// This test executes the real pinned host and existing protocol with explicit mock provider output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Host } from './host.js';

test('real MAS host exercises the hybrid branch, correlated replies, and durable replay', async t => {
  const binary = resolve(process.env.MAS_HOST_BIN ?? '../../.tools/mas-host/target/debug/mas-host');
  const sdk = resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host');
  const host = new Host({ binary, sdk, project: resolve('project'), payloads: true });
  const folder = await mkdtemp(join(tmpdir(), 'mas-hybrid-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const input = join(folder, 'input.json');
  await writeFile(input, JSON.stringify({ incident: { reason: 'BackOff', source: 'fixture' } }));
  const output = await host.run('hybrid-test', input, folder, 'fixture') as Record<string, unknown>;
  assert.equal(output.requires_human, true);
  const snapshot = await host.observe('hybrid-test', folder);
  const messages = snapshot.messages as { id: string; sender: string; recipient: string; kind: string; correlation: string; taskId: string }[];
  const requests = messages.filter(m => m.kind === 'request');
  assert.equal(requests.length, 8);
  assert.ok(requests.some(m => m.sender === 'platform' && m.recipient === 'security'));
  assert.equal(requests.filter(m => m.sender === 'security' && m.recipient === 'security_review').length, 2);
  assert.equal(messages.filter(m => m.kind === 'result').length, 8);
  for (const request of requests) assert.ok(messages.some(m => m.kind === 'result' && m.correlation === request.id));
  assert.deepEqual(await host.run('hybrid-test', input, folder, 'fixture'), output);
  assert.equal((await host.observe('hybrid-test', folder)).messages.length, messages.length);
});
