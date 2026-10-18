import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureIncident, failureReport, observeCanvasProgress, prepareIncident, selectRemediationForRun, selectRunForPod, validateCanvasProgress, validateControllerResolution, validateDistinctRecoveries, validateIncidentIdentity, validateMcpInvestigation, validateSnapshot } from './record-demo.mjs';
import { managedWorkloads } from '../shared/workloads.mjs';
import { canonicalJson, verifyRevisionDigests, verifySelectedOutput } from '../shared/revision.mjs';

function completed() {
  const routes = [
    ['client', 'coordinator'], ['coordinator', 'platform'], ['coordinator', 'security'],
    ['platform', 'platform_diagnosis'], ['platform', 'security'],
    ['security', 'security_review'], ['security', 'security_review'], ['coordinator', 'decision'],
  ];
  const messages = routes.flatMap(([sender, recipient], index) => [
    { id: `request-${index}`, sequence: index * 2 + 1, sender, recipient, kind: 'request', payload: { input: {} } },
    { id: `result-${index}`, sequence: index * 2 + 2, sender: recipient, recipient: sender,
      kind: 'result', correlation: `request-${index}`, payload: { output: {}, reply_to: `request-${index}` } },
  ]);
  return { run: { id: 'k8s-uid', mode: 'live', status: 'completed', output: {} },
    observationAvailable: true, observation: { payloads_included: true, messages } };
}

function incidentSnapshot(workload = managedWorkloads[1]) {
  const snapshot = completed();
  snapshot.run.id = `k8s-${workload.approach}-uid`;
  snapshot.run.approach = workload.approach;
  const subject = { kind: 'Pod', namespace: workload.namespace, name: `${workload.name}-pod`, uid: `${workload.approach}-pod-uid` };
  snapshot.run.input = { incident: { event: { namespace: workload.namespace, involvedObject: structuredClone(subject) }, evidence: {} } };
  snapshot.run.output = { requires_human: false, remediation: { action: 'replace_readiness_probe_path' } };
  const observedAt = '2026-10-17T19:00:00.000Z';
  const probes = { name: 'checkout', readinessProbe: { httpGet: { path: workload.currentPath } }, livenessProbe: { httpGet: { path: '/healthz' } } };
  const item = (id, kind, data) => ({ id, kind, status: 'collected', observedAt, data });
  const items = [
    item('pod', 'pod', { kind: 'Pod', metadata: { ...subject, ownerReferences: [{ controller: true, kind: 'ReplicaSet', uid: 'rs-uid' }] },
      spec: { containers: [probes] }, status: { conditions: [{ type: 'Ready', status: 'False' }] } }),
    item('events', 'events', [{ type: 'Warning', reason: 'Unhealthy', involvedObject: subject }]),
    item('workload-replicaset', 'workload', { metadata: { uid: 'rs-uid', ownerReferences: [{ controller: true, kind: 'Deployment', uid: `${workload.approach}-deployment-uid` }] } }),
    item('workload-deployment', 'workload', { kind: 'Deployment', metadata: { namespace: 'mas-demo', name: workload.name, uid: `${workload.approach}-deployment-uid`, resourceVersion: '12345' },
      spec: { template: { spec: { containers: [structuredClone(probes)] } } } }),
    item('logs-checkout-current', 'logs', { container: 'checkout', previous: false,
      text: `${JSON.stringify({ method: 'GET', path: workload.currentPath, status: 404 })}\n{"method":"GET","path":"/healthz","status":200}` }),
    item('metrics', 'metrics', { metadata: subject, timestamp: observedAt, window: '15s', containers: [{ name: 'checkout', usage: { cpu: '1m', memory: '16Mi' } }] }),
  ];
  const tools = ['pod_overview', 'workload_spec', 'pod_logs', 'pod_metrics'];
  const ids = [['pod', 'events'], ['workload-replicaset', 'workload-deployment'], ['logs-checkout-current'], ['metrics']];
  snapshot.run.investigation = { runId: 'investigation-run', status: 'completed', source: 'kubernetes-api',
    evidence: { version: 'mas-k8s-evidence/1', capturedAt: observedAt, subject, items },
    calls: tools.map((tool, index) => ({ id: `effect-${index}`, tool, status: 'collected', evidenceIds: ids[index] })) };
  snapshot.run.input.incident.evidence = structuredClone(snapshot.run.investigation.evidence);
  snapshot.investigationObservation = { payloads_included: true, observed_at_ms: 1,
    messages: tools.flatMap((tool, index) => [
      { id: `tool-request-${index}`, sequence: index * 2 + 1, kind: 'request', sender: 'investigator', recipient: tool, payload: {} },
      { id: `tool-result-${index}`, sequence: index * 2 + 2, kind: 'result', sender: tool, recipient: 'investigator', correlation: `tool-request-${index}`, payload: { output: {} } },
    ]) };
  return snapshot;
}

