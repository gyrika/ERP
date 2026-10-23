import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answersFromEvents, batchMakes, batchQuestion, checkAnswer, gapName, ingredientQuestion, linesCost, marginOf, menuCost, openQuestions, ownPreps, prepOf,
  kitchenLine, prepQuestion, recipeChoices, recipeQuestion, undefinedNames, stockLine, waitingOn, yieldQuestion, type Answer, type RecipeEvent,
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

/** Answers he might give in the app later (test values, not his): they win over what he confirmed outside it. */
const PIZZA_ANSWERS: [string, Answer][] = [
  [yieldQuestion('Pizza Sauce Batch'), { kind: 'yield', qty: 3600 }],
  [yieldQuestion('Mozzarella Blend'), { kind: 'yield', qty: 1900 }],
];

const SAUCE_IN = 2550 + 550 + 500 + 3.12 + 3.12 + 13.82 + 9.75; // every line of his sauce batch, in g

test('a 12" Margherita, worked by hand from his recipes, his price list and his answers of 2026-10-23', () => {
  const doughBatch = (122 + 2550) * per('inv-0001') + 3.93 * per('inv-0005') + 6.11 * per('inv-0003')
    + 31.095 * per('inv-0004') + 85 * per('inv-0022'); // water costs nothing
  // Basil is priced as oregano (inv-0060 = inv-0036's price) until its first delivery.
  const sauceBatch = 2550 * per('inv-0009') + 550 * per('inv-0010') + 3.12 * per('inv-0036') + 3.12 * per('inv-0060')
    + 13.82 * per('inv-0004') + 9.75 * per('inv-0033');
  const blend = 1000 * per('inv-0006') + 1000 * per('inv-0007'); // his A (Prabhat) and B (Margarita)
  // His answers: the blend makes 2,000 g; the sauce makes what goes in.
  const byHand = doughBatch * 0.0833 + (sauceBatch / SAUCE_IN) * 90 + (blend / 2000) * 150 + 0.3333 * per('inv-0036');

  const cost = menuCost('margherita', 'L', ctx());
  assert.equal(per('inv-0060'), per('inv-0036'));
  assert.equal(cost.complete, true);
  assert.deepEqual(cost.missing, []);
  assert.equal(cost.product, 'Margherita Pizza 12 inch');
  assert.equal(cost.cents, Math.round(byHand), 'rounded once, to whole cents');
  assert.ok(Number.isInteger(cost.cents));
});

test('if he weighs again and answers in the app, his answer wins', () => {
  assert.deepEqual(batchMakes('Mozzarella Blend', 'g', new Map()), { qty: 2000, unit: 'g' });
  assert.deepEqual(batchMakes('Pizza Sauce Batch', 'g', new Map()), { qty: SAUCE_IN, unit: 'g' });
  const answers = new Map(PIZZA_ANSWERS);
  assert.deepEqual(batchMakes('Mozzarella Blend', 'g', answers), { qty: 1900, unit: 'g' });
  assert.deepEqual(batchMakes('Pizza Sauce Batch', 'g', answers), { qty: 3600, unit: 'g' });
  assert.ok(menuCost('margherita', 'L', ctx(PIZZA_ANSWERS)).cents > menuCost('margherita', 'L', ctx()).cents, 'less cheese per batch: dearer');
  assert.equal(batchMakes('Spaghetti Boil Batch', 'g', new Map()), null, 'a batch he never confirmed stays unknown');
});

