# Validation record

## 19 October 2026: pin the Kubernetes client used by host workers

[Run 39315712235, job 118283096279](https://github.com/emmett08/mas-host-examples/actions/runs/39315712235/job/118283096279), at main `33340ddd83f00be3464e1ea651899bed05208f9d`, passed live configuration and image export preflight but stopped the `verification-bypass` case during baseline establishment. The other seven live jobs and shared fixture passed. The retained diagnostic `sha256:0f54e0e9dd0a64988b26597426a811c79c536a27d595c2f418d01978b6b1d144` records `kubectl get` exiting 2 with `runtime/cgo: pthread_create failed: Resource temporarily unavailable`. No provider call or candidate was admitted. The host retained the invocation as unknown; this is not evidence that the namespace mutation completed.

The workflow previously depended on an unpinned runner client. Its published runner image inventory lists kubectl 1.37.1, while this example runs k3s 1.32.3. The failed worker's exact client bytes were not retained. A separately downloaded official 1.37.1 binary passed bounded local startup, so neither the inventory version alone nor the precise resource exhausted by the failing cgo build is established as the cause.

Setup now installs the official static Linux x86_64 kubectl 1.32.3 with committed SHA-256 `ab209d0c5134b61486a0486585604a616a5bb2fc07df46d304b3c95817b2d79f`, matching the disposable server. Every cluster setup verifies the client; the shared fixture installs it before host integration checks. The host, its 2 GiB address-space ceiling, 64 MiB file ceiling and unknown-effect reconciliation rules are unchanged.

The new integration control runs the real pinned host, production `KubectlTransport` and official client against a labelled local HTTP API. It verifies the selected executable digest, client version, three namespace reads and the inherited hard limits. A different client digest is rejected. A separate installer control supplies corrupt download bytes and verifies that real checksum validation blocks installation and removes the temporary file. Local validation passed 177 unit/contract tests (two browser opt-ins skipped), all 12 real-host integration tests, the production build, shell syntax and actionlint. This does not reproduce the original intermittent thread-creation failure or claim real cluster recovery. The full Docker/k3s path remains an automatic PR check, and a subsequent live case requires a fresh dispatch after merge.

## 19 October 2026: case matrix and release-host comparison

Baseline: `87c3146d16ed8efbf5602c51c9d0cf2fbe84f433`. The changes add an optional eight-case dispatch matrix, retain the default canonical fixture, and move each selected case's publication/promotion dependency chain into a reusable workflow. The matrix has two concurrent members and does not cancel the other cases when one fails. Host source remains pinned to `f3cc7cb1894bebd45c2d708edec27c4b8171be1a` and MCP to `2971c481450978beb469839fed5421463f73c51e`.

The local comparison executed `node --import tsx --test host/phase.integration.ts` with `MAS_HOST_BIN` selecting debug or release and the same pinned `MAS_SDK_ROOT`. Each invocation ran the five existing delegation, replay, changed-input, cancellation and observation tests in fresh state. Order: debug, release, release, debug, debug, release. No warm-up observation was discarded. Environment: Linux x86_64, AMD EPYC 9V74, Node 24.19.0, Rust 1.99.0. Compilation was measured separately.

| Profile | Three elapsed observations (seconds) | Median |
|---|---|---|
| Debug | 49.884, 48.518, 46.663 | 48.518 s |
| Release | 2.952, 2.973, 2.918 | 2.952 s |

Every invocation passed. The median difference was **45.566 s (93.9%)** for this workload. Local cold builds took 14.79 s for debug and 55.46 s for release. The release binary and complete pinned source/SDK checkout are packaged once for case jobs, preserving the Git revision and clean-tree checks used by `pinnedHostIdentity`. A 4,916,402-byte archive was restored into another directory and all five phase tests passed against that restored distribution. These are local measurements, not a measured end-to-end GitHub workflow speed-up.

Local validation passed TypeScript/Vue production builds, 175 unit/contract tests (two opt-in browser tests skipped), all 11 real-host integration tests and five MCP integration tests with release, and actionlint 1.7.12 for every workflow. Matrix controls check the complete protected case list, per-case lifecycle wiring, distinct publication/namespace identities, rejection of another case/attempt's manifest, and observer artefact isolation. A two-event requirements stop retains acknowledged terminal evidence and declares that limited observation scope. Other cases still require during-run observations.

An existing concurrent-initial-claim control exposed a SQLite startup race: WAL activation ran before the busy timeout was installed. The timeout now precedes WAL activation. The control passed ten consecutive runs after that change, and the complete unit suite passed.

Docker and Kubernetes are unavailable in this local environment. The eight-case Kubernetes dispatch, paid providers and publication/promotion remain unexecuted here. Automatic PR checks exercise the canonical credential-free Docker/Kubernetes repair path. Full matrix dispatch is an explicit opt-in after the workflow is available on the default branch. Each live case keeps its original limits; all eight permit at most 96 inference calls, 24 candidates and USD 16 in configured reservations per attempt.

Observed locally on **18 October 2026**, against the implementation prepared for this PR. The repository baseline was `7a0b5f37d7a28ee7a676ecc9d12154361c9f2fb0`; the pinned host remained `8df16b640b78999b5eba60d83f2695f29052aaa2`. This record distinguishes local evidence from automatic PR workflow results, each bound to its published PR commit.

## Executed checks

| Check | Observed result | Scope |
|---|---|---|
| `npm run build` in `examples/self-remediation` | **Passed** | Controller/server TypeScript, Vue type-check, production Vue bundle, portable observer and trusted tool bundles |
| `npm test` in `examples/self-remediation` | **102 passed, 0 skipped, 0 failed** | Full suite with the explicit browser opt-in and available Chromium, including combined replay, actual file-limit/stream controls and immutable request/publication restart controls |
| `tests/observer-browser.test.ts` within the full run | **2 passed** | Actual Chromium browser, live SSE updates before completion, desktop/mobile layout, escaped before/after source disclosure and offline playback without future-result leakage |
| `npm run test:host` with the exact pinned host | **8 passed** | Actual maintained host, native/command/custom MCP paths, compiled topology, delegation, replay, accepted failed measurements and unknown-response recovery controls |
| `verification/verify.py` | **30/30 SPIN checks passed** | Finite safety models, checks without partial-order reduction, guard-removal counterexamples and selected reachability controls |
| Existing `examples/k3s-live` unit suite | **212 passed** | Regression checks for the preserved existing example |
| Existing `examples/k3s-live` build | **Passed** | Preserved example's TypeScript/Vue build |
| `actionlint` for the new workflow | **Passed** | Workflow syntax and static expression checks |
| Offline archive smoke check | **Passed** | Built Vue, styles and committed event data embedded into one HTML document, with the portable observer also packaged |

The complete 241-event archive from the fourth automatic run was also opened in Chromium. It retained the distinction between verified trial recovery and a later unknown export effect, disclosed both candidates as three file comparisons, and made no network requests. Desktop and 390-pixel mobile inspection found no browser errors or document overflow. Seeking before the recovery event hid that outcome. This larger trace exposed a missing safe summary field and long-criterion wrapping; both have dedicated regression coverage.

The combined-replay control verifies original job incident/sequence/type/hash provenance, retained gaps, redaction, publication versus deployed recovery, and no future outcomes while seeking. The combiner reads only explicitly supplied journal paths and never executes retained candidate code.

The browser was run using an available executable through `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. The initial default Playwright download returned an invalid archive. The subsequent explicit Chromium run passed, and its desktop and mobile screenshots were visually inspected. The mobile graph uses a narrow coordinate layout, and the journal table scrolls inside its card. The graph remains immediately below stable live/playback controls. No document-width overflow was observed at the tested mobile viewport.

The unit suite includes eleven pure controller-loop controls and separate deployment restart controls. They demonstrate a failed candidate followed by a new investigation and useful revision, independent review rejection followed by continued repair, final-check disclosure followed by a fresh final suite, stale source/build rejection, cancellation before publication, incomplete baseline evidence, exact-phase recovery without double charging and aggregate workflow-budget persistence and source repair after an observed baseline build failure. Deployment controls separately retain original mutation preconditions across interruption and establish the first trial from a verified candidate when no runnable baseline image exists. These scripted ports test controller behaviour. They are not provider repair measurements.

The SPIN report includes model, checker-runner and corresponding implementation hashes. Original models pass and deliberate guard removals reach their specified assertions. This provides finite control-safety evidence and an implementation correspondence argument. It does not establish a machine-checked refinement proof, complete tests, unbounded liveness or arbitrary generated-code correctness.

## First automatic PR integration observation

[PR run 39115856935](https://github.com/emmett08/mas-host-examples/actions/runs/39115856935), at head `42c52ac6a17ff42d462a55310423fa0358db567d`, passed the host, browser, formal, Docker image and k3s setup checks. Real isolated baseline checks observed ten passing criteria and the intended missing-route failure. The controller then stopped at its phase-input size boundary; it did **not** recover the trial. Diagnostics and a complete failure replay were retained. An immutable checkpoint upload was acknowledged while the controller was running.

That evidence led to three follow-up fixes: repeated passing-check explanations now use the retained complete-input reference without dropping any criterion; image defaults are explicitly set and verified against the independently exercised command; and checkpoint objects are deduplicated while retaining executable permission modes. Regression controls cover the actual failed input, the subsequent rejected-candidate/revision/review inputs, the image configuration mismatch, 144 MiB of logical checkpoint paths sharing less than 49 MiB of objects, and rejection when distinct objects exceed 128 MiB. The test and repeated host/formal results above include those fixes. Subsequent automatic CI results are bound to the PR head and reported separately; this initial failed run is not recovery evidence.

The second [automatic run 39117138156](https://github.com/emmett08/mas-host-examples/actions/runs/39117138156), at head `50f1eeaafccfe0752b27892bb1e1d86abb4c570b`, observed the intended baseline failure, rejected the first candidate for two regressions, generated a useful revision, passed all eleven development and eleven fresh final criteria, and imported the immutable candidate image. It then stopped with `unknown_effect` during Kubernetes replacement; it did not claim recovery. Retained Kubernetes data omitted the empty environment field, exposing a JSON Patch `replace` on an absent member. The following fix uses the object-member `add` operation while preserving every atomic target precondition. Regression controls cover API normalization, stale rejection and exact lost-response reconciliation. All 79 local tests and 30 formal checks passed after that fix. This second run also acknowledged four immutable checkpoint uploads (two before controller completion), with ten local cuts and no snapshot failures. A verified during-run cut retained 819,620,312 logical bytes as 61,103,523 distinct object bytes.

The third [automatic run 39118066464](https://github.com/emmett08/mas-host-examples/actions/runs/39118066464), at head `7f77ce7ca4122fa87df201251666753e53949f90`, again reached the verified revised candidate and immutable image, then retained an unknown replacement effect. The environment-member correction was insufficient: the adapter passed `/dev/stdin` to kubectl, which reopens that path rather than reading the supplied descriptor. Actual official kubectl v1.32.3 reproduced `ENXIO` under Node's socket-backed child stdin. The same command and production adapter passed in local-patch mode with a regular file. The adapter now uses a private temporary directory and patch file, cleans them up, and retains bounded redacted command diagnostics without inferring the external outcome. Real child-process controls exercise file permissions, cleanup and conservative failure classification. Earlier unknown operations are not retried automatically; each subsequent CI run creates a distinct disposable incident and target.

A restart review also found a truncating rewrite of the read-only preserved candidate. Publication files now accept identical existing bytes without reopening for writing and reject conflicting bytes. Separate-process controls preserve inode, mode and timestamp. This local environment cannot map another UID; the same test additionally verifies the old write's `EACCES` under an ordinary CI user. All 82 local tests and 30 formal checks pass after these changes.

The fourth [automatic run 39119115206](https://github.com/emmett08/mas-host-examples/actions/runs/39119115206), at head `3ea968b1b3ad5bc8b7f08e308000249774807e5d`, **verified real isolated k3s trial recovery**. Baseline liveness returned 404; the first candidate was rejected for unknown-route and unsupported-method regressions; the useful source revision passed all eleven development, eleven fresh final and eleven deployment criteria. The actual replacement completed and the recovered Pod ran `docker.io/library/mas-self-remediation@sha256:266406cd72b410dca2cdbd8ca33caf6e1d12cc04f7e900c4e0d974e6ebf904bf`. Source tree: `b99636b6c0d16c043a08a911fc591f34ab0b6ab0d18ba54a52ff87dcf24336a2`; image configuration: `sha256:d6e0c4a000a089bc24821565500a1e21b6c3de88d544d0ceeb64684d42bf5fad`.

That run subsequently stopped with an unknown image-export effect, so `trialRecovery` was true while overall success remained false. It retained 2 candidates, 9 scripted calls, 29 operations, zero provider micro-USD and 444.503 seconds. Publication/false promotion was unassessed. The image adapter had discarded subprocess stderr, preventing exact diagnosis of this export failure. The follow-up retains bounded redacted image-command diagnostics and exercises the actual host-bound exporter on the trusted builder image before the repair loop. This separate bounded transport control makes no provider calls and does not count as candidate evidence. Subsequent automatic results remain bound to their exact PR commits. All existing Application examples checks passed in the fourth run.

The fifth [automatic run 39120453013](https://github.com/emmett08/mas-host-examples/actions/runs/39120453013), at head `27a371d5e025e987acab42e8dd50e25370cc14a9`, stopped at that early preflight. Its retained Docker diagnostic reported `file too large`. The exact pinned host's `docs/native-contract.md` and `crates/mas-host-worker/src/lib.rs` specify a **64 MiB per-file guardian limit**. The original monolithic tar exceeded it. The replacement archive streams image bytes through content-addressed chunks of at most 8 MiB, with a small manifest, an aggregate 2 GiB bound, and hashes checked before load. It preserves the host limit and process supervision. A real subprocess control reproduces a failed monolithic write under a 64 MiB hard limit, then retains and verifies a 72 MiB chunked stream under that same limit. Corruption, symlinks, traversal and aggregate limits remain blocking. The sixth automatic run below then exercised actual Docker export of this representation successfully.

The final restart review also repairs retained deployment/external request envelopes, publication/promotion requests and same-sequence checkpoint manifests. Canonical JSON prevents insertion-order differences between initial requests and journal recovery. Separate-process controls exercise the actual recovery adapters, immutable file preservation and changed-input rejection, with only the host transport explicitly simulated.

## Completed automatic recovery control

The sixth [automatic run 39121381802](https://github.com/emmett08/mas-host-examples/actions/runs/39121381802), at PR head `1f024f0802ca777f4fa7362c973e48f5ac0d56be`, **passed the entire credential-free integration**. Both the new workflow and the existing Application examples workflow completed successfully. Incident `39121381802-1-missing-route` ended with `verified_recovery`, scope `isolated trial`, and publication status `archived`.

The real baseline passed ten criteria and failed liveness. The first candidate was rejected for two regressions; another investigation produced a useful revision. All eleven development, eleven fresh final and eleven trial criteria passed. The host-bound image-export preflight and final retained candidate export completed. The archived candidate preserves the source, independent verification, immutable image and offline replay for a separately authorised publisher.

| Identity or measurement | Observed value |
|---|---|
| Case / provider | `missing-route` / `explicit-scripted-control` |
| Faulty incident base | `0af27ec55e37ef7ff854ebeff3ba91bad52e5b56` |
| Candidate source tree | `b99636b6c0d16c043a08a911fc591f34ab0b6ab0d18ba54a52ff87dcf24336a2` |
| Image configuration digest | `sha256:d56acc2e57b0541031614f5e17e65a13edee3bb206cefdadf2ac73d0a1856995` |
| Deployed image manifest digest | `sha256:58c44dadb8cd226dc1d189dc192f2f7086e21a53a4d9fbc2a248c3633ea4f0b4` |
| Controller elapsed time | 450.630 seconds |
| Candidates / scripted calls / operations | 2 / 9 / 29 |
| Provider spend | 0 micro-USD; no live provider used |
| Success / abstention | True / false, within the isolated trial scope |
| Regression evidence | One rejected candidate with two failing behavioural criteria |
| False promotion | Unassessed: publication and promotion were not run |

This establishes actual tool and controller behaviour for one scripted missing-route control. It does not establish live-provider repair competence, success across the entire benchmark, or production recovery. The seventh automatic run checks the subsequent UI-only fixes and this evidence record; its outcome is reported on the PR.

## External acceptance and local availability

| Gate | Status and missing evidence |
|---|---|
| Original operational cluster trigger → Pod/release → image/configuration → source binding | **Unexecuted remotely:** needs an exact owner-supplied target grant and scoped source-cluster read credential; local identity/precondition controls passed |
| Container build and candidate execution in the real constrained sandbox | **Executed in automatic PR CI:** real Docker execution passed. Usable Docker infrastructure was unavailable locally |
| Baseline failure → generated source change → protected checks → immutable image → real isolated k3s recovery | **Executed in sixth automatic PR CI:** baseline failure, rejected candidate, useful scripted source revision, independent checks, immutable image, real trial recovery and retained image export all passed. This does not measure live-provider repair |
| Official GitHub MCP metadata call | **Unexecuted remotely:** requires the runtime read credential and frozen admitted official schema. Local MCP transport/schema/projection controls passed |
| Live-provider patch generation and revision | **Unexecuted:** no paid/live workflow was authorised or dispatched in this session |
| Real nonempty GitHub repair PR against an injected faulty branch | **Unexecuted:** requires the separately scoped runtime publication credential and retained verified candidate. Transport controls verify the intended semantics locally |
| Real Check Run progress observed in a browser before the live workflow finishes | **Unexecuted remotely:** the local browser control passed, while a running GitHub workflow and its progress Check Run remain required |
| Automatic scoped merge and post-merge deployed recovery | **Unexecuted remotely:** requires an explicitly disposable target, configured trusted checks, App credentials and the separate promotion environment |

No paid/live workflow, demonstration merge or production promotion was dispatched as part of local validation. The implementation PR is separate from the repair PR that a future admitted demonstration may publish.

## Live startup follow-up

[Live run 39125081773, job 117671911252](https://github.com/emmett08/mas-host-examples/actions/runs/39125081773/job/117671911252) ran merged main `089365b2c9b6eff069d6b3a0c1df7efe0bb71f7e`, selected `business-logic`, and stopped before provider execution. The job received empty `OPENAI_API_KEY` and `SELF_REMEDIATION_MODEL` settings. Its official GitHub MCP token and schema digest were also empty. The error was `Live provider credential unavailable`. No progress Check Run or committed incident journal was created.

The follow-up adds a dependency-free configuration check before host compilation, image builds and cluster creation, and repeats it inside the integration wrapper. It reports required omissions together, retains a redacted JSON report and Actions summary, and preserves optional MCP absence as an unexecuted acceptance gate. Partially configured MCP grants remain blocking. The publisher now prints a complete observer command with an exact Check Run ID only after an acknowledged update. Lost responses still require reconciliation.

The supplied Mac screenshots independently show Homebrew Node 25.6.0 failing in the dynamic loader because `libllhttp.9.3.dylib` is missing. JavaScript had not started. The main README and built observer instructions now describe selecting a working Node 24 runtime, checking its version, and viewing the offline archive without Node.

Local follow-up verification: build passed; **110 tests passed, zero skipped or failed**, including both Chromium tests; actionlint and `git diff --check` passed. Seven new configuration controls cover the observed missing settings, redaction, optional MCP configuration, reservation bounds, effect-free CLI validation and retained integration failure. An eighth control verifies that an observer command becomes available only after acknowledged Check Run publication. The user's Mac runtime and live provider configuration require owner action; no paid/live retry was dispatched for this follow-up.

## Current boundaries

- Application source and `config.json` can change within the admitted projection. The build/execution interface fixes the Node standard-library environment and constrained container grants. Shared persistent-data writes, schema migrations and arbitrary dependencies remain outside the example.
- A completed baseline build failure is retained as failed evidence, while HTTP checks that could not execute remain inconclusive. Source repair can proceed without inventing a baseline Pod, and the first eligible candidate establishes the isolated trial. Local controller/deployment controls cover this route. The executed Docker/k3s case began with a runnable faulty baseline; a real initially unbuildable application remains a separate unexecuted variant.
- Operational configuration checks the exact source commit and performs scoped read-only binding of the original trigger, Deployment, Pod ownership, image and declared configuration. Local fake Kubernetes transports exercise those identity and staleness controls. An actual original-cluster observation is unexecuted locally. Source annotations remain assertions of the configured build/deploy interface and need supporting build provenance. Trials run in a separate disposable cluster; the supplied CLI does not promote into the original operational deployment.
- Candidate verification samples stated behaviours using protected checks. Capability/resource deltas concern enforced execution grants and limits, rather than a complete semantic analysis of generated source.
- A Check Run contains a bounded redacted event window. Delayed or late observers may see explicit gaps. Full disclosed candidate payloads are retained in the archive; the GitHub-only live transport may expose references rather than full source. In the supplied demo workflow the original Check Run closes after controller/trial work. Separate publication and promotion jobs contribute to a combined offline archive; their later outcomes are not streamed through that earlier Check Run.
- Provider expenditure is bounded by persistent configured reservations. Billed cost still requires retained provider usage and the applicable verified price schedule. The workflow's per-call reservation must be checked for the selected model and token limits.
- GitHub supplies an atomic expected-head merge parameter but no atomic expected-base parameter. A changed post-merge tree blocks promotion and requires renewed build/verification evidence.
- Process restart assumes surviving durable journal, host and artefact state. Runner/cluster loss requires checkpoint restoration and reconciliation of surviving external resources. A missing external resource alone does not establish that an uncertain request had no effect.

Use the commands and credential configuration in [README.md](README.md) to execute the remaining gates. Retain the exact case, provider, revision, requirement/test/environment identities, time, cost and observed outcome for each run. An unavailable or inconclusive gate stays blocking.
