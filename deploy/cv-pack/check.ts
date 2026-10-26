// Checks a built CV pack the way the shop uses it (CI, after build.ps1): the shop server's own code
// (server/cvPack.ts) unpacks and verifies the zip, then ONNX Runtime loads from the unpacked folder
// alone (createRequire(<pack>/), as the CV worker will) and runs YOLOX nano on a 416x416 frame.
// Usage: node --experimental-strip-types deploy/cv-pack/check.ts <cv-pack-N-win-x64.zip>
import { createReadStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { CV_PACK_VERSION, cvPack } from '../../server/cvPack.ts';

const zip = process.argv[2];
if (!zip) throw new Error('usage: check.ts <zip>');
const data = mkdtempSync(join(tmpdir(), 'cv-check-'));
let active = false;
const cv = cvPack({
  dir: join(data, 'cv-pack'), appVersion: () => 'development', active: () => active, setActive: (on) => { active = on; },
  fetch: (async () => new Response(Readable.toWeb(createReadStream(zip)) as ReadableStream, { headers: { 'content-length': String(statSync(zip).size) } })) as unknown as typeof fetch,
});
cv.activate();
await cv.settled();
const status = cv.status();
const dir = cv.packDir();
if (status.phase !== 'ready' || !dir) throw new Error(`the server would not install this pack: ${JSON.stringify(status)}`);
console.log(`unpacked and verified by server/cvPack.ts: CV pack ${CV_PACK_VERSION} in ${dir}`);

const require = createRequire(pathToFileURL(`${dir}/`));
const from = require.resolve('onnxruntime-node');
if (!from.startsWith(dir)) throw new Error(`onnxruntime-node came from ${from}, not the pack`);
/** The little of onnxruntime-node used here (its types live in the pack, not in this repo). */
interface Ort {
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
  InferenceSession: { create(path: string): Promise<{ inputNames: string[]; outputNames: string[]; run(feeds: Record<string, unknown>): Promise<Record<string, { dims: number[] }>> }> };
}
const ort = require('onnxruntime-node') as Ort;
const session = await ort.InferenceSession.create(join(dir, 'models/yolox_nano.onnx'));
const frame = new ort.Tensor('float32', new Float32Array(3 * 416 * 416), [1, 3, 416, 416]);
const out = (await session.run({ [session.inputNames[0]]: frame }))[session.outputNames[0]];
// YOLOX at 416x416: 52² + 26² + 13² = 3549 boxes, each 4 + 1 + 80 COCO classes.
if (out.dims.join('x') !== '1x3549x85') throw new Error(`YOLOX nano answered ${out.dims.join('x')}, expected 1x3549x85`);
console.log(`onnxruntime-node from the pack ran YOLOX nano: ${session.inputNames[0]} 1x3x416x416 -> ${out.dims.join('x')} (Node ${process.version})`);
try { rmSync(data, { recursive: true, force: true }); } catch { /* Windows keeps the loaded binding locked: the runner is thrown away anyway */ }
