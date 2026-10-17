import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { invokeTool, exactJSON, runtimeIdentity } from '../project/mcp-client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const subject = { namespace: 'mas-demo', name: 'checkout', uid: 'pod-1' };
async function fixture(serverSource?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'mas-mcp-'));
  const context = join(directory, 'context.json'), server = join(directory, 'dist/mcp/server.js');
  for (const path of ['dist/mcp', 'dist/operator', 'dist/shared']) await mkdir(join(directory, path), { recursive: true });
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'package-lock.json'), await readFile(join(root, 'package-lock.json')));
  // Compile-free test bootstrap executes production code through tsx. Production
  // invokes compiled dist/mcp/server.js without this test-only source loader.
  await writeFile(server, serverSource ?? `import {tsImport} from ${JSON.stringify(pathToFileURL(require.resolve('tsx/esm/api')).href)};
if (process.env.OPENAI_API_KEY || process.env.DEMO_VERIFIER_TOKEN) process.exit(9);
const {serveFromEnvironment}=await tsImport(${JSON.stringify(pathToFileURL(resolve(root, 'mcp/server.ts')).href)}, import.meta.url);
await serveFromEnvironment();\n`);
  const data = JSON.stringify({ version: 'mas-mcp-investigation/1', source: 'recorded-evidence',
    runtime_sha256: await runtimeIdentity(directory),
    event: { namespace: subject.namespace, involvedObject: { ...subject, kind: 'Pod' } },
    evidence: { version: 'mas-k8s-evidence/1', capturedAt: '2026-10-17T18:00:00Z', subject,
      items: [{ id: 'pod', kind: 'pod', source: '/retained/pod', status: 'collected', truncated: false,
        observedAt: '2026-10-17T18:00:00Z', data: { metadata: subject, cpu: 0.5 } }] } });
  await writeFile(context, data);
  const env = { MAS_MCP_PACKAGE_ROOT: directory, MAS_MCP_SERVER_MODULE: server, MAS_MCP_CONTEXT_FILE: context,
    MAS_MCP_CONTEXT_SHA256: createHash('sha256').update(data).digest('hex'),
    OPENAI_API_KEY: 'must-not-be-inherited', DEMO_VERIFIER_TOKEN: 'must-not-be-inherited' };
  return { directory, context, server, env };
}

test('retained command bridge executes actual stdio MCP handshake, list and one tool call without provider credentials', async () => {
  const { directory, env } = await fixture();
  try {
    const result = await invokeTool('pod_overview', {}, env);
    assert.equal(result.status, 'collected'); assert.equal(result.source, 'recorded-evidence');
    assert.equal(result.evidence_items[0].data.cpu, '0.5');
    assert.equal(result.context_sha256, env.MAS_MCP_CONTEXT_SHA256);
    const missing = await invokeTool('pod_metrics', {}, env);
    assert.equal(missing.status, 'unavailable');
    const rejected = await invokeTool('pod_logs', { namespace: 'other' }, env);
    assert.equal(rejected.status, 'error'); assert.match(rejected.evidence_items[0].reason, /rejected/);
    const otherRejected = await invokeTool('pod_metrics', { namespace: 'other' }, env);
    assert.notEqual(otherRejected.evidence_items[0].id, rejected.evidence_items[0].id);
    await assert.rejects(invokeTool('exec', {}, env), /Unknown registered/);
    await assert.rejects(invokeTool('pod_overview', {}, { ...env, MAS_MCP_CONTEXT_FILE: 'relative.json' }), /Absolute/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bridge refuses modified context, runtime source, dependency lock and alternative server path before spawning', async () => {
  const { directory, env, context, server } = await fixture();
  try {
    await assert.rejects(invokeTool('pod_overview', {}, { ...env, MAS_MCP_SERVER_MODULE: join(directory, 'other.js') }), /pinned/);
    await assert.rejects(invokeTool('pod_overview', {}, { ...env, MAS_MCP_CONTEXT_SHA256: '0'.repeat(64) }), /context identity/);
    const original = await readFile(context);
    await writeFile(context, Buffer.concat([original, Buffer.from(' ')]));
    await assert.rejects(invokeTool('pod_overview', {}, env), /context identity/);
    await writeFile(context, original);
    await writeFile(server, 'process.exit(0);');
    await assert.rejects(invokeTool('pod_overview', {}, env), /runtime identity/);
    const before = await runtimeIdentity(directory);
    await writeFile(join(directory, 'package-lock.json'), '{}');
    assert.notEqual(await runtimeIdentity(directory), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an explicit MCP execution error is a recorded result rather than an uncertain command exit', async () => {
  const { directory, context, env } = await fixture();
  try {
    const content = JSON.parse(await readFile(context, 'utf8'));
    content.evidence.items[0].data.cpu = Number.MAX_SAFE_INTEGER + 1;
    const bytes = JSON.stringify(content);
    await writeFile(context, bytes);
    const result = await invokeTool('pod_overview', {}, { ...env,
      MAS_MCP_CONTEXT_SHA256: createHash('sha256').update(bytes).digest('hex') });
    assert.equal(result.status, 'error');
    assert.deepEqual(result.evidence_items, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('MCP bridge deadline terminates a stalled child and does not retry', async () => {
  const { directory, env } = await fixture('process.stdin.resume(); setInterval(() => {}, 1000);\n');
  try {
    const start = Date.now();
    await assert.rejects(invokeTool('pod_overview', {}, env, { deadlineMs: 30 }), /deadline/);
    assert.ok(Date.now() - start < 4500);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bridge refuses numeric values that have already lost integer precision', () => {
  assert.deepEqual(exactJSON({ integer: 42, decimal: 0.125 }), { integer: 42, decimal: '0.125' });
  assert.throws(() => exactJSON(Number.MAX_SAFE_INTEGER + 1), /precision loss/);
});
