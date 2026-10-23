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

test("the owner's new items are accepted only with an added-item id and a full, whole-rupee price list", () => {
  const owner = { ...base, actor: { id: 'owner-1', name: 'Nisal', role: 'owner' } };
  const item = { category: 'pasta', name: { en: 'Chicken Alfredo', si: '' }, description: '', prices: { S: 110000, M: 210000, L: 290000 } };
  const valid = [
    { ...owner, type: 'menu.item_added', itemId: 'new-chicken-alfredo', item },
    { ...owner, id: 'event-2', type: 'menu.item_set', itemId: 'new-chicken-alfredo', before: {}, after: { prices: { L: 300000 }, hidden: true } },
    { ...owner, id: 'event-3', type: 'menu.sold_out', itemId: 'new-chicken-alfredo', until: 1_800_000_000_000 },
    { ...owner, id: 'event-4', type: 'menu.item_added', itemId: 'new-chicken-alfredo', item: null },
  ];
  assert.deepEqual(validatePush({ events: valid }, 'shop-1'), { events: valid });

  for (const bad of [
    { itemId: 'margherita', item },
    { itemId: 'new-Chicken', item },
    { itemId: 'new-x', item: { ...item, prices: { S: 110000 } } },
    { itemId: 'new-x', item: { ...item, prices: { S: 110000, M: 210000, L: '290000' } } },
    { itemId: 'new-x', item: { ...item, category: 'drinks' } },
    { itemId: 'new-x', item: { ...item, name: { en: 'X', fr: 'Y' } } },
    { itemId: 'new-x', item: { ...item, extra: true } },
  ]) {
    const r = validatePush({ events: [{ ...owner, type: 'menu.item_added', ...bad }] }, 'shop-1');
    assert.ok('reason' in r, JSON.stringify(bad));
  }
  const notAdded = validatePush({ events: [{ ...owner, type: 'menu.sold_out', itemId: 'not-on-menu', until: null }] }, 'shop-1');
  assert.ok('reason' in notAdded);
});

test("the owner's own recipe and opening his recipes pass; a malformed recipe does not", () => {
  const owner = { ...base, actor: { id: 'owner-1', name: 'Owner', role: 'owner' } };
  const recipe = { kind: 'own', lines: [{ name: 'stock:inv-0016', qty: 2, unit: 'pcs' }] };
  const valid = [
    { ...owner, type: 'recipe.answer_set', question: 'recipe:sausages:M', before: null, after: recipe },
    { ...owner, id: 'event-2', type: 'recipe.answer_set', question: 'addon:chicken', before: null, after: recipe },
    { ...owner, id: 'event-3', type: 'recipe.viewed' },
  ];
  assert.deepEqual(validatePush({ events: valid }, 'shop-1'), { events: valid });
  const bad = { kind: 'own', lines: [{ name: 'stock:inv-0016', qty: -2, unit: 'pcs' }] };
  assert.ok('reason' in validatePush({ events: [{ ...owner, type: 'recipe.answer_set', question: 'recipe:sausages:M', before: null, after: bad }] }, 'shop-1'));
  assert.ok('reason' in validatePush({ events: [{ ...owner, type: 'recipe.viewed', orderNumber: 4 }] }, 'shop-1'));
});

