import type { Actor } from './auth.ts';
import type { SyncEvent } from './sync.ts';

/**
 * Modules a shop has: parts of the ERP that are on only where the developers turned them on (the
 * CRM first; a "CRM only" plan may later sell it alone). The owner never switches them: a developer
 * types the developers' password on #unlock on the shop PC (server/modules.ts keeps only its hash),
 * and the shop server records one `shop.module_set`. No device may record one (auth.ts, app.ts), so
 * every screen, the server and the cloud agree which modules are on, and the history says when.
 * Turning a module off keeps its data.
 */

export const MODULES = ['crm'] as const;
export type ModuleId = (typeof MODULES)[number];
export const isModuleId = (v: unknown): v is ModuleId => MODULES.includes(v as never);

export const MODULE_LABEL: Record<ModuleId, string> = { crm: 'Customers (CRM)' };

export type ModuleEvent = {
  id: string;
  shopId: string;
  at: number;
  orderNumber: 0;
  actor: Actor;
  type: 'shop.module_set';
  module: ModuleId;
  on: boolean;
  /** This change's own id (random, 16 hex). */
  codeId: string;
};

export const MODULE_EVENT_TYPES = ['shop.module_set'] as const satisfies readonly ModuleEvent['type'][];

/** Who a module change is filed under: the developers (by their password), never a person at the shop. */
export const DEVELOPERS: Actor = { id: 'developers', name: 'CheesyBeez developers', role: 'owner' };

/** A module change's own id (random, 16 hex), so each one can be told apart in the history. */
export const CODE_ID = /^[0-9a-f]{16}$/;

/** Why this event is not a module change as the server records it, or null (validate.ts). */
export const checkModuleEvent = (e: Record<string, unknown>): string | null => {
  if (!isModuleId(e.module)) return 'unknown module';
  if (typeof e.on !== 'boolean') return 'a module is on or off';
  if (typeof e.codeId !== 'string' || !CODE_ID.test(e.codeId)) return 'a module change names its code';
  if (e.orderNumber !== 0) return 'a module change is not about an order';
  return null;
};

export type ModuleState = Record<ModuleId, boolean>;

/** Which modules are on: the latest change of each wins. All off until the developers turn one on. */
export const modulesFromEvents = (events: readonly SyncEvent[]): ModuleState => {
  const state = Object.fromEntries(MODULES.map((m) => [m, false])) as ModuleState;
  for (const e of events) if (e.type === 'shop.module_set' && isModuleId(e.module)) state[e.module] = e.on;
  return state;
};

/** The latest change of a module, for "on since …". */
export const lastChange = (events: readonly SyncEvent[], module: ModuleId): ModuleEvent | null => {
  let last: ModuleEvent | null = null;
  for (const e of events) if (e.type === 'shop.module_set' && e.module === module) last = e;
  return last;
};
