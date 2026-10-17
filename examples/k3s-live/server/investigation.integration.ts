// Exercise the pinned host, real MCP stdio sessions and independent assessment.
// The model provider is scripted; these checks make no external inference calls.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { Host, HostRunFailure, type HostOptions } from './host.js';
import { Runs, type Run } from './runs.js';
import { freezeInvestigation, retainFile } from './investigation.js';
import { runtimeIdentity } from '../project/mcp-client.mjs';
import { EVIDENCE_VERSION, type EvidenceBundle, type EvidenceItem } from '../shared/evidence.js';

const tools = ['pod_overview', 'workload_spec', 'pod_logs', 'pod_metrics'];
const observedAt = '2026-10-17T18:00:00Z';
const subject = { namespace: 'mas-demo', name: 'checkout-pod', uid: 'pod-fixture-uid' };

function incident(id: string) {
  const item = (id: string, kind: EvidenceItem['kind'], data: unknown): EvidenceItem => ({
    id, kind, source: `recorded-fixture:${id}`, status: 'collected', observedAt, truncated: false, data,
  });
  const evidence: EvidenceBundle = { version: EVIDENCE_VERSION, capturedAt: observedAt, subject, items: [
    item('pod', 'pod', { kind: 'Pod', metadata: subject,
      spec: { containers: [{ name: 'checkout' }] },
      status: { conditions: [{ type: 'Ready', status: 'False' }] } }),
    item('events', 'events', [{ reason: 'Unhealthy', message: 'Readiness returned HTTP 404', involvedObject: subject }]),
    item('workload-deployment', 'workload', { kind: 'Deployment',
      metadata: { namespace: 'mas-demo', name: 'mas-demo-checkout', uid: 'deployment-fixture-uid', resourceVersion: '12345' },
      spec: { template: { spec: { containers: [{ name: 'checkout',
        readinessProbe: { httpGet: { path: '/readyz' } }, livenessProbe: { httpGet: { path: '/healthz' } },
      }] } } } }),
    item('logs-checkout-current', 'logs', { container: 'checkout', previous: false,
      text: '{"method":"GET","path":"/readyz","status":404}\n{"method":"GET","path":"/healthz","status":200}' }),
    // A seed observation not selected by the model must not enter the new evidence bundle.
    item('logs-checkout-previous', 'logs', { container: 'checkout', previous: true, text: 'unrequested-previous-observation' }),
    item('metrics', 'metrics', { timestamp: observedAt, containers: [{ name: 'checkout', usage: { cpu: '1m', memory: '16Mi' } }] }),
  ] };
  return { id, scenario: 'pod-incident', approach: 'mcp', evidence,
    event: { namespace: subject.namespace, name: 'checkout-warning', uid: 'event-fixture-uid',
      reason: 'Unhealthy', message: 'Readiness probe returned HTTP 404', involvedObject: { kind: 'Pod', ...subject } } };
}

async function application(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), 'mas-mcp-host-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const project = join(folder, 'project');
  await cp(resolve('project'), project, { recursive: true, filter: path => basename(path) !== '.mas' });
  await mkdir(join(folder, 'dist'));
  for (const name of ['mcp', 'operator', 'shared']) await cp(resolve('dist', name), join(folder, 'dist', name), { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) await cp(resolve(name), join(folder, name));
  await symlink(resolve('node_modules'), join(folder, 'node_modules'), 'dir');
  // The deployment has node on the host's fixed PATH. Local toolchains may not.
  // Retain the bridge as a declared file while binding the actual interpreter.
  const actors = join(project, 'agents.mcp.toml');
  await writeFile(actors, (await readFile(actors, 'utf8'))
    .replaceAll('executable = "mcp-client.mjs"', `executable = ${JSON.stringify(process.execPath)}`)
    .replaceAll('arguments = [{literal', 'arguments = [{file = "mcp-client.mjs"}, {literal'));
  for (const name of ['connections.mcp-fixture.toml', 'connections.assessment-fixture.toml']) {
    const file = join(project, name);
    await writeFile(file, (await readFile(file, 'utf8'))
      .replaceAll('command = ["node",', `command = [${JSON.stringify(process.execPath)},`));
  }
  const previous = process.env.DEMO_MCP_SOURCE;
  process.env.DEMO_MCP_SOURCE = 'recorded-evidence';
  t.after(() => { if (previous === undefined) delete process.env.DEMO_MCP_SOURCE; else process.env.DEMO_MCP_SOURCE = previous; });
  const options: HostOptions = { binary: resolve(process.env.MAS_HOST_BIN ?? '../../.tools/mas-host/target/debug/mas-host'),
    sdk: resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host'), project, payloads: true,
    revisionPlan: join(project, 'revision.json') };
  return { folder, project, options, directory: join(folder, 'runs') };
}

