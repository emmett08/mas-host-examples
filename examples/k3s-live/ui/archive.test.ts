import assert from "node:assert/strict";
import { test } from "node:test";
import { ArchivePlayback, parseArchive, playbackTime } from "./archive";
import type { Message } from "./types";

const request: Message = { id: "request-1", sequence: 1, sender: "client", recipient: "agent", kind: "request" };
const result: Message = { id: "result-1", sequence: 2, sender: "agent", recipient: "client", kind: "result", correlation: "request-1" };
function archive() {
  return { version: "mas-demo-archive/1", capturedAt: "2026-10-16T12:00:02Z", runId: "recorded-1",
    topology: { mode: "live", nodes: [ { id: "client", label: "Incident", kind: "client" },
      { id: "agent", label: "Specialist", kind: "llm" } ], edges: [{ from: "client", to: "agent" }] },
    snapshots: [
      { run: { id: "recorded-1", mode: "live", status: "running", startedAt: "2026-10-16T12:00:00Z" },
        observation: { observed_at_ms: 1_000, messages: [] as Message[] } },
      { run: { id: "recorded-1", mode: "live", status: "running", startedAt: "2026-10-16T12:00:00Z" },
        observation: { observed_at_ms: 1_200, messages: [request] } },
      { run: { id: "recorded-1", mode: "live", status: "running", startedAt: "2026-10-16T12:00:00Z" },
        observation: { observed_at_ms: 1_250, messages: [request, request] } },
      { run: { id: "recorded-1", mode: "live", status: "completed", startedAt: "2026-10-16T12:00:00Z", output: { final: "assessment" } },
        observation: { observed_at_ms: 1_800, messages: [request, result] } },
    ] };
}

test('playback preserves an unknown attempt and reveals later observations only at their recorded sample', () => {
  const data = archive();
  const original = { version: 'mas-k8s-resolution/2', status: 'failed', operationId: 'operation-1', attemptId: 'attempt-1',
    effectOutcome: 'unknown', verificationOutcome: 'not_run', action: 'replace_readiness_probe_path',
    target: { namespace: 'mas-demo', name: 'mas-demo-checkout', uid: 'uid-1' }, recordedAt: '2026-10-16T12:00:02Z',
    reason: 'Response lost', patch: [], before: null, after: null, checks: [] };
  Object.assign(data.snapshots.at(-1)!.run, { resolution: original });
  const next = structuredClone(data.snapshots.at(-1)!);
  next.observation.observed_at_ms = 2_000;
  Object.assign(next.run, { reconciliations: [{ version: 'mas-k8s-reconciliation/1', id: 'a'.repeat(64),
    sequence: 1, runId: data.runId, operationId: original.operationId, attemptId: original.attemptId,
    observedAt: '2026-10-16T12:00:03Z', state: 'desired' }] });
  data.snapshots.push(next);
  const clock = new ArchivePlayback(parseArchive(data));
  assert.equal(clock.seek(800).snapshot.run.reconciliations, undefined);
  assert.equal(clock.final().snapshot.run.reconciliations!.length, 1);
  assert.equal(clock.final().snapshot.run.resolution!.version, 'mas-k8s-resolution/2');
  assert.deepEqual(clock.final().snapshot.run.resolution, original);
  const rewritten = structuredClone(data);
  Object.assign(rewritten.snapshots.at(-1)!.run, { resolution: { ...original, effectOutcome: 'applied' } });
  assert.throws(() => parseArchive(rewritten), /immutable attempt report/);
});

