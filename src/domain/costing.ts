import type { Actor } from './auth.ts';
import type { InventoryItem } from './inventoryData.ts';
import { PREPS, PRODUCTS, type BookLine } from './recipeBook.ts';
import { FREE_INGREDIENTS, INGREDIENT_SOURCES, MENU_RECIPES } from './recipeMap.ts';
import type { Cents, MenuItem } from './types.ts';

/**
 * Food cost per menu item (SCRUM-77), for the owner: what each item costs to make
 * and what it earns, from his own recipes (recipeBook.ts), his price list with the
 * latest prices his manager entered (stock.price_set), and his answers.
 *
 * Nothing is estimated. Where his sheets leave a gap (a batch whose output he never
 * confirmed, an ingredient with no price, a menu item whose recipe is not clear),
 * the item's cost is "so far" and the gap becomes a question he answers once in the
 * app. Each answer is an audited event, like a menu change.
 */

/** One answer from the owner. */
export type Answer =
  /** A batch makes this much, in the unit his recipes use it in (g, pcs). */
  | { kind: 'yield'; qty: number }
  /** This ingredient is that price-list item; one recipe unit = `per` of its base units. */
  | { kind: 'source'; inventoryId: string; per: number }
  /** This ingredient costs `cents` for `qty` recipe units (no price-list item for it). */
  | { kind: 'price'; cents: Cents; qty: number }
  /** This menu item and size is made with that recipe of his. */
  | { kind: 'recipe'; product: string };

interface RecipeBase { id: string; shopId: string; at: number; orderNumber: 0; actor: Actor }
/** The owner answers (or clears, `after: null`) one question. Audited with what it was before. */
export type RecipeEvent = RecipeBase & { type: 'recipe.answer_set'; question: string; before: Answer | null; after: Answer | null };
export const RECIPE_EVENT_TYPES = ['recipe.answer_set'] as const satisfies readonly RecipeEvent['type'][];

/** The newest answer per question. */
export const answersFromEvents = (events: readonly { type: string }[]): Map<string, Answer> => {
  const answers = new Map<string, Answer>();
  for (const e of events) {
    if (e.type !== 'recipe.answer_set') continue;
    const r = e as RecipeEvent;
    if (r.after) answers.set(r.question, r.after);
    else answers.delete(r.question);
  }
  return answers;
};

// ----- questions -----

export const yieldQuestion = (prep: string) => `yield:${prep}`;
export const ingredientQuestion = (name: string) => `ingredient:${name}`;
export const recipeQuestion = (itemId: string, size: string) => `recipe:${itemId}:${size}`;

export type QuestionKind = 'yield' | 'ingredient' | 'recipe';
export const questionKind = (id: string): QuestionKind => id.slice(0, id.indexOf(':')) as QuestionKind;
/** What the question is about: the batch, the ingredient, or [menu item id, size]. */
export const questionSubject = (id: string): string => id.slice(id.indexOf(':') + 1);

/** The unit his recipes use a batch or an ingredient in (the first place it appears). */
export const recipeUnit = (name: string): string | null => {
  for (const lines of [...Object.values(PRODUCTS), ...Object.values(PREPS).map((p) => p.lines)]) {
    const line = lines.find((l) => l.name === name);
    if (line) return line.unit;
  }
  return null;
};

/** Is this a well-formed answer to that question? (The server checks the same.) */
export const checkAnswer = (question: string, a: Answer): string | null => {
  const kind = questionKind(question);
  const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (kind === 'yield') return a.kind === 'yield' && positive(a.qty) ? null : 'Type how much one batch makes.';
  if (kind === 'recipe') return a.kind === 'recipe' && a.product in PRODUCTS ? null : 'Choose one of the recipes.';
  if (kind === 'ingredient') {
    if (a.kind === 'source') return a.inventoryId.trim() && positive(a.per) ? null : 'Choose an item.';
    if (a.kind === 'price') return Number.isSafeInteger(a.cents) && a.cents >= 0 && positive(a.qty) ? null : 'Type the price and the amount.';
  }
  return 'That does not answer this question.';
};

// ----- cost -----

export interface CostContext {
  /** The price list as it stands (workingPriceCents = the latest price entered). */
  items: readonly InventoryItem[];
  answers: ReadonlyMap<string, Answer>;
}

export interface Cost {
  /** What is known so far, rounded once to whole cents. */
  cents: Cents;
  /** Every part priced: cents is the full cost. */
  complete: boolean;
  /** The questions that would complete it. */
  missing: string[];
  /** His recipe for it, if known. */
  product: string | null;
}

const MAX_DEPTH = 8; // preps inside preps (pizza → dough ball → dough batch → culture)

const sourceOf = (name: string, ctx: CostContext) => {
  const answer = ctx.answers.get(ingredientQuestion(name));
  return INGREDIENT_SOURCES[name] ?? (answer?.kind === 'source' ? answer : null);
};

/** Unrounded cost of some recipe lines; adds every gap met on the way to `missing`. */
const linesCost = (lines: readonly BookLine[], ctx: CostContext, missing: Set<string>, depth: number): number =>
  lines.reduce((sum, line) => sum + lineCost(line, ctx, missing, depth), 0);

