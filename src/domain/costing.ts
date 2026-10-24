import type { Actor } from './auth.ts';
import type { InventoryItem } from './inventoryData.ts';
import { PREPS, PRODUCTS, type BookLine, type Prep } from './recipeBook.ts';
import { ADD_RECIPES, CONFIRMED_BATCHES, FREE_INGREDIENTS, INGREDIENT_SOURCES, MENU_RECIPES } from './recipeMap.ts';
import { checkRates, checkResourceLines, type Rates, type ResourceLine } from './resources.ts';
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
  | { kind: 'recipe'; product: string }
  /**
   * His own recipe, written in the app (the Recipes screen): it wins over his sheet.
   * A line names one of his batches or ingredients, or a price-list item directly
   * (`stock:<id>`, in that item's base unit).
   */
  | { kind: 'own'; lines: BookLine[] }
  /**
   * A semi-processed item of his own, added in the app (a garlic sauce, fried chicken cubes):
   * its name, what one batch makes and what goes in it. Recipes use it like his sheet's
   * batches, by id (`kitchen:<id>`), or by name where his sheet names it but never defines it.
   */
  | { kind: 'prep'; name: string; makes: { qty: number; unit: string }; lines: BookLine[] }
  /**
   * His own version of one of his sheet's batches, changed in the app: what one batch makes and
   * what goes in it. It wins over his sheet; the name stays, since his sheet's dishes use it by name.
   */
  | { kind: 'batch'; makes: { qty: number; unit: string }; lines: BookLine[] }
  /** What making one batch (or one dish) takes besides ingredients: electricity, labour... (resources.ts). */
  | { kind: 'resources'; lines: ResourceLine[] }
  /** The shop's rates for those (resources.ts). */
  | { kind: 'rates'; rates: Rates };

interface RecipeBase { id: string; shopId: string; at: number; orderNumber: 0; actor: Actor }
/**
 * The owner answers (or clears, `after: null`) one question. Audited with what it was before.
 * recipe.viewed: someone opened the Recipes screen (his recipes are the shop's secret).
 * recipe.draft_set: his unpublished change to one answer (recipeDrafts.ts), `after: null` drops it.
 * A draft changes no cost and no stock; publishing it is a recipe.answer_set.
 */
export type RecipeEvent = RecipeBase & (
  | { type: 'recipe.answer_set'; question: string; before: Answer | null; after: Answer | null }
  | { type: 'recipe.viewed' }
  | { type: 'recipe.draft_set'; question: string; after: Answer | null }
);
export const RECIPE_EVENT_TYPES = ['recipe.answer_set', 'recipe.viewed', 'recipe.draft_set'] as const satisfies readonly RecipeEvent['type'][];

/** The newest answer per question. */
export const answersFromEvents = (events: readonly { type: string }[]): Map<string, Answer> => {
  const answers = new Map<string, Answer>();
  for (const e of events) {
    if (e.type !== 'recipe.answer_set') continue;
    const r = e as Extract<RecipeEvent, { type: 'recipe.answer_set' }>;
    // Two screens may each add half of a loop: the later one is not taken, the same on every device.
    if (r.after && makesLoop(r.question, r.after, answers)) continue;
    if (r.after) answers.set(r.question, r.after);
    else answers.delete(r.question);
  }
  return answers;
};

// ----- questions -----

export const yieldQuestion = (prep: string) => `yield:${prep}`;
export const ingredientQuestion = (name: string) => `ingredient:${name}`;
export const recipeQuestion = (itemId: string, size: string) => `recipe:${itemId}:${size}`;
/** The recipe for a menu extra (a pizza topping, a cheese slice), by its id. */
export const addonQuestion = (extraId: string) => `addon:${extraId}`;
/** A semi-processed item he added in the app, by its id (names are labels: they may change). */
export const prepQuestion = (id: string) => `prep:${id}`;
/** One of his sheet's batches as he changed it in the app, by its name on his sheet. */
export const batchQuestion = (name: string) => `batch:${name}`;
/**
 * What a recipe takes besides ingredients (resources.ts), by the recipe's own key: a dish's
 * recipe question (recipe:<id>:<size>), an extra's (addon:<id>), or a batch by its key.
 */
