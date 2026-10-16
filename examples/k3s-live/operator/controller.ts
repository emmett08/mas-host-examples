export const GROUP = 'demo.mas.dev';
export const VERSION = 'v1alpha1';
export const PLURAL = 'masdemoruns';
export const TRIGGER_LABEL = `${GROUP}/trigger`;

export interface Metadata {
  name: string;
  namespace?: string;
  uid?: string;
  creationTimestamp?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
}

export interface EventEvidence {
  namespace: string;
  name: string;
  uid: string;
  reason: string;
  message: string;
  involvedObject: { kind: string; name: string; namespace: string; uid: string };
}

export interface KubernetesEvent {
  metadata: Metadata;
  type?: string;
  reason?: string;
  message?: string;
  lastTimestamp?: string;
  eventTime?: string | null;
  involvedObject?: { kind?: string; name?: string; namespace?: string; uid?: string };
}

export interface DemoRun {
  apiVersion: string;
  kind: string;
  metadata: Metadata;
  spec: { scenario: 'pod-crash'; event?: EventEvidence };
  status?: {
    phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed';
    runId?: string;
    message?: string;
    observedGeneration?: number;
  };
}

export interface KubernetesAPI {
  list<T>(path: string): Promise<T[]>;
  get<T>(path: string): Promise<T>;
  create<T>(path: string, resource: unknown): Promise<T>;
  status(path: string, status: unknown): Promise<void>;
}

export interface RunState {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  error?: string;
}

export interface DemoAPI {
  get(id: string): Promise<RunState | undefined>;
  start(input: { id: string; scenario: 'pod-crash'; event?: EventEvidence }): Promise<RunState>;
}

