import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoHistory } from '../fake/history.ts';
import { buildOwnerDigest } from './ownerDigest.ts';
import type { SyncEvent } from './sync.ts';

// What goes to OpenAI through the owner's ChatGPT (SCRUM-198): built from an allowlist, never with people in it.

const NOW = Date.UTC(2026, 10, 2, 6, 30);
const SECRET = 'Kumari Perera';
const NOTE = 'SECRET-NOTE-ABOUT-STAFF';
const person = { id: 'u-secret', name: SECRET, role: 'manager' };
const stockBase = { shopId: 'demo', orderNumber: 0, actor: person };

test('no staff name, order number or free-text note in the whole digest', () => {
  const history = demoHistory(NOW) as SyncEvent[];
  const named = history.map((e) => ('actor' in e ? { ...e, actor: person } : e)) as SyncEvent[];
  const extra = [
    { ...stockBase, id: 'gap-1', type: 'stock.counted', at: NOW - 3_600_000, itemId: 'inv-0001', counted: 0, expected: 90000, reason: 'other', note: NOTE },
  ] as unknown as SyncEvent[];
  const text = JSON.stringify(buildOwnerDigest([...named, ...extra], NOW));
  assert.ok(!text.includes(SECRET), 'staff name');
  assert.ok(!text.includes('Kumari'), 'first name');
  assert.ok(!text.includes(NOTE), 'free-text note');
  assert.ok(!/\b[Oo]rder \d/.test(text), 'order number');
});

test('a card the allowlist does not know is not sent', () => {
  const digest = buildOwnerDigest(demoHistory(NOW) as SyncEvent[], NOW);
  assert.ok(digest.attention.length > 0, 'the demo shop has something to say');
  assert.ok(!digest.attention.some((c) => /delivery approval|approved a delivery|undid a delivery/.test(c.title)));
});

test('stock: never counted is unknown, not empty; a low item says what to buy', () => {
  const quiet = buildOwnerDigest([], NOW);
  const flour = quiet.stock.find((i) => i.id === 'inv-0001')!;
  assert.equal(flour.status, 'unknown');
  assert.equal(flour.onHand, null);
  assert.equal(flour.onHandPacks, null);
});

test('dishes: a cost only when every part is priced; a whole price list on an empty shop', () => {
  const { dishes } = buildOwnerDigest([], NOW);
  assert.ok(dishes.length > 20);
  for (const d of dishes) {
    assert.ok(Number.isSafeInteger(d.priceCents), d.name);
    assert.equal(d.marginPercent === null, d.foodCostCents === null || d.priceCents === 0, d.name);
    assert.equal(d.soldLast28Days, 0, d.name);
  }
});

test('sold counts paid orders only, as they stood, and an undone payment comes off', () => {
  const line = (id: string, itemId: string, size: string, qty: number) => ({ id, itemId, size, qty, adds: [], outs: [], unit: 100 });
  const base = { shopId: 'demo', actor: person };
  const itemId = 'margherita';
  const size = 'L';
  const sent = (n: number, at: number, id: string, qty: number) => ({ ...base, id, type: 'order.sent', at, orderNumber: n, ticketId: `t-${id}`, addOn: false, lines: [line(`l-${id}`, itemId, size, qty)] });
  const paid = (n: number, at: number, id: string) => ({ ...base, id, type: 'order.paid', at, orderNumber: n, total: 100, tender: 'cash', tendered: 100 });
  const events = [
    sent(1, NOW - 1000, 'a', 2), paid(1, NOW - 900, 'pa'), // paid: counts
    sent(2, NOW - 800, 'b', 5), // never paid: does not
    sent(3, NOW - 700, 'c', 7), paid(3, NOW - 600, 'pc'),
    { ...base, id: 'uc', type: 'order.payment_undone', at: NOW - 500, orderNumber: 3 }, // undone: does not
    sent(4, NOW - 40 * 86_400_000, 'd', 9), paid(4, NOW - 40 * 86_400_000 + 1, 'pd'), // too old
  ] as unknown as SyncEvent[];
  const found = buildOwnerDigest(events, NOW).dishes.filter((d) => d.soldLast28Days > 0);
  assert.deepEqual(found.map((d) => [d.size, d.soldLast28Days]), [['L', 2]]);
});

test('suppliers: draft and suggestions come through, with no phone number', () => {
  const events = [{ ...stockBase, id: 'd1', type: 'stock.draft_set', at: NOW - 1000, supplierId: 'sup_prima', lines: [{ itemId: 'inv-0001', packs: 3 }] }] as unknown as SyncEvent[];
  const { suppliers } = buildOwnerDigest(events, NOW);
  const prima = suppliers.find((s) => s.id === 'sup_prima')!;
  assert.deepEqual(prima.draft.map((l) => [l.itemId, l.packs]), [['inv-0001', 3]]);
  assert.ok(prima.draft[0].name.length > 0);
  assert.ok(!('phone' in prima));
});

test('Customers: gone quiet and credit go to ChatGPT as counts and amounts, never a customer id or phone number', () => {
  const DAY = 86_400_000;
  const cust = (k: number) => `cus-${String(k).padStart(16, '0')}`;
  let n = 0;
  const sale = (k: number, daysAgo: number, tender = 'cash') => ({
    id: `cp${++n}`, shopId: 'demo', at: NOW - daysAgo * DAY, orderNumber: 9000 + n, actor: person,
    type: 'order.paid', total: 300000, tender, tendered: 300000, customerId: cust(k),
  });
  const events = [
    { ...stockBase, id: 'crm-on', at: 1, type: 'shop.module_set', module: 'crm', on: true, codeId: '0123456789abcdef' },
    ...[40, 35, 30, 25, 20].map((d) => sale(1, d)), ...[50, 44, 38, 32, 18].map((d) => sale(2, d)),
    sale(3, 45, 'credit'), // on credit, nothing paid back for 45 days
  ] as unknown as SyncEvent[];
  const digest = buildOwnerDigest(events, NOW);
  const ids = digest.attention.map((c) => c.title);
  assert.ok(ids.includes('2 regulars have gone quiet'), ids.join(' | '));
  assert.ok(ids.some((t) => /nothing paid for 30\+ days/.test(t)), ids.join(' | '));
  assert.doesNotMatch(JSON.stringify(digest), /cus-|\+94|07\d{8}/);
});
