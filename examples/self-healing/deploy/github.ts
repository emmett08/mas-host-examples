import { createHash } from 'node:crypto';
import { effect, sha256, RejectedEffect, type EffectStore, type Json, type OperationIdentity, type Reconciliation } from './effects.js';
import type { IncidentGitManifest } from './source.js';

export interface GitHubTransport { request(method: string, path: string, body?: Json): Promise<any> }
export class GitHubHttpError extends Error {
  constructor(public status: number) { super(`GitHub API status ${status}`); }
}
/** Trusted publisher transport. Never pass an instance, token or response body into candidate execution. */
export class RestGitHub implements GitHubTransport {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {
    if (!token) throw new Error('Publication credential unavailable');
  }
  async request(method: string, path: string, body?: Json): Promise<any> {
    if (!path.startsWith('/repos/') || path.includes('..')) throw new Error('Invalid GitHub REST route');
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json',
        'content-type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new GitHubHttpError(response.status);
    if (response.status === 204) return null;
    const reader = response.body?.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
    if (reader) for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('GitHub result exceeds trusted publisher bound'); }
      parts.push(part.value);
    }
    const text = Buffer.concat(parts).toString('utf8');
    return JSON.parse(text);
  }
}
export interface PublicationPolicy {
  repository: string; baseBranch: string; allowedPathPrefix: string;
  mode: 'archive' | 'pull-request' | 'automatic';
  target: 'operational' | 'disposable-demo';
  runId: string;
  /** Exact trusted check name + owning GitHub App ID. Empty is forbidden in automatic mode. */
  requiredChecks: Array<{ name: string; appId: number }>;
  /** App token is required for unattended downstream PR CI; GITHUB_TOKEN cannot assert that. */
  credentialKind: 'none' | 'github-app' | 'github-token';
}
export interface CandidatePublication {
  baseCommit: string;
  candidateTreeSha256: string;
  files: Record<string, string | null>;
  requirementsSha256: string; testsSha256: string; environmentSha256: string;
  imageDigest: string;
  verification: { candidateTreeSha256: string; mandatory: Array<{ id: string; status: 'pass' | 'fail' | 'inconclusive' }> };
}
export interface PublicationResult {
  status: 'archived' | 'pull-request-created' | 'awaiting-checks' | 'merged' | 'merged-tree-changed';
  candidateTreeSha256: string; imageDigest: string;
  commit?: string; gitTree?: string; branch?: string; pullRequest?: number; url?: string; mergedCommit?: string;
}
export const treeIdentity = (files: Record<string, string | null>) => sha256(files);
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const gitBlob = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
function safePath(value: string): boolean { return /^[A-Za-z0-9_.\/-]+$/.test(value) && !value.split('/').some(p => p === '..' || p === '.' || !p) && !value.split('/').includes('.git'); }
function validatePolicy(policy: PublicationPolicy): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(policy.repository) || !/^[a-z0-9][a-z0-9-]{0,49}$/.test(policy.runId)
    || !safePath(policy.allowedPathPrefix.replace(/\/$/, '')) || !safePath(policy.baseBranch)) throw new Error('Invalid publication projection');
  if (policy.target === 'disposable-demo' && policy.baseBranch !== `demo/incidents/${policy.runId}`)
    throw new Error('Disposable repair PRs must target their exact faulty incident branch');
  if (policy.mode === 'automatic' && (policy.target !== 'disposable-demo' || !policy.requiredChecks.length || policy.credentialKind !== 'github-app'))
    throw new Error('Automatic publication requires disposable scope, explicit checks and a GitHub App credential');
  if (policy.requiredChecks.some(check => !check.name || !Number.isSafeInteger(check.appId) || check.appId < 1)
    || new Set(policy.requiredChecks.map(check => `${check.appId}:${check.name}`)).size !== policy.requiredChecks.length) throw new Error('Unique named checks and exact GitHub App owners required');
}
function validateCandidate(candidate: CandidatePublication, prefix: string): void {
  if (!sha.test(candidate.baseCommit) || ![candidate.candidateTreeSha256, candidate.requirementsSha256, candidate.testsSha256, candidate.environmentSha256].every(x => digest.test(x))
    || !/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(candidate.imageDigest)) throw new Error('Exact source, acceptance, environment and immutable image identities required');
  if (treeIdentity(candidate.files) !== candidate.candidateTreeSha256) throw new Error('Candidate bytes changed after verification');
  if (candidate.verification.candidateTreeSha256 !== candidate.candidateTreeSha256 || !candidate.verification.mandatory.length
    || candidate.verification.mandatory.some(gate => gate.status !== 'pass')) throw new Error('All current mandatory candidate gates must pass');
  const paths = Object.keys(candidate.files);
  if (!paths.length || paths.length > 200) throw new Error('Bounded nonempty candidate source required');
  for (const path of paths) if (!safePath(path) || !path.startsWith(`${prefix.replace(/\/$/, '')}/`)) throw new Error('Candidate change exceeds admitted path projection');
  if (JSON.stringify(candidate.files).length > 2 * 1024 * 1024) throw new Error('Candidate publication bound exceeded');
}
export class GitHubPublisher {
  private root: string;
  constructor(private github: GitHubTransport, private journal: EffectStore, readonly policy: PublicationPolicy) {
    validatePolicy(policy); this.root = `/repos/${policy.repository}`;
  }
  private id(parent: OperationIdentity, suffix: string): OperationIdentity { return { ...parent, operationId: `${parent.operationId}/${suffix}` }; }
  private target(): string { return `${this.policy.repository}:refs/heads/${this.policy.baseBranch}`; }
  private repairBranch(candidate: CandidatePublication): string { return `${this.policy.target === 'disposable-demo' ? 'demo' : 'mas'}/repairs/${this.policy.runId}-${candidate.candidateTreeSha256.slice(0, 12)}`; }
  private async optional(path: string): Promise<any | undefined> {
    try { return await this.github.request('GET', `${this.root}${path}`); }
    catch (error) { if (error instanceof GitHubHttpError && error.status === 404) return undefined; throw error; }
  }
  private async ref(branch: string): Promise<string | undefined> { return (await this.optional(`/git/ref/heads/${encodeURIComponent(branch)}`))?.object?.sha; }
  private async assertBase(expected: string): Promise<void> {
    if (await this.ref(this.policy.baseBranch) !== expected) throw new RejectedEffect('Stale base revision');
  }
  private async write(identity: OperationIdentity, kind: string, input: Json, path: string,
    reconcile: () => Promise<Reconciliation>, method = 'POST'): Promise<any> {
    return effect(this.journal, identity, kind, this.target(), input, async () => {
      try { return await this.github.request(method, `${this.root}${path}`, input); }
      catch (error) {
        if (error instanceof GitHubHttpError && [400, 401, 403, 404, 409, 422].includes(error.status)) throw new RejectedEffect(error.message);
        throw error;
      }
    }, reconcile);
  }
  /** Branch creation is create-only. A conflicting existing branch is never force-pushed. */
  private async createRef(identity: OperationIdentity, branch: string, commit: string): Promise<void> {
    const reconcile = async (): Promise<Reconciliation> => {
      const current = await this.ref(branch);
      return current === commit ? { status: 'completed', receipt: { ref: `refs/heads/${branch}`, object: { sha: commit } } }
        : current ? { status: 'rejected', receipt: { reason: 'Branch occupied by a different commit' } } : { status: 'unknown' };
    };
    const existing = await this.ref(branch);
    if (existing && existing !== commit) throw new RejectedEffect('Ref occupied; refusing to overwrite other work');
    await effect(this.journal, identity, 'github.create-ref', this.target(), { branch, commit }, async () => {
      if (existing === commit) return { ref: `refs/heads/${branch}`, object: { sha: commit } };
      const r = await this.github.request('POST', `${this.root}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit });
      return { ref: r.ref, object: { sha: r.object.sha } };
    }, reconcile);
  }
  /** Trusted benchmark setup calls this before agents start. No healthy source is returned. */
  async prepareIncident(identity: OperationIdentity, faultyCommit: string): Promise<{ baseCommit: string; baseBranch: string }> {
    if (this.policy.target !== 'disposable-demo' || !sha.test(faultyCommit)) throw new Error('Incident setup confined to explicit disposable target');
    await this.createRef(this.id(identity, 'incident-ref'), this.policy.baseBranch, faultyCommit);
    return { baseCommit: faultyCommit, baseBranch: this.policy.baseBranch };
  }
  async importIncident(identity: OperationIdentity, manifest: IncidentGitManifest): Promise<void> {
    if (this.policy.target !== 'disposable-demo' || manifest.version !== 'mas-incident-source/1'
      || manifest.prefix !== this.policy.allowedPathPrefix || !sha.test(manifest.faultyCommit) || !sha.test(manifest.parentCommit)
      || manifest.objects.length > 500) throw new Error('Incident Git import exceeds trusted scope');
    for (const object of manifest.objects) {
      if (!sha.test(object.sha) || !['blob', 'tree', 'commit'].includes(object.kind)) throw new Error('Invalid retained Git object');
      const path = `/git/${object.kind === 'tree' ? 'trees' : object.kind === 'commit' ? 'commits' : 'blobs'}`;
      const created = await this.write(this.id(identity, `incident-${object.kind}-${object.sha}`), `github.import-${object.kind}`, object.body,
        path, async () => {
          const found = await this.optional(`${path}/${object.sha}`);
          return found?.sha === object.sha ? { status: 'completed', receipt: { sha: found.sha } } : { status: 'unknown' };
        });
      if (created.sha !== object.sha) throw new Error('Imported Git object identity differs from frozen incident');
    }
    const imported = await this.github.request('GET', `${this.root}/git/commits/${manifest.faultyCommit}`);
    if (imported.tree?.sha !== manifest.gitTree || imported.parents?.[0]?.sha !== manifest.parentCommit) throw new Error('Faulty incident commit provenance mismatch');
    await this.prepareIncident(identity, manifest.faultyCommit);
  }
  async publish(identity: OperationIdentity, candidate: CandidatePublication): Promise<PublicationResult> {
    validateCandidate(candidate, this.policy.allowedPathPrefix);
    const common = { candidateTreeSha256: candidate.candidateTreeSha256, imageDigest: candidate.imageDigest };
    if (this.policy.mode === 'archive') return { status: 'archived', ...common };
    if (this.journal.get(this.id(identity, 'merge').operationId)) {
      const commit = this.journal.get(this.id(identity, 'commit').operationId)?.receipt as any;
      const tree = this.journal.get(this.id(identity, 'tree').operationId)?.receipt as any;
      const pr = this.journal.get(this.id(identity, 'pull-request').operationId)?.receipt as any;
      if (!commit?.sha || !tree?.sha || !pr?.number) throw new Error('Merge intent lacks its retained publication evidence');
      return this.merge(identity, candidate, { ...common, status: 'pull-request-created', commit: commit.sha, gitTree: tree.sha,
        branch: this.repairBranch(candidate), pullRequest: pr.number, url: pr.html_url });
    }
    await this.assertBase(candidate.baseCommit);
    const base = await this.github.request('GET', `${this.root}/git/commits/${candidate.baseCommit}`);
    if (base.sha !== candidate.baseCommit || !sha.test(base.tree?.sha)) throw new Error('Base commit identity unavailable');
    const entries: Json[] = [];
    for (const [path, content] of Object.entries(candidate.files).sort(([a], [b]) => a.localeCompare(b))) {
      if (content === null) { entries.push({ path, mode: '100644', type: 'blob', sha: null }); continue; }
      const expected = gitBlob(content);
      const blob = await this.write(this.id(identity, `blob-${expected}`), 'github.create-blob', { content, encoding: 'utf-8' }, '/git/blobs', async () => {
        const found = await this.optional(`/git/blobs/${expected}`);
        return found?.sha === expected ? { status: 'completed', receipt: { sha: expected } } : { status: 'unknown' };
      });
      if (blob.sha !== expected) throw new Error('GitHub blob differs from retained candidate');
      entries.push({ path, mode: '100644', type: 'blob', sha: expected });
    }
    // Tree writes are content-addressed but a lost response cannot be inferred from absence.
    // Keep unknown and require evidence-backed reconciliation instead of repeating POST.
    const tree = await this.write(this.id(identity, 'tree'), 'github.create-tree', { base_tree: base.tree.sha, tree: entries }, '/git/trees', async () => ({ status: 'unknown' }));
    if (!sha.test(tree.sha) || tree.sha === base.tree.sha) throw new RejectedEffect('Repair must produce a nonempty diff against the actual faulty base');
    const message = `MAS verified repair ${this.policy.runId}\n\nCandidate: ${candidate.candidateTreeSha256}\nOperation: ${identity.operationId}`;
    const commit = await this.write(this.id(identity, 'commit'), 'github.create-commit', { message, tree: tree.sha, parents: [candidate.baseCommit] }, '/git/commits', async () => ({ status: 'unknown' }));
    if (!sha.test(commit.sha) || commit.tree?.sha !== tree.sha) throw new Error('Commit candidate tree mismatch');
    await this.assertBase(candidate.baseCommit);
    const branch = this.repairBranch(candidate);
    await this.createRef(this.id(identity, 'repair-ref'), branch, commit.sha);
    const marker = `<!-- mas-operation:${identity.operationId} -->`;
    const input = { title: `Repair ${this.policy.runId}`, head: branch, base: this.policy.baseBranch,
      body: `${marker}\n\nGenerated repair for exact incident base \`${candidate.baseCommit}\`.\n\nCandidate: \`${candidate.candidateTreeSha256}\`\nRequirements: \`${candidate.requirementsSha256}\`\nTests: \`${candidate.testsSha256}\`\nEnvironment: \`${candidate.environmentSha256}\`\nImage: \`${candidate.imageDigest}\`\n\nEvery retained mandatory candidate gate passed. PR creation is distinct from merge and deployed recovery.`, draft: false };
    const reconcilePr = async (): Promise<Reconciliation> => {
      const prs = await this.github.request('GET', `${this.root}/pulls?state=all&head=${encodeURIComponent(this.policy.repository.split('/')[0] + ':' + branch)}&base=${encodeURIComponent(this.policy.baseBranch)}&per_page=100`);
      const matching = prs.filter((pr: any) => pr.head?.sha === commit.sha && pr.base?.ref === this.policy.baseBranch && pr.body?.includes(marker));
      return matching.length === 1 ? { status: 'completed', receipt: { number: matching[0].number, html_url: matching[0].html_url } } : { status: 'unknown' };
    };
    const pr = await this.write(this.id(identity, 'pull-request'), 'github.create-pr', input, '/pulls', reconcilePr);
    const result: PublicationResult = { ...common, status: 'pull-request-created', commit: commit.sha, gitTree: tree.sha, branch, pullRequest: pr.number, url: pr.html_url };
    if (this.policy.mode !== 'automatic') return result;
    return this.merge(identity, candidate, result);
  }
  async merge(identity: OperationIdentity, candidate: CandidatePublication, published: PublicationResult): Promise<PublicationResult> {
    validatePolicy(this.policy); validateCandidate(candidate, this.policy.allowedPathPrefix);
    if (this.policy.mode !== 'automatic' || !published.commit || !published.gitTree || !published.pullRequest) throw new Error('Automatic merge lacks retained publication identity');
    const mergeId = this.id(identity, 'merge');
    // Reconcile a previously dispatched merge before checking a base that the merge itself may have advanced.
    const reconcile = async (): Promise<Reconciliation> => {
      const pr = await this.github.request('GET', `${this.root}/pulls/${published.pullRequest}`);
      if (pr.merged && pr.head?.sha === published.commit && pr.base?.ref === this.policy.baseBranch && pr.merge_commit_sha)
        return { status: 'completed', receipt: { sha: pr.merge_commit_sha, merged: true } };
      return { status: 'unknown' };
    };
    if (!this.journal.get(mergeId.operationId)) {
      if ((await this.checkStatus(candidate, published)).status !== 'ready') return { ...published, status: 'awaiting-checks' };
    }
    const merged = await this.write(mergeId, 'github.merge', { sha: published.commit, merge_method: 'merge' }, `/pulls/${published.pullRequest}/merge`, reconcile, 'PUT');
    if (!merged.merged || !sha.test(merged.sha)) throw new Error('Merge outcome lacks authoritative commit');
    const commit = await this.github.request('GET', `${this.root}/git/commits/${merged.sha}`);
    // GitHub's merge API has a head precondition, not atomic base-SHA CAS. A raced base
    // can change the merged tree: retain it but require rebuild/reverification before promotion.
    return { ...published, mergedCommit: merged.sha, status: commit.tree?.sha === published.gitTree ? 'merged' : 'merged-tree-changed' };
  }
  async checkStatus(candidate: CandidatePublication, published: PublicationResult): Promise<{ status: 'ready' | 'awaiting-checks'; commit: string; pullRequest: number }> {
    validatePolicy(this.policy); validateCandidate(candidate, this.policy.allowedPathPrefix);
    if (this.policy.mode !== 'automatic' || !published.commit || !published.gitTree || !published.pullRequest) throw new Error('Required-check read lacks frozen publication');
    await this.assertBase(candidate.baseCommit);
    const checks = await this.github.request('GET', `${this.root}/commits/${published.commit}/check-runs?per_page=100`);
    if (checks.total_count > 100) throw new Error('Check result pagination exceeds frozen publication bound');
    const passing = this.policy.requiredChecks.every(required => {
      const matching = checks.check_runs.filter((check: any) => check.name === required.name && check.app?.id === required.appId && check.head_sha === published.commit)
        .sort((a: any, b: any) => (b.id ?? 0) - (a.id ?? 0));
      return matching[0]?.status === 'completed' && matching[0]?.conclusion === 'success';
    });
    const pr = await this.github.request('GET', `${this.root}/pulls/${published.pullRequest}`);
    if (pr.head?.sha !== published.commit || pr.base?.sha !== candidate.baseCommit || pr.base?.ref !== this.policy.baseBranch || pr.state !== 'open') throw new RejectedEffect('Stale PR target or candidate');
    return { status: passing ? 'ready' : 'awaiting-checks', commit: published.commit, pullRequest: published.pullRequest };
  }
}
