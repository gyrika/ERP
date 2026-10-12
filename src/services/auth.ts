import type { Actor, AuthService } from '../domain/auth.ts';
import { fakeAuth } from '../fake/fakeAuth.ts';
import { syncToken } from './pairing.ts';
import { serverAuth } from './serverAuth.ts';

/**
 * THE swap point. A device paired with the server uses real PIN logins and
 * roles (`serverAuth`); development and the demo keep the fake staff, with
 * no lock screen.
 */
export const usesLogin = (): boolean => syncToken() !== null;
const auth = (): AuthService => (usesLogin() ? serverAuth : fakeAuth);

/** The single manager check every screen uses. */
export const requireManager = (pin: string): Promise<Actor | null> => auth().verifyManagerPin(pin);
export const currentCashier = (): Actor => auth().currentCashier();
export const shopId = (): string => auth().shopId();
