// The camera worker (SCRUM-170): a child process of the shop server, started by server/cvWorker.ts
// with Node IPC. It reads each camera in use with the CV pack's ffmpeg (1 fps, 640x360 rgb24 to a
// pipe), finds people with YOLOX-Nano on ONNX Runtime (one thread), and tells the server what the
// cameras saw (server/cv/engine.ts). It never touches storage: no files, no database, no network
// but the cameras; frames live in memory until the next one. Its messages: server/cv/messages.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants, cpus, setPriority } from 'node:os';
import { join } from 'node:path';
import { testFailure } from '../../src/domain/cameraSetup.ts';
import { visionEngine } from './engine.ts';
import type { FromWorker, ToWorker, WorkerCamera, WorkerConfig } from './messages.ts';
import { cameraArgs, FRAME_BYTES, frameReader, MAX_IOU, MIN_SCORE, RECONNECT_MS } from './visionCore.ts';
import { decodePersons, INPUT, letterbox, nms, toFrame, type Box, type Rect } from './yolox.ts';

const send = (m: FromWorker) => { try { process.send?.(m); } catch { /* the server is gone: disconnect ends us */ } };
const log = (text: string) => send({ type: 'log', text });

// ----- ONNX Runtime, from the pack folder (createRequire), so the Station's own node_modules never change -----
interface Ort {
  InferenceSession: { create(path: string, o: Record<string, unknown>): Promise<Session> };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
}
interface Session { inputNames: string[]; outputNames: string[]; run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>> }
let model: { packDir: string; ready: Promise<{ ort: Ort; session: Session }> } | null = null;

const loadModel = (packDir: string) => {
  const ready = (async () => {
    const ort = createRequire(join(packDir, '/'))('onnxruntime-node') as Ort;
    const session = await ort.InferenceSession.create(join(packDir, 'models', 'yolox_nano.onnx'), {
      intraOpNumThreads: 1, // one core: the counter PC also runs the Register
      interOpNumThreads: 1,
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
    });
    log('model loaded');
    return { ort, session };
  })();
  ready.catch((e: unknown) => {
    log(`ONNX Runtime could not load from the CV pack: ${e instanceof Error ? e.message : String(e)}`);
    quit(1);
  });
  model = { packDir, ready };
};

const detect = async (rgb: Uint8Array, crop: Rect): Promise<Box[]> => {
  const { ort, session } = await model!.ready;
  const lb = letterbox(rgb, 640, 360, crop);
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', lb.tensor, [1, 3, INPUT, INPUT]) });
  return nms(decodePersons(out[session.outputNames[0]].data as Float32Array, MIN_SCORE), MAX_IOU).map((b) => toFrame(b, lb));
};

const engine = visionEngine({
  detect, send, now: Date.now, cores: cpus().length,
  cpuMicros: () => { const u = process.cpuUsage(); return u.user + u.system; },
});

// ----- one ffmpeg per camera in use -----
interface Feed { cam: WorkerCamera; child: ChildProcess | null; retry: ReturnType<typeof setTimeout> | null }
const feeds = new Map<string, Feed>();
let config: WorkerConfig | null = null;

const startFeed = (f: Feed) => {
  f.retry = null;
  if (!config || feeds.get(f.cam.id) !== f) return;
  let err = '';
  const child = spawn(join(config.packDir, 'ffmpeg.exe'), cameraArgs(f.cam.url), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  f.child = child;
  try { if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* gone already */ }
  child.stdout?.on('data', frameReader(FRAME_BYTES, (frame) => { void engine.frame(f.cam.id, frame); }));
  child.stderr?.on('data', (d: Buffer) => { err = (err + d.toString('utf8')).slice(-4000); });
  child.on('error', () => { err += '\ncould not start ffmpeg'; });
  child.on('close', (code) => {
    if (f.child !== child) return; // stopped on purpose
    f.child = null;
    if (feeds.get(f.cam.id) !== f) return;
    // testFailure masks any login in ffmpeg's words; the server masks again before cv.log.
    log(`${f.cam.id}: ffmpeg stopped (exit ${code ?? '?'}): ${testFailure(err).cause}; again in ${RECONNECT_MS / 1000} s`);
    f.retry = setTimeout(() => startFeed(f), RECONNECT_MS);
  });
};

const stopFeed = (f: Feed) => {
  if (f.retry) clearTimeout(f.retry);
  const child = f.child;
  f.child = null;
  try { child?.kill(); } catch { /* gone */ }
};

const configure = (next: WorkerConfig) => {
  config = next;
  if (!model || model.packDir !== next.packDir) loadModel(next.packDir);
  for (const [id, f] of feeds) {
    const cam = next.cameras.find((c) => c.id === id);
    if (!cam || cam.url !== f.cam.url) { stopFeed(f); feeds.delete(id); } else f.cam = cam;
  }
  for (const cam of next.cameras) {
    if (feeds.has(cam.id)) continue;
    const f: Feed = { cam, child: null, retry: null };
    feeds.set(cam.id, f);
    startFeed(f);
  }
  engine.configure({ ...next, cameras: next.cameras.map((c) => ({ id: c.id, zones: c.zones })) });
};

function quit(code = 0): never {
  for (const f of feeds.values()) stopFeed(f);
  process.exit(code);
}

process.on('message', (m: ToWorker) => {
  if (m.type === 'stop') quit(0);
  else if (m.type === 'config') configure(m.config);
});
process.on('disconnect', () => quit(0)); // the server went: never leave ffmpeg running
setInterval(() => engine.tick(), 1000);
send({ type: 'ready' });
