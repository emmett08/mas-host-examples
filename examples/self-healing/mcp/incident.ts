/** Retain the original controller dispatch and persistent incident cancellation. */
import { Journal } from '../controller/journal.js';
import { admissionDigest, canonical, type Admission, type Dispatch } from './contract.js';

const bindingKey = 'mcp:admission', dispatchKey = 'mcp:dispatch';
function open(admission: Admission): Journal {
  const journal = new Journal(admission.directory, admission.incidentId, admission.limits);
  try { journal.put(bindingKey, admissionDigest(admission)); return journal; }
  catch (error) { journal.close(); throw error; }
}
/** Atomic claim survives lost acknowledgements. A later request never starts a second controller. */
export function claim(admission: Admission, dispatch: Dispatch): boolean {
  const journal = open(admission);
  try {
    journal.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = journal.value<Dispatch>(dispatchKey);
      const cancelled = journal.isCancelled();
      if (previous || cancelled) { journal.db.exec('COMMIT'); return false; }
      journal.assertActive();
      journal.db.prepare('INSERT INTO values_store(key,value) VALUES(?,?)').run(dispatchKey, canonical(dispatch));
      journal.db.exec('COMMIT');
    } catch (error) { journal.db.exec('ROLLBACK'); throw error; }
    journal.append('mcp.dispatched', { requestId: dispatch.requestId, invocationId: dispatch.invocationId, contractDigest: dispatch.contractDigest });
    return true;
  } finally { journal.close(); }
}
export function cancelIncident(admission: Admission): void {
  const journal = open(admission);
  try { if (!journal.isCancelled()) journal.cancel('MCP incident cancellation requested'); }
  finally { journal.close(); }
}
export function interrupted(admission: Admission): void {
  const journal = open(admission);
  try { journal.append('mcp.interrupted', { status: 'unknown', reason: 'Controller completion was not confirmed; reconcile the original incident before resuming.' }); }
  finally { journal.close(); }
}
