import { SEED_INVENTORY } from '../src/domain/inventoryData.ts';
import { holdsBatches, releasesDue } from '../src/domain/scheduler.ts';
import { PULL_LIMIT, type SyncEvent, type SyncedEvent } from '../src/domain/sync.ts';
import type { Device, EventStore } from './store.ts';

/**
 * The shop server releases held batches to the kitchen (src/domain/scheduler.ts) once what they are
 * made from is on hand: after every stored push, from the shop's whole history, one shop at a time.
 * The history is read once and then kept up to date here; it is folded only while a batch is held.
 */
export function createScheduler(store: EventStore, now: () => number) {
  const logs = new Map<string, Promise<SyncEvent[]>>();
  const queues = new Map<string, Promise<unknown>>();

  const load = async (tenantId: string): Promise<SyncEvent[]> => {
    const events: SyncEvent[] = [];
    for (let after = 0;;) {
      const rows = await store.pull(tenantId, after, PULL_LIMIT);
      events.push(...rows.map((r) => r.event));
      if (rows.length < PULL_LIMIT) break;
      after = rows[rows.length - 1].seq;
    }
    return events;
  };

  /** `stored`: what was just stored for this shop. Returns the releases newly stored. */
  return async (device: Device, stored: readonly SyncEvent[]): Promise<SyncedEvent[]> => {
    const tenant = device.tenantId;
    const run = (queues.get(tenant) ?? Promise.resolve()).then(async () => {
      const first = !logs.has(tenant);
      if (first) logs.set(tenant, load(tenant));
      try {
        const log = await logs.get(tenant)!;
        if (!first) {
          const known = new Set(log.map((e) => e.id));
          log.push(...stored.filter((e) => !known.has(e.id)));
        }
        if (!stored.length || !holdsBatches(log)) return [];
        const made = releasesDue(SEED_INVENTORY, log, tenant, now());
        if (!made.length) return [];
        const out = (await store.push(device, made, now())).stored;
        log.push(...out.map((s) => s.event));
        return out;
      } catch (e) {
        logs.delete(tenant); // what we kept may be out of step with what was stored: read it again next time
        throw e;
      }
    });
    queues.set(tenant, run.catch(() => undefined));
    return run;
  };
}
