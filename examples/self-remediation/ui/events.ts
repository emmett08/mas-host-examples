/** The observer consumes committed journal facts. It never mutates the controller. */
export interface ObservationEvent {
  seq: number;
  incidentId: string;
  time: string;
  type: string;
  data: Record<string, unknown>;
  phaseId?: string;
  candidateId?: string;
}
export interface EventGap { from: number; to: number; reason: 'missed-window' | 'conflicting-duplicate' }
export interface ObservationState {
  incidentId: string | null;
  events: readonly ObservationEvent[];
  gaps: readonly EventGap[];
  lastSeq: number;
  lastEventAt: string | null;
}
export interface ObservationWindow {
  schema: 'self-remediation-observer/1';
  incidentId: string;
  generatedAt: string;
  firstSeq: number;
  lastSeq: number;
  events: ObservationEvent[];
  completed: boolean;
  disclosure: 'summary' | 'redacted';
}
export const emptyState = (): ObservationState => ({ incidentId: null, events: [], gaps: [], lastSeq: 0, lastEventAt: null });

/** Reject transport metadata or pending intentions that have no committed journal sequence. */
export function parseEvent(value: unknown): ObservationEvent {
  if (!value || typeof value !== 'object') throw new Error('event must be an object');
  const v = value as Record<string, unknown>;
  const seq = Number(v.seq ?? v.sequence);
  const incidentId = v.incidentId ?? v.runId ?? v.incident_id;
  const time = v.time ?? v.at ?? v.timestamp ?? v.createdAt;
  const type = v.type ?? v.kind;
  const data = v.data ?? v.payload ?? {};
  if (!Number.isSafeInteger(seq) || seq < 1 || typeof incidentId !== 'string' || !incidentId ||
    typeof time !== 'string' || !Number.isFinite(Date.parse(time)) || typeof type !== 'string' ||
    !type || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid committed event');
  return { seq, incidentId, time, type, data: data as Record<string, unknown>,
    ...(typeof v.phaseId === 'string' ? { phaseId: v.phaseId } : {}),
    ...(typeof v.candidateId === 'string' ? { candidateId: v.candidateId } : {}) };
}

/** Both SSE delivery and offline playback call this reducer. First committed copy wins. */
export function reduceEvent(state: ObservationState, event: ObservationEvent): ObservationState {
  if (state.incidentId !== null && state.incidentId !== event.incidentId) throw new Error('incident identity changed');
  const old = state.events.find(e => e.seq === event.seq);
  if (old) {
    if (JSON.stringify(old) === JSON.stringify(event)) return state;
    if (state.gaps.some(g => g.reason === 'conflicting-duplicate' && g.from === event.seq)) return state;
    return { ...state, gaps: [...state.gaps, { from: event.seq, to: event.seq, reason: 'conflicting-duplicate' }] };
  }
  const events = [...state.events, event].sort((a, b) => a.seq - b.seq);
  const gaps: EventGap[] = state.gaps.filter(g => g.reason === 'conflicting-duplicate');
  let expected = 1;
  for (const item of events) {
    if (item.seq > expected) gaps.push({ from: expected, to: item.seq - 1, reason: 'missed-window' });
    expected = item.seq + 1;
  }
  const last = events.at(-1)!;
  return { incidentId: event.incidentId, events, gaps, lastSeq: last.seq, lastEventAt: last.time };
}

export function replay(events: readonly ObservationEvent[], throughSeq = Infinity): ObservationState {
  return events.filter(e => e.seq <= throughSeq).reduce(reduceEvent, emptyState());
}
export function parseWindow(value: unknown): ObservationWindow {
  if (!value || typeof value !== 'object') throw new Error('invalid observation window');
  const v = value as ObservationWindow;
  if (v.schema !== 'self-remediation-observer/1' || typeof v.incidentId !== 'string' ||
    !Number.isFinite(Date.parse(v.generatedAt)) || !Array.isArray(v.events) || v.events.length > 512 ||
    !Number.isSafeInteger(v.firstSeq) || !Number.isSafeInteger(v.lastSeq) || typeof v.completed !== 'boolean' ||
    !['summary', 'redacted'].includes(v.disclosure)) throw new Error('invalid observation window');
  const events = v.events.map(parseEvent);
  if (events.some(e => e.incidentId !== v.incidentId || e.seq < v.firstSeq || e.seq > v.lastSeq)) throw new Error('window identity mismatch');
  return { ...v, events };
}

const sensitiveKey = /(?:^token$|password|secret|authorization|credential|private.?key|api.?key|access.?token|refresh.?token|kubeconfig|cookie|rawOutput|stdout|stderr|environmentVariables)/i;
const credential = /(?:\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{16,})\b|Bearer\s+[^\s"']+|-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----)/g;
const safeSummaryKeys = new Set(['replayProvenance', 'scope', 'seq', 'time', 'type', 'sourceSha256', 'incidentId', 'mode', 'trigger', 'sourceCommit', 'sourceAnnotation', 'deployment', 'deploymentUid', 'pod', 'replicaSetUid', 'resourceVersion', 'configurationSha256', 'podConfigurationSha256', 'runtimeEnvironmentSha256', 'releaseGeneration', 'observedAt', 'subjectUid', 'uid', 'imageId', 'sourceTree', 'sourceRef', 'patchRef', 'patchPreview', 'rationale', 'changedCapabilities', 'changedResources', 'remainingUncertainty', 'operationalRisk', 'unnecessaryChange', 'costMicroUsd', 'eligible', 'reasons', 'findings', 'identity', 'evaluator', 'evaluatorVersion', 'authority', 'requirements', 'tests', 'environment', 'configuration', 'patch', 'stage', 'iteration', 'disposition', 'unresolvedIntent', 'kind', 'result', 'target', 'inputHash', 'receipt', 'publication', 'limits', 'used', 'deadline', 'microUsd', 'wallMs', 'operations', 'accounting', 'workflow', 'subject', 'explanation', 'rank', 'risk', 'id', 'name', 'role', 'from', 'to', 'sender', 'recipient', 'messageType', 'phase', 'status', 'outcome', 'reason', 'summary', 'mechanism', 'prediction', 'predictions', 'hypotheses', 'evidence', 'contradictions', 'uncertainty', 'criterion', 'criteria', 'measurements', 'value', 'unit', 'expected', 'actual', 'passed', 'mandatory', 'cost', 'costUsd', 'spentUsd', 'limitUsd', 'calls', 'maxCalls', 'candidates', 'maxCandidates', 'elapsedMs', 'timeoutMs', 'baseCommit', 'tree', 'candidateTree', 'patchDigest', 'imageDigest', 'requirementsDigest', 'testsDigest', 'environmentDigest', 'candidateId', 'phaseId', 'operationId', 'invocationId', 'invocation_id', 'repository', 'ref', 'podUid', 'release', 'namespace', 'artifact', 'artefact', 'artifacts', 'artefacts', 'digest', 'sha256', 'size', 'mediaType', 'disclosure', 'url', 'number', 'regressions', 'capabilities', 'resources', 'remaining', 'exposure', 'provider', 'model']);
export function redact(value: unknown, summaryOnly = false, depth = 0): unknown {
  if (depth > 7) return '[depth bounded]';
  if (typeof value === 'string') return value.replace(credential, '[redacted]').slice(0, summaryOnly ? 700 : 12_000);
  if (Array.isArray(value)) return value.slice(0, summaryOnly ? 12 : 100).map(v => redact(v, summaryOnly, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, val]) =>
    [key, sensitiveKey.test(key) ? '[redacted]' : (summaryOnly && !safeSummaryKeys.has(key) ? '[retained in artefact]' : redact(val, summaryOnly, depth + 1))]));
  return value;
}
export function publicEvent(event: ObservationEvent, summaryOnly = true): ObservationEvent {
  return { ...event, data: redact(event.data, summaryOnly) as Record<string, unknown> };
}
export function makeWindow(events: readonly ObservationEvent[], incidentId: string, completed = false, now = new Date(), maxBytes = 44_000): ObservationWindow {
  const bounded = events.slice(-128).map(e => publicEvent(e));
  const result: ObservationWindow = { schema: 'self-remediation-observer/1', incidentId, generatedAt: now.toISOString(), firstSeq: bounded[0]?.seq ?? 0,
    lastSeq: events.at(-1)?.seq ?? 0, events: bounded, completed, disclosure: 'summary' };
  const encoder = new TextEncoder();
  while (result.events.length && encoder.encode(JSON.stringify(result)).length > maxBytes) { result.events.shift(); result.firstSeq = result.events[0]?.seq ?? result.lastSeq + 1; }
  result.firstSeq = result.events[0]?.seq ?? result.lastSeq + 1;
  return result;
}
