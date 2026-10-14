import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OrderEvent } from './events.ts';
import { lkDate, lkTime, orderLinesFrom, saleFrom } from './salesLedger.ts';
import type { OrderLine } from './types.ts';

const actor = { id: 'n', name: 'Nimal', role: 'cashier' as const };
const manager = { id: 'm', name: 'Ravi', role: 'manager' as const };
const base = (id: string, at = 1000) => ({ id, shopId: 's', at, actor, orderNumber: 1001 });
const audited = { totalBefore: 0, totalAfter: 0 };
const pizza: OrderLine = { id: 'l1', itemId: 'devilled-chicken', qty: 2, size: 'L', adds: ['chicken'], outs: ['no-onion'], sent: true, unit: 290000 };
const burger: OrderLine = { id: 'l2', itemId: 'chicken-burger', qty: 1, adds: [], outs: [], sent: true, unit: 95000 };
const sent = (id: string, ticketId: string, lines: OrderLine[]): OrderEvent =>
  ({ ...base(id), type: 'order.sent', ticketId, lines, addOn: false });

test('Sri Lanka date and time, UTC+05:30', () => {
  const at = Date.UTC(2026, 9, 14, 19, 0); // 19:00 UTC is 00:30 the next day in Thalwila
  assert.equal(lkDate(at), '2026-10-15');
  assert.equal(lkTime(at), '00:30');
});

test('the lines an order holds: sends, an undone send, a change, a cancel and its Undo', () => {
  const changed = { ...burger, qty: 2 };
  const { lines } = orderLinesFrom([
    sent('e1', 't1', [pizza]),
    sent('e2', 't2', [burger]),
    { ...base('e3'), type: 'order.send_undone', ticketId: 't2' },
    sent('e4', 't3', [burger]),
    { ...base('e5'), ...audited, actor: manager, type: 'order.item_changed', lineId: 'l2', before: burger, after: changed, reason: 'two' },
    { ...base('e6'), ...audited, actor: manager, type: 'order.item_cancelled', lineId: 'l1', index: 0, before: pizza, reason: 'wrong' },
    { ...base('e7'), ...audited, actor: manager, type: 'order.change_undone', undoneEventId: 'e6', undoneType: 'order.item_cancelled' },
  ]);
  assert.deepEqual(lines, [pizza, changed]);
});

test('a sale: one row per payment, its items named, the discount is what the total left out', () => {
  const events = [sent('e1', 't1', [pizza, burger])];
  const paid = { ...base('p1', Date.UTC(2026, 9, 14, 14, 5)), type: 'order.paid' as const, total: 600000, tender: 'cash' as const, tendered: 700000 };
  const sale = saleFrom(paid, events);
  assert.deepEqual({ ...sale, items: undefined }, {
    id: 'p1', orderNumber: 1001, saleDate: '2026-10-14', saleTime: '19:35', paidAt: paid.at,
    itemsCount: 3, subtotal: 675000, discount: 75000, total: 600000,
    tender: 'cash', tendered: 700000, changeGiven: 100000, cashier: 'Nimal', online: false, items: undefined,
  });
  assert.deepEqual(sale.items[0], {
    lineNo: 1, itemId: 'devilled-chicken', itemName: 'Devilled Chicken', size: 'Large', qty: 2,
    unitPrice: 290000, lineTotal: 580000, extras: 'Chicken', leftOut: 'No onion',
  });
  assert.equal(sale.items[1].itemName, 'Chicken Burger');
  assert.equal(sale.items.reduce((s, i) => s + i.lineTotal, 0) - sale.discount, sale.total, 'items less discount = total, to the cent');
});

test('an online order is marked; a transfer gives no change', () => {
  const online: OrderEvent = { ...base('e1'), type: 'order.sent', ticketId: 't1', lines: [burger], addOn: false, online: { pickupBy: 2000 } };
  const sale = saleFrom({ ...base('p1'), type: 'order.paid', total: 95000, tender: 'transfer', tendered: 95000 }, [online]);
  assert.equal(sale.online, true);
  assert.equal(sale.changeGiven, 0);
});
