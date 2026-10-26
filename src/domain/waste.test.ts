import test from 'node:test';
import assert from 'node:assert/strict';
import type { Answer } from './costing.ts';
import { prepQuestion } from './costing.ts';
import { inventoryFromEvents } from './inventory.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import { itemHistory } from './itemStory.ts';
import { MENU } from './menu.ts';
import { bookUsage, wasteUsage } from './stockUsage.ts';
import type { SyncEvent } from './sync.ts';
import { checkWaste, dishesLeftToWaste, matchesWaste, wasteChoices, wasteRecords, type WasteWhat } from './waste.ts';

// Waste in manager mode: stock goes down through the recipes, like a sale.

const FLOUR = 'inv-0001';
const MOZZ = 'inv-0006';
const none = new Map<string, Answer>();
const ravi = { id: 'm1', name: 'Ravi', role: 'manager' as const };
let n = 0;
const wasted = (what: WasteWhat, qty: number, name = 'x', at = 1000): SyncEvent =>
  ({ id: `w${++n}`, shopId: 's', at, orderNumber: 0, actor: ravi, type: 'stock.wasted', what, name, qty, reason: 'burnt' });
const onHand = (events: SyncEvent[], id: string) => inventoryFromEvents(SEED_INVENTORY, events).find((r) => r.id === id)!.onHandBaseUnits;

test('a wasted dish takes its recipe, like selling it', () => {
  const dish: WasteWhat = { kind: 'dish', itemId: 'margherita', size: 'L' };
  const sold = bookUsage({ itemId: 'margherita', size: 'L', qty: 2, adds: [], outs: [] }, none);
  assert.deepEqual(wasteUsage(dish, 2, none), sold);
  assert.equal(onHand([wasted(dish, 2)], MOZZ), -150, 'two Margherita L: 75 g of mozzarella each');
});

test('a wasted semi-processed item takes its batch down to raw; his own items too', () => {
  const ball = (qty: number) => wasteUsage({ kind: 'prep', name: '12inch Dough Ball', unit: 'pcs' }, qty, none).find((u) => u.inventoryId === FLOUR)!;
  assert.ok(ball(1).qtyBaseUnits > 0);
  assert.equal(ball(3).qtyBaseUnits, ball(1).qtyBaseUnits * 3);

  const own = new Map<string, Answer>([[prepQuestion('k1'), {
    kind: 'prep', name: 'Garlic butter', makes: { qty: 500, unit: 'g' }, lines: [{ name: `stock:${MOZZ}`, qty: 250, unit: 'g' }],
  }]]);
  assert.deepEqual(wasteUsage({ kind: 'prep', name: 'kitchen:k1', unit: 'g' }, 100, own), [{ inventoryId: MOZZ, qtyBaseUnits: 50 }]);
});

test('a wasted raw item is taken as it is; Undo gives it back exactly', () => {
  const w = wasted({ kind: 'stock', itemId: FLOUR }, 1200);
  assert.equal(onHand([w], FLOUR), -1200);
  const undo: SyncEvent = { id: 'u1', shopId: 's', at: 2000, orderNumber: 0, actor: ravi, type: 'stock.waste_undone', wasteId: w.id };
  assert.equal(onHand([w, undo], FLOUR), 0);
  assert.deepEqual(wasteRecords([w, undo]), []);
});

test('each raw item\'s history shows the waste and where it came from', () => {
  const events = [wasted({ kind: 'dish', itemId: 'margherita', size: 'L' }, 1, 'Margherita · Large', 5000)];
  const [h] = itemHistory(events, MOZZ);
  assert.deepEqual(h, { kind: 'waste', at: 5000, by: 'Ravi', qty: 75, from: 'Margherita · Large', reason: 'burnt' });
});

test('the bin lists dishes per size, semi-processed and raw, and finds by any words', () => {
  const list = wasteChoices(MENU, none, SEED_INVENTORY);
  assert.ok(list.some((c) => c.group === 'Finished' && c.name === 'Margherita · Large'));
  assert.ok(list.some((c) => c.group === 'Semi-processed' && c.name === '12inch Dough Ball'));
  assert.ok(list.some((c) => c.group === 'Raw' && c.what.kind === 'stock' && c.what.itemId === FLOUR));
  assert.ok(matchesWaste({ name: 'Devilled Chicken · Large', group: 'Finished' }, 'chick large'));
  assert.ok(!matchesWaste({ name: 'Margherita · Large', group: 'Finished' }, 'chick'));
});

test('a waste needs what, a real amount (whole dishes) and a reason; Other needs words', () => {
  const dish = { kind: 'dish', itemId: 'margherita', size: 'L' };
  assert.equal(checkWaste(dish, 1, 'burnt', undefined, 'Margherita · Large'), null);
  assert.ok(checkWaste(dish, 1.5, 'burnt', undefined, 'M'));
  assert.ok(checkWaste(dish, 0, 'burnt', undefined, 'M'));
  assert.ok(checkWaste(dish, 1, 'nope', undefined, 'M'));
  assert.ok(checkWaste(dish, 1, 'other', '', 'M'));
  assert.equal(checkWaste(dish, 1, 'other', 'rat got it', 'M'), null);
  assert.ok(checkWaste({ kind: 'stock' }, 1, 'burnt', undefined, 'M'));
  assert.equal(checkWaste({ kind: 'stock', itemId: FLOUR }, 0.5, 'expired', undefined, 'Flour'), null);
});

test('the bin can only take a dish the kitchen made today, less what is already wasted (SCRUM-183)', () => {
  const now = new Date(2026, 9, 26, 20, 0).getTime();
  const kasun = { id: 'c1', name: 'Kasun', role: 'cashier' as const };
  const sent = (ticketId: string, at: number, qty: number): SyncEvent[] => [
    { id: `s-${ticketId}`, shopId: 's', at, orderNumber: 1001, actor: kasun, type: 'order.sent', ticketId, addOn: false,
      lines: [{ id: `L-${ticketId}`, itemId: 'margherita', size: 'L', qty, adds: [], outs: [], sent: true }] },
  ];
  const started = (ticketId: string, at: number): SyncEvent => ({ id: `k-${ticketId}`, shopId: 's', at, orderNumber: 1001, ticketId, type: 'kitchen.started' });
  const yesterday = now - 24 * 60 * 60_000;
  const events = [
    ...sent('old', yesterday, 5), started('old', yesterday + 1), // yesterday's: gone
    ...sent('waiting', now - 600_000, 4), // not started: not made
    ...sent('cooking', now - 500_000, 3), started('cooking', now - 400_000),
    wasted({ kind: 'dish', itemId: 'margherita', size: 'L' }, 1, 'Margherita · Large', now - 100_000),
  ];
  assert.deepEqual([...dishesLeftToWaste(events, now)], [['margherita:L', 2]]);
  assert.equal(dishesLeftToWaste(sent('waiting', now - 600_000, 4), now).size, 0, 'sent but never started');
});
