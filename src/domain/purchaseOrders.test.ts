import test from 'node:test';
import assert from 'node:assert/strict';
import type { Actor } from './auth.ts';
import type { SyncEvent } from './sync.ts';
import { compareDelivery, grnNumber, mergeLines, onOrder, planOrder, poNumber, purchasesFromEvents } from './purchaseOrders.ts';

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
    { ...base, id: 'c', at: 1, type: 'stock.order_cancelled', orderId: 'po-2', reason: 'Ordered by mistake' },
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

test('delivery time is the average of the last first deliveries; a second GRN of the same order does not count', () => {
  const s = purchasesFromEvents([
    po('a', 0), grn('g1', 'a', 2 * DAY), grn('g1b', 'a', 9 * DAY), // the later partial delivery must not change it
    po('b', 10 * DAY), grn('g2', 'b', 13.5 * DAY),
    po('c', 0, 'sup_b'), grn('g3', 'c', DAY / 4, 'sup_b'),
  ]);
  assert.equal(s.leadDays.get('sup_a'), 2.75); // (2 + 3.5) / 2
  assert.equal(s.leadDays.get('sup_b'), 0.25);
  assert.equal(s.leadDays.has('sup_c'), false, 'no history: the settings default applies');
  assert.equal(s.lastSupplier.get('flour'), 'sup_a');
});

test('only the last few deliveries count (the setting), and an undone GRN teaches nothing', () => {
  const evs: SyncEvent[] = [];
  for (let i = 0; i < 7; i++) evs.push(po(`p${i}`, i * 20 * DAY), grn(`g${i}`, `p${i}`, i * 20 * DAY + (i < 2 ? 10 : 1) * DAY));
  assert.equal(purchasesFromEvents(evs).leadDays.get('sup_a'), 1, 'the last 5 were 1 day each');
  assert.equal(purchasesFromEvents(evs, { leadSamples: 7 }).leadDays.get('sup_a'), (10 + 10 + 5) / 7);
  const undone = purchasesFromEvents([po('a', 0), grn('g1', 'a', 5 * DAY), { ...base, id: 'u', at: 6 * DAY, type: 'stock.grn_undone', grnId: 'g1' }]);
  assert.equal(undone.leadDays.size, 0);
});

test('compare: as ordered, short or over; any difference needs approval', () => {
  assert.deepEqual(compareDelivery([{ itemId: 'x', ordered: 2, received: 2 }]), { lines: [{ itemId: 'x', ordered: 2, received: 2, diff: 0, match: 'ok' }], needsApproval: false });
  const r = compareDelivery([{ itemId: 'x', ordered: 2, received: 1.5 }, { itemId: 'y', ordered: 1, received: 3 }]);
  assert.deepEqual(r.lines.map((l) => [l.match, l.diff]), [['short', -0.5], ['over', 2]]);
  assert.equal(r.needsApproval, true);
});

// ----- statuses, edits, cancel, and "Add to PO" -----

const grnOf = (id: string, orderId: string, at: number, received: number, ordered = 2, shortDecision?: 'wait' | 'close'): SyncEvent =>
  ({ ...base, id, at, type: 'stock.grn', grnNo: id, orderId, supplierId: 'sup_a', lines: [{ itemId: 'flour', ordered, received }], approvedBy: null, shortDecision });
const statusOf = (events: SyncEvent[], id = 'po-1') => purchasesFromEvents(events).orders.find((o) => o.id === id)!;

test('status: Open, then Partly received while the rest is awaited, then Closed; or closed short', () => {
  assert.equal(statusOf([po('po-1', 0)]).status, 'open');
  const partly = statusOf([po('po-1', 0), grnOf('g1', 'po-1', 1, 1, 2, 'wait')]);
  assert.equal(partly.status, 'partly');
  assert.deepEqual(partly.lines, [{ itemId: 'flour', packs: 2, stockQty: null, received: 1, remaining: 1 }]);
  const done = statusOf([po('po-1', 0), grnOf('g1', 'po-1', 1, 1, 2, 'wait'), grnOf('g2', 'po-1', 2, 1, 1, 'wait')]);
  assert.equal(done.status, 'closed');
  assert.equal(done.lines[0].remaining, 0);
  assert.equal(statusOf([po('po-1', 0), grnOf('g1', 'po-1', 1, 1, 2, 'close')]).status, 'closed', 'closed short: the missing packs are dropped');
  assert.equal(statusOf([po('po-1', 0), grnOf('g1', 'po-1', 1, 2)]).status, 'closed', 'a full delivery closes it');
});

