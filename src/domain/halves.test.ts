import test from 'node:test';
import assert from 'node:assert/strict';
import { basePrice, canHalve, leaveOutsOf, lineItemName } from './halves.ts';
import { ticketsFromEvents } from './kitchen.ts';
import { itemById, MENU } from './menu.ts';
import { unitPrice } from './money.ts';
import { addLine, emptyOrder, markSent } from './order.ts';
import { ShorthandInterpreter } from './parser.ts';
import { receipt, receiptText } from './receipt.ts';
import { bookGaps, bookUsage } from './stockUsage.ts';
import { totals } from './totals.ts';
import type { LineSpec, PaidOrder } from './types.ts';

// Half-and-half pizzas: "Half price for each half" (the owner, October 2026).

const half = (a: string, b: string, extra: Partial<LineSpec> = {}): LineSpec =>
  ({ itemId: a, half: b, qty: 1, size: 'L', adds: [], outs: [], ...extra });

test('the price is half of each half, per size, rounded once; extras once for the whole pizza', () => {
  // Devilled Chicken M 1650, BBQ Chicken M 1750 → 1700. L: 2500 + 2500 → 2500.
  assert.equal(basePrice(itemById('devilled-chicken'), { size: 'M', half: 'bbq-chicken' }), 170000);
  assert.equal(unitPrice(itemById('devilled-chicken'), half('devilled-chicken', 'bbq-chicken')), 250000);
  // Margherita L 1990 + Seafood L 3200 → 2595.
  assert.equal(unitPrice(itemById('margherita'), half('margherita', 'seafood')), 259500);
  assert.equal(unitPrice(itemById('margherita'), half('margherita', 'seafood', { adds: ['bacon'] })), 259500 + 45000);
  assert.equal(basePrice(itemById('margherita'), { size: 'M' }), 145000, 'a whole pizza is unchanged');
});

test('only two different pizzas make a half-and-half', () => {
  assert.equal(canHalve(itemById('margherita'), itemById('seafood')), true);
  assert.equal(canHalve(itemById('margherita'), itemById('margherita')), false);
  assert.equal(canHalve(itemById('margherita'), itemById('chicken-burger')), false);
});

test('its name and leave-outs come from both halves', () => {
  assert.equal(lineItemName(half('devilled-chicken', 'bbq-chicken')), '½ Devilled Chicken + ½ BBQ Chicken');
  const outs = leaveOutsOf(itemById('margherita'), itemById('seafood')).map((o) => o.id);
  assert.deepEqual(outs, ['no-onion', 'no-bell-pepper', 'no-tomato']);
});

test('in an order it is its own line, priced at Send, and never merged with a whole pizza', () => {
  let order = addLine(emptyOrder(1), half('devilled-chicken', 'bbq-chicken', { size: 'M' }));
  order = addLine(order, { itemId: 'devilled-chicken', qty: 1, size: 'M', adds: [], outs: [] });
  order = addLine(order, half('devilled-chicken', 'bbq-chicken', { size: 'M' }));
  assert.equal(order.lines.length, 2);
  assert.equal(order.lines[0].qty, 2);
  assert.equal(totals(order).total, 2 * 170000 + 165000);
  assert.equal(markSent(order, 1).lines[0].unit, 170000);
});

test('the kitchen and the receipt name both halves', () => {
  const order = markSent(addLine(emptyOrder(7), half('margherita', 'seafood', { outs: ['no-tomato'] })), 1);
  const [ticket] = ticketsFromEvents([{
    id: 'e1', shopId: 's', at: 1, orderNumber: 7, actor: { id: 'a', name: 'A', role: 'cashier' },
    type: 'order.sent', ticketId: 't1', lines: order.lines, addOn: false,
  }], 1);
  assert.equal(ticket.lines[0].itemId, 'margherita');
  const paid: PaidOrder = { ...order, paidAt: 2, tender: 'cash', tendered: 300000, total: 259500 } as PaidOrder;
  const text = receiptText(receipt(paid, { cashier: 'A' }));
  assert.match(text, /1 x 1\/2 Margherita \+ 1\/2 Seafood/);
  assert.match(text, /2,595/);
});

test('in stock each half takes half of its recipe; a half with no recipe keeps the pizza off stock', () => {
  const none = new Map();
  const whole = (id: string) => Object.fromEntries(bookUsage({ itemId: id, qty: 1, size: 'L', adds: [], outs: [] }, none).map((u) => [u.inventoryId, u.qtyBaseUnits]));
  const both = Object.fromEntries(bookUsage(half('margherita', 'cheese-onion'), none).map((u) => [u.inventoryId, u.qtyBaseUnits]));
  const ONION = 'inv-0024';
  assert.equal(both[ONION], whole('cheese-onion')[ONION] / 2);
  assert.deepEqual(bookUsage(half('margherita', 'sausages'), none), [], 'Sausages has no recipe yet');
  assert.equal(bookGaps(half('margherita', 'sausages'), none).untracked, true);
});

test('typed: "L half devilled chicken half bbq chicken" and "margherita / seafood no onion"', () => {
  const p = new ShorthandInterpreter(MENU);
  assert.deepEqual(p.interpret('L half devilled chicken half bbq chicken').lines,
    [{ itemId: 'devilled-chicken', half: 'bbq-chicken', qty: 1, size: 'L', adds: [], outs: [] }]);
  assert.deepEqual(p.interpret('2 margherita / seafood no onion').lines,
    [{ itemId: 'margherita', half: 'seafood', qty: 2, size: 'M', adds: [], outs: ['no-onion'] }]);
  assert.deepEqual(p.interpret('half margherita half burger').lines, [], 'a burger cannot be half a pizza');
  assert.deepEqual(p.interpret('2 L devilled chicken no onion, burger').lines.map((l) => l.half), [undefined, undefined]);
});
