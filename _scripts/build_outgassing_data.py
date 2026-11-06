"""Build the compact NASA outgassing (ASTM E595) table that tools/outgassing/ loads on demand.

    python _scripts/build_outgassing_data.py <path to outgassing.csv>            write tools/outgassing/nasa-e595.json
    python _scripts/build_outgassing_data.py <path to outgassing.csv> --check    exit 1 if the committed file differs

Input: the cleaned CSV of the full NASA Goddard outgassing database (13,582 rows), archived on 2026-11-06 from
https://etd.gsfc.nasa.gov/capabilities/outgassing-database/ (the page's own JSON endpoint, all rows in one response).
The archive is kept outside the repository; its SHA-256 is pinned below, so a different file is refused.
The data are a US Government work (NASA GSFC); credit NASA, imply no endorsement, and never use the NASA insignia.

Output (UTF-8, LF, one row per line so diffs stay readable):
  {"source", "accessed", "count", "cats": [...], "apps": [...], "cures": [...], "cols": [...], "rows": [[...], ...]}
  Each row: material, data_ref, mfr_code, TML %, CVCM %, WVR % (null when not measured), index into apps, year
  (null if unknown), index into cats, index into cures, and a trailing 1 when the category was matched from the
  Application text rather than taken from NASA's legacy export (null category: neither gives one).
  Rows keep the server's order (sorted by data reference), duplicates included, so the count equals NASA's.
Standard library only.
"""
import csv, hashlib, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'tools', 'outgassing', 'nasa-e595.json')
CSV_SHA256 = 'c34115acb02eb2b03b1e9e0693a4f6f29f8289cb1dc59b1a152db66e46af12ae'
EXPECTED_ROWS = 13582
# the 18 categories of the database's Section A plus Miscellaneous, in the order of the live site's filter list
CATS = ['Adhesives', 'Cable Insulation and Shrink Tubing', 'Conformal Coating', 'Electrical Components', 'Electrical Shields',
        'Films and Sheet Materials', 'Foams', 'Greases and Lubricants', 'Lacing Tape and Cord Cable Ties',
        'Laminates and Circuit Boards', 'Marking Materials and Inks', 'Miscellaneous', 'Molding Compounds',
        'Paints, Lacquers, and Varnishes', 'Potting Compounds', 'Rubber and Elastomers', 'Tapes', 'Thermal Greases']
UNIT = {'S': 's', 'SEC': 's', 'M': 'min', 'MIN': 'min', 'H': 'h', 'HR': 'h', 'HRS': 'h', 'D': 'd', 'DAY': 'd', 'DAYS': 'd',
        'W': 'wk', 'WK': 'wk', 'MO': 'mo', 'YR': 'yr'}


def num(s):
    s = s.strip()
    if not s: return None
    x = float(s)
    return int(x) if x == int(x) and abs(x) < 1e6 and '.' not in s else x


def atm(s):
    """Cure atmosphere as published, made readable: E-6 is a cure in vacuum at 1e-6 Torr (user guide, "Using the Data")."""
    s = s.strip()
    m = re.fullmatch(r'E-(\d+)', s)
    if m: return 'vacuum, 10%s Torr' % sup('-' + m.group(1))
    if s.upper() in ('AIR',): return 'air'
    if s.upper() in ('VAC', 'VACUUM'): return 'vacuum'
    if s.upper() in ('N2', 'GN2', 'NIT', 'NITROGEN'): return 'nitrogen'
    # 2019+ vacuum cures: NASA's own data lost the exponent (e.g. "1.5x10ø?"); keep the mantissa and mark the gap
    m = re.fullmatch(r'(\d*\.?\d+)\s*x\s*10[^\d\s]*\??', s)
    if m and not re.search(r'[\u2070-\u209f]\d*$', s): return 'vacuum, %s×10^?' % m.group(1)
    m = re.fullmatch(r'(\d*\.?\d+)\s*(?:x10\u00af\u2077| exponent -7)', s)
    if m: return 'vacuum, %s×10⁻⁷' % m.group(1)
    return s


def sup(s):
    return s.translate(str.maketrans('-0123456789', '⁻⁰¹²³⁴⁵⁶⁷⁸⁹'))


