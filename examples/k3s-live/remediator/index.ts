import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { InClusterKubernetesClient } from '../operator/client.js';
import { NAMESPACE, RemediationController, type ResolutionReport, type Snapshot } from './controller.js';
import { createRemediationTransport } from './transport.js';

const namespace = process.env.MAS_NAMESPACE;
if (namespace !== NAMESPACE) throw new Error('MAS_NAMESPACE must be mas-demo for the readiness remediation policy');
const configuredBackend = process.env.MAS_DEMO_API_URL;
if (configuredBackend && configuredBackend !== 'http://mas-demo.mas-demo.svc:8080') {
  throw new Error('MAS_DEMO_API_URL must identify the fixed mas-demo Service');
}
const podUID = process.env.POD_UID;
const podName = process.env.POD_NAME;
if (!podUID || !podName) throw new Error('POD_UID and POD_NAME must identify the controller Pod');
const host = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443';
const authority = host.includes(':') ? `[${host}]` : host;
const client = new InClusterKubernetesClient(`https://${authority}:${port}`);
const transport = createRemediationTransport({ client, namespace, verifierToken: process.env.DEMO_VERIFIER_TOKEN ?? '' });
// The deployed JavaScript implementation is copied beside dist/, preserving a
// single admission/verification implementation for controller and CLI callers.
const module = await import(new URL('../../deploy/remediation.mjs', import.meta.url).href) as {
  resolveIncident(snapshot: Snapshot, options: { kubectl(args: string[]): Promise<string>; namespaceUID: string;
    operationId: string; attemptId: string; isDefiniteRejection(error: unknown): boolean;
    enabled: boolean; beforePatch(report: ResolutionReport): Promise<void> }): Promise<ResolutionReport>;
};
const enabled = process.env.DEMO_AUTO_REMEDIATE === 'true';
const controller = new RemediationController(client, transport,
  (snapshot, options) => module.resolveIncident(snapshot, { ...options, enabled: true, kubectl: transport.kubectl, isDefiniteRejection: transport.isDefiniteRejection }),
  { namespace, enabled, ownerId: randomUUID(), podUID, podName });
console.log(`MAS remediation controller: ${enabled ? 'enabled for both managed readiness corrections' : 'disabled'}`);
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
while (!stop.signal.aborted) {
  try { await controller.tick(); }
  catch (error) { console.error('Remediation reconciliation will retry:', error instanceof Error ? error.message : 'Unexpected error'); }
  try { await setTimeout(3000, undefined, { signal: stop.signal }); }
  catch { /* Shutdown interrupts only the polling delay, never an effect journal. */ }
}
