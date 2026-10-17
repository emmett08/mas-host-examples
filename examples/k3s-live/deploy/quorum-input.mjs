// Prepare the optional review from public, digest-verified retained host records.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseRevisionAudit, verifyRevisionDigests } from '../shared/revision.mjs';

export async function quorumInput(result) {
  const audit = parseRevisionAudit(result.revision);
  await verifyRevisionDigests(audit);
  if (audit.status !== 'completed' || !audit.selected) throw new Error('A completed retained assessment is required');
  const candidate = audit.candidates.find(row => row.id === audit.selected.id);
  const assessment = audit.assessments.find(row => row.candidate.id === audit.selected.id &&
    row.candidate.sha256 === audit.selected.sha256 && row.evaluator.id === 'incident_checks' && row.status === 'completed');
  const rubric = audit.records.find(row => row.kind === 'rubric' && row.id === assessment?.rubric.id && row.sha256 === assessment.rubric.sha256);
  const incident = audit.records.find(row => row.kind === 'evidence' && row.id === 'incident');
  if (!candidate || !assessment || !rubric?.record || !incident?.record || incident.readers?.join() !== '*')
    throw new Error('The exact candidate, rubric and public incident must be available');
  const refs = new Map(assessment.findings.flatMap(row => row.evidence).map(row => [row.id, row.sha256]));
  const evidence = audit.records.filter(row => row.kind === 'evidence' && refs.get(row.id) === row.sha256);
  if (evidence.length !== refs.size || evidence.some(row => !row.record || row.readers?.join() !== '*'))
    throw new Error('All selected supporting evidence must be public and available');
  return {
    candidate: audit.selected, candidate_record: candidate, rubric: rubric.record,
    incident: incident.record.content, evidence: evidence.map(row => row.record),
    review_context: { criterion_id: 'incident-constraints/1:all', rubric: assessment.rubric,
      evidence: evidence.map(row => ({ id: row.id, sha256: row.sha256 })) },
  };
}

if (process.argv[1] && import.meta.url === new URL(resolve(process.argv[1]), 'file:').href) {
  if (process.argv.length !== 3) throw new Error('Usage: node deploy/quorum-input.mjs HOST_RESULT.json');
  process.stdout.write(`${JSON.stringify(await quorumInput(JSON.parse(await readFile(process.argv[2], 'utf8'))), null, 2)}\n`);
}
