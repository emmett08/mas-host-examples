import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJSON } from '../remediator/controller.js';
import { createRemediationTransport } from '../remediator/transport.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runs, RequestError } from './runs.js';
import { HostRunFailure, type Host } from './host.js';
import { projectFailure } from './diagnostics.js';
import { application } from './http.js';
import { EVIDENCE_VERSION, type EvidenceBundle } from '../shared/evidence.js';
import { canonicalJson, parseRevisionAudit } from '../shared/revision.mjs';
import { parseArchive } from '../ui/archive.js';

test('MCP snapshots keep observation availability coherent when a primary poll completes during acquisition', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-snapshot-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'topology.mcp.yaml'), 'edges: [[client, investigator]]\n');
  const primary = { observed_at_ms: 2_000, messages: [] };
  const acquisition = { observed_at_ms: 1_900, messages: [] };
  for (const available of [false, true]) {
    const host = { options: { project: dir }, observe: async () => {
      // Complete the concurrent primary poll while snapshot awaits acquisition.
      if (available) runs.observations.set('snapshot-race', primary);
      return acquisition;
    } } as unknown as Host;
    const runs = new Runs(dir, 'fixture', host);
    runs.records.set('snapshot-race', { id: 'snapshot-race', mode: 'fixture', approach: 'mcp', status: 'running',
      startedAt: '2026-10-19T08:00:00Z', input: { incident: {} }, fingerprint: 'fixture' });
    const snapshot = await runs.snapshot('snapshot-race');
    assert.equal(snapshot.observationAvailable, available);
    assert.deepEqual(snapshot.observation, available ? primary : { messages: [] });
    assert.deepEqual(snapshot.investigationObservation, acquisition);
    // The same strict parser used by the downloaded dashboard must accept it.
    const parsed = parseArchive({ version: 'mas-demo-archive/1', capturedAt: '2026-10-19T08:00:01Z',
      runId: 'snapshot-race', topology: snapshot.investigationTopology,
      snapshots: [{ ...snapshot, observedAtMs: available ? primary.observed_at_ms : acquisition.observed_at_ms }] });
    assert.equal(parsed.snapshots[0]!.observationAvailable, available);
  }
});

function incidentEvidence(): EvidenceBundle {
  return { version: EVIDENCE_VERSION, capturedAt: '2026-10-16T12:00:00Z',
    subject: { namespace: 'mas-demo', name: 'mas-demo-checkout-a', uid: 'pod-uid-a' }, items: [
      { id: 'workload-deployment', kind: 'workload', source: 'Kubernetes API', status: 'collected', observedAt: '2026-10-16T12:00:00Z', truncated: false,
        data: { apiVersion: 'apps/v1', kind: 'Deployment', templateHash: 'before-hash', metadata: { namespace: 'mas-demo', name: 'mas-demo-checkout', uid: 'deployment-a', resourceVersion: '42' },
          spec: { template: { spec: { containers: [{ name: 'checkout', readinessProbe: { httpGet: { path: '/readyz' } }, livenessProbe: { httpGet: { path: '/healthz' } } }] } } } } },
      { id: 'logs-checkout-current', kind: 'logs', source: 'Kubernetes logs API', status: 'collected', observedAt: '2026-10-16T12:00:00Z', truncated: false,
        data: { container: 'checkout', previous: false, text: '{"method":"GET","path":"/readyz","status":404}\n{"method":"GET","path":"/healthz","status":200}' } },
      { id: 'metrics', kind: 'metrics', source: 'Kubernetes Metrics API', status: 'unavailable', observedAt: '2026-10-16T12:00:00Z', truncated: false, data: null, reason: 'Metrics server is not installed' },
    ] };
}
function evidenceRequest(id: string, evidence = incidentEvidence()) {
  return { id, scenario: 'pod-incident', event: { reason: 'Unhealthy', involvedObject: { kind: 'Pod', ...evidence.subject } }, evidence };
}

