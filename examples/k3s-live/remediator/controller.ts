import { createHash } from 'node:crypto';
import type { DemoRun, EventEvidence, Metadata } from '../operator/controller.js';
import { evidenceFromStorage } from '../operator/evidence.js';
import type { EvidenceBundle } from '../shared/evidence.js';
import type { DigestRef } from '../shared/revision.mjs';
import { validOutcomeCombination, type ResolutionReport, type ReconciliationObservation } from '../shared/resolution.js';

export type { ResolutionReport };
export const POLICY_VERSION = 'mas-k8s-remediation/1';
export const NAMESPACE = 'mas-demo';
export const RUN_PATH = `/apis/demo.mas.dev/v1alpha1/namespaces/${NAMESPACE}/masdemoruns`;
export const JOURNAL_PATH = `/apis/demo.mas.dev/v1alpha1/namespaces/${NAMESPACE}/masremediations`;
const MAX_REPORT_BYTES = 16 * 1024;

export interface Snapshot {
  run: {
    id: string; status: string; startedAt?: string;
    input: { incident: { scenario?: string; source?: string; event?: EventEvidence; evidence?: EvidenceBundle } };
    output?: unknown; resolution?: ResolutionReport; reconciliations?: ReconciliationObservation[];
    revisionSelection?: { status: string; candidate: DigestRef; output_sha256: string };
  };
}
export interface RemediationKubernetesAPI {
  get<T>(path: string): Promise<T>;
  list<T>(path: string): Promise<T[]>;
  create<T>(path: string, resource: unknown): Promise<T>;
  replace<T>(path: string, resource: unknown): Promise<T>;
}
export interface RemediationBackendAPI {
  snapshot(id: string): Promise<Snapshot | undefined>;
  report(id: string, report: ResolutionReport): Promise<void>;
  reconcile(id: string, observation: ReconciliationObservation): Promise<void>;
}
export interface JournalSpec {
  version: typeof POLICY_VERSION; runId: string; sourceRunUID: string;
  namespaceUID: string; targetUID: string; templateHash: string; evidenceHash: string;
}
export interface JournalStatus {
  phase: 'Pending' | 'Applying' | 'Finished';
  ownerId?: string; ownerPodUID?: string; ownerPodName?: string;
  startedAt?: string; reportJson?: string; reconciliations?: string[];
}
export interface RemediationJournal {
  apiVersion: string; kind: string; metadata: Metadata;
  spec: JournalSpec; status?: JournalStatus;
}
export interface ResolveOptions {
  namespaceUID: string; operationId: string; attemptId: string;
  beforePatch(report: ResolutionReport): Promise<void>;
}
export type Resolver = (snapshot: Snapshot, options: ResolveOptions) => Promise<ResolutionReport>;
export interface RemediationOptions {
  namespace: string; enabled: boolean; ownerId: string; podUID: string; podName: string;
  now?: () => number; maxEvidenceAgeMs?: number; reservationDeadlineMs?: number;
  log?: (message: string) => void;
}

export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Only JSON values can be journalled');
  return encoded;
}
const digest = (value: unknown) => createHash('sha256').update(canonicalJSON(value)).digest('hex');
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function code(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { statusCode?: unknown; status?: unknown }).statusCode ?? (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}
function same(left: unknown, right: unknown) { return canonicalJSON(left) === canonicalJSON(right); }
function itemData(bundle: EvidenceBundle, id: string): Record<string, unknown> {
  const data = bundle.items.find(item => item.id === id && item.status === 'collected')?.data;
  assert(data && typeof data === 'object' && !Array.isArray(data), `Collected ${id} evidence is required`);
  return data as Record<string, unknown>;
}
function target(bundle: EvidenceBundle): { uid: string; templateHash: string } {
  const deployment = itemData(bundle, 'workload-deployment');
  const metadata = deployment.metadata as Record<string, unknown> | undefined;
  assert(deployment.kind === 'Deployment' && metadata?.namespace === NAMESPACE && metadata?.name === 'mas-demo-checkout' &&
    typeof metadata.uid === 'string' && metadata.uid.length > 0 && typeof deployment.templateHash === 'string' &&
    /^[a-f0-9]{64}$/.test(deployment.templateHash), 'Evidence does not identify the permitted Deployment and original template');
  return { uid: metadata.uid, templateHash: deployment.templateHash };
}
export function journalName(spec: Pick<JournalSpec, 'namespaceUID' | 'targetUID' | 'templateHash' | 'version'>): string {
  // Evidence/Run IDs are deliberately excluded: repeated Events for the same
  // original template share a permanent tombstone, including after rollbacks.
  return `readiness-${digest([spec.namespaceUID, spec.targetUID, spec.templateHash, spec.version]).slice(0, 52)}`;
}

