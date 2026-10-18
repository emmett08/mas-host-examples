import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { checkPath, sha256 } from './projection.js';
import type { ToolContext } from './broker.js';
function canonical(value: any): string { return JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(x => JSON.parse(canonical(x))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value); }
export const mcpSchema = { type: 'object' as const, additionalProperties: false, properties: { path: { type: 'string', maxLength: 100 } }, required: ['path'] };
export async function serveMcp(context: ToolContext) {
  const server = new Server({ name: 'self-remediation-projected-source', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'source_read', description: 'Read one admitted immutable incident file', inputSchema: mcpSchema }] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name !== 'source_read' || !request.params.arguments || Object.keys(request.params.arguments).join() !== 'path' || typeof request.params.arguments.path !== 'string') throw new Error('Unregistered MCP operation');
    const path = request.params.arguments.path; checkPath(path, context.snapshot.projection);
    const text = context.snapshot.files[path]; const value = { status: text === undefined ? 'failed' : 'passed', path, text: text?.slice(0,8192), truncated: text !== undefined && text.length > 8192, tree: context.snapshot.tree, protocol: 'MCP', server: 'self-remediation-projected-source@1.0.0' };
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
  });
  await server.connect(new StdioServerTransport()); return server;
}
export async function customMcpRead(context: ToolContext, path: string) {
  checkPath(path, context.snapshot.projection);
  const transport = new StdioClientTransport({ command: process.execPath, args: [context.runtimeBundle, '--mcp-server'], env: {
    SELF_REMEDIATION_CONTEXT: process.env.SELF_REMEDIATION_CONTEXT!, SELF_REMEDIATION_CONTEXT_SHA256: process.env.SELF_REMEDIATION_CONTEXT_SHA256!,
  }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'self-remediation-trusted-broker', version: '1.0.0' });
  try {
    await client.connect(transport);
    const discovered = await client.listTools({}, { timeout: 10000 });
    const tool = discovered.tools.find(x => x.name === 'source_read');
    if (!tool || sha256(canonical(tool.inputSchema)) !== sha256(canonical(mcpSchema))) throw new Error('MCP schema drift rejected');
    const result = await client.callTool({ name: 'source_read', arguments: { path } }, undefined, { timeout: 10000 });
    const value = result.structuredContent as any;
    if (!value || value.tree !== context.snapshot.tree || value.path !== path || !['passed', 'failed'].includes(value.status)) throw new Error('Invalid MCP result');
    return value;
  } finally { await client.close(); }
}
