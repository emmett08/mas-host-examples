import { createHash } from 'node:crypto';
import { EVIDENCE_VERSION, MAX_EVIDENCE_BYTES, parseEvidence, redactEvidenceText,
  type EvidenceBundle, type EvidenceItem, type EvidenceKind } from '../shared/evidence.js';
import type { EventEvidence, KubernetesAPI } from './controller.js';

type JSONRecord = Record<string, unknown>;
const record = (value: unknown): JSONRecord => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as JSONRecord : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, length = 256) => typeof value === 'string' ? redactEvidenceText(value, length) : undefined;
const pick = (value: unknown, keys: string[]): JSONRecord => {
  const source = record(value), result: JSONRecord = {};
  for (const key of keys) if (source[key] !== undefined) result[key] = source[key];
  return result;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical((value as JSONRecord)[key])]));
  return value;
}

// SHA-256 of JSON.stringify with recursively lexicographically sorted object
// keys; array order is preserved. Hash the full original spec.template.
export function canonicalTemplateHash(template: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(template))).digest('hex');
}

function metadata(value: unknown): JSONRecord {
  const source = record(value);
  const labels = Object.fromEntries(Object.entries(record(source.labels))
    .filter(([key]) => ['app.kubernetes.io/name', 'demo.mas.dev/trigger', 'demo.mas.dev/managed', 'demo.mas.dev/approach'].includes(key)).slice(0, 4)
    .map(([key, value]) => [key.slice(0, 128), text(value, 128)]));
  return { ...pick(source, ['name', 'namespace', 'uid', 'resourceVersion']), labels,
    ownerReferences: array(source.ownerReferences).slice(0, 3).map(owner => pick(owner, ['apiVersion', 'kind', 'name', 'uid', 'controller'])) };
}

function probe(value: unknown): unknown {
  if (!value) return undefined;
  const source = record(value), result = pick(source,
    ['initialDelaySeconds', 'periodSeconds', 'timeoutSeconds', 'successThreshold', 'failureThreshold', 'tcpSocket', 'grpc']);
  if (source.exec) result.exec = { command: argumentsProjection(record(source.exec).command) };
  if (source.httpGet) result.httpGet = { ...pick(source.httpGet, ['path', 'port', 'scheme']),
    httpHeaders: array(record(source.httpGet).httpHeaders).slice(0, 8).map(header => ({ name: text(record(header).name), value: '[REDACTED]' })) };
  return result;
}

function argumentsProjection(value: unknown): unknown[] {
  const entries = array(value).slice(0, 12);
  return entries.map((entry, index) => index > 0 && /^--?(?:password|passwd|secret|token|api[_-]?key)$/i.test(String(entries[index - 1]))
    ? '[REDACTED]' : text(entry));
}

function containers(value: unknown): unknown[] {
  return array(value).slice(0, 4).map(container => {
    const source = record(container);
    return { name: text(source.name), image: text(source.image),
      command: argumentsProjection(source.command),
      args: argumentsProjection(source.args),
      resources: pick(source.resources, ['requests', 'limits']),
      securityContext: pick(source.securityContext, ['allowPrivilegeEscalation', 'runAsNonRoot', 'runAsUser', 'readOnlyRootFilesystem', 'capabilities']),
      env: array(source.env).slice(0, 16).map(variable => {
        const env = record(variable);
        return { name: text(env.name), ...(env.value !== undefined ? { value: '[REDACTED]' } : {}),
          ...(env.valueFrom ? { valueFrom: pick(env.valueFrom, ['configMapKeyRef', 'secretKeyRef', 'fieldRef', 'resourceFieldRef']) } : {}) };
      }),
      readinessProbe: probe(source.readinessProbe), livenessProbe: probe(source.livenessProbe), startupProbe: probe(source.startupProbe) };
  });
}

function podSpec(value: unknown): JSONRecord {
  const source = record(value);
  return { ...pick(source, ['restartPolicy', 'nodeName', 'serviceAccountName', 'automountServiceAccountToken']),
    containers: containers(source.containers), initContainers: containers(source.initContainers),
    volumes: array(source.volumes).slice(0, 8).map(volume => pick(volume, ['name', 'configMap', 'secret', 'emptyDir'])) };
}

