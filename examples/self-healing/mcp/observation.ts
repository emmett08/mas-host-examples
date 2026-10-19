/** Project bounded, read-only observations from one frozen controller journal. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalEvent } from '../controller/journal.js';
import { publicEvent, redact } from '../ui/events.js';
import { admissionDigest, type Admission } from './contract.js';
import { bindingKey, dispatchKey } from './retained-journal.js';
export function snapshot(admission: Admission, after = 0): Record<string, unknown> {
  const base: Record<string, unknown> = {
    version: 'self-healing-mcp-observation/1', incident_id: admission.incidentId, contract_digest: admissionDigest(admission),
    code_revision: admission.sourceRevision, requirements_digest: admission.requirementsDigest, policy_digest: admission.policyDigest,
    mode: admission.mode, profile: admission.profile, publication_policy: admission.publication,
    controller_state: 'not_started', cancellation_requested: false, dispatch: null, outcome: null, result: null,
    budget: null, events: [], next_after: after, last_sequence: 0, more: false,
  };
  const file = join(admission.directory, 'journal.sqlite');
  if (!existsSync(file)) return base;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    const binding = db.prepare('SELECT value FROM values_store WHERE key=?').get(bindingKey);
    if (!binding || JSON.parse(String(binding.value)) !== admissionDigest(admission)) throw new Error('Retained incident contract mismatch');
    const dispatch = db.prepare('SELECT value FROM values_store WHERE key=?').get(dispatchKey);
    base.dispatch = dispatch ? JSON.parse(String(dispatch.value)) : null;
    base.cancellation_requested = Boolean(db.prepare('SELECT cancelled FROM incidents WHERE id=?').get(admission.incidentId)?.cancelled);
    const budget = db.prepare('SELECT limits,used,deadline FROM budgets WHERE scope=?').get(admission.incidentId);
    if (budget) base.budget = { limits: JSON.parse(String(budget.limits)), used: JSON.parse(String(budget.used)), deadline: Number(budget.deadline) };
    const outcome = db.prepare("SELECT data FROM events WHERE incident=? AND type='outcome' ORDER BY seq DESC LIMIT 1").get(admission.incidentId);
    if (outcome) {
      const result = JSON.parse(String(outcome.data));
      base.outcome = result.outcome;
      base.result = redact(result, true);
      if (Buffer.byteLength(JSON.stringify(base.result)) > 4000) base.result = { outcome: base.outcome, projection: 'omitted_size_bound' };
      base.controller_state = 'outcome_recorded';
    } else if (dispatch) base.controller_state = 'dispatched'; // May still run or may have been interrupted.
    else if (base.cancellation_requested) base.controller_state = 'cancelled_before_dispatch';
    base.last_sequence = Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE incident=?').get(admission.incidentId)!.seq);
    const rows = db.prepare('SELECT * FROM events WHERE incident=? AND seq>? ORDER BY seq LIMIT 32').all(admission.incidentId, after);
    const events: unknown[] = [];
    for (const row of rows) {
      const event: JournalEvent = { seq: Number(row.seq), incidentId: String(row.incident), time: String(row.time), type: String(row.type), data: JSON.parse(String(row.data)) };
      let projected = publicEvent(event);
      if (Buffer.byteLength(JSON.stringify(projected)) > 4000) projected = { ...event, data: { projection: 'omitted_size_bound', retainedSequence: event.seq } };
      // The snapshot is itself encoded inside an exact-JSON string in the host result.
      if (Buffer.byteLength(JSON.stringify({ ...base, events: [...events, projected] })) > 12000) break;
      events.push(projected); base.next_after = event.seq;
    }
    base.events = events;
    base.more = Number(base.next_after) < Number(base.last_sequence);
    // A long explanation cannot displace progress or make the host output exceed its frame.
    if (Buffer.byteLength(JSON.stringify(base)) > 20000) base.result = { outcome: base.outcome, projection: 'omitted_size_bound' };
    db.exec('COMMIT');
    return base;
  } finally { db.close(); }
}
