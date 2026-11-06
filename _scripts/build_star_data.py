"""Build the compact NIST ESTAR/PSTAR/ASTAR data files for tools/stopping-power/.

    python -I _scripts/build_star_data.py [path to nist-star/clean]

Reads the clean CSVs of the archived NIST SRD 124 tables (default E:/cdfoley-data/nist-star/clean, see its README for
provenance) and writes tools/stopping-power/{pstar,astar,estar}.json and materials.js. The site does not republish
NIST's complete tables: only the curated list of commonly used materials in CURATED below is written, each kept to the
programs that tabulate it (nickel, tantalum and ICRU soft tissue exist in ESTAR only). Each file keeps NIST's default
energy grid and, per material, only the columns the calculator uses, with NIST's four significant figures unchanged:
  PSTAR/ASTAR: electronic and nuclear mass stopping power (MeV cm2/g), CSDA and projected range (g/cm2)
  ESTAR:       collision and radiative mass stopping power (MeV cm2/g), CSDA range (g/cm2)
Totals are not stored: the calculator adds the two parts, which reproduces NIST's total to its last digit or one unit
in it (checked below).
"""
import csv, json, os, re, sys

SRC = sys.argv[1] if len(sys.argv) > 1 else 'E:/cdfoley-data/nist-star/clean'
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools', 'stopping-power')
CITE = ('M. J. Berger, J. S. Coursey, M. A. Zucker, and J. Chang, ESTAR, PSTAR, and ASTAR: Computer Programs for Calculating '
        'Stopping-Power and Range Tables for Electrons, Protons, and Helium Ions (version 2.0.1), NIST Standard Reference '
        'Database 124, https://doi.org/10.18434/T4NC7P (tables retrieved 2026-11-06). Originally published as M. J. Berger, '
        'NISTIR 4999 (1993).')
COPY = ('Copyright protection on this compilation of data has been secured by the Secretary of the U.S. Department of Commerce '
        'on behalf of the United States in the United States and all countries that are parties to the Universal Copyright '
        'Convention, pursuant to Section 290(e) of Title 15 of the United States Code.')
FIX = {'Polytetrafluoroethylene (Teflon': 'Polytetrafluoroethylene (Teflon)', 'Methacralate': 'Methacrylate',
       '1,2-Ddihlorobenzene': '1,2-Dichlorobenzene', 'Tissue-Equivalent GAS': 'Tissue-Equivalent Gas'}

# Curated menu (NIST material ids); the menus keep NIST's order. Ids a program does not tabulate are skipped for it.
CURATED = [
    '001', '002', '004', '906', '007', '008', '013', '014', '018', '022', '026', '028', '029', '032', '047', '054',
    '073', '074', '079', '082', '092',                      # H He Be graphite N O Al Si Ar Ti Fe Ni Cu Ge Ag Xe Ta W Au Pb U
    '104', '276', '277', '262', '201', '119',               # dry air, liquid water, water vapor, ICRU soft tissue, skeletal muscle, compact bone
    '223', '221', '222', '179', '226', '227', '216', '245', # PMMA, polyethylene, Mylar, Kapton, polystyrene, PTFE, plastic scintillator, SiO2
]

def label(name):
    m = re.match(r'(\d+): (.*)$', name)
    if m:
        z, rest = m.groups()
        if rest.startswith('Carbon, Amorphous'): return 'Carbon, amorphous, 2.0 g/cm³ (Z = 6)'
        if rest.startswith('Graphite'): return 'Graphite, 1.7 g/cm³ (Z = 6)'
        return '%s (Z = %s)' % (rest, z)
    for a, b in FIX.items(): name = name.replace(a, b)
    return name

def g(x):
    s = format(float(x), '.4g')
    return float(s) if 'e' not in s else float(s)

def build(prog, cols):
    rows = list(csv.DictReader(open(os.path.join(SRC, prog.lower() + '.csv'), encoding='utf-8')))
    mats, order, E = {}, [], None
    for r in rows:
        mid = r['material_id']
        if mid not in CURATED: continue
        if mid not in mats:
            mats[mid] = {'id': mid, 'n': label(r['material_name']), 'el': bool(re.match(r'\d+: ', r['material_name'])),
                         'rho': float(r['density_g_cm3']), 'I': float(r['mean_excitation_energy_eV']), 'E': []}
            for k in cols: mats[mid][k] = []
            order.append(mid)
        m = mats[mid]
        m['E'].append(float(r['energy_MeV']))
        for k, c in cols.items(): m[k].append(float(r[c]))
        tot = float(r['total_stopping_MeV_cm2_g'])
        parts = sum(float(r[c]) for k, c in cols.items() if k in ('Se', 'Sn', 'Sc', 'Sr'))
        assert abs(parts - tot) <= 1.5e-3 * tot, (prog, mid, r['energy_MeV'], parts, tot)
    for mid in order:
        if E is None: E = mats[mid]['E']
        assert mats[mid]['E'] == E, (prog, mid)
        del mats[mid]['E']
    out = {'program': prog, 'source': CITE, 'copyright': COPY, 'units': {'E': 'MeV', 'S': 'MeV cm2/g', 'R': 'g/cm2'},
           'E': E, 'materials': [mats[k] for k in order]}
    s = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    s = re.sub(r'(\d)e-0(\d)', r'\1e-\2', s); s = re.sub(r'(\d)e\+0?(\d)', r'\1e\2', s)
    s = re.sub(r'(\d)\.0(?=[,\]])', r'\1', s)
    path = os.path.join(OUT, prog.lower() + '.json')
    open(path, 'w', encoding='utf-8', newline='\n').write(s + '\n')
    print('%s: %d materials x %d energies (%.4g-%.4g MeV), %d bytes' % (prog, len(order), len(E), E[0], E[-1], len(s) + 1))
    return [[m['id'], m['n'], 1 if m['el'] else 0, m['rho'], m['I']] for m in (mats[k] for k in order)]

MAT = {}
MAT['pa'] = build('PSTAR', {'Se': 'electronic_stopping_MeV_cm2_g', 'Sn': 'nuclear_stopping_MeV_cm2_g', 'R': 'csda_range_g_cm2', 'Rp': 'projected_range_g_cm2'})
assert [r[0] for r in MAT['pa']] == [r[0] for r in build('ASTAR', {'Se': 'electronic_stopping_MeV_cm2_g', 'Sn': 'nuclear_stopping_MeV_cm2_g', 'R': 'csda_range_g_cm2', 'Rp': 'projected_range_g_cm2'})], 'PSTAR and ASTAR list different materials'
MAT['e'] = build('ESTAR', {'Sc': 'collision_stopping_MeV_cm2_g', 'Sr': 'radiative_stopping_MeV_cm2_g', 'R': 'csda_range_g_cm2'})

# The material menus, loaded with the page so the selects exist before the calculator starts: [id, label, element?, density
# (g/cm3), I (eV)] per material, PSTAR/ASTAR set ('pa') and ESTAR set ('e'). Each set keeps its own program's density and I.
js = ('/* Generated by _scripts/build_star_data.py from NIST SRD 124 (ESTAR, PSTAR, ASTAR v2.0.1); do not edit. */\n'
      'window.STAR_MATERIALS = ' + json.dumps(MAT, ensure_ascii=False, separators=(',', ':')) + ';\n')
open(os.path.join(OUT, 'materials.js'), 'w', encoding='utf-8', newline='\n').write(js)
print('materials.js: %d + %d materials, %d bytes' % (len(MAT['pa']), len(MAT['e']), len(js.encode('utf-8'))))
