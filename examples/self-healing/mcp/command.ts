/** Adapt one schema-checked host command to the incident run, observation or cancellation contract. */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { admissionDigest, validateRequest, type Admission, type Request } from './contract.js';
import { cancelIncident } from './incident.js';
import { snapshot } from './observation.js';
import { runIncident, verifyInvocation } from './execute.js';

const { values } = parseArgs({ options: { admission: { type: 'string' }, operation: { type: 'string' }, invocation: { type: 'string' } } });
try {
  if (!values.admission || !values.invocation || !['run', 'status', 'cancel'].includes(values.operation ?? '')) throw new Error('Invalid trusted invocation');
  const admission = JSON.parse(readFileSync(values.admission, 'utf8')) as Admission;
  if (admission.version !== 'self-healing-mcp/1') throw new Error('Unsupported admission');
  const input = readFileSync(0, 'utf8');
  if (Buffer.byteLength(input) > 4096) throw new Error('Oversized input');
  const request = JSON.parse(input) as Request;
  validateRequest(admission, request, values.operation!);
  if (values.operation === 'run') {
    await verifyInvocation(admission, request, values.invocation);
    await runIncident(admission, request, values.invocation);
  } else if (values.operation === 'cancel') cancelIncident(admission);
  process.stdout.write(JSON.stringify({ incident_id: admission.incidentId, contract_digest: admissionDigest(admission),
    invocation_id: values.invocation, snapshot_json: JSON.stringify(snapshot(admission, request.after ?? 0)) }) + '\n');
} catch {
  // Detailed process diagnostics can contain paths or credentials; retain a fixed public failure.
  process.stderr.write('Self-healing MCP operation failed; inspect the retained incident and original host task.\n');
  process.exitCode = 1;
}
