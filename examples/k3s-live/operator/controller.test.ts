import assert from 'node:assert/strict';
import test from 'node:test';
import { APIError, DemoController, TRIGGER_LABEL, APPROACH_LABEL, type DemoAPI, type DemoRun,
  type KubernetesAPI, type KubernetesEvent, type RunState } from './controller.js';
import { evidenceFromStorage } from './evidence.js';

const now = Date.parse('2026-10-16T10:00:00Z');
const run = (name: string, phase?: 'Pending' | 'Running' | 'Succeeded' | 'Failed'): DemoRun => ({
  apiVersion: 'demo.mas.dev/v1alpha1', kind: 'MASDemoRun',
  metadata: { name, uid: name, namespace: 'mas-demo', creationTimestamp: new Date(now).toISOString() },
  spec: { scenario: 'pod-crash' }, ...(phase ? { status: { phase, runId: `k8s-${name}` } } : {}),
});

class Kube implements KubernetesAPI {
  runs: DemoRun[] = [];
  events: KubernetesEvent[] = [];
  pod = { metadata: { name: 'crash', namespace: 'mas-demo', uid: 'pod-uid',
    labels: { [TRIGGER_LABEL]: 'true' } as Record<string, string> },
    spec: { containers: [{ name: 'checkout', readinessProbe: { httpGet: { path: '/ready', port: 8081 } } }] } };
  reads: string[] = [];
  creates = 0;
  failStatus = false;
  async list<T>(path: string): Promise<T[]> {
    return (path.includes('/events?') ? this.events : this.runs) as T[];
  }
  async get<T>(path: string): Promise<T> { this.reads.push(path); return this.pod as T; }
  async create<T>(_path: string, resource: unknown): Promise<T> {
    const next = resource as DemoRun;
    if (this.runs.some(existing => existing.metadata.name === next.metadata.name)) throw new APIError(409, 'Already exists');
    next.metadata.uid = `cr-${this.creates++}`;
    next.metadata.creationTimestamp = new Date(now).toISOString();
    this.runs.push(next);
    return next as T;
  }
  async status(path: string, status: unknown): Promise<void> {
    if (this.failStatus) { this.failStatus = false; throw new APIError(500, 'Lost status response'); }
    const selected = this.runs.find(item => path.endsWith(`/${item.metadata.name}/status`));
    assert.ok(selected);
    selected.status = status as DemoRun['status'];
  }
}

class Demo implements DemoAPI {
  states = new Map<string, RunState>();
  starts = 0;
  rejectStart = false;
  loseStartResponse = false;
  inputs: Parameters<DemoAPI['start']>[0][] = [];
  async get(id: string): Promise<RunState | undefined> { return this.states.get(id); }
  async start(input: Parameters<DemoAPI['start']>[0]): Promise<RunState> {
    if (this.rejectStart) throw new APIError(429, 'Busy');
    this.starts++;
    this.inputs.push(structuredClone(input));
    const state: RunState = { id: input.id, status: 'running' };
    this.states.set(input.id, state);
    if (this.loseStartResponse) { this.loseStartResponse = false; throw new APIError(500, 'Lost start response'); }
    return state;
  }
}

function fixture() {
  const kube = new Kube();
  const demo = new Demo();
  const create = () => new DemoController(kube, demo, { namespace: 'mas-demo', now: () => now, log: () => {} });
  return { kube, demo, create };
}

function warning(overrides: Partial<KubernetesEvent> = {}): KubernetesEvent {
  return { metadata: { name: 'crash.123', uid: 'event-uid', creationTimestamp: new Date(now).toISOString() },
    type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container',
    involvedObject: { kind: 'Pod', name: 'crash', namespace: 'mas-demo', uid: 'pod-uid' }, ...overrides };
}

