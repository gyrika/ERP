import type { Actor } from './auth.ts';
import type { Cents, OrderLine, Tender } from './types.ts';

/**
 * The order event log: every send, payment and manager change, append-only.
 * It is the audit trail today and becomes the sync outbox in slice 4.
 */
interface Base {
  id: string;
  at: number;
  actor: Actor;
  orderNumber: number;
}

export type OrderEvent =
  | (Base & { type: 'order.sent'; ticketId: string; lines: OrderLine[]; addOn: boolean })
  | (Base & { type: 'order.send_undone'; ticketId: string })
  | (Base & { type: 'order.paid'; total: Cents; tender: Tender; tendered: Cents })
  | (Base & { type: 'order.payment_undone' })
  | (Base & { type: 'order.item_changed'; lineId: string; before: OrderLine; after: OrderLine; reason: string })
  | (Base & { type: 'order.item_cancelled'; lineId: string; before: OrderLine; reason: string });

/** An event before the log gives it an id. */
export type NewOrderEvent = OrderEvent extends infer E ? (E extends OrderEvent ? Omit<E, 'id'> : never) : never;
