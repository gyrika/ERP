import { isOverdue, nearLimit, type CreditAccount } from './credit.ts';
import { isGoneQuiet } from './customerInsights.ts';
import type { Customer, Visit } from './customers.ts';
import { fmt } from './money.ts';
import { lkDate, lkTime } from './salesLedger.ts';
import type { Cents, OrderLine, SizeId } from './types.ts';

/**
 * What the Customers screens draw, folded from what the shop already keeps (customers.ts, credit.ts,
 * the event log). Who: the owner or a manager on the shop PC. Nothing here is stored or typed in.
 * See docs/crm-redesign.md.
 */
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// ----- when -----

/** "Today", "Yesterday", "3 days ago" (Sri Lanka days). */
export function relativeDay(at: number, now: number): string {
  const days = Math.round((Date.parse(lkDate(now)) - Date.parse(lkDate(at))) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
/** The Sri Lanka weekday of a moment, 0 = Sunday. */
export const lkWeekday = (at: number): number => new Date(`${lkDate(at)}T00:00:00Z`).getUTCDay();
export const weekdayName = (d: number): string => WEEKDAYS[d];

// ----- visits, week by week -----

export type BillSize = 's' | 'm' | 'b';
export interface WeekVisit { size: BillSize; credit: boolean }
/** One week of a customer's visits, oldest week first; the last week ends now. */
export type WeekCell = WeekVisit[];

/**
 * A customer's visits in the last `weeks` weeks, each sized against their own bills (thirds: small,
 * middle, big; under three visits all are middle) and marked when it went on credit.
 */
export function weekStrip(visits: readonly Visit[], now: number, weeks: number, creditSales: ReadonlySet<string> = new Set()): WeekCell[] {
  const totals = visits.map((v) => v.total).sort((a, b) => a - b);
  const third = (k: number) => totals[Math.floor((totals.length * k) / 3)] ?? 0;
  const [low, high] = [third(1), third(2)];
  const sizeOf = (t: Cents): BillSize => (totals.length < 3 ? 'm' : t < low ? 's' : t >= high && high > low ? 'b' : 'm');
  const out: WeekCell[] = Array.from({ length: weeks }, () => []);
  const from = now - weeks * WEEK_MS;
  for (const v of [...visits].sort((a, b) => a.at - b.at)) {
    if (v.at <= from || v.at > now) continue;
    const i = Math.min(weeks - 1, Math.floor((v.at - from) / WEEK_MS));
    out[i].push({ size: sizeOf(v.total), credit: creditSales.has(v.saleId) });
  }
  return out;
}

/** The sale ids that went on credit (a bill still on the account, open or paid back). */
export const creditSaleIds = (accounts: Iterable<CreditAccount>): Set<string> => {
  const out = new Set<string>();
  for (const a of accounts) for (const b of a.bills) out.add(b.saleId);
  return out;
};

export interface ComingBack {
  /** Oldest first; the last week ends now. Named orders only (a customer on the payment). */
  weeks: { returning: number; first: number }[];
  /** This week's share of named orders from people who had been before (0-1), or null with none. */
  shareThisWeek: number | null;
}

/** Named orders per week: from someone who had been before, or their first ever visit. */
export function comingBack(visits: ReadonlyMap<string, readonly Visit[]>, now: number, weeks = 12): ComingBack {
  const out = Array.from({ length: weeks }, () => ({ returning: 0, first: 0 }));
  const from = now - weeks * WEEK_MS;
  for (const list of visits.values()) {
    const sorted = [...list].sort((a, b) => a.at - b.at);
    sorted.forEach((v, i) => {
      if (v.at <= from || v.at > now) return;
      const w = out[Math.min(weeks - 1, Math.floor((v.at - from) / WEEK_MS))];
      if (i === 0) w.first++; else w.returning++;
    });
  }
  const last = out[weeks - 1];
  const named = last.returning + last.first;
  return { weeks: out, shareThisWeek: named ? last.returning / named : null };
}

// ----- what they buy -----

export interface Favourite { itemId: string; size?: SizeId; n: number }

/** What a customer buys most (dish and size, by quantity), most first; ties go to the more recent. */
export function favourites(orders: readonly (readonly OrderLine[])[], count = 4): Favourite[] {
  // orders: newest first (customers.ts customerOrders), so the first seen is the most recent.
  const seen = new Map<string, Favourite & { order: number }>();
  orders.forEach((lines, order) => {
    for (const l of lines) {
      const key = `${l.itemId}|${l.size ?? ''}`;
      const f = seen.get(key);
      if (f) f.n += l.qty;
      else seen.set(key, { itemId: l.itemId, ...(l.size ? { size: l.size } : {}), n: l.qty, order });
    }
  });
  return [...seen.values()].sort((a, b) => b.n - a.n || a.order - b.order).slice(0, count).map(({ order: _o, ...f }) => f);
}

/** Left out often enough to be "how they like it": at least this many times... */
export const LEAVE_OUT_MIN = 3;
/** ...and on at least this share of that dish. */
export const LEAVE_OUT_SHARE = 0.5;

export interface LeaveOut { itemId: string; optionId: string; n: number; of: number }

/** The leave-out this customer asks for most ("no onion on 14 of 18"), or null. */
export function usualLeaveOut(orders: readonly (readonly OrderLine[])[]): LeaveOut | null {
  const dish = new Map<string, number>();
  const outs = new Map<string, LeaveOut>();
  for (const lines of orders) {
    for (const l of lines) {
      dish.set(l.itemId, (dish.get(l.itemId) ?? 0) + 1);
      for (const o of new Set(l.outs)) {
        const key = `${l.itemId}|${o}`;
        const x = outs.get(key);
        if (x) x.n++; else outs.set(key, { itemId: l.itemId, optionId: o, n: 1, of: 0 });
      }
    }
  }
  let best: LeaveOut | null = null;
  for (const x of outs.values()) {
    x.of = dish.get(x.itemId) ?? x.n;
    if (x.n < LEAVE_OUT_MIN || x.n / x.of < LEAVE_OUT_SHARE) continue;
    if (!best || x.n > best.n) best = x;
  }
  return best;
}

/** One weekday and two-hour window holds at least this share of visits: "Usually Fri, 7–9 pm". */
export const USUAL_TIME_SHARE = 0.4;
export interface UsualTime { weekday: number; from: number; to: number; n: number; of: number }

/** When this customer usually comes (Sri Lanka time), or null when no window holds 40% of 3+ visits. */
export function usualTime(visits: readonly Pick<Visit, 'at'>[]): UsualTime | null {
  if (visits.length < 3) return null;
  const at = visits.map((v) => ({ d: lkWeekday(v.at), h: Number(lkTime(v.at).slice(0, 2)) }));
  let best: UsualTime | null = null;
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 23; h++) {
      const n = at.filter((x) => x.d === d && x.h >= h && x.h < h + 2).length;
      if (!best || n > best.n) best = { weekday: d, from: h, to: h + 2, n, of: visits.length };
    }
  }
  return best && best.n / best.of >= USUAL_TIME_SHARE ? best : null;
}

