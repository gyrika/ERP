import test from 'node:test';
import assert from 'node:assert/strict';
import { SEED_INVENTORY, SEED_SUPPLIERS } from './inventoryData.ts';
import { countDifference, inventoryFromEvents, isLowStock, isOutOfStock, itemById, parsePacks, loadSeed, summariseSuppliers, supplierById, suppliersFromEvents, validateSeed } from './inventory.ts';
import { mayRecord } from './auth.ts';
import type { UsageOf } from './stockUsage.ts';
import { storageKey } from '../ui/storage.ts';

test('T1: suppliers have unique ids', () => {
  assert.equal(new Set(SEED_SUPPLIERS.map((s) => s.id)).size, SEED_SUPPLIERS.length);
});

test('T2: items have unique ids', () => {
  assert.equal(new Set(SEED_INVENTORY.map((i) => i.id)).size, SEED_INVENTORY.length);
});

test('T3: every item supplier resolves', () => {
  for (const item of SEED_INVENTORY) {
    assert.ok(item.supplierIds.length > 0, `${item.id}: no suppliers`);
    for (const supplierId of item.supplierIds) {
      assert.ok(supplierById(supplierId), `${item.id}: supplier ${supplierId}`);
    }
  }
});

test('T4: inventory items support independent multiple suppliers', () => {
  assert.ok(SEED_INVENTORY.some((item) => item.supplierIds.length > 1));
});

test('T5: all workingPriceCents are non-negative integers', () => {
  for (const item of SEED_INVENTORY) {
    assert.ok(Number.isInteger(item.workingPriceCents) && item.workingPriceCents >= 0, item.id);
  }
});

test('T6: all packQty are positive numbers', () => {
  for (const item of SEED_INVENTORY) {
    assert.ok(typeof item.packQty === 'number' && item.packQty > 0 && Number.isFinite(item.packQty), item.id);
  }
});

test('T7: all baseUnits are valid', () => {
  const allowed = ['g', 'ml', 'pcs', 'sheets'];
  for (const item of SEED_INVENTORY) {
    assert.ok(allowed.includes(item.baseUnit), `${item.id}: ${item.baseUnit}`);
  }
});

test('T8: required fields are present', () => {
  for (const s of SEED_SUPPLIERS) {
    assert.ok(s.id.trim());
    assert.ok(s.name.trim());
  }
  for (const i of SEED_INVENTORY) {
    assert.ok(i.name.trim());
    assert.ok(i.category.trim());
    assert.ok(i.baseUnit);
    assert.ok(i.supplierIds.length > 0);
  }
});

test('T9: price conversion spot-checks', () => {
  assert.equal(itemById('inv-0001')!.workingPriceCents, 640000);
  assert.equal(itemById('inv-0024')!.workingPriceCents, 24928);
  assert.equal(itemById('inv-0052')!.workingPriceCents, 35500);
});

test('T10: unit normalization spot-checks', () => {
  const flour = itemById('inv-0001')!;
  assert.equal(flour.baseUnit, 'g');
  assert.equal(flour.packQty, 25000);
  const palm = itemById('inv-0023')!;
  assert.equal(palm.baseUnit, 'ml');
  assert.equal(palm.packQty, 3780);
  const buns = itemById('inv-0052')!;
  assert.equal(buns.baseUnit, 'pcs');
  assert.equal(buns.packQty, 6);
});

test('T11: no duplicate supplier names (normalized)', () => {
  const normalized = SEED_SUPPLIERS.map((s) => s.name.trim().toLowerCase());
  assert.equal(new Set(normalized).size, normalized.length);
});

test('T12: supplier count matches expectation', () => {
  assert.equal(SEED_SUPPLIERS.length, 18);
});

test('T13: item count matches expectation', () => {
  assert.equal(SEED_INVENTORY.length, 59);
});

test('T14: validateSeed returns no errors', () => {
  assert.equal(validateSeed({ suppliers: SEED_SUPPLIERS, items: SEED_INVENTORY }).length, 0);
});

test('T15: loadSeed does not overwrite', () => {
  const seed = [1, 2];
  assert.deepEqual(loadSeed('k', seed), seed);
  assert.deepEqual(loadSeed('k', seed, () => [9]), [9]);
  assert.deepEqual(loadSeed('k', seed, () => []), seed);
});

test('T16: storage key namespacing', () => {
  assert.equal(storageKey('inventory.v0'), 'cb.inventory.v0');
});