test('labelled pod Warning creates one CR, starts one run and survives controller restart', async () => {
  const { kube, demo, create } = fixture();
  kube.events.push(warning());
  await create().tick();
  assert.equal(kube.creates, 1);
  const retainedEvidence = structuredClone(kube.runs[0]?.spec.evidence);
  assert.ok(retainedEvidence?.items.find(item => item.id === 'pod'));
  assert.equal(demo.starts, 0, 'Evidence and CR persist before a backend run starts');
  await create().tick();
  assert.equal(demo.starts, 1);
  assert.deepEqual(demo.inputs[0]?.evidence, evidenceFromStorage(retainedEvidence));
  assert.equal(demo.inputs[0]?.scenario, 'pod-incident');
  assert.equal(demo.inputs[0]?.approach, 'collected');
  demo.states.set('k8s-cr-0', { id: 'k8s-cr-0', status: 'completed' });
  await create().tick();
  await create().tick();
  assert.equal(kube.runs[0].status?.phase, 'Succeeded');
  assert.equal(kube.creates, 1);
  assert.equal(demo.starts, 1);
});

test('lost backend start response reuses the admitted identity and immutable evidence without repeating inference', async () => {
  const { kube, demo, create } = fixture();
  kube.events.push(warning());
  await create().tick();
  const captured = structuredClone(kube.runs[0]?.spec.evidence);
  demo.loseStartResponse = true;
  await assert.rejects(create().tick(), /Lost start response/);
  assert.equal(demo.starts, 1);
  kube.pod.metadata.uid = 'replacement-pod';
  await create().tick();
  assert.equal(demo.starts, 1);
  assert.equal(kube.runs[0]?.status?.phase, 'Running');
  assert.deepEqual(demo.inputs[0]?.evidence, evidenceFromStorage(captured));
});

test('unlabelled pods, stale events, Normal events and reused Pod names do not trigger', async () => {
  const { kube, create } = fixture();
  kube.pod.metadata.labels[TRIGGER_LABEL] = 'false';
  kube.events = [warning()];
  await create().tick();
  kube.pod.metadata.labels[TRIGGER_LABEL] = 'true';
  kube.events = [warning({ metadata: { name: 'old', uid: 'old', creationTimestamp: '2026-10-15T10:00:00Z' } }),
    warning({ type: 'Normal' }),
    warning({ involvedObject: { kind: 'Pod', name: 'crash', namespace: 'mas-demo', uid: 'previous-pod' } })];
  await create().tick();
  assert.equal(kube.creates, 0);
});

test('lost Kubernetes status response reconciles retained backend run without restarting it', async () => {
  const { kube, demo, create } = fixture();
  kube.runs.push(run('manual'));
  kube.failStatus = true;
  await assert.rejects(create().tick(), /Lost status/);
  assert.equal(demo.starts, 1);
  await create().tick();
  assert.equal(demo.starts, 1);
  assert.equal(kube.runs[0].status?.phase, 'Running');
});

test('existing live run is counted before an older queued CR is admitted', async () => {
  const { kube, demo, create } = fixture();
  const queued = run('a-queued');
  const running = run('z-running');
  kube.runs.push(queued, running);
  demo.states.set('k8s-z-running', { id: 'k8s-z-running', status: 'running' });
  await create().tick();
  assert.equal(demo.starts, 0);
  demo.states.set('k8s-z-running', { id: 'k8s-z-running', status: 'completed' });
  await create().tick();
  assert.equal(demo.starts, 1);
  assert.equal(queued.status?.phase, 'Running');
});

test('backend backpressure is retried using the same run identity', async () => {
  const { kube, demo, create } = fixture();
  kube.runs.push(run('manual'));
  demo.rejectStart = true;
  await assert.rejects(create().tick(), error => error instanceof APIError && error.statusCode === 429);
  demo.rejectStart = false;
  await create().tick();
  assert.equal(kube.runs[0].status?.runId, 'k8s-manual');
  assert.equal(demo.starts, 1);
});

test('pending queue bounds event admission and explicit Event labels work without a Pod', async () => {
  const { kube, create } = fixture();
  kube.runs = Array.from({ length: 4 }, (_, index) => run(`manual-${index}`));
  kube.events = [warning({ metadata: { name: 'labelled', uid: 'labelled', creationTimestamp: new Date(now).toISOString(),
    labels: { [TRIGGER_LABEL]: 'true' } }, involvedObject: { kind: 'Deployment', name: 'demo' } })];
  await create().tick();
  assert.equal(kube.creates, 0);
  kube.runs = [];
  await create().tick();
  assert.equal(kube.creates, 1);
  assert.equal(kube.runs[0].spec.event?.involvedObject.kind, 'Deployment');
});


