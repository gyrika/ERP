import type { OrderLine } from './types.ts';

/**
 * Recipes: what one menu item takes from stock, in each ingredient's base unit
 * (g, ml, pcs, sheets, as in SEED_INVENTORY), keyed by MenuItem.id.
 *
 * Empty on purpose. The owner's own recipes ("Cheesy Beez System V1", Recipe_BOM
 * and Production_BOM) come in with SCRUM-77, copied by a script and locked by
 * tests like the menu. Never estimate a recipe here: an item without one takes
 * nothing from stock, and its cost shows as incomplete.
 */
export interface RecipeLine {
  inventoryId: string;
  qtyBaseUnits: number;
}

export interface Recipe {
  /** Used by every size. */
  baseIngredients: RecipeLine[];
  /** Added for one size only, e.g. M (10") or L (12"). */
  variantOverrides?: Record<string, RecipeLine[]>;
}

export type Recipes = Readonly<Record<string, Recipe>>;

export const RECIPES: Recipes = {};

/** What one order line takes from stock: the recipe times the quantity, one entry per ingredient. */
export const recipeUsage = (line: Pick<OrderLine, 'itemId' | 'qty' | 'size'>, recipes: Recipes = RECIPES): RecipeLine[] => {
  const recipe = recipes[line.itemId];
  if (!recipe) return [];
  const qty = Number.isFinite(line.qty) && line.qty > 0 ? line.qty : 1;
  const sized = line.size ? recipe.variantOverrides?.[line.size] ?? [] : [];
  const total = new Map<string, number>();
  for (const { inventoryId, qtyBaseUnits } of [...recipe.baseIngredients, ...sized]) {
    if (qtyBaseUnits > 0) total.set(inventoryId, (total.get(inventoryId) ?? 0) + qtyBaseUnits * qty);
  }
  return [...total].map(([inventoryId, qtyBaseUnits]) => ({ inventoryId, qtyBaseUnits }));
};
