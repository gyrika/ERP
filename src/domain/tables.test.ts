import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraLost, checkTableEvent, DEFAULT_LEAVE_S, DEFAULT_SEAT_S, DEFAULT_VISION_SETTINGS, footPoint, LEAVE_SHARE, newTracker,
  floorSummary, observe, pointInPolygon, SEAT_SHARE, staffSet, tableChanges, tablesFromEvents, visionFromEvents, type FloorTable, type Sample, type TableTracker,
} from './tables.ts';
import type { SyncEvent } from './sync.ts';
import type { Actor } from './auth.ts';

const S = 1000;
const owner: Actor = { id: 'owner-1', name: 'Anton', role: 'owner' };
const cashier: Actor = { id: 'cashier-1', name: 'Kasun', role: 'cashier' };

/** One sample a second from `from` to `to` seconds (both included); `present(i)` says who is there. */
const run = (t: TableTracker, from: number, to: number, present: (second: number) => boolean) => {
  const changes = [];
  for (let s = from; s <= to; s++) {
    const r = observe(t, { at: s * S, present: present(s) });
    t = r.tracker;
    if (r.change) changes.push(r.change);
  }
  return { tracker: t, changes };
};

/** `n` of the 60 samples in (0, 60] s are present (the last ones), on a tracker watching since 0. */
const seated = (n: number) => run(newTracker('free', 0), 0, 60, (s) => s > 60 - n);

test('the rules are named constants with the agreed defaults', () => {
  assert.equal(SEAT_SHARE, 0.7);
  assert.equal(LEAVE_SHARE, 0.9);
  assert.equal(DEFAULT_SEAT_S, 60);
  assert.equal(DEFAULT_LEAVE_S, 180);
  assert.deepEqual({ seatS: DEFAULT_VISION_SETTINGS.seatS, leaveS: DEFAULT_VISION_SETTINGS.leaveS, mode: DEFAULT_VISION_SETTINGS.mode },
    { seatS: 60, leaveS: 180, mode: 'off' });
});

test('free becomes occupied at 70% present over the last 60 s: 41 of 60 stays free, 42 of 60 is occupied', () => {
  const at41 = seated(41);
  assert.equal(at41.tracker.state, 'free');
  assert.deepEqual(at41.changes, []);
  const at42 = seated(42);
  assert.equal(at42.tracker.state, 'occupied');
  assert.deepEqual(at42.changes, [{ from: 'free', to: 'occupied', confidence: 0.7, at: 60 * S }]);
  assert.equal(at42.tracker.since, 60 * S);
});

test('nothing changes before a whole window has been watched', () => {
  // 59 s of people all present: not yet a full minute of evidence.
  const r = run(newTracker('free', 0), 0, 59, () => true);
  assert.equal(r.tracker.state, 'free');
  const next = observe(r.tracker, { at: 60 * S, present: true });
  assert.deepEqual(next.change, { from: 'free', to: 'occupied', confidence: 1, at: 60 * S });
});

test('reserved also becomes occupied when people sit', () => {
  const r = run(newTracker('reserved', 0), 0, 60, () => true);
  assert.equal(r.tracker.state, 'occupied');
  assert.equal(r.changes[0].from, 'reserved');
});

test('occupied becomes needs_cleaning at 90% absent over the last 180 s; just under stays occupied', () => {
  // 162 of 180 absent = 90%; 161 = 89.4%.
  const leave = (absent: number) => run(newTracker('occupied', 0), 0, 180, (s) => s <= 180 - absent);
  const under = leave(161);
  assert.equal(under.tracker.state, 'occupied');
  const at = leave(162);
  assert.equal(at.tracker.state, 'needs_cleaning');
  assert.deepEqual(at.changes, [{ from: 'occupied', to: 'needs_cleaning', confidence: 0.9, at: 180 * S }]);
});

test('samples older than the window are dropped', () => {
  const r = run(newTracker('occupied', 0), 0, 400, () => true);
  assert.ok(r.tracker.samples.every((x: Sample) => x.at > 400 * S - DEFAULT_LEAVE_S * S));
  assert.equal(r.tracker.samples.length, DEFAULT_LEAVE_S);
});

