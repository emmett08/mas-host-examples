import { createHash } from 'node:crypto';
import { APIError } from '../operator/controller.js';
import type { InClusterKubernetesClient } from '../operator/client.js';
import type { ResolutionReport, Snapshot } from './controller.js';
import type { ReconciliationObservation } from '../shared/resolution.js';
import { managedWorkload, managedWorkloads, type ManagedWorkload } from '../shared/workloads.mjs';

const NAMESPACE = 'mas-demo';
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const UID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RUN_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

type WorkloadAPI = Pick<InClusterKubernetesClient, 'get' | 'list' | 'text' | 'patchJSON'>;

function exact(args: readonly string[], expected: readonly string[]): boolean {
  return args.length === expected.length && args.every((value, index) => value === expected[index]);
}

function validatePatch(value: unknown, policy: ManagedWorkload): unknown[] {
  if (!Array.isArray(value) || value.length !== 5) throw new Error('Only the admitted readiness JSON Patch is supported');
  const index = /^\/spec\/template\/spec\/containers\/(0|[1-9][0-9]?)\/name$/.exec(String(value[2]?.path));
  if (!index || !value[0] || !value[1] || typeof value[0].value !== 'string' || !value[0].value ||
      typeof value[1].value !== 'string' || !value[1].value || value[0].value.length > 128 || value[1].value.length > 128) {
    throw new Error('The readiness patch requires exact UID and resourceVersion tests');
  }
  const path = `/spec/template/spec/containers/${index[1]}`;
  const expected = [
    { op: 'test', path: '/metadata/uid', value: value[0].value },
    { op: 'test', path: '/metadata/resourceVersion', value: value[1].value },
    { op: 'test', path: `${path}/name`, value: policy.container },
    { op: 'test', path: `${path}/readinessProbe/httpGet/path`, value: policy.currentPath },
    { op: 'replace', path: `${path}/readinessProbe/httpGet/path`, value: policy.proposedPath },
  ];
  // Key order is immaterial; additional fields and operations are forbidden.
  if (!value.every((operation, position) => operation && typeof operation === 'object' &&
      Object.keys(operation).length === 3 && ['op', 'path', 'value'].every(key =>
        operation[key] === expected[position]![key as keyof typeof expected[number]]))) {
    throw new Error('Only the admitted readiness JSON Patch is supported');
  }
  return expected;
}

// Compatibility at the boundary lets the controller call the same admission
// and verification implementation as the original recorder. These argv values
// are interpreted locally; no process, shell or kubectl executable is invoked.
export function createKubernetesExecutor(client: WorkloadAPI): (args: string[]) => Promise<string> {
  const core = `/api/v1/namespaces/${NAMESPACE}`;
  const apps = `/apis/apps/v1/namespaces/${NAMESPACE}`;
  return async args => {
    if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('Unsupported remediation Kubernetes operation');
    if (exact(args, ['get', 'namespace', NAMESPACE, '-o', 'json'])) {
      return JSON.stringify(await client.get(`/api/v1/namespaces/${NAMESPACE}`));
    }
    for (const policy of managedWorkloads) {
      const selector = `app.kubernetes.io/name=${policy.name}`;
      if (exact(args, ['get', 'deployment', policy.name, '-o', 'json'])) {
        return JSON.stringify(await client.get(`${apps}/deployments/${policy.name}`));
      }
      if (exact(args, ['get', 'replicasets', '-l', selector, '-o', 'json'])) {
        return JSON.stringify({ items: await client.list(`${apps}/replicasets?labelSelector=${encodeURIComponent(selector)}`) });
      }
      if (exact(args, ['get', 'pods', '-l', selector, '-o', 'json'])) {
        return JSON.stringify({ items: await client.list(`${core}/pods?labelSelector=${encodeURIComponent(selector)}`) });
      }
    }
    if (args.length === 5 && args[0] === 'get' && args[1] === 'pod' && DNS_LABEL.test(args[2]!) && args[3] === '-o' && args[4] === 'json') {
      return JSON.stringify(await client.get(`${core}/pods/${args[2]}`));
    }
    if (args.length === 6 && args[0] === 'get' && args[1] === 'events' && args[2] === '--field-selector' &&
        args[3]!.startsWith('involvedObject.uid=') && UID.test(args[3]!.slice('involvedObject.uid='.length)) && args[4] === '-o' && args[5] === 'json') {
      // A single bounded page retains continuation metadata so verification
      // cannot treat an incomplete Event set as absence of readiness failures.
      return JSON.stringify(await client.get(`${core}/events?fieldSelector=${encodeURIComponent(args[3]!)}&limit=13`));
    }
    if (args.length === 7 && args[0] === 'logs' && DNS_LABEL.test(args[1]!) && args[2] === '-c' && args[3] === 'checkout' &&
        args[4] === '--timestamps=true' && args[5]!.startsWith('--since-time=') && args[6] === '--previous=false') {
      const since = args[5]!.slice('--since-time='.length);
      if (TIMESTAMP.test(since) && Number.isFinite(Date.parse(since))) {
        return client.text(`${core}/pods/${args[1]}/log?container=checkout&timestamps=true&sinceTime=${encodeURIComponent(since)}&previous=false`, 4096);
      }
    }
    if (args.length === 3 && args[0] === 'get' && args[1] === '--raw') {
      const metricsPrefix = `/apis/metrics.k8s.io/v1beta1/namespaces/${NAMESPACE}/pods/`;
      if (args[2]!.startsWith(metricsPrefix) && DNS_LABEL.test(args[2]!.slice(metricsPrefix.length))) {
        return JSON.stringify(await client.get(args[2]!));
      }
      if (managedWorkloads.some(policy => args[2] === `${core}/services/${policy.name}:8081/proxy/`)) return client.text(args[2]!, 4096);
    }
    const policy = managedWorkload(NAMESPACE, args[2]);
    if (args.length === 8 && args[0] === 'patch' && args[1] === 'deployment' && policy &&
        args[3] === '--type=json' && args[4] === '-p' && args[6] === '-o' && args[7] === 'json' &&
        Buffer.byteLength(args[5]!) <= 4096) {
      let patch: unknown;
      try { patch = JSON.parse(args[5]!); } catch { throw new Error('Invalid readiness JSON Patch'); }
      return JSON.stringify(await client.patchJSON(`${apps}/deployments/${policy.name}`, validatePatch(patch, policy)));
    }
    throw new Error('Unsupported remediation Kubernetes operation');
  };
}

