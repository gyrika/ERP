import type { Actor } from '../../src/domain/auth.ts';
import { PULL_LIMIT, PUSH_BATCH, type ApiError, type PullResponse, type SyncedEvent } from '../../src/domain/sync.ts';
import { validatePush } from '../../server/validate.ts';
import { HttpError, json, sha256Hex } from './http.ts';
import { managerRoutes, parseActor } from './manager.ts';
import { onlineRoutes } from './online.ts';
import { projectSales } from './sales.ts';

export { sha256Hex };

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

export type Kind = 'shop_server' | 'owner' | 'manager';
/** actor: a manager phone's person (SCRUM-94); null for every other device. */
export interface CloudDevice { id: string; tenantId: string; kind: Kind; actor: Actor | null }

/** POST /api/v1/replica: events exactly as the shop server holds them, oldest first. */
export interface ReplicaPush { events: SyncedEvent[] }
export interface ReplicaState { lastSourceSeq: number; serverTime: number }


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

/** The updater's last step as the shop server tells it, kept to the known fields (or null). */
export const updateStatus = (raw: string | null): string | null => {
  if (!raw || raw.length > 500) return null;
  try {
    const s = JSON.parse(raw) as Record<string, unknown> | null;
    if (!s || typeof s.phase !== 'string' || !/^[a-z-]{1,20}$/.test(s.phase)) return null;
    const version = typeof s.version === 'string' && /^[\w.+-]{0,32}$/.test(s.version) ? s.version : '';
    return JSON.stringify({ phase: s.phase, percent: Number(s.percent) || 0, version, at: Number(s.at) || 0 });
  } catch {
    return null;
  }
};

export interface CloudOptions {
  now?: () => number;
  /**
   * The shop code (a Worker secret, ENROL_CODE): whoever installs a shop types it in the
   * setup wizard, and the shop server registers itself. Without it, nobody can add a shop.
   */
  enrolCode?: string;
  /** The shop that cheesybeez.com takes online orders for (wrangler.toml ORDER_SHOP). */
  orderShop?: string;
  /** Its daily hours, "11:00-21:00" (wrangler.toml ORDER_HOURS); unset = the page shows no times. */
  orderHours?: string;
  /** Its phone / WhatsApp number and address for the page's pickup card; unset = not shown. */
  orderPhone?: string;
  orderAddress?: string;
}