const hour12 = (h: number) => `${h % 12 === 0 ? 12 : h % 12}`;
/** "Fri, 7–9 pm" / "Sat, 11 am–1 pm". */
export function usualTimeText(u: UsualTime): string {
  const half = (h: number) => (h % 24 < 12 ? 'am' : 'pm');
  const to = u.to % 24;
  const span = half(u.from) === half(to) ? `${hour12(u.from)}–${hour12(to)} ${half(to)}` : `${hour12(u.from)} ${half(u.from)}–${hour12(to)} ${half(to)}`;
  return `${weekdayName(u.weekday).slice(0, 3)}, ${span}`;
}

/** The average of some bills, whole cents (0 with none). */
export const averageBill = (bills: readonly { total: Cents }[]): Cents =>
  bills.length ? Math.round(bills.reduce((s, b) => s + b.total, 0) / bills.length) : 0;

// ----- the top of Customers -----

export interface NeedsYouCard {
  id: 'quiet' | 'owed' | 'new';
  tone: 'warn' | 'bad' | 'ok';
  label: string;
  title: string;
  detail: string;
  action: string;
  go: string;
}

/**
 * Up to three things worth the owner's minute, each one sentence and one tap: regulars gone quiet,
 * money owed on credit, and new customers this month. Nothing to say: no card.
 */
