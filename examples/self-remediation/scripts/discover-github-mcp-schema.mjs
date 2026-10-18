#!/usr/bin/env node
/** Dependency-free, read-only discovery unless --configure is explicitly confirmed. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENDPOINT = 'https://api.githubcopilot.com/mcp/';
const MAX_RESPONSE = 256 * 1024;
const VARIABLE = 'SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256';
const ROOT = dirname(fileURLToPath(import.meta.url));
class SetupError extends Error {}

export const HELP = `Discover the official GitHub actions_get schema for self-remediation.

Usage: node discover-github-mcp-schema.mjs [options]
  --configure       Show the schema and ask before setting the environment variable
  --repo OWNER/REPO  Override the repository recorded in run.json
  --env NAME        GitHub environment (default: self-remediation-live)
  --run PATH        Package run.json (default: beside this script)
  --output DIR      Save schema/hash here (default: beside this script)
  --help            Show this help without authenticating

Authentication: SELF_REMEDIATION_GITHUB_READ_TOKEN, or the token from
'gh auth token --hostname github.com'. Credentials stay in memory and are never
written into the package. Discovery performs only the MCP initialise/list calls.

Review github-mcp-actions_get.schema.json and its get_workflow_run method before
confirming --configure. Configuration writes only ${VARIABLE}.
The workflow's dedicated read-token secret must already be configured separately.
A changed schema needs a new --output directory so the previous review is retained.
`;

export function parseArguments(argv) {
  const options = { configure: false, help: false, environment: 'self-remediation-live',
    run: resolve(ROOT, 'run.json'), output: ROOT, repository: undefined };
  const names = { '--repo': 'repository', '--env': 'environment', '--run': 'run', '--output': 'output' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw new SetupError('Repeated option. Use --help for accepted arguments.');
    seen.add(arg);
    if (arg === '--help') options.help = true;
    else if (arg === '--configure') options.configure = true;
    else if (Object.hasOwn(names, arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value))
        throw new SetupError('An option value is missing or invalid. Use --help for accepted arguments.');
      options[names[arg]] = value;
    } else throw new SetupError('Unknown argument. Use --help for accepted arguments.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(options.environment))
    throw new SetupError('Use a simple GitHub environment name containing letters, digits, dots, hyphens or underscores.');
  if (options.repository !== undefined && !validRepository(options.repository))
    throw new SetupError('Repository must be OWNER/REPO.');
  options.run = resolve(options.run);
  options.output = resolve(options.output);
  return options;
}

function validRepository(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new SetupError('Only JSON values may be hashed.');
  return result;
}

/** Handshake, headers and canonical record match tools/github-mcp.ts. */
export async function discoverSchema(token, request = fetch) {
  let session, nextId = 0;
  async function rpc(method, params = {}, notification = false) {
    const id = ++nextId;
    let response;
    try {
      response = await request(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26',
          'X-MCP-Readonly': 'true', 'X-MCP-Tools': 'actions_get',
          ...(session ? { 'Mcp-Session-Id': session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
      });
    } catch { throw new SetupError('GitHub MCP request failed or timed out. Check your connection and GitHub authentication.'); }
    if (!response.ok) throw new SetupError(`GitHub MCP returned HTTP ${response.status}. Check your token and MCP access.`);
    session = response.headers.get('Mcp-Session-Id') ?? session;
    if (notification && response.status === 202) return {};
    const parts = []; let bytes = 0;
    const reader = response.body?.getReader();
    try {
      if (reader) for (;;) {
        const item = await reader.read(); if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > MAX_RESPONSE) {
          await reader.cancel();
          throw new SetupError('GitHub MCP response exceeded 256 KiB. No schema was accepted.');
        }
        parts.push(item.value);
      }
    } catch (error) {
      if (error instanceof SetupError) throw error;
      throw new SetupError('GitHub MCP response could not be read. No schema was accepted.');
    }
    const body = Buffer.concat(parts).toString('utf8');
    if (notification && !body) return {};
    let found;
    try {
      const frames = response.headers.get('content-type')?.includes('text/event-stream')
        ? body.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/)
          .filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')).filter(Boolean)
        : [body];
      found = frames.map(frame => JSON.parse(frame)).find(frame => frame?.id === id);
    } catch { throw new SetupError('GitHub MCP returned an invalid JSON response. No schema was accepted.'); }
    if (!found || found.error || !found.result || typeof found.result !== 'object')
      throw new SetupError('GitHub MCP discovery failed. No schema was accepted.');
    return found.result;
  }
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'mas-self-remediation-read', version: '1.0.0' } });
  await rpc('notifications/initialized', {}, true);
  const listed = await rpc('tools/list', {});
  if (!Array.isArray(listed.tools)) throw new SetupError('GitHub MCP tool list is unavailable.');
  const matching = listed.tools.filter(item => item?.name === 'actions_get');
  if (matching.length > 1) throw new SetupError('GitHub MCP returned duplicate actions_get definitions.');
  const tool = matching[0];
  if (!tool) {
    if (listed.nextCursor)
      throw new SetupError('The current runtime requires actions_get on the first filtered tools/list page. No schema was accepted.');
    throw new SetupError('Official actions_get capability is unavailable.');
  }
  if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema))
    throw new SetupError('Official actions_get input schema is unavailable.');
  const record = { name: tool.name, inputSchema: tool.inputSchema };
  const json = JSON.stringify(record, null, 2) + '\n';
  if (token && json.includes(token)) throw new SetupError('GitHub MCP returned credential-bearing content. Nothing was retained.');
  return { record, json, digest: createHash('sha256').update(canonical(record)).digest('hex') };
}

