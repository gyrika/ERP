import type { Actor } from './auth.ts';
import { withoutTestData } from './freshStart.ts';
import { isCustomerId } from './customers.ts';
import type { PaidPart } from './events.ts';
import { fmt } from './money.ts';
import type { SyncEvent } from './sync.ts';
import type { Cents, Tender } from './types.ts';

/**
 * Credit (customers who eat now and pay at the end of the month). Who: the owner decides who may,
 * and how much; the cashier closes a bill "On credit" for them and later takes the money back.
 *
 * - The owner turns credit on for a customer, with a limit or none (`credit.limit_set`, Customers).
 * - A bill closed on credit is an ordinary payment with tender `credit` and the customer's id: it is a
 *   sale on the day it was eaten, like any other, so sales never wait for the month's end.
 * - Paying back is `credit.paid`: money into the drawer (or the bank) that is NOT a sale; it pays off
 *   the oldest bills first. Undo is `credit.paid_undone`.
 *
 * What someone owes is always worked out from these events, never kept, so it works offline and the
 * counter, the owner's PC and his phone agree. Like the rest of the CRM, events name customers by id only.
 */

interface CreditBase { id: string; shopId: string; at: number; orderNumber: 0; actor: Actor }

/** Credit for one customer: `limit` in cents, or null for no limit. */
export interface CreditSetting { limit: Cents | null }

/** How money comes back for credit: never Free, a delivery app, or credit itself. */
export type CreditTender = 'cash' | 'transfer' | 'card' | 'qr';
export const CREDIT_TENDERS: readonly CreditTender[] = ['cash', 'transfer', 'card', 'qr'];

export type CreditEvent =
  /** The owner's: credit on (with its limit) or off (null); `before` is what it was, for Undo and the audit. */
  | (CreditBase & { type: 'credit.limit_set'; customerId: string; before: CreditSetting | null; after: CreditSetting | null })
  /** The customer paid back `amount` (> 0); `tendered`: what they handed over (cash: change = tendered - amount). */
  | (CreditBase & { type: 'credit.paid'; customerId: string; amount: Cents; tender: CreditTender; tendered: Cents })
  | (CreditBase & { type: 'credit.paid_undone'; paidId: string });

export const CREDIT_EVENT_TYPES = ['credit.limit_set', 'credit.paid', 'credit.paid_undone'] as const satisfies readonly CreditEvent['type'][];

/** Rs 10,00,000: higher than any tab a pizza shop would run, so a slip of the keyboard is caught. */
export const MAX_LIMIT: Cents = 100_000_000;
/** The To do speaks up when nothing was paid back for this long. */
export const OVERDUE_DAYS = 30;
/** ...and when someone has used this share of their limit. */
export const NEAR_LIMIT = 0.8;
const DAY_MS = 86_400_000;

/** Why this setting cannot be kept, or null. */
export const checkCreditSetting = (v: unknown): string | null => {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return 'credit must be on with a limit, or off';
  const s = v as Record<string, unknown>;
  if (Object.keys(s).some((k) => k !== 'limit') || !('limit' in s)) return 'credit has only a limit';
  if (s.limit === null) return null;
  if (!Number.isSafeInteger(s.limit) || (s.limit as number) <= 0) return 'the limit must be more than Rs 0, in whole cents';
  if ((s.limit as number) > MAX_LIMIT) return `the limit can be at most Rs ${fmt(MAX_LIMIT)}`;
  return null;
};

/** Why this event cannot be kept, or null (the shop server asks, server/validate.ts). */
export const checkCreditEvent = (e: Record<string, unknown>): string | null => {
  if (e.orderNumber !== 0) return 'credit is not about one order';
  if (e.type === 'credit.paid_undone') return typeof e.paidId === 'string' && e.paidId.length > 0 && e.paidId.length <= 64 ? null : 'names no payment';
  if (!isCustomerId(e.customerId)) return 'has no customer';
  if (e.type === 'credit.limit_set') return checkCreditSetting(e.before) ?? checkCreditSetting(e.after);
  if (e.type === 'credit.paid') {
    if (!CREDIT_TENDERS.includes(e.tender as CreditTender)) return 'credit is paid back in cash, by bank, card or QR';
    if (!Number.isSafeInteger(e.amount) || (e.amount as number) <= 0) return 'pays back nothing';
    if (!Number.isSafeInteger(e.tendered) || (e.tendered as number) < (e.amount as number)) return 'hands over less than it pays';
    return null;
  }
  return 'is not a credit event';
};

