// WP2: every reference number embedded in validation-mc.js equals its source entry (spec §5.1 rule 5):
// fixtures/validation-cases-v2.json and fixtures/conductance-tables.json, or the spec (Appendix B) where the
// research file has no entry. Also checks the case list against the table of §5.3 (ids, N, seeds, quick set).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MC_CASES } from '../../beta/conductance/js/engine/validation-mc.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/validation-cases-v2.json', import.meta.url), 'utf8'));
const TB = JSON.parse(readFileSync(new URL('./fixtures/conductance-tables.json', import.meta.url), 'utf8'));
const byId = Object.fromEntries(MC_CASES.map((c) => [c.id, c]));
const at = (obj, path) => path.reduce((o, k) => (o === undefined ? undefined : o[k]), obj);

// spec §5.3 / Appendix B values that have no entry in the research file
const SPEC = {
  'mc-preset-turbo': [138.03, 0.16],          // Appendix B.1 preset 1, chain TPMC 4·10⁶ particles
  'mc-preset-beamline': [22.14, 0.03],        // Appendix B.1 preset 4
  'mesh-elbow33': [0.26524, 0.00021],         // Appendix B.2 (TPMC "elbowchk 3,3", 4.6·10⁶ particles)
};

// §5.3 table: id → [quick N or null (full only), full N, tolerance]
const TABLE = {
  'mc-tube10': [3e5, 2e6, { sigmas: 3 }], 'mc-orifice-tube': [2e5, 2e6, { sigmas: 3 }], 'mc-tpt': [3e5, 2e6, { sigmas: 3 }],
  'mc-contraction': [6e5, 4e6, { sigmas: 3 }], 'mc-expansion': [2e5, 2e6, { sigmas: 3 }], 'mc-livesey-15-25-20': [3e5, 2e6, { sigmas: 3 }],
  'mc-elbow22': [2e5, 2e6, { sigmas: 3 }], 'mc-elbow25': [3e5, 2e6, { sigmas: 3 }], 'mc-merge': [2e5, 2e6, { sigmas: 3 }],
  'mc-cone20': [1e5, 1e6, { sigmas: 3 }], 'mc-cone-recip': [4e5, 3e6, { abs: 3 }], 'mc-annulus': [2e5, 2e6, { sigmas: 3 }],
  'mc-rect': [2e5, 2e6, { sigmas: 3 }], 'mc-livesey-pump': [3e5, 3e6, { sigmas: 3, plusRel: 0.002 }],
  'mc-preset-turbo': [3e5, 3e6, { sigmas: 3 }], 'mc-preset-beamline': [3e5, 3e6, { sigmas: 3 }],
  'mesh-tube10': [2e5, 1e6, { sigmas: 3, plusRel: 0.003 }], 'mesh-elbow33': [2e5, 1e6, { sigmas: 3, plusRel: 0.003 }],
  'mesh-cone20': [1e5, 5e5, { sigmas: 3, plusRel: 0.003 }], 'mesh-annulus': [1e5, 5e5, { sigmas: 3, plusRel: 0.004 }],
  'mesh-rect': [1e5, 5e5, { sigmas: 3, plusRel: 0.001 }], 'mesh-profile20': [null, 1e6, { abs: 0.006 }],
  'mesh-faceting16': [null, 1e6, { sigmas: 3, plusAbs: 0.5 }], 'mesh-leaks': [null, 1e6, { abs: 1 }],
  'mesh-recip-cone': [null, 1e6, { abs: 3 }], 'mesh-stl-roundtrip': [null, 1e6, { sigmas: 3 }],
  'mesh-pump': [null, 1e6, { sigmas: 3, plusRel: 0.004 }],
  'neg-sampler-asin': [null, 1e5, null], 'neg-sampler-uniform': [null, 1e5, null], 'neg-leaky-mesh': [null, 2e5, null],
};

