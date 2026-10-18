/** Exercise the actual bundled command boundary with an explicit offline MCP transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { canonical, sha256 } from '../deploy/effects.js';

test('bundled GitHub metadata command consumes and verifies the retained external-read envelope', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mas-github-read-envelope-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = join(directory, 'github.mjs'), control = join(directory, 'offline-fetch.mjs');
  const revision = 'a'.repeat(40), inputSchema = { type: 'object', properties: { method: { type: 'string' } } };
  const request = { journalDirectory: directory, incidentId: 'incident-control', attemptId: 'attempt-control',
    operationId: 'incident-control.github_metadata', grant: { repository: 'control/repository', workflowRunId: '123',
      workflowSourceRevision: revision, toolSchemaSha256: sha256({ name: 'actions_get', inputSchema }), evidenceSetting: 'blind' } };
  await build({ entryPoints: ['scripts/github-read.ts'], outfile: bundle, platform: 'node', target: 'node24', bundle: true, format: 'esm',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  await writeFile(control, `
    import {appendFileSync} from 'node:fs';
    globalThis.fetch=async(url,options)=>{
      if(url!=='https://api.githubcopilot.com/mcp/')throw new Error('Unexpected offline control endpoint');
      if(options.headers.authorization!=='Bearer explicit-offline-control')throw new Error('Unexpected control credential');
      const request=JSON.parse(options.body);appendFileSync(process.env.CONTROL_RPC_LOG,JSON.stringify(request)+'\\n');
      if(request.method==='notifications/initialized')return new Response(null,{status:202});
      let result;
      if(request.method==='initialize')result={serverInfo:{name:'explicit-offline-control'}};
      else if(request.method==='tools/list')result={tools:[{name:'actions_get',inputSchema:${JSON.stringify(inputSchema)}}]};
      else if(request.method==='tools/call'){
        if(request.params.name!=='actions_get'||JSON.stringify(request.params.arguments)!==JSON.stringify({method:'get_workflow_run',owner:'control',repo:'repository',resource_id:'123'}))throw new Error('Unexpected metadata read');
        result={structuredContent:{id:123,head_sha:${JSON.stringify(revision)},status:'in_progress',conclusion:null,event:'workflow_dispatch',logs:'excluded-control-data'}};
      }else throw new Error('Unexpected offline control method');
      return Response.json({jsonrpc:'2.0',id:request.id,result});
    };
  `);
  const execute = async (name: string, content: unknown, overrides: Record<string, unknown> = {}, invocation = true) => {
    const requestFile = join(directory, name + '.json'), log = join(directory, name + '.rpc.jsonl');
    await writeFile(requestFile, canonical(content));
    const envelope = { operationId: request.operationId, requestFile, requestSha256: sha256(request), ...overrides };
    const result = spawnSync(process.execPath, ['--import', control, bundle, ...(invocation ? ['--invocation', 'effect-control'] : [])], {
      encoding: 'utf8', input: JSON.stringify(envelope), timeout: 10_000,
      env: { PATH: process.env.PATH, SELF_REMEDIATION_GITHUB_READ_TOKEN: 'explicit-offline-control', CONTROL_RPC_LOG: log },
    });
    return { result, calls: existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : [] };
  };
  await t.test('valid envelope reaches the permitted RPC and returns the bound receipt', async () => {
    const { result, calls } = await execute('valid', request);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.operationId, request.operationId);
    assert.equal(receipt.invocation_id, 'effect-control');
    assert.equal(receipt.status, 'COMPLETED');
    assert.equal(receipt.result.sourceRevision, revision);
    assert.equal(receipt.result.repository, request.grant.repository);
    assert.equal(receipt.result.workflowRunId, request.grant.workflowRunId);
    assert.equal(receipt.result.evidenceSetting, 'blind');
    assert.equal(receipt.result.schemaSha256, request.grant.toolSchemaSha256);
    assert.equal(result.stdout.includes('excluded-control-data'), false);
    assert.deepEqual(calls.map(call => call.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  });
  await t.test('changed request bytes are rejected before RPC', async () => {
    const { result, calls } = await execute('tampered', { ...request, grant: { ...request.grant, workflowRunId: '456' } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Retained GitHub metadata request changed/);
    assert.deepEqual(calls, []); assert.equal(result.stdout, '');
  });
  await t.test('different operation identity is rejected even when the content digest matches', async () => {
    const { result, calls } = await execute('operation-mismatch', request, { operationId: 'another-operation' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Retained GitHub metadata request changed/);
    assert.deepEqual(calls, []); assert.equal(result.stdout, '');
  });
  await t.test('missing grant is rejected before RPC', async () => {
    const missingGrant = { operationId: request.operationId };
    const { result, calls } = await execute('missing-grant', missingGrant, { requestSha256: sha256(missingGrant) });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Frozen GitHub metadata request required/);
    assert.deepEqual(calls, []); assert.equal(result.stdout, '');
  });
  await t.test('missing host invocation is rejected before RPC', async () => {
    const { result, calls } = await execute('missing-invocation', request, {}, false);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /--invocation must be supplied/);
    assert.deepEqual(calls, []); assert.equal(result.stdout, '');
  });
});
