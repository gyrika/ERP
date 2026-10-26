// CV proof (SCRUM-165): one camera -> ffmpeg 1 fps -> YOLOX-Nano -> person boxes and ms per frame.
// Run on the shop PC before the vision worker is built, to see that the design fits its CPU.
//
//   set CV_PROOF_RTSP=rtsp://user:pass@192.168.1.50:554/stream2   (or a video or image file, to try it without a camera)
//   set CV_PACK_DIR=C:\cv-pack                                      (ffmpeg.exe, node_modules\onnxruntime-node, models\yolox_nano.onnx)
//   node --experimental-strip-types --no-warnings scripts/cv-proof.ts
//
// CV_PROOF_FRAMES (default 60) frames, one a second. The URL is never printed: it holds the camera's password.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { decodePersons, letterbox, nms, toFrame } from '../server/cv/yolox.ts';

const W = 640, H = 360, FRAME = W * H * 3;
const MIN_SCORE = 0.4, MAX_IOU = 0.45;

const source = process.env.CV_PROOF_RTSP;
const pack = process.env.CV_PACK_DIR;
const frames = Number(process.env.CV_PROOF_FRAMES ?? 60);
if (!source || !pack) {
  console.error('Set CV_PROOF_RTSP (an rtsp:// URL or a file) and CV_PACK_DIR (the unpacked CV pack).');
  process.exit(2);
}

// ONNX Runtime from the pack folder, so the Station's own node_modules stay as they are.
const ort = createRequire(join(pack, '/'))('onnxruntime-node');
const session = await ort.InferenceSession.create(join(pack, 'models', 'yolox_nano.onnx'), {
  intraOpNumThreads: 1, // one core: the counter PC also runs the Register
  executionMode: 'sequential',
  graphOptimizationLevel: 'all',
});
const inputName: string = session.inputNames[0];

const input = /^rtsps?:/i.test(source)
  ? ['-rtsp_transport', 'tcp', '-i', source]
  : /\.(jpe?g|png|bmp)$/i.test(source)
    ? ['-re', '-loop', '1', '-framerate', '5', '-i', source]
    : ['-re', '-stream_loop', '-1', '-i', source];
const ffmpeg = spawn(join(pack, 'ffmpeg.exe'), [
  '-hide_banner', '-nostats', '-benchmark', ...input, '-an',
  '-vf', `fps=1,scale=${W}:${H}`, '-frames:v', String(frames), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let log = '';
ffmpeg.stderr.on('data', (d: Buffer) => { log = (log + d.toString()).slice(-4000); });

const totals: number[] = [], infers: number[] = [];
const cpuStart = process.cpuUsage();
const wallStart = performance.now();
let pending = Buffer.alloc(0);
let n = 0;

async function detect(rgb: Uint8Array) {
  const t0 = performance.now();
  const lb = letterbox(rgb, W, H);
  const t1 = performance.now();
  const out = await session.run({ [inputName]: new ort.Tensor('float32', lb.tensor, [1, 3, 416, 416]) });
  const t2 = performance.now();
  const people = nms(decodePersons(out[session.outputNames[0]].data as Float32Array, MIN_SCORE), MAX_IOU).map((b) => toFrame(b, lb));
  const t3 = performance.now();
  totals.push(t3 - t0);
  infers.push(t2 - t1);
  const boxes = people.map((b) => `[${[b.x1, b.y1, b.x2, b.y2].map(Math.round).join(',')} ${b.score.toFixed(2)}]`).join(' ');
  console.log(`frame ${String(++n).padStart(3)}  prep ${(t1 - t0).toFixed(1)} ms  infer ${(t2 - t1).toFixed(1)} ms  post ${(t3 - t2).toFixed(1)} ms  persons ${people.length} ${boxes}`);
}

// Frames come one a second, so detection always finishes before the next; a queue keeps the order anyway.
let queue = Promise.resolve();
ffmpeg.stdout.on('data', (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= FRAME) {
    const rgb = new Uint8Array(pending.subarray(0, FRAME));
    pending = pending.subarray(FRAME);
    queue = queue.then(() => detect(rgb));
  }
});

ffmpeg.on('close', async (code) => {
  await queue;
  if (n === 0) {
    console.error(`No frames (ffmpeg exit ${code}). Last ffmpeg output:\n${log.replace(/rtsps?:\/\/[^\s]+/gi, '<camera url>')}`);
    process.exit(1);
  }
  const wall = (performance.now() - wallStart) / 1000;
  const cpu = process.cpuUsage(cpuStart);
  const nodeCpu = (cpu.user + cpu.system) / 1e6;
  const bench = /bench: utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(log);
  const ffCpu = bench ? Number(bench[1]) + Number(bench[2]) : NaN;
  const cores = cpus().length;
  const pct = (sec: number) => `${((sec / wall) * 100).toFixed(1)}% of one core`;
  const sorted = [...totals].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1);
  const mean = (xs: number[]) => (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(1);
  // Four cameras at 1 fps, every frame detected (the motion gate in the worker skips most of them).
  const fourCams = (4 * (nodeCpu + (Number.isNaN(ffCpu) ? 0 : ffCpu))) / wall / cores * 100;
  console.log(`
${n} frames in ${wall.toFixed(0)} s on ${cores} logical cores (${cpus()[0].model.trim()})
per frame: mean ${mean(totals)} ms, p50 ${q(0.5)} ms, p95 ${q(0.95)} ms (inference alone mean ${mean(infers)} ms)
cpu: node ${pct(nodeCpu)}, ffmpeg ${Number.isNaN(ffCpu) ? 'unknown' : pct(ffCpu)}
4 cameras, every frame detected: about ${fourCams.toFixed(1)}% of the whole CPU (limit 15%)`);
});
