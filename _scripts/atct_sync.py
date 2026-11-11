"""Refresh the Thermochemistry Lab's ATcT data (beta/thermochem/data/) from the ATcT API, one TN version at a time.

    python _scripts/atct_sync.py                     fetch /all/ once; stop there when that version is already shipped
    python _scripts/atct_sync.py --force             rebuild even when the version is unchanged
    python _scripts/atct_sync.py --raw-dir DIR       also save every raw API response, a request log, README.md and
                                                     SHA256SUMS.txt under DIR (a new folder: one live run per folder)
    python _scripts/atct_sync.py --max-cov-requests N   request budget for the covariances (default 2000: every pair of the target species)
    python _scripts/atct_sync.py --from-raw DIR      rebuild from the responses an earlier --raw-dir run saved (no requests)
    python _scripts/atct_sync.py --compare-to FILE   table JSON or /all/ JSON of another TN version for the covariance
                                                     version test (default: the table shipped now)

Every request goes through the official ATcT Python client ("atct" on PyPI, D. H. Bross and B. Ruscic, Argonne,
BSD 3-clause): its HTTP layer, its default User-Agent and its base URL. No other headers, no API key, no personal data.
Politeness: at most one request every 4 s (the API allows 100 per minute), backoff on 429 and 5xx, and a hard stop on
403 or an HTML page (a challenge is never retried or worked around). A run that finds no new version makes exactly one
request (/all/); so does a run that waits for ATcT's covariances to catch up (see "Pending" below).

Exit codes: 0 written, up to date, or still waiting on a version already noted as pending; 1 a check failed (nothing
written); 2 blocked or challenged (403 or an HTML page); 3 HTTP 400/404 or no answer after 5 tries; 4 the covariances
are not those of the new version yet (only the "pending" note in atct-current.json is written).

What it writes (only after every check passed; nothing else is touched otherwise):
  atct-tn<ver>.json      the table the page loads (cols/rows/syn/hill/meta, the format of the earlier
                         build_site_data.py). Every enthalpy, uncertainty and mass is from this run's /all/ response;
                         composition and charge are parsed from the API formula (the API's charge field drops the sign
                         of multiply charged anions, so the formula's suffix decides, and any other disagreement stops
                         the run); names and the CAS, SMILES and species number come from the API too. Only descriptive
                         fields the API lacks are carried over from the table shipped before, by ATcT ID or CAS:
                         InChIKeys, synonym lists and Hill-formula aliases (an alias is kept only while its composition
                         and charge still match).
  atct-cov-tn<ver>.json  ATcT covariances of DfH(298.15 K) from the same run and version, in the sparse correlation
                         form engine.js reads (as the earlier cov/build_tool.py wrote it: tau 0.001, rho rounded to
                         0.5 % of the variances it affects).
  atct-current.json      version, fetch time (UTC), dataset DOI, file names, counts, request count, the covariance
                         version test, and the client and numpy versions.
  index.html             (next to the data folder) its preload of the table is pointed at the new table file.
Then data files that neither the new nor the previous atct-current.json names are removed: the previous version's files
stay until the next version, so a browser or cache still holding the old atct-current.json finds the files it names.

Covariances: the endpoint returns the full N x N block for the ATcT IDs asked, but at most 50 per request (HTTP 400
"too_many_species" above that; tested 2026-11-06 and again 2026-11-10). So the target species are put on the points of
a projective plane PG(2, q), s species per point, and each line (q + 1 points, at most 50 species) is one request:
every pair of points shares exactly one line, so every pair of species meets in some request. The design is the
smallest plane that holds the whole target within the request budget; when none does, the target is cut, by ATcT rank,
to what the budget's largest plane holds. Target (rules of the earlier cov/build_target.py): gas-phase species with
at most 3 non-hydrogen atoms, larger gas-phase species ranked <= 800, and a short list of common named ones.

Are the covariances of the version of /all/? The covariance responses carry no version, so it is read from the
diagonal. Only species whose printed uncertainty changed clearly between the shipped (or --compare-to) version and the
new one can tell, by more than max(one printed digit, 10 %); sqrt(diagonal) must lie closer to the new printed value
than to the old one for at least 90 % of them (2026-11-10, against TN 1.220: the TN 1.228 covariances 57 of 57 among the
species fetched, the TN 1.220 matrix 4 of 129). One probe request with up to 48 such species comes first, so a covariance
store that lags its table stops the run after 2 requests. After the plan the same test runs on all species fetched,
together with a looser one against this version's printed uncertainties alone: at least 82 % within max(half a printed
digit, 3 %) and at most 1 % off by more than 25 % (TN 1.228 covariances: 87 % and 0 %; the TN 1.220 matrix against the
same values: 73 % and 3 %; the printed value is not exactly sqrt(diagonal), median ratio 0.99, so a tighter test would
reject ATcT's own data). With fewer than 5 telling species the version test cannot decide and is recorded as
"unverified"; the looser test then decides alone.
Pending: when a version test fails, atct-current.json keeps the shipped version and gains a "pending" note (version,
sha256 of /all/, since, reason). After a failed probe the next run tries the probe again (2 requests a week); after a
failure at the end of the full plan, runs wait 28 days (1 request each) unless /all/ changes, so a lagging covariance
store does not cost a full fetch every week. Other checks: every block symmetric, the species returned are those asked,
repeats of an entry identical (also between the probe and the plan), every pair covered.

Depends on the "atct" package and numpy only.
"""
import argparse, asyncio, datetime, hashlib, json, math, os, re, sys, time
from pathlib import Path

os.environ.setdefault('ATCT_TIMEOUT_S', '120')     # the client's default is 10 s; /all/ is 1.5 MB
import numpy as np
from atct.api import _http
from atct.api._config import settings
try:
    from importlib.metadata import version as _pkg_version
    CLIENT_VERSION = _pkg_version('atct')
