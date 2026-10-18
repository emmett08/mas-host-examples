/** Protected verifier authority. Never include this directory in the candidate snapshot or Git projection. */
import { randomBytes } from 'node:crypto';
import type { HTTPCheck } from '../sandbox/executor.js';
import { sha256 } from '../tools/projection.js';
export const developmentChecks: HTTPCheck[] = [
  { id: 'liveness', method: 'GET', path: '/livez', status: 200, json: { status: 'alive' } },
  { id: 'catalogue', method: 'GET', path: '/catalogue', status: 200, json: { currency: 'GBP', version: 1 } },
  { id: 'standard-below', method: 'POST', path: '/quote', body: { quantity: 1, unitPricePence: 4999, delivery: 'standard' }, status: 200, json: { subtotalPence: 4999, shippingPence: 395, totalPence: 5394 } },
  { id: 'standard-boundary', method: 'POST', path: '/quote', body: { quantity: 2, unitPricePence: 2500, delivery: 'standard' }, status: 200, json: { subtotalPence: 5000, shippingPence: 0, totalPence: 5000 } },
  { id: 'express', method: 'POST', path: '/quote', body: { quantity: 2, unitPricePence: 3000, delivery: 'express' }, status: 200, json: { subtotalPence: 6000, shippingPence: 795, totalPence: 6795 } },
  { id: 'invalid-quantity', method: 'POST', path: '/quote', body: { quantity: 0, unitPricePence: 2500, delivery: 'standard' }, status: 400 },
  { id: 'invalid-price', method: 'POST', path: '/quote', body: { quantity: 1, unitPricePence: 100001, delivery: 'standard' }, status: 400 },
  { id: 'oversized-body', method: 'POST', path: '/quote', body: { quantity: 1, unitPricePence: 100, delivery: 'standard', padding: 'x'.repeat(4097) }, status: 413 },
  { id: 'invalid-delivery', method: 'POST', path: '/quote', body: { quantity: 1, unitPricePence: 2500, delivery: 'instant' }, status: 400 },
  { id: 'unknown-route', method: 'GET', path: '/does-not-exist', status: 404 },
  { id: 'unsupported-method', method: 'POST', path: '/livez', status: 404 },
];
export type Exposure = { suite: string; kind: 'development' | 'final'; exposedToRepair: boolean; candidateTrees: string[] };
export function expose(exposure: Exposure): Exposure { return { ...exposure, kind: 'development', exposedToRepair: true }; }
/** Seed retained by the evaluator only; fresh checks are generated for each untouched final assessment. */
export function finalChecks(seed = randomBytes(24).toString('hex')) {
  if (!/^[0-9a-f]{48}$/.test(seed)) throw new Error('Final suite requires an evaluator seed');
  const bytes = Buffer.from(seed, 'hex'), checks: HTTPCheck[] = [];
  for (let i = 0; i < 8; i++) {
    const quantity = 1 + bytes[i]! % 9, unitPricePence = 100 + ((bytes[i + 8]! << 8) + bytes[i + 16]!) % 3000;
    const delivery = i % 2 ? 'express' : 'standard', subtotalPence = quantity * unitPricePence;
    const shippingPence = delivery === 'express' ? 795 : subtotalPence >= 5000 ? 0 : 395;
    checks.push({ id: `final-quote-${i}`, method: 'POST', path: '/quote', body: { quantity, unitPricePence, delivery }, status: 200, json: { subtotalPence, shippingPence, totalPence: subtotalPence + shippingPence } });
  }
  checks.push({ id: 'final-negative-route', method: 'GET', path: '/unregistered-' + seed.slice(0,12), status: 404 });
  checks.push({ id: 'final-fraction', method: 'POST', path: '/quote', body: { quantity: 1.5, unitPricePence: 200, delivery: 'standard' }, status: 400 });
  checks.push({ id: 'final-upper-bound', method: 'POST', path: '/quote', body: { quantity: 101, unitPricePence: 200, delivery: 'standard' }, status: 400 });
  return { checks, seed, digest: sha256(JSON.stringify(checks)), exposure: { suite: sha256(JSON.stringify(checks)), kind: 'final' as const, exposedToRepair: false, candidateTrees: [] } };
}
