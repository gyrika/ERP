import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answersFromEvents, batchQuestion, checkAnswer, menuCost, RATES_QUESTION, recipeQuestion, resourcesQuestion, stockLine, type Answer,
} from './costing.ts';
import { mayRecord } from './auth.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import { MENU } from './menu.ts';
import { draftsFromEvents, publishPlan, versionsOf, withDrafts } from './recipeDrafts.ts';
import { bookUsage } from './stockUsage.ts';
import {
  buildFlow, COL_W, connectProblem, holderOf, layout, lineFor, moneyOf, newStage, soldUnits, viewOf,
} from './visualFlow.ts';
import { validatePush } from '../../server/validate.ts';

const ctx = (answers: [string, Answer][] = []) => ({ items: SEED_INVENTORY, answers: new Map(answers) });
const per = (id: string) => { const i = SEED_INVENTORY.find((x) => x.id === id)!; return i.workingPriceCents / i.packQty; };
const MARGHERITA = recipeQuestion('margherita', 'L');
const owner = { id: 'owner-1', name: 'Owner', role: 'owner' as const };

test('a 12" Margherita flows from flour through culture, dough batch and dough ball, at the Recipes screen\'s cost', () => {
  const g = buildFlow({ focus: MARGHERITA, ctx: ctx(), menu: MENU });
  const level = (id: string) => g.nodes.find((n) => n.id === id)!.level;
  // Culture → Dough → Dough ball → Pizza, each a column further right.
  assert.ok(level('semi:Pizza Dough Culture') < level('semi:Pizza Dough Batch'));
  assert.ok(level('semi:Pizza Dough Batch') < level('semi:12inch Dough Ball'));
  assert.ok(level('semi:12inch Dough Ball') < level(MARGHERITA));
  assert.equal(level('stock:inv-0001'), 0);
  // Flour: 0.0833 of a dough batch, which holds 2,550 g and one culture of 122 g.
  const flour = g.nodes.find((n) => n.id === 'stock:inv-0001')!;
  assert.ok(Math.abs(flour.qty - 0.0833 * (2550 + 122)) < 1e-9);
  assert.equal(flour.unit, 'g');
  // The same food cost as the Recipes screen, and no resources yet.
  assert.equal(Math.round(g.breakdown.materials), menuCost('margherita', 'L', ctx()).cents);
  assert.equal(g.breakdown.total, g.breakdown.materials);
  assert.equal(g.complete, true);
  // What flows into the pizza adds up to its cost.
  const into = g.edges.filter((e) => e.target === MARGHERITA).reduce((s, e) => s + e.cents, 0);
  assert.ok(Math.abs(into - g.breakdown.total) < 1e-6);
});

test('wastage takes more, in the cost and in the stock a sale takes', () => {
  const lines = [{ name: stockLine('inv-0001'), qty: 100, unit: 'g', waste: 0.2 }];
  const c = ctx([[MARGHERITA, { kind: 'own', lines }]]);
  assert.equal(checkAnswer(MARGHERITA, { kind: 'own', lines }), null);
  assert.ok(checkAnswer(MARGHERITA, { kind: 'own', lines: [{ ...lines[0], waste: 0.95 }] }));
  assert.equal(menuCost('margherita', 'L', c).cents, Math.round(125 * per('inv-0001')));
  const used = bookUsage({ itemId: 'margherita', qty: 2, size: 'L', adds: [], outs: [] }, c.answers);
  assert.deepEqual(used, [{ inventoryId: 'inv-0001', qtyBaseUnits: 250 }]);
  const g = buildFlow({ focus: MARGHERITA, ctx: c, menu: MENU });
  assert.equal(g.edges[0].qty, 125);
});

