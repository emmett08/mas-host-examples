// Serve the local demo API, bounded SSE snapshots and compiled Vue assets.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { RequestError, type Runs } from './runs.js';

export function application(runs: Runs, topology: unknown, ui: string, verifierToken?: string) {
  let clients = 0;
  const server = createServer((req, res) => { void route(req, res).catch(error => {
    if (res.headersSent) { res.destroy(); return; }
    reply(res, error instanceof RequestError ? error.status : 500,
      { error: error instanceof RequestError ? error.message : 'Demo service could not handle the request' });
  }); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  async function route(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Cache-Control', 'no-store');
    const path = new URL(req.url ?? '/', 'http://demo.local').pathname;
    if (req.method === 'GET' && path === '/api/health') return reply(res, 200, { status: 'ok', mode: runs.mode });
    if (req.method === 'GET' && path === '/api/topology') return reply(res, 200, topology);
    if (req.method === 'GET' && path === '/api/runs') return reply(res, 200, runs.list());
    if (req.method === 'POST' && path === '/api/runs') return reply(res, 202, await runs.create(await requestBody(req)));
    const resolution = /^\/api\/runs\/([a-zA-Z0-9_-]{1,64})\/(resolution|reconciliations)$/.exec(path);
    if (req.method === 'POST' && resolution) {
      if (!verifierToken) throw new RequestError(503, 'External verifier reporting is not configured');
      const expected = Buffer.from(`Bearer ${verifierToken}`), supplied = Buffer.from(req.headers.authorization ?? '');
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new RequestError(401, 'External verifier authentication is required');
      const body = await requestBody(req);
      if (resolution[2] === 'resolution') await runs.recordResolution(resolution[1]!, body);
      else await runs.recordReconciliation(resolution[1]!, body);
      return reply(res, 202, { accepted: true, runId: resolution[1], kind: resolution[2],
        recordId: createHash('sha256').update(JSON.stringify(body)).digest('hex') });
    }
    const match = /^\/api\/runs\/([a-zA-Z0-9_-]{1,64})(\/(?:events|snapshot|remediation))?$/.exec(path);
    if (req.method === 'GET' && match) {
      const id = match[1]!;
      runs.get(id);
      if (!match[2]) return reply(res, 200, runs.get(id));
      if (match[2] === '/snapshot') return reply(res, 200, await runs.snapshot(id));
      if (match[2] === '/remediation') return reply(res, 200, await runs.remediationSnapshot(id));
      if (clients >= 20) throw new RequestError(429, 'Too many event viewers');
      clients++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      let pending = false, closed = false;
      const send = async () => {
        if (pending || closed) return;
        pending = true;
        try {
          const snapshot = await runs.snapshot(id);
          if (closed) return;
          if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
          res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
        } catch { res.destroy(); }
        finally { pending = false; }
      };
      const timer = setInterval(() => void send(), 300);
      res.on('close', () => { closed = true; clearInterval(timer); clients--; });
      void send();
      return;
    }
    if (path.startsWith('/api/')) throw new RequestError(404, 'Unknown API endpoint');
    if (req.method !== 'GET') throw new RequestError(405, 'Method is not supported');
    const root = resolve(ui), filename = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
    const file = resolve(root, filename);
    if (!file.startsWith(root + sep)) throw new RequestError(404, 'Unknown asset');
    let data: Buffer;
    try { data = await readFile(file); } catch { throw new RequestError(404, 'Unknown asset'); }
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  }
  return server;
}
async function requestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new RequestError(415, 'Use application/json');
  const origin = req.headers.origin;
  if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && new URL(origin).host !== req.headers.host)) throw new RequestError(403, 'Cross-origin run changes are disabled');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new RequestError(413, 'Request exceeds 64 KiB');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new RequestError(400, 'Invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'Expected JSON object');
  return body;
}
function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
