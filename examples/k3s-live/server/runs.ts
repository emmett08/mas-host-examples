// Own bounded, durable demo run identities and the single live host execution.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HostRunFailure, type Host } from './host.js';
import type { FailureDiagnostics } from './diagnostics.js';
import { parseEvidence, type EvidenceBundle } from '../shared/evidence.js';

export interface ResolutionReport {
  version: 'mas-k8s-resolution/1'; status: 'verified' | 'failed' | 'not-attempted';
  action: 'replace_readiness_probe_path'; target: { namespace: string; name: string; uid: string };
  recordedAt: string; reason: string; patch: unknown[]; before: unknown; after: unknown;
  checks: { name: string; passed: boolean; detail: string }[];
}

export interface Run {
  id: string; status: 'queued' | 'running' | 'completed' | 'failed';
  mode: 'live' | 'fixture'; startedAt: string; error?: string; output?: unknown;
  diagnostics?: FailureDiagnostics;
  resolution?: ResolutionReport;
  input: { incident: unknown }; fingerprint: string;
}
export class RequestError extends Error { constructor(public status: number, message: string) { super(message); } }
export class Runs {
  readonly records = new Map<string, Run>();
  readonly observations = new Map<string, unknown>();
  private resolutionWrites = new Map<string, { identity: string; completion: Promise<Run> }>();
  private active?: Run;
  private stopping = false;
  constructor(readonly directory: string, readonly mode: Run['mode'], readonly host: Host) {}
  private folder(id: string) { return join(this.directory, id); }
  private async persist(run: Run) {
    const folder = this.folder(run.id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(join(folder, 'run.tmp'), JSON.stringify(run), { mode: 0o600 });
    await rename(join(folder, 'run.tmp'), join(folder, 'run.json'));
  }
  async initialise() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
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
        run.status = 'failed';
        run.error = 'Server restarted during execution. Retained host state needs inspection; this demo will not repeat inference automatically.';
        await this.persist(run);
      }
      this.records.set(run.id, run);
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
    const input = { incident: { scenario: 'pod-incident', source: event ? 'kubernetes-event' : 'synthetic-scenario',
      event: event ?? { reason: 'BackOff', message: 'Back-off restarting failed container demo-app',
        involvedObject: { kind: 'Pod', name: 'demo-app', namespace: 'mas-demo' } },
      ...(evidence ? { evidence } : {}), context: evidenceContext(evidence) } };
    const fingerprint = inputFingerprint(input);
    const existing = this.records.get(id);
    if (existing) {
      // Earlier archives retain their original wording and pod-crash alias.
      // Their immutable incident/evidence identity still admits the same retry.
      if (existing.fingerprint !== fingerprint && inputFingerprint(existing.input) !== fingerprint) throw new RequestError(409, 'Run id already belongs to different input');
      return existing;
    }
    if (this.stopping || this.active) throw new RequestError(429, 'One demo is already running; try again after it finishes');
    if (this.records.size >= 50) throw new RequestError(429, 'Demo retains at most 50 runs; archive the data directory before starting a new session');
    if (this.mode === 'live' && !process.env.OPENAI_API_KEY) throw new RequestError(503, 'OPENAI_API_KEY is required for live agents');
    const run: Run = { id, mode: this.mode, status: 'queued', startedAt: new Date().toISOString(), input, fingerprint };
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
  private async execute(run: Run) {
    const folder = this.folder(run.id), state = join(folder, 'host');
    let pendingObservation: Promise<boolean> | undefined;
    const observe = (): Promise<boolean> => {
      if (pendingObservation) return pendingObservation;
      pendingObservation = Promise.resolve().then(() => this.host.observe(run.id, state))
        .then(snapshot => { this.observations.set(run.id, snapshot); return true; })
        // Database creation and SQLite snapshot races do not change the run.
        .catch(() => false)
        .finally(() => { pendingObservation = undefined; });
      return pendingObservation;
    };
    const timer = setInterval(() => void observe(), 250);
    let outcome: { status: 'completed'; output: unknown } | { status: 'failed'; error: string; diagnostics?: FailureDiagnostics };
    try {
      run.status = 'running';
      await this.persist(run);
      const input = join(folder, 'input.json');
      await writeFile(input, JSON.stringify(run.input), { mode: 0o600 });
      outcome = { status: 'completed', output: await this.host.run(run.id, input, state, run.mode) };
    } catch (error) {
      outcome = error instanceof HostRunFailure
        ? { status: 'failed', error: error.message, diagnostics: error.diagnostics }
        : { status: 'failed', error: 'Host did not complete. Inspect retained state before retrying an uncertain provider outcome.' };
    } finally {
      clearInterval(timer);
    }
    try {
      // A poll may have captured the database before the host settled. Wait for
      // it, then obtain a fresh final snapshot before publishing terminal state.
      await pendingObservation;
      if (!await observe()) this.observations.delete(run.id);
      const terminal = { ...run, ...outcome };
      await this.persist(terminal);
      Object.assign(run, terminal);
    } finally { this.active = undefined; }
  }
  async snapshot(id: string) {
    const run = this.get(id);
    if (!this.observations.has(id) && run.status !== 'running' && run.status !== 'queued') {
      try { this.observations.set(id, await this.host.observe(id, join(this.folder(id), 'host'))); } catch { /* Show absence explicitly below. */ }
    }
    return { run, observation: this.observations.get(id) ?? { messages: [] },
      observationAvailable: this.observations.has(id) };
  }
  async shutdown() {
    this.stopping = true;
    if (this.active) await this.host.cancel(this.active.id, join(this.folder(this.active.id), 'host')).catch(() => {});
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
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) throw new RequestError(400, 'Resolution report must be an object of at most 16 KiB');
  const report = value as Record<string, unknown>;
  const required = ['version', 'status', 'action', 'target', 'recordedAt', 'reason', 'patch', 'before', 'after', 'checks'];
  if (Object.keys(report).length !== required.length || required.some(key => !(key in report)) || report.version !== 'mas-k8s-resolution/1' ||
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
  if (report.status === 'verified' && (!report.checks.length || report.checks.some(check => check.passed !== true))) throw new RequestError(400, 'A verified resolution requires successful verification checks');
  if (report.status === 'verified') {
    const verificationChecks = report.checks as ResolutionReport['checks'];
    const checks = ['Admission', 'Patch applied', 'Rollout', 'Template scope', 'New Pod ready', 'Functional HTTP', 'Fresh metrics'];
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
      { op: 'test', path, value: '/readyz' }, { op: 'replace', path, value: '/healthz' },
    ];
    if (verificationChecks.length !== checks.length || checks.some(name => !verificationChecks.some(check => check.name === name && check.passed === true)) || index < 0 ||
        !before || !after || Array.isArray(before) || Array.isArray(after) || before.uid !== target.uid || after.uid !== target.uid ||
        typeof before.resourceVersion !== 'string' || !before.resourceVersion || typeof after.resourceVersion !== 'string' || !after.resourceVersion || after.resourceVersion === before.resourceVersion ||
        before.readinessPath !== '/readyz' || after.readinessPath !== '/healthz' || typeof before.templateHash !== 'string' || !before.templateHash || before.templateHash !== resource.templateHash || typeof after.templateHash !== 'string' || !after.templateHash ||
        typeof before.observedAt !== 'string' || !Number.isFinite(Date.parse(before.observedAt)) || typeof after.observedAt !== 'string' || !Number.isFinite(Date.parse(after.observedAt)) || Date.parse(after.observedAt) < Date.parse(before.observedAt) || Date.parse(report.recordedAt) < Date.parse(after.observedAt) ||
        !Number.isSafeInteger(before.generation) || !Number.isSafeInteger(after.generation) || Number(after.generation) !== Number(before.generation) + 1 ||
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
