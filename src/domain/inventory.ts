import type { BaseUnit, InventoryItem, Supplier } from './inventoryData.ts';
import type { SyncEvent } from './sync.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from './inventoryData.ts';

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
    if (!supplierIds.has(i.mainSupplierId)) {
      errors.push(`${i.id}: unknown mainSupplierId ${i.mainSupplierId}`);
    }
    if (i.backupSupplierId !== null && !supplierIds.has(i.backupSupplierId)) {
      errors.push(`${i.id}: unknown backupSupplierId ${i.backupSupplierId}`);
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
export type InventoryRow = InventoryItem & { onHandPacks: number };

export const LOW_STOCK_PACKS = 1;

export const isLowStock = (row: InventoryRow): boolean => row.onHandPacks <= LOW_STOCK_PACKS;

/**
 * Stock as it stands, built from the price list (in code, like the menu) and
 * the stock events, oldest first. Counts never go below zero; the last price
 * set wins. Same events, same result on every device and in the cloud.
 */
export const inventoryFromEvents = (items: readonly InventoryItem[], events: readonly SyncEvent[]): InventoryRow[] => {
  const rows = new Map(items.map((i) => [i.id, { ...i, onHandPacks: 0 }]));
  for (const e of events) {
    if (e.type !== 'stock.adjusted' && e.type !== 'stock.price_set') continue;
    const row = rows.get(e.itemId);
    if (!row) continue; // an item no longer on the price list
    if (e.type === 'stock.adjusted') row.onHandPacks = Math.max(0, row.onHandPacks + e.deltaPacks);
    else row.workingPriceCents = e.after;
  }
  return [...rows.values()];
};
