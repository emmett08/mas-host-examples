import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { archiveDocument, createArchive, readArchive } from './archive.mjs';

const topology = { mode: 'live', nodes: [
  { id: 'client', label: 'Client', kind: 'client' },
  { id: 'coordinator', label: 'Coordinator', kind: 'workflow' },
], edges: [{ from: 'client', to: 'coordinator' }] };
const run = { id: 'captured-run', mode: 'live', status: 'running', startedAt: '2026-10-16T12:00:00.000Z' };
const message = { id: 'request-1', sequence: 1, sender: 'client', recipient: 'coordinator', kind: 'request' };
const snapshot = (at, messages = [], status = 'running') => ({
  run: { ...run, status }, observationAvailable: true,
  observation: { observed_at_ms: at, messages },
});

async function capture(t, samples = [snapshot(1000), snapshot(2000, [message], 'failed')]) {
  const directory = await mkdtemp(join(tmpdir(), 'mas-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(directory, 'topology.json'), JSON.stringify(topology)),
    writeFile(join(directory, 'snapshot.json'), JSON.stringify(samples.at(-1))),
    writeFile(join(directory, 'snapshots.ndjson'), samples.map(sample => JSON.stringify(sample)).join('\n') + '\n'),
  ]);
  return directory;
}

test('archive preserves actual observations and filters unavailable pre-observation samples', async t => {
  const samples = [
    { run, observationAvailable: false }, snapshot(1000), snapshot(2000, [message], 'failed'),
  ];
  const directory = await capture(t, samples);
  const archive = await readArchive(directory);
  assert.equal(archive.version, 'mas-demo-archive/1');
  assert.equal(archive.runId, run.id);
  assert.deepEqual(archive.snapshots, samples.slice(1));
  assert.deepEqual(archive.topology, topology);
  assert.equal(archive.capturedAt, new Date(2000).toISOString());
});

test('recorded request and result payloads survive packaging without executing embedded markup', async t => {
  const hostile = '</script><script>globalThis.injected=true</script>&<>\u2028\u2029';
  const request = { ...message, payload: { operation: 'incident_review/1', task_id: 'task-1',
    input: { incident: { event: { message: hostile }, evidence: [null, false, { attempts: 3 }] } } } };
  const result = { id: 'result-1', sequence: 2, sender: 'coordinator', recipient: 'client', kind: 'result',
    correlation: request.id, payload: { task_id: 'task-1', reply_to: request.id,
      output: { summary: hostile, next_checks: ['Inspect status', 'Compare logs'] } } };
  const samples = [snapshot(1000, [request]), snapshot(2000, [request, result], 'completed')]
    .map(sample => ({ ...sample, observation: { ...sample.observation, payloads_included: true } }));
  const directory = await capture(t, samples);
  const html = await readFile(await createArchive(directory), 'utf8');
  const embedded = JSON.parse(html.match(/<script id="mas-demo-archive" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(embedded.snapshots, samples);
  assert.deepEqual(embedded.snapshots.at(-1).observation.messages.map(item => item.payload), [request.payload, result.payload]);
  assert.equal([...html.matchAll(/^<script\b/gim)].length, 2);
  assert.equal(html.includes(hostile), false);
});

test('missing capture files and unavailable observations skip without fabricating timestamps', async t => {
  const directory = await capture(t, [{ run, observationAvailable: false }]);
  assert.equal(await readArchive(directory), undefined);
  await rm(join(directory, 'snapshot.json'));
  assert.equal(await createArchive(directory), undefined);
});

test('malformed captures and inconsistent or backwards observation histories fail', async t => {
  for (const samples of [
    [snapshot(2000), snapshot(1000)],
    [snapshot(1000), { ...snapshot(2000), run: { ...run, id: 'another-run' } }],
    [snapshot(1000), { ...snapshot(2000), run: { ...run, mode: 'fixture' } }],
    [snapshot(1000), { ...snapshot(2000), run: { ...run, startedAt: '2026-10-16T13:00:00.000Z' } }],
    [snapshot(1000), { ...snapshot(2000), observation: { messages: [] } }],
    [snapshot(1000), snapshot(2000, [{ ...message, sequence: 2 }, { ...message, id: 'request-2' }])],
  ]) {
    const directory = await capture(t, samples);
    await assert.rejects(readArchive(directory), /Cannot archive/);
  }
  const directory = await capture(t);
  await writeFile(join(directory, 'snapshots.ndjson'), '{malformed json\n');
  await assert.rejects(readArchive(directory), /malformed JSON in snapshots.ndjson/);
});

test('embedded data and bundle strings cannot close their HTML script or style elements', () => {
  const hostile = '</script><script>globalThis.injected=true</script>&<>\u2028\u2029';
  const data = { version: 'mas-demo-archive/1', hostile };
  const javascript = 'globalThis.label = "</SCRIPT><img src=untrusted>";';
  const css = '.label::before { content: "</STYLE><script>"; }';
  const html = archiveDocument(data, javascript, css);
  const scripts = [...html.matchAll(/^<script\b[^>]*>([\s\S]*?)<\/script>/gim)];
  assert.equal(scripts.length, 2);
  assert.deepEqual(JSON.parse(scripts[0][1]), data);
  const context = {};
  new Script(scripts[1][1]).runInNewContext(context);
  assert.equal(context.label, '</SCRIPT><img src=untrusted>');
  assert.equal(context.injected, undefined);
  assert.equal([...html.matchAll(/<\/style>/gi)].length, 1);
  assert.match(html, /connect-src 'none'/);
});

test('packaging compiles the real Vue entry and embeds all scripts, styles and observations', async t => {
  const directory = await capture(t);
  // Other files in the capture directory remain untouched and outside the embedded data.
  await mkdir(join(directory, 'video'));
  const htmlFile = await createArchive(directory);
  const html = await readFile(htmlFile, 'utf8');
  assert.deepEqual((await readdir(join(directory, 'dashboard'))).sort(), ['README.md', 'index.html']);
  assert.equal([...html.matchAll(/^<script\b/gim)].length, 2);
  assert.doesNotMatch(html, /^<script\b[^>]+src=|^<link\b[^>]+href=/im);
  const data = html.match(/<script id="mas-demo-archive" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.deepEqual(JSON.parse(data).snapshots, [snapshot(1000), snapshot(2000, [message], 'failed')]);
  const javascript = [...html.matchAll(/^<script\b[^>]*>([\s\S]*?)<\/script>/gim)][1][1];
  assert.doesNotThrow(() => new Script(javascript));
  assert.ok(!javascript.includes('process.env.NODE_ENV'), 'the browser bundle must resolve its production environment');
  assert.ok(javascript.length > 40_000, 'the Vue runtime and application should be bundled');
});
