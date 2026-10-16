// Derive permitted canvas edges from the same topology file consumed by MAS.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

export async function topology(project: string, mode: string) {
  const config = parse(await readFile(join(project, 'topology.yaml'), 'utf8'));
  return { mode, nodes: [
    { id: 'client', label: 'Incident event', kind: 'client', group: 'ingress' },
    { id: 'assessed_draft', label: 'Draft invocation', kind: 'workflow', group: 'ingress' },
    { id: 'assessed_revision', label: 'Revision invocation', kind: 'workflow', group: 'ingress' },
    { id: 'incident_checks', label: 'Candidate checks', kind: 'tool', group: 'decision' },
    { id: 'coordinator', label: 'Coordinator', kind: 'workflow', group: 'coordination' },
    { id: 'platform', label: 'Platform branch', kind: 'workflow', group: 'coordination' },
    { id: 'security', label: 'Security branch', kind: 'workflow', group: 'coordination' },
    { id: 'diagnose', label: 'Platform specialist', kind: 'llm', group: 'specialists', model: 'GPT-5.4 Mini' },
    { id: 'security_review', label: 'Security specialist', kind: 'llm', group: 'specialists', model: 'GPT-5.4 Mini' },
    { id: 'decision', label: 'Investigation plan', kind: 'llm', group: 'decision', model: 'GPT-5.4' },
  ], edges: config.edges.map(([from, to]: string[]) => ({ from, to,
    ...((from === 'platform' && to === 'security') || (from === 'security' && to === 'platform') ? { kind: 'peer' } : {}) })) };
}
