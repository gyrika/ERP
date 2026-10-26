import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Actor } from './auth.ts';
import { rulesSuggestions } from './insights.ts';
import type { SyncEvent } from './sync.ts';
import {
  BUSY_PCT, camerasOffline, MAX_VISIT_MIN, MIN_DATA_DAYS, MIN_OFFLINE_MIN, MIN_VISIT_MIN, tablesVsUsual, tableUse, visitLength, visitsFrom,
} from './tableInsights.ts';

const friday = new Date(2026, 9, 9, 20, 30).getTime(); // a Friday evening, local time
const MIN = 60_000;
const owner: Actor = { id: 'o', name: 'Anton', role: 'owner' };
const cashier: Actor = { id: 'n', name: 'Nimal', role: 'cashier' };
const cams: Actor = { id: 'vision', name: 'Cameras', role: 'vision' };

let n = 0;
const ev = (e: object, at: number, actor: Actor = cams) =>
  ({ id: `e${++n}`, shopId: 's', at, orderNumber: 0, actor, ...e }) as unknown as SyncEvent;
/** Midnight k days before the Friday, local time. */
const day = (k: number) => { const d = new Date(friday); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - k); return d.getTime(); };

const TABLES = [{ id: 't1', label: '1', seats: 2 }, { id: 't2', label: '2', seats: 4 }, { id: 't3', label: '3', seats: 4 }];
const setup = (at = day(40)): SyncEvent[] => [
  ev({ type: 'table.layout_set', tables: TABLES }, at, owner),
  ev({ type: 'vision.cameras_set', cameras: [
    { id: 'c1', name: 'Front door', ip: '192.168.1.20', rtspPath: '/stream1', enabled: true },
    { id: 'c2', name: 'Back room camera', ip: '192.168.1.21', rtspPath: '/stream1', enabled: true },
  ] }, at, owner),
  ev({ type: 'vision.zones_set', cameraId: 'c1', zones: TABLES.map((t) => ({ id: `z-${t.id}`, tableId: t.id, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] })) }, at, owner),
];
/** A visit the camera saw: seated at `at`, gone `minutes` later, then a cashier wipes the table. */
const visit = (tableId: string, at: number, minutes: number): SyncEvent[] => [
  ev({ type: 'table.state_changed', tableId, from: 'free', to: 'occupied', confidence: 0.8 }, at),
  ev({ type: 'table.state_changed', tableId, from: 'occupied', to: 'needs_cleaning', confidence: 0.95 }, at + minutes * MIN),
  ev({ type: 'table.state_set', tableId, from: 'needs_cleaning', to: 'free' }, at + (minutes + 2) * MIN, cashier),
];
/** `count` visits on a day, an hour apart from noon, spread over the tables. */
const dayOf = (k: number, count: number, minutes = 30, tables = ['t1', 't2', 't3']) =>
  Array.from({ length: count }, (_, i) => visit(tables[i % tables.length], day(k) + 12 * 60 * MIN + Math.floor(i / tables.length) * 60 * MIN, minutes)).flat();
const byTime = (events: SyncEvent[]) => [...events].sort((a, b) => a.at - b.at);
const ids = (events: SyncEvent[], now = friday) => rulesSuggestions.insights({ events: byTime(events), now }).map((i) => i.id);
const TABLE_CARDS = ['camera-offline', 'tables-vs-usual', 'visit-length', 'table-use'];

test('the thresholds are named, so the owner can be told them', () => {
  assert.deepEqual([BUSY_PCT, MIN_VISIT_MIN, MAX_VISIT_MIN, MIN_DATA_DAYS, MIN_OFFLINE_MIN], [20, 5, 180, 14, 2]);
});

test('a shop without cameras sees none of these cards, even with tables set by staff', () => {
  const staffOnly = [
    ev({ type: 'table.layout_set', tables: TABLES }, day(10), owner),
    ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((k) => [
      ev({ type: 'table.state_set', tableId: 't1', from: 'free', to: 'occupied' }, day(k) + 13 * 60 * MIN, cashier),
      ev({ type: 'table.state_set', tableId: 't1', from: 'occupied', to: 'free' }, day(k) + 14 * 60 * MIN, cashier),
    ]),
  ];
  assert.deepEqual(ids([]).filter((i) => TABLE_CARDS.includes(i)), []);
  assert.deepEqual(ids(staffOnly).filter((i) => TABLE_CARDS.includes(i)), []);
  assert.deepEqual(visitsFrom(byTime(staffOnly)), [], 'staff-made occupancy is not a visit the camera saw');
});