function addRecovery(snapshot, workload) {
  snapshot.run.resolution = { version: 'mas-k8s-resolution/2', operationId: `${workload.approach}-operation`, attemptId: 'shared-controller-owner',
    effectOutcome: 'applied', verificationOutcome: 'passed', status: 'verified',
    target: { namespace: workload.namespace, name: workload.name, uid: `${workload.approach}-deployment-uid` },
    recordedAt: '2026-10-18T07:00:20Z', before: { observedAt: '2026-10-18T07:00:00Z' },
    after: { observedAt: '2026-10-18T07:00:20Z', pod: { name: `${workload.name}-replacement`, uid: `${workload.approach}-new-pod`, readyTransitionTime: '2026-10-18T07:00:04Z' } },
    checks: ['Post-change logs', 'Post-change events'].map(name => ({ name, passed: true })),
    verificationEvidence: { version: 'mas-k8s-post-change-evidence/1',
      subject: { namespace: workload.namespace, name: `${workload.name}-replacement`, uid: `${workload.approach}-new-pod`, container: workload.container },
      window: { startedAt: '2026-10-18T07:00:05Z', endedAt: '2026-10-18T07:00:18Z' },
      logs: { status: 'collected', source: 'Kubernetes API logs', observedAt: '2026-10-18T07:00:17Z', truncated: false,
        records: [{ timestamp: '2026-10-18T07:00:15Z', method: 'GET', path: '/healthz', status: 200 }], omittedLines: 0, unparsedLines: 0 },
      events: { status: 'collected', source: 'Kubernetes API events', observedAt: '2026-10-18T07:00:18Z', truncated: false, items: [] } } };
  return snapshot;
}

function admission(snapshot, workload) {
  return { metadata: { uid: `${workload.approach}-uid` },
    spec: { approach: workload.approach, event: structuredClone(snapshot.run.input.incident.event) },
    status: { runId: snapshot.run.id } };
}

test('MCP capture requires real tool envelopes and frozen evidence for its own admitted Pod', () => {
  assert.doesNotThrow(() => validateMcpInvestigation(incidentSnapshot(), 'live', 'k8s-mcp-uid'));
  for (const [change, pattern] of [
    [snapshot => { snapshot.run.approach = 'collected'; }, /admitted incident/],
    [snapshot => { snapshot.run.input.incident.event.involvedObject.uid = 'other-pod'; }, /admitted incident/],
    [snapshot => { delete snapshot.run.investigation.evidence; }, /frozen incident evidence/],
    [snapshot => { snapshot.run.investigation.source = 'recorded-evidence'; }, /actual Kubernetes API/],
    [snapshot => { snapshot.run.investigation.calls = []; }, /all four distinct MCP tool calls/],
    [snapshot => { snapshot.investigationObservation.payloads_included = false; }, /SHOW_PAYLOADS/],
    [snapshot => { delete snapshot.investigationObservation.messages[0].payload; }, /SHOW_PAYLOADS/],
    [snapshot => { snapshot.investigationObservation.messages[1].correlation = 'missing-request'; }, /correlated reverse-routed/],
    [snapshot => { snapshot.run.investigation.calls[0].tool = 'invented-tool'; }, /all four distinct MCP tool calls/],
    [snapshot => { snapshot.run.investigation.calls[0].evidenceIds = ['invented-evidence']; }, /frozen evidence/],
    [snapshot => { snapshot.investigationObservation.messages[1].sequence = 1; }, /identities or order/],
  ]) {
    const altered = incidentSnapshot(); change(altered);
    assert.throws(() => validateMcpInvestigation(altered, 'live', altered.run.id), pattern);
  }
});

