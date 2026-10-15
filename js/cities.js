// Travel Atlas: cities layer on the World map (docs/plan-cities.md §6-§8, docs/plan-ux.md §2.5).
// Classic script, loaded with <script defer> after app.js. Talks to app.js only through window.Atlas.
// The pure parts (parse, tier selection + culling, the nearest-city grid, label placement, search)
// are exported for Node tests via module.exports; in the page they hang off window.AtlasCities.
// Nothing is fetched until the world map is zoomed to k >= 2, the search box is focused, or the
// store already holds a city mark (the counters and lists need the names).
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
  function parse(d, remap) {
    if (!d || !Array.isArray(d.c) || !Array.isArray(d.r)) throw new Error('Bad cities data');
    const rows = d.c, n = rows.length;
    const C = {
      n, id: new Array(n), name: new Array(n), alias: new Array(n), cc: new Array(n), adm: new Array(n),
      flags: new Uint8Array(n), z: new Float32Array(n), x: new Float32Array(n), y: new Float32Array(n),
      keys: new Array(n), all: new Array(n), dupName: new Uint8Array(n), byId: new Map(), remap: remap || {},
    };
    const seen = new Map();
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const id = 'C-' + r[0];
      C.id[i] = id; C.name[i] = r[1]; C.alias[i] = Array.isArray(r[2]) ? r[2] : [];
      C.cc[i] = r[3]; C.adm[i] = r[4] >= 0 && r[4] < d.r.length ? d.r[r[4]] : '';
      C.flags[i] = r[5]; C.z[i] = r[6]; C.x[i] = r[7]; C.y[i] = r[8];
      const keys = [norm(r[1])];
      for (const a of C.alias[i]) { const k = norm(a); if (k && !keys.includes(k)) keys.push(k); }
      C.keys[i] = keys; C.all[i] = keys.join('|');
      C.byId.set(id, i);
      const nk = keys[0];
      if (seen.has(nk)) { C.dupName[i] = 1; C.dupName[seen.get(nk)] = 1; } else seen.set(nk, i);
    }
    // old ids from tools/cities-remap.json ("C-old": "C-new" | "retired") resolve to their replacement
    for (const old in C.remap) { const nu = C.remap[old]; if (C.byId.has(nu) && !C.byId.has(old)) C.byId.set(old, C.byId.get(nu)); }
    return C;
  }

  // ---------- selection: tiers + viewport culling ----------
  // Visible if z <= k * frameWidth / 360 (= s * W / 360 with s = CSS px per map unit), inside the
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
  function capitalTotal(C) {
    const s = new Set();
    for (let i = 0; i < C.n; i++) if (C.flags[i] === FLAG_CAPITAL) s.add(C.cc[i]);
    return s.size;
  }

  // ======================================================================================
  // Page part. Everything below touches the DOM and window.Atlas.
  // ======================================================================================
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function boot(win) {
    const doc = win.document;
    let A = null;                 // window.Atlas
    let C = null;                 // parsed data
    let loadP = null, failed = false;
    let view = null, svg = null, layer = null, labelsG = null;
    const pool = [], textPool = [];
    let vis = [];                 // visible city indices (marked first, then rank)
    let curVb = null, curS = 0, frameW = 0, frameH = 0, lastK = 0;
    let grid = null, gridDirty = true, pts = [];
    let labelTimer = 0;
    let markedIdx = [];
    let tile = null, listHost = null;
    let capTotal = 0;
    const stats = { updates: 0, ms: [], labelMs: [], parseMs: 0, buildMs: 0, requests: 0 };

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
      markedIdx.sort((a, b) => a - b);
    }
    function countryName(cc) { const p = A && A.places && A.places.get(cc); return p ? p.name : cc; }

    // ---- loading ----
    function load() {
      if (C) return Promise.resolve(C);
      if (loadP) return loadP;
      if (layer) layer.classList.add('loading');
      stats.requests++;
      loadP = win.fetch(URL_DATA).then(r => { if (!r.ok) throw new Error('cities ' + r.status); return r.text(); }).then(txt => {
        const t0 = win.performance.now();
        const d = JSON.parse(txt);
        const t1 = win.performance.now();
        C = parse(d, null);
        stats.parseMs = t1 - t0; stats.buildMs = win.performance.now() - t1;
        capTotal = capitalTotal(C);
        failed = false;
        registerPlaces();
        refreshMarked();
        render(true);
        renderSide();
        announce();
        if (layer) win.requestAnimationFrame(() => layer.classList.remove('loading'));
        return C;
      }).catch(err => {
        failed = true; loadP = null;           // retried on the next zoom / search focus
        if (layer) layer.classList.remove('loading');
        throw err;
      });
      return loadP;
    }
    function ensure() { if (!C) load().catch(() => {}); }

    // Cities join the places registry (kind 'city') so core toasts, tooltips, backup checks and the
    // details panel can name them. The core builds its own lists/counters/search index from the
    // registry once at startup, so these entries never show up there twice.
    function registerPlaces() {
      if (!A || !A.places || typeof A.places.set !== 'function') return;
      for (let i = 0; i < C.n; i++) {
        if (A.places.has(C.id[i])) continue;
        A.places.set(C.id[i], { id: C.id[i], name: C.name[i], kind: 'city', map: 'world', country: C.cc[i], admin1: C.adm[i], capital: C.flags[i] === FLAG_CAPITAL });
      }
      for (const old in C.remap) if (C.byId.has(old) && !A.places.has(old)) A.places.set(old, A.places.get(C.id[C.byId.get(old)]));
      A.citiesLoaded = true;
    }
    function announce() { if (A && typeof A.emit === 'function') A.emit('cities', { loaded: !!C, count: vis.length }); }

    // ---- layer ----
    function mountLayer(host) {
      layer = doc.createElementNS(SVG_NS, 'g');
      layer.setAttribute('class', 'cities');
      layer.setAttribute('aria-hidden', 'true');
      labelsG = doc.createElementNS(SVG_NS, 'g');
      labelsG.setAttribute('class', 'city-labels');
      labelsG.setAttribute('aria-hidden', 'true');
      const dots = svg.querySelector('g.dots');
      if (host && host !== svg) { host.appendChild(layer); host.appendChild(labelsG); }
      else if (dots && dots.parentNode === svg) { svg.insertBefore(labelsG, dots.nextSibling); svg.insertBefore(layer, dots.nextSibling); }
      else { svg.appendChild(layer); svg.appendChild(labelsG); }
    }
    function measure() {
      const r = svg.getBoundingClientRect();
      frameW = r.width; frameH = r.height;
    }
    function dotPx(i, st) { return C.flags[i] === FLAG_CAPITAL ? R_CAPITAL : st ? R_MARKED : R_PX; }
    function classOf(i, st) {
      let c = 'city';
      if (st === 1) c += ' on'; else if (st === 2) c += ' want';
      if (C.flags[i] === FLAG_CAPITAL) c += ' capital';
      return c;
    }

    // once per frame (the app coalesces apply() to rAF)
    function render(force) {
      if (!C || !curVb || !layer) return;
      const t0 = win.performance.now();
      const kChanged = force || Math.abs(lastK - (view.W / curVb.w)) > 1e-6;
      if (kChanged || !frameW) measure();
      lastK = view.W / curVb.w;
      curS = frameW / curVb.w;
      if (!(curS > 0)) return;
      vis = select(C, curVb, curS, view.W, markedIdx, CAP, TIER_MIN_K, TIER_CAP);
      const s = curS;
      pts.length = vis.length;
      for (let j = 0; j < vis.length; j++) {
        const i = vis[j];
        let n = pool[j];
        if (!n) { n = doc.createElementNS(SVG_NS, 'circle'); pool.push(n); n._i = -1; n._c = ''; n._r = -1; }
        if (!n.parentNode) layer.appendChild(n);
        const st = status(C.id[i]);
        if (n._i !== i) {
          n._i = i; n._c = '';                    // drop classes another module added for the old city
          n.setAttribute('cx', C.x[i]); n.setAttribute('cy', C.y[i]);
          n.setAttribute('data-id', C.id[i]);
        }
        const cls = classOf(i, st);
        if (n._c !== cls) { n.setAttribute('class', cls); n._c = cls; }
        const r = dotPx(i, st) / s;
        if (Math.abs(n._r - r) > 1e-4) { n.setAttribute('r', r.toFixed(3)); n._r = r; }
        const p = pts[j] || (pts[j] = { i: 0, sx: 0, sy: 0, r: 0 });
        p.i = i; p.sx = (C.x[i] - curVb.x) * s; p.sy = (C.y[i] - curVb.y) * s; p.r = dotPx(i, st);
      }
      for (let j = vis.length; j < pool.length; j++) { const n = pool[j]; if (n.parentNode) n.parentNode.removeChild(n); n._i = -1; }
      gridDirty = true;
      if (kChanged) {
        labelsG.setAttribute('font-size', (LABEL_PX / s).toFixed(3));
        labelsG.setAttribute('stroke-width', (3 / s).toFixed(3));
      }
      scheduleLabels(kChanged ? 140 : 160);
      stats.updates++;
      stats.ms.push(win.performance.now() - t0);
      if (stats.ms.length > 2000) stats.ms.splice(0, 1000);
    }

    function scheduleLabels(ms) {
      win.clearTimeout(labelTimer);
      labelTimer = win.setTimeout(layoutLabels, ms);
    }
    function layoutLabels() {
      labelTimer = 0;
      if (!C || !curVb) return;
      const t0 = win.performance.now();
      let placed = [];
      if (lastK >= LABEL_MIN_K - 1e-6) {
        const items = pts.slice(0, vis.length).map(p => ({ i: p.i, sx: p.sx, sy: p.sy, r: p.r, len: C.name[p.i].length }));
        const max = frameW < PHONE_W ? LABELS_PHONE : LABELS_DESK;
        placed = placeLabels(items, items, LABEL_PX, max, frameW, frameH);
      }
      const s = curS;
      for (let j = 0; j < placed.length; j++) {
        const it = placed[j];
        let t = textPool[j];
        if (!t) { t = doc.createElementNS(SVG_NS, 'text'); t.setAttribute('class', 'city-lbl'); textPool.push(t); t._i = -1; t._x = NaN; }
        if (!t.parentNode) labelsG.appendChild(t);
        const x = C.x[it.i] + (it.r + 2) / s;
        if (t._i !== it.i) { t._i = it.i; t.textContent = C.name[it.i]; t.setAttribute('y', C.y[it.i]); }
        if (t._x !== x) { t.setAttribute('x', x.toFixed(2)); t._x = x; }
      }
      for (let j = placed.length; j < textPool.length; j++) { const t = textPool[j]; if (t.parentNode) t.parentNode.removeChild(t); t._i = -1; }
      stats.labelMs.push(win.performance.now() - t0);
      announce();                                // e.g. ratings.js repaints the reassigned dots
      if (stats.labelMs.length > 500) stats.labelMs.splice(0, 250);
    }

    // view hook: called by app.js at the end of apply()
    function onView(vb, k) {
      curVb = { x: vb.x, y: vb.y, w: vb.w, h: vb.h };
      if (!C) { if (k >= 2 - 1e-6) ensure(); return; }
      render(false);
    }

    // ---- hit testing ----
    function hitIndex(clientX, clientY) {
      if (!C || !vis.length) return -1;
      if (gridDirty) { grid = buildGrid(pts.slice(0, vis.length), CELL); gridDirty = false; }
      const r = svg.getBoundingClientRect();
      const p = nearest(grid, clientX - r.left, clientY - r.top, HIT_PX);
      return p ? p.i : -1;
    }

    // ---- marking ----
    // the core adds a Details button for a place id when the panel is listening
    function toast(msg, id) { if (A && typeof A.toast === 'function') A.toast('world', msg, id || null); }
    function openDetails(id, from) {
      if (!A) return;
      if (typeof A.openDetails === 'function') A.openDetails(id, from);
      else if (typeof A.emit === 'function') A.emit('details', id);
      else if (win.AtlasPanel && typeof win.AtlasPanel.open === 'function') win.AtlasPanel.open(id, from);
    }
    // Marking-switch rules (plan-ux §2.1) through the core's tap(), plus decision 12: a city marked
    // Been there also marks its country if that is not marked yet. Clearing never touches the country.
    function tapCity(i) {
      const id = C.id[i], name = C.name[i];
      const vm = A.viewMode || 'own';
      if (vm !== 'own') {
        if (typeof A.tap === 'function') A.tap(id, { quiet: true });          // notes view: opens details
        else if (vm === 'notes' && status(id)) openDetails(id);
        if (vm === 'plain' || !status(id)) toast('View only');
        return;
      }
      let from, to;
      if (typeof A.tap === 'function') {
        const r = A.tap(id, { quiet: true });
        if (!r) return;
        if (r.blocked) { toast(`Already been to ${name}`, id); return; }
        if (!r.changed) return;
        from = r.from; to = r.to;
      } else {
        const mode = A.mode === 'want' ? 'want' : 'been';
        from = status(id);
        if (mode === 'want') {
          if (from === 1) { toast(`Already been to ${name}`, id); return; }
          to = from === 0 ? 2 : 0;
        } else to = from === 1 ? 0 : 1;
        setStatus(id, to);
      }
      let msg;
      if (to === 1) {
        const cc = C.cc[i];
        if (A.places && A.places.has(cc) && status(cc) === 0) {
          setStatus(cc, 1);
          msg = `${name} and ${countryName(cc)}: been there`;
        } else msg = from === 2 ? `${name}: been there (was on Want to go)` : `${name}: been there`;
      } else msg = to === 2 ? `${name}: want to go` : `${name}: cleared`;
      toast(msg, id);
      afterChange();
    }
    function afterChange() { refreshMarked(); render(false); renderSide(); }

    function onTap(e) {
      const i = hitIndex(e.clientX, e.clientY);
      if (i < 0) return false;
      tapCity(i);
      if (e.pointerType === 'mouse') showTip(i, e.clientX, e.clientY);
      return true;
    }

    // ---- tooltip (same #tip element and look as places) ----
    let tipShown = false;
    function showTip(i, x, y) {
      const tip = doc.getElementById('tip'); if (!tip) return;
      const st = status(C.id[i]);
      const info = A && typeof A.getInfo === 'function' ? A.getInfo(C.id[i]) : null;
      if ((st || info) && typeof A.tip === 'function' && A.places && A.places.has(C.id[i])) { A.tip(C.id[i], x, y); tipShown = true; return; }
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
      tipShown = true;
    }
    // views.world.onHover: a city within 12 px wins over the place under the pointer
    function onHover(e) {
      if (e.pointerType && e.pointerType !== 'mouse') return false;
      const i = hitIndex(e.clientX, e.clientY);
      if (i < 0) { tipShown = false; return false; }
      showTip(i, e.clientX, e.clientY);
      return true;
    }

    // ---- flash (search pick): center at k >= 4 ----
    function flashCity(i) {
      const v = view;
      const frame = v.svg.parentElement;
      if (frame && frame.scrollIntoView) frame.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const w = Math.min(curVb ? curVb.w : v.W, v.W / FLASH_K);
      const h = w * v.H / v.W;
      v.set(C.x[i] - w / 2, C.y[i] - h / 2, w);
      if (!curVb || Math.abs(curVb.w - w) > 1e-6) onView({ x: C.x[i] - w / 2, y: C.y[i] - h / 2, w, h }, v.W / w);
      const n = pool.find(c => c._i === i && c.parentNode);
      if (n) { n.classList.remove('flash'); void n.getBBox(); n.classList.add('flash'); win.setTimeout(() => n.classList.remove('flash'), 1000); n._c = ''; }
    }

    // ---- counters tile + list ----
    function renderSide() {
      renderTile();
      renderList();
    }
    function cityStatusLists() {
      const been = [], want = [];
      if (C) for (const id of cityIds()) { const i = C.byId.get(id); if (i == null) continue; const s = status(id); if (s === 1) been.push(i); else if (s === 2) want.push(i); }
      return { been: [...new Set(been)], want: [...new Set(want)] };
    }
    function renderTile() {
      const host = doc.getElementById('stats-world');
      if (!host) return;
      if (!tile) {
        tile = doc.createElement('div');
        tile.className = 'stat city-stat';
        tile.innerHTML = '<div class="num"><span class="n">0</span></div><div class="label">Cities<span class="cc"></span></div><div class="want-line" hidden></div><div class="want-line cap-line"></div><div class="bar"><i></i></div>';
        host.appendChild(tile);
      }
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
    function renderList() {
      const anchor = doc.getElementById('list-world');
      if (!anchor) return;
      if (!listHost) {
        listHost = doc.createElement('div');
        listHost.className = 'visited-list city-list';
        listHost.id = 'list-cities';
        anchor.parentNode.insertBefore(listHost, anchor.nextSibling);
      }
      listHost.textContent = '';
      if (!C) { listHost.hidden = true; return; }
      const { been, want } = cityStatusLists();
      const total = been.length + want.length;
      if (!total) { listHost.hidden = true; return; }
      listHost.hidden = false;
      const grp = doc.createElement('div'); grp.className = 'list-group';
      const lead = doc.createElement('span'); lead.className = 'lead'; lead.textContent = `Cities (${total}):`;
      const chips = doc.createElement('span'); chips.className = 'chips';
      grp.append(lead, chips);
      const byCountry = new Map();
      for (const i of been) { if (!byCountry.has(C.cc[i])) byCountry.set(C.cc[i], []); byCountry.get(C.cc[i]).push([i, 1]); }
      for (const i of want) { if (!byCountry.has(C.cc[i])) byCountry.set(C.cc[i], []); byCountry.get(C.cc[i]).push([i, 2]); }
      const groups = [...byCountry.keys()].map(cc => [cc, countryName(cc)]).sort((a, b) => a[1].localeCompare(b[1]));
      const vm = A.viewMode || 'own';
      for (const [cc, cname] of groups) {
        const g = doc.createElement('span'); g.className = 'city-group';
        const lab = doc.createElement('span'); lab.className = 'grp'; lab.textContent = cname + ':';
        g.appendChild(lab);
        const list = byCountry.get(cc).sort((a, b) => a[1] - b[1] || C.name[a[0]].localeCompare(C.name[b[0]]));
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
            const bits = [C.name[i] + ', ' + countryName(cc), st === 1 ? 'been there' : 'want to go'];
            if (info && info.rating) bits.push('rated ' + info.rating);
            if (info && info.note) bits.push('has a note');
            chip.setAttribute('aria-label', bits.join(', ') + '. Open details.');
            chip.addEventListener('click', () => openDetails(id, chip));
          }
          g.appendChild(chip);
        }
        chips.appendChild(g);
      }
      listHost.appendChild(grp);
    }

    // ---- search source ----
    // Called by app.js with the raw query. Returns rows the core merges with place results.
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
          id, kind: 'city', map: 'world',
          name: h.alias && h.cls < 4 && !C.keys[i][0].includes(norm(raw)) ? `${C.name[i]} (${h.alias})` : C.name[i],
          where, cls: h.cls, rank: i, score: h.cls + 0.5,
          label: `${C.name[i]}, city in ${whereText(C, i, cname)}`,
          pick: () => pickCity(i),
        };
      });
    }
    function pickCity(i) {
      tapCity(i);
      flashCity(i);
      return status(C.id[i]);
    }

    // ---- wiring ----
    function wire() {
      A = win.Atlas;
      view = A.views && A.views.world;
      if (!view) return;
      svg = view.svg || doc.querySelector('svg.map[data-map="world"]');
      // layer: through addLayer when the core offers it, else after .dots ourselves
      let host = null;
      if (typeof A.addLayer === 'function') {
        try { host = A.addLayer('world', (vb, k) => onView(vb, k)) || null; } catch (_) { host = null; }
      }
      if (host && host.nodeType !== 1) host = null;
      mountLayer(host);
      if (!(typeof A.addLayer === 'function')) {
        if (Array.isArray(view.onView)) view.onView.push(onView); else view.onView = onView;
      }
      if (typeof A.onTap === 'function') A.onTap('world', onTap); else if (Array.isArray(view.onTap)) view.onTap.push(onTap); else view.onTap = onTap;
      if (Array.isArray(view.onHover)) view.onHover.push(onHover); else svg.addEventListener('pointermove', e => { if (!e.buttons && !svg.classList.contains('dragging')) onHover(e); });
      if (typeof A.addSearchSource === 'function') A.addSearchSource(searchSource);
      if (typeof A.on === 'function') {
        A.on('change', () => { if (C) afterChange(); else { renderTile(); if (cityIds().length) ensure(); } });
        A.on('zoom', (m, k) => { if ((m === 'world' || (m && m.map === 'world')) && !C && (+k || (m && m.k) || 0) >= 2) ensure(); });
        A.on('style', () => { if (C) layoutLabels(); });
      }
      svg.addEventListener('pointerup', () => { if (labelTimer) { win.clearTimeout(labelTimer); win.setTimeout(layoutLabels, 0); } });
      win.addEventListener('resize', () => { frameW = 0; if (C && curVb) render(true); });
      const q = doc.getElementById('q');
      if (q) q.addEventListener('focus', ensure);
      // initial view (the core may have applied before we hooked in)
      const vb0 = view.vb || (svg.viewBox && svg.viewBox.baseVal ? { x: svg.viewBox.baseVal.x, y: svg.viewBox.baseVal.y, w: svg.viewBox.baseVal.width, h: svg.viewBox.baseVal.height } : null);
      if (vb0) curVb = { x: vb0.x, y: vb0.y, w: vb0.w || vb0.width, h: vb0.h || vb0.height };
      renderTile();
      if (cityIds().length || (curVb && view.W / curVb.w >= 2)) ensure();
      win.AtlasCities.ready = true;
      try { win.dispatchEvent(new win.CustomEvent('atlas-cities-ready')); } catch (_) {}
    }

    // public, for tests and other modules
    Object.assign(win.AtlasCities, {
      load, stats,
      count: () => pool.reduce((a, n) => a + (n.parentNode ? 1 : 0), 0),
      labels: () => textPool.reduce((a, t) => a + (t.parentNode ? 1 : 0), 0),
      hit: (x, y) => { const i = hitIndex(x, y); return i < 0 ? null : C.id[i]; },
      screenOf: (id) => {          // client px of a city (for tests); null if not loaded
        if (!C || !curVb) return null;
        const i = C.byId.get(id); if (i == null) return null;
        const r = svg.getBoundingClientRect(), s = r.width / curVb.w;
        return { x: r.left + (C.x[i] - curVb.x) * s, y: r.top + (C.y[i] - curVb.y) * s };
      },
      get: (id) => {               // place-like record for the panel / other modules
        const i = C && C.byId.get(id); if (i == null) return null;
        return { id: C.id[i], name: C.name[i], kind: 'city', map: 'world', country: C.cc[i], countryName: countryName(C.cc[i]), admin1: C.adm[i], capital: C.flags[i] === FLAG_CAPITAL };
      },
      find: (name) => { if (!C) return null; for (let i = 0; i < C.n; i++) if (C.name[i] === name) return C.id[i]; return null; },
      flash: (id) => { const i = C && C.byId.get(id); if (i != null) flashCity(i); },
      refresh: () => { if (C) afterChange(); else renderTile(); },
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
    norm, parse, select, buildGrid, nearest, placeLabels, search, matchClass, whereText, tally, capitalTotal, boot,
    CAP, TIER_CAP, REF_W, HIT_PX, CELL, TIER_MIN_K, LABELS_PHONE, LABELS_DESK, OFFLINE_NOTE,
  };
});
