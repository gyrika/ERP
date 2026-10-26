import { answersFromEvents, batchMakes, ownPreps, kitchenLine, recipeUnit, type Answer, type RecipeEvent } from './costing.ts';
import { bookUsage, wasteUsage, type RecipeLine } from './stockUsage.ts';
import { lineItemName } from './halves.ts';
import type { SyncEvent } from './sync.ts';
import type { InventoryItem } from './inventoryData.ts';
import { PREPS } from './recipeBook.ts';
import { prepTracker } from './prep.ts';
import type { MenuItem, SizeId } from './types.ts';

/**
 * Waste (manager mode, the bin): anything thrown away instead of sold. A finished dish,
 * a semi-processed item (dough, sauce, his own items) or a raw item from the price list.
 * Stock only counts raw items, so a waste takes from them the way a sale does: a dish
 * through its recipe, a semi-processed item through its batch, a raw item directly
 * (stockUsage.ts: wasteUsage). One audited event, `stock.wasted`; Undo writes `stock.waste_undone`.
 */
export type WasteWhat =
  | { kind: 'dish'; itemId: string; size?: SizeId }
  /** A sheet batch by name, or his own item as `kitchen:<id>`; qty in `unit`. */
  | { kind: 'prep'; name: string; unit: string }
  /** A price-list item; qty in its base unit. */
  | { kind: 'stock'; itemId: string };

export const WASTE_REASONS = [
  { id: 'burnt', label: 'Burnt' },
  { id: 'dropped', label: 'Dropped' },
  { id: 'expired', label: 'Expired' },
  { id: 'wrong', label: 'Made wrong' },
  { id: 'returned', label: 'Sent back' },
  { id: 'other', label: 'Other' },
] as const;
/** The bin's reasons, and 'cancelled': a dish made, then cancelled by a manager (SCRUM-176), never chosen in the bin. */
export type WasteReason = (typeof WASTE_REASONS)[number]['id'] | 'cancelled';
/** A reason the bin may record (not 'cancelled', which only a cancel makes). */
export const isWasteReason = (r: unknown): r is WasteReason => WASTE_REASONS.some((w) => w.id === r);
export const wasteReasonLabel = (id: string): string => (id === 'cancelled' ? 'Made, then cancelled' : WASTE_REASONS.find((r) => r.id === id)?.label ?? id);

export const MAX_WASTE_QTY = 1e6;

/** One row of the bin's list. */
export interface WasteChoice {
  key: string;
  group: 'Finished' | 'Semi-processed' | 'Raw';
  name: string;
  what: WasteWhat;
  /** What the quantity is counted in: 'pcs' for a dish. */
  unit: string;
}

/**
 * Everything that can be wasted: menu dishes (one row per size), then semi-processed
 * items (his own, then his sheet's batches), then the price list.
 */
export const wasteChoices = (
  menu: readonly MenuItem[], answers: ReadonlyMap<string, Answer>, items: readonly Pick<InventoryItem, 'id' | 'name' | 'baseUnit'>[],
): WasteChoice[] => [
  ...menu.flatMap((m): WasteChoice[] => (m.variants?.length
    ? m.variants.map((v) => ({ key: `dish:${m.id}:${v.id}`, group: 'Finished', name: `${m.name.en} · ${v.label}`, what: { kind: 'dish', itemId: m.id, size: v.id }, unit: 'pcs' }))
    : [{ key: `dish:${m.id}`, group: 'Finished', name: m.name.en, what: { kind: 'dish', itemId: m.id }, unit: 'pcs' }])),
  ...ownPreps(answers).map((p): WasteChoice => ({
    key: `prep:${p.id}`, group: 'Semi-processed', name: p.name, what: { kind: 'prep', name: kitchenLine(p.id), unit: p.makes.unit }, unit: p.makes.unit,
  })),
  ...Object.keys(PREPS).sort((a, b) => a.localeCompare(b)).map((name): WasteChoice => {
    const unit = PREPS[name].makes?.unit ?? batchMakes(name, recipeUnit(name) ?? 'pcs', answers)?.unit ?? recipeUnit(name) ?? 'pcs';
    return { key: `prep:${name}`, group: 'Semi-processed', name, what: { kind: 'prep', name, unit }, unit };
  }),
  ...items.map((i): WasteChoice => ({ key: `stock:${i.id}`, group: 'Raw', name: i.name, what: { kind: 'stock', itemId: i.id }, unit: i.baseUnit })),
];

