/** Publisher credentials and retained candidate bytes enter only the trusted publisher process. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Journal, Boundary } from './journal.js';
import { HostPhaseError, hostCommand, pinnedHostIdentity, type HostConfiguration } from '../host/phase.js';
import { runTrustedOperation, type TrustedOperationOptions } from '../host/tool.js';
import { externalCapabilities } from '../deploy/capabilities.js';
import { canonical, sha256, UnknownEffect } from '../deploy/effects.js';
import type { PublicationResult } from '../deploy/github.js';
import type { PublishRequest } from '../scripts/publish.js';

export type PublicationOutcome = PublicationResult & { unexecutedGate?: string };
export interface PublisherReceipt { operationId: string; invocation_id: string; status: 'COMPLETED'; result: PublicationResult | { status: 'rejected'; reason: string } }
const rawSha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Recover response loss only when the original trusted process retained its complete receipt.
 * Partial GitHub operations without this receipt require external reconciliation and stay blocked. */
export async function recoverPublicationReceipt(journal: Journal, host: HostConfiguration, id: string, request: PublishRequest,
  port = { command: hostCommand, identity: pinnedHostIdentity }): Promise<boolean> {
  const retained = journal.value<{ requestSha256: string; receipt: PublisherReceipt }>(`publisher-command-receipt:${id}`);
  if (!retained) return false;
  const receipt = retained.receipt;
  if (retained.requestSha256 !== sha256(request) || receipt.operationId !== id || receipt.status !== 'COMPLETED'
    || !/^[A-Za-z0-9._:-]{1,160}$/.test(receipt.invocation_id)) throw new Error('Publisher receipt has conflicting frozen identity');
  if (journal.db.prepare("SELECT id FROM effects WHERE json_extract(record,'$.status') IN ('intended','unknown') LIMIT 1").get()) return false;
  const project = join(resolve(host.stateDir), 'tool-projects', id), capability = externalCapabilities.find(item => item.id === 'publish')!;
  const identity = JSON.parse(readFileSync(join(project, 'identity.json'), 'utf8'));
  const expected = { operationId: id, requestFile: join(resolve(journal.directory), 'contexts', `publication-${sha256(id)}.json`), requestSha256: sha256(request) };
  if (canonical(identity.host) !== canonical(await port.identity(host)) || identity.operation !== 'publish/1'
    || canonical(identity.input) !== canonical(expected) || canonical(identity.inputSchema) !== canonical(capability.inputSchema)
    || canonical(identity.outputSchema) !== canonical(capability.outputSchema) || rawSha(readFileSync(join(project, 'broker.mjs'))) !== identity.runtime)
    throw new Error('Publisher host, runtime, schema or command identity changed');
  const observation = JSON.parse(await port.command(host.binary, ['observe', '--state', host.stateDir, '--run', id, '--include-payloads', 'true']));
  const effect = observation.steps?.find((step: any) => step.kind === 'effect' && step.id === receipt.invocation_id);
  const bundle = readFileSync(join(project, '.mas/build/bundle.json'));
  const actor = JSON.parse(bundle.toString()).agents?.find((item: any) => item.name === 'trusted_tool_broker');
  if (observation.run_id !== id || !effect || effect.actor !== 'trusted_tool_broker' || effect.input?.format !== 'mas-command/2'
    || canonical(effect.input.input) !== canonical(expected) || !actor?.configuration
    || rawSha(canonical(actor.configuration)) !== effect.input.configuration_sha256
    || !observation.calls?.some((call: any) => call.id === receipt.invocation_id && call.actor === effect.actor))
    throw new Error('Publisher receipt does not bind the original admitted command');
  const wrapper = { status: 'completed', output: receipt };
  if (['completed', 'resolved'].includes(effect.state)) {
    if (canonical(effect.output) !== canonical(wrapper)) throw new Error('Host retains a conflicting publisher outcome');
    return true;
  }
  if (!['unknown', 'executing'].includes(effect.state)) return false;
  const proof = { version: 'self-remediation-publication-reconciliation/1', incidentId: journal.incidentId, operationId: id,
    invocation_id: receipt.invocation_id, authority: 'original trusted publisher completed receipt', requestSha256: retained.requestSha256,
    receiptSha256: sha256(receipt), bundleSha256: rawSha(bundle), host: identity.host };
  const directory = join(resolve(journal.directory), 'reconciliation', id, receipt.invocation_id); mkdirSync(directory, { recursive: true });
  const immutable = (name: string, value: unknown) => {
    const path = join(directory, name), bytes = canonical(value);
    try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o400 }); }
    catch (error: any) { if (error.code !== 'EEXIST' || readFileSync(path, 'utf8') !== bytes) throw new Error('Conflicting publisher reconciliation proof'); }
    return path;
  };
  const output = immutable('output.json', wrapper), evidence = immutable('evidence.json', proof);
  await port.command(host.binary, ['resolve', '--state', host.stateDir, '--run', id, '--effect', receipt.invocation_id, '--output', output, '--evidence', evidence]);
  journal.append('effect.reconciled', { operationId: id, invocationId: receipt.invocation_id, evidence: journal.artefacts.put(proof) });
  return true;
}
export class Publication {
  constructor(readonly journal: Journal, readonly host: HostConfiguration) {}
  /** Injectable only through trusted application composition, never agent discovery. */
  protected async execute(id: string, envelope: Record<string, unknown>, options: TrustedOperationOptions): Promise<PublisherReceipt> {
    return (await runTrustedOperation<PublisherReceipt>(this.host, id, envelope, options)).receipt;
  }
  private async dispatch(id: string, input: PublishRequest): Promise<PublicationResult> {
    const capability = externalCapabilities.find(item => item.id === 'publish')!;
    const directory = join(resolve(this.journal.directory), 'contexts'); mkdirSync(directory, { recursive: true });
    const requestFile = join(directory, `publication-${sha256(id)}.json`), bytes = canonical(input);
    try { writeFileSync(requestFile, bytes, { flag: 'wx', mode: 0o400 }); }
    catch (error: any) { if (error.code !== 'EEXIST' || readFileSync(requestFile, 'utf8') !== bytes) throw new Error('Frozen publication request changed'); }
    const environment: Record<string, string> = { SELF_REMEDIATION_PUBLISH_TOKEN: process.env.SELF_REMEDIATION_PUBLISH_TOKEN ?? '' };
    if (input.policy.target === 'operational') environment.SELF_REMEDIATION_SOURCE_KUBECONFIG = process.env.SELF_REMEDIATION_SOURCE_KUBECONFIG ?? process.env.KUBECONFIG ?? '';
    try {
      const receipt = await this.execute(id, { operationId: id, requestFile, requestSha256: sha256(input) }, {
        runtimeBundle: resolve('dist-tools/publisher.mjs'), inputSchema: capability.inputSchema, outputSchema: capability.outputSchema,
        operationName: 'publish/1', timeoutMs: capability.timeoutMs, outputBytes: capability.outputBytes, environment,
      });
      if (receipt.operationId !== id || !receipt.invocation_id || receipt.status !== 'COMPLETED') throw new Error('Publisher receipt does not bind the admitted operation');
      const unresolved = this.journal.db.prepare("SELECT id FROM effects WHERE json_extract(record,'$.status') IN ('intended','unknown') LIMIT 1").get();
      if (unresolved) throw new UnknownEffect(String(unresolved.id));
      this.journal.put(`publication-receipt:${id}`, receipt);
      this.journal.finishPhase(id, 'completed', receipt.result);
      if (receipt.result.status === 'rejected') throw new Boundary('stale_revision_target', receipt.result.reason);
      return receipt.result;
    } catch (error) {
      if (!(error instanceof Boundary)) this.journal.finishPhase(id,
        error instanceof UnknownEffect || error instanceof HostPhaseError && error.uncertain ? 'unknown' : 'failed',
        { message: error instanceof Error ? error.message : 'Publisher failed' });
      throw error;
    }
  }
  async publish(id: string, request: PublishRequest): Promise<PublicationOutcome> {
    if (request.operationId !== id || request.incidentId !== this.journal.incidentId
      || resolve(request.journalDirectory) !== resolve(this.journal.directory)
      || request.attemptId !== this.journal.value('attempt')) throw new Error('Publication request differs from the owning controller');
    if (request.policy.mode === 'automatic' && request.policy.target !== 'disposable-demo') throw new Boundary('policy_boundary', 'Automatic publication is limited to explicit disposable demo targets');
    const previous = this.journal.db.prepare('SELECT status FROM phases WHERE id=? AND incident=?').get(id, this.journal.incidentId);
    // Do not fabricate a dispatched phase or a GitHub outcome when credentials are absent.
    if (!previous && (request.policy.mode === 'archive' || !process.env.SELF_REMEDIATION_PUBLISH_TOKEN)) {
      this.journal.assertActive();
      const result: PublicationOutcome = { status: 'archived', candidateTreeSha256: request.candidate.candidateTreeSha256,
        imageDigest: request.candidate.imageDigest,
        ...(request.policy.mode !== 'archive' ? { unexecutedGate: 'github-publication:scoped-publisher-credential-unavailable' } : {}) };
      this.journal.append('github.outcome', { ...result, operationId: id }); return result;
    }
    this.journal.put(`publication:${id}`, request);
    const admitted = this.journal.admitPhase(id, { capability: 'publish/1', request }, { operations: 1 });
    if (admitted.status === 'completed') {
      const receipt = this.journal.value<PublisherReceipt>(`publication-receipt:${id}`);
      if (!receipt || receipt.result.status === 'rejected') throw new Boundary('stale_revision_target', receipt?.result.status === 'rejected' ? receipt.result.reason : 'Completed publisher receipt unavailable');
      return receipt.result;
    }
    return this.dispatch(id, request);
  }
  /** Same retained host run only. Without a completed/resolved host receipt it stays unknown. */
  async recover(): Promise<void> {
    const pending = this.journal.db.prepare("SELECT id FROM phases WHERE status IN ('running','unknown') ORDER BY rowid").all();
    for (const row of pending) {
      const id = String(row.id), request = this.journal.value<PublishRequest>(`publication:${id}`);
      if (request) { await recoverPublicationReceipt(this.journal, this.host, id, request); await this.dispatch(id, request); }
    }
  }
}
