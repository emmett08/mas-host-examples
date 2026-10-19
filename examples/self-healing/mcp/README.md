# Self-healing through MAS MCP

An external MCP client can request the complete bounded controller workflow,
inspect committed progress and cancel the incident. The independently pinned
Rust `mas-mcp` server owns MCP framing, discovery and request retention. The
existing controller owns repair decisions, budgets, independent measurements,
isolated Kubernetes trials and publication policy.

The service is local stdio on Linux. Its operator prepares one incident and
its immutable execution grant. Tool callers supply identifiers and a progress
cursor. Executables, directories, source, requirements, credentials, budgets
and release policy are selected during preparation.

## Prepare and connect

Build the dependencies from repository root:

```sh
make setup mcp-setup
cd examples/self-healing
npm ci --ignore-scripts
npm run build
```

Prepare the immutable sandbox image and disposable cluster using the
[existing local Kubernetes instructions](../README.md#run-the-real-host-and-disposable-kubernetes-control).
Keep `MAS_SANDBOX_IMAGE` and `KUBECONFIG` set. Then prepare a fresh directory:

```sh
npm run prepare:mcp -- \
  --output /absolute/path/healing-mcp-incident-42 \
  --incident incident-42 --mode fixture --case missing-route
```

Preparation builds a retained host application and writes `mcp-client.json`,
`server.json`, `request.json` and the private `project/admission.json`.
It performs no repair. Register the `mas-self-healing` entry from
`mcp-client.json` with a stdio-capable client. Keep the prepared directory,
original checkout, pinned SDK, runtime assets and their paths available.
Changed dependency bytes or repository HEAD block a new repair dispatch.
The run uses the controller bundle built by `npm run build`; rebuild before
preparing an incident after source edits.

For an operational incident, use `--mode live --config /absolute/path/incident.json`
with the [existing operational configuration](../README.md). Preparation defaults
an omitted publication policy to `archive`. An explicit `pull-request` policy
retains the existing separately scoped publisher requirement. Automatic
operational deployment is outside this interface. Set the model, per-call
reservation and budget variables before preparation. Provide the configured
credentials to the client process when it launches the service. Credential
values are inherited only by their named trusted operations and are absent
from the generated configuration files.

The generated registration runs a small Node supervisor around the Rust
server with inherited stdio. The supervisor does not parse MCP messages.
It observes the original outer host run and forwards its committed cancellation
intent into the controller journal. Keep this registration when using
`mas_cancel`; launching the Rust binary directly omits that bridge.

## Published operations

The five standard MCP tools remain `mas_describe`, `mas_submit`, `mas_status`,
`mas_observe` and `mas_cancel`. `mas_describe` publishes three application operations:

| Operation selected through `mas_submit` | Application input | Application result |
|---|---|---|
| `self_healing_run` | `incident_id`, `contract_digest`, `request_id` | The controller snapshot after the foreground execution returns, or the existing incident snapshot if already dispatched |
| `self_healing_status` | `incident_id`, `contract_digest`, optional `after` | A bounded page of committed controller events, original dispatch identity, budget and recorded outcome |
| `self_healing_cancel` | `incident_id`, `contract_digest` | Persistent incident cancellation intent and the resulting snapshot |

1. Call `mas_describe` and retain its `descriptor_digest`.
2. Use the generated `request.json`, replacing its descriptor placeholder.
   Its outer `request_id` and the `request_id` inside `input_json` must match.
   The adapter verifies that identifier against the actual admitted host effect.
3. Poll `mas_status` for the original task. Submit `self_healing_status` with
   a **fresh MCP request ID for each read** to obtain current controller progress.
   Reusing a read request ID returns that read's retained observation.
4. Pass the returned `next_after` as the next cursor. `more` identifies additional
   committed events. Event sequence numbers correlate controller phases,
   candidates and effect invocation IDs without exposing raw source or provider
   messages. Oversized projections are explicitly marked.
5. Parse the completed task's `output_json`, then its `snapshot_json` string.

All operations return the exact incident and contract identity plus the host
command's `invocation_id`. `snapshot_json.dispatch` retains the original repair
request and effect identity even when another task reads or cancels it.
`mas_observe` concerns the outer host run. `self_healing_status` supplies the
controller's correlated observations across its separate inner host runs.

## Completion, cancellation and recovery

| Observation | Meaning |
|---|---|
| MCP task `completed` | The exported operation returned schema-valid output |
| Controller `not_started` | No dispatch has been committed for this prepared incident |
| Controller `dispatched` | The original dispatch is retained; work may be running or interrupted |
| Controller `outcome_recorded` | The controller committed the displayed application outcome |
| Controller `cancelled_before_dispatch` | Incident cancellation prevented the controller dispatch |
| `cancellation_requested: true` | Persistent controller cancellation intent; external effects can remain unresolved |
| Outcome `verified_recovery` | The controller recorded recovery in its isolated trial, with publication represented separately |
| Outcome `no_eligible_candidate` | The controller completed without a candidate passing its gates |
| MCP task `unknown` | The gateway lacks confirmed completion; retain the original task identity |

Use `self_healing_cancel` to cancel the incident, including before its first
dispatch. The active controller polls its journal and forwards cancellation to
its current host phase. `mas_cancel` cancels the outer task; after dispatch,
the generated supervisor also persists the matching incident cancellation.
Host interruption may leave the task or an effect unknown. Confirm the
controller cancellation with a fresh `self_healing_status` observation.

An identical MCP submission returns the original task. A changed submission
under that ID rejects. A different MCP request ID for this prepared incident
returns its existing controller record and never launches a second controller.
The incident's original deadline, expenditure and call reservations remain.

After abrupt server loss, `mas-mcp` converts unfinished tasks to `unknown` and
does not dispatch them again. A surviving controller may still finish, and a
fresh status operation can show its outcome. This does not rewrite the gateway's
unknown record. Unknown tasks continue to occupy its active capacity. The
configuration allows four active tasks and 2,048 lifetime request identities,
including status reads. Stop polling after completion and reconcile exhausted
capacity through the operator's deployment process while retaining old evidence.

Controller resumption remains an explicit operator action under the original
[recovery procedure](../verification/RECOVERY.md). Preserve the generated
admission's original arguments, environment settings, controller directory and
dependencies when using `scripts/run.ts`. Reconcile external effects first.
An MCP submission cannot reset the dispatch record, clear cancellation or
authorise replacement work after an interrupted outcome.

## Design and verification

The selected design is an outer host command adapter. Replacing
`HostPhaseRunner` would require `--revision-plan` support and different phase
publication contracts. Leaving only the CLI would keep external MCP clients
without an admitted incident operation. The adapter reuses both existing
executors and introduces no second repair policy or MCP implementation.

| Responsibility | Owner |
|---|---|
| MCP task identity and transport | Pinned Rust `mas-mcp` |
| Published application schemas and operator preparation | `contract.ts`, `prepare.ts` |
| Original controller dispatch and cancellation | Controller journal, `incident.ts` |
| Bounded read-only incident projection | `observation.ts` |
| Foreground process and request-to-effect binding | `execute.ts` |
| Outer host cancellation to incident intent | `service.ts` |
| Cross-process incident intent to active runtime signal | `controller/cancellation.ts` |
| Repair acceptance and publication | Existing controller and independent verifier |

From the example directory, with `MAS_HOST_BIN`, `MAS_SDK_ROOT` and optionally
`MAS_MCP_BIN` selecting the pinned distributions:

```sh
npm test
npm run test:mcp
npm run demo:mcp -- --output /absolute/path/new-mcp-control --incident mcp-control
```

Unit checks exercise frozen identities, budget retention, cancellation and
bounded read-only progress. Official-client integration uses the real Rust
server, real host and real controller with explicitly labelled scripted
measurement ports. It checks failed acceptance gates, restart replay, lost
outcomes and both cancellation paths. The final command uses the ordinary
sandbox and Kubernetes adapters for the complete `missing-route` control,
including progress observed before completion. CI runs both levels.

These controls establish the tested execution and recovery behaviour. Live
repair competence and operational deployment require their own observations.
