#!/usr/bin/env bash
# Run after apply.sh on an isolated fixture-mode cluster.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
preparation="$(mktemp -d)"
trap 'rm -rf "$preparation"; kubectl -n mas-demo delete deployment,service mas-demo-checkout --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT
node --input-type=module - "$root" "$preparation" <<'NODE'
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const execute = promisify(execFile);
const { prepareIncident } = await import(pathToFileURL(`${process.argv[2]}/record-demo.mjs`));
const { pod } = await prepareIncident(process.argv[3], async args =>
  (await execute('kubectl', ['-n', 'mas-demo', ...args], { timeout: 200_000 })).stdout);
await writeFile(`${process.argv[3]}/pod-name`, pod.metadata.name);
await writeFile(`${process.argv[3]}/pod-uid`, pod.metadata.uid);
NODE
pod_name="$(cat "$preparation/pod-name")"
pod_uid="$(cat "$preparation/pod-uid")"
deadline=$((SECONDS + 180))
run_name=''
while (( SECONDS < deadline )); do
  run_name="$(kubectl -n mas-demo get masdemoruns -l demo.mas.dev/source=warning-event -o json 2>/dev/null | node --input-type=module -e 'import {readFileSync} from "node:fs"; const rows=JSON.parse(readFileSync(0,"utf8")).items; console.log(rows.find(row=>row.spec?.event?.involvedObject?.uid===process.argv[1])?.metadata.name??"")' "$pod_uid" || true)"
  [[ -z "$run_name" ]] || break
  sleep 3
done
[[ -n "$run_name" ]] || { echo 'No MASDemoRun was created from the opted-in pod Warning Event' >&2; exit 1; }
kubectl -n mas-demo label "pod/$pod_name" demo.mas.dev/trigger=false --overwrite
kubectl -n mas-demo wait "masdemorun/$run_name" --for=jsonpath='{.status.phase}'=Succeeded --timeout=180s
run_id="$(kubectl -n mas-demo get "masdemorun/$run_name" -o jsonpath='{.status.runId}')"
# Exercise real API validation: an unchanged spec must permit status updates,
# while both typed and preserved opaque evidence remain immutable.
kubectl -n mas-demo patch "masdemorun/$run_name" --subresource=status --type=merge \
  -p "{\"status\":{\"phase\":\"Succeeded\",\"runId\":\"$run_id\"}}" >/dev/null
expect_immutable_rejection() {
  local patch="$1" rejection
  if rejection="$(kubectl -n mas-demo patch "masdemorun/$run_name" --type=json --dry-run=server -p "$patch" 2>&1)"; then
    echo 'The API accepted a mutation of immutable admitted incident evidence' >&2
    exit 1
  fi
  [[ "$rejection" == *'Create a new MASDemoRun'* ]] || { echo "Unexpected API validation failure: $rejection" >&2; exit 1; }
}
expect_immutable_rejection '[{"op":"replace","path":"/spec/scenario","value":"pod-crash"}]'
pod_item_index="$(kubectl -n mas-demo get "masdemorun/$run_name" -o json | node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(0,"utf8")).spec.evidence.items.findIndex(item=>item.id==="pod"&&item.status==="collected"))')"
[[ "$pod_item_index" =~ ^[0-9]+$ ]] || { echo 'No collected Pod evidence was admitted to test opaque-data immutability' >&2; exit 1; }
expect_immutable_rejection "[{\"op\":\"replace\",\"path\":\"/spec/evidence/items/$pod_item_index/data/metadata/name\",\"value\":\"changed-pod\"}]"
kubectl -n mas-demo port-forward svc/mas-demo 18080:8080 > /tmp/mas-demo-port-forward.log 2>&1 &
forward_pid=$!
trap 'kill "$forward_pid" 2>/dev/null || true; rm -rf "$preparation"; kubectl -n mas-demo delete deployment,service mas-demo-checkout --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:18080/api/health >/dev/null; then break; fi
  sleep 1
