import { answersFromEvents, exactLineCost, type Answer } from './costing.ts';
import { stockFromEvents, type InventoryRow, type Stock } from './inventory.ts';
import type { InventoryItem } from './inventoryData.ts';
import { fmt } from './money.ts';
import { prepItems } from './prep.ts';
import type { Insight, ShopData } from './insights.ts';
import type { SyncEvent } from './sync.ts';
import type { Cents } from './types.ts';

/**
 * Stock value (SCRUM-163): the money sitting on the shelves, worked out from the stock the
 * shop already keeps, so nothing new is stored and it moves by itself with every delivery,
 * batch, sale, waste and count. Value = on hand × unit cost.
 *
 * - Raw materials: on hand × the latest price entered (per base unit). Never counted: unknown,
 *   left out of the total (never a fake zero, like the stock).
 * - Semi-processed: on hand × what one unit costs to make (his recipe, costing.ts). Making a
 *   batch takes its raw items off, so the batch is counted once, here.
 * - Finished: made to order. Their stock is the raw and semi-processed items they are made
 *   from, already counted above, so they add nothing (no double counting).
 *
 * Node ids are the production ledger's: `stock:<inventory id>` and `semi:<key>`.
 */
export type ValueKind = 'raw' | 'semi' | 'finished';

export interface ItemValue {
  id: string;
  kind: ValueKind;
  name: string;
  /** On hand: base units for a raw item, the item's own unit for a semi-processed one. Never below 0. */
  qty: number;
  unit: string;
  /** One unit's cost, unrounded cents; null: no price yet, or his recipe has a gap. */
  unitCents: number | null;
  /** qty × unitCents, rounded once; null: not known (not counted, or no cost). */
  cents: Cents | null;
}

export interface Valuation {
  items: ItemValue[];
  /** Each kind's known value. Finished is always 0 (see above). */
  byKind: Record<ValueKind, Cents>;
  total: Cents;
  /** Items left out of the total because their value is not known. */
  notCounted: number;
  noCost: number;
}

/** A raw item's unit cost (cents per base unit, unrounded) and value; null where not known. */
export const rawValue = (r: Pick<InventoryRow, 'workingPriceCents' | 'packQty' | 'onHandBaseUnits' | 'counted'>): { unitCents: number | null; cents: Cents | null } => {
  const unitCents = r.workingPriceCents > 0 && r.packQty > 0 ? r.workingPriceCents / r.packQty : null;
  return { unitCents, cents: r.counted && unitCents !== null ? Math.round(Math.max(0, r.onHandBaseUnits) * unitCents) : null };
};

/** The value of the stock as it stands. */
export const valuationOf = (stock: Pick<Stock, 'rows' | 'preps'>, answers: ReadonlyMap<string, Answer>): Valuation => {
  const out: ItemValue[] = [];
  let notCounted = 0;
  let noCost = 0;
  for (const r of stock.rows) {
    if (r.archived) continue;
    const { unitCents, cents } = rawValue(r);
    if (!r.counted) notCounted += 1;
    else if (unitCents === null) noCost += 1;
    out.push({ id: `stock:${r.id}`, kind: 'raw', name: r.name, qty: Math.max(0, r.onHandBaseUnits), unit: r.baseUnit, unitCents, cents });
  }
  const ctx = { items: stock.rows, answers };
  const names = new Map(prepItems(answers).map((p) => [p.key, p.name]));
  for (const p of stock.preps) {
    if (!p.tracked) continue; // no batch made: it has no stock of its own, sales take its raw items
    const { cents, missing } = exactLineCost({ name: p.key, qty: 1, unit: p.unit }, ctx);
    const unitCents = missing.length ? null : cents;
    const qty = Math.max(0, p.onHand);
    if (unitCents === null) noCost += 1;
    out.push({
      id: `semi:${p.key}`, kind: 'semi', name: names.get(p.key) ?? p.key, qty, unit: p.unit, unitCents,
      cents: unitCents === null ? null : Math.round(qty * unitCents),
    });
  }
  const byKind: Record<ValueKind, Cents> = { raw: 0, semi: 0, finished: 0 };
  for (const v of out) byKind[v.kind] += v.cents ?? 0;
  return { items: out, byKind, total: byKind.raw + byKind.semi + byKind.finished, notCounted, noCost };
};

/** The value of the stock as it stood at `at`: the same events, cut there. */
export const valueAt = (items: readonly InventoryItem[], events: readonly SyncEvent[], at: number): Valuation => {
  const upTo = events.filter((e) => e.at <= at);
  return valuationOf(stockFromEvents(items, upTo, { now: at }), answersFromEvents(upTo));
};

const DAY = 24 * 60 * 60 * 1000;
const endOfDay = (t: number): number => { const d = new Date(t); d.setHours(23, 59, 59, 999); return d.getTime(); };

/** The days the trend shows: each day's end, oldest first; today ends now. */
export const trendDays = (now: number, days = 30): number[] =>
  Array.from({ length: days }, (_, i) => (i === days - 1 ? now : endOfDay(now - (days - 1 - i) * DAY)));

/** Below this, a rise in stock value is noise, not money tied up. */
export const RISE_MIN_CENTS: Cents = 500_000; // Rs 5,000
/** Up this share in a week: more is being bought than used. */
export const RISE_SHARE = 0.3;

/**
 * "Stock value up 45% this week": the owner's money is sitting on the shelves. Speaks only
 * when the rise is both large in share and in rupees, and lists what grew most.
 */
export const stockValueRose = (now: Valuation, weekAgo: Valuation): Insight | null => {
  const rise = now.total - weekAgo.total;
  if (weekAgo.total <= 0 || rise < RISE_MIN_CENTS || rise < weekAgo.total * RISE_SHARE) return null;
  const before = new Map(weekAgo.items.map((v) => [v.id, v.cents ?? 0]));
  const grew = now.items
    .map((v) => ({ v, up: (v.cents ?? 0) - (before.get(v.id) ?? 0) }))
    .filter((x) => x.up > 0)
    .sort((a, b) => b.up - a.up)
    .slice(0, 5);
  return {
    id: 'stock-value-rose',
    tone: 'attention',
    title: `Stock value up ${Math.round((rise / weekAgo.total) * 100)}% this week`,
    detail: `Rs ${fmt(now.total)} on the shelves, Rs ${fmt(rise)} more than a week ago. More is coming in than is used: check the next orders on Items.`,
    action: { label: 'What grew', items: grew.map(({ v, up }) => ({ primary: v.name, secondary: `now Rs ${fmt(v.cents ?? 0)}`, amount: up })) },
  };
};

/** The Owner view's card: the stock now against a week ago. */
export const stockValueCard = (events: readonly SyncEvent[], stock: ShopData['stock'], now: number): Insight | null =>
  stock ? stockValueRose(valueAt(stock.items, events, now), valueAt(stock.items, events, now - 7 * DAY)) : null;