test('MCP capture rejects another policy, incomplete endpoint proof and wrongly selected logs', () => {
  for (const change of [
    bundle => { bundle.items.find(item => item.id === 'logs-checkout-current').data.container = 'sidecar'; },
    bundle => { bundle.items.find(item => item.id === 'logs-checkout-current').data.previous = true; },
    bundle => { bundle.items.find(item => item.id === 'logs-checkout-current').data.text = '{"method":"GET","path":"/ready","status":404}'; },
    bundle => { bundle.items.find(item => item.id === 'logs-checkout-current').data.text = '{"method":"GET","path":"/healthz","status":200}'; },
    bundle => { delete bundle.items.find(item => item.id === 'workload-deployment').data.metadata.resourceVersion; },
    bundle => { bundle.items.find(item => item.id === 'workload-deployment').data.metadata.name = 'mas-demo-checkout'; },
    bundle => { bundle.items.find(item => item.id === 'workload-deployment').data.spec.template.spec.containers[0].readinessProbe.httpGet.path = '/other'; },
    bundle => { bundle.items.find(item => item.id === 'metrics').status = 'unavailable'; },
  ]) {
    const snapshot = incidentSnapshot(); change(snapshot.run.investigation.evidence);
    snapshot.run.input.incident.evidence = structuredClone(snapshot.run.investigation.evidence);
    assert.throws(() => validateMcpInvestigation(snapshot, 'live', snapshot.run.id), /requires|collected|readiness failure|cannot remediate/);
  }
});

test('recording rejects API-only runs, changed approaches and another workload identity', () => {
  const workload = managedWorkloads[1], snapshot = incidentSnapshot(workload), resource = admission(snapshot, workload);
  const subject = snapshot.run.input.incident.evidence.subject;
  const trigger = { podUID: subject.uid, podName: subject.name, deploymentUID: 'mcp-deployment-uid' };
  assert.doesNotThrow(() => validateIncidentIdentity(snapshot, resource, trigger, workload));
  const apiOnly = structuredClone(snapshot); apiOnly.run.id = 'mcp-api-only';
  assert.throws(() => validateIncidentIdentity(apiOnly, resource, trigger, workload), /operator-admitted/);
  assert.throws(() => validateIncidentIdentity(snapshot, { ...resource, spec: { ...resource.spec, approach: 'collected' } }, trigger, workload), /operator-admitted/);
  assert.throws(() => validateIncidentIdentity(snapshot, resource, { ...trigger, podUID: 'another-pod' }, workload), /operator-admitted/);
  assert.throws(() => validateIncidentIdentity(snapshot, resource, { ...trigger, deploymentUID: 'another-deployment' }, workload), /another managed Deployment/);
});

