import type { Actor } from './auth.ts';

/**
 * Value addition (Visual Flow's Financial view): the places where a dish gains its cost, as the
 * owner names them. A place has no type, kitchen or register: it is only a name, for him to see
 * where the money goes in. Each ingredient and cost belongs to one place, in every dish. Picture
 * only: stock, recipes and costs do not read this. Pure: events in, the column out.
 */
export interface PlaceInfo { name: string; archived: boolean }
export interface ValuePlace extends PlaceInfo { id: string }
export interface ValuePlaces {
  /** In the order they were added, the order they run along the column. */
  list: ValuePlace[];
  /** Each card's chosen place; missing: the first place. */
  of: ReadonlyMap<string, string>;
}

interface ValueBase { id: string; shopId: string; at: number; orderNumber: 0; actor: Actor }
export type ValueEvent =
  /** A place added (before null), renamed or removed; its Undo writes `before` back (after null: never added). */
  | (ValueBase & { type: 'value.place_set'; placeId: string; before: PlaceInfo | null; after: PlaceInfo | null })
  /** A card put in a place; placeId null: back to the first place. */
  | (ValueBase & { type: 'value.card_set'; nodeId: string; placeId: string | null });

export const VALUE_EVENT_TYPES = ['value.place_set', 'value.card_set'] as const satisfies readonly ValueEvent['type'][];

export const isPlaceId = (id: unknown): id is string => typeof id === 'string' && /^va-[A-Za-z0-9-]{1,40}$/.test(id);
export const isPlaceCard = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128 && /^(stock|free|ingredient|res):/.test(id);
export const checkPlaceName = (name: unknown): string | null => {
  if (typeof name !== 'string' || !name.trim()) return 'Type a name.';
  return name.trim().length > 40 ? 'Keep the name to 40 characters.' : null;
};
const validInfo = (v: unknown): boolean => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const i = v as Record<string, unknown>;
  return checkPlaceName(i.name) === null && typeof i.archived === 'boolean' && Object.keys(i).length === 2;
};
/** Null when the event is well formed (the server checks the same). */
export const checkValueEvent = (e: { type: string; [k: string]: unknown }): string | null => {
  if (e.orderNumber !== 0) return 'not about an order';
  if (e.type === 'value.place_set') {
    if (!isPlaceId(e.placeId) || !(e.before === null || validInfo(e.before)) || !(e.after === null || validInfo(e.after))) return 'an invalid place';
    return null;
  }
  return isPlaceCard(e.nodeId) && (e.placeId === null || isPlaceId(e.placeId)) ? null : 'an invalid card';
};

export const valuePlacesFromEvents = (events: readonly { type: string }[]): ValuePlaces => {
  const places = new Map<string, PlaceInfo>();
  const of = new Map<string, string>();
  for (const raw of events) {
    if (!raw.type.startsWith('value.')) continue;
    const e = raw as ValueEvent;
    if (e.type === 'value.place_set') {
      if (e.after) places.set(e.placeId, e.after); else places.delete(e.placeId);
    } else if (e.placeId) of.set(e.nodeId, e.placeId);
    else of.delete(e.nodeId);
  }
  return { list: [...places].map(([id, p]) => ({ id, ...p })), of };
};

export const activePlaces = (v: ValuePlaces): ValuePlace[] => v.list.filter((p) => !p.archived);

/** The place a card is in: its choice, or the first place when it has none or that place is gone. */
export const placeOfCard = (v: ValuePlaces, nodeId: string): string | null => {
  const active = activePlaces(v);
  const chosen = v.of.get(nodeId);
  return active.find((p) => p.id === chosen)?.id ?? active[0]?.id ?? null;
};

/** "Place 3", or the next free number: a new place's name until the owner types his own. */
export const nextPlaceName = (v: ValuePlaces): string => {
  const taken = new Set(activePlaces(v).map((p) => p.name.trim().toLowerCase()));
  let n = v.list.length + 1;
  while (taken.has(`place ${n}`)) n += 1;
  return `Place ${n}`;
};

/** A card on the drawing that carries money of its own: a raw item or a cost. Its cents count once. */
export interface PlaceItem { id: string; cents: number; y: number }
export interface PlaceCard {
  id: string; name: string;
  /** Its number: the key that puts a picked card there. */
  index: number;
  /** What goes in here, and everything up to and including here, in unrounded cents. */
  adds: number; soFar: number;
  /** Its part of the whole cost (0..1). */
  share: number;
  y: number;
}
export interface ValueColumn {
  cards: PlaceCard[];
  /** Each item's new height: stacked by place, as the Warehouse view stacks by warehouse. */
  itemY: Map<string, number>;
  links: { id: string; placeId: string; itemId: string }[];
  /** The column's title, and "+ Place" under the last one. */
  headY: number;
  addY: number;
}

const GAP = 0.5;

export const valueColumn = (v: ValuePlaces, items: readonly PlaceItem[], rowH: number): ValueColumn => {
  const total = items.reduce((s, i) => s + i.cents, 0);
  const itemY = new Map<string, number>();
  const cards: PlaceCard[] = [];
  const links: ValueColumn['links'] = [];
  let cursor = 0;
  let soFar = 0;
  activePlaces(v).forEach((p, index) => {
    const mine = items.filter((i) => placeOfCard(v, i.id) === p.id).sort((a, b) => a.y - b.y);
    mine.forEach((i, k) => {
      itemY.set(i.id, cursor + k * rowH);
      links.push({ id: `va>${p.id}>${i.id}`, placeId: p.id, itemId: i.id });
    });
    const adds = mine.reduce((s, i) => s + i.cents, 0);
    soFar += adds;
    const rows = Math.max(1, mine.length);
    cards.push({ id: p.id, name: p.name, index, adds, soFar, share: total > 0 ? adds / total : 0, y: cursor + ((rows - 1) * rowH) / 2 });
    cursor += rows * rowH + GAP * rowH;
  });
  // Centred on the drawing, like every other column.
  const shift = cards.length ? -(cursor - GAP * rowH - rowH) / 2 : 0;
  for (const c of cards) c.y += shift;
  for (const [id, y] of itemY) itemY.set(id, y + shift);
  // The title sits just above the first place, not above its whole block of cards.
  return { cards, itemY, links, headY: (cards[0]?.y ?? 0) - 40, addY: cards.length ? cursor + shift : 40 };
};