export function createCloud(db: D1Like, options: CloudOptions | (() => number) = {}) {
  const { now = Date.now, enrolCode, ...order } = typeof options === 'function' ? { now: options } as CloudOptions : options;
  const authenticate = async (req: Request, allowed: Kind[]): Promise<CloudDevice> => {
    const h = req.headers.get('authorization');
    const token = h?.startsWith('Bearer ') ? h.slice(7) : null;
    const row = token
      ? await db.prepare('SELECT id, tenant_id, kind, actor FROM devices WHERE token_hash = ?').bind(await sha256Hex(token))
        .first<{ id: string; tenant_id: string; kind: Kind; actor: string | null }>()
      : null;
    if (!row) throw new HttpError(401, 'unauthorized', 'unknown device token');
    if (!allowed.includes(row.kind)) throw new HttpError(403, 'forbidden', 'not for this device');
    return { id: row.id, tenantId: row.tenant_id, kind: row.kind, actor: row.kind === 'manager' ? parseActor(row.actor) : null };
  };

  const lastSourceSeq = async (tenantId: string): Promise<number> =>
    (await db.prepare('SELECT COALESCE(MAX(source_seq), 0) AS s FROM events WHERE tenant_id = ?').bind(tenantId)
      .first<{ s: number }>())?.s ?? 0;

  /** A shop server checked in: when, which version it runs, and its last update (the admin view). */
  const seen = async (device: CloudDevice, req: Request): Promise<void> => {
    const version = req.headers.get('x-station-version');
    await db.prepare('UPDATE devices SET last_seen_at = ?, version = COALESCE(?, version), update_status = COALESCE(?, update_status) WHERE id = ?')
      .bind(now(), version && /^[\w.+-]{1,32}$/.test(version) ? version : null, updateStatus(req.headers.get('x-station-update')), device.id)
      .run();
  };

  // The sales ledger is a tidy copy of the events: a fault there must never stop the copy itself.
  const fileSales = async (tenantId: string): Promise<void> => {
    try { await projectSales(db, tenantId); } catch (e) { console.error('sales ledger', tenantId, e); }
  };

  const routes = async (req: Request, url: URL): Promise<Response> => {
    if (url.pathname === '/api/v1/health' && req.method === 'GET') return json(200, { ok: true, serverTime: now() });
    const online = await onlineRoutes(req, url, { db, now, ...order, authenticate });
    if (online) return online;
    const manager = await managerRoutes(req, url, { db, now, authenticate });
    if (manager) return manager;

    if (url.pathname === '/api/v1/replica') {
      const device = await authenticate(req, ['shop_server']);
      await seen(device, req);
      if (req.method === 'GET') {
        await fileSales(device.tenantId); // the shop's heartbeat also catches up the ledger
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
      await fileSales(device.tenantId);
      return json(200, { stored, lastSourceSeq: await lastSourceSeq(device.tenantId), serverTime: t });
    }

    // A new shop server registers itself with the shop code (the setup wizard's cloud step).
    if (url.pathname === '/api/v1/enrol' && req.method === 'POST') {
      let body: { code?: unknown; shopId?: unknown; name?: unknown; secret?: unknown };
      try { body = await req.json(); } catch { throw new HttpError(400, 'invalid_event', 'body is not JSON'); }
      if (!enrolCode || typeof body.code !== 'string' || !sameText(body.code.trim().toUpperCase(), enrolCode.toUpperCase())) {
        throw new HttpError(403, 'forbidden', 'that shop code is not right');
      }
      if (typeof body.shopId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(body.shopId)) throw new HttpError(400, 'invalid_event', 'bad shop id');
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : body.shopId;
      const secret = typeof body.secret === 'string' && body.secret.length >= 32 ? await sha256Hex(body.secret) : null;
      // The shop code makes NEW shops only. An existing shop takes back only the server holding its own
      // secret (its answer was lost, or it connects again); that server's old key stops working.
      const known = await db.prepare('SELECT secret_hash FROM shops WHERE id = ?').bind(body.shopId).first<{ secret_hash: string | null }>();
      const taken = () => new HttpError(409, 'forbidden', 'that shop is already connected to the cloud');
      if (known && !(known.secret_hash && secret && sameText(secret, known.secret_hash))) throw taken();
      const token = newToken();
      const t = now();
      try {
        await db.batch([
          known
            ? db.prepare("DELETE FROM devices WHERE tenant_id = ? AND kind = 'shop_server'").bind(body.shopId)
            // Plain INSERT: two servers racing for one new id, the second fails and gets nothing.
            : db.prepare('INSERT INTO shops (id, name, created_at, secret_hash) VALUES (?, ?, ?, ?)').bind(body.shopId, name, t, secret),
          db.prepare("INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES (?, ?, 'shop_server', ?, ?)")
            .bind(newId(), body.shopId, await sha256Hex(token), t),
        ]);
      } catch {
        throw taken();
      }
      return json(200, { token });
    }

    // The owners' and managers' phones, managed by the shop server (the setup wizard's QR codes, and withdrawing a lost phone).
    if (url.pathname === '/api/v1/devices' || url.pathname.startsWith('/api/v1/devices/')) {
      const device = await authenticate(req, ['shop_server']);
      if (url.pathname === '/api/v1/devices' && req.method === 'GET') {
        const { results } = await db.prepare(
          "SELECT id, kind, actor, created_at FROM devices WHERE tenant_id = ? AND kind IN ('owner', 'manager') ORDER BY created_at")
          .bind(device.tenantId).all<{ id: string; kind: Kind; actor: string | null; created_at: number }>();
        return json(200, { devices: results.map((r) => ({
          id: r.id, kind: r.kind, createdAt: r.created_at, ...(r.kind === 'manager' ? { person: parseActor(r.actor)?.name ?? null } : {}),
        })) });
      }
      if (url.pathname === '/api/v1/devices' && req.method === 'POST') {
        let body: { kind?: unknown; actor?: unknown } = {};
        try { body = (await req.json()) as typeof body; } catch { /* {} : an owner phone, as before */ }
        const kind: Kind = body.kind === 'manager' ? 'manager' : 'owner';
        // A manager phone is made for one manager or owner of this shop (the shop server says who).
        const actor = kind === 'manager' ? parseActor(JSON.stringify(body.actor ?? null)) : null;
        if (kind === 'manager' && !actor) throw new HttpError(400, 'invalid_event', 'a manager phone needs its person: a manager or an owner');
        const token = newToken();
        const id = newId();
        await db.prepare('INSERT INTO devices (id, tenant_id, kind, token_hash, created_at, actor) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(id, device.tenantId, kind, await sha256Hex(token), now(), actor ? JSON.stringify({ id: actor.id, name: actor.name, role: actor.role }) : null).run();
        return json(200, { id, token });
      }
      if (req.method === 'DELETE') {
        const id = decodeURIComponent(url.pathname.slice('/api/v1/devices/'.length));
        // Only this shop's phones: never a shop server, never another shop's device.
        const r = await db.prepare("DELETE FROM devices WHERE id = ? AND tenant_id = ? AND kind IN ('owner', 'manager')")
          .bind(id, device.tenantId).run();
        return json(r.meta.changes ? 200 : 404, { removed: r.meta.changes });
      }
      throw new HttpError(405, 'server', 'method not allowed');
    }

    if (url.pathname === '/api/v1/events' && req.method === 'GET') {
      // Reading the copy: the owner's phone later, or a shop server rebuilding itself.
      const device = await authenticate(req, ['shop_server', 'owner', 'manager']);
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
