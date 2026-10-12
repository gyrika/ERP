import test from 'node:test';
import assert from 'node:assert/strict';
import { SEED_INVENTORY, SEED_SUPPLIERS } from './inventoryData.ts';
import { itemById, loadSeed, supplierById, validateSeed } from './inventory.ts';
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
