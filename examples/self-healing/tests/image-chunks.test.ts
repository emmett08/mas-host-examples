import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeImageArchive, verifyImageArchive, streamImageArchive, type ImageArchive } from '../deploy/image.js';

const configDigest = 'sha256:' + 'a'.repeat(64);
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: any, size = 8 * 1024 * 1024 + 123) {
  const directory = await mkdtemp(join(tmpdir(), 'mas-image-chunks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.alloc(size, 41);
  async function* source() { for (let offset = 0; offset < bytes.length; offset += 300001) yield bytes.subarray(offset, offset + 300001); }
  const archive = await writeImageArchive(join(directory, 'image-archive.json'), configDigest, source());
  return { directory, archive, bytes };
}
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    result.push(...entry.isDirectory() ? await files(path) : [path]);
  }
  return result;
}
async function consumed(archive: ImageArchive) {
  const digest = createHash('sha256'); let bytes = 0;
  for await (const chunk of streamImageArchive(archive)) { digest.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: digest.digest('hex') };
}

test('chunk archive preserves arbitrary source boundaries and verifies retained content', async t => {
  const { directory, archive, bytes } = await fixture(t);
  assert.equal(archive.version, 'mas-image-archive/2');
  assert.equal(archive.sha256, hash(bytes)); assert.equal(archive.configDigest, configDigest);
  assert.equal(archive.manifestSha256, hash(await readFile(archive.path)));
  await verifyImageArchive(archive);
  assert.deepEqual(await consumed(archive), { bytes: bytes.length, sha256: hash(bytes) });
  for (const path of await files(directory)) assert((await stat(path)).size <= 8 * 1024 * 1024, 'each retained file fits beneath the host file bound');
});

test('archive over 64 MiB survives the real pinned-host file-size limit without raising it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mas-image-rlimit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceUrl = new URL('../deploy/image.ts', import.meta.url).href;
  const child = `
    import assert from 'node:assert/strict';
    import {writeFileSync,truncateSync,unlinkSync} from 'node:fs';
    import {createHash} from 'node:crypto';
    import {writeImageArchive,verifyImageArchive,streamImageArchive} from ${JSON.stringify(sourceUrl)};
    const directory=process.argv[1];
    const large=directory+'/monolithic-control';writeFileSync(large,'');
    assert.throws(()=>truncateSync(large,64*1024*1024+1),{code:'EFBIG'});unlinkSync(large);
    const part=Buffer.alloc(256*1024,73);const expected=createHash('sha256');
    async function* source(){for(let i=0;i<288;i++){expected.update(part);yield part;}}
    const archive=await writeImageArchive(directory+'/image-archive.json',${JSON.stringify(configDigest)},source());
    await verifyImageArchive(archive);
    let bytes=0;const actual=createHash('sha256');
    for await(const part of streamImageArchive(archive)){bytes+=part.length;actual.update(part);}
    assert.equal(bytes,72*1024*1024);assert.equal(actual.digest('hex'),expected.digest('hex'));
    process.stdout.write(JSON.stringify({bytes,archive}));
  `;
  // Python establishes the actual Linux limit before exec. The same limit remains
  // in force for Node and every descendant; no Docker/provider is simulated here.
  const result = spawnSync('python3', ['-c',
    "import os,resource,signal,sys; signal.signal(signal.SIGXFSZ,signal.SIG_IGN); resource.setrlimit(resource.RLIMIT_FSIZE,(67108864,67108864)); os.execv(sys.argv[1],sys.argv[1:])",
    process.execPath, '--import', 'tsx', '--input-type=module', '--eval', child, directory],
  { cwd: dirname(dirname(fileURLToPath(import.meta.url))), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, `${result.error ?? ''} ${result.signal ?? ''} ${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).bytes, 72 * 1024 * 1024);
  for (const path of await files(directory)) assert((await stat(path)).size <= 8 * 1024 * 1024);
});

test('chunk mutation and symlink substitution fail verification and streaming', async t => {
  const { directory, archive } = await fixture(t, 1024);
  const chunk = (await files(directory)).find(path => path !== archive.path)!;
  const original = await readFile(chunk);
  await chmod(chunk, 0o600); await writeFile(chunk, Buffer.alloc(original.length, 0));
  await assert.rejects(verifyImageArchive(archive)); await assert.rejects(consumed(archive));
  await writeFile(chunk, original); await verifyImageArchive(archive);
  const outside = join(tmpdir(), `mas-image-outside-${process.pid}-${Date.now()}`);
  t.after(() => rm(outside, { force: true })); await writeFile(outside, original);
  await rm(chunk); await symlink(outside, chunk);
  await assert.rejects(verifyImageArchive(archive)); await assert.rejects(consumed(archive));
});

test('manifest mutation or manifest symlink cannot replace the frozen archive identity', async t => {
  const { directory, archive } = await fixture(t, 1024);
  const original = await readFile(archive.path);
  await chmod(archive.path, 0o600); await writeFile(archive.path, Buffer.concat([original, Buffer.from(' ')]));
  await assert.rejects(verifyImageArchive(archive));
  const alternate = join(directory, 'alternate.json'); await writeFile(alternate, original);
  await rm(archive.path); await symlink(alternate, archive.path);
  await assert.rejects(verifyImageArchive(archive));
});

test('even rehashed manifests cannot admit traversal, excessive resource declarations or inconsistent identities', async t => {
  const mutations: Array<[string, (value: any) => void]> = [
    ['traversal', value => { value.chunks[0].sha256 = '../../outside'; }],
    ['aggregate overflow', value => { value.bytes = 2 * 1024 * 1024 * 1024 + 1; }],
    ['chunk overflow', value => { value.chunks[0].bytes = 8 * 1024 * 1024 + 1; value.bytes = value.chunks[0].bytes; }],
    ['excessive chunk count', value => { value.chunks = Array.from({ length: 257 }, () => ({ ...value.chunks[0] })); value.bytes *= 257; }],
    ['inconsistent stream length', value => { value.bytes++; }],
    ['changed config identity', value => { value.configDigest = 'sha256:' + 'b'.repeat(64); }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async child => {
    const { archive } = await fixture(child, 1024);
    const value = JSON.parse(await readFile(archive.path, 'utf8')); mutate(value);
    const bytes = JSON.stringify(value); await chmod(archive.path, 0o600); await writeFile(archive.path, bytes);
    const changed = { ...archive, manifestSha256: hash(bytes) };
    await assert.rejects(verifyImageArchive(changed));
    let emitted = 0;
    await assert.rejects(async () => { for await (const data of streamImageArchive(changed)) emitted += data.length; });
    assert.equal(emitted, 0, 'invalid archive must not send any bytes to Docker load');
  });
});

test('archive manifest size and sibling directory projection remain bounded', async t => {
  const { directory, archive } = await fixture(t, 1024);
  const original = await readFile(archive.path);
  const oversized = Buffer.concat([original, Buffer.alloc(64 * 1024, 32)]);
  await chmod(archive.path, 0o600); await writeFile(archive.path, oversized);
  await assert.rejects(verifyImageArchive({ ...archive, manifestSha256: hash(oversized) }));
  await writeFile(archive.path, original);
  const outside = join(directory, 'outside-parts'); await rename(archive.path + '.parts', outside);
  await symlink(outside, archive.path + '.parts');
  await assert.rejects(verifyImageArchive(archive));
});
