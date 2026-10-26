import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { constants, getPriority, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { SyncEvent } from '../src/domain/sync.ts';
import type { FromWorker, WorkerConfig } from './cv/messages.ts';
import { keepHeartbeat, stampEvent, startVision, workerConfig, workerProcess } from './cvWorker.ts';
import { settingsFile } from './settings.ts';
import { memoryStore, type Device } from './store.ts';

const FAKE = fileURLToPath(new URL('./cv/fakeWorker.mjs', import.meta.url));
const SHOP = 'shop-1';
const owner = { id: 'o1', name: 'Owner', role: 'owner' as const };
let n = 0;
const ev = (fields: Record<string, unknown>, at = 1000) =>
  ({ id: `e${++n}`, shopId: SHOP, at, actor: owner, orderNumber: 0, ...fields }) as unknown as SyncEvent;
const zone = { id: 'z1', tableId: 't1', points: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }] };
const setUp = (mode: 'off' | 'shadow' | 'live') => [
  ev({ type: 'table.layout_set', tables: [{ id: 't1', label: '1', seats: 4 }] }),
  ev({ type: 'vision.cameras_set', cameras: [
    { id: 'cam1', name: 'Front', ip: '192.168.1.20', rtspPath: '/stream2', enabled: true },
    { id: 'cam2', name: 'Store room', ip: '192.168.1.21', rtspPath: '/stream2', enabled: false },
  ] }),
  ev({ type: 'vision.zones_set', cameraId: 'cam1', zones: [zone] }),
  ev({ type: 'vision.settings_set', mode, seatS: 60, leaveS: 180, cleanAlertS: 300, cpuLimit: 20 }),
];
const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};

test('the worker\'s config: Shadow or Live only, the cameras in use with their login, zones, floor; nothing without the pack', () => {
  const login = (id: string) => (id === 'cam1' ? { user: 'admin', password: 'p@ss' } : null);
  assert.equal(workerConfig(setUp('off'), 'C:/pack', login), null);
  assert.equal(workerConfig(setUp('shadow'), null, login), null, 'no pack (or a new one on its way): paused');
  const c = workerConfig(setUp('shadow'), 'C:/pack', login)!;
  assert.equal(c.mode, 'shadow');
  assert.equal(c.cpuLimit, 20);
  assert.deepEqual(c.cameras.map((x) => x.id), ['cam1'], 'only "Use for CV" cameras');
  assert.equal(c.cameras[0].url, 'rtsp://admin:p%40ss@192.168.1.20:554/stream2');
  assert.deepEqual(c.cameras[0].zones, [zone]);
  assert.deepEqual(c.floor, { t1: { state: 'free', since: 1000, alertId: null } });
  // A development camera: the file, no login.
  assert.equal(workerConfig(setUp('shadow'), 'C:/pack', login, new Map([['cam1', 'C:/clips/cafe.mp4']]))!.cameras[0].url, 'C:/clips/cafe.mp4');
});

test('the server stamps worker events as the vision role, and checks them like a push', () => {
  const ok = stampEvent({ type: 'table.state_changed', tableId: 't1', from: 'free', to: 'occupied', confidence: 0.8 }, 5000, SHOP, 'id1');
  assert.ok('event' in ok);
  assert.deepEqual(ok.event, {
    id: 'id1', shopId: SHOP, at: 5000, orderNumber: 0, actor: { id: 'vision', name: 'Cameras', role: 'vision' },
    type: 'table.state_changed', tableId: 't1', from: 'free', to: 'occupied', confidence: 0.8,
  });
  // Anything else riding along (an image, a password) is refused, and so is any event vision may not record.
  assert.ok('reason' in stampEvent({ type: 'vision.camera_offline', cameraId: 'cam1', frame: 'AAAA' } as never, 1, SHOP, 'id2'));
  assert.ok('reason' in stampEvent({ type: 'table.state_set', tableId: 't1', from: 'free', to: 'reserved' } as never, 1, SHOP, 'id3'));
  assert.ok('reason' in stampEvent({ type: 'vision.settings_set', mode: 'live', seatS: 60, leaveS: 180, cleanAlertS: 300 } as never, 1, SHOP, 'id4'));
});

test('one heartbeat kept per 5 minutes, or at once when a camera or "slowed" changes', () => {
  const beat = (online: boolean, slowed = false) => ({ cameras: [{ id: 'c1', online, fps: 1 }], cpu: 4, slowed });
  assert.equal(keepHeartbeat(null, beat(true), 0), true);
  const kept = { at: 0, beat: beat(true) };
  assert.equal(keepHeartbeat(kept, beat(true), 299_999), false);
  assert.equal(keepHeartbeat(kept, beat(true), 300_000), true);
  assert.equal(keepHeartbeat(kept, beat(false), 30_000), true);
  assert.equal(keepHeartbeat(kept, beat(true, true), 30_000), true);
});

