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
import { itemHistory, itemStory, usedIn, type HistoryEntry, type ItemStory } from '../domain/itemStory.ts';
import { gapCases, type GapCase } from '../domain/gapReview.ts';
import { menuItems } from '../domain/menu.ts';
import { grnNumber, mergeLines, poNumber, purchasesFromEvents, type PurchaseOrder, type PurchaseState } from '../domain/purchaseOrders.ts';
import type { GrnLine, MovementKind, PoLine } from '../domain/sync.ts';
import { checkStockSetting, stockSettingsFromEvents, type StockSettings } from '../domain/stockSettings.ts';

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
export { isLowStock, isOutOfStock, stockStatus, type StockStatus, type InventoryRow } from '../domain/inventory.ts';

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

/**
 * THE one way stock changes (besides sales, which come from paid orders): a movement in
 * base units. GRN in, GRN_UNDO out, COUNT_ADJUST either way. Nothing edits a stock
 * figure; the shelf is the sum of its movements. Returns false for an item that is
 * not here or an amount that is not a real change.
 */
export const addStockMovement = (kind: MovementKind, itemId: string, qtyBase: number, docId: string): boolean => {
  if (qtyBase === 0 || !Number.isFinite(qtyBase) || !readItems().some((i) => i.id === itemId)) return false;
  if ((kind === 'GRN' && qtyBase < 0) || (kind === 'GRN_UNDO' && qtyBase > 0)) return false;
  appendEvent({ type: 'stock.movement', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId, kind, qtyBase, docId });
  return true;
};

/**
 * Packs in (+) or out (-): a GRN movement when it is a delivery, else a count correction.
 * The screens offer it for nothing else; kept for starting stock and for tests.
 */
export const adjustStock = (itemId: string, deltaPacks: number, reason?: 'waste' | 'audit' | 'receive'): void => {
  const item = readItems().find((i) => i.id === itemId);
  if (!item) return;
  const qty = deltaPacks * item.packQty;
  if (reason === 'receive') addStockMovement(qty > 0 ? 'GRN' : 'GRN_UNDO', itemId, qty, 'manual');
  else addStockMovement('COUNT_ADJUST', itemId, qty, 'manual');
};

/**
 * A shelf count (counting.ts): what is left, compared with what the app expected, with
 * the reason for a big gap. Returns the Undo.
 */
export const recordCount = (
  row: InventoryRow, entries: CountEntry[], counted: number, reason: GapReason | null, tier: Tier, photo: string | null = null,
): (() => void) => {
  const expected = row.onHandBaseUnits;
  const { valueCents } = gapOf(expected, counted, row);
  const e = appendEvent({
    type: 'stock.counted', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId: row.id,
    counted, expected, entries, reason, valueCents, tier, ...(photo ? { photo } : {}),
  });
  return () => { appendEvent({ type: 'stock.count_undone', at: Date.now(), orderNumber: 0, actor: currentCashier(), countId: e.id }); };
};

/** A unit learned for an item ("Tray" = 30 pcs), audited like any stock change. */
export const learnUnit = (itemId: string, name: string, base: number): void => {
  appendEvent({ type: 'stock.unit_set', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId, name: name.trim(), base });
};

/** What receiving an item is counted in (SCRUM-96), the owner's choice, signed by the owner's PIN. */
export const setReceiveUnit = (itemId: string, unit: string, owner: Actor): void => {
  appendEvent({ type: 'stock.receive_unit_set', at: Date.now(), orderNumber: 0, actor: owner, itemId, unit });
};

/** The owner on a count's gap (SCRUM-95): OK, or a question for the manager. */
export const reviewGap = (gap: GapCase, decision: 'ok' | 'ask', note = ''): void => {
  appendEvent({ type: 'stock.gap_reviewed', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId: gap.itemId, countId: gap.countId, decision, note: note.trim() });
};

/** The manager answers the owner's question about a gap. */
export const answerGap = (gap: GapCase, note: string): void => {
  appendEvent({ type: 'stock.gap_answered', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId: gap.itemId, countId: gap.countId, note: note.trim() });
};

/** The gaps in the counts and where each stands (SCRUM-95). */
export function useGapCases(): GapCase[] {
  const events = useShopHistory();
  return useMemo(() => gapCases(events), [events]);
}

