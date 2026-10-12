import type { Actor, AuthService } from '../domain/auth.ts';
import type { LoginRequest, LoginResponse } from '../domain/sync.ts';
import { FAKE_SHOP_ID } from '../fake/data.ts';
import { pairedShop, syncToken } from './pairing.ts';

/**
 * The real AuthService on a paired device (SCRUM-40/41): PINs are checked by
 * the server on the counter PC, which also records the login so it can check
 * every order event against it. Nothing about staff or PINs is kept here.
 * A reload or a power cut asks for the PIN again.
 */
export type LoginResult = 'ok' | 'wrong' | 'wait' | 'offline';

let current: { actor: Actor; until: number } | null = null;
let last: Actor | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

const post = (req: LoginRequest): Promise<Response> =>
  fetch('/api/v1/login', {
    method: 'POST',
    headers: { authorization: `Bearer ${syncToken() ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(8000),
  });

/** Server time → this device's clock, so the session ends on time even if the clocks differ. */
const localUntil = (r: LoginResponse): number => r.expiresAt - r.serverTime + Date.now();

export const lock = (): void => {
  clearTimeout(expiry);
  if (!current) return;
  current = null;
  notify();
};

export async function login(pin: string): Promise<LoginResult> {
  let r: Response;
  try { r = await post({ pin, purpose: 'shift' }); } catch { return 'offline'; }
  if (r.status === 429) return 'wait';
  if (!r.ok) return r.status === 401 ? 'wrong' : 'offline';
  const body = (await r.json()) as LoginResponse;
  current = { actor: body.actor, until: localUntil(body) };
  last = body.actor;
  clearTimeout(expiry);
  expiry = setTimeout(lock, Math.max(0, current.until - Date.now()));
  notify();
  return 'ok';
}

/** Who is logged in now; null = locked. */
export const signedIn = (): Actor | null => current?.actor ?? null;

export const subscribeAuth = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const serverAuth: AuthService = {
  shopId: () => pairedShop() ?? FAKE_SHOP_ID,
  currentCashier() {
    const who = current?.actor ?? last;
    if (!who) throw new Error('Nobody is logged in');
    return who;
  },
  async verifyManagerPin(pin) {
    try {
      const r = await post({ pin, purpose: 'manager' });
      return r.ok ? ((await r.json()) as LoginResponse).actor : null;
    } catch {
      return null;
    }
  },
};
