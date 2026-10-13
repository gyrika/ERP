import { itemById } from './menu.ts';
import { unitPrice } from './money.ts';
import { totals } from './totals.ts';
import type { Cents, LineSpec, Order, OrderLine } from './types.ts';

let seq = 0;
export const newLineId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `line-${Date.now()}-${seq++}`;

export const emptyOrder = (number: number): Order => ({ number, lines: [] });

const sameConfig = (a: LineSpec, b: LineSpec): boolean =>
  a.itemId === b.itemId &&
  a.size === b.size &&
  (a.note ?? '') === (b.note ?? '') &&
  [...a.adds].sort().join() === [...b.adds].sort().join() &&
  [...a.outs].sort().join() === [...b.outs].sort().join();

/**
 * Adds a line; an identical unsent line just increases quantity (fewer rows to
 * read). Sent lines never merge, so a second round reaches the kitchen as new.
 */
export const addLine = (order: Order, spec: LineSpec): Order => {
  const hit = order.lines.find((l) => !l.sent && sameConfig(l, spec));
  if (hit) {
    return { ...order, lines: order.lines.map((l) => (l === hit ? { ...l, qty: l.qty + spec.qty } : l)) };
  }
  return { ...order, lines: [...order.lines, { ...spec, id: newLineId() }] };
};

export const addLines = (order: Order, specs: LineSpec[]): Order => specs.reduce(addLine, order);

export const updateLine = (order: Order, line: OrderLine): Order => ({
  ...order,
  lines: order.lines.map((l) => (l.id === line.id ? line : l)),
});

export const removeLine = (order: Order, id: string): Order => ({
  ...order,
  lines: order.lines.filter((l) => l.id !== id),
});

/** What the customer pays: menu prices minus any manager adjustments (see totals.ts). */
export const orderTotal = (order: Order): Cents => totals(order).total;

export const unsentLines = (order: Order): OrderLine[] => order.lines.filter((l) => !l.sent);

/** Sending fixes each new line's price (size + extras) as the menu has it now. */
export const markSent = (order: Order, at: number): Order => ({
  ...order,
  sentAt: order.sentAt ?? at,
  lines: order.lines.map((l) => (l.sent ? l : { ...l, sent: true, unit: l.unit ?? unitPrice(itemById(l.itemId), l) })),
});

export const bareLine = (itemId: string, size?: LineSpec['size']): LineSpec => ({
  itemId, qty: 1, size, adds: [], outs: [],
});
