import type { Actor, AuthService } from '../domain/auth.ts';
import { fakeAuth } from '../fake/fakeAuth.ts';

/** THE swap point: replace `fakeAuth` with the real AuthService when logins exist. */
export const auth: AuthService = fakeAuth;

/** The single manager check every screen uses. */
export const requireManager = (pin: string): Promise<Actor | null> => auth.verifyManagerPin(pin);
export const currentCashier = (): Actor => auth.currentCashier();
export const shopId = (): string => auth.shopId();
