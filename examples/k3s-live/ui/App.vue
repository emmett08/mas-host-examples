<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import TopologyCanvas from "./components/TopologyCanvas.vue";
import { ArchivePlayback, playbackTime, type PlaybackFrame } from "./archive";
import {
  deduplicateMessages,
  formatDuration,
  isRequestComplete,
  messageTone,
} from "./topology";
import type { Message, Run, RunArchive, Snapshot, Topology } from "./types";

const props = defineProps<{ archive?: RunArchive; archiveError?: string; archiveRequested?: boolean }>();
const isArchive = computed(() => Boolean(props.archiveRequested || props.archive));
const playback = ref<PlaybackFrame>();
const canvasReset = ref(0);
let playbackClock: ArchivePlayback | undefined;
let playbackWallTime = 0;

const topology = ref<Topology>({ nodes: [], edges: [] });
const runs = ref<Run[]>([]);
const selectedRunId = ref("");
const messages = ref<Message[]>([]);
const arrivals = ref<Message[]>([]);
const selectedMessageId = ref<string | null>(null);
const selectedNodeId = ref<string | null>("coordinator");
const filter = ref("all");
const error = ref("");
const streamError = ref("");
const observationAvailable = ref<boolean | null>(null);
const loading = ref(true);
const starting = ref(false);
const connection = ref<
  "idle" | "connecting" | "connected" | "reconnecting" | "closed"
>("idle");
const now = ref(Date.now());
const newRunId = ref("");
const historyError = ref("");
let stream: EventSource | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let historyTimer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;
let epoch = 0;
let disposed = false;
let hasSnapshot = false;
let seen = new Set<string>();

const currentRun = computed(() =>
  runs.value.find((run) => run.id === selectedRunId.value),
);
const mode = computed(() => currentRun.value?.mode ?? topology.value.mode);
const isLive = computed(() => mode.value === "live");
const isFixture = computed(() => mode.value === "fixture");
const isLaunchLive = computed(() => topology.value.mode === "live");
const isLaunchFixture = computed(() => topology.value.mode === "fixture");
const selectedMessage = computed(() =>
  messages.value.find((message) => message.id === selectedMessageId.value),
);
const selectedNode = computed(() =>
  topology.value.nodes.find((node) => node.id === selectedNodeId.value),
);
const requests = computed(() =>
  messages.value.filter((message) => messageTone(message.kind) === "request"),
);
const pending = computed(() =>
  requests.value.filter(
    (request) => !isRequestComplete(request, messages.value),
  ),
);
const llmRequests = computed(() =>
  requests.value.filter((request) =>
    topology.value.nodes.some(
      (node) => node.id === request.recipient && node.kind === "llm",
    ),
  ),
);
const filteredMessages = computed(() =>
  [...messages.value]
    .reverse()
    .filter(
      (message) =>
        filter.value === "all" || messageTone(message.kind) === filter.value,
    ),
);
const output = computed(() => currentRun.value?.output);
const hasOutput = computed(
  () => output.value !== undefined && output.value !== null,
);
const elapsed = computed(() =>
  currentRun.value
    ? formatDuration(currentRun.value.startedAt, now.value)
    : "—",
);
const active = computed(
  () => currentRun.value && !terminal(currentRun.value.status),
);
const observationNotice = computed(() =>
  observationAvailable.value === false
    ? active.value
      ? "Waiting for host state. Observation data has not become available yet."
      : "Observation unavailable. Inspect the retained host state for this run; an empty log does not establish that no messages were sent."
    : "",
);
const emptyLogTitle = computed(() =>
  isArchive.value ? "No envelopes in this recorded observation" : !currentRun.value
    ? "The next investigation starts here"
    : observationAvailable.value === false
      ? active.value
        ? "Waiting for host state"
        : "Observation unavailable"
      : active.value
        ? "Waiting for the first envelope"
        : "This run recorded no envelopes",
);
const emptyLogCopy = computed(() =>
  isArchive.value ? "Play the recording or move along the observed timeline to inspect later messages." : !currentRun.value
    ? "Start a run to observe actual requests and results between agents."
    : active.value
      ? "Provider calls can take time. Messages appear as mas-host records them."
      : "Select another run or start an investigation to observe its message flow.",
);
const statusLabel = computed(() => currentRun.value ? `${isArchive.value ? "Recorded " : ""}${currentRun.value.status}` : "Ready");
const nodeActivity = computed(() =>
  selectedNode.value
    ? messages.value.filter(
        (message) =>
          message.sender === selectedNode.value?.id ||
          message.recipient === selectedNode.value?.id,
      )
    : [],
);

