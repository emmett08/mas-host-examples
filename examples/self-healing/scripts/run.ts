/** Trusted setup composes the general controller; benchmark material stays outside every agent projection. */
import { parseArgs } from 'node:util';
import { readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Journal,Boundary,type JournalEvent } from '../controller/journal.js';
import { watchCancellation } from '../controller/cancellation.js';
import { writeImmutableFile } from '../controller/immutable-file.js';
import { Controller,type Incident } from '../controller/loop.js';
import { Runtime } from '../controller/runtime.js';
import { Deployment,trialCriteria } from '../controller/deployment.js';
import { HostPhaseError } from '../host/phase.js';
import { ExternalReads } from '../controller/external.js';
import { Publication } from '../controller/publication.js';
import type { OperationalBinding } from '../deploy/operational.js';
import { exportSnapshot,materialise,sha256 as rawSha,type Snapshot } from '../tools/projection.js';
import { sha256,UnknownEffect } from '../deploy/effects.js';
import { treeIdentity,type CandidatePublication,type PublicationPolicy } from '../deploy/github.js';
import { freezeIncidentSource,type IncidentGitManifest } from '../deploy/source.js';
import { developmentChecks,type Exposure } from '../evaluation/harness.js';
import { caseNames,inject,type CaseName } from '../evaluation/injectors.js';
import { resolveIncidentRequirements } from '../evaluation/requirements.js';
import type { Budget,Investigation,Review,Synthesis } from '../contracts/types.js';
import type { BuildResult,HTTPCheck } from '../sandbox/executor.js';
import type { TargetSnapshot,TrialSpec } from '../deploy/trial.js';
import type { PublishRequest } from './publish.js';

const {values}=parseArgs({options:{mode:{type:'string',default:'fixture'},case:{type:'string',default:'missing-route'},output:{type:'string',default:'.state/run'},incident:{type:'string'},trial:{type:'string',default:'k3s'},config:{type:'string'},cancel:{type:'boolean',default:false}}});
if(!['fixture','live'].includes(values.mode!))throw new Error('mode must be fixture or live');
const mode=values.mode as 'fixture'|'live',directory=resolve(values.output!),incidentId=values.incident??'local-self-remediation';
if(!/^[a-zA-Z0-9_-]{1,65}$/.test(incidentId))throw new Error('Incident identifier must contain 1..65 letters, digits, underscore or hyphen');
const bounded=(name:string,fallback:number,ceiling:number)=>{const value=Number(process.env[name]??fallback);if(!Number.isFinite(value)||value<=0||value>ceiling)throw new Error(`${name} outside admitted boundary`);return value;};
const limits:Budget={calls:bounded('SELF_REMEDIATION_MAX_CALLS',12,96),candidates:bounded('SELF_REMEDIATION_MAX_CANDIDATES',3,8),operations:160,
  microUsd:Math.floor(bounded('SELF_REMEDIATION_MAX_USD',2,10)*1_000_000),wallMs:Math.floor(bounded('SELF_REMEDIATION_MAX_SECONDS',600,1800)*1000)};
