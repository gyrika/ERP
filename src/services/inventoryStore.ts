import { useEffect, useMemo, useState } from 'react';
import { answersFromEvents, type Answer, type CostContext } from '../domain/costing.ts';
import type { Actor } from '../domain/auth.ts';
import { countHistory, gapOf, type CountEntry, type CountRecord, type GapReason, type Tier } from '../domain/counting.ts';
import type { SyncEvent } from '../domain/sync.ts';
import { addEvents, appendEvent, dismissRejection, readAll, readRejections, subscribeEvents, type Rejection } from '../ui/eventLog.ts';
import { numberingOf, numbersFor, pendingNumber, type DocKind } from '../domain/docNumbers.ts';
import { inventoryFromEvents, stockFromEvents, suppliersFromEvents, validateSeed, type InventoryRow, type Stock } from '../domain/inventory.ts';
import { planProduction, type Plan } from '../domain/production.ts';
import { holdsBatches, releasesDue } from '../domain/scheduler.ts';
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
import { prepItems, type PrepItem, type PrepStock } from '../domain/prep.ts';
import { draftEvent, draftsFromEvents, type Draft, type PublishStep } from '../domain/recipeDrafts.ts';
import { trendDays, valuationOf, valueAt, type Valuation } from '../domain/valuation.ts';
import { byWarehouse, checkMove, checkWarehouseName, shownSplit, warehousesFromEvents, type Split, type StockEntry, type WarehouseStock, type Warehouses } from '../domain/warehouses.ts';

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

/**
 * While ordering (SCRUM-185): this supplier sells this item too. One `stock.supplier_edited` that
 * only links it (name and phone unchanged); returns the Undo, which unlinks it again.
 */
export const linkToSupplier = (supplierId: string, itemId: string): (() => void) => {
  const supplier = readSuppliers(true).find((s) => s.id === supplierId);
  if (!supplier) throw new Error('Supplier no longer exists.');
  if (!readItems().some((i) => i.id === itemId)) throw new Error('That ingredient no longer exists.');
  const details = { name: supplier.name, ...(supplier.phone ? { phone: supplier.phone } : {}) };
  const actor = currentCashier();
  appendEvent({ type: 'stock.supplier_edited', at: Date.now(), orderNumber: 0, actor, supplierId, before: details, after: details, linked: [itemId], unlinked: [] });
  return () => appendEvent({ type: 'stock.supplier_edited', at: Date.now(), orderNumber: 0, actor, supplierId, before: details, after: details, linked: [], unlinked: [itemId] });
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
  /** Counting one warehouse (SCRUM-184): which, and what the app expects there. */
  where: { warehouseId: string; expected: number } | null = null,
): (() => void) => {
  const expected = where ? where.expected : row.onHandBaseUnits;
  const { valueCents } = gapOf(expected, counted, row);
  const e = appendEvent({
    type: 'stock.counted', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId: row.id,
    counted, expected, entries, reason, valueCents, tier, ...(photo ? { photo } : {}), ...(note?.trim() ? { note: note.trim() } : {}),
    ...(where ? { warehouseId: where.warehouseId } : {}),
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
export function useInventory(): { items: InventoryRow[]; allItems: InventoryRow[]; suppliers: Supplier[]; untrackedSold: number } {
  const events = useShopHistory();
  return useMemo(() => {
    const stock = stockFromEvents(SEED_INVENTORY, events);
    return {
      items: stock.rows.filter((item) => !item.archived),
      /** With archived ones, for goods still owed on an order placed before an item was archived. */
      allItems: stock.rows,
      suppliers: suppliersFromEvents(SEED_SUPPLIERS, events),
      untrackedSold: stock.untrackedSold,
    };
  }, [events]);
}

/** Stock value as it stands (SCRUM-163), from the same stock as Items and Visual Flow. */
export function useValuation(): Valuation {
  const events = useShopHistory();
  return useMemo(() => valuationOf(stockFromEvents(SEED_INVENTORY, events), answersFromEvents(events)), [events]);
}

/** Past days' values, by day end: kept while the events up to that day are the same. */
const pastValues = new Map<number, { n: number; last: string; cents: Cents }>();

/**
 * The last 30 days' stock value, oldest first; null while it is worked out. Thirty replays of
 * the history are slow on the counter PC, so they run after the screen shows, and a past day
 * is replayed again only when an event for it arrives late (a sync).
 */
export function useValueTrend(): { at: number; cents: Cents }[] | null {
  const events = useShopHistory();
  const [trend, setTrend] = useState<{ at: number; cents: Cents }[] | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      const days = trendDays(Date.now());
      const points = days.map((at, i) => {
        const upTo = events.filter((e) => e.at <= at);
        const key = { n: upTo.length, last: upTo[upTo.length - 1]?.id ?? '' };
        const kept = pastValues.get(at);
        if (i < days.length - 1 && kept && kept.n === key.n && kept.last === key.last) return { at, cents: kept.cents };
        const cents = valueAt(SEED_INVENTORY, upTo, at).total;
        if (i < days.length - 1) pastValues.set(at, { ...key, cents });
        return { at, cents };
      });
      for (const at of pastValues.keys()) if (at < days[0]) pastValues.delete(at);
      setTrend(points);
    }, 0);
    return () => clearTimeout(timer);
  }, [events]);
  return trend;
}

