// The real camera worker on development cameras (SCRUM-170): the replay clips looped in real time,
// one ffmpeg each at 1 fps, YOLOX on one thread, as the shop server would run it. Prints what the
// worker says and, at the end, the CPU of the worker and its ffmpegs as a share of the whole PC.
// On the shop PC with real cameras, the heartbeat on #vision says the same for the worker.
//
//   set CV_PACK_DIR=C:\cv-pack
//   npm run cv:clips            (once)
//   npm run cv:live             (CV_LIVE_SECONDS, default 120; CV_LIVE_CAMERAS, default 4)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerConfig } from '../server/cv/messages.ts';
import { REPLAY_CLIPS } from '../server/cv/replayClips.ts';
import { workerProcess } from '../server/cvWorker.ts';

const pack = process.env.CV_PACK_DIR;
if (!pack) { console.error('Set CV_PACK_DIR to the unpacked CV pack.'); process.exit(2); }
const seconds = Number(process.env.CV_LIVE_SECONDS ?? 120);
const count = Number(process.env.CV_LIVE_CAMERAS ?? 4);
const clips = fileURLToPath(new URL('../test-assets/cv-clips/', import.meta.url));
const cameras = Array.from({ length: count }, (_, i) => {
  const clip = REPLAY_CLIPS[i % REPLAY_CLIPS.length];
  const file = join(clips, clip.name, 'clip.mp4');
  if (!existsSync(file)) { console.error(`${file} is missing: run npm run cv:clips first.`); process.exit(2); }
  return { id: `${clip.name}-${i + 1}`, url: file, zones: clip.zones.map((z) => ({ ...z, tableId: `${z.tableId}-${i + 1}` })) };
});

/** CPU seconds so far of the worker and of every ffmpeg it started (Windows). */
const cpuSeconds = (pid: number): { worker: number; ffmpeg: number } => {
  const ps = `$w = Get-Process -Id ${pid}; $f = Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { (Get-Process -Id $_.ProcessId).CPU }; "$($w.CPU) $(($f | Measure-Object -Sum).Sum)"`;
  const out = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\s+/);
  return { worker: Number(out[0]) || 0, ffmpeg: Number(out[1]) || 0 };
};

const config: WorkerConfig = {
  packDir: pack, mode: 'shadow', seatS: 10, leaveS: 20, cleanAlertS: 0, cpuLimit: 50, cameras, offline: [],
  floor: Object.fromEntries(cameras.flatMap((c) => c.zones.map((z) => [z.tableId, { state: 'free' as const, since: Date.now(), alertId: null }]))),
};
const worker = workerProcess({
  log: (text) => console.log(`server: ${text}`),
  onMessage: (m) => {
    if (m.type === 'log') console.log(`worker: ${m.text}`);
    else if (m.type === 'event') console.log(`event: ${JSON.stringify(m.fields)}`);
    else if (m.type === 'heartbeat') console.log(`heartbeat: cpu ${m.cpu}% slowed ${m.slowed} ${m.cameras.map((c) => `${c.id} ${c.fps} fps`).join(', ')}`);
  },
});
worker.set(config);

const WARM_MS = 15_000;
await new Promise((r) => setTimeout(r, WARM_MS));
const pid = worker.pid();
if (!pid) { console.error('The worker is not running.'); process.exit(1); }
const before = cpuSeconds(pid);
const t0 = Date.now();
await new Promise((r) => setTimeout(r, seconds * 1000));
const after = cpuSeconds(pid);
const wall = (Date.now() - t0) / 1000;
const share = (s: number) => `${((s / wall / cpus().length) * 100).toFixed(1)}%`;
console.log(`
${count} development cameras for ${wall.toFixed(0)} s on ${cpus().length} logical cores (${cpus()[0].model.trim()}):
worker (decode + YOLOX): ${share(after.worker - before.worker)} of the PC
ffmpeg (${count} x 1 fps): ${share(after.ffmpeg - before.ffmpeg)} of the PC
together: ${share(after.worker - before.worker + after.ffmpeg - before.ffmpeg)} of the PC (the owner's limit is 15% by default)`);
await worker.stop();