// The journal reserves at most one external effect per target/original-template.
// Kubernetes resourceVersion CAS is the lock; in-memory state only serialises a
// process. A lost reservation acknowledgement therefore never permits a patch.
export class RemediationController {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly maxAge: number;
  private readonly reservationDeadline: number;
  private ticking = false;
  private readonly published = new Set<string>();

  constructor(private readonly kube: RemediationKubernetesAPI, private readonly backend: RemediationBackendAPI,
    private readonly resolve: Resolver, private readonly options: RemediationOptions) {
    assert(options.namespace === NAMESPACE, 'The readiness remediation policy is confined to mas-demo');
    assert(options.ownerId && options.podUID && options.podName, 'Controller boot and Pod identities are required');
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console.log;
    this.maxAge = options.maxEvidenceAgeMs ?? 10 * 60_000;
    this.reservationDeadline = options.reservationDeadlineMs ?? 5 * 60_000;
  }

  async tick(): Promise<void> {
    if (!this.options.enabled || this.ticking) return;
    this.ticking = true;
    try {
      // Reconcile retained effects even when their source CR has been removed.
      // Finished reports are always replayed byte-for-byte from durable state.
      const journals = await this.kube.list<RemediationJournal>(JOURNAL_PATH);
      for (const journal of journals) {
        try {
          if (journal.status?.phase === 'Applying') await this.recoverApplying(journal);
          else if (journal.status?.phase === 'Finished') {
            const observed = await this.observeFinished(journal);
            await this.publish(observed);
          }
        } catch (error) { this.log(`Retained remediation ${journal.metadata.name} will retry: ${this.safeError(error)}`); }
      }
      const runs = await this.kube.list<DemoRun>(RUN_PATH);
      runs.sort((a, b) => (a.metadata.creationTimestamp ?? '').localeCompare(b.metadata.creationTimestamp ?? '') ||
        a.metadata.name.localeCompare(b.metadata.name));
      for (const run of runs) {
        if (run.status?.phase !== 'Succeeded') continue;
        try { await this.reconcileRun(run); }
        catch (error) { this.log(`Investigation ${run.metadata.name} was not remediated: ${this.safeError(error)}`); }
      }
    } finally { this.ticking = false; }
  }

  private safeError(error: unknown) {
    // API clients already suppress response bodies. Never log journalled data,
    // credentials, arbitrary model output or raw application evidence here.
    return code(error) !== undefined ? `API status ${code(error)}`
      : error instanceof Error ? error.message.slice(0, 300) : 'Unexpected controller error';
  }

  private binding(run: DemoRun, snapshot: Snapshot, fresh: boolean): EvidenceBundle {
    assert(run.metadata.namespace === NAMESPACE && run.metadata.uid && run.status?.phase === 'Succeeded',
      'A namespaced Succeeded MASDemoRun with a UID is required');
    const id = `k8s-${run.metadata.uid}`;
    assert(run.status.runId === id && snapshot.run.id === id && snapshot.run.status === 'completed',
      'Backend completion must match the exact Kubernetes investigation UID');
    const incident = snapshot.run.input.incident;
    assert(incident.source === 'kubernetes-event' && incident.scenario === 'pod-incident' && run.spec.event &&
      same(incident.event, run.spec.event), 'Backend Event differs from the immutable Kubernetes investigation');
    const stored = evidenceFromStorage(run.spec.evidence);
    assert(stored && incident.evidence && same(stored, incident.evidence),
      'Backend evidence differs from the immutable Kubernetes investigation');
    const subject = run.spec.event.involvedObject;
    assert(subject.kind === 'Pod' && subject.namespace === NAMESPACE && stored.subject.namespace === NAMESPACE &&
      subject.name === stored.subject.name && subject.uid === stored.subject.uid, 'Evidence is bound to another Pod');
    if (fresh) this.assertFresh(stored);
    target(stored);
    return stored;
  }

