import type { OrderEvent } from './events.ts';
import { withoutTestData } from './freshStart.ts';
import { lkDate, saleFrom, type SaleRow } from './salesLedger.ts';
import type { SyncEvent } from './sync.ts';
import type { Cents } from './types.ts';

/**
 * Customers (CRM): who they are lives in the shop server's customer list (number, name, opt-out),
 * which can be corrected and erased. What they bought lives in the event log, as it always has: a
 * payment names its customer by an opaque id (`order.paid.customerId`), and everything here is
 * folded from that. So stats, segments and history are worked out when asked and never disagree
 * with the sales: nothing keeps a copy that could go stale.
 *
 * Test data cleared by the owner (freshStart.ts) is left out, like every other reader.
 */

/** cus- and 16 hex characters: made by the shop server, never from the number. */
export const CUSTOMER_ID = /^cus-[0-9a-f]{16}$/;
export const isCustomerId = (v: unknown): v is string => typeof v === 'string' && CUSTOMER_ID.test(v);

/** Where a customer first came from: given at Charge, the owner's spreadsheet, typed in, or signed up for offers in the app. */
export type CustomerSource = 'pos' | 'import' | 'manual' | 'app';

export interface Customer {
  id: string;
  /** +947XXXXXXXX (phone.ts). */
  phone: string;
  name: string | null;
  source: CustomerSource;
  /** Asked for no messages: respected by every campaign and automatic message. */
  optedOut: boolean;
  createdAt: number;
}

/** One payment that still stands, for one customer. */
export interface Visit { saleId: string; orderNumber: number; at: number; total: Cents }

export interface CustomerStats {
  customerId: string;
  orders: number;
  spent: Cents;
  firstVisitAt: number;
  lastVisitAt: number;
}

const DAY_MS = 86_400_000;

type Paid = Extract<OrderEvent, { type: 'order.paid' }>;

/**
 * Every payment that still stands, with the order's events behind it, oldest first. Order numbers
 * are not unique (each screen counts from 1001), so, as the cloud's sales ledger does, an order is
 * what its number did since the payment before it that still stands; an undone payment gives its
 * order back to the next payment of that number.
 */
const standingSales = (events: readonly SyncEvent[]): { paid: Paid; order: OrderEvent[] }[] => {
  const pending = new Map<number, OrderEvent[]>(); // number → its events since its last standing payment
  const paidOf = new Map<number, { paid: Paid; order: OrderEvent[]; index: number }[]>();
  const sales: ({ paid: Paid; order: OrderEvent[] } | null)[] = [];
  for (const e of withoutTestData(events)) {
    if (!e.type.startsWith('order.')) continue;
    const o = e as OrderEvent;
    const n = o.orderNumber;
    if (o.type === 'order.paid') {
      const order = pending.get(n) ?? [];
      pending.delete(n);
      const sale = { paid: o, order, index: sales.length };
      sales.push({ paid: o, order });
      paidOf.set(n, [...(paidOf.get(n) ?? []), sale]);
    } else if (o.type === 'order.payment_undone') {
      const stack = paidOf.get(n);
      const undone = stack?.pop();
      if (!undone) continue;
      sales[undone.index] = null;
      pending.set(n, [...undone.order, ...(pending.get(n) ?? [])]);
    } else {
      pending.set(n, [...(pending.get(n) ?? []), o]);
    }
  }
  return sales.filter((s): s is { paid: Paid; order: OrderEvent[] } => s !== null);
};

/** Each customer's visits (payments that still stand), oldest first. */
export const visitsFromEvents = (events: readonly SyncEvent[]): Map<string, Visit[]> => {
  const out = new Map<string, Visit[]>();
  for (const { paid } of standingSales(events)) {
    if (!isCustomerId(paid.customerId)) continue;
    const v: Visit = { saleId: paid.id, orderNumber: paid.orderNumber, at: paid.at, total: paid.total };
    const list = out.get(paid.customerId);
    if (list) list.push(v); else out.set(paid.customerId, [v]);
  }
  return out;
};

export const statsOf = (customerId: string, visits: readonly Visit[]): CustomerStats | null =>
  visits.length ? {
    customerId,
    orders: visits.length,
    spent: visits.reduce((s, v) => s + v.total, 0),
    firstVisitAt: Math.min(...visits.map((v) => v.at)),
    lastVisitAt: Math.max(...visits.map((v) => v.at)),
  } : null;

/** Total spent, order count, first and last visit, for every customer who has bought anything. */
export const customerStatsFromEvents = (events: readonly SyncEvent[]): Map<string, CustomerStats> => {
  const out = new Map<string, CustomerStats>();
  for (const [id, visits] of visitsFromEvents(events)) out.set(id, statsOf(id, visits)!);
  return out;
};

/** What one customer bought, newest first, line by line (the profile page). */
export const purchaseHistory = (events: readonly SyncEvent[], customerId: string): SaleRow[] =>
  standingSales(events)
    .filter(({ paid }) => paid.customerId === customerId)
    .map(({ paid, order }) => saleFrom(paid, order))
    .reverse();

// ----- segments -----

