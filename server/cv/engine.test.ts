import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ZoneSpec } from '../../src/domain/tables.ts';
import { visionEngine, type EngineConfig } from './engine.ts';
import type { FromWorker } from './messages.ts';
import { CPU_GUARD_MS, FRAME_BYTES, HEARTBEAT_MS, OFFLINE_REPORT_MS, REUSE_MS } from './visionCore.ts';
import type { Box, Rect } from './yolox.ts';

const left: ZoneSpec = { id: 'z1', tableId: 't1', points: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }] };
/** Someone sitting in the left half: foot point (160, 300). */
const seated: Box = { x1: 120, y1: 100, x2: 200, y2: 350, score: 0.9 };

const config = (patch: Partial<EngineConfig> = {}): EngineConfig => ({
  mode: 'shadow', shortVisitS: 20, leftCheckS: 10, autoFreeS: 60, cpuLimit: 15,
  cameras: [{ id: 'cam1', zones: [left] }], floor: { t1: { state: 'free', since: 0, alertId: null } }, offline: [], ...patch,
});

function setup(opts: { people?: () => Box[]; cpu?: (t: number) => number } = {}) {
  let clock = 1_000_000;
  const sent: FromWorker[] = [];
  const crops: Rect[] = [];
  const engine = visionEngine({
    detect: async (_rgb, crop) => { crops.push(crop); return opts.people?.() ?? [seated]; },
    send: (m) => sent.push(m),
    now: () => clock,
    cpuMicros: () => opts.cpu?.(clock) ?? 0,
    cores: 1,
  });
  const frame = (shade = 100) => Buffer.alloc(FRAME_BYTES, shade);
  return {
    engine, sent, crops, frame,
    events: () => sent.flatMap((m) => (m.type === 'event' ? [m.fields] : [])),
    beats: () => sent.flatMap((m) => (m.type === 'heartbeat' ? [m] : [])),
    /** One frame (and a tick) a second for `seconds`. */
    async run(seconds: number, shade: (i: number) => number | null = () => 100) {
      for (let i = 0; i < seconds; i++) {
        const s = shade(i);
        if (s !== null) await engine.frame('cam1', frame(s));
        engine.tick();
        clock += 1000;
      }
    },
    at: () => clock,
  };
}

test('the first frame with a person in a zone makes the table occupied (Shadow records it too), with the detector score; the crop is the zone plus margin', async () => {
  const s = setup();
  s.engine.configure(config());
  await s.run(3);
  assert.deepEqual(s.events(), [{ type: 'table.state_changed', tableId: 't1', from: 'free', to: 'occupied', confidence: 0.9 }]);
  assert.deepEqual(s.crops[0], { x: 0, y: 0, w: 352, h: 360 });
});

test('the motion gate reuses a detection while nothing moves, for at most 30 s', async () => {
  const s = setup();
  s.engine.configure(config());
  await s.run(REUSE_MS / 1000);
  assert.equal(s.crops.length, 1, 'still frames: one detection');
  await s.run(1);
  assert.equal(s.crops.length, 2, '30 s on: detected again');
  await s.run(2, (i) => (i % 2 ? 100 : 160));
  assert.equal(s.crops.length, 4, 'movement: every frame');
});

test('over the CPU limit for 5 minutes: one check every 2 s, "slowed" in the heartbeat; back after 5 minutes under', async () => {
  let busy = true;
  let used = 0, last = 0;
  // 1 core; 50% busy, or 5%.
  const s = setup({ cpu: (t) => { used += (t - last) * 1000 * (busy ? 0.5 : 0.05); last = t; return used; } });
  s.engine.configure(config());
  const moving = (i: number) => 100 + (i % 4) * 20; // every check sees movement, at either pace
  await s.run(10, moving);
  assert.equal(s.crops.length, 10);
  await s.run(CPU_GUARD_MS / 1000 + 20, moving);
  const before = s.crops.length;
  await s.run(10, moving);
  assert.equal(s.crops.length - before, 5, 'every other frame');
  assert.equal(s.beats().at(-1)!.slowed, true);
  assert.ok(s.beats().at(-1)!.cpu > 15);
  busy = false;
  await s.run(CPU_GUARD_MS / 1000 + 20, moving);
  const after = s.crops.length;
  await s.run(10, moving);
  assert.equal(s.crops.length - after, 10);
  assert.equal(s.beats().at(-1)!.slowed, false);
});

