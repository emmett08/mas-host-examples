import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { APIError, type DemoRun } from '../operator/controller.js';
import type { EvidenceBundle } from '../shared/evidence.js';
import type { ReconciliationObservation } from '../shared/resolution.js';
import { canonicalJSON, JOURNAL_PATH, NAMESPACE, RemediationController, RUN_PATH,
  type RemediationBackendAPI, type RemediationJournal, type RemediationKubernetesAPI,
  type ResolutionReport, type Resolver, type Snapshot } from './controller.js';

const epoch = Date.parse('2026-10-16T17:00:00Z');
const clone = <T>(value: T): T => structuredClone(value);
const source = (id = 'run-1'): DemoRun => ({ apiVersion: 'demo.mas.dev/v1alpha1', kind: 'MASDemoRun',
  metadata: { namespace: NAMESPACE, name: id, uid: id, creationTimestamp: new Date(epoch).toISOString() },
  status: { phase: 'Succeeded', runId: `k8s-${id}` }, spec: {
    scenario: 'pod-incident', event: { namespace: NAMESPACE, name: 'unhealthy', uid: `event-${id}`,
      reason: 'Unhealthy', message: 'Readiness probe failed: HTTP 404',
      involvedObject: { kind: 'Pod', namespace: NAMESPACE, name: 'checkout-original', uid: 'pod-original' } },
    evidence: { version: 'mas-k8s-evidence/1', capturedAt: new Date(epoch).toISOString(),
      subject: { namespace: NAMESPACE, name: 'checkout-original', uid: 'pod-original' },
      items: [{ id: 'workload-deployment', kind: 'workload', source: 'Kubernetes API', status: 'collected',
        observedAt: new Date(epoch).toISOString(), truncated: false,
        data: { kind: 'Deployment', metadata: { namespace: NAMESPACE, name: 'mas-demo-checkout', uid: 'deployment-1' },
          templateHash: 'a'.repeat(64) } },
      { id: 'logs-checkout-previous', kind: 'logs', source: 'Kubernetes API', status: 'unavailable',
        observedAt: new Date(epoch).toISOString(), truncated: false, data: null, reason: 'No previous container' }],
    },
  } });
function snapshot(run: DemoRun): Snapshot {
  return { run: { id: `k8s-${run.metadata.uid}`, status: 'completed', startedAt: new Date(epoch).toISOString(), input: {
    incident: { scenario: 'pod-incident', source: 'kubernetes-event', event: clone(run.spec.event), evidence: clone(run.spec.evidence) },
  }, output: { requires_human: false } } };
}
function mcpSource(id = 'mcp-run'): { run: DemoRun; state: Snapshot } {
  const run = source(id);
  run.spec.approach = 'mcp';
  run.spec.event!.involvedObject = { kind: 'Pod', namespace: NAMESPACE, name: 'checkout-mcp-original', uid: 'pod-mcp-original' };
  run.spec.evidence!.subject = { namespace: NAMESPACE, name: 'checkout-mcp-original', uid: 'pod-mcp-original' };
  const deployment = run.spec.evidence!.items[0]!.data as { metadata: { name: string; uid: string } };
  deployment.metadata.name = 'mas-demo-checkout-mcp';
  deployment.metadata.uid = 'deployment-mcp';
  const state = snapshot(run);
  state.run.approach = 'mcp';
  state.run.admissionEvidence = clone(run.spec.evidence!);
  const evidence = state.run.input.incident.evidence!;
  evidence.capturedAt = new Date(epoch + 1000).toISOString();
  const contextSha256 = 'c'.repeat(64);
  state.run.investigation = { status: 'completed', runId: state.run.id, source: 'kubernetes-api', contextSha256,
    evidence: clone(evidence), calls: ['pod_overview', 'workload_spec', 'pod_logs', 'pod_metrics'].map((tool, index) => ({
      id: `tool-${index}`, tool, status: 'collected', contextSha256, evidenceIds: evidence.items.map(item => item.id),
    })) };
  return { run, state };
}
function report(status: ResolutionReport['status'] = 'not-attempted'): ResolutionReport {
  return { version: 'mas-k8s-resolution/1', status, action: 'replace_readiness_probe_path',
    target: { namespace: NAMESPACE, name: 'mas-demo-checkout', uid: 'deployment-1' },
    recordedAt: new Date(epoch).toISOString(), reason: 'Test executor result',
    patch: [{ op: 'replace', path: '/spec/template/spec/containers/0/readinessProbe/httpGet/path', value: '/healthz' }],
    before: { templateHash: 'a'.repeat(64), readinessPath: '/readyz' },
    after: status === 'verified' ? { readinessPath: '/healthz' } : null,
    checks: [{ name: 'Admission', passed: true, detail: 'Test admission predicate' }] };
}

