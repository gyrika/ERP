import { randomBytes } from 'node:crypto';
import type { Actor } from '../../src/domain/auth.ts';
import type { RowPlan } from '../../src/domain/customerImport.ts';
import type { Customer, CustomerSource } from '../../src/domain/customers.ts';

/**
 * The customer list (CRM). Apart from the event store on purpose: events never change, a customer
 * can be corrected and erased. Memory in tests; SQLite (./sqlite.ts) or MySQL (./mysql.ts) in a shop,
 * the same database as the events. Every row belongs to one shop (tenant_id), as everywhere.
 */

/** A phone that allowed notifications (the browser's PushSubscription, as JSON). */
export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }

export interface CustomerStore {
  /** The shop's whole list, opened (numbers +947XXXXXXXX). */
  list(tenantId: string): Promise<Customer[]>;
  byPhone(tenantId: string, phone: string): Promise<Customer | null>;
  /** The customer with this number, made if new (given at Charge, or signed up in the app). */
  ensure(tenantId: string, phone: string, source: CustomerSource, by: string, at: number): Promise<{ customer: Customer; created: boolean }>;
  /**
   * An import plan's writes, in one transaction (customerImport.ts): adds, names filled in, names
   * replaced. A number already on the list is never added again, even if the plan is old.
   * Returns what actually changed.
   */
  importRows(tenantId: string, rows: readonly RowPlan[], by: Actor, at: number): Promise<{ added: number; updated: number }>;
  /**
   * Erased (the owner, PDPA): the row goes, with the phones that signed up and the send log. Past
   * sales keep only the opaque id, which now names nobody. Returns what was removed, for Undo.
   */
  remove(tenantId: string, id: string): Promise<Customer | null>;
  /** Undo of a remove: the customer back as they were, same id (the phones must sign up again). False: the number is on the list again already. */
  restore(tenantId: string, customer: Customer, by: string, at: number): Promise<boolean>;
  /** Asked for no messages (or changed their mind). False: no such customer. */
  setOptOut(tenantId: string, id: string, optedOut: boolean, by: string, at: number): Promise<boolean>;

  // ----- push sign-ups (server/crm/push.ts) -----
  /** A phone signed up: it belongs to this customer (a phone that signed up before moves over). */
  addSub(tenantId: string, customerId: string, sub: PushSub, at: number): Promise<void>;
  /** The phone said stop, or the push service said it is gone. */
  removeSub(tenantId: string, endpoint: string): Promise<boolean>;
  subs(tenantId: string): Promise<{ customerId: string; sub: PushSub }[]>;
  /** Marks a send as done; false when it was already (so nothing goes twice). */
  logOnce(tenantId: string, key: string, customerId: string, at: number): Promise<boolean>;
  /** A send that failed is tried again next time. */
  unlog(tenantId: string, key: string): Promise<void>;
}

export const newCustomerId = () => `cus-${randomBytes(8).toString('hex')}`;

/** Tests and a server started with MEMORY=1: nothing is kept, nothing is sealed. */
export function memoryCustomers(): CustomerStore {
  const rows = new Map<string, Customer & { tenantId: string }>();
  const subs = new Map<string, { tenantId: string; customerId: string; sub: PushSub }>(); // tenant|endpoint
  const log = new Set<string>(); // tenant|key
  const find = (tenantId: string, phone: string) => [...rows.values()].find((c) => c.tenantId === tenantId && c.phone === phone);
  const open = ({ tenantId: _t, ...c }: Customer & { tenantId: string }): Customer => c;
  return {
    async list(tenantId) { return [...rows.values()].filter((c) => c.tenantId === tenantId).map(open); },
    async byPhone(tenantId, phone) { const c = find(tenantId, phone); return c ? open(c) : null; },
    async ensure(tenantId, phone, source, _by, at) {
      const had = find(tenantId, phone);
      if (had) return { customer: open(had), created: false };
      const c = { id: newCustomerId(), tenantId, phone, name: null, source, optedOut: false, createdAt: at };
      rows.set(c.id, c);
      return { customer: open(c), created: true };
    },
    async importRows(tenantId, plan, _by, at) {
      let added = 0;
      let updated = 0;
      for (const r of plan) {
        if (r.kind === 'add') {
          if (find(tenantId, r.phone)) continue;
          const c = { id: newCustomerId(), tenantId, phone: r.phone, name: r.name, source: 'import' as const, optedOut: false, createdAt: at };
          rows.set(c.id, c);
          added++;
        } else if (r.kind === 'fill_name' || r.kind === 'rename') {
          const c = rows.get(r.id);
          if (!c || c.tenantId !== tenantId || (r.kind === 'fill_name' && c.name)) continue;
          rows.set(c.id, { ...c, name: r.name });
          updated++;
        }
      }
      return { added, updated };
    },
    async remove(tenantId, id) {
      const c = rows.get(id);
      if (!c || c.tenantId !== tenantId) return null;
      rows.delete(id);
      for (const [k, s] of subs) if (s.tenantId === tenantId && s.customerId === id) subs.delete(k);
      return open(c);
    },
    async restore(tenantId, customer) {
      if (rows.has(customer.id) || find(tenantId, customer.phone)) return false;
      rows.set(customer.id, { ...customer, tenantId });
      return true;
    },
    async setOptOut(tenantId, id, optedOut) {
      const c = rows.get(id);
      if (!c || c.tenantId !== tenantId) return false;
      rows.set(id, { ...c, optedOut });
      return true;
    },
    async addSub(tenantId, customerId, sub) { subs.set(`${tenantId}|${sub.endpoint}`, { tenantId, customerId, sub }); },
    async removeSub(tenantId, endpoint) { return subs.delete(`${tenantId}|${endpoint}`); },
    async subs(tenantId) {
      return [...subs.values()].filter((s) => s.tenantId === tenantId && rows.has(s.customerId)).map(({ customerId, sub }) => ({ customerId, sub }));
    },
    async logOnce(tenantId, key) {
      const k = `${tenantId}|${key}`;
      if (log.has(k)) return false;
      log.add(k);
      return true;
    },
    async unlog(tenantId, key) { log.delete(`${tenantId}|${key}`); },
  };
}
