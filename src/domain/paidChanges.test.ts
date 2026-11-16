import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paidChanges } from './paidChanges.ts';
import { changeSlip, receiptText } from './receipt.ts';
import type { SyncEvent } from './sync.ts';
import type { OrderLine } from './types.ts';

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

test('the slip lists the changes and says how the money went back', () => {
  const opts = { at: 0, cashier: 'Kasun' };
  const back = receiptText(changeSlip({ number: 1001, amount: -45000, tender: 'transfer', tendered: 45000, total: 145000, changes: ['- 1 x Chicken Burger'] }, opts));
  assert.match(back, /- 1 x Chicken Burger/);
  assert.match(back, /G I V E N   B A C K/);
  assert.match(back, /By bank transfer/);
  const cash = receiptText(changeSlip({ number: 1001, amount: -45000, tender: 'cash', tendered: 45000, total: 145000 }, opts));
  assert.match(cash, /Cash from the drawer/);
});
