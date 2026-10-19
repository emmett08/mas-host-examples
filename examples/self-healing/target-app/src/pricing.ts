export interface Quote { subtotalPence: number; shippingPence: number; totalPence: number }
/** Standard UK delivery is £3.95 below £50; express delivery is always £7.95. */
export function quote(quantity: number, unitPricePence: number, delivery: string): Quote {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100 ||
      !Number.isSafeInteger(unitPricePence) || unitPricePence < 1 || unitPricePence > 100000 ||
      !['standard', 'express'].includes(delivery)) throw new Error('invalid quote input');
  const subtotalPence = quantity * unitPricePence;
  const shippingPence = delivery === 'express' ? 795 : subtotalPence >= 5000 ? 0 : 395;
  return { subtotalPence, shippingPence, totalPence: subtotalPence + shippingPence };
}
