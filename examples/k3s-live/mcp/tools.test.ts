import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { APIError, type KubernetesAPI } from '../operator/controller.js';
import { EVIDENCE_VERSION } from '../shared/evidence.js';
import { InvestigationTools, CONTEXT_VERSION, exactJSON, parseContext, type InvestigationContext } from './tools.js';
import { createInvestigationServer } from './server.js';
import { freezeInvestigation } from '../server/investigation.js';

const now = Date.parse('2026-10-17T18:00:00Z');
const target = { namespace: 'mas-demo', name: 'checkout-1', uid: 'pod-1' };
const owner = (kind: string, name: string, uid: string) => ({ apiVersion: 'apps/v1', kind, name, uid, controller: true });
const pod = { metadata: { ...target, creationTimestamp: new Date(now - 120_000).toISOString(),
  ownerReferences: [owner('ReplicaSet', 'checkout-rs', 'rs-1')] },
  spec: { containers: [{ name: 'checkout', image: 'demo:1', env: [{ name: 'SECRET', value: 'hidden-env' }] }] },
  status: { phase: 'Running', containerStatuses: [{ name: 'checkout', ready: false, restartCount: 1 }] } };
function context(source: InvestigationContext['source'] = 'kubernetes-api'): InvestigationContext {
  return parseContext({ version: CONTEXT_VERSION, source,
    event: { namespace: target.namespace, name: 'warning', uid: 'event-1', reason: 'Unhealthy', message: 'Readiness failed',
      involvedObject: { ...target, kind: 'Pod' } },
    evidence: { version: EVIDENCE_VERSION, capturedAt: new Date(now).toISOString(), subject: target,
      items: [{ id: 'pod', kind: 'pod', source: '/retained/pod', observedAt: new Date(now).toISOString(),
        status: 'collected', truncated: false, data: { metadata: target, status: { phase: 'Running' } } }] } });
}
class Kube implements KubernetesAPI {
  reads: string[] = [];
  podReads = 0;
  replace = false;
  wrongOwner = false;
  unavailableMetrics = false;
  staleMetrics = false;
  large = false;
  async get<T>(path: string): Promise<T> {
    this.reads.push(path);
    if (path.includes('/metrics.k8s.io/')) {
      if (this.unavailableMetrics) throw new APIError(503, 'hidden-service-response');
      return { metadata: target, timestamp: new Date(now - (this.staleMetrics ? 300_000 : 10_000)).toISOString(),
        window: '15s', containers: [{ name: 'checkout', usage: { cpu: '1000000n', memory: '10000Ki' } }] } as T;
    }
    if (path.includes('/replicasets/')) return { metadata: { name: 'checkout-rs', uid: this.wrongOwner ? 'other-rs' : 'rs-1',
      namespace: target.namespace, ownerReferences: [owner('Deployment', 'checkout', 'deploy-1')] }, spec: { template: { spec: pod.spec } } } as T;
    if (path.includes('/deployments/')) return { metadata: { name: 'checkout', uid: 'deploy-1', namespace: target.namespace },
      spec: { template: { spec: pod.spec }, replicas: 1 } } as T;
    const result = structuredClone(pod);
    this.podReads++;
    if (this.replace && this.podReads > 1) result.metadata.uid = 'recreated-pod';
    if (this.large) (result.spec as Record<string, unknown>).containers = [{ name: 'checkout', resources: { requests: { memory: 'x'.repeat(20_000) } } }];
    return result as T;
  }
  async list<T>(path: string): Promise<T[]> { this.reads.push(path); return [{ reason: 'Unhealthy', message: 'token=hidden-event', involvedObject: target }] as T[]; }
  async text(path: string): Promise<string> { this.reads.push(path); return 'GET /readyz 404 token=hidden-log'; }
  async create<T>(): Promise<T> { throw new Error('Unexpected mutation'); }
  async status(): Promise<void> { throw new Error('Unexpected mutation'); }
}

