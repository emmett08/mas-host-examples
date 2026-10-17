import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { projectResource } from '../operator/evidence.js';
import type { EventEvidence, KubernetesAPI } from '../operator/controller.js';
import { EVIDENCE_VERSION, MAX_EVIDENCE_BYTES, parseEvidence, redactEvidenceText,
  type EvidenceBundle, type EvidenceItem, type EvidenceKind } from '../shared/evidence.js';

export const SERVER_NAME = 'mas-k3s-investigation';
export const CONTEXT_VERSION = 'mas-mcp-investigation/1';
export const TOOL_NAMES = ['pod_overview', 'pod_logs', 'pod_metrics', 'workload_spec'] as const;
export type ToolName = typeof TOOL_NAMES[number];
export interface InvestigationContext {
  version: typeof CONTEXT_VERSION;
  source: 'kubernetes-api' | 'recorded-evidence';
  event: EventEvidence;
  evidence: EvidenceBundle;
}
export interface ToolResult {
  status: 'collected' | 'unavailable' | 'error';
  source: InvestigationContext['source'];
  server: typeof SERVER_NAME;
  tool: ToolName;
  subject: EvidenceBundle['subject'];
  evidence_items: EvidenceItem[];
  numeric_encoding: 'integer-or-decimal-string';
}
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const name = (value: unknown, maximum = 253): value is string => typeof value === 'string'
  && value.length <= maximum && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value);

// The context is created by the run controller, outside model input. Bind every
// operation to that Pod identity; no tool accepts an API path or target name.
export function parseContext(value: unknown): InvestigationContext {
  const context = row(value), event = row(context.event), target = row(event.involvedObject);
  const evidence = parseEvidence(context.evidence);
  if (context.version !== CONTEXT_VERSION || !['kubernetes-api', 'recorded-evidence'].includes(String(context.source))
    || !evidence || target.kind !== 'Pod' || !name(target.namespace, 63) || !name(target.name)
    || typeof target.uid !== 'string' || !target.uid || target.uid.length > 128
    || target.namespace !== event.namespace || target.namespace !== evidence.subject.namespace
    || target.name !== evidence.subject.name || target.uid !== evidence.subject.uid) {
    throw new Error('Invalid or mismatched investigation context');
  }
  return { version: CONTEXT_VERSION, source: context.source as InvestigationContext['source'],
    event: context.event as EventEvidence, evidence };
}

export async function readContext(path: string | undefined, expectedSHA256?: string): Promise<InvestigationContext> {
  if (!path || !isAbsolute(path)) throw new Error('An absolute controller-owned MCP context path is required');
  const content = await readFile(path);
  if (content.byteLength > MAX_EVIDENCE_BYTES + 8192) throw new Error('Investigation context exceeds byte limit');
  if (expectedSHA256 !== undefined && createHash('sha256').update(content).digest('hex') !== expectedSHA256)
    throw new Error('Investigation context identity changed');
  return parseContext(JSON.parse(content.toString('utf8')));
}

export function validateArguments(tool: string, value: unknown): asserts tool is ToolName {
  if (!TOOL_NAMES.includes(tool as ToolName)) throw new Error('Unknown investigation tool');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be an object');
  const args = value as Row;
  const allowed = tool === 'pod_logs' ? ['container', 'previous', 'tail_lines'] : [];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unrecognised tool argument; the incident target is fixed');
  if (args.container !== undefined && (!name(args.container, 63) || String(args.container).includes('.')))
    throw new Error('Invalid container name');
  if (args.previous !== undefined && typeof args.previous !== 'boolean') throw new Error('previous must be boolean');
  if (args.tail_lines !== undefined && (!Number.isInteger(args.tail_lines) || Number(args.tail_lines) < 1 || Number(args.tail_lines) > 40))
    throw new Error('tail_lines must be an integer from 1 to 40');
}

// Nehemiah payloads retain exact integers. Non-integral or out-of-range JSON
// numbers become explicit strings; this never rounds a quantity to an integer.
export function exactJSON(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw new Error('Numeric observation cannot be represented without precision loss');
    return Number.isSafeInteger(value) ? value : String(value);
  }
  if (Array.isArray(value)) return value.map(exactJSON);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, exactJSON(entry)]));
  return value;
}

