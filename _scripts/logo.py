"""Generate the site logo: a tightly focused Gaussian beam, filled, in a purple gradient.

    python _scripts/logo.py

Writes assets/img/favicon.svg and updates BRAND_MARK in assets/js/site.js.
The envelope is w(x) = w0·sqrt(1 + ((x − x0)/zR)²) on a 32-unit canvas, symmetric about the center.
"""
import math, os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
X0, W0, ZR, CY = 16.0, 1.7, 3.6, 16.0
STOPS = ('#8b5cf6', '#a855f7', '#c084fc')       # violet-500 → purple-500 → purple-400
FILL_OPACITY = .28

XS = [4 + i * 0.5 for i in range(49)]
def env(x): return W0 * math.sqrt(1 + ((x - X0) / ZR) ** 2)
def pts(xs, sign): return ['%.2f %.2f' % (x, CY + sign * env(x)) for x in xs]
EDGES = 'M' + ' L'.join(pts(XS, -1)) + ' M' + ' L'.join(pts(XS, 1))
AREA = 'M' + ' L'.join(pts(XS, -1) + pts(XS[::-1], 1)) + 'Z'

GRAD = ('<linearGradient id="bm-g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="%s"/>'
        '<stop offset=".5" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient>' % STOPS)
INNER = ('<rect width="32" height="32" rx="7" fill="#0b1220"/>'
         '<path d="' + AREA + '" fill="url(#bm-g)" opacity="%g"/>' % FILL_OPACITY +
         '<path d="' + EDGES + '" fill="none" stroke="url(#bm-g)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>')

open('assets/img/favicon.svg', 'w', encoding='utf-8').write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs>' + GRAD + '</defs>' + INNER + '</svg>\n')
js = open('assets/js/site.js', encoding='utf-8').read()
old = re.search(r"    var BRAND_MARK =\n.*?'</svg>';\n", js, flags=re.S).group(0)
new = ("    var BRAND_MARK =\n"
       "        '<svg class=\"brand-mark\" viewBox=\"0 0 32 32\" aria-hidden=\"true\">' +\n"
       "        '<defs>" + GRAD + "</defs>' +\n"
       "        '" + INNER + "' +\n"
       "        '</svg>';\n")
open('assets/js/site.js', 'w', encoding='utf-8').write(js.replace(old, new))
print('logo written: waist %.1f at x=%.1f, edges %.1f' % (W0, X0, env(4)))
