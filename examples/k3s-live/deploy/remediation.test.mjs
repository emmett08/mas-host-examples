import assert from 'node:assert/strict';
import test from 'node:test';
import { admitReadinessPatch, APPLICATION_BODY, canonicalTemplateHash, recovered, resolveIncident, validatePracticalEvidence } from './remediation.mjs';

function candidate() {
  const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'mas-demo-checkout', namespace: 'mas-demo',
    uid: 'deployment-uid', resourceVersion: 'new-status-version', generation: 2, labels: { 'demo.mas.dev/managed': 'true' } },
  spec: { replicas: 1, template: { metadata: { labels: { app: 'checkout' } }, spec: { containers: [{ name: 'checkout', image: 'demo:fixed',
    readinessProbe: { httpGet: { path: '/readyz', port: 8081 } }, livenessProbe: { httpGet: { path: '/healthz', port: 8081 } } }] } } }, status: {} };
  const collected = (id, data) => ({ id, kind: id, status: 'collected', observedAt: new Date().toISOString(), data });
  const bundle = { version: 'mas-k8s-evidence/1', capturedAt: new Date().toISOString(), subject: { namespace: 'mas-demo', name: 'original-pod', uid: 'original-pod-uid' },
    items: [collected('pod', { metadata: { name: 'original-pod', uid: 'original-pod-uid', ownerReferences: [{ kind: 'ReplicaSet', controller: true, uid: 'original-rs' }] },
      spec: structuredClone(deployment.spec.template.spec), status: { conditions: [{ type: 'Ready', status: 'False' }] } }),
      collected('workload-replicaset', { metadata: { uid: 'original-rs', ownerReferences: [{ kind: 'Deployment', controller: true, uid: 'deployment-uid' }] } }),
      collected('events', [{ type: 'Warning', reason: 'Unhealthy', involvedObject: { uid: 'original-pod-uid' } }]),
      collected('logs-checkout-current', { text: '{"method":"GET","path":"/readyz","status":404}\n{"method":"GET","path":"/healthz","status":200}' }),
      collected('metrics', { metadata: { name: 'original-pod', namespace: 'mas-demo' }, timestamp: new Date().toISOString(), window: '15s', containers: [{ name: 'checkout', usage: { cpu: '10n', memory: '10Ki' } }] }),
      collected('workload-deployment', { ...structuredClone(deployment), metadata: { ...deployment.metadata, resourceVersion: 'recorded-version' },
        templateHash: canonicalTemplateHash(deployment.spec.template) })] };
  const output = { requires_human: false, remediation: { action: 'replace_readiness_probe_path',
    target: { kind: 'Deployment', name: 'mas-demo-checkout', namespace: 'mas-demo', uid: 'deployment-uid',
      resource_version: 'recorded-version', container: 'checkout' }, current_path: '/readyz', proposed_path: '/healthz',
    evidence_ids: ['pod', 'workload-deployment', 'logs-checkout-current'] } };
  return { deployment, snapshot: { run: { input: { incident: { evidence: bundle } }, output } } };
}

test('practical recording requires actual logs, owner specs and timestamped CPU/memory evidence', () => {
  const { snapshot } = candidate();
  assert.doesNotThrow(() => validatePracticalEvidence(snapshot));
  snapshot.run.input.incident.evidence.items.find(item => item.id === 'metrics').status = 'unavailable';
  assert.throws(() => validatePracticalEvidence(snapshot), /collected metrics/);
});

test('admission allows refreshed status resourceVersion only after full template and identity match', () => {
  const { deployment, snapshot } = candidate();
  const patch = admitReadinessPatch(snapshot, deployment);
  assert.equal(patch.filter(item => item.op === 'replace').length, 1);
  assert.deepEqual(patch.at(-1), { op: 'replace', path: '/spec/template/spec/containers/0/readinessProbe/httpGet/path', value: '/healthz' });
  assert.equal(patch[1].value, 'new-status-version');
  assert.equal(canonicalTemplateHash({ b: 1, a: { d: 2, c: 3 } }), canonicalTemplateHash({ a: { c: 3, d: 2 }, b: 1 }));
});

