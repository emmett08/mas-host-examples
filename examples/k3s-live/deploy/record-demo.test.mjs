import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failureReport, observeCanvasProgress, prepareIncident, selectRemediationForRun, selectRunForPod, validateCanvasProgress, validateControllerResolution, validateSnapshot } from './record-demo.mjs';
import { canonicalJson, verifyRevisionDigests, verifySelectedOutput } from '../shared/revision.mjs';

function completed() {
  const routes = [
    ['client', 'coordinator'], ['coordinator', 'platform'], ['coordinator', 'security'],
    ['platform', 'platform_diagnosis'], ['platform', 'security'],
    ['security', 'security_review'], ['security', 'security_review'], ['coordinator', 'decision'],
  ];
  const messages = routes.flatMap(([sender, recipient], index) => [
    { id: `request-${index}`, sequence: index * 2 + 1, sender, recipient, kind: 'request', payload: { input: {} } },
    { id: `result-${index}`, sequence: index * 2 + 2, sender: recipient, recipient: sender,
      kind: 'result', correlation: `request-${index}`, payload: { output: {}, reply_to: `request-${index}` } },
  ]);
  return { run: { id: 'k8s-uid', mode: 'live', status: 'completed', output: {} },
    observationAvailable: true, observation: { payloads_included: true, messages } };
}

test('recording selects this Pod UID and rejects duplicate admitted investigations', () => {
  const old = { spec: { event: { involvedObject: { uid: 'old-pod' } } } };
  const current = { spec: { event: { involvedObject: { uid: 'new-pod' } } } };
  assert.equal(selectRunForPod([old, current], 'new-pod'), current);
  assert.equal(selectRunForPod([old], 'new-pod'), undefined);
  assert.throws(() => selectRunForPod([current, current], 'new-pod'), /More than one/);
});

test('recording requires the actual finished controller journal to match its published recovery', () => {
  const snapshot = completed();
  assert.equal(validateControllerResolution(snapshot, undefined, 'source-uid'), false);
  snapshot.run.resolution = { version: 'mas-k8s-resolution/2', effectOutcome: 'applied', verificationOutcome: 'passed', status: 'verified', reason: 'Ready, HTTP 200 and metrics verified' };
  const journal = { spec: { runId: snapshot.run.id, sourceRunUID: 'source-uid' },
    status: { phase: 'Finished', reportJson: JSON.stringify(snapshot.run.resolution) } };
  assert.equal(selectRemediationForRun([{ spec: { runId: 'old-run' } }, journal], snapshot.run.id), journal);
  assert.throws(() => selectRemediationForRun([journal, journal], snapshot.run.id), /More than one durable/);
  assert.equal(validateControllerResolution(snapshot, journal, 'source-uid'), true);
  assert.throws(() => validateControllerResolution({ run: { ...snapshot.run, resolution: { ...snapshot.run.resolution, effectOutcome: 'unknown' } } }, journal, 'source-uid'), /acknowledged applied/);
  assert.throws(() => validateControllerResolution(snapshot, journal, 'other-source'), /no matching finished/);
  assert.throws(() => validateControllerResolution(snapshot, { ...journal, status: { ...journal.status, phase: 'Applying' } }, 'source-uid'), /no matching finished/);
  assert.throws(() => validateControllerResolution(snapshot, { ...journal, status: { ...journal.status, reportJson: '{}' } }, 'source-uid'), /differs from/);
  snapshot.run.resolution.status = 'failed';
  assert.throws(() => validateControllerResolution(snapshot, journal, 'source-uid'), /Practical recovery was failed/);
});

test('recording requires actual completed observations in the requested provider mode', () => {
  assert.doesNotThrow(() => validateSnapshot(completed(), 'live', 'k8s-uid'));
  assert.throws(() => validateSnapshot(completed(), 'fixture', 'k8s-uid'), /mode/);
  const absent = completed();
  absent.observationAvailable = false;
  assert.throws(() => validateSnapshot(absent, 'live', 'k8s-uid'), /no available observation/);
  const failed = completed();
  failed.run.status = 'failed';
  assert.throws(() => validateSnapshot(failed, 'live', 'k8s-uid'), /did not complete/);
});

