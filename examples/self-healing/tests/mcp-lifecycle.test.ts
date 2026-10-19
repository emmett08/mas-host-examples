/** Exercise first-use publication and retained replay across actual process boundaries. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { admissionDigest, rawDigest, verifyFiles, type Admission } from '../mcp/contract.js';
import { claim, cancelIncident } from '../mcp/incident.js';
import { snapshot } from '../mcp/observation.js';
import { runIncident } from '../mcp/execute.js';
import { bindingKey, dispatchKey } from '../mcp/retained-journal.js';
import { Journal } from '../controller/journal.js';

function fixture(t: TestContext): Admission {
  const root = mkdtempSync(join(tmpdir(), 'healing-mcp-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { version: 'self-healing-mcp/1', profile: 'boundary-control', incidentId: 'incident-1', directory: join(root, 'incident'),
    example: root, repository: join(root, 'unavailable-checkout'), sourceRevision: 'a'.repeat(40), host: 'unused', gatewayState: 'unused', node: process.execPath,
    controller: 'unused', arguments: [], environment: {}, credentialNames: [], files: {}, directories: [],
    limits: { calls: 12, candidates: 3, operations: 160, microUsd: 2_000_000, wallMs: 600000 }, mode: 'fixture', publication: 'archive',
    requirementsDigest: 'b'.repeat(64), policyDigest: 'c'.repeat(64) };
}

// Pause a real Journal at the binding write, after its constructor has committed
// schema and budget rows. No production hook changes the publication sequence.
const childSource = `
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Journal } from ${JSON.stringify(new URL('../controller/journal.ts', import.meta.url).href)};
import { claim } from ${JSON.stringify(new URL('../mcp/incident.ts', import.meta.url).href)};
import { admissionDigest } from ${JSON.stringify(new URL('../mcp/contract.ts', import.meta.url).href)};
const [admissionFile, id, ready, release] = process.argv.slice(1);
const admission = JSON.parse(readFileSync(admissionFile, 'utf8'));
const originalPut = Journal.prototype.put;
Journal.prototype.put = function (key, value) {
  if (key === 'mcp:admission') {
    writeFileSync(ready + '.tmp', JSON.stringify(this.budget())); renameSync(ready + '.tmp', ready);
    const deadline = Date.now() + 15000, sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(release)) {
      if (Date.now() >= deadline) throw new Error('Timed out awaiting binding release');
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  return originalPut.call(this, key, value);
};
const claimed = claim(admission, { requestId: id, invocationId: 'effect-' + id, contractDigest: admissionDigest(admission) });
if (claimed) {
  const journal = new Journal(admission.directory, admission.incidentId, admission.limits);
  try { journal.reserveBudget('original-execution', { calls: 2, microUsd: 10000 }); }
  finally { journal.close(); }
}
process.stdout.write(JSON.stringify({ claimed, id }));
`;

function heldClaim(t: TestContext, admission: Admission, id: string) {
  const file = join(admission.example, `${id}.admission.json`), ready = join(admission.example, `${id}.ready`), release = join(admission.example, `${id}.release`);
  writeFileSync(file, JSON.stringify(admission));
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childSource, file, id, ready, release], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  const done = new Promise<{ claimed: boolean; id: string }>((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0) reject(new Error(`Claim child exited ${code ?? signal}: ${errors}`));
      else { try { accept(JSON.parse(output)); } catch (error) { reject(error); } }
    });
  });
  // Attach rejection handling immediately so an early child failure remains a test failure.
  void done.catch(() => {});
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return {
    done, release: () => writeFileSync(release, ''),
    ready: async () => {
      const deadline = Date.now() + 10000;
      while (!existsSync(ready)) {
        if (child.exitCode !== null || child.signalCode !== null) await done;
        if (Date.now() >= deadline) throw new Error(`Claim child did not reach initial binding: ${errors}`);
        await delay(10);
      }
      return JSON.parse(readFileSync(ready, 'utf8'));
    },
  };
}

test('observers see an absent incident until its initial contract binding is complete', { timeout: 20000 }, async t => {
  const a = fixture(t), first = heldClaim(t, a, 'first');
  await first.ready();
  try {
    assert.equal(existsSync(a.directory), false);
    const before = snapshot(a);
    assert.equal(before.controller_state, 'not_started'); assert.equal(before.budget, null);
    assert.deepEqual(before.events, []); assert.equal(existsSync(a.directory), false);
  } finally { first.release(); }
  assert.equal((await first.done).claimed, true);
  assert.equal(snapshot(a).controller_state, 'dispatched');
});

test('concurrent initial claims retain one dispatch and its original budget', { timeout: 20000 }, async t => {
  const a = fixture(t), first = heldClaim(t, a, 'first'), second = heldClaim(t, a, 'second');
  const prepared = await Promise.all([first.ready(), second.ready()]);
  first.release(); second.release();
  const results = await Promise.all([first.done, second.done]);
  const winners = results.filter(result => result.claimed); assert.equal(winners.length, 1);
  const retained = snapshot(a), dispatch = { requestId: winners[0]!.id, invocationId: `effect-${winners[0]!.id}`, contractDigest: admissionDigest(a) };
  assert.deepEqual(retained.dispatch, dispatch);
  const budget = retained.budget as ReturnType<Journal['budget']>;
  assert.ok(prepared.some(initial => initial.deadline === budget.deadline));
  assert.equal(budget.used.calls, 2); assert.equal(budget.used.microUsd, 10000);
  assert.equal((retained.events as { type: string }[]).filter(event => event.type === 'mcp.dispatched').length, 1);
  assert.equal(claim(a, { ...dispatch, requestId: 'later', invocationId: 'effect-later' }), false);
  assert.deepEqual(snapshot(a).budget, budget);
  assert.equal(readdirSync(a.example).some(name => name.includes('.initialising-')), false);
});

test('incomplete retained directories and unbound journals are preserved without a new budget', t => {
  const a = fixture(t); mkdirSync(a.directory); writeFileSync(join(a.directory, 'retained-evidence.json'), '{"interrupted":true}');
  const dispatch = { requestId: 'first', invocationId: 'effect-first', contractDigest: admissionDigest(a) };
  assert.throws(() => claim(a, dispatch), /incomplete/); assert.throws(() => cancelIncident(a), /incomplete/);
  assert.deepEqual(readdirSync(a.directory), ['retained-evidence.json']);
  assert.equal(readFileSync(join(a.directory, 'retained-evidence.json'), 'utf8'), '{"interrupted":true}');

  const b = fixture(t), existing = new Journal(b.directory, b.incidentId, b.limits);
  existing.reserveBudget('retained-operation', { calls: 3, microUsd: 20000 });
  const budget = existing.budget(); existing.close();
  assert.throws(() => claim(b, { ...dispatch, contractDigest: admissionDigest(b) }), /contract mismatch/);
  const reopened = new Journal(b.directory, b.incidentId, b.limits);
  try {
    assert.deepEqual(reopened.budget(), budget);
    assert.equal(reopened.value(bindingKey), undefined); assert.equal(reopened.value(dispatchKey), undefined);
  } finally { reopened.close(); }
});

test('a replacement request observes the original dispatch after its dependencies change', async t => {
  const a = fixture(t), dependency = join(a.example, 'controller.mjs');
  writeFileSync(dependency, 'original controller'); a.files[dependency] = rawDigest('original controller');
  const dispatch = { requestId: 'original', invocationId: 'effect-original', contractDigest: admissionDigest(a) };
  assert.equal(claim(a, dispatch), true);
  const journal = new Journal(a.directory, a.incidentId, a.limits);
  journal.reserveBudget('retained-operation', { calls: 2, microUsd: 10000 }); journal.close();
  const before = snapshot(a);
  writeFileSync(dependency, 'changed controller'); assert.throws(() => verifyFiles(a), /dependency changed/);
  await runIncident(a, { incident_id: a.incidentId, contract_digest: admissionDigest(a), request_id: 'replacement' }, 'effect-replacement');
  assert.deepEqual(snapshot(a), before);
});
