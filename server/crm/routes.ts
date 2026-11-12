import { randomUUID } from 'node:crypto';
import { managesRole, type Actor } from '../../src/domain/auth.ts';
import { checkMessage, isAudience, type CampaignEvent } from '../../src/domain/campaigns.ts';
import { cleanName, planImport, type ImportPlan, type KnownCustomer } from '../../src/domain/customerImport.ts';
import { isCustomerId, type Customer } from '../../src/domain/customers.ts';
import { modulesFromEvents } from '../../src/domain/modules.ts';
import { toLkMobile } from '../../src/domain/phone.ts';
import { PULL_LIMIT, type ApiError, type SyncEvent } from '../../src/domain/sync.ts';
import type { Device, EventStore } from '../store.ts';
import { readSheet } from './importFile.ts';
import { createPush, PushError, type Push } from './push.ts';
import type { CustomerStore } from './store.ts';
import type { Vapid } from './webpush.ts';

/**
 * The CRM's side of the shop server (/api/v1/crm/…). Answers only while the developers have the
 * module on (modules.ts): off, every route is "no such page", and the data stays. Only the counter
 * PC asks (customer numbers never cross the Wi-Fi to a tablet or the cloud), as the person signed in
 * on it now, by the server's own session list: managers and the owner for the list, anyone at the
 * counter for the number at Charge, the owner alone for campaigns.
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
  /** The shop's VAPID pair (webpush.ts); without it campaigns cannot be sent. */
  vapid?: () => Promise<Vapid>;
  /** Stores the server's own events (campaign records) and streams them (app.ts ingest). */
  ingest?: (device: Device, events: SyncEvent[]) => Promise<unknown>;
  fetch?: typeof fetch;
  now?: () => number;
}

type Who = 'counter' | 'manager' | 'owner';

