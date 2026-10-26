import type { PartLine } from './ownerParts.ts';
import type { SyncEvent } from './sync.ts';
import { MIN_SHADOW_CHANGES, offlineCameras, SHADOW_DAYS, shadowAgreement, visitsFrom } from './tableInsights.ts';
import {
  floorSummary, LEAVE_SHARE, SEAT_SHARE, tableChanges, tablesFromEvents, visionFromEvents, type FloorTable, type TableState, type VisionSettings,
} from './tables.ts';

/**
 * The owner's Computer vision page (#vision, SCRUM-174). Pure: events in, words out. Mind: the
 * owner, who knows where the tables and cameras are; what they need is whether CV is on, whether
 * it is right, and why it thinks a table is taken.
 */

const MIN = 60_000;
const DAY_MS = 24 * 60 * MIN;
const startOfDay = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const clock = (t: number): string => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const WORD: Record<TableState, string> = { free: 'Free', occupied: 'Occupied', needs_cleaning: 'Needs cleaning', reserved: 'Reserved' };
/** The fewest seconds of a window that count, by the tracker's own rule (42 of 60 at 70%). */
const needed = (share: number, seconds: number): number => Math.ceil(share * seconds - 1e-9);

/** What one camera change says, from its confidence: the seconds it saw against the seconds needed. */
const cameraSaw = (to: TableState, confidence: number, at: number, s: VisionSettings): string => {
  if (to === 'occupied') {
    return `Cameras saw people in ${Math.round(confidence * s.seatS)} of the last ${s.seatS} s at ${clock(at)}; ${needed(SEAT_SHARE, s.seatS)} count as occupied.`;
  }
  if (to === 'needs_cleaning') {
    return `Cameras saw it empty for ${Math.round(confidence * s.leaveS)} of the last ${s.leaveS} s at ${clock(at)}; ${needed(LEAVE_SHARE, s.leaveS)} count as left.`;
  }
  return `Set by the cameras at ${clock(at)}.`;
};

/**
 * Why a table is in its state, in one sentence: what the cameras saw against what the tracker
 * needs (`observe` in tables.ts), or who set it and what ends a staff hold (`staffSet`: the next
 * time presence flips). In Shadow, what the cameras saw last is said beside it.
 */
export const whyState = (table: FloorTable, events: readonly SyncEvent[], settings: VisionSettings): string => {
  const mine = tableChanges(events).filter((c) => c.tableId === table.id);
  let last = [...mine].reverse().find((c) => !(c.by === 'camera' && c.shadow));
  // Staff setting the state it already had (cleaned a free table) moves nothing, but it is the latest word.
  const staffSaid = [...events].reverse().find((e) => e.type === 'table.state_set' && e.tableId === table.id);
  if (staffSaid && staffSaid.type === 'table.state_set' && staffSaid.at > (last?.at ?? -Infinity)) {
    last = { tableId: table.id, from: staffSaid.from, to: staffSaid.to, at: staffSaid.at, by: 'staff' };
  }
  const cameraLast = settings.mode === 'shadow' ? [...mine].reverse().find((c) => c.by === 'camera') : undefined;
  const find = <T extends SyncEvent['type']>(type: T, at: number) =>
    [...events].reverse().find((e) => e.type === type && e.at === at && 'tableId' in e && e.tableId === table.id) as Extract<SyncEvent, { type: T }> | undefined;

  if (!last) {
    const laid = [...events].reverse().find((e) => e.type === 'table.layout_set');
    return `${WORD[table.state]} since the tables were set up${laid ? ` at ${clock(laid.at)}` : ''}.`;
  }
  if (last.by === 'camera') {
    const e = find('table.state_changed', last.at);
    const saw = cameraSaw(last.to, e?.confidence ?? 0, last.at, settings);
    return table.noCamera ? `Camera offline: this is the last thing it saw. ${saw}` : saw;
  }
  if (last.by === 'undo') return `Put back by ${find('table.state_set_undone', last.at)?.actor.name ?? 'staff'}’s Undo at ${clock(last.at)}.`;
  const set = `Set by ${find('table.state_set', last.at)?.actor.name ?? 'staff'} at ${clock(last.at)}`;
  if (settings.mode === 'off') return `${set}.`;
  if (!table.watched) return `${set}; no camera watches this table.`;
  if (settings.mode === 'shadow') {
    const seen = cameraLast ? ` They saw ${cameraLast.to === 'occupied' ? 'people' : 'it empty'} at ${clock(cameraLast.at)}.` : '';
    return `${set}; in Shadow the cameras only watch.${seen}`;
  }
  return `${set}; holds until ${table.state === 'occupied' ? 'the table empties' : 'someone sits down'}.`;
};

