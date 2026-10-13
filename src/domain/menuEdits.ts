import type { Actor } from './auth.ts';
import type { Cents, MenuItem, SizeId } from './types.ts';

/**
 * The owner's own menu changes, on top of the printed menu (menu.ts stays the starting point,
 * so "Back to the printed menu" is always one tap). Each change is an event like a sale:
 * who, when, before and after, so it reaches every screen, the cloud and online ordering,
 * is audited, and can be undone.
 *
 * An override is the whole difference for one item; the newest event for an item wins.
 */
export interface ItemOverride {
  name?: { en?: string; si?: string; ta?: string };
  description?: string;
  /** Price per size, or `one` for single-price items. */
  prices?: Partial<Record<SizeId | 'one', Cents>>;
  /** Extras' prices, by option id. */
  adds?: Record<string, Cents>;
  hidden?: boolean;
}

interface MenuBase { id: string; shopId: string; at: number; orderNumber: 0; actor: Actor; itemId: string }
export type MenuEvent =
  /** Owner only: names, description, prices, hidden. `after: {}` = back to the printed menu. */
  | (MenuBase & { type: 'menu.item_set'; before: ItemOverride; after: ItemOverride })
  /** Owners and managers: sold out until `until` (the next morning), or back (`null`). */
  | (MenuBase & { type: 'menu.sold_out'; until: number | null });

export const MENU_EVENT_TYPES = ['menu.item_set', 'menu.sold_out'] as const satisfies readonly MenuEvent['type'][];

export interface MenuState {
  overrides: Record<string, ItemOverride>;
  /** Item id → sold out until (ms). */
  soldOut: Record<string, number>;
}
export const EMPTY_MENU_STATE: MenuState = { overrides: {}, soldOut: {} };

/** Folds menu events (oldest first) into the shop's current changes. Other events are ignored. */
export const menuStateFromEvents = (events: readonly { type: string }[]): MenuState => {
  const overrides: Record<string, ItemOverride> = {};
  const soldOut: Record<string, number> = {};
  for (const e of events) {
    if (e.type === 'menu.item_set') {
      const m = e as Extract<MenuEvent, { type: 'menu.item_set' }>;
      if (Object.keys(m.after).length) overrides[m.itemId] = m.after;
      else delete overrides[m.itemId];
    } else if (e.type === 'menu.sold_out') {
      const m = e as Extract<MenuEvent, { type: 'menu.sold_out' }>;
      if (m.until) soldOut[m.itemId] = m.until;
      else delete soldOut[m.itemId];
    }
  }
  return { overrides, soldOut };
};

const clean = (s: string | undefined) => s?.trim() || undefined;

/** One printed item with the owner's changes applied. */
export const applyOverride = (item: MenuItem, o: ItemOverride | undefined, soldOutUntil: number | undefined, now: number): MenuItem => {
  const soldOut = soldOutUntil !== undefined && soldOutUntil > now;
  if (!o && !soldOut) return item;
  const price = (id: SizeId | 'one', fallback: Cents) => o?.prices?.[id] ?? fallback;
  return {
    ...item,
    name: {
      en: clean(o?.name?.en) ?? item.name.en,
      ...(clean(o?.name?.si) ?? item.name.si ? { si: clean(o?.name?.si) ?? item.name.si } : {}),
      ...(clean(o?.name?.ta) ?? item.name.ta ? { ta: clean(o?.name?.ta) ?? item.name.ta } : {}),
    },
    description: clean(o?.description) ?? item.description,
    ...(item.variants ? { variants: item.variants.map((v) => ({ ...v, price: price(v.id, v.price) })) } : {}),
    ...(item.price !== undefined ? { price: price('one', item.price) } : {}),
    adds: item.adds.map((a) => ({ ...a, price: o?.adds?.[a.id] ?? a.price })),
    ...(o?.hidden ? { hidden: true } : {}),
    ...(soldOut ? { soldOut: true } : {}),
    ...(o ? { edited: true } : {}),
  };
};

/** The menu every screen shows: the printed one with the shop's changes. */
export const effectiveMenu = (base: readonly MenuItem[], state: MenuState, now: number): MenuItem[] =>
  base.map((item) => applyOverride(item, state.overrides[item.id], state.soldOut[item.id], now));

/** Sold out "for today" ends the next morning at 6, so it never needs remembering to undo. */
export const nextMorning = (now: number): number => {
  const d = new Date(now);
  d.setHours(6, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
};

const MAX_PRICE: Cents = 10_000_000; // Rs 100,000
const isPrice = (v: unknown): v is Cents => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_PRICE && (v as number) % 100 === 0;
const isText = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max);

/** Is this a change the shop can take? (Prices in whole rupees, names of a sensible length.) */
export const checkOverride = (item: MenuItem, o: ItemOverride): string | null => {
  if (o.name && (!isText(o.name.en, 40) || !isText(o.name.si, 60) || !isText(o.name.ta, 60))) return 'a name is too long';
  if (o.name?.en !== undefined && !o.name.en.trim()) return 'the item needs an English name';
  if (!isText(o.description, 160)) return 'the description is too long';
  for (const [k, v] of Object.entries(o.prices ?? {})) {
    const known = k === 'one' ? item.price !== undefined : item.variants?.some((x) => x.id === k);
    if (!known) return `${item.name.en} has no ${k} size`;
    if (!isPrice(v) || v === 0) return 'prices are whole rupees, more than 0';
  }
  for (const [k, v] of Object.entries(o.adds ?? {})) {
    if (!item.adds.some((a) => a.id === k)) return 'that extra is not on this item';
    if (!isPrice(v)) return 'prices are whole rupees';
  }
  return null;
};
