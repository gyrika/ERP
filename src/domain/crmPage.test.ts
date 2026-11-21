import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  averageBill, comingBack, favourites, lkWeekday, needsYou, reachFunnel, relativeDay, signupsByMonth, usualLeaveOut, usualTime,
  usualTimeText, weekStrip,
} from './crmPage.ts';
import { DEFAULT_CREDIT, type CreditAccount } from './credit.ts';
import { isGoneQuiet, rhythmOf } from './customerInsights.ts';
import type { Customer, Visit } from './customers.ts';
import type { OrderLine } from './types.ts';

const DAY = 86_400_000;
// Saturday 21 Nov 2026, 12:30 pm in Sri Lanka.
const NOW = Date.UTC(2026, 10, 21, 7, 0);
let n = 0;
const v = (daysAgo: number, total = 200_000, at = NOW - daysAgo * DAY): Visit => ({ saleId: `s${++n}`, orderNumber: 1000 + n, at, total });
const line = (itemId: string, outs: string[] = [], qty = 1, size?: 'M' | 'L'): OrderLine =>
  ({ id: `l${++n}`, itemId, qty, adds: [], outs, ...(size ? { size } : {}) }) as OrderLine;
const cust = (id: string, over: Partial<Customer> = {}): Customer =>
  ({ id, phone: '+94771234567', name: null, source: 'pos', optedOut: false, createdAt: NOW - 100 * DAY, ...over });

test('rhythm: the usual gap, when next, from when quiet; too early under three visits', () => {
  const r = rhythmOf([v(14), v(8), v(2)])!;
  assert.equal(r.usualDays, 6);
  assert.equal(r.lastAt, NOW - 2 * DAY);
  assert.equal(r.nextAt, NOW + 4 * DAY);
  assert.equal(r.quietFrom, NOW - 2 * DAY + 14 * DAY, 'two weeks at least, though twice the gap is 12 days');
  assert.equal(rhythmOf([v(9), v(2)]), null);
});

test('gone quiet agrees with the To do rule: away > 2x usual, 14 days or more, under 30', () => {
  assert.equal(isGoneQuiet([v(40), v(35), v(30), v(25), v(20)], NOW), true);
  assert.equal(isGoneQuiet([v(90), v(60), v(30), v(20)], NOW), false, 'their own rhythm is slow');
  assert.equal(isGoneQuiet([v(60), v(50), v(40), v(31)], NOW), false, 'already Inactive');
  assert.equal(isGoneQuiet([v(25), v(20)], NOW), false, 'not a regular yet');
});

test('relative days are Sri Lanka days', () => {
  assert.equal(relativeDay(NOW - 60_000, NOW), 'Today');
  assert.equal(relativeDay(NOW - DAY, NOW), 'Yesterday');
  assert.equal(relativeDay(NOW - 19 * DAY, NOW), '19 days ago');
});

test('week strip: visits fall in their week, sized against their own bills, credit marked', () => {
  const a = v(1, 100_000);
  const b = v(8, 300_000);
  const c = v(9, 200_000);
  const old = v(200, 900_000);
  const strip = weekStrip([a, b, c, old], NOW, 4, new Set([c.saleId]));
  assert.equal(strip.length, 4);
  assert.deepEqual(strip[3], [{ size: 's', credit: false }]);
  assert.deepEqual(strip[2], [{ size: 'm', credit: true }, { size: 'b', credit: false }]);
  assert.deepEqual([strip[0], strip[1]], [[], []], 'older than the strip: left out');
  assert.deepEqual(weekStrip([v(1, 5), v(2, 500_000)], NOW, 1)[0].map((x) => x.size), ['m', 'm'], 'under three bills: all middle');
});

test('coming back: a first-ever visit counts as first, every later one as returning', () => {
  const visits = new Map([
    ['a', [v(100), v(3)]],
    ['b', [v(2)]],
    ['c', [v(10), v(1)]],
  ]);
  const cb = comingBack(visits, NOW, 2);
  assert.deepEqual(cb.weeks, [{ returning: 0, first: 1 }, { returning: 2, first: 1 }]);
  assert.equal(cb.shareThisWeek, 2 / 3);
  assert.equal(comingBack(new Map(), NOW, 2).shareThisWeek, null);
});

test('favourites: dish and size by quantity, most first, ties to the more recent', () => {
  const orders = [
    [line('devilled', [], 1, 'L'), line('coke')],
    [line('devilled', [], 2, 'L')],
    [line('margherita', [], 1, 'M'), line('coke')],
  ];
  assert.deepEqual(favourites(orders, 3), [
    { itemId: 'devilled', size: 'L', n: 3 },
    { itemId: 'coke', n: 2 },
    { itemId: 'margherita', size: 'M', n: 1 },
  ]);
});