async function retainFile(path, value) {
  try { await writeFile(path, value, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw new SetupError('Could not save the schema files. Choose a writable --output directory.');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RESPONSE * 4 || await readFile(path, 'utf8') !== value)
      throw new SetupError('Existing schema output differs. Use --output with a new directory to review a changed schema.');
  }
}

async function terminalConfirmation(prompt) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return await terminal.question(prompt); } finally { terminal.close(); }
}

export async function runSetup(options, dependencies = {}) {
  const output = dependencies.output ?? (value => process.stdout.write(value + '\n'));
  if (options.help) { output(HELP); return { configured: false }; }
  const environment = dependencies.environment ?? process.env;
  const execute = dependencies.execute ?? spawnSync;
  // The dedicated MCP token is needed only by the in-memory HTTP transport.
  const childEnvironment = { ...environment }; delete childEnvironment.SELF_REMEDIATION_GITHUB_READ_TOKEN;
  let repository = options.repository;
  if (!repository) {
    try {
      const info = await lstat(options.run);
      if (!info.isFile() || info.size > 64 * 1024) throw new Error();
      const run = JSON.parse(await readFile(options.run, 'utf8'));
      repository = run.repository ?? run.repo;
    } catch (error) {
      if (options.configure) throw new SetupError('A valid run.json or --repo OWNER/REPO is required to configure GitHub.');
      if (error?.code !== 'ENOENT') throw new SetupError('Package run.json could not be read. Use --repo OWNER/REPO.');
    }
  }
  if (repository !== undefined && !validRepository(repository)) throw new SetupError('Repository must be OWNER/REPO.');
  if (options.configure && !repository) throw new SetupError('Supply --repo OWNER/REPO before configuring GitHub.');
  let token = environment.SELF_REMEDIATION_GITHUB_READ_TOKEN?.trim();
  if (!token) {
    let result;
    try { result = execute('gh', ['auth', 'token', '--hostname', 'github.com'],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024, env: childEnvironment }); }
    catch { throw new SetupError('GitHub authentication is unavailable. Run gh auth login or set SELF_REMEDIATION_GITHUB_READ_TOKEN.'); }
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || !result.stdout.trim())
      throw new SetupError('GitHub authentication is unavailable. Run gh auth login or set SELF_REMEDIATION_GITHUB_READ_TOKEN.');
    token = result.stdout.trim();
  }
  if (token.length > 8192 || /[\x00-\x20\x7f]/.test(token)) throw new SetupError('The GitHub credential has an invalid format.');
  const schema = await discoverSchema(token, dependencies.request ?? fetch);
  try { await mkdir(options.output, { recursive: true }); }
  catch { throw new SetupError('Could not create the schema output directory.'); }
  await retainFile(resolve(options.output, 'github-mcp-actions_get.schema.json'), schema.json);
  await retainFile(resolve(options.output, 'github-mcp-actions_get.sha256'), schema.digest + '\n');
  output(`Saved github-mcp-actions_get.schema.json and github-mcp-actions_get.sha256.\n${VARIABLE}=${schema.digest}`);
  if (!options.configure) {
    output('Review the saved schema. Run again with --configure to approve updating the GitHub environment variable.');
    return { ...schema, configured: false };
  }
  output(`Review the exact tool definition, including its get_workflow_run method:\n${schema.json}`);
  output(`Proposed update: ${repository}, environment ${options.environment}\n${VARIABLE}=${schema.digest}`);
  if (!(dependencies.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY)))
    throw new SetupError('Configuration requires an interactive terminal. Discovery files are saved; no GitHub variable was changed.');
  const answer = await (dependencies.confirm ?? terminalConfirmation)('Type configure to approve this exact schema and update the variable: ');
  if (answer.trim() !== 'configure') {
    output('Configuration cancelled. No GitHub variable was changed.');
    return { ...schema, configured: false };
  }
  let result;
  try { result = execute('gh', ['variable', 'set', VARIABLE, '--repo', repository,
    '--env', options.environment, '--body', schema.digest],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024, env: childEnvironment }); }
  catch { throw new SetupError('GitHub variable update could not be confirmed. Check the environment variable in GitHub before retrying.'); }
  if (result.error || result.status !== 0)
    throw new SetupError('GitHub variable update could not be confirmed. Check gh authentication and repository environment permissions.');
  output(`Configured ${VARIABLE} for ${repository} / ${options.environment}.`);
  return { ...schema, configured: true };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  try { await runSetup(parseArguments(argv), dependencies); return 0; }
  catch (error) {
    // Never surface provider bodies, subprocess stdout/stderr, stack traces or credentials.
    const message = error instanceof SetupError ? error.message : 'Schema setup failed. No further action was attempted; check the local files and GitHub configuration.';
    (dependencies.error ?? (value => process.stderr.write(value + '\n')))(message);
    return 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await main();
