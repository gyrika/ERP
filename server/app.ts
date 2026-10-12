import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { managesRole, mayRecord } from '../src/domain/auth.ts';
import type { OrderEvent } from '../src/domain/events.ts';
import {
  PULL_LIMIT, type ApiError, type LoginResponse, type PullResponse, type PushResponse, type StreamMessage, type SyncEvent,
  type SyncedEvent,
} from '../src/domain/sync.ts';
import { isPin } from './pins.ts';
import type { RawPrinter } from './printer.ts';
import type { ReplicaStatus } from './replicator.ts';
import type { Device, EventStore } from './store.ts';
import { validatePush } from './validate.ts';

/**
 * The sync server (docs/sync-contract.md): stores events, hands them out in
 * order, streams new ones to every open device of the same shop. It also
 * serves the built app, so the counter PC runs one program and the kitchen
 * device just opens http://<PC address>:<port>/#kitchen.
 */
export interface AppOptions {
  store: EventStore;
  /** The built app (vite build → dist). Omit to serve the API only. */
  staticDir?: string;
  /** The receipt printer on this PC. Omit and printing answers 503. */
  printer?: RawPrinter;
  /** New events were stored for this shop (the cloud copy follows). */
  onStored?: (tenantId: string) => void;
  /** The cloud copy's state, shown by the health check (null: no cloud copy set up). */
  cloudStatus?: () => ReplicaStatus | null;
  now?: () => number;
}

const MAX_BODY = 1_000_000; // 100 events are far below this
const MAX_PRINT = 64_000; // a long receipt is ~3 KB of ESC/POS

/** A shift login lasts a working day; manager mode a few minutes (it ends after 10 s idle anyway). */
export const SHIFT_MS = 14 * 60 * 60_000;
export const MANAGER_MS = 15 * 60_000;
/** Device clocks drift a little from the server's; on the counter PC they are the same clock. */
const CLOCK_SLACK_MS = 2 * 60_000;
/** Wrong PINs: after this many in a row, the device waits before it may try again. */
const MAX_WRONG = 5;
const WRONG_WAIT_MS = 30_000;

class HttpError extends Error {
  status: number;
  code: ApiError['error'];
  constructor(status: number, code: ApiError['error'], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(400, 'invalid_event', 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'invalid_event', 'body is not JSON')); }
    });
    req.on('error', reject);
  });

const bearer = (req: IncomingMessage, url: URL): string | null => {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  // Browsers cannot set headers on a WebSocket, so the stream takes the token in the URL.
  return url.searchParams.get('token');
};

const nonNegInt = (v: string | null, fallback: number): number => {
  const n = v === null ? fallback : Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json',
};

/** One open stream. Until its catch-up is sent, live events wait in `held`. */
interface Stream {
  ws: WebSocket;
  held: SyncedEvent[] | null;
}

const send = (ws: WebSocket, m: StreamMessage) => ws.send(JSON.stringify(m));

