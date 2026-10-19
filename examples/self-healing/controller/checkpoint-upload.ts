/** A checkpoint upload is an independent immutable effect. A lost response is
 * retained as unknown and never automatically dispatched again. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyCheckpoint, checkpointObjectPath, type Checkpoint } from './checkpoint.js';

export interface ArtifactUploader {
  uploadArtifact(name: string, files: string[], root: string, options: { retentionDays: number; compressionLevel: number }):
    Promise<{ id?: number; digest?: string; size?: number }>;
}
export interface CheckpointUploadReceipt {
  operationId: string; artifactName: string; manifestSha256: string; sequence: number;
  status: 'completed' | 'unknown'; artifactId?: number; artifactDigest?: string; bytes?: number;
  intendedAt: string; settledAt: string; failure?: string;
}
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
export async function uploadCheckpoint(directory: string, checkpoint: Checkpoint, name: string, uploader: ArtifactUploader): Promise<CheckpointUploadReceipt> {
  if (!/^[A-Za-z0-9_-]{1,220}$/.test(name)) throw new Error('Invalid immutable checkpoint artifact name');
  const verified = verifyCheckpoint(checkpoint.directory);
  if (verified.manifestSha256 !== checkpoint.manifestSha256) throw new Error('Checkpoint identity changed before upload');
  const receipts = join(resolve(directory), 'checkpoint-receipts'); mkdirSync(receipts, { recursive: true, mode: 0o700 });
  if (lstatSync(receipts).isSymbolicLink() || realpathSync(receipts) !== receipts) throw new Error('Checkpoint receipt destination symlink rejected');
  const intentPath = join(receipts, `${name}.intent.json`), receiptPath = join(receipts, `${name}.receipt.json`);
  if (existsSync(intentPath)) {
    if (JSON.parse(readFileSync(intentPath, 'utf8')).manifestSha256 !== checkpoint.manifestSha256) throw new Error('Frozen checkpoint upload identity changed');
    if (existsSync(receiptPath)) return JSON.parse(readFileSync(receiptPath, 'utf8')) as CheckpointUploadReceipt;
    throw new Error('Unknown checkpoint upload: reconcile its artifact name externally before any repetition');
  }
  const intent = { operationId: `checkpoint-upload:${name}`, artifactName: name, manifestSha256: checkpoint.manifestSha256,
    sequence: checkpoint.manifest.sequence, intendedAt: new Date().toISOString() };
  writeFileSync(intentPath, JSON.stringify(intent) + '\n', { flag: 'wx', mode: 0o400 });
  sync(intentPath); sync(receipts);
  let receipt: CheckpointUploadReceipt;
  try {
    const files = [...new Set(verified.manifest.files.map(file => file.sha256))].map(sha256 => checkpointObjectPath(verified.directory, sha256));
    files.push(join(verified.directory, 'checkpoint-manifest.json'), join(verified.directory, 'checkpoint-manifest.sha256'));
    const result = await uploader.uploadArtifact(name, files, checkpoint.directory, { retentionDays: 14, compressionLevel: 6 });
    if (!Number.isSafeInteger(result.id) || result.id! <= 0 || !/^[a-f0-9]{64}$/i.test(result.digest ?? '')) throw new Error('Artifact service returned no verified upload identity');
    receipt = { ...intent, status: 'completed', artifactId: result.id, artifactDigest: result.digest, bytes: result.size, settledAt: new Date().toISOString() };
  } catch {
    // Transport messages can contain signed service URLs; never retain them.
    receipt = { ...intent, status: 'unknown', settledAt: new Date().toISOString(), failure: 'Artifact response lost or invalid; read the named artifact and verify its manifest before reconciliation.' };
  }
  writeFileSync(receiptPath, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o400 });
  sync(receiptPath); sync(receipts);
  appendFileSync(join(directory, 'checkpoint-acknowledgements.jsonl'), JSON.stringify(receipt) + '\n', { mode: 0o600 });
  return receipt;
}
