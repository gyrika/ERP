import {
  checkAddress, checkProfile, MAX_ADDRESSES, PAST_ORDERS, sameAddress,
  type Account, type PastOrder, type Profile, type SavedAddress,
} from '../../src/domain/accounts.ts';
import { effectiveStatus, type CheckedOnlineOrder, type DeliveryPin, type OnlineKind, type OnlineLine, type OnlineStatus } from '../../src/domain/online.ts';
import type { D1Like } from './cloud.ts';
import { verifyGoogleIdToken, type GoogleKeys } from './google.ts';
import { HttpError, json, randomToken, sha256Hex } from './http.ts';
import { lookupHash, seal, unseal, type SealKeys } from './seal.ts';

/**
 * Customer accounts on cheesybeez.com (src/domain/accounts.ts has the rules). The cloud is their
 * master copy (owner, 2026-11-16): customers sign in and change them from anywhere, while the shop
 * PC may be off. Signed in with Google (no SMS: no paid channel); a session is an HttpOnly cookie
 * whose token is kept here only as a hash. Name, phone, email and addresses are sealed (seal.ts).
 *
 * Off (every route 404, the page shows no Sign in) until both GOOGLE_CLIENT_ID and PROFILE_KEY are set.
 */
export interface AccountsContext {
  db: D1Like;
  now: () => number;
  /** The shop cheesybeez.com is for (wrangler.toml ORDER_SHOP): accounts are that shop's customers. */
  orderShop?: string;
  /** The page's Google sign-in client id (wrangler.toml GOOGLE_CLIENT_ID, public). */
  googleClientId?: string;
  /** From the PROFILE_KEY secret (seal.ts sealKeys); null = accounts off. */
  keys: SealKeys | null;
  googleKeys: GoogleKeys;
}

const DAY = 86_400_000;
export const SESSION_MS = 90 * DAY;
export const SESSION_COOKIE = 'cb_session';
const MAX_SIGNINS_PER_IP_HOUR = 20;

interface AccountRow { id: string; tenant_id: string; profile: string }
interface AddressRow { id: string; body: string; last_used_at: number }
interface OrderRow { id: string; created_at: number; kind: OnlineKind; status: OnlineStatus; body: string; total: number; order_number: number | null }

const cookieOf = (req: Request, name: string): string | null => {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
};

const sessionCookie = (token: string, maxAgeS: number) =>
  `${SESSION_COOKIE}=${token}; Path=/api/; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Lax`;

const body = async (req: Request): Promise<Record<string, unknown>> => {
  try { const b = await req.json(); return typeof b === 'object' && b !== null ? b as Record<string, unknown> : {}; } catch { return {}; }
};

