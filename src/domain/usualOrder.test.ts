import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerOrders } from './customers.ts';
import type { SyncEvent } from './sync.ts';
import type { MenuItem, OrderLine } from './types.ts';
import { usualOrder } from './usualOrder.ts';

const actor = { id: 'n', name: 'Nimal', role: 'cashier' as const };
const DILANI = 'cus-00000000000000a1';
const line = (id: string, itemId: string, extra: Partial<OrderLine> = {}): OrderLine =>
  ({ id, itemId, qty: 1, adds: [], outs: [], sent: true, unit: 100000, ...extra });
const marg = (id = 'm') => line(id, 'margherita', { size: 'L' });
const burger = (id = 'b') => line(id, 'chicken-burger', { outs: ['onion'] });
const veggie = (id = 'v') => line(id, 'veggie', { size: 'M' });

const menu: Record<string, Partial<MenuItem>> = { margherita: {}, 'chicken-burger': {}, veggie: {} };
const onMenu = (over: Record<string, Partial<MenuItem>> = {}) => (id: string) =>
  (id in menu ? ({ id, ...menu[id], ...over[id] } as MenuItem) : undefined);

test('an order bought twice is the usual, even if the last one was different', () => {
  const u = usualOrder([[veggie()], [burger('b1'), marg('m1')], [marg('m2'), burger('b2')]], onMenu());
  assert.equal(u?.kind, 'usual');
  assert.equal(u?.times, 2);
  assert.deepEqual(u?.lines.map((l) => l.itemId).sort(), ['chicken-burger', 'margherita']);
  assert.deepEqual(u?.lines.find((l) => l.itemId === 'chicken-burger')?.outs, ['onion']);
  assert.equal(u?.lines.some((l) => 'id' in l || 'sent' in l || 'unit' in l), false, 'a fresh line: priced from today\'s menu');
});

test('nothing repeated: the last order is offered as "Last time"', () => {
  const u = usualOrder([[veggie()], [marg()]], onMenu());
  assert.deepEqual(u, { kind: 'last', lines: [{ itemId: 'veggie', qty: 1, adds: [], outs: [], size: 'M' }], times: 1 });
});

test('two sends of one dish count as one line, so the orders still match', () => {
  const u = usualOrder([[marg('a'), marg('b')], [line('c', 'margherita', { size: 'L', qty: 2 })]], onMenu());
  assert.equal(u?.kind, 'usual');
  assert.deepEqual(u?.lines, [{ itemId: 'margherita', qty: 2, adds: [], outs: [], size: 'L' }]);
});

test('a sold-out or hidden dish is left out; an order with nothing left is skipped', () => {
  const u = usualOrder([[veggie()], [marg(), burger()]], onMenu({ veggie: { soldOut: true }, 'chicken-burger': { hidden: true } }));
  assert.deepEqual(u?.lines.map((l) => l.itemId), ['margherita']);
  assert.equal(usualOrder([[veggie()]], onMenu({ veggie: { removed: true } })), null);
  assert.equal(usualOrder([[line('x', 'gone')]], onMenu()), null);
});

test('a combo box is never offered; no orders, nothing to offer', () => {
  const boxed = [line('a', 'margherita', { size: 'L', box: { id: 'bx', comboId: 'c', share: 100000 } as OrderLine['box'] })];
  assert.equal(usualOrder([boxed], onMenu()), null);
  assert.equal(usualOrder([], onMenu()), null);
});

test('only the last ten orders count', () => {
  const old = Array.from({ length: 5 }, (_, i) => [veggie(`v${i}`)]);
  const recent = Array.from({ length: 10 }, (_, i) => [i % 2 ? marg(`m${i}`) : burger(`b${i}`)]);
  assert.equal(usualOrder([...recent, ...old], onMenu())?.lines[0].itemId, 'chicken-burger'); // 5 each: the newest wins
});

test('customerOrders: the lines of each standing payment for that customer, newest first', () => {
  let seq = 0;
  const ev = <T extends object>(orderNumber: number, at: number, body: T) => ({ id: `e${++seq}`, shopId: 's', at, actor, orderNumber, ...body });
  const events = [
    ev(1001, 1, { type: 'order.sent', ticketId: 't1', lines: [marg()], addOn: false }),
    ev(1001, 2, { type: 'order.paid', total: 100000, tender: 'cash', tendered: 100000, customerId: DILANI }),
    ev(1002, 3, { type: 'order.sent', ticketId: 't2', lines: [veggie()], addOn: false }),
    ev(1002, 4, { type: 'order.paid', total: 100000, tender: 'cash', tendered: 100000 }),
    ev(1003, 5, { type: 'order.sent', ticketId: 't3', lines: [burger()], addOn: false }),
    ev(1003, 6, { type: 'order.paid', total: 100000, tender: 'cash', tendered: 100000, customerId: DILANI }),
    ev(1003, 7, { type: 'order.payment_undone' }),
  ] as unknown as SyncEvent[];
  assert.deepEqual(customerOrders(events, DILANI).map((o) => o.map((l) => l.itemId)), [['margherita']]);
});
