import type { BaseUnit, InventoryItem, Supplier } from './inventoryData.ts';
import type { SyncEvent } from './sync.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from './inventoryData.ts';
import { answersFromEvents, type Answer, type RecipeEvent } from './costing.ts';
import { bookGaps, bookUsage, type GapsOf, type RecipeLine, type UsageOf } from './stockUsage.ts';
import type { LearnedUnit, Tier } from './counting.ts';
import { suggestions } from './ordering.ts';
import { onOrder, purchasesFromEvents } from './purchaseOrders.ts';
import { stockSettingsFromEvents, type StockSettings } from './stockSettings.ts';

const BASE_UNITS: BaseUnit[] = ['g', 'ml', 'pcs', 'sheets'];

export const supplierById = (id: string): Supplier | undefined =>
  SEED_SUPPLIERS.find((s) => s.id === id);

export const itemById = (id: string): InventoryItem | undefined =>
  SEED_INVENTORY.find((i) => i.id === id);

export type SeedData = { suppliers: Supplier[]; items: InventoryItem[] };

/** Pure validation for seed or persisted inventory rows. */
export const validateSeed = (data: SeedData): string[] => {
  const errors: string[] = [];
  const supplierIds = new Set<string>();
  for (const s of data.suppliers) {
    if (!s.id.trim()) errors.push('supplier missing id');
    if (!s.name.trim()) errors.push(`supplier ${s.id}: missing name`);
    if (s.phone !== undefined && (typeof s.phone !== 'string' || !s.phone.trim())) {
      errors.push(`supplier ${s.id}: invalid phone`);
    }
    if (supplierIds.has(s.id)) errors.push(`duplicate supplier id: ${s.id}`);
    supplierIds.add(s.id);
  }

  const itemIds = new Set<string>();
  for (const i of data.items) {
    if (!i.id.trim()) errors.push('item missing id');
    if (itemIds.has(i.id)) errors.push(`duplicate item id: ${i.id}`);
    itemIds.add(i.id);
    if (!i.name.trim()) errors.push(`${i.id}: missing name`);
    if (!i.category.trim()) errors.push(`${i.id}: missing category`);
    if (!BASE_UNITS.includes(i.baseUnit)) errors.push(`${i.id}: invalid baseUnit ${i.baseUnit}`);
    if (!(i.packQty > 0 && Number.isFinite(i.packQty))) errors.push(`${i.id}: invalid packQty`);
    if (!Number.isInteger(i.workingPriceCents) || i.workingPriceCents < 0) {
      errors.push(`${i.id}: workingPriceCents must be a non-negative integer`);
    }
    if (!i.supplierIds.length) errors.push(`${i.id}: must have at least one supplier`);
    if (new Set(i.supplierIds).size !== i.supplierIds.length) {
      errors.push(`${i.id}: duplicate supplier id`);
    }
    for (const supplierId of i.supplierIds) {
      if (!supplierIds.has(supplierId)) errors.push(`${i.id}: unknown supplier ${supplierId}`);
    }
  }

  const normalizedNames = data.suppliers.map((s) => s.name.trim().toLowerCase());
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    errors.push('duplicate supplier names (normalized)');
  }

  return errors;
};

