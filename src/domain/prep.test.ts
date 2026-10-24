import test from 'node:test';
import assert from 'node:assert/strict';
import { prepQuestion, recipeQuestion, type Answer, type RecipeEvent } from './costing.ts';
import { stockFromEvents } from './inventory.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import { batchShare, checkPrepLimit, checkPrepOrder, madeFrom, prepItems, prepKey, prepStatus } from './prep.ts';
import { cookLog, queue, ticketsFromEvents } from './kitchen.ts';
import type { SyncEvent } from './sync.ts';
import { wasteRecords } from './waste.ts';
import { mayRecord } from './auth.ts';

// SCRUM-136: low stock is sent to the kitchen as a PREP ticket; Done makes the batch, and the item gets a stock of its own.

const FLOUR = 'inv-0001';
const YEAST = 'inv-0005';
const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const owner = { id: 'o1', name: 'Nisal', role: 'owner' as const };
const kasun = { id: 'c1', name: 'Kasun', role: 'cashier' as const };
const DOUGH = 'kitchen:kdough1';
let n = 0;
const id = () => `e${++n}`;

const answer = (question: string, after: Answer): RecipeEvent =>
  ({ id: id(), shopId: 's', at: 1, orderNumber: 0, actor: owner, type: 'recipe.answer_set', question, before: null, after });
/** Dough: one batch makes 20 balls from 2 kg of flour and 40 g of yeast; a Margherita L takes one ball. */
const recipes: SyncEvent[] = [
  answer(prepQuestion('kdough1'), {
    kind: 'prep', name: 'Dough', makes: { qty: 20, unit: 'pcs' },
    lines: [{ name: `stock:${FLOUR}`, qty: 2000, unit: 'g' }, { name: `stock:${YEAST}`, qty: 40, unit: 'g' }],
  }),
  answer(recipeQuestion('margherita', 'L'), { kind: 'own', lines: [{ name: DOUGH, qty: 1, unit: 'pcs' }] }),
];
const sent = (qty = 20, at = NOW - 1000, prepId = DOUGH, unit = 'pcs'): Extract<SyncEvent, { type: 'prep.ordered' }> =>
  ({ id: id(), shopId: 's', at, orderNumber: 0, actor: kasun, type: 'prep.ordered', ticketId: id(), prepId, name: 'Dough', qty, unit });
const tap = (type: 'kitchen.started' | 'kitchen.bumped' | 'kitchen.unbumped', ticketId: string, at = NOW - 950): SyncEvent =>
  ({ id: id(), shopId: 's', at, orderNumber: 0, ticketId, type });
/** Sent, started and marked Done: one batch made. */
const made = (qty = 20, at = NOW - 1000): SyncEvent[] => {
  const o = sent(qty, at);
  return [o, tap('kitchen.started', o.ticketId, at + 1), tap('kitchen.bumped', o.ticketId, at + 2)];
};
const sold = (qty: number, at = NOW - 900): SyncEvent => ({
  id: id(), shopId: 's', at, orderNumber: 1, actor: kasun, type: 'order.sent', ticketId: id(), addOn: false,
  lines: [{ id: id(), itemId: 'margherita', size: 'L', qty, adds: [], outs: [] }],
});
const limit = (after: number | null): SyncEvent =>
  ({ id: id(), shopId: 's', at: NOW - 100, orderNumber: 0, actor: owner, type: 'prep.limit_set', prepId: DOUGH, before: null, after });

const stock = (events: SyncEvent[]) => {
  const s = stockFromEvents(SEED_INVENTORY, events, { now: NOW });
  const raw = (item: string) => s.rows.find((r) => r.id === item)!.onHandBaseUnits;
  return { raw, dough: s.preps.find((p) => p.key === DOUGH) };
};

test('sent to the kitchen, it waits as a PREP ticket after the orders; nothing moves until Done', () => {
  const o = sent();
  const order = sold(1, NOW - 500);
  const tickets = queue(ticketsFromEvents([...recipes, o, order], NOW));
  assert.equal(tickets.length, 2);
  assert.equal(tickets[0].number, 1, 'the customer first');
  assert.deepEqual(tickets[1].prep, { prepId: DOUGH, name: 'Dough', qty: 20, unit: 'pcs' });
  const s = stock([...recipes, o, tap('kitchen.started', o.ticketId)]);
  assert.equal(s.raw(FLOUR), 0);
  assert.equal(s.dough?.tracked, false);
  assert.equal(s.dough?.inKitchen, 20);
  assert.equal(cookLog([o, tap('kitchen.bumped', o.ticketId)]).length, 0, 'prep is not a cooked order');
});

