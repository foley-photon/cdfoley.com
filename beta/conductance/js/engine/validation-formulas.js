// Formula validation cases (spec 5.2): published and "this work" reference values, embedded with their sources
// because the browser cannot read _tests/. wp1-validation-data.test.mjs checks every embedded number against
// _tests/conductance/fixtures/*.json (refFrom: file 'v' = validation-cases-v2.json, 't' = conductance-tables.json).

import { gasState, orificeC } from './gas.js';
import { tubeAlpha, slotAlpha, rectAlpha, annulusAlpha, coneAlpha, elbowAlpha, bermanSlotAlpha, bermanAnnulusAlpha } from './molecular.js';
import { GP, edgeG } from './flow.js';
import { compileItem } from './elements.js';
import { buildNetwork, molecularLimit, errorBand, analyze, sweep } from './network.js';

const PI = Math.PI, DEG = PI / 180, G0 = 8 / (3 * Math.sqrt(PI));
const LIVESEY = 'https://www.wiley-vch.de/en/areas-interest/engineering/foundations-of-vacuum-science-and-technology-978-0-471-17593-3';
const JPCRD = 'https://srd.nist.gov/jpcrdreprint/1.556019.pdf';
const CERN = 'https://doi.org/10.5170/CERN-2007-003';
const SRC = {
    leybold130: { label: 'Leybold, Fundamentals of Vacuum Technology, eq. 1.30', url: 'https://archive.org/details/FundamentalsOfVacuumTechnology/page/n15' },
    leybold126: { label: 'Leybold, Fundamentals of Vacuum Technology, eq. 1.26', url: 'https://archive.org/details/FundamentalsOfVacuumTechnology/page/n15' },
    matuda: { label: 'Matuda 2015, Table 1 (integral equation)', url: 'https://doi.org/10.3131/jvsj2.58.311' },
    jpcrd29: { label: 'Sharipov & Seleznev 1998 (JPCRD), Table 29', url: JPCRD },
    sb: { label: 'Santeler & Boeckmann 1991, in Livesey Table 2.6', url: LIVESEY },
    cole: { label: 'Cole, in Livesey Table 2.7', url: LIVESEY },
    bermanAnn: { label: 'Berman, in Livesey Table 2.9', url: LIVESEY },
    nasa: { label: 'Richley & Reynolds, NASA TN D-2330, Table I(a)', url: 'https://ntrs.nasa.gov/citations/19640011357' },
    tpmc: { label: 'Test-particle Monte Carlo of this work (research, 2·10⁶ particles)', url: '#how' },
    identity: { label: 'Reciprocity: A₁α₁₂ = A₂α₂₁', url: '#how' },
    haefer: { label: 'Haefer addition theorem (Haefer 1980), research value', url: 'https://doi.org/10.1016/S0042-207X(80)80745-7' },
    liveseyHaefer: { label: 'Livesey, Haefer example (15/25/20 mm)', url: LIVESEY },
    liveseyPump: { label: 'Livesey p. 100, pump on a tube (Oatley/Ho)', url: LIVESEY },
    cern: { label: 'Sharipov, CERN-2007-003, Table 1', url: CERN },
    jpcrd7: { label: 'Sharipov & Seleznev 1998 (JPCRD), Table 7, column b', url: JPCRD },
    jpcrd3: { label: 'Sharipov & Seleznev 1998 (JPCRD), Table 3 (plane channel, Cercignani & Pagani)', url: JPCRD },
    chainMc: { label: 'Chain Monte Carlo of this work (10⁷ particles; an independent TPMC agrees)', url: '#how' },
    fu: { label: 'Fujimoto & Usami, in JPCRD eq. 4.14', url: JPCRD },
    liepmann: { label: 'Liepmann, in JPCRD Table 28', url: JPCRD },
    wong: { label: 'Square-duct Poiseuille constant (Wong 2020)', url: '#how' },
    jpcrd516: { label: 'JPCRD eq. 5.16: L + 3πR/8 end correction', url: JPCRD },
    berman: { label: 'Berman 1965 (Livesey eqs. 2.28 and 2.36)', url: 'https://doi.org/10.1063/1.1702984' },
};

