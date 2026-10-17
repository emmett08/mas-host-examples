import assert from "node:assert/strict";
import { test } from "node:test";
import { approachOf, approachRuns, selectApproachRun, phaseMessages } from "./approach";
import type { Run, Snapshot } from "./types";
const run = (id: string, approach?: Run["approach"]): Run => ({ id, approach, mode: "live", status: "completed", startedAt: "2026-10-17T12:00:00Z" });

test("legacy runs retain the collected approach independently of provider mode", () => {
  const legacy = run("legacy");
  const fixture = { ...run("fixture-mcp", "mcp"), mode: "fixture" };
  assert.equal(approachOf(legacy), "collected");
  assert.deepEqual(approachRuns([fixture, legacy], "collected"), [legacy]);
  assert.deepEqual(approachRuns([fixture, legacy], "mcp"), [fixture]);
});

test("tab selection restores the chosen run and never selects another approach", () => {
  const history = [run("new", "collected"), run("mcp", "mcp"), run("remembered")];
  assert.equal(selectApproachRun(history, "collected", "remembered"), "remembered");
  assert.equal(selectApproachRun(history, "collected", "mcp"), "new");
  assert.equal(selectApproachRun(history, "mcp", "missing"), "mcp");
  assert.equal(selectApproachRun([run("collected")], "mcp"), "");
});

test("the two host traces preserve independent identities and sequence numbers", () => {
  const request = { id: "same-host-sequence", sequence: 1, sender: "client", recipient: "agent", kind: "request" };
  const snapshot: Snapshot = { run: run("mcp", "mcp"), observation: { messages: [request] },
    investigationObservation: { messages: [{ ...request, recipient: "investigator" }] } };
  assert.equal(phaseMessages(snapshot, "assessment")[0]!.recipient, "agent");
  assert.equal(phaseMessages(snapshot, "investigation")[0]!.recipient, "investigator");
  assert.equal(phaseMessages(snapshot, "investigation")[0]!.sequence, 1);
  delete snapshot.investigationObservation;
  assert.deepEqual(phaseMessages(snapshot, "investigation"), []);
});
