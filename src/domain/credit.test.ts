import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePush } from '../../server/validate.ts';
import { mayRecord } from './auth.ts';
import {
  canTakeCredit, checkCreditEvent, checkCreditSetting, creditDay, creditFromEvents, creditOf, isOverdue, MAX_LIMIT, nearLimit, statement,
  type CreditSetting,
} from './credit.ts';
import { creditInsights } from './creditInsights.ts';
import type { ModuleEvent } from './modules.ts';
import type { SyncEvent } from './sync.ts';
import type { Tender } from './types.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 21, 6, 0); // 21 Nov 2026
const KASUN = 'cus-000000000000000a';
const NIMAL = 'cus-000000000000000b';
const cashier = { id: 'c', name: 'Nimal', role: 'cashier' as const };
const owner = { id: 'o', name: 'Anton', role: 'owner' as const };
let n = 0;
const id = () => `e${++n}`;
const base = (at: number) => ({ id: id(), shopId: 's', at, actor: cashier });

const crmOn: ModuleEvent = { id: 'm', shopId: 's', at: 1, orderNumber: 0, actor: owner, type: 'shop.module_set', module: 'crm', on: true, codeId: '0123456789abcdef' };
const setCredit = (customerId: string, after: CreditSetting | null, at = NOW - 60 * DAY, before: CreditSetting | null = null): SyncEvent =>
  ({ ...base(at), actor: owner, orderNumber: 0, type: 'credit.limit_set', customerId, before, after });
const bill = (customerId: string, total: number, at: number, orderNumber = 1000 + n, tender: Tender = 'credit'): SyncEvent =>
  ({ ...base(at), orderNumber, type: 'order.paid', total, tender, tendered: total, customerId });
const payBack = (customerId: string, amount: number, at: number, tender: 'cash' | 'transfer' = 'cash', tendered = amount): SyncEvent =>
  ({ ...base(at), orderNumber: 0, type: 'credit.paid', customerId, amount, tender, tendered });

test('owes = bills on credit less what was paid back; payments pay off the oldest bills first', () => {
  const events = [
    setCredit(KASUN, { limit: 2_000_000 }),
    bill(KASUN, 150_000, NOW - 20 * DAY),
    bill(KASUN, 250_000, NOW - 10 * DAY),
    bill(KASUN, 90_000, NOW - 5 * DAY, 2001, 'cash'), // paid in cash: not on credit
    payBack(KASUN, 200_000, NOW - 2 * DAY),
  ];
  const a = creditOf(events, KASUN);
  assert.equal(a.owes, 200_000);
  assert.deepEqual(a.bills.map((b) => [b.amount, b.open]), [[150_000, 0], [250_000, 200_000]]);
  assert.equal(a.oldestOpenAt, NOW - 10 * DAY, 'the first bill is paid off, the second is the oldest still open');
  assert.equal(a.lastPaidAt, NOW - 2 * DAY);
  assert.deepEqual(a.setting, { limit: 2_000_000 });
});

test('an undone payment takes its credit bill away; an undone pay-back puts the debt back', () => {
  const p = payBack(KASUN, 50_000, NOW - DAY);
  const events: SyncEvent[] = [
    setCredit(KASUN, { limit: null }),
    bill(KASUN, 100_000, NOW - 3 * DAY, 1500),
    { ...base(NOW - 3 * DAY + 1000), orderNumber: 1500, type: 'order.payment_undone' },
    bill(KASUN, 120_000, NOW - 3 * DAY + 2000, 1500),
    p,
    { ...base(NOW), orderNumber: 0, type: 'credit.paid_undone', paidId: p.id },
  ];
  const a = creditOf(events, KASUN);
  assert.equal(a.owes, 120_000);
  assert.equal(a.payments.length, 0);
});

test('a credit bill changed after paying and settled on credit changes what is owed (SCRUM-242)', () => {
  const events: SyncEvent[] = [
    setCredit(KASUN, { limit: null }),
    bill(KASUN, 100_000, NOW - DAY, 1700),
    { ...base(NOW - DAY + 60_000), orderNumber: 1700, type: 'order.settled', amount: 30_000, tender: 'credit', tendered: 30_000 },
    { ...base(NOW - DAY + 120_000), orderNumber: 1700, type: 'order.settled', amount: -50_000, tender: 'credit', tendered: 50_000 },
  ];
  assert.equal(creditOf(events, KASUN).owes, 80_000);
});