async function settled(runs: Runs, id: string) {
  const until = Date.now() + 240_000;
  while (['queued', 'running'].includes(runs.get(id).status) && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const result = runs.get(id);
  assert.ok(!['queued', 'running'].includes(result.status), 'The bounded host run must settle');
  return result;
}

function effects(observation: { steps: Record<string, any>[] }) {
  return observation.steps.filter(step => step.kind === 'effect');
}

test('OpenAI HTTP investigation enforces complete tool coverage and retains rejected decisions without retries', { timeout: 600_000 }, async t => {
  for (const scenario of ['valid', 'alternate-order', 'invalid-json', 'invalid-decision', 'early-completion', 'partial-completion', 'duplicate-request']) await t.test(scenario, async t => {
    const order = scenario === 'alternate-order' ? ['pod_metrics', 'pod_logs', 'workload_spec', 'pod_overview'] : tools;
    const valid = ['valid', 'alternate-order'].includes(scenario);
    const acceptedCalls = ['partial-completion', 'duplicate-request'].includes(scenario) ? 1 : 0;
    const app = await application(t), requests: Record<string, any>[] = [], errors: unknown[] = [];
    const server = createServer(async (request, response) => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/responses');
        assert.equal(request.headers.authorization, 'Bearer offline-fixture');
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(body);
        assert.equal(body.store, false);
        assert.deepEqual(body.tools, []); // MAS delegates execute the actual MCP tools.
        assert.equal(body.text.format.type, 'json_schema');
        assert.equal(body.text.format.strict, true);
        assert.deepEqual(body.text.format.schema.required, ['decision']);
        const variants = body.text.format.schema.properties.decision.anyOf;
        const requestSchema = variants.find((variant: any) => variant.properties.kind.enum[0] === 'request');

        // Exercise the exact JSON examples supplied to the real model, through
        // the HTTP parser and runtime validator rather than a command provider.
        const examples = body.instructions.split('\n').filter((line: string) => line.startsWith('{'))
          .map((line: string) => JSON.parse(line));
        const ask = examples.find((example: any) => example.decision?.target === 'pod_overview');
        const logs = examples.find((example: any) => example.decision?.target === 'pod_logs');
        assert.deepEqual(JSON.parse(logs.decision.input_json), { container: 'checkout', previous: false, tail_lines: 40 });
        const finish = examples.find((example: any) => example.decision?.kind === 'complete');
        assert.equal(ask.decision.input_json, '{}');
        assert.equal(typeof finish.decision.output.summary, 'string');
        const input = JSON.parse(body.input), turn = input.history.length;
        assert.equal(turn, requests.length - 1);
        assert.equal(variants.some((variant: any) => variant.properties.kind.enum[0] === 'complete'), turn === tools.length,
          'the provider may complete only after all four distinct tools have returned');
        if (turn < tools.length) {
          assert.equal(requestSchema.properties.input_json.type, 'string');
          assert.deepEqual([...requestSchema.properties.target.enum].sort(), order.slice(turn).sort(),
            'the provider can choose only a required tool that has not returned');
        } else assert.equal(requestSchema, undefined, 'the final bounded turn permits completion only');
        if (turn) assert.equal(input.history[turn - 1].result.tool, order[turn - 1]);
        let output = turn < tools.length
          ? { decision: { ...(order[turn] === 'pod_logs' ? logs.decision : ask.decision), target: order[turn] } } : finish;
        if (scenario === 'partial-completion' && turn === 1) output = finish;
        if (scenario === 'duplicate-request' && turn === 1) output = ask;
        const text = scenario === 'invalid-json' ? 'This is not JSON.' : scenario === 'invalid-decision'
          ? JSON.stringify({ decision: { kind: 'request', target: 'pod_overview', input_json: {} } })
          : JSON.stringify(scenario === 'early-completion' ? finish : output);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: `offline-${scenario}-${turn}`, status: 'completed', model: body.model,
          output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
          usage: { input_tokens: 1425, output_tokens: 273, total_tokens: 1698 } }));
      } catch (error) {
        errors.push(error);
        response.writeHead(500); response.end('{}');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const credential = 'MAS_MCP_OFFLINE_HTTP_KEY', previous = process.env[credential];
    process.env[credential] = 'offline-fixture';
    t.after(() => { if (previous === undefined) delete process.env[credential]; else process.env[credential] = previous; });
    const actors = join(app.project, 'agents.mcp.toml');
    await writeFile(actors, (await readFile(actors, 'utf8'))
      .replace('api_key_env = "OPENAI_API_KEY"', `api_key_env = "${credential}"\nendpoint = "http://127.0.0.1:${address.port}/v1/responses"`));
    const id = `mcp-http-${scenario}`, seed = incident(id), host = new Host(app.options);
    const contextFile = join(app.folder, 'context.json'), inputFile = join(app.folder, 'input.json'), state = join(app.folder, 'host');
    const contextSha256 = await retainFile(contextFile, { version: 'mas-mcp-investigation/1',
      source: 'recorded-evidence', event: seed.event, evidence: seed.evidence,
      runtime_sha256: await runtimeIdentity(app.folder) });
    await retainFile(inputFile, { event: seed.event, subject, context_sha256: contextSha256 });
    // 'live' selects the OpenAI adapter; its endpoint is strictly this loopback
    // fixture. No external provider or Kubernetes credentials are used.
    const invoke = () => host.runInvestigation(id, inputFile, state, 'live', contextFile, contextSha256);
    if (valid) {
      const output = await invoke();
      assert.deepEqual(errors, []);
      assert.equal(requests.length, 5);
      const observation = await host.observe(id, state, true);
      const audit = freezeInvestigation(id, observation, seed.evidence, 'recorded-evidence', contextSha256);
      assert.deepEqual(audit.calls.map(call => call.tool), order);
      const deployment = audit.evidence!.items.find(item => item.id === 'workload-deployment')!.data as any;
      assert.equal(deployment.metadata.uid, 'deployment-fixture-uid');
      assert.equal(deployment.metadata.resourceVersion, '12345');
      assert.equal(deployment.spec.template.spec.containers[0].readinessProbe.httpGet.path, '/readyz');
      const logs = audit.evidence!.items.find(item => item.id === 'logs-checkout-current')!.data as any;
      assert.equal(logs.container, 'checkout');
      assert.equal(logs.previous, false);
      assert.deepEqual(logs.text.split('\n').map((line: string) => JSON.parse(line)), [
        { method: 'GET', path: '/readyz', status: 404 }, { method: 'GET', path: '/healthz', status: 200 },
      ]);
      assert.doesNotMatch(JSON.stringify(audit.evidence), /unrequested-previous-observation/);
      assert.ok(effects(observation).filter(step => step.key.startsWith('inference-'))
        .every(step => step.evidence.adapter === 'mas-host-openai/1' && step.output.output_status === 'valid'));
      assert.deepEqual(await invoke(), output);
      assert.equal(requests.length, 5, 'replay must not call the provider again');
    } else {
      const rejected = (error: unknown) => {
        assert.ok(error instanceof HostRunFailure);
        assert.equal(error.diagnostics.classification, 'invalid-output');
        assert.equal(error.diagnostics.automaticRetry, false);
        assert.equal(error.diagnostics.effects[0]?.actor, 'investigator');
        assert.equal(error.diagnostics.effects[0]?.httpStatus, 200);
        return true;
      };
      await assert.rejects(invoke, rejected);
      assert.deepEqual(errors, []);
      const observation = await host.observe(id, state, true);
      assert.equal(effects(observation).length, 2 * acceptedCalls + 1);
      const rejectedInference = effects(observation).find(step => step.key === `inference-${acceptedCalls}`)!;
      assert.equal(rejectedInference.state, 'completed');
      assert.equal(rejectedInference.output.output_status, 'invalid');
      assert.equal(effects(observation).filter(step => step.key === 'command').length, acceptedCalls,
        'rejected duplicate or premature completion must not dispatch another tool');
      assert.equal(observation.messages.filter((message: any) => tools.includes(message.recipient)).length, acceptedCalls);
      assert.throws(() => freezeInvestigation(id, observation, seed.evidence, 'recorded-evidence', contextSha256));
      await assert.rejects(invoke, rejected);
      assert.equal(requests.length, acceptedCalls + 1, 'known-invalid output must not retry the provider');
    }
  });
});

