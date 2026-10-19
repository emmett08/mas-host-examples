/** Separate, credential-free promotion job. No GitHub/provider credential enters this job. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Journal } from '../controller/journal.js';
import { writeImmutableFile } from '../controller/immutable-file.js';
import { runTrustedOperation } from '../host/tool.js';
import { externalReceiptSchema } from '../deploy/capabilities.js';
import { canonical, sha256 } from '../deploy/effects.js';
import type { ImportedImage } from '../deploy/image.js';
import type { PublishRequest } from './publish.js';
import type { TrialRequest } from './trial.js';
import { assertWorkflowIncident } from './workflow-identity.js';
const argument = (name: string) => { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing ${name}`); return resolve(process.argv[i + 1]!); };
const input = argument('--input'), publication = argument('--publication'), output = argument('--output');
async function locate(root: string, name: string): Promise<string> {
  const matches: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error('Archive nesting exceeds bound');
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('Archive symlink rejected');
      const path = join(directory, item.name);
      if (item.isDirectory()) await visit(path, depth + 1);
      else if (item.isFile() && item.name === name) matches.push(path);
    }
  };
  await visit(root, 0);
  if (matches.length !== 1) throw new Error(`Exactly one ${name} is required`);
  return matches[0]!;
}
const manifest = JSON.parse(await readFile(await locate(input, 'publication-manifest.json'), 'utf8')) as PublishRequest;
const identity = assertWorkflowIncident(manifest.incidentId);
const rawReceipt = JSON.parse(await readFile(await locate(publication, 'publication-receipt.json'), 'utf8'));
const published = rawReceipt.receipt?.result ?? rawReceipt.result;
if (published?.status !== 'merged' || published.candidateTreeSha256 !== manifest.candidate.candidateTreeSha256
  || published.imageDigest !== manifest.candidate.imageDigest) throw new Error('Exact tested tree must be merged before promotion; changed tree requires rebuild/reverification');
if (!manifest.promotion || manifest.promotion.spec.imageDigest !== manifest.candidate.imageDigest
  || manifest.promotion.spec.requirementsSha256 !== manifest.candidate.requirementsSha256
  || manifest.promotion.spec.testsSha256 !== manifest.candidate.testsSha256
  || manifest.promotion.spec.environmentSha256 !== manifest.candidate.environmentSha256) throw new Error('Retained image/protected verification projection missing or changed');
const imageArchive = { ...manifest.promotion.imageArchive, path: await locate(input, 'candidate-image.json') };
await mkdir(output, { recursive: true, mode: 0o700 });
const runId = `${identity.runId}-promotion`;
const directory = join(output, 'journal'); const journal = new Journal(directory, runId);
journal.put('merged-publication', published); journal.put('promotion-manifest', manifest.promotion); journal.close();
const here = dirname(fileURLToPath(import.meta.url)), repository = resolve(here, '../../..');
const runtimeBundle = join(output, 'trusted-trial.mjs');
await build({ entryPoints: [join(here, 'trial.ts')], outfile: runtimeBundle, bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['node:*'] });
let counter = 0;
async function run(operation: TrialRequest['operation'], fields: Partial<TrialRequest>): Promise<any> {
  const id = `${runId}-${++counter}`;
  const request: TrialRequest = { journalDirectory: directory, incidentId: runId, operationId: `${id}/${operation}`, attemptId: runId, operation, ...fields };
  const requestFile = join(output, `request-${counter}.json`); writeImmutableFile(requestFile, canonical(request));
  const outcome = await runTrustedOperation({ binary: process.env.MAS_HOST_BIN ?? join(repository, '.tools/mas-host/target/debug/mas-host'),
    sdkRoot: process.env.MAS_SDK_ROOT ?? join(repository, '.tools/mas-host'), stateDir: join(output, 'host') }, id,
    { operationId: request.operationId, requestFile, requestSha256: sha256(request) }, {
      runtimeBundle, operationName: 'trial/1', timeoutMs: 300000, outputBytes: 32768,
      environment: { KUBECONFIG: process.env.KUBECONFIG ?? join(process.env.HOME ?? '', '.kube/config') },
      inputSchema: { type: 'object', required: ['operationId', 'requestFile', 'requestSha256'], properties: {
        operationId: { type: 'string' }, requestFile: { type: 'string' }, requestSha256: { type: 'string' } }, additionalProperties: false },
      outputSchema: externalReceiptSchema,
    });
  await writeFile(join(output, `receipt-${counter}.json`), JSON.stringify(outcome), { mode: 0o600 });
  return (outcome.receipt as any).result;
}
try {
  await run('load', { imageArchive });
  const imported = await run('import', { imageConfigDigest: imageArchive.configDigest }) as ImportedImage;
  if (imported.imageDigest !== manifest.candidate.imageDigest) throw new Error('Restored image manifest identity changed');
  const spec = { ...manifest.promotion.spec, namespace: identity.namespace,
    owner: runId, runId: runId.slice(0, 50), stage: 'promotion' as const };
  const target = await run('establish', { spec });
  if (target.status === 'rejected') throw new Error('Promotion target rejected');
  const initial = await run('observe', { spec, criteria: manifest.promotion.criteria });
  await new Promise(resolve => setTimeout(resolve, 5000));
  const afterwards = await run('observe', { spec, criteria: manifest.promotion.criteria });
  const result = { status: initial.status === 'pass' && afterwards.status === 'pass' ? 'deployed-recovery-verified' : 'promotion-not-verified',
    mergedCommit: published.mergedCommit, gitTree: published.gitTree, imported, target, initial, afterwards,
    scope: 'fresh disposable stateless k3s deployment; no shared data or schema writes' };
  const observations=Journal.open(directory,runId);
  observations.append('deployment.recovery',result);
  observations.close();
  await writeFile(join(output, 'promotion-receipt.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  if (result.status !== 'deployed-recovery-verified') process.exitCode = 1;
} finally {
  const retained = Journal.open(directory, runId); retained.checkpoint(); retained.close();
}
