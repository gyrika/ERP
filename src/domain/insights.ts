import { gapCases, shortStreaks, toCheck, weekLoss, type GapCase } from './gapReview.ts';
import { costsToAnswer, marginsFell, soldWithoutRecipe } from './costInsights.ts';
import { inventoryFromEvents, isLowStock, isOutOfStock } from './inventory.ts';
import type { InventoryItem, Supplier } from './inventoryData.ts';
import { MENU, itemById } from './menu.ts';
import { fmt } from './money.ts';
import { formatQuantity } from './quantity.ts';
import { reasonLabel } from './counting.ts';
import type { SyncEvent } from './sync.ts';
import type { Cents, OrderLine } from './types.ts';
import { lineItemName } from './halves.ts';

/**
 * The Owner view's brain (CLAUDE.md: "tell the owner what needs attention and
 * what to decide, not reports"). Everything here is pure: events in, insights
 * out, so it runs the same on the counter, on the owner's phone and in tests.
 * `SuggestionsService` is the swap point: rules today, smarter predictions later.
 *
 * Each rule compares today with what is usual for this shop and speaks only when
 * the difference matters. "Usual" needs history, so a new shop sees few cards.
 */

export type Tone = 'attention' | 'good' | 'info';

export interface InsightItem {
  primary: string;
  secondary?: string;
  amount?: Cents;
  at?: number;
}

export interface Insight {
  /** Stable per kind of card, so the screen can animate and remember what was opened. */
  id: string;
  tone: Tone;
  title: string;
  detail: string;
  /** The one tap: open the list behind the card. */
  action: { label: string; items: InsightItem[] };
  /** Gaps for the owner to check (SCRUM-95): the list behind the card is answered, not just read. */
  cases?: CaseView[];
}

/** One gap as the owner sees it: the case, the item's name and the gap in words. */
export interface CaseView { gap: GapCase; name: string; gapText: string }

export interface DaySummary {
  salesCents: Cents;
  orders: number;
  averageCents: Cents;
}

export interface ShopData {
  events: readonly SyncEvent[];
  now: number;
  stock?: { items: readonly InventoryItem[]; suppliers: readonly Supplier[] };
}

export interface SuggestionsService {
  summary(data: ShopData): DaySummary;
  insights(data: ShopData): Insight[];
}

// ----- time, in the shop's local time -----

