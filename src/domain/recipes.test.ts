import test from 'node:test';
import assert from 'node:assert/strict';
import { RECIPES } from './recipes.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import { MENU } from './menu.ts';

test('T1: RECIPES has realistic examples populated', () => {
  const recipeKeys = Object.keys(RECIPES);
  assert.ok(recipeKeys.length >= 3 && recipeKeys.length <= 10, `Expected 3 to 10 recipes, got ${recipeKeys.length}`);
});

test('T2: Every recipe key maps to a valid MenuItem.id', () => {
  const menuIds = new Set(MENU.map((m) => m.id));
  for (const key of Object.keys(RECIPES)) {
    assert.ok(menuIds.has(key), `Recipe key "${key}" should exist in MENU`);
  }
});

test('T3: Every RecipeLine references a real inventoryId from SEED_INVENTORY with positive qtyBaseUnits', () => {
  const inventoryIds = new Set(SEED_INVENTORY.map((i) => i.id));

  for (const [key, recipe] of Object.entries(RECIPES)) {
    assert.ok(Array.isArray(recipe.baseIngredients), `${key} baseIngredients should be an array`);

    const allLines = [...recipe.baseIngredients];
    if (recipe.variantOverrides) {
      for (const [variantKey, lines] of Object.entries(recipe.variantOverrides)) {
        assert.ok(typeof variantKey === 'string' && variantKey.length > 0, `${key} variant key should be non-empty`);
        assert.ok(Array.isArray(lines), `${key} variant ${variantKey} should be an array`);
        allLines.push(...lines);
      }
    }

    assert.ok(allLines.length > 0, `${key} should have at least one ingredient line`);

    for (const line of allLines) {
      assert.ok(inventoryIds.has(line.inventoryId), `${key}: Unknown inventoryId ${line.inventoryId}`);
      assert.ok(
        typeof line.qtyBaseUnits === 'number' && Number.isFinite(line.qtyBaseUnits) && line.qtyBaseUnits > 0,
        `${key}: Invalid qtyBaseUnits ${line.qtyBaseUnits} for ${line.inventoryId}`,
      );
    }
  }
});

test('T4: Variant overrides align with MenuItem variants', () => {
  for (const [key, recipe] of Object.entries(RECIPES)) {
    if (!recipe.variantOverrides) continue;
    const menuItem = MENU.find((m) => m.id === key);
    assert.ok(menuItem, `Menu item ${key} should exist`);
    assert.ok(menuItem.variants && menuItem.variants.length > 0, `Menu item ${key} should have variants`);

    const validVariantIds = new Set<string>(menuItem.variants.map((v) => v.id));
    for (const variantKey of Object.keys(recipe.variantOverrides)) {
      assert.ok(
        validVariantIds.has(variantKey),
        `${key}: variant override "${variantKey}" not found in MenuItem.variants (${Array.from(validVariantIds).join(', ')})`,
      );
    }
  }
});