/**
 * One segment each, worked out when looked at (they depend on today), first match wins:
 * Inactive (no visit for `inactiveDays`, or never bought) › VIP › New › Regular.
 */
export type Segment = 'inactive' | 'vip' | 'new' | 'regular';
export const SEGMENTS: readonly Segment[] = ['new', 'regular', 'vip', 'inactive'];

export interface SegmentRules {
  /** First visit within this many days: New. */
  newDays: number;
  /** No visit for this many days (or none at all): Inactive. */
  inactiveDays: number;
  /** VIP looks at what was spent in this many days. */
  vipWindowDays: number;
  /** Spent at least this in the window: VIP. */
  vipSpent: Cents;
  /** Or among the top share of spenders in the window (0.1 = top 10%). 0: the amount alone. */
  vipTopShare: number;
}

export const DEFAULT_SEGMENT_RULES: SegmentRules = { newDays: 30, inactiveDays: 30, vipWindowDays: 90, vipSpent: 1_500_000, vipTopShare: 0.1 };

/** Why these rules cannot be kept, or null (the settings screen and the server both ask). */
export const checkSegmentRules = (v: unknown): string | null => {
  if (typeof v !== 'object' || v === null) return 'rules are missing';
  const r = v as Record<string, unknown>;
  const days = (k: string) => Number.isInteger(r[k]) && (r[k] as number) >= 1 && (r[k] as number) <= 365;
  for (const k of ['newDays', 'inactiveDays', 'vipWindowDays']) if (!days(k)) return `${k} must be 1 to 365 days`;
  if (!Number.isSafeInteger(r.vipSpent) || (r.vipSpent as number) < 0) return 'the VIP amount must be whole cents, 0 or more';
  if (typeof r.vipTopShare !== 'number' || !(r.vipTopShare >= 0 && r.vipTopShare <= 0.5)) return 'the VIP share must be 0 to 50%';
  return null;
};

/** Each customer's segment today. `customers`: the whole list (someone who never bought is Inactive). */
export const segmentsOf = (
  customers: readonly Pick<Customer, 'id'>[],
  visits: ReadonlyMap<string, readonly Visit[]>,
  rules: SegmentRules,
  now: number,
): Map<string, Segment> => {
  const out = new Map<string, Segment>();
  const windowFrom = now - rules.vipWindowDays * DAY_MS;
  const active: { id: string; first: number; windowSpent: Cents }[] = [];
  for (const { id } of customers) {
    const list = visits.get(id) ?? [];
    const last = list.length ? Math.max(...list.map((v) => v.at)) : null;
    if (last === null || now - last >= rules.inactiveDays * DAY_MS) { out.set(id, 'inactive'); continue; }
    active.push({
      id,
      first: Math.min(...list.map((v) => v.at)),
      windowSpent: list.filter((v) => v.at >= windowFrom).reduce((s, v) => s + v.total, 0),
    });
  }
  // The top share of spenders: whole customers only (rounded down), and ties at the line all in.
  const spenders = active.filter((a) => a.windowSpent > 0).sort((a, b) => b.windowSpent - a.windowSpent);
  const topCount = Math.floor(spenders.length * rules.vipTopShare);
  const topLine = topCount > 0 ? spenders[topCount - 1].windowSpent : Infinity;
  for (const a of active) {
    const vip = a.windowSpent > 0 && (a.windowSpent >= rules.vipSpent || a.windowSpent >= topLine);
    out.set(a.id, vip ? 'vip' : now - a.first < rules.newDays * DAY_MS ? 'new' : 'regular');
  }
  return out;
};

// ----- the numbers at the top of Customers -----

export interface CrmSummary {
  total: number;
  /** First bought this calendar month (Sri Lanka time); a name imported this month is not new until they buy. */
  newThisMonth: number;
  active: number;
  inactive: number;
  /** Of the customers who bought, the share who came back (0-1); null before anyone bought. */
  repeatRate: number | null;
  bySegment: Record<Segment, number>;
  /** Most spent, all time. */
  top: CustomerStats[];
}

export const crmSummary = (
  customers: readonly Pick<Customer, 'id'>[],
  visits: ReadonlyMap<string, readonly Visit[]>,
  rules: SegmentRules,
  now: number,
  topCount = 5,
): CrmSummary => {
  const segments = segmentsOf(customers, visits, rules, now);
  const bySegment: Record<Segment, number> = { new: 0, regular: 0, vip: 0, inactive: 0 };
  for (const s of segments.values()) bySegment[s]++;
  const month = lkDate(now).slice(0, 7);
  const stats = customers.map((c) => statsOf(c.id, visits.get(c.id) ?? [])).filter((s): s is CustomerStats => s !== null);
  return {
    total: customers.length,
    newThisMonth: stats.filter((s) => lkDate(s.firstVisitAt).slice(0, 7) === month).length,
    active: customers.length - bySegment.inactive,
    inactive: bySegment.inactive,
    repeatRate: stats.length ? stats.filter((s) => s.orders >= 2).length / stats.length : null,
    bySegment,
    top: [...stats].sort((a, b) => b.spent - a.spent || b.orders - a.orders).slice(0, topCount),
  };
};