test('both capture paths retain their own admission, growing canvas and durable verified controller repair', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mas-independent-capture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const captures = [];
  for (const workload of managedWorkloads) {
    const final = addRecovery(incidentSnapshot(workload), workload);
    const resource = admission(final, workload);
    const journal = { spec: { runId: final.run.id, sourceRunUID: resource.metadata.uid },
      status: { phase: 'Finished', reportJson: JSON.stringify(final.run.resolution) } };
    const active = structuredClone(final); active.run.status = 'running'; delete active.run.resolution;
    const assessed = structuredClone(final); delete assessed.run.resolution;
    const sequence = [active, active, assessed, final];
    const calls = [], actions = [];
    let reads = 0;
    const locator = name => ({ click: async () => actions.push(name), waitFor: async () => {}, getByRole: (_role, { name }) => locator(name),
      selectOption: async id => actions.push(id), scrollIntoViewIfNeeded: async () => {} });
    const page = { getByRole: (_role, { name }) => locator(name), locator, reload: async () => {},
      waitForFunction: async () => {}, screenshot: async () => {},
      evaluate: async () => ({ selectedRunId: final.run.id, status: reads <= 2 ? 'running' : 'completed', envelopeCount: reads * 2 }) };
    const destination = workload.approach === 'mcp' ? join(directory, 'mcp') : directory;
    const snapshot = await captureIncident({ workload, mode: 'live', destination, page, deadline: Date.now() + 5000,
      sleep: async () => {}, prepare: async () => ({ pod: { metadata: final.run.input.incident.evidence.subject }, deploymentUID: final.run.resolution.target.uid }),
      kube: async args => {
        calls.push(args);
        if (args[1] === 'namespace') return JSON.stringify({ metadata: { uid: 'namespace-uid' } });
        if (args[1] === 'masdemoruns') return JSON.stringify({ items: [resource] });
        if (args[1] === 'masremediations') return JSON.stringify({ items: [journal] });
        if (args[0] === 'label') return '';
        throw new Error(`Unexpected Kubernetes mutation or read: ${args.join(' ')}`);
      }, fetchSnapshot: async path => path === '/api/topology' ? { nodes: [{ id: 'coordinator' }], edges: [] } : sequence[reads++] });
    captures.push(snapshot);
    for (const [filename, expected] of [['run-resource.json', resource], ['remediation-journal.json', journal], ['outcome.json', final.run.resolution]]) {
      assert.deepEqual(JSON.parse(await readFile(join(destination, filename), 'utf8')), expected);
    }
    assert.equal(JSON.parse(await readFile(join(destination, 'canvas-progress.json'), 'utf8')).grewWhileActive, true);
    assert.equal(calls.filter(args => args[0] === 'label').length, 1);
    assert.equal(calls.some(args => ['patch', 'scale'].includes(args[0])), false);
    assert.ok(actions.includes(workload.approach === 'mcp' ? 'LLM tools + MCP' : 'Collected evidence'));
    if (workload.approach === 'mcp') {
      assert.deepEqual(JSON.parse(await readFile(join(destination, 'tool-calls.json'), 'utf8')), final.run.investigation.calls);
      assert.deepEqual(JSON.parse(await readFile(join(destination, 'investigation-observation.json'), 'utf8')), final.investigationObservation);
    }
  }
  assert.equal(captures[0].run.resolution.attemptId, captures[1].run.resolution.attemptId,
    'one controller process owns both independent operations');
  assert.doesNotThrow(() => validateDistinctRecoveries(...captures));
  for (const change of [
    run => { run.id = captures[0].run.id; },
    run => { run.input.incident.evidence.subject.uid = captures[0].run.input.incident.evidence.subject.uid; },
    run => { run.resolution.target.uid = captures[0].run.resolution.target.uid; },
    run => { run.resolution.operationId = captures[0].run.resolution.operationId; },
    run => { delete run.resolution.attemptId; },
    run => { delete run.resolution; },
  ]) {
    const altered = structuredClone(captures[1]); change(altered.run);
    assert.throws(() => validateDistinctRecoveries(captures[0], altered), /distinct incident/);
  }
});

test('MCP failure diagnostics remain attached to its own incident after another run has recovered', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mas-independent-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workload = managedWorkloads[1], snapshot = incidentSnapshot(workload), resource = admission(snapshot, workload);
  snapshot.run.status = 'failed'; snapshot.run.error = 'The provider returned invalid output';
  snapshot.run.diagnostics = { classification: 'invalid-output', automaticRetry: false };
  const locator = () => ({ click: async () => {}, waitFor: async () => {}, selectOption: async () => {}, scrollIntoViewIfNeeded: async () => {} });
  const page = { getByRole: locator, locator, reload: async () => {}, screenshot: async () => {},
    evaluate: async () => ({ selectedRunId: snapshot.run.id, status: 'failed', envelopeCount: 0 }) };
  let captureError;
  const retained = [];
  await assert.rejects(captureIncident({ workload, mode: 'live', destination: directory, page, deadline: Date.now() + 5000,
    onSnapshot: async value => retained.push({ runId: value.run.id, status: value.run.status }),
    prepare: async () => ({ pod: { metadata: snapshot.run.input.incident.evidence.subject }, deploymentUID: 'mcp-deployment-uid' }),
    kube: async args => args[1] === 'namespace' ? JSON.stringify({ metadata: { uid: 'namespace-uid' } })
      : args[1] === 'masdemoruns' ? JSON.stringify({ items: [resource] }) : '',
    fetchSnapshot: async path => path === '/api/topology' ? { nodes: [], edges: [] } : snapshot,
  }), error => { captureError = error; return /provider returned invalid output/.test(error.message); });
  const failure = JSON.parse(await readFile(join(directory, 'failure-diagnostics.json'), 'utf8'));
  assert.equal(failure.runId, snapshot.run.id);
  assert.equal(failure.classification, 'invalid-output');
  assert.deepEqual(failureReport(addRecovery(incidentSnapshot(managedWorkloads[0]), managedWorkloads[0]), captureError), failure);
  assert.equal(JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')).status, 'failed');
  assert.deepEqual(retained, [{ runId: snapshot.run.id, status: 'failed' }]);
});

