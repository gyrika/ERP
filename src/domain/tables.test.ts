import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoFreeAt, cameraLost, checkTableEvent, CPU_LIMIT_STEP, DEFAULT_AUTO_FREE_S, DEFAULT_CPU_LIMIT, DEFAULT_LEFT_CHECK_S, DEFAULT_SHORT_VISIT_S,
  DEFAULT_TIMERS, DEFAULT_VISION_SETTINGS, footPoint, newTracker, floorSummary, MAX_CPU_LIMIT, MIN_CPU_LIMIT, newlyDirty, observe, pointInPolygon,
  staffSet, tableChanges, tablesFromEvents, timersOf, visionFromEvents, type Change, type FloorTable, type TableTracker,
} from './tables.ts';
import type { SyncEvent } from './sync.ts';
import type { Actor } from './auth.ts';

const S = 1000;
const owner: Actor = { id: 'owner-1', name: 'Anton', role: 'owner' };
const cashier: Actor = { id: 'cashier-1', name: 'Kasun', role: 'cashier' };

/** One frame a second from `from` to `to` seconds (both included); `present(i)` says who is there. */
const run = (t: TableTracker, from: number, to: number, present: (second: number) => boolean, timers = DEFAULT_TIMERS) => {
  const changes: Change[] = [];
  for (let s = from; s <= to; s++) {
    const r = observe(t, { at: s * S, present: present(s) }, timers);
    t = r.tracker;
    if (r.change) changes.push(r.change);
  }
  return { tracker: t, changes };
};

/** A visit: people at the table for seconds [0, lastPresent], then empty until `until`. */
const visit = (lastPresent: number, until = lastPresent + 60) => run(newTracker('free', 0), 0, until, (s) => s <= lastPresent);

test('the owner\'s timers (2026-10-26) are named constants: a 3 min short visit, a 10 s left check, free again after 5 min', () => {
  assert.deepEqual([DEFAULT_SHORT_VISIT_S, DEFAULT_LEFT_CHECK_S, DEFAULT_AUTO_FREE_S], [180, 10, 300]);
  assert.deepEqual(DEFAULT_TIMERS, { shortVisitS: 180, leftCheckS: 10, autoFreeS: 300 });
  assert.deepEqual(DEFAULT_VISION_SETTINGS, { mode: 'off', shortVisitS: 180, leftCheckS: 10, autoFreeS: 300, cpuLimit: 15 });
  assert.deepEqual(timersOf(DEFAULT_VISION_SETTINGS), DEFAULT_TIMERS);
});

test('free becomes occupied on the first frame with a person: no waiting window', () => {
  let r = observe(newTracker('free', 0), { at: 5 * S, present: false });
  assert.equal(r.change, null);
  r = observe(r.tracker, { at: 6 * S, present: true });
  assert.deepEqual(r.change, { from: 'free', to: 'occupied', confidence: 1, at: 6 * S });
  assert.equal(r.tracker.state, 'occupied');
  assert.equal(r.tracker.since, 6 * S);
  // The detector's confidence rides along when the worker gives it.
  assert.equal(observe(newTracker('free', 0), { at: S, present: true, confidence: 0.834 }).change?.confidence, 0.83);
});

test('reserved becomes occupied when someone sits there', () => {
  const r = observe(newTracker('reserved', 0), { at: 40 * S, present: true });
  assert.deepEqual(r.change, { from: 'reserved', to: 'occupied', confidence: 1, at: 40 * S });
});

test('left is confirmed after 10 s empty, not on the first empty frame', () => {
  // Present for [0, 199]; empty from 200. Left at 210, 10 s after the first empty frame.
  const r = run(newTracker('free', 0), 0, 209, (s) => s < 200);
  assert.equal(r.tracker.state, 'occupied', '9 s empty: still checking');
  assert.equal(r.tracker.emptySince, 200 * S);
  const left = observe(r.tracker, { at: 210 * S, present: false });
  assert.deepEqual(left.change, { from: 'occupied', to: 'needs_cleaning', confidence: 1, at: 210 * S });
  assert.equal(left.tracker.emptySince, null);
});

