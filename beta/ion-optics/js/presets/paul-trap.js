/* ==========================================================================
   Ion optics presets: paul-trap.js
   P9 Paul trap (spec §4.14): a hyperbolic ring (r₀ = 7.07 mm) and grounded
   end caps (z₀ = 5 mm, r₀² = 2z₀²) with 500 V at 1.0 MHz on the ring. The
   axial motion obeys Mathieu's equation with q_z = 8qV/(m(r₀² + 2z₀²)Ω²)
   (Paul, Rev. Mod. Phys. 62, 531 (1990)); motion is stable for q_z < 0.908,
   so the low-mass cut-off is 107.7 u: m/z 120 (q_z 0.815, amplification at
   most 5.15 over 200 cycles) stays trapped and m/z 100 (q_z 0.978) is lost.
   Cylindrical domain with a mirror plane at the trap center; the ring is
   clipped half a millimeter below the grounded outer wall so the two never
   touch.
   ========================================================================== */
import { newProject } from '../engine/schema.js';

function build() {
    const p = newProject('cyl2d');
    p.meta = {
        ...p.meta, name: 'Paul trap', preset: 'paul-trap',
        notes: 'A three-dimensional RF ion trap: a ring electrode and two end caps with hyperbolic faces (ring radius r0 = 7.07 mm, end-cap '
            + 'half-distance z0 = 5 mm). The trap axis is x; one half is solved and the other follows by mirror symmetry. The ring carries 500 V '
            + 'at 1.0 MHz and the end caps are grounded.\n'
            + 'One hundred ions (m/z 120 and 100, 0.05 eV, random directions and RF phases) start near the center. Masses below the low-mass '
            + 'cut-off of about 108 have unstable orbits and leave within a few cycles; m/z 120 stays trapped for the whole 200 microseconds.\n'
            + 'Try lowering the RF amplitude to trap m/z 100 as well, or color the paths by time.',
    };
    p.params = [{ name: 'Vrf', value: 500, dim: 'voltage', note: 'RF amplitude on the ring', slider: { min: 100, max: 800, step: 1 } }];
    p.domain = {
        type: 'cyl2d', cell: 0.1, x: [0, 15], y: [0, 15],
        edges: { xmin: { bc: 'neumann' }, xmax: { bc: 'dirichlet', electrode: 'gnd' }, ymin: { bc: 'axis' }, ymax: { bc: 'dirichlet', electrode: 'gnd' } },
        mirror: { x: true, y: false }, beyond: { xmin: 'stop', xmax: 'stop', ymin: 'stop', ymax: 'stop' },
    };
    p.electrodes = [
        { id: 'gnd', name: 'Ground (end caps)', ground: true, color: '#64748b' },
        { id: 'ring', name: 'Ring', kind: 'solid', v: 0, wave: { terms: [{ type: 'cos', amp: 'Vrf', freq: 1.0, phase: 0 }] }, color: '#2563eb' },
    ];
    p.shapes = [
        { id: 's1', type: 'quadric', electrode: 'ring', name: 'Ring (hyperbolic)', A: -2, B: 1, C: 49.985, cx: 0, cy: 0, clip: [0, 15, 0, 14.5] },
        { id: 's2', type: 'quadric', electrode: 'gnd', name: 'End cap (hyperbolic)', A: 2, B: -1, C: 50, cx: 0, cy: 0, clip: [0, 15, 0, 15] },
    ];
    p.magnets = [];
    p.idealFields = [];
    p.sources = [{
        id: 'b1', name: 'Ions m/z 120 and 100', enabled: true, color: 'auto', count: 100, sampling: 'random', seed: 1,
        species: [{ label: 'm/z 120', mass: 120, charge: 1, fraction: 1 }, { label: 'm/z 100', mass: 100, charge: 1, fraction: 1 }],
        position: { type: 'gaussian', center: [0, 0, 0], sigma: [0.2, 0.2, 0.2] }, direction: { type: 'isotropic', axis: [1, 0, 0], beta: 0 },
        energy: { type: 'mono', ke: 0.05 }, time: { type: 'rfPhase', freq: 1.0 },
    }];
    p.recording = { planes: [], trajectories: { store: true, maxPoints: 2000 }, timeMarkers: null };
    p.tracer = { ...p.tracer, tMax: 200 };
    p.view = { ...p.view, center: [0, 0], scale: 14,
        layers: { ...p.view.layers, trajectories: 'species' } };
    return p;
}

export default Object.freeze({
    id: 'paul-trap',
    title: 'Paul trap',
    order: 90,
    domainType: 'cyl2d',
    tags: ['rf'],
    blurb: 'A ring and two end caps with 500 V of RF trap m/z 120 and eject m/z 100.',
    tryThis: 'Lower Vrf until m/z 100 is trapped too; the low-mass cut-off scales with the RF amplitude.',
    build,
    expect: Object.freeze([
        { id: 'trapped120', label: 'm/z 120 still trapped after 200 µs', metric: 'statusFraction', status: ['TMAX'], species: 'm/z 120', min: 0.95, check: null, measured: 1 },
        { id: 'lost100', label: 'm/z 100 lost (hit an electrode or left)', metric: 'statusFraction', status: ['HIT', 'EXIT'], species: 'm/z 100', min: 0.95, check: null, measured: 1 },
    ]),
    guide: null,
});
