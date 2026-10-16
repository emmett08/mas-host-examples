// Project retained inference evidence into fixed, public diagnostic fields.
// Full observation also contains application output and protocol payloads: none of
// those objects, provider messages or CLI stderr may cross this boundary.
export type FailureClassification = 'authentication' | 'permission' | 'model-unavailable' | 'quota' |
  'rate-limit' | 'invalid-schema' | 'invalid-request' | 'missing-credential' |
  'uncertain-provider-outcome' | 'invalid-output' | 'provider-rejected' | 'host-failure';
export interface FailedInference {
  actor: string; effectId: string; state: string; classification: FailureClassification;
  certainty?: string; outputStatus?: string; httpStatus?: number; provider?: string; model?: string;
  errorCode?: string; errorType?: string; errorParam?: string;
}
export interface FailureDiagnostics {
  version: 'mas-demo-failure/1'; classification: FailureClassification;
  automaticRetry: false; effects: FailedInference[];
}
const actors = ['diagnose', 'platform_diagnosis', 'security_review', 'decision'];
const models = ['gpt-5.4-mini-2026-03-17', 'gpt-5.4-2026-03-05'];
const states = ['prepared', 'executing', 'unknown', 'completed', 'resolved', 'failed', 'blocked', 'rejected'];
const certainties = ['completed', 'not_sent', 'rejected'];
const outputStatuses = ['valid', 'invalid', 'unavailable', 'refused', 'incomplete', 'rejected'];
const providers = ['openai', 'openai-compatible', 'cursor', 'command', 'mock'];
const errorCodes = ['invalid_api_key', 'invalid_json_schema', 'insufficient_quota', 'credit_balance_exhausted',
  'billing_hard_limit_reached', 'rate_limit_exceeded', 'slow_down', 'model_not_found', 'permission_denied',
  'unsupported_country_region_territory', 'organization_restricted', 'project_archived', 'invalid_parameter',
  'missing_required_parameter', 'unsupported_parameter', 'unsupported_value', 'context_length_exceeded',
  'content_policy_violation'];
const errorTypes = ['invalid_request_error', 'authentication_error', 'permission_error', 'rate_limit_error',
  'insufficient_quota', 'server_error'];
const errorParams = ['model', 'input', 'instructions', 'max_output_tokens', 'max_tokens', 'messages',
  'response_format', 'response_format.type', 'response_format.json_schema', 'response_format.json_schema.name',
  'response_format.json_schema.schema', 'response_format.json_schema.strict', 'text', 'text.format',
  'text.format.type', 'text.format.name', 'text.format.schema', 'text.format.strict', 'tools', 'tool_choice',
  'parallel_tool_calls', 'store', 'stream', 'temperature', 'top_p', 'reasoning', 'reasoning.effort',
  'service_tier', 'previous_response_id'];
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const allowed = (value: unknown, values: readonly string[]) =>
  typeof value === 'string' && values.includes(value) ? value : undefined;
const fallback = (): FailureDiagnostics => ({ version: 'mas-demo-failure/1', classification: 'host-failure',
  automaticRetry: false, effects: [] });

function classify(effect: Omit<FailedInference, 'classification'>, output: Record<string, unknown>): FailureClassification {
  if (['executing', 'unknown'].includes(effect.state)) return 'uncertain-provider-outcome';
  if (effect.certainty === 'not_sent' && output.reason === 'provider credential environment is missing or invalid') return 'missing-credential';
  if (effect.httpStatus === 401) return 'authentication';
  if (effect.httpStatus === 403) return 'permission';
  if (effect.httpStatus === 404) return 'model-unavailable';
  if (effect.httpStatus === 429) {
    if (['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached'].includes(effect.errorCode ?? '') ||
        effect.errorType === 'insufficient_quota') return 'quota';
    if (['rate_limit_exceeded', 'slow_down'].includes(effect.errorCode ?? '') || effect.errorType === 'rate_limit_error') return 'rate-limit';
    return 'provider-rejected';
  }
  if (effect.httpStatus === 400 && effect.errorCode === 'invalid_json_schema') return 'invalid-schema';
  if (effect.httpStatus === 400) return 'invalid-request';
  if (effect.certainty === 'rejected' || effect.outputStatus === 'rejected') return 'provider-rejected';
  if (effect.certainty === 'completed' && effect.outputStatus !== 'valid') return 'invalid-output';
  return 'host-failure';
}

