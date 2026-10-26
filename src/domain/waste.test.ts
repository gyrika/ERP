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
import { checkWaste, matchesWaste, wasteChoices, wasteRecords, type WasteWhat } from './waste.ts';

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

// SCRUM-176: a sent dish cancelled after the kitchen made it is waste; one not made yet gives its stock back.
const sentPizza: SyncEvent = { id: 'snt1', shopId: 's', at: 100, orderNumber: 7, actor: ravi, type: 'order.sent', ticketId: 't7', addOn: false,
  lines: [{ id: 'L1', itemId: 'margherita', size: 'L', qty: 1, adds: [], outs: [], sent: true }] };
const cancel = (made: boolean): Extract<SyncEvent, { type: 'order.item_cancelled' }> => ({
  id: made ? 'cx-made' : 'cx', shopId: 's', at: 200, orderNumber: 7, actor: ravi, type: 'order.item_cancelled', lineId: 'L1', index: 0,
  before: { id: 'L1', itemId: 'margherita', size: 'L', qty: 1, adds: [], outs: [], sent: true }, reason: 'Customer left', totalBefore: 145000, totalAfter: 0,
  ...(made ? { made: true as const } : {}),
});

test('cancelled before it was made: its mozzarella goes back, and it is not waste', () => {
  assert.equal(onHand([sentPizza], MOZZ), -75);
  assert.equal(onHand([sentPizza, cancel(false)], MOZZ), 0);
  assert.deepEqual(wasteRecords([sentPizza, cancel(false)]), []);
});

test('cancelled after it was made: its mozzarella stays used, as waste, with the reason given', () => {
  const events = [sentPizza, cancel(true)];
  assert.equal(onHand(events, MOZZ), -75);
  const [w] = wasteRecords(events);
  assert.equal(w.reason, 'cancelled');
  assert.equal(w.note, 'Customer left');
  assert.deepEqual(w.takes.find((t) => t.inventoryId === MOZZ), { inventoryId: MOZZ, qtyBaseUnits: 75 });
  const [h] = itemHistory(events, MOZZ);
  assert.equal(h.kind === 'waste' && h.reason, 'cancelled');
});

test('Undo of a made-then-cancelled dish takes the waste back; the sale stands as before', () => {
  const undo: SyncEvent = { id: 'u7', shopId: 's', at: 300, orderNumber: 7, actor: ravi, type: 'order.change_undone', undoneEventId: 'cx-made',
    undoneType: 'order.item_cancelled', totalBefore: 0, totalAfter: 145000 };
  const events = [sentPizza, cancel(true), undo];
  assert.deepEqual(wasteRecords(events), []);
  assert.equal(onHand(events, MOZZ), -75);
});
