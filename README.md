# MAS Host examples

Applications written in Python, Go, Rust and C++ running on the same
[MAS Host](https://github.com/emmett08/mas-host). Each example supplies application
functions or ordinary CLI tools, TOML agent settings and YAML topology/workflows.
All agent bindings use `mas-agents/3`. The host generates worker entry points, communication code
and registration bundles. Applications supply no handwritten worker transport or
custom host implementation.

The native examples and the default model fixtures run without credentials.
The composable example also supplies task-specific GPT-5.4/GPT-5.4 Mini settings,
Cursor, compatible-provider and mixed-provider profiles. The command example has
an explicit live model-to-CLI entry. The examples demonstrate coordination and recovery;
they do not evaluate model quality or make production release decisions.

| Example | Application behaviour | Host feature |
|---|---|---|
| [Go release qualification](examples/go-release) | Capacity, security and reliability checks; bounded capacity revisions; independent acceptance; optional durable audit receipt | Parallel child requests, joins, replay and uncertain-effect recovery |
| [Rust order calculation](examples/rust-order) | Checked integer totals, discount, tax and budget comparison | Generated Rust worker and precise JSON results |
| [C++ telemetry assessment](examples/cpp-telemetry) | Bounded sample-window statistics and threshold decisions | Generated C++17 worker and input validation |
| [Python service review](examples/python-review) | Dataclass inputs and outputs, capacity/security checks, independent acceptance and optional durable receipt | Typed Python client and workers, parallel/request/effect APIs, TOML settings and YAML input |
| [Command policy check](examples/command-policy) | Standalone CLI with arguments, JSON stdin/stdout and an optional receipt; optional GPT-5.4 delegation | Retained executable, shared operation contracts, model-to-command requests and admitted command recovery |
| [Composable review agents](examples/composable-agents) | Star, tree and mesh reviews nested into a release workflow; interchangeable model providers | Recursive Composite workflow, provider Strategy/Adapter, MAS admission and durable inference replay |

## Quick start

The pinned host supports **trusted local Linux applications**. Use Linux directly
or a Linux VM on macOS; GitHub Actions runs the same checks without a local Linux
installation. Prerequisites are Git, Make, Rust **1.99.0** through rustup, Go
**1.24.0 or later**, Python **3.11 or later**, and a compiler supporting C++17. Ubuntu 24.04 with
`build-essential` supplies the C/C++ build tools. Initial setup needs network
access to GitHub and the language dependency registries.

```sh
git clone https://github.com/emmett08/mas-host-examples.git
cd mas-host-examples
make setup
make go
make rust
make cpp
make python python-client
make command
make star tree mesh composed
```

`make setup` fetches the exact host commit in [host-revision.txt](host-revision.txt)
and builds it with its checked-in Cargo lockfile. The distribution, SDKs and build
tools remain together under `.tools/mas-host`. The Go module references that SDK
through ordinary relative dependency replacements. Neither upstream repository
is modified. Generated application files are ignored under each example's
`.mas/build/` directory.

Each command prints JSON with `status: "completed"` and an application `output`.
The Go input needs three rounds to provision sufficient capacity. The other
examples' inputs and documented expected outputs are in their directories.

## Change an application

1. Select the example closest to your problem and edit its functions or executable tool.
2. Bind each actor to a function, command, LLM or workflow in `agents.toml` (or JSON/YAML).
3. Declare permitted request and reply edges in `topology.yaml` (or TOML/JSON).
4. Run the host with a new run ID when changing application code or input.

For example, from this repository's root:

```sh
.tools/mas-host/target/debug/mas-host run \
  --sdk-root "$PWD/.tools/mas-host" \
  --project examples/go-release --agent planner \
  --input examples/go-release/input.yaml \
  --state .state --run release-002

.tools/mas-host/target/debug/mas-host inspect \
  --state .state --run release-002
```

Topology permits communication. Application code determines order, parallel
branches, stopping conditions and acceptance. A handler can use `Request`,
`Parallel` and `Effect` (with language-specific spelling) without implementing the
wire protocol. Code outside effect boundaries must be deterministic and free of
external effects because an incomplete handler may execute again.

To resume, retain the original input, run ID, host executable and generated
bundle. The host binds retained work to those identities and preserves the
original deadline. `mas-host build --project DIR --sdk-root DIR` prints an
immutable bundle path; `run --bundle FILE` selects that build without rebuilding.
Use fresh run IDs for separate experiments. Keep old bundles and state while
their runs remain relevant.

The host discovers one `agents` and one `topology` file by extension. Keep one
file per role, or select explicit paths with `--agents` and `--topology`. Workflow
plans and `--input` also accept TOML/YAML/JSON; schemas remain ordinary JSON. The
readers feed one validated execution model. The Python client accepts dataclasses
and dictionaries directly, so input files are optional.

To copy an example into another repository, retain its application and two
configuration files, then point the ordinary SDK dependency at your installed
host distribution. Go uses its standard module files; the current Rust/C++
profiles generate their build entry points from source files. Python captures
project modules and packages, including imported helpers. Installed third-party
Python dependencies require separately pinned versions and a retained compatible
interpreter/runtime. Full Cargo/CMake project discovery and arbitrary native type-to-schema generation are not yet
provided by the pinned host. CLI executables require no SDK. Their input/output
schemas belong to the operation; the host adapts and records command execution.

## Verify and observe recovery

```sh
make verify       # application checks and real host integration tests
make recovery     # Go/CLI crash reconciliation and Python recorded-effect replay
```

The integration tests build the actual examples and exercise positive decisions,
negative decisions, invalid inputs, replay, CLI argument binding and receipts,
model-to-CLI delegation through a local HTTP fixture, Python typed calls,
changed-source identity rejection, changed-input rejection
and denied communication routes. They use the public host CLI; they do not replace
it with a mock. Test state is created in temporary directories, independently of `.state`.

The recovery exercise:

1. Completes the parallel assessments and independent acceptance.
2. Admits the audit effect, writes and synchronises its receipt, then exits the
   worker before returning completion.
3. Confirms that another run attempt is blocked by the uncertain effect.
4. Matches the receipt's invocation identity to the inspected effect and its
   decision to the completed independent check, then submits confirmed output
   and evidence through `resolve`.
5. Resumes the original run and checks that completed child records remain,
   exactly one protocol call exists and the receipt bytes are unchanged.

This is evidence-based reconciliation for this local receipt. It is not a
general exactly-once guarantee. `resolve` records an operator assertion: an
application using a remote service needs evidence from that service. Ordinary
file writes or network calls outside `Effect` do not acquire recovery guarantees.

The host executes trusted code with the operator's filesystem permissions. The
local profile supplies maintained provider adapters and scoped credentials; it
has no remote service ingress or untrusted-code sandbox. The execution model
accepts integer numbers; examples use minor units and basis points to avoid floating-point ambiguity. The C++ SDK
supports signed and unsigned 64-bit integers.

See the host's [execution contract](https://github.com/emmett08/mas-host/blob/main/docs/native-contract.md)
for the precise limits and recovery semantics.

## Repository responsibilities

This repository owns maintained application demonstrations and their acceptance
checks against a pinned host. `mas-host` owns implementation tests, SDK snippets
and the compiler/recovery inputs under `tests/fixtures`; it does not maintain a
second catalogue of application examples.

## Licence

GPL-3.0-only; see [LICENSE](LICENSE). The examples consume the separately licensed
host distribution and its SDKs without vendoring their source.