class Kube implements RemediationKubernetesAPI {
  runs: DemoRun[] = [source()];
  journals = new Map<string, RemediationJournal>();
  pods = new Map<string, { metadata: { uid: string }; status: { phase: string } }>();
  revision = 0;
  creates = 0;
  lostApplyingACK = false;
  lostFinishedACK = false;
  lostCreateACK = false;
  beforeReplace?: (journal: RemediationJournal) => Promise<void>;
  async list<T>(path: string): Promise<T[]> {
    if (path === RUN_PATH) return clone(this.runs) as T[];
    if (path === JOURNAL_PATH) return clone([...this.journals.values()]) as T[];
    throw new Error(`Unexpected list ${path}`);
  }
  async get<T>(path: string): Promise<T> {
    if (path === `/api/v1/namespaces/${NAMESPACE}`) return { metadata: { uid: 'namespace-1' } } as T;
    const podName = path.match(/\/pods\/([^/]+)$/)?.[1];
    if (podName) {
      const pod = this.pods.get(podName);
      if (!pod) throw new APIError(404, 'Missing Pod');
      return clone(pod) as T;
    }
    const journal = this.journals.get(path);
    if (!journal) throw new APIError(404, 'Missing journal');
    return clone(journal) as T;
  }
  async create<T>(path: string, resource: unknown): Promise<T> {
    assert.equal(path, JOURNAL_PATH);
    const journal = clone(resource as RemediationJournal);
    const key = `${path}/${journal.metadata.name}`;
    if (this.journals.has(key)) throw new APIError(409, 'Already exists');
    this.creates++;
    journal.metadata.uid = `journal-${this.creates}`;
    journal.metadata.resourceVersion = String(++this.revision);
    this.journals.set(key, journal);
    if (this.lostCreateACK) { this.lostCreateACK = false; throw new Error('Create response lost after persistence'); }
    return clone(journal) as T;
  }
  async replace<T>(path: string, resource: unknown): Promise<T> {
    assert.ok(path.endsWith('/status'));
    const next = clone(resource as RemediationJournal);
    await this.beforeReplace?.(next);
    const key = path.slice(0, -'/status'.length);
    const current = this.journals.get(key);
    if (!current || current.metadata.resourceVersion !== next.metadata.resourceVersion) throw new APIError(409, 'CAS conflict');
    assert.deepEqual(next.spec, current.spec);
    next.metadata.resourceVersion = String(++this.revision);
    this.journals.set(key, next);
    if (this.lostApplyingACK && next.status?.phase === 'Applying') {
      this.lostApplyingACK = false;
      throw new Error('Applying response lost after persistence');
    }
    if (this.lostFinishedACK && next.status?.phase === 'Finished') {
      this.lostFinishedACK = false;
      throw new Error('Finished response lost after persistence');
    }
    return clone(next) as T;
  }
  journal() { assert.equal(this.journals.size, 1); return [...this.journals.values()][0]!; }
}
class Backend implements RemediationBackendAPI {
  snapshots = new Map<string, Snapshot>();
  reports: { id: string; report: ResolutionReport }[] = [];
  failNextReport = false;
  observations: ReconciliationObservation[] = [];
  async reconcile(id: string, value: ReconciliationObservation) {
    const run = this.snapshots.get(id)?.run;
    if (run) {
      run.reconciliations ??= [];
      if (!run.reconciliations.some(item => item.id === value.id)) run.reconciliations.push(clone(value));
    }
    this.observations.push(clone(value));
  }
  async snapshot(id: string) { return clone(this.snapshots.get(id)); }
  async report(id: string, value: ResolutionReport) {
    const saved = this.snapshots.get(id)?.run;
    if (saved?.resolution && canonicalJSON(saved.resolution) !== canonicalJSON(value)) throw new APIError(409, 'Report is immutable');
    if (saved) saved.resolution = clone(value);
    this.reports.push({ id, report: clone(value) });
    if (this.failNextReport) { this.failNextReport = false; throw new Error('Report response lost'); }
  }
}
function fixture() {
  const kube = new Kube();
  const backend = new Backend();
  backend.snapshots.set('k8s-run-1', snapshot(kube.runs[0]!));
  let clock = epoch;
  let effects = 0;
  let calls = 0;
  const normal: Resolver = async (_snapshot, options) => {
    calls++;
    await options.beforePatch(report());
    effects++;
    return report('verified');
  };
  const make = (ownerId = 'boot-1', podUID = 'controller-pod-1', resolver: Resolver = normal, enabled = true) =>
    new RemediationController(kube, backend, resolver, { namespace: NAMESPACE, enabled, ownerId, podUID,
      podName: podUID, now: () => clock, log: () => {} });
  return { kube, backend, make, effects: () => effects, calls: () => calls, setTime: (value: number) => { clock = value; } };
}

