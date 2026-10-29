/* ==========================================================================
   Ion optics engine: expr.js
   Safe arithmetic expressions for project parameters and numeric fields.

   Grammar (spec §2.2.3), parsed by recursive descent into a tree of closures
   (no eval, no Function):
     expr   := term (('+'|'-') term)*
     term   := factor (('*'|'/') factor)*
     factor := unary ('^' factor)?            right-associative
     unary  := ('+'|'-') unary | atom         so -2^2 = (-2)^2 = 4, 2^-1 = 0.5
     atom   := number | name | name '(' args ')' | '(' expr ')'
   Functions: sqrt abs sin cos tan (degrees), asin acos atan atan2 (return
   degrees), exp ln log10 min max pow floor ceil round hypot; constant pi.
   Names are parameters, evaluated in topological order (depth-first search,
   Tarjan, SIAM J. Comput. 1, 146 (1972)); a cycle is an error at the path of
   every parameter on it.

   Sources: recursive-descent parsing and operator precedence (Aho, Lam,
   Sethi & Ullman, Compilers: Principles, Techniques, and Tools, 2nd ed.
   (2006), §4.4); exact values of the trigonometric functions at multiples of
   30° and 45° (Abramowitz & Stegun, Handbook of Mathematical Functions
   (1964), Table 4.6, special values).
   ========================================================================== */

/**
 * Error raised by engine modules: { name: 'EngineError', code, message, path?, detail? }.
 * Codes: E_BAD_PROJECT, E_GRID_TOO_LARGE, E_MEMORY, E_NO_CONVERGENCE, E_NAN, E_CANCELLED,
 * E_UNSUPPORTED, E_VERSION, E_INTERNAL. Re-exported by schema.js.
 */
export class EngineError extends Error {
    /**
     * @param {string} code @param {string} message @param {string} [path] @param {*} [detail]
     */
    constructor(code, message, path, detail) {
        super(message);
        this.name = 'EngineError';
        this.code = code;
        if (path !== undefined) this.path = path;
        if (detail !== undefined) this.detail = detail;
    }
}

const DEG = Math.PI / 180;
const HAS = Object.prototype.hasOwnProperty;
const SQRT3_2 = Math.sqrt(3) / 2;

/** Function names with their argument counts ([min, max]). */
export const FUNCTIONS = Object.freeze({
    sqrt: [1, 1], abs: [1, 1], sin: [1, 1], cos: [1, 1], tan: [1, 1],
    asin: [1, 1], acos: [1, 1], atan: [1, 1], atan2: [2, 2],
    exp: [1, 1], ln: [1, 1], log10: [1, 1], min: [1, Infinity], max: [1, Infinity], pow: [2, 2],
    floor: [1, 1], ceil: [1, 1], round: [1, 1], hypot: [1, Infinity],
});
/** Names a parameter may not take. */
export const RESERVED_NAMES = Object.freeze([...Object.keys(FUNCTIONS), 'pi']);
const IDENT = /^[A-Za-z_]\w*$/;

/** True if `name` is a valid, unreserved parameter name. */
export function isIdentifier(name) {
    return typeof name === 'string' && IDENT.test(name) && !RESERVED_NAMES.includes(name);
}

// ---------------------------------------------------------------- exact-angle trigonometry
function reduceDeg(x) {
    let r = x % 360;
    if (r < 0) r += 360;
    return r;
}
// sin at multiples of 30° (index r/30)
const SIN30 = [0, 0.5, SQRT3_2, 1, SQRT3_2, 0.5, 0, -0.5, -SQRT3_2, -1, -SQRT3_2, -0.5];
function sinDeg(x) {
    if (!Number.isFinite(x)) return NaN;
    const r = reduceDeg(x);
    if (r % 30 === 0) return SIN30[r / 30];
    if (r % 45 === 0) return (r === 45 || r === 135) ? Math.SQRT1_2 : -Math.SQRT1_2;
    return Math.sin(r * DEG);
}
function cosDeg(x) {
    if (!Number.isFinite(x)) return NaN;
    return sinDeg(reduceDeg(x) + 90);
}
function tanDeg(x) {
    if (!Number.isFinite(x)) return NaN;
    const r = reduceDeg(x);
    if (r % 180 === 0) return 0;
    if (r % 180 === 90) return NaN;            // undefined: reported as a non-finite value
    if (r % 45 === 0) return (r % 180 === 45) ? 1 : -1;
    return sinDeg(r) / cosDeg(r);
}

