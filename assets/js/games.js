/* Shared helpers for the /games/ pages: saved settings, sound effects, and a resolution-independent canvas. */
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
    ['keydown', 'pointerdown'].forEach(function (t) { document.addEventListener(t, function () { if (G.soundOn) G.audio(); }, true); });

    // A canvas drawn in fixed logical units (w × h). Its box (the canvas's parent) is sized to the width of the
    // box's container and to at most maxVh of the viewport height. Call view.begin() before drawing each frame.
    G.canvas = function (cv, w, h, maxVh, onResize) {
        var ctx = cv.getContext('2d'), box = cv.parentElement, host = box.parentElement;
        var view = { ctx: ctx, w: w, h: h, scale: 1 };
        function fit(initial) {
            var avail = host.clientWidth, maxH = Math.max(260, window.innerHeight * (maxVh || 0.8));
            var cssW = Math.max(200, Math.floor(Math.min(avail, maxH * w / h))), cssH = Math.round(cssW * h / w);
            var dpr = Math.min(2, window.devicePixelRatio || 1);
            box.style.width = cssW + 'px';
            cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
            cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
            view.scale = cv.width / w;
            if (onResize && initial !== true) onResize(view);   // not on the first fit: the caller is still setting up
        }
        view.begin = function () { ctx.setTransform(view.scale, 0, 0, view.scale, 0, 0); };
        view.point = function (e) { var r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * w, y: (e.clientY - r.top) / r.height * h }; };
        var lastW = -1;
        new ResizeObserver(function () { if (host.clientWidth !== lastW) { lastW = host.clientWidth; requestAnimationFrame(fit); } }).observe(host);
        window.addEventListener('resize', function () { requestAnimationFrame(fit); });
        fit(true);
        return view;
    };

    // requestAnimationFrame loop with a clamped time step (a background tab returns with one small step, not a jump).
    G.loop = function (step) {
        var last = performance.now();
        function frame(t) { step(Math.min(0.033, Math.max(0, (t - last) / 1000))); last = t; requestAnimationFrame(frame); }
        requestAnimationFrame(frame);
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
