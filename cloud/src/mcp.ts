import { lkDate, lkTime } from '../../src/domain/salesLedger.ts';
import type { DigestLine, OwnerDigest } from '../../src/domain/ownerDigest.ts';
import type { SyncEvent } from '../../src/domain/sync.ts';
import { validatePush } from '../../server/validate.ts';
import type { CloudDevice, D1Like, Kind } from './cloud.ts';
import { HttpError, json, randomToken, sha256Hex } from './http.ts';

/**
 * The owner's ChatGPT plugin (SCRUM-197): an MCP server that lets ChatGPT read the shop for him.
 *
 * MCP is JSON-RPC over HTTP; this server keeps no session, so it is a plain POST to /mcp, written
 * by hand because a few methods do not justify a dependency in the Worker. Looking at the server
 * and listing its tools work without a token and hold no shop data; a tool call without a token
 * answers with a sign-in challenge. ChatGPT signs in with OAuth (authorization code + PKCE): an
 * empty POST gets a 401 pointing at the /.well-known documents, it registers, and sends him to
 * /authorize, where he pastes his owner link. Its tokens stop when his owner device is removed,
 * and open the shop through /mcp only. Off unless MCP_ENABLED is "1".
 *
 * Whatever a tool answers goes to OpenAI, so answers never hold customers, staff, order numbers or
 * anything else that identifies a person. Sales come from the ledger here; the rest comes from the
 * digest the shop server uploads while ChatGPT is connected (src/domain/ownerDigest.ts, SCRUM-198),
 * because this free-plan Worker cannot fold the shop's whole history for each question. The one
 * thing it can write is a supplier's draft order, into the inbox: placing an order stays a person's.
 */
export const MCP_CLIENT_ID = 'cheesybeez-chatgpt';
export const MCP_SCOPE = 'shop.owner';
/** No handshake: each request says its version in _meta. */
const MODERN_VERSION = '2026-07-28';
/** With the initialize handshake. */
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const ALL_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
const SERVER_INFO = { name: 'cheesybeez', title: 'CheesyBeez', version: '1.0.0' };
const INSTRUCTIONS = "Answers the owner's questions about his shop. Use only the numbers the tools return, and say how old they are when as_of is more than an hour old. A what-if on a price is your own arithmetic on those numbers: say so. It can fill in a supplier's draft order only when he asks; it cannot place an order.";
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const CODE_MS = 5 * 60_000;
const ACCESS_S = 3600;
const REFRESH_MS = 90 * 24 * 3_600_000;
/** How long the owner's Undo can bring back what he disconnected. */
const UNDO_MS = 60_000;
const TOP_ITEMS = 10;
const OAUTH = '/api/v1/mcp';
const RESOURCE_METADATA = '/.well-known/oauth-protected-resource';
const AUTH_METADATA = '/.well-known/oauth-authorization-server';

export interface McpContext {
  db: D1Like;
  now: () => number;
  enabled?: boolean;
  authenticate(req: Request, allowed: Kind[]): Promise<CloudDevice>;
}

/** Only ChatGPT's own callback: a code is never sent anywhere else, whoever registers. */
export const isChatGptCallback = (uri: string): boolean =>
  /^https:\/\/chatgpt\.com\/(connector_platform_oauth_redirect|connector\/oauth\/[A-Za-z0-9_-]+)$/.test(uri);

