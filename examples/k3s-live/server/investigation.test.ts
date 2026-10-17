import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { freezeInvestigation, InvestigationEvidenceFailure, retainFile } from './investigation.js';
import { Runs } from './runs.js';
import type { Host } from './host.js';
import { EVIDENCE_VERSION, type EvidenceBundle } from '../shared/evidence.js';
const subject = { namespace: 'mas-demo', name: 'checkout-a', uid: 'pod-a' };
const at = '2026-10-17T18:00:00Z';
const seed: EvidenceBundle = { version: EVIDENCE_VERSION, capturedAt: at, subject, items: [{ id: 'seed-only', kind: 'logs',
  source: 'seed', status: 'collected', observedAt: at, truncated: false, data: { text: 'Never copy seed evidence automatically' } }] };
const hash = 'a'.repeat(64);
const evidence = { id: 'pod', kind: 'pod', source: 'kubernetes-api', status: 'collected', observedAt: at,
  truncated: false, data: { kind: 'Pod', metadata: subject } };
const result = () => ({ status: 'collected', source: 'kubernetes-api', server: 'mas-k3s-investigation', tool: 'pod_overview',
  subject, evidence_items: [structuredClone(evidence)], context_sha256: hash });
const observed = () => ({ run_id: 'run-a', cancelled: false, observed_at_ms: Date.parse(at), steps: [
  { id: 'tool-effect-a', actor: 'pod_overview', kind: 'effect', key: 'command', state: 'completed', output: { status: 'completed', output: result() } },
] });

test('only recorded tool results form frozen evidence; model prose and admission evidence cannot add observations', () => {
  const audit = freezeInvestigation('run-a', observed(), seed, 'kubernetes-api', hash);
  assert.deepEqual(audit.evidence!.items.map(item => item.id), ['pod']);
  assert.deepEqual(audit.calls, [{ id: 'tool-effect-a', tool: 'pod_overview', status: 'collected', evidenceIds: ['pod'] }]);
  assert.equal(audit.contextSha256, hash);
});

test('unknown effects, cancelled runs, mismatched contexts, tool actors and subjects cannot freeze evidence', () => {
  const mutations = [
    (o: any) => { o.cancelled = true; }, (o: any) => { o.run_id = 'another'; },
    (o: any) => { o.steps[0].state = 'unknown'; }, (o: any) => { o.steps[0].actor = 'foreign'; },
    (o: any) => { o.steps[0].output.output.context_sha256 = 'b'.repeat(64); },
    (o: any) => { o.steps[0].output.output.subject = { ...subject, uid: 'replaced' }; },
    (o: any) => { o.steps[0].output.output.source = 'recorded-evidence'; },
    (o: any) => { o.steps[0].output.output.evidence_items[0].data.metadata = { ...subject, uid: 'foreign' }; },
    (o: any) => { o.steps = []; },
  ];
  for (const change of mutations) { const o = observed(); change(o); assert.throws(() => freezeInvestigation('run-a', o, seed, 'kubernetes-api', hash)); }
});

test('repeated evidence must keep identity and order; the last consistent timed observation is selected', () => {
  const o = observed(), later = structuredClone(o.steps[0]!);
  later.id = 'tool-effect-b';
  later.output.output.evidence_items[0]!.observedAt = '2026-10-17T18:00:01Z';
  o.steps.push(later);
  assert.equal(freezeInvestigation('run-a', o, seed, 'kubernetes-api', hash).evidence!.items[0]!.observedAt, '2026-10-17T18:00:01Z');
  later.output.output.evidence_items[0]!.observedAt = '2026-10-17T17:59:00Z';
  assert.throws(() => freezeInvestigation('run-a', o, seed, 'kubernetes-api', hash), /backwards/);
});

test('retained inputs can be reopened exactly but cannot be rewritten', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-mcp-input-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'context.json');
  const digest = await retainFile(file, { uid: 'pod-a' });
  assert.equal(await retainFile(file, { uid: 'pod-a' }), digest);
  await assert.rejects(retainFile(file, { uid: 'pod-b' }), /changed/);
});

