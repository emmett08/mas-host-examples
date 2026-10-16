# Composable review agents

One application runs star, tree and mesh reviews, then combines those workflows
in a release decision. Application files define agents, routes, workflow plans,
prompts and result schemas. Settings use TOML; topology, workflow plans and the
sample input use YAML. Result schemas retain JSON. The installed MAS Host owns execution, provider
adapters and MAS Request/Result exchanges.

The default `agents.toml` uses explicit mock responses. It exercises real host
execution and protocol admission offline; its answers are fixtures, not evidence
of a model's review quality. Live provider configurations are selected explicitly
and never fall back to mocks.

| Entry agent | Actual request pattern |
| --- | --- |
| `star` | A hub requests security, delivery and operations reviews in parallel. |
| `tree` | The root requests technical and governance branches. Technical requests security and operations; governance requests delivery. |
| `mesh_a`, `mesh_b`, `mesh_c` | Each member reviews locally and can request both peers. A delegated request carries the local review and sets `delegate: false`, bounding this example's cycle. |
| `composed` | A reusable parallel definition requests star, tree and mesh workflows; a subsequent model actor evaluates their combined evidence. |

The topology grants routes. The workflow determines which granted routes a run
uses. Run each mesh entry with the supplied input to exercise all six directed
peer requests. Reverse edges also allow correlated replies, as required by the
current topology format.

## Run offline

From the repository root, after `make setup`:

```bash
.tools/mas-host/target/debug/mas-host run \
  --project examples/composable-agents \
  --agent composed \
  --input examples/composable-agents/input.yaml \
  --state .state --run composed-offline

.tools/mas-host/target/debug/mas-host inspect \
  --state .state --run composed-offline
```

Replace `--agent composed` with `star`, `tree` or a mesh member and choose a new
run ID to inspect that pattern separately. Repeating the same command with the
same bundle, input and run ID reuses the recorded results and provider effects.

## Select a live provider

These profiles override provider connections and models. Actor declarations,
workflow plans, prompts and schemas remain in one shared application definition:

| Configuration | Bindings | Required credential environment |
| --- | --- | --- |
| `connections.openai.toml` | OpenAI Responses with a task-specific GPT-5.4 / GPT-5.4 Mini allocation. | `OPENAI_API_KEY` |
| `connections.cursor.toml` | All model actors use the maintained Cursor adapter. | `CURSOR_API_KEY` |
| `connections.compatible.toml` | All model actors use a compatible Chat Completions endpoint. | `OTHER_API_KEY` |
| `connections.mixed.toml` | Security and decision use OpenAI, delivery uses Cursor, operations uses the compatible endpoint. | All three above |

The OpenAI profile names model snapshots so its allocation is explicit:

| Task | Snapshot | Illustrative allocation |
| --- | --- | --- |
| Security review | `gpt-5.4-2026-03-05` | Reserve GPT-5.4 for risk assessment. |
| Delivery review | `gpt-5.4-mini-2026-03-17` | Use lower-cost Mini for the narrow rollback check. |
| Operations review | `gpt-5.4-mini-2026-03-17` | Use lower-cost Mini for the narrow telemetry check. |
| Final decision | `gpt-5.4-2026-03-05` | Reserve GPT-5.4 for combined evidence. |

This demonstrates per-task model selection, not an established quality or cost
optimum. The supplied policy checks are simple Boolean rules: a deterministic
command is preferable when those rules must decide acceptance. Models become
useful when the task includes interpretation that those rules do not express.
Evaluate candidate allocations against representative tasks before choosing a
production profile. OpenAI documents these snapshots and their Responses and
structured-output support in its [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4)
and [GPT-5.4 Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini) model
pages (checked 16 October 2026). Account access remains a deployment prerequisite.

Each named connection is a deployment binding. A profile's `model` overrides
the model in every actor referencing that connection. Separate connection names
let tasks select different models even when they use the same provider endpoint.
The prompts, operation contracts and workflow remain shared.

The Cursor, compatible and mixed profiles retain `<...-model-id>` placeholders;
replace each with a model available to the relevant account. For Cursor, install
its pinned dependencies following the host's `assets/providers/README.md`; the
host resolves `@sdk` to its installed SDK root.
If Node is installed outside the host's system executable paths, replace `node`
in the connection command with its absolute executable path.
For the compatible adapter, replace `https://provider.example/v1/chat/completions` with the full
endpoint URL. Providers without JSON Schema support can explicitly set
`structured_outputs: false`; the host still checks the returned object locally.
Cursor's SDK does not expose an enforceable output-token cap: that adapter records
the configured token limit as advisory, while enforcing time and response-byte
limits. Use provider evidence to distinguish requested and enforced limits.

### Discover Cursor models

The Cursor profile uses the official SDK for a restricted inference run. It does
not automate the Cursor IDE or enable its repository-editing tools. With
`CURSOR_API_KEY` set, run this account metadata query from the repository root:

```sh
npm --prefix .tools/mas-host/assets/providers ci
(
  cd .tools/mas-host/assets/providers
  node --input-type=module <<'JAVASCRIPT'
import { Cursor } from "@cursor/sdk";
const models = await Cursor.models.list({ apiKey: process.env.CURSOR_API_KEY });
console.log(JSON.stringify(models, null, 2));
JAVASCRIPT
)
```

Select returned IDs in `connections.cursor.toml`, or just the delivery binding in
`connections.mixed.toml`. Cursor documents that this catalogue is account- and
team-specific in [its SDK reference](https://cursor.com/docs/sdk/typescript#cursormodelslist).
The installed `@cursor/sdk` version 1.0.37 exposes this discovery method.
This host currently selects models by ID; it does not expose Cursor's optional
per-model parameters, so their SDK defaults apply. Choose IDs whose defaults
meet the task requirements. The query above discovers metadata and starts no
inference. Selecting the live profile below starts inference.

### Run the selected profile

Set the required credential variables in your shell, then select a configuration:

```bash
.tools/mas-host/target/debug/mas-host run \
  --project examples/composable-agents \
  --connections connections.openai.toml \
  --agent composed \
  --input examples/composable-agents/input.yaml \
  --state .state --run composed-openai
```

Credentials are referenced by variable name, not placed in configuration files.
Use a new run ID after changing a model, prompt, provider binding or schema. Live
responses are retained for replay; the host does not promise that a second live
inference will produce the same answer. The test suite verifies offline behaviour
and makes no claim that an account's live provider credentials were exercised.

## Extend the composition

The workflow nodes compose recursively: `sequence`, `parallel`, `branch`, bounded
`repeat`, `foreach`, reusable `call`, `request` and pure `value` mappings. Add
application actors and routes, then compose their requests in a plan. A workflow
actor can itself be requested by any permitted peer, so a subtree or a mesh review
can occupy any leaf in a larger workflow. Executions remain subject to configured
time, message, byte and call limits, and the host's fixed structural bounds.

Templates make data flow explicit. `{$input: /change}` reads the workflow's
original input, while `{$previous: /results}` reads the previous node's
ordered parallel results. `{$input: ""}` selects the whole input. These YAML
mappings resolve to the same strict execution values as JSON templates. Ordered
steps are YAML sequences. The host rejects duplicate keys, tags, anchors, aliases
and non-integer numeric values before building a run.

The sample uses the Composite pattern for nested workflow nodes and named
definitions, and Strategy through provider connection bindings. The application
depends on the host's configuration and execution contracts; it contains no
provider transport or alternate protocol implementation. Provider-specific code
belongs in host adapters, while review policy belongs in the prompts and schemas.
