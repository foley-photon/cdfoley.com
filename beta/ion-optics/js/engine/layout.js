/* ==========================================================================
   Ion optics engine: layout.js
   Typed-array row layouts shared by the particle generator, the tracer, the
   analysis functions, the worker protocol and the results UI. Rows are stored
   struct-of-rows in Float64Array (stride constants below) so that a whole run
   moves between threads as a few transferable ArrayBuffers.

   No physics here; the layout is part of the engine contract (bump
   ENGINE_VERSION in version.js when it changes).
   ========================================================================== */

// Particle rows (Float64Array). P_WX..P_WZ hold the proper velocity γv (= v if nonrelativistic).
export const P_STRIDE = 16, P_ID = 0, P_SRC = 1, P_SPECIES = 2, P_MASS = 3, P_CHARGE = 4, P_T0 = 5, P_X = 6, P_Y = 7, P_Z = 8,
    P_WX = 9, P_WY = 10, P_WZ = 11, P_KE = 12, P_C0 = 13, P_C1 = 14, P_C2 = 15;   // class indices: position, direction, energy; −1 random

// Summary rows, one per particle (Float64Array).
export const S_STRIDE = 24, S_ID = 0, S_STATUS = 1, S_WHERE = 2, S_T = 3, S_X = 4, S_Y = 5, S_Z = 6, S_VX = 7, S_VY = 8, S_VZ = 9,
    S_KE = 10, S_TOF = 11, S_STEPS = 12, S_PATH = 13,
    S_DE_END = 14,   // eV, (KE + qφ)end − (KE + qφ)start; NaN if time-dependent or outside
    S_DE_MAX = 15,   // eV, max |(KE + qφ) − start| over step ends (static fields)
    S_WORK = 16,     // eV, Σ|ΔKE − W| over steps, W = work done by E along the step
    S_NCROSS = 17, S_TBAND = 18 /* µs in BOUNDARY cells */, S_FLAGS = 19,
    S_SRC = 20, S_SPECIES = 21, S_KE0 = 22, S_T0 = 23;

// Crossing rows: planes and mesh crossings (Float64Array).
export const C_STRIDE = 14, C_ID = 0, C_PLANE = 1 /* −1 mesh */, C_T = 2, C_X = 3, C_Y = 4, C_Z = 5, C_VX = 6, C_VY = 7, C_VZ = 8,
    C_KE = 9, C_DIR = 10, C_K = 11 /* crossing count, 1-based */, C_KIND = 12 /* 0 plane, 1 mesh */, C_ELEC = 13;

// Markers: Float32Array stride 5 (id, t, x, y, z). Trajectories: offsets Uint32Array(n+1), pts Float32Array (x, y, z, t).
export const M_STRIDE = 5, T_STRIDE = 4;

export const STATUS = Object.freeze({ FLYING: 0, HIT: 1, DETECTED: 2, EXIT: 3, TMAX: 4, STEPS: 5, ABSORBED: 6, DRIFT_END: 7, NUM_ERROR: 8, BORN_INSIDE: 9, CANCELLED: 10 });
export const STATUS_NAMES = Object.freeze(['FLYING', 'HIT', 'DETECTED', 'EXIT', 'TMAX', 'STEPS', 'ABSORBED', 'DRIFT_END', 'NUM_ERROR', 'BORN_INSIDE', 'CANCELLED']);
// S_WHERE: HIT/ABSORBED → electrode index; DETECTED → plane index; EXIT/DRIFT_END → EDGE code; otherwise −1.
export const EDGE = Object.freeze({ XMIN: 0, XMAX: 1, YMIN: 2, YMAX: 3, ZMIN: 4, ZMAX: 5, RMAX: 6, DRIFT_LIMIT: 7 });
export const EDGE_NAMES = Object.freeze(['XMIN', 'XMAX', 'YMIN', 'YMAX', 'ZMIN', 'ZMAX', 'RMAX', 'DRIFT_LIMIT']);
export const FLAG = Object.freeze({ RELATIVISTIC: 1, ENTERED_BOUNDARY: 2, ENERGY_WARN: 4, TD_FIELDS: 8, BORIS: 16, STEP_FLOOR: 32 });