/** A semi-processed item with its stock (SCRUM-136): untracked until its first batch. */
export type PrepRow = PrepItem & Omit<PrepStock, 'key' | 'unit'>;

/** Every semi-processed item, his own then his sheet's, with what is on hand (from the whole history). */
export function usePreps(): PrepRow[] {
  const events = useShopHistory();
  return useMemo(() => {
    const stock = new Map(stockFromEvents(SEED_INVENTORY, events).preps.map((p) => [p.key, p]));
    return prepItems(answersFromEvents(events)).map((item) => {
      const p = stock.get(item.key);
      // Once made, the stock is counted in the unit its batches were recorded in.
      const unit = p?.tracked ? p.unit : item.unit;
      return { ...item, unit, tracked: p?.tracked ?? false, onHand: p?.onHand ?? 0, usedPerDay: p?.usedPerDay ?? 0, makeBelow: p?.makeBelow ?? null, lastMadeAt: p?.lastMadeAt ?? null, inKitchen: p?.inKitchen ?? 0,
        reserved: p?.reserved ?? 0, waiting: p?.waiting ?? 0, waitingFor: p?.waitingFor ?? [] };
    });
  }, [events]);
}

/**
 * The one stock ledger (raw, semi-processed and finished alike), from the whole history, and a
 * planner for sending to the kitchen with its dependencies: what Items and Visual Flow both read.
 */
export function useStock(): { stock: Stock; nameOf: (id: string) => string; plan: (key: string, qty: number, unit: string) => Plan } {
  const events = useShopHistory();
  return useMemo(() => {
    const stock = stockFromEvents(SEED_INVENTORY, events);
    const preps = prepItems(answersFromEvents(events));
    const nameOf = (id: string) => (id.startsWith('stock:')
      ? stock.rows.find((r) => r.id === id.slice('stock:'.length))?.name ?? 'An item'
      : preps.find((p) => `semi:${p.key}` === id)?.name ?? id.slice(id.indexOf(':') + 1));
    const plan = (key: string, qty: number, unit: string) => planProduction({ key, name: nameOf(`semi:${key}`), qty, unit }, stock.ledger, nameOf);
    return { stock, nameOf, plan };
  }, [events]);
}

/** Held batches the shop server sent to the kitchen in the last `minutes`, newest first: what to tell. */
export function useRecentReleases(minutes = 30): Extract<SyncEvent, { type: 'prep.released' }>[] {
  const events = useShopHistory();
  return useMemo(() => {
    const since = Date.now() - minutes * 60_000;
    return events.filter((e): e is Extract<SyncEvent, { type: 'prep.released' }> => e.type === 'prep.released' && e.at >= since).reverse();
  }, [events, minutes]);
}

