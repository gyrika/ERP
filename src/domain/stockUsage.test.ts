import test from 'node:test';
import assert from 'node:assert/strict';
import { ingredientQuestion, yieldQuestion, type Answer, type RecipeEvent } from './costing.ts';
import { inventoryFromEvents, stockFromEvents, stockStatus, USAGE_DAYS } from './inventory.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import { bookGaps, bookUsage } from './stockUsage.ts';
import type { SyncEvent } from './sync.ts';
import type { OrderLine } from './types.ts';

// What a sale takes, from the owner's real recipes (recipeBook.ts). SCRUM-78.

const BUN = 'inv-0052'; // 6 pcs a pack
const EGGS = 'inv-0020';
const LETTUCE = 'inv-0026';
const FLOUR = 'inv-0001'; // 25 kg sack
const ONION = 'inv-0024';
const MOZZ = 'inv-0006'; // Prabhat, 2 kg block
const DAY = 24 * 60 * 60 * 1000;

const none = new Map<string, Answer>();
const line = (itemId: string, extra: Partial<OrderLine> = {}): OrderLine =>
  ({ id: `l-${itemId}`, itemId, qty: 1, adds: [], outs: [], ...extra });
const usage = (l: OrderLine, answers = none) =>
  Object.fromEntries(bookUsage(l, answers).map((u) => [u.inventoryId, u.qtyBaseUnits]));

test('a chicken burger takes his recipe: bun, butter, lettuce, patty; unmatched sauces take nothing', () => {
  assert.deepEqual(usage(line('chicken-burger')), { [BUN]: 1, 'inv-0021': 5, [LETTUCE]: 4.6, 'inv-0018': 1 });
  assert.equal(usage(line('chicken-burger', { qty: 3 }))[BUN], 3, 'times the quantity');
});

test('a leave-out takes its line off; an extra adds his add-on recipe', () => {
  assert.equal(usage(line('chicken-burger', { outs: ['no-lettuce'] }))[LETTUCE], undefined);
  assert.equal(usage(line('cheese-onion', { size: 'M' }))[ONION], 8);
  assert.equal(usage(line('cheese-onion', { size: 'M', outs: ['no-onion'] }))[ONION], undefined);
  assert.equal(usage(line('chicken-burger', { adds: ['bullseye'] }))[EGGS], 1);
  assert.equal(usage(line('chicken-burger', { outs: ['less-spicy'] }))[LETTUCE], 4.6, 'a leave-out with no certain line changes nothing');
});

test('a pizza is traced through his dough batch to the flour sack, per size', () => {
  assert.equal(usage(line('margherita', { size: 'M' }))[FLOUR], 127.1872);
  assert.equal(usage(line('margherita', { size: 'L' }))[FLOUR], 222.5776);
});

test('a batch he has not confirmed takes nothing until he answers; then his answer is used', () => {
  const pizza = line('margherita', { size: 'L' }); // 150 g of Mozzarella Blend
  assert.equal(usage(pizza)[MOZZ], undefined);
  const answers = new Map<string, Answer>([
    [yieldQuestion('Mozzarella Blend'), { kind: 'yield', qty: 2000 }],
    [ingredientQuestion('Mozzarella A'), { kind: 'source', inventoryId: MOZZ, per: 1 }],
  ]);
  assert.equal(usage(pizza, answers)[MOZZ], 75, 'half of the blend is Mozzarella A');
});

test('a menu item with no recipe of his takes nothing', () => {
  assert.deepEqual(usage(line('no-such-item')), {});
});

// ----- in the stock fold -----

const actor = { id: 'm', name: 'Ravi', role: 'manager' as const };
const owner = { id: 'o', name: 'Owner', role: 'owner' as const };
const NOW = 50 * DAY;
const stockIn = (itemId: string, packs: number, at = 0): SyncEvent =>
  ({ id: `in-${itemId}-${at}`, shopId: 's', at, orderNumber: 0, actor, type: 'stock.adjusted', itemId, deltaPacks: packs });
const sent = (id: string, lines: OrderLine[], at = NOW): SyncEvent =>
  ({ id, shopId: 's', at, orderNumber: 7, actor, type: 'order.sent', ticketId: `t-${id}`, addOn: false, lines });
const answer = (id: string, question: string, after: Answer, at = NOW): RecipeEvent =>
  ({ id, shopId: 's', at, orderNumber: 0, actor: owner, type: 'recipe.answer_set', question, before: null, after });
const row = (events: SyncEvent[], id: string) =>
  inventoryFromEvents(SEED_INVENTORY, events, { now: NOW }).find((r) => r.id === id)!;

test('selling takes stock by itself; Undo after Send gives it back', () => {
  const burger = line('chicken-burger', { id: 'b1', qty: 2 });
  assert.equal(row([stockIn(BUN, 1), sent('s1', [burger])], BUN).onHandBaseUnits, 6 - 2);
  assert.equal(row([stockIn(BUN, 1), sent('s1', [burger]),
    { id: 'u', shopId: 's', at: NOW, orderNumber: 7, actor, type: 'order.send_undone', ticketId: 't-s1' }], BUN).onHandBaseUnits, 6);
});