export function createApp({ store, staticDir, printer, onStored, cloudStatus, now = Date.now }: AppOptions): Server {
  /** Open streams per shop. A shop's events never go to another shop's devices. */
  const streams = new Map<string, Set<Stream>>();
  /** Wrong PIN guesses per device. 10,000 PINs: without a brake, guessing would take minutes. */
  const wrong = new Map<string, { count: number; until: number }>();

  /**
   * SCRUM-41, on the server: an order event counts only if its person was logged in
   * on this device at that moment, with a role that allows it. A kitchen device
   * may only record kitchen taps. Returns why an event is refused, or null.
   */
  const refusal = (device: Device, e: SyncEvent, sessions: Awaited<ReturnType<EventStore['sessions']>>): string | null => {
    if (e.type.startsWith('kitchen.')) return device.kind === 'owner' ? 'not from this device' : null;
    if (device.kind !== 'counter') return 'only the counter records orders';
    const { actor } = e as OrderEvent;
    const s = sessions.find((x) => x.staffId === actor.id && x.role === actor.role
      && e.at >= x.startedAt - CLOCK_SLACK_MS && e.at <= x.expiresAt + CLOCK_SLACK_MS);
    if (!s) return 'that person was not logged in on this device then';
    if (!mayRecord(s.role, e.type)) return `a ${s.role} may not do this`;
    return null;
  };
  const broadcast = (tenantId: string, events: SyncedEvent[]) => {
    for (const st of streams.get(tenantId) ?? []) {
      if (st.held) st.held.push(...events);
      else for (const data of events) send(st.ws, { type: 'event', data });
    }
  };

  const authenticate = async (req: IncomingMessage, url: URL): Promise<Device> => {
    const token = bearer(req, url);
    const device = token ? await store.deviceByToken(token) : null;
    if (!device) throw new HttpError(401, 'unauthorized', 'unknown device token');
    return device;
  };

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname === '/api/v1/health' && req.method === 'GET') {
      const cloud = cloudStatus?.() ?? null;
      json(res, 200, { ok: true, serverTime: now(), ...(cloud ? { cloud } : {}) });
      return;
    }
    if (url.pathname === '/api/v1/login' && req.method === 'POST') {
      const device = await authenticate(req, url);
      const t = now();
      const w = wrong.get(device.id);
      if (w && w.until > t) throw new HttpError(429, 'too_many', 'too many wrong PINs: wait a moment');
      const body = await readBody(req) as { pin?: unknown; purpose?: unknown };
      const purpose = body?.purpose === 'manager' ? 'manager' : 'shift';
      const staff = isPin(body?.pin) ? await store.staffByPin(device.tenantId, body.pin) : null;
      // A cashier's own PIN in the manager box is simply a wrong PIN: it says nothing about who exists.
      if (!staff || (purpose === 'manager' && !managesRole(staff.role))) {
        const count = (w?.count ?? 0) + 1;
        wrong.set(device.id, count >= MAX_WRONG ? { count: 0, until: t + WRONG_WAIT_MS } : { count, until: 0 });
        throw new HttpError(401, 'wrong_pin', 'wrong PIN');
      }
      wrong.delete(device.id);
      const actor = { id: staff.id, name: staff.name, role: staff.role };
      const expiresAt = t + (purpose === 'manager' ? MANAGER_MS : SHIFT_MS);
      await store.startSession(device, actor, t, expiresAt);
      json(res, 200, { actor, expiresAt, serverTime: t } satisfies LoginResponse);
      return;
    }

    if (url.pathname === '/api/v1/print' && req.method === 'POST') {
      const device = await authenticate(req, url);
      // Printing opens the cash drawer: only the counter may, never a kitchen tablet or a phone.
      if (device.kind !== 'counter') throw new HttpError(403, 'forbidden', 'only the counter prints');
      const body = await readBody(req);
      const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
      if (typeof data !== 'string') throw new HttpError(400, 'invalid_event', 'body must be { data: base64 }');
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length || bytes.length > MAX_PRINT) throw new HttpError(400, 'invalid_event', 'receipt is empty or too large');
      if (!printer) throw new HttpError(503, 'printer', 'no printer set up on this PC');
      try { await printer.print(bytes); }
      catch (e) { console.error(e); throw new HttpError(503, 'printer', 'the printer did not take the receipt'); }
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname !== '/api/v1/events') throw new HttpError(404, 'server', 'no such endpoint');
    const device = await authenticate(req, url);

    if (req.method === 'POST') {
      const checked = validatePush(await readBody(req), device.tenantId);
      if ('reason' in checked) {
        throw checked.wrongShop
          ? new HttpError(403, 'wrong_shop', checked.reason)
          : new HttpError(400, 'invalid_event', checked.reason);
      }
      const people = [...new Set(checked.events.flatMap((e) => ('actor' in e ? [e.actor.id] : [])))];
      const sessions = await store.sessions(device, people);
      const rejected: { id: string; reason: string }[] = [];
      const allowed = checked.events.filter((e) => {
        const why = refusal(device, e, sessions);
        if (why) rejected.push({ id: e.id, reason: why });
        return !why;
      });
      const { accepted, stored } = await store.push(device, allowed, now());
      broadcast(device.tenantId, stored);
      if (stored.length) onStored?.(device.tenantId);
      json(res, 200, { accepted, ...(rejected.length ? { rejected } : {}), serverTime: now() } satisfies PushResponse);
      return;
    }

    if (req.method === 'GET') {
      const after = nonNegInt(url.searchParams.get('after'), 0);
      const limit = Math.min(PULL_LIMIT, Math.max(1, nonNegInt(url.searchParams.get('limit'), PULL_LIMIT)));
      // One extra tells us whether there is more without a second query.
      const rows = await store.pull(device.tenantId, after, limit + 1);
      const events = rows.slice(0, limit);
      json(res, 200, {
        events, lastSeq: events.at(-1)?.seq ?? after, more: rows.length > limit, serverTime: now(),
      } satisfies PullResponse);
      return;
    }
    throw new HttpError(405, 'server', 'method not allowed');
  };

  const serveStatic = (res: ServerResponse, url: URL) => {
    if (!staticDir) { json(res, 404, { error: 'server', message: 'not found' } satisfies ApiError); return; }
    const root = normalize(staticDir + sep);
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; } // no ../ out of dist
    let isFile = false;
    try { isFile = statSync(file).isFile(); } catch { /* not there */ }
    if (!isFile) file = join(root, 'index.html'); // one-page app: unknown paths get the app
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      // Vite fingerprints assets, so they can be cached for good; index.html must not be.
      'cache-control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).on('error', () => res.end()).pipe(res);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (!url.pathname.startsWith('/api/')) { serveStatic(res, url); return; }
    api(req, res, url).catch((e: unknown) => {
      if (e instanceof HttpError) { json(res, e.status, { error: e.code, message: e.message } satisfies ApiError); return; }
      console.error(e);
      json(res, 500, { error: 'server', message: 'server error' } satisfies ApiError);
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname !== '/api/v1/stream') { socket.destroy(); return; }
    authenticate(req, url).then(
      (device) => wss.handleUpgrade(req, socket, head, (ws) => { void openStream(ws, device, nonNegInt(url.searchParams.get('after'), 0)); }),
      () => { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); },
    );
  });

  /**
   * hello, then everything after `after`, then each new event as it is stored.
   * The stream is registered before the catch-up starts and holds live events
   * until it ends, so no event can fall between the two or arrive out of order.
   */
  const openStream = async (ws: WebSocket, device: Device, after: number) => {
    const st: Stream = { ws, held: [] };
    const set = streams.get(device.tenantId) ?? new Set();
    streams.set(device.tenantId, set);
    set.add(st);
    const drop = () => set.delete(st);
    ws.on('close', drop);
    ws.on('error', drop);
    try {
      send(ws, { type: 'hello', lastSeq: await store.lastSeq(device.tenantId), serverTime: now() });
      let last = after;
      for (;;) {
        const batch = await store.pull(device.tenantId, last, PULL_LIMIT);
        for (const data of batch) send(ws, { type: 'event', data });
        if (batch.length) last = batch[batch.length - 1].seq;
        if (batch.length < PULL_LIMIT) break;
      }
      const held = st.held ?? [];
      st.held = null;
      for (const data of held) if (data.seq > last) send(ws, { type: 'event', data });
    } catch (e) {
      console.error(e);
      ws.close(1011, 'server error');
    }
  };

  // Stopping must not wait for devices to hang up: close their streams first.
  const close = server.close.bind(server);
  server.close = (cb) => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.closeAllConnections();
    return close(cb);
  };
  return server;
}