export const resourcesQuestion = (recipeKey: string) => `resources:${recipeKey}`;
/** The shop's rates for electricity, labour and equipment. */
export const RATES_QUESTION = 'rates:shop';

export type QuestionKind = 'yield' | 'ingredient' | 'recipe' | 'addon' | 'prep' | 'batch' | 'resources' | 'rates';
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

/** A price-list item used straight in an own recipe line. */
export const STOCK_LINE = 'stock:';
export const stockLine = (inventoryId: string) => `${STOCK_LINE}${inventoryId}`;
/** A semi-processed item of his own used in a recipe line, by its id. */
export const KITCHEN_LINE = 'kitchen:';
export const kitchenLine = (id: string) => `${KITCHEN_LINE}${id}`;
const PREP_ID = /^k[a-z0-9]{4,24}$/;
/** A new id for a semi-processed item of his. */
export const newPrepId = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const UNITS = ['g', 'ml', 'pcs', 'sheets'] as const;
export const MAX_OWN_LINES = 40;

const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Null when every line names something, has an amount and a unit (the server checks the same). */
export const checkOwnLines = (lines: unknown): string | null => {
  if (!Array.isArray(lines) || lines.length === 0) return 'Add at least one line.';
  if (lines.length > MAX_OWN_LINES) return `At most ${MAX_OWN_LINES} lines.`;
  for (const l of lines as BookLine[]) {
    if (typeof l !== 'object' || l === null || typeof l.name !== 'string' || !l.name.trim() || l.name.length > 120) return 'Choose what each line is.';
    if (!positive(l.qty) || l.qty > 1_000_000) return `Type how much ${l.name.startsWith(STOCK_LINE) ? 'of it' : l.name} goes in.`;
    if (!(UNITS as readonly string[]).includes(l.unit)) return 'A line has no unit.';
    if (l.waste !== undefined && !(typeof l.waste === 'number' && l.waste >= 0 && l.waste <= MAX_WASTE)) return `Wastage is 0 to ${MAX_WASTE * 100}%.`;
  }
  return null;
};

/** The most a line may lose on the way: more than this is a different recipe. */
export const MAX_WASTE = 0.9;

/** What a line really takes, its wastage included: 100 g at 20% wastage takes 125 g. */
export const grossQty = (l: BookLine): number => l.qty / (1 - (l.waste ?? 0));

export const MAX_PREP_NAME = 60;

/**
 * Null when this can name a semi-processed item of his: not a batch, a dish or a matched
 * ingredient of his recipe book. A name his sheet uses but never defines ("Fried Chicken
 * Cubes") is allowed: the item then defines it, wherever his recipes name it.
 */
export const checkPrepName = (name: unknown): string | null => {
  if (typeof name !== 'string' || !name.trim()) return 'Type its name.';
  if (name !== name.trim() || name.length > MAX_PREP_NAME) return `At most ${MAX_PREP_NAME} letters.`;
  if (name.startsWith(STOCK_LINE) || name.startsWith(KITCHEN_LINE)) return 'Type its name.';
  const same = (n: string) => n.toLowerCase() === name.toLowerCase();
  if ([...Object.keys(PREPS), ...Object.keys(PRODUCTS), ...Object.keys(INGREDIENT_SOURCES), ...FREE_INGREDIENTS].some(same)) {
    return 'Your recipe book already has that name.';
  }
  return null;
};

/** Refused by the server too: an item naming itself. Through others it takes his answers (makesLoop). */
const INSIDE = 'It can\'t go inside itself.';

/** A line naming his stock, one of his sheet's batches, or one of his own items. */
const madeOf = (name: string) =>
  name.startsWith(STOCK_LINE) || name in PREPS || (name.startsWith(KITCHEN_LINE) && PREP_ID.test(name.slice(KITCHEN_LINE.length)));

/**
 * Null when a semi-processed item is well formed. Its lines are his stock, his sheet's batches
 * and his other items (SCRUM-146); one inside itself is refused where it is set (makesLoop).
 * Where his sheet already uses the name, it keeps the sheet's unit.
 */
