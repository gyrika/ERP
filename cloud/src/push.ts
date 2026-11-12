import { isPushSubscription } from '../../src/domain/campaigns.ts';
import { toLkMobile } from '../../src/domain/phone.ts';
import type { CloudDevice, D1Like, Kind } from './cloud.ts';
import { HttpError, json, randomToken, sha256Hex } from './http.ts';

/**
 * Offers on the customer's phone (CRM). The cloud is only a letterbox between the CheesyBeez app
 * (cheesybeez.com, also the TWA) and the shop PC, which keeps the customer list and sends the pushes:
 * - the app asks for the shop's push key (GET /api/v1/push/key), signs up with a mobile number
 *   (POST /api/v1/push/subscribe) or stops (POST /api/v1/push/unsubscribe);
 * - the shop PC hands over its key (POST /api/v1/push/key), takes what waits (GET /api/v1/push/inbox)
 *   and says what it took (POST /api/v1/push/inbox/ack), which is then deleted here.
 * Nothing is kept longer than that, and nothing waits longer than 30 days.
 */
const DAY = 86_400_000;
const KEEP_MS = 30 * DAY;
const MAX_WAITING = 2000; // a shop offline for weeks: older sign-ups first, no endless growth
const MAX_PER_IP_HOUR = 10;

export interface PushContext {
  db: D1Like;
  now: () => number;
  /** The shop cheesybeez.com is for (wrangler.toml ORDER_SHOP). */
  orderShop?: string;
  authenticate: (req: Request, allowed: Kind[]) => Promise<CloudDevice>;
}

const body = async (req: Request): Promise<Record<string, unknown>> => {
  try { const b = await req.json(); return typeof b === 'object' && b !== null ? b as Record<string, unknown> : {}; } catch { return {}; }
};

export async function pushRoutes(req: Request, url: URL, c: PushContext): Promise<Response | null> {
  const { db, now } = c;
  const path = url.pathname;
  if (!path.startsWith('/api/v1/push/')) return null;

  // ----- the app (no login: anyone with the page) -----
  if (path === '/api/v1/push/key' && req.method === 'GET') {
    if (!c.orderShop) return json(200, { key: null });
    const row = await db.prepare('SELECT public_key FROM push_keys WHERE tenant_id = ?').bind(c.orderShop).first<{ public_key: string }>();
    return json(200, { key: row?.public_key ?? null });
  }
  if ((path === '/api/v1/push/subscribe' || path === '/api/v1/push/unsubscribe') && req.method === 'POST') {
    if (!c.orderShop) throw new HttpError(404, 'server', 'offers are not on');
    const b = await body(req);
    const t = now();
    const ip = await sha256Hex(`cb-push:${req.headers.get('cf-connecting-ip') ?? 'unknown'}`);
    const counts = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM push_inbox WHERE ip_hash = ? AND created_at > ?) AS ip,
        (SELECT COUNT(*) FROM push_inbox WHERE tenant_id = ?) AS waiting`).bind(ip, t - 3_600_000, c.orderShop).first<{ ip: number; waiting: number }>();
    if ((counts?.ip ?? 0) >= MAX_PER_IP_HOUR) throw new HttpError(429, 'too_many', 'too many tries: please wait a while');
    if ((counts?.waiting ?? 0) >= MAX_WAITING) throw new HttpError(503, 'unavailable', 'please try again tomorrow');
    let row: { kind: 'subscribe' | 'unsubscribe'; body: unknown };
    if (path.endsWith('/subscribe')) {
      const phone = toLkMobile(b.phone);
      if (!('phone' in phone)) throw new HttpError(400, 'invalid_event', 'type your mobile number, like 077 123 4567');
      if (!isPushSubscription(b.subscription)) throw new HttpError(400, 'invalid_event', 'this phone cannot take notifications');
      const { endpoint, keys } = b.subscription;
      row = { kind: 'subscribe', body: { phone: phone.phone, subscription: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } } } };
    } else {
      if (typeof b.endpoint !== 'string' || !/^https:\/\/\S{1,800}$/.test(b.endpoint)) throw new HttpError(400, 'invalid_event', 'which phone?');
      row = { kind: 'unsubscribe', body: { endpoint: b.endpoint } };
    }
    await db.prepare('INSERT INTO push_inbox (id, tenant_id, kind, body, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(randomToken(12), c.orderShop, row.kind, JSON.stringify(row.body), ip, t).run();
    return json(200, { ok: true });
  }

  // ----- the shop PC -----
  if (path === '/api/v1/push/key' && req.method === 'POST') {
    const device = await c.authenticate(req, ['shop_server']);
    const key = (await body(req)).key;
    if (typeof key !== 'string' || !/^[\w-]{80,100}$/.test(key)) throw new HttpError(400, 'invalid_event', 'not a push key');
    await db.prepare(`INSERT INTO push_keys (tenant_id, public_key, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (tenant_id) DO UPDATE SET public_key = excluded.public_key, updated_at = excluded.updated_at`).bind(device.tenantId, key, now()).run();
    return json(200, { ok: true });
  }
  if (path === '/api/v1/push/inbox' && req.method === 'GET') {
    const device = await c.authenticate(req, ['shop_server']);
    await db.prepare('DELETE FROM push_inbox WHERE tenant_id = ? AND created_at < ?').bind(device.tenantId, now() - KEEP_MS).run();
    const { results } = await db.prepare('SELECT id, kind, body FROM push_inbox WHERE tenant_id = ? ORDER BY created_at LIMIT 200')
      .bind(device.tenantId).all<{ id: string; kind: string; body: string }>();
    return json(200, { rows: results.map((r) => ({ id: r.id, kind: r.kind, ...JSON.parse(r.body) as object })) });
  }
  if (path === '/api/v1/push/inbox/ack' && req.method === 'POST') {
    const device = await c.authenticate(req, ['shop_server']);
    const ids = (await body(req)).ids;
    if (!Array.isArray(ids) || ids.length > 200 || !ids.every((id) => typeof id === 'string' && id.length <= 40)) {
      throw new HttpError(400, 'invalid_event', 'which rows?');
    }
    for (const id of ids) await db.prepare('DELETE FROM push_inbox WHERE tenant_id = ? AND id = ?').bind(device.tenantId, id).run();
    return json(200, { ok: true });
  }
  return null;
}
