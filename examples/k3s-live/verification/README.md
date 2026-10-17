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

The runner compiles each generated verifier with `-O0`. The current finite
suite spends more time compiling than searching. Use
`--compile-optimisation 2` to compare an optimised verifier when model bounds
grow. Both choices use the same assertions, state storage and search options.

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
generated `pan.*` C verifier sources and replay trail. A single writer creates
the archive. Before reporting `PASS`, the runner verifies every archived member
against its recorded source bytes and checks the complete member set. Build binaries stay in
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
| `patch_applied`, `patch_acknowledged`, `effects` | Actual API effect and its separately successful response. A lost response leaves `effectOutcome: unknown`; the tool does not retry. One call site in one invocation does not establish restart/retry or exactly-once semantics. |
| `effect_outcome`, `verification_outcome` | Independent report axes: effect `not_started/rejected/applied/unknown`, verification `not_run/passed/failed/inconclusive`. A known failed postcondition and unavailable evidence have distinct outcomes. |
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
`PatchUncertain` and `RecoveryFailed` retain the existing overall `failed` status,
while resolution version 2 additionally distinguishes the effect and verification
axes. The model checks that an `applied` claim requires an acknowledged effect
and that a passed verification requires complete positive recovery evidence.
An overall failed report therefore supplies no guarantee that the patch had no
effect. A lost response can leave an unknown effect even when the API rejected
the operation without applying it.

One bundle, proposal, Deployment, invocation and report publication are modelled.
Recovery flags abstract the final bounded poll results, not elapsed time.
Crashes, restarts, retries, persistent replay, unbounded competing writers and
cluster or transport implementation correctness are outside the model.

Safety and progress searches each run with and without partial-order reduction.
Isolated mutations remove the UID guard family, ignore the resourceVersion test,
declare verification before recovery, publish an unauthenticated report, or
misreport an uncertain effect as acknowledged application.
Each must yield its intended replayable assertion counterexample. A stalled
external API supplies the expected progress counterexample. A deliberately
false assertions witness reachable fully verified recovery and an actually
applied effect whose lost response retains unknown attribution. These controls
test the harness and the stated abstractions; their failures are not defects
in the unmodified model. Raw commands, search output and trails remain in the
same `evidence/` directory as the choreography evidence.

For an unsuccessful verification the model nondeterministically selects observed
postcondition failure or inconclusive evidence. This overapproximates the
adapter's distinction: complete negative observations justify `failed`, while
unavailable or incomplete observations justify `inconclusive`. Correct evidence
classification is an adapter assumption supported by executable tests.

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
either outcome. All choreography, tool, controller and revision checks use the same
runner, resource limits and retained evidence format above.

`remediator/controller.test.ts` exercises the controller's actual admission,
CAS competition, restart/lost-response handling and stable report retries;
`remediator/transport.test.ts` checks its in-cluster HTTP transport.
`deploy/remediation.test.mjs` tests that the shared executor awaits `beforePatch`
and produces no workload PATCH when reservation fails. The summary records
reviewed implementation/test/schema hashes. Correspondence is reviewed
manually, and the model does not derive correctness from those hashes.

## Generic operation and append-only observation contract

`deploy/guarded-operation.mjs` separates durable reservation, acknowledged effect
execution and postcondition verification. Kubernetes admission and guarded PATCH
construction remain in the readiness adapter. The helper is also exercised
through a distinct key-value adapter in `guarded-operation.test.mjs`.