test('Done puts dough in stock and takes its flour and yeast', () => {
  const s = stock([...recipes, ...made()]);
  assert.equal(s.dough?.inKitchen, 0);
  assert.equal(s.dough?.onHand, 20);
  assert.equal(s.dough?.tracked, true);
  assert.equal(s.raw(FLOUR), -2000);
  assert.equal(s.raw(YEAST), -40);
});

test('after a batch, a pizza takes a dough ball, not flour again', () => {
  const s = stock([...recipes, ...made(), sold(3)]);
  assert.equal(s.dough?.onHand, 17);
  assert.equal(s.raw(FLOUR), -2000);
});

test('before any batch, a pizza takes the raw items through the dough, as before', () => {
  const s = stock([...recipes, sold(2)]);
  assert.equal(s.raw(FLOUR), -200);
  assert.equal(s.dough?.tracked ?? false, false);
});

test('Undo of Done takes the dough back and gives back the flour and yeast', () => {
  const batch = made();
  const s = stock([...recipes, ...batch, tap('kitchen.unbumped', (batch[0] as { ticketId: string }).ticketId, NOW - 500)]);
  assert.equal(s.dough?.onHand, 0);
  assert.equal(s.dough?.tracked, false);
  assert.equal(s.raw(FLOUR), 0);
  assert.equal(s.raw(YEAST), 0);
});

test('half a batch takes half the raw items', () => {
  const s = stock([...recipes, ...made(10)]);
  assert.equal(s.dough?.onHand, 10);
  assert.equal(s.raw(FLOUR), -1000);
});

test('an item whose batch size is not known yet takes no raw items (nothing is guessed)', () => {
  const unknown: SyncEvent[] = [answer(prepQuestion('kx'), {
    kind: 'prep', name: 'Sauce', makes: { qty: 1000, unit: 'g' }, lines: [{ name: `stock:${FLOUR}`, qty: 100, unit: 'g' }],
  })];
  const typed = sent(3, NOW - 1000, 'kitchen:kx', 'pcs');
  const s = stockFromEvents(SEED_INVENTORY, [...unknown, typed, tap('kitchen.bumped', typed.ticketId)], { now: NOW });
  assert.equal(s.rows.find((r) => r.id === FLOUR)!.onHandBaseUnits, 0, 'a batch in another unit than the recipe says takes nothing');
  assert.equal(s.preps.find((p) => p.key === 'kitchen:kx')?.onHand, 3);
});

test('a wasted tracked item comes off its own stock, not the raw items', () => {
  const waste: SyncEvent = {
    id: id(), shopId: 's', at: NOW - 800, orderNumber: 0, actor: owner, type: 'stock.wasted',
    what: { kind: 'prep', name: DOUGH, unit: 'pcs' }, name: 'Dough', qty: 2, reason: 'dropped',
  };
  const events = [...recipes, ...made(), waste];
  const s = stock(events);
  assert.equal(s.dough?.onHand, 18);
  assert.equal(s.raw(FLOUR), -2000);
  assert.deepEqual(wasteRecords(events)[0].takes, [{ inventoryId: `prep:${DOUGH}`, qtyBaseUnits: 2 }]);
});

test('make more: at or below his amount; empty is automatic, below a day\'s usual use', () => {
  // 14 pizzas over the usage window (14 days by default), then 12 today: about 2 balls a day.
  const week = Array.from({ length: 14 }, (_, i) => sold(1, NOW - (i + 1) * DAY + 1));
  const base = [...recipes, ...week, ...made(20), sold(12)];
  let d = stock(base).dough!;
  assert.equal(d.onHand, 8);
  assert.equal(d.usedPerDay, 26 / 14, 'the 14 days plus today\'s 12');
  assert.equal(prepStatus(d), 'ok', '8 left, about 2 a day: fine');
  d = stock([...base, limit(8)]).dough!;
  assert.equal(d.makeBelow, 8);
  assert.equal(prepStatus(d), 'low', 'at 8 or fewer with "make more when below 8"');
  d = stock([...base, limit(8), limit(null)]).dough!;
  assert.equal(prepStatus(d), 'ok', 'cleared: back to automatic');
  d = stock([...base, sold(8)]).dough!;
  assert.equal(prepStatus(d), 'out');
  assert.equal(prepStatus({ tracked: false, onHand: 0, usedPerDay: 3, makeBelow: null }), 'unknown');
});

