/** Supervise the unchanged Rust stdio server and retain its original run's cancellation in the controller. */
import { spawn, execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs, promisify } from 'node:util';
import { admissionDigest, type Admission, type Dispatch } from './contract.js';
import { snapshot } from './observation.js';
import { cancelIncident } from './incident.js';
const execute = promisify(execFile);
const { values } = parseArgs({ options: { admission: { type: 'string' }, digest: { type: 'string' }, server: { type: 'string' }, config: { type: 'string' } } });
if (!values.admission || !values.server || !values.config) throw new Error('Prepared service arguments required');
const admission = JSON.parse(readFileSync(values.admission, 'utf8')) as Admission;
if (admissionDigest(admission) !== values.digest) throw new Error('Prepared service contract changed');
// All MCP framing, discovery and tool dispatch stay in mas-mcp. This process never reads stdin or writes stdout.
const server = spawn(values.server, ['--config', values.config], { stdio: 'inherit', detached: false });
let reading = false;
async function forwardCancellation() {
  if (reading) return;
  reading = true;
  try {
    const view = snapshot(admission), dispatch = view.dispatch as Dispatch | null;
    if (!dispatch || view.cancellation_requested) return;
    const result = await execute(admission.host, ['observe', '--state', admission.gatewayState, '--run', dispatch.requestId, '--include-payloads', 'false'],
      { timeout: 10000, maxBuffer: 1_048_576 });
    const observed = JSON.parse(result.stdout);
    if (observed.cancelled === true && observed.run_id === dispatch.requestId &&
        observed.steps.some((step: any) => step.kind === 'effect' && step.id === dispatch.invocationId)) cancelIncident(admission);
  } catch { /* An unavailable observation leaves cancellation unconfirmed; never fabricate a receipt. */ }
  finally { reading = false; }
}
const timer = setInterval(() => { void forwardCancellation(); }, 250);
const terminate = () => { server.kill('SIGTERM'); };
process.once('SIGTERM', terminate); process.once('SIGINT', terminate);
try {
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; accept(); });
  });
} finally {
  clearInterval(timer); await forwardCancellation();
  process.off('SIGTERM', terminate); process.off('SIGINT', terminate);
}