test('recording selects this Pod UID and rejects duplicate admitted investigations', () => {
  const old = { spec: { event: { involvedObject: { uid: 'old-pod' } } } };
  const current = { spec: { event: { involvedObject: { uid: 'new-pod' } } } };
  assert.equal(selectRunForPod([old, current], 'new-pod'), current);
  assert.equal(selectRunForPod([old], 'new-pod'), undefined);
  assert.throws(() => selectRunForPod([current, current], 'new-pod'), /More than one/);
});

test('recording requires the actual finished controller journal to match its published recovery', () => {
  const snapshot = completed();
  snapshot.run.output = { requires_human: false, remediation: { action: 'replace_readiness_probe_path' } };
  assert.equal(validateControllerResolution(snapshot, undefined, 'source-uid'), false);
  snapshot.run.resolution = { version: 'mas-k8s-resolution/2', effectOutcome: 'applied', verificationOutcome: 'passed', status: 'verified', reason: 'Ready, HTTP 200 and metrics verified' };
  const report = snapshot.run.resolution;
  Object.assign(report, { target: { namespace: 'mas-demo', name: 'mas-demo-checkout' }, recordedAt: '2026-10-18T07:00:20Z',
    before: { observedAt: '2026-10-18T07:00:00Z' },
    after: { observedAt: '2026-10-18T07:00:20Z', pod: { name: 'replacement', uid: 'new-pod', readyTransitionTime: '2026-10-18T07:00:04Z' } },
    checks: ['Post-change logs', 'Post-change events'].map(name => ({ name, passed: true })),
    verificationEvidence: { version: 'mas-k8s-post-change-evidence/1',
      subject: { namespace: 'mas-demo', name: 'replacement', uid: 'new-pod', container: 'checkout' },
      window: { startedAt: '2026-10-18T07:00:05Z', endedAt: '2026-10-18T07:00:18Z' },
      logs: { status: 'collected', source: 'Kubernetes API logs', observedAt: '2026-10-18T07:00:17Z', truncated: false,
        records: [{ timestamp: '2026-10-18T07:00:15Z', method: 'GET', path: '/healthz', status: 200 }], omittedLines: 0, unparsedLines: 0 },
      events: { status: 'collected', source: 'Kubernetes API events', observedAt: '2026-10-18T07:00:18Z', truncated: false, items: [] } } });
  const journal = { spec: { runId: snapshot.run.id, sourceRunUID: 'source-uid' },
    status: { phase: 'Finished', reportJson: JSON.stringify(snapshot.run.resolution) } };
  assert.equal(selectRemediationForRun([{ spec: { runId: 'old-run' } }, journal], snapshot.run.id), journal);
  assert.throws(() => selectRemediationForRun([journal, journal], snapshot.run.id), /More than one durable/);
  assert.equal(validateControllerResolution(snapshot, journal, 'source-uid'), true);
  assert.throws(() => validateControllerResolution({ run: { ...snapshot.run, resolution: { ...snapshot.run.resolution, effectOutcome: 'unknown' } } }, journal, 'source-uid'), /acknowledged applied/);
  assert.throws(() => validateControllerResolution(snapshot, journal, 'other-source'), /no matching finished/);
  assert.throws(() => validateControllerResolution(snapshot, { ...journal, status: { ...journal.status, phase: 'Applying' } }, 'source-uid'), /no matching finished/);
  assert.throws(() => validateControllerResolution(snapshot, { ...journal, status: { ...journal.status, reportJson: '{}' } }, 'source-uid'), /differs from/);
  const noProof = structuredClone(snapshot); delete noProof.run.resolution.verificationEvidence;
  assert.throws(() => validateControllerResolution(noProof, { ...journal, status: { phase: 'Finished', reportJson: JSON.stringify(noProof.run.resolution) } }, 'source-uid'), /requires retained logs and events/);
  const truncated = structuredClone(snapshot); truncated.run.resolution.verificationEvidence.events.truncated = true;
  assert.throws(() => validateControllerResolution(truncated, { ...journal, status: { phase: 'Finished', reportJson: JSON.stringify(truncated.run.resolution) } }, 'source-uid'), /complete observations/);
  snapshot.run.resolution.status = 'failed';
  assert.throws(() => validateControllerResolution(snapshot, journal, 'source-uid'), /Practical recovery was failed/);
});

