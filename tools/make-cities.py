#!/usr/bin/env python3
"""Build data/cities.json (and the id lock file data/cities-ids.json) from Natural Earth.

Usage:
    python3 tools/make-cities.py                     fetch the pinned source, write both files
    python3 tools/make-cities.py --src local.geojson use a local copy (its SHA-256 must still match)
    python3 tools/make-cities.py --check             regenerate in memory, exit 1 if either file differs
    python3 tools/make-cities.py --fit-na            fit the U.S. & Canada map projections from scratch and print them

Source: Natural Earth 1:10m populated places (public domain), pinned in tools/cities-source.json.
The U.S. & Canada map fit (plan-cities §10, phase 2) also reads the 1:50m admin-1 and admin-0 files
pinned under "na_fit" in the same file (geometry only, to check the projection constants below).
The script refuses a file whose SHA-256 differs from the pin. See docs/plan-cities.md for the rules
(selection, Equal Earth projection, country assignment, names, zoom tiers, NA map, output format).
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
NAMAP = ROOT / 'data' / 'na.json'
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

# ---- U.S. & Canada map (data/na.json; plan-cities §10 phase 2)
# Extra selection: every state/provincial/territorial capital of the U.S. and Canada, and every row
# of the five U.S. territories on the map's insets (NE 1:10m has only a handful there).
NA_CAPITAL_A3 = {'USA', 'CAN'}
NA_TERRITORIES = {'PRI': 'US-PRI', 'VIR': 'US-VIR', 'GUM': 'US-GUM', 'MNP': 'US-MNP', 'ASM': 'US-ASM'}
NA_WORLD_IDS = {'USA', 'CAN'} | set(NA_TERRITORIES)      # world.json ids whose cities go on the NA map
NA_NEAR = 2.0               # NA map units: "inside" for the self-check, and the own-polygon fallback
NA_FALLBACK = 3.0           # NA map units: nearest-polygon fallback
NA_PIP_MIN = 0.98           # self-check: share of NA cities inside (or within NA_NEAR of) their own polygon
NA_VERTEX_MAX = 0.5         # self-check: median distance of na.json vertices to the projected source outline
NA_ANCHOR_MAX = 0.5         # self-check: median error of the anchor dots
NA_FIT_REL = 0.001          # self-check: least-squares refit within 0.1% of the constants
# Projections, reproduced from na.json by least squares (python3 tools/make-cities.py --fit-na prints
# the fit). Screen x = tx + s*X, y = ty - s*Y over the raw projection (X, Y), like d3.
#   conic = d3.geoConicEqualArea raw with parallels (p0, p1) after rotating longitudes by `rot` degrees
#   merc  = d3.geoMercator raw (no rotation)
NA_MAIN = {'proj': ('conic', 40.0, 62.0, 100.0), 's': 857.3514, 'tx': 545.3216, 'ty': 1187.4781}
NA_INSET_PROJ = {     # by inset id; the transform constants are the fitted ones
    'US-HI': {'proj': ('conic', 8.0, 18.0, 157.0), 's': 1691.9365, 'tx': 112.1869, 'ty': 1547.7170},
    'US-PRI': {'proj': ('merc',), 's': 2688.7364, 'tx': 3392.1130, 'ty': 1811.5451},
    'US-VIR': {'proj': ('merc',), 's': 7651.6594, 'tx': 9063.1155, 'ty': 3391.5353},
    'US-GUM': {'proj': ('merc',), 's': 14667.0112, 'tx': -36532.7443, 'ty': 4413.4604},
    'US-MNP': {'proj': ('merc',), 's': 1123.3106, 'tx': -2198.9737, 'ty': 1268.5001},
    'US-ASM': {'proj': ('merc',), 's': 24743.6259, 'tx': 74502.1380, 'ty': -5303.5176},
    'US-DC': {'proj': ('merc',), 's': 20848.5702, 'tx': 28952.6574, 'ty': 16332.5159},
}
# Hawaii's inset shows the eight main islands only (the 1:50m state also has the Northwestern
# Hawaiian Islands); these bounds pick the source vertices and the cities that belong in it.
HI_BOUNDS = (-161.0, 18.0, -154.0, 23.0)
# Anchor dots in na.json and the Natural Earth city that should sit on them (self-check)
NA_ANCHORS = {'US-DC': 1159151573}   # Washington, D.C.


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
        stem = Path(pin['path']).stem
        cache = Path(os.environ.get('TMPDIR') or tempfile.gettempdir()) / f'{stem}-{pin["sha256"][:16]}.geojson'
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

# ---------------------------------------------------------------- U.S. & Canada map (phase 2)

def conic_raw(p0, p1, rot):
    """d3.geoConicEqualArea raw projection after d3.geoRotate([rot, 0]) (longitude wrapped)."""
    y0, y1 = math.radians(p0), math.radians(p1)
    sy0 = math.sin(y0)
    n = (sy0 + math.sin(y1)) / 2
    c = 1 + sy0 * (2 * n - sy0)
    r0 = math.sqrt(c) / n

    def f(lon, lat):
        lam = math.radians(((lon + rot + 180.0) % 360.0) - 180.0)
        r = math.sqrt(max(0.0, c - 2 * n * math.sin(math.radians(lat)))) / n
        return r * math.sin(lam * n), r0 - r * math.cos(lam * n)
    return f


def merc_raw(lon, lat):
    return math.radians(lon), math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def raw_of(spec):
    return conic_raw(*spec[1:]) if spec[0] == 'conic' else merc_raw


class Frame:
    """One drawing frame of the NA map: the main map or an inset. Projects lon/lat to na.json units."""
    def __init__(self, key, cfg, shapes, box=None, index=-1):
        self.key, self.cfg, self.shapes, self.box, self.index = key, cfg, shapes, box, index
        self.raw = raw_of(cfg['proj'])

    def project(self, lon, lat, s=None, tx=None, ty=None):
        X, Y = self.raw(lon, lat)
        s = self.cfg['s'] if s is None else s
        tx = self.cfg['tx'] if tx is None else tx
        ty = self.cfg['ty'] if ty is None else ty
        return tx + s * X, ty - s * Y

    def describe(self):
        pj = self.cfg['proj']
        name = f'conic {pj[1]:g}/{pj[2]:g} rot {pj[3]:g}' if pj[0] == 'conic' else 'mercator'
        return f'{name} s={self.cfg["s"]:.4f} t={self.cfg["tx"]:.4f},{self.cfg["ty"]:.4f}'


def na_frames(na):
    main = Frame('main', NA_MAIN, [Shape(p) for p in na['places']])
    frames = {'main': main}
    for i, ins in enumerate(na['insets']):
        iid = ins.get('id') or ins['places'][0]['id']
        if iid not in NA_INSET_PROJ:
            fail(f'na.json inset {iid} has no projection in NA_INSET_PROJ')
        frames[iid] = Frame(iid, NA_INSET_PROJ[iid], [Shape(p) for p in ins['places']],
                            (ins['x'], ins['y'], ins['x'] + ins['w'], ins['y'] + ins['h']), i)
    return frames


def geom_points(geom, bounds=None):
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    out = []
    for poly in polys:
        for ring in poly:
            for lon, lat in ring:
                if bounds and not (bounds[0] <= lon <= bounds[2] and bounds[1] <= lat <= bounds[3]):
                    continue
                out.append((lon, lat))
    return out


class PtGrid:
    def __init__(self, pts, cell=2.0):
        self.cell = cell
        self.g = {}
        for p in pts:
            self.g.setdefault((int(p[0] // cell), int(p[1] // cell)), []).append(p)

    def near(self, x, y, reach=3):
        cx, cy = int(x // self.cell), int(y // self.cell)
        best, bd = None, math.inf
        for i in range(cx - reach, cx + reach + 1):
            for j in range(cy - reach, cy + reach + 1):
                for p in self.g.get((i, j), ()):
                    d = (p[0] - x) ** 2 + (p[1] - y) ** 2
                    if d < bd:
                        best, bd = p, d
        return best, math.sqrt(bd)


def lsq_fit(pairs):
    """least squares x = tx + s*X, y = ty - s*Y (one s for both axes). pairs: (X, Y, x, y)."""
    S = [[0.0] * 3 for _ in range(3)]
    b = [0.0] * 3
    for X, Y, x, y in pairs:
        for row, v in (([X, 1.0, 0.0], x), ([-Y, 0.0, 1.0], y)):
            for i in range(3):
                b[i] += row[i] * v
                for j in range(3):
                    S[i][j] += row[i] * row[j]
    return solve3(S, b)


def fit_frame(frame, groups):
    """groups: [(lonlat points, na.json vertices)] for one frame. Starts from a bounding-box match,
    then iterates nearest-vertex least squares (ICP). Returns (s, tx, ty, errors)."""
    # start: least squares over every polygon's bounding-box edges (x edges and y edges share s)
    data = []
    S = [[0.0] * 3 for _ in range(3)]
    b = [0.0] * 3
    for pts, V in groups:
        P = [frame.raw(lo, la) for lo, la in pts]
        data.append((P, V))
        xs, ys = [p[0] for p in P], [p[1] for p in P]
        vx, vy = [v[0] for v in V], [v[1] for v in V]
        for row, v in (([min(xs), 1.0, 0.0], min(vx)), ([max(xs), 1.0, 0.0], max(vx)),
                       ([-max(ys), 0.0, 1.0], min(vy)), ([-min(ys), 0.0, 1.0], max(vy))):
            for i in range(3):
                b[i] += row[i] * v
                for j in range(3):
                    S[i][j] += row[i] * row[j]
    s, tx, ty = solve3(S, b)
    errs = []
    for _ in range(10):
        pairs, errs = [], []
        for P, V in data:
            g = PtGrid([(tx + s * X, ty - s * Y, X, Y) for X, Y in P])
            for x, y in V:
                q, d = g.near(x, y)
                if q is None:
                    continue
                errs.append(d)
                if d < 1.5:
                    pairs.append((q[2], q[3], x, y))
        if len(pairs) < 3:
            fail(f'NA fit for {frame.key}: too few matching vertices')
        s, tx, ty = lsq_fit(pairs)
    return s, tx, ty, sorted(errs)


def outline_errors(frame, groups):
    """distance of every na.json vertex to the nearest projected source vertex, with the constants."""
    errs = []
    for pts, V in groups:
        g = PtGrid([frame.project(lo, la) for lo, la in pts])
        for x, y in V:
            q, d = g.near(x, y, reach=6)
            errs.append(d if q is not None else math.inf)
    return sorted(errs)


def na_fit_groups(na, frames, a1, a0):
    """source outlines matched to na.json polygons, per frame: admin-1 for states/provinces/DC/Hawaii,
    admin-0 for the territories."""
    by_iso = {}
    for f in a1['features']:
        pr = f['properties']
        if pr.get('adm0_a3') in NA_CAPITAL_A3:
            by_iso[pr['iso_3166_2']] = f['geometry']
    by_a3 = {}
    for f in a0['features']:
        pr = f['properties']
        if pr.get('ADM0_A3') in NA_TERRITORIES:
            by_a3[pr['ADM0_A3']] = f['geometry']
    groups = {k: [] for k in frames}
    for p in na['places']:
        if p['id'] not in by_iso:
            fail(f'NA fit: no admin-1 outline for {p["id"]}')
        groups['main'].append((geom_points(by_iso[p['id']]), [v for r in parse_rings(p['d']) for v in r]))
    for k, fr in frames.items():
        if k == 'main':
            continue
        a3 = k[3:]
        if a3 in by_a3:
            pts = geom_points(by_a3[a3])
        elif k in by_iso:
            pts = geom_points(by_iso[k], HI_BOUNDS if k == 'US-HI' else None)
        else:
            fail(f'NA fit: no outline for inset {k}')
        ins = na['insets'][fr.index]
        V = [v for p in ins['places'] for r in parse_rings(p['d']) for v in r]
        groups[k].append((pts, V))
    return groups


def na_checks(na, frames, a1, a0):
    """Projection self-checks for the NA map (fail the build on a miss). Returns numbers for the report."""
    groups = na_fit_groups(na, frames, a1, a0)
    out = {'frames': {}}
    problems = []
    for k, fr in frames.items():
        errs = outline_errors(fr, groups[k])
        med, p95 = errs[len(errs) // 2], errs[int(len(errs) * 0.95)]
        s, tx, ty, _ = fit_frame(fr, groups[k])
        # how far the refit moves the projected outline, in map units
        pts = [pt for g in groups[k] for pt in g[0]]
        moved = max(math.hypot(a[0] - b[0], a[1] - b[1]) for a, b in
                    ((fr.project(lo, la), fr.project(lo, la, s, tx, ty)) for lo, la in pts))
        rel = abs(s - fr.cfg['s']) / fr.cfg['s']
        out['frames'][k] = dict(n=len(errs), median=med, p95=p95, fit=(s, tx, ty), rel=rel, moved=moved)
        if med >= NA_VERTEX_MAX:
            problems.append(f'{k}: outline median error {med:.3f} >= {NA_VERTEX_MAX}')
        if rel > NA_FIT_REL or moved > 0.1:
            problems.append(f'{k}: refit s={s:.4f} t={tx:.4f},{ty:.4f} differs from the constants '
                            f'(scale {rel:.4%}, outline moves {moved:.3f} units)')
    if problems:
        fail('NA projection self-check failed: ' + '; '.join(problems))
    return out


def na_fit_report(na, a1, a0):
    """--fit-na: fit every frame from scratch and print constants to paste into NA_MAIN / NA_INSET_PROJ."""
    frames = na_frames(na)
    groups = na_fit_groups(na, frames, a1, a0)
    for k, fr in frames.items():
        s, tx, ty, errs = fit_frame(fr, groups[k])
        print(f"{k:7s} {fr.cfg['proj']}: 's': {s:.4f}, 'tx': {tx:.4f}, 'ty': {ty:.4f}  "
              f'(vertices {len(errs)}, median {errs[len(errs) // 2]:.3f}, p95 {errs[int(len(errs) * 0.95)]:.3f})')
    for p0, p1, rot in [(29.5, 45.5, 100), (40, 62, 96), (40, 62, 104), (39, 62, 100), (41, 62, 100), (40, 61, 100), (40, 63, 100)]:
        fr = Frame('main', {'proj': ('conic', p0, p1, rot), 's': 1, 'tx': 0, 'ty': 0}, [])
        s, tx, ty, errs = fit_frame(fr, groups['main'])
        print(f'  alternative main conic {p0}/{p1} rot {rot}: median {errs[len(errs) // 2]:.3f} p95 {errs[int(len(errs) * 0.95)]:.3f}')


def na_place(frames, by_shape_id, x, y, own, frame):
    """NA polygon for a projected city. Returns (id, how) or (None, why)."""
    hits = [sh for sh in frame.shapes if sh.contains(x, y)]
    if hits:
        ids = [sh.id for sh in hits]
        if own in ids:
            return own, 'pip'
        return min(hits, key=lambda sh: sh.area).id, 'pip'
    sh = by_shape_id.get(own)
    if sh is not None and sh in frame.shapes and sh.dist(x, y, NA_NEAR) <= NA_NEAR:
        return own, 'near-own'
    best, bd = None, math.inf
    for sh in frame.shapes:
        d = sh.dist(x, y, NA_FALLBACK)
        if d < bd:
            best, bd = sh.id, d
    if bd <= NA_FALLBACK:
        return best, 'nearest'
    if own and own in by_shape_id:
        return own, 'admin-1'
    return None, f'no NA polygon within {NA_FALLBACK} units'


def na_frame_for(frames, p, w, lon, lat, own):
    if w in NA_TERRITORIES:
        return frames[NA_TERRITORIES[w]]
    if own == 'US-HI' or (HI_BOUNDS[0] <= lon <= HI_BOUNDS[2] and HI_BOUNDS[1] <= lat <= HI_BOUNDS[3]):
        return frames['US-HI']
    return frames['main']


def zoom_tiers(rows, kx='x', ky='y'):
    """rows in rank order with x,y (or the keys kx, ky). z = smallest k in [1,10] at which the city is >= 8 px (360 px
    reference) from every higher-ranked city; rounded up to 0.1 so the rule still holds at z."""
    need = MIN_SPACING_PX / REF_PX_PER_UNIT  # units of separation required at k = 1
    cell = need
    grid = {}
    zs = []
    for r in rows:
        x, y = r[kx], r[ky]
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
    na = json.loads(NAMAP.read_text(encoding='utf-8'))
    fit_src = {f['role']: f for f in pin.get('na_fit', [])}
    if set(fit_src) != {'admin1', 'admin0'}:
        fail('tools/cities-source.json needs "na_fit" pins with roles admin1 and admin0')
    a1 = load_source(None, fit_src['admin1'])
    a0 = load_source(None, fit_src['admin0'])

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
    frames = na_frames(na)
    checks['na'] = na_checks(na, frames, a1, a0)
    # admin-1 name (as in the populated places' ADM1NAME) -> NA map id
    adm1_to_na = {f['properties']['name']: f['properties']['iso_3166_2'] for f in a1['features']
                  if f['properties'].get('adm0_a3') in NA_CAPITAL_A3}

    # ---- selection
    def keep(p, cut):
        return (p['FEATURECLA'].startswith('Admin-0 capital') or (p['POP_MAX'] or 0) >= cut
                or (p['SCALERANK'] is not None and p['SCALERANK'] <= SCALERANK_CUT))
    def na_extra(p):   # phase 2: every U.S./Canadian admin-1 capital, every U.S. territory row
        return ((p['FEATURECLA'] == 'Admin-1 capital' and p['ADM0_A3'] in NA_CAPITAL_A3)
                or p['ADM0_A3'] in NA_TERRITORIES)
    cut = POP_CUT
    sel = [r for r in src_rows if keep(r[0], cut)]
    if len(sel) > COUNT_GUARD:
        cut = POP_CUT_GUARD
        sel = [r for r in src_rows if keep(r[0], cut)]
        log(f'NOTE: default rule kept more than {COUNT_GUARD}; population cut raised to {cut:,}')
    base_n = len(sel)
    na_added = [r for r in src_rows if not keep(r[0], cut) and na_extra(r[0])]
    sel += na_added
    log(f'source rows {len(src_rows)}, selected {len(sel)} (capitals + POP_MAX >= {cut:,} + SCALERANK <= {SCALERANK_CUT}: '
        f'{base_n}; plus U.S./Canadian admin-1 capitals and U.S. territory rows: {len(na_added)})')

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
            used_over.add(nid)
        if nid in overrides and 'w' in overrides[nid]:
            o = overrides[nid]
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
        rows.append({'p': p, 'id': p['NE_ID'], 'x': x, 'y': y, 'lon': lon, 'lat': lat, 'w': w, 'pop': p['POP_MAX'] or 0,
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

    # ---- U.S. & Canada map: position, frame (main map or inset), state/province/territory
    na_rows, na_how, na_disagree, na_dropped, na_used = [], {}, [], [], set()
    for r in rows:
        if r['w'] not in NA_WORLD_IDS:
            continue
        p = r['p']
        own = NA_TERRITORIES.get(r['w']) or adm1_to_na.get(clean(p.get('ADM1NAME')) or '')
        fr = na_frame_for(frames, p, r['w'], r['lon'], r['lat'], own)
        nx, ny = fr.project(r['lon'], r['lat'])
        local = {sh.id: sh for sh in fr.shapes}
        nid, how = na_place(frames, local, nx, ny, own, fr)
        o = overrides.get(str(r['id']), {})
        if 'na' in o:
            if o['na'] not in local:
                fail(f'override {r["id"]} points at NA id {o["na"]} that is not drawn where the city is ({fr.key})')
            na_used.add(str(r['id']))
            how = 'override' if o['na'] == nid else f'override (computed {nid})'
            nid = o['na']
        if nid is None:
            na_dropped.append((p['NAME'], r['id'], how))
            continue
        na_how[how.split(' ')[0]] = na_how.get(how.split(' ')[0], 0) + 1
        if nid != own:
            na_disagree.append((p['NAME'], r['id'], own, nid, how))
        sh = local.get(own)
        inside_own = sh is not None and (sh.contains(nx, ny) or sh.dist(nx, ny, NA_NEAR) <= NA_NEAR)
        r.update(nx=nx, ny=ny, inset=fr.index, na=nid, own=own, inside_own=inside_own)
        na_rows.append(r)
    stale_na = sorted(k for k, v in overrides.items() if 'na' in v and k not in na_used)
    if stale_na:
        fail(f'NA overrides for rows that are not on the NA map: {stale_na}')
    for r, z in zip(na_rows, zoom_tiers(na_rows, 'nx', 'ny')):
        r['nz'] = z
    # self-check: cities inside their own polygon; anchor dots
    share = sum(r['inside_own'] for r in na_rows) / max(1, len(na_rows))
    checks['na']['pip_share'] = share
    checks['na']['outside'] = [(r['p']['NAME'], r['id'], r['own'], r['na']) for r in na_rows if not r['inside_own']]
    by_name = {}
    for r in na_rows:
        by_name.setdefault(r['id'], r)
    anchors = {}
    dots = {pl['id']: (pl['dot'], -1) for pl in na['places'] if 'dot' in pl}
    for i, ins in enumerate(na['insets']):
        for pl in ins['places']:
            if 'dot' in pl:
                dots[pl['id']] = (pl['dot'], i)
    for pid, ne_id in NA_ANCHORS.items():
        r = by_name.get(ne_id)
        if pid not in dots or r is None:
            fail(f'NA anchor {pid}: missing dot or city {ne_id}')
        (dx, dy), _ = dots[pid]
        anchors[pid] = (r['p']['NAME'], math.hypot(r['nx'] - dx, r['ny'] - dy))
    checks['na']['anchors'] = anchors
    checks['na']['anchor_median'] = statistics.median(e for _, e in anchors.values())
    problems = []
    if share < NA_PIP_MIN:
        problems.append(f'only {share:.1%} of NA cities are inside (or within {NA_NEAR:g} units of) their own polygon (need {NA_PIP_MIN:.0%})')
    if checks['na']['anchor_median'] >= NA_ANCHOR_MAX:
        problems.append(f'anchor median error {checks["na"]["anchor_median"]:.3f} >= {NA_ANCHOR_MAX}')
    if problems:
        fail('NA self-check failed: ' + '; '.join(problems))

    # ---- admin-1 table
    adm = sorted({clean(r['p'].get('ADM1NAME')) for r in rows} - {None})
    adm_ix = {a: i for i, a in enumerate(adm)}

    out_rows = []
    for r in rows:
        p = r['p']
        al = aliases_for(p)
        an = clean(p.get('ADM1NAME'))
        row = [r['id'], clean(p['NAME']), al or 0, r['w'], adm_ix[an] if an else -1, r['k'],
               round(r['z'], 1), round(r['x'], 1), round(r['y'], 1)]
        if 'na' in r:     # v2: position on the U.S. & Canada map
            row += [round(r['nx'], 1), round(r['ny'], 1), r['inset'], r['na'], round(r['nz'], 1)]
        out_rows.append(row)

    head = {'v': 2, 'src': f'ne_10m_populated_places {pin["tag"]} {pin["commit"][:12]}',
            'proj': f'equalearth s={SCALE:.4f} t={TX:g},{TY:g}',
            'naProj': '; '.join(f'{k} {fr.describe()}' for k, fr in frames.items() if k != 'US-DC'), 'r': adm}
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
                  merged=merged, wd_conflicts=wd_conflicts, how=how_count, cut=cut, text=text,
                  na_added=[(r[0]['NAME'], r[0]['ADM0_A3'], r[0]['ADM1NAME']) for r in na_added],
                  na_how=na_how, na_disagree=na_disagree, na_dropped=na_dropped, na_rows=na_rows, na=na)
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
    print_na_report(rep)
    raw = rep['text'].encode('utf-8')
    print(f'size: {len(raw):,} bytes raw, {len(gzip.compress(raw, 9, mtime=0)):,} bytes gzip')


def print_na_report(rep):
    c = rep['checks']['na']
    na = rep['na']
    nrows = rep['na_rows']
    print(f'U.S. & Canada map: {len(nrows)} cities; added by the phase-2 rule: {len(rep["na_added"])}')
    for k, f in c['frames'].items():
        s, tx, ty = f['fit']
        print(f'  {k:7s} outline error median {f["median"]:.3f} p95 {f["p95"]:.3f} over {f["n"]} vertices (limit median {NA_VERTEX_MAX}); '
              f'refit s={s:.4f} t={tx:.4f},{ty:.4f}: scale off {f["rel"]:.4%}, outline moves {f["moved"]:.3f} units')
    print(f'  cities inside (or within {NA_NEAR:g} units of) their own polygon: {c["pip_share"]:.2%} (limit {NA_PIP_MIN:.0%})'
          + ''.join(f'; outside: {n} ({i}) own {o} -> {w}' for n, i, o, w in c['outside']))
    print('  anchors: ' + ', '.join(f'{k} {n} {e:.2f}' for k, (n, e) in c['anchors'].items())
          + f'; median {c["anchor_median"]:.3f} (limit {NA_ANCHOR_MAX})')
    print('  added: ' + '; '.join(f'{n} [{a}{", " + b if b else ""}]' for n, a, b in rep['na_added']))
    insets = {}
    for r in nrows:
        insets[r['inset']] = insets.get(r['inset'], 0) + 1
    print('  per frame: ' + ', '.join(f'{"main" if k < 0 else na["insets"][k]["label"]}:{v}' for k, v in sorted(insets.items())))
    per = {}
    for r in nrows:
        per[r['na']] = per.get(r['na'], 0) + 1
    ids = [p['id'] for p in na['places']] + [ins.get('id') for ins in na['insets'] if ins.get('id') != 'US-DC']
    print('  per state/province/territory: ' + ' '.join(f'{k}:{per.get(k, 0)}' for k in sorted(ids)))
    empty = [k for k in ids if not per.get(k)]
    print(f'  with no city: {empty or "none"}')
    tiers = {}
    for r in nrows:
        t = min(10, math.ceil(r['nz']))
        tiers[t] = tiers.get(t, 0) + 1
    print('  NA tiers (z rounded up): ' + ', '.join(f'{t}:{tiers[t]}' for t in sorted(tiers))
          + f'; visible at k=1 on a 360px frame: {sum(r["nz"] <= 1 for r in nrows)}')
    print('  assignment: ' + ', '.join(f'{k} {v}' for k, v in sorted(rep['na_how'].items())))
    if rep['na_dropped']:
        print('  no NA position: ' + '; '.join(f'{n} ({i}): {w}' for n, i, w in rep['na_dropped']))
    print(f'  polygon vs ADM1NAME disagreements ({len(rep["na_disagree"])}):')
    for n, i, own, w, how in sorted(rep['na_disagree'], key=lambda d: (str(d[2]), d[3], d[0])):
        print(f'    {n} ({i}) NE {own} -> map {w} [{how}]' + ('' if how.startswith('override') else '  UNREVIEWED: pin "na" in tools/cities-overrides.json'))


def main():
    args = sys.argv[1:]
    src = None
    if '--src' in args:
        i = args.index('--src')
        if i + 1 >= len(args):
            fail('--src needs a path')
        src = args[i + 1]
    check = '--check' in args
    if '--fit-na' in args:
        pin = json.loads(SOURCE.read_text(encoding='utf-8'))
        fit_src = {f['role']: f for f in pin.get('na_fit', [])}
        na_fit_report(json.loads(NAMAP.read_text(encoding='utf-8')), load_source(None, fit_src['admin1']),
                      load_source(None, fit_src['admin0']))
        return
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
