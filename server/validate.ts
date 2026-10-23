import { isPhotoId } from '../src/domain/photos.ts';
import { isNote } from '../src/domain/gapReview.ts';
import { isUnitId } from '../src/domain/counting.ts';
import { MENU } from '../src/domain/menu.ts';
import { checkStockSetting } from '../src/domain/stockSettings.ts';
import { checkAnswer, RECIPE_EVENT_TYPES, type Answer } from '../src/domain/costing.ts';
import { isGapReason } from '../src/domain/counting.ts';
import { checkWaste } from '../src/domain/waste.ts';
import { checkNewItem, checkOverride, MENU_EVENT_TYPES, NEW_ITEM_ID, type ItemOverride, type NewItem } from '../src/domain/menuEdits.ts';
import type { MenuItem } from '../src/domain/types.ts';
import {
  KITCHEN_EVENT_TYPES, MOVEMENT_KINDS, ORDER_EVENT_TYPES, PUSH_BATCH, STOCK_EVENT_TYPES, type SyncEvent,
} from '../src/domain/sync.ts';

const TYPES = new Set<string>([
  ...ORDER_EVENT_TYPES, ...KITCHEN_EVENT_TYPES, ...STOCK_EVENT_TYPES, ...MENU_EVENT_TYPES, ...RECIPE_EVENT_TYPES,
]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const shortString = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isAddedId = (v: unknown): v is string => typeof v === 'string' && NEW_ITEM_ID.test(v);
const onMenu = (itemId: unknown): boolean => MENU.some((entry) => entry.id === itemId) || isAddedId(itemId);
/**
 * An item the owner added: the server checks one event at a time, so it does not know which
 * section it is in. Any section's sizes and extras pass; the menu ignores what the item lacks.
 */
const ANY_ADDED: MenuItem = {
  id: 'new-item', category: 'pizza', name: { en: 'This item' }, description: '', aliases: [],
  variants: (['S', 'M', 'L'] as const).map((id) => ({ id, label: id, price: 0 })), price: 0,
  adds: MENU.flatMap((m) => m.adds), leaveOut: [],
};
const validNewItem = (value: unknown): boolean =>
  value === null || (isObj(value) && isObj(value.name) && isObj(value.prices) &&
    Object.entries(value.name).every(([key, name]) => ['en', 'si', 'ta'].includes(key) && typeof name === 'string') &&
    Object.values(value.prices).every((price) => typeof price === 'number') &&
    Object.keys(value).every((key) => ['category', 'name', 'description', 'prices'].includes(key)) &&
    checkNewItem(value as unknown as NewItem, MENU) === null);
const validOverride = (itemId: unknown, value: unknown): boolean => {
  if (!isObj(value)) return false;
  const item = MENU.find((entry) => entry.id === itemId) ?? (isAddedId(itemId) ? ANY_ADDED : undefined);
  if (!item) return false;
  if (value.name !== undefined && (!isObj(value.name) ||
      Object.entries(value.name).some(([key, name]) =>
        !['en', 'si', 'ta'].includes(key) || (name !== undefined && typeof name !== 'string')))) return false;
  if (value.description !== undefined && typeof value.description !== 'string') return false;
  if (value.hidden !== undefined && typeof value.hidden !== 'boolean') return false;
  if (value.prices !== undefined && (!isObj(value.prices) ||
      Object.values(value.prices).some((price) => typeof price !== 'number'))) return false;
  if (value.adds !== undefined && (!isObj(value.adds) ||
      Object.values(value.adds).some((price) => typeof price !== 'number'))) return false;
  return checkOverride(item, value as ItemOverride) === null;
};

/**
 * The server checks the shape only (contract rule 3): it never changes an
 * event's body. The shop must be the device's own shop.
 * Returns a reason when the batch must be rejected, or the events.
 */
export const validatePush = (body: unknown, tenantId: string): { events: SyncEvent[] } | { reason: string; wrongShop?: boolean } => {
  if (!isObj(body) || !Array.isArray(body.events)) return { reason: 'body must be { deviceId, events: [] }' };
  if (body.events.length > PUSH_BATCH) return { reason: `at most ${PUSH_BATCH} events per push` };
  for (const [i, e] of body.events.entries()) {
    if (!isObj(e)) return { reason: `event ${i} is not an object` };
    if (!shortString(e.id)) return { reason: `event ${i} has no id` };
    if (!shortString(e.type, 40) || !TYPES.has(e.type)) return { reason: `event ${e.id} has an unknown type` };
    if (!Number.isSafeInteger(e.orderNumber) || (e.orderNumber as number) < 0) return { reason: `event ${e.id} has no orderNumber` };
    if (!Number.isSafeInteger(e.at)) return { reason: `event ${e.id} has no time` };
    if (e.shopId !== tenantId) return { reason: `event ${e.id} belongs to another shop`, wrongShop: true };
    if (e.type.startsWith('order.') || e.type.startsWith('stock.') || e.type.startsWith('menu.') || e.type.startsWith('recipe.')) {
      const a = e.actor;
      if (!isObj(a) || !shortString(a.id) || !shortString(a.name, 80) || !shortString(a.role, 16)) {
        return { reason: `event ${e.id} does not say who did it` };
      }
    }
    if (e.type === 'stock.adjusted' && (
      !shortString(e.itemId) || typeof e.deltaPacks !== 'number' || !Number.isFinite(e.deltaPacks) || e.deltaPacks === 0 ||
      (e.reason !== undefined && !['waste', 'audit', 'receive'].includes(String(e.reason)))
    )) return { reason: `event ${e.id} has an invalid stock change` };
    if (e.type === 'stock.movement' && (
      !shortString(e.itemId) || !shortString(e.docId, 80) || !MOVEMENT_KINDS.includes(e.kind as never) ||
      typeof e.qtyBase !== 'number' || !Number.isFinite(e.qtyBase) || e.qtyBase === 0 || Math.abs(e.qtyBase) > 1e9 ||
      (e.kind === 'GRN' && e.qtyBase < 0) || (e.kind === 'GRN_UNDO' && e.qtyBase > 0)
    )) return { reason: `event ${e.id} has an invalid stock movement` };
    if (e.type === 'stock.price_set' && (
      !shortString(e.itemId) || !Number.isSafeInteger(e.before) || !Number.isSafeInteger(e.after) ||
      (e.before as number) < 0 || (e.after as number) < 0 || (e.grnId !== undefined && !shortString(e.grnId))
    )) return { reason: `event ${e.id} has an invalid price` };
    if (e.type === 'stock.item_added') {
      const item = e.item;
      if (
        !isObj(item) || !shortString(item.id) || !shortString(item.name, 120) ||
        !shortString(item.category, 80) || !Array.isArray(item.supplierIds) ||
        item.supplierIds.length === 0 || !item.supplierIds.every((id) => shortString(id)) ||
        new Set(item.supplierIds).size !== item.supplierIds.length ||
        !['g', 'ml', 'pcs', 'sheets'].includes(String(item.baseUnit)) ||
        typeof item.packQty !== 'number' || !Number.isFinite(item.packQty) || item.packQty <= 0 ||
        !Number.isSafeInteger(item.workingPriceCents) || (item.workingPriceCents as number) < 0
      ) return { reason: `event ${e.id} has an invalid ingredient` };
    }
    if (e.type === 'stock.supplier_added') {
      const supplier = e.supplier;
      if (
        !isObj(supplier) || !shortString(supplier.id) || !shortString(supplier.name, 120) ||
        (supplier.phone !== undefined && !shortString(supplier.phone, 40)) ||
        !Array.isArray(e.linkedItemIds) || !e.linkedItemIds.every((id) => shortString(id)) ||
        new Set(e.linkedItemIds).size !== e.linkedItemIds.length
      ) return { reason: `event ${e.id} has an invalid supplier` };
    }
    if (
      (e.type === 'stock.item_archived' || e.type === 'stock.item_restored') &&
      !shortString(e.itemId)
    ) return { reason: `event ${e.id} has an invalid ingredient id` };
    if (
      (e.type === 'stock.supplier_archived' || e.type === 'stock.supplier_restored') &&
      !shortString(e.supplierId)
    ) return { reason: `event ${e.id} has an invalid supplier id` };
    if (e.type === 'stock.counted') {
      const amount = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= -1e9 && n <= 1e9;
      const entries = e.entries;
      if (
        !shortString(e.itemId) || !amount(e.counted) || (e.counted as number) < 0 || !amount(e.expected) ||
        !Array.isArray(entries) || entries.length > 10 ||
        !entries.every((x) => isObj(x) && shortString(x.unit, 40) && amount(x.qty) && (x.qty as number) >= 0) ||
        !(e.reason === null || isGapReason(e.reason)) || !Number.isSafeInteger(e.valueCents) ||
        !['daily', 'weekly', 'monthly'].includes(String(e.tier)) ||
        !(e.photo === undefined || e.photo === null || isPhotoId(e.photo)) ||
        !(e.note === undefined || shortString(e.note, 200)) || (e.reason === 'other' && !(typeof e.note === 'string' && e.note.trim()))
      ) return { reason: `event ${e.id} has an invalid count` };
    }
    if (e.type === 'stock.wasted' && checkWaste(e.what, e.qty, e.reason, e.note, e.name) !== null) return { reason: `event ${e.id} has an invalid waste` };
    if (e.type === 'stock.waste_undone' && !shortString(e.wasteId)) return { reason: `event ${e.id} has an invalid waste id` };
    if (e.type === 'stock.count_undone' && !shortString(e.countId)) return { reason: `event ${e.id} has an invalid count id` };
    if (e.type === 'stock.unit_set' && (
      !shortString(e.itemId) || !shortString(e.name, 20) || typeof e.base !== 'number' || !Number.isFinite(e.base) || (e.base as number) < 0
    )) return { reason: `event ${e.id} has an invalid unit` };
    if (e.type === 'stock.tier_set' && (!shortString(e.itemId) || !(e.tier === null || ['daily', 'weekly', 'monthly'].includes(String(e.tier))))) {
      return { reason: `event ${e.id} has an invalid count tier` };
    }
    const packs = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e6;
    const poLines = (lines: unknown): boolean => Array.isArray(lines) && lines.length > 0 && lines.length <= 200 &&
      lines.every((l) => isObj(l) && shortString(l.itemId) && packs(l.packs) && (l.packs as number) > 0 &&
        (l.stockQty === undefined || (typeof l.stockQty === 'number' && Number.isFinite(l.stockQty) && l.stockQty > 0 && l.stockQty <= 1e9)));
    if (e.type === 'stock.ordered' && ((e.poNo !== undefined && !shortString(e.poNo, 20)) || !shortString(e.supplierId) || !poLines(e.lines))) {
      return { reason: `event ${e.id} has an invalid purchase order` };
    }
    if (e.type === 'stock.order_edited' && (!shortString(e.orderId) || !poLines(e.lines))) return { reason: `event ${e.id} has an invalid order change` };
    if (e.type === 'stock.draft_set' && (!shortString(e.supplierId) || !(Array.isArray(e.lines) && (e.lines.length === 0 || poLines(e.lines))))) {
      return { reason: `event ${e.id} has an invalid draft order` };
    }
    if (e.type === 'stock.order_cancelled' && (!shortString(e.orderId) || !shortString(e.reason, 200))) {
      return { reason: `event ${e.id} cancels an order without saying why` };
    }
    if (e.type === 'stock.order_reopened' && !shortString(e.orderId)) return { reason: `event ${e.id} has an invalid order id` };
    if (e.type === 'stock.grn') {
      const by = e.approvedBy;
      const lines = e.lines;
      if (
        (e.grnNo !== undefined && !shortString(e.grnNo, 20)) || !shortString(e.orderId) || !shortString(e.supplierId) || !Array.isArray(lines) || lines.length > 200 ||
        !lines.every((l) => isObj(l) && shortString(l.itemId) && packs(l.ordered) && packs(l.received) && (l.accepted === undefined || packs(l.accepted)) && (l.returned === undefined || packs(l.returned))) ||
        !(by === null || (isObj(by) && shortString(by.id) && shortString(by.name, 80) && (by.role === 'manager' || by.role === 'owner'))) ||
        !(e.shortDecision === undefined || e.shortDecision === 'wait' || e.shortDecision === 'close') ||
        !(e.overDecision === undefined || e.overDecision === 'accept' || e.overDecision === 'return')
      ) return { reason: `event ${e.id} has an invalid goods received note` };
      const rows = lines as { ordered: number; received: number; accepted?: number; returned?: number }[];
      // A delivery that differs from its order needs a manager's approval and the decisions.
      if (by === null && rows.some((l) => l.received !== l.ordered)) return { reason: `event ${e.id} differs from its order without a manager's approval` };
      if (rows.some((l) => l.received < l.ordered) && e.shortDecision === undefined) return { reason: `event ${e.id} is short but does not say wait or close` };
      if (rows.some((l) => l.received > l.ordered) && e.overDecision === undefined) return { reason: `event ${e.id} has extra but does not say accept or return` };
      // The stock a GRN puts in is worked out from accepted: it must be exactly what the decisions allow.
      for (const l of rows) {
        if (l.accepted === undefined) continue;
        const accepted = l.received > l.ordered && e.overDecision === 'return' ? l.ordered : l.received;
        if (Math.abs(l.accepted - accepted) > 1e-6 || Math.abs((l.returned ?? 0) - (l.received - accepted)) > 1e-6) return { reason: `event ${e.id} puts the wrong amount into stock` };
      }
    }
    if (e.type === 'stock.numbered' && (!shortString(e.docId, 80) || (e.kind !== 'PO' && e.kind !== 'GRN') || !shortString(e.number, 20))) {
      return { reason: `event ${e.id} has an invalid document number` };
    }
    if (e.type === 'stock.settings_set') {
      const why = checkStockSetting(e.key, e.value);
      if (why) return { reason: `event ${e.id} has an invalid setting: ${why}` };
    }
    if (e.type === 'stock.grn_undone') {
      const by = e.approvedBy;
      if (!shortString(e.grnId) || !shortString(e.reason, 200) || !(isObj(by) && shortString(by.id) && shortString(by.name, 80) && (by.role === 'manager' || by.role === 'owner'))) {
        return { reason: `event ${e.id} undoes a GRN without a manager or a reason` };
      }
    }
    if (e.type === 'stock.receive_unit_set' && (!shortString(e.itemId) || !isUnitId(e.unit))) {
      return { reason: `event ${e.id} has an invalid receiving unit` };
    }
    if ((e.type === 'stock.gap_reviewed' || e.type === 'stock.gap_answered') && (
      !shortString(e.itemId) || !shortString(e.countId) || !isNote(e.note) ||
      (e.type === 'stock.gap_reviewed' && e.decision !== 'ok' && e.decision !== 'ask')
    )) return { reason: `event ${e.id} has an invalid gap review` };
    if (e.type.startsWith('menu.') && e.orderNumber !== 0) return { reason: `event ${e.id} has an invalid menu order number` };
    if (e.type === 'recipe.answer_set') {
      const valid = (a: unknown) => a === null || (isObj(a) && checkAnswer(String(e.question), a as Answer) === null);
      if (e.orderNumber !== 0 || !shortString(e.question, 200) || !valid(e.before) || !valid(e.after)) {
        return { reason: `event ${e.id} has an invalid recipe answer` };
      }
    }
    if (e.type === 'recipe.viewed' && e.orderNumber !== 0) return { reason: `event ${e.id} has an invalid order number` };
    if (e.type === 'menu.item_set' &&
        (!shortString(e.itemId) || !validOverride(e.itemId, e.before) || !validOverride(e.itemId, e.after))) {
      return { reason: `event ${e.id} has an invalid menu change` };
    }
    if (e.type === 'menu.sold_out' &&
        (!shortString(e.itemId) || !onMenu(e.itemId) ||
          (e.until !== null && !Number.isSafeInteger(e.until)))) {
      return { reason: `event ${e.id} has an invalid sold-out change` };
    }
    if (e.type === 'menu.item_added' && (!isAddedId(e.itemId) || !validNewItem(e.item))) {
      return { reason: `event ${e.id} has an invalid new menu item` };
    }
  }
  return { events: body.events as SyncEvent[] };
};
