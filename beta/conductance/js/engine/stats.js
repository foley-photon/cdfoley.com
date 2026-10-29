// Statistics of the test-particle Monte Carlo (spec §3.6.5): binomial and Wilson intervals, inverse-variance
// combination, series/parallel combination of block conductances (§3.6.2), the stopping rule, time estimates,
// reciprocity z-scores, and the summaries shared by the runner and the UI (chain blocks and mesh runs).
// Pure module: no DOM; runs in the page, in workers and in Node (H7, H8). SI units.

export const Z95 = 1.96;
export const MIN_PARTICLES = 1e4;     // stopping rule: at least this many particles ...
export const MIN_COUNTS = 100;        // ... and at least this many counts in the dominant transmission

/** Binomial estimate p = k/n with σ = √(p(1 − p)/n). n = 0 gives NaNs. */
export function binomial(k, n) {
  if (!(n > 0)) return { p: NaN, sigma: NaN };
  const p = k / n;
  return { p, sigma: Math.sqrt(Math.max(p * (1 - p), 0) / n) };
}

/**
 * Wilson score interval: centre (k + z²/2)/(n + z²), half-width z·√(k(n − k)/n + z²/4)/(n + z²).
 * Returns { lo, hi, center, half }; n = 0 gives the whole [0, 1].
 */
export function wilson(k, n, z = Z95) {
  if (!(n > 0)) return { lo: 0, hi: 1, center: 0.5, half: 0.5 };
  const z2 = z * z, den = n + z2;
  const center = (k + z2 / 2) / den;
  const half = z * Math.sqrt(Math.max(k * (n - k) / n, 0) + z2 / 4) / den;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half), center, half };
}

/** σ of k/n, never zero for n > 0: the binomial σ, or the Wilson half-width/z when k = 0 or k = n. */
export function safeSigma(k, n, z = Z95) {
  if (!(n > 0)) return NaN;
  const s = binomial(k, n).sigma;
  return s > 0 ? s : wilson(k, n, z).half / z;
}

/** [value − zσ, value + zσ]. */
export function ci95(value, sigma, z = Z95) {
  return [value - z * sigma, value + z * sigma];
}

/** Relative half-width zσ/|value| (Infinity when value is 0). */
export function relHalfWidth(value, sigma, z = Z95) {
  if (!(Math.abs(value) > 0)) return Infinity;
  return z * sigma / Math.abs(value);
}

/**
 * Inverse-variance combination of independent estimates [{ value, sigma }] (σ > 0; entries with
 * non-finite or non-positive σ are ignored unless they are the only ones). σ = (Σ 1/σ_k²)^(−1/2).
 */
export function inverseVariance(estimates) {
  const ok = estimates.filter((e) => e && Number.isFinite(e.value) && e.sigma > 0 && Number.isFinite(e.sigma));
  if (!ok.length) {
    const any = estimates.find((e) => e && Number.isFinite(e.value));
    if (!any) return { value: NaN, sigma: NaN, ci95: [NaN, NaN] };
    return { value: any.value, sigma: any.sigma, ci95: ci95(any.value, any.sigma) };
  }
  let w = 0, wv = 0;
  for (const e of ok) { const wi = 1 / (e.sigma * e.sigma); w += wi; wv += wi * e.value; }
  const value = wv / w, sigma = 1 / Math.sqrt(w);
  return { value, sigma, ci95: ci95(value, sigma) };
}

/** Series combination 1/X = Σ 1/C_k with var(1/X) = Σ σ_k²/C_k⁴ (§3.6.2). */
export function combineSeries(parts) {
  let inv = 0, v = 0, zeroSigma = -1;
  for (const p of parts) {
    if (!(p.value > 0)) { zeroSigma = Math.max(zeroSigma, p.sigma || 0); continue; }
    inv += 1 / p.value;
    v += (p.sigma * p.sigma) / (p.value ** 4);
  }
  if (zeroSigma >= 0) return { value: 0, sigma: zeroSigma };
  if (!(inv > 0)) return { value: Infinity, sigma: 0 };
  const X = 1 / inv;
  return { value: X, sigma: X * X * Math.sqrt(v) };
}

/** Parallel combination C = Σ C_k, σ = √(Σ σ_k²). */
export function combineParallel(parts) {
  let s = 0, v = 0;
  for (const p of parts) { s += p.value; v += p.sigma * p.sigma; }
  return { value: s, sigma: Math.sqrt(v) };
}

