import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Journal } from '../controller/journal.js';
import { RejectedEffect, sha256, type OperationIdentity } from '../deploy/effects.js';
import { importK3dImage, exportImage, loadImage, imageCommand, runImageCommand, type ImageArchive, type ImageCommandDiagnostic } from '../deploy/image.js';
import { KubectlTransport, KubernetesTrial, type HttpCriterion, type TargetSnapshot, type TrialSpec } from '../deploy/trial.js';
import { observeOperationalTarget, type OperationalTargetGrant, type OperationalBinding } from '../deploy/operational.js';

export interface TrialRequest {
  journalDirectory: string; incidentId: string; operationId: string; attemptId: string;
  operation: 'import' | 'export' | 'load' | 'establish' | 'replace' | 'observe' | 'current' | 'operational-observe';
  imageConfigDigest?: string; archivePath?: string; imageArchive?: ImageArchive; cluster?: string; spec?: TrialSpec; expected?: TargetSnapshot; criteria?: HttpCriterion[];
  operationalTarget?: OperationalTargetGrant; previousOperationalBinding?: OperationalBinding;
}
export async function trialMain(input: TrialRequest, invocationId: string): Promise<unknown> {
  if (!invocationId || !input.operationId || !input.attemptId) throw new Error('Host-admitted invocation and application operation identities required');
  const journal = Journal.open(input.journalDirectory, input.incidentId);
  const identity: OperationIdentity = { operationId: input.operationId, invocationId, attemptId: input.attemptId };
  const transport = () => new KubectlTransport(process.env.KUBECONFIG ?? '', 'kubectl', diagnostic => {
    const evidence = journal.artefacts.put(diagnostic);
    journal.append('tool.diagnostic', { operationId: identity.operationId, invocationId, tool: 'kubectl', evidence,
      exitCode: diagnostic.exitCode, externalOutcome: diagnostic.externalOutcome });
  });
  const imageDiagnostic = (diagnostic: ImageCommandDiagnostic) => {
    const evidence = journal.artefacts.put(diagnostic);
    journal.append('tool.diagnostic', { operationId: identity.operationId, invocationId, tool: diagnostic.tool, evidence,
      exitCode: diagnostic.exitCode, signal: diagnostic.signal, externalOutcome: diagnostic.externalOutcome });
  };
  const imageExecutor = (executable: string, args: string[], timeout?: number) => imageCommand(executable, args, timeout, imageDiagnostic);
  const archiveExecutor = { command: imageExecutor, stream: (executable: string, args: string[], options: Parameters<typeof runImageCommand>[2]) =>
    runImageCommand(executable, args, { ...options, onDiagnostic: imageDiagnostic }) };
  try {
    let result: unknown;
    if (input.operation === 'import') result = await importK3dImage(journal, identity, input.imageConfigDigest!, input.cluster, imageExecutor);
    else if (input.operation === 'export') result = await exportImage(journal, identity, input.imageConfigDigest!, input.archivePath!, archiveExecutor);
    else if (input.operation === 'load') result = await loadImage(journal, identity, input.imageArchive!, archiveExecutor);
    else if (input.operation === 'operational-observe') {
      if (!input.operationalTarget) throw new Error('Frozen operational target grant required');
      result = await observeOperationalTarget(transport(), input.operationalTarget, input.previousOperationalBinding);
      journal.append('operational.binding', { ...result as object, operationId: identity.operationId, invocationId });
    } else {
      const trial = new KubernetesTrial(transport(), journal);
      if (!input.spec) throw new Error('Frozen trial specification required');
      switch (input.operation) {
        case 'current': result = await trial.current(input.spec); journal.append('trial.target', { ...result as object, operationId: identity.operationId, invocationId }); break;
        case 'establish': result = await trial.establish(identity, input.spec); break;
        case 'replace': if (!input.expected) throw new Error('Current target precondition required'); result = await trial.replace(identity, input.spec, input.expected); break;
        case 'observe': {
          const observed = await trial.observe(input.spec, input.criteria ?? []);
          const diagnosticsRef = journal.artefacts.put(observed.diagnostics);
          const { diagnostics: _, ...summary } = observed;
          result = { ...summary, diagnosticsRef };
          journal.append('trial.observed', { ...summary, diagnosticsRef, operationId: identity.operationId, invocationId });
          break;
        }
        default: throw new Error('Unregistered trial operation');
      }
    }
    return { operationId: identity.operationId, invocation_id: invocationId, status: 'COMPLETED', result };
  } catch (error) {
    if (error instanceof RejectedEffect) return { operationId: identity.operationId, invocation_id: invocationId, status: 'COMPLETED', result: { status: 'rejected', reason: error.message } };
    throw error;
  } finally { journal.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--invocation');
  const invocation = index >= 0 ? process.argv[index + 1] : undefined;
  if (!invocation) throw new Error('--invocation must be supplied by the maintained host adapter');
  const envelope = JSON.parse(readFileSync(0, 'utf8')) as TrialRequest & { requestFile?: string; requestSha256?: string };
  const input = envelope.requestFile ? JSON.parse(readFileSync(envelope.requestFile, 'utf8')) as TrialRequest : envelope;
  if (envelope.requestFile && (sha256(input) !== envelope.requestSha256 || input.operationId !== envelope.operationId)) throw new Error('Retained trial request changed');
  process.stdout.write(`${JSON.stringify(await trialMain(input, invocation))}\n`);
}