const readStorageArray = <T>(key: string): T[] => {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

/** First launch returns seed; never overwrites non-empty stored data. */
export const loadSeed = <T>(
  key: string,
  seed: T[],
  read: (storageKey: string) => T[] = readStorageArray,
): T[] => {
  const existing = read(key);
  return existing.length > 0 ? existing : seed;
};

/**
 * A stock row: the price-list item plus what is on the shelf. onHandBaseUnits is
 * exact (g, ml, pcs, sheets) and can go below zero when more was sold than was
 * recorded; onHandPacks is the same amount in purchasing packs, never below zero,
 * for showing (2000 g of a 2 kg block = 1 pack, 1500 g = 0.75).
 */
export type InventoryRow = InventoryItem & {
  onHandPacks: number;
  onHandBaseUnits: number;
  archived: boolean;
  /** Someone has recorded stock for it. A never-counted item is unknown, not empty. */
  counted: boolean;
  /** Base units sales took per day, over the last `usageDays` (stockSettings). */
  usedPerDay: number;
  /** Days what is left lasts at that rate; null when it is not counted, empty or not used. */
  lastsDays: number | null;
  /**
   * Items sold since its last count that should have taken some of it but could not
   * (a batch output the owner has not confirmed): the shelf holds less than shown.
   */
  missedSales: number;
  /** Packs to order now (`suggestions`, the one reorder rule); 0: not needed. This is what Low means. */
  suggestedPacks: number;
  suggestedSupplierId: string | null;
  /** When it was last counted (a shelf count or an older audit), or null. */
  lastCountedAt: number | null;
  /** Units learned for it ("Tray" = 30 pcs), for counting. */
  units: LearnedUnit[];
  /** How often the owner wants it counted; null: chosen automatically (tiersOf). */
  tier: Tier | null;
  /** What receiving it is counted in, the owner's choice (SCRUM-96); null: packs. */
  receiveUnit: string | null;
};

const DAY = 24 * 60 * 60 * 1000;
export const isOutOfStock = (row: Pick<InventoryRow, 'onHandBaseUnits'>): boolean => row.onHandBaseUnits <= 0;
/** Low: the reorder rule says to order it. */
export const isLowStock = (row: Pick<InventoryRow, 'suggestedPacks'>): boolean => row.suggestedPacks > 0;

/** A typed number of packs ("2", "1.5", "0"), or null. Never negative. */
export const parsePacks = (raw: string): number | null => {
  const text = raw.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(text)) return null;
  return Number(text);
};

/**
 * A count: the manager says how many packs are on the shelf; the app records the
 * difference from what it expected (exact, in base units, so a later count of
 * the same shelf records nothing). Positive: more there than expected.
 */
export const countDifference = (row: Pick<InventoryRow, 'onHandBaseUnits' | 'packQty'>, countedPacks: number): number =>
  (Math.round(countedPacks * row.packQty) - row.onHandBaseUnits) / row.packQty;

/**
 * unknown: nobody has recorded this item yet, so the app cannot say (never shown as out).
 * unsure: it looks fine, but sales it could not take from have happened since the last
 * count. Missed sales only ever make the real shelf lower, so out and low stay true.
 */
export type StockStatus = 'out' | 'low' | 'unsure' | 'ok' | 'unknown';
export const stockStatus = (row: InventoryRow): StockStatus => {
  if (!row.counted) return 'unknown';
  if (isOutOfStock(row)) return 'out';
  if (isLowStock(row)) return 'low';
  if (row.missedSales > 0) return 'unsure';
  return 'ok';
};

export const suppliersFromEvents = (
  suppliers: readonly Supplier[],
  events: readonly SyncEvent[],
  includeArchived = false,
): Supplier[] => {
  const byId = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
  const archived = new Set<string>();
  for (const event of events) {
    if (event.type === 'stock.supplier_added' && !byId.has(event.supplier.id)) {
      byId.set(event.supplier.id, event.supplier);
    } else if (event.type === 'stock.supplier_archived') {
      archived.add(event.supplierId);
    } else if (event.type === 'stock.supplier_restored') {
      archived.delete(event.supplierId);
    }
  }
  return [...byId.values()].filter((supplier) => includeArchived || !archived.has(supplier.id));
};

const STATUS_ORDER: Record<StockStatus, number> = { out: 0, low: 1, unsure: 2, ok: 3, unknown: 4 };

/** The worst status among a list: out, then low, then ok; unknown only if nothing is known. */
export const worstStatus = (statuses: StockStatus[]): StockStatus =>
  statuses.reduce<StockStatus>((worst, s) => (STATUS_ORDER[s] < STATUS_ORDER[worst] ? s : worst), 'unknown');

/** Per supplier: what they supply, and what of it needs ordering (out first, then low). */
export const summariseSuppliers = (items: InventoryRow[], suppliers: Supplier[]) =>
  suppliers.map((supplier) => {
    const suppliedItems = items.filter((i) => !i.archived && i.supplierIds.includes(supplier.id));
    const statuses = suppliedItems.map(stockStatus);
    return {
      supplier,
      status: worstStatus(statuses),
      outCount: statuses.filter((s) => s === 'out').length,
      lowCount: statuses.filter((s) => s === 'low').length,
      suppliedItems,
      needItems: suppliedItems
        .filter((item) => STATUS_ORDER[stockStatus(item)] <= STATUS_ORDER.low)
        .sort((a, b) => STATUS_ORDER[stockStatus(a)] - STATUS_ORDER[stockStatus(b)]),
    };
  });

