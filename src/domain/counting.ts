import type { BaseUnit } from './inventoryData.ts';
import { formatQuantity } from './quantity.ts';
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

/** Per item, from what it costs a week (price x how much the sales use). Unused items are monthly. */
export const tiersOf = (rows: readonly { id: string; usedPerDay: number; packQty: number; workingPriceCents: Cents }[]): Map<string, Tier> => {
  const spend = rows
    .map((r) => ({ id: r.id, week: r.packQty > 0 ? (r.usedPerDay * 7 / r.packQty) * r.workingPriceCents : 0 }))
    .sort((a, b) => b.week - a.week || a.id.localeCompare(b.id));
  const total = spend.reduce((s, r) => s + r.week, 0);
  const tiers = new Map<string, Tier>();
  let before = 0;
  for (const r of spend) {
    // An item belongs to the band where its spend starts, so the biggest item is always daily.
    const at = total > 0 ? before / total : 1;
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
