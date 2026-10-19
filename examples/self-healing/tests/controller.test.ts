import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, DEFAULT_BUDGET } from '../controller/journal.js';
import { eligibility, assertAutomaticScope } from '../controller/policy.js';
import type { Identity, ReleasePolicy, Verification } from '../contracts/types.js';
import { sha256 } from '../deploy/effects.js';
const create=()=>new Journal(mkdtempSync(join(tmpdir(),'mas-journal-')),'incident',DEFAULT_BUDGET);
test('reservations, cancellation and immutable committed events survive process restart',()=>{
  const j=create();const path=j.directory;j.reserveBudget('read',{calls:2});j.reserveBudget('read',{calls:2});
  assert.equal(j.budget().used.calls,2);j.cancel('requested');j.close();
  const reopened=Journal.open(path,'incident');assert.equal(reopened.budget().used.calls,2);assert.throws(()=>reopened.reserveBudget('next',{calls:1}),/cancelled/);
  assert.throws(()=>reopened.db.prepare('DELETE FROM events').run(),/immutable/);reopened.close();
});
test('unknown effects block new phases until an exact external receipt is retained',()=>{
  const j=create();j.intend({operationId:'op1',invocationId:'admitted-1',attemptId:'process',kind:'create',target:'branch',inputHash:sha256({}),input:{},status:'intended'});
  j.settle('op1','unknown');assert.throws(()=>j.admitPhase('new-run',{tree:'new'},{calls:1}),/Unknown effect/);
  j.settle('op1','completed',{branch:'exact',evidence:'read-by-operation-id'});
  j.admitPhase('new-run',{tree:'new'},{calls:1});j.finishPhase('new-run','completed',{found:true});
  assert.throws(()=>j.settle('op1','completed',{branch:'other'}),/Conflicting/);j.close();
});
test('failed measurement permits a fresh phase, unknown phase can resume only its own identity',()=>{
  const j=create();j.admitPhase('p1',{tree:'a'},{calls:1});j.finishPhase('p1','completed',{measurement:'failed'});
  j.admitPhase('p2',{tree:'b'},{calls:1});j.finishPhase('p2','unknown',{transport:'lost'});
  assert.throws(()=>j.admitPhase('p3',{tree:'c'},{calls:1}),/Unknown effect/);
  assert.throws(()=>j.admitPhase('p2',{tree:'changed'},{calls:1}),/Frozen phase/);
  assert.equal(j.admitPhase('p2',{tree:'b'},{calls:1}).status,'unknown');j.close();
});
test('persistent workflow budgets and candidate cycle detection block new admissions',()=>{
  const j=create();j.reserveBudget('all',{calls:DEFAULT_BUDGET.calls});assert.throws(()=>j.reserveBudget('extra',{calls:1}),/budget exhausted/);
  j.candidate('tree',{patch:'p'});assert.throws(()=>j.candidate('tree',{patch:'other'}),/Repeated candidate/);j.close();
});
test('promotion owner and revision are retained and cannot be superseded by another incident',()=>{
  const j=create();j.acquireTarget('deployment','rv1');const other=new Journal(j.directory,'other');
  assert.throws(()=>other.acquireTarget('deployment','rv1'),/Another owner/);
  assert.throws(()=>j.acquireTarget('deployment','rv2'),/Another owner/);other.close();j.close();
});
const identity:Identity={baseCommit:'a'.repeat(40),sourceTree:'a',candidateTree:'b',patch:'c',requirements:'d',tests:'e',environment:'f',configuration:'g',imageDigest:'sha256:'+'a'.repeat(64)};
const policy:ReleasePolicy={mode:'pull-request',repository:'owner/repo',baseRef:'main',disposable:false,mandatoryCriteria:['business'],evaluator:'protected',allowedCapabilities:[],allowedResources:[]};
const verification:Verification={identity,evaluator:'protected',evaluatorVersion:'v1',criteria:[{id:'business',status:'passed',mandatory:true,evidence:['hash'],explanation:'measured'}],regressions:[],changedCapabilities:[],changedResources:[],remainingUncertainty:[],operationalRisk:0,unnecessaryChange:1,costMicroUsd:1,authority:'independent',exposure:'development'};
test('every mandatory gate and exact current identity are required, irrespective of model vote',()=>{
  assert.equal(eligibility(verification,identity,policy).eligible,true);
  for(const key of Object.keys(identity)) assert.equal(eligibility(verification,{...identity,[key]:'changed'},policy).eligible,false);
  assert.equal(eligibility({...verification,criteria:[{...verification.criteria[0]!,status:'inconclusive'}]},identity,policy).eligible,false);
  assert.equal(eligibility({...verification,evaluator:'repair-agent'},identity,policy).eligible,false);
  assert.equal(eligibility({...verification,changedCapabilities:['network']},identity,policy).eligible,false);
  assert.throws(()=>assertAutomaticScope({...policy,mode:'automatic'}),/disposable/);
});