test('a missed frame shorter than the check does not end the visit', () => {
  const r = run(newTracker('free', 0), 0, 400, (s) => s !== 100 && !(s >= 250 && s <= 255));
  assert.deepEqual(r.changes.map((c) => c.to), ['occupied']);
  assert.equal(r.tracker.state, 'occupied');
  assert.equal(r.tracker.emptySince, null);
});

test('a person back within the check: the visit goes on, and the check starts again from the next empty frame', () => {
  // Empty 200-208, back at 209, empty again from 300: left at 310, measured from 300.
  const r = run(newTracker('free', 0), 0, 320, (s) => s < 200 || (s >= 209 && s < 300));
  assert.deepEqual(r.changes.map((c) => [c.to, c.at]), [['occupied', 0], ['needs_cleaning', 310 * S]]);
});

test('a visit of 2:59 is short: straight back to free, no cleaning; 3:00 needs cleaning', () => {
  // Occupied at 0; the visit ends at the first empty frame.
  const short = visit(178); // empty from 179: 2:59
  assert.deepEqual(short.changes.map((c) => [c.from, c.to, c.at]), [['free', 'occupied', 0], ['occupied', 'free', 189 * S]]);
  assert.equal(short.tracker.state, 'free');
  const long = visit(179); // empty from 180: 3:00
  assert.deepEqual(long.changes.map((c) => [c.from, c.to, c.at]), [['free', 'occupied', 0], ['occupied', 'needs_cleaning', 190 * S]]);
});

test('needs cleaning frees itself after 5 min: still dirty at 4:59, free at 5:00', () => {
  const dirty = visit(299, 310).tracker; // needs_cleaning since 310 s
  assert.equal(dirty.state, 'needs_cleaning');
  assert.equal(dirty.since, 310 * S);
  const at459 = run(dirty, 311, 310 + 299, () => false);
  assert.equal(at459.tracker.state, 'needs_cleaning');
  assert.deepEqual(at459.changes, []);
  const at5 = observe(at459.tracker, { at: (310 + 300) * S, present: false });
  assert.deepEqual(at5.change, { from: 'needs_cleaning', to: 'free', confidence: 1, at: 610 * S });
});

test('someone sitting at a table that needs cleaning does not make it occupied; once it frees itself, the next frame does', () => {
  const dirty = visit(299, 310).tracker;
  let r = run(dirty, 311, 609, () => true);
  assert.equal(r.tracker.state, 'needs_cleaning');
  r = run(r.tracker, 610, 611, () => true);
  assert.deepEqual(r.changes.map((c) => [c.from, c.to, c.at]), [['needs_cleaning', 'free', 610 * S], ['free', 'occupied', 611 * S]]);
});

test('staff free a dirty table during the 5 min (C or F): it is free at once, and the next guest makes it occupied', () => {
  const dirty = visit(299, 310).tracker;
  let t = run(dirty, 311, 400, () => false).tracker;
  t = staffSet(t, 'free', 401 * S);
  assert.deepEqual([t.state, t.since], ['free', 401 * S]);
  // No auto-free is pending on a free table.
  let r = run(t, 402, 800, () => false);
  assert.deepEqual(r.changes, []);
  r = run(r.tracker, 801, 801, () => true);
  assert.deepEqual(r.changes.map((c) => [c.from, c.to]), [['free', 'occupied']]);
});

test('a staff change holds until presence next flips; that frame is then judged by the rules', () => {
  // Staff free a table people still sit at (e.g. the camera takes a waiter for a guest): it holds.
  const seated = run(newTracker('free', 0), 0, 60, () => true).tracker;
  let t = staffSet(seated, 'free', 61 * S);
  let r = run(t, 62, 200, () => true);
  assert.equal(r.tracker.state, 'free', 'present all along: no flip, it holds');
  r = run(r.tracker, 201, 205, () => false);
  assert.equal(r.tracker.hold, null, 'they left: the hold ends');
  r = run(r.tracker, 206, 206, () => true);
  assert.deepEqual(r.changes.map((c) => [c.to, c.at]), [['occupied', 206 * S]], 'the next guest: occupied at once');
  // Staff seat a group not yet seen (O): absence alone does not end it.
  t = staffSet(newTracker('free', 0), 'occupied', 10 * S);
  t = observe(t, { at: 11 * S, present: false }).tracker;
  r = run(t, 12, 500, () => false);
  assert.equal(r.tracker.state, 'occupied');
  // They sit (the flip), the visit counts from the staff change, and they leave after 3 min.
  r = run(r.tracker, 501, 600, () => true);
  r = run(r.tracker, 601, 611, () => false);
  assert.deepEqual(r.changes.map((c) => [c.from, c.to, c.at]), [['occupied', 'needs_cleaning', 611 * S]]);
});

