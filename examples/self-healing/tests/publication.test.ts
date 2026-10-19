import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effect, UnknownEffect, RejectedEffect, sha256, type EffectStore, type EffectRecord, type Json } from '../deploy/effects.js';
import { GitHubPublisher, GitHubHttpError, treeIdentity, type CandidatePublication, type GitHubTransport, type PublicationPolicy } from '../deploy/github.js';
import { KubernetesTrial, type KubernetesTransport, type TrialSpec } from '../deploy/trial.js';
import { OfficialGitHubMcp } from '../tools/github-mcp.js';
import { freezeIncidentSource } from '../deploy/source.js';
class Store implements EffectStore {
  records = new Map<string, EffectRecord>();
  get(id: string) { return this.records.get(id); }
  unresolved(target: string) { return [...this.records.values()].filter(r => r.target === target && ['intended', 'unknown'].includes(r.status)); }
  intend(record: EffectRecord) { assert(!this.records.has(record.operationId)); assert.equal(this.unresolved(record.target).length, 0); this.records.set(record.operationId, record); }
  settle(id: string, status: EffectRecord['status'], receipt?: Json) { this.records.set(id, { ...this.records.get(id)!, status, ...(receipt === undefined ? {} : { receipt }) }); }
}
const original = 'a'.repeat(40), tree = 'b'.repeat(40), commit = 'c'.repeat(40), merged = 'd'.repeat(40);
const identity = { operationId: 'incident-1/publish', invocationId: 'actual-host-effect-7', attemptId: 'process-1' };
const files = { 'examples/self-healing/target-app/src/service.ts': 'export const tax = 20;\n' };
const candidate: CandidatePublication = { baseCommit: original, candidateTreeSha256: treeIdentity(files), files,
  requirementsSha256: '1'.repeat(64), testsSha256: '2'.repeat(64), environmentSha256: '3'.repeat(64),
  imageDigest: `registry.invalid/app@sha256:${'4'.repeat(64)}`,
  verification: { candidateTreeSha256: treeIdentity(files), mandatory: [{ id: 'business', status: 'pass' }] } };
const policy: PublicationPolicy = { repository: 'owner/repo', baseBranch: 'demo/incidents/run-1', allowedPathPrefix: 'examples/self-healing/target-app',
  mode: 'pull-request', target: 'disposable-demo', runId: 'run-1', credentialKind: 'github-app', requiredChecks: [{ name: 'protected-contract', appId: 123 }] };
