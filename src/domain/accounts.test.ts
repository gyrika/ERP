import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAddress, checkProfile, reorderable, sameAddress } from './accounts.ts';
import { menuItems } from './menu.ts';

test('profile: name and mobile checked like an order, either may be empty', () => {
  assert.deepEqual(checkProfile({ name: '  Kasun   P ', phone: '+94 77 123 4567' }), { name: 'Kasun P', phone: '0771234567' });
  assert.deepEqual(checkProfile({}), { name: '', phone: '' });
  assert.ok('reason' in checkProfile({ phone: '12345' }));
  assert.ok('reason' in checkProfile({ name: 'x'.repeat(41) }));
});

test('address: words required, label short, pin optional and rounded', () => {
  assert.deepEqual(checkAddress({ label: ' Home ', address: ' 12  Temple Rd ', pin: { lat: 7.123456789, lng: 79.9 } }),
    { label: 'Home', address: '12 Temple Rd', pin: { lat: 7.12346, lng: 79.9 } });
  assert.deepEqual(checkAddress({ address: 'Here' }), { label: '', address: 'Here', pin: null });
  assert.ok('reason' in checkAddress({ address: ' ' }));
  assert.ok('reason' in checkAddress({ address: 'x', label: 'y'.repeat(21) }));
  assert.ok('reason' in checkAddress({ address: 'x', pin: { lat: 200, lng: 0 } }));
  assert.ok(sameAddress('12 Temple Rd', ' 12  temple rd'));
  assert.ok(!sameAddress('12 Temple Rd', '14 Temple Rd'));
});

test('order again: only what can be ordered today', () => {
  const items = menuItems();
  const pizza = items.find((m) => m.variants && m.adds.length > 0)!;
  const plain = items.find((m) => !m.variants)!;
  const lines = [
    { itemId: pizza.id, qty: 2, size: pizza.variants![0].id, adds: [pizza.adds[0].id, 'gone-extra'], outs: [] },
    { itemId: 'gone-dish', qty: 1, adds: [], outs: [] },
    { itemId: pizza.id, qty: 1, size: 'XXL' as never, adds: [], outs: [] },
    { itemId: plain.id, qty: 99, adds: [], outs: [] },
  ];
  assert.deepEqual(reorderable(lines, items), [
    { itemId: pizza.id, qty: 2, size: pizza.variants![0].id, adds: [pizza.adds[0].id], outs: [] },
    { itemId: plain.id, qty: 20, adds: [], outs: [] },
  ]);
  const soldOut = items.map((m) => (m.id === plain.id ? { ...m, soldOut: true } : m));
  assert.equal(reorderable([lines[3]], soldOut).length, 0);
});
