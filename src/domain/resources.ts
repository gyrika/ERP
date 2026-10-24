import type { Cents } from './types.ts';

/**
 * What a recipe costs besides its ingredients (Visual Flow): the electricity, labour and equipment
 * one batch (or one dish) takes, and any other cost of making it (gas, a box). The owner says how
 * much each recipe takes; the shop's rates (Rs per kWh, per hour) are set once, so a new tariff
 * changes every recipe at once. Both are answers like his recipes (costing.ts): audited, synced,
 * drafted and published the same way. Food cost (costing.ts) stays ingredients only.
 */
export type ResourceKind = 'electricity' | 'labour' | 'equipment' | 'other';
export const RESOURCE_KINDS: readonly ResourceKind[] = ['electricity', 'labour', 'equipment', 'other'];

/**
 * One cost of making a recipe, per batch (or per dish).
 * electricity: kWh; labour and equipment: minutes; other: `cents` straight (no rate).
 * label: what it is ("Oven", "Mixer", "Gas"), optional.
 */
export type ResourceLine =
  | { kind: 'electricity' | 'labour' | 'equipment'; qty: number; label?: string }
  | { kind: 'other'; cents: Cents; label?: string };

/** The shop's rates, in cents: per kWh, per hour of labour, per hour of equipment. */
export interface Rates { electricity: Cents; labour: Cents; equipment: Cents }

export const RESOURCE_UNIT: Record<ResourceKind, string> = { electricity: 'kWh', labour: 'min', equipment: 'min', other: 'Rs' };
export const RESOURCE_LABEL: Record<ResourceKind, string> = { electricity: 'Electricity', labour: 'Labour', equipment: 'Equipment', other: 'Other costs' };

export const MAX_RESOURCE_LINES = 12;
const MAX_LABEL = 40;
const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const cents = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;

/** Null when every resource line is well formed (the server checks the same). */
export const checkResourceLines = (lines: unknown): string | null => {
  if (!Array.isArray(lines)) return 'Add what it takes.';
  if (lines.length > MAX_RESOURCE_LINES) return `At most ${MAX_RESOURCE_LINES} costs.`;
  for (const l of lines as ResourceLine[]) {
    if (typeof l !== 'object' || l === null || !RESOURCE_KINDS.includes(l.kind)) return 'Choose what each cost is.';
    if (l.label !== undefined && (typeof l.label !== 'string' || l.label.length > MAX_LABEL)) return `A name of at most ${MAX_LABEL} letters.`;
    if (l.kind === 'other' ? !cents(l.cents) || l.cents > 100_000_00 : !positive(l.qty) || l.qty > 100_000) {
      return `Type how much ${RESOURCE_LABEL[l.kind].toLowerCase()} it takes.`;
    }
  }
  return null;
};

export const checkRates = (r: unknown): string | null => {
  if (typeof r !== 'object' || r === null) return 'Type the rates.';
  const rates = r as Rates;
  return cents(rates.electricity) && cents(rates.labour) && cents(rates.equipment) ? null : 'Type each rate in rupees.';
};

/**
 * The unrounded cost of some resource lines, and whether a rate they need is still unset
 * (an unset rate costs nothing, and the recipe's cost is "so far").
 */
export const resourceCost = (lines: readonly ResourceLine[], rates: Rates | null): { byKind: Record<ResourceKind, number>; unrated: boolean } => {
  const byKind: Record<ResourceKind, number> = { electricity: 0, labour: 0, equipment: 0, other: 0 };
  let unrated = false;
  for (const l of lines) {
    if (l.kind === 'other') { byKind.other += l.cents; continue; }
    const rate = rates?.[l.kind] ?? 0;
    if (!rate) { unrated = true; continue; }
    // Labour and equipment rates are per hour; their lines are in minutes.
    byKind[l.kind] += l.kind === 'electricity' ? l.qty * rate : (l.qty / 60) * rate;
  }
  return { byKind, unrated };
};
