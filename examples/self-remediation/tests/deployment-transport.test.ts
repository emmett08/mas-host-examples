import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KubectlTransport, type KubernetesCommandDiagnostic } from '../deploy/trial.js';
import { RejectedEffect } from '../deploy/effects.js';

/** A real child-process/file control. It deliberately uses readFile like kubectl,
 * so the former --patch-file=/dev/stdin fails under Node's Linux socket stdin. */
async function executable(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'mas-kubectl-transport-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'kubectl-control.mjs');
  await writeFile(path, `#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';
const file=process.argv.find(arg=>arg.startsWith('--patch-file='))?.slice(13);
if(!file){process.stderr.write('patch file absent');process.exit(1);}
const patch=JSON.parse(fs.readFileSync(file,'utf8'));
const observed={patch,file,fileMode:fs.statSync(file).mode&0o777,directoryMode:fs.statSync(path.dirname(file)).mode&0o777,regular:fs.statSync(file).isFile()};
if(patch[0]?.value==='failure-control'){
  process.stderr.write('request failed at '+file+' token=arbitrary-secret Bearer another-secret '+ 'x'.repeat(6000));process.exit(1);
}
process.stdout.write(JSON.stringify(observed));\n`, { mode: 0o700 });
  return path;
}
test('kubectl patch receives a private regular file and removes it after the child completes', async t => {
  const transport = new KubectlTransport('/unused/kubeconfig', await executable(t));
  const patch = [{ op: 'add', path: '/spec/template/spec/containers/0/env', value: [] }];
  const result = await transport.patch('deployment', 'quote', 'mas-repair-control', patch);
  assert.deepEqual(result.patch, patch); assert.equal(result.regular, true);
  assert.equal(result.fileMode, 0o600); assert.equal(result.directoryMode, 0o700);
  await assert.rejects(access(result.file));
});
test('failed kubectl retains bounded redacted evidence, removes patch file, and stays uncertain', async t => {
  const diagnostics: KubernetesCommandDiagnostic[] = [];
  const transport = new KubectlTransport('/unused/kubeconfig', await executable(t), value => diagnostics.push(value));
  await assert.rejects(transport.patch('deployment', 'quote', 'mas-repair-control', [{ op: 'add', path: '/value', value: 'failure-control' }]),
    error => error instanceof Error && !(error instanceof RejectedEffect) && /acknowledgement unavailable/.test(error.message));
  assert.equal(diagnostics.length, 1); const diagnostic = diagnostics[0]!;
  assert.equal(diagnostic.exitCode, 1); assert.equal(diagnostic.operation, 'patch'); assert.equal(diagnostic.externalOutcome, 'not-inferred');
  assert(diagnostic.message.length <= 4096); assert(!diagnostic.message.includes('arbitrary-secret')); assert(!diagnostic.message.includes('another-secret'));
  const path = diagnostic.message.match(/at (\S+) token=/)?.[1]; assert(path); await assert.rejects(access(path));
});
