import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Actor } from './auth.ts';
import type { SyncEvent } from './sync.ts';
import { tablesFromEvents, visionFromEvents } from './tables.ts';
import { cameraHealth, tablesToday, visionPart, whyState } from './visionPage.ts';

const MIN = 60_000;
const now = new Date(2026, 9, 9, 20, 30).getTime();
const today = new Date(2026, 9, 9).getTime();
const owner: Actor = { id: 'o', name: 'Anton', role: 'owner' };
const nimal: Actor = { id: 'n', name: 'Nimal', role: 'cashier' };
const cams: Actor = { id: 'vision', name: 'Cameras', role: 'vision' };
let n = 0;
const ev = (e: object, at: number, actor: Actor = cams) => ({ id: `e${++n}`, shopId: 's', at, orderNumber: 0, actor, ...e }) as unknown as SyncEvent;
const at = (h: number, m = 0) => today + (h * 60 + m) * MIN;

const TABLES = [{ id: 't1', label: '1', seats: 2 }, { id: 't2', label: '2', seats: 4 }, { id: 't3', label: '3', seats: 4 }];
const square = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
const setup = (mode: 'off' | 'shadow' | 'live' = 'live', zoned = ['t1', 't2']): SyncEvent[] => [
  ev({ type: 'table.layout_set', tables: TABLES }, at(9), owner),
  ev({ type: 'vision.cameras_set', cameras: [
    { id: 'c1', name: 'Front', ip: '192.168.1.20', rtspPath: '/stream1', enabled: true },
    { id: 'c2', name: 'Back camera', ip: '192.168.1.21', rtspPath: '/stream1', enabled: true },
  ] }, at(9), owner),
  ev({ type: 'vision.zones_set', cameraId: 'c1', zones: zoned.map((t) => ({ id: `z-${t}`, tableId: t, points: square })) }, at(9), owner),
  ev({ type: 'vision.settings_set', mode, shortVisitS: 180, leftCheckS: 10, autoFreeS: 300 }, at(9), owner),
];
const saw = (tableId: string, from: string, to: string, when: number, confidence = 0.8) =>
  ev({ type: 'table.state_changed', tableId, from, to, confidence }, when);
const set = (tableId: string, from: string, to: string, when: number) => ev({ type: 'table.state_set', tableId, from, to }, when, nimal);
const why = (events: SyncEvent[], id: string, when = now) => {
  const table = tablesFromEvents(events).find((t) => t.id === id)!;
  return whyState(table, events, visionFromEvents(events).settings, when);
};

test('why a camera set a table, by the owner\'s rules: seen, left after a visit, frees itself', () => {
  const events = [...setup(), saw('t1', 'free', 'occupied', at(18, 2))];
  assert.equal(why(events, 't1', at(18, 14)), 'Seen at 18:02; occupied 12 min.');
  // Left at 18:40 (10 s after the first empty frame): a 37 min visit; frees itself 5 min after.
  const left = [...events, saw('t1', 'occupied', 'needs_cleaning', at(18, 40) + 10_000)];
  assert.equal(why(left, 't1', at(18, 42)), 'Left at 18:40 after 38 min; frees itself in 4 min.');
  assert.equal(why(left, 't1', at(18, 44) + 30_000), 'Left at 18:40 after 38 min; frees itself in under a minute.');
  const freed = [...left, saw('t1', 'needs_cleaning', 'free', at(18, 45) + 10_000)];
  assert.equal(why(freed, 't1', at(18, 50)), 'Freed itself at 18:45, 5 min after it needed cleaning.');
  // A short visit: straight back to free.
  const short = [...setup(), saw('t2', 'free', 'occupied', at(19)), saw('t2', 'occupied', 'free', at(19, 2) + 10_000)];
  assert.equal(why(short, 't2', at(19, 5)), 'Left at 19:02 after 2 min, a short visit (under 3 min): no cleaning needed.');
  // Its camera offline: no frames, so no auto-free; the table waits for staff.
  const shadow = [...setup('live'), saw('t1', 'free', 'occupied', at(18)), saw('t1', 'occupied', 'needs_cleaning', at(18, 40)),
    ev({ type: 'vision.camera_offline', cameraId: 'c1' }, at(18, 41))];
  assert.equal(why(shadow, 't1', at(18, 42)), 'Camera offline: this is the last thing it saw. Left at 18:40 after 39 min; waits for staff to clean it.');
});

test('why staff set a table: who, when, and what ends it in Live', () => {
  const seated = [...setup(), set('t1', 'free', 'occupied', at(12, 10))];
  assert.equal(why(seated, 't1'), 'Set by Nimal at 12:10; holds until the table empties.');
  const cleaned = [...setup(), set('t1', 'needs_cleaning', 'free', at(12, 10))];
  assert.equal(why(cleaned, 't1'), 'Set by Nimal at 12:10; holds until someone sits down.');
  // A table no camera watches: staff run it.
  assert.equal(why([...setup(), set('t3', 'free', 'reserved', at(13))], 't3'), 'Set by Nimal at 13:00; no camera watches this table.');
  // Off: the cameras play no part.
  assert.equal(why([...setup('off'), set('t1', 'free', 'occupied', at(13))], 't1'), 'Set by Nimal at 13:00.');
});

