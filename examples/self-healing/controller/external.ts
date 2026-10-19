/** Shared envelope composition for externally authorised read operations. */
import { mkdirSync } from 'node:fs';
import { writeImmutableFile } from './immutable-file.js';
import { join, resolve } from 'node:path';
import { Journal, Boundary } from './journal.js';
import { HostPhaseError, type HostConfiguration } from '../host/phase.js';
import { runTrustedOperation } from '../host/tool.js';
import { externalCapabilities } from '../deploy/capabilities.js';
import { canonical, sha256 } from '../deploy/effects.js';
import type { GitHubReadGrant } from '../tools/github-mcp.js';
import type { OperationalBinding, OperationalTargetGrant } from '../deploy/operational.js';

type ReadKind = 'github_metadata' | 'operational_observe';
interface FrozenRead { kind: ReadKind; input: Record<string, unknown> }
export class ExternalReads {
  constructor(readonly journal: Journal, readonly host: HostConfiguration) {}
  private async dispatch<T>(id: string, frozen: FrozenRead): Promise<T> {
    const capability = externalCapabilities.find(item => item.id === frozen.kind)!;
    const requestFile = join(resolve(this.journal.directory), 'contexts', `external-${sha256(id)}.json`);
    mkdirSync(join(resolve(this.journal.directory), 'contexts'), { recursive: true });
    writeImmutableFile(requestFile, canonical(frozen.input));
    const envelope = { operationId: id, requestFile, requestSha256: sha256(frozen.input) };
    const environment: Record<string, string> = frozen.kind === 'github_metadata'
      ? { SELF_REMEDIATION_GITHUB_READ_TOKEN: process.env.SELF_REMEDIATION_GITHUB_READ_TOKEN ?? '' }
      : { KUBECONFIG: process.env.SELF_REMEDIATION_SOURCE_KUBECONFIG ?? process.env.KUBECONFIG ?? '' };
    try {
      const completed = await runTrustedOperation<{ operationId: string; invocation_id: string; status: string; result: T & { status?: string; reason?: string } }>(this.host, id, envelope, {
        runtimeBundle: resolve(`dist-tools/${frozen.kind === 'github_metadata' ? 'github' : 'trial'}.mjs`),
        inputSchema: capability.inputSchema, outputSchema: capability.outputSchema,
        operationName: `${frozen.kind}/1`, timeoutMs: capability.timeoutMs, outputBytes: capability.outputBytes, environment,
      });
      this.journal.finishPhase(id, 'completed', completed.receipt.result);
      this.journal.append(frozen.kind === 'github_metadata' ? 'github.metadata' : 'operational.binding', {
        operationId: id, invocationId: completed.receipt.invocation_id, result: completed.receipt.result,
      });
      if (completed.receipt.result.status === 'rejected') throw new Boundary('stale_revision_target', completed.receipt.result.reason);
      return completed.receipt.result;
    } catch (error) {
      if (!(error instanceof Boundary)) this.journal.finishPhase(id, error instanceof HostPhaseError && error.uncertain ? 'unknown' : 'failed',
        { message: error instanceof Error ? error.message : 'External read failed' });
      throw error;
    }
  }
  private async read<T>(id: string, kind: ReadKind, request: Record<string, unknown>): Promise<T> {
    const input = { journalDirectory: resolve(this.journal.directory), incidentId: this.journal.incidentId,
      operationId: id, attemptId: this.journal.value<string>('attempt')!, ...request };
    const frozen = { kind, input }; this.journal.put(`external:${id}`, frozen);
    const admitted = this.journal.admitPhase(id, { kind, input }, { operations: 1 });
    if (admitted.status === 'completed') {
      const result = admitted.result as T & { status?: string; reason?: string };
      if (result.status === 'rejected') throw new Boundary('stale_revision_target', result.reason);
      return result;
    }
    return this.dispatch<T>(id, frozen);
  }
  async github(id: string, grant: GitHubReadGrant): Promise<Record<string, unknown>> { return this.read(id, 'github_metadata', { grant }); }
  async operational(id: string, grant: OperationalTargetGrant, previous?: OperationalBinding): Promise<OperationalBinding> {
    return this.read(id, 'operational_observe', { operation: 'operational-observe', operationalTarget: grant, ...(previous ? { previousOperationalBinding: previous } : {}) });
  }
  async recover(): Promise<void> {
    const pending = this.journal.db.prepare("SELECT id FROM phases WHERE status IN ('running','unknown') ORDER BY rowid").all();
    for (const row of pending) {
      const id = String(row.id), frozen = this.journal.value<FrozenRead>(`external:${id}`);
      if (frozen) await this.dispatch(id, frozen);
    }
  }
}
