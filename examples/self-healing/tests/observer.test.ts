import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, reduceEvent, replay, redact, makeWindow, parseEvent, type ObservationEvent } from '../ui/events.js';
import { ApiError, retryDelay, encodeWindow, decodeWindow, parseGhResponse, findCheck, CHECK_NAME, type CheckApi, type CheckRun, type ApiResponse } from '../server/github-check.js';
import { CheckPublisher } from '../server/check-publisher.js';
import { EventHub, createObserverServer, pollCheck } from '../server/index.js';
const incidentId = 'observer-test';
function event(seq: number, type = 'measurement', data: Record<string, unknown> = {}): ObservationEvent { return { seq, incidentId, type, data, time: `2026-10-18T10:00:${String(seq % 60).padStart(2, '0')}.000Z` }; }

test('live and replay share a reducer with deduplication, explicit gaps and conflict detection', () => {
  const first = event(1), later = event(3, 'outcome', { outcome: 'VERIFIED_RECOVERY' });
  let state = reduceEvent(reduceEvent(emptyState(), first), later);
  assert.deepEqual(state.gaps, [{ from: 2, to: 2, reason: 'missed-window' }]);
  assert.equal(reduceEvent(state, later), state);
  state = reduceEvent(state, event(2));
  assert.deepEqual(state.gaps, []);
  state = reduceEvent(state, event(3, 'outcome', { outcome: 'NO_ELIGIBLE_CANDIDATE' }));
  assert.equal(state.gaps[0]?.reason, 'conflicting-duplicate');
  assert.equal(state.events.at(-1)?.data.outcome, 'VERIFIED_RECOVERY');
  assert.throws(() => reduceEvent(state, { ...event(4), incidentId: 'different' }), /identity/);
});
test('seeking rebuilds every panel from a committed prefix without future-result leakage', () => {
  const events = [event(1, 'incident.opened', { baseCommit: 'base' }), event(2, 'hypotheses', { summary: 'tentative' }), event(3, 'outcome', { outcome: 'FUTURE_SUCCESS' })];
  assert.equal(replay(events, 0).incidentId, null);
  assert.equal(replay(events, 2).events.length, 2);
  assert.ok(!JSON.stringify(replay(events, 2)).includes('FUTURE_SUCCESS'));
  assert.equal(replay(events, 3).events.at(-1)?.data.outcome, 'FUTURE_SUCCESS');
  assert.throws(() => parseEvent({ type: 'pending', data: {} }), /invalid committed/);
});
test('compact Check Run projection bounds bytes and redacts secrets before transport', () => {
  const raw = { apiKey: 'sensitive', token: 'unrecognised secret format', nested: { authorization: 'Bearer something', summary: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 is hidden' }, stdout: 'private stdout' };
  const clean = JSON.stringify(redact(raw));
  assert.ok(!clean.includes('sensitive')); assert.ok(!clean.includes('unrecognised secret')); assert.ok(!clean.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ')); assert.ok(!clean.includes('private stdout'));
  const events = Array.from({ length: 128 }, (_, i) => event(i + 1, 'hypotheses', { summary: 'é'.repeat(900), opaque: 'never expose' }));
  const window = makeWindow(events, incidentId, false, new Date(), 12_000);
  assert.ok(Buffer.byteLength(JSON.stringify(window)) <= 12_000);
  assert.ok(window.firstSeq > 1);
  assert.equal(window.lastSeq, 128);
  assert.ok(!JSON.stringify(window).includes('never expose'));
  assert.deepEqual(decodeWindow(encodeWindow(window)), window);
  const identity = makeWindow([event(1, 'incident.opened', { incidentId, mode: 'live', trigger: { podUid: 'pod-identity', sourceCommit: 'a'.repeat(40), imageDigest: 'immutable-image', configurationSha256: 'b'.repeat(64), kubeconfig: 'private source credential' } })], incidentId);
  const retained = identity.events[0]!.data.trigger as Record<string, unknown>;
  assert.equal(retained.podUid, 'pod-identity'); assert.equal(retained.sourceCommit, 'a'.repeat(40));
  assert.equal(retained.configurationSha256, 'b'.repeat(64)); assert.equal(retained.kubeconfig, '[redacted]');
  const trial = makeWindow([event(1, 'trial', { recovered: true, observation: { diagnostics: 'raw deployment detail' } })], incidentId).events[0]!;
  assert.equal(trial.data.recovered, true); assert.equal(trial.data.observation, '[retained in artefact]');
});
test('rate limits respect server retry/reset instructions and bounded exponential fallback', () => {
  assert.equal(retryDelay(new ApiError('limit', 429, { 'retry-after': '77' }), 0), 77_000);
  assert.equal(retryDelay(new ApiError('limit', 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '60' }), 0, 10_000), 51_000);
  assert.equal(retryDelay(new ApiError('limit', 403, {}), 0), 60_000);
  const parsed = parseGhResponse<{ id: number }>('HTTP/2.0 200 OK\r\nX-RateLimit-Remaining: 9\r\n\r\n{"id": 1}');
  assert.equal(parsed.headers['x-ratelimit-remaining'], '9'); assert.equal(parsed.body.id, 1);
});
class MemoryChecks implements CheckApi {
  check?: CheckRun; posts = 0; patches = 0; loseCreate = false; losePatch = false; rejectPatch = false;
  async request<T>(method: 'GET' | 'POST' | 'PATCH', endpoint: string, body?: unknown): Promise<ApiResponse<T>> {
    let data: unknown;
    if (method === 'POST') { this.posts++; this.check = { ...(body as CheckRun), id: 42 }; if (this.loseCreate) { this.loseCreate = false; throw new Error('response lost'); } data = this.check; }
    else if (method === 'PATCH') { this.patches++; if (this.rejectPatch) throw new Error('unknown write outcome'); this.check = { ...this.check!, ...(body as CheckRun) }; if (this.losePatch) { this.losePatch = false; throw new Error('response lost'); } data = this.check; }
    else data = endpoint.includes('/commits/') ? { check_runs: this.check ? [this.check] : [] } : this.check;
    return { status: 200, headers: {}, body: data as T };
  }
}
test('renamed observation discovers both Check Run names and rejects ambiguous or mismatched identities', async () => {
  const sha = 'a'.repeat(40);
  const current: CheckRun = { id: 42, name: CHECK_NAME, external_id: incidentId, head_sha: sha, status: 'in_progress' };
  const legacy: CheckRun = { ...current, id: 41, name: 'Self-remediation live observation' };
  let checks: CheckRun[] = [];
  const api: CheckApi = { async request<T>(_method, endpoint) {
    const name = new URL(endpoint, 'https://api.github.com').searchParams.get('check_name');
    return { status: 200, headers: {}, body: { check_runs: checks.filter(c => c.name === name) } as T };
  } };
  for (const check of [current, legacy]) {
    checks = [check, { ...check, id: 43, external_id: 'other-incident' }, { ...check, id: 44, head_sha: 'b'.repeat(40) }];
    assert.equal((await findCheck(api, 'owner/repo', sha, incidentId))?.id, check.id);
  }
  checks = [current, legacy];
  await assert.rejects(findCheck(api, 'owner/repo', sha, incidentId), /duplicate Check Runs/);
  checks = [{ ...legacy, external_id: 'other-incident' }, { ...current, head_sha: 'b'.repeat(40) }];
  assert.equal(await findCheck(api, 'owner/repo', sha, incidentId), undefined);
});
test('lost Check Run create/update responses reconcile before further effects across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'observer-')); const state = join(dir, 'state.json'), api = new MemoryChecks(), sha = 'a'.repeat(40);
  try {
    api.loseCreate = true;
    await assert.rejects(new CheckPublisher(api, 'owner/repo', sha, incidentId, state).tick([event(1)]), /lost/);
    assert.equal(api.posts, 1);
    const resumed = new CheckPublisher(api, 'owner/repo', sha, incidentId, state);
    api.losePatch = true; await assert.rejects(resumed.tick([event(1)]), /lost/);
    await new CheckPublisher(api, 'owner/repo', sha, incidentId, state).tick([event(1), event(2)], true);
    assert.equal(api.posts, 1); assert.equal(api.check?.status, 'completed');
    assert.equal(decodeWindow(api.check?.output?.text ?? '').lastSeq, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('an unresolved Check Run write is never automatically repeated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'observer-')), api = new MemoryChecks();
  try {
    const publisher = new CheckPublisher(api, 'owner/repo', 'a'.repeat(40), incidentId, join(dir, 'state.json'));
    api.rejectPatch = true; await assert.rejects(publisher.tick([event(1)]), /unknown/);
    api.rejectPatch = false; await assert.rejects(publisher.tick([event(1)]), /unknown/);
    assert.equal(api.patches, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('observer command identifies an acknowledged Check Run and stays unavailable after a lost response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'observer-command-')), api = new MemoryChecks();
  const state = join(dir, 'state.json'), sha = 'a'.repeat(40);
  try {
    const publisher = new CheckPublisher(api, 'owner/repo', sha, incidentId, state);
    assert.equal(publisher.observerCommand(), undefined);
    api.loseCreate = true;
    await assert.rejects(publisher.tick([event(1)]), /lost/);
    assert.equal(publisher.observerCommand(), undefined);
    const resumed = new CheckPublisher(api, 'owner/repo', sha, incidentId, state);
    api.losePatch = true;
    await assert.rejects(resumed.tick([event(1)]), /lost/);
    assert.equal(resumed.observerCommand(), undefined);
    await resumed.tick([event(1)]);
    assert.equal(resumed.observerCommand(), `node observe.mjs --repo owner/repo --sha ${sha} --incident ${incidentId} --check 42`);
    assert.equal(api.posts, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('Check Run polling produces SSE updates before completion with reconnect sequence suppression', async () => {
  const api = new MemoryChecks(), hub = new EventHub();
  api.check = { id: 42, name: 'Self-healing live observation', external_id: incidentId, head_sha: 'a'.repeat(40), status: 'in_progress', output: { text: encodeWindow(makeWindow([event(1), event(2)], incidentId)) } };
  await pollCheck(api, 'owner/repo', 'a'.repeat(40), incidentId, hub, 42);
  assert.equal(hub.status.completed, false); assert.equal(hub.state.lastSeq, 2);
  const server = createObserverServer(hub, '/nonexistent');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/stream?after=1`, { signal: controller.signal });
    const reader = response.body!.getReader(); const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.ok(chunk.includes('id: 2')); assert.ok(!chunk.includes('id: 1\n'));
    assert.ok(chunk.includes('"completed":false'));
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/events`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/status`, { headers: { origin: 'https://evil.invalid' } })).status, 403);
    const { request } = await import('node:http');
    const rebound = await new Promise<number | undefined>((resolve, reject) => { const req = request({ hostname: '127.0.0.1', port: address.port, path: '/api/status', headers: { host: `rebound.invalid:${address.port}` } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
    assert.equal(rebound, 403);
  } finally { controller.abort(); hub.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('disclosed artefacts are explicit, identity checked, source opt-in, and projection hashes are honest', async () => {
  const { writeFileSync, mkdirSync, symlinkSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { loadDisclosedArtefacts } = await import('../server/disclosure.js');
  const directory = mkdtempSync(join(tmpdir(), 'observer-disclosure-'));
  try {
    const artefacts = join(directory, 'artefacts'); mkdirSync(artefacts);
    const source = JSON.stringify([{ path: 'src/app.ts', content: 'export const quote = 42;' }]);
    const hash = createHash('sha256').update(source).digest('hex'); writeFileSync(join(artefacts, hash), source);
    const secret = JSON.stringify({ status: 'passed', apiKey: 'never published' });
    const secretHash = createHash('sha256').update(secret).digest('hex'); writeFileSync(join(artefacts, secretHash), secret);
    const manifest = join(directory, 'disclosed.json'); writeFileSync(manifest, JSON.stringify([`sha256:${hash}`, `sha256:${secretHash}`]));
    assert.equal(Object.keys(loadDisclosedArtefacts(artefacts, manifest)).length, 1);
    const disclosed = loadDisclosedArtefacts(artefacts, manifest, true);
    assert.equal(Object.keys(disclosed).length, 2);
    assert.equal(disclosed[`sha256:${hash}`]?.sourceDisclosure, true);
    assert.notEqual(disclosed[`sha256:${secretHash}`]?.projectionDigest, secretHash);
    assert.ok(!JSON.stringify(disclosed).includes('never published'));
    writeFileSync(join(artefacts, hash), 'tampered');
    assert.throws(() => loadDisclosedArtefacts(artefacts, manifest, true), /identity mismatch/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
