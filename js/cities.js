// Travel Atlas: cities layer on the World map and the U.S. & Canada map (docs/plan-cities.md §6-§8,
// §11 phase 2; docs/plan-ux.md §2.5).
// Classic script, loaded with <script defer> after app.js. Talks to app.js only through window.Atlas.
// The pure parts (parse, tier selection + culling, the nearest-city grid, label placement, search)
// are exported for Node tests via module.exports; in the page they hang off window.AtlasCities.
// Nothing is fetched until either map is zoomed to k >= 2, the search box is focused, or the
// store already holds a city mark (the counters and lists need the names).
// U.S./Canadian (and U.S. territory) cities are drawn on both maps; on the NA map they sit in the
// main map or in their inset (Hawaii, Puerto Rico, ...) and belong to a state/province/territory.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) { root.AtlasCities = api; if (root.document) api.boot(root); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const URL_DATA = './data/cities.json';
  const CAP = 600;               // hard cap on visible city circles (marked ones fill up to this)
  const TIER_CAP = 400;          // cities shown by tier alone (plan-ux §1.11 "capped ~400")
  const REF_W = 360;             // tiers were built for a 360 CSS px wide world map
  const HIT_PX = 12;             // a tap within 12 CSS px of a visible city marks it (nearest wins)
  const CELL = 32;               // hit grid cell, CSS px
  const LABELS_PHONE = 40, LABELS_DESK = 80, PHONE_W = 640;
  const LABEL_MIN_K = 2;         // names appear once the map is zoomed in a little
  const TIER_MIN_K = 2;          // below this zoom only marked cities show (plan-ux §6 state 7 "zoomed
                                 // out (marked only)"; also the lazy-load threshold). 1 = tier rule alone.
  const LABEL_PX = 10.5;         // city label font size, CSS px
  const R_PX = 2.4, R_MARKED = 3.2, R_CAPITAL = 3.6;   // dot radius, CSS px
  const FLAG_CAPITAL = 2;
  const FLASH_K = 4;
  const SEARCH_MAX = 6;
  const OFFLINE_NOTE = 'Cities need one online visit first.';
  const LABELLED_ADMIN = new Set(['USA', 'CAN']);      // lead decision: US/Canadian cities show state/province

  // ---------- text ----------
  // The app's fold (NFD, strip marks, lower case) plus letters NFD doesn't split (plan-cities §8),
  // and punctuation folded so "St. Louis", "T'Bilisi" and "Saint-Denis" match typed forms.
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/œ/g, 'oe')
      .replace(/ł/g, 'l').replace(/đ/g, 'd').replace(/ı/g, 'i').replace(/þ/g, 'th')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[‘’ʼ'`´.]/g, '')
      .replace(/[\s\-‐-―_,;:/()]+/g, ' ').trim();
  }

  // ---------- data ----------
  // Row: [ne_id, name, aliases|0, worldId, admin1Index|-1, flags, z, x, y] (plan-cities §5), rank-sorted.
  // v2 adds, for cities on the U.S. & Canada map: [..., nx, ny, inset|-1, naId, nz] (position on the
  // NA map, the inset it is drawn in, its state/province/territory id there, its NA zoom tier).
  // v1 files (no NA fields) still parse: the NA layer is then empty.
  function parse(d, remap) {
    if (!d || !Array.isArray(d.c) || !Array.isArray(d.r)) throw new Error('Bad cities data');
    const rows = d.c, n = rows.length;
    const C = {
      n, id: new Array(n), name: new Array(n), alias: new Array(n), cc: new Array(n), adm: new Array(n),
      flags: new Uint8Array(n), z: new Float32Array(n), x: new Float32Array(n), y: new Float32Array(n),
      na: new Uint8Array(n), nx: new Float32Array(n), ny: new Float32Array(n), nz: new Float32Array(n),
      ins: new Int8Array(n).fill(-1), st: new Array(n).fill(''), nli: new Int32Array(n).fill(-1),
      keys: new Array(n), all: new Array(n), dupName: new Uint8Array(n), byId: new Map(), remap: remap || {},
    };
    const naList = [];
    const seen = new Map();
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const id = 'C-' + r[0];
      C.id[i] = id; C.name[i] = r[1]; C.alias[i] = Array.isArray(r[2]) ? r[2] : [];
      C.cc[i] = r[3]; C.adm[i] = r[4] >= 0 && r[4] < d.r.length ? d.r[r[4]] : '';
      C.flags[i] = r[5]; C.z[i] = r[6]; C.x[i] = r[7]; C.y[i] = r[8];
      if (r.length >= 14 && typeof r[12] === 'string') {
        C.na[i] = 1; C.nx[i] = r[9]; C.ny[i] = r[10]; C.ins[i] = r[11]; C.st[i] = r[12]; C.nz[i] = r[13];
        C.nli[i] = naList.length; naList.push(i);
      }
      const keys = [norm(r[1])];
      for (const a of C.alias[i]) { const k = norm(a); if (k && !keys.includes(k)) keys.push(k); }
      C.keys[i] = keys; C.all[i] = keys.join('|');
      C.byId.set(id, i);
      const nk = keys[0];
      if (seen.has(nk)) { C.dupName[i] = 1; C.dupName[seen.get(nk)] = 1; } else seen.set(nk, i);
    }
    // old ids from tools/cities-remap.json ("C-old": "C-new" | "retired") resolve to their replacement
    for (const old in C.remap) { const nu = C.remap[old]; if (C.byId.has(nu) && !C.byId.has(old)) C.byId.set(old, C.byId.get(nu)); }
    // the NA map's own view of the data (rank order kept): select() works on it like on C itself
    const m = naList.length;
    const NV = { n: m, x: new Float32Array(m), y: new Float32Array(m), z: new Float32Array(m), ci: Int32Array.from(naList) };
    for (let j = 0; j < m; j++) { const i = naList[j]; NV.x[j] = C.nx[i]; NV.y[j] = C.ny[i]; NV.z[j] = C.nz[i]; }
    C.naView = NV;
    return C;
  }

  // ---------- selection: tiers + viewport culling ----------
  // C is the parsed data (World map) or C.naView (NA map): anything with n, x, y, z in rank order.
  // Returns indices into it. Visible if z <= k * frameWidth / 360 (= s * W / 360 with s = CSS px per map unit), inside the
  // view + 5%, or marked (marked cities ignore the tier but still need to be in view). Marked first,
  // then rank order: at most `tierCap` by tier, at most `cap` in all.
  function select(C, vb, s, W, markedIdx, cap, minK, tierCap) {
    cap = cap || CAP;
    tierCap = tierCap == null ? cap : tierCap;
    const thr = W / vb.w < (minK == null ? 1 : minK) - 1e-6 ? -1 : s * W / REF_W;
    const mx = vb.w * 0.05, my = vb.h * 0.05;
    const x0 = vb.x - mx, x1 = vb.x + vb.w + mx, y0 = vb.y - my, y1 = vb.y + vb.h + my;
    const out = [];
    const taken = markedIdx && markedIdx.length ? new Set() : null;
    if (taken) {
      for (const i of markedIdx) {
        if (out.length >= cap) break;
        const x = C.x[i], y = C.y[i];
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        out.push(i); taken.add(i);
      }
    }
    let nt = 0;
    for (let i = 0; i < C.n && out.length < cap && nt < tierCap; i++) {
      if (C.z[i] > thr) continue;
      const x = C.x[i], y = C.y[i];
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (taken && taken.has(i)) continue;
      out.push(i); nt++;
    }
    return out;
  }

  // ---------- nearest-city grid (screen px, relative to the svg's top left) ----------
  function buildGrid(pts, cell) {
    cell = cell || CELL;
    const g = new Map();
    for (let j = 0; j < pts.length; j++) {
      const p = pts[j];
      const key = Math.floor(p.sx / cell) * 65536 + Math.floor(p.sy / cell);
      let b = g.get(key); if (!b) g.set(key, b = []);
      b.push(p);
    }
    return { g, cell };
  }
  function nearest(grid, px, py, maxD) {
    maxD = maxD == null ? HIT_PX : maxD;
    const { g, cell } = grid;
    const cx = Math.floor(px / cell), cy = Math.floor(py / cell);
    const reach = Math.ceil(maxD / cell);
    let best = null, bd = maxD * maxD;
    for (let ix = cx - reach; ix <= cx + reach; ix++) {
      for (let iy = cy - reach; iy <= cy + reach; iy++) {
        const b = g.get(ix * 65536 + iy); if (!b) continue;
        for (const p of b) {
          const dx = p.sx - px, dy = p.sy - py, d = dx * dx + dy * dy;
          if (d <= bd) { bd = d; best = p; }
        }
      }
    }
    return best;
  }

  // ---------- label placement ----------
  // items: [{i, sx, sy, r, len}] in priority order (screen px). Each label sits right of its dot if
  // its box is free of other labels and dots (spatial hash), inside the frame. Returns placed items.
  function placeLabels(items, dots, fontPx, max, frameW, frameH) {
    const HC = 48;
    const hash = new Map();
    const add = (b) => {
      for (let gx = Math.floor(b.x0 / HC); gx <= Math.floor(b.x1 / HC); gx++)
        for (let gy = Math.floor(b.y0 / HC); gy <= Math.floor(b.y1 / HC); gy++) {
          const k = gx * 65536 + gy; let a = hash.get(k); if (!a) hash.set(k, a = []); a.push(b);
        }
    };
    const hits = (b) => {
      for (let gx = Math.floor(b.x0 / HC); gx <= Math.floor(b.x1 / HC); gx++)
        for (let gy = Math.floor(b.y0 / HC); gy <= Math.floor(b.y1 / HC); gy++) {
          const a = hash.get(gx * 65536 + gy); if (!a) continue;
          for (const o of a) if (o.own !== b.own && o.x0 < b.x1 && o.x1 > b.x0 && o.y0 < b.y1 && o.y1 > b.y0) return true;
        }
      return false;
    };
    for (const d of dots) add({ x0: d.sx - d.r - 1, x1: d.sx + d.r + 1, y0: d.sy - d.r - 1, y1: d.sy + d.r + 1, own: d.i });
    const out = [];
    const h = fontPx * 1.25, cw = fontPx * 0.56;
    for (const it of items) {
      if (out.length >= max) break;
      const x0 = it.sx + it.r + 2, w = it.len * cw;
      const b = { x0, x1: x0 + w, y0: it.sy - h / 2, y1: it.sy + h / 2, own: it.i };
      if (b.x0 < 0 || b.y0 < 0 || b.x1 > frameW || b.y1 > frameH) continue;
      if (hits(b)) continue;
      b.own = -1 - it.i;          // a placed label also blocks its own dot's later neighbours
      add(b); out.push(it);
    }
    return out;
  }

  // ---------- search ----------
  // Match class per key: 0 exact, 1 prefix, 2 word prefix, 3 substring. Best over name + aliases;
  // ties by rank (the data is rank-sorted: capitals, then population). Returns [{i, cls, alias}].
  function search(C, q, max) {
    q = norm(q);
    if (!q || !C) return [];
    max = max || SEARCH_MAX;
    const hits = [];
    const wq = ' ' + q;
    for (let i = 0; i < C.n; i++) {
      if (!C.all[i].includes(q)) continue;
      const keys = C.keys[i];
      let cls = 4, ki = 0;
      for (let j = 0; j < keys.length && cls > 0; j++) {
        const k = keys[j];
        const c = k === q ? 0 : k.startsWith(q) ? 1 : k.includes(wq) ? 2 : k.includes(q) ? 3 : 4;
        if (c < cls) { cls = c; ki = j; }
      }
      if (cls < 4) hits.push({ i, cls, alias: ki > 0 ? C.alias[i].find(a => norm(a) === keys[ki]) || null : null });
    }
    hits.sort((a, b) => a.cls - b.cls || a.i - b.i);
    return hits.slice(0, max);
  }
  // Same classes for a plain place name (used to order countries/states before cities on ties).
  function matchClass(key, q) {
    q = norm(q); key = norm(key);
    if (!q) return 4;
    return key === q ? 0 : key.startsWith(q) ? 1 : key.includes(' ' + q) ? 2 : key.includes(q) ? 3 : 4;
  }

  // "Illinois, United States" / "Japan" (admin-1 shown for US/Canada and for names that repeat)
  function whereText(C, i, countryName) {
    const adm = C.adm[i];
    const showAdm = adm && adm !== C.name[i] && (LABELLED_ADMIN.has(C.cc[i]) || C.dupName[i]);
    return (showAdm ? adm + ', ' : '') + (countryName || C.cc[i]);
  }

  // ---------- counters ----------
  // been/want: arrays of city indices. Returns tile numbers.
  function tally(C, been, want) {
    const countries = new Set(), caps = new Set();
    for (const i of been) { countries.add(C.cc[i]); if (C.flags[i] === FLAG_CAPITAL) caps.add(C.cc[i]); }
    return { been: been.length, want: want.length, countries: countries.size, capitals: caps.size };
  }
  // NA map tile: cities on the NA map, and the distinct states/provinces/territories they are in
  function naTally(C, been, want) {
    const regions = new Set();
    let b = 0, w = 0;
    for (const i of been) if (C.na[i]) { b++; regions.add(C.st[i]); }
    for (const i of want) if (C.na[i]) w++;
    return { been: b, want: w, regions: regions.size };
  }
  function capitalTotal(C) {
    const s = new Set();
    for (let i = 0; i < C.n; i++) if (C.flags[i] === FLAG_CAPITAL) s.add(C.cc[i]);
    return s.size;
  }

  // ======================================================================================
  // Page part. Everything below touches the DOM and window.Atlas.
  // ======================================================================================
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAPS = ['world', 'na'];

  function boot(win) {
    const doc = win.document;
    let A = null;                 // window.Atlas
    let C = null;                 // parsed data
    let loadP = null, failed = false;
    let markedIdx = [];           // marked city indices (into C), rank order
    const side = { world: { tile: null, list: null }, na: { tile: null, list: null } };
    let capTotal = 0;
    const stats = { updates: 0, ms: [], labelMs: [], parseMs: 0, buildMs: 0, requests: 0, na: { updates: 0, ms: [], labelMs: [] } };

    // One layer per map: its own node pools, visible set, hit grid and labels.
    // D (set once the data is loaded) is what select() walks: C itself on the World map, C.naView on
    // the NA map. vis holds indices into D; pts/pool/labels carry the city index into C.
    function makeLayer(key) {
      return {
        key, view: null, svg: null, layer: null, labelsG: null, D: null,
        pool: [], textPool: [], vis: [], pts: [],
        curVb: null, curS: 0, frameW: 0, frameH: 0, lastK: 0,
        grid: null, gridDirty: true, labelTimer: 0, marked: [],
        st: key === 'world' ? stats : stats.na,
      };
    }
    const layers = { world: makeLayer('world'), na: makeLayer('na') };
    const ci = (L, j) => (L.D.ci ? L.D.ci[j] : j);
    const mapOfCity = i => (C && C.na[i] ? 'na' : 'world');

    // ---- status helpers (Atlas may report 0/1/2 or 'none'/'been'/'want') ----
    const S_OF = { none: 0, been: 1, want: 2 };
    function status(id) {
      if (!A || typeof A.getStatus !== 'function') return 0;
      const s = A.getStatus(id);
      return typeof s === 'number' ? s : S_OF[s] || 0;
    }
    function setStatus(id, s) { A.setStatus(id, s, { quiet: true }); }
    function cityIds() {
      // every city id the store holds with a status (works before the data is loaded)
      if (A && typeof A.ids === 'function') {
        try { return [].concat(A.ids(1) || [], A.ids(2) || []).filter(id => /^C-/.test(id)); } catch (_) {}
      }
      if (A && A.store && typeof A.store.ids === 'function') return [].concat(A.store.ids(1), A.store.ids(2)).filter(id => /^C-/.test(id));
      return [];
    }
    function refreshMarked() {
      markedIdx = [];
      if (!C) return;
      for (const id of cityIds()) { const i = C.byId.get(id); if (i != null && status(C.id[i]) !== 0) markedIdx.push(i); }
      markedIdx = [...new Set(markedIdx)].sort((a, b) => a - b);
      layers.world.marked = markedIdx;
      layers.na.marked = markedIdx.filter(i => C.na[i]).map(i => C.nli[i]);
    }
    function placeName(id) { const p = A && A.places && A.places.get(id); return p ? p.name : id; }
    const countryName = placeName;

    // ---- loading ----
    function load() {
      if (C) return Promise.resolve(C);
      if (loadP) return loadP;
      for (const k of MAPS) if (layers[k].layer) layers[k].layer.classList.add('loading');
      stats.requests++;
      loadP = win.fetch(URL_DATA).then(r => { if (!r.ok) throw new Error('cities ' + r.status); return r.text(); }).then(txt => {
        const t0 = win.performance.now();
        const d = JSON.parse(txt);
        const t1 = win.performance.now();
        C = parse(d, null);
        stats.parseMs = t1 - t0; stats.buildMs = win.performance.now() - t1;
        layers.world.D = C; layers.na.D = C.naView;
        capTotal = capitalTotal(C);
        failed = false;
        registerPlaces();
        refreshMarked();
        for (const k of MAPS) render(layers[k], true);
        renderSide();
        announce();
        for (const k of MAPS) { const L = layers[k]; if (L.layer) win.requestAnimationFrame(() => L.layer.classList.remove('loading')); }
        return C;
      }).catch(err => {
        failed = true; loadP = null;           // retried on the next zoom / search focus
        for (const k of MAPS) if (layers[k].layer) layers[k].layer.classList.remove('loading');
        throw err;
      });
      return loadP;
    }
    function ensure() { if (!C) load().catch(() => {}); }

    // Cities join the places registry (kind 'city') so core toasts, tooltips, backup checks and the
    // details panel can name them. The core builds its own lists/counters/search index from the
    // registry once at startup, so these entries never show up there twice. U.S./Canadian cities
    // belong to the NA map (map 'na', state = their state/province/territory there).
    function registerPlaces() {
      if (!A || !A.places || typeof A.places.set !== 'function') return;
      for (let i = 0; i < C.n; i++) {
        if (A.places.has(C.id[i])) continue;
        const rec = { id: C.id[i], name: C.name[i], kind: 'city', map: mapOfCity(i), country: C.cc[i], admin1: C.adm[i], capital: C.flags[i] === FLAG_CAPITAL };
        if (C.na[i]) rec.state = C.st[i];
        A.places.set(C.id[i], rec);
      }
      for (const old in C.remap) if (C.byId.has(old) && !A.places.has(old)) A.places.set(old, A.places.get(C.id[C.byId.get(old)]));
      A.citiesLoaded = true;
    }
    function announce() { if (A && typeof A.emit === 'function') A.emit('cities', { loaded: !!C, count: layers.world.vis.length, na: layers.na.vis.length }); }

    // ---- layer ----
    function mountLayer(L, host) {
      const svg = L.svg;
      L.layer = doc.createElementNS(SVG_NS, 'g');
      L.layer.setAttribute('class', 'cities');
      L.layer.setAttribute('aria-hidden', 'true');
      L.labelsG = doc.createElementNS(SVG_NS, 'g');
      L.labelsG.setAttribute('class', 'city-labels');
      L.labelsG.setAttribute('aria-hidden', 'true');
      const dots = svg.querySelector('g.dots');
      if (host && host !== svg) {
        host.appendChild(L.layer); host.appendChild(L.labelsG);
        // NA map: the insets' tray is drawn after the main map, so the layer goes on top of it
        if (L.key === 'na' && host.parentNode === svg) svg.appendChild(host);
      } else if (L.key === 'na') { svg.appendChild(L.layer); svg.appendChild(L.labelsG); }
      else if (dots && dots.parentNode === svg) { svg.insertBefore(L.labelsG, dots.nextSibling); svg.insertBefore(L.layer, dots.nextSibling); }
      else { svg.appendChild(L.layer); svg.appendChild(L.labelsG); }
    }
    function measure(L) {
      const r = L.svg.getBoundingClientRect();
      L.frameW = r.width; L.frameH = r.height;
    }
    function dotPx(i, st) { return C.flags[i] === FLAG_CAPITAL ? R_CAPITAL : st ? R_MARKED : R_PX; }
    function classOf(i, st) {
      let c = 'city';
      if (st === 1) c += ' on'; else if (st === 2) c += ' want';
      if (C.flags[i] === FLAG_CAPITAL) c += ' capital';
      return c;
    }

    // once per frame (the app coalesces apply() to rAF)
    function render(L, force) {
      if (!C || !L.curVb || !L.layer) return;
      const t0 = win.performance.now();
      const view = L.view, vb = L.curVb, D = L.D;
      const kChanged = force || Math.abs(L.lastK - (view.W / vb.w)) > 1e-6;
      if (kChanged || !L.frameW) measure(L);
      L.lastK = view.W / vb.w;
      L.curS = L.frameW / vb.w;
      if (!(L.curS > 0)) return;
      L.vis = select(D, vb, L.curS, view.W, L.marked, CAP, TIER_MIN_K, TIER_CAP);
      const s = L.curS, vis = L.vis, pool = L.pool, pts = L.pts;
      pts.length = vis.length;
      for (let j = 0; j < vis.length; j++) {
        const l = vis[j], i = ci(L, l);
        let n = pool[j];
        if (!n) { n = doc.createElementNS(SVG_NS, 'circle'); pool.push(n); n._i = -1; n._c = ''; n._r = -1; }
        if (!n.parentNode) L.layer.appendChild(n);
        const st = status(C.id[i]);
        if (n._i !== i) {
          n._i = i; n._c = '';                    // drop classes another module added for the old city
          n.setAttribute('cx', D.x[l]); n.setAttribute('cy', D.y[l]);
          n.setAttribute('data-id', C.id[i]);
        }
        const cls = classOf(i, st);
        if (n._c !== cls) { n.setAttribute('class', cls); n._c = cls; }
        const r = dotPx(i, st) / s;
        if (Math.abs(n._r - r) > 1e-4) { n.setAttribute('r', r.toFixed(3)); n._r = r; }
        const p = pts[j] || (pts[j] = { i: 0, mx: 0, my: 0, sx: 0, sy: 0, r: 0 });
        p.i = i; p.mx = D.x[l]; p.my = D.y[l];
        p.sx = (p.mx - vb.x) * s; p.sy = (p.my - vb.y) * s; p.r = dotPx(i, st);
      }
      for (let j = vis.length; j < pool.length; j++) { const n = pool[j]; if (n.parentNode) n.parentNode.removeChild(n); n._i = -1; }
      L.gridDirty = true;
      if (kChanged) {
        L.labelsG.setAttribute('font-size', (LABEL_PX / s).toFixed(3));
        L.labelsG.setAttribute('stroke-width', (3 / s).toFixed(3));
      }
      scheduleLabels(L, kChanged ? 140 : 160);
      L.st.updates++;
      L.st.ms.push(win.performance.now() - t0);
      if (L.st.ms.length > 2000) L.st.ms.splice(0, 1000);
    }

    function scheduleLabels(L, ms) {
      win.clearTimeout(L.labelTimer);
      L.labelTimer = win.setTimeout(() => layoutLabels(L), ms);
    }
    function layoutLabels(L) {
      L.labelTimer = 0;
      if (!C || !L.curVb) return;
      const t0 = win.performance.now();
      let placed = [];
      if (L.lastK >= LABEL_MIN_K - 1e-6) {
        const items = L.pts.slice(0, L.vis.length).map(p => ({ i: p.i, mx: p.mx, my: p.my, sx: p.sx, sy: p.sy, r: p.r, len: C.name[p.i].length }));
        const max = L.frameW < PHONE_W ? LABELS_PHONE : LABELS_DESK;
        placed = placeLabels(items, items, LABEL_PX, max, L.frameW, L.frameH);
      }
      const s = L.curS, textPool = L.textPool;
      for (let j = 0; j < placed.length; j++) {
        const it = placed[j];
        let t = textPool[j];
        if (!t) { t = doc.createElementNS(SVG_NS, 'text'); t.setAttribute('class', 'city-lbl'); textPool.push(t); t._i = -1; t._x = NaN; }
        if (!t.parentNode) L.labelsG.appendChild(t);
        const x = it.mx + (it.r + 2) / s;
        if (t._i !== it.i) { t._i = it.i; t.textContent = C.name[it.i]; t.setAttribute('y', it.my); }
        if (t._x !== x) { t.setAttribute('x', x.toFixed(2)); t._x = x; }
      }
      for (let j = placed.length; j < textPool.length; j++) { const t = textPool[j]; if (t.parentNode) t.parentNode.removeChild(t); t._i = -1; }
      L.st.labelMs.push(win.performance.now() - t0);
      announce();                                // e.g. ratings.js repaints the reassigned dots
      if (L.st.labelMs.length > 500) L.st.labelMs.splice(0, 250);
    }

    // view hook: called by app.js at the end of apply()
    function onView(L, vb, k) {
      L.curVb = { x: vb.x, y: vb.y, w: vb.w, h: vb.h };
      if (!C) { if (k >= 2 - 1e-6) ensure(); return; }
      render(L, false);
    }

    // ---- hit testing ----
    function hitIndex(L, clientX, clientY) {
      if (!C || !L.vis.length) return -1;
      if (L.gridDirty) { L.grid = buildGrid(L.pts.slice(0, L.vis.length), CELL); L.gridDirty = false; }
      const r = L.svg.getBoundingClientRect();
      const p = nearest(L.grid, clientX - r.left, clientY - r.top, HIT_PX);
      return p ? p.i : -1;
    }

    // ---- marking ----
    // the core adds a Details button for a place id when the panel is listening
    function toast(map, msg, id) { if (A && typeof A.toast === 'function') A.toast(map || 'world', msg, id || null); }
    function openDetails(id, from) {
      if (!A) return;
      if (typeof A.openDetails === 'function') A.openDetails(id, from);
      else if (typeof A.emit === 'function') A.emit('details', id);
      else if (win.AtlasPanel && typeof win.AtlasPanel.open === 'function') win.AtlasPanel.open(id, from);
    }
    // Marking-switch rules (plan-ux §2.1) through the core's tap(), plus decision 12: a city marked
    // Been there also marks its country if that is not marked yet, and (phase 2) a U.S./Canadian city
    // also marks its state/province/territory on the NA map. Clearing never touches either.
    function tapCity(i, map) {
      const id = C.id[i], name = C.name[i];
      map = map || 'world';
      const vm = A.viewMode || 'own';
      if (vm !== 'own') {
        if (typeof A.tap === 'function') A.tap(id, { quiet: true });          // notes view: opens details
        else if (vm === 'notes' && status(id)) openDetails(id);
        if (vm === 'plain' || !status(id)) toast(map, 'View only');
        return;
      }
      let from, to;
      if (typeof A.tap === 'function') {
        const r = A.tap(id, { quiet: true });
        if (!r) return;
        if (r.blocked) { toast(map, `Already been to ${name}`, id); return; }
        if (!r.changed) return;
        from = r.from; to = r.to;
      } else {
        const mode = A.mode === 'want' ? 'want' : 'been';
        from = status(id);
        if (mode === 'want') {
          if (from === 1) { toast(map, `Already been to ${name}`, id); return; }
          to = from === 0 ? 2 : 0;
        } else to = from === 1 ? 0 : 1;
        setStatus(id, to);
      }
      let msg;
      if (to === 1) {
        const also = [];
        for (const pid of [C.na[i] ? C.st[i] : '', C.cc[i]]) {
          if (!pid || !A.places || !A.places.has(pid) || status(pid) !== 0) continue;
          setStatus(pid, 1);
          const pn = placeName(pid);
          if (!also.includes(pn)) also.push(pn);       // "San Juan and Puerto Rico" (NA and World place)
        }
        if (also.length === 1) msg = `${name} and ${also[0]}: been there`;
        else if (also.length > 1) msg = `${name}, ${also.slice(0, -1).join(', ')} and ${also[also.length - 1]}: been there`;
        else msg = from === 2 ? `${name}: been there (was on Want to go)` : `${name}: been there`;
      } else msg = to === 2 ? `${name}: want to go` : `${name}: cleared`;
      toast(map, msg, id);
      afterChange();
    }
    function afterChange() { refreshMarked(); for (const k of MAPS) render(layers[k], false); renderSide(); }

    function onTap(L, e) {
      const i = hitIndex(L, e.clientX, e.clientY);
      if (i < 0) return false;
      tapCity(i, L.key);
      if (e.pointerType === 'mouse') showTip(i, e.clientX, e.clientY);
      return true;
    }

    // ---- tooltip (same #tip element and look as places) ----
    function showTip(i, x, y) {
      const tip = doc.getElementById('tip'); if (!tip) return;
      const st = status(C.id[i]);
      const info = A && typeof A.getInfo === 'function' ? A.getInfo(C.id[i]) : null;
      if ((st || info) && typeof A.tip === 'function' && A.places && A.places.has(C.id[i])) { A.tip(C.id[i], x, y); return; }
      tip.textContent = '';
      tip.append(doc.createTextNode(C.name[i]));
      const k = doc.createElement('span'); k.className = 'k';
      k.textContent = st === 1 ? 'been there' : st === 2 ? 'want to go' : 'City · ' + whereText(C, i, countryName(C.cc[i]));
      tip.appendChild(k);
      const w = tip.offsetWidth, h = tip.offsetHeight;
      let left = x, top = y;
      if (x + 12 + w > win.innerWidth - 8) left = x - w - 24;
      if (y + 14 + h > win.innerHeight - 8) top = y - h - 28;
      tip.style.left = left + 'px'; tip.style.top = top + 'px';
      tip.classList.add('show');
    }
    // views[map].onHover: a city within 12 px wins over the place under the pointer
    function onHover(L, e) {
      if (e.pointerType && e.pointerType !== 'mouse') return false;
      const i = hitIndex(L, e.clientX, e.clientY);
      if (i < 0) return false;
      showTip(i, e.clientX, e.clientY);
      return true;
    }

    // ---- flash (search pick): center at k >= 4 on the city's own map ----
    function flashCity(i, map) {
      map = map === 'na' && C.na[i] ? 'na' : 'world';
      const L = layers[map], v = L.view;
      if (!v) return;
      const x = map === 'na' ? C.nx[i] : C.x[i], y = map === 'na' ? C.ny[i] : C.y[i];
      const frame = v.svg.parentElement;
      if (frame && frame.scrollIntoView) frame.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const w = Math.min(L.curVb ? L.curVb.w : v.W, v.W / FLASH_K);
      const h = w * v.H / v.W;
      v.set(x - w / 2, y - h / 2, w);
      if (!L.curVb || Math.abs(L.curVb.w - w) > 1e-6) onView(L, { x: x - w / 2, y: y - h / 2, w, h }, v.W / w);
      const n = L.pool.find(c => c._i === i && c.parentNode);
      if (n) { n.classList.remove('flash'); void n.getBBox(); n.classList.add('flash'); win.setTimeout(() => n.classList.remove('flash'), 1000); n._c = ''; }
    }

    // ---- counters tiles + lists ----
    // World: tile counts every city ("Cities: N · in M countries", capitals line); its list shows the
    // cities that are not on the NA map (plan-ux §2.5: no duplicates). NA: tile "Cities: N · in M
    // states and provinces" and a list of its cities grouped by state/province/territory.
    function renderSide() {
      renderTile();
      renderNaTile();
      renderList('world');
      renderList('na');
    }
    function cityStatusLists() {
      const been = [], want = [];
      if (C) for (const id of cityIds()) { const i = C.byId.get(id); if (i == null) continue; const s = status(id); if (s === 1) been.push(i); else if (s === 2) want.push(i); }
      return { been: [...new Set(been)], want: [...new Set(want)] };
    }
    function makeTile(map) {
      const host = doc.getElementById('stats-' + map);
      if (!host) return null;
      if (!side[map].tile) {
        const tile = doc.createElement('div');
        tile.className = 'stat city-stat';
        tile.dataset.map = map;
        tile.innerHTML = '<div class="num"><span class="n">0</span></div><div class="label">Cities<span class="cc"></span></div><div class="want-line" hidden></div><div class="want-line cap-line"></div><div class="bar"><i></i></div>';
        host.appendChild(tile);
        side[map].tile = tile;
      }
      return side[map].tile;
    }
    function renderTile() {
      const tile = makeTile('world');
      if (!tile) return;
      const ids = cityIds();
      let t;
      if (C) { const l = cityStatusLists(); t = tally(C, l.been, l.want); }
      else {                                       // before the data: counts from the store alone
        let b = 0, w = 0; for (const id of ids) { const s = status(id); if (s === 1) b++; else if (s === 2) w++; }
        t = { been: b, want: w, countries: 0, capitals: 0 };
      }
      tile.querySelector('.n').textContent = String(t.been);
      tile.querySelector('.cc').textContent = C || !t.been ? ` · in ${t.countries} ${t.countries === 1 ? 'country' : 'countries'}` : '';
      const wl = tile.querySelector('.want-line:not(.cap-line)');
      wl.hidden = !t.want; wl.textContent = `+${t.want} want to go`;
      const cl = tile.querySelector('.cap-line');
      cl.textContent = C ? `Capitals ${t.capitals} / ${capTotal}` : '';
      cl.hidden = !C;
    }
    function renderNaTile() {
      const tile = makeTile('na');
      if (!tile) return;
      const anyMarks = cityIds().length > 0;
      tile.hidden = !C && anyMarks;                // which marks are U.S./Canadian is known once loaded
      let t = { been: 0, want: 0, regions: 0 };
      if (C) { const l = cityStatusLists(); t = naTally(C, l.been, l.want); }
      tile.querySelector('.n').textContent = String(t.been);
      tile.querySelector('.cc').textContent = ` · in ${t.regions} ${t.regions === 1 ? 'state or province' : 'states and provinces'}`;
      const wl = tile.querySelector('.want-line:not(.cap-line)');
      wl.hidden = !t.want; wl.textContent = `+${t.want} want to go`;
      const cl = tile.querySelector('.cap-line');
      cl.textContent = ''; cl.hidden = true;
    }
    function renderList(map) {
      const anchor = doc.getElementById('list-' + map);
      if (!anchor) return;
      let host = side[map].list;
      if (!host) {
        host = doc.createElement('div');
        host.className = 'visited-list city-list';
        host.id = map === 'world' ? 'list-cities' : 'list-cities-na';
        host.dataset.map = map;
        anchor.parentNode.insertBefore(host, anchor.nextSibling);
        side[map].list = host;
      }
      host.textContent = '';
      if (!C) { host.hidden = true; return; }
      const l = cityStatusLists();
      const onNa = map === 'na';
      const keep = i => (C.na[i] ? 1 : 0) === (onNa ? 1 : 0);
      const been = l.been.filter(keep), want = l.want.filter(keep);
      const total = been.length + want.length;
      if (!total) { host.hidden = true; return; }
      host.hidden = false;
      const grp = doc.createElement('div'); grp.className = 'list-group';
      const lead = doc.createElement('span'); lead.className = 'lead'; lead.textContent = `Cities (${total}):`;
      const chips = doc.createElement('span'); chips.className = 'chips';
      grp.append(lead, chips);
      const groupOf = i => (onNa ? C.st[i] : C.cc[i]);
      const byGroup = new Map();
      for (const [list, st] of [[been, 1], [want, 2]]) {
        for (const i of list) { const g = groupOf(i); if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push([i, st]); }
      }
      const groups = [...byGroup.keys()].map(g => [g, placeName(g)]).sort((a, b) => a[1].localeCompare(b[1]));
      const vm = A.viewMode || 'own';
      for (const [gid, gname] of groups) {
        const g = doc.createElement('span'); g.className = 'city-group'; g.dataset.group = gid;
        const lab = doc.createElement('span'); lab.className = 'grp'; lab.textContent = gname + ':';
        g.appendChild(lab);
        const list = byGroup.get(gid).sort((a, b) => a[1] - b[1] || C.name[a[0]].localeCompare(C.name[b[0]]));
        for (const [i, st] of list) {
          const id = C.id[i];
          const plain = vm === 'plain';
          const chip = doc.createElement(plain ? 'span' : 'button');
          chip.className = 'chip' + (st === 2 ? ' want' : '');
          const nm = doc.createElement('span'); nm.textContent = C.name[i];
          chip.appendChild(nm);
          const info = A && typeof A.getInfo === 'function' ? A.getInfo(id) : null;
          if (info && info.rating) { const r = doc.createElement('span'); r.className = 'ci-rate'; r.textContent = '★' + info.rating; chip.appendChild(r); }
          if (info && info.note) { const nn = doc.createElement('span'); nn.className = 'ci-note'; nn.setAttribute('aria-hidden', 'true'); nn.textContent = '✎'; chip.appendChild(nn); }
          chip.dataset.id = id;
          if (!plain) {
            chip.type = 'button';
            const bits = [C.name[i] + ', ' + gname, st === 1 ? 'been there' : 'want to go'];
            if (info && info.rating) bits.push('rated ' + info.rating);
            if (info && info.note) bits.push('has a note');
            chip.setAttribute('aria-label', bits.join(', ') + '. Open details.');
            chip.addEventListener('click', () => openDetails(id, chip));
          }
          g.appendChild(chip);
        }
        chips.appendChild(g);
      }
      host.appendChild(grp);
    }

    // ---- search source ----
    // Called by app.js with the raw query. Returns rows the core merges with place results.
    // U.S./Canadian cities fly to the NA map; the rest to the World map.
    function searchSource(query) {
      const raw = typeof query === 'string' ? query : query && (query.raw || query.q || query.query) || '';
      if (!norm(raw)) return [];
      if (!C) {
        ensure();
        return failed ? [{ note: OFFLINE_NOTE, empty: true }] : [];
      }
      return search(C, raw, SEARCH_MAX).map(h => {
        const i = h.i, id = C.id[i];
        const cname = countryName(C.cc[i]);
        const where = 'City · ' + whereText(C, i, cname);
        return {
          id, kind: 'city', map: mapOfCity(i),
          name: h.alias && h.cls < 4 && !C.keys[i][0].includes(norm(raw)) ? `${C.name[i]} (${h.alias})` : C.name[i],
          where, cls: h.cls, rank: i, score: h.cls + 0.5,
          label: `${C.name[i]}, city in ${whereText(C, i, cname)}`,
          pick: () => pickCity(i),
        };
      });
    }
    function pickCity(i) {
      const map = mapOfCity(i);
      tapCity(i, map);
      flashCity(i, map);
      return status(C.id[i]);
    }

    // ---- wiring ----
    function wireMap(L) {
      const view = A.views && A.views[L.key];
      if (!view) return false;
      L.view = view;
      L.svg = view.svg || doc.querySelector(`svg.map[data-map="${L.key}"]`);
      // layer: through addLayer when the core offers it, else after .dots ourselves
      let host = null;
      if (typeof A.addLayer === 'function') {
        try { host = A.addLayer(L.key, (vb, k) => onView(L, vb, k)) || null; } catch (_) { host = null; }
      }
      if (host && host.nodeType !== 1) host = null;
      mountLayer(L, host);
      if (!(typeof A.addLayer === 'function')) {
        const fn = (vb, k) => onView(L, vb, k);
        if (Array.isArray(view.onView)) view.onView.push(fn); else view.onView = fn;
      }
      const tapFn = e => onTap(L, e), hoverFn = e => onHover(L, e);
      if (typeof A.onTap === 'function') A.onTap(L.key, tapFn); else if (Array.isArray(view.onTap)) view.onTap.push(tapFn); else view.onTap = tapFn;
      if (Array.isArray(view.onHover)) view.onHover.push(hoverFn); else L.svg.addEventListener('pointermove', e => { if (!e.buttons && !L.svg.classList.contains('dragging')) hoverFn(e); });
      L.svg.addEventListener('pointerup', () => { if (L.labelTimer) { win.clearTimeout(L.labelTimer); win.setTimeout(() => layoutLabels(L), 0); } });
      // initial view (the core may have applied before we hooked in)
      const b = L.svg.viewBox && L.svg.viewBox.baseVal;
      const vb0 = view.vb || (b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null);
      if (vb0) L.curVb = { x: vb0.x, y: vb0.y, w: vb0.w || vb0.width, h: vb0.h || vb0.height };
      return true;
    }
    function wire() {
      A = win.Atlas;
      if (!wireMap(layers.world)) return;
      wireMap(layers.na);
      if (typeof A.addSearchSource === 'function') A.addSearchSource(searchSource);
      if (typeof A.on === 'function') {
        A.on('change', () => { if (C) afterChange(); else { renderTile(); renderNaTile(); if (cityIds().length) ensure(); } });
        A.on('zoom', (m, k) => { if ((MAPS.includes(m) || (m && MAPS.includes(m.map))) && !C && (+k || (m && m.k) || 0) >= 2) ensure(); });
        A.on('style', () => { if (C) for (const key of MAPS) layoutLabels(layers[key]); });
      }
      win.addEventListener('resize', () => { for (const key of MAPS) { const L = layers[key]; L.frameW = 0; if (C && L.curVb) render(L, true); } });
      const q = doc.getElementById('q');
      if (q) q.addEventListener('focus', ensure);
      renderTile();
      renderNaTile();
      if (cityIds().length || MAPS.some(key => { const L = layers[key]; return L.view && L.curVb && L.view.W / L.curVb.w >= 2; })) ensure();
      win.AtlasCities.ready = true;
      try { win.dispatchEvent(new win.CustomEvent('atlas-cities-ready')); } catch (_) {}
    }

    // public, for tests and other modules. `map` defaults to 'world'.
    const L_ = map => layers[map === 'na' ? 'na' : 'world'];
    Object.assign(win.AtlasCities, {
      load, stats,
      count: (map) => L_(map).pool.reduce((a, n) => a + (n.parentNode ? 1 : 0), 0),
      labels: (map) => L_(map).textPool.reduce((a, t) => a + (t.parentNode ? 1 : 0), 0),
      hit: (x, y, map) => { const i = hitIndex(L_(map), x, y); return i < 0 ? null : C.id[i]; },
      screenOf: (id, map) => {     // client px of a city on a map (for tests); null if not loaded / not on it
        const L = L_(map);
        if (!C || !L.curVb) return null;
        const i = C.byId.get(id); if (i == null) return null;
        if (L.key === 'na' && !C.na[i]) return null;
        const mx = L.key === 'na' ? C.nx[i] : C.x[i], my = L.key === 'na' ? C.ny[i] : C.y[i];
        const r = L.svg.getBoundingClientRect(), s = r.width / L.curVb.w;
        return { x: r.left + (mx - L.curVb.x) * s, y: r.top + (my - L.curVb.y) * s };
      },
      mapPos: (id, map) => {       // map units, e.g. {x, y, inset, state} on 'na'
        const i = C && C.byId.get(id); if (i == null) return null;
        if (map === 'na') return C.na[i] ? { x: C.nx[i], y: C.ny[i], inset: C.ins[i], state: C.st[i], z: C.nz[i] } : null;
        return { x: C.x[i], y: C.y[i], z: C.z[i] };
      },
      get: (id) => {               // place-like record for the panel / other modules
        const i = C && C.byId.get(id); if (i == null) return null;
        const rec = { id: C.id[i], name: C.name[i], kind: 'city', map: mapOfCity(i), country: C.cc[i], countryName: countryName(C.cc[i]), admin1: C.adm[i], capital: C.flags[i] === FLAG_CAPITAL };
        if (C.na[i]) { rec.state = C.st[i]; rec.stateName = placeName(C.st[i]); rec.inset = C.ins[i]; }
        return rec;
      },
      find: (name) => { if (!C) return null; for (let i = 0; i < C.n; i++) if (C.name[i] === name) return C.id[i]; return null; },
      flash: (id, map) => { const i = C && C.byId.get(id); if (i != null) flashCity(i, map || mapOfCity(i)); },
      refresh: () => { if (C) afterChange(); else { renderTile(); renderNaTile(); } },
      search: (q) => searchSource(q),
      OFFLINE_NOTE,
    });

    Object.defineProperties(win.AtlasCities, {
      loaded: { get: () => !!C, configurable: true },
      failed: { get: () => failed, configurable: true },
    });

    // wait for app.js (its maps load asynchronously) to publish window.Atlas
    let tries = 0;
    (function waitAtlas() {
      if (win.Atlas && win.Atlas.views && win.Atlas.views.world) { wire(); return; }
      if (++tries > 1200) return;              // ~60 s
      win.setTimeout(waitAtlas, 50);
    })();
  }

  return {
    norm, parse, select, buildGrid, nearest, placeLabels, search, matchClass, whereText, tally, naTally, capitalTotal, boot,
    CAP, TIER_CAP, REF_W, HIT_PX, CELL, TIER_MIN_K, LABELS_PHONE, LABELS_DESK, OFFLINE_NOTE,
  };
});
