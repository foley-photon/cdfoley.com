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
     hover: true | { format: (x, hits) => 'text', hint }     readout by pointer, tap, or keyboard (focus, ← →)
   })
   Plot.clear(container)                                 remove a chart, e.g. when the inputs are invalid
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
        // whole multiples of the step: no accumulated rounding (a "−5.6e-17" zero tick), and no endless loop
        // when the step is below the floating-point spacing of the values
        var k0 = Math.ceil(min / step - 1e-9), k1 = Math.floor(max / step + 1e-9);
        if (!(Math.abs(k0) < 1e12 && Math.abs(k1) < 1e12)) return [min, max];
        var out = [];
        for (var k = k0; k <= k1 && out.length < 1000; k++) out.push(k === 0 ? 0 : parseFloat((k * step).toPrecision(12)));
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
        if (!isFinite(v)) return '';
        var a = Math.abs(v);
        var e = Math.round(Math.log10(a));
        if (log && Math.abs(a - Math.pow(10, e)) / a < 1e-9 && (e < -2 || e > 3)) {
            return (v < 0 ? '−' : '') + '10' + String(e).split('').map(function (c) { return SUP[c] || c; }).join('');
        }
        if (a >= 1e-3 && a < 1e5) return String(parseFloat(v.toPrecision(6))).replace('-', '−');
        var s = v.toExponential(1).split('e');
        return s[0].replace(/\.0$/, '').replace('-', '−') + 'e' + s[1].replace('+', '');
    }
    // a linear-axis tick label with the digits the tick step needs, so neighbouring ticks never read the same
    // (1063.996 | 1063.998 | 1064 rather than 1064 | 1064 | 1064)
    function stepLabel(v, step) {
        var ls = Math.floor(Math.log10(step) + 1e-9);
        if (v === 0 || !isFinite(v) || !isFinite(ls)) return tickLabel(v);
        var a = Math.abs(v);
        if (a >= 1e-3 && a < 1e5) return String(parseFloat(v.toFixed(Math.max(0, Math.min(20, -ls))))).replace('-', '−');
        var s = v.toExponential(Math.max(1, Math.min(20, Math.floor(Math.log10(a) + 1e-9) - ls))).split('e');
        return s[0].replace(/\.?0+$/, '').replace('-', '−') + 'e' + s[1].replace('+', '');
    }
    function axisFormat(ax, log, min, max, count) {
        if (ax.format) return ax.format;
        if (log) return function (v) { return tickLabel(v, true); };
        var step = niceStep(max - min, count);
        return function (v) { return stepLabel(v, step); };
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

    // true for a single value, or a range so narrow (relative width below 1e-12) that it is only rounding
    function flat(lo, hi) { return !(Math.abs(hi - lo) > 1e-12 * Math.max(Math.abs(lo), Math.abs(hi))); }

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
    function drawable(x, y, log) { return isFinite(x) && isFinite(y) && !(log.x && x <= 0) && !(log.y && y <= 0); }
    function pathFrom(xs, ys, sx, sy, log) {
        var d = '', pen = false;
        for (var i = 0; i < xs.length; i++) {
            var x = xs[i], y = ys[i];
            if (!drawable(x, y, log)) { pen = false; continue; }
            d += (pen ? 'L' : 'M') + sx(x).toFixed(2) + ',' + sy(y).toFixed(2);
            pen = true;
        }
        return d;
    }
    // indices of the points that have a position on the x axis, sorted by x (points need not be in order)
    function xOrder(xs, log) {
        var idx = [];
        for (var i = 0; i < xs.length; i++) if (isFinite(xs[i]) && !(log.x && xs[i] <= 0)) idx.push(i);
        return idx.sort(function (a, b) { return xs[a] - xs[b] || a - b; });
    }
    // index of the point nearest to pixel px, measured on screen (so log axes are fair); -1 if none
    function nearestIndex(order, xs, xv, sx, px) {
        var lo = 0, hi = order.length - 1;
        if (hi < 0) return -1;
        while (hi - lo > 1) {
            var mid = (lo + hi) >> 1;
            if (xs[order[mid]] < xv) lo = mid; else hi = mid;
        }
        var a = order[lo], b = order[hi];
        return Math.abs(sx(xs[a]) - px) <= Math.abs(sx(xs[b]) - px) ? a : b;
    }

    function plotWidth(w) { return Math.round(Math.max(300, Math.min(1100, w))); }
    // a chart that is still on screen: not one the page has since cleared (for example on an input error)
    function live(c) { return !!(c._plot && c._plot.svg && c._plot.svg.parentNode === c); }

    // Redraw at the new width when a plot's container is resized (charts are drawn at true pixel size).
    var ro = 'ResizeObserver' in window ? new ResizeObserver(function (entries) {
        entries.forEach(function (en) {
            var c = en.target, w = Math.round(en.contentRect.width);
            if (w > 0 && live(c) && Math.abs(plotWidth(w) - c._plot.w) > 24) {   // width 0: hidden, keep the chart as it is
                clearTimeout(c._plotT);
                c._plotT = setTimeout(function () { if (live(c)) draw(c, c._plot.o); }, 80);
            }
        });
    }) : null;

    // Remove a chart (for example when the inputs are invalid) so that a later resize cannot bring it back.
    function clear(container) {
        if (typeof container === 'string') container = document.querySelector(container);
        if (!container) return;
        clearTimeout(container._plotT);
        container._plot = null;
        container.innerHTML = '';
    }

    function draw(container, o) {
        if (typeof container === 'string') container = document.querySelector(container);
        // width = container's pixel width (so 11 px labels render at 11 px), within sensible bounds
        var W = plotWidth(container.clientWidth || 640);
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
        // no drawable data: a unit range (a log axis needs positive bounds, or every coordinate is NaN)
        if (!isFinite(xmin) || !isFinite(xmax) || (log.x && !(xmin > 0 && xmax > 0))) { xmin = log.x ? 1 : 0; xmax = log.x ? 10 : 1; }
        if (!isFinite(ymin) || !isFinite(ymax) || (log.y && !(ymin > 0 && ymax > 0))) { ymin = log.y ? 1 : 0; ymax = log.y ? 10 : 1; }
        // a single value, or values equal to within rounding (a flat curve), gets a margin around it
        if (flat(xmin, xmax)) { if (log.x) { xmin /= 2; xmax *= 2; } else { xmin -= 0.5; xmax += 0.5; } }
        if (flat(ymin, ymax)) { var pad0 = Math.abs(ymin) * 0.1 || 1; ymin -= pad0; ymax += pad0; }
        // headroom, unless it would overflow (values near ±1e308)
        if (!log.y && yo.max === undefined) { var hi = ymax + (ymax - ymin) * 0.06; if (isFinite(hi)) ymax = hi; }
        if (!log.y && yo.min === undefined && ymin !== 0) { var lo = ymin - (ymax - ymin) * 0.04; if (isFinite(lo)) ymin = lo; }
        if (log.y && yo.min === undefined) ymin = Math.pow(10, Math.floor(Math.log10(ymin) * 4) / 4);
        if (log.y && yo.max === undefined) ymax = Math.pow(10, Math.ceil(Math.log10(ymax) * 4) / 4);

        var yt = log.y ? logTicks(ymin, ymax) : linTicks(ymin, ymax, yo.ticks || 5);
        var fy = axisFormat(yo, log.y, ymin, ymax, yo.ticks || 5);

        container.innerHTML = '';
        var svg = h('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'plot', role: 'img', 'aria-label': o.ariaLabel || ((yo.label || '') + ' versus ' + (xo.label || '')) }, container);
        container._plot.svg = svg;

        // label widths, measured when rendered (otherwise about 7.5 px per character)
        var probe = h('text', {}, svg);
        var widthOf = function (s) {
            probe.textContent = s;
            var w = 0;
            try { w = probe.getComputedTextLength(); } catch (e) { /* not rendered */ }
            return w || 7.5 * probe.textContent.length;
        };
        // long y tick labels widen the left margin so they clear the rotated axis title
        var yw = 0;
        yt.forEach(function (v) { yw = Math.max(yw, widthOf(fy(v))); });
        var x0 = Math.max(M.l, Math.ceil(32 + yw)), x1 = W - M.r, y0 = H - M.b, y1 = M.t;
        var sx = scale(xmin, xmax, x0, x1, log.x), sy = scale(ymin, ymax, y0, y1, log.y);
        var ix = invScale(xmin, xmax, x0, x1, log.x);
        // x ticks: when default labels would run into each other (long, precise ones on a phone), use fewer ticks
        // while at least three stay labelled, then label only every 2nd (3rd, …) one
        var xcount = xo.ticks || 6, xt, fx, xstride = 1;
        var inside = function (ticks) { return ticks.filter(function (v) { var p = sx(v); return p >= x0 - 0.5 && p <= x1 + 0.5; }); };
        var xFits = function (stride) {
            var end = -Infinity;
            return inside(xt).every(function (v, i) {
                if (i % stride) return true;
                var p = sx(v), w = widthOf(fx(v)), ok = p - w / 2 >= end + 6;
                end = p + w / 2;
                return ok;
            });
        };
        for (;;) {
            xt = log.x ? logTicks(xmin, xmax) : linTicks(xmin, xmax, xcount);
            fx = axisFormat(xo, log.x, xmin, xmax, xcount);
            if (xo.format || log.x || xFits(1)) break;
            if (xcount <= 2 || inside(linTicks(xmin, xmax, xcount - 1)).length < 3) {
                while (xstride < xt.length && !xFits(xstride)) xstride++;
                break;
            }
            xcount--;
        }
        svg.removeChild(probe);
        var clipId = 'pc' + (++uid);
        var defs = h('defs', {}, svg);
        h('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1 }, h('clipPath', { id: clipId }, defs));

        // grid + ticks
        var gGrid = h('g', { class: 'grid' }, svg), gAxis = h('g', { class: 'axis' }, svg), xi = 0;
        xt.forEach(function (v) {
            var p = sx(v); if (p < x0 - 0.5 || p > x1 + 0.5) return;
            h('line', { x1: p, x2: p, y1: y1, y2: y0 }, gGrid);
            if (xi++ % xstride === 0) h('text', { x: p, y: y0 + 16, 'text-anchor': 'middle' }, gAxis).textContent = fx(v);
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
                var first = null, last = null;   // the ends of the drawn curve (not a trailing gap)
                for (var q = 0; q < s.x.length; q++) if (drawable(s.x[q], s.y[q], log)) { if (first === null) first = s.x[q]; last = s.x[q]; }
                h('path', { d: d + 'L' + sx(last).toFixed(2) + ',' + baseY + 'L' + sx(first).toFixed(2) + ',' + baseY + 'Z', class: 'area', fill: color }, gData);
            }
            if (s.type !== 'points' || s.line) {
                h('path', { d: d, class: 'series', stroke: color, 'stroke-dasharray': s.dash ? '6 5' : null, 'stroke-width': s.width || null }, gData);
            }
            if (s.type === 'points') {
                for (var k = 0; k < s.x.length; k++) {
                    if (!drawable(s.x[k], s.y[k], log)) continue;
                    h('circle', { cx: sx(s.x[k]), cy: sy(s.y[k]), r: s.r || 3.5, class: 'marker', fill: (s.colors && s.colors[k]) || color }, gData);
                }
            }
        });

        // line labels go where they cover the least data: each label tries a few positions along its line and takes
        // the first one with the lowest cost (the drawn length of curves under it, markers, bars, other labels, and
        // the plot edges). Unobstructed labels keep their usual place: right end above an hline, top of a vline.
        // Labels sit under the data and over the grid, with a halo in the panel color: where dense data leaves no
        // clear position (a phone-width control chart), the points stay visible and the label stays legible.
        var segs = [], boxes = [];
        series.forEach(function (s) {
            if (s.type === 'bars') {
                s.bins.forEach(function (b) {
                    var a = sx(b.x0), c = sx(b.x1), top = sy(Math.max(b.y, log.y ? ymin : 0));
                    boxes.push({ x: Math.min(a, c), y: Math.min(top, baseY), width: Math.abs(c - a), height: Math.abs(baseY - top), w: 0.5 });
                });
                return;
            }
            if (s.type === 'band') return;   // a light shading, not data a label must avoid
            if (s.type !== 'points' || s.line) {
                var prev = null;
                for (var k = 0; k < s.x.length; k++) {
                    if (!drawable(s.x[k], s.y[k], log)) { prev = null; continue; }
                    var pt = [sx(s.x[k]), sy(s.y[k])];
                    if (prev) segs.push([prev[0], prev[1], pt[0], pt[1]]);
                    prev = pt;
                }
            }
            if (s.type === 'points') {
                var r = (s.r || 3.5) + 1;
                for (var m = 0; m < s.x.length; m++) {
                    if (drawable(s.x[m], s.y[m], log)) boxes.push({ x: sx(s.x[m]) - r, y: sy(s.y[m]) - r, width: 2 * r, height: 2 * r, w: 12 });
                }
            }
        });
        // length of the segment (ax,ay)-(bx,by) inside box b (Liang–Barsky clipping)
        var inLen = function (b, ax, ay, bx, by) {
            var dx = bx - ax, dy = by - ay, t0 = 0, t1 = 1;
            var p = [-dx, dx, -dy, dy], q = [ax - b.x, b.x + b.width - ax, ay - b.y, b.y + b.height - ay];
            for (var i = 0; i < 4; i++) {
                if (p[i] === 0) { if (q[i] < 0) return 0; continue; }
                var t = q[i] / p[i];
                if (p[i] < 0) { if (t > t1) return 0; if (t > t0) t0 = t; } else { if (t < t0) return 0; if (t < t1) t1 = t; }
            }
            return (t1 - t0) * Math.sqrt(dx * dx + dy * dy);
        };
        var overlap = function (a, b) {
            return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        };
        var placed = [];
        var cost = function (b) {
            var g = { x: b.x - 2, y: b.y - 1, width: b.width + 4, height: b.height + 2 }, c = 0;
            segs.forEach(function (s) { c += inLen(g, s[0], s[1], s[2], s[3]); });
            boxes.forEach(function (q) { var a = overlap(g, q); if (a > 0) c += q.w ? q.w * Math.min(1, a / 4) + (q.w < 1 ? a / b.height : 0) : 0; });
            placed.forEach(function (q) { if (overlap({ x: g.x - 1, y: g.y, width: g.width + 2, height: g.height }, q) > 0) c += 1000; });
            if (b.y < 0 || b.y + b.height > y0 + 1 || b.x < x0 - 1 || b.x + b.width > W) c += 500;   // the top margin is free; the axes are not
            return c;
        };
        // try each candidate {x, y (top of the text box), anchor, extra} in order; keep the cheapest
        var place = function (t, cands) {
            var b = null;
            try { b = t.getBBox(); } catch (e) { /* not rendered */ }
            if (!b || !b.width) return;
            var asc = +t.getAttribute('y') - b.y, best = null;
            cands.forEach(function (cd) {
                t.setAttribute('x', cd.x); t.setAttribute('y', cd.top + asc); t.setAttribute('text-anchor', cd.anchor);
                var bb = t.getBBox(), c = cost(bb) + (cd.extra || 0);
                if (!best || c < best.c - 0.5) best = { c: c, cd: cd };
            });
            t.setAttribute('x', best.cd.x); t.setAttribute('y', best.cd.top + asc); t.setAttribute('text-anchor', best.cd.anchor);
            placed.push(t.getBBox());
        };
        var gLab = svg.insertBefore(document.createElementNS(NS, 'g'), gData);
        var labelStyle = function (c) { return 'fill:' + c + ';stroke:var(--surface);stroke-width:3px;stroke-linejoin:round;paint-order:stroke'; };
        (o.hlines || []).forEach(function (l) {
            if (!(l.y >= ymin && l.y <= ymax)) return;
            var p = sy(l.y), c = l.color || 'var(--muted)';
            h('line', { x1: x0, x2: x1, y1: p, y2: p, class: 'vline', stroke: c }, svg);
            if (l.label) {
                var t = h('text', { x: x1 - 4, y: p - 5, 'text-anchor': 'end', class: 'vlabel', style: labelStyle(c) }, gLab);
                t.textContent = l.label;
                var b0 = null; try { b0 = t.getBBox(); } catch (e) { /* not rendered */ }
                var above = b0 ? b0.y : p - 17, below = p + 3, hw = b0 ? b0.width / 2 : 0;
                var cands = [
                    { x: x1 - 4, top: above, anchor: 'end' }, { x: x1 - 4, top: below, anchor: 'end' },
                    { x: x0 + 4, top: above, anchor: 'start', extra: 0.5 }, { x: x0 + 4, top: below, anchor: 'start', extra: 0.5 }
                ];
                // then anywhere along the line, in 8 px steps from the right
                for (var cx = x1 - 4 - hw - 8; cx > x0 + 4 + hw; cx -= 8) {
                    cands.push({ x: cx, top: above, anchor: 'middle', extra: 1 }, { x: cx, top: below, anchor: 'middle', extra: 1 });
                }
                place(t, cands);
            }
        });
        (o.vlines || []).forEach(function (l) {
            if (!(l.x >= xmin && l.x <= xmax)) return;
            var p = sx(l.x), c = l.color || 'var(--muted)';
            h('line', { x1: p, x2: p, y1: y1, y2: y0, class: 'vline', stroke: c }, svg);
            if (l.label) {
                var right = p > (x0 + x1) / 2;
                var t = h('text', { x: p + (right ? -5 : 5), y: y1 + 12, 'text-anchor': right ? 'end' : 'start', class: 'vlabel', style: labelStyle(c) }, gLab);
                t.textContent = l.label;
                var bb0 = null; try { bb0 = t.getBBox(); } catch (e) { /* not rendered */ }
                var top0 = bb0 && bb0.width ? bb0.y : y1, step = bb0 && bb0.height ? Math.ceil(bb0.height) : 15, cands = [];
                // first the usual side, then the other side, moving down a line at a time (a small cost per line)
                for (var n = 0; top0 + n * step + step <= y0; n++) {
                    cands.push({ x: p + (right ? -5 : 5), top: top0 + n * step, anchor: right ? 'end' : 'start', extra: n * 0.6 });
                    cands.push({ x: p + (right ? 5 : -5), top: top0 + n * step, anchor: right ? 'start' : 'end', extra: n * 0.6 + 0.5 });
                }
                place(t, cands);
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

        // hover readout: pointer (move or tap) and keyboard (focus the chart, then ← → or Home / End)
        if (o.hover) {
            var lines = series.filter(function (s) { return s.type === 'line' || s.type === 'points'; });
            var orders = lines.map(function (s) { return xOrder(s.x, log); });
            var readout = document.createElement('div'); readout.className = 'plot-readout'; readout.setAttribute('aria-live', 'polite');
            readout.id = 'pr' + uid;
            readout.textContent = o.hover.hint || 'Hover over or tap the chart to read values.';
            container.appendChild(readout);
            var hl = h('line', { y1: y1, y2: y0, class: 'hover-line', visibility: 'hidden' }, svg);
            var dots = lines.map(function (s, i) { return h('circle', { r: 4, fill: s.color || 'var(--c' + ((series.indexOf(s) % 6) + 1) + ')', class: 'marker', visibility: 'hidden' }, svg); });
            var hit = h('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1, fill: 'transparent', style: 'cursor:crosshair' }, svg);
            var at = (x0 + x1) / 2;   // cursor position in pixels
            var show = function (px) {
                at = px = Math.max(x0, Math.min(x1, px));
                var xv = ix(px);
                var hits = [];
                lines.forEach(function (s, i) {
                    var k = nearestIndex(orders[i], s.x, xv, sx, px);
                    if (k < 0 || !drawable(s.x[k], s.y[k], log)) { dots[i].setAttribute('visibility', 'hidden'); return; }   // a gap in the curve
                    hits.push({ series: s, x: s.x[k], y: s.y[k], i: k });
                    dots[i].setAttribute('cx', sx(s.x[k])); dots[i].setAttribute('cy', sy(s.y[k]));
                    dots[i].setAttribute('visibility', 'visible');
                });
                var hx = hits.length ? sx(hits[0].x) : px;
                hl.setAttribute('x1', hx); hl.setAttribute('x2', hx); hl.setAttribute('visibility', 'visible');
                readout.textContent = o.hover.format ? o.hover.format(hits.length ? hits[0].x : xv, hits)
                    : (xo.label || 'x') + ' = ' + tickLabel(hits.length ? hits[0].x : xv) + hits.map(function (hh) { return ' · ' + (hh.series.label || 'y') + ' = ' + tickLabel(hh.y); }).join('');
            };
            var hide = function () {
                hl.setAttribute('visibility', 'hidden');
                dots.forEach(function (d) { d.setAttribute('visibility', 'hidden'); });
            };
            var move = function (ev) {
                var pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
                show(pt.matrixTransform(svg.getScreenCTM().inverse()).x);
            };
            hit.addEventListener('pointermove', move);
            hit.addEventListener('pointerdown', move);
            hit.addEventListener('pointerleave', hide);
            svg.setAttribute('tabindex', '0');
            svg.setAttribute('aria-describedby', readout.id);
            svg.addEventListener('focus', function () { show(at); });
            svg.addEventListener('blur', hide);
            svg.addEventListener('keydown', function (ev) {
                var w = x1 - x0, step = ev.shiftKey ? w / 10 : w / 50;
                var to = { ArrowLeft: at - step, ArrowDown: at - step, ArrowRight: at + step, ArrowUp: at + step,
                    PageDown: at - w / 10, PageUp: at + w / 10, Home: x0, End: x1 }[ev.key];
                if (to === undefined || ev.altKey || ev.ctrlKey || ev.metaKey) return;
                ev.preventDefault();
                show(to);
            });
        }
        return { svg: svg, sx: sx, sy: sy };
    }

    window.Plot = { draw: draw, clear: clear, ticks: linTicks, logTicks: logTicks };
})();
