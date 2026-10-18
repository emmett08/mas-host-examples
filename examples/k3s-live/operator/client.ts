import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { APIError, type DemoAPI, type KubernetesAPI, type RunState } from './controller.js';

// API Status messages can embed the rejected resource, including its logs. Keep
// diagnostic codes and field paths, and classify familiar validation messages;
// never print response.message, raw causes or the request/response body.
export function safeKubernetesErrorDetails(body: string): string {
  try {
    const value = JSON.parse(body) as { reason?: unknown; details?: { causes?: unknown } };
    const reason = typeof value.reason === 'string' && /^[A-Za-z]{1,40}$/.test(value.reason) ? value.reason : 'APIError';
    const causes = Array.isArray(value.details?.causes) ? value.details.causes.slice(0, 4).map((cause: unknown) => {
      if (!cause || typeof cause !== 'object') return 'unspecified cause';
      const row = cause as Record<string, unknown>;
      const type = typeof row.reason === 'string' && /^[A-Za-z]{1,40}$/.test(row.reason) ? row.reason : 'Validation';
      const field = typeof row.field === 'string' && /^[A-Za-z0-9_.\[\]-]{1,160}$/.test(row.field) ? row.field : 'resource';
      const message = typeof row.message === 'string' ? row.message : '';
      const hint = /Create a new MASDemoRun|self == oldSelf/.test(message) ? ' (immutable spec check failed)'
        : /no matching overload|invalid data|evaluation failed/.test(message) ? ' (CEL evaluation failed)'
          : /Required value|required property/.test(message) ? ' (required field missing)' : '';
      return `${type}@${field}${hint}`;
    }) : [];
    return `${reason}${causes.length ? `; ${causes.join(', ')}` : ''}`;
  } catch { return 'Unparseable API error response'; }
}

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

  patchJSON<T>(path: string, patch: unknown[]): Promise<T> {
    return this.call('PATCH', new URL(path, this.baseURL), patch, false, 8 * 1024 * 1024,
      'application/json-patch+json');
  }

  replace<T>(path: string, resource: unknown): Promise<T> {
    if (!resource || typeof resource !== 'object' || !('metadata' in resource) ||
        !resource.metadata || typeof resource.metadata !== 'object' ||
        !('resourceVersion' in resource.metadata) || typeof resource.metadata.resourceVersion !== 'string' ||
        !resource.metadata.resourceVersion) {
      throw new Error('Kubernetes replacement requires a resourceVersion precondition');
    }
    return this.call('PUT', new URL(path, this.baseURL), resource);
  }

  replaceStatusCAS<T>(path: string, resource: unknown): Promise<T> {
    if (!path.endsWith('/status')) throw new Error('Status replacement requires a status subresource');
    return this.replace<T>(path, resource);
  }

  private call<T>(method: string, url: URL, body?: unknown, plainText = false, maxBytes = 8 * 1024 * 1024,
    contentType = method === 'PATCH' ? 'application/merge-patch+json' : 'application/json'): Promise<T> {
    if (url.origin !== new URL(this.baseURL).origin || url.username || url.password) {
      throw new Error('Kubernetes requests must remain on the configured API server');
    }
    // Projected tokens rotate; read the current token for every request.
    const token = readFileSync(this.tokenPath, 'utf8').trim();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      let deadline: ReturnType<typeof setTimeout>;
      const finish = (error?: Error, value?: T) => {
        clearTimeout(deadline);
        if (error) reject(error); else resolve(value as T);
      };
      const req = request(url, {
        method, ca: readFileSync(this.caPath), timeout: 10_000,
        // The API server negotiates an API serializer before handing pods/log
        // to its text streamer. text/plain alone can fail that negotiation
        // with HTTP 406; wildcard accepts both streamed logs and API errors.
        headers: { authorization: `Bearer ${token}`, accept: plainText ? '*/*' : 'application/json',
          ...(payload ? { 'content-type': contentType,
            'content-length': Buffer.byteLength(payload) } : {}) },
      }, response => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          data += chunk;
          if (Buffer.byteLength(data) > maxBytes) {
            finish(new Error('Kubernetes response exceeds byte limit'));
            response.destroy();
            req.destroy();
          }
        });
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) {
            finish(new APIError(response.statusCode ?? 500,
              `Kubernetes API ${method} ${url.pathname}: ${response.statusCode} (${safeKubernetesErrorDetails(data)})`));
            return;
          }
          try { finish(undefined, (plainText ? data : JSON.parse(data)) as T); } catch (error) { finish(error as Error); }
        });
        response.on('error', error => finish(error));
      });
      // The socket timeout alone resets on each chunk. A total deadline also
      // bounds a peer that keeps a response open with occasional bytes.
      deadline = setTimeout(() => { finish(new Error('Kubernetes request timed out')); req.destroy(); }, 10_000);
      req.on('timeout', () => { finish(new Error('Kubernetes request timed out')); req.destroy(); });
      req.on('error', error => finish(error));
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

  async start(input: Parameters<DemoAPI['start']>[0]): Promise<RunState> {
    const response = await fetch(new URL('/api/runs', this.baseURL), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new APIError(response.status, `Demo API returned ${response.status}`);
    return await response.json() as RunState;
  }
}
