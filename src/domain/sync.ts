import type { Actor } from './auth.ts';
import type { OrderEvent } from './events.ts';
import type { RecipeEvent } from './costing.ts';
import type { ShorthandEvent } from './shorthandMisses.ts';
import type { MenuEvent } from './menuEdits.ts';
import type { Cents } from './types.ts';
import type { InventoryItem, Supplier } from './inventoryData.ts';
import type { CountEntry, GapReason, Tier } from './counting.ts';
import type { StockSettings } from './stockSettings.ts';
import type { WasteReason, WasteWhat } from './waste.ts';

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
  /** The cook started on the ticket; with `kitchen.bumped` it times the cooking (cookLog). */
  | (KitchenBase & { type: 'kitchen.started' })
  | (KitchenBase & { type: 'kitchen.unstarted' })
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
  /** grnId: the price a GRN delivered at (and the GRN's Undo putting the old one back). */
  | (StockItemBase & { type: 'stock.price_set'; before: Cents; after: Cents; grnId?: string })
  | (StockBase & { type: 'stock.item_added'; item: InventoryItem })
  | (StockBase & { type: 'stock.supplier_added'; supplier: Supplier; linkedItemIds: string[] })
  | (StockItemBase & { type: 'stock.item_archived' | 'stock.item_restored' })
  | (StockBase & { type: 'stock.supplier_archived' | 'stock.supplier_restored'; supplierId: string })
  /** Edit Supplier: name and phone before/after, and the ingredients it now supplies or no longer does. */
  | (StockBase & {
    type: 'stock.supplier_edited'; supplierId: string;
    before: Omit<Supplier, 'id'>; after: Omit<Supplier, 'id'>; linked: string[]; unlinked: string[];
  })
  /**
   * A shelf count (counting.ts): what was left, what the app expected then (both in base
   * units), how it was counted, and why it differs when the gap is beyond the allowance.
   * The shelf becomes counted - expected + what it was, so concurrent sales stay exact.
   */
  | (StockItemBase & {
    type: 'stock.counted'; counted: number; expected: number; entries: CountEntry[];
    reason: GapReason | null; valueCents: Cents; tier: Tier;
    /** What happened, when the reason is Other. */
    note?: string;
    /** The shelf photo taken as proof of a big gap (SCRUM-94), kept on the shop PC. */
    photo?: string | null;
  })
  /** Takes back a count (Undo on the count screen). */
  | (StockBase & { type: 'stock.count_undone'; countId: string })
  /** A unit learned for an item: "Tray" = 30 pcs (base: 0 removes it). */
  | (StockItemBase & { type: 'stock.unit_set'; name: string; base: number })
  /** The owner fixes how often an item is counted; null hands it back to the automatic choice. */
  | (StockItemBase & { type: 'stock.tier_set'; tier: Tier | null })
  /** What receiving this item is counted in, the owner's choice (SCRUM-96): a unit id from unitsOf ('pack', 'kg', 'unit:Tray'). */
  | (StockItemBase & { type: 'stock.receive_unit_set'; unit: string })
  /** "Order when below" this many packs, the owner's choice (SCRUM-135); null hands it back to the reorder rule. */
  | (StockItemBase & { type: 'stock.limit_set'; packs: number | null })
  /** The owner on a count's gap (SCRUM-95): OK, or a question to the manager. */
  | (StockItemBase & { type: 'stock.gap_reviewed'; countId: string; decision: 'ok' | 'ask'; note: string })
  /** The manager answers the owner's question about a gap. */
  | (StockItemBase & { type: 'stock.gap_answered'; countId: string; note: string })
  /** A purchase order (purchaseOrders.ts): packs and agreed price per pack from one supplier. Its id is the event id. */
  | (StockBase & { type: 'stock.ordered'; poNo?: string; supplierId: string; lines: PoLine[] })
  /** A purchase order cancelled, with why (only while nothing has been received); Undo reopens it. */
  | (StockBase & { type: 'stock.order_cancelled'; orderId: string; reason: string })
  | (StockBase & { type: 'stock.order_reopened'; orderId: string })
  /** A purchase order's lines replaced (edit, or "Add to PO"); only while nothing has been received. */
  | (StockBase & { type: 'stock.order_edited'; orderId: string; lines: PoLine[] })
  /** One supplier's draft order, whole (Items add to it; the Order page places it); no lines clears it. */
  | (StockBase & { type: 'stock.draft_set'; supplierId: string; lines: PoLine[] })
  /**
   * Goods received against a purchase order (GRN), in packs. Stock itself goes up by
   * 'receive' adjustments; this is the record, closing the order. approvedBy: the manager
   * whose PIN approved a quantity or price difference.
   */
  | (StockBase & { type: 'stock.grn'; grnNo?: string; orderId: string; supplierId: string; lines: GrnLine[]; approvedBy: Actor | null; shortDecision?: 'wait' | 'close'; overDecision?: 'accept' | 'return'; /** The approving manager's final note, if any. */ note?: string })
  /** A GRN taken back by a manager, with why: its stock comes off and its order goes back. The GRN stays, marked undone. */
  | (StockBase & { type: 'stock.grn_undone'; grnId: string; reason?: string; approvedBy?: Actor })
  /** One stock movement, in base units (g, ml, pcs, sheets); docId: the GRN or count it belongs to. */
  | (StockItemBase & { type: 'stock.movement'; kind: MovementKind; qtyBase: number; docId: string })
  /** The shop server gives a PO or GRN its display number (docNumbers.ts). Only the server writes these. */
  | (StockBase & { type: 'stock.numbered'; docId: string; kind: 'PO' | 'GRN'; number: string })
  /**
   * Thrown away instead of sold (manager mode, the bin; waste.ts). Takes stock the way a sale
   * does: a dish through its recipe, a semi-processed item through its batch, raw directly.
   */
  | (StockBase & { type: 'stock.wasted'; what: WasteWhat;
    /** What it was called when thrown away ("Margherita · Large"), for history and reports. */
    name: string; qty: number; reason: WasteReason; note?: string })
  | (StockBase & { type: 'stock.waste_undone'; wasteId: string })
  /** The owner changes one of the stock rules' numbers (stockSettings.ts). */
  | (StockBase & { type: 'stock.settings_set'; key: keyof StockSettings; value: number });

