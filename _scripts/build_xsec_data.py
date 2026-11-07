"""Build the data files of the Absorption Cross-Section Atlas (beta/cross-sections/data/) from the cleaned archive in
E:/cdfoley-data/xsec/clean (see its README for sources, versions and licenses).

    python _scripts/build_xsec_data.py [archive/clean]

Writes data/index.json (species and dataset metadata, no spectra) and data/s/<n>.json (one spectrum each, loaded on demand).
Each spectrum is resampled to at most MAX_POINTS points, keeping its shape on a log σ scale (largest-triangle buckets),
so peaks and band heads survive; shorter spectra are kept whole. Non-positive and non-finite σ are dropped.
"""
import json, math, os, re, sys, datetime, unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLEAN = sys.argv[1] if len(sys.argv) > 1 else 'E:/cdfoley-data/xsec/clean'
OUT = os.path.join(ROOT, 'beta', 'cross-sections', 'data')
MAX_POINTS = 2000

SOURCES = {
    'tuvx': {'short': 'TUV-x', 'name': 'NCAR TUV-x photolysis data (cross sections, quantum yields, solar flux)', 'url': 'https://github.com/NCAR/tuv-x',
             'license': 'Apache License 2.0.', 'cite': 'the TUV-x data files and the original papers each file names.'},
    'mainz2013': {'short': 'MPI-Mainz 2013', 'name': 'The MPI-Mainz UV/VIS Spectral Atlas of Gaseous Molecules of Atmospheric Interest, 2013 snapshot',
                  'url': 'https://doi.org/10.5281/zenodo.6951', 'license': 'CC BY 4.0 (Zenodo record).',
                  'cite': 'H. Keller-Rudek, G. K. Moortgat, R. Sander and R. Sörensen, Earth Syst. Sci. Data 5, 365–373 (2013), doi:10.5194/essd-5-365-2013, and the original papers.'},
    'leiden': {'short': 'Leiden', 'name': 'Leiden database of photodissociation and photoionization cross sections', 'url': 'https://home.strw.leidenuniv.nl/~ewine/photo/',
               'license': 'No license stated; the database asks users to cite it and the original sources.',
               'cite': 'A. N. Heays, A. D. Bosman and E. F. van Dishoeck, Astron. Astrophys. 602, A105 (2017), doi:10.1051/0004-6361/201628742, and the original papers.'},
    'bremen': {'short': 'IUP Bremen', 'name': 'Institute of Environmental Physics, University of Bremen, molecular spectroscopy data', 'url': 'https://www.iup.uni-bremen.de/gruppen/molspec/databases/',
               'license': 'Distributed for research use; cite the papers.', 'cite': 'the original papers named with each dataset.'},
    'cfa': {'short': 'Harvard CfA', 'name': 'Harvard–Smithsonian Center for Astrophysics molecular spectroscopy database', 'url': 'https://lweb.cfa.harvard.edu/amp/ampdata/cfamols.html',
            'license': 'Distributed for research use; cite the papers.', 'cite': 'the original papers named with each dataset.'},
}


def key_of(formula):
    """File-safe key for a species: the formula with anything but letters, digits, +, - replaced."""
    k = unicodedata.normalize('NFKD', formula)
    return re.sub(r'[^A-Za-z0-9+\-]+', '_', k).strip('_') or 'x'


def resample(d, mx=MAX_POINTS):
    if len(d) <= mx:
        return d
    ly = [math.log10(max(p[1], 1e-40)) for p in d]
    out = [d[0]]; a = 0; n = len(d)
    bucket = (n - 2) / (mx - 2)
    for i in range(mx - 2):
        s = int(i * bucket) + 1; e = min(int((i + 1) * bucket) + 1, n - 1)
        ns = min(int((i + 1) * bucket) + 1, n - 1); ne = min(int((i + 2) * bucket) + 1, n)
        cnt = max(1, ne - ns)
        ax = sum(d[j][0] for j in range(ns, ne)) / cnt; ay = sum(ly[j] for j in range(ns, ne)) / cnt
        best, area = s, -1.0
        for j in range(s, e):
            ar = abs((d[a][0] - ax) * (ly[j] - ly[a]) - (d[a][0] - d[j][0]) * (ay - ly[a]))
            if ar > area:
                area, best = ar, j
        out.append(d[best]); a = best
    out.append(d[-1])
    return out


