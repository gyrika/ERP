import { setMenuState } from '../domain/menu.ts';
import { menuStateFromEvents } from '../domain/menuEdits.ts';
import { useEffect, useState } from 'react';
import type { PullResponse, SyncEvent } from '../domain/sync.ts';
import { demoHistory } from '../fake/history.ts';
import { readAll, subscribeEvents } from '../ui/eventLog.ts';
import { isDemo } from '../ui/storage.ts';
import { adminShop, fleetShop, ownerToken, syncToken } from './pairing.ts';

/**
 * Everything the Owner view looks at: the shop's whole history of events.
 * - The owner's phone: from the cloud copy (same address that served the page).
 * - The developer's admin view of a shop: the same, through /admin (signed in with the admin password).
 * - The Shops screen on the developer's laptop: the same, through its local server (server/fleet.ts).
 * - The counter (paired): from the shop server (the browser keeps only two days).
 * - The demo: five weeks of made-up trading (src/fake/history.ts).
 * - Development without a server: this browser's own events.
 * Remote sources are read once in full, then only what is new since (phones and
 * slow shop internet pay for every byte).
 */
interface Source {
  /** Events after the cursor, and the new cursor. A full load starts at 0. */
  next(after: number): Promise<{ events: SyncEvent[]; cursor: number }>;
  /** Local sources rebuild the whole list each time. */
  incremental: boolean;
}

const remote = (path: string, headers: Record<string, string>): Source => ({
  incremental: true,
  async next(after) {
    const events: SyncEvent[] = [];
    let cursor = after;
    for (;;) {
      const r = await fetch(`${path}?after=${cursor}&limit=500`, { headers, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(r.status === 401 ? 'This link is no longer valid.' : `server ${r.status}`);
      const page = (await r.json()) as PullResponse;
      events.push(...page.events.map((s) => s.event));
      cursor = page.lastSeq;
      if (!page.more) return { events, cursor };
    }
  },
});

const local = (read: () => SyncEvent[]): Source => ({
  incremental: false,
  next: async () => ({ events: read(), cursor: 0 }),
});

export const shopSource = (): Source => {
  if (isDemo()) return local(() => demoHistory(Date.now()));
  const shop = adminShop();
  if (shop) return remote(`/admin/api/shops/${shop}/events`, {});
  const fleet = fleetShop();
  if (fleet) return remote(`/api/v1/fleet/shops/${fleet}/events`, {});
  const token = ownerToken() ?? syncToken();
  return token ? remote('/api/v1/events', { authorization: `Bearer ${token}` }) : local(readAll);
};

export type ShopEvents =
  | { state: 'loading' }
  | { state: 'ready'; events: SyncEvent[]; at: number }
  | { state: 'error'; message: string; events?: SyncEvent[]; at?: number };

/** Loads once, then catches up when this device records something, and every minute. */
export function useShopEvents(): ShopEvents {
  const [data, setData] = useState<ShopEvents>({ state: 'loading' });
  useEffect(() => {
    const source = shopSource();
    let alive = true;
    let events: SyncEvent[] | undefined;
    let cursor = 0;
    let busy = false;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const got = await source.next(source.incremental ? cursor : 0);
        if (!alive) return;
        events = source.incremental ? [...(events ?? []), ...got.events] : got.events;
        cursor = got.cursor;
        // The owner's own names and prices, wherever this view runs (the phone has no event log).
        setMenuState(menuStateFromEvents(events.filter((e) => e.type.startsWith('menu.'))));
        setData({ state: 'ready', events, at: Date.now() });
      } catch (e) {
        if (alive) setData({ state: 'error', message: e instanceof Error ? e.message : String(e), events, at: Date.now() });
      } finally {
        busy = false;
      }
    };
    void load();
    const soon = () => { clearTimeout(pending); pending = setTimeout(() => void load(), 1500); };
    const unsubscribe = subscribeEvents(soon);
    const every = setInterval(() => void load(), 60_000);
    return () => { alive = false; clearTimeout(pending); clearInterval(every); unsubscribe(); };
  }, []);
  return data;
}
