import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { APIError, type DemoAPI, type EventEvidence, type KubernetesAPI, type RunState } from './controller.js';
import type { EvidenceBundle } from '../shared/evidence.js';

export class InClusterKubernetesClient implements KubernetesAPI {
  constructor(private readonly baseURL: string,
    private readonly tokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token',
    private readonly caPath = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt') {
    if (new URL(baseURL).protocol !== 'https:') throw new Error('Kubernetes API requires HTTPS');
  }

  async list<T>(path: string): Promise<T[]> {
    const result: T[] = [];
    let continuation = '';
    for (let page = 0; page < 10; page += 1) {
      const url = new URL(path, this.baseURL);
      url.searchParams.set('limit', '200');
      if (continuation) url.searchParams.set('continue', continuation);
      const body = await this.call<{ items: T[]; metadata?: { continue?: string } }>('GET', url);
      result.push(...body.items);
      continuation = body.metadata?.continue ?? '';
      if (!continuation) return result;
    }
    throw new Error('Kubernetes list exceeded 2000 items; use a dedicated demo namespace');
  }

  get<T>(path: string): Promise<T> { return this.call('GET', new URL(path, this.baseURL)); }
  text(path: string, maxBytes = 4096): Promise<string> {
    return this.call<string>('GET', new URL(path, this.baseURL), undefined, true, Math.min(8192, maxBytes));
  }
  create<T>(path: string, resource: unknown): Promise<T> {
    return this.call('POST', new URL(path, this.baseURL), resource);
  }
  async status(path: string, status: unknown): Promise<void> {
    await this.call('PATCH', new URL(path, this.baseURL), { status });
  }

  private call<T>(method: string, url: URL, body?: unknown, plainText = false, maxBytes = 8 * 1024 * 1024): Promise<T> {
    // Projected tokens rotate; read the current token for every request.
    const token = readFileSync(this.tokenPath, 'utf8').trim();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(url, {
        method, ca: readFileSync(this.caPath), timeout: 10_000,
        headers: { authorization: `Bearer ${token}`, accept: plainText ? 'text/plain' : 'application/json',
          ...(payload ? { 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json',
            'content-length': Buffer.byteLength(payload) } : {}) },
      }, response => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          data += chunk;
          if (Buffer.byteLength(data) > maxBytes) req.destroy(new Error('Kubernetes response exceeds byte limit'));
        });
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new APIError(response.statusCode ?? 500, `Kubernetes API ${method} ${url.pathname}: ${response.statusCode}`));
            return;
          }
          try { resolve((plainText ? data : JSON.parse(data)) as T); } catch (error) { reject(error); }
        });
        response.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Kubernetes request timed out')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

export class LocalDemoClient implements DemoAPI {
  constructor(private readonly baseURL: string) {
    const url = new URL(baseURL);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('MAS_DEMO_API_URL must point to the backend in the same pod');
    }
  }

  async get(id: string): Promise<RunState | undefined> {
    const response = await fetch(new URL(`/api/runs/${encodeURIComponent(id)}`, this.baseURL),
      { signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new APIError(response.status, `Demo API returned ${response.status}`);
    return await response.json() as RunState;
  }

  async start(input: { id: string; scenario: 'pod-incident' | 'pod-crash'; event?: EventEvidence; evidence?: EvidenceBundle }): Promise<RunState> {
    const response = await fetch(new URL('/api/runs', this.baseURL), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new APIError(response.status, `Demo API returned ${response.status}`);
    return await response.json() as RunState;
  }
}
