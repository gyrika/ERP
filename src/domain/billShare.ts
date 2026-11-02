import { COOK_MINUTES } from './kitchen.ts';
import { monthOf, moneyOutFromEvents, shiftMonth, type MoneyOut, type MonthKey } from './moneyOut.ts';
import type { ResourceLine } from './resources.ts';
import type { MenuItem } from './types.ts';

/**
 * What the real bills add to one dish (Visual Flow). Serves the owner, who knows what he paid but
 * not what it means per pizza. Each bill is spread over the dishes sold in the time it covers, by
 * cook minutes: a pasta takes 20 minutes of the kitchen, a burger 3. The shares of a bill add up
 * to the bill. Pure: events in, cents per cook minute out.
 *
 * A bill replaces the owner's typed estimate of the same thing (typedInBills), never adds to it,
 * so the same money is not counted twice. With no bill yet, his estimates stay as they are.
 */
export type BillKind = 'electricity' | 'gas' | 'water';
export const BILL_KINDS: readonly BillKind[] = ['electricity', 'gas', 'water'];
export const BILLS_NODE = 'res:bills';

export interface BillPart {
  kind: BillKind;
  /** The money spread. */
  cents: number;
  /** The time it covers: [from, to). */
  from: number;
  to: number;
  /** Cook minutes of the dishes sold in that time. */
  minutes: number;
  /** What one cook minute costs, unrounded cents. */
  perMinute: number;
}

const DAY = 86_400_000;
/** Older than this, a bill no longer says what things cost now. */
const MAX_AGE_DAYS = 120;

const monthStart = (month: MonthKey): number => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).getTime();
};

/** The cook minutes of what was sold in [from, to); a half and half counts half to each side. */
export const cookMinutesSold = (events: readonly { type: string }[], menu: readonly MenuItem[], from: number, to: number): number => {
  type Line = { itemId: string; qty: number; half?: string };
  const minutesOf = (id: string): number => {
    const item = menu.find((m) => m.id === id);
    return item ? COOK_MINUTES[item.category] : 0;
  };
  const worth = (l: Line) => l.qty * (l.half ? (minutesOf(l.itemId) + minutesOf(l.half)) / 2 : minutesOf(l.itemId));
  const tickets = new Map<string, number>();
  let n = 0;
  for (const e of events as ({ type: string; at: number; ticketId?: string; lines?: Line[]; before?: Line })[]) {
    if (e.at < from || e.at >= to) continue;
    if (e.type === 'order.sent' && e.lines) {
      const k = e.lines.reduce((s, l) => s + worth(l), 0);
      tickets.set(e.ticketId ?? '', k);
      n += k;
    } else if (e.type === 'order.send_undone') n -= tickets.get(e.ticketId ?? '') ?? 0;
    else if (e.type === 'order.item_cancelled' && e.before) n -= worth(e.before);
  }
  return Math.max(0, n);
};

/** A meter bill: the latest finished month that has one. This month's sales are not all in yet. */
const meterBill = (kind: BillKind, paid: readonly MoneyOut[], now: number): Omit<BillPart, 'minutes' | 'perMinute'> | null => {
  const thisMonth = monthOf(now);
  const months = [...new Set(paid.filter((o) => o.what === kind && o.month < thisMonth).map((o) => o.month))].sort();
  const month = months.at(-1);
  if (!month) return null;
  const to = monthStart(shiftMonth(month, 1));
  if (now - to > MAX_AGE_DAYS * DAY) return null;
  return { kind, cents: paid.filter((o) => o.what === kind && o.month === month).reduce((s, o) => s + o.cents, 0), from: monthStart(month), to };
};

/**
 * Gas, cylinder to cylinder: a cylinder is bought when the last one runs out, so what was bought
 * before the latest purchase is what was burnt since the first. The latest is still in use, so it
 * does not count yet. Needs purchases on two different days. Cylinders bought the same day are one
 * purchase. A month would swing with whether a cylinder happened to fall in it.
 */
const gasBill = (paid: readonly MoneyOut[], now: number): Omit<BillPart, 'minutes' | 'perMinute'> | null => {
  const since = now - MAX_AGE_DAYS * DAY;
  const gas = paid.filter((o) => o.what === 'gas' && o.at >= since && o.at <= now);
  const dayOf = (at: number) => new Date(at).setHours(0, 0, 0, 0);
  const days = [...new Set(gas.map((o) => dayOf(o.at)))].sort((a, b) => a - b);
  if (days.length < 2) return null;
  const last = days[days.length - 1];
  return { kind: 'gas', cents: gas.filter((o) => dayOf(o.at) < last).reduce((s, o) => s + o.cents, 0), from: days[0], to: last };
};

/** Every bill that can be spread: none when it covers no sales, since a share of nothing says nothing. */
export const billParts = (events: readonly { type: string }[], menu: readonly MenuItem[], now: number): BillPart[] => {
  const paid = moneyOutFromEvents(events);
  const parts = [meterBill('electricity', paid, now), gasBill(paid, now), meterBill('water', paid, now)];
  return parts.flatMap((p) => {
    if (!p) return [];
    const minutes = cookMinutesSold(events, menu, p.from, p.to);
    return minutes > 0 ? [{ ...p, minutes, perMinute: p.cents / minutes }] : [];
  });
};

/** The bill a typed line estimates, if any: gas and water are typed as "other" costs with a name. */
export const billOfLine = (line: ResourceLine): BillKind | null => {
  if (line.kind === 'electricity') return 'electricity';
  if (line.kind !== 'other') return null;
  if (/\b(gas|lpg)\b/i.test(line.label ?? '')) return 'gas';
  if (/\bwater\b/i.test(line.label ?? '')) return 'water';
  return null;
};

/** What the bills add to one dish, unrounded cents, kind by kind. Only a dish on the menu has cook minutes. */
export const billsForDish = (parts: readonly BillPart[], item: MenuItem | undefined): { part: BillPart; cents: number }[] =>
  (item ? parts.map((part) => ({ part, cents: part.perMinute * COOK_MINUTES[item.category] })) : []);