test('the usual leave-out: 3+ times and on half that dish or more', () => {
  const orders = [
    [line('devilled', ['onion'])], [line('devilled', ['onion'])], [line('devilled', ['onion', 'onion'])], [line('devilled')],
    [line('cheese', ['onion'])],
  ];
  assert.deepEqual(usualLeaveOut(orders), { itemId: 'devilled', optionId: 'onion', n: 3, of: 4 });
  assert.equal(usualLeaveOut(orders.slice(0, 2)), null, 'twice is not a habit');
  assert.equal(usualLeaveOut([...orders, [line('devilled')], [line('devilled')], [line('devilled')]]), null, '3 of 7 is under half');
});

test('the usual time: one weekday and two-hour window with 40% of visits, in Sri Lanka time', () => {
  // Fridays at 7:40 pm Sri Lanka time (14:10 UTC).
  const friday = (weeksAgo: number) => Date.UTC(2026, 10, 20, 14, 10) - weeksAgo * 7 * DAY;
  assert.equal(lkWeekday(friday(0)), 5);
  const u = usualTime([{ at: friday(0) }, { at: friday(1) }, { at: friday(2) }, { at: NOW - 3 * DAY }, { at: NOW - 12 * DAY }])!;
  assert.deepEqual([u.weekday, u.n, u.of], [5, 3, 5]);
  assert.equal(usualTimeText(u), 'Fri, 6–8 pm');
  assert.equal(usualTimeText({ weekday: 6, from: 11, to: 13, n: 3, of: 3 }), 'Sat, 11 am–1 pm');
  assert.equal(usualTime([{ at: friday(0) }, { at: NOW - 3 * DAY }, { at: NOW - 9 * DAY }]), null, 'no window holds 40%... of three, one is not enough');
});

test('average bill in whole cents', () => {
  assert.equal(averageBill([{ total: 100 }, { total: 201 }]), 151);
  assert.equal(averageBill([]), 0);
});

const account = (customerId: string, owes: number, over: Partial<CreditAccount> = {}): CreditAccount => ({
  customerId, setting: DEFAULT_CREDIT, isDefault: true, bills: [], payments: [], owes, oldestOpenAt: NOW - 5 * DAY, lastPaidAt: null, ...over,
});

test('needs you: quiet regulars, money owed, new this month; nothing to say, no card', () => {
  const customers = [cust('q1'), cust('q2'), cust('p', { name: 'Priya' }), cust('n', { source: 'app', createdAt: NOW - 2 * DAY })];
  const visits = new Map([
    ['q1', [v(40), v(35), v(30), v(25), v(20)]],
    ['q2', [v(50), v(44), v(38), v(32), v(18)]],
  ]);
  const credit = new Map([
    ['p', account('p', 8_500_000)],
    ['x', account('x', 1_000_000, { oldestOpenAt: NOW - 40 * DAY })],
  ]);
  const cards = needsYou({ customers, visits, credit, newThisMonth: 1, now: NOW });
  assert.deepEqual(cards.map((c) => c.id), ['quiet', 'owed', 'new']);
  assert.equal(cards[0].title, '2 regulars are away twice their usual gap');
  assert.equal(cards[1].title, 'Rs 95,000 on credit, 1 customer with nothing paid for 30+ days');
  assert.equal(cards[1].tone, 'bad');
  assert.equal(cards[1].detail, 'Priya is at 85% of their limit.');
  assert.equal(cards[2].detail, '1 signed up for offers in the app.');
  assert.deepEqual(needsYou({ customers: [], visits: new Map(), credit: new Map(), newThisMonth: 0, now: NOW }), []);
});

test('reach: signed up in the app and not opted out', () => {
  const customers = [cust('a'), cust('b', { optedOut: true }), cust('c'), cust('d', { optedOut: true })];
  assert.deepEqual(reachFunnel(customers, new Set(['a', 'b'])), { total: 4, signedUp: 2, reachable: 1, optedOut: 2 });
});

test('sign-ups in the app, this month and last, across a year end', () => {
  const jan = Date.UTC(2027, 0, 10);
  const customers = [
    cust('a', { source: 'app', createdAt: Date.UTC(2027, 0, 2) }),
    cust('b', { source: 'app', createdAt: Date.UTC(2026, 11, 20) }),
    cust('c', { source: 'app', createdAt: Date.UTC(2026, 10, 20) }),
    cust('d', { source: 'pos', createdAt: Date.UTC(2027, 0, 3) }),
  ];
  assert.deepEqual(signupsByMonth(customers, jan), { thisMonth: 1, lastMonth: 1 });
});