function terminal(status: string): boolean {
  return [
    "completed",
    "succeeded",
    "success",
    "failed",
    "error",
    "cancelled",
    "timed_out",
  ].includes(status.toLowerCase());
}

function nodeLabel(id: string): string {
  return topology.value.nodes.find((node) => node.id === id)?.label ?? id;
}

function kindLabel(message: Message): string {
  const tone = messageTone(message.kind);
  return tone === "other"
    ? message.kind
    : tone[0].toUpperCase() + tone.slice(1);
}

function stateLabel(message: Message): string {
  const tone = messageTone(message.kind);
  if (tone === "error") return "Error";
  if (tone !== "request") return "Observed";
  return isRequestComplete(message, messages.value)
    ? "Answered"
    : currentRun.value && terminal(currentRun.value.status)
      ? "Unanswered"
      : "Pending";
}

function display(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? "No payload recorded.";
}

function shortTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}

function recordingDate(value: string): string {
  return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" });
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      detail = body.error ?? body.message ?? detail;
    } catch {
      /* Preserve the HTTP error when the response has no JSON body. */
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

function upsertRun(run: Run) {
  const existing = runs.value.findIndex((item) => item.id === run.id);
  if (existing >= 0) runs.value[existing] = { ...runs.value[existing], ...run };
  else runs.value = [run, ...runs.value];
}

function connect(id: string) {
  if (isArchive.value) return;
  stream?.close();
  epoch++;
  const thisEpoch = epoch;
  messages.value = [];
  arrivals.value = [];
  selectedMessageId.value = null;
  streamError.value = "";
  observationAvailable.value = null;
  hasSnapshot = false;
  seen = new Set();
  if (!id) {
    connection.value = "idle";
    return;
  }
  connection.value = "connecting";
  const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  stream = source;
  source.onopen = () => {
    if (thisEpoch !== epoch || disposed) return;
    connection.value = "connected";
    streamError.value = "";
  };
  const snapshot = (event: MessageEvent) => {
    if (thisEpoch !== epoch || disposed) return;
    try {
      const data = JSON.parse(event.data) as Snapshot;
      if (
        !data.run?.id ||
        data.run.id !== id ||
        !Array.isArray(data.observation?.messages)
      )
        throw new Error("The observation snapshot has an unexpected format.");
      const next = deduplicateMessages(data.observation.messages);
      observationAvailable.value = data.observationAvailable ?? true;
      const unseen = next.filter((message) => !seen.has(message.id));
      // Initial and reconnect snapshots restore state. Only envelopes first observed
      // after initial state are animated; replayed IDs cannot create new pulses.
      arrivals.value = hasSnapshot ? unseen : [];
      for (const message of next) seen.add(message.id);
      messages.value = next;
      hasSnapshot = true;
      upsertRun(data.run);
      connection.value = "connected";
      streamError.value = "";
      if (terminal(data.run.status)) {
        source.close();
        connection.value = "closed";
      }
    } catch (caught) {
      streamError.value =
        caught instanceof Error
          ? caught.message
          : "Unable to read the observation snapshot.";
    }
  };
  source.addEventListener("snapshot", snapshot as EventListener);
  source.onmessage = snapshot;
  source.onerror = () => {
    if (
      thisEpoch !== epoch ||
      disposed ||
      source.readyState === EventSource.CLOSED
    )
      return;
    connection.value = "reconnecting";
    streamError.value =
      "Observation connection interrupted. Reconnecting automatically; the next snapshot restores the message log.";
  };
}

watch(selectedRunId, (id) => {
  if (isArchive.value) return;
  if (newRunId.value === id) newRunId.value = "";
  connect(id);
});

async function refreshRuns() {
  if (isArchive.value) return;
  if (refreshing || loading.value || disposed) return;
  refreshing = true;
  try {
    const result = await api<Run[] | { runs: Run[] }>("/api/runs");
    if (disposed) return;
    const history = Array.isArray(result) ? result : result.runs;
    const unknown = history.filter(
      (run) => !runs.value.some((existing) => existing.id === run.id),
    );
    const previous = new Map(runs.value.map((run) => [run.id, run]));
    runs.value = history.map((run) => ({ ...previous.get(run.id), ...run }));
    if (!selectedRunId.value && history.length)
      selectedRunId.value = history[0].id;
    else if (unknown.length) newRunId.value = unknown[0].id;
    historyError.value = "";
  } catch {
    if (!disposed)
      historyError.value =
        "Run history is temporarily unavailable. Retrying automatically.";
  } finally {
    refreshing = false;
  }
}

async function load() {
  if (isArchive.value) {
    loading.value = false;
    error.value = props.archiveError ?? "";
    if (props.archive) {
      topology.value = props.archive.topology;
      playbackClock = new ArchivePlayback(props.archive);
      selectedRunId.value = props.archive.runId;
      applyPlayback(playbackClock.current(), true);
    }
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const [graph, history] = await Promise.all([
      api<Topology>("/api/topology"),
      api<Run[] | { runs: Run[] }>("/api/runs"),
    ]);
    if (disposed) return;
    topology.value = graph;
    runs.value = Array.isArray(history) ? history : history.runs;
    if (!selectedRunId.value && runs.value.length)
      selectedRunId.value = runs.value[0].id;
  } catch (caught) {
    if (!disposed)
      error.value =
        caught instanceof Error
          ? caught.message
          : "Unable to connect to the demo server.";
  } finally {
    if (!disposed) loading.value = false;
  }
}

async function startRun() {
  if (isArchive.value) return;
  starting.value = true;
  error.value = "";
  try {
    const result = await api<Run | { run: Run }>("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "pod-crash" }),
    });
    if (disposed) return;
    const run = "run" in result ? result.run : result;
    upsertRun(run);
    selectedRunId.value = run.id;
  } catch (caught) {
    if (!disposed)
      error.value =
        caught instanceof Error
          ? caught.message
          : "Unable to start an investigation.";
  } finally {
    if (!disposed) starting.value = false;
  }
}

