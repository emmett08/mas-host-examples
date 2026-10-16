import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runs, RequestError } from './runs.js';
import type { Host } from './host.js';
import { application } from './http.js';

test('idempotent event dispatch, conflicting input rejection, admission bound, and crash recovery', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  let complete!: (result: unknown) => void;
  const host = { run: async () => { calls++; return new Promise(resolve => { complete = resolve; }); },
    observe: async () => ({ messages: [{ id: 'message-1' }] }), cancel: async () => {} } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  const input = { id: 'event-a', scenario: 'pod-crash', event: { reason: 'BackOff' } };
  const first = await runs.create(input);
  await assert.rejects(runs.create({ ...input, event: { reason: 'Different' } }), (e: unknown) => e instanceof RequestError && e.status === 409);
  assert.equal(await runs.create(input), first);
  await assert.rejects(runs.create({ id: 'event-b', scenario: 'pod-crash' }), (e: unknown) => e instanceof RequestError && e.status === 429);
  while (!complete) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  // A restarted API retains identity and refuses to repeat an uncertain inference.
  const restarted = new Runs(dir, 'fixture', host);
  await restarted.initialise();
  assert.equal((await restarted.create(input)).status, 'failed');
  assert.equal(calls, 1);
  complete({ summary: 'done' });
  while (runs.get('event-a').status === 'running') await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runs.get('event-a').status, 'completed');
  assert.equal((await runs.snapshot('event-a')).observationAvailable, true);
});

test('HTTP rejects cross-origin dispatch and invalid evidence, serves retained snapshots', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = { run: async () => ({ summary: 'fixture' }), observe: async () => ({ messages: [] }) } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  const server = application(runs, { nodes: [], edges: [] }, dir);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, origin?: string) => fetch(`${url}/api/runs`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ scenario: 'pod-crash' }, 'https://attacker.invalid')).status, 403);
  assert.equal((await post({ scenario: 'pod-crash', event: { message: 'a'.repeat(2001) } })).status, 400);
  const response = await post({ id: 'http-run', scenario: 'pod-crash' });
  assert.equal(response.status, 202);
  while (runs.get('http-run').status !== 'completed') await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await (await fetch(`${url}/api/runs/http-run`)).json()).mode, 'fixture');
  assert.equal((await (await fetch(`${url}/api/runs/http-run/snapshot`)).json()).observationAvailable, true);
  assert.equal((await fetch(`${url}/api/runs/absent`)).status, 404);
});

test('terminal state waits for an in-flight observation and a fresh final snapshot', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-final-observation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let complete!: (value: unknown) => void;
  let releaseObservation!: (value: unknown) => void;
  let observeCalls = 0;
  const host = {
    run: () => new Promise(resolve => { complete = resolve; }),
    observe: () => {
      observeCalls++;
      if (observeCalls === 1) return new Promise(resolve => { releaseObservation = resolve; });
      return Promise.resolve({ messages: [{ id: 'request' }, { id: 'final-result' }] });
    },
  } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  await runs.create({ id: 'observed', scenario: 'pod-crash' });
  await waitFor(() => Boolean(releaseObservation));
  complete({ summary: 'done' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(runs.get('observed').status, 'running');
  await assert.rejects(runs.create({ id: 'too-soon', scenario: 'pod-crash' }),
    (error: unknown) => error instanceof RequestError && error.status === 429);
  releaseObservation({ messages: [{ id: 'request' }] });
  await waitFor(() => runs.get('observed').status === 'completed');
  assert.equal(observeCalls, 2);
  const snapshot = await runs.snapshot('observed');
  assert.deepEqual(snapshot.observation, { messages: [{ id: 'request' }, { id: 'final-result' }] });
  assert.equal(JSON.parse(await readFile(join(dir, 'observed', 'run.json'), 'utf8')).status, 'completed');
});

test('interrupted initial admissions recover, while unrecorded host state requires inspection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-interrupted-admission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'empty'));
  await mkdir(join(dir, 'temporary'));
  await writeFile(join(dir, 'temporary', 'run.tmp'), '{"status":"queued"');
  let calls = 0;
  const host = { run: async () => { calls++; return {}; },
    observe: async () => ({ messages: [] }) } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  assert.equal(calls, 0);
  assert.equal(runs.list().length, 0);
  await runs.create({ id: 'temporary', scenario: 'pod-crash' });
  await waitFor(() => runs.get('temporary').status === 'completed');
  assert.equal(calls, 1);
  await mkdir(join(dir, 'uncertain', 'host'), { recursive: true });
  await assert.rejects(new Runs(dir, 'fixture', host).initialise(),
    /retained state without an admission record; inspect the data directory/);
  assert.equal(calls, 1);
});

test('a failed terminal write is handled and releases the execution slot without replay', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-terminal-write-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let complete!: (value: unknown) => void;
  let calls = 0;
  const host = { run: () => {
    calls++;
    return calls === 1 ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({});
  }, observe: async () => ({ messages: [] }) } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  const input = { id: 'write-fails', scenario: 'pod-crash' };
  await runs.create(input);
  await waitFor(() => Boolean(complete));
  // Block the temporary write after admission without losing its durable
  // manifest. This fails deterministically even when the test runs as root.
  await mkdir(join(dir, 'write-fails', 'run.tmp'));
  complete({});
  await waitFor(() => runs.get('write-fails').status === 'failed');
  assert.match(runs.get('write-fails').error ?? '', /Could not retain the run outcome/);
  assert.equal((await runs.create(input)).status, 'failed');
  assert.equal(calls, 1);
  await rm(join(dir, 'write-fails', 'run.tmp'), { recursive: true });
  const restarted = new Runs(dir, 'fixture', host);
  await restarted.initialise();
  assert.equal((await restarted.create(input)).status, 'failed');
  assert.equal(calls, 1);
  await runs.create({ id: 'next-run', scenario: 'pod-crash' });
  await waitFor(() => runs.get('next-run').status === 'completed');
  assert.equal(calls, 2);
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the run transition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
