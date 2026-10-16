#!/usr/bin/env bash
# Run after apply.sh on an isolated fixture-mode cluster.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
kubectl apply -f "$root/failing-pod.yaml"
deadline=$((SECONDS + 180))
run_name=''
while (( SECONDS < deadline )); do
  run_name="$(kubectl -n mas-demo get masdemoruns -l demo.mas.dev/source=warning-event -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  [[ -z "$run_name" ]] || break
  sleep 3
done
[[ -n "$run_name" ]] || { echo 'No MASDemoRun was created from the opted-in pod Warning Event' >&2; exit 1; }
kubectl -n mas-demo wait "masdemorun/$run_name" --for=jsonpath='{.status.phase}'=Succeeded --timeout=180s
run_id="$(kubectl -n mas-demo get "masdemorun/$run_name" -o jsonpath='{.status.runId}')"
kubectl -n mas-demo port-forward svc/mas-demo 18080:8080 > /tmp/mas-demo-port-forward.log 2>&1 &
forward_pid=$!
trap 'kill "$forward_pid" 2>/dev/null || true' EXIT
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:18080/api/health >/dev/null; then break; fi
  sleep 1
done
run_json="$(mktemp)"
trap 'rm -f "$run_json"; kill "$forward_pid" 2>/dev/null || true' EXIT
curl --fail --silent "http://127.0.0.1:18080/api/runs/$run_id/snapshot" > "$run_json"
node --input-type=module - "$run_json" <<'NODE'
import { readFileSync } from 'node:fs';
const {run, observation} = JSON.parse(readFileSync(process.argv[2], 'utf8'));
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
