import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quietRegulars, regularsGoneQuiet } from './customerInsights.ts';
import { rulesSuggestions as suggestions } from './insights.ts';
import type { ModuleEvent } from './modules.ts';
import type { SyncEvent } from './sync.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 14, 6, 0);
const crm = (on: boolean): ModuleEvent => ({
  id: `m-${on}`, shopId: 's', at: 1, orderNumber: 0, actor: { id: 'developers', name: 'Developers', role: 'owner' },
  type: 'shop.module_set', module: 'crm', on, codeId: '0123456789abcdef',
});
let n = 0;
/** A customer's paid visits, so many days before NOW. */
const visits = (customer: string, daysAgo: number[], total = 200000): SyncEvent[] => daysAgo.map((d) => {
  n++;
  return { id: `p${n}`, shopId: 's', at: NOW - d * DAY, orderNumber: 1000 + n, actor: { id: 'c', name: 'Nimal', role: 'cashier' }, type: 'order.paid', total, tender: 'cash', tendered: total, customerId: `cus-${customer.padStart(16, '0')}` } as SyncEvent;
});

const shop = [
  crm(true),
  ...visits('1', [40, 35, 30, 25, 20], 300000), // every 5 days, away 20: quiet
  ...visits('2', [50, 44, 38, 32, 18]), // every 8 days, away 18: quiet
  ...visits('3', [90, 60, 30, 20]), // every ~23 days, away 20: their rhythm, not quiet
  ...visits('4', [30, 20, 3]), // came 3 days ago: not quiet
  ...visits('5', [60, 50, 40, 31]), // away 31 days: already Inactive ("we miss you" is for them)
  ...visits('6', [25, 20]), // two visits: not a regular yet
];

test('quiet by their own rhythm: away more than twice their usual gap, two weeks or more, not yet Inactive', () => {
  const q = quietRegulars(shop, NOW);
  assert.deepEqual(q.map((r) => [r.usualDays, r.awayDays, r.visits]), [[5, 20, 5], [8, 18, 5]]);
  assert.equal(q[0].spent, 1_500_000, 'the regular worth most comes first');
});

test('the To do card: how many, worth how much, one tap to Campaigns; no names or numbers anywhere', () => {
  const card = regularsGoneQuiet(shop, NOW)!;
  assert.equal(card.title, '2 regulars have gone quiet');
  assert.equal(card.tone, 'attention');
  assert.match(card.detail, /Rs 25,000/);
  assert.equal(card.action.go, '#customers/campaigns');
  assert.deepEqual(card.action.items.map((i) => i.primary), ['Usually every 5 days, away 20 days', 'Usually every 8 days, away 18 days']);
  assert.doesNotMatch(JSON.stringify(card), /cus-|\+94|07\d/);
  // It is on the Owner view's To do with the rest.
  assert.ok(suggestions.insights({ events: shop, now: NOW }).some((i) => i.id === 'regulars-quiet'));
});

test('quiet: CRM off, or only one regular drifting, says nothing', () => {
  assert.equal(regularsGoneQuiet([...shop, { ...crm(false), id: 'm-off', at: 2 }], NOW), null);
  assert.equal(regularsGoneQuiet([crm(true), ...visits('9', [40, 35, 30, 25, 20])], NOW), null);
});

test('an offer\'s result: on the To do for the week after its own week, counts only, beside the ones it could not reach', () => {
  const owner = { id: 'o', name: 'Owner', role: 'owner' as const };
  const sentAt = NOW - 9 * DAY;
  const sent = { id: 'camp-1', shopId: 's', at: sentAt, orderNumber: 0, actor: owner, type: 'crm.campaign_sent', audience: 'inactive', kind: 'campaign', title: 'We kept your table', body: 'x', customers: 40, reachable: 20, delivered: 20, failed: 0 } as SyncEvent;
  const result = { id: 'result-camp-1', shopId: 's', at: sentAt + 7 * DAY, orderNumber: 0, actor: owner, type: 'crm.campaign_result', campaignId: 'camp-1', reached: 20, cameIn: 4, spent: 620000, compared: 20, comparedCameIn: 1 } as SyncEvent;
  const card = (events: SyncEvent[], now = NOW) => suggestions.insights({ events: [crm(true), ...events], now }).find((i) => i.id === 'campaign-result');
  const c = card([sent, result])!;
  assert.equal(c.title, '“We kept your table” brought in 4 of 20, Rs 6,200');
  assert.equal(c.tone, 'good');
  assert.match(c.detail, /Of the 20 in the same group it could not reach, 1 came in \(5% against 20%\)\./);
  assert.equal(c.action.go, '#customers/campaigns');
  assert.equal(card([sent]), undefined, 'no result written yet');
  assert.equal(card([sent, result], sentAt + 15 * DAY), undefined, 'gone a week after its week');
  const none = card([sent, { ...result, cameIn: 0, spent: 0 } as SyncEvent])!;
  assert.equal(none.title, '“We kept your table” brought nobody in');
  assert.equal(none.tone, 'info');
});
