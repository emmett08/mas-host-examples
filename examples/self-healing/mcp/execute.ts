/** Execute the prepared foreground controller once under its existing journal and budget. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { admissionDigest, verifyFiles, type Admission, type Request } from './contract.js';
import { cancelIncident, claim, interrupted } from './incident.js';
import { snapshot } from './observation.js';
import { runControllerProcess } from './controller-process.js';

const execute = promisify(execFile);
export async function verifyInvocation(admission: Admission, request: Request, invocationId: string): Promise<void> {
  // mas-mcp uses request_id as the host run ID. Verify the caller-supplied correlation against that run's admitted effect.
  const result = await execute(admission.host, ['observe', '--state', admission.gatewayState, '--run', request.request_id!, '--include-payloads', 'false'],
    { timeout: 10000, maxBuffer: 1_048_576 });
  const observed = JSON.parse(result.stdout);
  if (observed.run_id !== request.request_id || !observed.steps?.some((step: any) => step.kind === 'effect' && step.id === invocationId && step.actor === 'healing_run'))
    throw new Error('MCP request identity does not bind this host invocation');
}

export async function runIncident(admission: Admission, request: Request, invocationId: string): Promise<void> {
  const retained = snapshot(admission);
  if (retained.dispatch || retained.cancellation_requested) return;
  verifyFiles(admission);
  const revision = await execute('git', ['-C', admission.repository, 'rev-parse', 'HEAD'], { timeout: 10000 });
  if (revision.stdout.trim() !== admission.sourceRevision) throw new Error('Prepared repository revision changed');
  if (!claim(admission, { requestId: request.request_id!, invocationId, contractDigest: admissionDigest(admission) })) return;
  const environment: NodeJS.ProcessEnv = { ...admission.environment };
  for (const name of admission.credentialNames) if (process.env[name]) environment[name] = process.env[name];
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  try {
    const budget = snapshot(admission).budget as { deadline: number };
    const result = await runControllerProcess({ executable: admission.node, arguments: [admission.controller, ...admission.arguments],
      directory: admission.example, environment, deadline: budget.deadline, signal: cancellation.signal,
      onStop: reason => cancelIncident(admission, reason),
    });
    // Application failures can have a committed outcome. Process loss never manufactures one.
    if (result.signal || result.code === null || !snapshot(admission).outcome) throw new Error('Controller outcome unconfirmed');
  } catch { interrupted(admission); }
  finally { process.off('SIGTERM', cancel); process.off('SIGINT', cancel); }
}
