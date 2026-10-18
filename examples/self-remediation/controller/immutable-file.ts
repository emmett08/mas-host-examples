/** Preserve exact frozen bytes across process restarts without reopening them for writing. */
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

export function writeImmutableFile(path: string, bytes: string, mode = 0o400): void {
  try { writeFileSync(path, bytes, { flag: 'wx', mode }); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!lstatSync(path).isFile() || readFileSync(path, 'utf8') !== bytes)
    throw new Error(`Frozen artefact changed: ${basename(path)}`);
}
