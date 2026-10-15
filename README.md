# MAS Host examples

Applications written in Go, Rust and C++ running on the same
[MAS Host](https://github.com/emmett08/mas-host). Each example supplies application
functions, `agents.json` and `topology.json`. The host generates worker entry
points, communication code and registration bundles. Application directories
contain no Python, handwritten worker transport or custom host implementation.

These are deterministic native agents. They need no model subscription, API key
or external service. The examples demonstrate coordination and recovery; they do
not evaluate language models or make production release decisions.

| Example | Application behaviour | Host feature |
|---|---|---|
| [Go release qualification](examples/go-release) | Capacity, security and reliability checks; bounded capacity revisions; independent acceptance; optional durable audit receipt | Parallel child requests, joins, replay and uncertain-effect recovery |
| [Rust order calculation](examples/rust-order) | Checked integer totals, discount, tax and budget comparison | Generated Rust worker and precise JSON results |
| [C++ telemetry assessment](examples/cpp-telemetry) | Bounded sample-window statistics and threshold decisions | Generated C++17 worker and input validation |
| [Mixed-language review](examples/mixed-review) | Go coordinator combines Rust exposure and C++ arrears assessments, independently checks reports and applies a synthetic policy | Cross-language requests under one topology and execution journal |

## Quick start

The pinned host supports **trusted local Linux applications**. Use Linux directly
or a Linux VM on macOS; GitHub Actions runs the same checks without a local Linux
installation. Prerequisites are Git, Make, Rust **1.99.0** through rustup, Go
**1.24.0 or later**, and a compiler supporting C++17. Ubuntu 24.04 with
`build-essential` supplies the C/C++ build tools. Initial setup needs network
access to GitHub and the language dependency registries.

```sh
git clone https://github.com/emmett08/mas-host-examples.git
cd mas-host-examples
make setup
make go
make rust
make cpp
make mixed
```

`make setup` fetches the exact host commit in [host-revision.txt](host-revision.txt)
and builds it with its checked-in Cargo lockfile. The distribution, SDKs and build
tools remain together under `.tools/mas-host`. The Go modules reference that SDK
through ordinary relative dependency replacements. Neither upstream repository
is modified. Generated application files are ignored under each example's
`.mas/build/` directory.

Each command prints JSON with `status: "completed"` and an application `output`.
The Go input needs three rounds to provision sufficient capacity. The other
examples' inputs and documented expected outputs are in their directories.

## Change an application

1. Select the example closest to your problem and edit its application functions.
2. Bind each actor to a function in `agents.json`.
3. Declare permitted request and reply edges in `topology.json`.
4. Run the host with a new run ID when changing application code or input.

For example, from this repository's root:

```sh
.tools/mas-host/target/debug/mas-host run \
  --sdk-root "$PWD/.tools/mas-host" \
  --project examples/go-release --agent planner \
  --input examples/go-release/input.json \
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

To copy an example into another repository, retain its application and two
configuration files, then point the ordinary SDK dependency at your installed
host distribution. Go uses its standard module files; the current Rust/C++
profiles generate their build entry points from source files. Full Cargo/CMake
project discovery and arbitrary native type-to-schema generation are not yet
provided by the pinned host.

## Verify and observe recovery

```sh
make verify       # application checks and real host integration tests
make recovery     # run the durable-receipt crash/reconciliation exercise alone
```

The integration tests build the actual examples and exercise positive decisions,
negative decisions, invalid inputs, replay, changed-input rejection and denied
communication routes. They use the public host CLI; they do not replace it with
a mock. Test state is created in temporary directories, independently of `.state`.

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
initial profile is not a sandbox and has no built-in model providers, remote
service ingress or credential injection. JSON numbers are integers; examples
use minor units and basis points to avoid floating-point ambiguity. The C++ SDK
supports signed and unsigned 64-bit integers.

See the pinned host's [execution contract](https://github.com/emmett08/mas-host/blob/ad3c275fbfb29bf780b405b824b5abf94380444b/docs/native-contract.md)
for the precise limits and recovery semantics.

## Licence

GPL-3.0-only; see [LICENSE](LICENSE). The examples consume the separately licensed
host distribution and its SDKs without vendoring their source.
