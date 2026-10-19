import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Deployment } from '../controller/deployment.js';
import { Journal } from '../controller/journal.js';
import type { Built, Source } from '../controller/loop.js';
import type { Verification } from '../contracts/types.js';
import type { BuildResult } from '../sandbox/executor.js';
import type { TrialSpec, TargetSnapshot } from '../deploy/trial.js';
const source = (letter: string): Source => ({ tree: letter.repeat(64), files: { 'src/main.ts': letter }, ref: `sha256:${letter.repeat(64)}` });
const image = 'sha256:' + 'f'.repeat(64), ref = 'docker.io/library/test@sha256:' + 'e'.repeat(64);
const built = (letter: string): Built => ({ source: source(letter), imageDigest: image, status: 'passed', evidence: 'sha256:' + '1'.repeat(64) });
const report = (letter: string): Verification => ({ identity: { baseCommit: 'a'.repeat(40), sourceTree: source('a').tree, candidateTree: source(letter).tree,
  patch: 'patch', requirements: '1'.repeat(64), tests: '2'.repeat(64), environment: '3'.repeat(64), configuration: 'config', imageDigest: image },
  evaluator: 'protected', evaluatorVersion: '1', criteria: [], regressions: [], changedCapabilities: [], changedResources: [], remainingUncertainty: [],
  operationalRisk: 0, unnecessaryChange: 0, costMicroUsd: 0, authority: 'independent', exposure: 'development' });
class FakeDeployment extends Deployment {
  operations: Array<{ id: string; request: any }> = []; external = new Map<string, unknown>(); version = 1; failObservationOnce = false;
  latest?: TargetSnapshot;
  override async operation<T>(id: string, request: any): Promise<T> {
    this.operations.push({ id, request: structuredClone(request) });
    if (this.external.has(id)) return this.external.get(id) as T;
    let result: any;
    if (request.operation === 'import') result = { imageDigest: ref, configDigest: image, manifestDigest: ref.split('@')[1] };
    else if (request.operation === 'establish' || request.operation === 'replace') {
      const spec: TrialSpec = request.spec;
      result = this.latest = { namespace: spec.namespace, name: spec.deployment, owner: spec.owner, uid: 'uid', resourceVersion: String(this.version++), imageDigest: spec.imageDigest, candidateTreeSha256: spec.candidateTreeSha256 };
    } else if (request.operation === 'observe') {
      if (this.failObservationOnce) { this.failObservationOnce = false; throw new Error('Controller interrupted before observation'); }
      result = { status: request.spec.candidateTreeSha256 === source('b').tree ? 'fail' : 'pass', binding: request.spec, observedAt: 'now', target: this.latest,
        criteria: [], diagnostics: { pods: '', events: '', logs: '', resources: '' } };
    } else if (request.operation === 'current') result = this.latest;
    else throw new Error('Unexpected operation');
    this.external.set(id, result); return result as T;
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mas-deploy-restart-')); const journal = new Journal(directory, 'incident');
  journal.put('attempt', 'attempt-1');
  const deployment = new FakeDeployment(journal, { binary: '/unused', sdkRoot: '/unused', stateDir: directory }, 'run', []);
  return { journal, deployment, cleanup: async () => { journal.close(); await rm(directory, { recursive: true, force: true }); } };
}
test('baseline and failed-trial replay preserve latest candidate target and original mutation precondition', async () => {
  const { journal, deployment, cleanup } = await fixture();
  try {
    const raw = { imageDigest: image, identity: { baseCommit: 'a'.repeat(40) } } as BuildResult;
    await deployment.baseline(source('a'), raw, '1'.repeat(64), '2'.repeat(64), '3'.repeat(64));
    const original = journal.value<TargetSnapshot>('baseline-target')!;
    deployment.failObservationOnce = true;
    await assert.rejects(deployment.trial(built('b'), report('b'), original.resourceVersion), /interrupted/);
    const first = deployment.operations.find(op => op.request.operation === 'replace')!;
    assert.equal((await deployment.trial(built('b'), report('b'), original.resourceVersion)).recovered, false);
    const replacements = deployment.operations.filter(op => op.request.operation === 'replace');
    assert.deepEqual(replacements[1]!.request.expected, first.request.expected);
    const latest = journal.events().filter(event => event.type === 'trial.target').at(-1)!.data.target;
    const count = deployment.operations.length;
    await deployment.baseline(source('a'), raw, '1'.repeat(64), '2'.repeat(64), '3'.repeat(64));
    await deployment.trial(built('b'), report('b'), original.resourceVersion);
    assert.equal(deployment.operations.length, count, 'completed failed observations replay without new commands');
    assert.deepEqual(journal.events().filter(event => event.type === 'trial.target').at(-1)!.data.target, latest);
    assert.equal((await deployment.trial(built('c'), report('c'), original.resourceVersion)).recovered, true);
    assert.equal(await deployment.current(), original.resourceVersion);
  } finally { await cleanup(); }
});
test('a completed build failure has no fabricated Pod and first verified candidate creates the trial', async () => {
  const { journal, deployment, cleanup } = await fixture();
  try {
    const revision = deployment.recordBuildFailure(source('a'), '1'.repeat(64), '2'.repeat(64), '3'.repeat(64), 'sha256:' + '4'.repeat(64));
    assert.equal(await deployment.current(), revision); assert.equal(journal.value('baseline-target'), undefined);
    assert.equal(deployment.operations.length, 0);
    assert.equal((await deployment.trial(built('c'), report('c'), revision)).recovered, true);
    assert(deployment.operations.some(op => op.request.operation === 'establish'));
    assert(!deployment.operations.some(op => op.request.operation === 'replace'));
    assert.equal(await deployment.current(), revision);
  } finally { await cleanup(); }
});
test('a successful retained trial gets fresh protected observations before replay can claim current recovery', async () => {
  const { journal, deployment, cleanup } = await fixture();
  try {
    const revision=deployment.recordBuildFailure(source('a'),'1'.repeat(64),'2'.repeat(64),'3'.repeat(64),'build-failure');
    assert.equal((await deployment.trial(built('c'),report('c'),revision)).recovered,true);
    const mutations=deployment.operations.filter(op=>['replace','establish'].includes(op.request.operation)).length;
    assert.equal((await deployment.trial(built('c'),report('c'),revision)).recovered,true);
    assert(deployment.operations.some(op=>op.id.includes('fresh-observe')));
    assert.equal(deployment.operations.filter(op=>['replace','establish'].includes(op.request.operation)).length,mutations);
    assert.equal(journal.events().filter(event=>event.type==='trial.refreshed').length,1);
  } finally {await cleanup();}
});
