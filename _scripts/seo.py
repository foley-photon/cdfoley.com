"""SEO upkeep for cdfoley.com. Run after adding or editing pages:

    python _scripts/seo.py

1. Writes JSON-LD (WebApplication + BreadcrumbList) into every tool page and an
   ItemList into the tools and learn hubs, from the TOOLS/ARTICLES registries
   in assets/js/site.js.
2. Regenerates sitemap.xml with lastmod dates from git (today for uncommitted edits).
3. Reports pages missing a title, description, canonical URL, or Open Graph tags.
"""
import datetime, json, os, re, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = 'https://cdfoley.com'
AUTHOR = {'@type': 'Person', 'name': 'Casey D. Foley', 'url': SITE + '/'}
os.chdir(ROOT)

js = open('assets/js/site.js', encoding='utf-8').read()
def registry(name):
    body = re.search(r'var ' + name + r' = \[(.*?)\n    \];', js, re.S).group(1)
    rows = []
    for m in re.finditer(r'\{([^{}]*)\}', body):
        row = dict(re.findall(r"(\w+):\s*'((?:[^'\\]|\\.)*)'", m.group(1)))
        if row: rows.append(row)
    return rows
TOOLS, ARTICLES, CATS = registry('TOOLS'), registry('ARTICLES'), registry('CATEGORIES')
CAT = {c['id']: c['title'] for c in CATS}

def put_ld(path, data):
    s = open(path, encoding='utf-8').read()
    block = '<script type="application/ld+json" id="ld-page">\n' + json.dumps(data, ensure_ascii=False, indent=1) + '\n</script>\n'
    s, n = re.subn(r'<script type="application/ld\+json" id="ld-page">.*?</script>\n', lambda m: block, s, flags=re.S)
    if not n:
        s = s.replace('</head>', block + '</head>', 1)
    open(path, 'w', encoding='utf-8').write(s)

def meta(s, name, attr='name'):
    m = re.search(r'<meta ' + attr + r'="' + re.escape(name) + r'" content="([^"]*)"', s)
    return m.group(1) if m else ''

def crumbs(items):
    return {'@type': 'BreadcrumbList', 'itemListElement': [
        {'@type': 'ListItem', 'position': i + 1, 'name': n, 'item': SITE + u} for i, (n, u) in enumerate(items)]}

# 1. Structured data
for t in TOOLS:
    path = 'tools/%s/index.html' % t['slug']
    if not os.path.exists(path):
        print('missing tool page:', path); continue
    s = open(path, encoding='utf-8').read()
    url = '%s/tools/%s/' % (SITE, t['slug'])
    put_ld(path, {'@context': 'https://schema.org', '@graph': [
        {'@type': 'WebApplication', 'name': t['title'], 'url': url,
         'description': meta(s, 'description') or t['desc'],
         'applicationCategory': 'UtilitiesApplication', 'operatingSystem': 'Any (web browser)',
         'browserRequirements': 'Requires JavaScript', 'isAccessibleForFree': True,
         'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'USD'},
         'keywords': t.get('keys', ''), 'author': AUTHOR, 'publisher': AUTHOR},
        crumbs([('Tools', '/tools/'), (CAT.get(t['cat'], 'Tools'), '/tools/#' + t['cat']), (t['title'], '/tools/%s/' % t['slug'])])]})

put_ld('tools/index.html', {'@context': 'https://schema.org', '@type': 'CollectionPage', 'name': 'Engineering calculators',
    'url': SITE + '/tools/', 'author': AUTHOR,
    'mainEntity': {'@type': 'ItemList', 'numberOfItems': len(TOOLS), 'itemListElement': [
        {'@type': 'ListItem', 'position': i + 1, 'name': t['title'], 'url': '%s/tools/%s/' % (SITE, t['slug'])} for i, t in enumerate(TOOLS)]}})
put_ld('learn/index.html', {'@context': 'https://schema.org', '@type': 'CollectionPage', 'name': 'Knowledge center',
    'url': SITE + '/learn/', 'author': AUTHOR,
    'mainEntity': {'@type': 'ItemList', 'numberOfItems': len(ARTICLES), 'itemListElement': [
        {'@type': 'ListItem', 'position': i + 1, 'name': a['title'], 'url': '%s/learn/%s/' % (SITE, a['slug'])} for i, a in enumerate(ARTICLES)]}})
print('JSON-LD: %d tools, tools hub, learn hub' % len(TOOLS))

# 2. Sitemap
pages = ['index.html'] + sorted(
    os.path.join(dp, 'index.html').replace('\\', '/').lstrip('./')
    for dp, dn, fn in os.walk('.') if 'index.html' in fn and dp != '.'
    and not re.match(r'\./(\.git|applications|_)', dp))
dirty = set(subprocess.run(['git', 'status', '--porcelain'], capture_output=True, text=True).stdout.split())
today = datetime.date.today().isoformat()
def lastmod(f):
    if f in dirty or any(f.startswith(d) for d in dirty if d.endswith('/')): return today
    out = subprocess.run(['git', 'log', '-1', '--format=%cs', '--', f], capture_output=True, text=True).stdout.strip()
    return out or today
def prio(f):
    if f == 'index.html': return '1.0'
    if f in ('tools/index.html', 'learn/index.html', 'formulas/index.html'): return '0.9'
    if f.startswith(('tools/', 'learn/')): return '0.8'
    if f.startswith('publications/'): return '0.7'
    return '0.6'
urls = []
for f in pages:
    loc = SITE + '/' + f[:-len('index.html')]
    urls.append('  <url><loc>%s</loc><lastmod>%s</lastmod><priority>%s</priority></url>' % (loc, lastmod(f), prio(f)))
open('sitemap.xml', 'w', encoding='utf-8').write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + '\n'.join(urls) + '\n</urlset>\n')
print('sitemap.xml: %d URLs' % len(urls))

# 3. Audit
for f in pages:
    s = open(f, encoding='utf-8').read()
    miss = [k for k, ok in [('title', '<title>' in s), ('description', bool(meta(s, 'description'))),
                            ('canonical', 'rel="canonical"' in s), ('og:title', bool(meta(s, 'og:title', 'property'))),
                            ('og:description', bool(meta(s, 'og:description', 'property')))] if not ok]
    if miss: print('  %-45s missing %s' % (f, ', '.join(miss)))
