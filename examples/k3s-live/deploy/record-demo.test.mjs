import assert from 'node:assert/strict';
import test from 'node:test';
import { failureReport, observeCanvasProgress, selectRunForPod, validateCanvasProgress, validateSnapshot } from './record-demo.mjs';

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