test('visits: camera seated to left (cleaning, or freed by staff); blips under 5 min, over 3 h and staff corrections are not visits', () => {
  const t = day(0) + 12 * 60 * MIN;
  const undoable = ev({ type: 'table.state_set', tableId: 't3', from: 'occupied', to: 'free' }, t + 10 * MIN, cashier);
  const events = byTime([
    ...setup(),
    ...visit('t1', t, 40),
    ...visit('t2', t, 3), // someone stood by a table waiting for takeaway
    ev({ type: 'table.state_changed', tableId: 't2', from: 'free', to: 'occupied', confidence: 0.8 }, t + 60 * MIN),
    ev({ type: 'table.state_set', tableId: 't2', from: 'occupied', to: 'free' }, t + 95 * MIN, cashier), // staff cleared it: they left
    ev({ type: 'table.state_changed', tableId: 't3', from: 'free', to: 'occupied', confidence: 0.8 }, t),
    undoable, // a slip of the key …
    ev({ type: 'table.state_set_undone', tableId: 't3', undoneEventId: (undoable as { id: string }).id }, t + 10 * MIN + 5000, cashier), // … undone
    ev({ type: 'table.state_changed', tableId: 't3', from: 'occupied', to: 'needs_cleaning', confidence: 0.9 }, t + 50 * MIN),
    ...visit('t1', t + 60 * MIN, 200), // the camera was stuck
  ]);
  const visits = visitsFrom(events);
  assert.deepEqual(visits.map((v) => [v.tableId, (v.start - t) / MIN, v.end === null ? null : (v.end - v.start) / MIN]), [
    ['t1', 0, 40], ['t3', 0, 50], ['t2', 60, 35],
  ]);
  const open = visitsFrom(byTime([...setup(), ev({ type: 'table.state_changed', tableId: 't1', from: 'free', to: 'occupied', confidence: 0.8 }, t)]), t + 20 * MIN);
  assert.deepEqual(open.map((v) => [v.tableId, v.end]), [['t1', null]], 'a table still taken is a visit under way');
  assert.deepEqual(visitsFrom(byTime([...setup(), ev({ type: 'table.state_changed', tableId: 't1', from: 'free', to: 'occupied', confidence: 0.8 }, t)]), t + 4 * MIN), [], 'under 5 min so far: not yet a visit');
});

test('busy tables vs the last 4 same weekdays by this time: ±20%, worded like the sales card', () => {
  const past = [7, 14, 21, 28].flatMap((k) => dayOf(k, 10));
  const busier = tablesVsUsual(byTime([...setup(), ...past, ...dayOf(0, 13)]), friday);
  assert.equal(busier?.title, 'Tables 30% busier than a usual Friday');
  assert.equal(busier?.tone, 'good');
  assert.equal(busier?.detail, '13 visits so far; usually 10 by 8 pm.');
  assert.equal(busier?.action.label, 'Compare');
  assert.deepEqual(busier?.action.items.map((i) => [i.primary, i.secondary]), [
    ['Today, by 20:30', '13 visits'],
    ...[7, 14, 21, 28].map((k) => [new Date(day(k)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }), '10 visits by 20:30']),
  ]);
  const quieter = tablesVsUsual(byTime([...setup(), ...past, ...dayOf(0, 7)]), friday);
  assert.equal(quieter?.title, 'Tables 30% quieter than a usual Friday');
  assert.equal(quieter?.tone, 'attention');
  assert.equal(tablesVsUsual(byTime([...setup(), ...past, ...dayOf(0, 11)]), friday), null, 'within 20% says nothing');
  // Visits after this time of day on past Fridays do not count towards "by now".
  const late = [7, 14, 21, 28].flatMap((k) => visit('t1', day(k) + 21 * 60 * MIN, 30));
  assert.equal(tablesVsUsual(byTime([...setup(), ...past, ...late, ...dayOf(0, 13)]), friday)?.title, 'Tables 30% busier than a usual Friday');
});

