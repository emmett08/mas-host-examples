import { createServer, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emptyState, reduceEvent, publicEvent, type ObservationState, type ObservationWindow } from '../ui/events.js';
import { GhCheckApi, findCheck, decodeWindow, retryDelay, type CheckApi, type CheckRun } from './github-check.js';
import { readEvents } from './check-publisher.js';
import { loadDisclosedArtefacts, type DisclosedArtefact } from './disclosure.js';

export interface ObserverStatus {
  mode: 'github-check' | 'direct'; connected: boolean; completed: boolean; lastPollAt: string | null;
  publishedAt: string | null; lastSeq: number; nextPollMs: number; error: string | null; gaps: ObservationState['gaps'];
}
export class EventHub {
  state = emptyState();
  status: ObserverStatus = { mode: 'github-check', connected: false, completed: false, lastPollAt: null, publishedAt: null, lastSeq: 0, nextPollMs: 12_000, error: null, gaps: [] };
  private clients = new Set<ServerResponse>();
  accept(window: ObservationWindow): void {
    for (const event of window.events) {
      const next = reduceEvent(this.state, event);
      if (next !== this.state) {
        const isNew = !this.state.events.some(e => e.seq === event.seq);
        this.state = next;
        if (isNew) this.broadcast(`id: ${event.seq}\nevent: committed\ndata: ${JSON.stringify(event)}\n\n`);
      }
    }
    this.status = { ...this.status, connected: true, completed: window.completed, publishedAt: window.generatedAt,
      lastPollAt: new Date().toISOString(), lastSeq: this.state.lastSeq, gaps: this.state.gaps, error: null };
    this.sendStatus();
  }
  broadcast(message: string): void { for (const client of this.clients) { if (!client.write(message)) { client.end(); this.clients.delete(client); } } }
  sendStatus(): void { this.broadcast(`event: status\ndata: ${JSON.stringify(this.status)}\n\n`); }
  subscribe(res: ServerResponse, after = 0): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' });
    res.write(`retry: 3000\nevent: status\ndata: ${JSON.stringify(this.status)}\n\n`);
    for (const event of this.state.events.filter(e => e.seq > after)) res.write(`id: ${event.seq}\nevent: committed\ndata: ${JSON.stringify(event)}\n\n`);
    this.clients.add(res);
    const heartbeat = setInterval(() => res.write(': observer heartbeat\n\n'), 15_000);
    res.once('close', () => { clearInterval(heartbeat); this.clients.delete(res); });
  }
  close(): void { for (const res of this.clients) res.end(); this.clients.clear(); }
}
export async function pollCheck(api: CheckApi, repository: string, sha: string, incidentId: string, hub: EventHub, checkId?: number): Promise<number | undefined> {
  const check = checkId === undefined ? await findCheck(api, repository, sha, incidentId) : (await api.request<CheckRun>('GET', `/repos/${repository}/check-runs/${checkId}`)).body;
  if (!check) throw new Error('Progress Check Run is not available yet');
  if (check.external_id !== incidentId || check.head_sha !== sha) throw new Error('Check Run identity mismatch');
  const window = decodeWindow(check.output?.text ?? '');
  if (window.incidentId !== incidentId) throw new Error('Progress incident identity mismatch');
  hub.accept(window);
  return check.id;
}
export function createObserverServer(hub: EventHub, uiRoot: string, artefacts: () => Record<string, DisclosedArtefact> = () => ({}), publicOrigin?: string) {
  if (publicOrigin && (new URL(publicOrigin).origin !== publicOrigin || new URL(publicOrigin).protocol !== 'https:')) throw new Error('Public observer origin must be an exact HTTPS origin');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Bind allowed Host as well as Origin to prevent loopback DNS rebinding.
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : 0;
    const origins = publicOrigin ? [publicOrigin] : [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    const hostAllowed = origins.some(origin => new URL(origin).host === req.headers.host);
    // Read-only HTTP still protects private evidence from unrelated browser origins.
    if (req.method !== 'GET' || !hostAllowed || (req.headers.origin && !origins.includes(req.headers.origin))) { res.writeHead(403); res.end('read-only same-origin observer'); return; }
    if (url.pathname === '/api/stream') {
      const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) { res.writeHead(400); res.end('invalid sequence'); return; }
      hub.subscribe(res, after); return;
    }
    if (/^\/api\/artefacts\/[a-f0-9]{64}$/.test(url.pathname)) {
      const ref = `sha256:${url.pathname.split('/').at(-1)}`;
      try {
        const value = artefacts()[ref];
        res.writeHead(value ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(JSON.stringify(value ?? { error: 'Payload is not disclosed by this observation transport' }));
      } catch { res.writeHead(503); res.end('Disclosure manifest unavailable or invalid'); }
      return;
    }
    if (url.pathname === '/api/events' || url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(url.pathname === '/api/events' ? hub.state.events : hub.status)); return;
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!/^\/(?:index\.html|assets\/[A-Za-z0-9_.-]+)$/.test(path)) { res.writeHead(404); res.end('not found'); return; }
    const file = resolve(uiRoot, `.${path}`);
    if (!file.startsWith(resolve(uiRoot) + '/') || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(readFileSync(file));
  });
  return server;
}
function argument(name: string): string | undefined { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; }
export async function main(): Promise<void> {
  const file = argument('events'), repo = argument('repo'), sha = argument('sha'), incidentId = argument('incident');
  if (!incidentId || (!file && (!repo || !sha))) throw new Error('usage: observe --repo OWNER/REPO --sha COMMIT --incident ID [--check ID] OR --events FILE --incident ID');
  const port = Number(argument('port') ?? 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid observer port');
  const hub = new EventHub();
  hub.status.mode = file ? 'direct' : 'github-check';
  const ui = argument('ui') ?? resolve(dirname(fileURLToPath(import.meta.url)), '../ui');
  const artefactsRoot = argument('artefacts'), disclosures = argument('disclosures');
  const server = createObserverServer(hub, ui, () => artefactsRoot && disclosures ? loadDisclosedArtefacts(artefactsRoot, disclosures, process.argv.includes('--disclose-source')) : {}, argument('public-origin'));
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  process.stdout.write(`Live observer: http://127.0.0.1:${port}\nCredentials are used only by the local gh process. No local Kubernetes is required.\n`);
  let stopped = false, failures = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let checkId = argument('check') ? Number(argument('check')) : undefined;
  if (checkId !== undefined && (!Number.isSafeInteger(checkId) || checkId < 1)) throw new Error('invalid Check Run ID');
  const api = repo ? new GhCheckApi(repo) : undefined;
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); hub.close(); server.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const poll = async () => {
    let delay = file ? 1000 : 12_000;
    try {
      if (file) {
        const events = readEvents(file).map(e => publicEvent(e, !process.argv.includes('--disclose')));
        hub.accept({ schema: 'self-remediation-observer/1', incidentId, generatedAt: new Date().toISOString(), firstSeq: events[0]?.seq ?? 0, lastSeq: events.at(-1)?.seq ?? 0, events, completed: events.at(-1)?.type === 'outcome', disclosure: process.argv.includes('--disclose') ? 'redacted' : 'summary' });
      } else checkId = await pollCheck(api!, repo!, sha!, incidentId, hub, checkId);
      failures = 0;
    } catch (error) {
      delay = retryDelay(error, failures++);
      hub.status = { ...hub.status, connected: false, lastPollAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), nextPollMs: delay };
      hub.sendStatus();
    }
    hub.status.nextPollMs = delay;
    if (!stopped) timer = setTimeout(() => { void poll(); }, delay);
  };
  await poll();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
