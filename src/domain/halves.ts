import { itemById } from './menu.ts';
import type { Cents, MenuItem, Option, OrderLine } from './types.ts';

/**
 * Half-and-half pizzas (the owner, October 2026: "Yes, half-and-half pizzas are
 * offered. Half price for each half."). One line, one pizza: `itemId` is the
 * first half, `half` the second, both in the line's size. The base price is half
 * of each half's price, rounded once to the cent; extras are priced as on any
 * pizza, once for the whole pizza. Leave-outs cover the whole pizza and come from
 * both halves. In stock, each half takes half of its own recipe.
 */
export const HALVES_CATEGORY = 'pizza';

/** Can these two items be the halves of one pizza? */
export const canHalve = (a: MenuItem, b: MenuItem): boolean =>
  a.id !== b.id && a.category === HALVES_CATEGORY && b.category === HALVES_CATEGORY;

/** The second half of a line, or null for a whole item. */
export const secondHalf = (l: Pick<OrderLine, 'half'>): MenuItem | null => (l.half ? itemById(l.half) : null);

const sizePrice = (item: MenuItem, size: string | undefined): Cents =>
  item.variants ? (item.variants.find((v) => v.id === size) ?? item.variants[0]).price : (item.price ?? 0);

/** The base price of a line's size: half of each half's price, rounded once (half up). */
export const basePrice = (item: MenuItem, line: Pick<OrderLine, 'size' | 'half'>, other: MenuItem | null = secondHalf(line)): Cents =>
  other ? Math.floor((sizePrice(item, line.size) + sizePrice(other, line.size) + 1) / 2) : sizePrice(item, line.size);

/** "½ Devilled Chicken + ½ BBQ Chicken", or the item's own name. */
export const lineItemName = (l: Pick<OrderLine, 'itemId' | 'half'>): string => {
  const item = itemById(l.itemId);
  const other = secondHalf(l);
  return other ? `½ ${item.name.en} + ½ ${other.name.en}` : item.name.en;
};

/** What can be left out of the pizza: both halves' leave-outs, each once. */
export const leaveOutsOf = (item: MenuItem, other: MenuItem | null): Option[] =>
  other ? [...item.leaveOut, ...other.leaveOut.filter((o) => !item.leaveOut.some((x) => x.id === o.id))] : item.leaveOut;