export function needsYou(p: {
  customers: readonly Pick<Customer, 'id' | 'name' | 'phone' | 'source' | 'createdAt'>[];
  visits: ReadonlyMap<string, readonly Visit[]>;
  credit: ReadonlyMap<string, CreditAccount>;
  newThisMonth: number;
  now: number;
}): NeedsYouCard[] {
  const out: NeedsYouCard[] = [];
  const quiet = p.customers.filter((c) => isGoneQuiet(p.visits.get(c.id) ?? [], p.now)).length;
  if (quiet > 0) {
    out.push({
      id: 'quiet', tone: 'warn', label: 'Gone quiet',
      title: quiet === 1 ? 'A regular is away twice their usual gap' : `${quiet} regulars are away twice their usual gap`,
      detail: 'An offer still brings most back before 30 days.',
      action: 'Send them an offer', go: '#customers/campaigns?to=quiet',
    });
  }
  const owing = [...p.credit.values()].filter((a) => a.owes > 0);
  if (owing.length) {
    const owed = owing.reduce((s, a) => s + a.owes, 0);
    const overdue = owing.filter((a) => isOverdue(a, p.now)).length;
    const near = owing.filter(nearLimit).sort((a, b) => b.owes - a.owes)[0];
    const nearName = near ? p.customers.find((c) => c.id === near.customerId)?.name ?? null : null;
    const nearPct = near?.setting?.limit ? Math.round((near.owes / near.setting.limit) * 100) : 0;
    out.push({
      id: 'owed', tone: overdue ? 'bad' : 'warn', label: 'Owed',
      title: `Rs ${fmt(owed)} on credit${overdue ? `, ${overdue} ${overdue === 1 ? 'customer' : 'customers'} with nothing paid for 30+ days` : ''}`,
      detail: near ? `${nearName ?? 'A customer'} is at ${nearPct}% of their limit.` : `${owing.length} ${owing.length === 1 ? 'customer owes' : 'customers owe'}.`,
      action: 'See who owes', go: '#customers/owes',
    });
  }
  if (p.newThisMonth > 0) {
    const month = lkDate(p.now).slice(0, 7);
    const signed = p.customers.filter((c) => c.source === 'app' && lkDate(c.createdAt).slice(0, 7) === month).length;
    out.push({
      id: 'new', tone: 'ok', label: 'New',
      title: `${p.newThisMonth} new ${p.newThisMonth === 1 ? 'customer' : 'customers'} this month`,
      detail: signed ? `${signed} signed up for offers in the app.` : 'Their first visit was this month.',
      action: 'See them', go: '#customers?show=new',
    });
  }
  return out;
}

// ----- Campaigns -----

export interface ReachFunnel { total: number; signedUp: number; reachable: number; optedOut: number }

/** Who a message can reach: everyone, those signed up for offers in the app, and of those, who has not said no. */
export function reachFunnel(customers: readonly Pick<Customer, 'id' | 'optedOut'>[], withApp: ReadonlySet<string>): ReachFunnel {
  const signed = customers.filter((c) => withApp.has(c.id));
  return {
    total: customers.length,
    signedUp: signed.length,
    reachable: signed.filter((c) => !c.optedOut).length,
    optedOut: customers.filter((c) => c.optedOut).length,
  };
}

/** Sign-ups for offers in the app (source "app"), this Sri Lanka month and the one before. */
export function signupsByMonth(customers: readonly Pick<Customer, 'source' | 'createdAt'>[], now: number): { thisMonth: number; lastMonth: number } {
  const month = lkDate(now).slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  let thisMonth = 0;
  let lastMonth = 0;
  for (const c of customers) {
    if (c.source !== 'app') continue;
    const cm = lkDate(c.createdAt).slice(0, 7);
    if (cm === month) thisMonth++; else if (cm === prev) lastMonth++;
  }
  return { thisMonth, lastMonth };
}
