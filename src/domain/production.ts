import { batchMakes, grossQty, prepOf, type Answer } from './costing.ts';
import { PREP_STOCK, prepKey, type PrepOrder } from './prep.ts';
import { bookUsage, lineUsage, type Tracked } from './stockUsage.ts';
import type { OrderLine } from './types.ts';

/**
 * Production with its dependencies (Culture › Dough › Dough Ball › Pizza), on the one stock ledger
 * (inventory.ts). Sending a semi-processed item to the kitchen checks what it is made from: what is
 * not on hand is sent first, as batches of its own (whole batches, what is left over stays for the
 * next one), and the item itself waits, held, until its inputs are on hand. The shop server then
 * releases it to the kitchen (scheduler.ts), oldest first; every device folds the same records the
 * same way, so a release is never made twice and nothing is taken twice.
 *
 * Amounts are by node id, as Visual Flow names things: `stock:<inventory id>` for a price-list item
 * (base units), `semi:<key>` for a semi-processed item (in the unit its stock is counted in).
 * A price-list item nobody has counted is not known, so it never holds production back; a
 * semi-processed item with no batch made yet has nothing on hand, so it is made first.
 */
/** unit: a semi-processed item's, the unit it is counted in; a price-list item's amount is in base units. */
export interface Need { id: string; qty: number; unit?: string }

const EPS = 1e-6;
const MAX_CHAIN = 8; // as deep as recipes are followed

/** A semi-processed item's line, if a batch of it is counted in the unit the line uses. */
const semiLine = (name: string, unit: string, answers: ReadonlyMap<string, Answer>, tracked: Tracked): string | null => {
  const key = prepKey(name, answers);
  if (!key) return null;
  const makes = batchMakes(name, unit, answers);
  const t = tracked.get(key);
  return makes && makes.unit === unit && (t === undefined || t === unit) ? key : null;
};

/**
 * What a batch of `qty` (in `unit`) takes straight from stock: the semi-processed items it is
 * made from, and the price-list items for the rest. Empty when what one batch makes is not known.
 */
export const directNeeds = (key: string, qty: number, unit: string, answers: ReadonlyMap<string, Answer>, tracked: Tracked): Need[] => {
  const prep = prepOf(key, answers);
  const makes = prep && batchMakes(key, unit, answers);
  if (!prep || !makes || makes.unit !== unit || !(qty > 0)) return [];
  const batches = qty / makes.qty;
  const out = new Map<string, Need>();
  const add = (id: string, qty: number, unit?: string) => {
    const was = out.get(id);
    if (was) was.qty += qty; else out.set(id, { id, qty, ...(unit ? { unit } : {}) });
  };
  for (const l of prep.lines) {
    const semi = semiLine(l.name, l.unit, answers, tracked);
    if (semi) { add(`semi:${semi}`, grossQty(l) * batches, l.unit); continue; }
    for (const u of lineUsage(l, batches, answers, tracked)) {
      const k = u.inventoryId.startsWith(PREP_STOCK) ? u.inventoryId.slice(PREP_STOCK.length) : null;
      if (k) add(`semi:${k}`, u.qtyBaseUnits, tracked.get(k)); else add(`stock:${u.inventoryId}`, u.qtyBaseUnits);
    }
  }
  return [...out.values()].filter((n) => n.qty > 0);
};

export interface LedgerInput {
  answers: ReadonlyMap<string, Answer>;
  /** Semi-processed items with a stock of their own, and its unit. */
  tracked: Tracked;
  /** On hand, by node id: price-list items that were counted, and tracked semi-processed items. */
  onHand: ReadonlyMap<string, number>;
  /** In the kitchen now (released, not Done). */
  open: readonly PrepOrder[];
  /** Held for their inputs, oldest first. */
  waiting: readonly PrepOrder[];
}

