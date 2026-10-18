import { spawn } from 'node:child_process';
import { parseWindow, type ObservationWindow } from '../ui/events.js';

export const CHECK_NAME = 'Self-remediation live observation';
export const MARKER = '<!-- self-remediation-observer/1 -->';
export interface ApiResponse<T = unknown> { status: number; headers: Record<string, string>; body: T }
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly headers: Record<string, string>) { super(message); }
}
export interface CheckRun {
  id: number; name: string; external_id: string; head_sha: string; status: string;
  html_url?: string; output?: { text?: string; summary?: string };
}
export interface CheckApi {
  request<T>(method: 'GET' | 'POST' | 'PATCH', endpoint: string, body?: unknown): Promise<ApiResponse<T>>;
}
/** gh holds credentials server-side. No token, arbitrary URL or command comes from the browser. */
export class GhCheckApi implements CheckApi {
  constructor(readonly repository: string) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('repository must be OWNER/REPO');
  }
  async request<T>(method: 'GET' | 'POST' | 'PATCH', endpoint: string, body?: unknown): Promise<ApiResponse<T>> {
    const prefix = `/repos/${this.repository}/`;
    if (!endpoint.startsWith(prefix) || !/^(?:check-runs(?:\/\d+)?|commits\/[a-f0-9]{40}\/check-runs)(?:\?[A-Za-z0-9_=&%.-]+)?$/.test(endpoint.slice(prefix.length))) throw new Error('endpoint outside Check Run projection');
    const args = ['api', '--include', '--method', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10', endpoint];
    if (body !== undefined) args.push('--input', '-');
    return await new Promise((resolve, reject) => {
      const proc = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', bytes = 0;
      const timeout = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('GitHub transport timed out; outcome requires reconciliation')); }, 25_000);
      proc.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1_500_000) { proc.kill('SIGKILL'); reject(new Error('GitHub response limit exceeded')); } else stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString(); });
      proc.on('error', reject);
      proc.on('close', code => {
        clearTimeout(timeout);
        try {
          const parsed = parseGhResponse<T>(stdout);
          if (code !== 0 || parsed.status >= 400) reject(new ApiError(`GitHub API failed (${parsed.status || code}); credentials remain server-side`, parsed.status, parsed.headers));
          else resolve(parsed);
        } catch (error) { reject(new Error(`GitHub transport returned no parseable response (${code}); ${error instanceof Error ? error.message : 'unknown'}`)); }
      });
      proc.stdin.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
}
export function parseGhResponse<T>(text: string): ApiResponse<T> {
  const separator = /\r?\n\r?\n/.exec(text);
  if (!separator || separator.index === undefined) throw new Error('missing HTTP headers');
  const head = text.slice(0, separator.index).split(/\r?\n/);
  const status = Number(head[0]?.match(/^HTTP\/\S+ (\d+)/)?.[1]);
  if (!Number.isFinite(status)) throw new Error('invalid HTTP status');
  const headers: Record<string, string> = {};
  for (const line of head.slice(1)) { const colon = line.indexOf(':'); if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim(); }
  const body = text.slice(separator.index + separator[0].length).trim();
  return { status, headers, body: (body ? JSON.parse(body) : null) as T };
}
export function retryDelay(error: unknown, failures: number, now = Date.now()): number {
  if (error instanceof ApiError && (error.status === 403 || error.status === 429)) {
    const after = Number(error.headers['retry-after']);
    if (Number.isFinite(after) && after > 0) return after * 1000;
    const reset = Number(error.headers['x-ratelimit-reset']);
    if (error.headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset)) return Math.max(1000, reset * 1000 - now + 1000);
    return Math.min(15 * 60_000, 60_000 * 2 ** Math.min(failures, 4));
  }
  return Math.min(120_000, 12_000 * 2 ** Math.min(failures, 4));
}
export function encodeWindow(window: ObservationWindow): string { return `${MARKER}\n\n\`\`\`json\n${JSON.stringify(window)}\n\`\`\``; }
export function decodeWindow(text: string): ObservationWindow {
  if (!text.startsWith(MARKER)) throw new Error('Check Run is not a self-remediation observation');
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!match?.[1]) throw new Error('Check Run has no observation window');
  return parseWindow(JSON.parse(match[1]));
}
export async function findCheck(api: CheckApi, repo: string, sha: string, incidentId: string): Promise<CheckRun | undefined> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Check Run SHA must be an exact commit');
  const matches: CheckRun[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = await api.request<{ check_runs: CheckRun[] }>('GET', `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&per_page=100&page=${page}`);
    const checks = result.body.check_runs;
    matches.push(...checks.filter(c => c.external_id === incidentId && c.head_sha === sha && c.name === CHECK_NAME));
    if (checks.length < 100) {
      if (matches.length > 1) throw new Error('duplicate Check Runs need explicit reconciliation');
      return matches[0];
    }
  }
  throw new Error('Check Run reconciliation window exhausted');
}
