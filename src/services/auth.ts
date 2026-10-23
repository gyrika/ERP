import type { Actor, AuthService } from '../domain/auth.ts';
import { fakeAuth } from '../fake/fakeAuth.ts';
import { phoneToken, syncToken } from './pairing.ts';
import { phoneAuth } from './managerPhone.ts';
import { serverAuth } from './serverAuth.ts';

/**
 * THE swap point. A device paired with the server uses real PIN logins and
 * roles (`serverAuth`); development and the demo keep the fake staff, with
 * no lock screen.
 */
export const usesLogin = (): boolean => syncToken() !== null;
// The phone apps sign with the person the phone was made for (SCRUM-94/95).
const auth = (): AuthService => (phoneToken() ? phoneAuth : usesLogin() ? serverAuth : fakeAuth);

/** The single manager check every screen uses. */
export const requireManager = (pin: string): Promise<Actor | null> => auth().verifyManagerPin(pin);
/** The owner this PIN belongs to, or null (the Recipes screen: the shop's secret). */
export const requireOwner = async (pin: string): Promise<Actor | null> => {
  const actor = await requireManager(pin);
  return actor?.role === 'owner' ? actor : null;
};
/** No server to number documents: only the demo and development, never a paired device or a phone. */
export const numbersLocally = (): boolean => syncToken() === null && !phoneToken();
export const currentCashier = (): Actor => auth().currentCashier();
export const shopId = (): string => auth().shopId();
