import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { managesRole, mayRecord } from '../src/domain/auth.ts';
import {
  PULL_LIMIT, type ApiError, type LoginResponse, type PullResponse, type PushResponse, type StreamMessage, type SyncEvent, type SyncedEvent,
} from '../src/domain/sync.ts';
import type { UpdateStep } from '../src/domain/updating.ts';
import { isPin } from './pins.ts';
import { OnlineError, type Online, type OnlineAnswer } from './online.ts';
import { MAX_PHOTO_BYTES, isJpeg, type PhotoStore } from './photos.ts';
import { isPhotoId } from '../src/domain/photos.ts';
import type { RawPrinter } from './printer.ts';
import type { ReplicaStatus } from './replicator.ts';
import type { Fleet } from './fleet.ts';
import { SetupError, isLocal, type SetupApi } from './setup.ts';
import type { Device, EventStore } from './store.ts';
import { createNumberer } from './numbering.ts';
import { createScheduler } from './scheduler.ts';
import { createStockRules } from './stockRules.ts';
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
  /** New events were stored for this shop (the cloud copy follows; online orders become ready or collected). */
  onStored?: (tenantId: string, events: SyncEvent[]) => void;
  /** Online orders from cheesybeez.com (server/online.ts), once the cloud is connected. */
  online?: () => Online | null;
  /** The cloud copy's state, shown by the health check (null: no cloud copy set up). */
  cloudStatus?: () => ReplicaStatus | null;
  /** The setup wizard's endpoints (server/setup.ts); answered for this PC only. */
  setup?: SetupApi;
  /** The installed version, shown by the health check (support from afar, Update now). */
  version?: () => string;
  /** An update under way (src/domain/updating.ts), so the counter can say so; null when none. */
  updating?: () => UpdateStep | null;
  /** Shelf photos (SCRUM-94): a copy on this PC of the ones in the cloud. Omit and photos answer 503. */
  photos?: PhotoStore;
  /** Fetches a shelf photo from the cloud (the manager phones keep them there); null when it has none. */
  cloudPhoto?: (tenantId: string, id: string) => Promise<Buffer | null>;
  /** The developer's Shops screen (only where CLOUD_ADMIN_KEY is set: the developer's laptop). */
  fleet?: Fleet | null;
  /**
   * The cloud's language model (SCRUM-144/145): passes a counter's request on with this server's
   * cloud key and returns the cloud's answer as it is; null when there is no cloud or no answer.
   */
  cloudAi?: (tenantId: string, task: 'command' | 'transcribe', body: Buffer, contentType: string) => Promise<{ status: number; body: Buffer } | null>;
  now?: () => number;
}

export type Ingest = (device: Device, events: SyncEvent[]) => Promise<number>;

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

const readRaw = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(400, 'invalid_event', 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const raw = await readRaw(req);
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new HttpError(400, 'invalid_event', 'body is not JSON'); }
};

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

