import { useEffect, useState } from 'react';
import { appendEvent, readAll, subscribeEvents } from '../ui/eventLog.ts';
import { inventoryFromEvents, suppliersFromEvents, validateSeed, type InventoryRow } from '../domain/inventory.ts';
import type { InventoryItem, Supplier } from '../domain/inventoryData.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from '../domain/inventoryData.ts';
import type { Cents } from '../domain/types.ts';
import { currentCashier } from './auth.ts';
import { newLineId } from '../domain/order.ts';

/**
 * Stock is not stored as a list: like the kitchen screen, it is built from the
 * event log (`inventoryFromEvents`), so every change reaches MySQL and the cloud
 * copy, says who made it, and survives a cleared browser. The price list
 * itself (items, suppliers) comes from the owner's March 2026 sheet, in code.
 */
export { isLowStock, isOutOfStock, LOW_STOCK_PACKS, stockStatus, type StockStatus, type InventoryRow } from '../domain/inventory.ts';

const readAllItems = (): InventoryRow[] => inventoryFromEvents(SEED_INVENTORY, readAll());
export const readItems = (): InventoryRow[] => readAllItems().filter((item) => !item.archived);

// Compute active recipes from event log
export const readActiveRecipes = (): Record<string, Array<{ inventoryId: string; qtyBaseUnits: number }>> => {
  const active: Record<string, Array<{ inventoryId: string; qtyBaseUnits: number }>> = {};
  const events = readAll();
  for (const e of events) {
    if (e.type === 'recipe.updated') {
      const rev = e as any;
      active[rev.menuItemId] = rev.ingredients;
    }
  }
  return active;
};

export function useActiveRecipes(): Record<string, Array<{ inventoryId: string; qtyBaseUnits: number }>> {
  const [active, setActive] = useState(readActiveRecipes);
  useEffect(() => subscribeEvents(() => setActive(readActiveRecipes())), []);
  return active;
};
export const readSuppliers = (includeArchived = false): Supplier[] =>
  suppliersFromEvents(SEED_SUPPLIERS, readAll(), includeArchived);

export const addSupplier = (
  supplier: Supplier,
  linkedItemIds: string[],
  newIngredientNames: string[] = [],
): void => {
  const suppliers = readSuppliers(true);
  const items = readItems();
  if (suppliers.some((existing) => existing.id === supplier.id)) throw new Error('A supplier with this id already exists.');
  if (suppliers.some((existing) => existing.name.trim().toLowerCase() === supplier.name.trim().toLowerCase())) {
    throw new Error('A supplier with this name already exists.');
  }
  if (!supplier.name.trim()) throw new Error('Enter a supplier name.');
  if (supplier.name.trim().length > 120) throw new Error('Supplier name must be 120 characters or fewer.');
  if (supplier.phone !== undefined && !supplier.phone.trim()) throw new Error('Enter a phone number or leave it blank.');
  if (supplier.phone && supplier.phone.trim().length > 40) throw new Error('Phone number must be 40 characters or fewer.');
  if (new Set(linkedItemIds).size !== linkedItemIds.length) throw new Error('An ingredient is selected more than once.');
  if (linkedItemIds.some((id) => !items.some((item) => item.id === id))) throw new Error('A selected ingredient no longer exists.');
  const normalizedNames = newIngredientNames.map((name) => name.trim().toLowerCase());
  if (normalizedNames.some((name) => !name)) throw new Error('Ingredient names cannot be blank.');
  if (normalizedNames.some((name) => name.length > 120)) throw new Error('Ingredient names must be 120 characters or fewer.');
  if (new Set(normalizedNames).size !== normalizedNames.length) throw new Error('An ingredient is selected more than once.');

  const linked = new Set(linkedItemIds);
  const existingNames = new Map(items.map((item) => [item.name.trim().toLowerCase(), item.id]));
  const namesToCreate: string[] = [];
  for (const name of newIngredientNames) {
    const existingId = existingNames.get(name.trim().toLowerCase());
    if (existingId) linked.add(existingId);
    else namesToCreate.push(name.trim());
  }
  if (linked.size === 0 && namesToCreate.length === 0) {
    throw new Error('Select or add at least one ingredient for this supplier.');
  }

  const actor = currentCashier();
  for (const itemName of namesToCreate) {
    const item: InventoryItem = {
      id: `inv-${newLineId()}`,
      name: itemName,
      category: 'General',
      baseUnit: 'pcs',
      packQty: 1,
      supplierIds: [supplier.id],
      workingPriceCents: 0 as Cents,
    };
    appendEvent({ type: 'stock.item_added', at: Date.now(), orderNumber: 0, actor, item });
    linked.add(item.id);
  }

  appendEvent({
    type: 'stock.supplier_added',
    at: Date.now(),
    orderNumber: 0,
    actor,
    supplier: { ...supplier, name: supplier.name.trim(), ...(supplier.phone ? { phone: supplier.phone.trim() } : {}) },
    linkedItemIds: [...linked],
  });
};

