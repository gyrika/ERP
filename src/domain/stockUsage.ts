import { addonOf, batchMakes, grossQty, prepOf, recipeOf, sourceOf, STOCK_LINE, type Answer } from './costing.ts';
import { PRODUCTS, type BookLine } from './recipeBook.ts';
import { FREE_INGREDIENTS, LEAVE_OUT_LINES } from './recipeMap.ts';
import type { OrderLine } from './types.ts';
import type { WasteWhat } from './waste.ts';
import { prepKey, prepStockId } from './prep.ts';

/**
 * What a sale takes from stock (SCRUM-78), from the owner's own recipes, the same
 * way costing.ts prices them: each sold item is traced through his batches (dough,
 * sauce, cheese blend, and the semi-processed items he adds in the app) down to the items on his price list, in their base units
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

/**
 * Semi-processed items with a stock of their own (prep.ts), by key, with the unit it is counted
 * in: a line reaching one takes it (as `prep:<key>`) instead of going down to its raw items.
 */
export type Tracked = ReadonlyMap<string, string>;
const NONE: Tracked = new Map();

export type UsageOf = (line: Pick<OrderLine, 'itemId' | 'qty' | 'size' | 'adds' | 'outs' | 'half'>, answers: ReadonlyMap<string, Answer>, tracked?: Tracked) => RecipeLine[];

const MAX_DEPTH = 8; // as in costing.ts

const trace = (line: BookLine, times: number, answers: ReadonlyMap<string, Answer>, total: Map<string, number>, depth: number, tracked: Tracked = NONE): void => {
  if (depth > MAX_DEPTH) throw new Error(`recipe nesting too deep at ${line.name}`);
  if (FREE_INGREDIENTS.has(line.name)) return;
  const qty = grossQty(line) * times; // its wastage too

  const prep = prepOf(line.name, answers);
  if (prep) {
    const key = tracked.size ? prepKey(line.name, answers) : null;
    if (key && tracked.get(key) === line.unit) {
      const id = prepStockId(key);
      total.set(id, (total.get(id) ?? 0) + qty);
      return;
    }
    const makes = batchMakes(line.name, line.unit, answers);
    if (!makes || makes.unit !== line.unit) return; // output not confirmed yet
    for (const l of prep.lines) trace(l, qty / makes.qty, answers, total, depth + 1, tracked);
    return;
  }
  const product = PRODUCTS[line.name];
  if (product) {
    for (const l of product) trace(l, qty, answers, total, depth + 1, tracked);
    return;
  }
  const source = sourceOf(line.name, answers);
  if (source) total.set(source.inventoryId, (total.get(source.inventoryId) ?? 0) + qty * source.per);
};

/**
 * A sold line's recipe lines: his recipe less its leave-outs, plus each extra's recipe;
 * null: no recipe yet. A half-and-half pizza takes half of each half's recipe (halves.ts).
 */
