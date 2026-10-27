import type { SyncEvent } from './sync.ts';

/**
 * Warehouses (SCRUM-184): where stock is kept. The shop starts with three placeholders the owner
 * renames ("Warehouse 1/2/3"); he adds, renames and archives them himself, each change one audited
 * `stock.warehouse_set` with Undo. One of them is next to the kitchen.
 *
 * Every raw and semi-processed item has a home (`stock.home_set`, Warehouse 1 until he says).
 * What comes in goes to a warehouse: a delivery where its GRN line says (its home by default), a
 * batch made into its home. What goes out (sales, batches' inputs, waste) is taken automatically:
 * the warehouse next to the kitchen first, then the item's home, then the rest, so nobody picks a
 * warehouse at the counter. The split is therefore close, not exact, until someone records a Move
 * (`stock.moved`) or counts one warehouse. The total is still the stock fold's (inventory.ts).
 *
 * Amounts are by Visual Flow's node id, like the ledger: `stock:<id>` in base units, `semi:<key>`
 * in the unit the item is counted in.
 */
export interface WarehouseInfo { name: string; archived: boolean }
export interface Warehouse extends WarehouseInfo { id: string }

export const SEED_WAREHOUSES: readonly Warehouse[] = [
  { id: 'wh-1', name: 'Warehouse 1', archived: false },
  { id: 'wh-2', name: 'Warehouse 2', archived: false },
  { id: 'wh-3', name: 'Warehouse 3', archived: false },
];
/** Where an item with no home of its own is kept, and the warehouse next to the kitchen until he moves it. */
export const DEFAULT_WAREHOUSE = 'wh-1';

/** A warehouse's name: 1 to 40 characters. null when it is fine, else what is wrong. */
export const checkWarehouseName = (name: unknown): string | null => {
  if (typeof name !== 'string' || !name.trim()) return 'Type a name.';
  if (name.trim().length > 40) return 'Keep the name to 40 characters.';
  return null;
};

export const isStockKey = (key: unknown): key is string =>
  typeof key === 'string' && /^(stock|semi):.{1,120}$/.test(key);

export const isWarehouseId = (id: unknown): id is string => typeof id === 'string' && /^wh-[A-Za-z0-9-]{1,40}$/.test(id);

export interface Warehouses {
  /** Every warehouse, in the order they were made; archived ones stay so their stock is still shown. */
  list: Warehouse[];
  kitchenSide: string;
  /** Each item's home, by stock key; missing: DEFAULT_WAREHOUSE. */
  homes: Map<string, string>;
}

const fresh = (): Warehouses => ({ list: SEED_WAREHOUSES.map((w) => ({ ...w })), kitchenSide: DEFAULT_WAREHOUSE, homes: new Map() });

/** One warehouse record applied to the list (used by the fold below and by placement). */
const stepWarehouses = (w: Warehouses, e: SyncEvent): void => {
  if (e.type === 'stock.warehouse_set') {
    const at = w.list.find((x) => x.id === e.warehouseId);
    if (at) Object.assign(at, e.after);
    else w.list.push({ id: e.warehouseId, ...e.after });
  } else if (e.type === 'stock.kitchen_side_set') {
    if (w.list.some((x) => x.id === e.after)) w.kitchenSide = e.after;
  } else if (e.type === 'stock.home_set') {
    if (e.after === null) w.homes.delete(e.stockKey); else w.homes.set(e.stockKey, e.after);
  }
};

export const warehousesFromEvents = (events: readonly SyncEvent[]): Warehouses => {
  const w = fresh();
  for (const e of events) stepWarehouses(w, e);
  return w;
};

export const homeOf = (w: Warehouses, key: string): string => {
  const home = w.homes.get(key);
  return home && w.list.some((x) => x.id === home) ? home : DEFAULT_WAREHOUSE;
};

/** The warehouses a delivery or a move may go to: the ones not archived. */
export const activeWarehouses = (w: Warehouses): Warehouse[] => w.list.filter((x) => !x.archived);

/** Where stock is taken from, in order: next to the kitchen, the item's home, then the rest. */
export const takeOrder = (w: Warehouses, key: string): string[] =>
  [...new Set([w.kitchenSide, homeOf(w, key), ...w.list.map((x) => x.id)])];

/** How much of one item is in each warehouse. */
export type Split = Map<string, number>;

const EPS = 1e-9;

/**
 * Takes `qty` (positive) from the split in the take order: from each warehouse what it has, and
 * what nobody has from the first (it goes below zero there, as the total does). Returns what came
 * from where, so it can be given back exactly.
 */
