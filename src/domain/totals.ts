import { itemById } from './menu.ts';
import { lineTotal } from './money.ts';
import type { Cents, Discount, Order, OrderLine } from './types.ts';

/**
 * Order totals with manager adjustments. All integer cents:
 *   subtotal      = sum of line prices (menu prices, never changed)
 *   lineAdjust    = sum of per-line adjustments, each capped at its line
 *   orderDiscount = percentage of what is left, rounded ONCE (half up), or all of it for Free
 *   total         = subtotal - lineAdjust - orderDiscount
 * so total + lineAdjust + orderDiscount === subtotal, always, to the cent.
 */
export interface Totals {
  subtotal: Cents;
  lineAdjust: Cents;
  orderDiscount: Cents;
  total: Cents;
}

export const lineGross = (l: OrderLine): Cents =>
  l.unit !== undefined ? l.unit * l.qty : lineTotal(itemById(l.itemId), l);

/** A line's adjustment, capped so a line never goes below zero. */
export const lineAdjustment = (order: Order, l: OrderLine): Cents =>
  Math.min(Math.max(0, order.adjust?.lines?.[l.id] ?? 0), lineGross(l));

export const lineNet = (order: Order, l: OrderLine): Cents => lineGross(l) - lineAdjustment(order, l);

/** Integer percent of integer cents, rounded half up, with no floating point. */
export const percentOf = (cents: Cents, pct: number): Cents => Math.floor((cents * pct + 50) / 100);

export const discountAmount = (afterLines: Cents, d: Discount | undefined): Cents =>
  !d ? 0 : d.kind === 'comp' ? afterLines : Math.min(afterLines, percentOf(afterLines, d.pct));

export const totals = (order: Order): Totals => {
  const subtotal = order.lines.reduce((s, l) => s + lineGross(l), 0);
  const lineAdjust = order.lines.reduce((s, l) => s + lineAdjustment(order, l), 0);
  const orderDiscount = discountAmount(subtotal - lineAdjust, order.adjust?.discount);
  return { subtotal, lineAdjust, orderDiscount, total: subtotal - lineAdjust - orderDiscount };
};

export const discountLabel = (d: Discount): string => (d.kind === 'comp' ? 'Free' : `${d.pct}% off`);
