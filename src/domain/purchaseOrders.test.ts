import test from 'node:test';
import assert from 'node:assert/strict';
import type { Actor } from './auth.ts';
import type { SyncEvent } from './sync.ts';
import { compareDelivery, grnLineCents, grnNumber, grnProblem, grnTotals, grnValueCents, mergeLines, orderTotals, onOrder, planOrder, poNumber, purchasesFromEvents, settleGrn, undoCheck, type PurchaseOrder } from './purchaseOrders.ts';

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

  s = purchasesFromEvents([...events,
    { ...base, id: 'u', at: 2, type: 'stock.grn_undone', grnId: 'g1' },
    { ...base, id: 'r', at: 3, type: 'stock.order_reopened', orderId: 'po-2' }]);
  assert.deepEqual(s.open.map((o) => o.id), ['po-1', 'po-2', 'po-3']);
  assert.equal(onOrder(s.open).get('flour'), 6);
});

test("a supplier's draft: the last one wins, none clears it, a repeat counts once, one per supplier", () => {
  const draft = (id: string, supplierId: string, lines: { itemId: string; packs: number }[]): SyncEvent =>
    ({ ...base, id, at: 0, type: 'stock.draft_set', supplierId, lines });
  const first = draft('d1', 'sup_a', [{ itemId: 'flour', packs: 2 }]);
  let s = purchasesFromEvents([first, draft('d2', 'sup_b', [{ itemId: 'cheese', packs: 1 }]), draft('d3', 'sup_a', [{ itemId: 'flour', packs: 3 }, { itemId: 'oil', packs: 1 }])]);
  assert.deepEqual(Object.fromEntries(s.drafts), { sup_a: { flour: 3, oil: 1 }, sup_b: { cheese: 1 } });
  s = purchasesFromEvents([first, draft('d2', 'sup_a', []), first]);
  assert.equal(s.drafts.has('sup_a'), false);
  assert.deepEqual(s.open, [], 'a draft is not an order');
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
  assert.deepEqual(compareDelivery([{ itemId: 'x', ordered: 2, received: 2 }]), { lines: [{ itemId: 'x', ordered: 2, received: 2, diff: 0, match: 'ok' }], needsApproval: false, hasShort: false, hasOver: false });
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

// ----- GRN rules: decisions, what goes into stock, undo -----

const HOUR = 3_600_000;
const owed = (remaining: number, status: PurchaseOrder['status'] = 'open') =>
  ({ poNo: 'PO-0001', status, lines: [{ itemId: 'flour', packs: remaining, stockQty: null, received: 0, remaining }] });
const manager = { role: 'manager' as const };
const noDecision = { short: null, over: null };
const came = (ordered: number, received: number) => [{ itemId: 'flour', ordered, received }];

test('a full GRN needs no one; a short or over one needs a manager and a decision', () => {
  assert.equal(grnProblem(owed(2), came(2, 2), noDecision, null), null, 'as ordered: no approval');
  assert.match(grnProblem(owed(2), came(2, 1), { short: 'wait', over: null }, null) ?? '', /needs a manager/);
  assert.match(grnProblem(owed(2), came(2, 1), { short: 'wait', over: null }, { role: 'cashier' }) ?? '', /needs a manager/, 'a cashier cannot approve');
  assert.match(grnProblem(owed(2), came(2, 1), noDecision, manager) ?? '', /wait for the rest, or close the order/);
  assert.match(grnProblem(owed(2), came(2, 3), noDecision, manager) ?? '', /accept the extra, or return it/);
  assert.equal(grnProblem(owed(2), came(2, 1), { short: 'wait', over: null }, manager), null);
  assert.equal(grnProblem(owed(2), came(2, 1), { short: 'close', over: null }, { role: 'owner' }), null);
  assert.equal(grnProblem(owed(2), came(2, 3), { short: null, over: 'return' }, manager), null);
});

test('the PO price is captured and a different delivered price needs manager approval', () => {
  const order = {
    ...owed(2),
    lines: [{ itemId: 'flour', packs: 2, stockQty: null, received: 0, remaining: 2, unitPriceCents: 640000 }],
  };
  const delivery = [{ itemId: 'flour', ordered: 2, received: 2, unitPriceCents: 650000 }];
  assert.equal(compareDelivery(delivery, order.lines).needsApproval, true);
  assert.match(grnProblem(order, delivery, noDecision, null) ?? '', /needs a manager/);
  assert.match(grnProblem(order, came(2, 2), noDecision, manager) ?? '', /Enter the delivered price/);
  assert.equal(grnProblem(order, delivery, noDecision, manager), null);
  assert.deepEqual(settleGrn(delivery, null), [{ ...delivery[0], accepted: 2, returned: 0 }]);
  assert.match(grnProblem(order, [{ itemId: 'flour', ordered: 2, received: 2, unitPriceCents: 640000.5 }], noDecision, manager) ?? '', /whole number of cents/);
});

test('a GRN is refused for a closed or cancelled order, an unknown item, a changed order, or a negative amount', () => {
  assert.match(grnProblem(owed(2, 'closed'), came(2, 2), noDecision, null) ?? '', /PO-0001 is closed/);
  assert.match(grnProblem(owed(2, 'cancelled'), came(2, 2), noDecision, null) ?? '', /cancelled/);
  assert.match(grnProblem(owed(2), [{ itemId: 'salt', ordered: 1, received: 1 }], noDecision, null) ?? '', /not on this order/);
  assert.match(grnProblem(owed(2), came(3, 3), noDecision, null) ?? '', /changed since/, 'expected must be what is still owed');
  assert.match(grnProblem(owed(2), came(2, -1), { short: 'close', over: null }, manager) ?? '', /less than zero/);
  assert.match(grnProblem(owed(2), [], noDecision, null) ?? '', /nothing on this GRN/);
});

test('stock in: extra accepted = what came; extra returned = what was owed, the rest recorded as returned; short = what came', () => {
  assert.deepEqual(settleGrn(came(2, 3), 'accept'), [{ itemId: 'flour', ordered: 2, received: 3, accepted: 3, returned: 0 }]);
  assert.deepEqual(settleGrn(came(2, 3), 'return'), [{ itemId: 'flour', ordered: 2, received: 3, accepted: 2, returned: 1 }]);
  assert.deepEqual(settleGrn(came(2, 1), null), [{ itemId: 'flour', ordered: 2, received: 1, accepted: 1, returned: 0 }]);
  assert.deepEqual(settleGrn(came(2, 2), 'return'), [{ itemId: 'flour', ordered: 2, received: 2, accepted: 2, returned: 0 }]);
});

test('a second partial GRN works from what is left, and returned extra does not count as received', () => {
  const g = (id: string, at: number, ordered: number, received: number, accepted: number, d?: 'wait' | 'close'): SyncEvent =>
    ({ ...base, id, at, type: 'stock.grn', grnNo: id, orderId: 'po-1', supplierId: 'sup_a', lines: [{ itemId: 'flour', ordered, received, accepted, returned: received - accepted }], approvedBy: null, shortDecision: d });
  const first = statusOf([po('po-1', 0, 'sup_a', 5), g('g1', 1, 5, 2, 2, 'wait')]);
  assert.equal(first.lines[0].remaining, 3);
  assert.equal(grnProblem(first, came(3, 3), noDecision, null), null, 'the next GRN is for the 3 left');
  const second = statusOf([po('po-1', 0, 'sup_a', 5), g('g1', 1, 5, 2, 2, 'wait'), g('g2', 2, 3, 4, 3)]);
  assert.equal(second.status, 'closed', 'extra returned: only the 3 owed count');
  assert.equal(second.lines[0].received, 5);
});

test('undo: only the latest GRN of an order, only within the hours, once', () => {
  const at = 100 * HOUR;
  const g = (id: string, t: number, orderId = 'po-1'): SyncEvent => ({ ...base, id, at: t, type: 'stock.grn', grnNo: id, orderId, supplierId: 'sup_a', lines: [{ itemId: 'flour', ordered: 1, received: 1, accepted: 1 }], approvedBy: null, shortDecision: 'wait' });
  const state = purchasesFromEvents([po('po-1', 0, 'sup_a', 3), po('po-2', 0, 'sup_a', 3), g('g1', at), g('g2', at + HOUR), g('g3', at, 'po-2')]);
  assert.equal(undoCheck(state, 'g2', at + 2 * HOUR, 24), null);
  assert.match(undoCheck(state, 'g1', at + 2 * HOUR, 24) ?? '', /Only the latest GRN of PO-1 can be undone. Undo g2 first/);
  assert.equal(undoCheck(state, 'g3', at + 2 * HOUR, 24), null, 'the other order has its own latest');
  assert.equal(undoCheck(state, 'g2', at + HOUR + 24 * HOUR, 24), null, 'exactly the limit');
  assert.match(undoCheck(state, 'g2', at + HOUR + 24 * HOUR + 1, 24) ?? '', /older than 24 hours/);
  assert.match(undoCheck(state, 'nope', at, 24) ?? '', /not here/);
  const after = purchasesFromEvents([po('po-1', 0, 'sup_a', 3), g('g1', at), g('g2', at + HOUR), { ...base, id: 'u', at: at + 2 * HOUR, type: 'stock.grn_undone', grnId: 'g2', reason: 'Wrong amounts', approvedBy: base.actor }]);
  assert.match(undoCheck(after, 'g2', at + 3 * HOUR, 24) ?? '', /already undone/);
  assert.equal(undoCheck(after, 'g1', at + 3 * HOUR, 24), null, 'the earlier one is the latest now');
  assert.deepEqual(after.grns.map((x) => [x.id, x.undone?.reason ?? null]), [['g2', 'Wrong amounts'], ['g1', null]], 'the undone GRN stays listed, newest first');
});

test('lead time learns from the first GRN of an order only, and loses it when that GRN is undone', () => {
  const g = (id: string, at: number): SyncEvent => ({ ...base, id, at, type: 'stock.grn', grnNo: id, orderId: 'po-1', supplierId: 'sup_a', lines: [{ itemId: 'flour', ordered: 1, received: 1, accepted: 1 }], approvedBy: null, shortDecision: 'wait' });
  const evs = [po('po-1', 0, 'sup_a', 3), g('g1', 2 * DAY), g('g2', 6 * DAY)];
  assert.equal(purchasesFromEvents(evs).leadDays.get('sup_a'), 2);
  assert.equal(purchasesFromEvents([...evs, { ...base, id: 'u2', at: 7 * DAY, type: 'stock.grn_undone', grnId: 'g2', reason: 'x', approvedBy: base.actor }]).leadDays.get('sup_a'), 2);
  assert.equal(purchasesFromEvents([...evs, { ...base, id: 'u2', at: 7 * DAY, type: 'stock.grn_undone', grnId: 'g2', reason: 'x', approvedBy: base.actor }, { ...base, id: 'u1', at: 8 * DAY, type: 'stock.grn_undone', grnId: 'g1', reason: 'x', approvedBy: base.actor }]).leadDays.has('sup_a'), false);
});

test('a document shows its number from the server, or "pending" until it arrives', () => {
  const numbered: SyncEvent = { ...base, id: 'n1', at: 1, type: 'stock.numbered', docId: 'po-1', kind: 'PO', number: 'PO-0042' };
  const orderEvent = { ...po('po-1', 0), poNo: undefined } as SyncEvent;
  assert.equal(purchasesFromEvents([orderEvent]).orders[0].poNo, 'PO (pending)');
  assert.equal(purchasesFromEvents([orderEvent, numbered]).orders[0].poNo, 'PO-0042');
  assert.equal(purchasesFromEvents([po('po-1', 0)]).orders[0].poNo, 'PO-1', 'an older document keeps the number it was written with');
  const g = { ...grnOf('g1', 'po-1', 1, 2), grnNo: undefined } as SyncEvent;
  const s = purchasesFromEvents([orderEvent, numbered, g]);
  assert.equal(s.grns[0].grnNo, 'GRN (pending)');
  assert.equal(s.grns[0].poNo, 'PO-0042');
  assert.equal(purchasesFromEvents([orderEvent, numbered, g, { ...base, id: 'n2', at: 3, type: 'stock.numbered', docId: 'g1', kind: 'GRN', number: 'GRN-0007' }]).grns[0].grnNo, 'GRN-0007');
});

test('totals: an order draft is items, packs and about what it costs; a delivery is packs expected and received', () => {
  const price = new Map([['flour', 640000], ['eggs', 85050]]);
  assert.deepEqual(orderTotals([{ itemId: 'flour', packs: 2 }, { itemId: 'eggs', packs: 1.5 }, { itemId: 'salt', packs: 0 }], price), { items: 2, packs: 3.5, cents: 1_407_575 });
  assert.deepEqual(orderTotals([], price), { items: 0, packs: 0, cents: 0 });
  assert.deepEqual(orderTotals([{ itemId: 'unknown', packs: 2 }], price), { items: 1, packs: 2, cents: 0 }, 'no price: nothing to add');
  assert.deepEqual(grnTotals([{ itemId: 'a', ordered: 2, received: 1.5 }, { itemId: 'b', ordered: 0.5, received: 1 }]), { expected: 2.5, received: 2.5 });
});

test('sync retry: the same records twice change nothing — stock, orders, status and numbers count once', () => {
  const g: SyncEvent = { ...base, id: 'g1', at: 1, type: 'stock.grn', orderId: 'po-1', supplierId: 'sup_a', lines: [{ itemId: 'flour', ordered: 4, received: 1, accepted: 1 }], approvedBy: base.actor, shortDecision: 'wait' };
  const numbered: SyncEvent = { ...base, id: 'num-po-1', at: 1, type: 'stock.numbered', docId: 'po-1', kind: 'PO', number: 'PO-0001' };
  const once = [po('po-1', 0, 'sup_a', 4), numbered, g];
  const twice = [...once, ...once, po('po-1', 0, 'sup_a', 4), g];
  assert.deepEqual(purchasesFromEvents(twice), purchasesFromEvents(once));
  assert.equal(purchasesFromEvents(twice).orders[0].lines[0].remaining, 3, 'the 1 pack received is counted once, not twice');
  assert.equal(purchasesFromEvents(twice).grns.length, 1);
});

test('a GRN is worth what went into stock at the delivered price, in whole cents; lines with no price add nothing', () => {
  const lines = [
    { itemId: 'flour', ordered: 2, received: 3, accepted: 2, returned: 1, unitPriceCents: 640000 },
    { itemId: 'cheese', ordered: 1.5, received: 1.5, unitPriceCents: 333 },
    { itemId: 'old', ordered: 1, received: 1 },
  ];
  assert.equal(grnLineCents(lines[0]), 1280000, 'the returned pack is not paid for');
  assert.equal(grnLineCents(lines[1]), 500, '1.5 × 333 = 499.5, rounded once');
  assert.equal(grnLineCents(lines[2]), null);
  assert.equal(grnValueCents(lines), 1280500);
});
