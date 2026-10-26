import type { FromWorker, SeenBox, VisionFields, WorkerConfig } from './messages.ts';
import { followFloor, lost, sample as trackSample, startTracker, type Tracker } from './tracker.ts';
import {
  checkEvery, cpuGuard, cpuPercent, CPU_SAMPLE_MS, FRAME_H, FRAME_W, greyThumb, HEARTBEAT_MS, linkStep, PERF_MS, PERF_WINDOW_MS, presence,
  shouldReuse, zoneBox, type Guard, type Link, type Presence,
} from './visionCore.ts';
import type { Box, Rect } from './yolox.ts';

/**
 * The camera worker's brain (SCRUM-170): frames in, what the cameras saw out, as IPC messages.
 * No ffmpeg, ONNX Runtime or storage here (server/cv/worker.ts brings frames and `detect`), so it
 * is tested with fake frames and a fake detector.
 *
 * Each frame: is a check due (1 s, or 2 s while the CPU guard has slowed it)? Then the motion gate
 * (zones' crop as a grey thumbnail) either reuses the last detection or runs `detect` on the crop;
 * each person's foot point in a zone is a presence sample for that table's tracker (./tracker.ts),
 * whose changes go out as `table.state_changed`. A table seen by two cameras is present if either
 * sees someone. `tick` (every second): camera links, Live's camera events, the CPU guard, the
 * heartbeat. (Cleaning alerts went with SCRUM-182: a dirty table frees itself after `autoFreeS`.)
 */
export type EngineConfig = Omit<WorkerConfig, 'packDir' | 'cameras'> & { cameras: { id: string; zones: WorkerConfig['cameras'][number]['zones'] }[] };

/** Frames closer together than a check's interval minus this are skipped (frames come about 1 s apart). */
const SLACK_MS = 250;
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
/** A box in frame pixels as a share of the frame, for the owner's overlay. */
const share = (b: Box): SeenBox =>
  ({ x1: round4(b.x1 / FRAME_W), y1: round4(b.y1 / FRAME_H), x2: round4(b.x2 / FRAME_W), y2: round4(b.y2 / FRAME_H), score: Math.round(b.score * 100) / 100 });

interface Cam {
  id: string;
  zones: EngineConfig['cameras'][number]['zones'];
  zonesKey: string;
  box: Rect | null;
  link: Link;
  online: boolean;
  /** When each frame of the last HEARTBEAT_MS came. */
  frames: number[];
  lastCheck: number | null;
  last: { thumb: Uint8Array; at: number; persons: Box[] } | null;
  busy: boolean;
  /** Each of its tables: is someone there, at the last check, and how sure? */
  seen: Map<string, Presence>;
  /** For Performance: when each check ran, and each detection's time (the motion gate's reuses are checks, not detections). */
  checks: number[];
  detects: { at: number; ms: number }[];
}

