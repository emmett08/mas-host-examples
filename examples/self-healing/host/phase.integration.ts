import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HostPhaseRunner, HostPhaseError, assertFrameInput } from './phase.js';

const sdkRoot = resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host');
const binary = resolve(process.env.MAS_HOST_BIN ?? join(sdkRoot, 'target/debug/mas-host'));
const experiment = { kind: 'http', rationale: 'Compare required route against the observed failure', predictions: ['An absent handler returns 404'], program: '', requests: [{ path: '/livez', expectedStatus: 200 }] };
const fixture = { hypotheses: [{ id: 'h1', mechanism: 'The required route may not be registered', evidence: ['baseline'], contradictions: [], predictions: ['GET /livez returns 404'], rank: 1 }], experiment, unresolvedIntent: [], disposition: 'investigate' };

test('real pinned host compiles bounded bundle, delegates, journals inference, replays and rejects changed frozen inputs', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'self-remediation-host-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const runner = new HostPhaseRunner({ binary, sdkRoot, stateDir, projectTemplate: resolve('project') });
  const options = { mode: 'fixture' as const, fixtureOutput: fixture, fixturePlanner: experiment };
  const first = await runner.run('investigation', 'investigation-1', { evidence: ['baseline'] }, options);
  assert.deepEqual(first.output, fixture); assert.equal(first.calls, 3);
  assert.ok(first.observation.messages.some((m: any) => m.sender === 'investigator' && m.recipient === 'experiment_planner'));
  assert.ok(first.invocationIds.length === 3);
  const replay = await runner.resume('investigation-1');
  assert.equal(replay.calls, first.calls); assert.deepEqual(replay.invocationIds, first.invocationIds);
  await assert.rejects(runner.run('investigation', 'investigation-1', { evidence: ['changed'] }, options), /different frozen input/);
});

test('failed candidate counterexamples feed a new synthesis identity without changing the frozen earlier phase', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'self-remediation-revision-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const runner = new HostPhaseRunner({ binary, sdkRoot, stateDir, projectTemplate: resolve('project') });
  const bad = { edits: [{ path: 'src/app.ts', content: 'export const bad = true;\n' }], rationale: 'First scripted control proposal', changedCapabilities: [], changedResources: [] };
  const good = { ...bad, edits: [{ path: 'src/app.ts', content: 'export const corrected = true;\n' }], rationale: 'Revised scripted control from independent counterexample' };
  const first = await runner.run('synthesis', 'synthesis-1', { base: 'a'.repeat(40) }, { mode: 'fixture', fixtureOutput: bad });
  const next = await runner.run('synthesis', 'synthesis-2', { base: 'a'.repeat(40), counterexamples: [{ status: 'failed', criterion: 'required-behaviour' }] }, { mode: 'fixture', fixtureOutput: good });
  assert.notEqual(first.identity.input, next.identity.input); assert.notEqual(first.invocationIds[0], next.invocationIds[0]);
  assert.equal(next.output.rationale, good.rationale);
});

test('live phases forbid fixture responses and oversized or inexact frames before dispatch', async () => {
  const runner = new HostPhaseRunner({ binary, sdkRoot, stateDir: '/unused' });
  await assert.rejects(runner.run('synthesis', 'live', {}, { mode: 'live', fixtureOutput: {} }), /forbidden/);
  assert.throws(() => assertFrameInput({ huge: 'x'.repeat(20000) }), /artefact references/);
  assert.throws(() => assertFrameInput({ decimal: 0.5 }), /exact integers/);
});

async function controlledHost(t: any, waitForInitialCancellation: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'self-healing-host-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const delayedHost = join(root, 'delayed-host'), marker = join(root, 'starting'), attempts = join(root, 'cancel-attempts');
  const startupRelease = join(root, 'first-cancel-failed'), providerRelease = join(root, 'provider-release');
  const providerGate = `import os, time\ncontrol_deadline=time.monotonic()+30\nwhile not os.path.exists(${JSON.stringify(providerRelease)}):\n if time.monotonic() >= control_deadline: raise RuntimeError('Controlled provider release timed out')\n time.sleep(0.01)\n`;
  await writeFile(delayedHost, `#!${process.execPath}
const { writeFileSync, appendFileSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout } = require('node:timers/promises');
(async () => {
  if (process.argv[2] === 'build') {
    const provider = join(process.argv[process.argv.indexOf('--project') + 1], 'fixture-provider.py');
    writeFileSync(provider, ${JSON.stringify(providerGate)} + readFileSync(provider, 'utf8'));
  }
  if (process.argv[2] === 'run') {
    writeFileSync(${JSON.stringify(marker)}, 'starting');
    const deadline = Date.now() + 30000;
    while (${waitForInitialCancellation} && !existsSync(${JSON.stringify(startupRelease)})) {
      if (Date.now() >= deadline) throw new Error('Initial cancellation did not reach controlled startup');
      await setTimeout(10);
    }
  }
  if (process.argv[2] === 'cancel') appendFileSync(${JSON.stringify(attempts)}, 'attempt\\n');
  const child = spawn(${JSON.stringify(binary)}, process.argv.slice(2), { stdio: 'inherit' });
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', (code) => {
    if (process.argv[2] === 'cancel') {
      if (code !== 0) writeFileSync(${JSON.stringify(startupRelease)}, 'released');
      else {
        try {
          const confirmed = JSON.parse(execFileSync(${JSON.stringify(binary)}, ['observe', ...process.argv.slice(3), '--include-payloads', 'false'], { encoding: 'utf8', timeout: 10000 }));
          if (confirmed.cancelled === true) writeFileSync(${JSON.stringify(providerRelease)}, 'released');
        } catch { /* The real host metadata may still be initialising. */ }
      }
    }
    process.exitCode = code ?? 1;
  });
})();
`);
  await chmod(delayedHost, 0o700);
  return { root, delayedHost, marker, attempts, providerRelease };
}

