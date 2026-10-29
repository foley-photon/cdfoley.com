// WP1 golden values (spec 3.4.3, 5.2; acceptance 7.2.2): the engine reproduces the design reference to 1e-7
// relative for every function and to 1e-6 for the Appendix B preset analyses, molecular limits and sweeps.
// Run: node --test "_tests/conductance/wp1-golden.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../../beta/conductance/js/engine/molecular.js';
import * as F from '../../beta/conductance/js/engine/flow.js';
import * as N from '../../beta/conductance/js/engine/network.js';
import { gasState } from '../../beta/conductance/js/engine/gas.js';

const GOLD = JSON.parse(readFileSync(new URL('./fixtures/golden-formulas.json', import.meta.url), 'utf8'));
const relDev = (a, b) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(b), 1e-300));

function checkAll(name, fn, entries, tol) {
    let worst = 0, at = null;
    for (const { args, value } of entries) {
        const got = fn(...args), d = relDev(got, value);
        if (!(d <= worst)) { worst = d; at = args; }
        assert.ok(d <= tol, `${name}(${args.join(', ')}) = ${got}, golden ${value} (rel ${d.toExponential(2)})`);
    }
    return { worst, at };
}

test('golden file is the expected format and covers about 250 function values', () => {
    assert.equal(GOLD.format, 'cdfoley-conductance-golden');
    assert.equal(GOLD.version, 1);
    const n = Object.values(GOLD.functions).reduce((s, a) => s + a.length, 0);
    assert.ok(n >= 240, `only ${n} golden function values`);
    assert.equal(Object.keys(GOLD.presets).length, 7);
});

const FNS = {
    tubeAlpha: M.tubeAlpha, tubeAlphaInverse: M.tubeAlphaInverse, slotAlpha: M.slotAlpha, rectAlpha: M.rectAlpha,
    annulusAlpha: M.annulusAlpha, coneAlpha: M.coneAlpha, elbowAlpha: M.elbowAlpha,
    Z: F.Z, IZ: F.IZ, GP: F.GP, gOrifice: F.gOrifice, psi: F.psi, nearFmA: F.nearFmA,
};

for (const [name, entries] of Object.entries(GOLD.functions)) {
    test(`golden ${name}: ${entries.length} values to 1e-7`, () => {
        assert.ok(FNS[name], `no engine function for golden key ${name}`);
        checkAll(name, FNS[name], entries, 1e-7);
    });
}

const close = (got, want, tol, what) => {
    if (want === null) { assert.equal(got, null, what); return; }
    assert.ok(relDev(got, want) <= tol, `${what}: ${got} vs golden ${want} (rel ${relDev(got, want).toExponential(2)})`);
};

for (const [name, g] of Object.entries(GOLD.presets)) {
    test(`golden preset ${name}: analyze, molecular limit and sweeps to 1e-6`, () => {
        const r = N.analyze(g.model);
        assert.equal(r.ok, true, JSON.stringify(r.errors));
        assert.equal(r.converged, g.analyze.converged);
        for (const k of ['Q', 'Seff', 'Cline', 'pN']) close(r[k], g.analyze[k], 1e-6, `${name} ${k}`);
        assert.equal(r.elements.length, g.analyze.shares.length);
        r.elements.forEach((e, i) => close(e.share, g.analyze.shares[i], 1e-6, `${name} share ${i}`));
        if (g.analyze.pumpShare !== null) close(r.pump.share, g.analyze.pumpShare, 1e-6, `${name} pump share`);
        assert.equal(r.mol.band.junctions, g.analyze.junctions);
        close(r.mol.Cline, g.molecularLimit.Cline, 1e-6, `${name} mol Cline`);
        close(r.mol.Seff, g.molecularLimit.Seff, 1e-6, `${name} mol Seff`);
        const G = gasState(g.model.gas.id, g.model.gas.T);
        const ml = N.molecularLimit(g.model.items, G);
        close(ml.Cline, g.molecularLimit.Cline, 1e-6, `${name} molecularLimit Cline`);
        close(ml.Seff, g.molecularLimit.Seff, 1e-6, `${name} molecularLimit Seff`);
        const sc = N.sweep(g.model, 'C');
        assert.equal(sc.y.length, g.sweepC.length);
        g.sweepC.forEach((v, k) => close(sc.y[k], v, 1e-6, `${name} C sweep point ${k}`));
        if (g.sweepSeff) {
            const ss = N.sweep(g.model, 'Seff');
            assert.ok(ss.converged.every((c) => c === 1), `${name}: unconverged Seff sweep points`);
            g.sweepSeff.forEach((v, k) => close(ss.y[k], v, 1e-6, `${name} Seff sweep point ${k}`));
        }
    });
}
