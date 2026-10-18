import { sha256 } from './projection.js';
export type EffectClass = 'read' | 'isolated-write' | 'isolated-execution' | 'external-write';
export interface Capability {
  id: string; version: number; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
  implementation: string; resources: readonly string[]; effectClass: EffectClass; timeoutMs: number; outputBytes: number;
  credentialOwner: 'none' | 'trusted-builder' | 'trusted-publisher' | 'trusted-trial'; reconciliation: string;
}
export const receiptSchema = { type: 'object', additionalProperties: false, required: ['operationStatus', 'measurement', 'operationId', 'invocation_id', 'resultRef', 'summary'], properties: {
  operationStatus: { type: 'string', enum: ['COMPLETED'] }, measurement: { type: 'string', enum: ['passed', 'failed', 'inconclusive'] },
  operationId: { type: 'string', maxLength: 160 }, invocation_id: { type: 'string', maxLength: 160 }, resultRef: { type: 'string', maxLength: 80 }, summary: { type: 'string', maxLength: 8192 },
} };
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', additionalProperties: false, properties: { operationId: { type: 'string', maxLength: 160 }, ...properties }, required: ['operationId', ...required] });
const path = { type: 'string', maxLength: 100 };
function capability(id: string, inputSchema: Record<string, unknown>, effectClass: EffectClass, implementation: string, resources = ['incident-snapshot'], credentialOwner: Capability['credentialOwner'] = 'none'): Capability {
  return { id, version: 1, inputSchema, outputSchema: receiptSchema, implementation, resources, effectClass, timeoutMs: effectClass === 'isolated-execution' ? 60000 : 15000, outputBytes: 12000, credentialOwner, reconciliation: 'Look up durable operationId plus admitted invocation_id in tool_effects; unresolved effects block all new phase dispatch' };
}
export const capabilities: readonly Capability[] = Object.freeze([
  capability('source_read', object({ path }, ['path']), 'read', 'native:projected-file'),
  capability('source_search', object({ pattern: { type: 'string', maxLength: 256 } }, ['pattern']), 'read', 'native:literal-projected-search'),
  capability('custom_mcp_read', object({ path }, ['path']), 'read', 'mcp:self-remediation/source_read@1'),
  capability('source_edit', object({ edits: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path, content: { anyOf: [{ type: 'string', maxLength: 20000 }, { type: 'null' }] } } } } }, ['edits']), 'isolated-write', 'native:new-immutable-source-snapshot'),
  capability('build', object({}, []), 'isolated-execution', 'native:trusted-container-builder', ['incident-snapshot', 'bounded-container'], 'trusted-builder'),
  capability('test', object({}, []), 'isolated-execution', 'native:protected-http-verifier', ['immutable-candidate-image', 'protected-checks'], 'trusted-builder'),
  capability('diagnostic_program', object({ program: { type: 'string', maxLength: 16384 } }, ['program']), 'isolated-execution', 'native:credential-free-container', ['incident-snapshot', 'bounded-container'], 'trusted-builder'),
]);
export const registryDigest = sha256(JSON.stringify(capabilities));
export function requireCapability(id: string): Capability { const found = capabilities.find(x => x.id === id); if (!found) throw new Error('Capability was not admitted'); return found; }
/** The frozen JSON schemas are also supplied to MAS. No discovery result grants authority. */
export function validateInput(capability: Capability, input: unknown): asserts input is Record<string, any> {
  function valid(schema: any, value: any): boolean {
    if (schema.anyOf) return schema.anyOf.some((child: any) => valid(child, value));
    if (schema.type === 'null') return value === null;
    if (schema.type === 'string') return typeof value === 'string' && value.length <= schema.maxLength && !value.includes('\0');
    if (schema.type === 'array') return Array.isArray(value) && value.length <= schema.maxItems && value.every(x => valid(schema.items, x));
    if (schema.type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value) && schema.required.every((key: string) => key in value) && Object.keys(value).every(key => schema.properties[key] && valid(schema.properties[key], value[key]));
    return false;
  }
  if (!valid(capability.inputSchema, input)) throw new Error('Tool input violates frozen schema');
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test((input as any).operationId)) throw new Error('Invalid operation identity');
}
