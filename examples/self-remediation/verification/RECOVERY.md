# Recovery checkpoints

The trusted integration sidecar takes an immutable local cut every 30 seconds, at most 20 cuts per incident. It snapshots the controller and host SQLite stores with `VACUUM INTO`, copies the admitted source and content-addressed evidence stores, checks hashes and rejects credential-shaped content, symlinks and oversized captures. Each individual database cut is consistent. The collection is **not an atomic transaction across controller, host and external services**.

Inside Actions, the official `@actions/artifact` client uploads immutable checkpoint artifacts while the incident is running. Version 6.3.1 documents a ten-artifact limit per job. This workflow reserves capacity for other diagnostic artifacts: at most six checkpoint uploads, approximately 120 seconds apart, plus a final cut when capacity remains. Local cuts retain their 30-second cadence. These are bounded attempts, not a guarantee that the remote service or a changing source store will always provide a usable cut. `checkpoint-summary.json` reports attempts, local cuts, acknowledged uploads and uploads acknowledged before controller completion. Integration fails if Actions produced no acknowledged during-run checkpoint.

The small local Node action supplies the job-scoped artifact runtime credential to the trusted checkpoint process. It does not export it to later workflow steps. The integration wrapper strips runtime artifact credentials before starting the controller, and the checkpoint process receives no provider key, GitHub publication token or kubeconfig. Generated code runs in the separate credential-free sandbox. Checkpoint artifacts are trusted operator recovery evidence; they can contain protected test material and must never become a repair-agent source projection or unrestricted UI disclosure.

Each upload has a durable intent and a distinct artifact name. Acknowledged receipts retain the artifact ID, service digest and manifest digest. A lost response remains `unknown` and is not automatically uploaded again under the same identity. Later periodic cuts are separate snapshots, not retries of the uncertain write. If a response is lost, retrieve that exact artifact name and verify its manifest before recording reconciliation. Do not infer upload success from an attempted request or local ZIP.

## Download, verify and restore

Use the exact run, repository and artifact name from the upload receipt or workflow log:

```sh
gh run download RUN_ID --repo OWNER/REPOSITORY \
  --name self-remediation-checkpoint-RUN_ID-ATTEMPT-MODE-SEQUENCE-MANIFEST_PREFIX \
  --dir /tmp/downloaded-checkpoint
node --import tsx scripts/checkpoint.ts --verify /tmp/downloaded-checkpoint
node --import tsx scripts/checkpoint.ts --restore /tmp/downloaded-checkpoint \
  --output /path/to/restored-run
```

Run these commands from `examples/self-remediation` in the exact trusted source revision identified by `checkpoint-manifest.json`. Compare its SHA-256 with the retained acknowledgement; a valid file hash alone does not establish who produced it. Restore copies only manifest-listed files into an empty destination. It preserves recorded deadlines, consumed budgets, cancellation, pending phases and unresolved effects. It adds `RUNNER_LOSS_REQUIRES_RECONCILIATION.json`; `run.ts` rejects this marker before dispatch.

This restore command intentionally does **not** resume an incident on a replacement runner. Host project and invocation receipts contain the original absolute working/state paths. Container image state and kubeconfig are not checkpoints, and a new cluster has different object identities. The retained marker names the original paths and unresolved operations. The operator must reconcile surviving GitHub branches/PRs/merges and Kubernetes effects, validate target identities, and rebuild/reverify any unavailable images or changed environment under fresh identities. Removing the marker without that evidence does not constitute recovery. Automatic cross-runner continuation is not implemented.

For an ordinary controller-process restart with the original runner, paths, host stores and external environment intact, reuse the same incident/output/configuration with `scripts/run.ts`. It reconciles retained invocation receipts before admitting new work. Cancellation prevents new admissions; an effect admitted before cancellation may still complete and must be reconciled.

## Bounds and exclusions

Each checkpoint admits at most 20,000 files and 128 MiB. It includes the outer journal, tool-effect journal, host stores, source projections, CAS stores, immutable contexts and prior upload receipts. It excludes mutable log streams, Git databases, previous snapshot trees, kubeconfig, credentials, container runtime state and candidate image archives. The final workflow diagnostic artifact separately retains the complete available replay and, when produced, immutable image export. A runner lost after the most recent acknowledged checkpoint can lose later observations; uncertainty remains blocking.

Local tests exercise live WAL snapshots, exact hash verification, pending phase/budget preservation, restoration guards, credential/path rejection and lost-upload non-repetition. Actual Actions artifact acknowledgements and a runner-loss restore remain separate integration observations.
