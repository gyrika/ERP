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
  // His version of a sheet batch: its lines are his stock or what his kitchen makes, never itself.
  const batch = { kind: 'batch', makes: { qty: 2000, unit: 'g' }, lines: [{ name: 'Mozzarella A', qty: 1500, unit: 'g' }] };
  const edit = { ...owner, type: 'recipe.answer_set', question: 'batch:Mozzarella Blend', before: null, after: batch };
  assert.deepEqual(validatePush({ events: [edit] }, 'shop-1'), { events: [edit] });
  const inside = { ...batch, lines: [{ name: 'Mozzarella Blend', qty: 5, unit: 'g' }] };
  assert.ok('reason' in validatePush({ events: [{ ...edit, after: inside }] }, 'shop-1'));
});

test('purchase orders and GRNs: a GRN that differs from its order needs a manager and the decisions', () => {
  const ordered = { ...base, type: 'stock.ordered', poNo: 'PO-0001', supplierId: 'sup', lines: [{ itemId: 'inv-1', packs: 2 }] };
  const line = (received: number, accepted = received) => [{ itemId: 'inv-1', ordered: 2, received, accepted, returned: received - accepted }];
  const grn = { ...base, id: 'event-2', type: 'stock.grn', grnNo: 'GRN-0001', orderId: 'event-1', supplierId: 'sup', lines: line(2), approvedBy: null };
  const reason = (e: unknown) => (validatePush({ events: [e] }, 'shop-1') as { reason: string }).reason;
  assert.ok('events' in validatePush({ events: [ordered, grn] }, 'shop-1'));

  const short = { ...grn, lines: line(1) };
  assert.match(reason(short), /without a manager's approval/);
  assert.match(reason({ ...short, approvedBy: base.actor }), /short but does not say wait or close/);
  assert.ok('events' in validatePush({ events: [{ ...short, approvedBy: base.actor, shortDecision: 'wait' }] }, 'shop-1'));
  // The approving manager's final note: optional, plain text, at most 500 characters.
  assert.ok('events' in validatePush({ events: [{ ...short, approvedBy: base.actor, shortDecision: 'wait', note: 'The rest comes on Monday' }] }, 'shop-1'));
  assert.match(reason({ ...short, approvedBy: base.actor, shortDecision: 'wait', note: 'x'.repeat(501) }), /invalid goods received note/);
  assert.match(reason({ ...short, approvedBy: base.actor, shortDecision: 'wait', note: 42 }), /invalid goods received note/);
  assert.match(reason({ ...short, approvedBy: { id: 'c', name: 'Nimal', role: 'cashier' }, shortDecision: 'close' }), /invalid goods received note/);

  const over = { ...grn, lines: line(3), approvedBy: base.actor };
  assert.match(reason(over), /extra but does not say accept or return/);
  assert.ok('events' in validatePush({ events: [{ ...over, overDecision: 'accept' }] }, 'shop-1'));
  assert.match(reason({ ...over, overDecision: 'return' }), /wrong amount into stock/, 'returning extra but taking it all into stock');
  assert.ok('events' in validatePush({ events: [{ ...over, overDecision: 'return', lines: line(3, 2) }] }, 'shop-1'));
  assert.match(reason({ ...over, overDecision: 'accept', lines: [{ itemId: 'inv-1', ordered: 2, received: 3, accepted: 5, returned: 0 }] }), /wrong amount into stock/, 'stock cannot be made up');
  assert.match(reason({ ...over, overDecision: 'accept', lines: line(3, 5) }), /invalid goods received note/);
  assert.match(reason({ ...ordered, lines: [] }), /invalid purchase order/);
  const draft = { ...base, id: 'event-3', type: 'stock.draft_set', supplierId: 'sup', lines: [{ itemId: 'inv-1', packs: 2 }] };
  assert.ok('events' in validatePush({ events: [draft, { ...draft, id: 'event-4', lines: [] }] }, 'shop-1'), 'no lines clears the draft');
  assert.match(reason({ ...draft, lines: [{ itemId: 'inv-1', packs: 0 }] }), /invalid draft order/);
  assert.match(reason({ ...draft, supplierId: '' }), /invalid draft order/);
  // A price typed for this order only rides on the draft's line; it must be a real amount.
  assert.ok('events' in validatePush({ events: [{ ...draft, id: 'event-5', lines: [{ itemId: 'inv-1', packs: 2, unitPriceCents: 655000 }] }] }, 'shop-1'));
  assert.match(reason({ ...draft, lines: [{ itemId: 'inv-1', packs: 2, unitPriceCents: -1 }] }), /invalid draft order/);
  assert.match(reason({ ...draft, lines: [{ itemId: 'inv-1', packs: 2, unitPriceCents: 'free' }] }), /invalid draft order/);
});

test('an undone GRN names a manager and a reason', () => {
  const undone = { ...base, type: 'stock.grn_undone', grnId: 'event-2', reason: 'Wrong amounts', approvedBy: base.actor };
  assert.ok('events' in validatePush({ events: [undone] }, 'shop-1'));
  const reason = (e: unknown) => (validatePush({ events: [e] }, 'shop-1') as { reason: string }).reason;
  assert.match(reason({ ...undone, reason: '' }), /without a manager or a reason/);
  assert.match(reason({ ...undone, approvedBy: undefined }), /without a manager or a reason/);
  assert.match(reason({ ...undone, approvedBy: { id: 'c', name: 'Nimal', role: 'cashier' } }), /without a manager or a reason/);
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

test('a count: Other must say what happened; the note is short', () => {
  const counted = { ...base, type: 'stock.counted', itemId: 'inv-0006', counted: 1000, expected: 2000, entries: [], reason: 'spoiled', valueCents: -260000, tier: 'daily' };
  const reason = (e: unknown) => (validatePush({ events: [e] }, 'shop-1') as { reason: string }).reason;
  assert.ok('events' in validatePush({ events: [counted, { ...counted, id: 'e2', reason: 'other', note: 'The fridge was off' }, { ...counted, id: 'e3', reason: 'wrong-entry' }] }, 'shop-1'));
  assert.match(reason({ ...counted, reason: 'other' }), /invalid count/);
  assert.match(reason({ ...counted, reason: 'other', note: '   ' }), /invalid count/);
  assert.match(reason({ ...counted, note: 'x'.repeat(201) }), /invalid count/);
  assert.ok('events' in validatePush({ events: [{ ...counted, reason: 'delivery-short' }] }, 'shop-1'), 'an older reason still reads');
});

test('a price change passes, marked with the GRN it came from or not; a bad GRN mark does not', () => {
  const price = { ...base, actor: { id: 'm', name: 'Ravi', role: 'manager' }, type: 'stock.price_set', itemId: 'inv-0001', before: 640000, after: 660000 };
  assert.deepEqual(validatePush({ events: [price] }, 'shop-1'), { events: [price] });
  const fromGrn = { ...price, grnId: 'grn-event-1' };
  assert.deepEqual(validatePush({ events: [fromGrn] }, 'shop-1'), { events: [fromGrn] });
  assert.ok('reason' in validatePush({ events: [{ ...price, grnId: 42 }] }, 'shop-1'));
});

test('a supplier edit passes sync validation; a broken one is refused', () => {
  const events = [{
    ...base, type: 'stock.supplier_edited', supplierId: 'sup-prima',
    before: { name: 'Prima' }, after: { name: 'Prima Lanka', phone: '+94 77 123 4567' },
    linked: ['inv-0001'], unlinked: [],
  }];
  assert.deepEqual(validatePush({ deviceId: 'device-1', events }, 'shop-1'), { events });

  const invalid = validatePush({ deviceId: 'device-1', events: [{ ...events[0], after: { name: '' } }] }, 'shop-1');
  assert.ok('reason' in invalid);
  if ('reason' in invalid) assert.match(invalid.reason, /invalid supplier edit/);
});

test('prep sent to the kitchen (SCRUM-136): a ticket, an item, a unit and a real amount; its Undo and "make more" amount', () => {
  const made = { ...base, type: 'prep.ordered', ticketId: 'ticket-1', prepId: 'kitchen:kdough1', name: 'Dough', qty: 20, unit: 'pcs' };
  const ok = (e: unknown) => 'events' in validatePush({ events: [e] }, 'shop-1');
  assert.ok(ok(made));
  assert.ok(!ok({ ...made, qty: 0 }));
  assert.ok(!ok({ ...made, unit: 'kg' }));
  assert.ok(!ok({ ...made, prepId: '' }));
  assert.ok(!ok({ ...made, actor: undefined }));
  assert.ok(!ok({ ...made, orderNumber: 5 }));
  assert.ok(!ok({ ...made, ticketId: '' }));
  assert.ok(ok({ ...base, type: 'prep.order_undone', ticketId: 'ticket-1' }));
  assert.ok(!ok({ ...base, type: 'prep.order_undone' }));
  assert.ok(ok({ ...base, type: 'prep.limit_set', prepId: 'Mozzarella Blend', before: null, after: 3000 }));
  assert.ok(!ok({ ...base, type: 'prep.limit_set', prepId: 'Mozzarella Blend', before: null, after: -1 }));
});

test('a shorthand miss syncs with what was typed; a malformed one is refused', () => {
  const miss = { ...base, actor: { id: 'cashier-1', name: 'Kasun', role: 'cashier' }, type: 'shorthand.missed', text: '2 l margherita, bbq chkn', unresolved: ['bbq chkn'], gaveUp: false };
  assert.ok('events' in validatePush({ events: [miss] }, 'shop-1'));
  assert.ok('reason' in validatePush({ events: [{ ...miss, unresolved: [] }] }, 'shop-1'));
  assert.ok('reason' in validatePush({ events: [{ ...miss, gaveUp: undefined }] }, 'shop-1'));
  assert.ok('reason' in validatePush({ events: [{ ...miss, orderNumber: 7 }] }, 'shop-1'));
  assert.ok('reason' in validatePush({ events: [{ ...miss, actor: undefined }] }, 'shop-1'));
});
