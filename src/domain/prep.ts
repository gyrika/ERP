import { batchMakes, kitchenLine, ownPrepOf, ownPreps, prepOf, recipeUnit, UNITS, type Answer } from './costing.ts';
import { PREPS, type BookLine } from './recipeBook.ts';
import type { SyncEvent } from './sync.ts';
import { TICKET_HORIZON_MS } from './kitchen.ts';

/**
 * Semi-processed items as stock (SCRUM-136). Running low, an item is sent to the kitchen as a
 * prep ticket (`prep.ordered`); the cook Starts it and marks it Done like an order, and Done is
 * the batch made. From an item's first batch on it has a stock of its own: a batch takes its raw
 * items, a sale takes the item (stockUsage.ts). Items with no batch made keep the old way,
 * a sale straight through the batch to the raw items, so nothing is counted twice.
 *
 * An item is known by its key: his own items as `kitchen:<id>`, his sheet's batches by name,
 * the same names recipe lines and the waste bin use.
 */
export interface PrepItem {
  key: string;
  name: string;
  /** What its stock is counted in: what one batch makes in, else what his dishes use it in. */
  unit: string;
  /** One batch's output; null: he has not said yet, so the kitchen types what it made. */
  makes: { qty: number; unit: string } | null;
  lines: readonly BookLine[];
  own: boolean;
}

/** His own items (A to Z), then his sheet's batches (A to Z): the Semi-processed list. */
export const prepItems = (answers: ReadonlyMap<string, Answer>): PrepItem[] => [
  ...ownPreps(answers).map((p): PrepItem => ({ key: kitchenLine(p.id), name: p.name, unit: p.makes.unit, makes: p.makes, lines: p.lines, own: true })),
  ...Object.keys(PREPS).sort((a, b) => a.localeCompare(b)).map((name): PrepItem => {
    const makes = batchMakes(name, recipeUnit(name) ?? PREPS[name].makes?.unit ?? 'pcs', answers);
    const unit = makes?.unit ?? recipeUnit(name) ?? 'pcs';
    return { key: name, name, unit, makes, lines: prepOf(name, answers)?.lines ?? PREPS[name].lines, own: false };
  }),
];

/** The item a recipe line names, by its key (a sheet name his own item defines is that item); null: not one. */
export const prepKey = (line: string, answers: ReadonlyMap<string, Answer>): string | null => {
  if (line in PREPS) return line;
  const own = ownPrepOf(line, answers);
  return own ? kitchenLine(own.id) : null;
};

/** The semi-processed items made from this one (SCRUM-141): the dough balls for the dough batch. */
export const madeFrom = (key: string, items: readonly PrepItem[], answers: ReadonlyMap<string, Answer>): PrepItem[] =>
  items.filter((p) => p.key !== key && p.lines.some((l) => prepKey(l.name, answers) === key));

/** Everything made from this one, however far down: what may never go into it (SCRUM-146). */
export const madeFromAll = (key: string, items: readonly PrepItem[], answers: ReadonlyMap<string, Answer>): Set<string> => {
  const found = new Set<string>();
  const walk = (k: string) => {
    for (const p of madeFrom(k, items, answers)) if (!found.has(p.key)) { found.add(p.key); walk(p.key); }
  };
  walk(key);
  return found;
};

/** A line taking part of a batch that is counted in batches (it makes 1 pcs). */
const partOfBatch = (line: BookLine, answers: ReadonlyMap<string, Answer>): boolean => {
  if (!prepOf(line.name, answers)) return false;
  const makes = batchMakes(line.name, line.unit, answers);
  return !!makes && makes.unit === 'pcs' && makes.qty === 1 && line.unit === 'pcs' && line.qty > 0 && line.qty < 1;
};

/**
 * How many one batch makes, for a line taking a whole share of a batch counted in batches:
 * 12 for 0.0833 pcs of the dough batch (a sheet keeps 4 decimal places); null: not one.
 */
export const perBatch = (line: BookLine, answers: ReadonlyMap<string, Answer>): number | null => {
  if (!partOfBatch(line, answers)) return null;
  const n = Math.round(1 / line.qty);
  return Math.abs(1 / n - line.qty) < 5e-4 ? n : null;
};

/** The line for "one batch makes n": 1/n of a batch, to 6 places (SCRUM-146). */
export const shareLine = (line: BookLine, n: number): BookLine => ({ ...line, qty: Number((1 / n).toFixed(6)) });

/** The most one batch can be said to make, so 1/n still reads back as n. */
export const MAX_PER_BATCH = 999;

/** Such a line as a share of the batch: "1/12 batch", "0.35 batch"; null: show it as it is. */
export const batchShare = (line: BookLine, answers: ReadonlyMap<string, Answer>): string | null => {
  if (!partOfBatch(line, answers)) return null;
  const n = perBatch(line, answers);
  return n ? `1/${n} batch` : `${Number(line.qty.toFixed(2))} batch`;
};

/** What a prep's stock row reads: what is on hand from the batches made since it was first made. */
export const PREP_STOCK = 'prep:';
export const prepStockId = (key: string) => `${PREP_STOCK}${key}`;

export const MAX_BATCH_QTY = 1e6;

/** Why a batch cannot be sent to the kitchen, or null (the server checks the same). */
export const checkPrepOrder = (prepId: unknown, name: unknown, qty: unknown, unit: unknown): string | null => {
  if (!(typeof prepId === 'string' && prepId.length > 0 && prepId.length <= 120)) return 'Choose what was made';
  if (!(typeof name === 'string' && name.length > 0 && name.length <= 120)) return 'Choose what was made';
  if (!(typeof unit === 'string' && (UNITS as readonly string[]).includes(unit))) return 'Choose what was made';
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0 || qty > MAX_BATCH_QTY) return 'Type how much to make';
  return null;
};