  private assertFresh(bundle: EvidenceBundle) {
    const at = Date.parse(bundle.capturedAt);
    assert(Number.isFinite(at) && at <= this.now() + 5000 && this.now() - at <= this.maxAge,
      'Collected evidence is stale or future-dated; collect a new investigation');
  }

  private async reconcileRun(run: DemoRun): Promise<void> {
    if (!run.metadata.uid) return;
    const id = `k8s-${run.metadata.uid}`;
    const snapshot = await this.backend.snapshot(id);
    if (!snapshot) return;
    const bundle = this.binding(run, snapshot, false);
    const deployment = target(bundle);
    const namespace = await this.kube.get<{ metadata: Metadata }>(`/api/v1/namespaces/${NAMESPACE}`);
    assert(namespace.metadata.uid, 'Namespace identity is unavailable');
    const spec: JournalSpec = { version: POLICY_VERSION, runId: id, sourceRunUID: run.metadata.uid,
      namespaceUID: namespace.metadata.uid, targetUID: deployment.uid, templateHash: deployment.templateHash,
      evidenceHash: digest({ event: run.spec.event, evidence: bundle }) };
    const name = journalName(spec);
    let journal: RemediationJournal;
    try { journal = await this.kube.get<RemediationJournal>(`${JOURNAL_PATH}/${name}`); }
    catch (error) {
      if (code(error) !== 404) throw error;
      if (snapshot.run.resolution) return;
      // The placeholder is not persisted. Admission can reject an assessment
      // without spending the permanent reservation for this original template.
      journal = { apiVersion: 'demo.mas.dev/v1alpha1', kind: 'MASRemediation',
        metadata: { name, namespace: NAMESPACE }, spec };
    }
    if (!same(journal.spec, spec)) {
      this.log(`Investigation ${run.metadata.name} shares retained target/template reservation ${name}; no second effect is permitted`);
      return;
    }
    if (journal.status?.phase === 'Finished') { await this.publish(journal); return; }
    if (journal.status?.phase === 'Applying') { await this.recoverApplying(journal); return; }
    this.assertFresh(bundle);
    // Snapshot objects are detached from both clients before the executor runs.
    const admittedSnapshot = structuredClone(snapshot);
    let claimed = false;
    let applying: RemediationJournal | undefined;
    let reservationFailed = false;
    let hookEntered = false;
    const beforePatch = async (report: ResolutionReport) => {
      hookEntered = true;
      try {
        this.assertFresh(bundle);
        this.assertReport(report, journal);
        assert(report.version !== 'mas-k8s-resolution/2' || report.attemptId === this.options.ownerId,
          'The admitted report attempt must match the reserving controller');
        assert(report.patch.length > 0 && report.before !== null, 'An admitted pre-patch report is required');
        // Creating a journal is itself ambiguous if its acknowledgement is
        // lost. This invocation stops on both create conflicts and I/O errors;
        // a later poll may read Pending and obtain its own acknowledged CAS.
        const live = journal.metadata.uid
          ? await this.kube.get<RemediationJournal>(`${JOURNAL_PATH}/${name}`)
          : await this.kube.create<RemediationJournal>(JOURNAL_PATH, journal);
        assert(same(live.spec, spec) && (!live.status || live.status.phase === 'Pending'),
          'The durable reservation no longer permits an effect');
        const status: JournalStatus = { phase: 'Applying', ownerId: this.options.ownerId,
          ownerPodUID: this.options.podUID, ownerPodName: this.options.podName,
          startedAt: new Date(this.now()).toISOString(), reportJson: canonicalJSON(report) };
        applying = await this.casStatus(live, status);
        // Only an acknowledged resourceVersion CAS authorises the single
        // immediate mutation. Read-back after a lost response grants no effect.
        claimed = true;
        this.assertFresh(bundle);
      } catch (error) { reservationFailed = true; throw error; }
    };
    let report: ResolutionReport;
    try { report = await this.resolve(admittedSnapshot, { namespaceUID: spec.namespaceUID, operationId: name, attemptId: this.options.ownerId, beforePatch }); }
    catch {
      report = this.failureReport(applying ?? journal,
        claimed ? 'The executor stopped after reserving a possible effect; inspect the live workload. No automatic retry is permitted.'
          : 'The executor stopped before it admitted a workload mutation.');
    }
    // The shared resolver turns hook exceptions into failed reports. A worker
    // that did not obtain the reservation must never publish that local report.
    if (reservationFailed) return;
    this.assertReport(report, applying ?? journal);
    assert(report.status !== 'verified' || claimed, 'Verified recovery requires an acknowledged effect reservation');
    if (!hookEntered) {
      // A preflight rejection spends no authority and creates no permanent
      // target reservation. It also must not race another worker's admitted
      // effect by publishing an immutable no-action resolution for that run.
      // The existing agent assessment remains visible for engineer review.
      this.log(`Investigation ${run.metadata.name} did not pass the fixed readiness preflight; no mutation was reserved`);
      return;
    }
    const terminal = await this.finish(claimed ? applying! : journal, report);
    if (terminal) await this.publish(terminal);
  }

