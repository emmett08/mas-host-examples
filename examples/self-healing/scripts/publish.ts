import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Journal } from '../controller/journal.js';
import { GitHubPublisher, RestGitHub, type CandidatePublication, type PublicationPolicy, type PublicationResult } from '../deploy/github.js';
import { effect, RejectedEffect, sha256, type Json, type OperationIdentity } from '../deploy/effects.js';
import type { IncidentGitManifest } from '../deploy/source.js';
import type { ImageArchive } from '../deploy/image.js';
import type { TrialSpec, HttpCriterion } from '../deploy/trial.js';
import { KubectlTransport } from '../deploy/trial.js';
import { observeOperationalTarget, type OperationalTargetGrant, type OperationalBinding } from '../deploy/operational.js';
export interface PublishRequest {
  journalDirectory: string; incidentId: string; operationId: string; attemptId: string;
  policy: PublicationPolicy; candidate: CandidatePublication;
  action?: 'publish' | 'checks' | 'merge'; published?: PublicationResult;
  /** Trusted setup already created the faulty Git object; this exposes only its incident branch. */
  setupFaultyCommit?: string;
  incidentGit?: IncidentGitManifest;
  promotion?: { imageArchive: ImageArchive; spec: TrialSpec; criteria: HttpCriterion[] };
  operationalTarget?: OperationalTargetGrant; operationalBinding?: OperationalBinding;
}
export async function publishMain(input: PublishRequest, invocationId: string): Promise<unknown> {
  if (!invocationId || !input.operationId || !input.attemptId) throw new Error('Host-admitted invocation and application operation identities required');
  const journal = Journal.open(input.journalDirectory, input.incidentId);
  const identity: OperationIdentity = { operationId: input.operationId, invocationId, attemptId: input.attemptId };
  const completed = (result: unknown) => {
    const receipt = { operationId: identity.operationId, invocation_id: invocationId, status: 'COMPLETED', result };
    journal.put(`publisher-command-receipt:${identity.operationId}`, { requestSha256: sha256(input), receipt });
    return receipt;
  };
  try {
    const github = new RestGitHub(input.policy.mode === 'archive' ? 'unused-in-archive' : process.env.SELF_REMEDIATION_PUBLISH_TOKEN ?? '');
    const publisher = new GitHubPublisher(github, journal, input.policy);
    if (input.policy.target === 'operational' && input.policy.mode !== 'archive') {
      if (!input.operationalTarget || !input.operationalBinding || input.operationalTarget.sourceCommit !== input.candidate.baseCommit)
        throw new RejectedEffect('Operational publication requires the retained source-bound deployed target');
      const observed = await observeOperationalTarget(new KubectlTransport(process.env.SELF_REMEDIATION_SOURCE_KUBECONFIG ?? process.env.KUBECONFIG ?? ''), input.operationalTarget, input.operationalBinding);
      journal.append('operational.publication-precondition', { ...observed, operationId: identity.operationId, invocationId });
    }
    if ((!input.action || input.action === 'publish') && input.incidentGit && input.policy.mode !== 'archive') {
      if (input.incidentGit.faultyCommit !== input.candidate.baseCommit) throw new Error('Candidate does not bind the actual faulty incident commit');
      await publisher.importIncident(identity, input.incidentGit);
    } else if ((!input.action || input.action === 'publish') && input.setupFaultyCommit && input.policy.mode !== 'archive') await publisher.prepareIncident(identity, input.setupFaultyCommit);
    let result: unknown;
    if (input.action === 'checks') {
      if (!input.published) throw new Error('Frozen publication required');
      result = await effect(journal, identity, 'github.read-required-checks', `${input.policy.repository}:pull:${input.published.pullRequest}`,
        { candidate: input.candidate.candidateTreeSha256, commit: input.published.commit!, pullRequest: input.published.pullRequest!, requiredChecks: input.policy.requiredChecks } as Json,
        async () => await publisher.checkStatus(input.candidate, input.published!) as Json, async () => ({ status: 'unknown' }));
    } else if (input.action === 'merge') {
      if (!input.published) throw new Error('Frozen publication required');
      result = await publisher.merge(identity, input.candidate, input.published);
    } else result = await publisher.publish(identity, input.candidate);
    journal.append('github.outcome', { ...result as object, operationId: identity.operationId, invocationId });
    return completed(result);
  } catch (error) {
    if (error instanceof RejectedEffect) return completed({ status: 'rejected', reason: error.message });
    throw error;
  } finally { journal.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--invocation');
  const invocation = index >= 0 ? process.argv[index + 1] : undefined;
  if (!invocation) throw new Error('--invocation must be supplied by the maintained host adapter');
  const envelope = JSON.parse(readFileSync(0, 'utf8')) as PublishRequest & { requestFile?: string; requestSha256?: string };
  const input = envelope.requestFile ? JSON.parse(readFileSync(envelope.requestFile, 'utf8')) as PublishRequest : envelope;
  if (envelope.requestFile && (sha256(input) !== envelope.requestSha256 || input.operationId !== envelope.operationId)) throw new Error('Retained publication request changed');
  process.stdout.write(`${JSON.stringify(await publishMain(input, invocation))}\n`);
}