test('cancellation during host startup retries against the original run until intent is committed', { timeout: 120000 }, async t => {
  // Release startup only after the first cancellation fails without a journal.
  // The provider cannot finish until a later cancellation has committed.
  const { root, delayedHost, marker, attempts } = await controlledHost(t, true);
  let acknowledgementWithoutCommit = false;
  class InitialisingCancellation extends HostPhaseRunner {
    override async cancel(phaseId: string, stateDir?: string) {
      try { return await super.cancel(phaseId, stateDir); }
      catch (error) {
        if (acknowledgementWithoutCommit) throw error;
        // The pinned host can acknowledge an UPDATE affecting zero rows while
        // its journal exists but metadata is incomplete. Model that receipt
        // deterministically at the real run's controlled startup boundary.
        acknowledgementWithoutCommit = true;
        return { cancelled: true, run_id: phaseId };
      }
    }
  }
  const runner = new InitialisingCancellation({ binary: delayedHost, sdkRoot, stateDir: join(root, 'state'), projectTemplate: resolve('project') });
  const controller = new AbortController();
  let settled = false;
  const outcome = runner.run('synthesis', 'startup-cancel', {}, { mode: 'fixture', signal: controller.signal,
    fixtureOutput: { edits: [], rationale: 'Scripted cancellation control', changedCapabilities: [], changedResources: [] } })
    .then(() => { settled = true; return null; }, error => { settled = true; return error; });
  let starting = false;
  const preparationDeadline = Date.now() + 90000;
  while (!settled && Date.now() < preparationDeadline) {
    try { await access(marker); starting = true; break; } catch { await delay(10); }
  }
  controller.abort();
  const result = await outcome;
  assert.equal(starting, true, `Host did not reach the controlled startup boundary: ${String(result)}`);
  assert.ok(result instanceof HostPhaseError);
  const observed = await runner.observe('startup-cancel');
  assert.equal(observed.run_id, 'startup-cancel');
  assert.equal(observed.cancelled, true);
  assert.equal(acknowledgementWithoutCommit, true, 'Control did not exercise acknowledgement before committed cancellation');
  assert.ok((await readFile(attempts, 'utf8')).trim().split('\n').length >= 2, 'Failed pre-journal delivery was not retried');
});

test('public progress cannot replace completion evidence and its pending callback drains before return', { timeout: 120000 }, async t => {
  const { root, delayedHost, providerRelease } = await controlledHost(t, false);
  const fullRead = Promise.withResolvers<void>(), callbackStarted = Promise.withResolvers<void>();
  let publicReads = 0, callbackFinished = false;
  class InterleavedObservations extends HostPhaseRunner {
    override async observe(phaseId: string, stateDir?: string, payloads = false) {
      if (payloads) {
        const full = await super.observe(phaseId, stateDir, true);
        fullRead.resolve();
        return full;
      }
      if (++publicReads === 1) {
        let progress;
        try { progress = await super.observe(phaseId, stateDir); }
        catch (error) { publicReads = 0; throw error; }
        await writeFile(providerRelease, 'Successful public observation admitted');
        await fullRead.promise;
        return { ...progress, probe: 'periodic-progress' };
      }
      await callbackStarted.promise;
      return super.observe(phaseId, stateDir);
    }
  }
  const runner = new InterleavedObservations({ binary: delayedHost, sdkRoot, stateDir: join(root, 'state'), projectTemplate: resolve('project') });
  const result = await runner.run('synthesis', 'completion-evidence', {}, { mode: 'fixture',
    fixtureOutput: { edits: [], rationale: 'Scripted observation control', changedCapabilities: [], changedResources: [] },
    onObservation: async progress => {
      assert.equal(progress.payloads_included, false, 'Public callback received payload-bearing evidence');
      if (progress.probe === 'periodic-progress') {
        callbackStarted.resolve();
        await delay(100);
        callbackFinished = true;
      }
    },
  });
  assert.equal(result.observation.payloads_included, true);
  assert.equal(result.providerUsage.length, 1);
  assert.equal(callbackFinished, true, 'Phase returned while the journal callback was still pending');
});