test('a completed abstention stops recovery capture and retains the actual decision in failure diagnostics', () => {
  for (const [requiresHuman, action] of [[true, 'none'], [true, 'replace_readiness_probe_path'], [false, 'none']]) {
    const snapshot = completed();
    snapshot.run.output = { requires_human: requiresHuman, remediation: { action,
      reason: 'The endpoint contract has not been established.' } };
    assert.throws(() => validateControllerResolution(snapshot, undefined, 'source-uid'), error => {
      const report = failureReport(snapshot, error);
      assert.equal(report.classification, 'remediation-not-proposed');
      assert.match(report.error, /completed assessment.*automatic recovery/i);
      assert.deepEqual(report.proposal, { requiresHuman, action, reason: snapshot.run.output.remediation.reason });
      assert.equal('observation' in report, false);
      return true;
    });
  }
});

test('recovery capture waits for unfinished assessments and eligible proposals, and fails closed on missing decisions', () => {
  const snapshot = completed();
  snapshot.run.status = 'running';
  assert.equal(validateControllerResolution(snapshot, undefined, 'source-uid'), false);
  snapshot.run.status = 'completed';
  for (const output of [undefined, {}, { requires_human: false },
    { requires_human: 'false', remediation: { action: 'replace_readiness_probe_path' } }]) {
    snapshot.run.output = output;
    assert.throws(() => validateControllerResolution(snapshot, undefined, 'source-uid'), /automatic recovery/i);
  }
  snapshot.run.output = { requires_human: false, remediation: { action: 'replace_readiness_probe_path' } };
  assert.equal(validateControllerResolution(snapshot, undefined, 'source-uid'), false);
});

test('recording requires actual completed observations in the requested provider mode', () => {
  assert.doesNotThrow(() => validateSnapshot(completed(), 'live', 'k8s-uid'));
  assert.throws(() => validateSnapshot(completed(), 'fixture', 'k8s-uid'), /mode/);
  const absent = completed();
  absent.observationAvailable = false;
  assert.throws(() => validateSnapshot(absent, 'live', 'k8s-uid'), /no available observation/);
  const failed = completed();
  failed.run.status = 'failed';
  assert.throws(() => validateSnapshot(failed, 'live', 'k8s-uid'), /did not complete/);
});

test('assessed smoke and recording traces use retained invocation pairs and exact selected assessment identities', async () => {
  const snapshot = completed();
  const sha = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
  const reference = record => ({ id: record.id, sha256: sha(record) });
  const candidate = { schema_version: 1, id: 'candidate-1', output: snapshot.run.output, output_sha256: sha(snapshot.run.output), parent: null, feedback: [] };
  const evidence = { schema_version: 1, id: 'evidence-1', content: { observed: true }, content_sha256: sha({ observed: true }) };
  const rubric = { schema_version: 1, id: 'rubric-1', criteria: [{ id: 'check', measurement: 'deterministic', minimum: 0, maximum: 1 }] };
  const assessment = { schema_version: 1, id: 'assessment-1', candidate: reference(candidate),
    evaluator: { id: 'incident_checks', kind: 'deterministic', version: '1' }, rubric: reference(rubric), status: 'completed', error: null,
    findings: [{ criterion_id: 'check', verdict: 'pass', score: 1, evidence: [reference(evidence)], explanation: 'Fixture check' }] };
  for (let index = 8; index < 13; index++) snapshot.observation.messages.push(
    { id: `request-${index}`, sequence: index * 2 + 1, sender: 'client', recipient: 'incident_checks', kind: 'request', payload: {} },
    { id: `result-${index}`, sequence: index * 2 + 2, sender: 'incident_checks', recipient: 'client', kind: 'result', correlation: `request-${index}`, payload: {} });
  snapshot.run.revision = { version: 'mas-host-revision-audit/1', status: 'completed', selected: reference(candidate),
    candidates: [candidate], assessments: [assessment], records: [['candidate', candidate], ['evidence', evidence], ['rubric', rubric], ['assessment', assessment]].map(([kind, record]) =>
      ({ kind, id: record.id, sha256: sha(record), readers: ['*'], record })),
    contexts: Array.from({ length: 13 }, (_, index) => ({ id: `invocation-${index}`, actor: 'incident_checks', input: {}, policy: {}, readers: ['*'] })) };
  assert.equal(snapshot.observation.messages.length, 26);
  assert.doesNotThrow(() => validateSnapshot(snapshot, 'live', 'k8s-uid'));
  await verifyRevisionDigests(snapshot.run.revision);
  await verifySelectedOutput(snapshot.run.revision, snapshot.run.output);
  const missingPair = structuredClone(snapshot); missingPair.observation.messages.splice(-2);
  assert.throws(() => validateSnapshot(missingPair, 'live', 'k8s-uid'), /pair for every retained invocation/);
  const missingAssessment = structuredClone(snapshot); missingAssessment.run.revision.assessments = [];
  assert.throws(() => validateSnapshot(missingAssessment, 'live', 'k8s-uid'), /assessment of the exact selected candidate/);
  const changed = structuredClone(snapshot); changed.run.output = { altered: true };
  assert.throws(() => validateSnapshot(changed, 'live', 'k8s-uid'), /exact selected candidate/);
});

