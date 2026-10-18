# Validation record

Observed locally on **18 October 2026**, against the implementation prepared for this PR. The repository baseline was `7a0b5f37d7a28ee7a676ecc9d12154361c9f2fb0`; the pinned host remained `8df16b640b78999b5eba60d83f2695f29052aaa2`. This record describes local evidence. The automatic PR workflow separately binds its results to the published PR commit.

## Executed checks

| Check | Observed result | Scope |
|---|---|---|
| `npm run build` in `examples/self-remediation` | **Passed** | Controller/server TypeScript, Vue type-check, production Vue bundle, portable observer and trusted tool bundles |
| `npm test` in `examples/self-remediation` | **79 passed, 0 skipped, 0 failed** | Full suite with the explicit browser opt-in and available Chromium, including the combined-replay control |
| Separate `tests/observer-browser.test.ts` run | **1 passed** | Actual Chromium browser, live SSE updates before completion, desktop/mobile layout, escaped before/after source disclosure and offline playback without future-result leakage |
| `npm run test:host` with the exact pinned host | **8 passed** | Actual maintained host, native/command/custom MCP paths, compiled topology, delegation, replay, accepted failed measurements and unknown-response recovery controls |
| `verification/verify.py` | **30/30 SPIN checks passed** | Finite safety models, checks without partial-order reduction, guard-removal counterexamples and selected reachability controls |
| Existing `examples/k3s-live` unit suite | **212 passed** | Regression checks for the preserved existing example |
| Existing `examples/k3s-live` build | **Passed** | Preserved example's TypeScript/Vue build |
| `actionlint` for the new workflow | **Passed** | Workflow syntax and static expression checks |
| Offline archive smoke check | **Passed** | Built Vue, styles and committed event data embedded into one HTML document, with the portable observer also packaged |

The combined-replay control verifies original job incident/sequence/type/hash provenance, retained gaps, redaction, publication versus deployed recovery, and no future outcomes while seeking. The combiner reads only explicitly supplied journal paths and never executes retained candidate code.

