import test from 'node:test';
import assert from 'node:assert/strict';
import type { Actor } from './auth.ts';
import type { SyncEvent } from './sync.ts';
import { compareDelivery, grnNumber, onOrder, poNumber, purchasesFromEvents } from './purchaseOrders.ts';

const actor: Actor = { id: 'm1', name: 'Ravi', role: 'manager' };
const DAY = 86_400_000;
const base = { shopId: 's', orderNumber: 0 as const, actor };
const po = (id: string, at: number, supplierId = 'sup_a', packs = 2): SyncEvent =>
  ({ ...base, id, at, type: 'stock.ordered', poNo: id.toUpperCase(), supplierId, lines: [{ itemId: 'flour', packs }] });
const grn = (id: string, orderId: string, at: number, supplierId = 'sup_a'): SyncEvent =>
  ({ ...base, id, at, type: 'stock.grn', grnNo: id, orderId, supplierId, lines: [{ itemId: 'flour', ordered: 2, received: 2 }], approvedBy: null });

test('numbers count up from 0001', () => {
  assert.equal(poNumber(1), 'PO-0001');
  assert.equal(grnNumber(12), 'GRN-0012');
});

test('an order is open until a GRN receives it or it is cancelled; undo and reopen bring it back', () => {
  const events: SyncEvent[] = [
    po('po-1', 0), po('po-2', 0), po('po-3', 0),
    grn('g1', 'po-1', DAY),
    { ...base, id: 'c', at: 1, type: 'stock.order_cancelled', orderId: 'po-2' },
  ];
  let s = purchasesFromEvents(events);
  assert.deepEqual(s.open.map((o) => o.id), ['po-3']);
  assert.deepEqual([s.poCount, s.grnCount], [3, 1]);

  s = purchasesFromEvents([...events,
    { ...base, id: 'u', at: 2, type: 'stock.grn_undone', grnId: 'g1' },
    { ...base, id: 'r', at: 3, type: 'stock.order_reopened', orderId: 'po-2' }]);
  assert.deepEqual(s.open.map((o) => o.id), ['po-1', 'po-2', 'po-3']);
  assert.equal(onOrder(s.open).get('flour'), 6);
});

test('delivery days are learned per supplier (rounded up, at least one); the last supplier per item', () => {
  const s = purchasesFromEvents([po('a', 0), grn('g1', 'a', 2 * DAY), po('b', 10 * DAY), grn('g2', 'b', 13.5 * DAY), po('c', 0, 'sup_b'), grn('g3', 'c', DAY / 4, 'sup_b')]);
  assert.equal(s.leadDays.get('sup_a'), 3); // (2 + 3.5) / 2 = 2.75
  assert.equal(s.leadDays.get('sup_b'), 1);
  assert.equal(s.lastSupplier.get('flour'), 'sup_a');
});

test('compare: as ordered, short or over; any difference needs approval', () => {
  assert.deepEqual(compareDelivery([{ itemId: 'x', ordered: 2, received: 2 }]), { lines: [{ itemId: 'x', ordered: 2, received: 2, diff: 0, match: 'ok' }], needsApproval: false });
  const r = compareDelivery([{ itemId: 'x', ordered: 2, received: 1.5 }, { itemId: 'y', ordered: 1, received: 3 }]);
  assert.deepEqual(r.lines.map((l) => [l.match, l.diff]), [['short', -0.5], ['over', 2]]);
  assert.equal(r.needsApproval, true);
});