const checkPrep = (id: string, a: Extract<Answer, { kind: 'prep' }>): string | null => {
  if (!PREP_ID.test(id)) return 'That is not one of your items.';
  const sheetUnit = typeof a.name === 'string' ? recipeUnit(a.name) : null;
  return checkPrepName(a.name)
    ?? (typeof a.makes === 'object' && a.makes !== null && positive(a.makes.qty) && a.makes.qty <= 1_000_000
      && (UNITS as readonly string[]).includes(a.makes.unit) ? null : 'Type how much one batch makes.')
    ?? (sheetUnit && sheetUnit !== a.makes.unit ? `Your recipes use it in ${sheetUnit}: type the batch in ${sheetUnit}.` : null)
    ?? checkOwnLines(a.lines)
    ?? (a.lines.every((l) => madeOf(l.name)) ? null : 'Choose each line from your stock or what your kitchen makes.')
    ?? (a.lines.some((l) => l.name === kitchenLine(id)) ? INSIDE : null);
};

/**
 * Null when his version of a sheet batch is well formed. In the unit his dishes use it in; its
 * lines are his stock, what the sheet's batch already takes, or what his kitchen makes
 * (SCRUM-146; one inside itself is refused where it is set, makesLoop).
 */
const checkBatch = (name: string, a: Extract<Answer, { kind: 'batch' }>): string | null => {
  const sheet = PREPS[name];
  if (!sheet) return 'That is not one of your batches.';
  const unit = recipeUnit(name) ?? sheet.makes?.unit;
  const taken = new Set(sheet.lines.map((l) => l.name));
  return (typeof a.makes === 'object' && a.makes !== null && positive(a.makes.qty) && a.makes.qty <= 1_000_000
    && (UNITS as readonly string[]).includes(a.makes.unit) ? null : 'Type how much one batch makes.')
    ?? (unit && unit !== a.makes.unit ? `Your recipes use it in ${unit}: type the batch in ${unit}.` : null)
    ?? checkOwnLines(a.lines)
    ?? (a.lines.every((l) => taken.has(l.name) || madeOf(l.name)) ? null : 'Choose each line from your stock or what your kitchen makes.')
    ?? (a.lines.some((l) => l.name === name) ? INSIDE : null);
};

/** Is this a well-formed answer to that question? (The server checks the same.) */
export const checkAnswer = (question: string, a: Answer): string | null => {
  const kind = questionKind(question);
  if (kind === 'prep') return a.kind === 'prep' ? checkPrep(questionSubject(question), a) : 'Write what goes in it.';
  if (kind === 'batch') return a.kind === 'batch' ? checkBatch(questionSubject(question), a) : 'Write what goes in it.';
  if (kind === 'yield') return a.kind === 'yield' && positive(a.qty) ? null : 'Type how much one batch makes.';
  if (kind === 'recipe') {
    if (a.kind === 'own') return checkOwnLines(a.lines);
    return a.kind === 'recipe' && a.product in PRODUCTS ? null : 'Choose one of the recipes.';
  }
  if (kind === 'addon') return a.kind === 'own' ? checkOwnLines(a.lines) : 'Write the recipe.';
  if (kind === 'resources') return a.kind === 'resources' ? checkResourceLines(a.lines) : 'Add what it takes.';
  if (kind === 'rates') return a.kind === 'rates' && question === RATES_QUESTION ? checkRates(a.rates) : 'Type the rates.';
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
  /** His sheet recipe for it, if that is what it is made with. */
  product: string | null;
  /** Where its recipe comes from; null: no recipe yet. */
  origin: RecipeOrigin | null;
}

const MAX_DEPTH = 8; // preps inside preps (pizza → dough ball → dough batch → culture)

/** The price-list item behind one of his ingredients, from the map or his answer. */
export const sourceOf = (name: string, answers: ReadonlyMap<string, Answer>) => {
  if (name.startsWith(STOCK_LINE)) return { inventoryId: name.slice(STOCK_LINE.length), per: 1 };
  const answer = answers.get(ingredientQuestion(name));
  return INGREDIENT_SOURCES[name] ?? (answer?.kind === 'source' ? answer : null);
};