test('the list has his items and his sheet\'s batches, each with a key his recipes use', () => {
  const answers = new Map<string, Answer>([[prepQuestion('kdough1'), (recipes[0] as Extract<RecipeEvent, { type: 'recipe.answer_set' }>).after!]]);
  const list = prepItems(answers);
  assert.equal(list[0].key, DOUGH);
  assert.deepEqual(list[0].makes, { qty: 20, unit: 'pcs' });
  assert.ok(list.some((p) => p.key === '12inch Dough Ball' && !p.own));
  assert.equal(prepKey('Dough', answers), DOUGH, 'his item by the name a sheet uses');
  assert.equal(prepKey('12inch Dough Ball', answers), '12inch Dough Ball');
  assert.equal(prepKey('Flour', answers), null);
});

test('a ticket taken back after Done unmakes the batch; a ticket taken back before Done never moved stock', () => {
  const [o, , done] = made();
  assert.equal(stock([...recipes, o, done, { id: id(), shopId: 's', at: NOW - 400, orderNumber: 0, actor: kasun, type: 'prep.order_undone', ticketId: (o as { ticketId: string }).ticketId }]).raw(FLOUR), 0);
  const waiting = sent();
  const undone: SyncEvent = { id: id(), shopId: 's', at: NOW - 400, orderNumber: 0, actor: kasun, type: 'prep.order_undone', ticketId: waiting.ticketId };
  assert.equal(stock([...recipes, waiting, undone]).dough?.inKitchen ?? 0, 0);
  assert.equal(ticketsFromEvents([waiting, undone], NOW).length, 0);
});

test('a batch needs an item, a unit and a real amount; anyone signed in sends one, managers set the limit', () => {
  assert.equal(checkPrepOrder(DOUGH, 'Dough', 20, 'pcs'), null);
  assert.ok(checkPrepOrder(DOUGH, 'Dough', 0, 'pcs'));
  assert.ok(checkPrepOrder(DOUGH, 'Dough', 5, 'kg'));
  assert.ok(checkPrepOrder('', 'Dough', 5, 'pcs'));
  assert.equal(checkPrepLimit(null), null);
  assert.ok(checkPrepLimit(0));
  assert.ok(mayRecord('cashier', 'prep.ordered'));
  assert.ok(mayRecord('kitchen', 'prep.order_undone'));
  assert.ok(!mayRecord('cashier', 'prep.limit_set'));
  assert.ok(mayRecord('manager', 'prep.limit_set'));
});

test('an item made from another is linked both ways, and a share of a batch reads as one (SCRUM-141)', () => {
  const answers = new Map<string, Answer>();
  const list = prepItems(answers);
  assert.deepEqual(madeFrom('Pizza Dough Batch', list, answers).map((p) => p.key), ['10inch Dough Ball', '12inch Dough Ball']);
  assert.deepEqual(madeFrom('Pizza Dough Culture', list, answers).map((p) => p.key), ['Pizza Dough Batch']);
  assert.deepEqual(madeFrom('12inch Dough Ball', list, answers), [], 'only dishes use the balls');
  assert.equal(batchShare({ name: 'Pizza Dough Batch', qty: 0.0833, unit: 'pcs' }, answers), '1/12 batch');
  assert.equal(batchShare({ name: 'Pizza Dough Batch', qty: 0.0476, unit: 'pcs' }, answers), '1/21 batch');
  assert.equal(batchShare({ name: 'Pizza Dough Batch', qty: 0.35, unit: 'pcs' }, answers), '0.35 batch');
  assert.equal(batchShare({ name: 'Pizza Dough Culture', qty: 1, unit: 'pcs' }, answers), null, 'a whole one reads as it is');
  assert.equal(batchShare({ name: 'Flour', qty: 0.5, unit: 'pcs' }, answers), null, 'not a semi-processed item');
});
