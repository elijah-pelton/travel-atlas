#!/usr/bin/env python3
"""Build data/cities.json (and the id lock file data/cities-ids.json) from Natural Earth.

Usage:
    python3 tools/make-cities.py                     fetch the pinned source, write both files
    python3 tools/make-cities.py --src local.geojson use a local copy (its SHA-256 must still match)
    python3 tools/make-cities.py --check             regenerate in memory, exit 1 if either file differs

Source: Natural Earth 1:10m populated places (public domain), pinned in tools/cities-source.json.
The script refuses a file whose SHA-256 differs from the pin. See docs/plan-cities.md for the rules
(selection, Equal Earth projection, country assignment, names, zoom tiers, output format).
Python 3 standard library only.
"""
import gzip
import hashlib
import http.client
import json
import math
import os
import re
import statistics
import sys
import tempfile
import unicodedata
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tools' / 'cities-source.json'
OVERRIDES = ROOT / 'tools' / 'cities-overrides.json'
REMAP = ROOT / 'tools' / 'cities-remap.json'
WORLD = ROOT / 'data' / 'world.json'
OUT = ROOT / 'data' / 'cities.json'
IDS = ROOT / 'data' / 'cities-ids.json'

# Selection (plan §2 / lead decisions)
POP_CUT = 100_000
POP_CUT_GUARD = 150_000      # used if the default rule keeps more than COUNT_GUARD rows
COUNT_GUARD = 4500
SCALERANK_CUT = 4
DUP_DIST = 0.3               # map units: same name closer than this = same city
WD_MERGE_MAX = 5.0           # map units: rows sharing a wikidataid further apart than this are a source error, not merged
FALLBACK_DIST = 3.0          # map units: max distance to a polygon for points that fall in none

# Equal Earth (d3-geo geoEqualEarth constants) and our map's fit
A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
M = math.sqrt(3) / 2
TX, TY = 500.0, 243.36

# Zoom tiers (plan §2): 360 px reference width over a 1000-unit map, 8 px spacing
REF_PX_PER_UNIT = 0.36
MIN_SPACING_PX = 8.0
Z_MIN, Z_MAX = 1.0, 10.0

REQUIRED = ['NE_ID', 'NAME', 'NAMEASCII', 'NAMEALT', 'NAMEPAR', 'NAME_EN', 'FEATURECLA', 'POP_MAX',
            'SCALERANK', 'ADM0_A3', 'ADM1NAME', 'WIKIDATAID']
LATIN_ALIAS_FIELDS = ['NAME_DE', 'NAME_FR', 'NAME_ES', 'NAME_IT', 'NAME_PT', 'NAME_NL', 'NAME_PL',
                      'NAME_SV', 'NAME_TR', 'NAME_ID', 'NAME_VI']
DOT_CHECK = ['VAT', 'MCO', 'SMR', 'LIE', 'SGP', 'MLT', 'AND']
# Natural Earth populated-places ADM0_A3 codes that our world.json spells differently
A3_ALIAS = {'SSD': 'SDS'}


def fail(msg):
    sys.exit('make-cities: ' + msg)


# ---------------------------------------------------------------- source

def sha256(data):
    return hashlib.sha256(data).hexdigest()


def download(url, tries=4):
    err = None
    for _ in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                chunks = []
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    chunks.append(b)
                return b''.join(chunks)
        except (OSError, http.client.HTTPException) as e:
            err = e
    fail(f'download failed ({err!r}); fetch the file yourself and pass --src path')


def load_source(src_arg, pin):
    if src_arg:
        data = Path(src_arg).read_bytes()
        where = src_arg
    else:
        cache = Path(os.environ.get('TMPDIR') or tempfile.gettempdir()) / f'ne_10m_populated_places-{pin["sha256"][:16]}.geojson'
        if cache.exists() and sha256(cache.read_bytes()) == pin['sha256']:
            data = cache.read_bytes()
            where = str(cache)
        else:
            print(f'fetching {pin["url"]}', file=sys.stderr)
            data = download(pin['url'])
            cache.write_bytes(data)
            where = pin['url']
    got = sha256(data)
    if got != pin['sha256']:
        fail(f'SHA-256 mismatch for {where}: got {got}, pinned {pin["sha256"]} (tools/cities-source.json). Refusing.')
    if len(data) != pin['bytes']:
        fail(f'size mismatch for {where}: got {len(data)}, pinned {pin["bytes"]}')
    return json.loads(data.decode('utf-8'))