test('needs_cleaning never frees itself: only staff (C or F) frees it', () => {
  const dirty = run(newTracker('needs_cleaning', 0), 0, 600, () => false);
  assert.equal(dirty.tracker.state, 'needs_cleaning');
  // People sitting at a dirty table do not make it occupied either.
  const sat = run(dirty.tracker, 601, 700, () => true);
  assert.equal(sat.tracker.state, 'needs_cleaning');
  assert.equal(staffSet(sat.tracker, 'free', 701 * S).state, 'free');
});

test('a staff change holds until presence next flips, then the rules act again on fresh evidence', () => {
  // Cleaned: the table is empty when staff press C.
  const empty = run(newTracker('needs_cleaning', 0), 0, 100, () => false).tracker;
  let t = staffSet(empty, 'free', 101 * S);
  assert.equal(t.state, 'free');
  assert.equal(t.since, 101 * S);
  // Staff mark it occupied for a group not yet seen; absence alone does not undo that while it holds.
  t = staffSet(t, 'occupied', 102 * S);
  let r = run(t, 103, 500, () => false);
  assert.equal(r.tracker.state, 'occupied', 'still absent: no flip, the staff change holds');
  // People arrive (absent → present): the hold ends, and leaving now needs a full 180 s of evidence.
  r = run(r.tracker, 501, 510, () => true);
  assert.equal(r.tracker.hold, null);
  r = run(r.tracker, 511, 600, () => false);
  assert.equal(r.tracker.state, 'occupied', 'not yet 180 s since the flip');
  r = run(r.tracker, 601, 700, () => false);
  assert.equal(r.tracker.state, 'needs_cleaning');
});

test('staff free a table people still sit at: it stays free until they leave and someone sits again', () => {
  let r = run(newTracker('free', 0), 0, 60, () => true);
  assert.equal(r.tracker.state, 'occupied');
  let t = staffSet(r.tracker, 'free', 61 * S);
  r = run(t, 62, 200, () => true);
  assert.equal(r.tracker.state, 'free', 'present all along: no flip, it holds');
  r = run(r.tracker, 201, 205, () => false);
  assert.equal(r.tracker.hold, null, 'they left: the hold ends');
  r = run(r.tracker, 206, 260, () => true);
  assert.equal(r.tracker.state, 'free', 'the window after the flip is not full yet');
  r = run(r.tracker, 261, 270, () => true);
  assert.equal(r.tracker.state, 'occupied');
  t = r.tracker;
  assert.equal(r.changes[0].at, 261 * S);
  assert.equal(t.since, 261 * S);
});

test('a staff change with no samples yet takes the first sample as where presence stands', () => {
  let t = staffSet(newTracker('free', 0), 'reserved', 5 * S);
  t = observe(t, { at: 6 * S, present: true }).tracker;
  assert.deepEqual(t.hold, { present: true });
  t = run(t, 7, 300, () => true).tracker;
  assert.equal(t.state, 'reserved', 'present since the change: holds');
});

test('a table whose camera is lost reports noCamera and keeps its state; it starts afresh when the camera returns', () => {
  const r = run(newTracker('free', 0), 0, 60, () => true);
  let t = cameraLost(r.tracker);
  assert.equal(t.noCamera, true);
  assert.equal(t.state, 'occupied');
  assert.deepEqual(t.samples, []);
  // Back after ten minutes: one absent sample is not 180 s of evidence.
  const back = observe(t, { at: 700 * S, present: false });
  t = back.tracker;
  assert.equal(t.noCamera, false);
  assert.equal(back.change, null);
  t = run(t, 701, 879, () => false).tracker;
  assert.equal(t.state, 'occupied');
  t = observe(t, { at: 880 * S, present: false }).tracker;
  assert.equal(t.state, 'needs_cleaning');
});

test('custom timers', () => {
  const r = run(newTracker('free', 0), 0, 20, () => true);
  assert.equal(r.tracker.state, 'free');
  let t = newTracker('free', 0);
  for (let s = 0; s <= 20; s++) t = observe(t, { at: s * S, present: true }, { seatS: 20, leaveS: 30 }).tracker;
  assert.equal(t.state, 'occupied');
});

// ----- Points and polygons -----

const square = [{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.6, y: 0.6 }, { x: 0.2, y: 0.6 }];

