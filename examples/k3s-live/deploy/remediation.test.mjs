import assert from 'node:assert/strict';
import test from 'node:test';
import { admitReadinessPatch, APPLICATION_BODY, canonicalTemplateHash, recovered, resolveIncident as executeIncident, validatePracticalEvidence } from './remediation.mjs';
import { validatePostChangeEvidence } from '../shared/post-change-evidence.mjs';
const resolveIncident = (snapshot, options) => executeIncident(snapshot, { operationId: 'test-operation', attemptId: 'test-attempt', beforePatch: async () => {}, ...options });

function candidate(approach = 'collected') {
  const name = approach === 'mcp' ? 'mas-demo-checkout-mcp' : 'mas-demo-checkout';
  const currentPath = approach === 'mcp' ? '/ready' : '/readyz';
  const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: 'mas-demo',
    uid: 'deployment-uid', resourceVersion: 'new-status-version', generation: 2, labels: { 'demo.mas.dev/managed': 'true' } },
  spec: { replicas: 1, template: { metadata: { labels: { app: 'checkout' } }, spec: { containers: [{ name: 'checkout', image: 'demo:fixed',
    readinessProbe: { httpGet: { path: currentPath, port: 8081 } }, livenessProbe: { httpGet: { path: '/healthz', port: 8081 } } }] } } }, status: {} };
  const collected = (id, data) => ({ id, kind: id, status: 'collected', observedAt: new Date().toISOString(), data });
  const bundle = { version: 'mas-k8s-evidence/1', capturedAt: new Date().toISOString(), subject: { namespace: 'mas-demo', name: 'original-pod', uid: 'original-pod-uid' },
    items: [collected('pod', { metadata: { name: 'original-pod', uid: 'original-pod-uid', ownerReferences: [{ kind: 'ReplicaSet', controller: true, uid: 'original-rs' }] },
      spec: structuredClone(deployment.spec.template.spec), status: { conditions: [{ type: 'Ready', status: 'False' }] } }),
      collected('workload-replicaset', { metadata: { uid: 'original-rs', ownerReferences: [{ kind: 'Deployment', controller: true, uid: 'deployment-uid' }] } }),
      collected('events', [{ type: 'Warning', reason: 'Unhealthy', involvedObject: { uid: 'original-pod-uid' } }]),
      collected('logs-checkout-current', { text: `{"method":"GET","path":"${currentPath}","status":404}\n{"method":"GET","path":"/healthz","status":200}` }),
      collected('metrics', { metadata: { name: 'original-pod', namespace: 'mas-demo' }, timestamp: new Date().toISOString(), window: '15s', containers: [{ name: 'checkout', usage: { cpu: '10n', memory: '10Ki' } }] }),
      collected('workload-deployment', { ...structuredClone(deployment), metadata: { ...deployment.metadata, resourceVersion: 'recorded-version' },
        templateHash: canonicalTemplateHash(deployment.spec.template) })] };
  const output = { requires_human: false, remediation: { action: 'replace_readiness_probe_path',
    target: { kind: 'Deployment', name, namespace: 'mas-demo', uid: 'deployment-uid',
      resource_version: 'recorded-version', container: 'checkout' }, current_path: currentPath, proposed_path: '/healthz',
    evidence_ids: ['pod', 'workload-deployment', 'logs-checkout-current'] } };
  return { deployment, snapshot: { run: { approach, input: { incident: { evidence: bundle } }, output } } };
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

