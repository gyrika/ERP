import type { OnlineOrder, OnlineStatus } from '../src/domain/online.ts';
import type { SyncEvent } from '../src/domain/sync.ts';

/**
 * Online orders at the shop (src/domain/online.ts). Every few seconds the shop server
 * asks the cloud for them, telling it whether the counter is taking orders; the counter
 * reads them from here. The counter's answers go to the cloud straight away, or, when
 * the internet is down, as soon as it is back. The kitchen tapping Done marks an
 * accepted order ready, and its payment marks it collected, without another tap.
 */
export interface OnlineOptions {
  url: string;
  token: string;
  /** Taking online orders (kept in the settings, so a restart keeps it). */
  isOpen(): boolean;
  setOpen(open: boolean): void;
  fetch?: typeof fetch;
  every?: number;
  now?: () => number;
}

export interface OnlineView {
  open: boolean;
  /** The cloud answered lately. */
  connected: boolean;
  orders: OnlineOrder[];
}

export type OnlineAnswer =
  | { status: 'accepted'; orderNumber: number; readyBy: number }
  | { status: 'declined'; reason: string }
  | { status: 'ready' }
  | { status: 'collected' };

export class OnlineError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const MAX_BACKOFF_MS = 60_000;

export function startOnline(o: OnlineOptions) {
  const http = o.fetch ?? fetch;
  const every = o.every ?? 10_000;
  const now = o.now ?? Date.now;
  const headers = { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' };
  let orders: OnlineOrder[] = [];
  let heardAt: number | null = null;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let polling: Promise<void> | null = null;
  /** Answers the cloud has not confirmed yet (the internet was down): sent again on each poll. */
  const owed = new Map<string, OnlineAnswer>();

  const post = (path: string, body: unknown) =>
    http(`${o.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });

  const merge = (order: OnlineOrder) => {
    orders = orders.some((x) => x.id === order.id) ? orders.map((x) => (x.id === order.id ? order : x)) : [...orders, order];
  };
  /** The counter sees an answer at once, before the cloud confirms it. */
  const applyLocally = (id: string, a: OnlineAnswer) => {
    const hit = orders.find((x) => x.id === id);
    if (hit) merge({ ...hit, ...a, status: a.status as OnlineStatus });
  };

  /** Sends one answer. Network trouble: owed for later. The cloud refusing it: thrown (the counter says why). */
  const send = async (id: string, a: OnlineAnswer): Promise<void> => {
    let r: Response;
    try { r = await post(`/api/v1/online/${id}`, a); } catch { owed.set(id, a); return; }
    if (r.status >= 500) { owed.set(id, a); return; }
    owed.delete(id);
    const body = (await r.json().catch(() => ({}))) as OnlineOrder & { message?: string };
    if (!r.ok) throw new OnlineError(r.status, body.message ?? `the cloud answered ${r.status}`);
    merge(body);
  };

  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => void poll(), ms);
  };

  const poll = (): Promise<void> => {
    polling ??= (async () => {
      try {
        // Close by itself overnight, so a forgotten switch never takes orders at 3 am.
        const hour = new Date(now()).getHours();
        if (o.isOpen() && hour >= 2 && hour < 6) o.setOpen(false);
        for (const [id, a] of [...owed]) await send(id, a).catch(() => owed.delete(id));
        const r = await post('/api/v1/online/poll', { open: o.isOpen() });
        if (!r.ok) throw new Error(`the cloud answered ${r.status}`);
        const fresh = ((await r.json()) as { orders: OnlineOrder[] }).orders;
        // An answer still owed wins over what the cloud has not heard yet.
        orders = fresh.map((x) => { const a = owed.get(x.id); return a ? { ...x, ...a, status: a.status as OnlineStatus } : x; });
        heardAt = now();
        failures = 0;
        schedule(every);
      } catch {
        schedule(Math.min(MAX_BACKOFF_MS, every * 2 ** failures++));
      } finally {
        polling = null;
      }
    })();
    return polling;
  };

  void poll();

  return {
    view: (): OnlineView => ({
      open: o.isOpen(),
      connected: heardAt !== null && now() - heardAt < Math.max(3 * every, 30_000),
      orders: orders.filter((x) => x.status === 'new' || x.status === 'accepted' || x.status === 'ready'),
    }),
    setOpen(open: boolean) { o.setOpen(open); void poll(); },
    async answer(id: string, a: OnlineAnswer) {
      applyLocally(id, a);
      await send(id, a);
    },
    /** New events at the shop: the kitchen's Done marks an online order ready; its payment, collected. */
    onEvents(events: SyncEvent[]) {
      for (const e of events) {
        const to = e.type === 'kitchen.bumped' ? 'ready' : e.type === 'order.paid' ? 'collected' : null;
        if (!to) continue;
        const hit = orders.find((x) => x.orderNumber === e.orderNumber && (x.status === 'accepted' || (to === 'collected' && x.status === 'ready')));
        if (hit) { applyLocally(hit.id, { status: to }); void send(hit.id, { status: to }).catch(() => {}); }
      }
    },
    /** One poll now (tests). */
    pollNow: () => poll(),
    stop() { stopped = true; clearTimeout(timer); },
  };
}
export type Online = ReturnType<typeof startOnline>;
