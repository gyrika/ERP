import type { Answer } from './costing.ts';
import { sizesOf } from './costing.ts';
import type { GapReason } from './counting.ts';
import type { BaseUnit } from './inventoryData.ts';
import { formatQuantity } from './quantity.ts';
import { bookUsage } from './stockUsage.ts';
import { gapCases, type Review } from './gapReview.ts';
import type { SyncEvent } from './sync.ts';
import type { Cents, MenuItem, SizeId } from './types.ts';

/**
 * One item's story (SCRUM-93), so its sheet never feels like something is missing:
 * when it was last counted and how that went, the last delivery, the last price
 * change, and which menu items use it. All from events the shop already records.
 */
export interface ItemStory {
  /** first: it set the starting amount, so there was nothing to compare. */
  lastCount: { at: number; by: string; delta: number; reason: GapReason | null; first: boolean; photo: string | null } | null;
  lastDelivery: { at: number; packs: number; by: string } | null;
  lastPrice: { at: number; before: Cents; after: Cents } | null;
}

/** One line of an item's history (SCRUM-97): a count, a delivery or a price change. */
export type HistoryEntry =
  | { kind: 'count'; at: number; by: string; counted: number; expected: number; delta: number; valueCents: Cents;
      reason: GapReason | null; photo: string | null; first: boolean; review: Review | null }
  | { kind: 'delivery'; at: number; by: string; packs: number; grnId?: string }
  | { kind: 'price'; at: number; by: string; before: Cents; after: Cents };

/**
 * Everything that happened to one item's stock, newest first. Undone counts are left
 * out, and a delivery or price change taken back with Undo cancels its pair.
 */
export const itemHistory = (events: readonly SyncEvent[], itemId: string, packQty = 0): HistoryEntry[] => {
  const undone = new Set(events.flatMap((e) => (e.type === 'stock.count_undone' ? [e.countId] : [])));
  const reviews = new Map(gapCases(events).filter((c) => c.itemId === itemId).map((c) => [c.countId, c.review]));
  const out: HistoryEntry[] = [];
  let counted = false;
  for (const e of events) {
    // A GRN is a delivery of every item it accepted; its undo takes that delivery off the list.
    if (e.type === 'stock.grn') {
      const accepted = e.lines.filter((l) => l.itemId === itemId).reduce((n, l) => n + (l.accepted ?? 0), 0);
      if (accepted > 0) out.push({ kind: 'delivery', at: e.at, by: e.actor.name, packs: accepted, grnId: e.id });
      continue;
    }
    if (e.type === 'stock.grn_undone') {
      const i = out.findIndex((d) => d.kind === 'delivery' && d.grnId === e.grnId);
      if (i >= 0) out.splice(i, 1);
      continue;
    }
    if (!('itemId' in e) || e.itemId !== itemId) continue;
    if (e.type === 'stock.counted' && !undone.has(e.id)) {
      out.push({
        kind: 'count', at: e.at, by: e.actor.name, counted: e.counted, expected: e.expected, delta: e.counted - Math.max(0, e.expected),
        // First: it set the starting amount (nothing known to compare); a gap with a reason is never that.
        valueCents: e.valueCents, reason: e.reason, photo: e.photo ?? null, first: !counted && e.reason === null, review: reviews.get(e.id) ?? null,
      });
      counted = true;
    } else if ((e.type === 'stock.adjusted' && e.reason === 'receive') || (e.type === 'stock.movement' && (e.kind === 'GRN' || e.kind === 'GRN_UNDO') && packQty > 0)) {
      // Older deliveries are adjustments in packs; newer ones are GRN movements in base units.
      const packs = e.type === 'stock.adjusted' ? e.deltaPacks : e.qtyBase / packQty;
      // An Undo of a delivery is the same packs taken back: it cancels that delivery.
      if (packs > 0) out.push({ kind: 'delivery', at: e.at, by: e.actor.name, packs });
      else {
        for (let i = out.length - 1; i >= 0; i--) {
          const d = out[i];
          if (d.kind === 'delivery' && Math.abs(d.packs + packs) < 1e-9) { out.splice(i, 1); break; }
        }
      }
    } else if (e.type === 'stock.price_set' && e.before !== e.after) {
      // Likewise an Undo of a price change puts the old price back: drop both.
      let last = -1;
      for (let i = out.length - 1; i >= 0; i--) if (out[i].kind === 'price') { last = i; break; }
      const p = last >= 0 ? out[last] : null;
      if (p && p.kind === 'price' && p.before === e.after && p.after === e.before) out.splice(last, 1);
      else out.push({ kind: 'price', at: e.at, by: e.actor.name, before: e.before, after: e.after });
    }
  }
  return out.reverse();
};

export const itemStory = (events: readonly SyncEvent[], itemId: string, packQty = 0): ItemStory => {
  const history = itemHistory(events, itemId, packQty);
  const count = history.find((h) => h.kind === 'count');
  const delivery = history.find((h) => h.kind === 'delivery');
  const price = history.find((h) => h.kind === 'price');
  return {
    lastCount: count && count.kind === 'count'
      ? { at: count.at, by: count.by, delta: count.delta, reason: count.reason, first: count.first, photo: count.photo }
      : null,
    lastDelivery: delivery && delivery.kind === 'delivery' ? { at: delivery.at, packs: delivery.packs, by: delivery.by } : null,
    lastPrice: price && price.kind === 'price' ? { at: price.at, before: price.before, after: price.after } : null,
  };
};

/** The menu items whose recipe (any size) takes from this price-list item, by name. */
export const usedIn = (menu: readonly MenuItem[], answers: ReadonlyMap<string, Answer>, inventoryId: string): string[] =>
  menu.filter((m) => sizesOf(m).some((size) =>
    bookUsage({ itemId: m.id, qty: 1, size: (size || undefined) as SizeId | undefined, adds: [], outs: [] }, answers)
      .some((u) => u.inventoryId === inventoryId)))
    .map((m) => m.name.en);

const QUARTERS = ['', '¼', '½', '¾'];

/**
 * What is on the shelf, packs first: "1½ packs · 3 kg", "1 pack · 25 kg", "Empty".
 * Rounded to the quarter pack, the way people see a shelf; a crumb is "under ¼ pack".
 */
export const formatStock = (baseUnits: number, item: { packQty: number; baseUnit: BaseUnit }): string => {
  const base = Math.max(0, baseUnits);
  if (base === 0) return 'Empty';
  const amount = formatQuantity(base, item.baseUnit);
  if (item.packQty <= 0) return amount;
  const quarters = Math.round((base / item.packQty) * 4);
  if (quarters === 0) return `under ¼ pack · ${amount}`;
  const whole = Math.floor(quarters / 4);
  const packs = `${whole || ''}${QUARTERS[quarters % 4]}` || '0';
  return `${packs} ${quarters <= 4 ? 'pack' : 'packs'} · ${amount}`;
};

const DAY = 24 * 60 * 60 * 1000;
const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "today", "yesterday", "3 days ago", "on 2 Sep" (a month or more back). */
export const daysAgo = (at: number, now: number): string => {
  const n = Math.round((dayStart(now) - dayStart(at)) / DAY);
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 30) return `${n} days ago`;
  return `on ${new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
};