test('a completed investigator without tools is an explicit application failure and cannot start assessment or replay', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-mcp-no-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const path of ['project', 'dist/mcp', 'dist/operator', 'dist/shared']) await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, 'package-lock.json'), '{}');
  const observation = { run_id: 'empty-investigation', cancelled: false, observed_at_ms: Date.parse(at),
    messages: [], steps: [{ actor: 'investigator', key: 'inference-0', kind: 'effect', state: 'completed',
      output: { certainty: 'completed', output_status: 'valid', output: { decision: { kind: 'complete',
        output: { summary: 'untrusted-provider-prose', limitations: ['no history'] } } } } }] };
  assert.throws(() => freezeInvestigation('empty-investigation', observation, seed, 'kubernetes-api', hash), InvestigationEvidenceFailure);
  let acquisitions = 0, assessments = 0;
  const host = { options: { project: join(dir, 'project'), revisionPlan: 'revision.json' },
    runInvestigation: async () => { acquisitions++; return { summary: 'untrusted-provider-prose' }; },
    runAssessed: async () => { assessments++; throw new Error('Assessment must not start'); },
    observe: async () => observation,
  } as unknown as Host;
  const request = { id: 'empty-investigation', scenario: 'pod-incident', approach: 'mcp', evidence: seed,
    event: { involvedObject: { kind: 'Pod', ...subject } } };
  const directory = join(dir, 'runs'), runs = new Runs(directory, 'fixture', host); await runs.initialise();
  await runs.create(request);
  await waitFor(() => runs.get(request.id).status === 'failed');
  const failed = runs.get(request.id);
  assert.equal(failed.diagnostics?.classification, 'investigation-no-tools');
  assert.equal(failed.diagnostics?.automaticRetry, false);
  assert.match(failed.error!, /completed without calling an MCP tool/);
  assert.doesNotMatch(failed.error!, /untrusted-provider-prose|uncertain provider/);
  assert.equal(failed.investigation?.error, failed.error);
  assert.equal(failed.investigation?.evidence, undefined);
  assert.equal(assessments, 0);
  const restarted = new Runs(directory, 'fixture', host); await restarted.initialise();
  assert.deepEqual((await restarted.create(request)).diagnostics, failed.diagnostics);
  assert.equal(acquisitions, 1);
  assert.equal(assessments, 0);
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'state settled within test deadline');
}

test('MCP admission requires a bound namespace and separates approach identity from provider mode', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-mcp-admission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = { observe: async () => ({ messages: [] }), run: async () => ({}) } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host); await runs.initialise();
  await assert.rejects(runs.create({ scenario: 'pod-incident', approach: 'mcp' }), /requires an incident/);
  await runs.create({ id: 'same', scenario: 'pod-incident' });
  await waitFor(() => runs.get('same').status === 'completed');
  await assert.rejects(runs.create({ id: 'same', scenario: 'pod-incident', approach: 'mcp', evidence: seed,
    event: { involvedObject: { kind: 'Pod', ...subject } } }), /different input/);
  await assert.rejects(runs.create({ scenario: 'pod-incident', approach: 'unknown' }), /Unknown investigation/);
});

test('shutdown during acquisition never launches assessment and persists cancellation for restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-mcp-cancel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const path of ['project', 'dist/mcp', 'dist/operator', 'dist/shared']) await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, 'package-lock.json'), '{}');
  let release!: (value: unknown) => void, assessments = 0;
  const cancelled: string[] = [];
  const host = { options: { project: join(dir, 'project'), revisionPlan: 'revision.json' },
    runInvestigation: async () => new Promise(resolve => { release = resolve; }),
    runAssessed: async () => { assessments++; throw new Error('Assessment must not start'); },
    observe: async () => ({ messages: [] }), cancel: async (_id: string, state: string) => { cancelled.push(state); },
  } as unknown as Host;
  const runs = new Runs(join(dir, 'runs'), 'fixture', host); await runs.initialise();
  await runs.create({ id: 'stop', scenario: 'pod-incident', approach: 'mcp', evidence: seed,
    event: { involvedObject: { kind: 'Pod', ...subject } } });
  await waitFor(() => Boolean(release));
  await runs.shutdown(); release({ summary: 'late response' });
  await waitFor(() => runs.get('stop').status === 'failed');
  assert.equal(assessments, 0); assert.equal(cancelled.length, 2);
  assert.equal(JSON.parse(await readFile(join(dir, 'runs/stop/run.json'), 'utf8')).stopRequested, true);
  const restarted = new Runs(join(dir, 'runs'), 'fixture', host); await restarted.initialise();
  assert.equal(restarted.get('stop').status, 'failed'); assert.equal(assessments, 0);
});

test('concurrent snapshots share one acquisition read so late responses cannot rewind its trace', async () => {
  let release!: (value: unknown) => void, reads = 0;
  const host = { options: { project: resolve('project') },
    observe: async () => { reads++; return new Promise(resolve => { release = resolve; }); },
  } as unknown as Host;
  const runs = new Runs('/unused', 'fixture', host);
  runs.records.set('observed', { id: 'observed', status: 'completed', mode: 'fixture', approach: 'mcp',
    startedAt: at, input: { incident: {} }, fingerprint: hash });
  runs.observations.set('observed', { messages: [] });
  const first = runs.snapshot('observed'), second = runs.snapshot('observed');
  assert.equal(reads, 1);
  const observation = { observed_at_ms: 20, messages: [{ id: 'retained-result' }] };
  release(observation);
  for (const snapshot of await Promise.all([first, second])) assert.deepEqual(snapshot.investigationObservation, observation);
  assert.deepEqual((await runs.snapshot('observed')).investigationObservation, observation);
  assert.equal(reads, 1);
});