test('real host records four MCP tools, freezes their evidence, assesses a revision and replays no work', { timeout: 360_000 }, async t => {
  const app = await application(t), id = 'mcp-complete';
  let freezeChecked = false;
  class ObservedHost extends Host {
    override async runAssessed(...args: Parameters<Host['runAssessed']>) {
      const retained = JSON.parse(await readFile(join(app.directory, id, 'run.json'), 'utf8')) as Run;
      assert.equal(retained.investigation?.status, 'completed', 'Freeze must be durable before assessment dispatch');
      assert.equal(retained.investigation?.calls.length, 4);
      const source = JSON.parse(await readFile(args[1], 'utf8')).sources[0].content;
      assert.deepEqual(source.evidence, retained.investigation?.evidence);
      freezeChecked = true;
      return super.runAssessed(...args);
    }
  }
  const host = new ObservedHost(app.options), runs = new Runs(app.directory, 'fixture', host);
  await runs.initialise();
  await runs.create(incident(id));
  const run = await settled(runs, id);
  assert.equal(run.status, 'completed', JSON.stringify({ error: run.error, diagnostics: run.diagnostics }));
  assert.ok(freezeChecked);
  assert.equal(run.investigation?.status, 'completed');
  assert.equal(run.investigation?.source, 'recorded-evidence');
  assert.deepEqual(run.investigation?.calls.map(call => call.tool), tools);
  assert.ok(run.investigation?.calls.every(call => call.status === 'collected'));
  const evidence = run.investigation!.evidence!;
  assert.deepEqual(evidence.items.map(item => item.id).sort(), ['events', 'logs-checkout-current', 'metrics', 'pod', 'workload-deployment']);
  assert.doesNotMatch(JSON.stringify(evidence), /unrequested-previous-observation/);
  assert.deepEqual((run.input.incident as { evidence: EvidenceBundle }).evidence, evidence);
  assert.equal(run.revision?.status, 'completed');
  assert.equal(run.revision?.candidates.length, 2);
  assert.equal(run.revision?.assessments[0]?.findings.find(finding => finding.criterion_id === 'evidence-references')?.verdict, 'fail');
  assert.ok(run.revision?.assessments[1]?.findings.every(finding => finding.verdict === 'pass'));
  assert.equal((run.output as any).remediation.action, 'replace_readiness_probe_path');

  const directory = join(app.directory, id), acquisitionState = join(directory, 'investigation', 'host');
  const acquired = await host.observe(id, acquisitionState, true);
  assert.equal(effects(acquired).length, 9, 'Five model turns and four command calls have separate admitted effects');
  assert.equal(effects(acquired).filter(step => step.key === 'command').length, 4);
  assert.equal(acquired.calls.length, 9);
  const acquiredCalls = effects(acquired).filter(step => step.key === 'command');
  assert.deepEqual(acquiredCalls.map(step => step.actor), tools);
  assert.ok(acquiredCalls.every(step => step.state === 'completed' && step.output.output.source === 'recorded-evidence'));
  const contextFile = join(directory, 'investigation', 'context.json');
  const investigationInput = join(directory, 'investigation', 'input.json');
  assert.deepEqual(await host.runInvestigation(id, investigationInput, acquisitionState, 'fixture', contextFile,
    run.investigation!.contextSha256!), run.investigation!.summary);
  const replayed = await host.observe(id, acquisitionState, true);
  assert.deepEqual(replayed.steps, acquired.steps);
  assert.deepEqual(replayed.calls, acquired.calls);
  assert.deepEqual(replayed.messages, acquired.messages);

  const assessmentState = join(directory, 'host'), assessed = await host.observe(id, assessmentState, true);
  const expectedOutput = structuredClone(run.output), expectedEvidence = structuredClone(evidence);
  // Simulate losing only the terminal API manifest after the freeze and both
  // host journals are durable. Recovery must not re-enter acquisition.
  await writeFile(join(directory, 'run.json'), JSON.stringify({ ...run, status: 'running' }));
  class FrozenRecoveryHost extends Host {
    override async runInvestigation(): Promise<never> { throw new Error('A frozen investigation must not be executed again'); }
  }
  const recoveredHost = new FrozenRecoveryHost(app.options), recovered = new Runs(app.directory, 'fixture', recoveredHost);
  await recovered.initialise();
  const recoveredRun = await settled(recovered, id);
  assert.equal(recoveredRun.status, 'completed', recoveredRun.error);
  assert.deepEqual(recoveredRun.output, expectedOutput);
  assert.deepEqual(recoveredRun.investigation?.evidence, expectedEvidence);
  assert.deepEqual((await recoveredHost.observe(id, acquisitionState, true)).steps, acquired.steps);
  const recoveredAssessment = await recoveredHost.observe(id, assessmentState, true);
  assert.deepEqual(recoveredAssessment.steps, assessed.steps);
  assert.deepEqual(recoveredAssessment.calls, assessed.calls);
  assert.deepEqual(recoveredAssessment.messages, assessed.messages);
});

