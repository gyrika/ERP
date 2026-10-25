import test from 'node:test';
import assert from 'node:assert/strict';
import { prepQuestion, recipeQuestion, type Answer, type RecipeEvent } from './costing.ts';
import { stockFromEvents } from './inventory.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import { itemStockOf } from './itemStock.ts';
import { queue, ticketsFromEvents } from './kitchen.ts';
import { canMake, ledgerOf, planNotice, planProduction, type Plan } from './production.ts';
import { holdsBatches, releasesDue, releaseText } from './scheduler.ts';
import type { SyncEvent } from './sync.ts';
import { mayRecord } from './auth.ts';

// Production with its dependencies: Culture › Dough › Dough Ball › Pizza, on the one stock ledger.

const FLOUR = 'inv-0001';
const YEAST = 'inv-0005';
const NOW = 100 * 24 * 60 * 60 * 1000;
const owner = { id: 'o1', name: 'Nisal', role: 'owner' as const };
const kasun = { id: 'c1', name: 'Kasun', role: 'cashier' as const };
const CULTURE = 'kitchen:kculture';
const DOUGH = 'kitchen:kdough';
const BALL = 'kitchen:kball';
let n = 0;
const id = () => `e${++n}`;
let clock = NOW - 10_000;
const at = () => ++clock;

const answer = (question: string, after: Answer): RecipeEvent =>
  ({ id: id(), shopId: 's', at: 1, orderNumber: 0, actor: owner, type: 'recipe.answer_set', question, before: null, after });

/** 10 kg of dough takes 2 kg of culture and 8 kg of flour; one culture batch makes `cultureBatch` g. */
const recipes = (cultureBatch = 2000): SyncEvent[] => [
  answer(prepQuestion('kculture'), {
    kind: 'prep', name: 'Culture', makes: { qty: cultureBatch, unit: 'g' },
    lines: [{ name: `stock:${FLOUR}`, qty: cultureBatch / 2, unit: 'g' }, { name: `stock:${YEAST}`, qty: 50, unit: 'g' }],
  }),
  answer(prepQuestion('kdough'), {
    kind: 'prep', name: 'Dough', makes: { qty: 10000, unit: 'g' },
    lines: [{ name: CULTURE, qty: 2000, unit: 'g' }, { name: `stock:${FLOUR}`, qty: 8000, unit: 'g' }],
  }),
  answer(prepQuestion('kball'), {
    kind: 'prep', name: 'Dough Ball', makes: { qty: 40, unit: 'pcs' }, lines: [{ name: DOUGH, qty: 10000, unit: 'g' }],
  }),
  answer(recipeQuestion('margherita', 'L'), { kind: 'own', lines: [{ name: BALL, qty: 1, unit: 'pcs' }] }),
];

const counted = (itemId: string, qtyBase: number): SyncEvent =>
  ({ id: id(), shopId: 's', at: at(), orderNumber: 0, actor: owner, type: 'stock.movement', itemId, kind: 'COUNT_ADJUST', qtyBase, docId: 'count' });
const delivered = (itemId: string, qtyBase: number): SyncEvent =>
  ({ id: id(), shopId: 's', at: at(), orderNumber: 0, actor: owner, type: 'stock.movement', itemId, kind: 'GRN', qtyBase, docId: 'grn' });
const done = (ticketId: string): SyncEvent => ({ id: id(), shopId: 's', at: at(), orderNumber: 0, ticketId, type: 'kitchen.bumped' });

const names: Record<string, string> = { [`semi:${CULTURE}`]: 'Culture', [`semi:${DOUGH}`]: 'Dough', [`semi:${BALL}`]: 'Dough Ball', [`stock:${FLOUR}`]: 'Flour', [`stock:${YEAST}`]: 'Yeast' };
const nameOf = (x: string) => names[x] ?? x;
const stock = (events: SyncEvent[]) => stockFromEvents(SEED_INVENTORY, events, { now: NOW });
const plan = (events: SyncEvent[], key: string, qty: number, unit: string) =>
  planProduction({ key, name: nameOf(`semi:${key}`), qty, unit }, stock(events).ledger, nameOf);

/** What sendPlan writes: the batches in order, the last one held for the rest. */
const send = (p: Plan): Extract<SyncEvent, { type: 'prep.ordered' }>[] => {
  const ids = p.batches.map(() => id());
  return p.batches.map((b, i) => ({
    id: id(), shopId: 's', at: at(), orderNumber: 0, actor: kasun, type: 'prep.ordered', ticketId: ids[i], prepId: b.prepId, name: b.name, qty: b.qty, unit: b.unit,
    ...(b.waitFor.length ? { waitFor: b.waitFor } : {}), ...(i < ids.length - 1 ? { plan: ids.at(-1) } : {}),
  }));
};
/** The shop server's turn: what it releases now. */
const release = (events: SyncEvent[]) => releasesDue(SEED_INVENTORY, events, 's', at());
const kitchen = (events: SyncEvent[]) => queue(ticketsFromEvents(events, NOW)).map((t) => t.prep?.name);

