// Components items → analytic Monte Carlo blocks and their combination plan (spec §2.11, §3.6.2).
// A run (a maximal sequence of items between plenums: the chamber, chamber items and parallel-group boundaries)
// becomes one block; thin orifices become plates at the junction where they stand; black boxes become their
// equivalent tubes; a pump attached to a run turns it into a pump block. Blocks combine as series and parallel
// conductances between ideal plenums, which is exact for ideal mixing volumes.
// Pure module (main thread and Node); SI units.
import { compileItem } from './elements.js';
import { makeBlock, mirrorBlock, apArea, apIntersectArea, cellApertures, compileBlock } from './chain-mc.js';
import { blockEstimate, combineTree, ci95 } from './stats.js';

const PI = Math.PI;

/** Mirror image of a block, launched from its outlet; requires outlet === null or outlet.stick === 1. */
export function reverseBlock(block) {
  return mirrorBlock(block);
}

// Intersection of two coaxial apertures at the same junction, or null when it is not an aperture shape.
function combineApertures(p, q) {
  if (!p) return q;
  if (!q) return p;
  const A = apIntersectArea(p, q), Ap = apArea(p), Aq = apArea(q);
  if (Math.abs(A - Ap) <= 1e-12 * Ap) return p;      // p lies inside q
  if (Math.abs(A - Aq) <= 1e-12 * Aq) return q;
  const ring = (x) => (x.kind === 'disc' ? { ri: 0, ro: x.r } : x.kind === 'ring' ? { ri: x.ri, ro: x.ro } : null);
  const a = ring(p), b = ring(q);
  if (a && b) {
    const ro = Math.min(a.ro, b.ro), ri = Math.max(a.ri, b.ri);
    if (!(ro > ri)) return undefined;
    return ri > 0 ? { kind: 'ring', ri, ro } : { kind: 'disc', r: ro };
  }
  if (p.kind === 'rect' && q.kind === 'rect') return { kind: 'rect', a: Math.min(p.a, q.a), b: Math.min(p.b, q.b) };
  return undefined;
}

// A reason why a block cannot be traced (a junction where an opening does not overlap the bore next to it, or a
// cell the kernel refuses), or null.
function blockProblem(block) {
  const n = block.cells.length;
  for (let j = 0; j <= n; j++) {
    const P = block.plates[j] || null;
    const prevOut = j > 0 ? cellApertures(block.cells[j - 1]).apOut : null;
    const nextIn = j < n ? cellApertures(block.cells[j]).apIn : null;
    if (!(apIntersectArea(P, nextIn) > 0) || !(apIntersectArea(P, prevOut) > 0) || !(apIntersectArea(prevOut, nextIn) > 0)) {
      return 'an opening does not overlap the bore next to it, so nothing can pass and the conductance is zero.';
    }
  }
  try { compileBlock(block); } catch (err) { return err && err.message ? err.message : String(err); }
  return null;
}

const num1 = (s) => String(Number(s) + 1);
function pathLabel(paths) {
  const top = paths.map((p) => p.split('.'));
  if (top.length && top[0].length === 3) {
    return 'Element ' + num1(top[0][0]) + ', branch ' + num1(top[0][1]);
  }
  const first = num1(top[0][0]), last = num1(top[top.length - 1][0]);
  return first === last ? 'Element ' + first : 'Elements ' + first + '–' + last;
}

/**
 * Maps a Components line to analytic Monte Carlo blocks (§2.11, §3.6.2, Appendix B.3).
 * items: Item[] (SI); G: GasState; bc: { mode: 'pump' | 'dp', ... }.
 * Returns ChainPlan = { blocks, tree, kind: 'Seff' | 'C', notes } or { unsupported: string[] }.
 * Rectangles (ducts, slits, rectangular orifices) are aligned with their short sides parallel.
 */
