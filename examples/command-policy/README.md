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

## Let a model request the CLI

The same application also declares `reviewer`, a GPT-5.4 actor permitted to
request `policy_check`. Its prompt asks it to request the policy result on its
first inference turn and return that result on its second. The CLI's operation
name and input/output schemas are supplied to the model as its delegate contract.
The host admits the request through the topology and returns the actual CLI
result in the next inference input.

To opt into live, billed inference, set `OPENAI_API_KEY`, confirm access to the
configured `gpt-5.4-2026-03-05` snapshot, and run:

```sh
make command-agent
```

The example permits two inference turns and three external calls in total: two
model calls and one CLI execution. `make command` still selects `policy_check`
directly and performs no inference. Both entries share the same tool and
operation schemas. The `reviewer_provider` connection can be overridden with a
`mas-connections/1` profile without changing the actor or tool implementation.

The prompt requests delegation; the host's allow-list permits it. Neither proves
that a live model will call the tool or faithfully report its result. Treat the
reviewer output as advisory. For mandatory policy enforcement, call `policy_check`
directly or make a workflow request it explicitly and use that recorded result
as the acceptance decision. The model has no deployment operation in this example.

Acceptance tests substitute a local HTTP Responses endpoint for the remote
provider. They exercise both model turns through the maintained OpenAI adapter,
the actual CLI through MAS request/result messages, positive and negative policy
results, and replay with no new model or command calls. The HTTP replies are
explicit fixtures; they verify integration rather than live model behaviour.
No credentials or remote model calls are needed by `make verify`.

Provider SDK commands use a different inference envelope and remain configured
under provider connections. The policy tool is an ordinary application command.
