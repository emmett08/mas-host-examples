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

test('comparison packaging preserves both approaches and acquisition observations', async t => {
  const directory = await capture(t);
  const acquired = snapshot(800, [], 'running');
  acquired.run = { ...acquired.run, id: 'mcp-captured-run', approach: 'mcp', investigation: { runId: 'mcp-captured-run', status: 'running', calls: [] } };
  acquired.observation = { messages: [] };
  acquired.observationAvailable = false;
  acquired.investigationObservation = { observed_at_ms: 800, messages: [message] };
  const completed = structuredClone(acquired);
  completed.run.status = 'completed';
  completed.run.investigation.status = 'completed';
  completed.observation = { observed_at_ms: 3000, messages: [message] };
  completed.investigationObservation.observed_at_ms = 3000;
  const other = await capture(t, [acquired, completed]);
  const archive = await readArchive(directory, [other]);
  assert.equal(archive.version, 'mas-demo-archive/1');
  assert.equal(archive.comparisons[0].snapshots[0].observedAtMs, 800);
  assert.equal(archive.comparisons[0].snapshots[0].observation.observed_at_ms, undefined);
  assert.equal(archive.comparisons[0].snapshots[0].observationAvailable, false);
  assert.deepEqual(archive.comparisons[0].snapshots[0].investigationObservation.messages, [message]);
  assert.equal(archive.comparisons[0].snapshots.at(-1).run.approach, 'mcp');
  const html = await readFile(await createArchive(directory, [other]), 'utf8');
  const embedded = JSON.parse(html.match(/<script id="mas-demo-archive" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(embedded.comparisons[0].runId, 'mcp-captured-run');
  await assert.rejects(readArchive(directory, [directory]), /different directory/);
  const repeatedApproach = await capture(t, [snapshot(1000)]);
  await assert.rejects(readArchive(directory, [repeatedApproach]), /distinct runs and approaches/);
});

test('missing comparison capture preserves the primary recording; malformed capture still fails', async t => {
  const directory = await capture(t), absent = join(directory, 'not-started-mcp');
  const unavailable = await readArchive(directory, [absent]);
  assert.equal(unavailable.runId, run.id);
  assert.deepEqual(unavailable.comparisons, []);
  const untimed = await capture(t, [{ run: { ...run, approach: 'mcp' }, observationAvailable: false }]);
  assert.deepEqual((await readArchive(directory, [untimed])).comparisons, []);
  const malformed = await capture(t);
  await writeFile(join(malformed, 'topology.json'), '{');
  await assert.rejects(readArchive(directory, [malformed]), /malformed JSON/);
});

test('comparison timeline uses the latest actual host time and preserves both journals', async t => {
  const directory = await capture(t);
  const acquisition = { run: { ...run, id: 'mcp-times', approach: 'mcp' }, observationAvailable: false,
    observation: { messages: [] }, investigationObservation: { observed_at_ms: 2_000, messages: [] } };
  const assessment = { run: { ...acquisition.run, status: 'completed' }, observationAvailable: true,
    observation: { observed_at_ms: 1_900, messages: [message] },
    investigationObservation: { observed_at_ms: 2_100, messages: [] } };
  const comparisonDirectory = await capture(t, [acquisition, assessment]);
  const result = (await readArchive(directory, [comparisonDirectory])).comparisons[0];
  assert.deepEqual(result.snapshots.map(item => item.observedAtMs), [2_000, 2_100]);
  assert.equal(result.snapshots[0].observation.observed_at_ms, undefined);
  assert.equal(result.snapshots[1].observation.observed_at_ms, 1_900);
  assert.equal(result.snapshots[1].investigationObservation.observed_at_ms, 2_100);
});