test('the case list matches the table of §5.3: ids, groups, N, tolerances, seeds', () => {
  assert.deepEqual(MC_CASES.map((c) => c.id), Object.keys(TABLE));
  assert.equal(new Set(MC_CASES.map((c) => c.id)).size, MC_CASES.length);
  MC_CASES.forEach((c, i) => {
    const [q, n, tol] = TABLE[c.id];
    assert.equal(c.seed, 20261012 + i, c.id + ' seed');
    assert.equal(c.n, n, c.id + ' full N');
    if (q !== null) assert.equal(c.nQuick, q, c.id + ' quick N');
    assert.deepEqual(c.tol, tol, c.id + ' tolerance');
    assert.equal(c.group, c.id.startsWith('mc-') ? 'chain-mc' : c.id.startsWith('mesh-') ? 'mesh-mc' : 'negative');
  });
  // quick set: every chain case plus mesh-tube10 and mesh-elbow33 (and the two sampler controls, 10⁵ particles each)
  const quick = MC_CASES.filter((c) => c.quick).map((c) => c.id);
  assert.deepEqual(quick, [...Object.keys(TABLE).filter((k) => k.startsWith('mc-')), 'mesh-tube10', 'mesh-elbow33', 'neg-sampler-asin', 'neg-sampler-uniform']);
  assert.equal(byId['neg-leaky-mesh'].nodeOnly, true);
  for (const c of MC_CASES.filter((x) => x.group === 'negative')) assert.ok(c.catchRel >= 0 && Number.isFinite(c.catchRel));
});

test('embedded references equal the research fixture (validation-cases-v2.json) exactly', () => {
  let checked = 0;
  for (const c of MC_CASES) {
    const rf = c.refFrom;
    assert.ok(rf, c.id + ' names its reference source');
    if (rf.file === 'validation-cases-v2.json') {
      const v = at(V, rf.path);
      assert.notEqual(v, undefined, c.id + ': ' + rf.path.join(' / '));
      if (c.id === 'mesh-profile20') {
        assert.deepEqual(c.clausing.q, v);
        assert.deepEqual(c.clausing.z, V.profile_tube_L_over_R_20.z_over_L);
      } else if (Array.isArray(v)) { assert.equal(c.ref, v[0], c.id); assert.equal(c.refSigma, v[1], c.id); }
      else if (typeof v === 'object') { assert.equal(c.ref, v.alpha, c.id); assert.equal(c.refSigma, v.sigma, c.id); }
      else { assert.equal(c.ref, v, c.id); assert.equal(c.refSigma, 0, c.id); }
      checked++;
    } else if (rf.spec) {
      assert.deepEqual([c.ref, c.refSigma], SPEC[c.id], c.id);
      checked++;
    } else if (rf.identity) {
      assert.equal(c.ref, 0, c.id);
      checked++;
    } else if (rf.policy) {
      assert.ok(c.id === 'mesh-leaks' ? c.ref === 0 && c.tol.abs === 1 : c.ref === 100 && c.catchRel === 0, c.id);   // 100 per million: the stop limit
      checked++;
    }
  }
  assert.equal(checked, MC_CASES.length);
});

test('cross-checks against the engine tables (conductance-tables.json)', () => {
  // tube integral-equation values
  const tl = TB.TUBE_IE.l, ta = TB.TUBE_IE.alpha;
  assert.equal(byId['mc-tube10'].ref, ta[tl.indexOf(10)]);
  assert.equal(byId['mesh-tube10'].ref, ta[tl.indexOf(10)]);
  assert.equal(byId['neg-sampler-asin'].ref, ta[tl.indexOf(2)]);
  assert.equal(byId['neg-sampler-uniform'].ref, ta[tl.indexOf(2)]);
  // faceting and the Clausing profile
  assert.equal(byId['mesh-faceting16'].ref, TB.FACETING['L/R=10'][TB.FACETING.n.indexOf(16)]);
  assert.deepEqual(byId['mesh-profile20'].clausing.q, TB.CLAUSING_PROFILE_LR20.p_over_pin);
  assert.deepEqual(byId['mesh-profile20'].clausing.z, TB.CLAUSING_PROFILE_LR20.z_over_L);
  // the same TPMC values are used by the mesh twins of the chain cases
  for (const [a, b] of [['mc-cone20', 'mesh-cone20'], ['mc-annulus', 'mesh-annulus'], ['mc-rect', 'mesh-rect'], ['mc-livesey-pump', 'mesh-pump']]) {
    assert.equal(byId[a].ref, byId[b].ref, b); assert.equal(byId[a].refSigma, byId[b].refSigma, b);
  }
  // the elbow (2, 2) reference serves the merged tube–elbow–tube case
  assert.equal(byId['mc-merge'].ref, byId['mc-elbow22'].ref);
});

test('every case names a source with a label and a link', () => {
  for (const c of MC_CASES) {
    assert.ok(typeof c.source.label === 'string' && c.source.label.length > 10, c.id);
    assert.ok(/^(https:\/\/|#)/.test(c.source.url), c.id + ' ' + c.source.url);
    assert.ok(typeof c.title === 'string' && c.title.length > 5, c.id);
    assert.ok(typeof c.unit === 'string', c.id);
  }
});
