/** Manual-workflow publisher. Downloaded bytes are data, and are never executed. */
import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { runTrustedOperation } from '../host/tool.js';
import { Journal } from '../controller/journal.js';
import { writeImmutableFile } from '../controller/immutable-file.js';
import { canonical, sha256 } from '../deploy/effects.js';
import type { PublicationPolicy } from '../deploy/github.js';
import type { PublishRequest } from './publish.js';
const arg = (key: string) => { const i = process.argv.indexOf(key); if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing ${key}`); return resolve(process.argv[i + 1]!); };
const inputRoot = arg('--input'), output = arg('--output');
await mkdir(output, { recursive: true, mode: 0o700 });
const matches: string[] = [];
async function find(directory: string, depth = 0): Promise<void> {
  if (depth > 8) throw new Error('Publication archive nesting exceeds bound');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Publication archive contains a symbolic link');
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await find(path, depth + 1);
    else if (entry.isFile() && entry.name === 'publication-manifest.json') matches.push(path);
  }
}
await find(inputRoot);
if (matches.length !== 1) throw new Error('Exactly one verified publication-manifest.json is required');
const text = await readFile(matches[0]!, 'utf8');
if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Publication manifest exceeds bound');
const retained = JSON.parse(text) as PublishRequest;
if (!retained.incidentGit || retained.incidentGit.faultyCommit !== retained.candidate?.baseCommit
  || retained.incidentGit.parentCommit !== process.env.GITHUB_SHA) throw new Error('Retained incident must bind the exact trusted workflow source');
const runId = `run-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
const mode = process.env.SELF_REMEDIATION_PUBLICATION ?? 'pull-request';
if (!['pull-request', 'automatic'].includes(mode)) throw new Error('Publication job requires explicit scoped publication mode');
const policy: PublicationPolicy = { repository: process.env.GITHUB_REPOSITORY ?? '', baseBranch: `demo/incidents/${runId}`,
  allowedPathPrefix: 'examples/self-healing/target-app', mode: mode as PublicationPolicy['mode'], target: 'disposable-demo', runId,
  requiredChecks: JSON.parse(process.env.SELF_REMEDIATION_REQUIRED_CHECKS ?? '[]'), credentialKind: 'github-app' };
const request: PublishRequest = { journalDirectory: join(output, 'journal'), incidentId: runId,
  operationId: `${runId}/publication`, attemptId: `runner-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  policy, candidate: retained.candidate, incidentGit: retained.incidentGit };
const journal = new Journal(request.journalDirectory, request.incidentId);
journal.put('trusted-publication-policy', policy); journal.put('publication-manifest', request); journal.close();
const runtimeBundle = join(output, 'trusted-publisher.mjs');
const here = dirname(fileURLToPath(import.meta.url));
await build({ entryPoints: [join(here, 'publish.ts')], outfile: runtimeBundle, bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['node:*'] });
const sourceRoot = resolve(here, '../../..');
// The host carries one small content-addressed file reference, not source blobs in a wire frame.
async function execute(next: PublishRequest, suffix: string) {
  const requestFile = join(output, `publisher-request-${suffix}.json`);
  writeImmutableFile(requestFile, canonical(next));
  const envelope = { operationId: next.operationId, requestFile, requestSha256: sha256(next) };
  return runTrustedOperation({ binary: process.env.MAS_HOST_BIN ?? join(sourceRoot, '.tools/mas-host/target/debug/mas-host'),
    sdkRoot: process.env.MAS_SDK_ROOT ?? join(sourceRoot, '.tools/mas-host'), stateDir: join(output, 'host') }, runId + '-publisher-' + suffix, envelope, {
    runtimeBundle, operationName: 'publish/1', timeoutMs: 300_000, outputBytes: 32768,
    inputSchema: { type: 'object', required: ['operationId', 'requestFile', 'requestSha256'], properties: {
      operationId: { type: 'string' }, requestFile: { type: 'string' }, requestSha256: { type: 'string' } }, additionalProperties: false },
    outputSchema: { type: 'object', required: ['operationId', 'invocation_id', 'status', 'result'], properties: {
      operationId: { type: 'string' }, invocation_id: { type: 'string' }, status: { type: 'string', enum: ['COMPLETED'] }, result: { type: 'object' } } },
    environment: { SELF_REMEDIATION_PUBLISH_TOKEN: process.env.SELF_REMEDIATION_PUBLISH_TOKEN ?? '' },
  });
}
try {
  let receipt = await execute(request, 'create');
  const published = (receipt.receipt as any).result;
  if (policy.mode === 'automatic' && published?.status === 'awaiting-checks') {
    const state = Journal.open(request.journalDirectory, request.incidentId);
    const deadline = state.value<number>('required-check-deadline') ?? Date.now() + 180_000;
    state.put('required-check-deadline', deadline); state.close();
    for (let index = 1; index <= 18 && Date.now() < deadline; index++) {
      await new Promise(resolve => setTimeout(resolve, Math.min(10000, Math.max(0, deadline - Date.now()))));
      if (Date.now() >= deadline) break;
      const checked = await execute({ ...request, action: 'checks', published, operationId: `${runId}-checks-${index}/checks` }, `checks-${index}`);
      await writeFile(join(output, `required-check-receipt-${index}.json`), JSON.stringify(checked), { mode: 0o600 });
      const status = (checked.receipt as any).result?.status;
      if (status === 'rejected') { receipt = checked; break; }
      if (status === 'ready') {
        // A distinct maintained host invocation admits merge. Replaying the completed
        // awaiting-checks publication invocation cannot admit a new mutation.
        receipt = await execute({ ...request, action: 'merge', published, operationId: `${runId}-merge/merge` }, 'merge');
        break;
      }
    }
  }
  await writeFile(join(output, 'publication-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  const status = (receipt.receipt as { result?: { status?: string } }).result?.status;
  if (process.env.GITHUB_OUTPUT && status && /^[a-z-]+$/.test(status)) await appendFile(process.env.GITHUB_OUTPUT, `status=${status}\n`);
  process.stdout.write(`${JSON.stringify(receipt.receipt)}\n`);
} finally {
  const retainedJournal = Journal.open(request.journalDirectory, request.incidentId);
  retainedJournal.checkpoint(); retainedJournal.close();
}
