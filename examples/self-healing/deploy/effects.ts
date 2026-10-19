import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Only JSON values may be retained');
  return result;
}
export const sha256 = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export interface OperationIdentity { operationId: string; invocationId: string; attemptId: string }
export interface EffectRecord extends OperationIdentity {
  kind: string; target: string; inputHash: string; input: Json;
  status: 'intended' | 'unknown' | 'completed' | 'rejected'; receipt?: Json;
}
export interface EffectStore {
  get(operationId: string): EffectRecord | undefined;
  unresolved(target: string): EffectRecord[];
  intend(record: EffectRecord): void;
  settle(operationId: string, status: EffectRecord['status'], receipt?: Json): void;
}
export class UnknownEffect extends Error { constructor(public operationId: string) { super(`Unknown effect ${operationId}: reconcile external evidence before further mutation`); } }
export class RejectedEffect extends Error {}
export type Reconciliation = { status: 'completed'; receipt: Json } | { status: 'rejected'; receipt: Json } | { status: 'unknown' };
/** A missing object does not prove a timed-out request will never finish. No blind retry. */
export async function effect(store: EffectStore, identity: OperationIdentity, kind: string, target: string,
  input: Json, dispatch: () => Promise<Json>, reconcile: (record: EffectRecord) => Promise<Reconciliation>): Promise<Json> {
  for (const value of Object.values(identity)) if (!value || value.length > 200) throw new Error('Bounded operation, invocation and process attempt identities required');
  const inputHash = sha256(input);
  const previous = store.get(identity.operationId);
  if (previous) {
    if (previous.inputHash !== inputHash || previous.target !== target || previous.kind !== kind || previous.invocationId !== identity.invocationId)
      throw new Error('Operation identity reused for a different effect or host invocation');
    if (previous.status === 'completed') return previous.receipt!;
    if (previous.status === 'rejected') throw new RejectedEffect(`Previously rejected ${identity.operationId}`);
    const observed = await reconcile(previous);
    if (observed.status === 'unknown') throw new UnknownEffect(identity.operationId);
    store.settle(identity.operationId, observed.status, observed.receipt);
    if (observed.status === 'rejected') throw new RejectedEffect(`Reconciled rejected ${identity.operationId}`);
    return observed.receipt;
  }
  if (store.unresolved(target).length) throw new UnknownEffect(store.unresolved(target)[0]!.operationId);
  store.intend({ ...identity, kind, target, inputHash, input, status: 'intended' });
  try {
    const receipt = await dispatch();
    store.settle(identity.operationId, 'completed', receipt);
    return receipt;
  } catch (error) {
    if (error instanceof RejectedEffect) {
      store.settle(identity.operationId, 'rejected', { reason: error.message });
      throw error;
    }
    store.settle(identity.operationId, 'unknown');
    throw new UnknownEffect(identity.operationId);
  }
}
