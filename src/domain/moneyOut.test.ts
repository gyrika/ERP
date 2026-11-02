import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Actor } from './auth.ts';
import {
  DEFAULT_CHOICES, rentRows, checkChoiceChosen, checkChoices, checkMoneyOut, defaultMonth, drawerOutToday, lastPaidEach, mayPayOut, moneyChoices, moneyMonth,
  moneyOutFromEvents, monthLabel, monthOf, removedGrns, rentsPaid, shiftMonth, type MoneyEvent,
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

const base = { what: 'gas', from: 'drawer', cents: 164700 };

test('gas keeps its size and how many; rent keeps which; both survive the fold', () => {
  const all = moneyOutFromEvents([
    out('g', { choiceId: 'gas-5', note: '5kg', qty: 2, cents: 329400 }),
    out('r', { what: 'rent', from: 'bank', choiceId: 'rent-land', note: 'Land', cents: 2000000, month: '2026-11' }),
  ]);
  assert.deepEqual([all[0].choiceId, all[0].qty, all[0].note], ['gas-5', 2, '5kg']);
  assert.deepEqual([all[1].choiceId, all[1].note], ['rent-land', 'Land']);
});

test('the month shows gas by size and rent by place; older entries with neither still count', () => {
  const all = moneyOutFromEvents([
    out('a', { choiceId: 'gas-5', note: '5kg', qty: 2, cents: 300000 }),
    out('b', { choiceId: 'gas-5', note: '5kg', cents: 150000 }),
    out('c', { choiceId: 'gas-12.5', note: '12.5kg', cents: 400000 }),
    out('old', { cents: 100000 }),
    out('r', { what: 'rent', from: 'bank', choiceId: 'rent-room-1', note: 'Room 1', cents: 1000000 }),
  ]);
  const m = moneyMonth(all, monthOf(at));
  assert.deepEqual(m.parts.gas, [
    { label: '5kg', cents: 450000, qty: 3 }, { label: '12.5kg', cents: 400000, qty: 1 }, { label: 'Not said', cents: 100000, qty: 1 },
  ]);
  assert.deepEqual(m.parts.rent, [{ label: 'Room 1', cents: 1000000, qty: 1 }]);
  assert.equal(m.costs, 1950000);
});

test('the last price is per cylinder, from the newest of that size; never paid is null', () => {
  const all = moneyOutFromEvents([
    out('a', { choiceId: 'gas-5', qty: 1, cents: 150000 }),
    out('b', { choiceId: 'gas-5', qty: 2, cents: 329400 }),
    out('c', { choiceId: 'gas-12.5', cents: 406500 }),
  ]);
  assert.equal(lastPaidEach(all, 'gas-5'), 164700);
  assert.equal(lastPaidEach(all, 'gas-2.5'), null);
});

test('which rents are paid goes by the month it is for, and an undone one is not paid', () => {
  const all = moneyOutFromEvents([
    out('a', { what: 'rent', from: 'bank', choiceId: 'rent-land', month: '2026-10' }),
    out('b', { what: 'rent', from: 'bank', choiceId: 'rent-room-1', month: '2026-11' }),
    out('c', { what: 'rent', from: 'bank', choiceId: 'rent-room-2', month: '2026-11' }),
    undo('c', owner),
  ]);
  assert.deepEqual([...rentsPaid(all, '2026-11')], ['rent-room-1']);
  assert.deepEqual([...rentsPaid(all, '2026-10')], ['rent-land']);
});

test('the new fields belong to their kind only; entries from before them stay valid', () => {
  assert.equal(checkMoneyOut(base), null, 'an older gas entry with no size');
  assert.equal(checkMoneyOut({ ...base, choiceId: 'gas-5', qty: 2 }), null);
  assert.match(checkMoneyOut({ ...base, what: 'water', choiceId: 'x' }) ?? '', /gas and rent/);
  assert.match(checkMoneyOut({ ...base, qty: 0 }) ?? '', /how many/);
  assert.match(checkMoneyOut({ ...base, qty: 1.5 }) ?? '', /how many/);
  assert.match(checkMoneyOut({ ...base, what: 'rent', qty: 2 }) ?? '', /how many/);
  assert.match(checkMoneyOut({ ...base, grnIds: ['g'] }) ?? '', /deliveries/);
  assert.equal(checkMoneyOut({ ...base, what: 'supplier', supplierId: 's', grnIds: ['g'] }), null);
  assert.match(checkMoneyOut({ ...base, what: 'supplier', supplierId: 's', grnIds: [1] }) ?? '', /deliveries/);
  assert.match(checkChoiceChosen('gas', undefined) ?? '', /size/);
  assert.match(checkChoiceChosen('rent', undefined) ?? '', /which rent/);
  assert.equal(checkChoiceChosen('water', undefined), null);
});

test("the lists start as the owner's, and the latest edit stands; a bad list is refused", () => {
  assert.deepEqual(moneyChoices([]).gas.map((c) => c.label), ['2.5kg', '5kg', '12.5kg']);
  assert.deepEqual(moneyChoices([]).rent.map((c) => c.label), ['Room 1', 'Room 2', 'Land']);
  const set = (label: string) => ({ type: 'money.choices_set', what: 'rent', choices: [{ id: 'r', label }] });
  assert.deepEqual(moneyChoices([set('A'), set('B')]).rent, [{ id: 'r', label: 'B' }]);
  assert.deepEqual(moneyChoices([set('A')]).gas, DEFAULT_CHOICES.gas, 'the other list is left alone');
  assert.equal(checkChoices('gas', DEFAULT_CHOICES.gas), null);
  assert.match(checkChoices('water', DEFAULT_CHOICES.gas) ?? '', /gas or rent/);
  assert.match(checkChoices('gas', []) ?? '', /at least one/);
  assert.match(checkChoices('gas', [{ id: 'a', label: ' ' }]) ?? '', /name/);
  assert.match(checkChoices('gas', [{ id: 'a', label: 'X' }, { id: 'b', label: 'x' }]) ?? '', /same name/);
  assert.match(checkChoices('gas', [{ id: 'a', label: 'X' }, { id: 'a', label: 'Y' }]) ?? '', /same/);
});

test('renaming a rent leaves what was paid under its old name', () => {
  const events = [out('a', { what: 'rent', from: 'bank', choiceId: 'rent-land', note: 'Land' }), { type: 'money.choices_set', what: 'rent', choices: [{ id: 'rent-land', label: 'Back land' }] }];
  assert.equal(moneyOutFromEvents(events)[0].note, 'Land');
});

test('every rent has a row for the month, paid or not; one no longer on the list still shows', () => {
  const all = moneyOutFromEvents([
    out('a', { what: 'rent', from: 'bank', choiceId: 'rent-land', note: 'Land', cents: 2000000, month: '2026-11' }),
    out('b', { what: 'rent', from: 'bank', choiceId: 'rent-land', note: 'Land', cents: 500000, month: '2026-11' }),
    out('c', { what: 'rent', from: 'bank', choiceId: 'rent-old', note: 'Old room', cents: 100000, month: '2026-11' }),
    out('d', { what: 'rent', from: 'bank', cents: 100000, month: '2026-11' }),
    out('e', { what: 'rent', from: 'bank', choiceId: 'rent-room-1', note: 'Room 1', cents: 900000, month: '2026-10' }),
  ]);
  assert.deepEqual(rentRows(all, DEFAULT_CHOICES.rent, '2026-11').map((r) => [r.label, r.cents]), [
    ['Room 1', 0], ['Room 2', 0], ['Land', 2500000], ['Old room', 100000], ['Not said', 100000],
  ]);
});

test('only the owner takes a GRN off the unpaid list, and Undo puts it back', () => {
  const ev = (type: string, actor: Actor, grnId = 'g1') => ({ id: `${type}${actor.id}`, shopId: 's', at, orderNumber: 0, actor, type, grnId });
  assert.deepEqual([...removedGrns([ev('money.grn_removed', owner)])], ['g1']);
  assert.deepEqual([...removedGrns([ev('money.grn_removed', cashier)])], [], 'a cashier never');
  assert.deepEqual([...removedGrns([ev('money.grn_removed', owner), ev('money.grn_restored', owner)])], []);
  assert.deepEqual(moneyOutFromEvents([ev('money.grn_removed', owner)]), [], 'not a payment');
});
