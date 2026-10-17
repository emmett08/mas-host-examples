// Validate the public audit projection and its immutable relationships for live and offline viewers.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 8192;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ref = value => object(value) && text(value.id) && digest(value.sha256);
const fail = detail => { throw new Error(`Invalid revision audit: ${detail}`); };
const keyOrder = (left, right) => {
  const a = Array.from(left, character => character.codePointAt(0));
  const b = Array.from(right, character => character.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
};
export function canonicalJson(value) {
  // This viewer refuses values JavaScript cannot retain exactly. The Rust
  // contract remains authoritative for the full signed 64-bit domain.
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('numeric value cannot be represented exactly by this viewer');
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort(keyOrder).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function parseRevisionAudit(value, previous) {
  if (!object(value) || value.version !== 'mas-host-revision-audit/1' ||
      !['in_progress', 'completed', 'exhausted', 'cancelled', 'failed', 'blocked', 'expired'].includes(value.status) ||
      !['candidates', 'assessments', 'records', 'contexts'].every(key => Array.isArray(value[key]) && value[key].length <= 1024) ||
      !(value.selected === null || ref(value.selected))) fail('unsupported version, status or record bounds');
  if (value.budget !== undefined && (!object(value.budget) ||
      !Number.isSafeInteger(value.budget.max_revisions) || value.budget.max_revisions < 0 || value.budget.max_revisions > 16 ||
      !Number.isSafeInteger(value.budget.max_invocations) || value.budget.max_invocations < 1 || value.budget.max_invocations > 1024 ||
      value.budget.used_invocations !== value.contexts.length || value.budget.used_invocations > value.budget.max_invocations)) fail('invocation or revision budget');
  const records = new Map();
  for (const row of value.records) {
    if (!object(row) || !['candidate', 'assessment', 'evidence', 'rubric'].includes(row.kind) ||
        !text(row.id) || !digest(row.sha256) || records.has(`${row.kind}:${row.id}`)) fail('record identity');
    if (row.redacted === true) {
      if (row.record !== undefined) fail('a withheld record contains content');
    } else if (!object(row.record) || row.record.schema_version !== 1 || row.record.id !== row.id ||
        !Array.isArray(row.readers) || row.readers.length !== 1 || row.readers[0] !== '*') fail('private or unsupported record entered public projection');
    records.set(`${row.kind}:${row.id}`, row);
  }
  const resolve = (reference, kind) => {
    if (!ref(reference)) fail('malformed reference');
    const row = records.get(`${kind}:${reference.id}`);
    if (!row || row.sha256 !== reference.sha256) fail(`unresolved exact ${kind} reference`);
    return row;
  };
  const candidates = new Map();
  for (const candidate of value.candidates) {
    const row = records.get(`candidate:${candidate?.id}`);
    if (!object(candidate) || candidate.schema_version !== 1 || !digest(candidate.output_sha256) ||
        !row?.record || canonicalJson(row.record) !== canonicalJson(candidate) || candidates.has(candidate.id) ||
        !Array.isArray(candidate.feedback)) fail('candidate identity or content');
    if (candidate.parent !== null) {
      resolve(candidate.parent, 'candidate');
      if (!candidates.has(candidate.parent.id)) fail('revision parent must precede its distinct child');
    } else if (candidate.feedback.length) fail('initial candidate cannot contain feedback');
    if (new Set(candidate.feedback.map(item => item.id)).size !== candidate.feedback.length) fail('duplicate supplied feedback');
    for (const feedback of candidate.feedback) {
      const assessment = resolve(feedback, 'assessment').record;
      if (assessment && (!candidate.parent || assessment.candidate.id !== candidate.parent.id ||
          assessment.candidate.sha256 !== candidate.parent.sha256)) fail('feedback assesses a different parent');
    }
    candidates.set(candidate.id, candidate);
  }
  const assessments = new Set();
  for (const assessment of value.assessments) {
    const row = records.get(`assessment:${assessment?.id}`);
    if (!object(assessment) || assessment.schema_version !== 1 || !row?.record ||
        canonicalJson(row.record) !== canonicalJson(assessment) || assessments.has(assessment.id) ||
        !object(assessment.evaluator) || !text(assessment.evaluator.id) || !text(assessment.evaluator.version) ||
        !['deterministic', 'model'].includes(assessment.evaluator.kind) ||
        !['completed', 'inconclusive', 'error'].includes(assessment.status) || !Array.isArray(assessment.findings)) fail('assessment identity or evaluator');
    resolve(assessment.candidate, 'candidate');
    const rubric = resolve(assessment.rubric, 'rubric').record;
    const criteria = new Map((rubric?.criteria ?? []).map(item => [item.id, item]));
    const seen = new Set();
    for (const finding of assessment.findings) {
      const criterion = criteria.get(finding?.criterion_id);
      if (!object(finding) || !text(finding.criterion_id) || seen.has(finding.criterion_id) ||
          !['pass', 'fail', 'inconclusive'].includes(finding.verdict) || !text(finding.explanation) ||
          !Array.isArray(finding.evidence) || (finding.verdict === 'inconclusive' ? finding.score !== null :
            !Number.isSafeInteger(finding.score) || !finding.evidence.length) ||
          rubric && (!criterion || criterion.measurement !== assessment.evaluator.kind || finding.score !== null &&
            (finding.score < criterion.minimum || finding.score > criterion.maximum))) fail('criterion, verdict or metric range');
      for (const evidence of finding.evidence) resolve(evidence, 'evidence');
      seen.add(finding.criterion_id);
    }
    if (assessment.status === 'error' ? !text(assessment.error) || assessment.findings.length !== 0
      : assessment.error !== null || !assessment.findings.length || rubric && criteria.size !== seen.size ||
        (assessment.status === 'inconclusive') !== assessment.findings.some(item => item.verdict === 'inconclusive')) fail('evaluator outcome cannot become a passing assessment');
    assessments.add(assessment.id);
  }
  if (value.selected !== null) resolve(value.selected, 'candidate');
  const contexts = new Set();
  for (const context of value.contexts) {
    if (!object(context) || !text(context.id) || !text(context.actor) || contexts.has(context.id)) fail('invocation identity');
    if (context.redacted === true) {
      if (context.input !== undefined || context.policy !== undefined) fail('a withheld context contains input or policy');
    } else if (!object(context.input) || !object(context.policy) || !Array.isArray(context.readers) ||
        context.readers.length !== 1 || context.readers[0] !== '*') fail('private invocation entered public projection');
    contexts.add(context.id);
  }
  if (previous) {
    if (previous.budget && (!value.budget || previous.budget.max_invocations !== value.budget.max_invocations ||
        previous.budget.max_revisions !== value.budget.max_revisions)) fail('frozen budget changed');
    const immutable = (old, current, key) => {
      for (const row of old) {
        const next = current.find(item => key(item) === key(row));
        if (!next) fail('retained history changed or disappeared');
        if (row.redacted || next.redacted) {
          // An explicit display opt-in may reveal a previously omitted body.
          // It cannot change the host's identity, digest or disclosure audience.
          const metadata = item => Object.fromEntries(Object.entries(item).filter(([name]) =>
            !['record', 'input', 'policy', 'redacted', 'output_sha256'].includes(name)));
          if (canonicalJson(metadata(row)) !== canonicalJson(metadata(next)) ||
              row.output_sha256 && next.output_sha256 && row.output_sha256 !== next.output_sha256) fail('retained history changed or disappeared');
        } else if (canonicalJson(row) !== canonicalJson(next)) fail('retained history changed or disappeared');
      }
    };
    immutable(previous.records, value.records, row => `${row.kind}:${row.id}`);
    immutable(previous.contexts, value.contexts, row => row.id);
    if (previous.selected !== null && (canonicalJson(previous.selected) !== canonicalJson(value.selected) ||
        previous.status !== value.status)) fail('terminal selection changed');
  }
  return value;
}

export function redactRevisionAudit(audit) {
  return { ...audit, candidates: [], assessments: [],
    records: audit.records.map(({ record, ...row }) => ({ ...row, redacted: true,
      ...(row.kind === 'candidate' && record ? { output_sha256: record.output_sha256 } : {}) })),
    contexts: audit.contexts.map(({ input: _input, policy: _policy, ...context }) => ({ ...context, redacted: true })) };
}

export function checkSelectedOutput(audit, output) {
  const selected = audit.candidates.find(candidate => candidate.id === audit.selected?.id);
  if (selected) {
    if (canonicalJson(selected.output) !== canonicalJson(output)) fail('selected output differs from its exact candidate');
  } else {
    const row = audit.records.find(item => item.kind === 'candidate' && item.id === audit.selected?.id);
    if (!row || row.sha256 !== audit.selected?.sha256 || !digest(row.output_sha256) ||
        row.readers?.length !== 1 || row.readers[0] !== '*') fail('selected output has no public exact candidate reference');
  }
}

const sha = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value))))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
export async function verifySelectedOutput(audit, output) {
  checkSelectedOutput(audit, output);
  const row = audit.records.find(item => item.kind === 'candidate' && item.id === audit.selected.id);
  if (await sha(output) !== (row.record?.output_sha256 ?? row.output_sha256)) fail('selected output digest');
}

/** Integrity check for the JSON domain of this incident example, before sharing or playback. */
export async function verifyRevisionDigests(audit) {
  for (const row of audit.records) {
    if (!row.record) continue;
    if (await sha(row.record) !== row.sha256) fail('record content differs from its digest');
    if (row.kind === 'candidate' && await sha(row.record.output) !== row.record.output_sha256) fail('candidate output digest');
    if (row.kind === 'evidence' && await sha(row.record.content) !== row.record.content_sha256) fail('evidence content digest');
  }
}
