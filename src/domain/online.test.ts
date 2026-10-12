import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemById } from './menu.ts';
import { unitPrice } from './money.ts';
import { checkOnlineOrder, effectiveStatus, normalisePhone, ONLINE_ANSWER_MS, takingOrders } from './online.ts';

test('phone numbers: the everyday Sri Lankan forms, and nothing else', () => {
  for (const ok of ['0771234567', '077 123 4567', '077-123-4567', '+94771234567', '94771234567', '771234567', '0112345678']) {
    assert.ok(normalisePhone(ok), ok);
  }
  assert.equal(normalisePhone('+94 77 123 4567'), '0771234567');
  for (const bad of ['', '12345', '077123456', '07712345678', 'abc', '+1 555 123 4567']) assert.equal(normalisePhone(bad), null, bad);
});

const order = (lines: unknown[], extra: Record<string, unknown> = {}) =>
  checkOnlineOrder({ name: '  Kasun   Perera ', phone: '077 123 4567', lines, ...extra });

test('an order is priced here from the menu, whatever the phone says', () => {
  const r = order([
    { itemId: 'devilled-chicken', qty: 2, size: 'L', adds: ['full-cheese'], outs: ['no-onion'], price: 1 },
    { itemId: 'chicken-burger', qty: 1 },
  ]);
  assert.ok(!('reason' in r));
  const pizza = itemById('devilled-chicken');
  const burger = itemById('chicken-burger');
  assert.equal(r.total, unitPrice(pizza, { size: 'L', adds: ['full-cheese'] }) * 2 + unitPrice(burger, { adds: [] }));
  assert.equal(r.name, 'Kasun Perera');
  assert.equal(r.phone, '0771234567');
  assert.deepEqual(r.lines[1], { itemId: 'chicken-burger', qty: 1, adds: [], outs: [] });
  assert.ok(!('price' in r.lines[0]), 'nothing the phone made up is kept');
});

test('anything not on the menu is refused, never guessed', () => {
  const why = (lines: unknown[], extra?: Record<string, unknown>) => {
    const r = order(lines, extra);
    return 'reason' in r ? r.reason : 'accepted';
  };
  assert.equal(why([]), 'the order is empty');
  assert.match(why([{ itemId: 'lobster', qty: 1 }]), /not on the menu/);
  assert.match(why([{ itemId: 'devilled-chicken', qty: 1 }]), /choose a size/);
  assert.match(why([{ itemId: 'devilled-chicken', qty: 1, size: 'S' }]), /choose a size/);
  assert.match(why([{ itemId: 'chicken-burger', qty: 1, size: 'L' }]), /no sizes/);
  assert.match(why([{ itemId: 'chicken-burger', qty: 0 }]), /at most/);
  assert.match(why([{ itemId: 'chicken-burger', qty: 21 }]), /at most 20/);
  assert.match(why([{ itemId: 'chicken-burger', qty: 1.5 }]), /at most/);
  assert.match(why([{ itemId: 'chicken-burger', qty: 1, adds: ['gold-leaf'] }]), /not offered/);
  assert.match(why([{ itemId: 'chicken-burger', qty: 1, adds: ['cheese-slice', 'cheese-slice'] }]), /twice/);
  assert.match(why([{ itemId: 'chicken-burger', qty: 1 }], { name: ' ' }), /your name/);
  assert.match(why([{ itemId: 'chicken-burger', qty: 1 }], { phone: '123' }), /phone number/);
  assert.match(why([{ itemId: 'chicken-burger', qty: 1 }], { note: 'x'.repeat(141) }), /note/);
  assert.match(why(Array(31).fill({ itemId: 'chicken-burger', qty: 1 })), /call the shop/);
  assert.equal(why([{ itemId: 'chicken-burger', qty: 1 }], { note: 'Extra napkins please' }), 'accepted');
});

test('an unanswered order runs out; the shop takes orders only while switched on and heard from', () => {
  assert.equal(effectiveStatus({ status: 'new', createdAt: 0 }, ONLINE_ANSWER_MS), 'new');
  assert.equal(effectiveStatus({ status: 'new', createdAt: 0 }, ONLINE_ANSWER_MS + 1), 'expired');
  assert.equal(effectiveStatus({ status: 'accepted', createdAt: 0 }, ONLINE_ANSWER_MS * 9), 'accepted');
  assert.equal(takingOrders({ open: true, seenAt: 1000 }, 1000 + 60_000), true);
  assert.equal(takingOrders({ open: true, seenAt: 1000 }, 1000 + 3 * 60_000), false, 'the shop PC went quiet');
  assert.equal(takingOrders({ open: false, seenAt: 1000 }, 1000), false);
  assert.equal(takingOrders({ open: true, seenAt: null }, 1000), false);
});