/** The part of a payment that went on credit: the whole bill, or a split bill's credit parts. */
export const creditShare = (p: { tender: Tender; total: Cents; parts?: readonly PaidPart[] }): Cents =>
  p.parts?.length ? p.parts.filter((x) => x.tender === 'credit').reduce((n, x) => n + x.amount, 0) : p.tender === 'credit' ? p.total : 0;

/** One bill on credit, and what is still open on it once the payments so far have paid off the oldest. */
export interface CreditBill { saleId: string; orderNumber: number; at: number; amount: Cents; open: Cents }
export interface CreditPayment { id: string; at: number; amount: Cents; tender: CreditTender; tendered: Cents; by: string }

export interface CreditAccount {
  customerId: string;
  /** null: credit is off (never turned on, or turned off). */
  setting: CreditSetting | null;
  bills: CreditBill[];
  payments: CreditPayment[];
  owes: Cents;
  /** The oldest bill not yet paid off. */
  oldestOpenAt: number | null;
  lastPaidAt: number | null;
}

const emptyAccount = (customerId: string): CreditAccount =>
  ({ customerId, setting: null, bills: [], payments: [], owes: 0, oldestOpenAt: null, lastPaidAt: null });

/**
 * Every customer's credit, from the log. A bill on credit is the payment that still stands (an
 * undone payment gives its order back, as everywhere else); a paid order changed afterwards and
 * settled on credit (SCRUM-242) changes that bill. Payments pay the oldest bills first.
 */
export const creditFromEvents = (events: readonly SyncEvent[]): Map<string, CreditAccount> => {
  const settings = new Map<string, CreditSetting | null>();
  // Per order number, its payments that still stand (newest last), with the credit bill if it is one.
  const standing = new Map<number, ({ customerId: string; bill: CreditBill } | null)[]>();
  const bills: { customerId: string; bill: CreditBill }[] = [];
  const paid = new Map<string, { customerId: string; payment: CreditPayment }>();
  for (const e of withoutTestData(events)) {
    if (e.type === 'credit.limit_set') settings.set(e.customerId, e.after);
    else if (e.type === 'credit.paid') paid.set(e.id, { customerId: e.customerId, payment: { id: e.id, at: e.at, amount: e.amount, tender: e.tender, tendered: e.tendered, by: e.actor.name } });
    else if (e.type === 'credit.paid_undone') paid.delete(e.paidId);
    else if (e.type === 'order.paid') {
      const amount = creditShare(e);
      const entry = amount > 0 && isCustomerId(e.customerId)
        ? { customerId: e.customerId, bill: { saleId: e.id, orderNumber: e.orderNumber, at: e.at, amount, open: amount } } : null;
      if (entry) bills.push(entry);
      standing.set(e.orderNumber, [...(standing.get(e.orderNumber) ?? []), entry]);
    } else if (e.type === 'order.payment_undone') {
      const undone = standing.get(e.orderNumber)?.pop();
      if (undone) bills.splice(bills.indexOf(undone), 1);
    } else if (e.type === 'order.settled' && e.tender === 'credit') {
      const latest = standing.get(e.orderNumber)?.at(-1);
      if (latest) latest.bill.amount = Math.max(0, latest.bill.amount + e.amount);
    }
  }

  const out = new Map<string, CreditAccount>();
  const of = (id: string) => out.get(id) ?? (out.set(id, emptyAccount(id)), out.get(id)!);
  for (const [id, setting] of settings) of(id).setting = setting;
  for (const { customerId, bill } of bills) of(customerId).bills.push({ ...bill, open: bill.amount });
  for (const { customerId, payment } of paid.values()) of(customerId).payments.push(payment);
  for (const a of out.values()) {
    a.bills.sort((x, y) => x.at - y.at);
    a.payments.sort((x, y) => x.at - y.at);
    let back = a.payments.reduce((n, p) => n + p.amount, 0);
    for (const b of a.bills) { const off = Math.min(b.open, back); b.open -= off; back -= off; }
    // Paid back more than was owed (a mistake, or paid in advance): what they owe goes below 0.
    a.owes = a.bills.reduce((n, b) => n + b.amount, 0) - a.payments.reduce((n, p) => n + p.amount, 0);
    a.oldestOpenAt = a.bills.find((b) => b.open > 0)?.at ?? null;
    a.lastPaidAt = a.payments.at(-1)?.at ?? null;
  }
  return out;
};