// ---- embedded reference data (exact copies of fixture entries)
const MATUDA = { 1: 0.514230535, 2: 0.356572732, 5: 0.190942432, 10: 0.109320714, 20: 0.059450419, 50: 0.025276364, 100: 0.012944758, 500: 0.002647618 };
const JPCRD_SLOT = [['0.1', 0.9525], ['0.2', 0.9096], ['0.4', 0.8362], ['0.5', 0.8047], ['1', 0.6844], ['2', 0.5421], ['4', 0.3992], ['5', 0.3565], ['10', 0.2408]];
const SB = [['(b/a=1,l/a=1)', 1, 1, 0.5363], ['(1,2)', 1, 2, 0.378], ['(1,10)', 1, 10, 0.1195], ['(1,20)', 1, 20, 0.0655],
    ['(2,1)', 2, 1, 0.6026], ['(2,10)', 2, 10, 0.1537], ['(4,2)', 4, 2, 0.4893], ['(4,10)', 4, 10, 0.1843], ['(8,1)', 8, 1, 0.6631],
    ['(8,10)', 8, 10, 0.2078], ['(24,10)', 24, 10, 0.2287], ['(1,0.1)', 1, 0.1, 0.9131]];
const COLE = [['(1,1)', 1, 1, 0.53619], ['(1,4)', 1, 4, 0.24233], ['(10,10)', 10, 10, 0.2128], ['(100,10)', 100, 10, 0.2372]];
const BERMAN_ANN = [['(0.5,2)', 0.5, 2, 0.5295], ['(0.5,10)', 0.5, 10, 0.2081], ['(0.75,2)', 0.75, 2, 0.5365], ['(0.75,10)', 0.75, 10, 0.22],
    ['(0.9,5)', 0.9, 5, 0.3507], ['(0.9,10)', 0.9, 10, 0.2304], ['(0.25,4)', 0.25, 4, 0.3661], ['(0.25,8)', 0.25, 8, 0.2339]];
const NASA = [['(10,1)', 10, 1, 0.792], ['(20,2)', 20, 2, 0.834], ['(30,4)', 30, 4, 0.91], ['(45,1)', 45, 1, 0.979]];
const CONE_TPMC = [['cone beta=20 L/R1=2', 20, 2, 0.837679, 0.0003687450243176171], ['cone beta=5 L/R1=16', 5, 16, 0.380229, 0.00048544300134928305],
    ['cone beta=45 L/R1=1', 45, 1, 0.979419, 0.00014197683768488422], ['cone beta=-5 L/R1=8', -5, 8, 0.032269, 0.0001767136430471626],
    ['cone beta=-20 L/R1=1', -20, 1, 0.343436, 0.0004748554663305457], ['cone beta=-45 L/R1=0.5', -45, 0.5, 0.244427, 0.0004297469507407819]];
const ELBOW_TPMC = [['elbow90 R=1 A=B=1', 1, 1, 0.54176, 0.00035], ['elbow90 R=1 A=B=2', 2, 2, 0.35147, 0.00034], ['elbow90 R=1 A=B=5', 5, 5, 0.18207, 0.00027]];
const ELBOW_ASYM = { key: 'A=2,B=5', A: 2, B: 5, alpha: 0.239884, sigma: 0.0004270124899156932 };
const FU = [['0.1', 0.1, 1.0067], ['0.5', 0.5, 1.0588], ['1', 1, 1.1241], ['2', 2, 1.2215], ['5', 5, 1.3644], ['10', 10, 1.446]];
const LIEPMANN = [['N2', 1.414], ['Ar', 1.476], ['CO2', 1.388]];
const GP_TABLE = { '1.0': 1.4758, '10.0': 3.5749 };
// off-node values of the long-tube G_P (between the engine's 14 nodes): JPCRD Table 7, column b (S model)
const GP_OFFNODE = [['0.3', 0.3, 1.3876], ['3', 3, 1.9014], ['7', 7, 2.8455]];
// long plane channel G_P^ch(delta), delta on the full gap: JPCRD Table 3 (Cercignani & Pagani, BGK)
const GP_CHANNEL = [['0.1', 0.1, 2.0314], ['1', 1, 1.5389], ['10', 10, 2.7638]];
const T20 = 293.15;
const gas = (id) => gasState(id, T20);