/**
 * Sends a plan (production.ts): what the item is made from first, then the item itself, held until
 * its inputs are on hand; the shop server releases it to the kitchen. One Undo takes them all back.
 */
export const sendPlan = (plan: Plan, actor: Actor = currentCashier()): (() => void) => {
  if (plan.problem || !plan.batches.length) return () => {};
  const ids = plan.batches.map(() => newLineId());
  const target = ids.at(-1)!;
  plan.batches.forEach((b, i) => appendEvent({
    type: 'prep.ordered', at: Date.now(), orderNumber: 0, actor, ticketId: ids[i], prepId: b.prepId, name: b.name, qty: b.qty, unit: b.unit,
    ...(b.waitFor.length ? { waitFor: b.waitFor } : {}), ...(ids[i] !== target ? { plan: target } : {}),
  }));
  return () => { for (const ticketId of [...ids].reverse()) appendEvent({ type: 'prep.order_undone', at: Date.now(), orderNumber: 0, actor, ticketId }); };
};

/**
 * What production waits for, into each supplier's cart (packs, rounded up): the supplier the reorder
 * rule picks, else the last one, else the first. Returns the suppliers and one Undo; nothing is
 * received until a GRN says so.
 */
export const cartShortages = (buy: ReadonlyMap<string, number>, rows: readonly InventoryRow[], purchases: PurchaseState, active: ReadonlySet<string>): { suppliers: string[]; undo: () => void } => {
  const undos: (() => void)[] = [];
  const suppliers = new Set<string>();
  for (const [itemId, base] of buy) {
    const row = rows.find((r) => r.id === itemId);
    if (!row || !(base > 0)) continue;
    const last = purchases.lastSupplier.get(itemId);
    const to = (row.suggestedSupplierId && active.has(row.suggestedSupplierId) ? row.suggestedSupplierId : null)
      ?? (last && row.supplierIds.includes(last) && active.has(last) ? last : row.supplierIds.find((id) => active.has(id)));
    if (!to) continue;
    const cart = readDrafts().get(to) ?? {};
    const packs = Math.max(cart[itemId] ?? 0, Math.ceil(base / row.packQty - 1e-9));
    undos.push(addToDraft(to, itemId, packs).undo);
    suppliers.add(to);
  }
  return { suppliers: [...suppliers], undo: () => undos.reverse().forEach((u) => u()) };
};

/**
 * Without a shop server (the demo, development) this device releases held batches itself, from
 * its own records, the same way the server does.
 */
export const startLocalScheduler = (): (() => void) => {
  const run = () => {
    const events = readLive();
    if (!holdsBatches(events)) return;
    const made = releasesDue(SEED_INVENTORY, events, shopId(), Date.now());
    if (made.length) addEvents(made);
  };
  run();
  return subscribeEvents(run);
};

/** "Make more when below" (managers and the owner; audited). null: automatic. Returns the Undo. */
export const setMakeBelow = (key: string, before: number | null, after: number | null, actor: Actor): (() => void) => {
  appendEvent({ type: 'prep.limit_set', at: Date.now(), orderNumber: 0, actor, prepId: key, before, after });
  return () => { appendEvent({ type: 'prep.limit_set', at: Date.now(), orderNumber: 0, actor, prepId: key, before: after, after: before }); };
};

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

/** The warehouses and every item's home (SCRUM-184), from the whole history. */
export function useWarehouses(): Warehouses {
  const events = useShopHistory();
  return useMemo(() => warehousesFromEvents(events), [events]);
}

