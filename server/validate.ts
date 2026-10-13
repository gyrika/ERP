import { KITCHEN_EVENT_TYPES, ORDER_EVENT_TYPES, PUSH_BATCH, STOCK_EVENT_TYPES, type SyncEvent } from '../src/domain/sync.ts';

const TYPES = new Set<string>([...ORDER_EVENT_TYPES, ...KITCHEN_EVENT_TYPES, ...STOCK_EVENT_TYPES]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const shortString = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

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
    if (e.type.startsWith('order.') || e.type.startsWith('stock.')) {
      const a = e.actor;
      if (!isObj(a) || !shortString(a.id) || !shortString(a.name, 80) || !shortString(a.role, 16)) {
        return { reason: `event ${e.id} does not say who did it` };
      }
    }
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
  }
  return { events: body.events as SyncEvent[] };
};
