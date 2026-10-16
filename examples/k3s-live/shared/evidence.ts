// Application evidence carried inside existing MAS payloads; this is not a MAS wire extension.
export const EVIDENCE_VERSION = 'mas-k8s-evidence/1' as const;
export const MAX_EVIDENCE_BYTES = 32 * 1024;
export type EvidenceKind = 'pod' | 'workload' | 'events' | 'logs' | 'metrics';
export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  source: string;
  status: 'collected' | 'unavailable' | 'skipped';
  observedAt: string;
  truncated: boolean;
  data: unknown;
  reason?: string;
}
export interface EvidenceBundle {
  version: typeof EVIDENCE_VERSION;
  capturedAt: string;
  subject: { namespace: string; name: string; uid: string };
  items: EvidenceItem[];
}

const kinds = new Set(['pod', 'workload', 'events', 'logs', 'metrics']);
const statuses = new Set(['collected', 'unavailable', 'skipped']);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, maximum: number, minimum = 1): value is string =>
  typeof value === 'string' && value.length >= minimum && value.length <= maximum;
const timestamp = (value: unknown): value is string => bounded(value, 64) && Number.isFinite(Date.parse(value));

// Validate the common transport contract on admission as well as collection.
// Item data is intentionally extensible, but the entire bundle has a byte cap.
export function parseEvidence(value: unknown): EvidenceBundle | undefined {
  if (value === undefined) return undefined;
  let serialised: string;
  try { serialised = JSON.stringify(value); } catch { throw new Error('Evidence must be serialisable JSON'); }
  if (!serialised || new TextEncoder().encode(serialised).byteLength > MAX_EVIDENCE_BYTES) {
    throw new Error('Evidence exceeds 32 KiB');
  }
  if (!object(value) || value.version !== EVIDENCE_VERSION || !timestamp(value.capturedAt)
    || !object(value.subject) || !bounded(value.subject.namespace, 63)
    || !bounded(value.subject.name, 253) || !bounded(value.subject.uid, 128)
    || !Array.isArray(value.items) || value.items.length > 16) throw new Error('Invalid evidence bundle');
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!object(item) || !bounded(item.id, 128) || !/^[a-z0-9-]+$/.test(item.id)
      || ids.has(item.id) || !kinds.has(String(item.kind)) || !statuses.has(String(item.status))
      || !bounded(item.source, 1000) || !timestamp(item.observedAt) || typeof item.truncated !== 'boolean'
      || !Object.hasOwn(item, 'data') || item.data === undefined || (item.reason !== undefined && !bounded(item.reason, 500, 0))) {
      throw new Error('Invalid or duplicate evidence item');
    }
    if (item.status !== 'collected' && item.data !== null) throw new Error('Unavailable evidence must have null data');
    ids.add(item.id);
  }
  return JSON.parse(serialised) as EvidenceBundle;
}

// This is a bounded best-effort log scrubber, not a guarantee that arbitrary
// application text contains no secrets. Resource literals are removed separately.
export function redactEvidenceText(value: string, maximum = 2048): string {
  const credentialKey = /^(?:password|passwd|secret|token|api[_-]?key)$/i;
  const scrubJSON = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrubJSON);
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, credentialKey.test(key) ? '[REDACTED]' : scrubJSON(child)]));
    return value;
  };
  // Parse complete JSON log records when available so arrays, objects, escaped
  // keys and non-string credential values keep a valid surrounding structure.
  const records = value.split('\n').map(line => {
    const start = line.search(/[\[{]/);
    if (start < 0) return line;
    try { return line.slice(0, start) + JSON.stringify(scrubJSON(JSON.parse(line.slice(start)))); }
    catch { return line; }
  }).join('\n');
  return records
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>;,}\]]+/gi, '$1 [REDACTED]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,}|github_pat_[a-zA-Z0-9_]{12,})\b/g, '[REDACTED]')
    .replace(/(["'])(password|passwd|secret|token|api[_-]?key)\1(\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)/gi,
      (_match, quote: string, key: string, separator: string, literal: string) => {
        const valueQuote = literal.startsWith('"') || literal.startsWith("'") ? literal[0]! : '"';
        return `${quote}${key}${quote}${separator}${valueQuote}[REDACTED]${valueQuote}`;
      })
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,
      (_match, prefix: string, literal: string) => {
        const quote = literal.startsWith('"') || literal.startsWith("'") ? literal[0]! : '';
        return `${prefix}${quote}[REDACTED]${quote}`;
      })
    .slice(0, maximum);
}