test("archive parsing preserves collected timestamps, normalises duplicate IDs and checks run identity", () => {
  const data = parseArchive(JSON.stringify(archive()));
  assert.deepEqual(data.snapshots.map(snapshot => snapshot.observation.observed_at_ms), [1000, 1200, 1250, 1800]);
  assert.equal(data.snapshots[2]!.observation.messages.length, 1);
  const wrongVersion = archive(); wrongVersion.version = "future-version";
  assert.throws(() => parseArchive(wrongVersion), /archive version/);
  const wrongIdentity = archive(); wrongIdentity.snapshots[1]!.run.id = "different-run";
  assert.throws(() => parseArchive(wrongIdentity), /run identity/);
  const wrongMode = archive(); wrongMode.snapshots[1]!.run.mode = "fixture";
  assert.throws(() => parseArchive(wrongMode), /run identity changed/);
  const wrongStart = archive(); wrongStart.snapshots[1]!.run.startedAt = "2026-10-16T12:00:01Z";
  assert.throws(() => parseArchive(wrongStart), /run identity changed/);
});

test("archive rejects missing/regressing observation times, changed envelopes and invalid sequence order", () => {
  const regressed = archive(); regressed.snapshots[2]!.observation.observed_at_ms = 1199;
  assert.throws(() => parseArchive(regressed), /observation time/);
  const missing = archive(); delete (missing.snapshots[0]!.observation as { observed_at_ms?: number }).observed_at_ms;
  assert.throws(() => parseArchive(missing), /observation time/);
  const changed = archive(); changed.snapshots[2]!.observation.messages = [{ ...request, recipient: "client" }];
  assert.throws(() => parseArchive(changed), /changed identity/);
  const vanished = archive(); vanished.snapshots[2]!.observation.messages = [];
  assert.throws(() => parseArchive(vanished), /disappeared/);
  const unordered = archive(); unordered.snapshots[3]!.observation.messages = [result, request];
  assert.throws(() => parseArchive(unordered), /envelope identity or order/);
  const duplicateSequence = archive(); duplicateSequence.snapshots[3]!.observation.messages = [request, { ...result, sequence: 1 }];
  assert.throws(() => parseArchive(duplicateSequence), /share a sequence/);
});

test("playback starts paused at the first real sample and advances using observed offsets", () => {
  const clock = new ArchivePlayback(parseArchive(archive()));
  assert.equal(clock.current().playing, false);
  assert.equal(clock.current().snapshot.observation.messages.length, 0);
  assert.deepEqual(clock.offsets, [0, 200, 250, 800]);
  assert.equal(clock.advance(1000).positionMs, 0);
  clock.play();
  assert.equal(clock.advance(199).index, 0);
  assert.deepEqual(clock.advance(1).arrivals.map(message => message.id), ["request-1"]);
  assert.deepEqual(clock.advance(50).arrivals, []);
  const final = clock.advance(550);
  assert.deepEqual(final.arrivals.map(message => message.id), ["result-1"]);
  assert.equal(final.playing, false);
  assert.equal(final.snapshot.run.status, "completed");
  assert.deepEqual(final.snapshot.run.output, { final: "assessment" });
});

test("pause freezes the clock; seeking and restarting restore state without arrivals or future output", () => {
  const clock = new ArchivePlayback(parseArchive(archive()));
  clock.play(); clock.advance(300);
  const paused = clock.pause();
  assert.equal(clock.advance(10000).positionMs, paused.positionMs);
  assert.deepEqual(clock.final().arrivals, []);
  const earlier = clock.seek(200);
  assert.equal(earlier.playing, false);
  assert.equal(earlier.snapshot.run.output, undefined);
  assert.deepEqual(earlier.arrivals, []);
  clock.play();
  assert.deepEqual(clock.advance(600).arrivals.map(message => message.id), ["result-1"]);
  const restarted = clock.seek(0);
  assert.equal(restarted.snapshot.observation.messages.length, 0);
  assert.equal(restarted.snapshot.run.output, undefined);
  assert.deepEqual(restarted.arrivals, []);
  clock.play();
  assert.deepEqual(clock.advance(200).arrivals.map(message => message.id), ["request-1"]);
});

