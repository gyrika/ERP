import { MENU } from '../../src/domain/menu.ts';
import { effectiveMenu, menuStateFromEvents } from '../../src/domain/menuEdits.ts';
import {
  checkOnlineOrder, effectiveStatus, NEXT_STATUS, parseHours, takingOrders, type OnlineLine, type OnlineOrder, type OnlineStatus,
} from '../../src/domain/online.ts';
import type { CloudDevice, D1Like, Kind } from './cloud.ts';
import { HttpError, json, randomToken, sha256Hex } from './http.ts';

/**
 * Online orders on the cloud (src/domain/online.ts has the rules).
 * For customers, no login: the shop's menu status, placing an order, and its status by
 * the private link it came with. For the shop server (its own key): the orders to show
 * at the counter, and the counter's answers (accept, decline, ready, collected).
 */
export interface OnlineContext {
  db: D1Like;
  now: () => number;
  /** The shop that cheesybeez.com takes orders for (wrangler.toml ORDER_SHOP). */
  orderShop?: string;
  /** Its daily hours, "11:00-21:00" (wrangler.toml ORDER_HOURS). */
  orderHours?: string;
  authenticate(req: Request, allowed: Kind[]): Promise<CloudDevice>;
}

interface Row {
  id: string; status: OnlineStatus; name: string; phone: string; body: string; total: number;
  order_number: number | null; ready_by: number | null; reason: string | null; created_at: number;
}

const HOUR = 60 * 60_000;
/** The counter sees today's orders still in play. */
const ACTIVE_FOR_MS = 12 * HOUR;
/** Names and phone numbers are kept 30 days, then blanked. */
const KEEP_CONTACT_MS = 30 * 24 * HOUR;
const MAX_PER_PHONE = 2; // orders still in play from one number
const MAX_PER_IP_HOUR = 6;
const MAX_WAITING = 20; // unanswered orders for the shop

const toOrder = (r: Row, now: number): OnlineOrder => {
  const body = JSON.parse(r.body) as { lines: OnlineLine[]; note: string };
  return {
    id: r.id, createdAt: r.created_at, status: effectiveStatus({ status: r.status, createdAt: r.created_at }, now),
    name: r.name, phone: r.phone, lines: body.lines, note: body.note, total: r.total,
    orderNumber: r.order_number, readyBy: r.ready_by, reason: r.reason,
  };
};

const COLUMNS = 'id, status, name, phone, body, total, order_number, ready_by, reason, created_at';

