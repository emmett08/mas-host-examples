# Live Kubernetes incident room

A Vue 3/TypeScript canvas displays real MAS request/result envelopes while four
LLM inferences investigate a Kubernetes workload warning using collected logs,
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
5. The canvas animates envelopes first observed after connection. The message
   log, correlation inspector and final output remain available after completion.
6. The recording workflow can apply one allowed readiness-probe correction using
   a deterministic tool. It records the exact patch and independently checks
   rollout, replacement Pod identity, application health and fresh metrics.

## The practical incident and outcome

The sample checkout application serves `/healthz` and `/`, but its readiness
probe requests `/readyz`. Kubernetes reports an `Unhealthy` Warning; the Pod is
running and unready. Its access logs show `/readyz` returning 404 and `/healthz`
returning 200. The live Pod, ReplicaSet and Deployment specifications identify
the faulty readiness path and the owning workload. Because the process remains
running, metrics-server can sample its real CPU and memory usage.

The expected useful outcome is a specific proposal to change the owning
Deployment's named container readiness path to `/healthz`. The LLM must cite
collected evidence IDs. It can return `action: none` and request further work
when evidence does not support that remedy; missing metrics are never zeroes,
and a current usage sample cannot rule out earlier resource pressure.

For the isolated recording, `DEMO_AUTO_REMEDIATE=true` enables a tool restricted
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

The verifier reports through a dedicated authenticated endpoint. Deployment
creates its token automatically; it is available to the backend and the trusted
recording workflow, and is excluded from workers, prompts and archives. The
Kubernetes operator and all LLM workers remain read-only.

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
which peer to contact. The four provider calls normally produce eight MAS
invocations and sixteen request/result envelopes. Failure can stop that sequence.

The canvas shows logical agents, not pods. One pod contains a dashboard/backend
and a separate Kubernetes controller container. The backend runs the Rust host
and supervised workers locally. MAS protocol admission governs actor messages;
private IPC connects workers to the host; HTTPS connects LLM adapters to providers;
SSE carries read-only observation snapshots to Vue. No MAS wire change is needed.

## Run with real LLMs on Linux

Use Node **22.13 or later**, Rust **1.99.0** and the pinned host. The repository's
standard setup also requires Go, Python and C++ for its other examples. From the
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
SHOW_PAYLOADS=true DEMO_MODE=live examples/k3s-live/deploy/apply.sh
kubectl -n mas-demo port-forward svc/mas-demo 8080:8080
```

The recording script creates the faulty workload, waits for genuine metrics and
probe logs, then opts its exact Pod into event-triggered investigation:

```sh
DEMO_MODE=live DEMO_AUTO_REMEDIATE=true node examples/k3s-live/deploy/record-demo.mjs
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
and PodMetrics, and writes its own custom resources and status. Only the operator container receives a Kubernetes service-account
token; only the backend receives the provider key. No LLM receives Kubernetes tools
or authority to mutate workloads. Event text is bounded and treated as untrusted
evidence. Remediation is a separate, narrowly constrained workflow tool rather
than an LLM Kubernetes capability.

The service is ClusterIP, intended for `kubectl port-forward`. This example has
no public authentication layer; add authenticated ingress before exposing it
beyond a trusted demonstration environment.

## GitHub Actions

[k3s-demo.yml](../../.github/workflows/k3s-demo.yml) builds the image on pull requests
and relevant main-branch pushes, creates an ephemeral k3d/k3s cluster, deploys the
operator in fixture mode, triggers the readiness failure and checks collected
evidence, the real MAS trace and verified recovery,
and retained identity after pod restart. These jobs make no provider calls.

Manual dispatch with `deploy_live=true` first runs those checks, then creates a
fresh k3s cluster in a second GitHub-hosted `ubuntu-24.04` runner. The live job
builds the image and imports it directly into that cluster, deploys the operator
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
Both recording jobs explicitly enable payload capture and the constrained demo
verifier. Successful practical capture requires collected logs, live resource
specifications, real metric samples, every message payload and a verified
recovery. It fails explicitly when that evidence or outcome is missing.
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
replays the completed run and verifies that no messages were added. The controller
tests cover event selection, durable identity, lost status responses, queue limits
and admission backpressure. The SPIN model checks the finite hybrid choreography,
including the join before final synthesis, and detects deliberate route,
correlation, observation and progress faults. See [verification](verification/README.md)
for assumptions, complete-search evidence and the implementation boundary.

One backend owns one execution at a time. It retains at most fifty run records;
the controller admits at most four pending resources and one event per poll.
Each run has a 300-second host deadline, sixteen call reservations and bounded
message/byte limits. The normal choreography uses four provider calls. These
limits are not a monetary billing cap. Observation polls at 250 ms and the UI
receives snapshots at 300 ms; insertion sequence is durable order, not a fabricated
send timestamp. Separate host/protocol database snapshots can briefly disagree.

After a backend restart, incomplete runs become failed and remain available for
inspection; this demo does not automatically repeat uncertain provider effects.
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
- [Kubernetes Pod and log API](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/)
- [Resource metrics semantics](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
- [K3s packaged metrics-server](https://docs.k3s.io/installation/packaged-components)
- [Vue with TypeScript](https://vuejs.org/guide/typescript/overview)
- [k3d](https://k3d.io/)
