import type { Actor } from './auth.ts';
import type { OrderEvent } from './events.ts';
import type { MenuEvent } from './menuEdits.ts';
import type { Cents } from './types.ts';
import type { InventoryItem, Supplier } from './inventoryData.ts';

/**
 * The sync contract between devices and the server (SCRUM-59, 60, 29, 30).
 * Read docs/sync-contract.md first. In short: the server stores events, it
 * never edits them; every device pushes the events it wrote and pulls or
 * streams everyone else's, then folds them into its own screens. Only
 * `src/ui/kitchenStore.ts` and `src/ui/eventLog.ts` talk to a SyncTransport.
 */

/** Kitchen actions become events too, so the counter and owner see them. */
interface KitchenBase {
  id: string;
  shopId: string;
  at: number;
  orderNumber: number;
  ticketId: string;
}

export type KitchenEvent =
  | (KitchenBase & { type: 'kitchen.seen' })
  | (KitchenBase & { type: 'kitchen.bumped' })
  | (KitchenBase & { type: 'kitchen.unbumped' });

/**
 * Stock changes (inventory), recorded like sales so they reach MySQL and the cloud
 * copy with who did them. Not about an order: `orderNumber` is always 0.
 */
interface StockBase {
  id: string;
  shopId: string;
  at: number;
  orderNumber: 0;
  actor: Actor;
}

interface StockItemBase extends StockBase {
  itemId: string;
}

export type StockEvent =
  | (StockItemBase & { type: 'stock.adjusted'; deltaPacks: number; reason?: 'waste' | 'audit' | 'receive' })
  | (StockItemBase & { type: 'stock.price_set'; before: Cents; after: Cents })
  | (StockBase & { type: 'stock.item_added'; item: InventoryItem })
  | (StockBase & { type: 'stock.supplier_added'; supplier: Supplier; linkedItemIds: string[] })
  | (StockItemBase & { type: 'stock.item_archived' | 'stock.item_restored' })
  | (StockBase & { type: 'stock.supplier_archived' | 'stock.supplier_restored'; supplierId: string });

// Recipe updated event: dynamic BOM changes
interface RecipeUpdatedBase {
  id: string;
  shopId: string;
  at: number;
  orderNumber: 0;
  actor: Actor;
  menuItemId: string;
  ingredients: Array<{ inventoryId: string; qtyBaseUnits: number }>;
}
export type RecipeUpdatedEvent = RecipeUpdatedBase & { type: 'recipe.updated' };

/** Everything that syncs. Menu changes: src/domain/menuEdits.ts. */
export type SyncEvent = OrderEvent | KitchenEvent | StockEvent | RecipeUpdatedEvent | MenuEvent;

/** An event before the log gives it an id and stamps the shop. */
export type NewSyncEvent = SyncEvent extends infer E ? (E extends SyncEvent ? Omit<E, 'id' | 'shopId'> : never) : never;

export const KITCHEN_EVENT_TYPES = ['kitchen.seen', 'kitchen.bumped', 'kitchen.unbumped'] as const;
export const STOCK_EVENT_TYPES = [
  'stock.adjusted', 'stock.price_set', 'stock.item_added', 'stock.supplier_added',
  'stock.item_archived', 'stock.item_restored', 'stock.supplier_archived', 'stock.supplier_restored',
] as const satisfies readonly StockEvent['type'][];
export const RECIPE_EVENT_TYPES = ['recipe.updated'] as const satisfies readonly RecipeUpdatedEvent['type'][];
export const ORDER_EVENT_TYPES = [
  'order.sent', 'order.send_undone', 'order.paid', 'order.payment_undone', 'order.item_changed', 'order.item_cancelled',
  'order.line_removed', 'order.line_adjusted', 'order.discount_set', 'order.comped', 'order.change_undone',
] as const satisfies readonly OrderEvent['type'][];

