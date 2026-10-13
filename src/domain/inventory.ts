import type { BaseUnit, InventoryItem, Supplier } from './inventoryData.ts';
import type { SyncEvent } from './sync.ts';
import type { OrderLine } from './types.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from './inventoryData.ts';
import { RECIPES } from './recipes.ts';

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

/** A stock row: the price-list item plus what is on the shelf, in purchasing packs. */
export type InventoryRow = InventoryItem & { onHandPacks: number; onHandBaseUnits?: number };

export const LOW_STOCK_PACKS = 1;

export const isLowStock = (row: InventoryRow): boolean => row.onHandPacks <= LOW_STOCK_PACKS;
export type StockStatus = 'out' | 'low' | 'ok';
export const stockStatus = (row: InventoryRow): StockStatus => {
  if (isOutOfStock(row)) return 'out';
  if (isLowStock(row)) return 'low';
  return 'ok';
};



export const isOutOfStock = (row: InventoryRow): boolean => row.onHandPacks === 0;

export const suppliersFromEvents = (suppliers: readonly Supplier[], events: readonly SyncEvent[]): Supplier[] => {
  const byId = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
  for (const event of events) {
    if (event.type === 'stock.supplier_added' && !byId.has(event.supplier.id)) {
      byId.set(event.supplier.id, event.supplier);
    }
  }
  return [...byId.values()];
};

// Return worst status among a list
export const worstStatus = (statuses: StockStatus[]): StockStatus => {
  if (statuses.includes('out')) return 'out';
  if (statuses.includes('low')) return 'low';
  return 'ok';
};

// Summarise suppliers based on items
export const summariseSuppliers = (items: InventoryRow[], suppliers: Supplier[]) => {
  return suppliers.map((supplier) => {
    const suppliedItems = items.filter((i) => i.supplierIds.includes(supplier.id));
    const statuses = suppliedItems.map(stockStatus);
    const status = worstStatus(statuses);
    const outCount = suppliedItems.filter(isOutOfStock).length;
    const lowCount = suppliedItems.filter((it) => isLowStock(it) && !isOutOfStock(it)).length;
    const needItems = suppliedItems
      .filter((it) => isOutOfStock(it) || isLowStock(it))
      .sort((a, b) => {
        if (isOutOfStock(a) && !isOutOfStock(b)) return -1;
        if (!isOutOfStock(a) && isOutOfStock(b)) return 1;
        if (isLowStock(a) && !isLowStock(b)) return -1;
        if (!isLowStock(a) && isLowStock(b)) return 1;
        return 0;
      });
    return { supplier, status, outCount, lowCount, suppliedItems, needItems };
  });
};

export type SupplierSummary = ReturnType<typeof summariseSuppliers>[number];


interface StockAccumulator {
  item: InventoryItem;
  workingPriceCents: number;
  onHandBaseUnits: number;
}

const getLineIngredients = (
  line: { itemId: string; qty?: number; size?: string },
): { inventoryId: string; qtyBaseUnits: number }[] => {
  const recipe = RECIPES[line.itemId];
  if (!recipe) return [];
  const qty = typeof line.qty === 'number' && Number.isFinite(line.qty) && line.qty > 0 ? line.qty : 1;
  const ingredients: { inventoryId: string; qtyBaseUnits: number }[] = [];

  for (const ing of recipe.baseIngredients) {
    if (ing.qtyBaseUnits > 0) {
      ingredients.push({
        inventoryId: ing.inventoryId,
        qtyBaseUnits: ing.qtyBaseUnits * qty,
      });
    }
  }

  if (line.size && recipe.variantOverrides) {
    const variantLines = recipe.variantOverrides[line.size] ?? recipe.variantOverrides[line.size.toUpperCase()];
    if (variantLines) {
      for (const ing of variantLines) {
        if (ing.qtyBaseUnits > 0) {
          ingredients.push({
            inventoryId: ing.inventoryId,
            qtyBaseUnits: ing.qtyBaseUnits * qty,
          });
        }
      }
    }
  }

  return ingredients;
};

