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
 *   real bill: it replaces them there (billShare.ts), never adds on top of them.
 */
export type MoneyWhat = 'electricity' | 'gas' | 'water' | 'rent' | 'wages' | 'supplier' | 'other';
export type MoneyFrom = 'drawer' | 'bank';
/** A calendar month, "2026-10". */
export type MonthKey = string;

export const MONEY_WHATS: readonly MoneyWhat[] = ['electricity', 'gas', 'water', 'rent', 'wages', 'supplier', 'other'];
/** Paid for one of a short list the shop keeps: which gas cylinder, which rent. */
export type ChoiceWhat = 'gas' | 'rent';
export const isChoiceWhat = (what: unknown): what is ChoiceWhat => what === 'gas' || what === 'rent';
export interface MoneyChoice { id: string; label: string }
export type MoneyChoices = Record<ChoiceWhat, MoneyChoice[]>;
/** The owner's three cylinder sizes, and his two rooms and one land (2026-11-02). He renames them. */
export const DEFAULT_CHOICES: MoneyChoices = {
  gas: [{ id: 'gas-2.5', label: '2.5kg' }, { id: 'gas-5', label: '5kg' }, { id: 'gas-12.5', label: '12.5kg' }],
  rent: [{ id: 'rent-room-1', label: 'Room 1' }, { id: 'rent-room-2', label: 'Room 2' }, { id: 'rent-land', label: 'Land' }],
};
export const CHOICE_ASK: Record<ChoiceWhat, { title: string; none: string; edit: string; add: string }> = {
  gas: { title: 'Which size', none: 'Choose the size', edit: 'Edit sizes', add: 'Add a size' },
  rent: { title: 'Which rent', none: 'Choose which rent', edit: 'Edit rents', add: 'Add a rent' },
};
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
   * choiceId: which cylinder or rent, with its name then in note, so renaming it later leaves history alone.
   * qty: how many cylinders; missing: one. grnIds: the deliveries a supplier payment is for.
   */
  | (MoneyBase & {
    type: 'money.out'; what: MoneyWhat; from: MoneyFrom; cents: Cents; note?: string; supplierId?: string; month?: MonthKey;
    choiceId?: string; qty?: number; grnIds?: string[];
  })
  /** Taken back: the quick Undo, or a manager removing a mistake. A cashier reaches only their own. */
  | (MoneyBase & { type: 'money.out_undone'; outId: string })
  /** Undo of that removal. */
  | (MoneyBase & { type: 'money.out_restored'; outId: string })
  /** The owner takes a GRN off the unpaid list (paid long ago, or not owed): its stock and record stay. */
  | (MoneyBase & { type: 'money.grn_removed' | 'money.grn_restored'; grnId: string })
  /** The whole list of cylinder sizes or rents, as a manager or the owner left it. */
  | (MoneyBase & { type: 'money.choices_set'; what: ChoiceWhat; choices: MoneyChoice[] });

export const MONEY_EVENT_TYPES = ['money.out', 'money.out_undone', 'money.out_restored', 'money.choices_set', 'money.grn_removed', 'money.grn_restored'] as const satisfies readonly MoneyEvent['type'][];

export const MAX_MONEY_OUT: Cents = 10_000_000_00;
const MAX_NOTE = 120;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const MAX_QTY = 99;
const MAX_GRNS = 50;
const shortId = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 64;

export interface MoneyOutInput {
  what?: unknown; from?: unknown; cents?: unknown; note?: unknown; supplierId?: unknown; month?: unknown;
  choiceId?: unknown; qty?: unknown; grnIds?: unknown;
}

/** Null when it can be recorded, else what is missing (the screen says it; the server checks the same). */
export const checkMoneyOut = ({ what, from, cents, note, supplierId, month, choiceId, qty, grnIds }: MoneyOutInput): string | null => {
  if (!MONEY_WHATS.includes(what as MoneyWhat)) return 'Choose what it was for';
  if (!Number.isSafeInteger(cents) || (cents as number) <= 0) return 'Type the amount';
  if ((cents as number) > MAX_MONEY_OUT) return 'That amount is too big';
  if (from !== 'drawer' && from !== 'bank') return 'Choose where it was paid from';
  if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE)) return `A note of at most ${MAX_NOTE} letters`;
  if (what === 'other' && (typeof note !== 'string' || !note.trim())) return 'Say what it was';
  if (what === 'supplier' && (typeof supplierId !== 'string' || !supplierId || supplierId.length > 64)) return 'Choose the supplier';
  if (what !== 'supplier' && supplierId !== undefined) return 'Only a supplier payment names a supplier';
  if (month !== undefined && (!isMonthly(what as MoneyWhat) || typeof month !== 'string' || !MONTH.test(month))) return 'Choose the month';
  if (choiceId !== undefined && (!isChoiceWhat(what) || !shortId(choiceId))) return 'Only gas and rent have a choice';
  if (qty !== undefined && (what !== 'gas' || !Number.isSafeInteger(qty) || (qty as number) < 1 || (qty as number) > MAX_QTY)) return 'Type how many';
  if (grnIds !== undefined && (what !== 'supplier' || !Array.isArray(grnIds) || grnIds.length > MAX_GRNS || !grnIds.every(shortId))) return 'Choose the deliveries';
  return null;
};

/** The screen asks for the size or the rent; the server cannot, since entries from before it have none. */
export const checkChoiceChosen = (what: unknown, choiceId: unknown): string | null =>
  isChoiceWhat(what) && !choiceId ? CHOICE_ASK[what].none : null;

