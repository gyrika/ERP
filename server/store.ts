import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Actor, Role } from '../src/domain/auth.ts';
import type { SyncEvent, SyncedEvent } from '../src/domain/sync.ts';
import { hashPin, pinMatches } from './pins.ts';

/**
 * Where the server keeps events. The HTTP layer only talks to this
 * interface: MySQL in production, memory in tests.
 */
export interface Device {
  id: string;
  tenantId: string;
  kind: DeviceKind;
}
export type DeviceKind = 'counter' | 'kitchen' | 'owner';

export interface StaffMember extends Actor {
  active: boolean;
}

/** A PIN login on one device: who, with which role, for how long (server clock). */
export interface Session {
  staffId: string;
  role: Role;
  startedAt: number;
  expiresAt: number;
}

/** Thrown by addStaff: login is by PIN alone, so a PIN may belong to one active person only. */
export class PinTaken extends Error {
  constructor() { super('another active staff member already has this PIN'); }
}

export interface PushResult {
  /** One per event sent, in order, including ones already stored. */
  accepted: { id: string; seq: number }[];
  /** Only the events stored by this call, for the live stream. */
  stored: SyncedEvent[];
}

export interface EventStore {
  deviceByToken(token: string): Promise<Device | null>;
  push(device: Device, events: SyncEvent[], receivedAt: number): Promise<PushResult>;
  /** Events after `afterSeq`, oldest first, at most `limit`. */
  pull(tenantId: string, afterSeq: number, limit: number): Promise<SyncedEvent[]>;
  lastSeq(tenantId: string): Promise<number>;
  /** Setup only (npm run server:device): registers a device, returns its secret token once. */
  addDevice(tenantId: string, shopName: string, kind: DeviceKind): Promise<{ device: Device; token: string }>;

