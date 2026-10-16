# Finite hybrid choreography check

This example uses the existing MAS version 1 `Request`, `Result` and `Failure`
messages. It adds no protocol syntax, message kind or delivery rule. The browser
observes stored evidence; it does not receive or acknowledge agent messages.

`hybrid.pml` checks the application's bounded request choreography. The slots
represent eight distinct invocations, including two invocations of the same
security reviewer. Actor identity and task identity are separate.

| Slot | Request | Required predecessor |
| --- | --- | --- |
| 0 | Client → coordinator | Start |
| 1 | Coordinator → platform | Coordinator received slot 0 |
| 2 | Coordinator → security | Coordinator received slot 0 |
| 3 | Platform → diagnose | Platform received slot 1 |
| 4 | Platform → security | Diagnose completed successfully |
| 5 | Security → security review | Security received slot 2 |
| 6 | Security → security review | Security received slot 4 |
| 7 | Coordinator → decision | Slots 1 and 2 completed successfully |

The model explores each ordering of the enabled abstract transitions. A durable
slot remains present after receipt, as in the local SQLite bus. Its scheduler
chooses the next send, receive, terminal or observation transition. This is an
interleaving model of the choreography, not a simulation of LLM internals.

| Property | Check |
| --- | --- |
| Permitted routing | Every request and reversed reply uses a declared directed edge. |
| Correlation | A terminal follows receipt of the same request identity and replies to that identity. |
| Unique invocation | Each of the eight invocation identities is dispatched at most once. |
| Join before decision | Decision is admitted only after both coordinator branches succeed. |
| Successful completion | Coordinator success requires both branch successes and decision success. |
| Observation isolation | Up to two repeated reads leave the dispatch counter unchanged. |
| Finite settlement | The root eventually becomes terminal under the finite response assumptions. |

The observer assertion expresses the intended read-only design. The host's
read-only SQLite tests supply implementation evidence. The model does not
prove that a different observer implementation is read-only.

Each LLM leaf can return a valid result or a known failure. A failed diagnose
prevents the lateral critique; a failed branch prevents the decision. Parallel
branches settle before the root reports failure. No transition in `hybrid.pml`
operates on a Kubernetes resource. The separate `remediation.pml` model below
checks admission and outcome handling for the external recording tool.

Positive progress checks assume finite known leaf responses, no crashes, no
cancellation, no expiry and no provider stall. The model uses seven actors,
eight request identities, one run and at most two observer reads. It excludes
mailbox pressure, redelivery, storage failures, elapsed time and deployment
behaviour. It does not verify an LLM conclusion, infer exactly-once provider
effects, or establish refinement of the Rust and SQLite implementation.

