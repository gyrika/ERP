import type { OnlineOrder } from '../domain/online.ts';
import { isKitchenDevice, syncToken } from './pairing.ts';

/**
 * The counter's view of online orders, read from the shop server (server/online.ts)
 * every few seconds while the Register shows. Nothing here on a kitchen tablet, a phone,
 * the demo, or a counter whose shop has no cloud connection (`available: false`).
 */
export interface OnlineState {
  available: boolean;
  /** Taking online orders (the counter's switch). */
  open: boolean;
  /** The shop server reaches the cloud: customers can order. */
  connected: boolean;
  orders: OnlineOrder[];
}
export type OnlineAnswer =
  | { status: 'accepted'; orderNumber: number; readyBy: number }
  | { status: 'declined'; reason: string }
  | { status: 'out' };

const EVERY_MS = 5_000;
const NONE: OnlineState = { available: false, open: false, connected: false, orders: [] };
let state = NONE;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

const set = (next: OnlineState) => { state = next; listeners.forEach((l) => l()); };

const call = async (path: string, body?: unknown): Promise<OnlineState> => {
  const r = await fetch(`/api/v1/online${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${syncToken()}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await r.json().catch(() => ({}))) as OnlineState & { message?: string };
  if (!r.ok) throw new Error(json.message ?? 'the shop server did not answer');
  return { available: json.available ?? true, open: json.open, connected: json.connected, orders: json.orders ?? [] };
};

const refresh = () => { call('').then(set, () => set({ ...state, connected: false })); };

export const onlineOrders = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1 && syncToken() && !isKitchenDevice()) { refresh(); timer = setInterval(refresh, EVERY_MS); }
    return () => {
      listeners.delete(listener);
      if (!listeners.size) { clearInterval(timer); timer = undefined; }
    };
  },
  get: (): OnlineState => state,
  /** Switches taking online orders on or off. */
  async setOpen(open: boolean) { set({ ...state, open }); set(await call('/open', { open })); },
  /** Accept or decline. Returns why it could not be done, or null. */
  async answer(id: string, a: OnlineAnswer): Promise<string | null> {
    try { set(await call(`/${id}`, a)); return null; } catch (e) { refresh(); return e instanceof Error ? e.message : String(e); }
  },
};