export async function onlineRoutes(req: Request, url: URL, c: OnlineContext): Promise<Response | null> {
  const { db, now } = c;
  const path = url.pathname;

  /** The shop's menu with its owner's changes, from its menu events (few, so read whole). */
  const shopMenuState = async (tenantId: string) => {
    const { results } = await db.prepare(
      "SELECT body FROM events WHERE tenant_id = ? AND type IN ('menu.item_set', 'menu.sold_out') ORDER BY seq").bind(tenantId).all<{ body: string }>();
    return menuStateFromEvents(results.map((r) => JSON.parse(r.body) as { type: string }));
  };
  const shopMenu = async (tenantId: string) => effectiveMenu(MENU, await shopMenuState(tenantId), now());

  const shopState = async () => {
    if (!c.orderShop) throw new HttpError(404, 'server', 'online orders are not set up');
    const shop = await db.prepare('SELECT name, online_open, online_seen_at FROM shops WHERE id = ?').bind(c.orderShop)
      .first<{ name: string; online_open: number; online_seen_at: number | null }>();
    if (!shop) throw new HttpError(404, 'server', 'online orders are not set up');
    return { name: shop.name, open: takingOrders({ open: Boolean(shop.online_open), seenAt: shop.online_seen_at }, now()) };
  };

  // ----- Customers -----
  if (path === '/api/v1/shop' && req.method === 'GET') {
    const shop = await shopState();
    // The owner's menu changes: the page applies them to the printed menu it carries, as the counter does.
    return json(200, { ...shop, hours: parseHours(c.orderHours), menuState: await shopMenuState(c.orderShop!) });
  }

  if (path === '/api/v1/orders' && req.method === 'POST') {
    const shop = await shopState();
    if (!shop.open) throw new HttpError(409, 'forbidden', 'The shop is not taking online orders right now.');
    let body: unknown;
    try { body = await req.json(); } catch { throw new HttpError(400, 'invalid_event', 'The order is not readable.'); }
    const checked = checkOnlineOrder(body, await shopMenu(c.orderShop!));
    if ('reason' in checked) throw new HttpError(400, 'invalid_event', checked.reason);
    const t = now();
    const ip = await sha256Hex(`cb-online:${req.headers.get('cf-connecting-ip') ?? 'unknown'}`);
    const counts = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM online_orders WHERE phone = ? AND status IN ('new', 'accepted', 'ready') AND created_at > ?) AS phone,
        (SELECT COUNT(*) FROM online_orders WHERE ip_hash = ? AND created_at > ?) AS ip,
        (SELECT COUNT(*) FROM online_orders WHERE tenant_id = ? AND status = 'new' AND created_at > ?) AS waiting`)
      .bind(checked.phone, t - ACTIVE_FOR_MS, ip, t - HOUR, c.orderShop, t - 15 * 60_000)
      .first<{ phone: number; ip: number; waiting: number }>();
    if (counts && counts.phone >= MAX_PER_PHONE) throw new HttpError(429, 'too_many', 'You already have orders on the way. Please wait for them, or call the shop.');
    if (counts && counts.ip >= MAX_PER_IP_HOUR) throw new HttpError(429, 'too_many', 'Too many orders from here. Please call the shop.');
    if (counts && counts.waiting >= MAX_WAITING) throw new HttpError(429, 'too_many', 'The shop is very busy right now. Please try again in a few minutes.');

    const id = `o-${randomToken(9)}`;
    const token = randomToken(24);
    await db.prepare(`INSERT INTO online_orders
        (id, tenant_id, token_hash, status, name, phone, body, total, ip_hash, created_at, updated_at)
        VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, c.orderShop, await sha256Hex(token), checked.name, checked.phone,
        JSON.stringify({ lines: checked.lines, note: checked.note }), checked.total, ip, t, t)
      .run();
    return json(200, { id, token, total: checked.total });
  }

  const mine = /^\/api\/v1\/orders\/(o-[A-Za-z0-9_-]{8,20})$/.exec(path);
  if (mine && req.method === 'GET') {
    const token = url.searchParams.get('t') ?? '';
    const row = await db.prepare(`SELECT ${COLUMNS} FROM online_orders WHERE id = ? AND token_hash = ?`)
      .bind(mine[1], await sha256Hex(token)).first<Row>();
    if (!row) throw new HttpError(404, 'server', 'That order is not here.');
    const { phone: _phone, ...order } = toOrder(row, now());
    return json(200, order);
  }

  // ----- The shop server -----
  if (path === '/api/v1/online/poll' && req.method === 'POST') {
    const device = await c.authenticate(req, ['shop_server']);
    let open = false;
    try { open = Boolean(((await req.json()) as { open?: unknown }).open); } catch { /* closed */ }
    const t = now();
    const { results } = await db.prepare(
      `SELECT ${COLUMNS} FROM online_orders WHERE tenant_id = ? AND created_at > ? AND status IN ('new', 'accepted', 'ready') ORDER BY created_at`)
      .bind(device.tenantId, t - ACTIVE_FOR_MS).all<Row>();
    await db.batch([
      db.prepare('UPDATE shops SET online_open = ?, online_seen_at = ? WHERE id = ?').bind(open ? 1 : 0, t, device.tenantId),
      db.prepare("UPDATE online_orders SET name = '', phone = '', ip_hash = NULL WHERE tenant_id = ? AND created_at < ? AND phone != ''")
        .bind(device.tenantId, t - KEEP_CONTACT_MS),
    ]);
    return json(200, { orders: results.map((r) => toOrder(r, t)).filter((o) => o.status !== 'expired'), serverTime: t });
  }

  const answer = /^\/api\/v1\/online\/(o-[A-Za-z0-9_-]{8,20})$/.exec(path);
  if (answer && req.method === 'POST') {
    const device = await c.authenticate(req, ['shop_server']);
    let b: { status?: unknown; orderNumber?: unknown; readyBy?: unknown; reason?: unknown };
    try { b = await req.json(); } catch { throw new HttpError(400, 'invalid_event', 'body is not JSON'); }
    const row = await db.prepare(`SELECT ${COLUMNS} FROM online_orders WHERE id = ? AND tenant_id = ?`)
      .bind(answer[1], device.tenantId).first<Row>();
    if (!row) throw new HttpError(404, 'server', 'no such online order');
    const t = now();
    const current = effectiveStatus({ status: row.status, createdAt: row.created_at }, t);
    const to = b.status as OnlineStatus;
    if (current === to) return json(200, toOrder(row, t)); // asked twice: same answer
    if (!NEXT_STATUS[current]?.includes(to)) throw new HttpError(409, 'forbidden', `the order is ${current}: it cannot become ${String(b.status)}`);
    let set = '';
    const values: unknown[] = [];
    if (to === 'accepted') {
      if (!Number.isSafeInteger(b.orderNumber) || (b.orderNumber as number) < 1) throw new HttpError(400, 'invalid_event', 'an accepted order needs its number');
      if (!Number.isSafeInteger(b.readyBy) || (b.readyBy as number) < t - 60_000) throw new HttpError(400, 'invalid_event', 'an accepted order needs a ready time');
      set = ', order_number = ?, ready_by = ?';
      values.push(b.orderNumber, b.readyBy);
    } else if (to === 'declined') {
      if (typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 80) throw new HttpError(400, 'invalid_event', 'a declined order needs a short reason');
      set = ', reason = ?';
      values.push(b.reason.trim());
    }
    await db.prepare(`UPDATE online_orders SET status = ?, updated_at = ?${set} WHERE id = ? AND tenant_id = ?`)
      .bind(to, t, ...values, row.id, device.tenantId).run();
    const after = await db.prepare(`SELECT ${COLUMNS} FROM online_orders WHERE id = ?`).bind(row.id).first<Row>();
    return json(200, toOrder(after!, t));
  }
  return null;
}
