import { useEffect, useMemo, useState } from 'react';
import { answersFromEvents, type Answer, type CostContext } from '../domain/costing.ts';
import type { Actor } from '../domain/auth.ts';
import { countHistory, gapOf, type CountEntry, type CountRecord, type GapReason, type Tier } from '../domain/counting.ts';
import type { SyncEvent } from '../domain/sync.ts';
import { addEvents, appendEvent, dismissRejection, readAll, readRejections, subscribeEvents, type Rejection } from '../ui/eventLog.ts';
import { numberingOf, numbersFor, pendingNumber, type DocKind } from '../domain/docNumbers.ts';
import { inventoryFromEvents, stockFromEvents, suppliersFromEvents, validateSeed, type InventoryRow } from '../domain/inventory.ts';
import type { InventoryItem, Supplier } from '../domain/inventoryData.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from '../domain/inventoryData.ts';
import type { Cents } from '../domain/types.ts';
import { currentCashier, numbersLocally, shopId } from './auth.ts';
import { newLineId } from '../domain/order.ts';
import { useShopEvents } from './ownerData.ts';
import { itemHistory, itemStory, usedIn, type HistoryEntry, type ItemStory } from '../domain/itemStory.ts';
import { gapCases, type GapCase } from '../domain/gapReview.ts';
import { menuItems } from '../domain/menu.ts';
import { grnProblem, mergeLines, purchasesFromEvents, settleGrn, undoCheck, type GrnDecisions, type PurchaseOrder, type PurchaseState } from '../domain/purchaseOrders.ts';
import type { GrnLine, MovementKind, PoLine } from '../domain/sync.ts';
import { checkStockSetting, stockSettingsFromEvents, type StockSettings } from '../domain/stockSettings.ts';
import type { WasteChoice, WasteReason } from '../domain/waste.ts';

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

/**
 * This device's own records, without the ones the shop server refused (a GRN for an order
 * another device had already received, say): they never happened, so they never count.
 */
const readLive = (): SyncEvent[] => {
  const all = readAll();
  const refused = new Set(readRejections().map((r) => r.id));
  return refused.size ? all.filter((e) => !refused.has(e.id)) : all;
};

/** What the server refused and the person has not read yet, to tell them. */
export function useRejections(): Rejection[] {
  const [list, setList] = useState(() => readRejections().filter((r) => !r.dismissed));
  useEffect(() => subscribeEvents(() => setList(readRejections().filter((r) => !r.dismissed))), []);
  return list;
}
export { dismissRejection };

const readAllItems = (): InventoryRow[] => inventoryFromEvents(SEED_INVENTORY, readLive());
/** The ingredient list (amounts here cover two days only: use useInventory for stock). */
export const readItems = (): InventoryRow[] => readAllItems().filter((item) => !item.archived);
export const readSuppliers = (includeArchived = false): Supplier[] =>
  suppliersFromEvents(SEED_SUPPLIERS, readLive(), includeArchived);

/** An ingredient typed in Add Supplier: its name, what it is bought in and what one costs. */
export type NewIngredient = Pick<InventoryItem, 'name' | 'baseUnit' | 'packQty' | 'workingPriceCents'>;

/** The checks Add and Edit Supplier share; returns the ingredients to link and the new ones to create. */
const supplierInput = (
  supplier: Supplier,
  others: Supplier[],
  linkedItemIds: string[],
  newIngredients: NewIngredient[],
): { linked: Set<string>; toCreate: InventoryItem[] } => {
  const items = readItems();
  if (others.some((existing) => existing.name.trim().toLowerCase() === supplier.name.trim().toLowerCase())) {
    throw new Error('A supplier with this name already exists.');
  }
  if (!supplier.name.trim()) throw new Error('Enter a supplier name.');
  if (supplier.name.trim().length > 120) throw new Error('Supplier name must be 120 characters or fewer.');
  if (supplier.phone !== undefined && !supplier.phone.trim()) throw new Error('Enter a phone number or leave it blank.');
  if (supplier.phone && supplier.phone.trim().length > 40) throw new Error('Phone number must be 40 characters or fewer.');
  if (new Set(linkedItemIds).size !== linkedItemIds.length) throw new Error('An ingredient is selected more than once.');
  if (linkedItemIds.some((id) => !items.some((item) => item.id === id))) throw new Error('A selected ingredient no longer exists.');
  const normalizedNames = newIngredients.map(({ name }) => name.trim().toLowerCase());
  if (normalizedNames.some((name) => !name)) throw new Error('Ingredient names cannot be blank.');
  if (normalizedNames.some((name) => name.length > 120)) throw new Error('Ingredient names must be 120 characters or fewer.');
  if (new Set(normalizedNames).size !== normalizedNames.length) throw new Error('An ingredient is selected more than once.');

  const linked = new Set(linkedItemIds);
  const existingNames = new Map(items.map((item) => [item.name.trim().toLowerCase(), item.id]));
  const toCreate: InventoryItem[] = [];
  for (const ingredient of newIngredients) {
    const existingId = existingNames.get(ingredient.name.trim().toLowerCase());
    if (existingId) linked.add(existingId);
    else toCreate.push({ ...ingredient, id: `inv-${newLineId()}`, name: ingredient.name.trim(), category: 'General', supplierIds: [supplier.id] });
  }
  if (linked.size === 0 && toCreate.length === 0) {
    throw new Error('Select or add at least one ingredient for this supplier.');
  }

  const errors = validateSeed({ suppliers: [...others, supplier], items: toCreate });
  if (errors.length) throw new Error(errors.join(' '));
  return { linked, toCreate };
};

