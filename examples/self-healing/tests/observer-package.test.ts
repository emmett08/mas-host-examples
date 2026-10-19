import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore dependency-free packaging helper
import { buildObserver } from '../scripts/build-observer.mjs';

const ready = existsSync(new URL('../dist/server/index.js', import.meta.url));
test('extracted portable bundle launches recorded events outside its working directory without npm', { skip: !ready }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'observer package '));
  const target = join(temporary, 'extracted observer'), bin = join(temporary, 'bin');
  const env = { GITHUB_REPOSITORY: 'emmett08/mas-host-examples', GITHUB_SHA: 'b5ae5929974daf433dbb8e10293ddc7349e60408',
    GITHUB_RUN_ID: '39140657270', GITHUB_RUN_ATTEMPT: '1' };
  buildObserver(target, env);
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'api') {
  process.stdout.write(JSON.stringify({ artifacts: [{ id: 12141304435, name: 'self-remediation-fixture-39140657270-1', expired: false, workflow_run: { id: 39140657270 } }] }));
} else if (args[0] === 'run' && args[1] === 'download') {
  const dir = path.join(args[args.indexOf('--dir') + 1], 'self-remediation-fixture');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'integration-start.json'), JSON.stringify({ schema: 'self-remediation-integration/1', incident: '39140657270-1-missing-route', mode: 'fixture', workflow: '39140657270', attempt: '1', source: '${env.GITHUB_SHA}' }));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ seq: 1, incidentId: '39140657270-1-missing-route', time: '2026-10-18T15:00:00.000Z', type: 'incident.opened', data: { mode: 'fixture' } }) + '\\n');
} else { process.exit(2); }
`, { mode: 0o755 });
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const child = spawn('bash', [join(target, 'start.command'), '--port', String(port)], {
    cwd: temporary, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  try {
    let events: any[] | undefined;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) assert.fail(`Packaged launcher exited ${child.exitCode}: ${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/events`);
        events = await response.json() as any[];
        if (events.length) break;
      } catch { /* Startup is asynchronous. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(events?.length, 1, output);
    assert.equal(events?.[0]?.incidentId, '39140657270-1-missing-route');
    assert.match(output, /Recorded replay \(1 committed events\)/);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);
  } finally { child.kill('SIGTERM'); await closed; rmSync(temporary, { recursive: true, force: true }); }
});
