import { leaveOutsOf } from './halves.ts';
import { unitPrice } from './money.ts';
import type { Cents, Combo, ComboSlot, LineSpec, MenuItem, OrderLine } from './types.ts';

/**
 * Combo packs (SCRUM-231): a combo is a box with slots. A slot is one dish, or a choice the
 * customer makes, with the usual pick that one tap on the Register gives, and what each other
 * pick costs on top (0 = in the price). Managers and the owner make them (`menu.combo_set`).
 *
 * Selling one puts each dish in the order as an ordinary line (always qty 1) carrying its
 * BoxMark, so the kitchen, stock, waste, manager changes and every report of sales already work:
 * they see dishes. The box price is split over its dishes in proportion to their own menu
 * prices, in whole rupees, so the shares add up to the combo price exactly.
 *
 * Pure: menus are passed in. The screens pass the shop's current menu (menu.ts).
 */

export const COMBO_ID = /^combo-[a-z0-9-]{1,48}$/;
export const MAX_SLOTS = 8;
export const MAX_SLOT_QTY = 6;
export const MAX_OPTIONS = 24;
const MAX_PRICE: Cents = 10_000_000; // Rs 100,000

const isRupees = (v: unknown): v is Cents =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_PRICE && (v as number) % 100 === 0;

/** A dish's own price at a slot's size, nothing added: what it costs bought alone. */
export const alonePrice = (item: MenuItem, slot: Pick<ComboSlot, 'size'>): Cents =>
  unitPrice(item, { size: slot.size, adds: [] });

const find = (items: readonly MenuItem[], id: string) => items.find((m) => m.id === id);

/** The picks a slot can be filled with now: on the menu, not hidden, not sold out; the usual first. */
export const pickable = (slot: ComboSlot, items: readonly MenuItem[]): MenuItem[] => {
  const ids = [slot.usual, ...Object.keys(slot.options).filter((id) => id !== slot.usual)];
  return ids.flatMap((id) => {
    const m = find(items, id);
    return m && !m.hidden && !m.soldOut && slot.options[id] !== undefined ? [m] : [];
  });
};

/** What one tap gives: the usual pick, or (sold out) the first pick in the price, or any pick left. */
export const usualPick = (slot: ComboSlot, items: readonly MenuItem[]): MenuItem | null => {
  const can = pickable(slot, items);
  return can[0]?.id === slot.usual ? can[0] : can.find((m) => slot.options[m.id] === 0) ?? can[0] ?? null;
};

/** Why a combo cannot be sold now (a slot with nothing left to pick), or null when it can. */
export const comboBlocked = (combo: Combo, items: readonly MenuItem[]): string | null => {
  if (combo.hidden) return 'hidden';
  for (const slot of combo.slots) {
    if (!usualPick(slot, items)) {
      const name = find(items, slot.usual)?.name.en ?? 'A dish';
      return `${name} sold out`;
    }
  }
  return null;
};

/** The usual box bought dish by dish: what the combo saves is this less its price. */
export const separatePrice = (combo: Combo, items: readonly MenuItem[]): Cents =>
  combo.slots.reduce((sum, slot) => {
    const m = find(items, slot.usual);
    return sum + (m ? alonePrice(m, slot) * slot.qty : 0);
  }, 0);

/**
 * Splits `total` over the weights in whole cents, in proportion, adding up to `total` exactly:
 * each share is rounded down, then the cents left go one each to the first shares. With no
 * weights (all 0), equal shares.
 */
export const allocate = (total: Cents, weights: readonly Cents[]): Cents[] => {
  if (!weights.length) return [];
  const w = weights.some((x) => x > 0) ? weights : weights.map(() => 1);
  const sum = w.reduce((a, b) => a + b, 0);
  const shares = w.map((x) => Math.floor((total * x) / sum));
  let left = total - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0; i = (i + 1) % shares.length, left--) shares[i]++;
  return shares;
};

let seq = 0;
const newBoxId = (): string => globalThis.crypto?.randomUUID?.() ?? `box-${Date.now()}-${seq++}`;

/**
 * The box as order lines, one per dish, with the usual picks (or `picks`: item id per slot, from
 * typed shorthand, when the slot offers it). Null when the combo cannot be sold now.
 */
export const boxLines = (
  comboId: string, combo: Combo, items: readonly MenuItem[], opts: { boxId?: string; picks?: Record<number, string> } = {},
): LineSpec[] | null => {
  if (comboBlocked(combo, items)) return null;
  const id = opts.boxId ?? newBoxId();
  const dishes = combo.slots.flatMap((slot, i) => {
    const wanted = opts.picks?.[i];
    const can = pickable(slot, items);
    const pick = (wanted && can.find((m) => m.id === wanted)) || usualPick(slot, items)!;
    const usual = find(items, slot.usual) ?? pick;
    return Array.from({ length: slot.qty }, () => ({ slot, i, pick, usualAlone: alonePrice(usual, slot) }));
  });
  // Shares follow the usual picks' prices, so a different pick never moves money between dishes;
  // in whole rupees, like the combo price, so no report shows a dish at Rs 1,842.12.
  const shares = allocate(combo.price / 100, dishes.map((d) => d.usualAlone)).map((r) => r * 100);
  return dishes.map(({ slot, i, pick }, n) => ({
    itemId: pick.id, qty: 1, ...(slot.size ? { size: slot.size } : {}), adds: [], outs: [],
    box: { id, comboId, name: combo.name.en, slot: i, share: shares[n], extra: slot.options[pick.id] ?? 0, alone: alonePrice(pick, slot) },
  }));
};