except Exception:
    import atct
    CLIENT_VERSION = getattr(atct, '__version__', '?')

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'beta' / 'thermochem' / 'data'
CURRENT = 'atct-current.json'
GAP_S = 4.0            # seconds between request starts (about 15 per minute, well under the 100 the API allows)
MAX_SPECIES = 50       # server cap per covariance request
TAU, PREC = 0.001, 0.005
PROBE_N = 48           # species in the version probe (a plan line holds 48 too)
VC_MIN, VC_PASS = 5, 0.9    # telling species needed for a verdict; share of them that must follow the new version
RETRY_DAYS = 28        # wait after a full plan whose covariances turned out not to be of the new version
# ATcT values as DOE datasets (Ruscic and Bross); DOI by TN version
DOI = {'1.220': '10.17038/CSE/2568691', '1.222': '10.17038/CSE/3399421', '1.226': '10.17038/CSE/3703521',
       '1.228': '10.17038/CSE/3703591'}
DATASET_YEAR = {'1.220': 2025, '1.228': 2026}     # publication year of the dataset, where known
NAMED = {'Benzene', 'Ethanol', 'Acetone', 'Toluene', 'Phenol', 'Naphthalene', 'Pyridine', 'Acetic acid', 'n-Butane',
         'iso-Butane', '1,3-Butadiene', 'Cyclopentadiene', 'Methyl formate', 'Nitric acid', 'Sulfur trioxide',
         'Tetrachloromethane', 'Chloroform', 'Tetrafluoromethane', 'Sulfur hexafluoride', 'Dinitrogen tetroxide',
         'Dinitrogen pentoxide', 'Furan', 'Cyclohexane', 'n-Hexane', 'n-Pentane', '1-Propanol', '2-Propanol',
         'Dimethyl ether', 'Urea', 'Glycine', 'Nitromethane', 'Benzyl', 'Phenyl', 'Phenoxy', 'Styrene', 'Phenylethene',
         'Sulfuric acid', 'Acetaldehyde', 'Formic acid', 'Methyl acetate', 'Diethyl ether', 'Isoprene', 'Cyclopentane'}


class Stop(Exception):
    def __init__(self, code, msg):
        super().__init__(msg); self.code = code


class Hold(Exception):
    """The covariance store is not (yet) on the version of /all/: noted as pending (see the module docstring)."""
    def __init__(self, reason, retry_days=0):
        super().__init__(reason); self.reason = reason; self.retry_days = retry_days


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


# ── HTTP (the client's own layer) ───────────────────────────────────────────
class Api:
    def __init__(self, raw_dir, replay=None):
        self.raw = Path(raw_dir) if raw_dir else None
        self.replay = Path(replay) if replay else None
        self.count = 0; self.last = 0.0; self.bytes = 0; self.last_sha = None
        if self.raw:
            (self.raw / 'covariance').mkdir(parents=True, exist_ok=True)

    async def _get(self, url, params):
        async with _http._get_client() as client:
            return await client.get(url, params=params)

    def get(self, path, params=None, name='', n=''):
        """GET settings.url(path), paced and retried; returns the parsed JSON. Saves the raw body when --raw-dir.
        With --from-raw, the body an earlier run saved under the same name is read instead (no request)."""
        if self.replay:
            body = (self.replay / name).read_bytes(); self.last_sha = hashlib.sha256(body).hexdigest()
            return json.loads(body)
        url = settings.url(path)
        for attempt in range(5):
            wait = self.last + GAP_S - time.time()
            if wait > 0:
                time.sleep(wait)
            self.last = time.time(); when = utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'); self.count += 1
            try:
                r = asyncio.run(self._get(url, params)); code, ctype, body = r.status_code, r.headers.get('content-type', ''), r.content
            except Exception as e:      # network error or timeout
                code, ctype, body = 0, '', repr(e).encode()
            self.bytes += len(body)
            if self.raw:
                (self.raw / name).write_bytes(body)
                with open(self.raw / 'requests.tsv', 'a', encoding='utf-8', newline='\n') as f:
                    f.write('\t'.join([when, name, str(n), str(code), ctype, str(len(body)), '%.2f' % (time.time() - self.last),
                                       hashlib.sha256(body).hexdigest()]) + '\n')
            if code == 200 and 'json' in ctype:
                self.last_sha = hashlib.sha256(body).hexdigest()
                return json.loads(body)
            if code in (401, 403) or 'html' in ctype:
                raise Stop(2, f'{path}: HTTP {code} {ctype}: blocked or challenged; not retrying')
            if code in (400, 404):
                raise Stop(3, f'{path}: HTTP {code}: {body[:300].decode("utf-8", "replace")}')
            if attempt == 4:
                break
            if code == 429:
                ra = r.headers.get('retry-after', '')
                delay = max(60.0, float(ra)) if ra.replace('.', '', 1).isdigit() else 60.0
            else:
                delay = (15, 60, 180, 300)[attempt]
            print(f'  {name}: HTTP {code or "error"}, retrying in {delay:.0f} s', flush=True)
            time.sleep(delay)
        raise Stop(3, f'{path}: giving up after 5 attempts (last HTTP {code})')


