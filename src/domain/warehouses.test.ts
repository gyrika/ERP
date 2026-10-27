import test from 'node:test';
import assert from 'node:assert/strict';
import { prepQuestion, type Answer, type RecipeEvent } from './costing.ts';
import { stockFromEvents } from './inventory.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import type { SyncEvent } from './sync.ts';
import { byWarehouse, checkMove, checkWarehouseName, drain, homeOf, shownSplit, splitFor, takeOrder, warehousesFromEvents, type Split } from './warehouses.ts';

// SCRUM-184: stock kept in warehouses; deliveries go where the GRN says, sales take next to the kitchen first.

const FLOUR = 'inv-0001'; // 25 kg bag
const YEAST = 'inv-0005';
const DOUGH = 'kitchen:kdough1';
const owner = { id: 'o1', name: 'Nisal', role: 'owner' as const };
const kasun = { id: 'c1', name: 'Kasun', role: 'cashier' as const };
let n = 0;
const id = () => `w${++n}`;
const base = () => ({ id: id(), shopId: 's', at: ++n, orderNumber: 0 as const, actor: owner });

const grn = (itemId: string, packs: number, warehouseId?: string): SyncEvent => ({
  ...base(), type: 'stock.grn', orderId: 'po', supplierId: 'sup', approvedBy: null,
  lines: [{ itemId, ordered: packs, received: packs, accepted: packs, ...(warehouseId ? { warehouseId } : {}) }],
});
const counted = (itemId: string, qty: number, expected: number, warehouseId?: string): SyncEvent => ({
  ...base(), type: 'stock.counted', itemId, counted: qty, expected, entries: [], reason: null, valueCents: 0, tier: 'daily', ...(warehouseId ? { warehouseId } : {}),
});
const wasted = (itemId: string, qty: number): SyncEvent =>
  ({ ...base(), type: 'stock.wasted', what: { kind: 'stock', itemId }, name: 'x', qty, reason: 'expired' });
const home = (stockKey: string, after: string): SyncEvent => ({ ...base(), type: 'stock.home_set', stockKey, before: null, after });
const moved = (stockKey: string, from: string, to: string, qty: number): SyncEvent => ({ ...base(), type: 'stock.moved', stockKey, from, to, qty });

const split = (events: SyncEvent[], key: string) => {
  const s = stockFromEvents(SEED_INVENTORY, events);
  const total = key.startsWith('stock:')
    ? s.rows.find((r) => `stock:${r.id}` === key)!.onHandBaseUnits
    : s.preps.find((p) => `semi:${p.key}` === key)!.onHand;
  return Object.fromEntries(splitFor(s.warehouses, s.places, key, total).map((x) => [x.id, x.qty]));
};

test('the shop starts with Warehouse 1/2/3, the first next to the kitchen and everyone\'s home', () => {
  const w = warehousesFromEvents([]);
  assert.deepEqual(w.list.map((x) => x.name), ['Warehouse 1', 'Warehouse 2', 'Warehouse 3']);
  assert.equal(w.kitchenSide, 'wh-1');
  assert.equal(homeOf(w, `stock:${FLOUR}`), 'wh-1');
});

test('the owner adds, renames and archives warehouses; the last record wins', () => {
  const w = warehousesFromEvents([
    { ...base(), type: 'stock.warehouse_set', warehouseId: 'wh-2', before: { name: 'Warehouse 2', archived: false }, after: { name: 'Cold room', archived: false } },
    { ...base(), type: 'stock.warehouse_set', warehouseId: 'wh-x1', before: null, after: { name: 'Freezer', archived: false } },
    { ...base(), type: 'stock.warehouse_set', warehouseId: 'wh-3', before: { name: 'Warehouse 3', archived: false }, after: { name: 'Warehouse 3', archived: true } },
    { ...base(), type: 'stock.kitchen_side_set', before: 'wh-1', after: 'wh-2' },
  ]);
  assert.deepEqual(w.list.map((x) => `${x.name}${x.archived ? ' (archived)' : ''}`), ['Warehouse 1', 'Cold room', 'Warehouse 3 (archived)', 'Freezer']);
  assert.equal(w.kitchenSide, 'wh-2');
});

