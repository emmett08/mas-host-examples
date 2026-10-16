# Ordinary CLI: release policy

`tools/policy-check` is a standalone Python command-line tool. It imports no MAS
SDK, accepts arguments and JSON stdin, and prints one JSON object. It approves a
service with zero critical findings. A policy refusal is a successful operation
with `approved: false`; invalid input or interrupted publication is a process
failure. It deploys nothing.

After `make setup`, run from the repository root:

```sh
make command
```

The result approves `billing`. `agents.toml` supplies a fixed executable and
flags, selects the service argument from `/service`, and passes the admitted
effect ID as `--invocation-id`. The host retains the executable by content
digest, validates the operation schemas and records one effect. Repeating the
same run reuses its outcome. The shebang selects `/usr/bin/python3`; preserve that
runtime when retaining a deployment.

The CLI also runs independently:

```sh
printf '%s\n' '{"service":"billing","critical_findings":0}' |
  examples/command-policy/tools/policy-check \
    --service billing --max-critical 0 --invocation-id standalone-001
```

For optional receipt publication, provide a fresh absolute `receipt_path` in the
input. Exclusive creation prevents overwrite. The receipt contains the admitted
effect identity and public output and is synchronised with its containing
directory. `crash_after_receipt: true` deliberately exits with code 7 after that
write, leaving the effect uncertain. The acceptance test verifies this crash,
checks the receipt identity, resolves the retained effect and resumes without
another invocation or write.

After independently checking such a receipt, `resolve --output` must contain
`{"status":"completed","output":...}` with the receipt's nested output. Supply
the verified receipt and invocation identity as separate nonempty evidence.
The original run deadline remains in force; resolution asserts the observed
external outcome and grants no automatic retry.

An LLM can delegate to `policy_check` through permitted routes; a workflow can
request it like any other actor. The host's command integration tests cover both
the CLI boundary and the shared effect lifecycle. Provider SDK commands use a
different inference envelope and remain configured under provider connections.