const lineCost = (line: BookLine, ctx: CostContext, missing: Set<string>, depth: number): number => {
  if (depth > MAX_DEPTH) throw new Error(`recipe nesting too deep at ${line.name}`);
  if (FREE_INGREDIENTS.has(line.name)) return 0;

  const prep = PREPS[line.name];
  if (prep) {
    const answer = ctx.answers.get(yieldQuestion(line.name));
    const makes = prep.makes ?? (answer?.kind === 'yield' ? { qty: answer.qty, unit: line.unit } : null);
    const batch = linesCost(prep.lines, ctx, missing, depth + 1); // collect its gaps too, all at once
    if (!makes || makes.unit !== line.unit) { missing.add(yieldQuestion(line.name)); return 0; }
    return (batch / makes.qty) * line.qty;
  }

  const product = PRODUCTS[line.name];
  if (product) return linesCost(product, ctx, missing, depth + 1) * line.qty; // a sold item used inside another

  const source = sourceOf(line.name, ctx);
  if (source) {
    const item = ctx.items.find((i) => i.id === source.inventoryId);
    if (item && item.workingPriceCents > 0) return (item.workingPriceCents / item.packQty) * source.per * line.qty;
    missing.add(ingredientQuestion(line.name)); // the item is gone, or has no price yet
    return 0;
  }
  const price = ctx.answers.get(ingredientQuestion(line.name));
  if (price?.kind === 'price') return (price.cents / price.qty) * line.qty;
  missing.add(ingredientQuestion(line.name));
  return 0;
};

/** His recipe for a menu item and size ('' when the item has no sizes), if known. */
export const recipeFor = (itemId: string, size: string, answers: ReadonlyMap<string, Answer>): string | null => {
  const answer = answers.get(recipeQuestion(itemId, size));
  return MENU_RECIPES[`${itemId}:${size}`] ?? (answer?.kind === 'recipe' ? answer.product : null);
};

/** The cost of one menu item in one size. */
export const menuCost = (itemId: string, size: string, ctx: CostContext): Cost => {
  const product = recipeFor(itemId, size, ctx.answers);
  if (!product || !PRODUCTS[product]) {
    return { cents: 0, complete: false, missing: [recipeQuestion(itemId, size)], product: null };
  }
  const missing = new Set<string>();
  const cents = Math.round(linesCost(PRODUCTS[product], ctx, missing, 0));
  return { cents, complete: missing.size === 0, missing: [...missing], product };
};

/** The sizes an item is sold in ('' for one size). */
export const sizesOf = (item: MenuItem): string[] => item.variants?.map((v) => v.id) ?? [''];

/** Earned share of the price: 0.69 = 69%. Null when there is no price. */
export const marginOf = (priceCents: Cents, costCents: Cents): number | null =>
  priceCents > 0 ? (priceCents - costCents) / priceCents : null;

export interface OpenQuestion {
  id: string;
  kind: QuestionKind;
  /** Menu items (with size) it holds back, e.g. "Margherita L". */
  blocks: string[];
}

const KIND_ORDER: Record<QuestionKind, number> = { yield: 0, recipe: 1, ingredient: 2 };

/** Every open question, those holding back the most menu items first (then batches, recipes, ingredients). */
export const openQuestions = (menu: readonly MenuItem[], ctx: CostContext): OpenQuestion[] => {
  const blocks = new Map<string, string[]>();
  for (const item of menu) {
    if (item.hidden) continue;
    for (const size of sizesOf(item)) {
      for (const q of menuCost(item.id, size, ctx).missing) {
        blocks.set(q, [...(blocks.get(q) ?? []), `${item.name.en}${size ? ` ${size}` : ''}`]);
      }
    }
  }
  return [...blocks]
    .map(([id, b]) => ({ id, kind: questionKind(id), blocks: b }))
    .sort((a, b) => b.blocks.length - a.blocks.length || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id));
};

/** A question in a few words, for lists (the Menu sheet asks it in full). */
export const questionText = (id: string, menu: readonly MenuItem[]): string => {
  const subject = questionSubject(id);
  const kind = questionKind(id);
  if (kind === 'yield') return `How much one ${subject} makes`;
  if (kind === 'ingredient') return `${subject}: its price`;
  const [itemId, size] = subject.split(':');
  const item = menu.find((m) => m.id === itemId);
  return `Which recipe is ${item?.name.en ?? itemId}${size ? ` ${size}` : ''}`;
};

/** His recipes that could be this menu item in this size, for the owner to choose from. */
export const recipeChoices = (item: MenuItem, size: string): string[] => {
  const names = Object.keys(PRODUCTS);
  const sized = (n: string) => !size || (item.category === 'pizza'
    ? n.endsWith(size === 'M' ? '10 inch' : '12 inch')
    : n.endsWith(({ S: 'Single', M: 'Medium', L: 'Large' } as Record<string, string>)[size] ?? ''));
  const kind = item.category === 'pizza' ? /Pizza/ : item.category === 'pasta' ? /Penne|Spaghetti|Pasta/ : /Burger/;
  return names.filter((n) => kind.test(n) && sized(n)).sort();
};
