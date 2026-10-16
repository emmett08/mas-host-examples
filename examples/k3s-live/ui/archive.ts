import { deduplicateMessages } from "./topology";
import { validOutcomeCombination } from "../shared/resolution";
import type { ArchiveSnapshot, Message, RunArchive } from "./types";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;
const date = (value: unknown): value is string => text(value, 64) && Number.isFinite(Date.parse(value));
function fail(detail: string): never { throw new Error(`Recorded run data is invalid: ${detail}.`); }
const identity = (message: Message) => JSON.stringify([message.sequence, message.sender, message.recipient,
  message.kind, message.correlation ?? null]);

/** Validate collected observations without manufacturing missing timestamps. */
export function parseArchive(value: unknown): RunArchive {
  const source: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!object(source) || source.version !== "mas-demo-archive/1") fail("unsupported archive version");
  if (!date(source.capturedAt) || !text(source.runId, 64)) fail("capture date or run identity is missing");
  const graph = source.topology;
  if (!object(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) ||
      graph.nodes.length < 1 || graph.nodes.length > 64 || graph.edges.length > 1024) fail("topology is missing or exceeds demo limits");
  const nodes = new Set<string>();
  for (const node of graph.nodes) {
    if (!object(node) || !text(node.id) || !text(node.label) ||
        !["client", "workflow", "llm"].includes(String(node.kind)) || nodes.has(node.id)) fail("topology node identity is invalid");
    if (node.group !== undefined && !text(node.group)) fail("topology group is invalid");
    if (node.model !== undefined && !text(node.model)) fail("topology model is invalid");
    nodes.add(node.id);
  }
  for (const edge of graph.edges) {
    if (!object(edge) || typeof edge.from !== "string" || typeof edge.to !== "string" ||
        !nodes.has(edge.from) || !nodes.has(edge.to) ||
        (edge.kind !== undefined && edge.kind !== "peer" && edge.kind !== "hierarchy")) fail("topology edge is invalid");
  }
  if (!Array.isArray(source.snapshots) || !source.snapshots.length || source.snapshots.length > 10_000) fail("timed observations are missing or exceed demo limits");
  let previousTime = -Infinity;
  let mode: string | undefined, startedAt: string | undefined;
  const retained = new Map<string, string>();
  const snapshots: ArchiveSnapshot[] = [];
  let retainedResolution: string | undefined;
  let retainedObservations: string[] = [];
  for (const item of source.snapshots) {
    if (!object(item) || !object(item.run) || item.run.id !== source.runId ||
        !["live", "fixture"].includes(String(item.run.mode)) || !date(item.run.startedAt) ||
        !["queued", "running", "completed", "failed"].includes(String(item.run.status))) fail("snapshot run identity or state differs");
    if (mode !== undefined && (item.run.mode !== mode || item.run.startedAt !== startedAt)) fail("snapshot run identity changed");
    mode = item.run.mode as string;
    startedAt = item.run.startedAt;
    if (item.run.resolution !== undefined) {
      if (!object(item.run.resolution) || !validOutcomeCombination(item.run.resolution) ||
          !['mas-k8s-resolution/1', 'mas-k8s-resolution/2'].includes(String(item.run.resolution.version))) fail("resolution outcomes are invalid");
      const serialised = JSON.stringify(item.run.resolution);
      if (retainedResolution && retainedResolution !== serialised) fail("the immutable attempt report changed");
      retainedResolution = serialised;
    } else if (retainedResolution) fail("the retained attempt report disappeared");
    const observations = item.run.reconciliations ?? [];
    if (!Array.isArray(observations) || observations.length > 8 || observations.length < retainedObservations.length) fail("reconciliation observations are invalid");
    const report = item.run.resolution;
    const encoded = observations.map((observation: unknown, index: number) => {
      if (!object(observation) || observation.version !== 'mas-k8s-reconciliation/1' || observation.sequence !== index + 1 ||
          observation.runId !== source.runId || !text(observation.id, 64) || !date(observation.observedAt) ||
          !object(report) || report.version !== 'mas-k8s-resolution/2' || observation.operationId !== report.operationId ||
          observation.attemptId !== report.attemptId || !['desired', 'original', 'changed', 'unavailable'].includes(String(observation.state))) fail("reconciliation identity differs");
      const serialised = JSON.stringify(observation);
      if (retainedObservations[index] !== undefined && retainedObservations[index] !== serialised) fail("a retained reconciliation changed");
      return serialised;
    });
    retainedObservations = encoded;
    if (item.observationAvailable !== undefined && typeof item.observationAvailable !== "boolean") fail("observation availability is invalid");
    if (!object(item.observation) || !Number.isSafeInteger(item.observation.observed_at_ms) ||
        Number(item.observation.observed_at_ms) < 0 || Number(item.observation.observed_at_ms) < previousTime ||
        !Array.isArray(item.observation.messages) || item.observation.messages.length > 128) fail("observation time or envelope order is invalid");
    previousTime = Number(item.observation.observed_at_ms);
    const messages: Message[] = [];
    let previousSequence = 0;
    const present = new Set<string>();
    for (const value of item.observation.messages) {
      if (!object(value) || !text(value.id) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 ||
          Number(value.sequence) < previousSequence || !text(value.sender) || !nodes.has(value.sender) ||
          !text(value.recipient) || !nodes.has(value.recipient) || !text(value.kind, 64) ||
          (value.correlation !== undefined && value.correlation !== null && !text(value.correlation))) fail("envelope identity or order is invalid");
      const message = value as unknown as Message;
      const known = retained.get(message.id);
      if (known !== undefined && known !== identity(message)) fail("a retained envelope changed identity");
      retained.set(message.id, identity(message));
      present.add(message.id);
      messages.push(message);
      previousSequence = message.sequence;
    }
    if (retained.size > 64 || [...retained.keys()].some(id => !present.has(id))) fail("retained envelopes disappeared or exceeded demo limits");
    const unique = deduplicateMessages(messages);
    if (unique.some((message, index) => index > 0 && message.sequence <= unique[index - 1]!.sequence)) fail("distinct envelopes share a sequence");
    snapshots.push({ ...item, observation: { ...item.observation, messages: unique } } as unknown as ArchiveSnapshot);
  }
  return { ...source, snapshots } as unknown as RunArchive;
}

