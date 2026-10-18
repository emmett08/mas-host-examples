import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, effect, type EffectStore, type Json, type OperationIdentity, type Reconciliation } from './effects.js';
import { redact } from '../ui/events.js';

export interface ImageCommandDiagnostic {
  tool: string; operation: string; exitCode: number | null; signal: string | null;
  timedOut: boolean; outputExceeded: boolean; message: string; externalOutcome: 'not-inferred';
}
export interface ImageCommandOptions {
  timeout?: number; onDiagnostic?: (value: ImageCommandDiagnostic) => void;
  input?: AsyncIterable<Uint8Array>; output?: (value: Buffer) => Promise<void>;
}
/** Foreground bounded stream adapter: it never resets inherited host resource limits. */
export async function runImageCommand(executable: string, args: string[], options: ImageCommandOptions = {}): Promise<string> {
  const child = spawn(executable, args, { env: { PATH: process.env.PATH, HOME: '/tmp/mas-image-transport' }, stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let output = '', diagnostic = ''; let bytes = 0; let bound = false, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeout ?? 90_000);
  const closed = new Promise<{ code: number | null; signal: string | null }>((accept, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal }));
  });
  child.stderr!.on('data', (data: Buffer) => { if (diagnostic.length < 12000) diagnostic += data.toString().slice(0, 12000 - diagnostic.length); });
  child.stdin?.on('error', () => {}); // Each pending write callback carries this failure.
  const drain = async () => {
    for await (const part of child.stdout!) {
      const data = part as Buffer;
      if (options.output) await options.output(data);
      else { bytes += data.length; if (bytes > 256 * 1024) { bound = true; throw new Error('Image command output bound exceeded'); } output += data.toString(); }
    }
  };
  const feed = async () => {
    if (!options.input) return;
    for await (const data of options.input) await new Promise<void>((accept, reject) => child.stdin!.write(data, error => error ? reject(error) : accept()));
    child.stdin!.end();
  };
  try {
    const [result] = await Promise.all([closed, drain(), feed()]);
    if (result.code !== 0 || result.signal || bound) throw new Error('Image command did not complete successfully');
    return output;
  } catch (error) {
    child.kill('SIGKILL');
    const result = await closed.catch(() => ({ code: null, signal: null }));
    let message = String(redact(diagnostic || (error instanceof Error ? error.message : 'Image command failed'), false));
    for (const [name, value] of Object.entries(process.env)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY/i.test(name) && value && value.length >= 4) message = message.replaceAll(value, '[redacted]');
    message = message.replace(/((?:token|password|secret|authorization|client-key-data|client-certificate-data)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]').slice(0, 4096);
    options.onDiagnostic?.({ tool: basename(executable), operation: args[0] ?? 'unknown', exitCode: result.code, signal: result.signal,
      timedOut, outputExceeded: bound, message, externalOutcome: 'not-inferred' });
    throw new Error(`${basename(executable)} trusted image transport failed`);
  } finally { clearTimeout(timer); }
}
export async function imageCommand(executable: string, args: string[], timeout = 90_000,
  onDiagnostic?: (value: ImageCommandDiagnostic) => void): Promise<string> {
  return runImageCommand(executable, args, { timeout, onDiagnostic });
}
const command = imageCommand;
export interface ImportedImage { imageDigest: string; configDigest: string; manifestDigest: string; cluster: string }
export interface ImageArchive {
  version: 'mas-image-archive/2'; path: string; sha256: string; configDigest: string; manifestSha256: string;
}
export const IMAGE_CHUNK_BYTES = 8 * 1024 * 1024;
export const IMAGE_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
export const IMAGE_ARCHIVE_CHUNKS = 256;
interface ArchiveManifest {
  version: 'mas-image-archive/2'; sha256: string; configDigest: string; bytes: number;
  chunks: Array<{ sha256: string; bytes: number }>;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const validDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
async function readBoundedFile(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat(); if (!info.isFile() || info.size > maximum) throw new Error('Archive file exceeds bound or is not regular');
    const bytes = Buffer.alloc(info.size + 1); let count = 0;
    for (;;) { const result = await file.read(bytes, count, bytes.length - count, count); count += result.bytesRead;
      if (!result.bytesRead || count === bytes.length) break; }
    if (count !== info.size) throw new Error('Archive file changed during bounded read');
    return bytes.subarray(0, count);
  } finally { await file.close(); }
}
async function manifest(archive: ImageArchive): Promise<ArchiveManifest> {
  if (archive.version !== 'mas-image-archive/2' || !validDigest(archive.sha256) || !validDigest(archive.manifestSha256)
    || !/^sha256:[a-f0-9]{64}$/.test(archive.configDigest) || !archive.path.endsWith('.json')) throw new Error('Exact chunked image archive identity required');
  const bytes = await readBoundedFile(resolve(archive.path), 64 * 1024);
  if (digest(bytes) !== archive.manifestSha256) throw new Error('Retained archive manifest changed');
  const value = JSON.parse(bytes.toString()) as ArchiveManifest;
  if (value.version !== archive.version || value.sha256 !== archive.sha256 || value.configDigest !== archive.configDigest
    || canonical(Object.keys(value).sort()) !== canonical(['bytes','chunks','configDigest','sha256','version'])
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > IMAGE_ARCHIVE_BYTES
    || !Array.isArray(value.chunks) || !value.chunks.length || value.chunks.length > IMAGE_ARCHIVE_CHUNKS
    || value.chunks.some(chunk => canonical(Object.keys(chunk).sort()) !== canonical(['bytes','sha256']) || !validDigest(chunk.sha256) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > IMAGE_CHUNK_BYTES)
    || value.chunks.reduce((total, chunk) => total + chunk.bytes, 0) !== value.bytes) throw new Error('Archive manifest violates aggregate, chunk or identity bounds');
  const parts = resolve(archive.path) + '.parts', info = await lstat(parts);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parts) !== join(await realpath(dirname(parts)), basename(parts))) throw new Error('Archive chunks escape the admitted directory');
  return value;
}
async function* parts(archive: ImageArchive, value: ArchiveManifest): AsyncGenerator<Buffer> {
  for (const chunk of value.chunks) {
    const bytes = await readBoundedFile(join(resolve(archive.path) + '.parts', chunk.sha256), IMAGE_CHUNK_BYTES);
    if (bytes.length !== chunk.bytes || digest(bytes) !== chunk.sha256) throw new Error('Retained image chunk changed');
    yield bytes;
  }
}
export async function verifyImageArchive(archive: ImageArchive): Promise<void> {
  const value = await manifest(archive), hash = createHash('sha256');
  for await (const chunk of parts(archive, value)) hash.update(chunk);
  if (hash.digest('hex') !== archive.sha256) throw new Error('Retained image archive stream changed');
}
export async function* streamImageArchive(archive: ImageArchive): AsyncGenerator<Buffer> {
  // Verify the complete stream before any consumer (especially Docker load) sees bytes.
  await verifyImageArchive(archive);
  yield* parts(archive, await manifest(archive));
}
async function archiveWriter(path: string, configDigest: string) {
  if (!path.endsWith('.json') || !/^sha256:[a-f0-9]{64}$/.test(configDigest)) throw new Error('Immutable image and JSON archive manifest path required');
  path = resolve(path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = path + '.parts'; await mkdir(directory, { mode: 0o700 }); // Exclusive: partial writes must reconcile, never overwrite.
  const sync = async (file: string) => { const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } };
  const hash = createHash('sha256'), chunks: ArchiveManifest['chunks'] = [];
  let total = 0, pendingBytes = 0; let pending: Buffer[] = [];
  const flush = async () => {
    if (!pendingBytes) return;
    const bytes = Buffer.concat(pending, pendingBytes), sha256 = digest(bytes), file = join(directory, sha256);
    try { await writeFile(file, bytes, { mode: 0o400, flag: 'wx' }); }
    catch (error: any) { if (error.code !== 'EEXIST' || !(await readBoundedFile(file, IMAGE_CHUNK_BYTES)).equals(bytes)) throw error; }
    await sync(file);
    chunks.push({ sha256, bytes: pendingBytes }); pending = []; pendingBytes = 0;
  };
  return {
    async write(data: Uint8Array) {
      total += data.byteLength; if (total > IMAGE_ARCHIVE_BYTES) throw new Error('Image archive aggregate bound exceeded');
      hash.update(data); let cursor = 0;
      while (cursor < data.byteLength) {
        const length = Math.min(IMAGE_CHUNK_BYTES - pendingBytes, data.byteLength - cursor);
        pending.push(Buffer.from(data.subarray(cursor, cursor + length))); pendingBytes += length; cursor += length;
        if (pendingBytes === IMAGE_CHUNK_BYTES) await flush();
      }
    },
    async finish(): Promise<ImageArchive> {
      await flush(); if (!total || chunks.length > IMAGE_ARCHIVE_CHUNKS) throw new Error('Empty or excessive image archive');
      const value: ArchiveManifest = { version: 'mas-image-archive/2', sha256: hash.digest('hex'), configDigest, bytes: total, chunks };
      await sync(directory);
      const bytes = Buffer.from(canonical(value)); await writeFile(path, bytes, { mode: 0o400, flag: 'wx' }); await sync(path); await sync(dirname(path));
      return { version: value.version, path, sha256: value.sha256, configDigest, manifestSha256: digest(bytes) };
    },
  };
}
export async function writeImageArchive(path: string, configDigest: string, input: AsyncIterable<Uint8Array>): Promise<ImageArchive> {
  const writer = await archiveWriter(path, configDigest); for await (const bytes of input) await writer.write(bytes); return writer.finish();
}
/** Delete only a verified manifest and its fixed sibling chunk directory (preflight cleanup). */
export async function removeImageArchive(archive: ImageArchive): Promise<void> {
  await verifyImageArchive(archive); await rm(resolve(archive.path)); await rm(resolve(archive.path) + '.parts', { recursive: true });
}
export async function archiveDigest(path: string): Promise<string> {
  const bytes = await readBoundedFile(resolve(path), 64 * 1024), value = JSON.parse(bytes.toString()) as ArchiveManifest;
  const archive: ImageArchive = { version: value.version, path, sha256: value.sha256, configDigest: value.configDigest, manifestSha256: digest(bytes) };
  await verifyImageArchive(archive); return archive.sha256;
}
export interface ImageExecutor {
  command: typeof imageCommand;
  stream: typeof runImageCommand;
}
const nativeExecutor: ImageExecutor = { command: imageCommand, stream: runImageCommand };
export async function exportImage(journal: EffectStore, identity: OperationIdentity, configDigest: string, path: string,
  executor: ImageExecutor = nativeExecutor): Promise<ImageArchive> {
  if (!/^sha256:[a-f0-9]{64}$/.test(configDigest) || !path.endsWith('.json')) throw new Error('Immutable image and JSON archive manifest required');
  path = resolve(path);
  const inspect = async (): Promise<ImageArchive | undefined> => {
    try {
      const bytes = await readBoundedFile(path, 64 * 1024), value = JSON.parse(bytes.toString()) as ArchiveManifest;
      const archive: ImageArchive = { version: value.version, path, sha256: value.sha256, configDigest, manifestSha256: digest(bytes) };
      await verifyImageArchive(archive);
      const extract = (name: string) => executor.stream('tar', ['-xOf', '-', name], { timeout: 120_000, input: streamImageArchive(archive) });
      const images = JSON.parse(await extract('manifest.json')), name = images?.[0]?.Config;
      if (images.length !== 1 || typeof name !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(name) || name.split('/').includes('..')) return undefined;
      if (`sha256:${createHash('sha256').update(await extract(name)).digest('hex')}` !== configDigest) return undefined;
      return archive;
    } catch { return undefined; }
  };
  const result = await effect(journal, identity, 'image.export', `image-archive:${path}`, { path, configDigest }, async () => {
    const writer = await archiveWriter(path, configDigest);
    await executor.stream('docker', ['image', 'save', configDigest], { timeout: 120_000, output: writer.write });
    await writer.finish(); const observed = await inspect(); if (!observed) throw new Error('Exported image identity unavailable');
    return observed as unknown as Json;
  }, async () => { const observed = await inspect(); return observed ? { status: 'completed', receipt: observed as unknown as Json } : { status: 'unknown' }; });
  return result as unknown as ImageArchive;
}
export async function loadImage(journal: EffectStore, identity: OperationIdentity, archive: ImageArchive,
  executor: ImageExecutor = nativeExecutor): Promise<{ configDigest: string }> {
  await verifyImageArchive(archive); // No Docker process starts before full validation.
  const inspect = async () => {
    try { return JSON.parse(await executor.command('docker', ['image', 'inspect', archive.configDigest]))?.[0]?.Id === archive.configDigest; }
    catch { return false; }
  };
  await effect(journal, identity, 'image.load', `image:${archive.configDigest}`, archive as unknown as Json, async () => {
    await executor.stream('docker', ['image', 'load'], { timeout: 120_000, input: streamImageArchive(archive) });
    if (!await inspect()) throw new Error('Retained image not present after load');
    return { configDigest: archive.configDigest };
  }, async () => await inspect() ? { status: 'completed', receipt: { configDigest: archive.configDigest } } : { status: 'unknown' });
  return { configDigest: archive.configDigest };
}
/** Transfers an already built immutable image. No generated executable runs in this process.
 * The disposable cluster contains one server and no agent nodes. */