const trimmed = (supplier: Supplier): Supplier =>
  ({ ...supplier, name: supplier.name.trim(), ...(supplier.phone ? { phone: supplier.phone.trim() } : {}) });

export const addSupplier = (
  supplier: Supplier,
  linkedItemIds: string[],
  newIngredients: NewIngredient[] = [],
): void => {
  const suppliers = readSuppliers(true);
  if (suppliers.some((existing) => existing.id === supplier.id)) throw new Error('A supplier with this id already exists.');
  const { linked, toCreate } = supplierInput(supplier, suppliers, linkedItemIds, newIngredients);

  const actor = currentCashier();
  for (const item of toCreate) {
    appendEvent({ type: 'stock.item_added', at: Date.now(), orderNumber: 0, actor, item });
    linked.add(item.id);
  }

  appendEvent({
    type: 'stock.supplier_added',
    at: Date.now(),
    orderNumber: 0,
    actor,
    supplier: trimmed(supplier),
    linkedItemIds: [...linked],
  });
};

/** The ingredients a supplier supplies now (active ones: the ones Edit Supplier shows). */
export const suppliedItemIds = (supplierId: string): string[] =>
  readItems().filter((item) => item.supplierIds.includes(supplierId)).map((item) => item.id);

/**
 * Edit Supplier: name, phone and what they supply, as one event with before and after,
 * so it is audited and Undo is the same event reversed. Returns that Undo.
 */