test('the durable terminal report precedes publication and repeated polls never repeat an effect', async () => {
  const f = fixture();
  f.backend.report = async (id, value) => {
    assert.equal(f.kube.journal().status?.phase, 'Finished');
    assert.equal(f.kube.journal().status?.reportJson, canonicalJSON(value));
    f.backend.reports.push({ id, report: clone(value) });
  };
  await f.make().tick();
  await f.make().tick();
  assert.equal(f.effects(), 1);
  assert.equal(f.calls(), 1);
  assert.equal(f.kube.journal().status?.phase, 'Finished');
  assert.ok(f.backend.reports.every(value => value.report.status === 'verified'));
});

test('two racing controller processes obtain only one acknowledged reservation and one effect', async () => {
  const f = fixture();
  await Promise.all([f.make('boot-a', 'pod-a').tick(), f.make('boot-b', 'pod-b').tick()]);
  assert.equal(f.kube.creates, 1);
  assert.equal(f.effects(), 1);
  assert.equal(f.kube.journal().status?.phase, 'Finished');
  assert.ok(f.backend.reports.every(value => value.report.status === 'verified'), 'The CAS loser must not publish its local failure');
});

test('a lost Applying acknowledgement grants no effect and restart marks the retained reservation uncertain', async () => {
  const f = fixture();
  f.kube.lostApplyingACK = true;
  await f.make().tick();
  assert.equal(f.effects(), 0);
  assert.equal(f.backend.reports.length, 0);
  assert.equal(f.kube.journal().status?.phase, 'Applying');
  await f.make('new-boot-same-pod').tick();
  assert.equal(f.effects(), 0);
  assert.equal(f.calls(), 1);
  assert.equal(f.kube.journal().status?.phase, 'Finished');
  assert.equal(f.backend.reports[0]?.report.status, 'failed');
  assert.match(f.backend.reports[0]!.report.reason, /may have occurred/);
  assert.deepEqual(f.backend.reports[0]!.report.patch, report().patch);
});

test('a lost journal-create acknowledgement stops this invocation; a later Pending CAS may admit the first effect', async () => {
  const f = fixture();
  f.kube.lostCreateACK = true;
  await f.make().tick();
  assert.equal(f.kube.journal().status, undefined);
  assert.equal(f.effects(), 0);
  assert.equal(f.backend.reports.length, 0);
  await f.make('new-boot').tick();
  assert.equal(f.effects(), 1);
  assert.equal(f.kube.creates, 1);
});

test('a live other Pod keeps its reservation until the conservative deadline, then never retries', async () => {
  const f = fixture();
  f.kube.lostApplyingACK = true;
  await f.make('old-boot', 'old-pod').tick();
  f.kube.pods.set('old-pod', { metadata: { uid: 'old-pod' }, status: { phase: 'Running' } });
  await f.make('new-boot', 'new-pod').tick();
  assert.equal(f.kube.journal().status?.phase, 'Applying');
  assert.equal(f.backend.reports.length, 0);
  f.setTime(epoch + 5 * 60_000);
  await f.make('new-boot', 'new-pod').tick();
  assert.equal(f.kube.journal().status?.phase, 'Finished');
  assert.equal(f.backend.reports[0]?.report.status, 'failed');
  assert.equal(f.effects(), 0);
});

