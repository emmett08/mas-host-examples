import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonical as runtimeCanonical, sha256 } from '../deploy/effects.js';
import { OfficialGitHubMcp } from '../tools/github-mcp.js';
import { canonical, discoverSchema, main, parseArguments, runSetup } from '../scripts/discover-github-mcp-schema.mjs';

const TOKEN = 'ghp_offline_control_DO_NOT_PRINT';
const inputSchema = { type: 'object', properties: { resource_id: { type: 'string' },
  method: { type: 'string', enum: ['get_workflow_run'] }, repo: { type: 'string' }, owner: { type: 'string' } },
  required: ['method', 'owner', 'repo', 'resource_id'] };
const record = { name: 'actions_get', inputSchema };
const digest = sha256(record);

function transport(options: { sse?: boolean; pages?: boolean; token?: string } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const request = async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), headers, body });
    assert.equal(String(url), 'https://api.githubcopilot.com/mcp/');
    assert.equal(headers.authorization, `Bearer ${options.token ?? TOKEN}`);
    assert.equal(headers['MCP-Protocol-Version'], '2025-03-26');
    assert.equal(headers['X-MCP-Readonly'], 'true'); assert.equal(headers['X-MCP-Tools'], 'actions_get');
    assert.equal(init?.redirect, 'error');
    if (body.method === 'notifications/initialized') {
      assert.equal(Object.hasOwn(body, 'id'), false);
      assert.equal(headers['Mcp-Session-Id'], 'offline-session');
      return new Response(null, { status: 202 });
    }
    let result;
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'offline-control' } };
    else if (body.method === 'tools/list') {
      assert.equal(headers['Mcp-Session-Id'], 'offline-session');
      result = options.pages && !body.params.cursor ? { tools: [], nextCursor: 'next-page' } : { tools: [record] };
    } else throw new Error('Unexpected RPC');
    const message = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    return new Response(options.sse ? `event: message\r\ndata: ${message}\r\n\r\n` : message, {
      headers: { 'content-type': options.sse ? 'text/event-stream' : 'application/json', 'Mcp-Session-Id': 'offline-session' },
    });
  };
  return { request: request as typeof fetch, calls };
}