test('recording rejects metadata-only observations and missing or inherited envelope payloads', () => {
  for (const flag of [false, undefined]) {
    const metadata = completed();
    metadata.observation.payloads_included = flag;
    assert.throws(() => validateSnapshot(metadata, 'live', 'k8s-uid'), /SHOW_PAYLOADS=true/);
  }
  const missing = completed();
  delete missing.observation.messages[0].payload;
  assert.throws(() => validateSnapshot(missing, 'live', 'k8s-uid'), /requires message payloads/);
  Object.setPrototypeOf(missing.observation.messages[0], { payload: { input: {} } });
  assert.throws(() => validateSnapshot(missing, 'live', 'k8s-uid'), /requires message payloads/);
});

test('recording reports the retained safe cause rather than replacing it with a generic completion error', () => {
  const failed = completed();
  failed.run.status = 'failed';
  failed.run.error = 'The provider rejected the structured output schema (HTTP 400, invalid_json_schema).';
  failed.run.diagnostics = { version: 'mas-demo-failure/1', classification: 'invalid-schema', automaticRetry: false,
    effects: [{ actor: 'diagnose', httpStatus: 400, errorCode: 'invalid_json_schema' }] };
  assert.throws(() => validateSnapshot(failed, 'live', 'k8s-uid'), /HTTP 400, invalid_json_schema/);
  const report = failureReport(failed, new Error('The host investigation did not complete'));
  assert.equal(report.classification, 'invalid-schema');
  assert.equal(report.error, failed.run.error);
  assert.deepEqual(report.diagnostics, failed.run.diagnostics);
  assert.equal('observation' in report, false);
  assert.equal('output' in report, false);
  assert.equal(failureReport(undefined, new Error('Capture failed')).error, 'Capture failed');
});

test('recording rejects missing hybrid flow, reordered sequence and duplicate envelope identity', () => {
  const noPeer = completed();
  noPeer.observation.messages[8].sender = 'coordinator';
  noPeer.observation.messages[9].recipient = 'coordinator';
  assert.throws(() => validateSnapshot(noPeer, 'live', 'k8s-uid'), /peer exchange/);
  const reordered = completed();
  reordered.observation.messages[5].sequence = 3;
  assert.throws(() => validateSnapshot(reordered, 'live', 'k8s-uid'), /strictly increasing/);
  const duplicated = completed();
  duplicated.observation.messages[5].id = duplicated.observation.messages[4].id;
  assert.throws(() => validateSnapshot(duplicated, 'live', 'k8s-uid'), /distinct/);
});

test('recording rejects a wrong reply ID, a wrong reply direction and an unbalanced message count', () => {
  const wrongID = completed();
  wrongID.observation.messages[5].correlation = 'another-request';
  assert.throws(() => validateSnapshot(wrongID, 'live', 'k8s-uid'), /correlated to its request ID/);
  const wrongDirection = completed();
  wrongDirection.observation.messages[5].recipient = 'platform';
  assert.throws(() => validateSnapshot(wrongDirection, 'live', 'k8s-uid'), /reverse-routed/);
  const unbalanced = completed();
  unbalanced.observation.messages[5].kind = 'request';
  assert.throws(() => validateSnapshot(unbalanced, 'live', 'k8s-uid'), /eight recorded requests and eight recorded results/);
});

