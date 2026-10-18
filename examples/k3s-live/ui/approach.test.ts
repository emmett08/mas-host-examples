import assert from "node:assert/strict";
import { test } from "node:test";
import { approachOf, approachRuns, selectApproachRun, phaseMessages, recordedRecoverySource } from "./approach";
import type { Run, RunArchive, Snapshot } from "./types";
import type { EvidenceBundle } from "../shared/evidence";
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

test("comparison recovery links require a separately recorded outcome for the exact incident Pod", () => {
  const evidence: EvidenceBundle = { version: "mas-k8s-evidence/1", capturedAt: "2026-10-17T12:00:00Z",
    subject: { namespace: "mas-demo", name: "checkout", uid: "pod-uid" }, items: [] };
  const original: Run = { ...run("collected"), input: { incident: { evidence } },
    resolution: { version: "mas-k8s-resolution/1", status: "verified", action: "replace_readiness_probe_path",
      target: { namespace: "mas-demo", name: "checkout", uid: "deployment-uid" }, recordedAt: "2026-10-17T12:01:00Z",
      reason: "Verified", patch: [], before: null, after: null, checks: [] } };
  const archive: RunArchive = { version: "mas-demo-archive/1", capturedAt: "2026-10-17T12:01:00Z", runId: original.id,
    topology: { nodes: [], edges: [] }, snapshots: [{ run: original, observation: { messages: [] } }] };
  const comparison: Run = { ...run("comparison", "mcp"), investigation: { status: "completed", runId: "investigation", evidence: structuredClone(evidence) } };
  assert.equal(recordedRecoverySource([archive], comparison), original);
  assert.equal(recordedRecoverySource([archive], original), undefined);
  for (const key of ["namespace", "name", "uid"] as const) {
    const unrelated = structuredClone(comparison);
    unrelated.investigation!.evidence!.subject[key] = "different";
    assert.equal(recordedRecoverySource([archive], unrelated), undefined, `Mismatched ${key} must not borrow another incident's recovery`);
  }
  const unidentified = structuredClone(comparison);
  unidentified.investigation!.evidence!.subject.uid = "";
  assert.equal(recordedRecoverySource([archive], unidentified), undefined);
  const repaired = { ...comparison, resolution: original.resolution };
  assert.equal(recordedRecoverySource([archive], repaired), undefined,
    "An MCP run with its own controller report must never borrow the collected run's outcome");
  delete original.resolution;
  assert.equal(recordedRecoverySource([archive], comparison), undefined);
});