test('stock is built from events: exact amounts, last price wins, unknown items ignored', () => {
  const actor = { id: 'm', name: 'Ravi', role: 'manager' as const };
  const base = { shopId: 's', orderNumber: 0 as const, actor, at: 1 };
  const flour = SEED_INVENTORY[0].id;
  const rows = inventoryFromEvents(SEED_INVENTORY, [
    { ...base, id: 'a', type: 'stock.adjusted', itemId: flour, deltaPacks: 3 },
    { ...base, id: 'b', type: 'stock.adjusted', itemId: flour, deltaPacks: -5 },
    { ...base, id: 'c', type: 'stock.adjusted', itemId: flour, deltaPacks: 2 },
    { ...base, id: 'd', type: 'stock.price_set', itemId: flour, before: 640000, after: 650000 },
    { ...base, id: 'e', type: 'stock.adjusted', itemId: 'gone', deltaPacks: 9 },
  ]);
  const row = rows.find((r) => r.id === flour)!;
  assert.equal(row.onHandBaseUnits, 0, '3 in, 5 out, 2 in: exact, so every give-back adds up');
  assert.equal(row.counted, true);
  assert.equal(row.workingPriceCents, 650000);
  assert.equal(rows.length, SEED_INVENTORY.length);
  assert.ok(rows.filter((r) => r.id !== flour).every((r) => r.onHandPacks === 0));
});

test('creation events add ingredients and independent supplier links without mutating seed data', () => {
  const actor = { id: 'm', name: 'Ravi', role: 'manager' as const };
  const base = { shopId: 's', orderNumber: 0 as const, actor, at: 1 };
  const flour = SEED_INVENTORY[0];
  const supplier = { id: 'sup_extra', name: 'Fresh Farms' };
  const newItem = {
    id: 'inv-extra',
    name: 'Sea Salt',
    category: 'General',
    baseUnit: 'pcs' as const,
    packQty: 1,
    supplierIds: [supplier.id],
    workingPriceCents: 0,
  };
  const rows = inventoryFromEvents(SEED_INVENTORY, [
    { ...base, id: 'supplier-added', type: 'stock.supplier_added', supplier, linkedItemIds: [flour.id] },
    { ...base, id: 'item-added', type: 'stock.item_added', item: newItem },
    { ...base, id: 'stock-added', type: 'stock.adjusted', itemId: newItem.id, deltaPacks: 2 },
  ]);

  assert.deepEqual(flour.supplierIds, ['sup_prima', 'sup_ajantha']);
  assert.deepEqual(rows.find((item) => item.id === flour.id)?.supplierIds, ['sup_prima', 'sup_ajantha', supplier.id]);
  assert.equal(rows.find((item) => item.id === newItem.id)?.onHandPacks, 2);
  const supplierSummary = summariseSuppliers(rows, [...SEED_SUPPLIERS, supplier]).find((summary) => summary.supplier.id === supplier.id);
  assert.deepEqual(supplierSummary?.suppliedItems.map((item) => item.id), [flour.id, newItem.id]);
});

test('ingredient and supplier archive events hide catalog rows and restore them without losing stock', () => {
  const actor = { id: 'm', name: 'Ravi', role: 'manager' as const };
  const base = { shopId: 's', orderNumber: 0 as const, actor, at: 1 };
  const itemId = SEED_INVENTORY[0].id;
  const supplierId = SEED_SUPPLIERS[0].id;
  const archived = [
    { ...base, id: 'stock-in', type: 'stock.adjusted' as const, itemId, deltaPacks: 3 },
    { ...base, id: 'item-archived', type: 'stock.item_archived' as const, itemId },
    { ...base, id: 'supplier-archived', type: 'stock.supplier_archived' as const, supplierId },
  ];
  const rows = inventoryFromEvents(SEED_INVENTORY, archived);

  assert.equal(rows.find((item) => item.id === itemId)?.archived, true);
  assert.equal(rows.find((item) => item.id === itemId)?.onHandPacks, 3);
  assert.equal(suppliersFromEvents(SEED_SUPPLIERS, archived).some((supplier) => supplier.id === supplierId), false);
  assert.equal(suppliersFromEvents(SEED_SUPPLIERS, archived, true).some((supplier) => supplier.id === supplierId), true);

  const restored = inventoryFromEvents(SEED_INVENTORY, [
    ...archived,
    { ...base, id: 'item-restored', type: 'stock.item_restored' as const, itemId },
  ]);
  assert.equal(restored.find((item) => item.id === itemId)?.archived, false);
  assert.equal(restored.find((item) => item.id === itemId)?.onHandPacks, 3);
  assert.equal(suppliersFromEvents(SEED_SUPPLIERS, [
    ...archived,
    { ...base, id: 'supplier-restored', type: 'stock.supplier_restored' as const, supplierId },
  ]).some((supplier) => supplier.id === supplierId), true);
});

