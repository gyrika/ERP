import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePush } from './validate.ts';

const base = {
  id: 'event-1',
  shopId: 'shop-1',
  at: 1,
  orderNumber: 0,
  actor: { id: 'manager-1', name: 'Ravi', role: 'manager' },
};

test('valid ingredient and supplier creation events pass sync validation', () => {
  const events = [
    {
      ...base,
      type: 'stock.item_added',
      item: {
        id: 'inv-new',
        name: 'Sea Salt',
        category: 'General',
        baseUnit: 'pcs',
        packQty: 1,
        supplierIds: ['sup-new'],
        workingPriceCents: 0,
      },
    },
    {
      ...base,
      id: 'event-2',
      type: 'stock.supplier_added',
      supplier: { id: 'sup-new', name: 'Fresh Farms' },
      linkedItemIds: ['inv-0001'],
    },
  ];

  assert.deepEqual(validatePush({ deviceId: 'device-1', events }, 'shop-1'), { events });
});

test('valid ingredient and supplier archive and restore events pass sync validation', () => {
  const events = [
    { ...base, type: 'stock.item_archived', itemId: 'inv-0001' },
    { ...base, id: 'event-2', type: 'stock.item_restored', itemId: 'inv-0001' },
    { ...base, id: 'event-3', type: 'stock.supplier_archived', supplierId: 'sup-prima' },
    { ...base, id: 'event-4', type: 'stock.supplier_restored', supplierId: 'sup-prima' },
  ];
  assert.deepEqual(validatePush({ deviceId: 'device-1', events }, 'shop-1'), { events });

  const invalidItem = validatePush({
    deviceId: 'device-1',
    events: [{ ...base, type: 'stock.item_archived' }],
  }, 'shop-1');
  assert.ok('reason' in invalidItem);
  if ('reason' in invalidItem) assert.match(invalidItem.reason, /invalid ingredient id/);

  const invalidSupplier = validatePush({
    deviceId: 'device-1',
    events: [{ ...base, type: 'stock.supplier_archived' }],
  }, 'shop-1');
  assert.ok('reason' in invalidSupplier);
  if ('reason' in invalidSupplier) assert.match(invalidSupplier.reason, /invalid supplier id/);
});

test('invalid ingredient and supplier creation payloads are refused', () => {
  const invalidIngredient = {
    ...base,
    type: 'stock.item_added',
    item: {
      id: 'inv-new',
      name: 'Sea Salt',
      category: 'General',
      baseUnit: 'pcs',
      packQty: 1,
      supplierIds: [],
      workingPriceCents: 0,
    },
  };
  const invalidSupplier = {
    ...base,
    type: 'stock.supplier_added',
    supplier: { id: 'sup-new', name: 'Fresh Farms' },
    linkedItemIds: ['inv-1', 'inv-1'],
  };

  const ingredientResult = validatePush({ deviceId: 'device-1', events: [invalidIngredient] }, 'shop-1');
  assert.ok('reason' in ingredientResult);
  if ('reason' in ingredientResult) assert.match(ingredientResult.reason, /invalid ingredient/);
  const result = validatePush({ deviceId: 'device-1', events: [invalidSupplier] }, 'shop-1');
  assert.ok('reason' in result);
  if ('reason' in result) assert.match(result.reason, /invalid supplier/);
});

test('menu edits and sold-out events are accepted only with valid event data', () => {
  const owner = { ...base, actor: { id: 'owner-1', name: 'Nisal', role: 'owner' } };
  const valid = [
    {
      ...owner,
      type: 'menu.item_set',
      itemId: 'margherita',
      before: {},
      after: { prices: { M: 160000 }, name: { en: 'Margherita Special' } },
    },
    {
      ...owner,
      id: 'event-2',
      type: 'menu.sold_out',
      itemId: 'margherita',
      until: 1_800_000_000_000,
    },
  ];
  assert.deepEqual(validatePush({ events: valid }, 'shop-1'), { events: valid });

  const unknownItem = validatePush({
    events: [{ ...owner, type: 'menu.item_set', itemId: 'not-on-menu', before: {}, after: {} }],
  }, 'shop-1');
  assert.ok('reason' in unknownItem);

  const invalidPrice = validatePush({
    events: [{ ...owner, type: 'menu.item_set', itemId: 'margherita', before: {}, after: { prices: { M: 160001 } } }],
  }, 'shop-1');
  assert.ok('reason' in invalidPrice);

  const invalidSoldOut = validatePush({
    events: [{ ...owner, type: 'menu.sold_out', itemId: 'margherita', until: 'tomorrow' }],
  }, 'shop-1');
  assert.ok('reason' in invalidSoldOut);
});