const extractVoidedLines = (e: SyncEvent): OrderLine[] => {
  if (e.type === 'order.item_cancelled') {
    return e.before ? [e.before] : [];
  }
  const anyEvent = e as any;
  if (anyEvent.type === 'order.managed') {
    if (anyEvent.kind && anyEvent.kind !== 'void' && anyEvent.kind !== 'cancel' && anyEvent.kind !== 'cancellation') {
      return [];
    }
    if (anyEvent.action && anyEvent.action !== 'void' && anyEvent.action !== 'cancel' && anyEvent.action !== 'cancellation') {
      return [];
    }
    if (Array.isArray(anyEvent.lines)) return anyEvent.lines;
    if (Array.isArray(anyEvent.voidedLines)) return anyEvent.voidedLines;
    if (Array.isArray(anyEvent.before)) return anyEvent.before;
    if (anyEvent.before && typeof anyEvent.before === 'object') return [anyEvent.before];
    if (anyEvent.line && typeof anyEvent.line === 'object') return [anyEvent.line];
  }
  return [];
};

/**
 * Stock as it stands, built from the price list (in code, like the menu) and
 * the stock events, oldest first. Counts never go below zero; the last price
 * set wins. Real-time ingredient consumption is deducted from sales and restored on voids.
 */
export const inventoryFromEvents = (items: readonly InventoryItem[], events: readonly SyncEvent[]): InventoryRow[] => {
  const accumulator = new Map<string, StockAccumulator>(
    items.map((i) => [i.id, {
      item: { ...i, supplierIds: [...i.supplierIds] },
      workingPriceCents: i.workingPriceCents,
      onHandBaseUnits: 0,
    }]),
  );

  const activeRecipes: Record<string, Array<{ inventoryId: string; qtyBaseUnits: number }>> = {};
  for (const e of events) {
    if (e.type === 'stock.item_added') {
      if (!accumulator.has(e.item.id)) {
        accumulator.set(e.item.id, {
          item: { ...e.item, supplierIds: [...e.item.supplierIds] },
          workingPriceCents: e.item.workingPriceCents,
          onHandBaseUnits: 0,
        });
      }
    } else if (e.type === 'stock.supplier_added') {
      for (const itemId of e.linkedItemIds) {
        const acc = accumulator.get(itemId);
        if (acc && !acc.item.supplierIds.includes(e.supplier.id)) {
          acc.item.supplierIds.push(e.supplier.id);
        }
      }
    } else if (e.type === 'stock.adjusted') {
      const acc = accumulator.get(e.itemId);
      if (!acc) continue; // an item no longer on the price list
      acc.onHandBaseUnits = Math.max(0, acc.onHandBaseUnits + e.deltaPacks * acc.item.packQty);
    } else if (e.type === 'recipe.updated') {
      // Update the active recipe ingredients for the given menu item
      const rev = e as any;
      activeRecipes[rev.menuItemId] = rev.ingredients;
    } else if (e.type === 'stock.price_set') {
      const acc = accumulator.get(e.itemId);
      if (!acc) continue;
      acc.workingPriceCents = e.after;
    } else if (e.type === 'order.sent' || (e as { type: string }).type === 'order.dispatched') {
      const lines: OrderLine[] = Array.isArray((e as any).lines) ? (e as any).lines : [];
      for (const line of lines) {
        // Determine ingredients: use dynamic recipe if present, otherwise static definition
        const menuId = line.itemId;
        const qty = typeof line.qty === 'number' && Number.isFinite(line.qty) && line.qty > 0 ? line.qty : 1;
        let ingredients: { inventoryId: string; qtyBaseUnits: number }[] = [];
        if (activeRecipes[menuId]) {
          ingredients = activeRecipes[menuId].map((ing) => ({
            inventoryId: ing.inventoryId,
            qtyBaseUnits: ing.qtyBaseUnits * qty,
          }));
        } else {
          ingredients = getLineIngredients(line);
        }
        for (const { inventoryId, qtyBaseUnits } of ingredients) {
          const acc = accumulator.get(inventoryId);
          if (!acc) continue;
          acc.onHandBaseUnits = Math.max(0, acc.onHandBaseUnits - qtyBaseUnits);
        }
      }
    } else if (e.type === 'order.item_cancelled' || (e as { type: string }).type === 'order.managed') {
      const voidedLines = extractVoidedLines(e);
      for (const line of voidedLines) {
        for (const { inventoryId, qtyBaseUnits } of getLineIngredients(line)) {
          const acc = accumulator.get(inventoryId);
          if (!acc) continue;
          acc.onHandBaseUnits += qtyBaseUnits;
        }
      }
    }
  }

  return [...accumulator.values()].map((acc) => ({
    ...acc.item,
    workingPriceCents: acc.workingPriceCents,
    onHandBaseUnits: acc.onHandBaseUnits,
    onHandPacks: acc.item.packQty > 0 ? Math.floor(acc.onHandBaseUnits / acc.item.packQty) : 0,
  }));
};
