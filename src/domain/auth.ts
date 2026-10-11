/**
 * Who is acting, and the one interface that answers it. Real PIN login and
 * roles arrive with the server work (sprint 3, SCRUM-40/41): implement
 * AuthService for real and swap it in `src/services/auth.ts`. Nothing else
 * should need to change.
 */
export type Role = 'cashier' | 'manager' | 'owner';

export interface Actor {
  id: string;
  name: string;
  role: Role;
}

export interface AuthService {
  /** The shop this device belongs to. Stamped on every row that syncs. */
  shopId(): string;
  /** Who is signed in at the counter right now. */
  currentCashier(): Actor;
  /** The manager or owner this PIN belongs to, or null (unknown PIN, or not allowed). */
  verifyManagerPin(pin: string): Promise<Actor | null>;
}

/** Only managers and owners may use manager mode. Menu prices, items and staff are owner-only and not in the app yet. */
export const canManage = (actor: Actor): boolean => actor.role === 'manager' || actor.role === 'owner';
