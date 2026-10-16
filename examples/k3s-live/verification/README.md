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
branches settle before the root reports failure. No model transition operates
on a Kubernetes resource.

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
the `.trail` files retain the counterexamples. Generated C verifiers and build
binaries stay in isolated temporary directories. Use `--out DIRECTORY` to retain
another run separately. A missing checker, exceeded resource limit, unexpected
counterexample or missing expected counterexample exits non-zero.

SPIN command semantics follow the maintained [SPIN](https://spinroot.com/spin/Man/Spin.html),
[verifier](https://spinroot.com/spin/Man/Pan.html) and
[inline LTL](https://spinroot.com/spin/Man/ltl.html) manuals, consulted on
16 October 2026. The recorded tool is SPIN 6.5.2, the Ubuntu package available
in this execution environment.
