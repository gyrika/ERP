import test from 'node:test';
import assert from 'node:assert/strict';
import { RECIPES, recipeUsage } from './recipes.ts';

test('no recipes until the owner\'s own are imported (SCRUM-77): never estimated', () => {
  assert.deepEqual(RECIPES, {});
  assert.deepEqual(recipeUsage({ itemId: 'margherita', qty: 1, size: 'M' }), []);
});

test('a line takes the recipe for every size, plus its size, times the quantity, once per ingredient', () => {
  const recipes = {
    pizza: {
      baseIngredients: [{ inventoryId: 'sauce', qtyBaseUnits: 45 }, { inventoryId: 'cheese', qtyBaseUnits: 10 }],
      variantOverrides: { L: [{ inventoryId: 'cheese', qtyBaseUnits: 140 }] },
    },
  };
  assert.deepEqual(recipeUsage({ itemId: 'pizza', qty: 2, size: 'L' }, recipes), [
    { inventoryId: 'sauce', qtyBaseUnits: 90 },
    { inventoryId: 'cheese', qtyBaseUnits: 300 },
  ]);
  assert.deepEqual(recipeUsage({ itemId: 'pizza', qty: 1, size: 'M' }, recipes), [
    { inventoryId: 'sauce', qtyBaseUnits: 45 },
    { inventoryId: 'cheese', qtyBaseUnits: 10 },
  ]);
  assert.deepEqual(recipeUsage({ itemId: 'burger', qty: 1 }, recipes), []);
});
