import type { MenuState } from '../domain/menuEdits.ts';
import type { DeliveryPin, DeliveryQuote, OnlineKind, OnlineLine, OnlineOrder, OpeningHours } from '../domain/online.ts';

/** The cloud's customer endpoints (cloud/src/online.ts). Same address as this page. */
/**
 * The cloud's /api/v1/shop. phone (0XXXXXXXXX) and address only when the owner has given them.
 * delivery: cents a started km and the farthest km; null (or missing) = pickup only.
 */
export interface ShopInfo {
  name: string; open: boolean; hours?: OpeningHours | null; phone?: string | null; address?: string | null;
  delivery?: { perKm: number; maxKm: number } | null; menuState?: MenuState;
}
export interface Placed { id: string; token: string; total: number }
export type MyOrder = Omit<OnlineOrder, 'phone' | 'pin'>;
export interface NewOrder {
  kind: OnlineKind; name: string; phone: string; address?: string; pin?: DeliveryPin | null; note: string; lines: OnlineLine[];
}

const call = async <T>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await r.json().catch(() => ({}))) as T & { message?: string };
  if (!r.ok) throw new Error(json.message ?? 'Something went wrong. Please try again.');
  return json;
};

export const api = {
  shop: () => call<ShopInfo>('/api/v1/shop'),
  place: (o: NewOrder) => call<Placed>('/api/v1/orders', o),
  /** What delivery to this location costs (the cloud measures it), or why it cannot be delivered to. */
  quote: (pin: DeliveryPin) => call<DeliveryQuote>('/api/v1/delivery-quote', { pin }),
  order: (id: string, token: string) => call<MyOrder>(`/api/v1/orders/${id}?t=${encodeURIComponent(token)}`),
};

// ----- What this phone remembers (never needed: everything works without it) -----

export interface Me { name: string; phone: string; address: string }

const read = <T>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
};
const write = (key: string, value: unknown) => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
};

export const remembered = {
  basket: () => read<OnlineLine[]>('cb.order.basket', []),
  setBasket: (b: OnlineLine[]) => write('cb.order.basket', b.length ? b : null),
  /** Name, phone and the delivery address, so the next order is two taps. */
  me: () => ({ name: '', phone: '', address: '', ...read<Partial<Me>>('cb.order.me', {}) }),
  setMe: (me: Me) => write('cb.order.me', me),
  /** Pickup or delivery, as last chosen. */
  kind: () => read<OnlineKind>('cb.order.kind', 'pickup'),
  setKind: (k: OnlineKind) => write('cb.order.kind', k),
  /** The order being followed, and the one before (for "Order the same again"). */
  current: () => read<Placed | null>('cb.order.current', null),
  setCurrent: (p: Placed | null) => write('cb.order.current', p),
  last: () => read<OnlineLine[]>('cb.order.last', []),
  setLast: (lines: OnlineLine[]) => write('cb.order.last', lines),
};
