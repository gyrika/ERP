"""The receipt logo (SCRUM-254): the owner's logo as 1-bit dots for the XP-80T, written to src/domain/receiptLogo.ts. Needs Pillow."""
import os, sys, base64
from PIL import Image, ImageOps
# Usage: python3 scripts/receipt-logo.py [source.png] [preview.png]
here = os.path.dirname(os.path.abspath(__file__))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'receipt-logo-source.png')
out_png = sys.argv[2] if len(sys.argv) > 2 else None
out_ts = os.path.join(here, '..', 'src', 'domain', 'receiptLogo.ts')
W = 384
g = ImageOps.autocontrast(Image.open(src).convert('L'), cutoff=1)
ink = g.point(lambda p: 255 if p < 170 else 0)
g = g.crop(ink.getbbox()); ink = ink.crop(ink.getbbox())
# drop the tagline: cut at the last blank band of rows before the bottom
rows = [any(ink.getpixel((x, y)) for x in range(ink.width)) for y in range(ink.height)]
y = ink.height - 1
while rows[y]: y -= 1          # tagline rows
while not rows[y]: y -= 1      # gap
g = g.crop((0, 0, g.width, y + 1))
h = round(g.height * W / g.width)
bw = g.resize((W, h), Image.LANCZOS).point(lambda p: 0 if p < 170 else 255, '1')
if out_png: bw.save(out_png)
# ESC/POS raster rows: 1 = black, MSB first
bpr = (W + 7) // 8
data = bytearray()
for yy in range(h):
    for bx in range(bpr):
        b = 0
        for bit in range(8):
            x = bx * 8 + bit
            if x < W and bw.getpixel((x, yy)) == 0: b |= 0x80 >> bit
        data.append(b)
b64 = base64.b64encode(bytes(data)).decode()
chunks = '\n'.join(f"  '{b64[i:i+100]}' +" for i in range(0, len(b64), 100)).rstrip(' +')
open(out_ts, 'w').write(f"""/**
 * The CheesyBeez logo for the receipt (SCRUM-254): the owner's logo (bee + cheese) without its
 * tagline, which prints as text so it stays sharp. 1 bit a dot, rows top to bottom, 1 = black,
 * leftmost dot in the high bit, as ESC/POS GS v 0 wants it. Made from the owner's image by
 * scripts/receipt-logo.py; regenerate with that script rather than editing these bytes.
 */
export const RECEIPT_LOGO = {{
  /** Dots across: 48 mm of the 72 mm print width at 203 dpi. */
  width: {W},
  height: {h},
  bits:
{chunks},
}} as const;
""")
print(W, h, len(data), 'bytes')
