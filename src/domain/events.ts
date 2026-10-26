import type { Actor } from './auth.ts';
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
  | (Base & { type: 'order.sent'; ticketId: string; lines: OrderLine[]; addOn: boolean; online?: OnlineMark })
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
   * `cpuLimit` (SCRUM-174): percent of the shop PC the camera worker may use; missing = DEFAULT_CPU_LIMIT.
   * The timers (SCRUM-182, the owner's rules of 2026-10-26) are `shortVisitS`, `leftCheckS`, `autoFreeS`;
   * events from before carry `seatS`, `leaveS`, `cleanAlertS` instead, and fold to the default timers.
   */
  | (FloorBase & { type: 'vision.settings_set'; mode: VisionMode; cpuLimit?: number }
    & ({ shortVisitS: number; leftCheckS: number; autoFreeS: number } | { seatS: number; leaveS: number; cleanAlertS: number }))
  | (FloorBase & { type: 'vision.camera_offline' | 'vision.camera_online'; cameraId: string })
  | (FloorBase & { type: 'vision.heartbeat'; cameras: { id: string; online: boolean; fps: number }[]; cpu: number });
