import test from 'node:test';
import assert from 'node:assert/strict';
import { PREPS, PRODUCTS } from './recipeBook.ts';

// Locks the owner's recipes as copied from his sheet, like menu.test locks the printed prices.
// If one of these fails, his sheet changed: re-run scripts/import-recipes.ts and check with him.

test('his book: 80 sold products and 13 in-house preps, Active rows only (the packs are on hold)', () => {
  assert.equal(Object.keys(PRODUCTS).length, 80);
  assert.equal(Object.keys(PREPS).length, 13);
  assert.ok(!('Family Pack' in PRODUCTS) && !('Couple Pack' in PRODUCTS));
});

test('the 12" Margherita is his locked standard: 1 dough ball, 90 g sauce, 150 g cheese blend', () => {
  assert.deepEqual(PRODUCTS['Margherita Pizza 12 inch'], [
    { name: '12inch Dough Ball', qty: 1, unit: 'pcs' },
    { name: 'Pizza Sauce Batch', qty: 90, unit: 'g' },
    { name: 'Mozzarella Blend', qty: 150, unit: 'g' },
    { name: 'Oregano', qty: 0.3333, unit: 'g' },
  ]);
  assert.deepEqual(PRODUCTS['Margherita Pizza 10 inch'].map((l) => l.qty), [1, 45, 90, 0.3333]);
});

test('the dough: one batch makes 12 large or 21 medium balls', () => {
  assert.deepEqual(PREPS['12inch Dough Ball'], { makes: { qty: 1, unit: 'pcs' }, lines: [{ name: 'Pizza Dough Batch', qty: 0.0833, unit: 'pcs' }] });
  assert.deepEqual(PREPS['10inch Dough Ball'].lines, [{ name: 'Pizza Dough Batch', qty: 0.0476, unit: 'pcs' }]);
  assert.equal(PREPS['Pizza Dough Batch'].lines.find((l) => l.name === 'Pizza Flour')?.qty, 2550);
});

test('only the batches he flagged "Confirm batch output qty" wait for his answer', () => {
  assert.deepEqual(Object.keys(PREPS).filter((p) => PREPS[p].makes === null).sort(),
    ['Mozzarella Blend', 'Penne Boil Batch', 'Pizza Sauce Batch', 'Spaghetti Boil Batch']);
});