export function chainPlan(items, G, opts) {
  const bc = opts && opts.bc;
  const unsupported = [], notes = [], blocks = [], parts = [];
  const kind = bc && bc.mode === 'dp' ? 'C' : 'Seff';
  if (!Array.isArray(items)) return { unsupported: ['The line could not be read.'] };
  if (!G || !(G.vbar > 0)) return { unsupported: ['The gas data are not valid.'] };
  let run = null;   // { cells, plates (length cells + 1), paths }

  const open = () => { if (!run) run = { cells: [], plates: [null], paths: [] }; return run; };
  const addPlate = (r, ap, path) => {
    const n = r.cells.length;
    const c = combineApertures(r.plates[n], ap);
    if (c === undefined) {
      unsupported.push('Element ' + pathText(path) + ': two openings of different shape at the same junction cannot be simulated; put a short duct between them.');
      return;
    }
    r.plates[n] = c; r.paths.push(path);
  };
  const addCell = (r, cell, path) => { r.cells.push(cell); r.plates.push(null); r.paths.push(path); };
  const pathText = (path) => path.split('.').map((x) => num1(x)).join('.');
  const close = (r, extra = {}) => {
    if (!r || (r.cells.length === 0 && !r.plates[0])) return null;
    const block = makeBlock({ id: blocks.length, label: pathLabel(r.paths), cells: r.cells, plates: r.plates, outlet: extra.outlet || null, paths: r.paths.slice() });
    const why = blockProblem(block);
    if (why) unsupported.push(block.label + ': ' + why);
    blocks.push(block);
    return block;
  };

  // one geometric item → cell or plate of run r
  const addItem = (r, it, path) => {
    switch (it.t) {
      case 'tube': addCell(r, { type: 'tube', R: it.d / 2, L: it.L }, path); break;
      case 'cone': addCell(r, { type: 'cone', R1: it.d1 / 2, R2: it.d2 / 2, L: it.L }, path); break;
      case 'annulus': addCell(r, { type: 'annulus', Ri: it.di / 2, Ro: it.do / 2, L: it.L }, path); break;
      case 'rect': addCell(r, { type: 'rect', a: Math.min(it.a, it.b), b: Math.max(it.a, it.b), L: it.L }, path); break;
      case 'slit': addCell(r, { type: 'rect', a: Math.min(it.h, it.w), b: Math.max(it.h, it.w), L: it.L }, path); break;
      case 'elbow': addCell(r, { type: 'elbow', R: it.d / 2, A: it.A, B: it.B }, path); break;
      case 'bbox': {
        let Leq;
        try { Leq = compileItem(it, G).Leq; } catch (err) { unsupported.push('Element ' + pathText(path) + ': ' + err.message); return; }
        addCell(r, { type: 'tube', R: it.d / 2, L: Leq }, path);
        notes.push('Element ' + pathText(path) + ' (black box) is simulated as its equivalent tube, ' + (Leq * 1000).toPrecision(4) + ' mm long.');
        break;
      }
      case 'orifice':
        if (it.shape === 'rect') addPlate(r, { kind: 'rect', a: Math.min(it.w, it.h), b: Math.max(it.w, it.h) }, path);
        else addPlate(r, { kind: 'disc', r: it.d / 2 }, path);
        break;
      default:
        unsupported.push('Element ' + pathText(path) + ' (' + it.t + ') cannot be simulated in a branch or chain.');
    }
  };

  let pumpSeen = false;
  items.forEach((it, i) => {
    const path = String(i);
    if (!it || typeof it !== 'object') { unsupported.push('Element ' + (i + 1) + ' could not be read.'); return; }
    if (pumpSeen) { unsupported.push('The pump must be the last element.'); return; }
    switch (it.t) {
      case 'chamber': {
        const b = close(run); run = null;
        if (b) parts.push({ k: 'block', id: b.id });
        break;
      }
      case 'parallel': {
        const b = close(run); run = null;
        if (b) parts.push({ k: 'block', id: b.id });
        const branches = [];
        (it.branches || []).forEach((br, bi) => {
          const r = { cells: [], plates: [null], paths: [] };
          (br || []).forEach((sub, k) => {
            if (!sub || ['chamber', 'parallel', 'pump'].includes(sub.t)) {
              unsupported.push('Branches may not contain chambers, pumps or parallel groups.');
              return;
            }
            addItem(r, sub, `${i}.${bi}.${k}`);
          });
          const bb = close(r);
          if (bb) branches.push({ k: 'block', id: bb.id });
        });
        if (branches.length) parts.push(branches.length === 1 ? branches[0] : { k: 'par', branches });
        break;
      }
      case 'pump': {
        pumpSeen = true;
        if (kind !== 'Seff') { unsupported.push('A pump is only allowed in the "Chamber → pump" mode.'); break; }
        const Ap = PI * it.d * it.d / 4, C0 = Ap * G.vbar / 4, stick = it.S / C0;
        if (!(it.S > 0) || !(it.d > 0)) { unsupported.push('The pump needs a positive speed and bore.'); break; }
        if (!(stick <= 1)) { unsupported.push('Pumping speed exceeds the molecular-flow maximum for this inlet bore.'); break; }
        if (run && run.cells.length === 0) {
          unsupported.push('An orifice directly on the pump inlet cannot be simulated; put a short duct (the flange) between them.');
          run = null;
          break;
        }
        if (run) {
          const last = run.cells[run.cells.length - 1];
          const apOut = cellApertures(last).apOut, Aout = apArea(apOut);
          // A plate smaller than the pump bore right at the pump would send the particles the pump reflects back
          // into the line, although in reality they bounce between the plate and the pump: not modelled.
          const plate = run.plates[run.cells.length];
          if (plate && apIntersectArea(plate, apOut) < Math.min(Ap, Aout) * (1 - 1e-9)) {
            unsupported.push('An orifice directly on the pump inlet cannot be simulated; put a short duct (the flange) between them.');
            run = null;
            break;
          }
          // A pump inlet that reaches beyond the line's outlet (a DN40 line on a DN100 pump): the gas spreads over the
          // flange and the pump's own throat before it is pumped, a volume the chain does not contain. Sticking it on
          // the smaller outlet would simulate a pump of speed S·A_out/A_p, so the user is asked for that piece instead.
          const pAp = { kind: 'disc', r: it.d / 2 };
          if (apIntersectArea(pAp, apOut) < Ap * (1 - 1e-9)) {
            if (apOut.kind === 'ring' && apOut.ro >= pAp.r * (1 - 1e-9)) {
              unsupported.push('The rod of ' + pathLabel(run.paths.slice(-1)).toLowerCase() + ' ends at the pump inlet, so the gas also reaches the pump over the rod\'s end face, which the simulation cannot see. Add a short tube of the pump bore after the annulus to verify this line.');
              run = null;
              break;
            }
            unsupported.push('The pump inlet (Ø' + (it.d * 1000).toPrecision(4) + ' mm) does not fit inside the outlet of the last element, so the gas spreads over a flange and the pump throat that the simulation cannot see. Add the adapter or the pump\'s inlet throat as the last element (a cone, or a short tube of the pump bore) to verify this line.');
            run = null;
            break;
          }
          if (Ap < Aout * (1 - 1e-9)) addPlate(run, pAp, path);
          const b = close(run, { outlet: { stick } }); run = null;
          if (b) parts.push({ k: 'pumpBlock', id: b.id });
        } else {
          parts.push({ k: 'pump', S: it.S });
          notes.push('The pump follows a chamber or a parallel group, so it is combined with the line as a pump on a plenum.');
        }
        break;
      }
      default:
        addItem(open(), it, path);
    }
  });
  if (run) { const b = close(run); run = null; if (b) parts.push({ k: 'block', id: b.id }); }

  if (kind === 'Seff' && !pumpSeen) unsupported.push('The line has no pump.');
  if (!blocks.length && !unsupported.length) {
    unsupported.push(kind === 'Seff' ? 'There is nothing to simulate between the chamber and the pump.' : 'Add at least one element.');
  }
  if (unsupported.length) return { unsupported: [...new Set(unsupported)] };
  const tree = parts.length === 1 ? parts[0] : { k: 'series', parts };
  return { blocks, tree, kind, notes };
}

