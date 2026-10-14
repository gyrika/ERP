import { PULL_LIMIT, type PullResponse } from '../../src/domain/sync.ts';
import { isNewer } from '../../src/domain/version.ts';
import type { D1Like } from './cloud.ts';
import { json, sha256Hex } from './http.ts';

/**
 * /admin: the developer's view of every shop (not the owner's). Which version each
 * Station runs, when it last checked in, how its last update went, and one tap into
 * a shop's Owner view, read-only.
 *
 * Signed in with one long random password (the Worker secret ADMIN_KEY, made by
 * `npm run admin-key` in cloud/). Typed once, it becomes a signed session cookie for
 * 30 days: HttpOnly (no script reads it), Secure, SameSite=Strict, only for /admin,
 * and never in the address. Without ADMIN_KEY, /admin does not exist. The data under
 * /admin/api/ also answers to the password as a Bearer key: the Shops screen on the
 * developer's laptop reads it through its own local server (server/fleet.ts).
 */

const SESSION = 'cb_admin';
const SESSION_DAYS = 30;

const hmacHex = async (key: string, text: string): Promise<string> => {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** Compares without leaking, through timing, how much of a guess was right. */
const sameText = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const cookie = (req: Request, name: string): string | null =>
  req.headers.get('cookie')?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;

/** A session that ends at `until` (ms), signed with the admin key. */
export const sessionCookie = async (key: string, until: number): Promise<string> =>
  `${SESSION}=${until}.${await hmacHex(key, `admin-session:${until}`)}; Path=/admin; Max-Age=${SESSION_DAYS * 86_400}; HttpOnly; Secure; SameSite=Strict`;

/** Is this request signed in (a session the key signed, not yet ended)? */
export const signedIn = async (req: Request, key: string, now: number): Promise<boolean> => {
  const [until, sig] = cookie(req, SESSION)?.split('.') ?? [];
  if (!until || !sig || !/^\d{1,16}$/.test(until) || Number(until) <= now) return false;
  return sameText(sig, await hmacHex(key, `admin-session:${until}`));
};

/** Is this the admin password? (Hashed first, so the comparison is always the same length.) */
export const rightKey = async (typed: string, key: string): Promise<boolean> =>
  sameText(await sha256Hex(typed.trim()), await sha256Hex(key));

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

const STYLE = `:root{--bg:#F2F1EF;--card:#FFF;--fg:#1C1C1E;--muted:#6E6D72;--line:#E3E1DE;--ok:#1E7A4F;--warn:#9A6514;--bad:#C8363B}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1C1C1E;--fg:#F5F5F7;--muted:#A1A1A6;--line:#3A3A3C;--ok:#30A46C;--warn:#E8A94B;--bad:#E5484D;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 "DM Sans",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px;display:flex;flex-direction:column;gap:14px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
h1{margin:0;font-size:28px;letter-spacing:-.5px}
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
form{display:flex;flex-direction:column;gap:12px}
input{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;min-height:50px;width:100%}
input:focus{outline:2px solid var(--fg);outline-offset:1px}
button{font:inherit;font-weight:600;min-height:50px;padding:0 24px;border-radius:12px;border:0;background:var(--fg);color:var(--bg);cursor:pointer}
.quiet{min-height:48px;padding:0 14px;background:transparent;color:var(--muted);border:1px solid var(--line)}
.signin{max-width:420px;margin-top:12vh}`;

const shell = (title: string, body: string, refresh = false) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>${refresh ? '\n<meta http-equiv="refresh" content="30">' : ''}
<meta name="robots" content="noindex">
<link rel="icon" type="image/png" href="/icons/favicon-32.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap">
<style>${STYLE}</style></head><body>${body}</body></html>`;

/** The sign-in box, and nothing else, for anyone without a session. */
export const signInPage = (wrong: boolean): string => shell('CheesyBeez admin', `<main class="signin">
<h1>CheesyBeez admin</h1>
<form method="post" action="/admin/login">
  <input name="key" type="password" autocomplete="current-password" aria-label="Admin password" placeholder="Admin password" required autofocus>
  ${wrong ? '<p class="bad" role="alert">That password is not right.</p>' : ''}
  <button type="submit">Sign in</button>
</form>
</main>`);

export const adminPage = (rows: ShopRow[], latest: string | null, now: number): string => {
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
  return shell('CheesyBeez admin', `<main>
<header><h1>Shops</h1><form method="post" action="/admin/logout"><button class="quiet" type="submit">Sign out</button></form></header>
<p class="lead">${online} of ${rows.length} online · latest release ${esc(latest ?? 'unknown')}${behind ? ` · ${behind} still to update` : ''}</p>
${rows.length ? rows.map(row).join('\n') : '<p class="empty">No shops yet.</p>'}
</main>`, true);
};

// ----- routes -----

export interface AdminOptions {
  db: D1Like;
  /** The admin password (Worker secret ADMIN_KEY), or null: then /admin does not exist. */
  key: string | null;
  latest: () => Promise<string | null>;
  /** The Owner view (the cloud build's index.html), for one shop. */
  app: (req: Request) => Promise<Response>;
  now?: () => number;
}

const notFound = () => new Response('Not found', { status: 404 });
const html = (body: string, status = 200, extra: Record<string, string> = {}) => new Response(body, {
  status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...extra },
});
const back = (cookieHeader: string) => new Response(null, { status: 303, headers: { location: '/admin', 'set-cookie': cookieHeader, 'cache-control': 'no-store' } });

/** A key too short to be the generated one is refused outright: /admin stays shut. */
export const MIN_KEY_LENGTH = 32;

/** Everything under /admin, or null for other paths. */
export const adminRoutes = async (req: Request, url: URL, o: AdminOptions): Promise<Response | null> => {
  if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return null;
  if (!o.key || o.key.length < MIN_KEY_LENGTH) return notFound(); // not set up: /admin does not exist
  const now = (o.now ?? Date.now)();

  if (url.pathname === '/admin/login' && req.method === 'POST') {
    const typed = String((await req.formData().catch(() => null))?.get('key') ?? '');
    if (!(await rightKey(typed, o.key))) return html(signInPage(true), 401);
    return back(await sessionCookie(o.key, now + SESSION_DAYS * 86_400_000));
  }
  if (url.pathname === '/admin/logout' && req.method === 'POST') {
    return back(`${SESSION}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
  }

  // The developer's own laptop (its local server, `server/fleet.ts`) asks for data with the password as a key.
  const auth = req.headers.get('authorization');
  const byKey = url.pathname.startsWith('/admin/api/') && auth?.startsWith('Bearer ') && await rightKey(auth.slice(7), o.key);
  if (!byKey && !(await signedIn(req, o.key, now))) {
    return url.pathname === '/admin' || url.pathname === '/admin/' ? html(signInPage(false)) : new Response('Sign in at /admin', { status: 403 });
  }
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    const [rows, latest] = await Promise.all([shopRows(o.db, now), o.latest()]);
    return html(adminPage(rows, latest, now));
  }
  if (url.pathname === '/admin/api/shops') {
    const [shops, latest] = await Promise.all([shopRows(o.db, now), o.latest()]);
    return json(200, { shops, latest, serverTime: now });
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
    // The app's page as the site's root serves it ('/index.html' would answer with a redirect to '/',
    // which would take the browser off this shop's address).
    const page = await o.app(new Request(new URL('/', url), { headers: req.headers }));
    if (page.status !== 200) return new Response('The Owner view is not available', { status: 502 });
    // The Owner view's own files, but never cached and never sent on as a referrer.
    const headers = new Headers(page.headers);
    headers.set('cache-control', 'no-store');
    headers.set('referrer-policy', 'no-referrer');
    return new Response(page.body, { status: page.status, headers });
  }
  return notFound();
};
