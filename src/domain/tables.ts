import type { TableEvent, VisionEvent } from './events.ts';
import type { SyncEvent } from './sync.ts';

/**
 * Tables and cameras (CV Table Management v1, SCRUM-164/166). Pure: time is passed in, never read.
 * The vision worker feeds each table's presence samples to a tracker (`observe`) and writes the
 * changes it returns as `table.state_changed`; staff change a table with `table.state_set` (keys
 * C, F …), which the tracker takes with `staffSet`; every screen folds the floor with
 * `tablesFromEvents`. Times are in ms (like every event's `at`); the timers in seconds.
 */

export type TableState = 'free' | 'occupied' | 'needs_cleaning' | 'reserved';
export const TABLE_STATES: readonly TableState[] = ['free', 'occupied', 'needs_cleaning', 'reserved'];

/** Free or reserved → occupied: present in at least this share of the last `seatS` seconds' samples. */
export const SEAT_SHARE = 0.7;
/** Occupied → needs_cleaning: absent in at least this share of the last `leaveS` seconds' samples. */
export const LEAVE_SHARE = 0.9;
export const DEFAULT_SEAT_S = 60;
export const DEFAULT_LEAVE_S = 180;
/** A table still waiting to be cleaned this long raises a cleaning alert. */
export const DEFAULT_CLEAN_ALERT_S = 300;
/** Wi-Fi cameras one shop PC can watch ("Use for CV" on). */
export const MAX_CAMERAS = 4;
/** Cameras the owner may set up in all, most of them off (SCRUM-171). */
export const MAX_CAMERA_LIST = 16;

/**
 * The share of the shop PC's CPU the camera worker may use (SCRUM-174), in percent: the owner may
 * raise it from 15 to 50 in steps of 5. The worker (SCRUM-170) enforces it by reading fewer frames.
 */
export const DEFAULT_CPU_LIMIT = 15;
export const MIN_CPU_LIMIT = 5;
export const MAX_CPU_LIMIT = 50;
export const CPU_LIMIT_STEP = 5;

/** Off: no cameras. Shadow: the cameras' changes are recorded, the floor follows staff only. Live: the cameras set the floor. */
export type VisionMode = 'off' | 'shadow' | 'live';
export interface VisionSettings { mode: VisionMode; seatS: number; leaveS: number; cleanAlertS: number; cpuLimit: number }
export const DEFAULT_VISION_SETTINGS: VisionSettings = {
  mode: 'off', seatS: DEFAULT_SEAT_S, leaveS: DEFAULT_LEAVE_S, cleanAlertS: DEFAULT_CLEAN_ALERT_S, cpuLimit: DEFAULT_CPU_LIMIT,
};

export interface TableSpec { id: string; label: string; seats: number }
/** Where a camera is. Never its password: the worker keeps that on the shop PC. */
export interface CameraSpec { id: string; name: string; ip: string; rtspPath: string; enabled: boolean }
/** A point in a camera frame, normalised 0-1 (0,0 top left). */
export interface Point { x: number; y: number }
export interface ZoneSpec { id: string; tableId: string; points: Point[] }

// ----- One table's tracker (the worker) -----

export interface Sample { at: number; present: boolean }
export interface Timers { seatS: number; leaveS: number }
export interface Change { from: TableState; to: TableState; confidence: number; at: number }

export interface TableTracker {
  state: TableState;
  since: number;
  /** Presence samples, oldest first, for the longer of the two windows. */
  samples: Sample[];
  /** When the current run of evidence began (first sample, after a camera returned or a hold ended); null: none yet. */
  watchingSince: number | null;
  /** A staff change holding until presence flips from `present` (null: not seen yet). */
  hold: { present: boolean | null } | null;
  noCamera: boolean;
}

export const newTracker = (state: TableState = 'free', since = 0): TableTracker =>
  ({ state, since, samples: [], watchingSince: null, hold: null, noCamera: false });

const share = (samples: readonly Sample[], present: boolean): number =>
  samples.filter((s) => s.present === present).length / samples.length;
/** The share is at least the threshold (42/60 counts as 70%, whatever the float says). */
const reaches = (value: number, threshold: number): boolean => value >= threshold - 1e-9;