test('take order: next to the kitchen, then the home, then the rest, each once', () => {
  const w = warehousesFromEvents([home(`stock:${FLOUR}`, 'wh-3')]);
  assert.deepEqual(takeOrder(w, `stock:${FLOUR}`), ['wh-1', 'wh-3', 'wh-2']);
  assert.deepEqual(takeOrder(w, `stock:${YEAST}`), ['wh-1', 'wh-2', 'wh-3']);
});

test('drain takes what each warehouse has in order; what nobody has comes from the first', () => {
  const s: Split = new Map([['wh-1', 100], ['wh-2', 50]]);
  assert.deepEqual([...drain(s, ['wh-1', 'wh-2', 'wh-3'], 120)], [['wh-1', 100], ['wh-2', 20]]);
  assert.deepEqual([...s], [['wh-1', 0], ['wh-2', 30]]);
  drain(s, ['wh-1', 'wh-2', 'wh-3'], 40);
  assert.deepEqual([...s], [['wh-1', -10], ['wh-2', 0]]);
});

test('a GRN puts each line where it says, else in the item\'s home; its Undo takes exactly that back', () => {
  const g = grn(FLOUR, 2, 'wh-2');
  assert.deepEqual(split([g], `stock:${FLOUR}`), { 'wh-2': 50000 });
  assert.deepEqual(split([home(`stock:${FLOUR}`, 'wh-3'), grn(FLOUR, 1)], `stock:${FLOUR}`), { 'wh-3': 25000 });
  const undo: SyncEvent = { ...base(), type: 'stock.grn_undone', grnId: g.id, reason: 'wrong', approvedBy: owner };
  assert.deepEqual(split([grn(FLOUR, 1, 'wh-1'), g, undo], `stock:${FLOUR}`), { 'wh-1': 25000 });
});

test('waste and sales take next to the kitchen first, then the home, then the rest (option A)', () => {
  const events = [home(`stock:${FLOUR}`, 'wh-3'), grn(FLOUR, 1, 'wh-1'), grn(FLOUR, 1, 'wh-2'), grn(FLOUR, 1, 'wh-3')];
  assert.deepEqual(split([...events, wasted(FLOUR, 30000)], `stock:${FLOUR}`), { 'wh-2': 25000, 'wh-3': 20000 });
});

test('a waste Undo gives back exactly where it was taken from', () => {
  const w = wasted(FLOUR, 30000);
  const undo: SyncEvent = { ...base(), type: 'stock.waste_undone', wasteId: w.id };
  assert.deepEqual(split([grn(FLOUR, 1, 'wh-1'), grn(FLOUR, 1, 'wh-2'), w, undo], `stock:${FLOUR}`), { 'wh-1': 25000, 'wh-2': 25000 });
});

test('a move carries stock between warehouses without changing the total; its Undo carries it back', () => {
  const m = moved(`stock:${FLOUR}`, 'wh-2', 'wh-1', 5000);
  const events = [grn(FLOUR, 1, 'wh-2'), m];
  assert.deepEqual(split(events, `stock:${FLOUR}`), { 'wh-1': 5000, 'wh-2': 20000 });
  assert.equal(stockFromEvents(SEED_INVENTORY, events).rows.find((r) => r.id === FLOUR)!.onHandBaseUnits, 25000);
  assert.deepEqual(split([...events, { ...base(), type: 'stock.move_undone', moveId: m.id }], `stock:${FLOUR}`), { 'wh-2': 25000 });
});

test('a count of one warehouse corrects that warehouse only; a whole count adds to the home', () => {
  const events = [grn(FLOUR, 1, 'wh-1'), grn(FLOUR, 1, 'wh-2')];
  assert.deepEqual(split([...events, counted(FLOUR, 20000, 25000, 'wh-2')], `stock:${FLOUR}`), { 'wh-1': 25000, 'wh-2': 20000 });
  assert.deepEqual(split([...events, counted(FLOUR, 52000, 50000)], `stock:${FLOUR}`), { 'wh-1': 27000, 'wh-2': 25000 });
  const c = counted(FLOUR, 0, 25000, 'wh-1');
  assert.deepEqual(split([...events, c, { ...base(), type: 'stock.count_undone', countId: c.id }], `stock:${FLOUR}`), { 'wh-1': 25000, 'wh-2': 25000 });
});

