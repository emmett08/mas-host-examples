# Bounded source self-healing

This separate example adapts the SDLC into an observed **find → investigate → experiment → repair → check → revise** loop. It uses the repository's pinned MAS host and Nehemiah communication protocol. The application controller owns durable budgets, candidate eligibility, external effects and release policy. `examples/k3s-live` remains a separate example.

The target is a stateless TypeScript parcel quotation service. It calculates GBP delivery prices, validates inputs and exposes a catalogue and liveness route. Engineers supply the versioned intended behaviour, editable paths, execution interfaces and release policy. Live agents can create or edit source files and runtime configuration inside that projection. Production tooling has no fault-label dispatch, expected patch or catalogue of cause-to-fix handlers.

All application data are disposable. Shared persistent writes, database migrations and arbitrary dependency installation are outside this example. Restoring an image does not roll back application data.

## Why self-healing

Self-healing names the implemented capability: restoring a managed application's required behaviour after a reproduced failure. The [controller](controller/loop.ts) investigates the failure, generates source or configuration changes, rejects candidates that fail independent checks, and verifies recovery in an isolated Kubernetes trial. Persistent budgets and release policy bound the work. Here, the managed system comprises the application and its repair controller.

Autonomic computing is the broader approach to self-management, encompassing capabilities such as self-configuration, self-optimisation, self-healing and self-protection ([White et al., 2006](https://research.ibm.com/publications/autonomic-computing-architectural-approach-and-prototype)). This example implements the fault-recovery capability within that family. Its automated configuration edits serve recovery of the specified behaviour. The precise name is **bounded source self-healing**.

Recovery evidence has a defined scope. The benchmark can verify deployment in its disposable target under the selected publication policy. For an operational incident, an independently checked candidate can be retained and, with the scoped credential, published as a repair pull request. Deployment into the original operational cluster requires a separate release process.

## Names and existing integrations

The example now lives at `examples/self-healing`, with workflow `.github/workflows/self-healing.yml` and action `.github/actions/self-healing-integration`. Update local commands and any workflow dispatch calls that use the old paths. The workflow appears as **Bounded source self-healing**, and the observer as **Self-healing**.

Existing integrations retain these identifiers:

| Identifier | Reason for retaining it |
|---|---|
| `SELF_REMEDIATION_*` settings and GitHub environments `self-remediation-live` / `self-remediation-publication` | Existing secrets, variables and environment protection rules remain applicable |
| `self-remediation-*` artefact names, evidence schemas and observation marker | Existing downloads, journals and checkpoint formats remain identifiable |
| `self-remediation` cluster, `k3d-self-remediation` context, image names and MCP identities | Existing execution guards, cleanup commands and capability records retain their identities |

New progress Check Runs use **Self-healing live observation**. The observer also recognises the previous Check Run name while retaining exact commit and incident matching. Recovery checkpoints must still be resumed from their recorded source revision, as described in [verification/RECOVERY.md](verification/RECOVERY.md).

## Read the result at the correct level

| Retained result | Meaning |
|---|---|
| A hypothesis or model review | A structured model judgement with its evidence, predictions and uncertainty |
| A completed failed measurement | The tool ran, returned an accepted receipt and observed a failed criterion |
| An unknown effect | Execution or acknowledgement is unresolved. External evidence must reconcile the original operation before more effects |
| Candidate eligible | Independent measurements satisfy every mandatory gate for the exact source, requirements, test and environment identities |
| Trial recovered | The exact immutable image passed fresh observations in the isolated runner-local Kubernetes target |
| Pull request created | GitHub retained a real repair diff against the faulty incident base |
| Merged | The configured checks and scoped publication policy admitted a merge |
| Deployed recovery verified | The separately admitted image passed fresh post-merge deployment observations |

Fixture runs are explicitly scripted controls. They exercise host communication, rejected candidates, source mutation and release safeguards. They do not measure a model's ability to discover repairs. Live runs retain the exact selected case, provider/model identity, observations, time and expenditure accounting. Neither a control suite nor a few live cases establishes general repair competence. Consult [VALIDATION.md](VALIDATION.md) for the actual checks executed for this revision.

## Components and authority

| Path | Responsibility |
|---|---|
| `target-app/` | Ordinary application source, runtime configuration and container recipe |
| `evaluation/requirements.json` | Service-owner requirements admitted as model input |
| `controller/` | SQLite journal/outbox, immutable artefacts, persistent budgets, controller loop and runtime bindings |
| `host/` and `project/` | Pinned-host investigation, delegated experiment planning, synthesis, independent review and admitted command/native operations |
| `tools/` | Typed frozen capability registry, source projection, native broker and custom MCP adapter |
| `sandbox/` | Credential-free execution of application code and generated diagnostic programs |
| `deploy/` | GitHub identity/precondition checks, content-addressed source import, immutable images and isolated Kubernetes trials |
| `server/` and `ui/` | Check Run publisher, local read-only observer, Vue UI and shared live/playback reducer |
| `evaluation/` | Protected injectors, scripted control responses and independent checks. These stay outside candidate snapshots and accessible Git objects |
| `verification/` | Finite SPIN models, guard-removal controls and implementation correspondence |
| `scripts/` | Entry points, observer/archive packaging and separate publication/promotion jobs |
| `../../.github/workflows/self-healing.yml` | Credential-free PR checks and separately selected live/publication jobs |

`host-revision.txt` at repository root is authoritative. Read [host/README.md](host/README.md) for the inspected pinned contracts. Assessed revision runs admit inference effects and exclude command/remediation effects and evaluator delegation. Builds, edits, MCP access and deployment therefore run through separately admitted ordinary host operations. Changed frozen inputs or candidate source create new phase identities.

The host is trusted orchestration software. Candidate execution occurs in separate constrained containers with no provider credentials, GitHub token, kubeconfig, host mount, Docker socket or accessible repository object database. The trusted executor retains those capabilities outside the candidate container. Reported capability/resource deltas describe the enforced execution grants and container limits. They do not establish every behaviour that arbitrary source might attempt. Protected tests execute from verifier-owned code and are not editable by the repair. Candidate-authored tests can supplement that evidence.

Hypothesis rank, experiment priority and candidate eligibility have separate roles. Every mandatory candidate criterion must pass. An inconclusive result blocks release. A model vote, test count or uncalibrated confidence cannot admit promotion. Failed candidates and independent review rejections feed counterexamples into another investigation while budget remains. Final evaluation disclosed to a later repair becomes development evidence and requires a fresh final suite.

## Implemented assessment contract

The example implements an executable acceptance contract. Its numerical host rubric has a narrower, structural purpose.

| Layer | Implemented rule | Authority |
|---|---|---|
| Service requirements | [`evaluation/requirements.json`](evaluation/requirements.json) defines HTTP behaviour, pricing, input limits and permitted edits; [`evaluation/harness.ts`](evaluation/harness.ts) measures development cases and generates fresh final cases | Protected verifier measurements establish whether the specified behaviour passes |
| Candidate eligibility | [`contracts/types.ts`](contracts/types.ts) binds evidence to source, patch, requirements, tests, environment and image identities; [`controller/policy.ts`](controller/policy.ts) requires every mandatory criterion to pass with evidence, an authorised independent evaluator, no regressions or unresolved release uncertainty, and permitted capability/resource changes | Any failed, absent or inconclusive mandatory criterion blocks eligibility |
| Host phase rubric | [`host/phase.ts`](host/phase.ts) admits `self-remediation-structure/1`; [`project/assessment.py`](project/assessment.py) scores `bounded-record` as **1** for canonical JSON output of at most **12,288 bytes**, otherwise **0**, after operation-schema validation | Structural validation only; it cannot establish product correctness or authorise release |
| Model review | [`project/prompts/reviewer.md`](project/prompts/reviewer.md) requires evidence-based findings, risk and remaining uncertainty; a rejection blocks the candidate in [`controller/loop.ts`](controller/loop.ts) | Additional blocking judgement; model approval cannot override failed measurements |
| Recovery and publication | The controller requires fresh final checks and an observed recovery of the exact immutable image in the isolated trial before invoking the separately scoped publication policy | Eligibility alone does not establish deployed recovery |

There is no active aggregate quality score or comparison of multiple eligible candidates. `preferEligible()` defines a lexicographic preference by operational risk, edit count and cost, but the controller does not call it: the loop stops after the first candidate completes the required checks, trial and publication step. The recorded risk judgement and edit count are not a calibrated measure of repair quality.

## Local checks

An external MCP client can invoke this controller through the independently
pinned Rust `mas-mcp` server. The optional [MCP entry point](mcp/README.md)
publishes a bounded incident run, correlated progress and persistent cancellation.
The controller retains its existing acceptance and release authority.

Use Node **24.19.0**, the repository's pinned host prerequisites, and SPIN plus a C compiler for formal checks. From repository root:

```sh
make setup
cd examples/self-healing
npm ci --ignore-scripts
npm run build
npm test
export MAS_HOST_BIN="$(pwd)/../../.tools/mas-host/target/debug/mas-host"
export MAS_SDK_ROOT="$(pwd)/../../.tools/mas-host"
npm run test:host
npm run verify:formal
```

`npm run build` also produces the portable observer in `dist/observer/`. It includes compiled Node server code and the built Vue application. Extraction and execution require no npm installation.

Browser controls require a Playwright Chromium installation:

```sh
npx playwright install --with-deps chromium
SELF_REMEDIATION_BROWSER_TEST=1 node --import tsx --test tests/observer-browser.test.ts
```

That test checks in-progress SSE delivery, graph placement directly below stable controls, a mobile viewport and offline seeking without future results appearing. It is a labelled browser control, separate from observing an actual live-provider workflow.

## Run the real host and disposable Kubernetes control

Docker, `kubectl` and permission to create a disposable local cluster are required. On GitHub Actions these run on the runner. Watching the workflow requires no Kubernetes installation on the engineer's computer.

From this example directory, after the build above:

```sh
docker build -t mas-self-remediation-builder sandbox
export MAS_SANDBOX_IMAGE="$(docker image inspect --format '{{.Id}}' mas-self-remediation-builder)"
bash scripts/prepare-k3s.sh
export KUBECONFIG="${RUNNER_TEMP:-/tmp}/self-remediation-kubeconfig"
node --import tsx scripts/integration.ts \
  --mode fixture --case missing-route --incident local-control \
  --output /tmp/mas-self-remediation-control
```

The preparation script installs the pinned k3d binary using `sudo` and creates `k3d-self-remediation`. Use an isolated development machine or the supplied workflow. The integration entry point rejects another Kubernetes context and requires an immutable sandbox image ID. Remove the disposable cluster after collecting its observations:

```sh
k3d cluster delete self-remediation
```

A completed baseline build failure also permits investigation and source repair. Unexecuted HTTP checks remain inconclusive, and the first independently eligible candidate establishes a trial without fabricating a baseline Pod.

The `missing-route` control must demonstrate a baseline failure, an unsuccessful candidate, another investigation, a useful source revision, independent checks and isolated k3s recovery. A failing external prerequisite remains a failed or unexecuted acceptance gate. The entry point preserves available diagnostics and builds the offline replay on failure.

## Select a live case

The workflow is **Bounded source self-healing**. Open **Run workflow** and select a case, or tick **Run all eight cases** (`all_cases`) to override the case selector. The checkbox is off by default. With `live_provider` unchecked, the selected cases use scripted controls. Enabling `live_provider` uses the configured billed provider on trusted `main`, after the shared credential-free checks pass.

The matrix runs at most two cases concurrently and retains every case's result even when another case fails. Shared contract tests, browser checks, formal verification and the canonical direct/MCP repair controls run once. Every selected case reuses the exact tested release host and SDK, verified by archive digest and pinned source revision. Each case has its own runner-local cluster, incident, observer, evidence artefacts and publication/promotion chain. A failed case cannot publish, and one case's candidate output cannot select another case's publication. PR and push checks retain the canonical fixture coverage. An unchanged manual, fixture-only `missing-route` selection uses that same control without running it twice.

Publication remains **archive** by default. If publication is explicitly selected for an all-case live run, each eligible case uses a distinct disposable branch. Negative controls retain their specified outcomes: `ambiguous-requirement` requires `missing_requirements`, `no-defect` requires `no_repair_required`, and `unavailable-dependency` requires `unavailable_external_cause`. The other scripted cases require `verified_recovery`. Live outcomes remain observations of the selected provider. A requirements stop that records only incident opening and its terminal outcome requires acknowledged completion evidence. It records that scope explicitly, because no controller effect was executed during an observable repair interval. Other cases retain the during-run checkpoint and progress requirements.

Available protected benchmark cases are `missing-route`, `business-logic`, `runtime-config`, `held-out-combination`, `unavailable-dependency`, `ambiguous-requirement`, `no-defect` and `verification-bypass`. Case labels and injectors belong to trusted benchmark setup. They are excluded from live repair inputs and admitted GitHub source access. Live providers must supply actual candidate edits. The `held-out-combination` is a benchmark variation, not a claim that the provider has never encountered similar code.

Configure the protected **self-remediation-live** environment:

The live job checks these settings immediately after Node setup, before restoring the tested host, image builds or cluster creation. A failed check lists every missing or invalid required setting in the job summary and retains `live-preflight.json` in the diagnostics artefact. The integration entry point repeats the same validation for direct invocation. Reports contain setting names and fixed guidance, never credential values.

| Setting | Purpose |
|---|---|
| Secret `OPENAI_API_KEY` | Maintained-host live inference only |
| Variable `SELF_REMEDIATION_MODEL` | Explicit provider model identifier admitted by the pinned host |
| Secret `SELF_REMEDIATION_GITHUB_READ_TOKEN` | Read-only official GitHub MCP metadata operation |
| Variable `SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256` | SHA-256 of the admitted official MCP `actions_get` schema and tool name |
| Variable `SELF_REMEDIATION_MAX_CALL_MICRO_USD` | Positive maximum reservation per inference call, in millionths of a US dollar. Workflow default: `150000` (USD 0.15) |
| Workflow `checks: write` permission | Dedicated compact redacted progress Check Run |

Set the secrets and variables in **Settings → Environments → self-remediation-live**. Secrets stored only in another environment, such as the existing Kubernetes demonstration environment, are scoped to jobs that use that environment. A live job needs an OpenAI key and explicit model. When both GitHub MCP settings are absent, the report warns that the official MCP acceptance gate remains unexecuted. A partially configured MCP grant or malformed schema digest blocks startup.

Defaults cap each case at **12 calls, 3 candidates, 600 seconds and USD 2 reserved expenditure**. Selecting all eight live cases allows at most **96 calls, 24 candidates and USD 16 reserved expenditure** across independent case budgets. The two-case concurrency limit reduces simultaneous activity; it does not reduce these aggregate limits. These bounds apply per workflow attempt. Explicit reruns can incur additional expenditure. The default USD 0.15 reservation is configuration that must be checked against the selected model and admitted token limits before a paid run. Durable counters survive process restart. Provider usage and reserved cost are retained separately. Reservations need a defensible configured per-call upper bound for the chosen model and token limits. They are not a statement that a fixture's zero provider cost predicts live cost.

The official GitHub MCP integration requires a frozen admitted schema digest, repository, workflow run and exact workflow SHA. A discovered schema change blocks access. The demonstration reads workflow metadata, without exposing healthy-main source, history, search, logs or downloadable benchmark artefacts. Missing credentials or an unavailable official service are reported as unavailable integration. See [deploy/README.md](deploy/README.md) for the exact runtime grant and credential configuration.

## Watch an active workflow

A runner's web server is not automatically reachable from your browser. This example publishes redacted event windows to a dedicated Check Run approximately every **12 seconds**. A local Node observer polls that Check Run through server-side `gh` authentication and serves Vue plus SSE on loopback.

1. Authenticate GitHub CLI locally with read access to the repository's Actions and Checks.
2. Download **self-remediation-observer-RUN-ATTEMPT-CASE** for the selected case. Its job uploads it before that case executes. The unsuffixed **self-remediation-observer-RUN-ATTEMPT** bundle observes the shared canonical fixture.
3. Extract the ZIP, open a terminal in that folder and run:

```sh
bash start.command
```

Then open **http://127.0.0.1:4318**. The equivalent cross-platform command is `node start.mjs`. No npm installation or local Kubernetes is required.

The bundle's `run.json` records the repository, exact workflow SHA, run ID, attempt, incident IDs and artefact names. Each case bundle selects its requested mode by default. In a live case bundle, `node start.mjs --mode fixture` selects the shared canonical control. In a fixture matrix bundle it selects that exact case. Case-suffixed artefact names prevent another matrix member from supplying its replay. The launcher resolves the exact download within that run and attempt, downloads available completed evidence and validates its incident before serving replay. While a live incident is active, it discovers the acknowledged progress Check Run. Pending fixture data, failed live setup and expired artefacts produce an explanation before the viewer starts.

The launcher prints the downloaded `archive/index.html` path when available. That file opens directly without Node. The explicit `observe.mjs --events ... --incident ...` and `observe.mjs --repo ... --sha ... --incident ...` interfaces remain available. Local builds without GitHub run metadata use those explicit interfaces.

The ZIP also includes optional MCP setup:

```sh
bash setup-github-mcp.command
```

This discovers `actions_get`, saves the schema and its runtime-compatible SHA-256 digest, and displays them for review. Typing `configure` saves `SELF_REMEDIATION_GITHUB_MCP_SCHEMA_SHA256` to the recorded repository's `self-remediation-live` environment. The helper uses `SELF_REMEDIATION_GITHUB_READ_TOKEN` when set, otherwise the existing local `gh` credential. It never writes the token to a file. Discovery without an environment update is `node discover-github-mcp-schema.mjs`.

The workflow's read-token secret still requires separate configuration. Viewing and schema setup do not start a repair workflow. The bundle carries no credentials. GitHub assigns numerical artefact IDs after upload, so the launcher looks them up using the exact recorded name and run instead of guessing them at build time.

On macOS, first confirm that `node --version` starts successfully. A `dyld: Library not loaded` error occurs before JavaScript execution and requires repairing or selecting a working Node installation. Homebrew's supported Node 24 installation can be selected for the current shell:

```sh
brew install node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"
hash -r
node --version
```

If that Node 24 installation itself reports a missing `llhttp` library, repair its packages with `brew reinstall llhttp node@24` and repeat `node --version`. The built observer requires Node **24.19.0 or later**. The offline `archive/index.html` opens directly in a browser without Node. See the [official Homebrew Node 24 formula](https://formulae.brew.sh/formula/node@24).

The UI displays committed incident identity, lifecycle, MAS message routes, hypotheses, predictions, measured criteria, candidate identities, independent eligibility, budget reservations, deployment observations and GitHub outcomes. Structured rationale is shown through disclosure controls. It does not expose hidden chain-of-thought.

Every panel uses the same event reducer in live mode and replay. Reconnects resume by sequence and suppress duplicates. A bounded Check Run window can omit older events if the observer starts late or polling is delayed. The UI shows gaps, conflicting duplicates, actual publication age and connection errors. Rate-limit responses honour `Retry-After` or the reset time and otherwise apply increasing delay. Missing events are never inferred as successful work.

For a reachable deployment, serve the built UI and its same-origin read-only SSE endpoint behind the deployment's own access control and TLS proxy. The local direct mode is:

```sh
node dist/server/index.js --events /path/to/run/events.jsonl --incident INCIDENT_ID
```

The bundled server binds to loopback. It exposes no mutation or credential endpoint and validates both Host and Origin. A trusted reverse proxy serving HTTPS can use `--public-origin https://observer.example` and preserve that exact Host. The proxy remains responsible for authentication and network access. Direct mode can additionally serve explicitly disclosed artefacts. A compact Check Run transport retains large payload references, so raw source may remain unavailable during a GitHub-only observation window. For the optional demonstration workflow, this live Check Run covers the controller and isolated trial. It completes before the separate publication and promotion jobs. Those later jobs add their observations to a consolidated offline archive; this implementation does not claim that the original Check Run streams their later outcomes.

## Offline replay and disclosed source

The completion artefact contains `archive/index.html`, a self-contained built Vue application with embedded committed events. The integration wrapper also includes candidate source/results selected by the controller disclosure manifest when available. Open it directly. It starts at sequence zero and requires no network connection. A completed archive is separate from during-run visibility.

To rebuild an archive with permitted details and candidate source:

```sh
node scripts/archive.mjs \
  --events /path/to/run/events.jsonl \
  --incident INCIDENT_ID --output /path/to/replay \
  --disclose \
  --artefacts /path/to/run/artefacts \
  --disclosures /path/to/run/disclosed-artefacts.json \
  --disclose-source
```

The controller-authored disclosure manifest selects explicit content hashes. The packager verifies each original hash, rejects symlinks and oversized payloads, and preserves a distinct hash for every redacted projection. It never copies the whole source checkout, protected harness or Git database. Candidate before/after comparisons, including added or removed files, appear only when their event is reached and disclosure is enabled. Undisclosed references remain visible as references.

The publication and promotion artefacts additionally contain `archive/index.html`, combining the controller journal with those separately scoped jobs. Each displayed event retains its original incident, sequence, timestamp, type and source-journal hash in `replayProvenance`. Replay sequences follow explicit workflow job order; they do not assume synchronized clocks across runners. Original missing event windows remain visible as gaps. `replay-sources.json` records the contributing journals.

To combine downloaded job directories explicitly:

```sh
node --import tsx scripts/combine-replay.ts \
  --controller /path/to/live-run --publication /path/to/publication-run \
  --promotion /path/to/promotion-run --output /path/to/combined-replay
```

Omit `--promotion` when only publication has run. The command reads the exact journal paths, preserves original outcome distinctions and executes no downloaded application code.

## Publication and promotion

The manual workflow's default is **archive**. A separately selected `pull-request` or `automatic` publication job consumes the exact retained candidate. Operational publication policy defaults to PR creation. Publication credentials live in the protected **self-remediation-publication** environment and never enter candidate execution.

The retained image consists of `candidate-image.json` and its sibling `candidate-image.json.parts/` directory. Keep them together when downloading or moving a run. Each content-addressed chunk is at most 8 MiB; the full stream is bounded to 2 GiB and verified against the manifest, stream and image configuration hashes before loading. Export and load stream through the host adapter without creating a file larger than the pinned host's 64 MiB limit. The separate publication process never executes the retained application.

Configure a repository-scoped GitHub App with contents write, pull requests write and checks read permissions:

| Setting | Purpose |
|---|---|
| Variable `SELF_REMEDIATION_APP_CLIENT_ID` | App identity used to obtain an installation token |
| Secret `SELF_REMEDIATION_APP_PRIVATE_KEY` | Installation-token issuance in the publication job |
| Variable `SELF_REMEDIATION_REQUIRED_CHECKS` | JSON array of actual check names and trusted owning App IDs, such as `[{"name":"protected-contract","appId":12345}]` |

Use the real App IDs and check names for the disposable target. Automatic mode requires explicit checks and an explicitly scoped disposable branch. The supplied workflow never grants live/provider credentials to PR code and never uses privileged `pull_request_target` execution. Publication processes do not run generated application code.

Injected faults become a genuine faulty Git commit and `demo/incidents/<run-id>` branch. Repair PRs target that branch, so the diff contains the actual repair. Demonstration setup never mutates `main`. Operational adapters instead bind the deployed faulty revision and configured base. All remote source access must remain inside the admitted repository/revision/path projection.

GitHub's merge API provides an expected-head check but no atomic expected-base parameter. The publisher checks the base before merging and verifies the resulting tree afterwards. A changed tree blocks promotion and requires a new build and independent verification. The optional promotion job accepts an exact-tree merge receipt, restores the retained immutable image and performs fresh observations in another disposable k3s target. See [deploy/README.md](deploy/README.md) for effect reconciliation and GitHub token-trigger rules.

## Supply an operational source projection

`run.ts --config FILE` accepts an owner-supplied JSON configuration instead of applying a benchmark injector. Its required fields are `repository`, `baseCommit`, `sourceDirectory`, `repositoryDirectory`, `pathPrefix`, `requirements`, a nonempty `checks` array and `operationalTarget`. `baseBranch` identifies the current repository branch. Optional `unresolvedIntent`, `publicationMode` and `requiredChecks` refine the policy. Each admitted source file is checked against the exact Git commit and path prefix. The owner supplies intended behaviour and protected HTTP checks using the types in `sandbox/executor.ts`.

The `operationalTarget` grant requires `namespace`, `deployment`, `deploymentUid`, `container`, `pod`, `podUid`, `imageDigest`, `sourceCommit` and `sourceAnnotation`. Use the exact immutable `repository@sha256:...` image and the same source commit as `baseCommit`. `sourceAnnotation` names the release metadata on both the Deployment template and Pod, for example `mas.dev/source-commit`. Optional `configurationSha256` pins the declared workload configuration; optional `event: {name, uid}` binds an exact triggering Kubernetes Event. Set `runtimeEnvironment: {}` for this supplied stateless service. A nonempty environment requires a separately implemented matched execution adapter.

```sh
export SELF_REMEDIATION_SOURCE_KUBECONFIG=/path/to/read-only-source-cluster.yaml
export KUBECONFIG="${RUNNER_TEMP:-/tmp}/self-remediation-kubeconfig"
node --import tsx scripts/run.ts --mode live --config /path/to/incident.json \
  --incident operational-review --output /path/to/run --trial k3s
```

The trusted source adapter reads the exact Deployment, Pod, its owning ReplicaSet and optional Event. It verifies the ownership chain, configured and running image digest, source annotation and configuration hashes. It repeats the observation before publication and rejects changed release identities. The annotation is an assertion of the engineer's build/deploy interface; retain supporting build provenance. The source kubeconfig needs only those scoped reads and never enters candidate execution. If omitted, it falls back to `KUBECONFIG`; using separate credentials keeps the source cluster's read authority distinct from trial mutations.

The controller reconstructs and verifies the incident in a separate disposable `k3d-self-remediation` target selected by `KUBECONFIG`. It retains an operational PR publication manifest for the separately credentialled publisher, which also needs the source read credential to repeat the release check. Set `SELF_REMEDIATION_PUBLISH_TOKEN` for the separately invoked trusted publisher when operational policy requests a PR; `credentialKind` defaults to `github-app`. The controller uses the retained result from that process. Without the scoped publication token it preserves the candidate as an archive and records `github-publication:scoped-publisher-credential-unavailable` as an unexecuted gate. This example does not promote into the original operational cluster. The runtime has the same immutable builder, provider-budget and protected-check requirements as the benchmark path.

## Restart, cancellation and unresolved effects

Resume the controller with the same mode, incident, output directory, source/configuration and budget settings using `scripts/run.ts`. The integration wrapper intentionally creates a new integration-start record and is not the process-resume entry point. A separate cancellation command preserves the request in the existing journal:

```sh
node --import tsx scripts/run.ts --output /path/to/run --incident INCIDENT_ID --cancel
```

`journal.sqlite` is authoritative. The newline event projection is recreated from committed rows. Immutable checkpoints retain the database and content hashes. Reusing a phase requires its original frozen input, tool binding and invocation identities. Runtime recovery consults retained dispatch records and host receipts before starting new work. A completed failed build/test permits another investigation. A lost tool or inference outcome remains unknown until the original effect has adequate evidence.

Use [verification/RECOVERY.md](verification/RECOVERY.md) for the exact checkpoint restoration and effect-reconciliation procedure. A process restart can reuse surviving host state and tool receipts. Runner or cluster loss is a different event: restore the immutable checkpoint and retained artefacts, then reconcile externally surviving GitHub and Kubernetes state. An old kubeconfig, target UID/resourceVersion or missing image cannot be treated as a restored environment. Cancellation and expenditure reservations persist in SQLite. Ordinary in-scope tools need no per-call confirmation.

[verification/README.md](verification/README.md) defines the finite SPIN properties and their implementation correspondence. Guard-removal controls test whether the stated assertions detect the missing safeguards. These models do not prove the semantic correctness of arbitrary generated programs, unbounded liveness or the correctness of external services.

## Acceptance still requires observations

The complete acceptance path is real baseline failure → provider-generated source change → protected independent checks → immutable image → isolated k3s recovery. External acceptance also includes the actual nonempty GitHub repair PR where authorised credentials exist, browser updates before the job completes, retained archive, and independently observed publication/promotion outcomes when those modes are selected.

The PR implements these paths and their controls. Its measured validation report records which were actually executed. Unavailable credentials, container infrastructure, official MCP access, browser runtime or paid-provider authorisation remain explicit unexecuted gates. Do not substitute a scripted fixture for those observations.
