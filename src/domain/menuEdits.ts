import type { Actor } from './auth.ts';
import type { Category, Cents, Combo, MenuItem, SizeId } from './types.ts';
import { CUSTOM_SIZE_IDS, isCustomSection, isCustomSize, PRINTED_SECTIONS, sectionsOf, type SectionSetting, type SectionsState } from './sections.ts';

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
  /** Moved to another section (its sizes and extras go with it; its cook time is the new section's). */
  category?: Category;
}

/**
 * An item the owner added himself. It takes the shape of its section's printed items (a pizza
 * has Medium and Large and the pizza extras; a burger one price and the burger extras; a pasta
 * Single, Medium and Large), so only its name and prices are his to type.
 */
export interface NewItem {
  category: Category;
  name: { en: string; si?: string; ta?: string };
  description: string;
  /** One price per size of its section, or `one` for single-price sections. */
  prices: Partial<Record<SizeId | 'one', Cents>>;
}

/** Added items' ids, so they never meet a printed item's id. */
export const NEW_ITEM_ID = /^new-[a-z0-9-]{1,48}$/;

interface MenuBase { id: string; shopId: string; at: number; orderNumber: 0; actor: Actor; itemId: string }
export type MenuEvent =
  /** Owner only: names, description, prices, hidden, section. `after: {}` = back to the printed menu. */
  | (MenuBase & { type: 'menu.item_set'; before: ItemOverride; after: ItemOverride })
  /** Owners and managers: sold out until `until` (the next morning), or back (`null`). */
  | (MenuBase & { type: 'menu.sold_out'; until: number | null })
  /** Owner only: a new item, or `null` to take back an item just added (Undo). */
  | (MenuBase & { type: 'menu.item_added'; item: NewItem | null })
  /**
   * Managers and the owner (SCRUM-231): a combo pack, made or changed (`after`), or taken off for
   * good (`after: null`). `itemId` is the combo's id (combos.ts COMBO_ID).
   */
  | (MenuBase & { type: 'menu.combo_set'; before: Combo | null; after: Combo | null })
  /**
   * Owners and managers: the item's photo (menuPhotos.ts). A photo id (the picture is kept on the
   * shop server, by its SHA-256), `null` for no photo, or '' for never chosen (Undo of the first one).
   */
  | (MenuBase & { type: 'menu.photo_set'; photo: string | null })
  /**
   * Owner only (SCRUM-241): a section's whole setting (sections.ts), `itemId` = its id. For a
   * printed section `after: null` is back to as printed; for his own, null takes it back (Undo).
   */
  | (MenuBase & { type: 'menu.section_set'; before: SectionSetting | null; after: SectionSetting | null })
  /** Owner only: the sections' order, every id once (`itemId: 'sections'`). */
  | (MenuBase & { type: 'menu.sections_ordered'; before: string[]; after: string[] });

export const MENU_EVENT_TYPES = ['menu.item_set', 'menu.sold_out', 'menu.item_added', 'menu.combo_set', 'menu.photo_set', 'menu.section_set', 'menu.sections_ordered'] as const satisfies readonly MenuEvent['type'][];

export interface MenuState extends SectionsState {
  overrides: Record<string, ItemOverride>;
  /** Item id → sold out until (ms). */
  soldOut: Record<string, number>;
  /**
   * The owner's own items, oldest first. A taken-back item keeps its definition (`removed`),
   * so an order that already has it still prices and prints.
   */
  added: Record<string, NewItem & { removed?: true }>;
  /** Combo packs on offer or hidden, by id (combos.ts). Deleted ones are gone. */
  combos?: Record<string, Combo>;
  /** Item id → the photo the shop chose: a photo id, or null for none. Absent = never chosen. */
  photos?: Record<string, string | null>;
}
export const EMPTY_MENU_STATE: MenuState = { overrides: {}, soldOut: {}, added: {} };

