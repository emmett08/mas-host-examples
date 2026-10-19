import { readContext, dispatch } from './broker.js';
import { serveMcp } from './mcp-server.js';
async function main() {
  const context = await readContext();
  if (process.argv[2] === '--mcp-server') { await serveMcp(context); return; }
  if (process.argv[2] !== '--invocation' || !process.argv[3] || !process.argv[4]) throw new Error('Admitted invocation and registered capability required');
  const chunks: Buffer[] = []; let count = 0;
  for await (const chunk of process.stdin) { count += chunk.length; if (count > 49152) throw new Error('Tool input bound exceeded'); chunks.push(chunk); }
  const result = await dispatch(context, process.argv[4], JSON.parse(Buffer.concat(chunks).toString()), process.argv[3]);
  process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch(() => { process.stderr.write('Trusted tool execution did not return a completed outcome. Reconcile before retrying.\n'); process.exitCode = 1; });
