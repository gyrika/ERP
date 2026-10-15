import type { BaseUnit } from './inventoryData.ts';
import { formatQuantity } from './quantity.ts';
import type { SyncEvent } from './sync.ts';
import type { Cents } from './types.ts';

/**
 * Shelf counts (SCRUM-89). Serves the manager on count day: they record only what
 * is left; the app knows what should be left (last count + deliveries - what the
 * POS sold through the recipes) and compares. Within a small allowance it matches;
 * a bigger gap needs a reason before the item is done.
 *
 * What to count when follows the money: the items that carry most of the week's
 * spend are counted daily, the next ones weekly, the rest monthly. Nothing to set up.
 */

// ----- units: count in whatever is in your hand -----

/** A unit the manager can count in; base = how many of the item's base units (g, ml, pcs) one is. */
export interface CountUnit { id: string; label: string; base: number }

/** A unit learned for one item ("Tray = 30 pcs"), saved once with stock.unit_set. */
export interface LearnedUnit { name: string; base: number }

const BUILT_IN: Record<BaseUnit, CountUnit[]> = {
  g: [{ id: 'kg', label: 'kg', base: 1000 }, { id: 'g', label: 'g', base: 1 }],
  ml: [{ id: 'L', label: 'L', base: 1000 }, { id: 'ml', label: 'ml', base: 1 }],
  pcs: [{ id: 'pcs', label: 'pcs', base: 1 }],
  sheets: [{ id: 'sheets', label: 'sheets', base: 1 }],
};

/** Its pack ("Pack · 2 kg"), the units learned for it, then the built-in ones. */
export const unitsOf = (item: { baseUnit: BaseUnit; packQty: number; units?: readonly LearnedUnit[] }): CountUnit[] => [
  { id: 'pack', label: `Pack · ${formatQuantity(item.packQty, item.baseUnit)}`, base: item.packQty },
  ...(item.units ?? []).map((u) => ({ id: `unit:${u.name}`, label: `${u.name} · ${formatQuantity(u.base, item.baseUnit)}`, base: u.base })),
  ...BUILT_IN[item.baseUnit],
];

/** A unit id as unitsOf makes them: the pack, a built-in unit, or a learned one ("unit:Tray"). */
export const isUnitId = (u: unknown): u is string =>
  typeof u === 'string' && /^(pack|kg|g|L|ml|pcs|sheets|unit:[A-Za-z][A-Za-z ]{0,19})$/.test(u);

/**
 * What receiving this item is counted in (SCRUM-96): the owner's choice, else the pack.
 * A choice that no longer fits the item (a learned unit removed) falls back to the pack.
 */
export const receiveUnitOf = (item: { baseUnit: BaseUnit; packQty: number; units?: readonly LearnedUnit[]; receiveUnit?: string | null }): CountUnit => {
  const units = unitsOf(item);
  return units.find((u) => u.id === item.receiveUnit) ?? units[0];
};

/** So many of a unit, in packs (what the stock is kept in). */
export const toPacks = (qty: number, unit: CountUnit, packQty: number): number => (packQty > 0 ? (qty * unit.base) / packQty : 0);

/** A pack's price as the price of one of `unit`, and back (whole cents). */
export const unitPrice = (packCents: number, unit: CountUnit, packQty: number): number => Math.round((packCents * unit.base) / packQty);
export const packPrice = (unitCents: number, unit: CountUnit, packQty: number): number => Math.round((unitCents * packQty) / unit.base);

/** The unit's short name for a sentence: "pack", "kg", "Tray". */
export const unitName = (unit: CountUnit): string => (unit.id === 'pack' ? 'pack' : unit.id.startsWith('unit:') ? unit.id.slice(5) : unit.id);

/** "Tray", "Box": a short name, not a number and not one of the built-in units. */
export const checkUnitName = (name: string, item: { baseUnit: BaseUnit; units?: readonly LearnedUnit[] }): string | null => {
  const n = name.trim();
  if (!/^[A-Za-z][A-Za-z ]{0,19}$/.test(n)) return 'Type a short name, like Tray or Box.';
  const taken = [...BUILT_IN[item.baseUnit].map((u) => u.label), 'pack', ...(item.units ?? []).map((u) => u.name)];
  if (taken.some((t) => t.toLowerCase() === n.toLowerCase())) return `${n} is already there.`;
  return null;
};

/** One line of a count: so many of a unit (3 packs, ½ pack, 450 g). */
export interface CountEntry { unit: string; qty: number }

/** The shelf in base units, from the lines typed. Unknown units count nothing. */
export const countedBase = (entries: readonly CountEntry[], units: readonly CountUnit[]): number =>
  entries.reduce((sum, e) => sum + (units.find((u) => u.id === e.unit)?.base ?? 0) * e.qty, 0);

// ----- the comparison -----