function status(value: unknown): JSONRecord {
  const source = record(value);
  return { ...pick(source, ['phase', 'replicas', 'readyReplicas', 'availableReplicas', 'updatedReplicas', 'observedGeneration']),
    conditions: array(source.conditions).slice(0, 8).map(condition => {
      const row = record(condition);
      return { ...pick(row, ['type', 'status', 'reason', 'lastTransitionTime']), message: text(row.message, 512) };
    }),
    containerStatuses: array(source.containerStatuses).slice(0, 4).map(container => {
      const row = record(container);
      const state = (value: unknown) => Object.fromEntries(Object.entries(record(value)).slice(0, 3).map(([key, entry]) => {
        const details = record(entry);
        return [key, { ...pick(details, ['reason', 'exitCode', 'signal', 'startedAt', 'finishedAt']), message: text(details.message, 512) }];
      }));
      return { ...pick(row, ['name', 'ready', 'restartCount', 'started']), state: state(row.state), lastState: state(row.lastState) };
    }) };
}

export function projectResource(value: unknown, kind: 'Pod' | 'ReplicaSet' | 'Deployment'): JSONRecord {
  const source = record(value), spec = record(source.spec);
  return { apiVersion: source.apiVersion ?? (kind === 'Pod' ? 'v1' : 'apps/v1'), kind,
    metadata: metadata(source.metadata),
    spec: kind === 'Pod' ? podSpec(spec) : { ...pick(spec, ['replicas', 'selector']),
      template: { metadata: metadata(record(spec.template).metadata), spec: podSpec(record(spec.template).spec) } },
    status: status(source.status), ...(kind === 'Deployment' && spec.template ? { templateHash: canonicalTemplateHash(spec.template) } : {}) };
}

function failure(error: unknown): string {
  const code = record(error).statusCode;
  return typeof code === 'number' ? `Kubernetes API returned ${code}` : 'Evidence request unavailable or timed out';
}

export interface EvidenceOptions { now?: () => number; budgetMs?: number }

// Kubernetes 1.32 CEL object equality treats a declared nullable property set to
// null as absent on lookup, so whole-spec equality fails even on /status writes.
// Omit unavailable data in CR storage; restore the public bundle's explicit null
// before admission to the backend. Opaque non-null data retains deep equality.
export function evidenceForStorage(bundle: EvidenceBundle): unknown {
  return { ...bundle, items: bundle.items.map(({ data, ...item }) => data === null ? item : { ...item, data }) };
}

export function evidenceFromStorage(bundle: EvidenceBundle | undefined): EvidenceBundle | undefined {
  if (!bundle) return undefined;
  return parseEvidence({ ...bundle, items: bundle.items.map(item => ({ ...item, data: item.data ?? null })) });
}

// Admission retains the single Pod response used for UID and approach checks.
// Do not precollect tool results: live MCP delegation owns their acquisition.
export function collectInvestigationSeed(event: EventEvidence, pod: unknown,
  options: EvidenceOptions = {}): EvidenceBundle {
  const target = event.involvedObject, identity = record(record(pod).metadata);
  if (target.kind !== 'Pod' || !target.uid || target.namespace !== event.namespace
      || identity.uid !== target.uid || identity.name !== target.name || identity.namespace !== target.namespace) {
    throw new Error('MCP admission requires the original namespace, Pod name and UID');
  }
  const capturedAt = new Date((options.now ?? Date.now)()).toISOString();
  const base = `/api/v1/namespaces/${encodeURIComponent(target.namespace)}`;
  return parseEvidence({ version: EVIDENCE_VERSION, capturedAt,
    subject: { namespace: target.namespace, name: target.name, uid: target.uid }, items: [
      { id: 'pod', kind: 'pod', source: `${base}/pods/${encodeURIComponent(target.name)}`,
        status: 'collected', observedAt: capturedAt, truncated: false, data: projectResource(pod, 'Pod') },
      { id: 'events', kind: 'events', source: `${base}/events/${encodeURIComponent(event.name)}`,
        status: 'collected', observedAt: capturedAt, truncated: false,
        data: [{ ...event, message: redactEvidenceText(event.message, 2000) }] },
    ] })!;
}

