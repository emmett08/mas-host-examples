/** Immutable, hash-checked recovery evidence. Each SQLite cut is consistent;
 * the collection of controller/host stores is deliberately not called atomic. */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync, renameSync, rmSync, openSync, closeSync, fsyncSync, chmodSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 20_000;
const DIRECTORIES = ['artefacts', 'tool-artefacts', 'sources', 'contexts', 'host', 'checkpoint-receipts'];
const FILES = ['journal.sqlite', 'tool-effects.sqlite', 'integration-start.json', 'integration-preflight.json',
  'disclosed-artefacts.json', 'publication-manifest.json', 'result.json', 'checkpoint-acknowledgements.jsonl'];
export interface CheckpointManifest {
  schema: 'self-remediation-checkpoint/2'; originalDirectory: string; originalWorkingDirectory: string;
  createdAt: string; finishedAt: string; sequence: number; incidents: string[]; sourceRevision: string | null;
  pendingPhases: string[]; pendingEffects: string[];
  consistency: 'individual SQLite snapshots; cross-store reconciliation required';
  files: Array<{ path: string; bytes: number; sha256: string; mode: number }>;
  objectBytes: number;
  excluded: string[];
}
export interface Checkpoint { directory: string; manifestSha256: string; manifest: CheckpointManifest }
/** Checkpoint objects are never executable; restoration applies each retained path's mode. */
export function checkpointObjectPath(directory: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid checkpoint object identity');
  return join(directory, 'objects', sha256);
}
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function safe(path: string): boolean {
  return !!path && !path.startsWith('/') && !path.includes('\\') && path.split('/').every(x => x && x !== '.' && x !== '..');
}
function rejectCredentials(bytes: Buffer, denied: string[]): void {
  if (denied.some(value => value.length >= 8 && bytes.includes(Buffer.from(value)))) throw new Error('Credential detected in checkpoint; upload denied');
  const text = bytes.toString('utf8');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|client-key-data:\s*\S+|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{35,})/.test(text))
    throw new Error('Credential-shaped content detected in checkpoint; upload denied');
}

