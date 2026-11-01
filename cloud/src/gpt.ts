import { lkDate, lkTime } from '../../src/domain/salesLedger.ts';
import type { D1Like } from './cloud.ts';
import { json, randomToken, sha256Hex } from './http.ts';

/**
 * The owner's ChatGPT (SCRUM-197): a private Custom GPT reads the shop on his behalf.
 *
 * ChatGPT signs in with OAuth (authorization code): it sends him to /authorize, he pastes his owner
 * link, and ChatGPT swaps the code for its own tokens. Those tokens open these endpoints only, and
 * stop working when his owner device is removed. Off until the GPT_CLIENT_SECRET secret is set.
 *
 * Whatever an action answers goes to OpenAI, so answers hold totals and menu item names only:
 * never customers, staff, order numbers or anything else that identifies a person.
 */
export const GPT_CLIENT_ID = 'cheesybeez-gpt';
const CODE_MS = 5 * 60_000;
const ACCESS_S = 3600;
const TOP_ITEMS = 10;
const BASE = '/api/v1/gpt';

export interface GptContext {
  db: D1Like;
  now: () => number;
  clientSecret?: string;
}

/** Only ChatGPT's own callback: a code is never sent anywhere else. */
export const isChatGptCallback = (uri: string): boolean =>
  /^https:\/\/(chatgpt\.com|chat\.openai\.com)\/aip\/[A-Za-z0-9_-]+\/oauth\/callback$/.test(uri);

/** The secret from the owner link, or from the secret pasted on its own. */
export const ownerKeyFrom = (pasted: string): string | null => {
  const text = pasted.trim();
  if (/^[A-Za-z0-9_-]{20,64}$/.test(text)) return text;
  return /[?&](?:owner|k)=([A-Za-z0-9_-]{20,64})(?:[&#]|$)/.exec(text)?.[1] ?? null;
};

/** Integer cents as rupees, without going through a float: 480050 → "Rs 4,800.50". */
export const rupees = (cents: number): string =>
  `Rs ${String(Math.trunc(cents / 100)).replace(/\B(?=(\d{3})+$)/g, ',')}.${String(cents % 100).padStart(2, '0')}`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (status: number, body: string) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect ChatGPT</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:0 auto;padding:24px 16px;color:#1c1c1e;background:#f2f1ef}
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
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com https://chat.openai.com; frame-ancestors 'none'; base-uri 'none'",
  },
});

const approvalPage = (redirectUri: string, state: string, wrong: boolean) => page(wrong ? 401 : 200, `<h1>Connect ChatGPT to your shop</h1>
<p>ChatGPT will read today's sales: totals and which items sold. It cannot change anything. OpenAI keeps what it reads in your chat history.</p>
<form method="post" action="${BASE}/authorize">
<input type="hidden" name="client_id" value="${GPT_CLIENT_ID}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<label for="link">Your owner link</label>
<input id="link" name="link" autocomplete="off" autocapitalize="off" spellcheck="false" required${wrong ? ' aria-describedby="why" aria-invalid="true"' : ''}>
${wrong ? '<p id="why" class="no">This link is not right. Paste the whole owner link.</p>' : ''}
<button>Connect</button>
</form>`);

const oauthError = (status: number, error: string, headers: Record<string, string> = {}) => {
  const r = json(status, { error });
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
};

/** An owner device that still exists: the GPT lives only as long as the phone that approved it. */
const OWNER_DEVICE = `EXISTS (SELECT 1 FROM devices d WHERE d.id = l.device_id AND d.tenant_id = l.tenant_id AND d.kind = 'owner')`;

