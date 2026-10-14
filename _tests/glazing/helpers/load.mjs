// Loads the site's classic scripts into a fresh node:vm context, in page order, the way the browser runs them:
// `window` is the context's global object, so each file attaches its global (GlazingWeights, GlazingEngine, ...)
// to it.
//
//   import { load } from './helpers/load.mjs';
//   const ctx = load.open();                 // or load(['assets/js/glazing-weights.js', ...])
//   const E = ctx.GlazingEngine;
//
// load(files, globals?) runs each entry with vm.runInContext (filename set, for stack traces). An entry is a
// repo-relative path, or { file, code } to run source text under that name (V7 loads a reverted engine this
// way). `globals` adds or overrides context globals. Presets, in the page's script order (spec section 1):
//   load.engine()  weights + engine
//   load.open()    + materials, E891 weights, transfer matrix, coatings, open model
//   load.all()     + products, beta/glazing/beta-core.js, beta/glazing/selftest.js
//
// Speed: on Node 22.8+ the context is created with vm.constants.DONT_CONTEXTIFY, an ordinary global object as in
// a browser. A classic "contextified" sandbox routes every global lookup (Math, Float64Array, ...) through an
// interceptor and ran the engine 18 to 30 times slower on this PC (9.0 ms against 0.50 ms per double-glazing
// evaluate(), Node 24.11). Older Node versions fall back to the sandbox.
//
// Values from the context belong to another realm: compare numbers or Array.from(x), and never use
// assert.deepStrictEqual on typed arrays (or other objects) across realms.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ENGINE = ['assets/js/glazing-weights.js', 'assets/js/glazing-engine.js'];
const OPEN = ENGINE.concat(['assets/js/glazing-materials.js', 'assets/js/glazing-solar-e891.js', 'assets/js/glazing-tmm.js',
    'assets/js/glazing-coatings.js', 'assets/js/glazing-open.js']);
const ALL = OPEN.concat(['assets/js/glazing-products.js', 'beta/glazing/beta-core.js', 'beta/glazing/selftest.js']);

const FAST = !!(vm.constants && vm.constants.DONT_CONTEXTIFY !== undefined);

export function load(files, globals) {
    // console, performance and TextDecoder as the spec lists; the timer functions and TextEncoder are there
    // because browser code (for example selftest.js yielding between groups) may use them.
    const host = Object.assign({
        console, performance, TextDecoder, TextEncoder, setTimeout, clearTimeout, queueMicrotask
    }, globals);
    let ctx;
    if (FAST) {
        ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY);   // the new context's own global object
        for (const k of Object.keys(host)) ctx[k] = host[k];
    } else {
        ctx = vm.createContext(host);
    }
    ctx.window = ctx;
    for (const entry of files) {
        const item = typeof entry === 'string' ? { file: entry } : entry;
        if (!item || !item.file) throw new Error('load.mjs: each entry needs a file name');
        const file = item.code != null ? item.file : path.resolve(ROOT, item.file);
        const code = item.code != null ? item.code : fs.readFileSync(file, 'utf8');
        vm.runInContext(code, ctx, { filename: file });
    }
    return ctx;
}

load.FILES = { engine: ENGINE.slice(), open: OPEN.slice(), all: ALL.slice() };
load.engine = globals => load(ENGINE, globals);
load.open = globals => load(OPEN, globals);
load.all = globals => load(ALL, globals);

export default load;
