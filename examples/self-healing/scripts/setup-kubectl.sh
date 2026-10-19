#!/usr/bin/env bash
# Match the disposable k3s server with the official static Linux client. The
# runner's ambient client can change independently of our host resource limits.
set -euo pipefail
read -r kubectl_version kubectl_sha256 < "$(dirname "$0")/../kubectl-version.txt"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]]
[[ "$kubectl_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$kubectl_sha256" =~ ^[a-f0-9]{64}$ ]]
kubectl_target=/usr/local/bin/kubectl
if [[ ! -x "$kubectl_target" ]] || ! echo "$kubectl_sha256  $kubectl_target" | sha256sum --check --status 2>/dev/null; then
  kubectl_download=$(mktemp "${RUNNER_TEMP:-/tmp}/self-remediation-kubectl.XXXXXX")
  trap 'rm -f "$kubectl_download"' EXIT
  curl --fail --location --silent --show-error \
    "https://dl.k8s.io/release/${kubectl_version}/bin/linux/amd64/kubectl" \
    --output "$kubectl_download"
  echo "$kubectl_sha256  $kubectl_download" | sha256sum --check
  sudo install -m 0755 "$kubectl_download" "$kubectl_target"
fi
echo "$kubectl_sha256  $kubectl_target" | sha256sum --check
"$kubectl_target" version --client --output=json
