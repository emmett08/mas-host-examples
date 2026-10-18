import test from 'node:test';
import assert from 'node:assert/strict';
import { observeOperationalTarget, type OperationalTargetGrant } from '../deploy/operational.js';
import type { KubernetesTransport } from '../deploy/trial.js';
const image = `registry.invalid/app@sha256:${'a'.repeat(64)}`;
const source = 'b'.repeat(40);
const grant: OperationalTargetGrant = { namespace: 'application', deployment: 'quote', deploymentUid: 'deployment-uid', container: 'application',
  pod: 'quote-pod', podUid: 'pod-uid', imageDigest: image, sourceCommit: source, sourceAnnotation: 'mas.dev/source-commit', runtimeEnvironment: {} };
function fixture() {
  const objects: Record<string, any> = {
    deployment: { metadata: { namespace: grant.namespace, name: grant.deployment, uid: grant.deploymentUid, resourceVersion: '12', generation: 3, annotations: { hidden: 'never expose' } },
      spec: { template: { metadata: { annotations: { 'mas.dev/source-commit': source } }, spec: { containers: [{ name: 'application', image }] } } } },
    pod: { metadata: { namespace: grant.namespace, name: grant.pod, uid: grant.podUid, annotations: { 'mas.dev/source-commit': source },
      ownerReferences: [{ controller: true, name: 'quote-replicaset', kind: 'ReplicaSet', uid: 'replica-uid' }] },
      spec: { containers: [{ name: 'application', image }], nodeName: 'node-1' }, status: { containerStatuses: [{ name: 'application', imageID: image }] } },
    replicaset: { metadata: { namespace: grant.namespace, name: 'quote-replicaset', uid: 'replica-uid', ownerReferences: [{ controller: true, kind: 'Deployment', name: grant.deployment, uid: grant.deploymentUid }] } },
    event: { metadata: { uid: 'event-uid' }, involvedObject: { uid: grant.podUid }, reason: 'Unhealthy', type: 'Warning' },
  };
  const reads: string[] = [];
  const kube = { get: async (kind: string, name: string, namespace: string) => { reads.push(`${namespace}:${kind}:${name}`); return structuredClone(objects[kind]); } } as unknown as KubernetesTransport;
  return { objects, reads, kube };
}
test('operational collector binds exact trigger, release, Pod, image and source without disclosing raw configuration', async () => {
  const { kube, reads } = fixture();
  const result = await observeOperationalTarget(kube, { ...grant, event: { name: 'quote-failed', uid: 'event-uid' } });
  assert.equal(result.sourceCommit, source); assert.equal(result.imageDigest, image); assert.equal(result.trigger.kind, 'kubernetes-event');
  assert.equal(result.replicaSetUid, 'replica-uid'); assert(!JSON.stringify(result).includes('never expose'));
  assert.deepEqual(reads.sort(), ['application:deployment:quote', 'application:pod:quote-pod', 'application:replicaset:quote-replicaset', 'application:event:quote-failed'].sort());
});
test('new source, wrong Pod owner, mismatched event and hidden external environment are rejected', async () => {
  for (const change of [
    (x: any) => { x.deployment.spec.template.metadata.annotations['mas.dev/source-commit'] = 'c'.repeat(40); },
    (x: any) => { x.replicaset.metadata.ownerReferences[0].uid = 'other-deployment'; },
    (x: any) => { x.event.involvedObject.uid = 'other-pod'; },
    (x: any) => { x.pod.spec.containers[0].envFrom = [{ secretRef: { name: 'secret' } }]; },
    (x: any) => { x.pod.spec.containers[0].volumeMounts = [{ name: 'shared', mountPath: '/data' }]; },
    (x: any) => { x.deployment.spec.template.spec.volumes = [{ name: 'shared', persistentVolumeClaim: { claimName: 'shared' } }]; },
    (x: any) => { x.pod.spec.initContainers = [{ name: 'prepare', image: 'uncontrolled' }]; },
    (x: any) => { x.pod.spec.containers.push({ name: 'sidecar', image: 'uncontrolled' }); },
    (x: any) => { x.pod.status.containerStatuses[0].imageID = `registry.invalid/app@sha256:${'d'.repeat(64)}`; },
  ]) {
    const { kube, objects } = fixture(); change(objects);
    await assert.rejects(observeOperationalTarget(kube, { ...grant, event: { name: 'quote-failed', uid: 'event-uid' } }));
  }
});
test('publication recheck allows status-only resource versions but rejects changed release generation and Pod configuration', async () => {
  const { kube, objects } = fixture(); const first = await observeOperationalTarget(kube, grant);
  objects.deployment.metadata.resourceVersion = '13';
  assert.equal((await observeOperationalTarget(kube, grant, first)).resourceVersion, '13');
  objects.deployment.metadata.generation = 4;
  await assert.rejects(observeOperationalTarget(kube, grant, first), /changed since/);
  objects.deployment.metadata.generation = 3; objects.pod.spec.securityContext = { privileged: true };
  await assert.rejects(observeOperationalTarget(kube, grant, first), /changed since/);
});