done
run_json="$(mktemp)"
trap 'rm -f "$run_json"; kill "$forward_pid" 2>/dev/null || true; rm -rf "$preparation"; kubectl -n mas-demo delete deployment,service mas-demo-checkout --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT
curl --fail --silent "http://127.0.0.1:18080/api/runs/$run_id/snapshot" > "$run_json"
node --input-type=module - "$run_json" "$root" <<'NODE'
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { validatePracticalEvidence } = await import(pathToFileURL(`${process.argv[3]}/remediation.mjs`));
const {run, observation} = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const evidence = run.input?.incident?.evidence;
const diagnostics = { runId: run.id, capturedAt: evidence?.capturedAt,
  items: evidence?.items?.slice(0, 16).map(item => ({ id: item.id, status: item.status,
    reason: item.reason, observedAt: item.observedAt, truncated: item.truncated,
    dataBytes: Buffer.byteLength(JSON.stringify(item.data ?? null)) })) ?? [] };
// Retain the already scrubbed, bounded evidence independently of a later recording.
const artifacts = process.env.DEMO_ARTIFACT_DIR ?? (process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, 'mas-demo-artifacts') : undefined);
if (artifacts) {
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'smoke-evidence.json'), `${JSON.stringify(evidence ?? null, null, 2)}\n`);
  await writeFile(join(artifacts, 'smoke-evidence-status.json'), `${JSON.stringify(diagnostics, null, 2)}\n`);
}
try { validatePracticalEvidence({run}); }
catch (error) {
  // API status/reason and sizes diagnose collection failures without logging payloads.
  console.error(`Practical evidence validation failed: ${JSON.stringify(diagnostics)}`);
  throw error;
}
if (run.status !== 'completed') throw new Error('The backend did not retain the completed host run');
if (observation.messages.length !== 16) throw new Error('Expected 16 admitted Request/Result messages from eight invocations');
if (!observation.messages.some(message => message.sender === 'platform' && message.recipient === 'security')) {
  throw new Error('Expected the hybrid platform-to-security peer request');
}
if (observation.messages.filter(message => message.sender === 'security' && message.recipient === 'security_review').length !== 2) {
  throw new Error('Expected two independent security review requests');
}
console.log(`Completed real MAS host execution ${run.id} in fixture provider mode`);
NODE
# Restart the entire pod; retained CRs and backend IDs must prevent a second run.
before="$(kubectl -n mas-demo get masdemoruns -o jsonpath='{range .items[*]}{.metadata.uid}{"\n"}{end}')"
kubectl -n mas-demo rollout restart deployment/mas-demo
kubectl -n mas-demo rollout status deployment/mas-demo --timeout=180s
kubectl -n mas-demo wait "masdemorun/$run_name" --for=jsonpath='{.status.phase}'=Succeeded --timeout=60s
# Give the restarted observer two polling periods to reconcile the same event.
sleep 6
after="$(kubectl -n mas-demo get masdemoruns -o jsonpath='{range .items[*]}{.metadata.uid}{"\n"}{end}')"
[[ "$before" == "$after" ]] || { echo 'Observer restart admitted a duplicate event' >&2; exit 1; }
kill "$forward_pid" 2>/dev/null || true
kubectl -n mas-demo port-forward svc/mas-demo 18080:8080 > /tmp/mas-demo-port-forward.log 2>&1 &
forward_pid=$!
for attempt in {1..30}; do
  if curl --fail --silent "http://127.0.0.1:18080/api/runs/$run_id/snapshot" > "$run_json"; then break; fi
  sleep 1
done
node --input-type=module - "$run_json" <<'NODE'
import { readFileSync } from 'node:fs';
const {run, observation} = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (run.status !== 'completed' || observation.messages.length !== 16) {
  throw new Error('Restart did not retain the completed host execution and its original messages');
}
NODE
printf 'Event trigger, host run, retained state and event deduplication passed.\n'