/**
 * Semi-processed items (prep.ts, SCRUM-136). Running low, one is sent to the kitchen as a prep
 * ticket (`ticketId`); the cook Starts and marks it Done like an order (kitchen.* events), and
 * Done is the batch made: the item's stock goes up and its raw items come off. From its first
 * batch on, sales take the item. prepId: the item's key (his own as `kitchen:<id>`, a sheet
 * batch by name); qty in `unit`. Undo right after sending takes the ticket back.
 */
export type PrepEvent =
  | (StockBase & { type: 'prep.ordered'; ticketId: string; prepId: string; name: string; qty: number; unit: string })
  | (StockBase & { type: 'prep.order_undone'; ticketId: string })
  /** "Make more when below" this amount, in the item's unit (managers and the owner); null: automatic. */
  | (StockBase & { type: 'prep.limit_set'; prepId: string; before: number | null; after: number | null });

export const PREP_EVENT_TYPES = ['prep.ordered', 'prep.order_undone', 'prep.limit_set'] as const satisfies readonly PrepEvent['type'][];

/**
 * Stock moves only by these (stockMovements.ts): GRN in, GRN_UNDO out, COUNT_ADJUST ±.
 * Sales are not stored: they are worked out from paid orders and their recipes.
 */
export const MOVEMENT_KINDS = ['GRN', 'GRN_UNDO', 'COUNT_ADJUST'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/** stockQty: base units; unitPriceCents: agreed one-pack price (missing on older orders). */
export interface PoLine { itemId: string; packs: number; stockQty?: number; unitPriceCents?: Cents }
/**
 * ordered: what was still owed when it came; received: what came; accepted: what went into
 * stock (the stock movement is worked out from this); returned: the extra sent back;
 * unitPriceCents: delivered price per pack.
 * Older notes have no accepted: their stock was written as separate movements.
 */
export interface GrnLine { itemId: string; ordered: number; received: number; accepted?: number; returned?: number; unitPriceCents?: Cents }

/** Everything that syncs. Menu changes: src/domain/menuEdits.ts; shorthand misses: shorthandMisses.ts. */
export type SyncEvent = OrderEvent | KitchenEvent | StockEvent | PrepEvent | MenuEvent | RecipeEvent | ShorthandEvent;

/** An event before the log gives it an id and stamps the shop. */
export type NewSyncEvent = SyncEvent extends infer E ? (E extends SyncEvent ? Omit<E, 'id' | 'shopId'> : never) : never;

export const KITCHEN_EVENT_TYPES = [
  'kitchen.seen', 'kitchen.started', 'kitchen.unstarted', 'kitchen.bumped', 'kitchen.unbumped',
] as const satisfies readonly KitchenEvent['type'][];
export const STOCK_EVENT_TYPES = [
  'stock.adjusted', 'stock.price_set', 'stock.item_added', 'stock.supplier_added',
  'stock.item_archived', 'stock.item_restored', 'stock.supplier_archived', 'stock.supplier_restored', 'stock.supplier_edited',
  'stock.counted', 'stock.count_undone', 'stock.unit_set', 'stock.tier_set', 'stock.gap_reviewed', 'stock.gap_answered', 'stock.receive_unit_set', 'stock.limit_set',
  'stock.ordered', 'stock.order_cancelled', 'stock.order_reopened', 'stock.order_edited', 'stock.draft_set', 'stock.grn', 'stock.grn_undone', 'stock.movement', 'stock.numbered', 'stock.settings_set',
  'stock.wasted', 'stock.waste_undone',
] as const satisfies readonly StockEvent['type'][];
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
  error: 'unauthorized' | 'wrong_shop' | 'forbidden' | 'invalid_event' | 'printer' | 'wrong_pin' | 'too_many' | 'unavailable' | 'server';
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