test('assessed smoke and recording traces use retained invocation pairs and exact selected assessment identities', async () => {
  const snapshot = completed();
  const sha = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
  const reference = record => ({ id: record.id, sha256: sha(record) });
  const candidate = { schema_version: 1, id: 'candidate-1', output: snapshot.run.output, output_sha256: sha(snapshot.run.output), parent: null, feedback: [] };
  const evidence = { schema_version: 1, id: 'evidence-1', content: { observed: true }, content_sha256: sha({ observed: true }) };
  const rubric = { schema_version: 1, id: 'rubric-1', criteria: [{ id: 'check', measurement: 'deterministic', minimum: 0, maximum: 1 }] };
  const assessment = { schema_version: 1, id: 'assessment-1', candidate: reference(candidate),
    evaluator: { id: 'incident_checks', kind: 'deterministic', version: '1' }, rubric: reference(rubric), status: 'completed', error: null,
    findings: [{ criterion_id: 'check', verdict: 'pass', score: 1, evidence: [reference(evidence)], explanation: 'Fixture check' }] };
  for (let index = 8; index < 13; index++) snapshot.observation.messages.push(
    { id: `request-${index}`, sequence: index * 2 + 1, sender: 'client', recipient: 'incident_checks', kind: 'request', payload: {} },
    { id: `result-${index}`, sequence: index * 2 + 2, sender: 'incident_checks', recipient: 'client', kind: 'result', correlation: `request-${index}`, payload: {} });
  snapshot.run.revision = { version: 'mas-host-revision-audit/1', status: 'completed', selected: reference(candidate),
    candidates: [candidate], assessments: [assessment], records: [['candidate', candidate], ['evidence', evidence], ['rubric', rubric], ['assessment', assessment]].map(([kind, record]) =>
      ({ kind, id: record.id, sha256: sha(record), readers: ['*'], record })),
    contexts: Array.from({ length: 13 }, (_, index) => ({ id: `invocation-${index}`, actor: 'incident_checks', input: {}, policy: {}, readers: ['*'] })) };
  assert.equal(snapshot.observation.messages.length, 26);
  assert.doesNotThrow(() => validateSnapshot(snapshot, 'live', 'k8s-uid'));
  await verifyRevisionDigests(snapshot.run.revision);
  await verifySelectedOutput(snapshot.run.revision, snapshot.run.output);
  const missingPair = structuredClone(snapshot); missingPair.observation.messages.splice(-2);
  assert.throws(() => validateSnapshot(missingPair, 'live', 'k8s-uid'), /pair for every retained invocation/);
  const missingAssessment = structuredClone(snapshot); missingAssessment.run.revision.assessments = [];
  assert.throws(() => validateSnapshot(missingAssessment, 'live', 'k8s-uid'), /assessment of the exact selected candidate/);
  const changed = structuredClone(snapshot); changed.run.output = { altered: true };
  assert.throws(() => validateSnapshot(changed, 'live', 'k8s-uid'), /exact selected candidate/);
});

test('recording rejects metadata-only observations and missing or inherited envelope payloads', () => {
  for (const flag of [false, undefined]) {
    const metadata = completed();
    metadata.observation.payloads_included = flag;
    assert.throws(() => validateSnapshot(metadata, 'live', 'k8s-uid'), /SHOW_PAYLOADS=true/);
  }
  const missing = completed();
  delete missing.observation.messages[0].payload;
  assert.throws(() => validateSnapshot(missing, 'live', 'k8s-uid'), /requires message payloads/);
  Object.setPrototypeOf(missing.observation.messages[0], { payload: { input: {} } });
  assert.throws(() => validateSnapshot(missing, 'live', 'k8s-uid'), /requires message payloads/);
});

test('recording reports the retained safe cause rather than replacing it with a generic completion error', () => {
  const failed = completed();
  failed.run.status = 'failed';
  failed.run.error = 'The provider rejected the structured output schema (HTTP 400, invalid_json_schema).';
  failed.run.diagnostics = { version: 'mas-demo-failure/1', classification: 'invalid-schema', automaticRetry: false,
    effects: [{ actor: 'diagnose', httpStatus: 400, errorCode: 'invalid_json_schema' }] };
  assert.throws(() => validateSnapshot(failed, 'live', 'k8s-uid'), /HTTP 400, invalid_json_schema/);
  const report = failureReport(failed, new Error('The host investigation did not complete'));
  assert.equal(report.classification, 'invalid-schema');
  assert.equal(report.error, failed.run.error);
  assert.deepEqual(report.diagnostics, failed.run.diagnostics);
  assert.equal('observation' in report, false);
  assert.equal('output' in report, false);
  assert.equal(failureReport(undefined, new Error('Capture failed')).error, 'Capture failed');
});

test('recording rejects missing hybrid flow, reordered sequence and duplicate envelope identity', () => {
  const noPeer = completed();
  noPeer.observation.messages[8].sender = 'coordinator';
  noPeer.observation.messages[9].recipient = 'coordinator';
  assert.throws(() => validateSnapshot(noPeer, 'live', 'k8s-uid'), /peer exchange/);
  const reordered = completed();
  reordered.observation.messages[5].sequence = 3;
  assert.throws(() => validateSnapshot(reordered, 'live', 'k8s-uid'), /strictly increasing/);
  const duplicated = completed();
  duplicated.observation.messages[5].id = duplicated.observation.messages[4].id;
  assert.throws(() => validateSnapshot(duplicated, 'live', 'k8s-uid'), /distinct/);
});

