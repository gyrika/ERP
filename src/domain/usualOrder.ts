import type { LineSpec, MenuItem, OrderLine } from './types.ts';

/**
 * "The usual": what a known customer orders, offered as one button when the cashier puts them on
 * a new order. Worked out from their past payments (customers.ts `customerOrders`), never stored.
 *
 * Among their last `LOOK_BACK` orders, the one bought most often (the same dishes, sizes, extras
 * and quantities, in any order) is the usual once it was bought at least twice; otherwise their
 * last order is offered as "Last time". Ties go to the more recent.
 *
 * Only what can be ordered today is offered: a dish taken off the menu or sold out is left out,
 * and an order that was a combo box is skipped (its price came from the box, not the dishes).
 */
export const LOOK_BACK = 10;

export interface Usual {
  kind: 'usual' | 'last';
  lines: LineSpec[];
  /** How many of the orders looked at were this one. */
  times: number;
}

const spec = (l: OrderLine): LineSpec => ({
  itemId: l.itemId, qty: l.qty, adds: [...l.adds], outs: [...l.outs],
  ...(l.size ? { size: l.size } : {}), ...(l.half ? { half: l.half } : {}), ...(l.note ? { note: l.note } : {}),
});

/** The same lines merged (two sends of one dish are one line) and in one order, so equal orders compare equal. */
const normalise = (lines: readonly OrderLine[]): LineSpec[] => {
  const byKey = new Map<string, LineSpec>();
  for (const l of lines) {
    const s = spec(l);
    const k = keyOf({ ...s, qty: 0 });
    const had = byKey.get(k);
    if (had) had.qty += s.qty; else byKey.set(k, s);
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s);
};

const keyOf = (s: LineSpec): string =>
  [s.itemId, s.size ?? '', s.half ?? '', [...s.adds].sort().join('+'), [...s.outs].sort().join('+'), s.note ?? '', s.qty].join('|');

/**
 * `orders`: the customer's orders, newest first. `item`: today's menu (undefined: not on it).
 * Null when there is nothing to offer.
 */
export const usualOrder = (
  orders: readonly (readonly OrderLine[])[],
  item: (id: string) => MenuItem | undefined,
): Usual | null => {
  const orderable = (s: LineSpec): boolean => {
    const ids = s.half ? [s.itemId, s.half] : [s.itemId];
    return ids.every((id) => { const m = item(id); return Boolean(m && !m.hidden && !m.removed && !m.soldOut); });
  };
  const candidates = orders
    .slice(0, LOOK_BACK)
    .filter((lines) => lines.length > 0 && !lines.some((l) => l.box))
    .map((lines) => normalise(lines).filter(orderable))
    .filter((lines) => lines.length > 0);
  if (!candidates.length) return null;

  const counts = new Map<string, { lines: LineSpec[]; times: number; newest: number }>();
  candidates.forEach((lines, i) => {
    const k = lines.map(keyOf).join(',');
    const had = counts.get(k);
    if (had) had.times++; else counts.set(k, { lines, times: 1, newest: i });
  });
  const best = [...counts.values()].sort((a, b) => b.times - a.times || a.newest - b.newest)[0];
  return best.times >= 2
    ? { kind: 'usual', lines: best.lines, times: best.times }
    : { kind: 'last', lines: candidates[0], times: 1 };
};
