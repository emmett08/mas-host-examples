import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { InClusterKubernetesClient } from '../operator/client.js';
import { InvestigationTools, SERVER_NAME, readContext, toolDefinitions, validateArguments } from './tools.js';

export function createInvestigationServer(tools: InvestigationTools): Server {
  const server = new Server({ name: SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {};
    try { validateArguments(request.params.name, args); }
    catch { throw new McpError(ErrorCode.InvalidParams, 'Unknown tool or invalid arguments; the incident target is fixed'); }
    try {
      const result = await tools.call(request.params.name, args, extra.signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch {
      // Raw API/transport errors may contain resource content or credentials.
      const result = { status: 'error', source: tools.context.source, server: SERVER_NAME, tool: request.params.name,
        subject: tools.context.evidence.subject, evidence_items: [], numeric_encoding: 'integer-or-decimal-string' };
      return { isError: true, content: [{ type: 'text', text: 'Investigation tool failed or was cancelled' }], structuredContent: result };
    }
  });
  return server;
}

export async function serveFromEnvironment() {
  if (!/^[0-9a-f]{64}$/.test(process.env.MAS_MCP_CONTEXT_SHA256 ?? '')) throw new Error('MCP context digest is required');
  const context = await readContext(process.env.MAS_MCP_CONTEXT_FILE, process.env.MAS_MCP_CONTEXT_SHA256);
  const host = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443';
  if (!/^[a-zA-Z0-9.:-]+$/.test(host) || !/^\d{1,5}$/.test(port)) throw new Error('Invalid Kubernetes API authority');
  const authority = host.includes(':') ? `[${host}]` : host;
  const kube = context.source === 'kubernetes-api' ? new InClusterKubernetesClient(`https://${authority}:${port}`) : undefined;
  const server = createInvestigationServer(new InvestigationTools(context, kube));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveFromEnvironment().catch(() => { process.stderr.write('MCP investigation server could not start\n'); process.exitCode = 1; });
}
