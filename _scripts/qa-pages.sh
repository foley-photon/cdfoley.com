#!/usr/bin/env bash
# QA every page in headless Edge: header/footer injection, KaTeX errors, calculator errors at default
# inputs, blank outputs, page console errors, and broken internal links.
#   bash _scripts/qa-pages.sh                 # all pages
#   bash _scripts/qa-pages.sh tools/fluence/  # specific pages
# Requires Git Bash, Python 3, and Microsoft Edge.
cd "$(dirname "$0")/.."
PORT=$(( (RANDOM % 20000) + 20000 ))
python -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 0.25; done
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
OUT=$(mktemp -d)
PAGES="index.html 404.html $(find . -mindepth 2 -name index.html -not -path "./applications/*" -not -path "./.git/*" | sed 's#^\./##; s#index.html$##' | sort)"
[ -n "$1" ] && PAGES="$*"
for p in $PAGES; do
  PROF=$(mktemp -d); ERR=$(mktemp)
  timeout 90 "$EDGE" --headless=new --disable-gpu --no-first-run --disable-extensions --user-data-dir="$PROF" --enable-logging=stderr --v=0 --virtual-time-budget=6000 --dump-dom "http://127.0.0.1:$PORT/$p" 2>"$ERR" > "$OUT/dom.html"
  python - "$p" "$OUT/dom.html" "$ERR" <<'PY'
import sys, re, os
p, dom_f, err_f = sys.argv[1:4]
dom = open(dom_f, encoding='utf-8', errors='replace').read()
err = open(err_f, encoding='utf-8', errors='replace').read()
issues = []
if dom.count('class="site-header"') != 1: issues.append('header')
if 'class="site-footer"' not in dom: issues.append('footer')
k = dom.count('katex-error');  issues += [f'katex-error x{k}'] if k else []
if re.search(r'class="calc-error show"', dom): issues.append('calc-error shown: ' + re.search(r'class="calc-error show"[^>]*>([^<]*)', dom).group(1)[:80])
blank = []
for m in re.finditer(r'<div class="result[^"]*"([^>]*)>(.*?)</div>', dom, re.S):
    if 'hidden' in m.group(1): continue
    blank += re.findall(r'data-out="([^"]+)"[^>]*>—<', m.group(2))
hidden_rows = 0
if blank: issues.append('blank outputs: ' + ','.join(blank[:8]))
cons = [l for l in err.splitlines() if 'CONSOLE' in l and 'Tracking Prevention' not in l and 'chrome-extension' not in l]
cons = [re.sub(r'^.*CONSOLE[^"]*', '', l)[:140] for l in cons]
if cons: issues.append('console: ' + ' | '.join(cons[:3]))
# internal links
links = set(re.findall(r'href="(/[^"#?]*)', dom))
bad = []
for l in links:
    path = l.lstrip('/')
    cand = [path, path + 'index.html', path + '/index.html'] if path else ['index.html']
    if not any(os.path.isfile(c) for c in cand): bad.append(l)
if bad: issues.append('broken links: ' + ','.join(sorted(bad)[:6]))
print(f"{'OK ' if not issues else 'BAD'} /{p:45s} " + ('; '.join(issues)))
PY
  rm -rf "$PROF" "$ERR"
done
rm -rf "$OUT"
