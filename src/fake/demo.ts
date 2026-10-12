import { fire } from '../domain/kitchen.ts';
import { emptyOrder } from '../domain/order.ts';
import type { Order } from '../domain/types.ts';
import { updateTickets } from '../ui/kitchenStore.ts';
import { FAKE_SHOP_ID, fakeOrders } from './data.ts';

/**
 * /?demo only: three fake tables waiting to pay, already in the (demo)
 * kitchen. Storage is namespaced for the demo, so real orders are untouched.
 */
export const demoSnapshot = (now: number): { order: Order; open: Order[]; nextNumber: number } => {
  const open = fakeOrders(now);
  // Idempotent: tickets are keyed by id, so a second call (React StrictMode) changes nothing.
  updateTickets((t) => open.reduce((acc, o) => fire(acc, {
    id: `demo-ticket-${o.number}`, shopId: FAKE_SHOP_ID, number: o.number, lines: o.lines, firedAt: o.sentAt ?? now,
  }), t));
  const nextNumber = Math.max(...open.map((o) => o.number)) + 1;
  return { order: emptyOrder(nextNumber), open, nextNumber };
};