export function visionEngine(o: {
  /** People in the crop of an rgb24 FRAME_W x FRAME_H frame, in frame pixels. */
  detect: (rgb: Uint8Array, crop: Rect) => Promise<Box[]>;
  send: (m: FromWorker) => void;
  now: () => number;
  /** This process's CPU time so far, µs, and the PC's logical cores. */
  cpuMicros: () => number;
  cores: number;
}) {
  let cfg: EngineConfig | null = null;
  const cams = new Map<string, Cam>();
  const trackers = new Map<string, Tracker>();
  let guard: Guard = { slowed: false, since: null };
  /** The camera the owner watches large (SCRUM-175), or null. */
  let watched: string | null = null;
  let cpu = 0;
  const start = o.now();
  let cpuAt = start, cpuUsed = o.cpuMicros(), beatAt = start, perfAt = start;
  /** One detection at a time: one ONNX session, one core. */
  let detecting: Promise<unknown> = Promise.resolve();

  const event = (fields: VisionFields, at = o.now()) => o.send({ type: 'event', at, fields });
  const log = (text: string) => o.send({ type: 'log', text });

  /** One presence sample for a table, from every camera that sees it and has not lost it. */
  const sample = (tableId: string, at: number) => {
    if (!cfg) return;
    const words = [...cams.values()].filter((c) => c.online).map((c) => c.seen.get(tableId)).filter((p) => p !== undefined);
    const present = words.some((p) => p.present);
    const confidence = Math.max(0, ...words.map((p) => p.confidence));
    const before = trackers.get(tableId) ?? startTracker(cfg.floor[tableId]?.state ?? 'free', cfg.floor[tableId]?.since ?? at);
    const { tracker, change } = trackSample(before, at, present, confidence, cfg);
    trackers.set(tableId, tracker);
    if (change) event({ type: 'table.state_changed', tableId, from: change.from, to: change.to, confidence: change.confidence }, change.at);
  };

  return {
    /** New settings, cameras, zones or floor. Cameras that stay keep their link and last detection. */
    configure(next: EngineConfig) {
      const t = o.now();
      const limitWas = cfg?.cpuLimit;
      cfg = next;
      for (const id of [...cams.keys()]) if (!next.cameras.some((c) => c.id === id)) cams.delete(id);
      for (const c of next.cameras) {
        const zonesKey = JSON.stringify(c.zones);
        const had = cams.get(c.id);
        if (had && had.zonesKey === zonesKey) continue;
        cams.set(c.id, {
          id: c.id, zones: c.zones, zonesKey, box: zoneBox(c.zones, FRAME_W, FRAME_H),
          link: had?.link ?? { started: t, lastFrame: null, reported: next.offline.includes(c.id) ? 'offline' : null },
          online: had?.online ?? false, frames: had?.frames ?? [], lastCheck: null, last: null, busy: false, seen: new Map(),
          checks: had?.checks ?? [], detects: had?.detects ?? [],
        });
      }
      const tables = new Set(next.cameras.flatMap((c) => c.zones.map((z) => z.tableId)));
      for (const id of [...trackers.keys()]) if (!tables.has(id)) trackers.delete(id);
      for (const id of tables) {
        const f = next.floor[id];
        const tr = trackers.get(id);
        trackers.set(id, tr ? followFloor(tr, f, next.mode) : startTracker(f?.state ?? 'free', f?.since ?? t));
      }
      if (limitWas !== undefined && limitWas !== next.cpuLimit) log(`CPU limit ${next.cpuLimit}%`);
    },

    /** One frame from a camera's ffmpeg. */
    async frame(cameraId: string, rgb: Uint8Array): Promise<void> {
      const c = cams.get(cameraId);
      if (!c || !cfg) return;
      const t = o.now();
      c.link = { ...c.link, lastFrame: t };
      c.frames.push(t);
      c.online = true;
      if (c.busy || !c.box || (c.lastCheck !== null && t - c.lastCheck < checkEvery(guard) - SLACK_MS)) return;
      c.lastCheck = t;
      c.checks.push(t);
      c.busy = true;
      try {
        const thumb = greyThumb(rgb, FRAME_W, FRAME_H, c.box);
        let persons: Box[];
        if (c.last && shouldReuse(c.last, thumb, t)) persons = c.last.persons;
        else {
          const box = c.box;
          const run = detecting.then(async () => {
            const began = performance.now();
            try { return await o.detect(rgb, box); } finally { c.detects.push({ at: t, ms: performance.now() - began }); }
          });
          detecting = run.catch(() => undefined);
          persons = await run;
          c.last = { thumb, at: t, persons };
        }
        if (cams.get(cameraId) !== c) return; // the zones changed meanwhile
        if (watched === cameraId) o.send({ type: 'seen', cameraId, at: t, detectedAt: c.last!.at, persons: persons.map(share) });
        c.seen = presence(persons, c.zones, FRAME_W, FRAME_H);
        for (const tableId of c.seen.keys()) sample(tableId, t);
      } catch (e) {
        log(`detection failed on ${cameraId}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        c.busy = false;
      }
    },

    /** Every second: camera links, Live's events, the CPU guard, the heartbeat. */
    tick() {
      if (!cfg) return;
      const t = o.now();
      for (const c of cams.values()) {
        const r = linkStep(c.link, t);
        c.link = r.link;
        if (c.online && !r.online) {
          c.online = false;
          log(`${c.id}: no frames for 30 s`);
          // Its tables keep their state but have no camera, unless another camera still sees them.
          for (const tableId of c.seen.keys()) {
            const other = [...cams.values()].some((x) => x !== c && x.online && x.seen.has(tableId));
            const tr = trackers.get(tableId);
            if (!other && tr) trackers.set(tableId, lost(tr));
          }
        }
        if (r.emit && cfg.mode === 'live') event({ type: r.emit, cameraId: c.id }, t);
      }

      if (t - cpuAt >= CPU_SAMPLE_MS) {
        const used = o.cpuMicros();
        cpu = cpuPercent(used - cpuUsed, t - cpuAt, o.cores);
        cpuAt = t;
        cpuUsed = used;
        const was = guard.slowed;
        guard = cpuGuard(guard, t, cpu, cfg.cpuLimit);
        if (guard.slowed !== was) log(guard.slowed ? `slowed to one check every 2 s: over ${cfg.cpuLimit}% CPU for 5 minutes` : 'back to one check a second');
      }

      if (t - perfAt >= PERF_MS) {
        perfAt = t;
        const since = t - PERF_WINDOW_MS;
        const perS = (times: number[]) => Math.round((times.filter((at) => at > since).length / (PERF_WINDOW_MS / 1000)) * 10) / 10;
        const cameras = [...cams.values()].map((c) => {
          c.checks = c.checks.filter((at) => at > since);
          c.detects = c.detects.filter((d) => d.at > since);
          const ms = c.detects.map((d) => d.ms);
          return { id: c.id, online: c.online, fps: perS(c.frames), checksPerS: perS(c.checks), detectMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null };
        });
        o.send({ type: 'perf', at: t, cpu: Math.min(100, cpu), cpuLimit: cfg.cpuLimit, slowed: guard.slowed, cameras });
      }

      if (t - beatAt >= HEARTBEAT_MS) {
        beatAt = t;
        const cameras = [...cams.values()].map((c) => {
          c.frames = c.frames.filter((at) => at > t - HEARTBEAT_MS);
          return { id: c.id, online: c.online, fps: Math.round((c.frames.length / (HEARTBEAT_MS / 1000)) * 10) / 10 };
        });
        o.send({ type: 'heartbeat', at: t, cameras, cpu: Math.min(100, cpu), slowed: guard.slowed });
      }
    },

    /** The owner opened this camera large (null: closed): each check's people go to the server for the overlay. */
    watch(cameraId: string | null) { watched = cameraId; },

    slowed: () => guard.slowed,
  };
}
export type VisionEngine = ReturnType<typeof visionEngine>;
