/** Frozen application identities, measurements and terminal outcomes. */
export type Outcome = 'verified_recovery' | 'no_repair_required' | 'no_eligible_candidate' |
  'missing_requirements' | 'unreproduced_failure' | 'unavailable_external_cause' |
  'stale_revision_target' | 'exhausted_budget' | 'policy_boundary' | 'cancelled' | 'unknown_effect';
export interface Budget { calls: number; candidates: number; operations: number; microUsd: number; wallMs: number }
export interface Identity {
  baseCommit: string; sourceTree: string; candidateTree: string; patch: string;
  requirements: string; tests: string; environment: string; configuration: string; imageDigest: string;
}
export interface Criterion {
  id: string; status: 'passed' | 'failed' | 'inconclusive'; mandatory: boolean;
  value?: number | string; unit?: string; evidence: string[]; explanation: string;
}
export interface Verification {
  identity: Identity; evaluator: string; evaluatorVersion: string; criteria: Criterion[];
  regressions: string[]; changedCapabilities: string[]; changedResources: string[];
  remainingUncertainty: string[]; operationalRisk: number; unnecessaryChange: number; costMicroUsd: number;
  authority: 'independent'; exposure: 'development' | 'final-untouched' | 'final-disclosed';
}
export interface ReleasePolicy {
  mode: 'archive' | 'pull-request' | 'automatic'; repository: string; baseRef: string;
  disposable: boolean; mandatoryCriteria: string[]; evaluator: string;
  allowedCapabilities: string[]; allowedResources: string[];
}
export interface Hypothesis { id: string; mechanism: string; evidence: string[]; contradictions: string[]; predictions: string[]; rank: number }
export interface Investigation {
  hypotheses: Hypothesis[]; experiment: { kind: 'diagnostic' | 'http'; rationale: string; predictions: string[]; program?: string; requests?: {path: string; expectedStatus?: number}[] };
  unresolvedIntent: string[]; disposition: 'investigate' | 'missing_requirements' | 'external_unavailable' | 'no_repair_required';
}
export interface Synthesis { edits: {path: string; content: string | null}[]; rationale: string; changedCapabilities: string[]; changedResources: string[] }
export interface Review { eligible: boolean; findings: string[]; remainingUncertainty: string[]; risk: 'low' | 'medium' | 'high' }