# ---------------------------------------------------------------- projection

def ee_raw(lam, phi):
    l = math.asin(M * math.sin(phi))
    l2 = l * l
    l6 = l2 * l2 * l2
    x = lam * math.cos(l) / (M * (A1 + 3 * A2 * l2 + l6 * (7 * A3 + 9 * A4 * l2)))
    y = l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2))
    return x, y


SCALE = 500.0 / ee_raw(math.pi, 0.0)[0]


def project(lon, lat, s=SCALE, tx=TX, ty=TY):
    X, Y = ee_raw(math.radians(lon), math.radians(lat))
    return tx + s * X, ty - s * Y


# ---------------------------------------------------------------- world.json geometry

def parse_rings(d):
    if re.search(r'[^MLZ0-9.,\- ]', d):
        fail('world.json path uses commands other than absolute M/L/Z')
    rings = []
    for part in re.findall(r'M[^MZ]*Z?', d):
        pts = [tuple(map(float, p.split(','))) for p in re.findall(r'-?[\d.]+,-?[\d.]+', part)]
        if len(pts) >= 3:
            rings.append(pts)
    return rings


def ring_area(r):
    a = 0.0
    for i in range(len(r)):
        x1, y1 = r[i - 1]
        x2, y2 = r[i]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


class Shape:
    def __init__(self, place):
        self.id = place['id']
        self.dot = 'dot' in place
        self.rings = parse_rings(place['d'])
        xs = [p[0] for r in self.rings for p in r]
        ys = [p[1] for r in self.rings for p in r]
        self.bbox = (min(xs), min(ys), max(xs), max(ys))
        self.area = sum(ring_area(r) for r in self.rings)

    def contains(self, x, y):
        x0, y0, x1, y1 = self.bbox
        if x < x0 or x > x1 or y < y0 or y > y1:
            return False
        inside = False  # even-odd over all rings, so holes and enclaves work
        for r in self.rings:
            j = len(r) - 1
            for i in range(len(r)):
                xi, yi = r[i]
                xj, yj = r[j]
                if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                    inside = not inside
                j = i
        return inside

    def dist(self, x, y, limit):
        x0, y0, x1, y1 = self.bbox
        if x < x0 - limit or x > x1 + limit or y < y0 - limit or y > y1 + limit:
            return math.inf
        best = math.inf
        for r in self.rings:
            for i in range(len(r)):
                ax, ay = r[i - 1]
                bx, by = r[i]
                dx, dy = bx - ax, by - ay
                L = dx * dx + dy * dy
                t = 0.0 if L == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L))
                best = min(best, math.hypot(x - ax - t * dx, y - ay - t * dy))
        return best


def assign_country(shapes, by_id, x, y, a3):
    """Return (worldId, how) or (None, why). Plan §4 step 4, plus the dot rule below."""
    hits = [s for s in shapes if s.contains(x, y)]
    if hits:
        ids = [s.id for s in hits]
        if a3 in ids:
            return a3, 'pip'
        pick = min(hits, key=lambda s: s.area).id  # nested polygons: the enclave wins
    else:
        pick = None
    # Dot rule: microstates/islands drawn as dots have tiny, crude polygons in world.json, so their
    # cities often land in the neighbour or the sea. If Natural Earth's country is a dot place on
    # our map and its polygon is within 3 units, trust Natural Earth.
    own = by_id.get(a3)
    if own is not None and own.dot and own.dist(x, y, FALLBACK_DIST) <= FALLBACK_DIST and pick != a3:
        return a3, 'dot'
    if pick:
        return pick, 'pip'
    if own is not None and own.dist(x, y, FALLBACK_DIST) <= FALLBACK_DIST:
        return a3, 'near-a3'
    best, bd = None, math.inf
    for s in shapes:
        d = s.dist(x, y, FALLBACK_DIST)
        if d < bd:
            best, bd = s.id, d
    if bd <= FALLBACK_DIST:
        return best, 'nearest'
    return None, f'no polygon within {FALLBACK_DIST} units'


# ---------------------------------------------------------------- names

SPECIAL_FOLD = str.maketrans({'ß': 'ss', 'ø': 'o', 'Ø': 'o', 'æ': 'ae', 'Æ': 'ae', 'ł': 'l', 'Ł': 'l',
                              'đ': 'd', 'Đ': 'd', 'ı': 'i', 'œ': 'oe', 'Œ': 'oe', 'þ': 'th', 'ð': 'd'})