test('the worker process: spawned at below-normal priority with IPC both ways, restarted with doubling backoff, stopped for good', async () => {
  const got: FromWorker[] = [];
  const delays: number[] = [];
  const config = { packDir: 'x', mode: 'shadow', seatS: 60, leaveS: 180, cleanAlertS: 300, cpuLimit: 15, cameras: [{ id: 'cam1', url: 'rtsp://x', zones: [] }], floor: {}, offline: [] } satisfies WorkerConfig;
  const crashing = workerProcess({
    script: FAKE, env: { FAKE_WORKER_CRASH: '1' }, onMessage: (m) => got.push(m), log: () => {},
    backoff: (failures) => { const d = 40 * 2 ** failures; delays.push(d); return d; },
  });
  crashing.set(config);
  await until(() => delays.length >= 3);
  assert.deepEqual(delays.slice(0, 3), [40, 80, 160], 'doubling');
  assert.ok(got.some((m) => m.type === 'log' && m.text === 'config shadow 1'), 'the config went over IPC');
  crashing.set(null);
  const after = delays.length;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(crashing.running(), false);
  assert.ok(delays.length <= after + 1, 'off: no more restarts');

  const steady = workerProcess({ script: FAKE, onMessage: () => {}, log: () => {} });
  steady.set(config);
  await until(() => steady.pid() !== null);
  const pid = steady.pid()!;
  await until(() => { try { return getPriority(pid) === constants.priority.PRIORITY_BELOW_NORMAL; } catch { return false; } });
  await steady.stop();
  assert.equal(steady.running(), false);
});

test('the shop server runs the worker in Shadow, stores what it says as vision, writes cv.log, and stops it when CV is off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cvworker-'));
  const store = memoryStore();
  const settings = settingsFile(join(dir, 'settings.json'));
  settings.set({ shopId: SHOP, setupDone: true });
  const { device } = await store.addDevice(SHOP, 'Counter', 'counter');
  await store.push(device, setUp('shadow'), 1000);
  const ingested: SyncEvent[] = [];
  let packDir: string | null = dir;
  const vision = startVision({
    store, settings, packDir: () => packDir, login: () => ({ user: 'admin', password: 'secret1' }), logDir: join(dir, 'logs'), script: FAKE, checkMs: 50, watchMs: 200,
    ingest: async (d: Device, events: SyncEvent[]) => {
      const r = await store.push(d, events, Date.now());
      ingested.push(...r.stored.map((s) => s.event));
      vision.onStored(SHOP, r.stored.map((s) => s.event));
      return r.stored.length;
    },
  });
  try {
    await until(() => ingested.some((e) => e.type === 'vision.heartbeat'));
    const online = ingested.find((e) => e.type === 'vision.camera_online')!;
    assert.deepEqual((online as { actor: unknown }).actor, { id: 'vision', name: 'Cameras', role: 'vision' });
    assert.equal(online.shopId, SHOP);
    assert.ok(vision.running());
    // The owner opens the front camera large: its detections come, in memory only, and stop with the view.
    vision.watch('cam1');
    await until(() => vision.seen('cam1') !== null);
    assert.deepEqual(vision.seen('cam1'), { at: 2000, detectedAt: 1000, persons: [{ x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.9, score: 0.87 }] });
    assert.equal(vision.seen('cam2'), null);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(vision.seen('cam1'), null, 'no poll for WATCH_MS: closed');
    await until(() => readFileSync(join(dir, 'logs', 'cv.log'), 'utf8').includes('unwatched'));
    assert.equal(ingested.some((e) => JSON.stringify(e).includes('0.87')), false, 'never an event');
    // Pausing for a new CV pack stops it; the pack back starts it again.
    packDir = null;
    await until(() => !vision.running());
    packDir = dir;
    await until(() => vision.running());
    // Off: the worker stops.
    const off = setUp('off').at(-1)!;
    await store.push(device, [off], 2000);
    vision.onStored(SHOP, [off]);
    await until(() => !vision.running());
    const log = readFileSync(join(dir, 'logs', 'cv.log'), 'utf8');
    assert.match(log, /config shadow 1/);
    assert.doesNotMatch(log, /secret1/);
  } finally {
    await vision.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