export type SupplierSummary = ReturnType<typeof summariseSuppliers>[number];

interface Shelf {
  item: InventoryItem;
  onHandBaseUnits: number;
  archived: boolean;
  counted: boolean;
  units: LearnedUnit[];
  tier: Tier | null;
  receiveUnit: string | null;
}

/**
 * Stock as it stands, built from the price list (in code, like the menu) and
 * the shop's events, oldest first. Same events, same result on every device and
 * in the cloud, like the kitchen tickets.
 *
 * Sales: a line takes its recipe from stock when it is sent to the kitchen, and
 * remembers exactly what it took. Undo after Send, a cancelled line or a changed
 * line gives that back (a changed line then takes its new recipe); a manager's
 * Undo of that change puts it back as it was. Lines never sent take nothing.
 * Amounts are not clamped, so every give-back is exact. What a line takes comes
 * from the owner's recipes (stockUsage.ts) with his answers as they were when it
 * was sold, so a later answer never rewrites past sales.
 */
export const inventoryFromEvents = (
  items: readonly InventoryItem[],
  events: readonly SyncEvent[],
  options: StockOptions = {},
): InventoryRow[] => stockFromEvents(items, events, options).rows;

export interface StockOptions { usageOf?: UsageOf; gapsOf?: GapsOf; now?: number; settings?: StockSettings }

export interface Stock {
  rows: InventoryRow[];
  /** Items sold in the last usageDays whose menu item has no recipe yet: they took nothing. */
  untrackedSold: number;
}

