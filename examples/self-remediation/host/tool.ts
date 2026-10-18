/** Ordinary host command effects stay outside the pure --revision-plan runs. */
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { hostCommand, pinnedHostIdentity, HostPhaseError, type HostConfiguration } from './phase.js';
import { requireCapability } from '../tools/capabilities.js';
import type { Receipt } from '../tools/broker.js';
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export type TrustedOperationOptions = {
  runtimeBundle: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
  operationName: string; stateDir?: string; environment?: Record<string, string>;
  arguments?: string[]; timeoutMs: number; outputBytes: number;
  onObservation?: (value: any) => void | Promise<void>;
};
/** Called only by trusted controller composition. No model selects executable, argv, schemas or credentials. */
export async function runTrustedOperation<T extends { operationId: string; invocation_id: string } = Receipt>(configuration: HostConfiguration, runId: string, input: Record<string, unknown>, options: TrustedOperationOptions) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(runId) || typeof input.operationId !== 'string') throw new Error('Run and application operation identities required');
  if (!/^[a-z_]+\/\d+$/.test(options.operationName) || options.outputBytes > 49152 || options.timeoutMs > 600000) throw new Error('Invalid admitted operation bounds');
  const stateDir = resolve(options.stateDir ?? configuration.stateDir), project = join(stateDir, 'tool-projects', runId);
  const runtimeBytes = await readFile(options.runtimeBundle), runtimeHash = digest(runtimeBytes);
  const environment = { PATH: process.env.PATH, ...options.environment };
  const host = await pinnedHostIdentity(configuration);
  const identity = { host, operation: options.operationName, input, runtime: runtimeHash, inputSchema: options.inputSchema, outputSchema: options.outputSchema,
    environmentNames: Object.keys(options.environment ?? {}).sort(), arguments: options.arguments ?? [], timeoutMs: options.timeoutMs, outputBytes: options.outputBytes };
  await mkdir(project, { recursive: true });
  try { if (await readFile(join(project, 'identity.json'), 'utf8') !== JSON.stringify(identity)) throw new Error('Tool run already binds different input/context/runtime'); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; await writeFile(join(project, 'identity.json'), JSON.stringify(identity), { flag: 'wx' }); }
  await copyFile(options.runtimeBundle, join(project, 'broker.mjs'));
  await writeFile(join(project, 'input-schema.json'), JSON.stringify(options.inputSchema));
  await writeFile(join(project, 'output-schema.json'), JSON.stringify(options.outputSchema));
  await writeFile(join(project, 'input.json'), JSON.stringify(input));
  await writeFile(join(project, 'agents.json'), JSON.stringify({ version: 'mas-agents/3', agents: [{
    name: 'trusted_tool_broker', operation: options.operationName, input_schema: 'input-schema.json', output_schema: 'output-schema.json',
    environment: Object.keys(options.environment ?? {}),
    implementation: { kind: 'command', executable: process.execPath,
      arguments: [{ file: 'broker.mjs' }, { literal: '--invocation' }, { invocation_id: true }, ...(options.arguments ?? []).map(literal => ({ literal }))],
      stdin: 'json', stdout: 'json-object', success_exit_codes: [0], timeout_seconds: Math.ceil(options.timeoutMs / 1000), max_output_bytes: options.outputBytes },
  }], limits: { wall_seconds: Math.ceil(options.timeoutMs / 1000) + 15, max_calls: 1, max_messages: 8, max_bytes: 131072, mailbox_capacity: 4 } }));
  await writeFile(join(project, 'topology.json'), JSON.stringify({ version: 'mas-topology/1', edges: [['client', 'trusted_tool_broker'], ['trusted_tool_broker', 'client']] }));
  let observation: any = null, polling = false;
  const observe = async (payloads = false) => JSON.parse(await hostCommand(configuration.binary, ['observe', '--state', stateDir, '--run', runId, '--include-payloads', String(payloads)]));
  const timer = setInterval(() => { if (polling) return; polling = true; void observe().then(value => options.onObservation?.(value)).catch(() => {}).finally(() => { polling = false; }); }, 750);
  try {
    const value = JSON.parse(await hostCommand(configuration.binary, ['run', '--project', project, '--sdk-root', configuration.sdkRoot,
      '--agents', 'agents.json', '--topology', 'topology.json', '--agent', 'trusted_tool_broker', '--input', join(project, 'input.json'), '--state', stateDir, '--run', runId],
    { env: environment, timeout: options.timeoutMs + 30_000 }));
    observation = await observe(true);
    const receipt = value.output as T;
    const admitted = observation.steps.find((step: any) => step.kind === 'effect' && step.id === receipt.invocation_id);
    if (receipt.operationId !== input.operationId || !admitted || !['completed', 'resolved'].includes(admitted.state)) throw new Error('Application operation does not bind the completed host invocation');
    await writeFile(join(project, 'observation.json'), JSON.stringify(observation), { mode: 0o600 });
    return { receipt, observation, invocationIds: [receipt.invocation_id], calls: observation.calls.length };
  } catch {
    try { observation = await observe(true); await writeFile(join(project, 'observation.json'), JSON.stringify(observation), { mode: 0o600 }); } catch { /* The missing outcome remains unknown. */ }
    throw new HostPhaseError('Tool effect did not return a bound completed measurement; reconcile before repeating', runId, observation,
      !observation || observation.steps.some((step: any) => step.kind === 'effect' && ['executing', 'unknown', 'prepared'].includes(step.state)));
  } finally { clearInterval(timer); }
}
export type ToolOptions = { contextFile: string; runtimeBundle: string; stateDir?: string; onObservation?: (value: any) => void | Promise<void> };
export async function executeTool(configuration: HostConfiguration, runId: string, capabilityId: string, input: Record<string, unknown>, options: ToolOptions) {
  const capability = requireCapability(capabilityId), contextBytes = await readFile(options.contextFile);
  if (Buffer.byteLength(JSON.stringify(input)) > 18_000) throw new Error('Tool input exceeds framed input budget; use an admitted artefact reference');
  // Bind the context hash in the invocation input as an immutable file resource,
  // rather than pretending environment values are included in host bundle hashes.
  const context = JSON.parse(contextBytes.toString());
  if (context.runtimeDigest !== digest(await readFile(options.runtimeBundle))) throw new Error('Trusted tool runtime differs from frozen context');
  const stateDir = resolve(options.stateDir ?? configuration.stateDir), identityFile = join(stateDir, 'tool-contexts', runId + '.sha256');
  await mkdir(join(stateDir, 'tool-contexts'), { recursive: true });
  const contextHash = digest(contextBytes);
  try { if (await readFile(identityFile, 'utf8') !== contextHash) throw new Error('Tool run already binds different frozen context'); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; await writeFile(identityFile, contextHash, { flag: 'wx' }); }
  return runTrustedOperation(configuration, runId, input, {
    ...options, inputSchema: capability.inputSchema, outputSchema: capability.outputSchema,
    operationName: `${capabilityId}/${capability.version}`, timeoutMs: capability.timeoutMs, outputBytes: capability.outputBytes, arguments: [capabilityId],
    environment: { SELF_REMEDIATION_CONTEXT: resolve(options.contextFile), SELF_REMEDIATION_CONTEXT_SHA256: contextHash },
  });
}
