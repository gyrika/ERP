import type { Actor } from './auth.ts';
import type { PlatformMark } from './platforms.ts';
import type { Cents, Discount, OnlineMark, OrderLine, Tender } from './types.ts';
import type { CameraSpec, TableSpec, TableState, VisionMode, ZoneSpec } from './tables.ts';

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
  /**
   * `held`: paid before it went to the kitchen (SCRUM-239). Sales and stock count it from here, as
   * sold; the kitchen sees it only at its `order.released`, when the cashier presses Send.
   */
  | (Base & { type: 'order.sent'; ticketId: string; lines: OrderLine[]; addOn: boolean; online?: OnlineMark; platform?: PlatformMark; held?: true })
  | (Base & { type: 'order.send_undone'; ticketId: string })
  /** A held send (paid first) goes to the kitchen now. */
  | (Base & { type: 'order.released'; ticketId: string })
  /** The customer has the food (SCRUM-240): handed over at the counter, or out with the rider. */
  | (Base & { type: 'order.given' })
  | (Base & { type: 'order.given_undone' })
  /**
   * `customerId` (CRM, customers.ts): the customer whose mobile number was given at Charge, an opaque
   * `cus-…` id. Never the number or the name: those stay in the shop server's customer list, where
   * they can be erased; events never change.
   */
  /**
   * `parts`: a split bill, paid in parts (split.ts): each part's tender, amount and what was handed
   * over. They add up to `total`; `tender`/`tendered` are then the part that took the most money,
   * for readers that know one tender only.
   */
  | (Base & { type: 'order.paid'; total: Cents; tender: Tender; tendered: Cents; customerId?: string; parts?: PaidPart[]; deliveryFee?: Cents })
  | (Base & { type: 'order.payment_undone' })
  /**
   * A paid order changed afterwards (SCRUM-242) and the difference settled: `amount` > 0 the
   * customer paid more, < 0 the shop gave money back (cash from the drawer). Adds to the latest
   * payment of that number still standing; it is not a sale of its own.
   */
  | (Base & { type: 'order.settled'; amount: Cents; tender: Tender; tendered: Cents })
  // Order changes (audited). Sent-item changes carry a reason: the manager's, or the counter's own
  // ("Before it was made" / "Already made") when a cashier changed it.
  // `made`: the kitchen had started or finished it, so what it used stays used (waste).
  // `remake` (SCRUM-242): thrown away and made again, so the kitchen gets the new version as a new
  // ticket (always `made`). Without it the kitchen's ticket changes in place.
  // `afterPay`: the order was already paid; the change belongs to that payment (see order.settled).
  | (Base & Audited & { type: 'order.item_changed'; lineId: string; before: OrderLine; after: OrderLine; reason: string; made?: boolean; remake?: true; afterPay?: true })
  | (Base & Audited & { type: 'order.item_cancelled'; lineId: string; index: number; before: OrderLine; reason: string; made?: boolean; afterPay?: true })
  | (Base & Audited & { type: 'order.line_removed'; lineId: string; index: number; before: OrderLine })
  | (Base & Audited & { type: 'order.line_adjusted'; lineId: string; before: Cents; after: Cents })
  | (Base & Audited & { type: 'order.discount_set'; before: Discount | null; after: Discount | null })
  | (Base & Audited & { type: 'order.comped'; before: Discount | null })
  | (Base & Audited & { type: 'order.change_undone'; undoneEventId: string; undoneType: string });

/** An event before the log gives it an id and stamps the shop. */
export type NewOrderEvent = OrderEvent extends infer E ? (E extends OrderEvent ? Omit<E, 'id' | 'shopId'> : never) : never;

/**
 * Tables and cameras (CV Table Management, SCRUM-166; rules and fold in tables.ts). Not about an
 * order: `orderNumber` is always 0. Never a password or an image: the server takes only these fields.
 */
interface FloorBase {
  id: string;
  shopId: string;
  at: number;
  orderNumber: 0;
  actor: Actor;
}

export type TableEvent =
  | (FloorBase & { type: 'table.layout_set'; tables: TableSpec[] })
  /** The camera saw the table change; confidence: the share of samples behind it (0-1). */
  | (FloorBase & { type: 'table.state_changed'; tableId: string; from: TableState; to: TableState; confidence: number })
  /** Staff changed the table (C, F …): it holds until presence next flips. */
  | (FloorBase & { type: 'table.state_set'; tableId: string; from: TableState; to: TableState })
  /** Undo of a staff change: puts back what it replaced (like order.change_undone). */
  | (FloorBase & { type: 'table.state_set_undone'; tableId: string; undoneEventId: string })
  | (FloorBase & { type: 'table.alert_raised'; tableId: string; alert: 'needs_cleaning' })
  | (FloorBase & { type: 'table.alert_cleared'; tableId: string; alertEventId: string });

export type VisionEvent =
  | (FloorBase & { type: 'vision.cameras_set'; cameras: CameraSpec[] })
  /** One camera's table zones; points normalised 0-1 to the frame. */
  | (FloorBase & { type: 'vision.zones_set'; cameraId: string; zones: ZoneSpec[] })
  /**
   * Since 2026-10-30 only `mode`: the table rules and the CPU limit are fixed in tables.ts. Older events
   * may also carry `cpuLimit` and `shortVisitS`, `leftCheckS`, `autoFreeS` (or `seatS`, `leaveS`,
   * `cleanAlertS`): they still sync, and the fold ignores them.
   */
  | (FloorBase & { type: 'vision.settings_set'; mode: VisionMode; cpuLimit?: number }
    & (object | { shortVisitS: number; leftCheckS: number; autoFreeS: number } | { seatS: number; leaveS: number; cleanAlertS: number }))
  | (FloorBase & { type: 'vision.camera_offline' | 'vision.camera_online'; cameraId: string })
  /** `slowed`: the CPU guard has the worker checking every 2 s, to protect the Register (SCRUM-170). */
  | (FloorBase & { type: 'vision.heartbeat'; cameras: { id: string; online: boolean; fps: number }[]; cpu: number; slowed?: boolean });

/** One part of a split payment, as the payment event carries it. */
export interface PaidPart { tender: Tender; amount: Cents; tendered: Cents }