const IMPL = {
    sqrt: (a) => Math.sqrt(a[0]), abs: (a) => Math.abs(a[0]),
    sin: (a) => sinDeg(a[0]), cos: (a) => cosDeg(a[0]), tan: (a) => tanDeg(a[0]),
    asin: (a) => Math.asin(a[0]) / DEG, acos: (a) => Math.acos(a[0]) / DEG, atan: (a) => Math.atan(a[0]) / DEG,
    atan2: (a) => Math.atan2(a[0], a[1]) / DEG,
    exp: (a) => Math.exp(a[0]), ln: (a) => Math.log(a[0]), log10: (a) => Math.log10(a[0]),
    min: (a) => Math.min(...a), max: (a) => Math.max(...a), pow: (a) => Math.pow(a[0], a[1]),
    floor: (a) => Math.floor(a[0]), ceil: (a) => Math.ceil(a[0]), round: (a) => Math.round(a[0]),
    hypot: (a) => Math.hypot(...a),
};

// ---------------------------------------------------------------- tokenizer
function syntaxError(message, column, src) {
    return new EngineError('E_BAD_PROJECT', `${message} at column ${column}`, undefined, { column, source: src, kind: 'syntax' });
}
const isDigit = (c) => c >= 48 && c <= 57;
const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

function tokenize(src) {
    const toks = [];
    const n = src.length;
    let i = 0;
    while (i < n) {
        const c = src.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
        if (isDigit(c) || (c === 46 && i + 1 < n && isDigit(src.charCodeAt(i + 1)))) {
            let j = i;
            while (j < n && isDigit(src.charCodeAt(j))) j++;
            if (j < n && src.charCodeAt(j) === 46) { j++; while (j < n && isDigit(src.charCodeAt(j))) j++; }
            if (j < n && (src[j] === 'e' || src[j] === 'E')) {
                let k = j + 1;
                if (k < n && (src[k] === '+' || src[k] === '-')) k++;
                if (k < n && isDigit(src.charCodeAt(k))) { j = k; while (j < n && isDigit(src.charCodeAt(j))) j++; }
                else throw syntaxError('Malformed number', i + 1, src);
            }
            if (j < n && (isAlpha(src.charCodeAt(j)) || src.charCodeAt(j) === 46)) throw syntaxError('Malformed number', i + 1, src);
            toks.push({ t: 'num', v: Number(src.slice(i, j)), col: i + 1 });
            i = j;
            continue;
        }
        if (isAlpha(c)) {
            let j = i + 1;
            while (j < n && (isAlpha(src.charCodeAt(j)) || isDigit(src.charCodeAt(j)))) j++;
            toks.push({ t: 'name', v: src.slice(i, j), col: i + 1 });
            i = j;
            continue;
        }
        const ch = src[i];
        if ('+-*/^(),'.includes(ch)) { toks.push({ t: ch, col: i + 1 }); i++; continue; }
        throw syntaxError(`Unexpected character "${ch}"`, i + 1, src);
    }
    toks.push({ t: 'end', col: n + 1 });
    return toks;
}

// ---------------------------------------------------------------- parser (closure tree)
// A node is { c: true, v } (constant) or { c: false, f: (vars) => number }.
const K = (v) => ({ c: true, v });
const F = (f) => ({ c: false, f });
const run = (node) => (node.c ? (() => node.v) : node.f);

function lookupVar(vars, name, col, src) {
    if (vars instanceof Map) {
        if (vars.has(name)) return +vars.get(name);
    } else if (vars && HAS.call(vars, name)) return +vars[name];
    throw new EngineError('E_BAD_PROJECT', `Unknown parameter "${name}" at column ${col}`, undefined, { column: col, source: src, kind: 'unknown', name });
}

function binary(op, a, b) {
    if (a.c && b.c) {
        switch (op) {
            case '+': return K(a.v + b.v);
            case '-': return K(a.v - b.v);
            case '*': return K(a.v * b.v);
            case '/': return K(a.v / b.v);
            default: return K(Math.pow(a.v, b.v));
        }
    }
    const fa = run(a), fb = run(b);
    switch (op) {
        case '+': return F((v) => fa(v) + fb(v));
        case '-': return F((v) => fa(v) - fb(v));
        case '*': return F((v) => fa(v) * fb(v));
        case '/': return F((v) => fa(v) / fb(v));
        default: return F((v) => Math.pow(fa(v), fb(v)));
    }
}