test('a camera offline now: its tables are left out of every day, so a dark camera is not a quiet day', () => {
  const past = [7, 14, 21, 28].flatMap((k) => [...dayOf(k, 10), ...dayOf(k, 10, 30, ['t4'])]);
  const layout = ev({ type: 'table.layout_set', tables: [...TABLES, { id: 't4', label: '4', seats: 2 }] }, day(40), owner);
  const back = ev({ type: 'vision.zones_set', cameraId: 'c2', zones: [{ id: 'z-t4', tableId: 't4', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }] }, day(40), owner);
  const dark = ev({ type: 'vision.camera_offline', cameraId: 'c2' }, day(0) + 11 * 60 * MIN);
  // Today: the front tables as usual (10), nothing seen at table 4 (its 9 visits by 20:30 on past Fridays).
  assert.equal(tablesVsUsual(byTime([...setup(), layout, back, ...past, ...dayOf(0, 10)]), friday)?.title, 'Tables 47% quieter than a usual Friday');
  assert.equal(tablesVsUsual(byTime([...setup(), layout, back, dark, ...past, ...dayOf(0, 10)]), friday), null);
});

test('busy tables needs 3 past weekdays with camera data, and 5 visits usually by now', () => {
  assert.equal(tablesVsUsual(byTime([...setup(), ...[7, 14].flatMap((k) => dayOf(k, 10)), ...dayOf(0, 20)]), friday), null);
  assert.equal(tablesVsUsual(byTime([...setup(), ...[7, 14, 21].flatMap((k) => dayOf(k, 4)), ...dayOf(0, 12)]), friday), null);
  assert.ok(tablesVsUsual(byTime([...setup(), ...[7, 14, 21].flatMap((k) => dayOf(k, 5)), ...dayOf(0, 12)]), friday));
});

test('visit length today vs the last 28 days: ±20%, at least 5 visits today and 20 before', () => {
  const before = [1, 2, 3, 4, 5].flatMap((k) => dayOf(k, 4, 30));
  const longer = visitLength(byTime([...setup(), ...before, ...dayOf(0, 5, 42)]), friday);
  assert.equal(longer?.title, 'Guests staying 12 min longer than usual');
  assert.equal(longer?.detail, '42 min a visit today; usually 30 min.');
  assert.equal(longer?.tone, 'info');
  assert.equal(longer?.action.label, 'See visits');
  assert.equal(longer?.action.items.length, 5);
  assert.deepEqual(longer?.action.items.map((i) => [i.primary, i.secondary]).slice(0, 3), [['Table 1', '42 min'], ['Table 2', '42 min'], ['Table 1', '42 min']], 'newest first');
  assert.equal(visitLength(byTime([...setup(), ...before, ...dayOf(0, 5, 20)]), friday)?.title, 'Guests staying 10 min shorter than usual');
  assert.equal(visitLength(byTime([...setup(), ...before, ...dayOf(0, 5, 35)]), friday), null, 'within 20% says nothing');
  assert.equal(visitLength(byTime([...setup(), ...before, ...dayOf(0, 4, 50)]), friday), null, 'four visits today are not enough');
  assert.equal(visitLength(byTime([...setup(), ...before.slice(0, 19 * 3), ...dayOf(0, 5, 50)]), friday), null, '19 visits before are not enough');
  // Two-minute blips today change nothing.
  const blips = [0, 1, 2].flatMap((i) => visit('t3', day(0) + (9 * 60 + i * 10) * MIN, 2));
  assert.equal(visitLength(byTime([...setup(), ...before, ...dayOf(0, 5, 42), ...blips]), friday)?.title, 'Guests staying 12 min longer than usual');
});

