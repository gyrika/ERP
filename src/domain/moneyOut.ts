import type { Actor, Role } from './auth.ts';
import type { Cents } from './types.ts';

/**
 * Money out (SCRUM-105): electricity, gas, rent, wages and other money the shop pays, from the
 * drawer or the bank. Serves the owner, who otherwise only sees what came in, and the cashier,
 * who hands over cash and needs one quick way to say so. Pure: events in, the month out.
 *
 * Two things are kept apart so nothing is counted twice:
 * - Paying a supplier takes cash from the drawer but is not a running cost: the food is already
 *   counted when it is used (food cost). It is shown on its own, outside `costs`.
 * - Visual Flow's electricity and gas per recipe are estimates of the same money. This is the
 *   real bill; it is never added on top of them.
 */
export type MoneyWhat = 'electricity' | 'gas' | 'water' | 'rent' | 'wages' | 'supplier' | 'other';
export type MoneyFrom = 'drawer' | 'bank';
/** A calendar month, "2026-10". */
export type MonthKey = string;

export const MONEY_WHATS: readonly MoneyWhat[] = ['electricity', 'gas', 'water', 'rent', 'wages', 'supplier', 'other'];
export const MONEY_LABEL: Record<MoneyWhat, string> = {
  electricity: 'Electricity', gas: 'Gas', water: 'Water', rent: 'Rent', wages: 'Wages', supplier: 'Supplier', other: 'Other',
};
export const FROM_LABEL: Record<MoneyFrom, string> = { drawer: 'Drawer', bank: 'Bank' };

/** Bills that belong to a month, whenever they are paid. */
const MONTHLY: ReadonlySet<MoneyWhat> = new Set(['electricity', 'water', 'rent', 'wages']);
export const isMonthly = (what: MoneyWhat): boolean => MONTHLY.has(what);

/** What a cashier may record: cash from the drawer, but not rent or wages (a manager's or the owner's). */
const CASHIER_WHATS: ReadonlySet<MoneyWhat> = new Set(['electricity', 'gas', 'water', 'supplier', 'other']);
export const cashierWhats: readonly MoneyWhat[] = MONEY_WHATS.filter((w) => CASHIER_WHATS.has(w));
export const mayPayOut = (role: Role, what: MoneyWhat, from: MoneyFrom): boolean =>
  role === 'manager' || role === 'owner' || (role === 'cashier' && from === 'drawer' && CASHIER_WHATS.has(what));

interface MoneyBase { id: string; shopId: string; at: number; orderNumber: 0; actor: Actor }
export type MoneyEvent =
  /**
   * note: what it was (Other), or the supplier's name when paid, for history.
   * month: the month a bill belongs to; missing: the month it was paid.
   */
  | (MoneyBase & { type: 'money.out'; what: MoneyWhat; from: MoneyFrom; cents: Cents; note?: string; supplierId?: string; month?: MonthKey })
  /** Taken back: the quick Undo, or a manager removing a mistake. A cashier reaches only their own. */
  | (MoneyBase & { type: 'money.out_undone'; outId: string })
  /** Undo of that removal. */
  | (MoneyBase & { type: 'money.out_restored'; outId: string });

export const MONEY_EVENT_TYPES = ['money.out', 'money.out_undone', 'money.out_restored'] as const satisfies readonly MoneyEvent['type'][];

export const MAX_MONEY_OUT: Cents = 10_000_000_00;
const MAX_NOTE = 120;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface MoneyOutInput { what?: unknown; from?: unknown; cents?: unknown; note?: unknown; supplierId?: unknown; month?: unknown }

