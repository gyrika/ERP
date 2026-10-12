import { PULL_LIMIT, PUSH_BATCH, type ApiError, type PullResponse, type SyncedEvent } from '../../src/domain/sync.ts';
import { validatePush } from '../../server/validate.ts';

/**
 * The cloud copy (SCRUM-61). The shop server stays the truth for selling (it
 * works without internet); whenever the internet is up, it copies its events
 * here, so they survive the shop PC and can be read from anywhere (support from
 * Galle, the owner's phone, the examiners' link).
 *
 * Runs on Cloudflare Workers with a D1 (SQLite) database. Written against the
 * small part of D1 it needs, so the tests run it on Node's own SQLite.
 */

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<{ meta: { changes: number } }[]>;
}

type Kind = 'shop_server' | 'owner';
interface CloudDevice { id: string; tenantId: string; kind: Kind }

/** POST /api/v1/replica: events exactly as the shop server holds them, oldest first. */
export interface ReplicaPush { events: SyncedEvent[] }
export interface ReplicaState { lastSourceSeq: number; serverTime: number }

class HttpError extends Error {
  status: number;
  code: ApiError['error'];
  constructor(status: number, code: ApiError['error'], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const isInt = (v: unknown): v is number => Number.isSafeInteger(v);

/** A random token: 32 bytes, URL-safe. */
const newToken = (): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const newId = (): string => `cloud-${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

/** Compares without leaking, through timing, how much of a guess was right. */
const sameText = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export interface CloudOptions {
  now?: () => number;
  /**
   * The shop code (a Worker secret, ENROL_CODE): whoever installs a shop types it in the
   * setup wizard, and the shop server registers itself. Without it, nobody can add a shop.
   */
  enrolCode?: string;
}

export function createCloud(db: D1Like, options: CloudOptions | (() => number) = {}) {
  const { now = Date.now, enrolCode } = typeof options === 'function' ? { now: options, enrolCode: undefined } : options;
  const authenticate = async (req: Request, allowed: Kind[]): Promise<CloudDevice> => {
    const h = req.headers.get('authorization');
    const token = h?.startsWith('Bearer ') ? h.slice(7) : null;
    const row = token
      ? await db.prepare('SELECT id, tenant_id, kind FROM devices WHERE token_hash = ?').bind(await sha256Hex(token))
        .first<{ id: string; tenant_id: string; kind: Kind }>()
      : null;
    if (!row) throw new HttpError(401, 'unauthorized', 'unknown device token');
    if (!allowed.includes(row.kind)) throw new HttpError(403, 'forbidden', 'not for this device');
    return { id: row.id, tenantId: row.tenant_id, kind: row.kind };
  };

  const lastSourceSeq = async (tenantId: string): Promise<number> =>
    (await db.prepare('SELECT COALESCE(MAX(source_seq), 0) AS s FROM events WHERE tenant_id = ?').bind(tenantId)
      .first<{ s: number }>())?.s ?? 0;

  const routes = async (req: Request, url: URL): Promise<Response> => {
    if (url.pathname === '/api/v1/health' && req.method === 'GET') return json(200, { ok: true, serverTime: now() });

    if (url.pathname === '/api/v1/replica') {
      const device = await authenticate(req, ['shop_server']);
      if (req.method === 'GET') {
        return json(200, { lastSourceSeq: await lastSourceSeq(device.tenantId), serverTime: now() } satisfies ReplicaState);
      }
      if (req.method !== 'POST') throw new HttpError(405, 'server', 'method not allowed');
      let body: unknown;
      try { body = await req.json(); } catch { throw new HttpError(400, 'invalid_event', 'body is not JSON'); }
      const rows = (body as Partial<ReplicaPush>)?.events;
      if (!Array.isArray(rows) || rows.length > PUSH_BATCH) throw new HttpError(400, 'invalid_event', `body must be { events: [] }, at most ${PUSH_BATCH}`);
      for (const r of rows) {
        if (!r || !isInt(r.seq) || r.seq < 1 || typeof r.deviceId !== 'string' || !isInt(r.receivedAt)) {
          throw new HttpError(400, 'invalid_event', 'each row needs seq, deviceId, receivedAt and event');
        }
      }
      // The same shape checks the shop server ran: the cloud never stores what the shop would not.
      const checked = validatePush({ events: rows.map((r) => r.event) }, device.tenantId);
      if ('reason' in checked) {
        throw checked.wrongShop ? new HttpError(403, 'wrong_shop', checked.reason) : new HttpError(400, 'invalid_event', checked.reason);
      }
      const t = now();
      const insert = db.prepare(`INSERT OR IGNORE INTO events
        (tenant_id, id, source_seq, source_device, type, order_number, at, received_at, copied_at, body)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      // One batch = one transaction: all of it lands, or none (the shop sends it again).
      const results = rows.length
        ? await db.batch(rows.map((r) => insert.bind(
          device.tenantId, r.event.id, r.seq, r.deviceId, r.event.type, r.event.orderNumber, r.event.at, r.receivedAt, t,
          JSON.stringify(r.event))))
        : [];
      const stored = results.reduce((n, x) => n + x.meta.changes, 0);
      return json(200, { stored, lastSourceSeq: await lastSourceSeq(device.tenantId), serverTime: t });
    }

