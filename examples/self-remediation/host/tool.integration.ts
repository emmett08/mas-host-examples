import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { executeTool } from './tool.js';
import { hostCommand } from './phase.js';
import { registryDigest } from '../tools/capabilities.js';
import { materialise, sha256 } from '../tools/projection.js';
const sdkRoot = resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host');
const binary = resolve(process.env.MAS_HOST_BIN ?? join(sdkRoot, 'target/debug/mas-host'));

test('real host native and custom MCP commands retain operationId to admitted invocation_id and known failure as completed', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'self-remediation-tools-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const runtimeBundle = join(stateDir, 'broker.mjs');
  await build({ entryPoints: ['tools/command.ts'], outfile: runtimeBundle, bundle: true, platform: 'node', target: 'node24', format: 'esm', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  const snapshot = await materialise({ 'src/app.ts': 'export const incident = true;\n' }, { repository: 'owner/repo', revision: 'a'.repeat(40), paths: ['src/'], mode: 'blind' });
  t.after(() => rm(snapshot.root, { recursive: true, force: true }));
  const contextFile = join(stateDir, 'context.json');
  await writeFile(contextFile, JSON.stringify({ snapshot, registryDigest, journalPath: join(stateDir, 'tools.sqlite'), artefactRoot: join(stateDir, 'artefacts'), runtimeBundle, runtimeDigest: sha256(await readFile(runtimeBundle)) }));
  const config = { binary, sdkRoot, stateDir };
  for (const capability of ['source_read', 'custom_mcp_read']) {
    const output = await executeTool(config, capability, capability, { operationId: `${capability}-op`, path: 'src/app.ts' }, { contextFile, runtimeBundle });
    assert.equal(output.receipt.operationId, `${capability}-op`); assert.equal(output.receipt.measurement, 'passed');
    assert.ok(output.receipt.invocation_id); assert.equal(output.calls, 1);
    assert.match(output.receipt.summary, /incident/);
  }
  const failed = await executeTool(config, 'missing-file', 'source_read', { operationId: 'missing-file-op', path: 'src/missing.ts' }, { contextFile, runtimeBundle });
  assert.equal(failed.receipt.operationStatus, 'COMPLETED'); assert.equal(failed.receipt.measurement, 'failed');
  const replay = await executeTool(config, 'missing-file', 'source_read', { operationId: 'missing-file-op', path: 'src/missing.ts' }, { contextFile, runtimeBundle });
  assert.equal(replay.calls, 1); assert.equal(replay.receipt.invocation_id, failed.receipt.invocation_id);
});

test('real native SDK receipt binds both invocation identities and revision policy denies native effects', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'self-remediation-native-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const project = join(stateDir, 'project'); await mkdir(project);
  await copyFile('project/assessment.py', join(project, 'assessment.py'));
  await writeFile(join(project, 'agents.json'), JSON.stringify({ version: 'mas-agents/3', agents: [
    { name: 'receipt', implementation: { kind: 'native', language: 'python', source: 'assessment.py', handler: 'receipt' } },
    { name: 'check', implementation: { kind: 'native', language: 'python', source: 'assessment.py', handler: 'assess' } },
  ], limits: { wall_seconds: 30, max_calls: 2, max_messages: 12, max_bytes: 65536, mailbox_capacity: 4 } }));
  await writeFile(join(project, 'topology.json'), JSON.stringify({ version: 'mas-topology/1', edges: [['client', 'receipt'], ['receipt', 'client'], ['client', 'check'], ['check', 'client']] }));
  await writeFile(join(project, 'input.json'), JSON.stringify({ operationId: 'native-control', measurement: 'failed' }));
  const args = ['run', '--project', project, '--sdk-root', sdkRoot, '--agents', 'agents.json', '--topology', 'topology.json', '--agent', 'receipt', '--input', join(project, 'input.json'), '--state', stateDir, '--run', 'native-receipt'];
  const result = JSON.parse(await hostCommand(binary, args, { timeout: 60_000 }));
  assert.equal(result.output.operationId, 'native-control'); assert.equal(result.output.measurement, 'failed'); assert.notEqual(result.output.invocation_id, result.output.native_invocation_id);
  // Preserve the same worker but adapt its pure inputs. This hostile trusted
  // worker attempts an external effect during a revision assessment.
  const source = (await readFile(join(project, 'assessment.py'), 'utf8')).replace("operation = invocation['operationId']", "operation = invocation.get('sources', {}).get('incident', invocation)['operationId']");
  await writeFile(join(project, 'assessment.py'), source);
  const plan = { version: 'mas-host-revision/1', draft_agent: 'receipt', revision_agent: 'receipt', max_revisions: 0, max_invocations: 3, draft_inputs: ['incident'], revision_inputs: ['incident'], allowed_agents: [], feedback_evaluators: [], rubric: { schema_version: 1, id: 'bounded/1', criteria: [{ id: 'bounded-record', measurement: 'deterministic', minimum: 0, maximum: 1 }] }, evaluators: [{ actor: 'check', identity: { id: 'check', version: '1', kind: 'deterministic' }, inputs: ['incident'] }] };
  await writeFile(join(project, 'plan.json'), JSON.stringify(plan));
  await writeFile(join(project, 'input.json'), JSON.stringify({ sources: [{ id: 'incident', kind: 'input', content: { operationId: 'forbidden-effect' }, readers: ['*'] }] }));
  const guarded = [...args]; guarded[guarded.indexOf('native-receipt')] = 'forbidden-revision'; guarded.push('--revision-plan', join(project, 'plan.json'));
  await assert.rejects(hostCommand(binary, guarded, { timeout: 60_000 }));
  const observation = JSON.parse(await hostCommand(binary, ['observe', '--state', stateDir, '--run', 'forbidden-revision', '--include-payloads', 'true']));
  assert.equal(observation.calls.length, 0, 'Forbidden native effect must be refused before reservation');
});