  // ----- staff and logins (SCRUM-40/41) -----
  addStaff(tenantId: string, name: string, role: Role, pin: string): Promise<StaffMember>;
  listStaff(tenantId: string): Promise<StaffMember[]>;
  /**
   * Someone leaves: their PIN stops working at once. There is no re-activation:
   * hashes cannot be compared, so the server could not tell whether the old PIN
   * now clashes with someone else's. Add them again with a new PIN instead.
   */
  deactivateStaff(tenantId: string, staffId: string): Promise<boolean>;
  /** The active staff member with this PIN, or null. */
  staffByPin(tenantId: string, pin: string): Promise<StaffMember | null>;
  startSession(device: Device, staff: Actor, startedAt: number, expiresAt: number): Promise<void>;
  /** This device's sessions for these people. */
  sessions(device: Device, staffIds: string[]): Promise<Session[]>;
  close(): Promise<void>;
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const newDeviceId = () => `dev-${randomBytes(8).toString('hex')}`;
const newStaffId = () => `staff-${randomBytes(8).toString('hex')}`;
const newSessionId = () => randomBytes(16).toString('hex');

/** Tries every active person's hash; a shop has a handful of staff, so this stays well under a second. */
const findByPin = async <T extends { pin_salt: string; pin_hash: string }>(rows: T[], pin: string): Promise<T | null> => {
  for (const r of rows) if (await pinMatches(pin, r.pin_salt, r.pin_hash)) return r;
  return null;
};

// ----- memory (tests, and trying the server without MySQL) -----

export function memoryStore(): EventStore {
  const devices = new Map<string, Device>(); // token hash → device
  const events: (SyncedEvent & { tenantId: string })[] = [];
  const staff: (StaffMember & { tenantId: string; pin_salt: string; pin_hash: string })[] = [];
  const sessions: (Session & { deviceId: string })[] = [];
  let seq = 0;
  const pub = ({ id, name, role, active }: StaffMember): StaffMember => ({ id, name, role, active });
  return {
    async addStaff(tenantId, name, role, pin) {
      if (await findByPin(staff.filter((m) => m.tenantId === tenantId && m.active), pin)) throw new PinTaken();
      const { salt, hash } = await hashPin(pin);
      const m = { id: newStaffId(), name, role, active: true, tenantId, pin_salt: salt, pin_hash: hash };
      staff.push(m);
      return pub(m);
    },
    async listStaff(tenantId) { return staff.filter((m) => m.tenantId === tenantId).map(pub); },
    async deactivateStaff(tenantId, staffId) {
      const m = staff.find((x) => x.tenantId === tenantId && x.id === staffId && x.active);
      if (!m) return false;
      m.active = false;
      return true;
    },
    async staffByPin(tenantId, pin) {
      const m = await findByPin(staff.filter((x) => x.tenantId === tenantId && x.active), pin);
      return m ? pub(m) : null;
    },
    async startSession(device, who, startedAt, expiresAt) {
      sessions.push({ deviceId: device.id, staffId: who.id, role: who.role, startedAt, expiresAt });
    },
    async sessions(device, staffIds) {
      return sessions.filter((x) => x.deviceId === device.id && staffIds.includes(x.staffId))
        .map(({ deviceId: _d, ...x }) => x);
    },
    async deviceByToken(token) { return devices.get(hashToken(token)) ?? null; },
    async push(device, batch, receivedAt) {
      const accepted: PushResult['accepted'] = [];
      const stored: SyncedEvent[] = [];
      for (const event of batch) {
        const had = events.find((e) => e.tenantId === device.tenantId && e.event.id === event.id);
        if (had) { accepted.push({ id: event.id, seq: had.seq }); continue; }
        const s: SyncedEvent = { event, deviceId: device.id, seq: ++seq, receivedAt };
        events.push({ ...s, tenantId: device.tenantId });
        stored.push(s);
        accepted.push({ id: event.id, seq: s.seq });
      }
      return { accepted, stored };
    },
    async pull(tenantId, afterSeq, limit) {
      return events
        .filter((e) => e.tenantId === tenantId && e.seq > afterSeq)
        .slice(0, limit)
        .map(({ tenantId: _t, ...s }) => s);
    },
    async lastSeq(tenantId) {
      return events.filter((e) => e.tenantId === tenantId).at(-1)?.seq ?? 0;
    },
    async addDevice(tenantId, _shopName, kind) {
      const device = { id: newDeviceId(), tenantId, kind };
      const token = newToken();
      devices.set(hashToken(token), device);
      return { device, token };
    },
    async close() {},
  };
}

// ----- MySQL -----

interface EventRow extends RowDataPacket {
  seq: number | string;
  device_id: string;
  received_at: number | string;
  body: SyncEvent | string;
}

const toSynced = (r: EventRow): SyncedEvent => ({
  event: typeof r.body === 'string' ? (JSON.parse(r.body) as SyncEvent) : r.body,
  deviceId: r.device_id,
  seq: Number(r.seq),
  receivedAt: Number(r.received_at),
});

/**
 * Every query filters by tenant_id, and the tenant always comes from the
 * device token, never from the request (SCRUM-42). Events are only ever
 * INSERTed and SELECTed: the app's MySQL user has no UPDATE or DELETE on
 * them (SCRUM-43), which is why a repeat push uses INSERT IGNORE rather than
 * ON DUPLICATE KEY UPDATE.
 */
export function mysqlStore(pool: Pool): EventStore {
  const inTransaction = async <T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> => {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const result = await fn(c);
      await c.commit();
      return result;
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  };

  return {
    async deviceByToken(token) {
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT id, tenant_id, kind FROM devices WHERE token_hash = ?', [hashToken(token)]);
      const r = rows[0];
      return r ? { id: r.id as string, tenantId: r.tenant_id as string, kind: r.kind as DeviceKind } : null;
    },

    async push(device, batch, receivedAt) {
      if (!batch.length) return { accepted: [], stored: [] };
      return inTransaction(async (c) => {
        // One push per shop at a time, so seq values commit in order: without this lock a
        // device that already pulled "after 8" could miss a 7 committed a moment later.
        await c.query('SELECT id FROM shops WHERE id = ? FOR UPDATE', [device.tenantId]);
        const fresh = new Set<string>();
        for (const e of batch) {
          const [r] = await c.query<ResultSetHeader>(
            `INSERT IGNORE INTO events (id, tenant_id, device_id, type, order_number, at, received_at, body)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [e.id, device.tenantId, device.id, e.type, e.orderNumber, e.at, receivedAt, JSON.stringify(e)]);
          if (r.affectedRows === 1) fresh.add(e.id);
        }
        const [rows] = await c.query<EventRow[]>(
          'SELECT seq, id, device_id, received_at, body FROM events WHERE tenant_id = ? AND id IN (?)',
          [device.tenantId, batch.map((e) => e.id)]);
        const byId = new Map(rows.map((r) => [r.id as string, r]));
        return {
          accepted: batch.map((e) => ({ id: e.id, seq: Number(byId.get(e.id)!.seq) })),
          stored: rows.filter((r) => fresh.has(r.id as string)).map(toSynced).sort((a, b) => a.seq - b.seq),
        };
      });
    },

    async pull(tenantId, afterSeq, limit) {
      const [rows] = await pool.query<EventRow[]>(
        'SELECT seq, device_id, received_at, body FROM events WHERE tenant_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        [tenantId, afterSeq, limit]);
      return rows.map(toSynced);
    },

    async lastSeq(tenantId) {
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE tenant_id = ?', [tenantId]);
      return Number(rows[0].s);
    },

    async addDevice(tenantId, shopName, kind) {
      const device = { id: newDeviceId(), tenantId, kind };
      const token = newToken();
      await pool.query('INSERT IGNORE INTO shops (id, name) VALUES (?, ?)', [tenantId, shopName]);
      await pool.query('INSERT INTO devices (id, tenant_id, kind, token_hash) VALUES (?, ?, ?, ?)',
        [device.id, tenantId, kind, hashToken(token)]);
      return { device, token };
    },

    async addStaff(tenantId, name, role, pin) {
      return inTransaction(async (c) => {
        // Lock the shop so two people added at once cannot both take the same PIN.
        await c.query('SELECT id FROM shops WHERE id = ? FOR UPDATE', [tenantId]);
        const [rows] = await c.query<StaffRow[]>(
          'SELECT id, name, role, active, pin_salt, pin_hash FROM staff WHERE tenant_id = ? AND active', [tenantId]);
        if (await findByPin(rows, pin)) throw new PinTaken();
        const { salt, hash } = await hashPin(pin);
        const id = newStaffId();
        await c.query('INSERT INTO staff (id, tenant_id, name, role, pin_salt, pin_hash) VALUES (?, ?, ?, ?, ?, ?)',
          [id, tenantId, name, role, salt, hash]);
        return { id, name, role, active: true };
      });
    },

    async listStaff(tenantId) {
      const [rows] = await pool.query<StaffRow[]>(
        'SELECT id, name, role, active FROM staff WHERE tenant_id = ? ORDER BY active DESC, name', [tenantId]);
      return rows.map(toStaff);
    },

    async deactivateStaff(tenantId, staffId) {
      const [r] = await pool.query<ResultSetHeader>(
        'UPDATE staff SET active = FALSE WHERE tenant_id = ? AND id = ? AND active', [tenantId, staffId]);
      return r.affectedRows === 1;
    },

    async staffByPin(tenantId, pin) {
      const [rows] = await pool.query<StaffRow[]>(
        'SELECT id, name, role, active, pin_salt, pin_hash FROM staff WHERE tenant_id = ? AND active', [tenantId]);
      const m = await findByPin(rows, pin);
      return m ? toStaff(m) : null;
    },

    async startSession(device, who, startedAt, expiresAt) {
      await pool.query(
        'INSERT INTO sessions (id, tenant_id, device_id, staff_id, role, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [newSessionId(), device.tenantId, device.id, who.id, who.role, startedAt, expiresAt]);
    },

    async sessions(device, staffIds) {
      if (!staffIds.length) return [];
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT staff_id, role, started_at, expires_at FROM sessions WHERE device_id = ? AND staff_id IN (?)',
        [device.id, staffIds]);
      return rows.map((r) => ({
        staffId: r.staff_id as string, role: r.role as Role, startedAt: Number(r.started_at), expiresAt: Number(r.expires_at),
      }));
    },

    async close() { await pool.end(); },
  };
}

interface StaffRow extends RowDataPacket {
  id: string;
  name: string;
  role: Role;
  active: number | boolean;
  pin_salt: string;
  pin_hash: string;
}
const toStaff = (r: StaffRow): StaffMember => ({ id: r.id, name: r.name, role: r.role, active: Boolean(r.active) });
