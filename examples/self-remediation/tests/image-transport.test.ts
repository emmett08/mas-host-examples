import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportImage, imageCommand, type ImageCommandDiagnostic } from '../deploy/image.js';
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
  const execute = async (program: string, args: string[], timeout?: number) => {
    assert.equal(program, 'docker'); assert.equal(args[1], 'save'); saves++;
    return imageCommand(process.execPath, ['-e', "process.stderr.write('save request failed'); process.exit(1)"], timeout, value => diagnostics.push(value));
  };
  const run = () => exportImage(store, identity, 'sha256:' + 'a'.repeat(64), join(directory, 'candidate.tar'), execute);
  await assert.rejects(run(), UnknownEffect); assert.equal(store.get(identity.operationId)?.status, 'unknown');
  await assert.rejects(run(), UnknownEffect); assert.equal(saves, 1);
  assert.equal(diagnostics[0]?.exitCode, 1); assert.equal(diagnostics[0]?.message, 'save request failed');
});