test('resources roll up from a batch into each pizza, at the shop\'s rates', () => {
  const rates: Answer = { kind: 'rates', rates: { electricity: 5000, labour: 30000, equipment: 6000 } };
  const dough: Answer = { kind: 'resources', lines: [{ kind: 'labour', qty: 30, label: 'Kneading' }, { kind: 'electricity', qty: 2 }] };
  const pizza: Answer = { kind: 'resources', lines: [{ kind: 'equipment', qty: 10, label: 'Oven' }, { kind: 'other', cents: 2000, label: 'Box' }] };
  assert.equal(checkAnswer(resourcesQuestion('Pizza Dough Batch'), dough), null);
  assert.equal(checkAnswer(RATES_QUESTION, rates), null);
  const c = ctx([[RATES_QUESTION, rates], [resourcesQuestion('Pizza Dough Batch'), dough], [resourcesQuestion(MARGHERITA), pizza]]);
  const g = buildFlow({ focus: MARGHERITA, ctx: c, menu: MENU });
  // 0.0833 of a batch: half an hour of labour at Rs 300/h, 2 kWh at Rs 50.
  assert.ok(Math.abs(g.breakdown.labour - 0.0833 * 15000) < 1e-6);
  assert.ok(Math.abs(g.breakdown.electricity - 0.0833 * 10000) < 1e-6);
  assert.ok(Math.abs(g.breakdown.overhead - (1000 + 2000)) < 1e-6); // 10 min of oven + the box
  assert.ok(Math.abs(g.breakdown.total - (g.breakdown.materials + g.breakdown.labour + g.breakdown.electricity + g.breakdown.overhead)) < 1e-6);
  // The dough ball carries the batch's labour into the pizza.
  const ball = g.edges.find((e) => e.source === 'semi:12inch Dough Ball' && e.target === MARGHERITA)!;
  assert.ok(ball.cents > 0.0833 * 15000);
  // Food cost (the Recipes screen) stays ingredients only.
  assert.equal(menuCost('margherita', 'L', c).cents, menuCost('margherita', 'L', ctx()).cents);
  // With no rates, the labour costs nothing yet and the rates are asked for.
  const unrated = buildFlow({ focus: MARGHERITA, ctx: ctx([[resourcesQuestion('Pizza Dough Batch'), dough]]), menu: MENU });
  assert.equal(unrated.breakdown.labour, 0);
  assert.ok(unrated.missing.includes(RATES_QUESTION));
});

test('the Financial view: price, whole cost and profit, and what sold', () => {
  const at = 1_800_000_000_000;
  const line = { id: 'l1', itemId: 'margherita', size: 'L', qty: 3, adds: [], outs: [], unit: 0 };
  const events = [
    { type: 'order.sent', at, ticketId: 't1', lines: [line, { ...line, id: 'l2', itemId: 'veggie', half: 'margherita', qty: 1 }] },
    { type: 'order.sent', at, ticketId: 't2', lines: [{ ...line, qty: 5 }] },
    { type: 'order.send_undone', at, ticketId: 't2' },
    { type: 'order.sent', at: at - 40 * 86_400_000, ticketId: 't0', lines: [line] }, // too long ago
  ];
  const sold = soldUnits(events, MARGHERITA, at + 1000);
  assert.equal(sold, 3.5);
  const g = viewOf(buildFlow({ focus: MARGHERITA, ctx: ctx(), menu: MENU, sold }), 'financial');
  const money = moneyOf(g)!;
  const price = MENU.find((m) => m.id === 'margherita')!.variants!.find((v) => v.id === 'L')!.price;
  assert.equal(money.revenue, price);
  assert.equal(money.profit, price - money.cost);
  assert.ok(g.nodes.some((n) => n.id === 'profit') && g.edges.some((e) => e.id === 'revenue>profit'));
  assert.equal(viewOf(g, 'material').nodes.length, g.nodes.length); // other views add nothing
});

test('collapsing a stage hides what flows only through it; layout puts columns by level', () => {
  const full = buildFlow({ focus: MARGHERITA, ctx: ctx(), menu: MENU });
  const folded = buildFlow({ focus: MARGHERITA, ctx: ctx(), menu: MENU, collapsed: new Set(['semi:12inch Dough Ball']) });
  assert.ok(folded.nodes.some((n) => n.id === 'semi:12inch Dough Ball' && n.collapsed && n.inputs === 1));
  assert.ok(!folded.nodes.some((n) => n.id === 'semi:Pizza Dough Culture'));
  assert.ok(!folded.nodes.some((n) => n.id === 'stock:inv-0005')); // yeast is only in the dough
  assert.ok(folded.nodes.some((n) => n.id === 'stock:inv-0004')); // salt is in the sauce too
  assert.equal(folded.breakdown.total, full.breakdown.total); // hiding changes no cost
  const pos = layout(full);
  for (const n of full.nodes) assert.equal(pos.get(n.id)!.x, n.level * COL_W);
});

