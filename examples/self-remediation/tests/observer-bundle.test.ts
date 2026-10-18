import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Plain JS entry point is intentionally usable without npm in the downloaded ZIP.
// @ts-ignore standalone packaging helper
import { runManifest } from '../scripts/build-observer.mjs';

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
test('packaging mirrors the same condition and case used by live execution', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/self-remediation.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("SELF_REMEDIATION_OBSERVER_LIVE: ${{ github.event_name == 'workflow_dispatch' && inputs.live_provider && github.ref == 'refs/heads/main' }}"));
  assert.ok(workflow.includes("SELF_REMEDIATION_OBSERVER_CASE: ${{ inputs.case || 'missing-route' }}"));
});
