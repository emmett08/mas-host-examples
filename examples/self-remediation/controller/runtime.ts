/** Bind the durable SDLC controller to actual maintained-host phases and trusted tools. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HostPhaseRunner, HostPhaseError, type HostConfiguration, type PhaseKind } from '../host/phase.js';
import { executeTool } from '../host/tool.js';
import { registryDigest, requireCapability } from '../tools/capabilities.js';
import { materialise, sha256, verifySnapshot, type Snapshot } from '../tools/projection.js';
import type { ToolContext, Receipt } from '../tools/broker.js';
import type { BuildResult, HTTPCheck, Evaluation } from '../sandbox/executor.js';
import { finalChecks } from '../evaluation/harness.js';
import type { Criterion, Investigation, Synthesis, Verification } from '../contracts/types.js';
import { canonical } from '../deploy/effects.js';
import { Journal, Boundary } from './journal.js';
import type { Built, Check, LoopPorts, Source } from './loop.js';
export interface RuntimeSettings {
  journal: Journal; hostConfiguration: HostConfiguration; mode: 'fixture'|'live'; builderImage: string;
  fixture?: (kind: PhaseKind, input: Record<string,unknown>, id: string) => {fixtureOutput: unknown;fixturePlanner?: unknown};
  developmentChecks: HTTPCheck[]; requirementsHash: string; environmentHash: string; baseCommit: string;
  runtimeBundle?: string; model?: string; perCallMicroUsd?: number; signal?: AbortSignal;
  current: () => Promise<{baseCommit:string;targetRevision:string}> | {baseCommit:string;targetRevision:string};
  onTrial?: (build: Built, report: Verification, expectedTarget: string) => Promise<{recovered:boolean;evidence:string;observation:unknown}>;
  onPublish?: (build: Built, report: Verification, trial: unknown) => Promise<unknown>;
}
type ToolDispatch = { kind:'tool'; operation:string; capability:string; input:Record<string,unknown>; contextFile:string; identity:unknown };
type PhaseDispatch = { kind:'phase'; operation:string; phase:PhaseKind; input:Record<string,unknown>; options:Record<string,unknown>; identity:unknown };
type Dispatch = ToolDispatch | PhaseDispatch;
const clean = <T>(value:T):T => JSON.parse(JSON.stringify(value));
export class Runtime implements LoopPorts {
  readonly journal:Journal; readonly runner:HostPhaseRunner; readonly runtimeBundle:string;
  private readonly spend:number;
  constructor(readonly settings:RuntimeSettings) {
    this.journal=settings.journal; this.runner=new HostPhaseRunner(settings.hostConfiguration);
    this.runtimeBundle=resolve(settings.runtimeBundle??'dist-tools/broker.mjs');
    this.spend=settings.mode==='fixture'?0:(settings.perCallMicroUsd??Number(process.env.SELF_REMEDIATION_MAX_CALL_MICRO_USD));
    if(!Number.isSafeInteger(this.spend)||this.spend<0||(settings.mode==='live'&&this.spend===0)) throw new Error('Live mode requires a positive per-call expenditure reservation');
    if(settings.mode==='live'&&settings.fixture) throw new Error('Live runtime cannot receive fixture implementations');
  }
  async retainSnapshot(snapshot:Snapshot):Promise<Source> {
    await verifySnapshot(snapshot);
    const root=join(this.journal.directory,'sources',snapshot.tree);
    const durable=existsSync(root)?{...snapshot,root}:await materialise(snapshot.files,snapshot.projection,root);
    await verifySnapshot(durable);
    return {tree:durable.tree,files:durable.files,ref:this.journal.artefacts.put(durable)};
  }
  async snapshot(source:Source):Promise<Snapshot> {
    const retained=this.journal.artefacts.json<Snapshot>(source.ref);
    if(retained.tree!==source.tree||sha256(canonical(retained.files))!==sha256(canonical(source.files))) throw new Boundary('stale_revision_target','Source and retained snapshot disagree');
    // Restored runner checkpoints can have a new directory. Materialise only the already hashed projection.
    const root=join(this.journal.directory,'sources',retained.tree);
    const snapshot=existsSync(root)?{...retained,root}:await materialise(retained.files,retained.projection,root);
    await verifySnapshot(snapshot); return snapshot;
  }
  rawBuild(built:Built):BuildResult { return this.journal.artefacts.json<BuildResult>(built.evidence); }
  private observation(operation:string,value:any) {
    const observedRef=this.journal.artefacts.put(clean(value));
    const existing=new Set(this.journal.events().filter(e=>e.type==='mas.message').map(e=>String(e.data.id)));
    for(const message of value?.messages??[]) {
      const id=`${operation}:${message.message_id??message.sequence}`;
      if(existing.has(id))continue;
      this.journal.append('mas.message',{id,phaseId:operation,from:message.sender,to:message.recipient,sender:message.sender,recipient:message.recipient,messageType:message.kind,operation:message.operation??'',evidence:observedRef});
      existing.add(id);
    }
    return observedRef;
  }
  private compact(input:Record<string,unknown>):Record<string,unknown> {
    const exact=clean(input), reference=this.journal.artefacts.put(exact);
    if(Buffer.byteLength(JSON.stringify(exact))<=9500) return exact;
    // Preserve source and owner requirements exactly. Only repeated measured evidence
    // receives an explicitly labelled bounded projection with its complete retained reference.
    const summary=(value:any):any=>{
      if(typeof value==='string')return value.length>420?{preview:value.slice(0,420),truncated:true,completeInputRef:reference}:value;
      if(Array.isArray(value))return value.slice(0,24).map(summary);
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,summary(entry)]));
      return value;
    };
    const result:Record<string,unknown>={...exact,completeInputRef:reference,evidenceProjection:'bounded summaries; source and intended behaviour preserved exactly'};
    for(const key of ['measurements','baseline','experiment'])if(key in exact)result[key]=summary(exact[key]);
    if(Array.isArray(exact.edits))result.edits=exact.edits.map((edit:any)=>({path:edit.path,contentRef:this.journal.artefacts.put(edit),deleted:edit.content===null}));
    if(Buffer.byteLength(JSON.stringify(result))>9900) throw new Boundary('policy_boundary','Exact source and requirements exceed phase frame budget; a smaller admitted evidence selection is required');
    return result;
  }
  private async perform(dispatch:Dispatch,recover=false):Promise<any> {
    const j=this.journal, operation=dispatch.operation;
    if(this.settings.signal?.aborted)throw new Boundary('cancelled');
    if(dispatch.kind==='phase'&&dispatch.options.mode!==this.settings.mode)throw new Boundary('policy_boundary','Retained provider mode differs from current controller mode');
    const calls=dispatch.kind==='phase'?(dispatch.phase==='investigation'?3:1):0;
    const admitted=j.admitPhase(operation,dispatch.identity,dispatch.kind==='phase'?{calls,microUsd:calls*this.spend}:{operations:1});
    if(admitted.status==='completed')return admitted.result;
    if(admitted.status==='failed')throw new Boundary('no_eligible_candidate','This frozen phase has a retained known failure');
    const cancel=()=>{void this.runner.cancel(operation).catch(()=>{});};
    this.settings.signal?.addEventListener('abort',cancel,{once:true});
    const cancelWatcher=setInterval(()=>{if(this.settings.signal?.aborted)cancel();},500);
    try {
      if(dispatch.kind==='phase') {
        const phaseFile=join(this.settings.hostConfiguration.stateDir,'phases',operation,'identity.json');
        const result=recover&&existsSync(phaseFile)?await this.runner.resume(operation):await this.runner.run(dispatch.phase,operation,dispatch.input,{...(dispatch.options as any),signal:this.settings.signal,onObservation:(value:any)=>{this.observation(operation,value);}});
        const observationRef=this.observation(operation,result.observation);
        const saved=clean({output:result.output,observationRef,identity:result.identity,invocationIds:result.invocationIds,providerUsage:result.providerUsage,calls:result.calls});
        j.finishPhase(operation,'completed',saved);
        j.append('provider',{phaseId:operation,mode:this.settings.mode,model:this.settings.model??'maintained-host-default',calls:result.calls,reservedMicroUsd:calls*this.spend,usage:result.providerUsage,accounting:'reserved upper bound; provider usage retained separately'});
        return saved;
      }
      const result=await executeTool(this.settings.hostConfiguration,operation,dispatch.capability,dispatch.input,{contextFile:dispatch.contextFile,runtimeBundle:this.runtimeBundle,onObservation:(value:any)=>{this.observation(operation,value);}});
      const receipt=result.receipt;
      const bytes=readFileSync(join(j.directory,'tool-artefacts',receipt.resultRef.slice(7)+'.json'));
      if(sha256(bytes)!==receipt.resultRef.slice(7))throw new Error('Retained tool result hash mismatch');
      const valueRef=j.artefacts.putBytes(bytes), observationRef=this.observation(operation,result.observation);
      const saved={valueRef,receipt,observationRef,invocationIds:result.invocationIds};
      j.finishPhase(operation,'completed',saved);
      j.append('tool.result',{phaseId:operation,operationId:receipt.operationId,invocation_id:receipt.invocation_id,capability:dispatch.capability,status:receipt.operationStatus,measurement:receipt.measurement,evidence:valueRef,observation:observationRef});
      return saved;
    } catch(error) {
      const observation=error instanceof HostPhaseError&&error.observation?this.observation(operation,error.observation):null;
      j.finishPhase(operation,error instanceof HostPhaseError&&!error.uncertain?'failed':'unknown',{reason:error instanceof Error?error.message:String(error),observation});
      throw error;
    } finally {clearInterval(cancelWatcher);this.settings.signal?.removeEventListener('abort',cancel);}
  }
  async recoverPending():Promise<void> {
    const pending=this.journal.db.prepare("SELECT id FROM phases WHERE status IN ('running','unknown') ORDER BY rowid").all();
    for(const row of pending) {
      const descriptor=this.journal.value<Dispatch>(`runtime:dispatch:${String(row.id)}`);
      if(!descriptor)continue; // Deployment/publication composition owns its separate dispatch descriptors.
      await this.perform(descriptor,true);
    }
  }
  async recover():Promise<void> { await this.recoverPending(); }
  private async tool(capability:string,operation:string,source:Source,input:Record<string,unknown>,extra:Partial<ToolContext>={}):Promise<any> {
    const snapshot=await this.snapshot(source), j=this.journal;
    const context=clean({snapshot,journalPath:join(j.directory,'tool-effects.sqlite'),artefactRoot:join(j.directory,'tool-artefacts'),registryDigest,builderImage:this.settings.builderImage,runtimeBundle:this.runtimeBundle,runtimeDigest:sha256(readFileSync(this.runtimeBundle)),...extra});
    const directory=join(j.directory,'contexts');mkdirSync(directory,{recursive:true,mode:0o700});
    const contextFile=join(directory,sha256(operation)+'.json'), bytes=JSON.stringify(context);
    if(existsSync(contextFile)) {if(readFileSync(contextFile,'utf8')!==bytes)throw new Boundary('stale_revision_target','Frozen operation context changed');}
    else writeFileSync(contextFile,bytes,{flag:'wx',mode:0o400});
    const request={operationId:operation,...input};
    if(Buffer.byteLength(JSON.stringify(request))>18000)throw new Boundary('policy_boundary','Tool input exceeds admitted frame budget; retained artefact selection required');
    const identity={kind:'tool',capability,input:request,context:sha256(bytes),runtime:context.runtimeDigest};
    const descriptor:ToolDispatch={kind:'tool',operation,capability,input:request,contextFile,identity};
    j.put(`runtime:dispatch:${operation}`,descriptor);
    const saved=await this.perform(descriptor,true);
    return {value:j.artefacts.json(saved.valueRef),evidence:saved.valueRef,receipt:saved.receipt as Receipt};
  }
  async phase<T>(kind:PhaseKind,id:string,input:Record<string,unknown>):Promise<T> {
    // Explicit ordinary tool phases precede inference; no command effect enters --revision-plan.
    if(kind==='investigation'&&typeof input.sourceRef==='string'&&!this.journal.value('runtime:source-demonstration')) {
      const source:Source={tree:String(input.sourceTree),files:input.source as Record<string,string>,ref:input.sourceRef};
      const path=Object.keys(source.files).find(p=>p.startsWith('src/'));
      if(path) { await this.tool('source_read',`${id}.read`,source,{path}); await this.tool('custom_mcp_read',`${id}.mcp`,source,{path}); this.journal.put('runtime:source-demonstration',{sourceTree:source.tree,phaseId:id}); }
    }
    const compact=this.compact(input), control=this.settings.mode==='fixture'?this.settings.fixture?.(kind,input,id):undefined;
    if(this.settings.mode==='fixture'&&!control)throw new Error('Explicit fixture phase response required');
    const calls=kind==='investigation'?3:1, remaining=this.journal.budget().deadline-Date.now();
    const options=clean({mode:this.settings.mode,model:this.settings.model,maxCalls:calls,wallSeconds:Math.max(1,Math.min(180,Math.floor(remaining/1000))),...control});
    const descriptor:PhaseDispatch={kind:'phase',operation:id,phase:kind,input:compact,options,identity:{kind,mode:this.settings.mode,input:sha256(canonical(compact)),options}};
    const prior=this.journal.value<PhaseDispatch>(`runtime:dispatch:${id}`);
    // A restart keeps the original wall limit and fixture bytes, not the new wall clock.
    if(prior) {if(prior.identity&&sha256(canonical(prior.input))!==sha256(canonical(compact)))throw new Boundary('stale_revision_target','Changed frozen phase input');return (await this.perform(prior,true)).output as T;}
    this.journal.put(`runtime:dispatch:${id}`,descriptor);
    return (await this.perform(descriptor)).output as T;
  }
  async build(source:Source,operation:string):Promise<Built> {
    const identity={baseCommit:this.settings.baseCommit,candidateTree:source.tree,requirements:this.settings.requirementsHash,tests:sha256(JSON.stringify(this.settings.developmentChecks)),environment:this.settings.environmentHash};
    const result=await this.tool('build',operation,source,{}, {identity});
    const raw=result.value as BuildResult;
    const built:Built={imageDigest:raw.imageDigest??'',source,evidence:result.evidence,status:raw.status};
    if(operation.endsWith('.baseline.build'))this.journal.put('runtime:baseline',built);
    return built;
  }
  private async evaluate(build:Built,operation:string,checks:HTTPCheck[]):Promise<{result:Evaluation;evidence:string}> {
    const raw=this.rawBuild(build), digest=sha256(JSON.stringify(checks));
    const assessmentIdentity={...raw.identity,candidateTree:build.source.tree,tests:digest};
    const result=await this.tool('test',operation,build.source,{}, {buildResult:raw,protectedChecks:checks,protectedSuiteDigest:digest,assessmentIdentity});
    return {result:result.value,evidence:result.evidence};
  }
  async check(build:Built,operation:string,final:boolean):Promise<Check> {
    let checks=this.settings.developmentChecks, finalFresh=false;
    if(final) {
      let retained=this.journal.value<{checksJSON:string;seed:string;digest:string}>(`runtime:final:${operation}`);
      if(!retained){const fresh=finalChecks();retained={checksJSON:JSON.stringify(fresh.checks),seed:fresh.seed,digest:fresh.digest};this.journal.put(`runtime:final:${operation}`,retained);}
      const suite={...retained,checks:JSON.parse(retained.checksJSON) as HTTPCheck[]};
      if(sha256(retained.checksJSON)!==suite.digest)throw new Boundary('stale_revision_target','Protected suite bytes changed');
      checks=suite.checks; finalFresh=!this.journal.events().some(e=>e.type==='evaluation.exposure'&&e.data.tests===suite.digest&&e.data.status==='development');
      const baseline=this.journal.value<Built>('runtime:baseline');
      if(!baseline)throw new Boundary('policy_boundary','Matched baseline image missing for fresh final suite');
      const original=baseline.status==='passed'?await this.evaluate(baseline,`${operation}.baseline`,checks):{result:{status:'inconclusive',reason:'Retained baseline build failed, so fresh runtime checks cannot execute',tests:suite.digest,environment:this.settings.environmentHash},evidence:baseline.evidence};
      this.journal.put(`runtime:final-baseline:${operation}`,original);
      this.journal.append('evaluation.exposure',{tests:suite.digest,status:finalFresh?'final-untouched':'development',subject:'matched baseline rechecked',evidence:original.evidence});
    }
    if(build.status!=='passed') {
      const raw=this.rawBuild(build);
      const criteria:Criterion[]=[...raw.measurements.map((m):Criterion=>({id:m.criterion,status:m.status,mandatory:true,evidence:[build.evidence],explanation:m.detail??'Build did not complete successfully'})),...checks.map((check):Criterion=>({id:check.id,status:'inconclusive',mandatory:true,evidence:[build.evidence],explanation:raw.status==='failed'?'HTTP check not executed because the independent build failed':'HTTP check not executed because the independent build result is inconclusive'}))];
      return {criteria:criteria.length?criteria:[{id:'build',status:'inconclusive',mandatory:true,evidence:[build.evidence],explanation:'No independent build measurement'}],evidence:build.evidence,tests:sha256(JSON.stringify(checks)),environment:this.settings.environmentHash,authority:'independent',changedCapabilities:[],changedResources:[],finalFresh} as Check;
    }
    const observed=await this.evaluate(build,operation,checks);
    const criteria:Criterion[]=observed.result.measurements.map(m=>({id:m.criterion,status:m.status,mandatory:true,evidence:[observed.evidence],explanation:m.detail??JSON.stringify({expected:m.expected,actual:m.actual}).slice(0,1200)}));
    return {criteria,evidence:observed.evidence,tests:sha256(JSON.stringify(checks)),environment:this.settings.environmentHash,authority:'independent',changedCapabilities:[],changedResources:[],finalFresh} as Check;
  }
  async edit(base:Source,changes:Synthesis,operation:string):Promise<Source> {
    const result=await this.tool('source_edit',operation,base,{edits:changes.edits});
    if(result.receipt.measurement!=='passed'||!result.value.snapshot)throw new Boundary('policy_boundary',result.value.reason??'Candidate source edit rejected');
    return this.retainSnapshot(result.value.snapshot);
  }
  async experiment(source:Source,plan:Investigation['experiment'],operation:string):Promise<unknown> {
    let program=plan.program;
    if(plan.kind==='http') {
      const requests=plan.requests??[];
      if(!requests.length||requests.length>8||requests.some(x=>!x.path.startsWith('/')||x.path.startsWith('//')||x.path.length>200))throw new Boundary('policy_boundary','Diagnostic HTTP requests exceed loopback projection');
      program=`import './src/server.ts'; await new Promise(r=>setTimeout(r,150)); const results=[]; for(const request of ${JSON.stringify(requests.map(x=>({path:x.path})))}) {try {const response=await fetch('http://127.0.0.1:8080'+request.path,{signal:AbortSignal.timeout(2000)});results.push({path:request.path,status:response.status,body:(await response.text()).slice(0,2048)});}catch{results.push({path:request.path,status:'unavailable'});}} console.log(JSON.stringify(results));process.exit(0);`;
    }
    if(!program)throw new Boundary('policy_boundary','Discriminating diagnostic program required');
    const result=await this.tool('diagnostic_program',operation,source,{program});
    return {measurement:result.receipt.measurement,result:result.value,evidence:result.evidence};
  }
  async current(){return this.settings.current();}
  async trial(build:Built,report:Verification,expectedTarget:string){if(!this.settings.onTrial)throw new Boundary('policy_boundary','No isolated trial adapter configured');return this.settings.onTrial(build,report,expectedTarget);}
  async publish(build:Built,report:Verification,trial:unknown){if(this.settings.onPublish)return this.settings.onPublish(build,report,trial);return {mode:'archive',candidate:build.source.ref,verification:this.journal.artefacts.put(report),imageDigest:build.imageDigest};}
}
