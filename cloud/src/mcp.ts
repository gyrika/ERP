import { lkDate, lkTime } from '../../src/domain/salesLedger.ts';
import type { D1Like } from './cloud.ts';
import { json, randomToken, sha256Hex } from './http.ts';

/**
 * The owner's ChatGPT plugin (SCRUM-197): an MCP server that lets ChatGPT read the shop for him.
 *
 * MCP is JSON-RPC over HTTP; this server keeps no session, so it is a plain POST to /mcp, written
 * by hand because a few methods do not justify a dependency in the Worker. Looking at the server
 * and listing its tools work without a token and hold no shop data; a tool call without a token
 * answers with a sign-in challenge. ChatGPT signs in with OAuth (authorization code + PKCE): an
 * empty POST gets a 401 pointing at the /.well-known documents, it registers, and sends him to
 * /authorize, where he pastes his owner link. Its tokens stop when his owner device is removed,
 * and read the shop through /mcp only. Off unless MCP_ENABLED is "1".
 *
 * Whatever a tool answers goes to OpenAI, so answers hold totals and menu item names only: never
 * customers, staff, order numbers or anything else that identifies a person.
 */
export const MCP_CLIENT_ID = 'cheesybeez-chatgpt';
export const MCP_SCOPE = 'sales.read';
/** No handshake: each request says its version in _meta. */
const MODERN_VERSION = '2026-07-28';
/** With the initialize handshake. */
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const ALL_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
const SERVER_INFO = { name: 'cheesybeez', title: 'CheesyBeez', version: '1.0.0' };
const INSTRUCTIONS = "Answers the owner's questions about his shop. Use only the numbers the tools return.";
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const CODE_MS = 5 * 60_000;
const ACCESS_S = 3600;
const REFRESH_MS = 90 * 24 * 3_600_000;
const TOP_ITEMS = 10;
const OAUTH = '/api/v1/mcp';
const RESOURCE_METADATA = '/.well-known/oauth-protected-resource';
const AUTH_METADATA = '/.well-known/oauth-authorization-server';

export interface McpContext {
  db: D1Like;
  now: () => number;
  enabled?: boolean;
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
<p>ChatGPT will read today's sales: totals and which items sold. It cannot change anything. OpenAI keeps what it reads in your chat history.</p>
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

/** An owner device that still exists: ChatGPT's access lives only as long as the phone that approved it. */
const OWNER_DEVICE = `EXISTS (SELECT 1 FROM devices d WHERE d.id = l.device_id AND d.tenant_id = l.tenant_id AND d.kind = 'owner')`;

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
      WHERE refresh_hash = ? AND refresh_expires_at > ? AND ${OWNER_DEVICE}`)
      .bind(await sha256Hex(access), await sha256Hex(refresh), t + ACCESS_S * 1000, t + REFRESH_MS, await sha256Hex(String(form.get('refresh_token') ?? '')), t).run();
    return done.meta.changes === 1 ? answer() : oauthError(400, 'invalid_grant');
  }
  return oauthError(400, 'unsupported_grant_type');
};

/** Today in the shop, in Sri Lanka time: payments that still stand. */
export const todaySales = async (db: D1Like, tenantId: string, t: number) => {
  const date = lkDate(t);
  const sums = await db.prepare(`SELECT COUNT(*) AS orders,
      COALESCE(SUM(total), 0) AS total,
      COALESCE(SUM(CASE WHEN tender = 'cash' THEN total ELSE 0 END), 0) AS cash,
      COALESCE(SUM(CASE WHEN tender = 'transfer' THEN total ELSE 0 END), 0) AS transfer,
      COALESCE(SUM(CASE WHEN tender NOT IN ('cash', 'transfer') THEN total ELSE 0 END), 0) AS other,
      COALESCE(SUM(discount), 0) AS discounts,
      COALESCE(SUM(online), 0) AS online
    FROM sales WHERE tenant_id = ? AND sale_date = ? AND status = 'paid'`).bind(tenantId, date)
    .first<{ orders: number; total: number; cash: number; transfer: number; other: number; discounts: number; online: number }>();
  const { results: items } = await db.prepare(`SELECT i.item_name AS name, SUM(i.qty) AS qty
    FROM sale_items i JOIN sales s ON s.id = i.sale_id
    WHERE s.tenant_id = ? AND i.tenant_id = ? AND s.sale_date = ? AND s.status = 'paid'
    GROUP BY i.item_name ORDER BY qty DESC, name LIMIT ?`).bind(tenantId, tenantId, date, TOP_ITEMS).all<{ name: string; qty: number }>();
  const copied = (await db.prepare('SELECT MAX(copied_at) AS at FROM events WHERE tenant_id = ?').bind(tenantId).first<{ at: number | null }>())?.at ?? null;
  return {
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
  };
};

const TOOLS = [{
  name: 'get_today_sales',
  title: "Today's sales",
  description: "Today's orders, takings by payment type, discounts and best-selling items at the owner's shop, in Sri Lanka time. Sales arrive when the shop PC is online: check last_copied_from_shop and say so if it is old.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: {
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
      top_items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'integer' } }, required: ['name', 'qty'] } },
      last_copied_from_shop: {
        type: ['object', 'null'],
        properties: { date: { type: 'string' }, time: { type: 'string' }, minutes_ago: { type: 'integer' } },
      },
    },
    required: ['date', 'time_now', 'orders', 'total', 'cash', 'bank_transfer', 'other_payments', 'discounts_given', 'online_orders', 'top_items', 'last_copied_from_shop'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  securitySchemes: [{ type: 'oauth2', scopes: [MCP_SCOPE] }],
}];

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
    ? await c.db.prepare(`SELECT l.tenant_id FROM mcp_links l WHERE l.access_hash = ? AND l.access_expires_at > ? AND ${OWNER_DEVICE}`)
      .bind(await sha256Hex(bearer), t).first<{ tenant_id: string }>()
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
      if (params?.name !== 'get_today_sales') return rpcError(id, -32602, 'unknown tool');
      // The only place shop data is read, and the sign-in challenge ChatGPT shows its linking screen for.
      if (!link) {
        return rpcResult(id, {
          content: [{ type: 'text', text: 'Sign in to your shop first.' }],
          isError: true,
          _meta: { 'mcp/www_authenticate': [`Bearer resource_metadata="${metadata}", error="insufficient_scope", error_description="Sign in to your shop to continue"`] },
        });
      }
      const sales = await todaySales(c.db, link.tenant_id, t);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(sales) }], structuredContent: sales, isError: false });
    }
    default: return rpcError(id, -32601, 'method not found', params?._meta ? 404 : 200);
  }
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
  return json(404, { error: 'server', message: 'not found' });
}
