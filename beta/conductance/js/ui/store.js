// Observable settings shared by the tabs (spec 2.15): gas, temperature, custom gas data, discharge-coefficient
// override and display units. Browser module, but DOM-free (it also runs in Node tests).

import { gasState } from '../engine/gas.js';

export const STORE_DEFAULTS = Object.freeze({ gas: 'N2', T: 293.15, custom: null, Cd: null, lu: 'mm', su: 'L/s', pu: 'mbar' });

const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b))
    || (a && b && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

/**
 * A tiny observable store: get() returns the current state object (treat it as read-only); set(patch) merges the
 * patch and notifies subscribers with (state, changedKeys) when anything changed (returns true then);
 * subscribe(fn) returns an unsubscribe function.
 */
export function createStore(initial) {
    let state = Object.freeze({ ...(initial || {}) });
    const subs = new Set();
    return {
        get() { return state; },
        set(patch) {
            if (!patch || typeof patch !== 'object') return false;
            const changed = Object.keys(patch).filter((k) => !same(state[k], patch[k]));
            if (!changed.length) return false;
            state = Object.freeze({ ...state, ...patch });
            for (const fn of [...subs]) {
                try { fn(state, changed); } catch (_) { /* a failing subscriber must not stop the others */ }
            }
            return true;
        },
        subscribe(fn) {
            if (typeof fn !== 'function') return () => {};
            subs.add(fn);
            return () => { subs.delete(fn); };
        },
    };
}

export const store = createStore(STORE_DEFAULTS);

/** GasState of the store's settings (or of the settings s); throws RangeError for invalid custom values. */
export function currentGas(s = store.get()) {
    return gasState(s.gas, s.T, s.gas === 'custom' ? s.custom : null, s.Cd ?? null);
}
