/* ==========================================================================
   cdfoley.com — plot.js
   Dependency-free SVG charts that inherit theme colors from CSS variables.

   Plot.draw(container, {
     height: 300,                                     pixel height (width follows the container)
     x: { label: 'z (mm)', log: false, min, max, ticks: 6, format: v => '' },
     y: { label: 'w (µm)', log: false, min, max, ticks: 5, format },
     series: [
       { type: 'line', x: [], y: [], label: 'w(z)', color: 'var(--c1)', fill: true, dash: false },
       { type: 'band', x: [], y: [], y0: [], color: 'var(--c1)' },          shaded region y0…y
       { type: 'bars', bins: [{ x0, x1, y }], color: 'var(--c1)', label },  histogram
       { type: 'points', x: [], y: [], color, colors: [] , line: true }     markers (+ optional line)
     ],
     vlines: [{ x, label, color }], hlines: [{ y, label, color }],
     hover: true | { format: (x, hits) => 'text' }
   })
   ========================================================================== */
(function () {
    'use strict';
    var M = { l: 62, r: 18, t: 14, b: 46 };
    var uid = 0;
    var NS = 'http://www.w3.org/2000/svg';

    function niceStep(range, count) {
        var raw = range / Math.max(1, count);
        var mag = Math.pow(10, Math.floor(Math.log10(raw)));
        var n = raw / mag;
        return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
    }
    function linTicks(min, max, count) {
        if (!(max > min)) return [min];
        var step = niceStep(max - min, count);
        var out = [];
        for (var v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(parseFloat(v.toPrecision(12)));
        return out;
    }
    function logTicks(min, max) {
        var a = Math.floor(Math.log10(min)), b = Math.ceil(Math.log10(max));
        var out = [], mult = (b - a) <= 2 ? [1, 2, 5] : (b - a) <= 4 ? [1, 3] : [1];
        var stride = Math.max(1, Math.ceil((b - a) / 8));
        for (var e = a; e <= b; e += (mult.length === 1 ? stride : 1)) {
            mult.forEach(function (m) { var v = m * Math.pow(10, e); if (v >= min * 0.999 && v <= max * 1.001) out.push(v); });
        }
        return out;
    }
    var SUP = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
    function tickLabel(v, log) {
        if (v === 0) return '0';
        var a = Math.abs(v);
        var e = Math.round(Math.log10(a));
        if (log && Math.abs(a - Math.pow(10, e)) / a < 1e-9 && (e < -2 || e > 3)) {
            return (v < 0 ? '−' : '') + '10' + String(e).split('').map(function (c) { return SUP[c] || c; }).join('');
        }
        if (a >= 1e-3 && a < 1e5) return String(parseFloat(v.toPrecision(6))).replace('-', '−');
        var s = v.toExponential(1).split('e');
        return s[0].replace(/\.0$/, '').replace('-', '−') + 'e' + s[1].replace('+', '');
    }

    function extent(arrs, log) {
        var lo = Infinity, hi = -Infinity;
        arrs.forEach(function (arr) {
            for (var i = 0; i < arr.length; i++) {
                var v = arr[i];
                if (!isFinite(v) || (log && v <= 0)) continue;
                if (v < lo) lo = v; if (v > hi) hi = v;
            }
        });
        return [lo, hi];
    }

    function scale(min, max, a, b, log) {
        if (log) {
            var lmin = Math.log10(min), lmax = Math.log10(max);
            return function (v) { return a + (Math.log10(v) - lmin) / (lmax - lmin) * (b - a); };
        }
        return function (v) { return a + (v - min) / (max - min) * (b - a); };
    }
    function invScale(min, max, a, b, log) {
        if (log) {
            var lmin = Math.log10(min), lmax = Math.log10(max);
            return function (p) { return Math.pow(10, lmin + (p - a) / (b - a) * (lmax - lmin)); };
        }
        return function (p) { return min + (p - a) / (b - a) * (max - min); };
    }

    function h(tag, attrs, parent) {
        var n = document.createElementNS(NS, tag);
        for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
        if (parent) parent.appendChild(n);
        return n;
    }
    function pathFrom(xs, ys, sx, sy, log) {
        var d = '', pen = false;
        for (var i = 0; i < xs.length; i++) {
            var x = xs[i], y = ys[i];
            var ok = isFinite(x) && isFinite(y) && !(log.x && x <= 0) && !(log.y && y <= 0);
            if (!ok) { pen = false; continue; }
            d += (pen ? 'L' : 'M') + sx(x).toFixed(2) + ',' + sy(y).toFixed(2);
            pen = true;
        }
        return d;
    }
    function nearestIndex(xs, x) {
        var lo = 0, hi = xs.length - 1;
        if (hi < 0) return -1;
        var asc = xs[hi] >= xs[0];
        while (hi - lo > 1) {
            var mid = (lo + hi) >> 1;
            if ((xs[mid] < x) === asc) lo = mid; else hi = mid;
        }
        return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
    }

    // Redraw at the new width when a plot's container is resized (charts are drawn at true pixel size).
    var ro = 'ResizeObserver' in window ? new ResizeObserver(function (entries) {
        entries.forEach(function (en) {
            var c = en.target, w = Math.round(en.contentRect.width);
            if (c._plot && Math.abs(w - c._plot.w) > 24) {
                clearTimeout(c._plotT);
                c._plotT = setTimeout(function () { draw(c, c._plot.o); }, 80);
            }
        });
    }) : null;

    function draw(container, o) {
        if (typeof container === 'string') container = document.querySelector(container);
        // width = container's pixel width (so 11 px labels render at 11 px), within sensible bounds
        var W = Math.round(Math.max(300, Math.min(1100, container.clientWidth || 640)));
        var H = Math.round(Math.min((o.height || 300) * 1.3, Math.max(230, W * 0.42)));
        if (!container._plot && ro) ro.observe(container);
        container._plot = { o: o, w: W };
        var xo = o.x || {}, yo = o.y || {};
        var log = { x: !!xo.log, y: !!yo.log };
        var series = o.series || [];

        // domains
        var xs = [], ys = [];
        series.forEach(function (s) {
            if (s.type === 'bars') {
                xs.push(s.bins.map(function (b) { return b.x0; }), s.bins.map(function (b) { return b.x1; }));
                ys.push(s.bins.map(function (b) { return b.y; }), [0]);
            } else {
                xs.push(s.x); ys.push(s.y); if (s.y0) ys.push(s.y0);
            }
        });
        (o.vlines || []).forEach(function (v) { if (o.includeLines !== false) xs.push([v.x]); });
        (o.hlines || []).forEach(function (v) { if (o.includeLines !== false) ys.push([v.y]); });
        var xe = extent(xs, log.x), ye = extent(ys, log.y);
        var xmin = xo.min !== undefined ? xo.min : xe[0], xmax = xo.max !== undefined ? xo.max : xe[1];
        var ymin = yo.min !== undefined ? yo.min : ye[0], ymax = yo.max !== undefined ? yo.max : ye[1];
        if (!isFinite(xmin) || !isFinite(xmax)) { xmin = 0; xmax = 1; }
        if (!isFinite(ymin) || !isFinite(ymax)) { ymin = 0; ymax = 1; }
        if (xmin === xmax) { xmin -= 0.5 || 1; xmax += 0.5 || 1; }
        if (ymin === ymax) { var pad0 = Math.abs(ymin) * 0.1 || 1; ymin -= pad0; ymax += pad0; }
        if (!log.y && yo.max === undefined) { ymax += (ymax - ymin) * 0.06; }
        if (!log.y && yo.min === undefined && ymin !== 0) { ymin -= (ymax - ymin) * 0.04; }
        if (log.y && yo.min === undefined) ymin = Math.pow(10, Math.floor(Math.log10(ymin) * 4) / 4);
        if (log.y && yo.max === undefined) ymax = Math.pow(10, Math.ceil(Math.log10(ymax) * 4) / 4);

        var x0 = M.l, x1 = W - M.r, y0 = H - M.b, y1 = M.t;
        var sx = scale(xmin, xmax, x0, x1, log.x), sy = scale(ymin, ymax, y0, y1, log.y);
        var ix = invScale(xmin, xmax, x0, x1, log.x);

        container.innerHTML = '';
        var svg = h('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'plot', role: 'img', 'aria-label': o.ariaLabel || ((yo.label || '') + ' versus ' + (xo.label || '')) }, container);
        var clipId = 'pc' + (++uid);
        var defs = h('defs', {}, svg);
        h('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1 }, h('clipPath', { id: clipId }, defs));

        // grid + ticks
        var gGrid = h('g', { class: 'grid' }, svg), gAxis = h('g', { class: 'axis' }, svg);
        var xt = log.x ? logTicks(xmin, xmax) : linTicks(xmin, xmax, xo.ticks || 6);
        var yt = log.y ? logTicks(ymin, ymax) : linTicks(ymin, ymax, yo.ticks || 5);
        var fx = xo.format || function (v) { return tickLabel(v, log.x); };
        var fy = yo.format || function (v) { return tickLabel(v, log.y); };
        xt.forEach(function (v) {
            var p = sx(v); if (p < x0 - 0.5 || p > x1 + 0.5) return;
            h('line', { x1: p, x2: p, y1: y1, y2: y0 }, gGrid);
            h('text', { x: p, y: y0 + 16, 'text-anchor': 'middle' }, gAxis).textContent = fx(v);
        });
        yt.forEach(function (v) {
            var p = sy(v); if (p < y1 - 0.5 || p > y0 + 0.5) return;
            h('line', { x1: x0, x2: x1, y1: p, y2: p }, gGrid);
            h('text', { x: x0 - 8, y: p + 3.5, 'text-anchor': 'end' }, gAxis).textContent = fy(v);
        });
        h('path', { d: 'M' + x0 + ',' + y1 + 'V' + y0 + 'H' + x1, fill: 'none' }, gAxis);
        if (xo.label) h('text', { x: (x0 + x1) / 2, y: H - 8, 'text-anchor': 'middle', class: 'axis-label' }, svg).textContent = xo.label;
        if (yo.label) h('text', { x: 14, y: (y0 + y1) / 2, 'text-anchor': 'middle', class: 'axis-label', transform: 'rotate(-90 14 ' + (y0 + y1) / 2 + ')' }, svg).textContent = yo.label;

        var gData = h('g', { 'clip-path': 'url(#' + clipId + ')' }, svg);
        var baseY = log.y ? y0 : sy(Math.max(ymin, Math.min(ymax, 0)));

        series.forEach(function (s, i) {
            var color = s.color || 'var(--c' + ((i % 6) + 1) + ')';
            if (s.type === 'bars') {
                s.bins.forEach(function (b) {
                    var a = sx(b.x0), c = sx(b.x1), top = sy(Math.max(b.y, log.y ? ymin : 0));
                    h('rect', { x: Math.min(a, c) + 0.5, y: Math.min(top, baseY), width: Math.max(0, Math.abs(c - a) - 1), height: Math.abs(baseY - top), fill: color, opacity: s.opacity || 0.55 }, gData);
                });
                return;
            }
            if (s.type === 'band') {
                var up = pathFrom(s.x, s.y, sx, sy, log);
                var dn = pathFrom(s.x.slice().reverse(), s.y0.slice().reverse(), sx, sy, log).replace(/^M/, 'L');
                h('path', { d: up + dn + 'Z', class: 'area', fill: color, style: 'opacity:' + (s.opacity || 0.16) }, gData);
                return;
            }
            var d = pathFrom(s.x, s.y, sx, sy, log);
            if (s.fill && d) {
                var first = s.x.find(function (v) { return isFinite(v); }), last = s.x[s.x.length - 1];
                h('path', { d: d + 'L' + sx(last).toFixed(2) + ',' + baseY + 'L' + sx(first).toFixed(2) + ',' + baseY + 'Z', class: 'area', fill: color }, gData);
            }
            if (s.type !== 'points' || s.line) {
                h('path', { d: d, class: 'series', stroke: color, 'stroke-dasharray': s.dash ? '6 5' : null, 'stroke-width': s.width || null }, gData);
            }
            if (s.type === 'points') {
                for (var k = 0; k < s.x.length; k++) {
                    if (!isFinite(s.x[k]) || !isFinite(s.y[k])) continue;
                    h('circle', { cx: sx(s.x[k]), cy: sy(s.y[k]), r: s.r || 3.5, class: 'marker', fill: (s.colors && s.colors[k]) || color }, gData);
                }
            }
        });

        (o.hlines || []).forEach(function (l) {
            if (!(l.y >= ymin && l.y <= ymax)) return;
            var p = sy(l.y), c = l.color || 'var(--muted)';
            h('line', { x1: x0, x2: x1, y1: p, y2: p, class: 'vline', stroke: c }, svg);
            if (l.label) h('text', { x: x1 - 4, y: p - 5, 'text-anchor': 'end', class: 'vlabel', fill: c }, svg).textContent = l.label;
        });
        (o.vlines || []).forEach(function (l) {
            if (!(l.x >= xmin && l.x <= xmax)) return;
            var p = sx(l.x), c = l.color || 'var(--muted)';
            h('line', { x1: p, x2: p, y1: y1, y2: y0, class: 'vline', stroke: c }, svg);
            if (l.label) {
                var right = p > (x0 + x1) / 2;
                h('text', { x: p + (right ? -5 : 5), y: y1 + 12, 'text-anchor': right ? 'end' : 'start', class: 'vlabel', fill: c }, svg).textContent = l.label;
            }
        });

        // legend
        var labeled = series.filter(function (s) { return s.label; });
        if (labeled.length > 1 || o.legend) {
            var lg = document.createElement('div'); lg.className = 'plot-legend';
            labeled.forEach(function (s) {
                var i = series.indexOf(s);
                var sp = document.createElement('span');
                sp.style.setProperty('--c', s.color || 'var(--c' + ((i % 6) + 1) + ')');
                sp.textContent = s.label; lg.appendChild(sp);
            });
            container.appendChild(lg);
        }

        // hover readout
        if (o.hover) {
            var lines = series.filter(function (s) { return s.type === 'line' || s.type === 'points'; });
            var readout = document.createElement('div'); readout.className = 'plot-readout'; readout.setAttribute('aria-live', 'polite');
            readout.textContent = o.hover.hint || 'Hover over the chart to read values.';
            container.appendChild(readout);
            var hl = h('line', { y1: y1, y2: y0, class: 'hover-line', visibility: 'hidden' }, svg);
            var dots = lines.map(function (s, i) { return h('circle', { r: 4, fill: s.color || 'var(--c' + ((series.indexOf(s) % 6) + 1) + ')', class: 'marker', visibility: 'hidden' }, svg); });
            var hit = h('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1, fill: 'transparent', style: 'cursor:crosshair' }, svg);
            var move = function (ev) {
                var pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
                var loc = pt.matrixTransform(svg.getScreenCTM().inverse());
                var xv = ix(Math.max(x0, Math.min(x1, loc.x)));
                var hits = [];
                lines.forEach(function (s, i) {
                    var k = nearestIndex(s.x, xv);
                    if (k < 0 || !isFinite(s.y[k])) { dots[i].setAttribute('visibility', 'hidden'); return; }
                    hits.push({ series: s, x: s.x[k], y: s.y[k], i: k });
                    dots[i].setAttribute('cx', sx(s.x[k])); dots[i].setAttribute('cy', sy(s.y[k]));
                    dots[i].setAttribute('visibility', 'visible');
                });
                var px = hits.length ? sx(hits[0].x) : sx(xv);
                hl.setAttribute('x1', px); hl.setAttribute('x2', px); hl.setAttribute('visibility', 'visible');
                readout.textContent = o.hover.format ? o.hover.format(hits.length ? hits[0].x : xv, hits)
                    : (xo.label || 'x') + ' = ' + tickLabel(hits.length ? hits[0].x : xv) + hits.map(function (hh) { return ' · ' + (hh.series.label || 'y') + ' = ' + tickLabel(hh.y); }).join('');
            };
            hit.addEventListener('pointermove', move);
            hit.addEventListener('pointerdown', move);
            hit.addEventListener('pointerleave', function () {
                hl.setAttribute('visibility', 'hidden');
                dots.forEach(function (d) { d.setAttribute('visibility', 'hidden'); });
            });
        }
        return { svg: svg, sx: sx, sy: sy };
    }

    window.Plot = { draw: draw, ticks: linTicks, logTicks: logTicks };
})();
