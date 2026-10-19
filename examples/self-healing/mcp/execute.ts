/** Execute the prepared foreground controller once under its existing journal and budget. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { admissionDigest, verifyFiles, type Admission, type Request } from './contract.js';
import { cancelIncident, claim, interrupted } from './incident.js';
import { snapshot } from './observation.js';

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
  verifyFiles(admission);
  const revision = await execute('git', ['-C', admission.repository, 'rev-parse', 'HEAD'], { timeout: 10000 });
  if (revision.stdout.trim() !== admission.sourceRevision) throw new Error('Prepared repository revision changed');
  if (!claim(admission, { requestId: request.request_id!, invocationId, contractDigest: admissionDigest(admission) })) return;
  const environment: NodeJS.ProcessEnv = { ...admission.environment };
  for (const name of admission.credentialNames) if (process.env[name]) environment[name] = process.env[name];
  let child: ReturnType<typeof spawn> | undefined;
  const cancel = () => { cancelIncident(admission); child?.kill('SIGTERM'); };
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  try {
    await new Promise<void>((accept, reject) => {
      child = spawn(admission.node, [admission.controller, ...admission.arguments], {
        cwd: admission.example, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
      });
      let bytes = 0;
      const drain = (data: Buffer) => { bytes += data.length; if (bytes > 1_048_576) { child?.kill('SIGTERM'); reject(new Error('Controller output exceeded bound')); } };
      child.stdout!.on('data', drain); child.stderr!.on('data', drain);
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        // Application failures can have a completed journal outcome. Signals and missing outcomes retain uncertainty.
        if (signal || code === null || !snapshot(admission).outcome) reject(new Error('Controller outcome unconfirmed'));
        else accept();
      });
    });
  } catch { interrupted(admission); }
  finally { process.off('SIGTERM', cancel); process.off('SIGINT', cancel); }
}