/** The window's samples, or null while fewer than `seconds` have been watched. */
const windowOf = (t: TableTracker, now: number, seconds: number): Sample[] | null => {
  const ms = seconds * 1000;
  if (t.watchingSince === null || now - t.watchingSince < ms) return null;
  const inside = t.samples.filter((s) => s.at > now - ms);
  return inside.length ? inside : null;
};

/**
 * One presence sample for this table. Returns the tracker after it, and the change to record
 * as `table.state_changed`, if any. A held staff change ends when presence flips; the rules then
 * wait for a whole window of fresh evidence.
 */
export const observe = (
  t: TableTracker, sample: Sample, timers: Timers = { seatS: DEFAULT_SEAT_S, leaveS: DEFAULT_LEAVE_S },
): { tracker: TableTracker; change: Change | null } => {
  if (t.noCamera) return { tracker: { ...t, noCamera: false, samples: [sample], watchingSince: sample.at, hold: t.hold }, change: null };
  if (t.hold) {
    if (t.hold.present === null) return { tracker: { ...t, hold: { present: sample.present }, samples: [sample] }, change: null };
    if (t.hold.present === sample.present) return { tracker: { ...t, samples: [sample] }, change: null };
    return { tracker: { ...t, hold: null, samples: [sample], watchingSince: sample.at }, change: null };
  }
  const keepMs = Math.max(timers.seatS, timers.leaveS) * 1000;
  const next: TableTracker = {
    ...t,
    samples: [...t.samples, sample].filter((s) => s.at > sample.at - keepMs),
    watchingSince: t.watchingSince ?? sample.at,
  };
  let to: TableState | null = null;
  let confidence = 0;
  if (next.state === 'free' || next.state === 'reserved') {
    const w = windowOf(next, sample.at, timers.seatS);
    if (w && reaches(share(w, true), SEAT_SHARE)) { to = 'occupied'; confidence = share(w, true); }
  } else if (next.state === 'occupied') {
    const w = windowOf(next, sample.at, timers.leaveS);
    if (w && reaches(share(w, false), LEAVE_SHARE)) { to = 'needs_cleaning'; confidence = share(w, false); }
  }
  if (!to) return { tracker: next, change: null };
  const change = { from: next.state, to, confidence: Math.round(confidence * 100) / 100, at: sample.at };
  return { tracker: { ...next, state: to, since: sample.at }, change };
};

/** Staff set the table (or Undo put a state back): it holds until presence next flips. */
export const staffSet = (t: TableTracker, to: TableState, at: number): TableTracker => {
  const last = t.samples.at(-1);
  return { ...t, state: to, since: at, hold: { present: t.hold?.present ?? last?.present ?? null } };
};

/** The table's camera went offline: it keeps its state, says noCamera, and starts afresh when a sample comes. */
export const cameraLost = (t: TableTracker): TableTracker => ({ ...t, noCamera: true, samples: [], watchingSince: null });

// ----- Where a person is -----

const onSegment = (p: Point, a: Point, b: Point): boolean => {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > 1e-9) return false;
  return p.x >= Math.min(a.x, b.x) - 1e-9 && p.x <= Math.max(a.x, b.x) + 1e-9
    && p.y >= Math.min(a.y, b.y) - 1e-9 && p.y <= Math.max(a.y, b.y) + 1e-9;
};

