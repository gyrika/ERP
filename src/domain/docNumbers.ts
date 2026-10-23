import type { Actor } from './auth.ts';
import type { SyncEvent } from './sync.ts';

/**
 * Display numbers for purchase orders and GRNs (PO-0001, GRN-0001). The shop server
 * hands them out, one at a time per shop, so two devices can never use the same one:
 * it writes a `stock.numbered` record for each new document. Until that record has
 * arrived the document shows "PO (pending)". A device with no server at all (the demo,
 * development) numbers its own documents with the same function.
 */
export type DocKind = 'PO' | 'GRN';

export const docNumber = (kind: DocKind, n: number): string => `${kind}-${String(n).padStart(4, '0')}`;
export const pendingNumber = (kind: DocKind): string => `${kind} (pending)`;
export const isPending = (no: string): boolean => no.endsWith('(pending)');

/** The one who numbers: not a person, so it never appears as someone's work. */
export const NUMBERER: Actor = { id: 'shop-server', name: 'Shop server', role: 'owner' };

const kindOf = (e: SyncEvent): DocKind | null => (e.type === 'stock.ordered' ? 'PO' : e.type === 'stock.grn' ? 'GRN' : null);
const suffix = (no: string | undefined): number => {
  const n = /-(\d+)$/.exec(no ?? '');
  return n ? Number(n[1]) : 0;
};

export interface NumberingState {
  /** The highest number given so far, per kind. */
  last: Record<DocKind, number>;
  /** Documents that already have their number. */
  numbered: Set<string>;
}

/** What has been numbered, from the log (older documents carried their own number: it counts too). */
export const numberingOf = (events: readonly SyncEvent[]): NumberingState => {
  const state: NumberingState = { last: { PO: 0, GRN: 0 }, numbered: new Set() };
  for (const e of events) {
    if (e.type === 'stock.numbered') {
      state.numbered.add(e.docId);
      state.last[e.kind] = Math.max(state.last[e.kind], suffix(e.number));
    } else if (e.type === 'stock.ordered' && e.poNo) {
      state.numbered.add(e.id);
      state.last.PO = Math.max(state.last.PO, suffix(e.poNo));
    } else if (e.type === 'stock.grn' && e.grnNo) {
      state.numbered.add(e.id);
      state.last.GRN = Math.max(state.last.GRN, suffix(e.grnNo));
    }
  }
  return state;
};

/** The documents among these events that still need a number. */
export const unnumbered = (events: readonly SyncEvent[], state: NumberingState): { id: string; kind: DocKind }[] =>
  events.flatMap((e) => { const kind = kindOf(e); return kind && !state.numbered.has(e.id) ? [{ id: e.id, kind }] : []; });

/**
 * The numbering records for these documents, in order. Changes `state`, so a document
 * is numbered once however often this is asked. The record's id comes from the document's,
 * so storing it twice stores it once.
 */
export const numbersFor = (shopId: string, at: number, docs: readonly { id: string; kind: DocKind }[], state: NumberingState): SyncEvent[] => {
  const out: SyncEvent[] = [];
  for (const d of docs) {
    if (state.numbered.has(d.id)) continue;
    state.numbered.add(d.id);
    state.last[d.kind] += 1;
    out.push({
      id: `num-${d.id}`, shopId, at, orderNumber: 0, actor: NUMBERER, type: 'stock.numbered',
      docId: d.id, kind: d.kind, number: docNumber(d.kind, state.last[d.kind]),
    });
  }
  return out;
};
