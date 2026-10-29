"""Tell IndexNow search engines (Bing, Yandex, Seznam, Naver, ...) about every URL in sitemap.xml.

    python _scripts/indexnow.py            # all URLs in the sitemap
    python _scripts/indexnow.py games/ tools/fluence/    # just these pages (no leading slash)

Run after a push has deployed: the key file (<key>.txt at the site root) must be live for the ping to be accepted.
"""
import glob, json, os, re, sys, urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
SITE = 'https://cdfoley.com'
key = next(os.path.basename(f)[:-4] for f in glob.glob('*.txt') if re.fullmatch(r'[0-9a-f]{32}\.txt', os.path.basename(f)))
def url(p):   # 'games/' or a full URL; Git Bash rewrites args starting with '/' into Windows paths, so leave the slash off
    return p if p.startswith('http') else SITE + '/' + p.replace(os.sep, '/').split('/Git/')[-1].lstrip('/')
urls = [url(p) for p in sys.argv[1:]] or re.findall(r'<loc>(.*?)</loc>', open('sitemap.xml', encoding='utf-8').read())
body = json.dumps({'host': 'cdfoley.com', 'key': key, 'keyLocation': '%s/%s.txt' % (SITE, key), 'urlList': urls}).encode()
req = urllib.request.Request('https://api.indexnow.org/indexnow', data=body, headers={'Content-Type': 'application/json; charset=utf-8'})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print('IndexNow: HTTP %d for %d URLs (200/202 = accepted)' % (r.status, len(urls)))
except urllib.error.HTTPError as e:     # 422: a URL isn't on cdfoley.com, or the key file isn't live yet
    print('IndexNow: HTTP %d for %d URLs: %s' % (e.code, len(urls), e.read()[:200].decode('utf-8', 'replace')))
