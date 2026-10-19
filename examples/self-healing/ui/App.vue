<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { emptyState, parseEvent, reduceEvent, replay, redact, type ObservationEvent } from './events';

declare global { interface Window { __MAS_ARCHIVE__?: { schema: string; events: ObservationEvent[]; disclosure: string; artefacts?: Record<string, { content: unknown; projectionDigest: string; sourceDigest: string }> } } }
const archive = window.__MAS_ARCHIVE__;
const narrow = ref(window.innerWidth < 650);
const resize = () => { narrow.value = window.innerWidth < 650; };
const committed = ref(emptyState());
const mode = ref<'live' | 'playback'>(archive ? 'playback' : 'live');
const cursor = ref(0), playing = ref(false), disclose = ref(false), now = ref(Date.now());
const connection = ref<Record<string, unknown>>({ connected: false, publishedAt: null, error: archive ? null : 'Connecting to observer' });
const loadedArtefacts = ref<Record<string, unknown>>({});
async function loadArtefact(reference: unknown): Promise<void> {
  if (typeof reference !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(reference)) return;
  try {
    const embedded = archive?.artefacts?.[reference];
    if (embedded) loadedArtefacts.value[reference] = embedded;
    else if (archive) loadedArtefacts.value[reference] = { status: 'not disclosed in this archive' };
    else { const response = await fetch(`/api/artefacts/${reference.slice(7)}`); loadedArtefacts.value[reference] = response.ok ? await response.json() : { status: 'Payload is not disclosed by this live transport. The retained reference can be resolved from the complete authorised archive.' }; }
  } catch { loadedArtefacts.value[reference] = { status: 'Artefact retrieval failed; no content inferred.' }; }
}
function candidateEdits(reference: unknown): { path: string; before: string | null; content: string | null }[] {
  const payload = loadedArtefacts.value[String(reference)];
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { content?: unknown }).content)) return [];
  return (payload as { content: unknown[] }).content.filter((entry): entry is { path: string; before: string | null; content: string | null } => {
    if (!entry || typeof entry !== 'object') return false;
    const edit = entry as Record<string, unknown>;
    return typeof edit.path === 'string' && (typeof edit.before === 'string' || edit.before === null) && (typeof edit.content === 'string' || edit.content === null);
  });
}
let source: EventSource | undefined, clock: ReturnType<typeof setInterval> | undefined;
const visible = computed(() => replay(committed.value.events, mode.value === 'live' ? Infinity : cursor.value));
const visibleEvents = computed(() => visible.value.events);
const recent = computed(() => [...visibleEvents.value].reverse());
const incident = computed(() => visibleEvents.value.find(e => e.type === 'incident.opened'));
const budget = computed(() => recent.value.find(e => e.type === 'budget'));
const lifecycle = computed(() => recent.value.find(e => ['lifecycle', 'outcome', 'phase.started', 'phase.completed'].includes(e.type)));
const statusText = computed(() => String(lifecycle.value?.data.outcome ?? lifecycle.value?.data.status ?? lifecycle.value?.data.phase ?? lifecycle.value?.data.stage ?? lifecycle.value?.type ?? 'Waiting for committed events'));
const timestamp = computed(() => typeof connection.value.publishedAt === 'string' ? Date.parse(connection.value.publishedAt) : NaN);
const age = computed(() => Number.isFinite(timestamp.value) ? Math.max(0, Math.floor((now.value - timestamp.value) / 1000)) : null);
const freshness = computed(() => archive ? 'Offline archive' : !connection.value.connected ? 'Connection interrupted' : age.value === null ? 'Awaiting first update' : age.value > 35 ? `Stale · ${age.value}s since publication` : `Published ${age.value}s ago`);
const stale = computed(() => !archive && (!connection.value.connected || age.value === null || age.value > 35));
const groups = [
  { id: 'hypotheses', title: 'Hypotheses & evidence', kind: 'Model judgements', types: ['hypotheses'], hint: 'Mechanisms, supporting evidence, contradictions and remaining uncertainty.' },
  { id: 'experiments', title: 'Experiments & predictions', kind: 'Discriminating observations', types: ['experiment.planned', 'experiment.completed'], hint: 'A prediction is recorded before a permitted experiment runs.' },
  { id: 'candidates', title: 'Candidate source changes', kind: 'Exact source identities', types: ['candidate.created'], hint: 'Each candidate retains its source identity and patch artefact.' },
  { id: 'measurements', title: 'Objective measurements', kind: 'Measured results', types: ['measurement'], hint: 'Failed and inconclusive checks remain visible as measurements.' },
  { id: 'verification', title: 'Candidate eligibility', kind: 'Independent verification', types: ['verification'], hint: 'Every mandatory gate must pass. Hypothesis rank never grants release authority.' },
  { id: 'binding', title: 'Observed incident binding', kind: 'Release provenance', types: ['operational.binding'], hint: 'Exact trigger, Pod ownership, source, image and configuration identities observed by the trusted adapter.' },
  { id: 'trial', title: 'Trial & deployed recovery', kind: 'Deployment observations', types: ['trial', 'deployment.recovery'], hint: 'Candidate verification, isolated trial recovery and deployed recovery are separate facts.' },
  { id: 'github', title: 'GitHub publication', kind: 'External effect receipts', types: ['github'], hint: 'A pull request, merge and promotion each require their own retained outcome.' },
  { id: 'effects', title: 'Effects & checkpoints', kind: 'Recovery and uncertainty', types: ['effect.intended', 'effect.completed', 'effect.unknown', 'effect.reconciled', 'effect.result', 'checkpoint', 'outcome'], hint: 'Unknown effects stay unresolved until external evidence reconciles them.' },
];
function forTypes(types: string[]): readonly ObservationEvent[] { return recent.value.filter(e => types.includes(e.type)); }
function headline(event: ObservationEvent): string {
  if (event.type === 'trial' && typeof event.data.recovered === 'boolean') return event.data.recovered ? 'Isolated trial recovered' : 'Isolated trial recovery not verified';
  return String(event.data.summary ?? event.data.reason ?? event.data.outcome ?? event.data.status ?? event.data.name ?? event.data.phase ?? event.data.stage ?? event.data.disposition ?? event.type.replaceAll('.', ' ')); }