  private async casStatus(journal: RemediationJournal, status: JournalStatus): Promise<RemediationJournal> {
    assert(journal.metadata.uid && journal.metadata.resourceVersion, 'A journal CAS requires UID and resourceVersion');
    const updated = await this.kube.replace<RemediationJournal>(
      `${JOURNAL_PATH}/${encodeURIComponent(journal.metadata.name)}/status`, { ...journal, status });
    assert(updated.metadata.uid === journal.metadata.uid && updated.metadata.resourceVersion &&
      updated.metadata.resourceVersion !== journal.metadata.resourceVersion && same(updated.spec, journal.spec) && same(updated.status, status),
    'The Kubernetes status acknowledgement did not confirm the exact journal reservation');
    return updated;
  }

  private async finish(journal: RemediationJournal, report: ResolutionReport): Promise<RemediationJournal | undefined> {
    this.assertReport(report, journal);
    try { return await this.casStatus(journal, { ...journal.status, phase: 'Finished', reportJson: canonicalJSON(report) }); }
    catch (error) {
      // Terminal CAS competitors and lost acknowledgements have one authority:
      // the persisted Finished record. Never overwrite it with a local result.
      const retained = await this.kube.get<RemediationJournal>(`${JOURNAL_PATH}/${encodeURIComponent(journal.metadata.name)}`);
      if (same(retained.spec, journal.spec) && retained.status?.phase === 'Finished') return retained;
      if (code(error) === 409) return undefined;
      throw error;
    }
  }

  private async recoverApplying(journal: RemediationJournal): Promise<void> {
    const status = journal.status;
    if (status?.phase !== 'Applying') return;
    const started = Date.parse(status.startedAt ?? '');
    let abandoned = !Number.isFinite(started) || this.now() - started >= this.reservationDeadline;
    if (!abandoned && status.ownerPodUID === this.options.podUID) {
      // One worker/process runs per container. A different boot ID in this same
      // Pod is a dead process; a retained own attempt has no in-flight executor
      // because tick() is serialised and awaits every executor call.
      abandoned = true;
    }
    if (!abandoned && status.ownerPodName && status.ownerPodUID) {
      try {
        const pod = await this.kube.get<{ metadata: Metadata; status?: { phase?: string } }>(
          `/api/v1/namespaces/${NAMESPACE}/pods/${encodeURIComponent(status.ownerPodName)}`);
        abandoned = pod.metadata.uid !== status.ownerPodUID || ['Succeeded', 'Failed'].includes(pod.status?.phase ?? '');
      } catch (error) { if (code(error) === 404) abandoned = true; else throw error; }
    } else if (!status.ownerPodName || !status.ownerPodUID) abandoned = true;
    if (!abandoned) return;
    const report = this.failureReport(journal,
      'The reserved executor is no longer running or its reservation deadline expired. A workload effect may have occurred. Inspect the live workload; this target/template will never be retried automatically.');
    const terminal = await this.finish(journal, report);
    if (terminal) await this.publish(terminal);
  }