test("playback speed changes time progression and skipped samples animate each newly seen identity once", () => {
  const clock = new ArchivePlayback(parseArchive(archive()));
  clock.setSpeed(4); clock.play();
  const frame = clock.advance(200);
  assert.equal(frame.positionMs, 800);
  assert.deepEqual(frame.arrivals.map(message => message.id), ["request-1", "result-1"]);
  assert.throws(() => clock.setSpeed(3), /Playback speed/);
  assert.throws(() => clock.advance(-1), /non-negative/);
  assert.throws(() => clock.seek(NaN), /finite/);
  assert.equal(playbackTime(13942), "0:13.9");
});

test("equal observed times keep capture order and an existing first-sample envelope has no fabricated arrival", () => {
  const data = archive();
  data.snapshots = data.snapshots.slice(1);
  data.snapshots.forEach(snapshot => { snapshot.observation.observed_at_ms = 1200; });
  const clock = new ArchivePlayback(parseArchive(data));
  assert.equal(clock.current().snapshot.observation.messages.length, 1);
  assert.deepEqual(clock.current().arrivals, []);
  clock.play();
  assert.deepEqual(clock.advance(0).arrivals.map(message => message.id), ["result-1"]);
  assert.equal(clock.seek(0).index, 0);
  assert.equal(clock.final().index, 2);
});

test("seeking restores captured evidence but never reveals a future tool recovery", () => {
  const data = archive();
  const evidence = { version: "mas-k8s-evidence/1", capturedAt: "2026-10-16T11:59:59Z",
    subject: { namespace: "mas-demo", name: "checkout-1", uid: "pod-1" },
    items: [{ id: "metrics", kind: "metrics", status: "unavailable", source: "/apis/metrics.k8s.io", observedAt: "2026-10-16T11:59:59Z", truncated: false, data: null, reason: "No current sample" }] };
  for (const sample of data.snapshots) Object.assign(sample.run, { input: { incident: { evidence } } });
  Object.assign(data.snapshots.at(-1)!.run, { resolution: { version: "mas-k8s-resolution/1", status: "verified",
    action: "replace_readiness_probe_path", recordedAt: "2026-10-16T12:00:02Z", reason: "Recovery checks passed",
    target: { namespace: "mas-demo", name: "mas-demo-checkout", uid: "deployment-1" },
    patch: [], before: {}, after: {},
    checks: [{ name: "functional-http", passed: true, detail: "HTTP 200" }] } });
  const clock = new ArchivePlayback(parseArchive(data));
  assert.deepEqual(clock.current().snapshot.run.input?.incident?.evidence, evidence);
  assert.equal(clock.current().snapshot.run.resolution, undefined);
  assert.equal(clock.final().snapshot.run.resolution?.status, "verified");
  const earlier = clock.seek(200).snapshot.run;
  assert.equal(earlier.resolution, undefined);
  assert.deepEqual(earlier.input?.incident?.evidence, evidence);
});

test('comparison archives retain separate approaches and reject duplicates or nested comparisons', () => {
  const baseline = archive();
  const mcp = archive();
  mcp.runId = 'mcp-run';
  for (const snapshot of mcp.snapshots) Object.assign(snapshot.run, { id: mcp.runId, approach: 'mcp' });
  const parsed = parseArchive({ ...baseline, comparisons: [mcp] });
  assert.equal(parsed.comparisons![0]!.snapshots[0]!.run.approach, 'mcp');
  assert.equal(parsed.snapshots[0]!.run.approach, undefined);
  assert.throws(() => parseArchive({ ...baseline, comparisons: [baseline] }), /distinct runs and approaches/);
  assert.throws(() => parseArchive({ ...baseline, comparisons: [{ ...mcp, comparisons: [] }] }), /nested/);
  assert.throws(() => parseArchive({ ...baseline, comparisons: [mcp, mcp] }), /comparison archives/);
  const changed = archive();
  Object.assign(changed.snapshots.at(-1)!.run, { approach: 'mcp' });
  assert.throws(() => parseArchive(changed), /identity changed/);
});

