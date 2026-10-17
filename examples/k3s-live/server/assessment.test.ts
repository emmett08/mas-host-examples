// Exercise the actual native evaluator without provider calls or the Kubernetes controller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../shared/revision.mjs';

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function evaluate(output: Record<string, unknown>, incident = { evidence: { items: [] } }) {
  const record = { schema_version: 1, id: 'incident', content: incident, content_sha256: digest(incident) };
  const result = spawnSync('python3', ['-I', '-c',
    'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("assessment",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.assess(None,json.load(sys.stdin))))',
    resolve('project/assessment.py')], { encoding: 'utf8', input: JSON.stringify({ candidate: { output }, sources: { incident }, evidence: [record] }) });
  assert.equal(result.status, 0, result.stderr);
  return { result: JSON.parse(result.stdout), evidence: { id: record.id, sha256: digest(record) } };
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