test('an exhausted revision retains its selected output but cannot admit remediation or repeat the same run', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-exhausted-revision-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = { summary: 'Unresolved finding', requires_human: true };
  const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
  const candidate = { schema_version: 1, id: 'candidate-0', output, output_sha256: digest(output), parent: null, feedback: [] };
  const revision = parseRevisionAudit({ version: 'mas-host-revision-audit/1', status: 'exhausted',
    selected: { id: candidate.id, sha256: digest(candidate) }, candidates: [candidate], assessments: [], contexts: [],
    records: [{ kind: 'candidate', id: candidate.id, sha256: digest(candidate), readers: ['*'], record: candidate }] });
  let calls = 0;
  const host = { options: { revisionPlan: 'revision.json' }, runAssessed: async (_id: string, input: string) => {
    calls++;
    const supplied = JSON.parse(await readFile(input, 'utf8'));
    assert.deepEqual(supplied.sources.map((row: { id: string; readers: string[] }) => ({ id: row.id, readers: row.readers })), [{ id: 'incident', readers: ['*'] }]);
    return { output, revision };
  }, observe: async () => ({ messages: [], revision }) } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  const request = { id: 'exhausted', scenario: 'pod-incident' };
  await runs.create(request);
  await waitFor(() => runs.get('exhausted').status === 'failed');
  assert.deepEqual(runs.get('exhausted').output, output);
  assert.equal(runs.get('exhausted').revision!.status, 'exhausted');
  await assert.rejects(runs.recordResolution('exhausted', {}), error => error instanceof RequestError && error.status === 409);
  await runs.create(request);
  assert.equal(calls, 1);
});

test('idempotent event dispatch, conflicting input rejection, admission bound, and crash recovery', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  let complete!: (result: unknown) => void;
  const host = { run: async () => { calls++; return new Promise(resolve => { complete = resolve; }); },
    observe: async () => ({ messages: [{ id: 'message-1' }] }), cancel: async () => {} } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  const input = { id: 'event-a', scenario: 'pod-crash', event: { reason: 'BackOff' } };
  const first = await runs.create(input);
  await assert.rejects(runs.create({ ...input, event: { reason: 'Different' } }), (e: unknown) => e instanceof RequestError && e.status === 409);
  assert.equal(await runs.create(input), first);
  await assert.rejects(runs.create({ id: 'event-b', scenario: 'pod-crash' }), (e: unknown) => e instanceof RequestError && e.status === 429);
  while (!complete) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  // A restarted API retains identity and refuses to repeat an uncertain inference.
  const restarted = new Runs(dir, 'fixture', host);
  await restarted.initialise();
  assert.equal((await restarted.create(input)).status, 'failed');
  assert.equal(calls, 1);
  complete({ summary: 'done' });
  while (runs.get('event-a').status === 'running') await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runs.get('event-a').status, 'completed');
  assert.equal((await runs.snapshot('event-a')).observationAvailable, true);
});

test('HTTP rejects cross-origin dispatch and invalid evidence, serves retained snapshots', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = { run: async () => ({ summary: 'fixture' }), observe: async () => ({ messages: [] }) } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  const server = application(runs, { nodes: [], edges: [] }, dir);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, origin?: string) => fetch(`${url}/api/runs`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ scenario: 'pod-crash' }, 'https://attacker.invalid')).status, 403);
  assert.equal((await post({ scenario: 'pod-crash', event: { message: 'a'.repeat(2001) } })).status, 400);
  const response = await post({ id: 'http-run', scenario: 'pod-crash' });
  assert.equal(response.status, 202);
  while (runs.get('http-run').status !== 'completed') await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await (await fetch(`${url}/api/runs/http-run`)).json()).mode, 'fixture');
  assert.equal((await (await fetch(`${url}/api/runs/http-run/snapshot`)).json()).observationAvailable, true);
  assert.equal((await fetch(`${url}/api/runs/absent`)).status, 404);
});

