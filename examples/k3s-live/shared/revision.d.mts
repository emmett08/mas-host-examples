/** Public projection of the host's versioned assessment audit; no private payloads. */
export interface DigestRef { id: string; sha256: string }
export interface Candidate {
  schema_version: 1; id: string; output: unknown; output_sha256: string;
  parent: DigestRef | null; feedback: DigestRef[];
}
export interface Finding {
  criterion_id: string; verdict: 'pass' | 'fail' | 'inconclusive'; score: number | null;
  evidence: DigestRef[]; explanation: string;
}
export interface Assessment {
  schema_version: 1; id: string; candidate: DigestRef;
  evaluator: { id: string; version: string; kind: 'deterministic' | 'model' };
  rubric: DigestRef; status: 'completed' | 'inconclusive' | 'error'; findings: Finding[]; error: string | null;
}
export interface AuditRecord {
  kind: 'candidate' | 'assessment' | 'evidence' | 'rubric'; id: string; sha256: string;
  readers?: string[]; record?: Record<string, unknown>; redacted?: boolean;
  output_sha256?: string;
}
export interface InvocationContext {
  id: string; actor: string; readers?: string[]; redacted?: boolean; parent?: string;
  input?: Record<string, unknown>; policy?: Record<string, unknown>;
}
export interface RevisionAudit {
  version: 'mas-host-revision-audit/1'; status: string; selected: DigestRef | null;
  candidates: Candidate[]; assessments: Assessment[]; records: AuditRecord[]; contexts: InvocationContext[];
  budget?: { max_revisions: number; max_invocations: number; used_invocations: number };
}
export function canonicalJson(value: unknown): string;
export function parseRevisionAudit(value: unknown, previous?: RevisionAudit): RevisionAudit;
export function verifyRevisionDigests(audit: RevisionAudit): Promise<void>;
export function redactRevisionAudit(audit: RevisionAudit): RevisionAudit;
export function checkSelectedOutput(audit: RevisionAudit, output: unknown): void;
export function verifySelectedOutput(audit: RevisionAudit, output: unknown): Promise<void>;