test('drafts change nothing until published; publishing is a new version that closes the draft', () => {
  const base = { shopId: 's', orderNumber: 0, actor: owner };
  const lines = [{ name: stockLine('inv-0001'), qty: 200, unit: 'g' }];
  const draft = { ...base, id: 'd1', at: 10, type: 'recipe.draft_set', question: MARGHERITA, after: { kind: 'own', lines } };
  const events: { type: string; [k: string]: unknown }[] = [draft];
  assert.equal(answersFromEvents(events).size, 0);
  const drafts = draftsFromEvents(events);
  assert.equal(drafts.size, 1);
  const preview = withDrafts(answersFromEvents(events), drafts);
  assert.equal(menuCost('margherita', 'L', { items: SEED_INVENTORY, answers: preview }).cents, Math.round(200 * per('inv-0001')));
  const plan = publishPlan(new Map(), drafts);
  assert.deepEqual(plan.map((p) => p.problem), [null]);
  events.push({ ...base, id: 'a1', at: 20, type: 'recipe.answer_set', question: MARGHERITA, before: null, after: plan[0].after });
  assert.equal(draftsFromEvents(events).size, 0);
  events.push({ ...base, id: 'a2', at: 30, type: 'recipe.answer_set', question: MARGHERITA, before: plan[0].after, after: null });
  assert.deepEqual(versionsOf(events, MARGHERITA).map((v) => [v.n, v.answer?.kind ?? null]), [[1, 'own'], [2, null]]);
  // Dropping a draft.
  const dropped = [draft, { ...draft, id: 'd2', after: null }];
  assert.equal(draftsFromEvents(dropped).size, 0);
  // Only the owner drafts; the server keeps a well-formed draft and refuses a malformed one.
  assert.equal(mayRecord('owner', 'recipe.draft_set'), true);
  assert.equal(mayRecord('manager', 'recipe.draft_set'), false);
  assert.ok('events' in validatePush({ events: [draft] }, 's'));
  assert.ok('reason' in validatePush({ events: [{ ...draft, after: { kind: 'own', lines: 'x' } }] }, 's'));
});

test('a new stage, connections and what may not go where', () => {
  const answers = new Map<string, Answer>();
  const pizza = holderOf(MARGHERITA, answers, MENU)!;
  const made = newStage('Garlic Oil', pizza, answers);
  assert.ok(made.drafts);
  const [[stageQ, stage], [parentQ, parent]] = made.drafts!;
  assert.equal(parentQ, MARGHERITA);
  assert.ok(parent.kind === 'own' && parent.lines.length === pizza.lines.length + 1);
  // Nothing in it yet: the draft is kept, but it can't be published like that.
  const drafts = new Map(made.drafts!.map(([q, a]) => [q, { question: q, answer: a, at: 1, by: 'Owner' }]));
  const plan = publishPlan(answers, drafts);
  assert.equal(plan.find((p) => p.question === stageQ)!.problem, 'Add at least one line.');
  assert.equal(stage.kind, 'prep');
  assert.ok(newStage('Pizza Dough Batch', pizza, answers).problem); // his sheet's name

  // The culture can't take a dough ball: the dough ball is made from it.
  const culture = holderOf('semi:Pizza Dough Culture', answers, MENU)!;
  assert.equal(culture.question, batchQuestion('Pizza Dough Culture'));
  const ball = lineFor('semi:12inch Dough Ball', ctx())!;
  assert.match(connectProblem(culture, ball, answers)!, /made from this one/);
  // Flour from the price list can go into it; a sheet product can't change here.
  assert.equal(connectProblem(culture, lineFor('stock:inv-0001', ctx()), answers), null);
  assert.ok(connectProblem(holderOf('product:Alfredo Penne Large', answers, MENU), lineFor('stock:inv-0001', ctx()), answers));
});