const authorize = async (req: Request, url: URL, c: GptContext): Promise<Response> => {
  const form = req.method === 'POST' ? await req.formData().catch(() => null) : null;
  const read = (name: string) => String((form ? form.get(name) : url.searchParams.get(name)) ?? '');
  const redirectUri = read('redirect_uri');
  // Checked first, and answered here: a wrong address never receives a redirect.
  if (read('client_id') !== GPT_CLIENT_ID || !isChatGptCallback(redirectUri)) {
    return page(400, '<h1>This connection is not right</h1><p>Start again from ChatGPT.</p>');
  }
  const state = read('state');
  if (req.method === 'GET') {
    if (read('response_type') !== 'code') return page(400, '<h1>This connection is not right</h1><p>Start again from ChatGPT.</p>');
    return approvalPage(redirectUri, state, false);
  }
  const key = ownerKeyFrom(read('link'));
  const device = key
    ? await c.db.prepare("SELECT id, tenant_id FROM devices WHERE token_hash = ? AND kind = 'owner'").bind(await sha256Hex(key))
      .first<{ id: string; tenant_id: string }>()
    : null;
  if (!device) return approvalPage(redirectUri, state, true);

  const code = randomToken();
  const t = c.now();
  await c.db.batch([
    c.db.prepare('DELETE FROM gpt_codes WHERE expires_at <= ?').bind(t),
    c.db.prepare('INSERT INTO gpt_codes (code_hash, tenant_id, device_id, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256Hex(code), device.tenant_id, device.id, redirectUri, t + CODE_MS),
  ]);
  const back = new URL(redirectUri);
  back.searchParams.set('code', code);
  if (state) back.searchParams.set('state', state);
  return new Response(null, { status: 303, headers: { location: back.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
};

/** ChatGPT may send its credentials either way; the GPT's OAuth setting picks one. */
const clientCredentials = (req: Request, form: FormData): { id: string; secret: string } => {
  const h = req.headers.get('authorization');
  if (h?.startsWith('Basic ')) {
    try {
      const plain = atob(h.slice(6));
      const colon = plain.indexOf(':');
      return { id: decodeURIComponent(plain.slice(0, colon)), secret: decodeURIComponent(plain.slice(colon + 1)) };
    } catch { return { id: '', secret: '' }; }
  }
  return { id: String(form.get('client_id') ?? ''), secret: String(form.get('client_secret') ?? '') };
};

const token = async (req: Request, c: GptContext & { clientSecret: string }): Promise<Response> => {
  const form = await req.formData().catch(() => null);
  if (!form) return oauthError(400, 'invalid_request');
  const client = clientCredentials(req, form);
  // Hashes are compared, so the time taken says nothing about how much of a guess was right.
  if (client.id !== GPT_CLIENT_ID || await sha256Hex(client.secret) !== await sha256Hex(c.clientSecret)) {
    return oauthError(401, 'invalid_client', { 'www-authenticate': 'Basic realm="gpt"' });
  }
  const t = c.now();
  const access = randomToken();
  const accessHash = await sha256Hex(access);
  const expires = t + ACCESS_S * 1000;
  const grant = form.get('grant_type');

  if (grant === 'authorization_code') {
    const codeHash = await sha256Hex(String(form.get('code') ?? ''));
    const row = await c.db.prepare('SELECT tenant_id, device_id, redirect_uri, expires_at FROM gpt_codes WHERE code_hash = ?').bind(codeHash)
      .first<{ tenant_id: string; device_id: string; redirect_uri: string; expires_at: number }>();
    // Deleting decides who wins: a code works once, even if it arrives twice at the same moment.
    const taken = row ? (await c.db.prepare('DELETE FROM gpt_codes WHERE code_hash = ?').bind(codeHash).run()).meta.changes === 1 : false;
    if (!row || !taken || row.expires_at <= t || row.redirect_uri !== String(form.get('redirect_uri') ?? '')) return oauthError(400, 'invalid_grant');
    const refresh = randomToken();
    await c.db.prepare('INSERT INTO gpt_links (access_hash, refresh_hash, tenant_id, device_id, access_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(accessHash, await sha256Hex(refresh), row.tenant_id, row.device_id, expires, t).run();
    return json(200, { access_token: access, token_type: 'bearer', expires_in: ACCESS_S, refresh_token: refresh });
  }

  if (grant === 'refresh_token') {
    const refresh = String(form.get('refresh_token') ?? '');
    const done = await c.db.prepare(`UPDATE gpt_links AS l SET access_hash = ?, access_expires_at = ? WHERE refresh_hash = ? AND ${OWNER_DEVICE}`)
      .bind(accessHash, expires, await sha256Hex(refresh)).run();
    if (done.meta.changes !== 1) return oauthError(400, 'invalid_grant');
    return json(200, { access_token: access, token_type: 'bearer', expires_in: ACCESS_S, refresh_token: refresh });
  }
  return oauthError(400, 'unsupported_grant_type');
};

/** Today in the shop, in Sri Lanka time: payments that still stand. */
const today = async (req: Request, c: GptContext): Promise<Response> => {
  const h = req.headers.get('authorization');
  const bearer = h?.startsWith('Bearer ') ? h.slice(7) : null;
  const t = c.now();
  const link = bearer
    ? await c.db.prepare(`SELECT l.tenant_id FROM gpt_links l WHERE l.access_hash = ? AND l.access_expires_at > ? AND ${OWNER_DEVICE}`)
      .bind(await sha256Hex(bearer), t).first<{ tenant_id: string }>()
    : null;
  if (!link) return oauthError(401, 'invalid_token', { 'www-authenticate': 'Bearer' });

  const date = lkDate(t);
  const sums = await c.db.prepare(`SELECT COUNT(*) AS orders,
      COALESCE(SUM(total), 0) AS total,
      COALESCE(SUM(CASE WHEN tender = 'cash' THEN total ELSE 0 END), 0) AS cash,
      COALESCE(SUM(CASE WHEN tender = 'transfer' THEN total ELSE 0 END), 0) AS transfer,
      COALESCE(SUM(CASE WHEN tender NOT IN ('cash', 'transfer') THEN total ELSE 0 END), 0) AS other,
      COALESCE(SUM(discount), 0) AS discounts,
      COALESCE(SUM(online), 0) AS online
    FROM sales WHERE tenant_id = ? AND sale_date = ? AND status = 'paid'`).bind(link.tenant_id, date)
    .first<{ orders: number; total: number; cash: number; transfer: number; other: number; discounts: number; online: number }>();
  const { results: items } = await c.db.prepare(`SELECT i.item_name AS name, SUM(i.qty) AS qty
    FROM sale_items i JOIN sales s ON s.id = i.sale_id
    WHERE s.tenant_id = ? AND i.tenant_id = ? AND s.sale_date = ? AND s.status = 'paid'
    GROUP BY i.item_name ORDER BY qty DESC, name LIMIT ?`).bind(link.tenant_id, link.tenant_id, date, TOP_ITEMS).all<{ name: string; qty: number }>();
  const copied = (await c.db.prepare('SELECT MAX(copied_at) AS at FROM events WHERE tenant_id = ?').bind(link.tenant_id).first<{ at: number | null }>())?.at ?? null;

  return json(200, {
    date,
    time_now: lkTime(t),
    orders: sums?.orders ?? 0,
    total: rupees(sums?.total ?? 0),
    cash: rupees(sums?.cash ?? 0),
    bank_transfer: rupees(sums?.transfer ?? 0),
    other_payments: rupees(sums?.other ?? 0),
    discounts_given: rupees(sums?.discounts ?? 0),
    online_orders: sums?.online ?? 0,
    top_items: items,
    last_copied_from_shop: copied === null ? null : { date: lkDate(copied), time: lkTime(copied), minutes_ago: Math.max(0, Math.floor((t - copied) / 60_000)) },
  });
};

/** What the GPT's Actions screen imports. Public on purpose: it holds no data and no secret. */
export const openApiSchema = (origin: string) => ({
  openapi: '3.1.0',
  info: { title: 'CheesyBeez shop', version: '1.0.0', description: "Read the owner's pizza shop." },
  servers: [{ url: origin }],
  paths: {
    [`${BASE}/today`]: {
      get: {
        operationId: 'getTodaySales',
        summary: "Today's sales so far",
        description: "Today's orders, takings by payment type, discounts and best-selling items, in Sri Lanka time. Sales reach this copy when the shop PC is online: check last_copied_from_shop and say so if it is old.",
        responses: {
          200: {
            description: "Today's sales",
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                date: { type: 'string', description: 'YYYY-MM-DD' },
                time_now: { type: 'string', description: 'HH:MM' },
                orders: { type: 'integer' },
                total: { type: 'string', description: 'Rupees, already formatted' },
                cash: { type: 'string' },
                bank_transfer: { type: 'string' },
                other_payments: { type: 'string' },
                discounts_given: { type: 'string' },
                online_orders: { type: 'integer' },
                top_items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'integer' } } } },
                last_copied_from_shop: {
                  type: ['object', 'null'],
                  properties: { date: { type: 'string' }, time: { type: 'string' }, minutes_ago: { type: 'integer' } },
                },
              },
            } } },
          },
          401: { description: 'Not signed in' },
        },
      },
    },
  },
});

export async function gptRoutes(req: Request, url: URL, c: GptContext): Promise<Response | null> {
  if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return null;
  const clientSecret = c.clientSecret;
  if (!clientSecret) return json(404, { error: 'server', message: 'not found' }); // switched off
  const route = url.pathname.slice(BASE.length);
  if (route === '/openapi.json' && req.method === 'GET') return json(200, openApiSchema(url.origin));
  if (route === '/authorize' && (req.method === 'GET' || req.method === 'POST')) return authorize(req, url, c);
  if (route === '/token' && req.method === 'POST') return token(req, { ...c, clientSecret });
  if (route === '/today' && req.method === 'GET') return today(req, c);
  return json(404, { error: 'server', message: 'not found' });
}
