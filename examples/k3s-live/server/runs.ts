// Own bounded, durable demo run identities and the single live host execution.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HostRunFailure, type Host } from './host.js';
import type { FailureDiagnostics } from './diagnostics.js';

export interface Run {
  id: string; status: 'queued' | 'running' | 'completed' | 'failed';
  mode: 'live' | 'fixture'; startedAt: string; error?: string; output?: unknown;
  diagnostics?: FailureDiagnostics;
  input: { incident: unknown }; fingerprint: string;
}
export class RequestError extends Error { constructor(public status: number, message: string) { super(message); } }
export class Runs {
  readonly records = new Map<string, Run>();
  readonly observations = new Map<string, unknown>();
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
    if (body.scenario !== 'pod-crash') throw new RequestError(400, 'Select scenario pod-crash');
    const id = body.id ?? `demo-${randomUUID()}`;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
      throw new RequestError(400, 'Invalid run id');
    }
    const event = validateEvent(body.event);
    const input = { incident: { scenario: 'pod-crash', source: event ? 'kubernetes-event' : 'synthetic-scenario',
      event: event ?? { reason: 'BackOff', message: 'Back-off restarting failed container demo-app',
        involvedObject: { kind: 'Pod', name: 'demo-app', namespace: 'mas-demo' } },
      context: 'Demonstration only. No logs, metrics or live resource specifications have been collected.' } };
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = this.records.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new RequestError(409, 'Run id already belongs to different input');
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
