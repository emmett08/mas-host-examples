import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseAllDocuments } from 'yaml';

const execute = promisify(execFile);
const deploy = dirname(fileURLToPath(import.meta.url));

async function apply(t, setting, remediation) {
  const directory = await mkdtemp(join(tmpdir(), 'mas-deploy-payloads-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'kubectl.jsonl');
  await writeFile(join(directory, 'kubectl'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.at(-1) === '-' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + '\\n');
process.stdout.write('{}\\n');
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`,
    DEMO_MODE: 'fixture', MAS_IMAGE: 'mas-k3s-live:test', OPENAI_API_KEY: '', GHCR_PULL_TOKEN: '' };
  if (setting === undefined) delete env.SHOW_PAYLOADS;
  else env.SHOW_PAYLOADS = setting;
  if (remediation === undefined) delete env.DEMO_AUTO_REMEDIATE;
  else env.DEMO_AUTO_REMEDIATE = remediation;
  let error;
  try { await execute('bash', [join(deploy, 'apply.sh')], { env }); }
  catch (failure) { error = failure; }
  const calls = await readFile(log, 'utf8').then(text => text.trim().split('\n').map(JSON.parse))
    .catch(failure => { if (failure.code === 'ENOENT') return []; throw failure; });
  return { calls, error };
}

test('deployment defaults to metadata and explicitly enables payloads only on the dashboard', async t => {
  for (const setting of [undefined, 'false', 'true']) {
    const { calls, error } = await apply(t, setting);
    assert.equal(error, undefined);
    const expected = setting ?? 'false';
    const config = calls.find(call => call.args.includes('configmap'));
    assert.ok(config.args.includes(`--from-literal=showPayloads=${expected}`));
    const documents = calls.flatMap(call => parseAllDocuments(call.input).map(document => document.toJSON()));
    const deployment = documents.find(document => document?.kind === 'Deployment' && document.metadata.name === 'mas-demo');
    assert.equal(deployment.spec.template.metadata.annotations['demo.mas.dev/show-payloads'], expected,
      'Changing the payload setting must change the pod template and restart the dashboard');
    const containers = deployment.spec.template.spec.containers;
    assert.deepEqual(containers.find(container => container.name === 'dashboard').env.find(item => item.name === 'SHOW_PAYLOADS'), {
      name: 'SHOW_PAYLOADS', valueFrom: { configMapKeyRef: { name: 'mas-demo-settings', key: 'showPayloads', optional: true } },
    });
    assert.equal(containers.find(container => container.name === 'operator').env.some(item => item.name === 'SHOW_PAYLOADS'), false);
    assert.deepEqual(containers.find(container => container.name === 'dashboard').env.find(item => item.name === 'DEMO_VERIFIER_TOKEN'), {
      name: 'DEMO_VERIFIER_TOKEN', valueFrom: { secretKeyRef: { name: 'mas-demo-verifier', key: 'DEMO_VERIFIER_TOKEN', optional: true } },
    });
    assert.equal(containers.find(container => container.name === 'operator').env.some(item => item.name === 'DEMO_VERIFIER_TOKEN'), false);
  }
});

test('dedicated controller requires explicit enablement and receives neither model credentials nor backend storage', async t => {
  for (const setting of [undefined, 'false', 'true']) {
    const { calls, error } = await apply(t, 'true', setting);
    assert.equal(error, undefined);
    const expected = setting ?? 'false';
    assert.ok(calls.find(call => call.args.includes('configmap')).args.includes(`--from-literal=autoRemediate=${expected}`));
    const documents = calls.flatMap(call => parseAllDocuments(call.input).map(document => document.toJSON()));
    const controller = documents.find(document => document?.kind === 'Deployment' && document.metadata.name === 'mas-demo-remediator');
    assert.equal(controller.spec.replicas, 1);
    assert.equal(controller.spec.strategy.type, 'Recreate');
    assert.equal(controller.spec.template.metadata.annotations['demo.mas.dev/auto-remediate'], expected);
    assert.equal(controller.spec.template.spec.serviceAccountName, 'mas-demo-remediator');
    const container = controller.spec.template.spec.containers[0];
    assert.equal(container.env.some(variable => variable.name === 'OPENAI_API_KEY'), false);
    assert.deepEqual(container.env.find(variable => variable.name === 'DEMO_VERIFIER_TOKEN').valueFrom,
      { secretKeyRef: { name: 'mas-demo-verifier', key: 'DEMO_VERIFIER_TOKEN' } });
    assert.deepEqual(container.env.find(variable => variable.name === 'DEMO_AUTO_REMEDIATE').valueFrom,
      { configMapKeyRef: { name: 'mas-demo-settings', key: 'autoRemediate' } });
    assert.equal(controller.spec.template.spec.volumes.some(volume => volume.persistentVolumeClaim), false);
    assert.ok(calls.some(call => call.args.includes('crd/masremediations.demo.mas.dev')));
  }
});

test('invalid remediation settings fail before any Kubernetes mutation', async t => {
  for (const setting of ['', 'TRUE', 'yes', '1']) {
    const { calls, error } = await apply(t, 'true', setting);
    assert.match(error.stderr, /DEMO_AUTO_REMEDIATE must be true or false/);
    assert.deepEqual(calls, []);
  }
});

test('invalid payload settings fail before any Kubernetes mutation', async t => {
  for (const setting of ['', 'TRUE', 'yes', '1']) {
    const { calls, error } = await apply(t, setting);
    assert.match(error.stderr, /SHOW_PAYLOADS must be true or false/);
    assert.deepEqual(calls, []);
  }
});