def fold(s):
    s = s.translate(SPECIAL_FOLD)
    s = ''.join(c for c in unicodedata.normalize('NFKD', s) if not unicodedata.combining(c))
    return ' '.join(s.lower().split())


def is_latin(s):
    for c in s:
        if c.isalpha() and 'LATIN' not in unicodedata.name(c, ''):
            return False
    return True


def clean(v):
    if v is None:
        return None
    v = ' '.join(str(v).split())
    return v or None


def aliases_for(p):
    name = clean(p['NAME'])
    seen = {fold(name)}
    out = []
    raw = [p.get('NAMEASCII'), p.get('NAME_EN')]
    for f in ('NAMEALT', 'NAMEPAR'):  # NAMEALT sometimes lists several names separated by |
        v = clean(p.get(f))
        raw += v.split('|') if v else []
    raw += [p.get(f) for f in LATIN_ALIAS_FIELDS]
    for v in raw:
        v = clean(v)
        if not v or not is_latin(v):
            continue
        k = fold(v)
        if k in seen:
            continue
        seen.add(k)
        out.append(v)
    return out


def flags_for(p):
    fc = p['FEATURECLA']
    if fc == 'Admin-0 capital':
        return 2
    if 'capital' in fc:  # admin-1 capitals; also secondary and territory capitals (see report)
        return 1
    return 0


# ---------------------------------------------------------------- build

def self_checks(world, src_rows):
    """Plan §4 step 3. Returns a dict of numbers; fails the build on any miss."""
    out = {}
    # (a) sphere edge: every vertex of world.sphere vs the projected outline (antimeridian + poles)
    edge = []
    n = 3600
    for i in range(n + 1):
        phi = -90 + 180 * i / n
        edge.append(project(180, phi))
        edge.append(project(-180, phi))
    for i in range(n + 1):
        lam = -180 + 360 * i / n
        edge.append(project(lam, 90))
        edge.append(project(lam, -90))
    verts = [tuple(map(float, q.split(','))) for q in re.findall(r'-?[\d.]+,-?[\d.]+', world['sphere'])]
    err_a = max(min(math.hypot(vx - ex, vy - ey) for ex, ey in edge) for vx, vy in verts)
    out['sphere_max_err'] = err_a
    out['sphere_height'] = project(0, -90)[1] - project(0, 90)[1]
    # (b) known dot places vs their capitals in the source
    dots = {p['id']: p['dot'] for p in world['places'] if 'dot' in p}
    caps = {}
    for p, lon, lat in src_rows:
        if p['FEATURECLA'] == 'Admin-0 capital' and p['ADM0_A3'] in DOT_CHECK:
            caps[p['ADM0_A3']] = (lon, lat, p['NAME'])
    pairs = []
    errs = {}
    for cid in DOT_CHECK:
        if cid not in caps or cid not in dots:
            fail(f'self-check (b): missing capital or dot for {cid}')
        lon, lat, nm = caps[cid]
        x, y = project(lon, lat)
        errs[cid] = (nm, math.hypot(x - dots[cid][0], y - dots[cid][1]))
        X, Y = ee_raw(math.radians(lon), math.radians(lat))
        pairs.append((X, Y, dots[cid][0], dots[cid][1]))
    med = statistics.median(e for _, e in errs.values())
    out['dot_errors'] = errs
    out['dot_median'] = med
    # (c) least squares x = tx + s*X, y = ty - s*Y (one s for both axes)
    # unknowns (s, tx, ty); normal equations of rows [X,1,0]->x and [-Y,0,1]->y
    S = [[0.0] * 3 for _ in range(3)]
    b = [0.0] * 3
    for X, Y, x, y in pairs:
        for row, v in (([X, 1.0, 0.0], x), ([-Y, 0.0, 1.0], y)):
            for i in range(3):
                b[i] += row[i] * v
                for j in range(3):
                    S[i][j] += row[i] * row[j]
    s_fit, tx_fit, ty_fit = solve3(S, b)
    out['fit'] = (s_fit, tx_fit, ty_fit)
    rel = max(abs(s_fit - SCALE) / SCALE, abs(tx_fit - TX) / TX, abs(ty_fit - TY) / TY)
    out['fit_rel'] = rel
    problems = []
    if err_a > 0.2:
        problems.append(f'(a) sphere edge max error {err_a:.3f} > 0.2')
    if med >= 0.5:
        problems.append(f'(b) dot median error {med:.3f} >= 0.5')
    if rel > 0.001:
        problems.append(f'(c) fitted s/tx/ty {s_fit:.4f}/{tx_fit:.3f}/{ty_fit:.3f} off by {rel:.4%} > 0.1%')
    if problems:
        fail('projection self-check failed: ' + '; '.join(problems))
    return out