test('admission rejects human review, arbitrary targets, unsupported evidence and any unrelated template change', () => {
  const changes = [
    ({ snapshot }) => { snapshot.run.output.requires_human = true; },
    ({ snapshot }) => { snapshot.run.output.remediation.proposed_path = '/execute'; },
    ({ snapshot }) => { snapshot.run.output.remediation.target.namespace = 'production'; },
    ({ snapshot }) => { snapshot.run.output.remediation.target.uid = 'other-uid'; },
    ({ snapshot }) => { snapshot.run.output.remediation.evidence_ids.push('invented-log'); },
    ({ deployment }) => { deployment.metadata.labels['demo.mas.dev/managed'] = 'false'; },
    ({ deployment }) => { deployment.spec.template.spec.containers[0].image = 'other-image'; },
  ];
  for (const change of changes) {
    const value = candidate(); change(value);
    assert.throws(() => admitReadinessPatch(value.snapshot, value.deployment));
  }
});

test('coherence rejects inverse logs, unrelated owners, healthy original Pods and absent or wrong-identity measurements', () => {
  const changes = [
    item => { item('logs-checkout-current').data.text = '{"method":"GET","path":"/readyz","status":200}\n{"method":"GET","path":"/healthz","status":404}'; },
    item => { item('pod').data.metadata.ownerReferences[0].uid = 'unrelated-rs'; },
    item => { item('pod').data.status.conditions[0].status = 'True'; },
    item => { item('events').data = []; },
    item => { item('metrics').data.metadata.name = 'another-pod'; },
    item => { item('metrics').data.timestamp = new Date(Date.now() + 60_000).toISOString(); },
  ];
  for (const change of changes) {
    const { snapshot, deployment } = candidate();
    change(id => snapshot.run.input.incident.evidence.items.find(item => item.id === id));
    assert.throws(() => admitReadinessPatch(snapshot, deployment));
  }
});

test('disabled or engineer-review decisions never invoke kubectl mutations', async () => {
  const { snapshot } = candidate();
  const kubectl = async () => { throw new Error('No Kubernetes API calls expected'); };
  assert.equal((await resolveIncident(snapshot, { kubectl })).status, 'not-attempted');
  snapshot.run.output.requires_human = true;
  assert.equal((await resolveIncident(snapshot, { kubectl, enabled: true })).status, 'not-attempted');
});

