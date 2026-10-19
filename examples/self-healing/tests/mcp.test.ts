/** The gateway preserves controller identity, budgets and committed cancellation across processes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { admissionDigest, validateRequest, verifyFiles, rawDigest, type Admission } from '../mcp/contract.js';
import { claim, cancelIncident, interrupted } from '../mcp/incident.js';
import { snapshot } from '../mcp/observation.js';
import { Journal } from '../controller/journal.js';
import { watchCancellation } from '../controller/cancellation.js';

function fixture(t: any): Admission {
  const root = mkdtempSync(join(tmpdir(), 'healing-mcp-unit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { version: 'self-healing-mcp/1', profile: 'boundary-control', incidentId: 'incident-1', directory: join(root, 'incident'),
    example: root, repository: root, sourceRevision: 'a'.repeat(40), host: 'unused', gatewayState: 'unused', node: process.execPath,
    controller: 'unused', arguments: [], environment: {}, credentialNames: [], files: {}, directories: [],
    limits: { calls: 12, candidates: 3, operations: 160, microUsd: 2_000_000, wallMs: 600000 }, mode: 'fixture', publication: 'archive',
    requirementsDigest: 'b'.repeat(64), policyDigest: 'c'.repeat(64) };
}
test('one incident retains the original dispatch and budget despite another MCP request or interrupted response', t => {
  const a = fixture(t), first = { requestId: 'first', invocationId: 'effect-1', contractDigest: admissionDigest(a) };
  assert.equal(claim(a, first), true);
  const journal = new Journal(a.directory, a.incidentId, a.limits);
  journal.reserveBudget('original-phase', { calls: 3, microUsd: 150000 }); journal.close();
  const before = snapshot(a);
  interrupted(a);
  assert.equal(claim(a, { ...first, requestId: 'replacement', invocationId: 'effect-2' }), false);
  const after = snapshot(a);
  assert.deepEqual(after.dispatch, first); assert.deepEqual(after.budget, before.budget);
  assert.equal(after.controller_state, 'dispatched'); assert.equal(after.outcome, null);
  const changed = { ...a, limits: { ...a.limits, calls: 13 } };
  assert.throws(() => claim(changed, first), /budget|Frozen/);
  assert.throws(() => snapshot({ ...a, policyDigest: 'd'.repeat(64) }), /contract mismatch/);
});
test('cancellation before dispatch persists and prevents a new request from starting', t => {
  const a = fixture(t); cancelIncident(a);
  assert.equal(claim(a, { requestId: 'late', invocationId: 'effect', contractDigest: admissionDigest(a) }), false);
  assert.equal(snapshot(a).controller_state, 'cancelled_before_dispatch');
  assert.equal(snapshot(a).cancellation_requested, true);
});
test('cancellation from a separate database connection aborts an active controller signal', async t => {
  const a = fixture(t); claim(a, { requestId: 'active', invocationId: 'effect', contractDigest: admissionDigest(a) });
  const journal = new Journal(a.directory, a.incidentId, a.limits), signal = new AbortController();
  const stop = watchCancellation(journal, signal);
  try { cancelIncident(a); for (let i = 0; i < 20 && !signal.signal.aborted; i++) await delay(20); assert.equal(signal.signal.aborted, true); }
  finally { stop(); journal.close(); }
});
test('progress pages preserve sequence, redact secrets and remain read-only and bounded', t => {
  const a = fixture(t); claim(a, { requestId: 'active', invocationId: 'effect', contractDigest: admissionDigest(a) });
  const journal = new Journal(a.directory, a.incidentId, a.limits);
  for (let i = 0; i < 70; i++) journal.append('phase.started', { phaseId: `phase-${i}`, token: 'do-not-disclose', rationale: 'x'.repeat(15000) });
  journal.append('outcome', { outcome: 'no_eligible_candidate', reason: 'r'.repeat(50000) });
  const retained = journal.events(); journal.close();
  let cursor = 0; const seqs: number[] = [];
  for (let i = 0; i < 10; i++) {
    const view = snapshot(a, cursor); assert.ok(Buffer.byteLength(JSON.stringify(view)) <= 20000);
    assert.ok(!JSON.stringify(view).includes('do-not-disclose'));
    seqs.push(...(view.events as any[]).map(event => event.seq));
    cursor = Number(view.next_after); if (!view.more) break;
  }
  assert.deepEqual(seqs, retained.map(event => event.seq));
  const reopened = new Journal(a.directory, a.incidentId, a.limits);
  assert.deepEqual(reopened.events(), retained); reopened.close();
  assert.equal(snapshot(a).outcome, 'no_eligible_candidate');
});
test('request and file identity checks reject changed inputs before dispatch', t => {
  const a = fixture(t), request = { incident_id: a.incidentId, contract_digest: admissionDigest(a), request_id: 'request-1' };
  validateRequest(a, request, 'run');
  assert.throws(() => validateRequest(a, { ...request, contract_digest: '0'.repeat(64) }, 'run'));
  assert.throws(() => validateRequest(a, { ...request, request_id: '../escape' }, 'run'));
  assert.throws(() => validateRequest(a, { ...request, after: -1 }, 'status'));
  const file = join(a.example, 'runtime.mjs'); writeFileSync(file, 'original'); a.files[file] = rawDigest('original'); verifyFiles(a);
  writeFileSync(file, 'changed'); assert.throws(() => verifyFiles(a), /dependency changed/);
  writeFileSync(file, 'original');
  const directory = join(a.example, 'source'); mkdirSync(directory); a.directories.push(directory);
  verifyFiles(a); writeFileSync(join(directory, 'added.ts'), 'new code');
  assert.throws(() => verifyFiles(a), /inventory changed/);
});