test('a new price from the manager changes the cost at once', () => {
  const dearerFlour = SEED_INVENTORY.map((i) => (i.id === 'inv-0001' ? { ...i, workingPriceCents: i.workingPriceCents + 25000 } : i));
  const before = menuCost('margherita', 'L', ctx()).cents;
  const after = menuCost('margherita', 'L', ctx([], dearerFlour)).cents;
  // +Rs 250 a 25 kg bag = +1 cent a gram of flour; each total rounds once, so within a cent.
  assert.ok(Math.abs(after - before - 2672 * 0.0833) <= 1);
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

test('open questions: the ones holding back the most items first; his three answers completed the pizza basics', () => {
  const qs = openQuestions(MENU, ctx());
  const gone = [ingredientQuestion('Basil'), yieldQuestion('Mozzarella Blend'), yieldQuestion('Pizza Sauce Batch')];
  assert.ok(!qs.some((q) => gone.includes(q.id)), 'cheese blend, sauce and basil are answered (2026-10-23)');
  assert.ok(qs.every((q, i) => i === 0 || qs[i - 1].blocks.length >= q.blocks.length));
  assert.ok(!qs.some((q) => q.blocks.some((b) => b.startsWith('Margherita'))), 'Margherita is complete');
  assert.ok(qs.every((q) => q.blocks.length < 20), 'no gap holds back every pizza any more');
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

test('lines not yet on any item are costed the same way (adding a dish, SCRUM-129)', () => {
  const ctx = { items: SEED_INVENTORY, answers: new Map() };
  const cheese = { name: stockLine('inv-0006'), qty: 150, unit: 'g' };
  const item = SEED_INVENTORY.find((i) => i.id === 'inv-0006')!;
  assert.deepEqual(linesCost([cheese], ctx), { cents: Math.round((item.workingPriceCents / item.packQty) * 150), complete: true, missing: [] });
  assert.equal(linesCost([{ name: 'Something new', qty: 10, unit: 'g' }], ctx).complete, false);
});

test('a gap is named in a few words, so the owner knows what to give (SCRUM-129)', () => {
  assert.equal(gapName(yieldQuestion('Pizza Sauce Batch'), MENU), 'Pizza Sauce batch size');
  assert.equal(gapName(ingredientQuestion('Basil'), MENU), 'Basil price');
  assert.equal(gapName(recipeQuestion('sausages', 'M'), MENU), 'the recipe for Sausages M');
  const five = ['a', 'b', 'c', 'd', 'e'].map((n) => ingredientQuestion(n));
  assert.equal(waitingOn([...five, five[0]], MENU), 'waiting on a price, b price, c price and 2 more');
});

// ----- semi-processed items he adds in the app -----

/** A test item (not his): 50 g garlic powder + 950 g sugar make 1,000 g. */
const GARLIC_ID = 'kgarlic1';
const GARLIC: [string, Answer] = [prepQuestion(GARLIC_ID), {
  kind: 'prep', name: 'Garlic Sauce', makes: { qty: 1000, unit: 'g' },
  lines: [{ name: stockLine('inv-0037'), qty: 50, unit: 'g' }, { name: stockLine('inv-0003'), qty: 950, unit: 'g' }],
}];

test('a semi-processed item of his own is priced per batch and used by id, like his sheet batches', () => {
  const batch = 50 * per('inv-0037') + 950 * per('inv-0003');
  const use = [{ name: kitchenLine(GARLIC_ID), qty: 20, unit: 'g' }];
  assert.equal(linesCost(use, ctx([GARLIC])).cents, Math.round((batch / 1000) * 20));
  assert.equal(prepOf(kitchenLine(GARLIC_ID), new Map([GARLIC]))?.makes?.qty, 1000);
  assert.deepEqual(ownPreps(new Map([GARLIC])).map((p) => p.name), ['Garlic Sauce']);
  // Deleted, a line naming it costs nothing and asks about it, never guessed.
  assert.equal(linesCost(use, ctx()).complete, false);
});

test('defining a name his sheet uses but never defines completes every dish that names it', () => {
  // His BBQ Chicken pizza names "Fried Chicken Cubes", which nothing defines: it waits on a price.
  assert.ok(menuCost('bbq-chicken', 'M', ctx()).missing.includes(ingredientQuestion('Fried Chicken Cubes')));
  assert.ok(undefinedNames(new Map()).some((u) => u.name === 'Fried Chicken Cubes' && u.unit === 'g' && u.dishes === 6));
  // A test item (not his): 1,000 g chicken + 100 g oil make 800 g of cubes.
  const cubes: [string, Answer] = [prepQuestion('kcubes01'), {
    kind: 'prep', name: 'Fried Chicken Cubes', makes: { qty: 800, unit: 'g' },
    lines: [{ name: stockLine('inv-0011'), qty: 1000, unit: 'g' }, { name: stockLine('inv-0022'), qty: 100, unit: 'g' }],
  }];
  assert.equal(menuCost('bbq-chicken', 'M', ctx([cubes])).missing.includes(ingredientQuestion('Fried Chicken Cubes')), false);
  assert.equal(undefinedNames(new Map([cubes])).some((u) => u.name === 'Fried Chicken Cubes'), false);
  // His recipes use it in g: a batch in pcs would never match them.
  assert.equal(checkAnswer(cubes[0], { ...cubes[1], makes: { qty: 40, unit: 'pcs' } } as Answer), 'Your recipes use it in g: type the batch in g.');
});

test('a semi-processed item needs a free name, its output, and lines from stock or his sheet batches only', () => {
  const [q, a] = GARLIC;
  const as = (patch: object) => ({ ...a, ...patch }) as Answer;
  assert.equal(checkAnswer(q, a), null);
  assert.equal(checkAnswer(q, as({ name: 'Pizza Sauce Batch' })), 'Your recipe book already has that name.');
  assert.equal(checkAnswer(q, as({ name: 'mozzarella blend' })), 'Your recipe book already has that name.');
  assert.equal(checkAnswer(q, as({ name: 'Margherita Pizza 10 inch' })), 'Your recipe book already has that name.');
  assert.equal(checkAnswer(q, as({ name: 'Onion' })), 'Your recipe book already has that name.');
  assert.equal(checkAnswer(q, as({ name: ' ' })), 'Type its name.');
  assert.equal(checkAnswer(prepQuestion('Garlic Sauce'), a), 'That is not one of your items.');
  assert.equal(checkAnswer(q, as({ makes: { qty: 0, unit: 'g' } })), 'Type how much one batch makes.');
  assert.equal(checkAnswer(q, as({ makes: { qty: 5, unit: 'kg' } })), 'Type how much one batch makes.');
  // Never inside another item of his own (so never inside itself); his sheet's batches are fine.
  assert.notEqual(checkAnswer(q, as({ lines: [{ name: kitchenLine(GARLIC_ID), qty: 5, unit: 'g' }] })), null);
  assert.equal(checkAnswer(q, as({ lines: [{ name: 'Pizza Sauce Batch', qty: 500, unit: 'g' }] })), null);
  assert.notEqual(checkAnswer(q, { kind: 'own', lines: [{ name: stockLine('inv-0003'), qty: 1, unit: 'g' }] }), null);
});

const SAUCE = 'Pizza Sauce Batch';
const sauce = (patch: Partial<Extract<Answer, { kind: 'batch' }>> = {}): Answer => ({
  kind: 'batch', makes: { qty: 3000, unit: 'g' },
  lines: [{ name: 'Tomato Paste', qty: 2000, unit: 'g' }, { name: stockLine('inv-0009'), qty: 500, unit: 'g' }],
  ...patch,
});

test('a sheet batch he changes in the app: checked like the server does', () => {
  const q = batchQuestion(SAUCE);
  assert.equal(checkAnswer(q, sauce()), null);
  assert.equal(checkAnswer(batchQuestion('No Such Batch'), sauce()), 'That is not one of your batches.');
  assert.equal(checkAnswer(q, sauce({ makes: { qty: 30, unit: 'pcs' } })), 'Your recipes use it in g: type the batch in g.');
  assert.equal(checkAnswer(q, sauce({ makes: { qty: 0, unit: 'g' } })), 'Type how much one batch makes.');
  assert.notEqual(checkAnswer(q, sauce({ lines: [{ name: SAUCE, qty: 5, unit: 'g' }] })), null, 'never inside itself');
  assert.notEqual(checkAnswer(q, sauce({ lines: [{ name: 'Pizza Dough Batch', qty: 1, unit: 'pcs' }] })), null, 'no batch it did not take');
  assert.notEqual(checkAnswer(q, sauce({ lines: [{ name: kitchenLine('kgarlic01'), qty: 5, unit: 'g' }] })), null);
  assert.notEqual(checkAnswer(q, { kind: 'yield', qty: 3000 }), null);
});

test('his version of a sheet batch wins over his sheet in every cost; clearing it brings the sheet back', () => {
  const edited = ctx([[batchQuestion(SAUCE), sauce()]]);
  assert.equal(prepOf(SAUCE, edited.answers)?.makes?.qty, 3000);
  assert.equal(batchMakes(SAUCE, 'g', edited.answers)?.qty, 3000);
  assert.notEqual(menuCost('margherita', 'L', edited).cents, menuCost('margherita', 'L', ctx()).cents);
  assert.equal(prepOf(SAUCE, new Map())?.lines.length, 7);
});