def sig(x):
    """σ to 5 significant figures; λ is kept as given (rounded to 1e-4 nm)."""
    return float('%.5g' % x)


def skip(r):
    """Datasets left out: not in cm² molecule⁻¹, or flagged by the archive's QA (e.g. NO2 Bass 1976, about 25x too high)."""
    return r.get('units') != 'cm2/molecule' or 'QA FLAG' in str(r.get('notes') or '')


def main():
    idx = json.load(open(os.path.join(CLEAN, 'index.json'), encoding='utf-8'))
    rows = [r for r in idx['datasets'] if r.get('kind') == 'cross_section']
    species = {}; skipped = []
    sdir = os.path.join(OUT, 's')
    if os.path.isdir(sdir):
        for f in os.listdir(sdir): os.remove(os.path.join(sdir, f))
    os.makedirs(sdir, exist_ok=True)
    if os.path.isdir(os.path.join(OUT, 'sp')):
        for f in os.listdir(os.path.join(OUT, 'sp')): os.remove(os.path.join(OUT, 'sp', f))
        os.rmdir(os.path.join(OUT, 'sp'))
    total = 0; nfile = 0
    for r in rows:
        if skip(r):
            skipped.append(r['id']); continue
        ds = json.load(open(os.path.join(CLEAN, r['path']), encoding='utf-8'))
        data = sorted(([float(p[0]), float(p[1])] for p in ds['data'] if len(p) >= 2 and p[0] is not None and p[1] is not None
                       and math.isfinite(float(p[0])) and math.isfinite(float(p[1])) and float(p[1]) > 0), key=lambda p: p[0])
        if not data:
            skipped.append(r['id']); continue
        orig = len(data)
        data = [[round(l, 4), sig(s)] for l, s in resample(data)]
        f = r.get('species_canonical') or r['species']; k = key_of(f)
        sp = species.setdefault(k, {'k': k, 'f': f, 'n': r.get('name') or '', 'cas': r.get('cas') or '', 'sets': []})
        if not sp['n'] and r.get('name'): sp['n'] = r['name']
        if not sp['cas'] and r.get('cas'): sp['cas'] = r['cas']
        ref = r.get('reference') or {}
        T = r.get('T_K')
        nfile += 1; fid = '%05d' % nfile
        notes = str(r.get('notes') or '').strip()
        sp['sets'].append({
            'id': r['id'], 'f': fid, 'src': r['source'], 'T': T, 'l': [round(data[0][0], 2), round(data[-1][0], 2)], 'np': len(data), 'n0': orig,
            'rec': bool(r.get('recommended')), 'med': r.get('lambda_medium') or 'unknown', 'res': r.get('resolution') or '',
            'ref': {'a': ref.get('authors') or '', 'y': ref.get('year') or '', 't': ref.get('title') or '', 'j': ref.get('journal') or '', 'doi': ref.get('doi') or ''},
            'y': ref.get('year') if isinstance(ref.get('year'), int) else (int(ref['year']) if str(ref.get('year') or '').isdigit() else None),
            'note': notes[:400],
        })
        p = os.path.join(sdir, fid + '.json')
        json.dump(data, open(p, 'w', encoding='utf-8'), separators=(',', ':'))
        total += os.path.getsize(p)
    used = sorted({s['src'] for sp in species.values() for s in sp['sets']})
    out = {'meta': {'built': datetime.date.today().isoformat(), 'archive': idx.get('generated', ''), 'max_points': MAX_POINTS,
                    'sources': {k: SOURCES.get(k, {'short': k, 'name': k}) for k in used}, 'skipped': skipped},
           'species': sorted(species.values(), key=lambda s: (-len(s['sets']), s['f']))}
    json.dump(out, open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('%d species, %d datasets (%d skipped), spectra %.1f MB in %d files, index %.2f MB' % (
        len(species), sum(len(s['sets']) for s in species.values()), len(skipped), total / 1e6, nfile, os.path.getsize(os.path.join(OUT, 'index.json')) / 1e6))


if __name__ == '__main__':
    main()
