import type { BaseUnit, InventoryItem, Supplier } from './inventoryData.ts';
import type { SyncEvent } from './sync.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from './inventoryData.ts';
import { RECIPES, recipeUsage, type RecipeLine, type Recipes } from './recipes.ts';

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
};

export const LOW_STOCK_PACKS = 1;

export const isOutOfStock = (row: InventoryRow): boolean => row.onHandBaseUnits <= 0;
export const isLowStock = (row: InventoryRow): boolean => row.onHandPacks <= LOW_STOCK_PACKS;

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

/** unknown: nobody has recorded this item yet, so the app cannot say (never shown as out). */
export type StockStatus = 'out' | 'low' | 'ok' | 'unknown';
export const stockStatus = (row: InventoryRow): StockStatus => {
  if (!row.counted) return 'unknown';
  if (isOutOfStock(row)) return 'out';
  if (isLowStock(row)) return 'low';
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

const STATUS_ORDER: Record<StockStatus, number> = { out: 0, low: 1, ok: 2, unknown: 3 };

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
 * Amounts are not clamped, so every give-back is exact.
 */
export const inventoryFromEvents = (
  items: readonly InventoryItem[],
  events: readonly SyncEvent[],
  recipes: Recipes = RECIPES,
): InventoryRow[] => {
  const shelves = new Map<string, Shelf>(items.map((i) => [i.id, {
    item: { ...i, supplierIds: [...i.supplierIds] }, onHandBaseUnits: 0, archived: false, counted: false,
  }]));
  const take = (usage: readonly RecipeLine[], sign: 1 | -1) => {
    for (const { inventoryId, qtyBaseUnits } of usage) {
      const shelf = shelves.get(inventoryId);
      if (shelf) shelf.onHandBaseUnits -= sign * qtyBaseUnits;
    }
  };
  /** What each sent line took from stock, by line id. */
  const taken = new Map<string, RecipeLine[]>();
  const ticketLines = new Map<string, string[]>();
  /** For a manager's Undo: what the line had taken before the change (null: nothing). */
  const beforeChange = new Map<string, { lineId: string; usage: RecipeLine[] | null }>();
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
            item: { ...e.item, supplierIds: [...e.item.supplierIds] }, onHandBaseUnits: 0, archived: false, counted: false,
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
        shelf.onHandBaseUnits += e.deltaPacks * shelf.item.packQty;
        break;
      }
      case 'stock.price_set': {
        const shelf = shelves.get(e.itemId);
        if (shelf) shelf.item.workingPriceCents = e.after;
        break;
      }
      case 'order.sent':
        ticketLines.set(e.ticketId, e.lines.map((l) => l.id));
        for (const line of e.lines) setLine(line.id, recipeUsage(line, recipes));
        break;
      case 'order.send_undone':
        for (const lineId of ticketLines.get(e.ticketId) ?? []) setLine(lineId, null);
        ticketLines.delete(e.ticketId);
        break;
      case 'order.item_cancelled':
      case 'order.item_changed': {
        const had = taken.get(e.lineId);
        if (!had) break; // never sent: it took nothing
        beforeChange.set(e.id, { lineId: e.lineId, usage: had });
        setLine(e.lineId, e.type === 'order.item_changed' ? recipeUsage(e.after, recipes) : null);
        break;
      }
      case 'order.change_undone': {
        const was = beforeChange.get(e.undoneEventId);
        if (was) setLine(was.lineId, was.usage);
        break;
      }
      default: break; // payments, discounts and the kitchen do not move stock
    }
  }

  return [...shelves.values()].map(({ item, onHandBaseUnits, archived, counted }) => ({
    ...item,
    onHandBaseUnits,
    onHandPacks: item.packQty > 0 ? Math.max(0, onHandBaseUnits) / item.packQty : 0,
    archived,
    counted,
  }));
};