test('compact remediation responses preserve selected output and admission inputs despite oversized audit history', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-compact-remediation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
  const draftOutput = { requires_human: false, summary: 'Unselected draft' };
  const output = { requires_human: true, summary: 'Selected revision requires review' };
  const draft = { schema_version: 1, id: 'candidate-0', output: draftOutput, output_sha256: digest(draftOutput), parent: null, feedback: [] };
  const candidate = { ...draft, id: 'candidate-1', output, output_sha256: digest(output), parent: { id: draft.id, sha256: digest(draft) } };
  const content = { retained: 'x'.repeat(2 * 1024 * 1024) };
  const evidence = { schema_version: 1, id: 'large-evidence', content, content_sha256: digest(content) };
  const revision = parseRevisionAudit({ version: 'mas-host-revision-audit/1', status: 'completed',
    selected: { id: candidate.id, sha256: digest(candidate) }, candidates: [draft, candidate], assessments: [], contexts: [],
    records: [draft, candidate, evidence].map(record => ({ kind: record === evidence ? 'evidence' : 'candidate',
      id: record.id, sha256: digest(record), readers: ['*'], record })) });
  const host = { options: { revisionPlan: 'revision.json' }, runAssessed: async () => ({ output, revision }),
    observe: async () => ({ messages: [], revision }) } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  await runs.create(evidenceRequest('compact'));
  await waitFor(() => runs.get('compact').status === 'completed');
  const server = application(runs, {}, dir);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const full = await (await fetch(`${base}/api/runs/compact/snapshot`)).text();
  assert.ok(Buffer.byteLength(full) > 1024 * 1024);
  const noKubernetes = async () => { throw new Error('No Kubernetes mutation should occur'); };
  const transport = createRemediationTransport({ namespace: 'mas-demo', verifierToken: 'a'.repeat(64),
    client: { get: noKubernetes, list: noKubernetes, text: noKubernetes, patchJSON: noKubernetes },
    fetch: (input, init) => fetch(`${base}${new URL(String(input)).pathname}`, init) });
  const compact = await transport.snapshot('compact');
  assert.ok(compact);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 64 * 1024);
  assert.equal(compact.run.status, 'completed');
  assert.deepEqual(compact.run.input, runs.get('compact').input);
  assert.deepEqual(compact.run.output, output);
  assert.deepEqual(compact.run.revisionSelection, { status: 'completed', candidate: revision.selected, output_sha256: candidate.output_sha256 });
  assert.equal('revision' in compact.run, false);
  assert.equal('observation' in compact, false);
  const { resolveIncident } = await import(new URL('../deploy/remediation.mjs', import.meta.url).href);
  const denied = await resolveIncident(compact, { enabled: true, kubectl: noKubernetes });
  assert.equal(denied.effectOutcome, 'not_started');
  assert.match(denied.reason, /collected pod evidence/);
  assert.equal(denied.reason, (await resolveIncident(JSON.parse(full), { enabled: true, kubectl: noKubernetes })).reason);
  const retained = runs.get('compact');
  retained.status = 'failed'; retained.revision!.status = 'exhausted';
  assert.equal((await transport.snapshot('compact'))!.run.status, 'failed');
  await assert.rejects(runs.recordResolution('compact', {}), error => error instanceof RequestError && error.status === 409);
  retained.status = 'completed';
  assert.equal((await fetch(`${base}/api/runs/compact/remediation`)).status, 409);
  retained.revision!.status = 'completed'; retained.output = draftOutput;
  assert.equal((await fetch(`${base}/api/runs/compact/remediation`)).status, 500);
  retained.output = output; retained.revision!.selected = null;
  assert.equal((await fetch(`${base}/api/runs/compact/remediation`)).status, 409);
  retained.revision!.selected = { id: candidate.id, sha256: digest(candidate) }; retained.output = undefined;
  assert.equal((await fetch(`${base}/api/runs/compact/remediation`)).status, 409);
});

test('terminal state waits for an in-flight observation and a fresh final snapshot', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-final-observation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let complete!: (value: unknown) => void;
  let releaseObservation!: (value: unknown) => void;
  let observeCalls = 0;
  const host = {
    run: () => new Promise(resolve => { complete = resolve; }),
    observe: () => {
      observeCalls++;
      if (observeCalls === 1) return new Promise(resolve => { releaseObservation = resolve; });
      return Promise.resolve({ messages: [{ id: 'request' }, { id: 'final-result' }] });
    },
  } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  await runs.create({ id: 'observed', scenario: 'pod-crash' });
  await waitFor(() => Boolean(releaseObservation));
  complete({ summary: 'done' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(runs.get('observed').status, 'running');
  await assert.rejects(runs.create({ id: 'too-soon', scenario: 'pod-crash' }),
    (error: unknown) => error instanceof RequestError && error.status === 429);
  releaseObservation({ messages: [{ id: 'request' }] });
  await waitFor(() => runs.get('observed').status === 'completed');
  assert.equal(observeCalls, 2);
  const snapshot = await runs.snapshot('observed');
  assert.deepEqual(snapshot.observation, { messages: [{ id: 'request' }, { id: 'final-result' }] });
  assert.equal(JSON.parse(await readFile(join(dir, 'observed', 'run.json'), 'utf8')).status, 'completed');
});

test('interrupted initial admissions recover, while unrecorded host state requires inspection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-interrupted-admission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'empty'));
  await mkdir(join(dir, 'temporary'));
  await writeFile(join(dir, 'temporary', 'run.tmp'), '{"status":"queued"');
  let calls = 0;
  const host = { run: async () => { calls++; return {}; },
    observe: async () => ({ messages: [] }) } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  assert.equal(calls, 0);
  assert.equal(runs.list().length, 0);
  await runs.create({ id: 'temporary', scenario: 'pod-crash' });
  await waitFor(() => runs.get('temporary').status === 'completed');
  assert.equal(calls, 1);
  await mkdir(join(dir, 'uncertain', 'host'), { recursive: true });
  await assert.rejects(new Runs(dir, 'fixture', host).initialise(),
    /retained state without an admission record; inspect the data directory/);
  assert.equal(calls, 1);
});

