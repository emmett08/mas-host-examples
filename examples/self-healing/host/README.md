# Pinned host boundary

`phase.ts` and `tool.ts` use the MAS host pinned by the repository's
`host-revision.txt`: `f3cc7cb1894bebd45c2d708edec27c4b8171be1a`.
Each invocation verifies the SDK checkout's exact revision and clean tracked
files and records the executable SHA-256. The workflow builds that executable
from the identified checkout. This does not attest a third-party binary's build.

The contracts read at that revision were `docs/assessment-revision.md`,
`docs/native-contract.md`, `docs/commands.md`, `docs/llm-workflows.md`,
`docs/mcp-tools.md` and `docs/observation.md`.

* Frozen investigation, synthesis and independent review are distinct host runs.
  Each uses `--revision-plan` with zero internal source revisions. The outer
  controller owns source mutation and launches a new run when evidence changes.
* The investigator delegates experiment planning through the maintained LLM
  actor and Nehemiah request/result path. There is no application provider loop.
* Revision permits only maintained `mas-inference/2` effects. Commands and
  remediation are refused before reservation. Evaluators cannot delegate.
* The native evaluator checks record size only. Neither that structural pass nor
  the model review authorises a repair. The controller owns mandatory gates.
* Operation schemas use the host's integer JSON subset. Phase inputs are limited
  to 10,000 bytes and outputs to 12,288 bytes, leaving space for repeated evidence
  and request history in 65,536-byte frames. The complete compiled bundle is
  checked against that same limit. Large inputs use artefact references and an
  explicitly admitted source projection.
* `executeTool` and `runTrustedOperation` launch ordinary command runs outside
  assessment. Fixed arguments bind application `operationId` to the actual host
  effect `invocation_id`. The broker's own journal records both before effects.
  The native receipt control also verifies the SDK's separate actor invocation.
* A schema-valid accepted-exit receipt can report `failed` or `inconclusive`.
  Non-accepted exits, missing outputs and transport loss preserve unknown effect
  state. Retrying a run reuses completed effects. Administrative resolution
  requires the original effect identity and independently retained evidence.
* Provider, publication and cluster credentials are granted only to their
  appropriate trusted processes. Candidate code runs in the separate sandbox.
  Native workers and ordinary host commands are trusted code, not a sandbox.

`phase.integration.ts` runs actual pinned-host delegation and replay with a
clearly labelled scripted provider. Its fixture responses are never passed to
live mode. `tool.integration.ts` runs real native and custom MCP operations,
accepted failing measurements, forbidden revision effects and a deliberately
lost command response followed by evidence-backed recovery. These are protocol
and controller controls, not measurements of LLM repair competence.

Run from this example directory with `MAS_HOST_BIN` and `MAS_SDK_ROOT` pointing
to the built pinned checkout:

```sh
npm run test:host
```

## Recover a lost native tool response

From the example directory, recover one exact retained native operation:

```sh
node --import tsx scripts/reconcile.ts \
  --output .state/run --incident local-self-remediation \
  --run local-self-remediation.baseline.check \
  --operation local-self-remediation.baseline.check
```

Set `MAS_HOST_BIN` and `MAS_SDK_ROOT` to the original pinned host. The command
requires the original controller directory and its SQLite journals. It matches
incident, run, operation and admitted invocation identities, verifies the frozen
context, runtime, schemas and result artefact, then reads a **completed** receipt
from `tool-effects.sqlite`. It records immutable proof files under
`reconciliation/<run>/<invocation>/` and resolves only that host effect. The pinned
command adapter revalidates the original output schema during cached replay.
The next controller restart consumes that same receipt and preserves its measured
`passed`, `failed` or `inconclusive` status. A completed failing check can therefore
supply a counterexample for another repair attempt.

A dispatched operation without a completed native receipt remains `unknown_effect`.
The utility cannot reconstruct a missing response or turn transport loss into a
failed check. Publisher, branch, PR, merge and deployment effects require their
own external-evidence reconciliation adapters. No generic `--receipt` override is
accepted. Cancellation and the original host deadline remain effective after an
outcome is recovered, and the command reports whether its original request could
complete. It never extends a budget or creates another effect invocation.

`reconcileNativeReceipt(options)` is also exported for automatic startup recovery.
The caller supplies the original `directory`, `incidentId`, `runId`, `operationId`
and host configuration. A missing completed receipt raises
`UnresolvedNativeEffect`; callers must keep that operation blocking.
