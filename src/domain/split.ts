import { orderTotal } from './order.ts';
import { lineNet } from './totals.ts';
import type { Cents, Order, OrderLine, Tender } from './types.ts';

/**
 * Split bills: a group pays one order in parts, each person their own items, each part its
 * own tender. All integer cents.
 *
 * A part is worth its items' share of the order total (so an order discount and a delivery fee
 * are shared in proportion), rounded to the cent; the part that pays the last items takes what is
 * left, so the parts always add up to the total exactly.
 */
export interface PaymentPart {
  tender: Tender;
  amount: Cents;
  /** What the customer handed over for this part (cash: may be more than `amount`). */
  tendered: Cents;
  at: number;
  /** Units paid by this part, per line id. Kept on this screen only. */
  units?: Record<string, number>;
}

/** Units chosen, per line id. */
export type Pick = Record<string, number>;

/** Units of each line already paid by earlier parts. */
export const paidUnits = (order: Order): Pick => {
  const out: Pick = {};
  for (const p of order.parts ?? []) {
    for (const [id, n] of Object.entries(p.units ?? {})) out[id] = (out[id] ?? 0) + n;
  }
  return out;
};

/** Units of a line still to pay (never below 0, even if the line shrank after a part was paid). */
export const unitsLeft = (order: Order, l: OrderLine): number => Math.max(0, l.qty - (paidUnits(order)[l.id] ?? 0));

/** What earlier parts have paid. */
export const paidSoFar = (order: Order): Cents => (order.parts ?? []).reduce((s, p) => s + p.amount, 0);

/** What is still owed on the order. */
export const amountLeft = (order: Order): Cents => orderTotal(order) - paidSoFar(order);

/** A pick limited to the units still to pay; empty entries dropped. */
export const cleanPick = (order: Order, pick: Pick): Pick => {
  const out: Pick = {};
  for (const l of order.lines) {
    const n = Math.min(Math.max(0, Math.floor(pick[l.id] ?? 0)), unitsLeft(order, l));
    if (n > 0) out[l.id] = n;
  }
  return out;
};

/** The pick takes every unit still to pay: this part closes the order. */
export const picksAllLeft = (order: Order, pick: Pick): boolean => {
  const p = cleanPick(order, pick);
  return order.lines.every((l) => (p[l.id] ?? 0) === unitsLeft(order, l));
};

/**
 * What the picked units come to. The last part (every unit left) takes exactly what is left, so
 * rounding never loses or makes a cent. Otherwise: the units' share of the line totals, applied
 * to the order total, rounded half up.
 */
export const pickAmount = (order: Order, pick: Pick): Cents => {
  const p = cleanPick(order, pick);
  if (picksAllLeft(order, p)) return amountLeft(order);
  const all = order.lines.reduce((s, l) => s + lineNet(order, l), 0);
  if (all <= 0) return 0;
  // Integer division, rounded half up: the units' part of each line, then their share of the total.
  const half = (a: number, b: number): Cents => Math.floor((2 * a + b) / (2 * b));
  const picked = order.lines.reduce((s, l) => s + (p[l.id] ? half(lineNet(order, l) * p[l.id], l.qty) : 0), 0);
  return Math.min(half(orderTotal(order) * picked, all), amountLeft(order));
};

/** An order being split has at least one part paid. */
export const isSplit = (order: Order): boolean => (order.parts?.length ?? 0) > 0;

/** The tenders of a payment, as parts: a split payment's parts, or the whole as one. */
export const tenderParts = (p: { total: Cents; tender: Tender; tendered: Cents; parts?: readonly { tender: Tender; amount: Cents; tendered: Cents }[] }): { tender: Tender; amount: Cents; tendered: Cents }[] =>
  p.parts?.length ? p.parts.map(({ tender, amount, tendered }) => ({ tender, amount, tendered })) : [{ tender: p.tender, amount: p.total, tendered: p.tendered }];

/** Cash change handed back over a payment's parts. */
export const changeGiven = (p: Parameters<typeof tenderParts>[0]): Cents =>
  tenderParts(p).reduce((s, x) => s + (x.tender === 'cash' ? Math.max(0, x.tendered - x.amount) : 0), 0);

/** The tender that took the most money: the one a single "tender" column shows for a split payment. */
export const mainTender = (p: Parameters<typeof tenderParts>[0]): Tender =>
  tenderParts(p).reduce((a, b) => (b.amount > a.amount ? b : a)).tender;
