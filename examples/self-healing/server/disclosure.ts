import { readFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { redact } from '../ui/events.js';
export interface DisclosedArtefact { sourceDigest: string; projectionDigest: string; content: unknown; sourceDisclosure: boolean }
function containsSource(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSource);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (typeof object.path === 'string' && ('content' in object || 'before' in object || 'after' in object)) return true;
    return Object.values(object).some(containsSource);
  }
  return false;
}
/** Only a controller-authored disclosure manifest can select artefacts; never enumerate a run directory. */
export function loadDisclosedArtefacts(root: string, manifest: string, discloseSource = false): Record<string, DisclosedArtefact> {
  const selected: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  const entries = Array.isArray(selected) ? selected : selected && typeof selected === 'object' ? (selected as { artefacts?: unknown }).artefacts : undefined;
  if (!Array.isArray(entries) || entries.length > 256) throw new Error('Disclosure manifest must contain at most 256 explicit references');
  const result: Record<string, DisclosedArtefact> = {};
  const realRoot = realpathSync(root);
  for (const entry of entries) {
    const reference = typeof entry === 'string' ? entry : entry?.ref ?? entry?.sha256 ?? entry?.digest;
    if (typeof reference !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/.test(reference)) throw new Error('Invalid disclosed artefact reference');
    const digest = reference.replace(/^sha256:/, '');
    const rawPath = resolve(root, existsSync(resolve(root, digest)) ? digest : `${digest}.json`);
    if (lstatSync(rawPath).isSymbolicLink() || !realpathSync(rawPath).startsWith(realRoot + sep)) throw new Error('Artefact escaped its admitted directory');
    if (lstatSync(rawPath).size > 2_000_000) throw new Error('Artefact exceeds disclosure size bound');
    const bytes = readFileSync(rawPath);
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Artefact content identity mismatch');
    let raw: unknown; try { raw = JSON.parse(bytes.toString()); } catch { raw = bytes.toString(); }
    const source = containsSource(raw) || entry?.kind === 'source';
    if (source && !discloseSource) continue;
    const content = redact(raw, false);
    const projectionDigest = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    result[`sha256:${digest}`] = { sourceDigest: digest, projectionDigest, content, sourceDisclosure: source };
  }
  return result;
}
