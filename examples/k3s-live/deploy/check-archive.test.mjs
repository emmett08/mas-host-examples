import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDualCapture } from './check-archive.mjs';

function fixture() {
  const recordedAt = '2026-10-18T08:00:20Z';
  const runs = ['collected', 'mcp'].map(approach => {
    const name = approach === 'mcp' ? 'mas-demo-checkout-mcp' : 'mas-demo-checkout';
    const subject = { namespace: 'mas-demo', name: `${name}-old`, uid: `${approach}-old-pod` };
    const replacement = { namespace: 'mas-demo', name: `${name}-new`, uid: `${approach}-new-pod`, container: 'checkout' };
    const evidence = { version: 'mas-k8s-evidence/1', capturedAt: '2026-10-18T08:00:00Z', subject, items: [] };
    return { id: `${approach}-run`, approach, mode: 'fixture', status: 'completed',
      input: { incident: { evidence } }, ...(approach === 'mcp' ? { investigation: { evidence } } : {}),
      resolution: { version: 'mas-k8s-resolution/2', status: 'verified', effectOutcome: 'applied', verificationOutcome: 'passed',
        operationId: `${approach}-operation`, attemptId: `${approach}-attempt`, action: 'replace_readiness_probe_path',
        target: { namespace: 'mas-demo', name, uid: `${approach}-deployment` }, recordedAt, reason: 'Deterministic verification fixture',
        patch: [], before: { observedAt: '2026-10-18T08:00:00Z' },
        after: { observedAt: recordedAt, pod: { ...replacement, readyTransitionTime: '2026-10-18T08:00:05Z' } },
        checks: ['Post-change logs', 'Post-change events'].map(name => ({ name, passed: true, detail: 'Complete retained observation' })),
        verificationEvidence: { version: 'mas-k8s-post-change-evidence/1', subject: replacement,
          window: { startedAt: '2026-10-18T08:00:05Z', endedAt: recordedAt },
          logs: { status: 'collected', source: 'fixture logs', observedAt: recordedAt, truncated: false,
            records: [{ timestamp: '2026-10-18T08:00:19Z', method: 'GET', path: '/healthz', status: 200 }], omittedLines: 0, unparsedLines: 0 },
          events: { status: 'collected', source: 'fixture events', observedAt: recordedAt, truncated: false, items: [] } },
      } };
  });
  const [collected, mcp] = runs;
  return { snapshots: [{ run: collected }], comparisons: [{ snapshots: [{ run: mcp }] }],
    capture: { version: 'mas-k8s-dual-capture/1', runs: runs.map(run => ({ approach: run.approach,
      workload: run.resolution.target.name, runId: run.id, subject: run.input.incident.evidence.subject,
      target: run.resolution.target, operationId: run.resolution.operationId })) } };
}

test('dual dashboard gate requires independently verified controller outcomes and retained post-change evidence', () => {
  assert.equal(checkDualCapture(fixture()), true);
  for (const mutate of [
    data => { delete data.comparisons[0].snapshots[0].run.resolution; },
    data => { data.comparisons[0].snapshots[0].run.resolution = data.snapshots[0].run.resolution; },
    data => { delete data.comparisons[0].snapshots[0].run.resolution.verificationEvidence; },
    data => { data.comparisons[0].snapshots[0].run.resolution.verificationEvidence.logs.records = []; },
    data => { data.comparisons[0].snapshots[0].run.resolution.status = 'failed'; },
    data => { data.capture.runs[1].runId = 'unrelated'; },
    data => { delete data.capture.runs[1].subject; },
    data => { data.comparisons = []; },
    data => { data.capture.runs[1].subject.uid = data.capture.runs[0].subject.uid; },
    data => {
      data.capture.runs[1].operationId = data.capture.runs[0].operationId;
      data.comparisons[0].snapshots[0].run.resolution.operationId = data.capture.runs[0].operationId;
    },
  ]) {
    const data = fixture(); mutate(data);
    assert.throws(() => checkDualCapture(data), undefined, 'An incomplete, borrowed or contradicted repair must fail the dual-capture gate');
  }
});

test('older same-incident comparison archives do not claim a dual-repair capture', () => {
  const data = fixture(); delete data.capture;
  delete data.comparisons[0].snapshots[0].run.resolution;
  assert.equal(checkDualCapture(data), false);
});

test('one controller attempt identity can independently repair two different operations', () => {
  const data = fixture();
  const collected = data.snapshots[0].run.resolution;
  const mcp = data.comparisons[0].snapshots[0].run.resolution;
  mcp.attemptId = collected.attemptId;
  assert.notEqual(mcp.operationId, collected.operationId);
  assert.equal(checkDualCapture(data), true);
  mcp.attemptId = '';
  assert.throws(() => checkDualCapture(data), undefined, 'Both reports must retain their controller attempt identity');
});
