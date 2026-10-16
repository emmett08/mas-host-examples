import assert from 'node:assert/strict';
import test from 'node:test';
import { outcomeLabels, validOutcomeCombination, type ResolutionReport } from '../shared/resolution.js';

test('effect and verification outcomes cannot turn unacknowledged effects into verified recovery', () => {
  const base = { version: 'mas-k8s-resolution/2', operationId: 'operation-1', attemptId: 'attempt-1', status: 'failed' };
  for (const effectOutcome of ['not_started', 'rejected', 'unknown']) {
    assert.equal(validOutcomeCombination({ ...base, effectOutcome, verificationOutcome: 'not_run' }), true);
    for (const verificationOutcome of ['passed', 'failed', 'inconclusive']) {
      assert.equal(validOutcomeCombination({ ...base, effectOutcome, verificationOutcome }), false);
    }
  }
  assert.equal(validOutcomeCombination({ ...base, effectOutcome: 'applied', verificationOutcome: 'passed' }), false);
  assert.equal(validOutcomeCombination({ ...base, status: 'verified', effectOutcome: 'applied', verificationOutcome: 'passed' }), true);
  assert.equal(validOutcomeCombination({ ...base, status: 'not-attempted', effectOutcome: 'unknown', verificationOutcome: 'not_run' }), false);
});

test('legacy failure remains unclassified while new reports display independent outcomes', () => {
  assert.equal(outcomeLabels({ version: 'mas-k8s-resolution/1', status: 'failed' } as ResolutionReport).effect,
    'Not separately recorded (legacy report)');
  assert.deepEqual(outcomeLabels({ version: 'mas-k8s-resolution/2', effectOutcome: 'unknown', verificationOutcome: 'not_run' } as ResolutionReport),
    { effect: 'Unknown — no automatic retry', verification: 'Not run' });
  assert.deepEqual(outcomeLabels({ version: 'mas-k8s-resolution/2', effectOutcome: 'applied', verificationOutcome: 'inconclusive' } as ResolutionReport),
    { effect: 'Application acknowledged', verification: 'Inconclusive' });
});
