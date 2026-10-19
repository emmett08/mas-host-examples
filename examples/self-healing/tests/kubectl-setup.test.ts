import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, copyFile, readdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a corrupt kubectl download is rejected before installation and its temporary file is removed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'self-remediation-kubectl-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scripts = join(directory, 'scripts'), bin = join(directory, 'bin');
  await mkdir(scripts); await mkdir(bin);
  // An impossible installed digest forces the download branch even when the
  // machine already has the pinned client. All hashing remains real.
  await copyFile('scripts/setup-kubectl.sh', join(scripts, 'setup-kubectl.sh'));
  await writeFile(join(directory, 'kubectl-version.txt'), `v1.32.3 ${'0'.repeat(64)}\n`);
  const attempted = join(directory, 'install-attempted');
  await writeFile(join(bin, 'curl'), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
const output=process.argv[process.argv.indexOf('--output')+1];writeFileSync(output,'corrupt-download');\n`, { mode: 0o700 });
  await writeFile(join(bin, 'sudo'), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(attempted)},'attempted');process.exit(1);\n`, { mode: 0o700 });
  const result = spawnSync('bash', [join(scripts, 'setup-kubectl.sh')], {
    encoding: 'utf8', timeout: 10000, env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory },
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /FAILED|did NOT match/);
  await assert.rejects(access(attempted));
  assert(!(await readdir(directory)).some(name => name.startsWith('self-remediation-kubectl.')));
});