The upstream [operation-outcome model and contract](https://github.com/emmett08/mas/blob/main/formal/operation-outcomes-notes.md)
checks the generic lifecycle with original-owner dispatch permission, response
loss, recovery and a delayed original effect after an unknown report. Its two
concurrent observation writers compare the retained revision before appending
and check exact replay, changed-content rejection, immutable history and report
binding. It models two observation slots; this application retains up to eight.
The upstream model is reproduced by its own repository's `verify
--operations-only` command and has no dependency on a sibling checkout.

The controller appends observations to an already Finished journal while retaining
its original `reportJson`, operation/attempt identity and target binding.
`shared/resolution.ts` and server tests check the report digest, target UID,
original template and append-only history. A `desired` snapshot describes a
resource at observation time. It neither proves the original attempt caused
that state nor prevents an already-reserved delayed owner from acting later.
The original `unknown` effect therefore remains unknown. New observations do not
grant another execution reservation.

The local `controller.pml` continues to abstract the immutable terminal report
into Verified/Failed/Uncertain for reservation and outbox properties. The expanded
local `remediation.pml` checks the two outcome axes. The upstream generic model
checks appended observation semantics; actual TypeScript tests provide separate
implementation evidence. None of these models establishes a refinement proof
for the complete deployed system.

## Assessment selection and remediation admission

`revision.pml` checks the example's boundary between an assessed candidate,
its selected output and the existing remediation controller. It enumerates two
candidates, at most one revision, two assessments and one optional controller
effect. A revision consumes feedback tied to its parent. Cancellation and a
blocked effect produce no controller authority. Exhaustion retains a selected
candidate but cannot pass the completed-run admission condition. A completed
internal assessment still requires the independent remediation preconditions.

Four complete safety/liveness searches cover partial-order reduction both enabled
and disabled. Injected selection mismatch and exhausted-run authority faults must
produce their targeted counterexamples. A separate false assertion witnesses a
passing revision followed by independently admitted remediation. With the original
35 checks, this assessment extension brought the suite to 42 cases. The MCP
acquisition extension below now adds 20 cases, bringing the current total to 62.

`server/host.integration.ts` executes the real Rust host with a deliberately
unsupported fixture citation, checks exact candidate/feedback references, verifies
that the independent evaluator receives no earlier assessment, and reopens a
completed journal after simulating loss of the API's final persistence step.
`server/runs.test.ts` checks that exhausted assessment output cannot enter the
remediation reporting path. `ui/revision.test.ts` checks exact references, immutable
history, disclosure omission, numeric precision and playback visibility.

Identity/hash comparison and remediation admission are abstract predicates in
this local model. The MAS contract and host repositories carry separate Promela
models for assessment authority, immutable identity, budgets and disclosure.
Neither these models nor internal deterministic criteria establish that feedback
improves diagnosis correctness; that requires the separately frozen incident
experiment and independent outcome measurements.


## Verification timing

An interleaved comparison on 17 October 2026 used the complete 42-case suite
at revision `f086e3e51d4c18c2ff851a00b70422bdbfd8aa50`, GCC 13.3.0,
SPIN 6.5.2 and Python 3.12.14 on Ubuntu 24.04.3, x86-64. Each invocation
compiled into fresh temporary directories. The run order was `-O2`, `-O0`,
`-O0`, `-O2`.

| Compiler option | Whole-suite times (s) | Median (s) | Compilation times (s) |
| --- | --- | --- | --- |
| `-O2` | 74.24, 66.42 | 70.33 | 67.96, 59.05 |
| `-O0` | 27.02, 26.65 | 26.83 | 15.31, 13.43 |

The local median fell by **43.50 seconds, or 61.85%**. All 42 result
classifications and stored-state/error counts matched. The 26 counterexample
trails were byte-identical. The largest reported verifier memory use remained
164.091 MiB. The 16 positive checks completed their searches, and all
26 expected counterexamples replayed. Faster compilation outweighed the
additional search time for these models.

The [timing record](evidence/performance.json) contains the individual
measurements, source hashes, CI step timings and action-runtime references.
These local measurements cover compilation, searches and evidence writing.
GitHub job measurements also include package installation and runner overhead.
Recheck the trade-off after increasing the model bounds.

Run the same comparison into a new directory:

```sh
python3 examples/k3s-live/verification/benchmark.py --out /tmp/mas-spin-timing
```

The script retains each run's complete evidence and `benchmark.json`, then
requires equal sources, bounds, outcomes, state/error counts and replay trails.
It leaves the published `evidence/` files intact.

## MCP-directed evidence acquisition

`investigation.pml` checks the new acquisition phase composed with the existing
assessed workflow. An investigating LLM chooses the order of four required tool
actors. The configured host policy admits only outstanding required actors until
coverage is complete. This model independently checks the application freezer:
it also permits partial or repeated-actor histories, as might be retained from
an earlier host, and requires them to fail before assessment. Each invocation
passes through the host's existing delegation and
operation records before its command adapter makes one MCP `tools/call`. The
custom Kubernetes tools remain application code; this model introduces no
Nehemiah message or delivery rule.

The acquisition and assessed phases use distinct retained host state directories
under one admitted application Run. `Runs.acquire` invokes
`Host.runInvestigation`, then `freezeInvestigation` validates retained command
results; `Runs.execute` starts assessment only after that bundle is persisted.
`retainFile` requires exact bytes when reopening context or assessed input, and
`Runs.persist` serialises manifest updates so a cancellation record follows any
earlier phase write. The admitted approach, incident subject and
trusted MCP context remain fixed. Trusted application code extracts completed
command results and freezes the evidence supplied to assessment. Model-generated
summaries cannot supply additional evidence items. The model represents subject
identity, approved tool identity, valid result shape, consistent evidence and
at least one collected observation by one conjunctive `all_trusted` predicate;
implementation tests must exercise the individual checks. A separate bitset records distinct tool actors, so four
invocations of one actor cannot satisfy four required actors. A valid unavailable
observation counts as a completed acquisition attempt. It grants no useful
evidence or remediation permission; those predicates are checked separately.

| Property | Abstract transition and implementation obligation |
| --- | --- |
| Frozen evidence before assessment | `Frozen → Assessing` requires `frozen_version == 1`, trusted evidence, complete required-actor coverage and no unknown operation. The frozen incident must be persisted before launching the assessed host. |
| Complete distinct coverage | `Acquired → Frozen` requires `covered == ALL_REQUIRED`. Partial histories and four calls containing a repeated actor are blocked independently of host schema enforcement. |
| Recorded calls never replay | Each of four invocation identities has `calls[slot] <= 1`. The host's retained per-operation record supplies the result after restart. A later newly admitted call is a different identity. |
| Unknown acquisition cannot complete | A reserved or invoked operation without a retained response becomes `Uncertain` on restart and moves to `Blocked`; `Acquired` asserts that no unknown operation exists. |
| Exact incident and tool binding | `all_trusted == false` prevents freezing. A mismatched Pod UID, unexpected command/tool identity, invalid result or conflicting evidence must fail the corresponding trusted-code checks. |
| Cancellation prevents a later launch | A separate cancellation process can run between every persisted phase transition. Tool invocation and assessment launch check cancellation at their synchronous admission boundary. Cancellation does not undo an earlier external request. |
| Frozen context survives restart | `frozen_version <= 1`; restarting after freezing retains the original bytes rather than collecting a replacement bundle. |
| Finite settlement | `investigation_settles` requires completion, blocking or cancellation under finite responses and at most two restarts. |

Reservation, external invocation, retained response, acquisition completion,
evidence freezing and assessment launch are separate transitions. Only the
synchronous cancellation/dispatch decision, one abstract durable record update,
or host recovery of retained records is atomic. In particular, an external
request and its response are never collapsed into one atomic action. An
interrupted reservation becomes uncertain even if the external request had not
yet started: absence of a recorded response supplies no permission to repeat it.
Application cancellation stops later phase dispatch immediately at its local
admission check. Tool admission stops when the host observes its cancellation
record. The model's cancellation event denotes that admission boundary; it does
not claim instantaneous propagation of a shutdown signal to another process.
Already-admitted operations may settle after cancellation.

The model has one orchestrator owner, one immutable Run, four sequential delegate
invocation identities, four required actor identities, at most two restarts, one
cancellation, one frozen bundle and one assessed-phase start. Each invocation
can name any actor, allowing all tool orders and repeated targets to be checked. Host inference, individual MCP exchanges, queue
behaviour and the subsequent candidate/revision loop are outside this model;
`revision.pml` covers the latter. Retention of the original host admission,
configuration, deadline and operation identities is an implementation assumption.
No elapsed-time, distributed-owner, storage-loss, unrestricted exactly-once or
implementation-refinement claim follows from these checks. Tool calls are
read-only Kubernetes observations, so counting invocations does not count
workload mutations.

Safety and settlement run with and without partial-order reduction. Eight
isolated mutations admit assessment before freezing, repeat a recorded call,
complete an uncertain acquisition, accept untrusted evidence, accept partial
coverage, count repeated actors as complete coverage, launch after cancellation,
or replace a frozen bundle. Each must produce its intended replayable assertion
counterexample. A separate stalled-provider mutation must produce a liveness
counterexample. Seven deliberately false assertions witness complete coverage,
reverse tool order, a valid unavailable observation, blocked partial coverage,
blocked duplicate-actor coverage, successful recovery after both a recorded
result and a frozen bundle, and an invoked operation whose outcome remains
uncertain. The two useful restart boundaries are distinct; the recovery witness
cannot be satisfied merely by restarting before any work begins.

`server/investigation.test.ts` exercises evidence source/subject checks,
conflicting observations, retained input and shutdown/restart gates.
`server/investigation.integration.ts` exercises the real host and MCP bridge with
a deterministic provider fixture. `mcp/client.test.ts` and `mcp/tools.test.ts`
cover MCP transport and incident-scoped Kubernetes collection. Fixture execution
does not establish live LLM behaviour or a live-cluster result.

The full suite contains 20 positive searches and 42 expected counterexamples,
including the coverage controls and reachability witnesses. SPIN 6.5.1 was available from
a retained local installation for this change; `evidence/summary.json` records
the exact checker/compiler and reviewed-source hashes for each retained run.
The maintained verifier and atomic-transition documentation was checked on
17 October 2026. The model's successful finite searches establish the named
properties only within the boundary above; application and adapter tests provide
separate implementation evidence.
