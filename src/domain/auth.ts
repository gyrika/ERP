/**
 * Who is acting, and what each role may do (SCRUM-40/41). The same rules run
 * on the device (what the screen offers) and on the server (what it accepts),
 * so hiding a button is never the only protection.
 * Implementation: `src/services/auth.ts` picks the real (server) AuthService
 * on a paired device, the fake one in development and the demo.
 */
export type Role = 'cashier' | 'manager' | 'owner' | 'kitchen';

export interface Actor {
  id: string;
  name: string;
  role: Role;
}

export interface AuthService {
  /** The shop this device belongs to. Stamped on every row that syncs. */
  shopId(): string;
  /** Who is signed in at the counter right now (the last person, if the screen just locked). */
  currentCashier(): Actor;
  /** The manager or owner this PIN belongs to, or null (unknown PIN, or not allowed). */
  verifyManagerPin(pin: string): Promise<Actor | null>;
}

/** Managers and owners use manager mode. Menu prices, items and staff are owner-only and not in the app yet. */
export const managesRole = (role: Role): boolean => role === 'manager' || role === 'owner';
export const canManage = (actor: Actor): boolean => managesRole(actor.role);

/** What a cashier records: sending, paying, and the quick Undo straight after either. */
const CASHIER_EVENTS = new Set(['order.sent', 'order.send_undone', 'order.paid', 'order.payment_undone']);
/** Everything else on an order is a manager change (audited). */
const MANAGER_EVENTS = new Set([
  'order.item_changed', 'order.item_cancelled', 'order.line_removed', 'order.line_adjusted',
  'order.discount_set', 'order.comped', 'order.change_undone',
]);

/**
 * May someone with this role record this event? Kitchen taps carry no
 * person (the kitchen screen is shared), so they are checked by device instead.
 */
export const mayRecord = (role: Role, type: string): boolean => {
  if (type.startsWith('kitchen.')) return true;
  if (CASHIER_EVENTS.has(type)) return role !== 'kitchen';
  if (MANAGER_EVENTS.has(type)) return managesRole(role);
  return false;
};

/** Cashiers do not see the day's takings (SCRUM-41). */
export const seesTakings = (role: Role): boolean => managesRole(role);

export const PIN_LENGTH = 4;