test('a split bill counts only its credit parts', () => {
  const split: SyncEvent = {
    ...base(NOW), orderNumber: 1800, type: 'order.paid', total: 300_000, tender: 'cash', tendered: 200_000, customerId: KASUN,
    parts: [{ tender: 'cash', amount: 200_000, tendered: 200_000 }, { tender: 'credit', amount: 100_000, tendered: 100_000 }],
  };
  assert.equal(creditOf([split], KASUN).owes, 100_000);
});

test('every customer has Rs 100,000 credit until the owner says otherwise; his Off is off', () => {
  const fresh = creditOf([], KASUN);
  assert.deepEqual(fresh.setting, { limit: 10_000_000 });
  assert.equal(fresh.isDefault, true);
  assert.deepEqual(canTakeCredit(fresh, 10_000_000), { ok: true });
  assert.deepEqual(canTakeCredit(fresh, 10_000_100), { ok: false, why: 'over', over: 100 });
  const billOnly = creditOf([bill(KASUN, 400_000, NOW - DAY)], KASUN);
  assert.equal(billOnly.isDefault, true, 'a bill alone does not change the setting');
  const off = creditOf([setCredit(KASUN, null)], KASUN);
  assert.equal(off.setting, null);
  assert.equal(off.isDefault, false);
});

test('the limit: off, no limit, within it, and by how much a bill would pass it', () => {
  assert.deepEqual(canTakeCredit({ setting: null, owes: 0 }, 1), { ok: false, why: 'off' });
  assert.deepEqual(canTakeCredit({ setting: { limit: null }, owes: 9_999_999 }, 500_000), { ok: true });
  assert.deepEqual(canTakeCredit({ setting: { limit: 2_000_000 }, owes: 1_800_000 }, 200_000), { ok: true });
  assert.deepEqual(canTakeCredit({ setting: { limit: 2_000_000 }, owes: 1_800_000 }, 240_000), { ok: false, why: 'over', over: 40_000 });
});

test('turning credit off keeps the debt, and the latest setting wins', () => {
  const events = [setCredit(KASUN, { limit: 1_000_000 }), bill(KASUN, 400_000, NOW - DAY), setCredit(KASUN, null, NOW, { limit: 1_000_000 })];
  const a = creditOf(events, KASUN);
  assert.equal(a.setting, null);
  assert.equal(a.owes, 400_000);
  assert.deepEqual(canTakeCredit(a, 1), { ok: false, why: 'off' });
});

test('settings and events are checked: whole cents, a customer, money handed over', () => {
  assert.equal(checkCreditSetting(null), null);
  assert.equal(checkCreditSetting({ limit: null }), null);
  assert.equal(checkCreditSetting({ limit: 2_000_000 }), null);
  assert.ok(checkCreditSetting({ limit: 0 }));
  assert.ok(checkCreditSetting({ limit: 12.5 }));
  assert.ok(checkCreditSetting({ limit: MAX_LIMIT + 1 }));
  assert.ok(checkCreditSetting({ limit: 100, note: 'x' }));
  const ok = { orderNumber: 0, type: 'credit.paid', customerId: KASUN, amount: 100, tender: 'cash', tendered: 500 };
  assert.equal(checkCreditEvent(ok), null);
  assert.ok(checkCreditEvent({ ...ok, tender: 'credit' }), 'never paid back with credit');
  assert.ok(checkCreditEvent({ ...ok, tendered: 50 }));
  assert.ok(checkCreditEvent({ ...ok, customerId: '0771234567' }), 'a customer is an id, never a number');
});

