import { emptyOrder } from '../domain/order.ts';
import type { Order } from '../domain/types.ts';
import { addEvents } from '../ui/eventLog.ts';
import { FAKE_SHOP_ID, FAKE_STAFF, fakeOrders } from './data.ts';

/**
 * /?demo only: three fake tables waiting to pay, already in the (demo)
 * kitchen. Storage is namespaced for the demo, so real orders are untouched.
 */
export const demoSnapshot = (now: number): { order: Order; open: Order[]; nextNumber: number } => {
  const open = fakeOrders(now);
  // Fixed ids, so a second call (React StrictMode, a reload) adds nothing. Demo events never sync.
  addEvents(open.map((o) => ({
    type: 'order.sent', id: `demo-sent-${o.number}`, shopId: FAKE_SHOP_ID, actor: FAKE_STAFF[0].actor, orderNumber: o.number,
    at: o.sentAt ?? now, ticketId: `demo-ticket-${o.number}`, lines: o.lines, addOn: false,
  })));
  const nextNumber = Math.max(...open.map((o) => o.number)) + 1;
  return { order: emptyOrder(nextNumber), open, nextNumber };
};
