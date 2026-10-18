/** Write-once content-addressed JSON and bytes outside candidate workspaces. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../deploy/effects.js';
export class Artefacts {
  constructor(readonly root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); }
  put(value: unknown): string { return this.putBytes(Buffer.from(canonical(value))); }
  putBytes(bytes: Uint8Array): string {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const path = join(this.root, digest);
    if (!existsSync(path)) {
      try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o400 }); } catch (error) { if (!existsSync(path)) throw error; }
      const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      const dir = openSync(this.root, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    }
    if (!readFileSync(path).equals(Buffer.from(bytes))) throw new Error('Artefact digest collision or modification');
    return `sha256:${digest}`;
  }
  read(ref: string): Buffer {
    if (!/^sha256:[a-f0-9]{64}$/.test(ref)) throw new Error('Invalid artefact reference');
    const bytes = readFileSync(join(this.root, ref.slice(7)));
    if (createHash('sha256').update(bytes).digest('hex') !== ref.slice(7)) throw new Error('Modified artefact');
    return bytes;
  }
  json<T>(ref: string): T { return JSON.parse(this.read(ref).toString()) as T; }
}