# ── table ───────────────────────────────────────────────────────────────────
def parse_formula(f):
    """ATcT formula ("[OC(O)O]-2", "(OS(O)(OH)2)(H2O)2") -> (composition, charge from the suffix or None)."""
    q = None; body = f
    m = re.search(r'(?<=[\]A-Za-z0-9)])([+-])(\d*)$', f)
    if m:
        q = (1 if m.group(1) == '+' else -1) * (int(m.group(2)) if m.group(2) else 1); body = f[:m.start()]
    stack = [{}]; i = 0
    while i < len(body):
        c = body[i]
        if c in '([':
            stack.append({}); i += 1
        elif c in ')]':
            i += 1; n = re.match(r'\d*', body[i:]).group(); i += len(n)
            if len(stack) < 2:
                raise ValueError(f'unbalanced formula {f!r}')
            top = stack.pop()
            for e, k in top.items():
                stack[-1][e] = stack[-1].get(e, 0) + k * (int(n) if n else 1)
        else:
            m2 = re.match(r'([A-Z][a-z]?)(\d*)', body[i:])
            if not m2:
                raise ValueError(f'cannot parse formula {f!r} at {i}')
            e = m2.group(1); stack[-1][e] = stack[-1].get(e, 0) + (int(m2.group(2)) if m2.group(2) else 1); i += m2.end()
    if len(stack) != 1:
        raise ValueError(f'unbalanced formula {f!r}')
    return stack[0], q


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def build_table(api, ver, fetched, prev):
    """Rows in the page's column order from the /all/ records; descriptive extras carried over from `prev`."""
    cols = ['n', 'id', 'name', 'formula', 'state', 'q', 'comp', 'h0', 'h298', 'u', 'utext', 'mass', 'cas', 'smiles', 'inchikey']
    pix = {c: i for i, c in enumerate(prev['cols'])} if prev else {}
    prow = {r[pix['id']]: r for r in prev['rows']} if prev else {}
    rows, notes = [], []
    for n, a in enumerate(api, 1):
        m = re.fullmatch(r'(.*?)\s+\((.*)\)', a['Formula'].strip())
        if not m:
            raise Stop(1, f'unexpected Formula field {a["Formula"]!r} ({a["ATcT_ID"]})')
        formula, st = m.group(1), m.group(2).strip()
        comp, qf = parse_formula(formula)
        q = int(a['charge'])
        if (qf is None and q != 0) or (qf is not None and abs(qf) != abs(q)):
            raise Stop(1, f'{a["ATcT_ID"]}: charge {a["charge"]} disagrees with formula {formula!r}; not guessing')
        if qf is not None:
            q = qf
        ut = str(a['Delta_Hf298K_uncertainty'] or '').replace('±', '').strip()
        u = 0.0 if ut.lower() == 'exact' else num(ut)
        h0, h298 = num(a['Delta_Hf_0K']), num(a['Delta_Hf_298K'])
        if h298 is None or u is None:
            raise Stop(1, f'{a["ATcT_ID"]}: missing 298.15 K value or uncertainty in /all/: {a}')
        old = prow.get(a['ATcT_ID'])
        rows.append([n, a['ATcT_ID'], a['Name'], formula, st, q, comp, h0, h298, u, ut, num(a['mass']), a['CASRN'] or '',
                     a['SMILES'] or '', old[pix['inchikey']] if old else ''])
    syn = dict((prev or {}).get('syn', {}))     # keyed by CAS; includes the electron's, which is not an ATcT row
    by_cas = {}
    for r in rows:
        by_cas.setdefault(r[12], []).append((r[6], r[5]))
    hill = {}
    for cas, lab in (prev or {}).get('hill', {}).items():
        mm = re.fullmatch(r'((?:[A-Z][a-z]?\d*)+)([+-]\d*)?', lab)
        if not mm or cas not in by_cas:
            continue
        comp = {e: int(k or 1) for e, k in re.findall(r'([A-Z][a-z]?)(\d*)', mm.group(1))}
        c = mm.group(2) or ''
        q = 0 if not c else (1 if c[0] == '+' else -1) * (int(c[1:]) if len(c) > 1 else 1)
        if all(m2 == (comp, q) for m2 in by_cas[cas]):
            hill[cas] = lab
    page = f'https://atct.anl.gov/Thermochemical%20Data/version%20{ver}/index.php'
    pm = (prev or {}).get('meta', {})
    meta = {
        'source': 'Active Thermochemical Tables (ATcT), Argonne National Laboratory',
        'url': page, 'api': settings.url('all/'), 'tn_version': ver,
        'downloaded': fetched[:10], 'fetched': fetched,
        'units': 'kJ/mol',
        'uncertainty': '95 % confidence limits of DfH(298.15 K) as listed by ATcT; ATcT tabulates no separate 0 K uncertainty, so the same value is applied at 0 K',
        'ion_convention': '298.15 K values of ions use the stationary-electron convention',
        'citation': [
            'B. Ruscic, R. E. Pinzon, M. L. Morton, G. von Laszewski, S. Bittner, S. G. Nijsure, K. A. Amin, M. Minkoff, and A. F. Wagner, J. Phys. Chem. A 108, 9979-9997 (2004), doi:10.1021/jp047912y',
            'B. Ruscic, R. E. Pinzon, G. von Laszewski, D. Kodeboyina, A. Burcat, D. Leahy, D. Montoya, and A. F. Wagner, J. Phys. Conf. Ser. 16, 561-570 (2005), doi:10.1088/1742-6596/16/1/078',
            f'B. Ruscic and D. H. Bross, Active Thermochemical Tables (ATcT) values based on ver. {ver} of the Thermochemical Network, Argonne National Laboratory, Lemont, Illinois, USA'
            + (f' ({DATASET_YEAR[ver]})' if ver in DATASET_YEAR else '') + (f'; doi:{DOI[ver]}' if ver in DOI else '; available at ATcT.anl.gov'),
        ],
        'client': f'atct {CLIENT_VERSION} (D. H. Bross and B. Ruscic, ATcT Python interface, doi:10.11578/dc.20260106.1)',
        'carried_over': 'InChIKeys, synonym lists and Hill-formula aliases (descriptive only) from the table shipped before',
    }
    if pm.get('tn_version') == ver and pm.get('as_of'):
        meta['as_of'] = pm['as_of']      # release date of this version, from ATcT's web table (the API has none)
    return {'meta': meta, 'cols': cols, 'rows': rows, 'syn': syn, 'hill': hill, 'cov': None}, notes


