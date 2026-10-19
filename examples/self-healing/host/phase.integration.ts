import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
