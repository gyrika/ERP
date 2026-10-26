import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { CV_PACK_VERSION, cvPack, cvPackUrl, type CvPackOptions } from './cvPack.ts';

/** A zip file as PowerShell's ZipFile writes it: deflated entries, forward slashes, a central directory. */
function zipOf(files: Record<string, Buffer | string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const packed = deflateRawSync(data);
    const name = Buffer.from(path);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(crc32(data), 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    central.push(head, name);
    offset += 30 + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const CONTENT = {
  'ffmpeg.exe': 'MZ pretend ffmpeg',
  'node_modules/onnxruntime-node/package.json': '{"name":"onnxruntime-node","version":"1.30.0"}',
  'models/yolox_nano.onnx': Buffer.alloc(4096, 7),
  'LICENSES/ffmpeg-LGPL-2.1.txt': 'LGPL',
};
/** A pack as CI builds it; `tamper` changes a file after its sha256 went into the manifest. */
function pack({ version = CV_PACK_VERSION, tamper, extra }: { version?: string; tamper?: string; extra?: Record<string, string> } = {}): Buffer {
  const files: Record<string, Buffer | string> = { ...CONTENT };
  const manifest = { version, files: Object.entries(files).map(([path, c]) => ({ path, sha256: sha(c) })) };
  if (tamper) files[tamper] = 'corrupted on the way';
  return zipOf({ ...files, ...extra, 'manifest.json': JSON.stringify(manifest) });
}

/** GitHub's release download, answered from memory; `cut` drops the connection after that many bytes. */
function github(body: Buffer, { status = 200, cut }: { status?: number; cut?: number } = {}) {
  const asked: string[] = [];
  const http = (async (url: string) => {
    asked.push(String(url));
    if (status !== 200) return new Response('Not Found', { status });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(body.subarray(0, cut ?? body.length)));
        if (cut === undefined) c.close(); else c.error(new TypeError('terminated: other side closed'));
      },
    });
    return new Response(stream, { headers: { 'content-length': String(body.length) } });
  }) as unknown as typeof fetch;
  return { http, asked };
}

function shop({ active: on = false, ...opts }: Partial<Omit<CvPackOptions, 'active'>> & { active?: boolean } = {}) {
  const data = mkdtempSync(join(tmpdir(), 'cb-cv-'));
  let active = on;
  const dir = join(data, 'cv-pack');
  const cv = cvPack({ dir, appVersion: () => '1.0.40', active: () => active, setActive: (v) => { active = v; }, ...opts });
  return { cv, dir, isActive: () => active, done: () => rmSync(data, { recursive: true, force: true }) };
}
const left = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

test('the pack comes from the GitHub release of the installed version (the latest one in development)', () => {
  assert.equal(cvPackUrl('1.0.40'), `https://github.com/gyrika/ERP/releases/download/v1.0.40/cv-pack-${CV_PACK_VERSION}-win-x64.zip`);
  assert.equal(cvPackUrl('development'), `https://github.com/gyrika/ERP/releases/latest/download/cv-pack-${CV_PACK_VERSION}-win-x64.zip`);
});

test('CV is off by default: idle, nothing downloaded, nothing for the worker', () => {
  const s = shop();
  s.cv.start();
  assert.deepEqual(s.cv.status(), { active: false, phase: 'idle' });
  assert.equal(s.cv.packDir(), null);
  assert.deepEqual(left(s.dir), []);
  s.done();
});

test('Activate CV: downloads, checks every file and unpacks to cv-pack\\<version>', async () => {
  const gh = github(pack());
  const s = shop({ fetch: gh.http });
  const seen: string[] = [];
  const first = s.cv.activate();
  assert.equal(first.phase, 'downloading');
  assert.equal(s.isActive(), true, 'kept, so the next start knows');
  await s.cv.settled((st) => { if (seen.at(-1) !== st.phase) seen.push(st.phase); });
  assert.deepEqual(seen, ['downloading', 'verifying', 'ready']);
  assert.deepEqual(gh.asked, [cvPackUrl('1.0.40')]);
  assert.deepEqual(s.cv.status(), { active: true, phase: 'ready', version: CV_PACK_VERSION });
  const here = join(s.dir, CV_PACK_VERSION);
  assert.equal(s.cv.packDir(), here);
  assert.deepEqual(left(s.dir), [CV_PACK_VERSION], 'no download or half-unpacked folder left');
  assert.equal(readFileSync(join(here, 'ffmpeg.exe'), 'utf8'), 'MZ pretend ffmpeg');
  assert.deepEqual(readFileSync(join(here, 'models/yolox_nano.onnx')), CONTENT['models/yolox_nano.onnx']);
  assert.ok(existsSync(join(here, 'node_modules/onnxruntime-node/package.json')));
  assert.ok(existsSync(join(here, 'manifest.json')));
  // Pressing it again changes nothing.
  assert.equal(s.cv.activate().phase, 'ready');
  assert.equal(gh.asked.length, 1);
  s.done();
});

