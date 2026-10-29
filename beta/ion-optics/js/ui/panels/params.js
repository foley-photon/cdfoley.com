/* ==========================================================================
   Ion optics UI: panels/params.js
   Params rail tab (spec §4.3, §2.2.3): named parameters usable in any
   numeric field. Each row shows the value or expression (with its unit and
   evaluated value) and, when the parameter has a slider range, a slider
   (a drag is one undo step). The inspector editor renames a parameter and
   rewrites every expression that uses it, and sets the dimension, the note
   and the slider range.
   ========================================================================== */
import { h, icon, clear } from '../dom.js';
import { createField, bindForm, metaFor, normaliseDescriptor, storeEvalExpr, nextParamName, renameParamRefs } from '../forms.js';
import { formatPretty } from '../units.js';
import { niceLength } from '../tools.js';

const locParam = (name) => (p) => {
    const i = (p.params || []).findIndex((x) => x && x.name === name);
    return i >= 0 ? { obj: p.params[i], index: i, path: `params[${i}]` } : null;
};

/** Rail tab. */
export function mountParams(host, ctx, app) {
    const { store } = ctx;
    const listEl = h('ul', { class: 'io-list', 'aria-label': 'Parameters' });
    const empty = h('p', { class: 'io-empty', text: 'No parameters. A parameter is a named number (or expression) that any numeric field can use, for example D for a tube diameter and "D/2" for its radius.' });
    const addBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('plus', 16), h('span', { text: 'Add parameter' }));
    addBtn.addEventListener('click', () => addParam(ctx, app));
    host.append(h('p', { class: 'io-note', text: 'Expressions may use + − × / ^, sqrt, sin and cos (degrees), ln, exp, min, max, pi and other parameters.' }), listEl, empty, h('div', { class: 'io-add-row' }, addBtn));
    let sig = '', rows = [];
    function build() {
        const params = store.get().project.params || [];
        sig = params.map((q) => `${q.name}:${q.dim}:${q.slider ? 1 : 0}`).join('|');
        clear(listEl);
        rows = params.map((q, i) => {
            const name = q.name;
            const li = h('li', { class: 'io-item', dataset: { name } });
            const title = h('button', { type: 'button', class: 'io-item-title', text: name });
            title.addEventListener('click', () => { store.select({ kind: 'param', ids: [name] }); app.openInspector && app.openInspector(); });
            const del = h('button', { type: 'button', class: 'io-mini', title: 'Delete parameter', 'aria-label': `Delete parameter ${name}` }, icon('trash', 16));
            del.addEventListener('click', () => {
                const r = ctx.commit((p) => { const L = locParam(name)(p); if (L) p.params.splice(L.index, 1); }, { label: 'Delete parameter' });
                if (!r.ok && ctx.ui.toast) ctx.ui.toast(`${name} is still used: ${r.error}`, { kind: 'warn' });
            });
            const field = createField({ key: 'value', label: 'Value', kind: 'number', dim: q.dim || 'none' }, {
                evalExpr: storeEvalExpr(ctx), idPrefix: 'io-pv', wheel: q.dim === 'voltage',
                onCommit: (v, o) => ctx.commit((p) => { const L = locParam(name)(p); if (L) L.obj.value = v; }, { label: `Parameter ${name}`, merge: o.merge ? 'param:' + name : null }),
            });
            if (field.input) field.input.setAttribute('aria-label', `${name} value`);
            li.append(h('div', { class: 'io-item-row' }, title, h('span', { class: 'io-item-sub', text: q.dim && q.dim !== 'none' ? q.dim : '' }), h('span', { class: 'io-spacer' }), del), field.el);
            let range = null;
            if (q.slider) {
                range = h('input', { type: 'range', class: 'io-range', 'aria-label': `${name} slider` });
                range.addEventListener('input', () => {
                    const v = Number(range.value);
                    const r = ctx.commit((p) => { const L = locParam(name)(p); if (L) L.obj.value = v; }, { label: `Parameter ${name}`, merge: 'param:' + name });
                    if (!r.ok) field.setError(r.error);
                });
                li.appendChild(range);
            }
            const note = h('div', { class: 'hint' });
            li.appendChild(note);
            listEl.appendChild(li);
            return { li, field, range, note, name, i };
        });
        syncRows();
    }
    function syncRows() {
        const st = store.get();
        const params = st.project.params || [];
        const r = st.resolved || st.lastResolved;
        const vals = (r && r.paramValues) || {};
        empty.hidden = params.length > 0;
        const sel = st.selection || {};
        rows.forEach((row) => {
            const q = params[row.i];
            if (!q) return;
            row.field.sync(q.value, vals[q.name]);
            if (row.range && q.slider) {
                row.range.min = String(q.slider.min); row.range.max = String(q.slider.max);
                row.range.step = String(q.slider.step > 0 ? q.slider.step : niceLength((q.slider.max - q.slider.min) / 1000));
                const v = vals[q.name];
                row.range.disabled = !Number.isFinite(v) || typeof q.value !== 'number';
                if (Number.isFinite(v) && document.activeElement !== row.range) row.range.value = String(v);
                row.range.setAttribute('aria-valuetext', formatPretty(v, q.dim || 'none', 6));
            }
            row.note.textContent = q.note || '';
            row.note.hidden = !q.note;
            row.li.classList.toggle('io-selected', sel.kind === 'param' && (sel.ids || []).includes(q.name));
        });
    }
    function update() {
        const params = store.get().project.params || [];
        const s = params.map((q) => `${q.name}:${q.dim}:${q.slider ? 1 : 0}`).join('|');
        if (s !== sig) build(); else syncRows();
    }
    build();
    const offs = ['project', 'resolved', 'selection'].map((evt) => store.on(evt, update));
    return { update, destroy: () => offs.forEach((f) => f()) };
}

