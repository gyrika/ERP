import { useEffect, useMemo, useState } from 'react';
import { answersFromEvents, type Answer, type CostContext } from '../domain/costing.ts';
import type { Actor } from '../domain/auth.ts';
import { countHistory, gapOf, type CountEntry, type CountRecord, type GapReason, type Tier } from '../domain/counting.ts';
import type { SyncEvent } from '../domain/sync.ts';
import { appendEvent, readAll, subscribeEvents } from '../ui/eventLog.ts';
import { inventoryFromEvents, stockFromEvents, suppliersFromEvents, validateSeed, type InventoryRow } from '../domain/inventory.ts';
import type { InventoryItem, Supplier } from '../domain/inventoryData.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from '../domain/inventoryData.ts';
import type { Cents } from '../domain/types.ts';
import { currentCashier } from './auth.ts';
import { newLineId } from '../domain/order.ts';
import { useShopEvents } from './ownerData.ts';

/**
 * Stock is not stored as a list: like the kitchen screen, it is built from the
 * event log (`inventoryFromEvents`), so every change reaches MySQL and the cloud
 * copy, says who made it, and survives a cleared browser. The price list
 * itself (items, suppliers) comes from the owner's March 2026 sheet, in code.
 *
 * This browser keeps only two days of events, but stock needs the whole history
 * (every count and every sale), so the amounts come from the shop server, like the
 * Owner view. The ingredient and supplier lists are kept here for good, so the
 * checks below and the add dialogs work from this device's own copy.
 */
export { isLowStock, isOutOfStock, LOW_STOCK_PACKS, stockStatus, type StockStatus, type InventoryRow } from '../domain/inventory.ts';

const readAllItems = (): InventoryRow[] => inventoryFromEvents(SEED_INVENTORY, readAll());
/** The ingredient list (amounts here cover two days only: use useInventory for stock). */
export const readItems = (): InventoryRow[] => readAllItems().filter((item) => !item.archived);
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

/** Packs in (+) or out (-), with why. The screen offers "out" only while there is stock. */
export const adjustStock = (itemId: string, deltaPacks: number, reason?: 'waste' | 'audit' | 'receive'): void => {
  if (deltaPacks === 0 || !Number.isFinite(deltaPacks) || !readItems().some((i) => i.id === itemId)) return;
  appendEvent({
    type: 'stock.adjusted', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId, deltaPacks,
    ...(reason ? { reason } : {}),
  });
};

/**
 * A delivery: packs in, and the price paid per pack if it changed (both audited).
 * 0 packs with a new price just updates the price. Returns the Undo.
 */
export const receiveStock = (row: InventoryRow, packs: number, priceCents: Cents): (() => void) => {
  const before = row.workingPriceCents;
  if (packs > 0) adjustStock(row.id, packs, 'receive');
  if (priceCents !== before) setWorkingPrice(row.id, priceCents);
  return () => {
    if (packs > 0) adjustStock(row.id, -packs, 'receive');
    if (priceCents !== before) setWorkingPrice(row.id, before);
  };
};

/**
 * A shelf count (counting.ts): what is left, compared with what the app expected, with
 * the reason for a big gap. Returns the Undo.
 */
export const recordCount = (
  row: InventoryRow, entries: CountEntry[], counted: number, reason: GapReason | null, tier: Tier,
): (() => void) => {
  const expected = row.onHandBaseUnits;
  const { valueCents } = gapOf(expected, counted, row);
  const e = appendEvent({
    type: 'stock.counted', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId: row.id,
    counted, expected, entries, reason, valueCents, tier,
  });
  return () => { appendEvent({ type: 'stock.count_undone', at: Date.now(), orderNumber: 0, actor: currentCashier(), countId: e.id }); };
};

/** A unit learned for an item ("Tray" = 30 pcs), audited like any stock change. */
export const learnUnit = (itemId: string, name: string, base: number): void => {
  appendEvent({ type: 'stock.unit_set', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId, name: name.trim(), base });
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

/** The ingredient and supplier lists from this device's copy, for the add dialogs. */
export function useCatalog(): { items: InventoryRow[]; suppliers: Supplier[] } {
  const [items, setItems] = useState(readItems);
  const [suppliers, setSuppliers] = useState(readSuppliers);
  useEffect(() => subscribeEvents(() => {
    setItems(readItems());
    setSuppliers(readSuppliers());
  }), []);
  return { items, suppliers };
}

/** The shop's history, then what this device has that the history does not have yet. */
const withLocal = (history: readonly SyncEvent[], local: readonly SyncEvent[]): SyncEvent[] => {
  const known = new Set(history.map((e) => e.id));
  return [...history, ...local.filter((e) => !known.has(e.id))];
};

/**
 * The shop's whole history plus this device's own new events: this device's
 * changes show at once; the history from the server follows (refreshed every minute).
 */
function useShopHistory(): SyncEvent[] {
  const shop = useShopEvents();
  const [local, setLocal] = useState(readAll);
  useEffect(() => subscribeEvents(() => setLocal(readAll())), []);
  const history = shop.state === 'loading' ? null : shop.events;
  return useMemo(() => withLocal(history ?? [], local), [history, local]);
}

/** Stock as it stands, from the whole history; untrackedSold: items sold this week with no recipe yet. */
export function useInventory(): { items: InventoryRow[]; suppliers: Supplier[]; untrackedSold: number } {
  const events = useShopHistory();
  return useMemo(() => {
    const stock = stockFromEvents(SEED_INVENTORY, events);
    return {
      items: stock.rows.filter((item) => !item.archived),
      suppliers: suppliersFromEvents(SEED_SUPPLIERS, events),
      untrackedSold: stock.untrackedSold,
    };
  }, [events]);
}

/** Every standing shelf count, oldest first (the Manager page's progress). */
export function useCountHistory(): CountRecord[] {
  const events = useShopHistory();
  return useMemo(() => countHistory(events), [events]);
}

/** What food costing needs (SCRUM-77): the price list with its latest prices, and the owner's answers. */
export function useCostContext(): CostContext {
  const events = useShopHistory();
  return useMemo(() => ({
    items: inventoryFromEvents(SEED_INVENTORY, events),
    answers: answersFromEvents(events),
  }), [events]);
}

/**
 * The owner answers one costing question (or clears it with null). Returns the Undo.
 * actor: the owner who opened the Recipes screen with his PIN (default: who is signed in).
 */
export const answerQuestion = (question: string, after: Answer | null, before: Answer | null, actor: Actor = currentCashier()): (() => void) => {
  appendEvent({ type: 'recipe.answer_set', at: Date.now(), orderNumber: 0, actor, question, before, after });
  return () => appendEvent({ type: 'recipe.answer_set', at: Date.now(), orderNumber: 0, actor, question, before: after, after: before });
};

/** The Recipes screen was opened: who and when, in the audit trail. */
export const recipesViewed = (actor: Actor): void => {
  appendEvent({ type: 'recipe.viewed', at: Date.now(), orderNumber: 0, actor });
};
