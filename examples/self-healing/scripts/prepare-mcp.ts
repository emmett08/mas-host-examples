/** Prepare an operator-owned local MCP service without executing a repair. */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { prepare } from '../mcp/prepare.js';
const { values } = parseArgs({ options: { output: { type: 'string' }, incident: { type: 'string' }, mode: { type: 'string', default: 'fixture' },
  case: { type: 'string', default: 'missing-route' }, config: { type: 'string' }, host: { type: 'string' }, server: { type: 'string' }, 'sdk-root': { type: 'string' } } });
if (!values.output || !values.incident || !['fixture', 'live'].includes(values.mode!)) throw new Error('Use --output NEW_DIRECTORY --incident ID [--mode fixture|live] [--config FILE]');
const prepared = await prepare({ directory: values.output, example: process.cwd(), incidentId: values.incident, mode: values.mode as 'fixture' | 'live', caseName: values.case,
  config: values.config, host: values.host ?? process.env.MAS_HOST_BIN ?? resolve('../../.tools/mas-host/target/debug/mas-host'),
  sdkRoot: values['sdk-root'] ?? process.env.MAS_SDK_ROOT ?? resolve('../../.tools/mas-host'),
  server: values.server ?? process.env.MAS_MCP_BIN ?? resolve('../../.tools/mas-mcp/target/release/mas-mcp') });
console.log(JSON.stringify({ status: 'prepared', registration: prepared.registration, config: prepared.config, contract_digest: prepared.contract_digest }, null, 2));