The upstream [MAS formal suite](https://github.com/emmett08/mas/tree/main/formal)
separately models transport, task correlation, transaction recovery and workflow
composition. Its assumptions and evidence apply to those models. This small
application check supplements that suite.

## Reproduce

Install SPIN, a C compiler and Python 3. On an Ubuntu runner:

```sh
sudo apt-get update
sudo apt-get install -y spin build-essential
python3 examples/k3s-live/verification/verify.py
```

The runner gives each command 30 seconds, 512 MiB of address space and a search
depth of 100,000. It uses full state storage, checks assertions and invalid end
states, checks the inline settlement LTL claim separately, and repeats positive
checks without partial-order reduction. It requests no process fairness. Every
positive transition consumes finite remaining work, so the positive model has
no unrelated infinite branch.

Five isolated mutations deliberately introduce a forbidden route, a reply to
the wrong request, premature decision admission, an observer dispatch and an
indefinitely stalled provider. Their expected counterexamples are replayed.
A sixth deliberately false assertion witnesses reachable successful completion.
An expected counterexample is a successful harness check; its violated property
does not hold for that mutation. The provider-stall counterexample demonstrates
the limit of the positive progress assumption.

`evidence/summary.json` records model, runner and reviewed application-file
hashes, installed tool versions, bounds and results. Those application hashes
identify the configurations compared during review; the runner does not derive
the Promela model automatically from the YAML. `evidence/commands.json` retains command arguments and raw output;
the `.trail` files retain the counterexamples. `counterexamples.zip` preserves
each exact counterexample model, macro/compilation/search configuration,
generated `pan.*` C verifier sources and replay trail. Build binaries stay in
isolated temporary directories. Use `--out DIRECTORY` to retain
another run separately. A missing checker, exceeded resource limit, unexpected
counterexample or missing expected counterexample exits non-zero.

SPIN command semantics follow the maintained [SPIN](https://spinroot.com/spin/Man/Spin.html),
[verifier](https://spinroot.com/spin/Man/Pan.html) and
[inline LTL](https://spinroot.com/spin/Man/ltl.html) manuals, consulted on
16 October 2026. The recorded tool is SPIN 6.5.2, the Ubuntu package available
in this execution environment.

## Bounded external remediation

`remediation.pml` models one invocation of the deterministic external tool in
`deploy/remediation.mjs`, after the existing MAS workflow has returned its
structured proposal. It changes no MAS wire syntax, message kind, envelope
count or delivery rule. The LLM proposes an action; the tool compares the
proposal and collected evidence against a fixed policy before applying one
JSON Patch. The model neither interprets logs nor establishes that the diagnosis
is correct.

The only permitted action targets namespace `mas-demo`, Deployment
`mas-demo-checkout`, container `checkout`, and changes the readiness HTTP path
from `/readyz` to `/healthz`. The evidence bundle's collected items and cited
identifiers, target UID, namespace identity, managed label, unchanged full
workload-template hash and current probe values must satisfy the tool's
admission checks. Kubernetes applies the patch only if its atomic UID,
resourceVersion, container-name and old-path tests pass. Reading the live
Deployment and applying the patch are separate operations; a stale version,
deletion or replacement can reject the effect between them.

| Model predicate/action | Implementation correspondence |
| --- | --- |
| `evidence_valid` | `validatePracticalEvidence`: required collected items, subject and owner identities, failed readiness/Warning and fresh measured CPU/memory; `admitReadinessPatch`: cited collected IDs and actual log records for `/readyz` 404 and `/healthz` 200. This models those comparisons, not the truth of arbitrary log content or diagnosis. |
| `proposal_allowed` | `requires_human === false`, admitted action and exact namespace/name/container/path proposal. `remediation_enabled` separately represents explicit enablement. |
| `target_preconditions` | Recorder namespace UID, live managed Deployment UID, full recorded template hash and current readiness/liveness paths. |
| `patch_identity` and `resource_version_matches` | Atomic Kubernetes JSON Patch UID/resourceVersion tests, alongside container-name and old-path tests. The Boolean API outcome also permits an unrelated API error. |
| `patch_applied`, `patch_acknowledged`, `effects` | Actual API effect and its separately successful response. A lost response can leave an applied effect with a failed report; the tool does not retry. One call site in one invocation does not establish restart/retry or exactly-once semantics. |
| `generation_observed`, `rollout_ready` | `recovered`: observed generation and exactly one updated, Ready and available replica with no old replicas. |
| `recovery_identity_matches`, `replacement_pod_ready` | Verification checks for unchanged patched Deployment identity/template and an actual Ready replacement Pod owned through the ReplicaSet by that Deployment. |
| `endpoint_200_body` | Successful Kubernetes Service API proxy response with the expected application body. |
| `fresh_metrics` | Actual replacement-Pod CPU/memory measurement with matching identity and a sufficiently recent timestamp after Pod creation. |
| `report_authenticated` | Server acceptance of the external verifier credential before a resolution report is published. The model does not establish credential secrecy or HTTP authentication implementation correctness. |

The positive safety checks require that every applied patch has valid evidence,
policy and identity preconditions; a stale resourceVersion never applies; one
invocation applies at most one effect; and only an acknowledged applied patch
with every observed recovery predicate can become `Verified`. An unauthenticated
report cannot publish a resolution. The environment nondeterministically chooses
missing evidence, unsupported proposals, UID/template mismatch, deletion,
replacement, resourceVersion races, patch failure, lost patch responses and
every combination of partial recovery. A partial rollout, missing metrics or
failed endpoint is a failure outcome, even when the patch was applied.

`remediation_settles` requires an explicit terminal outcome. Each API operation
and the recovery poll must return or reach a finite failure deadline. There is
no fairness option and no unrelated infinite branch in the positive model.
The property permits rejection, failure and an uncertain effect outcome; it
does not promise that every proposal restores the application. `PatchFailed`,
`PatchUncertain` and `RecoveryFailed` distinguish model paths that all produce
the implementation's `failed` report status. A failed report therefore supplies
no guarantee that the patch had no effect.

One bundle, proposal, Deployment, invocation and report publication are modelled.
Recovery flags abstract the final bounded poll results, not elapsed time.
Crashes, restarts, retries, persistent replay, unbounded competing writers and
cluster or transport implementation correctness are outside the model.

Safety and progress searches each run with and without partial-order reduction.
Isolated mutations remove the UID guard family, ignore the resourceVersion test,
declare verification before recovery, or publish an unauthenticated report.
Each must yield its intended replayable assertion counterexample. A stalled
external API supplies the expected progress counterexample. A deliberately
false assertion witnesses reachable fully verified recovery. These controls
test the harness and the stated abstractions; their failures are not defects
in the unmodified model. Raw commands, search output and trails remain in the
same `evidence/` directory as the choreography evidence.

`deploy/remediation.test.mjs` exercises the actual tool's admission and recovery
checks using Kubernetes API fixtures. `server/runs.test.ts` checks authenticated
resolution publication and rejection of invalid reports. The reviewed source
hashes identify those tests and implementations. This correspondence is reviewed
manually; the runner does not derive the model from JavaScript and establishes
no formal refinement proof.