test('a missing, replaced or terminal owner Pod makes Applying uncertain without repeating execution', async () => {
  for (const state of ['missing', 'replacement', 'Failed']) {
    const f = fixture();
    f.kube.lostApplyingACK = true;
    await f.make('old-boot', 'old-pod').tick();
    if (state !== 'missing') f.kube.pods.set('old-pod', {
      metadata: { uid: state === 'replacement' ? 'new-uid' : 'old-pod' }, status: { phase: state === 'replacement' ? 'Running' : state },
    });
    await f.make('new-boot', 'new-pod').tick();
    assert.equal(f.effects(), 0);
    assert.equal(f.calls(), 1);
    assert.equal(f.kube.journal().status?.phase, 'Finished');
  }
});

test('a lost terminal acknowledgement reads back the authoritative Finished result', async () => {
  const f = fixture();
  f.kube.lostFinishedACK = true;
  await f.make().tick();
  assert.equal(f.effects(), 1);
  assert.equal(f.backend.reports[0]?.report.status, 'verified');
  await f.make('next-boot').tick();
  assert.equal(f.effects(), 1);
});

test('backend publication failures retain and replay the identical terminal report', async () => {
  const f = fixture();
  f.backend.failNextReport = true;
  await f.make().tick();
  const first = canonicalJSON(f.backend.reports[0]?.report);
  assert.equal(f.kube.journal().status?.phase, 'Finished');
  f.setTime(epoch + 20 * 60_000);
  await f.make('next-boot').tick();
  assert.equal(f.effects(), 1);
  assert.ok(f.backend.reports.length >= 2);
  assert.ok(f.backend.reports.every(value => canonicalJSON(value.report) === first));
});

test('a competing uncertain terminal record overrides a late verified executor result', async () => {
  const f = fixture();
  const late: Resolver = async (_snapshot, options) => {
    await options.beforePatch(report());
    f.setTime(epoch + 5 * 60_000);
    await f.make('reaper-boot', 'reaper-pod').tick();
    return report('verified');
  };
  await f.make('slow-boot', 'slow-pod', late).tick();
  assert.equal(f.kube.journal().status?.phase, 'Finished');
  assert.ok(f.backend.reports.length > 0);
  assert.ok(f.backend.reports.every(value => value.report.status === 'failed'));
  assert.match(JSON.parse(f.kube.journal().status!.reportJson!).reason, /may have occurred/);
});

test('stale evidence is rejected both at admission and immediately before reservation', async () => {
  const f = fixture();
  f.setTime(epoch + 10 * 60_000 + 1);
  await f.make().tick();
  assert.equal(f.kube.creates, 0);
  assert.equal(f.effects(), 0);
  const g = fixture();
  await g.make('boot', 'pod', async (_snapshot, options) => {
    g.setTime(epoch + 10 * 60_000 + 1);
    await options.beforePatch(report());
    throw new Error('Must not reach a mutation');
  }).tick();
  assert.equal(g.kube.journals.size, 0);
  assert.equal(g.backend.reports.length, 0);
});

test('evidence ageing during the Applying CAS stops before the effect and preserves uncertainty', async () => {
  const f = fixture();
  f.setTime(epoch + 10 * 60_000 - 1);
  f.kube.beforeReplace = async next => { if (next.status?.phase === 'Applying') f.setTime(epoch + 10 * 60_000 + 1); };
  await f.make().tick();
  assert.equal(f.effects(), 0);
  assert.equal(f.kube.journal().status?.phase, 'Applying');
  assert.equal(f.backend.reports.length, 0);
});

test('backend completion, Event and evidence must exactly bind to the immutable source CR', async () => {
  for (const change of ['id', 'status', 'event', 'evidence', 'source', 'source-run-id']) {
    const f = fixture();
    const state = f.backend.snapshots.get('k8s-run-1')!;
    if (change === 'id') state.run.id = 'k8s-unrelated';
    if (change === 'status') state.run.status = 'running';
    if (change === 'event') state.run.input.incident.event!.message = 'Altered message';
    if (change === 'evidence') state.run.input.incident.evidence!.items[0]!.source = 'Altered source';
    if (change === 'source') state.run.input.incident.source = 'synthetic-scenario';
    if (change === 'source-run-id') f.kube.runs[0]!.status!.runId = 'k8s-unrelated';
    await f.make().tick();
    assert.equal(f.kube.creates, 0, change);
    assert.equal(f.effects(), 0, change);
  }
});

