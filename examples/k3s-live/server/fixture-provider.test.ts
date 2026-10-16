import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureOutput } from '../project/fixture-provider.mjs';

const evidence = () => ({ subject: { namespace: 'mas-demo', name: 'checkout-pod', uid: 'pod-live-uid' }, items: [
  { id: 'workload-deployment', kind: 'workload', status: 'collected', truncated: false, data: { kind: 'Deployment', metadata: { namespace: 'mas-demo', name: 'mas-demo-checkout', uid: 'deployment-live-uid', resourceVersion: '789' },
    spec: { template: { spec: { containers: [{ name: 'checkout', readinessProbe: { httpGet: { path: '/readyz' } }, livenessProbe: { httpGet: { path: '/healthz' } } }] } } } } },
  { id: 'logs-checkout-current', kind: 'logs', status: 'collected', truncated: false, data: { text: '2026-10-16T12:00:00.123456789Z {"method":"GET","path":"/readyz","status":404}\n2026-10-16T12:00:01Z {"method":"GET","path":"/healthz","status":200}' } },
  { id: 'metrics', kind: 'metrics', status: 'unavailable', truncated: false, data: null },
  { id: 'pod', kind: 'pod', status: 'collected', truncated: false, data: { kind: 'Pod', metadata: { namespace: 'mas-demo', name: 'checkout-pod', uid: 'pod-live-uid' }, status: { conditions: [{ type: 'Ready', status: 'False' }] } } },
] });
const decide = (value: unknown) => fixtureOutput({ input_json: JSON.stringify({ incident: { evidence: value } }) }, 'decision');

test('fixture proposes only an independently corroborated readiness fix with exact captured identity', () => {
  const result = decide(evidence());
  assert.equal(result.requires_human, false);
  assert.equal(result.remediation.action, 'replace_readiness_probe_path');
  assert.equal(result.remediation.target.uid, 'deployment-live-uid');
  assert.equal(result.remediation.target.resource_version, '789');
  assert.deepEqual(result.remediation.evidence_ids, ['pod', 'workload-deployment', 'logs-checkout-current']);
  assert.ok(!result.evidence_ids.includes('metrics'));
  assert.match(result.summary, /^Fixture investigation plan:/);
});

test('fixture refuses absent, contradictory, truncated and out-of-scope evidence', () => {
  for (const alter of [
    (value: ReturnType<typeof evidence>) => { value.items = []; },
    (value: ReturnType<typeof evidence>) => { value.items[1]!.data = { text: '{"method":"GET","path":"/healthz","status":503}' }; },
    (value: ReturnType<typeof evidence>) => { value.items[0]!.truncated = true; },
    (value: ReturnType<typeof evidence>) => { value.items[0]!.data!.metadata!.name = 'production-service'; },
    (value: ReturnType<typeof evidence>) => { value.items[1]!.status = 'unavailable'; },
    (value: ReturnType<typeof evidence>) => { value.items = value.items.filter(item => item.id !== 'pod'); },
  ]) {
    const bundle = evidence(); alter(bundle);
    const result = decide(bundle);
    assert.equal(result.requires_human, true);
    assert.equal(result.remediation.action, 'none');
    assert.equal(result.remediation.target.uid, '');
    assert.deepEqual(result.remediation.evidence_ids, []);
  }
});

test('a truncated log tail supports the narrow fix only when both complete proof records remain', () => {
  const bundle = evidence();
  bundle.items[1]!.truncated = true;
  assert.equal(decide(bundle).remediation.action, 'replace_readiness_probe_path');
  bundle.items[1]!.data!.text = 'truncated partial {"method":"GET","path":"/readyz"\n2026-10-16T12:00:01Z {"method":"GET","path":"/healthz","status":200}';
  assert.equal(decide(bundle).remediation.action, 'none');
});