/** The secret from the owner link, or from the secret pasted on its own. */
export const ownerKeyFrom = (pasted: string): string | null => {
  const text = pasted.trim();
  if (/^[A-Za-z0-9_-]{20,64}$/.test(text)) return text;
  return /[?&](?:owner|k)=([A-Za-z0-9_-]{20,64})(?:[&#]|$)/.exec(text)?.[1] ?? null;
};

/** Integer cents as rupees, without going through a float: 480050 → "Rs 4,800.50". */
export const rupees = (cents: number): string =>
  `Rs ${String(Math.trunc(cents / 100)).replace(/\B(?=(\d{3})+$)/g, ',')}.${String(cents % 100).padStart(2, '0')}`;

/** PKCE S256: what the verifier must hash to. */
export const s256 = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (status: number, body: string) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect ChatGPT</title>
<style>body{font:16px/1.5 "DM Sans",system-ui,sans-serif;max-width:28rem;margin:0 auto;padding:24px 16px;color:#1c1c1e;background:#f2f1ef}
h1{font-size:24px;margin:0 0 12px}label{display:block;font-weight:600;margin:20px 0 6px}
input{box-sizing:border-box;width:100%;min-height:48px;padding:0 12px;font:inherit;border:1px solid #8a8a8e;border-radius:8px}
button{width:100%;min-height:48px;margin-top:16px;font:inherit;font-weight:600;color:#fff;background:#1c1c1e;border:0;border-radius:8px}
.no{color:#b3261e}@media (prefers-color-scheme:dark){body{color:#f2f1ef;background:#000}input{color:#f2f1ef;background:#1c1c1e}button{color:#000;background:#f2f1ef}.no{color:#ff8a80}}</style>
</head><body>${body}</body></html>`, {
  status,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    // Browsers also apply form-action to the redirect after the form, so ChatGPT is listed.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
  },
});

const notRight = () => page(400, '<h1>This connection is not right</h1><p>Start again from ChatGPT.</p>');

interface Ask { redirectUri: string; state: string; challenge: string }

const approvalPage = ({ redirectUri, state, challenge }: Ask, resource: string, wrong: boolean) => page(wrong ? 401 : 200, `<h1>Connect ChatGPT to your shop</h1>
<p>ChatGPT will read your sales, what needs attention, your stock, supplier prices and orders, and what each dish costs and earns. No staff names. It can fill in a supplier's draft order when you ask; you place the order yourself in the app. It cannot change anything else. OpenAI keeps what it reads in your chat history.</p>
<form method="post" action="${OAUTH}/authorize">
<input type="hidden" name="client_id" value="${MCP_CLIENT_ID}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<input type="hidden" name="code_challenge" value="${escapeHtml(challenge)}">
<input type="hidden" name="code_challenge_method" value="S256">
<input type="hidden" name="resource" value="${escapeHtml(resource)}">
<label for="link">Your owner link</label>
<input id="link" name="link" autocomplete="off" autocapitalize="off" spellcheck="false" required${wrong ? ' aria-describedby="why" aria-invalid="true"' : ''}>
${wrong ? '<p id="why" class="no">This link is not right. Paste the whole owner link.</p>' : ''}
<button>Connect</button>
</form>`);

const oauthError = (status: number, error: string) => json(status, { error });

/** Not disconnected, and the owner device still exists: access lives only as long as the phone that approved it. */
const STILL_LINKED = `l.revoked_at IS NULL AND EXISTS (SELECT 1 FROM devices d WHERE d.id = l.device_id AND d.tenant_id = l.tenant_id AND d.kind = 'owner')`;

/** ChatGPT registers itself. Every registration gets the same public client: only the callback matters. */
const register = async (req: Request): Promise<Response> => {
  const body = await req.json().catch(() => null) as { redirect_uris?: unknown } | null;
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string' && isChatGptCallback(u))) {
    return oauthError(400, 'invalid_redirect_uri');
  }
  return json(201, {
    client_id: MCP_CLIENT_ID,
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: MCP_SCOPE,
  });
};

const authorize = async (req: Request, url: URL, c: McpContext): Promise<Response> => {
  const form = req.method === 'POST' ? await req.formData().catch(() => null) : null;
  const read = (name: string) => String((form ? form.get(name) : url.searchParams.get(name)) ?? '');
  const resource = `${url.origin}/mcp`;
  const ask: Ask = { redirectUri: read('redirect_uri'), state: read('state'), challenge: read('code_challenge') };
  // All checked first, and answered here: a wrong address never receives a redirect.
  if (read('client_id') !== MCP_CLIENT_ID || !isChatGptCallback(ask.redirectUri)
    || read('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(ask.challenge)
    || (read('resource') && read('resource') !== resource)) return notRight();
  if (req.method === 'GET') return read('response_type') === 'code' ? approvalPage(ask, resource, false) : notRight();

  const key = ownerKeyFrom(read('link'));
  const device = key
    ? await c.db.prepare("SELECT id, tenant_id FROM devices WHERE token_hash = ? AND kind = 'owner'").bind(await sha256Hex(key))
      .first<{ id: string; tenant_id: string }>()
    : null;
  if (!device) return approvalPage(ask, resource, true);

  const code = randomToken();
  const t = c.now();
  await c.db.batch([
    c.db.prepare('DELETE FROM mcp_codes WHERE expires_at <= ?').bind(t),
    c.db.prepare('INSERT INTO mcp_codes (code_hash, tenant_id, device_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await sha256Hex(code), device.tenant_id, device.id, ask.redirectUri, ask.challenge, t + CODE_MS),
  ]);
  const back = new URL(ask.redirectUri);
  back.searchParams.set('code', code);
  if (ask.state) back.searchParams.set('state', ask.state);
  back.searchParams.set('iss', url.origin);
  return new Response(null, { status: 303, headers: { location: back.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
};

const token = async (req: Request, url: URL, c: McpContext): Promise<Response> => {
  const form = await req.formData().catch(() => null);
  if (!form) return oauthError(400, 'invalid_request');
  if (form.get('client_id') !== MCP_CLIENT_ID) return oauthError(401, 'invalid_client');
  const resource = form.get('resource');
  if (resource && resource !== `${url.origin}/mcp`) return oauthError(400, 'invalid_target');
  const t = c.now();
  const access = randomToken();
  const refresh = randomToken();
  const answer = () => json(200, { access_token: access, token_type: 'bearer', expires_in: ACCESS_S, refresh_token: refresh, scope: MCP_SCOPE });
  const grant = form.get('grant_type');

  if (grant === 'authorization_code') {
    const codeHash = await sha256Hex(String(form.get('code') ?? ''));
    const row = await c.db.prepare('SELECT tenant_id, device_id, redirect_uri, code_challenge, expires_at FROM mcp_codes WHERE code_hash = ?').bind(codeHash)
      .first<{ tenant_id: string; device_id: string; redirect_uri: string; code_challenge: string; expires_at: number }>();
    // Deleting decides who wins: a code works once, even if it arrives twice at the same moment.
    const taken = row ? (await c.db.prepare('DELETE FROM mcp_codes WHERE code_hash = ?').bind(codeHash).run()).meta.changes === 1 : false;
    if (!row || !taken || row.expires_at <= t || row.redirect_uri !== form.get('redirect_uri')
      || await s256(String(form.get('code_verifier') ?? '')) !== row.code_challenge) return oauthError(400, 'invalid_grant');
    await c.db.prepare(`INSERT INTO mcp_links (access_hash, refresh_hash, tenant_id, device_id, access_expires_at, refresh_expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(await sha256Hex(access), await sha256Hex(refresh), row.tenant_id, row.device_id, t + ACCESS_S * 1000, t + REFRESH_MS, t).run();
    return answer();
  }

  if (grant === 'refresh_token') {
    // A public client has no secret, so each refresh token works once.
    const done = await c.db.prepare(`UPDATE mcp_links AS l SET access_hash = ?, refresh_hash = ?, access_expires_at = ?, refresh_expires_at = ?
      WHERE refresh_hash = ? AND refresh_expires_at > ? AND ${STILL_LINKED}`)
      .bind(await sha256Hex(access), await sha256Hex(refresh), t + ACCESS_S * 1000, t + REFRESH_MS, await sha256Hex(String(form.get('refresh_token') ?? '')), t).run();
    return done.meta.changes === 1 ? answer() : oauthError(400, 'invalid_grant');
  }
  return oauthError(400, 'unsupported_grant_type');
};

/** The owner's Disconnect button: only his phone can see or change this, for his own shop. */
const connection = async (req: Request, path: string, c: McpContext): Promise<Response> => {
  const { tenantId } = await c.authenticate(req, ['owner']);
  const t = c.now();
  if (path === 'connection') {
    const row = await c.db.prepare(`SELECT COUNT(*) AS n FROM mcp_links l WHERE l.tenant_id = ? AND l.refresh_expires_at > ? AND ${STILL_LINKED}`)
      .bind(tenantId, t).first<{ n: number }>();
    return json(200, { connected: (row?.n ?? 0) > 0 });
  }
  if (path === 'disconnect') {
    await c.db.batch([
      c.db.prepare('DELETE FROM mcp_links WHERE tenant_id = ? AND revoked_at <= ?').bind(tenantId, t - UNDO_MS),
      c.db.prepare('UPDATE mcp_links SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL').bind(t, tenantId),
    ]);
    return json(200, { at: t });
  }
  const at = (await req.json().catch(() => null) as { at?: unknown } | null)?.at;
  if (!Number.isSafeInteger(at) || (at as number) <= t - UNDO_MS) throw new HttpError(410, 'server', 'too late to undo');
  await c.db.prepare('UPDATE mcp_links SET revoked_at = NULL WHERE tenant_id = ? AND revoked_at = ?').bind(tenantId, at).run();
  return json(200, { ok: true });
};

/** A period can reach back this far in one question; by_day keeps the answer small enough for a chat. */
const MAX_DAYS = 92;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86_400_000;
const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dateOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (date: string): string => WEEKDAYS[new Date(dayNumber(date) * DAY_MS).getUTCDay()];
/** A real calendar date: 2026-02-31 does not come back the same. */
const isDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(dayNumber(v)) && dateOf(dayNumber(v)) === v;

interface Sums { orders: number; total: number; cash: number; transfer: number; other: number; discounts: number; online: number }

/** Payments that still stand between two dates, in Sri Lanka time; `until` stops each day at that time. */
const sumsOf = async (db: D1Like, tenantId: string, from: string, to: string, until: string | null): Promise<Sums> =>
  (await db.prepare(`SELECT COUNT(*) AS orders,
      COALESCE(SUM(total), 0) AS total,
      COALESCE(SUM(CASE WHEN tender = 'cash' THEN total ELSE 0 END), 0) AS cash,
      COALESCE(SUM(CASE WHEN tender = 'transfer' THEN total ELSE 0 END), 0) AS transfer,
      COALESCE(SUM(CASE WHEN tender NOT IN ('cash', 'transfer') THEN total ELSE 0 END), 0) AS other,
      COALESCE(SUM(discount), 0) AS discounts,
      COALESCE(SUM(online), 0) AS online
    FROM sales WHERE tenant_id = ? AND sale_date BETWEEN ? AND ? AND status = 'paid' AND (? IS NULL OR sale_time <= ?)`)
    .bind(tenantId, from, to, until, until).first<Sums>())!;

const moneyOf = (s: Sums) => ({
  orders: s.orders,
  total: rupees(s.total),
  cash: rupees(s.cash),
  bank_transfer: rupees(s.transfer),
  other_payments: rupees(s.other),
  discounts_given: rupees(s.discounts),
  online_orders: s.online,
});

const topItems = async (db: D1Like, tenantId: string, from: string, to: string) =>
  (await db.prepare(`SELECT i.item_name AS name, SUM(i.qty) AS qty
    FROM sale_items i JOIN sales s ON s.id = i.sale_id
    WHERE s.tenant_id = ? AND i.tenant_id = ? AND s.sale_date BETWEEN ? AND ? AND s.status = 'paid'
    GROUP BY i.item_name ORDER BY qty DESC, name LIMIT ?`).bind(tenantId, tenantId, from, to, TOP_ITEMS).all<{ name: string; qty: number }>()).results;

const comparison = (description: string, orders: number, total: number, against: number) => ({
  description,
  orders,
  total: rupees(total),
  change_percent: total > 0 ? Math.round(((against - total) * 100) / total) : null,
});

/**
 * The usual for one day: the same weekday in the last 4 weeks the shop was open, as the Today screen
 * counts it. Needs 2 such days, or there is no usual yet. `until` compares a day still in progress
 * with the same days up to the same time.
 */
const usualFor = async (db: D1Like, tenantId: string, date: string, against: number, until: string | null) => {
  const days = [7, 14, 21, 28].map((k) => dateOf(dayNumber(date) - k));
  const { results } = await db.prepare(`SELECT sale_date,
      SUM(CASE WHEN ? IS NULL OR sale_time <= ? THEN 1 ELSE 0 END) AS orders,
      SUM(CASE WHEN ? IS NULL OR sale_time <= ? THEN total ELSE 0 END) AS total
    FROM sales WHERE tenant_id = ? AND sale_date IN (?, ?, ?, ?) AND status = 'paid' GROUP BY sale_date`)
    .bind(until, until, until, until, tenantId, ...days).all<{ orders: number; total: number }>();
  if (results.length < 2) return null;
  const average = (f: (r: { orders: number; total: number }) => number) => Math.round(results.reduce((n, r) => n + f(r), 0) / results.length);
  const name = weekdayOf(date);
  return comparison(`The usual ${name}${until ? ` by ${until}` : ''}: the average of the last ${results.length} ${name}s the shop was open`, average((r) => r.orders), average((r) => r.total), against);
};

const lastCopied = async (db: D1Like, tenantId: string, t: number) => {
  const copied = (await db.prepare('SELECT MAX(copied_at) AS at FROM events WHERE tenant_id = ?').bind(tenantId).first<{ at: number | null }>())?.at ?? null;
  return copied === null ? null : { date: lkDate(copied), time: lkTime(copied), minutes_ago: Math.max(0, Math.floor((t - copied) / 60_000)) };
};

/** Today in the shop, in Sri Lanka time. */
export const todaySales = async (db: D1Like, tenantId: string, t: number) => {
  const date = lkDate(t);
  const time = lkTime(t);
  const sums = await sumsOf(db, tenantId, date, date, null);
  return {
    date,
    time_now: time,
    ...moneyOf(sums),
    top_items: await topItems(db, tenantId, date, date),
    compared_with: await usualFor(db, tenantId, date, sums.total, time),
    last_copied_from_shop: await lastCopied(db, tenantId, t),
  };
};

/** Any finished or running period; or, as a string, why those dates cannot be answered. */
export const salesBetween = async (db: D1Like, tenantId: string, t: number, args: Record<string, unknown> | undefined) => {
  const from = args?.date_from;
  const to = args?.date_to;
  if (!isDate(from) || !isDate(to)) return 'date_from and date_to must be real dates, written YYYY-MM-DD.';
  const today = lkDate(t);
  if (from > to) return 'date_from must not be after date_to.';
  if (to > today) return `date_to is in the future. Today is ${today}.`;
  const days = dayNumber(to) - dayNumber(from) + 1;
  if (days > MAX_DAYS) return `That is ${days} days. Ask for at most ${MAX_DAYS} days at a time.`;

  const sums = await sumsOf(db, tenantId, from, to, null);
  const single = days === 1;
  const running = to === today;
  let compared: ReturnType<typeof comparison> | null;
  if (single) {
    compared = await usualFor(db, tenantId, from, sums.total, running ? lkTime(t) : null);
  } else {
    const before = dateOf(dayNumber(from) - days);
    const end = dateOf(dayNumber(from) - 1);
    const previous = await sumsOf(db, tenantId, before, end, null);
    compared = previous.orders > 0 ? comparison(`The ${days} days before: ${before} to ${end}`, previous.orders, previous.total, sums.total) : null;
  }
  const { results: byDay } = await db.prepare(`SELECT sale_date AS date, COUNT(*) AS orders, SUM(total) AS total
    FROM sales WHERE tenant_id = ? AND sale_date BETWEEN ? AND ? AND status = 'paid' GROUP BY sale_date ORDER BY sale_date`)
    .bind(tenantId, from, to).all<{ date: string; orders: number; total: number }>();
  return {
    date_from: from,
    date_to: to,
    days,
    includes_today_so_far: running,
    ...moneyOf(sums),
    top_items: await topItems(db, tenantId, from, to),
    by_day: byDay.map((d) => ({ date: d.date, weekday: weekdayOf(d.date), orders: d.orders, total: rupees(d.total) })),
    compared_with: compared,
    last_copied_from_shop: await lastCopied(db, tenantId, t),
  };
};

/** A digest bigger than this is not one: a whole shop's is tens of KB, and D1 rows stop at 2 MB. */
const MAX_DIGEST_CHARS = 1_000_000;
/** How many pending drafts to look back through; the shop server takes them within seconds. */
const PENDING_INBOX = 50;
const MAX_DRAFT_LINES = 50;
const MAX_PACKS = 1000;

interface Digest { digest: OwnerDigest; computedAt: number }

const NO_DIGEST = 'The shop PC has not sent this yet. It sends it a few minutes after ChatGPT connects, while the PC is on and online. Sales still work.';

const digestOf = async (db: D1Like, tenantId: string): Promise<Digest | null> => {
  const row = await db.prepare('SELECT computed_at, body FROM owner_digests WHERE tenant_id = ?').bind(tenantId).first<{ computed_at: number; body: string }>();
  return row ? { digest: JSON.parse(row.body) as OwnerDigest, computedAt: row.computed_at } : null;
};

const asOf = (computedAt: number, t: number) => ({ date: lkDate(computedAt), time: lkTime(computedAt), minutes_ago: Math.max(0, Math.floor((t - computedAt) / 60_000)) });

const attentionAnswer = ({ digest, computedAt }: Digest, t: number) => ({
  as_of: asOf(computedAt, t),
  cards: digest.attention.map((c) => ({
    tone: c.tone,
    title: c.title,
    detail: c.detail,
    items: c.items.map((i) => ({ what: i.what, note: i.note ?? null, amount: i.amountCents === undefined ? null : rupees(i.amountCents) })),
  })),
});

const stockAnswer = ({ digest, computedAt }: Digest, t: number, args: Record<string, unknown> | undefined) => {
  const onlyAttention = args?.only_needing_attention === true;
  const items = onlyAttention ? digest.stock.filter((i) => i.status === 'out' || i.status === 'low' || i.status === 'unsure') : digest.stock;
  return {
    as_of: asOf(computedAt, t),
    items: items.map((i) => ({
      item_id: i.id,
      name: i.name,
      category: i.category,
      status: i.status,
      on_hand: i.onHand,
      used_per_day: i.usedPerDay,
      lasts_days: i.lastsDays,
      pack: i.pack,
      pack_price: rupees(i.packPriceCents),
      suggested_packs: i.suggestedPacks,
      on_order_packs: i.onOrderPacks,
      supplier_ids: i.supplierIds,
    })),
    semi_processed: digest.semiProcessed,
    can_make: digest.dishes.filter((d) => d.canMake !== null).map((d) => ({ name: d.name, size: d.size, can_make: d.canMake as number })),
  };
};

const profitAnswer = ({ digest, computedAt }: Digest, t: number) => ({
  as_of: asOf(computedAt, t),
  dishes: digest.dishes.map((d) => {
    const earned = d.foodCostCents === null ? null : d.priceCents - d.foodCostCents;
    return {
      name: d.name,
      size: d.size,
      price: rupees(d.priceCents),
      food_cost: d.foodCostCents === null ? null : rupees(d.foodCostCents),
      earned_each: earned === null ? null : earned < 0 ? `-${rupees(-earned)}` : rupees(earned),
      margin_percent: d.marginPercent,
      sold_last_28_days: d.soldLast28Days,
    };
  }),
  unanswered_cost_questions: digest.unansweredCosts,
});

const packsOut = (l: DigestLine) => ({ item_id: l.itemId, name: l.name, packs: l.packs, ...(l.unitPriceCents === undefined ? {} : { pack_price: rupees(l.unitPriceCents) }) });

const ordersAnswer = ({ digest, computedAt }: Digest, t: number) => ({
  as_of: asOf(computedAt, t),
  suppliers: digest.suppliers.map((s) => ({
    supplier_id: s.id,
    name: s.name,
    usual_days_to_deliver: s.leadDays,
    draft: s.draft.map(packsOut),
    suggested: s.suggested.map(packsOut),
    open_orders: s.openOrders.map((o) => ({ number: o.number, status: o.status, placed_on: lkDate(o.placedAt), lines: o.lines.map(packsOut) })),
  })),
});

/** The newest draft for this supplier the shop has not folded in yet: a second request must build on the first. */
const pendingDraft = async (db: D1Like, tenantId: string, supplierId: string, computedAt: number) => {
  const { results } = await db.prepare('SELECT body FROM inbox WHERE tenant_id = ? AND received_at > ? ORDER BY seq DESC LIMIT ?')
    .bind(tenantId, computedAt, PENDING_INBOX).all<{ body: string }>();
  for (const { body } of results) {
    const e = JSON.parse(body) as SyncEvent;
    if (e.type === 'stock.draft_set' && e.supplierId === supplierId) return e.lines;
  }
  return null;
};

/**
 * Sets some lines of one supplier's draft, leaving the others as they are; 0 packs takes a line off.
 * Nothing is ordered: the owner or a manager places it on the Order page. The answer says what would
 * put the draft back. Prices are never set here, so a line keeps the price it had, or the item's own.
 */
const setDraftLines = async (db: D1Like, tenantId: string, deviceId: string, found: Digest, t: number, args: Record<string, unknown> | undefined) => {
  const { digest } = found;
  const supplierId = args?.supplier_id;
  const lines = args?.lines;
  const supplier = digest.suppliers.find((s) => s.id === supplierId);
  if (!supplier) return 'Unknown supplier_id. Use one from get_supplier_orders.';
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_DRAFT_LINES) return `lines must hold 1 to ${MAX_DRAFT_LINES} items.`;

  const pending = await pendingDraft(db, tenantId, supplier.id, found.computedAt);
  const before = new Map<string, { packs: number; unitPriceCents?: number }>(
    (pending ?? supplier.draft).map((l) => [l.itemId, { packs: l.packs, ...(l.unitPriceCents === undefined ? {} : { unitPriceCents: l.unitPriceCents }) }]),
  );
  const after = new Map(before);
  const toUndo = new Map<string, number>();
  for (const line of lines as { item_id?: unknown; packs?: unknown }[]) {
    const packs = line?.packs;
    const item = digest.stock.find((i) => i.id === line?.item_id);
    if (!item) return `Unknown item_id ${JSON.stringify(line?.item_id)}. Use one from get_stock.`;
    if (!item.supplierIds.includes(supplier.id)) return `${supplier.name} does not sell ${item.name} according to the shop's price list.`;
    if (typeof packs !== 'number' || !Number.isFinite(packs) || packs < 0 || packs > MAX_PACKS) return `packs for ${item.name} must be from 0 to ${MAX_PACKS}.`;
    if (!toUndo.has(item.id)) toUndo.set(item.id, before.get(item.id)?.packs ?? 0);
    if (packs === 0) after.delete(item.id);
    else after.set(item.id, { ...after.get(item.id), packs });
  }

  const nameOf = (id: string) => digest.stock.find((i) => i.id === id)?.name ?? id;
  const unchanged = after.size === before.size && [...after].every(([id, l]) => before.get(id)?.packs === l.packs);
  if (!unchanged) {
    const event = {
      id: crypto.randomUUID(),
      shopId: tenantId,
      type: 'stock.draft_set',
      at: t,
      orderNumber: 0,
      actor: { id: `chatgpt-${deviceId}`, name: 'ChatGPT, for the owner', role: 'owner' },
      supplierId: supplier.id,
      lines: [...after].map(([itemId, l]) => ({ itemId, ...l })),
    };
    const checked = validatePush({ events: [event] }, tenantId);
    if ('reason' in checked) return `The shop would refuse this draft: ${checked.reason}.`;
    await db.prepare('INSERT INTO inbox (tenant_id, id, device_id, received_at, body) VALUES (?, ?, ?, ?, ?)')
      .bind(tenantId, event.id, deviceId, t, JSON.stringify(event)).run();
  }
  const ordered = new Set(supplier.openOrders.flatMap((o) => o.lines.map((l) => l.itemId)));
  return {
    supplier: supplier.name,
    changed: !unchanged,
    draft: [...after].map(([id, l]) => ({ item_id: id, name: nameOf(id), packs: l.packs })),
    already_on_an_open_order: [...after.keys()].filter((id) => ordered.has(id)).map(nameOf),
    to_undo: { supplier_id: supplier.id, lines: [...toUndo].map(([item_id, packs]) => ({ item_id, packs })) },
    nothing_is_ordered: "This is only a draft on the app's Order page. A person places it. It reaches the shop within a minute while the PC is online.",
  };
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const DRAFT_ONLY = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SIGN_IN = [{ type: 'oauth2', scopes: [MCP_SCOPE] }];
const MONEY_FIELDS = {
  orders: { type: 'integer' },
  total: { type: 'string', description: 'Rupees, already formatted' },
  cash: { type: 'string' },
  bank_transfer: { type: 'string' },
  other_payments: { type: 'string' },
  discounts_given: { type: 'string' },
  online_orders: { type: 'integer' },
  top_items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'integer' } }, required: ['name', 'qty'] } },
  compared_with: {
    type: ['object', 'null'],
    description: 'What to compare with; null when the shop has too little history to say.',
    properties: {
      description: { type: 'string' },
      orders: { type: 'integer' },
      total: { type: 'string' },
      change_percent: { type: ['integer', 'null'], description: 'How far this period is above (+) or below (-) the comparison' },
    },
  },
  last_copied_from_shop: {
    type: ['object', 'null'],
    properties: { date: { type: 'string' }, time: { type: 'string' }, minutes_ago: { type: 'integer' } },
  },
};
const MONEY_REQUIRED = ['orders', 'total', 'cash', 'bank_transfer', 'other_payments', 'discounts_given', 'online_orders', 'top_items', 'compared_with', 'last_copied_from_shop'];

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };
const AS_OF = {
  type: 'object',
  description: 'When the shop PC worked this out, in Sri Lanka time',
  properties: { date: { type: 'string' }, time: { type: 'string' }, minutes_ago: { type: 'integer' } },
  required: ['date', 'time', 'minutes_ago'],
};
const PACK_LINES = {
  type: 'array',
  items: { type: 'object', properties: { item_id: { type: 'string' }, name: { type: 'string' }, packs: { type: 'number' }, pack_price: { type: 'string' } }, required: ['item_id', 'name', 'packs'] },
};

