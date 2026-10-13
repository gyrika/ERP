import { PULL_LIMIT, type PullResponse } from '../../src/domain/sync.ts';
import { isNewer } from '../../src/domain/version.ts';
import type { D1Like } from './cloud.ts';
import { json } from './http.ts';

/**
 * /admin: the developer's view of every shop (not the owner's). Which version each
 * Station runs, when it last checked in, how its last update went, and one tap into
 * a shop's Owner view, read-only.
 *
 * Cloudflare Access stands in front of /admin (only the developer's email gets in);
 * the Worker checks Access's signed token as well, so a mistake in the dashboard
 * never opens it. Without ACCESS_TEAM and ACCESS_AUD set, /admin does not exist.
 */

export interface AccessConfig {
  /** e.g. gyrika.cloudflareaccess.com */
  team: string;
  /** The Access application's audience tag. */
  aud: string;
}

const b64url = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const part = (s: string): Record<string, unknown> | null => {
  try { return JSON.parse(new TextDecoder().decode(b64url(s))) as Record<string, unknown>; } catch { return null; }
};

const cookie = (req: Request, name: string): string | null =>
  req.headers.get('cookie')?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;

let certs: { team: string; at: number; keys: { kid: string; key: CryptoKey }[] } | null = null;
const keysOf = async (team: string, http: typeof fetch, now: number) => {
  if (certs && certs.team === team && now - certs.at < 60 * 60_000) return certs.keys;
  const r = await http(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`Access certs: ${r.status}`);
  const { keys } = (await r.json()) as { keys: (JsonWebKey & { kid: string })[] };
  const imported = await Promise.all(keys.map(async (k) => ({
    kid: k.kid,
    key: await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']),
  })));
  certs = { team, at: now, keys: imported };
  return imported;
};

/** The signed-in email if Access let this request through, else null. */
export const accessEmail = async (req: Request, cfg: AccessConfig, http: typeof fetch = fetch, now = Date.now()): Promise<string | null> => {
  const token = req.headers.get('cf-access-jwt-assertion') ?? cookie(req, 'CF_Authorization');
  const [h, p, sig] = token?.split('.') ?? [];
  if (!h || !p || !sig) return null;
  const header = part(h);
  const payload = part(p);
  if (!header || !payload || header.alg !== 'RS256') return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(cfg.aud) || payload.iss !== `https://${cfg.team}`) return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
  try {
    const key = (await keysOf(cfg.team, http, now)).find((k) => k.kid === header.kid)?.key;
    if (!key) return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    return ok && typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
};

// ----- the shop list -----

const COLOMBO = 5.5 * 60 * 60_000; // Sri Lanka: UTC+5:30, no summer time
const DAY = 24 * 60 * 60_000;
export const startOfDayColombo = (t: number): number => Math.floor((t + COLOMBO) / DAY) * DAY - COLOMBO;

export interface ShopRow {
  id: string;
  name: string;
  version: string | null;
  update: { phase: string; percent: number; version: string; at: number } | null;
  lastSeenAt: number | null;
  lastSaleAt: number | null;
  eventsToday: number;
}

export const shopRows = async (db: D1Like, now: number): Promise<ShopRow[]> => {
  const { results } = await db.prepare(`
    SELECT s.id, s.name, d.version, d.update_status, d.last_seen_at,
      (SELECT MAX(at) FROM events e WHERE e.tenant_id = s.id AND e.type = 'order.paid') AS last_sale,
      (SELECT COUNT(*) FROM events e WHERE e.tenant_id = s.id AND e.at >= ?) AS events_today
    FROM shops s LEFT JOIN devices d ON d.tenant_id = s.id AND d.kind = 'shop_server'
    ORDER BY COALESCE(d.last_seen_at, 0) DESC, s.name`)
    .bind(startOfDayColombo(now))
    .all<{ id: string; name: string; version: string | null; update_status: string | null; last_seen_at: number | null; last_sale: number | null; events_today: number }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    version: r.version,
    update: r.update_status ? (JSON.parse(r.update_status) as ShopRow['update']) : null,
    lastSeenAt: r.last_seen_at,
    lastSaleAt: r.last_sale,
    eventsToday: r.events_today,
  }));
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** "just now", "4 min ago", "3 h ago", "2 days ago". */
export const ago = (t: number | null, now: number): string => {
  if (t === null) return 'never';
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
};

/** Online: checked in within 2 minutes (it does every 30 s while the internet is up). */
export const isOnline = (row: ShopRow, now: number): boolean => row.lastSeenAt !== null && now - row.lastSeenAt < 2 * 60_000;

const UPDATE_WORDS: Record<string, string> = {
  done: 'Updated', back: 'Went back', failed: 'Update failed', 'going-back': 'Going back', 'up-to-date': 'Up to date',
  checking: 'Checking', downloading: 'Downloading', backup: 'Backing up', installing: 'Installing', starting: 'Starting',
};