test('Kubernetes omitted unavailable data is hydrated to null before evidence identity comparison', async () => {
  const f = fixture();
  delete (f.kube.runs[0]!.spec.evidence!.items[1] as Partial<EvidenceBundle['items'][number]>).data;
  await f.make().tick();
  assert.equal(f.effects(), 1);
});

test('different Event/run IDs for the same original Deployment template never cause a second effect', async () => {
  const f = fixture();
  await f.make().tick();
  const second = source('run-2');
  f.kube.runs.push(second);
  f.backend.snapshots.set('k8s-run-2', snapshot(second));
  await f.make().tick();
  assert.equal(f.kube.creates, 1);
  assert.equal(f.effects(), 1);
  assert.ok(f.backend.reports.every(value => value.id === 'k8s-run-1'));
});

test('disabled automation has no API activity or executor calls', async () => {
  const f = fixture();
  f.kube.list = async () => { throw new Error('Must not call Kubernetes'); };
  await f.make('boot', 'pod', undefined, false).tick();
  assert.equal(f.calls(), 0);
  assert.equal(f.backend.reports.length, 0);
});

test('a verified result without the durable hook is rejected and unpublished', async () => {
  const f = fixture();
  await f.make('boot', 'pod', async () => report('verified')).tick();
  assert.equal(f.kube.journals.size, 0);
  assert.equal(f.backend.reports.length, 0);
});

test('preflight rejection spends no reservation or publication and a later investigation can act on better evidence', async () => {
  const f = fixture();
  const declined = report();
  declined.patch = [];
  declined.before = null;
  declined.reason = 'The agent requested engineer review';
  await f.make('boot', 'pod', async () => declined).tick();
  assert.equal(f.kube.journals.size, 0);
  assert.equal(f.effects(), 0);
  assert.equal(f.backend.reports.length, 0);
  const better = source('run-better');
  f.kube.runs = [better];
  f.backend.snapshots.set('k8s-run-better', snapshot(better));
  await f.make().tick();
  assert.equal(f.effects(), 1);
  assert.equal(f.backend.reports[0]?.id, 'k8s-run-better');
});

test('an existing backend resolution prevents a new effect when no journal exists', async () => {
  const f = fixture();
  f.backend.snapshots.get('k8s-run-1')!.run.resolution = report('failed');
  await f.make().tick();
  assert.equal(f.calls(), 0);
  assert.equal(f.kube.creates, 0);
});

function uncertainOperation() {
  const f = fixture();
  const template = { spec: { containers: [{ name: 'checkout', readinessProbe: { httpGet: { path: '/readyz' } } }] } };
  const desired = clone(template); desired.spec.containers[0]!.readinessProbe.httpGet.path = '/healthz';
  const hash = (value: unknown) => createHash('sha256').update(canonicalJSON(value)).digest('hex');
  const evidence = f.kube.runs[0]!.spec.evidence!.items[0]!.data as { templateHash: string };
  evidence.templateHash = hash(template);
  f.backend.snapshots.set('k8s-run-1', snapshot(f.kube.runs[0]!));
  let mutations = 0;
  const before = { uid: 'deployment-1', resourceVersion: '1', generation: 1, readinessPath: '/readyz',
    namespaceUID: 'namespace-1', templateHash: hash(template), expectedTemplateHash: hash(desired) };
  const get = f.kube.get.bind(f.kube);
  f.kube.get = async <T>(path: string): Promise<T> => path.includes('/deployments/')
    ? { metadata: { uid: 'deployment-1', resourceVersion: '2', generation: 2 },
      spec: { template: desired }, status: { observedGeneration: 2, readyReplicas: 1 } } as T
    : get<T>(path);
  const execute: Resolver = async (_snapshot, options) => {
    const prepared: ResolutionReport = { ...report(), version: 'mas-k8s-resolution/2',
      operationId: options.operationId, attemptId: options.attemptId, effectOutcome: 'not_started', verificationOutcome: 'not_run', before };
    await options.beforePatch(prepared);
    mutations++;
    return { ...prepared, status: 'failed', effectOutcome: 'unknown', reason: 'The patch response was lost' };
  };
  return { ...f, execute, mutations: () => mutations };
}