test('resolution retains exact admitted patch and independently verifies fresh Pod metrics and functional HTTP', async () => {
  const { snapshot, deployment } = candidate();
  let patched = false;
  let reservation;
  const seen = [];
  const kubectl = async args => {
    seen.push(args);
    if (args[0] === 'get' && args[1] === 'namespace') return JSON.stringify({ metadata: { uid: 'namespace-uid' } });
    if (args[0] === 'patch') {
      assert.ok(reservation, 'The durable reservation must complete before the API mutation');
      assert.deepEqual(JSON.parse(args[5]), reservation.patch);
      patched = true;
      deployment.spec.template.spec.containers[0].readinessProbe.httpGet.path = '/healthz';
      deployment.metadata.generation = 3;
      deployment.status = { observedGeneration: 3, updatedReplicas: 1, replicas: 1, readyReplicas: 1, availableReplicas: 1 };
      return JSON.stringify(deployment);
    }
    if (args[1] === 'deployment') return JSON.stringify(deployment);
    if (args[1] === 'replicasets') return JSON.stringify({ items: [{ metadata: { uid: 'new-rs', ownerReferences: [{ kind: 'Deployment', controller: true, uid: 'deployment-uid' }] },
      spec: { template: deployment.spec.template } }] });
    const pod = { metadata: { name: 'new-pod', uid: 'new-pod-uid',
      creationTimestamp: new Date(Date.now() - 60_000).toISOString(), ownerReferences: [{ kind: 'ReplicaSet', controller: true, uid: 'new-rs' }] },
    status: { conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'checkout', restartCount: 0 }] } };
    if (args[1] === 'pods') return JSON.stringify({ items: [pod] });
    if (args[1] === 'pod') return JSON.stringify(pod);
    if (args[1] === '--raw' && args[2].includes('/metrics.k8s.io/')) return JSON.stringify({ metadata: { name: 'new-pod', namespace: 'mas-demo' }, timestamp: new Date().toISOString(), window: '15s',
      containers: [{ name: 'checkout', usage: { cpu: '8n', memory: '30Mi' } }] });
    if (args[1] === '--raw' && args[2].endsWith('/proxy/')) return APPLICATION_BODY;
    throw new Error(`Unexpected kubectl ${args.join(' ')}`);
  };
  const report = await resolveIncident(snapshot, { kubectl, namespaceUID: 'namespace-uid', enabled: true,
    beforePatch: async prepared => {
      assert.equal(patched, false);
      assert.equal(prepared.checks[0].name, 'Admission');
      assert.equal(prepared.checks[0].passed, true);
      assert.equal(prepared.before.uid, 'deployment-uid');
      await Promise.resolve();
      reservation = prepared;
    } });
  assert.equal(patched, true);
  assert.equal(report.status, 'verified');
  assert.equal(report.after.pod.uid, 'new-pod-uid');
  assert.equal(report.after.application.status, 200);
  assert.equal(report.patch.at(-1).value, '/healthz');
  assert.ok(report.checks.every(check => check.passed));
  assert.equal(seen.filter(args => args[0] === 'patch').length, 1);
  assert.ok(JSON.stringify(report).length < 16 * 1024);
});

test('a rejected or uncertain durable reservation prevents every Kubernetes mutation', async () => {
  for (const reason of ['reservation CAS conflict', 'reservation acknowledgement lost']) {
    const { snapshot, deployment } = candidate();
    let mutations = 0;
    let hooks = 0;
    const report = await resolveIncident(snapshot, { namespaceUID: 'namespace-uid', enabled: true,
      kubectl: async args => {
        if (args[0] !== 'get') { mutations++; throw new Error('Mutation must never execute'); }
        return JSON.stringify(args[1] === 'namespace' ? { metadata: { uid: 'namespace-uid' } } : deployment);
      },
      beforePatch: async prepared => {
        hooks++;
        assert.equal(prepared.patch.length, 5);
        assert.equal(prepared.before.readinessPath, '/readyz');
        assert.equal(prepared.checks[0].passed, true);
        // The hook receives its own copy, preserving the admission result.
        prepared.patch.length = 0;
        await Promise.resolve();
        throw new Error(reason);
      } });
    assert.equal(hooks, 1);
    assert.equal(mutations, 0);
    assert.equal(report.status, 'failed');
    assert.equal(report.reason, reason);
    assert.equal(report.patch.length, 5);
    assert.equal(report.checks.some(check => check.name === 'Patch applied'), false);
  }
});

test('namespace identity changes fail before mutation and success requires observed generation and one updated replica', async () => {
  const { snapshot, deployment } = candidate();
  const report = await resolveIncident(snapshot, { enabled: true, namespaceUID: 'recorded-namespace', kubectl: async args => {
    assert.equal(args[0], 'get'); return JSON.stringify({ metadata: { uid: 'different-namespace' } });
  } });
  assert.equal(report.status, 'failed');
  assert.equal(report.patch.length, 0);
  assert.equal(recovered(deployment), false);
});

