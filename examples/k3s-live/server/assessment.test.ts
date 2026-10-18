// Exercise the actual native evaluator without provider calls or the Kubernetes controller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../shared/revision.mjs';
import { managedWorkloads } from '../shared/workloads.mjs';

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function pythonHandler(handler: string, input: unknown) {
  const result = spawnSync('python3', ['-I', '-c',
    'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("assessment",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(getattr(m,sys.argv[2])(None,json.load(sys.stdin))))',
    resolve('project/assessment.py'), handler], { encoding: 'utf8', input: JSON.stringify(input) });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function evaluate(output: Record<string, unknown>, incident: { evidence: { items: unknown[] } } = { evidence: { items: [] } }) {
  const record = { schema_version: 1, id: 'incident', content: incident, content_sha256: digest(incident) };
  return { result: pythonHandler('assess', { candidate: { output }, sources: { incident }, evidence: [record] }),
    evidence: { id: record.id, sha256: digest(record) } };
}

test('native evaluator distinguishes unsupported citations and inconsistent abstention without claiming true diagnosis accuracy', () => {
  const candidate = { evidence_ids: ['invented-observation'], next_checks: ['Collect logs'], requires_human: false,
    remediation: { action: 'none', evidence_ids: [] } };
  const { result, evidence } = evaluate(candidate);
  assert.equal(result.status, 'completed');
  assert.equal(result.findings.find((item: { criterion_id: string }) => item.criterion_id === 'evidence-references').verdict, 'fail');
  assert.equal(result.findings.find((item: { criterion_id: string }) => item.criterion_id === 'uncertainty').verdict, 'fail');
  assert.ok(result.findings.every((item: { evidence: unknown[] }) => canonicalJson(item.evidence) === canonicalJson([evidence])));
  const revised = evaluate({ ...candidate, evidence_ids: [], requires_human: true }).result;
  assert.ok(revised.findings.every((item: { verdict: string }) => item.verdict === 'pass'));
  assert.deepEqual(candidate.evidence_ids, ['invented-observation']);
});

test('native evaluator rejects a proposed mutation without the exact retained target evidence', () => {
  const { result } = evaluate({ evidence_ids: [], next_checks: ['Observe'], requires_human: false,
    remediation: { action: 'replace_readiness_probe_path', evidence_ids: [], target: { uid: 'invented' },
      current_path: '/readyz', proposed_path: '/healthz', verification: ['Check'], rollback: 'Restore' } });
  assert.equal(result.findings.find((item: { criterion_id: string }) => item.criterion_id === 'bounded-proposal').verdict, 'fail');
});

test('native quorum constraints distinguish Boolean values from exact integer rubric and incident values', () => {
  const reference = (record: { id: string }) => ({ id: record.id, sha256: digest(record) });
  const rubric = { schema_version: 1, id: 'incident-constraints/1', criteria:
    ['evidence-references', 'bounded-proposal', 'uncertainty'].map(id => ({ id, measurement: 'deterministic', minimum: 0, maximum: 1 })) };
  const incident = { evidence: { items: [] }, flag: 0 };
  const evidence = [{ schema_version: 1, id: 'incident', content: incident, content_sha256: digest(incident) }];
  const output = { evidence_ids: [], requires_human: true, next_checks: ['Collect logs'], remediation: { action: 'none', evidence_ids: [] } };
  const candidate = { schema_version: 1, id: 'candidate-type-check', output, output_sha256: digest(output), parent: null, feedback: [] };
  const input = { candidate: reference(candidate), candidate_record: candidate, incident, rubric, evidence,
    review_context: { criterion_id: 'incident-constraints/1:all', rubric: reference(rubric), evidence: evidence.map(reference) } };
  assert.equal(pythonHandler('quorum_vote', input).accepted, true);
  const wrongRubric = structuredClone(input);
  for (const criterion of wrongRubric.rubric.criteria) Object.assign(criterion, { minimum: false, maximum: true });
  wrongRubric.review_context.rubric = reference(wrongRubric.rubric);
  assert.equal(pythonHandler('quorum_vote', wrongRubric).accepted, false);
  const wrongIncident = { ...structuredClone(input), incident: { ...incident, flag: false } };
  assert.equal(pythonHandler('quorum_vote', wrongIncident).accepted, false);
});


test('native evaluator binds each managed readiness proposal to its exact observed deployment/path pair', () => {
  for (const workload of managedWorkloads) {
    const deployment = { kind: 'Deployment',
      metadata: { namespace: workload.namespace, name: workload.name, uid: 'retained-uid', resourceVersion: '789' },
      spec: { template: { spec: { containers: [{ name: workload.container, command: ['node', '/app/deploy/probe-app.mjs'],
        readinessProbe: { httpGet: { path: workload.currentPath } }, livenessProbe: { httpGet: { path: '/healthz' } },
      }] } } } };
    const incident = { evidence: { items: [
      { id: 'pod', status: 'collected' }, { id: 'logs-checkout-current', status: 'collected' },
      { id: 'workload-deployment', status: 'collected', data: deployment },
    ] } };
    const candidate = { evidence_ids: ['pod', 'workload-deployment', 'logs-checkout-current'], requires_human: false,
      next_checks: ['Verify rollout and retained post-change logs/events'], remediation: {
        action: 'replace_readiness_probe_path', target: { kind: 'Deployment', namespace: workload.namespace,
          name: workload.name, container: workload.container, uid: 'retained-uid', resource_version: '789' },
        current_path: workload.currentPath, proposed_path: workload.proposedPath,
        evidence_ids: ['pod', 'workload-deployment', 'logs-checkout-current'], verification: ['Check'], rollback: 'Restore',
      } };
    const verdict = (output = candidate, observations = incident) => evaluate(output, observations).result.findings
      .find((item: { criterion_id: string }) => item.criterion_id === 'bounded-proposal').verdict;
    assert.equal(verdict(), 'pass');
    const crossed = structuredClone(candidate);
    crossed.remediation.current_path = workload.currentPath === '/readyz' ? '/ready' : '/readyz';
    assert.equal(verdict(crossed), 'fail');
    const wrongTarget = structuredClone(candidate);
    wrongTarget.remediation.target.name = workload.name === 'mas-demo-checkout' ? 'mas-demo-checkout-mcp' : 'mas-demo-checkout';
    assert.equal(verdict(wrongTarget), 'fail');
    for (const name of ['production-service', 'mas-demo-checkout-mcp-copy']) {
      const unknownTarget = structuredClone(candidate), unknownEvidence = structuredClone(incident);
      unknownTarget.remediation.target.name = name;
      unknownEvidence.evidence.items[2]!.data!.metadata.name = name;
      assert.equal(verdict(unknownTarget, unknownEvidence), 'fail');
    }
    const wrongSpec = structuredClone(incident);
    wrongSpec.evidence.items[2]!.data!.spec.template.spec.containers[0]!.readinessProbe.httpGet.path =
      workload.currentPath === '/readyz' ? '/ready' : '/readyz';
    assert.equal(verdict(candidate, wrongSpec), 'fail');
    const wrongCommand = structuredClone(incident);
    wrongCommand.evidence.items[2]!.data!.spec.template.spec.containers[0]!.command = ['node', '/app/other-service.mjs'];
    assert.equal(verdict(candidate, wrongCommand), 'fail');
  }
});