const DAY_MS = 24 * 60 * 60_000;
const startOfDay = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const minuteOfDay = (t: number): number => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };
/** The same weekday k weeks back, at midnight (calendar-safe across daylight saving). */
const weeksBack = (dayStart: number, k: number): number => { const d = new Date(dayStart); d.setDate(d.getDate() - 7 * k); return d.getTime(); };
const daysBack = (dayStart: number, k: number): number => { const d = new Date(dayStart); d.setDate(d.getDate() - k); return d.getTime(); };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const clock = (t: number): string => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dateLabel = (t: number): string => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const hourLabel = (t: number): string => {
  const h = new Date(t).getHours();
  return `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
};
const rs = (c: Cents) => `Rs ${fmt(c)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ----- facts from the events -----

interface Sale { orderNumber: number; total: Cents; at: number; by: string }

/**
 * Paid orders, as they stand: a payment undone later no longer counts.
 * Order numbers are not unique (each screen counts from 1001), so every payment is
 * its own sale, and an Undo takes back the latest payment with that number.
 */
export const salesFrom = (events: readonly SyncEvent[]): Sale[] => {
  const sales: (Sale | null)[] = [];
  const open = new Map<number, number[]>(); // order number → indexes of its payments still standing
  for (const e of events) {
    if (e.type === 'order.paid') {
      open.set(e.orderNumber, [...(open.get(e.orderNumber) ?? []), sales.length]);
      sales.push({ orderNumber: e.orderNumber, total: e.total, at: e.at, by: e.actor.name });
    } else if (e.type === 'order.payment_undone') {
      const i = open.get(e.orderNumber)?.pop();
      if (i !== undefined) sales[i] = null;
    }
  }
  return sales.filter((s): s is Sale => s !== null);
};

/** Days the shop was open (anything sold), among the last `days` before today. */
const openDays = (sales: Sale[], today: number, days: number): number[] => {
  const out: number[] = [];
  for (let k = 1; k <= days; k++) {
    const d = daysBack(today, k);
    if (sales.some((s) => s.at >= d && s.at < d + DAY_MS)) out.push(d);
  }
  return out;
};

const lineName = (l: OrderLine): string => {
  const item = itemById(l.itemId);
  const size = item.variants?.find((v) => v.id === l.size)?.label;
  return `${l.qty} × ${lineItemName(l)}${size ? ` ${size}` : ''}`;
};

// ----- the rules -----

const salesVsUsual = (sales: Sale[], now: number): Insight | null => {
  const today = startOfDay(now);
  const upTo = minuteOfDay(now);
  const sameTime = (day: number) => sales.filter((s) => s.at >= day && s.at < day + DAY_MS && minuteOfDay(s.at) <= upTo)
    .reduce((n, s) => n + s.total, 0);
  const past = [1, 2, 3, 4].map((k) => weeksBack(today, k))
    .map((day) => ({ day, total: sameTime(day), open: sales.some((s) => s.at >= day && s.at < day + DAY_MS) }))
    .filter((d) => d.open);
  if (past.length < 3) return null; // not enough history to know "usual"
  const usual = Math.round(past.reduce((n, d) => n + d.total, 0) / past.length / 100) * 100; // whole rupees
  if (usual < 500000) return null; // too early in the day to judge (under Rs 5,000 usually by now)
  const sofar = sameTime(today);
  const pct = Math.round(((sofar - usual) / usual) * 100);
  if (Math.abs(pct) < 20) return null;
  const weekday = WEEKDAYS[new Date(now).getDay()];
  return {
    id: 'sales-vs-usual',
    tone: pct < 0 ? 'attention' : 'good',
    title: `Sales ${Math.abs(pct)}% ${pct < 0 ? 'below' : 'above'} a usual ${weekday}`,
    detail: `${rs(sofar)} so far; usually ${rs(usual)} by ${hourLabel(now)}.`,
    action: {
      label: 'Compare',
      items: [
        { primary: `Today, by ${clock(now)}`, amount: sofar },
        ...past.map((d) => ({ primary: dateLabel(d.day), secondary: `by ${clock(now)}`, amount: d.total })),
      ],
    },
  };
};

type VoidEvent = Extract<SyncEvent, { type: 'order.item_cancelled' | 'order.line_removed' }>;
const isVoid = (e: SyncEvent): e is VoidEvent => e.type === 'order.item_cancelled' || e.type === 'order.line_removed';

const voidsToday = (events: readonly SyncEvent[], sales: Sale[], now: number): Insight | null => {
  const today = startOfDay(now);
  const voids = events.filter(isVoid);
  const todays = voids.filter((e) => e.at >= today);
  if (todays.length < 3) return null;
  const days = openDays(sales, today, 28);
  const usual = days.length ? voids.filter((e) => e.at >= daysBack(today, 28) && e.at < today).length / days.length : 0;
  if (todays.length < 2 * Math.max(usual, 0.5)) return null;
  const by = new Map<string, number>();
  for (const e of todays) by.set(e.actor.name, (by.get(e.actor.name) ?? 0) + 1);
  const [topName, topCount] = [...by.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  const mostlyOne = topCount >= Math.ceil((todays.length * 2) / 3);
  return {
    id: 'voids',
    tone: 'attention',
    title: `${plural(todays.length, 'void')} today${mostlyOne ? `, ${topCount} by ${topName}` : ''}`,
    detail: `Usually ${usual < 1 ? 'about 1 or none' : `about ${Math.round(usual)}`} a day.`,
    action: {
      label: 'See them',
      items: todays.map((e) => ({
        primary: `${lineName(e.before)} · order ${e.orderNumber}`,
        secondary: `${e.actor.name} · ${e.type === 'order.item_cancelled' ? e.reason : 'before it was sent'}`,
        at: e.at,
      })),
    },
  };
};

const GIVEAWAYS = new Set(['order.discount_set', 'order.comped', 'order.line_adjusted', 'order.change_undone']);

const discountsToday = (events: readonly SyncEvent[], sales: Sale[], now: number): Insight | null => {
  const today = startOfDay(now);
  const given = (e: SyncEvent) => ('totalBefore' in e && 'totalAfter' in e ? e.totalBefore - e.totalAfter : 0);
  const changes = events.filter((e) => GIVEAWAYS.has(e.type));
  const todays = changes.filter((e) => e.at >= today);
  const total = todays.reduce((n, e) => n + given(e), 0);
  if (total < 100000) return null; // under Rs 1,000 is not worth the owner's time
  const days = openDays(sales, today, 28);
  const usual = days.length
    ? changes.filter((e) => e.at >= daysBack(today, 28) && e.at < today).reduce((n, e) => n + given(e), 0) / days.length
    : 0;
  if (total < 2 * usual) return null;
  return {
    id: 'discounts',
    tone: 'attention',
    title: `${rs(total)} in discounts today`,
    detail: usual > 0 ? `Usually about ${rs(Math.round(usual / 100) * 100)} a day.` : 'Usually none.',
    action: {
      label: 'See them',
      items: todays.filter((e) => given(e) !== 0).map((e) => ({
        primary: `Order ${e.orderNumber} · ${e.type === 'order.comped' ? 'Free' : e.type === 'order.line_adjusted' ? 'Price adjusted' : e.type === 'order.change_undone' ? 'Undone' : 'Discount'}`,
        secondary: 'actor' in e ? e.actor.name : undefined,
        amount: given(e),
        at: e.at,
      })),
    },
  };
};

/** How long each ticket took, from Send to the kitchen's first Done. */
const ticketTimes = (events: readonly SyncEvent[]) => {
  const sent = new Map<string, { at: number; orderNumber: number }>();
  const out: { orderNumber: number; sentAt: number; minutes: number }[] = [];
  for (const e of events) {
    if (e.type === 'order.sent') sent.set(e.ticketId, { at: e.at, orderNumber: e.orderNumber });
    else if (e.type === 'kitchen.bumped') {
      const s = sent.get(e.ticketId);
      if (s) { out.push({ orderNumber: s.orderNumber, sentAt: s.at, minutes: (e.at - s.at) / 60_000 }); sent.delete(e.ticketId); }
    }
  }
  return out;
};

const kitchenSlow = (events: readonly SyncEvent[], now: number): Insight | null => {
  const times = ticketTimes(events);
  const recent = times.filter((t) => t.sentAt >= now - 2 * 60 * 60_000);
  const before = times.filter((t) => t.sentAt < startOfDay(now) && t.sentAt >= startOfDay(now) - 28 * DAY_MS);
  if (recent.length < 3 || before.length < 10) return null;
  const avg = (xs: { minutes: number }[]) => xs.reduce((n, t) => n + t.minutes, 0) / xs.length;
  const now2h = avg(recent);
  const usual = avg(before);
  if (now2h < 12 || now2h < usual * 1.5) return null;
  return {
    id: 'kitchen-slow',
    tone: 'attention',
    title: `Kitchen slow: ${Math.round(now2h)} min average`,
    detail: `In the last 2 hours. Usually ${Math.round(usual)} min.`,
    action: {
      label: 'See orders',
      items: [...recent].sort((a, b) => b.minutes - a.minutes)
        .map((t) => ({ primary: `Order ${t.orderNumber}`, secondary: `${Math.round(t.minutes)} min`, at: t.sentAt })),
    },
  };
};

const runningLow = (events: readonly SyncEvent[], stock: ShopData['stock'], now: number): Insight | null => {
  if (!stock) return null;
  // Only items someone has counted: a never-counted item is unknown, not empty. Low is the
  // reorder rule's call (it needs a rate of use), so an empty shelf is named too.
  const low = inventoryFromEvents(stock.items, events, { now }).filter((r) => !r.archived && r.counted && (isLowStock(r) || isOutOfStock(r)));
  if (!low.length) return null;
  const names = low.slice(0, 3).map((r) => r.name).join(', ');
  return {
    id: 'running-low',
    tone: 'attention',
    title: `${plural(low.length, 'item')} running low`,
    detail: `${names}${low.length > 3 ? ` and ${low.length - 3} more` : ''}.`,
    action: {
      label: 'Order list',
      items: [...low].sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => ({
          primary: r.name,
          // Stock here is worked out from sales, never seen: out means "go and look", not "stop selling".
          secondary: `${isOutOfStock(r) ? 'may be out: check the shelf' : `${plural(Math.round(r.onHandPacks * 10) / 10, 'pack')} left`} · ${r.supplierIds.map((id) =>
            stock.suppliers.find((s) => s.id === id)?.name ?? id).join(', ')}`,
        })),
    },
  };
};

/**
 * Counts this week that found less than the recipes said should be there: waste or
 * loss. Every shortfall is listed, the costliest first; no made-up "normal" amount.
 */
const countedShort = (events: readonly SyncEvent[], stock: ShopData['stock'], now: number): Insight | null => {
  if (!stock) return null;
  const since = daysBack(startOfDay(now), 7);
  const rows = inventoryFromEvents(stock.items, events, { now });
  const short = new Map<string, number>(); // packs, below zero
  /** The manager's reasons for this week's gaps (shelf counts), per item. */
  const why = new Map<string, Set<string>>();
  const undone = new Set(events.flatMap((e) => (e.type === 'stock.count_undone' ? [e.countId] : [])));
  for (const e of events) {
    if (e.at < since || e.at > now) continue;
    if (e.type === 'stock.adjusted' && e.reason === 'audit') short.set(e.itemId, (short.get(e.itemId) ?? 0) + e.deltaPacks);
    if (e.type === 'stock.counted' && !undone.has(e.id)) {
      const packQty = rows.find((r) => r.id === e.itemId)?.packQty ?? 1;
      short.set(e.itemId, (short.get(e.itemId) ?? 0) + (e.counted - e.expected) / packQty);
      if (e.reason) why.set(e.itemId, new Set([...(why.get(e.itemId) ?? []), reasonLabel(e.reason)]));
    }
  }
  const lost = [...short]
    .map(([id, packs]) => ({ row: rows.find((r) => r.id === id), packs }))
    .filter((x): x is { row: (typeof rows)[number]; packs: number } => !!x.row && x.packs < 0)
    .map(({ row, packs }) => ({ row, qty: -packs * row.packQty, cents: Math.round(-packs * row.workingPriceCents), why: [...(why.get(row.id) ?? [])] }))
    .sort((a, b) => b.cents - a.cents || a.row.name.localeCompare(b.row.name));
  if (!lost.length) return null;
  const [top] = lost;
  const total = lost.reduce((n, l) => n + l.cents, 0);
  // The week before, for scale (SCRUM-95): shelf counts only, the same way.
  const { lastWeek } = weekLoss(events, now);
  return {
    id: 'counted-short',
    tone: 'attention',
    title: `${top.row.name} counted ${formatQuantity(top.qty, top.row.baseUnit)} below expected this week`,
    detail: `${lost.length > 1 ? `And ${plural(lost.length - 1, 'more item')}. ` : ''}Rs ${fmt(total)} in all: waste or loss.${lastWeek > 0 ? ` Last week: Rs ${fmt(lastWeek)}.` : ''}`,
    action: {
      label: 'See counts',
      items: lost.map((l) => ({
        primary: l.row.name,
        secondary: `${formatQuantity(l.qty, l.row.baseUnit)} below expected${l.why.length ? ` · ${l.why.join(', ')}` : ''}`,
        amount: l.cents,
      })),
    },
  };
};

/**
 * Gaps beyond the allowance the owner has not OK'd (SCRUM-95): each with the manager's
 * reason and photo; the owner says OK, or asks. Answers come back on the same card.
 */
const gapsToCheck = (events: readonly SyncEvent[], stock: ShopData['stock']): Insight | null => {
  const open = toCheck(gapCases(events));
  if (!open.length) return null;
  const items = stock ? inventoryFromEvents(stock.items, events) : [];
  const cases = open.map((gap) => {
    const item = items.find((i) => i.id === gap.itemId);
    const qty = item ? formatQuantity(Math.abs(gap.delta), item.baseUnit) : `${Math.abs(gap.delta)}`;
    return { gap, name: item?.name ?? gap.itemId, gapText: `${qty} ${gap.delta < 0 ? 'short' : 'over'} · ${reasonLabel(gap.reason)}` };
  });
  const answered = open.filter((g) => g.review.kind === 'asked' && g.review.answer).length;
  const [first] = cases;
  return {
    id: 'gaps-to-check',
    tone: 'attention',
    title: open.length === 1 ? `${first.name}: ${first.gapText}` : `${plural(open.length, 'gap')} in the counts to check`,
    detail: answered ? `${plural(answered, 'answer')} from the manager.`
      : `With the manager's reason${open.some((g) => g.photo) ? ' and a photo of the shelf' : ''}. OK it, or ask.`,
    action: { label: 'Check', items: [] },
    cases,
  };
};

/** An item short beyond the allowance three counts running: a pattern worth a look. */
const shortStreak = (events: readonly SyncEvent[], stock: ShopData['stock']): Insight | null => {
  const streaks = shortStreaks(events);
  if (!streaks.length || !stock) return null;
  const items = inventoryFromEvents(stock.items, events);
  const named = streaks.map((s) => ({ ...s, name: items.find((i) => i.id === s.itemId)?.name ?? s.itemId }));
  const [top] = named;
  return {
    id: 'short-streak',
    tone: 'attention',
    title: `${top.name} short ${top.counts} counts in a row`,
    detail: `Rs ${fmt(top.cents)} over those counts. Not bad luck: worth a look at how it is kept or used.`,
    action: { label: 'See items', items: named.map((s) => ({ primary: s.name, secondary: `short ${s.counts} counts in a row`, amount: s.cents })) },
  };
};

/** Menu items ordered per item id, over a window. */
const itemsSold = (events: readonly SyncEvent[], from: number, to: number) => {
  const sold = new Map<string, number>();
  for (const e of events) {
    if (e.type !== 'order.sent' || e.at < from || e.at >= to) continue;
    // A half-and-half pizza sold both of its pizzas (half each).
    for (const l of e.lines) {
      for (const id of l.half ? [l.itemId, l.half] : [l.itemId]) sold.set(id, (sold.get(id) ?? 0) + (l.half ? l.qty / 2 : l.qty));
    }
  }
  return sold;
};

const notSelling = (events: readonly SyncEvent[], sales: Sale[], now: number): Insight | null => {
  const today = startOfDay(now);
  if (openDays(sales, today, 14).length < 10) return null; // need two real weeks to say "never"
  const sold = itemsSold(events, daysBack(today, 14), now);
  const idle = MENU.filter((m) => !sold.has(m.id));
  if (!idle.length) return null;
  return {
    id: 'not-selling',
    tone: 'info',
    title: idle.length === 1 ? `${idle[0].name.en} hasn't sold in 2 weeks` : `${idle.length} menu items haven't sold in 2 weeks`,
    detail: 'Remove, change or promote?',
    action: { label: 'See them', items: idle.map((m) => ({ primary: m.name.en, secondary: m.description })) },
  };
};

const bestSeller = (events: readonly SyncEvent[], now: number): Insight | null => {
  const sold = [...itemsSold(events, startOfDay(now), now + 1).entries()].sort((a, b) => b[1] - a[1]);
  if (!sold.length || sold[0][1] < 5) return null;
  const [id, qty] = sold[0];
  return {
    id: 'best-seller',
    tone: 'good',
    title: `${itemById(id).name.en} is today's best seller`,
    detail: `${qty} sold so far.`,
    action: { label: 'Top items', items: sold.slice(0, 8).map(([i, q]) => ({ primary: itemById(i).name.en, secondary: `${q} sold` })) },
  };
};

const ORDER: Record<Tone, number> = { attention: 0, info: 1, good: 2 };

/** The rules engine. Cards needing a decision come first, good news last. */
export const rulesSuggestions: SuggestionsService = {
  summary({ events, now }) {
    const today = startOfDay(now);
    const sales = salesFrom(events).filter((s) => s.at >= today && s.at <= now);
    const salesCents = sales.reduce((n, s) => n + s.total, 0);
    return { salesCents, orders: sales.length, averageCents: sales.length ? Math.round(salesCents / sales.length) : 0 };
  },
  insights({ events, now, stock }) {
    const sales = salesFrom(events);
    return [
      salesVsUsual(sales, now),
      voidsToday(events, sales, now),
      discountsToday(events, sales, now),
      kitchenSlow(events, now),
      runningLow(events, stock, now),
      gapsToCheck(events, stock),
      shortStreak(events, stock),
      countedShort(events, stock, now),
      soldWithoutRecipe(events, now),
      marginsFell(events, stock, now),
      costsToAnswer(events, stock, now),
      notSelling(events, sales, now),
      bestSeller(events, now),
    ].filter((x): x is Insight => x !== null).sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);
  },
};
