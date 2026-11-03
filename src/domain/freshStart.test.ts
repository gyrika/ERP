import test from 'node:test';
import assert from 'node:assert/strict';
import { freshStartOf, isSetup, withoutTestData } from './freshStart.ts';
import { stockFromEvents } from './inventory.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import { ticketsFromEvents } from './kitchen.ts';
import { numberingOf } from './docNumbers.ts';
import type { SyncEvent } from './sync.ts';
import { splitFor } from './warehouses.ts';

// The shop's first real day: the owner clears what happened while testing; the setup stays.

const FLOUR = 'inv-0001'; // 25 kg bag
const owner = { id: 'o1', name: 'Nisal', role: 'owner' as const };
const base = (at: number) => ({ id: `e${at}`, shopId: 's', at, orderNumber: 0 as const, actor: owner });

const grn = (at: number, packs: number, warehouseId?: string): SyncEvent => ({
  ...base(at), type: 'stock.grn', orderId: 'po', supplierId: 'sup', approvedBy: null,
  lines: [{ itemId: FLOUR, ordered: packs, received: packs, accepted: packs, ...(warehouseId ? { warehouseId } : {}) }],
});
const counted = (at: number, qty: number, expected: number, warehouseId?: string): SyncEvent => ({
  ...base(at), type: 'stock.counted', itemId: FLOUR, counted: qty, expected, entries: [], reason: null, valueCents: 0, tier: 'daily', ...(warehouseId ? { warehouseId } : {}),
});
const cleared = (at: number, before: number): SyncEvent => ({ ...base(at), id: `fresh${at}`, type: 'shop.started_fresh', before });
const sent = (at: number, n: number): SyncEvent => ({
  id: `s${at}`, shopId: 's', at, orderNumber: n, actor: { id: 'c', name: 'Kasun', role: 'cashier' }, type: 'order.sent', ticketId: `t${n}`, addOn: false,
  lines: [{ id: `l${n}`, itemId: 'devilled-chicken', size: 'L', qty: 1, adds: [], outs: [], sent: true, unit: 250000 }],
});
const flour = (events: SyncEvent[]) => stockFromEvents(SEED_INVENTORY, withoutTestData(events)).rows.find((r) => r.id === FLOUR)!.onHandBaseUnits;

test('nothing cleared: the history is the same array, untouched', () => {
  const events = [grn(1, 2), sent(2, 1)];
  assert.equal(withoutTestData(events), events);
  assert.equal(freshStartOf(events), null);
});

test('activity before the cut-off goes; the setup stays, whenever it was made', () => {
  const menu: SyncEvent = { ...base(5), type: 'menu.sold_out', itemId: 'devilled-chicken', until: null } as SyncEvent;
  const supplier: SyncEvent = { ...base(6), type: 'stock.supplier_added', supplier: { id: 'sup_x', name: 'X' }, linkedItemIds: [] };
  const ownerPrice: SyncEvent = { ...base(7), type: 'stock.price_set', itemId: FLOUR, before: 640000, after: 650000 };
  const grnPrice: SyncEvent = { ...base(8), type: 'stock.price_set', itemId: FLOUR, before: 650000, after: 700000, grnId: 'g' };
  const layout: SyncEvent = { ...base(9), type: 'table.layout_set', tables: [] };
  const events = [sent(1, 1), grn(2, 1), menu, supplier, ownerPrice, grnPrice, layout, cleared(50, 10), sent(60, 2)];
  assert.deepEqual(withoutTestData(events).map((e) => e.id), ['e5', 'e6', 'e7', 'e9', 'fresh50', 's60']);
  assert.ok(isSetup(ownerPrice) && !isSetup(grnPrice), "the owner's price stays; a test delivery's price goes with it");
  const rents = { ...base(11), type: 'money.choices_set', what: 'rent', choices: [] } as unknown as SyncEvent;
  const paidOut = { ...base(12), type: 'money.out', kind: 'gas', amount: 100 } as unknown as SyncEvent;
  assert.ok(isSetup(rents) && !isSetup(paidOut), 'the rents to pay stay; a test payment goes');
});

test('the kitchen forgets test tickets; orders after the cut-off stay', () => {
  const events = [sent(1, 1), sent(20, 2), cleared(30, 10)];
  assert.deepEqual(ticketsFromEvents(withoutTestData(events), 40).map((t) => t.number), [2]);
});

test('a count before the clear was compared with test stock: the shelf becomes exactly what was counted', () => {
  // Testing put 3 bags in; the count at 20 saw 1 bag (expected 3, so -2); the owner then clears before 10.
  const events = [grn(1, 3), counted(20, 25000, 75000), cleared(30, 10)];
  assert.equal(flour(events), 25000, 'not 0 - 2 bags');
  // A count after the clear is a difference again, as always.
  assert.equal(flour([...events, grn(40, 1), counted(50, 40000, 50000)]), 40000);
});

test('a warehouse count before the clear sets that warehouse; a whole count after adds up as usual', () => {
  const events = [grn(1, 2, 'wh-2'), counted(20, 10000, 50000, 'wh-2'), counted(21, 5000, 0, 'wh-1'), cleared(30, 10)];
  const s = stockFromEvents(SEED_INVENTORY, withoutTestData(events));
  const total = s.rows.find((r) => r.id === FLOUR)!.onHandBaseUnits;
  assert.equal(total, 15000);
  assert.deepEqual(Object.fromEntries(splitFor(s.warehouses, s.places, `stock:${FLOUR}`, total).map((x) => [x.id, x.qty])), { 'wh-1': 5000, 'wh-2': 10000 });
});

test('Undo (before 0) puts everything back; the latest clear wins', () => {
  const events = [grn(1, 3), cleared(30, 10), cleared(31, 0)];
  assert.equal(freshStartOf(events), null);
  assert.equal(flour(events), 75000);
  assert.deepEqual(freshStartOf([...events, cleared(32, 5)]), { before: 5, at: 32 });
});

test('purchase orders and GRNs from testing take no number: the first real order is PO-0001', () => {
  const po = (at: number): SyncEvent => ({ ...base(at), id: `po${at}`, type: 'stock.ordered', supplierId: 'sup', lines: [] });
  const numbered = (at: number, docId: string, number: string): SyncEvent => ({ ...base(at), id: `n${at}`, type: 'stock.numbered', docId, kind: 'PO', number });
  // The server's number for the test order came a moment after the cut-off: it goes with its order.
  const events = [po(1), numbered(12, 'po1', 'PO-0001'), cleared(30, 10)];
  assert.equal(numberingOf(withoutTestData(events)).last.PO, 0);
  assert.equal(numberingOf(events).last.PO, 1, 'without the clear it would be PO-0002');
});