test('purchase orders and GRNs: a GRN that differs from its order needs a manager', () => {
  const ordered = { ...base, type: 'stock.ordered', poNo: 'PO-0001', supplierId: 'sup', lines: [{ itemId: 'inv-1', packs: 2 }] };
  const grn = { ...base, id: 'event-2', type: 'stock.grn', grnNo: 'GRN-0001', orderId: 'event-1', supplierId: 'sup', lines: [{ itemId: 'inv-1', ordered: 2, received: 2 }], approvedBy: null };
  assert.ok('events' in validatePush({ events: [ordered, grn] }, 'shop-1'));

  const short = { ...grn, lines: [{ itemId: 'inv-1', ordered: 2, received: 1 }] };
  assert.match((validatePush({ events: [short] }, 'shop-1') as { reason: string }).reason, /without a manager's approval/);
  assert.ok('events' in validatePush({ events: [{ ...short, approvedBy: base.actor }] }, 'shop-1'));
  const byCashier = { ...short, approvedBy: { id: 'c', name: 'Nimal', role: 'cashier' } };
  assert.match((validatePush({ events: [byCashier] }, 'shop-1') as { reason: string }).reason, /invalid goods received note/);
  assert.match((validatePush({ events: [{ ...ordered, lines: [] }] }, 'shop-1') as { reason: string }).reason, /invalid purchase order/);
});

test('a stock setting is checked on the server too', () => {
  const ok = { ...base, actor: { id: 'o', name: 'Owner', role: 'owner' }, type: 'stock.settings_set', key: 'usageDays', value: 21 };
  assert.ok('events' in validatePush({ events: [ok] }, 'shop-1'));
  assert.match((validatePush({ events: [{ ...ok, value: 0 }] }, 'shop-1') as { reason: string }).reason, /invalid setting: Type a number from 1 to 90/);
});

test('stock movements: the kind decides the sign; nothing else passes', () => {
  const mv = { ...base, type: 'stock.movement', itemId: 'inv-1', kind: 'GRN', qtyBase: 50000, docId: 'event-9' };
  assert.ok('events' in validatePush({ events: [mv, { ...mv, id: 'e2', kind: 'GRN_UNDO', qtyBase: -50000 }, { ...mv, id: 'e3', kind: 'COUNT_ADJUST', qtyBase: -3 }] }, 'shop-1'));
  for (const bad of [{ kind: 'GRN', qtyBase: -1 }, { kind: 'GRN_UNDO', qtyBase: 1 }, { kind: 'SALE', qtyBase: 1 }, { kind: 'GRN', qtyBase: 0 }, { kind: 'GRN', qtyBase: 'x' }]) {
    assert.match((validatePush({ events: [{ ...mv, ...bad }] }, 'shop-1') as { reason: string }).reason, /invalid stock movement/);
  }
});

test('order changes: edits need lines, a cancel needs a reason, a GRN decision is wait or close', () => {
  const edited = { ...base, type: 'stock.order_edited', orderId: 'event-1', lines: [{ itemId: 'inv-1', packs: 2, stockQty: 50000 }] };
  assert.ok('events' in validatePush({ events: [edited] }, 'shop-1'));
  assert.match((validatePush({ events: [{ ...edited, lines: [] }] }, 'shop-1') as { reason: string }).reason, /invalid order change/);
  assert.match((validatePush({ events: [{ ...edited, lines: [{ itemId: 'inv-1', packs: 2, stockQty: -1 }] }] }, 'shop-1') as { reason: string }).reason, /invalid order change/);
  const cancelled = { ...base, type: 'stock.order_cancelled', orderId: 'event-1', reason: 'Ordered by mistake' };
  assert.ok('events' in validatePush({ events: [cancelled] }, 'shop-1'));
  assert.match((validatePush({ events: [{ ...cancelled, reason: '' }] }, 'shop-1') as { reason: string }).reason, /without saying why/);
  const { reason: _r, ...noReason } = cancelled;
  assert.match((validatePush({ events: [noReason] }, 'shop-1') as { reason: string }).reason, /without saying why/);
  const grn = { ...base, type: 'stock.grn', grnNo: 'GRN-0001', orderId: 'event-1', supplierId: 'sup', lines: [{ itemId: 'inv-1', ordered: 2, received: 2 }], approvedBy: null };
  assert.ok('events' in validatePush({ events: [{ ...grn, shortDecision: 'wait' }] }, 'shop-1'));
  assert.match((validatePush({ events: [{ ...grn, shortDecision: 'later' }] }, 'shop-1') as { reason: string }).reason, /invalid goods received note/);
});
