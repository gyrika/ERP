import test from 'node:test';
import assert from 'node:assert/strict';
import { SEED_INVENTORY, SEED_SUPPLIERS } from './inventoryData.ts';
import { inventoryFromEvents, isLowStock, isOutOfStock, itemById, loadSeed, supplierById, validateSeed } from './inventory.ts';
import { mayRecord } from './auth.ts';
import { storageKey } from '../ui/storage.ts';

test('T1: suppliers have unique ids', () => {
  assert.equal(new Set(SEED_SUPPLIERS.map((s) => s.id)).size, SEED_SUPPLIERS.length);
});

test('T2: items have unique ids', () => {
  assert.equal(new Set(SEED_INVENTORY.map((i) => i.id)).size, SEED_INVENTORY.length);
});

test('T3: every mainSupplierId resolves', () => {
  for (const item of SEED_INVENTORY) {
    assert.ok(supplierById(item.mainSupplierId), `${item.id}: main ${item.mainSupplierId}`);
  }
});

test('T4: nullable backup suppliers are handled', () => {
  assert.ok(SEED_INVENTORY.some((i) => i.backupSupplierId === null));
  for (const item of SEED_INVENTORY) {
    if (item.backupSupplierId === null) continue;
    assert.ok(supplierById(item.backupSupplierId), `${item.id}: backup ${item.backupSupplierId}`);
  }
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
    assert.ok(i.mainSupplierId.trim());
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

test('stock is built from events: counts never below zero, last price wins, unknown items ignored', () => {
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
  assert.equal(row.onHandPacks, 2, '3 in, 5 out (floored at 0), 2 in');
  assert.equal(row.workingPriceCents, 650000);
  assert.equal(rows.length, SEED_INVENTORY.length);
  assert.ok(rows.filter((r) => r.id !== flour).every((r) => r.onHandPacks === 0));
});

test('only managers and owners may change stock', () => {
  assert.equal(mayRecord('cashier', 'stock.adjusted'), false);
  assert.equal(mayRecord('kitchen', 'stock.price_set'), false);
  assert.equal(mayRecord('manager', 'stock.adjusted'), true);
  assert.equal(mayRecord('owner', 'stock.price_set'), true);
});

test('T17: all 18 suppliers have realistic Sri Lankan phone numbers', () => {
  assert.equal(SEED_SUPPLIERS.length, 18);
  for (const s of SEED_SUPPLIERS) {
    assert.ok(s.phone, `${s.id}: missing phone`);
    assert.match(s.phone, /^\+947\d{8}$/, `${s.id}: phone ${s.phone} is not valid Sri Lankan mobile`);
  }
});

test('T18: isOutOfStock and isLowStock helper checks', () => {
  const item = SEED_INVENTORY[0];
  const outOfStockRow = { ...item, onHandPacks: 0 };
  const onePackRow = { ...item, onHandPacks: 1 };
  const twoPacksRow = { ...item, onHandPacks: 2 };

  assert.equal(isOutOfStock(outOfStockRow), true);
  assert.equal(isLowStock(outOfStockRow), true);

  assert.equal(isOutOfStock(onePackRow), false);
  assert.equal(isLowStock(onePackRow), true);

  assert.equal(isOutOfStock(twoPacksRow), false);
  assert.equal(isLowStock(twoPacksRow), false);
});

test('T19: validateSeed handles optional phone property', () => {
  // Valid with phone
  assert.equal(validateSeed({ suppliers: SEED_SUPPLIERS, items: SEED_INVENTORY }).length, 0);

  // Valid without phone (optional)
  const supplierWithoutPhone = { id: 'sup_test', name: 'Test Supplier' };
  assert.equal(
    validateSeed({
      suppliers: [supplierWithoutPhone],
      items: [{ ...SEED_INVENTORY[0], mainSupplierId: 'sup_test', backupSupplierId: null }],
    }).length,
    0,
  );

  // Invalid with blank phone
  const supplierWithBlankPhone = { id: 'sup_blank', name: 'Blank Phone Supplier', phone: '   ' };
  const errors = validateSeed({
    suppliers: [supplierWithBlankPhone],
    items: [{ ...SEED_INVENTORY[0], mainSupplierId: 'sup_blank', backupSupplierId: null }],
  });
  assert.ok(errors.some((e) => e.includes('invalid phone')));
});