test('recording rejects a wrong reply ID, a wrong reply direction and an unbalanced message count', () => {
  const wrongID = completed();
  wrongID.observation.messages[5].correlation = 'another-request';
  assert.throws(() => validateSnapshot(wrongID, 'live', 'k8s-uid'), /correlated to its request ID/);
  const wrongDirection = completed();
  wrongDirection.observation.messages[5].recipient = 'platform';
  assert.throws(() => validateSnapshot(wrongDirection, 'live', 'k8s-uid'), /reverse-routed/);
  const unbalanced = completed();
  unbalanced.observation.messages[5].kind = 'request';
  assert.throws(() => validateSnapshot(unbalanced, 'live', 'k8s-uid'), /eight recorded requests and eight recorded results/);
});

test('canvas capture requires growth on the selected active run before terminal state', () => {
  let progress = {};
  const frame = { selectedRunId: 'k8s-uid', status: 'running', envelopeCount: 3 };
  progress = observeCanvasProgress(progress, frame, 'k8s-uid');
  assert.throws(() => validateCanvasProgress(progress), /did not observe increasing/);
  progress = observeCanvasProgress(progress, { ...frame, envelopeCount: 6 }, 'k8s-uid');
  assert.doesNotThrow(() => validateCanvasProgress(progress));
});

test('fast completion, terminal-only growth and growth on an older run cannot pass live canvas capture', () => {
  const fastCompleted = observeCanvasProgress({}, {
    selectedRunId: 'k8s-uid', status: 'completed', envelopeCount: 16,
  }, 'k8s-uid');
  assert.throws(() => validateCanvasProgress(fastCompleted), /did not observe increasing/);
  const active = observeCanvasProgress({}, {
    selectedRunId: 'k8s-uid', status: 'running', envelopeCount: 3,
  }, 'k8s-uid');
  const terminalGrowth = observeCanvasProgress(active, {
    selectedRunId: 'k8s-uid', status: 'completed', envelopeCount: 16,
  }, 'k8s-uid');
  assert.throws(() => validateCanvasProgress(terminalGrowth), /did not observe increasing/);
  const oldRunGrowth = observeCanvasProgress(active, {
    selectedRunId: 'old-run', status: 'running', envelopeCount: 12,
  }, 'k8s-uid');
  assert.throws(() => validateCanvasProgress(oldRunGrowth), /did not observe increasing/);
});

test('preparation measures the actual faulty Pod before enabling its event trigger without replacing it', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'mas-practical-'));
  const calls = [];
  let manifest;
  const pod = { metadata: { name: 'checkout-pod', uid: 'original-uid', creationTimestamp: new Date(Date.now() - 60_000).toISOString() },
    status: { phase: 'Running' } };
  try {
    const result = await prepareIncident(destination, async args => {
      calls.push(args);
      if (args[0] === 'delete') return '';
      if (args[0] === 'apply') { manifest = JSON.parse(await readFile(args[2], 'utf8')); return ''; }
      if (args[1] === 'pods') return JSON.stringify({ items: [pod] });
      if (args[1] === '--raw') return JSON.stringify({ metadata: { name: pod.metadata.name, namespace: 'mas-demo' }, timestamp: new Date().toISOString(), window: '15s',
        containers: [{ name: 'checkout', usage: { cpu: '1n', memory: '30Mi' } }] });
      if (args[0] === 'logs') return '{"method":"GET","path":"/readyz","status":404}\n{"method":"GET","path":"/healthz","status":200}\n';
      if (args[1] === 'deployment') return JSON.stringify({ metadata: { uid: 'deployment-uid' } });
      if (args[0] === 'label') return '';
      throw new Error(`Unexpected preparation call ${args.join(' ')}`);
    });
    assert.equal(result.pod.metadata.uid, 'original-uid');
    const deployment = manifest.items.find(item => item.kind === 'Deployment');
    assert.equal(deployment.spec.template.metadata.labels['demo.mas.dev/trigger'], 'false');
    assert.equal(deployment.spec.template.spec.containers[0].readinessProbe.httpGet.path, '/readyz');
    assert.ok(calls.findIndex(args => args[0] === 'label') > calls.findIndex(args => args[0] === 'logs'));
    assert.deepEqual(calls.at(-1), ['label', 'pod', 'checkout-pod', 'demo.mas.dev/trigger=true', '--overwrite']);
    assert.equal(calls.filter(args => args[0] === 'patch').length, 0);
  } finally { await rm(destination, { recursive: true, force: true }); }
});
