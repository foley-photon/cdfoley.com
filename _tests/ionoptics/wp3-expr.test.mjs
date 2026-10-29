// WP3 acceptance (1): expressions — precedence, right-associative ^, unary minus, degree trigonometry, column-numbered
// errors, parameter order and cycle paths (spec §2.2.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseExpr, evaluateParams, evalValue, isIdentifier, RESERVED_NAMES } from '../../beta/ion-optics/js/engine/expr.js';

const ev = (s, vars = {}) => parseExpr(s).evaluate(vars);
/** Asserts that `src` fails to parse with an EngineError E_BAD_PROJECT at `column` (1-based). */
function failsAt(src, column, re = null) {
    assert.throws(() => parseExpr(src), (e) => {
        assert.equal(e.name, 'EngineError');
        assert.equal(e.code, 'E_BAD_PROJECT');
        assert.equal(e.detail.column, column, `${JSON.stringify(src)}: ${e.message}`);
        assert.ok(e.message.includes(`column ${column}`), e.message);
        if (re) assert.match(e.message, re);
        return true;
    });
}

test('precedence and associativity', () => {
    const cases = [
        ['1+2*3', 7], ['(1+2)*3', 9], ['2*3^2', 18], ['2^3^2', 512], ['(2^3)^2', 64], ['10-4-3', 3], ['12/3/2', 2],
        ['2+3*4^2/8-1', 7], ['1-2*-3', 7], ['8/-2^2', 2], ['2^-1', 0.5], ['2^-2^-1', 2 ** -(2 ** -1)], ['1.5e3+2.5E-1', 1500.25],
        ['.5+.25', 0.75], ['3*(4+(5-2)*2)', 30],
    ];
    for (const [s, v] of cases) assert.equal(ev(s), v, s);
});

test('unary minus and plus (factor := unary (^ factor)?, so -2^2 = (-2)^2)', () => {
    assert.equal(ev('-2^2'), 4);
    assert.equal(ev('-(2^2)'), -4);
    assert.equal(ev('0-2^2'), -4);
    assert.equal(ev('--3'), 3);
    assert.equal(ev('+-+3'), -3);
    assert.equal(ev('-a', { a: 5 }), -5);
    assert.equal(ev('-a^2', { a: 3 }), 9);
    assert.equal(ev('2*-a', { a: 3 }), -6);
});

test('trigonometry in degrees, exact at multiples of 30° and 45°', () => {
    assert.equal(ev('sin(30)'), 0.5);
    assert.equal(ev('cos(60)'), 0.5);
    assert.equal(ev('cos(90)'), 0);
    assert.equal(ev('sin(180)'), 0);
    assert.equal(ev('sin(-30)'), -0.5);
    assert.equal(ev('cos(720+60)'), 0.5);
    assert.equal(ev('tan(45)'), 1);
    assert.equal(ev('tan(135)'), -1);
    assert.equal(ev('sin(45)'), Math.SQRT1_2);
    assert.ok(Math.abs(ev('sin(10)') - Math.sin(Math.PI / 18)) < 1e-15);
    assert.ok(Math.abs(ev('asin(0.5)') - 30) < 1e-12);
    assert.ok(Math.abs(ev('acos(-1)') - 180) < 1e-12);
    assert.ok(Math.abs(ev('atan(1)') - 45) < 1e-12);
    assert.ok(Math.abs(ev('atan2(1, -1)') - 135) < 1e-12);
    assert.ok(Number.isNaN(ev('tan(90)')), 'tan(90°) is undefined');
});

test('other functions and pi', () => {
    const cases = [['sqrt(16)', 4], ['abs(-3)', 3], ['exp(0)', 1], ['ln(exp(2))', 2], ['log10(1000)', 3], ['min(3, 1, 2)', 1], ['max(3, 1, 2)', 3],
        ['pow(2, 10)', 1024], ['floor(-1.5)', -2], ['ceil(1.2)', 2], ['round(2.5)', 3], ['hypot(3, 4)', 5], ['hypot(1, 2, 2)', 3], ['2*pi', 2 * Math.PI],
        ['min(5)', 5]];
    for (const [s, v] of cases) assert.ok(Math.abs(ev(s) - v) < 1e-12 * Math.max(1, Math.abs(v)), `${s} = ${ev(s)}`);
});

test('syntax errors carry the column', () => {
    failsAt('1 + * 2', 5, /Unexpected "\*"/);
    failsAt('2 + foo(3)', 5, /Unknown function "foo"/);
    failsAt('sin 30', 1, /needs arguments in parentheses/);
    failsAt('(1+2', 5, /Expected "\)"/);
    failsAt('1..2', 1, /Malformed number/);
    failsAt('3e', 1, /Malformed number/);
    failsAt('2x', 1, /Malformed number/);
    failsAt('3 $ 4', 3, /Unexpected character "\$"/);
    failsAt('', 1, /Empty expression/);
    failsAt('   ', 1, /Empty expression/);
    failsAt('sqrt(1, 2)', 1, /sqrt\(\) takes 1 argument, got 2/);
    failsAt('atan2(1)', 1, /atan2\(\) takes 2 arguments, got 1/);
    failsAt('max()', 1, /at least 1 argument/);
    failsAt('1 2', 3, /Unexpected number 2/);
    failsAt('(1)(2)', 4, /Unexpected "\("/);
    failsAt('a +', 4, /end of expression/);
    assert.throws(() => parseExpr(42), (e) => e.code === 'E_BAD_PROJECT');
    assert.throws(() => parseExpr('1+'.repeat(1001) + '1'), (e) => e.code === 'E_BAD_PROJECT' && /2000 characters/.test(e.message));
});

