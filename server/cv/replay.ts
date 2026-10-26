// Replays a clip through the camera worker's brain (engine.ts) with the real detector: ffmpeg reads
// the file at one frame a second as fast as it can, and the engine's clock moves one second a frame,
// so a 80 s clip takes a few seconds and the result never depends on the PC's speed.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { TableState } from '../../src/domain/tables.ts';
import { loadDetector, type Detect } from './detector.ts';
import { visionEngine } from './engine.ts';
import type { ReplayClip } from './replayClips.ts';
import { FRAME_BYTES, FRAME_H, FRAME_W, frameReader } from './visionCore.ts';

export interface ReplayResult {
  changes: { tableId: string; from: TableState; to: TableState; atS: number }[];
  frames: number;
  /** Each detection's time, ms (the motion gate skips some frames). */
  detectMs: number[];
}

/** Every frame of a file, one a second, 640x360 rgb24. */
export const readFrames = (ffmpeg: string, file: string): Promise<Buffer[]> => new Promise((resolve, reject) => {
  const frames: Buffer[] = [];
  let err = '';
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-vf', `fps=1,scale=${FRAME_W}:${FRAME_H}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', frameReader(FRAME_BYTES, (f) => frames.push(f)));
  child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve(frames) : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-500)}`))));
});

export async function replay(clip: ReplayClip, file: string, o: { packDir: string; detect?: Detect }): Promise<ReplayResult> {
  const real = o.detect ?? await loadDetector(o.packDir);
  const detectMs: number[] = [];
  const detect: Detect = async (rgb, crop) => {
    const t = performance.now();
    try { return await real(rgb, crop); } finally { detectMs.push(performance.now() - t); }
  };
  const frames = await readFrames(join(o.packDir, 'ffmpeg.exe'), file);
  const start = 1_000_000_000_000;
  let clock = start;
  const changes: ReplayResult['changes'] = [];
  const engine = visionEngine({
    detect, now: () => clock, cpuMicros: () => 0, cores: 1,
    send: (m) => {
      if (m.type === 'event' && m.fields.type === 'table.state_changed') {
        const { tableId, from, to } = m.fields;
        changes.push({ tableId, from, to, atS: Math.round((m.at - start) / 1000) });
      }
    },
  });
  engine.configure({
    mode: 'shadow', ...clip.timers, cleanAlertS: 0, cpuLimit: 50, offline: [],
    cameras: [{ id: clip.name, zones: clip.zones }],
    floor: Object.fromEntries(clip.zones.map((z) => [z.tableId, { state: 'free' as const, since: start, alertId: null }])),
  });
  for (const f of frames) {
    await engine.frame(clip.name, f);
    engine.tick();
    clock += 1000;
  }
  return { changes, frames: frames.length, detectMs };
}

/** What differs from the clip's expected changes (empty: it passed). */
export const mismatches = (clip: ReplayClip, got: ReplayResult['changes'], tolerance: number): string[] => {
  const left = [...got];
  const out: string[] = [];
  for (const e of clip.expect) {
    const i = left.findIndex((g) => g.tableId === e.tableId && g.from === e.from && g.to === e.to && Math.abs(g.atS - e.atS) <= tolerance);
    if (i < 0) out.push(`missing ${e.tableId} ${e.from} -> ${e.to} at ${e.atS} s`);
    else left.splice(i, 1);
  }
  for (const g of left) out.push(`unexpected ${g.tableId} ${g.from} -> ${g.to} at ${g.atS} s`);
  return out;
};
