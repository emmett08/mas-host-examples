import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { combineReplay } from '../scripts/combine-replay.js';
import { replay } from '../ui/events.js';
test('combined replay retains scoped original identities, gaps and publication/promotion distinction without future leakage', () => {
  const root = mkdtempSync(join(tmpdir(), 'combined-control-'));
  const write = (scope: string, entries: { seq: number; type: string; data: object }[]) => {
    const path = join(root, `${scope}.jsonl`);
    writeFileSync(path, entries.map(entry => JSON.stringify({ incidentId: scope, time: '2026-10-18T12:00:00.000Z', ...entry })).join('\n') + '\n'); return path;
  };
  try {
    const controller = write('live-id', [{ seq: 1, type: 'incident.opened', data: { baseCommit: 'base' } }, { seq: 3, type: 'trial', data: { recovered: true } }]);
    const publication = write('publisher-id', [{ seq: 1, type: 'github.outcome', data: { status: 'merged', token: 'private-credential' } }]);
    const promotion = write('promotion-id', [{ seq: 1, type: 'deployment.recovery', data: { status: 'deployed-recovery-verified' } }]);
    const merged = combineReplay([{ scope: 'controller', eventsFile: controller }, { scope: 'publication', eventsFile: publication }, { scope: 'promotion', eventsFile: promotion }]);
    assert.equal(merged.incidentId, 'live-id'); assert.deepEqual(merged.events.map(event => event.seq), [1, 3, 4, 5]);
    assert.deepEqual(merged.events.map(event => event.type), ['incident.opened', 'trial', 'github', 'deployment.recovery']);
    const provenance = merged.events[2]!.data.replayProvenance as Record<string, unknown>;
    assert.equal(provenance.incidentId, 'publisher-id'); assert.equal(provenance.seq, 1); assert.equal(provenance.type, 'github.outcome');
    assert.match(String(provenance.sourceSha256), /^[a-f0-9]{64}$/); assert.equal(merged.events[2]!.data.token, '[redacted]');
    assert.deepEqual(replay(merged.events, 3).gaps, [{ from: 2, to: 2, reason: 'missed-window' }]);
    assert.ok(!JSON.stringify(replay(merged.events, 3)).includes('merged')); assert.ok(!JSON.stringify(replay(merged.events, 4)).includes('deployed-recovery-verified'));
    assert.throws(() => combineReplay([{ scope: 'publication', eventsFile: publication }]), /one controller/);
    writeFileSync(publication, '{"incomplete":');
    assert.throws(() => combineReplay([{ scope: 'controller', eventsFile: controller }, { scope: 'publication', eventsFile: publication }]), /incomplete/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
