import type { Actor, AuthService } from '../domain/auth.ts';
import type { PushResponse } from '../domain/sync.ts';
import { markRejected, markSynced, readAll, readOutbox, subscribeEvents } from '../ui/eventLog.ts';
import { phoneToken } from './pairing.ts';

/**
 * The phone apps (SCRUM-94/95), served by the cloud. A manager's phone was made for one
 * person at the shop PC; the owner's phone signs as the owner. The cloud says who
 * (/api/v1/me), and everything it records is signed with them. What it records goes to the cloud's inbox,
 * from where the shop PC takes it; on weak signal it simply waits on the phone.
 */
const ME = 'cb.manager.me';
const RETRY_MS = 20_000;

interface Me { actor: Actor; shopId: string }
const readMe = (): Me | null => { try { return JSON.parse(localStorage.getItem(ME) ?? 'null') as Me | null; } catch { return null; } };

/** Who this phone is for. Asked once, then kept (it never changes for a phone). */
export const loadMe = async (): Promise<Me | null> => {
  const known = readMe();
  if (known) return known;
  const token = phoneToken();
  if (!token) return null;
  const r = await fetch('/api/v1/me', { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(r.status === 401 ? 'This link is no longer valid. Ask for a new QR code.' : `cloud ${r.status}`);
  const me = (await r.json()) as Me;
  try { localStorage.setItem(ME, JSON.stringify(me)); } catch { /* blocked: asked again next time */ }
  return me;
};

export const phoneAuth: AuthService = {
  shopId: () => readMe()?.shopId ?? '',
  currentCashier: () => readMe()?.actor ?? { id: 'unknown', name: 'Manager', role: 'manager' },
  // PINs live on the shop PC only; nothing on the phone needs one (Edit lists stays at the shop).
  verifyManagerPin: async () => null,
};

let timer: ReturnType<typeof setTimeout> | undefined;
let busy = false;

/** Sends what this phone recorded to the cloud's inbox; whatever does not get through waits. */
export const flushOutbox = async (): Promise<void> => {
  const token = phoneToken();
  if (!token || busy) return;
  busy = true;
  clearTimeout(timer);
  try {
    const waiting = new Set(readOutbox());
    const events = readAll().filter((e) => waiting.has(e.id));
    if (!events.length) return;
    const r = await fetch('/api/v1/inbox', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events }), signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`inbox ${r.status}`);
    const res = (await r.json()) as PushResponse;
    markSynced(res.accepted.map((a) => a.id));
    if (res.rejected?.length) markRejected(res.rejected);
  } catch {
    timer = setTimeout(() => void flushOutbox(), RETRY_MS);
  } finally {
    busy = false;
  }
};

/** Sends each new count at once, and again whenever the signal comes back. */
export const startManagerPhone = (): void => {
  subscribeEvents(() => void flushOutbox());
  window.addEventListener('online', () => void flushOutbox());
  void flushOutbox();
};