export const toolDefinitions = TOOL_NAMES.map(tool => ({
  name: tool,
  description: ({ pod_overview: 'Read status and warning events for the incident Pod only.',
    pod_logs: 'Read a bounded, redacted log excerpt from an incident Pod container.',
    pod_metrics: 'Read fresh CPU and memory observations for the incident Pod; absent metrics remain unavailable.',
    workload_spec: 'Read projected specifications through the incident Pod owner chain, checking every owner UID.' })[tool],
  inputSchema: { type: 'object' as const, additionalProperties: false,
    properties: tool === 'pod_logs' ? {
      container: { type: 'string', maxLength: 63, description: 'Container within the fixed incident Pod; defaults to its first container.' },
      previous: { type: 'boolean', default: false },
      tail_lines: { type: 'integer', minimum: 1, maximum: 40, default: 40 },
    } : {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}));

export class InvestigationTools {
  constructor(readonly context: InvestigationContext, readonly kube?: KubernetesAPI,
    readonly options: { now?: () => number; budgetMs?: number } = {}) {}

  async call(tool: string, arguments_: unknown, signal?: AbortSignal): Promise<ToolResult> {
    validateArguments(tool, arguments_);
    if (signal?.aborted) throw new Error('Investigation request cancelled');
    const args = arguments_ as Row, now = this.options.now ?? Date.now;
    // Tail length selects a different projection of the same observation. Give
    // it a distinct evidence identity; default callers keep existing IDs.
    const logProjection = args.tail_lines !== undefined && args.tail_lines !== 40 ? `-tail-${args.tail_lines}` : '';
    const subject = this.context.evidence.subject;
    const items: EvidenceItem[] = [];
    const add = (id: string, kind: EvidenceKind, source: string, data: unknown,
      status: EvidenceItem['status'] = 'collected', reason?: string, truncated = false) => {
      items.push({ id, kind, source, status, observedAt: new Date(now()).toISOString(), truncated,
        data: data ?? null, ...(reason ? { reason } : {}) });
    };
    const kinds: Record<ToolName, EvidenceKind[]> = { pod_overview: ['pod', 'events'], pod_logs: ['logs'],
      pod_metrics: ['metrics'], workload_spec: ['workload'] };
    if (this.context.source === 'recorded-evidence') {
      const selected = this.context.evidence.items.filter(item => kinds[tool].includes(item.kind))
        .filter(item => tool !== 'pod_logs' || ((args.container === undefined || row(item.data).container === args.container)
          && (row(item.data).previous === (args.previous ?? false) || item.data === null)));
      for (const item of selected) {
        const copy = structuredClone(item);
        if (copy.kind === 'logs') copy.id += logProjection;
        if (copy.kind === 'logs' && copy.data !== null) {
          const data = row(copy.data), raw = String(data.text ?? '');
          const lines = raw.split('\n').slice(-Number(args.tail_lines ?? 40)).join('\n');
          copy.data = { ...data, text: redactEvidenceText(lines, 2048) };
          copy.truncated ||= lines !== raw || raw.length > 2048;
        }
        items.push(copy);
      }
      if (!items.length) add(`mcp-${tool.replaceAll('_', '-')}`, kinds[tool][0]!, 'recorded-evidence', null,
        'unavailable', 'The retained evidence has no matching observation; this tool has not queried a live cluster');
    } else {
      if (!this.kube) throw new Error('Live investigation requires a Kubernetes client');
      const kube = this.kube, deadline = Date.now() + Math.min(10_000, this.options.budgetMs ?? 10_000);
      const timed = async <T>(operation: () => Promise<T>): Promise<T> => {
        if (signal?.aborted) throw new Error('Investigation request cancelled');
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Investigation request timed out');
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abort: (() => void) | undefined;
        try {
          return await Promise.race([operation(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Investigation request timed out')), remaining);
            abort = () => reject(new Error('Investigation request cancelled'));
            signal?.addEventListener('abort', abort, { once: true });
          })]);
        } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
      };
      const base = `/api/v1/namespaces/${encodeURIComponent(subject.namespace)}`;
      const podPath = `${base}/pods/${encodeURIComponent(subject.name)}`;
      const readPod = async () => {
        const pod = row(await timed(() => kube.get(podPath))), metadata = row(pod.metadata);
        if (metadata.uid !== subject.uid || metadata.name !== subject.name || metadata.namespace !== subject.namespace)
          throw new Error('Original Pod identity unavailable');
        return pod;
      };
      let pod: Row | undefined;
      try { pod = await readPod(); }
      catch { add('pod', 'pod', podPath, null, 'unavailable', 'Original Pod identity could not be verified'); }
      if (pod) {
        try {
          if (tool === 'pod_overview') {
            add('pod', 'pod', podPath, projectResource(pod, 'Pod'));
            const path = `${base}/events?fieldSelector=${encodeURIComponent(`involvedObject.uid=${subject.uid}`)}`;
            const events = (await timed(() => kube.list<unknown>(path))).map(row)
              .filter(event => row(event.involvedObject).uid === subject.uid);
            add('events', 'events', path, events.slice(-8).map(event => ({
              reason: redactEvidenceText(String(event.reason ?? ''), 128), type: String(event.type ?? '').slice(0, 32),
              message: redactEvidenceText(String(event.message ?? ''), 768), involvedObject: { ...subject, kind: 'Pod' },
            })), 'collected', undefined, events.length > 8);
          } else if (tool === 'pod_logs') {
            const containers = rows(row(pod.spec).containers);
            const container = args.container ?? containers[0]?.name;
            if (!name(container, 63) || !containers.some(candidate => candidate.name === container))
              throw new Error('Container is not part of the incident Pod');
            const previous = args.previous ?? false;
            const path = `${podPath}/log?container=${encodeURIComponent(container)}&timestamps=true&tailLines=${args.tail_lines ?? 40}&limitBytes=2048&sinceSeconds=900&previous=${previous}`;
            if (!kube.text) throw new Error('Log reads unavailable');
            const raw = await timed(() => kube.text!(path, 4096));
            add(`logs-${container}-${previous ? 'previous' : 'current'}${logProjection}`, 'logs', path,
              { container, previous, text: redactEvidenceText(Buffer.from(raw).subarray(0, 2048).toString('utf8'), 2048) },
              'collected', undefined, Buffer.byteLength(raw) >= 2048);
          } else if (tool === 'pod_metrics') {
            const path = `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(subject.namespace)}/pods/${encodeURIComponent(subject.name)}`;
            const metric = row(await timed(() => kube.get(path))), metadata = row(metric.metadata);
            const stamp = Date.parse(String(metric.timestamp)), created = Date.parse(String(row(pod.metadata).creationTimestamp));
            if (metadata.name !== subject.name || metadata.namespace !== subject.namespace || !Number.isFinite(stamp)
              || stamp > now() + 60_000 || now() - stamp > 120_000 || (Number.isFinite(created) && stamp < created)
              || !rows(metric.containers).length) throw new Error('No fresh target metrics sample');
            add('metrics', 'metrics', path, { metadata: { name: subject.name, namespace: subject.namespace },
              timestamp: metric.timestamp, window: metric.window, containers: rows(metric.containers).slice(0, 4)
                .map(container => ({ name: container.name, usage: { cpu: row(container.usage).cpu, memory: row(container.usage).memory } })) });
          } else {
            let owner = rows(row(pod.metadata).ownerReferences).find(owner => owner.controller === true);
            for (const [kind, plural, id] of [['ReplicaSet', 'replicasets', 'workload-replicaset'],
              ['Deployment', 'deployments', 'workload-deployment']] as const) {
              if (!owner || owner.kind !== kind || owner.apiVersion !== 'apps/v1' || !name(owner.name)
                || typeof owner.uid !== 'string' || !owner.uid) break;
              const path = `/apis/apps/v1/namespaces/${encodeURIComponent(subject.namespace)}/${plural}/${encodeURIComponent(owner.name)}`;
              const resource = row(await timed(() => kube.get(path))), metadata = row(resource.metadata);
              if (metadata.uid !== owner.uid || metadata.name !== owner.name || metadata.namespace !== subject.namespace)
                throw new Error('Owner identity changed');
              add(id, 'workload', path, projectResource(resource, kind));
              owner = rows(metadata.ownerReferences).find(owner => owner.controller === true);
            }
            if (!items.length) add('workload', 'workload', podPath, null, 'unavailable', 'The Pod has no supported UID-bound ReplicaSet or Deployment owner');
          }
        } catch (error) {
          if (signal?.aborted) throw new Error('Investigation request cancelled');
          const status = row(error).statusCode;
          add(`mcp-${tool.replaceAll('_', '-')}`, kinds[tool][0]!, podPath, null, 'unavailable',
            typeof status === 'number' ? `Kubernetes API returned ${status}` : 'Requested evidence unavailable, invalid, or timed out');
        }
        try { await readPod(); }
        catch {
          for (const item of items) {
            item.status = 'unavailable'; item.data = null;
            item.reason = 'Original Pod identity could not be verified after collection';
          }
        }
      }
    }
    if (signal?.aborted) throw new Error('Investigation request cancelled');
    const result = exactJSON({ status: items.some(item => item.status === 'collected') ? 'collected' : 'unavailable',
      source: this.context.source, server: SERVER_NAME, tool, subject,
      evidence_items: items, numeric_encoding: 'integer-or-decimal-string' }) as ToolResult;
    // Keep room for result provenance while preserving every item's availability status.
    while (Buffer.byteLength(JSON.stringify(result)) > 7800) {
      const largest = result.evidence_items.filter(item => item.data !== null)
        .sort((a, b) => JSON.stringify(b.data).length - JSON.stringify(a.data).length)[0];
      if (!largest) throw new Error('Investigation metadata exceeds byte limit');
      largest.data = null; largest.status = 'unavailable'; largest.truncated = true;
      largest.reason = 'Item omitted to preserve the MCP result byte limit';
    }
    result.status = result.evidence_items.some(item => item.status === 'collected') ? 'collected' : 'unavailable';
    parseEvidence({ version: EVIDENCE_VERSION, capturedAt: new Date(now()).toISOString(), subject, items: result.evidence_items });
    return result;
  }
}
