// Prerender the REMPI planner's scheme table and reference lists into its HTML, so the page shows them
// without JavaScript, in print, and to search engines. The page's own script still rebuilds them from
// rempi-data.js on load, so the two cannot disagree in a browser.
//
// This runs the page's inline script against a stand-in DOM and keeps what it writes into
// #scheme-rows, #refs-data, #refs-papers and #refs-lasers. Nothing is formatted here, so the
// prerendered text is exactly what the page script produces.
//
//   node _scripts/prerender_rempi.mjs           rewrite tools/rempi-schemes/index.html
//   node _scripts/prerender_rempi.mjs --check   exit 1 if the file is out of date (writes nothing)
//
// Run it after editing rempi-data.js or the table and reference code in the page.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'rempi-schemes');
const pagePath = path.join(dir, 'index.html');
const html = fs.readFileSync(pagePath, 'utf8');
const data = fs.readFileSync(path.join(dir, 'rempi-data.js'), 'utf8');

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.includes('REMPI_DATA'));
if (scripts.length !== 1) throw new Error('expected one inline script that uses REMPI_DATA, found ' + scripts.length);

// a stand-in element: remembers what is assigned to it, ignores everything else the page does with it
const els = {};
function element() {
    const attrs = {};
    return {
        innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, dataset: {}, options: [], style: {},
        classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
        setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null }, attrs,
        addEventListener() {}, querySelector() { return element(); }, querySelectorAll() { return []; }
    };
}
let ready = null;
const ctx = {
    URL, console,
    document: {
        getElementById(id) { return els[id] || (els[id] = element()); },
        querySelector() { return element(); }, querySelectorAll() { return []; },
        addEventListener(type, fn) { if (type === 'DOMContentLoaded') ready = fn; }
    },
    // the calculator itself is not run: only the table and reference code after it matters here
    Calc: { fmt: {}, K: { c: 299792458, e: 1.602176634e-19, me: 9.1093837139e-31 }, create() { return {}; }, fail(m) { return new Error(m); }, copyText() {} }
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(data, ctx, { filename: 'rempi-data.js' });
vm.runInContext(scripts[0], ctx, { filename: 'index.html (inline script)' });
if (!ready) throw new Error('the page script did not register a DOMContentLoaded handler');
ready();

// one row or reference per line, indented under its parent, for readable diffs
const lines = (s, tag, ind) => s.split('</' + tag + '>').filter(Boolean).map(x => ind + '    ' + x + '</' + tag + '>').join('\n');
let out = html, done = 0;
function splice(id, tag, child, attr) {
    const el = els[id];
    if (!el || !el.innerHTML) throw new Error('the page script wrote nothing into #' + id);
    const re = new RegExp('(<' + tag + '\\b[^>]*\\bid="' + id + '"[^>]*>)[\\s\\S]*?(</' + tag + '>)');
    if (!re.test(out)) throw new Error('#' + id + ' not found in the page');
    out = out.replace(re, (m, open, close, at) => {
        const ind = /[ \t]*$/.exec(out.slice(0, at))[0];   // the indentation of the parent's own line
        if (attr && el.attrs[attr] !== undefined) {
            open = new RegExp('\\b' + attr + '="').test(open) ? open.replace(new RegExp('\\b' + attr + '="[^"]*"'), attr + '="' + el.attrs[attr] + '"')
                                                              : open.replace(/>$/, ' ' + attr + '="' + el.attrs[attr] + '">');
        }
        return open + '\n' + lines(el.innerHTML, child, ind) + '\n' + ind + close;
    });
    done++;
}
splice('scheme-rows', 'tbody', 'tr');
splice('refs-data', 'ol', 'li');
splice('refs-papers', 'ol', 'li');
splice('refs-lasers', 'ol', 'li', 'start');

if (html.includes('\r\n')) out = out.replace(/\r?\n/g, '\r\n');
if (process.argv.includes('--check')) {
    if (out !== html) { console.error('tools/rempi-schemes/index.html is out of date: run node _scripts/prerender_rempi.mjs'); process.exit(1); }
    console.log('tools/rempi-schemes/index.html is up to date (' + done + ' blocks).');
} else {
    if (out !== html) fs.writeFileSync(pagePath, out);
    console.log((out !== html ? 'Updated' : 'No change to') + ' tools/rempi-schemes/index.html: ' +
        (els['scheme-rows'].innerHTML.split('</tr>').length - 1) + ' table rows, ' +
        ['refs-data', 'refs-papers', 'refs-lasers'].reduce((n, id) => n + els[id].innerHTML.split('</li>').length - 1, 0) + ' references.');
}
