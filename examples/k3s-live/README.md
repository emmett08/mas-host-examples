# Live Kubernetes incident room

A Vue 3/TypeScript canvas displays real MAS request/result envelopes while a bounded
draft, assessment and optional revision investigate a Kubernetes workload warning using collected logs,
resource specifications, status, events and CPU/memory samples. The default mode calls
OpenAI; it never substitutes fixture responses when credentials or models fail.
A separate, clearly labelled fixture mode exercises the real host and protocol
without calling a model.

**The GitHub Actions demonstration creates its own k3s cluster on a GitHub-hosted
Linux runner. You do not need a cluster on your Mac or an external Kubernetes
service.** See [GitHub Actions](#github-actions) for the single required secret.

## What the demonstration shows

1. An opted-in Pod Warning triggers collection of bounded Kubernetes evidence.
   The controller retains that evidence in a `MASDemoRun` before starting agents.
2. The coordinator workflow starts platform and security branches in parallel.
3. The platform branch asks a platform LLM for a diagnosis, then contacts the
   security branch directly for peer critique. The independent security branch
   also calls its specialist LLM. Each invocation has its own request identity.
4. The coordinator joins both branches and asks a final LLM for an evidence-cited
   diagnosis, a structured remedy and verification criteria. The original platform
   findings travel with the critique to the final agent.
5. The host binds the exact draft to a versioned rubric and deterministic evaluator.
   Failed criteria can supply feedback to one revision. The final selected output,
   all earlier candidates, criterion findings and supplied invocation inputs remain inspectable.
6. A dedicated remediation controller can apply one allowed readiness-probe
   correction after the selected candidate passes its internal checks. It records the exact patch and checks
   rollout, replacement Pod identity, application health and fresh metrics.

## Compare collected evidence with LLM-selected MCP tools

The dashboard has two tabs on the same page:

- **Collected evidence** keeps the original operator collection and hybrid assessment.
- **LLM tools + MCP** selects the same incident, asks an LLM investigator to choose
  tools, freezes their recorded results, then runs the same hybrid assessment and
  bounded revision. Select **Investigation** or **Assessment** to inspect each
  phase's own topology and request/result trace.

First select a collected run with a Pod-bound evidence bundle. In the MCP tab,
**Investigate same incident** copies its event and Pod identity into a new run.
The investigator receives the event and subject, but does not receive the earlier
logs and specifications. It can request `pod_overview`, `workload_spec`, `pod_logs`
and `pod_metrics`, then return its findings. Tool arguments cannot choose another
namespace, Pod, API path or executable. These are read operations; the existing
remediation controller remains the owner of permitted workload changes.

`project/agents.mcp.toml` binds the investigator and four ordinary command actors.
The retained executable `project/mcp-client.mjs` connects to the custom stdio MCP
server in `mcp/server.ts` using the pinned official TypeScript SDK. It discovers
and invokes one registered tool per admitted MAS command effect. The model
selects operations through the existing `delegates` decision loop; it does not
receive Kubernetes credentials or open MCP connections itself. Both protocols
are used: Nehemiah carries admitted actor requests/results and MCP carries the
client/server tool calls. The server belongs to this application because it owns
Kubernetes-specific evidence, permissions and projection rules. No host runtime
or Nehemiah wire-format change is required.

`DEMO_MCP_SOURCE` selects `kubernetes-api` or `recorded-evidence` on the server.
It is independent of `DEMO_MODE`, which selects live model calls or deterministic
provider fixtures. Deployment explicitly sets `kubernetes-api` in both provider
modes. Local fixture runs default to `recorded-evidence`; that mode only reads
previously supplied observations and never claims fresh cluster measurements.
Live mode defaults to `kubernetes-api` and does not fall back when access fails.
The dashboard's MCP subprocess uses the projected service-account token; the
existing namespace-scoped operator role has workload read permissions and CRD
administration permissions. The tool implementation exposes no mutation method.

Each investigation permits five model turns, at most four tool calls and nine
external effects within 180 seconds. Each tool call has a 20-second host limit,
a 15-second client limit and an 8 KiB result bound. The assessment retains its
300-second bound; the combined API run has a retained 600-second deadline. These
are execution limits, not supplier billing guarantees. Context bytes, deployed
MCP/operator/shared modules and the dependency lockfile are digest-bound. The
Node interpreter and installed SDK dependency tree remain pinned deployment
requirements; use `npm ci` and retain the deployed image with the run.

Only completed command results in the host journal enter the final evidence
bundle. Model-authored prose and the earlier admission bundle cannot add evidence.
Each result must match the admitted context, tool, source and Pod UID. Sequential
reads retain their individual timestamps; they are not an atomic cluster snapshot.
The controller persists the frozen evidence before starting assessment, and
reopening the same run reuses completed calls. Unknown effects prevent automatic
repetition. Shutdown prevents subsequent phase launch and asks each active host
to cancel; already admitted work can settle before cancellation is acknowledged.

The recording workflow pauses remediation until both approaches have acquired
evidence from the same faulty Pod. Once MCP evidence is frozen, it restores the
original remediation flow while the MCP assessment continues. Its downloadable
HTML embeds both captured approaches, including the MCP calls and their evidence.
This compares behaviour on one incident; it does not establish that one method
has better diagnostic accuracy. A run initiated directly from the MCP tab does
not create a Kubernetes remediation custom resource.

After `make setup`, run application and real-host integration checks:

```sh
cd examples/k3s-live
npm ci
npm test
npm run build
npm run test:host
```

The integration checks use deterministic model responses and real stdio MCP
exchanges. The Kubernetes workflow additionally exercises actual cluster reads;
its explicit live mode calls the configured LLMs. For deployment, continue with
the existing GitHub Actions instructions below.

## Auditable assessment and bounded revision

`project/revision.json` freezes the evaluator, three binary criteria, permitted
inputs, permitted delegates, a maximum of one revision and sixteen total
invocations. Nested workflow calls count towards that limit. The original
300-second host deadline and provider-effect budget continue across the loop
and restart. Evaluation uses a native Python worker through the same host request
machinery; no cluster command or remediation effect is available to it.

The criteria check that evidence citations name collected items, that a proposed
action retains the allowed target/identity/paths and verification fields, and that
abstention is consistent with human review and follow-up checks. These are
**deterministic constraints on the recommendation**. They do not measure whether
the diagnosis is true or whether abstention was appropriate for the actual incident.
The selected output is the first candidate passing all frozen checks, otherwise
the last candidate at the fixed limit. An exhausted, cancelled, blocked or expired
loop is a failed investigation for controller admission; its retained evidence
remains visible. The separate controller still applies every original remediation
precondition and verification check to a completed loop's exact selected output.

The fixture profile deliberately adds `fixture-missing-evidence` to its draft's
citations. The evaluator detects that unsupported reference; the fixture revision
removes it. This demonstrates failure retention and correction with two distinct
candidate identities. It is not an estimate of model performance or evidence that
feedback improves independently measured outcomes. Live mode inserts no defect.
The [held-out incident experiment](../../experiments/incident-revision/README.md)
compares one pass, feedback revision and resampling with separately retained
outcome labels, repeated trials and frozen budgets.

The assessment panel identifies each candidate by its full-record reference and
output SHA-256, every evaluator by identity/version/kind, and each finding by
criterion, verdict and exact supporting evidence reference. It keeps inconclusive
findings and evaluator errors distinct from failures and passes. Model-based
evaluators, when configured in a host plan, are labelled **model judgement**;
deterministic criteria are labelled **deterministic check**. No internal score is
presented as independent improvement.

Host assembly retains the evidence, feedback and policy actually supplied to each
invocation. This demo explicitly marks its bounded incident input public using
`readers: ["*"]`. Independent evaluator invocations receive the incident and exact
candidate, with no earlier assessments. Revision receives only the feedback
permitted by the frozen plan. Host disclosure restrictions propagate to derived
outputs; a public observation cannot reveal a restricted record even when payloads
are enabled. The guarantee covers host-mediated channels under the trusted-worker
boundary. It does not confine arbitrary native-worker filesystem or network access.

`SHOW_PAYLOADS=true` includes permitted candidate bodies, findings and invocation
contexts in the inspection view and download. With the setting false, assessment
records retain identities and hashes while their bodies and invocation inputs are
omitted. The final public output remains displayed and is bound to the selected
candidate's output digest. This setting never overrides a source disclosure policy.
The archive checks reference relationships, append-only history and SHA-256 content
before playback. Its JavaScript viewer rejects integers outside the exactly
representable range; the Rust protocol remains authoritative for its wider integer
domain. An offline file performs no agent execution or remediation.

## Candidate-bound mixed-agent review

The optional `review_quorum` agent demonstrates a native deterministic reviewer
and a model reviewer assessing the same retained candidate. Its versioned parallel
join requires two distinct actors, an exact candidate `{id, sha256}`, and the same
frozen context containing criterion, rubric and evidence references. An
`accepted: true` vote for a different candidate or context is retained as
`mismatched` and cannot count towards the quorum. The native reviewer also checks
candidate content, output digest, rubric and supplied evidence before applying
the three incident constraints. The model review remains model judgement. Neither
a quorum nor a passing assessment grants remediation authority.

From this directory, a completed public host result can be prepared for another
review without reconstructing identities or exposing private evidence:

```bash
node deploy/quorum-input.mjs assessed-result.json > quorum-input.json
"$MAS_HOST_BIN" run --project project --sdk-root "$MAS_SDK_ROOT" \
  --agent review_quorum --input quorum-input.json --state .state \
  --run candidate-review --connections project/connections.quorum-fixture.toml
```

The named connection profile uses a **scripted command-provider fixture**, so the
command performs no model inference. It accepts only the conservative abstention
fixture; a proposed action may receive a negative vote. Omit `--connections` only
for an explicitly intended live model review with the configured provider key.
This separate command leaves the incident controller's frozen selection and
independent remediation checks unchanged.

The native-host integration suite runs the same mixed review and checks passing
agreement, candidate mismatch, context mismatch and changed candidate content.
It also checks reply-route preflight, rejection of host-reserved evidence source
identities, forged evaluator bindings, foreign evidence, frozen-plan conflicts,
exhaustion and replay. Run it from this directory after building the pinned host:

```bash
MAS_HOST_BIN=../../.tools/mas-host/target/debug/mas-host \
MAS_SDK_ROOT=../../.tools/mas-host npm run test:host
```

These are protocol and host conformance checks using scripted model adapters;
they establish neither live-model quality nor improvement on unseen incidents.

## The practical incident and outcome

The sample checkout application serves `/healthz` and `/`, but its readiness
probe requests `/readyz`. Kubernetes reports an `Unhealthy` Warning; the Pod is
running and unready. Its access logs show `/readyz` returning 404 and `/healthz`
returning 200. The live Pod, ReplicaSet and Deployment specifications identify
the faulty readiness path and the owning workload. Because the process remains
running, metrics-server can sample its real CPU and memory usage.

All three agent prompts state the bundled `probe-app.mjs` endpoint contract:
`/healthz` serves readiness and liveness, `/` serves the application, and
`/readyz` is unsupported. That contract applies only to this managed example
running the bundled command. Collected logs and specifications must still
support the diagnosis. The controller checks current execution preconditions
and subsequent recovery; those pending checks do not themselves prevent a
conditional recommendation.

The expected useful outcome is a specific proposal to change the owning
Deployment's named container readiness path to `/healthz`. The LLM must cite
collected evidence IDs. It can return `action: none` and request further work
when evidence does not support that remedy; missing metrics are never zeroes,
and a current usage sample cannot rule out earlier resource pressure.

Deploying with `DEMO_AUTO_REMEDIATE=true` enables a dedicated controller restricted
to the managed `mas-demo/mas-demo-checkout` Deployment and its `checkout`
container. It accepts only `/readyz` → `/healthz`, verifies the proposal against
the collected specification and probe logs, checks Deployment UID and the full
original template hash, then uses JSON Patch tests for current UID, resource
version, container name and old path. It executes no model-supplied shell.
Unchanged templates permit refreshing a resource version after status updates;
changed templates and replaced resources are rejected.

A successful model response means **assessment completed**. **Verified recovery**
requires the separate tool to observe the corrected Deployment rollout, a Ready
replacement Pod owned by that Deployment, the expected HTTP response through its
Service and fresh resource metrics. The archive retains the admitted patch,
checks and before/after observations. A failed or incomplete verification remains
visible and is never reported as recovery.

The controller reports through a dedicated authenticated endpoint. Deployment
creates its token automatically and supplies it to the backend and remediator.
It is excluded from the collector, LLM workers, prompts and archives. The
collector and LLM workers retain read-only access to workloads. The recording
script observes the controller's result; it holds no reporting credential and
executes no remediation.

## Dedicated remediation controller

`mas-demo-remediator` runs as a separate Deployment with its own ServiceAccount.
It polls completed `MASDemoRun` objects, binds the backend run ID, Event and
evidence to the admitted custom resource, and checks evidence age before
considering a change. It reuses the same admission and recovery functions as
the original workflow tool, through direct Kubernetes HTTPS requests.
Its `/api/runs/:id/remediation` response carries the unchanged incident, exact
selected output and digest reference, completion state and retained remediation
records. Invocation history stays in the dashboard snapshot so a growing audit
does not exhaust the controller's unchanged 1 MiB response limit. All original
evidence and live-resource admission checks still apply.

Before applying a patch it creates a `MASRemediation` journal and reserves the
attempt through a resource-version-conditional status update. The journal
retains the admitted patch and original observation before the effect can
occur. A reservation whose acknowledgement is lost grants no execution
authority. A retained `Applying` attempt is never patched again after restart.
An uncertain effect retains `effectOutcome: unknown` and
`verificationOutcome: not_run`; no automatic retry is permitted.

The journal identity binds the namespace UID, Deployment UID, original Pod
template hash and policy version. Retaining it suppresses automatic repetition
of the same original configuration, including another investigation or a
manual rollback to that exact template. The controller cannot delete journals.
They must remain available for as long as the corresponding target and
investigations can be reconsidered. Repeating a completed or uncertain attempt
requires an explicit engineering decision outside this controller.

The controller saves a terminal report before publishing it to the dashboard.
If publication fails, it retries the identical report without repeating the
Kubernetes change. An assessment that fails preflight leaves the agent's
assessment visible without creating a mutation journal or publishing a repair
report. A later investigation can supply better evidence. The deployment uses
one replica and the `Recreate` strategy;
it provides durable effect reservations rather than a highly available
remediation service or an unrestricted exactly-once guarantee.

Its Role grants patch access only to the named checkout Deployment. The
admission code enforces the allowed field and value change; Kubernetes RBAC
does not express that field restriction. The controller can read the Pods,
ReplicaSets, metrics and named Service proxy needed for verification, and the
demo namespace UID. It receives neither the provider key nor permission to
read Secrets, execute in Pods or mutate other Deployments.

## Execution outcomes and later observations

New `mas-k8s-resolution/2` reports bind an operation ID (the durable journal
name) and attempt ID (the reserving controller process). They record two
independent properties:

| Property | Values and meaning |
| --- | --- |
| Effect outcome | `not_started`: no dispatch; `rejected`: a definite authenticated API rejection; `applied`: the exact admitted change was acknowledged; `unknown`: retained evidence cannot establish whether the change was applied |
| Verification outcome | `not_run`, `passed`, `failed` (an observed postcondition failed), or `inconclusive` (the available evidence could not establish the postconditions) |

A generic subprocess error, timeout or malformed patch response remains
`unknown`. The in-cluster adapter recognises only explicit pre-commit API
rejections; HTTP 5xx responses remain uncertain. An acknowledged patch followed
by unavailable metrics is `applied` and `inconclusive`. Verified recovery requires
`applied` and `passed`. Existing version 1 reports retain their original bytes;
the dashboard labels their missing independent outcomes as unrecorded.

`deploy/guarded-operation.mjs` supplies the shared reserve, execute and verify
sequence. The readiness adapter owns its Kubernetes admission predicates,
patch and recovery checks. The controller owns durable reservation and replay
refusal. A second deterministic adapter in `guarded-operation.test.mjs` replaces
a versioned key/value entry through the same execution contract, including lost
acknowledgements and process reconstruction. The deployed Kubernetes controller
continues to admit the single readiness-path action described above.

For an uncertain or unverified version 2 attempt, the controller can append up
to eight read-only workload observations, at least 30 seconds apart, to the
finished journal. Each observation binds the run, operation, attempt, original
report digest, namespace and target identities, and original template hash. A
resource-version CAS admits exactly one appended record; competing or lost
acknowledgements read the retained record before publication. The authenticated
backend retains observations in the same order and returns a compact receipt
for the exact submitted record.

These observations classify the current template as `desired`, `original`,
`changed` or `unavailable`. A desired template establishes its presence at the
recorded time. It does not attribute that state to the uncertain attempt,
establish application recovery, rule out a delayed original request, or grant
a repeat attempt. The original execution report remains immutable. Archives
preserve both records and reveal each observation only at its recorded time.

## Collected evidence

The `mas-k8s-evidence/1` application payload contains a capture time, exact Pod
identity and individually identified items:

| Evidence | What is retained |
|---|---|
| `pod` | Actual image, commands, probes, resource requests/limits, conditions, restart counts and termination state |
| `workload-replicaset`, `workload-deployment` | Verified owner chain, bounded specifications and Deployment template hash |
| `logs-<container>-current`, `logs-<container>-previous` | Bounded timestamped container logs, or an explicit reason they could not be read |
| `events` | Related events filtered to the exact Pod UID |
| `metrics` | Actual CPU/memory quantities, sample timestamp and measurement window |

Collection has a ten-second budget and a 32 KiB aggregate bound. It checks Pod
UID before and after name-addressed log/metrics requests and verifies each owner
UID. Missing, stale, denied and truncated evidence stays explicit. Environment
literal values and probe header values are redacted; Secret contents are never
requested. Common credential patterns in logs and command arguments are scrubbed,
but arbitrary application text can still contain sensitive information. Use the
dedicated demo namespace and inspect evidence before sharing a capture.

The same bundle reaches the platform specialist, independent security review,
peer critique and synthesis. The dashboard exposes each item and the separate
tool verification; it keeps an LLM proposal distinct from an observed recovery.

This is a hybrid of supervisor fan-out, hierarchical specialist workflows and a
lateral peer exchange. Workflows choose the bounded choreography; LLMs produce
diagnoses, critique and recommendations. These are **LLM-backed workflow agents**:
the demonstration does not claim that the models invented the topology or chose
which peer to contact. The original draft uses four provider calls. The assessment
wrapper and evaluator produce ten invocations in a passing first draft. One revision
adds one provider call and three invocations, for twenty-six request/result envelopes
in the deliberately defective fixture. Failure can stop that sequence.

The canvas shows logical agents, not pods. One pod contains a dashboard/backend
and a separate evidence collector container; the remediator has its own pod.
The backend runs the Rust host
and supervised workers locally. MAS protocol admission governs actor messages;
private IPC connects workers to the host; HTTPS connects LLM adapters to providers;
SSE carries read-only observation snapshots to Vue. No MAS wire change is needed.

## Run with real LLMs on Linux

Use Node **22.13 or later**, Python 3, Rust **1.99.0** and the pinned host. The repository's
standard setup also requires Go and C++ for its other examples. From the
repository root:

```sh
make setup
cd examples/k3s-live
npm ci
npm run build
export OPENAI_API_KEY='your-provider-key'
DEMO_MODE=live npm start
```

Open <http://localhost:8080> and choose **Run sample with LLMs** to exercise a
sample without cluster access. Real collection is triggered by the deployed
operator in the Kubernetes path below. Provider keys
stay in the server environment. `project/agents.toml` explicitly selects GPT-5.4
Mini for specialist work and GPT-5.4 for synthesis, using the same dated model
identifiers as the other live examples. Your provider account must support them;
edit the models there if necessary. A fresh run captures changed configuration.
This example uses OpenAI; the existing composable example retains Cursor and
compatible-provider profiles.

`SHOW_PAYLOADS=true` includes application message payloads and checkpoint values
in observations. Metadata is the default. Final run output is always displayed.
For a local service, start it with `SHOW_PAYLOADS=true DEMO_MODE=live npm start`.
For Kubernetes, pass `SHOW_PAYLOADS=true` to `deploy/apply.sh`; it records the
setting in the ConfigMap and rolls the dashboard onto the changed setting.
The setting accepts only `true` or `false`. Omit it to retain metadata only.
Do not submit confidential incident data to a demonstration session. To develop
the UI, run the backend and `npm run dev` in separate terminals; Vite proxies
`/api` to port 8080.

For a credential-free rehearsal:

```sh
DEMO_MODE=fixture npm start
```

Fixture mode uses deterministic provider outputs, not response replay. It still
executes MAS admission, workflows, supervision and journal persistence. The UI
labels it **FIXTURE · NO LLM**. Switching mode requires restarting the backend;
existing runs retain their original mode.

The workflow opts into a separate **paced recording fixture** with
`DEMO_MODE=fixture DEMO_FIXTURE_RECORDING=true`. Its command providers consume
the real `mas-provider/1` request, inspect the attached evidence, wait five
seconds per call and return deterministic, schema-checked JSON. This deliberate delay lets the browser subscribe before
message flow finishes; it does not measure LLM latency. The normal fixture stays
fast, and the recording flag has no effect in live mode. The fixture provider
uses no provider credentials or network and is clearly distinguished from LLM inference.

## Deploy to k3s

Docker Desktop with k3d is a convenient macOS route: k3d runs a real k3s cluster
inside Linux containers. Alternatively use an existing dedicated k3s cluster.
The default manifests use k3s's default storage class for the retained-state PVC.

```sh
# From the repository root; k3d and kubectl must already be installed.
docker build -f examples/k3s-live/Dockerfile -t mas-k3s-live:demo .
k3d cluster create mas-demo --image rancher/k3s:v1.32.3-k3s1 --wait
k3d image import mas-k3s-live:demo --cluster mas-demo
export OPENAI_API_KEY='your-provider-key'
SHOW_PAYLOADS=true DEMO_MODE=live DEMO_AUTO_REMEDIATE=true examples/k3s-live/deploy/apply.sh
kubectl -n mas-demo port-forward svc/mas-demo 8080:8080
```

The recording script creates the faulty workload, waits for genuine metrics and
probe logs, then opts its exact Pod into event-triggered investigation:

```sh
DEMO_MODE=live node examples/k3s-live/deploy/record-demo.mjs
```

For a manual investigation, apply `deploy/failing-pod.yaml`, wait for its Pod to
be Running and for metrics to be available, then label that Pod
`demo.mas.dev/trigger=true`. The template starts with the trigger disabled, so
warming the workload does not spend model calls. The controller
polls namespace Warning events every three seconds, checks the label on the Event
or its exact involved Pod UID, and creates a `MASDemoRun`. It starts the retained
run through the local API and updates custom-resource status. Repeated occurrence
counts on the same Event UID do not start another run. New Event UIDs may trigger
additional runs: remove the Pod's trigger label after admission and clean up the
sample Deployment and Service when finished. Old events, unlabelled
pods and events from other namespaces are ignored. A queued run can also be
created explicitly with `deploy/run.yaml`.

The operator reads namespace Pods, their logs, Events, ReplicaSets, Deployments
and PodMetrics, and writes its own custom resources and status. The collector and
remediator have separate Kubernetes identities; only the backend receives the
provider key. No LLM receives Kubernetes tools
or authority to mutate workloads. Event text is bounded and treated as untrusted
evidence. Remediation runs in the separately authorised controller. Omit
`DEMO_AUTO_REMEDIATE` or set it to `false` at deployment to collect and assess
incidents without automatic workload changes. Changing that setting through
`apply.sh` rolls the remediator onto the new value.

The service is ClusterIP, intended for `kubectl port-forward`. This example has
no public authentication layer; add authenticated ingress before exposing it
beyond a trusted demonstration environment.

## GitHub Actions

The workflow actions use their own Node.js 24 runtime. The application continues
using Node.js 22 in its build and runtime containers.

[k3s-demo.yml](../../.github/workflows/k3s-demo.yml) builds the image on pull requests
and relevant main-branch pushes, creates an ephemeral k3d/k3s cluster, deploys the
operator in fixture mode, triggers the readiness failure and checks collected
evidence, the real MAS trace and verified recovery,
and retained identity after pod restart. These jobs make no provider calls.

Manual dispatch with `deploy_live=true` first runs those checks, then creates a
fresh k3s cluster in a second GitHub-hosted `ubuntu-24.04` runner. The live job
downloads the exact image that passed the fixture checks, verifies its Docker
image ID and imports it directly into that cluster. It deploys the operator
and real LLM agents, opens the Vue dashboard in a recording browser, and triggers
a Warning event from the opted-in demonstration Pod. The cluster is named
`mas-demo`; k3d generates and selects the kubeconfig context `k3d-mas-demo`.

Configure one environment secret in this repository:

| Secret | Purpose |
|---|---|
| `OPENAI_API_KEY` | Model credentials injected into the backend Secret |

1. Open **Settings → Environments → mas-k3s-demo → Environment secrets** and add
   `OPENAI_API_KEY`. Create the environment if necessary. Restrict its deployment
   branch to `main`.
2. Open **Actions → Kubernetes live MAS demonstration → Run workflow**.
3. Select `main`, enable `deploy_live`, and run the workflow.
4. Download the `mas-k3s-live-<run-id>` artefact from the completed workflow run.

The workflow creates its own kubeconfig. `KUBECONFIG_B64`, `GHCR_PULL_TOKEN`,
`GHCR_PULL_USER` and `MAS_DEMO_RUNNER` are unnecessary for this GitHub-hosted path.
Its GitHub permission is `contents: read`; no registry publishing or package token
is needed. The live job fails clearly if the OpenAI key is missing; it never
substitutes fixture responses. Pull requests and ordinary pushes run only the
credential-free fixture checks.

The recording starts before the Warning event. The artefact retains the actual
canvas video, screenshots, topology, run and observation snapshots, a result
summary, and a built interactive Vue dashboard. Fixture recordings are explicitly labelled and are saved separately as
`mas-k3s-fixture-<run-id>`. The source Pod's trigger label is removed after admission
to limit further model calls. The workload remains until collection, assessment
and recovery checks finish; the recorder rejects duplicate admissions for that Pod.
The fixture recording uses the five-second paced providers described above;
its video shows actual MAS envelopes carrying deterministic responses. Live
recordings retain actual provider timing and use the configured OpenAI models.
Both jobs deploy the dedicated remediator with automatic correction enabled and
enable payload capture. Recordings observe its retained outcome and include the
`MASRemediation` resource. Successful practical capture requires collected logs, live resource
specifications, real metric samples, every message payload and a verified
recovery. It fails explicitly when that evidence or outcome is missing.
If the final assessment requests human review or proposes no permitted action,
capture fails immediately with classification `remediation-not-proposed`.
`failure-diagnostics.json` retains the proposed action and the agent's reason;
`run.json` retains its next checks. The recorder does not wait for a recovery
that this decision cannot initiate, override the assessment or report success.
Recordings and traces
remain available for seven days; the cluster is deleted when its job finishes,
including after failure.

After downloading and extracting the artefact, open **`dashboard/index.html`**
directly in a browser. This single file embeds the compiled Vue application,
styles and the run's collected observations. It needs no server, installation,
provider key or network connection. Play or pause the flow, change speed, seek
along the timeline, inspect evidence and envelopes, and view the final assessment
and verified tool outcome. The page
labels recorded playback and distinguishes real LLM runs from provider fixtures.
Select a message in the log to inspect its captured JSON payload, including
request inputs and agent results. Payloads are embedded in the download, so
share recordings only with their intended audience. Provider credentials are
excluded. An older metadata-only recording cannot reveal payloads by changing a
browser setting: capture a new run with `SHOW_PAYLOADS=true` to include them.
Playback follows sampled host observations; it does not reconstruct network send
times or perform new inference. Messages present in the first observation form
the initial state. Forward playback animates subsequently observed envelopes.

The download and live service use the same Vue 3/TypeScript source and canvas.
The archive embeds its data; the deployed application uses the backend's live
API and SSE stream. Use the deployment commands above to run that application
in an environment with cluster access. Provider credentials stay on its backend.
GitHub Actions removes its temporary cluster after capture; the downloaded
dashboard remains usable independently of the cluster.

An existing capture can also be packaged locally:

```sh
cd examples/k3s-live
npm ci
npm run archive -- /path/to/extracted-capture
```

The workflow checks the built file through `file://` with HTTP requests blocked,
including playback, pause, speed, seeking, restart and message inspection. When
payloads were included, it compares a request and a result in the inspector with
the captured JSON. The results are retained in `dashboard/verification.json`.

### Workflow timing

Three successful runs of the current 42-case fixture workload provide the
comparison sample. They used `ubuntu-24.04`, restored the npm cache and built
the Docker image from cold layers.

| Run | Source revision | Fixture job (s) | SPIN step (s) | Image build (s) |
| --- | --- | --- | --- | --- |
| [38970073360](https://github.com/emmett08/mas-host-examples/actions/runs/38970073360) | `f227d59508e1` | 410 | 72 | 94 |
| [39012991619](https://github.com/emmett08/mas-host-examples/actions/runs/39012991619) | `f086e3e51d4c` | 412 | 72 | 93 |
| [39018218014](https://github.com/emmett08/mas-host-examples/actions/runs/39018218014) | `f086e3e51d4c` | 420 | 70 | 94 |

The fixture job median was **412 seconds**, with a 410–420 second range and
2–3 seconds of initial queue time. The latest manual live run took 672 seconds
from dispatch to completion. Its sequential jobs used 420 and 247 seconds.
The live job repeated a 96-second image build after the fixture job had tested
the same sources.

The workflow now passes that tested image through a same-run artefact. Only a
main-branch manual dispatch with `deploy_live=true` exports it. The live job
downloads the exact artefact ID, validates its archive digest and checks the
loaded Docker image ID before creating its cluster. The image archive expires
after seven days, matching the fixture recording. Rerun all jobs when that
archive has expired. Application checks, formal checks, smoke tests, recording,
offline archive checks and cleanup keep their existing order and conditions.

The saving from image reuse is **96 seconds minus save, upload, download and
load time** for that observed baseline. A future authorised live run will
measure those transfer costs. The separate
[verifier comparison](verification/README.md#verification-timing) measured a
43.50-second local saving by reducing C compilation work. The timing record
keeps local verifier results and GitHub job observations separate. Earlier
33/35-case runs, failures, cancellations and retries are outside the comparable
fixture sample. Model calls, credentials and remediation policy retain their
existing controls.


## Verification and operational limits

```sh
cd examples/k3s-live
npm test
npm run build
npm run test:host
python3 verification/verify.py     # requires SPIN and a C compiler
```

The integration test runs the real host, asserts the lateral peer request and two
distinct security-specialist invocations, checks exact reply correlation, then
replays the completed run and verifies that no messages were added. Collector
tests cover event selection, durable identity, queue limits and admission
backpressure. Remediator tests cover competing reservations, lost API responses,
restarts, stale evidence and durable report retries. The SPIN models check the
finite hybrid choreography, guarded repair and controller journal, including
the join before synthesis and crash or acknowledgement loss around mutation.
Deliberate faults exercise the safety and progress assertions.
See [verification](verification/README.md)
for assumptions, complete-search evidence and the implementation boundary.

One backend owns one execution at a time. It retains at most fifty run records;
the controller admits at most four pending resources and one event per poll.
Each run has a 300-second host deadline, sixteen call reservations and bounded
message/byte limits. The draft uses four provider calls; an admitted revision uses
one more. The plan separately bounds total invocations at sixteen. These
limits are not a monetary billing cap. Observation polls at 250 ms and the UI
receives snapshots at 300 ms; insertion sequence is durable order, not a fabricated
send timestamp. Separate host/protocol database snapshots can briefly disagree.

After a backend restart, an interrupted assessment run reopens the same retained
host journal, input and frozen plan. Completed invocations and assessments are
reused; an unknown provider effect, changed configuration or elapsed original
deadline prevents new execution. Earlier one-pass records retain their previous
safe behaviour: interrupted runs become failed for inspection.
When a host run fails, the backend reads its retained inference evidence once
using the read-only observation command. The run record, workflow summary and
`failure-diagnostics.json` artefact report the failed agent, effect ID, execution
state, provider/model, HTTP status and recognised provider error identifiers.
The public diagnostic projection accepts fixed identifiers and enum values;
it excludes raw provider messages, prompts, outputs, CLI stderr and credentials.
For example, HTTP 400 with `invalid_json_schema` identifies a rejected structured
output schema, while HTTP 401 identifies authentication rejection. Unknown
provider outcomes still require host reconciliation before any manual retry.
The PVC retains run IDs, results and host state. The host's normal reconciliation
tools govern uncertain effects. This deployment is a single-owner demonstration,
not a distributed or highly available host. Preserve the original image and
generated bundles if manually resuming a retained run. Keep only one backend
process per data directory. To start a new demonstration session after archiving
the results, use a fresh data directory or dedicated PVC.

## Sources

- [MAS host architecture](https://github.com/emmett08/mas-host/blob/main/docs/architecture.md)
- [MAS LLM/workflow contract](https://github.com/emmett08/mas-host/blob/main/docs/llm-workflows.md)
- [Kubernetes operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [Kubernetes API concurrency](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- [Kubernetes RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [Kubernetes Pod and log API](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/)
- [Resource metrics semantics](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
- [K3s packaged metrics-server](https://docs.k3s.io/installation/packaged-components)
- [Vue with TypeScript](https://vuejs.org/guide/typescript/overview)
- [k3d](https://k3d.io/)