test('a failed terminal write is handled and releases the execution slot without replay', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-terminal-write-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let complete!: (value: unknown) => void;
  let calls = 0;
  const host = { run: () => {
    calls++;
    return calls === 1 ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({});
  }, observe: async () => ({ messages: [] }) } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  const input = { id: 'write-fails', scenario: 'pod-crash' };
  await runs.create(input);
  await waitFor(() => Boolean(complete));
  // Block the temporary write after admission without losing its durable
  // manifest. This fails deterministically even when the test runs as root.
  await mkdir(join(dir, 'write-fails', 'run.tmp'));
  complete({});
  await waitFor(() => runs.get('write-fails').status === 'failed');
  assert.match(runs.get('write-fails').error ?? '', /Could not retain the run outcome/);
  assert.equal((await runs.create(input)).status, 'failed');
  assert.equal(calls, 1);
  await rm(join(dir, 'write-fails', 'run.tmp'), { recursive: true });
  const restarted = new Runs(dir, 'fixture', host);
  await restarted.initialise();
  assert.equal((await restarted.create(input)).status, 'failed');
  assert.equal(calls, 1);
  await runs.create({ id: 'next-run', scenario: 'pod-crash' });
  await waitFor(() => runs.get('next-run').status === 'completed');
  assert.equal(calls, 2);
});

test('uncertain inference diagnostics survive restart and the same admission never retries the provider', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-retained-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const diagnostics = projectFailure({ version: 'mas-host-observation/1', run_id: 'uncertain', steps: [
    { kind: 'effect', key: 'inference-0', id: `eff-${'b'.repeat(64)}`, actor: 'security_review', state: 'unknown',
      input: { prompt: 'private-api-key' }, evidence: { error: 'private-api-key' } },
  ] }, 'uncertain');
  const host = { run: async () => { calls++; throw new HostRunFailure(diagnostics); },
    observe: async () => ({ messages: [] }) } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  const input = { id: 'uncertain', scenario: 'pod-crash' };
  await runs.create(input);
  await waitFor(() => runs.get('uncertain').status === 'failed');
  assert.match(runs.get('uncertain').error ?? '', /uncertain outcome.*reconcile/);
  assert.deepEqual(runs.get('uncertain').diagnostics, diagnostics);
  assert.equal(diagnostics.automaticRetry, false);
  const manifest = await readFile(join(dir, 'uncertain', 'run.json'), 'utf8');
  assert.doesNotMatch(manifest, /private-api-key/);
  const restarted = new Runs(dir, 'fixture', host);
  await restarted.initialise();
  assert.deepEqual((await restarted.snapshot('uncertain')).run.diagnostics, diagnostics);
  assert.equal((await restarted.create(input)).status, 'failed');
  assert.equal(calls, 1);
});

test('unexpected application errors retain a fixed message without copying arbitrary details', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-generic-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = { run: async () => { throw new Error('private-api-key'); },
    observe: async () => ({ messages: [] }) } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  await runs.create({ id: 'unexpected', scenario: 'pod-crash' });
  await waitFor(() => runs.get('unexpected').status === 'failed');
  assert.equal(runs.get('unexpected').diagnostics, undefined);
  assert.doesNotMatch(await readFile(join(dir, 'unexpected', 'run.json'), 'utf8'), /private-api-key/);
});

