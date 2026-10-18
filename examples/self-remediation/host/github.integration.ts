/** The host and GitHub command are real; only the remote MCP transport is an offline control. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { runTrustedOperation } from './tool.js';
import { externalCapabilities } from '../deploy/capabilities.js';
import { canonical, sha256 } from '../deploy/effects.js';

const sdkRoot = resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host');
const binary = resolve(process.env.MAS_HOST_BIN ?? join(sdkRoot, 'target/debug/mas-host'));

test('real host completes a frozen GitHub metadata envelope and replays its receipt without another RPC', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'self-remediation-github-host-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const runtimeBundle = join(stateDir, 'github.mjs'), rpcLog = join(stateDir, 'rpc.jsonl');
  const inputSchema = { type: 'object', properties: { method: { type: 'string' } } };
  const request = { operationId: 'github-control', journalDirectory: stateDir, incidentId: 'incident-control', attemptId: 'attempt-control',
    grant: { repository: 'control/repository', workflowRunId: '123', workflowSourceRevision: 'a'.repeat(40),
      toolSchemaSha256: sha256({ name: 'actions_get', inputSchema }), evidenceSetting: 'blind' } };
  await build({ entryPoints: ['scripts/github-read.ts'], outfile: runtimeBundle, bundle: true, platform: 'node', target: 'node24', format: 'esm',
    banner: { js: `
      import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
      import { appendFileSync as recordControlRpc } from 'node:fs';
      globalThis.fetch = async (url, options) => {
        if (url !== 'https://api.githubcopilot.com/mcp/') throw new Error('Unexpected control endpoint');
        const rpc = JSON.parse(options.body); recordControlRpc(${JSON.stringify(rpcLog)}, JSON.stringify(rpc) + '\\n');
        if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
        const result = rpc.method === 'initialize' ? { serverInfo: { name: 'offline-control' } }
          : rpc.method === 'tools/list' ? { tools: [{ name: 'actions_get', inputSchema: ${JSON.stringify(inputSchema)} }] }
          : rpc.method === 'tools/call' ? { structuredContent: { id: 123, head_sha: ${JSON.stringify(request.grant.workflowSourceRevision)}, status: 'in_progress' } }
          : null;
        if (!result) throw new Error('Unexpected control RPC');
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
      };
    ` } });
  const requestFile = join(stateDir, 'request.json');
  await writeFile(requestFile, canonical(request), { mode: 0o400 });
  const envelope = { operationId: request.operationId, requestFile, requestSha256: sha256(request) };
  const capability = externalCapabilities.find(item => item.id === 'github_metadata')!;
  const options = { runtimeBundle, inputSchema: capability.inputSchema, outputSchema: capability.outputSchema,
    operationName: 'github_metadata/1', timeoutMs: capability.timeoutMs, outputBytes: capability.outputBytes,
    environment: { SELF_REMEDIATION_GITHUB_READ_TOKEN: 'offline-control' } };
  const invoke = () => runTrustedOperation<{ operationId: string; invocation_id: string; status: string; result: Record<string, unknown> }>(
    { binary, sdkRoot, stateDir }, 'github-control', envelope, options);
  const completed = await invoke();
  assert.equal(completed.receipt.operationId, request.operationId);
  assert.equal(completed.receipt.status, 'COMPLETED');
  assert.equal(completed.receipt.result.sourceRevision, request.grant.workflowSourceRevision);
  assert.equal(completed.calls, 1);
  assert.equal(completed.observation.steps.find((step: any) => step.id === completed.receipt.invocation_id)?.state, 'completed');
  const calls = await readFile(rpcLog, 'utf8');
  assert.deepEqual(calls.trim().split('\n').map(line => JSON.parse(line).method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  const replay = await invoke();
  assert.deepEqual(replay.receipt, completed.receipt);
  assert.equal(replay.calls, 1);
  assert.equal(await readFile(rpcLog, 'utf8'), calls);
});
