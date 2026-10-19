/** Execute the bounded SDLC loop using host phases and independently authorised tool ports. */
import { sha256 } from '../deploy/effects.js';
import type { Criterion, Identity, Investigation, Outcome, ReleasePolicy, Review, Synthesis, Verification } from '../contracts/types.js';
import { Journal, Boundary } from './journal.js';
import { eligibility } from './policy.js';
export interface Source { tree: string; files: Record<string,string>; ref: string }
export interface Built { imageDigest: string; source: Source; evidence: string; status: 'passed'|'failed'|'inconclusive' }
export interface Check { criteria: Criterion[]; evidence: string; tests: string; environment: string;
  authority:'independent'; changedCapabilities:string[]; changedResources:string[]; finalFresh?:boolean }
export interface LoopPorts {
  recover?(): Promise<void>;
  phase<T>(kind: 'investigation'|'synthesis'|'review', id: string, input: Record<string,unknown>): Promise<T>;
  build(source: Source, operation: string): Promise<Built>;
  check(build: Built, operation: string, final: boolean): Promise<Check>;
  experiment(source: Source, plan: Investigation['experiment'], operation: string): Promise<unknown>;
  edit(base: Source, changes: Synthesis, operation: string): Promise<Source>;
  current(): Promise<{baseCommit:string; targetRevision:string}>;
  trial(build: Built, report: Verification, expectedTarget: string): Promise<{recovered:boolean; evidence:string; observation:unknown}>;
  publish(build: Built, report: Verification, trial: unknown): Promise<unknown>;
}
export interface Incident {
  id: string; mode:'fixture'|'live'; baseCommit:string; targetRevision:string; source:Source;
  requirements:Record<string,unknown>; requirementsHash:string; testsHash:string; environmentHash:string;
  configurationHash:string; policy:ReleasePolicy; trigger:Record<string,unknown>; unresolvedIntent:string[];
}
export class Controller {
  constructor(readonly journal:Journal, readonly ports:LoopPorts) {}
  private stop(outcome:Outcome, details:Record<string,unknown> = {}) {
    this.journal.append('outcome',{outcome,...details}); this.journal.checkpoint(); return {outcome,...details};
  }
  async run(incident:Incident):Promise<Record<string,unknown>> {
    const j=this.journal;
    await this.ports.recover?.();
    j.put(`incident:${incident.id}`,incident);
    j.append('incident.opened',{incidentId:incident.id,mode:incident.mode,baseCommit:incident.baseCommit,sourceTree:incident.source.tree,
      trigger:incident.trigger,requirements:incident.requirementsHash,tests:incident.testsHash,environment:incident.environmentHash});
    if(incident.unresolvedIntent.length) return this.stop('missing_requirements',{unresolvedIntent:incident.unresolvedIntent});
    const stillCurrent = async () => {
      j.assertActive(); const current=await this.ports.current();
      if(current.baseCommit!==incident.baseCommit || current.targetRevision!==incident.targetRevision) throw new Boundary('stale_revision_target');
    };
    await stillCurrent();
    j.append('lifecycle',{stage:'reproduce baseline'});
    const baseline=await this.ports.build(incident.source,`${incident.id}.baseline.build`);
    const baselineChecks=await this.ports.check(baseline,`${incident.id}.baseline.check`,false);
    if(baseline.source.tree!==incident.source.tree||baselineChecks.authority!=='independent'||baselineChecks.tests!==incident.testsHash||baselineChecks.environment!==incident.environmentHash)
      throw new Boundary('policy_boundary','Baseline source or independent measurement binding differs');
    if(!baselineChecks.criteria.length||incident.policy.mandatoryCriteria.some(id=>!baselineChecks.criteria.some(c=>c.id===id&&c.mandatory)))
      return this.stop('unreproduced_failure',{reason:'Baseline mandatory criteria are absent'});
    const baselineRef=j.artefacts.put(baselineChecks);
    j.append('measurement',{subject:'baseline',criteria:baselineChecks.criteria,evidence:baselineRef,imageDigest:baseline.imageDigest});
    if(baselineChecks.criteria.every(c=>c.status==='passed') && baseline.status==='passed') return this.stop('no_repair_required',{baseline:baselineRef});
    if(baselineChecks.criteria.every(c=>c.status!=='failed') && baseline.status!=='failed') return this.stop('unreproduced_failure',{baseline:baselineRef});
    let counterexamples:unknown[]=[baselineChecks], previous:Source=incident.source;
    for(let iteration=0;iteration<j.budget().limits.candidates;iteration++) {
      await stillCurrent();
      const frozen={baseCommit:incident.baseCommit,source:previous.files,sourceTree:previous.tree,sourceRef:previous.ref,
        intendedBehaviour:incident.requirements,measurements:counterexamples,baselineEvidence:baselineRef,
        limits:{allowedPaths:'src/**/*.ts and config.json',persistentData:'excluded',testAuthority:'independent protected harness'}};
      j.append('lifecycle',{stage:'investigation',iteration});
      const diagnosis=await this.ports.phase<Investigation>('investigation',`${incident.id}.i${iteration}.investigation`,frozen);
      j.append('hypotheses',{hypotheses:diagnosis.hypotheses,disposition:diagnosis.disposition,unresolvedIntent:diagnosis.unresolvedIntent});
      if(diagnosis.unresolvedIntent.length || diagnosis.disposition==='missing_requirements') return this.stop('missing_requirements',{unresolvedIntent:diagnosis.unresolvedIntent});
      j.append('experiment.planned',{...diagnosis.experiment,iteration});
      const experiment=await this.ports.experiment(previous,diagnosis.experiment,`${incident.id}.i${iteration}.experiment`);
      const experimentRef=j.artefacts.put(experiment);
      j.append('experiment.completed',{iteration,result:experiment,evidence:experimentRef,predictions:diagnosis.experiment.predictions});
      if(diagnosis.disposition==='external_unavailable') return this.stop('unavailable_external_cause',{diagnosis:j.artefacts.put(diagnosis),experiment:experimentRef,scope:'model explanation with retained experiment; no source repair claimed'});
      if(diagnosis.disposition==='no_repair_required') {
        // An observed failing requirement cannot be dismissed by model judgement.
        counterexamples.push({contradiction:'Baseline mandatory requirement failed; model no-action judgement cannot establish recovery',evidence:baselineRef});
        continue;
      }
      const synthesis=await this.ports.phase<Synthesis>('synthesis',`${incident.id}.i${iteration}.synthesis`,{...frozen,diagnosis,experiment});
      j.append('lifecycle',{stage:'candidate generation',iteration});
      let candidate:Source;
      try { candidate=await this.ports.edit(previous,synthesis,`${incident.id}.i${iteration}.edit`); }
      catch(error) {
        if(!(error instanceof Boundary)||error.outcome!=='policy_boundary')throw error;
        counterexamples=[{rejection:'Candidate attempted a change outside its admitted source authority',reason:error.message}];
        j.append('verification',{eligible:false,iteration,reasons:counterexamples,disposition:'return to investigation'});
        continue;
      }
      const cumulativeEdits=[...new Set([...Object.keys(incident.source.files),...Object.keys(candidate.files)])]
        .filter(path=>incident.source.files[path]!==candidate.files[path]).map(path=>({path,before:incident.source.files[path]??null,content:candidate.files[path]??null}));
      const patchRef=j.artefacts.put(cumulativeEdits);
      const previousRecord=j.value<{tree:string}>(`iteration:${incident.id}:${iteration}`);
      if(!previousRecord) { j.candidate(candidate.tree,{iteration,sourceRef:candidate.ref,patchRef,rationale:synthesis.rationale,changedCapabilities:synthesis.changedCapabilities,changedResources:synthesis.changedResources}); j.put(`iteration:${incident.id}:${iteration}`,{tree:candidate.tree}); }
      else if(previousRecord.tree!==candidate.tree) throw new Boundary('stale_revision_target','Restart produced a different candidate');
      const built=await this.ports.build(candidate,`${incident.id}.i${iteration}.build`);
      if(built.source.tree!==candidate.tree||sha256(built.source.files)!==sha256(candidate.files)) throw new Boundary('stale_revision_target','Built artefact does not bind current candidate source');
      const checked=await this.ports.check(built,`${incident.id}.i${iteration}.check`,false);
      j.append('measurement',{subject:'candidate',candidateId:candidate.tree,criteria:checked.criteria,evidence:checked.evidence});
      if(checked.authority!=='independent'||checked.tests!==baselineChecks.tests || checked.environment!==baselineChecks.environment) throw new Boundary('policy_boundary','Matched baseline/candidate identities differ; recheck baseline before selection');
      const regressions=baselineChecks.criteria.filter(c=>c.status==='passed' && checked.criteria.find(x=>x.id===c.id)?.status!=='passed').map(c=>c.id);
      const identity:Identity={baseCommit:incident.baseCommit,sourceTree:incident.source.tree,candidateTree:candidate.tree,patch:patchRef,
        requirements:incident.requirementsHash,tests:checked.tests,environment:checked.environment,configuration:incident.configurationHash,imageDigest:built.imageDigest};
      const checksFailed=built.status!=='passed'||incident.policy.mandatoryCriteria.some(id=>!checked.criteria.some(c=>c.id===id&&c.mandatory&&c.status==='passed'))||checked.criteria.some(c=>c.mandatory&&c.status!=='passed')||regressions.length>0;
      if(checksFailed) {
        counterexamples=[{candidate:candidate.tree,criteria:checked.criteria,regressions,evidence:checked.evidence}]; previous=candidate;
        j.append('verification',{candidateId:candidate.tree,eligible:false,criteria:checked.criteria,regressions,disposition:'return to investigation'}); continue;
      }
      const review=await this.ports.phase<Review>('review',`${incident.id}.i${iteration}.review`,{identity,requirements:incident.requirements,
        candidate:candidate.files,edits:synthesis.edits,measurements:checked.criteria,baseline:baselineChecks.criteria});
      const report:Verification={identity,evaluator:incident.policy.evaluator,evaluatorVersion:checked.tests,criteria:checked.criteria,
        regressions,changedCapabilities:checked.changedCapabilities,changedResources:checked.changedResources,
        remainingUncertainty:review.eligible?review.remainingUncertainty:[...review.remainingUncertainty,...review.findings,'independent review rejected'],
        operationalRisk:review.risk==='low'?0:review.risk==='medium'?1:2,unnecessaryChange:synthesis.edits.length,
        costMicroUsd:j.budget().used.microUsd,authority:'independent',exposure:'development'};
      const decision=eligibility(report,identity,incident.policy);
      j.append('verification',{...report,eligible:decision.eligible,reasons:decision.reasons});
      if(!decision.eligible) {counterexamples=[{review,decision}];previous=candidate;continue;}
      // Final tests remain outside every source snapshot and phase input until selected.
      const finalCheck=await this.ports.check(built,`${incident.id}.i${iteration}.final`,true);
      j.append('measurement',{subject:'independent final evaluation',criteria:finalCheck.criteria,evidence:finalCheck.evidence,exposure:'final-untouched'});
      if(finalCheck.authority!=='independent'||!finalCheck.finalFresh||!finalCheck.tests||finalCheck.environment!==checked.environment||!finalCheck.criteria.length)
        throw new Boundary('policy_boundary','Independent final evaluation lacks current untouched suite identity');
      if(j.value(`disclosed-final:${finalCheck.tests}`))throw new Boundary('policy_boundary','Final suite was previously disclosed for development');
      if(finalCheck.criteria.some(c=>c.mandatory&&c.status!=='passed')) {
        j.put(`disclosed-final:${finalCheck.tests}`,true);
        counterexamples=[{criteria:finalCheck.criteria,evidence:finalCheck.evidence,exposure:'final-disclosed'}]; previous=candidate;
        j.append('evaluation.exposure',{tests:finalCheck.tests,status:'development',reason:'Final counterexample disclosed for another repair attempt; fresh final suite required'});
        continue;
      }
      const finalIdentity={...identity,tests:sha256({development:checked.tests,final:finalCheck.tests})};
      const finalReport={...report,identity:finalIdentity,criteria:[...report.criteria,...finalCheck.criteria],exposure:'final-untouched' as const};
      if(!eligibility(finalReport,finalIdentity,incident.policy).eligible)throw new Boundary('policy_boundary','Final assessment invalidated eligibility');
      j.put(`verified:${candidate.tree}`,finalReport); await stillCurrent();
      j.append('lifecycle',{stage:'isolated trial',candidateId:candidate.tree});
      const trial=await this.ports.trial(built,finalReport,incident.targetRevision);
      j.append('trial',{...trial,candidateId:candidate.tree,imageDigest:built.imageDigest});
      if(!trial.recovered) {counterexamples=[{trial}];previous=candidate;continue;}
      j.assertActive();
      if((await this.ports.current()).baseCommit!==incident.baseCommit)throw new Boundary('stale_revision_target');
      const publication=await this.ports.publish(built,finalReport,trial);
      j.append('github',{publication});
      return this.stop('verified_recovery',{scope:'isolated trial',candidate:candidate.tree,imageDigest:built.imageDigest,publication,
        competenceClaim:incident.mode==='fixture'?'scripted control only':'observed result on this case and provider only'});
    }
    return this.stop('no_eligible_candidate',{counterexamples:sha256(counterexamples)});
  }
}
