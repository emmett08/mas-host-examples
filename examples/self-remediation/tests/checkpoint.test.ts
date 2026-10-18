import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { Journal } from '../controller/journal.js';
import { createCheckpoint, verifyCheckpoint, restoreCheckpoint } from '../controller/checkpoint.js';
import { uploadCheckpoint } from '../controller/checkpoint-upload.js';

const create = () => new Journal(mkdtempSync(join(tmpdir(), 'mas-checkpoint-')), 'recovery');
test('immutable checkpoint captures WAL-backed budget, pending host phase and CAS while writer remains open', () => {
  const journal = create();
  try {
    const ref = journal.artefacts.put({ retained: 'source and protected evidence' });
    journal.admitPhase('phase-one', { frozen: ref }, { calls: 2 });
    const host = join(journal.directory, 'host'); mkdirSync(host);
    const hostDb = new DatabaseSync(join(host, 'execution.sqlite')); hostDb.exec("PRAGMA journal_mode=WAL; CREATE TABLE receipt(id TEXT); INSERT INTO receipt VALUES ('admitted-invocation')");
    const first = createCheckpoint(journal.directory)!;
    assert.deepEqual(first.manifest.pendingPhases, ['phase-one']);
    assert.ok(first.manifest.files.some(file => file.path === `artefacts/${ref.slice(7)}`));
    assert.ok(first.manifest.files.some(file => file.path === 'host/execution.sqlite'));
    const firstBytes = readFileSync(join(first.directory, 'journal.sqlite'));
    journal.finishPhase('phase-one', 'completed', { result: 'failed' });
    const second = createCheckpoint(journal.directory)!;
    assert.ok(second.manifest.sequence > first.manifest.sequence);
    assert.deepEqual(second.manifest.pendingPhases, []);
    assert.deepEqual(readFileSync(join(first.directory, 'journal.sqlite')), firstBytes);
    assert.equal(verifyCheckpoint(first.directory).manifestSha256, first.manifestSha256);
    const target = join(journal.directory, 'restored'); restoreCheckpoint(first.directory, target);
    const recovered = new DatabaseSync(join(target, 'journal.sqlite'), { readOnly: true });
    assert.equal(JSON.parse(String(recovered.prepare("SELECT used FROM budgets WHERE scope='recovery'").get()!.used)).calls, 2);
    assert.equal(recovered.prepare("SELECT status FROM phases WHERE id='phase-one'").get()!.status, 'running');
    assert.equal(JSON.parse(readFileSync(join(target, 'RUNNER_LOSS_REQUIRES_RECONCILIATION.json'), 'utf8')).status, 'unknown_effect');
    assert.throws(() => restoreCheckpoint(first.directory, target), /absent or empty/);
    recovered.close(); hostDb.close();
  } finally { journal.close(); rmSync(journal.directory, { recursive: true, force: true }); }
});
test('checkpoint verification rejects altered bytes and does not copy unlisted payloads', () => {
  const journal = create();
  try {
    journal.append('measurement', { result: 'failed' });
    const checkpoint = createCheckpoint(journal.directory)!;
    writeFileSync(join(checkpoint.directory, 'unlisted-program'), 'never copied');
    const restored = join(journal.directory, 'restore'); restoreCheckpoint(checkpoint.directory, restored);
    assert.equal(existsSync(join(restored, 'unlisted-program')), false);
    chmodSync(join(checkpoint.directory, 'journal.sqlite'), 0o600);
    writeFileSync(join(checkpoint.directory, 'journal.sqlite'), 'altered');
    assert.throws(() => verifyCheckpoint(checkpoint.directory), /digest changed/);
  } finally { journal.close(); rmSync(journal.directory, { recursive: true, force: true }); }
});
test('checkpoint source projection blocks credential bytes and symlinked stores', () => {
  const journal = create();
  try {
    journal.append('evidence', { accidentallyRetained: 'secret-value-never-uploaded' });
    assert.throws(() => createCheckpoint(journal.directory, { deniedValues: ['secret-value-never-uploaded'] }), /Credential detected/);
    const outside = mkdtempSync(join(tmpdir(), 'outside-checkpoint-'));
    symlinkSync(outside, join(journal.directory, 'host'));
    assert.throws(() => createCheckpoint(journal.directory), /symlink rejected/);
    rmSync(outside, { recursive: true, force: true });
  } finally { journal.close(); rmSync(journal.directory, { recursive: true, force: true }); }
});
test('upload retains the exact artifact identity and never automatically repeats a lost response', async () => {
  const journal = create();
  try {
    journal.append('lifecycle', { status: 'investigating' });
    const checkpoint = createCheckpoint(journal.directory)!;
    let calls = 0;
    const uploader = { async uploadArtifact() { ++calls; throw new Error('transport lost with a secret URL'); } };
    const first = await uploadCheckpoint(journal.directory, checkpoint, 'lost-checkpoint', uploader);
    assert.equal(first.status, 'unknown');
    assert.equal((await uploadCheckpoint(journal.directory, checkpoint, 'lost-checkpoint', uploader)).status, 'unknown');
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(first).includes('secret URL'), false);
    const completed = await uploadCheckpoint(journal.directory, checkpoint, 'acknowledged-checkpoint', { async uploadArtifact(name, files) {
      assert.equal(name, 'acknowledged-checkpoint'); assert.ok(files.some(file => file.endsWith('checkpoint-manifest.json')));
      return { id: 42, digest: 'a'.repeat(64), size: 1024 };
    } });
    assert.equal(completed.artifactId, 42); assert.equal(completed.manifestSha256, checkpoint.manifestSha256);
    assert.equal(completed.status, 'completed');
  } finally { journal.close(); rmSync(journal.directory, { recursive: true, force: true }); }
});
test('restored runner marker blocks the real CLI before any new host or deployment admission', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mas-checkpoint-cli-'));
  const journal = new Journal(directory, 'recovery', { calls: 12, candidates: 3, operations: 160, microUsd: 2_000_000, wallMs: 600_000 });
  try {
    journal.append('lifecycle', { status: 'investigating' });
    const checkpoint = createCheckpoint(directory)!;
    const restored = join(directory, 'restore'); restoreCheckpoint(checkpoint.directory, restored);
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run.ts', '--incident', 'recovery', '--output', restored], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(JSON.parse(readFileSync(join(restored, 'result.json'), 'utf8')).outcome, 'unknown_effect');
    const state = new DatabaseSync(join(restored, 'journal.sqlite'), { readOnly: true });
    assert.equal(state.prepare('SELECT COUNT(*) AS n FROM effects').get()!.n, 0);
    assert.equal(state.prepare('SELECT COUNT(*) AS n FROM phases').get()!.n, 0);
    state.close();
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('interrupted restoration after journal copy preserves the admission block', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mas-checkpoint-interrupt-'));
  const journal = new Journal(directory, 'recovery', { calls: 12, candidates: 3, operations: 160, microUsd: 2_000_000, wallMs: 600_000 });
  try {
    journal.reserveBudget('already-spent', { calls: 2 });
    writeFileSync(join(directory, 'result.json'), '{}');
    const checkpoint = createCheckpoint(directory)!;
    const restored = join(directory, 'partial-restore');
    // Inject a filesystem failure after copying the journal, in a separate
    // process so the fs fault cannot affect another test or production code.
    const injected = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const original = fs.writeFileSync;
      fs.writeFileSync = function(path, ...args) { if (String(path).endsWith('/result.json')) throw new Error('injected restore write failure'); return original(path, ...args); };
      syncBuiltinESMExports();
      const { restoreCheckpoint } = await import('./controller/checkpoint.ts');
      restoreCheckpoint(process.argv[1], process.argv[2]);
    `, checkpoint.directory, restored], { encoding: 'utf8', timeout: 15_000 });
    assert.notEqual(injected.status, 0); assert.match(injected.stderr, /injected restore write failure/);
    assert.ok(existsSync(join(restored, 'journal.sqlite')));
    assert.ok(existsSync(join(restored, 'RUNNER_LOSS_REQUIRES_RECONCILIATION.json')));
    const restarted = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run.ts', '--incident', 'recovery', '--output', restored], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(restarted.error, undefined);
    assert.equal(JSON.parse(readFileSync(join(restored, 'result.json'), 'utf8')).outcome, 'unknown_effect');
    const state = new DatabaseSync(join(restored, 'journal.sqlite'), { readOnly: true });
    assert.equal(state.prepare('SELECT COUNT(*) AS n FROM phases').get()!.n, 0);
    assert.equal(JSON.parse(String(state.prepare("SELECT used FROM budgets WHERE scope='recovery'").get()!.used)).calls, 2);
    state.close();
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('writable checkpoint control directories reject symlink redirection before dispatch', async () => {
  const journal = create(), outside = mkdtempSync(join(tmpdir(), 'checkpoint-write-outside-'));
  try {
    symlinkSync(outside, join(journal.directory, 'durable-checkpoints'));
    assert.throws(() => createCheckpoint(journal.directory), /destination symlink rejected/);
    rmSync(join(journal.directory, 'durable-checkpoints'));
    const checkpoint = createCheckpoint(journal.directory)!;
    symlinkSync(outside, join(journal.directory, 'checkpoint-receipts'));
    let dispatched = false;
    await assert.rejects(uploadCheckpoint(journal.directory, checkpoint, 'bad-destination', { async uploadArtifact() { dispatched = true; return {}; } }), /destination symlink rejected/);
    assert.equal(dispatched, false);
  } finally { journal.close(); rmSync(journal.directory, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
