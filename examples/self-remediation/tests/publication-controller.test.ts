import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Publication, recoverPublicationReceipt, type PublisherReceipt } from '../controller/publication.js';
import { Journal } from '../controller/journal.js';
import { HostPhaseError } from '../host/phase.js';
import type { TrustedOperationOptions } from '../host/tool.js';
import type { PublishRequest } from '../scripts/publish.js';
import { canonical, sha256 } from '../deploy/effects.js';
import { externalCapabilities } from '../deploy/capabilities.js';
const rawSha = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'mas-publication-controller-')), journal = new Journal(directory, 'incident');
  journal.put('attempt', 'attempt'); t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
  const host = { binary: '/trusted/host', sdkRoot: '/trusted/sdk', stateDir: join(directory, 'host') };
  const request: PublishRequest = { journalDirectory: directory, incidentId: 'incident', operationId: 'incident.publish', attemptId: 'attempt',
    policy: { repository: 'owner/repo', baseBranch: 'main', allowedPathPrefix: 'application', mode: 'pull-request', target: 'operational', runId: 'run', requiredChecks: [], credentialKind: 'github-app' },
    candidate: { baseCommit: 'a'.repeat(40), candidateTreeSha256: 'b'.repeat(64), files: { 'application/main.ts': 'source' }, requirementsSha256: 'c'.repeat(64),
      testsSha256: 'd'.repeat(64), environmentSha256: 'e'.repeat(64), imageDigest: `repo@sha256:${'f'.repeat(64)}`,
      verification: { candidateTreeSha256: 'b'.repeat(64), mandatory: [{ id: 'independent', status: 'pass' }] } } };
  return { directory, journal, host, request };
}
class ControlledPublisher extends Publication {
  invocations: Array<{ id: string; envelope: Record<string, unknown>; options: TrustedOperationOptions }> = [];
  lose = false;
  protected override async execute(id: string, envelope: Record<string, unknown>, options: TrustedOperationOptions): Promise<PublisherReceipt> {
    this.invocations.push({ id, envelope, options });
    if (this.lose) { this.lose = false; throw new HostPhaseError('lost response control', id, null, true); }
    const request = JSON.parse(await readFile(String(envelope.requestFile), 'utf8')) as PublishRequest;
    assert.equal(sha256(request), envelope.requestSha256);
    return { operationId: id, invocation_id: 'effect-control', status: 'COMPLETED', result: {
      status: 'pull-request-created', candidateTreeSha256: request.candidate.candidateTreeSha256, imageDigest: request.candidate.imageDigest, pullRequest: 1,
    } };
  }
}
test('controller publication keeps source credentials in trusted publisher and resumes completed result without another effect', async t => {
  const s = await fixture(t); const saved = process.env.SELF_REMEDIATION_PUBLISH_TOKEN;
  process.env.SELF_REMEDIATION_PUBLISH_TOKEN = 'control-token'; t.after(() => { if (saved === undefined) delete process.env.SELF_REMEDIATION_PUBLISH_TOKEN; else process.env.SELF_REMEDIATION_PUBLISH_TOKEN = saved; });
  const publisher = new ControlledPublisher(s.journal, s.host);
  assert.equal((await publisher.publish(s.request.operationId, s.request)).status, 'pull-request-created');
  delete process.env.SELF_REMEDIATION_PUBLISH_TOKEN;
  assert.equal((await publisher.publish(s.request.operationId, s.request)).status, 'pull-request-created');
  assert.equal(publisher.invocations.length, 1);
  assert.deepEqual(Object.keys(publisher.invocations[0]!.options.environment!).sort(), ['SELF_REMEDIATION_PUBLISH_TOKEN', 'SELF_REMEDIATION_SOURCE_KUBECONFIG']);
  assert(!canonical(s.journal.events()).includes('control-token'));
  await assert.rejects(publisher.publish(s.request.operationId, { ...s.request, candidate: { ...s.request.candidate, imageDigest: 'changed' } }), /Frozen/);
});
test('absent publisher credential is an explicit unexecuted gate and cannot authorize automatic operational publication', async t => {
  const s = await fixture(t), saved = process.env.SELF_REMEDIATION_PUBLISH_TOKEN; delete process.env.SELF_REMEDIATION_PUBLISH_TOKEN;
  t.after(() => { if (saved !== undefined) process.env.SELF_REMEDIATION_PUBLISH_TOKEN = saved; });
  const publisher = new ControlledPublisher(s.journal, s.host), result = await publisher.publish(s.request.operationId, s.request);
  assert.equal(result.status, 'archived'); assert.match(result.unexecutedGate!, /credential-unavailable/); assert.equal(publisher.invocations.length, 0);
  await assert.rejects(publisher.publish(s.request.operationId, { ...s.request, policy: { ...s.request.policy, mode: 'automatic' } }), /disposable/);
});
test('unknown publication blocks a new phase and recovery uses the original frozen host operation', async t => {
  const s = await fixture(t), saved = process.env.SELF_REMEDIATION_PUBLISH_TOKEN; process.env.SELF_REMEDIATION_PUBLISH_TOKEN = 'control-token';
  t.after(() => { if (saved === undefined) delete process.env.SELF_REMEDIATION_PUBLISH_TOKEN; else process.env.SELF_REMEDIATION_PUBLISH_TOKEN = saved; });
  const publisher = new ControlledPublisher(s.journal, s.host); publisher.lose = true;
  await assert.rejects(publisher.publish(s.request.operationId, s.request), HostPhaseError);
  assert.throws(() => s.journal.admitPhase('another-run', {}, {}), /Unknown effect/);
  await publisher.recover();
  assert.deepEqual(publisher.invocations.map(item => item.id), [s.request.operationId, s.request.operationId]);
  assert.deepEqual(publisher.invocations[1]!.envelope, publisher.invocations[0]!.envelope);
  assert.equal(s.journal.budget().used.operations, 1);
});
test('response-loss recovery requires the actual completed publisher receipt and original command identity', async t => {
  const s = await fixture(t), id = s.request.operationId, project = join(s.host.stateDir, 'tool-projects', id);
  const commands: string[] = [], hostIdentity = { sourceRevision: 'pinned-control', binarySha256: 'a'.repeat(64) };
  const port = { identity: async () => hostIdentity, command: async (_binary: string, args: string[]) => {
    commands.push(args[0]!); if (args[0] === 'observe') return JSON.stringify(observation);
    if (args[0] === 'resolve') return '{}'; throw new Error('Unexpected host operation');
  } };
  assert.equal(await recoverPublicationReceipt(s.journal, s.host, id, s.request, port), false); assert.deepEqual(commands, []);
  await mkdir(join(project, '.mas/build'), { recursive: true });
  const input = { operationId: id, requestFile: join(s.directory, 'contexts', `publication-${sha256(id)}.json`), requestSha256: sha256(s.request) };
  const capability = externalCapabilities.find(item => item.id === 'publish')!, runtime = '// trusted control runtime';
  const config = { kind: 'command', identity: 'control' };
  await writeFile(join(project, 'broker.mjs'), runtime);
  await writeFile(join(project, '.mas/build/bundle.json'), JSON.stringify({ agents: [{ name: 'trusted_tool_broker', configuration: config }] }));
  await writeFile(join(project, 'identity.json'), JSON.stringify({ host: hostIdentity, operation: 'publish/1', input, inputSchema: capability.inputSchema, outputSchema: capability.outputSchema, runtime: rawSha(runtime) }));
  const receipt: PublisherReceipt = { operationId: id, invocation_id: 'effect-control', status: 'COMPLETED', result: { status: 'pull-request-created',
    candidateTreeSha256: s.request.candidate.candidateTreeSha256, imageDigest: s.request.candidate.imageDigest, pullRequest: 1 } };
  s.journal.put(`publisher-command-receipt:${id}`, { requestSha256: sha256(s.request), receipt });
  const observation = { run_id: id, calls: [{ id: receipt.invocation_id, actor: 'trusted_tool_broker' }], steps: [{ id: receipt.invocation_id,
    kind: 'effect', actor: 'trusted_tool_broker', state: 'unknown', input: { format: 'mas-command/2', input, configuration_sha256: rawSha(canonical(config)) } }] };
  await assert.rejects(recoverPublicationReceipt(s.journal, s.host, id, { ...s.request, attemptId: 'different' }, port), /conflicting/);
  assert.equal(await recoverPublicationReceipt(s.journal, s.host, id, s.request, port), true);
  assert.deepEqual(commands, ['observe', 'resolve']);
  const output = JSON.parse(await readFile(join(s.directory, 'reconciliation', id, receipt.invocation_id, 'output.json'), 'utf8'));
  assert.deepEqual(output, { status: 'completed', output: receipt });
});