test('undoing a GRN puts the order back to its previous status and amounts', () => {
  const events = [po('po-1', 0), grnOf('g1', 'po-1', 1, 1, 2, 'wait'), grnOf('g2', 'po-1', 2, 1, 1, 'wait')];
  assert.equal(statusOf(events).status, 'closed');
  const back = statusOf([...events, { ...base, id: 'u', at: 3, type: 'stock.grn_undone', grnId: 'g2' }]);
  assert.equal(back.status, 'partly');
  assert.equal(back.lines[0].remaining, 1);
  assert.equal(statusOf([...events, { ...base, id: 'u1', at: 3, type: 'stock.grn_undone', grnId: 'g2' }, { ...base, id: 'u2', at: 4, type: 'stock.grn_undone', grnId: 'g1' }]).status, 'open');
});

test('only what is still owed counts as on order', () => {
  const s = purchasesFromEvents([po('po-1', 0, 'sup_a', 4), grnOf('g1', 'po-1', 1, 1, 4, 'wait')]);
  assert.equal(onOrder(s.open).get('flour'), 3);
});

test('an order can be edited or cancelled (with a reason) only while no GRN stands against it', () => {
  const edit = (id: string, at: number, packs: number): SyncEvent => ({ ...base, id, at, type: 'stock.order_edited', orderId: 'po-1', lines: [{ itemId: 'flour', packs }] });
  const cancel: SyncEvent = { ...base, id: 'c', at: 9, type: 'stock.order_cancelled', orderId: 'po-1', reason: "Supplier can't deliver" };
  assert.equal(statusOf([po('po-1', 0), edit('e1', 1, 5)]).lines[0].packs, 5);
  assert.equal(statusOf([po('po-1', 0), edit('e1', 1, 5)]).editable, true);

  const cancelled = statusOf([po('po-1', 0), cancel]);
  assert.deepEqual([cancelled.status, cancelled.cancelReason, cancelled.editable], ['cancelled', "Supplier can't deliver", false]);
  assert.equal(purchasesFromEvents([po('po-1', 0), cancel]).open.length, 0);
  assert.equal(statusOf([po('po-1', 0), cancel, { ...base, id: 'r', at: 10, type: 'stock.order_reopened', orderId: 'po-1' }]).status, 'open', 'Undo reopens it');

  const received = [po('po-1', 0), grnOf('g1', 'po-1', 1, 1, 2, 'wait')];
  const after = statusOf([...received, edit('e2', 2, 9), { ...cancel, at: 3 }]);
  assert.equal(after.lines[0].packs, 2, 'an edit after goods came is ignored');
  assert.equal(after.status, 'partly', 'so is a cancel');
  assert.equal(after.editable, false);
  // Undone GRN: it can be changed again.
  assert.equal(statusOf([...received, { ...base, id: 'u', at: 2, type: 'stock.grn_undone', grnId: 'g1' }, edit('e3', 3, 7)]).lines[0].packs, 7);
});

test('lines of the same item add up when merged; empty lines go', () => {
  assert.deepEqual(mergeLines([{ itemId: 'a', packs: 1, stockQty: 2000 }, { itemId: 'a', packs: 2, stockQty: 4000 }, { itemId: 'b', packs: 0 }]), [{ itemId: 'a', packs: 3, stockQty: 6000 }]);
  assert.deepEqual(mergeLines([{ itemId: 'a', packs: 1 }, { itemId: 'a', packs: 1, stockQty: 5 }]), [{ itemId: 'a', packs: 2 }]);
});

test('Place order: an item already on an open order of this supplier is added to it; a partly received one blocks; the rest is new', () => {
  const s = purchasesFromEvents([
    po('po-1', 0, 'sup_a'),
    { ...base, id: 'po-2', at: 1, type: 'stock.ordered', poNo: 'PO-2', supplierId: 'sup_a', lines: [{ itemId: 'eggs', packs: 2 }] },
    grnOf('g1', 'po-2', 2, 1, 2, 'wait'),
  ]);
  const plan = planOrder(s.open, 'sup_a', [{ itemId: 'flour', packs: 1 }, { itemId: 'eggs', packs: 1 }, { itemId: 'salt', packs: 3 }, { itemId: 'oil', packs: 0 }]);
  assert.deepEqual(plan.add.map((a) => [a.order.id, a.lines]), [['po-1', [{ itemId: 'flour', packs: 1 }]]]);
  assert.deepEqual(plan.blocked, [{ itemId: 'eggs', poNo: 'PO-2' }]);
  assert.deepEqual(plan.create, [{ itemId: 'salt', packs: 3 }]);
  assert.deepEqual([...plan.onOrder], [['flour', 'PO-1'], ['eggs', 'PO-2']]);
  assert.deepEqual(planOrder(s.open, 'sup_b', [{ itemId: 'flour', packs: 1 }]).create, [{ itemId: 'flour', packs: 1 }], 'another supplier: a new order');
});
