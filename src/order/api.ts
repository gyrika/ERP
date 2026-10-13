import type { MenuState } from '../domain/menuEdits.ts';
import type { OnlineLine, OnlineOrder } from '../domain/online.ts';

/** The cloud's customer endpoints (cloud/src/online.ts). Same address as this page. */
export interface ShopInfo { name: string; open: boolean; menuState?: MenuState }
export interface Placed { id: string; token: string; total: number }
export type MyOrder = Omit<OnlineOrder, 'phone'>;

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
  place: (o: { name: string; phone: string; note: string; lines: OnlineLine[] }) => call<Placed>('/api/v1/orders', o),
  order: (id: string, token: string) => call<MyOrder>(`/api/v1/orders/${id}?t=${encodeURIComponent(token)}`),
};

// ----- What this phone remembers (never needed: everything works without it) -----

const read = <T>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
};
const write = (key: string, value: unknown) => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
};

export const remembered = {
  basket: () => read<OnlineLine[]>('cb.order.basket', []),
  setBasket: (b: OnlineLine[]) => write('cb.order.basket', b.length ? b : null),
  /** Name and phone, so the next order is two taps. */
  me: () => read<{ name: string; phone: string }>('cb.order.me', { name: '', phone: '' }),
  setMe: (me: { name: string; phone: string }) => write('cb.order.me', me),
  /** The order being followed, and the one before (for "Order the same again"). */
  current: () => read<Placed | null>('cb.order.current', null),
  setCurrent: (p: Placed | null) => write('cb.order.current', p),
  last: () => read<OnlineLine[]>('cb.order.last', []),
  setLast: (lines: OnlineLine[]) => write('cb.order.last', lines),
};