The browser was run using an available executable through `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. The initial default Playwright download returned an invalid archive. The subsequent explicit Chromium run passed, and its desktop and mobile screenshots were visually inspected. The mobile graph uses a narrow coordinate layout, and the journal table scrolls inside its card. The graph remains immediately below stable live/playback controls. No document-width overflow was observed at the tested mobile viewport.

The unit suite includes eleven pure controller-loop controls and separate deployment restart controls. They demonstrate a failed candidate followed by a new investigation and useful revision, independent review rejection followed by continued repair, final-check disclosure followed by a fresh final suite, stale source/build rejection, cancellation before publication, incomplete baseline evidence, exact-phase recovery without double charging and aggregate workflow-budget persistence and source repair after an observed baseline build failure. Deployment controls separately retain original mutation preconditions across interruption and establish the first trial from a verified candidate when no runnable baseline image exists. These scripted ports test controller behaviour. They are not provider repair measurements.

The SPIN report includes model, checker-runner and corresponding implementation hashes. Original models pass and deliberate guard removals reach their specified assertions. This provides finite control-safety evidence and an implementation correspondence argument. It does not establish a machine-checked refinement proof, complete tests, unbounded liveness or arbitrary generated-code correctness.

## First automatic PR integration observation

[PR run 39115856935](https://github.com/emmett08/mas-host-examples/actions/runs/39115856935), at head `42c52ac6a17ff42d462a55310423fa0358db567d`, passed the host, browser, formal, Docker image and k3s setup checks. Real isolated baseline checks observed ten passing criteria and the intended missing-route failure. The controller then stopped at its phase-input size boundary; it did **not** recover the trial. Diagnostics and a complete failure replay were retained. An immutable checkpoint upload was acknowledged while the controller was running.

That evidence led to three follow-up fixes: repeated passing-check explanations now use the retained complete-input reference without dropping any criterion; image defaults are explicitly set and verified against the independently exercised command; and checkpoint objects are deduplicated while retaining executable permission modes. Regression controls cover the actual failed input, the subsequent rejected-candidate/revision/review inputs, the image configuration mismatch, 144 MiB of logical checkpoint paths sharing less than 49 MiB of objects, and rejection when distinct objects exceed 128 MiB. The test and repeated host/formal results above include those fixes. Subsequent automatic CI results are bound to the PR head and reported separately; this initial failed run is not recovery evidence.

The second [automatic run 39117138156](https://github.com/emmett08/mas-host-examples/actions/runs/39117138156), at head `50f1eeaafccfe0752b27892bb1e1d86abb4c570b`, observed the intended baseline failure, rejected the first candidate for two regressions, generated a useful revision, passed all eleven development and eleven fresh final criteria, and imported the immutable candidate image. It then stopped with `unknown_effect` during Kubernetes replacement; it did not claim recovery. Retained Kubernetes data omitted the empty environment field, exposing a JSON Patch `replace` on an absent member. The following fix uses the object-member `add` operation while preserving every atomic target precondition. Regression controls cover API normalization, stale rejection and exact lost-response reconciliation. All 79 local tests and 30 formal checks pass after that fix. This second run also acknowledged four immutable checkpoint uploads (two before controller completion), with ten local cuts and no snapshot failures. A verified during-run cut retained 819,620,312 logical bytes as 61,103,523 distinct object bytes.

## External acceptance gates not executed locally

| Gate | Status and missing evidence |
|---|---|
| Original operational cluster trigger → Pod/release → image/configuration → source binding | **Unexecuted remotely:** needs an exact owner-supplied target grant and scoped source-cluster read credential; local identity/precondition controls passed |
| Container build and candidate execution in the real constrained sandbox | **Unexecuted locally:** usable Docker infrastructure was unavailable in this work session |
| Baseline failure → generated source change → protected checks → immutable image → real isolated k3s recovery | **Unexecuted locally:** requires the Docker/k3s integration environment. Host/tool/control tests do not substitute for this path |
| Official GitHub MCP metadata call | **Unexecuted remotely:** requires the runtime read credential and frozen admitted official schema. Local MCP transport/schema/projection controls passed |
| Live-provider patch generation and revision | **Unexecuted:** no paid/live workflow was authorised or dispatched in this session |
| Real nonempty GitHub repair PR against an injected faulty branch | **Unexecuted:** requires the separately scoped runtime publication credential and retained verified candidate. Transport controls verify the intended semantics locally |
| Real Check Run progress observed in a browser before the live workflow finishes | **Unexecuted remotely:** the local browser control passed, while a running GitHub workflow and its progress Check Run remain required |
| Automatic scoped merge and post-merge deployed recovery | **Unexecuted remotely:** requires an explicitly disposable target, configured trusted checks, App credentials and the separate promotion environment |

No paid/live workflow, demonstration merge or production promotion was dispatched as part of local validation. The implementation PR is separate from the repair PR that a future admitted demonstration may publish.

## Current boundaries

- Application source and `config.json` can change within the admitted projection. The build/execution interface fixes the Node standard-library environment and constrained container grants. Shared persistent-data writes, schema migrations and arbitrary dependencies remain outside the example.
- A completed baseline build failure is retained as failed evidence, while HTTP checks that could not execute remain inconclusive. Source repair can proceed without inventing a baseline Pod, and the first eligible candidate establishes the isolated trial. Local controller/deployment controls cover this route. Actual container execution and end-to-end recovery remain among the unexecuted Docker/k3s gates above.
- Operational configuration checks the exact source commit and performs scoped read-only binding of the original trigger, Deployment, Pod ownership, image and declared configuration. Local fake Kubernetes transports exercise those identity and staleness controls. An actual original-cluster observation is unexecuted locally. Source annotations remain assertions of the configured build/deploy interface and need supporting build provenance. Trials run in a separate disposable cluster; the supplied CLI does not promote into the original operational deployment.
- Candidate verification samples stated behaviours using protected checks. Capability/resource deltas concern enforced execution grants and limits, rather than a complete semantic analysis of generated source.
- A Check Run contains a bounded redacted event window. Delayed or late observers may see explicit gaps. Full disclosed candidate payloads are retained in the archive; the GitHub-only live transport may expose references rather than full source. In the supplied demo workflow the original Check Run closes after controller/trial work. Separate publication and promotion jobs contribute to a combined offline archive; their later outcomes are not streamed through that earlier Check Run.
- Provider expenditure is bounded by persistent configured reservations. Billed cost still requires retained provider usage and the applicable verified price schedule. The workflow's per-call reservation must be checked for the selected model and token limits.
- GitHub supplies an atomic expected-head merge parameter but no atomic expected-base parameter. A changed post-merge tree blocks promotion and requires renewed build/verification evidence.
- Process restart assumes surviving durable journal, host and artefact state. Runner/cluster loss requires checkpoint restoration and reconciliation of surviving external resources. A missing external resource alone does not establish that an uncertain request had no effect.

Use the commands and credential configuration in [README.md](README.md) to execute the remaining gates. Retain the exact case, provider, revision, requirement/test/environment identities, time, cost and observed outcome for each run. An unavailable or inconclusive gate stays blocking.
