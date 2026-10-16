#!/usr/bin/env bash
# Deploy to the current kubectl context. Live deployments require explicit mode.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
image="${MAS_IMAGE:-mas-k3s-live:demo}"
mode="${DEMO_MODE:-live}"
show_payloads="${SHOW_PAYLOADS-false}"
auto_remediate="${DEMO_AUTO_REMEDIATE-false}"
[[ "$image" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/@:-]+$ ]] || { echo 'MAS_IMAGE is invalid' >&2; exit 1; }
[[ "$mode" == live || "$mode" == fixture ]] || { echo 'DEMO_MODE must be live or fixture' >&2; exit 1; }
[[ "$show_payloads" == true || "$show_payloads" == false ]] || { echo 'SHOW_PAYLOADS must be true or false' >&2; exit 1; }
[[ "$auto_remediate" == true || "$auto_remediate" == false ]] || { echo 'DEMO_AUTO_REMEDIATE must be true or false' >&2; exit 1; }
kubectl apply -f "$root/namespace.yaml"
kubectl apply -f "$root/crd.yaml"
kubectl apply -f "$root/remediation-crd.yaml"
kubectl wait --for=condition=Established crd/masdemoruns.demo.mas.dev --timeout=60s
kubectl wait --for=condition=Established crd/masremediations.demo.mas.dev --timeout=60s
kubectl apply -f "$root/rbac.yaml"
if ! kubectl -n mas-demo get secret mas-demo-verifier >/dev/null 2>&1; then
  verifier_file="$(mktemp)"
  trap 'rm -f "$verifier_file"' EXIT
  chmod 600 "$verifier_file"
  node --input-type=module -e "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('hex'));" > "$verifier_file"
  kubectl -n mas-demo create secret generic mas-demo-verifier --from-file="DEMO_VERIFIER_TOKEN=$verifier_file" --dry-run=client -o yaml | kubectl apply -f -
  rm -f "$verifier_file"
  trap - EXIT
fi
kubectl -n mas-demo create configmap mas-demo-settings --from-literal="provider=$mode" --from-literal="showPayloads=$show_payloads" --from-literal="autoRemediate=$auto_remediate" --dry-run=client -o yaml | kubectl apply -f -
if [[ -n "${GHCR_PULL_TOKEN:-}" ]]; then
  registry_file="$(mktemp)"
  trap 'rm -f "$registry_file"' EXIT
  chmod 600 "$registry_file"
  node --input-type=module - > "$registry_file" <<'NODE'
const user = process.env.GHCR_PULL_USER ?? 'emmett08';
const auth = Buffer.from(`${user}:${process.env.GHCR_PULL_TOKEN}`).toString('base64');
process.stdout.write(JSON.stringify({ auths: { 'ghcr.io': { auth } } }));
NODE
  kubectl -n mas-demo create secret generic mas-demo-registry --type=kubernetes.io/dockerconfigjson --from-file=".dockerconfigjson=$registry_file" --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n mas-demo patch serviceaccount mas-demo-operator --type=merge -p '{"imagePullSecrets":[{"name":"mas-demo-registry"}]}'
  kubectl -n mas-demo patch serviceaccount mas-demo-remediator --type=merge -p '{"imagePullSecrets":[{"name":"mas-demo-registry"}]}'
  rm -f "$registry_file"
  trap - EXIT
fi
if [[ "$mode" == live ]]; then
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    secret_file="$(mktemp)"
    trap 'rm -f "$secret_file"' EXIT
    chmod 600 "$secret_file"
    printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY" > "$secret_file"
    kubectl -n mas-demo create secret generic mas-demo-provider --from-env-file="$secret_file" --dry-run=client -o yaml | kubectl apply -f -
    rm -f "$secret_file"
    trap - EXIT
  else
    # Existing secrets may be managed outside this repository.
    kubectl -n mas-demo get secret mas-demo-provider >/dev/null
  fi
fi
# Environment references are resolved when containers start. Changing the
# template annotation also rolls an existing deployment onto the chosen setting.
sed -e "s|mas-k3s-live:demo|$image|g" \
  -e "s|demo.mas.dev/show-payloads: 'false'|demo.mas.dev/show-payloads: '$show_payloads'|" \
  "$root/deployment.yaml" | kubectl apply -f -
kubectl -n mas-demo rollout status deployment/mas-demo --timeout=180s
sed -e "s|mas-k3s-live:demo|$image|g" \
  -e "s|demo.mas.dev/auto-remediate: 'false'|demo.mas.dev/auto-remediate: '$auto_remediate'|" \
  "$root/remediator.yaml" | kubectl apply -f -
kubectl -n mas-demo rollout status deployment/mas-demo-remediator --timeout=180s
printf 'Dashboard: kubectl -n mas-demo port-forward svc/mas-demo 8080:8080\n'
printf 'Automatic remediation: %s (dedicated mas-demo-remediator controller)\n' "$auto_remediate"
printf 'Trigger: kubectl apply -f %s/failing-pod.yaml\n' "$root"
