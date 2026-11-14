/**
 * The offers inbox on cheesybeez.com (CRM): every offer this phone received, kept on the phone itself.
 * The service worker (public/order-sw.js) saves each one as it arrives, before it shows the
 * notification; the site lists them under the bell. Nothing goes to a server and there is no login:
 * the list is this phone's, private, and there offline. It starts when offers are turned on, and
 * clearing the browser's data empties it (the owner approved this, 2026-11-14).
 *
 * The database's name, store and limits are written in the service worker too (it cannot import):
 * keep both in step.
 */
export interface Offer { id: string; title: string; body: string; at: number }

export const OFFERS_DB = 'cheesybeez-offers';
export const OFFERS_STORE = 'offers';
/** Older offers are long over; a phone keeps at most this many. */
export const KEEP_DAYS = 90;
export const KEEP_MAX = 50;
const DAY_MS = 86_400_000;

/** Newest first, nothing older than KEEP_DAYS, at most KEEP_MAX. */
export const keepOffers = (list: readonly Offer[], now: number): Offer[] =>
  list.filter((o) => now - o.at < KEEP_DAYS * DAY_MS).sort((a, b) => b.at - a.at).slice(0, KEEP_MAX);

/** How many arrived since the list was last opened. */
export const unseenCount = (list: readonly Offer[], seenAt: number): number => list.filter((o) => o.at > seenAt).length;

/** When the list was last opened (on this phone). */
const SEEN = 'cb.order.offersSeen';
export const seenAt = (): number => { try { return Number(localStorage.getItem(SEEN)) || 0; } catch { return 0; } };
export const markSeen = (at: number): void => { try { localStorage.setItem(SEEN, String(at)); } catch { /* private mode: they show as new again */ } };

const isOffer = (v: unknown): v is Offer => {
  const o = v as Partial<Offer> | null;
  return !!o && typeof o.id === 'string' && typeof o.title === 'string' && typeof o.body === 'string' && Number.isFinite(o.at);
};

/** The offers this phone kept; none where the browser has no IndexedDB (or blocks it). */
export function readOffers(now = Date.now()): Promise<Offer[]> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(OFFERS_DB, 1); } catch { resolve([]); return; }
    req.onupgradeneeded = () => { req.result.createObjectStore(OFFERS_STORE, { keyPath: 'id' }); };
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const all = db.transaction(OFFERS_STORE, 'readonly').objectStore(OFFERS_STORE).getAll();
        all.onsuccess = () => { resolve(keepOffers((all.result as unknown[]).filter(isOffer), now)); db.close(); };
        all.onerror = () => { resolve([]); db.close(); };
      } catch { resolve([]); db.close(); }
    };
  });
}

/**
 * What the service worker tells an open page: a new offer was saved (the bell counts it at once),
 * or a notification was tapped (the inbox opens).
 */
export function onOfferMessage(cb: (kind: 'new' | 'open') => void): () => void {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker?.addEventListener) return () => {};
  const listen = (e: MessageEvent) => {
    const type = (e.data as { type?: string } | null)?.type;
    if (type === 'cheesybeez-offer') cb('new');
    if (type === 'cheesybeez-open-inbox') cb('open');
  };
  navigator.serviceWorker.addEventListener('message', listen);
  return () => navigator.serviceWorker.removeEventListener('message', listen);
}