/** "Make more when below": a positive amount in the item's unit, or null for automatic. */
export const checkPrepLimit = (value: unknown): string | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_BATCH_QTY) ? null : 'Type an amount above 0, or leave it empty';

/** A semi-processed item's stock as it stands. */
export interface PrepStock {
  key: string;
  unit: string;
  /** A batch is recorded and not undone: its stock is known, and sales take from it. */
  tracked: boolean;
  onHand: number;
  /** What sales took from it a day, over the stock rules' usage days (whether tracked or not). */
  usedPerDay: number;
  /** "Make more when below" this amount; null: automatic (less than a day's usual use). */
  makeBelow: number | null;
  /** When its last batch was made. */
  lastMadeAt: number | null;
  /** Sent to the kitchen and not Done yet, in its unit. */
  inKitchen: number;
  /** Held by batches in the kitchen that are made from it (production.ts): on hand, but spoken for. */
  reserved: number;
  /** Sent, but waiting for what it is made from before it reaches the kitchen. */
  waiting: number;
  /** What those waiting batches wait for, by name. */
  waitingFor: string[];
}

export type PrepStatus = 'out' | 'low' | 'ok' | 'unknown';

/** unknown: no batch recorded yet. low: at or below his "make more" amount, or below a day's usual use. */
export const prepStatus = (p: Pick<PrepStock, 'tracked' | 'onHand' | 'usedPerDay' | 'makeBelow'>): PrepStatus => {
  if (!p.tracked) return 'unknown';
  if (p.onHand <= 0) return 'out';
  if (p.makeBelow !== null ? p.onHand <= p.makeBelow : p.onHand < p.usedPerDay) return 'low';
  return 'ok';
};

/** "6 pcs", "1,250 g": whole amounts as they are, the rest to one decimal place. */
export const prepAmount = (qty: number, unit: string): string =>
  `${Number((Math.round(qty * 10) / 10).toFixed(1)).toLocaleString('en-US')} ${unit}`;

/**
 * One batch sent to the kitchen: what, and how much. held: waiting for what it is made from
 * (`waitFor`, by name), not on the kitchen screen until released (production.ts); `at` is when
 * it reached the kitchen. plan: the ticket the person asked for, when this one was sent for it.
 */
export interface PrepOrder { ticketId: string; prepId: string; name: string; qty: number; unit: string; at: number; held: boolean; waitFor: string[]; plan?: string }

/**
 * Prep tickets as batches, in event order (stock and waste history share it, so they agree).
 * `step` says what an event does: a prep ticket marked Done is a batch made; its Undo, or taking
 * the ticket back after Done, unmakes it. An item is tracked while a batch of it stands; one unit
 * per item: a batch in another unit than its first is not made.
 */
export const prepTracker = () => {
  const orders = new Map<string, PrepOrder>();
  const done = new Set<string>();
  const standing = new Map<string, number>();
  const tracked = new Map<string, string>();
  const unmake = (o: PrepOrder) => {
    done.delete(o.ticketId);
    const left = (standing.get(o.prepId) ?? 1) - 1;
    if (left > 0) standing.set(o.prepId, left);
    else { standing.delete(o.prepId); tracked.delete(o.prepId); }
  };
  return {
    /** Items with a batch standing, with the unit their stock is counted in. */
    tracked: tracked as ReadonlyMap<string, string>,
    /** Sent and not Done yet, and still on the kitchen screen (it shows a day's tickets). */
    open: (now: number): PrepOrder[] => [...orders.values()].filter((o) => !o.held && !done.has(o.ticketId) && now - o.at <= TICKET_HORIZON_MS),
    /** Held for what it is made from, oldest first: released in this order. */
    waiting: (): PrepOrder[] => [...orders.values()].filter((o) => o.held),
    step(e: SyncEvent): { kind: 'made' | 'unmade'; order: PrepOrder } | null {
      switch (e.type) {
        case 'prep.ordered': {
          const waitFor = e.waitFor ?? [];
          if (!orders.has(e.ticketId)) {
            orders.set(e.ticketId, {
              ticketId: e.ticketId, prepId: e.prepId, name: e.name, qty: e.qty, unit: e.unit, at: e.at, held: waitFor.length > 0, waitFor, ...(e.plan ? { plan: e.plan } : {}),
            });
          }
          return null;
        }
        case 'prep.released': {
          // Reaches the kitchen now; a second release, or one for an order taken back, changes nothing.
          const o = orders.get(e.ticketId);
          if (o?.held) orders.set(e.ticketId, { ...o, held: false, at: e.at });
          return null;
        }
        case 'prep.order_undone': {
          const o = orders.get(e.ticketId);
          if (!o) return null;
          orders.delete(e.ticketId);
          if (!done.has(o.ticketId)) return null;
          unmake(o);
          return { kind: 'unmade', order: o };
        }
        case 'kitchen.bumped': {
          const o = orders.get(e.ticketId);
          if (!o || o.held || done.has(o.ticketId)) return null;
          const unit = tracked.get(o.prepId);
          if (unit !== undefined && unit !== o.unit) return null;
          done.add(o.ticketId);
          standing.set(o.prepId, (standing.get(o.prepId) ?? 0) + 1);
          tracked.set(o.prepId, o.unit);
          return { kind: 'made', order: { ...o, at: e.at } };
        }
        case 'kitchen.unbumped': {
          const o = orders.get(e.ticketId);
          if (!o || !done.has(o.ticketId)) return null;
          unmake(o);
          return { kind: 'unmade', order: o };
        }
        default: return null;
      }
    },
  };
};
