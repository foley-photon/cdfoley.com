"""SEO upkeep for cdfoley.com. Run after adding or editing pages:

    python _scripts/seo.py

1. Writes JSON-LD (WebApplication + BreadcrumbList) into every tool page and an
   ItemList into the tools and learn hubs, from the TOOLS/ARTICLES registries
   in assets/js/site.js.
2. Regenerates sitemap.xml with lastmod dates from git (today for uncommitted edits).
3. Reports pages missing a title, description, canonical URL, or Open Graph tags.
"""
import datetime, html, json, os, re, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = 'https://cdfoley.com'
AUTHOR = {'@type': 'Person', '@id': SITE + '/#person', 'name': 'Casey D. Foley', 'url': SITE + '/'}
SITE_NAME = 'Casey D. Foley, PhD'
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

# Games: one VideoGame per page, from the cards on the games hub
hub = open('games/index.html', encoding='utf-8').read()
GENRE = {'pinball': 'Pinball', 'brick-breaker': 'Arcade', 'space-rocks': 'Shooter', 'paddle-ball': 'Sports', 'snake': 'Arcade',
         '2048': 'Puzzle', 'sudoku': 'Puzzle', 'minesweeper': 'Puzzle', 'solitaire': 'Card game', 'hangman': 'Word game'}
GAMES = [dict(slug=m.group(1), title=m.group(2)) for m in re.finditer(
    r'<a class="card tool-card game-card" href="/games/([^/]+)/">.*?<h3>(.*?)</h3>', hub, re.S)]
for g in GAMES:
    path = 'games/%s/index.html' % g['slug']
    s = open(path, encoding='utf-8').read()
    put_ld(path, {'@context': 'https://schema.org', '@graph': [
        {'@type': 'VideoGame', 'name': g['title'], 'url': '%s/games/%s/' % (SITE, g['slug']), 'description': meta(s, 'description'),
         'genre': GENRE.get(g['slug'], 'Casual'), 'gamePlatform': 'Web browser', 'playMode': 'SinglePlayer',
         'applicationCategory': 'GameApplication', 'operatingSystem': 'Any (web browser)', 'isAccessibleForFree': True,
         'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'USD'}, 'author': AUTHOR, 'publisher': AUTHOR},
        crumbs([('Games', '/games/'), (g['title'], '/games/%s/' % g['slug'])])]})
put_ld('games/index.html', {'@context': 'https://schema.org', '@type': 'CollectionPage', 'name': 'Games',
    'url': SITE + '/games/', 'description': meta(hub, 'description'), 'author': AUTHOR,
    'mainEntity': {'@type': 'ItemList', 'numberOfItems': len(GAMES), 'itemListElement': [
        {'@type': 'ListItem', 'position': i + 1, 'name': g['title'], 'url': '%s/games/%s/' % (SITE, g['slug'])} for i, g in enumerate(GAMES)]}})

# Publications: each paper as a ScholarlyArticle, linked to its DOI or preprint
def text(t): return html.unescape(re.sub(r'<[^>]+>', '', t)).strip()
pubs_html = open('publications/index.html', encoding='utf-8').read()
PUBS = []
for year, body in re.findall(r'<li class="pub"[^>]*><div class="pub-year">(.*?)</div>(.*?)</li>', pubs_html, re.S):
    title = re.search(r'<div class="pub-title">(.*?)</div>', body, re.S).group(1)
    href = re.search(r'href="([^"]+)"', title)
    venue = re.search(r'<div class="pub-venue">(.*?)</div>', body, re.S)
    venue = text(re.sub(r'<span class="pub-badge">.*?</span>|<a class="pub-pdf".*?</a>', '', venue.group(1), flags=re.S)) if venue else ''
    journal = 'arXiv' if venue.startswith('arXiv') else (re.match(r'(.*?)\s+\d', venue) or re.match(r'(.*)', venue)).group(1)
    authors = [a.strip() for a in text(re.search(r'<div class="pub-authors">(.*?)</div>', body, re.S).group(1)).split(',') if a.strip()]
    art = {'@type': 'ScholarlyArticle', 'headline': text(title), 'datePublished': text(year),
           'author': [AUTHOR if 'Foley' in a else {'@type': 'Person', 'name': a} for a in authors],
           'isPartOf': {'@type': 'Periodical', 'name': journal}}
    if href:
        art['url'] = href.group(1)
        if 'doi.org/' in href.group(1): art['sameAs'] = href.group(1)
    PUBS.append(art)
put_ld('publications/index.html', {'@context': 'https://schema.org', '@type': 'CollectionPage', 'name': 'Publications',
    'url': SITE + '/publications/', 'author': AUTHOR,
    'mainEntity': {'@type': 'ItemList', 'numberOfItems': len(PUBS), 'itemListElement': [
        {'@type': 'ListItem', 'position': i + 1, 'item': p} for i, p in enumerate(PUBS)]}})

# Resume: a ProfilePage whose subject is the same Person described on the home page
home = open('index.html', encoding='utf-8').read()
person = next(json.loads(b) for b in re.findall(r'<script type="application/ld\+json"[^>]*>(.*?)</script>', home, re.S)
              if '"@type": "Person"' in b)
person.pop('@context', None)
put_ld('resume/index.html', {'@context': 'https://schema.org', '@type': 'ProfilePage', 'url': SITE + '/resume/',
    'dateModified': datetime.date.today().isoformat(), 'mainEntity': person})
formulas = open('formulas/index.html', encoding='utf-8').read()
put_ld('formulas/index.html', {'@context': 'https://schema.org', '@type': 'CollectionPage', 'name': 'Formula reference',
    'url': SITE + '/formulas/', 'description': meta(formulas, 'description'), 'author': AUTHOR})
print('JSON-LD: %d tools, %d games, %d publications, tools/learn/games hubs, resume, formulas' % (len(TOOLS), len(GAMES), len(PUBS)))

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

# 3. Site name on every page (Google and link previews show it beside the page title), then audit
for f in pages:
    s = open(f, encoding='utf-8').read()
    if 'og:site_name' not in s and '<meta property="og:type"' in s:
        s = re.sub(r'(<meta property="og:type"[^>]*>\n)', r'\1<meta property="og:site_name" content="%s">\n' % SITE_NAME, s, count=1)
        open(f, 'w', encoding='utf-8').write(s)
    miss = [k for k, ok in [('title', '<title>' in s), ('description', bool(meta(s, 'description'))),
                            ('canonical', 'rel="canonical"' in s), ('og:title', bool(meta(s, 'og:title', 'property'))),
                            ('og:description', bool(meta(s, 'og:description', 'property')))] if not ok]
    if miss: print('  %-45s missing %s' % (f, ', '.join(miss)))
