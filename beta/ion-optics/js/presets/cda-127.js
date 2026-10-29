/* ==========================================================================
   Ion optics presets: cda-127.js
   P5 127° cylindrical deflector (spec §4.14). Between coaxial cylinders the
   potential is logarithmic, V(r) = 2(E_p/q)·ln(r/r₀) for a central orbit of
   radius r₀ at pass energy E_p, and the radial motion refocuses after
   π/√2 = 127.28° (Hughes & Rojansky, Phys. Rev. 34, 284 (1929)). Faces at
   r = 40 and 60 mm around r₀ = 50 mm; for 100 eV singly charged positive
   ions the inner electrode is at −44.629 V and the outer at +36.464 V.
   Grounded shields with 2 mm slits sit 4° before and after the sectors; the
   source is 2 mm before the entrance on the entrance tangent line. The
   ideal energy dispersion at the exit is r₀/100 = 0.50 mm per 1 %.
   ========================================================================== */
import { newProject } from '../engine/schema.js';

const DEG = Math.PI / 180;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
/** Two points on the ray at angle `deg` from the origin, at radii r0 and r1. */
const ray = (deg, r0, r1) => [[r6(r0 * Math.cos(deg * DEG)), r6(r0 * Math.sin(deg * DEG))], [r6(r1 * Math.cos(deg * DEG)), r6(r1 * Math.sin(deg * DEG))]];
const PHI = 127.28;

function build() {
    const p = newProject('planar2d');
    p.meta = {
        ...p.meta, name: '127° cylindrical deflector', preset: 'cda-127',
        notes: 'Two cylindrical sector electrodes (faces at r = 40 and 60 mm, 127.28 degrees) bend ions of the pass energy Ep around the '
            + 'central radius r0 = 50 mm. The voltages follow V(r) = 2 Ep ln(r/r0) per unit charge: -44.63 V inside and +36.46 V outside for Ep = 100 eV. '
            + 'A sector of 127.28 degrees (180/sqrt(2)) refocuses rays that leave a point at slightly different angles.\n'
            + 'Ions of m/z 100 start 2 mm before the entrance in a fan of ±2 degrees at 99, 100 and 101 eV. Grounded shields with 2 mm slits '
            + 'stand 4 degrees before and after the sectors. The weaker field at the entrance edge moves the orbits up to about 1 mm outward, '
            + 'so the 101 eV rays launched at 0, +1 and +2 degrees strike the exit shield just outside the slit. '
            + 'The detector lies on the 140 degree ray. Change Ep to select another energy.\n'
            + 'Rays that pass close to the slit edges cross grid cells cut by the shields, where the field is only first-order accurate; the Summary tab '
            + 'flags several of them with energy errors between 1e-5 and 5e-4 of their energy. A smaller cell reduces this.',
    };
    p.params = [{ name: 'Ep', value: 100, dim: 'energy', note: 'pass energy of the central orbit (eV per unit charge)', slider: { min: 50, max: 150, step: 0.5 } }];
    p.domain = {
        type: 'planar2d', cell: 0.5, x: [-70, 70], y: [-30, 70],
        edges: { xmin: { bc: 'dirichlet', electrode: 'gnd' }, xmax: { bc: 'dirichlet', electrode: 'gnd' }, ymin: { bc: 'dirichlet', electrode: 'gnd' }, ymax: { bc: 'dirichlet', electrode: 'gnd' } },
        mirror: { x: false, y: false }, beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' },
    };
    p.electrodes = [
        { id: 'gnd', name: 'Ground', ground: true, color: '#64748b' },
        { id: 'inner', name: 'Inner electrode', kind: 'solid', v: '2*Ep*ln(40/50)', wave: null, color: '#2563eb' },
        { id: 'outer', name: 'Outer electrode', kind: 'solid', v: '2*Ep*ln(60/50)', wave: null, color: '#ea580c' },
    ];
    p.shapes = [
        { id: 's1', type: 'annulus', electrode: 'inner', cx: 0, cy: 0, rIn: 38, rOut: 40, a0: 0, a1: PHI },
        { id: 's2', type: 'annulus', electrode: 'outer', cx: 0, cy: 0, rIn: 60, rOut: 62, a0: 0, a1: PHI },
        { id: 's3', type: 'polyline', electrode: 'gnd', name: 'Entrance shield (inner)', points: ray(-4, 34, 49) },
        { id: 's4', type: 'polyline', electrode: 'gnd', name: 'Entrance shield (outer)', points: ray(-4, 51, 66) },
        { id: 's5', type: 'polyline', electrode: 'gnd', name: 'Exit shield (inner)', points: ray(PHI + 4, 34, 49) },
        { id: 's6', type: 'polyline', electrode: 'gnd', name: 'Exit shield (outer)', points: ray(PHI + 4, 51, 66) },
    ];
    p.magnets = [];
    p.idealFields = [];
    p.sources = [{
        id: 'b1', name: 'Fan ±2°, 99–101 eV', enabled: true, color: 'auto', count: 15, sampling: 'grid', seed: 1,
        species: [{ label: 'm/z 100', mass: 100, charge: 1, fraction: 1 }],
        position: { type: 'point', p: [50, -2, 0] }, direction: { type: 'fan', axis: [0, 1, 0], normal: [0, 0, 1], from: -2, to: 2, n: 5 },
        energy: { type: 'list', values: [99, 100, 101] }, time: { type: 'fixed', t: 0 },
    }];
    const det = ray(140, 40, 60);
    p.recording = {
        planes: [{ id: 'det', name: 'Detector (140° ray)', kind: 'segment', p0: det[0], p1: det[1], limits: null, radius: null, terminate: true, side: 'both', record: 'first' }],
        trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null,
    };
    p.view = { ...p.view, center: [0, 20], scale: 4.5,
        layers: { ...p.view.layers, trajectories: 'energy' } };
    return p;
}

