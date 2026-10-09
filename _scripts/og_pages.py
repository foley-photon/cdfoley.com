"""Draw a link-preview image (1200 × 630) for every tool, article, game, and hub page, and point each
page's og:image at its own card, so a shared link shows that page instead of the generic site card.

    python _scripts/og_pages.py

Run after changing page titles or descriptions. Uses Segoe UI from Windows and Pillow.
Writes assets/img/og/<section>-<slug>.jpg.
"""
import html, math, os, re
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
SITE = 'https://cdfoley.com'
W, H = 1200, 630
BG, ACCENT, WHITE, BODY, MUTED = (11, 18, 32), (167, 139, 250), (242, 245, 250), (176, 188, 206), (122, 136, 158)
FONTS = r'C:\Windows\Fonts'
def font(name, size): return ImageFont.truetype(os.path.join(FONTS, name), size)

js = open('assets/js/site.js', encoding='utf-8').read()
def registry(name):
    body = re.search(r'var ' + name + r' = \[(.*?)\n    \];', js, re.S).group(1)
    return [dict(re.findall(r"(\w+):\s*'((?:[^'\\]|\\.)*)'", m.group(1))) for m in re.finditer(r'\{([^{}]*)\}', body)]
CAT = {c['id']: c['title'] for c in registry('CATEGORIES') if c}

def meta(s, attr, name):
    m = re.search(r'<meta %s="%s" content="([^"]*)"' % (attr, re.escape(name)), s)
    return html.unescape(m.group(1)) if m else ''

def logo(size):
    """The site mark: a tightly focused, filled Gaussian beam in a purple gradient (same as _scripts/logo.py)."""
    k = size / 32 * 4
    im = Image.new('RGBA', (int(32 * k), int(32 * k)), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, 32 * k - 1, 32 * k - 1), radius=7 * k, fill=(22, 32, 54, 255), outline=(44, 58, 86, 255), width=max(1, int(0.35 * k)))
    grad = [(139, 92, 246), (168, 85, 247), (192, 132, 252)]
    def col(t, a=255):
        p, q, f = (grad[0], grad[1], t / 0.5) if t < 0.5 else (grad[1], grad[2], (t - 0.5) / 0.5)
        return tuple(round(x + (y - x) * f) for x, y in zip(p, q)) + (a,)
    env = lambda x: 1.7 * math.sqrt(1 + ((x - 16) / 3.6) ** 2)
    fill = Image.new('RGBA', im.size, (0, 0, 0, 0)); fd = ImageDraw.Draw(fill)
    for px in range(int(4 * k), int(28 * k) + 1):
        x = px / k; fd.line([(px, (16 - env(x)) * k), (px, (16 + env(x)) * k)], fill=col((x - 4) / 24, 72))
    im = Image.alpha_composite(im, fill); d = ImageDraw.Draw(im)
    w, n = 2.3 * k, 600
    for sign in (-1, 1):
        for i in range(n + 1):
            x = 4 + 24 * i / n; y = 16 + sign * env(x)
            d.ellipse((x * k - w / 2, y * k - w / 2, x * k + w / 2, y * k + w / 2), fill=col(i / n))
    return im.resize((size, size), Image.LANCZOS)

LOGO = logo(64)

def wrap(d, text, f, maxw, lines):
    words, out, cur = text.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if d.textlength(t, font=f) <= maxw: cur = t
        else:
            out.append(cur); cur = w
            if len(out) == lines: break
    if len(out) < lines and cur: out.append(cur)
    used = sum(len(l.split()) for l in out)
    if used < len(words):                       # trim the last line to fit an ellipsis
        last = out[-1]
        while d.textlength(last + '…', font=f) > maxw and ' ' in last: last = last.rsplit(' ', 1)[0]
        out[-1] = last.rstrip(',;:') + '…'
    return out

