import { homeOf, shownSplit, type Split, type Warehouses } from './warehouses.ts';

/**
 * Visual Flow's Warehouse view (SCRUM-188): a column of warehouses left of the raw items, a line
 * from each warehouse to each item kept there. The raw items are stacked by their home, one block
 * per warehouse, so every line runs short and nearly flat; each warehouse sits in the middle of its
 * block. A warehouse with nothing of this dish still gets a slot, so there is always somewhere to
 * drag a line to. Archived warehouses are drawn only while they still hold some of these items.
 */

/** A raw card on the drawing: its stock key, how much there is (null: not counted), and its place in the plain drawing. */
export interface ColumnItem { id: string; total: number | null; y: number }

export interface WarehouseCard { id: string; name: string; index: number; kitchenSide: boolean; archived: boolean; y: number }

/** One line: home (solid, can be dragged to another warehouse) or stock kept elsewhere (dashed). */
export interface WarehouseLink { id: string; warehouseId: string; itemId: string; home: boolean; qty: number | null }

export interface WarehouseColumn {
  cards: WarehouseCard[];
  /** Each raw card's new height on the drawing. */
  itemY: Map<string, number>;
  links: WarehouseLink[];
  /** Where "+ Warehouse" goes, under the last warehouse. */
  addY: number;
}

/** Space between two warehouses' blocks, as a share of a row. */
const GAP = 0.5;

export const warehouseColumn = (w: Warehouses, places: ReadonlyMap<string, Split>, items: readonly ColumnItem[], rowH: number): WarehouseColumn => {
  const splits = new Map(items.map((i) => [i.id, i.total === null ? [] : shownSplit(w, places, i.id, i.total)]));
  const holds = (whId: string) => items.some((i) => splits.get(i.id)!.some((s) => s.id === whId && s.qty > 0));
  const shown = w.list.filter((x) => !x.archived || holds(x.id));

  const blocks = shown.map((x) => ({ x, items: items.filter((i) => homeOf(w, i.id) === x.id).sort((a, b) => a.y - b.y) }));
  const itemY = new Map<string, number>();
  const cards: WarehouseCard[] = [];
  let cursor = 0;
  for (const { x, items: mine } of blocks) {
    mine.forEach((i, k) => itemY.set(i.id, cursor + k * rowH));
    const rows = Math.max(1, mine.length);
    cards.push({ id: x.id, name: x.name, index: w.list.indexOf(x), kitchenSide: x.id === w.kitchenSide, archived: x.archived, y: cursor + ((rows - 1) * rowH) / 2 });
    cursor += rows * rowH + GAP * rowH;
  }
  // Centred on the drawing, like every other column.
  const shift = -(cursor - GAP * rowH - rowH) / 2;
  for (const c of cards) c.y += shift;
  for (const [id, y] of itemY) itemY.set(id, y + shift);

  const links: WarehouseLink[] = [];
  for (const i of items) {
    const home = homeOf(w, i.id);
    const split = splits.get(i.id)!;
    links.push({ id: `wh>${home}>${i.id}`, warehouseId: home, itemId: i.id, home: true, qty: i.total === null ? null : split.find((s) => s.id === home)?.qty ?? 0 });
    for (const s of split) {
      if (s.id !== home && s.qty > 0 && shown.some((x) => x.id === s.id)) links.push({ id: `wh>${s.id}>${i.id}`, warehouseId: s.id, itemId: i.id, home: false, qty: s.qty });
    }
  }
  return { cards, itemY, links, addY: cursor + shift };
};

/** "Warehouse 4", or the next free number: a new warehouse's name until the owner types his own. */
export const nextWarehouseName = (w: Warehouses): string => {
  const taken = new Set(w.list.filter((x) => !x.archived).map((x) => x.name.trim().toLowerCase()));
  let n = w.list.length + 1;
  while (taken.has(`warehouse ${n}`)) n += 1;
  return `Warehouse ${n}`;
};