test('only managers and owners may change stock', () => {
  assert.equal(mayRecord('cashier', 'stock.adjusted'), false);
  assert.equal(mayRecord('kitchen', 'stock.price_set'), false);
  assert.equal(mayRecord('cashier', 'stock.item_added'), false);
  assert.equal(mayRecord('cashier', 'stock.supplier_added'), false);
  assert.equal(mayRecord('cashier', 'stock.item_archived'), false);
  assert.equal(mayRecord('cashier', 'stock.supplier_archived'), false);
  assert.equal(mayRecord('manager', 'stock.adjusted'), true);
  assert.equal(mayRecord('manager', 'stock.item_added'), true);
  assert.equal(mayRecord('manager', 'stock.supplier_added'), true);
  assert.equal(mayRecord('owner', 'stock.price_set'), true);
  assert.equal(mayRecord('manager', 'stock.item_archived'), true);
  assert.equal(mayRecord('owner', 'stock.supplier_archived'), true);
});

test('T17: no made-up supplier phone numbers: a number is added by the manager, or comes from the owner', () => {
  assert.equal(SEED_SUPPLIERS.length, 18);
  assert.ok(SEED_SUPPLIERS.every((s) => s.phone === undefined));
});

test('T18: out = nothing left (even a part-pack is stock); low = the reorder rule says to order it', () => {
  const row = (onHandBaseUnits: number) => {
    const [r] = inventoryFromEvents([SEED_INVENTORY[0]], []);
    return { ...r, onHandBaseUnits, onHandPacks: Math.max(0, onHandBaseUnits) / r.packQty };
  };
  const pack = SEED_INVENTORY[0].packQty;
  assert.equal(isOutOfStock(row(0)), true);
  assert.equal(isOutOfStock(row(-50)), true, 'sold more than was recorded');
  assert.equal(isOutOfStock(row(pack * 0.1)), false, 'a part-pack still cooks');
  assert.equal(isLowStock({ suggestedPacks: 2 }), true);
  assert.equal(isLowStock({ suggestedPacks: 0 }), false);
  assert.equal(row(pack * 0.9).onHandPacks, 0.9, 'packs are not rounded down');
});

test('T19: validateSeed handles optional phone property', () => {
  // Valid with phone
  assert.equal(validateSeed({ suppliers: SEED_SUPPLIERS, items: SEED_INVENTORY }).length, 0);

  // Valid without phone (optional)
  const supplierWithoutPhone = { id: 'sup_test', name: 'Test Supplier' };
  assert.equal(
    validateSeed({
      suppliers: [supplierWithoutPhone],
      items: [{ ...SEED_INVENTORY[0], supplierIds: ['sup_test'] }],
    }).length,
    0,
  );

  // Invalid with blank phone
  const supplierWithBlankPhone = { id: 'sup_blank', name: 'Blank Phone Supplier', phone: '   ' };
  const errors = validateSeed({
    suppliers: [supplierWithBlankPhone],
    items: [{ ...SEED_INVENTORY[0], supplierIds: ['sup_blank'] }],
  });
  assert.ok(errors.some((e) => e.includes('invalid phone')));
});

const MOZZ = 'inv-0006'; // 2 kg block
// A test recipe only (the shop's real ones are in stockUsage.test.ts): sauce, and cheese by size.
const testUsage: UsageOf = (line) => line.itemId !== 'margherita' ? [] : [
  { inventoryId: 'inv-0009', qtyBaseUnits: 45 * line.qty },
  { inventoryId: MOZZ, qtyBaseUnits: (line.size === 'L' ? 150 : 90) * line.qty },
];
const TEST_RECIPES = { usageOf: testUsage };
const actor = { id: 'm', name: 'Ravi', role: 'manager' as const };
const at = 100;
const stockIn = (id: string, packs: number) =>
  ({ id: `in-${id}`, shopId: 's', at, orderNumber: 0 as const, actor, type: 'stock.adjusted' as const, itemId: id, deltaPacks: packs });
