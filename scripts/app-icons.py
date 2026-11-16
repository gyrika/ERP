"""Every app icon from the owner's CheesyBeez logo (SCRUM-258). Needs Pillow.

Usage: python3 scripts/app-icons.py [logo.png]   (default scripts/receipt-logo-source.png)
Writes public/icons/*.png (browser tab, home screens, the installed apps, the download page) and
deploy/station/pos-app/app.ico (the counter app and its installer). Give it the largest logo you
have: the 512 px icons come out sharper from a big source.
"""
import os, sys
from PIL import Image, ImageDraw, ImageFilter

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, '..')
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'receipt-logo-source.png')
CREAM = (253, 246, 236, 255)  # the badge's own background

logo = Image.open(src).convert('RGBA')
# The badge is a circle on white: keep the circle, the corners go transparent.
side = min(logo.size)
logo = logo.crop(((logo.width - side) // 2, (logo.height - side) // 2, (logo.width + side) // 2, (logo.height + side) // 2))

def badge(size: int) -> Image.Image:
    big = logo.resize((size * 4, size * 4), Image.LANCZOS)
    mask = Image.new('L', big.size, 0)
    inset = round(big.width * 0.025)  # just inside the photo's white edge
    ImageDraw.Draw(mask).ellipse((inset, inset, big.width - 1 - inset, big.height - 1 - inset), fill=255)
    big.putalpha(mask)
    out = big.resize((size, size), Image.LANCZOS)
    return out.filter(ImageFilter.UnsharpMask(radius=1, percent=60, threshold=2)) if size >= 96 else out

def on_cream(size: int, scale: float) -> Image.Image:
    """Full-bleed square (iPhone fills transparent corners with black; Android crops maskable icons)."""
    out = Image.new('RGBA', (size, size), CREAM)
    b = badge(round(size * scale))
    out.alpha_composite(b, ((size - b.width) // 2, (size - b.height) // 2))
    return out

icons = os.path.join(root, 'public', 'icons')
badge(192).save(os.path.join(icons, 'icon-192.png'))
badge(512).save(os.path.join(icons, 'icon-512.png'))
badge(32).save(os.path.join(icons, 'favicon-32.png'))
on_cream(180, 1.0).convert('RGB').save(os.path.join(icons, 'apple-touch-icon.png'))
on_cream(512, 0.8).save(os.path.join(icons, 'maskable-512.png'))  # inside Android's 80% safe zone
badge(256).save(os.path.join(root, 'deploy', 'station', 'pos-app', 'app.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('icons written')