test('managed MCP workload retains only its UID-matched Pod and trigger, then starts the MCP approach', async () => {
  const { kube, demo, create } = fixture();
  kube.pod.metadata.labels['app.kubernetes.io/name'] = 'mas-demo-checkout-mcp';
  kube.pod.metadata.labels[APPROACH_LABEL] = 'mcp';
  kube.events = [warning()];
  await create().tick();
  assert.equal(kube.runs[0]?.spec.approach, 'mcp');
  assert.deepEqual(kube.reads, ['/api/v1/namespaces/mas-demo/pods/crash']);
  const seed = kube.runs[0]!.spec.evidence!;
  assert.deepEqual(seed.items.map(item => item.id), ['pod', 'events']);
  assert.equal(seed.subject.uid, 'pod-uid');
  assert.deepEqual(seed.items[1]?.data, [kube.runs[0]?.spec.event]);
  assert.equal((seed.items[0]?.data as { metadata: { labels: Record<string, string> } }).metadata.labels[APPROACH_LABEL], 'mcp');
  await create().tick();
  assert.equal(demo.inputs[0]?.approach, 'mcp');
  assert.deepEqual(demo.inputs[0]?.evidence, evidenceFromStorage(seed));
  assert.equal(demo.starts, 1);
});

test('workload policy routes both approaches without requiring the optional approach label', async () => {
  for (const [workload, approach] of [['mas-demo-checkout', 'collected'], ['mas-demo-checkout-mcp', 'mcp']]) {
    const { kube, create } = fixture();
    kube.pod.metadata.labels['app.kubernetes.io/name'] = workload!;
    kube.events = [warning()];
    await create().tick();
    assert.equal(kube.runs[0]?.spec.approach, approach);
  }
});

test('managed workload and explicit approach mismatches cannot admit or redirect an incident', async () => {
  for (const [workload, approach] of [['mas-demo-checkout', 'mcp'], ['mas-demo-checkout-mcp', 'collected'],
    ['mas-demo-checkout-mcp', 'unknown'], ['unmanaged-workload', 'mcp']]) {
    const { kube, create } = fixture();
    kube.pod.metadata.labels['app.kubernetes.io/name'] = workload!;
    kube.pod.metadata.labels[APPROACH_LABEL] = approach!;
    kube.events = [warning()];
    await create().tick();
    assert.equal(kube.creates, 0);
  }
});

test('Event labels opt in but cannot select another workload or approach, or bypass a reused Pod UID', async () => {
  const { kube, create } = fixture();
  kube.pod.metadata.labels[TRIGGER_LABEL] = 'false';
  kube.pod.metadata.labels['app.kubernetes.io/name'] = 'mas-demo-checkout';
  kube.events = [warning({ metadata: { name: 'labelled', uid: 'labelled', creationTimestamp: new Date(now).toISOString(),
    labels: { [TRIGGER_LABEL]: 'true', [APPROACH_LABEL]: 'mcp', 'app.kubernetes.io/name': 'mas-demo-checkout-mcp' } } })];
  await create().tick();
  assert.equal(kube.runs[0]?.spec.approach, 'collected');
  kube.runs = [];
  kube.pod.metadata.uid = 'replacement-pod';
  await create().tick();
  assert.equal(kube.creates, 1, 'the labelled old Event cannot trigger the replacement Pod');
});

test('missing Pod and cross-namespace Pod Events cannot enter the MCP path', async () => {
  const { kube, create } = fixture();
  kube.pod.metadata.labels['app.kubernetes.io/name'] = 'mas-demo-checkout-mcp';
  kube.events = [warning({ involvedObject: { kind: 'Pod', name: 'crash', namespace: 'other', uid: 'pod-uid' } })];
  await create().tick();
  assert.equal(kube.creates, 0);
  assert.deepEqual(kube.reads, []);
  kube.events = [warning()];
  kube.get = async () => { throw new APIError(404, 'Pod not found'); };
  await create().tick();
  assert.equal(kube.creates, 0);
});
