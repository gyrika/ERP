// The camera worker's rules (SCRUM-170), pure: frames, the motion gate, the crop, camera links,
// the CPU guard, Live's floor and cleaning alerts. Time is passed in, never read, so all of it is
// tested without a camera, ffmpeg or ONNX Runtime. server/cv/engine.ts puts them together.
import { footPoint, pointInPolygon, type TableState, type ZoneSpec } from '../../src/domain/tables.ts';
import type { Box, Rect } from './yolox.ts';

/** What the worker reads from each camera: 640x360 rgb24, one frame a second. */
export const FRAME_W = 640;
export const FRAME_H = 360;
export const FRAME_BYTES = FRAME_W * FRAME_H * 3;
/** YOLOX: people at least this sure, after non-maximum suppression at this overlap. */
export const MIN_SCORE = 0.4;
export const MAX_IOU = 0.45;
/** The crop is the zones' bounding box grown by this share of its size on every side. */
export const CROP_MARGIN = 0.1;

/** The motion gate's thumbnail of the crop, grey. */
export const MOTION_W = 64;
export const MOTION_H = 36;
/** Mean absolute difference (0-1) under which nothing moved since the last detection. */
export const MOTION_THRESHOLD = 6 / 255;
/** A detection reused for at most this long, moved or not. */
export const REUSE_MS = 30_000;

/** One check a second; two seconds apart while the CPU guard has slowed the worker. */
export const CHECK_MS = 1000;
export const SLOW_CHECK_MS = 2000;
/** The CPU guard: over (or back under) the owner's limit this long changes pace. */
export const CPU_GUARD_MS = 5 * 60_000;
/** How often the worker measures its CPU. */
export const CPU_SAMPLE_MS = 10_000;

/** ffmpeg exited: try that camera again after this long. */
export const RECONNECT_MS = 10_000;
/** No frame for this long: the camera is offline (heartbeat, the tables lose their camera). */
export const NO_FRAMES_MS = 30_000;
/** Offline this long (no frames): Live records `vision.camera_offline`. */
export const OFFLINE_REPORT_MS = 300_000;
/**
 * How often the worker tells the server how it is doing now (CPU, frames and checks a second, how
 * long a detection takes): memory only, for #vision's Performance (owner, 2026-10-27).
 */
export const PERF_MS = 2000;
/** The window those numbers are measured over. */
export const PERF_WINDOW_MS = 10_000;
/** How often the worker sends a heartbeat; the server keeps one per HEARTBEAT_KEEP_MS. */
export const HEARTBEAT_MS = 30_000;
export const HEARTBEAT_KEEP_MS = 300_000;

/** The worker process exited: start it again after 1 s, doubling to 60 s. */
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 60_000;
/** A worker that ran this long was well: the next restart waits BACKOFF_MIN_MS again. */
export const STABLE_MS = 60_000;

/**
 * How ffmpeg opens a source: a camera's RTSP stream over TCP, or, in development only
 * (CV_DEV_CAMERAS), a video file looped at its own speed or a still image: a camera without a camera.
 */
export const inputArgs = (source: string): string[] =>
  /^rtsps?:\/\//i.test(source) ? ['-timeout', '5000000', '-rtsp_transport', 'tcp', '-i', source]
    : /\.(jpe?g|png|bmp)$/i.test(source) ? ['-re', '-loop', '1', '-framerate', '1', '-i', source]
      : ['-re', '-stream_loop', '-1', '-i', source];

/**
 * Development cameras: CV_DEV_CAMERAS="front=C:\clips\cafe.mp4;back=C:\clips\empty.jpg" puts a looping
 * file where a camera's stream would be. Read from the environment only, never from a screen.
 */
export const devSources = (value: string | undefined): Map<string, string> =>
  new Map((value ?? '').split(';').map((pair) => pair.split('=')).flatMap(([id, ...file]) =>
    (id?.trim() && file.join('=').trim() ? [[id.trim(), file.join('=').trim()] as [string, string]] : [])));