test('point in polygon: inside, outside, and the edges and corners count as inside', () => {
  assert.equal(pointInPolygon({ x: 0.4, y: 0.4 }, square), true);
  assert.equal(pointInPolygon({ x: 0.1, y: 0.4 }, square), false);
  assert.equal(pointInPolygon({ x: 0.7, y: 0.4 }, square), false);
  assert.equal(pointInPolygon({ x: 0.4, y: 0.61 }, square), false);
  assert.equal(pointInPolygon({ x: 0.2, y: 0.4 }, square), true, 'on the left edge');
  assert.equal(pointInPolygon({ x: 0.4, y: 0.6 }, square), true, 'on the bottom edge');
  assert.equal(pointInPolygon({ x: 0.6, y: 0.2 }, square), true, 'on a corner');
  // A ray through a vertex is counted once.
  const diamond = [{ x: 0.5, y: 0.1 }, { x: 0.9, y: 0.5 }, { x: 0.5, y: 0.9 }, { x: 0.1, y: 0.5 }];
  assert.equal(pointInPolygon({ x: 0.3, y: 0.5 }, diamond), true);
  assert.equal(pointInPolygon({ x: 0.05, y: 0.5 }, diamond), false);
  // A concave polygon (an L): the notch is outside.
  const l = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.2 }, { x: 0.2, y: 0.2 }, { x: 0.2, y: 0.5 }, { x: 0, y: 0.5 }];
  assert.equal(pointInPolygon({ x: 0.1, y: 0.4 }, l), true);
  assert.equal(pointInPolygon({ x: 0.4, y: 0.4 }, l), false);
  // Fewer than three points is no area.
  assert.equal(pointInPolygon({ x: 0.2, y: 0.2 }, square.slice(0, 2)), false);
});

test('the foot point is the box centre across, 80% of the way down', () => {
  const p = footPoint({ x1: 0.2, y1: 0.1, x2: 0.4, y2: 0.6 });
  assert.ok(Math.abs(p.x - 0.3) < 1e-12);
  assert.ok(Math.abs(p.y - 0.5) < 1e-12);
  // A person whose head is outside the table's zone but whose seat is inside is at the table.
  assert.equal(pointInPolygon(footPoint({ x1: 0.3, y1: 0.0, x2: 0.5, y2: 0.5 }), square), true);
});

// ----- The floor, folded from events -----

let n = 0;
const ev = <T extends object>(e: T, at: number, actor: Actor = owner) =>
  ({ id: `e${++n}`, shopId: 'shop-1', at, orderNumber: 0, actor, ...e }) as unknown as SyncEvent;
const layout = (at = 0) => ev({ type: 'table.layout_set', tables: [{ id: 't1', label: 'T1', seats: 4 }, { id: 't2', label: 'T2', seats: 2 }] }, at);

test('the floor starts free from the layout, and follows camera and staff changes with since-when', () => {
  const floor = tablesFromEvents([
    layout(10),
    ev({ type: 'table.state_changed', tableId: 't1', from: 'free', to: 'occupied', confidence: 0.8 }, 100),
    ev({ type: 'table.state_set', tableId: 't2', from: 'free', to: 'reserved' }, 120, cashier),
  ]);
  assert.deepEqual(floor.map((t) => [t.id, t.label, t.seats, t.state, t.since]), [
    ['t1', 'T1', 4, 'occupied', 100],
    ['t2', 'T2', 2, 'reserved', 120],
  ]);
});

test('a camera change from a state the table is no longer in is stale and ignored; a staff change always applies', () => {
  const floor = tablesFromEvents([
    layout(),
    ev({ type: 'table.state_set', tableId: 't1', from: 'free', to: 'reserved' }, 50),
    ev({ type: 'table.state_changed', tableId: 't1', from: 'occupied', to: 'needs_cleaning', confidence: 0.95 }, 60),
    ev({ type: 'table.state_set', tableId: 't2', from: 'occupied', to: 'free' }, 70),
  ]);
  assert.equal(floor[0].state, 'reserved');
  assert.equal(floor[1].state, 'free');
});

test('the layout can change: kept tables keep their state, new ones start free, removed ones go', () => {
  const floor = tablesFromEvents([
    layout(),
    ev({ type: 'table.state_set', tableId: 't1', from: 'free', to: 'occupied' }, 50),
    ev({ type: 'table.layout_set', tables: [{ id: 't1', label: 'Window', seats: 6 }, { id: 't3', label: 'T3', seats: 2 }] }, 80),
  ]);
  assert.deepEqual(floor.map((t) => [t.id, t.label, t.seats, t.state, t.since]), [['t1', 'Window', 6, 'occupied', 50], ['t3', 'T3', 2, 'free', 80]]);
});

