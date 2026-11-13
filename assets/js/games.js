/* Shared helpers for the /games/ pages: saved settings, sound effects, a resolution-independent canvas, and the
   fit layout that keeps a whole game (bar, board, touch pad) on screen at once. */
(function () {
    'use strict';
    var G = {};

    // localStorage can be missing or throw (private windows, blocked storage); games must still run.
    G.get = function (key, fallback) { try { var v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; } };
    G.set = function (key, value) { try { localStorage.setItem(key, String(value)); } catch (e) { /* storage unavailable */ } };
    G.getJSON = function (key) { try { return JSON.parse(G.get(key, 'null')); } catch (e) { return null; } };
    G.setJSON = function (key, value) { G.set(key, JSON.stringify(value)); };

    // Sound: tiny synthesized effects. Browsers only allow audio after a user gesture, so the context starts lazily.
    var ac = null, noiseBuf = null;
    G.soundOn = G.get('games-sound', '1') !== '0';
    G.audio = function () {
        // Only during a user activation: a touch press is not one yet (it becomes one on release), and a context made
        // or resumed without it stays suspended and logs a warning. Browsers without userActivation just try.
        if (navigator.userActivation && !navigator.userActivation.isActive) return;
        if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; } }
        if (ac && ac.state === 'suspended') ac.resume();
    };
    function ready() { return G.soundOn && ac && ac.state === 'running'; }
    G.tone = function (f0, f1, dur, type, vol) {
        if (!ready()) return;
        var t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
        o.type = type || 'square'; o.frequency.setValueAtTime(f0, t);
        if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
        g.gain.setValueAtTime(vol || 0.04, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur + 0.02);
    };
    G.noise = function (dur, vol, cutoff) {
        if (!ready()) return;
        if (!noiseBuf) { noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate); var d = noiseBuf.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
        var t = ac.currentTime, s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
        s.buffer = noiseBuf; f.type = 'lowpass'; f.frequency.value = cutoff || 1200;
        g.gain.setValueAtTime(vol || 0.08, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        s.connect(f); f.connect(g); g.connect(ac.destination); s.start(t); s.stop(t + dur + 0.02);
    };
    G.soundButton = function (btn) {
        function label() { btn.textContent = G.soundOn ? 'Sound on' : 'Sound off'; btn.setAttribute('aria-pressed', G.soundOn ? 'true' : 'false'); }
        btn.addEventListener('click', function () { G.soundOn = !G.soundOn; G.set('games-sound', G.soundOn ? '1' : '0'); G.audio(); label(); });
        label();
    };
    // Unlock on the events that grant user activation: a key, a mouse press, or the release of a touch (not its press).
    ['keydown', 'mousedown', 'pointerup', 'touchend'].forEach(function (t) { document.addEventListener(t, function () { if (G.soundOn) G.audio(); }, true); });

    // ── Fit: the whole play area on screen at once ──────────────────────────────────────────────────────────
    // A page wraps everything a player needs while playing (score chips, buttons, board, touch pad) in one
    // element with class "game-play". The board inside it gets the largest size that fits both the width of
    // its host and the height the rest of the play block leaves free between the sticky site header and the
    // bottom of the window. The site header stops sticking on short or narrow screens (games.css), and then
    // the whole window height is available.
    var probe = null;
    function viewH() {   // the small viewport height (100svh): what is visible even while a phone shows its toolbars
        if (!probe && document.body) {
            probe = document.createElement('div'); probe.setAttribute('aria-hidden', 'true');
            probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100vh;height:100svh;visibility:hidden;pointer-events:none';
            document.body.appendChild(probe);
        }
        var h = probe ? probe.offsetHeight : 0;
        return h > 0 ? Math.min(h, window.innerHeight) : window.innerHeight;
    }
    function px(cs, p) { return parseFloat(cs[p]) || 0; }
    G.isFull = function (play) {
        return !!play && (document.fullscreenElement === play || document.webkitFullscreenElement === play || play.classList.contains('game-focus'));
    };
    // The band of the window a play block may use, in client pixels: below a sticky header, with a small margin.
    G.band = function (play) {
        play = play || document.querySelector('.game-play');
        var vh = viewH();
        if (G.isFull(play)) return { top: 0, bottom: vh, height: vh };
        var hd = document.querySelector('.site-header'), top = 0;
        if (hd) { var pos = getComputedStyle(hd).position; if (pos === 'sticky' || pos === 'fixed') top = hd.offsetHeight + 1; }   // + the spectrum line under it
        var m = vh < 560 ? 4 : 8;
        return { top: top + m, bottom: vh - m, height: Math.max(0, vh - top - 2 * m) };
    };
    // Height of the play block's content (its in-flow children plus its own padding and border).
    function extent(play) {
        var lo = Infinity, hi = -Infinity, kids = play.children;
        for (var i = 0; i < kids.length; i++) {
            var k = kids[i];
            if (!k.getClientRects().length) continue;
            var cs = getComputedStyle(k);
            if (cs.position === 'absolute' || cs.position === 'fixed') continue;
            var r = k.getBoundingClientRect();
            lo = Math.min(lo, r.top - px(cs, 'marginTop')); hi = Math.max(hi, r.bottom + px(cs, 'marginBottom'));
        }
        if (lo === Infinity) return 0;
        var ps = getComputedStyle(play);
        return hi - lo + px(ps, 'paddingTop') + px(ps, 'paddingBottom') + px(ps, 'borderTopWidth') + px(ps, 'borderBottomWidth');
    }
    // How much the play block is taller than its band (positive: that many px would be off screen; negative: room left).
    G.overflow = function (play) { play = play || document.querySelector('.game-play'); return play ? extent(play) - G.band(play).height : 0; };
    // The largest height `board` may have so that its play block fits the band.
    G.space = function (board, play) {
        play = play || board.closest('.game-play');
        if (!play) return Infinity;
        return G.band(play).height - (extent(play) - board.getBoundingClientRect().height);
    };
    // Calls fn (at most once per frame) whenever something that changes the fit may have changed: the size of any
    // of the elements, the window, full screen, or the web font arriving.
    G.watch = function (els, fn) {
        var queued = false;
        function q() { if (!queued) { queued = true; requestAnimationFrame(function () { queued = false; fn(); }); } }
        if (window.ResizeObserver) { var ro = new ResizeObserver(q); els.forEach(function (el) { if (el) ro.observe(el); }); }
        window.addEventListener('resize', q);
        ['fullscreenchange', 'webkitfullscreenchange', 'gamefocuschange'].forEach(function (t) { document.addEventListener(t, q); });
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(q);
        return q;
    };
    function playEls(play, extra) {
        var list = extra.slice();
        if (play) { list.push(play); for (var i = 0; i < play.children.length; i++) list.push(play.children[i]); }
        return list;
    }
    function contentW(el) { var cs = getComputedStyle(el); return el.clientWidth - px(cs, 'paddingLeft') - px(cs, 'paddingRight'); }
    function capW(opts, play) { return (G.isFull(play) ? opts.fullMaxW : opts.maxW) || Infinity; }

    // Size a fixed-aspect board (a DOM board, or the box around a canvas) to fit its play block.
    // opts: aspect (width / height, or a function returning it; default 1), maxW and minW (CSS px; default no cap
    // and 160), fullMaxW (the cap in full screen; default none), maxH, host (whose content width caps the board;
    // default the board's parent), play (default the nearest .game-play), set(w, h) to apply the size yourself
    // (default: the board's style width and height), and onFit(w, h), called after the size changes.
    // Returns { w, h, refit, play }.
    G.fit = function (board, opts) {
        opts = opts || {};
        var play = opts.play || board.closest('.game-play'), host = opts.host || board.parentElement;
        var ctl = { w: 0, h: 0, play: play, refit: refit };
        function refit() {
            if (!board.getClientRects().length) return;
            var changed = false;
            for (var i = 0; i < 4; i++) {
                var a = typeof opts.aspect === 'function' ? opts.aspect() : (opts.aspect || 1);
                var maxH = Math.min(play ? G.space(board, play) : Infinity, opts.maxH || Infinity);
                var w = Math.floor(Math.min(contentW(host), capW(opts, play), maxH * a));
                w = Math.max(opts.minW || 160, w);
                var h = Math.floor(w / a);
                if (Math.abs(w - ctl.w) < 1 && Math.abs(h - ctl.h) < 1) break;
                ctl.w = w; ctl.h = h; changed = true;
                if (opts.set) opts.set(w, h); else { board.style.width = w + 'px'; board.style.height = h + 'px'; }
            }
            if (changed && opts.onFit) opts.onFit(ctl.w, ctl.h);
        }
        G.watch(playEls(play, [host]), refit);
        refit();
        return ctl;
    };

    // A canvas drawn in fixed logical units (w × h). Call view.begin() before drawing each frame.
    // Fit mode, G.canvas(cv, w, h, { fit: true, maxW, fullMaxW, onResize }) or G.canvas(cv, w, h, 'fit', onResize): the
    // canvas's box (its parent) gets the largest size that fits the box's container and the height its .game-play
    // block leaves free. Older pages pass a number maxVh instead: the box is sized to the width of its container
    // and to at most maxVh of the window height.
    G.canvas = function (cv, w, h, maxVh, onResize) {
        var opts = maxVh && typeof maxVh === 'object' ? maxVh : {};
        if (opts.onResize) onResize = opts.onResize;
        var ctx = cv.getContext('2d'), box = cv.parentElement, host = box.parentElement;
        var play = (maxVh === 'fit' || (typeof maxVh === 'object' && opts.fit !== false)) ? (opts.play || cv.closest('.game-play')) : null;
        var view = { ctx: ctx, w: w, h: h, scale: 1, play: play };
        var last = '';
        function size() {
            var avail = play ? contentW(host) : host.clientWidth;
            var maxH = play ? G.space(box, play) : Math.max(260, window.innerHeight * (typeof maxVh === 'number' ? maxVh : 0.8));
            var cssW = Math.max(play ? 160 : 200, Math.floor(Math.min(avail, capW(opts, play), maxH * w / h))), cssH = Math.round(cssW * h / w);
            var dpr = Math.min(2, window.devicePixelRatio || 1), key = cssW + 'x' + cssH + '@' + dpr;
            if (key === last) return false;   // unchanged: keep the drawing (resizing a canvas clears it)
            last = key;
            box.style.width = cssW + 'px';
            cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
            cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
            view.scale = cv.width / w;
            return true;
        }
        function fit(initial) {
            // In fit mode the new size may change the room left (a pad beside the board, a bar that wraps): settle.
            var changed = false;
            for (var i = 0; i < (play ? 4 : 1); i++) { if (!size()) break; changed = true; }
            if (changed && onResize && initial !== true) onResize(view);   // not on the first fit: the caller is still setting up
        }
        view.fit = function () { fit(); };
        view.begin = function () { ctx.setTransform(view.scale, 0, 0, view.scale, 0, 0); };
        view.point = function (e) { var r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * w, y: (e.clientY - r.top) / r.height * h }; };
        if (play) G.watch(playEls(play, [host]), fit);
        else {
            var lastW = -1;
            new ResizeObserver(function () { if (host.clientWidth !== lastW) { lastW = host.clientWidth; requestAnimationFrame(fit); } }).observe(host);
            window.addEventListener('resize', function () { requestAnimationFrame(fit); });
        }
        fit(true);
        return view;
    };

    // Scroll the play block (or the one around el) into view, if any of it is hidden: smoothly, or at once when the
    // visitor prefers reduced motion. Call it when a game starts. Returns the distance scrolled.
    var reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    G.reveal = function (el, instant) {
        var play = el ? (el.closest && el.closest('.game-play')) || el : document.querySelector('.game-play');
        if (!play || G.isFull(play) || !play.getClientRects().length) return 0;
        var b = G.band(play), r = play.getBoundingClientRect();
        if (r.top >= b.top - 1 && r.bottom <= b.bottom + 1) return 0;
        var dy = r.height > b.height || r.top < b.top ? r.top - b.top : r.bottom - b.bottom;
        var behavior = instant || reduced.matches ? 'auto' : 'smooth';
        try { window.scrollBy({ top: dy, behavior: behavior }); } catch (e) { window.scrollBy(0, dy); }
        return dy;
    };
    // A key the game used (it called preventDefault) also brings the play block into view: a player who scrolled
    // down to read the rules can just keep playing. A play block with data-reveal="off" opts out.
    window.addEventListener('keydown', function (e) {
        if (!e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.key === 'Tab' || e.key === 'Escape') return;
        var t = e.target;
        if (t && t.closest && (t.closest('dialog[open], input, select, textarea, [contenteditable="true"]'))) return;
        var plays = document.querySelectorAll('.game-play');
        if (plays.length === 1 && plays[0].getAttribute('data-reveal') !== 'off') G.reveal(plays[0]);
    });

    // Full screen for the play block: the Fullscreen API where there is one (not on iPhone), else a "focus" view
    // that covers the window. btn may be empty; it gets an icon and a label that follow the state.
    var ICON_FULL = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
    var ICON_EXIT = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
    function setFocus(play, on) {
        play.classList.toggle('game-focus', on);
        document.documentElement.classList.toggle('game-focus-on', on);
        document.dispatchEvent(new Event('gamefocuschange'));
    }
    G.toggleFull = function (play) {
        play = play || document.querySelector('.game-play');
        if (!play) return;
        if (document.fullscreenElement || document.webkitFullscreenElement) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
        if (play.classList.contains('game-focus')) { setFocus(play, false); return; }
        var req = play.requestFullscreen || play.webkitRequestFullscreen, active = !navigator.userActivation || navigator.userActivation.isActive;
        if (req && active && (document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
            try { var p = req.call(play); if (p && p.catch) p.catch(function () { setFocus(play, true); }); } catch (e) { setFocus(play, true); }
        } else setFocus(play, true);
    };
    G.fullButton = function (btn, play) {
        play = play || btn.closest('.game-play') || document.querySelector('.game-play');
        var text = btn.textContent.trim() !== '';   // a button with words keeps words; an empty one gets an icon
        function label() {
            var on = G.isFull(play), name = on ? 'Exit full screen' : 'Full screen';
            if (text) btn.textContent = name;
            else { btn.innerHTML = on ? ICON_EXIT : ICON_FULL; btn.setAttribute('aria-label', name); btn.title = name; }
        }
        btn.addEventListener('click', function () { G.toggleFull(play); });
        ['fullscreenchange', 'webkitfullscreenchange', 'gamefocuschange'].forEach(function (t) { document.addEventListener(t, label); });
        label();
    };
    // Escape leaves the focus view, unless the game used the key (many games pause on Escape) or the key only
    // closes an open dialog (settings, level list).
    window.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        if (document.querySelector('dialog[open]')) return;
        var f = document.querySelector('.game-play.game-focus');
        if (f) setFocus(f, false);
    });

    // requestAnimationFrame loop with a clamped time step (a background tab returns with one small step, not a jump).
    // Returns { start, stop, running }: a game may stop the loop when nothing moves and start it again (optional).
    G.loop = function (step) {
        var last = performance.now(), id = 0, on = false;
        function frame(t) { id = 0; step(Math.min(0.033, Math.max(0, (t - last) / 1000))); last = t; if (on && !id) id = requestAnimationFrame(frame); }
        var ctl = {
            start: function () { if (!on) { on = true; last = performance.now(); if (!id) id = requestAnimationFrame(frame); } return ctl; },
            stop: function () { on = false; if (id) cancelAnimationFrame(id); id = 0; return ctl; },
            running: function () { return on; }
        };
        return ctl.start();
    };

    // Hold-to-press buttons for touch controls: down() on press, up() on release.
    G.hold = function (el, down, up) {
        el.addEventListener('pointerdown', function (e) { e.preventDefault(); el.classList.add('on'); down(); });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { el.addEventListener(t, function () { if (el.classList.contains('on')) { el.classList.remove('on'); up(); } }); });
        el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    };

    G.fmt = function (n) { return Math.round(n).toLocaleString('en-US'); };
    window.Games = G;
})();