test('live evidence is identity-bound, copied into input and immutable across retries and restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const host = { run: async () => { calls++; return {}; }, observe: async () => ({ messages: [] }) } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  const body = evidenceRequest('live-evidence');
  await assert.rejects(runs.create({ ...body, event: { involvedObject: { ...body.event.involvedObject, uid: 'replaced-pod' } } }), /Evidence subject must match/);
  await assert.rejects(runs.create({ ...body, evidence: { ...body.evidence, version: 'unknown' } }), /Invalid evidence bundle/);
  const original = structuredClone(body);
  const run = await runs.create(body);
  (body.evidence.items[1]!.data as { text: string }).text = 'mutated after admission';
  const incident = run.input.incident as { evidence: EvidenceBundle; context: string };
  assert.deepEqual(incident.evidence, original.evidence);
  assert.match(incident.context, /Collected items: workload-deployment, logs-checkout-current/);
  assert.match(incident.context, /metrics: unavailable/);
  assert.doesNotMatch(incident.context, /No live Kubernetes logs/);
  assert.equal(await runs.create({ ...original, scenario: 'pod-crash' }), run);
  await assert.rejects(runs.create(body), (error: unknown) => error instanceof RequestError && error.status === 409);
  await waitFor(() => run.status === 'completed');
  const restarted = new Runs(dir, 'fixture', host);
  await restarted.initialise();
  assert.deepEqual((await restarted.create(original)).input, run.input);
  assert.equal(calls, 1);
});

