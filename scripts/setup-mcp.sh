#!/usr/bin/env bash
# Obtain the independent Rust MCP gateway at the reviewed example revision.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
revision="$(cat mcp-revision.txt)"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid MCP server revision.' >&2; exit 1; }
distribution="$root/.tools/mas-mcp"
mkdir -p "$root/.tools"
if [[ ! -e "$distribution" ]]; then
  git clone --no-checkout https://github.com/emmett08/mas-mcp.git "$distribution"
  git -C "$distribution" fetch origin "$revision"
  git -C "$distribution" checkout --detach "$revision"
fi
[[ "$(git -C "$distribution" rev-parse HEAD)" == "$revision" ]] || {
  echo 'Existing .tools/mas-mcp has another revision; move it aside and rerun make mcp-setup.' >&2
  exit 1
}
git -C "$distribution" diff --quiet HEAD -- || { echo 'MCP server checkout has modified tracked files.' >&2; exit 1; }
cargo build --locked --release --manifest-path "$distribution/Cargo.toml" \
  --target-dir "$distribution/target"
"$distribution/target/release/mas-mcp" --version
