import { NUMBERER } from './docNumbers.ts';
import { stockFromEvents } from './inventory.ts';
import type { InventoryItem } from './inventoryData.ts';
import type { SyncEvent } from './sync.ts';

/**
 * The production scheduler (production.ts): held batches whose inputs are on hand now go to the
 * kitchen, oldest first, as `prep.released` records. It runs where the whole history is: on the
 * shop server after every stored push (on the counter PC, so it runs with the internet down), and
 * on a device with no server (the demo). A record's id comes from its batch, so writing it twice
 * stores it once. Written by the shop server, never a person.
 */
export const releasesDue = (items: readonly InventoryItem[], events: readonly SyncEvent[], shopId: string, now: number): SyncEvent[] =>
  stockFromEvents(items, events, { now }).ledger.due.map((o): SyncEvent => ({
    id: `rel-${o.ticketId}`, shopId, at: now, orderNumber: 0, actor: NUMBERER, type: 'prep.released',
    ticketId: o.ticketId, prepId: o.prepId, name: o.name, qty: o.qty, unit: o.unit, waited: o.waitFor,
  }));

/** Only a log with a batch held for its inputs, and not yet released or taken back, needs looking at. */
export const holdsBatches = (events: readonly SyncEvent[]): boolean => {
  const held = new Set<string>();
  for (const e of events) {
    if (e.type === 'prep.ordered' && e.waitFor?.length) held.add(e.ticketId);
    else if (e.type === 'prep.released' || e.type === 'prep.order_undone') held.delete(e.ticketId);
  }
  return held.size > 0;
};

/** "Culture completed. Dough automatically sent to the kitchen.": what a release tells the people at the counter. */
export const releaseText = (e: Extract<SyncEvent, { type: 'prep.released' }>): string => {
  const what = e.waited.length ? e.waited.join(' and ') : 'What it needed';
  return `${what} ${e.waited.length > 1 ? 'are' : 'is'} ready. ${e.name} sent to the kitchen automatically.`;
};
