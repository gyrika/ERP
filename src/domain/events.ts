import type { Actor } from './auth.ts';
import type { Cents, Discount, OrderLine, Tender } from './types.ts';

/**
 * The order event log: every send, payment and manager change, append-only.
 * It is the audit trail today and becomes the sync outbox (slice 4): every
 * event carries its shopId so the server can file it without a rewrite.
 * Nothing is ever edited or deleted; an Undo is a new event.
 */
interface Base {
  id: string;
  shopId: string;
  at: number;
  actor: Actor;
  orderNumber: number;
}

/** Every manager change records the order total before and after, in cents. */
interface Audited {
  totalBefore: Cents;
  totalAfter: Cents;
}

export type OrderEvent =
  | (Base & { type: 'order.sent'; ticketId: string; lines: OrderLine[]; addOn: boolean })
  | (Base & { type: 'order.send_undone'; ticketId: string })
  | (Base & { type: 'order.paid'; total: Cents; tender: Tender; tendered: Cents })
  | (Base & { type: 'order.payment_undone' })
  // Manager changes (audited). Sent-item changes carry the reason the manager gave.
  | (Base & Audited & { type: 'order.item_changed'; lineId: string; before: OrderLine; after: OrderLine; reason: string })
  | (Base & Audited & { type: 'order.item_cancelled'; lineId: string; index: number; before: OrderLine; reason: string })
  | (Base & Audited & { type: 'order.line_removed'; lineId: string; index: number; before: OrderLine })
  | (Base & Audited & { type: 'order.line_adjusted'; lineId: string; before: Cents; after: Cents })
  | (Base & Audited & { type: 'order.discount_set'; before: Discount | null; after: Discount | null })
  | (Base & Audited & { type: 'order.comped'; before: Discount | null })
  | (Base & Audited & { type: 'order.change_undone'; undoneEventId: string; undoneType: string });

/** An event before the log gives it an id and stamps the shop. */
export type NewOrderEvent = OrderEvent extends infer E ? (E extends OrderEvent ? Omit<E, 'id' | 'shopId'> : never) : never;
