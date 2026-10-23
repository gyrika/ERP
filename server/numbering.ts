import { numberingOf, numbersFor, unnumbered, type NumberingState } from '../src/domain/docNumbers.ts';
import { PULL_LIMIT, type SyncEvent, type SyncedEvent } from '../src/domain/sync.ts';
import type { Device, EventStore } from './store.ts';

/**
 * The shop server hands out PO and GRN numbers (PO-0001, GRN-0001), one at a time per
 * shop, so two devices can never use the same one. For each new document it stores a
 * `stock.numbered` record (an event like any other, so it reaches every device and the
 * cloud copy). It looks at every document in a push, not only the ones newly stored, so
 * a push retried after a failure still gets its numbers; the record's id comes from the
 * document's, so storing it twice stores it once.
 */
export function createNumberer(store: EventStore, now: () => number) {
  /** What each shop has numbered, read from its log once and then kept up to date here. */
  const states = new Map<string, Promise<NumberingState>>();
  /** One shop is numbered one batch at a time. */
  const queues = new Map<string, Promise<unknown>>();

  const load = async (tenantId: string): Promise<NumberingState> => {
    const events: SyncEvent[] = [];
    for (let after = 0;;) {
      const rows = await store.pull(tenantId, after, PULL_LIMIT);
      events.push(...rows.map((r) => r.event));
      if (rows.length < PULL_LIMIT) break;
      after = rows[rows.length - 1].seq;
    }
    return numberingOf(events);
  };

  /** Numbers the documents among `events`; returns the numbering records newly stored. */
  return async (device: Device, events: readonly SyncEvent[]): Promise<SyncedEvent[]> => {
    if (!events.some((e) => e.type === 'stock.ordered' || e.type === 'stock.grn')) return [];
    const tenant = device.tenantId;
    const run = (queues.get(tenant) ?? Promise.resolve()).then(async () => {
      if (!states.has(tenant)) states.set(tenant, load(tenant));
      try {
        const state = await states.get(tenant)!;
        const made = numbersFor(tenant, now(), unnumbered(events, state), state);
        if (!made.length) return [];
        return (await store.push(device, made, now())).stored;
      } catch (e) {
        states.delete(tenant); // what we kept may be ahead of what was stored: read it again next time
        throw e;
      }
    });
    queues.set(tenant, run.catch(() => undefined));
    return run;
  };
}
