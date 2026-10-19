import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIncidentRequirements } from '../evaluation/requirements.js';
import { ambiguousRequirement, unavailableRequirement } from '../evaluation/injectors.js';
import { sha256 } from '../deploy/effects.js';

const base = Object.freeze({ health: 'GET /livez returns 200' });

test('unavailable-dependency admits the external service contract evaluated by the controller', () => {
  const resolved = resolveIncidentRequirements(base, 'unavailable-dependency');
  assert.deepEqual(resolved, { requirements: { ...base, externalTariff: unavailableRequirement }, unresolvedIntent: [] });
  assert.notEqual(sha256(resolved.requirements), sha256(base));
});

test('ambiguous-requirement binds the unresolved requirement to its admission digest', () => {
  const resolved = resolveIncidentRequirements(base, 'ambiguous-requirement');
  assert.deepEqual(resolved, { requirements: { ...base, requestedChange: ambiguousRequirement }, unresolvedIntent: [ambiguousRequirement] });
  assert.notEqual(sha256(resolved.requirements), sha256(base));
});

test('ordinary cases retain the base contract and operational cases retain their supplied contract', () => {
  assert.deepEqual(resolveIncidentRequirements(base, 'missing-route'), { requirements: base, unresolvedIntent: [] });
  const operational = { requirements: { availability: 'GET /ready returns 200' }, unresolvedIntent: ['Owner must specify the latency bound'] };
  for (const caseName of ['unavailable-dependency', 'ambiguous-requirement'] as const) {
    assert.deepEqual(resolveIncidentRequirements(base, caseName, operational), operational);
    assert.deepEqual(resolveIncidentRequirements(base, caseName, {}), { requirements: base, unresolvedIntent: [] });
  }
  assert.deepEqual(base, { health: 'GET /livez returns 200' });
});