export const drain = (split: Split, order: readonly string[], qty: number): Split => {
  const from: Split = new Map();
  let left = qty;
  for (const id of order) {
    if (left <= EPS) break;
    const has = split.get(id) ?? 0;
    if (has <= EPS) continue;
    const t = Math.min(has, left);
    from.set(id, t);
    left -= t;
  }
  if (left > EPS) from.set(order[0], (from.get(order[0]) ?? 0) + left);
  for (const [id, t] of from) split.set(id, (split.get(id) ?? 0) - t);
  return from;
};

/**
 * Where each item's stock is, built alongside the stock fold. `put` and `take` are what the fold
 * calls where it adds or takes stock; a give-back of something taken is exact when the fold hands
 * back the same record (`taken`), else it goes next to the kitchen.
 */
export const placement = () => {
  const w = fresh();
  const places = new Map<string, Split>();
  /** What each taking took from where, by the record the fold took it for (a sale's usage, a batch). */
  const taken = new WeakMap<object, Map<string, Split>>();
  /** What each GRN, count, batch made and move put where, by its id, for its Undo. */
  const done = new Map<string, { key: string; split: Split }[]>();

  const splitOf = (key: string): Split => places.get(key) ?? places.set(key, new Map()).get(key)!;
  const add = (key: string, split: Split, sign: 1 | -1) => {
    const s = splitOf(key);
    for (const [id, q] of split) s.set(id, (s.get(id) ?? 0) + sign * q);
  };

  return {
    warehouses: w,
    /** Warehouse records change the list and homes as they come, so later stock goes where they say then. */
    step: (e: SyncEvent): void => {
      stepWarehouses(w, e);
      if (e.type === 'stock.moved') {
        const split: Split = new Map([[e.from, -e.qty], [e.to, e.qty]]);
        add(e.stockKey, split, 1);
        done.set(e.id, [{ key: e.stockKey, split }]);
      } else if (e.type === 'stock.move_undone') {
        for (const d of done.get(e.moveId) ?? []) add(d.key, d.split, -1);
        done.delete(e.moveId);
      }
    },
    /**
     * Stock in (qty > 0) into a warehouse, or its home when none is given; stock out (qty < 0)
     * from that warehouse, or the take order when none is given. `doc`: the record whose Undo
     * takes exactly this back (a GRN, a count, a batch made).
     */
    put: (key: string, qty: number, warehouseId: string | null | undefined, doc?: string): void => {
      if (!qty) return;
      const known = warehouseId && w.list.some((x) => x.id === warehouseId) ? warehouseId : null;
      const split: Split = qty > 0 || known
        ? new Map([[known ?? homeOf(w, key), qty]])
        : new Map([...drain(splitOf(key), takeOrder(w, key), -qty)].map(([id, q]) => [id, -q]));
      if (qty > 0 || known) add(key, split, 1);
      if (doc) {
        const list = done.get(doc) ?? [];
        list.push({ key, split });
        done.set(doc, list);
      }
    },
    /** Takes back exactly what `put` did for this record (a GRN's or a count's Undo). */
    undo: (doc: string): void => {
      for (const d of done.get(doc) ?? []) add(d.key, d.split, -1);
      done.delete(doc);
    },
    /** Out, by the take order; `record` remembers from where, so `giveBack` with it is exact. */
    take: (key: string, qty: number, record?: object): void => {
      if (!(qty > 0)) { if (qty < 0) add(key, new Map([[w.kitchenSide, -qty]]), 1); return; }
      const from = drain(splitOf(key), takeOrder(w, key), qty);
      if (record) {
        const m = taken.get(record) ?? new Map<string, Split>();
        const was = m.get(key);
        if (was) for (const [id, q] of from) was.set(id, (was.get(id) ?? 0) + q); else m.set(key, from);
        taken.set(record, m);
      }
    },
    giveBack: (key: string, qty: number, record?: object): void => {
      const m = record && taken.get(record);
      if (m) {
        // A record listing an item twice was given back whole the first time.
        const from = m.get(key);
        if (from) { add(key, from, 1); m.delete(key); }
      } else if (qty) add(key, new Map([[w.kitchenSide, qty]]), 1);
    },
    /** Nothing of it is anywhere any more (a semi-processed item with no batch standing). */
    clear: (key: string): void => { places.delete(key); },
    places,
  };
};

export type Placement = ReturnType<typeof placement>;

/**
 * Each item's split for showing: the warehouses that hold some of it, in the list's order, with
 * any difference from the total (sales the split could not follow) kept next to the kitchen.
 */
