// Trusted acquisition boundary: only checkpointed tool effects can become evidence.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { EVIDENCE_VERSION, parseEvidence, type EvidenceBundle, type EvidenceItem } from '../shared/evidence.js';
import { failureMessage, type FailureDiagnostics } from './diagnostics.js';

// A completed host task can still fail the application's evidence requirement.
// Keep this fixed diagnostic separate from arbitrary exception text or model prose.
export class InvestigationEvidenceFailure extends Error {
  readonly diagnostics: FailureDiagnostics;
  constructor(classification: 'investigation-no-tools' | 'investigation-incomplete-tools' = 'investigation-no-tools') {
    const diagnostics: FailureDiagnostics = { version: 'mas-demo-failure/1', classification,
      automaticRetry: false, effects: [] };
    super(failureMessage(diagnostics));
    this.name = 'InvestigationEvidenceFailure';
    this.diagnostics = diagnostics;
  }
}

export const investigationTools = ['pod_overview', 'pod_logs', 'pod_metrics', 'workload_spec'] as const;
export function requireInvestigationTools(tools: readonly unknown[]) {
  if (!tools.length) throw new InvestigationEvidenceFailure();
  if (tools.length !== investigationTools.length || new Set(tools).size !== investigationTools.length
    || investigationTools.some(tool => !tools.includes(tool)))
    throw new InvestigationEvidenceFailure('investigation-incomplete-tools');
}
export interface InvestigationAudit {
  status: 'running' | 'completed' | 'failed'; runId: string;
  contextSha256?: string; evidence?: EvidenceBundle;
  calls: { id: string; tool: string; status: 'collected' | 'unavailable' | 'error'; evidenceIds: string[] }[];
  summary?: unknown;
  // Retain the provider's output separately from the audit summary, whose
  // limitations also include facts enforced by the collection boundary.
  modelSummary?: unknown; collectionLimitations?: string[]; error?: string;
}
export function investigationSummary(audit: InvestigationAudit, modelSummary: unknown) {
  const output = row(modelSummary);
  if (typeof output.summary !== 'string' || !Array.isArray(output.limitations)
    || output.limitations.some((value: unknown) => typeof value !== 'string'))
    throw new Error('Invalid investigator summary');
  const collectionLimitations = [
    ...(audit.evidence?.items.flatMap(item => [
      ...(item.truncated ? [`Evidence ${item.id} is truncated; omitted content is unavailable for assessment.`] : []),
      ...(item.status !== 'collected' ? [`Evidence ${item.id} is ${item.status}; no observation was collected.`] : []),
    ]) ?? []),
    ...audit.calls.filter(call => call.status !== 'collected')
      .map(call => `MCP tool ${call.tool} returned ${call.status}; its requested observations were not fully collected.`),
  ];
  return { modelSummary, collectionLimitations,
    summary: { ...output, limitations: [...new Set([...output.limitations, ...collectionLimitations])] } };
}
export const contentHash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function retainFile(path: string, value: unknown) {
  const bytes = JSON.stringify(value);
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    if (await readFile(path, 'utf8') !== bytes) throw new Error('Retained investigation input changed');
  }
  return contentHash(bytes);
}
const row = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export function freezeInvestigation(id: string, raw: unknown, seed: EvidenceBundle,
  source: 'recorded-evidence' | 'kubernetes-api', contextSha256: string): InvestigationAudit {
  const observation = row(raw);
  if (observation.run_id !== id || observation.cancelled || !Number.isSafeInteger(observation.observed_at_ms)
    || !Array.isArray(observation.steps) || observation.steps.some((step: any) => step.kind === 'effect' && step.state !== 'completed'))
    throw new Error('Investigation has unresolved effects or invalid identity');
  const effects = observation.steps.filter((step: any) => step.kind === 'effect' && step.key === 'command');
  requireInvestigationTools(effects.map((step: any) => step.actor));
  const items = new Map<string, EvidenceItem>();
  const calls: InvestigationAudit['calls'] = [];
  for (const step of effects) {
    const result = row(step.output?.output);
    if (!investigationTools.includes(step.actor) || step.output?.status !== 'completed' || result.tool !== step.actor
      || result.server !== 'mas-k3s-investigation' || result.source !== source || result.context_sha256 !== contextSha256
      || !['collected', 'unavailable', 'error'].includes(result.status)
      || ['namespace', 'name', 'uid'].some(key => result.subject?.[key] !== seed.subject[key as keyof typeof seed.subject]))
      throw new Error('MCP result does not belong to the admitted investigation');
    const bundle = parseEvidence({ version: EVIDENCE_VERSION, capturedAt: new Date(observation.observed_at_ms).toISOString(),
      subject: seed.subject, items: result.evidence_items });
    if (!bundle) throw new Error('MCP result has no evidence');
    for (const item of bundle.items) {
      const previous = items.get(item.id);
      if (previous && (previous.kind !== item.kind || previous.source !== item.source
        || Date.parse(item.observedAt) < Date.parse(previous.observedAt)
        || (item.observedAt === previous.observedAt && JSON.stringify(item) !== JSON.stringify(previous))))
        throw new Error('Conflicting or backwards MCP evidence');
      if (item.kind === 'pod' && item.status === 'collected') {
        const metadata = row(row(item.data).metadata);
        if (['namespace', 'name', 'uid'].some(key => metadata[key] !== seed.subject[key as keyof typeof seed.subject]))
          throw new Error('Collected Pod evidence has a foreign identity');
      }
      // Repeated reads select the latest recorded observation. This is an
      // explicitly timed bundle, not a claim of an atomic cluster snapshot.
      items.set(item.id, item);
    }
    calls.push({ id: step.id, tool: step.actor, status: result.status, evidenceIds: bundle.items.map(item => item.id) });
  }
  const evidence = parseEvidence({ version: EVIDENCE_VERSION, capturedAt: new Date(observation.observed_at_ms).toISOString(),
    subject: seed.subject, items: [...items.values()] });
  if (!evidence?.items.some(item => item.status === 'collected')) throw new Error('MCP investigation collected no usable observations');
  return { status: 'completed', runId: id, contextSha256, calls, evidence };
}
