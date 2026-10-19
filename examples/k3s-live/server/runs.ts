// Own bounded, durable demo run identities and the single live host execution.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HostRunFailure, type Host } from './host.js';
import { contentHash, freezeInvestigation, investigationSummary, InvestigationEvidenceFailure, requireInvestigationTools, retainFile, type InvestigationAudit } from './investigation.js';
import { runtimeIdentity } from '../project/mcp-client.mjs';
import { investigationTopology } from './topology.js';
import type { FailureDiagnostics } from './diagnostics.js';
import { parseEvidence, type EvidenceBundle } from '../shared/evidence.js';
import { parseRevisionAudit, verifySelectedOutput, type RevisionAudit } from '../shared/revision.mjs';
import { validatePostChangeEvidence } from '../shared/post-change-evidence.mjs';
import { managedWorkload } from '../shared/workloads.mjs';

import { validOutcomeCombination, type ResolutionReport, type ReconciliationObservation } from '../shared/resolution.js';
export type { ResolutionReport, ReconciliationObservation };

export interface Run {
  id: string; status: 'queued' | 'running' | 'completed' | 'failed';
  mode: 'live' | 'fixture'; startedAt: string; error?: string; output?: unknown;
  diagnostics?: FailureDiagnostics;
  revisionEnabled?: boolean; revision?: RevisionAudit;
  approach?: 'collected' | 'mcp'; investigation?: InvestigationAudit & { source?: 'kubernetes-api' | 'recorded-evidence' };
  // The immutable operator seed remains distinct from freshly acquired MCP evidence.
  admissionEvidence?: EvidenceBundle;
  stopRequested?: boolean; deadlineAt?: number;
  resolution?: ResolutionReport;
  reconciliations?: ReconciliationObservation[];
  input: { incident: unknown }; fingerprint: string;
}
export class RequestError extends Error { constructor(public status: number, message: string) { super(message); } }
export class Runs {
  readonly records = new Map<string, Run>();
  readonly observations = new Map<string, unknown>();
  readonly investigationObservations = new Map<string, unknown>();
  private investigationReads = new Map<string, Promise<unknown>>();
  private writes = new Map<string, Promise<void>>();
  private resolutionWrites = new Map<string, { identity: string; completion: Promise<Run> }>();
  private reconciliationWrites = new Map<string, Promise<Run>>();
  private active?: Run;
  private stopping = false;
  constructor(readonly directory: string, readonly mode: Run['mode'], readonly host: Host) {}
  private folder(id: string) { return join(this.directory, id); }
  private async persist(run: Run) {
    const folder = this.folder(run.id), bytes = JSON.stringify(run);
    const write = (this.writes.get(run.id) ?? Promise.resolve()).then(async () => {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(join(folder, 'run.tmp'), bytes, { mode: 0o600 });
      await rename(join(folder, 'run.tmp'), join(folder, 'run.json'));
    });
    this.writes.set(run.id, write);
    await write;
  }
  async initialise() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const resumable: Run[] = [];
    for (const item of await readdir(this.directory, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const folder = this.folder(item.name);
      let manifest: string;
      try { manifest = await readFile(join(folder, 'run.json'), 'utf8'); }
      catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
        // Host execution starts only after the first run.json rename. An empty
        // directory or initial temporary manifest therefore has no execution
        // to recover, and admitting that identity again cannot repeat inference.
        const files = await readdir(folder);
        if (files.every(name => name === 'run.tmp')) continue;
        throw new Error(`Stored run ${item.name} has retained state without an admission record; inspect the data directory before restarting`);
      }
      const run = JSON.parse(manifest) as Run;
      if (run.id !== item.name) throw new Error('Stored run identity mismatch');
      if (run.status === 'running' || run.status === 'queued') {
        if (!run.stopRequested && (run.deadlineAt === undefined || Date.now() < run.deadlineAt) && run.revisionEnabled && this.host.options?.revisionPlan) resumable.push(run);
        else {
          run.status = 'failed';
          run.error = 'Server restarted during execution. Retained host state needs inspection; this demo will not repeat inference automatically.';
          await this.persist(run);
        }
      }
      this.records.set(run.id, run);
    }
    if (resumable.length > 1) throw new Error('More than one interrupted revision run exists; inspect retained state before resuming');
    if (resumable[0]) {
      this.active = resumable[0];
      // The host freezes source input, configuration, policy, deadline and
      // reservations. Reopening reuses completed work and rejects unknown effects.
      void this.execute(resumable[0]).catch(() => {
        resumable[0]!.status = 'failed';
        resumable[0]!.error = 'Could not retain the resumed outcome. Inspect the existing host journal.';
      });
    }
  }
  get(id: string) {
    const run = this.records.get(id);
    if (!run) throw new RequestError(404, 'Run does not exist');
    return run;
  }
  list() { return [...this.records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  async create(body: Record<string, unknown>) {
    if (body.scenario !== 'pod-incident' && body.scenario !== 'pod-crash') throw new RequestError(400, 'Select scenario pod-incident');
    const approach = body.approach ?? 'collected';
    if (approach !== 'collected' && approach !== 'mcp') throw new RequestError(400, 'Unknown investigation approach');
    const id = body.id ?? `demo-${randomUUID()}`;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
      throw new RequestError(400, 'Invalid run id');
    }
    const event = validateEvent(body.event);
    let evidence: EvidenceBundle | undefined;
    try { evidence = parseEvidence(body.evidence); }
    catch (error) { throw new RequestError(400, error instanceof Error ? error.message : 'Invalid Kubernetes evidence'); }
    if (evidence) {
      const subject = event?.involvedObject as Record<string, string> | undefined;
      if (!subject || subject.kind !== 'Pod' || subject.namespace !== evidence.subject.namespace ||
          subject.name !== evidence.subject.name || subject.uid !== evidence.subject.uid) {
        throw new RequestError(400, 'Evidence subject must match the event Pod namespace, name and UID');
      }
    }
    if (approach === 'mcp' && (!evidence || !event)) throw new RequestError(400, 'MCP investigation requires an incident with collected, UID-bound evidence');
    const source = process.env.DEMO_MCP_SOURCE ?? (this.mode === 'live' ? 'kubernetes-api' : 'recorded-evidence');
    if (approach === 'mcp' && evidence!.subject.namespace !== (process.env.MAS_NAMESPACE ?? 'mas-demo')) throw new RequestError(400, 'MCP tools are limited to the configured demo namespace');
    if (approach === 'mcp' && !['kubernetes-api', 'recorded-evidence'].includes(source)) throw new RequestError(503, 'Invalid MCP source configuration');
    const input = { incident: { scenario: 'pod-incident', source: event ? 'kubernetes-event' : 'synthetic-scenario',
      event: event ?? { reason: 'BackOff', message: 'Back-off restarting failed container demo-app',
        involvedObject: { kind: 'Pod', name: 'demo-app', namespace: 'mas-demo' } },
      ...(evidence ? { evidence } : {}), context: evidenceContext(evidence) } };
    const fingerprint = approach === 'mcp' ? contentHash(`mcp:${source}:${inputFingerprint(input)}`) : inputFingerprint(input);
    const existing = this.records.get(id);
    if (existing) {
      // Earlier archives retain their original wording and pod-crash alias.
      // Their immutable incident/evidence identity still admits the same retry.
      if ((existing.approach ?? 'collected') !== approach || (existing.fingerprint !== fingerprint && (approach === 'mcp' || inputFingerprint(existing.input) !== fingerprint))) throw new RequestError(409, 'Run id already belongs to different input');
      return existing;
    }
    if (this.stopping || this.active) throw new RequestError(429, 'One demo is already running; try again after it finishes');
    if (this.records.size >= 50) throw new RequestError(429, 'Demo retains at most 50 runs; archive the data directory before starting a new session');
    if (this.mode === 'live' && !process.env.OPENAI_API_KEY) throw new RequestError(503, 'OPENAI_API_KEY is required for live agents');
    const run: Run = { id, mode: this.mode, status: 'queued', startedAt: new Date().toISOString(), input, fingerprint,
      ...(this.host.options?.revisionPlan ? { revisionEnabled: true } : {}),
      ...(approach === 'mcp' ? { approach, admissionEvidence: structuredClone(evidence!), deadlineAt: Date.now() + 600_000,
        investigation: { status: 'running', runId: id, calls: [], source: source as 'kubernetes-api' | 'recorded-evidence' } } : {}) };
    this.active = run;
    this.records.set(id, run);
    try { await this.persist(run); }
    catch (error) { this.active = undefined; this.records.delete(id); throw error; }
    void this.execute(run).catch(() => {
      // A terminal persistence error must not become an unhandled rejection.
      // The original admission record remains durable and prevents automatic
      // inference replay after restart, even when its final update failed.
      run.status = 'failed';
      run.error = 'Could not retain the run outcome. Inspect the data directory and host state before retrying.';
      console.error(`Could not persist the terminal outcome for demo run ${run.id}`);
    });
    return run;
  }
  async recordResolution(id: string, value: unknown) {
    const run = this.get(id);
    if (run.status !== 'completed') throw new RequestError(409, 'Record a resolution only after the MAS assessment completes');
    const report = validateResolution(value, run);
    if (run.resolution) {
      if (stableJson(run.resolution) !== stableJson(report)) throw new RequestError(409, 'A resolution report is already retained for this run');
      return run;
    }
    const identity = stableJson(report), pending = this.resolutionWrites.get(id);
    if (pending) {
      if (pending.identity !== identity) throw new RequestError(409, 'A different resolution report is being retained for this run');
      return pending.completion;
    }
    // This endpoint records an external verifier outcome. It never executes
    // commands or grants the LLM authority to mutate Kubernetes resources.
    const updated = { ...run, resolution: report };
    const completion = this.persist(updated).then(() => {
      Object.assign(run, updated);
      // The next completed snapshot must observe the host again so the
      // external tool outcome receives a real later observation timestamp.
      this.observations.delete(id);
      return run;
    });
    this.resolutionWrites.set(id, { identity, completion });
    try { return await completion; }
    finally { this.resolutionWrites.delete(id); }
  }
  async recordReconciliation(id: string, value: unknown): Promise<Run> {
    const pending = this.reconciliationWrites.get(id);
    if (pending) { await pending; return this.recordReconciliation(id, value); }
    const run = this.get(id);
    const observation = validateReconciliation(value, run);
    const retained = run.reconciliations ?? [];
    const existing = retained.find(item => item.id === observation.id);
    if (existing) {
      if (stableJson(existing) !== stableJson(observation)) throw new RequestError(409, 'Reconciliation identity already has different evidence');
      return run;
    }
    if (observation.sequence !== retained.length + 1 || retained.length >= 8) throw new RequestError(409, 'Reconciliation observations must append in order, at most eight per attempt');
    if (retained.length && Date.parse(observation.observedAt) < Date.parse(retained.at(-1)!.observedAt)) throw new RequestError(409, 'Reconciliation time cannot move backwards');
    const updated = { ...run, reconciliations: [...retained, observation] };
    const completion = this.persist(updated).then(() => {
      Object.assign(run, updated);
      this.observations.delete(id);
      return run;
    });
    this.reconciliationWrites.set(id, completion);
    try { return await completion; }
    finally { this.reconciliationWrites.delete(id); }
  }
  private async execute(run: Run) {
    const folder = this.folder(run.id), state = join(folder, 'host');
    let pendingObservation: Promise<boolean> | undefined;
    const observe = (): Promise<boolean> => {
      if (pendingObservation) return pendingObservation;
      pendingObservation = Promise.all([
        run.approach === 'mcp' ? this.observeInvestigation(run).catch(() => {}) : Promise.resolve(),
        Promise.resolve().then(() => this.host.observe(run.id, state))
          .then(snapshot => { this.observations.set(run.id, snapshot); return true; })
          // Database creation and SQLite snapshot races do not change the run.
          .catch(() => false),
      ]).then(([, available]) => available)
        .finally(() => { pendingObservation = undefined; });
      return pendingObservation;
    };
    const timer = setInterval(() => void observe(), 250);
    const expiry = run.deadlineAt === undefined ? undefined : setTimeout(() => {
      run.stopRequested = true;
      void this.persist(run).catch(() => {});
      void Promise.allSettled([this.host.cancel(run.id, state), this.host.cancel(run.id, join(folder, 'investigation', 'host'))]);
    }, Math.max(0, run.deadlineAt - Date.now()));
    let outcome: { status: 'completed'; output: unknown; revision?: RevisionAudit } |
      { status: 'failed'; error: string; diagnostics?: FailureDiagnostics; output?: unknown; revision?: RevisionAudit };
    try {
      run.status = 'running';
      await this.persist(run);
      if (run.approach === 'mcp') await this.acquire(run);
      this.ensureRunning(run);
      const input = join(folder, 'input.json');
      const supplied = run.revisionEnabled ? { sources: [{ id: 'incident', kind: 'evidence', content: run.input.incident, readers: ['*'] }] } : run.input;
      if (run.approach === 'mcp') await retainFile(input, supplied);
      else await writeFile(input, JSON.stringify(supplied), { mode: 0o600 });
      this.ensureRunning(run);
      if (run.revisionEnabled) {
        const result = await this.host.runAssessed(run.id, input, state, run.mode);
        outcome = result.revision.status === 'completed' ? { status: 'completed', ...result }
          : { status: 'failed', ...result, error: `Revision ended as ${result.revision.status}; unresolved findings remain. No remediation is admitted for this run.` };
      } else outcome = { status: 'completed', output: await this.host.run(run.id, input, state, run.mode) };
      this.ensureRunning(run);
    } catch (error) {
      if (run.approach === 'mcp' && (run.investigation?.status !== 'completed' || error instanceof InvestigationEvidenceFailure)) run.investigation = { ...run.investigation!, status: 'failed',
        error: error instanceof InvestigationEvidenceFailure ? error.message : 'Investigation did not complete; retained tool state requires inspection.' };
      outcome = error instanceof HostRunFailure || error instanceof InvestigationEvidenceFailure
        ? { status: 'failed', error: error.message, diagnostics: error.diagnostics }
        : { status: 'failed', error: 'Host did not complete. Inspect retained state before retrying an uncertain provider outcome.' };
    } finally {
      clearInterval(timer);
      if (expiry) clearTimeout(expiry);
    }
    try {
      // A poll may have captured the database before the host settled. Wait for
      // it, then obtain a fresh final snapshot before publishing terminal state.
      await pendingObservation;
      if (!await observe()) this.observations.delete(run.id);
      if (run.approach === 'mcp') await this.observeInvestigation(run).catch(() => {});
      const terminal = { ...run, ...outcome };
      await this.persist(terminal);
      Object.assign(run, terminal);
    } finally { this.active = undefined; }
  }
  private ensureRunning(run: Run) {
    if (this.stopping || run.stopRequested || (run.deadlineAt !== undefined && Date.now() >= run.deadlineAt))
      throw new Error('Investigation cancelled or admission deadline elapsed');
  }
  private async observeInvestigation(run: Run) {
    const pending = this.investigationReads.get(run.id);
    if (pending) return pending;
    const observation = this.host.observe(run.id, join(this.folder(run.id), 'investigation', 'host'))
      .then(value => { this.investigationObservations.set(run.id, value); return value; })
      .finally(() => this.investigationReads.delete(run.id));
    this.investigationReads.set(run.id, observation);
    return observation;
  }
  private async acquire(run: Run) {
    this.ensureRunning(run);
    if (run.investigation?.status === 'completed') {
      requireInvestigationTools(Array.isArray(run.investigation.calls) ? run.investigation.calls.map(call => call.tool) : []);
      const retained = parseEvidence(run.investigation.evidence);
      const actual = parseEvidence((run.input.incident as { evidence?: unknown }).evidence);
      if (!retained || stableJson(retained) !== stableJson(actual)) throw new Error('Frozen investigation evidence changed');
      return;
    }
    const folder = join(this.folder(run.id), 'investigation');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const incident = run.input.incident as { event: Record<string, unknown>; evidence: EvidenceBundle };
    const evidence = parseEvidence(incident.evidence)!;
    const contextFile = join(folder, 'context.json');
    const source = run.investigation!.source!;
    const context = { version: 'mas-mcp-investigation/1', source,
      event: { ...incident.event, namespace: evidence.subject.namespace }, evidence,
      runtime_sha256: await runtimeIdentity(resolve(this.host.options.project, '..')) };
    const contextSha256 = await retainFile(contextFile, context);
    if (run.investigation?.contextSha256 && run.investigation.contextSha256 !== contextSha256) throw new Error('Investigation context changed');
    run.investigation = { ...run.investigation!, contextSha256 };
    await this.persist(run);
    const input = join(folder, 'input.json');
    await retainFile(input, { event: context.event, subject: evidence.subject, context_sha256: contextSha256 });
    this.ensureRunning(run);
    const summary = await this.host.runInvestigation(run.id, input, join(folder, 'host'), run.mode, contextFile, contextSha256);
    this.ensureRunning(run);
    // Read the trusted internal journal with payloads for evidence assembly;
    // the public observation continues to honour SHOW_PAYLOADS independently.
    const observation = await this.host.observe(run.id, join(folder, 'host'), true);
    const audit = freezeInvestigation(run.id, observation, evidence, source, contextSha256);
    // Publish the final public trace before the completed audit. An older
    // observer poll must not make a frozen acquisition appear to lack replies.
    await this.investigationReads.get(run.id)?.catch(() => {});
    await this.observeInvestigation(run);
    run.input = { incident: { ...incident, evidence: audit.evidence, context: evidenceContext(audit.evidence) } };
    run.investigation = { ...audit, source, ...investigationSummary(audit, summary) };
    this.ensureRunning(run);
    await this.persist(run); // Freeze before admitting any assessment invocation.
  }
  async snapshot(id: string) {
    const run = this.get(id);
    if (!this.observations.has(id) && run.status !== 'running' && run.status !== 'queued') {
      try { this.observations.set(id, await this.host.observe(id, join(this.folder(id), 'host'))); } catch { /* Show absence explicitly below. */ }
    }
    if (run.approach === 'mcp' && !this.investigationObservations.has(id)) await this.observeInvestigation(run).catch(() => {});
    const graph = run.approach === 'mcp' ? await investigationTopology(this.host.options.project, run.mode) : undefined;
    // Background polls can update either journal during the awaits above.
    // Capture the payload and its availability together, without another await.
    const observation = this.observations.get(id) as { revision?: unknown } | undefined;
    const revision = observation?.revision ? parseRevisionAudit(observation.revision) : run.revision;
    return { run: revision ? { ...run, revision } : run,
      ...(run.approach === 'mcp' ? { investigationObservation: this.investigationObservations.get(id),
        investigationTopology: graph } : {}),
      observation: observation ?? { messages: [] },
      observationAvailable: observation !== undefined };
  }
  async remediationSnapshot(id: string) {
    const run = this.get(id);
    if ((run.revisionEnabled || run.revision) && run.status === 'completed' &&
        (run.revision?.status !== 'completed' || !run.revision.selected || run.output === undefined)) {
      throw new RequestError(409, 'Completed revision evidence is required for remediation');
    }
    let revisionSelection;
    if (run.revision?.selected && run.output !== undefined) {
      await verifySelectedOutput(run.revision, run.output);
      const candidate = run.revision.records.find(row => row.kind === 'candidate' && row.id === run.revision!.selected!.id)!;
      revisionSelection = { status: run.revision.status, candidate: run.revision.selected,
        output_sha256: candidate.record?.output_sha256 ?? candidate.output_sha256 };
    }
    // The controller needs the original incident and exact selected output, not
    // observer history or repeated invocation contexts. Preserve its byte bound
    // and every existing admission/recovery field without granting new authority.
    const investigation = run.approach === 'mcp' && run.investigation ? {
      status: run.investigation.status, runId: run.investigation.runId, source: run.investigation.source,
      contextSha256: run.investigation.contextSha256, calls: run.investigation.calls, evidence: run.investigation.evidence,
    } : undefined;
    return { run: { id: run.id, status: run.status, startedAt: run.startedAt, input: run.input, approach: run.approach ?? 'collected',
      ...(investigation ? { admissionEvidence: run.admissionEvidence, investigation } : {}),
      output: run.output, resolution: run.resolution, reconciliations: run.reconciliations,
      ...(revisionSelection ? { revisionSelection } : {}) } };
  }
  async shutdown() {
    this.stopping = true;
    if (this.active) {
      const run = this.active;
      run.stopRequested = true;
      await this.persist(run);
      await Promise.allSettled([this.host.cancel(run.id, join(this.folder(run.id), 'host')),
        ...(run.approach === 'mcp' ? [this.host.cancel(run.id, join(this.folder(run.id), 'investigation', 'host'))] : [])]);
    }
  }
}

