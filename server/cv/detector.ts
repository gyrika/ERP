// YOLOX-Nano on ONNX Runtime, loaded from the CV pack folder with createRequire(<pack>/), so the
// Station's own node_modules never change. Used by the camera worker and the clip replay.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FRAME_H, FRAME_W, MAX_IOU, MIN_SCORE } from './visionCore.ts';
import { decodePersons, INPUT, letterbox, nms, toFrame, type Box, type Rect } from './yolox.ts';

interface Ort {
  InferenceSession: { create(path: string, o: Record<string, unknown>): Promise<Session> };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
}
interface Session { inputNames: string[]; outputNames: string[]; run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>> }

/** People in `crop` of an rgb24 FRAME_W x FRAME_H frame, in frame pixels. */
export type Detect = (rgb: Uint8Array, crop: Rect) => Promise<Box[]>;

export async function loadDetector(packDir: string): Promise<Detect> {
  const ort = createRequire(join(packDir, '/'))('onnxruntime-node') as Ort;
  const session = await ort.InferenceSession.create(join(packDir, 'models', 'yolox_nano.onnx'), {
    intraOpNumThreads: 1, // one core: the counter PC also runs the Register
    interOpNumThreads: 1,
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
  });
  const [input] = session.inputNames;
  const [output] = session.outputNames;
  return async (rgb, crop) => {
    const lb = letterbox(rgb, FRAME_W, FRAME_H, crop);
    const out = await session.run({ [input]: new ort.Tensor('float32', lb.tensor, [1, 3, INPUT, INPUT]) });
    return nms(decodePersons(out[output].data as Float32Array, MIN_SCORE), MAX_IOU).map((b) => toFrame(b, lb));
  };
}