/** One dish of a box changed to another pick of its slot: extras and leave-outs it lacks drop off. */
export const swapPick = <L extends LineSpec>(line: L, pick: MenuItem, combo: Combo): L => {
  const box = line.box!;
  const slot = combo.slots[box.slot];
  const outs = leaveOutsOf(pick, null).map((o) => o.id);
  return {
    ...line,
    itemId: pick.id,
    adds: line.adds.filter((id) => pick.adds.some((o) => o.id === id)),
    outs: line.outs.filter((id) => outs.includes(id)),
    box: { ...box, extra: slot?.options[pick.id] ?? 0, alone: alonePrice(pick, { size: line.size }) },
  };
};

export interface BoxView {
  id: string;
  name: string;
  comboId: string;
  /** The lines in the box, in order. */
  lines: OrderLine[];
  /** The box price: the dishes' shares. */
  price: Cents;
  /** What the same dishes cost bought alone, less the box price (never below 0). */
  saved: Cents;
}

/** The boxes in an order's lines, by box id, in the order they appear. */
export const boxesIn = (lines: readonly OrderLine[]): Map<string, BoxView> => {
  const out = new Map<string, BoxView>();
  for (const l of lines) {
    if (!l.box) continue;
    const b = out.get(l.box.id) ?? { id: l.box.id, name: l.box.name, comboId: l.box.comboId, lines: [], price: 0, saved: 0 };
    b.lines.push(l);
    b.price += l.box.share;
    out.set(l.box.id, b);
  }
  for (const b of out.values()) {
    const alone = b.lines.reduce((s, l) => s + l.box!.alone - l.box!.extra, 0);
    b.saved = Math.max(0, alone - b.price);
  }
  return out;
};

/** Is a line the first dish of its box (where the box's heading goes)? */
export const opensBox = (lines: readonly Pick<OrderLine, 'box'>[], i: number): boolean =>
  Boolean(lines[i].box) && lines.findIndex((l) => l.box?.id === lines[i].box!.id) === i;

/** "combo-family-box", or "combo-family-box-2" if that id was ever used. */
export const comboIdFor = (en: string, taken: ReadonlySet<string>): string => {
  const slug = en.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'box';
  let id = `combo-${slug}`;
  for (let n = 2; taken.has(id); n++) id = `combo-${slug}-${n}`;
  return id;
};

/**
 * Is this a combo the shop can sell? Names of a sensible length, a price in whole rupees above 0,
 * 1-8 slots of 1-6 dishes, picks that are menu dishes in the slot's size, extras in whole rupees,
 * and a usual pick in the price. `known`: dishes the checker cannot see (the server's view of the
 * owner's own dishes) pass on their id alone.
 */
export const checkCombo = (c: Combo, items: readonly MenuItem[], known: (id: string) => boolean = () => false): string | null => {
  if (typeof c !== 'object' || c === null) return 'not a combo';
  if (typeof c.name?.en !== 'string' || !c.name.en.trim()) return 'the combo needs a name';
  if (c.name.en.length > 40 || (c.name.si ?? '').length > 60 || (c.name.ta ?? '').length > 60) return 'the name is too long';
  if (!isRupees(c.price) || c.price === 0) return 'the price is whole rupees, more than 0';
  if (c.hidden !== undefined && typeof c.hidden !== 'boolean') return 'hidden is yes or no';
  if (!Array.isArray(c.slots) || !c.slots.length) return 'put at least one dish in the box';
  if (c.slots.length > MAX_SLOTS) return `a box holds at most ${MAX_SLOTS} slots`;
  for (const s of c.slots) {
    if (!Number.isSafeInteger(s.qty) || s.qty < 1 || s.qty > MAX_SLOT_QTY) return `a slot holds 1 to ${MAX_SLOT_QTY} dishes`;
    const ids = Object.keys(s.options ?? {});
    if (!ids.length || ids.length > MAX_OPTIONS) return 'a slot needs 1 to 24 dishes to pick from';
    if (!ids.includes(s.usual)) return 'the usual pick must be one of the slot\'s dishes';
    if (s.options[s.usual] !== 0) return 'the usual pick is always in the price';
    for (const id of ids) {
      if (!isRupees(s.options[id])) return 'extras are whole rupees';
      const m = find(items, id);
      if (!m) { if (known(id)) continue; return 'a pick is not on the menu'; }
      if (m.variants ? !m.variants.some((v) => v.id === s.size) : s.size !== undefined) return `${m.name.en} has no such size`;
    }
  }
  return null;
};

/**
 * The food cost of the usual box, from the owner's recipes (`cost`: one dish in one size, as
 * costing.ts menuCost gives it). `complete`: every dish fully priced, so "the shop keeps" is true.
 */
export const boxFoodCost = (
  combo: Combo, cost: (itemId: string, size: string) => { cents: Cents; complete: boolean },
): { cents: Cents; complete: boolean } =>
  combo.slots.reduce<{ cents: Cents; complete: boolean }>((acc, s) => {
    const c = cost(s.usual, s.size ?? '');
    return { cents: acc.cents + c.cents * s.qty, complete: acc.complete && c.complete };
  }, { cents: 0, complete: true });