/** Null when it can be recorded, else what is missing (the screen says it; the server checks the same). */
export const checkMoneyOut = ({ what, from, cents, note, supplierId, month }: MoneyOutInput): string | null => {
  if (!MONEY_WHATS.includes(what as MoneyWhat)) return 'Choose what it was for';
  if (!Number.isSafeInteger(cents) || (cents as number) <= 0) return 'Type the amount';
  if ((cents as number) > MAX_MONEY_OUT) return 'That amount is too big';
  if (from !== 'drawer' && from !== 'bank') return 'Choose where it was paid from';
  if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE)) return `A note of at most ${MAX_NOTE} letters`;
  if (what === 'other' && (typeof note !== 'string' || !note.trim())) return 'Say what it was';
  if (what === 'supplier' && (typeof supplierId !== 'string' || !supplierId || supplierId.length > 64)) return 'Choose the supplier';
  if (what !== 'supplier' && supplierId !== undefined) return 'Only a supplier payment names a supplier';
  if (month !== undefined && (!isMonthly(what as MoneyWhat) || typeof month !== 'string' || !MONTH.test(month))) return 'Choose the month';
  return null;
};

const pad = (n: number) => String(n).padStart(2, '0');
/** The month a moment falls in, on the shop's clock. */
export const monthOf = (at: number): MonthKey => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
export const shiftMonth = (month: MonthKey, by: number): MonthKey => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
export const monthLabel = (month: MonthKey): string => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
};
/** A meter bill arrives after its month; rent and wages are for the month they are paid in. */
export const defaultMonth = (what: MoneyWhat, now: number): MonthKey =>
  what === 'electricity' || what === 'water' ? shiftMonth(monthOf(now), -1) : monthOf(now);

export interface MoneyOut {
  id: string; at: number; actor: Actor; what: MoneyWhat; from: MoneyFrom; cents: Cents; note?: string; supplierId?: string;
  /** The month it counts in. */
  month: MonthKey;
}

/**
 * What is still recorded, in the order it was paid. A removal by a cashier counts only on their
 * own entry: the server cannot look that up when it accepts the event, so the record itself holds to it.
 */
export const moneyOutFromEvents = (events: readonly { type: string }[]): MoneyOut[] => {
  const all = new Map<string, MoneyOut>();
  const removed = new Set<string>();
  for (const raw of events) {
    if (!raw.type.startsWith('money.')) continue;
    const e = raw as MoneyEvent;
    if (e.type === 'money.out') {
      all.set(e.id, {
        id: e.id, at: e.at, actor: e.actor, what: e.what, from: e.from, cents: e.cents, month: e.month ?? monthOf(e.at),
        ...(e.note ? { note: e.note } : {}), ...(e.supplierId ? { supplierId: e.supplierId } : {}),
      });
      continue;
    }
    const target = all.get(e.outId);
    if (!target || (e.actor.role === 'cashier' && e.actor.id !== target.actor.id)) continue;
    if (e.type === 'money.out_undone') removed.add(e.outId); else removed.delete(e.outId);
  }
  return [...all.values()].filter((o) => !removed.has(o.id)).sort((a, b) => a.at - b.at);
};

export interface MoneyMonth {
  /** Running costs: bills and other money spent, without supplier payments. */
  costs: Cents;
  /** Each kind of running cost, biggest first; none for a kind with nothing in it. */
  byWhat: { what: MoneyWhat; cents: Cents }[];
  /** Paid to suppliers; already in food cost, so outside `costs`. */
  suppliers: Cents;
  /** Everything of the month, newest first. */
  entries: MoneyOut[];
}

export const moneyMonth = (all: readonly MoneyOut[], month: MonthKey): MoneyMonth => {
  const entries = all.filter((o) => o.month === month).reverse();
  const sums = new Map<MoneyWhat, Cents>();
  let suppliers = 0;
  for (const o of entries) {
    if (o.what === 'supplier') suppliers += o.cents;
    else sums.set(o.what, (sums.get(o.what) ?? 0) + o.cents);
  }
  const byWhat = [...sums].map(([what, cents]) => ({ what, cents })).sort((a, b) => b.cents - a.cents);
  return { costs: byWhat.reduce((n, w) => n + w.cents, 0), byWhat, suppliers, entries };
};

/** Cash that left the drawer today, supplier payments included: what the day close must allow for (SCRUM-104). */
export const drawerOutToday = (all: readonly MoneyOut[], now: number): Cents => {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  return all.filter((o) => o.from === 'drawer' && o.at >= start.getTime() && o.at <= now).reduce((n, o) => n + o.cents, 0);
};