test('staff reserve an empty table: someone sitting there makes it occupied', () => {
  let t = run(newTracker('free', 0), 0, 5, () => false).tracker;
  t = staffSet(t, 'reserved', 6 * S);
  let r = run(t, 7, 100, () => false);
  assert.equal(r.tracker.state, 'reserved');
  r = run(r.tracker, 101, 101, () => true);
  assert.deepEqual(r.changes, [{ from: 'reserved', to: 'occupied', confidence: 1, at: 101 * S }]);
});

test('a staff change with no frames yet takes the first frame as where presence stands', () => {
  let t = staffSet(newTracker('free', 0), 'reserved', 5 * S);
  t = observe(t, { at: 6 * S, present: true }).tracker;
  assert.deepEqual(t.hold, { present: true });
  t = run(t, 7, 300, () => true).tracker;
  assert.equal(t.state, 'reserved', 'present since the change: holds');
});

test('staff mark a table to clean: it still frees itself after 5 min, hold or not', () => {
  let t = run(newTracker('free', 0), 0, 30, () => true).tracker;
  t = staffSet(t, 'needs_cleaning', 31 * S);
  const r = run(t, 32, 331, () => true);
  assert.deepEqual(r.changes.map((c) => [c.from, c.to, c.at]), [['needs_cleaning', 'free', 331 * S]]);
});

test('a table whose camera is lost says noCamera and keeps its state, with no left check or auto-free; it judges afresh when frames come back', () => {
  let t = run(newTracker('free', 0), 0, 205, (s) => s < 200).tracker; // occupied, 6 s into a left check
  t = cameraLost(t);
  assert.deepEqual([t.noCamera, t.state, t.emptySince], [true, 'occupied', null]);
  // Back ten minutes later, empty: the check starts again from that frame.
  let r = run(t, 800, 809, () => false);
  assert.equal(r.tracker.noCamera, false);
  assert.equal(r.tracker.state, 'occupied');
  r = run(r.tracker, 810, 810, () => false);
  assert.deepEqual(r.changes.map((c) => [c.to, c.at]), [['needs_cleaning', 810 * S]]);
  // A dirty table does not free itself while its camera is away (no frames come), and does on the first frame back.
  const away = cameraLost(r.tracker);
  r = run(away, 2000, 2000, () => false);
  assert.deepEqual(r.changes.map((c) => [c.from, c.to]), [['needs_cleaning', 'free']]);
});

test('custom timers', () => {
  const timers = { shortVisitS: 60, leftCheckS: 3, autoFreeS: 120 };
  const r = run(newTracker('free', 0), 0, 200, (s) => s < 60, timers);
  assert.deepEqual(r.changes.map((c) => [c.to, c.at]), [['occupied', 0], ['needs_cleaning', 63 * S], ['free', 183 * S]]);
  assert.deepEqual(run(newTracker('free', 0), 0, 70, (s) => s < 59, timers).changes.map((c) => c.to), ['occupied', 'free'], '59 s: a short visit');
});

