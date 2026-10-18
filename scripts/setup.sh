#!/usr/bin/env bash
# Obtain and build the pinned host distribution, including its native SDKs.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
profile="${MAS_HOST_BUILD_PROFILE:-debug}"
build_options=()
case "$profile" in
  debug) ;;
  release) build_options+=(--release) ;;
  *) echo 'MAS_HOST_BUILD_PROFILE must be debug or release.' >&2; exit 1 ;;
esac
if [[ "$(uname -s)" != Linux ]]; then
  echo 'The pinned MAS host requires Linux; use a Linux VM or the GitHub Actions workflow.' >&2
  exit 1
fi
for command in git cargo rustc go c++ make python3; do
  command -v "$command" >/dev/null || { echo "Missing prerequisite: $command" >&2; exit 1; }
done
python3 -c 'import sys; sys.exit("Python 3.11 or later is required" if sys.version_info < (3, 11) else 0)'
revision="$(cat host-revision.txt)"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid host revision.' >&2; exit 1; }
distribution="$root/.tools/mas-host"
mkdir -p "$root/.tools"
if [[ ! -e "$distribution" ]]; then
  git clone --no-checkout https://github.com/emmett08/mas-host.git "$distribution"
  git -C "$distribution" fetch origin "$revision"
  git -C "$distribution" checkout --detach "$revision"
fi
[[ "$(git -C "$distribution" rev-parse HEAD)" == "$revision" ]] || {
  echo 'Existing .tools/mas-host has another revision; move it aside and rerun make setup.' >&2
  exit 1
}
git -C "$distribution" diff --quiet HEAD -- || { echo 'Host checkout has modified tracked files.' >&2; exit 1; }
# Specify the target directory so the documented executable path remains stable.
cargo build --locked --manifest-path "$distribution/Cargo.toml" \
  --target-dir "$distribution/target" "${build_options[@]}" -p mas-host
"$distribution/target/$profile/mas-host" --version
