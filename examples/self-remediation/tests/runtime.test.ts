/** Retained-measurement projection controls. No container or provider execution is claimed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../controller/runtime.js';
import { Journal } from '../controller/journal.js';
import type { Built } from '../controller/loop.js';
import type { BuildResult, HTTPCheck } from '../sandbox/executor.js';
import { sha256 } from '../tools/projection.js';
const checks:HTTPCheck[]=[{id:'liveness',method:'GET',path:'/livez',status:200},{id:'quotation',method:'POST',path:'/quote',body:{quantity:2},status:200}];
function retainedBuild(status:'failed'|'inconclusive') {
  const directory=mkdtempSync(join(tmpdir(),'mas-runtime-check-')),journal=new Journal(directory,'compile-control');
  const tests=sha256(JSON.stringify(checks)),environment='e'.repeat(64),tree='b'.repeat(64);
  const raw:BuildResult={status,measurements:[{criterion:'build',status,actual:status==='failed'?1:undefined,detail:status==='failed'?'SyntaxError: unexpected end of TypeScript input':'Compiler outcome was not retained'}],identity:{baseCommit:'a'.repeat(40),candidateTree:tree,requirements:'c'.repeat(64),tests,environment},tree,toolchain:'sha256:'+'d'.repeat(64),durationMs:12};
  // Retained fixtures use plain JSON, mirroring receipt parsing at the real broker boundary.
  const evidence=journal.artefacts.put(JSON.parse(JSON.stringify(raw)));
  const build:Built={status,imageDigest:'',source:{tree,files:{'src/server.ts':'export function broken('},ref:'sha256:'+'f'.repeat(64)},evidence};
  const runtime=new Runtime({journal,hostConfiguration:{binary:'/unavailable-host',sdkRoot:'/unavailable-sdk',stateDir:join(directory,'host')},mode:'fixture',builderImage:'sha256:'+'d'.repeat(64),developmentChecks:checks,requirementsHash:raw.identity.requirements,environmentHash:environment,baseCommit:raw.identity.baseCommit,current:()=>({baseCommit:raw.identity.baseCommit,targetRevision:'1'}),runtimeBundle:'/unavailable-broker'});
  return {runtime,build,tests,environment,close:()=>{journal.close();rmSync(directory,{recursive:true,force:true});}};
}
test('known compilation failure remains failed while every required HTTP check is retained as unexecuted and inconclusive',async()=>{
  const fixture=retainedBuild('failed');
  try {
    const result=await fixture.runtime.check(fixture.build,'compile-control.baseline.check',false);
    assert.equal(result.authority,'independent');assert.equal(result.tests,fixture.tests);assert.equal(result.environment,fixture.environment);
    assert.equal(result.criteria.find(c=>c.id==='build')?.status,'failed');
    assert.match(result.criteria.find(c=>c.id==='build')?.explanation??'',/SyntaxError/);
    for(const check of checks){const criterion=result.criteria.find(c=>c.id===check.id);assert.equal(criterion?.status,'inconclusive');assert.equal(criterion?.mandatory,true);assert.match(criterion?.explanation??'',/not executed/);assert.deepEqual(criterion?.evidence,[fixture.build.evidence]);}
    assert.ok(result.criteria.some(c=>c.status==='failed'),'Controller receives the observed failure needed to investigate');
    assert.ok(result.criteria.some(c=>c.mandatory&&c.status!=='passed'),'Trial eligibility stays blocked');
  } finally {fixture.close();}
});
test('an inconclusive compiler outcome cannot be relabelled as an observed build or HTTP failure',async()=>{
  const fixture=retainedBuild('inconclusive');
  try {const result=await fixture.runtime.check(fixture.build,'compile-control.baseline.check',false);assert.ok(result.criteria.every(c=>c.status==='inconclusive'));assert.ok(result.criteria.filter(c=>c.id!=='build').every(c=>c.explanation.includes('inconclusive')));}
  finally {fixture.close();}
});
