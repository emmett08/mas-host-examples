import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function argument(name) { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; }
export async function createArchive({ eventsFile, output, incidentId, disclose = false, artefactsRoot, disclosures, discloseSource = false }) {
  const { parseEvent, publicEvent } = await import(pathToFileURL(resolve(root, 'dist/ui/events.js')).href);
  const events = readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map(line => publicEvent(parseEvent(JSON.parse(line)), !disclose));
  if (events.some(event => event.incidentId !== incidentId)) throw new Error('archive incident identity mismatch');
  let artefacts = {};
  if (artefactsRoot && disclosures) {
    const { loadDisclosedArtefacts } = await import(pathToFileURL(resolve(root, 'dist/server/disclosure.js')).href);
    artefacts = loadDisclosedArtefacts(artefactsRoot, disclosures, discloseSource);
  }
  let html = readFileSync(resolve(root, 'dist/ui/index.html'), 'utf8');
  html = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (_, src) => {
    if (!/^\.\/assets\/[A-Za-z0-9_.-]+\.js$/.test(src)) throw new Error('unexpected script reference');
    const code = readFileSync(resolve(root, 'dist/ui', src), 'utf8');
    return `<script type="module">${code.replaceAll('</script', '<\\/script')}</script>`;
  });
  html = html.replace(/<link\b[^>]*\bhref="([^"]+)"[^>]*>/g, (tag, href) => {
    if (!tag.includes('stylesheet')) return '';
    if (!/^\.\/assets\/[A-Za-z0-9_.-]+\.css$/.test(href)) throw new Error('unexpected stylesheet reference');
    return `<style>${readFileSync(resolve(root, 'dist/ui', href), 'utf8').replaceAll('</style', '<\\/style')}</style>`;
  });
  const embedded = JSON.stringify({ schema: 'self-remediation-archive/1', disclosure: disclose ? 'redacted' : 'summary', events, artefacts }).replaceAll('<', '\\u003c');
  html = html.replace('<head>', `<head><script>window.__MAS_ARCHIVE__=${embedded};</script>`);
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'index.html'), html);
  mkdirSync(resolve(output, 'artefacts'), { recursive: true });
  for (const value of Object.values(artefacts)) writeFileSync(resolve(output, `artefacts/${value.projectionDigest}.json`), JSON.stringify(value.content));
  writeFileSync(resolve(output, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
  if (existsSync(resolve(root, 'dist/observer'))) cpSync(resolve(root, 'dist/observer'), resolve(output, 'observer'), { recursive: true });
  const manifest = { schema: 'self-remediation-archive/1', incidentId, generatedAt: new Date().toISOString(), eventCount: events.length,
    firstSeq: events[0]?.seq ?? 0, lastSeq: events.at(-1)?.seq ?? 0, disclosure: disclose ? 'redacted' : 'summary',
    files: ['index.html', 'events.jsonl'].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(resolve(output, path))).digest('hex') })),
    artefacts: Object.fromEntries(Object.entries(artefacts).map(([ref, value]) => [ref, { sourceDigest: value.sourceDigest, projectionDigest: value.projectionDigest, sourceDisclosure: value.sourceDisclosure }])),
    payloads: 'Explicitly disclosed payloads are redacted projections with separate digest identities. Large payload references are preserved. Raw credentials and protected evaluator material are excluded. The workflow retains permitted diagnostic artefacts separately.' };
  writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(resolve(output, 'README.md'), '# Self-healing replay\n\nOpen index.html directly in a browser. This is a self-contained Vue application with embedded committed events and no network dependency. Playback starts at sequence zero. Every panel is rebuilt from the displayed event prefix, including identities, outcomes and message flow.\n\nThe live observer is in observer/. Follow its README to watch an active workflow before completion.\n\nThis archive reports only retained observations. Candidate verification, trial recovery, PR creation, merge and deployed recovery remain distinct. Large payloads appear as retained artefact references unless separately included in the workflow diagnostics.\n');
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const eventsFile = argument('events'), output = argument('output'), incidentId = argument('incident');
  if (!eventsFile || !output || !incidentId) throw new Error('usage: archive --events FILE --output DIRECTORY --incident ID [--disclose]');
  const manifest = await createArchive({ eventsFile, output: resolve(output), incidentId, disclose: process.argv.includes('--disclose'), artefactsRoot: argument('artefacts'), disclosures: argument('disclosures'), discloseSource: process.argv.includes('--disclose-source') });
  console.log(`Archived ${manifest.eventCount} committed events to ${resolve(output, 'index.html')}`);
}
