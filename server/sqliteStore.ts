import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Role } from '../src/domain/auth.ts';
import type { SyncEvent, SyncedEvent } from '../src/domain/sync.ts';
import { hashPin } from './pins.ts';
import {
  PinTaken, findByPin, hashToken, newDeviceId, newSessionId, newStaffId, newToken,
  type DeviceKind, type EventStore, type StaffMember,
} from './store.ts';

/**
 * The shop server's built-in database: one SQLite file, nothing to install
 * (Node's own `node:sqlite`). It brings itself up to date when it opens, from
 * server/sqlite/*.sql. Same behaviour as the MySQL store; the tests run both.
 * A shop has one counter, so one connection and synchronous calls are plenty.
 */
const MIGRATIONS = fileURLToPath(new URL('./sqlite/', import.meta.url));

interface StaffRow { id: string; name: string; role: Role; active: number; pin_salt: string; pin_hash: string }
const toStaff = (r: StaffRow): StaffMember => ({ id: r.id, name: r.name, role: r.role, active: Boolean(r.active) });

export function sqliteStore(file: string): EventStore {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set((db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id));
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(MIGRATIONS + f, 'utf8'));
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(f, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE'); // one writer at a time: seq values commit in order
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const ensureShop = (id: string, name: string) =>
    db.prepare('INSERT OR IGNORE INTO shops (id, name, created_at) VALUES (?, ?, ?)').run(id, name, Date.now());

  return {
    async deviceByToken(token) {
      const r = db.prepare('SELECT id, tenant_id, kind FROM devices WHERE token_hash = ?').get(hashToken(token)) as
        { id: string; tenant_id: string; kind: DeviceKind } | undefined;
      return r ? { id: r.id, tenantId: r.tenant_id, kind: r.kind } : null;
    },

    async push(device, batch, receivedAt) {
      return tx(() => {
        const insert = db.prepare(`INSERT INTO events
          (id, tenant_id, device_id, type, order_number, at, received_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        const find = db.prepare('SELECT seq FROM events WHERE tenant_id = ? AND id = ?');
        const accepted: { id: string; seq: number }[] = [];
        const stored: SyncedEvent[] = [];
        for (const e of batch) {
          // Look first: a repeat keeps its seq, and leaves no gap in the numbering.
          const had = find.get(device.tenantId, e.id) as { seq: number } | undefined;
          if (had) { accepted.push({ id: e.id, seq: Number(had.seq) }); continue; }
          const seq = Number(insert.run(e.id, device.tenantId, device.id, e.type, e.orderNumber, e.at, receivedAt, JSON.stringify(e)).lastInsertRowid);
          accepted.push({ id: e.id, seq });
          stored.push({ event: e, deviceId: device.id, seq, receivedAt });
        }
        return { accepted, stored };
      });
    },

    async pull(tenantId, afterSeq, limit) {
      const rows = db.prepare(
        'SELECT seq, device_id, received_at, body FROM events WHERE tenant_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .all(tenantId, afterSeq, limit) as { seq: number; device_id: string; received_at: number; body: string }[];
      return rows.map((r) => ({ event: JSON.parse(r.body) as SyncEvent, deviceId: r.device_id, seq: Number(r.seq), receivedAt: Number(r.received_at) }));
    },

    async lastSeq(tenantId) {
      return Number((db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE tenant_id = ?').get(tenantId) as { s: number }).s);
    },

    async addDevice(tenantId, shopName, kind) {
      const device = { id: newDeviceId(), tenantId, kind };
      const token = newToken();
      tx(() => {
        ensureShop(tenantId, shopName);
        db.prepare('INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(device.id, tenantId, kind, hashToken(token), Date.now());
      });
      return { device, token };
    },

    async addStaff(tenantId, name, role, pin) {
      const active = db.prepare('SELECT id, name, role, active, pin_salt, pin_hash FROM staff WHERE tenant_id = ? AND active = 1')
        .all(tenantId) as unknown as StaffRow[];
      if (await findByPin(active, pin)) throw new PinTaken();
      const { salt, hash } = await hashPin(pin);
      const id = newStaffId();
      tx(() => {
        ensureShop(tenantId, tenantId);
        db.prepare('INSERT INTO staff (id, tenant_id, name, role, pin_salt, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, tenantId, name, role, salt, hash, Date.now());
      });
      return { id, name, role, active: true };
    },

    async listStaff(tenantId) {
      return (db.prepare('SELECT id, name, role, active FROM staff WHERE tenant_id = ? ORDER BY active DESC, name')
        .all(tenantId) as unknown as StaffRow[]).map(toStaff);
    },

    async deactivateStaff(tenantId, staffId) {
      return Number(db.prepare('UPDATE staff SET active = 0 WHERE tenant_id = ? AND id = ? AND active = 1').run(tenantId, staffId).changes) === 1;
    },

    async staffByPin(tenantId, pin) {
      const rows = db.prepare('SELECT id, name, role, active, pin_salt, pin_hash FROM staff WHERE tenant_id = ? AND active = 1')
        .all(tenantId) as unknown as StaffRow[];
      const m = await findByPin(rows, pin);
      return m ? toStaff(m) : null;
    },

    async startSession(device, who, startedAt, expiresAt) {
      db.prepare('INSERT INTO sessions (id, tenant_id, device_id, staff_id, role, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(newSessionId(), device.tenantId, device.id, who.id, who.role, startedAt, expiresAt);
    },

    async sessions(device, staffIds) {
      if (!staffIds.length) return [];
      const rows = db.prepare(
        `SELECT staff_id, role, started_at, expires_at FROM sessions WHERE device_id = ? AND staff_id IN (${staffIds.map(() => '?').join(',')})`)
        .all(device.id, ...staffIds) as { staff_id: string; role: Role; started_at: number; expires_at: number }[];
      return rows.map((r) => ({ staffId: r.staff_id, role: r.role, startedAt: Number(r.started_at), expiresAt: Number(r.expires_at) }));
    },

    async close() { db.close(); },
  };
}
