# Live Kubernetes incident room

A Vue 3/TypeScript canvas displays real MAS request/result envelopes while four
LLM inferences investigate a Kubernetes restart warning. The default mode calls
OpenAI; it never substitutes fixture responses when credentials or models fail.
A separate, clearly labelled fixture mode exercises the real host and protocol
without calling a model.

**The GitHub Actions demonstration creates its own k3s cluster on a GitHub-hosted
Linux runner. You do not need a cluster on your Mac or an external Kubernetes
service.** See [GitHub Actions](#github-actions) for the single required secret.

## What the demonstration shows

1. A browser action or `MASDemoRun` custom resource submits bounded incident evidence.
2. The coordinator workflow starts platform and security branches in parallel.
3. The platform branch asks a platform LLM for a diagnosis, then contacts the
   security branch directly for peer critique. The independent security branch
   also calls its specialist LLM. Each invocation has its own request identity.
4. The coordinator joins both branches and asks a final LLM for an investigation
   plan. The original platform findings travel with the critique to the final agent.
5. The canvas animates envelopes first observed after connection. The message
   log, correlation inspector and final output remain available after completion.

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

Open <http://localhost:8080> and choose **Start live investigation**. Provider keys
stay in the server environment. `project/agents.toml` explicitly selects GPT-5.4
Mini for specialist work and GPT-5.4 for synthesis, using the same dated model
identifiers as the other live examples. Your provider account must support them;
edit the models there if necessary. A fresh run captures changed configuration.
This example uses OpenAI; the existing composable example retains Cursor and
compatible-provider profiles.

`SHOW_PAYLOADS=true` includes application message payloads and checkpoint values
in observations. Metadata is the default. Final run output is always displayed.
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
the real `mas-provider/1` request, wait five seconds per call and return fixed,
schema-checked JSON. This deliberate delay lets the browser subscribe before
message flow finishes; it does not measure LLM latency. The normal fixture stays
fast, and the recording flag has no effect in live mode. The inline provider code
is retained in the host bundle and uses no provider credentials or network.

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
DEMO_MODE=live examples/k3s-live/deploy/apply.sh
kubectl -n mas-demo port-forward svc/mas-demo 8080:8080
```

In another terminal, trigger an actual Warning event:

```sh
kubectl apply -f examples/k3s-live/deploy/failing-pod.yaml
kubectl -n mas-demo get masdemoruns -w
```

The deliberately failing pod is labelled `demo.mas.dev/trigger=true`. The controller
polls namespace Warning events every three seconds, checks the label on the Event
or its exact involved Pod UID, and creates a `MASDemoRun`. It starts the retained
run through the local API and updates custom-resource status. Repeated occurrence
counts on the same Event UID do not start another run. New Event UIDs may trigger
additional runs: remove the failing pod when finished. Old events, unlabelled
pods and events from other namespaces are ignored. A queued run can also be
created explicitly with `deploy/run.yaml`.

The operator reads only namespace pods/events and writes its own custom resources
and status. Only the operator container receives a Kubernetes service-account
token; only the backend receives the provider key. No LLM receives Kubernetes tools
or authority to mutate workloads. Event text is bounded and treated as untrusted
evidence. Recommendations require an engineer to gather and assess further evidence.

The service is ClusterIP, intended for `kubectl port-forward`. This example has
no public authentication layer; add authenticated ingress before exposing it
beyond a trusted demonstration environment.

## GitHub Actions

[k3s-demo.yml](../../.github/workflows/k3s-demo.yml) builds the image on pull requests
and relevant main-branch pushes, creates an ephemeral k3d/k3s cluster, deploys the
operator in fixture mode, triggers a crashing pod and checks the real MAS trace
and retained identity after pod restart. These jobs make no provider calls.

Manual dispatch with `deploy_live=true` first runs those checks, then creates a
fresh k3s cluster in a second GitHub-hosted `ubuntu-24.04` runner. The live job
builds the image and imports it directly into that cluster, deploys the operator
and real LLM agents, opens the Vue dashboard in a recording browser, and triggers
a Warning event from the labelled demonstration pod. The cluster is named
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
canvas video, screenshots, topology, run and observation snapshots, plus a result
summary. Fixture recordings are explicitly labelled and are saved separately as
`mas-k3s-fixture-<run-id>`. The failing pod is removed after admission to limit
further Warning triggers; the recorder rejects duplicate admissions for that Pod.
The fixture recording uses the five-second paced providers described above;
its video shows actual MAS envelopes carrying deterministic responses. Live
recordings retain actual provider timing and use the configured OpenAI models.
Recordings and traces
remain available for seven days; the cluster is deleted when its job finishes,
including after failure.

**GitHub Actions provides a temporary execution environment, not a permanent
dashboard URL.** The browser observes the real running system inside the runner;
you review its recording after the run. The JSON trace is retained evidence, not
an independently animated offline replay. Interactive remote access during a run
would need an authenticated connection to that runner or a separate hosted service.
The optional local and existing-cluster commands above remain available.

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
- [Vue with TypeScript](https://vuejs.org/guide/typescript/overview)
- [k3d](https://k3d.io/)
