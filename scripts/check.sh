#!/usr/bin/env bash
# Check application sources; host and generated transport tests belong upstream.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
export GOWORK=off GOTOOLCHAIN=local
if [[ ! -x .tools/mas-host/target/debug/mas-host ]]; then
  echo 'Run make setup first.' >&2
  exit 1
fi
unformatted="$(gofmt -l examples/go-release tests)"
[[ -z "$unformatted" ]] || { printf 'Run gofmt on:\n%s\n' "$unformatted" >&2; exit 1; }
for project in examples/go-release tests; do
  (cd "$project" && go vet ./...)
done
while IFS= read -r source; do
  rustfmt --edition 2021 --check "$source"
done < <(find examples -type d -name .mas -prune -o -type f -name '*.rs' -print)
bash -n scripts/setup.sh scripts/check.sh scripts/test-native.sh

# Parse Python source without creating bytecode beside application modules.
python3 - <<'PYTHON'
import ast
from pathlib import Path
for source in Path("examples/python-review").rglob("*.py"):
    if ".mas" not in source.parts:
        ast.parse(source.read_text(), filename=str(source))
PYTHON