test('lost command response remains unknown until the exact effect is reconciled, then replay performs no second external action', async t => {
  const { runTrustedOperation } = await import('./tool.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'self-remediation-lost-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const runtimeBundle = join(stateDir, 'lost-response.mjs'), evidencePath = join(stateDir, 'external-receipt.json');
  await writeFile(runtimeBundle, `import {writeFileSync,appendFileSync} from 'node:fs';\nlet raw='';for await(const c of process.stdin)raw+=c;const input=JSON.parse(raw);\nconst result={operationId:input.operationId,invocation_id:process.argv[3],status:'COMPLETED'};\nappendFileSync(${JSON.stringify(join(stateDir, 'dispatch-count'))},'one\\n');writeFileSync(${JSON.stringify(evidencePath)},JSON.stringify(result));process.exit(1);\n`);
  const inputSchema = { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'], additionalProperties: false };
  const outputSchema = { type: 'object', properties: { operationId: { type: 'string' }, invocation_id: { type: 'string' }, status: { type: 'string', enum: ['COMPLETED'] } }, required: ['operationId', 'invocation_id', 'status'], additionalProperties: false };
  const configuration = { binary, sdkRoot, stateDir }, options = { runtimeBundle, inputSchema, outputSchema, operationName: 'publication_control/1', timeoutMs: 60000, outputBytes: 4096 };
  const invoke = () => runTrustedOperation(configuration, 'lost-response', { operationId: 'publish-one' }, options);
  await assert.rejects(invoke(), (error: any) => error.uncertain === true);
  await assert.rejects(invoke(), (error: any) => error.uncertain === true);
  assert.equal((await readFile(join(stateDir, 'dispatch-count'), 'utf8')).trim(), 'one');
  const receipt = JSON.parse(await readFile(evidencePath, 'utf8'));
  const output = join(stateDir, 'resolved-output.json'), evidence = join(stateDir, 'resolution-evidence.json');
  await writeFile(output, JSON.stringify({ status: 'completed', output: receipt }));
  await writeFile(evidence, JSON.stringify({ operationId: receipt.operationId, invocation_id: receipt.invocation_id, receiptSha256: sha256(await readFile(evidencePath)), source: 'independent-reconciler-control' }));
  await hostCommand(binary, ['resolve', '--state', stateDir, '--run', 'lost-response', '--effect', receipt.invocation_id, '--output', output, '--evidence', evidence]);
  const recovered = await invoke();
  assert.equal(recovered.receipt.invocation_id, receipt.invocation_id);
  assert.equal((await readFile(join(stateDir, 'dispatch-count'), 'utf8')).trim(), 'one');
});
