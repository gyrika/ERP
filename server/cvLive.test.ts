import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Spawn } from './cvCameras.ts';
import { IDLE_MS, liveViews, MAX_TILES, mpjpegReader, RETRY_MS, UNUSED_MS, viewArgs } from './cvLive.ts';

const jpeg = (n: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, n, 0xff, 0xd9]);
const part = (j: Buffer) => Buffer.concat([Buffer.from(`--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: ${j.length}\r\n\r\n`), j, Buffer.from('\r\n')]);

test('the multipart reader hands over each whole JPEG, however ffmpeg cuts its output', () => {
  const got: Buffer[] = [];
  const push = mpjpegReader((j) => got.push(j));
  const all = Buffer.concat([part(jpeg(1)), part(jpeg(2)), part(jpeg(3))]);
  for (let i = 0; i < all.length; i += 5) push(all.subarray(i, i + 5)); // 5 bytes at a time
  assert.deepEqual(got, [jpeg(1), jpeg(2), jpeg(3)]);
  push(Buffer.from('--ffmpeg\r\nContent-length: 5\r\n\r\nhello\r\n')); // not a JPEG
  push(part(jpeg(4)));
  assert.deepEqual(got.at(-1), jpeg(4));
  assert.equal(got.length, 4);
});

test('ffmpeg reads the sub-stream over TCP, to memory: keyframes only for a tile, 4 fps for the large view', () => {
  const tile = viewArgs('rtsp://u:p@10.0.0.2:554/1/2', 'tile');
  const live = viewArgs('rtsp://u:p@10.0.0.2:554/1/2', 'live');
  for (const a of [tile, live]) {
    assert.deepEqual(a.slice(a.indexOf('-rtsp_transport'), a.indexOf('-rtsp_transport') + 2), ['-rtsp_transport', 'tcp']);
    assert.deepEqual(a.slice(-3), ['-f', 'mpjpeg', 'pipe:1'], 'to memory, never a file');
    assert.ok(a.includes('-an'));
  }
  assert.ok(tile.includes('nokey') && tile.indexOf('nokey') < tile.indexOf('-i'));
  assert.ok(!live.includes('nokey'));
  assert.match(live[live.indexOf('-vf') + 1], /^fps=4,/);
});

/** Fake ffmpegs: each stays running until killed or `exit` is called; `emit` writes a frame. */
function fakes() {
  const kids: { args: string[]; killed: boolean; emit: (n: number) => void; exit: (err: string) => void }[] = [];
  const spawn: Spawn = (_cmd, args) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      kill: () => { kid.killed = true; setImmediate(() => child.emit('close', null)); return true; },
    });
    const kid = {
      args, killed: false,
      emit: (n: number) => child.stdout.write(part(jpeg(n))),
      exit: (err: string) => { child.stderr.write(err); setImmediate(() => child.emit('close', 1)); },
    };
    kids.push(kid);
    return child;
  };
  return { spawn, kids };
}
const tick = () => new Promise((r) => setImmediate(r));

const setup = () => {
  let t = 1_000_000;
  const ff = fakes();
  const cams: Record<string, { ip: string; rtspPath: string; user?: string; password?: string }> = {};
  for (let i = 1; i <= 12; i++) cams[`c${i}`] = { ip: `192.168.1.${30 + i}`, rtspPath: '/1/2', user: 'admin', password: 'Sup3r-secret' };
  let pack: string | null = 'C:\\pack\\ffmpeg.exe';
  const views = liveViews({ ffmpeg: () => pack, source: async (id) => cams[id] ?? null, spawn: ff.spawn, now: () => t, sweepMs: 0 });
  return { views, ff, at: (ms: number) => { t += ms; }, noPack: () => { pack = null; } };
};