function parseTokens(toks, src) {
    let p = 0;
    const deps = [];
    const peek = () => toks[p];
    const describe = (t) => (t.t === 'end' ? 'end of expression' : t.t === 'num' ? `number ${t.v}` : t.t === 'name' ? `"${t.v}"` : `"${t.t}"`);
    function expect(type) {
        const t = toks[p];
        if (t.t !== type) throw syntaxError(`Expected "${type}" but found ${describe(t)}`, t.col, src);
        p++;
        return t;
    }
    function expr() {
        let left = term();
        for (;;) {
            const t = peek();
            if (t.t !== '+' && t.t !== '-') return left;
            p++;
            left = binary(t.t, left, term());
        }
    }
    function term() {
        let left = factor();
        for (;;) {
            const t = peek();
            if (t.t !== '*' && t.t !== '/') return left;
            p++;
            left = binary(t.t, left, factor());
        }
    }
    function factor() {
        const base = unary();
        if (peek().t === '^') { p++; return binary('^', base, factor()); }
        return base;
    }
    function unary() {
        const t = peek();
        if (t.t === '+') { p++; return unary(); }
        if (t.t === '-') {
            p++;
            const a = unary();
            if (a.c) return K(-a.v);
            const fa = a.f;
            return F((v) => -fa(v));
        }
        return atom();
    }
    function atom() {
        const t = peek();
        if (t.t === 'num') { p++; return K(t.v); }
        if (t.t === '(') {
            p++;
            const e = expr();
            expect(')');
            return e;
        }
        if (t.t === 'name') {
            p++;
            const name = t.v;
            if (peek().t === '(') {
                if (!HAS.call(FUNCTIONS, name)) throw syntaxError(`Unknown function "${name}"`, t.col, src);
                p++;
                const args = [];
                if (peek().t !== ')') {
                    args.push(expr());
                    while (peek().t === ',') { p++; args.push(expr()); }
                }
                expect(')');
                const [lo, hi] = FUNCTIONS[name];
                if (args.length < lo || args.length > hi) {
                    const want = lo === hi ? `${lo} argument${lo === 1 ? '' : 's'}` : `at least ${lo} argument${lo === 1 ? '' : 's'}`;
                    throw syntaxError(`${name}() takes ${want}, got ${args.length}`, t.col, src);
                }
                const impl = IMPL[name];
                if (args.every((a) => a.c)) return K(impl(args.map((a) => a.v)));
                const fs = args.map(run);
                const nArg = fs.length;
                return F((v) => {
                    const vals = new Array(nArg);
                    for (let q = 0; q < nArg; q++) vals[q] = fs[q](v);
                    return impl(vals);
                });
            }
            if (HAS.call(FUNCTIONS, name)) throw syntaxError(`Function "${name}" needs arguments in parentheses`, t.col, src);
            if (name === 'pi') return K(Math.PI);
            if (!deps.includes(name)) deps.push(name);
            const col = t.col;
            return F((v) => lookupVar(v, name, col, src));
        }
        throw syntaxError(`Unexpected ${describe(t)}`, t.col, src);
    }
    const root = expr();
    if (peek().t !== 'end') throw syntaxError(`Unexpected ${describe(peek())}`, peek().col, src);
    return { root, deps };
}

const CACHE = new Map();
const CACHE_MAX = 4096;

/**
 * Parses an expression once into a closure tree.
 * @param {string} src
 * @returns {{ evaluate: (vars?: object|Map<string, number>) => number, deps: string[], constant: boolean, src: string }}
 * @throws {EngineError} E_BAD_PROJECT with `detail.column` (1-based) on a syntax error
 */
export function parseExpr(src) {
    if (typeof src !== 'string') throw new EngineError('E_BAD_PROJECT', 'An expression must be a string', undefined, { column: 1, source: String(src), kind: 'syntax' });
    const hit = CACHE.get(src);
    if (hit) return hit;
    if (src.length > 2000) throw syntaxError('Expression longer than 2000 characters', 1, src.slice(0, 40));
    const toks = tokenize(src);
    if (toks.length === 1) throw syntaxError('Empty expression', 1, src);
    const { root, deps } = parseTokens(toks, src);
    const constant = root.c;
    const f = run(root);
    const out = Object.freeze({ evaluate: (vars) => f(vars), deps: Object.freeze(deps.slice()), constant, src });
    if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(src, out);
    return out;
}

/**
 * Value of a numeric field: a finite number, or an expression string evaluated with `vars`.
 * @param {number|string} value @param {object|Map<string, number>} [vars]
 * @returns {number} (may be non-finite; callers check)
 * @throws {EngineError} on syntax errors, unknown names or a value of another type
 */
export function evalValue(value, vars = {}) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return parseExpr(value).evaluate(vars);
    throw new EngineError('E_BAD_PROJECT', 'Expected a number or an expression', undefined, { kind: 'type' });
}

/** True if `v` is an expression string (as opposed to a plain number). */
export function isExpr(v) {
    return typeof v === 'string';
}

