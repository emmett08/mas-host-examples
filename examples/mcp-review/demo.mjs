#!/usr/bin/env node
/** Official MCP SDK interoperability exercise against the real Rust server and host. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const proposal = { release: 'release-42', has_rollback: true, critical_findings: false };
const options = parseArgs({ options: {
  server: { type: 'string', default: process.env.MAS_MCP_BIN ?? path.join(root, '.tools/mas-mcp/target/release/mas-mcp') },
  host: { type: 'string', default: process.env.MAS_HOST_BIN ?? path.join(root, '.tools/mas-host/target/debug/mas-host') },
  'sdk-root': { type: 'string', default: process.env.MAS_HOST_SDK_ROOT ?? path.join(root, '.tools/mas-host') },
  report: { type: 'string' },
  prepare: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
} }).values;

if (options.help) {
  console.log('node demo.mjs [--server FILE] [--host FILE] [--sdk-root DIR] [--report FILE]\n'
    + 'node demo.mjs --prepare NEW_DIRECTORY [same executable options]\n'
    + 'The default exercises the real server with a deterministic model fixture.\n'
    + '--prepare retains an unused server configuration for an MCP desktop client.');
  process.exit(0);
}

async function prepare(directory) {
  const host = path.resolve(options.host);
  const server = path.resolve(options.server);
  await Promise.all([access(host), access(server)]);
  await chmod(directory, 0o700);
  const retainedHost = path.join(directory, 'mas-host');
  const retainedServer = path.join(directory, 'mas-mcp');
  await copyFile(host, retainedHost);
  await copyFile(server, retainedServer);
  await chmod(retainedHost, 0o700);
  await chmod(retainedServer, 0o700);
  const project = path.join(directory, 'project');
  // Share the same policy application as the A2A example; only the client transport changes.
  await cp(path.join(here, '../a2a-review/project'), project, { recursive: true });
  const built = await execute(retainedHost, ['build', '--project', project, '--sdk-root',
    path.resolve(options['sdk-root'])], { timeout: 120_000, maxBuffer: 1_048_576 });
  const bundle = JSON.parse(built.stdout).bundle;
  const config = path.join(directory, 'server.json');
  await writeFile(config, JSON.stringify({
    version: 'mas-mcp/1', host: retainedHost, bundle, state: path.join(directory, 'state'),
    exports: [{ name: 'release_review', agent: 'review', description: 'Check release policy and obtain separately admitted reviewer advice.' }],
    max_active: 2, max_tasks: 8, allow_payloads: false,
  }, null, 2) + '\n', { mode: 0o600 });
  const registration = path.join(directory, 'mcp-client.json');
  await writeFile(registration, JSON.stringify({ mcpServers: {
    'mas-release-review': { command: retainedServer, args: ['--config', config] },
  } }, null, 2) + '\n', { mode: 0o600 });
  return { server: retainedServer, config, registration };
}

async function connect(prepared) {
  const client = new Client({ name: 'mas-mcp-release-review', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: prepared.server,
    args: ['--config', prepared.config], stderr: 'inherit' });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await transport.close();
    throw error;
  }
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name} returned an MCP tool error: ${JSON.stringify(result.content)}`);
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object', `${name} omitted structuredContent`);
  const text = result.content.filter(item => item.type === 'text');
  assert.equal(text.length, 1, `${name} must supply one JSON text compatibility result`);
  assert.deepEqual(JSON.parse(text[0].text), result.structuredContent);
  return result.structuredContent;
}

async function rejected(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} unexpectedly accepted forbidden input`);
  return true;
}

async function complete(client, task) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (task.state === 'completed') {
      assert.equal(typeof task.output_json, 'string');
      return task;
    }
    assert.ok(['submitted', 'working'].includes(task.state), `workflow stopped: ${JSON.stringify(task)}`);
    await delay(50);
    task = await call(client, 'mas_status', { task_id: task.task_id });
  }
  throw new Error('workflow exceeded the 90-second demonstration deadline');
}

async function exercise(prepared) {
  let client = await connect(prepared);
  try {
    const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(tools, ['mas_cancel', 'mas_describe', 'mas_observe', 'mas_status', 'mas_submit']);
    const description = await call(client, 'mas_describe');
    assert.match(description.descriptor_digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(description.operations.map(operation => operation.name), ['release_review']);
    const submission = { request_id: 'release-42', operation: 'release_review',
      descriptor_digest: description.descriptor_digest, input_json: JSON.stringify(proposal) };
    const first = await call(client, 'mas_submit', submission);
    assert.equal(first.task_id, submission.request_id);
    const repeated = await call(client, 'mas_submit', submission);
    assert.equal(repeated.task_id, first.task_id);
    const finished = await complete(client, repeated);
    const decision = JSON.parse(finished.output_json);
    assert.equal(decision.approved, true);
    assert.equal(decision.policy_accepted, true);
    assert.equal(decision.reviewer_approved, true);
    const observed = await call(client, 'mas_observe', { task_id: first.task_id, include_payloads: false });
    assert.equal(observed.task_id, first.task_id);
    const observations = JSON.parse(observed.observation_json);
    assert.equal(observations.version, 'mas-host-observation/1');
    assert.equal(observations.payloads_included, false);
    for (const target of ['policy', 'reviewer']) {
      assert.ok(observations.messages.some(message => message.sender === 'review' && message.recipient === target),
        `the retained protocol trace lacks the review -> ${target} request`);
    }
    assert.ok(observations.messages.every(message => !Object.hasOwn(message, 'payload')));
    assert.equal(observations.calls.length, 1, 'one fixture reviewer inference must be admitted');
    const denials = {
      changed_input: await rejected(client, 'mas_submit', { ...submission,
        input_json: JSON.stringify({ ...proposal, has_rollback: false }) }),
      hidden_agent: await rejected(client, 'mas_submit', { ...submission,
        request_id: 'hidden-policy', operation: 'policy' }),
      stale_descriptor: await rejected(client, 'mas_submit', { ...submission,
        request_id: 'stale-description', descriptor_digest: '0'.repeat(64) }),
      undisclosed_payloads: await rejected(client, 'mas_observe', { task_id: first.task_id, include_payloads: true }),
      unknown_task: await rejected(client, 'mas_status', { task_id: 'never-submitted' }),
    };
    // Closing stdin and reopening starts another real server with the same private state.
    await client.close();
    client = await connect(prepared);
    const restored = await complete(client, await call(client, 'mas_submit', submission));
    assert.deepEqual(restored, finished);
    const restoredObservation = await call(client, 'mas_observe', { task_id: first.task_id, include_payloads: false });
    // Observation time changes on each read, while the recorded execution must remain fixed.
    const { observed_at_ms: _firstRead, ...firstExecution } = observations;
    const { observed_at_ms: _secondRead, ...restoredExecution } = JSON.parse(restoredObservation.observation_json);
    assert.deepEqual(restoredExecution, firstExecution,
      'replay must preserve the existing MAS observation rather than run the actors again');
    const refused = await complete(client, await call(client, 'mas_submit', {
      ...submission, request_id: 'no-rollback',
      input_json: JSON.stringify({ ...proposal, has_rollback: false }),
    }));
    const refusal = JSON.parse(refused.output_json);
    assert.equal(refusal.approved, false);
    assert.equal(refusal.policy_accepted, false);
    assert.equal(refusal.reviewer_approved, true);
    return { status: 'passed', mode: 'deterministic-provider-fixture',
      client: '@modelcontextprotocol/sdk@1.32.1', transport: 'stdio',
      descriptor_digest: description.descriptor_digest, tools,
      exported_operations: description.operations.map(operation => operation.name),
      task_id: finished.task_id, decision, policy_refusal: refusal,
      repeated_request_same_identity: true, server_restart_retains_result: true,
      replay_preserves_host_observation: true, rejected: denials };
  } finally {
    await client.close();
  }
}

if (options.prepare) {
  const directory = path.resolve(options.prepare);
  // A fresh directory prevents accidental changes to a retained run's identity.
  await mkdir(directory, { mode: 0o700 });
  const prepared = await prepare(directory);
  console.log(JSON.stringify({ status: 'prepared', ...prepared }, null, 2));
} else {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mas-mcp-review-'));
  try {
    const report = await exercise(await prepare(directory));
    const encoded = JSON.stringify(report, null, 2) + '\n';
    if (options.report) {
      await mkdir(path.dirname(path.resolve(options.report)), { recursive: true });
      await writeFile(options.report, encoded);
    }
    process.stdout.write(encoded);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