export interface PlaybackFrame {
  snapshot: ArchiveSnapshot; index: number; positionMs: number; durationMs: number;
  playing: boolean; speed: number; arrivals: Message[];
}

/** A clock over sampled observations, independent of browser timers. */
export class ArchivePlayback {
  private positionMs = 0;
  private index = 0;
  private playing = false;
  private speed = 1;
  private seen: Set<string>;
  readonly offsets: number[];
  readonly durationMs: number;
  constructor(readonly archive: RunArchive) {
    const start = archive.snapshots[0]!.observation.observed_at_ms;
    this.offsets = archive.snapshots.map(snapshot => snapshot.observation.observed_at_ms - start);
    this.durationMs = this.offsets.at(-1)!;
    this.seen = new Set(archive.snapshots[0]!.observation.messages.map(message => message.id));
  }
  private frame(arrivals: Message[] = []): PlaybackFrame {
    return { snapshot: this.archive.snapshots[this.index]!, index: this.index, positionMs: this.positionMs,
      durationMs: this.durationMs, playing: this.playing, speed: this.speed, arrivals };
  }
  current(): PlaybackFrame { return this.frame(); }
  play(): PlaybackFrame {
    if (this.index === this.archive.snapshots.length - 1) this.seek(0);
    this.playing = this.archive.snapshots.length > 1;
    return this.frame();
  }
  pause(): PlaybackFrame { this.playing = false; return this.frame(); }
  setSpeed(speed: number): PlaybackFrame {
    if (![1, 2, 4, 8].includes(speed)) throw new Error("Playback speed must be 1, 2, 4 or 8");
    this.speed = speed;
    return this.frame();
  }
  seek(positionMs: number): PlaybackFrame {
    if (!Number.isFinite(positionMs)) throw new Error("Playback position must be finite");
    this.playing = false;
    this.positionMs = Math.max(0, Math.min(this.durationMs, positionMs));
    this.index = 0;
    // Seeking to zero always restores the first captured observation, including
    // when two genuine observations happen to share the same millisecond.
    if (this.positionMs > 0) for (let index = 1; index < this.offsets.length; index++) {
      if (this.offsets[index]! > this.positionMs) break;
      this.index = index;
    }
    this.seen = new Set(this.archive.snapshots[this.index]!.observation.messages.map(message => message.id));
    return this.frame();
  }
  final(): PlaybackFrame {
    this.seek(this.durationMs);
    this.index = this.archive.snapshots.length - 1;
    this.seen = new Set(this.archive.snapshots[this.index]!.observation.messages.map(message => message.id));
    return this.frame();
  }
  advance(milliseconds: number): PlaybackFrame {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Playback delta must be finite and non-negative");
    if (!this.playing) return this.frame();
    this.positionMs = Math.min(this.durationMs, this.positionMs + milliseconds * this.speed);
    const arrivals: Message[] = [];
    while (this.index + 1 < this.offsets.length && this.offsets[this.index + 1]! <= this.positionMs) {
      this.index++;
      for (const message of this.archive.snapshots[this.index]!.observation.messages) {
        if (!this.seen.has(message.id)) arrivals.push(message);
        this.seen.add(message.id);
      }
    }
    if (this.index === this.archive.snapshots.length - 1) this.playing = false;
    return this.frame(arrivals);
  }
}

export function playbackTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${Math.floor(milliseconds % 1000 / 100)}`;
}
