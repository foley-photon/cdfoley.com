// Ultraviolet transmittance by LBNL WINDOW's NFRC method, written independently of the page code for the tests.
// W5_NFRC_2003.std (pyWinCalc standards, commit a55b866), method TUV: source spectrum ASTM E891 Table 1, wavelength
// set = the source's own points, trapezoidal rule, 0.31 to 0.38 µm. The E891 table is read straight from
// _scripts/data/wce/standardData.cpp (Windows-CalcEngine 1dedefa), not from the generated glazing-solar-e891.js.
// T is a spectrum on the engine grid, 300 + 5i nm (every E891 point from 310 to 380 nm lies on that grid).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './load.mjs';

const cpp = fs.readFileSync(path.join(ROOT, '_scripts/data/wce/standardData.cpp'), 'utf8');
const i0 = cpp.indexOf('solarRadiationASTM_E891_87_Table1()');
const body = cpp.slice(cpp.indexOf('return', i0), cpp.indexOf('};', i0));
export const E891_UV = [...body.matchAll(/\{\s*([0-9.]+)\s*,\s*([0-9.eE+-]+)\s*\}/g)]
    .map(m => [Math.round(Number(m[1]) * 1e6) / 1e3, Number(m[2])])
    .filter(([nm]) => nm >= 310 && nm <= 380);

export function tuvWindow(T) {
    let num = 0, den = 0;
    for (let j = 1; j < E891_UV.length; j++) {
        const [la, ea] = E891_UV[j - 1], [lb, eb] = E891_UV[j], dl = lb - la;
        const ta = T[Math.round((la - 300) / 5)], tb = T[Math.round((lb - 300) / 5)];
        num += 0.5 * (ta * ea + tb * eb) * dl;
        den += 0.5 * (ea + eb) * dl;
    }
    return num / den;
}