/**
 * Evaluates the project parameters in dependency order.
 * @param {Array<{ name: string, value: number|string }>} params
 * @returns {{ values: Object<string, number>, errors: Array<{ path: string, code: string, message: string }>, order: string[] }}
 *   `values` has no prototype (every key is a parameter name).
 */
export function evaluateParams(params) {
    const list = Array.isArray(params) ? params : [];
    const values = Object.create(null);   // no inherited names: a parameter may be called "constructor"
    const errors = [];
    const order = [];
    const byName = new Map();
    const bad = new Set();
    const parsed = new Array(list.length).fill(null);
    for (let i = 0; i < list.length; i++) {
        const p = list[i];
        const path = `params[${i}]`;
        if (!p || typeof p !== 'object') { errors.push({ path, code: 'E_TYPE', message: 'A parameter must be an object.' }); continue; }
        const name = p.name;
        if (typeof name !== 'string' || !IDENT.test(name)) {
            errors.push({ path: path + '.name', code: 'E_PARAM_NAME', message: 'A parameter name starts with a letter or "_" and contains only letters, digits and "_".' });
            continue;
        }
        if (RESERVED_NAMES.includes(name)) {
            errors.push({ path: path + '.name', code: 'E_PARAM_RESERVED', message: `"${name}" is a function or constant name; choose another parameter name.` });
            continue;
        }
        if (byName.has(name)) {
            errors.push({ path: path + '.name', code: 'E_PARAM_DUPLICATE', message: `Parameter "${name}" is defined twice.` });
            bad.add(name);
            continue;
        }
        byName.set(name, i);
        const v = p.value;
        if (typeof v === 'number') {
            if (!Number.isFinite(v)) { errors.push({ path: path + '.value', code: 'E_NOT_FINITE', message: 'The value must be a finite number.' }); bad.add(name); }
            parsed[i] = { constant: true, value: v, deps: [] };
        } else if (typeof v === 'string') {
            try {
                const e = parseExpr(v);
                parsed[i] = { constant: false, expr: e, deps: e.deps };
            } catch (err) {
                errors.push({ path: path + '.value', code: 'E_EXPR_SYNTAX', message: err.message });
                bad.add(name);
            }
        } else {
            errors.push({ path: path + '.value', code: 'E_TYPE', message: 'The value must be a number or an expression.' });
            bad.add(name);
        }
    }
    // depth-first topological sort with cycle detection
    const state = new Map();   // name -> 1 visiting, 2 done
    const stack = [];
    const inCycle = new Set();
    function visit(name) {
        const st = state.get(name);
        if (st === 2) return;
        if (st === 1) {
            const k = stack.indexOf(name);
            const cyc = stack.slice(k).concat(name);
            for (const m of stack.slice(k)) {
                if (inCycle.has(m)) continue;
                inCycle.add(m);
                const idx = byName.get(m);
                errors.push({ path: `params[${idx}].value`, code: 'E_PARAM_CYCLE', message: `Circular reference: ${cyc.join(' → ')}.` });
            }
            return;
        }
        state.set(name, 1);
        stack.push(name);
        const i = byName.get(name);
        const pr = parsed[i];
        if (pr) for (const d of pr.deps) if (byName.has(d)) visit(d);
        stack.pop();
        state.set(name, 2);
        order.push(name);
    }
    for (const name of byName.keys()) visit(name);
    for (const name of order) {
        const i = byName.get(name);
        const pr = parsed[i];
        if (!pr || bad.has(name) || inCycle.has(name)) { bad.add(name); continue; }
        const path = `params[${i}].value`;
        if (pr.constant) { values[name] = pr.value; continue; }
        const missing = pr.deps.filter((d) => !byName.has(d));
        if (missing.length) {
            errors.push({ path, code: 'E_EXPR_UNKNOWN', message: `Unknown parameter "${missing[0]}".` });
            bad.add(name);
            continue;
        }
        const broken = pr.deps.filter((d) => bad.has(d));
        if (broken.length) {
            errors.push({ path, code: 'E_PARAM_DEPENDS', message: `Depends on parameter "${broken[0]}", which has an error.` });
            bad.add(name);
            continue;
        }
        let v;
        try { v = pr.expr.evaluate(values); } catch (err) {
            errors.push({ path, code: 'E_EXPR_UNKNOWN', message: err.message });
            bad.add(name);
            continue;
        }
        if (!Number.isFinite(v)) {
            errors.push({ path, code: 'E_NOT_FINITE', message: `The expression gives ${v}, not a finite number.` });
            bad.add(name);
            continue;
        }
        values[name] = v;
    }
    return { values, errors, order };
}