test('the download reports its bytes as it goes', async () => {
  const body = pack();
  const s = shop({ fetch: github(body).http });
  s.cv.activate();
  let downloading: ReturnType<typeof s.cv.status> | null = null;
  await s.cv.settled((st) => { if (st.phase === 'downloading' && st.bytes > 0) downloading = st; });
  assert.deepEqual(downloading, { active: true, phase: 'downloading', bytes: body.length, total: body.length });
  s.done();
});

test('a corrupted file fails the check, leaves nothing under cv-pack and Retry starts again', async () => {
  const s = shop({ fetch: github(pack({ tamper: 'models/yolox_nano.onnx' })).http });
  s.cv.activate();
  await s.cv.settled();
  const st = s.cv.status();
  assert.equal(st.phase, 'failed');
  assert.match(st.phase === 'failed' ? st.reason : '', /models\/yolox_nano\.onnx/);
  assert.deepEqual(left(s.dir), []);
  assert.equal(s.cv.packDir(), null);
  s.done();
});

test('Retry after a failure downloads again', async () => {
  let body = pack({ tamper: 'ffmpeg.exe' });
  const s = shop({ fetch: (async (u: string) => github(body).http(u)) as unknown as typeof fetch });
  s.cv.activate();
  await s.cv.settled();
  assert.equal(s.cv.status().phase, 'failed');
  body = pack();
  s.cv.activate();
  await s.cv.settled();
  assert.deepEqual(s.cv.status(), { active: true, phase: 'ready', version: CV_PACK_VERSION });
  assert.deepEqual(left(s.dir), [CV_PACK_VERSION]);
  s.done();
});

test('an interrupted download fails and leaves nothing', async () => {
  const body = pack();
  const s = shop({ fetch: github(body, { cut: 100 }).http });
  s.cv.activate();
  await s.cv.settled();
  const st = s.cv.status();
  assert.equal(st.phase, 'failed');
  assert.match(st.phase === 'failed' ? st.reason : '', /download/i);
  assert.deepEqual(left(s.dir), []);
  s.done();
});

test('no pack on the release: failed, with the reason', async () => {
  const s = shop({ fetch: github(Buffer.alloc(0), { status: 404 }).http });
  s.cv.activate();
  await s.cv.settled();
  assert.deepEqual(s.cv.status(), { active: true, phase: 'failed', reason: 'GitHub answered 404' });
  assert.deepEqual(left(s.dir), []);
  s.done();
});

test('a pack for another version, a file missing from the manifest or a path out of the folder is refused', async () => {
  for (const [body, why] of [
    [pack({ version: '0' }), /version/],
    [pack({ extra: { 'evil.dll': 'x' } }), /evil\.dll/],
    [pack({ extra: { '../outside.txt': 'x' } }), /outside/],
  ] as const) {
    const s = shop({ fetch: github(body).http });
    s.cv.activate();
    await s.cv.settled();
    const st = s.cv.status();
    assert.equal(st.phase, 'failed');
    assert.match(st.phase === 'failed' ? st.reason : '', why);
    assert.deepEqual(left(s.dir), []);
    assert.ok(!existsSync(join(s.dir, '..', 'outside.txt')));
    s.done();
  }
});

test('start with CV on and this version installed: ready at once, nothing fetched', () => {
  const gh = github(pack());
  const s = shop({ fetch: gh.http, active: true });
  mkdirSync(join(s.dir, CV_PACK_VERSION), { recursive: true });
  writeFileSync(join(s.dir, CV_PACK_VERSION, 'manifest.json'), '{}');
  s.cv.start();
  assert.equal(s.cv.status().phase, 'ready');
  assert.equal(s.cv.packDir(), join(s.dir, CV_PACK_VERSION));
  assert.deepEqual(gh.asked, []);
  s.done();
});

test('start with an older pack: the new one comes in the background, CV paused meanwhile, then the old one goes', async () => {
  const gh = github(pack());
  const s = shop({ fetch: gh.http, active: true });
  mkdirSync(join(s.dir, 'old'), { recursive: true });
  writeFileSync(join(s.dir, 'old', 'manifest.json'), '{}');
  mkdirSync(join(s.dir, '.tmp-crashed'), { recursive: true }); // a power cut during an earlier unpack
  s.cv.start();
  assert.equal(s.cv.status().phase, 'downloading');
  assert.equal(s.cv.packDir(), null, 'paused: the worker does not run on the old pack');
  await s.cv.settled();
  assert.equal(s.cv.status().phase, 'ready');
  assert.deepEqual(left(s.dir), [CV_PACK_VERSION], 'old pack and leftovers deleted');
  s.done();
});

test('start with an older pack and a failing download: the old pack stays, CV stays paused', async () => {
  const s = shop({ fetch: github(pack({ tamper: 'ffmpeg.exe' })).http, active: true });
  mkdirSync(join(s.dir, 'old'), { recursive: true });
  s.cv.start();
  await s.cv.settled();
  assert.equal(s.cv.status().phase, 'failed');
  assert.equal(s.cv.packDir(), null);
  assert.deepEqual(left(s.dir), ['old']);
  s.done();
});
