import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { effect, type EffectStore, type Json, type OperationIdentity, type Reconciliation } from './effects.js';
import { redact } from '../ui/events.js';

export interface ImageCommandDiagnostic {
  tool: string; operation: string; exitCode: number | null; signal: string | null;
  timedOut: boolean; outputExceeded: boolean; message: string; externalOutcome: 'not-inferred';
}
export async function imageCommand(executable: string, args: string[], timeout = 90_000,
  onDiagnostic?: (value: ImageCommandDiagnostic) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: { PATH: process.env.PATH, HOME: '/tmp/mas-image-transport' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostic = ''; let bytes = 0; let bound = false, timedOut = false, settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 256 * 1024) { bound = true; child.kill(); } else output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { if (diagnostic.length < 12000) diagnostic += data.toString().slice(0, 12000 - diagnostic.length); });
    const fail = (code: number | null, signal: string | null, message: string) => {
      let redacted = String(redact(message, false));
      for (const [name, value] of Object.entries(process.env)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY/i.test(name) && value && value.length >= 4) redacted = redacted.replaceAll(value, '[redacted]');
      redacted = redacted.replace(/((?:token|password|secret|authorization|client-key-data|client-certificate-data)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]').slice(0, 4096);
      try { onDiagnostic?.({ tool: basename(executable), operation: args[0] ?? 'unknown', exitCode: code, signal,
        timedOut, outputExceeded: bound, message: redacted, externalOutcome: 'not-inferred' }); }
      catch { reject(new Error('Image transport failure diagnostic could not be retained; outcome unknown')); return; }
      reject(new Error(`${basename(executable)} trusted image transport failed`));
    };
    child.once('error', error => { if (settled) return; settled = true; clearTimeout(timer); fail(null, null, error.message); });
    child.once('close', (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (code !== 0 || signal || bound) fail(code, signal, diagnostic); else resolve(output);
    });
  });
}
const command = imageCommand;
export interface ImportedImage { imageDigest: string; configDigest: string; manifestDigest: string; cluster: string }
export interface ImageArchive { path: string; sha256: string; configDigest: string }
export async function archiveDigest(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}
export async function exportImage(journal: EffectStore, identity: OperationIdentity, configDigest: string, path: string, execute = command): Promise<ImageArchive> {
  if (!/^sha256:[a-f0-9]{64}$/.test(configDigest) || !path.endsWith('.tar')) throw new Error('Immutable image and archive path required');
  path = resolve(path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const inspect = async (): Promise<ImageArchive | undefined> => {
    try {
      const details = await stat(path);
      if (!details.isFile() || details.size > 2 * 1024 * 1024 * 1024) return undefined;
      const manifest = JSON.parse(await execute('tar', ['-xOf', path, 'manifest.json']));
      const name = manifest?.[0]?.Config;
      if (manifest.length !== 1 || typeof name !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(name) || name.split('/').includes('..')) return undefined;
      const config = await execute('tar', ['-xOf', path, name]);
      if (`sha256:${createHash('sha256').update(config).digest('hex')}` !== configDigest) return undefined;
      return { path, configDigest, sha256: await archiveDigest(path) };
    } catch { return undefined; }
  };
  const result = await effect(journal, identity, 'image.export', `image-archive:${path}`, { path, configDigest }, async () => {
    await execute('docker', ['image', 'save', '--output', path, configDigest], 120_000);
    const observed = await inspect(); if (!observed) throw new Error('Exported image identity unavailable');
    return observed as unknown as Json;
  }, async () => { const observed = await inspect(); return observed ? { status: 'completed', receipt: observed as unknown as Json } : { status: 'unknown' }; });
  return result as unknown as ImageArchive;
}
export async function loadImage(journal: EffectStore, identity: OperationIdentity, archive: ImageArchive, execute = command): Promise<{ configDigest: string }> {
  if (!/^sha256:[a-f0-9]{64}$/.test(archive.configDigest) || !/^[a-f0-9]{64}$/.test(archive.sha256)
    || await archiveDigest(archive.path) !== archive.sha256) throw new Error('Retained image archive changed');
  const inspect = async () => {
    try { return JSON.parse(await execute('docker', ['image', 'inspect', archive.configDigest]))?.[0]?.Id === archive.configDigest; }
    catch { return false; }
  };
  await effect(journal, identity, 'image.load', `image:${archive.configDigest}`, archive as unknown as Json, async () => {
    await execute('docker', ['image', 'load', '--input', resolve(archive.path)], 120_000);
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
