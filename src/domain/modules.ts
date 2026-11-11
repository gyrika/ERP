import type { Actor } from './auth.ts';
import type { SyncEvent } from './sync.ts';

/**
 * Modules a shop has: parts of the ERP that are on only where the developers turned them on (the
 * CRM first; a "CRM only" plan may later sell it alone). The owner never switches them: a developer
 * gives the shop a one-time code, signed with the developers' private key, and the shop server
 * checks it and records one `shop.module_set`. No device may record one (auth.ts, app.ts), so every
 * screen, the server and the cloud agree which modules are on, and the history says when and by
 * which code. Turning a module off keeps its data.
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
  /** The code that did it: each code works once. */
  codeId: string;
};

export const MODULE_EVENT_TYPES = ['shop.module_set'] as const satisfies readonly ModuleEvent['type'][];

/** Who a module change is filed under: the developers, through their signed code, never a person at the shop. */
export const DEVELOPERS: Actor = { id: 'developers', name: 'CheesyBeez developers', role: 'owner' };

/**
 * What a code grants. Signed as it is; the shop server refuses a code for another shop, one already
 * used, or one past `until`.
 */
export interface ModuleGrant {
  v: 1;
  shop: string;
  module: ModuleId;
  on: boolean;
  /** Random, 16 hex: the code's own id. */
  id: string;
  /** Last moment the code may be used (ms). */
  until: number;
}

export const CODE_ID = /^[0-9a-f]{16}$/;

/** Why a grant is not readable, or null. */
export const checkGrant = (g: unknown): string | null => {
  if (typeof g !== 'object' || g === null) return 'not a module code';
  const r = g as Record<string, unknown>;
  if (r.v !== 1) return 'a code from a newer version: update the shop first';
  if (typeof r.shop !== 'string' || !/^[a-z0-9-]{1,64}$/.test(r.shop)) return 'the code names no shop';
  if (!isModuleId(r.module)) return 'the code names a module this version does not have';
  if (typeof r.on !== 'boolean') return 'the code says neither on nor off';
  if (typeof r.id !== 'string' || !CODE_ID.test(r.id)) return 'the code has no id';
  if (!Number.isSafeInteger(r.until)) return 'the code has no end date';
  return null;
};

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

/** The codes already used here: none works twice. */
export const usedCodes = (events: readonly SyncEvent[]): Set<string> =>
  new Set(events.filter((e): e is ModuleEvent => e.type === 'shop.module_set').map((e) => e.codeId));

/** The latest change of a module, for "on since …". */
export const lastChange = (events: readonly SyncEvent[], module: ModuleId): ModuleEvent | null => {
  let last: ModuleEvent | null = null;
  for (const e of events) if (e.type === 'shop.module_set' && e.module === module) last = e;
  return last;
};