export async function importK3dImage(journal: EffectStore, identity: OperationIdentity, configDigest: string,
  cluster = 'self-remediation', execute = command): Promise<ImportedImage> {
  if (!/^sha256:[a-f0-9]{64}$/.test(configDigest) || !/^[a-z][a-z0-9-]{0,35}$/.test(cluster)) throw new Error('Pinned local image and bounded cluster name required');
  const node = `k3d-${cluster}-server-0`;
  const tag = `docker.io/library/mas-self-remediation:${configDigest.slice(7)}`;
  const inspect = async (): Promise<ImportedImage | undefined> => {
    const listed = await execute('docker', ['exec', node, 'ctr', '--address', '/run/k3s/containerd/containerd.sock', '--namespace', 'k8s.io', 'images', 'list']);
    const row = listed.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[0] === tag);
    const manifestDigest = row?.[2];
    if (!manifestDigest || !/^sha256:[a-f0-9]{64}$/.test(manifestDigest)) return undefined;
    const manifest = JSON.parse(await execute('docker', ['exec', node, 'ctr', '--address', '/run/k3s/containerd/containerd.sock', '--namespace', 'k8s.io', 'content', 'get', manifestDigest]));
    if (manifest.config?.digest !== configDigest) throw new Error('Imported image manifest/config identity mismatch');
    const imageDigest = `docker.io/library/mas-self-remediation@${manifestDigest}`;
    const alias = listed.split('\n').some(line => line.trim().split(/\s+/)[0] === imageDigest);
    return alias ? { imageDigest, configDigest, manifestDigest, cluster } : undefined;
  };
  const input = { configDigest, cluster, tag };
  const result = await effect(journal, identity, 'k3d.import-image', `k3d:${cluster}:${configDigest}`, input, async () => {
    const local = JSON.parse(await execute('docker', ['image', 'inspect', configDigest]));
    if (local[0]?.Id !== configDigest) throw new Error('Built image no longer available');
    await execute('docker', ['tag', configDigest, tag]);
    await execute('k3d', ['image', 'import', tag, '--cluster', cluster, '--mode', 'direct'], 120_000);
    const listed = await execute('docker', ['exec', node, 'ctr', '--address', '/run/k3s/containerd/containerd.sock', '--namespace', 'k8s.io', 'images', 'list']);
    const row = listed.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[0] === tag);
    const manifestDigest = row?.[2];
    if (!manifestDigest || !/^sha256:[a-f0-9]{64}$/.test(manifestDigest)) throw new Error('Imported manifest identity unavailable');
    const manifest = JSON.parse(await execute('docker', ['exec', node, 'ctr', '--address', '/run/k3s/containerd/containerd.sock', '--namespace', 'k8s.io', 'content', 'get', manifestDigest]));
    if (manifest.config?.digest !== configDigest) throw new Error('Imported manifest differs from independently built image');
    await execute('docker', ['exec', node, 'ctr', '--address', '/run/k3s/containerd/containerd.sock', '--namespace', 'k8s.io', 'images', 'tag', tag, `docker.io/library/mas-self-remediation@${manifestDigest}`]);
    const observed = await inspect();
    if (!observed) throw new Error('Immutable image alias not observed');
    return observed as unknown as Json;
  }, async (): Promise<Reconciliation> => {
    const observed = await inspect();
    return observed ? { status: 'completed', receipt: observed as unknown as Json } : { status: 'unknown' };
  });
  return result as unknown as ImportedImage;
}
