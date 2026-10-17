# Nehemiah release review through A2A

An external A2A client invokes a workflow in the real Rust `mas-host`. A Python
policy agent checks the supplied rollback and critical-finding flags. A separate
reviewer then receives that result through admitted MAS messages. The workflow
requires both approvals; reviewer advice cannot override a failed policy check.
This is advice about synthetic input, with no deployment or remediation effects.

The default reviewer uses the host's deterministic provider fixture. It exercises
the LLM adapter, admission and retained effects without calling a model or using
credentials. The explicitly selected live mode calls OpenAI once per review.
Neither mode establishes model quality or the truth of the input flags.

## Run the credential-free demonstration

From the repository root after `make setup`:

```sh
make a2a
```

The runner copies the project into a temporary directory, builds an immutable
bundle, starts the host's optional loopback A2A gateway and runs these checks:

1. Public discovery advertises `review`; Alice's authenticated card also exposes
   `policy`. Bob's authenticated card contains only `review`.
2. The client selects `urn:mas:host-task-service:1` and pins the discovered bundle
   digest in the submission.
3. After acceptance, the client discards the response body before decoding its
   task ID, then submits the **same message identity and content**. Further
   identical retries return the same task ID.
4. Polling returns the retained policy and reviewer decision. Bob cannot inspect
   Alice's task or invoke the private policy export. Invalid credentials, a stale
   descriptor digest and changed content under the original identity are rejected.
5. A second review without rollback returns a refusal even though the deterministic
   reviewer fixture approves. This independently checks the final decision rule.

`demo.py` is a standard-library client, not the official A2A SDK. Each invocation
uses fresh random bearer tokens; the gateway config contains only their SHA-256
hashes. Tokens, configuration and temporary task state are removed after the
bounded demonstration. `make a2a` saves a credential-free report to
`.state/a2a-review/demo.json`.

The host owns routing, task identity, admission, execution and durable retry.
The demo invokes `describe` and `serve-a2a`; it supplies no replacement web server
or scheduler. Input/output schemas restrict the JSON media type. The example uses
strings and booleans, avoiding a mismatch between exact integer JSON and SDKs
that encode ProtoJSON `Struct` numbers as floating point.

## Independently maintained SDK check

```sh
python3 -m venv .tools/a2a-sdk
.tools/a2a-sdk/bin/python -m pip install -r examples/a2a-review/requirements-sdk.txt
.tools/a2a-sdk/bin/python examples/a2a-review/sdk_check.py \
  --report .state/a2a-review/official-sdk.json
```

The official `a2a-sdk==1.0.3` card resolver and `JsonRpcTransport` parse public and
authenticated cards, serialise and send `SendMessage`, repeat the same identity,
poll with `GetTask`, and decode the completed artefact. This local fixture test
provides independent client interoperability evidence. It does not certify every
A2A feature or contact a live external agent. CI runs both exercises without keys.

The [official SDK release](https://pypi.org/project/a2a-sdk/1.0.3/) implements the
A2A 1.0 API. Compare wire semantics with the
[A2A v1.0.1 specification](https://a2a-protocol.org/v1.0.1/specification/).
The SDK version, A2A protocol version and MAS extension version are separate
identifiers. These checks exercise the JSON-RPC polling profile.

## Explicit live OpenAI review

Set `OPENAI_API_KEY` in your environment, then run:

```sh
python3 examples/a2a-review/demo.py --live --model gpt-5.4-2026-03-05 \
  --report .state/a2a-review/live.json
```

This selects the host's OpenAI Responses adapter and makes billed calls. A missing
key fails before gateway startup; provider errors do not fall back to fixtures.
Each of the two distinct reviews admits at most one inference, with 512 output
tokens and a 60-second workflow deadline. Same-identity retries reuse the first
task. Token settings bound admitted work, not the provider bill. The model may
refuse an eligible release; the demo accepts that outcome and still checks the
mandatory refusal when rollback is absent.

The gateway listens on literal loopback HTTP for this exercise. Remote deployment
requires the host's documented trusted HTTPS reverse-proxy configuration and
separately provisioned credentials. Discovery never authorises new routes or
changes a frozen workflow.

To test a local checkout, pass `--host /absolute/path/to/mas-host` and
`--sdk-root /absolute/path/to/host-checkout` to either Python script. Keep the SDK
and executable from the same revision.
