import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answersFromEvents, checkAnswer, ingredientQuestion, marginOf, menuCost, openQuestions, recipeChoices,
  recipeQuestion, yieldQuestion, type Answer, type RecipeEvent,
} from './costing.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import { MENU, itemById } from './menu.ts';
import { mayRecord } from './auth.ts';

/** Cents per base unit (g, ml, pcs) on his price list. */
const per = (id: string) => {
  const item = SEED_INVENTORY.find((i) => i.id === id)!;
  return item.workingPriceCents / item.packQty;
};
const ctx = (answers: [string, Answer][] = [], items = SEED_INVENTORY) => ({ items, answers: new Map(answers) });

/** What the owner would answer to complete the pizzas (test values, not his). */
const PIZZA_ANSWERS: [string, Answer][] = [
  [yieldQuestion('Pizza Sauce Batch'), { kind: 'yield', qty: 3600 }],
  [yieldQuestion('Mozzarella Blend'), { kind: 'yield', qty: 2000 }],
  [ingredientQuestion('Mozzarella A'), { kind: 'source', inventoryId: 'inv-0006', per: 1 }],
  [ingredientQuestion('Mozzarella B'), { kind: 'source', inventoryId: 'inv-0008', per: 1 }],
  [ingredientQuestion('Basil'), { kind: 'price', cents: 20000, qty: 100 }],
];

test('a 12" Margherita, worked by hand from his recipes and his price list, once his gaps are answered', () => {
  const doughBatch = (122 + 2550) * per('inv-0001') + 3.93 * per('inv-0005') + 6.11 * per('inv-0003')
    + 31.095 * per('inv-0004') + 85 * per('inv-0022'); // water costs nothing
  const sauceBatch = 2550 * per('inv-0009') + 550 * per('inv-0010') + 3.12 * per('inv-0036') + 3.12 * (20000 / 100)
    + 13.82 * per('inv-0004') + 9.75 * per('inv-0033');
  const blend = 1000 * per('inv-0006') + 1000 * per('inv-0008');
  const byHand = doughBatch * 0.0833 + (sauceBatch / 3600) * 90 + (blend / 2000) * 150 + 0.3333 * per('inv-0036');

  const cost = menuCost('margherita', 'L', ctx(PIZZA_ANSWERS));
  assert.equal(cost.complete, true);
  assert.deepEqual(cost.missing, []);
  assert.equal(cost.product, 'Margherita Pizza 12 inch');
  assert.equal(cost.cents, Math.round(byHand), 'rounded once, to whole cents');
  assert.ok(Number.isInteger(cost.cents));
});

test('before his answers: the cost so far, and exactly what is missing', () => {
  const cost = menuCost('margherita', 'L', ctx());
  assert.equal(cost.complete, false);
  assert.deepEqual([...cost.missing].sort(), [
    ingredientQuestion('Basil'), ingredientQuestion('Mozzarella A'), ingredientQuestion('Mozzarella B'),
    yieldQuestion('Mozzarella Blend'), yieldQuestion('Pizza Sauce Batch'),
  ].sort());
  const dough = ((122 + 2550) * per('inv-0001') + 3.93 * per('inv-0005') + 6.11 * per('inv-0003')
    + 31.095 * per('inv-0004') + 85 * per('inv-0022')) * 0.0833;
  assert.equal(cost.cents, Math.round(dough + 0.3333 * per('inv-0036')), 'dough and oregano are known');
});

test('a new price from the manager changes the cost at once', () => {
  const dearerFlour = SEED_INVENTORY.map((i) => (i.id === 'inv-0001' ? { ...i, workingPriceCents: i.workingPriceCents + 25000 } : i));
  const before = menuCost('margherita', 'L', ctx(PIZZA_ANSWERS)).cents;
  const after = menuCost('margherita', 'L', ctx(PIZZA_ANSWERS, dearerFlour)).cents;
  assert.equal(after - before, Math.round(2672 * 0.0833 * (25000 / 25000)), '+Rs 250 a 25 kg bag = +1 cent a gram of flour');
});

