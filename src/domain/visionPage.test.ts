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
  ev({ type: 'vision.settings_set', mode, seatS: 60, leaveS: 180, cleanAlertS: 300 }, at(9), owner),
];
const saw = (tableId: string, from: string, to: string, when: number, confidence = 0.8) =>
  ev({ type: 'table.state_changed', tableId, from, to, confidence }, when);
const set = (tableId: string, from: string, to: string, when: number) => ev({ type: 'table.state_set', tableId, from, to }, when, nimal);
const why = (events: SyncEvent[], id: string) => {
  const table = tablesFromEvents(events).find((t) => t.id === id)!;
  return whyState(table, events, visionFromEvents(events).settings);
};

test('why a camera set a table: the share it saw against the share it needs', () => {
  const events = [...setup(), saw('t1', 'free', 'occupied', at(12, 4))];
  assert.equal(why(events, 't1'), 'Cameras saw people in 48 of the last 60 s at 12:04; 42 count as occupied.');
  const left = [...events, saw('t1', 'occupied', 'needs_cleaning', at(12, 40), 0.95)];
  assert.equal(why(left, 't1'), 'Cameras saw it empty for 171 of the last 180 s at 12:40; 162 count as left.');
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
  assert.equal(why(dark, 't1'), 'Camera offline: this is the last thing it saw. Cameras saw people in 48 of the last 60 s at 12:04; 42 count as occupied.');
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