export const creditOf = (events: readonly SyncEvent[], customerId: string): CreditAccount =>
  creditFromEvents(events).get(customerId) ?? emptyAccount(customerId);

/** Can this bill go on their credit? `over`: by how much it would pass the limit. */
export type CreditCheck = { ok: true } | { ok: false; why: 'off' } | { ok: false; why: 'over'; over: Cents };

export const canTakeCredit = (a: Pick<CreditAccount, 'setting' | 'owes'>, amount: Cents): CreditCheck => {
  if (!a.setting) return { ok: false, why: 'off' };
  if (a.setting.limit === null) return { ok: true };
  const over = a.owes + amount - a.setting.limit;
  return over > 0 ? { ok: false, why: 'over', over } : { ok: true };
};

/** "Limit Rs 20,000", "No limit", "Off". */
export const settingLabel = (s: CreditSetting | null): string =>
  !s ? 'Off' : s.limit === null ? 'No limit' : `Limit Rs ${fmt(s.limit)}`;

export const daysSince = (at: number, now: number): number => Math.max(0, Math.floor((now - at) / DAY_MS));

/** Nothing paid back for OVERDUE_DAYS, counted from the last payment or else the oldest open bill. */
export const isOverdue = (a: CreditAccount, now: number): boolean => {
  if (a.owes <= 0 || a.oldestOpenAt === null) return false;
  const since = Math.max(a.lastPaidAt ?? 0, a.oldestOpenAt);
  return now - since >= OVERDUE_DAYS * DAY_MS;
};

export const nearLimit = (a: CreditAccount): boolean =>
  Boolean(a.setting && a.setting.limit !== null && a.owes > 0 && a.owes >= a.setting.limit * NEAR_LIMIT);

/** A day's credit, for the owner's Money station: put on credit, paid back (and how much of it is cash), and owed in all. */
export interface CreditDay { onCredit: Cents; paidBack: Cents; paidBackCash: Cents; owed: Cents; customersOwing: number }

export const creditDay = (events: readonly SyncEvent[], from: number, to: number): CreditDay => {
  const accounts = [...creditFromEvents(events).values()];
  const inDay = (at: number) => at >= from && at <= to;
  const payments = accounts.flatMap((a) => a.payments).filter((p) => inDay(p.at));
  const owing = accounts.filter((a) => a.owes > 0);
  return {
    onCredit: accounts.flatMap((a) => a.bills).filter((b) => inDay(b.at)).reduce((n, b) => n + b.amount, 0),
    paidBack: payments.reduce((n, p) => n + p.amount, 0),
    paidBackCash: payments.filter((p) => p.tender === 'cash').reduce((n, p) => n + p.amount, 0),
    owed: owing.reduce((n, a) => n + a.owes, 0),
    customersOwing: owing.length,
  };
};

/** One line of a customer's credit, newest first: a bill on credit, or money paid back. */
export interface StatementRow { id: string; at: number; kind: 'bill' | 'paid'; text: string; amount: Cents; owesAfter: Cents }

export const statement = (a: CreditAccount): StatementRow[] => {
  const rows = [
    ...a.bills.map((b) => ({ id: b.saleId, at: b.at, kind: 'bill' as const, text: `Order ${b.orderNumber}`, amount: b.amount })),
    ...a.payments.map((p) => ({ id: p.id, at: p.at, kind: 'paid' as const, text: `Paid back · ${TENDER_WORD[p.tender]} · ${p.by}`, amount: -p.amount })),
  ].sort((x, y) => x.at - y.at);
  let owes = 0;
  return rows.map((r) => ({ ...r, owesAfter: (owes += r.amount) })).reverse();
};

const TENDER_WORD: Record<CreditTender, string> = { cash: 'Cash', transfer: 'Bank', card: 'Card', qr: 'QR' };
