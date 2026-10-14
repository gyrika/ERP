import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addonCost, addonQuestion, checkAnswer, ingredientQuestion, menuCost, recipeOf, recipeQuestion, stockLine, type Answer,
} from './costing.ts';
import { mayRecord } from './auth.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import { PRODUCTS } from './recipeBook.ts';
import { bookGaps, bookUsage } from './stockUsage.ts';
import type { OrderLine } from './types.ts';

// The owner's own recipes, written on the Recipes screen (SCRUM-75). Test amounts, not his.

const CHICKEN = 'inv-0011'; // raw, with skin and bone
const SAUSAGE = 'inv-0016'; // jumbo sausage, pcs
const ONION = 'inv-0024';
const BUN = 'inv-0052';
const per = (id: string) => {
  const item = SEED_INVENTORY.find((i) => i.id === id)!;
  return item.workingPriceCents / item.packQty;
};
const ctx = (answers: [string, Answer][] = []) => ({ items: SEED_INVENTORY, answers: new Map(answers) });
const line = (itemId: string, extra: Partial<OrderLine> = {}): OrderLine => ({ id: `l-${itemId}`, itemId, qty: 1, adds: [], outs: [], ...extra });
const usage = (l: OrderLine, answers: [string, Answer][] = []) =>
  Object.fromEntries(bookUsage(l, new Map(answers)).map((u) => [u.inventoryId, u.qtyBaseUnits]));

const SAUSAGES_M: Answer = {
  kind: 'own',
  lines: [{ name: stockLine(SAUSAGE), qty: 2, unit: 'pcs' }, { name: stockLine(ONION), qty: 10, unit: 'g' }],
};

test('a menu item with no recipe: no cost, takes nothing, and says so', () => {
  assert.equal(recipeOf('sausages', 'M', new Map()), null);
  assert.deepEqual(menuCost('sausages', 'M', ctx()).missing, [recipeQuestion('sausages', 'M')]);
  assert.deepEqual(bookUsage(line('sausages', { size: 'M' }), new Map()), []);
  assert.equal(bookGaps(line('sausages', { size: 'M' }), new Map()).untracked, true);
});

test('once he writes it: it costs its lines and each sale takes them from stock', () => {
  const answers: [string, Answer][] = [[recipeQuestion('sausages', 'M'), SAUSAGES_M]];
  const cost = menuCost('sausages', 'M', ctx(answers));
  assert.equal(cost.complete, true);
  assert.equal(cost.origin, 'own');
  assert.equal(cost.cents, Math.round(2 * per(SAUSAGE) + 10 * per(ONION)));
  assert.deepEqual(usage(line('sausages', { size: 'M', qty: 3 }), answers), { [SAUSAGE]: 6, [ONION]: 30 });
  assert.deepEqual(usage(line('sausages', { size: 'M', outs: ['no-onion'] }), answers), { [SAUSAGE]: 2 }, 'leave-outs apply to his own lines too');
  assert.equal(bookGaps(line('sausages', { size: 'M' }), new Map(answers)).untracked, false);
});

test('his own recipe wins over his sheet; clearing it brings the sheet back', () => {
  const own: Answer = { kind: 'own', lines: [{ name: stockLine(BUN), qty: 1, unit: 'pcs' }] };
  assert.equal(recipeOf('chicken-burger', '', new Map())?.origin, 'sheet');
  const answers = new Map<string, Answer>([[recipeQuestion('chicken-burger', ''), own]]);
  assert.equal(recipeOf('chicken-burger', '', answers)?.origin, 'own');
  assert.deepEqual(bookUsage(line('chicken-burger'), answers), [{ inventoryId: BUN, qtyBaseUnits: 1 }]);
});

test('his own lines can use his batches and his sheet names, and their gaps still show', () => {
  const own: Answer = { kind: 'own', lines: [...PRODUCTS['Margherita Pizza 10 inch'], { name: stockLine(SAUSAGE), qty: 2, unit: 'pcs' }] };
  const cost = menuCost('sausages', 'M', ctx([[recipeQuestion('sausages', 'M'), own]]));
  assert.equal(cost.complete, false, 'sauce and cheese batches are still unconfirmed');
  assert.ok(cost.missing.includes('yield:Pizza Sauce Batch'));
});

test('an extra with no add-on recipe takes nothing until he writes one', () => {
  assert.equal(usage(line('margherita', { size: 'L', adds: ['chicken'] }))[CHICKEN], undefined);
  assert.deepEqual(addonCost('chicken', ctx()).missing, [addonQuestion('chicken')]);
  const chicken: Answer = { kind: 'own', lines: [{ name: stockLine(CHICKEN), qty: 60, unit: 'g' }] };
  const answers: [string, Answer][] = [[addonQuestion('chicken'), chicken]];
  assert.equal(usage(line('margherita', { size: 'L', adds: ['chicken'], qty: 2 }), answers)[CHICKEN], 120);
  assert.equal(addonCost('chicken', ctx(answers)).complete, true);
});

test('an ingredient made from a price-list item with a loss: 1 g of cubes takes 1.6 g raw chicken', () => {
  const answers: [string, Answer][] = [[ingredientQuestion('Fried Chicken Cubes'), { kind: 'source', inventoryId: CHICKEN, per: 1.6 }]];
  assert.equal(usage(line('bbq-chicken', { size: 'M' }), answers)[CHICKEN], 30 * 1.6);
});

test('the server takes only well-formed own recipes', () => {
  assert.equal(checkAnswer(recipeQuestion('sausages', 'M'), SAUSAGES_M), null);
  assert.equal(checkAnswer(addonQuestion('chicken'), SAUSAGES_M), null);
  assert.ok(checkAnswer(addonQuestion('chicken'), { kind: 'recipe', product: 'Chicken Burger' }), 'an extra takes only his own lines');
  assert.ok(checkAnswer(recipeQuestion('sausages', 'M'), { kind: 'own', lines: [] }));
  assert.ok(checkAnswer(recipeQuestion('sausages', 'M'), { kind: 'own', lines: [{ name: stockLine(SAUSAGE), qty: 0, unit: 'pcs' }] }));
  assert.ok(checkAnswer(recipeQuestion('sausages', 'M'), { kind: 'own', lines: [{ name: stockLine(SAUSAGE), qty: 2, unit: 'cups' }] }));
  assert.ok(checkAnswer(recipeQuestion('sausages', 'M'), { kind: 'own', lines: [{ name: ' ', qty: 2, unit: 'g' }] }));
});

test('only the owner writes or opens his recipes', () => {
  for (const type of ['recipe.answer_set', 'recipe.viewed']) {
    assert.equal(mayRecord('owner', type), true);
    assert.equal(mayRecord('manager', type), false);
    assert.equal(mayRecord('cashier', type), false);
  }
});
