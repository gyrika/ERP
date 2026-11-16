/** The honeycomb strip on the bill (SCRUM-256), in place of the dashed rules. */

/**
 * The honeycomb strip (1 bit a dot, ESC/POS GS v 0 rows like the logo): a row of small hexagons
 * across the paper, every third one filled. Drawn here so nothing has to be shipped as a picture.
 */
export const combBitmap = (width = 576, r = 8): { width: number; height: number; bits: string } => {
  const height = 2 * r + 2;
  const row = Math.ceil(width / 8);
  const bytes = new Uint8Array(row * height);
  const step = Math.round(r * Math.sqrt(3)) + 4;
  const count = Math.floor((width - 2) / step);
  const left = Math.floor((width - count * step) / 2) + step / 2;
  // Inside a pointy-top hexagon of radius `rr` centred on 0,0.
  const inside = (x: number, y: number, rr: number) => {
    const ax = Math.abs(x); const ay = Math.abs(y);
    return ax <= (rr * Math.sqrt(3)) / 2 && ay <= rr - ax / Math.sqrt(3);
  };
  const cy = r + 1;
  for (let i = 0; i < count; i++) {
    const cx = left + i * step;
    const filled = i % 3 === 0;
    for (let y = 0; y < height; y++) {
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        if (x < 0 || x >= width) continue;
        const dx = x + 0.5 - cx; const dy = y + 0.5 - cy;
        const on = inside(dx, dy, r) && (filled || !inside(dx, dy, r - 2));
        if (on) bytes[y * row + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return { width, height, bits: btoa(s) };
};

/** Made once: every rule on every bill is the same strip. */
export const COMB = combBitmap();
