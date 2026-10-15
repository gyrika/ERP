import { managesRole, type Actor, type Role } from '../../src/domain/auth.ts';
import { isPhotoId } from '../../src/domain/photos.ts';
import { PULL_LIMIT, PUSH_BATCH, type PushResponse, type SyncEvent } from '../../src/domain/sync.ts';
import { validatePush } from '../../server/validate.ts';
import type { CloudDevice, D1Like, Kind } from './cloud.ts';
import { HttpError, json } from './http.ts';

/**
 * The manager's phone app (SCRUM-94), served by the cloud like the owner's, so it
 * installs from a QR code and works on mobile data. A manager phone belongs to one
 * person: what it records is signed with them. It reads the shop as the owner's phone
 * does; what it records waits here in the inbox until the shop server takes it into its
 * own log (the shop stays the truth); its shelf photos are kept here, with the shop.
 */
export interface ManagerContext {
  db: D1Like;
  now: () => number;
  authenticate(req: Request, allowed: Kind[]): Promise<CloudDevice>;
}

/** A shelf photo shrunk on the phone is ~150 KB; anything far bigger is not one. */
export const MAX_PHOTO_BYTES = 400_000;
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** What a manager phone may record: stock, signed by its own person (and lists only by an owner). */
export const phoneRefusal = (e: SyncEvent, actor: Actor): string | null => {
  if (!e.type.startsWith('stock.')) return 'the manager phone records stock only';
  if (!('actor' in e) || e.actor.id !== actor.id || e.actor.role !== actor.role) return 'not the person this phone belongs to';
  if (e.type === 'stock.tier_set' && actor.role !== 'owner') return 'only the owner changes the count lists';
  return null;
};

export const parseActor = (raw: string | null): Actor | null => {
  try {
    const a = raw ? JSON.parse(raw) as Actor : null;
    return a && typeof a.id === 'string' && typeof a.name === 'string' && managesRole(a.role as Role) ? a : null;
  } catch { return null; }
};

export async function managerRoutes(req: Request, url: URL, c: ManagerContext): Promise<Response | null> {
  const { db, now } = c;

  // Who this phone is: the person it was made for, and the shop.
  if (url.pathname === '/api/v1/me' && req.method === 'GET') {
    const device = await c.authenticate(req, ['manager']);
    return json(200, { actor: device.actor, shopId: device.tenantId });
  }

  if (url.pathname === '/api/v1/inbox') {
    if (req.method === 'POST') {
      const device = await c.authenticate(req, ['manager']);
      if (!device.actor) throw new HttpError(403, 'forbidden', 'this phone belongs to nobody');
      let body: unknown;
      try { body = await req.json(); } catch { throw new HttpError(400, 'invalid_event', 'body is not JSON'); }
      const events = (body as { events?: unknown })?.events;
      if (!Array.isArray(events) || events.length > PUSH_BATCH) throw new HttpError(400, 'invalid_event', `body must be { events: [] }, at most ${PUSH_BATCH}`);
      // The same shape checks the shop server runs: the cloud never keeps what the shop would refuse.
      const checked = validatePush({ events }, device.tenantId);
      if ('reason' in checked) {
        throw checked.wrongShop ? new HttpError(403, 'wrong_shop', checked.reason) : new HttpError(400, 'invalid_event', checked.reason);
      }
      const rejected: { id: string; reason: string }[] = [];
      const allowed = checked.events.filter((e) => {
        const why = phoneRefusal(e, device.actor!);
        if (why) rejected.push({ id: e.id, reason: why });
        return !why;
      });
      const t = now();
      const insert = db.prepare('INSERT OR IGNORE INTO inbox (tenant_id, id, device_id, received_at, body) VALUES (?, ?, ?, ?, ?)');
      if (allowed.length) await db.batch(allowed.map((e) => insert.bind(device.tenantId, e.id, device.id, t, JSON.stringify(e))));
      const seqs = new Map<string, number>();
      for (const e of allowed) {
        const row = await db.prepare('SELECT seq FROM inbox WHERE tenant_id = ? AND id = ?').bind(device.tenantId, e.id).first<{ seq: number }>();
        if (row) seqs.set(e.id, row.seq);
      }
      return json(200, {
        accepted: allowed.map((e) => ({ id: e.id, seq: seqs.get(e.id) ?? 0 })),
        ...(rejected.length ? { rejected } : {}), serverTime: t,
      } satisfies PushResponse);
    }
    if (req.method === 'GET') {
      // The shop server takes what its manager phones recorded, in order.
      const device = await c.authenticate(req, ['shop_server']);
      const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
      const { results } = await db.prepare('SELECT seq, body FROM inbox WHERE tenant_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .bind(device.tenantId, after, PULL_LIMIT).all<{ seq: number; body: string }>();
      return json(200, { events: results.map((r) => ({ seq: r.seq, event: JSON.parse(r.body) as SyncEvent })), lastSeq: results.at(-1)?.seq ?? after });
    }
    throw new HttpError(405, 'server', 'method not allowed');
  }

  if (url.pathname === '/api/v1/photos' && req.method === 'POST') {
    const device = await c.authenticate(req, ['manager']);
    let body: { id?: unknown; data?: unknown };
    try { body = await req.json(); } catch { throw new HttpError(400, 'invalid_event', 'body is not JSON'); }
    if (!isPhotoId(body.id) || typeof body.data !== 'string') throw new HttpError(400, 'invalid_event', 'body must be { id: ph-…, data: base64 JPEG }');
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(body.data), (ch) => ch.charCodeAt(0)); } catch { throw new HttpError(400, 'invalid_event', 'data is not base64'); }
    if (!isJpeg(bytes) || bytes.length > MAX_PHOTO_BYTES) throw new HttpError(400, 'invalid_event', 'not a JPEG photo, or too large');
    await db.prepare('INSERT OR IGNORE INTO photos (tenant_id, id, data, device_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(device.tenantId, body.id, bytes, device.id, now()).run();
    return json(200, { ok: true });
  }
  const photo = /^\/api\/v1\/photos\/([^/]+)$/.exec(url.pathname);
  if (photo && req.method === 'GET') {
    // The shop server (to show it at the counter), the owner's phone and the manager phones of that shop.
    const device = await c.authenticate(req, ['shop_server', 'owner', 'manager']);
    if (!isPhotoId(photo[1])) throw new HttpError(404, 'server', 'no such photo');
    const row = await db.prepare('SELECT data FROM photos WHERE tenant_id = ? AND id = ?').bind(device.tenantId, photo[1]).first<{ data: ArrayBuffer | Uint8Array }>();
    if (!row) throw new HttpError(404, 'server', 'no such photo');
    const bytes = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
    return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' } });
  }
  return null;
}