function pretty(value: unknown): string { return JSON.stringify(redact(value), null, 2); }
function short(value: unknown): string { if (typeof value === 'string') return value.length > 40 ? `${value.slice(0, 18)}…${value.slice(-10)}` : value; return JSON.stringify(value); }
function label(key: string): string { return key.replace(/([A-Z])/g, ' $1').replaceAll('_', ' '); }
function summary(event: ObservationEvent): Record<string, unknown> {
  const keys = ['recovered', 'sourceTree', 'configurationSha256', 'deploymentUid', 'podUid', 'sourceCommit', 'status', 'outcome', 'phase', 'baseCommit', 'candidateTree', 'tree', 'candidateId', 'imageDigest', 'criterion', 'passed', 'mandatory', 'value', 'unit', 'costUsd', 'operationId', 'invocationId', 'invocation_id', 'url', 'reason', 'summary', 'artifact', 'artefact', 'sourceRef', 'patchRef', 'changedCapabilities', 'changedResources', 'eligible', 'disposition', 'remainingUncertainty', 'exposure'];
  return Object.fromEntries(Object.entries(event.data).filter(([key]) => keys.includes(key)));
}
function pause(): void { cursor.value = visible.value.lastSeq; mode.value = 'playback'; playing.value = false; }
function live(): void { playing.value = false; mode.value = 'live'; }
function seek(event: Event): void { mode.value = 'playback'; playing.value = false; cursor.value = Number((event.target as HTMLInputElement).value); }
function togglePlay(): void { if (mode.value === 'live') pause(); if (cursor.value >= committed.value.lastSeq) cursor.value = 0; playing.value = !playing.value; }
function ingest(raw: unknown): void { committed.value = reduceEvent(committed.value, parseEvent(raw)); }
const messages = computed(() => visibleEvents.value.filter(e => e.type === 'mas.message'));
function route(event: ObservationEvent): { from: string; to: string } | undefined {
  const from = event.data.from ?? event.data.sender, to = event.data.to ?? event.data.recipient;
  return typeof from === 'string' && typeof to === 'string' ? { from, to } : undefined;
}
const graph = computed(() => {
  const routes = messages.value.map(route).filter((r): r is { from: string; to: string } => Boolean(r));
  const actors = [...new Set(routes.flatMap(r => [r.from, r.to]))].slice(0, 12);
  const count = Math.max(actors.length, 1);
  const cx = narrow.value ? 180 : 420, cy = 178, radius = narrow.value ? 125 : 300;
  const nodes = actors.map((id, index) => ({ id, x: cx + radius * Math.cos(-Math.PI / 2 + index / count * 2 * Math.PI), y: cy + 122 * Math.sin(-Math.PI / 2 + index / count * 2 * Math.PI) }));
  const edges = new Map<string, { from: typeof nodes[number]; to: typeof nodes[number]; count: number }>();
  for (const r of routes) { const from = nodes.find(n => n.id === r.from), to = nodes.find(n => n.id === r.to); if (!from || !to) continue; const key = `${r.from}:${r.to}`; const old = edges.get(key); edges.set(key, { from, to, count: (old?.count ?? 0) + 1 }); }
  return { nodes, cx, cy, edges: [...edges.values()], omitted: [...new Set(routes.flatMap(r => [r.from, r.to]))].length > 12 };
});
const visibleBudget = computed(() => {
  if (!budget.value) return [];
  const used = budget.value.data.used, limits = budget.value.data.limits;
  if (used && limits && typeof used === 'object' && typeof limits === 'object') return Object.entries(used).map(([key, value]) => [key === 'microUsd' ? 'reserved USD' : key, key === 'microUsd' ? `${(Number(value)/1e6).toFixed(4)} / ${(Number((limits as Record<string, unknown>)[key])/1e6).toFixed(2)}` : `${value} / ${(limits as Record<string, unknown>)[key]}`]);
  return Object.entries(budget.value.data);
});
function criteria(event: ObservationEvent): Record<string, unknown>[] { return Array.isArray(event.data.criteria) ? event.data.criteria.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object') : []; }
function hypotheses(event: ObservationEvent): Record<string, unknown>[] { return Array.isArray(event.data.hypotheses) ? event.data.hypotheses.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object') : []; }
onMounted(() => {
  window.addEventListener('resize', resize);
  if (archive) for (const event of archive.events) ingest(event);
  else {
    source = new EventSource('/api/stream');
    source.addEventListener('committed', event => { try { ingest(JSON.parse((event as MessageEvent).data)); } catch (error) { connection.value = { ...connection.value, error: String(error), connected: false }; } });
    source.addEventListener('status', event => { connection.value = JSON.parse((event as MessageEvent).data); });
    source.onerror = () => { connection.value = { ...connection.value, connected: false, error: 'SSE disconnected. Resuming from the last received sequence.' }; };
  }
  clock = setInterval(() => {
    now.value = Date.now();
    if (playing.value) { const next = committed.value.events.find(e => e.seq > cursor.value); if (next) cursor.value = next.seq; else playing.value = false; }
  }, 1000);
});
onBeforeUnmount(() => { window.removeEventListener('resize', resize); source?.close(); if (clock) clearInterval(clock); });
</script>

<template>
  <main>
    <header class="masthead">
      <div><p class="eyebrow"><span class="mark">M</span> MAS / ENGINEERING OPERATIONS</p><h1>Self-healing</h1><p class="intro">Follow the evidence from incident to verified recovery.</p></div>
      <div class="session"><span :class="['pill', stale ? 'warn' : 'quiet']"><i></i>{{ freshness }}</span><p>{{ archive ? 'Read-only replay' : 'Committed live events' }}</p><span class="mono">{{ visible.incidentId ?? 'Incident identity pending' }}</span></div>
    </header>

    <section class="controls" aria-label="Live and playback controls">
      <div class="mode-controls"><button v-if="!archive" :class="{ active: mode === 'live' }" @click="live">● Live</button><button :class="{ active: mode === 'playback' }" @click="pause">Playback</button><button class="play" @click="togglePlay" :aria-label="playing ? 'Pause playback' : 'Play committed events'">{{ playing ? 'Ⅱ Pause' : '▶ Play' }}</button></div>
      <label class="seek">Event <b>{{ visible.lastSeq }}</b><input aria-label="Seek committed sequence" type="range" min="0" :max="committed.lastSeq" :value="mode === 'live' ? committed.lastSeq : cursor" @input="seek"><span>{{ committed.lastSeq }}</span></label>
      <label class="disclosure"><input v-model="disclose" type="checkbox">Show redacted details</label>
    </section>

    <section class="graph-card" aria-labelledby="flow-heading">
      <div class="section-top"><div><p class="eyebrow">NEHEMIAH / MAS</p><h2 id="flow-heading">Message flow</h2></div><span class="mono muted">{{ messages.length }} committed messages · sequence {{ visible.lastSeq }}</span></div>
      <div v-if="!graph.nodes.length" class="graph-empty"><span class="orbit">↗</span><h3>Awaiting MAS messages</h3><p>Actor connections appear when their observations are committed.</p></div>
      <svg v-else :viewBox="narrow ? '0 0 360 356' : '0 0 840 356'" role="img" aria-label="Observed agent message routes" class="flow-graph">
        <defs><marker id="arrow" viewBox="0 0 10 10" refX="33" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#4faba9"/></marker></defs>
        <g v-for="edge in graph.edges" :key="`${edge.from.id}:${edge.to.id}`"><path :d="`M ${edge.from.x} ${edge.from.y} Q ${graph.cx} ${graph.cy} ${edge.to.x} ${edge.to.y}`" fill="none" stroke="#497d88" stroke-width="1.6" marker-end="url(#arrow)"/><text :x="(edge.from.x + edge.to.x + graph.cx * 2) / 4" :y="(edge.from.y + edge.to.y + 356) / 4" class="edge-count">{{ edge.count }}</text></g>
        <g v-for="node in graph.nodes" :key="node.id"><title>{{ node.id }}</title><circle :cx="node.x" :cy="node.y" r="22" fill="#203849" stroke="#6ad3c1" stroke-width="1.5"/><circle :cx="node.x" :cy="node.y" r="5" fill="#92ead6"/><text :x="node.x" :y="node.y + 43" text-anchor="middle" class="actor-label">{{ node.id.length > (narrow ? 15 : 28) ? `${node.id.slice(0, narrow ? 12 : 25)}…` : node.id }}</text></g>
      </svg>
      <p v-if="graph.omitted" class="notice">Graph shows the first 12 observed actors. Every route remains in the message records.</p>
      <div v-if="messages.length" class="message-strip"><span v-for="event in [...messages].reverse().slice(0, 4)" :key="event.seq"><b>#{{ event.seq }}</b> {{ route(event)?.from ?? 'Host' }} <span class="arrow">→</span> {{ route(event)?.to ?? 'Observation' }} <small>{{ event.data.messageType ?? event.type }}</small></span></div>
    </section>

    <div v-if="visible.gaps.length" class="alert" role="alert"><b>Incomplete observation history</b><span v-for="gap in visible.gaps" :key="`${gap.from}:${gap.reason}`">Sequences {{ gap.from }}–{{ gap.to }}: {{ gap.reason.replaceAll('-', ' ') }}.</span><p>These gaps do not imply that the controller skipped work. Retrieve the complete archive for the retained sequence.</p></div>
    <div v-if="connection.error && !archive" class="alert warning" role="status">{{ connection.error }}<span v-if="connection.nextPollMs">Next poll after {{ Number(connection.nextPollMs) / 1000 }}s.</span></div>

    <section class="overview" aria-label="Current incident overview">
      <div class="status-card"><p class="eyebrow">CURRENT LIFECYCLE</p><h2>{{ statusText }}</h2><p>{{ lifecycle ? `Recorded at ${new Date(lifecycle.time).toLocaleTimeString()}` : 'No lifecycle fact at this point in the record.' }}</p></div>
      <div class="identity-card"><p class="eyebrow">INCIDENT IDENTITY</p><dl v-if="incident"><template v-for="(value, key) in incident.data" :key="key"><dt>{{ label(String(key)) }}</dt><dd :title="String(value)">{{ short(value) }}</dd></template></dl><p v-else class="muted">Identity appears when its opening event is reached.</p></div>
      <div class="budget-card"><p class="eyebrow">PERSISTENT BUDGET</p><dl v-if="budget"><template v-for="[key, value] in visibleBudget" :key="key"><dt>{{ label(key) }}</dt><dd>{{ typeof value === 'object' ? short(value) : value }}</dd></template></dl><p v-else class="muted">Awaiting a committed budget measurement.</p></div>
    </section>

    <div class="evidence-grid">
      <section v-for="group in groups" :key="group.id" class="evidence-card" :aria-labelledby="`${group.id}-heading`">
        <div class="section-top"><div><p class="eyebrow">{{ group.kind }}</p><h2 :id="`${group.id}-heading`">{{ group.title }}</h2></div><span class="count">{{ forTypes(group.types).length }}</span></div>
        <p class="hint">{{ group.hint }}</p>
        <div v-if="!forTypes(group.types).length" class="empty">No retained result at this sequence.</div>
        <article v-for="event in forTypes(group.types).slice(0, 8)" :key="event.seq" class="record">
          <div class="record-heading"><span class="event-type">{{ event.type }}</span><span class="mono muted">#{{ event.seq }} · {{ new Date(event.time).toLocaleTimeString() }}</span></div>
          <h3>{{ headline(event) }}</h3>
          <dl class="facts"><template v-for="(value, key) in summary(event)" :key="key"><dt>{{ label(String(key)) }}</dt><dd>{{ typeof value === 'object' ? short(value) : value }}</dd></template></dl>
          <div v-if="criteria(event).length" class="criteria"><div v-for="criterion in criteria(event)" :key="String(criterion.id)" class="criterion"><span :class="['criterion-status', String(criterion.status)]">{{ criterion.status }}</span><b>{{ criterion.id }}</b><span>{{ criterion.value ?? criterion.explanation }}</span><small>{{ criterion.mandatory ? 'mandatory' : 'supplementary' }}</small></div></div>
          <div v-if="hypotheses(event).length" class="hypotheses"><div v-for="hypothesis in hypotheses(event)" :key="String(hypothesis.id)" class="hypothesis"><p><span class="mono">#{{ hypothesis.rank }} · {{ hypothesis.id }}</span></p><p>{{ hypothesis.mechanism }}</p><details v-if="disclose"><summary>Evidence, contradictions and predictions</summary><pre>{{ pretty(hypothesis) }}</pre></details></div></div>
          <pre v-if="disclose && event.data.patchPreview">{{ event.data.patchPreview }}</pre>
          <div v-if="disclose && event.data.patchRef" class="artefact"><button @click="loadArtefact(event.data.patchRef)">Inspect disclosed candidate diff</button>
            <div v-for="edit in candidateEdits(event.data.patchRef)" :key="edit.path" class="source-change">
              <h4 class="mono">{{ edit.path }} <span>{{ edit.before === null ? 'Added' : edit.content === null ? 'Removed' : 'Changed' }}</span></h4>
              <div class="source-comparison"><section aria-label="Original source"><p>Before · exact incident base</p><pre>{{ edit.before === null ? 'File did not exist' : edit.before }}</pre></section><section aria-label="Candidate source"><p>After · candidate</p><pre>{{ edit.content === null ? 'File removed' : edit.content }}</pre></section></div>
            </div>
            <pre v-if="loadedArtefacts[String(event.data.patchRef)] && !candidateEdits(event.data.patchRef).length">{{ pretty(loadedArtefacts[String(event.data.patchRef)]) }}</pre>
          </div>
          <details v-if="disclose"><summary>Structured rationale and retained references</summary><pre>{{ pretty(event.data) }}</pre></details>
          <p v-else class="payload-note">Redacted details are hidden. Enable disclosure above to inspect structured rationale and artefact references.</p>
        </article>
        <p v-if="forTypes(group.types).length > 8" class="muted">Showing the latest 8 records. The event journal contains the earlier records.</p>
      </section>
    </div>
    <section class="journal"><div class="section-top"><div><p class="eyebrow">COMMITTED EVENTS</p><h2>Event journal</h2></div><span class="mono muted">{{ visible.events.length }} visible records</span></div><div class="table-scroll"><table><thead><tr><th>Sequence</th><th>Time</th><th>Fact</th><th>Summary</th></tr></thead><tbody><tr v-for="event in recent.slice(0, 100)" :key="event.seq"><td class="mono">{{ event.seq }}</td><td>{{ new Date(event.time).toLocaleTimeString() }}</td><td class="mono">{{ event.type }}</td><td>{{ headline(event) }}</td></tr></tbody></table><p v-if="!recent.length" class="empty">The journal is empty at this playback position.</p></div></section>
    <footer><span>MAS self-healing · observed facts and explicit uncertainty</span><span>{{ archive ? 'Offline · no network requests' : 'Read-only observer · credentials stay on the server' }}</span></footer>
  </main>
</template>