/**
 * Evaluates a CombineNode tree (§2.11): { k: 'series', parts } | { k: 'par', branches } | { k: 'block', id }
 * | { k: 'pumpBlock', id } | { k: 'pump', S }. leaf(node) returns { value, sigma } for block nodes.
 */
export function combineTree(node, leaf) {
  switch (node.k) {
    case 'series': return combineSeries(node.parts.map((p) => combineTree(p, leaf)));
    case 'par': return combineParallel(node.branches.map((b) => combineTree(b, leaf)));
    case 'pump': return { value: node.S, sigma: 0 };
    case 'block': case 'pumpBlock': return leaf(node);
    default: throw new RangeError('Unknown combination node "' + node.k + '".');
  }
}

/** Particles needed for a relative half-width eps: N ≈ z²(1 − α)/(α ε²) (3.84·(1 − α)/(α ε²) at 95 %). */
export function particlesFor(alpha, eps, z = Z95) {
  if (!(alpha > 0) || !(eps > 0)) return Infinity;
  return z * z * (1 - alpha) / (alpha * eps * eps);
}

/**
 * Stopping rule (§3.6.5). state = { value, sigma, particles, counts, elapsed (s), target, maxTime (s), maxParticles }.
 * Returns 'target' | 'time' | 'particles' | null. The target needs ≥ 10⁴ particles and ≥ 100 counts in the
 * dominant transmission.
 */
export function stopReason(state) {
  const { value, sigma, particles = 0, counts = 0, elapsed = 0 } = state;
  const target = state.target ?? 0.01, maxTime = state.maxTime ?? 60, maxParticles = state.maxParticles ?? 1e9;
  if (target > 0 && particles >= MIN_PARTICLES && counts >= MIN_COUNTS && value > 0
      && relHalfWidth(value, sigma) <= target) return 'target';
  if (particles >= maxParticles) return 'particles';
  if (elapsed >= maxTime) return 'time';
  return null;
}

/** Seconds left to reach the target, from the current relative half-width and particle rate (per second). */
export function etaSeconds({ particles, rhw, target, rate }) {
  if (!(rate > 0) || !(target > 0) || !Number.isFinite(rhw) || !(particles > 0)) return null;
  const need = particles * (rhw / target) ** 2;
  return Math.max(0, (need - particles) / rate);
}

/** Reciprocity z = (A_i α_ij − A_j α_ji)/√(A_i²σ_ij² + A_j²σ_ji²) (§3.6.5); 0 when both sides are equal. */
export function reciprocityZ(Ai, aij, sij, Aj, aji, sji) {
  const lhs = Ai * aij, rhs = Aj * aji;
  const den = Math.sqrt(Ai * Ai * sij * sij + Aj * Aj * sji * sji);
  if (lhs === rhs) return 0;
  if (!(den > 0)) return lhs > rhs ? Infinity : -Infinity;
  return (lhs - rhs) / den;
}

// ---------------------------------------------------------------- chain blocks (§3.6.2)

/** True when a block needs no simulation: no cells and no partial outlet (a lone aperture, α = 1 exactly). */
export function isExactBlock(block) {
  return block.cells.length === 0 && !(block.outlet && block.outlet.stick < 1);
}

/** True when a block may be launched from its outlet (reciprocity requires a perfect outlet). */
export function canReverse(block) {
  return !block.outlet || block.outlet.stick >= 1;
}

/**
 * Conductance (or pump-block speed) of one block from its counts:
 * counts = { in: { n, trans } | null, out: { n, trans } | null } (n excludes stuck particles).
 * C_in = (trans/n)·A_in·v̄/4 and C_out = (trans/n)·A_out·v̄/4 are combined by inverse variance (reciprocity).
 * Returns { value, sigma, alpha, sigmaAlpha, counts, exact }; alpha is referred to A_in.
 */
export function blockEstimate(block, counts, vbar) {
  const q = vbar / 4, Cin0 = block.Ain * q;
  if (isExactBlock(block)) return { value: Cin0, sigma: 0, alpha: 1, sigmaAlpha: 0, counts: Infinity, exact: true };
  const est = [];
  let dom = 0;
  const din = counts && counts.in, dout = counts && counts.out;
  if (din && din.n > 0) {
    est.push({ value: (din.trans / din.n) * Cin0, sigma: safeSigma(din.trans, din.n) * Cin0 });
    dom = Math.max(dom, din.trans);
  }
  if (dout && dout.n > 0 && canReverse(block)) {
    const C0 = block.Aout * q;
    est.push({ value: (dout.trans / dout.n) * C0, sigma: safeSigma(dout.trans, dout.n) * C0 });
    dom = Math.max(dom, dout.trans);
  }
  if (!est.length) return { value: NaN, sigma: NaN, alpha: NaN, sigmaAlpha: NaN, counts: 0, exact: false };
  const c = inverseVariance(est);
  return { value: c.value, sigma: c.sigma, alpha: c.value / Cin0, sigmaAlpha: c.sigma / Cin0, counts: dom, exact: false };
}

