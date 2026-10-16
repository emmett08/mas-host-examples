import assert from 'node:assert/strict';
import test from 'node:test';
import { executeGuardedOperation, VerificationFailure } from './guarded-operation.mjs';

class VersionConflict extends Error {}

// A deterministic second adapter: versioned key/value compare-and-swap, with
// its backing store and journal surviving reconstruction of the controller.
// This is a test storage double, not a claim of process-durable in-memory data.
function backingState() {
  return { value: { key: 'worker-limit', version: 7, value: 1 }, journal: new Map(), mutations: 0, calls: 0 };
}

function controller(state, { loseEffectAck = false, loseReservationAck = false, verifierUnavailable = false,
  replaceAfterEffect = false, rejectBeforeEffect = false } = {}) {
  return {
    admit(expectedVersion = 7) {
      if (state.value.version !== expectedVersion) throw new Error('Admission evidence is stale');
      return { key: state.value.key, expectedVersion, replacement: 2 };
    },
    async run(admitted, attemptId = 'attempt-1') {
      const result = await executeGuardedOperation({
        operationId: 'restore-worker-limit', attemptId, admitted,
        reserve(reservation) {
          if (state.journal.has(reservation.operationId)) throw new Error('Operation already reserved; reconcile without replay');
          state.journal.set(reservation.operationId, { ...structuredClone(reservation), original: null, observations: [] });
          if (loseReservationAck) throw new Error('Reservation acknowledgement lost');
        },
        execute(input) {
          state.calls++;
          if (rejectBeforeEffect || state.value.key !== input.key || state.value.version !== input.expectedVersion) {
            throw new VersionConflict('Compare-and-swap precondition rejected');
          }
          state.mutations++;
          state.value = { key: input.key, version: input.expectedVersion + 1, value: input.replacement };
          const acknowledgement = structuredClone(state.value);
          if (loseEffectAck) throw new Error('Compare-and-swap acknowledgement lost');
          if (replaceAfterEffect) state.value = { ...state.value, version: state.value.version + 1, value: 9 };
          return acknowledgement;
        },
        verify(acknowledgement) {
          if (verifierUnavailable) throw new Error('Versioned store unavailable');
          if (JSON.stringify(state.value) !== JSON.stringify(acknowledgement)) {
            throw new VerificationFailure('Observed value differs from the acknowledged replacement');
          }
          return { observed: structuredClone(state.value) };
        },
        isDefiniteRejection: error => error instanceof VersionConflict,
      });
      const record = state.journal.get(result.operationId);
      // Retry refusal is not a replacement for an original uncertain outcome.
      if (record && !record.original) record.original = structuredClone(result);
      return result;
    },
    observe() {
      const observation = { value: structuredClone(state.value) };
      state.journal.get('restore-worker-limit').observations.push(observation);
      return observation;
    },
  };
}

test('invalid configuration rejects before reservation or execution', async () => {
  let reservations = 0, executions = 0;
  const valid = { operationId: 'operation', attemptId: 'attempt', admitted: { value: 1 },
    reserve() { reservations++; }, execute() { executions++; }, verify() {} };
  for (const invalid of [{ operationId: '' }, { operationId: 1 }, { attemptId: ' ' }, { attemptId: ' trailing ' },
    { reserve: undefined }, { execute: null }, { verify: false }, { isDefiniteRejection: true }, { admitted: undefined }]) {
    await assert.rejects(executeGuardedOperation({ ...valid, ...invalid }), TypeError);
  }
  await assert.rejects(executeGuardedOperation({ ...valid, admitted: { callback() {} } }));
  assert.equal(reservations, 0);
  assert.equal(executions, 0);
});

test('execution waits for reservation acknowledgement and uses the reserved input snapshot', async () => {
  let acknowledge, beganReservation;
  const started = new Promise(resolve => { beganReservation = resolve; });
  const ack = new Promise(resolve => { acknowledge = resolve; });
  let executed;
  const admitted = { expectedVersion: 7, replacement: 2 };
  const pending = executeGuardedOperation({ operationId: 'operation', attemptId: 'attempt', admitted,
    async reserve(reservation) {
      assert.deepEqual(reservation.admitted, { expectedVersion: 7, replacement: 2 });
      reservation.admitted.replacement = 99;
      beganReservation();
      await ack;
    },
    execute(input) { executed = input; return 'acknowledged'; },
    verify(value) { assert.equal(value, 'acknowledged'); return 'observed'; },
  });
  await started;
  admitted.replacement = 100;
  assert.equal(executed, undefined);
  acknowledge();
  const result = await pending;
  assert.deepEqual(executed, { expectedVersion: 7, replacement: 2 });
  assert.equal(result.effectOutcome, 'applied');
  assert.equal(result.verificationOutcome, 'passed');
});

