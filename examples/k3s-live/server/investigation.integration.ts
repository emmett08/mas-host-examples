// Exercise the pinned host, real MCP stdio sessions and independent assessment.
// The model provider is scripted; these checks make no external inference calls.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Host, type HostOptions } from './host.js';
import { Runs, type Run } from './runs.js';
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
