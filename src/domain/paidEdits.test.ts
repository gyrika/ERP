import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paidEdits, whatChanged } from './paidEdits.ts';
import { paidChanges } from './paidChanges.ts';
import type { SyncEvent } from './sync.ts';
import type { OrderLine, PaidOrder } from './types.ts';

// What changed on a paid order after paying, line by line, for the bill on screen (SCRUM-253).

const actor = { id: 'u1', name: 'Kasun', role: 'cashier' as const };
const base = { shopId: 's', actor, orderNumber: 1001, totalBefore: 0, totalAfter: 0 };
const marg: OrderLine = { id: 'a', itemId: 'margherita', qty: 1, size: 'M', adds: [], outs: [], sent: true, unit: 145000 };
const burger: OrderLine = { id: 'b', itemId: 'chicken-burger', qty: 1, adds: [], outs: [], sent: true, unit: 45000 };
const cheesy: OrderLine = { ...marg, adds: ['full-cheese'], unit: 205000 };
const ev = (e: object) => ({ ...base, ...e }) as unknown as SyncEvent;
const paid = (lines: OrderLine[]): PaidOrder =>
  ({ number: 1001, lines, total: 190000, tender: 'cash', tendered: 200000, change: 10000, paidAt: 100, sentAt: 90 }) as PaidOrder;

test('extra cheese after paying: the line is marked "+ Full cheese", +600, to pay until settled', () => {
  const change = ev({ id: 'e1', at: 110, type: 'order.item_changed', lineId: 'a', before: marg, after: cheesy, reason: 'x', afterPay: true });
  const [edit] = paidEdits([change], paid([cheesy, burger]));
  assert.deepEqual(edit, { lineId: 'a', kind: 'changed', amount: 60000, at: 110, what: ['+ Full cheese'], settled: false });
  const settled = ev({ id: 'e2', at: 120, type: 'order.settled', amount: 60000, tender: 'cash', tendered: 100000 });
  assert.equal(paidEdits([change, settled], paid([cheesy, burger]))[0].settled, true);
});

test('an item added on screen is "added" now; once sent with its money it keeps its time', () => {
  const extra: OrderLine = { id: 'c', itemId: 'chicken-burger', qty: 1, adds: [], outs: [] };
  assert.deepEqual(paidEdits([], paid([marg, extra])), [{ lineId: 'c', kind: 'added', amount: 45000, what: [], settled: false }]);
  const sent = ev({ id: 'e1', at: 130, type: 'order.sent', ticketId: 't2', addOn: true, lines: [{ ...extra, sent: true, unit: 45000 }] });
  const settle = ev({ id: 'e2', at: 130, type: 'order.settled', amount: 45000, tender: 'cash', tendered: 45000 });
  assert.deepEqual(paidEdits([sent, settle], paid([marg, { ...extra, sent: true, unit: 45000 }])),
    [{ lineId: 'c', kind: 'added', amount: 45000, at: 130, what: [], settled: true }]);
  // The slip says it too.
  assert.deepEqual(paidChanges([sent], 1001, 100), ['+ 1 x Chicken Burger']);
});

test('taken off after paying: kept for the bill (struck through), money back; not before paying, not undone', () => {
  const events = [
    ev({ id: 'e0', at: 50, type: 'order.item_cancelled', lineId: 'x', index: 1, before: burger, reason: 'x' }),
    ev({ id: 'e1', at: 110, type: 'order.item_cancelled', lineId: 'b', index: 1, before: burger, reason: 'x', afterPay: true }),
    ev({ id: 'e2', at: 120, type: 'order.item_changed', lineId: 'a', before: marg, after: cheesy, reason: 'x', afterPay: true }),
    ev({ id: 'e3', at: 125, type: 'order.change_undone', undoneEventId: 'e2', undoneType: 'order.item_changed' }),
  ];
  assert.deepEqual(paidEdits(events, paid([marg])), [{ lineId: 'b', kind: 'removed', amount: -45000, at: 110, what: [], before: burger, settled: false }]);
});

test('in words: size, how many, extras on and off', () => {
  assert.deepEqual(whatChanged(marg, { ...marg, size: 'L', qty: 2, adds: ['full-cheese'] }), ['Medium → Large', '1 → 2', '+ Full cheese']);
  assert.deepEqual(whatChanged(cheesy, marg), ['− Full cheese']);
});