def solve3(A, b):
    A = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(3):
        p = max(range(c, 3), key=lambda r: abs(A[r][c]))
        A[c], A[p] = A[p], A[c]
        for r in range(3):
            if r != c:
                f = A[r][c] / A[c][c]
                for k in range(c, 4):
                    A[r][k] -= f * A[c][k]
    return [A[i][3] / A[i][i] for i in range(3)]


def zoom_tiers(rows):
    """rows in rank order with x,y. z = smallest k in [1,10] at which the city is >= 8 px (360 px
    reference) from every higher-ranked city; rounded up to 0.1 so the rule still holds at z."""
    need = MIN_SPACING_PX / REF_PX_PER_UNIT  # units of separation required at k = 1
    cell = need
    grid = {}
    zs = []
    for r in rows:
        x, y = r['x'], r['y']
        gx, gy = int(x // cell), int(y // cell)
        dmin = math.inf
        for i in range(gx - 1, gx + 2):
            for j in range(gy - 1, gy + 2):
                for (ox, oy) in grid.get((i, j), ()):
                    dmin = min(dmin, math.hypot(x - ox, y - oy))
        if dmin >= need:
            z = Z_MIN
        elif dmin == 0:
            z = Z_MAX
        else:
            z = min(Z_MAX, max(Z_MIN, math.ceil(need / dmin * 10 - 1e-9) / 10))
        zs.append(z)
        grid.setdefault((gx, gy), []).append((x, y))
    return zs


def build(src_arg=None, quiet=False):
    log = (lambda *a: None) if quiet else (lambda *a: print(*a))
    pin = json.loads(SOURCE.read_text(encoding='utf-8'))
    world = json.loads(WORLD.read_text(encoding='utf-8'))
    overrides = {k: v for k, v in json.loads(OVERRIDES.read_text(encoding='utf-8')).items() if not k.startswith('_')}
    remap = {k: v for k, v in json.loads(REMAP.read_text(encoding='utf-8')).items() if not k.startswith('_')}
    gj = load_source(src_arg, pin)

    feats = gj.get('features') or fail('source has no features')
    missing = [f for f in REQUIRED if f not in feats[0]['properties']]
    if missing:
        fail(f'source is missing expected fields: {missing}')
    all_ids = [f['properties'].get('NE_ID') for f in feats]
    if any(not isinstance(i, int) or i <= 0 for i in all_ids):
        fail('source has rows without a valid NE_ID')
    if len(set(all_ids)) != len(all_ids):
        fail('NE_ID is not unique in the source')

    src_rows = []
    for f in feats:
        g = f.get('geometry') or {}
        if g.get('type') != 'Point':
            fail(f'non-point geometry for NE_ID {f["properties"]["NE_ID"]}')
        lon, lat = g['coordinates'][:2]
        src_rows.append((f['properties'], lon, lat))

    checks = self_checks(world, src_rows)

    # ---- selection
    def keep(p, cut):
        return (p['FEATURECLA'].startswith('Admin-0 capital') or (p['POP_MAX'] or 0) >= cut
                or (p['SCALERANK'] is not None and p['SCALERANK'] <= SCALERANK_CUT))
    cut = POP_CUT
    sel = [r for r in src_rows if keep(r[0], cut)]
    if len(sel) > COUNT_GUARD:
        cut = POP_CUT_GUARD
        sel = [r for r in src_rows if keep(r[0], cut)]
        log(f'NOTE: default rule kept more than {COUNT_GUARD}; population cut raised to {cut:,}')
    log(f'source rows {len(src_rows)}, selected {len(sel)} (capitals + POP_MAX >= {cut:,} + SCALERANK <= {SCALERANK_CUT})')

    shapes = [Shape(p) for p in world['places']]
    by_id = {s.id: s for s in shapes}

    rows, dropped, disagree, how_count, used_over = [], [], [], {}, set()
    for p, lon, lat in sel:
        x, y = project(lon, lat)
        a3 = A3_ALIAS.get(p['ADM0_A3'], p['ADM0_A3'])
        nid = str(p['NE_ID'])
        w, how = assign_country(shapes, by_id, x, y, a3)
        w0 = w
        if nid in overrides:
            o = overrides[nid]
            if fold(o.get('name', '')) != fold(p['NAME']):
                fail(f'override {nid} names {o.get("name")!r} but the source row is {p["NAME"]!r}')
            if o['w'] not in by_id:
                fail(f'override {nid} points at unknown world id {o["w"]}')
            used_over.add(nid)
            if o['w'] != w:
                how = f'override (computed {w})'
            else:
                how = 'override'
            w = o['w']
        if w is None:
            dropped.append((p['NAME'], a3, p['NE_ID'], how))
            continue
        how_count[how.split(' ')[0]] = how_count.get(how.split(' ')[0], 0) + 1
        if w != a3 or w0 != a3:
            disagree.append((p['NAME'], p['NE_ID'], a3, w, how))
        rows.append({'p': p, 'id': p['NE_ID'], 'x': x, 'y': y, 'w': w, 'pop': p['POP_MAX'] or 0,
                     'sr': p['SCALERANK'] if p['SCALERANK'] is not None else 99, 'k': flags_for(p)})
    stale = sorted(set(overrides) - used_over)
    if stale:
        fail(f'overrides for rows not in the selection: {stale}')

    # ---- duplicates (same wikidataid, or same name within DUP_DIST); keep higher population
    rows.sort(key=lambda r: (-r['pop'], r['id']))
    merged = []
    wd_conflicts = []
    kept = []
    by_wd = {}
    by_name = {}
    for r in rows:
        wd = r['p'].get('WIKIDATAID')
        nk = fold(r['p']['NAME'])
        twin = by_wd.get(wd) if wd else None
        if twin is not None and math.hypot(r['x'] - twin['x'], r['y'] - twin['y']) > WD_MERGE_MAX:
            wd_conflicts.append((r['p']['NAME'], r['id'], twin['p']['NAME'], twin['id'], wd))
            twin = None
        if twin is None:
            for o in by_name.get(nk, ()):
                if math.hypot(r['x'] - o['x'], r['y'] - o['y']) < DUP_DIST:
                    twin = o
                    break
        if twin is not None:
            merged.append((r['p']['NAME'], r['id'], twin['p']['NAME'], twin['id']))
            twin['k'] = max(twin['k'], r['k'])
            continue
        kept.append(r)
        if wd:
            by_wd[wd] = r
        by_name.setdefault(nk, []).append(r)
    rows = kept

    # ---- rank: national capital first, then POP_MAX, then SCALERANK, then ne_id
    rows.sort(key=lambda r: (0 if r['k'] == 2 else 1, -r['pop'], r['sr'], r['id']))
    for r, z in zip(rows, zoom_tiers(rows)):
        r['z'] = z

    # ---- admin-1 table
    adm = sorted({clean(r['p'].get('ADM1NAME')) for r in rows} - {None})
    adm_ix = {a: i for i, a in enumerate(adm)}

    out_rows = []
    for r in rows:
        p = r['p']
        al = aliases_for(p)
        a1 = clean(p.get('ADM1NAME'))
        out_rows.append([r['id'], clean(p['NAME']), al or 0, r['w'], adm_ix[a1] if a1 else -1, r['k'],
                         round(r['z'], 1), round(r['x'], 1), round(r['y'], 1)])

    head = {'v': 1, 'src': f'ne_10m_populated_places {pin["tag"]} {pin["commit"][:12]}',
            'proj': f'equalearth s={SCALE:.4f} t={TX:g},{TY:g}', 'r': adm}
    dumps = lambda v: json.dumps(v, ensure_ascii=False, separators=(',', ':'))
    text = dumps(head)[:-1] + ',"c":[\n' + ',\n'.join(dumps(r) for r in out_rows) + '\n]}\n'

    # ---- id lock file
    ids_now = {f'C-{r[0]}' for r in out_rows}
    prev = set(json.loads(IDS.read_text(encoding='utf-8'))) if IDS.exists() else set()
    lost = []
    for old in sorted(prev - ids_now):
        tgt = remap.get(old)
        if tgt == 'retired':
            continue
        if tgt and tgt in ids_now:
            continue
        lost.append(old)
    if lost:
        fail(f'{len(lost)} published city ids disappeared without an entry in tools/cities-remap.json: {lost[:20]}')
    bad_remap = [k for k, v in remap.items() if v != 'retired' and v not in ids_now]
    if bad_remap:
        fail(f'cities-remap.json maps to ids that are not published: {bad_remap}')
    ids_text = '[\n' + ',\n'.join(json.dumps(i) for i in sorted(prev | ids_now | set(remap))) + '\n]\n'

    report = dict(checks=checks, rows=out_rows, adm=adm, dropped=dropped, disagree=disagree,
                  merged=merged, wd_conflicts=wd_conflicts, how=how_count, cut=cut, text=text)
    return text, ids_text, report


def print_report(rep):
    c = rep['checks']
    rows = rep['rows']
    print(f'projection: s={SCALE:.4f} tx={TX} ty={TY}; sphere height {c["sphere_height"]:.2f}')
    print(f'  (a) sphere edge max error {c["sphere_max_err"]:.3f} (limit 0.2)')
    print('  (b) dot errors: ' + ', '.join(f'{k} {n} {e:.2f}' for k, (n, e) in c['dot_errors'].items())
          + f'; median {c["dot_median"]:.3f} (limit 0.5)')
    s, tx, ty = c['fit']
    print(f'  (c) least-squares s={s:.4f} tx={tx:.3f} ty={ty:.3f}; max relative diff {c["fit_rel"]:.4%} (limit 0.1%)')
    print(f'cities: {len(rows)}; capitals (flag 2): {sum(r[5] == 2 for r in rows)}; '
          f'admin-1/secondary capitals (flag 1): {sum(r[5] == 1 for r in rows)}; '
          f'countries/places covered: {len({r[3] for r in rows})}; admin-1 names: {len(rep["adm"])}')
    tiers = {}
    for r in rows:
        t = min(10, math.ceil(r[6]))
        tiers[t] = tiers.get(t, 0) + 1
    print('per tier (z rounded up): ' + ', '.join(f'{t}:{tiers[t]}' for t in sorted(tiers))
          + f'; visible at k=1 on a 360px frame: {sum(r[6] <= 1 for r in rows)}')
    per = {}
    for r in rows:
        per[r[3]] = per.get(r[3], 0) + 1
    print('per country: ' + ' '.join(f'{k}:{v}' for k, v in sorted(per.items(), key=lambda kv: (-kv[1], kv[0]))))
    print('assignment: ' + ', '.join(f'{k} {v}' for k, v in sorted(rep['how'].items())))
    print(f'dropped ({len(rep["dropped"])}): ' + '; '.join(f'{n} [{a}] {i}: {w}' for n, a, i, w in rep['dropped']))
    print(f'merged duplicates ({len(rep["merged"])}): ' + '; '.join(f'{a} {i} into {b} {j}' for a, i, b, j in rep['merged']))
    print(f'wikidataid shared by far-apart rows, kept both ({len(rep["wd_conflicts"])}): '
          + '; '.join(f'{a} {i} / {b} {j} ({w})' for a, i, b, j, w in rep['wd_conflicts']))
    print(f'polygon vs ADM0_A3 disagreements ({len(rep["disagree"])}):')
    for n, i, a3, w, how in sorted(rep['disagree'], key=lambda d: (d[2], d[3], d[0])):
        print(f'  {n} ({i}) NE {a3} -> map {w} [{how}]' + ('' if how.startswith('override') else '  UNREVIEWED: pin in tools/cities-overrides.json'))
    raw = rep['text'].encode('utf-8')
    print(f'size: {len(raw):,} bytes raw, {len(gzip.compress(raw, 9, mtime=0)):,} bytes gzip')


def main():
    args = sys.argv[1:]
    src = None
    if '--src' in args:
        i = args.index('--src')
        if i + 1 >= len(args):
            fail('--src needs a path')
        src = args[i + 1]
    check = '--check' in args
    text, ids_text, rep = build(src, quiet=check)
    if check:
        bad = [p.relative_to(ROOT).as_posix() for p, t in ((OUT, text), (IDS, ids_text))
               if not p.exists() or p.read_text(encoding='utf-8') != t]
        if bad:
            print('out of date: ' + ', '.join(bad) + ' (run python3 tools/make-cities.py)', file=sys.stderr)
            sys.exit(1)
        print(f'cities.json and cities-ids.json are current ({len(rep["rows"])} cities)')
        return
    OUT.write_text(text, encoding='utf-8')
    IDS.write_text(ids_text, encoding='utf-8')
    print_report(rep)
    print(f'wrote {OUT.relative_to(ROOT)} and {IDS.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