  private failureReport(journal: RemediationJournal, reason: string): ResolutionReport {
    const saved = journal.status?.reportJson ? this.parseReport(journal) : undefined;
    return { version: 'mas-k8s-resolution/2', operationId: journal.metadata.name,
      attemptId: saved?.version === 'mas-k8s-resolution/2' ? saved.attemptId : journal.status?.ownerId ?? this.options.ownerId,
      effectOutcome: journal.status?.phase === 'Applying' ? 'unknown' : 'not_started', verificationOutcome: 'not_run',
      status: 'failed', action: 'replace_readiness_probe_path',
      target: { namespace: NAMESPACE, name: 'mas-demo-checkout', uid: journal.spec.targetUID },
      recordedAt: new Date(this.now()).toISOString(), reason, patch: saved?.patch ?? [],
      before: saved?.before ?? null, after: null,
      checks: [...(saved?.checks ?? []).slice(0, 15), { name: 'Executor continuity', passed: false, detail: reason }] };
  }

  private assertReport(report: ResolutionReport, journal: RemediationJournal) {
    assert(report && ['mas-k8s-resolution/1', 'mas-k8s-resolution/2'].includes(report.version) &&
      validOutcomeCombination(report as unknown as Record<string, unknown>) &&
      (report.version !== 'mas-k8s-resolution/2' || report.operationId === journal.metadata.name &&
        (!journal.status?.ownerId || report.attemptId === journal.status.ownerId)) &&
      ['not-attempted', 'failed', 'verified'].includes(report.status) && report.action === 'replace_readiness_probe_path' &&
      report.target?.namespace === NAMESPACE && report.target.name === 'mas-demo-checkout' && report.target.uid === journal.spec.targetUID &&
      Array.isArray(report.patch) && Array.isArray(report.checks) && Buffer.byteLength(canonicalJSON(report)) <= MAX_REPORT_BYTES,
    'The executor report does not match the bounded journal target');
  }
  private parseReport(journal: RemediationJournal): ResolutionReport {
    assert(journal.status?.reportJson, 'A durable remediation report is missing');
    const report = JSON.parse(journal.status.reportJson) as ResolutionReport;
    this.assertReport(report, journal);
    assert(canonicalJSON(report) === journal.status.reportJson, 'The durable report is not canonical JSON');
    return report;
  }
  private async observeFinished(journal: RemediationJournal): Promise<RemediationJournal> {
    const report = this.parseReport(journal);
    if (report.version !== 'mas-k8s-resolution/2' || report.status !== 'failed' ||
        !['unknown', 'applied'].includes(report.effectOutcome)) return journal;
    const retained = journal.status?.reconciliations ?? [];
    const last = retained.length ? JSON.parse(retained.at(-1)!) as ReconciliationObservation : undefined;
    // Finite evidence growth, including API failures. Reconciliation is a later
    // observation, not a decision to repeat or attribute the original effect.
    if (retained.length >= 8 || last && this.now() - Date.parse(last.observedAt) < 30_000) return journal;
    const before = report.before as Record<string, unknown> | null;
    if (!before || typeof before.expectedTemplateHash !== 'string') return journal;
    let state: ReconciliationObservation['state'] = 'unavailable';
    let evidence: ReconciliationObservation['evidence'] = null;
    let reason = 'The live workload could not be observed; the original effect remains unchanged.';
    try {
      const namespace = await this.kube.get<{ metadata: Metadata }>(`/api/v1/namespaces/${NAMESPACE}`);
      const deployment = await this.kube.get<{ metadata: Metadata & { generation: number }; spec: {
        template: { spec: { containers: { name: string; readinessProbe?: { httpGet?: { path?: string } } }[] } } };
        status?: { observedGeneration?: number; readyReplicas?: number } }>(
        `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/mas-demo-checkout`);
      assert(namespace.metadata.uid && deployment.metadata.uid && deployment.metadata.resourceVersion &&
        Number.isSafeInteger(deployment.metadata.generation), 'The live workload identity is incomplete');
      evidence = { namespaceUID: namespace.metadata.uid, uid: deployment.metadata.uid,
        resourceVersion: deployment.metadata.resourceVersion, generation: deployment.metadata.generation,
        templateHash: digest(deployment.spec.template),
        readinessPath: deployment.spec.template.spec.containers.find(item => item.name === 'checkout')?.readinessProbe?.httpGet?.path ?? null,
        observedGeneration: deployment.status?.observedGeneration ?? null, readyReplicas: deployment.status?.readyReplicas ?? 0 };
      const sameTarget = evidence.namespaceUID === journal.spec.namespaceUID && evidence.uid === journal.spec.targetUID;
      state = sameTarget && evidence.templateHash === before.expectedTemplateHash && evidence.readinessPath === '/healthz' ? 'desired'
        : sameTarget && evidence.templateHash === journal.spec.templateHash && evidence.readinessPath === '/readyz' ? 'original' : 'changed';
      reason = state === 'desired' ? 'The admitted template is present at this observation time. This does not establish who applied it or verify application recovery.'
        : state === 'original' ? 'The original template is present at this observation time. A delayed request or later actor can still change it.'
          : 'The namespace, target identity or workload template differs from the admitted before and after states.';
    } catch { /* Do not copy API response bodies or infer non-application from an unavailable read. */ }
    const content = { version: 'mas-k8s-reconciliation/1' as const, sequence: retained.length + 1,
      runId: journal.spec.runId, operationId: report.operationId, attemptId: report.attemptId, reportDigest: digest(report),
      target: report.target, originalTemplateHash: journal.spec.templateHash,
      observedAt: new Date(this.now()).toISOString(), state, reason, evidence };
    const observation: ReconciliationObservation = { ...content, id: digest(content) };
    try { return await this.casStatus(journal, { ...journal.status!, reconciliations: [...retained, canonicalJSON(observation)] }); }
    catch (error) {
      // A lost append acknowledgement is resolved by reading durable authority.
      // Never publish a locally observed value that did not win the status CAS.
      const current = await this.kube.get<RemediationJournal>(`${JOURNAL_PATH}/${encodeURIComponent(journal.metadata.name)}`);
      assert(same(current.spec, journal.spec) && current.status?.phase === 'Finished' &&
        current.status.reportJson === journal.status?.reportJson, 'Reconciliation read-back changed the immutable attempt');
      if (code(error) === 409 || (current.status.reconciliations?.length ?? 0) > retained.length) return current;
      throw error;
    }
  }
  private async publish(journal: RemediationJournal): Promise<void> {
    assert(journal.status?.phase === 'Finished', 'Only a durable terminal report may be published');
    const report = this.parseReport(journal);
    const publication = digest([journal.metadata.uid, journal.spec, report]);
    if (!this.published.has(publication)) {
      // A failed publication retries exactly the retained report; no effect path.
      await this.backend.report(journal.spec.runId, report);
      this.published.add(publication);
    }
    for (const encoded of journal.status.reconciliations ?? []) {
      const observation = JSON.parse(encoded) as ReconciliationObservation;
      const identity = `observation:${observation.id}`;
      if (this.published.has(identity)) continue;
      await this.backend.reconcile(journal.spec.runId, observation);
      this.published.add(identity);
    }
  }
}