/** The owner's choice of how often an item is counted (null: automatic), signed by the owner's PIN. */
export const setCountTier = (itemId: string, tier: Tier | null, owner: Actor): void => {
  appendEvent({ type: 'stock.tier_set', at: Date.now(), orderNumber: 0, actor: owner, itemId, tier });
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

/** The stock rules' numbers: the defaults with the owner's changes. */
export function useStockSettings(): StockSettings {
  const events = useShopHistory();
  return useMemo(() => stockSettingsFromEvents(events), [events]);
}

/** The owner changes one number; returns what is wrong in plain words, or the Undo. */
export const setStockSetting = <K extends keyof StockSettings>(
  key: K, value: number, before: number, owner: Actor,
): string | (() => void) => {
  const why = checkStockSetting(key, value);
  if (why) return why;
  appendEvent({ type: 'stock.settings_set', at: Date.now(), orderNumber: 0, actor: owner, key, value });
  return () => { appendEvent({ type: 'stock.settings_set', at: Date.now(), orderNumber: 0, actor: owner, key, value: before }); };
};

/** Open purchase orders, delivery times and the next numbers, from the whole history. */
export function usePurchases(): PurchaseState {
  const events = useShopHistory();
  return useMemo(() => purchasesFromEvents(events), [events]);
}

/** The packs with their amount in base units (2 packs of 25 kg: 50000 g), as the order records them. */
const withStockQty = (lines: PoLine[]): PoLine[] => {
  const items = readItems();
  return lines.filter((l) => l.packs > 0).map((l) => {
    const item = items.find((i) => i.id === l.itemId);
    return item ? { itemId: l.itemId, packs: l.packs, stockQty: l.packs * item.packQty } : { itemId: l.itemId, packs: l.packs };
  });
};

/**
 * Places a purchase order (lines with packs only). The number follows every PO this
 * device has seen. Returns the order and its Undo (cancels it).
 */
export const placeOrder = (supplierId: string, lines: PoLine[], poCount: number): { order: PurchaseOrder; undo: () => void } => {
  const kept = withStockQty(lines);
  const poNo = poNumber(Math.max(poCount, purchasesFromEvents(readAll()).poCount) + 1);
  const e = appendEvent({ type: 'stock.ordered', at: Date.now(), orderNumber: 0, actor: currentCashier(), poNo, supplierId, lines: kept });
  return {
    order: {
      id: e.id, poNo, supplierId, at: e.at, actor: e.actor, status: 'open', editable: true, cancelReason: null,
      lines: kept.map((l) => ({ itemId: l.itemId, packs: l.packs, stockQty: l.stockQty ?? null, received: 0, remaining: l.packs })),
    },
    undo: () => { cancelOrder(e.id, 'Undone right after placing'); },
  };
};

/**
 * Replaces an open order's lines (edit, remove a line, or add to it). Only while no GRN
 * stands against it. Returns the Undo (the lines as they were), or why it cannot.
 */
export const editOrder = (order: PurchaseOrder, lines: PoLine[]): (() => void) | string => {
  if (!order.editable) return `${order.poNo} has goods received against it: it can no longer be changed.`;
  const next = withStockQty(mergeLines(lines));
  if (next.length === 0) return 'An order needs at least one item. Cancel it instead.';
  const before = withStockQty(order.lines.map((l) => ({ itemId: l.itemId, packs: l.packs })));
  appendEvent({ type: 'stock.order_edited', at: Date.now(), orderNumber: 0, actor: currentCashier(), orderId: order.id, lines: next });
  return () => { appendEvent({ type: 'stock.order_edited', at: Date.now(), orderNumber: 0, actor: currentCashier(), orderId: order.id, lines: before }); };
};

/** Adds lines to an open order: the same item's packs add up. */
export const addToOrder = (order: PurchaseOrder, added: PoLine[]): (() => void) | string =>
  editOrder(order, [...order.lines.map((l) => ({ itemId: l.itemId, packs: l.packs })), ...added]);

/** Cancels an order, saying why; returns the Undo (the same order, same number, open again). */
export const cancelOrder = (orderId: string, reason: string): (() => void) => {
  appendEvent({ type: 'stock.order_cancelled', at: Date.now(), orderNumber: 0, actor: currentCashier(), orderId, reason });
  return () => { appendEvent({ type: 'stock.order_reopened', at: Date.now(), orderNumber: 0, actor: currentCashier(), orderId }); };
};

/**
 * Goods received against an order (GRN): stock in per line ('receive' adjustments) and
 * the GRN record, which closes the order. approvedBy: the manager who let a difference in.
 * Returns the GRN number and one Undo for all of it (the order opens again).
 */
export const receiveGoods = (
  order: PurchaseOrder, rows: InventoryRow[], lines: GrnLine[], approvedBy: Actor | null, grnCount: number,
): { grnNo: string; undo: () => void } => {
  const grnNo = grnNumber(Math.max(grnCount, purchasesFromEvents(readAll()).grnCount) + 1);
  const e = appendEvent({
    type: 'stock.grn', at: Date.now(), orderNumber: 0, actor: currentCashier(),
    grnNo, orderId: order.id, supplierId: order.supplierId, lines, approvedBy,
  });
  const moved = lines.flatMap((l) => {
    const row = rows.find((r) => r.id === l.itemId);
    const qty = row ? l.received * row.packQty : 0;
    return row && qty > 0 && addStockMovement('GRN', row.id, qty, e.id) ? [{ id: row.id, qty }] : [];
  });
  return {
    grnNo,
    undo: () => {
      moved.forEach((m) => addStockMovement('GRN_UNDO', m.id, -m.qty, e.id));
      appendEvent({ type: 'stock.grn_undone', at: Date.now(), orderNumber: 0, actor: currentCashier(), grnId: e.id });
    },
  };
};

/** Every standing shelf count, oldest first (the Manager page's progress). */
export function useCountHistory(): CountRecord[] {
  const events = useShopHistory();
  return useMemo(() => countHistory(events), [events]);
}

/** One item's story for its sheet (SCRUM-93): last count, delivery, price change, and what uses it. */
export function useItemStory(itemId: string, packQty = 0): ItemStory & { usedIn: string[]; history: HistoryEntry[] } {
  const events = useShopHistory();
  return useMemo(() => ({
    ...itemStory(events, itemId, packQty), history: itemHistory(events, itemId, packQty), usedIn: usedIn(menuItems(), answersFromEvents(events), itemId),
  }), [events, itemId, packQty]);
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
