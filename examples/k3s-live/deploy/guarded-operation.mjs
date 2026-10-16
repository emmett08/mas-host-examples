/** An observed postcondition failed. Unavailable evidence uses an ordinary Error. */
export class VerificationFailure extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'VerificationFailure';
  }
}

function describeError(error) {
  try { return error instanceof Error ? error.message : String(error); }
  catch { return 'The adapter raised an error that could not be represented as text'; }
}

/**
 * Execute one previously admitted operation, at most once per invocation.
 *
 * The adapter's reserve callback must durably bind the operation and attempt IDs
 * to the exact admitted input, refuse replay (including after process restart),
 * and resolve only after an unambiguous acknowledgement. This function supplies
 * no storage or cross-invocation deduplication. A reservation error never permits
 * execution, even if the reservation may have committed.
 *
 * A fulfilled execute callback must mean that the remote system acknowledged
 * the admitted effect. Otherwise it must throw; only a supplied classifier's
 * literal true establishes definite rejection without an effect. Verification
 * must throw VerificationFailure for an observed failed postcondition, or an
 * ordinary error when it cannot establish the postcondition. Neither path
 * retries execution. Later read-only observations belong in separate records;
 * they must not overwrite an original unknown outcome or authorise replay.
 */
export async function executeGuardedOperation({ operationId, attemptId, admitted, reserve, execute, verify,
  isDefiniteRejection = () => false } = {}) {
  for (const [name, identity] of Object.entries({ operationId, attemptId })) {
    if (typeof identity !== 'string' || identity.length === 0 || identity.trim() !== identity) {
      throw new TypeError(`${name} must be a non-empty string without surrounding whitespace`);
    }
  }
  for (const [name, callback] of Object.entries({ reserve, execute, verify, isDefiniteRejection })) {
    if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (admitted === undefined) throw new TypeError('admitted input is required');
  // Separate copies prevent caller or reservation-callback mutation from
  // changing the execution input while reservation acknowledgement is pending.
  const input = structuredClone(admitted);
  const reservationInput = structuredClone(input);
  const executionInput = structuredClone(input);
  const result = { operationId, attemptId, effectOutcome: 'not_started', verificationOutcome: 'not_run' };
  try {
    await reserve({ operationId, attemptId, admitted: reservationInput });
  } catch (error) {
    return { ...result, error: describeError(error) };
  }

  result.effectOutcome = 'unknown';
  try {
    result.effectValue = await execute(executionInput);
    result.effectOutcome = 'applied';
  } catch (error) {
    // A faulty classifier cannot turn uncertainty into permission to retry.
    try { if (isDefiniteRejection(error) === true) result.effectOutcome = 'rejected'; }
    catch { /* Retain unknown when classification itself fails. */ }
    return { ...result, error: describeError(error) };
  }

  try {
    result.verificationValue = await verify(result.effectValue);
    result.verificationOutcome = 'passed';
  } catch (error) {
    result.verificationOutcome = error instanceof VerificationFailure ? 'failed' : 'inconclusive';
    result.error = describeError(error);
  }
  return result;
}