async function directory(t: { after: (callback: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), 'mas-mcp-setup-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
function args(path: string, extra: string[] = []) {
  return ['--repo', 'control/repository', '--run', join(path, 'run.json'), '--output', path, ...extra];
}

test('discovery canonical digest and MCP handshake match the actual runtime adapter', async () => {
  const setup = transport({ sse: true }), actual = transport();
  const found = await discoverSchema(TOKEN, setup.request);
  assert.equal(found.digest, digest); assert.equal(canonical(record), runtimeCanonical(record));
  const runtime = new OfficialGitHubMcp(TOKEN, { repository: 'control/repository', workflowRunId: '123',
    workflowSourceRevision: 'a'.repeat(40), toolSchemaSha256: found.digest, evidenceSetting: 'blind' }, actual.request);
  assert.equal((await runtime.initialise()).toolSchemaSha256, found.digest);
  assert.deepEqual(setup.calls.map(call => call.body), actual.calls.map(call => call.body));
  assert.deepEqual(setup.calls.map(call => call.headers), actual.calls.map(call => call.headers));
  assert.deepEqual(setup.calls.map(call => call.body.method), ['initialize', 'notifications/initialized', 'tools/list']);
});

test('discovery rejects a later-page schema that the runtime cannot discover', async () => {
  const control = transport({ pages: true });
  await assert.rejects(discoverSchema(TOKEN, control.request), /runtime requires actions_get on the first filtered/);
  assert.equal(control.calls.length, 3);
  assert.deepEqual(control.calls.at(-1)?.body.params, {});
});

test('authenticated gh fallback never prints or saves its token and default discovery makes no variable update', async t => {
  const path = await directory(t), output: string[] = [], commands: unknown[][] = [];
  await writeFile(join(path, 'run.json'), JSON.stringify({ repository: 'control/repository' }));
  const result = await runSetup(parseArguments(['--run', join(path, 'run.json'), '--output', path]), {
    environment: { PATH: process.env.PATH }, request: transport().request, output: (value: string) => output.push(value),
    execute: (command: string, argv: string[]) => { commands.push([command, argv]); return { status: 0, stdout: TOKEN + '\n', stderr: '' }; },
  });
  assert.equal(result.configured, false);
  assert.deepEqual(commands, [['gh', ['auth', 'token', '--hostname', 'github.com']]]);
  assert.equal(await readFile(join(path, 'github-mcp-actions_get.sha256'), 'utf8'), digest + '\n');
  const schema = await readFile(join(path, 'github-mcp-actions_get.schema.json'), 'utf8');
  assert.deepEqual(JSON.parse(schema), record);
  assert.equal((output.join('\n') + schema).includes(TOKEN), false);
});

test('configure shows the exact schema and changes only the identified variable after explicit confirmation', async t => {
  const path = await directory(t), output: string[] = [], commands: unknown[][] = [];
  await writeFile(join(path, 'run.json'), JSON.stringify({ repository: 'control/repository' }));
  const result = await runSetup(parseArguments(['--run', join(path, 'run.json'), '--output', path, '--configure']), {
    environment: { SELF_REMEDIATION_GITHUB_READ_TOKEN: TOKEN }, request: transport().request,
    output: (value: string) => output.push(value), isTTY: true,
    confirm: async (prompt: string) => {
      assert.match(prompt, /Type configure/); assert.match(output.join('\n'), /get_workflow_run/);
      assert.match(output.join('\n'), new RegExp(digest)); assert.deepEqual(commands, []); return 'configure';
    },
    execute: (command: string, argv: string[], options: { env: NodeJS.ProcessEnv }) => {
      assert.equal(options.env.SELF_REMEDIATION_GITHUB_READ_TOKEN, undefined);
      commands.push([command, argv]); return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.configured, true);
  assert.deepEqual(commands, [['gh', ['variable', 'set', 'SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256',
    '--repo', 'control/repository', '--env', 'self-remediation-live', '--body', digest]]]);
  assert.equal(JSON.stringify(commands).includes(TOKEN), false); assert.equal(output.join('\n').includes(TOKEN), false);
});

test('declined confirmation and noninteractive setup preserve the files without a remote write', async t => {
  const path = await directory(t), output: string[] = []; let calls = 0;
  const dependencies = { environment: { SELF_REMEDIATION_GITHUB_READ_TOKEN: TOKEN }, request: transport().request,
    output: (value: string) => output.push(value), execute: () => { calls++; throw new Error('unexpected subprocess'); } };
  const cancelled = await runSetup(parseArguments(args(path, ['--configure'])), {
    ...dependencies, isTTY: true, confirm: async () => 'yes',
  });
  assert.equal(cancelled.configured, false); assert.equal(calls, 0);
  await assert.rejects(runSetup(parseArguments(args(path, ['--configure'])), { ...dependencies, isTTY: false }), /interactive terminal/);
  assert.equal(calls, 0); assert.match(output.join('\n'), /Configuration cancelled/);
  assert.equal(await readFile(join(path, 'github-mcp-actions_get.sha256'), 'utf8'), digest + '\n');
});

test('authentication and transport failures are redacted and never create schema files', async t => {
  for (const mode of ['gh', 'network', 'http', 'rpc', 'parse', 'echo'] as const) {
    await t.test(mode, async t => {
      const path = await directory(t), output: string[] = [], errors: string[] = [];
      const request = async () => {
        if (mode === 'network') throw new Error(`transport diagnostic ${TOKEN}`);
        if (mode === 'http') return new Response(TOKEN, { status: 401 });
        if (mode === 'rpc') return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: TOKEN } });
        if (mode === 'parse') return new Response(TOKEN, { headers: { 'content-type': 'application/json' } });
        throw new Error('unexpected request');
      };
      let sequence = 0;
      const echo = async () => {
        sequence++; if (sequence === 2) return new Response(null, { status: 202 });
        return Response.json({ jsonrpc: '2.0', id: sequence, result: sequence === 1 ? {} : {
          tools: [{ name: 'actions_get', inputSchema: { description: TOKEN } }],
        } });
      };
      const code = await main(args(path), {
        environment: mode === 'gh' ? {} : { SELF_REMEDIATION_GITHUB_READ_TOKEN: TOKEN }, request: mode === 'echo' ? echo : request,
        execute: () => ({ status: 1, stdout: TOKEN, stderr: `authentication failed ${TOKEN}` }),
        output: (value: string) => output.push(value), error: (value: string) => errors.push(value),
      });
      assert.equal(code, 1); assert.equal((output.join('\n') + errors.join('\n')).includes(TOKEN), false);
      assert.deepEqual(await readdir(path), []);
    });
  }
});

test('an oversized response is cancelled before retention', async t => {
  const path = await directory(t); let cancelled = false;
  const code = await main(args(path), {
    environment: { SELF_REMEDIATION_GITHUB_READ_TOKEN: TOKEN }, output: () => {}, error: () => {},
    request: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel() { cancelled = true; },
    })),
  });
  assert.equal(code, 1); assert.equal(cancelled, true); assert.deepEqual(await readdir(path), []);
});

