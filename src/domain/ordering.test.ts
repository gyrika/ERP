import test from 'node:test';
import assert from 'node:assert/strict';
import { cartOf, cartsOf, draftsOf, orderMessage, suggestions, whatsAppLink, whatsAppNumber, type SuggestRow } from './ordering.ts';

// Ordering from a supplier (SCRUM-92).

test('the message lists each item with its pack size, and leaves out zeros', () => {
  assert.equal(orderMessage([
    { name: 'Mozzarella (Prabhat)', packs: 2, packQty: 2000, baseUnit: 'g' },
    { name: 'Oregano', packs: 0, packQty: 100, baseUnit: 'g' },
    { name: 'Eggs', packs: 1, packQty: 30, baseUnit: 'pcs' },
  ]), 'Hi, this is CheesyBeez. Please send:\n2 × Mozzarella (Prabhat) (2 kg packs)\n1 × Eggs (30 pcs pack)\nThank you.');
});

test('WhatsApp gets the country code and the message', () => {
  assert.equal(whatsAppNumber('077 123 4567'), '94771234567');
  assert.equal(whatsAppNumber('+94 77 123 4567'), '94771234567');
  assert.equal(whatsAppLink('0771234567', 'Hi & bye'), 'https://wa.me/94771234567?text=Hi%20%26%20bye');
});

// The reorder rule (`suggestions`): when and how much.

const S = { defaultLeadDays: 3, spareDays: 2, orderDays: 7 };
const row = (onHandBaseUnits: number, usedPerDay = 1000, extra: Partial<SuggestRow> = {}): SuggestRow =>
  ({ id: 'flour', counted: true, archived: false, usedPerDay, onHandBaseUnits, packQty: 2000, supplierIds: ['a'], ...extra });
const ask = (r: SuggestRow, onOrder = 0, lead?: number, last: [string, string][] = []) =>
  suggestions([r], new Set(['a', 'b']), new Map(onOrder ? [['flour', onOrder]] : []), new Map(lead === undefined ? [] : [['a', lead]]), new Map(last), S);

test('suggested when on hand + on order <= use × (delivery time + 2 spare days); the delivery time defaults to 3', () => {
  assert.equal(ask(row(5000)).length, 1, '5 kg = the reorder point (1 kg × (3 + 2)): suggested');
  assert.equal(ask(row(5001)).length, 0, 'one gram more: not yet');
  assert.equal(ask(row(7000), 0, 5).length, 1, 'a slow supplier (5 days): order sooner');
  assert.equal(ask(row(7000), 0, 1).length, 0, 'a fast one (1 day): later');
});

test('how much: use × (delivery time + 7) less what is in hand and on order, rounded UP to whole packs', () => {
  // 1 kg a day, 3 days, 7 days: 10 kg wanted; 3 kg in hand = 7 kg = 3.5 packs of 2 kg -> 4
  assert.deepEqual(ask(row(3000)), [{ itemId: 'flour', supplierId: 'a', packs: 4, stockQty: 8000 }]);
  assert.equal(ask(row(4000))[0].packs, 3, '6 kg = exactly 3 packs');
  assert.equal(ask(row(0))[0].packs, 5, 'an empty shelf wants 10 kg');
  assert.equal(ask(row(-300))[0].packs, 5, 'below zero counts as empty');
});

test('what is already on order counts, so the item leaves the list and never gets a double order', () => {
  assert.equal(ask(row(3000), 4).length, 0, '4 packs coming = 8 kg more: plenty');
  assert.equal(ask(row(0), 1)[0].packs, 4, '1 pack coming: 8 kg still wanted');
});

test('never 0 or negative packs; items with no use, never counted, archived or with no supplier are skipped', () => {
  assert.ok(ask(row(0)).every((s) => s.packs >= 1));
  assert.equal(ask(row(0, 0)).length, 0, 'no use: skipped, even empty');
  assert.equal(ask(row(0, 1000, { counted: false })).length, 0);
  assert.equal(ask(row(0, 1000, { archived: true })).length, 0);
  assert.equal(ask(row(0, 1000, { supplierIds: ['gone'] })).length, 0);
});

test('the supplier is the one it last came from, else its first active one', () => {
  const two = row(0, 1000, { supplierIds: ['gone', 'a', 'b'] });
  assert.equal(ask(two)[0].supplierId, 'a');
  assert.equal(ask(two, 0, undefined, [['flour', 'b']])[0].supplierId, 'b');
  assert.equal(ask(two, 0, undefined, [['flour', 'gone']])[0].supplierId, 'a', 'a supplier that is gone is not used');
});

test('drafts group the suggestions by supplier', () => {
  const drafts = draftsOf([
    { id: 'x', suggestedPacks: 2, suggestedSupplierId: 'a' }, { id: 'y', suggestedPacks: 1, suggestedSupplierId: 'a' },
    { id: 'z', suggestedPacks: 3, suggestedSupplierId: 'b' }, { id: 'w', suggestedPacks: 0, suggestedSupplierId: 'b' },
  ]);
  assert.deepEqual([...drafts], [['a', { x: 2, y: 1 }], ['b', { z: 3 }]]);
});

test("carts: a saved cart as saved; else the suggestions, less what sits in another supplier's cart", () => {
  const suggested = new Map<string, Record<string, number>>([['a', { x: 2, y: 1 }], ['b', { z: 3 }]]);
  // x was moved to b's cart: a's suggestions no longer hold it.
  const carts = cartsOf(suggested, new Map([['b', { z: 3, x: 2 }]]));
  assert.deepEqual([...carts], [['a', { y: 1 }], ['b', { z: 3, x: 2 }]]);
  assert.equal(cartOf(carts, 'x'), 'b');
  assert.equal(cartOf(carts, 'nothing'), null);
  // Everything a supplier was suggested sits elsewhere: it has no cart.
  assert.deepEqual([...cartsOf(new Map([['a', { x: 2 }]]), new Map([['b', { x: 2 }]]))], [['b', { x: 2 }]]);
  // A saved cart wins over the suggestions; an emptied one (no saved cart) falls back to them.
  assert.deepEqual(cartsOf(suggested, new Map([['a', { y: 4 }]])).get('a'), { y: 4 });
  assert.deepEqual(cartsOf(suggested, new Map()).get('a'), { x: 2, y: 1 });
});