export function projectFailure(observation: unknown, runId: string): FailureDiagnostics {
  const source = object(observation);
  if (source.version !== 'mas-host-observation/1' || source.run_id !== runId || !Array.isArray(source.steps)) return fallback();
  const effects: FailedInference[] = [];
  // The demo reserves at most sixteen calls. The protocol permits sixty-four
  // messages; retain no more than that bound even for malformed observation.
  for (const value of source.steps) {
    if (effects.length >= 64) break;
    const step = object(value), output = object(step.output), evidence = object(step.evidence);
    const actor = allowed(step.actor, actors), state = allowed(step.state, states);
    if (step.kind !== 'effect' || typeof step.key !== 'string' || !/^inference-[0-9]{1,2}$/.test(step.key) ||
        !actor || !state || typeof step.id !== 'string' || !/^eff-[a-f0-9]{64}$/.test(step.id)) continue;
    const certainty = allowed(output.certainty, certainties), outputStatus = allowed(output.output_status, outputStatuses);
    if (['completed', 'resolved'].includes(state) && certainty === 'completed' && outputStatus === 'valid' && output.cleanup !== 'incomplete') continue;
    const provider = providers.find(kind => evidence.adapter === `mas-host-${kind}/1` || evidence.provider === kind);
    const fields = {
      actor, effectId: step.id, state,
      ...(certainty ? { certainty } : {}), ...(outputStatus ? { outputStatus } : {}),
      ...(provider ? { provider } : {}),
      ...(allowed(evidence.requested_model ?? evidence.model, models) ? { model: allowed(evidence.requested_model ?? evidence.model, models) } : {}),
      ...(Number.isSafeInteger(evidence.http_status) && Number(evidence.http_status) >= 100 && Number(evidence.http_status) <= 599 ? { httpStatus: Number(evidence.http_status) } : {}),
      ...(allowed(evidence.error_code, errorCodes) ? { errorCode: allowed(evidence.error_code, errorCodes) } : {}),
      ...(allowed(evidence.error_type, errorTypes) ? { errorType: allowed(evidence.error_type, errorTypes) } : {}),
      ...(allowed(evidence.error_param, errorParams) ? { errorParam: allowed(evidence.error_param, errorParams) } : {}),
    };
    effects.push({ ...fields, classification: classify(fields, output) });
  }
  const classification = effects.find(effect => effect.classification === 'uncertain-provider-outcome')?.classification ??
    effects.find(effect => effect.classification !== 'host-failure')?.classification ?? 'host-failure';
  return { version: 'mas-demo-failure/1', classification, automaticRetry: false, effects };
}

export function failureMessage(diagnostics: FailureDiagnostics): string {
  const reasons: Record<FailureClassification, string> = {
    authentication: 'The provider rejected authentication (HTTP 401). Check the OPENAI_API_KEY environment secret.',
    permission: 'The provider rejected access (HTTP 403). Check the project, model and key permissions.',
    'model-unavailable': 'The provider could not find the requested model (HTTP 404). Check model access and its configured identifier.',
    quota: 'The provider reported exhausted quota or credit (HTTP 429). Check the OpenAI project billing and limits.',
    'rate-limit': 'The provider rejected the request with HTTP 429. Check rate limits and retained evidence before starting another run.',
    'invalid-schema': 'The provider rejected the structured output schema (HTTP 400, invalid_json_schema). Correct the schema before starting another run.',
    'invalid-request': 'The provider rejected the request (HTTP 400). Check the retained parameter and error code.',
    'missing-credential': 'The provider credential environment is missing or invalid. Check the backend OPENAI_API_KEY Secret.',
    'uncertain-provider-outcome': 'A provider effect has an uncertain outcome. Inspect and reconcile retained host state before retrying; inference will not repeat automatically.',
    'invalid-output': 'The provider completed without usable schema-valid output. Inspect retained host state before starting another run.',
    'provider-rejected': 'The provider rejected the request. Check the retained HTTP status and diagnostic identifiers.',
    'host-failure': 'Host did not complete. Inspect retained state before retrying an uncertain provider outcome.',
  };
  const detail = diagnostics.effects.slice(0, 3).map(effect => [effect.actor,
    effect.httpStatus ? `HTTP ${effect.httpStatus}` : effect.state, effect.errorCode].filter(Boolean).join(': ')).join('; ');
  return `${reasons[diagnostics.classification]}${detail ? ` Failed inference: ${detail}.` : ''}`;
}
