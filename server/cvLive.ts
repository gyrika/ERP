import { spawn as nodeSpawn } from 'node:child_process';
import { rtspUrl, testFailure, type TestCause } from '../src/domain/cameraSetup.ts';
import type { Spawn } from './cvCameras.ts';
import { inputArgs } from './cv/visionCore.ts';

/**
 * Camera views on #vision (SCRUM-180): the owner watches every camera, live, before trusting CV.
 * Only while someone watches, the shop server runs the CV pack's ffmpeg on a camera's sub-stream
 * and keeps its latest JPEG in memory; the screen polls for it. Frames are never written to disk,
 * an event, the log or the cloud: they live in this process until the next one replaces them.
 *
 * One ffmpeg per watched view at most. A tile decodes keyframes only (a picture every second or
 * few, very light); the large view decodes LIVE_FPS frames a second, and only one view is large
 * at a time. A view nobody asked for in IDLE_MS (the page was left, the browser closed) stops; so
 * does every view after UNUSED_MS without anyone touching the page ("paused" until they do).
 */

export const LIVE_FPS = 4;
/** The views that may run at once besides the large one: the shop's five fit, with room. */
export const MAX_TILES = 8;
/** No poll for this long: the page was left. */
export const IDLE_MS = 8_000;
/** Nobody touched the page for this long: stop until they do. */
export const UNUSED_MS = 120_000;
/** A camera that failed is tried again after this long. */
export const RETRY_MS = 10_000;
/** How long a poll for the large view waits for a newer frame. */
export const LIVE_WAIT_MS = 1_500;
const MAX_FRAME = 5_000_000;
const MAX_STDERR = 16_000;

export type ViewMode = 'tile' | 'live';

/** ffmpeg's arguments: the sub-stream over TCP (or a development file), one decoder thread, JPEGs as multipart on stdout. */
export const viewArgs = (url: string, mode: ViewMode): string[] => [
  '-hide_banner', '-loglevel', 'error', '-threads', '1',
  ...(mode === 'tile' ? ['-skip_frame', 'nokey'] : []),
  ...inputArgs(url), '-an', '-sn', '-dn',
  ...(mode === 'tile'
    ? ['-fps_mode', 'passthrough', '-vf', "scale='min(480,iw)':-2", '-q:v', '7']
    : ['-vf', `fps=${LIVE_FPS},scale='min(960,iw)':-2`, '-q:v', '5']),
  '-f', 'mpjpeg', 'pipe:1',
];

/**
 * ffmpeg's multipart JPEG (`-f mpjpeg`): "--ffmpeg", headers with Content-length, a blank line,
 * the JPEG. Returns a push(chunk) that hands each whole JPEG to `onFrame`.
 */
export const mpjpegReader = (onFrame: (jpeg: Buffer) => void): ((chunk: Buffer) => void) => {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) { if (buf.length > 4096) buf = Buffer.alloc(0); return; } // no header in sight: not mpjpeg
      const length = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, end).toString('latin1'))?.[1]);
      if (!Number.isSafeInteger(length) || length > MAX_FRAME) { buf = buf.subarray(end + 4); continue; }
      if (buf.length < end + 4 + length) return;
      const jpeg = Buffer.from(buf.subarray(end + 4, end + 4 + length));
      buf = buf.subarray(end + 4 + length);
      if (jpeg[0] === 0xff && jpeg[1] === 0xd8) onFrame(jpeg);
    }
  };
};

/** `file`: a development camera (CV_DEV_CAMERAS) instead of the stream. */
export interface ViewSource { ip: string; rtspPath: string; user?: string; password?: string; file?: string }

export type ViewFrame =
  | { state: 'frame'; seq: number; jpeg: Buffer; at: number }
  | { state: 'starting' }
  | { state: 'offline'; cause: TestCause; message: string }
  /** More views than MAX_TILES: open this one large to watch it. */
  | { state: 'busy' }
  /** UNUSED_MS without a touch: nothing runs until the next one. */
  | { state: 'paused' }
  | { state: 'pack' }
  | { state: 'unknown' };

type Child = ReturnType<Spawn>;
interface View {
  mode: ViewMode;
  child: Child | null;
  frame: { seq: number; jpeg: Buffer; at: number } | null;
  asked: number;
  used: number;
  failed: { cause: TestCause; message: string; at: number } | null;
  waiters: Set<() => void>;
}