const tube = (d, L) => ({ t: 'tube', d, L });
const orif = (d) => ({ t: 'orifice', shape: 'circle', d });
const lineAlpha = (items, Aref, G = gas('air')) => molecularLimit(items, G).Cline / (Aref * G.vbar / 4);
const coneR2 = (betaDeg, l) => 1 + l * Math.tan(betaDeg * DEG);
const idNum = (v) => String(v).replace('-', 'm');

function formula(o) {
    return { group: 'formula', refSigma: 0, quick: true, unit: '', refFrom: null, ...o };
}

const LINES = {
    orificeTube: { items: [orif(0.01), tube(0.02, 0.08)], Aref: PI * 0.005 ** 2 },
    tubePlateTube: { items: [tube(0.02, 0.01), orif(0.01), tube(0.02, 0.01)], Aref: PI * 0.01 ** 2 },
    livesey: { items: [tube(0.015, 0.03), tube(0.025, 0.05), tube(0.02, 0.04)], Aref: PI * 0.0075 ** 2 },
    // v2.2: a rod end face (formula about 8 % high) and a partial overlap (formula about 7 % high)
    tubeRodTube: { items: [tube(0.02, 0.005), { t: 'annulus', di: 0.016, do: 0.02, L: 0.005 }, tube(0.02, 0.005)], Aref: PI * 0.01 ** 2 },
    orificeRod: { items: [orif(0.012), { t: 'annulus', di: 0.01, do: 0.02, L: 0.01 }], Aref: PI * 0.006 ** 2 },
    // v2.3: a short cone whose narrow inlet faces a rod end face (exact value 29 % below the formula) and aligned ring
    // gaps across a short open tube (16 % above); the line-of-sight term of the band covers both
    coneRod: { items: [{ t: 'cone', d1: 0.02, d2: 0.03, L: 0.005 }, { t: 'annulus', di: 0.02, do: 0.03, L: 0.01 }], Aref: PI * 0.01 ** 2 },
    ringGapRing: { items: [{ t: 'annulus', di: 0.016, do: 0.02, L: 0.002 }, tube(0.02, 0.002), { t: 'annulus', di: 0.016, do: 0.02, L: 0.002 }], Aref: PI * (0.01 ** 2 - 0.008 ** 2) },
};

// Small-signal conductance (m^3/s) of the core of a compiled tube at pressure p.
function coreG(d, L, p, G) {
    const e = compileItem(tube(d, L), G);
    return edgeG({ k: 'core', kv: e.kv, Cm: e.Cm, s: e.s, Aout: e.Aout }, p, G);
}

function worstRatio(pairs) {
    let worst = 0;
    for (const [a, b] of pairs) { const d = a / b - 1; if (Math.abs(d) > Math.abs(worst)) worst = d; }
    return 1 + worst;
}

