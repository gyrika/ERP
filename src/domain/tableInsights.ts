import type { Insight, InsightItem } from './insights.ts';
import type { SyncEvent } from './sync.ts';
import { tableChanges, tablesFromEvents, visionFromEvents } from './tables.ts';

/**
 * The Owner view's table and camera cards (CV v1, SCRUM-172). Pure, like insights.ts: events in,
 * cards out, in the shop's local time. Only what the cameras saw counts, so a shop without
 * cameras (or one that sets its tables by hand) sees none of these cards.
 */

/** Busy tables speak at this many percent from the usual, like the sales card. */
export const BUSY_PCT = 20;
/** Shorter than this is someone standing by a table (a takeaway wait), not a visit. */
export const MIN_VISIT_MIN = 5;
/** Longer than this is a camera that kept seeing a coat on a chair, not a visit. */
export const MAX_VISIT_MIN = 180;
/** Days of camera data in the last 28 before tables are compared with each other. */
export const MIN_DATA_DAYS = 14;
/** A camera back within this long was a Wi-Fi blip, not worth the owner's time. */
export const MIN_OFFLINE_MIN = 2;

const MIN = 60_000;
const DAY_MS = 24 * 60 * MIN;
const startOfDay = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const minuteOfDay = (t: number): number => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };
const weeksBack = (dayStart: number, k: number): number => { const d = new Date(dayStart); d.setDate(d.getDate() - 7 * k); return d.getTime(); };
const daysBack = (dayStart: number, k: number): number => { const d = new Date(dayStart); d.setDate(d.getDate() - k); return d.getTime(); };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const clock = (t: number): string => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dateLabel = (t: number): string => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const hourLabel = (t: number): string => { const h = new Date(t).getHours(); return `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`; };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** How long, rounded down: "25 min", "3 h", "2 days". */
const howLong = (ms: number): string => {
  const m = Math.floor(ms / MIN);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : plural(Math.floor(h / 24), 'day');
};
const hours = (ms: number): string => `${Math.round(ms / (60 * MIN))} h`;

// ----- visits -----

export interface Visit { tableId: string; start: number; end: number | null }

/**
 * Each visit the cameras saw: from the camera seeing the table taken to the table left (the camera
 * seeing it empty, or staff freeing it). A table staff marked taken is not a visit (no camera saw
 * it), and a staff change they undid is not an end. Visits under `MIN_VISIT_MIN` or over
 * `MAX_VISIT_MIN` are dropped; one still under way (end null) counts once it has lasted the minimum.
 */
export const visitsFrom = (events: readonly SyncEvent[], now = Infinity): Visit[] => {
  const open = new Map<string, number>(); // table → start of its visit under way
  const endedByStaff = new Map<string, Visit>(); // table → its last visit, when staff ended it (an Undo reopens it)
  const done: Visit[] = [];
  for (const c of tableChanges(events)) {
    const start = open.get(c.tableId);
    if (c.to === 'occupied') {
      const back = endedByStaff.get(c.tableId);
      if (c.by === 'undo' && back) { done.splice(done.indexOf(back), 1); open.set(c.tableId, back.start); }
      else if (c.by === 'camera') open.set(c.tableId, c.at);
      endedByStaff.delete(c.tableId);
      continue;
    }
    if (start === undefined || c.from !== 'occupied') continue;
    open.delete(c.tableId);
    endedByStaff.delete(c.tableId);
    if (c.to === 'reserved') continue; // not someone leaving: a correction
    const v = { tableId: c.tableId, start, end: c.at };
    done.push(v);
    if (c.by !== 'camera') endedByStaff.set(c.tableId, v);
  }
  const lasted = (v: Visit) => (v.end ?? now) - v.start;
  return [...done, ...[...open].map(([tableId, start]) => ({ tableId, start, end: null }))]
    .filter((v) => lasted(v) >= MIN_VISIT_MIN * MIN && (v.end === null || lasted(v) <= MAX_VISIT_MIN * MIN))
    .sort((a, b) => a.start - b.start);
};

