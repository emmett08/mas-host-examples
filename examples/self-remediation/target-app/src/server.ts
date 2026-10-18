import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { quote } from './pricing.ts';
import { health } from './health.ts';
const configuration = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  const send = (status: number, body: unknown) => { response.statusCode = status; response.end(JSON.stringify(body)); };
  if (request.method === 'GET' && request.url === '/livez') return send(200, health());
  if (request.method === 'GET' && request.url === '/catalogue') return send(200, { currency: 'GBP', version: 1 });
  if (request.method === 'POST' && request.url === '/quote') {
    let text = '';
    try {
      for await (const chunk of request) {
        text += chunk;
        if (Buffer.byteLength(text) > 4096) return send(413, { error: 'request too large' });
      }
      const input = JSON.parse(text);
      return send(200, quote(input.quantity, input.unitPricePence, input.delivery));
    } catch { return send(400, { error: 'invalid quote input' }); }
  }
  return send(404, { error: 'route not found' });
});
server.listen(configuration.port, '0.0.0.0');