test('each sale uses the answers in force when it was sold', () => {
  const blend = [
    answer('a1', yieldQuestion('Mozzarella Blend'), { kind: 'yield', qty: 2000 }),
    answer('a2', ingredientQuestion('Mozzarella A'), { kind: 'source', inventoryId: MOZZ, per: 1 }),
  ];
  const before = sent('s1', [line('margherita', { id: 'p1', size: 'L' })]);
  const after = sent('s2', [line('margherita', { id: 'p2', size: 'L' })]);
  assert.equal(row([stockIn(MOZZ, 1), before, ...blend, after], MOZZ).onHandBaseUnits, 2000 - 75,
    'the pizza sold before he answered still takes nothing');
});

test('lasts about N days: the last 7 days of sales against what is left', () => {
  const sales = Array.from({ length: USAGE_DAYS }, (_, d) =>
    sent(`d${d}`, [line('chicken-burger', { id: `b${d}`, qty: 2 })], NOW - d * DAY - 1));
  const old = sent('old', [line('chicken-burger', { id: 'old', qty: 50 })], NOW - 30 * DAY);
  const bun = row([stockIn(BUN, 10), old, ...sales], BUN); // 60 - 50 - 14 = -4: none left
  assert.equal(bun.usedPerDay, 2, 'only the last 7 days count');
  assert.equal(bun.lastsDays, null, 'nothing left: no days to show');

  const restocked = row([stockIn(BUN, 20), old, ...sales], BUN); // 120 - 64 = 56 buns
  assert.equal(restocked.lastsDays, 28);
});

test('a newer shop divides by the days it has sold, and an uncounted item has no estimate', () => {
  const twoDays = [sent('a', [line('chicken-burger', { id: 'a', qty: 6 })], NOW - 2 * DAY)];
  assert.equal(row([stockIn(BUN, 2), ...twoDays], BUN).usedPerDay, 3);
  assert.equal(row(twoDays, BUN).lastsDays, null);
});

// ----- what the stock cannot know (an unconfirmed batch, a menu item with no recipe) -----

const SUGO = 'inv-0009'; // in his Pizza Sauce Batch, whose output he has not confirmed
const count = (itemId: string, packs: number, at: number): SyncEvent =>
  ({ id: `c-${itemId}-${at}`, shopId: 's', at, orderNumber: 0, actor, type: 'stock.adjusted', itemId, deltaPacks: packs, reason: 'audit' });

test('a sale names the items an unconfirmed batch held back, and a menu item with no recipe', () => {
  assert.ok(bookGaps(line('margherita', { size: 'L' }), none).items.includes(SUGO));
  assert.deepEqual(bookGaps(line('chicken-burger'), none), { untracked: false, items: [] });
  assert.deepEqual(bookGaps(line('no-such-item'), none), { untracked: true, items: [] });
  const confirmed = new Map<string, Answer>([[yieldQuestion('Pizza Sauce Batch'), { kind: 'yield', qty: 3000 }]]);
  assert.ok(!bookGaps(line('margherita', { size: 'L' }), confirmed).items.includes(SUGO), 'once he answers, it is taken');
});

test('missed sales since the last count make an item Check shelf; a new count clears them', () => {
  const pizzas = sent('p', [line('margherita', { id: 'p1', size: 'L', qty: 3 })], NOW - DAY);
  const before = row([stockIn(SUGO, 5), pizzas], SUGO);
  assert.equal(before.missedSales, 3);
  assert.equal(stockStatus(before), 'unsure');

  const after = row([stockIn(SUGO, 5), pizzas, count(SUGO, -1, NOW - 1)], SUGO);
  assert.equal(after.missedSales, 0, 'the count saw the real shelf');
  assert.equal(stockStatus(after), 'ok');
});

test('missed sales never hide low or out: the real shelf can only be lower', () => {
  const pizzas = sent('p', [line('margherita', { id: 'p1', size: 'L' })], NOW - DAY);
  assert.equal(stockStatus(row([stockIn(SUGO, 1), pizzas], SUGO)), 'low');
});

test('Undo after Send and a cancelled line take their missed sales back', () => {
  const pizzas = sent('p', [line('margherita', { id: 'p1', size: 'L', qty: 2 })], NOW - DAY);
  const undone: SyncEvent = { id: 'u', shopId: 's', at: NOW - DAY, orderNumber: 7, actor, type: 'order.send_undone', ticketId: 't-p' };
  assert.equal(row([stockIn(SUGO, 5), pizzas, undone], SUGO).missedSales, 0);
  const cancelled: SyncEvent = {
    id: 'x', shopId: 's', at: NOW - DAY, orderNumber: 7, actor, type: 'order.item_cancelled',
    lineId: 'p1', index: 0, before: line('margherita', { id: 'p1', size: 'L', qty: 2 }), reason: 'dropped', totalBefore: 0, totalAfter: 0,
  };
  assert.equal(row([stockIn(SUGO, 5), pizzas, cancelled], SUGO).missedSales, 0);
});

test('items sold this week with no recipe are counted once, by quantity', () => {
  const events = [
    sent('a', [line('no-such-item', { id: 'n1', qty: 2 }), line('chicken-burger', { id: 'b1' })], NOW - DAY),
    sent('old', [line('no-such-item', { id: 'n2', qty: 5 })], NOW - 30 * DAY),
  ];
  assert.equal(stockFromEvents(SEED_INVENTORY, events, { now: NOW }).untrackedSold, 2);
});
