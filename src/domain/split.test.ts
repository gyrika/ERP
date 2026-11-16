import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderTotal } from './order.ts';
import { amountLeft, changeGiven, cleanPick, mainTender, paidUnits, pickAmount, picksAllLeft, tenderParts, unitsLeft } from './split.ts';
import type { Order } from './types.ts';

/** Devilled Chicken L + Full cheese (3,100) · 2 × Margherita M (2,900) · Burger + cheese (600) = 6,600. */
const order = (extra: Partial<Order> = {}): Order => ({
  number: 1042, sentAt: 1, lines: [
    { id: 'a', itemId: 'devilled-chicken', qty: 1, size: 'L', adds: ['full-cheese'], outs: [], sent: true, unit: 310000 },
    { id: 'b', itemId: 'margherita', qty: 2, size: 'M', adds: [], outs: [], sent: true, unit: 145000 },
    { id: 'c', itemId: 'chicken-burger', qty: 1, adds: ['cheese-slice'], outs: [], sent: true, unit: 60000 },
  ],
  ...extra,
});

test('a part is worth its items; one unit of a line of two is half the line', () => {
  const o = order();
  assert.equal(orderTotal(o), 660000);
  assert.equal(pickAmount(o, { a: 1 }), 310000);
  assert.equal(pickAmount(o, { b: 1 }), 145000);
  assert.equal(pickAmount(o, { b: 1, c: 1 }), 205000);
});

test('the part that takes every unit left takes exactly what is left', () => {
  const o = order({ parts: [{ tender: 'cash', amount: 310000, tendered: 500000, at: 2, units: { a: 1 } }] });
  assert.equal(amountLeft(o), 350000);
  assert.ok(picksAllLeft(o, { b: 2, c: 1 }));
  assert.equal(pickAmount(o, { b: 2, c: 1 }), 350000);
  assert.ok(!picksAllLeft(o, { b: 1, c: 1 }));
});

test('an order discount is shared in proportion and the parts add up to the cent', () => {
  // 10% off 6,600 = 5,940. Three equal-ish parts that do not divide evenly.
  const o = order({ adjust: { discount: { kind: 'percent', pct: 10 } } });
  const total = orderTotal(o);
  assert.equal(total, 594000);
  const first = pickAmount(o, { a: 1 });
  assert.equal(first, 279000);
  const o2 = { ...o, parts: [{ tender: 'cash' as const, amount: first, tendered: first, at: 2, units: { a: 1 } }] };
  const second = pickAmount(o2, { b: 1 });
  const o3 = { ...o2, parts: [...o2.parts, { tender: 'transfer' as const, amount: second, tendered: second, at: 3, units: { b: 1 } }] };
  const last = pickAmount(o3, { b: 1, c: 1 });
  assert.equal(first + second + last, total);
  for (const x of [first, second, last]) assert.ok(Number.isInteger(x));
});

test('a pick never takes units already paid or more than the line has', () => {
  const o = order({ parts: [{ tender: 'cash', amount: 145000, tendered: 145000, at: 2, units: { b: 1 } }] });
  assert.deepEqual(paidUnits(o), { b: 1 });
  assert.equal(unitsLeft(o, o.lines[1]), 1);
  assert.deepEqual(cleanPick(o, { b: 5, a: 0, x: 3 }), { b: 1 });
});

test('a line shrunk after its part was paid never goes below nothing left', () => {
  const o = order({ parts: [{ tender: 'cash', amount: 290000, tendered: 290000, at: 2, units: { b: 2 } }] });
  const shrunk = { ...o, lines: o.lines.map((l) => (l.id === 'b' ? { ...l, qty: 1 } : l)) };
  assert.equal(unitsLeft(shrunk, shrunk.lines[1]), 0);
});

test('tender helpers read a split payment and an ordinary one alike', () => {
  const whole = { total: 660000, tender: 'cash' as const, tendered: 700000 };
  assert.deepEqual(tenderParts(whole), [{ tender: 'cash', amount: 660000, tendered: 700000 }]);
  assert.equal(changeGiven(whole), 40000);
  const split = { ...whole, tender: 'transfer' as const, tendered: 350000, parts: [
    { tender: 'cash' as const, amount: 310000, tendered: 500000 },
    { tender: 'transfer' as const, amount: 350000, tendered: 350000 },
  ] };
  assert.equal(changeGiven(split), 190000);
  assert.equal(mainTender(split), 'transfer');
});