test('menu items with no clear recipe ask which of his recipes it is; the answer is all it takes', () => {
  assert.deepEqual(menuCost('italian-pasta', 'M', ctx()).missing, [recipeQuestion('italian-pasta', 'M')]);
  assert.deepEqual(menuCost('bbq-pork', 'L', ctx()).missing, [recipeQuestion('bbq-pork', 'L')]);
  const choices = recipeChoices(itemById('italian-pasta'), 'M');
  assert.ok(choices.includes('Chicken Alfredo Pasta Medium') && choices.every((c) => c.endsWith('Medium')));
  assert.ok(recipeChoices(itemById('sausages'), 'L').includes('Chicken Sausages Pizza 12 inch'));
  const answered = menuCost('sausages', 'L', ctx([[recipeQuestion('sausages', 'L'), { kind: 'recipe', product: 'Chicken Sausages Pizza 12 inch' }]]));
  assert.equal(answered.product, 'Chicken Sausages Pizza 12 inch');
});

test('burgers: only ketchup and mayonnaise are missing (bought in ml, used in g)', () => {
  assert.deepEqual([...menuCost('chicken-burger', '', ctx()).missing].sort(), [ingredientQuestion('Ketchup'), ingredientQuestion('Mayonnaise')]);
  const done = menuCost('chicken-burger', '', ctx([
    [ingredientQuestion('Ketchup'), { kind: 'price', cents: 175000, qty: 4000 }],
    [ingredientQuestion('Mayonnaise'), { kind: 'price', cents: 330000, qty: 3780 }],
  ]));
  assert.equal(done.complete, true);
  assert.equal(done.cents, Math.round(per('inv-0052') + 5 * per('inv-0021') + 4.6 * per('inv-0026')
    + 10 * (330000 / 3780) + 10 * (175000 / 4000) + per('inv-0018')));
});

test('open questions: the ones holding back the most items first; pizza gaps hold back all 20 pizzas', () => {
  const qs = openQuestions(MENU, ctx());
  assert.deepEqual(qs.slice(0, 5).map((q) => q.blocks.length), [20, 20, 20, 20, 20]);
  assert.ok(qs.slice(0, 5).some((q) => q.id === yieldQuestion('Pizza Sauce Batch')));
  assert.ok(qs.every((q, i) => i === 0 || qs[i - 1].blocks.length >= q.blocks.length));
  const after = openQuestions(MENU, ctx(PIZZA_ANSWERS));
  assert.ok(!after.some((q) => q.blocks.some((b) => b.startsWith('Margherita'))), 'Margherita is complete');
});

test('answers are events: newest wins, null clears; only the owner may answer', () => {
  const actor = { id: 'o', name: 'Owner', role: 'owner' as const };
  const e = (id: string, after: Answer | null): RecipeEvent => ({
    id, shopId: 's', at: 1, orderNumber: 0, actor, type: 'recipe.answer_set', question: yieldQuestion('Pizza Sauce Batch'), before: null, after,
  });
  assert.deepEqual(answersFromEvents([e('1', { kind: 'yield', qty: 3000 }), e('2', { kind: 'yield', qty: 3600 })]).get(yieldQuestion('Pizza Sauce Batch')), { kind: 'yield', qty: 3600 });
  assert.equal(answersFromEvents([e('1', { kind: 'yield', qty: 3000 }), e('2', null)]).size, 0);
  assert.equal(mayRecord('owner', 'recipe.answer_set'), true);
  assert.equal(mayRecord('manager', 'recipe.answer_set'), false);
  assert.equal(mayRecord('cashier', 'recipe.answer_set'), false);
});

test('an answer must fit its question', () => {
  assert.equal(checkAnswer(yieldQuestion('Pizza Sauce Batch'), { kind: 'yield', qty: 3600 }), null);
  assert.notEqual(checkAnswer(yieldQuestion('Pizza Sauce Batch'), { kind: 'yield', qty: 0 }), null);
  assert.notEqual(checkAnswer(recipeQuestion('bbq-pork', 'L'), { kind: 'recipe', product: 'Made-up Pizza' }), null);
  assert.equal(checkAnswer(ingredientQuestion('Basil'), { kind: 'price', cents: 20000, qty: 100 }), null);
  assert.notEqual(checkAnswer(ingredientQuestion('Basil'), { kind: 'price', cents: 1.5, qty: 100 }), null);
  assert.notEqual(checkAnswer(ingredientQuestion('Basil'), { kind: 'yield', qty: 3 }), null);
});

test('margin: the share of the price the item earns', () => {
  assert.equal(marginOf(250000, 75000), 0.7);
  assert.equal(marginOf(0, 100), null);
});
