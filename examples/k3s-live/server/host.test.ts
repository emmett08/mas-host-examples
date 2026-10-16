import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureConnectionProfile, Host, HostRunFailure } from './host.js';
import { projectFailure } from './diagnostics.js';

test('paced recording providers require fixture mode and explicit opt-in; live always uses its configured providers', () => {
  assert.equal(fixtureConnectionProfile('fixture'), 'connections.fixture.toml');
  assert.equal(fixtureConnectionProfile('fixture', false), 'connections.fixture.toml');
  assert.equal(fixtureConnectionProfile('fixture', true), 'connections.recording.toml');
  assert.equal(fixtureConnectionProfile('live'), undefined);
  assert.equal(fixtureConnectionProfile('live', true), undefined);
});

const effectId = `eff-${'a'.repeat(64)}`;
function observedFailure(evidence: Record<string, unknown> = {}, output: Record<string, unknown> = {}) {
  return { version: 'mas-host-observation/1', run_id: 'failed-run', steps: [{
    kind: 'effect', key: 'inference-0', id: effectId, actor: 'diagnose', state: 'completed',
    output: { certainty: 'rejected', output_status: 'rejected', ...output },
    evidence: { adapter: 'mas-host-openai/1', requested_model: 'gpt-5.4-mini-2026-03-17', http_status: 400, ...evidence },
  }] };
}

test('safe projection distinguishes actionable HTTP failures and excludes raw or unrecognised data', () => {
  const raw = observedFailure({ error_code: 'invalid_json_schema', error_type: 'invalid_request_error',
    error_param: 'text.format.schema', message: 'private-api-key', headers: { authorization: 'private-api-key' },
    unknown: 'private-api-key' }, { output: { prompt: 'private-api-key' }, reason: 'private-api-key' });
  const diagnostics = projectFailure(raw, 'failed-run');
  assert.equal(diagnostics.classification, 'invalid-schema');
  assert.deepEqual(diagnostics.effects[0], { actor: 'diagnose', effectId, state: 'completed',
    certainty: 'rejected', outputStatus: 'rejected', provider: 'openai', model: 'gpt-5.4-mini-2026-03-17',
    httpStatus: 400, errorCode: 'invalid_json_schema', errorType: 'invalid_request_error', errorParam: 'text.format.schema',
    classification: 'invalid-schema' });
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-api-key|headers|prompt|reason/);
  for (const [http_status, error_code, classification] of [
    [401, 'invalid_api_key', 'authentication'], [403, 'permission_denied', 'permission'],
    [404, 'model_not_found', 'model-unavailable'], [429, 'insufficient_quota', 'quota'],
    [429, 'rate_limit_exceeded', 'rate-limit'], [400, 'unsupported_parameter', 'invalid-request'],
  ] as const) assert.equal(projectFailure(observedFailure({ http_status, error_code }), 'failed-run').classification, classification);
  const malicious = projectFailure(observedFailure({ error_code: 'private-api-key', error_type: 'private-api-key',
    error_param: 'private-api-key', requested_model: 'private-api-key', adapter: 'private-api-key', http_status: '400' }), 'failed-run');
  assert.doesNotMatch(JSON.stringify(malicious), /private-api-key|"(?:httpStatus|errorCode|errorType|errorParam|model|provider)":/);
  assert.equal(projectFailure(observedFailure({ http_status: 429, error_code: 'unknown' }), 'failed-run').classification, 'provider-rejected');
  assert.equal(projectFailure(observedFailure({ http_status: 404, error_code: 'unknown' }), 'failed-run').classification, 'provider-rejected');
});

test('safe projection bounds effects, validates identity, and only recognises the exact missing credential reason', () => {
  const missing = observedFailure({}, { certainty: 'not_sent', output_status: 'unavailable',
    reason: 'provider credential environment is missing or invalid' });
  assert.equal(projectFailure(missing, 'failed-run').classification, 'missing-credential');
  missing.steps[0]!.output.reason += ': private-api-key';
  assert.notEqual(projectFailure(missing, 'failed-run').classification, 'missing-credential');
  assert.doesNotMatch(JSON.stringify(projectFailure(missing, 'failed-run')), /private-api-key/);
  const untrusted = observedFailure();
  untrusted.steps = Array.from({ length: 80 }, () => untrusted.steps[0]!);
  assert.equal(projectFailure(untrusted, 'failed-run').effects.length, 64);
  assert.equal(projectFailure(untrusted, 'other-run').effects.length, 0);
  const successful = observedFailure({}, { certainty: 'completed', output_status: 'valid' });
  assert.equal(projectFailure(successful, 'failed-run').effects.length, 0);
  const wrongActor = observedFailure();
  wrongActor.steps[0]!.actor = 'private-api-key';
  assert.equal(projectFailure(wrongActor, 'failed-run').effects.length, 0);
});

test('failed CLI runs use one read-only observation and never retain raw subprocess errors or retry execution', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mas-safe-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'argv.jsonl'), binary = join(directory, 'host');
  const observation = observedFailure({ http_status: 401, error_code: 'invalid_api_key', message: 'private-api-key' });
  await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'run') { console.error('private-api-key'); process.exit(1); }
process.stdout.write(${JSON.stringify(JSON.stringify(observation))});\n`, { mode: 0o700 });
  const host = new Host({ binary, sdk: directory, project: directory, payloads: false });
  await assert.rejects(host.run('failed-run', join(directory, 'input.json'), directory, 'live'), (error: unknown) => {
    assert.ok(error instanceof HostRunFailure);
    assert.equal(error.diagnostics.classification, 'authentication');
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(JSON.stringify({ message: error.message, ...error }), /private-api-key|stderr|stdout/);
    return true;
  });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'run');
  assert.deepEqual(calls[1], ['observe', '--state', directory, '--run', 'failed-run', '--include-payloads', 'true']);
});

test('a failed diagnostic read keeps the fixed generic failure and cannot replace it with stderr', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mas-missing-diagnostic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'host');
  await writeFile(binary, `#!${process.execPath}\nconsole.error('private-api-key'); process.exit(1);\n`, { mode: 0o700 });
  await assert.rejects(new Host({ binary, sdk: directory, project: directory, payloads: false })
    .run('failed-run', 'input.json', directory, 'live'), (error: unknown) => {
    assert.ok(error instanceof HostRunFailure);
    assert.equal(error.diagnostics.classification, 'host-failure');
    assert.deepEqual(error.diagnostics.effects, []);
    assert.doesNotMatch(error.message, /private-api-key/);
    return true;
  });
});

test('host subprocesses cannot inherit the external verifier reporting credential', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mas-host-credential-scope-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.DEMO_VERIFIER_TOKEN;
  process.env.DEMO_VERIFIER_TOKEN = 'private-verifier-token';
  t.after(() => { if (previous === undefined) delete process.env.DEMO_VERIFIER_TOKEN; else process.env.DEMO_VERIFIER_TOKEN = previous; });
  const binary = join(directory, 'host');
  await writeFile(binary, `#!${process.execPath}\nif (process.env.DEMO_VERIFIER_TOKEN) process.exit(2); if (process.argv[2] === 'run') process.stdout.write(JSON.stringify({output:{credentialAbsent:true}})); else process.stdout.write(JSON.stringify({version:'mas-host-observation/1',messages:[]}));\n`, { mode: 0o700 });
  const host = new Host({ binary, sdk: directory, project: directory, payloads: true });
  assert.deepEqual(await host.run('scoped', 'input.json', directory, 'fixture'), { credentialAbsent: true });
  assert.deepEqual((await host.observe('scoped', directory)).messages, []);
  await host.cancel('scoped', directory);
});