export interface Ledger {
  answers: ReadonlyMap<string, Answer>;
  tracked: Tracked;
  /** Spoken for by batches in the kitchen, by node id. */
  reserved: ReadonlyMap<string, number>;
  /** On hand less what is spoken for; missing: not known (a price-list item never counted). */
  available: ReadonlyMap<string, number>;
  /** Held batches whose inputs are on hand now, oldest first: what the server releases next. */
  due: PrepOrder[];
  /** For planning a new batch: available, plus batches coming, less what held batches wait to take. */
  projected: ReadonlyMap<string, number>;
  /** What held batches still wait for, by node id: the shortage. */
  short: ReadonlyMap<string, number>;
  /** On hand now and not spoken for by any batch, held ones included: a new batch can use it at once. */
  ready: ReadonlyMap<string, number>;
}

const sub = (m: Map<string, number>, id: string, n: number) => { if (m.has(id)) m.set(id, m.get(id)! - n); };

export const ledgerOf = ({ answers, tracked, onHand, open, waiting }: LedgerInput): Ledger => {
  const needsOf = (o: PrepOrder) => directNeeds(o.prepId, o.qty, o.unit, answers, tracked);
  const reserved = new Map<string, number>();
  for (const o of open) for (const n of needsOf(o)) reserved.set(n.id, (reserved.get(n.id) ?? 0) + n.qty);
  const available = new Map<string, number>();
  for (const [id, q] of onHand) available.set(id, q - (reserved.get(id) ?? 0));

  // Held batches, oldest first: one goes when all it takes is there, and takes it from the next.
  const free = new Map(available);
  const has = (id: string) => free.has(id) || id.startsWith('semi:'); // a semi-processed item with no stock has none
  const due: PrepOrder[] = [];
  const still: PrepOrder[] = [];
  for (const o of [...waiting].sort((a, b) => a.at - b.at)) {
    const needs = needsOf(o);
    if (needs.every((n) => !has(n.id) || (free.get(n.id) ?? 0) + EPS >= n.qty)) {
      for (const n of needs) sub(free, n.id, n.qty);
      due.push(o);
    } else still.push(o);
  }

  // What a new batch can count on: what is free, the batches on their way, less what the held ones wait to take.
  const projected = new Map(free);
  for (const o of [...open, ...due, ...still]) {
    const id = `semi:${o.prepId}`;
    projected.set(id, (projected.get(id) ?? 0) + o.qty);
  }
  const short = new Map<string, number>();
  for (const o of still) {
    for (const n of needsOf(o)) {
      if (!has(n.id)) continue;
      const before = projected.get(n.id) ?? 0;
      projected.set(n.id, before - n.qty);
      const gap = n.qty - Math.max(0, free.get(n.id) ?? 0);
      if (gap > EPS) short.set(n.id, (short.get(n.id) ?? 0) + gap);
      sub(free, n.id, Math.min(n.qty, Math.max(0, free.get(n.id) ?? 0)));
    }
  }
  return { answers, tracked, reserved, available, due, projected, short, ready: free };
};

/** One batch to send: children first, the one asked for last. */
export interface PlannedBatch { prepId: string; name: string; qty: number; unit: string; waitFor: string[] }

export interface Plan {
  batches: PlannedBatch[];
  /** Price-list items short for them, in base units: what to buy (by inventory id). */
  buy: Map<string, number>;
  problem: string | null;
}

/**
 * Plans `qty` of a semi-processed item: what it is made from that is not there is planned first,
 * in whole batches, down every level; what is still coming (a batch in the kitchen not spoken for)
 * is counted on, so nothing is sent twice. `nameOf` names a node id for the screens.
 */
