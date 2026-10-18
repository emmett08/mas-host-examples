import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportImage, loadImage, imageCommand, runImageCommand, type ImageCommandDiagnostic, type ImageExecutor } from '../deploy/image.js';
import { UnknownEffect, type EffectRecord, type EffectStore, type Json } from '../deploy/effects.js';
class Store implements EffectStore {
  records = new Map<string, EffectRecord>();
  get(id: string) { return this.records.get(id); }
  unresolved(target: string) { return [...this.records.values()].filter(value => value.target === target && ['intended', 'unknown'].includes(value.status)); }
  intend(record: EffectRecord) { this.records.set(record.operationId, record); }
  settle(id: string, status: EffectRecord['status'], receipt?: Json) { this.records.set(id, { ...this.records.get(id)!, status, ...(receipt === undefined ? {} : { receipt }) }); }
}
test('image command records a bounded redacted nonzero exit separately from transport termination', async () => {
  const diagnostics: ImageCommandDiagnostic[] = [];
  await assert.rejects(imageCommand(process.execPath, ['-e', "process.stderr.write('export failed token=opaque-secret Bearer opaque-auth '+ 'x'.repeat(6000)); process.exit(7)"], 5000,
    value => diagnostics.push(value)), /trusted image transport failed/);
  assert.equal(diagnostics[0]?.exitCode, 7); assert.equal(diagnostics[0]?.signal, null); assert.equal(diagnostics[0]?.timedOut, false);
  assert.equal(diagnostics[0]?.externalOutcome, 'not-inferred'); assert(diagnostics[0]!.message.length <= 4096);
  assert(!JSON.stringify(diagnostics).includes('opaque-secret')); assert(!JSON.stringify(diagnostics).includes('opaque-auth'));
  await assert.rejects(imageCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 40, value => diagnostics.push(value)), /trusted image transport failed/);
  assert.equal(diagnostics[1]?.exitCode, null); assert.equal(diagnostics[1]?.signal, 'SIGKILL'); assert.equal(diagnostics[1]?.timedOut, true);
});
test('image export failure preserves uncertainty and cannot repeat without an evidenced archive', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mas-image-export-control-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(), diagnostics: ImageCommandDiagnostic[] = [], identity = { operationId: 'incident.export', invocationId: 'host-admitted-export', attemptId: 'process' };
  let saves = 0;
  // Explicit command control; this does not assert Docker availability or image correctness.
  const execute = async (program: string, args: string[], options?: Parameters<typeof runImageCommand>[2]) => {
    assert.equal(program, 'docker'); assert.equal(args[1], 'save'); saves++;
    return runImageCommand(process.execPath, ['-e', "process.stderr.write('save request failed'); process.exit(1)"], { ...options, onDiagnostic: value => diagnostics.push(value) });
  };
  const run = () => exportImage(store, identity, 'sha256:' + 'a'.repeat(64), join(directory, 'candidate-image.json'), { command: imageCommand, stream: execute });
  await assert.rejects(run(), UnknownEffect); assert.equal(store.get(identity.operationId)?.status, 'unknown');
  await assert.rejects(run(), UnknownEffect); assert.equal(saves, 1);
  assert.equal(diagnostics[0]?.exitCode, 1); assert.equal(diagnostics[0]?.message, 'save request failed');
});
test('export verifies real tar streams and load feeds the exact archive without reconstructing a large file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mas-image-tar-control-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'); await mkdir(source);
  const config = JSON.stringify({ architecture: 'amd64', os: 'linux', config: { User: '10001:10001' } });
  const configHash = createHash('sha256').update(config).digest('hex'), configDigest = `sha256:${configHash}`, configName = `${configHash}.json`;
  await writeFile(join(source, configName), config);
  await writeFile(join(source, 'manifest.json'), JSON.stringify([{ Config: configName, RepoTags: [], Layers: ['layer.tar'] }]));
  await writeFile(join(source, 'layer.tar'), Buffer.alloc(9 * 1024 * 1024, 57));
  let saves = 0, loads = 0, loaded: { bytes: number; sha256: string } | undefined;
  // Docker protocol is a labelled control; archive production and extraction use real tar.
  const executor: ImageExecutor = {
    command: async (_program, args) => { assert.deepEqual(args.slice(0, 2), ['image', 'inspect']); return JSON.stringify([{ Id: configDigest }]); },
    stream: async (program, args, options) => {
      if (program === 'tar') return runImageCommand(program, args, options);
      assert.equal(program, 'docker');
      if (args[1] === 'save') {
        saves++; assert.deepEqual(args, ['image', 'save', configDigest]);
        return runImageCommand('tar', ['-cf', '-', '-C', source, 'manifest.json', configName, 'layer.tar'], options);
      }
      assert.deepEqual(args, ['image', 'load']); loads++;
      const result = await runImageCommand(process.execPath, ['-e', "const h=require('crypto').createHash('sha256');let bytes=0;process.stdin.on('data',x=>{bytes+=x.length;h.update(x)});process.stdin.on('end',()=>console.log(JSON.stringify({bytes,sha256:h.digest('hex')})))"], options);
      loaded = JSON.parse(result); return result;
    },
  };
  const store = new Store(), identity = { operationId: 'incident.tar-export', invocationId: 'host-export-control', attemptId: 'process' };
  const archive = await exportImage(store, identity, configDigest, join(directory, 'candidate-image.json'), executor);
  assert.deepEqual(await exportImage(store, identity, configDigest, archive.path, executor), archive); assert.equal(saves, 1);
  await loadImage(store, { ...identity, operationId: 'incident.tar-load', invocationId: 'host-load-control' }, archive, executor);
  assert.equal(loaded?.sha256, archive.sha256); assert(loaded!.bytes > 9 * 1024 * 1024); assert.equal(loads, 1);
  const manifest = JSON.parse(await readFile(archive.path, 'utf8')), chunk = join(archive.path + '.parts', manifest.chunks[0].sha256);
  await chmod(chunk, 0o600); await writeFile(chunk, Buffer.from('tampered'));
  await assert.rejects(loadImage(store, { ...identity, operationId: 'incident.tampered', invocationId: 'host-tampered-control' }, archive, executor), /chunk changed/);
  assert.equal(loads, 1, 'invalid complete archive is rejected before starting a Docker-load consumer');
});