/** Adds a parameter and selects it. */
export function addParam(ctx, app, init = {}) {
    let name = null;
    const r = ctx.commit((p) => {
        p.params = p.params || [];
        name = init.name || nextParamName(p.params, 'p');
        p.params.push({ name, value: init.value === undefined ? 0 : init.value, dim: init.dim || 'none', note: init.note || '' });
    }, { label: 'Add parameter' });
    if (r.ok) { ctx.store.select({ kind: 'param', ids: [name] }); app.openInspector && app.openInspector(); }
    else if (ctx.ui.toast) ctx.ui.toast(r.error, { kind: 'warn' });
    return r.ok ? name : null;
}

/** Inspector editor for one parameter (renaming rewrites the expressions that use it). */
export function paramEditor(host, ctx, app, name0) {
    const { store } = ctx;
    let name = name0;
    const parse = ctx.engine.expr && ctx.engine.expr.parseExpr ? ctx.engine.expr.parseExpr : null;
    const title = h('h3');
    host.appendChild(h('div', { class: 'io-insp-head' }, icon('params', 18), title));
    // name with refactoring
    const nameField = createField({ key: 'name', label: 'Name', kind: 'text', pattern: '^[A-Za-z_]\\w*$', help: 'Renaming updates every expression that uses it.' }, {
        idPrefix: 'io-pn',
        onCommit: (v) => {
            if (v === name) return { ok: true };
            const old = name;
            const r = ctx.commit((p) => {
                const L = locParam(old)(p);
                if (!L) return;
                if ((p.params || []).some((q) => q.name === v)) throw new Error(`A parameter named ${v} already exists.`);
                L.obj.name = v;
                if (parse) renameParamRefs(p, old, v, parse);
            }, { label: 'Rename parameter' });
            if (r.ok) { name = v; store.select({ kind: 'param', ids: [v] }); }
            return r;
        },
    });
    host.appendChild(nameField.el);
    const formBox = h('div');
    host.appendChild(formBox);
    const sliderBox = h('div', { class: 'io-insp-section' });
    host.appendChild(sliderBox);
    let form = null, sliderForm = null, formDim = null, hadSlider = null;
    const sliderToggle = h('input', { type: 'checkbox', id: 'io-pslider-' + Math.random().toString(36).slice(2) });
    sliderToggle.addEventListener('change', () => {
        const st = store.get();
        const r = st.resolved || st.lastResolved;
        const v = r && r.paramValues ? r.paramValues[name] : 0;
        const a = Math.abs(v) || 1;
        const R = niceLength(2 * a);
        const res = ctx.commit((p) => {
            const L = locParam(name)(p);
            if (!L) return;
            if (sliderToggle.checked) L.obj.slider = { min: v < 0 ? -R : 0, max: R, step: niceLength(R / 500) };
            else delete L.obj.slider;
        }, { label: sliderToggle.checked ? 'Add slider' : 'Remove slider' });
        if (!res.ok && ctx.ui.toast) ctx.ui.toast(res.error, { kind: 'warn' });
    });
    function buildForm(dim) {
        clear(formBox);
        const descs = metaFor(ctx.engine.schema && ctx.engine.schema.META, 'param').map(normaliseDescriptor)
            .filter((d) => d.key !== 'name').map((d) => (d.key === 'value' ? { ...d, dim: dim || 'none', dimFrom: undefined } : d));
        form = bindForm(ctx, { descs, label: 'Edit parameter', idPrefix: 'io-pf', locate: (p) => locParam(name)(p), resolved: (r) => ({ value: r.paramValues ? r.paramValues[name] : undefined }), merge: (key) => (key === 'value' ? 'param:' + name : null) });
        formBox.appendChild(form.el);
        formDim = dim;
    }
    function update() {
        const p = store.get().project;
        const L = locParam(name)(p);
        if (!L) { clear(host); host.appendChild(h('p', { class: 'io-empty', text: 'This parameter was deleted.' })); return; }
        title.textContent = `Parameter ${name}`;
        nameField.sync(name);
        if (!form || formDim !== (L.obj.dim || 'none')) buildForm(L.obj.dim || 'none');
        form.sync();
        const has = !!L.obj.slider;
        if (has !== hadSlider) {
            hadSlider = has;
            clear(sliderBox);
            sliderBox.appendChild(h('label', { class: 'io-check', for: sliderToggle.id }, sliderToggle, h('span', { text: 'Show a slider in the Params tab' })));
            sliderForm = null;
            if (has) {
                sliderForm = bindForm(ctx, { kind: 'slider', label: 'Edit slider', idPrefix: 'io-ps', locate: (pp) => { const LL = locParam(name)(pp); return LL && LL.obj.slider ? { obj: LL.obj.slider, path: `${LL.path}.slider` } : null; } });
                sliderBox.appendChild(sliderForm.el);
            }
        }
        sliderToggle.checked = has;
        if (sliderForm) sliderForm.sync();
    }
    update();
    return { update };
}