const TOOLS = [{
  name: 'get_today_sales',
  title: "Today's sales",
  description: "Today's orders, takings by payment type, discounts and best-selling items at the owner's shop, in Sri Lanka time, compared with the usual for this weekday by this time. Sales arrive when the shop PC is online: check last_copied_from_shop and say so if it is old.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: {
    type: 'object',
    properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, time_now: { type: 'string', description: 'HH:MM' }, ...MONEY_FIELDS },
    required: ['date', 'time_now', ...MONEY_REQUIRED],
  },
  annotations: READ_ONLY,
  securitySchemes: SIGN_IN,
}, {
  name: 'get_sales',
  title: 'Sales for any dates',
  description: `Orders, takings, discounts and best-selling items for one day or a period of up to ${MAX_DAYS} days, in Sri Lanka time, with each day's total. One day is compared with the usual for that weekday; a period with the same number of days before it. The numbers say what happened, not why: do not state a cause they do not show.`,
  inputSchema: {
    type: 'object',
    properties: {
      date_from: { type: 'string', description: 'First day, YYYY-MM-DD' },
      date_to: { type: 'string', description: 'Last day, YYYY-MM-DD. The same as date_from for one day.' },
    },
    required: ['date_from', 'date_to'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      date_from: { type: 'string' },
      date_to: { type: 'string' },
      days: { type: 'integer' },
      includes_today_so_far: { type: 'boolean', description: 'True when today is not over, so a period is still growing' },
      by_day: {
        type: 'array',
        description: 'Only days with sales',
        items: { type: 'object', properties: { date: { type: 'string' }, weekday: { type: 'string' }, orders: { type: 'integer' }, total: { type: 'string' } }, required: ['date', 'weekday', 'orders', 'total'] },
      },
      ...MONEY_FIELDS,
    },
    required: ['date_from', 'date_to', 'days', 'includes_today_so_far', 'by_day', ...MONEY_REQUIRED],
  },
  annotations: READ_ONLY,
  securitySchemes: SIGN_IN,
}, {
  name: 'get_attention',
  title: 'What needs attention',
  description: "The owner's To do list from his Today screen: what needs a decision first, then news. Use it for \"anything I should deal with?\". It never names staff: do not guess who.",
  inputSchema: NO_INPUT,
  outputSchema: {
    type: 'object',
    properties: {
      as_of: AS_OF,
      cards: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tone: { type: 'string', description: 'attention, info or good' },
            title: { type: 'string' },
            detail: { type: 'string' },
            items: { type: 'array', items: { type: 'object', properties: { what: { type: 'string' }, note: { type: ['string', 'null'] }, amount: { type: ['string', 'null'] } }, required: ['what', 'note', 'amount'] } },
          },
          required: ['tone', 'title', 'detail', 'items'],
        },
      },
    },
    required: ['as_of', 'cards'],
  },
  annotations: READ_ONLY,
  securitySchemes: SIGN_IN,
}, {
  name: 'get_stock',
  title: 'Stock',
  description: 'Every stock item: status, what is on hand, use per day, how many days it lasts, what is on order, and how many of each dish the stock can make. status unknown means never counted, not empty; unsure means sales could not be taken off it. A count is only as good as the last shelf count.',
  inputSchema: {
    type: 'object',
    properties: { only_needing_attention: { type: 'boolean', description: 'Only items that are out, low or unsure' } },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      as_of: AS_OF,
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            item_id: { type: 'string' },
            name: { type: 'string' },
            category: { type: 'string' },
            status: { type: 'string', description: 'out, low, unsure, ok or unknown' },
            on_hand: { type: ['string', 'null'] },
            used_per_day: { type: ['string', 'null'] },
            lasts_days: { type: ['number', 'null'] },
            pack: { type: 'string' },
            pack_price: { type: 'string' },
            suggested_packs: { type: 'number' },
            on_order_packs: { type: 'number' },
            supplier_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['item_id', 'name', 'category', 'status', 'on_hand', 'used_per_day', 'lasts_days', 'pack', 'pack_price', 'suggested_packs', 'on_order_packs', 'supplier_ids'],
        },
      },
      semi_processed: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, onHand: { type: 'string' }, status: { type: 'string' } }, required: ['name', 'onHand', 'status'] } },
      can_make: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, size: { type: 'string' }, can_make: { type: 'integer' } }, required: ['name', 'size', 'can_make'] } },
    },
    required: ['as_of', 'items', 'semi_processed', 'can_make'],
  },
  annotations: READ_ONLY,
  securitySchemes: SIGN_IN,
}, {
  name: 'get_menu_profit',
  title: 'What each dish earns',
  description: 'Every dish and size on the menu: price, food cost, what it earns each, margin, and how many sold in the last 28 days. Food cost is ingredients only, not labour or rent. food_cost is null until every part of the recipe has a price: do not estimate it. For a what-if on a price, work it out from these numbers and say it is your own arithmetic.',
  inputSchema: NO_INPUT,
  outputSchema: {
    type: 'object',
    properties: {
      as_of: AS_OF,
      dishes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            size: { type: 'string' },
            price: { type: 'string' },
            food_cost: { type: ['string', 'null'] },
            earned_each: { type: ['string', 'null'] },
            margin_percent: { type: ['integer', 'null'] },
            sold_last_28_days: { type: 'number' },
          },
          required: ['name', 'size', 'price', 'food_cost', 'earned_each', 'margin_percent', 'sold_last_28_days'],
        },
      },
      unanswered_cost_questions: { type: 'integer', description: 'Recipe questions on the Recipes screen holding some dishes back' },
    },
    required: ['as_of', 'dishes', 'unanswered_cost_questions'],
  },
  annotations: READ_ONLY,
  securitySchemes: SIGN_IN,
}, {
  name: 'get_supplier_orders',
  title: 'Supplier orders',
  description: "For each supplier: the draft waiting on the Order page, what the reorder rule suggests buying now, open orders, and the usual days to deliver. Call this before draft_supplier_order.",
  inputSchema: NO_INPUT,
  outputSchema: {
    type: 'object',
    properties: {
      as_of: AS_OF,
      suppliers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            supplier_id: { type: 'string' },
            name: { type: 'string' },
            usual_days_to_deliver: { type: ['number', 'null'] },
            draft: PACK_LINES,
            suggested: PACK_LINES,
            open_orders: { type: 'array', items: { type: 'object', properties: { number: { type: 'string' }, status: { type: 'string' }, placed_on: { type: 'string' }, lines: PACK_LINES }, required: ['number', 'status', 'placed_on', 'lines'] } },
          },
          required: ['supplier_id', 'name', 'usual_days_to_deliver', 'draft', 'suggested', 'open_orders'],
        },
      },
    },
    required: ['as_of', 'suppliers'],
  },
  annotations: READ_ONLY,
  securitySchemes: SIGN_IN,
}, {
  name: 'draft_supplier_order',
  title: "Fill in a supplier's draft order",
  description: "Sets items on one supplier's draft order on the app's Order page, in packs; other lines stay, and 0 packs takes a line off. Use only when the owner asks for it. It orders nothing and sends nothing: he or a manager places it. Tell him what changed, and if he says undo, call this again with to_undo from the answer.",
  inputSchema: {
    type: 'object',
    properties: {
      supplier_id: { type: 'string', description: 'From get_supplier_orders' },
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_DRAFT_LINES,
        items: { type: 'object', properties: { item_id: { type: 'string', description: 'From get_stock' }, packs: { type: 'number', minimum: 0, maximum: MAX_PACKS } }, required: ['item_id', 'packs'], additionalProperties: false },
      },
    },
    required: ['supplier_id', 'lines'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      supplier: { type: 'string' },
      changed: { type: 'boolean' },
      draft: { type: 'array', items: { type: 'object', properties: { item_id: { type: 'string' }, name: { type: 'string' }, packs: { type: 'number' } }, required: ['item_id', 'name', 'packs'] } },
      already_on_an_open_order: { type: 'array', items: { type: 'string' } },
      to_undo: { type: 'object', properties: { supplier_id: { type: 'string' }, lines: { type: 'array', items: { type: 'object', properties: { item_id: { type: 'string' }, packs: { type: 'number' } }, required: ['item_id', 'packs'] } } }, required: ['supplier_id', 'lines'] },
      nothing_is_ordered: { type: 'string' },
    },
    required: ['supplier', 'changed', 'draft', 'already_on_an_open_order', 'to_undo', 'nothing_is_ordered'],
  },
  annotations: DRAFT_ONLY,
  securitySchemes: SIGN_IN,
}];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

