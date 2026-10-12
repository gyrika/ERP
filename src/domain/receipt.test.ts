import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CMD, RECEIPT_WIDTH, escpos, opensDrawer, receipt, receiptText, twoCols, wrap } from './receipt.ts';
import { totals } from './totals.ts';
import type { Order, PaidOrder, Tender } from './types.ts';

const at = new Date(2026, 9, 12, 19, 42).getTime(); // local time, as the receipt prints it

const pay = (order: Order, tender: Tender, tendered?: number): PaidOrder => {
  const total = totals(order).total;
  const given = tendered ?? total;
  return { ...order, total, tender, tendered: given, change: Math.max(0, given - total), paidAt: at };
};

const busy: Order = {
  number: 1043,
  lines: [
    { id: 'a', itemId: 'margherita', qty: 2, size: 'M', adds: ['full-cheese'], outs: [], sent: true },
    { id: 'b', itemId: 'devilled-chicken', qty: 1, size: 'L', adds: [], outs: ['no-onion'], note: 'extra hot', sent: true },
    { id: 'c', itemId: 'crispy-chicken-burger', qty: 1, adds: [], outs: [], sent: true },
  ],
  adjust: { lines: { b: 20000 }, discount: { kind: 'percent', pct: 10 } },
};

test('the receipt as it prints: items, adjustments, discount, cash and change', () => {
  const text = receiptText(receipt(pay(busy, 'cash', 1000000), { cashier: 'Nimal' }));
  assert.equal(text, [
    '              C h e e s y B e e z',
    '                    Thalwila',
    '------------------------------------------------',
    'Order 1043                     12 Oct 2026 19:42',
    'Cashier: Nimal',
    '------------------------------------------------',
    '2 x Margherita Medium                      4,100',
    '    + Full cheese',
    '1 x Devilled Chicken Large                 2,500',
    '    Price adjusted                          -200',
    '1 x Crispy Chicken Burger                    650',
    '------------------------------------------------',
    'Subtotal                                   7,050',
    '10% off                                     -705',
    'T O T A L                       R s   6 , 3 4 5',
    'Cash                                      10,000',
    'Change                                     3,655',
    '------------------------------------------------',
    '                   Thank you!',
  ].join('\n'));
  assert.ok(!text.includes('No onion') && !text.includes('extra hot'), 'kitchen details stay off the receipt');
});

test('every line fits the paper', () => {
  const lines = receipt(pay(busy, 'cash', 1000000), { cashier: 'A very long cashier name indeed' });
  for (const l of lines) assert.ok(l.text.length <= (l.big ? RECEIPT_WIDTH / 2 : RECEIPT_WIDTH), l.text);
});

test('bank transfer and Free: no cash lines, and Free says so once', () => {
  const plain: Order = { number: 1050, lines: [busy.lines[2]] };
  const transfer = receiptText(receipt(pay(plain, 'transfer'), { cashier: 'Nimal' }));
  assert.match(transfer, /Paid by +Bank transfer/);
  assert.doesNotMatch(transfer, /Change|Subtotal/);

  const free = receiptText(receipt(pay({ ...plain, adjust: { discount: { kind: 'comp' } } }, 'comp', 0), { cashier: 'Ravi' }));
  assert.match(free, /\nFree +-650\n/);
  assert.match(free, /R s   0/);
  assert.doesNotMatch(free, /Paid by/);
});

test('only cash opens the drawer', () => {
  const plain: Order = { number: 1, lines: [busy.lines[2]] };
  assert.equal(opensDrawer(pay(plain, 'cash')), true);
  for (const t of ['transfer', 'card', 'qr', 'comp'] as const) assert.equal(opensDrawer(pay(plain, t)), false);
});

test('ESC/POS bytes: init, drawer first, styles reset, ASCII only, then feed and cut', () => {
  const bytes = [...escpos([{ text: 'Hi', center: true, bold: true, big: true }, { text: '2 × Pizza · ok' }], { openDrawer: true })];
  assert.deepEqual(bytes, [
    ...CMD.init, ...CMD.kick,
    ...CMD.center, ...CMD.boldOn, ...CMD.big, 0x48, 0x69, 0x0a, ...CMD.normal, ...CMD.boldOff,
    ...CMD.left, ...[...'2 x Pizza - ok'].map((c) => c.charCodeAt(0)), 0x0a,
    ...CMD.left, ...CMD.feedCut,
  ]);
  assert.ok(![...escpos([{ text: 'x' }])].some((b, i, a) => b === 0x1b && a[i + 1] === 0x70), 'no drawer kick unless asked');
  assert.deepEqual([...escpos([{ text: 'අ' }])].slice(5, 6), [0x3f], 'non-ASCII prints as ? rather than garbage');
});

test('two columns and wrapping', () => {
  assert.equal(twoCols('Cash', '500', 12), 'Cash     500');
  assert.equal(twoCols('A long left side', '500', 12), 'A long l 500');
  assert.deepEqual(wrap('2 x Very Long Pizza Name Here', 10), ['2 x Very', 'Long Pizza', 'Name Here']);
  assert.deepEqual(wrap('Supercalifragilistic', 8), ['Supercal', 'ifragili', 'stic']);
});

test('a reprint is marked COPY', () => {
  const plain: Order = { number: 1, lines: [busy.lines[2]] };
  const lines = receiptText(receipt(pay(plain, 'cash'), { cashier: 'Nimal', copy: true })).split('\n');
  assert.equal(lines[2].trim(), 'COPY');
  assert.ok(!receiptText(receipt(pay(plain, 'cash'), { cashier: 'Nimal' })).includes('COPY'));
});

test('an online order says so on its receipt; a counter order does not', () => {
  const online = receiptText(receipt(pay({ ...busy, online: { pickupBy: at } }, 'cash'), { cashier: 'Nimal' }));
  assert.match(online, /Online order: collected/);
  assert.doesNotMatch(receiptText(receipt(pay(busy, 'cash'), { cashier: 'Nimal' })), /Online/);
});