test('incident binding rejects mismatched identity and path-like target names', () => {
  const base = context();
  for (const change of [{ uid: 'different-pod' }, { namespace: 'another' }, { name: '../secrets' }])
    assert.throws(() => parseContext({ ...base, event: { ...base.event, involvedObject: { ...base.event.involvedObject, ...change } } }));
});

test('each live tool reads only requested evidence with Pod and owner UID checks', async () => {
  for (const tool of ['pod_overview', 'pod_logs', 'pod_metrics', 'workload_spec']) {
    const kube = new Kube(), result = await new InvestigationTools(context(), kube, { now: () => now }).call(tool, {});
    assert.equal(result.source, 'kubernetes-api'); assert.equal(result.status, 'collected');
    assert.equal(kube.podReads, 2);
    assert.ok(kube.reads.every(path => path.includes('/namespaces/mas-demo/')));
    if (tool !== 'pod_logs') assert.ok(!kube.reads.some(path => path.includes('/log?')));
    if (tool !== 'pod_metrics') assert.ok(!kube.reads.some(path => path.includes('/metrics.k8s.io/')));
    if (tool !== 'workload_spec') assert.ok(!kube.reads.some(path => path.includes('/deployments/')));
    assert.doesNotMatch(JSON.stringify(result), /hidden-env|hidden-log|hidden-event/);
  }
});

test('model cannot change namespace, subject, paths, methods, or select a foreign container', async () => {
  const kube = new Kube(), tools = new InvestigationTools(context(), kube);
  for (const args of [{ namespace: 'secret-namespace' }, { path: '/api/v1/secrets' }, { method: 'DELETE' }, { name: 'another-pod' }])
    await assert.rejects(tools.call('pod_logs', args));
  assert.equal(kube.reads.length, 0);
  const result = await tools.call('pod_logs', { container: 'foreign-container' });
  assert.equal(result.status, 'unavailable'); assert.ok(!kube.reads.some(path => path.includes('/log?')));
  await assert.rejects(tools.call('exec', {}));
  await assert.rejects(tools.call('pod_logs', { tail_lines: 41 }));
});

test('identity replacement invalidates results and owner mismatch stops traversal', async () => {
  const kube = new Kube(); kube.replace = true;
  const result = await new InvestigationTools(context(), kube).call('pod_logs', {});
  assert.equal(result.status, 'unavailable'); assert.ok(result.evidence_items.every(item => item.data === null));
  const owners = new Kube(); owners.wrongOwner = true;
  const workload = await new InvestigationTools(context(), owners).call('workload_spec', {});
  assert.equal(workload.status, 'unavailable');
  assert.ok(!owners.reads.some(path => path.includes('/deployments/')));
});

test('missing and stale metrics stay unavailable and errors disclose no API response', async () => {
  for (const stale of [false, true]) {
    const kube = new Kube(); kube.unavailableMetrics = !stale; kube.staleMetrics = stale;
    const result = await new InvestigationTools(context(), kube, { now: () => now }).call('pod_metrics', {});
    assert.equal(result.status, 'unavailable');
    assert.ok(result.evidence_items.every(item => item.data === null));
    assert.doesNotMatch(JSON.stringify(result), /hidden-service-response/);
  }
});

test('recorded evidence is labelled, missing tools are explicit, and logs are bounded and scrubbed', async () => {
  const ctx = context('recorded-evidence'), kube = new Kube();
  ctx.evidence.items.push({ id: 'logs-checkout-current', kind: 'logs', source: '/retained/log',
    status: 'collected', truncated: false, observedAt: new Date(now).toISOString(),
    data: { container: 'checkout', previous: false, text: 'first line\nlast token=hidden-log' } });
  const tools = new InvestigationTools(ctx, kube);
  const logs = await tools.call('pod_logs', { tail_lines: 1 });
  assert.equal(logs.source, 'recorded-evidence'); assert.equal(logs.evidence_items[0]?.truncated, true);
  assert.doesNotMatch(JSON.stringify(logs), /first line|hidden-log/);
  const metrics = await tools.call('pod_metrics', {});
  assert.equal(metrics.status, 'unavailable'); assert.equal(kube.reads.length, 0);
});