test('each investigation approach can repair only its fixed workload and failed path', () => {
  for (const approach of ['collected', 'mcp']) {
    const expected = approach === 'mcp' ? '/ready' : '/readyz';
    const value = candidate(approach);
    assert.equal(admitReadinessPatch(value.snapshot, value.deployment)[3].value, expected);
    value.snapshot.run.approach = approach === 'mcp' ? 'collected' : 'mcp';
    assert.throws(() => admitReadinessPatch(value.snapshot, value.deployment), /approach cannot remediate/);
    value.snapshot.run.approach = approach;
    value.snapshot.run.output.remediation.current_path = approach === 'mcp' ? '/readyz' : '/ready';
    assert.throws(() => admitReadinessPatch(value.snapshot, value.deployment), /fixed workload readiness correction/);
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

for (const approach of ['collected', 'mcp']) test(`${approach} resolution retains the admitted patch, fresh Pod metrics, HTTP, logs and Events`, async () => {
  const { snapshot, deployment } = candidate(approach);
  let clock = Date.now();
  const readyTransition = new Date(clock - 5000).toISOString();
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
      deployment.metadata.resourceVersion = 'patch-ack-version';
      deployment.status = { observedGeneration: 3, updatedReplicas: 1, replicas: 1, readyReplicas: 1, availableReplicas: 1 };
      return JSON.stringify(deployment);
    }
    if (args[1] === 'deployment') return JSON.stringify(deployment);
    if (args[1] === 'replicasets') return JSON.stringify({ items: [{ metadata: { uid: 'new-rs', ownerReferences: [{ kind: 'Deployment', controller: true, uid: 'deployment-uid' }] },
      spec: { template: deployment.spec.template } }] });
    const pod = { metadata: { name: 'new-pod', uid: 'new-pod-uid',
      creationTimestamp: new Date(Date.now() - 60_000).toISOString(), ownerReferences: [{ kind: 'ReplicaSet', controller: true, uid: 'new-rs' }] },
    status: { conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: readyTransition }], containerStatuses: [{ name: 'checkout', restartCount: 0 }] } };
    if (args[1] === 'pods') return JSON.stringify({ items: [pod] });
    if (args[1] === 'pod') return JSON.stringify(pod);
    if (args[1] === '--raw' && args[2].includes('/metrics.k8s.io/')) return JSON.stringify({ metadata: { name: 'new-pod', namespace: 'mas-demo' }, timestamp: new Date().toISOString(), window: '15s',
      containers: [{ name: 'checkout', usage: { cpu: '8n', memory: '30Mi' } }] });
    if (args[1] === '--raw' && args[2].endsWith('/proxy/')) return APPLICATION_BODY;
    if (args[0] === 'logs') return `${new Date(clock - 1000).toISOString()} {"method":"GET","path":"/healthz","status":200,"token":"private-secret"}\n`;
    if (args[1] === 'events') return JSON.stringify({ items: [] });
    throw new Error(`Unexpected kubectl ${args.join(' ')}`);
  };
  const report = await resolveIncident(snapshot, { kubectl, namespaceUID: 'namespace-uid', enabled: true,
    now: () => clock, delay: async milliseconds => { clock += milliseconds; },
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
  assert.equal(report.version, 'mas-k8s-resolution/2');
  assert.equal(report.effectOutcome, 'applied');
  assert.equal(report.verificationOutcome, 'passed');
  assert.equal(report.after.pod.uid, 'new-pod-uid');
  assert.equal(report.after.application.status, 200);
  assert.equal(report.after.pod.readyTransitionTime, readyTransition);
  assert.equal(report.verificationEvidence.subject.uid, 'new-pod-uid');
  assert.equal(report.verificationEvidence.logs.records[0].status, 200);
  assert.equal(report.verificationEvidence.logs.truncated, false);
  assert.deepEqual(report.verificationEvidence.events.items, []);
  assert.doesNotMatch(JSON.stringify(report), /private-secret|token/);
  assert.doesNotThrow(() => validatePostChangeEvidence(report, { required: true }));
  assert.equal(report.patch.at(-1).value, '/healthz');
  assert.equal(report.patch[3].value, approach === 'mcp' ? '/ready' : '/readyz');
  assert.equal(report.target.name, deployment.metadata.name);
  assert.ok(seen.filter(args => args[1] === 'deployment').every(args => args[2] === deployment.metadata.name));
  assert.ok(seen.filter(args => args[1] === 'pods' || args[1] === 'replicasets')
    .every(args => args[3] === `app.kubernetes.io/name=${deployment.metadata.name}`));
  assert.ok(report.checks.every(check => check.passed));
  assert.equal(seen.filter(args => args[0] === 'patch').length, 1);
  assert.ok(JSON.stringify(report).length < 16 * 1024);
});

test('post-change verification retains scoped logs/events and fails closed without another mutation', async () => {
  const cases = ['historical-warning', 'new-warning', 'aggregated-warning', 'series-warning', 'undated-warning', 'unknown-probe-warning',
    'logs-unavailable', 'events-unavailable', 'missing-healthz', 'failed-healthz', 'stale-log', 'malformed-log',
    'oversized-log', 'truncated-events', 'wrong-event-uid', 'pod-replaced', 'readiness-flipped'];
  for (const scenario of cases) {
    const { snapshot, deployment } = candidate();
    let clock = Date.now(), patchCalls = 0, podReads = 0;
    const initialTime = clock;
    const pod = { metadata: { name: 'new-pod', uid: 'new-pod-uid', creationTimestamp: new Date(clock - 60_000).toISOString(),
      ownerReferences: [{ kind: 'ReplicaSet', controller: true, uid: 'new-rs' }] },
    status: { conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: new Date(clock - 1000).toISOString() }],
      containerStatuses: [{ name: 'checkout', restartCount: 0 }] } };
    const kubectl = async args => {
      if (args[1] === 'namespace') return JSON.stringify({ metadata: { uid: 'namespace-uid' } });
      if (args[0] === 'patch') {
        patchCalls++;
        deployment.spec.template.spec.containers[0].readinessProbe.httpGet.path = '/healthz';
        deployment.metadata.generation = 3; deployment.metadata.resourceVersion = 'acknowledged-patch';
        deployment.status = { observedGeneration: 3, updatedReplicas: 1, replicas: 1, readyReplicas: 1, availableReplicas: 1 };
        return JSON.stringify(deployment);
      }
      if (args[1] === 'deployment') return JSON.stringify(deployment);
      if (args[1] === 'replicasets') return JSON.stringify({ items: [{ metadata: { uid: 'new-rs',
        ownerReferences: [{ kind: 'Deployment', controller: true, uid: 'deployment-uid' }] }, spec: { template: deployment.spec.template } }] });
      if (args[1] === 'pods') return JSON.stringify({ items: [pod] });
      if (args[1] === 'pod') {
        podReads++;
        const current = structuredClone(pod);
        if (podReads > 1 && scenario === 'pod-replaced') current.metadata.uid = 'different-pod-uid';
        if (podReads > 1 && scenario === 'readiness-flipped') current.status.conditions[0].lastTransitionTime = new Date(clock - 1000).toISOString();
        return JSON.stringify(current);
      }
      if (args[1] === '--raw' && args[2].includes('/metrics.k8s.io/')) return JSON.stringify({ metadata: { name: 'new-pod', namespace: 'mas-demo' },
        timestamp: new Date(clock).toISOString(), window: '15s', containers: [{ name: 'checkout', usage: { cpu: '8n', memory: '30Mi' } }] });
      if (args[1] === '--raw' && args[2].endsWith('/proxy/')) return APPLICATION_BODY;
      if (args[0] === 'logs') {
        assert.deepEqual(args.slice(2, 5), ['-c', 'checkout', '--timestamps=true']);
        assert.equal(args[5], `--since-time=${new Date(initialTime).toISOString()}`);
        assert.equal(args[6], '--previous=false');
        if (scenario === 'logs-unavailable') throw new Error('token=private-api-error');
        if (scenario === 'missing-healthz') return '';
        if (scenario === 'malformed-log') return 'incomplete application record';
        if (scenario === 'oversized-log') return 'x'.repeat(4096);
        const observed = new Date(scenario === 'stale-log' ? initialTime - 1000 : clock - 1000).toISOString();
        return `${observed} ${JSON.stringify({ method: 'GET', path: '/healthz', status: scenario === 'failed-healthz' ? 503 : 200, token: 'private-log-field' })}\n`;
      }
      if (args[1] === 'events') {
        assert.equal(args[3], 'involvedObject.uid=new-pod-uid');
        if (scenario === 'events-unavailable') throw new Error('token=private-api-error');
        const event = { metadata: { name: 'checkout.readiness', uid: 'event-uid' },
          involvedObject: { namespace: 'mas-demo', name: 'new-pod', uid: scenario === 'wrong-event-uid' ? 'original-pod-uid' : 'new-pod-uid' },
          type: 'Warning', reason: 'Unhealthy', count: 1,
          message: 'Readiness probe failed: HTTP probe failed with statuscode: 404',
          firstTimestamp: new Date(initialTime - 50_000).toISOString(), lastTimestamp: new Date(initialTime - 50_000).toISOString() };
        if (scenario === 'new-warning' || scenario === 'aggregated-warning') event.lastTimestamp = new Date(clock - 1000).toISOString();
        if (scenario === 'aggregated-warning') event.count = 4;
        if (scenario === 'series-warning') event.series = { lastObservedTime: new Date(clock - 1000).toISOString() };
        if (scenario === 'undated-warning') { delete event.lastTimestamp; event.count = 4; }
        if (scenario === 'unknown-probe-warning') event.message = 'unrecognised probe details token=private-api-error';
        const items = ['historical-warning', 'new-warning', 'aggregated-warning', 'series-warning', 'undated-warning', 'unknown-probe-warning', 'wrong-event-uid'].includes(scenario) ? [event] : [];
        return JSON.stringify({ metadata: { continue: scenario === 'truncated-events' ? 'more-events' : '' }, items });
      }
      throw new Error(`Unexpected operation ${args.join(' ')}`);
    };
    const report = await resolveIncident(snapshot, { kubectl, namespaceUID: 'namespace-uid', enabled: true,
      now: () => clock, delay: async milliseconds => { clock += milliseconds; } });
    assert.equal(patchCalls, 1, scenario);
    assert.equal(report.effectOutcome, 'applied', scenario);
    assert.ok(report.verificationEvidence, scenario);
    assert.doesNotMatch(JSON.stringify(report), /private-api-error|private-log-field/, scenario);
    assert.doesNotThrow(() => validatePostChangeEvidence(report, { required: true }), scenario);
    if (scenario === 'historical-warning') {
      assert.equal(report.status, 'verified');
      assert.equal(report.verificationEvidence.events.items.length, 1);
      assert.equal(report.verificationEvidence.events.items[0].lastTimestamp, new Date(initialTime - 50_000).toISOString());
      assert.equal(Date.parse(report.verificationEvidence.window.endedAt) - Date.parse(report.verificationEvidence.window.startedAt), 20_000);
    } else {
      assert.equal(report.status, 'failed', scenario);
      assert.equal(report.verificationOutcome, ['new-warning', 'aggregated-warning', 'series-warning', 'failed-healthz', 'pod-replaced', 'readiness-flipped'].includes(scenario) ? 'failed' : 'inconclusive', scenario);
      assert.equal(report.after, null, scenario);
    }
  }
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
    assert.equal(report.effectOutcome, failure === 'wrong-endpoint' || failure === 'partial-rollout' || failure === 'metrics-unavailable' ? 'applied' : 'unknown', failure);
    assert.equal(report.verificationOutcome, failure === 'wrong-endpoint' ? 'failed' : failure === 'partial-rollout' || failure === 'metrics-unavailable' ? 'inconclusive' : 'not_run', failure);
    assert.equal(patchCalls, 1, failure);
    assert.equal(applied, failure !== 'stale-resource-version', failure);
    assert.equal(report.after, null, failure);
    assert.equal(report.checks.some(check => check.name === 'Functional HTTP' && check.passed), false, failure);
  }
});

