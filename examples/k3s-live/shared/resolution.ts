// Application report contract. These outcomes describe an attempted external
// effect; they neither grant execution authority nor encode Kubernetes policy.
export type EffectOutcome = 'not_started' | 'rejected' | 'applied' | 'unknown';
export type VerificationOutcome = 'not_run' | 'passed' | 'failed' | 'inconclusive';
export interface PostChangeEvidence {
  version: 'mas-k8s-post-change-evidence/1';
  subject: { namespace: string; name: string; uid: string; container: 'checkout' };
  window: { startedAt: string; endedAt: string };
  logs: {
    status: 'collected' | 'unavailable'; source: string; observedAt: string; truncated: boolean;
    records: { timestamp: string; method: 'GET'; path: '/' | '/healthz' | '/readyz' | '/ready'; status: number }[];
    omittedLines: number; unparsedLines: number; reason?: string;
  };
  events: {
    status: 'collected' | 'unavailable'; source: string; observedAt: string; truncated: boolean;
    items: { metadata: { name: string; uid: string }; involvedObject: { namespace: string; name: string; uid: string };
      type: string; reason: string; message: string; count: number | null; readinessFailure: boolean;
      firstTimestamp: string | null; lastTimestamp: string | null; eventTime: string | null; seriesLastObservedTime: string | null }[];
    reason?: string;
  };
}
interface ResolutionBase {
  status: 'verified' | 'failed' | 'not-attempted';
  action: 'replace_readiness_probe_path'; target: { namespace: string; name: string; uid: string };
  recordedAt: string; reason: string; patch: unknown[]; before: unknown; after: unknown;
  checks: { name: string; passed: boolean; detail: string }[];
  verificationEvidence?: PostChangeEvidence;
}
export interface CurrentResolutionReport extends ResolutionBase {
  version: 'mas-k8s-resolution/2'; operationId: string; attemptId: string;
  effectOutcome: EffectOutcome; verificationOutcome: VerificationOutcome;
}
export interface LegacyResolutionReport extends ResolutionBase { version: 'mas-k8s-resolution/1'; }
export type ResolutionReport = CurrentResolutionReport | LegacyResolutionReport;

export interface ReconciliationObservation {
  version: 'mas-k8s-reconciliation/1'; id: string; sequence: number; runId: string;
  operationId: string; attemptId: string; reportDigest: string;
  target: ResolutionBase['target']; originalTemplateHash: string; observedAt: string;
  state: 'desired' | 'original' | 'changed' | 'unavailable'; reason: string;
  evidence: null | { namespaceUID: string; uid: string; resourceVersion: string;
    templateHash: string; readinessPath: string | null; generation: number;
    observedGeneration: number | null; readyReplicas: number };
}

export function validOutcomeCombination(report: Record<string, unknown>): boolean {
  if (report.version === 'mas-k8s-resolution/1') return true;
  if (report.version !== 'mas-k8s-resolution/2' ||
      !['operationId', 'attemptId'].every(key => typeof report[key] === 'string' &&
        /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(report[key] as string)) ||
      !['not_started', 'rejected', 'applied', 'unknown'].includes(String(report.effectOutcome)) ||
      !['not_run', 'passed', 'failed', 'inconclusive'].includes(String(report.verificationOutcome))) return false;
  if (report.effectOutcome !== 'applied' && report.verificationOutcome !== 'not_run') return false;
  if (report.status === 'verified') return report.effectOutcome === 'applied' && report.verificationOutcome === 'passed';
  if (report.verificationOutcome === 'passed') return false;
  if (report.status === 'not-attempted') return report.effectOutcome === 'not_started' && report.verificationOutcome === 'not_run';
  return report.status === 'failed';
}

export function outcomeLabels(report: ResolutionReport): { effect: string; verification: string } {
  if (report.version === 'mas-k8s-resolution/1') return {
    effect: 'Not separately recorded (legacy report)', verification: 'Not separately recorded (legacy report)',
  };
  const effects: Record<EffectOutcome, string> = {
    not_started: 'Not started', rejected: 'Rejected by the target API',
    applied: 'Application acknowledged', unknown: 'Unknown — no automatic retry',
  };
  const verification: Record<VerificationOutcome, string> = {
    not_run: 'Not run', passed: 'Passed', failed: 'Failed', inconclusive: 'Inconclusive',
  };
  return { effect: effects[report.effectOutcome], verification: verification[report.verificationOutcome] };
}
