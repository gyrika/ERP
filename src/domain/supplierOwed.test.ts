import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MoneyOut } from './moneyOut.ts';
import { checkGrnPayment, grnsOwed } from './supplierOwed.ts';

const actor = { id: 'c', name: 'C', role: 'cashier' as const };
const day = (n: number) => new Date(2026, 10, 3).getTime() + n * 86_400_000;
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

test('every unpaid GRN counts, however old', () => {
  assert.deepEqual(owed(grnsOwed([grn('old', 1000, new Date(2026, 0, 1).getTime())], [])), { old: 1000 });
});

test('a GRN the owner removed is off the list, and no money goes to it', () => {
  const rows = grnsOwed([grn('a', 1000), grn('b', 1000, day(2))], [pay(500)], new Set(['a']));
  assert.deepEqual(owed(rows), { b: 500 });
});

test('an undone payment is simply not in the list, so the GRN is owed again', () => {
  assert.deepEqual(owed(grnsOwed([grn('a', 1000)], [])), { a: 1000 });
});

test('a supplier payment needs a GRN, and cannot be more than the ticked GRNs owe', () => {
  const rows = grnsOwed([grn('a', 1000), grn('b', 500, day(2))], []);
  assert.equal(checkGrnPayment([], 1000, []), 'No GRN to pay');
  assert.equal(checkGrnPayment([], 1000, rows), 'Choose the GRN');
  assert.equal(checkGrnPayment(['a'], 1001, rows), 'More than the GRN owes');
  assert.equal(checkGrnPayment(['a'], 1000, rows), null);
  assert.equal(checkGrnPayment(['a'], 400, rows), null, 'part of it is fine');
  assert.equal(checkGrnPayment(['a', 'b'], 1500, rows), null);
});
