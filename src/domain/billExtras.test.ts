import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billLineOf, checkBillLine, madeInMinutes } from './billExtras.ts';
import { escpos, receipt, receiptText } from './receipt.ts';
import type { SyncEvent } from './sync.ts';
import type { PaidOrder } from './types.ts';

// What makes the bill worth keeping (SCRUM-256).

const actor = { id: 'o', name: 'Owner', role: 'owner' as const };
const ev = (e: object) => ({ shopId: 's', actor, orderNumber: 0, ...e }) as unknown as SyncEvent;
const MIN = 60_000;

test("the owner's line: the latest one, empty takes it off; plain printer letters, two lines at most", () => {
  assert.equal(billLineOf([]), '');
  const a = ev({ id: 'a', at: 1, type: 'shop.bill_line_set', text: 'Thank you for choosing local!' });
  const b = ev({ id: 'b', at: 2, type: 'shop.bill_line_set', text: '' });
  assert.equal(billLineOf([a]), 'Thank you for choosing local!');
  assert.equal(billLineOf([a, b]), '');
  assert.equal(checkBillLine('Fresh dough every morning'), null);
  assert.equal(checkBillLine(''), null);
  assert.match(checkBillLine('x'.repeat(97))!, /96/);
  assert.match(checkBillLine('ස්තූතියි')!, /English/);
  assert.match(checkBillLine('two\nlines')!, /English/);
  assert.equal(checkBillLine(5), 'write the line');
});

test('made in: Send to Done of the order, rounded up, the slowest ticket; none when not made yet', () => {
  const at = 100 * MIN;
  const sent = (id: string, t: number, n = 1001) => ev({ id, at: t, orderNumber: n, type: 'order.sent', ticketId: id, lines: [], addOn: false });
  const done = (id: string, t: number, n = 1001) => ev({ id: `${id}-d`, at: t, orderNumber: n, type: 'kitchen.bumped', ticketId: id });
  assert.equal(madeInMinutes([sent('t1', 80 * MIN)], 1001, at), null, 'not made yet');
  assert.equal(madeInMinutes([sent('t1', 80 * MIN), done('t1', 88.2 * MIN)], 1001, at), 9);
  assert.equal(madeInMinutes([sent('t1', 80 * MIN), done('t1', 88 * MIN), sent('t2', 85 * MIN), done('t2', 97 * MIN)], 1001, at), 12);
  assert.equal(madeInMinutes([sent('t1', 80 * MIN, 1002), done('t1', 88 * MIN, 1002)], 1001, at), null, 'another order');
  assert.equal(madeInMinutes([sent('t1', at - 7 * 60 * MIN), done('t1', at - 7 * 60 * MIN + 5 * MIN)], 1001, at), null, 'an earlier day with the same number');
});

test('the rules print as dashes, not a picture (SCRUM-259)', () => {
  const paid = { number: 1001, lines: [{ id: 'a', itemId: 'margherita', qty: 1, size: 'M', adds: [], outs: [] }], total: 145000, tender: 'cash', tendered: 145000, change: 0, paidAt: 0 } as PaidOrder;
  const lines = receipt(paid, { cashier: 'Kasun' });
  assert.ok(lines.filter((l) => /^-{20,}$/.test(l.text)).length >= 3);
  const bytes = Buffer.from(escpos(lines));
  assert.ok(bytes.includes(Buffer.from('-'.repeat(20))));
});

test('the bill: MADE FRESH IN 9 MIN in a black band, then the owner\'s line; neither when absent', () => {
  const paid = { number: 1001, lines: [{ id: 'a', itemId: 'margherita', qty: 1, size: 'M', adds: [], outs: [] }], total: 145000, tender: 'cash', tendered: 145000, change: 0, paidAt: 0 } as PaidOrder;
  const lines = receipt(paid, { cashier: 'Kasun', madeIn: 9, billLine: 'Fresh dough every morning' });
  assert.deepEqual(lines.find((l) => l.invert), { text: 'MADE FRESH IN 9 MIN', center: true, bold: true, invert: true });
  assert.match(receiptText(lines), /Fresh dough every morning/);
  const plain = receiptText(receipt(paid, { cashier: 'Kasun' }));
  assert.doesNotMatch(plain, /MADE FRESH/);
});
