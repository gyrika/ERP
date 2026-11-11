import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Customer, CustomerSource } from '../../src/domain/customers.ts';
import type { CrmCrypto } from './crypto.ts';
import { newCustomerId, type CustomerStore } from './store.ts';

interface Row extends RowDataPacket { id: string; phone_enc: string; name_enc: string | null; source: CustomerSource; opted_out: number; created_at: number | string }

/** The customer list in MySQL (server/migrations/004-crm.sql): the same rules as ./sqlite.ts. */
export function mysqlCustomers(pool: Pool, crypto: CrmCrypto): CustomerStore {
  return {
    async list(tenantId) {
      const [rows] = await pool.query<Row[]>(`SELECT id, phone_enc, name_enc, source, opted_out, created_at FROM crm_customers
        WHERE tenant_id = ? ORDER BY created_at, id`, [tenantId]);
      const out: Customer[] = [];
      for (const r of rows) {
        const phone = crypto.open(r.phone_enc);
        if (phone === null) continue;
        out.push({
          id: r.id, phone, name: r.name_enc === null ? null : crypto.open(r.name_enc),
          source: r.source, optedOut: Boolean(r.opted_out), createdAt: Number(r.created_at),
        });
      }
      return out;
    },

    async importRows(tenantId, plan, by, at) {
      const c = await pool.getConnection();
      try {
        await c.beginTransaction();
        let added = 0;
        let updated = 0;
        for (const r of plan) {
          if (r.kind === 'add') {
            const [res] = await c.query<ResultSetHeader>(`INSERT IGNORE INTO crm_customers
              (id, tenant_id, phone_hash, phone_enc, name_enc, source, created_by, created_at, updated_by, updated_at)
              VALUES (?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)`,
            [newCustomerId(), tenantId, crypto.phoneHash(r.phone), crypto.seal(r.phone), r.name === null ? null : crypto.seal(r.name), by.id, at, by.id, at]);
            added += res.affectedRows;
          } else if (r.kind === 'fill_name' || r.kind === 'rename') {
            const [res] = await c.query<ResultSetHeader>(`UPDATE crm_customers SET name_enc = ?, updated_by = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ?${r.kind === 'fill_name' ? ' AND name_enc IS NULL' : ''}`,
            [crypto.seal(r.name), by.id, at, tenantId, r.id]);
            updated += res.affectedRows;
          }
        }
        await c.commit();
        return { added, updated };
      } catch (e) {
        await c.rollback();
        throw e;
      } finally {
        c.release();
      }
    },
  };
}
