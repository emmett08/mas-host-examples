import test from 'node:test';
import assert from 'node:assert/strict';
import { KubernetesTrial, type KubernetesTransport, type TargetSnapshot, type TrialSpec } from '../deploy/trial.js';
import { RejectedEffect, UnknownEffect, type EffectRecord, type EffectStore, type Json } from '../deploy/effects.js';
class Store implements EffectStore {
  records = new Map<string, EffectRecord>();
  get(id: string) { return this.records.get(id); }
  unresolved(target: string) { return [...this.records.values()].filter(record => record.target === target && ['intended', 'unknown'].includes(record.status)); }
  intend(record: EffectRecord) { assert.equal(this.unresolved(record.target).length, 0); this.records.set(record.operationId, record); }
  settle(id: string, status: EffectRecord['status'], receipt?: Json) { this.records.set(id, { ...this.records.get(id)!, status, ...(receipt === undefined ? {} : { receipt }) }); }
}
const spec: TrialSpec = { namespace: 'mas-repair-control', deployment: 'quote', owner: 'incident', runId: 'control', stage: 'candidate',
  imageDigest: `example/app@sha256:${'a'.repeat(64)}`, candidateTreeSha256: 'b'.repeat(64), requirementsSha256: 'c'.repeat(64),
  testsSha256: 'd'.repeat(64), environmentSha256: 'e'.repeat(64), configuration: {}, port: 8080 };
const expected: TargetSnapshot = { namespace: spec.namespace, name: spec.deployment, uid: 'uid', resourceVersion: '741', owner: spec.owner,
  imageDigest: `example/app@sha256:${'f'.repeat(64)}`, candidateTreeSha256: '0'.repeat(64) };
const identity = { operationId: 'incident.replace', invocationId: 'host-effect', attemptId: 'process' };
/** Narrow RFC6902 API control, including Kubernetes omission of empty env.
 * No application repair output is scripted here. */
class NormalizingApi {
  document: any = { metadata: { namespace: expected.namespace, name: expected.name, uid: expected.uid, resourceVersion: expected.resourceVersion,
    annotations: { 'mas.dev/owner': expected.owner, 'mas.dev/candidate': expected.candidateTreeSha256 } },
    spec: { template: { metadata: { annotations: {} }, spec: { containers: [{ name: 'application', image: expected.imageDigest }] } } } };
  patches: any[][] = []; loseResponse = false;
  async get() { return structuredClone(this.document); }
  async patch(_kind: string, _name: string, _namespace: string, operations: any[]) {
    this.patches.push(structuredClone(operations));
    const changed = structuredClone(this.document);
    for (const operation of operations) {
      const path = operation.path.slice(1).split('/').map((part: string) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
      const key = path.pop(), parent = path.reduce((value: any, part: string) => value?.[part], changed);
      if (!parent || !['test', 'add', 'replace'].includes(operation.op)) throw new Error('Invalid JSON Patch control');
      if (operation.op !== 'add' && !Object.hasOwn(parent, key)) throw new Error(`JSON Patch ${operation.op} requires existing member ${operation.path}`);
      if (operation.op === 'test') assert.deepEqual(parent[key], operation.value, 'atomic JSON Patch precondition');
      else parent[key] = structuredClone(operation.value);
    }
    if (!changed.spec.template.spec.containers[0].env?.length) delete changed.spec.template.spec.containers[0].env;
    changed.metadata.resourceVersion = String(Number(changed.metadata.resourceVersion) + 1); this.document = changed;
    if (this.loseResponse) { this.loseResponse = false; throw new Error('Transport closed after API commit'); }
    return structuredClone(changed);
  }
}
test('normalized Deployment with omitted env accepts candidate replacement and retains all atomic identity tests', async () => {
  const api = new NormalizingApi(), store = new Store(), trial = new KubernetesTrial(api as unknown as KubernetesTransport, store);
  assert(!Object.hasOwn(api.document.spec.template.spec.containers[0], 'env'));
  const first = await trial.replace(identity, spec, expected);
  assert.equal(first.imageDigest, spec.imageDigest); assert.equal(first.resourceVersion, '742');
  assert.deepEqual(api.patches[0]!.filter(op => op.op === 'test').map(op => [op.path, op.value]), [
    ['/metadata/uid', expected.uid], ['/metadata/resourceVersion', expected.resourceVersion],
    ['/metadata/annotations/mas.dev~1owner', expected.owner], ['/spec/template/spec/containers/0/image', expected.imageDigest],
  ]);
  const configured = { ...spec, configuration: { BUSINESS_REGION: 'GB' } };
  const second = await trial.replace({ ...identity, operationId: 'incident.configure', invocationId: 'host-effect-configure' }, configured, first);
  assert.deepEqual(api.document.spec.template.spec.containers[0].env, [{ name: 'BUSINESS_REGION', value: 'GB' }]);
  await trial.replace({ ...identity, operationId: 'incident.clear', invocationId: 'host-effect-clear' }, spec, second);
  assert(!Object.hasOwn(api.document.spec.template.spec.containers[0], 'env'));
});
test('known stale revision rejects before patch while lost patch response stays unknown until exact reconciliation', async () => {
  const stale = new NormalizingApi(), rejected = new Store(); stale.document.metadata.resourceVersion = '742';
  await assert.rejects(new KubernetesTrial(stale as unknown as KubernetesTransport, rejected).replace(identity, spec, expected), RejectedEffect);
  assert.equal(stale.patches.length, 0); assert.equal(rejected.get(identity.operationId)?.status, 'rejected');
  const api = new NormalizingApi(), store = new Store(), trial = new KubernetesTrial(api as unknown as KubernetesTransport, store); api.loseResponse = true;
  await assert.rejects(trial.replace(identity, spec, expected), UnknownEffect);
  assert.equal(store.get(identity.operationId)?.status, 'unknown'); assert.equal(api.patches.length, 1);
  const recovered = await trial.replace(identity, spec, expected);
  assert.equal(recovered.imageDigest, spec.imageDigest); assert.equal(store.get(identity.operationId)?.status, 'completed');
  assert.equal(api.patches.length, 1, 'exact observed operation and invocation reconcile without a repeated mutation');
});
