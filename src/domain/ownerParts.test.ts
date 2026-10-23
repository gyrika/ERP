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
  assert.match(parts.inventory.preview, /^0 of \d+ counted$/);
  assert.equal(parts.manager.preview, 'Nothing counted today');
  assert.equal(parts.menu.preview, '3 dishes without a recipe'); // Sausages, BBQ Pork, Italian Pasta
  assert.ok(Object.values(parts).every((p) => p.badge === 0));
});

test("today's takings; stock low or out is a decision; a count shows under Counts", () => {
  const parts = ownerParts([
    sent(1, 'margherita', 'L'), paid(1, 199000), sent(2, 'margherita', 'M'), paid(2, 145000),
    counted('inv-0024', 0.25), counted('inv-0006', 0),
  ], NOW);
  assert.equal(parts.owner.preview, 'Rs 3,440 · 2 orders');
  assert.equal(parts.inventory.preview, 'Mozzarella (Prabhat) out');
  // Low is the reorder rule's call: a quarter pack of onion with two pizzas sold lasts, so only mozzarella counts.
  assert.equal(parts.inventory.badge, 1, 'mozzarella out; onion is not low by the reorder rule');
  assert.equal(parts.manager.preview, '2 items counted today');
});

test('menu: sold out first; a dish sold without a recipe is a decision', () => {
  const soldOut: SyncEvent = { ...base, id: 'so', at: NOW - 600_000, orderNumber: 0, type: 'menu.sold_out', itemId: 'seafood', until: nextMorning(NOW) };
  assert.equal(ownerParts([soldOut], NOW).menu.preview, 'Seafood sold out today');
  const pasta = ownerParts([sent(3, 'italian-pasta', 'M')], NOW);
  assert.equal(pasta.menu.badge, 1);
  assert.ok(pasta.owner.badge >= 1, 'Today counts it among what needs him');
});
