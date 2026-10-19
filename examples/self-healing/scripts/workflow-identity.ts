import { caseNames } from '../evaluation/injectors.js';

/** Trusted workflow identity; a matrix case never shares a publication branch. */
export function workflowIdentity(env: NodeJS.ProcessEnv = process.env) {
  const run = env.GITHUB_RUN_ID, attempt = env.GITHUB_RUN_ATTEMPT;
  if (!/^[1-9][0-9]*$/.test(run ?? '') || !/^[1-9][0-9]*$/.test(attempt ?? ''))
    throw new Error('Exact workflow run and attempt are required');
  const selected = env.SELF_REMEDIATION_CASE;
  if (selected && !caseNames.includes(selected as typeof caseNames[number]))
    throw new Error('Unknown workflow case');
  const suffix = selected ? `-${selected}` : '';
  const runId = `run-${run}-${attempt}${suffix}`;
  if (runId.length > 53) throw new Error('Workflow identity exceeds the deployment label bound');
  return { runId, incidentId: selected ? `${run}-${attempt}-${selected}` : undefined,
    namespace: `mas-repair-${run}-${attempt}${suffix}` };
}

export function assertWorkflowIncident(incidentId: string, env: NodeJS.ProcessEnv = process.env) {
  const identity = workflowIdentity(env);
  if (identity.incidentId && identity.incidentId !== incidentId)
    throw new Error('Retained incident belongs to another workflow case or attempt');
  return identity;
}
