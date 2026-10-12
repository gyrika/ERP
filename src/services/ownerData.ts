import { useEffect, useRef, useState } from 'react';
import type { PullResponse, SyncEvent } from '../domain/sync.ts';
import { demoHistory } from '../fake/history.ts';
import { readAll, subscribeEvents } from '../ui/eventLog.ts';
import { isDemo } from '../ui/storage.ts';
import { syncToken } from './pairing.ts';

/**
 * Everything the Owner view looks at: the shop's whole history of events.
 * - Paired device: from the shop server (the browser keeps only two days).
 * - The demo: five weeks of made-up trading (src/fake/history.ts).
 * - Development without a server: this browser's own events.
 * Later the owner's phone reads the same from the cloud copy.
 */
async function fromServer(token: string): Promise<SyncEvent[]> {
  const out: SyncEvent[] = [];
  let after = 0;
  for (;;) {
    const r = await fetch(`/api/v1/events?after=${after}&limit=500`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`server ${r.status}`);
    const page = (await r.json()) as PullResponse;
    out.push(...page.events.map((s) => s.event));
    after = page.lastSeq;
    if (!page.more) return out;
  }
}

export const loadShopEvents = async (): Promise<SyncEvent[]> => {
  if (isDemo()) return demoHistory(Date.now());
  const token = syncToken();
  return token ? fromServer(token) : readAll();
};

export type ShopEvents =
  | { state: 'loading' }
  | { state: 'ready'; events: SyncEvent[]; at: number }
  | { state: 'error'; message: string; events?: SyncEvent[]; at?: number };

/** Loads once, then again when this device records something and every minute (insights depend on the time). */
export function useShopEvents(): ShopEvents {
  const [data, setData] = useState<ShopEvents>({ state: 'loading' });
  const last = useRef<SyncEvent[] | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      loadShopEvents().then(
        (events) => { if (alive) { last.current = events; setData({ state: 'ready', events, at: Date.now() }); } },
        (e: unknown) => { if (alive) setData({ state: 'error', message: String(e), events: last.current, at: Date.now() }); },
      );
    };
    load();
    const soon = () => { clearTimeout(pending); pending = setTimeout(load, 1500); };
    const unsubscribe = subscribeEvents(soon);
    const every = setInterval(load, 60_000);
    return () => { alive = false; clearTimeout(pending); clearInterval(every); unsubscribe(); };
  }, []);
  return data;
}