test('canvas capture requires growth on the selected active run before terminal state', () => {
  let progress = {};
  const frame = { selectedRunId: 'k8s-uid', status: 'running', envelopeCount: 3 };
  progress = observeCanvasProgress(progress, frame, 'k8s-uid');
  assert.throws(() => validateCanvasProgress(progress), /did not observe increasing/);
  progress = observeCanvasProgress(progress, { ...frame, envelopeCount: 6 }, 'k8s-uid');
  assert.doesNotThrow(() => validateCanvasProgress(progress));
});

test('fast completion, terminal-only growth and growth on an older run cannot pass live canvas capture', () => {
  const fastCompleted = observeCanvasProgress({}, {
    selectedRunId: 'k8s-uid', status: 'completed', envelopeCount: 16,
  }, 'k8s-uid');
  assert.throws(() => validateCanvasProgress(fastCompleted), /did not observe increasing/);
  const active = observeCanvasProgress({}, {
    selectedRunId: 'k8s-uid', status: 'running', envelopeCount: 3,
  }, 'k8s-uid');
  const terminalGrowth = observeCanvasProgress(active, {
    selectedRunId: 'k8s-uid', status: 'completed', envelopeCount: 16,
  }, 'k8s-uid');
  assert.throws(() => validateCanvasProgress(terminalGrowth), /did not observe increasing/);
  const oldRunGrowth = observeCanvasProgress(active, {
    selectedRunId: 'old-run', status: 'running', envelopeCount: 12,
  }, 'k8s-uid');
  assert.throws(() => validateCanvasProgress(oldRunGrowth), /did not observe increasing/);
});

for (const workload of managedWorkloads) test(`preparation measures the ${workload.approach} faulty Pod before enabling its event trigger without replacing it`, async () => {
  const destination = await mkdtemp(join(tmpdir(), 'mas-practical-'));
  const calls = [];
  let manifest;
  const pod = { metadata: { name: 'checkout-pod', uid: 'original-uid', creationTimestamp: new Date(Date.now() - 60_000).toISOString() },
    status: { phase: 'Running' } };
  try {
    const result = await prepareIncident(destination, async args => {
      calls.push(args);
      if (args[0] === 'delete') return '';
      if (args[0] === 'apply') { manifest = JSON.parse(await readFile(args[2], 'utf8')); return ''; }
      if (args[1] === 'pods') return JSON.stringify({ items: [pod] });
      if (args[1] === '--raw') return JSON.stringify({ metadata: { name: pod.metadata.name, namespace: 'mas-demo' }, timestamp: new Date().toISOString(), window: '15s',
        containers: [{ name: 'checkout', usage: { cpu: '1n', memory: '30Mi' } }] });
      if (args[0] === 'logs') return `${JSON.stringify({ method: 'GET', path: workload.currentPath, status: 404 })}\n{"method":"GET","path":"/healthz","status":200}\n`;
      if (args[1] === 'deployment') return JSON.stringify({ metadata: { uid: 'deployment-uid' } });
      if (args[0] === 'label') return '';
      throw new Error(`Unexpected preparation call ${args.join(' ')}`);
    }, workload);
    assert.equal(result.pod.metadata.uid, 'original-uid');
    const deployment = manifest.items.find(item => item.kind === 'Deployment');
    assert.equal(deployment.spec.template.metadata.labels['demo.mas.dev/trigger'], 'false');
    assert.equal(deployment.spec.template.spec.containers[0].readinessProbe.httpGet.path, workload.currentPath);
    assert.equal(deployment.metadata.name, workload.name);
    assert.equal(deployment.spec.template.metadata.labels['demo.mas.dev/approach'], workload.approach);
    assert.equal(calls.find(args => args[0] === 'delete')[2], workload.name);
    assert.equal(manifest.items.find(item => item.kind === 'Service').metadata.name, workload.name);
    assert.ok(calls.findIndex(args => args[0] === 'label') > calls.findIndex(args => args[0] === 'logs'));
    assert.deepEqual(calls.at(-1), ['label', 'pod', 'checkout-pod', 'demo.mas.dev/trigger=true', '--overwrite']);
    assert.equal(calls.filter(args => args[0] === 'patch').length, 0);
  } finally { await rm(destination, { recursive: true, force: true }); }
});