// ---------------------------------------------------------------- mesh runs (§3.6.5)

/** Default inlet, outlet and pump ports of a scene's port list (indices, or null). */
export function defaultPorts(ports, inletPort = null, outletPort = null) {
  const find = (role) => { const k = ports.findIndex((p) => p.role === role); return k < 0 ? null : k; };
  const iIn = inletPort ?? find('inlet');
  let jOut = outletPort ?? find('outlet');
  if (jOut === null) jOut = find('pump');
  const jPump = jOut !== null && ports[jOut] && ports[jOut].role === 'pump' ? jOut : find('pump');
  return { iIn, jOut, jPump };
}

/**
 * Transmission matrix, conductance, S_eff and reciprocity of a mesh run (§3.6.5).
 * ports: [{ role, stick, area }]; perSource: [{ port, n, absorbed: number[] }] (n excludes stuck particles);
 * vbar in m/s. Rows of alpha for ports that never launched are null.
 * Returns { alpha, C, Seff, reciprocity, primary, inletPort, outletPort, pumpPort, counts }.
 */
export function summarizeMesh(ports, perSource, vbar, { inletPort = null, outletPort = null } = {}) {
  const nP = ports.length, q = vbar / 4;
  const N = new Float64Array(nP), K = Array.from({ length: nP }, () => new Float64Array(nP));
  for (const s of perSource) {
    N[s.port] += s.n;
    for (let j = 0; j < nP; j++) K[s.port][j] += s.absorbed[j] || 0;
  }
  const alpha = [];
  for (let i = 0; i < nP; i++) {
    if (!(N[i] > 0)) { alpha.push(null); continue; }
    const row = [];
    for (let j = 0; j < nP; j++) {
      const b = binomial(K[i][j], N[i]), w = wilson(K[i][j], N[i]);
      row.push({ value: b.p, lo: w.lo, hi: w.hi, sigma: b.sigma, k: K[i][j], n: N[i] });
    }
    alpha.push(row);
  }
  const { iIn, jOut, jPump } = defaultPorts(ports, inletPort, outletPort);
  const dir = (i, j) => {
    if (i === null || j === null || !(N[i] > 0)) return null;
    const C0 = ports[i].area * q;
    return { value: (K[i][j] / N[i]) * C0, sigma: safeSigma(K[i][j], N[i]) * C0, k: K[i][j] };
  };
  let C = null, Seff = null, counts = 0;
  if (iIn !== null && jOut !== null && jOut !== iIn && ports[jOut].role !== 'pump') {
    const a = dir(iIn, jOut), b = ports[jOut].stick >= 1 ? dir(jOut, iIn) : null;
    const est = [a, b].filter(Boolean);
    if (est.length) {
      const c = inverseVariance(est);
      C = { value: c.value, sigma: c.sigma, ci95: c.ci95, i: iIn, j: jOut };
      counts = Math.max(...est.map((e) => e.k));
    }
  }
  if (iIn !== null && jPump !== null && jPump !== iIn) {
    const a = dir(iIn, jPump);
    if (a) {
      Seff = { value: a.value, sigma: a.sigma, ci95: ci95(a.value, a.sigma), i: iIn, j: jPump };
      counts = a.k;
    }
  }
  const reciprocity = [];
  for (let i = 0; i < nP; i++) {
    for (let j = i + 1; j < nP; j++) {
      if (!(ports[i].stick >= 1 && ports[j].stick >= 1 && N[i] > 0 && N[j] > 0)) continue;
      const aij = K[i][j] / N[i], aji = K[j][i] / N[j];
      const sij = safeSigma(K[i][j], N[i]), sji = safeSigma(K[j][i], N[j]);
      const z = reciprocityZ(ports[i].area, aij, sij, ports[j].area, aji, sji);
      reciprocity.push({ i, j, lhs: ports[i].area * aij, rhs: ports[j].area * aji, z, pass: Math.abs(z) <= 3 });
    }
  }
  return { alpha, C, Seff, reciprocity, primary: Seff || C, inletPort: iIn, outletPort: jOut, pumpPort: jPump, counts };
}
