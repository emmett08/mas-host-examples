import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalTemplateHash, collectEvidence, evidenceForStorage, evidenceFromStorage, projectResource } from './evidence.js';
import { safeKubernetesErrorDetails } from './client.js';
import { EVIDENCE_VERSION, MAX_EVIDENCE_BYTES, parseEvidence, redactEvidenceText, type EvidenceBundle } from '../shared/evidence.js';
import { APIError, type EventEvidence, type KubernetesAPI } from './controller.js';

const now = Date.parse('2026-10-16T15:00:00Z');
const event: EventEvidence = { namespace: 'mas-demo', name: 'checkout.warning', uid: 'event-1', reason: 'Unhealthy',
  message: 'Readiness probe failed: HTTP probe failed with statuscode: 404',
  involvedObject: { kind: 'Pod', namespace: 'mas-demo', name: 'checkout-1', uid: 'pod-1' } };
const owner = (kind: string, name: string, uid: string) => ({ apiVersion: 'apps/v1', kind, name, uid, controller: true });
const pod = {
  apiVersion: 'v1', kind: 'Pod', metadata: { namespace: 'mas-demo', name: 'checkout-1', uid: 'pod-1', resourceVersion: '9',
    creationTimestamp: '2026-10-16T14:58:00Z', labels: { 'demo.mas.dev/managed': 'true', private: 'do-not-copy' },
    ownerReferences: [owner('ReplicaSet', 'checkout-rs', 'rs-1')] },
  spec: { containers: [{ name: 'checkout', image: 'demo:1', command: ['node', 'app.mjs'], args: ['--token', 'private-token'],
    env: [{ name: 'OPENAI_API_KEY', value: 'private-key' }, { name: 'REF', valueFrom: { secretKeyRef: { name: 'credentials', key: 'password' } } }],
    resources: { requests: { cpu: '5m', memory: '32Mi' } }, readinessProbe: { httpGet: { path: '/readyz', port: 8081,
      httpHeaders: [{ name: 'Authorization', value: 'private-header' }] } } }] },
  status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }],
    containerStatuses: [{ name: 'checkout', ready: false, restartCount: 0 }] },
};
const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'checkout', namespace: 'mas-demo', uid: 'deploy-1', resourceVersion: '15' },
  spec: { replicas: 1, template: { metadata: { labels: { app: 'checkout' } }, spec: pod.spec } }, status: { readyReplicas: 0 } };

class Kube implements KubernetesAPI {
  reads: string[] = [];
  podReads = 0;
  replace = false;
  unavailableMetrics = false;
  staleMetrics = false;
  oversized = false;
  async get<T>(path: string): Promise<T> {
    this.reads.push(path);
    if (path.includes('/metrics.k8s.io/')) {
      if (this.unavailableMetrics) throw new APIError(503, 'secret server details');
      return { metadata: { name: 'checkout-1', namespace: 'mas-demo' }, timestamp: new Date(this.staleMetrics ? now - 300_000 : now - 10_000).toISOString(),
        window: '15s', containers: [{ name: 'checkout', usage: { cpu: '1000000n', memory: '25000Ki' } }] } as T;
    }
    if (path.includes('/replicasets/')) return { metadata: { name: 'checkout-rs', uid: 'rs-1', namespace: 'mas-demo',
      ownerReferences: [owner('Deployment', 'checkout', 'deploy-1')] }, spec: { template: { spec: pod.spec } } } as T;
    if (path.includes('/deployments/')) return structuredClone(deployment) as T;
    this.podReads++;
    const result = structuredClone(pod);
    if (this.replace && this.podReads > 1) result.metadata.uid = 'replacement';
    if (this.oversized) result.spec.containers[0]!.resources = { requests: { cpu: 'x'.repeat(40_000), memory: '32Mi' } };
    return result as T;
  }
  async list<T>(): Promise<T[]> { return [{ ...event, metadata: { name: event.name, uid: event.uid }, involvedObject: event.involvedObject }] as T[]; }
  async text(path: string): Promise<string> {
    if (path.includes('previous=true')) throw new APIError(400, 'previous terminated container not found');
    return '2026-10-16T14:59:58Z GET /healthz 200; GET /readyz 404; token=private-log-value';
  }
  async create<T>(): Promise<T> { throw new Error('Unexpected mutation'); }
  async status(): Promise<void> { throw new Error('Unexpected mutation'); }
}

