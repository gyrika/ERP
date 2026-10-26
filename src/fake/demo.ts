import { emptyOrder } from '../domain/order.ts';
import type { Order } from '../domain/types.ts';
import { addEvents } from '../ui/eventLog.ts';
import { FAKE_SHOP_ID, FAKE_STAFF, FAKE_TABLE_STATES, FAKE_TABLES, fakeOrders } from './data.ts';

/**
 * /?demo only: three fake tables waiting to pay, already in the (demo)
 * kitchen, and a floor of six tables. Storage is namespaced for the demo, so real orders are untouched.
 */
export const demoSnapshot = (now: number): { order: Order; open: Order[]; nextNumber: number } => {
  const open = fakeOrders(now);
  // Fixed ids, so a second call (React StrictMode, a reload) adds nothing. Demo events never sync.
  addEvents(open.map((o) => ({
    type: 'order.sent', id: `demo-sent-${o.number}`, shopId: FAKE_SHOP_ID, actor: FAKE_STAFF[0].actor, orderNumber: o.number,
    at: o.sentAt ?? now, ticketId: `demo-ticket-${o.number}`, lines: o.lines, addOn: false,
  })));
  const owner = FAKE_STAFF.find((s) => s.actor.role === 'owner')!.actor;
  const minute = 60_000;
  const start = now - Math.max(...FAKE_TABLE_STATES.map((t) => t.minutesAgo)) * minute - minute;
  addEvents([
    { type: 'table.layout_set', id: 'demo-layout', shopId: FAKE_SHOP_ID, actor: owner, orderNumber: 0, at: start, tables: FAKE_TABLES },
    ...FAKE_TABLE_STATES.map((t) => ({
      type: 'table.state_set' as const, id: `demo-table-${t.tableId}`, shopId: FAKE_SHOP_ID, actor: FAKE_STAFF[1].actor, orderNumber: 0 as const,
      at: now - t.minutesAgo * minute, tableId: t.tableId, from: 'free' as const, to: t.to,
    })),
  ]);
  const nextNumber = Math.max(...open.map((o) => o.number)) + 1;
  return { order: emptyOrder(nextNumber), open, nextNumber };
};
