import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHTTPServer } from 'node:http';
import { createServer as createHTTPSServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InClusterKubernetesClient } from '../operator/client.js';
import { createKubernetesExecutor, createRemediationTransport } from './transport.js';
import type { ResolutionReport } from './controller.js';

const patch = [
  { op: 'test', path: '/metadata/uid', value: 'deployment-uid' },
  { op: 'test', path: '/metadata/resourceVersion', value: '27' },
  { op: 'test', path: '/spec/template/spec/containers/0/name', value: 'checkout' },
  { op: 'test', path: '/spec/template/spec/containers/0/readinessProbe/httpGet/path', value: '/readyz' },
  { op: 'replace', path: '/spec/template/spec/containers/0/readinessProbe/httpGet/path', value: '/healthz' },
];
const patchArgs = (value: unknown = patch) => ['patch', 'deployment', 'mas-demo-checkout', '--type=json', '-p', JSON.stringify(value), '-o', 'json'];

test('direct HTTPS executor performs only fixed Kubernetes operations, rotates its token and preserves CAS content types', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'mas-remediator-transport-'));
  const token = join(folder, 'token');
  const certificate = new URL('../operator/fixtures/localhost-test-cert.pem', import.meta.url);
  const key = new URL('../operator/fixtures/localhost-test-key.pem', import.meta.url);
  const seen: { method: string; url: string; auth?: string; contentType?: string; body: string }[] = [];
  const server = createHTTPSServer({ key: await readFile(key), cert: await readFile(certificate) }, async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    seen.push({ method: request.method!, url: request.url!, auth: request.headers.authorization,
      contentType: request.headers['content-type'], body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(request.url!.includes('/proxy/') ? 'MAS checkout service ready\n' :
      request.url!.includes('labelSelector=') ? JSON.stringify({ items: [{ metadata: { name: 'managed-resource' } }] }) :
        JSON.stringify({ metadata: { uid: 'resource-uid', resourceVersion: '28' } }));
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(folder, { recursive: true, force: true });
  });
  await writeFile(token, 'first-token', { mode: 0o600 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new InClusterKubernetesClient(`https://127.0.0.1:${address.port}`, token, certificate.pathname);
  const execute = createKubernetesExecutor(client);
  await execute(['get', 'namespace', 'mas-demo', '-o', 'json']);
  await writeFile(token, 'rotated-token');
  await execute(['get', 'deployment', 'mas-demo-checkout', '-o', 'json']);
  for (const resource of ['pods', 'replicasets']) {
    assert.deepEqual(JSON.parse(await execute(['get', resource, '-l', 'app.kubernetes.io/name=mas-demo-checkout', '-o', 'json'])),
      { items: [{ metadata: { name: 'managed-resource' } }] });
  }
  await execute(['get', 'pod', 'mas-demo-checkout-abcde-pod', '-o', 'json']);
  await execute(['get', '--raw', '/apis/metrics.k8s.io/v1beta1/namespaces/mas-demo/pods/mas-demo-checkout-abcde-pod']);
  assert.equal(await execute(['get', '--raw', '/api/v1/namespaces/mas-demo/services/mas-demo-checkout:8081/proxy/']), 'MAS checkout service ready\n');
  await execute(patchArgs());
  const path = '/apis/demo.mas.dev/v1alpha1/namespaces/mas-demo/masremediations/action-one/status';
  const resource = { apiVersion: 'demo.mas.dev/v1alpha1', kind: 'MASRemediation', metadata: { name: 'action-one', resourceVersion: '19' },
    status: { phase: 'Executing' } };
  await client.replaceStatusCAS(path, resource);
  assert.equal(seen[0]!.auth, 'Bearer first-token');
  assert.ok(seen.slice(1).every(item => item.auth === 'Bearer rotated-token'));
  assert.ok(seen.filter(item => item.url.includes('labelSelector=')).every(item =>
    new URL(item.url, 'https://kubernetes.test').searchParams.get('labelSelector') === 'app.kubernetes.io/name=mas-demo-checkout'));
  const mutation = seen.find(item => item.method === 'PATCH')!;
  assert.equal(mutation.url, '/apis/apps/v1/namespaces/mas-demo/deployments/mas-demo-checkout');
  assert.equal(mutation.contentType, 'application/json-patch+json');
  assert.deepEqual(JSON.parse(mutation.body), patch);
  const status = seen.find(item => item.method === 'PUT')!;
  assert.equal(status.url, path);
  assert.equal(status.contentType, 'application/json');
  assert.deepEqual(JSON.parse(status.body), resource);
  assert.throws(() => client.replace(path, { metadata: { name: 'action-one' } }), /resourceVersion/);
  assert.throws(() => client.replaceStatusCAS('/not-status', resource), /status subresource/);
  assert.throws(() => client.get('https://another-api.test/secrets'), /configured API server/);
});

test('the compatibility adapter rejects arbitrary commands, cross-namespace paths and broader patches before API access', async () => {
  let calls = 0;
  const unexpected = async () => { calls++; throw new Error('Unexpected Kubernetes API access'); };
  const execute = createKubernetesExecutor({ get: unexpected, list: unexpected, text: unexpected, patchJSON: unexpected });
  const invalid = [
    ['get', 'secrets', '-o', 'json'], ['get', 'namespace', 'production', '-o', 'json'],
    ['get', 'deployment', 'other-workload', '-o', 'json'], ['get', 'pods', '-l', 'app=anything', '-o', 'json'],
    ['get', 'pod', '../secrets', '-o', 'json'], ['get', 'pod', 'a?fieldSelector=metadata.name%3Dsecret', '-o', 'json'],
    ['get', '--raw', 'https://external.test/api'], ['get', '--raw', '/apis/metrics.k8s.io/v1beta1/namespaces/production/pods/pod'],
    ['get', '--raw', '/apis/metrics.k8s.io/v1beta1/namespaces/mas-demo/pods/pod?extra=1'],
    ['get', '--raw', '/api/v1/namespaces/mas-demo/services/other:8081/proxy/'],
    ['exec', 'pod', '--', 'sh'], ['delete', 'deployment', 'mas-demo-checkout'],
    patchArgs([{ op: 'replace', path: '/spec/template/spec/containers/0/image', value: 'malicious' }]),
    patchArgs([...patch, { op: 'replace', path: '/spec/replicas', value: 2 }]),
    patchArgs(patch.map((operation, index) => index === 4 ? { ...operation, value: '/arbitrary' } : operation)),
    patchArgs(patch.map((operation, index) => index === 0 ? { ...operation, unexpected: true } : operation)),
  ];
  for (const args of invalid) await assert.rejects(execute(args), /Unsupported|admitted|requires exact/);
  assert.equal(calls, 0);
});

test('backend transport uses the fixed namespace Service, bounded snapshots and authenticated report requests', async t => {
  const seen: { target: string; method: string; path: string; auth?: string; body: string }[] = [];
  const snapshot = { run: { id: 'event_one', status: 'completed', input: { incident: {} } }, observationAvailable: false };
  const report = { version: 'mas-k8s-resolution/1', status: 'not-attempted', action: 'replace_readiness_probe_path',
    target: { namespace: 'mas-demo', name: 'mas-demo-checkout', uid: 'deployment-uid' }, recordedAt: new Date().toISOString(),
    reason: 'Engineer review required', patch: [], before: null, after: null, checks: [] } satisfies ResolutionReport;
  const server = createHTTPServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    seen.push({ target: '', method: request.method!, path: request.url!, auth: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    if (request.url!.includes('absent')) { response.writeHead(404); response.end('{}'); return; }
    if (request.url!.includes('oversized')) { response.end(JSON.stringify({ padding: 'x'.repeat(1024 * 1024) })); return; }
    if (request.url!.includes('denied')) { response.writeHead(403); response.end('{"private":"do-not-leak"}'); return; }
    if (request.url!.includes('redirect')) { response.writeHead(302, { location: 'https://external.test/' }); response.end('{}'); return; }
    response.writeHead(request.method === 'POST' ? 202 : 200);
    response.end(request.method === 'POST' ? '{}' : JSON.stringify(snapshot));
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const targets: string[] = [];
  const localFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    targets.push(url.origin);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
  };
  const noKubernetes = async () => { throw new Error('No workload API calls expected'); };
  const options = { client: { get: noKubernetes, list: noKubernetes, text: noKubernetes, patchJSON: noKubernetes },
    namespace: 'mas-demo', verifierToken: 'a'.repeat(64), fetch: localFetch };
  const transport = createRemediationTransport(options);
  assert.deepEqual(await transport.snapshot('event_one'), snapshot);
  await transport.report('event_one', report);
  assert.equal(await transport.snapshot('absent'), undefined);
  await assert.rejects(transport.snapshot('oversized'), /byte limit/);
  await assert.rejects(transport.snapshot('denied'), error => {
    assert.equal((error as { statusCode: number }).statusCode, 403);
    assert.doesNotMatch(String(error), /do-not-leak/); return true;
  });
  await assert.rejects(transport.snapshot('redirect'));
  assert.ok(targets.every(target => target === 'http://mas-demo.mas-demo.svc:8080'));
  assert.equal(seen[0]!.auth, undefined);
  assert.equal(seen[1]!.method, 'POST');
  assert.equal(seen[1]!.path, '/api/runs/event_one/resolution');
  assert.equal(seen[1]!.auth, `Bearer ${'a'.repeat(64)}`);
  assert.deepEqual(JSON.parse(seen[1]!.body), report);
  const before = seen.length;
  await assert.rejects(transport.snapshot('../another/run'), /run identity/);
  await assert.rejects(transport.report('event_one', { ...report, reason: 'x'.repeat(65536) }), /byte limit/);
  assert.equal(seen.length, before);
  assert.throws(() => createRemediationTransport({ ...options, namespace: 'production' }), /scoped/);
  assert.throws(() => createRemediationTransport({ ...options, verifierToken: 'short' }), /credential/);
  assert.throws(() => createRemediationTransport({ ...options, backendPort: 0 }), /port/);
});