/** A gap smaller than this share of what was expected, or worth less than ALLOW_CENTS, matches. */
export const ALLOW_SHARE = 0.02;
export const ALLOW_CENTS: Cents = 10_000; // Rs 100

export interface Gap {
  /** Counted minus expected, in base units: negative = short. */
  delta: number;
  /** What the gap is worth at today's price (whole cents, signed like delta). */
  valueCents: Cents;
  /** Beyond the allowance: needs a reason. */
  big: boolean;
}

export const gapOf = (expected: number, counted: number, item: { packQty: number; workingPriceCents: Cents }): Gap => {
  const delta = counted - Math.max(0, expected);
  const valueCents = Math.round((delta / item.packQty) * item.workingPriceCents);
  const share = expected > 0 ? Math.abs(delta) / expected : Math.abs(delta) > 0 ? 1 : 0;
  return { delta, valueCents, big: share > ALLOW_SHARE && Math.abs(valueCents) >= ALLOW_CENTS };
};

/** Why the shelf differs. "more" ones only when there is more than expected. */
export const GAP_REASONS = [
  { id: 'spoiled', label: 'Spoiled or expired', when: 'less' },
  { id: 'spilled', label: 'Dropped or spilled', when: 'less' },
  { id: 'staff-meal', label: 'Staff meal', when: 'less' },
  { id: 'delivery-short', label: 'Delivery was short', when: 'less' },
  { id: 'not-received', label: 'A delivery was not recorded', when: 'more' },
  { id: 'miscounted', label: 'Last count was wrong', when: 'both' },
  { id: 'unknown', label: "Don't know", when: 'both' },
] as const;
export type GapReason = (typeof GAP_REASONS)[number]['id'];
export const isGapReason = (r: unknown): r is GapReason => GAP_REASONS.some((g) => g.id === r);
export const reasonsFor = (delta: number) => GAP_REASONS.filter((r) => r.when === 'both' || r.when === (delta < 0 ? 'less' : 'more'));
export const reasonLabel = (id: string): string => GAP_REASONS.find((r) => r.id === id)?.label ?? id;

// ----- what to count when -----

export type Tier = 'daily' | 'weekly' | 'monthly';
export const TIER_DAYS: Record<Tier, number> = { daily: 1, weekly: 7, monthly: 30 };
/** Items carrying the first 70% of the week's spend: daily; up to 90%: weekly; the rest monthly. */
export const DAILY_SHARE = 0.7;
export const WEEKLY_SHARE = 0.9;

/** Before any sales: the dearest packs, this many daily and the next ones weekly. */
export const START_DAILY = 8;
export const START_WEEKLY = 12;

/**
 * Per item, from what it costs a week (price x how much the sales use). Unused items
 * are monthly. Before the first sale nothing is used yet, so the dearest packs start
 * daily and weekly; real sales take over as soon as there are any. An item the
 * owner fixed (stock.tier_set) keeps the owner's choice.
 */
export const tiersOf = (
  all: readonly { id: string; usedPerDay: number; packQty: number; workingPriceCents: Cents; tier?: Tier | null }[],
): Map<string, Tier> => {
  // The owner's choice wins; the rest are shared out among themselves.
  const tiers = new Map<string, Tier>(all.flatMap((r) => (r.tier ? [[r.id, r.tier] as const] : [])));
  const rows = all.filter((r) => !r.tier);
  const spend = rows
    .map((r) => ({ id: r.id, week: r.packQty > 0 ? (r.usedPerDay * 7 / r.packQty) * r.workingPriceCents : 0 }))
    .sort((a, b) => b.week - a.week || a.id.localeCompare(b.id));
  const total = spend.reduce((s, r) => s + r.week, 0);
  if (total <= 0) {
    [...rows].sort((a, b) => b.workingPriceCents - a.workingPriceCents || a.id.localeCompare(b.id))
      .forEach((r, i) => tiers.set(r.id, i < START_DAILY ? 'daily' : i < START_DAILY + START_WEEKLY ? 'weekly' : 'monthly'));
    return tiers;
  }
  let before = 0;
  for (const r of spend) {
    // An item belongs to the band where its spend starts, so the biggest item is always daily.
    const at = before / total;
    tiers.set(r.id, r.week <= 0 ? 'monthly' : at < DAILY_SHARE ? 'daily' : at < WEEKLY_SHARE ? 'weekly' : 'monthly');
    before += r.week;
  }
  return tiers;
};

const DAY = 24 * 60 * 60 * 1000;
const startOfDay = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

export interface DueCount {
  id: string;
  tier: Tier;
  /** never: not counted before (this count sets its starting amount). */
  state: 'never' | 'overdue' | 'due';
  lastCountedAt: number | null;
}

/**
 * Today's list: items whose tier says a count is due (a daily item not counted today,
 * a weekly one not in 7 days, a monthly one not in 30). Overdue (a full period late)
 * first, then by tier, then the ones never counted.
 */
