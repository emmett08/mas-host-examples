// Compose the single-owner demonstration service; credentials remain on the server.
import { resolve } from 'node:path';
import { Host } from './host.js';
import { Runs } from './runs.js';
import { topology } from './topology.js';
import { application } from './http.js';

const mode = process.env.DEMO_MODE ?? 'live';
if (mode !== 'live' && mode !== 'fixture') throw new Error('DEMO_MODE must be live or fixture');
const project = resolve('project');
const host = new Host({ binary: process.env.MAS_HOST_BIN ?? '../../.tools/mas-host/target/debug/mas-host',
  sdk: resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host'), project,
  payloads: process.env.SHOW_PAYLOADS === 'true' });
const runs = new Runs(resolve(process.env.DEMO_DATA_DIR ?? '.data'), mode, host);
await runs.initialise();
const server = application(runs, await topology(project, mode), resolve('dist/ui'));
const port = Number(process.env.PORT ?? 8080);
server.listen(port, process.env.LISTEN_HOST ?? '127.0.0.1', () => {
  console.log(`MAS incident demo: http://localhost:${port} (${mode})`);
});
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return;
  closing = true;
  server.close();
  void runs.shutdown().finally(() => {
    setTimeout(() => process.exit(0), 5000).unref();
    server.closeAllConnections();
  });
});
