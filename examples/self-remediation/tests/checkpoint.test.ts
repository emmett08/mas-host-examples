import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync, chmodSync, statSync, readdirSync, linkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { Journal } from '../controller/journal.js';
import { createCheckpoint, verifyCheckpoint, restoreCheckpoint, checkpointObjectPath } from '../controller/checkpoint.js';
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
    const firstJournalObject = checkpointObjectPath(first.directory, first.manifest.files.find(file => file.path === 'journal.sqlite')!.sha256);
    const firstBytes = readFileSync(firstJournalObject);
    journal.finishPhase('phase-one', 'completed', { result: 'failed' });
    const second = createCheckpoint(journal.directory)!;
    assert.ok(second.manifest.sequence > first.manifest.sequence);
    assert.deepEqual(second.manifest.pendingPhases, []);
    assert.deepEqual(readFileSync(firstJournalObject), firstBytes);
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
    const journalObject = checkpointObjectPath(checkpoint.directory, checkpoint.manifest.files.find(file => file.path === 'journal.sqlite')!.sha256);
    chmodSync(journalObject, 0o600);
    writeFileSync(journalObject, 'altered');
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

test('three phase runtimes share one checkpoint/upload object and restore their executable modes', async () => {
  const journal = create();
  try {
    journal.append('lifecycle', { status: 'investigating' });
    // Small identical executable bytes model the repeated 57 MiB Node runtime
    // observed in real CI. Size accounting must count distinct objects only.
    const runtime = '#!/bin/sh\nprintf checkpoint-runtime-ok\n';
    const modes = [0o755, 0o550, 0o500];
    for (let index = 0; index < modes.length; index++) {
      const phase = join(journal.directory, 'host', `phase-${index}`, '.mas', 'build', 'artifacts'); mkdirSync(phase, { recursive: true });
      const path = join(phase, 'native-runtime'); writeFileSync(path, runtime); chmodSync(path, modes[index]!);
    }
    const checkpoint = createCheckpoint(journal.directory)!;
    assert.equal(checkpoint.manifest.schema, 'self-remediation-checkpoint/2');
    const runtimes = checkpoint.manifest.files.filter(file => file.path.endsWith('/native-runtime'));
    assert.equal(runtimes.length, 3); assert.equal(new Set(runtimes.map(file => file.sha256)).size, 1);
    assert.deepEqual(runtimes.map(file => file.mode), modes);
    const objectSizes = new Map(checkpoint.manifest.files.map(file => [file.sha256, file.bytes]));
    assert.equal(checkpoint.manifest.objectBytes, [...objectSizes.values()].reduce((total, bytes) => total + bytes, 0));
    assert.equal(checkpoint.manifest.files.reduce((total, file) => total + file.bytes, 0) - checkpoint.manifest.objectBytes, 2 * Buffer.byteLength(runtime));
    assert.equal(readdirSync(join(checkpoint.directory, 'objects')).length, objectSizes.size);
    assert.equal(statSync(checkpointObjectPath(checkpoint.directory, runtimes[0]!.sha256)).mode & 0o111, 0);
    await uploadCheckpoint(journal.directory, checkpoint, 'deduplicated-runtime', { async uploadArtifact(_name, files) {
      assert.equal(files.length, objectSizes.size + 2); assert.equal(new Set(files).size, files.length);
      assert.equal(files.filter(path => path === checkpointObjectPath(checkpoint.directory, runtimes[0]!.sha256)).length, 1);
      assert.equal(files.some(path => path.endsWith('native-runtime')), false);
      return { id: 57, digest: 'd'.repeat(64), size: checkpoint.manifest.objectBytes };
    } });
    const restored = join(journal.directory, 'restore-executable'); restoreCheckpoint(checkpoint.directory, restored);
    for (const file of runtimes) {
      const path = join(restored, file.path);
      assert.equal(statSync(path).mode & 0o777, file.mode);
      const executed = spawnSync(path, [], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 5000 });
      assert.equal(executed.status, 0); assert.equal(executed.stdout, 'checkpoint-runtime-ok');
    }
    assert.ok(existsSync(join(restored, 'RUNNER_LOSS_REQUIRES_RECONCILIATION.json')));
  } finally { journal.close(); rmSync(journal.directory, { recursive: true, force: true }); }
});
test('checkpoint rejects special executable permission bits before retaining or restoring objects', () => {
  const journal = create();
  try {
    const host = join(journal.directory, 'host'); mkdirSync(host);
    const executable = join(host, 'runtime'); writeFileSync(executable, '#!/bin/sh\nexit 0\n'); chmodSync(executable, 0o4755);
    assert.throws(() => createCheckpoint(journal.directory), /special permission bits/);
    chmodSync(executable, 0o755);
    const checkpoint = createCheckpoint(journal.directory)!;
    const manifest = structuredClone(checkpoint.manifest); manifest.files.find(file => file.path === 'host/runtime')!.mode = 0o4755;
    const text = JSON.stringify(manifest);
    chmodSync(join(checkpoint.directory, 'checkpoint-manifest.json'), 0o600);
    chmodSync(join(checkpoint.directory, 'checkpoint-manifest.sha256'), 0o600);
    writeFileSync(join(checkpoint.directory, 'checkpoint-manifest.json'), text);
    writeFileSync(join(checkpoint.directory, 'checkpoint-manifest.sha256'), createHash('sha256').update(text).digest('hex'));
    const restored = join(journal.directory, 'invalid-mode-restore');
    assert.throws(() => restoreCheckpoint(checkpoint.directory, restored), /mode or object identity/);
    assert.equal(existsSync(restored), false);
  } finally { journal.close(); rmSync(journal.directory, { recursive: true, force: true }); }
});

