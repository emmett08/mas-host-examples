/** Retain the original controller dispatch and persistent incident cancellation. */
import { canonical, type Admission, type Dispatch } from './contract.js';
import { openIncident, dispatchKey } from './retained-journal.js';

/** Atomic claim survives lost acknowledgements. A later request never starts a second controller. */
export function claim(admission: Admission, dispatch: Dispatch): boolean {
  const journal = openIncident(admission);
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
export function cancelIncident(admission: Admission, reason = 'MCP incident cancellation requested'): void {
  const journal = openIncident(admission);
  try { if (!journal.isCancelled()) journal.cancel(reason); }
  finally { journal.close(); }
}
export function interrupted(admission: Admission): void {
  const journal = openIncident(admission);
  try { journal.append('mcp.interrupted', { status: 'unknown', reason: 'Controller completion was not confirmed; reconcile the original incident before resuming.' }); }
  finally { journal.close(); }
}