export function createAccounts(c: AccountsContext) {
  const { db, now } = c;
  const on = Boolean(c.keys && c.googleClientId && c.orderShop);
  const keys = () => {
    if (!on) throw new HttpError(404, 'server', 'accounts are not on');
    return c.keys!;
  };
  const tenant = () => c.orderShop!;

  const profileOf = (row: AccountRow) => unseal<Profile>(keys(), row.profile, `profile:${row.id}`);
  const saveProfile = async (id: string, p: Profile) => db.prepare('UPDATE customer_accounts SET profile = ?, phone_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await seal(keys(), p, `profile:${id}`), p.phone ? await lookupHash(keys(), 'phone', p.phone) : null, now(), id).run();
  const addressBody = (id: string, accountId: string) => `address:${id}:${accountId}`;

  /** The signed-in account's id, or null (no cookie, an unknown or expired one, or accounts off). */
  const signedIn = async (req: Request): Promise<string | null> => {
    if (!on) return null;
    const token = cookieOf(req, SESSION_COOKIE);
    if (!token || token.length > 64) return null;
    const row = await db.prepare('SELECT account_id FROM customer_sessions WHERE token_hash = ? AND tenant_id = ? AND expires_at > ?')
      .bind(await sha256Hex(token), tenant(), now()).first<{ account_id: string }>();
    return row?.account_id ?? null;
  };
  const mustSignIn = async (req: Request): Promise<AccountRow> => {
    const id = await signedIn(req);
    const row = id ? await db.prepare('SELECT id, tenant_id, profile FROM customer_accounts WHERE id = ? AND tenant_id = ?').bind(id, tenant()).first<AccountRow>() : null;
    if (!row) throw new HttpError(401, 'unauthorized', 'please sign in again');
    return row;
  };

  const addressesOf = async (accountId: string): Promise<SavedAddress[]> => {
    const { results } = await db.prepare('SELECT id, body, last_used_at FROM customer_addresses WHERE account_id = ? ORDER BY last_used_at DESC')
      .bind(accountId).all<AddressRow>();
    return Promise.all(results.map(async (r) => ({
      id: r.id, lastUsedAt: r.last_used_at,
      ...await unseal<{ label: string; address: string; pin: DeliveryPin | null }>(keys(), r.body, addressBody(r.id, accountId)),
    })));
  };
  const ordersOf = async (accountId: string, limit: number): Promise<PastOrder[]> => {
    const { results } = await db.prepare(
      'SELECT id, created_at, kind, status, body, total, order_number FROM online_orders WHERE account_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(accountId, tenant(), limit).all<OrderRow>();
    return results.map((r) => ({
      id: r.id, createdAt: r.created_at, kind: r.kind, status: effectiveStatus({ status: r.status, createdAt: r.created_at }, now()),
      lines: (JSON.parse(r.body) as { lines: OnlineLine[] }).lines, total: r.total, orderNumber: r.order_number,
    }));
  };
  const view = async (row: AccountRow): Promise<Account> => ({
    profile: await profileOf(row), addresses: await addressesOf(row.id), orders: await ordersOf(row.id, PAST_ORDERS),
  });

  /** Saves a delivery address: the same words update that one, a new place pushes out the one used longest ago. */
  const keepAddress = async (accountId: string, a: { label?: string; address: string; pin: DeliveryPin | null }, id?: string) => {
    const t = now();
    const all = await addressesOf(accountId);
    const hit = id ? all.find((x) => x.id === id) : all.find((x) => sameAddress(x.address, a.address));
    if (id && !hit) throw new HttpError(404, 'server', 'that address is not saved');
    const keepId = hit?.id ?? `adr-${randomToken(9)}`;
    const value = { label: a.label ?? hit?.label ?? '', address: a.address, pin: a.pin ?? hit?.pin ?? null };
    const sealed = await seal(keys(), value, addressBody(keepId, accountId));
    if (hit) {
      await db.prepare('UPDATE customer_addresses SET body = ?, last_used_at = ? WHERE id = ? AND account_id = ?').bind(sealed, t, keepId, accountId).run();
      return;
    }
    const oldest = all.slice(MAX_ADDRESSES - 1).map((x) => x.id);
    await db.batch([
      ...oldest.map((old) => db.prepare('DELETE FROM customer_addresses WHERE id = ? AND account_id = ?').bind(old, accountId)),
      db.prepare('INSERT INTO customer_addresses (id, account_id, tenant_id, body, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(keepId, accountId, tenant(), sealed, t, t),
    ]);
  };

  /**
   * An order placed while signed in fills the account by itself: the name and phone if it has none
   * yet, and a delivery's address and pin (so the next delivery is one tap). Never blocks the order.
   */
  const afterOrder = async (accountId: string, o: CheckedOnlineOrder): Promise<void> => {
    const row = await db.prepare('SELECT id, tenant_id, profile FROM customer_accounts WHERE id = ?').bind(accountId).first<AccountRow>();
    if (!row) return;
    const p = await profileOf(row);
    if (!p.name || !p.phone) await saveProfile(row.id, { ...p, name: p.name || o.name, phone: p.phone || o.phone });
    if (o.kind === 'delivery' && o.address) await keepAddress(row.id, { address: o.address, pin: o.pin });
  };

  const routes = async (req: Request, url: URL): Promise<Response | null> => {
    const path = url.pathname;
    if (path !== '/api/v1/account' && !path.startsWith('/api/v1/account/')) return null;
    // A browser always says where a POST comes from: only this site's own page may change an account.
    const origin = req.headers.get('origin');
    if (req.method !== 'GET' && origin && origin !== url.origin) throw new HttpError(403, 'forbidden', 'not from this site');

    if (path === '/api/v1/account' && req.method === 'GET') {
      if (!on) return json(200, { google: null, account: null });
      const id = await signedIn(req);
      const row = id ? await db.prepare('SELECT id, tenant_id, profile FROM customer_accounts WHERE id = ?').bind(id).first<AccountRow>() : null;
      return json(200, { google: c.googleClientId, account: row ? await view(row) : null });
    }

    if (path === '/api/v1/account/google' && req.method === 'POST') {
      keys();
      const b = await body(req);
      const who = await verifyGoogleIdToken(b.credential, c.googleClientId!, c.googleKeys, now());
      if ('reason' in who) throw new HttpError(401, 'unauthorized', who.reason);
      const t = now();
      const ip = await sha256Hex(`cb-account:${req.headers.get('cf-connecting-ip') ?? 'unknown'}`);
      const tries = await db.prepare('SELECT COUNT(*) AS n FROM customer_sessions WHERE ip_hash = ? AND created_at > ?').bind(ip, t - 3_600_000).first<{ n: number }>();
      if ((tries?.n ?? 0) >= MAX_SIGNINS_PER_IP_HOUR) throw new HttpError(429, 'too_many', 'too many sign-ins from here: please wait a while');
      const googleHash = await lookupHash(keys(), 'google', who.sub);
      let row = await db.prepare('SELECT id, tenant_id, profile FROM customer_accounts WHERE tenant_id = ? AND google_hash = ?')
        .bind(tenant(), googleHash).first<AccountRow>();
      if (!row) {
        const id = `acc-${randomToken(12)}`;
        const profile = await seal(keys(), { name: who.name ?? '', phone: '', email: who.email } satisfies Profile, `profile:${id}`);
        await db.prepare('INSERT INTO customer_accounts (id, tenant_id, google_hash, phone_hash, profile, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)')
          .bind(id, tenant(), googleHash, profile, t, t).run();
        row = { id, tenant_id: tenant(), profile };
      } else {
        const p = await profileOf(row);
        if (who.email && p.email !== who.email) await saveProfile(row.id, { ...p, email: who.email });
      }
      const token = randomToken(32);
      await db.batch([
        db.prepare('DELETE FROM customer_sessions WHERE account_id = ? AND expires_at < ?').bind(row.id, t),
        db.prepare('INSERT INTO customer_sessions (token_hash, account_id, tenant_id, ip_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(await sha256Hex(token), row.id, tenant(), ip, t, t + SESSION_MS),
      ]);
      const r = json(200, { account: await view((await db.prepare('SELECT id, tenant_id, profile FROM customer_accounts WHERE id = ?').bind(row.id).first<AccountRow>())!) });
      r.headers.append('set-cookie', sessionCookie(token, SESSION_MS / 1000));
      return r;
    }

    if (path === '/api/v1/account/sign-out' && req.method === 'POST') {
      keys();
      const token = cookieOf(req, SESSION_COOKIE);
      const everywhere = (await body(req)).everywhere === true;
      const id = await signedIn(req);
      if (id && everywhere) await db.prepare('DELETE FROM customer_sessions WHERE account_id = ?').bind(id).run();
      else if (token) await db.prepare('DELETE FROM customer_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
      const r = json(200, { ok: true });
      r.headers.append('set-cookie', sessionCookie('', 0));
      return r;
    }

    if (path === '/api/v1/account/profile' && req.method === 'POST') {
      const row = await mustSignIn(req);
      const checked = checkProfile(await body(req));
      if ('reason' in checked) throw new HttpError(400, 'invalid_event', checked.reason);
      await saveProfile(row.id, { ...await profileOf(row), ...checked });
      return json(200, { account: await view((await db.prepare('SELECT id, tenant_id, profile FROM customer_accounts WHERE id = ?').bind(row.id).first<AccountRow>())!) });
    }

    if (path === '/api/v1/account/addresses' && req.method === 'POST') {
      const row = await mustSignIn(req);
      const b = await body(req);
      const checked = checkAddress(b);
      if ('reason' in checked) throw new HttpError(400, 'invalid_event', checked.reason);
      await keepAddress(row.id, checked, typeof b.id === 'string' ? b.id : undefined);
      return json(200, { account: await view(row) });
    }

    if (path === '/api/v1/account/addresses/remove' && req.method === 'POST') {
      const row = await mustSignIn(req);
      const id = (await body(req)).id;
      if (typeof id !== 'string') throw new HttpError(400, 'invalid_event', 'which address?');
      await db.prepare('DELETE FROM customer_addresses WHERE id = ? AND account_id = ?').bind(id, row.id).run();
      return json(200, { account: await view(row) });
    }

    // Data protection (PDPA): everything kept about them, as a file, and erasing it all themselves.
    if (path === '/api/v1/account/export' && req.method === 'GET') {
      const row = await mustSignIn(req);
      const created = await db.prepare('SELECT created_at FROM customer_accounts WHERE id = ?').bind(row.id).first<{ created_at: number }>();
      const sessions = await db.prepare('SELECT created_at, expires_at FROM customer_sessions WHERE account_id = ? ORDER BY created_at').bind(row.id)
        .all<{ created_at: number; expires_at: number }>();
      const file = {
        shop: 'CheesyBeez', exportedAt: new Date(now()).toISOString(), accountCreatedAt: new Date(created?.created_at ?? 0).toISOString(),
        profile: await profileOf(row), addresses: await addressesOf(row.id), orders: await ordersOf(row.id, 1000),
        signedIn: sessions.results.map((s) => ({ since: new Date(s.created_at).toISOString(), until: new Date(s.expires_at).toISOString() })),
      };
      return new Response(JSON.stringify(file, null, 2), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="cheesybeez-my-data.json"' },
      });
    }

    if (path === '/api/v1/account/delete' && req.method === 'POST') {
      const row = await mustSignIn(req);
      // Past orders stay in the shop's books, but no longer point to anyone.
      await db.batch([
        db.prepare('UPDATE online_orders SET account_id = NULL WHERE account_id = ?').bind(row.id),
        db.prepare('DELETE FROM customer_sessions WHERE account_id = ?').bind(row.id),
        db.prepare('DELETE FROM customer_addresses WHERE account_id = ?').bind(row.id),
        db.prepare('DELETE FROM customer_accounts WHERE id = ?').bind(row.id),
      ]);
      const r = json(200, { deleted: true });
      r.headers.append('set-cookie', sessionCookie('', 0));
      return r;
    }

    throw new HttpError(404, 'server', 'no such endpoint');
  };

  return { on, routes, signedIn, afterOrder };
}

export type Accounts = ReturnType<typeof createAccounts>;
