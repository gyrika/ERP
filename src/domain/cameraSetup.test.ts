import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addPoint, brandOf, CAUSE_TEXT, hostPort, closePolygon, ffmpegCause, LIMIT_TEXT, liveBlocked, maskLogins, mayUse, normalisePoint, presetPath,
  rtspUrl, tablesWithoutZone, testFailure,
} from './cameraSetup.ts';
import type { CameraSpec, TableSpec, ZoneSpec } from './tables.ts';

/** What ffmpeg 8 (BtbN win64) writes to stderr with -loglevel error, one per failure. */
const STDERR = {
  login: '[rtsp @ 000001d2c4a8e0c0] method DESCRIBE failed: 401 Unauthorized\nrtsp://***@192.168.1.20:554/stream2: Server returned 401 Unauthorized (authorization failed)\n',
  path: '[rtsp @ 0000020f1e9a7f40] method DESCRIBE failed: 404 Not Found\nrtsp://admin:hunter2@192.168.1.21:554/Streaming/Channels/102: Server returned 404 Not Found\n',
  refused: '[tcp @ 000002a5b1c3d500] Connection to tcp://192.168.1.22:554?timeout=5000000 failed: Connection refused\nrtsp://admin:hunter2@192.168.1.22:554/stream2: Connection refused\n',
  winTimeout: '[tcp @ 000001f2a3b4c5d0] Connection to tcp://192.168.1.23:554?timeout=5000000 failed: Error number -138 occurred\nrtsp://admin:hunter2@192.168.1.23:554/stream2: Error number -138 occurred\n',
  other: '[rtsp @ 0000018a] Nonmatching transport in server reply\nrtsp://admin:hunter2@192.168.1.24:554/stream2: Invalid data found when processing input\n',
};

test('each brand has its low-resolution stream; any other path is custom', () => {
  assert.equal(presetPath('tapo'), '/stream2');
  assert.equal(presetPath('hikvision'), '/Streaming/Channels/102');
  assert.equal(presetPath('dahua'), '/cam/realmonitor?channel=1&subtype=1');
  assert.equal(presetPath('custom'), null);
  assert.equal(brandOf('/Streaming/Channels/102'), 'hikvision');
  assert.equal(brandOf('/live/ch1'), 'custom');
});

test('the RTSP address carries the login, escaped; masking hides it again', () => {
  assert.equal(rtspUrl({ ip: '192.168.1.20', rtspPath: '/stream2' }), 'rtsp://192.168.1.20:554/stream2');
  const url = rtspUrl({ ip: '192.168.1.20', rtspPath: 'stream2', user: 'cam@shop', password: 'p:ss/w@rd' });
  assert.equal(url, 'rtsp://cam%40shop:p%3Ass%2Fw%40rd@192.168.1.20:554/stream2');
  assert.equal(maskLogins(`Opening ${url} failed`), 'Opening rtsp://***@192.168.1.20:554/stream2 failed');
  assert.equal(maskLogins('rtsp://admin:hunter2@10.0.0.5:554/a and rtsp://u:p@10.0.0.6/b'), 'rtsp://***@10.0.0.5:554/a and rtsp://***@10.0.0.6/b');
  assert.equal(maskLogins('tcp://192.168.1.22:554?timeout=5'), 'tcp://192.168.1.22:554?timeout=5', 'no login, nothing changed');
});

test("ffmpeg's error output tells the likely cause", () => {
  assert.equal(ffmpegCause(STDERR.login), 'login');
  assert.equal(ffmpegCause(STDERR.path), 'path');
  assert.equal(ffmpegCause(STDERR.refused), 'rtsp');
  assert.equal(ffmpegCause(STDERR.winTimeout), 'rtsp');
  assert.equal(ffmpegCause('', true), 'rtsp', 'our own time limit: the camera did not answer');
  assert.equal(ffmpegCause(STDERR.other), 'other');
});

test('a failed Test says the cause in plain words, and never the password', () => {
  assert.deepEqual(testFailure(STDERR.login), { cause: 'login', message: CAUSE_TEXT.login });
  assert.deepEqual(testFailure(STDERR.refused), { cause: 'rtsp', message: CAUSE_TEXT.rtsp });
  const other = testFailure(STDERR.other);
  assert.equal(other.cause, 'other');
  assert.match(other.message, /Invalid data found/);
  assert.doesNotMatch(other.message, /hunter2|admin/);
  for (const s of Object.values(STDERR)) assert.doesNotMatch(testFailure(s).message, /hunter2/);
});