const pizza = (id: string, size: 'M' | 'L', qty = 1) => ({ id, itemId: 'margherita', qty, size, adds: [], outs: [] });
const sent = (id: string, ticketId: string, lines: ReturnType<typeof pizza>[]) =>
  ({ id, shopId: 's', at, orderNumber: 7, actor, type: 'order.sent' as const, ticketId, addOn: false, lines });
const audited = { shopId: 's', at, orderNumber: 7, actor, totalBefore: 0, totalAfter: 0 };
const mozz = (events: Parameters<typeof inventoryFromEvents>[1]) =>
  inventoryFromEvents(SEED_INVENTORY, events, TEST_RECIPES).find((r) => r.id === MOZZ)!.onHandBaseUnits;

test('T20: a sent line takes its recipe from stock: per size, times the quantity', () => {
  assert.equal(mozz([stockIn(MOZZ, 1), sent('s1', 't1', [pizza('l1', 'M', 2), pizza('l2', 'L')])]), 2000 - 2 * 90 - 150);
});

test('T21: Undo after Send gives back exactly what that ticket took', () => {
  assert.equal(mozz([
    stockIn(MOZZ, 1),
    sent('s1', 't1', [pizza('l1', 'M')]),
    sent('s2', 't2', [pizza('l2', 'L')]),
    { id: 'u', shopId: 's', at, orderNumber: 7, actor, type: 'order.send_undone', ticketId: 't2' },
  ]), 2000 - 90);
});

test('T22: a cancelled sent line gives back; a manager Undo of the cancel takes it again', () => {
  const cancel = { ...audited, id: 'c1', type: 'order.item_cancelled' as const, lineId: 'l1', index: 0, before: pizza('l1', 'M'), reason: 'dropped' };
  const events = [stockIn(MOZZ, 1), sent('s1', 't1', [pizza('l1', 'M')]), cancel];
  assert.equal(mozz(events), 2000);
  assert.equal(mozz([...events, { ...audited, id: 'u1', type: 'order.change_undone', undoneEventId: 'c1', undoneType: 'order.item_cancelled' }]), 2000 - 90);
});

test('T23: a changed sent line swaps its recipe; Undo of the change swaps it back', () => {
  const change = { ...audited, id: 'ch', type: 'order.item_changed' as const, lineId: 'l1', before: pizza('l1', 'M'), after: pizza('l1', 'L'), reason: 'wanted large' };
  const events = [stockIn(MOZZ, 1), sent('s1', 't1', [pizza('l1', 'M')]), change];
  assert.equal(mozz(events), 2000 - 150);
  assert.equal(mozz([...events, { ...audited, id: 'u', type: 'order.change_undone', undoneEventId: 'ch', undoneType: 'order.item_changed' }]), 2000 - 90);
});

test('T24: lines never sent take nothing: removing or changing them leaves stock alone', () => {
  assert.equal(mozz([
    stockIn(MOZZ, 1),
    { ...audited, id: 'rm', type: 'order.line_removed', lineId: 'x', index: 0, before: pizza('x', 'L') },
    { ...audited, id: 'ch', type: 'order.item_changed', lineId: 'y', before: pizza('y', 'M'), after: pizza('y', 'L'), reason: '' },
  ]), 2000);
});

test('T25: selling more than was recorded goes below zero exactly, shows as none left, and a delivery adds up', () => {
  const events = [sent('s1', 't1', [pizza('l1', 'L')])];
  const [row] = inventoryFromEvents(SEED_INVENTORY, events, TEST_RECIPES).filter((r) => r.id === MOZZ);
  assert.equal(row.onHandBaseUnits, -150);
  assert.equal(row.onHandPacks, 0);
  assert.equal(isOutOfStock(row), true);
  assert.equal(mozz([...events, stockIn(MOZZ, 1)]), 2000 - 150);
});

test('T26: a batch he has not confirmed takes nothing: no made-up amounts', () => {
  // His Margherita uses the Mozzarella Blend, whose batch output he has not confirmed yet.
  assert.equal(inventoryFromEvents(SEED_INVENTORY, [stockIn(MOZZ, 1), sent('s1', 't1', [pizza('l1', 'L')])])
    .find((r) => r.id === MOZZ)!.onHandBaseUnits, 2000);
});

