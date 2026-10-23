import test from 'node:test';
import assert from 'node:assert/strict';
import { nextMorning } from './menuEdits.ts';
import { ownerParts } from './ownerParts.ts';
import type { SyncEvent } from './sync.ts';

// The owner's sidebar lines (SCRUM-131): what is going on in each part, and a badge only for decisions.

const NOW = new Date(2026, 9, 23, 14, 0).getTime();
const owner = { id: 'o', name: 'Owner', role: 'owner' as const };
const base = { shopId: 's', actor: owner };
const sent = (n: number, itemId: string, size?: 'M' | 'L'): SyncEvent =>
  ({ ...base, id: `s${n}`, at: NOW - 3600_000, orderNumber: n, type: 'order.sent', ticketId: `t${n}`, addOn: false,
    lines: [{ id: `l${n}`, itemId, qty: 1, size, adds: [], outs: [] }] });
const paid = (n: number, total: number): SyncEvent =>
  ({ ...base, id: `p${n}`, at: NOW - 3000_000, orderNumber: n, type: 'order.paid', total, tender: 'cash', tendered: total });
const counted = (itemId: string, packs: number): SyncEvent =>
  ({ ...base, id: `c-${itemId}`, at: NOW - 7200_000, orderNumber: 0, type: 'stock.adjusted', itemId, deltaPacks: packs, reason: 'audit' });

test('a quiet shop: every part says what is there, nothing has a badge', () => {
  const parts = ownerParts([], NOW);
  assert.equal(parts.owner.preview, 'No sales yet today');
  assert.equal(parts.count.preview, 'Nothing counted today');
  assert.equal(parts.items.preview, '3 dishes without a recipe'); // Sausages, BBQ Pork, Italian Pasta
  assert.equal(parts.order.preview, 'Nothing to order');
  assert.equal(parts.receive.preview, 'No deliveries expected');
  assert.equal(parts.sell.preview, 'The register');
  assert.ok(Object.values(parts).every((p) => p.badge === 0));
});

test("today's takings; stock low or out is a decision; a count shows under Counts", () => {
  const parts = ownerParts([
    sent(1, 'margherita', 'L'), paid(1, 199000), sent(2, 'margherita', 'M'), paid(2, 145000),
    counted('inv-0024', 0.25), counted('inv-0006', 0),
  ], NOW);
  assert.equal(parts.owner.preview, 'Rs 3,440 · 2 orders');
  assert.equal(parts.items.preview, 'Mozzarella (Prabhat) out');
  // Low is the reorder rule's call: a quarter pack of onion with two pizzas sold lasts, so only mozzarella counts.
  assert.equal(parts.items.badge, 1, 'mozzarella out; onion is not low by the reorder rule');
  assert.equal(parts.count.preview, '2 items counted today');
});

test('items: sold out shows; a dish sold without a recipe is a decision', () => {
  const soldOut: SyncEvent = { ...base, id: 'so', at: NOW - 600_000, orderNumber: 0, type: 'menu.sold_out', itemId: 'seafood', until: nextMorning(NOW) };
  assert.equal(ownerParts([soldOut], NOW).items.preview, 'Seafood sold out today');
  const pasta = ownerParts([sent(3, 'italian-pasta', 'M')], NOW);
  assert.equal(pasta.items.badge, 1);
  assert.ok(pasta.owner.badge >= 1, 'Today counts it among what needs him');
});

test('order: what the reorder rule says to buy is a decision; receive: a delivery past its day is late', () => {
  const DAY = 86_400_000;
  // 500 large margheritas yesterday: flour goes fast; one pack on the shelf is not enough.
  const sales: SyncEvent = { ...base, id: 'big', at: NOW - DAY, orderNumber: 9, type: 'order.sent', ticketId: 'tb', addOn: false,
    lines: [{ id: 'lb', itemId: 'margherita', qty: 500, size: 'L', adds: [], outs: [] }] };
  const flour = (packs: number): SyncEvent => ({ ...base, id: `f${packs}`, at: NOW - 3600_000, orderNumber: 0, type: 'stock.movement', itemId: 'inv-0001', kind: 'COUNT_ADJUST', qtyBase: packs, docId: 'x' });
  const parts = ownerParts([sales, flour(111_288 + 25_000)], NOW);
  assert.equal(parts.order.preview, 'Pizza Flour to order');
  assert.equal(parts.order.badge, 1);

  const po: SyncEvent = { ...base, id: 'po1', at: NOW - 10 * DAY, orderNumber: 0, type: 'stock.ordered', supplierId: 'sup_prima', lines: [{ itemId: 'inv-0001', packs: 2 }] };
  const late = ownerParts([po], NOW);
  assert.equal(late.receive.preview, '1 delivery late');
  assert.equal(late.receive.badge, 1);
  const fresh = ownerParts([{ ...po, at: NOW - 3600_000 }], NOW);
  assert.equal(fresh.receive.preview, '1 delivery expected');
  assert.equal(fresh.receive.badge, 0);
});
