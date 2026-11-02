import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Actor } from './auth.ts';
import {
  checkMoneyOut, defaultMonth, drawerOutToday, mayPayOut, moneyMonth, moneyOutFromEvents, monthLabel, monthOf, shiftMonth, type MoneyEvent,
} from './moneyOut.ts';

const cashier: Actor = { id: 'c1', name: 'Cashier One', role: 'cashier' };
const other: Actor = { id: 'c2', name: 'Cashier Two', role: 'cashier' };
const owner: Actor = { id: 'o1', name: 'Owner', role: 'owner' };
const at = new Date(2026, 10, 2, 12).getTime();

const out = (id: string, fields: Partial<Extract<MoneyEvent, { type: 'money.out' }>> = {}): MoneyEvent => ({
  id, shopId: 's', at, orderNumber: 0, actor: cashier, type: 'money.out', what: 'gas', from: 'drawer', cents: 250000, ...fields,
});
const undo = (outId: string, actor: Actor): MoneyEvent => ({ id: `u-${outId}-${actor.id}`, shopId: 's', at, orderNumber: 0, actor, type: 'money.out_undone', outId });
const restore = (outId: string, actor: Actor): MoneyEvent => ({ id: `r-${outId}`, shopId: 's', at, orderNumber: 0, actor, type: 'money.out_restored', outId });

test('a cashier records drawer cash only, and never rent or wages', () => {
  assert.equal(mayPayOut('cashier', 'gas', 'drawer'), true);
  assert.equal(mayPayOut('cashier', 'supplier', 'drawer'), true);
  assert.equal(mayPayOut('cashier', 'gas', 'bank'), false);
  assert.equal(mayPayOut('cashier', 'rent', 'drawer'), false);
  assert.equal(mayPayOut('cashier', 'wages', 'drawer'), false);
  assert.equal(mayPayOut('kitchen', 'gas', 'drawer'), false);
  assert.equal(mayPayOut('vision', 'gas', 'drawer'), false);
  assert.equal(mayPayOut('manager', 'rent', 'bank'), true);
  assert.equal(mayPayOut('owner', 'wages', 'bank'), true);
});

test('the amount is whole cents above nothing, and each kind says what it needs', () => {
  const good = { what: 'gas', from: 'drawer', cents: 100 };
  assert.equal(checkMoneyOut(good), null);
  assert.ok(checkMoneyOut({ ...good, cents: 0 }));
  assert.ok(checkMoneyOut({ ...good, cents: -5 }));
  assert.ok(checkMoneyOut({ ...good, cents: 10.5 }));
  assert.ok(checkMoneyOut({ ...good, cents: 10_000_000_01 }));
  assert.ok(checkMoneyOut({ ...good, what: 'lunch' }));
  assert.ok(checkMoneyOut({ ...good, from: 'pocket' }));
  assert.ok(checkMoneyOut({ ...good, what: 'other' }));
  assert.ok(checkMoneyOut({ ...good, what: 'other', note: '   ' }));
  assert.equal(checkMoneyOut({ ...good, what: 'other', note: 'Bulbs' }), null);
  assert.ok(checkMoneyOut({ ...good, what: 'supplier' }));
  assert.equal(checkMoneyOut({ ...good, what: 'supplier', supplierId: 'sup-1' }), null);
  assert.ok(checkMoneyOut({ ...good, supplierId: 'sup-1' }));
});

test('only a monthly bill names a month, and it must be a real one', () => {
  assert.equal(checkMoneyOut({ what: 'electricity', from: 'bank', cents: 100, month: '2026-10' }), null);
  assert.ok(checkMoneyOut({ what: 'electricity', from: 'bank', cents: 100, month: '2026-13' }));
  assert.ok(checkMoneyOut({ what: 'gas', from: 'bank', cents: 100, month: '2026-10' }));
});

test('months move across a year, and a meter bill defaults to the month before', () => {
  assert.equal(monthOf(at), '2026-11');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(monthLabel('2026-10'), 'October 2026');
  assert.equal(defaultMonth('electricity', at), '2026-10');
  assert.equal(defaultMonth('water', at), '2026-10');
  assert.equal(defaultMonth('rent', at), '2026-11');
});

test('a bill paid in November for October counts in October', () => {
  const all = moneyOutFromEvents([out('a', { what: 'electricity', from: 'bank', cents: 900000, month: '2026-10' }), out('b')]);
  assert.equal(moneyMonth(all, '2026-10').costs, 900000);
  assert.equal(moneyMonth(all, '2026-11').costs, 250000);
});

test('supplier payments leave the drawer but are not a running cost', () => {
  const all = moneyOutFromEvents([out('gas'), out('sup', { what: 'supplier', supplierId: 's1', note: 'Veg shop', cents: 700000 })]);
  const month = moneyMonth(all, '2026-11');
  assert.equal(month.costs, 250000);
  assert.equal(month.suppliers, 700000);
  assert.deepEqual(month.byWhat, [{ what: 'gas', cents: 250000 }]);
  assert.equal(month.entries.length, 2);
  assert.equal(drawerOutToday(all, at), 950000);
});

test('the drawer counts only today and only the drawer', () => {
  const yesterday = at - 24 * 60 * 60_000;
  const all = moneyOutFromEvents([out('old', { at: yesterday }), out('bank', { from: 'bank' }), out('now', { cents: 100 })]);
  assert.equal(drawerOutToday(all, at), 100);
});

test('costs add up by kind, biggest first, newest entry first', () => {
  const all = moneyOutFromEvents([out('a', { cents: 100 }), out('b', { what: 'other', note: 'Bulbs', cents: 900, at: at + 1 }), out('c', { cents: 300, at: at + 2 })]);
  const month = moneyMonth(all, '2026-11');
  assert.deepEqual(month.byWhat, [{ what: 'other', cents: 900 }, { what: 'gas', cents: 400 }]);
  assert.equal(month.costs, 1300);
  assert.deepEqual(month.entries.map((e) => e.id), ['c', 'b', 'a']);
});

test('removing takes an entry out, restoring brings it back', () => {
  assert.deepEqual(moneyOutFromEvents([out('a'), undo('a', cashier)]), []);
  assert.equal(moneyOutFromEvents([out('a'), undo('a', owner), restore('a', owner)]).length, 1);
});

test("a cashier cannot remove someone else's entry; a manager or owner can", () => {
  assert.equal(moneyOutFromEvents([out('a', { actor: owner, what: 'rent', from: 'bank' }), undo('a', cashier)]).length, 1);
  assert.equal(moneyOutFromEvents([out('a'), undo('a', other)]).length, 1);
  assert.equal(moneyOutFromEvents([out('a'), undo('a', owner)]).length, 0);
  // Nor bring back what the owner removed.
  assert.equal(moneyOutFromEvents([out('a'), undo('a', owner), restore('a', other)]).length, 0);
});

test('other events are ignored, and a removal of nothing does nothing', () => {
  assert.deepEqual(moneyOutFromEvents([{ type: 'order.paid' }, undo('ghost', owner)]), []);
});
