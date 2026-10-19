/** Recover only a completed, identity-bound native broker receipt. Never infer an external outcome. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hostCommand, pinnedHostIdentity, type HostConfiguration } from '../host/phase.js';
import { canonical } from '../deploy/effects.js';
import { Journal } from '../controller/journal.js';
import { receiptSchema, requireCapability } from '../tools/capabilities.js';
import type { Receipt, ToolContext } from '../tools/broker.js';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export class UnresolvedNativeEffect extends Error { readonly outcome = 'unknown_effect'; }
export interface NativeReconciliationOptions { directory: string; incidentId: string; runId: string; operationId: string; host: HostConfiguration }
interface HostPort {
  command: typeof hostCommand;
  identity: typeof pinnedHostIdentity;
}
async function immutable(path: string, bytes: string) {
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o400 }); }
  catch (error: any) { if (error.code !== 'EEXIST' || await readFile(path, 'utf8') !== bytes) throw new Error('Conflicting retained reconciliation proof'); }
}
async function contained(directory: string, path: string) {
  const root = await realpath(directory), actual = await realpath(path), name = relative(root, actual);
  if (!name || name.startsWith('..') || isAbsolute(name)) throw new Error('Recovery evidence is outside the original controller directory');
  return actual;
}
export function validateNativeReceipt(value: unknown, operation: string, invocation: string): asserts value is Receipt {
  const record = value as any, schema = receiptSchema;
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
    canonical(Object.keys(record).sort()) !== canonical(schema.required.slice().sort()) ||
    record.operationStatus !== 'COMPLETED' || !['passed','failed','inconclusive'].includes(record.measurement) ||
    record.operationId !== operation || record.invocation_id !== invocation ||
    !/^sha256:[0-9a-f]{64}$/.test(record.resultRef) || typeof record.summary !== 'string' || record.summary.length > 8192 ||
    operation.length > 160 || !/^[A-Za-z0-9._:-]{1,160}$/.test(invocation) || Buffer.byteLength(JSON.stringify(record)) > 12000)
    throw new Error('Completed native receipt violates its frozen identity or schema');
}
/** Public entry point for automatic process recovery. External publisher/trial effects are deliberately excluded. */
export async function reconcileNativeReceipt(options: NativeReconciliationOptions, port: HostPort = { command: hostCommand, identity: pinnedHostIdentity }) {
  const { incidentId, runId, operationId, host } = options, directory = resolve(options.directory);
  if (![incidentId,runId,operationId].every(value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) || runId.includes(':')) throw new Error('Exact bounded incident, run and operation identities are required');
  if (resolve(host.stateDir) !== join(directory,'host')) throw new Error('Recovery must use this controller directory’s original host state');
  const db = new DatabaseSync(join(directory,'journal.sqlite'), { readOnly: true });
  let dispatch: any;
  try {
    if (!db.prepare('SELECT id FROM incidents WHERE id=?').get(incidentId)) throw new Error('Unknown incident');
    const phase = db.prepare('SELECT * FROM phases WHERE id=? AND incident=?').get(runId,incidentId);
    const raw = db.prepare('SELECT value FROM values_store WHERE key=?').get(`runtime:dispatch:${runId}`);
    if (!phase || !raw) throw new UnresolvedNativeEffect('No retained native dispatch binds this incident and run');
    dispatch = JSON.parse(String(raw.value));
    if (dispatch.kind !== 'tool' || dispatch.operation !== runId || dispatch.input?.operationId !== operationId || !dispatch.contextFile)
      throw new UnresolvedNativeEffect('This utility only recovers exact native broker operations; external effects require their own reconciliation adapter');
    if (canonical(dispatch.identity) !== phase.identity) throw new Error('Outer phase identity differs from retained dispatch');
  } finally { db.close(); }
  const contextFile = await contained(directory,dispatch.contextFile), contextBytes = await readFile(contextFile);
  const context = JSON.parse(contextBytes.toString()) as ToolContext;
  if (resolve(context.journalPath) !== join(directory,'tool-effects.sqlite') || resolve(context.artefactRoot) !== join(directory,'tool-artefacts')) throw new Error('Unadmitted native receipt storage');
  const contextHash = digest(contextBytes), contextBinding = await readFile(join(host.stateDir,'tool-contexts',runId+'.sha256'),'utf8');
  if (contextHash !== contextBinding || dispatch.identity.context !== contextHash) throw new Error('Frozen native context changed');
  const project = join(host.stateDir,'tool-projects',runId), identity = JSON.parse(await readFile(join(project,'identity.json'),'utf8'));
  const currentHost = await port.identity(host), capability = requireCapability(dispatch.capability);
  if (canonical(identity.host) !== canonical(currentHost) || identity.operation !== `${capability.id}/${capability.version}` ||
    canonical(identity.input) !== canonical(dispatch.input) || canonical(identity.outputSchema) !== canonical(capability.outputSchema) ||
    canonical(identity.inputSchema) !== canonical(capability.inputSchema) || identity.runtime !== context.runtimeDigest ||
    digest(await readFile(join(project,'broker.mjs'))) !== identity.runtime) throw new Error('Retained host, tool, schema or dispatch identity changed');
  const tools = new DatabaseSync(context.journalPath, { readOnly: true });
  let row: any;
  try { row = tools.prepare('SELECT * FROM tool_effects WHERE operation_id=?').get(operationId); }
  finally { tools.close(); }
  if (!row || row.state !== 'completed' || typeof row.receipt !== 'string') throw new UnresolvedNativeEffect('Native execution has no durable completed receipt. Its outcome remains unknown; no resolution was written');
  const expectedInputHash = digest(JSON.stringify({capabilityId:dispatch.capability,input:JSON.parse(canonical(dispatch.input)),tree:context.snapshot.tree,registryDigest:context.registryDigest}));
  if (row.capability !== dispatch.capability || row.input_hash !== expectedInputHash) throw new Error('Native receipt belongs to another capability, source or input');
  const receipt = JSON.parse(row.receipt);
  validateNativeReceipt(receipt,operationId,row.invocation_id);
  const resultBytes = await readFile(await contained(context.artefactRoot,join(context.artefactRoot,receipt.resultRef.slice(7)+'.json')));
  if (digest(resultBytes) !== receipt.resultRef.slice(7)) throw new Error('Native result artefact differs from the completed receipt');
  const measured=JSON.parse(resultBytes.toString());
  if ((measured.status??'inconclusive')!==receipt.measurement) throw new Error('Native receipt measurement contradicts its retained result');
  const observation = JSON.parse(await port.command(host.binary,['observe','--state',host.stateDir,'--run',runId,'--include-payloads','true']));
  const effect = observation.steps?.find((step: any) => step.kind === 'effect' && step.id === receipt.invocation_id);
  if (observation.run_id !== runId || !effect || effect.actor !== 'trusted_tool_broker' || effect.input?.format !== 'mas-command/2' ||
    canonical(effect.input.input) !== canonical(dispatch.input) || !observation.calls?.some((call: any) => call.id === effect.id && call.actor === effect.actor))
    throw new Error('Native receipt does not identify the original admitted host command');
  const wrapper = {status:'completed',output:receipt};
  if (!['unknown','executing','completed','resolved'].includes(effect.state)) throw new UnresolvedNativeEffect('Host effect is not eligible for completed-receipt recovery');
  if (['completed','resolved'].includes(effect.state) && canonical(effect.output) !== canonical(wrapper)) throw new Error('Host already retains a conflicting outcome');
  const bundle = join(project,'.mas/build/bundle.json'), bundleBytes=await readFile(bundle), bundleDigest = digest(bundleBytes);
  const retainedActor=JSON.parse(bundleBytes.toString()).agents?.find((actor:any)=>actor.name==='trusted_tool_broker');
  if (!retainedActor?.configuration || digest(canonical(retainedActor.configuration))!==effect.input.configuration_sha256) throw new Error('Host effect configuration differs from the retained command bundle');
  const proof = {version:'self-remediation-native-reconciliation/1',incidentId,runId,operationId,invocation_id:receipt.invocation_id,
    authority:'completed application-owned native receipt',capability:dispatch.capability,sourceTree:context.snapshot.tree,
    inputSha256:row.input_hash,receiptSha256:digest(row.receipt),resultSha256:digest(resultBytes),contextSha256:contextHash,bundleSha256:bundleDigest,host:currentHost};
  const proofBytes = canonical(proof), proofDigest = digest(proofBytes), proofDirectory = join(directory,'reconciliation',runId,receipt.invocation_id);
  await mkdir(proofDirectory,{recursive:true,mode:0o700});
  const outputPath = join(proofDirectory,'output.json'), proofPath = join(proofDirectory,'evidence.json');
  await immutable(outputPath,canonical(wrapper)); await immutable(proofPath,proofBytes); await immutable(join(proofDirectory,'receipt.json'),row.receipt);
  if (['unknown','executing'].includes(effect.state)) await port.command(host.binary,['resolve','--state',host.stateDir,'--run',runId,'--effect',receipt.invocation_id,'--output',outputPath,'--evidence',proofPath]);
  else if (effect.state === 'resolved' && canonical(effect.evidence) !== proofBytes) throw new Error('Effect was resolved using different evidence; preserve that original resolution');
  // Cached-effect replay invokes the pinned command adapter's schema validation.
  // It cannot execute the resolved native command again or extend its deadline.
  let requestCompleted = false;
  try {
    const resumed = JSON.parse(await port.command(host.binary,['run','--bundle',bundle,'--agent','trusted_tool_broker','--input',join(project,'input.json'),'--state',host.stateDir,'--run',runId],{timeout:15_000}));
    if (canonical(resumed.output) !== canonical(receipt)) throw new Error('Recovered host output differs from the evidenced native receipt');
    requestCompleted = true;
  } catch (error) {
    const after = JSON.parse(await port.command(host.binary,['observe','--state',host.stateDir,'--run',runId,'--include-payloads','true']));
    const retained = after.steps?.find((step: any) => step.id === receipt.invocation_id);
    if (!retained || !['completed','resolved'].includes(retained.state) || canonical(retained.output) !== canonical(wrapper)) throw error;
    // Cancellation/expiry may prevent task completion while the observed outcome remains retained.
    if (!after.cancelled && !after.run?.expired && Date.now()/1000 < (after.run?.deadline ?? 0)) throw error;
  }
  const result = {status:'resolved',incidentId,runId,operationId,invocation_id:receipt.invocation_id,measurement:receipt.measurement,
    requestCompleted,proofRef:`sha256:${proofDigest}`,proofPath,resultRef:receipt.resultRef,
    next:requestCompleted?'Restart the original controller with the same output directory and incident':'Outcome retained; the original cancellation or deadline still blocks execution'};
  const journal = Journal.open(directory,incidentId);
  try {
    const key = `native-reconciliation:${runId}:${receipt.invocation_id}`;
    if (!journal.value(key)) { journal.put(key,proof); journal.append('effect.reconciled',result); journal.checkpoint(); }
  } finally { journal.close(); }
  return result;
}
async function main() {
  const {values} = parseArgs({options:{output:{type:'string'},incident:{type:'string'},run:{type:'string'},operation:{type:'string'}}});
  if (!values.output || !values.incident || !values.run || !values.operation) throw new Error('Required: --output DIRECTORY --incident ID --run HOST_RUN --operation OPERATION_ID');
  const directory=resolve(values.output), host={binary:process.env.MAS_HOST_BIN??resolve('../../.tools/mas-host/target/debug/mas-host'),sdkRoot:process.env.MAS_SDK_ROOT??resolve('../../.tools/mas-host'),stateDir:join(directory,'host')};
  const result=await reconcileNativeReceipt({directory,incidentId:values.incident,runId:values.run,operationId:values.operation,host});
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{process.stderr.write(JSON.stringify({outcome:error instanceof UnresolvedNativeEffect?'unknown_effect':'recovery_rejected',reason:error instanceof Error?error.message:String(error)})+'\n');process.exitCode=1;});
