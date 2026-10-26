import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ZoneSpec } from '../../src/domain/tables.ts';
import { followFloor, startTracker } from './tracker.ts';
import {
  BACKOFF_MAX_MS, cameraArgs, devSources, CPU_GUARD_MS, cpuGuard, cpuPercent, checkEvery, CROP_MARGIN, FRAME_BYTES, FRAME_H, FRAME_W, frameReader,
  greyThumb, linkStep, meanAbsDiff, MOTION_H, MOTION_THRESHOLD, MOTION_W, NO_FRAMES_MS, OFFLINE_REPORT_MS, presence, restartDelay, REUSE_MS,
  shouldReuse, SLOW_CHECK_MS, CHECK_MS, zoneBox, type Guard, type Link,
} from './visionCore.ts';

const zone = (id: string, tableId: string, x1: number, y1: number, x2: number, y2: number): ZoneSpec =>
  ({ id, tableId, points: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }] });

test('ffmpeg reads the stream over TCP at 1 fps, 640x360 raw rgb24 to stdout, never a file', () => {
  const a = cameraArgs('rtsp://u:p@10.0.0.5:554/stream2');
  assert.deepEqual(a.slice(a.indexOf('-rtsp_transport'), a.indexOf('-rtsp_transport') + 4), ['-rtsp_transport', 'tcp', '-i', 'rtsp://u:p@10.0.0.5:554/stream2']);
  assert.deepEqual(a.slice(a.indexOf('-vf'), a.indexOf('-vf') + 2), ['-vf', `fps=1,scale=${FRAME_W}:${FRAME_H}`]);
  assert.deepEqual(a.slice(-5), ['-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  assert.equal(FRAME_BYTES, 640 * 360 * 3);
});

test('a development camera: a video file loops at its own speed, an image repeats; set only by CV_DEV_CAMERAS', () => {
  const video = cameraArgs('C:\\clips\\cafe.mp4');
  assert.deepEqual(video.slice(video.indexOf('-re'), video.indexOf('-re') + 5), ['-re', '-stream_loop', '-1', '-i', 'C:\\clips\\cafe.mp4']);
  assert.equal(video.includes('-rtsp_transport'), false);
  const still = cameraArgs('C:\\clips\\empty.jpg');
  assert.deepEqual(still.slice(still.indexOf('-re'), still.indexOf('-re') + 6), ['-re', '-loop', '1', '-framerate', '1', '-i']);
  assert.deepEqual([...devSources('front=C:\\clips\\a.mp4; back = C:\\b.jpg;;bad')], [['front', 'C:\\clips\\a.mp4'], ['back', 'C:\\b.jpg']]);
  assert.equal(devSources(undefined).size, 0);
});

test('the frame reader hands over exact-size frames however the pipe cuts them', () => {
  const got: number[][] = [];
  const push = frameReader(4, (f) => got.push([...f]));
  push(Buffer.from([1, 2, 3]));
  push(Buffer.from([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));
  push(Buffer.from([14, 15]));
  assert.deepEqual(got, [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]);
  push(Buffer.from([16]));
  assert.deepEqual(got.at(-1), [13, 14, 15, 16]);
  // Each frame is its own buffer: the next one does not overwrite it.
  assert.deepEqual(got[0], [1, 2, 3, 4]);
});

test('the crop is the bounding box of the camera\'s zones plus 10% each side, inside the frame', () => {
  assert.equal(CROP_MARGIN, 0.1);
  const box = zoneBox([zone('a', 't1', 0.25, 0.25, 0.5, 0.5), zone('b', 't2', 0.5, 0.5, 0.75, 0.75)], 640, 360)!;
  // zones span x 160-480 (w 320), y 90-270 (h 180); 10% margin: 32 px across, 18 down
  assert.deepEqual(box, { x: 128, y: 72, w: 384, h: 216 });
  const edge = zoneBox([zone('a', 't1', 0, 0.9, 0.2, 1)], 640, 360)!;
  assert.deepEqual(edge, { x: 0, y: 320, w: 141, h: 40 }, 'clamped to the frame');
  assert.equal(zoneBox([], 640, 360), null, 'no zones: nothing to look at');
});

test('the motion gate: a 64x36 grey thumbnail, mean absolute difference under 6/255 for 30 s reuses the result', () => {
  const frame = Buffer.alloc(FRAME_BYTES, 100);
  const rect = { x: 0, y: 0, w: 640, h: 360 };
  const a = greyThumb(frame, FRAME_W, FRAME_H, rect);
  assert.equal(a.length, MOTION_W * MOTION_H);
  assert.ok(a.every((v) => v === 100));
  // A small change: 5 levels brighter everywhere is under the threshold.
  const b = greyThumb(Buffer.alloc(FRAME_BYTES, 105), FRAME_W, FRAME_H, rect);
  assert.ok(Math.abs(meanAbsDiff(a, b) - 5 / 255) < 1e-9);
  assert.ok(meanAbsDiff(a, b) < MOTION_THRESHOLD);
  assert.equal(shouldReuse({ thumb: a, at: 0 }, b, REUSE_MS - 1), true);
  assert.equal(shouldReuse({ thumb: a, at: 0 }, b, REUSE_MS), false, 'a result is at most 30 s old');
  assert.equal(shouldReuse(null, b, 0), false);
  // Someone sits down: one quarter of the zone goes dark.
  const moved = Buffer.alloc(FRAME_BYTES, 100);
  for (let y = 0; y < 180; y++) moved.fill(0, (y * 640) * 3, (y * 640 + 320) * 3);
  const c = greyThumb(moved, FRAME_W, FRAME_H, rect);
  assert.ok(meanAbsDiff(a, c) > MOTION_THRESHOLD);
  assert.equal(shouldReuse({ thumb: a, at: 0 }, c, 1000), false);
});

test('the thumbnail looks only inside the crop', () => {
  const frame = Buffer.alloc(FRAME_BYTES, 0);
  for (let y = 100; y < 200; y++) frame.fill(255, (y * 640 + 100) * 3, (y * 640 + 200) * 3);
  const t = greyThumb(frame, FRAME_W, FRAME_H, { x: 100, y: 100, w: 100, h: 100 });
  assert.ok(t.every((v) => v === 255));
});

test('a person is at a table when the foot point is inside its zone', () => {
  const zones = [zone('a', 't1', 0, 0, 0.5, 1), zone('b', 't2', 0.5, 0, 1, 1)];
  // Foot point: centre across, 80% down. This box's foot is at (160, 300) px = (0.25, 0.83).
  const p = presence([{ x1: 120, y1: 100, x2: 200, y2: 350, score: 0.9 }], zones, FRAME_W, FRAME_H);
  assert.deepEqual([...p], [['t1', { present: true, confidence: 0.9 }], ['t2', { present: false, confidence: 0 }]]);
  assert.deepEqual([...presence([], zones, FRAME_W, FRAME_H)], [['t1', { present: false, confidence: 0 }], ['t2', { present: false, confidence: 0 }]]);
});

test('restart backoff: 1 s doubling to 60 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 20].map(restartDelay), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(BACKOFF_MAX_MS, 60_000);
});

test('a camera is offline after 30 s without frames; Live hears of it after 300 s, and as soon as it is back', () => {
  let link: Link = { started: 0, lastFrame: null, reported: null };
  let r = linkStep(link, NO_FRAMES_MS - 1);
  assert.equal(r.online, false, 'no frame yet');
  link = { ...r.link, lastFrame: 1000 };
  r = linkStep(link, 1000 + NO_FRAMES_MS - 1);
  assert.equal(r.online, true);
  assert.equal(r.emit, null);
  r = linkStep(r.link, 1000 + NO_FRAMES_MS);
  assert.equal(r.online, false);
  assert.equal(r.emit, null, 'not reported before 300 s');
  r = linkStep(r.link, 1000 + OFFLINE_REPORT_MS);
  assert.equal(r.emit, 'vision.camera_offline');
  r = linkStep(r.link, 1000 + OFFLINE_REPORT_MS + 5000);
  assert.equal(r.emit, null, 'once');
  r = linkStep({ ...r.link, lastFrame: 400_000 }, 400_000);
  assert.equal(r.emit, 'vision.camera_online');
  assert.equal(linkStep(r.link, 401_000).emit, null);
  // After a restart, a camera the shop knows is offline says so when it returns.
  assert.equal(linkStep({ started: 0, lastFrame: 10, reported: 'offline' }, 20).emit, 'vision.camera_online');
});

test('CPU guard: over the limit for 5 minutes slows to one check every 2 s; 5 minutes under returns', () => {
  let g: Guard = { slowed: false, since: null };
  const step = (at: number, pct: number) => { g = cpuGuard(g, at, pct, 15); return g; };
  step(0, 20);
  step(CPU_GUARD_MS - 10_000, 20);
  assert.equal(g.slowed, false);
  step(CPU_GUARD_MS - 5000, 10); // one dip starts the count again
  step(CPU_GUARD_MS, 20);
  step(2 * CPU_GUARD_MS - 1, 20);
  assert.equal(g.slowed, false);
  step(2 * CPU_GUARD_MS, 20);
  assert.equal(g.slowed, true);
  assert.equal(checkEvery(g), SLOW_CHECK_MS);
  step(2 * CPU_GUARD_MS + 10_000, 12);
  step(3 * CPU_GUARD_MS, 30); // a spike while slowed starts the count again
  step(3 * CPU_GUARD_MS + 10_000, 15); // at the limit counts as under
  step(4 * CPU_GUARD_MS + 5_000, 14);
  assert.equal(g.slowed, true, 'still slowed: 4m55s under');
  step(4 * CPU_GUARD_MS + 10_000, 14);
  assert.equal(g.slowed, false);
  assert.equal(checkEvery(g), CHECK_MS);
});

test('CPU share is of the whole PC', () => {
  assert.equal(cpuPercent(2_000_000, 10_000, 4), 5); // 2 s of CPU in 10 s on 4 cores
  assert.equal(cpuPercent(0, 0, 4), 0);
});

test('Live follows a staff change on the floor; Shadow keeps its own count', () => {
  const t = startTracker('occupied', 1000);
  const floor = { state: 'free' as const, since: 5000, alertId: null };
  const live = followFloor(t, floor, 'live');
  assert.equal(live.state, 'free');
  assert.ok(live.hold, 'held until presence flips');
  assert.equal(followFloor(t, floor, 'shadow'), t);
  // Its own change, come back from the server: nothing to do.
  assert.equal(followFloor(startTracker('occupied', 5000), { state: 'occupied', since: 5000, alertId: null }, 'live').hold, null);
  assert.equal(followFloor(t, undefined, 'live'), t);
});