export const planProduction = (
  target: { key: string; name: string; qty: number; unit: string }, ledger: Ledger, nameOf: (id: string) => string,
): Plan => {
  const { answers, tracked } = ledger;
  const free = new Map(ledger.projected);
  const ready = new Map(ledger.ready);
  const batches: PlannedBatch[] = [];
  const buy = new Map<string, number>();

  const visit = (key: string, name: string, qty: number, unit: string, path: readonly string[]): string | null => {
    if (path.includes(key)) return `${name} is made from itself: change its recipe first.`;
    if (path.length > MAX_CHAIN) return `${name} is made from too many levels of items.`;
    const waitFor: string[] = [];
    for (const n of directNeeds(key, qty, unit, answers, tracked)) {
      if (n.id.startsWith('stock:')) {
        const f = free.get(n.id);
        if (f === undefined) continue; // never counted: not known, so it holds nothing back
        if (f + EPS < n.qty) {
          const itemId = n.id.slice('stock:'.length);
          buy.set(itemId, (buy.get(itemId) ?? 0) + n.qty - Math.max(0, f));
          waitFor.push(nameOf(n.id));
        }
        free.set(n.id, f - n.qty);
        continue;
      }
      const f = free.get(n.id) ?? 0;
      const r = ready.get(n.id) ?? 0;
      ready.set(n.id, r - n.qty);
      if (f + EPS >= n.qty) {
        free.set(n.id, f - n.qty);
        if (r + EPS < n.qty) waitFor.push(nameOf(n.id)); // coming from the kitchen, not here yet
        continue;
      }
      const child = n.id.slice('semi:'.length);
      const childName = nameOf(n.id);
      const makes = batchMakes(child, n.unit ?? 'pcs', answers);
      waitFor.push(childName);
      if (!makes || makes.unit !== n.unit) { free.set(n.id, f - n.qty); continue; } // what a batch makes is not known: it waits until one is made
      const short = n.qty - Math.max(0, f);
      const make = Math.ceil(short / makes.qty - EPS) * makes.qty;
      const problem = visit(child, childName, make, makes.unit, [...path, key]);
      if (problem) return problem;
      free.set(n.id, Math.max(0, f) + make - n.qty);
    }
    batches.push({ prepId: key, name, qty, unit, waitFor });
    return null;
  };
  const problem = visit(target.key, target.name, target.qty, target.unit, []);
  return problem ? { batches: [], buy: new Map(), problem } : { batches, buy, problem: null };
};

/**
 * How many of a dish what is on hand makes now, by its scarcest input; null: nothing it takes is
 * known (no recipe, or nothing counted). A finished item is made to order, so this is its stock.
 */
export const canMake = (itemId: string, size: string, ledger: Ledger): number | null => {
  const usage = bookUsage({ itemId, qty: 1, ...(size ? { size: size as OrderLine['size'] } : {}), adds: [], outs: [] }, ledger.answers, ledger.tracked);
  let most: number | null = null;
  for (const u of usage) {
    const id = u.inventoryId.startsWith(PREP_STOCK) ? `semi:${u.inventoryId.slice(PREP_STOCK.length)}` : `stock:${u.inventoryId}`;
    const left = ledger.available.get(id);
    if (left === undefined || !(u.qtyBaseUnits > 0)) continue;
    const n = Math.max(0, Math.floor(left / u.qtyBaseUnits + EPS));
    most = most === null ? n : Math.min(most, n);
  }
  return most;
};

/** "Culture and Dough Batch", "Flour, Yeast and Salt". */
export const andList = (names: readonly string[]): string =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * What sending a plan tells the person: "Culture sent to the kitchen first. Dough will be sent
 * automatically when ready."; what still has to be bought is said by name.
 */
export const planNotice = (plan: Plan, amount: (qty: number, unit: string) => string): string => {
  const target = plan.batches.at(-1);
  if (!target) return plan.problem ?? '';
  const now = plan.batches.filter((b) => !b.waitFor.length);
  const later = plan.batches.filter((b) => b.waitFor.length);
  if (!later.length) return `${target.name}: sent to the kitchen · ${amount(target.qty, target.unit)}.`;
  const raw = [...new Set(later.flatMap((b) => b.waitFor).filter((n) => !plan.batches.some((x) => x.name === n)))];
  const plural = later.length > 1 ? 'are' : 'is';
  if (!now.length) return `${andList(later.map((b) => b.name))} ${plural} waiting for ${andList(raw)}. It goes to the kitchen automatically once received.`;
  const buy = raw.length ? ` Waiting for ${andList(raw)} to be received.` : '';
  return `${andList(now.map((b) => b.name))} sent to the kitchen first. ${andList(later.map((b) => b.name))} will be sent automatically when ready.${buy}`;
};
