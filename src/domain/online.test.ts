import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemById } from './menu.ts';
import { unitPrice } from './money.ts';
import {
  canBecome, checkOnlineOrder, clockText, effectiveStatus, normalisePhone, ONLINE_ANSWER_MS, paidStatus, parseDeliveryFee, parseHours, pinLink,
  statusText, takingOrders,
} from './online.ts';
import { totals } from './totals.ts';
import type { Order } from './types.ts';

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

test("the status pill: the shop's switch decides open or closed; the hours only add the time", () => {
  /** A moment at this Sri Lanka clock time (UTC+5:30). */
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 14, h, m) - 5.5 * 3_600_000;
  const day = parseHours('11:00-21:00');
  assert.deepEqual(day, { opens: 660, closes: 1260 });
  assert.equal(parseHours(undefined), null);
  assert.equal(parseHours('11am-9pm'), null);
  assert.equal(parseHours('25:00-21:00'), null);
  assert.equal(clockText(660), '11 AM');
  assert.equal(clockText(1290), '9:30 PM');
  assert.equal(clockText(0), '12 AM');

  assert.equal(statusText(true, null, at(12)), 'Open for pickup', 'no hours set: no times claimed');
  assert.equal(statusText(false, null, at(12)), 'Closed');
  assert.equal(statusText(true, day, at(12)), 'Open · Closes 9 PM');
  assert.equal(statusText(false, day, at(9)), 'Closed · Opens 11 AM');
  assert.equal(statusText(false, day, at(22)), 'Closed · Opens 11 AM', 'after closing: tomorrow');
  assert.equal(statusText(false, day, at(15)), 'Closed for now', 'switched off during the day: no promise');

  const late = parseHours('17:00-01:30')!;
  assert.equal(statusText(false, late, at(0, 30)), 'Closed for now', 'past midnight is still inside');
  assert.equal(statusText(false, late, at(2)), 'Closed · Opens 5 PM');
  assert.equal(statusText(true, late, at(23)), 'Open · Closes 1:30 AM');
});

// ----- Delivery (SCRUM-193) -----

const deliveryBody = (more: Record<string, unknown> = {}) => ({
  kind: 'delivery', name: 'Kasun', phone: '0771234567', note: '', address: '  12 Station Rd,\n Thalawathugoda ',
  lines: [{ itemId: 'devilled-chicken', qty: 1, size: 'L', adds: [], outs: [] }], ...more,
});

test('the delivery fee: whole rupees from the owner, or no delivery at all', () => {
  assert.equal(parseDeliveryFee('250'), 25000);
  assert.equal(parseDeliveryFee(' 0 '), 0, 'free delivery');
  for (const bad of [undefined, '', 'Rs 250', '250.50', '-1', '99999']) assert.equal(parseDeliveryFee(bad), null, String(bad));
});

test('a delivery needs an address and a shop that delivers; its fee comes from the shop and is in the total', () => {
  const items = checkOnlineOrder({ ...deliveryBody(), kind: 'pickup' });
  assert.ok(!('reason' in items));
  const pizza = items.total;

  assert.deepEqual(checkOnlineOrder(deliveryBody()), { reason: 'the shop is not delivering right now: choose pickup' });
  const ok = checkOnlineOrder(deliveryBody({ deliveryFee: 1 }), undefined, 25000);
  assert.ok(!('reason' in ok));
  assert.deepEqual([ok.kind, ok.address, ok.pin, ok.deliveryFee, ok.total], ['delivery', '12 Station Rd, Thalawathugoda', null, 25000, pizza + 25000], 'the phone cannot set the fee');
  assert.deepEqual(checkOnlineOrder(deliveryBody({ address: ' ' }), undefined, 25000), { reason: 'type your address' });
  assert.deepEqual(checkOnlineOrder(deliveryBody({ address: 'x'.repeat(201) }), undefined, 25000), { reason: 'an address of at most 200 letters' });

  const pinned = checkOnlineOrder(deliveryBody({ pin: { lat: 6.8235123456, lng: 79.8901234567 } }), undefined, 25000);
  assert.ok(!('reason' in pinned));
  assert.deepEqual(pinned.pin, { lat: 6.82351, lng: 79.89012 }, 'about a metre is kept');
  assert.equal(pinLink(pinned.pin!), 'https://www.google.com/maps/search/?api=1&query=6.82351,79.89012');
  assert.ok('reason' in checkOnlineOrder(deliveryBody({ pin: { lat: 'here', lng: 1 } }), undefined, 25000));

  const pickup = checkOnlineOrder({ ...deliveryBody(), kind: 'pickup' }, undefined, 25000);
  assert.ok(!('reason' in pickup));
  assert.deepEqual([pickup.address, pickup.deliveryFee, pickup.total], [null, 0, pizza], 'pickup never pays the fee');
});

test('pickup is collected; a delivery goes out and is delivered, and a payment closes either', () => {
  assert.ok(canBecome('delivery', 'ready', 'out'));
  assert.ok(canBecome('delivery', 'out', 'delivered'));
  assert.ok(canBecome('delivery', 'accepted', 'delivered'), 'paid before it left');
  assert.ok(!canBecome('delivery', 'ready', 'collected'));
  assert.ok(!canBecome('pickup', 'ready', 'out'));
  assert.ok(!canBecome('pickup', 'accepted', 'delivered'));
  assert.ok(canBecome('pickup', 'ready', 'collected'));
  assert.ok(!canBecome('delivery', 'out', 'ready'));
  assert.deepEqual([paidStatus('pickup'), paidStatus('delivery')], ['collected', 'delivered']);
});

test('the fee is in the order total, never discounted, and waived only when the order is Free', () => {
  const line = { id: 'l1', itemId: 'devilled-chicken', qty: 1, size: 'L' as const, adds: [], outs: [], sent: true, unit: 200000 };
  const order: Order = { number: 1030, lines: [line], online: { pickupBy: 0, delivery: { fee: 25000 } } };
  assert.deepEqual(totals(order), { subtotal: 200000, lineAdjust: 0, orderDiscount: 0, deliveryFee: 25000, total: 225000 });
  const tenOff = totals({ ...order, adjust: { discount: { kind: 'percent', pct: 10 } } });
  assert.deepEqual([tenOff.orderDiscount, tenOff.deliveryFee, tenOff.total], [20000, 25000, 205000]);
  const free = totals({ ...order, adjust: { discount: { kind: 'comp' } } });
  assert.deepEqual([free.deliveryFee, free.total], [0, 0]);
  assert.equal(totals({ ...order, online: { pickupBy: 0 } }).total, 200000, 'pickup: no fee');
});

test('the status pill says when the shop delivers', () => {
  assert.equal(statusText(true, null, 0, true), 'Open for pickup and delivery');
  assert.equal(statusText(true, null, 0), 'Open for pickup');
});
