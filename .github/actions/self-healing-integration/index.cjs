// A Node action receives artifact runtime credentials without exporting them to
// later workflow steps. No token is written to GITHUB_ENV or GITHUB_OUTPUT.
const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const mode = process.env.INPUT_MODE;
const selected = process.env.INPUT_CASE;
const output = process.env.INPUT_OUTPUT;
if (!['fixture', 'live'].includes(mode) || !/^[a-z-]{1,80}$/.test(selected ?? '') || !output?.startsWith('/'))
  throw new Error('Invalid integration action inputs');
const child = spawn('node', ['--import', 'tsx', 'scripts/integration.ts', '--mode', mode, '--case', selected, '--output', output], {
  cwd: resolve(process.env.GITHUB_WORKSPACE, 'examples/self-healing'), env: process.env, stdio: 'inherit',
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
