import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSegmentRules, crmSummary, customerStatsFromEvents, DEFAULT_SEGMENT_RULES, isCustomerId, purchaseHistory, segmentsOf,
  visitsFromEvents, type SegmentRules, type Visit,
} from './customers.ts';
import type { SyncEvent } from './sync.ts';
import type { OrderLine } from './types.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 11, 8, 0); // 11 Nov 2026, 13:30 in Thalwila
const actor = { id: 'n', name: 'Nimal', role: 'cashier' as const };
const owner = { id: 'o', name: 'Owner', role: 'owner' as const };
const KASUN = 'cus-00000000000000a1';
const NIMALI = 'cus-00000000000000b2';
const RUWAN = 'cus-00000000000000c3';

const pizza: OrderLine = { id: 'l1', itemId: 'devilled-chicken', qty: 1, size: 'L', adds: [], outs: [], sent: true, unit: 290000 };
const burger: OrderLine = { id: 'l2', itemId: 'chicken-burger', qty: 2, adds: [], outs: [], sent: true, unit: 95000 };

let seq = 0;
const ev = <T extends object>(orderNumber: number, at: number, body: T) => ({ id: `e${++seq}`, shopId: 's', at, actor, orderNumber, ...body });
const sent = (n: number, at: number, lines: OrderLine[]) => ev(n, at, { type: 'order.sent', ticketId: `t${seq + 1}`, lines, addOn: false });
const paid = (n: number, at: number, total: number, customerId?: string) =>
  ev(n, at, { type: 'order.paid', total, tender: 'cash', tendered: total, ...(customerId ? { customerId } : {}) });
const undone = (n: number, at: number) => ev(n, at, { type: 'order.payment_undone' });
const sale = (n: number, at: number, total: number, customerId?: string, lines = [pizza]) => [sent(n, at - 60_000, lines), paid(n, at, total, customerId)];

test('customer ids are opaque: cus- and 16 hex', () => {
  assert.equal(isCustomerId(KASUN), true);
  for (const bad of ['cus-123', '+94770000001', 'CUS-00000000000000A1', 'cus-00000000000000g1', 42, null]) assert.equal(isCustomerId(bad), false);
});

test('stats: payments that still stand, per customer; sales with no customer belong to nobody', () => {
  const events = [
    ...sale(1001, NOW - 40 * DAY, 290000, KASUN),
    ...sale(1002, NOW - 10 * DAY, 190000, KASUN, [burger]),
    ...sale(1003, NOW - 2 * DAY, 500000), // no number given at Charge
    ...sale(1004, NOW - DAY, 290000, NIMALI),
  ] as SyncEvent[];
  const stats = customerStatsFromEvents(events);
  assert.deepEqual([...stats.keys()].sort(), [KASUN, NIMALI]);
  assert.deepEqual(stats.get(KASUN), { customerId: KASUN, orders: 2, spent: 480000, firstVisitAt: NOW - 40 * DAY, lastVisitAt: NOW - 10 * DAY });
  assert.equal(stats.get(NIMALI)!.orders, 1);
});

test('an undone payment stops counting; paying again counts once, with the customer given then', () => {
  const events = [
    ...sale(1001, NOW - DAY, 290000, KASUN),
    undone(1001, NOW - DAY + 5_000),
    paid(1001, NOW - DAY + 9_000, 290000, NIMALI), // charged again: this time Nimali's number
    // Another screen's 1001, the same day: its own order.
    ...sale(1001, NOW - DAY + 60_000, 190000, KASUN, [burger]),
  ] as SyncEvent[];
  const stats = customerStatsFromEvents(events);
  assert.deepEqual(stats.get(NIMALI), { customerId: NIMALI, orders: 1, spent: 290000, firstVisitAt: NOW - DAY + 9_000, lastVisitAt: NOW - DAY + 9_000 });
  assert.equal(stats.get(KASUN)!.orders, 1);
  assert.equal(stats.get(KASUN)!.spent, 190000);
  // The re-paid order keeps its pizza; the second 1001 has only its burgers.
  assert.deepEqual(purchaseHistory(events, NIMALI)[0].items.map((i) => i.itemId), ['devilled-chicken']);
  assert.deepEqual(purchaseHistory(events, KASUN)[0].items.map((i) => i.itemId), ['chicken-burger']);
});

test('test data the owner cleared is not anyone\'s history', () => {
  const events = [
    ...sale(1001, NOW - 20 * DAY, 290000, KASUN),
    ev(0, NOW - 10 * DAY, { type: 'shop.started_fresh', actor: owner, before: NOW - 15 * DAY }),
    ...sale(1002, NOW - 5 * DAY, 190000, KASUN, [burger]),
  ] as SyncEvent[];
  assert.deepEqual(customerStatsFromEvents(events).get(KASUN), {
    customerId: KASUN, orders: 1, spent: 190000, firstVisitAt: NOW - 5 * DAY, lastVisitAt: NOW - 5 * DAY,
  });
});

test('purchase history: newest first, line by line', () => {
  const events = [...sale(1001, NOW - 3 * DAY, 290000, KASUN), ...sale(1002, NOW - DAY, 190000, KASUN, [burger])] as SyncEvent[];
  const history = purchaseHistory(events, KASUN);
  assert.deepEqual(history.map((s) => [s.orderNumber, s.total, s.itemsCount]), [[1002, 190000, 2], [1001, 290000, 1]]);
  assert.equal(history[0].items[0].itemName, 'Chicken Burger');
  assert.deepEqual(purchaseHistory(events, NIMALI), []);
});

