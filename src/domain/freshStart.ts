import type { Actor } from './auth.ts';
import type { SyncEvent } from './sync.ts';

/**
 * Starting fresh: the shop's first real day after testing. The owner says "what happened before
 * this time was test data" (Settings › Test data, on the shop PC); the shop server writes one
 * `shop.started_fresh` record, and from then on every screen, the server and the cloud leave out
 * the test activity before that time. Nothing is deleted (events are never edited or removed, and
 * every device and the cloud hold copies): the record only says which part no longer counts.
 *
 * Kept: the shop's setup (menu, recipes, ingredients, suppliers, units, warehouses, stock rules, gas sizes and rents,
 * value places, floor plan, cameras). Left out: what happened (orders, kitchen, counts, purchase orders, GRNs, money paid out,
 * waste, batches, tables seen, camera health).
 *
 * A count taken after the cut-off but before the record compared the shelf with stock that still
 * held test data, so it is read as "the shelf holds exactly this" (`absolute`), not as a difference.
 * The latest record wins; `before: 0` puts everything back (its Undo).
 */
export type ShopEvent = {
  id: string;
  shopId: string;
  at: number;
  orderNumber: 0;
  actor: Actor;
  type: 'shop.started_fresh';
  /** Activity before this moment (ms) was test data; 0: none was. */
  before: number;
};

export const SHOP_EVENT_TYPES = ['shop.started_fresh'] as const satisfies readonly ShopEvent['type'][];

/** The shop's setup: kept whenever it was recorded. Everything else is activity. */
const SETUP = new Set<string>([
  'stock.item_added', 'stock.supplier_added', 'stock.supplier_edited',
  'stock.item_archived', 'stock.item_restored', 'stock.supplier_archived', 'stock.supplier_restored',
  'stock.unit_set', 'stock.tier_set', 'stock.receive_unit_set', 'stock.limit_set', 'stock.settings_set',
  'stock.warehouse_set', 'stock.kitchen_side_set', 'stock.home_set', 'prep.limit_set',
  'table.layout_set', 'vision.cameras_set', 'vision.zones_set', 'vision.settings_set',
  // Gas sizes and rents to pay (Money out), and his places along the Visual Flow value column.
  'money.choices_set', 'value.place_set', 'value.card_set',
  ...SHOP_EVENT_TYPES,
]);

export const isSetup = (e: SyncEvent): boolean =>
  SETUP.has(e.type) || e.type.startsWith('menu.') || e.type.startsWith('recipe.') ||
  // A price the owner set is setup; one a GRN delivered at is test activity like the GRN.
  (e.type === 'stock.price_set' && !e.grnId);

/** The cut-off in force and when it was recorded, or null when nothing was cleared. */
export const freshStartOf = (events: readonly SyncEvent[]): { before: number; at: number } | null => {
  let last: ShopEvent | null = null;
  for (const e of events) if (e.type === 'shop.started_fresh') last = e;
  return last && last.before > 0 ? { before: last.before, at: last.at } : null;
};

/** The events as the shop's real history: test activity left out. Unchanged when nothing was cleared. */
export const withoutTestData = <T extends SyncEvent>(events: readonly T[]): T[] => {
  const fresh = freshStartOf(events);
  if (!fresh) return events as T[];
  const out: T[] = [];
  // What the shop server wrote later for a cleared record (its number, a held batch's release) goes with it.
  const gone = new Set<string>();
  for (const e of events) {
    if (e.at < fresh.before && !isSetup(e)) {
      gone.add(e.id);
      if (e.type === 'prep.ordered') gone.add(e.ticketId);
      continue;
    }
    if ((e.type === 'stock.numbered' && gone.has(e.docId)) || (e.type === 'prep.released' && gone.has(e.ticketId))) continue;
    out.push(e.type === 'stock.counted' && e.at < fresh.at ? { ...e, absolute: true } : e);
  }
  return out;
};