test('time-zone safe: the tracker reads no clock, so a visit across local midnight in any zone comes out the same', () => {
  // 2026-10-26 23:58:00 UTC; whatever TZ the test runs in, only the differences count.
  const base = Date.UTC(2026, 9, 26, 23, 58, 0);
  let t = newTracker('free', base);
  const changes: Change[] = [];
  for (let s = 0; s <= 400; s++) {
    const r = observe(t, { at: base + s * S, present: s < 240 });
    t = r.tracker;
    if (r.change) changes.push(r.change);
  }
  assert.deepEqual(changes.map((c) => [c.to, (c.at - base) / S]), [['occupied', 0], ['needs_cleaning', 250]]);
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

test('the new rules in the fold: a short visit, a staff free during the 5 min with its Undo, and the auto-free', () => {
  const live = ev({ type: 'vision.settings_set', mode: 'live', shortVisitS: 180, leftCheckS: 10, autoFreeS: 300 }, 1);
  const seen = (at: number, from: string, to: string) => ev({ type: 'table.state_changed', tableId: 't1', from, to, confidence: 1 }, at * S);
  // A short visit: occupied, then straight back to free.
  assert.deepEqual(tablesFromEvents([layout(), live, seen(10, 'free', 'occupied'), seen(100, 'occupied', 'free')]).map((t) => [t.state, t.since])[0], ['free', 100 * S]);
  // A long one: needs cleaning; the cashier wipes it at 400 s (C), then undoes it.
  const wiped = ev({ type: 'table.state_set', tableId: 't1', from: 'needs_cleaning', to: 'free' }, 400 * S, cashier);
  const base = [layout(), live, seen(10, 'free', 'occupied'), seen(300, 'occupied', 'needs_cleaning'), wiped];
  assert.equal(tablesFromEvents(base)[0].state, 'free');
  // The camera's auto-free at 600 s is stale after the wipe: the table is already free.
  assert.deepEqual(tableChanges([...base, seen(600, 'needs_cleaning', 'free')]).map((c) => [c.to, c.by]),
    [['occupied', 'camera'], ['needs_cleaning', 'camera'], ['free', 'staff']]);
  const undone = [...base, ev({ type: 'table.state_set_undone', tableId: 't1', undoneEventId: (wiped as { id: string }).id }, 405 * S, cashier)];
  assert.deepEqual([tablesFromEvents(undone)[0].state, tablesFromEvents(undone)[0].since], ['needs_cleaning', 300 * S], 'Undo puts back the wait, and its start');
  // With the wipe undone, the auto-free applies.
  assert.deepEqual([tablesFromEvents([...undone, seen(600, 'needs_cleaning', 'free')])[0].state], ['free']);
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
    ev({ type: 'vision.settings_set', mode: 'shadow', shortVisitS: 120, leftCheckS: 15, autoFreeS: 600 }, 10)]);
  assert.deepEqual(v.settings, { mode: 'shadow', shortVisitS: 120, leftCheckS: 15, autoFreeS: 600, cpuLimit: DEFAULT_CPU_LIMIT }, 'no cpuLimit: the default');
  assert.deepEqual(v.cameras.map((c) => c.id), ['c1', 'c2']);
  assert.deepEqual(v.zones.c1.map((z) => z.tableId), ['t2']);
  assert.deepEqual([...v.offline], []);
});

