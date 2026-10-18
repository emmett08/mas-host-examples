/** Scripted controller controls only. These tests measure no LLM repair competence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, type Incident, type LoopPorts, type Source } from '../controller/loop.js';
import { Journal, DEFAULT_BUDGET } from '../controller/journal.js';
import { sha256 } from '../deploy/effects.js';
import type { Criterion, Investigation, Review, Synthesis } from '../contracts/types.js';

const criterion = (id: string, status: Criterion['status']): Criterion => ({ id, status, mandatory: true, evidence: ['sha256:' + 'a'.repeat(64)], explanation: `scripted control measurement: ${status}` });
const source = (label: string): Source => ({ tree: sha256(label), files: { 'src/app.ts': `export const result = ${JSON.stringify(label)};` }, ref: `sha256:${sha256({ label })}` });
function fixture(options: { candidateFailures?: number; reviewFailures?: number; finalFailures?: number; reusedFinal?: boolean; staleAt?: number; staleBuild?: boolean; cancelDuringTrial?: boolean; emptyBaseline?: boolean; failedBuildBaseline?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mas-loop-control-'));
  let journal = new Journal(directory, 'loop-control', { ...DEFAULT_BUDGET, candidates: 3 });
  const initial = source('baseline');
  const incident: Incident = { id: 'loop-control', mode: 'fixture', baseCommit: 'a'.repeat(40), targetRevision: 'rv-1', source: initial,
    requirements: { meaning: 'A control-fixture business value must equal its declared value.' }, requirementsHash: 'requirements-v1', testsHash: 'development-v1', environmentHash: 'environment-v1', configurationHash: 'config-v1',
    policy: { mode: 'archive', repository: 'example/disposable', baseRef: 'demo/incidents/loop-control', disposable: true, mandatoryCriteria: ['business', 'live'], evaluator: 'protected-control-evaluator', allowedCapabilities: [], allowedResources: [] },
    trigger: { status: 500 }, unresolvedIntent: [] };
  const observed = { investigations: [] as Record<string, unknown>[], phases: [] as string[], trial: 0, publish: 0, finalSuites: [] as string[], reviews: 0, current: 0, edits: 0 };
  const ports: LoopPorts = {
    async phase<T>(kind: string, id: string, input: Record<string, unknown>): Promise<T> {
      observed.phases.push(id);
      const retained = journal.admitPhase(id, input, { calls: 1 });
      if (retained.status === 'completed') { if (kind === 'investigation') observed.investigations.push(structuredClone(input)); return retained.result as T; }
      let result: Investigation | Synthesis | Review;
      if (kind === 'investigation') {
        observed.investigations.push(structuredClone(input));
        result = { hypotheses: [{ id: `hypothesis-${observed.investigations.length}`, rank: 1, mechanism: 'The controlled result differs from its requirement.', evidence: ['control evidence'], contradictions: [], predictions: ['A check will discriminate the candidate.'] }],
          experiment: { kind: 'http', rationale: 'Control experiment', predictions: ['A check result is retained.'], requests: [{ path: '/quote' }] }, unresolvedIntent: [], disposition: 'investigate' };
      } else if (kind === 'synthesis') result = { edits: [{ path: 'src/app.ts', content: `export const result = ${observed.investigations.length};` }], rationale: 'Scripted control candidate', changedCapabilities: [], changedResources: [] };
      else {
        observed.reviews++;
        const eligible = observed.reviews > (options.reviewFailures ?? 0);
        result = { eligible, findings: eligible ? [] : ['Independent control reviewer rejected this candidate'], remainingUncertainty: [], risk: 'low' };
      }
      journal.finishPhase(id, 'completed', result);
      return result as T;
    },
    async build(candidate, operation) {
      const builtSource = options.staleBuild && !operation.endsWith('.baseline.build') ? initial : candidate;
      if(options.failedBuildBaseline&&operation.endsWith('.baseline.build'))return {source:builtSource,imageDigest:'',evidence:'observed-build-failure',status:'failed'};
      return { source: builtSource, imageDigest: `sha256:${sha256(builtSource.tree)}`, evidence: 'build-evidence', status: 'passed' };
    },
    async check(built, operation, final) {
      if (operation.endsWith('.baseline.check')) return { authority: 'independent', changedCapabilities: [], changedResources: [], criteria: options.emptyBaseline ? [] : options.failedBuildBaseline ? [criterion('build','failed'),criterion('business','inconclusive'),criterion('live','inconclusive')] : [criterion('business', 'failed'), criterion('live', 'passed')], evidence: 'baseline-result', tests: 'development-v1', environment: 'environment-v1' };
      if (final) {
        const tests = options.reusedFinal ? 'reused-final-suite' : `fresh-final-${observed.finalSuites.length + 1}`;
        observed.finalSuites.push(tests);
        return { authority: 'independent', changedCapabilities: [], changedResources: [], finalFresh: true, criteria: [criterion('independent-final', observed.finalSuites.length <= (options.finalFailures ?? 0) ? 'failed' : 'passed')], evidence: `final-${observed.finalSuites.length}`, tests, environment: 'environment-v1' };
      }
      return { authority: 'independent', changedCapabilities: [], changedResources: [], criteria: [criterion('business', observed.edits <= (options.candidateFailures ?? 0) ? 'failed' : 'passed'), criterion('live', 'passed')], evidence: `candidate-${observed.edits}`, tests: 'development-v1', environment: 'environment-v1' };
    },
    async experiment() { return { status: 'failed', transport: 'COMPLETED', observation: 'A failing experimental result is usable evidence.' }; },
    async edit() { return source(`candidate-${++observed.edits}`); },
    async current() { observed.current++; return { baseCommit: options.staleAt && observed.current >= options.staleAt ? 'b'.repeat(40) : incident.baseCommit, targetRevision: incident.targetRevision }; },
    async trial() { observed.trial++; if (options.cancelDuringTrial) journal.cancel('cancellation during trial observation'); return { recovered: true, evidence: 'isolated-control-trial', observation: { fixture: true } }; },
    async publish() { observed.publish++; return { mode: 'archive', status: 'retained' }; },
  };
  return { get journal() { return journal; }, incident, ports, observed, reopen: () => { journal.close(); journal = new Journal(directory, 'loop-control', { ...DEFAULT_BUDGET, candidates: 3 }); }, run: () => new Controller(journal, ports).run(incident), close: () => { journal.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function safeResult(run: () => Promise<Record<string, unknown>>): Promise<unknown> { try { return await run(); } catch (error) { return error; } }

test('failed candidate leads to a new investigation with counterexamples and then a useful revision', async () => {
  const f = fixture({ candidateFailures: 1 });
  try {
    const result = await f.run(); assert.equal(result.outcome, 'verified_recovery');
    assert.equal(f.observed.edits, 2); assert.equal(f.observed.investigations.length, 2);
    assert.notEqual(f.observed.investigations[0]?.sourceTree, f.observed.investigations[1]?.sourceTree);
    assert.match(JSON.stringify(f.observed.investigations[1]?.measurements), /candidate-1|failed/);
    assert.equal(f.observed.trial, 1); assert.equal(f.observed.publish, 1);
    assert.equal(f.journal.events().filter(e => e.type === 'verification' && e.data.eligible === false).length, 1);
  } finally { f.close(); }
});
test('independent review rejection continues investigation instead of terminating the incident', async () => {
  const f = fixture({ reviewFailures: 1 });
  try {
    assert.equal((await f.run()).outcome, 'verified_recovery');
    assert.equal(f.observed.reviews, 2); assert.equal(f.observed.trial, 1);
    assert.match(JSON.stringify(f.observed.investigations[1]?.measurements), /reviewer rejected/);
  } finally { f.close(); }
});
test('a disclosed final counterexample returns to development and a fresh final suite can establish eligibility', async () => {
  const f = fixture({ finalFailures: 1 });
  try {
    assert.equal((await f.run()).outcome, 'verified_recovery');
    assert.deepEqual(f.observed.finalSuites, ['fresh-final-1', 'fresh-final-2']);
    assert.match(JSON.stringify(f.observed.investigations[1]?.measurements), /final-disclosed/);
    assert.equal(f.journal.events().filter(e => e.type === 'evaluation.exposure').length, 1);
    assert.equal(f.observed.trial, 1);
  } finally { f.close(); }
});
test('a source revision change after checks blocks trial and publication', async () => {
  const f = fixture({ staleAt: 3 });
  try { await safeResult(f.run); assert.equal(f.observed.trial, 0); assert.equal(f.observed.publish, 0); }
  finally { f.close(); }
});
test('a stale build source cannot borrow the current candidate identity', async () => {
  const f = fixture({ staleBuild: true });
  try { await safeResult(f.run); assert.equal(f.observed.trial, 0, 'trial must reject a build of another source'); assert.equal(f.observed.publish, 0); }
  finally { f.close(); }
});
test('a disclosed final suite cannot be called untouched on a later candidate', async () => {
  const f = fixture({ finalFailures: 1, reusedFinal: true });
  try { await safeResult(f.run); assert.equal(f.observed.trial, 0, 'fresh controlled final evaluation required after disclosure'); assert.equal(f.observed.publish, 0); }
  finally { f.close(); }
});
test('cancellation during trial blocks the subsequent publication effect', async () => {
  const f = fixture({ cancelDuringTrial: true });
  try { await safeResult(f.run); assert.equal(f.observed.trial, 1); assert.equal(f.observed.publish, 0, 'publication requires a fresh cancellation/current-target check'); }
  finally { f.close(); }
});
test('empty baseline measurements cannot establish no repair required', async () => {
  const f = fixture({ emptyBaseline: true });
  try { const result = await safeResult(f.run); assert.notEqual((result as Record<string, unknown>).outcome, 'no_repair_required'); }
  finally { f.close(); }
});

test('process restart reaches the same unknown phase to reconcile without resetting its budget', async () => {
  const f = fixture();
  const phase = f.ports.phase;
  let loseResponse = true;
  f.ports.phase = async <T>(kind: 'investigation' | 'synthesis' | 'review', id: string, input: Record<string, unknown>): Promise<T> => {
    if (kind === 'investigation' && loseResponse) {
      loseResponse = false;
      f.journal.admitPhase(id, input, { calls: 1 });
      f.journal.finishPhase(id, 'unknown', { cause: 'injected transport loss in a controller control test' });
      throw new Error('injected lost phase response');
    }
    return phase<T>(kind, id, input);
  };
  try {
    await assert.rejects(f.run(), /injected lost phase/);
    const used = f.journal.budget().used.calls;
    f.reopen();
    await assert.rejects(f.run(), /Unknown effect/, 'an unresolved phase must block new work until a retained receipt exists');
    assert.equal(f.journal.budget().used.calls, used);
    f.ports.recover = async () => {
      // Simulated retained host receipt, not a fresh model call or another phase identity.
      const pending = f.journal.db.prepare("SELECT id FROM phases WHERE status='unknown'").all();
      assert.equal(pending.length, 1); assert.equal(pending[0]?.id, 'loop-control.i0.investigation');
      const retainedHostResult: Investigation = { hypotheses: [{ id: 'retained-control', rank: 1, mechanism: 'Control result differs from requirement', evidence: ['retained-host-receipt'], contradictions: [], predictions: ['A check distinguishes candidate behaviour'] }], experiment: { kind: 'http', rationale: 'Retained control experiment', predictions: ['Retain a result'], requests: [{ path: '/quote' }] }, unresolvedIntent: [], disposition: 'investigate' };
      f.journal.finishPhase(String(pending[0]!.id), 'completed', retainedHostResult);
    };
    const result = await f.run();
    assert.equal(result.outcome, 'verified_recovery');
    assert.equal(f.journal.budget().used.calls, used + 2, 'same phase admission must not be charged twice');
    assert.equal(f.observed.publish, 1);
  } finally { f.close(); }
});

test('incident budgets aggregate within one persistent workflow scope across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mas-workflow-control-'));
  const limits = { ...DEFAULT_BUDGET, calls: 3 };
  const first = new Journal(directory, 'case-one', limits);
  first.reserveBudget('one-phase', { calls: 2 }); first.close();
  const second = new Journal(directory, 'case-two', limits);
  try {
    second.reserveBudget('two-phase', { calls: 1 });
    assert.equal(second.budget().used.calls, 1);
    assert.equal(second.budget('workflow').used.calls, 3);
    assert.throws(() => second.reserveBudget('additional-phase', { calls: 1 }), /workflow calls budget exhausted/);
    assert.equal(second.budget().used.calls, 1, 'failed workflow reservation must roll back incident charge');
  } finally { second.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a known baseline build failure proceeds to source repair while unexecuted HTTP criteria remain inconclusive', async () => {
  const f=fixture({failedBuildBaseline:true});
  try {
    assert.equal((await f.run()).outcome,'verified_recovery');
    assert.equal(f.observed.investigations.length,1);
    const measured=JSON.stringify(f.observed.investigations[0]?.measurements);
    assert.match(measured,/inconclusive/); assert.match(measured,/failed/);
    assert.equal(f.observed.trial,1); assert.equal(f.observed.publish,1);
  } finally {f.close();}
});
