import { stockStatus, type Stock, type StockStatus } from './inventory.ts';
import { prepStatus } from './prep.ts';
import { canMake } from './production.ts';

/**
 * One item's stock, whatever kind it is, from the one ledger (inventory.ts): the same figures on
 * Items and on Visual Flow. By node id (visualFlow.ts): `stock:<id>` a raw material, `semi:<key>`
 * a semi-processed item, `recipe:<item>:<size>` a finished dish. A dish is made to order, so its
 * stock is how many what is on hand makes now.
 */
export interface ItemStock {
  kind: 'raw' | 'semi' | 'finished';
  status: StockStatus;
  /** Its amount is known (counted, made, or worked out from its inputs). */
  known: boolean;
  onHand: number;
  /** Spoken for by batches in the kitchen. */
  reserved: number;
  available: number;
  unit: string;
  /** Batches held for their inputs still wait for this much of it. */
  short: number;
  /** What to order now (raw), in packs; 0: nothing. */
  orderPacks: number;
  inKitchen: number;
  waiting: number;
  waitingFor: string[];
  /** A dish: how many can be made now; null otherwise or when not known. */
  canMake: number | null;
}

const after = (id: string) => id.slice(id.indexOf(':') + 1);

export const itemStockOf = (id: string, stock: Stock): ItemStock | null => {
  if (id.startsWith('stock:')) {
    const row = stock.rows.find((r) => r.id === after(id));
    if (!row) return null;
    return {
      kind: 'raw', status: stockStatus(row), known: row.counted, onHand: row.onHandBaseUnits, reserved: row.reservedBaseUnits,
      available: row.onHandBaseUnits - row.reservedBaseUnits, unit: row.baseUnit, short: row.shortBaseUnits, orderPacks: row.suggestedPacks,
      inKitchen: 0, waiting: 0, waitingFor: [], canMake: null,
    };
  }
  if (id.startsWith('semi:')) {
    const key = after(id);
    const p = stock.preps.find((x) => x.key === key);
    const tracked = p?.tracked ?? false;
    return {
      kind: 'semi', status: p ? prepStatus(p) : 'unknown', known: tracked, onHand: p?.onHand ?? 0, reserved: p?.reserved ?? 0,
      available: (p?.onHand ?? 0) - (p?.reserved ?? 0), unit: p?.unit ?? '', short: stock.ledger.short.get(id) ?? 0, orderPacks: 0,
      inKitchen: p?.inKitchen ?? 0, waiting: p?.waiting ?? 0, waitingFor: p?.waitingFor ?? [], canMake: null,
    };
  }
  if (id.startsWith('recipe:')) {
    const [itemId, size = ''] = after(id).split(':');
    const n = canMake(itemId, size, stock.ledger);
    return {
      kind: 'finished', status: n === null ? 'unknown' : n === 0 ? 'out' : 'ok', known: n !== null, onHand: n ?? 0, reserved: 0,
      available: n ?? 0, unit: 'pcs', short: 0, orderPacks: 0, inKitchen: 0, waiting: 0, waitingFor: [], canMake: n,
    };
  }
  return null;
};

/** Needs a look: out or low (a dish: none can be made), or held batches wait for it. */
export const needsAttention = (s: ItemStock): boolean => s.status === 'out' || s.status === 'low' || s.short > 0;