test('uncertain patch responses and conflicts never retry or claim verified recovery', async () => {
  for (const failure of ['lost-after-apply', 'malformed-after-apply', 'stale-resource-version']) {
    const { snapshot, deployment } = candidate();
    let patchCalls = 0;
    let applied = false;
    const kubectl = async args => {
      if (args[1] === 'namespace') return JSON.stringify({ metadata: { uid: 'namespace-uid' } });
      if (args[0] === 'get' && args[1] === 'deployment') return JSON.stringify(deployment);
      if (args[0] === 'patch') {
        patchCalls++;
        if (failure === 'stale-resource-version') throw new Error('JSON Patch resourceVersion test failed: conflict');
        applied = true;
        deployment.spec.template.spec.containers[0].readinessProbe.httpGet.path = '/healthz';
        if (failure === 'lost-after-apply') throw new Error('Patch response connection lost after server applied it');
        return '{malformed';
      }
      throw new Error('Uncertain mutations must not proceed to recovery checks');
    };
    const report = await resolveIncident(snapshot, { kubectl, namespaceUID: 'namespace-uid', enabled: true });
    assert.equal(report.status, 'failed', failure);
    assert.equal(patchCalls, 1, failure);
    assert.equal(applied, failure !== 'stale-resource-version', failure);
    assert.equal(report.after, null, failure);
    assert.equal(report.checks.some(check => check.name === 'Functional HTTP' && check.passed), false, failure);
  }
});

test('a wrong HTTP response, incomplete rollout or absent metrics cannot establish verified recovery', async () => {
  for (const failure of ['wrong-endpoint', 'partial-rollout', 'metrics-unavailable']) {
    const { snapshot, deployment } = candidate();
    let patchCalls = 0;
    let bodyCalls = 0;
    const kubectl = async args => {
      if (args[1] === 'namespace') return JSON.stringify({ metadata: { uid: 'namespace-uid' } });
      if (args[0] === 'patch') {
        patchCalls++;
        deployment.spec.template.spec.containers[0].readinessProbe.httpGet.path = '/healthz';
        deployment.metadata.generation = 3;
        deployment.status = { observedGeneration: 3, updatedReplicas: 1, replicas: 1,
          readyReplicas: failure === 'partial-rollout' ? 0 : 1, availableReplicas: failure === 'partial-rollout' ? 0 : 1 };
        return JSON.stringify(deployment);
      }
      if (args[1] === 'deployment') return JSON.stringify(deployment);
      if (args[1] === 'replicasets') return JSON.stringify({ items: [{ metadata: { uid: 'new-rs',
        ownerReferences: [{ kind: 'Deployment', controller: true, uid: 'deployment-uid' }] }, spec: { template: deployment.spec.template } }] });
      if (args[1] === 'pods') return JSON.stringify({ items: [{ metadata: { name: 'new-pod', uid: 'new-pod-uid',
        creationTimestamp: new Date(Date.now() - 60_000).toISOString(), ownerReferences: [{ kind: 'ReplicaSet', controller: true, uid: 'new-rs' }] },
      status: { conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'checkout', restartCount: 0 }] } }] });
      if (args[1] === '--raw' && args[2].includes('/metrics.k8s.io/')) {
        if (failure === 'metrics-unavailable') throw new Error('metrics-server has no measurement');
        return JSON.stringify({ metadata: { name: 'new-pod', namespace: 'mas-demo' }, timestamp: new Date().toISOString(), window: '15s',
          containers: [{ name: 'checkout', usage: { cpu: '8n', memory: '30Mi' } }] });
      }
      if (args[1] === '--raw' && args[2].endsWith('/proxy/')) { bodyCalls++; return 'some other application'; }
      throw new Error(`Unexpected kubectl ${args.join(' ')}`);
    };
    const report = await resolveIncident(snapshot, { kubectl, namespaceUID: 'namespace-uid', enabled: true,
      timeoutMs: 10, delay: async () => {} });
    assert.equal(report.status, 'failed', failure);
    assert.equal(patchCalls, 1, failure);
    assert.equal(report.after, null, failure);
    assert.equal(bodyCalls, failure === 'wrong-endpoint' ? 1 : 0, failure);
  }
});