/** "Table 3"; `lower` for mid-sentence ("table 3"), leaving the owner's own label as he wrote it. */
const tableName = (events: readonly SyncEvent[]) => {
  const labels = new Map(tablesFromEvents(events).map((t) => [t.id, t.label]));
  return (id: string, lower = false) => `${lower ? 'table' : 'Table'} ${labels.get(id) ?? id}`;
};
const onDay = (v: Visit, day: number) => v.start >= day && v.start < day + DAY_MS;

// ----- the rules -----

/**
 * Visits so far today against the last 4 same weekdays by this time: the sales card's way. Tables
 * whose camera is offline now are left out of every day, so a dark camera never reads as a quiet day.
 */
export const tablesVsUsual = (events: readonly SyncEvent[], now: number): Insight | null => {
  const dark = new Set(offlineCameras(events, now).flatMap((c) => c.tableIds));
  const visits = visitsFrom(events, now).filter((v) => !dark.has(v.tableId));
  if (!visits.length) return null;
  const today = startOfDay(now);
  const upTo = minuteOfDay(now);
  const byNow = (day: number) => visits.filter((v) => onDay(v, day) && minuteOfDay(v.start) <= upTo).length;
  const past = [1, 2, 3, 4].map((k) => weeksBack(today, k))
    .filter((day) => visits.some((v) => onDay(v, day)))
    .map((day) => ({ day, count: byNow(day) }));
  if (past.length < 3) return null; // not enough history to know "usual"
  const usual = Math.round(past.reduce((n, d) => n + d.count, 0) / past.length);
  if (usual < 5) return null; // too early in the day to judge
  const sofar = byNow(today);
  const pct = Math.round(((sofar - usual) / usual) * 100);
  if (Math.abs(pct) < BUSY_PCT) return null;
  return {
    id: 'tables-vs-usual',
    tone: pct < 0 ? 'attention' : 'good',
    title: `Tables ${Math.abs(pct)}% ${pct < 0 ? 'quieter' : 'busier'} than a usual ${WEEKDAYS[new Date(now).getDay()]}`,
    detail: `${plural(sofar, 'visit')} so far; usually ${usual} by ${hourLabel(now)}.`,
    action: {
      label: 'Compare',
      items: [
        { primary: `Today, by ${clock(now)}`, secondary: plural(sofar, 'visit') },
        ...past.map((d) => ({ primary: dateLabel(d.day), secondary: `${plural(d.count, 'visit')} by ${clock(now)}` })),
      ],
    },
  };
};

/** How long guests stay today against the last 28 days (finished visits only). */
export const visitLength = (events: readonly SyncEvent[], now: number): Insight | null => {
  const today = startOfDay(now);
  const visits = visitsFrom(events, now).filter((v): v is Visit & { end: number } => v.end !== null && v.end <= now);
  const todays = visits.filter((v) => v.start >= today);
  const before = visits.filter((v) => v.start >= daysBack(today, 28) && v.start < today);
  if (todays.length < 5 || before.length < 20) return null;
  const avg = (xs: { start: number; end: number }[]) => xs.reduce((n, v) => n + (v.end - v.start), 0) / xs.length / MIN;
  const todayMin = Math.round(avg(todays));
  const usual = Math.round(avg(before));
  const pct = Math.round(((todayMin - usual) / usual) * 100);
  if (Math.abs(pct) < 20) return null;
  const name = tableName(events);
  return {
    id: 'visit-length',
    tone: 'info',
    title: `Guests staying ${Math.abs(todayMin - usual)} min ${todayMin > usual ? 'longer' : 'shorter'} than usual`,
    detail: `${todayMin} min a visit today; usually ${usual} min.`,
    action: {
      label: 'See visits',
      items: [...todays].sort((a, b) => b.start - a.start).map((v): InsightItem => ({ primary: name(v.tableId), secondary: `${Math.round((v.end - v.start) / MIN)} min`, at: v.start })),
    },
  };
};