function countsOf(res) {
  if (!res) return null;
  if (res.in !== undefined || res.out !== undefined) return { in: res.in || null, out: res.out || null };
  if (res.n !== undefined) return { in: { n: res.n, trans: res.trans }, out: null };
  return null;
}

/**
 * Combines block results into S_eff (pump mode) or the line conductance (two-pressure mode) (§3.6.2).
 * blockResults: [{ id, in: { n, trans }, out: { n, trans } | null }] (the ChainMcResult.blocks entries) or
 * [{ id, n, trans }] for inlet launches only. Blocks without cells (a lone aperture) are exact and need no entry.
 * var(1/X) = Σ σ_k²/X_k⁴ for series; σ² adds for parallel branches; the interval is ±1.96σ.
 */
export function combinePlan(plan, blockResults, G) {
  const byId = new Map((blockResults || []).map((r) => [r.id, r]));
  const leaf = (node) => {
    const block = plan.blocks.find((b) => b.id === node.id);
    if (!block) throw new RangeError('The plan has no block ' + node.id + '.');
    const e = blockEstimate(block, countsOf(byId.get(node.id)), G.vbar);
    return { value: e.value, sigma: e.sigma };
  };
  const r = combineTree(plan.tree, leaf);
  return { value: r.value, sigma: r.sigma, ci95: ci95(r.value, r.sigma), kind: plan.kind };
}