def step(time, temp, at):
    if not (time or temp or at): return ''
    out = time.strip()
    m = re.fullmatch(r'(\d*\.?\d+)\s*([A-Z]+)', out.upper())
    if m and m.group(2) in UNIT: out = m.group(1) + ' ' + UNIT[m.group(2)]
    if temp.strip():
        t = num(temp)
        out += (' at ' if out else '') + ('%g' % t) + ' °C'
    if at.strip(): out += (', ' if out else '') + atm(at)
    return out


def build(path):
    raw = open(path, 'rb').read()
    sha = hashlib.sha256(raw).hexdigest()
    if sha != CSV_SHA256: sys.exit('unexpected input (SHA-256 %s): expected the 2026-11-06 archive' % sha)
    rows = list(csv.DictReader(raw.decode('utf-8').splitlines()))
    assert len(rows) == EXPECTED_ROWS, len(rows)
    apps, cures = [], []
    ai, ci = {}, {}
    def idx(table, lookup, s):
        if s not in lookup: lookup[s] = len(table); table.append(s)
        return lookup[s]
    idx(apps, ai, ''); idx(cures, ci, '')
    cat_of = {c.lower(): i for i, c in enumerate(CATS)}
    # A row the legacy export does not categorize (the 2019+ tests, and its code 0) gets a category from its Application
    # text: the category's own name, or else the category that at least 90 % of the categorized rows with the same
    # Application text share, when at least 5 such rows exist. Such rows are flagged.
    by_app = {}
    for r in rows:
        if r['category_inferred'].strip(): by_app.setdefault(r['application'].strip(), []).append(r['category_inferred'].strip())
    # an Application text that is a category's own name ("ADHESIVES", "Rubbers & Elastomers"), as the newer tests use
    words = lambda t: tuple(w.rstrip('S') for w in re.sub(r'[^A-Z ]', ' ', t.upper().replace('&', ' AND ')).split())
    named = {words(c): c for c in CATS}
    app_cat = {a: named[words(a)] for a in set(r['application'].strip() for r in rows) if a and words(a) in named}
    for a, cs in by_app.items():
        if a in app_cat: continue
        top = max(set(cs), key=cs.count)
        if a and len(cs) >= 5 and cs.count(top) >= 0.9 * len(cs): app_cat[a] = top
    out = []
    for r in rows:
        cure = '; '.join(filter(None, (step(r['cure%d_time' % i], r['cure%d_temp_c' % i], r['cure%d_atm' % i]) for i in range(1, 5))))
        cat = r['category_inferred'].strip()
        guess = not cat and app_cat.get(r['application'].strip())
        row = [r['material'].strip(), r['data_ref'].strip(), r['mfr_code'].strip(),
               num(r['tml_pct']), num(r['cvcm_pct']), num(r['wvr_pct']),
               idx(apps, ai, r['application'].strip()), num(r['year']),
               cat_of[(cat or guess).lower()] if (cat or guess) else None, idx(cures, ci, cure)]
        if guess: row.append(1)
        out.append(row)
    head = {'source': 'NASA Goddard Space Flight Center, Outgassing Database (ASTM E595), '
                      'https://etd.gsfc.nasa.gov/capabilities/outgassing-database/',
            'accessed': '2026-11-06', 'count': len(out), 'cats': CATS, 'apps': apps, 'cures': cures,
            'cols': ['material', 'data_ref', 'mfr', 'tml', 'cvcm', 'wvr', 'app', 'year', 'cat', 'cure', 'cat_from_app']}
    js = lambda o: json.dumps(o, ensure_ascii=False, separators=(',', ':'))
    text = '{' + ',\n'.join('%s:%s' % (js(k), js(v)) for k, v in head.items()) + ',\n"rows":[\n' + ',\n'.join(js(r) for r in out) + '\n]}\n'
    json.loads(text)
    return text


if __name__ == '__main__':
    if len(sys.argv) < 2: sys.exit(__doc__)
    text = build(sys.argv[1])
    if '--check' in sys.argv:
        same = os.path.exists(OUT) and open(OUT, encoding='utf-8').read() == text
        print('nasa-e595.json is', 'up to date' if same else 'OUT OF DATE'); sys.exit(0 if same else 1)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f: f.write(text)
    print('wrote %s: %d rows, %d bytes' % (os.path.relpath(OUT, ROOT), EXPECTED_ROWS, len(text.encode('utf-8'))))
