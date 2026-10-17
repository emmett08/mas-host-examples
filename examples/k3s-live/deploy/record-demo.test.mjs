import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureMcpComparison, comparisonRequest, failureReport, observeCanvasProgress, prepareIncident, selectRemediationForRun, selectRunForPod, validateCanvasProgress, validateControllerResolution, validateMcpComparison, validateSnapshot } from './record-demo.mjs';
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

function comparisonSource() {
  const snapshot = completed();
  const subject = { kind: 'Pod', namespace: 'mas-demo', name: 'checkout', uid: 'pod-uid' };
  snapshot.run.input = { incident: { event: { namespace: 'mas-demo', involvedObject: subject },
    evidence: { subject, capturedAt: '2026-10-17T19:00:00.000Z', items: [{ id: 'original-pod', kind: 'pod' }] } } };
  return snapshot;
}

function mcpComparison(source = comparisonSource()) {
  const snapshot = completed();
  snapshot.run.id = `mcp-${source.run.id}`;
  snapshot.run.approach = 'mcp';
  snapshot.run.input = structuredClone(source.run.input);
  snapshot.run.investigation = { runId: 'investigation-run', status: 'completed', source: 'kubernetes-api',
    evidence: { subject: structuredClone(source.run.input.incident.evidence.subject),
      items: [{ id: 'mcp-pod', kind: 'pod', data: {} }] },
    calls: [{ id: 'effect-1', tool: 'pod_overview', status: 'collected', evidenceIds: ['mcp-pod'] }] };
  snapshot.investigationObservation = { payloads_included: true, observed_at_ms: 1, messages: [
    { id: 'tool-request', sequence: 1, kind: 'request', sender: 'investigator', recipient: 'pod_overview', payload: {} },
    { id: 'tool-result', sequence: 2, kind: 'result', sender: 'pod_overview', recipient: 'investigator', correlation: 'tool-request', payload: { output: {} } },
  ] };
  return snapshot;
}

test('MCP comparison copies one admitted incident and preserves original observations', () => {
  const source = comparisonSource();
  const request = comparisonRequest(source);
  assert.equal(request.approach, 'mcp');
  assert.equal(request.id, 'mcp-k8s-uid');
  assert.deepEqual(request.event, source.run.input.incident.event);
  assert.deepEqual(request.evidence, source.run.input.incident.evidence);
  request.evidence.items[0].id = 'changed';
  assert.equal(source.run.input.incident.evidence.items[0].id, 'original-pod');
  const mismatch = comparisonSource();
  mismatch.run.input.incident.evidence.subject = { ...mismatch.run.input.incident.evidence.subject, uid: 'different-pod' };
  assert.throws(() => comparisonRequest(mismatch), /bound to the incident Pod/);
  const pending = comparisonSource(); pending.run.status = 'running';
  assert.throws(() => comparisonRequest(pending), /completed run/);
});

test('MCP capture requires real tool envelopes and frozen evidence for the same Pod', () => {
  const source = comparisonSource();
  assert.doesNotThrow(() => validateMcpComparison(mcpComparison(source), source, 'live', 'mcp-k8s-uid'));
  for (const [change, pattern] of [
    [snapshot => { snapshot.run.approach = 'collected'; }, /original incident/],
    [snapshot => { snapshot.run.input.incident.event.involvedObject.uid = 'other-pod'; }, /original incident/],
    [snapshot => { delete snapshot.run.investigation.evidence; }, /frozen incident evidence/],
    [snapshot => { snapshot.run.investigation.source = 'recorded-evidence'; }, /actual Kubernetes API/],
    [snapshot => { snapshot.run.investigation.calls = []; }, /no actual MCP tool call/],
    [snapshot => { snapshot.investigationObservation.payloads_included = false; }, /SHOW_PAYLOADS/],
    [snapshot => { delete snapshot.investigationObservation.messages[0].payload; }, /SHOW_PAYLOADS/],
    [snapshot => { snapshot.investigationObservation.messages[1].correlation = 'missing-request'; }, /correlated reverse-routed/],
    [snapshot => { snapshot.run.investigation.calls[0].tool = 'invented-tool'; }, /differs from its observed/],
    [snapshot => { snapshot.run.investigation.calls[0].evidenceIds = ['invented-evidence']; }, /frozen evidence/],
    [snapshot => { snapshot.investigationObservation.messages[1].sequence = 1; }, /identities or order/],
  ]) {
    const altered = mcpComparison(source); change(altered);
    assert.throws(() => validateMcpComparison(altered, source, 'live', 'mcp-k8s-uid'), pattern);
  }
});

