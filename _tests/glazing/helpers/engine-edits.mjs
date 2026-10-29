// The four additive edits E1-E4 to assets/js/glazing-engine.js (glazing beta build spec, section 3): a
// material-model registry, an optional fifth argument to pane(), an optional opts.solar in evaluate(), and two
// new exports. Each edit is an exact [before, after] pair on LF-normalized text. apply() requires every
// `before` to occur exactly once; revert() requires every `after` to occur exactly once, so
// revert(apply(src)) === src and the V7 test can rebuild the pre-edit engine from the committed file.
//
// Usage (from the repo root):  node _tests/glazing/helpers/engine-edits.mjs apply assets/js/glazing-engine.js
// applyFile() normalizes CRLF to LF, applies the edits (throwing, without writing, if any anchor is not found
// exactly once) and writes the file back with LF line endings.
//
// If the engine changes upstream and an anchor moves, re-apply the change by hand following the semantic rule
// of spec 3.4 and update the strings below to the new exact text, so that revert() keeps working.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EDITS = [
    { id: 'E1',
        before: "    var EPS_GLASS = 0.84, K_GLASS = 1.0;\n",
        after: "    var EPS_GLASS = 0.84, K_GLASS = 1.0;\n" +
            "\n" +
            "    /* ── Material models ──────────────────────────────────────────────── */\n" +
            "    // 'classic' is the parametric glass and coating model above. Other models (glazing-open.js) register\n" +
            "    // themselves here and are chosen per pane: pane(glass, mm, coating, side, 'open').\n" +
            "    var MODELS = {};\n" +
            "    function registerModel(name, model) {\n" +
            "        if (!name || name === 'classic' || !model || typeof model.pane !== 'function') throw new Error('GlazingEngine: invalid material model \"' + name + '\"');\n" +
            "        MODELS[name] = model;\n" +
            "    }\n" +
            "    function modelOf(name) {\n" +
            "        if (!name || name === 'classic') return null;\n" +
            "        if (!MODELS[name]) throw new Error('GlazingEngine: material model \"' + name + '\" is not loaded');\n" +
            "        return MODELS[name];\n" +
            "    }\n" },
    { id: 'E2',
        before: "    function pane(glassKey, tmm, coatKey, side) {\n",
        after: "    function pane(glassKey, tmm, coatKey, side, model) {\n" +
            "        var mod = modelOf(model); if (mod) return mod.pane(glassKey, tmm, coatKey, side);\n" },
    { id: 'E3a',
        before: "    function evaluate(layers, gaps, H) {\n" +
            "        var sys = system(layers);\n" +
            "        var Tsol = avg(sys.T, Wt.solar), Rsol = avg(sys.Rf, Wt.solar), RsolIn = avg(sys.Rb, Wt.solar);\n" +
            "        var Asol = sys.A.map(function (a) { return avg(a, Wt.solar); });\n",
        after: "    function evaluate(layers, gaps, H, opts) {\n" +
            "        var WS = (opts && opts.solar) || Wt.solar;   // solar weights: default ASTM G173 (glazing-weights.js)\n" +
            "        if (WS.length !== N) throw new Error('GlazingEngine: opts.solar must have ' + N + ' weights');\n" +
            "        var sys = system(layers);\n" +
            "        var Tsol = avg(sys.T, WS), Rsol = avg(sys.Rf, WS), RsolIn = avg(sys.Rb, WS);\n" +
            "        var Asol = sys.A.map(function (a) { return avg(a, WS); });\n" },
    { id: 'E3b',
        before: "            Tuv: rangeAvg(sys.T, Wt.solar, 300, 380),\n",
        after: "            Tuv: rangeAvg(sys.T, WS, 300, 380),\n" },
    { id: 'E4',
        before: "        pane: pane, imported: imported, system: system, avg: avg, color: color, thermal: thermal, evaluate: evaluate };\n",
        after: "        pane: pane, imported: imported, system: system, avg: avg, color: color, thermal: thermal, evaluate: evaluate,\n" +
            "        registerModel: registerModel, MODELS: MODELS };\n" }
];

function count(s, x) { return s.split(x).length - 1; }

// Apply E1-E4 to the engine source. Throws if any anchor is not found exactly once.
export function apply(src) {
    let s = src.replace(/\r\n/g, '\n');
    for (const e of EDITS) {
        const n = count(s, e.before);
        if (n !== 1) throw new Error(e.id + ': anchor found ' + n + ' times');
        s = s.replace(e.before, () => e.after);
    }
    return s;
}

// Undo E1-E4 (in reverse order). Throws if any edited text is not found exactly once.
export function revert(src) {
    let s = src.replace(/\r\n/g, '\n');
    for (const e of EDITS.slice().reverse()) {
        const n = count(s, e.after);
        if (n !== 1) throw new Error(e.id + ': edited text found ' + n + ' times');
        s = s.replace(e.after, () => e.before);
    }
    return s;
}

// Read the file, normalize CRLF to LF, apply the edits and write LF. Nothing is written if an edit fails.
export function applyFile(file) {
    const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (EDITS.every(e => count(src, e.after) === 1)) throw new Error('engine-edits: E1-E4 are already applied to ' + file);
    const out = apply(src);
    fs.writeFileSync(file, out);
    return out;
}

function isMain() {
    if (!process.argv[1]) return false;
    const a = path.resolve(process.argv[1]), b = fileURLToPath(import.meta.url);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isMain()) {
    const [cmd, file] = process.argv.slice(2);
    if (cmd !== 'apply' || !file) {
        console.error('Usage: node _tests/glazing/helpers/engine-edits.mjs apply <path to glazing-engine.js>');
        process.exit(2);
    }
    try {
        applyFile(file);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
    console.log('Applied ' + EDITS.map(e => e.id).join(', ') + ' to ' + file);
}
