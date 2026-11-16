import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paidChanges } from './paidChanges.ts';
import { changeBlocks, changedBill, escpos, receiptText } from './receipt.ts';
import type { SyncEvent } from './sync.ts';
import type { OrderLine, PaidOrder } from './types.ts';

// The change slip says what changed after paying, and how the money went back (SCRUM-247).

const actor = { id: 'u1', name: 'Kasun', role: 'cashier' as const };
const base = { shopId: 's', actor, orderNumber: 1001 };
const audit = { totalBefore: 0, totalAfter: 0 };
const marg: OrderLine = { id: 'a', itemId: 'margherita', qty: 1, size: 'M', adds: [], outs: [], sent: true, unit: 145000 };
const burger: OrderLine = { id: 'b', itemId: 'chicken-burger', qty: 1, adds: [], outs: [], sent: true, unit: 45000 };
const ev = (e: object) => ({ ...base, ...audit, ...e }) as unknown as SyncEvent;

test('what came off and went on after paying, not before it, not undone, not on an earlier slip', () => {
  const events = [
    ev({ id: 'e0', at: 50, type: 'order.item_cancelled', lineId: 'b', index: 1, before: burger, reason: 'x' }), // before paying
    ev({ id: 'e1', at: 110, type: 'order.item_changed', lineId: 'a', before: marg, after: { ...marg, size: 'L' }, reason: 'x', afterPay: true }),
    ev({ id: 'e2', at: 120, type: 'order.settled', amount: 54000, tender: 'cash', tendered: 54000 }),
    ev({ id: 'e3', at: 130, type: 'order.item_cancelled', lineId: 'b', index: 1, before: burger, reason: 'x', afterPay: true }),
    ev({ id: 'e4', at: 140, type: 'order.item_cancelled', lineId: 'a', index: 0, before: marg, reason: 'x', afterPay: true }),
    ev({ id: 'e5', at: 150, type: 'order.change_undone', undoneEventId: 'e4', undoneType: 'order.item_cancelled' }),
    ev({ id: 'e6', at: 160, type: 'order.item_cancelled', orderNumber: 1002, lineId: 'z', index: 0, before: burger, reason: 'x', afterPay: true }),
  ];
  assert.deepEqual(paidChanges(events.slice(0, 2), 1001, 100), ['- 1 x Margherita Medium', '+ 1 x Margherita Large']);
  assert.deepEqual(paidChanges(events, 1001, 100), ['- 1 x Chicken Burger']);
});

test('the CHANGED BILL: same number, the bill now, paid before, PAID NOW, a dated block per change (SCRUM-255)', () => {
  const cheesy: OrderLine = { ...marg, adds: ['full-cheese'], unit: 205000 };
  const paid = { number: 1001, lines: [cheesy, burger], total: 190000, tender: 'cash', tendered: 200000, change: 10000, paidAt: 100, settled: 60000 } as PaidOrder;
  const events = [
    ev({ id: 'e1', at: 110, type: 'order.item_changed', lineId: 'a', before: marg, after: cheesy, reason: 'x', afterPay: true }),
    ev({ id: 'e2', at: 120, type: 'order.settled', amount: 60000, tender: 'cash', tendered: 100000 }),
  ];
  const blocks = changeBlocks(events, paid);
  assert.deepEqual(blocks, [{ at: 120, entries: [{ text: 'Margherita: + Full cheese', amount: 60000 }], amount: 60000, tender: 'cash', tendered: 100000 }]);
  const lines = changedBill(paid, blocks, { cashier: 'Kasun' });
  assert.deepEqual(lines.find((l) => l.invert), { text: 'CHANGED BILL', center: true, bold: true, big: true, invert: true });
  const text = receiptText(lines);
  assert.match(text, /Order 1001/);
  assert.match(text, /1 x Margherita Medium +2,050/);
  assert.match(text, /\+ Full cheese/);
  assert.match(text, /T O T A L .*R s   2 , 5 0 0/);
  assert.match(text, /Paid before +1,900/);
  assert.match(text, /P A I D   N O W .*R s   6 0 0/);
  assert.match(text, /Cash +1,000/);
  assert.match(text, /Change +400/);
  assert.match(text, /Changed .*\n  Margherita: \+ Full cheese +\+600/);
  // A reprint says COPY; the invert band survives as ESC/POS GS B 1.
  assert.match(receiptText(changedBill(paid, blocks, { cashier: 'Kasun', copy: true })), /COPY/);
  assert.ok(Buffer.from(escpos(lines)).includes(Buffer.from([0x1d, 0x42, 0x01])));
});

test('two changes paid at two times: two blocks; the first says how its money went, money back says so', () => {
  const paid = { number: 1001, lines: [marg], total: 190000, tender: 'cash', tendered: 190000, change: 0, paidAt: 100, settled: -45000 } as PaidOrder;
  const extra: OrderLine = { id: 'c', itemId: 'chicken-burger', qty: 1, adds: [], outs: [], sent: true, unit: 45000 };
  const events = [
    ev({ id: 'e1', at: 110, type: 'order.sent', ticketId: 't2', addOn: true, lines: [extra] }),
    ev({ id: 'e2', at: 111, type: 'order.settled', amount: 45000, tender: 'cash', tendered: 45000 }),
    ev({ id: 'e3', at: 130, type: 'order.item_cancelled', lineId: 'b', index: 1, before: burger, reason: 'x', afterPay: true }),
    ev({ id: 'e4', at: 131, type: 'order.item_cancelled', lineId: 'c', index: 1, before: extra, reason: 'x', afterPay: true }),
    ev({ id: 'e5', at: 132, type: 'order.settled', amount: -90000, tender: 'transfer', tendered: 90000 }),
  ];
  const text = receiptText(changedBill(paid, changeBlocks(events, paid), { cashier: 'Kasun' }));
  assert.match(text, /\+ 1 x Chicken Burger +\+450\n  Paid 450 more/);
  assert.match(text, /- 1 x Chicken Burger +-450/);
  assert.match(text, /Paid before +2,350/);
  assert.match(text, /G I V E N   B A C K .*R s   9 0 0/);
  assert.match(text, /By bank transfer/);
});