test('recovery after acquisition completed but before freeze reuses the exact context and all tool outcomes', { timeout: 360_000 }, async t => {
  const app = await application(t), id = 'mcp-unfrozen';
  class LostResponseHost extends Host {
    override async runInvestigation(...args: Parameters<Host['runInvestigation']>): Promise<never> {
      await super.runInvestigation(...args);
      throw new Error('Simulated API process loss after acquisition host completion');
    }
    override async runAssessed(): Promise<never> { throw new Error('Assessment cannot start before evidence freeze'); }
  }
  const initialHost = new LostResponseHost(app.options), initial = new Runs(app.directory, 'fixture', initialHost);
  await initial.initialise();
  await initial.create(incident(id));
  const interrupted = await settled(initial, id);
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.investigation?.status, 'failed');
  assert.equal(interrupted.investigation?.evidence, undefined);
  const directory = join(app.directory, id), state = join(directory, 'investigation', 'host');
  const before = await initialHost.observe(id, state, true);
  assert.equal(effects(before).length, 9);
  assert.ok(effects(before).every(step => step.state === 'completed'));
  const contextFile = join(directory, 'investigation', 'context.json'), inputFile = join(directory, 'investigation', 'input.json');
  const contextBytes = await readFile(contextFile, 'utf8'), inputBytes = await readFile(inputFile, 'utf8');
  // A real process loss leaves the last pre-freeze admission record running.
  const retained = { ...interrupted, status: 'running', error: undefined,
    investigation: { ...interrupted.investigation!, status: 'running', error: undefined } };
  await writeFile(join(directory, 'run.json'), JSON.stringify(retained));
  const host = new Host(app.options), recovered = new Runs(app.directory, 'fixture', host);
  await recovered.initialise();
  const completed = await settled(recovered, id);
  assert.equal(completed.status, 'completed', JSON.stringify({ error: completed.error, diagnostics: completed.diagnostics }));
  assert.equal(completed.investigation?.status, 'completed');
  assert.equal(completed.revision?.status, 'completed');
  assert.equal(await readFile(contextFile, 'utf8'), contextBytes);
  assert.equal(await readFile(inputFile, 'utf8'), inputBytes);
  assert.equal(completed.investigation?.contextSha256, interrupted.investigation?.contextSha256);
  const after = await host.observe(id, state, true);
  assert.deepEqual(after.steps, before.steps);
  assert.deepEqual(after.calls, before.calls);
  assert.deepEqual(after.messages, before.messages);
});
