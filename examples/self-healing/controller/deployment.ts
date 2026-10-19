/** Bind trusted image transfer and Kubernetes operations to admitted host command identities. */
import { mkdirSync } from 'node:fs';
import { writeImmutableFile } from './immutable-file.js';
import { resolve, join } from 'node:path';
import { runTrustedOperation } from '../host/tool.js';
import { HostPhaseError, type HostConfiguration } from '../host/phase.js';
import { Journal, Boundary } from './journal.js';
import { canonical, sha256 } from '../deploy/effects.js';
import type { HttpCriterion, TrialSpec, TargetSnapshot, TrialObservation } from '../deploy/trial.js';
import type { BuildResult, HTTPCheck } from '../sandbox/executor.js';
import type { Built, Source } from './loop.js';
import type { Verification } from '../contracts/types.js';
import type { ImageArchive } from '../deploy/image.js';
import { externalCapabilities } from '../deploy/capabilities.js';
const capability=externalCapabilities.find(c=>c.id==='trial')!;
export function trialCriteria(checks:HTTPCheck[]):HttpCriterion[]{return checks.map(c=>({id:c.id,method:c.method as 'GET'|'POST',path:c.path,expectedStatus:c.status,...(c.json===undefined?{}:{expectedJson:c.json as never}),...(c.body===undefined?{}:{body:c.body as never})}));}
export class Deployment {
  constructor(readonly journal:Journal,readonly host:HostConfiguration,readonly runId:string,readonly checks:HTTPCheck[],readonly runtimeEnvironment:Record<string,string>={}){}
  async operation<T>(id:string,request:Record<string,unknown>):Promise<T>{
    const j=this.journal;
    const input={journalDirectory:resolve(j.directory),incidentId:j.incidentId,operationId:id,attemptId:j.value<string>('attempt')!,...request};
    j.put(`trusted:${id}`,{input});
    const prior=j.admitPhase(id,{kind:'trusted-trial',input},{operations:1});
    if(prior.status==='completed')return prior.result as T;
    return this.dispatch<T>(id,input);
  }
  private async dispatch<T>(id:string,input:Record<string,unknown>):Promise<T>{
    try{
      const requestFile=join(resolve(this.journal.directory),'contexts',`trial-${sha256(id)}.json`);
      mkdirSync(join(resolve(this.journal.directory),'contexts'),{recursive:true});
      writeImmutableFile(requestFile,canonical(input));
      const envelope={operationId:id,requestFile,requestSha256:sha256(input)};
      const out=await runTrustedOperation<{operationId:string;invocation_id:string;status:string;result:T}>(this.host,id,envelope,{
        runtimeBundle:resolve('dist-tools/trial.mjs'),inputSchema:capability.inputSchema,outputSchema:capability.outputSchema,operationName:'trusted_trial/1',timeoutMs:capability.timeoutMs,outputBytes:capability.outputBytes,
        environment:{KUBECONFIG:process.env.KUBECONFIG??''},
      });
      this.journal.finishPhase(id,'completed',out.receipt.result);
      this.journal.append('tool.completed',{operationId:id,invocationId:out.receipt.invocation_id,result:out.receipt.result});
      return out.receipt.result;
    }catch(error){this.journal.finishPhase(id,error instanceof HostPhaseError&&error.uncertain?'unknown':'failed',{message:error instanceof Error?error.message:'trial error'});throw error;}
  }
  async recover():Promise<void>{
    const rows=this.journal.db.prepare("SELECT id FROM phases WHERE status IN ('running','unknown') ORDER BY rowid").all();
    for(const row of rows){const id=String(row.id),stored=this.journal.value<{input:Record<string,unknown>}>(`trusted:${id}`);if(stored)await this.dispatch(id,stored.input);}
  }
  async import(imageConfigDigest:string,operationId:string){
    const result=await this.operation<{imageDigest:string;configDigest:string;manifestDigest:string}>(operationId,{operation:'import',imageConfigDigest,cluster:'self-remediation'});
    if(!result.imageDigest?.includes('@sha256:')||result.configDigest!==imageConfigDigest)throw new Boundary('policy_boundary','Immutable image transfer was not verified');return result;
  }
  spec(source:Source,imageDigest:string,requirements:string,tests:string,environment:string,stage:TrialSpec['stage']):TrialSpec{
    return {namespace:`mas-repair-${sha256(this.runId).slice(0,16)}`,deployment:'parcel-quote',owner:this.journal.incidentId,runId:this.runId,
      imageDigest,candidateTreeSha256:source.tree,requirementsSha256:requirements,testsSha256:tests,environmentSha256:environment,configuration:this.runtimeEnvironment,port:8080,stage};
  }
  recordBuildFailure(source:Source,requirements:string,tests:string,environment:string,evidence:string):string{
    const revision=`unbuilt:${source.tree}`;
    if(this.journal.value('baseline-target'))throw new Boundary('stale_revision_target','A running baseline is already retained');
    this.journal.put('baseline-unbuilt',{revision,sourceTree:source.tree,requirements,tests,environment,evidence});
    if(!this.journal.events().some(event=>event.type==='baseline.build-failed'))this.journal.append('baseline.build-failed',{
      sourceTree:source.tree,targetRevision:revision,evidence,status:'completed-failure',scope:'Source build failure; no baseline Pod or trial recovery is claimed'});
    return revision;
  }
  private initialRevision():string{
    const baseline=this.journal.value<TargetSnapshot>('baseline-target');
    const unbuilt=this.journal.value<{revision:string}>('baseline-unbuilt');
    if(baseline)return baseline.resourceVersion;
    if(unbuilt)return unbuilt.revision;
    throw new Boundary('stale_revision_target','Initial target identity unavailable');
  }
  async baseline(source:Source,built:BuildResult,requirements:string,tests:string,environment:string){
    const retained=this.journal.value<TrialObservation>('baseline-observation');
    if(retained){
      if(retained.binding.candidateTreeSha256!==source.tree||retained.binding.requirementsSha256!==requirements||retained.binding.testsSha256!==tests
        ||retained.binding.environmentSha256!==environment||this.journal.value('baseline-build-image')!==built.imageDigest)throw new Boundary('stale_revision_target','Cached baseline belongs to different source or protected inputs');
      // Never append a cached baseline after an already applied candidate on restart.
      if(!this.journal.events().some(event=>event.type==='trial.target'&&event.data.target))this.journal.append('trial.target',{target:retained.target,spec:retained.binding});
      return retained;
    }
    if(!built.imageDigest)throw new Boundary('unreproduced_failure','Faulty application has no runnable baseline image');
    const imported=await this.import(built.imageDigest,`${this.runId}.baseline.import`);
    const spec=this.spec(source,imported.imageDigest,requirements,tests,environment,'baseline');
    this.journal.acquireTarget(`${spec.namespace}:${spec.deployment}`,source.tree);
    await this.operation<TargetSnapshot>(`${this.runId}.baseline.establish`,{operation:'establish',spec});
    const observed=await this.operation<TrialObservation>(`${this.runId}.baseline.observe`,{operation:'observe',spec,criteria:trialCriteria(this.checks)});
    if(!observed.target)throw new Boundary('unreproduced_failure','Baseline target identity unavailable');
    this.journal.put('baseline-target',observed.target);this.journal.put('baseline-spec',spec);
    this.journal.put('baseline-build-image',built.imageDigest);
    this.journal.put('baseline-observation',observed);
    this.journal.append('trial.target',{target:observed.target,spec});
    this.journal.append('incident.binding',{trigger:'protected HTTP failure',sourceCommit:built.identity.baseCommit,sourceTree:source.tree,
      deployment:observed.target,podUid:observed.podUid??null,imageDigest:spec.imageDigest,configuration:sha256(spec.configuration)});
    return observed;
  }
  async trial(build:Built,report:Verification,expectedTarget:string){
    const j=this.journal;
    if(report.identity.candidateTree!==build.source.tree||report.identity.imageDigest!==build.imageDigest)throw new Boundary('stale_revision_target');
    if(this.initialRevision()!==expectedTarget)throw new Boundary('stale_revision_target');
    const complete=j.value<TrialObservation>(`trial-observation:${build.source.tree}`);
    if(complete){
      if(complete.binding.requirementsSha256!==report.identity.requirements||complete.binding.testsSha256!==report.identity.tests||complete.binding.environmentSha256!==report.identity.environment)throw new Boundary('stale_revision_target','Cached trial belongs to different protected inputs');
      if(complete.status!=='pass')return {recovered:false,evidence:j.artefacts.put(complete),observation:complete};
      // A completed trial is retained evidence, but restart must obtain fresh
      // protected HTTP observations before claiming current deployed recovery.
      await this.current();
      const count=j.events().filter(event=>event.type==='trial.refreshed').length;
      const fresh=await this.operation<TrialObservation>(`${this.runId}.${build.source.tree.slice(0,8)}.fresh-observe${count}`,{operation:'observe',spec:complete.binding,criteria:trialCriteria(this.checks)});
      if(!fresh.target)throw new Boundary('stale_revision_target','Fresh deployment verification target unavailable');
      j.append('trial.target',{target:fresh.target,spec:complete.binding});
      j.append('trial.refreshed',{candidateTree:build.source.tree,status:fresh.status,evidence:j.artefacts.put(fresh)});
      return {recovered:fresh.status==='pass',evidence:j.artefacts.put(fresh),observation:fresh};
    }
    type Admission={spec:TrialSpec;expected?:TargetSnapshot;initialRevision:string};
    let admission=j.value<Admission>(`trial-admission:${build.source.tree}`);
    if(!admission){
      const previous=j.events().filter(e=>e.type==='trial.target'&&e.data.target&&e.data.spec).at(-1)?.data;
      const expected=previous?.target as TargetSnapshot|undefined;
      if(!expected&&!j.value('baseline-unbuilt'))throw new Boundary('stale_revision_target');
      const imported=await this.import(build.imageDigest,`${this.runId}.${build.source.tree.slice(0,8)}.import`);
      const spec=this.spec(build.source,imported.imageDigest,report.identity.requirements,report.identity.tests,report.identity.environment,'candidate');
      if(!expected)j.acquireTarget(`${spec.namespace}:${spec.deployment}`,this.initialRevision());
      admission={spec,...(expected?{expected}:{}),initialRevision:expectedTarget};
      j.put(`trial-admission:${build.source.tree}`,admission);
    }
    if(admission.initialRevision!==expectedTarget||admission.spec.requirementsSha256!==report.identity.requirements||admission.spec.testsSha256!==report.identity.tests||admission.spec.environmentSha256!==report.identity.environment)throw new Boundary('stale_revision_target');
    const {spec,expected}=admission;
    const changedId=`${this.runId}.${build.source.tree.slice(0,8)}.${expected?'replace':'establish'}`;
    const changed=await this.operation<TargetSnapshot>(changedId,{operation:expected?'replace':'establish',spec,...(expected?{expected}:{})});
    if(!changed.uid)throw new Boundary('stale_revision_target','Candidate trial target rejected');
    if(!j.events().some(event=>event.type==='trial.target'&&event.data.operationId===changedId))j.append('trial.target',{target:changed,spec,operationId:changedId});
    const result=await this.operation<TrialObservation>(`${this.runId}.${build.source.tree.slice(0,8)}.observe`,{operation:'observe',spec,criteria:trialCriteria(this.checks)});
    if(!result.target)throw new Boundary('stale_revision_target','Candidate observation target rejected');
    const evidence=j.artefacts.put(result);
    j.append('trial.target',{target:result.target,spec});
    j.put(`trial-observation:${build.source.tree}`,result);
    if(result.status==='pass') {j.put(`trial-spec:${build.source.tree}`,spec);j.put(`trial-result:${build.source.tree}`,result);}
    return {recovered:result.status==='pass',evidence,observation:result};
  }
  async export(build:Built){
    return this.operation<ImageArchive>(`${this.runId}.${build.source.tree.slice(0,8)}.export`,{operation:'export',imageConfigDigest:build.imageDigest,archivePath:join(resolve(this.journal.directory),'candidate-image.json')});
  }
  async current(){
    const previous=this.journal.events().filter(e=>e.type==='trial.target'&&e.data.target&&e.data.spec).at(-1)?.data;
    const expected=previous?.target as TargetSnapshot|undefined,spec=previous?.spec as TrialSpec|undefined;
    if(!expected||!spec){if(this.journal.value('baseline-unbuilt'))return this.initialRevision();throw new Boundary('stale_revision_target','No retained owned target');}
    const count=this.journal.events().filter(e=>e.type==='target.checked').length;
    const actual=await this.operation<TargetSnapshot>(`${this.runId}.current${count}`,{operation:'current',spec});
    this.journal.append('target.checked',{expected,actual});
    if(sha256(actual)!==sha256(expected))throw new Boundary('stale_revision_target','Deployment changed outside the current owned effect');
    return this.initialRevision();
  }
}