// ----- segments -----

const visits = (...list: [number, number][]): Visit[] => list.map(([daysAgo, total], i) => ({ saleId: `s${i}`, orderNumber: 1001 + i, at: NOW - daysAgo * DAY, total }));
const rules = (over: Partial<SegmentRules> = {}): SegmentRules => ({ ...DEFAULT_SEGMENT_RULES, vipTopShare: 0, ...over });

test('segments: inactive at 30 days (or never bought), new within 30 days of the first visit, else regular', () => {
  const v = new Map<string, Visit[]>([
    ['first-week', visits([3, 100000])],
    ['since-spring', visits([200, 100000], [5, 100000])],
    ['just-29', visits([29, 100000])],
    ['exactly-30', visits([30, 100000])],
    ['long-gone', visits([300, 100000], [31, 100000])],
  ]);
  const customers = [...v.keys(), 'imported-never-bought'].map((id) => ({ id }));
  const seg = segmentsOf(customers, v, rules(), NOW);
  assert.deepEqual(Object.fromEntries(seg), {
    'first-week': 'new', 'since-spring': 'regular', 'just-29': 'new', 'exactly-30': 'inactive', 'long-gone': 'inactive', 'imported-never-bought': 'inactive',
  });
});

test('VIP: spent the amount in the window (any older spending does not count), and it beats New', () => {
  const v = new Map<string, Visit[]>([
    ['big-new', visits([2, 1_600_000])],
    ['big-long-ago', visits([120, 5_000_000], [10, 100000])],
    ['steady', visits([80, 800000], [20, 800000])],
    ['big-but-gone', visits([40, 9_000_000])],
  ]);
  const seg = segmentsOf([...v.keys()].map((id) => ({ id })), v, rules(), NOW);
  assert.deepEqual(Object.fromEntries(seg), { 'big-new': 'vip', 'big-long-ago': 'regular', steady: 'vip', 'big-but-gone': 'inactive' });
});

test('VIP: the top share of spenders, whole customers only, ties at the line all in', () => {
  const v = new Map<string, Visit[]>();
  for (let i = 1; i <= 20; i++) v.set(`c${i}`, visits([40 + i, 1000], [5, i * 10000]));
  v.set('tie', visits([45, 1000], [5, 190000])); // the same as c19
  const customers = [...v.keys()].map((id) => ({ id }));
  const seg = segmentsOf(customers, v, rules({ vipSpent: 99_999_999, vipTopShare: 0.1 }), NOW);
  // 21 spenders × 10% = 2 customers: c20 and c19, and the tie with c19.
  assert.deepEqual([...seg].filter(([, s]) => s === 'vip').map(([id]) => id).sort(), ['c19', 'c20', 'tie']);
  // Too few customers for 10% to be one whole customer: nobody is VIP by share.
  const few = new Map([...v].slice(0, 5));
  const segFew = segmentsOf([...few.keys()].map((id) => ({ id })), few, rules({ vipSpent: 99_999_999, vipTopShare: 0.1 }), NOW);
  assert.ok(![...segFew.values()].includes('vip'));
});

test('segment rules are checked before they are kept', () => {
  assert.equal(checkSegmentRules(DEFAULT_SEGMENT_RULES), null);
  assert.match(String(checkSegmentRules({ ...DEFAULT_SEGMENT_RULES, inactiveDays: 0 })), /inactiveDays/);
  assert.match(String(checkSegmentRules({ ...DEFAULT_SEGMENT_RULES, newDays: 2.5 })), /newDays/);
  assert.match(String(checkSegmentRules({ ...DEFAULT_SEGMENT_RULES, vipSpent: 15.5 })), /whole cents/);
  assert.match(String(checkSegmentRules({ ...DEFAULT_SEGMENT_RULES, vipTopShare: 0.9 })), /share/);
  assert.equal(checkSegmentRules(null), 'rules are missing');
});

// ----- the numbers at the top of Customers -----

test('summary: totals, new this month by first purchase, repeat rate, top spenders', () => {
  const events = [
    ...sale(1001, NOW - 40 * DAY, 290000, KASUN), // October
    ...sale(1002, NOW - 5 * DAY, 290000, KASUN),
    ...sale(1003, NOW - 3 * DAY, 190000, NIMALI), // first bought in November
    ...sale(1004, NOW - 50 * DAY, 900000, RUWAN), // gone quiet
  ] as SyncEvent[];
  const customers = [KASUN, NIMALI, RUWAN, 'cus-00000000000000d4'].map((id) => ({ id })); // the last one imported, never bought
  const s = crmSummary(customers, visitsFromEvents(events), DEFAULT_SEGMENT_RULES, NOW, 2);
  assert.equal(s.total, 4);
  assert.equal(s.newThisMonth, 1);
  assert.equal(s.active, 2);
  assert.equal(s.inactive, 2);
  assert.equal(s.repeatRate, 1 / 3);
  // Kasun: Rs 5,800 in 90 days, under Rs 15,000, and 2 spenders are too few for a top 10%.
  assert.deepEqual(s.bySegment, { new: 1, regular: 1, vip: 0, inactive: 2 });
  assert.deepEqual(s.top.map((t) => [t.customerId, t.spent]), [[RUWAN, 900000], [KASUN, 580000]]);
  assert.equal(crmSummary([], new Map(), DEFAULT_SEGMENT_RULES, NOW).repeatRate, null);
});
