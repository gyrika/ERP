import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Customer, CustomerSource } from '../../src/domain/customers.ts';
import type { CrmCrypto } from './crypto.ts';
import { newCustomerId, type CustomerStore, type PushSub } from './store.ts';

interface Row extends RowDataPacket { id: string; phone_enc: string; name_enc: string | null; source: CustomerSource; opted_out: number; created_at: number | string }
const COLUMNS = 'id, phone_enc, name_enc, source, opted_out, created_at';

/** The customer list in MySQL (server/migrations/004-crm.sql, 005-crm-push.sql): the same rules as ./sqlite.ts. */
export function mysqlCustomers(pool: Pool, crypto: CrmCrypto): CustomerStore {
  const open = (r: Row): Customer | null => {
    const phone = crypto.open(r.phone_enc);
    if (phone === null) return null;
    return {
      id: r.id, phone, name: r.name_enc === null ? null : crypto.open(r.name_enc),
      source: r.source, optedOut: Boolean(r.opted_out), createdAt: Number(r.created_at),
    };
  };
  const byPhone = async (tenantId: string, phone: string) => {
    const [rows] = await pool.query<Row[]>(`SELECT ${COLUMNS} FROM crm_customers WHERE tenant_id = ? AND phone_hash = ?`, [tenantId, crypto.phoneHash(phone)]);
    return rows[0] ? open(rows[0]) : null;
  };

  return {
    async list(tenantId) {
      const [rows] = await pool.query<Row[]>(`SELECT ${COLUMNS} FROM crm_customers WHERE tenant_id = ? ORDER BY created_at, id`, [tenantId]);
      return rows.map(open).filter((c): c is Customer => c !== null);
    },

    byPhone,

    async ensure(tenantId, phone, source, by, at) {
      const id = newCustomerId();
      const [res] = await pool.query<ResultSetHeader>(`INSERT IGNORE INTO crm_customers
        (id, tenant_id, phone_hash, phone_enc, name_enc, source, created_by, created_at, updated_by, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`, [id, tenantId, crypto.phoneHash(phone), crypto.seal(phone), source, by, at, by, at]);
      if (res.affectedRows) return { customer: { id, phone, name: null, source, optedOut: false, createdAt: at }, created: true };
      const had = await byPhone(tenantId, phone);
      if (!had) throw new Error('the customer could not be found or made');
      return { customer: had, created: false };
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

    async remove(tenantId, id) {
      const [rows] = await pool.query<Row[]>(`SELECT ${COLUMNS} FROM crm_customers WHERE tenant_id = ? AND id = ?`, [tenantId, id]);
      if (!rows[0]) return null;
      await pool.query('DELETE FROM crm_push_log WHERE tenant_id = ? AND customer_id = ?', [tenantId, id]);
      await pool.query('DELETE FROM crm_push_subs WHERE tenant_id = ? AND customer_id = ?', [tenantId, id]);
      await pool.query('DELETE FROM crm_customers WHERE tenant_id = ? AND id = ?', [tenantId, id]);
      return open(rows[0]);
    },

    async restore(tenantId, c, by, at) {
      const [res] = await pool.query<ResultSetHeader>(`INSERT IGNORE INTO crm_customers
        (id, tenant_id, phone_hash, phone_enc, name_enc, source, opted_out, opted_out_at, created_by, created_at, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [c.id, tenantId, crypto.phoneHash(c.phone), crypto.seal(c.phone),
        c.name === null ? null : crypto.seal(c.name), c.source, c.optedOut ? 1 : 0, c.optedOut ? at : null, by, c.createdAt, by, at]);
      return res.affectedRows > 0;
    },

    async setOptOut(tenantId, id, optedOut, by, at) {
      const [res] = await pool.query<ResultSetHeader>(`UPDATE crm_customers SET opted_out = ?, opted_out_at = ?, updated_by = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`, [optedOut ? 1 : 0, optedOut ? at : null, by, at, tenantId, id]);
      return res.affectedRows > 0;
    },

    async addSub(tenantId, customerId, sub, at) {
      await pool.query(`INSERT INTO crm_push_subs (tenant_id, endpoint_hash, customer_id, sub_enc, created_at) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE customer_id = VALUES(customer_id), sub_enc = VALUES(sub_enc), created_at = VALUES(created_at)`,
      [tenantId, crypto.phoneHash(sub.endpoint), customerId, crypto.seal(JSON.stringify(sub)), at]);
    },

    async removeSub(tenantId, endpoint) {
      const [res] = await pool.query<ResultSetHeader>('DELETE FROM crm_push_subs WHERE tenant_id = ? AND endpoint_hash = ?', [tenantId, crypto.phoneHash(endpoint)]);
      return res.affectedRows > 0;
    },

    async subs(tenantId) {
      const [rows] = await pool.query<(RowDataPacket & { customer_id: string; sub_enc: string })[]>(
        'SELECT customer_id, sub_enc FROM crm_push_subs WHERE tenant_id = ?', [tenantId]);
      const out: { customerId: string; sub: PushSub }[] = [];
      for (const r of rows) {
        const text = crypto.open(r.sub_enc);
        if (text) out.push({ customerId: r.customer_id, sub: JSON.parse(text) as PushSub });
      }
      return out;
    },

    async logOnce(tenantId, key, customerId, at) {
      const [res] = await pool.query<ResultSetHeader>('INSERT IGNORE INTO crm_push_log (tenant_id, dedupe_key, customer_id, sent_at) VALUES (?, ?, ?, ?)',
        [tenantId, key, customerId, at]);
      return res.affectedRows > 0;
    },

    async unlog(tenantId, key) {
      await pool.query('DELETE FROM crm_push_log WHERE tenant_id = ? AND dedupe_key = ?', [tenantId, key]);
    },
  };
}
