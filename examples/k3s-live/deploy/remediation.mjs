// A narrow external tool policy. Model commands and arbitrary patches never execute.
import { createHash } from 'node:crypto';

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
function summary(deployment) {
  const container = deployment.spec?.template?.spec?.containers?.find(item => item.name === TARGET.container);
  return { observedAt: new Date().toISOString(), uid: deployment.metadata.uid, resourceVersion: deployment.metadata.resourceVersion,
    generation: deployment.metadata.generation, templateHash: canonicalTemplateHash(deployment.spec.template),
    readinessPath: container?.readinessProbe?.httpGet?.path, status: deployment.status };
}
export function recovered(deployment) {
  return deployment.status?.observedGeneration >= deployment.metadata.generation && deployment.spec?.replicas === 1 &&
    deployment.status?.updatedReplicas === 1 && deployment.status?.replicas === 1 &&
    deployment.status?.readyReplicas === 1 && deployment.status?.availableReplicas === 1;
}
export async function resolveIncident(snapshot, { kubectl, namespaceUID, enabled = false, delay = pause, timeoutMs = 120_000,
  beforePatch = async () => {} }) {
  const bundle = evidence(snapshot);
  const saved = collected(bundle, 'workload-deployment')?.data;
  const report = { version: 'mas-k8s-resolution/1', status: 'not-attempted', action: 'replace_readiness_probe_path',
    target: { namespace: TARGET.namespace, name: TARGET.name, uid: saved?.metadata?.uid ?? '' },
    recordedAt: new Date().toISOString(), reason: '', patch: [], before: null, after: null, checks: [] };
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
    report.before = summary(before);
    report.checks.push({ name: 'Admission', passed: true, detail: 'Managed identity, collected evidence and unchanged full template passed. Only the readiness path is admitted.' });
    // The controller must durably reserve this exact admitted mutation before
    // contacting Kubernetes. Failure or an uncertain reservation never patches.
    await beforePatch(structuredClone(report));
    const applied = JSON.parse(await kubectl(['patch', 'deployment', TARGET.name, '--type=json', '-p', JSON.stringify(report.patch), '-o', 'json']));
    report.checks.push({ name: 'Patch applied', passed: true, detail: `Generation ${applied.metadata.generation}; JSON Patch UID, resource version, container and old path tests passed.` });
    const expectedTemplate = structuredClone(before.spec.template);
    expectedTemplate.spec.containers.find(container => container.name === TARGET.container).readinessProbe.httpGet.path = '/healthz';
    const expectedHash = canonicalTemplateHash(expectedTemplate);
    const deadline = Date.now() + timeoutMs;
    let after, pod, metrics;
    while (Date.now() < deadline) {
      after = JSON.parse(await kubectl(['get', 'deployment', TARGET.name, '-o', 'json']));
      assert(after.metadata.uid === before.metadata.uid && canonicalTemplateHash(after.spec.template) === expectedHash,
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
                Number.isFinite(timestamp) && timestamp >= Date.parse(pod.metadata.creationTimestamp) && timestamp <= Date.now() + 5000 &&
                Date.now() - timestamp < 120_000 && typeof metrics.window === 'string' && metrics.window.length > 0 && metrics.containers?.some(container => container.name === TARGET.container &&
                  typeof container.usage?.cpu === 'string' && typeof container.usage?.memory === 'string')) break;
          } catch { /* A new running Pod needs its first metrics-server sampling interval. */ }
        }
      }
      metrics = undefined;
      await delay(2000);
    }
    assert(after && recovered(after) && pod && metrics, 'Recovery did not produce one updated Ready Pod with a fresh CPU/memory sample before the deadline');
    assert(pod.status.containerStatuses?.find(container => container.name === TARGET.container)?.restartCount === 0,
      'The replacement application restarted during recovery verification');
    const body = await kubectl(['get', '--raw', `/api/v1/namespaces/${TARGET.namespace}/services/${TARGET.name}:8081/proxy/`]);
    assert(body === APPLICATION_BODY, 'The Kubernetes Service application endpoint did not return the expected HTTP 200 response body');
    const finalDeployment = JSON.parse(await kubectl(['get', 'deployment', TARGET.name, '-o', 'json']));
    const finalPod = JSON.parse(await kubectl(['get', 'pod', pod.metadata.name, '-o', 'json']));
    assert(finalDeployment.metadata.uid === before.metadata.uid && recovered(finalDeployment) &&
      canonicalTemplateHash(finalDeployment.spec.template) === expectedHash && finalPod.metadata.uid === pod.metadata.uid &&
      !finalPod.metadata.deletionTimestamp && finalPod.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True') &&
      finalPod.status.containerStatuses?.find(container => container.name === TARGET.container)?.restartCount === 0,
    'The workload changed or lost readiness while checking the application endpoint');
    after = finalDeployment;
    pod = finalPod;
    report.after = { ...summary(after), pod: { name: pod.metadata.name, uid: pod.metadata.uid,
      ready: true, restarts: pod.status.containerStatuses?.find(container => container.name === TARGET.container)?.restartCount },
    metrics: { timestamp: metrics.timestamp, window: metrics.window, containers: metrics.containers },
    application: { source: 'Kubernetes Service API proxy HTTP GET /', status: 200, body } };
    report.checks.push({ name: 'Rollout', passed: true, detail: 'Observed generation, one updated/ready/available replica and no old replicas.' },
      { name: 'Template scope', passed: true, detail: 'The full workload template differs only in readinessProbe.httpGet.path.' },
      { name: 'New Pod ready', passed: true, detail: `Replacement Pod ${pod.metadata.name} is Ready.` },
      { name: 'Functional HTTP', passed: true, detail: 'The application through the Kubernetes Service API proxy returned HTTP 200 and the expected checkout body.' },
      { name: 'Fresh metrics', passed: true, detail: `Actual replacement-Pod CPU/memory sample at ${metrics.timestamp} over ${metrics.window}.` });
    report.status = 'verified';
    report.reason = 'The agent diagnosis led to a policy-admitted readiness correction and objectively verified application recovery.';
  } catch (error) {
    report.status = 'failed';
    report.reason = error.message;
    report.checks.push({ name: 'Recovery policy', passed: false, detail: error.message });
  }
  report.recordedAt = new Date().toISOString();
  return report;
}
