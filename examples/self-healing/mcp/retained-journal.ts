/** Publish a complete incident journal before concurrent readers or writers can open it. */
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Journal } from '../controller/journal.js';
import { admissionDigest, type Admission } from './contract.js';

export const bindingKey = 'mcp:admission', dispatchKey = 'mcp:dispatch';

function initialise(admission: Admission): void {
  if (existsSync(join(admission.directory, 'journal.sqlite'))) return;
  // An existing incomplete directory is retained evidence, never a fresh budget.
  if (existsSync(admission.directory)) throw new Error('Retained incident journal is incomplete');
  const temporary = mkdtempSync(join(dirname(admission.directory), `.${basename(admission.directory)}.initialising-`));
  try {
    const journal = new Journal(temporary, admission.incidentId, admission.limits);
    try { journal.put(bindingKey, admissionDigest(admission)); }
    finally { journal.close(); }
    try { renameSync(temporary, admission.directory); }
    catch (error: any) {
      // Another first operation may have published the same incident while this one prepared it.
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !existsSync(join(admission.directory, 'journal.sqlite'))) throw error;
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function openIncident(admission: Admission): Journal {
  initialise(admission);
  const journal = new Journal(admission.directory, admission.incidentId, admission.limits);
  try {
    if (journal.value(bindingKey) !== admissionDigest(admission)) throw new Error('Retained incident contract mismatch');
    return journal;
  } catch (error) { journal.close(); throw error; }
}