const soldLines = (line: Pick<OrderLine, 'itemId' | 'size' | 'adds' | 'outs' | 'half'>, answers: ReadonlyMap<string, Answer>): BookLine[] | null => {
  const size = line.size ?? '';
  const whole = recipeOf(line.itemId, size, answers);
  const other = line.half ? recipeOf(line.half, size, answers) : null;
  if (!whole || (line.half && !other)) return null;
  const halfOf = (lines: readonly BookLine[]) => lines.map((l) => ({ ...l, qty: l.qty / 2 }));
  const recipe = { lines: other ? [...halfOf(whole.lines), ...halfOf(other.lines)] : whole.lines };
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
export const bookUsage: UsageOf = (line, answers, tracked = NONE) => {
  const lines = soldLines(line, answers);
  if (!lines) return [];
  const times = Number.isFinite(line.qty) && line.qty > 0 ? line.qty : 1;
  const total = new Map<string, number>();
  for (const l of lines) trace(l, times, answers, total, 0, tracked);
  return [...total].filter(([, q]) => q > 0).map(([inventoryId, qtyBaseUnits]) => ({ inventoryId, qtyBaseUnits }));
};

/**
 * What recording a batch of a semi-processed item takes: one batch's lines for each batch's
 * worth made, down to the raw items (or to tracked items inside it, like dough balls from
 * tracked dough). Empty when he has not said what one batch makes: nothing is guessed.
 */
export const batchUsage = (key: string, qty: number, unit: string, answers: ReadonlyMap<string, Answer>, tracked: Tracked = NONE): RecipeLine[] => {
  const name = key; // a sheet batch by name, his own item as kitchen:<id>: prepOf takes both
  const prep = prepOf(name, answers);
  const makes = prep && batchMakes(name, unit, answers);
  if (!prep || !makes || makes.unit !== unit || !(qty > 0)) return [];
  const total = new Map<string, number>();
  for (const l of prep.lines) trace(l, qty / makes.qty, answers, total, 1, tracked);
  return [...total].filter(([, q]) => q > 0).map(([inventoryId, qtyBaseUnits]) => ({ inventoryId, qtyBaseUnits }));
};

/**
 * How much of each semi-processed item a sold line used, by key, whether or not it has a stock
 * yet: the daily use behind "make more" (an item's use is known from the day it is first made).
 */
export const prepUse = (line: Pick<OrderLine, 'itemId' | 'qty' | 'size' | 'adds' | 'outs' | 'half'>, answers: ReadonlyMap<string, Answer>): Map<string, number> => {
  const out = new Map<string, number>();
  const lines = soldLines(line, answers);
  if (!lines) return out;
  const times = Number.isFinite(line.qty) && line.qty > 0 ? line.qty : 1;
  const meet = (l: BookLine, qty: number, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Error(`recipe nesting too deep at ${l.name}`);
    const prep = prepOf(l.name, answers);
    if (prep) {
      const key = prepKey(l.name, answers);
      if (key) out.set(key, (out.get(key) ?? 0) + qty);
      const makes = batchMakes(l.name, l.unit, answers);
      if (makes && makes.unit === l.unit) for (const x of prep.lines) meet(x, grossQty(x) * qty / makes.qty, depth + 1);
      return;
    }
    for (const x of PRODUCTS[l.name] ?? []) meet(x, grossQty(x) * qty, depth + 1);
  };
  for (const l of lines) meet(l, grossQty(l) * times, 0);
  return out;
};

/**
 * What a waste takes (waste.ts), the same way as a sale: a dish through its recipe (no extras,
 * nothing left out), a semi-processed item through its batch, a raw item as it is.
 * Empty: no recipe yet, or a batch whose output he has not confirmed.
 */
export const wasteUsage = (what: WasteWhat, qty: number, answers: ReadonlyMap<string, Answer>, tracked: Tracked = NONE): RecipeLine[] => {
  if (!(Number.isFinite(qty) && qty > 0)) return [];
  if (what.kind === 'stock') return [{ inventoryId: what.itemId, qtyBaseUnits: qty }];
  if (what.kind === 'dish') return bookUsage({ itemId: what.itemId, qty, size: what.size, adds: [], outs: [] }, answers, tracked);
  const total = new Map<string, number>();
  trace({ name: what.name, qty, unit: what.unit }, 1, answers, total, 0, tracked);
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
export type GapsOf = (line: Pick<OrderLine, 'itemId' | 'qty' | 'size' | 'adds' | 'outs' | 'half'>, answers: ReadonlyMap<string, Answer>, tracked?: Tracked) => UsageGaps;

/** Every price-list item a recipe line reaches, whatever the batch sizes. */
const reach = (line: BookLine, answers: ReadonlyMap<string, Answer>, ids: Set<string>, depth: number): void => {
  if (depth > MAX_DEPTH) throw new Error(`recipe nesting too deep at ${line.name}`);
  const below = prepOf(line.name, answers)?.lines ?? PRODUCTS[line.name];
  if (below) { for (const l of below) reach(l, answers, ids, depth + 1); return; }
  const source = sourceOf(line.name, answers);
  if (source) ids.add(source.inventoryId);
};

/** The items behind batches not confirmed yet, met on the way down a recipe line. */
const held = (line: BookLine, answers: ReadonlyMap<string, Answer>, ids: Set<string>, depth: number, tracked: Tracked = NONE): void => {
  if (depth > MAX_DEPTH) throw new Error(`recipe nesting too deep at ${line.name}`);
  const prep = prepOf(line.name, answers);
  if (prep) {
    // A sale takes a tracked item itself: nothing below it is held back.
    const key = tracked.size ? prepKey(line.name, answers) : null;
    if (key && tracked.get(key) === line.unit) return;
    const makes = batchMakes(line.name, line.unit, answers);
    if (!makes || makes.unit !== line.unit) { reach(line, answers, ids, depth); return; }
    for (const l of prep.lines) held(l, answers, ids, depth + 1, tracked);
    return;
  }
  for (const l of PRODUCTS[line.name] ?? []) held(l, answers, ids, depth + 1, tracked);
};

export const bookGaps: GapsOf = (line, answers, tracked = NONE) => {
  const lines = soldLines(line, answers);
  if (!lines) return { untracked: true, items: [] };
  const ids = new Set<string>();
  for (const l of lines) held(l, answers, ids, 0, tracked);
  return { untracked: false, items: [...ids] };
};
