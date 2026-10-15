import type { Answer } from './costing.ts';
import { sizesOf } from './costing.ts';
import type { GapReason } from './counting.ts';
import type { BaseUnit } from './inventoryData.ts';
import { formatQuantity } from './quantity.ts';
import { bookUsage } from './stockUsage.ts';
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

export const itemStory = (events: readonly SyncEvent[], itemId: string): ItemStory => {
  const undone = new Set(events.flatMap((e) => (e.type === 'stock.count_undone' ? [e.countId] : [])));
  let lastCount: ItemStory['lastCount'] = null;
  const deliveries: { at: number; packs: number; by: string }[] = [];
  const prices: { at: number; before: Cents; after: Cents }[] = [];
  for (const e of events) {
    if (!('itemId' in e) || e.itemId !== itemId) continue;
    if (e.type === 'stock.counted' && !undone.has(e.id)) {
      lastCount = { at: e.at, by: e.actor.name, delta: e.counted - Math.max(0, e.expected), reason: e.reason, first: lastCount === null, photo: e.photo ?? null };
    } else if (e.type === 'stock.adjusted' && e.reason === 'receive') {
      // An Undo of a delivery is the same packs taken back: it cancels that delivery.
      if (e.deltaPacks > 0) deliveries.push({ at: e.at, packs: e.deltaPacks, by: e.actor.name });
      else {
        for (let i = deliveries.length - 1; i >= 0; i--) {
          if (deliveries[i].packs === -e.deltaPacks) { deliveries.splice(i, 1); break; }
        }
      }
    } else if (e.type === 'stock.price_set' && e.before !== e.after) {
      // Likewise an Undo of a price change puts the old price back: drop both.
      const last = prices.at(-1);
      if (last && last.before === e.after && last.after === e.before) prices.pop();
      else prices.push({ at: e.at, before: e.before, after: e.after });
    }
  }
  return { lastCount, lastDelivery: deliveries.at(-1) ?? null, lastPrice: prices.at(-1) ?? null };
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