const rpcResult = (id: unknown, result: Record<string, unknown>) => json(200, {
  jsonrpc: '2.0',
  id,
  result: { resultType: 'complete', ...result, _meta: { ...(result._meta as object | undefined), 'io.modelcontextprotocol/serverInfo': SERVER_INFO } },
});
const rpcError = (id: unknown, code: number, message: string, status = 200, data?: unknown) =>
  json(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });

/** Why this request breaks the 2026-07-28 rules, or null. Older clients send none of this. */
const modernRefusal = (req: Request, id: unknown, method: string, params: Record<string, unknown> | undefined): Response | null => {
  const meta = params?._meta as Record<string, unknown> | undefined;
  const header = req.headers.get('mcp-protocol-version');
  const version = meta?.[VERSION_KEY];
  if (version === undefined && header !== MODERN_VERSION) return null;
  if (version === undefined) return rpcError(id, -32602, `_meta needs ${VERSION_KEY}`, 400);
  if (version !== MODERN_VERSION) return rpcError(id, -32022, 'Unsupported protocol version', 400, { supported: ALL_VERSIONS, requested: version });
  if (meta?.[CAPABILITIES_KEY] === undefined) return rpcError(id, -32602, `_meta needs ${CAPABILITIES_KEY}`, 400);
  if (header !== version) return rpcError(id, -32020, 'Header mismatch: MCP-Protocol-Version', 400);
  if (req.headers.get('mcp-method') !== method) return rpcError(id, -32020, 'Header mismatch: Mcp-Method', 400);
  if (method === 'tools/call' && req.headers.get('mcp-name') !== params?.name) return rpcError(id, -32020, 'Header mismatch: Mcp-Name', 400);
  return null;
};