function applyPlayback(frame: PlaybackFrame, reset = false) {
  playback.value = frame;
  // Replacing the complete record removes future output/error fields on seek.
  runs.value = [frame.snapshot.run];
  messages.value = frame.snapshot.observation.messages;
  arrivals.value = reset ? [] : frame.arrivals;
  observationAvailable.value = frame.snapshot.observationAvailable ?? true;
  now.value = frame.snapshot.observation.observed_at_ms;
  if (reset) canvasReset.value++;
  if (selectedMessageId.value && !messages.value.some(message => message.id === selectedMessageId.value)) selectedMessageId.value = null;
}

function togglePlayback() {
  if (!playbackClock || !playback.value) return;
  const wasPlaying = playback.value.playing;
  const atEnd = playback.value.index === playbackClock.archive.snapshots.length - 1;
  applyPlayback(wasPlaying ? playbackClock.pause() : playbackClock.play(), wasPlaying || atEnd);
  playbackWallTime = performance.now();
}

function seekPlayback(event: Event) {
  if (playbackClock) applyPlayback(playbackClock.seek(Number((event.target as HTMLInputElement).value)), true);
}

function restartPlayback() {
  if (playbackClock) applyPlayback(playbackClock.seek(0), true);
}

function finalPlayback() {
  if (playbackClock) applyPlayback(playbackClock.final(), true);
}