export interface OwnPrep { id: string; name: string; makes: { qty: number; unit: string }; lines: BookLine[] }

const ownCache = new WeakMap<ReadonlyMap<string, Answer>, OwnPrep[]>();

/** The semi-processed items he added in the app, A to Z. */
export const ownPreps = (answers: ReadonlyMap<string, Answer>): OwnPrep[] => {
  // Asked for every recipe line of every sale: worked out once per set of answers.
  let list = ownCache.get(answers);
  if (!list) {
    list = [...answers]
      .flatMap(([q, a]) => (questionKind(q) === 'prep' && a.kind === 'prep' ? [{ id: questionSubject(q), name: a.name, makes: a.makes, lines: a.lines }] : []))
      .sort((a, b) => a.name.localeCompare(b.name));
    ownCache.set(answers, list);
  }
  return list;
};

/** His own item a recipe line names: `kitchen:<id>`, or the name his sheet uses for it. */
export const ownPrepOf = (line: string, answers: ReadonlyMap<string, Answer>): OwnPrep | null => {
  if (line.startsWith(KITCHEN_LINE)) {
    const id = line.slice(KITCHEN_LINE.length);
    const a = answers.get(prepQuestion(id));
    return a?.kind === 'prep' ? { id, name: a.name, makes: a.makes, lines: a.lines } : null;
  }
  return ownPreps(answers).find((p) => p.name === line) ?? null;
};

/** His own version of a sheet batch, if he changed it in the app. */
export const batchEdit = (name: string, answers: ReadonlyMap<string, Answer>): Prep | null => {
  const a = name in PREPS ? answers.get(batchQuestion(name)) : undefined;
  return a?.kind === 'batch' ? { makes: a.makes, lines: a.lines } : null;
};

/** A batch from his sheet (as he changed it, if he did), else a semi-processed item he added in the app. */
export const prepOf = (name: string, answers: ReadonlyMap<string, Answer>): Prep | null =>
  batchEdit(name, answers) ?? PREPS[name] ?? ownPrepOf(name, answers);

/** The semi-processed item a line names, as one key (a sheet batch by name, his own as kitchen:<id>); null: not one. */
const prepIdentity = (name: string, answers: ReadonlyMap<string, Answer>): string | null => {
  if (name in PREPS) return name;
  const own = ownPrepOf(name, answers);
  return own ? kitchenLine(own.id) : null;
};

/** How deep his items may sit inside each other, leaving room for the dish above them. */
const MAX_PREP_CHAIN = MAX_DEPTH - 2;

/**
 * Would this answer put a semi-processed item inside itself, directly or through others
 * (SCRUM-146)? A chain deeper than recipes are followed counts as one too.
 */
export const makesLoop = (question: string, answer: Answer | null, answers: ReadonlyMap<string, Answer>): boolean => {
  if (!answer || (answer.kind !== 'prep' && answer.kind !== 'batch')) return false;
  const self = answer.kind === 'prep' ? kitchenLine(questionSubject(question)) : questionSubject(question);
  const trial = new Map(answers).set(question, answer);
  const seen = new Set<string>();
  const inside = (lines: readonly BookLine[], depth: number): boolean => lines.some((l) => {
    const key = prepIdentity(l.name, trial);
    if (!key) return false;
    if (key === self || depth >= MAX_PREP_CHAIN) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return inside(prepOf(l.name, trial)?.lines ?? [], depth + 1);
  });
  return inside(answer.lines, 0);
};

/**
 * Names his sheet's recipes for menu dishes use but nothing defines (no batch, no price-list
 * item, no item of his own yet), most used first: what a new semi-processed item may be.
 */
export const undefinedNames = (answers: ReadonlyMap<string, Answer>): { name: string; unit: string; dishes: number }[] => {
  const own = new Set(ownPreps(answers).map((p) => p.name));
  const found = new Map<string, { name: string; unit: string; dishes: number }>();
  for (const product of new Set(Object.values(MENU_RECIPES))) {
    for (const l of new Set((PRODUCTS[product] ?? []).map((x) => x.name))) {
      if (checkPrepName(l) || own.has(l) || answers.has(ingredientQuestion(l))) continue;
      const f = found.get(l) ?? { name: l, unit: recipeUnit(l) ?? 'g', dishes: 0 };
      found.set(l, { ...f, dishes: f.dishes + 1 });
    }
  }
  return [...found.values()].sort((a, b) => b.dishes - a.dishes || a.name.localeCompare(b.name));
};

