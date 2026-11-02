import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MoneyOut } from './moneyOut.ts';
import { grnsOwed, OWED_SINCE, suppliersOwed } from './supplierOwed.ts';

const actor = { id: 'c', name: 'C', role: 'cashier' as const };
const day = (n: number) => OWED_SINCE + n * 86_400_000;
const grn = (id: string, cents: number, at = day(1), supplierId = 's1', undone = false) => ({
  id, grnNo: id.toUpperCase(), supplierId, at, undone: undone ? { at, reason: 'x', by: null } : null,
  lines: [{ itemId: 'i', ordered: 1, received: 1, unitPriceCents: cents }],
});
const pay = (cents: number, grnIds?: string[], supplierId = 's1'): MoneyOut => ({
  id: `p${cents}`, at: day(5), actor, what: 'supplier', from: 'drawer', cents, month: '2026-11', supplierId, ...(grnIds ? { grnIds } : {}),
});
const owed = (rows: ReturnType<typeof grnsOwed>) => Object.fromEntries(rows.map((r) => [r.id, r.owed]));

test('a GRN is owed in full until paid, and paying it clears it', () => {
  assert.deepEqual(owed(grnsOwed([grn('a', 5000)], [])), { a: 5000 });
  assert.deepEqual(owed(grnsOwed([grn('a', 5000)], [pay(5000, ['a'])])), { a: 0 });
});

test('a part payment goes to the named GRNs, oldest first', () => {
  const rows = grnsOwed([grn('new', 3000, day(2)), grn('old', 5000, day(1)), grn('other', 1000, day(0))], [pay(6000, ['new', 'old'])]);
  assert.deepEqual(owed(rows), { other: 1000, old: 0, new: 2000 });
});

test('paying more, or naming no GRN, counts towards what the supplier is owed: never lost', () => {
  assert.deepEqual(owed(grnsOwed([grn('a', 1000), grn('b', 1000, day(2))], [pay(1500, ['a'])])), { a: 0, b: 500 });
  assert.deepEqual(owed(grnsOwed([grn('a', 1000), grn('b', 1000, day(2))], [pay(1500)])), { a: 0, b: 500 });
});

test('one supplier’s money never pays another’s GRN', () => {
  const rows = grnsOwed([grn('a', 1000), grn('b', 1000, day(1), 's2')], [pay(5000, ['a', 'b'])]);
  assert.deepEqual(owed(rows), { a: 0, b: 1000 });
});

test('an undone GRN owes nothing; what paid it moves to the next one', () => {
  const rows = grnsOwed([grn('a', 1000, day(1), 's1', true), grn('b', 1000, day(2))], [pay(1000, ['a'])]);
  assert.deepEqual(owed(rows), { b: 0 });
});

test('deliveries from before payments were linked are not debts', () => {
  assert.deepEqual(grnsOwed([grn('old', 1000, OWED_SINCE - 1)], []), []);
});

test('an undone payment is simply not in the list, so the GRN is owed again', () => {
  assert.deepEqual(owed(grnsOwed([grn('a', 1000)], [])), { a: 1000 });
});

test('who is owed, most first, leaving out whoever is paid up', () => {
  const rows = grnsOwed([grn('a', 1000), grn('b', 2000, day(2)), grn('c', 9000, day(1), 's2'), grn('d', 500, day(1), 's3')], [pay(500, ['d'], 's3')]);
  assert.deepEqual(suppliersOwed(rows), [{ supplierId: 's2', owed: 9000, grns: 1 }, { supplierId: 's1', owed: 3000, grns: 2 }]);
});
