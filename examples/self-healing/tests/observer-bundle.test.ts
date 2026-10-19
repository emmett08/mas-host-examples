import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Plain JS entry point is intentionally usable without npm in the downloaded ZIP.
// @ts-ignore standalone packaging helper
import { runManifest } from '../scripts/build-observer.mjs';
// @ts-ignore standalone downloaded launcher
import { validateRun } from '../scripts/start-observer.mjs';

const env = { GITHUB_REPOSITORY: 'emmett08/mas-host-examples', GITHUB_SHA: 'b5ae5929974daf433dbb8e10293ddc7349e60408',
  GITHUB_RUN_ID: '39140657270', GITHUB_RUN_ATTEMPT: '1' };
test('bundle records exact live selection while fixture keeps its own case', () => {
  const manifest = runManifest({ ...env, SELF_REMEDIATION_OBSERVER_LIVE: 'true', SELF_REMEDIATION_OBSERVER_CASE: 'business-logic' });
  assert.equal(manifest.defaultMode, 'live');
  assert.equal(manifest.sha, env.GITHUB_SHA);
  assert.deepEqual(manifest.cases, {
    fixture: { incidentId: '39140657270-1-missing-route', artifactName: 'self-remediation-fixture-39140657270-1' },
    live: { incidentId: '39140657270-1-business-logic', artifactName: 'self-remediation-live-39140657270-1' },
  });
});
test('fixture-only and rerun bundles cannot select an unexecuted live job or prior attempt', () => {
  const manifest = runManifest({ ...env, GITHUB_RUN_ATTEMPT: '2', SELF_REMEDIATION_OBSERVER_CASE: 'business-logic' });
  assert.equal(manifest.defaultMode, 'fixture');
  assert.equal(manifest.cases.live, undefined);
  assert.equal(manifest.cases.fixture.incidentId, '39140657270-2-missing-route');
  assert.equal(manifest.cases.fixture.artifactName, 'self-remediation-fixture-39140657270-2');
});
test('local build has no invented run and partial or unsafe metadata fails packaging', () => {
  assert.equal(runManifest({}), null);
  assert.throws(() => runManifest({ GITHUB_RUN_ID: '1' }), /exact repository/);
  assert.throws(() => runManifest({ ...env, GITHUB_RUN_ATTEMPT: '../1' }), /exact repository/);
  assert.throws(() => runManifest({ ...env, SELF_REMEDIATION_OBSERVER_CASE: 'arbitrary-case' }), /Unknown observer case/);
});
test('shared observer covers the canonical fixture while each selected case has its own bundle', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/self-healing.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("SELF_REMEDIATION_OBSERVER_LIVE: 'false'"));
  const reusable = readFileSync(new URL('../../../.github/workflows/self-healing-case.yml', import.meta.url), 'utf8');
  assert.ok(reusable.includes('SELF_REMEDIATION_MATRIX_CASE: ${{ inputs.case }}'));
});
test('matrix observers resolve only their own case artifact and exact attempt', () => {
  for (const live of [false, true]) {
    const a = runManifest({ ...env, SELF_REMEDIATION_OBSERVER_LIVE: String(live),
      SELF_REMEDIATION_OBSERVER_CASE: 'business-logic', SELF_REMEDIATION_MATRIX_CASE: 'business-logic' });
    const mode = live ? 'live' : 'fixture';
    assert.equal(validateRun(a), a);
    assert.equal(a.cases[mode].incidentId, `${env.GITHUB_RUN_ID}-1-business-logic`);
    assert.equal(a.cases[mode].artifactName, `self-remediation-${mode}-${env.GITHUB_RUN_ID}-1-business-logic`);
    const other = structuredClone(a);
    other.cases[mode].artifactName = `self-remediation-${mode}-${env.GITHUB_RUN_ID}-1-runtime-config`;
    assert.throws(() => validateRun(other), /exact run attempt and case/);
  }
  assert.throws(() => runManifest({ ...env, SELF_REMEDIATION_OBSERVER_CASE: 'business-logic',
    SELF_REMEDIATION_MATRIX_CASE: 'no-defect' }), /differs/);
});
