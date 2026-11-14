import type { DatabaseSync } from 'node:sqlite';
import type { Customer, CustomerSource } from '../../src/domain/customers.ts';
import type { CrmCrypto } from './crypto.ts';
import { newCustomerId, type CustomerStore, type PushSub } from './store.ts';

interface Row { id: string; phone_enc: string; name_enc: string | null; source: CustomerSource; opted_out: number; created_at: number }
const COLUMNS = 'id, phone_enc, name_enc, source, opted_out, created_at';

/** The customer list in the shop's built-in database (server/sqlite/003-crm.sql, 004-crm-push.sql), sealed by `crypto`. */
export function sqliteCustomers(db: DatabaseSync, crypto: CrmCrypto): CustomerStore {
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const open = (r: Row): Customer | null => {
    const phone = crypto.open(r.phone_enc);
    if (phone === null) return null; // sealed with another key: a restore without its crm.key
    return {
      id: r.id, phone, name: r.name_enc === null ? null : crypto.open(r.name_enc),
      source: r.source, optedOut: Boolean(r.opted_out), createdAt: Number(r.created_at),
    };
  };
  const byHash = (tenantId: string, phone: string) =>
    db.prepare(`SELECT ${COLUMNS} FROM crm_customers WHERE tenant_id = ? AND phone_hash = ?`).get(tenantId, crypto.phoneHash(phone)) as Row | undefined;

  return {
    async list(tenantId) {
      const rows = db.prepare(`SELECT ${COLUMNS} FROM crm_customers WHERE tenant_id = ? ORDER BY created_at, id`).all(tenantId) as unknown as Row[];
      return rows.map(open).filter((c): c is Customer => c !== null);
    },

    async byPhone(tenantId, phone) {
      const r = byHash(tenantId, phone);
      return r ? open(r) : null;
    },

    async ensure(tenantId, phone, source, by, at) {
      return tx(() => {
        const had = byHash(tenantId, phone);
        if (had) { const c = open(had); if (c) return { customer: c, created: false }; }
        const id = newCustomerId();
        db.prepare(`INSERT INTO crm_customers
          (id, tenant_id, phone_hash, phone_enc, name_enc, source, created_by, created_at, updated_by, updated_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`).run(id, tenantId, crypto.phoneHash(phone), crypto.seal(phone), source, by, at, by, at);
        return { customer: { id, phone, name: null, source, optedOut: false, createdAt: at }, created: true };
      });
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

    async remove(tenantId, id) {
      return tx(() => {
        const r = db.prepare(`SELECT ${COLUMNS} FROM crm_customers WHERE tenant_id = ? AND id = ?`).get(tenantId, id) as Row | undefined;
        if (!r) return null;
        db.prepare('DELETE FROM crm_push_log WHERE tenant_id = ? AND customer_id = ?').run(tenantId, id);
        db.prepare('DELETE FROM crm_push_subs WHERE tenant_id = ? AND customer_id = ?').run(tenantId, id);
        db.prepare('DELETE FROM crm_customers WHERE tenant_id = ? AND id = ?').run(tenantId, id);
        return open(r);
      });
    },

    async restore(tenantId, c, by, at) {
      return Number(db.prepare(`INSERT OR IGNORE INTO crm_customers
        (id, tenant_id, phone_hash, phone_enc, name_enc, source, opted_out, opted_out_at, created_by, created_at, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.id, tenantId, crypto.phoneHash(c.phone), crypto.seal(c.phone),
        c.name === null ? null : crypto.seal(c.name), c.source, c.optedOut ? 1 : 0, c.optedOut ? at : null, by, c.createdAt, by, at).changes) > 0;
    },

    async setOptOut(tenantId, id, optedOut, by, at) {
      return Number(db.prepare(`UPDATE crm_customers SET opted_out = ?, opted_out_at = ?, updated_by = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`).run(optedOut ? 1 : 0, optedOut ? at : null, by, at, tenantId, id).changes) > 0;
    },

    async addSub(tenantId, customerId, sub, at) {
      db.prepare(`INSERT INTO crm_push_subs (tenant_id, endpoint_hash, customer_id, sub_enc, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, endpoint_hash) DO UPDATE SET customer_id = excluded.customer_id, sub_enc = excluded.sub_enc, created_at = excluded.created_at`)
        .run(tenantId, crypto.phoneHash(sub.endpoint), customerId, crypto.seal(JSON.stringify(sub)), at);
    },

    async removeSub(tenantId, endpoint) {
      return Number(db.prepare('DELETE FROM crm_push_subs WHERE tenant_id = ? AND endpoint_hash = ?').run(tenantId, crypto.phoneHash(endpoint)).changes) > 0;
    },

    async subs(tenantId) {
      const rows = db.prepare('SELECT customer_id, sub_enc FROM crm_push_subs WHERE tenant_id = ?').all(tenantId) as { customer_id: string; sub_enc: string }[];
      const out: { customerId: string; sub: PushSub }[] = [];
      for (const r of rows) {
        const text = crypto.open(r.sub_enc);
        if (text) out.push({ customerId: r.customer_id, sub: JSON.parse(text) as PushSub });
      }
      return out;
    },

    async logOnce(tenantId, key, customerId, at) {
      return Number(db.prepare('INSERT OR IGNORE INTO crm_push_log (tenant_id, dedupe_key, customer_id, sent_at) VALUES (?, ?, ?, ?)')
        .run(tenantId, key, customerId, at).changes) > 0;
    },

    async unlog(tenantId, key) {
      db.prepare('DELETE FROM crm_push_log WHERE tenant_id = ? AND dedupe_key = ?').run(tenantId, key);
    },

    async logged(tenantId, prefix) {
      // A range on the key's index: keys are plain ASCII, and '~' sorts after every character in them.
      const rows = db.prepare('SELECT customer_id FROM crm_push_log WHERE tenant_id = ? AND dedupe_key >= ? AND dedupe_key < ?')
        .all(tenantId, prefix, `${prefix}~`) as { customer_id: string }[];
      return rows.map((r) => r.customer_id);
    },
  };
}
