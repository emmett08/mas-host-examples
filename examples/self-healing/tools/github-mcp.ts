import { sha256 } from '../deploy/effects.js';

export interface GitHubReadGrant {
  repository: string;
  workflowRunId: string;
  workflowSourceRevision: string;
  /** Pinned by trusted setup before a phase is frozen. Discovery alone cannot set this. */
  toolSchemaSha256: string;
  evidenceSetting: 'blind' | 'operational';
}
interface RpcResult { result?: Record<string, unknown>; error?: { code: number }; id?: number }
const ENDPOINT = 'https://api.githubcopilot.com/mcp/';
const MAX_RESPONSE = 256 * 1024;
function checkedGrant(grant: GitHubReadGrant): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(grant.repository) || !/^\d+$/.test(grant.workflowRunId)
    || !/^[a-f0-9]{40}$/.test(grant.workflowSourceRevision) || !/^[a-f0-9]{64}$/.test(grant.toolSchemaSha256))
    throw new Error('Exact repository, run, revision and frozen tool schema required');
}
/** Official remote GitHub MCP transport, deliberately exposing only run metadata.
 * No source, logs, artifacts, search, history or discovered tools reach the agent.
 */
export class OfficialGitHubMcp {
  private session: string | null = null;
  private nextId = 0;
  private ready = false;
  constructor(private token: string, private grant: GitHubReadGrant, private request: typeof fetch = fetch) {
    checkedGrant(grant);
    if (!token) throw new Error('Dedicated GitHub read credential is unavailable');
  }
  private async rpc(method: string, params: object, notification = false): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    const response = await this.request(ENDPOINT, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26',
        'X-MCP-Readonly': 'true', 'X-MCP-Tools': 'actions_get',
        ...(this.session ? { 'Mcp-Session-Id': this.session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
    });
    this.session = response.headers.get('Mcp-Session-Id') ?? this.session;
    if (!response.ok) throw new Error(`GitHub MCP transport status ${response.status}`);
    if (notification && response.status === 202) return {};
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = []; let bytes = 0;
    if (reader) {
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > MAX_RESPONSE) { await reader.cancel(); throw new Error('GitHub MCP output bound exceeded'); }
        parts.push(item.value);
      }
    }
    const text = Buffer.concat(parts).toString('utf8');
    if (notification && !text) return {};
    const frames = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')).filter(Boolean)
      : [text];
    const found = frames.map(frame => JSON.parse(frame) as RpcResult).find(frame => frame.id === id);
    if (!found || found.error || !found.result) throw new Error('GitHub MCP outcome unavailable');
    return found.result;
  }
  async initialise(): Promise<{ toolSchemaSha256: string; server: unknown }> {
    const initial = await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mas-self-remediation-read', version: '1.0.0' } });
    await this.rpc('notifications/initialized', {}, true);
    const listed = await this.rpc('tools/list', {});
    const tools = listed.tools as Array<{ name: string; inputSchema: unknown }> | undefined;
    const tool = tools?.find(item => item.name === 'actions_get');
    if (!tool) throw new Error('Official actions_get capability unavailable');
    const observed = sha256({ name: tool.name, inputSchema: tool.inputSchema });
    if (observed !== this.grant.toolSchemaSha256) throw new Error(`GitHub MCP frozen schema mismatch: observed ${observed}`);
    this.ready = true;
    return { toolSchemaSha256: observed, server: initial.serverInfo };
  }
  async readWorkflowRun(): Promise<Record<string, unknown>> {
    if (!this.ready) throw new Error('Frozen MCP schema must be verified first');
    const [owner, repo] = this.grant.repository.split('/');
    const response = await this.rpc('tools/call', { name: 'actions_get', arguments: {
      method: 'get_workflow_run', owner, repo, resource_id: this.grant.workflowRunId,
    } });
    if (response.isError) throw new Error('Official GitHub MCP read failed');
    let data = response.structuredContent as Record<string, unknown> | undefined;
    if (!data) {
      const content = response.content as Array<{ type: string; text?: string }> | undefined;
      const text = content?.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
      if (!text) throw new Error('GitHub MCP run metadata absent');
      data = JSON.parse(text) as Record<string, unknown>;
    }
    const run = (data.workflow_run ?? data.run ?? data) as Record<string, unknown>;
    if (String(run.id) !== this.grant.workflowRunId || run.head_sha !== this.grant.workflowSourceRevision)
      throw new Error('GitHub MCP run/revision outside admitted metadata projection');
    // Reconstruct the output instead of returning external text, URLs, logs or arbitrary nested fields.
    return { repository: this.grant.repository, workflowRunId: String(run.id), sourceRevision: run.head_sha,
      status: typeof run.status === 'string' ? run.status.slice(0, 40) : 'unknown',
      conclusion: typeof run.conclusion === 'string' ? run.conclusion.slice(0, 40) : null,
      event: typeof run.event === 'string' ? run.event.slice(0, 40) : 'unknown',
      evidenceSetting: this.grant.evidenceSetting, schemaSha256: this.grant.toolSchemaSha256 };
  }
}