/**
 * How much one batch of his makes, in the unit `unit` it is used in: his sheet, then his answer
 * in the app, then what he confirmed outside it (recipeMap.ts). Null: not known yet.
 */
export const batchMakes = (name: string, unit: string, answers: ReadonlyMap<string, Answer>): { qty: number; unit: string } | null => {
  const prep = prepOf(name, answers);
  if (!prep) return null;
  if (prep.makes) return prep.makes;
  const answer = answers.get(yieldQuestion(name));
  if (answer?.kind === 'yield') return { qty: answer.qty, unit };
  const confirmed = CONFIRMED_BATCHES[name];
  if (confirmed === 'sum') {
    // Only when every line is in the same unit as its use (grams of sauce from grams of tomato).
    return prep.lines.every((l) => l.unit === unit) ? { qty: prep.lines.reduce((n, l) => n + l.qty, 0), unit } : null;
  }
  return confirmed ?? null;
};

/** Unrounded cost of some recipe lines; adds every gap met on the way to `missing`. */
const sumLines = (lines: readonly BookLine[], ctx: CostContext, missing: Set<string>, depth: number): number =>
  lines.reduce((sum, line) => sum + lineCost(line, ctx, missing, depth), 0);

const lineCost = (line: BookLine, ctx: CostContext, missing: Set<string>, depth: number): number => {
  if (depth > MAX_DEPTH) throw new Error(`recipe nesting too deep at ${line.name}`);
  if (FREE_INGREDIENTS.has(line.name)) return 0;

  const prep = prepOf(line.name, ctx.answers);
  if (prep) {
    const makes = batchMakes(line.name, line.unit, ctx.answers);
    const batch = sumLines(prep.lines, ctx, missing, depth + 1); // collect its gaps too, all at once
    if (!makes || makes.unit !== line.unit) { missing.add(yieldQuestion(line.name)); return 0; }
    return (batch / makes.qty) * grossQty(line);
  }

  const product = PRODUCTS[line.name];
  if (product) return sumLines(product, ctx, missing, depth + 1) * grossQty(line); // a sold item used inside another

  const source = sourceOf(line.name, ctx.answers);
  if (source) {
    const item = ctx.items.find((i) => i.id === source.inventoryId);
    if (item && item.workingPriceCents > 0) return (item.workingPriceCents / item.packQty) * source.per * grossQty(line);
    missing.add(ingredientQuestion(line.name)); // the item is gone, or has no price yet
    return 0;
  }
  const price = ctx.answers.get(ingredientQuestion(line.name));
  if (price?.kind === 'price') return (price.cents / price.qty) * grossQty(line);
  missing.add(ingredientQuestion(line.name));
  return 0;
};

/** One line's cost, unrounded (Visual Flow sums many small ones), and the gaps met on the way. */
export const exactLineCost = (line: BookLine, ctx: CostContext): { cents: number; missing: string[] } => {
  const missing = new Set<string>();
  const cents = lineCost(line, ctx, missing, 0);
  return { cents, missing: [...missing] };
};

/** What some recipe lines cost, before they belong to any item (a dish still being added). */
export const linesCost = (lines: readonly BookLine[], ctx: CostContext): Pick<Cost, 'cents' | 'complete' | 'missing'> => {
  const missing = new Set<string>();
  const cents = Math.round(sumLines(lines, ctx, missing, 0));
  return { cents, complete: missing.size === 0, missing: [...missing] };
};

/** His recipe for a menu item and size ('' when the item has no sizes), if known. */
export const recipeFor = (itemId: string, size: string, answers: ReadonlyMap<string, Answer>): string | null => {
  const answer = answers.get(recipeQuestion(itemId, size));
  return MENU_RECIPES[`${itemId}:${size}`] ?? (answer?.kind === 'recipe' ? answer.product : null);
};

