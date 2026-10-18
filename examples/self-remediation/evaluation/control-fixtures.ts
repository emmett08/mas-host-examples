/** Deterministic harness controls only. Live providers cannot import or select these edits. */
import type { Snapshot } from '../tools/projection.js';
export function failingControl(snapshot: Snapshot) {
  return [{ path: 'src/server.ts', content: snapshot.files['src/server.ts']!.replace("return send(404, { error: 'route not found' });", "return send(200, { status: 'alive' });") }];
}
export function referenceControl(snapshot: Snapshot, healthy: Snapshot) {
  // Fixture assertions concern orchestration, never LLM repair competence.
  return [...new Set([...Object.keys(snapshot.files), ...Object.keys(healthy.files)])].filter(path => snapshot.files[path] !== healthy.files[path]).map(path => ({ path, content: healthy.files[path] ?? null }));
}
export function bypassControl() { return [{ path: '../evaluation/harness.ts', content: 'export const checks = [];' }]; }
