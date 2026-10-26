import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INPUT, decodePersons, iou, letterbox, nms, toFrame, type Box } from './yolox.ts';

/** A w×h rgb24 frame filled with one colour. */
const frame = (w: number, h: number, rgb: [number, number, number]) => {
  const f = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) f.set(rgb, i * 3);
  return f;
};
const plane = INPUT * INPUT;
const at = (t: Float32Array, c: number, x: number, y: number) => t[c * plane + y * INPUT + x];

test('letterbox: a 640x360 frame scales by 0.65 into the top of 416x416, the rest is grey 114', () => {
  const { tensor, ratio } = letterbox(frame(640, 360, [255, 0, 0]), 640, 360);
  assert.equal(ratio, 0.65);
  assert.equal(tensor.length, 3 * plane);
  // Channels are B, G, R (YOLOX was trained on OpenCV images), values 0-255.
  assert.deepEqual([at(tensor, 0, 10, 10), at(tensor, 1, 10, 10), at(tensor, 2, 10, 10)], [0, 0, 255]);
  assert.deepEqual([at(tensor, 0, 415, 233), at(tensor, 2, 415, 233)], [0, 255]); // last content row: 360 × 0.65 = 234
  assert.deepEqual([at(tensor, 0, 10, 234), at(tensor, 1, 10, 234), at(tensor, 2, 10, 234)], [114, 114, 114]);
});

test('letterbox: a crop is scaled on its own, and boxes map back to frame pixels', () => {
  const f = frame(640, 360, [0, 0, 0]);
  // A white 100x50 block at (200, 100) is the crop.
  for (let y = 100; y < 150; y++) for (let x = 200; x < 300; x++) f.set([255, 255, 255], (y * 640 + x) * 3);
  const crop = { x: 200, y: 100, w: 100, h: 50 };
  const lb = letterbox(f, 640, 360, crop);
  assert.equal(lb.ratio, 4.16);
  assert.equal(at(lb.tensor, 1, 0, 0), 255);
  assert.equal(at(lb.tensor, 1, 415, 207), 255);
  assert.equal(at(lb.tensor, 1, 10, 209), 114);
  const back = toFrame({ x1: 41.6, y1: 20.8, x2: 416, y2: 208, score: 1 }, lb);
  assert.deepEqual(
    [back.x1, back.y1, back.x2, back.y2].map((v) => Math.round(v * 1000) / 1000),
    [210, 105, 300, 150],
  );
});

/** A raw YOLOX-Nano output (3549 anchors × 85) with every score at 0. */
const output = () => new Float32Array(3549 * 85);
const put = (o: Float32Array, anchor: number, xywh: number[], obj: number, cls: number, score: number) => {
  o.set(xywh, anchor * 85);
  o[anchor * 85 + 4] = obj;
  o[anchor * 85 + 5 + cls] = score;
};

test('decodePersons: grid offset and exp(wh) times the stride, score = objectness × class', () => {
  const o = output();
  put(o, 5 * 52 + 3, [0.5, 0.5, Math.log(4), Math.log(8)], 0.9, 0, 0.9); // stride 8, cell (3, 5)
  put(o, 2704 + 26 * 1 + 2, [0, 0, 0, 0], 0.9, 0, 0.9); // stride 16, cell (2, 1)
  put(o, 2704 + 676 + 0, [0, 0, 0, 0], 0.9, 0, 0.9); // stride 32, cell (0, 0)
  const boxes = decodePersons(o, 0.4);
  assert.equal(boxes.length, 3);
  const r = (b: Box) => [b.x1, b.y1, b.x2, b.y2].map((v) => Math.round(v * 1000) / 1000);
  assert.deepEqual(r(boxes[0]), [12, 12, 44, 76]); // centre (28, 44), 32 × 64
  assert.equal(Math.round(boxes[0].score * 1000), 810);
  assert.deepEqual(r(boxes[1]), [24, 8, 40, 24]); // centre (32, 16), 16 × 16
  assert.deepEqual(r(boxes[2]), [-16, -16, 16, 16]); // centre (0, 0), 32 × 32
});

test('decodePersons: other classes and scores under the minimum are left out', () => {
  const o = output();
  put(o, 10, [0, 0, 0, 0], 0.9, 1, 0.99); // a bicycle
  put(o, 11, [0, 0, 0, 0], 0.6, 0, 0.6); // a person at 0.36
  put(o, 12, [0, 0, 0, 0], 0.8, 0, 0.5); // a person at exactly 0.4
  const boxes = decodePersons(o, 0.4);
  assert.equal(boxes.length, 1);
  assert.equal(Math.round(boxes[0].score * 100), 40);
});

test('nms: an overlapping weaker box goes, a separate one stays', () => {
  const a = { x1: 0, y1: 0, x2: 10, y2: 10, score: 0.9 };
  const b = { x1: 1, y1: 1, x2: 11, y2: 11, score: 0.8 }; // IoU 81/119 = 0.68
  const c = { x1: 5, y1: 0, x2: 15, y2: 10, score: 0.7 }; // IoU with a 50/150 = 0.33
  const d = { x1: 50, y1: 50, x2: 60, y2: 60, score: 0.95 };
  assert.equal(Math.round(iou(a, b) * 100), 68);
  assert.deepEqual(nms([b, a, c, d], 0.45), [d, a, c]);
});