/** Where a recipe comes from: written in the app, his sheet as matched, or his sheet as he chose. */
export type RecipeOrigin = 'own' | 'sheet' | 'chosen';
export interface Recipe { lines: readonly BookLine[]; origin: RecipeOrigin; product: string | null }

/** What one menu item in one size is made of: his own recipe first, then his sheet. */
export const recipeOf = (itemId: string, size: string, answers: ReadonlyMap<string, Answer>): Recipe | null => {
  const answer = answers.get(recipeQuestion(itemId, size));
  if (answer?.kind === 'own') return { lines: answer.lines, origin: 'own', product: null };
  const product = recipeFor(itemId, size, answers);
  if (!product || !PRODUCTS[product]) return null;
  return { lines: PRODUCTS[product], origin: MENU_RECIPES[`${itemId}:${size}`] ? 'sheet' : 'chosen', product };
};

/** What one menu extra adds: his own recipe for it, else his sheet's add-on recipe. */
export const addonOf = (extraId: string, answers: ReadonlyMap<string, Answer>): Recipe | null => {
  const answer = answers.get(addonQuestion(extraId));
  if (answer?.kind === 'own') return { lines: answer.lines, origin: 'own', product: null };
  const product = ADD_RECIPES[extraId];
  return product && PRODUCTS[product] ? { lines: PRODUCTS[product], origin: 'sheet', product } : null;
};

const costOf = (recipe: Recipe | null, question: string, ctx: CostContext): Cost => {
  if (!recipe) return { cents: 0, complete: false, missing: [question], product: null, origin: null };
  const missing = new Set<string>();
  const cents = Math.round(sumLines(recipe.lines, ctx, missing, 0));
  return { cents, complete: missing.size === 0, missing: [...missing], product: recipe.product, origin: recipe.origin };
};

/** The cost of one menu item in one size. */
export const menuCost = (itemId: string, size: string, ctx: CostContext): Cost =>
  costOf(recipeOf(itemId, size, ctx.answers), recipeQuestion(itemId, size), ctx);

/** The cost of one menu extra. */
export const addonCost = (extraId: string, ctx: CostContext): Cost =>
  costOf(addonOf(extraId, ctx.answers), addonQuestion(extraId), ctx);

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

const KIND_ORDER: Record<QuestionKind, number> = { yield: 0, recipe: 1, addon: 2, ingredient: 3, prep: 4, batch: 5, resources: 6, rates: 7 };

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
  if (kind === 'addon') return `The recipe for extra ${subject}`;
  if (kind === 'prep' || kind === 'batch') return `What goes in ${subject}`;
  if (kind === 'resources') return `What making ${subject} takes`;
  if (kind === 'rates') return 'The shop\'s rates';
  const [itemId, size] = subject.split(':');
  const item = menu.find((m) => m.id === itemId);
  return `Which recipe is ${item?.name.en ?? itemId}${size ? ` ${size}` : ''}`;
};

/** A gap in the fewest words, for the owner: "Mozzarella Blend batch size", "Basil price". */
export const gapName = (id: string, menu: readonly MenuItem[]): string => {
  const subject = questionSubject(id);
  const kind = questionKind(id);
  if (kind === 'yield') return `${subject.replace(/ batch$/i, '')} batch size`;
  if (kind === 'ingredient') return `${subject} price`;
  return questionText(id, menu).replace(/^Which recipe is (.*)$/, 'the recipe for $1');
};

/** "waiting on Mozzarella Blend batch size, Pizza Sauce batch size, Basil price and 2 more". */
export const waitingOn = (missing: readonly string[], menu: readonly MenuItem[], show = 3): string => {
  // Batch sizes first (each completes many items), then recipes and prices: the Recipes screen's order.
  const names = [...new Set(missing)]
    .sort((a, b) => KIND_ORDER[questionKind(a)] - KIND_ORDER[questionKind(b)] || a.localeCompare(b))
    .map((q) => gapName(q, menu));
  const more = names.length - show;
  return `waiting on ${names.slice(0, show).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
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