const answerTool = async (tool: string, db: D1Like, link: { tenant_id: string; device_id: string }, t: number, args: Record<string, unknown> | undefined): Promise<string | Record<string, unknown>> => {
  if (tool === 'get_today_sales') return todaySales(db, link.tenant_id, t);
  if (tool === 'get_sales') return salesBetween(db, link.tenant_id, t, args);
  const found = await digestOf(db, link.tenant_id);
  if (!found) return NO_DIGEST;
  switch (tool) {
    case 'get_attention': return attentionAnswer(found, t);
    case 'get_stock': return stockAnswer(found, t, args);
    case 'get_menu_profit': return profitAnswer(found, t);
    case 'get_supplier_orders': return ordersAnswer(found, t);
    default: return setDraftLines(db, link.tenant_id, link.device_id, found, t, args);
  }
};

const mcp = async (req: Request, url: URL, c: McpContext): Promise<Response> => {
  const t = c.now();
  const metadata = `${url.origin}${RESOURCE_METADATA}`;
  const unauthorized = () => {
    const r = json(401, { error: 'invalid_token' });
    r.headers.set('www-authenticate', `Bearer resource_metadata="${metadata}", scope="${MCP_SCOPE}"`);
    return r;
  };
  const h = req.headers.get('authorization');
  const bearer = h?.startsWith('Bearer ') ? h.slice(7) : null;
  const link = bearer
    ? await c.db.prepare(`SELECT l.tenant_id, l.device_id FROM mcp_links l WHERE l.access_hash = ? AND l.access_expires_at > ? AND ${STILL_LINKED}`)
      .bind(await sha256Hex(bearer), t).first<{ tenant_id: string; device_id: string }>()
    : null;
  // A wrong or old token always hears 401, which is what makes ChatGPT refresh or sign in again.
  if (bearer && !link) return unauthorized();
  // No session and nothing to stream, so POST is the whole of it.
  if (req.method !== 'POST') {
    if (!link) return unauthorized();
    const r = json(405, { error: 'method_not_allowed' });
    r.headers.set('allow', 'POST');
    return r;
  }
  const body = await req.json().catch(() => undefined) as { id?: unknown; method?: unknown; params?: Record<string, unknown> } | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.method !== 'string') {
    // ChatGPT's first probe is an empty POST: the 401 is how it finds the sign-in documents.
    return link ? rpcError(null, -32700, 'expected one JSON-RPC message', 400) : unauthorized();
  }
  const { id, method, params } = body;
  if (id === undefined) return new Response(null, { status: 202 }); // a notification needs no answer
  const refused = modernRefusal(req, id, method, params);
  if (refused) return refused;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, { supportedVersions: ALL_VERSIONS, capabilities: { tools: {} }, instructions: INSTRUCTIONS, ttlMs: 3_600_000, cacheScope: 'public' });
    case 'initialize': {
      const asked = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: typeof asked === 'string' && LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return rpcResult(id, {});
    case 'tools/list': return rpcResult(id, { tools: TOOLS, ttlMs: 300_000, cacheScope: 'public' });
    case 'tools/call': {
      const tool = params?.name;
      if (typeof tool !== 'string' || !TOOL_NAMES.has(tool)) return rpcError(id, -32602, 'unknown tool');
      // The only place shop data is read, and the sign-in challenge ChatGPT shows its linking screen for.
      if (!link) {
        return rpcResult(id, {
          content: [{ type: 'text', text: 'Sign in to your shop first.' }],
          isError: true,
          _meta: { 'mcp/www_authenticate': [`Bearer resource_metadata="${metadata}", error="insufficient_scope", error_description="Sign in to your shop to continue"`] },
        });
      }
      const args = params?.arguments as Record<string, unknown> | undefined;
      const answer = await answerTool(tool, c.db, link, t, args);
      if (typeof answer === 'string') return rpcResult(id, { content: [{ type: 'text', text: answer }], isError: true });
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer, isError: false });
    }
    default: return rpcError(id, -32601, 'method not found', params?._meta ? 404 : 200);
  }
};

