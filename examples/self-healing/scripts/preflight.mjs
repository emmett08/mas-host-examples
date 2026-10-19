/** Local configuration checks. This module never contacts a provider or external service. */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * Only setting names and fixed guidance leave this function. In particular,
 * credentials and malformed input values never enter retained diagnostics.
 * @param {Record<string, string | undefined>} env
 * @param {string} mode
 */
export function inspectConfiguration(env, mode) {
  const errors = [];
  const warnings = [];
  const present = name => typeof env[name] === 'string' && env[name].trim().length > 0;
  const error = (setting, reason) => errors.push({ setting, reason });
  if (!['live', 'fixture'].includes(mode)) error('mode', 'Select live or fixture mode.');
  if (mode === 'live') {
    if (!present('OPENAI_API_KEY')) error('OPENAI_API_KEY', 'Set this secret in the self-remediation-live environment.');
    if (!present('SELF_REMEDIATION_MODEL')) error('SELF_REMEDIATION_MODEL', 'Set an explicit provider model variable in the self-remediation-live environment.');
    const reservation = env.SELF_REMEDIATION_MAX_CALL_MICRO_USD?.trim() ?? '';
    if (!/^\d+$/.test(reservation) || !Number.isSafeInteger(Number(reservation)) || Number(reservation) < 1 || Number(reservation) > 2_000_000)
      error('SELF_REMEDIATION_MAX_CALL_MICRO_USD', 'Set an integer reservation from 1 to 2000000 micro-USD, checked against the selected model and admitted token limits.');

    const token = present('SELF_REMEDIATION_GITHUB_READ_TOKEN');
    const schema = present('SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256');
    if (!token && !schema) warnings.push({ setting: 'SELF_REMEDIATION_GITHUB_READ_TOKEN / SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256',
      reason: 'Official GitHub MCP metadata acceptance will remain unexecuted. Configure both settings to enable the read operation.' });
    else {
      if (!token) error('SELF_REMEDIATION_GITHUB_READ_TOKEN', 'Configure this read-only secret together with the frozen MCP schema digest, or leave both unset.');
      if (!schema) error('SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256', 'Configure the frozen MCP schema digest together with the read-only token, or leave both unset.');
      else if (!/^[a-f0-9]{64}$/.test(env.SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256))
        error('SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256', 'Use the reviewed 64-character lowercase hexadecimal digest of the admitted tool name and input schema.');
    }
  }
  if (env.SELF_REMEDIATION_PROGRESS === 'true') {
    if (!present('GH_TOKEN')) error('GH_TOKEN', 'Supply the progress publisher token with checks: write permission.');
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(env.GITHUB_REPOSITORY ?? ''))
      error('GITHUB_REPOSITORY', 'Supply the exact OWNER/REPOSITORY identity for the progress Check Run.');
    if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) error('GITHUB_SHA', 'Supply the exact 40-character lowercase hexadecimal workflow source commit.');
  }
  return { schema: 'self-remediation-preflight/1', mode: ['live', 'fixture'].includes(mode) ? mode : null,
    ready: errors.length === 0, errors, warnings };
}

export function main() {
  const { values } = parseArgs({ options: { mode: { type: 'string' }, output: { type: 'string' } } });
  if (!values.mode || !values.output) throw new Error('usage');
  const report = inspectConfiguration(process.env, values.mode);
  const output = resolve(values.output);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const lines = [report.ready ? 'Self-healing configuration checks passed.' : 'Self-healing configuration checks failed.'];
  for (const item of report.errors) lines.push(`ERROR ${item.setting}: ${item.reason}`);
  for (const item of report.warnings) lines.push(`WARNING ${item.setting}: ${item.reason}`);
  lines.push('Configure Settings → Environments → self-remediation-live. No provider, GitHub or cluster operation was attempted by this check.');
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Self-healing configuration\n\n${lines.map(line => `- ${line}`).join('\n')}\n\n`, { mode: 0o600 });
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch {
    // Filesystem errors can contain supplied paths. Keep failure output value-free.
    process.stderr.write('Unable to retain configuration preflight. Use --mode live|fixture --output FILE and a new writable report path.\n');
    process.exitCode = 1;
  }
}