export interface TableDay {
  /** Visits the cameras saw start today. */
  seated: number;
  /** Today's finished visits, average minutes; null: none yet. */
  visitMin: number | null;
  /** From the cameras seeing guests leave to staff marking it free, average minutes; null: none yet. */
  waitMin: number | null;
}

const average = (xs: number[]): number | null => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length / MIN) : null);

/**
 * Each table's day so far: visits (`visitsFrom`, the Owner feed's), and how long tables waited to
 * be cleaned: a camera seeing guests leave, to the first staff change that frees the table before
 * the camera's next change there. In Shadow too: the camera's word, not the floor's.
 */
export const tablesToday = (events: readonly SyncEvent[], now: number): Map<string, TableDay> => {
  const today = startOfDay(now);
  const visits = visitsFrom(events, now).filter((v) => v.start >= today);
  const undone = new Set(events.flatMap((e) => (e.type === 'table.state_set_undone' ? [e.undoneEventId] : [])));
  const left = new Map<string, number>();
  const waits = new Map<string, number[]>();
  for (const e of events) {
    if (e.at < today || e.at > now) continue;
    if (e.type === 'table.state_changed') {
      if (e.to === 'needs_cleaning') left.set(e.tableId, e.at); else left.delete(e.tableId);
    } else if (e.type === 'table.state_set' && e.to === 'free' && !undone.has(e.id)) {
      const since = left.get(e.tableId);
      if (since === undefined) continue;
      left.delete(e.tableId);
      waits.set(e.tableId, [...(waits.get(e.tableId) ?? []), e.at - since]);
    }
  }
  return new Map(tablesFromEvents(events).map((t) => {
    const mine = visits.filter((v) => v.tableId === t.id);
    const done = mine.flatMap((v) => (v.end !== null && v.end <= now ? [v.end - v.start] : []));
    return [t.id, { seated: mine.length, visitMin: average(done), waitMin: average(waits.get(t.id) ?? []) }];
  }));
};

export interface CameraHealth {
  /** The latest heartbeat. */
  at: number | null;
  /** The worker's CPU share there, whole percent. */
  cpu: number | null;
  cameras: { id: string; name: string; online: boolean; fps: number | null; lastSeen: number | null }[];
}

/**
 * Each camera in use: online or not (`vision.camera_offline`/`online` and heartbeats, as the floor
 * folds them), its frames a second in the latest heartbeat that names it, and when it was last
 * seen working. Null until the camera worker (SCRUM-170) has said anything.
 */
export const cameraHealth = (events: readonly SyncEvent[]): CameraHealth | null => {
  let heard = false;
  let at: number | null = null;
  let cpu: number | null = null;
  const fps = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'vision.camera_offline') heard = true;
    else if (e.type === 'vision.camera_online') { heard = true; seen.set(e.cameraId, e.at); }
    else if (e.type === 'vision.heartbeat') {
      heard = true; at = e.at; cpu = Math.round(e.cpu);
      for (const c of e.cameras) { fps.set(c.id, c.fps); if (c.online) seen.set(c.id, e.at); }
    }
  }
  if (!heard) return null;
  const vision = visionFromEvents(events);
  return {
    at, cpu,
    cameras: vision.cameras.filter((c) => c.enabled).map((c) => ({
      id: c.id, name: c.name, online: !vision.offline.has(c.id), fps: fps.get(c.id) ?? null, lastSeen: seen.get(c.id) ?? null,
    })),
  };
};

/**
 * The sidebar's line: a camera offline first (the floor is guessing), else the mode with the
 * floor (Live), how far into the Shadow week, or how right the cameras were.
 */
export const visionPart = (events: readonly SyncEvent[], now: number): PartLine => {
  const down = offlineCameras(events, now);
  if (down.length) {
    const name = down[0].camera?.name ?? down[0].id;
    return { preview: down.length === 1 ? `${/camera$/i.test(name) ? name : `${name} camera`} offline` : `${down.length} cameras offline`, badge: down.length };
  }
  const { mode, cleanAlertS } = visionFromEvents(events).settings;
  if (mode === 'off') return { preview: 'Off', badge: 0 };
  if (mode === 'shadow') {
    const a = shadowAgreement(events, now);
    const day = a ? Math.floor((now - a.since) / DAY_MS) + 1 : 1;
    const preview = a && a.changes >= MIN_SHADOW_CHANGES ? `Shadow · right ${a.pct}%`
      : day <= SHADOW_DAYS ? `Shadow · day ${day} of ${SHADOW_DAYS}` : `Shadow · ${a?.changes ?? 0} changes seen`;
    return { preview, badge: 0 };
  }
  const tables = tablesFromEvents(events);
  const dirty = tables.filter((t) => t.state === 'needs_cleaning').length;
  return { preview: `Live · ${floorSummary(tables, now, cleanAlertS).free} free${dirty ? `, ${dirty} to clean` : ''}`, badge: 0 };
};
