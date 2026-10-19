import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectConfiguration } from '../scripts/preflight.mjs';

const configured = {
  OPENAI_API_KEY: 'secret-provider-value', SELF_REMEDIATION_MODEL: 'explicit-model-value',
  SELF_REMEDIATION_MAX_CALL_MICRO_USD: '150000', SELF_REMEDIATION_PROGRESS: 'true',
  GH_TOKEN: 'secret-check-token-value', GITHUB_REPOSITORY: 'owner/repository', GITHUB_SHA: 'a'.repeat(40),
};

test('live preflight aggregates missing required settings without exposing any values', () => {
  const report = inspectConfiguration({ SELF_REMEDIATION_PROGRESS: 'true', UNRELATED_SECRET: 'private-unrelated' }, 'live');
  assert.equal(report.ready, false);
  assert.deepEqual(report.errors.map(item => item.setting), [
    'OPENAI_API_KEY', 'SELF_REMEDIATION_MODEL', 'SELF_REMEDIATION_MAX_CALL_MICRO_USD', 'GH_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_SHA',
  ]);
  assert.equal(report.warnings.length, 1);
  assert.ok(!JSON.stringify(report).includes('private-unrelated'));
  const accepted = inspectConfiguration(configured, 'live');
  assert.equal(accepted.ready, true);
  for (const value of [configured.OPENAI_API_KEY, configured.SELF_REMEDIATION_MODEL, configured.GH_TOKEN, configured.GITHUB_REPOSITORY, configured.GITHUB_SHA])
    assert.ok(!JSON.stringify(accepted).includes(value));
});

test('blank credentials and model are unavailable and call reservations have exact integer bounds', () => {
  const report = inspectConfiguration({ ...configured, OPENAI_API_KEY: ' \t', SELF_REMEDIATION_MODEL: '\n', GH_TOKEN: ' ' }, 'live');
  assert.deepEqual(report.errors.map(item => item.setting), ['OPENAI_API_KEY', 'SELF_REMEDIATION_MODEL', 'GH_TOKEN']);
  for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '2e5', '2000001', '9007199254740992']) {
    const result = inspectConfiguration({ ...configured, SELF_REMEDIATION_MAX_CALL_MICRO_USD: value }, 'live');
    assert.equal(result.ready, false);
    assert.equal(result.errors[0]?.setting, 'SELF_REMEDIATION_MAX_CALL_MICRO_USD');
  }
  for (const value of ['1', '2000000']) assert.equal(inspectConfiguration({ ...configured, SELF_REMEDIATION_MAX_CALL_MICRO_USD: value }, 'live').ready, true);
});

test('reported live workflow configuration identifies both required omissions and the unavailable MCP gate', () => {
  const report = inspectConfiguration({ ...configured, OPENAI_API_KEY: '', SELF_REMEDIATION_MODEL: '',
    SELF_REMEDIATION_GITHUB_READ_TOKEN: '', SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256: '' }, 'live');
  assert.equal(report.ready, false);
  assert.deepEqual(report.errors.map(item => item.setting), ['OPENAI_API_KEY', 'SELF_REMEDIATION_MODEL']);
  assert.equal(report.warnings.length, 1);
  assert.equal(report.warnings[0]?.setting, 'SELF_REMEDIATION_GITHUB_READ_TOKEN / SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256');
});

test('optional GitHub MCP absence is explicit while partial or malformed grants block execution', () => {
  const absent = inspectConfiguration(configured, 'live');
  assert.equal(absent.ready, true);
  assert.match(absent.warnings[0]!.reason, /acceptance will remain unexecuted/);
  const tokenOnly = inspectConfiguration({ ...configured, SELF_REMEDIATION_GITHUB_READ_TOKEN: 'secret-read-token' }, 'live');
  assert.equal(tokenOnly.ready, false);
  assert.equal(tokenOnly.errors[0]?.setting, 'SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256');
  const schemaOnly = inspectConfiguration({ ...configured, SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256: 'b'.repeat(64) }, 'live');
  assert.equal(schemaOnly.errors[0]?.setting, 'SELF_REMEDIATION_GITHUB_READ_TOKEN');
  const invalid = inspectConfiguration({ ...configured, SELF_REMEDIATION_GITHUB_READ_TOKEN: 'secret-read-token', SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256: 'private-invalid-digest' }, 'live');
  assert.equal(invalid.ready, false);
  assert.ok(!JSON.stringify(invalid).includes('private-invalid-digest'));
  const complete = inspectConfiguration({ ...configured, SELF_REMEDIATION_GITHUB_READ_TOKEN: 'secret-read-token', SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256: 'b'.repeat(64) }, 'live');
  assert.equal(complete.ready, true); assert.deepEqual(complete.warnings, []);
});