export async function collectEvidence(kube: KubernetesAPI, event: EventEvidence,
  options: EvidenceOptions = {}): Promise<EvidenceBundle | undefined> {
  const target = event.involvedObject;
  if (target.kind !== 'Pod' || !target.uid || !target.name || target.namespace !== event.namespace) return undefined;
  const now = options.now ?? Date.now, capturedAt = new Date(now()).toISOString();
  const deadline = Date.now() + Math.min(10_000, options.budgetMs ?? 10_000);
  const base = `/api/v1/namespaces/${encodeURIComponent(target.namespace)}`;
  const podPath = `${base}/pods/${encodeURIComponent(target.name)}`;
  const bundle: EvidenceBundle = { version: EVIDENCE_VERSION, capturedAt,
    subject: { namespace: target.namespace, name: target.name, uid: target.uid }, items: [] };
  const timed = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Evidence collection timed out');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Evidence collection timed out')), remaining);
    })]); } finally { if (timer) clearTimeout(timer); }
  };
  const add = (id: string, kind: EvidenceKind, source: string, data: unknown,
    state: EvidenceItem['status'] = 'collected', reason?: string, truncated = false) => {
    bundle.items.push({ id, kind, source, status: state, observedAt: new Date(now()).toISOString(), truncated, data,
      ...(reason ? { reason } : {}) });
  };
  const read = async (id: string, kind: EvidenceKind, path: string, project: (data: unknown) => unknown) => {
    try { const value = await timed(() => kube.get(path)); add(id, kind, path, project(value)); }
    catch (error) { add(id, kind, path, null, 'unavailable', failure(error)); }
  };
  let pod: JSONRecord;
  try {
    pod = record(await timed(() => kube.get(podPath)));
    if (record(pod.metadata).uid !== target.uid) throw new Error('Pod UID changed');
    add('pod', 'pod', podPath, projectResource(pod, 'Pod'));
  } catch (error) {
    add('pod', 'pod', podPath, null, 'unavailable', failure(error));
    add('events', 'events', `${base}/events`, [{ ...event, message: redactEvidenceText(event.message, 768) }]);
    add('metrics', 'metrics', '/apis/metrics.k8s.io/v1beta1', null, 'skipped', 'The original Pod identity is unavailable');
    return parseEvidence(bundle);
  }
  const work: Promise<unknown>[] = [];
  work.push((async () => {
    const owner = array(record(pod.metadata).ownerReferences).map(record).find(owner => owner.controller === true);
    if (owner?.kind !== 'ReplicaSet' || owner.apiVersion !== 'apps/v1' || typeof owner.name !== 'string') return;
    const rsPath = `/apis/apps/v1/namespaces/${encodeURIComponent(target.namespace)}/replicasets/${encodeURIComponent(owner.name)}`;
    try {
      const rs = record(await timed(() => kube.get(rsPath)));
      if (record(rs.metadata).uid !== owner.uid) throw new Error('Owner UID changed');
      add('workload-replicaset', 'workload', rsPath, projectResource(rs, 'ReplicaSet'));
      const deployment = array(record(rs.metadata).ownerReferences).map(record).find(owner => owner.controller === true);
      if (deployment?.kind !== 'Deployment' || deployment.apiVersion !== 'apps/v1' || typeof deployment.name !== 'string') return;
      const path = `/apis/apps/v1/namespaces/${encodeURIComponent(target.namespace)}/deployments/${encodeURIComponent(deployment.name)}`;
      try {
        const value = record(await timed(() => kube.get(path)));
        if (record(value.metadata).uid !== deployment.uid) throw new Error('Owner UID changed');
        add('workload-deployment', 'workload', path, projectResource(value, 'Deployment'));
      } catch (error) { add('workload-deployment', 'workload', path, null, 'unavailable', failure(error)); }
    } catch (error) { add('workload-replicaset', 'workload', rsPath, null, 'unavailable', failure(error)); }
  })());
  const eventPath = `${base}/events?fieldSelector=${encodeURIComponent(`involvedObject.uid=${target.uid}`)}`;
  work.push((async () => {
    try {
      const events = await timed(() => kube.list<unknown>(eventPath));
      const selected = events.filter(value => record(record(value).involvedObject).uid === target.uid).slice(-8);
      add('events', 'events', eventPath, selected.map(value => {
        const row = record(value);
        return { metadata: metadata(row.metadata), ...pick(row, ['type', 'reason', 'count', 'firstTimestamp', 'lastTimestamp', 'eventTime']),
          message: text(row.message, 768), involvedObject: pick(row.involvedObject, ['kind', 'name', 'namespace', 'uid']) };
      }), 'collected', undefined, events.length > 8);
    } catch (error) { add('events', 'events', eventPath, null, 'unavailable', failure(error)); }
  })());
  const metricPath = `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(target.namespace)}/pods/${encodeURIComponent(target.name)}`;
  work.push(read('metrics', 'metrics', metricPath, value => {
    const row = record(value), sample = Date.parse(String(row.timestamp));
    const created = Date.parse(String(record(pod.metadata).creationTimestamp));
    if (record(row.metadata).name !== target.name || !Number.isFinite(sample) || sample > now() + 60_000 || now() - sample > 120_000
      || (Number.isFinite(created) && sample < created) || !array(row.containers).length) {
      throw new Error('No fresh target metrics sample');
    }
    return { metadata: metadata(row.metadata), timestamp: row.timestamp, window: row.window,
      containers: array(row.containers).slice(0, 4).map(value => ({ name: text(record(value).name), usage: pick(record(value).usage, ['cpu', 'memory']) })) };
  }));
  for (const container of array(record(pod.spec).containers).slice(0, 2)) {
    const name = record(container).name;
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) continue;
    for (const previous of [false, true]) {
      const path = `${podPath}/log?container=${encodeURIComponent(name)}&timestamps=true&tailLines=40&limitBytes=2048&sinceSeconds=900&previous=${previous}`;
      work.push((async () => {
        const id = `logs-${name}-${previous ? 'previous' : 'current'}`;
        if (!kube.text) { add(id, 'logs', path, null, 'unavailable', 'The Kubernetes client does not support log reads'); return; }
        try {
          const raw = await timed(() => kube.text!(path, 4096));
          const clipped = Buffer.from(raw).subarray(0, 2048).toString('utf8');
          add(id, 'logs', path, { container: name, previous, text: redactEvidenceText(clipped, 2048) }, 'collected', undefined,
            Buffer.byteLength(raw) >= 2048);
        } catch (error) { add(id, 'logs', path, null, 'unavailable', failure(error)); }
      })());
    }
  }
  await Promise.all(work);
  try {
    const final = record(await timed(() => kube.get(podPath)));
    if (record(final.metadata).uid !== target.uid) throw new Error('Pod UID changed');
  } catch {
    for (const item of bundle.items) if (item.kind !== 'events') {
      item.status = 'unavailable'; item.data = null; item.reason = 'Original Pod identity could not be verified after collection';
    }
  }
  bundle.items.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  // Preserve provenance/status rather than silently dropping an item to meet the cap.
  while (Buffer.byteLength(JSON.stringify(bundle)) > MAX_EVIDENCE_BYTES) {
    const largest = bundle.items.filter(item => item.data !== null)
      .sort((a, b) => JSON.stringify(b.data).length - JSON.stringify(a.data).length)[0];
    if (!largest) throw new Error('Evidence metadata exceeds limit');
    largest.data = null; largest.status = 'unavailable'; largest.truncated = true; largest.reason = 'Item omitted to preserve the 32 KiB total evidence limit';
  }
  return parseEvidence(bundle);
}