test('culture missing: it goes to the kitchen first, the dough waits for it', () => {
  const base = recipes();
  const p = plan(base, DOUGH, 10000, 'g');
  assert.equal(p.problem, null);
  assert.deepEqual(p.batches.map((b) => [b.name, b.qty, b.waitFor]), [['Culture', 2000, []], ['Dough', 10000, ['Culture']]]);
  assert.equal(planNotice(p, (q, u) => `${q} ${u}`), 'Culture sent to the kitchen first. Dough will be sent automatically when ready.');
  const sent = send(p);
  const events = [...base, ...sent];
  assert.deepEqual(kitchen(events), ['Culture'], 'only the culture is on the kitchen screen');
  assert.ok(holdsBatches(events));
  assert.deepEqual(release(events), [], 'nothing to release while the culture is being made');
  const s = stock(events);
  assert.deepEqual(itemStockOf(`semi:${DOUGH}`, s)?.waitingFor, ['Culture']);
  assert.equal(itemStockOf(`semi:${CULTURE}`, s)?.inKitchen, 2000);
  assert.equal(s.production.length, 2);
});

test('culture Done: the dough is released once, takes the culture when it is Done', () => {
  const base = recipes();
  const [culture, dough] = send(plan(base, DOUGH, 10000, 'g'));
  let events = [...base, culture, dough, done(culture.ticketId)];
  const rel = release(events);
  assert.equal(rel.length, 1);
  assert.equal(rel[0].type === 'prep.released' && rel[0].ticketId, dough.ticketId);
  assert.equal(rel[0].id, `rel-${dough.ticketId}`, 'its id comes from the batch: stored twice, stored once');
  assert.equal(rel[0].type === 'prep.released' && releaseText(rel[0]), 'Culture is ready. Dough sent to the kitchen automatically.');
  events = [...events, ...rel];
  assert.deepEqual(release(events), [], 'never released twice');
  assert.equal(holdsBatches(events), false);
  assert.deepEqual(kitchen(events), ['Dough']);
  let s = stock(events);
  assert.equal(itemStockOf(`semi:${CULTURE}`, s)?.onHand, 2000);
  assert.equal(itemStockOf(`semi:${CULTURE}`, s)?.reserved, 2000, 'the dough in the kitchen holds the culture');
  assert.equal(itemStockOf(`semi:${CULTURE}`, s)?.available, 0);
  events = [...events, done(dough.ticketId)];
  s = stock(events);
  assert.equal(itemStockOf(`semi:${CULTURE}`, s)?.onHand, 0, 'taken once, when the dough is made');
  assert.equal(itemStockOf(`semi:${CULTURE}`, s)?.reserved, 0);
  assert.equal(itemStockOf(`semi:${DOUGH}`, s)?.onHand, 10000);
  assert.equal(s.rows.find((r) => r.id === FLOUR)!.onHandBaseUnits, -9000, '1 kg for the culture, 8 kg for the dough: each once');
});

test('enough culture on hand: the dough goes straight to the kitchen; part of it: only the rest is made, in whole batches', () => {
  const base = recipes(1500);
  const first = send(plan(base, CULTURE, 3000, 'g'));
  const made = [...base, ...first, done(first[0].ticketId)];
  const straight = plan(made, DOUGH, 10000, 'g');
  assert.deepEqual(straight.batches.map((b) => b.name), ['Dough']);
  assert.deepEqual(straight.batches[0].waitFor, []);

  const half = [...base, ...send(plan(base, CULTURE, 1500, 'g'))];
  const halfDone = [...half, done((half.at(-1) as { ticketId: string }).ticketId)];
  const p = plan(halfDone, DOUGH, 10000, 'g');
  assert.deepEqual(p.batches.map((b) => [b.name, b.qty]), [['Culture', 1500], ['Dough', 10000]], '500 g short: one batch of 1500 g');
});

test('no duplicate orders: culture already coming and not spoken for is counted on', () => {
  const base = recipes(5000); // one culture batch covers two doughs
  const one = send(plan(base, DOUGH, 10000, 'g'));
  const events = [...base, ...one];
  const two = plan(events, DOUGH, 10000, 'g');
  assert.deepEqual(two.batches.map((b) => [b.name, b.waitFor]), [['Dough', ['Culture']]], 'waits for the culture already in the kitchen');
  assert.equal(planNotice(two, (q, u) => `${q} ${u}`), 'Dough is waiting for Culture, already being made. It goes to the kitchen automatically when ready.');
  const all = [...events, ...send(two), done(one[0].ticketId)];
  const rel = release(all);
  assert.equal(rel.length, 2, 'both doughs go once the 5 kg is made');
  const three = plan([...all, ...rel], DOUGH, 10000, 'g');
  assert.deepEqual(three.batches.map((b) => b.name), ['Culture', 'Dough'], 'the rest of that batch is spoken for: a new one is made');
});

