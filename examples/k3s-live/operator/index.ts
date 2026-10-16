import { setTimeout } from 'node:timers/promises';
import { DemoController } from './controller.js';
import { InClusterKubernetesClient, LocalDemoClient } from './client.js';

const namespace = process.env.MAS_NAMESPACE;
if (!namespace) throw new Error('MAS_NAMESPACE is required');
const host = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443';
const authority = host.includes(':') ? `[${host}]` : host;
const controller = new DemoController(
  new InClusterKubernetesClient(`https://${authority}:${port}`),
  new LocalDemoClient(process.env.MAS_DEMO_API_URL ?? 'http://127.0.0.1:8080'),
  { namespace },
);
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
while (!stop.signal.aborted) {
  try { await controller.tick(); }
  catch (error) { console.error('Reconciliation will retry:', error instanceof Error ? error.message : String(error)); }
  try { await setTimeout(3000, undefined, { signal: stop.signal }); }
  catch { /* Shutdown interrupts only the polling delay. */ }
}
