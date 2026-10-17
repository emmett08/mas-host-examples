// Derive permitted canvas edges from the same topology file consumed by MAS.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

export async function topology(project: string, mode: string) {
  const config = parse(await readFile(join(project, 'topology.yaml'), 'utf8'));
  const nodes = [
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
  ];
  // The optional, separately invoked review_quorum workflow is outside this
  // incident run. Keep this canvas's routes bound to its displayed actors.
  const displayed = new Set(nodes.map(node => node.id));
  return { mode, nodes, edges: config.edges.filter(([from, to]: string[]) =>
    typeof from === 'string' && typeof to === 'string' && displayed.has(from) && displayed.has(to))
    .map(([from, to]: string[]) => ({ from, to,
    ...((from === 'platform' && to === 'security') || (from === 'security' && to === 'platform') ? { kind: 'peer' } : {}) })) };
}

export async function investigationTopology(project: string, mode: string) {
  const config = parse(await readFile(join(project, 'topology.mcp.yaml'), 'utf8'));
  return { mode, nodes: [
    { id: 'client', label: 'Bound incident', kind: 'client', group: 'ingress' },
    { id: 'investigator', label: 'Tool-using investigator', kind: 'llm', group: 'coordination', model: 'GPT-5.4 Mini' },
    ...['pod_overview', 'pod_logs', 'pod_metrics', 'workload_spec'].map(id => ({ id, label: id.replaceAll('_', ' '), kind: 'tool', group: 'specialists' })),
  ], edges: config.edges.map(([from, to]: string[]) => ({ from, to })) };
}
