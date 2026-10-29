// Random numbers and direction samplers for the test-particle Monte Carlo (spec §3.6.1).
// Clean-room implementation from the open literature:
//   - xoshiro128** : D. Blackman and S. Vigna, "Scrambled linear pseudorandom number generators",
//     ACM Trans. Math. Softw. 47 (2021); preprint 2018.
//   - splitmix32 finalizer (the 32-bit variant of Steele, Lea and Flood's SplitMix) to fill the 128-bit state.
//   - Cosine (Lambert) directions by normalizing n + u, with u uniform on the unit sphere.
// Pure module: no DOM, runs in the page, in workers and in Node (H7, H8).

const TWO_PI = 2 * Math.PI;
const INV_2_32 = 1 / 4294967296;
const GOLDEN = 0x9E3779B9;

/** splitmix32 step: mix32(v) = finalize(v + 0x9E3779B9), as an unsigned 32-bit integer (§3.6.1). */
export function mix32(v) {
  let z = (v + GOLDEN) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85EBCA6B);
  z = Math.imul(z ^ (z >>> 13), 0xC2B2AE35);
  return (z ^ (z >>> 16)) >>> 0;
}

/** splitmix32 generator: returns () => uint32. The first output is mix32(seed). */
export function splitmix32(seed) {
  let x = seed >>> 0;
  return function next() {
    const out = mix32(x);
    x = (x + GOLDEN) >>> 0;
    return out;
  };
}

/**
 * xoshiro128** seeded from a 32-bit seed through splitmix32.
 * Returns rng() → (x >>> 0)·2⁻³² ∈ [0, 1). rng.u32() returns the next raw unsigned 32-bit output.
 */
export function makeRng(seed) {
  const sm = splitmix32(seed);
  let a = sm(), b = sm(), c = sm(), d = sm();
  if ((a | b | c | d) === 0) a = 1;
  function u32() {
    const m = Math.imul(b, 5);
    const r = Math.imul((m << 7) | (m >>> 25), 9) >>> 0;
    const t = b << 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21);
    return r;
  }
  function rng() {
    const m = Math.imul(b, 5);
    const r = Math.imul((m << 7) | (m >>> 25), 9) >>> 0;
    const t = b << 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21);
    return r * INV_2_32;
  }
  rng.u32 = u32;
  return rng;
}

/** Integer in [0, n) from an rng() (n ≤ 2³²). Used by property tests. */
export function randInt(rng, n) {
  return Math.floor(rng() * n);
}

/** Source key of a launch: a port index for mesh jobs; 0 for 'in' and 1 for 'out' for chain jobs. */
export function sourceKeyOf(source) {
  if (source === 'in') return 0;
  if (source === 'out') return 1;
  return source | 0;
}

/**
 * Seed of one batch (§3.6.1): depends only on (jobSeed, sourceKey, seq), so a batch gives the same counts
 * whichever worker runs it. Never 0.
 *
 * Deviation from the formula printed in §3.6.1 (recorded in the WP2 report): that formula XORs two hashed terms,
 * so different (sourceKey, seq) pairs collide at the birthday rate (72 to 224 collisions measured over 10⁶ pairs
 * spread over 2 to 1000 sources). Here sourceKey (12 bits) and seq (20 bits) are packed into one 32-bit word,
 * which is XORed with a hash of the job seed and passed through the bijective splitmix32 finalizer. The map is
 * therefore injective for sourceKey < 4096 and seq < 2²⁰ within a job; higher bits are mixed into the job term.
 */
export function batchSeed(jobSeed, sourceKey, seq) {
  const hiSrc = Math.floor(sourceKey / 4096), hiSeq = Math.floor(seq / 1048576);
  const job = mix32(jobSeed >>> 0) ^ Math.imul(hiSrc, 0x85EBCA6B) ^ Math.imul(hiSeq, 0xC2B2AE35);
  const packed = ((sourceKey & 0xFFF) << 20) | (seq & 0xFFFFF);
  return mix32(job ^ packed) || 1;
}

/**
 * Cosine (Lambert) direction about the unit normal (nx, ny, nz), written to out[0..2].
 * u uniform on the unit sphere (u_z = 2ξ₁ − 1, φ = 2πξ₂); the result is (n + u)/|n + u|, redrawn if |n + u| < 1e-9.
 */
export function cosineDir(rng, nx, ny, nz, out) {
  for (;;) {
    const z = 2 * rng() - 1, ph = TWO_PI * rng(), s = Math.sqrt(1 - z * z);
    const x = nx + s * Math.cos(ph), y = ny + s * Math.sin(ph), w = nz + z;
    const l2 = x * x + y * y + w * w;
    if (l2 > 1e-18) {
      const il = 1 / Math.sqrt(l2);
      out[0] = x * il; out[1] = y * il; out[2] = w * il;
      return;
    }
  }
}

// Orthonormal tangents (t1, t2) of a unit normal, for the negative-control samplers.
function tangentDir(nx, ny, nz, ct, st, ph, out) {
  // helper axis least aligned with n
  let hx = 0, hy = 0, hz = 0;
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ax <= ay && ax <= az) hx = 1; else if (ay <= az) hy = 1; else hz = 1;
  // t1 = normalize(h × n), t2 = n × t1
  let t1x = hy * nz - hz * ny, t1y = hz * nx - hx * nz, t1z = hx * ny - hy * nx;
  const l = 1 / Math.sqrt(t1x * t1x + t1y * t1y + t1z * t1z);
  t1x *= l; t1y *= l; t1z *= l;
  const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
  const c = Math.cos(ph) * st, s = Math.sin(ph) * st;
  out[0] = c * t1x + s * t2x + ct * nx;
  out[1] = c * t1y + s * t2y + ct * ny;
  out[2] = c * t1z + s * t2z + ct * nz;
}

/** NEGATIVE CONTROL ONLY: θ = asin ξ (wrong; transmits +14 % to +55 % too much on tubes). */
export function asinDir(rng, nx, ny, nz, out) {
  const st = rng(), ph = TWO_PI * rng();
  tangentDir(nx, ny, nz, Math.sqrt(1 - st * st), st, ph, out);
}

/** NEGATIVE CONTROL ONLY: uniform hemisphere, cos θ = ξ (wrong; −7 % to −16 % on tubes). */
export function uniformDir(rng, nx, ny, nz, out) {
  const ct = rng(), ph = TWO_PI * rng();
  tangentDir(nx, ny, nz, ct, Math.sqrt(1 - ct * ct), ph, out);
}

export const SAMPLERS = Object.freeze(['cosine', 'asin', 'uniform']);

/** Direction sampler by name: 'cosine' (default), or the negative controls 'asin' and 'uniform'. */
export function getSampler(kind = 'cosine') {
  if (kind === undefined || kind === null || kind === 'cosine') return cosineDir;
  if (kind === 'asin') return asinDir;
  if (kind === 'uniform') return uniformDir;
  throw new RangeError('Unknown direction sampler "' + kind + '".');
}