/** The shop server's side: whether to bother, and the upload. Only a shop server, for its own shop. */
const digestRoutes = async (req: Request, path: string, c: McpContext): Promise<Response> => {
  const { tenantId } = await c.authenticate(req, ['shop_server']);
  const t = c.now();
  if (path === 'wanted') {
    const row = await c.db.prepare(`SELECT COUNT(*) AS n FROM mcp_links l WHERE l.tenant_id = ? AND l.refresh_expires_at > ? AND ${STILL_LINKED}`)
      .bind(tenantId, t).first<{ n: number }>();
    return json(200, { wanted: (row?.n ?? 0) > 0 });
  }
  const text = await req.text();
  if (text.length > MAX_DIGEST_CHARS) return json(413, { error: 'too_large' });
  let digest: { computedAt?: unknown } | undefined;
  try { digest = (JSON.parse(text) as { digest?: { computedAt?: unknown } }).digest; } catch { /* answered below */ }
  if (!digest || !Number.isSafeInteger(digest.computedAt)) return json(400, { error: 'not_a_digest' });
  await c.db.prepare(`INSERT INTO owner_digests (tenant_id, computed_at, uploaded_at, body) VALUES (?, ?, ?, ?)
    ON CONFLICT (tenant_id) DO UPDATE SET computed_at = excluded.computed_at, uploaded_at = excluded.uploaded_at, body = excluded.body`)
    .bind(tenantId, digest.computedAt as number, t, JSON.stringify(digest)).run();
  return json(200, { ok: true });
};

