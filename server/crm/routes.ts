import { managesRole, type Actor } from '../../src/domain/auth.ts';
import { planImport, type ImportPlan, type KnownCustomer } from '../../src/domain/customerImport.ts';
import { modulesFromEvents, type ModuleEvent } from '../../src/domain/modules.ts';
import { PULL_LIMIT, type ApiError } from '../../src/domain/sync.ts';
import type { Device, EventStore } from '../store.ts';
import { readSheet } from './importFile.ts';
import type { CustomerStore } from './store.ts';

/**
 * The CRM's side of the shop server (/api/v1/crm/…). Answers only while the developers have the
 * module on (modules.ts): off, every route is "no such page", and the data stays. Only the counter
 * PC asks (customer numbers never cross the Wi-Fi to a tablet or the cloud), and only for a manager
 * or the owner signed in on it now, as the server's own session list says.
 */
export class CrmError extends Error {
  readonly status: number;
  readonly code: ApiError['error'];
  constructor(status: number, code: ApiError['error'], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface CrmOptions {
  events: EventStore;
  customers: CustomerStore;
  now?: () => number;
}

export function crmApi({ events, customers, now = Date.now }: CrmOptions) {
  /** Each shop's module changes, read once and then only what is new. */
  const seen = new Map<string, { seq: number; changes: ModuleEvent[] }>();
  const isOn = async (tenantId: string): Promise<boolean> => {
    const had = seen.get(tenantId) ?? { seq: 0, changes: [] };
    for (let after = had.seq;;) {
      const rows = await events.pull(tenantId, after, PULL_LIMIT);
      for (const r of rows) if (r.event.type === 'shop.module_set') had.changes.push(r.event);
      if (rows.length) after = had.seq = rows[rows.length - 1].seq;
      if (rows.length < PULL_LIMIT) break;
    }
    seen.set(tenantId, had);
    return modulesFromEvents(had.changes).crm;
  };

  /** The manager or owner signed in on this counter now; anyone else is refused. */
  const who = async (device: Device, staffId: unknown): Promise<Actor> => {
    if (!(await isOn(device.tenantId))) throw new CrmError(404, 'server', 'no such page');
    if (device.kind !== 'counter') throw new CrmError(403, 'forbidden', 'customers are kept on the shop PC only');
    if (typeof staffId !== 'string' || !staffId) throw new CrmError(401, 'unauthorized', 'sign in first');
    const t = now();
    const session = (await events.sessions(device, [staffId])).find((s) => s.startedAt <= t && t <= s.expiresAt);
    if (!session) throw new CrmError(401, 'unauthorized', 'sign in first');
    if (!managesRole(session.role)) throw new CrmError(403, 'forbidden', 'customers are for managers and the owner');
    const person = (await events.listStaff(device.tenantId)).find((m) => m.id === staffId && m.active);
    if (!person) throw new CrmError(401, 'unauthorized', 'sign in first');
    return { id: person.id, name: person.name, role: session.role };
  };

  const known = async (tenantId: string) =>
    new Map<string, KnownCustomer>((await customers.list(tenantId)).map((c) => [c.phone, { id: c.id, name: c.name }]));

  const plan = async (tenantId: string, name: string, bytes: Buffer, renameExisting: boolean): Promise<ImportPlan> => {
    const sheet = await readSheet(name, bytes);
    if ('reason' in sheet) throw new CrmError(400, 'invalid_event', sheet.reason);
    return planImport(sheet.rows, await known(tenantId), { renameExisting });
  };

  return {
    isOn,

    /** How many customers the shop has (the Customers line, until the list arrives). */
    async count(device: Device, staffId: unknown) {
      await who(device, staffId);
      return { customers: (await customers.list(device.tenantId)).length };
    },

    /** What importing this file would do: nothing is saved. */
    async preview(device: Device, staffId: unknown, name: string, bytes: Buffer, renameExisting: boolean) {
      await who(device, staffId);
      return { plan: await plan(device.tenantId, name, bytes, renameExisting) };
    },

    /**
     * Saves the file: planned again against the list as it is now (so a second Save, or someone
     * else's import in between, never adds anyone twice), then written in one transaction.
     */
    async save(device: Device, staffId: unknown, name: string, bytes: Buffer, renameExisting: boolean) {
      const actor = await who(device, staffId);
      const p = await plan(device.tenantId, name, bytes, renameExisting);
      if (p.error) throw new CrmError(400, 'invalid_event', p.error);
      const saved = await customers.importRows(device.tenantId, p.rows, actor, now());
      return { plan: p, saved, customers: (await customers.list(device.tenantId)).length };
    },
  };
}
export type CrmApi = ReturnType<typeof crmApi>;