export class APIError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface ControllerOptions {
  namespace: string;
  maxActiveRuns?: number;
  maxQueuedRuns?: number;
  maxEventAgeMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

// Status is an observation, not the execution lock. The backend admits each run
// ID durably, so a lost status update cannot cause a second model execution.
export class DemoController {
  private readonly runPath: string;
  private readonly corePath: string;
  private readonly maxActive: number;
  private readonly maxQueued: number;
  private readonly maxAge: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly kube: KubernetesAPI, private readonly demo: DemoAPI,
    private readonly options: ControllerOptions) {
    if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(options.namespace)) {
      throw new Error('MAS_NAMESPACE must be a Kubernetes namespace name');
    }
    this.runPath = `/apis/${GROUP}/${VERSION}/namespaces/${options.namespace}/${PLURAL}`;
    this.corePath = `/api/v1/namespaces/${options.namespace}`;
    this.maxActive = options.maxActiveRuns ?? 1;
    this.maxQueued = options.maxQueuedRuns ?? 4;
    this.maxAge = options.maxEventAgeMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console.log;
  }

  async tick(): Promise<void> {
    const runs = await this.kube.list<DemoRun>(this.runPath);
    runs.sort((left, right) => (left.metadata.creationTimestamp ?? '').localeCompare(
      right.metadata.creationTimestamp ?? '') || left.metadata.name.localeCompare(right.metadata.name));
    let active = 0;
    const waiting: DemoRun[] = [];
    for (const run of runs) {
      if (run.status?.phase === 'Succeeded' || run.status?.phase === 'Failed') continue;
      // Observe all existing executions before admitting queued work, including
      // work whose initial status update was lost.
      const observed = await this.reconcile(run, false);
      if (observed === undefined) waiting.push(run);
      else if (observed) active += 1;
    }
    for (const run of waiting) {
      if (active >= this.maxActive) break;
      if (await this.reconcile(run, true)) active += 1;
    }
    const pending = runs.filter(run => !['Succeeded', 'Failed'].includes(run.status?.phase ?? '')).length;
    if (pending >= this.maxQueued) return;
    const knownEvents = new Set(runs.map(run => run.spec.event?.uid).filter(Boolean));
    const events = await this.kube.list<KubernetesEvent>(`${this.corePath}/events?fieldSelector=type%3DWarning`);
    // A long-lived Event's occurrence counter is deliberately not a new trigger.
    // Persisted CR names retain this deduplication across controller restarts.
    events.sort((a, b) => (a.metadata.creationTimestamp ?? '').localeCompare(b.metadata.creationTimestamp ?? ''));
    for (const event of events) {
      if (!event.metadata.uid || knownEvents.has(event.metadata.uid) || !this.isRecentWarning(event)) continue;
      if (!await this.isOptedIn(event)) continue;
      const evidence = this.evidence(event);
      const name = `event-${event.metadata.uid}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63).replace(/-+$/, '');
      try {
        await this.kube.create(this.runPath, {
          apiVersion: `${GROUP}/${VERSION}`, kind: 'MASDemoRun',
          metadata: { name, namespace: this.options.namespace, labels: { [`${GROUP}/source`]: 'warning-event' } },
          spec: { scenario: 'pod-crash', event: evidence },
        });
        this.log(`Created MASDemoRun ${name} from opted-in Warning Event ${event.metadata.name}`);
      } catch (error) {
        if (!(error instanceof APIError) || error.statusCode !== 409) throw error;
      }
      // At most one event admission per poll bounds reactions to event bursts.
      break;
    }
  }

  private async reconcile(run: DemoRun, mayStart: boolean): Promise<boolean | undefined> {
    if (!run.metadata.uid) throw new Error(`MASDemoRun ${run.metadata.name} has no UID`);
    const id = `k8s-${run.metadata.uid}`;
    let current = await this.demo.get(id);
    if (!current && !mayStart) return undefined;
    if (!current) current = await this.demo.start({ id, scenario: run.spec.scenario,
      ...(run.spec.event ? { event: run.spec.event } : {}) });
    const phase = current.status === 'completed' ? 'Succeeded'
      : current.status === 'failed' ? 'Failed' : 'Running';
    const next = { phase, runId: id,
      ...(current.error ? { message: current.error.slice(0, 1000) } : {}) };
    if (JSON.stringify(run.status ?? {}) !== JSON.stringify(next)) {
      await this.kube.status(`${this.runPath}/${encodeURIComponent(run.metadata.name)}/status`, next);
    }
    return phase === 'Running';
  }

  private isRecentWarning(event: KubernetesEvent): boolean {
    if (event.type !== 'Warning') return false;
    // Creation time prevents an old, frequently repeated event being replayed
    // when the demonstration is first deployed.
    const created = Date.parse(event.metadata.creationTimestamp ?? '');
    return Number.isFinite(created) && created <= this.now() + 60_000 && this.now() - created <= this.maxAge;
  }

  private async isOptedIn(event: KubernetesEvent): Promise<boolean> {
    if (event.metadata.labels?.[TRIGGER_LABEL] === 'true') return true;
    const object = event.involvedObject;
    if (object?.kind !== 'Pod' || !object.name || object.namespace !== this.options.namespace) return false;
    try {
      const pod = await this.kube.get<{ metadata: Metadata }>(`${this.corePath}/pods/${encodeURIComponent(object.name)}`);
      return pod.metadata.uid === object.uid && pod.metadata.labels?.[TRIGGER_LABEL] === 'true';
    } catch (error) {
      if (error instanceof APIError && error.statusCode === 404) return false;
      throw error;
    }
  }

  private evidence(event: KubernetesEvent): EventEvidence {
    return {
      namespace: this.options.namespace, name: event.metadata.name.slice(0, 253), uid: event.metadata.uid!,
      reason: (event.reason ?? 'Warning').slice(0, 128), message: (event.message ?? '').slice(0, 2000),
      involvedObject: {
        kind: (event.involvedObject?.kind ?? '').slice(0, 128),
        name: (event.involvedObject?.name ?? '').slice(0, 253),
        namespace: (event.involvedObject?.namespace ?? this.options.namespace).slice(0, 63),
        uid: (event.involvedObject?.uid ?? '').slice(0, 128),
      },
    };
  }
}