export function createApp({ store, staticDir, printer, onStored, online, cloudStatus, setup, version, updating, fleet, photos, cloudPhoto, cloudAi, now = Date.now }: AppOptions): Server & { ingest: Ingest } {
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
    // Display numbers come from this server alone: a device cannot give a document a number.
    if (e.type === 'stock.numbered') return 'only the shop server numbers documents';
    // Held batches go to the kitchen when the shop server sees their inputs on hand, never on a device's word.
    if (e.type === 'prep.released') return 'only the shop server sends held batches to the kitchen';
    if (e.type.startsWith('kitchen.')) return device.kind === 'owner' || device.kind === 'manager' ? 'not from this device' : null;
    // The manager's phone counts and receives stock (SCRUM-94); orders, menu and recipes stay on the counter.
    if (device.kind === 'manager' && !e.type.startsWith('stock.')) return 'the manager phone records stock only';
    if (device.kind !== 'counter' && device.kind !== 'manager') return 'only the counter records orders and stock';
    if (!('actor' in e)) return 'this event does not say who did it';
    const { actor } = e;
    const s = sessions.find((x) => x.staffId === actor.id && x.role === actor.role
      && e.at >= x.startedAt - CLOCK_SLACK_MS && e.at <= x.expiresAt + CLOCK_SLACK_MS);
    if (!s) return 'that person was not logged in on this device then';
    if (!mayRecord(s.role, e.type)) return `a ${s.role} may not do this`;
    return null;
  };
  const numberDocs = createNumberer(store, now);
  const releaseBatches = createScheduler(store, now);
  const checkStock = createStockRules(store, now);
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
      const update = updating?.() ?? null;
      json(res, 200, { ok: true, serverTime: now(), ...(version ? { version: version() } : {}), ...(cloud ? { cloud } : {}), ...(update ? { update } : {}) });
      return;
    }
    if (url.pathname === '/api/v1/fleet' || url.pathname.startsWith('/api/v1/fleet/')) {
      // Only on the developer's laptop, and only from that computer itself (never a tablet on its Wi-Fi).
      if (!fleet || !isLocal(req)) throw new HttpError(404, 'server', 'no shops here');
      if (req.method !== 'GET') throw new HttpError(405, 'server', 'method not allowed');
      const one = /^\/api\/v1\/fleet\/shops\/([a-z0-9-]{1,64})\/events$/.exec(url.pathname);
      try {
        if (url.pathname === '/api/v1/fleet') { json(res, 200, { available: true }); return; }
        if (url.pathname === '/api/v1/fleet/shops') { json(res, 200, await fleet.shops()); return; }
        if (one) {
          const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
          const limit = Math.min(PULL_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || PULL_LIMIT));
          json(res, 200, await fleet.events(one[1], after, limit));
          return;
        }
      } catch (e) {
        throw new HttpError(502, 'server', e instanceof Error ? e.message : String(e));
      }
      throw new HttpError(404, 'server', 'no such page');
    }
    if (url.pathname === '/api/v1/setup' || url.pathname.startsWith('/api/v1/setup/')) {
      if (!setup) throw new HttpError(404, 'server', 'no setup here');
      // Only the shop PC itself: a tablet or phone on the Wi-Fi never sets up or changes the shop.
      if (!isLocal(req)) throw new HttpError(403, 'forbidden', 'setup is only possible on the shop PC itself');
      const step = url.pathname.slice('/api/v1/setup'.length);
      try {
        if (step === '' && req.method === 'GET') { json(res, 200, await setup.state()); return; }
        if (req.method !== 'POST') throw new HttpError(405, 'server', 'method not allowed');
        const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
        const routes: Record<string, (b: Record<string, unknown>) => Promise<unknown>> = {
          '/shop': setup.nameShop, '/printer': setup.setPrinter, '/staff': setup.addStaff, '/staff/list': setup.staff,
          '/staff/remove': setup.removeStaff, '/pair': setup.pair, '/cloud': setup.connectCloud, '/finish': () => setup.finish(),
          '/update/check': setup.checkUpdate, '/update/install': setup.installUpdate, '/update/status': setup.updateStatus,
          '/cv/status': setup.cvStatus, '/cv/activate': setup.cvActivate,
        };
        const route = routes[step];
        if (!route) throw new HttpError(404, 'server', 'no such setup step');
        json(res, 200, await route(body));
      } catch (e) {
        if (e instanceof SetupError) { json(res, e.status, { error: e.code, message: e.message }); return; }
        throw e;
      }
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
      // The same on the manager's phone: it opens for managers and owners only (SCRUM-94).
      if (!staff || ((purpose === 'manager' || device.kind === 'manager') && !managesRole(staff.role))) {
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
    if (url.pathname === '/api/v1/photos' || url.pathname.startsWith('/api/v1/photos/')) {
      const device = await authenticate(req, url);
      // Proof of a count, shown at the counter; never on a kitchen tablet.
      if (device.kind !== 'counter') throw new HttpError(403, 'forbidden', 'only the counter sees photos');
      if (!photos) throw new HttpError(503, 'server', 'photos are not kept on this server');
      const id = url.pathname.slice('/api/v1/photos/'.length);
      if (req.method !== 'GET' || !isPhotoId(id)) throw new HttpError(404, 'server', 'no such photo');
      // From this PC's copy; the first time, from the cloud (then kept here, for when the internet is down).
      let jpeg = photos.read(device.tenantId, id);
      if (!jpeg && cloudPhoto) {
        const got = await cloudPhoto(device.tenantId, id).catch(() => null);
        if (got && isJpeg(got) && got.length <= MAX_PHOTO_BYTES) { photos.save(device.tenantId, id, got); jpeg = got; }
      }
      if (!jpeg) throw new HttpError(404, 'server', 'no such photo');
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' });
      res.end(jpeg);
      return;
    }
    // Opening a page by voice (SCRUM-145): the words and the page pick come from the cloud's model.
    if (url.pathname === '/api/v1/ai/command' || url.pathname === '/api/v1/ai/transcribe') {
      const device = await authenticate(req, url);
      if (device.kind !== 'counter') throw new HttpError(403, 'forbidden', 'voice is for the counter');
      if (req.method !== 'POST') throw new HttpError(405, 'server', 'method not allowed');
      const body = await readRaw(req);
      const task = url.pathname === '/api/v1/ai/command' ? 'command' : 'transcribe';
      const answer = cloudAi ? await cloudAi(device.tenantId, task, body, String(req.headers['content-type'] ?? 'application/json')) : null;
      if (!answer) throw new HttpError(503, 'unavailable', 'voice needs the internet and the cloud connected');
      res.writeHead(answer.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(answer.body);
      return;
    }
    if (url.pathname === '/api/v1/online' || url.pathname.startsWith('/api/v1/online/')) {
      const device = await authenticate(req, url);
      // Customers' names and phone numbers: the counter only, never a kitchen tablet or a phone.
      if (device.kind !== 'counter') throw new HttpError(403, 'forbidden', 'only the counter takes online orders');
      const o = online?.() ?? null;
      if (url.pathname === '/api/v1/online' && req.method === 'GET') {
        json(res, 200, o ? { available: true, ...o.view() } : { available: false, open: false, connected: false, orders: [] });
        return;
      }
      if (!o) throw new HttpError(409, 'server', 'connect the cloud first (Shop setup → Cloud)');
      if (req.method !== 'POST') throw new HttpError(405, 'server', 'method not allowed');
      const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
      if (url.pathname === '/api/v1/online/open') {
        o.setOpen(body.open === true);
        json(res, 200, o.view());
        return;
      }
      const id = url.pathname.slice('/api/v1/online/'.length);
      if (!/^o-[A-Za-z0-9_-]{8,20}$/.test(id)) throw new HttpError(404, 'server', 'no such online order');
      try { await o.answer(id, body as unknown as OnlineAnswer); }
      catch (e) { if (e instanceof OnlineError) throw new HttpError(e.status === 404 ? 404 : 409, 'forbidden', e.message); throw e; }
      json(res, 200, o.view());
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
      // The purchasing rules, against what the shop has stored (so no device is trusted alone).
      const { result, rejected: refused } = await checkStock(device, allowed, (ok) => store.push(device, ok, now()));
      rejected.push(...refused);
      const { accepted, stored: pushed } = result;
      // New purchase orders and GRNs get their number here, as records after them.
      const numbered = [...pushed, ...await numberDocs(device, allowed.filter((e) => !refused.some((r) => r.id === e.id)))];
      // Held batches whose inputs are now on hand go to the kitchen (production scheduling).
      const stored = [...numbered, ...await releaseBatches(device, numbered.map((s) => s.event))];
      broadcast(device.tenantId, stored);
      if (stored.length) onStored?.(device.tenantId, stored.map((s) => s.event));
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

  /** Events from elsewhere (the manager phones, through the cloud): stored as from `device`, then streamed as usual. */
  const ingest: Ingest = async (device, events) => {
    const { result, rejected } = await checkStock(device, events, (ok) => store.push(device, ok, now()));
    const { stored: pushed } = result;
    const numbered = [...pushed, ...await numberDocs(device, events.filter((e) => !rejected.some((r) => r.id === e.id)))];
    const stored = [...numbered, ...await releaseBatches(device, numbered.map((s) => s.event))];
    broadcast(device.tenantId, stored);
    if (stored.length) onStored?.(device.tenantId, stored.map((s) => s.event));
    return pushed.length;
  };

  // Stopping must not wait for devices to hang up: close their streams first.
  const close = server.close.bind(server);
  server.close = (cb) => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.closeAllConnections();
    return close(cb);
  };
  return Object.assign(server, { ingest });
}
