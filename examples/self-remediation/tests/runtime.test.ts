/** Retained-measurement projection controls. No container or provider execution is claimed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../controller/runtime.js';
import { Journal } from '../controller/journal.js';
import { Controller, type Built, type Incident, type LoopPorts, type Source } from '../controller/loop.js';
import type { BuildResult, HTTPCheck } from '../sandbox/executor.js';
import type { Criterion, Synthesis } from '../contracts/types.js';
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

test('actual CI synthesis input fits the host frame budget without changing source, requirements or any criterion outcome',()=>{
  const fixture=retainedBuild('failed');
  try {
    const input=JSON.parse(readFileSync(new URL('./fixtures/phase-input-39115856935.json',import.meta.url),'utf8'));
    assert.equal(Buffer.byteLength(JSON.stringify(input)),10396,'Retained failure payload changed');
    // Exercise the exact projection invoked by Runtime.phase before host admission.
    const output=(fixture.runtime as any).compact(input);
    assert.ok(Buffer.byteLength(JSON.stringify(output))<9900);
    assert.deepEqual(output.source,input.source);assert.deepEqual(output.intendedBehaviour,input.intendedBehaviour);
    assert.deepEqual(output.diagnosis,input.diagnosis);
    assert.deepEqual(fixture.runtime.journal.artefacts.json(output.completeInputRef),input);
    const before=input.measurements[0].criteria,after=output.measurements[0].criteria;
    assert.equal(after.length,before.length);
    for(let index=0;index<before.length;index++){
      const original=before[index],retained=after[index];
      assert.equal(retained.id,original.id);assert.equal(retained.status,original.status);assert.equal(retained.mandatory,original.mandatory);assert.deepEqual(retained.evidence,original.evidence);
      if(original.status==='passed'){
        assert.equal(retained.explanationRetained,true);
        assert.equal(fixture.runtime.journal.artefacts.json<any>(output.completeInputRef).measurements[0].criteria[index].explanation,original.explanation);
      }
      else assert.equal(retained.explanation,original.explanation);
    }
    assert.equal(output.experiment.measurement,input.experiment.measurement);
    assert.equal(output.experiment.result.exitCode,input.experiment.result.exitCode);
  } finally {fixture.close();}
});

test('the failed-candidate control reaches second investigation, synthesis and review within the unchanged frame bound',async t=>{
  const fixture=retainedBuild('failed');
  try {
    // Actual failed CI input supplies source, requirements and baseline measurements.
    // Later check outcomes are explicit orchestration controls, not new executions.
    const input=JSON.parse(readFileSync(new URL('./fixtures/phase-input-39115856935.json',import.meta.url),'utf8'));
    const baseline=input.measurements[0],journal=fixture.runtime.journal;
    const initial:Source={tree:input.sourceTree,files:input.source,ref:input.sourceRef};
    const healthy={...initial.files,'src/server.ts':readFileSync(new URL('../target-app/src/server.ts',import.meta.url),'utf8'),'src/health.ts':readFileSync(new URL('../target-app/src/health.ts',import.meta.url),'utf8')};
    const controls:Criterion[][]=[structuredClone(baseline.criteria),structuredClone(baseline.criteria)];
    for(const [index,criteria] of controls.entries())for(const c of criteria){
      c.evidence=[`sha256:${String(index+1).repeat(64)}`];
      if(c.id==='liveness'||(index===0&&['unknown-route','unsupported-method'].includes(c.id))){
        const actual={status:200,json:{status:'alive'},body:JSON.stringify({status:'alive'})};
        c.explanation=JSON.stringify({...JSON.parse(c.explanation),actual});
        c.status=c.id==='liveness'?'passed':'failed';
      }
    }
    const phases:{id:string;raw:number;projected:number;input:any;output:any}[]=[];
    let edits=0;
    const ports:LoopPorts={
      async phase<T>(kind,id,frozen):Promise<T>{
        const projected=(fixture.runtime as any).compact(frozen);
        const bytes=Buffer.byteLength(JSON.stringify(projected));assert.ok(bytes<=9900,`${id}: ${bytes} bytes`);
        for(const field of ['source','candidate','intendedBehaviour','requirements','limits','identity','diagnosis'])if(field in frozen)assert.deepEqual(projected[field],frozen[field],field);
        if(projected.completeInputRef)assert.deepEqual(journal.artefacts.json(projected.completeInputRef),frozen);
        const compare=(before:any,after:any)=>{
          if(Array.isArray(before)){assert.equal(after.length,before.length);before.forEach((entry,index)=>compare(entry,after[index]));}
          else if(before&&typeof before==='object'){
            if(typeof before.id==='string'&&typeof before.mandatory==='boolean'){
              assert.equal(after.id,before.id);assert.equal(after.status,before.status);assert.equal(after.mandatory,before.mandatory);assert.deepEqual(after.evidence,before.evidence);
              if(before.status!=='passed')assert.equal(after.explanation,before.explanation);
              else assert.ok(after.explanation===before.explanation||after.explanationRetained===true);
            }else for(const key of Object.keys(before))if(key==='criteria')compare(before[key],after[key]);
          }
        };
        for(const field of ['measurements','baseline'])if(field in frozen)compare(frozen[field],projected[field]);
        phases.push({id,raw:Buffer.byteLength(JSON.stringify(frozen)),projected:bytes,input:frozen,output:projected});
        if(kind==='investigation')return structuredClone(input.diagnosis) as T;
        if(kind==='review')return {eligible:true,findings:[],remainingUncertainty:[],risk:'low'} as T;
        const files=frozen.source as Record<string,string>;
        const changes=edits===0?[{path:'src/server.ts',content:files['src/server.ts']!.replace("return send(404, { error: 'route not found' });","return send(200, { status: 'alive' });")}]:Object.entries(healthy).filter(([path,content])=>files[path]!==content).map(([path,content])=>({path,content}));
        return {edits:changes,rationale:'Explicit frame control',changedCapabilities:[],changedResources:[]} as T;
      },
      async build(source){return {source,imageDigest:`sha256:${sha256(source.tree)}`,evidence:`sha256:${'b'.repeat(64)}`,status:'passed'};},
      async check(_build,operation,final){
        if(operation.endsWith('.baseline.check'))return structuredClone(baseline);
        return {...baseline,criteria:final?[{id:'final-control',mandatory:true,status:'passed',evidence:[`sha256:${'f'.repeat(64)}`],explanation:'Explicit fresh final control'}]:controls[edits-1],evidence:`sha256:${String(edits).repeat(64)}`,tests:final?'fresh-final-control':baseline.tests,finalFresh:final};
      },
      async experiment(source){return {...input.experiment,result:{...input.experiment.result,stdout:source.files['src/server.ts']+'\n'}};},
      async edit(source,changes:Synthesis){
        edits++;const files={...source.files};for(const change of changes.edits)if(change.content===null)delete files[change.path];else files[change.path]=change.content;
        return {files,tree:sha256(JSON.stringify(files)),ref:journal.artefacts.put(files)};
      },
      async current(){return {baseCommit:input.baseCommit,targetRevision:'frame-control'};},
      async trial(){return {recovered:true,evidence:'scripted-frame-control',observation:{fixture:true}};},
      async publish(){return {mode:'archive',fixture:true};}
    };
    const incident:Incident={id:journal.incidentId,mode:'fixture',baseCommit:input.baseCommit,targetRevision:'frame-control',source:initial,requirements:input.intendedBehaviour,requirementsHash:sha256(JSON.stringify(input.intendedBehaviour)),testsHash:baseline.tests,environmentHash:baseline.environment,configurationHash:sha256(initial.files['config.json']!),policy:{mode:'archive',repository:'example/disposable',baseRef:'demo/incidents/frame-control',disposable:true,mandatoryCriteria:baseline.criteria.map((c:Criterion)=>c.id),evaluator:'protected-control',allowedCapabilities:[],allowedResources:[]},trigger:{fixture:true},unresolvedIntent:[]};
    assert.equal((await new Controller(journal,ports).run(incident)).outcome,'verified_recovery');
    assert.equal(edits,2);assert.deepEqual(phases.map(x=>x.id.split('.').slice(-2).join('.')),['i0.investigation','i0.synthesis','i1.investigation','i1.synthesis','i1.review']);
    const revised=phases[2]!;assert.deepEqual(revised.input.measurements[0].regressions,['unknown-route','unsupported-method']);
    assert.equal(phases[4]!.input.measurements.length,11);assert.equal(phases[4]!.input.baseline.length,11);
    t.diagnostic(JSON.stringify(phases.map(({id,raw,projected})=>({phase:id.split('.').slice(-2).join('.'),raw,projected}))));
  } finally {fixture.close();}
});

test('evidence projection never silently drops criteria and still rejects an oversized exact source',()=>{
  const fixture=retainedBuild('failed');
  try {
    const input=JSON.parse(readFileSync(new URL('./fixtures/phase-input-39115856935.json',import.meta.url),'utf8'));
    input.source={'src/server.ts':'export {};'};
    input.measurements[0].criteria=Array.from({length:27},(_,index)=>({id:`criterion-${index}`,status:'passed',mandatory:true,evidence:[],explanation:'x'.repeat(400)}));
    const output=(fixture.runtime as any).compact(input);
    assert.equal(output.measurements[0].criteria.length,27);
    input.measurements[0].criteria[0]={id:'counterexample',status:'failed',mandatory:true,evidence:[],explanation:'failure-context-'.repeat(80)};
    const failed=(fixture.runtime as any).compact(input);
    assert.equal(failed.measurements[0].criteria[0].explanation,input.measurements[0].criteria[0].explanation);
    input.source['src/large.ts']='x'.repeat(10000);
    assert.throws(()=>(fixture.runtime as any).compact(input),/still exceeds the frame budget/);
  } finally {fixture.close();}
});
