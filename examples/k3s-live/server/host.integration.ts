// This test executes the real pinned host and existing protocol with explicit mock provider output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { Host, HostRunFailure } from './host.js';

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

test('recording fixture command providers produce schema-valid results with observable active message growth', { timeout: 60_000 }, async t => {
  const binary = resolve(process.env.MAS_HOST_BIN ?? '../../.tools/mas-host/target/debug/mas-host');
  const sdk = resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host');
  const folder = await mkdtemp(join(tmpdir(), 'mas-paced-fixture-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const project = join(folder, 'project');
  await cp(resolve('project'), project, { recursive: true, filter: source => basename(source) !== '.mas' });
  // The container supplies node on the host's fixed PATH. Development runtimes
  // can install Node elsewhere; normalise only this temporary test project's
  // argv to the running interpreter. CI recording uses the unmodified profile.
  const profile = join(project, 'connections.recording.toml');
  const connection = await readFile(profile, 'utf8');
  await writeFile(profile, connection.replaceAll('command = ["node",', `command = [${JSON.stringify(process.execPath)},`));
  const host = new Host({ binary, sdk, project, payloads: true, fixtureRecording: true });
  const state = join(folder, 'state');
  const input = join(folder, 'input.json');
  await writeFile(input, JSON.stringify({ incident: { reason: 'BackOff', source: 'fixture' } }));
  // The host enforces review.json and decision.json on all command-provider
  // results. Sampling its actual observations also proves the deliberate pacing
  // leaves more than one active message count for a recording subscriber.
  let settled = false;
  const completion = host.run('paced-fixture-test', input, state, 'fixture');
  void completion.then(() => { settled = true; }, () => { settled = true; });
  const counts = new Set<number>();
  while (!settled) {
    try {
      const snapshot = await host.observe('paced-fixture-test', state);
      if (!settled && snapshot.messages.length > 0) counts.add(snapshot.messages.length);
    } catch { /* The initial host databases do not exist before run admission. */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const output = await completion as Record<string, unknown>;
  assert.equal(output.requires_human, true);
  assert.match(String(output.summary), /^Paced fixture investigation plan:/);
  assert.ok(counts.size > 1, 'The active host trace must expose increasing message counts before completion');
  const snapshot = await host.observe('paced-fixture-test', state);
  assert.equal(snapshot.messages.length, 16);
});

test('a real host HTTP rejection retains safe diagnostics without repeating model calls', { timeout: 60_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'mas-provider-rejection-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const requests: unknown[] = [];
  const secretMarker = 'private-provider-error-message-and-credential';
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'invalid_json_schema', type: 'invalid_request_error',
      param: 'text.format.schema', message: secretMarker } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/v1/responses`;
  const keyName = 'MAS_DEMO_REJECTION_TEST_KEY';
  const previous = process.env[keyName];
  process.env[keyName] = secretMarker;
  t.after(() => { if (previous === undefined) delete process.env[keyName]; else process.env[keyName] = previous; });
  const project = join(folder, 'project');
  await cp(resolve('project'), project, { recursive: true, filter: source => basename(source) !== '.mas' });
  const agents = join(project, 'agents.toml');
  const source = await readFile(agents, 'utf8');
  assert.equal(source.match(/kind = "openai"/g)?.length, 2);
  // Both connections point only to our rejecting loopback server. No provider
  // credentials or external inference are used by this integration test.
  await writeFile(agents, source.replaceAll('kind = "openai"', `kind = "openai"\nendpoint = "${endpoint}"`)
    .replaceAll('api_key_env = "OPENAI_API_KEY"', `api_key_env = "${keyName}"`));
  const host = new Host({ binary: resolve(process.env.MAS_HOST_BIN ?? '../../.tools/mas-host/target/debug/mas-host'),
    sdk: resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host'), project, payloads: false });
  const input = join(folder, 'input.json');
  const state = join(folder, 'state');
  await writeFile(input, JSON.stringify({ incident: { reason: 'BackOff' } }));
  const isSafeRejection = (error: unknown) => {
    assert.ok(error instanceof HostRunFailure);
    assert.match(error.message, /400/);
    assert.ok(error.diagnostics.effects.length > 0);
    assert.ok(error.diagnostics.effects.every(effect => effect.httpStatus === 400 && effect.errorCode === 'invalid_json_schema'));
    assert.ok(!JSON.stringify(error.diagnostics).includes(secretMarker));
    assert.ok(!error.message.includes(secretMarker));
    return true;
  };
  await assert.rejects(host.run('rejected', input, state, 'live'), isSafeRejection);
  assert.equal(requests.length, 2);
  // A rejected effect is retained. Reopening the same run does not resend it.
  await assert.rejects(host.run('rejected', input, state, 'live'), isSafeRejection);
  assert.equal(requests.length, 2);
});
