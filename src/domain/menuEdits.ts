import type { Actor } from './auth.ts';
import type { Cents, MenuItem, SizeId } from './types.ts';

export interface ItemOverride {
  name?: { en?: string; si?: string; ta?: string };
  description?: string;
  prices?: Partial<Record<SizeId | 'one', Cents>>;
  adds?: Record<string, Cents>;
  hidden?: boolean;
}

interface MenuBase { id: string; shopId: string; at: number; orderNumber: 0; actor: Actor; itemId: string }
export type MenuEvent =
  | (MenuBase & { type: 'menu.item_set'; before: ItemOverride; after: ItemOverride })
  | (MenuBase & { type: 'menu.sold_out'; until: number | null });

export const MENU_EVENT_TYPES = ['menu.item_set', 'menu.sold_out'] as const satisfies readonly MenuEvent['type'][];

export interface MenuState {
  overrides: Record<string, ItemOverride>;
  soldOut: Record<string, number>;
}
export const EMPTY_MENU_STATE: MenuState = { overrides: {}, soldOut: {} };

export const menuStateFromEvents = (events: readonly { type: string }[]): MenuState => {
  const overrides: Record<string, ItemOverride> = {};
  const soldOut: Record<string, number> = {};
  for (const event of events) {
    if (event.type === 'menu.item_set') {
      const menuEvent = event as Extract<MenuEvent, { type: 'menu.item_set' }>;
      if (Object.keys(menuEvent.after).length) overrides[menuEvent.itemId] = menuEvent.after;
      else delete overrides[menuEvent.itemId];
    } else if (event.type === 'menu.sold_out') {
      const menuEvent = event as Extract<MenuEvent, { type: 'menu.sold_out' }>;
      if (menuEvent.until) soldOut[menuEvent.itemId] = menuEvent.until;
      else delete soldOut[menuEvent.itemId];
    }
  }
  return { overrides, soldOut };
};

const clean = (text: string | undefined) => text?.trim() || undefined;

export const applyOverride = (
  item: MenuItem,
  override: ItemOverride | undefined,
  soldOutUntil: number | undefined,
  now: number,
): MenuItem => {
  const soldOut = soldOutUntil !== undefined && soldOutUntil > now;
  if (!override && !soldOut) return item;
  const price = (id: SizeId | 'one', fallback: Cents) => override?.prices?.[id] ?? fallback;
  const si = override?.name?.si === undefined ? item.name.si : clean(override.name.si);
  const ta = override?.name?.ta === undefined ? item.name.ta : clean(override.name.ta);
  return {
    ...item,
    name: {
      en: clean(override?.name?.en) ?? item.name.en,
      ...(si ? { si } : {}),
      ...(ta ? { ta } : {}),
    },
    description: clean(override?.description) ?? item.description,
    ...(item.variants ? { variants: item.variants.map((variant) => ({ ...variant, price: price(variant.id, variant.price) })) } : {}),
    ...(item.price !== undefined ? { price: price('one', item.price) } : {}),
    adds: item.adds.map((add) => ({ ...add, price: override?.adds?.[add.id] ?? add.price })),
    ...(override?.hidden ? { hidden: true } : {}),
    ...(soldOut ? { soldOut: true } : {}),
    ...(override ? { edited: true } : {}),
  };
};

export const effectiveMenu = (base: readonly MenuItem[], state: MenuState, now: number): MenuItem[] =>
  base.map((item) => applyOverride(item, state.overrides[item.id], state.soldOut[item.id], now));

export const nextMorning = (now: number): number => {
  const date = new Date(now);
  date.setHours(6, 0, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
};

const MAX_PRICE: Cents = 10_000_000;
const isPrice = (value: unknown): value is Cents =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_PRICE && (value as number) % 100 === 0;
const isText = (value: unknown, max: number) => value === undefined || (typeof value === 'string' && value.length <= max);

export const checkOverride = (item: MenuItem, override: ItemOverride): string | null => {
  if (override.name && (!isText(override.name.en, 40) || !isText(override.name.si, 60) || !isText(override.name.ta, 60))) return 'a name is too long';
  if (override.name?.en !== undefined && !override.name.en.trim()) return 'the item needs an English name';
  if (!isText(override.description, 160)) return 'the description is too long';
  for (const [key, value] of Object.entries(override.prices ?? {})) {
    const known = key === 'one' ? item.price !== undefined : item.variants?.some((variant) => variant.id === key);
    if (!known) return `${item.name.en} has no ${key} size`;
    if (!isPrice(value) || value === 0) return 'prices are whole rupees, more than 0';
  }
  for (const [key, value] of Object.entries(override.adds ?? {})) {
    if (!item.adds.some((add) => add.id === key)) return 'that extra is not on this item';
    if (!isPrice(value)) return 'prices are whole rupees';
  }
  return null;
};