test('MCP recorder retains actual tool output and reports failed investigation without fabricating completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mas-mcp-capture-'));
  const source = comparisonSource(), snapshot = mcpComparison(source), submitted = [];
  const actions = [];
  const locator = name => ({ click: async () => actions.push(name), waitFor: async () => {}, getByRole: (_role, { name }) => locator(name),
    selectOption: async id => actions.push(id), scrollIntoViewIfNeeded: async () => {} });
  const page = { getByRole: (_role, { name }) => locator(name), locator,
    reload: async () => {}, screenshot: async () => {} };
  const fetchSnapshot = async path => path === '/api/topology'
    ? { nodes: [{ id: 'coordinator', label: 'Coordinator', kind: 'workflow' }], edges: [] } : snapshot;
  try {
    await captureMcpComparison({ source, mode: 'live', destination: directory, page,
      deadline: Date.now() + 5_000, fetchSnapshot, submit: async request => submitted.push(request) });
    assert.deepEqual(submitted[0], comparisonRequest(source));
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'investigation-observation.json'), 'utf8')), snapshot.investigationObservation);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'tool-calls.json'), 'utf8')), snapshot.run.investigation.calls);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8')), snapshot.run.investigation.evidence);
    assert.ok(actions.includes('LLM tools + MCP'));
    assert.ok(actions.includes('Assessment'));
    snapshot.run.status = 'failed'; snapshot.run.error = 'No permitted tool was requested';
    snapshot.run.diagnostics = { version: 'mas-demo-failure/1', classification: 'invalid-output',
      automaticRetry: false, effects: [{ actor: 'investigator', httpStatus: 200, outputStatus: 'invalid' }] };
    let comparisonError;
    await assert.rejects(captureMcpComparison({ source, mode: 'live', destination: directory, page,
      deadline: Date.now() + 5_000, fetchSnapshot, submit: async () => {} }), error => {
      comparisonError = error;
      assert.match(error.message, /MCP comparison failed: No permitted tool was requested/);
      return true;
    });
    const failure = JSON.parse(await readFile(join(directory, 'failure-diagnostics.json'), 'utf8'));
    assert.equal(failure.error, snapshot.run.error);
    assert.equal(failure.classification, 'invalid-output');
    assert.equal(failure.runId, snapshot.run.id);
    assert.deepEqual(failure.diagnostics, snapshot.run.diagnostics);
    assert.deepEqual(failureReport(source, comparisonError), failure,
      'the root summary must preserve MCP diagnostics after the collected run recovers');
    assert.equal(JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8')).run.status, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('MCP recorder resumes recovery once evidence is frozen while assessment is still running', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mas-mcp-freeze-'));
  const source = comparisonSource(), final = mcpComparison(source);
  const acquiring = structuredClone(final);
  acquiring.run.status = 'running'; acquiring.run.investigation.status = 'running';
  delete acquiring.run.investigation.evidence;
  const assessing = structuredClone(final); assessing.run.status = 'running';
  const sequence = [acquiring, assessing, final];
  let reads = 0, resumed = 0;
  const locator = () => ({ click: async () => {}, waitFor: async () => {}, getByRole: locator,
    selectOption: async () => {}, scrollIntoViewIfNeeded: async () => {} });
  const page = { getByRole: locator, locator, reload: async () => {}, screenshot: async () => {} };
  try {
    await captureMcpComparison({ source, mode: 'live', destination: directory, page,
      deadline: Date.now() + 5_000, submit: async () => {},
      fetchSnapshot: async path => {
        if (path === '/api/topology') return { nodes: [], edges: [] };
        if (reads === 1) assert.equal(resumed, 0, 'the controller must remain paused during tool collection');
        if (reads === 2) assert.equal(resumed, 1, 'recovery must start before final assessment is polled');
        return sequence[reads++];
      }, onEvidenceFrozen: async snapshot => {
        assert.equal(snapshot.run.status, 'running');
        assert.equal(snapshot.run.investigation.status, 'completed');
        assert.deepEqual(snapshot.run.investigation.evidence, final.run.investigation.evidence);
        resumed++;
      } });
    assert.equal(resumed, 1, 'terminal snapshots must not resume the controller again');
  } finally { await rm(directory, { recursive: true, force: true }); }
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
  const journal = { spec: { runId: snapshot.run.id, sourceRunUID: 'source-uid' },
    status: { phase: 'Finished', reportJson: JSON.stringify(snapshot.run.resolution) } };
  assert.equal(selectRemediationForRun([{ spec: { runId: 'old-run' } }, journal], snapshot.run.id), journal);
  assert.throws(() => selectRemediationForRun([journal, journal], snapshot.run.id), /More than one durable/);
  assert.equal(validateControllerResolution(snapshot, journal, 'source-uid'), true);
  assert.throws(() => validateControllerResolution({ run: { ...snapshot.run, resolution: { ...snapshot.run.resolution, effectOutcome: 'unknown' } } }, journal, 'source-uid'), /acknowledged applied/);
  assert.throws(() => validateControllerResolution(snapshot, journal, 'other-source'), /no matching finished/);
  assert.throws(() => validateControllerResolution(snapshot, { ...journal, status: { ...journal.status, phase: 'Applying' } }, 'source-uid'), /no matching finished/);
  assert.throws(() => validateControllerResolution(snapshot, { ...journal, status: { ...journal.status, reportJson: '{}' } }, 'source-uid'), /differs from/);
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

test('preparation measures the actual faulty Pod before enabling its event trigger without replacing it', async () => {
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
      if (args[0] === 'logs') return '{"method":"GET","path":"/readyz","status":404}\n{"method":"GET","path":"/healthz","status":200}\n';
      if (args[1] === 'deployment') return JSON.stringify({ metadata: { uid: 'deployment-uid' } });
      if (args[0] === 'label') return '';
      throw new Error(`Unexpected preparation call ${args.join(' ')}`);
    });
    assert.equal(result.pod.metadata.uid, 'original-uid');
    const deployment = manifest.items.find(item => item.kind === 'Deployment');
    assert.equal(deployment.spec.template.metadata.labels['demo.mas.dev/trigger'], 'false');
    assert.equal(deployment.spec.template.spec.containers[0].readinessProbe.httpGet.path, '/readyz');
    assert.ok(calls.findIndex(args => args[0] === 'label') > calls.findIndex(args => args[0] === 'logs'));
    assert.deepEqual(calls.at(-1), ['label', 'pod', 'checkout-pod', 'demo.mas.dev/trigger=true', '--overwrite']);
    assert.equal(calls.filter(args => args[0] === 'patch').length, 0);
  } finally { await rm(destination, { recursive: true, force: true }); }
});