export const FORMULA_CASES = [
    formula({
        id: 'orifice-air', title: 'Thin orifice in air at 20 °C: conductance per cm²', source: SRC.leybold130, unit: 'L/s',
        ref: 11.57, tol: { rel: 0.001 }, refFrom: { file: 'v', path: ['orifice_thin', 'C_air20C_L_per_s_per_cm2'] },
        run: () => orificeC(gas('air'), 1e-4) * 1e3,
    }),
    ...Object.entries(MATUDA).map(([m, ref]) => formula({
        id: `tube-matuda-m${m}`, title: `Round tube, L/D = ${m}: transmission probability`, source: SRC.matuda,
        ref, tol: { rel: 0.001 }, refFrom: { file: 'v', path: ['tube_exact_m_eq_L_over_D', m] }, run: () => tubeAlpha(+m),
    })),
    ...JPCRD_SLOT.map(([x, ref]) => formula({
        id: `slot-jpcrd-${x}`, title: `Wide slot, L/h = ${x}: transmission probability`, source: SRC.jpcrd29,
        ref, tol: { rel: 0.0015 }, refFrom: { file: 'v', path: ['slot_L_over_h', 'jpcrd_table29_eq5.8', x] }, run: () => slotAlpha(+x),
    })),
    ...SB.map(([key, ba, l, ref]) => formula({
        id: `rect-sb-${ba}-${l}`, title: `Rectangular duct, b/a = ${ba}, L/a = ${l}`, source: SRC.sb,
        ref, tol: { rel: 0.002 }, refFrom: { file: 'v', path: ['rect_santeler_boeckmann_via_livesey_table2_6', key] }, run: () => rectAlpha(1, ba, l),
    })),
    ...COLE.map(([key, ba, l, ref]) => formula({
        id: `rect-cole-${ba}-${l}`, title: `Rectangular duct, b/a = ${ba}, L/a = ${l}`, source: SRC.cole,
        ref, tol: { rel: 0.012 }, refFrom: { file: 'v', path: ['rect_cole_via_livesey_table2_7', key] }, run: () => rectAlpha(1, ba, l),
    })),
    ...BERMAN_ANN.map(([key, e, l, ref]) => formula({
        id: `annulus-berman-${e}-${l}`, title: `Annulus, Ri/Ro = ${e}, L/(Ro − Ri) = ${l}`, source: SRC.bermanAnn,
        ref, tol: { rel: 0.003 }, refFrom: { file: 'v', path: ['annulus_berman_via_livesey_table2_9_Ri_over_Ro_l_over_gap', key] },
        run: () => annulusAlpha(e, 1, l * (1 - e)),
    })),
    ...NASA.map(([key, b, l, ref]) => formula({
        id: `cone-nasa-${b}-${l}`, title: `Diverging cone, half-angle ${b}°, L/R₁ = ${l}`, source: SRC.nasa,
        ref, tol: { rel: 0.006 }, refFrom: { file: 'v', path: ['cone_nasa_tnd2330_table1a_beta_deg_L_over_R1', key] },
        run: () => coneAlpha(1, coneR2(b, l), l),
    })),
    ...CONE_TPMC.map(([key, b, l, ref, sigma]) => formula({
        id: `cone-tpmc-${idNum(b)}-${l}`, title: `${b < 0 ? 'Converging' : 'Diverging'} cone, half-angle ${Math.abs(b)}°, L/R₁ = ${l}`, source: SRC.tpmc,
        ref, refSigma: sigma, tol: { sigmas: 3, plusRel: 0.004 },
        refFrom: { file: 'v', path: ['cone_this_work', key, 'alpha'], sigmaPath: ['cone_this_work', key, 'sigma'] },
        run: () => coneAlpha(1, coneR2(b, l), l),
    })),
    formula({
        id: 'cone-reciprocity', title: 'Cone reciprocity A₁α(R₁→R₂) − A₂α(R₂→R₁), half-angle −10°, L/R₁ = 4', source: SRC.identity,
        ref: 0, tol: { abs: 1e-12 },
        run: () => { const R2 = coneR2(-10, 4); return PI * coneAlpha(1, R2, 4) - PI * R2 * R2 * coneAlpha(R2, 1, 4); },
    }),
    ...ELBOW_TPMC.map(([key, A, B, ref, sigma]) => formula({
        id: `elbow-tpmc-${A}-${B}`, title: `90° mitered elbow, legs A = B = ${A}R`, source: SRC.tpmc,
        ref, refSigma: sigma, tol: { sigmas: 3, plusRel: 0.003 },
        refFrom: { file: 'v', path: ['tpmc_reference_cases_this_work', key, 'alpha'], sigmaPath: ['tpmc_reference_cases_this_work', key, 'sigma'] },
        run: () => elbowAlpha(1, A, B),
    })),
    formula({
        id: 'elbow-tpmc-2-5', title: '90° mitered elbow, legs A = 2R, B = 5R', source: SRC.tpmc,
        ref: ELBOW_ASYM.alpha, refSigma: ELBOW_ASYM.sigma, tol: { sigmas: 3, plusRel: 0.003 },
        refFrom: { file: 'v', path: ['elbow90_asym_this_work', ELBOW_ASYM.key, 0], sigmaPath: ['elbow90_asym_this_work', ELBOW_ASYM.key, 1] },
        run: () => elbowAlpha(1, ELBOW_ASYM.A, ELBOW_ASYM.B),
    }),
    formula({
        id: 'net-haefer-orifice-tube', title: 'Line: orifice r = 0.5R, then tube R, L = 8R (molecular)', source: SRC.haefer,
        ref: 0.53766, tol: { rel: 0.001 }, run: () => lineAlpha(LINES.orificeTube.items, LINES.orificeTube.Aref),
    }),
    formula({
        id: 'net-livesey-15-25-20', title: 'Line: tubes Ø15, Ø25, Ø20 mm with L/d = 2 (molecular)', source: SRC.liveseyHaefer,
        ref: 0.214, tol: { rel: 0.003 }, refFrom: { file: 'v', path: ['series_examples', 'livesey_haefer_15_25_20mm_l_over_d_2', 'alpha_haefer'] },
        run: () => lineAlpha(LINES.livesey.items, LINES.livesey.Aref),
    }),
    formula({
        id: 'net-livesey-pump', title: 'Pump 300 L/s on a tube Ø100 × 200 mm, air: effective speed S_n', source: SRC.liveseyPump, unit: 'L/s',
        ref: 188, tol: { rel: 0.005 }, refFrom: { file: 'v', path: ['series_examples', 'livesey_pump_S300_tube_d100_l200', 'S_n_oatley'] },
        run: () => molecularLimit([tube(0.1, 0.2), { t: 'pump', S: 0.3, d: 0.1, label: 'Pump' }], gas('air')).Seff * 1e3,
    }),
    formula({
        id: 'net-merge-elbow', title: 'Line: tube R + elbow (R, R) + tube R, merged into one elbow', source: SRC.tpmc,
        ref: 0.35147, refSigma: 0.00034, tol: { sigmas: 3, plusRel: 0.003 },
        refFrom: { file: 'v', path: ['tpmc_reference_cases_this_work', 'elbow90 R=1 A=B=2', 'alpha'], sigmaPath: ['tpmc_reference_cases_this_work', 'elbow90 R=1 A=B=2', 'sigma'] },
        run: () => lineAlpha([tube(0.02, 0.01), { t: 'elbow', d: 0.02, A: 0.01, B: 0.01 }, tube(0.02, 0.01)], PI * 0.01 ** 2),
    }),
    ...[
        ['orifice-tube', 'orifice r = 0.5R + tube L = 8R', LINES.orificeTube, ['tpmc_reference_cases_this_work', 'orifice r=0.5 + tube R=1 L=8', 'alpha'], 0.54546],
        ['tube-plate-tube', 'tube | plate r = 0.5R | tube', LINES.tubePlateTube, ['tpmc_reference_cases_this_work', 'tube R1 L1 | plate r0.5 | tube R1 L1', 'alpha'], 0.21433],
        ['livesey', 'Livesey 15/25/20 mm', LINES.livesey, ['series_examples', 'livesey_haefer_15_25_20mm_l_over_d_2', 'alpha_tpmc_this_work', 0], 0.22678],
        ['tube-rod-tube', 'tube | annulus with a rod of 0.8 R_o | tube, each L = R/2', LINES.tubeRodTube, null, 0.148202],
        ['orifice-rod', 'orifice r = 0.6 R_o, then an annulus with a rod of 0.5 R_o (partial overlap)', LINES.orificeRod, null, 0.252341],
        ['cone-rod', 'cone Ø20 → Ø30 mm over 5 mm, then an annulus whose Ø20 mm rod faces the narrow inlet', LINES.coneRod, null, 0.342351],
        ['ring-gap-ring', 'annulus 16/20 mm | open tube Ø20 mm | annulus 16/20 mm, each 2 mm long (aligned gaps)', LINES.ringGapRing, null, 0.446100],
    ].map(([id, what, line, path, ref]) => formula({
        id: `band-covers-${id}`, title: `Error band covers the Monte Carlo value: ${what}`, source: path ? SRC.tpmc : SRC.chainMc,
        ref, tol: { band: true }, refFrom: path ? { file: 'v', path } : null,
        run: () => {
            const G = gas('air'), net = buildNetwork(line.items, G), b = errorBand(net, false);
            return { value: lineAlpha(line.items, line.Aref, G), band: { lo: b.lo, hi: b.hi } };
        },
    })),
    ...[['d1', 1, '1.0'], ['d10', 10, '10.0']].map(([id, delta, key]) => formula({
        id: `gp-sharipov-${id}`, title: `Long tube (L = 10⁵ R) core at δ = ${delta}: reduced flow rate G_P`, source: SRC.cern,
        ref: GP_TABLE[key], tol: { rel: 0.001 }, refFrom: { file: 'v', path: ['transitional', 'sharipov_GP_long_tube', key] },
        run: () => {
            const G = gas('air'), a = 1e-3, L = 1e5 * a, p = delta * G.eta * G.vm / a;
            return coreG(2 * a, L, p, G) * 2 * L / (PI * a ** 3 * G.vm);
        },
    })),
    ...GP_OFFNODE.map(([key, delta, ref]) => formula({
        id: `gp-offnode-${key}`, title: `Long tube core between the table nodes, δ = ${key}: reduced flow rate G_P`, source: SRC.jpcrd7,
        ref, tol: { rel: 0.003 },
        run: () => {
            const G = gas('air'), a = 1e-3, L = 1e5 * a, p = delta * G.eta * G.vm / a;
            return coreG(2 * a, L, p, G) * 2 * L / (PI * a ** 3 * G.vm);
        },
    })),
    ...GP_CHANNEL.map(([key, delta, ref]) => formula({
        id: `slit-channel-${key}`, title: `Slit 0.1 × 100 mm, 100 mm deep (L/h = 1000) at δ = ${key}: plane-channel flow rate G_P`, source: SRC.jpcrd3,
        ref, tol: { rel: 0.01 },
        run: () => {
            const h = 1e-4, w = 0.1, L = 0.1, G = gas('air'), p = delta * G.eta * G.vm / h;
            const y = sweep({ items: [{ t: 'slit', h, w, L }], gas: { id: 'air', T: T20, custom: null }, Cd: null, bc: { mode: 'dp', p0: 2 * p, p1: p } },
                'C', { n: 1, pMin: p, pMax: p }).y[0];
            return y * 2 * L / (w * h * h * G.vm);
        },
    })),
    formula({
        id: 'gp-sharipov-slip200', title: 'G_P(200) against the slip limit δ/4 + 1.018', source: SRC.cern,
        ref: 200 / 4 + 1.018, tol: { rel: 0.001 }, refFrom: { file: 'v', path: ['transitional', 'sharipov_GP_long_tube', 'hydrodynamic'], text: 'delta/4 + 1.018' },
        run: () => GP(200),
    }),
    ...FU.map(([key, delta, ref]) => formula({
        id: `orifice-fu-${key}`, title: `Orifice into vacuum, N₂, δ = ${key}: reduced flow W`, source: SRC.fu,
        ref, tol: { rel: 0.045 }, refFrom: { file: 'v', path: ['transitional', 'orifice_into_vacuum_fujimoto_usami_W', key] },
        run: () => {
            const G = gas('N2'), a = 1e-3, p0 = delta * G.eta * G.vm / a;
            const r = analyze({ items: [orif(2 * a)], gas: { id: 'N2', T: T20, custom: null }, Cd: null, bc: { mode: 'dp', p0, p1: p0 * 1e-9 } });
            if (!r.ok) throw new Error(r.errors[0].message);
            return r.Q / (PI * a * a * G.vbar / 4 * p0);
        },
    })),
    ...LIEPMANN.map(([id, ref]) => formula({
        id: `orifice-liepmann-${id}`, title: `Orifice into vacuum at 1 bar, ${id}: continuum flow W`, source: SRC.liepmann,
        ref, tol: { rel: 0.005 }, refFrom: { file: 'v', path: ['transitional', 'orifice_hydrodynamic_liepmann_W', id] },
        run: () => {
            const G = gas(id), a = 1e-3, p0 = 1e5;
            const r = analyze({ items: [orif(2 * a)], gas: { id, T: T20, custom: null }, Cd: null, bc: { mode: 'dp', p0, p1: 1 } });
            if (!r.ok) throw new Error(r.errors[0].message);
            return r.Q / (PI * a * a * G.vbar / 4 * p0);
        },
    })),
    formula({
        id: 'poiseuille-air', title: 'Tube Ø1 cm × 100 cm in air at a mean 1000 mbar: viscous core conductance', source: SRC.leybold126, unit: 'L/s',
        ref: 135 * 1 ** 4 * 1000 / 100, tol: { rel: 0.006 }, refFrom: { file: 'v', path: ['viscous', 'poiseuille_air20C'], text: '135 d^4 pbar / l' },
        run: () => coreG(0.01, 1, 1e5, gas('air')) * 1e3,
    }),
    formula({
        id: 'square-duct-kv', title: 'Square duct: laminar coefficient kv η L / a⁴', source: SRC.wong,
        ref: 0.035144, tol: { rel: 1e-4 }, refFrom: { file: 'v', path: ['viscous', 'square_duct'], text: '0.035144 a^4' },
        run: () => { const G = gas('air'), a = 0.01, L = 0.1; return compileItem({ t: 'rect', a, b: a, L }, G).kv * G.eta * L / a ** 4; },
    }),
    (() => {
        const G = gas('air'), R = 0.005, L = 0.005, pm = 1e5;
        return formula({
            id: 'short-tube-end-correction', title: 'Short tube L = R in air at 1 bar: small-signal conductance', source: SRC.jpcrd516, unit: 'L/s',
            ref: PI * R ** 4 * pm / (8 * G.eta * (L + 3 * PI * R / 8)) * 1e3, tol: { rel: 0.001 },
            refFrom: { file: 'v', path: ['transitional', 'short_tube_hydrodynamic'], text: 'L/(L + 3*pi/8)' },
            run: () => sweep({ items: [tube(2 * R, L)], gas: { id: 'air', T: T20, custom: null }, Cd: null, bc: { mode: 'dp', p0: pm, p1: 0.5 * pm } },
                'C', { n: 1, pMin: pm, pMax: pm }).y[0] * 1e3,
        });
    })(),
    formula({
        id: 'berman-slot-crosscheck', title: 'Berman slot formula against the slot table, L/h = 1 to 10 (largest ratio)', source: SRC.berman,
        ref: 1, tol: { rel: 0.002 },
        run: () => worstRatio([1, 1.5, 2, 3, 5, 7, 10].map((x) => [bermanSlotAlpha(x), slotAlpha(x)])),
    }),
    formula({
        id: 'berman-annulus-crosscheck', title: 'Berman annulus fit against the annulus table at the 8 Berman points (largest ratio)', source: SRC.berman,
        ref: 1, tol: { rel: 0.017 },
        run: () => worstRatio(BERMAN_ANN.map(([, e, l]) => [bermanAnnulusAlpha(e, 1, l * (1 - e)), annulusAlpha(e, 1, l * (1 - e))])),
    }),
    // ---- negative controls: deliberately wrong methods that must be caught
    formula({
        id: 'neg-dushman', group: 'negative', title: 'Dushman 1/(1 + 3L/8R) at L/R = 4 (wrong formula)', source: SRC.matuda,
        ref: 0.3565727, catchRel: 0.05, tol: { catchRel: 0.05 }, refFrom: { file: 't', path: ['TUBE_IE', 'alpha', 10] },
        run: () => 1 / (1 + 3 * 4 / 8),
    }),
    formula({
        id: 'neg-oatley-elbow', group: 'negative', title: 'Plain Oatley rule for an elbow with legs A = B = R (no κ)', source: SRC.tpmc,
        ref: 0.54176, catchRel: 0.03, tol: { catchRel: 0.03 },
        refFrom: { file: 'v', path: ['tpmc_reference_cases_this_work', 'elbow90 R=1 A=B=1', 'alpha'] },
        run: () => 1 / (2 / tubeAlpha(0.5) - 1),
    }),
    formula({
        id: 'neg-simple-sum', group: 'negative', title: 'Simple sum C_visc + C_mol for a long tube at δ = 1', source: SRC.cern,
        ref: 1.4758, catchRel: 0.10, tol: { catchRel: 0.10 }, refFrom: { file: 'v', path: ['transitional', 'sharipov_GP_long_tube', '1.0'] },
        run: () => 1 / 4 + G0,
    }),
];
