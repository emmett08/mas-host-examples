/** Resolve the exact contract before either admission hashing or controller execution. */
import { ambiguousRequirement, unavailableRequirement, type CaseName } from './injectors.js';

interface OperationalRequirements {
  requirements?: Record<string, unknown>;
  unresolvedIntent?: string[];
}

export function resolveIncidentRequirements(
  base: Record<string, unknown>,
  caseName: CaseName,
  operational?: OperationalRequirements,
): { requirements: Record<string, unknown>; unresolvedIntent: string[] } {
  // Operational configuration owns its contract. The controller separately validates its required fields.
  if (operational) return { requirements: operational.requirements ?? base, unresolvedIntent: operational.unresolvedIntent ?? [] };
  if (caseName === 'unavailable-dependency') return { requirements: { ...base, externalTariff: unavailableRequirement }, unresolvedIntent: [] };
  if (caseName === 'ambiguous-requirement') return { requirements: { ...base, requestedChange: ambiguousRequirement }, unresolvedIntent: [ambiguousRequirement] };
  return { requirements: base, unresolvedIntent: [] };
}
