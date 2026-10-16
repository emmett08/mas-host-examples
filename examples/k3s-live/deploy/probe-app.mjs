// An actual HTTP workload with a deliberately incorrect readiness probe in its manifest.
import { createServer } from 'node:http';
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const status = path === '/' || path === '/healthz' ? 200 : 404;
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), method: request.method, path, status }));
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(path === '/' ? 'MAS checkout service ready\n' : path === '/healthz' ? 'ok\n' : 'not found\n');
});
server.listen(8081, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
