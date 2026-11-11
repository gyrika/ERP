import type { DatabaseSync } from 'node:sqlite';
import type { Customer, CustomerSource } from '../../src/domain/customers.ts';
import type { CrmCrypto } from './crypto.ts';
import { newCustomerId, type CustomerStore } from './store.ts';

interface Row { id: string; phone_enc: string; name_enc: string | null; source: CustomerSource; opted_out: number; created_at: number }

/** The customer list in the shop's built-in database (server/sqlite/003-crm.sql), sealed by `crypto`. */
export function sqliteCustomers(db: DatabaseSync, crypto: CrmCrypto): CustomerStore {
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return {
    async list(tenantId) {
      const rows = db.prepare(`SELECT id, phone_enc, name_enc, source, opted_out, created_at FROM crm_customers
        WHERE tenant_id = ? ORDER BY created_at, id`).all(tenantId) as unknown as Row[];
      const out: Customer[] = [];
      for (const r of rows) {
        const phone = crypto.open(r.phone_enc);
        if (phone === null) continue; // sealed with another key: a restore without its crm.key
        out.push({
          id: r.id, phone, name: r.name_enc === null ? null : crypto.open(r.name_enc),
          source: r.source, optedOut: Boolean(r.opted_out), createdAt: Number(r.created_at),
        });
      }
      return out;
    },

    async importRows(tenantId, plan, by, at) {
      return tx(() => {
        const insert = db.prepare(`INSERT OR IGNORE INTO crm_customers
          (id, tenant_id, phone_hash, phone_enc, name_enc, source, created_by, created_at, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)`);
        const fill = db.prepare(`UPDATE crm_customers SET name_enc = ?, updated_by = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND name_enc IS NULL`);
        const rename = db.prepare(`UPDATE crm_customers SET name_enc = ?, updated_by = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`);
        let added = 0;
        let updated = 0;
        for (const r of plan) {
          if (r.kind === 'add') {
            added += Number(insert.run(newCustomerId(), tenantId, crypto.phoneHash(r.phone), crypto.seal(r.phone),
              r.name === null ? null : crypto.seal(r.name), by.id, at, by.id, at).changes);
          } else if (r.kind === 'fill_name') {
            updated += Number(fill.run(crypto.seal(r.name), by.id, at, tenantId, r.id).changes);
          } else if (r.kind === 'rename') {
            updated += Number(rename.run(crypto.seal(r.name), by.id, at, tenantId, r.id).changes);
          }
        }
        return { added, updated };
      });
    },
  };
}
