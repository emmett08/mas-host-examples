export type EffectOutcome = 'not_started' | 'rejected' | 'applied' | 'unknown';
export type VerificationOutcome = 'not_run' | 'passed' | 'failed' | 'inconclusive';

export interface GuardedOperationResult<Effect, Verification> {
  operationId: string;
  attemptId: string;
  effectOutcome: EffectOutcome;
  verificationOutcome: VerificationOutcome;
  effectValue?: Effect;
  verificationValue?: Verification;
  error?: string;
}

/** An observed postcondition failed; unavailable evidence uses an ordinary Error. */
export class VerificationFailure extends Error {
  constructor(message: string, options?: ErrorOptions);
}

/** Storage and replay prevention belong to reserve, not to this executor. */
export function executeGuardedOperation<Input, Effect, Verification>(options: {
  operationId: string;
  attemptId: string;
  admitted: Input;
  reserve: (reservation: { operationId: string; attemptId: string; admitted: Input }) => Promise<void> | void;
  execute: (admitted: Input) => Promise<Effect> | Effect;
  verify: (effect: Effect) => Promise<Verification> | Verification;
  isDefiniteRejection?: (error: unknown) => boolean;
}): Promise<GuardedOperationResult<Effect, Verification>>;