test('missing capability with or without pagination fails without emitting a usable digest', async () => {
  for (const cyclic of [false, true]) {
    let sequence = 0;
    const request = async () => {
      sequence++; if (sequence === 2) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: '2.0', id: sequence, result: sequence === 1 ? {} : {
        tools: [], ...(cyclic ? { nextCursor: 'repeated' } : {}),
      } });
    };
    await assert.rejects(discoverSchema(TOKEN, request), cyclic ? /first filtered tools\/list page/ : /capability is unavailable/);
  }
});

test('changed schemas preserve the previous reviewed files and identical discovery can repeat', async t => {
  const path = await directory(t);
  const dependencies = { environment: { SELF_REMEDIATION_GITHUB_READ_TOKEN: TOKEN }, request: transport().request, output: () => {} };
  await runSetup(parseArguments(args(path)), dependencies); await runSetup(parseArguments(args(path)), dependencies);
  await writeFile(join(path, 'github-mcp-actions_get.schema.json'), 'earlier reviewed schema\n');
  await assert.rejects(runSetup(parseArguments(args(path)), dependencies), /Existing schema output differs/);
  assert.equal(await readFile(join(path, 'github-mcp-actions_get.schema.json'), 'utf8'), 'earlier reviewed schema\n');
});

test('invalid arguments fail before authentication and help requires no credentials', async () => {
  for (const argv of [['--token', TOKEN], ['--repo'], ['--repo', 'owner/repo;echo'], ['--configure', '--configure'],
    ['--env', '--configure'], ['--env', 'live\nother']]) {
    let called = false; const errors: string[] = [];
    assert.equal(await main(argv, { execute: () => { called = true; }, error: (value: string) => errors.push(value) }), 1);
    assert.equal(called, false); assert.equal(errors.join('\n').includes(TOKEN), false);
  }
  const output: string[] = [];
  assert.equal(await main(['--help'], { environment: {}, output: (value: string) => output.push(value), execute: () => assert.fail() }), 0);
  assert.match(output.join('\n'), /gh auth token/);
});

test('failed gh variable updates suppress credential-bearing diagnostics', async t => {
  const path = await directory(t), errors: string[] = [];
  const code = await main(args(path, ['--configure']), {
    environment: { SELF_REMEDIATION_GITHUB_READ_TOKEN: TOKEN }, request: transport().request, output: () => {},
    isTTY: true, confirm: async () => 'configure', error: (value: string) => errors.push(value),
    execute: () => ({ status: 1, stdout: TOKEN, stderr: TOKEN }),
  });
  assert.equal(code, 1); assert.match(errors.join('\n'), /update could not be confirmed/);
  assert.equal(errors.join('\n').includes(TOKEN), false);
});
