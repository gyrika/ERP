import { setMenuState } from '../domain/menu.ts';
import { menuStateFromEvents } from '../domain/menuEdits.ts';
import { useSyncExternalStore } from 'react';
import type { PullResponse, SyncEvent } from '../domain/sync.ts';
import { demoHistory } from '../fake/history.ts';
import { readAll, subscribeEvents } from '../ui/eventLog.ts';
import { isDemo } from '../ui/storage.ts';
import { adminShop, fleetShop, managerToken, ownerToken, syncToken } from './pairing.ts';

/**
 * Everything the Owner view looks at: the shop's whole history of events.
 * - The owner's phone, and a manager's phone app: from the cloud copy (same address that served the page).
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
  const token = ownerToken() ?? managerToken() ?? syncToken();
  return token ? remote('/api/v1/events', { authorization: `Bearer ${token}` }) : local(readAll);
};

export type ShopEvents =
  | { state: 'loading' }
  | { state: 'ready'; events: SyncEvent[]; at: number }
  | { state: 'error'; message: string; events?: SyncEvent[]; at?: number };

/** Which history a source reads: a different shop (the Shops screen) or key starts afresh. */
const sourceKey = (): string => {
  if (isDemo()) return 'demo';
  const shop = adminShop() ?? fleetShop();
  if (shop) return `shop:${shop}`;
  return ownerToken() ?? managerToken() ?? syncToken() ?? 'local';
};

/**
 * One copy of the history for every screen that shows it (SCRUM-131: the owner's sidebar and the
 * screen beside it), so moving between them never loads it again. It loads when the first screen
 * needs it, then catches up when this device records something, and every minute; it stops when
 * none is left. A remote history is kept for the next screen (then only what is new is fetched);
 * this browser's own log is read afresh.
 */
const shared = {
  data: { state: 'loading' } as ShopEvents,
  key: '',
  cursor: 0,
  listeners: new Set<() => void>(),
  stop: null as null | (() => void),
};

const publish = (data: ShopEvents) => {
  shared.data = data;
  for (const l of shared.listeners) l();
};

const start = () => {
  const key = sourceKey();
  const source = shopSource();
  if (key !== shared.key || !source.incremental) {
    shared.key = key;
    shared.cursor = 0;
    shared.data = { state: 'loading' };
  }
  let alive = true;
  let busy = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const load = async () => {
    if (busy) return;
    busy = true;
    try {
      const got = await source.next(source.incremental ? shared.cursor : 0);
      if (!alive) return;
      const before = shared.data.state === 'loading' ? undefined : shared.data.events;
      const events = source.incremental ? [...(before ?? []), ...got.events] : got.events;
      shared.cursor = got.cursor;
      // The owner's own names and prices, wherever this view runs (the phone has no event log).
      setMenuState(menuStateFromEvents(events.filter((e) => e.type.startsWith('menu.'))));
      publish({ state: 'ready', events, at: Date.now() });
    } catch (e) {
      if (!alive) return;
      const events = shared.data.state === 'loading' ? undefined : shared.data.events;
      publish({ state: 'error', message: e instanceof Error ? e.message : String(e), events, at: Date.now() });
    } finally {
      busy = false;
    }
  };
  void load();
  const soon = () => { clearTimeout(pending); pending = setTimeout(() => void load(), 1500); };
  const unsubscribe = subscribeEvents(soon);
  const every = setInterval(() => void load(), 60_000);
  shared.stop = () => { alive = false; clearTimeout(pending); clearInterval(every); unsubscribe(); };
};

const subscribe = (listener: () => void) => {
  shared.listeners.add(listener);
  if (shared.listeners.size === 1) start();
  return () => {
    shared.listeners.delete(listener);
    if (shared.listeners.size === 0) { shared.stop?.(); shared.stop = null; }
  };
};

/** The shop's whole history, shared by every screen showing it. */
export function useShopEvents(): ShopEvents {
  return useSyncExternalStore(subscribe, () => shared.data);
}
