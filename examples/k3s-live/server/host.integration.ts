// Execute the real pinned host and existing protocol with deterministic command-provider fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { canonicalJson, parseRevisionAudit, verifyRevisionDigests, type RevisionAudit } from '../shared/revision.mjs';
import { quorumInput } from '../deploy/quorum-input.mjs';
import { Host, HostRunFailure } from './host.js';
import { Runs } from './runs.js';

test('real MAS host exercises the hybrid branch, correlated replies, and durable replay', async t => {
  const binary = resolve(process.env.MAS_HOST_BIN ?? '../../.tools/mas-host/target/debug/mas-host');
  const sdk = resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host');
  const folder = await mkdtemp(join(tmpdir(), 'mas-hybrid-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const project = await fixtureProject(folder);
  const host = new Host({ binary, sdk, project, payloads: true });
  const input = join(folder, 'input.json');
  await writeFile(input, JSON.stringify({ incident: { reason: 'BackOff', source: 'fixture' } }));
  const output = await host.run('hybrid-test', input, folder, 'fixture') as Record<string, unknown>;
  assert.equal(output.requires_human, true);
  const snapshot = await host.observe('hybrid-test', folder);
  const messages = snapshot.messages as { id: string; sender: string; recipient: string; kind: string; correlation: string; taskId: string }[];
  const requests = messages.filter(m => m.kind === 'request');
  assert.equal(requests.length, 8);
  assert.ok(requests.some(m => m.sender === 'platform' && m.recipient === 'security'));
  assert.equal(requests.filter(m => m.sender === 'security' && m.recipient === 'security_review').length, 2);
  assert.equal(messages.filter(m => m.kind === 'result').length, 8);
  for (const request of requests) assert.ok(messages.some(m => m.kind === 'result' && m.correlation === request.id));
  assert.deepEqual(await host.run('hybrid-test', input, folder, 'fixture'), output);
  assert.equal((await host.observe('hybrid-test', folder)).messages.length, messages.length);
});

test('recording fixture command providers produce schema-valid results with observable active message growth', { timeout: 60_000 }, async t => {
  const binary = resolve(process.env.MAS_HOST_BIN ?? '../../.tools/mas-host/target/debug/mas-host');
  const sdk = resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host');
  const folder = await mkdtemp(join(tmpdir(), 'mas-paced-fixture-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const project = await fixtureProject(folder);
  const host = new Host({ binary, sdk, project, payloads: true, fixtureRecording: true });
  const state = join(folder, 'state');
  const input = join(folder, 'input.json');
  await writeFile(input, JSON.stringify({ incident: { reason: 'BackOff', source: 'fixture' } }));
  // The host enforces review.json and decision.json on all command-provider
  // results. Sampling its actual observations also proves the deliberate pacing
  // leaves more than one active message count for a recording subscriber.
  let settled = false;
  const completion = host.run('paced-fixture-test', input, state, 'fixture');
  void completion.then(() => { settled = true; }, () => { settled = true; });
  const counts = new Set<number>();
  while (!settled) {
    try {
      const snapshot = await host.observe('paced-fixture-test', state);
      if (!settled && snapshot.messages.length > 0) counts.add(snapshot.messages.length);
    } catch { /* The initial host databases do not exist before run admission. */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const output = await completion as Record<string, unknown>;
  assert.equal(output.requires_human, true);
  assert.match(String(output.summary), /^Paced fixture investigation plan:/);
  assert.ok(counts.size > 1, 'The active host trace must expose increasing message counts before completion');
  const snapshot = await host.observe('paced-fixture-test', state);
  assert.equal(snapshot.messages.length, 16);
});

async function fixtureProject(folder: string) {
  const project = join(folder, 'project');
  await cp(resolve('project'), project, { recursive: true, filter: source => basename(source) !== '.mas' });
  // Container node is on the host's fixed PATH. Local runtimes may install it
  // elsewhere; adapt only temporary integration-test projects.
  for (const name of ['connections.fixture.toml', 'connections.recording.toml', 'connections.assessment-fixture.toml', 'connections.assessment-recording.toml', 'connections.quorum-fixture.toml']) {
    const profile = join(project, name), source = await readFile(profile, 'utf8');
    await writeFile(profile, source.replaceAll('command = ["node",', `command = [${JSON.stringify(process.execPath)},`));
  }
  return project;
}

test('real host retains a defective draft, exact findings and bounded revision; replay adds no work', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'mas-assessed-incident-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const project = await fixtureProject(folder);
  const host = new Host({ binary: resolve(process.env.MAS_HOST_BIN ?? '../../.tools/mas-host/target/debug/mas-host'),
    sdk: resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host'), project, payloads: true,
    revisionPlan: join(project, 'revision.json') });
  const input = join(folder, 'input.json'), state = join(folder, 'runs', 'assessed-incident', 'host');
  await writeFile(input, JSON.stringify({ sources: [{ id: 'incident', kind: 'evidence',
    content: { reason: 'BackOff', source: 'fixture' }, readers: ['*'] }] }));
  const result = await host.runAssessed('assessed-incident', input, state, 'fixture');
  assert.equal(result.revision.status, 'completed');
  assert.equal(result.revision.candidates.length, 2);
  assert.equal(result.revision.assessments.length, 2);
  const [draft, revised] = result.revision.candidates;
  const [first, second] = result.revision.assessments;
  assert.equal(draft!.parent, null);
  assert.equal(revised!.parent!.id, draft!.id);
  assert.equal(revised!.feedback[0]!.id, first!.id);
  assert.equal(first!.candidate.id, draft!.id);
  assert.equal(first!.findings.find(row => row.criterion_id === 'evidence-references')!.verdict, 'fail');
  assert.ok(second!.findings.every(row => row.verdict === 'pass'));
  assert.deepEqual(result.output, revised!.output);
  const reviewInput = await quorumInput(result);
  assert.deepEqual(reviewInput.candidate, result.revision.selected);
  assert.deepEqual(reviewInput.candidate_record, revised);
  for (const context of result.revision.contexts.filter(row => row.actor === 'incident_checks')) {
    assert.deepEqual(context.input!.feedback, [], 'The independent deterministic evaluator receives no earlier assessment');
  }
  const snapshot = await host.observe('assessed-incident', state);
  assert.equal(snapshot.messages.length, result.revision.contexts.length * 2);
  assert.equal(snapshot.messages.filter((row: { recipient: string; kind: string }) => row.recipient === 'decision' && row.kind === 'request').length, 2);
  assert.deepEqual(await host.runAssessed('assessed-incident', input, state, 'fixture'), result);
  assert.equal((await host.observe('assessed-incident', state)).messages.length, snapshot.messages.length);
  // Simulate API process loss after the host journal completed but before its
  // run.json terminal rename. Startup must reuse that exact journal and output.
  await writeFile(join(folder, 'runs', 'assessed-incident', 'run.json'), JSON.stringify({ id: 'assessed-incident',
    mode: 'fixture', status: 'running', startedAt: '2026-10-16T12:00:00Z', revisionEnabled: true,
    input: { incident: { reason: 'BackOff', source: 'fixture' } }, fingerprint: 'test-input' }));
  const recovered = new Runs(join(folder, 'runs'), 'fixture', host);
  await recovered.initialise();
  const deadline = Date.now() + 30_000;
  while (recovered.get('assessed-incident').status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(recovered.get('assessed-incident').status, 'completed');
  assert.deepEqual(recovered.get('assessed-incident').output, result.output);
  const remediation = await recovered.remediationSnapshot('assessed-incident');
  assert.deepEqual(remediation.run.output, revised!.output);
  assert.deepEqual(remediation.run.revisionSelection, { status: 'completed', candidate: result.revision.selected,
    output_sha256: revised!.output_sha256 });
  assert.equal('revision' in remediation.run, false);
  assert.equal((await host.observe('assessed-incident', state)).messages.length, snapshot.messages.length);
});

const execute = promisify(execFile);
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const reference = (record: { id: string }) => ({ id: record.id, sha256: digest(record) });
function nativeHostArgs(project: string, input: string, state: string, run: string, agent: string) {
  return ['run', '--project', project, '--sdk-root', resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host'),
    '--input', input, '--state', state, '--run', run, '--agent', agent];
}
async function nativeCommand(args: string[]) {
  return execute(resolve(process.env.MAS_HOST_BIN ?? '../../.tools/mas-host/target/debug/mas-host'), args,
    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
}
async function nativeRun(args: string[]) {
  return JSON.parse((await nativeCommand(args)).stdout) as { output: Record<string, any>; revision: RevisionAudit };
}

test('mixed native and model-adapter reviews count only the exact candidate and frozen review context', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'mas-candidate-quorum-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const project = await fixtureProject(folder);
  const rubric = JSON.parse(await readFile(join(project, 'revision.json'), 'utf8')).rubric;
  const incident = { reason: 'BackOff', source: 'fixture', evidence: { items: [] } };
  const evidence = [{ schema_version: 1, id: 'incident', content: incident, content_sha256: digest(incident) }];
  const output = { summary: 'Insufficient evidence; collect logs.', confidence: 'low', next_checks: ['Collect logs'],
    requires_human: true, evidence_ids: [], remediation: { action: 'none', evidence_ids: [] } };
  const candidate = { schema_version: 1, id: 'candidate-conformance', output, output_sha256: digest(output), parent: null, feedback: [] };
  const input = join(folder, 'input.json');
  await writeFile(input, JSON.stringify({ candidate: reference(candidate), candidate_record: candidate, incident, evidence, rubric,
    review_context: { criterion_id: 'incident-constraints/1:all', rubric: reference(rubric), evidence: evidence.map(reference) } }));
  const profile = join(project, 'connections.quorum-fixture.toml');
  const source = await readFile(profile, 'utf8');
  const state = join(folder, 'state');
  const args = (run: string) => [...nativeHostArgs(project, input, state, run, 'review_quorum'), '--connections', profile];
  const passed = await nativeRun(args('same-candidate'));
  assert.equal(passed.output.join.accepted, true);
  assert.deepEqual(passed.output.join.candidate, reference(candidate));
  assert.deepEqual(passed.output.join.selected.map((row: { actor: string }) => row.actor), ['constraint_vote', 'model_vote']);
  assert.deepEqual(await nativeRun(args('same-candidate')), passed, 'Replay cannot collect a second vote');
  for (const wrong of ['candidate', 'context']) {
    await writeFile(profile, source.replace('"vote"]', `"vote","--wrong-${wrong}"]`));
    const rejected = await nativeRun(args(`wrong-${wrong}`));
    assert.equal(rejected.output.results[1].accepted, true, 'The adversarial vote must otherwise claim acceptance');
    assert.equal(rejected.output.join.accepted, false);
    assert.deepEqual(rejected.output.join.selected, []);
    assert.equal(rejected.output.join.observations[1].status, 'mismatched');
  }
  await writeFile(profile, source);
  const changed = JSON.parse(await readFile(input, 'utf8'));
  changed.candidate_record.output.summary = 'Changed after candidate identity was frozen';
  await writeFile(input, JSON.stringify(changed));
  const corrupt = await nativeRun(args('changed-content'));
  assert.equal(corrupt.output.results[0].accepted, false);
  assert.equal(corrupt.output.join.accepted, false);
});

test('host rejects forged evaluator bindings and foreign evidence, retains exhausted history, and replays no work', async t => {
  for (const defect of ['candidate', 'rubric', 'evaluator', 'evidence']) {
    await t.test(defect, async t => {
      const folder = await mkdtemp(join(tmpdir(), `mas-assessment-${defect}-`));
      t.after(() => rm(folder, { recursive: true, force: true }));
      const project = await fixtureProject(folder);
      const evaluator = join(project, 'assessment.py');
      const source = await readFile(evaluator, 'utf8');
      const malicious = defect === 'evidence'
        ? 'for finding in findings:\n        finding["evidence"] = [{"id": "foreign-evidence", "sha256": "0" * 64}]\n    return {"status": "completed", "findings": findings}'
        : `return {"status": "completed", "findings": findings, "${defect}": {"id": "forged", "sha256": "0" * 64}}`;
      await writeFile(evaluator, source.replace('return {"status": "completed", "findings": findings}', malicious));
      const plan = join(project, 'revision.json');
      const frozen = JSON.parse(await readFile(plan, 'utf8'));
      frozen.max_revisions = 0;
      await writeFile(plan, JSON.stringify(frozen));
      const input = join(folder, 'input.json'), state = join(folder, 'state');
      await writeFile(input, JSON.stringify({ sources: [{ id: 'incident', kind: 'evidence', content: { reason: 'BackOff' }, readers: ['*'] }] }));
      const args = [...nativeHostArgs(project, input, state, `forged-${defect}`, 'assessed_draft'),
        '--revision-plan', plan, '--connections', join(project, 'connections.assessment-fixture.toml')];
      const result = await nativeRun(args);
      const audit = parseRevisionAudit(result.revision);
      await verifyRevisionDigests(audit);
      assert.equal(audit.status, 'exhausted');
      assert.equal(audit.candidates.length, 1);
      assert.equal(audit.assessments.length, 1);
      const assessment = audit.assessments[0]!;
      assert.equal(assessment.status, 'error');
      assert.deepEqual(assessment.findings, []);
      assert.deepEqual(assessment.evaluator, frozen.evaluators[0].identity);
      assert.deepEqual(assessment.candidate, reference(audit.candidates[0]!));
      assert.deepEqual(assessment.rubric, reference(frozen.rubric));
      assert.ok(assessment.error);
      assert.deepEqual(await nativeRun(args), result, 'Exhausted replay must preserve assessments and invocation count');
      const changed = { ...frozen, max_revisions: 1 };
      await writeFile(plan, JSON.stringify(changed));
      await assert.rejects(nativeCommand(args), error => {
        assert.match(String((error as { stderr: string }).stderr), /differs from retained/);
        return true;
      });
    });
  }
});

test('reserved source identities fail preflight before dispatching a scripted provider or deterministic worker', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'mas-reserved-evidence-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const project = await fixtureProject(folder);
  for (const id of ['candidate-0-output', 'attempt-assessment-0-0', 'budget-revision']) {
    const input = join(folder, `${id}.json`), state = join(folder, 'state');
    await writeFile(input, JSON.stringify({ sources: [
      { id: 'incident', kind: 'evidence', content: { reason: 'BackOff' }, readers: ['*'] },
      { id, kind: 'evidence', content: { note: 'Untrusted caller attempts a host identity collision' }, readers: ['*'] },
    ] }));
    const args = [...nativeHostArgs(project, input, state, id, 'assessed_draft'),
      '--revision-plan', join(project, 'revision.json'), '--connections', join(project, 'connections.assessment-fixture.toml')];
    await assert.rejects(nativeCommand(args), error => {
      assert.match(String((error as { stderr: string }).stderr), /host-reserved evidence prefix/);
      return true;
    });
    const snapshot = JSON.parse((await nativeCommand(['observe', '--state', state, '--run', id, '--include-payloads', 'true'])).stdout);
    assert.deepEqual(snapshot.messages, []);
    assert.deepEqual(snapshot.calls, []);
    assert.deepEqual(snapshot.steps, []);
  }
});

test('a supplied bundle with an impossible root reply route starts no worker or provider call', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'mas-reply-preflight-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const project = await fixtureProject(folder);
  const built = JSON.parse((await nativeCommand(['build', '--project', project,
    '--sdk-root', resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host'),
    '--connections', join(project, 'connections.quorum-fixture.toml')])).stdout);
  const bundle = JSON.parse(await readFile(built.bundle, 'utf8'));
  bundle.topology.edges = bundle.topology.edges.filter(([from, to]: string[]) => !(from === 'review_quorum' && to === 'client'));
  const supplied = join(folder, 'one-way-bundle.json'), input = join(folder, 'input.json'), state = join(folder, 'state');
  await writeFile(supplied, JSON.stringify(bundle));
  await writeFile(input, '{}');
  await assert.rejects(nativeCommand(['run', '--bundle', supplied, '--agent', 'review_quorum', '--input', input,
    '--state', state, '--run', 'no-reply']), error => {
    assert.match(String((error as { stderr: string }).stderr), /task reply route forbidden/);
    return true;
  });
  const snapshot = JSON.parse((await nativeCommand(['observe', '--state', state, '--run', 'no-reply', '--include-payloads', 'true'])).stdout);
  assert.deepEqual(snapshot.messages, []);
  assert.deepEqual(snapshot.calls, []);
  assert.deepEqual(snapshot.steps, []);
});

test('real host forwards evidence through both reviews and returns a schema-valid identity-bound readiness proposal', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'mas-evidence-flow-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const project = await fixtureProject(folder);
  const host = new Host({ binary: resolve(process.env.MAS_HOST_BIN ?? '../../.tools/mas-host/target/debug/mas-host'),
    sdk: resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host'), project, payloads: true });
  const input = join(folder, 'input.json'), state = join(folder, 'state');
  const observedAt = new Date().toISOString();
  await writeFile(input, JSON.stringify({ incident: { source: 'test-supplied-evidence', evidence: {
    version: 'mas-k8s-evidence/1', capturedAt: observedAt, subject: { namespace: 'mas-demo', name: 'test-pod', uid: 'pod-test-uid' }, items: [
      { id: 'pod', kind: 'pod', source: 'fixture', observedAt, status: 'collected', truncated: false, data: {
        kind: 'Pod', metadata: { namespace: 'mas-demo', name: 'test-pod', uid: 'pod-test-uid' }, status: { conditions: [{ type: 'Ready', status: 'False' }] },
      } },
      { id: 'workload-deployment', kind: 'workload', source: 'fixture', observedAt, status: 'collected', truncated: false, data: {
        kind: 'Deployment', metadata: { namespace: 'mas-demo', name: 'mas-demo-checkout', uid: 'deployment-test-uid', resourceVersion: '12345' },
        spec: { template: { spec: { containers: [{ name: 'checkout', command: ['node', '/app/deploy/probe-app.mjs'], readinessProbe: { httpGet: { path: '/readyz' } }, livenessProbe: { httpGet: { path: '/healthz' } } }] } } },
      } },
      { id: 'logs-checkout-current', kind: 'logs', source: 'fixture', observedAt, status: 'collected', truncated: false, data: {
        container: 'checkout', previous: false, text: `${observedAt} {"method":"GET","path":"/readyz","status":404}\n${observedAt} {"method":"GET","path":"/healthz","status":200}`,
      } },
    ],
  } } }));
  const output = await host.run('evidence-flow', input, state, 'fixture') as { requires_human: boolean; remediation: { action: string; target: { uid: string; resource_version: string }; evidence_ids: string[] } };
  assert.equal(output.requires_human, false);
  assert.equal(output.remediation.action, 'replace_readiness_probe_path');
  assert.equal(output.remediation.target.uid, 'deployment-test-uid');
  assert.equal(output.remediation.target.resource_version, '12345');
  assert.deepEqual(output.remediation.evidence_ids, ['pod', 'workload-deployment', 'logs-checkout-current']);
  assert.equal((await host.observe('evidence-flow', state)).messages.length, 16);
});

test('a real host HTTP rejection retains safe diagnostics without repeating model calls', { timeout: 60_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'mas-provider-rejection-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const requests: unknown[] = [];
  const secretMarker = 'private-provider-error-message-and-credential';
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'invalid_json_schema', type: 'invalid_request_error',
      param: 'text.format.schema', message: secretMarker } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/v1/responses`;
  const keyName = 'MAS_DEMO_REJECTION_TEST_KEY';
  const previous = process.env[keyName];
  process.env[keyName] = secretMarker;
  t.after(() => { if (previous === undefined) delete process.env[keyName]; else process.env[keyName] = previous; });
  const project = join(folder, 'project');
  await cp(resolve('project'), project, { recursive: true, filter: source => basename(source) !== '.mas' });
  const agents = join(project, 'agents.toml');
  const source = await readFile(agents, 'utf8');
  assert.equal(source.match(/kind = "openai"/g)?.length, 3);
  // Every connection points only to our rejecting loopback server. No provider
  // credentials or external inference are used by this integration test.
  await writeFile(agents, source.replaceAll('kind = "openai"', `kind = "openai"\nendpoint = "${endpoint}"`)
    .replaceAll('api_key_env = "OPENAI_API_KEY"', `api_key_env = "${keyName}"`));
  const host = new Host({ binary: resolve(process.env.MAS_HOST_BIN ?? '../../.tools/mas-host/target/debug/mas-host'),
    sdk: resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host'), project, payloads: false });
  const input = join(folder, 'input.json');
  const state = join(folder, 'state');
  await writeFile(input, JSON.stringify({ incident: { reason: 'BackOff' } }));
  const isSafeRejection = (error: unknown) => {
    assert.ok(error instanceof HostRunFailure);
    assert.match(error.message, /400/);
    assert.ok(error.diagnostics.effects.length > 0);
    assert.ok(error.diagnostics.effects.every(effect => effect.httpStatus === 400 && effect.errorCode === 'invalid_json_schema'));
    assert.ok(!JSON.stringify(error.diagnostics).includes(secretMarker));
    assert.ok(!error.message.includes(secretMarker));
    return true;
  };
  await assert.rejects(host.run('rejected', input, state, 'live'), isSafeRejection);
  assert.equal(requests.length, 2);
  // A rejected effect is retained. Reopening the same run does not resend it.
  await assert.rejects(host.run('rejected', input, state, 'live'), isSafeRejection);
  assert.equal(requests.length, 2);
});
