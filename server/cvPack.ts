import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

/**
 * The CV pack (SCRUM-169): what table detection needs that CheesyBeez Station does not ship,
 * fetched only when the owner presses "Activate CV" on #vision. ffmpeg.exe, ONNX Runtime
 * (node_modules/onnxruntime-node, loaded later with createRequire(<pack>/), so the Station's own
 * node_modules never change), the YOLOX nano model and their licences. CI builds it
 * (.github/workflows/station.yml, deploy/cv-pack/build.ps1) and attaches it to every release.
 *
 * The shop server downloads cv-pack-<CV_PACK_VERSION>-win-x64.zip from the release of the version
 * it runs, checks every file against the pack's manifest.json ({version, files: [{path, sha256}]}),
 * unpacks into a temporary folder and renames it to cv-pack\<version> only when all of it is
 * right, so a failure leaves nothing half-installed. No admin rights, no restart.
 * A new CV_PACK_VERSION in an update: the next start fetches it in the background with CV paused
 * (packDir() is null), then deletes the old pack.
 */
export const CV_PACK_VERSION = '1';

const RELEASES = 'https://github.com/gyrika/ERP/releases';
const asset = (version: string) => `cv-pack-${version}-win-x64.zip`;

/** The pack on the GitHub release of this app version; development builds take the latest release's. */
export const cvPackUrl = (appVersion: string, version = CV_PACK_VERSION): string =>
  /^\d+\.\d+\.\d+$/.test(appVersion) ? `${RELEASES}/download/v${appVersion}/${asset(version)}` : `${RELEASES}/latest/download/${asset(version)}`;

export type CvPackPhase =
  | { phase: 'idle' }
  | { phase: 'downloading'; bytes: number; total: number | null }
  | { phase: 'verifying' }
  | { phase: 'ready'; version: string }
  | { phase: 'failed'; reason: string };
export type CvPackStatus = CvPackPhase & { active: boolean };

export interface CvPackOptions {
  /** <data>\cv-pack: one folder per installed pack version. */
  dir: string;
  /** The running app version (version.txt), for the release to download from. */
  appVersion: () => string;
  /** CV switched on (kept in the shop's settings). */
  active: () => boolean;
  setActive: (on: boolean) => void;
  fetch?: typeof fetch;
  /** A download that sends nothing for this long is given up. */
  stallMs?: number;
}

interface ZipEntry { name: string; method: number; packed: number; size: number; offset: number }