test('different log projections have distinct stable identities in live and recorded evidence', async () => {
  for (const source of ['kubernetes-api', 'recorded-evidence'] as const) {
    const ctx = context(source);
    ctx.evidence.items.push({ id: 'logs-checkout-current', kind: 'logs', source: '/retained/log',
      status: 'collected', truncated: false, observedAt: new Date(now).toISOString(),
      data: { container: 'checkout', previous: false, text: 'first line\nlast line' } });
    const tools = new InvestigationTools(ctx, new Kube(), { now: () => now });
    const full = await tools.call('pod_logs', {});
    const explicitFull = await tools.call('pod_logs', { tail_lines: 40 });
    const short = await tools.call('pod_logs', { tail_lines: 1 });
    const repeat = await tools.call('pod_logs', { tail_lines: 1 });
    assert.equal(full.evidence_items[0]?.id, 'logs-checkout-current');
    assert.deepEqual(explicitFull.evidence_items, full.evidence_items);
    assert.equal(short.evidence_items[0]?.id, 'logs-checkout-current-tail-1');
    assert.deepEqual(repeat.evidence_items, short.evidence_items);
    assert.notEqual(short.evidence_items[0]?.id, full.evidence_items[0]?.id);
    const contextHash = 'a'.repeat(64);
    const frozen = freezeInvestigation('projection-test', { run_id: 'projection-test', observed_at_ms: now,
      steps: [full, short, repeat].map((output, index) => ({ id: `read-${index}`, actor: 'pod_logs',
        kind: 'effect', state: 'completed', key: 'command',
        output: { status: 'completed', output: { ...output, context_sha256: contextHash } } })) }, ctx.evidence, source, contextHash);
    assert.equal(frozen.calls.length, 3);
    assert.deepEqual(frozen.evidence?.items.map(item => item.id), ['logs-checkout-current', 'logs-checkout-current-tail-1']);
  }
});

test('result byte cap preserves availability records and decimal values never become rounded integers', async () => {
  const kube = new Kube(); kube.large = true;
  const result = await new InvestigationTools(context(), kube).call('pod_overview', {});
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  assert.equal(result.evidence_items.find(item => item.id === 'pod')?.truncated, true);
  assert.deepEqual(exactJSON({ a: 1, b: 0.125, c: [2.5] }), { a: 1, b: '0.125', c: ['2.5'] });
  assert.throws(() => exactJSON(9007199254740992), /precision loss/);
});

test('timeouts and cancellation bound an unresponsive API without retry', async () => {
  const kube = new Kube(); let calls = 0;
  kube.get = async <T>() => { calls++; return await new Promise<T>(() => {}); };
  const started = Date.now();
  const result = await new InvestigationTools(context(), kube, { budgetMs: 15 }).call('pod_overview', {});
  assert.ok(Date.now() - started < 500); assert.equal(calls, 1); assert.equal(result.status, 'unavailable');
  const stop = new AbortController();
  const pending = new InvestigationTools(context(), kube).call('pod_logs', {}, stop.signal);
  stop.abort();
  await assert.rejects(pending, /cancelled/);
});

test('official MCP client negotiates, lists tools, calls tools and receives invalid-argument errors', async () => {
  const server = createInvestigationServer(new InvestigationTools(context('recorded-evidence')));
  const client = new Client({ name: 'integration-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    assert.equal(client.getServerVersion()?.name, 'mas-k3s-investigation');
    const list = await client.listTools(); assert.equal(list.tools.length, 4);
    const result = await client.callTool({ name: 'pod_overview', arguments: {} });
    assert.equal(result.structuredContent?.source, 'recorded-evidence');
    await assert.rejects(client.callTool({ name: 'pod_logs', arguments: { namespace: 'other' } }), /incident target is fixed/);
    await assert.rejects(client.callTool({ name: 'exec', arguments: {} }), /Unknown tool/);
  } finally { await client.close(); await server.close(); }
});
