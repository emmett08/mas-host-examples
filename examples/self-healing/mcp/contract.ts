/** Bind the MCP entry point to one operator-prepared incident and execution grant. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { canonical, sha256 } from '../deploy/effects.js';
import type { Budget } from '../contracts/types.js';

export interface Admission {
  version: 'self-healing-mcp/1';
  profile: 'k3s' | 'boundary-control';
  incidentId: string;
  directory: string;
  example: string;
  repository: string;
  sourceRevision: string;
  host: string;
  gatewayState: string;
  node: string;
  controller: string;
  arguments: string[];
  environment: Record<string, string>;
  credentialNames: string[];
  files: Record<string, string>;
  directories: string[];
  /** Exact paths relative to an inventory root which its consumer does not read. */
  directoryExclusions?: Record<string, string[]>;
  limits: Budget;
  mode: 'fixture' | 'live';
  publication: 'archive' | 'pull-request';
  requirementsDigest: string;
  policyDigest: string;
}
export interface Request {
  incident_id: string;
  contract_digest: string;
  request_id?: string;
  after?: number;
}
export interface Dispatch { requestId: string; invocationId: string; contractDigest: string }
export const rawDigest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const admissionDigest = (admission: Admission): string => sha256(admission);
export function validateRequest(admission: Admission, request: Request, operation: string): void {
  const allowed = ['incident_id', 'contract_digest', ...(operation === 'run' ? ['request_id'] : operation === 'status' ? ['after'] : [])];
  if (Object.keys(request).some(key => !allowed.includes(key)) || request.incident_id !== admission.incidentId ||
      request.contract_digest !== admissionDigest(admission)) throw new Error('Incident or frozen contract mismatch');
  if (operation === 'run' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(request.request_id ?? '')) throw new Error('Bounded MCP request identity required');
  if (request.after !== undefined && (!Number.isSafeInteger(request.after) || request.after < 0)) throw new Error('Invalid event cursor');
}
export function verifyFiles(admission: Admission): void {
  for (const root of admission.directories) {
    const expected = Object.keys(admission.files).filter(file => file.startsWith(root + sep)).sort();
    if (canonical(dependencyFiles(root, admission.directoryExclusions?.[root])) !== canonical(expected)) throw new Error('Prepared dependency inventory changed');
  }
  for (const [file, digest] of Object.entries(admission.files)) {
    if (rawDigest(readFileSync(file)) !== digest) throw new Error('Prepared execution dependency changed');
  }
}
export function dependencyFiles(root: string, exclusions: readonly string[] = []): string[] {
  const excluded = new Set(exclusions);
  const walk = (directory: string, relative = ''): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (excluded.has(path)) return [];
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Prepared dependencies must be regular files');
    return entry.isDirectory() ? walk(file, path) : entry.isFile() ? [file] : [];
  });
  return walk(root).sort();
}
export function inputSchema(admission: Admission, operation: 'run' | 'status' | 'cancel') {
  const properties: Record<string, unknown> = {
    incident_id: { type: 'string', enum: [admission.incidentId] },
    contract_digest: { type: 'string', enum: [admissionDigest(admission)] },
  };
  const required = ['incident_id', 'contract_digest'];
  if (operation === 'run') { properties.request_id = { type: 'string', minLength: 1, maxLength: 120 }; required.push('request_id'); }
  if (operation === 'status') properties.after = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
  return { type: 'object', additionalProperties: false, properties, required };
}
export const outputSchema = { type: 'object', additionalProperties: false,
  properties: { incident_id: { type: 'string' }, contract_digest: { type: 'string' }, invocation_id: { type: 'string' },
    snapshot_json: { type: 'string' } }, required: ['incident_id', 'contract_digest', 'invocation_id', 'snapshot_json'] };
export { canonical };