export function liveViews(o: {
  /** The CV pack's ffmpeg.exe, or null while the pack is not there. */
  ffmpeg: () => string | null;
  /** Where the view is and its login, from the camera list and the kept logins; null: no such camera. */
  source: (id: string) => Promise<ViewSource | null>;
  spawn?: Spawn;
  now?: () => number;
  /** How often idle views are looked for; 0: never by itself (tests call sweep). */
  sweepMs?: number;
}) {
  const now = o.now ?? Date.now;
  const run = o.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as Child);
  const views = new Map<string, View>();
  const paused = new Set<string>();
  let seq = 0;
  let sweeper: ReturnType<typeof setInterval> | null = null;

  const stopOne = (id: string) => {
    const v = views.get(id);
    if (!v) return;
    views.delete(id);
    const child = v.child;
    v.child = null;
    try { child?.kill(); } catch { /* gone */ }
    for (const w of v.waiters) w();
    if (!views.size && sweeper) { clearInterval(sweeper); sweeper = null; }
  };

  const sweep = () => {
    const t = now();
    for (const [id, v] of views) {
      if (t - v.used > UNUSED_MS) { paused.add(id); stopOne(id); }
      else if (t - v.asked > IDLE_MS) stopOne(id);
    }
  };

  const start = (id: string, src: ViewSource, mode: ViewMode, ffmpeg: string): View => {
    const t = now();
    const v: View = { mode, child: null, frame: null, asked: t, used: t, failed: null, waiters: new Set() };
    views.set(id, v);
    if (!sweeper && (o.sweepMs ?? 2000) > 0) { sweeper = setInterval(sweep, o.sweepMs ?? 2000); sweeper.unref?.(); }
    let err = '';
    let child: Child;
    try { child = run(ffmpeg, viewArgs(src.file ?? rtspUrl(src), mode)); } catch {
      v.failed = { ...testFailure('could not start ffmpeg'), at: t };
      return v;
    }
    v.child = child;
    const read = mpjpegReader((jpeg) => {
      if (views.get(id) !== v) return;
      v.frame = { seq: ++seq, jpeg, at: now() };
      v.failed = null;
      for (const w of v.waiters) w();
    });
    child.stdout.on('data', read);
    child.stderr.on('data', (c: Buffer) => { if (err.length < MAX_STDERR) err += c.toString('utf8'); });
    child.on('error', () => { err += '\ncould not start ffmpeg'; });
    child.on('close', () => {
      if (views.get(id) !== v || v.child !== child) return; // stopped on purpose
      v.child = null;
      v.failed = { ...testFailure(err), at: now() }; // testFailure masks any login in ffmpeg's words
      for (const w of v.waiters) w();
    });
    return v;
  };

  /** Waits up to `ms` for a frame newer than `after` (or the view stopping or failing). */
  const newer = (v: View, after: number, ms: number) => new Promise<void>((resolve) => {
    if (ms <= 0 || (v.frame && v.frame.seq > after) || !v.child) { resolve(); return; }
    const done = () => { clearTimeout(timer); v.waiters.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    v.waiters.add(done);
  });

  const answer = (v: View | undefined): ViewFrame => {
    if (!v) return { state: 'starting' };
    if (v.frame && !v.failed) return { state: 'frame', ...v.frame };
    if (v.failed) return { state: 'offline', cause: v.failed.cause, message: v.failed.message };
    return { state: 'starting' };
  };

  return {
    /**
     * The latest frame of one view. `mode`: a tile or the large view; `after`: the last frame
     * the screen has (the large view waits for a newer one); `use`: someone touched the page.
     */
    async frame(id: string, q: { mode: ViewMode; after?: number; use?: boolean; waitMs?: number }): Promise<ViewFrame> {
      const t = now();
      let v = views.get(id);
      if (q.use) paused.delete(id);
      else if (paused.has(id) && !v) return { state: 'paused' };
      if (v) {
        v.asked = t;
        if (q.use) v.used = t;
        if (t - v.used > UNUSED_MS) { paused.add(id); stopOne(id); return { state: 'paused' }; }
      }
      const ffmpeg = o.ffmpeg();
      if (!ffmpeg) return { state: 'pack' };
      if (v?.failed && !v.child && t - v.failed.at >= RETRY_MS) { stopOne(id); v = undefined; } // try again
      if (v && q.mode === 'live' && v.mode === 'tile') { stopOne(id); v = undefined; } // one ffmpeg per view: the tile's makes way
      if (!v) {
        const src = await o.source(id);
        if (!src) return { state: 'unknown' };
        if (q.mode === 'live') { for (const [other, w] of views) if (other !== id && w.mode === 'live') stopOne(other); }
        else if ([...views.values()].filter((w) => w.mode === 'tile' && w.child).length >= MAX_TILES) return { state: 'busy' };
        v = start(id, src, q.mode, ffmpeg);
      }
      await newer(v, q.after ?? 0, q.waitMs ?? (q.mode === 'live' ? LIVE_WAIT_MS : 0));
      return answer(views.get(id) === v ? v : undefined);
    },

    /** The page was left, or the camera list changed: stop one view, or every one. */
    stop(id?: string) {
      if (id) stopOne(id);
      else { for (const k of [...views.keys()]) stopOne(k); paused.clear(); }
    },

    sweep,

    /** What runs now (for tests and the CPU check). */
    running: (): { id: string; mode: ViewMode }[] => [...views].filter(([, v]) => v.child).map(([id, v]) => ({ id, mode: v.mode })),
  };
}
export type LiveViews = ReturnType<typeof liveViews>;