test('Undo of a staff change puts back the state and since-when it replaced; an Undo that is no longer last does nothing', () => {
  const set = ev({ type: 'table.state_set', tableId: 't1', from: 'needs_cleaning', to: 'free' }, 300, cashier);
  const base = [
    layout(),
    ev({ type: 'table.state_changed', tableId: 't1', from: 'free', to: 'occupied', confidence: 0.9 }, 100),
    ev({ type: 'table.state_changed', tableId: 't1', from: 'occupied', to: 'needs_cleaning', confidence: 0.92 }, 200),
    set,
  ];
  assert.equal(tablesFromEvents(base)[0].state, 'free');
  const undone = tablesFromEvents([...base, ev({ type: 'table.state_set_undone', tableId: 't1', undoneEventId: (set as { id: string }).id }, 305, cashier)]);
  assert.equal(undone[0].state, 'needs_cleaning');
  assert.equal(undone[0].since, 200);
  // Something else changed the table after the staff change: the Undo is stale.
  const late = tablesFromEvents([
    ...base,
    ev({ type: 'table.state_changed', tableId: 't1', from: 'free', to: 'occupied', confidence: 0.75 }, 400),
    ev({ type: 'table.state_set_undone', tableId: 't1', undoneEventId: (set as { id: string }).id }, 410, cashier),
  ]);
  assert.equal(late[0].state, 'occupied');
  // Undo of an unknown event does nothing.
  assert.equal(tablesFromEvents([...base, ev({ type: 'table.state_set_undone', tableId: 't1', undoneEventId: 'nope' }, 305)])[0].state, 'free');
});

test('a cleaning alert stays open until it is cleared by its own id', () => {
  const raised = ev({ type: 'table.alert_raised', tableId: 't1', alert: 'needs_cleaning' }, 500);
  const id = (raised as { id: string }).id;
  assert.equal(tablesFromEvents([layout(), raised])[0].alertId, id);
  assert.equal(tablesFromEvents([layout(), raised, ev({ type: 'table.alert_cleared', tableId: 't1', alertEventId: 'other' }, 510)])[0].alertId, id);
  assert.equal(tablesFromEvents([layout(), raised, ev({ type: 'table.alert_cleared', tableId: 't1', alertEventId: id }, 510)])[0].alertId, null);
});

const cameras = (at = 0) => ev({ type: 'vision.cameras_set', cameras: [
  { id: 'c1', name: 'Front', ip: '192.168.1.20', rtspPath: '/stream1', enabled: true },
  { id: 'c2', name: 'Back', ip: '192.168.1.21', rtspPath: '/stream1', enabled: true },
] }, at);
const zones = (cameraId: string, tableIds: string[], at = 0) => ev({ type: 'vision.zones_set', cameraId, zones: tableIds.map((tableId, i) => ({ id: `${cameraId}-z${i}`, tableId, points: square })) }, at);

test('noCamera: a watched table whose cameras are all offline keeps its last state and says so', () => {
  const start = [layout(), cameras(), zones('c1', ['t1']), zones('c2', ['t1', 't2']),
    ev({ type: 'table.state_changed', tableId: 't2', from: 'free', to: 'occupied', confidence: 0.8 }, 100)];
  let floor = tablesFromEvents(start);
  assert.deepEqual(floor.map((t) => [t.watched, t.noCamera]), [[true, false], [true, false]]);
  floor = tablesFromEvents([...start, ev({ type: 'vision.camera_offline', cameraId: 'c2' }, 200)]);
  assert.deepEqual(floor.map((t) => [t.id, t.noCamera, t.state]), [['t1', false, 'free'], ['t2', true, 'occupied']], 't1 still has c1');
  floor = tablesFromEvents([...start, ev({ type: 'vision.camera_offline', cameraId: 'c2' }, 200), ev({ type: 'vision.camera_online', cameraId: 'c2' }, 300)]);
  assert.equal(floor[1].noCamera, false);
  // A heartbeat saying a camera is down counts too.
  floor = tablesFromEvents([...start, ev({ type: 'vision.heartbeat', cameras: [{ id: 'c1', online: true, fps: 2 }, { id: 'c2', online: false, fps: 0 }], cpu: 40 }, 400)]);
  assert.equal(floor[1].noCamera, true);
  // A disabled camera watches nothing.
  floor = tablesFromEvents([...start, ev({ type: 'vision.cameras_set', cameras: [{ id: 'c1', name: 'Front', ip: '192.168.1.20', rtspPath: '/stream1', enabled: true }, { id: 'c2', name: 'Back', ip: '192.168.1.21', rtspPath: '/stream1', enabled: false }] }, 500)]);
  assert.deepEqual(floor.map((t) => [t.watched, t.noCamera]), [[true, false], [false, false]]);
  // No camera at all: not watched, and not "no camera" either (staff run it by hand).
  assert.deepEqual(tablesFromEvents([layout()]).map((t) => [t.watched, t.noCamera]), [[false, false], [false, false]]);
});