test('T27: packs are typed as plain numbers; a count records only the difference, exactly', () => {
  assert.equal(parsePacks('2'), 2);
  assert.equal(parsePacks(' 1.5 '), 1.5);
  assert.equal(parsePacks('0'), 0);
  for (const bad of ['', '-1', 'two', '1,5', '1.2345']) assert.equal(parsePacks(bad), null, bad);

  const row = { onHandBaseUnits: 1730, packQty: 2000 }; // the app expects 0.865 of a block
  assert.equal(countDifference(row, 1), 270 / 2000, 'more on the shelf than expected');
  assert.equal(countDifference(row, 0.5), -730 / 2000, 'less than expected');
  const counted = mozz([stockIn(MOZZ, 1), sent('s1', 't1', [pizza('l1', 'L')]),
    { ...stockIn(MOZZ, countDifference({ onHandBaseUnits: 1850, packQty: 2000 }, 0.5)), id: 'count' }]);
  assert.equal(counted, 1000, 'after a count the stock is what was counted');
});

test('stock movements: GRN in, GRN_UNDO out, COUNT_ADJUST either way; the shelf is their sum; old adjustments still count', () => {
  const actor = { id: 'm', name: 'Ravi', role: 'manager' as const };
  const base = { shopId: 's', orderNumber: 0 as const, actor, at: 1 };
  const flour = SEED_INVENTORY[0].id;
  const move = (id: string, kind: 'GRN' | 'GRN_UNDO' | 'COUNT_ADJUST', qtyBase: number) =>
    ({ ...base, id, type: 'stock.movement' as const, itemId: flour, kind, qtyBase, docId: 'doc' });
  const row = (events: Parameters<typeof inventoryFromEvents>[1]) => inventoryFromEvents(SEED_INVENTORY, events).find((r) => r.id === flour)!;

  assert.equal(row([move('a', 'GRN', 50000), move('b', 'GRN_UNDO', -50000)]).onHandBaseUnits, 0, 'an undone GRN leaves exactly nothing');
  const mixed = row([{ ...base, id: 'old', type: 'stock.adjusted', itemId: flour, deltaPacks: 1 }, move('a', 'GRN', 25000), move('c', 'COUNT_ADJUST', -5000)]);
  assert.equal(mixed.onHandBaseUnits, 45000);
  assert.equal(mixed.counted, true);
  assert.equal(row([move('c', 'COUNT_ADJUST', 100)]).lastCountedAt, 1, 'a count adjustment is a count');
  assert.equal(row([move('a', 'GRN', 100)]).lastCountedAt, null, 'a delivery is not');
  assert.equal(inventoryFromEvents(SEED_INVENTORY, [{ ...move('z', 'GRN', 5), itemId: 'gone' }]).length, SEED_INVENTORY.length);
});

test('a GRN is its own stock movement: what it accepted goes in, its undo takes exactly that off; older notes add nothing here', () => {
  const actor = { id: 'm', name: 'Ravi', role: 'manager' as const };
  const base = { shopId: 's', orderNumber: 0 as const, actor, at: 1 };
  const flour = SEED_INVENTORY[0].id; // 25 kg packs
  const grn = (id: string, lines: { itemId: string; ordered: number; received: number; accepted?: number }[]) =>
    ({ ...base, id, type: 'stock.grn' as const, grnNo: id, orderId: 'po', supplierId: 's', lines, approvedBy: null });
  const row = (events: Parameters<typeof inventoryFromEvents>[1]) => inventoryFromEvents(SEED_INVENTORY, events).find((r) => r.id === flour)!;

  const got = row([grn('g1', [{ itemId: flour, ordered: 3, received: 3, accepted: 2 }])]);
  assert.equal(got.onHandBaseUnits, 2 * SEED_INVENTORY[0].packQty, 'accepted, not received (1 pack was returned)');
  assert.equal(got.counted, true, 'received counts as known');
  const undone = row([grn('g1', [{ itemId: flour, ordered: 2, received: 2, accepted: 2 }]), { ...base, id: 'u', type: 'stock.grn_undone', grnId: 'g1', reason: 'Entered by mistake', approvedBy: actor }]);
  assert.equal(undone.onHandBaseUnits, 0, 'exactly what that GRN added');
  assert.equal(undone.counted, true);
  assert.equal(row([grn('old', [{ itemId: flour, ordered: 2, received: 2 }])]).onHandBaseUnits, 0, 'a note from before has no accepted: its stock was separate movements');
  assert.equal(row([{ ...base, id: 'u2', type: 'stock.grn_undone', grnId: 'nope', reason: 'x', approvedBy: actor }]).onHandBaseUnits, 0);
});