export const addInventoryItem = (item: InventoryItem): void => {
  const items = readAllItems();
  if (items.some((existing) => existing.id === item.id)) throw new Error('An ingredient with this id already exists.');
  if (item.name.trim().length > 120) throw new Error('Ingredient name must be 120 characters or fewer.');
  const errors = validateSeed({ suppliers: readSuppliers(), items: [item] });
  if (errors.length) throw new Error(errors.join(' '));
  appendEvent({ type: 'stock.item_added', at: Date.now(), orderNumber: 0, actor: currentCashier(), item });
};

export const archiveInventoryItem = (itemId: string): void => {
  const item = readAllItems().find((row) => row.id === itemId);
  if (!item || item.archived) throw new Error('Ingredient is already removed or no longer exists.');
  appendEvent({ type: 'stock.item_archived', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId });
};

export const restoreInventoryItem = (itemId: string): void => {
  const item = readAllItems().find((row) => row.id === itemId);
  if (!item?.archived) throw new Error('Ingredient is already active or no longer exists.');
  appendEvent({ type: 'stock.item_restored', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId });
};

export const archiveSupplier = (supplierId: string): void => {
  if (!readSuppliers().some((supplier) => supplier.id === supplierId)) {
    throw new Error('Supplier is already removed or no longer exists.');
  }
  appendEvent({ type: 'stock.supplier_archived', at: Date.now(), orderNumber: 0, actor: currentCashier(), supplierId });
};

export const restoreSupplier = (supplierId: string): void => {
  if (!readSuppliers(true).some((supplier) => supplier.id === supplierId) ||
      readSuppliers().some((supplier) => supplier.id === supplierId)) {
    throw new Error('Supplier is already active or no longer exists.');
  }
  appendEvent({ type: 'stock.supplier_restored', at: Date.now(), orderNumber: 0, actor: currentCashier(), supplierId });
};

/** One pack in (+1) or out (-1). Taking from an empty shelf records nothing. */
export const adjustStock = (itemId: string, deltaPacks: number, reason?: string): void => {
  const row = readItems().find((i) => i.id === itemId);
  if (!row || deltaPacks === 0 || row.onHandPacks + deltaPacks < 0) return;
  const event: any = { type: 'stock.adjusted', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId, deltaPacks };
  if (reason) event.reason = reason;
  appendEvent(event);
};

/** A supplier's new price, audited with the old one (integer cents). */
export const setWorkingPrice = (itemId: string, cents: Cents): void => {
  const row = readItems().find((i) => i.id === itemId);
  if (!row || row.workingPriceCents === cents) return;
  appendEvent({
    type: 'stock.price_set', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId,
    before: row.workingPriceCents, after: cents,
  });
};

export function useInventory(): { items: InventoryRow[]; suppliers: Supplier[] } {
  const [items, setItems] = useState(readItems);
  const [suppliers, setSuppliers] = useState(readSuppliers);
  useEffect(() => subscribeEvents(() => {
    setItems(readItems());
    setSuppliers(readSuppliers());
  }), []);
  return { items, suppliers };
}