test('a tile starts its camera once and shows its latest frame; the large view waits for a newer one', async () => {
  const s = setup();
  assert.deepEqual(await s.views.frame('c1', { mode: 'tile', use: true }), { state: 'starting' });
  assert.deepEqual(await s.views.frame('c1', { mode: 'tile' }), { state: 'starting' });
  assert.equal(s.ff.kids.length, 1, 'one ffmpeg per camera');
  assert.ok(s.ff.kids[0].args.includes('rtsp://admin:Sup3r-secret@192.168.1.31:554/1/2'), 'the login is for ffmpeg only');
  s.ff.kids[0].emit(1);
  await tick();
  const f = await s.views.frame('c1', { mode: 'tile' });
  assert.equal(f.state, 'frame');
  assert.deepEqual(f.state === 'frame' && f.jpeg, jpeg(1));

  // Large: the tile's ffmpeg makes way for a live one; the poll waits for its first frame.
  const waiting = s.views.frame('c1', { mode: 'live', after: f.state === 'frame' ? f.seq : 0, waitMs: 1000 });
  await tick();
  assert.ok(s.ff.kids[0].killed);
  assert.equal(s.ff.kids.length, 2);
  s.ff.kids[1].emit(2);
  const live = await waiting;
  assert.deepEqual(live.state === 'frame' && live.jpeg, jpeg(2));
  assert.deepEqual(s.views.running(), [{ id: 'c1', mode: 'live' }]);
});

test('one large view at a time, and at most MAX_TILES tiles: the rest are opened large to watch', async () => {
  const s = setup();
  for (let i = 1; i <= MAX_TILES; i++) await s.views.frame(`c${i}`, { mode: 'tile', use: true });
  assert.deepEqual(await s.views.frame(`c${MAX_TILES + 1}`, { mode: 'tile', use: true }), { state: 'busy' });
  await s.views.frame('c10', { mode: 'live', use: true, waitMs: 0 });
  await s.views.frame('c11', { mode: 'live', use: true, waitMs: 0 });
  assert.deepEqual(s.views.running().filter((r) => r.mode === 'live'), [{ id: 'c11', mode: 'live' }]);
  assert.equal(s.views.running().length, MAX_TILES + 1);
  assert.deepEqual(await s.views.frame('nope', { mode: 'tile' }), { state: 'unknown' });
});

test('a view stops when nobody asks for it (the page was left), and pauses after 2 minutes untouched', async () => {
  const s = setup();
  await s.views.frame('c1', { mode: 'live', use: true, waitMs: 0 });
  await s.views.frame('c2', { mode: 'tile', use: true });
  for (let i = 0; i < 10; i++) { s.at(IDLE_MS / 2); await s.views.frame('c1', { mode: 'live', waitMs: 0 }); s.views.sweep(); }
  assert.ok(!s.ff.kids[0].killed, 'still watched');
  assert.ok(s.ff.kids[1].killed, 'the tile nobody asked for stopped');

  s.at(UNUSED_MS);
  assert.deepEqual(await s.views.frame('c1', { mode: 'live', waitMs: 0 }), { state: 'paused' });
  assert.ok(s.ff.kids[0].killed);
  assert.deepEqual(await s.views.frame('c1', { mode: 'live', waitMs: 0 }), { state: 'paused' }, 'nothing restarts by itself');
  assert.equal(s.ff.kids.length, 2);
  assert.deepEqual(await s.views.frame('c1', { mode: 'live', use: true, waitMs: 0 }), { state: 'starting' }, 'a touch starts it again');
  s.views.stop();
  assert.deepEqual(s.views.running(), []);
});

test('a camera that fails says why (login masked), and is tried again after a while; no pack, no ffmpeg', async () => {
  const s = setup();
  await s.views.frame('c1', { mode: 'tile', use: true });
  s.ff.kids[0].exit('rtsp://admin:Sup3r-secret@192.168.1.31:554/1/2: Invalid data found when processing input');
  await tick(); await tick();
  const f = await s.views.frame('c1', { mode: 'tile' });
  assert.equal(f.state, 'offline');
  assert.ok(f.state === 'offline' && !f.message.includes('Sup3r-secret') && f.message.includes('***@'));
  assert.equal(s.ff.kids.length, 1);
  s.at(RETRY_MS);
  await s.views.frame('c1', { mode: 'tile' });
  assert.equal(s.ff.kids.length, 2, 'tried again');

  s.noPack();
  assert.deepEqual(await s.views.frame('c5', { mode: 'tile', use: true }), { state: 'pack' });
});