/** Is the point inside the polygon (normalised coords)? Its edges and corners count as inside. */
export const pointInPolygon = (point: Point, polygon: readonly Point[]): boolean => {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (onSegment(point, a, b)) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

/** Where a detected person sits: the box's centre across, 80% of the way down. A person is at a table when it is in the table's zone. */
export const footPoint = (box: { x1: number; y1: number; x2: number; y2: number }): Point =>
  ({ x: (box.x1 + box.x2) / 2, y: box.y1 + 0.8 * (box.y2 - box.y1) });

// ----- The floor, folded from events -----

export interface Vision {
  settings: VisionSettings;
  cameras: CameraSpec[];
  /** Each camera's zones, by camera id. */
  zones: Record<string, ZoneSpec[]>;
  /** Cameras last reported offline. */
  offline: Set<string>;
}

const isVision = (e: SyncEvent): e is Extract<SyncEvent, VisionEvent> => e.type.startsWith('vision.');
const isTable = (e: SyncEvent): e is Extract<SyncEvent, TableEvent> => e.type.startsWith('table.');

/** The cameras, their zones and the vision settings, latest of each. */
export const visionFromEvents = (events: readonly SyncEvent[]): Vision => {
  const v: Vision = { settings: DEFAULT_VISION_SETTINGS, cameras: [], zones: {}, offline: new Set() };
  for (const e of events) {
    if (!isVision(e)) continue;
    switch (e.type) {
      case 'vision.settings_set':
        v.settings = { mode: e.mode, seatS: e.seatS, leaveS: e.leaveS, cleanAlertS: e.cleanAlertS, cpuLimit: e.cpuLimit ?? DEFAULT_CPU_LIMIT };
        break;
      case 'vision.cameras_set': v.cameras = e.cameras; break;
      case 'vision.zones_set': v.zones = { ...v.zones, [e.cameraId]: e.zones }; break;
      case 'vision.camera_offline': v.offline.add(e.cameraId); break;
      case 'vision.camera_online': v.offline.delete(e.cameraId); break;
      case 'vision.heartbeat': for (const c of e.cameras) { if (c.online) v.offline.delete(c.id); else v.offline.add(c.id); } break;
    }
  }
  return v;
};

export interface FloorTable extends TableSpec {
  state: TableState;
  since: number;
  /** An enabled camera has a zone on this table. */
  watched: boolean;
  /** Watched, but every camera on it is offline: the state is the last one seen. */
  noCamera: boolean;
  /** The open cleaning alert's event id. */
  alertId: string | null;
}

/**
 * The floor: the layout, each table's state and since-when, its open alert and camera. A camera
 * change from a state the table is no longer in (staff got there first) is stale and ignored;
 * a staff change always applies. In Shadow a camera change is what the camera saw, not the
 * floor: it is kept (the Owner feed's visits, the Shadow week's misses) but moves no table. `table.state_set_undone` puts back what the staff change
 * replaced, like `order.change_undone`, as long as nothing has changed the table since.
 */
export const tablesFromEvents = (events: readonly SyncEvent[]): FloorTable[] => foldTables(events).floor;

/** One change the floor took, in order: who made it (the camera, staff, or a staff Undo) and when. */
export interface TableChange {
  tableId: string; from: TableState; to: TableState; at: number; by: 'camera' | 'staff' | 'undo';
  /** A camera change in Shadow: what the camera saw, which the floor did not take. */
  shadow?: true;
}

/**
 * Every change the floor took, by the same rules as `tablesFromEvents` (stale camera changes left
 * out), and what the cameras saw in Shadow (as they saw it). The Owner feed's visits.
 */
export const tableChanges = (events: readonly SyncEvent[]): TableChange[] => foldTables(events).changes;

const foldTables = (events: readonly SyncEvent[]): { floor: FloorTable[]; changes: TableChange[] } => {
  let layout: TableSpec[] = [];
  const changes: TableChange[] = [];
  const took = (tableId: string, from: TableState, to: TableState, at: number, by: TableChange['by'], shadow = false) => {
    if (from !== to) changes.push({ tableId, from, to, at, by, ...(shadow ? { shadow: true as const } : {}) });
  };
  const state = new Map<string, { state: TableState; since: number; lastId: string | null }>();
  const alerts = new Map<string, string | null>();
  /** What each staff change replaced, by its event id. */
  const replaced = new Map<string, { state: TableState; since: number; lastId: string | null }>();
  let mode: VisionMode = DEFAULT_VISION_SETTINGS.mode;
  for (const e of events) {
    if (e.type === 'vision.settings_set') mode = e.mode;
    if (!isTable(e)) continue;
    const now = 'tableId' in e ? state.get(e.tableId) : undefined;
    switch (e.type) {
      case 'table.layout_set':
        layout = e.tables;
        for (const t of e.tables) if (!state.has(t.id)) state.set(t.id, { state: 'free', since: e.at, lastId: null });
        break;
      case 'table.state_changed':
        if (mode === 'shadow') { if (now) took(e.tableId, e.from, e.to, e.at, 'camera', true); }
        else if (now && now.state === e.from) { state.set(e.tableId, { state: e.to, since: e.at, lastId: e.id }); took(e.tableId, e.from, e.to, e.at, 'camera'); }
        break;
      case 'table.state_set':
        if (!now) break;
        replaced.set(e.id, now);
        state.set(e.tableId, { state: e.to, since: e.at, lastId: e.id });
        took(e.tableId, now.state, e.to, e.at, 'staff');
        break;
      case 'table.state_set_undone': {
        const was = replaced.get(e.undoneEventId);
        if (now && was && now.lastId === e.undoneEventId) { state.set(e.tableId, was); took(e.tableId, now.state, was.state, e.at, 'undo'); }
        break;
      }
      case 'table.alert_raised': alerts.set(e.tableId, e.id); break;
      case 'table.alert_cleared': if (alerts.get(e.tableId) === e.alertEventId) alerts.set(e.tableId, null); break;
    }
  }
  const vision = visionFromEvents(events);
  const floor = layout.map((t) => {
    const watchers = vision.cameras.filter((c) => c.enabled && (vision.zones[c.id] ?? []).some((z) => z.tableId === t.id));
    const s = state.get(t.id) ?? { state: 'free' as const, since: 0 };
    return {
      ...t, state: s.state, since: s.since,
      watched: watchers.length > 0,
      noCamera: watchers.length > 0 && watchers.every((c) => vision.offline.has(c.id)),
      alertId: alerts.get(t.id) ?? null,
    };
  });
  return { floor, changes };
};

/**
 * The Register's Tables chip (SCRUM-168): how many tables are free, and the most urgent colour.
 * A dirty table is amber, red once it has waited `cleanAlertS` (0: never) or has an open alert,
 * so the chip turns red with no camera too.
 */
export const floorSummary = (tables: readonly FloorTable[], now: number, cleanAlertS = DEFAULT_CLEAN_ALERT_S): { free: number; tone: 'warn' | 'bad' | null } => {
  const dirty = tables.filter((t) => t.state === 'needs_cleaning');
  const overdue = dirty.some((t) => t.alertId !== null || (cleanAlertS > 0 && now - t.since >= cleanAlertS * 1000));
  return { free: tables.filter((t) => t.state === 'free').length, tone: overdue ? 'bad' : dirty.length ? 'warn' : null };
};

// ----- What the server accepts -----

export const TABLE_EVENT_TYPES = [
  'table.layout_set', 'table.state_changed', 'table.state_set', 'table.state_set_undone', 'table.alert_raised', 'table.alert_cleared',
] as const satisfies readonly TableEvent['type'][];
export const VISION_EVENT_TYPES = [
  'vision.cameras_set', 'vision.zones_set', 'vision.settings_set', 'vision.camera_offline', 'vision.camera_online', 'vision.heartbeat',
] as const satisfies readonly VisionEvent['type'][];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const id = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isState = (v: unknown): v is TableState => TABLE_STATES.includes(v as TableState);
const unit = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const wholeIn = (v: unknown, min: number, max: number): boolean => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
/** Exactly these keys: nothing else (a password, a frame) can ride along. */
const only = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const unique = (list: { id: string }[]): boolean => new Set(list.map((x) => x.id)).size === list.length;
/** An IPv4 address or a host name: no user, password or port. */
const host = (v: unknown): boolean => typeof v === 'string' && v.length <= 253 && /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(v);
/** The stream's path on the camera ("/stream1"), never a full URL with a login. */
const rtspPath = (v: unknown): boolean => typeof v === 'string' && v.length <= 200 && /^\/[A-Za-z0-9/_.?=&%-]*$/.test(v);

const BASE = ['id', 'shopId', 'at', 'actor', 'orderNumber', 'type'];
const FIELDS: Record<(typeof TABLE_EVENT_TYPES)[number] | (typeof VISION_EVENT_TYPES)[number], string[]> = {
  'table.layout_set': ['tables'],
  'table.state_changed': ['tableId', 'from', 'to', 'confidence'],
  'table.state_set': ['tableId', 'from', 'to'],
  'table.state_set_undone': ['tableId', 'undoneEventId'],
  'table.alert_raised': ['tableId', 'alert'],
  'table.alert_cleared': ['tableId', 'alertEventId'],
  'vision.cameras_set': ['cameras'],
  'vision.zones_set': ['cameraId', 'zones'],
  'vision.settings_set': ['mode', 'seatS', 'leaveS', 'cleanAlertS', 'cpuLimit'],
  'vision.camera_offline': ['cameraId'],
  'vision.camera_online': ['cameraId'],
  'vision.heartbeat': ['cameras', 'cpu'],
};

/** Why a table or vision event is not acceptable, or null. Shape only; who may record it is `mayRecord`. */
export const checkTableEvent = (e: Record<string, unknown>): string | null => {
  const fields = FIELDS[e.type as keyof typeof FIELDS];
  if (!fields) return 'not a table or vision event';
  if (e.orderNumber !== 0) return 'it must not belong to an order';
  if (!only(e, [...BASE, ...fields])) return 'it carries something it should not';
  switch (e.type) {
    case 'table.layout_set': {
      const t = e.tables;
      if (!Array.isArray(t) || t.length > 100 || !t.every((x) => isObj(x) && only(x, ['id', 'label', 'seats']) && id(x.id) && id(x.label, 40) && wholeIn(x.seats, 1, 50))
        || !unique(t as TableSpec[])) return 'the tables are not valid';
      return null;
    }
    case 'table.state_changed':
      if (!id(e.tableId) || !isState(e.from) || !isState(e.to) || e.from === e.to || !unit(e.confidence)) return 'the change is not valid';
      return null;
    case 'table.state_set':
      return id(e.tableId) && isState(e.from) && isState(e.to) ? null : 'the change is not valid';
    case 'table.state_set_undone':
      return id(e.tableId) && id(e.undoneEventId) ? null : 'the Undo does not say what it undoes';
    case 'table.alert_raised':
      return id(e.tableId) && e.alert === 'needs_cleaning' ? null : 'the alert is not valid';
    case 'table.alert_cleared':
      return id(e.tableId) && id(e.alertEventId) ? null : 'it does not say which alert';
    case 'vision.cameras_set': {
      const c = e.cameras;
      if (!Array.isArray(c) || c.length > MAX_CAMERA_LIST || !c.every((x) => isObj(x) && only(x, ['id', 'name', 'ip', 'rtspPath', 'enabled'])
        && id(x.id) && id(x.name, 60) && host(x.ip) && rtspPath(x.rtspPath) && typeof x.enabled === 'boolean')
        || !unique(c as CameraSpec[]) || (c as CameraSpec[]).filter((x) => x.enabled).length > MAX_CAMERAS) return 'the cameras are not valid';
      return null;
    }
    case 'vision.zones_set': {
      const z = e.zones;
      if (!id(e.cameraId) || !Array.isArray(z) || z.length > 40 || !z.every((x) => isObj(x) && only(x, ['id', 'tableId', 'points']) && id(x.id) && id(x.tableId)
        && Array.isArray(x.points) && x.points.length >= 3 && x.points.length <= 32
        && x.points.every((p) => isObj(p) && only(p, ['x', 'y']) && unit(p.x) && unit(p.y)))
        || !unique(z as ZoneSpec[])) return 'the zones are not valid';
      return null;
    }
    case 'vision.settings_set':
      if (!['off', 'shadow', 'live'].includes(String(e.mode)) || !wholeIn(e.seatS, 10, 3600) || !wholeIn(e.leaveS, 10, 3600) || !wholeIn(e.cleanAlertS, 0, 7200)
        || (e.cpuLimit !== undefined && !wholeIn(e.cpuLimit, MIN_CPU_LIMIT, MAX_CPU_LIMIT))) {
        return 'the settings are not valid';
      }
      return null;
    case 'vision.camera_offline':
    case 'vision.camera_online':
      return id(e.cameraId) ? null : 'it does not say which camera';
    case 'vision.heartbeat': {
      const c = e.cameras;
      const cpu = e.cpu;
      if (!Array.isArray(c) || c.length > MAX_CAMERAS || !c.every((x) => isObj(x) && only(x, ['id', 'online', 'fps']) && id(x.id)
        && typeof x.online === 'boolean' && typeof x.fps === 'number' && Number.isFinite(x.fps) && x.fps >= 0 && x.fps <= 120)
        || typeof cpu !== 'number' || !Number.isFinite(cpu) || cpu < 0 || cpu > 100) return 'the heartbeat is not valid';
      return null;
    }
  }
  return null;
};
