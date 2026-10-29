/* ==========================================================================
   Ion optics presets: index.js
   The preset registry (spec §4.14). Each preset module exports
   default { id, title, order, domainType, tags, blurb, tryThis,
   build() → Project, expect: Check[], guide: GuideSpec | null }.
   Presets are plain JavaScript builders (no fetch), so Node tests, the
   benchmark worker and the page load them the same way. Dimensions are our
   own choices for generic device types.

   Check (data interpreted by _tests/ionoptics/wp6-presets.test.mjs):
     { id, label, metric, …metric arguments,
       set?: { params?, electrodes?, shapes?: { id: patch }, add?: { electrodes?, shapes? } },
       target?, tol?, rel?, min?, max?, unit?, check (design-phase value),
       measured (re-measured on the integrated engine), note?, source? }
   A `set` that changes the geometry must raise no geometry warnings.
   GuideSpec (panels/guide.js):
     { id, title, steps: [{ target: '<data-guide value>', title, text,
       open?: { rail?: tab, dock?: tab } }] }
   ========================================================================== */
import einzel from './einzel.js';
import twoTube from './two-tube.js';
import apertureLens from './aperture-lens.js';
import plateMirror from './plate-mirror.js';
import cda127 from './cda-127.js';
import hemisphere from './hemisphere.js';
import reflectron from './reflectron.js';
import rfQuadrupole from './rf-quadrupole.js';
import paulTrap from './paul-trap.js';
import magneticSector from './magnetic-sector.js';
import vmi from './vmi.js';

/** Every preset, in gallery order. */
export const PRESETS = Object.freeze([einzel, twoTube, apertureLens, plateMirror, cda127, hemisphere, reflectron, rfQuadrupole, paulTrap, magneticSector, vmi]
    .slice().sort((a, b) => a.order - b.order));

/** Gallery filter groups: tag → label (a preset may carry several tags). */
export const TAGS = Object.freeze({
    lens: 'Lenses', mirror: 'Mirrors', analyzer: 'Energy analyzers', tof: 'Time of flight', rf: 'RF devices', magnetic: 'Magnetic', imaging: 'Imaging',
});

/** The default preset (loaded on a first visit). */
export const DEFAULT_PRESET = 'einzel';

/**
 * The preset with this id, or null.
 * @param {string} id
 * @returns {object|null}
 */
export function presetById(id) {
    for (const p of PRESETS) if (p.id === id) return p;
    return null;
}
