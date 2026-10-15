import test from 'node:test';
import assert from 'node:assert/strict';
import { orderMessage, suggestPacks, whatsAppLink, whatsAppNumber } from './ordering.ts';

// Ordering from a supplier (SCRUM-92).

test('enough packs for a week at the last week\'s rate, at least one', () => {
  assert.equal(suggestPacks({ usedPerDay: 1000, onHandBaseUnits: 500, packQty: 2000 }), 4); // 7 kg - 0.5 kg = 3.25 packs
  assert.equal(suggestPacks({ usedPerDay: 0, onHandBaseUnits: 0, packQty: 2000 }), 1);
  assert.equal(suggestPacks({ usedPerDay: 100, onHandBaseUnits: -300, packQty: 1000 }), 1, 'below zero counts as empty');
});

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
