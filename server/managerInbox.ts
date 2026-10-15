import { managesRole, OWNER_STOCK } from '../src/domain/auth.ts';
import { PULL_LIMIT, type SyncEvent } from '../src/domain/sync.ts';
import type { Device } from './store.ts';
import { validatePush } from './validate.ts';

/**
 * The manager phones' counts, into the shop (SCRUM-94). The phones record in the cloud's
 * inbox (they are on mobile data, not the shop Wi-Fi); every few seconds this takes what
 * is new into the shop's own log, as if a device here had sent it, so the counter, the
 * cloud copy and every report see it the usual way. Checked again here: the shop never
 * keeps what it would not take from its own counter.
 */
export interface ManagerInboxOptions {
  url: string;
  token: string;
  tenantId: string;
  /** The local device the phones' events are filed under (made once). */
  device(): Promise<Device>;
  /** Stores events from that device here, and tells every screen. */
  ingest(device: Device, events: SyncEvent[]): Promise<unknown>;
  cursor(): number;
  setCursor(seq: number): void;
  fetch?: typeof fetch;
  every?: number;
}

/** What the shop takes from a phone: stock, by a manager or owner; count lists and gap checks by an owner only. */
export const takesFromPhone = (e: SyncEvent): boolean =>
  e.type.startsWith('stock.') && 'actor' in e && managesRole(e.actor.role) &&
  (!OWNER_STOCK.has(e.type) || e.actor.role === 'owner');

export function startManagerInbox(o: ManagerInboxOptions) {
  const http = o.fetch ?? fetch;
  const every = o.every ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /** Takes everything new; returns how many events were taken. */
  const poll = async (): Promise<number> => {
    let taken = 0;
    for (;;) {
      const r = await http(`${o.url}/api/v1/inbox?after=${o.cursor()}`, {
        headers: { authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`inbox ${r.status}`);
      const page = (await r.json()) as { events: { seq: number; event: SyncEvent }[]; lastSeq: number };
      const fine = page.events.map((x) => x.event).filter((e) => !('reason' in validatePush({ events: [e] }, o.tenantId)) && takesFromPhone(e));
      if (fine.length) await o.ingest(await o.device(), fine);
      taken += fine.length;
      o.setCursor(page.lastSeq);
      if (page.events.length < PULL_LIMIT) return taken;
    }
  };

  const loop = async () => {
    if (stopped) return;
    try { await poll(); } catch { /* the internet is down: next time */ }
    if (!stopped) timer = setTimeout(() => void loop(), every);
  };
  void loop();
  return { poll, stop: () => { stopped = true; clearTimeout(timer); } };
}