export function crmApi({ events, customers, vapid, ingest, fetch, now = Date.now }: CrmOptions) {
  /** Each shop's history, read once and then only what is new (segments, visits, module state). */
  const logs = new Map<string, { seq: number; events: SyncEvent[] }>();
  const history = async (tenantId: string): Promise<SyncEvent[]> => {
    const had = logs.get(tenantId) ?? { seq: 0, events: [] };
    for (let after = had.seq;;) {
      const rows = await events.pull(tenantId, after, PULL_LIMIT);
      for (const r of rows) had.events.push(r.event);
      if (rows.length) after = had.seq = rows[rows.length - 1].seq;
      if (rows.length < PULL_LIMIT) break;
    }
    logs.set(tenantId, had);
    return had.events;
  };
  const isOn = async (tenantId: string) => modulesFromEvents(await history(tenantId)).crm;

  const push: Push | null = vapid && ingest ? createPush({ customers, history, vapid, ingest, now, fetch }) : null;

  /** The person signed in on this counter now, if their role may do this. */
  const who = async (device: Device, staffId: unknown, need: Who): Promise<Actor> => {
    if (!(await isOn(device.tenantId))) throw new CrmError(404, 'server', 'no such page');
    if (device.kind !== 'counter') throw new CrmError(403, 'forbidden', 'customers are kept on the shop PC only');
    if (typeof staffId !== 'string' || !staffId) throw new CrmError(401, 'unauthorized', 'sign in first');
    const t = now();
    const session = (await events.sessions(device, [staffId])).find((s) => s.startedAt <= t && t <= s.expiresAt);
    if (!session) throw new CrmError(401, 'unauthorized', 'sign in first');
    if (session.role === 'kitchen') throw new CrmError(403, 'forbidden', 'not from the kitchen');
    if (need === 'manager' && !managesRole(session.role)) throw new CrmError(403, 'forbidden', 'customers are for managers and the owner');
    if (need === 'owner' && session.role !== 'owner') throw new CrmError(403, 'forbidden', 'campaigns are the owner\'s');
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

  const mobile = (v: unknown): string => {
    const check = toLkMobile(v);
    if (!('phone' in check)) throw new CrmError(400, 'invalid_event', check.reason);
    return check.phone;
  };
  /** At the counter only the first name is shown: what the cashier says to the customer. */
  const greeting = (c: { id: string; name: string | null }) => ({ id: c.id, name: c.name?.split(' ')[0] ?? null });
  const pushing = (): Push => {
    if (!push) throw new CrmError(503, 'unavailable', 'push is not set up on this server');
    return push;
  };
  const sending = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) { if (e instanceof PushError) throw new CrmError(400, 'invalid_event', e.message); throw e; }
  };

  return {
    isOn,
    history,
    push,

    /** How many customers the shop has. */
    async count(device: Device, staffId: unknown) {
      await who(device, staffId, 'manager');
      return { customers: (await customers.list(device.tenantId)).length };
    },

    /** The list (managers and the owner): numbers and names opened, and who has the app. */
    async list(device: Device, staffId: unknown) {
      await who(device, staffId, 'manager');
      const subs = await customers.subs(device.tenantId);
      return { customers: await customers.list(device.tenantId), withApp: [...new Set(subs.map((s) => s.customerId))] };
    },

    /** Asked for no messages, or changed their mind (PDPA): respected by every campaign. */
    async optOut(device: Device, staffId: unknown, body: { id?: unknown; optedOut?: unknown }) {
      const actor = await who(device, staffId, 'manager');
      if (!isCustomerId(body.id) || typeof body.optedOut !== 'boolean') throw new CrmError(400, 'invalid_event', 'which customer, and in or out?');
      if (!(await customers.setOptOut(device.tenantId, body.id, body.optedOut, actor.id, now()))) throw new CrmError(404, 'server', 'no such customer');
      return { optedOut: body.optedOut };
    },

    /** One customer typed in by hand (managers and the owner): a number not on the list yet, a name if given. */
    async add(device: Device, staffId: unknown, body: { phone?: unknown; name?: unknown }) {
      const actor = await who(device, staffId, 'manager');
      const phone = mobile(body.phone);
      const { name } = cleanName(typeof body.name === 'string' ? body.name : null);
      const had = await customers.byPhone(device.tenantId, phone);
      if (had) throw new CrmError(409, 'invalid_event', `already on the list${had.name ? ` as ${had.name}` : ''}`);
      const { customer } = await customers.ensure(device.tenantId, phone, 'manual', actor.id, now());
      if (name) await customers.importRows(device.tenantId, [{ row: 0, kind: 'fill_name', phone, name, id: customer.id, notes: [] }], actor, now());
      return { customer: { ...customer, name } };
    },

    /** Erased (the owner's, PDPA): gone from the list; returned so the screen can offer Undo. */
    async remove(device: Device, staffId: unknown, body: { id?: unknown }) {
      await who(device, staffId, 'owner');
      if (!isCustomerId(body.id)) throw new CrmError(400, 'invalid_event', 'which customer?');
      const removed = await customers.remove(device.tenantId, body.id);
      if (!removed) throw new CrmError(404, 'server', 'no such customer');
      return { removed };
    },

    /** Undo of a remove: back as they were, under the same id, so their past sales are theirs again. */
    async restore(device: Device, staffId: unknown, body: { customer?: unknown }) {
      const actor = await who(device, staffId, 'owner');
      const c = body.customer as Partial<Customer> | undefined;
      const phone = toLkMobile(c?.phone);
      if (!c || !isCustomerId(c.id) || !('phone' in phone) || !['pos', 'import', 'manual', 'app'].includes(String(c.source))
        || typeof c.optedOut !== 'boolean' || !Number.isSafeInteger(c.createdAt) || (c.name !== null && typeof c.name !== 'string')) {
        throw new CrmError(400, 'invalid_event', 'not a removed customer');
      }
      const back = { id: c.id, phone: phone.phone, name: c.name === null ? null : cleanName(c.name).name, source: c.source as Customer['source'], optedOut: c.optedOut, createdAt: c.createdAt as number };
      if (!(await customers.restore(device.tenantId, back, actor.id, now()))) throw new CrmError(409, 'invalid_event', 'that number is on the list again already');
      return { customer: back };
    },

    /** At Charge, while the number is typed: who it is, if known. Nothing is made. */
    async lookup(device: Device, staffId: unknown, body: { phone?: unknown }) {
      await who(device, staffId, 'counter');
      const c = await customers.byPhone(device.tenantId, mobile(body.phone));
      return { customer: c ? greeting(c) : null };
    },

    /** At Charge, as the payment goes in: the customer, made if new. */
    async ensure(device: Device, staffId: unknown, body: { phone?: unknown }) {
      const actor = await who(device, staffId, 'counter');
      const { customer, created } = await customers.ensure(device.tenantId, mobile(body.phone), 'pos', actor.id, now());
      return { customer: greeting(customer), created };
    },

    async preview(device: Device, staffId: unknown, name: string, bytes: Buffer, renameExisting: boolean) {
      await who(device, staffId, 'manager');
      return { plan: await plan(device.tenantId, name, bytes, renameExisting) };
    },

    /**
     * Saves the file: planned again against the list as it is now (so a second Save, or someone
     * else's import in between, never adds anyone twice), then written in one transaction.
     */
    async save(device: Device, staffId: unknown, name: string, bytes: Buffer, renameExisting: boolean) {
      const actor = await who(device, staffId, 'manager');
      const p = await plan(device.tenantId, name, bytes, renameExisting);
      if (p.error) throw new CrmError(400, 'invalid_event', p.error);
      const saved = await customers.importRows(device.tenantId, p.rows, actor, now());
      return { plan: p, saved, customers: (await customers.list(device.tenantId)).length };
    },

    /** How many a campaign to this audience would reach (the owner). */
    async reach(device: Device, staffId: unknown, body: { audience?: unknown }) {
      await who(device, staffId, 'owner');
      if (!isAudience(body.audience)) throw new CrmError(400, 'invalid_event', 'who should it go to?');
      return pushing().reach(device.tenantId, body.audience);
    },

    /** The owner's campaign: sent now; one record with the counts comes back. */
    async send(device: Device, staffId: unknown, body: { audience?: unknown; title?: unknown; body?: unknown; testPhone?: unknown }) {
      const actor = await who(device, staffId, 'owner');
      if (!isAudience(body.audience)) throw new CrmError(400, 'invalid_event', 'who should it go to?');
      const message = { title: String(body.title ?? ''), body: String(body.body ?? '') };
      const event = await sending(() => pushing().campaign(device, actor, body.audience as never, message, body.testPhone));
      return { events: [event] };
    },

    /** The automatic "we miss you": on or off, and its words (the owner). */
    async setAuto(device: Device, staffId: unknown, body: { on?: unknown; title?: unknown; body?: unknown }) {
      const actor = await who(device, staffId, 'owner');
      if (typeof body.on !== 'boolean') throw new CrmError(400, 'invalid_event', 'on or off?');
      const why = checkMessage(body);
      if (why) throw new CrmError(400, 'invalid_event', why);
      if (!ingest) throw new CrmError(503, 'unavailable', 'no event store here');
      const event = {
        id: randomUUID(), shopId: device.tenantId, at: now(), orderNumber: 0 as const, actor,
        type: 'crm.auto_set' as const, on: body.on, title: String(body.title).trim(), body: String(body.body).trim(),
      } satisfies CampaignEvent;
      await ingest(device, [event]);
      return { events: [event] };
    },
  };
}
export type CrmApi = ReturnType<typeof crmApi>;