const journal=new Journal(directory,incidentId,limits);
if(values.cancel){journal.cancel('operator cancellation');journal.checkpoint();journal.close();process.exit(0);}
const cancellation=new AbortController();
const cancel=()=>{journal.cancel('process termination requested');cancellation.abort();};
process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
// Another trusted process can commit cancellation while an inference phase is active.
const stopWatchingCancellation=watchCancellation(journal,cancellation);
const repositoryRoot=resolve('../..'),prefix='examples/self-healing/target-app';
const git=(args:string[])=>{const result=spawnSync('git',['-C',repositoryRoot,...args],{encoding:'utf8',timeout:30000});if(result.status!==0)throw new Error('Trusted source identity unavailable');return result.stdout.trim();};
const host={binary:process.env.MAS_HOST_BIN??resolve('../../.tools/mas-host/target/debug/mas-host'),sdkRoot:process.env.MAS_SDK_ROOT??resolve('../../.tools/mas-host'),stateDir:join(directory,'host'),projectTemplate:resolve('project')};
const runId=incidentId.toLowerCase().replace(/_/g,'-').slice(0,45);
let runtime:Runtime|undefined, deployment:Deployment|undefined;
let result:Record<string,unknown>={outcome:'policy_boundary',reason:'setup did not complete'};
try{
  if(journal.isCancelled())throw new Boundary('cancelled');
  if(existsSync(join(directory,'RUNNER_LOSS_REQUIRES_RECONCILIATION.json')))
    throw new Boundary('unknown_effect','Restored runner checkpoint requires reconciliation of original host paths, images, cluster and surviving external effects before dispatch');
  journal.put('attempt',journal.value('attempt')??randomUUID());
  if(values.trial!=='k3s')throw new Boundary('policy_boundary','Complete acceptance requires the isolated k3s trial adapter');
  if(!/^sha256:[a-f0-9]{64}$/.test(process.env.MAS_SANDBOX_IMAGE??''))throw new Boundary('policy_boundary','MAS_SANDBOX_IMAGE must identify the immutable trusted builder; Docker execution is required');
  if(mode==='live'&&!process.env.OPENAI_API_KEY)throw new Boundary('policy_boundary','Live provider credential unavailable');
  const configured=values.config?JSON.parse(readFileSync(resolve(values.config),'utf8')):undefined;
  const name=values.case as CaseName;
  if(!configured&&!caseNames.includes(name))throw new Error('Unknown protected benchmark case');
  const mainCommit=git(['rev-parse','HEAD']);
  const repository=configured?.repository??process.env.GITHUB_REPOSITORY??'emmett08/mas-host-examples';
  const healthy=await exportSnapshot(configured?.sourceDirectory??resolve('target-app'),{
    repository,revision:configured?.baseCommit??mainCommit,paths:['src/','config.json','package.json'],mode:configured?'operational':'blind',
  });
  let faulty:Snapshot=healthy,incidentGit:IncidentGitManifest|undefined;
  const {requirements,unresolvedIntent}=resolveIncidentRequirements(JSON.parse(readFileSync(resolve('evaluation/requirements.json'),'utf8')),name,configured);
  const checks:HTTPCheck[]=configured?.checks??developmentChecks;
  if(configured){
    if(!/^[a-f0-9]{40}$/.test(configured.baseCommit??'')||!configured.requirements||!Array.isArray(configured.checks)||!configured.checks.length)throw new Boundary('missing_requirements','Operational mode needs exact baseCommit, requirements and protected checks');
    // Read only admitted files at the exact deployment source, never repository-wide search/history.
    for(const [path,text] of Object.entries(healthy.files)){
      const source=spawnSync('git',['-C',resolve(configured.repositoryDirectory??repositoryRoot),'show',`${configured.baseCommit}:${configured.pathPrefix}/${path}`],{encoding:'utf8',timeout:10000});
      if(source.status!==0||source.stdout!==text)throw new Boundary('stale_revision_target','Operational snapshot differs from the admitted source commit');
    }
  }else{
    const retained=journal.value<{files:Record<string,string>;manifest:IncidentGitManifest}>('benchmark-source');
    if(retained){faulty=await materialise(retained.files,healthy.projection);incidentGit=retained.manifest;}
    else{faulty=await inject(healthy,name);incidentGit=await freezeIncidentSource(repositoryRoot,mainCommit,faulty.root,prefix,join(directory,'trusted-incident-git'));
      journal.put('benchmark-source',{files:faulty.files,manifest:incidentGit});}
    faulty=await materialise(faulty.files,{...faulty.projection,revision:incidentGit.faultyCommit});
  }
  const baseCommit=configured?.baseCommit??incidentGit!.faultyCommit,requirementsHash=sha256(requirements),testsHash=rawSha(JSON.stringify(checks));
  const environmentHash=sha256({builder:process.env.MAS_SANDBOX_IMAGE,node:process.versions.node,network:'none',user:10001,memoryBytes:268435456,pids:64,protectedChecks:testsHash});
  const external=new ExternalReads(journal,host),publisher=new Publication(journal,host);
  await publisher.recover();
  await external.recover();
  let operationalBinding:OperationalBinding|undefined=journal.value('operational-baseline');
  if(configured){
    if(!configured.operationalTarget||configured.operationalTarget.sourceCommit!==baseCommit)
      throw new Boundary('missing_requirements','Operational mode requires the exact deployed Pod/release/source grant');
    if(Object.keys(configured.operationalTarget.runtimeEnvironment??{}).length)
      throw new Boundary('policy_boundary','This matched sandbox supports configuration in config.json; operational environment overrides require an explicit matched adapter');
  }
  const recheckOperational=async()=>{
    if(!configured)return;
    const count=journal.events().filter(e=>e.type==='operational.binding').length;
    await external.operational(`${incidentId}.operational.current${count}`,configured.operationalTarget,operationalBinding);
  };
  deployment=new Deployment(journal,host,runId,checks);
  // Fixture source remains in this trusted setup closure. Live phases cannot select it.
  let fixture:((kind:any,input:Record<string,unknown>,id:string)=>{fixtureOutput:unknown;fixturePlanner?:unknown})|undefined;
  if(mode==='fixture'){
    const {failingControl,referenceControl,bypassControl}=await import('../evaluation/control-fixtures.js');
    fixture=(kind,input,id)=>{
      const iteration=Number(/\.i(\d+)\./.exec(id)?.[1]??0);
      const experiment={kind:'diagnostic',rationale:'Inspect the admitted source and exercise the observed request independently',predictions:['A missing registration or a broadened fallback will disagree with the protected HTTP measurements'],program:"import {readFileSync} from 'node:fs'; console.log(readFileSync('./src/server.ts','utf8'));",requests:[]};
      if(kind==='investigation')return {fixtureOutput:{hypotheses:[{id:'control-h1',mechanism:iteration?'The previous candidate changed response behaviour beyond the required operation':'The admitted source does not satisfy a required HTTP operation',evidence:['baseline or candidate protected HTTP measurements'],contradictions:iteration?['Previous patch failed independent preservation checks']:[],predictions:experiment.predictions,rank:1}],experiment,unresolvedIntent:[],disposition:name==='unavailable-dependency'?'external_unavailable':'investigate'},fixturePlanner:experiment};
      if(kind==='synthesis'){
        const current={...faulty,files:input.source as Record<string,string>};
        const edits=name==='verification-bypass'&&iteration===0?bypassControl():name==='missing-route'&&iteration===0?failingControl(current):referenceControl(current,healthy);
        return {fixtureOutput:{edits,rationale:iteration?'Scripted control uses observed counterexamples to exercise a useful revision':'Explicit deterministic control candidate',changedCapabilities:[],changedResources:[]}};
      }
      return {fixtureOutput:{eligible:true,findings:['Scripted independent review control; measured criteria remain authoritative'],remainingUncertainty:[],risk:'low'}};
    };
  }
  runtime=new Runtime({journal,hostConfiguration:host,mode,builderImage:process.env.MAS_SANDBOX_IMAGE!,fixture,signal:cancellation.signal,
    developmentChecks:checks,requirementsHash,environmentHash,baseCommit,model:process.env.SELF_REMEDIATION_MODEL||undefined,
    perCallMicroUsd:mode==='live'?Number(process.env.SELF_REMEDIATION_MAX_CALL_MICRO_USD):0,
    current:async()=>{
      if(configured){const sourceHead=spawnSync('git',['-C',resolve(configured.repositoryDirectory??repositoryRoot),'rev-parse',configured.baseBranch??'main'],{encoding:'utf8',timeout:10000});if(sourceHead.status!==0||sourceHead.stdout.trim()!==baseCommit)throw new Boundary('stale_revision_target');await recheckOperational();}
      return {baseCommit,targetRevision:await deployment!.current()};
    },
    onTrial:async(build,report,expected)=>deployment!.trial(build,report,expected),
    onPublish:async(build,report,trial)=>{
      journal.assertActive();await recheckOperational();
      const imageArchive=await deployment!.export(build);
      const trialSpec=journal.value<TrialSpec>(`trial-spec:${build.source.tree}`)!;
      const files:Record<string,string|null>={};
      for(const path of new Set([...Object.keys(faulty.files),...Object.keys(build.source.files)]))files[`${configured?.pathPrefix??prefix}/${path}`]=build.source.files[path]??null;
      const tree=treeIdentity(files);
      const candidate:CandidatePublication={baseCommit,candidateTreeSha256:tree,files,requirementsSha256:requirementsHash,testsSha256:report.identity.tests,environmentSha256:environmentHash,imageDigest:trialSpec.imageDigest,
        verification:{candidateTreeSha256:tree,mandatory:report.criteria.filter(c=>c.mandatory).map(c=>({id:c.id,status:c.status==='passed'?'pass':c.status==='failed'?'fail':'inconclusive'}))}};
      const policy:PublicationPolicy={repository,baseBranch:configured?.baseBranch??`demo/incidents/${runId}`,allowedPathPrefix:configured?.pathPrefix??prefix,
        mode:configured?.publicationMode??(configured?'pull-request':'archive'),target:configured?'operational':'disposable-demo',runId,requiredChecks:configured?.requiredChecks??[],credentialKind:configured?(configured.credentialKind??'github-app'):'none'};
      const publication:PublishRequest={journalDirectory:directory,incidentId,operationId:`${runId}.publication`,attemptId:journal.value<string>('attempt')!,policy,candidate,
        ...(incidentGit?{incidentGit}:{}),...(configured?{operationalTarget:configured.operationalTarget,operationalBinding}:{}),promotion:{imageArchive:{...imageArchive,path:'candidate-image.json'},spec:{...trialSpec,stage:'promotion'},criteria:trialCriteria(checks)}};
      const verificationRef=journal.artefacts.put(report);
      writeImmutableFile(join(directory,'publication-manifest.json'),JSON.stringify(publication,null,2),0o600);
      writeImmutableFile(join(directory,'candidate-source.json'),JSON.stringify({baseCommit,sourceTree:build.source.tree,publicationTree:tree,files}));
      journal.append('candidate.preserved',{sourceTree:build.source.tree,publicationTree:tree,verification:verificationRef,imageDigest:trialSpec.imageDigest,imageConfigDigest:build.imageDigest});
      if(configured)return publisher.publish(publication.operationId,publication);
      return {status:'archived',requestedMode:policy.mode,reason:'Separate credential-bearing workflow publication job consumes the frozen manifest',manifest:'publication-manifest.json',verification:verificationRef};
    }});
  await deployment.recover();await runtime.recoverPending();
  if(configured){
    const observed=await external.operational(`${incidentId}.operational.initial`,configured.operationalTarget);
    if(!operationalBinding){operationalBinding=observed;journal.put('operational-baseline',observed);}
  }
  const source=await runtime.retainSnapshot(faulty);
  if(unresolvedIntent.length){
    result={outcome:'missing_requirements',unresolvedIntent};journal.append('incident.opened',{incidentId,mode,baseCommit,requirements:requirementsHash});journal.append('outcome',result);
  }else{
    const baseline=await runtime.build(source,`${incidentId}.baseline.build`);
    const raw=runtime.rawBuild(baseline);
    if(raw.status!=='passed'){
      deployment.recordBuildFailure(source,requirementsHash,testsHash,environmentHash,baseline.evidence);
      journal.append('measurement',{subject:'baseline build',criteria:raw.measurements,evidence:baseline.evidence});
    }else await deployment.baseline(source,raw,requirementsHash,testsHash,environmentHash);
    const baselineTarget=journal.value<TargetSnapshot>('baseline-target');
      const incident:Incident={id:incidentId,mode,baseCommit,targetRevision:baselineTarget?.resourceVersion??`unbuilt:${source.tree}`,source,requirements,requirementsHash,testsHash,environmentHash,
        configurationHash:sha256(faulty.files['config.json']),policy:{mode:configured?.publicationMode??(configured?'pull-request':'archive'),repository,baseRef:configured?.baseBranch??`demo/incidents/${runId}`,
          disposable:!configured,mandatoryCriteria:checks.map(c=>c.id),evaluator:'protected-http/1',allowedCapabilities:[],allowedResources:[]},
        trigger:operationalBinding?{...operationalBinding}:baselineTarget?{deployment:baselineTarget.name,namespace:baselineTarget.namespace,uid:baselineTarget.uid,image:baselineTarget.imageDigest,sourceCommit:baseCommit}:{kind:'source-build-failure',sourceCommit:baseCommit,evidence:baseline.evidence},unresolvedIntent};
      // Official GitHub MCP is a separately configured runtime read, never this ChatGPT session's plugin.
      if(process.env.SELF_REMEDIATION_GITHUB_READ_TOKEN&&process.env.SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256&&process.env.GITHUB_RUN_ID){
        await external.github(`${incidentId}.github_metadata`,{repository,workflowRunId:process.env.GITHUB_RUN_ID,
          workflowSourceRevision:process.env.GITHUB_SHA??mainCommit,toolSchemaSha256:process.env.SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256,
          evidenceSetting:configured?'operational':'blind'});
      }else journal.append('acceptance.unexecuted',{gate:'official GitHub MCP metadata read',reason:'Dedicated runtime read credential, frozen tool-schema digest or workflow identity unavailable'});
      result=await new Controller(journal,runtime).run(incident);
  }
}catch(error){
  const outcome=error instanceof Boundary?error.outcome:error instanceof UnknownEffect?'unknown_effect':error instanceof HostPhaseError?(error.uncertain?'unknown_effect':'no_eligible_candidate'):'policy_boundary';
  result={outcome,reason:error instanceof Error?error.message:String(error)};journal.append('outcome',result);
  if(!['missing_requirements','no_repair_required','unavailable_external_cause','no_eligible_candidate','cancelled','exhausted_budget'].includes(outcome))process.exitCode=1;
}finally{
  const events=journal.events();
  const disclosures=new Set<string>();
  for(const event of events)if(['candidate.created','measurement','verification','experiment.completed','candidate.preserved'].includes(event.type)){
    for(const key of ['patchRef','evidence','verification'])if(typeof event.data[key]==='string'&&/^sha256:[a-f0-9]{64}$/.test(event.data[key] as string))disclosures.add(event.data[key] as string);
  }
  writeFileSync(join(directory,'disclosed-artefacts.json'),JSON.stringify([...disclosures]),{mode:0o600});
  const metrics={mode,case:values.case,provider:mode==='fixture'?'explicit-scripted-control':process.env.SELF_REMEDIATION_MODEL??'host-default',success:result.outcome==='verified_recovery',trialRecovery:events.some(e=>e.type==='trial'&&e.data.recovered===true),falsePromotion:null,promotionAssessment:'Publication and promotion run separately; this controller has not assessed a deployed promotion',regressions:events.filter(e=>e.type==='verification'&&Array.isArray(e.data.regressions)&&e.data.regressions.length).length,abstention:result.outcome!=='verified_recovery',elapsedMs:Date.now()-(journal.budget().deadline-journal.budget().limits.wallMs),budget:journal.budget(),limitations:['Fixture responses establish control-path behaviour only','Billed cost requires provider usage and a current price schedule','Source behaviour is sampled by protected tests; arbitrary generated code correctness is unproved']};
  writeFileSync(join(directory,'result.json'),JSON.stringify({...result,metrics},null,2),{mode:0o600});
  writeFileSync(join(directory,'observation.done'),JSON.stringify({outcome:result.outcome}),{mode:0o600});
  stopWatchingCancellation();journal.checkpoint();journal.close();process.off('SIGTERM',cancel);process.off('SIGINT',cancel);
  process.stdout.write(JSON.stringify(result)+'\n');
}
