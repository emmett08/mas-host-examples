import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { applyEdits, checkPath, sha256, verifySnapshot, type Snapshot } from './projection.js';
import { registryDigest, requireCapability, validateInput } from './capabilities.js';
import { DockerSandbox, UnknownExecution, type BuildIdentity, type BuildResult, type HTTPCheck } from '../sandbox/executor.js';
import { customMcpRead } from './mcp-server.js';
export type ToolContext = { snapshot: Snapshot; journalPath: string; artefactRoot: string; registryDigest: string; builderImage?: string; runtimeBundle: string; runtimeDigest: string; identity?: BuildIdentity; assessmentIdentity?: BuildIdentity; buildResult?: BuildResult; protectedChecks?: HTTPCheck[]; protectedSuiteDigest?: string };
export type Receipt = { operationStatus: 'COMPLETED'; measurement: 'passed' | 'failed' | 'inconclusive'; operationId: string; invocation_id: string; resultRef: string; summary: string };
export async function readContext(environment: NodeJS.ProcessEnv = process.env): Promise<ToolContext> {
  const path = environment.SELF_REMEDIATION_CONTEXT, digest = environment.SELF_REMEDIATION_CONTEXT_SHA256;
  if (!path || !digest || !path.startsWith('/')) throw new Error('Frozen controller context required');
  const bytes = await readFile(path); if (sha256(bytes) !== digest) throw new Error('Tool context identity changed');
  const context = JSON.parse(bytes.toString()) as ToolContext;
  if (context.registryDigest !== registryDigest || sha256(await readFile(context.runtimeBundle)) !== context.runtimeDigest) throw new Error('Tool implementation or authority changed');
  await verifySnapshot(context.snapshot); return context;
}
export async function projectedRead(snapshot: Snapshot, path: string) { checkPath(path, snapshot.projection); if (!(path in snapshot.files)) return { status: 'failed' as const, reason: 'Admitted file does not exist', path }; return { status: 'passed' as const, path, text: snapshot.files[path], tree: snapshot.tree }; }
export async function dispatch(context: ToolContext, capabilityId: string, input: unknown, invocationId: string): Promise<Receipt> {
  const capability = requireCapability(capabilityId); validateInput(capability, input);
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(invocationId)) throw new Error('Admitted host invocation identity required');
  await verifySnapshot(context.snapshot);
  await mkdir(dirname(context.journalPath), { recursive: true }); await mkdir(context.artefactRoot, { recursive: true });
  const db = new DatabaseSync(context.journalPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS tool_effects (operation_id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL, capability TEXT NOT NULL, input_hash TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT);');
  const inputHash = sha256(JSON.stringify({ capabilityId, input, tree: context.snapshot.tree, registryDigest: context.registryDigest }));
  try {
    db.exec('BEGIN IMMEDIATE');
    const existing = db.prepare('SELECT * FROM tool_effects WHERE operation_id=?').get(input.operationId) as any;
    if (existing) {
      db.exec('ROLLBACK');
      if (existing.invocation_id !== invocationId || existing.input_hash !== inputHash) throw new Error('Operation identity reuse or new phase attempted to evade an earlier effect');
      if (existing.state !== 'completed') throw new UnknownExecution('Previous tool outcome unresolved; reconcile before repeating');
      return JSON.parse(existing.receipt);
    }
    // A phase cannot bypass any earlier unresolved application tool effect.
    if (db.prepare("SELECT operation_id FROM tool_effects WHERE state!='completed' LIMIT 1").get()) { db.exec('ROLLBACK'); throw new UnknownExecution('An earlier effect requires reconciliation'); }
    db.prepare('INSERT INTO tool_effects VALUES (?,?,?,?,?,NULL)').run(input.operationId, invocationId, capabilityId, inputHash, 'dispatched'); db.exec('COMMIT');
    let result: any;
    let boundaryFailure: string | undefined;
    try {
      if (['source_read', 'custom_mcp_read'].includes(capabilityId)) checkPath(input.path!, context.snapshot.projection);
      if (capabilityId === 'source_edit') for (const edit of input.edits) checkPath(edit.path, context.snapshot.projection, true);
    } catch (error) { boundaryFailure = error instanceof Error ? error.message : 'Resource not admitted'; }
    if (boundaryFailure) result = { status: 'failed', kind: 'policy_boundary', reason: boundaryFailure };
    else if (capabilityId === 'source_read') result = await projectedRead(context.snapshot, input.path!);
    else if (capabilityId === 'source_search') { const matches = Object.entries(context.snapshot.files).flatMap(([path,text]) => text.split('\n').flatMap((line, index) => line.includes(input.pattern!) ? [{ path, line: index + 1, text: line.slice(0,512) }] : [])); result = { status: 'passed', tree: context.snapshot.tree, matches: matches.slice(0,32), total: matches.length, truncated: matches.length > 32 }; }
    else if (capabilityId === 'custom_mcp_read') result = await customMcpRead(context, input.path!);
    else if (capabilityId === 'source_edit') result = { status: 'passed', snapshot: await applyEdits(context.snapshot, input.edits) };
    else if (capabilityId === 'build') {
      if (!context.builderImage || !context.identity) throw new Error('Frozen builder identity required');
      result = await new DockerSandbox(context.builderImage).build(context.snapshot, { ...context.identity, operationId: input.operationId });
    } else if (capabilityId === 'test') {
      if (!context.builderImage || !context.buildResult || !context.protectedChecks || sha256(JSON.stringify(context.protectedChecks)) !== context.protectedSuiteDigest) throw new Error('Protected suite identity required');
      const assessment = context.assessmentIdentity ?? context.buildResult.identity;
      if (context.buildResult.tree !== context.snapshot.tree || assessment.candidateTree !== context.snapshot.tree || assessment.tests !== context.protectedSuiteDigest || ['baseCommit', 'requirements', 'environment'].some(key => (assessment as any)[key] !== (context.buildResult!.identity as any)[key])) throw new Error('Stale candidate, requirement, environment or test identity');
      result = { ...await new DockerSandbox(context.builderImage).evaluate(context.buildResult, context.protectedChecks, input.operationId), assessmentIdentity: assessment, buildIdentity: context.buildResult.identity };
    }
    else if (capabilityId === 'diagnostic_program') {
      if (!context.builderImage) throw new Error('No admitted sandbox toolchain');
      result = await new DockerSandbox(context.builderImage).experiment(context.snapshot, input.program!, input.operationId);
    } else throw new Error('No registered implementation');
    const bytes = JSON.stringify(result), digest = sha256(bytes), reference = `sha256:${digest}`;
    const artefactPath = join(context.artefactRoot, digest + '.json');
    await writeFile(artefactPath, bytes, { mode: 0o400, flag: 'wx' }).catch(async error => { if (error.code !== 'EEXIST') throw error; if (sha256(await readFile(artefactPath)) !== digest) throw new Error('Existing retained artefact failed its content hash'); });
    const receipt: Receipt = { operationStatus: 'COMPLETED', measurement: result.status ?? 'inconclusive', operationId: input.operationId!, invocation_id: invocationId, resultRef: reference, summary: Buffer.byteLength(bytes) <= 8192 ? bytes : JSON.stringify({ status: result.status, tree: context.snapshot.tree, truncated: true, resultRef: reference }) };
    if (Buffer.byteLength(JSON.stringify(receipt)) > capability.outputBytes) throw new Error('Receipt exceeds host boundary');
    db.prepare('UPDATE tool_effects SET state=?,receipt=? WHERE operation_id=?').run('completed', JSON.stringify(receipt), input.operationId);
    return receipt;
  } finally { db.close(); }
}
/** Reconciliation is an explicit trusted-controller action, never an LLM tool. */
export function reconcileTool(journalPath: string, operationId: string, invocationId: string, receipt: Receipt, evidence: string) {
  if (!evidence || receipt.operationId !== operationId || receipt.invocation_id !== invocationId) throw new Error('Exact externally evidenced receipt required');
  const db = new DatabaseSync(journalPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS tool_reconciliations (operation_id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL, evidence TEXT NOT NULL)');
    db.exec('BEGIN IMMEDIATE');
    const changed = db.prepare("UPDATE tool_effects SET state='completed',receipt=? WHERE operation_id=? AND invocation_id=? AND state!='completed'").run(JSON.stringify(receipt), operationId, invocationId);
    if (changed.changes === 1) { db.prepare('INSERT INTO tool_reconciliations VALUES (?,?,?)').run(operationId, invocationId, evidence); db.exec('COMMIT'); } else db.exec('ROLLBACK');
    if (changed.changes !== 1) throw new Error('Unknown or already resolved operation');
  } finally { db.close(); }
}