test('at most 4 cameras are used for CV: a 5th stays off until one is turned off', () => {
  const cams = (on: number, total = 5) => Array.from({ length: total }, (_, i) => ({ id: `c${i}`, enabled: i < on }));
  assert.equal(mayUse(cams(3), 'c4'), true);
  assert.equal(mayUse(cams(4), 'c4'), false);
  assert.equal(mayUse(cams(4), 'c0'), true, 'one that is on may stay on');
  assert.equal(LIMIT_TEXT, 'Limit 4 cameras - turn one off first');
});

const tables: TableSpec[] = [{ id: 't1', label: '1', seats: 4 }, { id: 't2', label: '2', seats: 2 }, { id: 't3', label: '3', seats: 6 }];
const cam = (id: string, enabled = true): CameraSpec => ({ id, name: id, ip: '192.168.1.20', rtspPath: '/stream2', enabled });
const zone = (tableId: string): ZoneSpec => ({ id: `z-${tableId}`, tableId, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] });

test('Live waits until every table has a zone on a camera in use', () => {
  assert.equal(liveBlocked([], [cam('c1')], {}), 'Add the tables first.');
  assert.equal(liveBlocked(tables, [cam('c1', false)], { c1: [zone('t1')] }), 'Turn on "Use for CV" for a camera first.');
  assert.equal(liveBlocked(tables, [cam('c1')], { c1: [zone('t1')] }), 'Tables 2 and 3 have no zone yet.');
  assert.equal(liveBlocked(tables, [cam('c1'), cam('c2', false)], { c1: [zone('t1'), zone('t2')], c2: [zone('t3')] }), 'Table 3 has no zone yet.',
    "a camera not in use does not count");
  assert.equal(liveBlocked(tables, [cam('c1'), cam('c2')], { c1: [zone('t1'), zone('t2')], c2: [zone('t3')] }), null);
  assert.deepEqual(tablesWithoutZone(tables, [cam('c1')], { c1: [zone('t2')] }).map((t) => t.id), ['t1', 't3']);
});

test('a click becomes a point normalised 0-1 to the frame, whatever size the frame is shown at', () => {
  const frame = { left: 100, top: 50, width: 640, height: 360 };
  assert.deepEqual(normalisePoint(420, 230, frame), { x: 0.5, y: 0.5 });
  assert.deepEqual(normalisePoint(100, 50, frame), { x: 0, y: 0 });
  assert.deepEqual(normalisePoint(900, 0, frame), { x: 1, y: 0 }, 'outside the frame is held at its edge');
  assert.deepEqual(normalisePoint(313.3333, 50, frame), { x: 0.3333, y: 0 }, 'four decimals are plenty');
});

test('Enter closes a zone of 3 points or more; a repeated point or a line is not a zone', () => {
  const tri = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.3, y: 0.6 }];
  assert.deepEqual(closePolygon(tri), tri);
  assert.equal(closePolygon(tri.slice(0, 2)), null);
  assert.deepEqual(closePolygon([...tri, { x: 0.1, y: 0.1 }]), tri, 'clicking the first point again closes it');
  assert.equal(closePolygon([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }]), null, 'three points on one line');
  assert.deepEqual(addPoint(tri, tri[2]), tri, 'a double click adds one point');
  assert.equal(addPoint(Array.from({ length: 32 }, (_, i) => ({ x: i / 32, y: (i % 2) / 2 })), { x: 1, y: 1 }).length, 32);
});

test('a phone app streams on its own port: the IP takes it ("192.168.1.5:8080"); without one, the RTSP port 554', () => {
  assert.deepEqual(hostPort('192.168.1.5:8080'), { host: '192.168.1.5', port: 8080 });
  assert.deepEqual(hostPort('192.168.1.5'), { host: '192.168.1.5', port: 554 });
  assert.equal(rtspUrl({ ip: '192.168.1.5:8080', rtspPath: presetPath('phone')! }), 'rtsp://192.168.1.5:8080/h264_ulaw.sdp');
  assert.equal(rtspUrl({ ip: '192.168.1.5:8080', rtspPath: '/h264_ulaw.sdp', user: 'me', password: 'pw' }), 'rtsp://me:pw@192.168.1.5:8080/h264_ulaw.sdp');
  assert.equal(brandOf('/h264_ulaw.sdp'), 'phone');
});
