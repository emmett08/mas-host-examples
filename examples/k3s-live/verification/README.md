# Finite MAS choreography and remediation checks

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


## Durable remediation controller

`controller.pml` supplements the single-invocation tool model with the dedicated
`remediator/controller.ts` reconciliation protocol. MAS still uses version 1 and
the same eight Request/Result pairs. The new Kubernetes journal and controller
are application mechanisms; they add no MAS delivery semantics.

The model contains two concurrent worker boot identities, two possible source
Run UIDs, one retained fault journal and at most two publication attempts. The
journal key abstracts the SHA-256-derived namespace UID, Deployment UID,
original full Pod-template hash and policy version. Distinct Events and source
Run UIDs for the same fault share that key. The immutable journal specification
binds the original source Run UID/backend ID, namespace/target identities,
template hash and evidence hash. A later investigation for the same fault
cannot substitute its identity or gain a second effect reservation.

The shared executor performs its existing evidence, proposal and live-resource
admission before invoking `beforePatch`. That hook lazily creates the journal
and then reserves `Pending → Applying` with Kubernetes resourceVersion CAS.
Create conflict, a lost create acknowledgement, claim conflict and a lost claim acknowledgement grant no
permission to patch in that reconciliation. A later pass can re-admit a retained
`Pending` journal, but `Applying` never returns to `Pending` and never authorises
a replacement attempt. Observing the original owner ID after a lost response is
also insufficient: only the original successful claim response grants effect
authority. A journal is a retained tombstone even if the application is later
rolled back to its original template.

| Named assertion or claim | Meaning and implementation correspondence |
| --- | --- |
| `SOURCE_AND_ENABLEMENT_BOUND`, `FRESH_EVIDENCE_BEFORE_EFFECT` | Explicit enablement and `binding`/`assertFresh` bind the completed backend run to the exact Succeeded Kubernetes investigation, immutable Event/evidence and age limit. Freshness is the check result, not a real-time guarantee during subsequent API calls. |
| `ACKNOWLEDGED_ORIGINAL_RESERVATION` | `beforePatch` obtains an acknowledged `casStatus` transition before the shared executor calls the workload PATCH. The hook records its exact admitted pre-patch report with owner boot/Pod identity and rechecks freshness after the claim response. |
| `EFFECT_BINDS_IMMUTABLE_SOURCE_RUN` | The retained journal specification must exactly match the original source, evidence and target; a different investigation sharing the fault key stops without another effect. |
| `ONE_EFFECT_PER_RETAINED_FAULT_JOURNAL` | Two competing workers can produce at most one workload effect while that journal is retained. The model separates the atomic guarded PATCH, actual effect and response acknowledgement. |
| `FIRST_TERMINAL_WINS` | `finish` uses status CAS; a competing terminal, lost status response or expired owner causes a reread of the retained terminal rather than an overwrite with a local report. |
| `IMMUTABLE_DURABLE_REPORT` | Mutation-bearing reports publish only after `Finished` stores canonical report bytes. Repeated outbox publication uses that exact report and its original source backend ID. |
| Verified-report assertions | A published verified result requires the original acknowledged reservation, its actual effect, acknowledged PATCH and complete observed recovery. Expiry or an owner crash produces uncertainty/failure rather than verification. |
| `controller_settles` | Under finite-return/deadline assumptions, the two worker attempts, reservation recovery and two publication attempts finish; no journal remains `Applying`. This permits failed POSTs and a retained `Pending` journal awaiting a later poll; it does not promise successful delivery or application recovery. |

Only create CAS, status CAS and guarded workload PATCH are atomic. Reading state,
claim acknowledgement, applying the effect, receiving the PATCH response,
checking recovery, committing `Finished` and posting its report are separate
steps. A worker can crash before the effect, after the effect, after the PATCH
response or after observing recovery. A committed `Finished` response can also
be lost; the outbox reads the persisted report instead. The acknowledgement
choices abstract the common durable-reread outcome, rather than modelling
transport retry timing.

The recovery process can close `Applying` as uncertain when its owner is known
to have stopped or its finite reservation deadline has elapsed. A delayed live
owner may still execute its one already-reserved patch after that terminal
write. Its later terminal CAS loses, so it cannot replace uncertainty with a
verified local report. Retrying report publication never calls the executor or
re-applies the patch. A failed or uncertain report therefore does not imply
that the workload remained unchanged.

Admission guards are represented by their conjunctive acceptance class and
each individual rejection class. Multiple failed guards cannot introduce an
effect. Recovery is represented by the conjunction of the predicates enumerated
individually in `remediation.pml`: exact identity/owner chain and template,
observed generation and completed rollout, Ready replacement Pod without
restarts, expected Service HTTP response, and fresh replacement-Pod metrics.
Pure preflight/no-action returns have no mutation, create no journal, publish
no resolution and are outside the durable effect-outbox model.

The positive model includes no journal deletion, Kubernetes storage loss,
forged credentials, SHA-256 collision, arbitrary administrator edits or
unbounded fresh process failures. API operations must return or fail within
their deadlines, and a surviving reconciliation/outbox process must perform
the finite recovery work. The model does not establish wall-clock deadlines,
cryptographic security, unrestricted exactly-once execution, high availability,
or a refinement proof of TypeScript and Kubernetes. The deployment remains one
controller replica; the two-worker model challenges its CAS behaviour during
accidental overlap or replacement.

Safety and settlement each run with and without partial-order reduction. Seven
controls continue after a lost create acknowledgement, bypass the claim CAS, resume `Applying`, publish before durable
`Finished`, bypass source binding, accept stale evidence, or indefinitely stall
reservation recovery. Each must yield its intended replayable counterexample.
Two further deliberately false assertions witness durable verified recovery
and an actual effect followed by an uncertain retained terminal. The witnesses
show those paths are reachable; they do not claim that every incident reaches
either outcome. All 33 choreography, tool and controller checks use the same
runner, resource limits and retained evidence format above.

`remediator/controller.test.ts` exercises the controller's actual admission,
CAS competition, restart/lost-response handling and stable report retries;
`remediator/transport.test.ts` checks its in-cluster HTTP transport.
`deploy/remediation.test.mjs` tests that the shared executor awaits `beforePatch`
and produces no workload PATCH when reservation fails. The summary records
reviewed implementation/test/schema hashes. Correspondence is reviewed
manually, and the model does not derive correctness from those hashes.
