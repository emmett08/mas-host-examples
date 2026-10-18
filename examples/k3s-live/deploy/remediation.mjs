// A narrow external tool policy. Model commands and arbitrary patches never execute.
import { createHash } from 'node:crypto';
import { executeGuardedOperation, VerificationFailure } from './guarded-operation.mjs';

export const APPLICATION_BODY = 'MAS checkout service ready\n';
const TARGET = { namespace: 'mas-demo', name: 'mas-demo-checkout', container: 'checkout' };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function canonicalTemplateHash(template) {
  return createHash('sha256').update(JSON.stringify(canonical(template))).digest('hex');
}
function evidence(snapshot) { return snapshot?.run?.input?.incident?.evidence; }
function collected(bundle, id) { return bundle?.items?.find(item => item.id === id && item.status === 'collected'); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function verifyAssert(condition, message) { if (!condition) throw new VerificationFailure(message); }
const LOG_LIMIT = 4096;
const EVENT_LIMIT = 12;
const EVENT_BYTES = 6144;
function postChangeLogRecords(text) {
  const lines = text.split('\n').filter(line => line.trim());
  const records = [];
  let omittedLines = 0, unparsedLines = 0;
  for (const line of lines) {
    try {
      const separator = line.indexOf(' ');
      const timestamp = line.slice(0, separator);
      const record = JSON.parse(line.slice(separator + 1));
      assert(separator > 0 && Number.isFinite(Date.parse(timestamp)) && record && typeof record === 'object', 'Invalid timestamped log');
      if (record.method === 'GET' && ['/', '/readyz', '/healthz'].includes(record.path)) {
        assert(Number.isInteger(record.status) && record.status >= 100 && record.status <= 599, 'Invalid HTTP status');
        // Retain the actual HTTP observation, never arbitrary application fields.
        records.push({ timestamp, method: 'GET', path: record.path, status: record.status });
      } else omittedLines++;
    } catch { unparsedLines++; }
  }
  return { records, omittedLines, unparsedLines, truncated: Buffer.byteLength(text) >= LOG_LIMIT };
}
function postChangeEvent(event) {
  const field = (value, limit = 128) => typeof value === 'string' ? value.slice(0, limit) : '';
  const timestamp = value => {
    if (value === undefined || value === null || value === '') return null;
    assert(typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)), 'Invalid Event occurrence timestamp');
    return value;
  };
  assert(event && typeof event === 'object' && [event.metadata?.name, event.metadata?.uid,
    event.involvedObject?.namespace, event.involvedObject?.name, event.involvedObject?.uid, event.type, event.reason]
    .every(value => typeof value === 'string' && value.length > 0), 'Incomplete Event metadata');
  const readinessFailure = event.type === 'Warning' && event.reason === 'Unhealthy' &&
    typeof event.message === 'string' && /^Readiness probe failed:/.test(event.message);
  // Event messages can contain URLs and credentials. Keep the canonical status
  // failure verbatim, otherwise retain occurrence metadata and a classification.
  const probePrefix = /^(Readiness|Liveness|Startup) probe failed:/.exec(event.message ?? '')?.[0];
  const message = /^Readiness probe failed: HTTP probe failed with statuscode: [1-5][0-9]{2}$/.test(event.message ?? '')
    ? event.message : probePrefix ? `${probePrefix} [details omitted]` : '[details omitted]';
  return { metadata: { name: field(event.metadata?.name), uid: field(event.metadata?.uid) },
    involvedObject: { namespace: field(event.involvedObject?.namespace), name: field(event.involvedObject?.name), uid: field(event.involvedObject?.uid) },
    type: field(event.type, 32), reason: field(event.reason, 64), message, readinessFailure,
    count: Number.isInteger(event.count) && event.count >= 0 ? event.count : null,
    firstTimestamp: timestamp(event.firstTimestamp), lastTimestamp: timestamp(event.lastTimestamp),
    eventTime: timestamp(event.eventTime), seriesLastObservedTime: timestamp(event.series?.lastObservedTime) };
}
async function collectPostChangeEvidence(kubectl, pod, startedAt, now) {
  const podPath = `/api/v1/namespaces/${TARGET.namespace}/pods/${pod.metadata.name}`;
  const logSource = `${podPath}/log?container=checkout&timestamps=true&sinceTime=${encodeURIComponent(startedAt)}&previous=false`;
  const eventSelector = `involvedObject.uid=${pod.metadata.uid}`;
  const eventSource = `/api/v1/namespaces/${TARGET.namespace}/events?fieldSelector=${encodeURIComponent(eventSelector)}`;
  const [logs, events] = await Promise.all([
    (async () => {
      try {
        // No API-side tail or byte truncation: the transport aborts an oversized
        // response rather than mistaking a partial log for complete coverage.
        const text = await kubectl(['logs', pod.metadata.name, '-c', TARGET.container, '--timestamps=true',
          `--since-time=${startedAt}`, '--previous=false']);
        return { status: 'collected', source: logSource, observedAt: new Date(now()).toISOString(), ...postChangeLogRecords(text) };
      } catch {
        return { status: 'unavailable', source: logSource, observedAt: new Date(now()).toISOString(), truncated: false,
          records: [], omittedLines: 0, unparsedLines: 0, reason: 'The replacement checkout current logs could not be collected.' };
      }
    })(),
    (async () => {
      try {
        const response = JSON.parse(await kubectl(['get', 'events', '--field-selector', eventSelector, '-o', 'json']));
        assert(Array.isArray(response.items), 'Invalid Event list');
        const items = [];
        let truncated = Boolean(response.metadata?.continue) || response.items.length > EVENT_LIMIT;
        for (const event of response.items.slice(0, EVENT_LIMIT)) {
          const projected = postChangeEvent(event);
          assert(projected.involvedObject.uid === pod.metadata.uid && projected.involvedObject.name === pod.metadata.name &&
            projected.involvedObject.namespace === TARGET.namespace, 'Event selector returned another Pod identity');
          if (Buffer.byteLength(JSON.stringify([...items, projected])) > EVENT_BYTES) { truncated = true; break; }
          items.push(projected);
        }
        return { status: 'collected', source: eventSource, observedAt: new Date(now()).toISOString(), truncated, items };
      } catch {
        return { status: 'unavailable', source: eventSource, observedAt: new Date(now()).toISOString(), truncated: false,
          items: [], reason: 'The replacement Pod Events could not be collected.' };
      }
    })(),
  ]);
  return { version: 'mas-k8s-post-change-evidence/1',
    subject: { namespace: TARGET.namespace, name: pod.metadata.name, uid: pod.metadata.uid, container: TARGET.container },
    window: { startedAt, endedAt: new Date(now()).toISOString() }, logs, events };
}
export function verifyPostChangeEvidence(evidence) {
  const startedAt = Date.parse(evidence.window.startedAt), endedAt = Date.parse(evidence.window.endedAt);
  const { logs, events } = evidence;
  assert(logs.status === 'collected' && !logs.truncated && logs.unparsedLines === 0,
    'Post-change checkout logs are unavailable, truncated or contain unparseable records');
  const current = logs.records.filter(record => Date.parse(record.timestamp) >= startedAt && Date.parse(record.timestamp) <= endedAt + 5000);
  verifyAssert(!current.some(record => record.path === '/healthz' && record.status !== 200 || record.path === '/readyz' && record.status === 404),
    'Post-change checkout logs still show a failed health endpoint');
  assert(current.some(record => record.method === 'GET' && record.path === '/healthz' && record.status === 200),
    'Post-change checkout logs do not establish a fresh GET /healthz 200 in the observation window');
  assert(events.status === 'collected' && !events.truncated, 'Post-change Pod Events are unavailable or truncated');
  for (const event of events.items) {
    assert(event.involvedObject.uid === evidence.subject.uid && event.involvedObject.name === evidence.subject.name &&
      event.involvedObject.namespace === evidence.subject.namespace, 'Post-change Event identity differs from the replacement Pod');
    if (!event.readinessFailure) {
      assert(event.type !== 'Warning' || event.reason !== 'Unhealthy' || /^(Liveness|Startup) probe failed:/.test(event.message),
        'An Unhealthy Warning does not identify which probe failed');
      continue;
    }
    const occurrences = [event.lastTimestamp, event.eventTime, event.seriesLastObservedTime].filter(Boolean).map(Date.parse);
    // firstTimestamp alone cannot establish the latest occurrence of an
    // aggregated Warning. Missing occurrence time is uncertainty, not absence.
    if (occurrences.length === 0 && event.count === 1 && event.firstTimestamp) occurrences.push(Date.parse(event.firstTimestamp));
    assert(occurrences.length > 0 && occurrences.every(Number.isFinite), 'A readiness Warning lacks a usable latest occurrence timestamp');
    const latest = Math.max(...occurrences);
    assert(latest <= endedAt + 5000, 'A readiness Warning has an occurrence timestamp beyond the observation window');
    verifyAssert(latest < startedAt, 'The replacement Pod has a readiness Warning during the post-change observation window');
  }
}
export function validatePracticalEvidence(snapshot) {
  const bundle = evidence(snapshot);
  assert(bundle?.version === 'mas-k8s-evidence/1', 'A practical recording requires a collected Kubernetes evidence bundle');
  for (const id of ['pod', 'workload-replicaset', 'workload-deployment', 'events', 'logs-checkout-current', 'metrics']) {
    assert(collected(bundle, id), `A practical recording requires collected ${id} evidence`);
  }
  const pod = collected(bundle, 'pod').data;
  assert(pod.metadata.uid === bundle.subject.uid && pod.metadata.name === bundle.subject.name,
    'Collected Pod identity differs from the investigation subject');
  const rs = collected(bundle, 'workload-replicaset').data;
  const deployment = collected(bundle, 'workload-deployment').data;
  assert(pod.metadata.ownerReferences?.some(owner => owner.controller === true && owner.kind === 'ReplicaSet' && owner.uid === rs.metadata?.uid) &&
    rs.metadata?.ownerReferences?.some(owner => owner.controller === true && owner.kind === 'Deployment' && owner.uid === deployment.metadata?.uid),
  'Collected Pod and ReplicaSet do not belong to the recorded Deployment');
  assert(pod.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'False') &&
    pod.spec?.containers?.some(container => container.name === 'checkout' && container.readinessProbe?.httpGet?.path === '/readyz' &&
      container.livenessProbe?.httpGet?.path === '/healthz'), 'The original Pod does not show the demonstrated readiness failure');
  assert(collected(bundle, 'events').data?.some(event => event.type === 'Warning' && event.reason === 'Unhealthy' &&
    event.involvedObject?.uid === bundle.subject.uid), 'The original Pod has no collected Unhealthy Warning');
  const metricsItem = collected(bundle, 'metrics');
  const metrics = metricsItem.data;
  const timestamp = Date.parse(metrics.timestamp);
  const capturedAt = Date.parse(metricsItem.observedAt);
  assert(metrics.metadata?.name === bundle.subject.name && metrics.metadata?.namespace === bundle.subject.namespace &&
    Number.isFinite(timestamp) && Number.isFinite(capturedAt) && timestamp <= capturedAt + 5000 && capturedAt - timestamp < 120_000 && typeof metrics.window === 'string' &&
    metrics.containers?.some(container => container.name === 'checkout' && typeof container.usage?.cpu === 'string' &&
      typeof container.usage?.memory === 'string'), 'CPU and memory measurements must include their actual timestamp and window');
  return bundle;
}
export function admitReadinessPatch(snapshot, deployment) {
  const bundle = validatePracticalEvidence(snapshot);
  const decision = snapshot.run.output;
  assert(decision?.requires_human === false, 'The decision requires an engineer; automatic remediation was not authorised');
  const remedy = decision.remediation;
  assert(remedy?.action === 'replace_readiness_probe_path', 'The decision does not propose the admitted readiness correction');
  const saved = collected(bundle, 'workload-deployment').data;
  const target = remedy.target;
  assert(target?.kind === 'Deployment' && target.namespace === TARGET.namespace && target.name === TARGET.name &&
    target.container === TARGET.container && target.uid === saved.metadata.uid &&
    target.resource_version === saved.metadata.resourceVersion,
  'The proposed target does not exactly match the recorded demonstration Deployment');
  assert(remedy.current_path === '/readyz' && remedy.proposed_path === '/healthz', 'Only /readyz to /healthz is admitted');
  const required = ['pod', 'workload-deployment', 'logs-checkout-current'];
  assert(required.every(id => remedy.evidence_ids?.includes(id)) && remedy.evidence_ids.every(id => collected(bundle, id)),
    'The correction must cite actual collected Pod, workload and log evidence');
  const records = collected(bundle, 'logs-checkout-current').data.text.split('\n').map(line => {
    try { return JSON.parse(line.slice(line.indexOf('{'))); } catch { return {}; }
  });
  assert(records.some(record => record.method === 'GET' && record.path === '/readyz' && record.status === 404) &&
    records.some(record => record.method === 'GET' && record.path === '/healthz' && record.status === 200),
  'Actual application logs do not establish the proposed readiness-path mismatch');
  assert(deployment.apiVersion === 'apps/v1' && deployment.kind === 'Deployment' &&
    deployment.metadata.namespace === TARGET.namespace && deployment.metadata.name === TARGET.name &&
    deployment.metadata.uid === target.uid && deployment.metadata.labels?.['demo.mas.dev/managed'] === 'true',
  'The live resource is outside the managed demonstration target');
  assert(typeof saved.templateHash === 'string' && canonicalTemplateHash(deployment.spec.template) === saved.templateHash,
    'The live workload template changed after evidence collection; collect new evidence');
  const containers = deployment.spec.template.spec.containers;
  const index = containers.findIndex(container => container.name === TARGET.container);
  assert(index >= 0 && containers[index].readinessProbe?.httpGet?.path === '/readyz' &&
    containers[index].livenessProbe?.httpGet?.path === '/healthz', 'The live probe preconditions no longer hold');
  const path = `/spec/template/spec/containers/${index}`;
  return [
    { op: 'test', path: '/metadata/uid', value: target.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: deployment.metadata.resourceVersion },
    { op: 'test', path: `${path}/name`, value: TARGET.container },
    { op: 'test', path: `${path}/readinessProbe/httpGet/path`, value: '/readyz' },
    { op: 'replace', path: `${path}/readinessProbe/httpGet/path`, value: '/healthz' },
  ];
}
function summary(deployment, now = Date.now) {
  const container = deployment.spec?.template?.spec?.containers?.find(item => item.name === TARGET.container);
  return { observedAt: new Date(now()).toISOString(), uid: deployment.metadata.uid, resourceVersion: deployment.metadata.resourceVersion,
    generation: deployment.metadata.generation, templateHash: canonicalTemplateHash(deployment.spec.template),
    readinessPath: container?.readinessProbe?.httpGet?.path, status: deployment.status };
}
export function recovered(deployment) {
  return deployment.status?.observedGeneration >= deployment.metadata.generation && deployment.spec?.replicas === 1 &&
    deployment.status?.updatedReplicas === 1 && deployment.status?.replicas === 1 &&
    deployment.status?.readyReplicas === 1 && deployment.status?.availableReplicas === 1;
}
export async function resolveIncident(snapshot, { kubectl, namespaceUID, enabled = false, delay = pause, timeoutMs = 120_000, now = Date.now,
  operationId, attemptId, beforePatch, isDefiniteRejection = () => false }) {
  const bundle = evidence(snapshot);
  const saved = collected(bundle, 'workload-deployment')?.data;
  const report = { version: 'mas-k8s-resolution/2', operationId, attemptId,
    effectOutcome: 'not_started', verificationOutcome: 'not_run', status: 'not-attempted', action: 'replace_readiness_probe_path',
    target: { namespace: TARGET.namespace, name: TARGET.name, uid: saved?.metadata?.uid ?? '' },
    recordedAt: new Date(now()).toISOString(), reason: '', patch: [], before: null, after: null, checks: [] };
  if (!enabled) { report.reason = 'Automatic readiness remediation has not been explicitly enabled.'; return report; }
  try {
    validatePracticalEvidence(snapshot);
    if (snapshot.run.output?.requires_human !== false || snapshot.run.output?.remediation?.action !== 'replace_readiness_probe_path') {
      report.reason = 'The agent requested engineer review or proposed no permitted correction.';
      return report;
    }
    const namespace = JSON.parse(await kubectl(['get', 'namespace', TARGET.namespace, '-o', 'json']));
    assert(namespaceUID && namespace.metadata.uid === namespaceUID, 'The configured namespace identity changed');
    const before = JSON.parse(await kubectl(['get', 'deployment', TARGET.name, '-o', 'json']));
    report.patch = admitReadinessPatch(snapshot, before);
    const expectedTemplate = structuredClone(before.spec.template);
    expectedTemplate.spec.containers.find(container => container.name === TARGET.container).readinessProbe.httpGet.path = '/healthz';
    const expectedHash = canonicalTemplateHash(expectedTemplate);
    report.before = { ...summary(before, now), namespaceUID, expectedTemplateHash: expectedHash };
    report.checks.push({ name: 'Admission', passed: true, detail: 'Managed identity, collected evidence and unchanged full template passed. Only the readiness path is admitted.' });
    // Shared execution semantics; all target, patch and verification policy
    // stays in this Kubernetes adapter. The controller supplies durable reserve.
    const execution = await executeGuardedOperation({ operationId, attemptId, admitted: report.patch,
      reserve: async () => {
        assert(typeof beforePatch === 'function', 'A durable effect reservation is required');
        await beforePatch(structuredClone(report));
      },
      execute: async patch => {
        const applied = JSON.parse(await kubectl(['patch', 'deployment', TARGET.name, '--type=json', '-p', JSON.stringify(patch), '-o', 'json']));
        assert(applied.metadata?.uid === before.metadata.uid &&
          applied.metadata?.resourceVersion && applied.metadata.resourceVersion !== before.metadata.resourceVersion &&
          applied.metadata.generation === before.metadata.generation + 1 &&
          canonicalTemplateHash(applied.spec?.template) === expectedHash,
        'The patch response did not acknowledge the exact admitted target and template');
        report.checks.push({ name: 'Patch applied', passed: true, detail: `Generation ${applied.metadata.generation}; JSON Patch UID, resource version, container and old path tests passed.` });
        return applied;
      },
      isDefiniteRejection,
      verify: async () => {
        const deadline = now() + timeoutMs;
        let after, pod, metrics;
        while (now() < deadline) {
          after = JSON.parse(await kubectl(['get', 'deployment', TARGET.name, '-o', 'json']));
          verifyAssert(after.metadata.uid === before.metadata.uid && canonicalTemplateHash(after.spec.template) === expectedHash,
            'Another actor changed the workload during verification');
          if (recovered(after)) {
            const replicasets = JSON.parse(await kubectl(['get', 'replicasets', '-l', 'app.kubernetes.io/name=mas-demo-checkout', '-o', 'json']));
            const ownerUIDs = new Set(replicasets.items.filter(item => item.metadata.ownerReferences?.some(
              owner => owner.controller === true && owner.kind === 'Deployment' && owner.uid === before.metadata.uid) &&
              item.spec.template.spec.containers.some(container => container.name === TARGET.container &&
                container.readinessProbe?.httpGet?.path === '/healthz')).map(item => item.metadata.uid));
            const pods = JSON.parse(await kubectl(['get', 'pods', '-l', 'app.kubernetes.io/name=mas-demo-checkout', '-o', 'json']));
            pod = pods.items.find(item => !item.metadata.deletionTimestamp && item.metadata.uid !== bundle.subject.uid &&
              item.metadata.ownerReferences?.some(owner => owner.controller === true && owner.kind === 'ReplicaSet' && ownerUIDs.has(owner.uid)) &&
              item.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True'));
            if (pod) {
              try {
                metrics = JSON.parse(await kubectl(['get', '--raw', `/apis/metrics.k8s.io/v1beta1/namespaces/${TARGET.namespace}/pods/${pod.metadata.name}`]));
                const timestamp = Date.parse(metrics.timestamp);
                if (metrics.metadata?.name === pod.metadata.name && metrics.metadata?.namespace === TARGET.namespace &&
                    Number.isFinite(timestamp) && timestamp >= Date.parse(pod.metadata.creationTimestamp) && timestamp <= now() + 5000 &&
                    now() - timestamp < 120_000 && typeof metrics.window === 'string' && metrics.window.length > 0 && metrics.containers?.some(container => container.name === TARGET.container &&
                      typeof container.usage?.cpu === 'string' && typeof container.usage?.memory === 'string')) break;
              } catch { /* A new running Pod needs its first metrics-server sampling interval. */ }
            }
          }
          metrics = undefined;
          await delay(2000);
        }
        assert(after && recovered(after) && pod && metrics, 'Recovery did not produce one updated Ready Pod with a fresh CPU/memory sample before the deadline');
        verifyAssert(pod.status.containerStatuses?.find(container => container.name === TARGET.container)?.restartCount === 0,
          'The replacement application restarted during recovery verification');
        const body = await kubectl(['get', '--raw', `/api/v1/namespaces/${TARGET.namespace}/services/${TARGET.name}:8081/proxy/`]);
        verifyAssert(body === APPLICATION_BODY, 'The Kubernetes Service application endpoint did not return the expected HTTP 200 response body');
        const initialPod = JSON.parse(await kubectl(['get', 'pod', pod.metadata.name, '-o', 'json']));
        const readyTransition = initialPod.status?.conditions?.find(condition => condition.type === 'Ready' && condition.status === 'True')?.lastTransitionTime;
        verifyAssert(initialPod.metadata.uid === pod.metadata.uid && !initialPod.metadata.deletionTimestamp &&
          initialPod.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True') &&
          initialPod.status.containerStatuses?.find(container => container.name === TARGET.container)?.restartCount === 0,
        'The replacement Pod changed or lost readiness before post-change evidence collection');
        assert(typeof readyTransition === 'string' && Number.isFinite(Date.parse(readyTransition)) && Date.parse(readyTransition) <= now() + 5000,
          'The replacement Pod has no usable Ready transition timestamp');
        const periodSeconds = before.spec.template.spec.containers.find(container => container.name === TARGET.container).readinessProbe.periodSeconds ?? 10;
        const observationMs = Math.max(10_000, periodSeconds * 2000);
        assert(Number.isInteger(periodSeconds) && periodSeconds > 0 && observationMs <= 30_000 && now() + observationMs < deadline,
          'The verification deadline cannot cover two readiness probe periods');
        const startedAt = new Date(now()).toISOString();
        await delay(observationMs);
        assert(now() - Date.parse(startedAt) >= observationMs, 'The post-change observation interval did not complete');
        report.verificationEvidence = await collectPostChangeEvidence(kubectl, pod, startedAt, now);
        const finalDeployment = JSON.parse(await kubectl(['get', 'deployment', TARGET.name, '-o', 'json']));
        const finalPod = JSON.parse(await kubectl(['get', 'pod', pod.metadata.name, '-o', 'json']));
        verifyAssert(finalDeployment.metadata.uid === before.metadata.uid && recovered(finalDeployment) &&
          canonicalTemplateHash(finalDeployment.spec.template) === expectedHash && finalPod.metadata.uid === pod.metadata.uid &&
          !finalPod.metadata.deletionTimestamp && finalPod.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True' &&
            condition.lastTransitionTime === readyTransition) &&
          finalPod.status.containerStatuses?.find(container => container.name === TARGET.container)?.restartCount === 0,
        'The workload changed or lost readiness while checking the application endpoint');
        verifyPostChangeEvidence(report.verificationEvidence);
        after = finalDeployment;
        pod = finalPod;
        report.after = { ...summary(after, now), pod: { name: pod.metadata.name, uid: pod.metadata.uid,
          ready: true, readyTransitionTime: readyTransition, restarts: pod.status.containerStatuses?.find(container => container.name === TARGET.container)?.restartCount },
        metrics: { timestamp: metrics.timestamp, window: metrics.window, containers: metrics.containers },
        application: { source: 'Kubernetes Service API proxy HTTP GET /', status: 200, body } };
        report.checks.push({ name: 'Rollout', passed: true, detail: 'Observed generation, one updated/ready/available replica and no old replicas.' },
          { name: 'Template scope', passed: true, detail: 'The full workload template differs only in readinessProbe.httpGet.path.' },
          { name: 'New Pod ready', passed: true, detail: `Replacement Pod ${pod.metadata.name} is Ready.` },
          { name: 'Functional HTTP', passed: true, detail: 'The application through the Kubernetes Service API proxy returned HTTP 200 and the expected checkout body.' },
          { name: 'Fresh metrics', passed: true, detail: `Actual replacement-Pod CPU/memory sample at ${metrics.timestamp} over ${metrics.window}.` },
          { name: 'Post-change logs', passed: true, detail: 'Retained timestamped replacement checkout records show GET /healthz 200 and no observed failing health endpoint in the bounded window.' },
          { name: 'Post-change events', passed: true, detail: `Retained replacement-Pod Events show no readiness Warning occurrence from ${report.verificationEvidence.window.startedAt} to ${report.verificationEvidence.window.endedAt}.` });
      return report.after;
      },
    });
    report.effectOutcome = execution.effectOutcome;
    report.verificationOutcome = execution.verificationOutcome;
    report.status = execution.verificationOutcome === 'passed' ? 'verified' : 'failed';
    report.reason = execution.verificationOutcome === 'passed'
      ? 'The agent diagnosis led to a policy-admitted readiness correction and objectively verified application recovery.'
      : execution.error ?? 'The operation did not establish recovery.';
    if (execution.error) report.checks.push({ name: 'Execution outcome', passed: false, detail: execution.error });
  } catch (error) {
    report.status = 'failed';
    report.reason = error.message;
    report.checks.push({ name: 'Recovery policy', passed: false, detail: error.message });
  }
  report.recordedAt = new Date(now()).toISOString();
  return report;
}
