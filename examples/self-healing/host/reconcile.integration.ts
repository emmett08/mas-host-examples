import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { build } from 'esbuild';
import { runTrustedOperation } from './tool.js';
import { hostCommand } from './phase.js';
import { Journal } from '../controller/journal.js';
import { registryDigest,requireCapability } from '../tools/capabilities.js';
import { materialise,sha256 } from '../tools/projection.js';
import { reconcileNativeReceipt } from '../scripts/reconcile.js';
const sdkRoot=resolve(process.env.MAS_SDK_ROOT??'../../.tools/mas-host'),binary=resolve(process.env.MAS_HOST_BIN??join(sdkRoot,'target/debug/mas-host'));

test('real host recovers the actual completed native broker receipt after its process loses the response',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mas-native-recovery-real-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const incidentId='incident',runId='incident.read',operationId=runId,host={binary,sdkRoot,stateDir:join(directory,'host')};
  const runtimeBundle=join(directory,'lost-broker.mjs');
  // Deliberate trusted control: the real broker commits its receipt, then the
  // wrapper loses stdout and exits nonzero. No candidate execution is involved.
  await build({entryPoints:['tools/command.ts'],outfile:runtimeBundle,bundle:true,platform:'node',target:'node24',format:'esm',banner:{js:"import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); process.stdout.write=()=>true; process.on('beforeExit',()=>{process.exitCode=1;});"}});
  const snapshot=await materialise({'src/app.ts':'export const application=true;\n'},{repository:'control/repository',revision:'a'.repeat(40),paths:['src/'],mode:'blind'},join(directory,'snapshot'));
  await mkdir(join(directory,'contexts'));await mkdir(join(host.stateDir,'tool-contexts'),{recursive:true});
  const contextFile=join(directory,'contexts','read.json'),context={snapshot,registryDigest,journalPath:join(directory,'tool-effects.sqlite'),artefactRoot:join(directory,'tool-artefacts'),runtimeBundle,runtimeDigest:sha256(await readFile(runtimeBundle))};
  const contextBytes=JSON.stringify(context),contextHash=sha256(contextBytes);await writeFile(contextFile,contextBytes);await writeFile(join(host.stateDir,'tool-contexts',runId+'.sha256'),contextHash);
  const input={operationId,path:'src/missing.ts'},capability=requireCapability('source_read'),identity={kind:'tool',capability:'source_read',input,context:contextHash,runtime:context.runtimeDigest};
  const journal=new Journal(directory,incidentId);journal.put(`runtime:dispatch:${runId}`,{kind:'tool',operation:runId,capability:'source_read',input,contextFile,identity});journal.admitPhase(runId,identity,{operations:1});
  await assert.rejects(runTrustedOperation(host,runId,input,{runtimeBundle,inputSchema:capability.inputSchema,outputSchema:capability.outputSchema,operationName:'source_read/1',timeoutMs:60000,outputBytes:12000,arguments:['source_read'],environment:{SELF_REMEDIATION_CONTEXT:contextFile,SELF_REMEDIATION_CONTEXT_SHA256:contextHash}}),(error:any)=>error.uncertain===true);
  journal.finishPhase(runId,'unknown',{transport:'lost'});journal.close();
  const recovered=await reconcileNativeReceipt({directory,incidentId,runId,operationId,host});
  assert.equal(recovered.measurement,'failed');assert.equal(recovered.requestCompleted,true);
  const observation=JSON.parse(await hostCommand(binary,['observe','--state',host.stateDir,'--run',runId,'--include-payloads','true']));
  assert.equal(observation.calls.length,1);assert.equal(observation.steps.find((step:any)=>step.kind==='effect').state,'resolved');
  const replay=await reconcileNativeReceipt({directory,incidentId,runId,operationId,host});assert.equal(replay.proofRef,recovered.proofRef);
});