test('unknown names fail at evaluation with their column; deps lists the parameters used', () => {
    const e = parseExpr('2*a + b - a');
    assert.deepEqual([...e.deps], ['a', 'b']);
    assert.equal(e.constant, false);
    assert.equal(e.evaluate({ a: 1, b: 2 }), 3);
    assert.equal(e.evaluate(new Map([['a', 1], ['b', 2]])), 3);
    assert.throws(() => e.evaluate({ a: 1 }), (err) => err.code === 'E_BAD_PROJECT' && err.detail.column === 7 && err.detail.name === 'b');
    assert.equal(parseExpr('2*pi').constant, true);
    assert.deepEqual([...parseExpr('sin(30)*pi').deps], []);
    // inherited object properties are not parameters
    assert.throws(() => ev('toString + 1', {}), (err) => err.code === 'E_BAD_PROJECT');
});

test('evalValue and identifiers', () => {
    assert.equal(evalValue(3), 3);
    assert.equal(evalValue('D/2', { D: 20 }), 10);
    assert.throws(() => evalValue(null), (e) => e.code === 'E_BAD_PROJECT');
    assert.ok(isIdentifier('Vc') && isIdentifier('_x1') && isIdentifier('constructor'));
    assert.ok(!isIdentifier('1a') && !isIdentifier('a-b') && !isIdentifier('sin') && !isIdentifier('pi') && !isIdentifier(''));
    for (const f of ['sqrt', 'abs', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'exp', 'ln', 'log10', 'min', 'max', 'pow', 'floor', 'ceil', 'round', 'hypot', 'pi']) assert.ok(RESERVED_NAMES.includes(f), f);
});

test('parameters are evaluated in dependency order', () => {
    const r = evaluateParams([
        { name: 'r2', value: 'r1 + gap' }, { name: 'gap', value: 2 }, { name: 'r1', value: 'D/2' }, { name: 'D', value: 20 }, { name: 'V', value: '2*Ep*(100/r2 - 1)' }, { name: 'Ep', value: 100 },
    ]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual({ ...r.values }, { r2: 12, gap: 2, r1: 10, D: 20, V: 2 * 100 * (100 / 12 - 1), Ep: 100 });
    assert.ok(r.order.indexOf('D') < r.order.indexOf('r1') && r.order.indexOf('r1') < r.order.indexOf('r2') && r.order.indexOf('r2') < r.order.indexOf('V'));
    // names that collide with Object built-ins work as ordinary parameters
    const o = evaluateParams([{ name: 'constructor', value: 3 }, { name: '__proto__', value: 'constructor*2' }, { name: 'x', value: '__proto__ + 1' }]);
    assert.deepEqual(o.errors, []);
    assert.equal(o.values.x, 7);
});

test('cycles are errors at the path of every parameter on the cycle; dependants are reported', () => {
    const r = evaluateParams([
        { name: 'a', value: 'b + 1' }, { name: 'b', value: 'c + 1' }, { name: 'c', value: 'a + 1' }, { name: 'd', value: 'a*2' }, { name: 'e', value: 5 }, { name: 's', value: 's+1' },
    ]);
    const byPath = new Map(r.errors.map((e) => [e.path, e]));
    for (const p of ['params[0].value', 'params[1].value', 'params[2].value', 'params[5].value']) {
        assert.equal(byPath.get(p) && byPath.get(p).code, 'E_PARAM_CYCLE', p);
        assert.match(byPath.get(p).message, /Circular reference/);
    }
    assert.match(byPath.get('params[0].value').message, /a → b → c → a/);
    assert.equal(byPath.get('params[3].value').code, 'E_PARAM_DEPENDS');
    assert.deepEqual({ ...r.values }, { e: 5 });
});

test('parameter name, value and reference errors have paths', () => {
    const r = evaluateParams([
        { name: '1bad', value: 1 }, { name: 'sin', value: 1 }, { name: 'pi', value: 3 }, { name: 'ok', value: 1 }, { name: 'ok', value: 2 },
        { name: 'u', value: 'nope*2' }, { name: 'z', value: '1/0' }, { name: 'q', value: '(1+' }, { name: 'w', value: true }, null, { name: 'n', value: NaN },
    ]);
    const codes = Object.fromEntries(r.errors.map((e) => [e.path, e.code]));
    assert.equal(codes['params[0].name'], 'E_PARAM_NAME');
    assert.equal(codes['params[1].name'], 'E_PARAM_RESERVED');
    assert.equal(codes['params[2].name'], 'E_PARAM_RESERVED');
    assert.equal(codes['params[4].name'], 'E_PARAM_DUPLICATE');
    assert.equal(codes['params[5].value'], 'E_EXPR_UNKNOWN');
    assert.equal(codes['params[6].value'], 'E_NOT_FINITE');
    assert.equal(codes['params[7].value'], 'E_EXPR_SYNTAX');
    assert.equal(codes['params[8].value'], 'E_TYPE');
    assert.equal(codes['params[9]'], 'E_TYPE');
    assert.equal(codes['params[10].value'], 'E_NOT_FINITE');
    assert.match(r.errors.find((e) => e.path === 'params[7].value').message, /column \d+/);
});

test('expressions are parsed, never executed as code', () => {
    const src = readFileSync(new URL('../../beta/ion-optics/js/engine/expr.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/\beval\s*\(/.test(src) && !/\bFunction\s*\(/.test(src) && !/new\s+Function/.test(src));
    for (const s of ['constructor.constructor("x")()', 'a.b', 'a[0]', '`1`', '"x"', 'a=1', 'a;b']) assert.throws(() => parseExpr(s), (e) => e.code === 'E_BAD_PROJECT', s);
});
