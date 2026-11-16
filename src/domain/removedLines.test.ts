import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removedLines } from './removedLines.ts';
import type { SyncEvent } from './sync.ts';
import type { Order, OrderLine } from './types.ts';

// Sent items taken off before paying stay on the bill, struck through (owner, 2026-11-17).

const actor = { id: 'u1', name: 'Nimal', role: 'manager' as const };
const base = { shopId: 's', actor, orderNumber: 1001, totalBefore: 0, totalAfter: 0 };
const marg: OrderLine = { id: 'a', itemId: 'margherita', qty: 1, size: 'M', adds: [], outs: [], sent: true, unit: 145000 };
const burger: OrderLine = { id: 'b', itemId: 'chicken-burger', qty: 1, adds: [], outs: [], sent: true, unit: 45000 };
const ev = (e: object) => ({ ...base, ...e }) as unknown as SyncEvent;
const order = (lines: OrderLine[], extra: Partial<Order & { paidAt: number }> = {}) => ({ number: 1001, lines, sentAt: 100, ...extra }) as Order;
const cancel = (id: string, at: number, more: object = {}) =>
  ev({ id, at, type: 'order.item_cancelled', lineId: 'b', index: 1, before: burger, reason: 'Wrong order', ...more });

test('a sent burger voided by the manager: on the bill, with when, who and why', () => {
  assert.deepEqual(removedLines([cancel('e1', 120)], order([marg])),
    [{ lineId: 'b', before: burger, at: 120, reason: 'Wrong order', by: 'Nimal' }]);
});

test('undone, after paying, or from another day: not drawn here', () => {
  const undo = ev({ id: 'e2', at: 125, type: 'order.change_undone', undoneEventId: 'e1', undoneType: 'order.item_cancelled' });
  assert.deepEqual(removedLines([cancel('e1', 120), undo], order([marg])), []);
  assert.deepEqual(removedLines([cancel('e1', 120, { afterPay: true })], order([marg])), []); // paidEdits draws it, with its money
  assert.deepEqual(removedLines([cancel('e1', 50)], order([marg])), []); // yesterday's 1001
  assert.deepEqual(removedLines([cancel('e1', 120)], order([marg], { sentAt: undefined })), []);
});

test('on a paid bill: removals before the payment stay, later ones are the paid edits', () => {
  const paid = order([marg], { paidAt: 200 });
  assert.equal(removedLines([cancel('e1', 120)], paid).length, 1);
  assert.equal(removedLines([cancel('e1', 220)], paid).length, 0);
});

test('a line put back (on the order again) is not drawn as removed', () => {
  assert.deepEqual(removedLines([cancel('e1', 120)], order([marg, burger])), []);
});