const MAX_CHOICES = 12;
const MAX_LABEL = 40;
/** Null when the list can be kept, else what is wrong with it. */
export const checkChoices = (what: unknown, choices: unknown): string | null => {
  if (!isChoiceWhat(what)) return 'Choose gas or rent';
  if (!Array.isArray(choices) || choices.length < 1) return 'Keep at least one';
  if (choices.length > MAX_CHOICES) return `At most ${MAX_CHOICES}`;
  const ok = (c: unknown) => {
    const { id, label } = (c ?? {}) as { id?: unknown; label?: unknown };
    return shortId(id) && typeof label === 'string' && label.trim() !== '' && label.length <= MAX_LABEL;
  };
  if (!choices.every(ok)) return 'Give each one a name';
  const names = (choices as MoneyChoice[]).map((c) => c.label.trim().toLowerCase());
  if (new Set(names).size !== names.length) return 'Two have the same name';
  if (new Set((choices as MoneyChoice[]).map((c) => c.id)).size !== choices.length) return 'Two are the same';
  return null;
};

/** The GRNs the owner took off the unpaid list, as things stand. */
export const removedGrns = (events: readonly { type: string }[]): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const raw of events) {
    if (raw.type !== 'money.grn_removed' && raw.type !== 'money.grn_restored') continue;
    const e = raw as Extract<MoneyEvent, { type: 'money.grn_removed' | 'money.grn_restored' }>;
    if (e.actor.role !== 'owner') continue;
    if (e.type === 'money.grn_removed') out.add(e.grnId); else out.delete(e.grnId);
  }
  return out;
};

/** The lists as they stand: the latest of each, else the owner's defaults. */
export const moneyChoices = (events: readonly { type: string }[]): MoneyChoices => {
  const out: MoneyChoices = { ...DEFAULT_CHOICES };
  for (const raw of events) {
    if (raw.type !== 'money.choices_set') continue;
    const e = raw as Extract<MoneyEvent, { type: 'money.choices_set' }>;
    out[e.what] = e.choices;
  }
  return out;
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
  choiceId?: string; qty?: number; grnIds?: string[];
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
    if (raw.type !== 'money.out' && raw.type !== 'money.out_undone' && raw.type !== 'money.out_restored') continue;
    const e = raw as Extract<MoneyEvent, { type: 'money.out' | 'money.out_undone' | 'money.out_restored' }>;
    if (e.type === 'money.out') {
      all.set(e.id, {
        id: e.id, at: e.at, actor: e.actor, what: e.what, from: e.from, cents: e.cents, month: e.month ?? monthOf(e.at),
        ...(e.note ? { note: e.note } : {}), ...(e.supplierId ? { supplierId: e.supplierId } : {}),
        ...(e.choiceId ? { choiceId: e.choiceId } : {}), ...(e.qty ? { qty: e.qty } : {}), ...(e.grnIds?.length ? { grnIds: e.grnIds } : {}),
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
  /** Gas by size and rent by place, biggest first: what was named when paid. */
  parts: Record<ChoiceWhat, { label: string; cents: Cents; qty: number }[]>;
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
  const partsOf = (what: ChoiceWhat) => {
    const groups = new Map<string, { label: string; cents: Cents; qty: number }>();
    for (const o of entries) {
      if (o.what !== what) continue;
      const key = o.choiceId ?? '';
      const g = groups.get(key) ?? { label: o.note ?? 'Not said', cents: 0, qty: 0 };
      groups.set(key, { ...g, cents: g.cents + o.cents, qty: g.qty + (o.qty ?? 1) });
    }
    return [...groups.values()].sort((a, b) => b.cents - a.cents);
  };
  return { costs: byWhat.reduce((n, w) => n + w.cents, 0), byWhat, parts: { gas: partsOf('gas'), rent: partsOf('rent') }, suppliers, entries };
};

/** What one of them last cost, each: fills in the amount, which stays editable. Null: never paid. */
export const lastPaidEach = (all: readonly MoneyOut[], choiceId: string): Cents | null => {
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].choiceId === choiceId) return Math.round(all[i].cents / (all[i].qty ?? 1));
  }
  return null;
};

export interface RentRow { id: string; label: string; cents: Cents }
/**
 * Every rent for a month: the shop's list, paid or not (0), then anything paid that is no longer on
 * the list, so the rows always add up to what the month says for rent.
 */
export const rentRows = (all: readonly MoneyOut[], choices: readonly MoneyChoice[], month: MonthKey): RentRow[] => {
  const rows = new Map<string, RentRow>(choices.map((c) => [c.id, { id: c.id, label: c.label, cents: 0 }]));
  for (const o of all) {
    if (o.what !== 'rent' || o.month !== month) continue;
    const id = o.choiceId ?? '';
    const row = rows.get(id) ?? { id, label: o.note ?? 'Not said', cents: 0 };
    rows.set(id, { ...row, cents: row.cents + o.cents });
  }
  return [...rows.values()];
};

/** The rents paid for a month, so nobody pays one twice or misses one. */
export const rentsPaid = (all: readonly MoneyOut[], month: MonthKey): ReadonlySet<string> =>
  new Set(all.filter((o) => o.what === 'rent' && o.month === month && o.choiceId).map((o) => o.choiceId as string));

/** Cash that left the drawer today, supplier payments included: what the day close must allow for (SCRUM-104). */
export const drawerOutToday = (all: readonly MoneyOut[], now: number): Cents => {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  return all.filter((o) => o.from === 'drawer' && o.at >= start.getTime() && o.at <= now).reduce((n, o) => n + o.cents, 0);
};
