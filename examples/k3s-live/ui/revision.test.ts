import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { canonicalJson, parseRevisionAudit, redactRevisionAudit, verifyRevisionDigests, verifySelectedOutput } from '../shared/revision.mjs';
import { ArchivePlayback, parseArchive } from './archive';

const sha = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const reference = (row: { id: string }) => ({ id: row.id, sha256: sha(row) });
function fixture() {
  const output = { summary: 'Insufficient evidence', requires_human: true };
  const candidate = { schema_version: 1, id: 'candidate-0', output, output_sha256: sha(output), parent: null, feedback: [] };
  const rubric = { schema_version: 1, id: 'rubric-1', criteria: [{ id: 'evidence', measurement: 'deterministic', minimum: 0, maximum: 1 }] };
  const evidence = { schema_version: 1, id: 'evidence-1', content: { collected: false }, content_sha256: sha({ collected: false }) };
  const assessment = { schema_version: 1, id: 'assessment-0', candidate: reference(candidate),
    evaluator: { id: 'checker', kind: 'deterministic', version: '1' }, rubric: reference(rubric), status: 'inconclusive', error: null,
    findings: [{ criterion_id: 'evidence', verdict: 'inconclusive', score: null, explanation: 'No observation', evidence: [reference(evidence)] }] };
  return { version: 'mas-host-revision-audit/1', status: 'exhausted', selected: reference(candidate), candidates: [candidate], assessments: [assessment],
    records: [['candidate', candidate], ['rubric', rubric], ['evidence', evidence], ['assessment', assessment]].map(([kind, record]) => ({
      kind, id: (record as { id: string }).id, sha256: sha(record), readers: ['*'], record })),
    contexts: [{ id: 'invocation-1', actor: 'checker', input: { candidate, feedback: [] }, policy: { source_ids: [] }, readers: ['*'] }] };
}

test('public audit binds every assessment, candidate, criterion and evidence to exact records', async () => {
  const value = fixture();
  await verifyRevisionDigests(parseRevisionAudit(value));
  assert.equal(value.assessments[0]!.status, 'inconclusive');
  const unknown = structuredClone(value);
  unknown.assessments[0]!.candidate.sha256 = 'f'.repeat(64);
  const row = unknown.records.find(item => item.kind === 'assessment')!;
  row.record = unknown.assessments[0]!; row.sha256 = sha(row.record);
  assert.throws(() => parseRevisionAudit(unknown), /exact candidate reference/);
  const changed = structuredClone(value);
  changed.candidates[0]!.output.summary = 'Changed output';
  changed.records.find(item => item.kind === 'candidate')!.record = changed.candidates[0]!;
  await assert.rejects(verifyRevisionDigests(parseRevisionAudit(changed)), /content differs/);
});

test('public audit rejects disclosed private records, evaluator-error passes and changed history', () => {
  const original = parseRevisionAudit(fixture());
  const privateRecord = fixture(); privateRecord.records[0]!.readers = ['reviewer'];
  assert.throws(() => parseRevisionAudit(privateRecord), /private/);
  const privateContext = fixture(); privateContext.contexts[0]!.readers = ['reviewer'];
  assert.throws(() => parseRevisionAudit(privateContext), /private invocation/);
  const error = fixture(); error.assessments[0]!.status = 'error';
  error.records.find(item => item.kind === 'assessment')!.record = error.assessments[0]!;
  assert.throws(() => parseRevisionAudit(error), /cannot become a passing assessment/);
  const changed = fixture(); changed.contexts[0]!.policy.source_ids.push('hidden' as never);
  assert.throws(() => parseRevisionAudit(changed, original), /history changed/);
  const missing = fixture(); missing.contexts = [];
  assert.throws(() => parseRevisionAudit(missing, original), /history changed/);
});

test('canonical encoding follows Unicode scalar key order and refuses numeric precision loss', () => {
  assert.equal(canonicalJson({ '\u{10000}': 1, '\ue000': 2 }), '{"\ue000":2,"\u{10000}":1}');
  assert.throws(() => canonicalJson({ value: 9_007_199_254_740_992 }), /exactly/);
  assert.throws(() => canonicalJson({ value: 0.5 }), /exactly/);
});

test('metadata playback retains the exact selected public output without disclosing feedback or invocation inputs', async () => {
  const full = parseRevisionAudit(fixture());
  const metadata = parseRevisionAudit(redactRevisionAudit(full));
  assert.deepEqual(metadata.candidates, []);
  assert.deepEqual(metadata.assessments, []);
  assert.ok(metadata.records.every(row => row.redacted && row.record === undefined));
  assert.ok(metadata.contexts.every(row => row.redacted && row.input === undefined && row.policy === undefined));
  assert.deepEqual(parseRevisionAudit(full, metadata), full, 'Explicit payload opt-in may reveal the same retained public record');
  await verifySelectedOutput(metadata, full.candidates[0]!.output);
  await assert.rejects(verifySelectedOutput(metadata, { summary: 'Unassessed replacement' }), /selected output digest/);
});

test('playback reveals assessments only when recorded and rejects selection/content changes', () => {
  const audit = fixture();
  const run = { id: 'run-1', mode: 'fixture', status: 'running', startedAt: '2026-10-16T12:00:00Z' };
  const archive = { version: 'mas-demo-archive/1', capturedAt: '2026-10-16T12:00:01Z', runId: run.id,
    topology: { nodes: [{ id: 'client', kind: 'client', label: 'Incident' }], edges: [] },
    snapshots: [
      { run, observation: { messages: [], observed_at_ms: 1000 } },
      { run: { ...run, status: 'failed', revision: audit, output: audit.candidates[0]!.output }, observation: { messages: [], observed_at_ms: 2000 } },
    ] };
  const clock = new ArchivePlayback(parseArchive(archive));
  assert.equal(clock.current().snapshot.run.revision, undefined);
  assert.equal(clock.final().snapshot.run.revision!.assessments[0]!.status, 'inconclusive');
  assert.equal(clock.seek(0).snapshot.run.revision, undefined);
  const changed = structuredClone(archive);
  changed.snapshots[1]!.run.output = { summary: 'Unassessed replacement', requires_human: false };
  assert.throws(() => parseArchive(changed), /selected output differs/);
});
