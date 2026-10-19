# Release review through the Rust MAS MCP server

An external MCP client invokes a multi-agent workflow through
[`mas-mcp`](https://github.com/emmett08/mas-mcp). The Rust server starts the
approved, immutable application bundle in the real Rust `mas-host`. The host
uses Nehemiah to admit the policy check and a separate reviewer request. The
final decision requires both approvals. Reviewer advice therefore cannot
override a failed policy check.

The application is shared with [`a2a-review`](../a2a-review/project). This example
changes the external access protocol and exercises the official
`@modelcontextprotocol/sdk` JavaScript client, pinned to **1.32.1**. The default
reviewer uses a deterministic provider fixture. The workflow makes no model
request, deployment or remediation change, and its result concerns the supplied
synthetic release flags.

## Run the complete example

Use Linux, Node.js 22.13 or later and the host prerequisites in the root README.
From the repository root:

```sh
make setup
make mcp-setup
make mcp
```

`mcp-setup` builds the exact server commit in [`mcp-revision.txt`](../../mcp-revision.txt)
using its Cargo lockfile and installs the client from its npm lockfile. The
existing [`host-revision.txt`](../../host-revision.txt) independently pins the host.
The server and SDK remain separate dependencies.

`make mcp` builds a retained bundle and starts the actual Rust server over stdio.
It checks that:

1. MCP discovery exposes the five gateway tools and the `release_review` operation.
2. Submission completes the policy and reviewer workflow and returns an approval.
3. An identical request retains its task identity and result, including after a
   server restart. The host observation remains unchanged.
4. Changed input under an existing request ID, an unexported internal agent,
   a stale descriptor digest, an unknown task and prohibited payload disclosure
   each produce an MCP tool error.
5. A second release without rollback receives a refusal even though the fixture
   reviewer approves it.

The report is written to `.state/mcp-review/demo.json`. Temporary host, bundle
and server state are removed after the exercise. This is a client/server
interoperability and workflow acceptance check. It provides no measurement of
model quality or production suitability. Interrupted external effects require
the host's ordinary reconciliation process.

To test local checkouts, keep the host executable and SDK at the same revision:

```sh
node examples/mcp-review/demo.mjs \
  --server /absolute/path/to/mas-mcp/target/debug/mas-mcp \
  --host /absolute/path/to/mas-host/target/debug/mas-host \
  --sdk-root /absolute/path/to/mas-host \
  --report .state/mcp-review/local.json
```

## Connect a desktop MCP client

Prepare a fresh, retained directory:

```sh
mkdir -p .state
node examples/mcp-review/demo.mjs --prepare .state/mcp-client
```

The command builds the application and creates `server.json` and
`mcp-client.json`, retaining copies of the executable files. Copy the
`mas-release-review` entry from `mcp-client.json` into your client's MCP server
configuration. Its command is the absolute path to the retained `mas-mcp`
executable, with `--config` and the absolute `server.json` path as arguments.
The Linux host and its application runtime must be available wherever that
client starts the server. The server currently provides a local stdio transport.

Ask the client to perform the following sequence:

1. Call `mas_describe` and retain `descriptor_digest` and the advertised input
   schema for `release_review`.
2. Call `mas_submit` with the arguments below, replacing the digest placeholder.
3. Poll `mas_status` with `{"task_id":"release-42"}` until the state is terminal.
4. Read the completed decision from `output_json`. Call `mas_observe` with
   `{"task_id":"release-42","include_payloads":false}` to inspect the host's
   recorded message flow.

```json
{
  "request_id": "release-42",
  "operation": "release_review",
  "descriptor_digest": "COPY_THE_DIGEST_FROM_MAS_DESCRIBE",
  "input_json": "{\"release\":\"release-42\",\"has_rollback\":true,\"critical_findings\":false}"
}
```

`input_json` and `output_json` preserve the host's exact JSON representation
through MCP clients. Use a new request ID for new work. Repeat the original ID
and content only to retrieve the same admitted work. An `unknown` result means
the server cannot establish completion and requires reconciliation. Retrying
that identity does not dispatch the application again.

`mas_cancel` records cancellation intent. It cannot establish that an external
operation stopped or undo an effect. The demonstration uses completion and
replay checks because its application finishes quickly.

The configuration exports only `release_review`. Internal actors, executable
paths, bundle paths and state paths are selected by the operator. MCP callers
cannot supply them. Payload observation is disabled. The completed application
output remains visible to this local client. Keep each configuration and state
directory private to the operator who owns that client process.

For the reverse direction, where a MAS actor invokes an MCP tool, see the
[`k3s-live` example](../k3s-live) and the host's
[MCP delegate contract](https://github.com/emmett08/mas-host/blob/main/docs/mcp-tools.md).
Both directions retain the host's existing Nehemiah admission rules.
