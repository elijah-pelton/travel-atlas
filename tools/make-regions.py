#!/usr/bin/env python3
"""Build data/regions.json: the continent of every place on the World map (js/browse.js groups
the World list by it).

Build:   python3 tools/make-regions.py
Verify:  python3 tools/make-regions.py --check     (changes nothing; exits 1 if regions.json is stale)
Offline: python3 tools/make-regions.py --src path/to/ne_50m_admin_0_countries.geojson

Source: Natural Earth 1:50m admin-0 countries at the pinned v5.1.2 tag, the "admin0" entry under
"na_fit" in tools/cities-source.json. Same rule as tools/make-cities.py: the file is cached in
$TMPDIR and refused if its SHA-256 or size differs from the pin.

Mapping: a world.json id is matched to a feature by ADM0_A3 (our ids are ADM0_A3, including the
Natural Earth specials KOS, SAH, PSX, SDS, CYN, SOL), then ADM0_A3_US, then SOV_A3. The continent
is the feature's CONTINENT. Natural Earth files a few islands under "Seven seas (open ocean)";
those take their REGION_UN instead (Mauritius, Seychelles, Saint Helena -> Africa; Maldives ->
Asia), and MANUAL below settles the rest. Every world.json place gets exactly one continent, or
the script fails. Standard library only.
"""
import argparse
import hashlib
import http.client
import json
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'regions.json'
ORDER = ['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'South America']
SEVEN_SEAS = 'Seven seas (open ocean)'
# Places Natural Earth leaves in the open ocean, with a REGION_UN that doesn't fit.
MANUAL = {
    'SGS': 'South America',   # South Georgia & the Sandwich Islands (REGION_UN "Americas")
    'HMD': 'Oceania',         # Heard & McDonald Islands, an Australian territory (REGION_UN "Africa")
}
REGION_UN = {'Africa': 'Africa', 'Asia': 'Asia', 'Europe': 'Europe', 'Oceania': 'Oceania', 'Antarctica': 'Antarctica'}


def fail(msg):
    sys.exit('make-regions: ' + msg)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def download(url, tries=4):
    err = None
    for _ in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                return r.read()
        except (OSError, http.client.HTTPException) as e:
            err = e
    fail(f'download failed ({err!r}); fetch the file yourself and pass --src path')


def pin():
    src = json.loads((ROOT / 'tools' / 'cities-source.json').read_text(encoding='utf-8'))
    for p in src.get('na_fit', []):
        if p.get('role') == 'admin0':
            return src['tag'], p
    fail('no "admin0" entry under "na_fit" in tools/cities-source.json')


def load_source(src_arg, p):
    if src_arg:
        data = Path(src_arg).read_bytes()
        where = src_arg
    else:
        stem = Path(p['path']).stem
        cache = Path(os.environ.get('TMPDIR') or tempfile.gettempdir()) / f'{stem}-{p["sha256"][:16]}.geojson'
        if cache.exists() and sha256(cache.read_bytes()) == p['sha256']:
            data = cache.read_bytes()
            where = str(cache)
        else:
            print(f'fetching {p["url"]}', file=sys.stderr)
            data = download(p['url'])
            cache.write_bytes(data)
            where = p['url']
    got = sha256(data)
    if got != p['sha256']:
        fail(f'SHA-256 mismatch for {where}: got {got}, pinned {p["sha256"]} (tools/cities-source.json). Refusing.')
    if len(data) != p['bytes']:
        fail(f'size mismatch for {where}: got {len(data)}, pinned {p["bytes"]}')
    return json.loads(data.decode('utf-8'))


def build(src_arg=None):
    tag, p = pin()
    geo = load_source(src_arg, p)
    props = [f['properties'] for f in geo['features']]
    keys = ('ADM0_A3', 'ADM0_A3_US', 'SOV_A3')
    index = {k: {} for k in keys}
    for pr in props:
        for k in keys:
            v = pr.get(k)
            if v and v not in index[k]:
                index[k][v] = pr
    world = json.loads((ROOT / 'data' / 'world.json').read_text(encoding='utf-8'))['places']
    of = {}
    how = {'ADM0_A3': 0, 'ADM0_A3_US': 0, 'SOV_A3': 0, 'REGION_UN': 0, 'manual': 0}
    for place in world:
        pid = place['id']
        if pid in MANUAL:
            of[pid] = MANUAL[pid]
            how['manual'] += 1
            continue
        pr = None
        for k in keys:
            pr = index[k].get(pid)
            if pr:
                how[k] += 1
                break
        if not pr:
            fail(f'{pid} ({place["name"]}) has no Natural Earth admin-0 feature; add it to MANUAL')
        cont = pr.get('CONTINENT')
        if cont == SEVEN_SEAS:
            cont = REGION_UN.get(pr.get('REGION_UN'))
            how['REGION_UN'] += 1
            if not cont:
                fail(f'{pid} ({place["name"]}) is in the open ocean with REGION_UN {pr.get("REGION_UN")!r}; add it to MANUAL')
        if cont not in ORDER:
            fail(f'{pid} ({place["name"]}): unknown continent {cont!r}')
        of[pid] = cont
    ids = [pl['id'] for pl in world]
    if len(set(ids)) != len(ids) or set(of) != set(ids):
        fail('every world.json place must get exactly one continent')
    unused = sorted(set(MANUAL) - set(ids))
    if unused:
        fail('MANUAL lists ids that are not on the World map: ' + ', '.join(unused))
    regions = {c: sorted(i for i in ids if of[i] == c) for c in ORDER}
    out = {
        '_comment': 'Generated by tools/make-regions.py from Natural Earth 1:50m admin-0 countries. Do not edit by hand.',
        'v': 1,
        'src': {'tag': tag, 'path': p['path'], 'sha256': p['sha256']},
        'order': ORDER,
        'manual': MANUAL,
        'regions': regions,
    }
    text = json.dumps(out, ensure_ascii=False, indent=1, sort_keys=False) + '\n'
    return text, regions, how


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--check', action='store_true', help='exit 1 if data/regions.json is not up to date')
    ap.add_argument('--src', help='local copy of the pinned ne_50m_admin_0_countries.geojson')
    a = ap.parse_args()
    text, regions, how = build(a.src)
    summary = ', '.join(f'{c} {len(v)}' for c, v in regions.items())
    if a.check:
        cur = OUT.read_text(encoding='utf-8') if OUT.exists() else ''
        if cur != text:
            print('make-regions: data/regions.json is stale; run python3 tools/make-regions.py', file=sys.stderr)
            sys.exit(1)
        print(f'make-regions: ok ({summary})')
        return
    OUT.write_text(text, encoding='utf-8')
    print(f'make-regions: wrote {OUT.relative_to(ROOT)} ({summary}; matched by {how})')


if __name__ == '__main__':
    main()
