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
| `connections.openai.toml` | All model actors use OpenAI Responses. | `OPENAI_API_KEY` |
| `connections.cursor.toml` | All model actors use the maintained Cursor adapter. | `CURSOR_API_KEY` |
| `connections.compatible.toml` | All model actors use a compatible Chat Completions endpoint. | `OTHER_API_KEY` |
| `connections.mixed.toml` | Security and decision use OpenAI, delivery uses Cursor, operations uses the compatible endpoint. | All three above |

Before a live run, replace each `<...-model-id>` with a model available to your
account. For Cursor, install its pinned dependencies following the host's
`assets/providers/README.md`; the host resolves `@sdk` to its installed SDK root.
If Node is installed outside the host's system executable paths, replace `node`
in the connection command with its absolute executable path.
For the compatible
adapter, replace `https://provider.example/v1/chat/completions` with the full
endpoint URL. Providers without JSON Schema support can explicitly set
`structured_outputs: false`; the host still checks the returned object locally.
Cursor's SDK does not expose an enforceable output-token cap: that adapter records
the configured token limit as advisory, while enforcing time and response-byte
limits. Use provider evidence to distinguish requested and enforced limits.

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
