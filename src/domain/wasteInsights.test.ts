import test from 'node:test';
import assert from 'node:assert/strict';
import { rulesSuggestions } from './insights.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from './inventoryData.ts';
import type { SyncEvent } from './sync.ts';
import type { WasteReason, WasteWhat } from './waste.ts';
import { wasteAboveUsual, wasteReasonRepeats } from './wasteInsights.ts';

// SCRUM-178: Today tells the owner when waste is unusual, and when one reason keeps repeating.

const NOW = new Date(2026, 9, 26, 21, 30).getTime(); // a Monday, 9:30 pm
const DAY = 24 * 60 * 60_000;
const at = (daysBack: number, h: number, m = 0) => { const d = new Date(NOW); d.setDate(d.getDate() - daysBack); d.setHours(h, m, 0, 0); return d.getTime(); };
const FLOUR = 'inv-0001'; // seed price: 25.6 cents a gram
const ravi = { id: 'm1', name: 'Ravi', role: 'manager' as const };
const shop = { items: SEED_INVENTORY, suppliers: SEED_SUPPLIERS };
let n = 0;
const wasted = (when: number, what: WasteWhat, qty: number, name: string, reason: WasteReason = 'expired'): SyncEvent =>
  ({ id: `w${++n}`, shopId: 's', at: when, orderNumber: 0, actor: ravi, type: 'stock.wasted', what, name, qty, reason });
const flour = (when: number, grams: number, reason: WasteReason = 'expired') => wasted(when, { kind: 'stock', itemId: FLOUR }, grams, 'Flour', reason);
const burnt = (when: number) => wasted(when, { kind: 'dish', itemId: 'margherita', size: 'L' }, 1, 'Margherita · Large', 'burnt');
const paid = (when: number): SyncEvent =>
  ({ id: `p${++n}`, shopId: 's', at: when, orderNumber: 1001, actor: ravi, type: 'order.paid', total: 100000, tender: 'cash', tendered: 100000 });
/** Four usual weeks: the shop sold, and 3 kg of flour (Rs 768) went in the bin each week. */
const usualWeeks = [1, 2, 3, 4].flatMap((k) => [paid(at(7 * k + 2, 12)), flour(at(7 * k + 2, 15), 3000)]);

test('this week\'s waste at double the usual week: a To do card with the top items and reasons', () => {
  const week = [flour(at(1, 10), 3000), flour(at(3, 10), 2500), flour(at(2, 11), 500, 'dropped')];
  const card = wasteAboveUsual([...usualWeeks, ...week], shop, NOW)!;
  assert.equal(card.tone, 'attention');
  assert.equal(card.title, 'Rs 1,536 wasted this week, double the usual');
  assert.match(card.detail, /Most of it: Flour\. Top reason: expired\./);
  assert.deepEqual(card.action.items, [{ primary: 'Flour', secondary: '3 times · Expired 2, Dropped 1', amount: 153600 }]);
});

test('waste near the usual week, or only a little above it, stays silent', () => {
  assert.equal(wasteAboveUsual([...usualWeeks, flour(at(1, 10), 3000)], shop, NOW), null, 'the usual');
  assert.equal(wasteAboveUsual([...usualWeeks, flour(at(1, 10), 4500)], shop, NOW), null, 'Rs 384 more is not worth his time');
});

test('with no usual week yet, only a lot of waste speaks, and says there is nothing to compare', () => {
  assert.equal(wasteAboveUsual([flour(at(1, 10), 5000)], shop, NOW), null, 'Rs 1,280');
  assert.equal(wasteAboveUsual([flour(at(1, 10), 8000)], shop, NOW)?.title, 'Rs 2,048 wasted this week, no usual week yet to compare');
});

test('waste taken back with Undo, or older than a week, does not count', () => {
  const undone: SyncEvent = { id: 'u1', shopId: 's', at: at(1, 11), orderNumber: 0, actor: ravi, type: 'stock.waste_undone', wasteId: 'big' };
  const big = { ...flour(at(1, 10), 6000), id: 'big' };
  assert.equal(wasteAboveUsual([...usualWeeks, big, undone], shop, NOW), null);
  assert.equal(wasteAboveUsual([...usualWeeks, flour(NOW - 8 * DAY, 6000)], shop, NOW), null);
});

test('one reason five times this week, mostly in one 2-hour window: a pattern card', () => {
  const evenings = [at(0, 19, 10), at(1, 20, 40), at(2, 19, 5), at(4, 20, 15), at(5, 13)].map(burnt);
  const card = wasteReasonRepeats(evenings, NOW)!;
  assert.equal(card.title, 'Burnt 5 times this week, mostly 7–9 pm');
  assert.equal(card.detail, '5 of them Margherita · Large.');
  assert.equal(card.action.items.length, 5);
  assert.equal(card.action.items[0].at, at(0, 19, 10), 'latest first');
  assert.equal(wasteReasonRepeats(evenings.slice(0, 4), NOW), null, 'four times is not yet a pattern');
});

test('spread over the day, the card does not invent a time', () => {
  const card = wasteReasonRepeats([10, 12, 15, 18, 21].map((h, i) => burnt(at(i, h))), NOW)!;
  assert.equal(card.title, 'Burnt 5 times this week');
});

test('both cards reach Today\'s To do through the suggestions service', () => {
  const events = [...usualWeeks, flour(at(1, 10), 6000), ...[0, 1, 2, 3, 4].map((d) => burnt(at(d, 19)))];
  const ids = rulesSuggestions.insights({ events, now: NOW, stock: shop }).map((i) => i.id);
  assert.ok(ids.includes('waste-week') && ids.includes('waste-reason'), ids.join());
});