/** Every raw and semi-processed item as the warehouse views list it, with its value per unit (Items and Visual Flow). */
export const stockEntries = (stock: Stock, answers: ReadonlyMap<string, Answer>): StockEntry[] => {
  const values = new Map(valuationOf(stock, answers).items.map((v) => [v.id, v]));
  const preps = new Map(stock.preps.map((p) => [p.key, p]));
  return [
    ...stock.rows.filter((r) => !r.archived).map((r): StockEntry => ({
      key: `stock:${r.id}`, kind: 'raw', name: r.name, total: r.counted ? r.onHandBaseUnits : null, unit: r.baseUnit, unitCents: values.get(`stock:${r.id}`)?.unitCents ?? null,
    })),
    ...prepItems(answers).map((p): StockEntry => {
      const s = preps.get(p.key);
      return { key: `semi:${p.key}`, kind: 'semi', name: p.name, total: s?.tracked ? s.onHand : null, unit: s?.tracked ? s.unit : p.unit, unitCents: values.get(`semi:${p.key}`)?.unitCents ?? null };
    }),
  ];
};

/**
 * Where every raw and semi-processed item is (SCRUM-184): each warehouse with what it holds, and
 * each item's split by stock key, from the same stock as Items and Visual Flow.
 */
export function useWarehouseStock(): {
  warehouses: Warehouses; rows: WarehouseStock[]; entries: StockEntry[]; splitOf: (key: string) => { id: string; qty: number }[];
  /** Where each item is, by stock key, as the stock fold placed it (for counts: placedIn, roundsByWarehouse). */
  places: ReadonlyMap<string, Split>;
} {
  const events = useShopHistory();
  return useMemo(() => {
    const stock = stockFromEvents(SEED_INVENTORY, events);
    const entries = stockEntries(stock, answersFromEvents(events));
    const totals = new Map(entries.map((e) => [e.key, e.total]));
    const splitOf = (key: string) => { const t = totals.get(key); return t === null || t === undefined ? [] : shownSplit(stock.warehouses, stock.places, key, t); };
    return { warehouses: stock.warehouses, rows: byWarehouse(stock.warehouses, stock.places, entries), entries, splitOf, places: stock.places };
  }, [events]);
}

const now = () => Date.now();

/** The owner adds a warehouse; returns what is wrong in plain words, or the Undo (it is archived again). */
export const addWarehouse = (w: Warehouses, name: string, owner: Actor): string | (() => void) => {
  const why = checkWarehouseName(name) ?? nameTaken(w, name, null);
  if (why) return why;
  const warehouseId = `wh-${newLineId()}`;
  const after = { name: name.trim(), archived: false };
  appendEvent({ type: 'stock.warehouse_set', at: now(), orderNumber: 0, actor: owner, warehouseId, before: null, after });
  return () => { appendEvent({ type: 'stock.warehouse_set', at: now(), orderNumber: 0, actor: owner, warehouseId, before: after, after: { ...after, archived: true } }); };
};

const nameTaken = (w: Warehouses, name: string, id: string | null): string | null =>
  w.list.some((x) => x.id !== id && !x.archived && x.name.trim().toLowerCase() === name.trim().toLowerCase()) ? 'Another warehouse has that name.' : null;

/** The owner renames, archives or restores one; returns what is wrong, or the Undo. */
export const editWarehouse = (w: Warehouses, warehouseId: string, change: { name?: string; archived?: boolean }, owner: Actor): string | (() => void) => {
  const was = w.list.find((x) => x.id === warehouseId);
  if (!was) return 'That warehouse is not here.';
  const after = { name: (change.name ?? was.name).trim(), archived: change.archived ?? was.archived };
  const why = checkWarehouseName(after.name) ?? (after.archived ? null : nameTaken(w, after.name, warehouseId));
  if (why) return why;
  if (after.archived && w.kitchenSide === warehouseId) return 'This one is next to the kitchen. Pick another one for the kitchen first.';
  const before = { name: was.name, archived: was.archived };
  appendEvent({ type: 'stock.warehouse_set', at: now(), orderNumber: 0, actor: owner, warehouseId, before, after });
  return () => { appendEvent({ type: 'stock.warehouse_set', at: now(), orderNumber: 0, actor: owner, warehouseId, before: after, after: before }); };
};

