# Release qualification in Go

Five agents decide whether a proposed release satisfies declared capacity,
security and reliability policies. The planner runs the three assessments in
parallel, increases capacity when permitted, then asks a separate checker to
reconstruct every assessment and stopping decision. The initial input needs two
capacity revisions: the result is `ready: true`, `replicas: 3`, `attempts: 3`.

This is a decision about supplied evidence. The example performs no live probes,
vulnerability scanning or deployment. The checker detects disagreement between
implementations; it cannot establish that the supplied measurements are true.

## Input and policy

Every field in `input.json` is required. Missing fields, `null` and unknown names
are rejected so absent measurements cannot silently become zero.

| Field | Meaning and accepted values |
|---|---|
| `release` | Nonblank identity, at most 128 UTF-8 bytes |
| `replicas`, `max_replicas` | Initial and maximum replicas; `1 <= replicas <= max_replicas <= 1000000` |
| `demand`, `per_replica` | Demand and capacity in the same application-defined units; nonnegative demand and positive per-replica capacity |
| `critical_vulnerabilities` | Nonnegative declared count; any positive count rejects the release |
| `observed_requests`, `failed_requests` | Positive observations with `0 <= failed_requests <= observed_requests` |
| `max_failure_basis_points` | Accepted failure rate in `0..10000`; `25` means 0.25% |

All numerical inputs are signed 64-bit integers. Capacity and reliability
comparisons avoid arithmetic overflow and rounding at the policy threshold.
Security and reliability evidence remains fixed during capacity revisions; the
example does not claim that adding a replica improves either measurement.

Each round stops at the first applicable condition in this order:

1. All three checks pass: `ready`.
2. Security fails: `security_rejected`.
3. Reliability fails: `reliability_rejected`.
4. The replica ceiling is reached: `replica_limit`.
5. The third assessment round is reached: `attempt_limit`.

Otherwise the next round adds one replica. There are at most three rounds and
two revisions. The result includes each round's reports and the final stopping
reason. The independent checker uses arbitrary-precision products and checks the
original proposal, every replica increment, intermediate reports and the first
valid stopping point.

## Audit publication and recovery

The optional `receipt_path` must be a clean absolute path whose parent already
exists. After successful checking, including a checked rejection, the planner
requests admission for the `publish_receipt` effect. It exclusively creates a
mode-0600 file containing:

```json
{
  "version": "release-receipt/1",
  "invocation_id": "the admitted effect identity",
  "output": {"the complete checked decision": "..."}
}
```

The receipt file and its parent directory are synchronised before completion is
reported. An existing path causes an error and is never overwritten. The path
is chosen by a trusted local operator; this is not a sandbox for untrusted file
access.

Setting `crash_after_receipt: true` deliberately terminates the worker after the
receipt becomes durable and before completion reaches the host. The effect must
remain uncertain until the receipt identity and output have been verified against
the journal. The repository's recovery exercise checks these bindings, resolves
the effect and resumes the original run. Ten completed child steps are retained;
the receipt bytes remain unchanged and only one effect call is admitted.

Use the repository's common setup and execution commands. Domain tests run with:

```sh
cd examples/go-release
go test -race ./...
```

The application contains typed functions, domain tests, agent configuration,
topology configuration and its ordinary Go module. The pinned host generates
worker entry points and manages transport, scheduling and recovery.
