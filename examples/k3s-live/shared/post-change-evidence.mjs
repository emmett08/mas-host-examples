// Validate retained verifier observations without executing Kubernetes operations.
// Existing archives can omit this additive record; new practical captures require it.
import { managedWorkload } from './workloads.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, maximum = 253) => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const timestamp = value => string(value, 64) && Number.isFinite(Date.parse(value));
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const exact = (value, keys, optional = []) => object(value) && keys.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => keys.includes(key) || optional.includes(key));
function require(condition, message) { if (!condition) throw new Error(`Invalid post-change evidence: ${message}`); }

export function validatePostChangeEvidence(report, { required = false } = {}) {
  const evidence = report?.verificationEvidence;
  if (evidence === undefined) {
    require(!required, 'fresh verification requires retained logs and events');
    return;
  }
  require(report.version === 'mas-k8s-resolution/2' && exact(evidence, ['version', 'subject', 'window', 'logs', 'events']) &&
    evidence.version === 'mas-k8s-post-change-evidence/1', 'unknown record format');
  const { subject, window, logs, events } = evidence;
  const policy = managedWorkload(report.target?.namespace, report.target?.name);
  require(policy, 'target is outside the fixed demonstration policies');
  require(exact(subject, ['namespace', 'name', 'uid', 'container']) && subject.namespace === report.target?.namespace &&
    string(subject.name) && string(subject.uid, 128) && subject.container === 'checkout', 'replacement Pod identity');
  require(exact(window, ['startedAt', 'endedAt']) && timestamp(window.startedAt) && timestamp(window.endedAt) &&
    timestamp(report.before?.observedAt) && timestamp(report.recordedAt), 'observation times');
  const start = Date.parse(window.startedAt), end = Date.parse(window.endedAt), recorded = Date.parse(report.recordedAt);
  require(Date.parse(report.before.observedAt) <= start && start <= end && end <= recorded, 'observation window order');
  for (const item of [logs, events]) {
    require(object(item) && ['collected', 'unavailable'].includes(item.status) && string(item.source, 1000) &&
      timestamp(item.observedAt) && Date.parse(item.observedAt) >= start && Date.parse(item.observedAt) <= end &&
      typeof item.truncated === 'boolean' && (item.reason === undefined || string(item.reason, 500)), 'collection metadata');
  }
  require(exact(logs, ['status', 'source', 'observedAt', 'truncated', 'records', 'omittedLines', 'unparsedLines'], ['reason']) &&
    Array.isArray(logs.records) && logs.records.length <= 80 && nonnegative(logs.omittedLines) && nonnegative(logs.unparsedLines), 'bounded log projection');
  for (const record of logs.records) {
    require(exact(record, ['timestamp', 'method', 'path', 'status']) && timestamp(record.timestamp) && record.method === 'GET' &&
      ['/', '/healthz', '/readyz', '/ready'].includes(record.path) && Number.isInteger(record.status) && record.status >= 100 && record.status <= 599,
    'HTTP log record');
  }
  require(exact(events, ['status', 'source', 'observedAt', 'truncated', 'items'], ['reason']) &&
    Array.isArray(events.items) && events.items.length <= 12, 'bounded event projection');
  for (const event of events.items) {
    require(exact(event, ['metadata', 'involvedObject', 'type', 'reason', 'message', 'count', 'readinessFailure',
      'firstTimestamp', 'lastTimestamp', 'eventTime', 'seriesLastObservedTime']) &&
      exact(event.metadata, ['name', 'uid']) && string(event.metadata.name) && string(event.metadata.uid, 128) &&
      exact(event.involvedObject, ['namespace', 'name', 'uid']) &&
      ['namespace', 'name', 'uid'].every(key => event.involvedObject[key] === subject[key]) &&
      string(event.type, 64) && string(event.reason, 128) && string(event.message, 500) &&
      (event.count === null || nonnegative(event.count)) && typeof event.readinessFailure === 'boolean' &&
      ['firstTimestamp', 'lastTimestamp', 'eventTime', 'seriesLastObservedTime'].every(key => event[key] === null || timestamp(event[key])),
    'UID-bound event record');
    require(!event.readinessFailure || event.type === 'Warning' && event.reason === 'Unhealthy', 'readiness event classification');
    require(!/^Readiness probe failed:/.test(event.message) || event.readinessFailure, 'readiness failure cannot be hidden');
  }
  require(logs.status !== 'unavailable' || logs.records.length === 0, 'unavailable logs cannot contain observations');
  require(events.status !== 'unavailable' || events.items.length === 0, 'unavailable events cannot contain observations');
  if (report.status !== 'verified') return;

  require(report.after?.pod?.uid === subject.uid && report.after.pod.name === subject.name &&
    timestamp(report.after.pod.readyTransitionTime) && Date.parse(report.after.pod.readyTransitionTime) <= start + 5000 &&
    timestamp(report.after.observedAt) && Date.parse(report.after.observedAt) >= end,
  'final observation must confirm the same replacement Pod after collection');
  require(end - start >= 10_000 && [logs, events].every(item => item.status === 'collected' && !item.truncated &&
    Date.parse(item.observedAt) - start >= 10_000), 'complete observations after the readiness window');
  require(logs.unparsedLines === 0 && logs.records.some(record => record.path === '/healthz' && record.status === 200 &&
    Date.parse(record.timestamp) >= start && Date.parse(record.timestamp) <= end + 5000), 'fresh successful health probe log');
  require(!logs.records.some(record => Date.parse(record.timestamp) >= start && Date.parse(record.timestamp) <= end + 5000 &&
    (record.path === policy.proposedPath && record.status !== 200 || record.path === policy.currentPath && record.status === 404)), 'contradictory probe logs');
  require(!events.items.some(event => event.type === 'Warning' && event.reason === 'Unhealthy' && !event.readinessFailure &&
    !/^(?:Liveness|Startup) probe failed:/.test(event.message)), 'unclassified probe Warning');
  for (const event of events.items.filter(item => item.readinessFailure)) {
    const latest = [event.seriesLastObservedTime, event.lastTimestamp, event.eventTime]
      .filter(value => value !== null).map(value => Date.parse(value));
    if (!latest.length && event.count === 1 && event.firstTimestamp !== null) latest.push(Date.parse(event.firstTimestamp));
    require(latest.length > 0 && Math.max(...latest) < start, 'ongoing or undated readiness Warning');
  }
  require(['Post-change logs', 'Post-change events'].every(name => report.checks?.some(check => check.name === name && check.passed === true)),
    'successful logs and events checks');
}
