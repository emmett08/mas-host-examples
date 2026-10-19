/** Official-client helpers for the prepared local service and immutable observation requests. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { prepare } from './prepare.js';
export type Prepared = Awaited<ReturnType<typeof prepare>>;
export async function connect(prepared: Prepared, directServer = false) {
  const client = new Client({ name: 'self-healing-client', version: '1.0.0' });
  const env = Object.fromEntries(prepared.admission.credentialNames.filter(name => process.env[name]).map(name => [name, process.env[name]!]));
  const transport = new StdioClientTransport({ command: directServer ? prepared.server : process.execPath,
    args: directServer ? ['--config', prepared.config] : prepared.launcherArgs, env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  try { await client.connect(transport); return { client, transport }; }
  catch (error) { await transport.close(); throw error; }
}
export async function call(client: Client, name: string, arguments_: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: arguments_ });
  if (result.isError || !result.structuredContent) throw new Error(`MCP ${name} rejected the request: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}
export async function completed(client: Client, task: any, timeoutMs = 60000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (['submitted', 'working'].includes(task.state) && Date.now() < deadline) {
    await delay(50); task = await call(client, 'mas_status', { task_id: task.task_id });
  }
  if (task.state !== 'completed') throw new Error(`MCP task remains ${task.state}; retain its identity and reconcile before replacement work`);
  return task;
}
export function input(prepared: Prepared) { return { incident_id: prepared.admission.incidentId, contract_digest: prepared.contract_digest }; }
export async function observeIncident(client: Client, prepared: Prepared, descriptorDigest: string, after = 0) {
  const task = await completed(client, await call(client, 'mas_submit', {
    request_id: `observe.${randomUUID()}`, operation: 'self_healing_status', descriptor_digest: descriptorDigest,
    input_json: JSON.stringify({ ...input(prepared), after }),
  }));
  return JSON.parse(JSON.parse(task.output_json).snapshot_json);
}
