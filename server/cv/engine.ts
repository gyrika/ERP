import { cameraLost, newTracker, observe, type TableTracker } from '../../src/domain/tables.ts';
import type { FromWorker, VisionFields, WorkerConfig } from './messages.ts';
import {
  alertsDue, checkEvery, cpuGuard, cpuPercent, CPU_SAMPLE_MS, followFloor, FRAME_H, FRAME_W, greyThumb, HEARTBEAT_MS, linkStep, presence,
  shouldReuse, zoneBox, type Guard, type Link,
} from './visionCore.ts';
import type { Box, Rect } from './yolox.ts';

/**
 * The camera worker's brain (SCRUM-170): frames in, what the cameras saw out, as IPC messages.
 * No ffmpeg, ONNX Runtime or storage here (server/cv/worker.ts brings frames and `detect`), so it
 * is tested with fake frames and a fake detector.
 *
 * Each frame: is a check due (1 s, or 2 s while the CPU guard has slowed it)? Then the motion gate
 * (zones' crop as a grey thumbnail) either reuses the last detection or runs `detect` on the crop;
 * each person's foot point in a zone is a presence sample for that table's tracker (tables.ts),
 * whose changes go out as `table.state_changed`. A table seen by two cameras is present if either
 * sees someone. `tick` (every second): camera links, Live's alerts and camera events, the CPU
 * guard, the heartbeat.
 */
export type EngineConfig = Omit<WorkerConfig, 'packDir' | 'cameras'> & { cameras: { id: string; zones: WorkerConfig['cameras'][number]['zones'] }[] };

/** Frames closer together than a check's interval minus this are skipped (frames come about 1 s apart). */
const SLACK_MS = 250;

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
  /** Each of its tables: is someone there, at the last check? */
  seen: Map<string, boolean>;
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
  const trackers = new Map<string, TableTracker>();
  const sent = new Set<string>();
  let guard: Guard = { slowed: false, since: null };
  let cpu = 0;
  const start = o.now();
  let cpuAt = start, cpuUsed = o.cpuMicros(), beatAt = start;
  /** One detection at a time: one ONNX session, one core. */
  let detecting: Promise<unknown> = Promise.resolve();

  const event = (fields: VisionFields, at = o.now()) => o.send({ type: 'event', at, fields });
  const log = (text: string) => o.send({ type: 'log', text });

  /** One presence sample for a table, from every camera that sees it and has not lost it. */
  const sample = (tableId: string, at: number) => {
    if (!cfg) return;
    const present = [...cams.values()].some((c) => c.online && c.seen.get(tableId) === true);
    const before = trackers.get(tableId) ?? newTracker(cfg.floor[tableId]?.state ?? 'free', cfg.floor[tableId]?.since ?? at);
    const { tracker, change } = observe(before, { at, present }, { seatS: cfg.seatS, leaveS: cfg.leaveS });
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
        });
      }
      const tables = new Set(next.cameras.flatMap((c) => c.zones.map((z) => z.tableId)));
      for (const id of [...trackers.keys()]) if (!tables.has(id)) trackers.delete(id);
      for (const id of tables) {
        const f = next.floor[id];
        const tr = trackers.get(id);
        trackers.set(id, tr ? followFloor(tr, f, next.mode) : newTracker(f?.state ?? 'free', f?.since ?? t));
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
      c.busy = true;
      try {
        const thumb = greyThumb(rgb, FRAME_W, FRAME_H, c.box);
        let persons: Box[];
        if (c.last && shouldReuse(c.last, thumb, t)) persons = c.last.persons;
        else {
          const box = c.box;
          const run = detecting.then(() => o.detect(rgb, box));
          detecting = run.catch(() => undefined);
          persons = await run;
          c.last = { thumb, at: t, persons };
        }
        if (cams.get(cameraId) !== c) return; // the zones changed meanwhile
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
            if (!other && tr) trackers.set(tableId, cameraLost(tr));
          }
        }
        if (r.emit && cfg.mode === 'live') event({ type: r.emit, cameraId: c.id }, t);
      }
      if (cfg.mode === 'live') for (const a of alertsDue(cfg.floor, t, cfg.cleanAlertS, sent)) event(a, t);

      if (t - cpuAt >= CPU_SAMPLE_MS) {
        const used = o.cpuMicros();
        cpu = cpuPercent(used - cpuUsed, t - cpuAt, o.cores);
        cpuAt = t;
        cpuUsed = used;
        const was = guard.slowed;
        guard = cpuGuard(guard, t, cpu, cfg.cpuLimit);
        if (guard.slowed !== was) log(guard.slowed ? `slowed to one check every 2 s: over ${cfg.cpuLimit}% CPU for 5 minutes` : 'back to one check a second');
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

    slowed: () => guard.slowed,
  };
}
export type VisionEngine = ReturnType<typeof visionEngine>;
