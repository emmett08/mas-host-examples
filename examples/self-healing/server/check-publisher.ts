import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeWindow, parseEvent, type ObservationEvent } from '../ui/events.js';
import { CHECK_NAME, GhCheckApi, decodeWindow, encodeWindow, findCheck, retryDelay, type CheckApi, type CheckRun } from './github-check.js';

export interface PublisherState {
  incidentId: string; sha: string; checkId?: number; createDispatched?: boolean;
  pending?: { text: string; completed: boolean }; lastSeq?: number; completed?: boolean;
  firstPublishedAt?: string; lastPublishedAt?: string; inProgressUpdates?: number;
}
export function readEvents(path: string): ObservationEvent[] {
  if (!existsSync(path)) return [];
  const contents = readFileSync(path, 'utf8');
  // Only newline-terminated records are committed to the projection file.
  return contents.slice(0, contents.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => parseEvent(JSON.parse(line)));
}
export class CheckPublisher {
  state: PublisherState;
  constructor(readonly api: CheckApi, readonly repository: string, readonly sha: string, readonly incidentId: string, readonly stateFile: string) {
    this.state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { incidentId, sha };
    if (this.state.incidentId !== incidentId || this.state.sha !== sha) throw new Error('publisher identity changed');
  }
  save(): void {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }
  observerCommand(): string | undefined {
    if (!this.state.checkId || !this.state.firstPublishedAt || this.state.pending) return undefined;
    return `node observe.mjs --repo ${this.repository} --sha ${this.sha} --incident ${this.incidentId} --check ${this.state.checkId}`;
  }
  acknowledged(text: string, completed: boolean): void {
    const window = decodeWindow(text);
    const at = new Date().toISOString();
    this.state.firstPublishedAt ??= at; this.state.lastPublishedAt = at;
    if (!completed && window.lastSeq > 0) this.state.inProgressUpdates = (this.state.inProgressUpdates ?? 0) + 1;
    this.state.lastSeq = window.lastSeq; this.state.completed = completed; delete this.state.pending; this.save();
  }
  async tick(events: ObservationEvent[], completed = false): Promise<number> {
    if (events.some(e => e.incidentId !== this.incidentId)) throw new Error('publisher incident mismatch');
    if (!this.state.checkId) {
      const existing = await findCheck(this.api, this.repository, this.sha, this.incidentId);
      if (existing) { this.state.checkId = existing.id; this.save(); }
      else if (this.state.createDispatched) throw new Error('Check Run creation outcome unknown; no repeated POST');
      else {
        this.state.createDispatched = true; this.save();
        const created = await this.api.request<CheckRun>('POST', `/repos/${this.repository}/check-runs`, {
          name: CHECK_NAME, head_sha: this.sha, external_id: this.incidentId, status: 'in_progress',
          started_at: new Date().toISOString(), output: { title: 'Self-healing observation starting', summary: 'Committed incident events will appear here during the run.', text: encodeWindow(makeWindow([], this.incidentId)) },
        });
        this.state.checkId = created.body.id; this.save();
      }
    }
    const endpoint = `/repos/${this.repository}/check-runs/${this.state.checkId}`;
    if (this.state.pending) {
      const found = await this.api.request<CheckRun>('GET', endpoint);
      if (found.body.external_id !== this.incidentId || found.body.head_sha !== this.sha) throw new Error('Check Run target changed');
      if (found.body.output?.text !== this.state.pending.text) throw new Error('Check Run update outcome unknown; no automatic repetition');
      this.acknowledged(this.state.pending.text, this.state.pending.completed);
    }
    if (this.state.completed) return this.state.checkId!;
    const window = makeWindow(events, this.incidentId, completed);
    const text = encodeWindow(window);
    this.state.pending = { text, completed }; this.save();
    await this.api.request<CheckRun>('PATCH', endpoint, { status: completed ? 'completed' : 'in_progress',
      ...(completed ? { conclusion: 'neutral', completed_at: new Date().toISOString() } : {}),
      output: { title: completed ? 'Observation complete — inspect measured outcome' : 'Self-healing live observation',
        summary: `Incident \`${this.incidentId}\` · committed sequence ${window.lastSeq} · published ${window.generatedAt}. This Check Run reports progress, not acceptance. Windows may omit older events.`, text } });
    this.acknowledged(text, completed);
    return this.state.checkId!;
  }
}
function argument(name: string): string | undefined { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; }
export async function main(): Promise<void> {
  const eventsFile = argument('events'), incidentId = argument('incident'), repo = argument('repo'), sha = argument('sha'), state = argument('state'), done = argument('done');
  if (!eventsFile || !incidentId || !repo || !sha || !state || !done) throw new Error('usage: check-publisher --events FILE --incident ID --repo OWNER/REPO --sha SHA --state FILE --done FILE');
  mkdirSync(dirname(state), { recursive: true });
  const lock = `${state}.lock`;
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, String(process.pid)); }
  catch { throw new Error(`publisher owner already reserved at ${lock}; confirm the former process stopped before removing it`); }
  const publisher = new CheckPublisher(new GhCheckApi(repo), repo, sha, incidentId, state);
  let failures = 0, stopped = false, announced = false;
  process.once('SIGTERM', () => { stopped = true; }); process.once('SIGINT', () => { stopped = true; });
  try {
    while (!stopped) {
      let delay = 12_000;
      try {
        const complete = existsSync(done);
        const checkId = await publisher.tick(readEvents(eventsFile), complete);
        const command = publisher.observerCommand();
        if (!announced && command) { process.stdout.write(`Live observer: ${command}\n`); announced = true; }
        process.stdout.write(`observer check=${checkId} seq=${publisher.state.lastSeq ?? 0} completed=${complete}\n`);
        failures = 0;
        if (complete || process.argv.includes('--once')) break;
      } catch (error) { delay = retryDelay(error, failures++); process.stderr.write(`Observation publisher: ${error instanceof Error ? error.message : String(error)}; retry in ${delay}ms\n`); }
      await new Promise<void>(resolveDelay => { const finish = () => { clearTimeout(timer); process.removeListener('SIGTERM', finish); process.removeListener('SIGINT', finish); resolveDelay(); }; const timer = setTimeout(finish, delay); process.once('SIGTERM', finish); process.once('SIGINT', finish); });
    }
  } finally { closeSync(fd); unlinkSync(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