/** The files in a zip (its central directory). Enough for the packs CI writes: no zip64, no encryption. */
async function zipEntries(file: string): Promise<ZipEntry[]> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tail = Buffer.alloc(Math.min(size, 22 + 0xffff));
    await fh.read(tail, 0, tail.length, size - tail.length);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) throw new Error('the download is not a zip file');
    const count = tail.readUInt16LE(end + 10);
    const dirSize = tail.readUInt32LE(end + 12);
    const dirAt = tail.readUInt32LE(end + 16);
    if (count === 0xffff || dirAt === 0xffffffff) throw new Error('the pack is too big to read');
    const dir = Buffer.alloc(dirSize);
    await fh.read(dir, 0, dirSize, dirAt);
    const entries: ZipEntry[] = [];
    const local = Buffer.alloc(30);
    for (let p = 0, i = 0; i < count; i++) {
      if (dir.readUInt32LE(p) !== 0x02014b50) throw new Error('the pack is damaged');
      const n = dir.readUInt16LE(p + 28);
      const at = dir.readUInt32LE(p + 42);
      await fh.read(local, 0, 30, at);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('the pack is damaged');
      entries.push({
        name: dir.toString('utf8', p + 46, p + 46 + n).replace(/\\/g, '/'),
        method: dir.readUInt16LE(p + 10), packed: dir.readUInt32LE(p + 20), size: dir.readUInt32LE(p + 24),
        offset: at + 30 + local.readUInt16LE(26) + local.readUInt16LE(28),
      });
      p += 46 + n + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** Writes one entry under `root`, returning its sha256. */
async function unpack(zip: string, e: ZipEntry, root: string): Promise<string> {
  const target = join(root, e.name);
  mkdirSync(dirname(target), { recursive: true });
  const hash = createHash('sha256');
  if (e.packed === 0) { writeFileSync(target, ''); return hash.digest('hex'); }
  if (e.method !== 0 && e.method !== 8) throw new Error(`${e.name} is packed in a way this server cannot read`);
  const read = createReadStream(zip, { start: e.offset, end: e.offset + e.packed - 1 });
  const hashing = new Transform({ transform(chunk: Buffer, _enc, done) { hash.update(chunk); done(null, chunk); } });
  if (e.method === 8) await pipeline(read, createInflateRaw(), hashing, createWriteStream(target));
  else await pipeline(read, hashing, createWriteStream(target));
  return hash.digest('hex');
}

/** A path that stays inside the pack folder: relative, forward slashes, no "..", no drive letters. */
const safePath = (name: string) => !/^\/|:/.test(name) && name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

const remove = (path: string) => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

/** Windows Defender looks at a new .exe or .dll for a moment and holds it open: a rename then fails with EPERM, so try again. */
async function rename(from: string, to: string, tries = 40): Promise<void> {
  for (let i = 1; ; i++) {
    try { renameSync(from, to); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= tries || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export function cvPack(o: CvPackOptions) {
  const http = o.fetch ?? fetch;
  const version = CV_PACK_VERSION;
  const stallMs = o.stallMs ?? 60_000;
  let now: CvPackPhase = { phase: 'idle' };
  let job: Promise<void> | null = null;
  const watchers = new Set<(s: CvPackStatus) => void>();
  const status = (): CvPackStatus => ({ active: o.active(), ...now });
  const set = (next: CvPackPhase) => { now = next; for (const w of watchers) w(status()); };
  const installed = () => existsSync(join(o.dir, version));
  /** Everything in cv-pack but this version's folder: older packs, and leftovers of a download cut short by a power cut. */
  const others = () => (existsSync(o.dir) ? readdirSync(o.dir).filter((name) => name !== version) : []);

  const download = async (zip: string) => {
    set({ phase: 'downloading', bytes: 0, total: null });
    const stop = new AbortController();
    let stall = setTimeout(() => stop.abort(), stallMs);
    try {
      const r = await http(cvPackUrl(o.appVersion(), version), { headers: { 'user-agent': 'CheesyBeez-Station' }, signal: stop.signal });
      if (!r.ok || !r.body) throw new Error(`GitHub answered ${r.status}`);
      const total = Number(r.headers.get('content-length')) || null;
      let bytes = 0;
      const count = new Transform({
        transform(chunk: Buffer, _enc, done) {
          clearTimeout(stall);
          stall = setTimeout(() => stop.abort(), stallMs);
          bytes += chunk.length;
          set({ phase: 'downloading', bytes, total });
          done(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(r.body as import('node:stream/web').ReadableStream), count, createWriteStream(zip));
      } catch {
        throw new Error('the download stopped part-way: check the internet and try again');
      }
      if (total !== null && bytes !== total) throw new Error('the download stopped part-way: check the internet and try again');
    } finally {
      clearTimeout(stall);
    }
  };

  const verify = async (zip: string, tmp: string) => {
    set({ phase: 'verifying' });
    const files = (await zipEntries(zip)).filter((e) => !e.name.endsWith('/'));
    const outside = files.find((e) => !safePath(e.name));
    if (outside) throw new Error(`the pack has a file outside its folder: ${outside.name}`);
    if (!files.some((e) => e.name === 'manifest.json')) throw new Error('the pack has no manifest.json');
    const hashes = new Map<string, string>();
    for (const e of files) hashes.set(e.name, await unpack(zip, e, tmp));
    let manifest: { version?: unknown; files?: { path?: unknown; sha256?: unknown }[] };
    try { manifest = JSON.parse(readFileSync(join(tmp, 'manifest.json'), 'utf8')); } catch { throw new Error('the pack’s manifest.json cannot be read'); }
    if (manifest.version !== version) throw new Error(`the pack is version ${String(manifest.version)}, this server needs ${version}`);
    const listed = new Map((manifest.files ?? []).map((f) => [String(f.path), String(f.sha256)]));
    for (const [path, sha] of listed) {
      if (!hashes.has(path)) throw new Error(`${path} is missing from the pack`);
      if (hashes.get(path) !== sha) throw new Error(`${path} is damaged (its sha256 does not match the manifest)`);
    }
    const extra = [...hashes.keys()].find((path) => path !== 'manifest.json' && !listed.has(path));
    if (extra) throw new Error(`${extra} is not in the pack’s manifest`);
  };

  const install = async () => {
    const id = randomBytes(4).toString('hex');
    const zip = join(o.dir, `.download-${version}-${id}.zip`);
    const tmp = join(o.dir, `.tmp-${version}-${id}`);
    try {
      mkdirSync(tmp, { recursive: true });
      await download(zip);
      await verify(zip, tmp);
      remove(join(o.dir, version));
      await rename(tmp, join(o.dir, version));
      remove(zip);
      for (const old of others()) remove(join(o.dir, old));
      set({ phase: 'ready', version });
    } catch (e) {
      remove(tmp);
      remove(zip);
      set({ phase: 'failed', reason: e instanceof Error ? e.message : String(e) });
    }
  };
  const run = () => { job ??= install().finally(() => { job = null; }); };

  return {
    status,

    /** On server start: a pack that is there is ready; a missing or older one is fetched in the background. */
    start(): void {
      if (!o.active()) return set({ phase: 'idle' });
      if (!installed()) return run();
      for (const old of others()) remove(join(o.dir, old));
      set({ phase: 'ready', version });
    },

    /** "Activate CV", and its Retry: switches CV on and fetches the pack unless it is there or on its way. */
    activate(): CvPackStatus {
      o.setActive(true);
      if (installed()) set({ phase: 'ready', version });
      else run();
      return status();
    },

    /** The pack folder for the CV worker; null while CV is off, paused for a new pack, or failed. */
    packDir(): string | null {
      return o.active() && now.phase === 'ready' ? join(o.dir, version) : null;
    },

    /** Resolves once the download in progress (if any) is over; `watch` sees every step. For tests and the log. */
    async settled(watch?: (s: CvPackStatus) => void): Promise<void> {
      if (watch) { watch(status()); watchers.add(watch); }
      try { await job; } finally { if (watch) watchers.delete(watch); }
    },
  };
}
export type CvPackApi = ReturnType<typeof cvPack>;
