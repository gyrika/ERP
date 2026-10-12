import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PULL_LIMIT, type ApiError, type PullResponse, type PushResponse, type StreamMessage, type SyncedEvent,
} from '../src/domain/sync.ts';
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
  now?: () => number;
}

const MAX_BODY = 1_000_000; // 100 events are far below this

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

export function createApp({ store, staticDir, now = Date.now }: AppOptions): Server {
  /** Open streams per shop. A shop's events never go to another shop's devices. */
  const streams = new Map<string, Set<Stream>>();

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
      json(res, 200, { ok: true, serverTime: now() });
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
      const { accepted, stored } = await store.push(device, checked.events, now());
      broadcast(device.tenantId, stored);
      json(res, 200, { accepted, serverTime: now() } satisfies PushResponse);
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
