import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from '../controller/journal.js';
import { canonical } from '../deploy/effects.js';
import { sha256 } from '../tools/projection.js';
import { registryDigest, requireCapability } from '../tools/capabilities.js';
import { reconcileNativeReceipt, UnresolvedNativeEffect } from '../scripts/reconcile.js';
import { PINNED_HOST } from '../host/phase.js';

test('the self-remediation host identity matches the revision installed by repository setup', async () => {
  const revision = (await readFile(new URL('../../../host-revision.txt', import.meta.url), 'utf8')).trim();
  assert.equal(PINNED_HOST, revision);
});

async function setup(t:any, completed=true) {
  const directory=await mkdtemp(join(tmpdir(),'mas-native-reconcile-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const runId='incident.test',operationId=runId,incidentId='incident',invocation='eff-test-control';
  const host={binary:'/trusted/control-host',sdkRoot:'/trusted/control-sdk',stateDir:join(directory,'host')};
  const hostIdentity={sourceRevision:PINNED_HOST,binarySha256:'a'.repeat(64)};
  const capability=requireCapability('test'), input={operationId}, project=join(host.stateDir,'tool-projects',runId);
  await mkdir(join(project,'.mas/build'),{recursive:true});await mkdir(join(host.stateDir,'tool-contexts'),{recursive:true});
  await mkdir(join(directory,'contexts'));await mkdir(join(directory,'tool-artefacts'));
  const runtime='// Explicit validation test double; no generated code or real executor is invoked.\n', runtimeDigest=sha256(runtime);
  await writeFile(join(project,'broker.mjs'),runtime);await writeFile(join(project,'.mas/build/bundle.json'),JSON.stringify({agents:[{name:'trusted_tool_broker',configuration:{version:'control/1'}}]}));await writeFile(join(project,'input.json'),JSON.stringify(input));
  const context={snapshot:{tree:'b'.repeat(64)},registryDigest,journalPath:join(directory,'tool-effects.sqlite'),artefactRoot:join(directory,'tool-artefacts'),runtimeDigest};
  const contextFile=join(directory,'contexts','native.json'),contextBytes=JSON.stringify(context),contextHash=sha256(contextBytes);
  await writeFile(contextFile,contextBytes);await writeFile(join(host.stateDir,'tool-contexts',runId+'.sha256'),contextHash);
  await writeFile(join(project,'identity.json'),JSON.stringify({host:hostIdentity,operation:'test/1',input,outputSchema:capability.outputSchema,inputSchema:capability.inputSchema,runtime:runtimeDigest}));
  const dispatch={kind:'tool',operation:runId,capability:'test',input,contextFile,identity:{kind:'tool',context:contextHash}};
  const journal=new Journal(directory,incidentId);journal.put(`runtime:dispatch:${runId}`,dispatch);journal.admitPhase(runId,dispatch.identity,{operations:1});journal.finishPhase(runId,'unknown',{transport:'lost'});journal.close();
  const result=JSON.stringify({status:'failed',measurements:[{criterion:'business',status:'failed'}]}),resultRef=`sha256:${sha256(result)}`;
  await writeFile(join(directory,'tool-artefacts',resultRef.slice(7)+'.json'),result);
  const receipt={operationStatus:'COMPLETED',measurement:'failed',operationId,invocation_id:invocation,resultRef,summary:result};
  const db=new DatabaseSync(context.journalPath);db.exec('CREATE TABLE tool_effects(operation_id TEXT PRIMARY KEY,invocation_id TEXT,capability TEXT,input_hash TEXT,state TEXT,receipt TEXT)');
  db.prepare('INSERT INTO tool_effects VALUES(?,?,?,?,?,?)').run(operationId,invocation,'test',sha256(JSON.stringify({capabilityId:'test',input,tree:context.snapshot.tree,registryDigest})),completed?'completed':'dispatched',completed?JSON.stringify(receipt):null);db.close();
  const observation:any={run_id:runId,cancelled:false,run:{deadline:Date.now()/1000+300,expired:false},calls:[{id:invocation,actor:'trusted_tool_broker'}],steps:[{kind:'effect',id:invocation,actor:'trusted_tool_broker',state:'unknown',input:{format:'mas-command/2',configuration_sha256:sha256(canonical({version:'control/1'})),input},output:null}]};
  const calls:string[]=[];
  const port={identity:async()=>hostIdentity,command:async(_binary:string,args:string[])=>{
    calls.push(args[0]!);
    if(args[0]==='observe')return JSON.stringify(observation);
    if(args[0]==='resolve'){observation.steps[0].state='resolved';observation.steps[0].output=JSON.parse(await readFile(args[args.indexOf('--output')+1]!,'utf8'));observation.steps[0].evidence=JSON.parse(await readFile(args[args.indexOf('--evidence')+1]!,'utf8'));return JSON.stringify({resolved:true});}
    if(args[0]==='run')return JSON.stringify({status:'completed',output:receipt});
    throw new Error('Unexpected host operation');
  }};
  return {directory,incidentId,runId,operationId,host,port,calls,receipt,observation};
}

test('known completed failing test receipt retains failure while repairing host transport loss',async t=>{
  const s=await setup(t);const result=await reconcileNativeReceipt(s,s.port);
  assert.equal(result.status,'resolved');assert.equal(result.measurement,'failed');assert.equal(result.requestCompleted,true);
  assert.equal(s.calls.filter(x=>x==='resolve').length,1);
  const j=Journal.open(s.directory,s.incidentId);assert.throws(()=>j.admitPhase('new-investigation',{},{}),/Unknown effect/);
  // Original runtime consumes the preserved receipt before the next phase.
  j.finishPhase(s.runId,'completed',{receipt:s.receipt});j.admitPhase('new-investigation',{counterexample:s.receipt.resultRef},{calls:1});j.close();
  const proof=JSON.parse(await readFile(result.proofPath,'utf8'));assert.equal(proof.operationId,s.operationId);assert.equal(proof.invocation_id,s.receipt.invocation_id);
  assert.equal(result.proofRef,`sha256:${sha256(canonical(proof))}`);
});

test('genuine loss without completed native receipt remains unknown and performs no host resolution',async t=>{
  const s=await setup(t,false);await assert.rejects(reconcileNativeReceipt(s,s.port),UnresolvedNativeEffect);assert.deepEqual(s.calls,[]);
});

test('mismatched operation and changed result bytes are refused before resolution',async t=>{
  const s=await setup(t);await assert.rejects(reconcileNativeReceipt({...s,operationId:'different-operation'},s.port),/exact native broker/);
  await writeFile(join(s.directory,'tool-artefacts',s.receipt.resultRef.slice(7)+'.json'),'{}');
  await assert.rejects(reconcileNativeReceipt(s,s.port),/differs from the completed receipt/);assert.equal(s.calls.includes('resolve'),false);
});

test('already resolved original receipt is idempotent and creates no new execution or budget reservation',async t=>{
  const s=await setup(t);await reconcileNativeReceipt(s,s.port);const j=Journal.open(s.directory,s.incidentId);const budget=j.budget();j.close();
  await reconcileNativeReceipt(s,s.port);assert.equal(s.calls.filter(x=>x==='resolve').length,1);
  const restored=Journal.open(s.directory,s.incidentId);assert.deepEqual(restored.budget(),budget);assert.equal(restored.events().filter(x=>x.type==='effect.reconciled').length,1);restored.close();
});