    // A new shop server registers itself with the shop code (the setup wizard's cloud step).
    if (url.pathname === '/api/v1/enrol' && req.method === 'POST') {
      let body: { code?: unknown; shopId?: unknown; name?: unknown };
      try { body = await req.json(); } catch { throw new HttpError(400, 'invalid_event', 'body is not JSON'); }
      if (!enrolCode || typeof body.code !== 'string' || !sameText(body.code.trim().toUpperCase(), enrolCode.toUpperCase())) {
        throw new HttpError(403, 'forbidden', 'that shop code is not right');
      }
      if (typeof body.shopId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(body.shopId)) throw new HttpError(400, 'invalid_event', 'bad shop id');
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : body.shopId;
      const token = newToken();
      const t = now();
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO shops (id, name, created_at) VALUES (?, ?, ?)').bind(body.shopId, name, t),
        db.prepare("INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES (?, ?, 'shop_server', ?, ?)")
          .bind(newId(), body.shopId, await sha256Hex(token), t),
      ]);
      return json(200, { token });
    }

    // The owners' phones, managed by the shop server (the setup wizard's QR codes, and withdrawing a lost phone).
    if (url.pathname === '/api/v1/devices' || url.pathname.startsWith('/api/v1/devices/')) {
      const device = await authenticate(req, ['shop_server']);
      if (url.pathname === '/api/v1/devices' && req.method === 'GET') {
        const { results } = await db.prepare(
          "SELECT id, created_at FROM devices WHERE tenant_id = ? AND kind = 'owner' ORDER BY created_at")
          .bind(device.tenantId).all<{ id: string; created_at: number }>();
        return json(200, { devices: results.map((r) => ({ id: r.id, createdAt: r.created_at })) });
      }
      if (url.pathname === '/api/v1/devices' && req.method === 'POST') {
        const token = newToken();
        const id = newId();
        await db.prepare("INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES (?, ?, 'owner', ?, ?)")
          .bind(id, device.tenantId, await sha256Hex(token), now()).run();
        return json(200, { id, token });
      }
      if (req.method === 'DELETE') {
        const id = decodeURIComponent(url.pathname.slice('/api/v1/devices/'.length));
        // Only this shop's owner phones: never a shop server, never another shop's device.
        const r = await db.prepare("DELETE FROM devices WHERE id = ? AND tenant_id = ? AND kind = 'owner'")
          .bind(id, device.tenantId).run();
        return json(r.meta.changes ? 200 : 404, { removed: r.meta.changes });
      }
      throw new HttpError(405, 'server', 'method not allowed');
    }

    if (url.pathname === '/api/v1/events' && req.method === 'GET') {
      // Reading the copy: the owner's phone later, or a shop server rebuilding itself.
      const device = await authenticate(req, ['shop_server', 'owner']);
      const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
      const limit = Math.min(PULL_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || PULL_LIMIT));
      const { results } = await db.prepare(
        'SELECT seq, source_device, received_at, body FROM events WHERE tenant_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .bind(device.tenantId, after, limit + 1)
        .all<{ seq: number; source_device: string; received_at: number; body: string }>();
      const events = results.slice(0, limit).map((r) => ({
        event: JSON.parse(r.body), deviceId: r.source_device, seq: r.seq, receivedAt: r.received_at,
      }));
      return json(200, {
        events, lastSeq: events.at(-1)?.seq ?? after, more: results.length > limit, serverTime: now(),
      } satisfies PullResponse);
    }

    throw new HttpError(404, 'server', 'no such endpoint');
  };

  return async (req: Request): Promise<Response> => {
    try {
      return await routes(req, new URL(req.url));
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.code, message: e.message } satisfies ApiError);
      console.error(e);
      return json(500, { error: 'server', message: 'server error' } satisfies ApiError);
    }
  };
}
