import test from 'node:test';
import assert from 'node:assert/strict';
import { observedDuringRun } from '../mcp/client.js';

test('a completed snapshot cannot count as during-run progress against an earlier working status', () => {
  assert.equal(observedDuringRun({ controller_state: 'outcome_recorded', outcome: 'verified_recovery', events: [{}] }, { state: 'working' }), false);
});

test('during-run evidence requires a nonterminal controller snapshot and a following active gateway observation', () => {
  const view = { controller_state: 'dispatched', outcome: null, events: [{}] };
  assert.equal(observedDuringRun(view, { state: 'working' }), true);
  assert.equal(observedDuringRun(view, { state: 'completed' }), false);
  assert.equal(observedDuringRun(view, { state: 'unknown' }), false);
  assert.equal(observedDuringRun({ ...view, events: [] }, { state: 'working' }), false);
});