test('fixture needs no credentials and progress identity is validated only when requested', () => {
  assert.deepEqual(inspectConfiguration({}, 'fixture'), { schema: 'self-remediation-preflight/1', mode: 'fixture', ready: true, errors: [], warnings: [] });
  assert.equal(inspectConfiguration({ GITHUB_REPOSITORY: 'malformed', GITHUB_SHA: 'malformed' }, 'fixture').ready, true);
  const invalid = inspectConfiguration({ ...configured, GITHUB_REPOSITORY: 'private-invalid-repository', GITHUB_SHA: 'private-invalid-sha' }, 'live');
  assert.deepEqual(invalid.errors.map(item => item.setting), ['GITHUB_REPOSITORY', 'GITHUB_SHA']);
  assert.ok(!JSON.stringify(invalid).includes('private-invalid'));
  assert.equal(inspectConfiguration({}, 'private-invalid-mode').mode, null);
  assert.ok(!JSON.stringify(inspectConfiguration({}, 'private-invalid-mode')).includes('private-invalid-mode'));
});

test('CLI retains redacted failure and Actions summary without external operations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'self-remediation-preflight-'));
  try {
    const guard = join(directory, 'forbid-effects.cjs'), touched = join(directory, 'unexpected-effect');
    writeFileSync(guard, `const fs=require('node:fs'); const denied=()=>{fs.writeFileSync(${JSON.stringify(touched)},'effect attempted');throw Error('external effect forbidden');};
for(const name of ['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork'])require('node:child_process')[name]=denied;
for(const name of ['request','get']){require('node:http')[name]=denied;require('node:https')[name]=denied;}
require('node:net').connect=denied;require('node:net').createConnection=denied;require('node:tls').connect=denied;
globalThis.fetch=denied;require('node:module').syncBuiltinESMExports();\n`);
    const summary = join(directory, 'summary.md'), report = join(directory, 'failed.json');
    const result = spawnSync(process.execPath, ['--require', guard, resolve('scripts/preflight.mjs'), '--mode', 'live', '--output', report], {
      encoding: 'utf8', timeout: 10_000,
      env: { PATH: directory, GITHUB_STEP_SUMMARY: summary, SELF_REMEDIATION_PROGRESS: 'true', UNRELATED_SECRET: 'do-not-retain-this' },
    });
    assert.equal(result.status, 1); assert.equal(result.error, undefined);
    assert.equal(JSON.parse(readFileSync(report, 'utf8')).errors.length, 6);
    const retained = readFileSync(report, 'utf8') + readFileSync(summary, 'utf8') + result.stdout + result.stderr;
    assert.ok(!retained.includes('do-not-retain-this'));
    assert.match(retained, /self-remediation-live/); assert.match(retained, /OPENAI_API_KEY/);
    assert.ok(!existsSync(touched));
    const passed = spawnSync(process.execPath, ['--require', guard, resolve('scripts/preflight.mjs'), '--mode', 'live', '--output', join(directory, 'passed.json')], {
      encoding: 'utf8', timeout: 10_000, env: { ...configured, PATH: directory },
    });
    assert.equal(passed.status, 0, passed.stderr);
    for (const value of ['secret-provider-value', 'secret-check-token-value', 'explicit-model-value']) assert.ok(!(passed.stdout + passed.stderr + readFileSync(join(directory, 'passed.json'), 'utf8')).includes(value));
    assert.ok(!existsSync(touched));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('integration retains missing-config diagnostics before host setup and never advertises a nonexistent Check Run', () => {
  const directory = mkdtempSync(join(tmpdir(), 'self-remediation-startup-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/integration.ts', '--mode', 'live',
      '--case', 'business-logic', '--incident', 'configuration-failure', '--output', directory], {
      encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, SELF_REMEDIATION_MAX_CALL_MICRO_USD: '150000',
        SELF_REMEDIATION_PROGRESS: 'true', GH_TOKEN: 'fake-token-never-used',
        GITHUB_REPOSITORY: 'owner/repository', GITHUB_SHA: 'a'.repeat(40) },
    });
    assert.equal(result.status, 1, result.stderr);
    const configuration = JSON.parse(readFileSync(join(directory, 'integration-configuration.json'), 'utf8'));
    assert.deepEqual(configuration.errors.map((item: { setting: string }) => item.setting), ['OPENAI_API_KEY', 'SELF_REMEDIATION_MODEL']);
    const retained = JSON.parse(readFileSync(join(directory, 'integration-result.json'), 'utf8'));
    assert.equal(retained.status, 'FAILED_OR_UNEXECUTED');
    assert.equal(retained.controllerCode, null);
    assert.match(retained.failure, /Configuration preflight failed/);
    assert.ok(existsSync(join(directory, 'observation.done')));
    assert.ok(!existsSync(join(directory, 'check-state.json')));
    assert.ok(!existsSync(join(directory, 'events.jsonl')));
    assert.ok(!result.stdout.includes('Live observer:'));
    assert.ok(!(result.stdout + result.stderr).includes('fake-token-never-used'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
