import type { Capability } from '../tools/capabilities.js';
/** External capabilities are admitted by trusted controller composition, never by model tool discovery. */
export const externalReceiptSchema = { type: 'object', required: ['operationId', 'invocation_id', 'status', 'result'], additionalProperties: false,
  properties: { operationId: { type: 'string', maxLength: 200 }, invocation_id: { type: 'string', maxLength: 200 },
    status: { type: 'string', enum: ['COMPLETED'] }, result: { type: 'object' } } };
const envelope = { type: 'object', additionalProperties: false, required: ['operationId', 'requestFile', 'requestSha256'], properties: {
  operationId: { type: 'string', maxLength: 200 }, requestFile: { type: 'string', maxLength: 1024 }, requestSha256: { type: 'string', maxLength: 64 } } };
export const externalCapabilities: readonly Capability[] = Object.freeze([
  { id: 'github_metadata', version: 1, inputSchema: envelope, outputSchema: externalReceiptSchema,
    implementation: 'mcp:official-github/actions_get@get_workflow_run', resources: ['one-admitted-repository', 'one-exact-workflow-run-and-source-revision'],
    effectClass: 'read', timeoutMs: 60000, outputBytes: 12000, credentialOwner: 'trusted-publisher',
    reconciliation: 'Read-only metadata repeated only in a new explicit phase; MCP transport loss remains host-uncertain' },
  { id: 'publish', version: 1, inputSchema: envelope, outputSchema: externalReceiptSchema,
    implementation: 'native:trusted-publisher/rest-github', resources: ['one-repository', 'exact-base-ref', 'admitted-application-path-projection'],
    effectClass: 'external-write', timeoutMs: 300000, outputBytes: 32768, credentialOwner: 'trusted-publisher',
    reconciliation: 'SQLite effect intention; exact Git object/ref, PR head/base/marker and merge SHA reconciliation before any repetition' },
  { id: 'trial', version: 1, inputSchema: envelope, outputSchema: externalReceiptSchema,
    implementation: 'native:kubectl-isolated-k3s', resources: ['disposable-namespace', 'exact-UID-resourceVersion', 'immutable-image-digest'],
    effectClass: 'external-write', timeoutMs: 300000, outputBytes: 32768, credentialOwner: 'trusted-trial',
    reconciliation: 'Kubernetes owner, operation/invocation annotation, target UID and image/source digest, plus fresh protected observations' },
  { id: 'operational_observe', version: 1, inputSchema: envelope, outputSchema: externalReceiptSchema,
    implementation: 'native:kubectl-exact-release-metadata', resources: ['exact-namespace-deployment-UID', 'exact-Pod-UID', 'Pod-owner-ReplicaSet', 'optional-exact-trigger-Event'],
    effectClass: 'read', timeoutMs: 60000, outputBytes: 12000, credentialOwner: 'trusted-trial',
    reconciliation: 'Retained host invocation outcome; fresh explicitly admitted read checks source/image/configuration/generation and owner chain' },
]);
