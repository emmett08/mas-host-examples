import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { caseNames, fixtureOutcome } from '../evaluation/injectors.js';
import { workflowIdentity, assertWorkflowIncident } from '../scripts/workflow-identity.js';
import { requiresDuringRunObservation } from '../controller/observation.js';

const workflow = (name: string) => parse(readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8'));
const env = { GITHUB_RUN_ID: '39303968258', GITHUB_RUN_ATTEMPT: '2' };

test('protected jobs declare and receive every consumed secret across the reusable workflow boundary', () => {
  const parent = workflow('self-healing.yml'), child = workflow('self-healing-case.yml');
  const references = (value: unknown) => [...new Set([...JSON.stringify(value).matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map(match => match[1]!))].sort();
  const consumed = references(child.jobs);
  assert.deepEqual(Object.keys(child.on.workflow_call.secrets ?? {}).sort(), consumed,
    'Every secret reference needs a declared workflow_call contract');
  assert.deepEqual(Object.keys(parent.jobs.examples.secrets ?? {}).sort(), consumed,
    'The matrix caller must explicitly forward exactly the consumed secrets');
  for (const name of consumed) {
    assert.equal(child.on.workflow_call.secrets[name].required, true,
      'GitHub must reject an omitted mapping; preflight checks the value when live execution is selected');
    assert.equal(parent.jobs.examples.secrets[name], `\${{ secrets.${name} }}`);
  }
  assert.deepEqual(references(child.jobs.live), ['OPENAI_API_KEY', 'SELF_REMEDIATION_GITHUB_READ_TOKEN']);
  assert.deepEqual(references(child.jobs.publication), ['SELF_REMEDIATION_APP_PRIVATE_KEY']);
  assert.deepEqual(references(child.jobs.fixture), []);
  assert.deepEqual(references(child.jobs.promotion), []);
  assert.deepEqual(references(child.env), []);
});

test('all-case selection covers every protected case with bounded concurrency and isolated lifecycle outputs', () => {
  const parent = workflow('self-healing.yml'), child = workflow('self-healing-case.yml');
  assert.equal(parent.on.workflow_dispatch.inputs.all_cases.type, 'boolean');
  assert.equal(parent.on.workflow_dispatch.inputs.all_cases.default, false);
  assert.deepEqual(parent.on.workflow_dispatch.inputs.case.options, [...caseNames]);
  const expression = parent.jobs.examples.strategy.matrix.case;
  assert.deepEqual(JSON.parse(expression.match(/'(?<cases>\["missing-route"[^']*)'/).groups.cases), [...caseNames]);
  assert.equal(parent.jobs.examples.strategy['max-parallel'], 2);
  assert.equal(parent.jobs.examples.strategy['fail-fast'], false);
  assert.equal(parent.jobs.examples.needs, 'fixture');
  assert.equal(parent.jobs.examples.uses, './.github/workflows/self-healing-case.yml');
  // The parent has already passed shared checks. Depending on this optional
  // fixture job would silently skip live execution when that job is skipped.
  assert.equal(child.jobs.live.needs, undefined);
  assert.equal(child.jobs.fixture.needs, undefined);
  assert.equal(child.jobs.publication.needs, 'live');
  assert.deepEqual(child.jobs.promotion.needs, ['live', 'publication']);
  assert.match(child.jobs.publication.if, /needs.live.outputs.has-candidate/);
  assert.equal(child.jobs.live.environment, 'self-remediation-live');
  assert.equal(child.jobs.publication.environment, 'self-remediation-publication');
  assert.equal(child.jobs.fixture.environment, undefined);
  assert.equal(child.jobs.promotion.environment, undefined);
  for (const job of Object.values(child.jobs) as any[]) {
    for (const step of job.steps) {
      const name = step.with?.name;
      if (typeof name === 'string' && name.startsWith('self-remediation-')) assert.ok(name.endsWith('-${{ inputs.case }}'), name);
    }
  }
});

test('all cases have independent publication branches, promotion namespaces and incident bindings', () => {
  const identities = caseNames.map(selected => workflowIdentity({ ...env, SELF_REMEDIATION_CASE: selected }));
  assert.equal(new Set(identities.map(x => x.runId)).size, caseNames.length);
  assert.equal(new Set(identities.map(x => x.namespace)).size, caseNames.length);
  for (const [index, selected] of caseNames.entries()) {
    const context = { ...env, SELF_REMEDIATION_CASE: selected }, identity = identities[index]!;
    assert.deepEqual(assertWorkflowIncident(identity.incidentId!, context), identity);
    assert.ok(identity.namespace.length <= 63);
    assert.throws(() => assertWorkflowIncident(identity.incidentId!, { ...context, GITHUB_RUN_ATTEMPT: '3' }), /another workflow/);
    assert.throws(() => assertWorkflowIncident(identity.incidentId!, { ...context, SELF_REMEDIATION_CASE: caseNames[(index + 1) % caseNames.length] }), /another workflow/);
  }
  assert.throws(() => workflowIdentity({ ...env, SELF_REMEDIATION_CASE: '../case' }), /Unknown workflow case/);
});

test('negative controls require their specific outcomes rather than any successful process exit', () => {
  assert.equal(fixtureOutcome('ambiguous-requirement'), 'missing_requirements');
  assert.equal(fixtureOutcome('no-defect'), 'no_repair_required');
  assert.equal(fixtureOutcome('unavailable-dependency'), 'unavailable_external_cause');
  for (const name of ['missing-route', 'business-logic', 'runtime-config', 'held-out-combination', 'verification-bypass'] as const)
    assert.equal(fixtureOutcome(name), 'verified_recovery');
});

test('an immediate requirements stop retains completion evidence without claiming active observation', () => {
  const stopped = [{ type: 'incident.opened', data: {} }, { type: 'outcome', data: { outcome: 'missing_requirements' } }];
  assert.equal(requiresDuringRunObservation(stopped), false);
  assert.equal(requiresDuringRunObservation([]), true);
  assert.equal(requiresDuringRunObservation([...stopped, { type: 'tool.result', data: {} }]), true);
  assert.equal(requiresDuringRunObservation([stopped[0]!, { type: 'outcome', data: { outcome: 'verified_recovery' } }]), true);
});