test('three levels: culture, then dough, then the balls, each released when the one before is Done', () => {
  const base = recipes();
  const p = plan(base, BALL, 40, 'pcs');
  assert.deepEqual(p.batches.map((b) => [b.name, b.waitFor]), [['Culture', []], ['Dough', ['Culture']], ['Dough Ball', ['Dough']]]);
  const [culture, dough, ball] = send(p);
  let events: SyncEvent[] = [...base, culture, dough, ball, done(culture.ticketId)];
  let rel = release(events);
  assert.deepEqual(rel.map((e) => e.type === 'prep.released' && e.name), ['Dough'], 'the balls still wait for the dough');
  events = [...events, ...rel, done(dough.ticketId)];
  rel = release(events);
  assert.deepEqual(rel.map((e) => e.type === 'prep.released' && e.name), ['Dough Ball']);
  events = [...events, ...rel, done(ball.ticketId)];
  const s = stock(events);
  assert.equal(itemStockOf(`semi:${BALL}`, s)?.onHand, 40);
  assert.equal(itemStockOf(`semi:${DOUGH}`, s)?.onHand, 0);
  assert.equal(itemStockOf(`recipe:margherita:L`, s)?.canMake, 40, 'a finished dish: how many can be made now');
  assert.equal(canMake('margherita', 'L', s.ledger), 40);
});

test('raw material short: it is to be bought and the batch waits; stock goes up only with the delivery', () => {
  const base = [...recipes(), counted(FLOUR, 3000), counted(YEAST, 500)];
  const p = plan(base, CULTURE, 2000, 'g');
  assert.deepEqual(p.batches.map((b) => b.waitFor), [[]], '1 kg of 3 kg flour: enough');
  const big = plan(base, DOUGH, 10000, 'g');
  assert.deepEqual(big.batches.map((b) => [b.name, b.waitFor]), [['Culture', []], ['Dough', ['Culture', 'Flour']]]);
  assert.equal(big.buy.get(FLOUR), 6000, '1 kg for the culture leaves 2 kg; the dough needs 8 kg');
  assert.equal(planNotice(big, (q, u) => `${q} ${u}`), 'Culture sent to the kitchen first. Dough will be sent automatically when ready. Waiting for Flour to be received.');
  const sent = send(big);
  let events = [...base, ...sent, done(sent[0].ticketId)];
  assert.deepEqual(release(events), [], 'the culture is there, the flour is not');
  const s = stock(events);
  assert.equal(s.rows.find((r) => r.id === FLOUR)!.onHandBaseUnits, 2000, 'nothing added for flour not received');
  assert.equal(itemStockOf(`stock:${FLOUR}`, s)?.short, 6000);
  events = [...events, delivered(FLOUR, 6000)];
  assert.equal(release(events).length, 1, 'received: the dough goes');
});

test('flour never counted is not known, so it holds nothing back', () => {
  const p = plan(recipes(), CULTURE, 2000, 'g');
  assert.deepEqual(p.batches[0].waitFor, []);
  assert.equal(p.buy.size, 0);
});

test('taken back before it went: never released, and a late release never reaches the kitchen', () => {
  const base = recipes();
  const [culture, dough] = send(plan(base, DOUGH, 10000, 'g'));
  const undo: SyncEvent = { id: id(), shopId: 's', at: at(), orderNumber: 0, actor: kasun, type: 'prep.order_undone', ticketId: dough.ticketId };
  const events = [...base, culture, dough, undo, done(culture.ticketId)];
  assert.deepEqual(release(events), []);
  const late: SyncEvent = { id: `rel-${dough.ticketId}`, shopId: 's', at: at(), orderNumber: 0, actor: owner, type: 'prep.released', ticketId: dough.ticketId, prepId: DOUGH, name: 'Dough', qty: 10000, unit: 'g', waited: ['Culture'] };
  assert.deepEqual(kitchen([...events, late]), []);
});

test('a recipe made from itself is refused, not planned forever', () => {
  // Saving one is refused already (makesLoop); the planner stops on its own too.
  const answers = new Map<string, Answer>([
    [prepQuestion('kculture'), { kind: 'prep', name: 'Culture', makes: { qty: 2000, unit: 'g' }, lines: [{ name: DOUGH, qty: 100, unit: 'g' }] }],
    [prepQuestion('kdough'), { kind: 'prep', name: 'Dough', makes: { qty: 10000, unit: 'g' }, lines: [{ name: CULTURE, qty: 2000, unit: 'g' }] }],
  ]);
  const ledger = ledgerOf({ answers, tracked: new Map(), onHand: new Map(), open: [], waiting: [] });
  const p = planProduction({ key: DOUGH, name: 'Dough', qty: 10000, unit: 'g' }, ledger, nameOf);
  assert.match(p.problem ?? '', /made from itself/);
  assert.equal(p.batches.length, 0);
});

test('only the shop server releases batches', () => {
  for (const role of ['cashier', 'kitchen', 'manager', 'owner'] as const) assert.ok(!mayRecord(role, 'prep.released'));
});