export const countsDue = (
  rows: readonly { id: string; lastCountedAt: number | null; archived?: boolean }[],
  tiers: ReadonlyMap<string, Tier>,
  now: number,
): DueCount[] => {
  const today = startOfDay(now);
  const out: DueCount[] = [];
  for (const r of rows) {
    if (r.archived) continue;
    const tier = tiers.get(r.id) ?? 'monthly';
    if (r.lastCountedAt === null) { out.push({ id: r.id, tier, state: 'never', lastCountedAt: null }); continue; }
    const dueAt = startOfDay(r.lastCountedAt) + TIER_DAYS[tier] * DAY;
    if (dueAt > today) continue;
    out.push({ id: r.id, tier, state: dueAt + TIER_DAYS[tier] * DAY <= today ? 'overdue' : 'due', lastCountedAt: r.lastCountedAt });
  }
  const STATE: Record<DueCount['state'], number> = { overdue: 0, due: 1, never: 2 };
  const TIER: Record<Tier, number> = { daily: 0, weekly: 1, monthly: 2 };
  return out.sort((a, b) => STATE[a.state] - STATE[b.state] || TIER[a.tier] - TIER[b.tier] || a.id.localeCompare(b.id));
};

// ----- progress (the Manager page) -----

/** One standing count (undone ones left out). */
export interface CountRecord { id: string; itemId: string; at: number; big: boolean; by: string; reason: GapReason | null; valueCents: Cents }

export const countHistory = (events: readonly SyncEvent[]): CountRecord[] => {
  const undone = new Set(events.flatMap((e) => (e.type === 'stock.count_undone' ? [e.countId] : [])));
  return events.flatMap((e) => (e.type === 'stock.counted' && !undone.has(e.id)
    ? [{ id: e.id, itemId: e.itemId, at: e.at, big: e.reason !== null, by: e.actor.name, reason: e.reason, valueCents: e.valueCents }]
    : []));
};

export interface DayCell {
  /** Start of the day (local). */
  day: number;
  /** Items counted that day (each once). */
  counted: number;
  /** Of today's daily items, how many were counted that day. */
  daily: number;
  gaps: number;
  /** 0 nothing, 1 some, 2 most, 3 every daily item (the GitHub-style shade); null: a future day. */
  level: 0 | 1 | 2 | 3 | null;
}

/**
 * The progress grid, GitHub style: `weeks` columns of 7 days (Monday first), the last
 * ending this week. A day's shade is how much of the daily count was done, measured
 * against the items that are daily today (tiers follow spend, so this is the fair
 * yardstick for a manager looking back).
 */
export const dayGrid = (history: readonly CountRecord[], dailyIds: ReadonlySet<string>, now: number, weeks = 26): DayCell[] => {
  const today = startOfDay(now);
  const weekday = (new Date(today).getDay() + 6) % 7; // Monday 0
  const first = startOfDay(today - (weekday + (weeks - 1) * 7) * DAY + 12 * 3600_000);
  const byDay = new Map<number, CountRecord[]>();
  for (const c of history) {
    const d = startOfDay(c.at);
    byDay.set(d, [...(byDay.get(d) ?? []), c]);
  }
  const cells: DayCell[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const day = startOfDay(first + i * DAY + 12 * 3600_000); // noon steps survive clock changes
    const list = byDay.get(day) ?? [];
    const items = new Set(list.map((c) => c.itemId));
    const daily = [...items].filter((id) => dailyIds.has(id)).length;
    const share = dailyIds.size ? daily / dailyIds.size : items.size ? 1 : 0;
    cells.push({
      day, counted: items.size, daily, gaps: list.filter((c) => c.big).length,
      level: day > today ? null : share >= 1 ? 3 : share >= 0.5 ? 2 : items.size > 0 ? 1 : 0,
    });
  }
  return cells;
};

/** Days in a row, up to today, with every daily item counted; today still open does not break it. */
export const dailyStreak = (cells: readonly DayCell[], now: number): number => {
  const today = startOfDay(now);
  let n = 0;
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i];
    if (c.level === null) continue;
    if (c.level === 3) n++;
    else if (c.day === today) continue;
    else break;
  }
  return n;
};

/** Of these items, how many were counted since `from`. */
export const countedSince = (history: readonly CountRecord[], ids: readonly string[], from: number): number => {
  const done = new Set(history.filter((c) => c.at >= from).map((c) => c.itemId));
  return ids.filter((id) => done.has(id)).length;
};

/** Monday 00:00 of this week, and the 1st of this month. */
export const weekStart = (now: number): number => { const t = startOfDay(now); return t - ((new Date(t).getDay() + 6) % 7) * DAY; };
export const monthStart = (now: number): number => { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
export { startOfDay };
