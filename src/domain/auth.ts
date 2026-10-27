/**
 * Who is acting, and what each role may do (SCRUM-40/41). The same rules run
 * on the device (what the screen offers) and on the server (what it accepts),
 * so hiding a button is never the only protection.
 * Implementation: `src/services/auth.ts` picks the real (server) AuthService
 * on a paired device, the fake one in development and the demo.
 */
export type Role = 'cashier' | 'manager' | 'owner' | 'kitchen' | 'vision';

/**
 * The roles a person can have: who can be added as staff and sign in with a PIN. `vision` is not one:
 * it is the shop server's own stamp on what the camera worker saw (SCRUM-167).
 */
export const STAFF_ROLES = ['cashier', 'manager', 'owner', 'kitchen'] as const satisfies readonly Role[];
export const isStaffRole = (role: unknown): role is (typeof STAFF_ROLES)[number] => STAFF_ROLES.includes(role as never);

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

/** Managers and owners use manager mode. Menu prices, names and staff are owner-only. */
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
/**
 * Stock decisions that are the owner's alone: which items are counted when (SCRUM-90),
 * checking a count's gap (SCRUM-95; answering is a manager's), what receiving is counted in (SCRUM-96), the stock rules' numbers,
 * an item's "Order when below" (SCRUM-135), and the warehouses (SCRUM-184).
 */
export const OWNER_STOCK: ReadonlySet<string> = new Set(['stock.tier_set', 'stock.gap_reviewed', 'stock.receive_unit_set', 'stock.settings_set', 'stock.limit_set',
  // The warehouses themselves and which is next to the kitchen (SCRUM-184); homes and moves are a manager's.
  'stock.warehouse_set', 'stock.kitchen_side_set']);

/** What the cameras see (SCRUM-167): only the camera worker records it, and it records nothing else. */
export const VISION_RECORDS: ReadonlySet<string> = new Set([
  'table.state_changed', 'table.alert_raised', 'table.alert_cleared', 'vision.camera_offline', 'vision.camera_online', 'vision.heartbeat',
]);
/** The floor plan and the cameras' setup: the owner's (SCRUM-171 sets them up). */
const OWNER_FLOOR = new Set(['table.layout_set', 'vision.cameras_set', 'vision.zones_set', 'vision.settings_set']);

/**
 * A kitchen Remake (SCRUM-177) or its Undo: waste tied to a kitchen ticket. Whoever is signed in
 * records it, like a kitchen tap, so a burnt pizza is never left out; the bin stays a manager's.
 */
export const isRemake = (e: { type: string; ticketId?: unknown }): boolean =>
  (e.type === 'stock.wasted' || e.type === 'stock.waste_undone') && typeof e.ticketId === 'string' && e.ticketId.length > 0;

/** `remake`: the event is a kitchen Remake (isRemake). */
export const mayRecord = (role: Role, type: string, remake = false): boolean => {
  if (role === 'vision') return VISION_RECORDS.has(type);
  if (VISION_RECORDS.has(type)) return false;
  // Marking a table cleaned, reserved or free on the floor, and its Undo: whoever works the counter.
  if (type === 'table.state_set' || type === 'table.state_set_undone') return role !== 'kitchen';
  if (OWNER_FLOOR.has(type)) return role === 'owner';
  if (type.startsWith('kitchen.')) return true;
  if (remake) return true;
  // Sending prep to the kitchen: whoever is signed in (SCRUM-136); the "make more" amount is a manager's.
  if (type === 'prep.ordered' || type === 'prep.order_undone') return true;
  if (type === 'prep.limit_set') return managesRole(role);
  if (CASHIER_EVENTS.has(type)) return role !== 'kitchen';
  // What the shorthand parser could not read (SCRUM-143): whoever types orders at the counter.
  if (type === 'shorthand.missed') return role !== 'kitchen';
  if (MANAGER_EVENTS.has(type)) return managesRole(role);
  // Which items are counted daily, weekly or monthly: the owner's choice (SCRUM-90).
  if (OWNER_STOCK.has(type)) return role === 'owner';
  // Stock counts and supplier prices are a manager's job (SCRUM-41).
  if (type.startsWith('stock.')) return managesRole(role);
  // The menu is the owner's; marking something sold out is a manager's job during service.
  if (type === 'menu.item_set' || type === 'menu.item_added') return role === 'owner';
  // Answers about his recipes and costs, and opening his recipes: the owner's (SCRUM-77).
  if (type === 'recipe.answer_set' || type === 'recipe.viewed' || type === 'recipe.draft_set') return role === 'owner';
  if (type === 'menu.sold_out') return managesRole(role);
  return false;
};

/** Inventory and suppliers: managers and owners only (SCRUM-41). */
export const managesStock = (role: Role): boolean => managesRole(role);

/** Cashiers do not see the day's takings (SCRUM-41). */
export const seesTakings = (role: Role): boolean => managesRole(role);

export const PIN_LENGTH = 4;
