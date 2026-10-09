"""Generate the site logo: a Gaussian beam focused to an off-center waist with a focal dot.

    python _scripts/logo.py

Writes assets/img/favicon.svg and updates BRAND_MARK in assets/js/site.js.
The envelope is w(x) = w0·sqrt(1 + ((x − x0)/zR)²) on a 32-unit canvas.
"""
import math, os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
X0, W0, ZR, CY = 19.5, 2.4, 5.0, 16.0

def env(x): return W0 * math.sqrt(1 + ((x - X0) / ZR) ** 2)
def path(sign):
    xs = [4 + i * 24 / 36 for i in range(37)]
    return 'M' + ' L'.join('%.2f %.2f' % (x, CY + sign * env(x)) for x in xs)

GRAD = ('<linearGradient id="bm-g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#6ea8fe"/>'
        '<stop offset=".55" stop-color="#22d3ee"/><stop offset="1" stop-color="#34d399"/></linearGradient>')
INNER = ('<rect width="32" height="32" rx="7" fill="#0b1220"/>'
         '<path d="M4 16h24" stroke="#94a3b8" stroke-width="1" stroke-dasharray="1.5 2.5" opacity=".7"/>'
         '<path d="' + path(-1) + '" fill="none" stroke="url(#bm-g)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>'
         '<path d="' + path(1) + '" fill="none" stroke="url(#bm-g)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>'
         '<circle cx="%.1f" cy="16" r="1.35" fill="#34d399"/>' % X0)

open('assets/img/favicon.svg', 'w', encoding='utf-8').write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs>' + GRAD + '</defs>' + INNER + '</svg>\n')
js = open('assets/js/site.js', encoding='utf-8').read()
old = re.search(r"    var BRAND_MARK =\n.*?'</svg>';\n", js, flags=re.S).group(0)
new = ("    var BRAND_MARK =\n"
       "        '<svg class=\"brand-mark\" viewBox=\"0 0 32 32\" aria-hidden=\"true\">' +\n"
       "        '<defs>" + GRAD + "</defs>' +\n"
       "        '" + INNER + "' +\n"
       "        '</svg>';\n")
open('assets/js/site.js', 'w', encoding='utf-8').write(js.replace(old, new))
print('logo written: waist at x=%.1f, edges %.1f / %.1f' % (X0, env(4), env(28)))