test('HTTP admits bounded evidence over 8 KiB and retains independently verified resolution reports', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-resolution-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = { run: async () => ({}), observe: async () => ({ messages: [] }) } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  const verifierToken = 'test-verifier-credential';
  const server = application(runs, {}, dir, verifierToken);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const post = (path: string, value: unknown, origin?: string, token: string | undefined = verifierToken) => fetch(url + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
  const body = evidenceRequest('resolved');
  (body.evidence.items[1]!.data as { text: string }).text += '\n' + 'a'.repeat(10_000);
  assert.equal((await post('/api/runs', body)).status, 202);
  await waitFor(() => runs.get('resolved').status === 'completed');
  await runs.snapshot('resolved');
  assert.equal(runs.observations.has('resolved'), true);
  const report = { version: 'mas-k8s-resolution/1', status: 'verified', action: 'replace_readiness_probe_path',
    target: { namespace: 'mas-demo', name: 'mas-demo-checkout', uid: 'deployment-a' }, recordedAt: '2026-10-16T12:01:00Z',
    reason: 'Authenticated external verifier checked the successful rollout.', patch: [
      { op: 'test', path: '/metadata/uid', value: 'deployment-a' }, { op: 'test', path: '/metadata/resourceVersion', value: '43' },
      { op: 'test', path: '/spec/template/spec/containers/0/name', value: 'checkout' },
      { op: 'test', path: '/spec/template/spec/containers/0/readinessProbe/httpGet/path', value: '/readyz' },
      { op: 'replace', path: '/spec/template/spec/containers/0/readinessProbe/httpGet/path', value: '/healthz' },
    ], before: { uid: 'deployment-a', resourceVersion: '43', generation: 2, templateHash: 'before-hash', observedAt: '2026-10-16T12:00:00Z', readinessPath: '/readyz', status: { readyReplicas: 0 } },
    after: { uid: 'deployment-a', resourceVersion: '44', generation: 3, templateHash: 'after-hash', observedAt: '2026-10-16T12:01:00Z', readinessPath: '/healthz', status: { readyReplicas: 1 },
      pod: { name: 'mas-demo-checkout-b', uid: 'pod-b', ready: true, restarts: 0 }, metrics: { timestamp: '2026-10-16T12:01:00Z', window: '15s', containers: [{ name: 'checkout', usage: { cpu: '1m', memory: '10Mi' } }] },
      application: { source: 'Kubernetes Service API proxy HTTP GET /', status: 200, body: 'MAS checkout service ready\n' } },
    checks: ['Admission', 'Patch applied', 'Rollout', 'Template scope', 'New Pod ready', 'Functional HTTP', 'Fresh metrics'].map(name => ({ name, passed: true, detail: 'Checked by the external verifier.' })) };
  const path = '/api/runs/resolved/resolution';
  assert.equal((await post(path, report, undefined, '')).status, 401);
  assert.equal((await post(path, report, undefined, 'wrong-token')).status, 401);
  assert.equal((await post(path, report, 'https://attacker.invalid')).status, 403);
  assert.equal((await post(path, { ...report, target: { ...report.target, uid: 'other-deployment' } })).status, 400);
  assert.equal((await post(path, { ...report, checks: [{ ...report.checks[0], passed: false }] })).status, 400);
  assert.equal((await post(path, { ...report, checks: [{ name: 'forged', passed: true, detail: 'not verified' }] })).status, 400);
  assert.equal((await post(path, { ...report, patch: [] })).status, 400);
  assert.equal((await post(path, { ...report, before: { ...report.before, templateHash: 'changed-template' } })).status, 400);
  // New reports bind the retained log/event proof to the replacement Pod. Older
  // seven-check reports above remain readable without inventing missing evidence.
  assert.equal((await post('/api/runs', evidenceRequest('resolved-new'))).status, 202);
  await waitFor(() => runs.get('resolved-new').status === 'completed');
  const currentReport = { ...structuredClone(report), version: 'mas-k8s-resolution/2', operationId: 'readiness-new', attemptId: 'owner-new',
    effectOutcome: 'applied', verificationOutcome: 'passed',
    before: { ...report.before, namespaceUID: 'namespace-a', expectedTemplateHash: report.after.templateHash },
    after: { ...report.after, pod: { ...report.after.pod, readyTransitionTime: '2026-10-16T12:00:30Z' } },
    checks: [...report.checks, ...['Post-change logs', 'Post-change events'].map(name => ({ name, passed: true, detail: 'Retained replacement-Pod observations.' }))],
    verificationEvidence: { version: 'mas-k8s-post-change-evidence/1',
      subject: { namespace: 'mas-demo', name: 'mas-demo-checkout-b', uid: 'pod-b', container: 'checkout' },
      window: { startedAt: '2026-10-16T12:00:40Z', endedAt: '2026-10-16T12:00:55Z' },
      logs: { status: 'collected', source: 'Kubernetes API checkout current logs', observedAt: '2026-10-16T12:00:54Z', truncated: false,
        records: [{ timestamp: '2026-10-16T12:00:50Z', method: 'GET', path: '/healthz', status: 200 }], omittedLines: 0, unparsedLines: 0 },
      events: { status: 'collected', source: 'Kubernetes API Pod UID events', observedAt: '2026-10-16T12:00:55Z', truncated: false, items: [] } } };
  const newPath = '/api/runs/resolved-new/resolution';
  for (const change of [
    (value: typeof currentReport) => { value.verificationEvidence.subject.uid = 'wrong-pod'; },
    (value: typeof currentReport) => { value.verificationEvidence.logs.status = 'unavailable'; value.verificationEvidence.logs.records = []; },
    (value: typeof currentReport) => { value.verificationEvidence.logs.records[0]!.status = 404; },
    (value: typeof currentReport) => { value.verificationEvidence.logs.records[0]!.timestamp = '2026-10-16T12:00:00Z'; },
    (value: typeof currentReport) => { value.verificationEvidence.events.truncated = true; },
    (value: typeof currentReport) => { value.checks = report.checks; },
  ]) {
    const invalid = structuredClone(currentReport); change(invalid);
    assert.equal((await post(newPath, invalid)).status, 400);
  }
  assert.equal((await post(newPath, currentReport)).status, 202);
  assert.deepEqual((await runs.snapshot('resolved-new')).run.resolution, currentReport);
  assert.equal((await post(path, report)).status, 202);
  assert.equal(runs.observations.has('resolved'), false, 'A retained tool outcome invalidates the old host observation timestamp');
  assert.equal((await post(path, report)).status, 202);
  assert.equal((await post(path, { ...report, reason: 'different outcome' })).status, 409);
  const restarted = new Runs(dir, 'fixture', host);
  await restarted.initialise();
  assert.deepEqual((await restarted.snapshot('resolved')).run.resolution, report);
  assert.deepEqual(await restarted.recordResolution('resolved', report), restarted.get('resolved'));
  assert.equal((await post('/api/runs', { ...body, id: 'too-large', ignored: 'a'.repeat(65536) })).status, 413);
});