test('most and least used tables over 28 days: one card, only when the gap is clear', () => {
  const k14 = Array.from({ length: 14 }, (_, i) => i + 1);
  // Table 1 three visits a day, table 2 two, table 3 one: 1.5 h a day against 30 min.
  const uneven = k14.flatMap((k) => [...dayOf(k, 3, 30, ['t1']), ...dayOf(k, 2, 30, ['t2']), ...dayOf(k, 1, 30, ['t3'])]);
  const card = tableUse(byTime([...setup(), ...uneven]), friday);
  assert.equal(card?.title, 'Table 1 busiest, table 3 quietest');
  assert.equal(card?.detail, 'Last 4 weeks: 21 h against 7 h. Worth moving or changing table 3?');
  assert.equal(card?.tone, 'info');
  assert.equal(card?.action.label, 'All tables');
  assert.deepEqual(card?.action.items.map((i) => [i.primary, i.secondary]), [
    ['Table 1', '21 h · 42 visits'], ['Table 2', '14 h · 28 visits'], ['Table 3', '7 h · 14 visits'],
  ]);
  const even = k14.flatMap((k) => [...dayOf(k, 3, 30, ['t1']), ...dayOf(k, 2, 30, ['t2']), ...dayOf(k, 2, 30, ['t3'])]);
  assert.equal(tableUse(byTime([...setup(), ...even]), friday), null, 'under 2× apart is not clear');
  const short = k14.slice(0, 13).flatMap((k) => [...dayOf(k, 3, 30, ['t1']), ...dayOf(k, 1, 30, ['t3'])]);
  assert.equal(tableUse(byTime([...setup(), ...short]), friday), null, 'under 14 days of camera data');
  const never = k14.flatMap((k) => dayOf(k, 3, 30, ['t1', 't2']));
  assert.equal(tableUse(byTime([...setup(), ...never]), friday)?.title, 'Table 1 busiest, table 3 quietest', 'a watched table nobody sat at counts, at 0 h');
});

test('a camera offline with no "online" after it: named, how long, ranked first', () => {
  const offline = (cameraId: string, minutesAgo: number) => ev({ type: 'vision.camera_offline', cameraId }, friday - minutesAgo * MIN);
  const card = camerasOffline(byTime([...setup(), offline('c1', 25)]), friday);
  assert.equal(card?.title, 'Front door camera offline for 25 min');
  assert.equal(card?.detail, 'Its tables show the last state it saw. Check its power and Wi-Fi.');
  assert.equal(card?.tone, 'attention');
  assert.equal(card?.action.label, 'See cameras');
  assert.deepEqual(card?.action.items.map((i) => [i.primary, i.secondary]), [['Front door', 'offline since 20:05 · tables 1, 2, 3']]);
  assert.equal(camerasOffline(byTime([...setup(), offline('c2', 3 * 60 + 10)]), friday)?.title, 'Back room camera offline for 3 h');
  assert.equal(camerasOffline(byTime([...setup(), offline('c2', 2 * 24 * 60 + 5)]), friday)?.title, 'Back room camera offline for 2 days');
  const both = camerasOffline(byTime([...setup(), offline('c1', 25), offline('c2', 70)]), friday);
  assert.equal(both?.title, '2 cameras offline');
  assert.equal(both?.detail, 'Back room camera 1 h, Front door 25 min. Their tables show the last state seen.');
  assert.equal(camerasOffline(byTime([...setup(), offline('c1', 25), ev({ type: 'vision.camera_online', cameraId: 'c1' }, friday - 5 * MIN)]), friday), null);
  assert.equal(camerasOffline(byTime([...setup(), offline('c1', 25),
    ev({ type: 'vision.heartbeat', cameras: [{ id: 'c1', online: true, fps: 5 }], cpu: 30 }, friday - 5 * MIN)]), friday), null, 'a heartbeat saying it is back');
  assert.equal(camerasOffline(byTime([...setup(), offline('c1', 1)]), friday), null, 'a blip under 2 min');
  // Ranked first, ahead of every other card that needs attention.
  const voids = Array.from({ length: 3 }, (_, i) => ev({
    type: 'order.line_removed', orderNumber: 1000 + i, lineId: `l${i}`, index: 0,
    before: { id: `l${i}`, itemId: 'margherita', qty: 1, adds: [], outs: [] }, totalBefore: 100000, totalAfter: 0,
  }, friday - 60 * MIN, cashier));
  assert.deepEqual(ids([...setup(), ...voids, offline('c1', 25)]).slice(0, 2), ['camera-offline', 'voids']);
});
