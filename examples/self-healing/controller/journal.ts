/** Own durable incident state, reservations, effect outbox and committed observations. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, sha256, UnknownEffect, type EffectRecord, type EffectStore, type Json } from '../deploy/effects.js';
import type { Budget } from '../contracts/types.js';
import { Artefacts } from './artefacts.js';
import { writeImmutableFile } from './immutable-file.js';
export class Boundary extends Error { constructor(readonly outcome: string, message = outcome) { super(message); } }
export const DEFAULT_BUDGET: Budget = { calls: 32, candidates: 3, operations: 80, microUsd: 2_000_000, wallMs: 900_000 };
export interface JournalEvent { seq: number; incidentId: string; time: string; type: string; data: Record<string, unknown> }
export class Journal implements EffectStore {
  readonly db: DatabaseSync;
  readonly artefacts: Artefacts;
  static open(directory: string, incidentId: string): Journal { return new Journal(directory, incidentId); }
  constructor(readonly directory: string, readonly incidentId = 'publication', limits?: Budget) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.artefacts = new Artefacts(join(directory, 'artefacts'));
    this.db = new DatabaseSync(join(directory, 'journal.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY, cancelled INTEGER NOT NULL DEFAULT 0, metadata TEXT);
      CREATE TABLE IF NOT EXISTS budgets(scope TEXT PRIMARY KEY, limits TEXT NOT NULL, used TEXT NOT NULL, deadline INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, scope TEXT NOT NULL, charge TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, incident TEXT NOT NULL, time TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS phases(id TEXT PRIMARY KEY, incident TEXT NOT NULL, identity TEXT NOT NULL, status TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY, incident TEXT NOT NULL, target TEXT NOT NULL, record TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_target ON effects(target) WHERE json_extract(record,'$.status') IN ('intended','unknown');
      CREATE TABLE IF NOT EXISTS candidates(tree TEXT NOT NULL, incident TEXT NOT NULL, result TEXT, PRIMARY KEY(tree,incident));
      CREATE TABLE IF NOT EXISTS targets(target TEXT PRIMARY KEY, owner TEXT NOT NULL, revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS values_store(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable events'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'immutable events'); END;`);
    this.db.prepare('INSERT OR IGNORE INTO incidents(id) VALUES(?)').run(incidentId);
    const existing = this.db.prepare('SELECT limits FROM budgets WHERE scope=?').get(incidentId);
    const selected = limits ?? (existing ? JSON.parse(String(existing.limits)) as Budget : DEFAULT_BUDGET);
    this.ensureBudget('workflow', selected);
    this.ensureBudget(incidentId, selected);
    this.exportEvents();
  }
  private transaction<T>(f: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    let result:T;
    try { result = f(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.exportEvents(); return result;
  }
  private ensureBudget(scope: string, limits: Budget): void {
    for (const [key, n] of Object.entries(limits)) if (!Number.isSafeInteger(n) || n < 0 || (key === 'wallMs' && n === 0)) throw new Error('Nonnegative integer budgets required');
    this.db.prepare('INSERT OR IGNORE INTO budgets VALUES(?,?,?,?)').run(scope, canonical(limits), canonical({calls:0,candidates:0,operations:0,microUsd:0,wallMs:0}), Date.now()+limits.wallMs);
    const retained = this.budget(scope);
    if (canonical(retained.limits) !== canonical(limits)) throw new Error('Persistent budget cannot be replaced on restart');
  }
  budget(scope = this.incidentId): {limits: Budget; used: Budget; deadline: number} {
    const row = this.db.prepare('SELECT * FROM budgets WHERE scope=?').get(scope)!;
    return { limits: JSON.parse(String(row.limits)), used: JSON.parse(String(row.used)), deadline: Number(row.deadline) };
  }
  private insertEvent(type: string, data: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO events(incident,time,type,data) VALUES(?,?,?,?)').run(this.incidentId, new Date().toISOString(), type, canonical(data));
  }
  append(type: string, data: Record<string, unknown>): void { this.transaction(() => this.insertEvent(type, data)); }
  events(after = 0): JournalEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq').all(after).map(row => ({seq:Number(row.seq),incidentId:String(row.incident),time:String(row.time),type:String(row.type),data:JSON.parse(String(row.data))}));
  }
  private exportEvents(): void {
    // SQLite is authoritative. A crash during export is repaired from committed rows at restart.
    const path = join(this.directory, 'events.jsonl');
    writeFileSync(`${path}.${process.pid}.tmp`, this.events().map(x => JSON.stringify(x)).join('\n')+'\n', {mode:0o600});
    renameSync(`${path}.${process.pid}.tmp`, path);
  }
  put(key: string, value: unknown): void {
    const encoded = canonical(value);
    const previous = this.value(key);
    if (previous !== undefined && canonical(previous) !== encoded) throw new Error(`Frozen value changed: ${key}`);
    this.db.prepare('INSERT OR IGNORE INTO values_store VALUES(?,?)').run(key, encoded);
  }
  value<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM values_store WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  isCancelled(): boolean { return Boolean(this.db.prepare('SELECT cancelled FROM incidents WHERE id=?').get(this.incidentId)?.cancelled); }
  assertActive(allowPendingPhase?: string): void {
    if (this.isCancelled()) throw new Boundary('cancelled');
    for (const scope of new Set(['workflow',this.incidentId])) if (Date.now() >= this.budget(scope).deadline) throw new Boundary('exhausted_budget','Persistent deadline expired');
    const pending = this.db.prepare(`SELECT id FROM effects WHERE json_extract(record,'$.status') IN ('intended','unknown') LIMIT 1`).get();
    if (pending) throw new UnknownEffect(String(pending.id));
    const phase = this.db.prepare(`SELECT id FROM phases WHERE status IN ('running','unknown') AND id != ? LIMIT 1`).get(allowPendingPhase ?? '');
    if (phase) throw new UnknownEffect(String(phase.id));
  }
  reserveBudget(id: string, charge: Partial<Budget>): void {
    this.transaction(() => { this.assertActive(id); this.charge(id, charge); });
  }
  private charge(id: string, charge: Partial<Budget>): void {
    for (const [key,n] of Object.entries(charge)) if (!['calls','candidates','operations','microUsd'].includes(key) || !Number.isSafeInteger(n) || n! < 0) throw new Error('Invalid reservation');
    for (const scope of new Set(['workflow',this.incidentId])) {
      const reservation = `${scope}:${id}`;
      const prior = this.db.prepare('SELECT charge FROM reservations WHERE id=?').get(reservation);
      if (prior) { if (String(prior.charge) !== canonical(charge)) throw new Error('Changed budget reservation'); continue; }
      const state = this.budget(scope);
      for (const [key,n] of Object.entries(charge)) {
        const field = key as keyof Budget;
        state.used[field] += n!;
        if (state.used[field] > state.limits[field]) throw new Boundary('exhausted_budget',`${scope} ${field} budget exhausted`);
      }
      this.db.prepare('UPDATE budgets SET used=? WHERE scope=?').run(canonical(state.used),scope);
      this.db.prepare('INSERT INTO reservations VALUES(?,?,?)').run(reservation,scope,canonical(charge));
    }
    this.insertEvent('budget', { ...this.budget(), accounting: 'reserved upper bounds; never reset by restart', workflow: this.budget('workflow') });
  }
  cancel(reason: string): void {
    this.transaction(() => { this.db.prepare('UPDATE incidents SET cancelled=1 WHERE id=?').run(this.incidentId); this.insertEvent('lifecycle',{status:'cancelled',reason}); });
  }
  admitPhase(id: string, frozenIdentity: unknown, charge: Partial<Budget>): {status: string; result?: unknown} {
    return this.transaction(() => {
      const encoded = canonical(frozenIdentity);
      const prior = this.db.prepare('SELECT * FROM phases WHERE id=?').get(id);
      if (prior) {
        if (prior.identity !== encoded || prior.incident !== this.incidentId) throw new Error('Frozen phase identity changed');
        this.assertActive(id);
        return {status:String(prior.status),...(prior.result ? {result:JSON.parse(String(prior.result))} : {})};
      }
      this.assertActive(); this.charge(id,charge);
      this.db.prepare('INSERT INTO phases VALUES(?,?,?,?,NULL)').run(id,this.incidentId,encoded,'running');
      this.insertEvent('phase.started',{phaseId:id,identity:frozenIdentity});
      return {status:'running'};
    });
  }
  finishPhase(id: string, status: 'completed' | 'unknown' | 'failed', result: unknown): void {
    this.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM phases WHERE id=?').get(id);
      if (!prior) throw new Error('Unadmitted phase');
      if (prior.status === 'completed' || prior.status === 'failed') {
        if (prior.status !== status || prior.result !== canonical(result)) throw new Error('Conflicting retained phase');
        return;
      }
      this.db.prepare('UPDATE phases SET status=?,result=? WHERE id=?').run(status,canonical(result),id);
      this.insertEvent('phase.completed',{phaseId:id,status,result});
    });
  }
  candidate(tree: string, details: Record<string,unknown>): void {
    this.transaction(() => {
      this.assertActive();
      if (this.db.prepare('SELECT tree FROM candidates WHERE tree=? AND incident=?').get(tree,this.incidentId)) throw new Boundary('no_eligible_candidate','Repeated candidate tree detected');
      this.charge(`candidate:${tree}`,{candidates:1});
      this.db.prepare('INSERT INTO candidates VALUES(?,?,?)').run(tree,this.incidentId,canonical(details));
      this.insertEvent('candidate.created',{candidateId:tree,...details});
    });
  }
  get(id: string): EffectRecord | undefined {
    const row = this.db.prepare('SELECT record FROM effects WHERE id=?').get(id);
    return row ? JSON.parse(String(row.record)) as EffectRecord : undefined;
  }
  unresolved(target: string): EffectRecord[] {
    return this.db.prepare(`SELECT record FROM effects WHERE target=? AND json_extract(record,'$.status') IN ('intended','unknown')`).all(target).map(x => JSON.parse(String(x.record)) as EffectRecord);
  }
  intend(record: EffectRecord): void {
    this.transaction(() => {
      this.assertActive(record.operationId.split('/')[0]);
      if (!record.invocationId || !record.operationId) throw new Error('Host invocation and operation identity required');
      this.charge(record.operationId,{operations:1});
      this.db.prepare('INSERT INTO effects VALUES(?,?,?,?)').run(record.operationId,this.incidentId,record.target,canonical(record));
      this.insertEvent('effect.intended', {operationId:record.operationId,invocationId:record.invocationId,kind:record.kind,target:record.target,inputHash:record.inputHash});
    });
  }
  settle(id: string, status: EffectRecord['status'], receipt?: Json): void {
    this.transaction(() => {
      const prior = this.get(id); if (!prior) throw new Error('Effect not admitted');
      if (['completed','rejected'].includes(prior.status)) {
        if (prior.status !== status || canonical(prior.receipt ?? null) !== canonical(receipt ?? null)) throw new Error('Conflicting terminal receipt');
        return;
      }
      const record = {...prior,status,...(receipt === undefined ? {} : {receipt})};
      this.db.prepare('UPDATE effects SET record=? WHERE id=?').run(canonical(record),id);
      this.insertEvent('effect.result',{operationId:id,invocationId:prior.invocationId,status,receipt:receipt ?? null});
    });
  }
  acquireTarget(target: string, revision: string): void {
    this.transaction(() => {
      this.assertActive();
      const prior = this.db.prepare('SELECT * FROM targets WHERE target=?').get(target);
      if (prior && (prior.owner !== this.incidentId || prior.revision !== revision)) throw new Boundary('stale_revision_target','Another owner or revision holds target');
      this.db.prepare('INSERT OR IGNORE INTO targets VALUES(?,?,?)').run(target,this.incidentId,revision);
    });
  }
  checkpoint(): {path: string; sha256: string; sequence: number} {
    const seq = this.events().at(-1)?.seq ?? 0;
    const dir = join(this.directory,'checkpoints'); mkdirSync(dir,{recursive:true});
    const path = join(dir,`checkpoint-${seq}.sqlite`);
    if (!existsSync(path)) this.db.prepare('VACUUM INTO ?').run(path);
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    const manifest = {path,sha256:hash,sequence:seq,artifactSet:this.artefacts.put(this.events()),scope:'process state; external effects require reconciliation after runner loss'};
    writeImmutableFile(`${path}.json`,canonical(manifest));
    return {path,sha256:hash,sequence:seq};
  }
  close(): void { this.exportEvents(); this.db.close(); }
}