test('versioned compare-and-swap applies once and retains independent observed evidence', async () => {
  const state = backingState(), adapter = controller(state);
  const result = await adapter.run(adapter.admit());
  assert.equal(result.effectOutcome, 'applied');
  assert.equal(result.verificationOutcome, 'passed');
  assert.deepEqual(result.effectValue, { key: 'worker-limit', version: 8, value: 2 });
  assert.deepEqual(result.verificationValue, { observed: result.effectValue });
  assert.equal(state.calls, 1);
  assert.equal(state.mutations, 1);
});

test('preflight rejection creates no reservation and performs no effect', () => {
  const state = backingState(), adapter = controller(state);
  assert.throws(() => adapter.admit(6), /stale/);
  assert.equal(state.journal.size, 0);
  assert.equal(state.calls, 0);
  assert.equal(state.mutations, 0);
});

test('lost reservation acknowledgement permits no effect or replay', async () => {
  const state = backingState(), adapter = controller(state, { loseReservationAck: true });
  const admitted = adapter.admit();
  const result = await adapter.run(admitted);
  assert.equal(result.effectOutcome, 'not_started');
  assert.equal(result.verificationOutcome, 'not_run');
  assert.match(result.error, /Reservation acknowledgement lost/);
  const resumed = await controller(state).run(admitted);
  assert.match(resumed.error, /already reserved/);
  assert.equal(state.calls, 0);
  assert.equal(state.mutations, 0);
});

test('definite compare-and-swap rejection is separate from uncertain execution', async () => {
  const state = backingState(), adapter = controller(state, { rejectBeforeEffect: true });
  const result = await adapter.run(adapter.admit());
  assert.equal(result.effectOutcome, 'rejected');
  assert.equal(result.verificationOutcome, 'not_run');
  assert.equal(state.calls, 1);
  assert.equal(state.mutations, 0);
  assert.equal(result.effectValue, undefined);
});

test('lost effect acknowledgement remains unknown after controller reconstruction and read-only observation', async () => {
  const state = backingState(), first = controller(state, { loseEffectAck: true });
  const admitted = first.admit();
  const result = await first.run(admitted);
  assert.equal(result.effectOutcome, 'unknown');
  assert.equal(result.verificationOutcome, 'not_run');
  assert.equal(state.mutations, 1);
  const original = structuredClone(state.journal.get('restore-worker-limit').original);
  const resumed = controller(state);
  for (const attemptId of ['attempt-1', 'attempt-2']) {
    const refused = await resumed.run(admitted, attemptId);
    assert.equal(refused.effectOutcome, 'not_started');
    assert.match(refused.error, /already reserved/);
  }
  assert.deepEqual(resumed.observe(), { value: { key: 'worker-limit', version: 8, value: 2 } });
  const record = state.journal.get('restore-worker-limit');
  assert.deepEqual(record.original, original);
  assert.equal(record.original.effectOutcome, 'unknown');
  assert.equal(record.observations.length, 1);
  assert.equal(state.calls, 1);
  assert.equal(state.mutations, 1);
});

test('observed wrong postcondition is failed verification after acknowledged application', async () => {
  const state = backingState(), adapter = controller(state, { replaceAfterEffect: true });
  const result = await adapter.run(adapter.admit());
  assert.equal(result.effectOutcome, 'applied');
  assert.equal(result.verificationOutcome, 'failed');
  assert.match(result.error, /Observed value differs/);
  assert.equal(state.calls, 1);
  assert.equal(state.mutations, 1);
});

test('unavailable verifier is inconclusive after acknowledged application', async () => {
  const state = backingState(), adapter = controller(state, { verifierUnavailable: true });
  const result = await adapter.run(adapter.admit());
  assert.equal(result.effectOutcome, 'applied');
  assert.equal(result.verificationOutcome, 'inconclusive');
  assert.match(result.error, /unavailable/);
  assert.equal(state.calls, 1);
  assert.equal(state.mutations, 1);
});

test('execution errors default to unknown and failed classifiers cannot establish rejection', async () => {
  for (const classifier of [undefined, () => 'yes', () => { throw new Error('Classifier unavailable'); }]) {
    let executions = 0, verifications = 0;
    const result = await executeGuardedOperation({ operationId: 'operation', attemptId: 'attempt', admitted: {},
      reserve() {}, execute() { executions++; throw new Error('Response lost'); },
      verify() { verifications++; }, isDefiniteRejection: classifier,
    });
    assert.equal(result.effectOutcome, 'unknown');
    assert.equal(result.verificationOutcome, 'not_run');
    assert.equal(result.error, 'Response lost');
    assert.equal(executions, 1);
    assert.equal(verifications, 0);
  }
});