/** An event as the server hands it back: who wrote it, and where it sits in the shop's history. */
export interface SyncedEvent {
  event: SyncEvent;
  deviceId: string;
  /** Server order for this shop. Strictly increasing; gaps are allowed. Apply in this order. */
  seq: number;
  /** Server clock (ms) when the event was accepted. Kitchen timers count from this. */
  receivedAt: number;
}

// ----- Wire format (JSON over HTTPS / WSS) -----

/** POST /api/v1/events */
export interface PushRequest {
  deviceId: string;
  events: SyncEvent[];
}
export interface PushResponse {
  /** One entry per event stored, including ones the server already had (pushing twice is safe). */
  accepted: { id: string; seq: number }[];
  /**
   * Events the server refuses for good (SCRUM-41): the person was not logged in on this
   * device at that moment, or their role does not allow it. Not stored; never retried.
   */
  rejected?: { id: string; reason: string }[];
  serverTime: number;
}

/** POST /api/v1/login: a PIN at the counter. `manager` = manager mode (managers and owners only). */
export interface LoginRequest {
  pin: string;
  purpose: 'shift' | 'manager';
}
export interface LoginResponse {
  actor: Actor;
  /** Server clock: the session ends here (the screen locks well before, after a few quiet minutes). */
  expiresAt: number;
  serverTime: number;
}

/** GET /api/v1/events?after=<seq>&limit=<n> */
export interface PullResponse {
  events: SyncedEvent[];
  lastSeq: number;
  /** True when there are more after `lastSeq`: pull again straight away. */
  more: boolean;
  serverTime: number;
}

/** WSS /api/v1/stream?after=<seq>: server → device only. */
export type StreamMessage =
  | { type: 'hello'; lastSeq: number; serverTime: number }
  | { type: 'event'; data: SyncedEvent };

/** What the server sends on any 4xx/5xx. */
export interface ApiError {
  error: 'unauthorized' | 'wrong_shop' | 'forbidden' | 'invalid_event' | 'printer' | 'wrong_pin' | 'too_many' | 'server';
  message: string;
}

/** The only thing the client needs from the network. HTTP + WebSocket today; a fake in tests. */
export interface SyncTransport {
  push(req: PushRequest): Promise<PushResponse>;
  pull(afterSeq: number, limit: number): Promise<PullResponse>;
  /** Returns a function that closes the stream. `onClose` fires on any disconnect. */
  stream(afterSeq: number, onMessage: (m: StreamMessage) => void, onClose: () => void): () => void;
}

export type SyncStatus = 'synced' | 'pending' | 'offline';

// ----- Rules every client follows (pure, tested) -----

export const PUSH_BATCH = 100;
export const PULL_LIMIT = 500;

/** Local events the server has not confirmed yet, oldest first, at most one batch. */
export const pendingEvents = (local: SyncEvent[], acked: ReadonlySet<string>, batch = PUSH_BATCH): SyncEvent[] =>
  local.filter((e) => !acked.has(e.id)).slice(0, batch);

/** Incoming events this device has not applied yet, deduplicated and in server order. */
export const newRemoteEvents = (known: ReadonlySet<string>, incoming: SyncedEvent[]): SyncedEvent[] => {
  const seen = new Set(known);
  return [...incoming]
    .sort((a, b) => a.seq - b.seq)
    .filter((s) => (seen.has(s.event.id) ? false : (seen.add(s.event.id), true)));
};

/** Retry after a failed push or a dropped stream: 1 s, 2 s, 4 s … capped at 60 s. */
export const retryDelayMs = (attempt: number): number => Math.min(60_000, 1000 * 2 ** Math.max(0, attempt));

/**
 * How far this device's clock is behind the server's, from one round trip.
 * Add it to Date.now() to get server time (the kitchen's mm:ss timers need this).
 */
export const clockOffsetMs = (serverTime: number, sentAt: number, receivedAt: number): number =>
  Math.round(serverTime - (sentAt + receivedAt) / 2);

export const syncStatus = (online: boolean, pendingCount: number): SyncStatus =>
  !online ? 'offline' : pendingCount > 0 ? 'pending' : 'synced';
