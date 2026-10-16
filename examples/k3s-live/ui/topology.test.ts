import test from "node:test";
import assert from "node:assert/strict";
import {
  deduplicateMessages,
  isRequestComplete,
  layoutTopology,
  messageTone,
} from "./topology.ts";
import type { Message, Topology } from "./types.ts";

const request: Message = {
  id: "request-1",
  sequence: 1,
  sender: "platform",
  recipient: "diagnose",
  kind: "Request",
  correlation: "incident-42",
};

test("request completion follows a later reverse route and its request ID", () => {
  const result: Message = {
    id: "result-1",
    sequence: 2,
    sender: "diagnose",
    recipient: "platform",
    kind: "Result",
    correlation: "request-1",
  };
  assert.equal(isRequestComplete(request, [request]), false);
  assert.equal(isRequestComplete(request, [request, result]), true);
  assert.equal(
    isRequestComplete(request, [
      request,
      { ...result, correlation: "another-request" },
    ]),
    false,
  );
  assert.equal(
    isRequestComplete(request, [request, { ...result, sender: "decision" }]),
    false,
  );
  assert.equal(
    isRequestComplete(request, [request, { ...result, sequence: 0 }]),
    false,
  );
});

test("an error reply completes its request; a shared task ID alone does not", () => {
  const failure: Message = {
    id: "failure-1",
    sequence: 2,
    sender: "diagnose",
    recipient: "platform",
    kind: "Error",
    correlation: "request-1",
  };
  assert.equal(isRequestComplete(request, [request, failure]), true);
  assert.equal(
    isRequestComplete(request, [
      request,
      { ...failure, correlation: "incident-42" },
    ]),
    false,
  );
  assert.equal(messageTone("REQUEST"), "request");
  assert.equal(messageTone("result"), "result");
  assert.equal(messageTone("ProviderFailure"), "error");
});

test("snapshot duplicates share one stable envelope regardless of arrival order", () => {
  const second = { ...request, id: "request-2", sequence: 2 };
  const restored = deduplicateMessages([
    second,
    request,
    second,
    { ...request, payload: "restored" },
  ]);
  assert.deepEqual(
    restored.map((message) => message.id),
    ["request-1", "request-2"],
  );
  assert.equal(restored[0]?.payload, "restored");
  const seen = new Set(restored.map((message) => message.id));
  assert.equal(
    deduplicateMessages([request, second]).filter(
      (message) => !seen.has(message.id),
    ).length,
    0,
  );
});

const topology: Topology = {
  nodes: [
    { id: "client", label: "Incident event", kind: "client", group: "ingress" },
    {
      id: "coordinator",
      label: "Coordinator",
      kind: "workflow",
      group: "coordination",
    },
    {
      id: "platform",
      label: "Platform branch",
      kind: "workflow",
      group: "coordination",
    },
    {
      id: "security",
      label: "Security branch",
      kind: "workflow",
      group: "coordination",
    },
    {
      id: "diagnose",
      label: "Platform specialist",
      kind: "llm",
      group: "specialists",
    },
    {
      id: "security_review",
      label: "Security specialist",
      kind: "llm",
      group: "specialists",
    },
    {
      id: "decision",
      label: "Investigation plan",
      kind: "llm",
      group: "decision",
    },
  ],
  edges: [],
};

for (const [width, height] of [
  [1000, 470],
  [330, 690],
  [600, 690],
]) {
  test(`hybrid topology fits ${width}px canvas without overlapping nodes`, () => {
    const nodes = layoutTopology(topology, width!, height!);
    assert.equal(nodes.length, topology.nodes.length);
    for (const node of nodes) {
      assert.ok(
        node.x >= 28 && node.x <= width! - 28,
        `${node.id} horizontal bound`,
      );
      assert.ok(
        node.y >= 28 && node.y <= height! - 65,
        `${node.id} label bound`,
      );
      for (const peer of nodes)
        if (peer.id !== node.id) {
          assert.ok(
            Math.hypot(node.x - peer.x, node.y - peer.y) > 75,
            `${node.id} / ${peer.id} separation`,
          );
        }
    }
  });
}
