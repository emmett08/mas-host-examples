#!/usr/bin/env bash
# Trusted infrastructure preparation; candidate code never receives this shell.
set -euo pipefail
command -v docker >/dev/null
docker info >/dev/null
bash "$(dirname "$0")/setup-kubectl.sh"
read -r kubectl_version _ < "$(dirname "$0")/../kubectl-version.txt"
k3d_version=v5.8.3
curl --fail --location --silent --show-error \
  "https://github.com/k3d-io/k3d/releases/download/${k3d_version}/k3d-linux-amd64" \
  --output "${RUNNER_TEMP:-/tmp}/self-remediation-k3d"
sudo install -m 0755 "${RUNNER_TEMP:-/tmp}/self-remediation-k3d" /usr/local/bin/k3d
k3d version
k3d cluster create self-remediation --image "rancher/k3s:${kubectl_version}-k3s1" --wait --timeout 120s
export KUBECONFIG="${RUNNER_TEMP:-/tmp}/self-remediation-kubeconfig"
k3d kubeconfig get self-remediation > "$KUBECONFIG"
chmod 0600 "$KUBECONFIG"
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "KUBECONFIG=$KUBECONFIG" >> "$GITHUB_ENV"
fi
kubectl config use-context k3d-self-remediation
kubectl get nodes
# The trusted trial executor creates each owned mas-repair-* namespace and its
# default-deny policy. Candidate containers receive no kubeconfig or API token.
