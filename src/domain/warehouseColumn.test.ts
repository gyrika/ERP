import test from 'node:test';
import assert from 'node:assert/strict';
import type { SyncEvent } from './sync.ts';
import { nextWarehouseName, warehouseColumn } from './warehouseColumn.ts';
import { warehousesFromEvents, type Split } from './warehouses.ts';

// SCRUM-188: Visual Flow's Warehouse view draws a warehouse column with a line to each raw item.

const owner = { id: 'o1', name: 'Nisal', role: 'owner' as const };
let n = 0;
const base = () => ({ id: `c${++n}`, shopId: 's', at: ++n, orderNumber: 0 as const, actor: owner });
const home = (stockKey: string, after: string): SyncEvent => ({ ...base(), type: 'stock.home_set', stockKey, before: null, after });
const archive = (warehouseId: string, name: string): SyncEvent =>
  ({ ...base(), type: 'stock.warehouse_set', warehouseId, before: { name, archived: false }, after: { name, archived: true } });
const ROW = 100;

test('items are stacked by their home, each warehouse in the middle of its block, and empty ones keep a slot', () => {
  const w = warehousesFromEvents([home('stock:cheese', 'wh-2'), home('stock:oil', 'wh-2')]);
  const col = warehouseColumn(w, new Map(), [
    { id: 'stock:oil', total: null, y: 50 },
    { id: 'stock:flour', total: null, y: 0 },
    { id: 'stock:cheese', total: null, y: -50 },
  ], ROW);
  assert.deepEqual(col.cards.map((c) => c.id), ['wh-1', 'wh-2', 'wh-3']);
  const y = (id: string) => col.itemY.get(id)!;
  // Warehouse 1 holds flour; Warehouse 2 cheese then oil (their order on the plain drawing).
  assert.ok(y('stock:flour') < y('stock:cheese'));
  assert.ok(y('stock:cheese') < y('stock:oil'));
  assert.equal(y('stock:oil') - y('stock:cheese'), ROW);
  const card = (id: string) => col.cards.find((c) => c.id === id)!;
  assert.equal(card('wh-1').y, y('stock:flour'));
  assert.equal(card('wh-2').y, (y('stock:cheese') + y('stock:oil')) / 2);
  // Warehouse 3 has nothing of this dish but still a slot below, and "+ Warehouse" below that.
  assert.ok(card('wh-3').y > y('stock:oil'));
  assert.ok(col.addY > card('wh-3').y);
  assert.equal(card('wh-1').kitchenSide, true);
  // Centred on the drawing.
  assert.ok(Math.abs(card('wh-1').y + card('wh-3').y) < 1e-9);
});

test('a line from the home to every item, and dashed ones where some is kept elsewhere', () => {
  const w = warehousesFromEvents([home('stock:flour', 'wh-2')]);
  const places = new Map<string, Split>([['stock:flour', new Map([['wh-2', 3000], ['wh-3', 2000]])]]);
  const col = warehouseColumn(w, places, [{ id: 'stock:flour', total: 5000, y: 0 }, { id: 'stock:salt', total: null, y: 10 }], ROW);
  assert.deepEqual(col.links, [
    { id: 'wh>wh-2>stock:flour', warehouseId: 'wh-2', itemId: 'stock:flour', home: true, qty: 3000 },
    { id: 'wh>wh-3>stock:flour', warehouseId: 'wh-3', itemId: 'stock:flour', home: false, qty: 2000 },
    { id: 'wh>wh-1>stock:salt', warehouseId: 'wh-1', itemId: 'stock:salt', home: true, qty: null },
  ]);
});

test('an archived warehouse is drawn only while it still holds some of these items', () => {
  const places = new Map<string, Split>([['stock:flour', new Map([['wh-3', 1000]])]]);
  const gone = warehousesFromEvents([archive('wh-3', 'Warehouse 3')]);
  assert.deepEqual(warehouseColumn(gone, new Map(), [{ id: 'stock:flour', total: 0, y: 0 }], ROW).cards.map((c) => c.id), ['wh-1', 'wh-2']);
  const col = warehouseColumn(gone, places, [{ id: 'stock:flour', total: 1000, y: 0 }], ROW);
  assert.deepEqual(col.cards.map((c) => [c.id, c.archived]), [['wh-1', false], ['wh-2', false], ['wh-3', true]]);
  assert.ok(col.links.some((l) => l.warehouseId === 'wh-3' && !l.home));
});

test('a new warehouse is called by the next free number', () => {
  assert.equal(nextWarehouseName(warehousesFromEvents([])), 'Warehouse 4');
  const renamed = warehousesFromEvents([{ ...base(), type: 'stock.warehouse_set', warehouseId: 'wh-1', before: { name: 'Warehouse 1', archived: false }, after: { name: 'Warehouse 4', archived: false } }]);
  assert.equal(nextWarehouseName(renamed), 'Warehouse 5');
});
