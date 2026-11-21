import type { OrderCustomer } from '../domain/types.ts';

/**
 * "Start an order" on a customer's page (docs/crm-redesign.md): the Register opens with them on a
 * new bill. The bill on screen, if it has anything on it, is held as NEW BILL does (with Undo).
 * Held in memory only: a reload forgets it, and the Register opens as it was.
 */
let pending: OrderCustomer | null = null;

export const startOrderFor = (customer: OrderCustomer): void => { pending = customer; };

/** The customer to put on a new bill, once; null when none is waiting. */
export const takeOrderFor = (): OrderCustomer | null => {
  const c = pending;
  pending = null;
  return c;
};
