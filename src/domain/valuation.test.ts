import test from 'node:test';
import assert from 'node:assert/strict';
import { answersFromEvents, prepQuestion, type Answer, type RecipeEvent } from './costing.ts';
import { stockFromEvents } from './inventory.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import { itemHistory } from './itemStory.ts';
import type { SyncEvent } from './sync.ts';
import { RISE_MIN_CENTS, stockValueRose, trendDays, valuationOf, valueAt, type Valuation } from './valuation.ts';

// SCRUM-163: stock value = on hand × unit cost, from the stock the shop already keeps.

const FLOUR = 'inv-0001'; // Rs 6,400 a 25 kg bag: 25.6 cents a gram
const YEAST = 'inv-0005'; // Rs 460 for 60 g
const DOUGH = 'kitchen:kdough1';
const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const owner = { id: 'o1', name: 'Nisal', role: 'owner' as const };
const kasun = { id: 'c1', name: 'Kasun', role: 'cashier' as const };
let n = 0;
const id = () => `v${++n}`;

const answer = (question: string, after: Answer): RecipeEvent =>
  ({ id: id(), shopId: 's', at: 1, orderNumber: 0, actor: owner, type: 'recipe.answer_set', question, before: null, after });
/** Dough: 20 balls from 2 kg of flour and 40 g of yeast. */
const dough = answer(prepQuestion('kdough1'), {
  kind: 'prep', name: 'Dough', makes: { qty: 20, unit: 'pcs' },
  lines: [{ name: `stock:${FLOUR}`, qty: 2000, unit: 'g' }, { name: `stock:${YEAST}`, qty: 40, unit: 'g' }],
});
const counted = (itemId: string, qty: number, at = NOW - 5000, expected = 0): SyncEvent =>
  ({ id: id(), shopId: 's', at, orderNumber: 0, actor: owner, type: 'stock.counted', itemId, counted: qty, expected, entries: [], reason: null, valueCents: 0, tier: 'daily' });
const madeBatch = (at = NOW - 1000): SyncEvent[] => {
  const ticketId = id();
  return [
    { id: id(), shopId: 's', at, orderNumber: 0, actor: kasun, type: 'prep.ordered', ticketId, prepId: DOUGH, name: 'Dough', qty: 20, unit: 'pcs' },
    { id: id(), shopId: 's', at: at + 1, orderNumber: 0, ticketId, type: 'kitchen.started' },
    { id: id(), shopId: 's', at: at + 2, orderNumber: 0, ticketId, type: 'kitchen.bumped' },
  ];
};
const price = (itemId: string, before: number, after: number, at = NOW - 500): SyncEvent =>
  ({ id: id(), shopId: 's', at, orderNumber: 0, actor: owner, type: 'stock.price_set', itemId, before, after });

const value = (events: SyncEvent[]) => valuationOf(stockFromEvents(SEED_INVENTORY, events, { now: NOW }), answersFromEvents(events));
const of = (v: Valuation, nodeId: string) => v.items.find((x) => x.id === nodeId);

test('a counted raw item is worth on hand × its price per base unit', () => {
  const v = value([counted(FLOUR, 5000)]);
  assert.equal(of(v, `stock:${FLOUR}`)?.cents, 128000); // 5 kg × 25.6 cents
  assert.equal(of(v, `stock:${FLOUR}`)?.unitCents, 25.6);
  assert.equal(v.byKind.raw, 128000);
  assert.equal(v.total, 128000);
});

test('an item never counted has no value, not a fake zero, and is left out of the total', () => {
  const v = value([counted(FLOUR, 5000)]);
  assert.equal(of(v, `stock:${YEAST}`)?.cents, null);
  assert.equal(v.notCounted, SEED_INVENTORY.length - 1);
});

test('making a batch moves value from raw to semi-processed: the total stays the same (no double counting)', () => {
  const before = value([dough, counted(FLOUR, 5000), counted(YEAST, 60)]);
  const after = value([dough, counted(FLOUR, 5000), counted(YEAST, 60), ...madeBatch()]);
  assert.equal(before.total, 174000);
  assert.equal(of(after, `stock:${FLOUR}`)?.cents, 76800);
  const ball = of(after, `semi:${DOUGH}`)!;
  assert.equal(ball.name, 'Dough');
  assert.equal(ball.qty, 20);
  assert.ok(Math.abs(ball.unitCents! - 81866.67 / 20) < 0.01, 'one ball: the batch cost over 20');
  assert.equal(after.byKind.semi, ball.cents);
  assert.equal(after.byKind.finished, 0, 'made to order: counted in its inputs');
  assert.ok(Math.abs(after.total - before.total) <= 1, 'only rounding');
});

test('a price change moves the value with it', () => {
  const v = value([counted(FLOUR, 5000), price(FLOUR, 640000, 800000)]);
  assert.equal(of(v, `stock:${FLOUR}`)?.cents, 160000);
});

test('stock below zero (sold more than recorded) is worth nothing, not a negative', () => {
  const v = value([counted(FLOUR, 0), counted(FLOUR, -3000)]);
  assert.equal(of(v, `stock:${FLOUR}`)?.cents, 0);
});

test('valueAt reads the stock as it stood then', () => {
  const events = [counted(FLOUR, 5000, NOW - 3 * DAY), counted(YEAST, 60, NOW - DAY)];
  assert.equal(valueAt(SEED_INVENTORY, events, NOW - 2 * DAY).total, 128000);
  assert.equal(valueAt(SEED_INVENTORY, events, NOW).total, 174000);
});

test('the trend has one point a day, oldest first, today ending now', () => {
  const days = trendDays(NOW);
  assert.equal(days.length, 30);
  assert.equal(days[29], NOW);
  assert.ok(days.every((d, i) => i === 0 || d > days[i - 1]));
});

test('the owner hears of a big rise in stock value, never of a small one', () => {
  const weekAgo = value([counted(FLOUR, 50000)]); // Rs 12,800
  const big = value([counted(FLOUR, 50000), counted(FLOUR, 125000, NOW - 4000, 50000)]); // Rs 32,000
  const card = stockValueRose(big, weekAgo);
  assert.ok(card);
  assert.equal(card.title, 'Stock value up 150% this week');
  assert.equal(card.action.items[0].primary, 'Pizza Flour');
  assert.equal(card.action.items[0].amount, 1920000);
  const small = value([counted(FLOUR, 50000), counted(FLOUR, 60000, NOW - 4000, 50000)]); // +Rs 2,560
  assert.ok(2560_00 < RISE_MIN_CENTS);
  assert.equal(stockValueRose(small, weekAgo), null);
});

test("an item's history puts a value on each delivery at that day's price", () => {
  const received = (packs: number, at: number): SyncEvent =>
    ({ id: id(), shopId: 's', at, orderNumber: 0, actor: owner, type: 'stock.adjusted', itemId: FLOUR, deltaPacks: packs, reason: 'receive' });
  const events = [received(2, NOW - 3 * DAY), price(FLOUR, 640000, 800000, NOW - 2 * DAY), received(1, NOW - DAY)];
  const deliveries = itemHistory(events, FLOUR, 25000, 800000).filter((h) => h.kind === 'delivery');
  assert.deepEqual(deliveries.map((h) => h.kind === 'delivery' && h.valueCents), [800000, 1280000]); // newest first
  assert.ok(itemHistory(events, FLOUR, 25000).every((h) => !('valueCents' in h)), 'no price given: no value');
});
