/**
 * Who is acting. PLACEHOLDER until real PIN login and roles (SCRUM-40, SCRUM-41):
 * swap `requireManager` and `currentCashier` for the real ones; nothing else
 * should need to change.
 */
export type Role = 'cashier' | 'manager' | 'owner';

export interface Actor {
  id: string;
  name: string;
  role: Role;
}

/** Only managers and owners may change or cancel items already sent to the kitchen. */
export const canChangeSentItems = (actor: Actor): boolean => actor.role === 'manager' || actor.role === 'owner';

/** Dev-only PINs. Not secrets; removed when SCRUM-40/41 land. */
export const DEV_PINS: Record<string, Actor> = {
  '2580': { id: 'dev-manager', name: 'Manager', role: 'manager' },
  '1111': { id: 'dev-cashier', name: 'Nimal', role: 'cashier' },
};

export const currentCashier = (): Actor => DEV_PINS['1111'];

/**
 * The single manager check. Resolves to the manager or owner the PIN belongs
 * to, or null for an unknown PIN or a PIN without the right role. Async so the
 * real version can ask the server.
 */
export async function requireManager(pin: string): Promise<Actor | null> {
  const actor = DEV_PINS[pin];
  return actor && canChangeSentItems(actor) ? actor : null;
}
