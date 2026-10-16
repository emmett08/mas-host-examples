#!/usr/bin/env bash
# Run after apply.sh on an isolated fixture-mode cluster.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Exercise the installed authorisation policy rather than only reading YAML.
permission() {
  local actor="$1" expected="$2" actual
  shift 2
  actual="$(kubectl -n mas-demo auth can-i "$@" --as="system:serviceaccount:mas-demo:$actor" 2>/dev/null || true)"
  [[ "$actual" == "$expected" ]] || { echo "Unexpected permission: $actor $* = $actual (expected $expected)" >&2; exit 1; }
}
permission mas-demo-remediator yes patch deployments.apps/mas-demo-checkout
permission mas-demo-remediator no patch deployments.apps/mas-demo
permission mas-demo-remediator no patch deployments.apps/another-service
permission mas-demo-remediator no delete deployments.apps/mas-demo-checkout
permission mas-demo-remediator no get secrets
permission mas-demo-remediator no create pods --subresource=exec
permission mas-demo-remediator yes get services/mas-demo-checkout:8081 --subresource=proxy
permission mas-demo-remediator no get services/mas-demo:8080 --subresource=proxy
permission mas-demo-remediator yes get namespaces/mas-demo
permission mas-demo-remediator no get namespaces/kube-system
permission mas-demo-remediator yes create masremediations.demo.mas.dev
permission mas-demo-remediator yes update masremediations.demo.mas.dev --subresource=status
permission mas-demo-remediator no update masremediations.demo.mas.dev
permission mas-demo-remediator no delete masremediations.demo.mas.dev
permission mas-demo-operator no patch deployments.apps/mas-demo-checkout
permission mas-demo-operator no create masremediations.demo.mas.dev
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
# A completed assessment and a verified repair are separate durable results.
deadline=$((SECONDS + 180))
while (( SECONDS < deadline )); do
  curl --fail --silent "http://127.0.0.1:18080/api/runs/$run_id/snapshot" > "$run_json"
  recovery="$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1],"utf8")).run.resolution?.status??"")' "$run_json")"
  [[ -z "$recovery" ]] || break
  sleep 2
done
[[ "$recovery" == verified ]] || { echo "The dedicated remediation controller did not verify recovery: ${recovery:-no report}" >&2; exit 1; }
kubectl -n mas-demo get masremediations -o json > "$preparation/remediations.json"
journal_name="$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1],"utf8")).items.find(item=>item.spec?.runId===process.argv[2])?.metadata.name??"")' "$preparation/remediations.json" "$run_id")"
[[ -n "$journal_name" ]] || { echo 'The repair has no durable Kubernetes journal' >&2; exit 1; }
if rejection="$(kubectl -n mas-demo patch "masremediation/$journal_name" --dry-run=server --type=json \
  -p '[{"op":"replace","path":"/spec/targetUID","value":"different-target"}]' 2>&1)"; then
  echo 'The API accepted a mutation of immutable remediation admission identity' >&2; exit 1
fi
[[ "$rejection" == *'Create a new MASRemediation'* ]] || { echo "Unexpected journal validation failure: $rejection" >&2; exit 1; }
if rejection="$(kubectl -n mas-demo patch "masremediation/$journal_name" --subresource=status --dry-run=server --type=merge \
  -p '{"status":{"phase":"Pending"}}' 2>&1)"; then
  echo 'The API accepted reopening a finished remediation attempt' >&2; exit 1