/** The warehouse next to the kitchen, which sales take from first. Returns the Undo. */
export const setKitchenSide = (w: Warehouses, warehouseId: string, owner: Actor): (() => void) => {
  const before = w.kitchenSide;
  appendEvent({ type: 'stock.kitchen_side_set', at: now(), orderNumber: 0, actor: owner, before, after: warehouseId });
  return () => { appendEvent({ type: 'stock.kitchen_side_set', at: now(), orderNumber: 0, actor: owner, before: warehouseId, after: before }); };
};

/** An item's home warehouse, by stock key (`stock:<id>`, `semi:<key>`); managers and the owner. Returns the Undo. */
export const setHome = (w: Warehouses, stockKey: string, warehouseId: string, actor: Actor = currentCashier()): (() => void) => {
  const before = w.homes.get(stockKey) ?? null;
  appendEvent({ type: 'stock.home_set', at: now(), orderNumber: 0, actor, stockKey, before, after: warehouseId });
  return () => { appendEvent({ type: 'stock.home_set', at: now(), orderNumber: 0, actor, stockKey, before: warehouseId, after: before }); };
};

/** Stock carried between warehouses (the total stays); returns what is wrong, or the Undo. */
export const moveStock = (w: Warehouses, stockKey: string, from: string, to: string, qty: number, actor: Actor = currentCashier()): string | (() => void) => {
  const why = checkMove(w, stockKey, from, to, qty);
  if (why) return why;
  const e = appendEvent({ type: 'stock.moved', at: now(), orderNumber: 0, actor, stockKey, from, to, qty });
  return () => { appendEvent({ type: 'stock.move_undone', at: now(), orderNumber: 0, actor, moveId: e.id }); };
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
  const kept = withStockQty(mergeLines(lines));
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
/** Prices typed for each supplier's draft only (cents a pack). */
export const readDraftPrices = (): Map<string, Record<string, number>> => purchasesFromEvents(readLive()).draftPrices;

const sameDraft = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([id, n]) => b[id] === n);

/**
 * Saves one supplier's draft whole (packs per item; none clears it) and returns the Undo, which
 * puts the draft back as it was. Nothing is written when nothing changed. `prices`: a price per pack
 * for this order only (cents); left out, the draft keeps the prices it had for what stays in it.
 */
export const setDraft = (supplierId: string, packs: Record<string, number>, prices?: Record<string, number>): (() => void) => {
  const kept = Object.fromEntries(Object.entries(packs).filter(([, n]) => n > 0));
  const now = purchasesFromEvents(readLive());
  const before = now.drafts.get(supplierId) ?? {};
  const beforePrices = now.draftPrices.get(supplierId) ?? {};
  const keptPrices = Object.fromEntries(Object.entries(prices ?? beforePrices).filter(([id, c]) => id in kept && c > 0));
  if (sameDraft(before, kept) && sameDraft(beforePrices, keptPrices)) return () => {};
  const write = (p: Record<string, number>, c: Record<string, number>) => appendEvent({
    type: 'stock.draft_set', at: Date.now(), orderNumber: 0, actor: currentCashier(), supplierId,
    lines: Object.entries(p).map(([itemId, n]) => ({ itemId, packs: n, ...(c[itemId] ? { unitPriceCents: c[itemId] } : {}) })),
  });
  write(kept, keptPrices);
  return () => {
    const later = purchasesFromEvents(readLive());
    if (!sameDraft(later.drafts.get(supplierId) ?? {}, before) || !sameDraft(later.draftPrices.get(supplierId) ?? {}, beforePrices)) write(before, beforePrices);
  };
};

/**
 * Puts an item on its supplier's draft at so many packs. A supplier with no draft yet starts from
 * `start` (what the reorder rule suggests), so those suggestions are not lost. Returns the draft and its Undo.
 */