export const editSupplier = (
  supplier: Supplier,
  linkedItemIds: string[],
  newIngredients: NewIngredient[] = [],
): (() => void) => {
  const suppliers = readSuppliers(true);
  const before = suppliers.find((existing) => existing.id === supplier.id);
  if (!before) throw new Error('Supplier no longer exists.');
  const { linked, toCreate } = supplierInput(supplier, suppliers.filter((s) => s.id !== supplier.id), linkedItemIds, newIngredients);

  const actor = currentCashier();
  for (const item of toCreate) appendEvent({ type: 'stock.item_added', at: Date.now(), orderNumber: 0, actor, item });
  const was = new Set(suppliedItemIds(supplier.id));
  const after = trimmed(supplier);
  const change = {
    supplierId: supplier.id,
    before: { name: before.name, ...(before.phone ? { phone: before.phone } : {}) },
    after: { name: after.name, ...(after.phone ? { phone: after.phone } : {}) },
    linked: [...linked].filter((id) => !was.has(id)),
    unlinked: [...was].filter((id) => !linked.has(id)),
  };
  appendEvent({ type: 'stock.supplier_edited', at: Date.now(), orderNumber: 0, actor, ...change });
  return () => appendEvent({
    type: 'stock.supplier_edited', at: Date.now(), orderNumber: 0, actor: currentCashier(),
    supplierId: change.supplierId, before: change.after, after: change.before, linked: change.unlinked, unlinked: change.linked,
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
  row: InventoryRow, entries: CountEntry[], counted: number, reason: GapReason | null, tier: Tier, photo: string | null = null, note: string | null = null,
): (() => void) => {
  const expected = row.onHandBaseUnits;
  const { valueCents } = gapOf(expected, counted, row);
  const e = appendEvent({
    type: 'stock.counted', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId: row.id,
    counted, expected, entries, reason, valueCents, tier, ...(photo ? { photo } : {}), ...(note?.trim() ? { note: note.trim() } : {}),
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

/** "Order when below" this many packs (SCRUM-135; null: automatic), the owner's choice, signed by the owner's PIN. */
export const setOrderBelow = (itemId: string, packs: number | null, owner: Actor): void => {
  appendEvent({ type: 'stock.limit_set', at: Date.now(), orderNumber: 0, actor: owner, itemId, packs });
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
  const [local, setLocal] = useState(readLive);
  useEffect(() => subscribeEvents(() => setLocal(readLive())), []);
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
    return {
      ...l,
      ...(item ? { stockQty: l.packs * item.packQty } : {}),
      ...(l.unitPriceCents === undefined && item ? { unitPriceCents: item.workingPriceCents } : {}),
    };
  });
};

/**
 * A device with no server (the demo, development) numbers its own documents, with the same
 * function the server uses. A paired device or a phone never does: it waits for the server's
 * number, shown as "pending" until then. Returns the number, or null when it is pending.
 */
const numberLocally = (docId: string, kind: DocKind): string | null => {
  if (!numbersLocally()) return null;
  const events = readLive();
  const made = numbersFor(shopId(), Date.now(), [{ id: docId, kind }], numberingOf(events.filter((e) => e.id !== docId)));
  addEvents(made);
  const e = made[0];
  return e && e.type === 'stock.numbered' ? e.number : null;
};

/**
 * Places a purchase order (lines with quantities and agreed pack prices). The shop server numbers it; until that
 * number arrives it is "PO (pending)". Returns the order and its Undo (cancels it).
 */
export const placeOrder = (supplierId: string, lines: PoLine[]): { order: PurchaseOrder; undo: () => void } => {
  const kept = withStockQty(lines);
  const e = appendEvent({ type: 'stock.ordered', at: Date.now(), orderNumber: 0, actor: currentCashier(), supplierId, lines: kept });
  const poNo = numberLocally(e.id, 'PO') ?? pendingNumber('PO');
  return {
    order: {
      id: e.id, poNo, supplierId, at: e.at, actor: e.actor, status: 'open', editable: true, cancelReason: null,
      lines: kept.map((l) => ({
        itemId: l.itemId, packs: l.packs, stockQty: l.stockQty ?? null,
        ...(l.unitPriceCents === undefined ? {} : { unitPriceCents: l.unitPriceCents }),
        received: 0, remaining: l.packs,
      })),
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
  const withOrderPrices = lines.map((l) => {
    const existing = order.lines.find((old) => old.itemId === l.itemId);
    return l.unitPriceCents === undefined && existing?.unitPriceCents !== undefined
      ? { ...l, unitPriceCents: existing.unitPriceCents }
      : l;
  });
  const next = withStockQty(mergeLines(withOrderPrices));
  if (next.length === 0) return 'An order needs at least one item. Cancel it instead.';
  const before = withStockQty(order.lines.map((l) => ({
    itemId: l.itemId, packs: l.packs,
    ...(l.unitPriceCents === undefined ? {} : { unitPriceCents: l.unitPriceCents }),
  })));
  appendEvent({ type: 'stock.order_edited', at: Date.now(), orderNumber: 0, actor: currentCashier(), orderId: order.id, lines: next });
  return () => { appendEvent({ type: 'stock.order_edited', at: Date.now(), orderNumber: 0, actor: currentCashier(), orderId: order.id, lines: before }); };
};

/** Adds lines to an open order: the same item's packs add up. */
export const addToOrder = (order: PurchaseOrder, added: PoLine[]): (() => void) | string =>
  editOrder(order, [...order.lines.map((l) => ({
    itemId: l.itemId, packs: l.packs,
    ...(l.unitPriceCents === undefined ? {} : { unitPriceCents: l.unitPriceCents }),
  })), ...added]);

/** Each supplier's draft order as it stands now. */
export const readDrafts = (): Map<string, Record<string, number>> => purchasesFromEvents(readLive()).drafts;

const sameDraft = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([id, n]) => b[id] === n);

/**
 * Saves one supplier's draft whole (packs per item; none clears it) and returns the Undo, which
 * puts the draft back as it was. Nothing is written when nothing changed.
 */
export const setDraft = (supplierId: string, packs: Record<string, number>): (() => void) => {
  const kept = Object.fromEntries(Object.entries(packs).filter(([, n]) => n > 0));
  const before = readDrafts().get(supplierId) ?? {};
  if (sameDraft(before, kept)) return () => {};
  const write = (p: Record<string, number>) => appendEvent({
    type: 'stock.draft_set', at: Date.now(), orderNumber: 0, actor: currentCashier(), supplierId,
    lines: Object.entries(p).map(([itemId, n]) => ({ itemId, packs: n })),
  });
  write(kept);
  return () => { if (!sameDraft(readDrafts().get(supplierId) ?? {}, before)) write(before); };
};

/**
 * Puts an item on its supplier's draft at so many packs. A supplier with no draft yet starts from
 * `start` (what the reorder rule suggests), so those suggestions are not lost. Returns the draft and its Undo.
 */
export const addToDraft = (supplierId: string, itemId: string, packs: number, start: Record<string, number> = {}): { draft: Record<string, number>; undo: () => void } => {
  const draft = { ...(readDrafts().get(supplierId) ?? start), [itemId]: packs };
  return { draft, undo: setDraft(supplierId, draft) };
};

/**
 * Moves an item from one supplier's cart (`fromCart`, as it stands) to another's, at the same packs.
 * A supplier with no saved cart yet starts from `toStart` (its suggestions). One Undo puts both back.
 */
export const moveToCart = (itemId: string, from: string, to: string, fromCart: Record<string, number>, toStart: Record<string, number> = {}): {
  cart: Record<string, number>; undo: () => void;
} => {
  const { [itemId]: packs = 1, ...rest } = fromCart;
  const added = addToDraft(to, itemId, packs, toStart);
  const removed = setDraft(from, rest);
  return { cart: rest, undo: () => { added.undo(); removed(); } };
};

/** Cancels an order, saying why; returns the Undo (the same order, same number, open again). */
export const cancelOrder = (orderId: string, reason: string): (() => void) => {
  appendEvent({ type: 'stock.order_cancelled', at: Date.now(), orderNumber: 0, actor: currentCashier(), orderId, reason });
  return () => { appendEvent({ type: 'stock.order_reopened', at: Date.now(), orderNumber: 0, actor: currentCashier(), orderId }); };
};

/**
 * Goods received against an order (GRN): ONE record that carries what was owed, what came,
 * what went into stock and what was returned, the manager's approval and decisions. The
 * stock movement is worked out from it, so a GRN either happens whole or not at all.
 * What an item came at becomes its price (one audited stock.price_set each, marked with the
 * GRN), so food costs and the next order use the latest delivery. Returns the GRN and how many
 * prices it changed, or why it is not allowed (`grnProblem`).
 */
export const receiveGoods = (
  order: PurchaseOrder, lines: GrnLine[], decisions: GrnDecisions, approvedBy: Actor | null,
): { grnNo: string; id: string; prices: number } | string => {
  const why = grnProblem(order, lines, decisions, approvedBy);
  if (why) return why;
  const settled = settleGrn(lines, decisions.over);
  const e = appendEvent({
    type: 'stock.grn', at: Date.now(), orderNumber: 0, actor: currentCashier(),
    orderId: order.id, supplierId: order.supplierId, lines: settled, approvedBy,
    ...(decisions.short ? { shortDecision: decisions.short } : {}), ...(decisions.over ? { overDecision: decisions.over } : {}),
  });
  const items = readItems();
  let prices = 0;
  for (const l of settled) {
    const row = items.find((i) => i.id === l.itemId);
    const cents = l.unitPriceCents;
    if (!row || cents === undefined || !(cents > 0) || !((l.accepted ?? l.received) > 0) || cents === row.workingPriceCents) continue;
    appendEvent({ type: 'stock.price_set', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId: l.itemId, before: row.workingPriceCents, after: cents, grnId: e.id });
    prices++;
  }
  return { grnNo: numberLocally(e.id, 'GRN') ?? pendingNumber('GRN'), id: e.id, prices };
};

/**
 * Takes a GRN back: only the latest of its order, within the allowed hours, by a manager
 * (their PIN, checked by the screen), with a reason. Its stock comes off exactly; the
 * order goes back to what it was; the GRN stays on record, marked undone.
 */
export const undoGrn = (purchases: PurchaseState, grnId: string, reason: string, manager: Actor, hours: number): string | null => {
  const why = undoCheck(purchases, grnId, Date.now(), hours);
  if (why) return why;
  if (!reason.trim()) return 'Say why it is being undone.';
  appendEvent({ type: 'stock.grn_undone', at: Date.now(), orderNumber: 0, actor: currentCashier(), grnId, reason: reason.trim(), approvedBy: manager });
  // The prices it set go back, unless someone has changed the price since.
  const items = readItems();
  for (const p of readLive()) {
    if (p.type !== 'stock.price_set' || p.grnId !== grnId || p.before === p.after) continue;
    const row = items.find((i) => i.id === p.itemId);
    if (!row || row.workingPriceCents !== p.after) continue;
    appendEvent({ type: 'stock.price_set', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId: p.itemId, before: p.after, after: p.before, grnId });
  }
  return null;
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

/**
 * Thrown away (manager mode, the bin): one audited event that takes stock through the
 * recipes, like a sale (waste.ts). Returns the Undo.
 */
export const recordWaste = (choice: WasteChoice, qty: number, reason: WasteReason, note: string, actor: Actor): (() => void) => {
  const e = appendEvent({
    type: 'stock.wasted', at: Date.now(), orderNumber: 0, actor, what: choice.what, name: choice.name, qty, reason,
    ...(note.trim() ? { note: note.trim() } : {}),
  });
  return () => { appendEvent({ type: 'stock.waste_undone', at: Date.now(), orderNumber: 0, actor, wasteId: e.id }); };
};

/** The Recipes screen was opened: who and when, in the audit trail. */
export const recipesViewed = (actor: Actor): void => {
  appendEvent({ type: 'recipe.viewed', at: Date.now(), orderNumber: 0, actor });
};