test('read-only reconciliation appends bounded observations and preserves original unknown across restart', async () => {
  const f = uncertainOperation();
  await f.make('owner', 'pod', f.execute).tick();
  const original = f.kube.journal().status!.reportJson;
  assert.equal(JSON.parse(original!).effectOutcome, 'unknown');
  await f.make('restart', 'new-pod', f.execute).tick();
  const first = f.backend.observations[0]!;
  assert.equal(first.state, 'desired');
  assert.equal(first.attemptId, 'owner');
  assert.equal(first.runId, 'k8s-run-1');
  assert.equal(first.reportDigest, createHash('sha256').update(original!).digest('hex'));
  assert.equal(f.kube.journal().status!.reportJson, original);
  assert.equal(f.mutations(), 1);
  for (let index = 0; index < 10; index++) await f.make('restart', 'new-pod', f.execute).tick();
  assert.equal(f.kube.journal().status!.reconciliations!.length, 1, 'Repeated polls do not append timestamps indefinitely');
  for (let index = 1; index <= 10; index++) {
    f.setTime(epoch + index * 30_000);
    await f.make('restart', 'new-pod', f.execute).tick();
  }
  assert.equal(f.kube.journal().status!.reconciliations!.length, 8);
  assert.equal(f.mutations(), 1);
  assert.equal(f.kube.journal().status!.reportJson, original);
});

test('lost observation acknowledgement and racing observers publish only retained CAS evidence', async () => {
  const f = uncertainOperation();
  await f.make('owner', 'pod', f.execute).tick();
  f.kube.lostFinishedACK = true;
  await Promise.all([f.make('reader-a', 'a', f.execute).tick(), f.make('reader-b', 'b', f.execute).tick()]);
  const retained = f.kube.journal().status!.reconciliations!;
  assert.equal(retained.length, 1);
  assert.ok(f.backend.observations.every(item => canonicalJSON(item) === retained[0]));
  assert.equal(f.mutations(), 1);
});

test('unavailable reconciliation records absence of evidence without declaring rejection or repeating mutation', async () => {
  const f = uncertainOperation();
  await f.make('owner', 'pod', f.execute).tick();
  const get = f.kube.get.bind(f.kube);
  f.kube.get = async <T>(path: string): Promise<T> => {
    if (path.includes('/deployments/')) throw new APIError(503, 'Unavailable');
    return get<T>(path);
  };
  await f.make('restart', 'other', f.execute).tick();
  assert.equal(f.backend.observations[0]!.state, 'unavailable');
  assert.equal(f.backend.observations[0]!.evidence, null);
  assert.equal(JSON.parse(f.kube.journal().status!.reportJson!).effectOutcome, 'unknown');
  assert.equal(f.mutations(), 1);
});

test('a report cannot reserve another operation or attempt identity', async () => {
  for (const changed of ['operationId', 'attemptId'] as const) {
    const f = fixture();
    const invalid: Resolver = async (_snapshot, options) => {
      await options.beforePatch({ ...report(), version: 'mas-k8s-resolution/2',
        operationId: options.operationId, attemptId: options.attemptId,
        [changed]: 'another-identity', effectOutcome: 'not_started', verificationOutcome: 'not_run' });
      throw new Error('Must not obtain effect authority');
    };
    await f.make('owner', 'pod', invalid).tick();
    assert.equal(f.kube.creates, 0);
    assert.equal(f.backend.reports.length, 0);
  }
});

test('the collected and MCP runs reserve independent targets and never repeat either repair after restart', async () => {
  const f = fixture();
  const mcp = mcpSource();
  f.kube.runs.push(mcp.run);
  f.backend.snapshots.set(mcp.state.run.id, mcp.state);
  const effects: string[] = [];
  const resolver: Resolver = async (state, options) => {
    const prepared = report();
    if (state.run.approach === 'mcp') prepared.target = { namespace: NAMESPACE, name: 'mas-demo-checkout-mcp', uid: 'deployment-mcp' };
    await options.beforePatch(prepared);
    effects.push(prepared.target.name);
    return { ...prepared, status: 'verified' };
  };
  await f.make('owner', 'pod', resolver).tick();
  await f.make('restart', 'new-pod', resolver).tick();
  assert.deepEqual(effects.sort(), ['mas-demo-checkout', 'mas-demo-checkout-mcp']);
  assert.equal(f.kube.journals.size, 2);
  assert.deepEqual([...f.kube.journals.values()].map(journal => [journal.spec.targetName, journal.spec.approach]).sort(),
    [['mas-demo-checkout', 'collected'], ['mas-demo-checkout-mcp', 'mcp']]);
  assert.ok(f.backend.reports.some(value => value.id === mcp.state.run.id && value.report.status === 'verified'));
});

