import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export type Projection = { repository: string; revision: string; paths: string[]; mode: 'blind' | 'operational'; admittedHistory?: string[] };
export type Snapshot = { root: string; tree: string; files: Record<string, string>; projection: Projection };
export function admittedPath(path: string): boolean {
  return path === 'config.json' || /^src\/[A-Za-z0-9_/-]+\.ts$/.test(path) && !path.split('/').includes('..');
}
export function checkPath(path: string, projection: Projection, write = false) {
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some(x => x === '.' || x === '..' || !x)) throw new Error('Path is outside the admitted projection');
  if (!admittedPath(path) && path !== 'package.json') throw new Error('Protected or unsupported path');
  if (write && !admittedPath(path)) throw new Error('Candidate cannot alter the trusted package contract');
  if (!projection.paths.some(x => x === path || x.endsWith('/') && path.startsWith(x))) throw new Error('Path was not admitted');
}
export function assertRemote(projection: Projection, repository: string, revision: string, path: string, operation: 'read' | 'search' | 'history') {
  if (repository !== projection.repository || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Unadmitted repository or mutable revision');
  if (revision !== projection.revision && (projection.mode !== 'operational' || !projection.admittedHistory?.includes(revision))) throw new Error('Unadmitted source revision');
  if (operation !== 'read') throw new Error('Remote broad search and history are not admitted capabilities');
  checkPath(path, projection);
}
async function safeRead(root: string, relative: string) {
  let current = resolve(root);
  for (const part of relative.split('/')) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Snapshot cannot contain symbolic links');
  }
  const stat = await lstat(current);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144) throw new Error('Snapshot requires bounded ordinary files');
  return readFile(current, 'utf8');
}
export async function exportSnapshot(sourceDir: string, projection: Projection, destination?: string): Promise<Snapshot> {
  if (!/^[a-f0-9]{40}$/.test(projection.revision)) throw new Error('Exact source commit required');
  const files: Record<string, string> = {};
  async function walk(prefix: string) {
    for (const entry of await readdir(join(sourceDir, prefix), { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Snapshot cannot contain symbolic links');
      if (entry.isDirectory() && (path === 'src' || path.startsWith('src/'))) await walk(path + '/');
      else if (entry.isFile() && (admittedPath(path) || path === 'package.json')) {
        checkPath(path, projection); files[path] = await safeRead(sourceDir, path);
      }
    }
  }
  await walk('');
  return materialise(files, projection, destination);
}
export async function materialise(files: Record<string, string>, projection: Projection, destination?: string): Promise<Snapshot> {
  if (Object.keys(files).length > 128 || Buffer.byteLength(JSON.stringify(files)) > 1048576) throw new Error('Snapshot exceeds file/byte budget');
  for (const path of Object.keys(files)) checkPath(path, projection);
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  const root = destination ?? await mkdtemp(join(tmpdir(), 'mas-source-'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [path, text] of Object.entries(files)) {
    const parent = join(root, path, '..'); await mkdir(parent, { recursive: true, mode: 0o700 });
    await writeFile(join(root, path), text, { mode: 0o400, flag: 'wx' });
  }
  return { root, tree: sha256(canonical), files, projection };
}
export async function applyEdits(snapshot: Snapshot, edits: { path: string; content: string | null }[]): Promise<Snapshot> {
  const files = { ...snapshot.files };
  const seen = new Set<string>();
  for (const { path, content } of edits) {
    checkPath(path, snapshot.projection, true);
    if (seen.has(path)) throw new Error('Duplicate edit path'); seen.add(path);
    if (content === null) delete files[path];
    else if (typeof content === 'string') files[path] = content;
    else throw new Error('Invalid edit content');
  }
  return materialise(files, snapshot.projection);
}
export async function verifySnapshot(snapshot: Snapshot) {
  for (const [path, text] of Object.entries(snapshot.files)) { checkPath(path, snapshot.projection); if (await safeRead(snapshot.root, path) !== text) throw new Error('Snapshot content changed'); }
  const identity = sha256(JSON.stringify(Object.fromEntries(Object.entries(snapshot.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
  if (identity !== snapshot.tree) throw new Error('Snapshot tree identity mismatch');
}
