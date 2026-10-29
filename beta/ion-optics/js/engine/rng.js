/* ==========================================================================
   Ion optics engine: rng.js
   Counter-based random numbers: every number is a pure function of
   (seed, a, b, c), so results never depend on batching, chunking or the
   number of workers.

   Generator: Philox-4x32-10, Salmon, Moraes, Dror & Shaw, "Parallel random
   numbers: as easy as 1, 2, 3", Proc. SC11 (2011). Counter = (a, b, c, lane),
   key = (seed mod 2^32, floor(seed / 2^32)). Normal deviates by the
   Box-Muller transform, Box & Muller, Ann. Math. Stat. 29, 610 (1958).

   Stream numbering used by the engine: a = source index, b = particle index,
   c = 0 species, 1-3 position, 4-6 direction, 7 energy, 8 time;
   mesh transmission rolls use a = 0x7f4a7c15, b = particle id, c = crossing.
   Fixed draws use lane 0; Stream objects (for rejection sampling) use lane >= 1.
   ========================================================================== */

const M0 = 0xD2511F53, M1 = 0xCD9E8D57, W0 = 0x9E3779B9, W1 = 0xBB67AE85;
const TWO32 = 4294967296, INV53 = 1 / 9007199254740992, TWO_PI = 2 * Math.PI;

// Output block of the last Philox call (module scratch, single-threaded).
let o0 = 0, o1 = 0, o2 = 0, o3 = 0;

/** High 32 bits of the 64-bit product of two uint32 values. */
function mulhi(a, b) {
    const al = a & 0xffff, ah = a >>> 16, bl = b & 0xffff, bh = b >>> 16;
    const ll = al * bl, lh = al * bh, hl = ah * bl, hh = ah * bh;
    const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
    return (hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) >>> 0;
}

/** Philox-4x32-10 block; result in o0..o3. */
function philox(k0, k1, c0, c1, c2, c3) {
    for (let r = 0; r < 10; r++) {
        const lo0 = Math.imul(M0, c0) >>> 0, hi0 = mulhi(M0, c0);
        const lo1 = Math.imul(M1, c2) >>> 0, hi1 = mulhi(M1, c2);
        c0 = (hi1 ^ c1 ^ k0) >>> 0; c1 = lo1; c2 = (hi0 ^ c3 ^ k1) >>> 0; c3 = lo0;
        k0 = (k0 + W0) >>> 0; k1 = (k1 + W1) >>> 0;
    }
    o0 = c0; o1 = c1; o2 = c2; o3 = c3;
}

function block(seed, a, b, c, lane) {
    const s = +seed || 0;
    philox(s >>> 0, Math.floor(s / TWO32) >>> 0, a >>> 0, b >>> 0, c >>> 0, lane >>> 0);
}

/**
 * Raw Philox-4x32-10 block (for known-answer tests): counter (c0..c3), key (k0, k1).
 * @returns {number[]} four uint32 words
 */
export function philox4x32(c0, c1, c2, c3, k0, k1) {
    philox(k0 >>> 0, k1 >>> 0, c0 >>> 0, c1 >>> 0, c2 >>> 0, c3 >>> 0);
    return [o0, o1, o2, o3];
}

/** 32-bit hash of (seed, a, b, c). @returns {number} uint32 */
export function hash32(seed, a, b, c) {
    block(seed, a, b, c, 0);
    return o0;
}

/** Uniform deviate in [0, 1) with 53 random bits. @returns {number} */
export function uniform01(seed, a, b, c) {
    block(seed, a, b, c, 0);
    return ((o0 >>> 5) * 67108864 + (o1 >>> 6)) * INV53;
}

/** Standard normal deviate (Box-Muller, cosine branch) from one Philox block. @returns {number} */
export function normal01(seed, a, b, c) {
    block(seed, a, b, c, 0);
    return boxMuller();
}

function boxMuller() {
    const u1 = ((o0 >>> 5) * 67108864 + (o1 >>> 6)) * INV53;
    const u2 = ((o2 >>> 5) * 67108864 + (o3 >>> 6)) * INV53;
    return Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(TWO_PI * u2);   // 1 − u1 ∈ (0, 1]
}

/**
 * Sequence of deviates for one (seed, a, b): draw n uses counter (a, b, n, lane).
 * Used where a variable number of draws is needed (rejection sampling); lane ≥ 1
 * keeps it disjoint from the fixed draws (lane 0).
 */
export class Stream {
    /** @param {number} seed @param {number} a @param {number} b @param {number} [lane=1] */
    constructor(seed, a, b, lane = 1) {
        this.seed = +seed || 0; this.a = a >>> 0; this.b = b >>> 0; this.lane = Math.max(1, lane >>> 0); this.n = 0;
    }
    /** @returns {number} uniform in [0, 1) */
    next() {
        block(this.seed, this.a, this.b, this.n++, this.lane);
        return ((o0 >>> 5) * 67108864 + (o1 >>> 6)) * INV53;
    }
    /** @returns {number} standard normal */
    normal() {
        block(this.seed, this.a, this.b, this.n++, this.lane);
        return boxMuller();
    }
}