export async function mcpRoutes(req: Request, url: URL, c: McpContext): Promise<Response | null> {
  const { pathname: path, origin } = url;
  const mine = path === '/mcp' || path.startsWith('/mcp/') || path.startsWith(`${OAUTH}/`) || path.startsWith('/.well-known/');
  if (!mine) return null;
  if (!c.enabled) return json(404, { error: 'server', message: 'not found' });
  if (path === '/mcp') return mcp(req, url, c);
  if (req.method === 'GET' && (path === RESOURCE_METADATA || path === `${RESOURCE_METADATA}/mcp`)) {
    return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: [MCP_SCOPE] });
  }
  if (req.method === 'GET' && path === AUTH_METADATA) {
    return json(200, {
      issuer: origin,
      authorization_endpoint: `${origin}${OAUTH}/authorize`,
      token_endpoint: `${origin}${OAUTH}/token`,
      registration_endpoint: `${origin}${OAUTH}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [MCP_SCOPE],
      authorization_response_iss_parameter_supported: true,
    });
  }
  if (path === `${OAUTH}/register` && req.method === 'POST') return register(req);
  if (path === `${OAUTH}/authorize` && (req.method === 'GET' || req.method === 'POST')) return authorize(req, url, c);
  if (path === `${OAUTH}/token` && req.method === 'POST') return token(req, url, c);
  if (path === `${OAUTH}/wanted` && req.method === 'GET') return digestRoutes(req, 'wanted', c);
  if (path === `${OAUTH}/digest` && req.method === 'PUT') return digestRoutes(req, 'digest', c);
  if (path === `${OAUTH}/connection` && req.method === 'GET') return connection(req, 'connection', c);
  if ((path === `${OAUTH}/disconnect` || path === `${OAUTH}/reconnect`) && req.method === 'POST') return connection(req, path.slice(OAUTH.length + 1), c);
  return json(404, { error: 'server', message: 'not found' });
}