test('an event from before the new rules (seatS, leaveS, cleanAlertS) still folds: its mode and CPU limit, the default timers', () => {
  const old = visionFromEvents([ev({ type: 'vision.settings_set', mode: 'live', seatS: 90, leaveS: 240, cleanAlertS: 120, cpuLimit: 25 }, 10)]);
  assert.deepEqual(old.settings, { mode: 'live', shortVisitS: 180, leftCheckS: 10, autoFreeS: 300, cpuLimit: 25 });
  // A newer event after it wins, as always.
  const both = visionFromEvents([
    ev({ type: 'vision.settings_set', mode: 'live', seatS: 90, leaveS: 240, cleanAlertS: 120 }, 10),
    ev({ type: 'vision.settings_set', mode: 'shadow', shortVisitS: 60, leftCheckS: 5, autoFreeS: 120, cpuLimit: 20 }, 20),
  ]);
  assert.deepEqual(both.settings, { mode: 'shadow', shortVisitS: 60, leftCheckS: 5, autoFreeS: 120, cpuLimit: 20 });
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
    ev({ type: 'vision.settings_set', mode: 'shadow', seatS: 60, leaveS: 180, cleanAlertS: 300, cpuLimit: 5 }, 1),
    ev({ type: 'vision.settings_set', mode: 'shadow', seatS: 60, leaveS: 180, cleanAlertS: 300, cpuLimit: 50 }, 1),
    ev({ type: 'vision.settings_set', mode: 'live', shortVisitS: 180, leftCheckS: 10, autoFreeS: 300, cpuLimit: 15 }, 1),
    ev({ type: 'vision.settings_set', mode: 'off', shortVisitS: 0, leftCheckS: 1, autoFreeS: 60 }, 1),
    ev({ type: 'vision.settings_set', mode: 'off', shortVisitS: 3600, leftCheckS: 300, autoFreeS: 7200 }, 1),
    ev({ type: 'vision.camera_offline', cameraId: 'c1' }, 1),
    ev({ type: 'vision.camera_online', cameraId: 'c1' }, 1),
    ev({ type: 'vision.heartbeat', cameras: [{ id: 'c1', online: true, fps: 2.5 }], cpu: 37.5 }, 1),
    // A 5th camera may be set up, as long as only 4 are used for CV (SCRUM-171).
    ev({ type: 'vision.cameras_set', cameras: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: 'C', ip: '192.168.1.20', rtspPath: '/s', enabled: i < 4 })) }, 1),
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
    ev({ type: 'vision.cameras_set', cameras: Array.from({ length: 17 }, (_, i) => ({ id: `c${i}`, name: 'C', ip: '192.168.1.20', rtspPath: '/s', enabled: false })) }, 1),
    ev({ type: 'vision.zones_set', cameraId: 'c1', zones: [{ id: 'z', tableId: 't1', points: [{ x: 0, y: 0 }, { x: 1.2, y: 0 }, { x: 1, y: 1 }] }] }, 1),
    ev({ type: 'vision.zones_set', cameraId: 'c1', zones: [{ id: 'z', tableId: 't1', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] }, 1),
    ev({ type: 'vision.settings_set', mode: 'on', seatS: 60, leaveS: 180, cleanAlertS: 300 }, 1),
    ev({ type: 'vision.settings_set', mode: 'live', seatS: 0, leaveS: 180, cleanAlertS: 300 }, 1),
    ev({ type: 'vision.settings_set', mode: 'live', seatS: 60, leaveS: 180, cleanAlertS: 300, cpuLimit: 4 }, 1),
    ev({ type: 'vision.settings_set', mode: 'live', seatS: 60, leaveS: 180, cleanAlertS: 300, cpuLimit: 51 }, 1),
    ev({ type: 'vision.settings_set', mode: 'live', seatS: 60, leaveS: 180, cleanAlertS: 300, cpuLimit: 12.5 }, 1),
    ev({ type: 'vision.settings_set', mode: 'live', seatS: 60, leaveS: 180, cleanAlertS: 300, cpuLimit: '15' }, 1),
    // The new timers: all three, whole seconds, in range, and never mixed with the old ones.
    ev({ type: 'vision.settings_set', mode: 'live', shortVisitS: 180, leftCheckS: 10 }, 1),
    ev({ type: 'vision.settings_set', mode: 'live', shortVisitS: 180, leftCheckS: 0, autoFreeS: 300 }, 1),
    ev({ type: 'vision.settings_set', mode: 'live', shortVisitS: 180, leftCheckS: 10, autoFreeS: 59 }, 1),
    ev({ type: 'vision.settings_set', mode: 'live', shortVisitS: -1, leftCheckS: 10, autoFreeS: 300 }, 1),
    ev({ type: 'vision.settings_set', mode: 'live', shortVisitS: 180.5, leftCheckS: 10, autoFreeS: 300 }, 1),
    ev({ type: 'vision.settings_set', mode: 'live', shortVisitS: 180, leftCheckS: 10, autoFreeS: 300, seatS: 60 }, 1),
    ev({ type: 'vision.settings_set', mode: 'live', seatS: 60, leaveS: 180, cleanAlertS: 300, autoFreeS: 300 }, 1),
    ev({ type: 'vision.settings_set', mode: 'live' }, 1),
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

test('the chip counts free tables, and is red while any table needs cleaning', () => {
  assert.deepEqual(floorSummary([]), { free: 0, dirty: 0, tone: null });
  assert.deepEqual(floorSummary([tile('free', 0), tile('occupied', 0), tile('reserved', 0), tile('free', 0)]), { free: 2, dirty: 0, tone: null });
  assert.deepEqual(floorSummary([tile('free', 0), tile('needs_cleaning', 0)]), { free: 1, dirty: 1, tone: 'bad' }, 'red at once, not after a wait');
  assert.deepEqual(floorSummary([tile('needs_cleaning', 100, 'alert-1'), tile('needs_cleaning', 100)]), { free: 0, dirty: 2, tone: 'bad' });
});

test('a dirty table frees itself 5 min after it began, in Live with a camera on it; otherwise staff free it', () => {
  const live = { ...DEFAULT_VISION_SETTINGS, mode: 'live' as const };
  const watched = { ...tile('needs_cleaning', 100), watched: true };
  assert.equal(autoFreeAt(watched, live), 400 * S);
  assert.equal(autoFreeAt(watched, { ...live, autoFreeS: 600 }), 700 * S);
  assert.equal(autoFreeAt(tile('needs_cleaning', 100), live), null, 'no camera on it');
  assert.equal(autoFreeAt({ ...watched, noCamera: true }, live), null, 'its camera is offline');
  assert.equal(autoFreeAt(watched, { ...live, mode: 'shadow' }), null, 'Shadow: the floor is staff\'s');
  assert.equal(autoFreeAt({ ...watched, state: 'occupied' }, live), null);
});

test('the tables that have just come to need cleaning (the Register\'s note)', () => {
  const a = { ...tile('occupied', 0), id: 'a', label: '3' };
  const b = { ...tile('needs_cleaning', 0), id: 'b', label: '5' };
  assert.deepEqual(newlyDirty([a, b], [{ ...a, state: 'needs_cleaning' }, b]).map((t) => t.label), ['3']);
  assert.deepEqual(newlyDirty([a, b], [a, b]), [], 'still dirty is not news');
  assert.deepEqual(newlyDirty([], [b]), [], 'a table new to the layout is not news');
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

// ----- Shadow and the CPU limit (SCRUM-174) -----

test('the CPU limit: 15% unless the owner sets it, 5% to 50% in steps of 5', () => {
  assert.deepEqual([DEFAULT_CPU_LIMIT, MIN_CPU_LIMIT, MAX_CPU_LIMIT, CPU_LIMIT_STEP], [15, 5, 50, 5]);
  assert.equal(visionFromEvents([]).settings.cpuLimit, 15);
  const v = visionFromEvents([ev({ type: 'vision.settings_set', mode: 'live', seatS: 60, leaveS: 180, cleanAlertS: 300, cpuLimit: 30 }, 1)]);
  assert.equal(v.settings.cpuLimit, 30);
});

test('in Shadow the cameras are recorded but the floor changes only when staff set it; in Live they set it', () => {
  const shadow = ev({ type: 'vision.settings_set', mode: 'shadow', seatS: 60, leaveS: 180, cleanAlertS: 300 }, 5);
  const seen = ev({ type: 'table.state_changed', tableId: 't1', from: 'free', to: 'occupied', confidence: 0.8 }, 100);
  const shadowFloor = tablesFromEvents([layout(), shadow, seen]);
  assert.equal(shadowFloor[0].state, 'free', 'the camera only watches');
  // The change is still what the camera saw: the Owner feed's visits count it.
  assert.deepEqual(tableChanges([layout(), shadow, seen]).map((c) => [c.tableId, c.to, c.by]), [['t1', 'occupied', 'camera']]);
  // Staff set the floor in Shadow.
  const staff = tablesFromEvents([layout(), shadow, seen, ev({ type: 'table.state_set', tableId: 't1', from: 'free', to: 'occupied' }, 120, cashier)]);
  assert.deepEqual([staff[0].state, staff[0].since], ['occupied', 120]);
  // Live: the camera sets the floor.
  const live = ev({ type: 'vision.settings_set', mode: 'live', seatS: 60, leaveS: 180, cleanAlertS: 300 }, 5);
  assert.equal(tablesFromEvents([layout(), live, seen])[0].state, 'occupied');
  // Switching to Live later: only changes from then on move the floor.
  const later = ev({ type: 'vision.settings_set', mode: 'live', seatS: 60, leaveS: 180, cleanAlertS: 300 }, 150);
  const left = ev({ type: 'table.state_changed', tableId: 't1', from: 'occupied', to: 'needs_cleaning', confidence: 0.9 }, 200);
  assert.equal(tablesFromEvents([layout(), shadow, seen, later, left])[0].state, 'free', 'stale: the floor never took what the camera saw');
});