class GitHub implements GitHubTransport {
  refs = new Map([[policy.baseBranch, original]]); prs: any[] = []; writes: string[] = []; lose = ''; mergeTree = tree;
  checkRuns: any[] = [{ id: 1, name: 'protected-contract', app: { id: 123 }, head_sha: commit, status: 'completed', conclusion: 'success' }];
  async request(method: string, path: string, body?: any): Promise<any> {
    const suffix = path.replace('/repos/owner/repo', '');
    if (method === 'GET') {
      if (suffix.startsWith('/git/ref/heads/')) {
        const value = this.refs.get(decodeURIComponent(suffix.slice('/git/ref/heads/'.length)));
        if (!value) throw new GitHubHttpError(404);
        return { object: { sha: value } };
      }
      if (suffix === `/git/commits/${original}`) return { sha: original, tree: { sha: 'e'.repeat(40) } };
      if (suffix === `/git/commits/${merged}`) return { sha: merged, tree: { sha: this.mergeTree } };
      if (suffix.startsWith('/pulls?')) return this.prs;
      if (suffix === '/pulls/1') return this.prs[0];
      if (suffix.startsWith('/commits/')) return { total_count: this.checkRuns.length, check_runs: this.checkRuns };
      throw new Error(`Unexpected GET ${suffix}`);
    }
    this.writes.push(suffix);
    let result: any;
    if (suffix === '/git/blobs') result = { sha: createHash('sha1').update(`blob ${Buffer.byteLength(body.content)}\0`).update(body.content).digest('hex') };
    else if (suffix === '/git/trees') result = { sha: tree };
    else if (suffix === '/git/commits') result = { sha: commit, tree: { sha: tree } };
    else if (suffix === '/git/refs') { this.refs.set(body.ref.replace('refs/heads/', ''), body.sha); result = { ref: body.ref, object: { sha: body.sha } }; }
    else if (suffix === '/pulls') {
      result = { number: 1, html_url: 'https://github.com/owner/repo/pull/1', body: body.body, state: 'open', head: { sha: commit }, base: { ref: body.base, sha: original } };
      this.prs.push(result);
    } else if (suffix === '/pulls/1/merge') {
      assert.equal(body.sha, commit); this.refs.set(policy.baseBranch, merged);
      Object.assign(this.prs[0], { merged: true, merge_commit_sha: merged }); result = { merged: true, sha: merged };
    } else throw new Error(`Unexpected write ${suffix}`);
    if (this.lose === suffix) { this.lose = ''; throw new Error('Connection lost after server committed'); }
    return result;
  }
}
test('real repair publication contains an exact changed tree and is create-only', async () => {
  const api = new GitHub(), journal = new Store();
  const publisher = new GitHubPublisher(api, journal, policy);
  const first = await publisher.publish(identity, candidate);
  assert.equal(first.status, 'pull-request-created'); assert.equal(first.gitTree, tree);
  const count = api.writes.length;
  assert.deepEqual(await publisher.publish(identity, candidate), first); assert.equal(api.writes.length, count);
  assert.equal(journal.get(`${identity.operationId}/pull-request`)?.invocationId, identity.invocationId);
  assert(!api.writes.some(path => path.startsWith('/git/refs/')));
});
for (const suffix of ['/git/refs', '/pulls']) test(`lost ${suffix} reply reconciles without repeating mutation`, async () => {
  const api = new GitHub(), journal = new Store(); api.lose = suffix;
  const publisher = new GitHubPublisher(api, journal, policy);
  await assert.rejects(publisher.publish(identity, candidate), UnknownEffect);
  const writes = api.writes.filter(x => x === suffix).length;
  const observed = await publisher.publish(identity, candidate);
  assert.equal(observed.status, 'pull-request-created'); assert.equal(api.writes.filter(x => x === suffix).length, writes);
});
test('lost merge reply reconciles after base advanced and changed merge tree blocks reuse', async () => {
  const api = new GitHub(), journal = new Store(); api.lose = '/pulls/1/merge'; api.mergeTree = 'f'.repeat(40);
  const publisher = new GitHubPublisher(api, journal, { ...policy, mode: 'automatic' });
  await assert.rejects(publisher.publish(identity, candidate), UnknownEffect);
  const outcome = await publisher.publish(identity, candidate);
  assert.equal(outcome.status, 'merged-tree-changed'); assert.equal(outcome.mergedCommit, merged);
  assert.equal(api.writes.filter(x => x === '/pulls/1/merge').length, 1);
});
test('stale source, changed candidate and inconclusive protected check block publication', async () => {
  const api = new GitHub(); api.refs.set(policy.baseBranch, 'f'.repeat(40));
  const publisher = new GitHubPublisher(api, new Store(), policy);
  await assert.rejects(publisher.publish(identity, candidate), /Stale base/);
  await assert.rejects(publisher.publish(identity, { ...candidate, files: { ...files, 'examples/self-healing/target-app/new.ts': 'x' } }), /changed after verification/);
  await assert.rejects(publisher.publish(identity, { ...candidate, verification: { ...candidate.verification, mandatory: [{ id: 'business', status: 'inconclusive' }] } }), /mandatory/);
  assert.equal(api.writes.length, 0);
});
test('automatic operational merge and injected main target are refused', () => {
  assert.throws(() => new GitHubPublisher(new GitHub(), new Store(), { ...policy, mode: 'automatic', target: 'operational', baseBranch: 'main' }), /disposable scope/);
  assert.throws(() => new GitHubPublisher(new GitHub(), new Store(), { ...policy, baseBranch: 'main' }), /faulty incident/);
});
test('a newer failed check supersedes success, then a separate admitted merge can follow fresh checks', async () => {
  const api = new GitHub(), journal = new Store(); api.checkRuns.push({ ...api.checkRuns[0], id: 2, conclusion: 'failure' });
  const publisher = new GitHubPublisher(api, journal, { ...policy, mode: 'automatic' });
  const published = await publisher.publish(identity, candidate);
  assert.equal(published.status, 'awaiting-checks'); assert.equal(api.writes.filter(x => x.endsWith('/merge')).length, 0);
  api.checkRuns.push({ ...api.checkRuns[0], id: 3 });
  assert.equal((await publisher.checkStatus(candidate, published)).status, 'ready');
  const next = { operationId: 'incident-1/merge-only', invocationId: 'actual-new-host-effect-8', attemptId: identity.attemptId };
  assert.equal((await publisher.merge(next, candidate, published)).status, 'merged');
  assert.equal(journal.get(`${next.operationId}/merge`)?.invocationId, next.invocationId);
});
test('an unresolved effect blocks a new phase/operation and changed host invocation', async () => {
  const store = new Store(); let dispatched = 0;
  await assert.rejects(effect(store, identity, 'write', 'target', {}, async () => { dispatched++; throw new Error('lost'); }, async () => ({ status: 'unknown' })), UnknownEffect);
  await assert.rejects(effect(store, { ...identity, operationId: 'new-phase' }, 'write', 'target', {}, async () => { dispatched++; return {}; }, async () => ({ status: 'unknown' })), UnknownEffect);
  await assert.rejects(effect(store, { ...identity, invocationId: 'new-invocation' }, 'write', 'target', {}, async () => ({}), async () => ({ status: 'unknown' })), /identity reused/);
  assert.equal(dispatched, 1);
});
test('trial rejects stale resource version and reconciles lost patch using operation and invocation', async () => {
  const spec: TrialSpec = { namespace: 'mas-repair-run-1', deployment: 'service', owner: 'owner', runId: 'run-1', imageDigest: candidate.imageDigest,
    candidateTreeSha256: candidate.candidateTreeSha256, requirementsSha256: candidate.requirementsSha256, testsSha256: candidate.testsSha256,
    environmentSha256: candidate.environmentSha256, configuration: { PORT: '8080' }, port: 8080, stage: 'candidate' };
  let dep: any = { metadata: { name: 'service', namespace: spec.namespace, uid: 'pod-1', resourceVersion: '2', annotations: { 'mas.dev/owner': 'owner' } }, spec: { template: { spec: { containers: [{ image: `registry.invalid/app@sha256:${'9'.repeat(64)}` }] } } } };
  let patches = 0;
  const kube = { get: async () => dep, patch: async (_kind: string, _name: string, _ns: string, patch: any[]) => {
    patches++; assert(patch.some(p => p.op === 'test' && p.path === '/metadata/resourceVersion'));
    dep = structuredClone(dep); dep.metadata.resourceVersion = '3'; dep.metadata.annotations = patch.find(p => p.path === '/metadata/annotations').value;
    dep.spec.template.spec.containers[0].image = spec.imageDigest;
    throw new Error('Lost response');
  } } as unknown as KubernetesTransport;
  const before = { namespace: spec.namespace, name: spec.deployment, uid: 'pod-1', resourceVersion: '1', owner: 'owner', imageDigest: dep.spec.template.spec.containers[0].image, candidateTreeSha256: '9'.repeat(64) };
  await assert.rejects(new KubernetesTrial(kube, new Store()).replace(identity, spec, before), RejectedEffect);
  const trial = new KubernetesTrial(kube, new Store()); before.resourceVersion = '2';
  await assert.rejects(trial.replace(identity, spec, before), UnknownEffect);
  assert.equal((await trial.replace(identity, spec, before)).imageDigest, spec.imageDigest);
  assert.equal(patches, 1);
});
test('official GitHub MCP permits only frozen run metadata and removes source/log fields', async () => {
  const inputSchema = { type: 'object', properties: { method: { type: 'string' } } };
  const calls: any[] = [];
  const fetcher = (async (_url: any, init: any) => {
    const request = JSON.parse(init.body); calls.push(request);
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = request.method === 'initialize' ? { serverInfo: { name: 'github-mcp-server' } }
      : request.method === 'tools/list' ? { tools: [{ name: 'actions_get', inputSchema }, { name: 'search_code', inputSchema: {} }] }
      : { content: [{ type: 'text', text: JSON.stringify({ id: 123, head_sha: original, status: 'completed', conclusion: 'failure', event: 'workflow_dispatch', logs: 'secret', repository: { source: 'solution' } }) }] };
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  }) as typeof fetch;
  const client = new OfficialGitHubMcp('token', { repository: 'owner/repo', workflowRunId: '123', workflowSourceRevision: original,
    toolSchemaSha256: sha256({ name: 'actions_get', inputSchema }), evidenceSetting: 'blind' }, fetcher);
  await client.initialise();
  const result = await client.readWorkflowRun();
  assert.equal(result.sourceRevision, original); assert(!JSON.stringify(result).includes('secret')); assert(!JSON.stringify(result).includes('solution'));
  assert.equal(calls.at(-1).params.name, 'actions_get'); assert.equal(calls.at(-1).params.arguments.method, 'get_workflow_run');
  const drifted = new OfficialGitHubMcp('token', { repository: 'owner/repo', workflowRunId: '123', workflowSourceRevision: original,
    toolSchemaSha256: '0'.repeat(64), evidenceSetting: 'blind' }, fetcher);
  await assert.rejects(drifted.initialise(), /frozen schema mismatch/);
});
test('faulty incident object manifest preserves exact commit bytes and never changes the repository ref', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mas-source-publication-'));
  try {
    const repo = join(directory, 'repository'), snapshot = join(directory, 'snapshot');
    await mkdir(repo); await mkdir(snapshot);
    execFileSync('git', ['init', '-q', repo]);
    await writeFile(join(repo, 'protected.txt'), 'must remain outside candidate projection\n');
    execFileSync('git', ['-C', repo, 'add', 'protected.txt']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base']);
    const parent = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await writeFile(join(snapshot, 'service.ts'), 'export const total = 0;\n');
    const manifest = await freezeIncidentSource(repo, parent, snapshot, 'examples/self-healing/target-app', join(directory, 'retained'), '2026-10-18T09:00:00.000Z');
    assert.notEqual(manifest.faultyCommit, parent); assert.equal(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), parent);
    const body = manifest.objects.at(-1)!.body as any;
    const epoch = Math.floor(new Date(body.author.date).getTime() / 1000);
    const raw = `tree ${body.tree}\nparent ${parent}\nauthor ${body.author.name} <${body.author.email}> ${epoch} +0000\ncommitter ${body.committer.name} <${body.committer.email}> ${epoch} +0000\n\n${body.message}`;
    assert.equal(createHash('sha1').update(`commit ${Buffer.byteLength(raw)}\0`).update(raw).digest('hex'), manifest.faultyCommit);
    assert.equal(manifest.objects.filter(x => x.kind === 'blob').length, 1, 'protected source bytes never enter the manifest');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
