#!/usr/bin/env node
// One host-admitted command invokes one MCP tool. Configuration comes only from
// the registered actor/environment; stdin contains arguments, never executable,
// URL, target, context path, or credentials. stdout is exactly one JSON object.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TOOL_NAMES = ['pod_overview', 'pod_logs', 'pod_metrics', 'workload_spec'];
const MAX_BYTES = 8192;
export async function runtimeIdentity(packageRoot) {
  const files = ['package-lock.json'];
  const walk = async relative => {
    for (const entry of await readdir(join(packageRoot, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(path);
      else if (entry.isSymbolicLink()) throw new Error('Runtime identity does not follow symbolic links');
    }
  };
  for (const directory of ['dist/mcp', 'dist/operator', 'dist/shared']) await walk(directory);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    const content = await readFile(join(packageRoot, file));
    hash.update(`${file}\0${content.byteLength}\0`); hash.update(content);
  }
  return hash.digest('hex');
}
export function exactJSON(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw new Error('Numeric observation cannot be represented without precision loss');
    return Number.isSafeInteger(value) ? value : String(value);
  }
  if (Array.isArray(value)) return value.map(exactJSON);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, exactJSON(entry)]));
  return value;
}

export async function invokeTool(tool, args, environment = process.env, options = {}) {
  if (!TOOL_NAMES.includes(tool)) throw new Error('Unknown registered MCP tool');
  const packageRoot = environment.MAS_MCP_PACKAGE_ROOT, serverModule = environment.MAS_MCP_SERVER_MODULE;
  if (![packageRoot, serverModule, environment.MAS_MCP_CONTEXT_FILE].every(value => typeof value === 'string' && isAbsolute(value)))
    throw new Error('Absolute controller-owned MCP configuration is required');
  if (resolve(serverModule) !== resolve(packageRoot, 'dist/mcp/server.js')) throw new Error('MCP server must be the pinned application module');
  const contextBytes = await readFile(environment.MAS_MCP_CONTEXT_FILE);
  if (contextBytes.byteLength > 40 * 1024) throw new Error('Investigation context exceeds byte limit');
  const contextHash = createHash('sha256').update(contextBytes).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(environment.MAS_MCP_CONTEXT_SHA256 ?? '') || contextHash !== environment.MAS_MCP_CONTEXT_SHA256)
    throw new Error('Investigation context identity changed');
  const context = JSON.parse(contextBytes.toString('utf8'));
  if (context.runtime_sha256 !== await runtimeIdentity(packageRoot)) throw new Error('Investigation runtime identity changed');
  const require = createRequire(join(packageRoot, 'package.json'));
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href),
    import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href),
  ]);
  const serverEnvironment = Object.fromEntries(['MAS_MCP_CONTEXT_FILE', 'MAS_MCP_CONTEXT_SHA256', 'KUBERNETES_SERVICE_HOST', 'KUBERNETES_SERVICE_PORT_HTTPS']
    .filter(key => typeof environment[key] === 'string').map(key => [key, environment[key]]));
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverModule],
    env: serverEnvironment, stderr: 'pipe', maxBufferSize: 24 * 1024 });
  // Discard raw diagnostics without accumulating them or forwarding secrets.
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'mas-k3s-command-bridge', version: '1.0.0' });
  const deadline = options.deadlineMs ?? 15_000;
  let timer;
  try {
    const operation = async () => {
      await client.connect(transport);
      const listed = await client.listTools({}, { timeout: deadline });
      if (!listed.tools.some(candidate => candidate.name === tool)) throw new Error('Registered MCP tool is unavailable');
      let result;
      try { result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: deadline }); }
      catch (error) {
        // An explicit protocol rejection is a known completed read attempt.
        // Transport failures still throw so the host cannot silently repeat an uncertain invocation.
        if (error?.code !== -32602) throw error;
        result = { isError: true, structuredContent: { status: 'error', source: context.source,
          server: 'mas-k3s-investigation', tool, subject: context.evidence.subject,
          evidence_items: [{ id: `mcp-${tool.replaceAll('_', '-')}-request-error`, kind: 'pod', source: `mcp:${tool}`, status: 'unavailable',
            observedAt: new Date().toISOString(), truncated: false, data: null,
            reason: 'MCP server rejected the requested arguments; the incident target and tool contract are fixed' }],
          numeric_encoding: 'integer-or-decimal-string' } };
      }
      const data = result.structuredContent;
      if (!data || data.server !== 'mas-k3s-investigation' || data.tool !== tool || !Array.isArray(data.evidence_items)
        || !['kubernetes-api', 'recorded-evidence'].includes(data.source)
        || !['collected', 'unavailable', 'error'].includes(data.status)) throw new Error('Invalid MCP tool result');
      if (result.isError && data.status !== 'error') throw new Error('Inconsistent MCP tool failure');
      const output = exactJSON({ ...data, context_sha256: contextHash });
      if (Buffer.byteLength(JSON.stringify(output)) > MAX_BYTES) throw new Error('MCP tool output exceeds byte limit');
      return output;
    };
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('MCP invocation exceeded its deadline')), deadline);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    await client.close(); // stdio close terminates this invocation's child; no retry or shared hidden session.
  }
}

async function main() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 4096) throw new Error('MCP arguments exceed byte limit');
    chunks.push(chunk);
  }
  const args = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('MCP arguments must be an object');
  const result = await invokeTool(process.argv[2], args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('MCP investigation command failed; no result was accepted\n'); process.exitCode = 1; });
}
