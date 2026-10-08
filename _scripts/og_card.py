"""Regenerate the social share image assets/img/og-card.jpg (1200 × 630).

    python _scripts/og_card.py

Uses Segoe UI from Windows and the headshot in assets/img. The tool count comes from site.js.
"""
import math, os, re
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
W, H = 1200, 630
BG, BLUE, WHITE, SUB, BODY, MUTED = (11, 18, 32), (110, 168, 254), (242, 245, 250), (203, 213, 226), (168, 180, 198), (122, 136, 158)
FONTS = r'C:\Windows\Fonts'
def font(name, size): return ImageFont.truetype(os.path.join(FONTS, name), size)

n_tools = len(re.findall(r"\{ slug: '", open('assets/js/site.js', encoding='utf-8').read().split('var ARTICLES')[0]))

img = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(img, 'RGBA')

# Gaussian-beam envelope in the background, w(z) = w0·sqrt(1 + ((z − z0)/zR)²)
cy, z0, w0, zR = 315, 760, 22, 230
top = [(x, cy - min(w0 * math.sqrt(1 + ((x - z0) / zR) ** 2), 150)) for x in range(0, W + 1, 6)]
bot = [(x, 2 * cy - y) for x, y in top]
d.polygon(top + bot[::-1], fill=(34, 211, 238, 16))
d.line(top, fill=(110, 168, 254, 70), width=2)
d.line(bot, fill=(110, 168, 254, 70), width=2)
for x in range(0, W, 14):
    d.line([(x, cy), (x + 6, cy)], fill=(148, 163, 184, 45), width=1)

# Headshot in a ring
R, cx, cyp = 150, 970, 315
photo = Image.open('assets/img/headshot-480.jpg').convert('RGB').resize((2 * R, 2 * R), Image.LANCZOS)
mask = Image.new('L', (2 * R, 2 * R), 0)
ImageDraw.Draw(mask).ellipse((0, 0, 2 * R - 1, 2 * R - 1), fill=255)
d.ellipse((cx - R - 6, cyp - R - 6, cx + R + 6, cyp + R + 6), fill=(30, 41, 64))
img.paste(photo, (cx - R, cyp - R), mask)

d = ImageDraw.Draw(img, 'RGBA')
x0, maxw = 80, 720
def fit(text, name, size, minsize):
    while size > minsize and d.textlength(text, font=font(name, size)) > maxw: size -= 1
    return font(name, size)

d.text((x0, 152), 'LASERS · OPTICS · VACUUM · MACHINE VISION', font=font('seguisb.ttf', 19), fill=BLUE)
d.text((x0, 190), 'Casey D. Foley, PhD', font=fit('Casey D. Foley, PhD', 'segoeuib.ttf', 66, 48), fill=WHITE)
sub = 'Laser & High Vacuum Systems Expert · Physical Chemist'
d.text((x0, 284), sub, font=fit(sub, 'seguisb.ttf', 30, 22), fill=SUB)
bullets = ['%d free engineering calculators and a formula reference' % n_tools,
           'Vision system configurator and glazing performance calculator',
           '23 peer-reviewed papers, including Science and JACS']
fb = font('segoeui.ttf', 24)
for i, b in enumerate(bullets):
    y = 350 + i * 41
    d.text((x0, y), '•', font=fb, fill=MUTED)
    d.text((x0 + 24, y), b, font=fit(b, 'segoeui.ttf', 24, 19), fill=BODY)
d.text((x0, 522), 'cdfoley.com', font=font('seguisb.ttf', 24), fill=WHITE)
d.text((x0 + 170, 522), 'Engineering tools · Formula reference · Knowledge center', font=font('segoeui.ttf', 23), fill=MUTED)

# Spectrum bar along the bottom edge
stops = [(0, (124, 58, 237)), (0.3, (29, 78, 216)), (0.55, (8, 145, 178)), (0.75, (5, 150, 105)), (0.9, (234, 179, 8)), (1, (220, 38, 38))]
for x in range(W):
    t = x / (W - 1)
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        if t0 <= t <= t1:
            f = (t - t0) / (t1 - t0)
            d.line([(x, H - 8), (x, H)], fill=tuple(round(a + (b - a) * f) for a, b in zip(c0, c1)))
            break

img.save('assets/img/og-card.jpg', quality=90, optimize=True, progressive=True)
print('og-card.jpg written (%d tools)' % n_tools)
