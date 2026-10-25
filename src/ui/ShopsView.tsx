import { useEffect, useState } from 'react';
import { isNewer } from '../domain/version.ts';

/**
 * Shops (the developer's screen, on the developer's laptop): every shop in the cloud,
 * read through this computer's own server (server/fleet.ts). One tap opens that shop's
 * Owner view: its sales, cards and stock, read-only.
 */
interface ShopRow {
  id: string;
  name: string;
  version: string | null;
  update: { phase: string; version: string; at: number } | null;
  lastSeenAt: number | null;
  lastSaleAt: number | null;
  eventsToday: number;
}

type State = { state: 'loading' } | { state: 'ready'; shops: ShopRow[]; latest: string | null; at: number } | { state: 'error'; message: string };

const UPDATE_WORDS: Record<string, string> = {
  done: 'Updated', back: 'Went back', failed: 'Update failed', 'going-back': 'Going back', 'up-to-date': 'Up to date',
  checking: 'Checking', downloading: 'Downloading', backup: 'Backing up', installing: 'Installing', starting: 'Starting',
  waiting: 'Ready to install',
};

/** "just now", "4 min ago", "3 h ago", "2 days ago". */
export const ago = (t: number | null, now: number): string => {
  if (t === null) return 'never';
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
};

/** Is the Shops screen available here (the server has the admin password, and this is that computer)? */
export function useFleet(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch('/api/v1/fleet').then((r) => { if (alive) setOn(r.ok); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return on;
}

export function ShopsView({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<State>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/v1/fleet/shops', { signal: AbortSignal.timeout(25_000) });
        const body = await r.json();
        if (!r.ok) throw new Error(body?.message ?? `server ${r.status}`);
        if (alive) setData({ state: 'ready', shops: body.shops, latest: body.latest, at: Date.now() });
      } catch (e) {
        if (alive) setData({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    };
    void load();
    const every = setInterval(() => void load(), 30_000);
    return () => { alive = false; clearInterval(every); };
  }, []);

  const now = data.state === 'ready' ? data.at : Date.now();
  const online = (s: ShopRow) => s.lastSeenAt !== null && now - s.lastSeenAt < 2 * 60_000;

  return (
    <div className="owner">
      <header className="owner__head">
        <button type="button" className="shops__back" onClick={onBack}>Register</button>
        <span className="brand">Shops</span>
        {data.state === 'ready' && <span className="owner__updated">Updated {new Date(data.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
      </header>
      <main className="owner__main shops" aria-label="Shops">
        {data.state === 'loading' && <div className="shops__card skeleton" aria-label="Loading" />}
        {data.state === 'error' && <p className="shops__error" role="alert">Could not reach the cloud: {data.message}</p>}
        {data.state === 'ready' && (
          <>
            <p className="shops__lead">
              {data.shops.filter(online).length} of {data.shops.length} online · latest release {data.latest ?? 'unknown'}
            </p>
            {data.shops.map((s) => {
              const behind = !!(data.latest && s.version && isNewer(data.latest, s.version));
              const bad = s.update && ['failed', 'back'].includes(s.update.phase);
              return (
                <a key={s.id} className="shops__card" href={`#shops/${s.id}`}>
                  <span className="shops__name">{s.name}</span>
                  <span className={`shops__state${online(s) ? ' shops__state--on' : ''}`}>
                    {online(s) ? 'Online' : `Offline · ${ago(s.lastSeenAt, now)}`}
                  </span>
                  <span className="shops__id">{s.id}</span>
                  <span className="shops__facts">
                    <span className={behind ? 'shops__warn' : ''}>
                      Version {s.version ?? 'unknown'}{behind ? ` · ${data.latest} waiting` : ''}
                    </span>
                    <span className={bad ? 'shops__bad' : ''}>
                      {s.update ? `${UPDATE_WORDS[s.update.phase] ?? s.update.phase} ${s.update.version} · ${ago(s.update.at, now)}` : 'No update yet'}
                    </span>
                    <span>Last sale {ago(s.lastSaleAt, now)} · {s.eventsToday} events today</span>
                  </span>
                </a>
              );
            })}
          </>
        )}
      </main>
    </div>
  );
}
