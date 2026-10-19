import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { runTrustedOperation } from './tool.js';
import { externalReceiptSchema } from '../deploy/capabilities.js';

const sdkRoot = resolve(process.env.MAS_SDK_ROOT ?? '../../.tools/mas-host');
const binary = resolve(process.env.MAS_HOST_BIN ?? join(sdkRoot, 'target/debug/mas-host'));

test('pinned kubectl starts and reads through the real host without relaxing its resource limits', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'self-remediation-kubectl-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const [version, digest] = (await readFile('kubectl-version.txt', 'utf8')).trim().split(/\s+/);
  const requests: string[] = [];
  // A labelled HTTP protocol control, not a real cluster or recovery claim.
  const resources: Record<string, unknown> = {
    '/api': { apiVersion: 'v1', kind: 'APIVersions', versions: ['v1'], serverAddressByClientCIDRs: [] },
    '/apis': { apiVersion: 'v1', kind: 'APIGroupList', groups: [] },
    '/api/v1': { apiVersion: 'v1', kind: 'APIResourceList', groupVersion: 'v1', resources: [
      { name: 'namespaces', singularName: 'namespace', namespaced: false, kind: 'Namespace', verbs: ['get'] },
    ] },
    '/api/v1/namespaces/mas-repair-control': { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'mas-repair-control', uid: 'namespace-control' } },
  };
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const resource = resources[new URL(request.url!, 'http://control').pathname];
    response.writeHead(resource && request.method === 'GET' ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(resource ?? { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'NotFound', code: 404 }));
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  t.after(() => new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())));
  const address = server.address(); assert(address && typeof address !== 'string');
  const kubeconfig = join(stateDir, 'kubeconfig.json');
  await writeFile(kubeconfig, JSON.stringify({ apiVersion: 'v1', kind: 'Config',
    clusters: [{ name: 'control', cluster: { server: `http://127.0.0.1:${address.port}` } }],
    contexts: [{ name: 'control', context: { cluster: 'control', user: 'control' } }],
    'current-context': 'control', users: [{ name: 'control', user: {} }],
  }));
  const runtimeBundle = join(stateDir, 'kubectl-control.mjs');
  await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'kubectl-host-control.ts', contents: `
    import assert from 'node:assert/strict';
    import {readFileSync,accessSync,constants} from 'node:fs';
    import {join} from 'node:path';
    import {createHash} from 'node:crypto';
    import {KubectlTransport} from './deploy/trial.ts';
    const input=JSON.parse(readFileSync(0,'utf8'));
    const executable=process.env.SELF_REMEDIATION_TEST_KUBECTL || process.env.PATH.split(':').map(directory=>join(directory,'kubectl')).find(path=>{
      try {accessSync(path,constants.X_OK);return true;} catch {return false;}
    });
    assert(executable,'Install the pinned client with scripts/setup-kubectl.sh');
    assert.equal(createHash('sha256').update(readFileSync(executable)).digest('hex'),${JSON.stringify(digest)},'Host PATH must select the checksum-pinned client');
    const client=new KubectlTransport(process.env.KUBECONFIG,executable);
    const version=await client.command(['version','--client','-o','json']);
    assert.equal(version.code,0);
    assert.equal(JSON.parse(version.stdout).clientVersion.gitVersion,${JSON.stringify(version)});
    for(let i=0;i<3;i++){
      const result=await client.get('namespace','mas-repair-control');
      assert.equal(result.metadata.uid,'namespace-control');
    }
    const limits=readFileSync('/proc/self/limits','utf8');
    assert.match(limits,/Max address space\\s+2147483648\\s+2147483648/);
    assert.match(limits,/Max file size\\s+67108864\\s+67108864/);
    process.stdout.write(JSON.stringify({operationId:input.operationId,invocation_id:process.argv[3],status:'COMPLETED',result:{version:${JSON.stringify(version)},sha256:${JSON.stringify(digest)},reads:3}}));
  ` }, outfile: runtimeBundle, bundle: true, platform: 'node', target: 'node24', format: 'esm' });
  const result = await runTrustedOperation<{ operationId: string; invocation_id: string; result: { version: string; sha256: string; reads: number } }>(
    { binary, sdkRoot, stateDir }, 'kubectl-resource-control', { operationId: 'kubectl-resource-control' }, {
      runtimeBundle, operationName: 'kubectl_control/1', timeoutMs: 30000, outputBytes: 4096,
      inputSchema: { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'], additionalProperties: false },
      // CI uses the host's normal restricted PATH. Local checks may supply an
      // explicit downloaded client when /usr/local/bin is not writable.
      outputSchema: externalReceiptSchema, environment: { KUBECONFIG: kubeconfig,
        ...(process.env.SELF_REMEDIATION_TEST_KUBECTL ? { SELF_REMEDIATION_TEST_KUBECTL: resolve(process.env.SELF_REMEDIATION_TEST_KUBECTL) } : {}),
      },
    });
  assert.deepEqual(result.receipt.result, { version, sha256: digest, reads: 3 });
  assert.deepEqual(requests.filter(request => request.startsWith('GET /api/v1/namespaces/')),
    Array(3).fill('GET /api/v1/namespaces/mas-repair-control?timeout=20s'));
  assert(requests.every(request => request.startsWith('GET ')), 'Client control must perform no writes');
  assert.equal(result.calls, 1);
});
