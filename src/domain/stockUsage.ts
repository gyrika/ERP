import { recipeFor, sourceOf, yieldQuestion, type Answer } from './costing.ts';
import { PREPS, PRODUCTS, type BookLine } from './recipeBook.ts';
import { ADD_RECIPES, FREE_INGREDIENTS, LEAVE_OUT_LINES } from './recipeMap.ts';
import type { OrderLine } from './types.ts';

/**
 * What a sale takes from stock (SCRUM-78), from the owner's own recipes, the same
 * way costing.ts prices them: each sold item is traced through his batches (dough,
 * sauce, cheese blend) down to the items on his price list, in their base units
 * (g, ml, pcs). Leave-outs take their lines off; extras add his add-on recipe.
 *
 * Nothing is guessed. A part his sheets leave open (a batch whose output he has not
 * confirmed, an ingredient not matched to a price-list item, a menu item with no
 * recipe) takes nothing until he answers it in the app; the answers in force when
 * the line was sold are the ones used.
 */
export interface RecipeLine {
  inventoryId: string;
  qtyBaseUnits: number;
}

export type UsageOf = (line: Pick<OrderLine, 'itemId' | 'qty' | 'size' | 'adds' | 'outs'>, answers: ReadonlyMap<string, Answer>) => RecipeLine[];

const MAX_DEPTH = 8; // as in costing.ts

const trace = (line: BookLine, times: number, answers: ReadonlyMap<string, Answer>, total: Map<string, number>, depth: number): void => {
  if (depth > MAX_DEPTH) throw new Error(`recipe nesting too deep at ${line.name}`);
  if (FREE_INGREDIENTS.has(line.name)) return;
  const qty = line.qty * times;

  const prep = PREPS[line.name];
  if (prep) {
    const answer = answers.get(yieldQuestion(line.name));
    const makes = prep.makes ?? (answer?.kind === 'yield' ? { qty: answer.qty, unit: line.unit } : null);
    if (!makes || makes.unit !== line.unit) return; // output not confirmed yet
    for (const l of prep.lines) trace(l, qty / makes.qty, answers, total, depth + 1);
    return;
  }
  const product = PRODUCTS[line.name];
  if (product) {
    for (const l of product) trace(l, qty, answers, total, depth + 1);
    return;
  }
  const source = sourceOf(line.name, answers);
  if (source) total.set(source.inventoryId, (total.get(source.inventoryId) ?? 0) + qty * source.per);
};

/** One order line: its recipe (less leave-outs, plus extras) times the quantity, one entry per price-list item. */
export const bookUsage: UsageOf = (line, answers) => {
  const product = recipeFor(line.itemId, line.size ?? '', answers);
  if (!product || !PRODUCTS[product]) return [];
  const times = Number.isFinite(line.qty) && line.qty > 0 ? line.qty : 1;
  const left = new Set(line.outs.flatMap((o) => LEAVE_OUT_LINES[o] ?? []));
  const lines = [
    ...PRODUCTS[product].filter((l) => !left.has(l.name)),
    ...line.adds.flatMap((a) => (ADD_RECIPES[a] && PRODUCTS[ADD_RECIPES[a]]) || []),
  ];
  const total = new Map<string, number>();
  for (const l of lines) trace(l, times, answers, total, 0);
  return [...total].filter(([, q]) => q > 0).map(([inventoryId, qtyBaseUnits]) => ({ inventoryId, qtyBaseUnits }));
};