test('MCP remediation rejects forged approach, seed, frozen evidence, subject and tool context before reservation', async () => {
  const changes: [string, (value: ReturnType<typeof mcpSource>) => void][] = [
    ['approach', value => { value.state.run.approach = 'collected'; }],
    ['CR approach', value => { value.run.spec.approach = 'collected'; }],
    ['admission seed', value => { value.state.run.admissionEvidence!.capturedAt = new Date(epoch - 1).toISOString(); }],
    ['missing admission', value => { delete value.state.run.admissionEvidence; }],
    ['frozen evidence', value => { value.state.run.input.incident.evidence!.capturedAt = new Date(epoch - 1).toISOString(); }],
    ['foreign subject', value => {
      value.state.run.investigation!.evidence!.subject.uid = 'other-pod';
      value.state.run.input.incident.evidence = clone(value.state.run.investigation!.evidence);
    }],
    ['context', value => { value.state.run.investigation!.contextSha256 = 'd'.repeat(64); }],
    ['call context', value => { value.state.run.investigation!.calls[0]!.contextSha256 = 'd'.repeat(64); }],
    ['missing call context', value => { delete value.state.run.investigation!.calls[0]!.contextSha256; }],
    ['recorded source', value => { value.state.run.investigation!.source = 'recorded-evidence'; }],
    ['incomplete', value => { value.state.run.investigation!.status = 'running'; }],
    ['wrong run', value => { value.state.run.investigation!.runId = 'another-run'; }],
    ['duplicate tool', value => { value.state.run.investigation!.calls[0]!.tool = 'workload_spec'; }],
    ['missing evidence', value => { value.state.run.investigation!.calls[0]!.evidenceIds.push('invented-evidence'); }],
    ['other workload', value => {
      const data = value.state.run.investigation!.evidence!.items[0]!.data as { metadata: { name: string } };
      data.metadata.name = 'mas-demo-checkout';
      value.state.run.input.incident.evidence = clone(value.state.run.investigation!.evidence);
    }],
  ];
  for (const [label, change] of changes) {
    const f = fixture(), value = mcpSource();
    change(value);
    f.kube.runs = [value.run];
    f.backend.snapshots.set(value.state.run.id, value.state);
    await f.make().tick();
    assert.equal(f.calls(), 0, label);
    assert.equal(f.kube.creates, 0, label);
    assert.equal(f.backend.reports.length, 0, label);
  }
});

test('an MCP reservation never accepts an executor report for the collected target', async () => {
  const f = fixture(), value = mcpSource();
  f.kube.runs = [value.run];
  f.backend.snapshots.set(value.state.run.id, value.state);
  await f.make().tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.effects(), 0);
  assert.equal(f.kube.creates, 0);
});

test('an abandoned MCP attempt retains the second target and cannot retry its effect', async () => {
  const f = fixture(), value = mcpSource();
  f.kube.runs = [value.run];
  f.backend.snapshots.set(value.state.run.id, value.state);
  f.kube.lostApplyingACK = true;
  let effects = 0;
  const resolver: Resolver = async (_state, options) => {
    const prepared = { ...report(), target: { namespace: NAMESPACE, name: 'mas-demo-checkout-mcp', uid: 'deployment-mcp' } };
    await options.beforePatch(prepared);
    effects++;
    return { ...prepared, status: 'verified' };
  };
  await f.make('owner', 'pod', resolver).tick();
  await f.make('restart', 'pod', resolver).tick();
  assert.equal(effects, 0);
  assert.equal(f.kube.journal().status?.phase, 'Finished');
  assert.equal(f.backend.reports[0]?.report.target.name, 'mas-demo-checkout-mcp');
  assert.equal(f.backend.reports[0]?.report.status, 'failed');
});