/** inventoryFromEvents, plus what the stock does not know about. */
export const stockFromEvents = (
  items: readonly InventoryItem[],
  events: readonly SyncEvent[],
  { usageOf = bookUsage, gapsOf = bookGaps, now = Date.now(), settings = stockSettingsFromEvents(events) }: StockOptions = {},
): Stock => {
  const shelves = new Map<string, Shelf>(items.map((i) => [i.id, {
    item: { ...i, supplierIds: [...i.supplierIds] }, onHandBaseUnits: 0, archived: false, counted: false, units: [], tier: null, receiveUnit: null,
  }]));
  const take = (usage: readonly RecipeLine[], sign: 1 | -1) => {
    for (const { inventoryId, qtyBaseUnits } of usage) {
      const shelf = shelves.get(inventoryId);
      if (shelf) shelf.onHandBaseUnits -= sign * qtyBaseUnits;
    }
  };
  /** What each GRN put on the shelves, for its Undo. */
  const grnMoved = new Map<string, { itemId: string; qty: number }[]>();
  /** What each sent line took from stock, by line id. */
  const taken = new Map<string, RecipeLine[]>();
  /** When each line was sent, for the daily rate. */
  const sentAt = new Map<string, number>();
  let answers = new Map<string, Answer>();
  const recipeEvents: RecipeEvent[] = [];
  const ticketLines = new Map<string, string[]>();
  /** What each standing sent line could not take (UsageGaps), by line id. */
  const gaps = new Map<string, { untracked: boolean; items: string[]; qty: number }>();
  /** When each item was last counted (an audit): missed sales before it are already corrected. */
  const countedAt = new Map<string, number>();
  /** Each shelf count's correction, for its Undo: the amount and the count time it replaced. */
  const counts = new Map<string, { itemId: string; delta: number; previous: number | undefined }>();
  /** For a manager's Undo: what the line had taken before the change (null: nothing). */
  const beforeChange = new Map<string, { lineId: string; usage: RecipeLine[] | null; gaps: { untracked: boolean; items: string[]; qty: number } | null }>();
  const setLine = (lineId: string, usage: RecipeLine[] | null) => {
    const had = taken.get(lineId);
    if (had) take(had, -1);
    if (usage) { take(usage, 1); taken.set(lineId, usage); } else taken.delete(lineId);
  };

  for (const e of events) {
    switch (e.type) {
      case 'stock.item_added':
        if (!shelves.has(e.item.id)) {
          shelves.set(e.item.id, {
            item: { ...e.item, supplierIds: [...e.item.supplierIds] }, onHandBaseUnits: 0, archived: false, counted: false, units: [], tier: null, receiveUnit: null,
          });
        }
        break;
      case 'stock.item_archived':
      case 'stock.item_restored': {
        const shelf = shelves.get(e.itemId);
        if (shelf) shelf.archived = e.type === 'stock.item_archived';
        break;
      }
      case 'stock.supplier_added':
        for (const itemId of e.linkedItemIds) {
          const shelf = shelves.get(itemId);
          if (shelf && !shelf.item.supplierIds.includes(e.supplier.id)) shelf.item.supplierIds.push(e.supplier.id);
        }
        break;
      case 'stock.adjusted': {
        const shelf = shelves.get(e.itemId);
        if (!shelf) break; // an item no longer on the price list
        shelf.counted = true;
        if (e.reason === 'audit') countedAt.set(e.itemId, e.at);
        shelf.onHandBaseUnits += e.deltaPacks * shelf.item.packQty;
        break;
      }
      case 'stock.grn': {
        // A GRN is its own stock movement: what it accepted goes in, in one record, so the
        // note and its stock can never disagree. Older notes (no accepted) used separate movements.
        const moved: { itemId: string; qty: number }[] = [];
        for (const l of e.lines) {
          const shelf = shelves.get(l.itemId);
          if (!shelf || l.accepted === undefined || !(l.accepted > 0)) continue;
          const qty = l.accepted * shelf.item.packQty;
          shelf.counted = true;
          shelf.onHandBaseUnits += qty;
          moved.push({ itemId: l.itemId, qty });
        }
        grnMoved.set(e.id, moved);
        break;
      }
      case 'stock.grn_undone': {
        for (const m of grnMoved.get(e.grnId) ?? []) {
          const shelf = shelves.get(m.itemId);
          if (shelf) shelf.onHandBaseUnits -= m.qty; // GRN_UNDO: exactly what that GRN added
        }
        grnMoved.delete(e.grnId);
        break;
      }
      case 'stock.movement': {
        const shelf = shelves.get(e.itemId);
        if (!shelf) break;
        shelf.counted = true;
        shelf.onHandBaseUnits += e.qtyBase;
        if (e.kind === 'COUNT_ADJUST') countedAt.set(e.itemId, e.at);
        break;
      }
      case 'stock.counted': {
        const shelf = shelves.get(e.itemId);
        if (!shelf) break;
        const delta = e.counted - e.expected;
        counts.set(e.id, { itemId: e.itemId, delta, previous: countedAt.get(e.itemId) });
        shelf.counted = true;
        shelf.onHandBaseUnits += delta;
        countedAt.set(e.itemId, e.at);
        break;
      }
      case 'stock.count_undone': {
        const c = counts.get(e.countId);
        const shelf = c && shelves.get(c.itemId);
        if (!c || !shelf) break;
        counts.delete(e.countId);
        shelf.onHandBaseUnits -= c.delta;
        if (c.previous === undefined) countedAt.delete(c.itemId); else countedAt.set(c.itemId, c.previous);
        break;
      }
      case 'stock.unit_set': {
        const shelf = shelves.get(e.itemId);
        if (!shelf) break;
        shelf.units = shelf.units.filter((u) => u.name.toLowerCase() !== e.name.toLowerCase());
        if (e.base > 0) shelf.units.push({ name: e.name, base: e.base });
        break;
      }
      case 'stock.receive_unit_set': {
        const shelf = shelves.get(e.itemId);
        if (shelf) shelf.receiveUnit = e.unit === 'pack' ? null : e.unit;
        break;
      }
      case 'stock.tier_set': {
        const shelf = shelves.get(e.itemId);
        if (shelf) shelf.tier = e.tier;
        break;
      }
      case 'stock.price_set': {
        const shelf = shelves.get(e.itemId);
        if (shelf) shelf.item.workingPriceCents = e.after;
        break;
      }
      case 'recipe.answer_set':
        recipeEvents.push(e);
        answers = answersFromEvents(recipeEvents);
        break;
      case 'order.sent':
        ticketLines.set(e.ticketId, e.lines.map((l) => l.id));
        for (const line of e.lines) {
          setLine(line.id, usageOf(line, answers));
          gaps.set(line.id, { ...gapsOf(line, answers), qty: lineQty(line.qty) });
          sentAt.set(line.id, e.at);
        }
        break;
      case 'order.send_undone':
        for (const lineId of ticketLines.get(e.ticketId) ?? []) { setLine(lineId, null); gaps.delete(lineId); }
        ticketLines.delete(e.ticketId);
        break;
      case 'order.item_cancelled':
      case 'order.item_changed': {
        const had = taken.get(e.lineId);
        const hadGaps = gaps.get(e.lineId);
        if (!had && !hadGaps) break; // never sent: it took nothing
        beforeChange.set(e.id, { lineId: e.lineId, usage: had ?? null, gaps: hadGaps ?? null });
        setLine(e.lineId, e.type === 'order.item_changed' ? usageOf(e.after, answers) : null);
        if (e.type === 'order.item_changed') gaps.set(e.lineId, { ...gapsOf(e.after, answers), qty: lineQty(e.after.qty) });
        else gaps.delete(e.lineId);
        break;
      }
      case 'order.change_undone': {
        const was = beforeChange.get(e.undoneEventId);
        if (was) {
          setLine(was.lineId, was.usage);
          if (was.gaps) gaps.set(was.lineId, was.gaps); else gaps.delete(was.lineId);
        }
        break;
      }
      default: break; // payments, discounts and the kitchen do not move stock
    }
  }

  // The daily rate: what lines sent in the window still take, over the days the shop has sold in it.
  const used = new Map<string, number>();
  for (const [lineId, usage] of taken) {
    const at = sentAt.get(lineId) ?? 0;
    if (at < now - settings.usageDays * DAY || at > now) continue;
    for (const { inventoryId, qtyBaseUnits } of usage) used.set(inventoryId, (used.get(inventoryId) ?? 0) + qtyBaseUnits);
  }
  /** Daily use = what sales took over the window ÷ the window's days, as the owner set it. */
  const days = settings.usageDays;

  // What the stock does not know: sales since each item's last count, and lines with no recipe this week.
  const missed = new Map<string, number>();
  let untrackedSold = 0;
  for (const [lineId, gap] of gaps) {
    const at = sentAt.get(lineId) ?? 0;
    if (at > now) continue;
    if (gap.untracked && at >= now - settings.usageDays * DAY) untrackedSold += gap.qty;
    for (const id of gap.items) {
      if (at > (countedAt.get(id) ?? -Infinity)) missed.set(id, (missed.get(id) ?? 0) + gap.qty);
    }
  }

  const rows = [...shelves.values()].map(({ item, onHandBaseUnits, archived, counted, units, tier, receiveUnit }) => {
    const usedPerDay = (used.get(item.id) ?? 0) / days;
    return {
      ...item,
      onHandBaseUnits,
      onHandPacks: item.packQty > 0 ? Math.max(0, onHandBaseUnits) / item.packQty : 0,
      archived,
      counted,
      usedPerDay,
      lastsDays: counted && onHandBaseUnits > 0 && usedPerDay > 0 ? onHandBaseUnits / usedPerDay : null,
      missedSales: missed.get(item.id) ?? 0,
      lastCountedAt: countedAt.get(item.id) ?? null,
      units,
      tier,
      receiveUnit,
      suggestedPacks: 0,
      suggestedSupplierId: null as string | null,
    };
  });

  // What to order now: one rule, so Low, the badge, the cards and the owner's feed all agree.
  const purchases = purchasesFromEvents(events, settings);
  const active = new Set(suppliersFromEvents(SEED_SUPPLIERS, events).map((x) => x.id));
  for (const s of suggestions(rows, active, onOrder(purchases.open), purchases.leadDays, purchases.lastSupplier, settings)) {
    const row = rows.find((r) => r.id === s.itemId);
    if (row) { row.suggestedPacks = s.packs; row.suggestedSupplierId = s.supplierId; }
  }
  return { rows, untrackedSold };
};

const lineQty = (qty: number) => (Number.isFinite(qty) && qty > 0 ? qty : 1);