test('resolution reporting is disabled without an independently configured verifier credential', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-no-verifier-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runs = new Runs(dir, 'fixture', {} as Host);
  const server = application(runs, {}, dir);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/runs/forged/resolution`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 503);
});

test('authenticated reconciliation appends exact report-bound evidence, retains uncertainty and returns small receipts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-reconcile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = { run: async () => ({ assessment: 'x'.repeat(90_000) }), observe: async () => ({ messages: [] }) } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  const input = evidenceRequest('uncertain-operation');
  (input.evidence.items[0]!.data as { templateHash: string }).templateHash = 'a'.repeat(64);
  await runs.create(input);
  await waitFor(() => runs.get(input.id).status === 'completed');
  const token = 'independent-verifier';
  const server = application(runs, {}, dir, token);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const post = (kind: string, value: unknown, credential = token) => fetch(`http://127.0.0.1:${address.port}/api/runs/${input.id}/${kind}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` }, body: JSON.stringify(value),
  });
  const report = { version: 'mas-k8s-resolution/2', status: 'failed', operationId: 'readiness-1', attemptId: 'owner-1',
    effectOutcome: 'unknown', verificationOutcome: 'not_run', action: 'replace_readiness_probe_path',
    target: { namespace: 'mas-demo', name: 'mas-demo-checkout', uid: 'deployment-a' }, recordedAt: '2026-10-16T12:01:00Z',
    reason: 'The response was lost', patch: [], before: { namespaceUID: 'namespace-1', templateHash: 'a'.repeat(64), expectedTemplateHash: 'b'.repeat(64) },
    after: null, checks: [{ name: 'Execution outcome', passed: false, detail: 'No acknowledged outcome' }] };
  assert.equal((await post('resolution', { ...report, status: 'verified', verificationOutcome: 'passed' })).status, 400);
  const response = await post('resolution', report);
  assert.equal(response.status, 202);
  const receipt = await response.text();
  assert.ok(receipt.length < 300, 'A publication receipt does not echo the large retained run');
  assert.equal(JSON.parse(receipt).recordId, createHash('sha256').update(JSON.stringify(report)).digest('hex'));
  const digest = (value: unknown) => createHash('sha256').update(canonicalJSON(value)).digest('hex');
  const content = { version: 'mas-k8s-reconciliation/1', sequence: 1, runId: input.id,
    operationId: report.operationId, attemptId: report.attemptId, reportDigest: digest(report),
    target: report.target, originalTemplateHash: 'a'.repeat(64), observedAt: '2026-10-16T12:02:00Z', state: 'desired',
    reason: 'Desired template observed, without attribution to the uncertain attempt',
    evidence: { namespaceUID: 'namespace-1', uid: 'deployment-a', resourceVersion: '45', templateHash: 'b'.repeat(64),
      readinessPath: '/healthz', generation: 3, observedGeneration: 3, readyReplicas: 1 } };
  const observation = { ...content, id: digest(content) };
  assert.equal((await post('reconciliations', observation, 'wrong')).status, 401);
  for (const change of [{ attemptId: 'other' }, { reportDigest: 'c'.repeat(64) }, { runId: 'other' },
    { originalTemplateHash: 'c'.repeat(64) }, { evidence: { ...content.evidence, namespaceUID: 'replaced-namespace' } }]) {
    const bad = { ...content, ...change };
    assert.equal((await post('reconciliations', { ...bad, id: digest(bad) })).status, 400);
  }
  assert.equal((await post('reconciliations', observation)).status, 202);
  assert.equal((await post('reconciliations', observation)).status, 202);
  const changed = { ...content, reason: 'Different evidence under the same sequence' };
  assert.equal((await post('reconciliations', { ...changed, id: digest(changed) })).status, 409);
  assert.deepEqual(runs.get(input.id).resolution, report);
  assert.equal(runs.get(input.id).reconciliations!.length, 1);
  const restarted = new Runs(dir, 'fixture', host); await restarted.initialise();
  assert.deepEqual(restarted.get(input.id).resolution, report);
  assert.deepEqual(restarted.get(input.id).reconciliations, [observation]);
});

test('legacy retained event-only runs keep idempotency without rewriting their historical input', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-legacy-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = { incident: { scenario: 'pod-crash', source: 'kubernetes-event', event: { reason: 'BackOff' },
    context: 'Demonstration only. No logs, metrics or live resource specifications have been collected.' } };
  await mkdir(join(dir, 'old-run'));
  await writeFile(join(dir, 'old-run', 'run.json'), JSON.stringify({ id: 'old-run', mode: 'fixture', status: 'completed', startedAt: '2026-10-16T12:00:00Z', input, fingerprint: 'legacy-hash' }));
  const host = { run: async () => { throw new Error('must not repeat'); } } as unknown as Host;
  const runs = new Runs(dir, 'fixture', host);
  await runs.initialise();
  assert.deepEqual((await runs.create({ id: 'old-run', scenario: 'pod-crash', event: { reason: 'BackOff' } })).input, input);
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the run transition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