test('128 MiB capture bound counts distinct bytes despite larger logical phase copies and rejects excess unique bytes', () => {
  const journal = create();
  try {
    const host = join(journal.directory, 'host'); mkdirSync(host);
    const runtime = join(host, 'phase-1-runtime');
    writeFileSync(runtime, Buffer.alloc(48 * 1024 * 1024, 0x42));
    linkSync(runtime, join(host, 'phase-2-runtime')); linkSync(runtime, join(host, 'phase-3-runtime'));
    const checkpoint = createCheckpoint(journal.directory)!;
    const logicalBytes = checkpoint.manifest.files.reduce((total, file) => total + file.bytes, 0);
    assert.ok(logicalBytes > 128 * 1024 * 1024);
    assert.ok(checkpoint.manifest.objectBytes < 49 * 1024 * 1024);
    assert.equal(verifyCheckpoint(checkpoint.directory).manifest.objectBytes, checkpoint.manifest.objectBytes);
    // Every individual object still fits. Only their distinct aggregate breaches the cap.
    writeFileSync(join(host, 'additional-distinct-object'), Buffer.alloc(81 * 1024 * 1024, 0x43));
    assert.throws(() => createCheckpoint(journal.directory), /distinct object byte bound exceeded/);
    assert.equal(readdirSync(join(journal.directory, 'durable-checkpoints')).filter(name => name.startsWith('.pending-')).length, 0);
  } finally { journal.close(); rmSync(journal.directory, { recursive: true, force: true }); }
});

test('candidate image manifest is retained as an external dependency while payload chunks stay outside checkpoints', () => {
  const journal = create();
  try {
    const bytes = Buffer.from('separately retained immutable image bytes'), sha256 = createHash('sha256').update(bytes).digest('hex');
    const imageManifest = JSON.stringify({ version: 'mas-image-archive/2', sha256, configDigest: `sha256:${'a'.repeat(64)}`, bytes: bytes.length, chunks: [{ sha256, bytes: bytes.length }] });
    writeFileSync(join(journal.directory, 'candidate-image.json'), imageManifest);
    const chunks = join(journal.directory, 'candidate-image.json.parts'); mkdirSync(chunks); writeFileSync(join(chunks, sha256), bytes);
    const checkpoint = createCheckpoint(journal.directory)!;
    assert.ok(checkpoint.manifest.files.some(file => file.path === 'candidate-image.json'));
    assert.equal(checkpoint.manifest.files.some(file => file.path.startsWith('candidate-image.json.parts/')), false);
    const dependency = { kind: 'candidate-image', manifestPath: 'candidate-image.json', manifestSha256: createHash('sha256').update(imageManifest).digest('hex'), chunksPath: 'candidate-image.json.parts', status: 'separate-artifact-required' };
    assert.deepEqual(checkpoint.manifest.externalDependencies, [dependency]);
    const restored = join(journal.directory, 'restore-image-reference'); restoreCheckpoint(checkpoint.directory, restored);
    assert.equal(readFileSync(join(restored, 'candidate-image.json'), 'utf8'), imageManifest);
    assert.equal(existsSync(join(restored, 'candidate-image.json.parts')), false);
    assert.deepEqual(JSON.parse(readFileSync(join(restored, 'RUNNER_LOSS_REQUIRES_RECONCILIATION.json'), 'utf8')).externalDependencies, [dependency]);
    writeFileSync(join(journal.directory, 'candidate-image.json'), 'x'.repeat(64 * 1024 + 1));
    assert.throws(() => createCheckpoint(journal.directory), /object byte bound exceeded/);
  } finally { journal.close(); rmSync(journal.directory, { recursive: true, force: true }); }
});