test('the shop server refuses a bill on credit without a customer, and takes a good one', () => {
  const ev = (extra: object) => ({ id: 'x1', shopId: 's', at: NOW, orderNumber: 1001, actor: cashier, type: 'order.paid', total: 100, tender: 'credit', tendered: 100, ...extra });
  assert.ok('reason' in validatePush({ events: [ev({})] }, 's'));
  assert.ok('events' in validatePush({ events: [ev({ customerId: KASUN })] }, 's'));
  assert.ok('events' in validatePush({ events: [{ ...setCredit(KASUN, { limit: 500_000 }), shopId: 's' }] }, 's'));
});

test('who may: the owner sets credit; anyone at the counter takes it back', () => {
  assert.equal(mayRecord('owner', 'credit.limit_set'), true);
  assert.equal(mayRecord('manager', 'credit.limit_set'), false);
  assert.equal(mayRecord('cashier', 'credit.limit_set'), false);
  assert.equal(mayRecord('cashier', 'credit.paid'), true);
  assert.equal(mayRecord('kitchen', 'credit.paid'), false);
});

test('a day: put on credit, paid back (cash apart), owed in all', () => {
  const today = NOW - 6 * 3_600_000;
  const events = [
    setCredit(KASUN, { limit: null }), setCredit(NIMAL, { limit: null }),
    bill(KASUN, 300_000, NOW - 10 * DAY), bill(NIMAL, 150_000, NOW - 60_000),
    payBack(KASUN, 100_000, NOW - 120_000), payBack(KASUN, 50_000, NOW - 100_000, 'transfer'),
  ];
  assert.deepEqual(creditDay(events, today, NOW), { onCredit: 150_000, paidBack: 150_000, paidBackCash: 100_000, owed: 300_000, customersOwing: 2 });
});

test('statement: newest first, with what was owed after each line', () => {
  const events = [setCredit(KASUN, { limit: null }), bill(KASUN, 100_000, NOW - 3 * DAY, 1201), payBack(KASUN, 40_000, NOW - DAY), bill(KASUN, 60_000, NOW, 1202)];
  const rows = statement(creditOf(events, KASUN));
  assert.deepEqual(rows.map((r) => [r.kind, r.amount, r.owesAfter]), [['bill', 60_000, 120_000], ['paid', -40_000, 60_000], ['bill', 100_000, 100_000]]);
  assert.equal(rows[2].text, 'Order 1201');
});

test('overdue after 30 days with nothing paid; near the limit at 80%', () => {
  const events = [
    setCredit(KASUN, { limit: 1_000_000 }), bill(KASUN, 850_000, NOW - 10 * DAY),
    setCredit(NIMAL, { limit: null }), bill(NIMAL, 200_000, NOW - 40 * DAY),
  ];
  const all = creditFromEvents(events);
  assert.equal(nearLimit(all.get(KASUN)!), true);
  assert.equal(isOverdue(all.get(KASUN)!, NOW), false);
  assert.equal(isOverdue(all.get(NIMAL)!, NOW), true);
  assert.equal(isOverdue(creditOf([...events, payBack(NIMAL, 10_000, NOW - 5 * DAY)], NIMAL), NOW), false, 'a payment this month resets it');
});

test('To do: overdue, near the limit, and (first week of a month) what is owed; no names, one tap to Owes', () => {
  const events = [
    crmOn,
    setCredit(KASUN, { limit: 1_000_000 }), bill(KASUN, 850_000, NOW - 10 * DAY),
    setCredit(NIMAL, { limit: null }), bill(NIMAL, 200_000, NOW - 40 * DAY),
  ];
  const cards = creditInsights(events, NOW);
  assert.deepEqual(cards.map((c) => c.id), ['credit-overdue', 'credit-near-limit']);
  assert.equal(cards[0].title, 'A customer owes Rs 2,000, nothing paid for 30+ days');
  assert.equal(cards[0].action.go, '#customers/owes');
  const firstOfMonth = Date.UTC(2026, 11, 2, 6, 0);
  assert.equal(creditInsights(events, firstOfMonth).at(-1)!.title, '2 customers owe Rs 10,500 on credit');
  assert.ok(!JSON.stringify(cards).includes('cus-'), 'no customer ids on the card either');
  assert.deepEqual(creditInsights(events.slice(1), NOW), [], 'nothing while Customers is off');
});