test('vision settings, cameras and zones fold to their latest values', () => {
  assert.deepEqual(visionFromEvents([]).settings, DEFAULT_VISION_SETTINGS);
  const v = visionFromEvents([cameras(), zones('c1', ['t1']), zones('c1', ['t2']),
    ev({ type: 'vision.settings_set', mode: 'shadow', seatS: 90, leaveS: 240, cleanAlertS: 120 }, 10)]);
  assert.deepEqual(v.settings, { mode: 'shadow', seatS: 90, leaveS: 240, cleanAlertS: 120 });
  assert.deepEqual(v.cameras.map((c) => c.id), ['c1', 'c2']);
  assert.deepEqual(v.zones.c1.map((z) => z.tableId), ['t2']);
  assert.deepEqual([...v.offline], []);
});

// ----- What the server accepts -----

const valid = (e: SyncEvent) => checkTableEvent(e as unknown as Record<string, unknown>);

test('the server accepts every well-formed table and vision event', () => {
  for (const e of [
    layout(), cameras(), zones('c1', ['t1']),
    ev({ type: 'table.state_changed', tableId: 't1', from: 'free', to: 'occupied', confidence: 0.7 }, 1),
    ev({ type: 'table.state_set', tableId: 't1', from: 'needs_cleaning', to: 'free' }, 1),
    ev({ type: 'table.state_set_undone', tableId: 't1', undoneEventId: 'e1' }, 1),
    ev({ type: 'table.alert_raised', tableId: 't1', alert: 'needs_cleaning' }, 1),
    ev({ type: 'table.alert_cleared', tableId: 't1', alertEventId: 'e1' }, 1),
    ev({ type: 'vision.settings_set', mode: 'live', seatS: 60, leaveS: 180, cleanAlertS: 300 }, 1),
    ev({ type: 'vision.camera_offline', cameraId: 'c1' }, 1),
    ev({ type: 'vision.camera_online', cameraId: 'c1' }, 1),
    ev({ type: 'vision.heartbeat', cameras: [{ id: 'c1', online: true, fps: 2.5 }], cpu: 37.5 }, 1),
  ]) assert.equal(valid(e), null, (e as { type: string }).type);
});