test('why in Shadow: staff set the floor, and what the cameras saw is said beside it', () => {
  const events = [...setup('shadow'), saw('t1', 'free', 'occupied', at(12)), set('t1', 'free', 'occupied', at(12, 1)),
    saw('t1', 'occupied', 'needs_cleaning', at(12, 40), 0.95)];
  assert.equal(why(events, 't1'), 'Set by Nimal at 12:01; in Shadow the cameras only watch. They saw it empty at 12:40.');
  assert.equal(why([...setup('shadow'), set('t1', 'free', 'reserved', at(12, 1))], 't1'), 'Set by Nimal at 12:01; in Shadow the cameras only watch.');
});

test('why: untouched since setup, an Undo, and a camera offline', () => {
  assert.equal(why(setup(), 't2'), 'Free since the tables were set up at 09:00.');
  const slip = set('t1', 'free', 'occupied', at(12));
  const undone = [...setup(), slip, ev({ type: 'table.state_set_undone', tableId: 't1', undoneEventId: (slip as { id: string }).id }, at(12, 1), nimal)];
  assert.equal(why(undone, 't1'), 'Put back by Nimal’s Undo at 12:01.');
  const dark = [...setup(), saw('t1', 'free', 'occupied', at(12, 4)), ev({ type: 'vision.camera_offline', cameraId: 'c1' }, at(12, 30))];
  assert.equal(why(dark, 't1', at(12, 34)), 'Camera offline: this is the last thing it saw. Seen at 12:04; occupied 30 min.');
});

test("each table's day: times seated, the average visit, and how long it waited to be cleaned", () => {
  const visit = (t: string, start: number, minutes: number, wipe: number | null) => [
    saw(t, 'free', 'occupied', start), saw(t, 'occupied', 'needs_cleaning', start + minutes * MIN),
    ...(wipe === null ? [] : [set(t, 'needs_cleaning', 'free', start + (minutes + wipe) * MIN)]),
  ];
  const events = [...setup(),
    ...visit('t1', at(12), 30, 4), ...visit('t1', at(13), 50, 8), ...visit('t1', at(19, 30), 40, null),
    ...visit('t2', at(12) - 24 * 60 * MIN, 30, 2), // yesterday
  ];
  const day = tablesToday(events, now);
  assert.deepEqual(day.get('t1'), { seated: 3, visitMin: 40, waitMin: 6 }, 'the last visit still waits to be cleaned');
  assert.deepEqual(day.get('t2'), { seated: 0, visitMin: null, waitMin: null });
});

test('camera health: online or offline, fps, last seen and the CPU from the latest heartbeat; nothing before the worker speaks', () => {
  assert.equal(cameraHealth(setup()), null);
  const events = [...setup(),
    ev({ type: 'vision.heartbeat', cameras: [{ id: 'c1', online: true, fps: 4 }, { id: 'c2', online: true, fps: 5 }], cpu: 9 }, at(20)),
    ev({ type: 'vision.camera_offline', cameraId: 'c2' }, at(20, 10)),
    ev({ type: 'vision.heartbeat', cameras: [{ id: 'c1', online: true, fps: 5 }, { id: 'c2', online: false, fps: 0 }], cpu: 12.4 }, at(20, 29)),
  ];
  assert.deepEqual(cameraHealth(events), {
    at: at(20, 29), cpu: 12, slowed: false,
    cameras: [
      { id: 'c1', name: 'Front', online: true, fps: 5, lastSeen: at(20, 29) },
      { id: 'c2', name: 'Back camera', online: false, fps: 0, lastSeen: at(20) },
    ],
  });
  // The CPU guard slowed the worker: the latest heartbeat says so, until one says it is back.
  const slow = ev({ type: 'vision.heartbeat', cameras: [{ id: 'c1', online: true, fps: 0.5 }], cpu: 18, slowed: true }, at(20, 35));
  assert.equal(cameraHealth([...events, slow])!.slowed, true);
  assert.equal(cameraHealth([...events, slow, ev({ type: 'vision.heartbeat', cameras: [], cpu: 9 }, at(20, 45))])!.slowed, false);
});

test("the sidebar's line: a camera offline first, else the mode and the floor", () => {
  assert.deepEqual(visionPart([], now), { preview: 'Off', badge: 0 });
  const live = [...setup('live'), saw('t1', 'free', 'occupied', at(20)), saw('t1', 'occupied', 'needs_cleaning', at(20, 20))];
  assert.deepEqual(visionPart(live, now), { preview: 'Live · 2 free, 1 to clean', badge: 0 });
  assert.deepEqual(visionPart(setup('live'), now), { preview: 'Live · 3 free', badge: 0 });
  assert.deepEqual(visionPart(setup('off'), now), { preview: 'Off', badge: 0 });
  assert.deepEqual(visionPart(setup('shadow'), now), { preview: 'Shadow · day 1 of 7', badge: 0 });
  const offline = [...live, ev({ type: 'vision.camera_offline', cameraId: 'c2' }, at(20, 20))];
  assert.deepEqual(visionPart(offline, now), { preview: 'Back camera offline', badge: 1 });
});