/** Folds menu events (oldest first) into the shop's current changes. Other events are ignored. */
export const menuStateFromEvents = (events: readonly { type: string }[]): MenuState => {
  const overrides: Record<string, ItemOverride> = {};
  const soldOut: Record<string, number> = {};
  const added: MenuState['added'] = {};
  const combos: Record<string, Combo> = {};
  const photos: Record<string, string | null> = {};
  const sections: Record<string, SectionSetting> = {};
  let sectionOrder: string[] | undefined;
  for (const e of events) {
    if (e.type === 'menu.item_set') {
      const m = e as Extract<MenuEvent, { type: 'menu.item_set' }>;
      if (Object.keys(m.after).length) overrides[m.itemId] = m.after;
      else delete overrides[m.itemId];
    } else if (e.type === 'menu.sold_out') {
      const m = e as Extract<MenuEvent, { type: 'menu.sold_out' }>;
      if (m.until) soldOut[m.itemId] = m.until;
      else delete soldOut[m.itemId];
    } else if (e.type === 'menu.item_added') {
      const m = e as Extract<MenuEvent, { type: 'menu.item_added' }>;
      if (m.item) added[m.itemId] = m.item;
      else if (added[m.itemId]) added[m.itemId] = { ...added[m.itemId], removed: true };
    } else if (e.type === 'menu.combo_set') {
      const m = e as Extract<MenuEvent, { type: 'menu.combo_set' }>;
      if (m.after) combos[m.itemId] = m.after;
      else delete combos[m.itemId];
    } else if (e.type === 'menu.photo_set') {
      const m = e as Extract<MenuEvent, { type: 'menu.photo_set' }>;
      if (m.photo === '') delete photos[m.itemId];
      else photos[m.itemId] = m.photo;
    } else if (e.type === 'menu.section_set') {
      const m = e as Extract<MenuEvent, { type: 'menu.section_set' }>;
      if (m.after) sections[m.itemId] = m.after;
      else delete sections[m.itemId];
    } else if (e.type === 'menu.sections_ordered') {
      const m = e as Extract<MenuEvent, { type: 'menu.sections_ordered' }>;
      if (Array.isArray(m.after)) sectionOrder = m.after;
    }
  }
  // Only a shop with combos (or photos) carries them (cheesybeez.com's menu has none yet).
  return {
    overrides, soldOut, added,
    ...(Object.keys(combos).length ? { combos } : {}),
    ...(Object.keys(photos).length ? { photos } : {}),
    ...(Object.keys(sections).length ? { sections } : {}),
    ...(sectionOrder ? { sectionOrder } : {}),
  };
};

const clean = (s: string | undefined) => s?.trim() || undefined;