test('MCP traces and frozen evidence survive replay without merging host sequences', () => {
  const data = archive();
  const investigationTopology = { nodes: [{ id: 'client', label: 'Incident', kind: 'client' },
    { id: 'investigator', label: 'Investigator', kind: 'llm' }], edges: [{ from: 'client', to: 'investigator' }] };
  const probe = { ...request, id: 'probe-1', recipient: 'investigator' };
  for (const [index, snapshot] of data.snapshots.entries()) {
    Object.assign(snapshot.run, { approach: 'mcp', investigation: { runId: data.runId,
      status: index === data.snapshots.length - 1 ? 'completed' : 'running', calls: [] } });
    Object.assign(snapshot, { investigationTopology,
      investigationObservation: { observed_at_ms: snapshot.observation.observed_at_ms, messages: index ? [{ ...probe }] : [] } });
  }
  Object.assign(data.snapshots.at(-1)!.run, { investigation: { runId: data.runId, status: 'completed',
    evidence: { items: [{ id: 'pod.status', status: 'collected', data: { ready: false } }] },
    calls: [{ id: 'call-1', tool: 'get_pod_status', status: 'collected', evidenceIds: ['pod.status'] }] } });
  const parsed = parseArchive(data);
  const clock = new ArchivePlayback(parsed);
  assert.equal(clock.current().snapshot.run.investigation!.calls!.length, 0);
  assert.equal(clock.final().snapshot.investigationObservation!.messages[0]!.sequence, 1);
  assert.equal(clock.final().snapshot.observation.messages[0]!.sequence, 1);
  assert.equal(clock.final().snapshot.run.investigation!.calls![0]!.tool, 'get_pod_status');
  assert.equal(clock.seek(0).snapshot.run.investigation!.evidence, undefined);
  const changed = structuredClone(parsed);
  changed.snapshots.at(-1)!.investigationObservation!.messages[0]!.recipient = 'client';
  assert.throws(() => parseArchive(changed), /investigation envelope changed identity/);
  const changedEvidence = structuredClone(parsed);
  const extra = structuredClone(changedEvidence.snapshots.at(-1)!);
  extra.observation.observed_at_ms += 100;
  extra.investigationObservation!.observed_at_ms! += 100;
  extra.run.investigation!.evidence!.items[0]!.data = { ready: true };
  changedEvidence.snapshots.push(extra);
  assert.throws(() => parseArchive(changedEvidence), /frozen investigation evidence changed/);
});

test('replay orders concurrent host observations without rewriting either journal timestamp', () => {
  const data = archive();
  const first = data.snapshots[0]!, final = data.snapshots.at(-1)!;
  delete (first.observation as { observed_at_ms?: number }).observed_at_ms;
  final.observation.observed_at_ms = 1_900;
  Object.assign(first, { observedAtMs: 2_000, observationAvailable: false,
    investigationObservation: { observed_at_ms: 2_000, messages: [] } });
  Object.assign(final, { observedAtMs: 2_100,
    investigationObservation: { observed_at_ms: 2_100, messages: [] } });
  Object.assign(first.run, { approach: 'mcp' }); Object.assign(final.run, { approach: 'mcp' });
  data.snapshots = [first, final];
  const parsed = parseArchive(data), clock = new ArchivePlayback(parsed);
  assert.deepEqual(clock.offsets, [0, 100]);
  assert.equal(parsed.snapshots[0]!.observation.observed_at_ms, undefined);
  assert.equal(parsed.snapshots[1]!.observation.observed_at_ms, 1_900);
  assert.equal(parsed.snapshots[1]!.investigationObservation!.observed_at_ms, 2_100);
  const inconsistent = structuredClone(parsed); inconsistent.snapshots[0]!.observationAvailable = true;
  assert.throws(() => parseArchive(inconsistent), /observation time/);
  const fabricated = structuredClone(parsed); fabricated.snapshots[1]!.observedAtMs = 2_500;
  assert.throws(() => parseArchive(fabricated), /observation time/);
});