export const addToDraft = (
  supplierId: string, itemId: string, packs: number, start: Record<string, number> = {}, priceCents?: number,
): { draft: Record<string, number>; undo: () => void } => {
  const draft = { ...(readDrafts().get(supplierId) ?? start), [itemId]: packs };
  // A price typed for this order goes in the cart with it; the item's own price is not touched.
  const prices = { ...(readDraftPrices().get(supplierId) ?? {}), ...(priceCents && priceCents > 0 ? { [itemId]: priceCents } : {}) };
  return { draft, undo: setDraft(supplierId, draft, prices) };
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
  order: PurchaseOrder, lines: GrnLine[], decisions: GrnDecisions, approvedBy: Actor | null, note = '',
): { grnNo: string; id: string; prices: number } | string => {
  const why = grnProblem(order, lines, decisions, approvedBy);
  if (why) return why;
  const settled = settleGrn(lines, decisions.over);
  const e = appendEvent({
    type: 'stock.grn', at: Date.now(), orderNumber: 0, actor: currentCashier(),
    orderId: order.id, supplierId: order.supplierId, lines: settled, approvedBy,
    ...(decisions.short ? { shortDecision: decisions.short } : {}), ...(decisions.over ? { overDecision: decisions.over } : {}),
    // The approving manager's final note, if they wrote one.
    ...(approvedBy && note.trim() ? { note: note.trim().slice(0, 500) } : {}),
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
export function useItemStory(itemId: string, packQty = 0, priceCents?: Cents): ItemStory & { usedIn: string[]; history: HistoryEntry[] } {
  const events = useShopHistory();
  return useMemo(() => ({
    ...itemStory(events, itemId, packQty), history: itemHistory(events, itemId, packQty, priceCents), usedIn: usedIn(menuItems(), answersFromEvents(events), itemId),
  }), [events, itemId, packQty, priceCents]);
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
 * Visual Flow: the recipes as published, the owner's open drafts, and the history behind each
 * recipe's versions, all from the whole history (drafts sync like his answers).
 */
export function useFlowData(): { ctx: CostContext; drafts: Map<string, Draft>; events: SyncEvent[]; stock: Stock } {
  const events = useShopHistory();
  return useMemo(() => {
    // The same ledger as Items: one fold gives the price list and every item's stock.
    const stock = stockFromEvents(SEED_INVENTORY, events);
    return { ctx: { items: stock.rows, answers: answersFromEvents(events) }, drafts: draftsFromEvents(events), events, stock };
  }, [events]);
}

/** One draft change (null drops it), with the draft it replaces for the Undo. */
export const saveDraft = (question: string, after: Answer | null, before: Answer | null, actor: Actor): (() => void) => {
  appendEvent(draftEvent(question, after, actor));
  return () => { appendEvent(draftEvent(question, before, actor)); };
};

/**
 * Publish: each draft becomes his answer (a new version), which closes it. The Undo puts the
 * versions before back and reopens the drafts, so nothing he worked on is lost.
 */
export const publishDrafts = (steps: readonly PublishStep[], actor: Actor): (() => void) => {
  for (const s of steps) appendEvent({ type: 'recipe.answer_set', at: Date.now(), orderNumber: 0, actor, question: s.question, before: s.before, after: s.after });
  return () => {
    for (const s of steps) {
      appendEvent({ type: 'recipe.answer_set', at: Date.now(), orderNumber: 0, actor, question: s.question, before: s.after, after: s.before });
      appendEvent(draftEvent(s.question, s.after, actor));
    }
  };
};

/** Drop every open draft; the Undo brings them back. */
export const discardDrafts = (drafts: readonly Draft[], actor: Actor): (() => void) => {
  for (const d of drafts) appendEvent(draftEvent(d.question, null, actor));
  return () => { for (const d of drafts) appendEvent(draftEvent(d.question, d.answer, actor)); };
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
