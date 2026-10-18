/** Decide candidate eligibility solely from frozen independent evidence and release authority. */
import { canonical } from '../deploy/effects.js';
import type { Identity, ReleasePolicy, Verification } from '../contracts/types.js';
export function eligibility(report: Verification, current: Identity, policy: ReleasePolicy): {eligible: boolean; reasons: string[]} {
  const reasons: string[] = [];
  if (canonical(report.identity) !== canonical(current)) reasons.push('evidence_identity_mismatch');
  if (report.authority !== 'independent' || report.evaluator !== policy.evaluator || !report.evaluatorVersion) reasons.push('evaluator_authority');
  if (!/^sha256:[a-f0-9]{64}$/.test(current.imageDigest)) reasons.push('immutable_image_required');
  if (new Set(report.criteria.map(x => x.id)).size !== report.criteria.length) reasons.push('duplicate_criteria');
  for (const id of policy.mandatoryCriteria) {
    const criterion = report.criteria.find(x => x.id === id);
    if (!criterion || !criterion.mandatory || criterion.status !== 'passed' || !criterion.evidence.length) reasons.push(`mandatory:${id}`);
  }
  if (report.criteria.some(x => x.mandatory && (x.status !== 'passed' || !x.evidence.length))) reasons.push('blocking_measurement');
  if (report.regressions.length) reasons.push('regression');
  if (report.remainingUncertainty.length) reasons.push('unresolved_release_uncertainty');
  if (report.changedCapabilities.some(x => !policy.allowedCapabilities.includes(x))) reasons.push('capability_boundary');
  if (report.changedResources.some(x => !policy.allowedResources.includes(x))) reasons.push('resource_boundary');
  return { eligible: reasons.length === 0, reasons };
}
/** Lexicographic preference only after every mandatory gate passes. */
export function preferEligible(reports: Verification[], current: Identity, policy: ReleasePolicy): Verification[] {
  return reports.filter(x => eligibility(x, current, policy).eligible).sort((a,b) =>
    a.operationalRisk - b.operationalRisk || a.unnecessaryChange - b.unnecessaryChange || a.costMicroUsd - b.costMicroUsd);
}
export function assertAutomaticScope(policy: ReleasePolicy): void {
  if (policy.mode === 'automatic' && (!policy.disposable || !/^demo\/incidents\/[a-zA-Z0-9_-]+$/.test(policy.baseRef)))
    throw new Error('Automatic publication requires an explicitly disposable incident branch');
}