test('the watched camera only: what each check sees goes to the server, normalised, with when it was detected', async () => {
  const s = setup();
  s.engine.configure(config());
  await s.run(2);
  assert.equal(s.sent.filter((m) => m.type === 'seen').length, 0, 'nobody watching: nothing');
  s.engine.watch('cam1');
  const from = s.at();
  await s.run(3);
  const seen = s.sent.flatMap((m) => (m.type === 'seen' ? [m] : []));
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[0].persons, [{ x1: 0.1875, y1: 0.2778, x2: 0.3125, y2: 0.9722, score: 0.9 }]);
  assert.equal(seen[0].cameraId, 'cam1');
  // Still frames: the motion gate reuses the first detection, so it gets older.
  assert.equal(seen[2].at, from + 2000);
  assert.ok(seen[2].detectedAt < from, 'detected before the watch began, reused since');
  s.engine.watch(null);
  await s.run(2);
  assert.equal(s.sent.filter((m) => m.type === 'seen').length, 3);
});

test('a heartbeat every 30 s: each camera online and its frames a second', async () => {
  const s = setup();
  s.engine.configure(config());
  await s.run(HEARTBEAT_MS / 1000 + 1);
  const [beat] = s.beats();
  assert.deepEqual(beat.cameras, [{ id: 'cam1', online: true, fps: 1 }]);
  assert.equal(beat.slowed, false);
  assert.equal(s.beats().length, 1);
});

test('Live records a camera offline after 300 s without frames, and online with its next frame; Shadow does not', async () => {
  for (const mode of ['live', 'shadow'] as const) {
    const s = setup();
    s.engine.configure(config({ mode }));
    await s.run(5);
    await s.run(OFFLINE_REPORT_MS / 1000, () => null);
    await s.run(2);
    const camera = s.events().filter((e) => e.type.startsWith('vision.'));
    assert.deepEqual(camera, mode === 'live'
      ? [{ type: 'vision.camera_offline', cameraId: 'cam1' }, { type: 'vision.camera_online', cameraId: 'cam1' }]
      : []);
    const beat = s.beats().find((b) => !b.cameras[0].online);
    assert.ok(beat, 'the heartbeat says offline after 30 s, in both modes');
  }
});

test('they leave: empty for leftCheckS ends the visit; a long one needs cleaning and frees itself after autoFreeS, a short one frees at once', async () => {
  let here = true;
  const s = setup({ people: () => (here ? [seated] : []) });
  s.engine.configure(config());
  const moving = (i: number) => 100 + (i % 4) * 20; // every check detects
  await s.run(30, moving); // a 30 s visit: longer than shortVisitS (20 s)
  here = false;
  await s.run(12, moving);
  assert.deepEqual(s.events().map((e) => 'to' in e && e.to), ['occupied', 'needs_cleaning'], 'left after 10 s empty');
  await s.run(60, moving);
  assert.deepEqual(s.events().map((e) => 'to' in e && e.to), ['occupied', 'needs_cleaning', 'free'], 'frees itself after autoFreeS');
  here = true;
  await s.run(5, moving); // a 5 s visit
  here = false;
  await s.run(12, moving);
  assert.deepEqual(s.events().slice(3).map((e) => 'to' in e && e.to), ['occupied', 'free'], 'a short visit needs no cleaning');
});

test('Live follows staff: a table staff freed while people sit stays free until they leave', async () => {
  const s = setup();
  s.engine.configure(config({ mode: 'live' }));
  await s.run(3);
  assert.equal(s.events().length, 1);
  s.engine.configure(config({ mode: 'live', floor: { t1: { state: 'free', since: s.at(), alertId: null } } }));
  await s.run(30);
  assert.equal(s.events().length, 1, 'held: still the same people');
});

test('Performance every 2 s, never stored: CPU against the limit, and per camera frames and checks a second and a detection\'s time', async () => {
  const s = setup();
  s.engine.configure(config());
  await s.run(12, (i) => 40 + (i * 37) % 180); // the picture changes: the motion gate does not reuse, each check detects
  const perf = s.sent.flatMap((m) => (m.type === 'perf' ? [m] : []));
  assert.ok(perf.length >= 5, 'one every 2 s');
  const last = perf.at(-1)!;
  assert.equal(last.cpuLimit, 15);
  assert.equal(last.slowed, false);
  assert.equal(last.cameras.length, 1);
  assert.deepEqual({ ...last.cameras[0], detectMs: typeof last.cameras[0].detectMs }, { id: 'cam1', online: true, fps: 1, checksPerS: 1, detectMs: 'number' });
  assert.equal(s.events().filter((e) => (e.type as string) === 'perf').length, 0, 'never an event');
});