function changePlaybackSpeed(event: Event) {
  if (playbackClock) applyPlayback(playbackClock.setSpeed(Number((event.target as HTMLSelectElement).value)));
  playbackWallTime = performance.now();
}

function selectMessage(message: Message) {
  selectedMessageId.value = message.id;
  selectedNodeId.value = null;
}

function selectNode(id: string) {
  selectedNodeId.value = id;
  selectedMessageId.value = null;
}

onMounted(() => {
  void load();
  if (isArchive.value) {
    playbackWallTime = performance.now();
    timer = setInterval(() => {
      const wallTime = performance.now();
      if (playbackClock && playback.value?.playing) applyPlayback(playbackClock.advance(wallTime - playbackWallTime));
      playbackWallTime = wallTime;
    }, 50);
    return;
  }
  timer = setInterval(() => {
    if (active.value) now.value = Date.now();
  }, 1000);
  historyTimer = setInterval(() => {
    void refreshRuns();
  }, 3000);
});

onBeforeUnmount(() => {
  disposed = true;
  epoch++;
  stream?.close();
  if (timer) clearInterval(timer);
  if (historyTimer) clearInterval(historyTimer);
});
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <a
        class="brand"
        href="https://github.com/emmett08/mas-host-examples"
        target="_blank"
        rel="noreferrer"
        aria-label="MAS examples on GitHub"
      >
        <svg
          class="brand-icon"
          viewBox="0 0 32 32"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m16 3 12 7v13l-12 7-12-7V10L16 3Z"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <path
            d="m4 10 12 7 12-7M16 17v13M10 13.5l12-7M10 26.5v-13"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <circle cx="16" cy="17" r="3" fill="currentColor" />
        </svg>
        <span
          >MAS<span class="brand-divider">/</span
          ><span class="brand-product">incident room</span></span
        >
      </a>
      <div class="header-meta">
        <span class="environment"
          ><span class="tiny-square" /> {{ isArchive ? "Recorded run · playback" : "Kubernetes · k3s" }}</span
        ><a
          class="source-link"
          href="https://github.com/emmett08/mas-host-examples/tree/main/examples/k3s-live"
          target="_blank"
          rel="noreferrer"
          >View source <span aria-hidden="true">↗</span></a
        >
      </div>
    </header>

    <main>
      <section class="intro" aria-labelledby="page-title">
        <div>
          <div class="eyebrow">
            <span class="eyebrow-line" /> AGENT SYSTEMS · {{ isArchive ? "RECORDED OBSERVATIONS" : "LIVE OBSERVABILITY" }}
          </div>
          <h1 id="page-title">
            One incident.<br class="mobile-break" />
            A team of agents.
          </h1>
          <p class="intro-copy">
            Follow a Kubernetes investigation across supervised workflows,
            specialist LLMs and peer critique.
          </p>
        </div>
        <div class="intro-tag">
          <span class="hybrid-mark" aria-hidden="true">⌘</span>
          <div>
            <strong>Hybrid topology</strong
            ><span>Hierarchy + parallel branches + peer exchange</span>
          </div>
        </div>
      </section>

      <div v-if="error" class="notice error-notice" role="alert">
        <span>{{ error }}</span
        ><button
          v-if="!isArchive && !topology.nodes.length"
          class="text-button"
          @click="load"
        >
          Retry connection</button
        ><button
          v-else
          class="dismiss-button"
          aria-label="Dismiss error"
          @click="error = ''"
        >
          ×
        </button>
      </div>

      <section v-if="isArchive" class="playback-bar" aria-label="Recording playback controls">
        <div class="recording-heading">
          <div><strong>Recorded run · playback</strong><span>{{ mode === "live" ? "Real LLM run" : mode === "fixture" ? "Fixture · no LLM calls" : "Recording unavailable" }}</span></div>
          <span v-if="props.archive" class="capture-date">Captured {{ recordingDate(props.archive.capturedAt) }}</span>
        </div>
        <template v-if="playback">
          <div class="playback-controls">
            <button class="playback-button primary" :disabled="props.archive?.snapshots.length === 1" @click="togglePlayback">{{ playback.playing ? "Pause" : "Play" }}</button>
            <button class="playback-button" @click="restartPlayback">Restart</button>
            <button class="playback-button" @click="finalPlayback">View final</button>
            <label class="playback-speed">Speed <select :value="playback.speed" aria-label="Playback speed" @change="changePlaybackSpeed"><option v-for="speed in [1, 2, 4, 8]" :key="speed" :value="speed">{{ speed }}×</option></select></label>
            <output class="playback-time">{{ playbackTime(playback.positionMs) }} / {{ playbackTime(playback.durationMs) }}</output>
          </div>
          <label class="playback-timeline"><span class="sr-only">Recorded observation timeline</span><input type="range" min="0" :max="playback.durationMs" step="1" :value="playback.positionMs" aria-label="Recorded observation timeline" @input="seekPlayback" /></label>
          <p class="playback-note">Sampled host observations. Pulses mark newly observed envelopes during playback; the timeline does not measure network send times. No cluster or provider is connected.</p>
        </template>
      </section>

      <section v-else class="control-bar" aria-label="Investigation controls">
        <div class="scenario">
          <div class="scenario-icon" aria-hidden="true">!</div>
          <div>
            <span class="control-label">INCIDENT SCENARIO</span
            ><strong>Pod restart warning</strong
            ><span class="scenario-detail"
              >Investigation and recommendations</span
            >
          </div>
        </div>
        <div class="launch-controls">
          <div
            class="execution-mode"
            :class="{ live: isLaunchLive, fixture: isLaunchFixture }"
          >
            <span class="status-dot" /><span>{{
              isLaunchLive
                ? "LIVE LLM"
                : isLaunchFixture
                  ? "FIXTURE · NO LLM"
                  : "MODE UNAVAILABLE"
            }}</span>
          </div>
          <button
            class="start-button"
            :disabled="loading || starting || !topology.nodes.length"
            @click="startRun"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="m5 3 8 5-8 5V3Z" fill="currentColor" /></svg
            >{{
              starting
                ? "Starting…"
                : isLaunchFixture
                  ? "Run fixture"
                  : isLaunchLive
                    ? "Start live investigation"
                    : "Start investigation"
            }}
          </button>
        </div>
      </section>

      <div v-if="isFixture" class="notice fixture-notice">
        <strong>{{ isArchive ? "Recorded fixture" : "Fixture mode" }}</strong
        ><span
          >{{ isArchive ? "This recording contains deterministic provider responses and no LLM calls." : "This run uses deterministic provider responses. No LLM provider is being called." }}</span
        >
      </div>

      <div v-if="newRunId" class="notice new-run-notice" role="status">
        <span
          >A new investigation is available. The current view stays on your
          selected run.</span
        ><button class="text-button" @click="selectedRunId = newRunId">
          View new run →
        </button>
      </div>

      <section class="workspace" :aria-label="isArchive ? 'Recorded investigation workspace' : 'Live investigation workspace'">
        <div class="primary-column">
          <section
            class="panel topology-panel"
            aria-labelledby="topology-title"
          >
            <div class="panel-heading">
              <div>
                <span class="section-kicker">01 / TOPOLOGY</span>
                <h2 id="topology-title">The communication graph</h2>
              </div>
              <div class="stream-status" :class="isArchive ? 'recorded' : connection">
                <span class="status-dot" />{{
                  isArchive ? playback?.playing ? "Playing recording" : playback?.index === (props.archive?.snapshots.length ?? 0) - 1 ? "Recording ended" : "Recording paused" : connection === "connected"
                    ? "Observing"
                    : connection === "connecting"
                      ? "Connecting"
                      : connection === "reconnecting"
                        ? "Reconnecting"
                        : connection === "closed"
                          ? "Run finished"
                          : "Awaiting run"
                }}
              </div>
            </div>
            <TopologyCanvas
              :key="`${selectedRunId}:${canvasReset}`"
              :topology="topology"
              :messages="messages"
              :arrivals="arrivals"
              :selected-message="selectedMessage"
              :selected-node="selectedNodeId"
              @select-node="selectNode"
            />
            <div class="graph-footer">
              <div class="legend">
                <span><i class="legend-line request" />Request</span
                ><span><i class="legend-line result" />Result</span
                ><span><i class="legend-line peer" />Peer link</span
                ><span><i class="legend-node" />LLM agent</span>
              </div>
              <span class="graph-hint"
                >Select a node or envelope to inspect</span
              >
            </div>
          </section>

          <section class="panel event-panel" aria-labelledby="events-title">
            <div class="panel-heading">
              <div>
                <span class="section-kicker">02 / OBSERVATIONS</span>
                <h2 id="events-title">
                  Message envelopes
                  <span class="count-badge">{{ messages.length }}</span>
                </h2>
              </div>
              <label class="filter-label"
                ><span class="sr-only">Filter message kind</span
                ><select v-model="filter">
                  <option value="all">All messages</option>
                  <option value="request">Requests</option>
                  <option value="result">Results</option>
                  <option value="error">Errors</option>
                </select></label
              >
            </div>
            <div v-if="streamError" class="stream-notice" role="status">
              {{ streamError }}
            </div>
            <div v-if="observationNotice" class="stream-notice" role="status">
              {{ observationNotice }}
            </div>
            <div v-if="!messages.length" class="empty-log">
              <div class="empty-log-symbol" aria-hidden="true">↔</div>
              <strong>{{ emptyLogTitle }}</strong>
              <p>{{ emptyLogCopy }}</p>
            </div>
            <template v-else
              ><div class="log-caption">
                <span
                  >Newest first · select a row for payload and correlation</span
                ><span>Observed messages only</span>
              </div>
              <div class="event-table-wrap">
                <table class="event-table">
                  <thead>
                    <tr>
                      <th scope="col">Seq.</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Route</th>
                      <th scope="col">State</th>
                      <th scope="col"><span class="sr-only">Inspect</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="message in filteredMessages"
                      :key="message.id"
                      :class="{ selected: selectedMessageId === message.id }"
                      @click="selectMessage(message)"
                    >
                      <td class="sequence">
                        {{ String(message.sequence).padStart(2, "0") }}
                      </td>
                      <td>
                        <span
                          class="kind-badge"
                          :class="messageTone(message.kind)"
                          >{{ kindLabel(message) }}</span
                        >
                      </td>
                      <td class="route-cell">
                        <span>{{ nodeLabel(message.sender) }}</span
                        ><span class="route-arrow" aria-hidden="true">→</span
                        ><span>{{ nodeLabel(message.recipient) }}</span>
                      </td>
                      <td>
                        <span
                          class="message-state"
                          :class="stateLabel(message).toLowerCase()"
                          ><i />{{ stateLabel(message) }}</span
                        >
                      </td>
                      <td>
                        <button
                          class="inspect-button"
                          :aria-label="`Inspect message ${message.sequence}: ${message.sender} to ${message.recipient}`"
                          @click.stop="selectMessage(message)"
                        >
                          ↗
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-if="!filteredMessages.length" class="no-results">
                No {{ filter }} envelopes observed.
              </p></template
            >
          </section>
        </div>

        <aside class="detail-column" aria-label="Run and message details">
          <section class="panel run-panel" aria-labelledby="run-title">
            <div class="panel-heading">
              <div>
                <span class="section-kicker">{{ isArchive ? "RECORDED RUN" : "RUN CONTROL" }}</span>
                <h2 id="run-title">Investigation</h2>
              </div>
              <span
                class="run-state"
                :class="currentRun?.status.toLowerCase()"
                >{{ statusLabel }}</span
              >
            </div>
            <div class="run-body">
              <p v-if="historyError" class="history-error" role="status">
                {{ historyError }}
              </p>
              <label class="field-label" for="run-picker">{{ isArchive ? "RECORDED RUN" : "SELECT RUN" }}</label
              ><select
                id="run-picker"
                v-model="selectedRunId"
                class="run-picker"
                :disabled="isArchive"
              >
                <option v-if="!runs.length" value="">No runs yet</option>
                <option v-for="run in runs" :key="run.id" :value="run.id">
                  {{ shortTime(run.startedAt) }} · {{ run.mode }} ·
                  {{ run.id.slice(-8) }}
                </option>
              </select>
              <dl class="run-stats">
                <div>
                  <dt>Envelopes</dt>
                  <dd>{{ messages.length }}</dd>
                </div>
                <div>
                  <dt>LLM requests</dt>
                  <dd>{{ llmRequests.length }}</dd>
                </div>
                <div>
                  <dt>Awaiting replies</dt>
                  <dd :class="{ 'pending-value': pending.length > 0 }">
                    {{ pending.length }}
                  </dd>
                </div>
              </dl>
              <div v-if="currentRun" class="run-identity">
                <span class="run-mode" :class="currentRun.mode">{{
                  currentRun.mode === "live"
                    ? isArchive ? "RECORDED REAL LLM RUN" : "LIVE LLM RUN"
                    : currentRun.mode === "fixture"
                      ? isArchive ? "RECORDED FIXTURE · NO LLM CALLS" : "FIXTURE · NO LLM CALLS"
                      : "MODE UNKNOWN"
                }}</span
                ><span>{{ currentRun.id }}</span
                ><span
                  >{{ isArchive ? "Recorded start" : "Started" }} {{ shortTime(currentRun.startedAt)
                  }}<template v-if="active && !isArchive">
                    · {{ elapsed }} elapsed</template
                  ></span
                >
              </div>
              <p class="observation-note">
                {{ isArchive ? "This view restores the recorded host state at the selected observation. Playback does not execute agents." : "Pulses follow observed protocol envelopes. Provider computation happens between a request and its reply." }}
              </p>
              <p v-if="currentRun?.error" class="run-error" role="alert">
                {{ currentRun.error }}
              </p>
            </div>
          </section>

          <section
            class="panel inspector-panel"
            aria-labelledby="inspector-title"
          >
            <div class="panel-heading">
              <div>
                <span class="section-kicker">03 / INSPECTOR</span>
                <h2 id="inspector-title">
                  {{
                    selectedMessage
                      ? `Envelope ${String(selectedMessage.sequence).padStart(2, "0")}`
                      : selectedNode
                        ? selectedNode.label
                        : "Explore a message"
                  }}
                </h2>
              </div>
              <span
                v-if="selectedMessage"
                class="kind-badge"
                :class="messageTone(selectedMessage.kind)"
                >{{ kindLabel(selectedMessage) }}</span
              >
            </div>
            <div class="inspector-body">
              <template v-if="selectedMessage"
                ><dl class="metadata">
                  <div>
                    <dt>From</dt>
                    <dd>{{ nodeLabel(selectedMessage.sender) }}</dd>
                  </div>
                  <div>
                    <dt>To</dt>
                    <dd>{{ nodeLabel(selectedMessage.recipient) }}</dd>
                  </div>
                  <div>
                    <dt>State</dt>
                    <dd>{{ stateLabel(selectedMessage) }}</dd>
                  </div>
                  <div>
                    <dt>Message ID</dt>
                    <dd class="mono">{{ selectedMessage.id }}</dd>
                  </div>
                  <div>
                    <dt>Correlation</dt>
                    <dd class="mono">
                      {{ selectedMessage.correlation ?? "No correlation ID" }}
                    </dd>
                  </div>
                  <div v-if="selectedMessage.createdAt">
                    <dt>Recorded</dt>
                    <dd>{{ shortTime(selectedMessage.createdAt) }}</dd>
                  </div>
                </dl>
                <div class="payload-label">PAYLOAD</div>
                <pre
                  v-if="selectedMessage.payload !== undefined"
                  class="payload"
                  >{{ display(selectedMessage.payload) }}</pre
                >
                <p v-else class="payload-hidden">
                  Payloads are hidden for this session. Routing and correlation
                  remain visible.
                </p></template
              ><template v-else-if="selectedNode"
                ><div class="node-type" :class="selectedNode.kind">
                  {{
                    selectedNode.kind === "llm"
                      ? "LLM agent"
                      : selectedNode.kind === "workflow"
                        ? "Deterministic workflow"
                        : "Incident event source"
                  }}
                </div>
                <p class="node-explanation">
                  {{
                    selectedNode.kind === "llm"
                      ? isArchive ? "This specialist used the recorded run's configured provider. Its observed request and result can be inspected in the message log." : "This agent sends its assigned task to the configured LLM provider. Its request and result appear in the message log."
                      : selectedNode.kind === "workflow"
                        ? isArchive ? "mas-host executed this workflow, routed requests and combined the resulting messages in the recorded run." : "mas-host executes this workflow, routes requests and combines the resulting messages."
                        : isArchive ? "The recorded run used a Kubernetes incident as its investigation input." : "The demo submits a Kubernetes incident as the input to this investigation."
                  }}
                </p>
                <dl class="metadata">
                  <div>
                    <dt>Agent ID</dt>
                    <dd class="mono">{{ selectedNode.id }}</dd>
                  </div>
                  <div v-if="selectedNode.model">
                    <dt>Model</dt>
                    <dd class="mono">{{ selectedNode.model }}</dd>
                  </div>
                  <div>
                    <dt>Observed envelopes</dt>
                    <dd>{{ nodeActivity.length }}</dd>
                  </div>
                </dl>
                <div v-if="nodeActivity.length" class="node-recent">
                  <span class="payload-label">LATEST ACTIVITY</span
                  ><button
                    v-for="message in [...nodeActivity].reverse().slice(0, 3)"
                    :key="message.id"
                    @click="selectMessage(message)"
                  >
                    <span
                      class="kind-badge"
                      :class="messageTone(message.kind)"
                      >{{ kindLabel(message) }}</span
                    ><span
                      >#{{ message.sequence }} ·
                      {{
                        message.sender === selectedNode.id
                          ? `To ${nodeLabel(message.recipient)}`
                          : `From ${nodeLabel(message.sender)}`
                      }}</span
                    ><span aria-hidden="true">↗</span>
                  </button>
                </div></template
              >
              <p v-else class="node-explanation">
                Select an envelope in the message log to inspect its payload and
                correlation, or select a node on the canvas.
              </p>
            </div>
          </section>
        </aside>
      </section>

      <section
        v-if="hasOutput"
        class="panel output-panel"
        aria-labelledby="output-title"
      >
        <div class="panel-heading">
          <div>
            <span class="section-kicker">04 / OUTCOME</span>
            <h2 id="output-title">The team's final assessment</h2>
          </div>
          <span class="output-label">{{
            isLive
              ? "LLM-generated proposal"
              : isFixture
                ? "Fixture response"
                : "Run output"
          }}</span>
        </div>
        <div class="output-body">
          <p class="output-note">
            Review the evidence and proposed actions before applying any change
            to a cluster.
          </p>
          <pre>{{ display(output) }}</pre>
        </div>
      </section>

      <footer class="app-footer">
        <span
          ><span class="footer-dot" />mas-host
          <span class="footer-separator">+</span> MAS protocol</span
        ><span>{{ isArchive ? "Recorded observations · no cluster or provider connection" : "Server-side provider credentials · read-only investigation" }}</span>
      </footer>
      <div class="sr-only" aria-live="polite" aria-atomic="true">
        {{
          currentRun
            ? `${isArchive ? 'Recorded run' : 'Run'} ${currentRun.status}. ${messages.length} envelopes observed. ${pending.length} awaiting replies.`
            : isArchive ? "Recording unavailable." : "Ready to start an investigation."
        }}
      </div>
    </main>
  </div>
</template>