export function createCheckpoint(directory: string, options: { deniedValues?: string[]; sourceRevision?: string } = {}): Checkpoint | undefined {
  const root = resolve(directory), journalPath = join(root, 'journal.sqlite');
  if (!existsSync(journalPath)) return undefined;
  if (realpathSync(root) !== root || lstatSync(journalPath).isSymbolicLink()) throw new Error('Checkpoint source symlink rejected');
  const parent = join(root, 'durable-checkpoints'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) throw new Error('Checkpoint destination symlink rejected');
  const pending = join(parent, `.pending-${randomUUID()}`); mkdirSync(pending, { mode: 0o700 });
  mkdirSync(join(pending, 'objects'), { mode: 0o700 });
  let bytes = 0;
  const objects = new Set<string>();
  const files: CheckpointManifest['files'] = [];
  const denied = options.deniedValues ?? [];
  try {
    const retain = (path: string): CheckpointManifest['files'][number] => {
      if (!safe(path) || files.length >= MAX_FILES) throw new Error('Checkpoint path/file bound exceeded');
      const source = join(root, path), stat = lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o7000)) throw new Error('Checkpoint only admits ordinary files without special permission bits');
      if (stat.size > MAX_BYTES) throw new Error('Checkpoint object byte bound exceeded');
      let content: Buffer;
      if (path.endsWith('.sqlite')) {
        const temporary = join(pending, `.sqlite-cut-${randomUUID()}`);
        const database = new DatabaseSync(source, { readOnly: true });
        try { database.exec('PRAGMA busy_timeout=5000'); database.prepare('VACUUM INTO ?').run(temporary); }
        finally { database.close(); }
        content = readFileSync(temporary); rmSync(temporary);
      } else {
        content = readFileSync(source);
        const after = lstatSync(source);
        if (!after.isFile() || after.isSymbolicLink() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
          || after.mode !== stat.mode || after.ino !== stat.ino || after.dev !== stat.dev) throw new Error('File changed during checkpoint; preserve next consistent cut');
      }
      rejectCredentials(content, denied);
      const sha256 = hash(content);
      if ((path.startsWith('artefacts/') || path.startsWith('tool-artefacts/')) && /^[a-f0-9]{64}(?:\.json)?$/.test(basename(path))) {
        if (sha256 !== basename(path).replace(/\.json$/, '')) throw new Error('Content-addressed artefact changed');
      }
      if (!objects.has(sha256)) {
        if (bytes + content.length > MAX_BYTES) throw new Error('Checkpoint distinct object byte bound exceeded');
        const target = checkpointObjectPath(pending, sha256);
        writeFileSync(target, content, { flag: 'wx', mode: 0o400 }); sync(target);
        objects.add(sha256); bytes += content.length;
      }
      const retained = { path, bytes: content.length, sha256, mode: path.endsWith('.sqlite') ? 0o600 : stat.mode & 0o777 };
      files.push(retained); return retained;
    };
    const visit = (path: string): void => {
      if (lstatSync(join(root, path)).isSymbolicLink() || !realpathSync(join(root, path)).startsWith(root + '/')) throw new Error('Checkpoint directory symlink rejected');
      for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
        const child = `${path}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error('Checkpoint symlink rejected');
        if (entry.name === '.git' || /(?:-wal|-shm|\.lock|\.tmp)$/.test(entry.name)) continue;
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile()) retain(child);
        else throw new Error('Checkpoint special file rejected');
      }
    };
    // The outer journal is captured first. Later host completions are evidence
    // for reconciliation, never authority to bypass a recorded pending phase.
    const journalFile = retain('journal.sqlite');
    const snapshot = new DatabaseSync(checkpointObjectPath(pending, journalFile.sha256), { readOnly: true });
    let sequence: number, incidents: string[], pendingPhases: string[], pendingEffects: string[];
    try {
      sequence = Number(snapshot.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get()!.seq);
      incidents = snapshot.prepare('SELECT id FROM incidents ORDER BY id').all().map(row => String(row.id));
      pendingPhases = snapshot.prepare("SELECT id FROM phases WHERE status IN ('running','unknown') ORDER BY id").all().map(row => String(row.id));
      pendingEffects = snapshot.prepare("SELECT id FROM effects WHERE json_extract(record,'$.status') IN ('intended','unknown') ORDER BY id").all().map(row => String(row.id));
    } finally { snapshot.close(); }
    for (const path of FILES.slice(1)) if (existsSync(join(root, path))) retain(path);
    for (const path of DIRECTORIES) if (existsSync(join(root, path))) visit(path);
    const manifest: CheckpointManifest = { schema: 'self-remediation-checkpoint/2', originalDirectory: root,
      originalWorkingDirectory: process.cwd(), createdAt: new Date(lstatSync(pending).birthtimeMs).toISOString(), finishedAt: new Date().toISOString(),
      sequence, incidents, sourceRevision: options.sourceRevision ?? null, pendingPhases, pendingEffects,
      consistency: 'individual SQLite snapshots; cross-store reconciliation required', objectBytes: bytes, files: files.sort((a,b) => a.path.localeCompare(b.path)),
      excluded: ['credentials and kubeconfig', 'mutable log streams', 'Git object databases', 'container/image runtime state', 'candidate image archives', 'previous checkpoint trees'],
    };
    const content = JSON.stringify(manifest, null, 2) + '\n', manifestSha256 = hash(content);
    writeFileSync(join(pending, 'checkpoint-manifest.json'), content, { flag: 'wx', mode: 0o400 });
    writeFileSync(join(pending, 'checkpoint-manifest.sha256'), manifestSha256 + '\n', { flag: 'wx', mode: 0o400 });
    sync(join(pending, 'objects'));
    sync(join(pending, 'checkpoint-manifest.json')); sync(join(pending, 'checkpoint-manifest.sha256')); sync(pending);
    const destination = join(parent, `checkpoint-${sequence}-${manifestSha256.slice(0,16)}`);
    renameSync(pending, destination);
    sync(parent);
    return { directory: destination, manifestSha256, manifest };
  } catch (error) { rmSync(pending, { recursive: true, force: true }); throw error; }
}

export function verifyCheckpoint(directory: string): Checkpoint {
  const root = resolve(directory), content = readFileSync(join(root, 'checkpoint-manifest.json'));
  if (realpathSync(root) !== root || hash(content) !== readFileSync(join(root, 'checkpoint-manifest.sha256'), 'utf8').trim()) throw new Error('Checkpoint manifest digest changed');
  const manifest = JSON.parse(content.toString()) as CheckpointManifest;
  if (manifest.schema !== 'self-remediation-checkpoint/2' || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES
    || !Number.isSafeInteger(manifest.objectBytes) || manifest.objectBytes < 0 || manifest.objectBytes > MAX_BYTES) throw new Error('Unsupported checkpoint manifest');
  const objectRoot = join(root, 'objects');
  if (lstatSync(objectRoot).isSymbolicLink() || realpathSync(objectRoot) !== objectRoot) throw new Error('Checkpoint object directory symlink rejected');
  const seen = new Set<string>(), objects = new Map<string, number>();
  for (const file of manifest.files) {
    if (!safe(file.path) || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_BYTES
      || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777
      || (file.path.endsWith('.sqlite') && file.mode !== 0o600)) throw new Error('Invalid or duplicate checkpoint path, mode or object identity');
    seen.add(file.path);
    if (objects.has(file.sha256) && objects.get(file.sha256) !== file.bytes) throw new Error('Checkpoint object metadata differs between paths');
    objects.set(file.sha256, file.bytes);
  }
  if (!seen.has('journal.sqlite')) throw new Error('Checkpoint lacks controller journal');
  let bytes = 0;
  for (const [sha256, expectedBytes] of objects) {
    const path = checkpointObjectPath(root, sha256);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !realpathSync(path).startsWith(root + '/')) throw new Error('Checkpoint object escapes its root');
    if (stat.size !== expectedBytes) throw new Error('Checkpoint content digest changed');
    const data = readFileSync(path); bytes += data.length;
    if (data.length !== expectedBytes || hash(data) !== sha256 || bytes > MAX_BYTES) throw new Error('Checkpoint content digest changed');
  }
  if (bytes !== manifest.objectBytes) throw new Error('Checkpoint distinct object byte count changed');
  return { directory: root, manifestSha256: hash(content), manifest };
}

export function restoreCheckpoint(checkpointDirectory: string, destination: string): Checkpoint {
  const checkpoint = verifyCheckpoint(checkpointDirectory), root = resolve(destination);
  if (existsSync(root) && readdirSync(root).length) throw new Error('Restore destination must be absent or empty');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root) throw new Error('Restore destination symlink rejected');
  // Persist the admission block BEFORE any journal can become visible. An
  // interrupted or failed copy must never resemble a normal process restart.
  const marker = join(root, 'RUNNER_LOSS_REQUIRES_RECONCILIATION.json');
  writeFileSync(marker, JSON.stringify({
    schema: 'self-remediation-runner-loss/1', checkpointManifest: checkpoint.manifestSha256,
    originalDirectory: checkpoint.manifest.originalDirectory, restoredDirectory: root,
    originalWorkingDirectory: checkpoint.manifest.originalWorkingDirectory,
    sourceRevision: checkpoint.manifest.sourceRevision, pendingPhases: checkpoint.manifest.pendingPhases,
    pendingEffects: checkpoint.manifest.pendingEffects,
    status: 'unknown_effect', reason: 'Controller/host snapshots are separate cuts. Original absolute paths, runtime images, surviving external effects and target identities require reconciliation before dispatch.',
  }, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
  sync(marker); sync(root); sync(dirname(root));
  for (const file of checkpoint.manifest.files) {
    const bytes = readFileSync(checkpointObjectPath(checkpoint.directory, file.sha256));
    if (hash(bytes) !== file.sha256) throw new Error('Checkpoint changed during restoration');
    const path = join(root, file.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    // Apply the recorded ordinary permission bits after writing so umask cannot
    // strip a retained host runtime's executable bit. No special modes are admitted.
    const descriptor = openSync(path, 'r');
    try { chmodSync(path, file.mode); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    sync(dirname(path));
  }
  return checkpoint;
}