function evidenceContext(evidence?: EvidenceBundle) {
  if (!evidence) return 'No live Kubernetes logs, metrics or resource specifications were collected for this sample. The supplied event alone cannot establish a cause or justify automatic remediation.';
  const collected = evidence.items.filter(item => item.status === 'collected').map(item => item.id);
  const missing = evidence.items.filter(item => item.status !== 'collected').map(item => `${item.id}: ${item.status}`);
  const truncated = evidence.items.filter(item => item.truncated).map(item => item.id);
  return `Kubernetes evidence captured at ${evidence.capturedAt}. Collected items: ${collected.join(', ') || 'none'}. Unavailable or skipped: ${missing.join(', ') || 'none'}. Truncated items: ${truncated.join(', ') || 'none'}. Cite item IDs; separate observations from hypotheses. Evidence is a bounded snapshot, not a continuing cluster connection.`;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
function inputFingerprint(input: { incident: unknown }) {
  const incident = input.incident as Record<string, unknown>;
  const { context: _context, ...identity } = incident;
  if (identity.scenario === 'pod-crash') identity.scenario = 'pod-incident';
  return createHash('sha256').update(stableJson(identity)).digest('hex');
}
function validateResolution(value: unknown, run: Run): ResolutionReport {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 32 * 1024) throw new RequestError(400, 'Resolution report must be an object of at most 32 KiB');
  const report = value as Record<string, unknown>;
  const required = ['version', 'status', 'action', 'target', 'recordedAt', 'reason', 'patch', 'before', 'after', 'checks',
    ...(report.version === 'mas-k8s-resolution/2' ? ['operationId', 'attemptId', 'effectOutcome', 'verificationOutcome'] : []),
    ...(Object.hasOwn(report, 'verificationEvidence') ? ['verificationEvidence'] : [])];
  if (Object.keys(report).length !== required.length || required.some(key => !(key in report)) || !['mas-k8s-resolution/1', 'mas-k8s-resolution/2'].includes(String(report.version)) || !validOutcomeCombination(report) ||
      !['verified', 'failed', 'not-attempted'].includes(String(report.status)) || report.action !== 'replace_readiness_probe_path' ||
      typeof report.recordedAt !== 'string' || !Number.isFinite(Date.parse(report.recordedAt)) || typeof report.reason !== 'string' || report.reason.length > 2000 ||
      !Array.isArray(report.patch) || report.patch.length > 16 || !Array.isArray(report.checks) || report.checks.length > 16) throw new RequestError(400, 'Invalid resolution report');
  for (const check of report.checks) {
    if (!check || typeof check !== 'object' || Array.isArray(check) || Object.keys(check).length !== 3 || typeof check.name !== 'string' || check.name.length > 253 ||
        typeof check.passed !== 'boolean' || typeof check.detail !== 'string' || check.detail.length > 2000) throw new RequestError(400, 'Invalid resolution verification check');
  }
  const target = report.target as Record<string, unknown> | null;
  const incident = run.input.incident as { evidence?: EvidenceBundle };
  const deployment = incident.evidence?.items.find(item => item.id === 'workload-deployment' && item.kind === 'workload' && item.status === 'collected');
  const resource = deployment?.data as { kind?: string; metadata?: Record<string, unknown>; templateHash?: string } | undefined;
  if (!target || Array.isArray(target) || Object.keys(target).length !== 3 || resource?.kind !== 'Deployment' ||
      ['namespace', 'name', 'uid'].some(key => typeof target[key] !== 'string' || target[key] !== resource.metadata?.[key])) throw new RequestError(400, 'Resolution target must match the collected Deployment namespace, name and UID');
  const policy = managedWorkload(target.namespace, target.name);
  if (!policy || policy.approach !== (run.approach ?? 'collected')) throw new RequestError(400, 'Resolution target does not match the admitted investigation approach');
  if (report.version === 'mas-k8s-resolution/2' && report.effectOutcome === 'applied' &&
      !report.checks.some(check => check.name === 'Patch applied' && check.passed === true)) {
    throw new RequestError(400, 'An applied effect requires an acknowledged patch check');
  }
  if (report.status === 'verified' && (!report.checks.length || report.checks.some(check => check.passed !== true))) throw new RequestError(400, 'A verified resolution requires successful verification checks');
  try { validatePostChangeEvidence(report); }
  catch (error) { throw new RequestError(400, error instanceof Error ? error.message : 'Invalid post-change evidence'); }
  if (report.status === 'verified') {
    const verificationChecks = report.checks as ResolutionReport['checks'];
    const checks = ['Admission', 'Patch applied', 'Rollout', 'Template scope', 'New Pod ready', 'Functional HTTP', 'Fresh metrics',
      ...(report.verificationEvidence ? ['Post-change logs', 'Post-change events'] : [])];
    const before = report.before as Record<string, unknown> | null, after = report.after as Record<string, unknown> | null;
    const pod = after?.pod as Record<string, unknown> | undefined, metrics = after?.metrics as Record<string, unknown> | undefined;
    const application = after?.application as Record<string, unknown> | undefined;
    const spec = deployment?.data as { spec?: { template?: { spec?: { containers?: { name?: string }[] } } } };
    const index = spec?.spec?.template?.spec?.containers?.findIndex(container => container.name === 'checkout') ?? -1;
    const path = `/spec/template/spec/containers/${index}/readinessProbe/httpGet/path`;
    const expectedPatch = [
      { op: 'test', path: '/metadata/uid', value: target.uid },
      { op: 'test', path: '/metadata/resourceVersion', value: before?.resourceVersion },
      { op: 'test', path: `/spec/template/spec/containers/${index}/name`, value: 'checkout' },
      { op: 'test', path, value: policy.currentPath }, { op: 'replace', path, value: policy.proposedPath },
    ];
    if (verificationChecks.length !== checks.length || checks.some(name => !verificationChecks.some(check => check.name === name && check.passed === true)) || index < 0 ||
        !before || !after || Array.isArray(before) || Array.isArray(after) || before.uid !== target.uid || after.uid !== target.uid ||
        typeof before.resourceVersion !== 'string' || !before.resourceVersion || typeof after.resourceVersion !== 'string' || !after.resourceVersion || after.resourceVersion === before.resourceVersion ||
        before.readinessPath !== policy.currentPath || after.readinessPath !== policy.proposedPath || typeof before.templateHash !== 'string' || !before.templateHash || before.templateHash !== resource.templateHash || typeof after.templateHash !== 'string' || !after.templateHash ||
        typeof before.observedAt !== 'string' || !Number.isFinite(Date.parse(before.observedAt)) || typeof after.observedAt !== 'string' || !Number.isFinite(Date.parse(after.observedAt)) || Date.parse(after.observedAt) < Date.parse(before.observedAt) || Date.parse(report.recordedAt) < Date.parse(after.observedAt) ||
        !Number.isSafeInteger(before.generation) || !Number.isSafeInteger(after.generation) || Number(after.generation) !== Number(before.generation) + 1 ||
        report.version === 'mas-k8s-resolution/2' && (typeof before.namespaceUID !== 'string' || !before.namespaceUID || before.expectedTemplateHash !== after.templateHash) ||
        !pod || typeof pod.name !== 'string' || !pod.name || typeof pod.uid !== 'string' || !pod.uid || pod.ready !== true || pod.restarts !== 0 ||
        !metrics || typeof metrics.timestamp !== 'string' || !Number.isFinite(Date.parse(metrics.timestamp)) || typeof metrics.window !== 'string' || !metrics.window ||
        !Array.isArray(metrics.containers) || !metrics.containers.length || metrics.containers.some(container => !container || typeof container.name !== 'string' || typeof container.usage?.cpu !== 'string' || typeof container.usage?.memory !== 'string') ||
        application?.source !== 'Kubernetes Service API proxy HTTP GET /' || application.status !== 200 || application.body !== 'MAS checkout service ready\n' ||
        stableJson(report.patch) !== stableJson(expectedPatch)) throw new RequestError(400, 'Verified resolution proof must include the exact bounded patch, rollout, ready Pod, functional HTTP and fresh metrics checks');
  }
  return structuredClone(report) as unknown as ResolutionReport;
}

