// WP2: unit tests of the thin-film transfer matrix, assets/js/glazing-tmm.js (glazing beta build spec 2.3, 7.3).
// Run: node --test "_tests/glazing/**/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers/load.mjs';

const ctx = load.open();
const TMM = ctx.GlazingTMM, E = ctx.GlazingEngine, O = ctx.GlazingOpen, C = ctx.GlazingCoatings;
const LAM = E.LAM;

// Deterministic pseudo-random numbers (mulberry32) for the random stacks.
function rng(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function randomStack(r, absorbing) {
    const m = 1 + Math.floor(r() * 10), n = [], k = [], d = [];
    for (let j = 0; j < m; j++) {
        const metal = absorbing && r() < 0.4;
        n.push(metal ? 0.03 + r() * 3 : 1.3 + r() * 1.3);
        k.push(metal ? r() * 6 : absorbing ? r() * 0.05 : 0);
        d.push(metal ? r() * 25 : r() * 300);
    }
    return { n, k, d, lam: 300 + r() * 2200, n0: 1 + r() * 0.6, ns: 1 + r() * 0.8 };
}

test('quarter-wave layer of n = 2 on n = 1.52 at 550 nm gives R = 0.201848', () => {
    const r = TMM.stackRT([2], [0], [550 / 8], 550, 1, 1.52);
    const exact = ((1.52 - 4) / (1.52 + 4)) ** 2;            // (n0 ns − n1²)² / (n0 ns + n1²)²
    assert.ok(Math.abs(r.R - exact) < 1e-14, String(r.R));
    assert.equal(r.R.toFixed(6), '0.201848');
    assert.ok(Math.abs(r.R + r.T - 1) < 1e-14);
});

test('a single interface matches the Fresnel formulas', () => {
    for (const [n0, ns] of [[1, 1.52], [1.52, 1], [1, 2.4], [1.33, 1.9]]) {
        const r = TMM.stackRT([], [], [], 550, n0, ns);
        assert.ok(Math.abs(r.R - ((n0 - ns) / (n0 + ns)) ** 2) < 1e-15);
        assert.ok(Math.abs(r.T - 4 * n0 * ns / (n0 + ns) ** 2) < 1e-15);
    }
    // A layer of the substrate's own index is invisible, whatever its thickness.
    const r = TMM.stackRT([1.52], [0], [137.3], 600, 1, 1.52), f = ((1 - 1.52) / (1 + 1.52)) ** 2;
    assert.ok(Math.abs(r.R - f) < 1e-14);
});

test('lossless stacks give R + T = 1 to 1e-12 (500 random stacks)', () => {
    const r = rng(12345);
    let worst = 0;
    for (let i = 0; i < 500; i++) {
        const s = randomStack(r, false), x = TMM.stackRT(s.n, s.k, s.d, s.lam, s.n0, s.ns);
        worst = Math.max(worst, Math.abs(x.R + x.T - 1));
    }
    assert.ok(worst < 1e-12, 'max |R + T − 1| = ' + worst);
});

test('absorbing stacks give R + T <= 1, with R and T in [0, 1] (500 random stacks)', () => {
    const r = rng(777);
    for (let i = 0; i < 500; i++) {
        const s = randomStack(r, true), x = TMM.stackRT(s.n, s.k, s.d, s.lam, s.n0, s.ns);
        assert.ok(x.R >= 0 && x.T >= 0 && x.R <= 1 + 1e-12 && x.T <= 1 + 1e-12, JSON.stringify(x));
        assert.ok(x.R + x.T <= 1 + 1e-12, 'R + T = ' + (x.R + x.T));
    }
});

test('a zero-thickness layer changes nothing', () => {
    const r = rng(99);
    for (let i = 0; i < 100; i++) {
        const s = randomStack(r, true), at = Math.floor(r() * (s.n.length + 1));
        const a = TMM.stackRT(s.n, s.k, s.d, s.lam, s.n0, s.ns);
        const n = s.n.slice(), k = s.k.slice(), d = s.d.slice();
        n.splice(at, 0, 0.2 + r() * 3); k.splice(at, 0, r() * 4); d.splice(at, 0, 0);
        const b = TMM.stackRT(n, k, d, s.lam, s.n0, s.ns);
        assert.ok(Math.abs(a.R - b.R) < 1e-14 && Math.abs(a.T - b.T) < 1e-14);
    }
});

test('film transmittance is the same in both directions (absorbing stacks)', () => {
    const r = rng(4242);
    let worst = 0;
    for (let i = 0; i < 300; i++) {
        const s = randomStack(r, true);
        const fwd = TMM.stackRT(s.n, s.k, s.d, s.lam, s.n0, s.ns);
        const rev = TMM.stackRT(s.n.slice().reverse(), s.k.slice().reverse(), s.d.slice().reverse(), s.lam, s.ns, s.n0);
        worst = Math.max(worst, Math.abs(fwd.T - rev.T) / Math.max(fwd.T, 1e-300));
    }
    assert.ok(worst < 1e-10, 'max relative difference ' + worst);
    // And through filmSpectra: Tc (from air) equals the transmittance computed from inside the glass.
    const g = O.glass('clear'), layers = C.coatings.triple.layers.map(L => ({ n: O.material(L.m).n, k: O.material(L.m).k, d: L.d }));
    const f = TMM.filmSpectra(layers, LAM, g.n);
    for (let i = 0; i < LAM.length; i += 7) {
        const back = TMM.stackRT(layers.map(L => L.n[i]), layers.map(L => (L.k ? L.k[i] : 0)), layers.map(L => L.d), LAM[i], g.n[i], 1);
        assert.ok(Math.abs(back.T - f.Tc[i]) <= 1e-10 * f.Tc[i] + 1e-300, LAM[i] + ' nm');
    }
});

test('filmSpectra: shapes, and the empty film is the bare interface', () => {
    const g = O.glass('clear'), f = TMM.filmSpectra([], LAM, g.n);
    assert.equal(f.Tc.length, 441); assert.equal(f.Rc.length, 441); assert.equal(f.Rg.length, 441);
    for (let i = 0; i < 441; i++) {
        const R = ((g.n[i] - 1) / (g.n[i] + 1)) ** 2;
        assert.ok(Math.abs(f.Rc[i] - R) < 1e-15 && Math.abs(f.Rg[i] - R) < 1e-15 && Math.abs(f.Tc[i] - (1 - R)) < 1e-15);
    }
});

test('double silver: Rg differs from Rc by more than 0.05 somewhere in 400-700 nm', () => {
    const f = O.film(C.coatings.double.layers, 'clear');
    let max = 0, at = 0;
    for (let i = 0; i < LAM.length; i++) if (LAM[i] >= 400 && LAM[i] <= 700) {
        const d = Math.abs(f.Rg[i] - f.Rc[i]);
        if (d > max) { max = d; at = LAM[i]; }
    }
    assert.ok(max > 0.05, `max |Rg − Rc| = ${max.toFixed(4)} at ${at} nm`);
});

test('combine without a film equals the classic bare-glass formula; with an empty film it is the same pane', () => {
    const g = O.glass('clear'), r = rng(5);
    // R0 from the real index only, as the film's interface sees it (glass k is ignored at the interface).
    const R0 = Float64Array.from(g.n, n => ((n - 1) / (n + 1)) ** 2), tau = Float64Array.from(LAM, () => 0.5 + 0.5 * r());
    const bare = TMM.combine(null, R0, tau, 'front');
    const empty = TMM.combine(TMM.filmSpectra([], LAM, g.n), R0, tau, 'back');
    for (let i = 0; i < 441; i++) {
        // The classic engine's expressions, in its order of operations: bitwise equal.
        const R = R0[i], t = tau[i], t2 = t * t, den = 1 - R * R * t2;
        assert.equal(bare.T[i], (1 - R) * (1 - R) * t / den);
        assert.equal(bare.Rf[i], R + (1 - R) * (1 - R) * R * t2 / den);
        assert.equal(bare.Rb[i], bare.Rf[i]);
        // The empty film reproduces R0 = |(n−1)/(n+1)|² (k of the glass is below 1e-5).
        assert.ok(Math.abs(empty.T[i] - bare.T[i]) < 1e-12 && Math.abs(empty.Rf[i] - bare.Rf[i]) < 1e-12 && Math.abs(empty.Rb[i] - bare.Rb[i]) < 1e-12);
    }
});

test('combine: the side swaps the reflectances; T is the same; energy is conserved', () => {
    const g = O.glass('clear'), f = O.film(C.coatings.single.layers, 'clear'), tau = Float64Array.from(LAM, () => 0.9);
    const a = TMM.combine(f, g.R0, tau, 'front'), b = TMM.combine(f, g.R0, tau, 'back');
    for (let i = 0; i < 441; i++) {
        assert.equal(a.T[i], b.T[i]); assert.equal(a.Rf[i], b.Rb[i]); assert.equal(a.Rb[i], b.Rf[i]);
        assert.ok(a.T[i] + a.Rf[i] <= 1 + 1e-12 && a.T[i] + a.Rb[i] <= 1 + 1e-12);
    }
    // Spec 2.3 formulas, written out independently.
    for (let i = 0; i < 441; i += 11) {
        const r = g.R0[i], t = tau[i], den = 1 - f.Rg[i] * r * t * t;
        assert.ok(Math.abs(a.T[i] - f.Tc[i] * (1 - r) * t / den) < 1e-15);
        assert.ok(Math.abs(a.Rf[i] - (f.Rc[i] + f.Tc[i] ** 2 * r * t * t / den)) < 1e-15);
        assert.ok(Math.abs(a.Rb[i] - (r + (1 - r) ** 2 * f.Rg[i] * t * t / den)) < 1e-15);
    }
});