test('stock recorded before warehouses existed is in Warehouse 1', () => {
  assert.deepEqual(split([counted(FLOUR, 4000, 0)], `stock:${FLOUR}`), { 'wh-1': 4000 });
});

test('a batch made goes into its home; its raw items come out in the take order', () => {
  const answer = (question: string, after: Answer): RecipeEvent =>
    ({ id: id(), shopId: 's', at: ++n, orderNumber: 0, actor: owner, type: 'recipe.answer_set', question, before: null, after });
  const dough = answer(prepQuestion('kdough1'), {
    kind: 'prep', name: 'Dough', makes: { qty: 20, unit: 'pcs' },
    lines: [{ name: `stock:${FLOUR}`, qty: 2000, unit: 'g' }, { name: `stock:${YEAST}`, qty: 40, unit: 'g' }],
  });
  const ticketId = id();
  const events: SyncEvent[] = [
    dough, home(`semi:${DOUGH}`, 'wh-2'), grn(FLOUR, 1, 'wh-3'),
    { ...base(), actor: kasun, type: 'prep.ordered', ticketId, prepId: DOUGH, name: 'Dough', qty: 20, unit: 'pcs' },
    { id: id(), shopId: 's', at: ++n, orderNumber: 0, ticketId, type: 'kitchen.started' },
    { id: id(), shopId: 's', at: ++n, orderNumber: 0, ticketId, type: 'kitchen.bumped' },
  ];
  assert.deepEqual(split(events, `semi:${DOUGH}`), { 'wh-2': 20 });
  assert.deepEqual(split(events, `stock:${FLOUR}`), { 'wh-3': 23000 });
});

test('names and moves are checked in plain words', () => {
  assert.equal(checkWarehouseName(' '), 'Type a name.');
  assert.equal(checkWarehouseName('Cold room'), null);
  const w = warehousesFromEvents([]);
  assert.equal(checkMove(w, `stock:${FLOUR}`, 'wh-1', 'wh-1', 5), 'Pick a different warehouse.');
  assert.equal(checkMove(w, `stock:${FLOUR}`, 'wh-1', 'wh-2', 0), 'Type how much.');
  assert.equal(checkMove(w, `stock:${FLOUR}`, 'wh-1', 'wh-9', 5), 'Pick where it goes.');
  assert.equal(checkMove(w, `stock:${FLOUR}`, 'wh-1', 'wh-2', 5), null);
});

test('shown split never goes below zero: the shortfall comes off the others in the take order', () => {
  const w = warehousesFromEvents([]);
  const places = new Map([[`stock:${FLOUR}`, new Map([['wh-1', -10], ['wh-2', 30], ['wh-3', 5]])]]);
  assert.deepEqual(shownSplit(w, places, `stock:${FLOUR}`, 25), [{ id: 'wh-2', qty: 20 }, { id: 'wh-3', qty: 5 }]);
});

test('by warehouse: every item is listed in its home, stock where it is, with its value', () => {
  const w = warehousesFromEvents([home(`stock:${YEAST}`, 'wh-3')]);
  const places = new Map([[`stock:${FLOUR}`, new Map([['wh-1', 1000], ['wh-2', 3000]])]]);
  const entries = [
    { key: `stock:${FLOUR}`, kind: 'raw' as const, name: 'Flour', total: 4000, unit: 'g', unitCents: 0.5 },
    { key: `stock:${YEAST}`, kind: 'raw' as const, name: 'Yeast', total: null, unit: 'g', unitCents: 7 },
    { key: `semi:${DOUGH}`, kind: 'semi' as const, name: 'Dough', total: 0, unit: 'pcs', unitCents: null },
  ];
  const rows = byWarehouse(w, places, entries);
  const show = (id: string) => rows.find((r) => r.id === id)!.items.map((i) => `${i.name} ${i.qty}${i.home ? ' home' : ''}`);
  assert.deepEqual(show('wh-1'), ['Flour 1000 home', 'Dough 0 home']);
  assert.deepEqual(show('wh-2'), ['Flour 3000']);
  assert.deepEqual(show('wh-3'), ['Yeast null home']);
  assert.equal(rows.find((r) => r.id === 'wh-2')!.cents, 1500);
  assert.equal(rows[0].kitchenSide, true);
});