export const adminPage = (rows: ShopRow[], latest: string | null, email: string, now: number): string => {
  const online = rows.filter((r) => isOnline(r, now)).length;
  const behind = rows.filter((r) => latest && r.version && isNewer(latest, r.version)).length;
  const row = (r: ShopRow) => {
    const on = isOnline(r, now);
    const old = !!(latest && r.version && isNewer(latest, r.version));
    const upd = r.update
      ? `${UPDATE_WORDS[r.update.phase] ?? r.update.phase}${r.update.version ? ` ${esc(r.update.version)}` : ''} · ${ago(r.update.at, now)}`
      : 'No update yet';
    const bad = r.update && ['failed', 'back'].includes(r.update.phase);
    return `<a class="shop" href="/admin/shop/${encodeURIComponent(r.id)}#owner">
  <span class="state ${on ? 'on' : 'off'}">${on ? 'Online' : `Offline · ${ago(r.lastSeenAt, now)}`}</span>
  <span class="name">${esc(r.name)}</span>
  <span class="id">${esc(r.id)}</span>
  <span class="facts">
    <span class="${old ? 'warn' : ''}">Version ${esc(r.version ?? 'unknown')}${old ? ` · ${esc(latest!)} waiting` : ''}</span>
    <span class="${bad ? 'bad' : ''}">${upd}</span>
    <span>Last sale ${ago(r.lastSaleAt, now)} · ${r.eventsToday} events today</span>
  </span>
</a>`;
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>CheesyBeez admin</title>
<meta http-equiv="refresh" content="30">
<meta name="robots" content="noindex">
<link rel="icon" type="image/png" href="/icons/favicon-32.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap">
<style>
:root{--bg:#F2F1EF;--card:#FFF;--fg:#1C1C1E;--muted:#6E6D72;--line:#E3E1DE;--ok:#1E7A4F;--warn:#9A6514;--bad:#C8363B}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1C1C1E;--fg:#F5F5F7;--muted:#A1A1A6;--line:#3A3A3C;--ok:#30A46C;--warn:#E8A94B;--bad:#E5484D;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 "DM Sans",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px;display:flex;flex-direction:column;gap:14px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
h1{margin:0;font-size:28px;letter-spacing:-.5px}
.who{color:var(--muted);font-size:14px}
.lead{margin:0 0 6px;color:var(--muted)}
.shop{display:grid;grid-template-columns:1fr auto;gap:2px 12px;padding:16px 18px;border-radius:16px;background:var(--card);color:inherit;text-decoration:none;border:1px solid transparent}
.shop:hover,.shop:focus-visible{border-color:var(--line);outline:none}
.name{font-weight:600;font-size:18px;grid-column:1}
.state{grid-column:2;grid-row:1;font-size:14px;font-weight:600}
.state.on{color:var(--ok)}.state.off{color:var(--muted)}
.id{grid-column:1/-1;color:var(--muted);font-size:13px}
.facts{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:6px;font-size:14px;color:var(--muted)}
.warn{color:var(--warn)}.bad{color:var(--bad)}
.empty{color:var(--muted)}
</style></head><body><main>
<header><h1>Shops</h1><span class="who">${esc(email)}</span></header>
<p class="lead">${online} of ${rows.length} online · latest release ${esc(latest ?? 'unknown')}${behind ? ` · ${behind} still to update` : ''}</p>
${rows.length ? rows.map(row).join('\n') : '<p class="empty">No shops yet.</p>'}
</main></body></html>`;
};

// ----- routes -----

export interface AdminOptions {
  db: D1Like;
  access: AccessConfig | null;
  latest: () => Promise<string | null>;
  /** The Owner view (the cloud build's index.html), for one shop. */
  app: (req: Request) => Promise<Response>;
  fetch?: typeof fetch;
  now?: () => number;
}

const notFound = () => new Response('Not found', { status: 404 });

/** Everything under /admin, or null for other paths. */
export const adminRoutes = async (req: Request, url: URL, o: AdminOptions): Promise<Response | null> => {
  if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return null;
  if (!o.access) return notFound(); // not set up: /admin does not exist
  const now = (o.now ?? Date.now)();
  const email = await accessEmail(req, o.access, o.fetch ?? fetch, now);
  if (!email) return new Response('Sign in through Cloudflare Access.', { status: 403 });
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    const [rows, latest] = await Promise.all([shopRows(o.db, now), o.latest()]);
    return new Response(adminPage(rows, latest, email, now), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
  }

  // One shop's events, for its Owner view: the same answer an owner's phone gets, for any shop.
  const events = /^\/admin\/api\/shops\/([a-z0-9-]{1,64})\/events$/.exec(url.pathname);
  if (events) {
    const shop = events[1];
    const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
    const limit = Math.min(PULL_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || PULL_LIMIT));
    const { results } = await o.db.prepare(
      'SELECT seq, source_device, received_at, body FROM events WHERE tenant_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .bind(shop, after, limit + 1)
      .all<{ seq: number; source_device: string; received_at: number; body: string }>();
    const page = results.slice(0, limit).map((r) => ({
      event: JSON.parse(r.body), deviceId: r.source_device, seq: r.seq, receivedAt: r.received_at,
    }));
    return json(200, { events: page, lastSeq: page.at(-1)?.seq ?? after, more: results.length > limit, serverTime: now } satisfies PullResponse);
  }

  if (/^\/admin\/shop\/[a-z0-9-]{1,64}$/.test(url.pathname)) {
    const known = await o.db.prepare('SELECT 1 AS x FROM shops WHERE id = ?').bind(url.pathname.slice('/admin/shop/'.length)).first();
    if (!known) return notFound();
    const page = await o.app(new Request(new URL('/index.html', url), req));
    // The Owner view's own files, but never cached and never sent on as a referrer.
    const headers = new Headers(page.headers);
    headers.set('cache-control', 'no-store');
    headers.set('referrer-policy', 'no-referrer');
    return new Response(page.body, { status: page.status, headers });
  }
  return notFound();
};