fi
[[ "$rejection" == *'Remediation phases cannot move backwards'* ]] || { echo "Unexpected phase validation failure: $rejection" >&2; exit 1; }
source_run_uid="$(kubectl -n mas-demo get "masdemorun/$run_name" -o jsonpath='{.metadata.uid}')"
node --input-type=module - "$run_json" "$root" "$preparation/remediations.json" "$source_run_uid" <<'NODE'
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { validatePracticalEvidence } = await import(pathToFileURL(`${process.argv[3]}/remediation.mjs`));
const { selectRemediationForRun, validateControllerResolution } = await import(pathToFileURL(`${process.argv[3]}/record-demo.mjs`));
const {run, observation} = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const journal = selectRemediationForRun(JSON.parse(readFileSync(process.argv[4], 'utf8')).items, run.id);
if (!validateControllerResolution({run}, journal, process.argv[5])) throw new Error('No controller recovery report was retained');
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
  await writeFile(join(artifacts, 'smoke-remediation-journal.json'), `${JSON.stringify(journal, null, 2)}\n`);
}
try { validatePracticalEvidence({run}); }
catch (error) {
  // API status/reason and sizes diagnose collection failures without logging payloads.
  console.error(`Practical evidence validation failed: ${JSON.stringify(diagnostics)}`);
  throw error;
}
if (run.status !== 'completed') throw new Error('The backend did not retain the completed host run');
if (run.resolution.version !== 'mas-k8s-resolution/2' || run.resolution.effectOutcome !== 'applied' || run.resolution.verificationOutcome !== 'passed') throw new Error('New execution must retain independent effect and verification outcomes');
if (observation.messages.length !== 16) throw new Error('Expected 16 admitted Request/Result messages from eight invocations');
if (!observation.messages.some(message => message.sender === 'platform' && message.recipient === 'security')) {
  throw new Error('Expected the hybrid platform-to-security peer request');
}
if (observation.messages.filter(message => message.sender === 'security' && message.recipient === 'security_review').length !== 2) {
  throw new Error('Expected two independent security review requests');
}
console.log(`Completed real MAS host execution ${run.id} in fixture provider mode`);
NODE
# A restarted remediator must replay the durable report without another patch.
generation_before="$(kubectl -n mas-demo get deployment mas-demo-checkout -o jsonpath='{.metadata.generation}')"
journals_before="$(kubectl -n mas-demo get masremediations -o jsonpath='{range .items[*]}{.metadata.uid}{" "}{.status.phase}{"\n"}{end}')"
kubectl -n mas-demo rollout restart deployment/mas-demo-remediator
kubectl -n mas-demo rollout status deployment/mas-demo-remediator --timeout=180s
sleep 6
generation_after="$(kubectl -n mas-demo get deployment mas-demo-checkout -o jsonpath='{.metadata.generation}')"
journals_after="$(kubectl -n mas-demo get masremediations -o jsonpath='{range .items[*]}{.metadata.uid}{" "}{.status.phase}{"\n"}{end}')"
[[ "$generation_before" == "$generation_after" && "$journals_before" == "$journals_after" ]] || {
  echo 'Remediator restart repeated a workload mutation or changed durable completion identity' >&2; exit 1;
}
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
if (run.status !== 'completed' || observation.messages.length !== 16 || run.resolution?.status !== 'verified') {
  throw new Error('Restart did not retain the completed host execution and its original messages');
}
NODE
printf 'Event trigger, host run, controller repair, scoped RBAC, retained recovery and restart deduplication passed.\n'

# Exercise ordered append-only status admission against the actual API server.
# This isolated schema fixture grants no workload permission and runs no executor.
kubectl create namespace mas-schema-check
kubectl create -f - <<'YAML'
apiVersion: demo.mas.dev/v1alpha1
kind: MASRemediation
metadata: {name: append-check, namespace: mas-schema-check}
spec:
  version: mas-k8s-remediation/1
  runId: schema-check
  sourceRunUID: schema-check
  namespaceUID: schema-check
  targetUID: schema-check
  templateHash: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  evidenceHash: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
YAML
kubectl -n mas-schema-check patch masremediation/append-check --subresource=status --type=merge -p '{"status":{"phase":"Finished","reportJson":"{}"}}'
kubectl -n mas-schema-check patch masremediation/append-check --subresource=status --type=merge -p '{"status":{"reconciliations":["first"]}}'
kubectl -n mas-schema-check patch masremediation/append-check --subresource=status --type=merge -p '{"status":{"reconciliations":["first","second"]}}'
for invalid in '{"status":{"reconciliations":["second","first"]}}' '{"status":{"reconciliations":["first"]}}' '{"status":{"reportJson":"changed"}}'; do
  if kubectl -n mas-schema-check patch masremediation/append-check --subresource=status --dry-run=server --type=merge -p "$invalid"; then
    echo 'The API accepted rewriting retained attempt or observation evidence' >&2; exit 1
  fi
done
kubectl delete namespace mas-schema-check --wait=false
printf 'Version 2 execution outcomes and ordered append-only observation admission passed.\n'