export const splitFor = (w: Warehouses, places: ReadonlyMap<string, Split>, key: string, total: number): { id: string; qty: number }[] => {
  const s = places.get(key);
  const out = new Map<string, number>();
  for (const x of w.list) {
    const q = s?.get(x.id) ?? 0;
    if (Math.abs(q) > 1e-6) out.set(x.id, q);
  }
  const sum = [...out.values()].reduce((a, b) => a + b, 0);
  if (Math.abs(total - sum) > 1e-6) out.set(w.kitchenSide, (out.get(w.kitchenSide) ?? 0) + total - sum);
  return w.list.filter((x) => out.has(x.id) && Math.abs(out.get(x.id)!) > 1e-6).map((x) => ({ id: x.id, qty: out.get(x.id)! }));
};

/** null when the move can be recorded, else why not, in plain words. */
export const checkMove = (w: Warehouses, key: unknown, from: unknown, to: unknown, qty: unknown): string | null => {
  if (!isStockKey(key)) return 'Pick an item.';
  if (!isWarehouseId(from) || !w.list.some((x) => x.id === from)) return 'Pick where it is.';
  if (!isWarehouseId(to) || !w.list.some((x) => x.id === to && !x.archived)) return 'Pick where it goes.';
  if (from === to) return 'Pick a different warehouse.';
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0 || qty > 1e9) return 'Type how much.';
  return null;
};

/**
 * A split as it is shown: never below zero. Where sales took more than a warehouse held (the
 * split follows them only roughly), the shortfall comes off the others in the take order, so
 * the warehouses always add up to what is on hand.
 */
export const shownSplit = (w: Warehouses, places: ReadonlyMap<string, Split>, key: string, total: number): { id: string; qty: number }[] => {
  const raw = splitFor(w, places, key, total);
  let short = raw.reduce((a, x) => a + (x.qty < 0 ? -x.qty : 0), 0);
  const left = new Map(raw.filter((x) => x.qty > 0).map((x) => [x.id, x.qty]));
  for (const id of takeOrder(w, key)) {
    if (short <= 1e-9) break;
    const has = left.get(id) ?? 0;
    const t = Math.min(has, short);
    if (t > 0) { left.set(id, has - t); short -= t; }
  }
  return w.list.filter((x) => (left.get(x.id) ?? 0) > 1e-6).map((x) => ({ id: x.id, qty: left.get(x.id)! }));
};

/** One item for the warehouse views: total null when nothing is known yet (never counted, never made). */
export interface StockEntry { key: string; kind: 'raw' | 'semi'; name: string; total: number | null; unit: string; unitCents: number | null }
export interface PlacedItem extends StockEntry { qty: number | null; cents: number | null; home: boolean }
export interface WarehouseStock extends Warehouse { kitchenSide: boolean; items: PlacedItem[]; cents: number }

/**
 * Items › Warehouses: each warehouse with what it holds first, raw then semi-processed, A to Z. Every
 * item is listed in its home even when none is there (or nothing is known yet), so each
 * ingredient has its place; an archived warehouse is listed only while it still holds something.
 */
export const byWarehouse = (w: Warehouses, places: ReadonlyMap<string, Split>, entries: readonly StockEntry[]): WarehouseStock[] => {
  const out = new Map<string, PlacedItem[]>(w.list.map((x) => [x.id, []]));
  for (const e of entries) {
    const home = homeOf(w, e.key);
    const split = e.total === null ? [] : shownSplit(w, places, e.key, e.total);
    for (const s of split) {
      out.get(s.id)?.push({ ...e, qty: s.qty, cents: e.unitCents === null ? null : Math.round(s.qty * e.unitCents), home: s.id === home });
    }
    if (!split.some((s) => s.id === home)) out.get(home)?.push({ ...e, qty: e.total === null ? null : 0, cents: e.total === null ? null : 0, home: true });
  }
  // What it holds first, then what is kept here with none in it; raw before semi-processed, A to Z.
  const held = (i: PlacedItem) => ((i.qty ?? 0) > 0 ? 0 : 1);
  const order = (a: PlacedItem, b: PlacedItem) => held(a) - held(b) || (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'raw' ? -1 : 1);
  return w.list
    .map((x) => {
      const items = out.get(x.id)!.sort(order);
      return { ...x, kitchenSide: x.id === w.kitchenSide, items, cents: items.reduce((a, i) => a + (i.cents ?? 0), 0) };
    })
    .filter((x) => !x.archived || x.items.some((i) => (i.qty ?? 0) > 0));
};
