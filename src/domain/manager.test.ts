import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Actor } from './auth.ts';
import {
  DISCOUNT_CHIPS, applyManagerChange, isRefusal, undoManagerChange, type Applied, type ManagerChange,
} from './manager.ts';
import { discountAmount, percentOf, totals } from './totals.ts';
import type { Order } from './types.ts';

const RAVI: Actor = { id: 'm1', name: 'Ravi', role: 'manager' };
const NIMAL: Actor = { id: 'c1', name: 'Nimal', role: 'cashier' };

/** The design's order: Devilled Chicken L + Full cheese (3,100) · 2 × Margherita M (2,900) · Burger + cheese (600) = 6,600. */
const order = (): Order => ({
  number: 1042, sentAt: 1, lines: [
    { id: 'a', itemId: 'devilled-chicken', qty: 1, size: 'L', adds: ['full-cheese'], outs: [], sent: true },
    { id: 'b', itemId: 'margherita', qty: 2, size: 'M', adds: [], outs: [], sent: true },
    { id: 'c', itemId: 'chicken-burger', qty: 1, adds: ['cheese-slice'], outs: [], sent: true },
  ],
});

const apply = (o: Order, change: ManagerChange, actor = RAVI): Applied => {
  const r = applyManagerChange(o, change, actor, 1000);
  if (isRefusal(r)) throw new Error(`refused: ${r.refused}`);
  return r;
};

test('each discount chip gives the exact cent total', () => {
  assert.equal(totals(order()).total, 660000);
  const expected: Record<string, number> = { '1': 594000, '2': 528000, '3': 330000, '4': 0 };
  for (const chip of DISCOUNT_CHIPS) {
    const { order: o } = apply(order(), { kind: 'discount', discount: chip.discount });
    assert.equal(totals(o).total, expected[chip.key], `chip ${chip.key} (${chip.label})`);
    assert.ok(Number.isInteger(totals(o).total));
  }
});

test('discounts round once, at order level, and are never off by a cent', () => {
  // Reference: exact rational arithmetic in BigInt, round half up.
  const ref = (cents: number, pct: number) => Number((BigInt(cents) * BigInt(pct) * 2n + 100n) / 200n);
  for (const pct of [10, 20, 50]) {
    for (let cents = 0; cents <= 250_000; cents++) {
      const off = percentOf(cents, pct);
      assert.equal(off, ref(cents, pct));
      assert.equal(discountAmount(cents, { kind: 'percent', pct }) + (cents - off), cents);
    }
  }
  // With a line adjustment first, the parts still add back to the subtotal exactly.
  const adjusted = apply(order(), { kind: 'adjustLine', lineId: 'a', cents: 1234 }).order;
  const t = totals(apply(adjusted, { kind: 'discount', discount: { kind: 'percent', pct: 10 } }).order);
  assert.equal(t.total + t.lineAdjust + t.orderDiscount, t.subtotal);
  assert.equal(t.orderDiscount, 65877); // 10% of 658,766 = 65,876.6 -> rounded once to 65,877
  assert.equal(t.total, 592889);
});

test('Free sets the total to 0 and Undo restores it exactly', () => {
  const start = apply(order(), { kind: 'discount', discount: { kind: 'percent', pct: 20 } }).order;
  const free = apply(start, { kind: 'discount', discount: { kind: 'comp' } });
  assert.equal(totals(free.order).total, 0);
  assert.equal(free.event.type, 'order.comped');
  const undone = undoManagerChange(free.order, { inverse: free.inverse, eventId: 'e1', eventType: free.event.type }, RAVI, 2000);
  assert.equal(totals(undone.order).total, 528000);
  assert.deepEqual(undone.order.adjust, start.adjust);
  assert.deepEqual(undone.order.lines, start.lines);
});

test('void then Undo restores the line in its original position', () => {
  const voided = apply(order(), { kind: 'void', lineId: 'b', reason: 'Customer changed mind' });
  assert.deepEqual(voided.order.lines.map((l) => l.id), ['a', 'c']);
  assert.equal(totals(voided.order).total, 370000);
  const undone = undoManagerChange(voided.order, { inverse: voided.inverse, eventId: 'e1', eventType: voided.event.type }, RAVI, 2000);
  assert.deepEqual(undone.order.lines, order().lines);
  assert.equal(totals(undone.order).total, 660000);
});

test('every change creates exactly one audit entry with the manager and before/after', () => {
  const changes: ManagerChange[] = [
    { kind: 'void', lineId: 'c', reason: 'Out of stock' },
    { kind: 'edit', lineId: 'b', after: { itemId: 'margherita', qty: 1, size: 'M', adds: [], outs: [] }, reason: 'Wrong item entered' },
    { kind: 'adjustLine', lineId: 'a', cents: 50000 },
    { kind: 'discount', discount: { kind: 'percent', pct: 10 } },
    { kind: 'discount', discount: { kind: 'comp' } },
  ];
  let o = order();
  for (const change of changes) {
    const r = apply(o, change);
    const e = r.event as Extract<typeof r.event, { totalBefore: number }>;
    assert.equal(e.actor.name, 'Ravi');
    assert.equal(e.at, 1000);
    assert.equal(e.totalBefore, totals(o).total);
    assert.equal(e.totalAfter, totals(r.order).total);
    assert.ok(Number.isInteger(e.totalBefore) && Number.isInteger(e.totalAfter));
    assert.deepEqual(r.order.edited, { by: 'Ravi', at: 1000 });
    o = r.order;
  }
});

test('rules: sent items need a reason, cashiers are refused, menu prices never change', () => {
  assert.deepEqual(applyManagerChange(order(), { kind: 'void', lineId: 'a' }, RAVI, 0), { refused: 'reason-required' });
  assert.deepEqual(applyManagerChange(order(), { kind: 'discount', discount: { kind: 'comp' } }, NIMAL, 0), { refused: 'not-a-manager' });
  const unsent: Order = { number: 1, lines: [{ id: 'x', itemId: 'margherita', qty: 1, size: 'M', adds: [], outs: [] }] };
  assert.equal(apply(unsent, { kind: 'void', lineId: 'x' }).event.type, 'order.line_removed'); // not sent: no reason needed
  const adj = apply(order(), { kind: 'adjustLine', lineId: 'c', cents: 999_999 }); // capped at the line's 600
  assert.equal(totals(adj.order).lineAdjust, 60000);
  assert.deepEqual(adj.order.lines, order().lines); // line prices untouched
});

test('a sent-line void or edit tells the kitchen; discounts do not', () => {
  assert.deepEqual(apply(order(), { kind: 'void', lineId: 'a', reason: 'x' }).kitchen, { lineId: 'a', after: null });
  assert.equal(apply(order(), { kind: 'edit', lineId: 'b', after: { itemId: 'margherita', qty: 3, size: 'M', adds: [], outs: [] }, reason: 'x' }).kitchen?.after?.qty, 3);
  assert.equal(apply(order(), { kind: 'discount', discount: { kind: 'comp' } }).kitchen, undefined);
});
