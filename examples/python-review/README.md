# Python: typed service review

Four Python agents assess a synthetic service proposal. The reviewer requests
capacity and security checks in parallel, then asks an independent acceptance
agent to recompute both reports. Approval requires sufficient capacity and zero
critical findings. This example assesses supplied values; it deploys nothing.

`review.py` contains dataclasses and ordinary functions. The host generates each
worker entry point, freezes the project’s Python modules and the SDK into its worker artefact,
and exchanges admitted MAS requests and results. No application transport code
or third-party Python packages are required. Python 3.11 or later is required.

The authored files are:

| File | Purpose |
| --- | --- |
| `agents.toml` | Public operations, Python handler bindings and execution limits |
| `topology.yaml` | Permitted request and reply routes |
| `input.yaml` | Optional CLI input example |
| `review.py` | Typed request, parallel assessment, independent acceptance and receipt effect |
| `call.py` | Typed root client passing a `Proposal` and receiving a `Decision` |
| `configure.py` | Optional typed configuration builder equivalent to the TOML/YAML files |

From the repository root after `make setup`:

```bash
make python        # CLI reads input.yaml
make python-client # Python passes a dataclass directly
```

The first two commands return `approved: true`, `available_capacity: 300` and
`critical_findings: 0`. A demand of 301 or one critical finding produces a normal
completed refusal. Missing fields, booleans in integer fields and out-of-range
counts are rejected. The SDK adapts nested dataclasses and validates their field
types at the application boundary.

The root client API is also available directly:

```python
from pathlib import Path
from mas_host import Client
from review import Decision, Proposal

client = Client(
    project=Path("examples/python-review"),
    host=".tools/mas-host/target/debug/mas-host",
    sdk_root=".tools/mas-host",
    state=".state",
    run_id="service-review-2",
)
decision = client.run(
    "reviewer", Proposal("service-42", 240, 3, 100, 0), output_type=Decision
)
print(decision.approved)
```

Import `mas_host` from the installed distribution's `sdk/python` directory. For
the snippet above, include both `.tools/mas-host/sdk/python` and
`examples/python-review` on `PYTHONPATH`. `make` sets the SDK path for its targets.
The client sends strict JSON on stdin to the public host CLI; callers do not
write an intermediate input file. Agent code uses the SDK's separate worker
interface through `Context`.

To author configuration in Python too, run `call.py` with `--native-config`.
It explicitly exports `configure.configuration()` into `.mas/authored` and passes
those paths to the host. This is an alternative authoring example; the default
continues to read TOML/YAML. The host never imports this configuration module
while resuming a bundle or inspecting retained work. The acceptance test switches
between the file and builder forms under one run ID and verifies identical
retained steps and a single receipt effect.

## Optional receipt and replay

To publish one durable local receipt, choose a new run ID and a fresh absolute
receipt path whose parent directory exists:

```bash
PYTHONPATH="$PWD/.tools/mas-host/sdk/python" \
python3 examples/python-review/call.py \
  --host "$PWD/.tools/mas-host/target/debug/mas-host" \
  --sdk-root "$PWD/.tools/mas-host" \
  --run python-receipt --receipt "$PWD/.state/python-receipt.json"
```

The receipt is created inside `ctx.effect`. It records the admitted invocation
identity and the accepted decision, and synchronises both the file and its
containing directory. Repeating the same run reuses the retained decision and
effect; exclusive file creation makes an accidental second publication fail.
If the worker stops after publication but before completion, the host requires
reconciliation. A receipt file alone is insufficient: verify its invocation
identity and output against the retained acceptance step before resolving an
uncertain effect. The Go example demonstrates that full reconciliation sequence.

Keep the original immutable bundle to resume a run. Building changed Python
source produces another implementation identity; the host refuses to use it
with an existing run ID. The acceptance tests verify both rejection and continued
execution of the original frozen bundle. Python source modules and packages
inside the project are captured together, including imported helpers. Installed
third-party dependencies remain external to the artefact: preserve their pinned
versions and the selected interpreter/runtime when resuming a run. This example
uses only the standard library and `mas_host`.
