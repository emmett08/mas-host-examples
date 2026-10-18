/** Trusted recovery sidecar. Runtime upload credentials never enter candidate execution. */
import { existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createCheckpoint, restoreCheckpoint, verifyCheckpoint } from '../controller/checkpoint.js';
import { uploadCheckpoint, type ArtifactUploader } from '../controller/checkpoint-upload.js';

const { values } = parseArgs({ options: {
  watch: { type: 'boolean' }, directory: { type: 'string' }, 'stop-file': { type: 'string' },
  verify: { type: 'string' }, restore: { type: 'string' }, output: { type: 'string' },
} });
if (values.verify) {
  const checkpoint = verifyCheckpoint(values.verify);
  process.stdout.write(JSON.stringify({ manifestSha256: checkpoint.manifestSha256, sequence: checkpoint.manifest.sequence, objectBytes: checkpoint.manifest.objectBytes, fileCount: checkpoint.manifest.files.length, verified: true }) + '\n');
} else if (values.restore) {
  if (!values.output) throw new Error('--restore requires --output');
  const checkpoint = restoreCheckpoint(values.restore, values.output);
  process.stdout.write(JSON.stringify({ manifestSha256: checkpoint.manifestSha256, output: resolve(values.output), status: 'unknown_effect', required: 'Reconcile surviving external state and original absolute host paths before dispatch.' }) + '\n');
} else {
  if (!values.directory) throw new Error('--directory is required');
  const directory = resolve(values.directory), stop = values['stop-file'];
  if (values.watch && !stop) throw new Error('--watch requires --stop-file');
  const remote = process.env.GITHUB_ACTIONS === 'true';
  if (remote && (!process.env.ACTIONS_RUNTIME_TOKEN || !process.env.ACTIONS_RESULTS_URL)) throw new Error('Actions runtime artifact credentials unavailable; launch through the integration Node action');
  let uploader: ArtifactUploader | undefined;
  if (remote) { const { DefaultArtifactClient } = await import('@actions/artifact'); uploader = new DefaultArtifactClient(); }
  let cuts = 0, uploads = 0, acknowledged = 0, duringRunAcknowledged = 0, lastCut = 0, lastUpload = 0, failures = 0;
  const deniedValues = [process.env.ACTIONS_RUNTIME_TOKEN ?? ''];
  const summaryPath = join(directory, 'checkpoint-summary.json');
  while (true) {
    const finished = !!stop && existsSync(stop), now = Date.now();
    if (cuts < 20 && (lastCut === 0 || now - lastCut >= 30_000 || finished)) {
      try {
        const checkpoint = createCheckpoint(directory, { deniedValues, sourceRevision: process.env.GITHUB_SHA });
        if (checkpoint) {
          ++cuts; lastCut = now;
          appendFileSync(join(directory, 'checkpoint-local.jsonl'), JSON.stringify({ manifestSha256: checkpoint.manifestSha256, sequence: checkpoint.manifest.sequence, directory: checkpoint.directory, createdAt: checkpoint.manifest.finishedAt }) + '\n', { mode: 0o600 });
          // The official artifact client documents ten artifacts/job. Reserve
          // room for final diagnostics/observer/browser artifacts. Local cuts
          // remain 30s; at most six remote cuts span the 600s incident budget.
          if (uploader && uploads < 6 && (lastUpload === 0 || now - lastUpload >= 120_000 || finished)) {
            ++uploads; lastUpload = now;
            const name = `self-remediation-checkpoint-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${process.env.SELF_REMEDIATION_MODE}-${checkpoint.manifest.sequence}-${checkpoint.manifestSha256.slice(0,16)}`;
            const receipt = await uploadCheckpoint(directory, checkpoint, name, uploader);
            if (receipt.status === 'completed') { ++acknowledged; if (!stop || !existsSync(stop)) ++duringRunAcknowledged; }
            process.stdout.write(`Checkpoint ${receipt.manifestSha256}: ${receipt.status}${receipt.artifactId ? ` artifact ${receipt.artifactId}` : ''}\n`);
          }
        }
      } catch {
        ++failures;
        // A concurrently changing file can prevent a cut. Never report it as a
        // retained snapshot; retry a new cut at the next interval.
        lastCut = now;
        appendFileSync(join(directory, 'checkpoint-failures.jsonl'), JSON.stringify({ at: new Date().toISOString(), status: 'inconclusive', reason: 'Snapshot unavailable or exceeded credential/path/size boundary' }) + '\n', { mode: 0o600 });
      }
    }
    writeFileSync(summaryPath, JSON.stringify({ localCuts: cuts, attemptedUploads: uploads, acknowledgedUploads: acknowledged, duringRunAcknowledged, snapshotFailures: failures,
      localIntervalSeconds: 30, remoteIntervalSeconds: 120, maxLocalCuts: 20, maxRemoteCuts: 6, remoteRequired: remote,
      scope: 'Per-store consistent recovery evidence; restored runner requires external reconciliation' }) + '\n', { mode: 0o600 });
    if (!values.watch || finished) break;
    await delay(1_000);
  }
  if (!cuts || (remote && !acknowledged)) process.exitCode = 1;
}
