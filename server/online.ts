import { IN_PLAY, paidStatus, type OnlineOrder, type OnlineStatus } from '../src/domain/online.ts';
import type { SyncEvent } from '../src/domain/sync.ts';

/**
 * Online orders at the shop (src/domain/online.ts). Every few seconds the shop server
 * asks the cloud for them, telling it whether the counter is taking orders; the counter
 * reads them from here. The counter's answers go to the cloud straight away, or, when
 * the internet is down, as soon as it is back. The kitchen tapping Done marks an
 * accepted order ready, and its payment marks it collected (a delivery: delivered), without
 * another tap. Only the rider leaving (Out) is the counter's own tap.
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
  | { status: 'out' }
  | { status: 'collected' }
  | { status: 'delivered' };

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
  /** The night online orders last switched themselves off (once a night, so staff can switch them back on). */
  let closedNight = '';
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
        // Close by itself once a night, so a forgotten switch never takes orders at 3 am;
        // a shop open late can switch it back on, and it stays on.
        const d = new Date(now());
        const night = d.toDateString();
        if (d.getHours() >= 2 && d.getHours() < 6 && closedNight !== night) {
          closedNight = night;
          if (o.isOpen()) o.setOpen(false);
        }
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
      orders: orders.filter((x) => IN_PLAY.includes(x.status)),
    }),
    setOpen(open: boolean) { o.setOpen(open); void poll(); },
    async answer(id: string, a: OnlineAnswer) {
      applyLocally(id, a);
      await send(id, a);
    },
    /** New events at the shop: the kitchen's Done marks an online order ready; its payment, collected or delivered. */
    onEvents(events: SyncEvent[]) {
      for (const e of events) {
        const paid = e.type === 'order.paid';
        if (!paid && e.type !== 'kitchen.bumped') continue;
        const hit = orders.find((x) => x.orderNumber === e.orderNumber && (x.status === 'accepted' || (paid && (x.status === 'ready' || x.status === 'out'))));
        if (!hit) continue;
        const to = paid ? paidStatus(hit.kind ?? 'pickup') : 'ready';
        applyLocally(hit.id, { status: to } as OnlineAnswer);
        void send(hit.id, { status: to } as OnlineAnswer).catch(() => {});
      }
    },
    /** One poll now (tests). */
    pollNow: () => poll(),
    stop() { stopped = true; clearTimeout(timer); },
  };
}
export type Online = ReturnType<typeof startOnline>;