test('collects actual identity-linked specification, logs, events, usage and full Deployment template hash', async () => {
  const kube = new Kube(), bundle = await collectEvidence(kube, event, { now: () => now });
  assert.ok(bundle);
  assert.equal(bundle.subject.uid, 'pod-1');
  assert.equal(bundle.items.find(item => item.id === 'metrics')?.status, 'collected');
  const workload = bundle.items.find(item => item.id === 'workload-deployment')?.data as typeof deployment & { templateHash: string };
  assert.equal(workload.templateHash, canonicalTemplateHash(deployment.spec.template));
  const logs = bundle.items.find(item => item.id === 'logs-checkout-current');
  assert.match(JSON.stringify(logs?.data), /readyz 404/);
  assert.doesNotMatch(JSON.stringify(bundle), /private-token|private-key|private-header|private-log-value|do-not-copy/);
  assert.equal(bundle.items.find(item => item.id === 'logs-checkout-previous')?.status, 'unavailable');
  assert.ok(kube.reads.every(path => !path.includes('/secrets')));
  assert.equal(kube.podReads, 2);
});

test('canonical template hash sorts object keys recursively, preserves arrays and includes every template field', () => {
  assert.equal(canonicalTemplateHash({ z: { b: 1, a: 2 }, a: [2, 1] }), canonicalTemplateHash({ a: [2, 1], z: { a: 2, b: 1 } }));
  assert.notEqual(canonicalTemplateHash({ a: [2, 1] }), canonicalTemplateHash({ a: [1, 2] }));
  assert.notEqual(canonicalTemplateHash(deployment.spec.template), canonicalTemplateHash({ ...deployment.spec.template, extra: true }));
});

test('recreated Pod invalidates all identity-dependent data rather than mixing evidence from two Pods', async () => {
  const kube = new Kube(); kube.replace = true;
  const bundle = await collectEvidence(kube, event, { now: () => now });
  assert.ok(bundle?.items.filter(item => item.kind !== 'events').every(item => item.status === 'unavailable' && item.data === null));
});

test('unavailable and stale metrics remain explicit and never become zero usage', async () => {
  for (const stale of [false, true]) {
    const kube = new Kube(); kube.unavailableMetrics = !stale; kube.staleMetrics = stale;
    const bundle = await collectEvidence(kube, event, { now: () => now });
    const metric = bundle?.items.find(item => item.id === 'metrics');
    assert.equal(metric?.status, 'unavailable'); assert.equal(metric?.data, null);
    assert.doesNotMatch(metric?.reason ?? '', /secret server details/);
  }
});

test('bounded collection reports timeout when an API never responds', async () => {
  const kube = new Kube();
  kube.get = async <T>() => new Promise<T>(() => {});
  const started = Date.now();
  const bundle = await collectEvidence(kube, event, { now: () => now, budgetMs: 20 });
  assert.ok(Date.now() - started < 500);
  assert.equal(bundle?.items.find(item => item.id === 'pod')?.status, 'unavailable');
});

test('owner UID mismatch refuses a replacement workload and never follows its parent', async () => {
  const kube = new Kube(), get = kube.get.bind(kube);
  kube.get = async <T>(path: string) => path.includes('/replicasets/')
    ? { metadata: { uid: 'replacement-rs', ownerReferences: [owner('Deployment', 'other-deployment', 'wrong')] } } as T
    : get<T>(path);
  const bundle = await collectEvidence(kube, event, { now: () => now });
  assert.equal(bundle?.items.find(item => item.id === 'workload-replicaset')?.status, 'unavailable');
  assert.ok(!kube.reads.some(path => path.includes('/deployments/')));
});

test('collector limits aggregate evidence size without dropping failure provenance', async () => {
  const kube = new Kube(); kube.oversized = true;
  const bundle = await collectEvidence(kube, event, { now: () => now });
  assert.ok(bundle);
  assert.ok(Buffer.byteLength(JSON.stringify(bundle)) <= MAX_EVIDENCE_BYTES);
  const item = bundle.items.find(item => item.id === 'pod');
  assert.equal(item?.truncated, true); assert.equal(item?.status, 'unavailable');
});

test('resource projection removes environment and HTTP header literals but retains diagnostic probes and commands', () => {
  const projected = JSON.stringify(projectResource(pod, 'Pod'));
  assert.match(projected, /\/readyz/); assert.match(projected, /app.mjs/); assert.match(projected, /secretKeyRef/);
  assert.doesNotMatch(projected, /private-key|private-header|private-token/);
});

test('parseEvidence rejects unsupported versions, duplicates, oversized and structurally invalid bundles', () => {
  const bundle: EvidenceBundle = { version: EVIDENCE_VERSION, capturedAt: new Date(now).toISOString(),
    subject: { namespace: 'mas-demo', name: 'checkout', uid: 'pod-1' },
    items: [{ id: 'pod', kind: 'pod', source: '/api/v1/pods', status: 'unavailable', observedAt: new Date(now).toISOString(), truncated: false, data: null }] };
  assert.equal(parseEvidence(undefined), undefined);
  assert.deepEqual(parseEvidence(bundle), bundle);
  assert.throws(() => parseEvidence({ ...bundle, version: 'other' }));
  assert.throws(() => parseEvidence({ ...bundle, items: [...bundle.items, ...bundle.items] }));
  assert.throws(() => parseEvidence({ ...bundle, items: [{ ...bundle.items[0], data: 'x'.repeat(MAX_EVIDENCE_BYTES) }] }));
  assert.throws(() => parseEvidence({ ...bundle, items: [{ ...bundle.items[0], data: {} }] }));
  assert.throws(() => parseEvidence({ ...bundle, items: [{ ...bundle.items[0], data: undefined }] }));
});

