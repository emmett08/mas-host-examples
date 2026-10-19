/** Exercise the full disposable Kubernetes repair through the actual MCP service. */
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { prepare } from '../mcp/prepare.js';
import { call, connect, input, observeIncident } from '../mcp/client.js';
const { values } = parseArgs({ options: { output: { type: 'string' }, incident: { type: 'string', default: 'mcp-fixture' } } });
if (!values.output) throw new Error('Use --output NEW_DIRECTORY');
const prepared = await prepare({ directory: values.output, incidentId: values.incident!, example: process.cwd(), mode: 'fixture',
  host: resolve(process.env.MAS_HOST_BIN ?? '../../.tools/mas-host/target/debug/mas-host'), sdkRoot: resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host'),
  server: resolve(process.env.MAS_MCP_BIN ?? '../../.tools/mas-mcp/target/release/mas-mcp') });
const { client } = await connect(prepared);
const observations: unknown[] = [];
try {
  const descriptor = await call(client, 'mas_describe'), requestId = `${values.incident}.repair`;
  const request = { request_id: requestId, operation: 'self_healing_run', descriptor_digest: descriptor.descriptor_digest,
    input_json: JSON.stringify({ ...input(prepared), request_id: requestId }) };
  await call(client, 'mas_submit', request);
  let cursor = 0, duringRun = false, terminal: any;
  const deadline = Date.now() + prepared.admission.limits.wallMs + 60000;
  while (Date.now() < deadline) {
    const task = await call(client, 'mas_status', { task_id: requestId });
    const view = await observeIncident(client, prepared, descriptor.descriptor_digest, cursor);
    observations.push(view); cursor = view.next_after;
    if (view.events.length && ['submitted', 'working'].includes(task.state)) duringRun = true;
    if (task.state === 'completed') { terminal = JSON.parse(JSON.parse(task.output_json).snapshot_json); break; }
    if (task.state === 'unknown' || task.state === 'cancelled') throw new Error(`Gateway task ${task.state}; inspect original controller observations`);
    if (!view.more) await delay(1000);
  }
  if (terminal?.outcome !== 'verified_recovery' || !duringRun) throw new Error('MCP demonstration did not establish isolated recovery and during-run observation');
  const repeated = await call(client, 'mas_submit', request);
  if (repeated.state !== 'completed') throw new Error('Completed request did not replay');
  console.log(JSON.stringify({ status: 'passed', mode: 'scripted Kubernetes control', task_id: requestId,
    outcome: terminal.outcome, during_run_observation: duringRun, repeated_submission_retained: true }));
} finally {
  writeFileSync(join(resolve(values.output), 'observations.json'), JSON.stringify(observations, null, 2), { mode: 0o600 });
  await client.close();
}
