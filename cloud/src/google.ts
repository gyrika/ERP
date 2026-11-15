/**
 * "Sign in with Google" on cheesybeez.com (accounts.ts). Google's own button on the page gives an
 * ID token (a signed JWT); the cloud checks it here, with Google's public keys, before trusting who
 * it names. No Google secret is needed: the client id (GOOGLE_CLIENT_ID) is public.
 */
export interface GoogleIdentity { sub: string; email: string | null; name: string | null }
/** Google's current public keys (JWKS). Tests pass their own. */
export type GoogleKeys = () => Promise<JsonWebKey[]>;

const CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const SKEW_S = 60;

let cached: { keys: JsonWebKey[]; until: number } | null = null;

/** Google's keys, kept in memory for as long as Google says they may be (an hour or more). */
export const googleKeys: GoogleKeys = async () => {
  if (cached && cached.until > Date.now()) return cached.keys;
  const r = await fetch(CERTS, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`google keys ${r.status}`);
  const keys = ((await r.json()) as { keys?: JsonWebKey[] }).keys ?? [];
  const maxAge = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control') ?? '')?.[1]) || 3600;
  cached = { keys, until: Date.now() + Math.min(maxAge, 6 * 3600) * 1000 };
  return keys;
};

const part = (s: string): Uint8Array<ArrayBuffer> => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const json = (s: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(part(s))) as Record<string, unknown>;

/**
 * Who the ID token names, or the reason it is refused: a bad shape or signature, another site's
 * token, expired, or an email Google has not checked.
 */
export async function verifyGoogleIdToken(
  token: unknown, clientId: string, keys: GoogleKeys, now: number,
): Promise<GoogleIdentity | { reason: string }> {
  if (typeof token !== 'string' || token.length > 4096) return { reason: 'not a Google sign-in' };
  const bits = token.split('.');
  if (bits.length !== 3) return { reason: 'not a Google sign-in' };
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try { header = json(bits[0]); claims = json(bits[1]); } catch { return { reason: 'not a Google sign-in' }; }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { reason: 'not a Google sign-in' };

  const jwk = (await keys()).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) return { reason: 'Google sign-in could not be checked: please try again' };
  const key = await crypto.subtle.importKey('jwk', { ...jwk, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signed = new TextEncoder().encode(`${bits[0]}.${bits[1]}`);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, part(bits[2]), signed))) return { reason: 'not a Google sign-in' };

  const t = now / 1000;
  if (!ISSUERS.includes(String(claims.iss))) return { reason: 'not a Google sign-in' };
  if (claims.aud !== clientId) return { reason: 'that sign-in is for another site' };
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < t) return { reason: 'that sign-in has expired: please try again' };
  if (typeof claims.iat === 'number' && claims.iat - SKEW_S > t) return { reason: 'not a Google sign-in' };
  if (typeof claims.sub !== 'string' || !/^[\w-]{1,255}$/.test(claims.sub)) return { reason: 'not a Google sign-in' };
  const email = typeof claims.email === 'string' && claims.email_verified === true ? claims.email.slice(0, 254) : null;
  const name = typeof claims.given_name === 'string' ? claims.given_name : typeof claims.name === 'string' ? claims.name : null;
  return { sub: claims.sub, email, name: name ? name.trim().slice(0, 40) || null : null };
}
