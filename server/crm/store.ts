import { randomBytes } from 'node:crypto';
import type { Actor } from '../../src/domain/auth.ts';
import type { RowPlan } from '../../src/domain/customerImport.ts';
import type { Customer } from '../../src/domain/customers.ts';

/**
 * The customer list (CRM). Apart from the event store on purpose: events never change, a customer
 * can be corrected and erased. Memory in tests; SQLite (./sqlite.ts) or MySQL (./mysql.ts) in a shop,
 * the same database as the events. Every row belongs to one shop (tenant_id), as everywhere.
 */
export interface CustomerStore {
  /** The shop's whole list, opened (numbers +947XXXXXXXX). */
  list(tenantId: string): Promise<Customer[]>;
  /**
   * An import plan's writes, in one transaction (customerImport.ts): adds, names filled in, names
   * replaced. A number already on the list is never added again, even if the plan is old.
   * Returns what actually changed.
   */
  importRows(tenantId: string, rows: readonly RowPlan[], by: Actor, at: number): Promise<{ added: number; updated: number }>;
}

export const newCustomerId = () => `cus-${randomBytes(8).toString('hex')}`;

/** Tests and a server started with MEMORY=1: nothing is kept, nothing is sealed. */
export function memoryCustomers(): CustomerStore {
  const rows = new Map<string, Customer & { tenantId: string }>();
  const byPhone = (tenantId: string, phone: string) => [...rows.values()].find((c) => c.tenantId === tenantId && c.phone === phone);
  return {
    async list(tenantId) {
      return [...rows.values()].filter((c) => c.tenantId === tenantId).map(({ tenantId: _t, ...c }) => c);
    },
    async importRows(tenantId, plan, _by, at) {
      let added = 0;
      let updated = 0;
      for (const r of plan) {
        if (r.kind === 'add') {
          if (byPhone(tenantId, r.phone)) continue;
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
  };
}