/** One printed item with the owner's changes applied. */
export const applyOverride = (item: MenuItem, o: ItemOverride | undefined, soldOutUntil: number | undefined, now: number): MenuItem => {
  const soldOut = soldOutUntil !== undefined && soldOutUntil > now;
  if (!o && !soldOut) return item;
  const price = (id: SizeId | 'one', fallback: Cents) => o?.prices?.[id] ?? fallback;
  return {
    ...item,
    ...(o?.category ? { category: o.category } : {}),
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

/**
 * The shape a new item in this section takes: a printed section's first item (its sizes and
 * extras), or the owner's own section's sizes and no extras (SCRUM-241). Undefined: no such section.
 */
const shapeOf = (category: Category, printed: readonly MenuItem[], sections: SectionsState['sections'] = {}): Pick<MenuItem, 'variants' | 'adds'> | undefined => {
  if (isCustomSection(category)) {
    const s = sections?.[category];
    if (!s) return undefined;
    return { ...(s.sizes?.length ? { variants: s.sizes.map((z) => ({ id: z.id, label: z.label.trim(), price: 0 })) } : {}), adds: [] };
  }
  return printed.find((m) => m.category === category);
};

/** The sizes a new item in this section is priced in ('one' for a single price). */
export const newItemSizes = (category: Category, printed: readonly MenuItem[], sections?: SectionsState['sections']): { id: SizeId | 'one'; label: string; hint?: string }[] =>
  shapeOf(category, printed, sections)?.variants?.map((v) => ({ id: v.id, label: v.label, hint: v.hint })) ?? [{ id: 'one', label: 'Price' }];

/**
 * An added item as a menu item, before the owner's later changes. One whose section this menu
 * does not have (recorded by another build, e.g. a "sec-kottu" section with Full/Normal sizes) is
 * kept from its own name and prices, hidden: an order that has it still shows, prices and reaches
 * the kitchen, instead of the Register failing to draw (2026-11-15).
 */
export const newMenuItem = (id: string, n: NewItem & { removed?: true }, printed: readonly MenuItem[], sections?: SectionsState['sections']): MenuItem | null => {
  if (!n || typeof n !== 'object' || typeof n.name?.en !== 'string') return null;
  const shape = shapeOf(n.category, printed, sections);
  if (!shape) {
    const sizes = Object.entries(n.prices ?? {}).filter(([k, v]) => k !== 'one' && Number.isSafeInteger(v)) as [string, Cents][];
    return {
      id, category: n.category, name: n.name, description: typeof n.description === 'string' ? n.description : '', aliases: [],
      // Its own sizes, as recorded: not this menu's S/M/L, so the type is widened on purpose.
      ...(sizes.length
        ? { variants: sizes.map(([k, price]) => ({ id: k as SizeId, label: k.charAt(0).toUpperCase() + k.slice(1), price })) }
        : { price: n.prices?.one ?? 0 }),
      adds: [], leaveOut: [], added: true, hidden: true,
      ...(n.removed ? { removed: true } : {}),
    };
  }
  return {
    id, category: n.category, name: n.name, description: n.description, aliases: [],
    ...(shape.variants
      ? { variants: shape.variants.map((v) => ({ ...v, price: n.prices[v.id] ?? 0 })) }
      : { price: n.prices.one ?? 0 }),
    adds: shape.adds, leaveOut: [], added: true,
    ...(n.removed ? { hidden: true, removed: true } : {}),
  };
};

/**
 * The menu every screen shows: the printed one, then the owner's own items, with the shop's changes.
 * An item in a section he hid or deleted is hidden with it (kept for old orders), and back when the
 * section is; one he moved out first stays on the menu.
 */
export const effectiveMenu = (printed: readonly MenuItem[], state: MenuState, now: number): MenuItem[] => {
  const off = new Set(sectionsOf(state).filter((s) => s.hidden).map((s) => s.id as string));
  return [...printed, ...Object.entries(state.added ?? {}).flatMap(([id, n]) => newMenuItem(id, n, printed, state.sections) ?? [])]
    .map((item) => applyOverride(item, state.overrides[item.id], state.soldOut[item.id], now))
    .map((item) => (off.has(item.category) && !item.hidden ? { ...item, hidden: true } : item));
};

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

const checkName = (name: { en?: string; si?: string; ta?: string }): string | null => {
  if (!isText(name.en, 40) || !isText(name.si, 60) || !isText(name.ta, 60)) return 'a name is too long';
  if (name.en !== undefined && !name.en.trim()) return 'the item needs an English name';
  return null;
};

const checkItemText = (n: NewItem): string | null => {
  if (typeof n.name?.en !== 'string') return 'the item needs an English name';
  const bad = checkName(n.name);
  if (bad) return bad;
  if (typeof n.description !== 'string' || !isText(n.description, 160)) return 'the description is too long';
  return null;
};

/**
 * Is this a new item the shop can take? A price for every size of its section, whole rupees.
 * Without `sections` (the server checks one event at a time and does not know the owner's own
 * sections), an item in one of his sections passes with one price, or prices for sizes x1.. in order.
 */
export const checkNewItem = (n: NewItem, printed: readonly MenuItem[], sections?: SectionsState['sections']): string | null => {
  if (typeof n?.category !== 'string') return 'that is not a menu section';
  if (isCustomSection(n.category) && !sections) {
    const keys = Object.keys(n.prices ?? {});
    const given: string[] = keys.length === 1 && keys[0] === 'one' ? ['one'] : CUSTOM_SIZE_IDS.slice(0, keys.length);
    if (!keys.length || keys.some((k) => k !== 'one' && !isCustomSize(k)) || keys.some((k) => !given.includes(k))) return 'a price is for a size this section does not have';
    return checkItemText(n) ?? (keys.some((k) => !isPrice(n.prices[k as SizeId]) || n.prices[k as SizeId] === 0) ? 'prices are whole rupees, more than 0' : null);
  }
  if (!shapeOf(n.category, printed, sections)) return 'that is not a menu section';
  const bad = checkItemText(n);
  if (bad) return bad;
  const sizes = newItemSizes(n.category, printed, sections).map((s) => s.id);
  if (Object.keys(n.prices ?? {}).some((k) => !sizes.includes(k as SizeId | 'one'))) return 'a price is for a size this section does not have';
  if (sizes.some((s) => !isPrice(n.prices?.[s]) || n.prices[s] === 0)) return 'prices are whole rupees, more than 0';
  return null;
};

/**
 * Is this a change the shop can take? (Prices in whole rupees, names of a sensible length, a section
 * the menu has.) Without `sections` (the server, one event at a time) any section id passes.
 */
export const checkOverride = (item: MenuItem, o: ItemOverride, sections?: readonly { id: string; removed?: boolean }[]): string | null => {
  const badName = o.name ? checkName(o.name) : null;
  if (badName) return badName;
  if (o.category !== undefined) {
    if (typeof o.category !== 'string' || !(PRINTED_SECTIONS.some((p) => p.id === o.category) || isCustomSection(o.category))) return 'that is not a menu section';
    if (sections && !sections.some((s) => s.id === o.category && !s.removed)) return 'that is not a menu section';
  }
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