/** The busiest and the quietest table over 28 days, when one is used at least twice as much. */
export const tableUse = (events: readonly SyncEvent[], now: number): Insight | null => {
  const today = startOfDay(now);
  const from = daysBack(today, 28);
  const visits = visitsFrom(events, now).filter((v): v is Visit & { end: number } => v.end !== null && v.start >= from && v.start < today);
  const days = new Set(visits.map((v) => startOfDay(v.start))).size;
  if (days < MIN_DATA_DAYS) return null;
  // Every table a camera watches: one nobody sat at is the clearest case of all.
  const watched = tablesFromEvents(events).filter((t) => t.watched);
  if (watched.length < 2) return null;
  const name = tableName(events);
  const use = watched.map((t) => {
    const mine = visits.filter((v) => v.tableId === t.id);
    return { id: t.id, ms: mine.reduce((n, v) => n + v.end - v.start, 0), count: mine.length };
  }).sort((a, b) => b.ms - a.ms);
  const top = use[0];
  const low = use[use.length - 1];
  if (top.ms < 10 * 60 * MIN || top.ms < 2 * low.ms) return null;
  const quiet = name(low.id, true);
  return {
    id: 'table-use',
    tone: 'info',
    title: `${name(top.id)} busiest, ${quiet} quietest`,
    detail: `Last 4 weeks: ${hours(top.ms)} against ${hours(low.ms)}. Worth moving or changing ${quiet}?`,
    action: { label: 'All tables', items: use.map((u) => ({ primary: name(u.id), secondary: `${hours(u.ms)} · ${plural(u.count, 'visit')}` })) },
  };
};

/** Cameras offline now, with no sign of them since (an "online", or a heartbeat saying so), longest first. */
export const offlineCameras = (events: readonly SyncEvent[], now: number) => {
  const since = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'vision.camera_offline') { if (!since.has(e.cameraId)) since.set(e.cameraId, e.at); }
    else if (e.type === 'vision.camera_online') since.delete(e.cameraId);
    else if (e.type === 'vision.heartbeat') {
      for (const c of e.cameras) { if (c.online) since.delete(c.id); else if (!since.has(c.id)) since.set(c.id, e.at); }
    }
  }
  const vision = visionFromEvents(events);
  const configured = events.some((e) => e.type === 'vision.cameras_set');
  return [...since]
    .map(([id, at]) => ({ id, at, camera: vision.cameras.find((c) => c.id === id), tableIds: (vision.zones[id] ?? []).map((z) => z.tableId) }))
    // A camera the owner has since removed or switched off is not missing.
    .filter((c) => (!configured || c.camera?.enabled) && now - c.at >= MIN_OFFLINE_MIN * MIN)
    .sort((a, b) => a.at - b.at);
};

/** A camera offline: named, and for how long. It needs attention, so it leads the feed. */
export const camerasOffline = (events: readonly SyncEvent[], now: number): Insight | null => {
  const down = offlineCameras(events, now);
  if (!down.length) return null;
  const labels = new Map(tablesFromEvents(events).map((t) => [t.id, t.label]));
  const named = down.map((c) => {
    const name = c.camera?.name ?? c.id;
    const tables = [...new Set(c.tableIds.map((id) => labels.get(id) ?? id))];
    return { ...c, name, called: /camera$/i.test(name) ? name : `${name} camera`, tables };
  });
  const [first] = named;
  return {
    id: 'camera-offline',
    tone: 'attention',
    title: named.length === 1 ? `${first.called} offline for ${howLong(now - first.at)}` : `${named.length} cameras offline`,
    detail: named.length === 1
      ? 'Its tables show the last state it saw. Check its power and Wi-Fi.'
      : `${named.map((c) => `${c.name} ${howLong(now - c.at)}`).join(', ')}. Their tables show the last state seen.`,
    action: {
      label: 'See cameras',
      items: named.map((c) => ({ primary: c.name, secondary: `offline since ${clock(c.at)}${c.tables.length ? ` · tables ${c.tables.join(', ')}` : ''}` })),
    },
  };
};