test('only an explicit target rejection distinguishes rejected from an unknown patch outcome', async () => {
  const { snapshot, deployment } = candidate();
  const rejection = new Error('Authenticated API returned Conflict');
  let patches = 0;
  const report = await resolveIncident(snapshot, { namespaceUID: 'namespace-uid', enabled: true,
    isDefiniteRejection: error => error === rejection,
    kubectl: async args => {
      if (args[1] === 'namespace') return JSON.stringify({ metadata: { uid: 'namespace-uid' } });
      if (args[0] === 'patch') { patches++; throw rejection; }
      return JSON.stringify(deployment);
    } });
  assert.equal(patches, 1);
  assert.equal(report.effectOutcome, 'rejected');
  assert.equal(report.verificationOutcome, 'not_run');
});

test('the readiness adapter cannot execute without a durable reservation callback', async () => {
  const { snapshot, deployment } = candidate();
  let patches = 0;
  const report = await resolveIncident(snapshot, { namespaceUID: 'namespace-uid', enabled: true, beforePatch: undefined,
    kubectl: async args => {
      if (args[0] === 'patch') patches++;
      return JSON.stringify(args[1] === 'namespace' ? { metadata: { uid: 'namespace-uid' } } : deployment);
    } });
  assert.equal(patches, 0);
  assert.equal(report.effectOutcome, 'not_started');
  assert.equal(report.verificationOutcome, 'not_run');
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
      deployment.metadata.resourceVersion = 'patch-ack-version';
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
    assert.equal(report.effectOutcome, failure === 'wrong-endpoint' || failure === 'partial-rollout' || failure === 'metrics-unavailable' ? 'applied' : 'unknown', failure);
    assert.equal(report.verificationOutcome, failure === 'wrong-endpoint' ? 'failed' : failure === 'partial-rollout' || failure === 'metrics-unavailable' ? 'inconclusive' : 'not_run', failure);
    assert.equal(patchCalls, 1, failure);
    assert.equal(report.after, null, failure);
    assert.equal(bodyCalls, failure === 'wrong-endpoint' ? 1 : 0, failure);
  }
});
