# Provider-result contract and CI verification

The repository [host pin](../../../host-revision.txt) and self-remediation
`PINNED_HOST` identify the same reviewed host. That host's
[inference result contract](https://github.com/emmett08/mas-host/blob/f3cc7cb1894bebd45c2d708edec27c4b8171be1a/docs/inference-results.md)
defines one result per inference identity: every eligible message must contain
one complete, exact integer-JSON value, and all such values must agree. Local
schema and peer admission checks still precede effects. Known-invalid outcomes
remain retained failures; uncertain effects remain blocked. Replay adds no
provider or tool calls. This refines the host boundary without changing Nehemiah
wire version 1 or the protocol crate dependency.

The original live run `39140672322` retained two eligible messages and two text
blocks, but neither text. Equivalent repetition is now accepted once; conflicts
remain rejected. The retained incident cannot establish which case occurred.
A fresh authorised live run is needed to establish the deployment outcome.

Run [39143210107](https://github.com/emmett08/mas-host-examples/actions/runs/39143210107/job/117721783915)
failed differently: the fifteen-case HTTP/MCP test reached its 600,000 ms parent
deadline after twelve scenarios passed with the debug host. The aggregate
`linux` job correctly rejected the failed conformance group. Conformance CI now
sets `MAS_HOST_BUILD_PROFILE=release`, which `make setup` and later Make commands
share. The direct npm invocation also uses `target/release/mas-host`. The
scenarios, deadline, executable hashing and SDK identity checks are unchanged.
Other workflows retain their existing build profile.

## Recorded checks

The [application verification receipt](evidence/provider-results/verification.json)
records **73 checks**: 24 complete safety/settlement searches with zero errors and
49 expected, replayed mutation or reachability counterexamples. SPIN 6.5.1 and
GCC 13.3.0 checked the six existing finite application models. Positive searches
ran with and without partial-order reduction. Source hashes, bounds, resource
limits and assumptions are in the receipt. The
[compressed evidence](evidence/provider-results/spin-checks.tar.xz) retains the
raw commands/logs, generated verifiers, model copies and replayable trails; its
`counterexamples/` directory contains the expanded original counterexample ZIP.

The [release-build integration log](evidence/provider-results/host-integration.log)
records **31 passing tests**, no failures, cancellations or skips, in about
41 seconds. Its fifteen-case HTTP/MCP parent completed in about 32 seconds on
the local test machine. This is measured execution, not a portable timing bound.
The suite uses real host processes and MCP stdio sessions with a scripted HTTP
provider; it makes no live inference calls. Repeated valid output completes with
five provider calls and four distinct tools. Conflicting output after one tool
stops before a second. Invalid outcomes and completed runs replay without new
provider/tool calls.

The host's separate provider-result model checks selection, validation, durable
retention, one crash and replay. Its receipt and independent review belong in the
host repository. Application and host models supply named finite control
properties and implementation correspondence, not a proof of unrestricted
composition or Rust/TypeScript refinement. No untimed model proves CI execution
time, provider cooperation, diagnostic truth or successful Kubernetes repair.
