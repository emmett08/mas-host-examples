import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effect, sha256, RejectedEffect, type EffectStore, type Json, type OperationIdentity, type Reconciliation } from './effects.js';
import { redact } from '../ui/events.js';

export interface KubernetesTransport {
  get(kind: string, name: string, namespace?: string): Promise<any | undefined>;
  create(resource: Json): Promise<any>;
  patch(kind: string, name: string, namespace: string, patch: Json[]): Promise<any>;
  command(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }>;
  forward(namespace: string, pod: string, remotePort: number): Promise<{ url: string; close(): void }>;
}
export interface KubernetesCommandDiagnostic {
  tool: 'kubectl'; operation: string; exitCode: number | null; signal: string | null;
  timedOut: boolean; outputExceeded: boolean; message: string;
  externalOutcome: 'not-inferred';
}
/** Credential-bearing tools run only here, outside every candidate container. */
export class KubectlTransport implements KubernetesTransport {
  private env: NodeJS.ProcessEnv;
  constructor(kubeconfig: string, private executable = 'kubectl', private onDiagnostic?: (value: KubernetesCommandDiagnostic) => void) {
    if (!kubeconfig) throw new Error('Trusted kubeconfig path required');
    this.env = { PATH: process.env.PATH, KUBECONFIG: kubeconfig, HOME: '/tmp/mas-trusted-kubectl' };
  }
  command(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ['--request-timeout=20s', ...args], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = []; const err: Buffer[] = []; let bytes = 0; let oversized = false; let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
      for (const [stream, target] of [[child.stdout, out], [child.stderr, err]] as const) stream.on('data', (part: Buffer) => {
        bytes += part.length;
        if (bytes > 512 * 1024) { oversized = true; child.kill('SIGKILL'); } else target.push(part);
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (code || signal || oversized || code === null) {
          // Never retain stdout (it can contain a complete Kubernetes object), argv,
          // kubeconfig contents, or the patch. Keep bounded diagnostics as evidence only.
          let message = String(redact(Buffer.concat(err).toString(), false));
          for (const [name, value] of Object.entries(process.env)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY/i.test(name) && value && value.length >= 4) message = message.replaceAll(value, '[redacted]');
          message = message.replace(/((?:token|password|secret|authorization|client-key-data|client-certificate-data)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]').slice(0, 4096);
          try { this.onDiagnostic?.({ tool: 'kubectl', operation: args[0] ?? 'unknown', exitCode: code, signal,
            timedOut, outputExceeded: oversized, message, externalOutcome: 'not-inferred' }); }
          catch { reject(new Error('Kubernetes failure diagnostic could not be retained; outcome unknown')); return; }
        }
        if (signal || oversized || code === null) reject(new Error('Kubernetes transport outcome unknown'));
        else resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
      });
      child.stdin.end(input);
    });
  }
  async get(kind: string, name: string, namespace?: string): Promise<any | undefined> {
    const result = await this.command(['get', kind, name, ...(namespace ? ['-n', namespace] : []), '--ignore-not-found', '-o', 'json']);
    if (result.code) throw new Error('Kubernetes read failed');
    return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
  }
  async create(resource: Json): Promise<any> {
    const result = await this.command(['create', '-f', '-', '-o', 'json'], JSON.stringify(resource));
    if (result.code) throw new Error('Kubernetes create acknowledgement unavailable');
    return JSON.parse(result.stdout);
  }
  async patch(kind: string, name: string, namespace: string, patch: Json[]): Promise<any> {
    // Node's child stdin pipe is a socket on Linux; kubectl opens --patch-file
    // with os.ReadFile, so /dev/stdin fails with ENXIO. A private regular file
    // also keeps configuration out of process arguments and is always removed.
    const bytes = JSON.stringify(patch);
    if (Buffer.byteLength(bytes) > 128 * 1024) throw new Error('Kubernetes patch exceeds the admitted payload bound');
    const directory = await mkdtemp(join(tmpdir(), 'mas-kubectl-patch-'));
    try {
      await chmod(directory, 0o700);
      const file = join(directory, 'patch.json'); await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      const result = await this.command(['patch', kind, name, '-n', namespace, '--type=json', `--patch-file=${file}`, '-o', 'json']);
      if (result.code) throw new Error('Kubernetes patch acknowledgement unavailable');
      return JSON.parse(result.stdout);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async forward(namespace: string, pod: string, remotePort: number): Promise<{ url: string; close(): void }> {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { const a = server.address(); resolve(typeof a === 'object' && a ? a.port : 0); });
    });
    await new Promise<void>(resolve => server.close(() => resolve()));
    const child = spawn(this.executable, ['port-forward', '-n', namespace, `pod/${pod}`, `${port}:${remotePort}`, '--address=127.0.0.1'], { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Port-forward unavailable')); }, 10_000);
      const ready = (chunk: Buffer) => { if (chunk.toString().includes('Forwarding from')) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', ready); child.stderr.on('data', ready);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Port-forward exited')); });
    });
    return { url: `http://127.0.0.1:${port}`, close: () => { child.kill('SIGTERM'); } };
  }
}
export interface TrialSpec {
  namespace: string; deployment: string; owner: string; runId: string;
  imageDigest: string; candidateTreeSha256: string; requirementsSha256: string; testsSha256: string; environmentSha256: string;
  configuration: Record<string, string>;
  port: number;
  stage: 'baseline' | 'candidate' | 'promotion';
}
export interface TargetSnapshot { namespace: string; name: string; uid: string; resourceVersion: string; owner: string; imageDigest: string; candidateTreeSha256: string }
export interface HttpCriterion { id: string; method: 'GET' | 'POST'; path: string; body?: Json; expectedStatus: number; expectedJson?: Json }
export interface TrialObservation {
  status: 'pass' | 'fail' | 'inconclusive'; binding: TrialSpec; observedAt: string;
  target: TargetSnapshot; podUid?: string; imageId?: string;
  criteria: Array<{ id: string; status: 'pass' | 'fail' | 'inconclusive'; statusCode?: number; bodySha256?: string }>;
  diagnostics: { pods: string; events: string; logs: string; resources: string };
}
function validate(spec: TrialSpec): void {
  if (!/^mas-repair-[a-z0-9-]{1,40}$/.test(spec.namespace) || !/^[a-z][a-z0-9-]{0,50}$/.test(spec.deployment)
    || !/^[a-z0-9-]{1,50}$/.test(spec.runId) || !spec.owner || !/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(spec.imageDigest)
    || ![spec.candidateTreeSha256, spec.requirementsSha256, spec.testsSha256, spec.environmentSha256].every(x => /^[a-f0-9]{64}$/.test(x))
    || !Number.isInteger(spec.port) || spec.port < 1024 || spec.port > 65535) throw new Error('Invalid immutable disposable trial identity');
  const forbidden = /TOKEN|SECRET|PASSWORD|CREDENTIAL|KUBECONFIG|DOCKER|AWS_|OPENAI|GITHUB|LD_|NODE_OPTIONS|PATH|HOME/i;
  if (Object.keys(spec.configuration).length > 20 || Object.entries(spec.configuration).some(([key, value]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || forbidden.test(key) || value.length > 2000))
    throw new Error('Candidate configuration contains forbidden credentials or process authority');
}
function annotations(spec: TrialSpec, identity: OperationIdentity): Record<string, string> {
  return { 'mas.dev/owner': spec.owner, 'mas.dev/run': spec.runId, 'mas.dev/operation': identity.operationId,
    'mas.dev/invocation': identity.invocationId, 'mas.dev/candidate': spec.candidateTreeSha256,
    'mas.dev/requirements': spec.requirementsSha256, 'mas.dev/tests': spec.testsSha256, 'mas.dev/environment': spec.environmentSha256 };
}
function snapshot(dep: any): TargetSnapshot {
  return { namespace: dep.metadata.namespace, name: dep.metadata.name, uid: dep.metadata.uid,
    resourceVersion: dep.metadata.resourceVersion, owner: dep.metadata.annotations?.['mas.dev/owner'],
    imageDigest: dep.spec.template.spec.containers[0].image, candidateTreeSha256: dep.metadata.annotations?.['mas.dev/candidate'] };
}
function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, i) => contains(actual[i], value));
  if (expected && typeof expected === 'object') return !!actual && typeof actual === 'object'
    && Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && contains((actual as Record<string, unknown>)[key], value));
  return actual === expected;
}
function desiredResource(observed: any, resource: any): boolean {
  if (observed?.metadata?.annotations?.['mas.dev/owner'] !== resource.metadata.annotations['mas.dev/owner']) return false;
  if (resource.kind === 'Namespace') return observed.metadata.labels?.['mas.dev/disposable'] === 'true' && observed.metadata.labels?.['pod-security.kubernetes.io/enforce'] === 'restricted';
  if (resource.kind === 'NetworkPolicy') return sha256(observed.spec?.podSelector) === sha256(resource.spec.podSelector)
    && sha256([...(observed.spec?.policyTypes ?? [])].sort()) === sha256([...resource.spec.policyTypes].sort())
    && !(observed.spec?.ingress ?? []).length && !(observed.spec?.egress ?? []).length;
  if (resource.kind === 'Deployment') {
    const pod = observed.spec?.template?.spec;
    return contains(observed.spec, resource.spec) && pod?.containers?.length === 1 && !pod?.initContainers?.length && !pod?.volumes?.length
      && !pod?.hostNetwork && !pod?.hostPID && !pod?.hostIPC && pod?.automountServiceAccountToken === false;
  }
  return false;
}
function isolatedPod(pod: any, spec: TrialSpec): boolean {
  const container = pod?.containers?.[0];
  if (!container || pod.containers.length !== 1 || pod.initContainers?.length || pod.volumes?.length || pod.hostNetwork || pod.hostPID || pod.hostIPC
    || pod.automountServiceAccountToken !== false || pod.enableServiceLinks !== false || container.envFrom?.length || container.volumeMounts?.length
    || container.command?.length || container.args?.length || container.securityContext?.privileged || container.securityContext?.allowPrivilegeEscalation !== false
    || container.securityContext?.readOnlyRootFilesystem !== true || sha256(container.securityContext?.capabilities?.drop) !== sha256(['ALL'])
    || pod.securityContext?.runAsNonRoot !== true || pod.securityContext?.runAsUser !== 10001 || pod.securityContext?.runAsGroup !== 10001
    || pod.securityContext?.seccompProfile?.type !== 'RuntimeDefault') return false;
  const environment: Record<string, string> = {};
  for (const item of container.env ?? []) { if (typeof item.value !== 'string' || item.valueFrom || Object.hasOwn(environment, item.name)) return false; environment[item.name] = item.value; }
  return sha256(environment) === sha256(spec.configuration) && container.name === 'application' && container.image === spec.imageDigest
    && container.ports?.length === 1 && container.ports[0].containerPort === spec.port
    && container.resources?.limits?.cpu === '500m' && container.resources?.limits?.memory === '128Mi';
}
async function boundedBody(response: Response): Promise<{ text: string; exceeded: boolean }> {
  const reader = response.body?.getReader(); let size = 0; const parts: Uint8Array[] = [];
  if (reader) for (;;) {
    const item = await reader.read(); if (item.done) break;
    size += item.value.byteLength;
    if (size > 64 * 1024) { await reader.cancel(); return { text: '', exceeded: true }; }
    parts.push(item.value);
  }
  return { text: Buffer.concat(parts).toString(), exceeded: false };
}
export class KubernetesTrial {
  constructor(private kube: KubernetesTransport, private journal: EffectStore) {}
  async current(spec: TrialSpec): Promise<TargetSnapshot> {
    validate(spec);
    // A rollout updates status/resourceVersion. Wait for that controller's normal convergence,
    // then bind the version used by the later atomic patch. A failed wait is read evidence only.
    await this.kube.command(['rollout', 'status', `deployment/${spec.deployment}`, '-n', spec.namespace, '--timeout=20s']);
    const value = await this.kube.get('deployment', spec.deployment, spec.namespace);
    if (!value) throw new RejectedEffect('Trial target is absent');
    const target = snapshot(value);
    const pod = value.spec?.template?.spec;
    if (target.owner !== spec.owner || target.imageDigest !== spec.imageDigest || target.candidateTreeSha256 !== spec.candidateTreeSha256
      || value.metadata.annotations?.['mas.dev/requirements'] !== spec.requirementsSha256 || value.metadata.annotations?.['mas.dev/tests'] !== spec.testsSha256
      || value.metadata.annotations?.['mas.dev/environment'] !== spec.environmentSha256 || !isolatedPod(pod, spec)) throw new RejectedEffect('Trial target identity or isolation changed');
    return target;
  }
  async establish(identity: OperationIdentity, spec: TrialSpec): Promise<TargetSnapshot> {
    validate(spec);
    const ns = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: spec.namespace, labels: { 'pod-security.kubernetes.io/enforce': 'restricted', 'mas.dev/disposable': 'true' }, annotations: { 'mas.dev/owner': spec.owner, 'mas.dev/run': spec.runId } } };
    const create = async (kind: string, name: string, resource: Json, namespace?: string) => {
      const op = { ...identity, operationId: `${identity.operationId}/${kind}` };
      return effect(this.journal, op, `kubernetes.create-${kind}`, `${spec.namespace}:${name}`, resource, async () => {
        const existing = await this.kube.get(kind, name, namespace);
        if (existing) {
          if (!desiredResource(existing, resource)) throw new RejectedEffect('Disposable target owner or protected resource specification changed');
          return existing as Json;
        }
        return await this.kube.create(resource) as Json;
      }, async () => {
        const observed = await this.kube.get(kind, name, namespace);
        return observed && desiredResource(observed, resource) ? { status: 'completed', receipt: observed as Json } : { status: 'unknown' };
      });
    };
    await create('namespace', spec.namespace, ns);
    await create('networkpolicy', 'deny-egress', { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: { name: 'deny-egress', namespace: spec.namespace, annotations: { 'mas.dev/owner': spec.owner } },
      spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] } }, spec.namespace);
    const podAnnotations = annotations(spec, identity);
    const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: spec.deployment, namespace: spec.namespace, annotations: podAnnotations }, spec: {
      replicas: 1, selector: { matchLabels: { app: spec.deployment } }, strategy: { type: 'Recreate' },
      template: { metadata: { labels: { app: spec.deployment }, annotations: podAnnotations }, spec: {
        automountServiceAccountToken: false, enableServiceLinks: false,
        securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'application', image: spec.imageDigest, imagePullPolicy: 'IfNotPresent',
          ports: [{ containerPort: spec.port }], env: Object.entries(spec.configuration).map(([name, value]) => ({ name, value })),
          resources: { requests: { cpu: '50m', memory: '32Mi' }, limits: { cpu: '500m', memory: '128Mi' } },
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } } }],
      } },
    } };
    const value = await create('deployment', spec.deployment, deployment, spec.namespace);
    const snap = snapshot(value);
    if (snap.imageDigest !== spec.imageDigest || snap.candidateTreeSha256 !== spec.candidateTreeSha256) throw new RejectedEffect('Existing trial identity mismatch');
    return snap;
  }
  /** Kubernetes JSON Patch tests give an atomic current-target/owner/image precondition. */
  async replace(identity: OperationIdentity, spec: TrialSpec, expected: TargetSnapshot): Promise<TargetSnapshot> {
    validate(spec);
    if (expected.namespace !== spec.namespace || expected.name !== spec.deployment || expected.owner !== spec.owner) throw new RejectedEffect('Target projection or owner mismatch');
    const patch: Json[] = [
      { op: 'test', path: '/metadata/uid', value: expected.uid },
      { op: 'test', path: '/metadata/resourceVersion', value: expected.resourceVersion },
      { op: 'test', path: '/metadata/annotations/mas.dev~1owner', value: spec.owner },
      { op: 'test', path: '/spec/template/spec/containers/0/image', value: expected.imageDigest },
      { op: 'replace', path: '/metadata/annotations', value: annotations(spec, identity) },
      { op: 'replace', path: '/spec/template/metadata/annotations', value: annotations(spec, identity) },
      { op: 'replace', path: '/spec/template/spec/containers/0/image', value: spec.imageDigest },
      // Kubernetes omits an empty env list in its stored/returned representation.
      // JSON Patch add sets an object member whether it is absent or already present.
      { op: 'add', path: '/spec/template/spec/containers/0/env', value: Object.entries(spec.configuration).map(([name, value]) => ({ name, value })) },
    ];
    const value = await effect(this.journal, identity, 'kubernetes.replace-image', `${spec.namespace}:${spec.deployment}`,
      { expected: expected as unknown as Json, spec: spec as unknown as Json, patch }, async () => {
        const current = await this.kube.get('deployment', spec.deployment, spec.namespace);
        if (!current || current.metadata.uid !== expected.uid || current.metadata.resourceVersion !== expected.resourceVersion) throw new RejectedEffect('Stale Kubernetes target');
        return await this.kube.patch('deployment', spec.deployment, spec.namespace, patch) as Json;
      }, async (): Promise<Reconciliation> => {
        const observed = await this.kube.get('deployment', spec.deployment, spec.namespace);
        if (observed?.metadata?.uid === expected.uid && observed.metadata.annotations?.['mas.dev/operation'] === identity.operationId
          && observed.metadata.annotations?.['mas.dev/invocation'] === identity.invocationId && snapshot(observed).imageDigest === spec.imageDigest
          && snapshot(observed).candidateTreeSha256 === spec.candidateTreeSha256) return { status: 'completed', receipt: observed as Json };
        return { status: 'unknown' };
      });
    return snapshot(value);
  }
  async observe(spec: TrialSpec, criteria: HttpCriterion[], timeoutMs = 60_000): Promise<TrialObservation> {
    validate(spec);
    if (!criteria.length || criteria.length > 100 || criteria.some(c => !c.path.startsWith('/') || c.path.startsWith('//') || !/^[A-Za-z0-9_-]+$/.test(c.id))) throw new Error('Protected HTTP criteria required');
    const deadline = Date.now() + Math.min(timeoutMs, 120_000);
    let dep: any; let pods: any;
    do {
      dep = await this.kube.get('deployment', spec.deployment, spec.namespace);
      const result = await this.kube.command(['get', 'pods', '-n', spec.namespace, '-l', `app=${spec.deployment}`, '-o', 'json']);
      if (result.code) throw new Error('Pod observation unavailable');
      pods = JSON.parse(result.stdout);
      if (pods.items.some((pod: any) => pod.metadata.annotations?.['mas.dev/candidate'] === spec.candidateTreeSha256 && pod.status?.containerStatuses?.[0]?.state?.running)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    if (!dep) throw new Error('Trial deployment disappeared');
    const target = await this.current(spec);
    if (target.owner !== spec.owner || target.imageDigest !== spec.imageDigest || target.candidateTreeSha256 !== spec.candidateTreeSha256) throw new RejectedEffect('Trial observation target changed');
    const pod = pods.items.find((item: any) => item.metadata.annotations?.['mas.dev/candidate'] === spec.candidateTreeSha256 && item.status?.containerStatuses?.[0]?.state?.running);
    const results: TrialObservation['criteria'] = [];
    const imageId: string | undefined = pod?.status?.containerStatuses?.[0]?.imageID;
    const observedDigest = imageId?.match(/sha256:[a-f0-9]{64}/)?.[0];
    const exactImage = observedDigest === spec.imageDigest.split('@')[1];
    if (pod && exactImage) {
      const forward = await this.kube.forward(spec.namespace, pod.metadata.name, spec.port);
      try {
        for (const criterion of criteria) {
          try {
            const response = await fetch(`${forward.url}${criterion.path}`, { method: criterion.method, redirect: 'error',
              headers: { 'content-type': 'application/json' }, ...(criterion.body === undefined ? {} : { body: JSON.stringify(criterion.body) }), signal: AbortSignal.timeout(5000) });
            const bounded = await boundedBody(response);
            if (bounded.exceeded) { results.push({ id: criterion.id, status: 'fail', statusCode: response.status }); continue; }
            const body = bounded.text;
            let matches = true;
            if (criterion.expectedJson !== undefined) { try { matches = contains(JSON.parse(body), criterion.expectedJson); } catch { matches = false; } }
            results.push({ id: criterion.id, status: response.status === criterion.expectedStatus && matches ? 'pass' : 'fail', statusCode: response.status, bodySha256: sha256(body) });
          } catch { results.push({ id: criterion.id, status: 'inconclusive' }); }
        }
      } finally { forward.close(); }
    } else criteria.forEach(c => results.push({ id: c.id, status: 'inconclusive' }));
    const collected = await Promise.all([
      this.kube.command(['get', 'pods', '-n', spec.namespace, '-o', 'json']),
      this.kube.command(['get', 'events', '-n', spec.namespace, '-o', 'json']),
      this.kube.command(['logs', '-n', spec.namespace, `deployment/${spec.deployment}`, '--tail=100', '--limit-bytes=32768']),
      this.kube.command(['top', 'pods', '-n', spec.namespace]),
    ].map(promise => promise.catch(() => ({ code: 1, stdout: '', stderr: '' }))));
    return { status: results.every(c => c.status === 'pass') ? 'pass' : results.some(c => c.status === 'fail') ? 'fail' : 'inconclusive',
      binding: spec, observedAt: new Date().toISOString(), target, ...(pod ? { podUid: pod.metadata.uid, imageId } : {}), criteria: results,
      diagnostics: { pods: collected[0]!.stdout, events: collected[1]!.stdout, logs: collected[2]!.stdout, resources: collected[3]!.stdout } };
  }
}
