// YOLOX-Nano maths: pure, no ONNX Runtime here, so it is tested without the CV pack.
// The model (YOLOX GitHub release 0.1.1rc0, yolox_nano.onnx) takes 1×3×416×416 float BGR 0-255,
// the image scaled into the top-left corner and padded with grey 114, and returns 3549 anchors × 85:
// x, y, log w, log h (raw), objectness and 80 class scores (already sigmoid). Class 0 is person.

export const INPUT = 416;
const STRIDES = [8, 16, 32];
const CLASSES = 80;
const PAD = 114;

/** A box in pixels of whatever image it was found in. */
export interface Box { x1: number; y1: number; x2: number; y2: number; score: number }
/** A part of a frame, in frame pixels. */
export interface Rect { x: number; y: number; w: number; h: number }
export interface Letterboxed { tensor: Float32Array; ratio: number; crop: Rect }

/** Scales `crop` of an rgb24 frame (bilinear) into the model's input. */
export function letterbox(rgb: Uint8Array, width: number, height: number, crop: Rect = { x: 0, y: 0, w: width, h: height }): Letterboxed {
  const ratio = Math.min(INPUT / crop.h, INPUT / crop.w);
  const w = Math.min(INPUT, Math.round(crop.w * ratio));
  const h = Math.min(INPUT, Math.round(crop.h * ratio));
  const plane = INPUT * INPUT;
  const tensor = new Float32Array(3 * plane).fill(PAD);
  const maxX = crop.x + crop.w - 1;
  const maxY = crop.y + crop.h - 1;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(maxY, Math.max(crop.y, crop.y + (y + 0.5) / ratio - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(maxY, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(maxX, Math.max(crop.x, crop.x + (x + 0.5) / ratio - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(maxX, x0 + 1);
      const fx = sx - x0;
      const a = (y0 * width + x0) * 3, b = (y0 * width + x1) * 3, c = (y1 * width + x0) * 3, d = (y1 * width + x1) * 3;
      const o = y * INPUT + x;
      for (let ch = 0; ch < 3; ch++) {
        const top = rgb[a + ch] + (rgb[b + ch] - rgb[a + ch]) * fx;
        const bottom = rgb[c + ch] + (rgb[d + ch] - rgb[c + ch]) * fx;
        tensor[(2 - ch) * plane + o] = top + (bottom - top) * fy; // rgb → bgr
      }
    }
  }
  return { tensor, ratio, crop };
}

/** People in a raw model output, in input pixels, with score (objectness × person) at least `minScore`. */
export function decodePersons(out: Float32Array, minScore: number): Box[] {
  const boxes: Box[] = [];
  const row = 5 + CLASSES;
  let anchor = 0;
  for (const stride of STRIDES) {
    const cells = INPUT / stride;
    for (let gy = 0; gy < cells; gy++) {
      for (let gx = 0; gx < cells; gx++, anchor++) {
        const i = anchor * row;
        const score = out[i + 4] * out[i + 5];
        if (score < minScore) continue;
        const cx = (out[i] + gx) * stride;
        const cy = (out[i + 1] + gy) * stride;
        const w = Math.exp(out[i + 2]) * stride;
        const h = Math.exp(out[i + 3]) * stride;
        boxes.push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, score });
      }
    }
  }
  return boxes;
}

export function iou(a: Box, b: Box): number {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter);
}

/** Greedy non-maximum suppression, strongest first. */
export function nms(boxes: readonly Box[], maxIou: number): Box[] {
  const kept: Box[] = [];
  for (const b of [...boxes].sort((p, q) => q.score - p.score)) {
    if (kept.every((k) => iou(k, b) <= maxIou)) kept.push(b);
  }
  return kept;
}

/** A box from input pixels back to frame pixels. */
export function toFrame(b: Box, lb: Letterboxed): Box {
  const { ratio, crop } = lb;
  return { x1: crop.x + b.x1 / ratio, y1: crop.y + b.y1 / ratio, x2: crop.x + b.x2 / ratio, y2: crop.y + b.y2 / ratio, score: b.score };
}