/** Matches every word typed, in any order: "chick l" finds "Devilled Chicken · Large". */
export const matchesWaste = (choice: Pick<WasteChoice, 'name' | 'group'>, query: string): boolean => {
  const hay = `${choice.name} ${choice.group}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

/** Why a waste cannot be recorded, or null. */
export const checkWaste = (what: unknown, qty: unknown, reason: unknown, note?: unknown, name?: unknown): string | null => {
  if (!(typeof name === 'string' && name.length > 0 && name.length <= 120)) return 'Choose what was thrown away';
  if (typeof what !== 'object' || what === null) return 'Choose what was thrown away';
  const w = what as Record<string, unknown>;
  const id = (v: unknown, max = 120) => typeof v === 'string' && v.length > 0 && v.length <= max;
  const ok = (w.kind === 'dish' && id(w.itemId, 64) && (w.size === undefined || ['S', 'M', 'L'].includes(String(w.size))))
    || (w.kind === 'prep' && id(w.name) && id(w.unit, 16))
    || (w.kind === 'stock' && id(w.itemId, 64));
  if (!ok) return 'Choose what was thrown away';
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0 || qty > MAX_WASTE_QTY) return 'Enter how much';
  if (w.kind === 'dish' && !Number.isInteger(qty)) return 'Dishes are whole';
  if (!isWasteReason(reason)) return 'Choose a reason';
  if (note !== undefined && !(typeof note === 'string' && note.length <= 200)) return 'Note is too long';
  if (reason === 'other' && !(typeof note === 'string' && note.trim())) return 'Say what happened';
  return null;
};

/** One waste still standing (not undone), with what it took from each raw item. */
export interface WasteRecord {
  id: string;
  at: number;
  by: string;
  what: WasteWhat;
  name: string;
  qty: number;
  unit: string;
  reason: WasteReason;
  note?: string;
  takes: RecipeLine[];
}

const unitOf = (w: WasteWhat, items: ReadonlyMap<string, string>) =>
  w.kind === 'dish' ? 'pcs' : w.kind === 'prep' ? w.unit : items.get(w.itemId) ?? '';

/**
 * Every waste still standing, oldest first, each traced with his recipe answers as they were
 * when it was thrown away (as stock does), so the bin's history and each item's history agree.
 */
export const wasteRecords = (events: readonly SyncEvent[], items: readonly Pick<InventoryItem, 'id' | 'baseUnit'>[] = []): WasteRecord[] => {
  const units = new Map(items.map((i) => [i.id, i.baseUnit as string]));
  const recipe: RecipeEvent[] = [];
  let answers = new Map<string, Answer>();
  const out = new Map<string, WasteRecord>();
  // Semi-processed items with batches standing take from their own stock, as in inventory.ts.
  const batches = prepTracker();
  const tracked = batches.tracked;
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    batches.step(e);
    if (e.type === 'recipe.answer_set') { recipe.push(e); answers = answersFromEvents(recipe); }
    else if (e.type === 'stock.wasted' && !out.has(e.id)) {
      out.set(e.id, {
        id: e.id, at: e.at, by: e.actor.name, what: e.what, name: e.name, qty: e.qty, unit: unitOf(e.what, units),
        reason: e.reason, ...(e.note ? { note: e.note } : {}), takes: wasteUsage(e.what, e.qty, answers, tracked),
      });
    } else if (e.type === 'stock.waste_undone') out.delete(e.wasteId);
    // A dish made, then cancelled (SCRUM-176): it took what a sale takes, and that is its waste.
    else if (e.type === 'order.item_cancelled' && e.made && !out.has(e.id)) {
      out.set(e.id, {
        id: e.id, at: e.at, by: e.actor.name, what: { kind: 'dish', itemId: e.before.itemId, ...(e.before.size ? { size: e.before.size } : {}) },
        name: lineItemName(e.before), qty: e.before.qty, unit: 'pcs', reason: 'cancelled', ...(e.reason ? { note: e.reason } : {}),
        takes: bookUsage(e.before, answers, tracked),
      });
    } else if (e.type === 'order.change_undone') out.delete(e.undoneEventId);
  }
  return [...out.values()];
};
