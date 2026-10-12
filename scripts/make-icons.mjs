// Draws the CheesyBeez icon (one honey-amber honeycomb cell on the app's near-black) at every size the
// apps need, with no image tools: PNG and ICO are written by hand. Run: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const INK = [0x1c, 0x1c, 0x1e];
const HONEY = [0xe8, 0xa9, 0x4b];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
const png = (size, rgba) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
};

// A pointy-top hexagon of "radius" r around (cx, cy): inside test on unit coordinates.
const inHex = (x, y, cx, cy, r) => {
  const dx = Math.abs(x - cx) / r, dy = Math.abs(y - cy) / r;
  return dx <= Math.sqrt(3) / 2 && dy <= 1 - dx / Math.sqrt(3);
};

/**
 * rounded: corner radius as a fraction of the size (0 = full square, for phones that shape it themselves).
 * scale: how big the cell is (smaller for Android's maskable crop, which keeps only the middle 80%).
 */
const rgba = (size, { rounded, scale }) => {
  const S = 4; // 4x4 samples per pixel: smooth edges
  const out = Buffer.alloc(size * size * 4);
  const R = rounded * size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = px + (sx + 0.5) / S, y = py + (sy + 0.5) / S;
          // rounded square
          const qx = Math.max(R - x, x - (size - R), 0), qy = Math.max(R - y, y - (size - R), 0);
          if (R > 0 && qx * qx + qy * qy > R * R) continue;
          bg++;
          const c = size / 2, outer = size * 0.30 * scale, inner = size * 0.20 * scale, core = size * 0.09 * scale;
          const ring = inHex(x, y, c, c, outer) && !inHex(x, y, c, c, inner);
          if (ring || inHex(x, y, c, c, core)) fg++;
        }
      }
      const n = S * S, i = (py * size + px) * 4, a = bg / n, f = bg ? fg / bg : 0;
      for (let k = 0; k < 3; k++) out[i + k] = Math.round(INK[k] * (1 - f) + HONEY[k] * f);
      out[i + 3] = Math.round(a * 255);
    }
  }
  return out;
};
const draw = (size, look) => png(size, rgba(size, look));

/** A 24-bit BMP (what the Windows installer's pictures must be): the icon at (x, y) on a plain colour. */
const bmp = (w, h, ground, icons) => {
  const pix = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) [pix[i * 3 + 2], pix[i * 3 + 1], pix[i * 3]] = ground;
  for (const { size, x, y, look } of icons) {
    const src = rgba(size, look);
    for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
      const s = (py * size + px) * 4, d = ((y + py) * w + x + px) * 3, a = src[s + 3] / 255;
      for (let k = 0; k < 3; k++) pix[d + 2 - k] = Math.round(src[s + k] * a + pix[d + 2 - k] * (1 - a));
    }
  }
  const row = Math.ceil((w * 3) / 4) * 4, out = Buffer.alloc(54 + row * h);
  out.write('BM', 0, 'ascii'); out.writeUInt32LE(out.length, 2); out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14); out.writeInt32LE(w, 18); out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); out.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) pix.copy(out, 54 + (h - 1 - y) * row, y * w * 3, (y + 1) * w * 3); // bottom row first
  return out;
};

const ico = (images) => { // PNG-in-ICO (Windows Vista and later)
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(([size, data], i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map(([, d]) => d)]);
};

const any = { rounded: 0.22, scale: 1 };
writeFileSync('public/icons/icon-192.png', draw(192, any));
writeFileSync('public/icons/icon-512.png', draw(512, any));
writeFileSync('public/icons/maskable-512.png', draw(512, { rounded: 0, scale: 0.8 }));
writeFileSync('public/icons/apple-touch-icon.png', draw(180, { rounded: 0, scale: 1 }));
writeFileSync('public/icons/favicon-32.png', draw(32, any));
writeFileSync('deploy/station/pos-app/app.ico', ico([16, 24, 32, 48, 64, 256].map((s) => [s, draw(s, any)])));
// The installer: its corner picture (on the white page header) and the tall welcome picture, at 100% and 200%.
const WHITE = [0xff, 0xff, 0xff];
for (const [n, k] of [['', 1], ['-2x', 2]]) {
  writeFileSync(`deploy/station/wizard-small${n}.bmp`, bmp(55 * k, 55 * k, WHITE, [{ size: 55 * k, x: 0, y: 0, look: any }]));
  const w = 164 * k, h = 314 * k, size = 164 * k;
  writeFileSync(`deploy/station/wizard${n}.bmp`, bmp(w, h, INK, [{ size, x: 0, y: Math.round((h - size) / 2), look: { rounded: 0, scale: 1.1 } }]));
}
console.log('icons written');