/** ffmpeg's arguments: the source, one frame a second, raw rgb24 to stdout (memory only). */
export const cameraArgs = (source: string): string[] => [
  '-hide_banner', '-loglevel', 'error', '-nostats', '-threads', '1', ...inputArgs(source), '-an', '-sn', '-dn',
  '-vf', `fps=1,scale=${FRAME_W}:${FRAME_H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
];

/** Returns a push(chunk) that hands each whole `size`-byte frame to `onFrame`, in its own buffer. */
export const frameReader = (size: number, onFrame: (frame: Buffer) => void): ((chunk: Buffer) => void) => {
  let frame = Buffer.allocUnsafe(size);
  let filled = 0;
  return (chunk) => {
    for (let i = 0; i < chunk.length;) {
      const n = Math.min(size - filled, chunk.length - i);
      chunk.copy(frame, filled, i, i + n);
      filled += n;
      i += n;
      if (filled === size) { onFrame(frame); frame = Buffer.allocUnsafe(size); filled = 0; }
    }
  };
};

/** The part of the frame worth reading: every zone of this camera, plus CROP_MARGIN, in whole pixels. Null: no zones. */
export const zoneBox = (zones: readonly ZoneSpec[], width: number, height: number, margin = CROP_MARGIN): Rect | null => {
  const points = zones.flatMap((z) => z.points);
  if (!points.length) return null;
  const xs = points.map((p) => p.x * width), ys = points.map((p) => p.y * height);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const mx = (maxX - minX) * margin, my = (maxY - minY) * margin;
  const x = Math.max(0, Math.floor(minX - mx)), y = Math.max(0, Math.floor(minY - my));
  const x2 = Math.min(width, Math.ceil(maxX + mx)), y2 = Math.min(height, Math.ceil(maxY + my));
  return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
};

/** The crop as a MOTION_W x MOTION_H grey thumbnail (each cell the mean of its pixels). */
export const greyThumb = (rgb: Uint8Array, width: number, _height: number, r: Rect): Uint8Array => {
  const out = new Uint8Array(MOTION_W * MOTION_H);
  for (let ty = 0; ty < MOTION_H; ty++) {
    const y0 = r.y + Math.floor((ty * r.h) / MOTION_H), y1 = Math.max(y0 + 1, r.y + Math.floor(((ty + 1) * r.h) / MOTION_H));
    for (let tx = 0; tx < MOTION_W; tx++) {
      const x0 = r.x + Math.floor((tx * r.w) / MOTION_W), x1 = Math.max(x0 + 1, r.x + Math.floor(((tx + 1) * r.w) / MOTION_W));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, i = (y * width + x0) * 3; x < x1; x++, i += 3) sum += rgb[i] * 299 + rgb[i + 1] * 587 + rgb[i + 2] * 114;
      }
      out[ty * MOTION_W + tx] = Math.round(sum / 1000 / ((y1 - y0) * (x1 - x0)));
    }
  }
  return out;
};

/** Mean absolute difference of two thumbnails, 0-1. */
export const meanAbsDiff = (a: Uint8Array, b: Uint8Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length / 255;
};

/** The motion gate: nothing moved since the last detection, and it is under REUSE_MS old. */
export const shouldReuse = (last: { thumb: Uint8Array; at: number } | null, thumb: Uint8Array, now: number): boolean =>
  last !== null && now - last.at < REUSE_MS && meanAbsDiff(last.thumb, thumb) < MOTION_THRESHOLD;

/** One table's word from one check: someone's foot point in its zone, and the best score of those people (0 when none). */
export interface Presence { present: boolean; confidence: number }

/** Each zone's table: is someone's foot point in it? (A table with two zones is present if either is.) */
export const presence = (persons: readonly Box[], zones: readonly ZoneSpec[], width: number, height: number): Map<string, Presence> => {
  const feet = persons.map((b) => { const f = footPoint(b); return { x: f.x / width, y: f.y / height, score: b.score }; });
  const out = new Map<string, Presence>();
  for (const z of zones) {
    const best = Math.max(out.get(z.tableId)?.confidence ?? 0, ...feet.filter((f) => pointInPolygon(f, z.points)).map((f) => f.score));
    out.set(z.tableId, { present: best > 0, confidence: best });
  }
  return out;
};

export const restartDelay = (failures: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(failures, 16));

/** One camera's link: when it was first watched, its last frame, and what Live last recorded about it. */
export interface Link { started: number; lastFrame: number | null; reported: 'online' | 'offline' | null }

/**
 * Online: a frame in the last NO_FRAMES_MS. `emit`: what Live records now. Offline once it has had
 * no frame for OFFLINE_REPORT_MS; online again with its first frame after that.
 */
export const linkStep = (link: Link, now: number): { link: Link; online: boolean; emit: 'vision.camera_offline' | 'vision.camera_online' | null } => {
  const quiet = now - (link.lastFrame ?? link.started);
  const online = link.lastFrame !== null && quiet < NO_FRAMES_MS;
  if (online && link.reported === 'offline') return { link: { ...link, reported: 'online' }, online, emit: 'vision.camera_online' };
  if (!online && quiet >= OFFLINE_REPORT_MS && link.reported !== 'offline') return { link: { ...link, reported: 'offline' }, online, emit: 'vision.camera_offline' };
  return { link, online, emit: null };
};

/** The CPU guard. `since`: when the present run of samples against the current pace began. */
export interface Guard { slowed: boolean; since: number | null }

/** One CPU sample (percent of the whole PC) against the owner's limit. At the limit counts as under. */
export const cpuGuard = (g: Guard, at: number, pct: number, limit: number): Guard => {
  const against = g.slowed ? pct <= limit : pct > limit;
  if (!against) return g.since === null ? g : { ...g, since: null };
  const since = g.since ?? at;
  return at - since >= CPU_GUARD_MS ? { slowed: !g.slowed, since: null } : { ...g, since };
};

export const checkEvery = (g: Guard): number => (g.slowed ? SLOW_CHECK_MS : CHECK_MS);

/** CPU time (µs) used in `wallMs`, as a share of the whole PC, in percent. */
export const cpuPercent = (usedMicros: number, wallMs: number, cores: number): number =>
  wallMs <= 0 || cores <= 0 ? 0 : Math.round((usedMicros / 1000 / wallMs / cores) * 1000) / 10;

/** A table on the shop's floor, as the server folds it. */
export interface FloorState { state: TableState; since: number; alertId: string | null }
