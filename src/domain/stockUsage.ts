import { addonOf, recipeOf, sourceOf, STOCK_LINE, yieldQuestion, type Answer } from './costing.ts';
import { PREPS, PRODUCTS, type BookLine } from './recipeBook.ts';
import { FREE_INGREDIENTS, LEAVE_OUT_LINES } from './recipeMap.ts';
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

/** A sold line's recipe lines: his recipe less its leave-outs, plus each extra's recipe; null: no recipe yet. */
const soldLines = (line: Pick<OrderLine, 'itemId' | 'size' | 'adds' | 'outs'>, answers: ReadonlyMap<string, Answer>): BookLine[] | null => {
  const recipe = recipeOf(line.itemId, line.size ?? '', answers);
  if (!recipe) return null;
  const left = new Set(line.outs.flatMap((o) => LEAVE_OUT_LINES[o] ?? []));
  // His own recipes may name the price-list item itself ("stock:inv-0024" for onion).
  const leftItems = new Set([...left].map((name) => sourceOf(name, answers)?.inventoryId).filter(Boolean));
  const isLeft = (l: BookLine) => left.has(l.name) || (l.name.startsWith(STOCK_LINE) && leftItems.has(l.name.slice(STOCK_LINE.length)));
  return [
    ...recipe.lines.filter((l) => !isLeft(l)),
    ...line.adds.flatMap((a) => addonOf(a, answers)?.lines ?? []),
  ];
};

/** One order line: its recipe (less leave-outs, plus extras) times the quantity, one entry per price-list item. */
export const bookUsage: UsageOf = (line, answers) => {
  const lines = soldLines(line, answers);
  if (!lines) return [];
  const times = Number.isFinite(line.qty) && line.qty > 0 ? line.qty : 1;
  const total = new Map<string, number>();
  for (const l of lines) trace(l, times, answers, total, 0);
  return [...total].filter(([, q]) => q > 0).map(([inventoryId, qtyBaseUnits]) => ({ inventoryId, qtyBaseUnits }));
};

/**
 * What a sale could not take, so the stock screen can say so instead of looking
 * certain. untracked: the menu item has no recipe of his yet, so it took nothing.
 * items: price-list items it would have taken from, held back by a batch whose
 * output he has not confirmed. Either way the shelf holds less than the app says,
 * never more. (An ingredient not matched to his price list has no item to mark:
 * it waits as a question on the Menu screen.)
 */
export interface UsageGaps { untracked: boolean; items: string[] }
export type GapsOf = (line: Pick<OrderLine, 'itemId' | 'qty' | 'size' | 'adds' | 'outs'>, answers: ReadonlyMap<string, Answer>) => UsageGaps;

/** Every price-list item a recipe line reaches, whatever the batch sizes. */
const reach = (line: BookLine, answers: ReadonlyMap<string, Answer>, ids: Set<string>, depth: number): void => {
  if (depth > MAX_DEPTH) throw new Error(`recipe nesting too deep at ${line.name}`);
  const below = PREPS[line.name]?.lines ?? PRODUCTS[line.name];
  if (below) { for (const l of below) reach(l, answers, ids, depth + 1); return; }
  const source = sourceOf(line.name, answers);
  if (source) ids.add(source.inventoryId);
};

/** The items behind batches not confirmed yet, met on the way down a recipe line. */
const held = (line: BookLine, answers: ReadonlyMap<string, Answer>, ids: Set<string>, depth: number): void => {
  if (depth > MAX_DEPTH) throw new Error(`recipe nesting too deep at ${line.name}`);
  const prep = PREPS[line.name];
  if (prep) {
    const answer = answers.get(yieldQuestion(line.name));
    const makes = prep.makes ?? (answer?.kind === 'yield' ? { qty: answer.qty, unit: line.unit } : null);
    if (!makes || makes.unit !== line.unit) { reach(line, answers, ids, depth); return; }
    for (const l of prep.lines) held(l, answers, ids, depth + 1);
    return;
  }
  for (const l of PRODUCTS[line.name] ?? []) held(l, answers, ids, depth + 1);
};

export const bookGaps: GapsOf = (line, answers) => {
  const lines = soldLines(line, answers);
  if (!lines) return { untracked: true, items: [] };
  const ids = new Set<string>();
  for (const l of lines) held(l, answers, ids, 0);
  return { untracked: false, items: [...ids] };
};
