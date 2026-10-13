import { useEffect, useState } from 'react';
import { inventoryFromEvents, type InventoryRow } from '../domain/inventory.ts';
import type { Supplier } from '../domain/inventoryData.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from '../domain/inventoryData.ts';
import type { Cents } from '../domain/types.ts';
import { appendEvent, readAll, subscribeEvents } from '../ui/eventLog.ts';
import { currentCashier } from './auth.ts';

/**
 * Stock is not stored as a list: like the kitchen screen, it is built from the
 * event log (`inventoryFromEvents`), so every change reaches MySQL and the cloud
 * copy, says who made it, and survives a cleared browser. The price list
 * itself (items, suppliers) comes from the owner's March 2026 sheet, in code.
 */
export { isLowStock, isOutOfStock, LOW_STOCK_PACKS, type InventoryRow } from '../domain/inventory.ts';

export const readItems = (): InventoryRow[] => inventoryFromEvents(SEED_INVENTORY, readAll());
export const readSuppliers = (): Supplier[] => SEED_SUPPLIERS;

/** One pack in (+1) or out (-1). Taking from an empty shelf records nothing. */
export const adjustStock = (itemId: string, deltaPacks: number): void => {
  const row = readItems().find((i) => i.id === itemId);
  if (!row || deltaPacks === 0 || row.onHandPacks + deltaPacks < 0) return;
  appendEvent({ type: 'stock.adjusted', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId, deltaPacks });
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
  useEffect(() => subscribeEvents(() => setItems(readItems())), []);
  return { items, suppliers: SEED_SUPPLIERS };
}