# ── covariance target and plan ─────────────────────────────────────────────
def target(rows):
    """build_target.py rules on the API table, in rank (species number) order."""
    out = []
    for r in rows:
        if r[4].split(',')[0].strip() not in ('g', 'g ?'):
            continue
        heavy = sum(k for e, k in r[6].items() if e not in ('H', 'D', 'T'))
        if heavy <= 3 or r[0] <= 800 or r[2] in NAMED:
            out.append(r[1])
    return out


def primes(lo, hi):
    return [p for p in range(lo, hi) if all(p % d for d in range(2, int(p ** 0.5) + 1))]


def choose_plane(n, budget):
    """(q, s): smallest PG(2, q) with s = 50 // (q + 1) species per point that holds n within the budget, else the
    largest that fits the budget. A plane has q^2 + q + 1 points and as many lines (requests)."""
    opts = [(q, MAX_SPECIES // (q + 1)) for q in primes(2, 60) if MAX_SPECIES // (q + 1) >= 1]
    opts = [(q, s, (q * q + q + 1) * s, q * q + q + 1) for q, s in opts if q * q + q + 1 <= budget]
    if not opts:
        raise Stop(1, f'covariance budget {budget} is below the smallest plane (7 requests)')
    fit = [o for o in opts if o[2] >= n]
    return min(fit, key=lambda o: o[3]) if fit else max(opts, key=lambda o: (o[2], -o[3]))


def plan(ids, q, s):
    """Requests (lists of ATcT IDs): the lines of PG(2, q), species dealt to the points round-robin."""
    pts = [(1, a, b) for a in range(q) for b in range(q)] + [(0, 1, b) for b in range(q)] + [(0, 0, 1)]
    P = np.array(pts)
    groups = [[] for _ in pts]
    for k, a in enumerate(ids):
        groups[k % len(pts)].append(a)
    assert max(map(len, groups)) <= s
    inc = (P @ P.T) % q == 0          # line i (same coordinates as point i) contains point j
    reqs = []
    for i in range(len(pts)):
        r = [a for j in np.nonzero(inc[i])[0] for a in groups[j]]
        if len(r) >= 2:
            reqs.append(r)
    idx = {a: i for i, a in enumerate(ids)}; N = len(ids)
    cover = np.zeros((N, N), bool)
    for r in reqs:
        assert len(r) <= MAX_SPECIES and len(set(r)) == len(r)
        ii = np.array([idx[a] for a in r]); cover[np.ix_(ii, ii)] = True
    assert cover.all(), 'plan does not cover every pair'
    return reqs


def check_diag(ids, sd, urow):
    """sqrt(diagonal) against the printed uncertainties: (species compared, list of those outside max(half a printed
    digit, 3 %), list of those off by more than 25 %). "0.000" means below 0.0005; "exact" must have zero variance."""
    off, far, n = [], [], 0
    for a, x in zip(ids, sd):
        u, ut = urow[a]
        if ut.lower() == 'exact':
            if x > 1e-6: off.append((a, ut, x)); far.append((a, ut, x))
            continue
        # Unbound anions such as He-, Ne- and Ar- print 28-130 kJ/mol, not a multiple of the matrix standard deviation
        # (sqrt(diagonal) is 0.15-0.6 of it in TN 1.228); they say nothing about the version, so they are skipped.
        if u > 10:
            continue
        n += 1
        if u == 0:
            if x > 0.0005: off.append((a, ut, x))
            continue
        dec = len(ut.split('.')[1]) if '.' in ut else 0
        if abs(x - u) > max(0.5 * 10 ** -dec, 0.03 * u): off.append((a, ut, x))
        if abs(x / u - 1) > 0.25: far.append((a, ut, x))
    return n, off, far


def u_map(src):
    """{ATcT ID: (U, printed U)} from a page table (cols/rows) or a list of /all/ records."""
    if isinstance(src, dict) and 'rows' in src:
        ix = {c: i for i, c in enumerate(src['cols'])}
        return {r[ix['id']]: (r[ix['u']], str(r[ix['utext']])) for r in src['rows'] if r[ix['u']] is not None}
    out = {}
    for a in (src if isinstance(src, list) else (src or {}).get('items', [])):
        t = str(a.get('Delta_Hf298K_uncertainty') or '').replace('±', '').strip()
        u = 0.0 if t.lower() == 'exact' else num(t)
        if u is not None:
            out[a['ATcT_ID']] = (u, t)
    return out


def telling(a, new_u, old_u):
    """True when the printed uncertainty of `a` changed by more than max(one printed digit, 10 %) between versions."""
    if a not in new_u or a not in old_u:
        return False
    (un, tn), (uo, to) = new_u[a], old_u[a]
    if 'exact' in (tn.lower(), to.lower()) or un <= 0 or uo <= 0:
        return False
    digit = lambda t: 10.0 ** -len(t.split('.')[1]) if '.' in t else 1.0
    return abs(un - uo) > max(digit(tn), digit(to), 0.10 * min(un, uo))


def version_check(ids, sd, new_u, old_u, old_ver):
    """Does sqrt(diagonal) follow the new printed uncertainties rather than those of `old_ver`?"""
    d = [abs(x - new_u[a][0]) < abs(x - old_u[a][0]) for a, x in zip(ids, sd) if telling(a, new_u, old_u)]
    n, k = len(d), int(sum(d))
    verdict = 'unverified' if n < VC_MIN else 'pass' if k >= VC_PASS * n else 'fail'
    return {'against': old_ver, 'telling_species': n, 'closer_to_this_version': k, 'verdict': verdict}


def block(c, asked, k):
    """The matrix of one covariance response, after checking the species and the symmetry."""
    got = c['species_atctids']
    if sorted(got) != sorted(asked):
        raise Stop(1, f'request {k}: species returned differ from those asked')
    M = np.array(c['matrix'], dtype=float)
    if M.shape != (len(got), len(got)) or not np.array_equal(M, M.T):
        raise Stop(1, f'request {k}: matrix not square and symmetric')
    return got, M


def fetch_cov(apic, ids, reqs, urow):
    N = len(ids); idx = {a: i for i, a in enumerate(ids)}
    C = np.full((N, N), np.nan); cnt = np.zeros((N, N), np.int16); maxdev = 0.0
    for k, r in enumerate(reqs):
        c = apic.get('covariance/species/', {'atctids': ','.join(r)}, name=f'covariance/r{k:04d}.json', n=len(r))
        got, M = block(c, r, k); ii = np.array([idx[a] for a in got])
        sub = C[np.ix_(ii, ii)]; have = ~np.isnan(sub)
        if have.any():
            maxdev = max(maxdev, float(np.abs(sub[have] - M[have]).max()))
        C[np.ix_(ii, ii)] = M; cnt[np.ix_(ii, ii)] += 1
        if k == 0:     # first block: is the covariance store the version of the table? (stop early if not)
            # Even with one version throughout, about 20 % of diagonals miss the printed U by more than rounding or 3 %
            # (TN 1.220, 1862 species), so only large misses count here: 0.3 % of species at one version, 3 % when stale.
            n0, _, far0 = check_diag(got, np.sqrt(np.maximum(np.diag(M), 0)), urow)
            if len(far0) > max(2, 0.15 * n0):
                raise Hold(f'first covariance block: {len(far0)} of {n0} diagonal values differ from the printed uncertainties of this version by more than 25 %')
        if k % 25 == 0:
            print(f'  covariance {k + 1}/{len(reqs)}', flush=True)
    if np.isnan(C).any():
        raise Stop(1, 'covariance pairs missing after the plan')
    if maxdev > 0:
        raise Stop(1, f'repeated covariance entries disagree (max {maxdev:g})')
    return C, cnt


# ── sparse correlation file (cov/build_tool.py) ─────────────────────────────
def fmt_r(r, dec):
    s = ('%.*f' % (dec, r)).rstrip('0')
    if s.endswith('.'): s = s[:-1]
    s = s.replace('0.', '.', 1) if s.startswith(('0.', '-0.')) else s
    return s if s not in ('-0', '', '-') else '0'


def sparse(C, ids, comps, ver, fetched, rows_by_id):
    N = C.shape[0]
    sd = np.sqrt(np.maximum(C.diagonal(), 0)); nz = sd > 0
    R = np.zeros_like(C); R[np.ix_(nz, nz)] = C[np.ix_(nz, nz)] / np.outer(sd[nz], sd[nz])
    rows = []; kept = 0; Q = np.zeros_like(C)
    for i in range(N):
        parts = []; prev = i
        if nz[i]:
            si = sd[i]; js = np.nonzero(nz[i + 1:])[0] + i + 1
            r = R[i, js]; sj = sd[js]; a = np.abs(r)
            small = si * si + sj * sj - 2 * a * si * sj            # smaller of var(xi-xj), var(xi+xj)
            keep = 2 * a * si * sj >= TAU * np.maximum(small, 1e-300)
            for j, rr, sm, sjj in zip(js[keep], r[keep], small[keep], sj[keep]):
                tol = PREC * max(sm, 1e-300) / (2 * si * sjj)                   # allowed |d rho| for x_i -/+ x_j
                tol = min(tol, PREC * max(1 - rr * rr, 1e-300) / (2 * abs(rr)))  # ... and for the best x_i - k x_j
                dec = min(12, max(2, math.ceil(-math.log10(2 * tol))))
                t = fmt_r(rr, dec)
                if t == '0': continue
                parts.append('%d:%s' % (j - prev, t)); prev = j; Q[i, j] = Q[j, i] = float(t); kept += 1
        rows.append(','.join(parts))
    np.fill_diagonal(Q, 1.0 * nz)
    total = int(nz.sum() * (nz.sum() - 1) / 2)
    # validation: every 2-body fragmentation P -> A + B inside the set, and 20 000 random 4-species combinations
    key = {}
    for i, a in enumerate(ids):
        key.setdefault(tuple(sorted(comps[a].items())), []).append(i)
    def sub(c1, c2):
        out = {}
        for e in set(c1) | set(c2):
            v = c1.get(e, 0) - c2.get(e, 0)
            if v < 0 and e != 'q': return None
            if v: out[e] = v
        return out
    sd_r = np.array([float('%.9g' % x) for x in sd]); Cq = Q * np.outer(sd_r, sd_r)
    errs, abserr = [], []
    for p in range(N):
        for a in range(N):
            if a == p: continue
            rest = sub(comps[ids[p]], comps[ids[a]])
            if not rest or all(k == 'q' for k in rest): continue
            for b in key.get(tuple(sorted(rest.items())), []):
                if b < a or b == p: continue
                k = [a, b, p]; v = np.array([1.0, 1.0, -1.0])
                ex = v @ C[np.ix_(k, k)] @ v; ap = v @ Cq[np.ix_(k, k)] @ v
                if ex <= 0: continue
                errs.append(abs(math.sqrt(max(ap, 0)) - math.sqrt(ex)) / math.sqrt(ex)); abserr.append(abs(math.sqrt(max(ap, 0)) - math.sqrt(ex)))
    rng = np.random.default_rng(1); e2 = []
    for _ in range(20000):
        k = rng.choice(np.nonzero(nz)[0], 4, replace=False); v = rng.choice([-2.0, -1.0, 1.0, 2.0], 4)
        ex = v @ C[np.ix_(k, k)] @ v; ap = v @ Cq[np.ix_(k, k)] @ v
        if ex > 0: e2.append(abs(math.sqrt(max(ap, 0)) - math.sqrt(ex)) / math.sqrt(ex))
    errs, abserr, e2 = np.array(errs or [0.0]), np.array(abserr or [0.0]), np.array(e2 or [0.0])
    ratio = [sd[i] / rows_by_id[a][9] for i, a in enumerate(ids) if rows_by_id[a][9] > 0]
    out = {'format': 'ATcT covariance, sparse correlation form',
           'source': f'{settings.url("covariance/species/")} (ATcT API v1, through the atct Python client {CLIENT_VERSION}), fetched {fetched}',
           'tn_version': ver, 'temperature_K': 298.15,
           'sd_units': f'kJ/mol; sd = sqrt(API covariance diagonal), the ATcT 95 % uncertainty of DfH(298.15 K), TN {ver} (median ratio to the printed value {float(np.median(ratio)):.3f})',
           'cov(i,j)': 'r(i,j) * sd[i] * sd[j]  (kJ^2/mol^2, same 95 % scale)',
           'rows': 'rows[i] lists r(i,j) for j > i as "dj:r" items separated by ","; dj = j minus the previous j in that row (the first is j - i); missing pairs are r = 0; r(i,i) = 1',
           'cut': {'tau': TAU, 'rule': 'pair dropped when 2|r| sd_i sd_j < tau * (sd_i^2 + sd_j^2 - 2|r| sd_i sd_j) or when r rounds to 0; r rounded so rounding changes var(x_i -/+ x_j) and the minimum over k of var(x_i - k x_j) by <= 0.5 %',
                   'pairs_kept': kept, 'pairs_total_nonzero_variance': total},
           'validation': {'two_body_fragmentations': len(errs), 'frag_rel_err_sigma_max': float(errs.max()), 'frag_rel_err_p99': float(np.percentile(errs, 99)),
                          'frag_abs_err_sigma_max_kJmol': float(abserr.max()), 'rho_rounding_rel_var_tol': PREC,
                          'random4_rel_err_sigma_max': float(e2.max()), 'random4_p99': float(np.percentile(e2, 99)),
                          'min_eigenvalue_kJ2mol2': float(np.linalg.eigvalsh(Cq).min()), 'min_eigenvalue_api_kJ2mol2': float(np.linalg.eigvalsh(C).min())},
           'ids': ids, 'sd': [float('%.9g' % x) for x in sd], 'rows': rows}
    return out


# ── main ────────────────────────────────────────────────────────────────────
def dump(o):
    return json.dumps(o, ensure_ascii=False, separators=(',', ':'))


def write(path, text):
    tmp = path.with_suffix(path.suffix + '.tmp'); tmp.write_text(text, encoding='utf-8', newline='\n'); os.replace(tmp, path)


def write_raw_index(raw, lines):
    """README.md and SHA256SUMS.txt ("<sha256> *relative/path") for everything a --raw-dir run saved."""
    (raw / 'README.md').write_text('\n'.join(lines) + '\n', encoding='utf-8', newline='\n')
    sums = []
    for p in sorted(x for x in raw.rglob('*') if x.is_file() and x.name != 'SHA256SUMS.txt'):
        sums.append(f'{hashlib.sha256(p.read_bytes()).hexdigest()} *{p.relative_to(raw).as_posix()}')
    (raw / 'SHA256SUMS.txt').write_text('\n'.join(sums) + '\n', encoding='utf-8', newline='\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--raw-dir')
    ap.add_argument('--data-dir', default=str(DATA))
    ap.add_argument('--max-cov-requests', type=int, default=2000)
    ap.add_argument('--from-raw')
    ap.add_argument('--compare-to')
    args = ap.parse_args()
    data = Path(args.data_dir)
    if args.raw_dir and not args.from_raw and (Path(args.raw_dir) / 'requests.tsv').exists():
        print(f'stopped (0 requests): {args.raw_dir} already holds a run (requests.tsv); use a new folder', file=sys.stderr)
        return 3
    api = Api(args.raw_dir, args.from_raw)
    fetched = utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    nlog = 0
    if args.from_raw:      # the time and request count of the run that saved the responses (from its last /all/ on)
        log = [ln.split('\t') for ln in (Path(args.from_raw) / 'requests.tsv').read_text(encoding='utf-8').splitlines() if ln.strip()]
        start = max(i for i, ln in enumerate(log) if ln[1] == 'all.json')
        fetched = log[start][0]; nlog = len(log) - start; args.force = True
    outcome = []; ver = None; cur = {}; sha_all = None
    try:
        allrec = api.get('all/', name='all.json', n='all')
        sha_all = api.last_sha
        if not isinstance(allrec, list):
            allrec = allrec.get('items', [])
        vers = {a.get('ATcT_TN_Version') for a in allrec}
        if len(vers) != 1 or not allrec:
            raise Stop(1, f'/all/ holds {len(allrec)} records of TN versions {sorted(map(str, vers))}; expected one version')
        ver = vers.pop()
        cur = json.loads((data / CURRENT).read_text(encoding='utf-8')) if (data / CURRENT).exists() else {}
        if not args.force and cur.get('version') == ver and all((data / f).exists() for f in cur.get('files', {}).values()):
            print(f'up to date: ATcT TN {ver} ({len(allrec)} species), 1 request')
            outcome.append(f'Up to date: TN {ver} is already shipped; nothing written.')
            return 0
        pend = cur.get('pending') or {}
        if (not args.force and pend.get('version') == ver and pend.get('all_sha256') == sha_all and pend.get('retry_after')
                and utcnow().date().isoformat() < pend['retry_after']):
            print(f'waiting: ATcT TN {ver} pending since {pend.get("since")} ({pend.get("reason")}); next try after {pend["retry_after"]}; 1 request')
            outcome.append(f'Waiting: TN {ver} pending since {pend.get("since")}; next try after {pend["retry_after"]}; nothing written.')
            return 0
        print(f'ATcT TN {ver}: {len(allrec)} species (shipped: {cur.get("version", "none")})', flush=True)
        prev_name = cur.get('files', {}).get('table') if cur else None
        if not prev_name:
            olds = sorted(data.glob('atct-tn*.json'), key=lambda p: p.stat().st_mtime)
            olds = [p for p in olds if re.fullmatch(r'atct-tn[\d.]+\.json', p.name)]
            prev_name = olds[-1].name if olds else None
        prev = json.loads((data / prev_name).read_text(encoding='utf-8')) if prev_name and (data / prev_name).exists() else None
        table, notes = build_table(allrec, ver, fetched, prev)
        for x in notes[:10]: print('  note:', x)
        rows_by_id = {r[1]: r for r in table['rows']}
        tg = target(table['rows'])
        q, s, cap, nreq = choose_plane(len(tg), args.max_cov_requests)
        ids = tg[:cap]
        reqs = plan(ids, q, s)
        print(f'covariance: target {len(tg)} species, plane PG(2,{q}) x {s} -> {len(ids)} species in {len(reqs)} requests'
              + (f' (cut {len(tg) - len(ids)} by rank to fit {args.max_cov_requests} requests)' if len(ids) < len(tg) else ''), flush=True)
        urow = {r[1]: (r[9], r[10]) for r in table['rows']}
        # the version the covariance diagonal is told apart from: --compare-to, else the table shipped now
        if args.compare_to:
            cmp_src = json.loads(Path(args.compare_to).read_text(encoding='utf-8'))
            if isinstance(cmp_src, dict) and 'rows' in cmp_src:
                cmp_ver = cmp_src.get('meta', {}).get('tn_version')
            else:
                cmp_ver = next(iter({a.get('ATcT_TN_Version') for a in (cmp_src if isinstance(cmp_src, list) else cmp_src.get('items', []))}), None)
        else:
            cmp_src, cmp_ver = prev, (prev or {}).get('meta', {}).get('tn_version')
        old_u = u_map(cmp_src) if cmp_src and str(cmp_ver) != str(ver) else {}
        tgs = set(tg)
        gas = [r[1] for r in table['rows'] if r[4].split(',')[0].strip() in ('g', 'g ?') and r[1] not in tgs]
        probe_ids = [a for a in tg + gas if telling(a, urow, old_u)][:PROBE_N]
        if api.raw:
            (api.raw / 'plan.json').write_text(json.dumps({'tn_version': ver, 'plane': [q, s], 'target': tg, 'ids': ids, 'requests': reqs,
                                                           'probe': probe_ids, 'compared_with': cmp_ver}), encoding='utf-8')
        probe, vc_probe = None, None
        if len(probe_ids) >= VC_MIN and not (api.replay and not (api.replay / 'covariance' / 'probe.json').exists()):
            c = api.get('covariance/species/', {'atctids': ','.join(probe_ids)}, name='covariance/probe.json', n=len(probe_ids))
            got, M = block(c, probe_ids, 'probe')
            vc_probe = version_check(got, np.sqrt(np.maximum(np.diag(M), 0)), urow, old_u, cmp_ver)
            print(f'  version probe: {vc_probe["closer_to_this_version"]} of {vc_probe["telling_species"]} telling species follow TN {ver} '
                  f'rather than TN {cmp_ver}: {vc_probe["verdict"]}', flush=True)
            if vc_probe['verdict'] == 'fail':
                raise Hold(f'version probe: only {vc_probe["closer_to_this_version"]} of {vc_probe["telling_species"]} species whose '
                           f'printed uncertainty changed since TN {cmp_ver} have a covariance diagonal closer to TN {ver}')
            probe = (got, M)
        C, cnt = fetch_cov(api, ids, reqs, urow)
        idx = {a: i for i, a in enumerate(ids)}
        if probe:      # entries the probe and the plan share must be identical
            pin = [i for i, a in enumerate(probe[0]) if a in idx]
            if pin:
                ci = np.array([idx[probe[0][i]] for i in pin])
                if not np.array_equal(C[np.ix_(ci, ci)], probe[1][np.ix_(pin, pin)]):
                    raise Stop(1, 'the probe and the plan returned different covariances for the same species')
        sd = np.sqrt(np.maximum(C.diagonal(), 0))
        vc = version_check(ids, sd, urow, old_u, cmp_ver)
        n, off, far = check_diag(ids, sd, urow)
        print(f'  pairs covered {int((cnt > 0).sum())}/{len(ids) ** 2}, repeats identical; diagonal vs printed U of {n} species: '
              f'{n - len(off)} within rounding or 3 %, {len(far)} off by more than 25 %; version test against TN {cmp_ver}: '
              f'{vc["closer_to_this_version"]} of {vc["telling_species"]} ({vc["verdict"]})', flush=True)
        if vc['verdict'] == 'fail':
            raise Hold(f'only {vc["closer_to_this_version"]} of {vc["telling_species"]} species whose printed uncertainty changed since '
                       f'TN {cmp_ver} have a covariance diagonal closer to TN {ver}', RETRY_DAYS)
        # Same-version noise (TN 1.220, 1862 species): 80 % within rounding or 3 %, 0.3 % off by more than 25 %. The
        # within-share cannot tell versions apart (a stale TN 1.220 matrix scored 73 % against TN 1.228); the version
        # test above and the share of large misses can.
        if n - len(off) < 0.6 * n or len(far) > 0.01 * n:
            raise Hold(f'covariance diagonal does not look like TN {ver}: {len(off)} of {n} differ, {len(far)} by more than 25 %', RETRY_DAYS)
        comps = {a: dict(rows_by_id[a][6], q=rows_by_id[a][5]) for a in ids}
        cov = sparse(C, ids, comps, ver, fetched, rows_by_id)
        diag = {'compared': n, 'outside_rounding_or_3pct': len(off), 'off_by_more_than_25pct': [[a, ut, round(float(x), 6)] for a, ut, x in far]}
        cov['coverage'] = {'target_rule': 'gas-phase species with <= 3 non-hydrogen atoms, larger gas-phase species ranked <= 800, and named common ones',
                           'target': len(tg), 'fetched': len(ids), 'requests': len(reqs), 'plane': f'PG(2,{q}), {s} species per point',
                           'diag_check': diag, 'version_check': vc, 'version_probe': vc_probe}
        if api.raw:
            iu = np.triu_indices(len(ids)); up = C[iu].astype('<f8').tobytes()
            import gzip
            with gzip.GzipFile(str(api.raw / f'atct_cov_tn{ver}_upper.f64.gz'), 'wb', 9, mtime=0) as f:
                f.write(up)
            (api.raw / f'atct_cov_tn{ver}_species.json').write_text(json.dumps({
                'tn_version': ver, 'n_species': len(ids), 'units': 'kJ^2/mol^2', 'temperature_K': 298.15,
                'layout': 'gzip of little-endian float64, upper triangle incl. diagonal, row-major',
                'upper_sha256_uncompressed': hashlib.sha256(up).hexdigest(), 'atctids': ids}, indent=0), encoding='utf-8')
        tname, cname = f'atct-tn{ver}.json', f'atct-cov-tn{ver}.json'
        write(data / tname, dump(table)); write(data / cname, dump(cov))
        current = {'source': 'ATcT API v1 (https://atct.anl.gov/api/v1/), via the atct Python client', 'version': ver, 'fetched': fetched,
                   'doi': DOI.get(ver), 'dataset_year': DATASET_YEAR.get(ver), 'files': {'table': tname, 'cov': cname}, 'species': len(table['rows']),
                   'cov_species': len(ids), 'cov_target': len(tg), 'requests': nlog if args.from_raw else api.count,
                   'cov_version_check': {'probe': vc_probe, 'all_fetched': vc,
                                         'diagonal': {'compared': n, 'outside_rounding_or_3pct': len(off), 'off_by_more_than_25pct': len(far)}},
                   'client': {'name': 'atct', 'version': CLIENT_VERSION}, 'numpy': np.__version__}
        write(data / CURRENT, json.dumps(current, ensure_ascii=False, indent=1) + '\n')
        page = data.parent / 'index.html'       # point the page's preload of the table at the new file
        if page.exists():
            t = page.read_bytes().decode('utf-8')
            t2, k = re.subn(r'(<link rel="preload" href="\./data/)atct-tn[\d.]+\.json(")', lambda m: m.group(1) + tname + m.group(2), t)
            if k == 1 and t2 != t:
                tmp = page.with_suffix('.html.tmp'); tmp.write_bytes(t2.encode('utf-8')); os.replace(tmp, page)
                print('  index.html: table preload ->', tname)
        keep = {tname, cname, CURRENT} | set((cur.get('files') or {}).values())
        for p in data.glob('atct-*.json'):
            if p.name not in keep:
                p.unlink(); print('  removed', p.name)
        print(f'wrote {tname} ({len(table["rows"])} species), {cname} ({len(ids)} species, {cov["cut"]["pairs_kept"]} pairs), {CURRENT}; '
              + (f'rebuilt from {args.from_raw} ({current["requests"]} requests on {fetched})' if args.from_raw else f'{api.count} requests, {api.bytes / 1e6:.1f} MB'))
        outcome.append(f'Written: TN {ver}, {len(table["rows"])} species, covariances of {len(ids)} species; version test {vc["verdict"]}.')
        return 0
    except Hold as h:
        if api.replay or not cur.get('version'):
            print(f'stopped ({api.count} requests): {h.reason}', file=sys.stderr)
            outcome.append(f'Stopped: {h.reason}')
            return 1
        old = cur.get('pending') or {}
        same = old.get('version') == ver and old.get('all_sha256') == sha_all
        today = utcnow().date()
        p = {'version': ver, 'all_sha256': sha_all, 'since': old.get('since') if same and old.get('since') else today.isoformat(), 'reason': h.reason}
        if h.retry_days:
            p['retry_after'] = (today + datetime.timedelta(days=h.retry_days)).isoformat()
        write(data / CURRENT, json.dumps({**{k: v for k, v in cur.items() if k != 'pending'}, 'pending': p}, ensure_ascii=False, indent=1) + '\n')
        repeat = same and old.get('reason') == h.reason
        print(f'{"still pending" if repeat else "pending"} ({api.count} requests): ATcT TN {ver}: {h.reason}; TN {cur.get("version")} stays'
              + (f'; next try after {p["retry_after"]}' if h.retry_days else '; the next run tries again'), file=sys.stderr)
        outcome.append(f'Pending: TN {ver}: {h.reason}. Only the pending note in atct-current.json was written.')
        return 0 if repeat else 4
    except Stop as e:
        print(f'stopped ({api.count} requests): {e}', file=sys.stderr)
        outcome.append(f'Stopped (exit {e.code}): {e}')
        return e.code
    finally:
        if api.raw and not args.from_raw:
            write_raw_index(api.raw, [
                f'# ATcT API responses, {fetched}', '',
                f'Saved by _scripts/atct_sync.py (cdfoley.com Thermochemistry Lab) through the atct Python client {CLIENT_VERSION}, '
                f'numpy {np.__version__}. TN version served: {ver or "unknown"}. Requests: {api.count}, {api.bytes / 1e6:.2f} MB.', '',
                *outcome, '',
                'Files: all.json is the body of /api/v1/all/; covariance/probe.json and covariance/rNNNN.json are the bodies of '
                '/api/v1/covariance/species/ for the ATcT IDs listed in plan.json ("probe", "requests"); requests.tsv logs each '
                'request (UTC start, file, species asked, HTTP status, content type, bytes, seconds, sha256 of the body); '
                'atct_cov_tn<ver>_upper.f64.gz is the assembled matrix (gzip of little-endian float64, upper triangle with the '
                'diagonal, row-major, in the order of atct_cov_tn<ver>_species.json). Rebuild the site files with '
                '"python _scripts/atct_sync.py --from-raw <this folder> --data-dir <folder>" (no requests).', '',
                'ATcT: B. Ruscic and D. H. Bross, Active Thermochemical Tables, Argonne National Laboratory, atct.anl.gov'
                + (f'; dataset doi:{DOI[ver]}' if ver in DOI else '') + '.'])


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