async function boundedJSON(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error('Demo API response exceeds byte limit');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error('Demo API response exceeds byte limit');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new Error('Demo API returned invalid JSON'); }
}

export interface RemediationTransportOptions {
  client: WorkloadAPI;
  namespace: string;
  verifierToken: string;
  backendPort?: number;
  fetch?: typeof globalThis.fetch;
}

export function createRemediationTransport(options: RemediationTransportOptions) {
  if (options.namespace !== NAMESPACE) throw new Error('The readiness remediation policy is scoped to namespace mas-demo');
  if (!/^[\x21-\x7e]{32,512}$/.test(options.verifierToken)) throw new Error('A bounded verifier credential is required');
  const port = options.backendPort ?? 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid demo backend port');
  // A caller can select the Service port, never another host or URL. Redirects
  // are disabled so a backend response cannot forward the verifier credential.
  const baseURL = `http://mas-demo.${NAMESPACE}.svc:${port}`;
  const request = options.fetch ?? globalThis.fetch;
  const runPath = (id: string) => {
    if (!RUN_ID.test(id)) throw new Error('Invalid demo run identity');
    return `/api/runs/${id}`;
  };
  const publish = async (id: string, kind: 'resolution' | 'reconciliations', report: ResolutionReport | ReconciliationObservation): Promise<void> => {
    const path = `${runPath(id)}/${kind}`;
    const body = JSON.stringify(report);
    if (Buffer.byteLength(body) > MAX_REPORT_BYTES) throw new Error('Resolution report exceeds byte limit');
    const response = await request(`${baseURL}${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${options.verifierToken}` }, body,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new APIError(response.status, `Demo resolution API returned ${response.status}`);
    }
    const receipt = await boundedJSON(response, 1024) as Record<string, unknown>;
    if (!receipt || receipt.accepted !== true || receipt.runId !== id || receipt.kind !== kind ||
        receipt.recordId !== createHash('sha256').update(body).digest('hex')) throw new Error('Demo publication acknowledgement did not match the exact record');
  };
  return {
    // Only an authenticated API response known to reject before mutation can
    // establish rejection. Timeouts, 5xx and arbitrary CLI exits remain unknown.
    isDefiniteRejection: (error: unknown) => error instanceof APIError && [400, 401, 403, 404, 405, 409, 415, 422, 429].includes(error.statusCode),
    kubectl: createKubernetesExecutor(options.client),
    async snapshot(id: string): Promise<Snapshot | undefined> {
      const response = await request(`${baseURL}${runPath(id)}/remediation`, {
        redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' },
      });
      if (response.status === 404) { await response.body?.cancel(); return undefined; }
      if (!response.ok) {
        await response.body?.cancel();
        throw new APIError(response.status, `Demo snapshot API returned ${response.status}`);
      }
      return await boundedJSON(response, MAX_SNAPSHOT_BYTES) as Snapshot;
    },
    report: (id: string, report: ResolutionReport) => publish(id, 'resolution', report),
    reconcile: (id: string, observation: ReconciliationObservation) => publish(id, 'reconciliations', observation),
  };
}