test('credential scrubber handles quoted JSON keys and preserves parseable JSON including escaped quotes', () => {
  for (const key of ['token', 'password', 'passwd', 'secret', 'api_key', 'api-key', 'ApiKey', 'TOKEN']) {
    const original = JSON.stringify({ ordinary: 'keep this', [key]: 'private-value with "escaped quotes"', trailing: true });
    const result = JSON.parse(redactEvidenceText(original));
    assert.equal(result[key], '[REDACTED]');
    assert.equal(result.ordinary, 'keep this');
    assert.equal(result.trailing, true);
    assert.doesNotMatch(JSON.stringify(result), /private-value|escaped quotes/);
  }
  assert.deepEqual(JSON.parse(redactEvidenceText('{"token": 12345,"password":false,"other":5}')),
    { token: '[REDACTED]', password: '[REDACTED]', other: 5 });
  assert.deepEqual(JSON.parse(redactEvidenceText('{"nested":{"token":["private-array-value"],"password":{"value":"private-object-value"}},"status":404}')),
    { nested: { token: '[REDACTED]', password: '[REDACTED]' }, status: 404 });
  assert.equal(JSON.parse(redactEvidenceText('{"to\\u006ben":"private-escaped-key"}')).token, '[REDACTED]');
});

test('credential scrubber handles single-quoted logs, assignment values and Basic/Bearer authentication', () => {
  for (const sample of [
    "{'token':'internal-session-secret-value'}", "{'password': 'internal-password-value'}",
    'token="internal-session-secret-value"', "password='internal-password-value'", 'token=internal-session-secret-value',
    'Authorization: Basic aW50ZXJuYWw6cGFzc3dvcmQ=', 'Authorization: Bearer internal-session-secret-value',
  ]) {
    const result = redactEvidenceText(sample);
    assert.match(result, /\[REDACTED\]/);
    assert.doesNotMatch(result, /internal-session-secret-value|internal-password-value|aW50ZXJuYWw6cGFzc3dvcmQ=/);
  }
  const prefixed = '2026-10-16T14:59:58.123456789Z {"token":"internal-session-secret-value","path":"/readyz","status":404}';
  const result = redactEvidenceText(prefixed);
  assert.equal(JSON.parse(result.slice(result.indexOf('{'))).token, '[REDACTED]');
  assert.match(result, /"path":"\/readyz","status":404/);
  const auth = JSON.parse(redactEvidenceText('{"Authorization":"Basic aW50ZXJuYWw6cGFzc3dvcmQ=","status":404}'));
  assert.equal(auth.Authorization, 'Basic [REDACTED]');
});

test('CR storage omits declared null data and restores explicit unavailable null without changing collected opaque JSON', async () => {
  const bundle = await collectEvidence(new Kube(), event, { now: () => now });
  assert.ok(bundle);
  const item = bundle.items.find(item => item.id === 'pod')!;
  (item.data as Record<string, unknown>).opaque = { nested: null, array: [null, { value: null }] };
  const stored = JSON.parse(JSON.stringify(evidenceForStorage(bundle))) as EvidenceBundle;
  const missing = stored.items.find(item => item.id === 'logs-checkout-previous')!;
  assert.equal(Object.hasOwn(missing, 'data'), false);
  assert.deepEqual(evidenceFromStorage(stored), bundle);
  assert.equal(evidenceFromStorage(undefined), undefined);
});

test('Kubernetes validation diagnostics retain reason and field codes without resource values or log secrets', () => {
  const result = safeKubernetesErrorDetails(JSON.stringify({ reason: 'Invalid',
    message: 'Rejected resource with password private-full-response', details: { causes: [
      { reason: 'FieldValueInvalid', field: 'spec', message: 'Invalid value: private-log-value: Create a new MASDemoRun to change the admitted scenario or evidence.' },
      { reason: 'FieldValueRequired', field: 'spec.evidence.items[0].data', message: 'Required value' },
    ] } }));
  assert.match(result, /Invalid; FieldValueInvalid@spec \(immutable spec check failed\)/);
  assert.match(result, /spec.evidence.items\[0\].data \(required field missing\)/);
  assert.doesNotMatch(result, /private-full-response|private-log-value/);
  assert.equal(safeKubernetesErrorDetails('not JSON'), 'Unparseable API error response');
});