test('the server refuses malformed table and vision events, and any password or image', () => {
  const bad = [
    ev({ type: 'table.layout_set', tables: [{ id: 't1', label: 'T1', seats: 0 }] }, 1),
    ev({ type: 'table.layout_set', tables: [{ id: 't1', label: 'T1', seats: 4 }, { id: 't1', label: 'T1b', seats: 4 }] }, 1),
    ev({ type: 'table.state_changed', tableId: 't1', from: 'free', to: 'gone', confidence: 0.7 }, 1),
    ev({ type: 'table.state_changed', tableId: 't1', from: 'free', to: 'occupied', confidence: 1.5 }, 1),
    ev({ type: 'table.state_changed', tableId: 't1', from: 'free', to: 'free', confidence: 0.9 }, 1),
    ev({ type: 'table.state_set', tableId: '', from: 'free', to: 'reserved' }, 1),
    ev({ type: 'table.alert_raised', tableId: 't1', alert: 'fire' }, 1),
    ev({ type: 'table.alert_cleared', tableId: 't1' }, 1),
    ev({ type: 'vision.cameras_set', cameras: [{ id: 'c1', name: 'Front', ip: '192.168.1.20', rtspPath: '/stream1', enabled: true, password: 'x' }] }, 1),
    ev({ type: 'vision.cameras_set', cameras: [{ id: 'c1', name: 'Front', ip: 'admin:secret@192.168.1.20', rtspPath: '/stream1', enabled: true }] }, 1),
    ev({ type: 'vision.cameras_set', cameras: [{ id: 'c1', name: 'Front', ip: '192.168.1.20', rtspPath: 'rtsp://admin:secret@x/stream1', enabled: true }] }, 1),
    ev({ type: 'vision.cameras_set', cameras: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: 'C', ip: '192.168.1.20', rtspPath: '/s', enabled: true })) }, 1),
    ev({ type: 'vision.zones_set', cameraId: 'c1', zones: [{ id: 'z', tableId: 't1', points: [{ x: 0, y: 0 }, { x: 1.2, y: 0 }, { x: 1, y: 1 }] }] }, 1),
    ev({ type: 'vision.zones_set', cameraId: 'c1', zones: [{ id: 'z', tableId: 't1', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] }, 1),
    ev({ type: 'vision.settings_set', mode: 'on', seatS: 60, leaveS: 180, cleanAlertS: 300 }, 1),
    ev({ type: 'vision.settings_set', mode: 'live', seatS: 0, leaveS: 180, cleanAlertS: 300 }, 1),
    ev({ type: 'vision.heartbeat', cameras: [{ id: 'c1', online: 'yes', fps: 2 }], cpu: 40 }, 1),
    ev({ type: 'vision.heartbeat', cameras: [], cpu: 40, frame: 'data:image/jpeg;base64,AAAA' }, 1),
    ev({ type: 'vision.camera_offline', cameraId: 'c1', snapshot: 'AAAA' }, 1),
    { ...(layout() as object), orderNumber: 1001 } as unknown as SyncEvent,
  ];
  for (const e of bad) assert.ok(valid(e), JSON.stringify(e));
});

// ----- The Register's Tables chip (SCRUM-168) -----

const tile = (state: FloorTable['state'], sinceS: number, alertId: string | null = null): FloorTable =>
  ({ id: `t-${state}-${sinceS}`, label: '1', seats: 4, state, since: sinceS * S, watched: false, noCamera: false, alertId });

test('the chip counts free tables, and takes the colour of the most urgent one', () => {
  assert.deepEqual(floorSummary([], 0), { free: 0, tone: null });
  assert.deepEqual(floorSummary([tile('free', 0), tile('occupied', 0), tile('reserved', 0), tile('free', 0)], 10 * S), { free: 2, tone: null });
  // A dirty table is amber while it is new, red once it has waited the cleaning-alert time (300 s), or an alert is open.
  assert.deepEqual(floorSummary([tile('free', 0), tile('needs_cleaning', 0)], 299 * S), { free: 1, tone: 'warn' });
  assert.deepEqual(floorSummary([tile('needs_cleaning', 0)], 300 * S), { free: 0, tone: 'bad' });
  assert.deepEqual(floorSummary([tile('needs_cleaning', 100, 'alert-1'), tile('needs_cleaning', 100)], 101 * S), { free: 0, tone: 'bad' });
  assert.deepEqual(floorSummary([tile('needs_cleaning', 0)], 60 * S, 60), { free: 0, tone: 'bad' }, 'the owner\'s own alert time');
  assert.deepEqual(floorSummary([tile('needs_cleaning', 0)], 60 * S, 0), { free: 0, tone: 'warn' }, '0: no cleaning alert');
});

test('the changes the floor took, in order and by whom: stale camera changes are left out, an Undo says so', () => {
  const set = ev({ type: 'table.state_set', tableId: 't1', from: 'occupied', to: 'free' }, 300, cashier);
  const changes = tableChanges([
    layout(),
    ev({ type: 'table.state_changed', tableId: 't1', from: 'free', to: 'occupied', confidence: 0.9 }, 100),
    ev({ type: 'table.state_changed', tableId: 't2', from: 'occupied', to: 'needs_cleaning', confidence: 0.9 }, 150), // stale: t2 is free
    set,
    ev({ type: 'table.state_set_undone', tableId: 't1', undoneEventId: (set as { id: string }).id }, 310, cashier),
  ]);
  assert.deepEqual(changes.map((c) => [c.tableId, c.from, c.to, c.at, c.by]), [
    ['t1', 'free', 'occupied', 100, 'camera'],
    ['t1', 'occupied', 'free', 300, 'staff'],
    ['t1', 'free', 'occupied', 310, 'undo'],
  ]);
});