export default Object.freeze({
    id: 'cda-127',
    title: '127° cylindrical deflector',
    order: 50,
    domainType: 'planar2d',
    tags: ['analyzer'],
    blurb: 'Coaxial sector electrodes bend 100 eV ions round a 50 mm orbit and refocus them after 127°.',
    tryThis: 'Change the pass energy Ep and watch which of the three energies passes the exit slit.',
    build,
    expect: Object.freeze([
        { id: 'field', label: '|E| at mid-sector on r₀ (22.20, 44.80)', metric: 'fieldMagnitude', at: [22.20, 44.80], target: 4.000, tol: 0.01, unit: 'V/mm', check: 4.0000, measured: 4.000064,
            note: 'At the entrance edge (50, 0) it is only 1.71 V/mm.' },
        { id: 'orbit', label: '100 eV central ray radius from 10° to 117°', metric: 'radiusRange', select: { energy: 100, dir: 'center' }, center: [0, 0], angles: [10, 117],
            min: 49.5, max: 52.0, unit: 'mm', check: [50.13, 51.22], measured: [50.10228, 51.09296], note: 'The weaker entrance fringe field starts a small radial oscillation.' },
        { id: 'focus', label: 'Crossing of the ±2° rays (100 eV)', metric: 'fanCrossing', select: [{ energy: 100, dir: 'min' }, { energy: 100, dir: 'max' }], center: [0, 0], angles: [30, 139],
            target: 120.5, tol: 2.5, unit: '°', check: 120.47, measured: 121.0007, note: 'Sharp-edge estimate 124° for an object 2 mm before the field.' },
        { id: 'dispersion', label: 'Energy dispersion at the detector (99 → 100 eV central rays)', metric: 'dispersion', plane: 'det', coord: 'r', center: [0, 0],
            a: { energy: 99, dir: 'center' }, b: { energy: 100, dir: 'center' }, target: 0.52, tol: 0.05, unit: 'mm per 1 %', check: 0.517, measured: 0.5225973,
            note: 'Ideal 0.50 at the exit face. The 101 eV central ray hits the exit shield (slit r 49–51 mm), so the 99 and 100 eV rays are used.' },
    ]),
    guide: null,
});