// Copy only bounded event evidence. Arbitrary caller-supplied objects never enter prompts.
function validateEvent(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(400, 'event must be an object');
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key of ['namespace', 'name', 'uid', 'reason', 'message']) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== 'string' || source[key].length > (key === 'message' ? 2000 : 253)) throw new RequestError(400, 'Event field is invalid or too long');
      copy[key] = source[key];
    }
  }
  if (source.involvedObject !== undefined) {
    if (!source.involvedObject || typeof source.involvedObject !== 'object' || Array.isArray(source.involvedObject)) throw new RequestError(400, 'involvedObject must be an object');
    const object: Record<string, string> = {};
    for (const key of ['kind', 'name', 'namespace', 'uid']) {
      const field = (source.involvedObject as Record<string, unknown>)[key];
      if (field !== undefined) {
        if (typeof field !== 'string' || field.length > 253) throw new RequestError(400, 'Invalid involvedObject field');
        object[key] = field;
      }
    }
    copy.involvedObject = object;
  }
  return copy;
}

function validateReconciliation(value: unknown, run: Run): ReconciliationObservation {
  const report = run.resolution;
  if (!report || report.version !== 'mas-k8s-resolution/2' || report.status !== 'failed' ||
      !['unknown', 'applied'].includes(report.effectOutcome)) throw new RequestError(409, 'Reconciliation requires a retained uncertain or unverified effect');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 4096) throw new RequestError(400, 'Reconciliation must be a bounded observation');
  const row = value as Record<string, unknown>;
  const fields = ['version', 'id', 'sequence', 'runId', 'operationId', 'attemptId', 'reportDigest', 'target', 'originalTemplateHash', 'observedAt', 'state', 'reason', 'evidence'];
  const before = report.before as Record<string, unknown> | null;
  const digest = (data: unknown) => createHash('sha256').update(stableJson(data)).digest('hex');
  const { id: _id, ...content } = row;
  if (Object.keys(row).length !== fields.length || fields.some(key => !(key in row)) ||
      row.version !== 'mas-k8s-reconciliation/1' || row.id !== digest(content) ||
      !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1 || Number(row.sequence) > 8 ||
      row.runId !== run.id || row.operationId !== report.operationId || row.attemptId !== report.attemptId || row.reportDigest !== digest(report) ||
      stableJson(row.target) !== stableJson(report.target) || row.originalTemplateHash !== before?.templateHash ||
      typeof row.originalTemplateHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.originalTemplateHash) ||
      typeof row.observedAt !== 'string' || !Number.isFinite(Date.parse(row.observedAt)) || Date.parse(row.observedAt) < Date.parse(report.recordedAt) ||
      !['desired', 'original', 'changed', 'unavailable'].includes(String(row.state)) || typeof row.reason !== 'string' || row.reason.length > 1000) throw new RequestError(400, 'Reconciliation must bind to the exact immutable attempt report');
  if (row.state === 'unavailable') {
    if (row.evidence !== null) throw new RequestError(400, 'Unavailable reconciliation must not invent workload evidence');
  } else {
    const data = row.evidence as ReconciliationObservation['evidence'];
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 8 ||
        !['namespaceUID', 'uid', 'resourceVersion', 'templateHash'].every(key => typeof data[key as keyof typeof data] === 'string' && String(data[key as keyof typeof data]).length > 0 && String(data[key as keyof typeof data]).length <= 128) ||
        !/^[a-f0-9]{64}$/.test(data.templateHash) || !(data.readinessPath === null || typeof data.readinessPath === 'string' && data.readinessPath.length <= 253) ||
        !Number.isSafeInteger(data.generation) || data.generation < 1 || !Number.isSafeInteger(data.readyReplicas) || data.readyReplicas < 0 ||
        !(data.observedGeneration === null || Number.isSafeInteger(data.observedGeneration) && data.observedGeneration >= 0)) throw new RequestError(400, 'Reconciliation workload evidence is invalid');
    if (row.state === 'desired' && (data.namespaceUID !== before?.namespaceUID || data.uid !== report.target.uid || data.templateHash !== before?.expectedTemplateHash || data.readinessPath !== '/healthz')) throw new RequestError(400, 'Desired-state observation must match the exact admitted template');
    if (row.state === 'original' && (data.namespaceUID !== before?.namespaceUID || data.uid !== report.target.uid || data.templateHash !== before?.templateHash || data.readinessPath !== '/readyz')) throw new RequestError(400, 'Original-state observation must match the original target and template');
  }
  return structuredClone(row) as unknown as ReconciliationObservation;
}
