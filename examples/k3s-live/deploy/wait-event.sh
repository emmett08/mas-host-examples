#!/usr/bin/env bash
# Wait for the run associated with this Pod identity, not an older demonstration.
set -euo pipefail
pod="${1:-mas-demo-crash}"
pod_uid="$(kubectl -n mas-demo get "pod/$pod" -o jsonpath='{.metadata.uid}')"
deadline=$((SECONDS + 600))
while (( SECONDS < deadline )); do
  run_name="$(kubectl -n mas-demo get masdemoruns -o json | OBJECT_UID="$pod_uid" node --input-type=module -e '
    import {readFileSync} from "node:fs";
    const {items} = JSON.parse(readFileSync(0, "utf8"));
    const run = items.find(item => item.spec.event?.involvedObject?.uid === process.env.OBJECT_UID);
    if (run) process.stdout.write(run.metadata.name);
  ')"
  if [[ -n "$run_name" ]]; then
    phase="$(kubectl -n mas-demo get "masdemorun/$run_name" -o jsonpath='{.status.phase}')"
    if [[ "$phase" == Succeeded ]]; then
      kubectl -n mas-demo get "masdemorun/$run_name"
      exit 0
    fi
    if [[ "$phase" == Failed ]]; then
      echo "MASDemoRun $run_name failed; inspect its status and dashboard run" >&2
      exit 1
    fi
  fi
  sleep 5
done
echo "No successful MASDemoRun for Pod UID $pod_uid within 600 seconds" >&2
exit 1