def card(path, eyebrow, title, desc):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img, 'RGBA')
    cy, z0, w0, zr = 470, 980, 18, 210                     # faint beam envelope in the background
    top = [(x, cy - min(w0 * math.sqrt(1 + ((x - z0) / zr) ** 2), 170)) for x in range(0, W + 1, 6)]
    bot = [(x, 2 * cy - y) for x, y in top]
    d.polygon(top + bot[::-1], fill=(168, 85, 247, 14))
    d.line(top, fill=(167, 139, 250, 60), width=2); d.line(bot, fill=(167, 139, 250, 60), width=2)
    img.paste(LOGO, (80, 64), LOGO)
    d.text((164, 70), 'cdfoley.com', font=font('seguisb.ttf', 30), fill=WHITE)
    d.text((164, 106), 'Casey D. Foley, PhD', font=font('segoeui.ttf', 22), fill=MUTED)
    d.text((80, 184), eyebrow.upper(), font=font('seguisb.ttf', 22), fill=ACCENT)
    size = 70
    while size > 46:
        ft = font('segoeuib.ttf', size)
        lines = wrap(d, title, ft, 1040, 2)
        if not lines[-1].endswith('…'): break
        size -= 2
    y = 224
    for l in lines:
        d.text((80, y), l, font=ft, fill=WHITE); y += int(size * 1.18)
    fd = font('segoeui.ttf', 27)
    for l in wrap(d, desc, fd, 1040, 3):
        d.text((80, y + 14), l, font=fd, fill=BODY); y += 38
    stops = [(0, (124, 58, 237)), (0.3, (29, 78, 216)), (0.55, (8, 145, 178)), (0.75, (5, 150, 105)), (0.9, (234, 179, 8)), (1, (220, 38, 38))]
    for x in range(W):
        t = x / (W - 1)
        for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
            if t0 <= t <= t1:
                f = (t - t0) / (t1 - t0); d.line([(x, H - 8), (x, H)], fill=tuple(round(a + (b - a) * f) for a, b in zip(c0, c1))); break
    img.save(path, quality=86, optimize=True, progressive=True)

def point_page_at(page, image_url, alt):
    s = open(page, encoding='utf-8').read()
    s = re.sub(r'<meta property="og:image" content="[^"]*">', '<meta property="og:image" content="%s">' % image_url, s, count=1)
    a = '<meta property="og:image:alt" content="%s">' % html.escape(alt, quote=True)
    if 'og:image:alt' in s: s = re.sub(r'<meta property="og:image:alt" content="[^"]*">', a, s, count=1)
    else: s = re.sub(r'(<meta property="og:image:height"[^>]*>\n)', r'\1' + a.replace('\\', '\\\\') + '\n', s, count=1)
    open(page, 'w', encoding='utf-8').write(s)

os.makedirs('assets/img/og', exist_ok=True)
jobs = []
for t in registry('TOOLS'):
    if t: jobs.append(('tools/%s/index.html' % t['slug'], 'tool-' + t['slug'], 'Free calculator · ' + CAT.get(t['cat'], 'Engineering'), t['title']))
for a in registry('ARTICLES'):
    if a: jobs.append(('learn/%s/index.html' % a['slug'], 'learn-' + a['slug'], 'Knowledge center · ' + a.get('topic', 'Explainer'), a['title']))
hub = open('games/index.html', encoding='utf-8').read()
for slug, title in re.findall(r'<a class="card tool-card game-card" href="/games/([^/]+)/">.*?<h3>(.*?)</h3>', hub, re.S):
    jobs.append(('games/%s/index.html' % slug, 'game-' + slug, 'Free online game · No ads', html.unescape(title)))
jobs += [('tools/index.html', 'hub-tools', 'Free engineering calculators', 'Calculators for lasers, optics, vacuum & quality'),
         ('learn/index.html', 'hub-learn', 'Knowledge center', 'Laser, optics & vacuum explainers'),
         ('formulas/index.html', 'hub-formulas', 'Reference', 'Laser, optics, vacuum & SPC formulas'),
         ('games/index.html', 'hub-games', 'Free online games · No ads', 'Pinball, Brick Breaker, 2048, Sudoku & more')]
for page, name, eyebrow, title in jobs:
    s = open(page, encoding='utf-8').read()
    desc = meta(s, 'name', 'description')
    h1 = re.search(r'<h1[^>]*>(.*?)</h1>', s, re.S)
    if h1 and not page.endswith(('tools/index.html', 'learn/index.html', 'games/index.html', 'formulas/index.html')):
        title = re.sub(r'<[^>]+>', '', h1.group(1)).strip()     # the page's own heading, e.g. "Laser Fluence & Irradiance Calculator"
    card('assets/img/og/%s.jpg' % name, eyebrow, html.unescape(title), desc)
    point_page_at(page, '%s/assets/img/og/%s.jpg' % (SITE, name), '%s: %s' % (html.unescape(title), desc))
print('share images: %d written to assets/img/og/' % len(jobs))
