import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build as bundle } from 'esbuild';
import { applyEdits, assertRemote, exportSnapshot, materialise, sha256, verifySnapshot, type Projection } from '../tools/projection.js';
import { dispatch, reconcileTool, type ToolContext } from '../tools/broker.js';
import { registryDigest } from '../tools/capabilities.js';
import { DockerSandbox, sandboxConstraints, executionWatchdog, protectedProbeArguments, UnknownExecution } from '../sandbox/executor.js';
import { inject } from '../evaluation/injectors.js';
import { finalChecks, expose } from '../evaluation/harness.js';
const projection: Projection = { repository: 'owner/incident', revision: 'a'.repeat(40), paths: ['src/', 'config.json', 'package.json'], mode: 'blind' };
async function context(): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), 'mas-tools-test-'));
  return { snapshot: await materialise({ 'src/server.ts': 'console.log("incident only")', 'config.json': '{"port":8080}' }, projection), journalPath: join(root,'tools.db'), artefactRoot: join(root,'artefacts'), registryDigest, runtimeBundle: '', runtimeDigest: '' };
}
test('snapshot excludes all Git objects, protected evaluators and benchmark material', async () => {
  const root = await mkdtemp(join(tmpdir(),'mas-source-test-'));
  await mkdir(join(root,'src')); await mkdir(join(root,'.git')); await mkdir(join(root,'evaluation'));
  await writeFile(join(root,'src','server.ts'),'safe'); await writeFile(join(root,'.git','solution'),'secret'); await writeFile(join(root,'evaluation','answer.ts'),'secret');
  const snapshot = await exportSnapshot(root, projection);
  assert.deepEqual(Object.keys(snapshot.files), ['src/server.ts']);
  await symlink('/etc/passwd',join(root,'src','escape.ts'));
  await assert.rejects(exportSnapshot(root,projection), /symbolic/);
});
test('arbitrary permitted new implementations work; path traversal and criteria changes are rejected', async () => {
  const state = await context();
  const edited = await applyEdits(state.snapshot,[{path:'src/new-route.ts',content:'export const value = 2;'}]);
  assert.notEqual(edited.tree,state.snapshot.tree);
  for (const path of ['../evaluation/check.ts','src/../../policy.ts','evaluation/check.ts','.git/objects/x','package.json']) await assert.rejects(applyEdits(state.snapshot,[{path,content:'overwrite'}]));
  await chmod(join(edited.root,'src/new-route.ts'),0o600); await writeFile(join(edited.root,'src/new-route.ts'),'tampered'); await assert.rejects(verifySnapshot(edited), /changed/);
});
test('every remote read binds exact incident revision and rejects search/history and healthy main', () => {
  assert.doesNotThrow(()=>assertRemote(projection,'owner/incident','a'.repeat(40),'src/server.ts','read'));
  for (const revision of ['main','b'.repeat(40)]) assert.throws(()=>assertRemote(projection,'owner/incident',revision,'src/server.ts','read'));
  for (const operation of ['search','history'] as const) assert.throws(()=>assertRemote(projection,'owner/incident','a'.repeat(40),'src/server.ts',operation));
  assert.throws(()=>assertRemote(projection,'other/repo','a'.repeat(40),'src/server.ts','read'));
});
test('known missing file is completed failure with identities, distinct from a lost outcome', async () => {
  const state = await context();
  const result = await dispatch(state,'source_read',{operationId:'op-1',path:'src/missing.ts'},'host-effect-1');
  assert.equal(result.operationStatus,'COMPLETED'); assert.equal(result.measurement,'failed'); assert.equal(result.invocation_id,'host-effect-1');
  const replay = await dispatch(state,'source_read',{operationId:'op-1',path:'src/missing.ts'},'host-effect-1'); assert.deepEqual(replay,result);
  await assert.rejects(dispatch(state,'source_read',{operationId:'op-1',path:'src/missing.ts'},'new-host-effect'),/evade/);
  const db = new DatabaseSync(state.journalPath); db.prepare('INSERT INTO tool_effects VALUES (?,?,?,?,?,NULL)').run('lost','host-lost','source_read','hash','dispatched'); db.close();
  await assert.rejects(dispatch(state,'source_read',{operationId:'new-phase',path:'src/server.ts'},'host-new'),UnknownExecution);
  reconcileTool(state.journalPath,'lost','host-lost',{...result,operationId:'lost',invocation_id:'host-lost'},'Retained result artefact independently found and verified for host-lost');
  const continued=await dispatch(state,'source_read',{operationId:'new-phase',path:'src/server.ts'},'host-new'); assert.equal(continued.measurement,'passed');
});
test('attempted protected-test edit is a completed rejected candidate and cannot change authority', async () => {
  const state=await context();
  const result=await dispatch(state,'source_edit',{operationId:'bypass',edits:[{path:'../evaluation/harness.ts',content:'pass everything'}]},'host-bypass');
  assert.equal(result.operationStatus,'COMPLETED'); assert.equal(result.measurement,'failed'); assert.match(result.summary,/policy_boundary/);
  const next=await dispatch(state,'source_read',{operationId:'after-bypass',path:'src/server.ts'},'host-after'); assert.equal(next.measurement,'passed');
});
test('sandbox policy has no candidate host mount, socket, credentials or network and rejects mutable image tags', () => {
  assert.throws(()=>new DockerSandbox('node:24'),/immutable/);
  assert.ok(sandboxConstraints.includes('--network=none')); assert.ok(sandboxConstraints.includes('--read-only')); assert.ok(sandboxConstraints.includes('--cap-drop=ALL'));
  assert.ok(sandboxConstraints.every(value=>!value.includes('mount')&&!value.includes('volume')&&!value.includes('docker.sock')));
  assert.deepEqual(executionWatchdog,['/usr/bin/timeout','--signal=TERM','--kill-after=2s','45s']);
});
test('protected HTTP checks run in a separate trusted image and share only candidate networking', () => {
  const check={id:'private',method:'POST',path:'/quote',body:{quantity:2},status:200,json:{secret:'held-out-expected'}};
  const argv=protectedProbeArguments('mas-probe-11111111-1111-4111-8111-111111111111','mas-evaluate-22222222-2222-4222-8222-222222222222','sha256:'+'a'.repeat(64),check,'check-op');
  assert.ok(argv.includes('--network=container:mas-evaluate-22222222-2222-4222-8222-222222222222'));
  assert.ok(argv.includes('--read-only'));assert.ok(argv.includes('/usr/bin/timeout'));assert.ok(argv.includes('4s'));
  assert.ok(!argv.some(arg=>arg.startsWith('--pid=')||arg.startsWith('--volume')||arg.startsWith('--mount')));
  assert.ok(!argv.join(' ').includes('held-out-expected'));
  assert.deepEqual(JSON.parse(argv.at(-1)!),{method:'POST',path:'/quote',body:{quantity:2}});
});
test('benchmark injection is separated from exposure-aware fresh final criteria', async () => {
  const healthy = await exportSnapshot(resolve('target-app'),projection);
  const incident = await inject(healthy,'held-out-combination');
  assert.ok(!incident.files['src/health.ts']); assert.ok(incident.files['src/checkout.ts']);
  const one = finalChecks(), two = finalChecks(); assert.notEqual(one.digest,two.digest); assert.equal(expose(one.exposure).kind,'development');
});
test('actual custom MCP stdio discovery and call return the projected incident source', async () => {
  const state = await context(); const root = await mkdtemp(join(tmpdir(),'mas-mcp-test-'));
  const runtimeBundle = join(root,'broker.mjs');
  await bundle({ entryPoints:[resolve('tools/command.ts')],outfile:runtimeBundle,bundle:true,platform:'node',format:'esm',banner:{js:"import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"} });
  state.runtimeBundle=runtimeBundle; state.runtimeDigest=sha256(await readFile(runtimeBundle));
  const bytes=JSON.stringify(state), contextFile=join(root,'context.json'); await writeFile(contextFile,bytes);
  const previous=process.env.SELF_REMEDIATION_CONTEXT, previousHash=process.env.SELF_REMEDIATION_CONTEXT_SHA256;
  process.env.SELF_REMEDIATION_CONTEXT=contextFile;process.env.SELF_REMEDIATION_CONTEXT_SHA256=sha256(bytes);
  try { const result=await dispatch(state,'custom_mcp_read',{operationId:'mcp-1',path:'src/server.ts'},'host-mcp-1'); assert.equal(result.measurement,'passed'); assert.match(result.summary,/incident only/); }
  finally { if(previous===undefined)delete process.env.SELF_REMEDIATION_CONTEXT;else process.env.SELF_REMEDIATION_CONTEXT=previous;if(previousHash===undefined)delete process.env.SELF_REMEDIATION_CONTEXT_SHA256;else process.env.SELF_REMEDIATION_CONTEXT_SHA256=previousHash; }
});
