/** Read-only consolidation of separately scoped job journals. Never executes retained code. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseEvent, publicEvent, type ObservationEvent } from '../ui/events.js';
export interface ReplaySource { scope: 'controller' | 'publication' | 'promotion'; eventsFile: string }
export function combineReplay(sources: ReplaySource[]): { incidentId: string; events: ObservationEvent[]; sources: Record<string, unknown>[] } {
  if (sources[0]?.scope !== 'controller' || new Set(sources.map(source => source.scope)).size !== sources.length
    || sources.some((source, index) => ['controller', 'publication', 'promotion'].indexOf(source.scope) < index)) throw new Error('Use one controller, then optional publication and promotion journals');
  let incidentId = '', replaySeq = 0;
  const events: ObservationEvent[] = [], provenance: Record<string, unknown>[] = [];
  for (const source of sources) {
    const stat = lstatSync(source.eventsFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('Replay input must be a bounded regular journal projection');
    const raw = readFileSync(source.eventsFile, 'utf8');
    if (raw && !raw.endsWith('\n')) throw new Error('Replay input has an incomplete committed-event projection');
    const sourceSha256 = createHash('sha256').update(raw).digest('hex');
    const original = raw.split('\n').filter(Boolean).map(line => parseEvent(JSON.parse(line)));
    if (source.scope === 'controller') {
      if (!original.length) throw new Error('Controller journal has no committed incident identity');
      incidentId = original[0]!.incidentId;
    }
    let previousSeq = 0;
    const sourceIncident = original[0]?.incidentId;
    for (const event of original) {
      if (event.incidentId !== sourceIncident || event.seq <= previousSeq || Object.hasOwn(event.data, 'replayProvenance')) throw new Error('Conflicting original journal identity, order or provenance');
      // Preserve original missing windows as missing replay sequences. Never silently fill gaps.
      replaySeq += event.seq - previousSeq;
      previousSeq = event.seq;
      const normalized = event.type === 'github.outcome' ? 'github' : event.type;
      events.push(publicEvent({ ...event, seq: replaySeq, incidentId, type: normalized, data: { ...event.data,
        replayProvenance: { scope: source.scope, incidentId: event.incidentId, seq: event.seq, time: event.time, type: event.type, sourceSha256 },
      } }, false));
      if (events.length > 100_000) throw new Error('Combined replay exceeds event bound');
    }
    provenance.push({ scope: source.scope, incidentId: sourceIncident ?? null, sourceSha256, eventCount: original.length,
      firstOriginalSeq: original[0]?.seq ?? null, lastOriginalSeq: original.at(-1)?.seq ?? null });
  }
  return { incidentId, events, sources: provenance };
}
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { controller: { type: 'string' }, publication: { type: 'string' }, promotion: { type: 'string' }, output: { type: 'string' } } });
  if (!values.controller || !values.output) throw new Error('usage: combine-replay --controller RUN --publication PUBLICATION [--promotion PROMOTION] --output ARCHIVE');
  const sources: ReplaySource[] = [{ scope: 'controller', eventsFile: join(resolve(values.controller), 'events.jsonl') }];
  if (values.publication) sources.push({ scope: 'publication', eventsFile: join(resolve(values.publication), 'journal/events.jsonl') });
  if (values.promotion) sources.push({ scope: 'promotion', eventsFile: join(resolve(values.promotion), 'journal/events.jsonl') });
  const combined = combineReplay(sources), output = resolve(values.output);
  if (sources.some(source => resolve(source.eventsFile) === join(output, 'events.jsonl'))) throw new Error('Combined replay cannot overwrite an original journal');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const eventsFile = join(output, 'events.jsonl');
  writeFileSync(eventsFile, combined.events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
  const { createArchive } = await import(pathToFileURL(resolve('scripts/archive.mjs')).href);
  const disclosures = join(resolve(values.controller), 'disclosed-artefacts.json');
  await createArchive({ eventsFile, output, incidentId: combined.incidentId, disclose: true,
    ...(existsSync(disclosures) ? { artefactsRoot: join(resolve(values.controller), 'artefacts'), disclosures, discloseSource: true } : {}) });
  writeFileSync(join(output, 'replay-sources.json'), JSON.stringify({ schema: 'self-remediation-combined-replay/1', incidentId: combined.incidentId,
    ordering: 'Explicit workflow job order: controller, publication, promotion; original timestamps retained without implying synchronized runner clocks.', sources: combined.sources }, null, 2), { mode: 0o600 });
  process.stdout.write(`Combined ${combined.events.length} committed observations from ${combined.sources.length} explicitly scoped jobs into ${join(output, 'index.html')}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
