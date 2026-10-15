// Travel Atlas core: maps, marking (Been there / Want to go), counters, lists, search, backup,
// sync with a shared map, view pages. Data lives in js/store.js (window.AtlasStore).
//
// ============================================================================================
// THE SEAM: window.Atlas  (docs/plan-ux.md §7, docs/plan-cities.md §6)
// --------------------------------------------------------------------------------------------
// Feature modules (places-panel.js, ratings.js, cities.js, ...) are plain <script defer> files
// after app.js and talk to the core only through window.Atlas. It is published once both maps
// are built (then `atlas:ready` fires on window and document; Atlas.ready is a Promise too).
//
// Data
//   places            Map id -> {id, name, kind, map}. Modules may add entries (cities: kind 'city').
//   nodes             Map id -> [svg elements] for map places (paths, dots, hit circles, inset boxes).
//   views             {na, world}: see "Views" below.
//   getStatus(id)     0 none | 1 been | 2 want (own atlas, or the shared map on a view page).
//   setStatus(id, s, {quiet})  s: 0/1/2 or 'none'/'been'/'want'. Own atlas only (false on view
//                     pages). Toasts unless quiet. Returns true if it changed. Throws on a bad id.
//   tap(id)           a map tap on id: marking-switch rules + toasts (what a click on a place does).
//   ids(s)            sorted ids with status s (1 or 2), cities included.
//   getInfo(id)       {rating, year, note} | null  (notes; on a plain view page always null).
//   setInfo(id, patch) patch {rating?, year?, note?}; own atlas only. Throws RangeError / Error
//                     with code 'too_many_notes' (see js/store.js). Returns true if it changed.
//   ownerName()       the atlas owner's name as shown.
//   mode              'been' | 'want' (the marking switch; resets to 'been' on every load). setMode(m).
//   viewMode          'own' | 'plain' (map-only view link) | 'notes' (map-with-notes view link).
//   style             current map style id ('flat' | 'real' | a module's id). setStyle(id, remember).
//   citiesLoaded      modules set true once city ids are registered in `places` (backup checks).
// Events  on(evt, fn) / off(evt, fn) / emit(evt, payload)   (on('ready') fires at once if ready)
//   'change'  {ids: [..] | null (= everything), source: 'local'|'remote'|'reload'|'restore'|'undo'|'view', owner}
//   'zoom'    {map, k, vb}   when a map's zoom factor changes
//   'style'   {style}
//   'mode'    {mode}
//   'view'    {mode}         a view page loaded (or fell back from notes to plain)
//   'details' {id, map, opener, readonly}   chips, the toast's Details button, notes-view taps.
//             Nobody listening: nothing happens (and toasts show no Details button).
// UI
//   toast(map, msg, action)  action: {label, run(button)} or a place id (= a Details button) or null.
//   openDetails(id, opener)  emits 'details'.
//   flash(id)                flash a map place (search does this).
//   tip(id, x, y) / hideTip()  the hover tooltip.
//   addSearchSource(fn)      fn(rawQuery, normQuery) -> rows [{id, name, where, label?, pick?()}]
//                            or [{note, empty: true}]. Max 6 rows from sources, 10 total, places first.
//   norm(s)                  the search folding (accents, case).
//   addLayer(mapKey, fn)     creates <g class="layer"> above the dots of that map and returns it;
//                            fn(vb, k) is called at the end of every view update (an onView hook).
//   onTap(mapKey, fn)        same as views[mapKey].onTap.push(fn).
//   addStyle({id, label, icon})  adds a button to the style switch; returns it. The module owns its
//                            body class (e.g. body.ratings) and follows the 'style' event.
//   addLegend(mapKey, ...nodes)  a node with class "legend" goes after that map's legend (other
//                            nodes follow it); anything else is appended inside the legend.
//   link()                   {id, name, notesToken, viewUrl, notesUrl} | null (this device's shared map).
//   notesLink(action)        'on' | 'off' | 'reset' -> Promise {ok, status, notesToken}.
// Views  (Atlas.views.na / .world)
//   svg, frame, W, H, k (zoom factor), vb ({x,y,w,h} viewBox), scale() (CSS px per unit),
//   toSvg(clientX, clientY), set(x, y, w), zoomAt(f, x, y), layoutLabels(), sizeMarks()
//   onView   array of fn(vb, k), called at the end of every apply() (once per frame while panning)
//   onTap    array of fn(event): checked first on a tap that didn't move; return true to skip the
//            place toggle
//   onHover  array of fn(event) for mouse moves (not dragging); return true to skip the place tooltip
// ============================================================================================
(async function () {
  'use strict';
  let NA, WORLD; // loaded from ./data/na.json and ./data/world.json at startup

  // terrain JPEGs; attached to the map only the first time the real map is shown
  const TERRAIN = {"world": "./terrain/world.jpg", "na": "./terrain/na.jpg", "insets": ["./terrain/inset-0.jpg", "./terrain/inset-1.jpg", "./terrain/inset-2.jpg", "./terrain/inset-3.jpg", "./terrain/inset-4.jpg", "./terrain/inset-5.jpg", "./terrain/inset-6.jpg"]};
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const AS = window.AtlasStore;

  // ---------- event bus (the seam's on/off/emit) ----------
  const listeners = new Map();
  let isReady = false;
  function on(evt, fn) {
    if (typeof fn !== 'function') return;
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    if (evt === 'ready' && isReady) setTimeout(() => fn(window.Atlas), 0);
  }
  function off(evt, fn) { const s = listeners.get(evt); if (s) s.delete(fn); }
  function hasListeners(evt) { const s = listeners.get(evt); return !!s && s.size > 0; }
  function emit(evt, payload) {
    const s = listeners.get(evt); if (!s) return;
    for (const fn of [...s]) {
      try { fn(payload); } catch (err) { setTimeout(() => { throw err; }, 0); }   // surface, never break the core
    }
  }

  // ---------- registry ----------
  const places = new Map();        // id -> {id, name, kind, map}
  const nodes = new Map();         // id -> [svg elements]
  const KIND_LABEL = { state: 'U.S. state', dc: 'Federal district', territory: 'U.S. territory', province: 'Canada', country: 'Country', other: 'Territory', city: 'City' };
  const MAP_LABEL = { na: 'U.S. & Canada', world: 'World' };
  const STATUS_WORD = { 1: 'been there', 2: 'want to go' };

  function register(rec, map, node) {
    if (!places.has(rec.id)) places.set(rec.id, { id: rec.id, name: rec.name, kind: rec.kind, map });
    if (!nodes.has(rec.id)) nodes.set(rec.id, []);
    nodes.get(rec.id).push(node);
    node.dataset.id = rec.id;
  }

  // ---------- build maps ----------
  const terrainImgs = []; // [image element, JPEG path] — href is attached the first time the real map is shown
  function terrain(parent, uri, attrs) {
    const img = el('image', Object.assign({ class: 'terrain', preserveAspectRatio: 'none' }, attrs), parent);
    terrainImgs.push([img, uri]);
    return img;
  }
  function label(parent, r) {
    if (!r.l) return;
    const t = el('text', { class: 'lbl', x: r.l[0], y: r.l[1], 'data-w': r.l[2], 'data-h': r.l[3] }, parent);
    t.textContent = r.name;
    t.style.display = 'none';
  }
  // Want to go: diagonal stripes. Sizes are attributes set by sizeMarks() (6/k units, line 2/k);
  // css/features.css only colors them.
  function hatch(defs, mapKey) {
    const p = el('pattern', { id: 'want-' + mapKey, patternUnits: 'userSpaceOnUse', width: 6, height: 6, patternTransform: 'rotate(45)' }, defs);
    el('rect', { class: 'want-bg', x: 0, y: 0, width: 6, height: 6 }, p);
    el('line', { class: 'want-line', x1: 1, y1: 0, x2: 1, y2: 6, 'stroke-width': 2 }, p);
    return p;
  }

  // Small places get a visible dot plus an invisible, larger hit circle (same place id) so they
  // stay easy to tap on a phone. The hit circle's radius is kept ~22 CSS px across at every zoom.
  function addDot(r, map, hitParent, dotParent) {
    const h = el('circle', { class: 'dot-hit', cx: r.dot[0], cy: r.dot[1], r: 10 }, hitParent); register(r, map, h);
    const c = el('circle', { class: 'dot', cx: r.dot[0], cy: r.dot[1], r: 3.2 }, dotParent); register(r, map, c);
  }

  function buildNA() {
    const svg = el('svg', { viewBox: `0 0 ${NA.w} ${NA.h}`, class: 'map', 'data-map': 'na', role: 'group', 'aria-label': 'Map of the United States and Canada' });
    const defs = el('defs', {}, svg);
    hatch(defs, 'na');
    el('rect', { class: 'water', x: 0, y: 0, width: NA.w, height: NA.mainH }, svg);
    terrain(svg, TERRAIN.na, { x: 0, y: 0, width: NA.w, height: NA.mainH });
    el('path', { class: 'ctx', d: NA.context }, svg);
    const g = el('g', { class: 'places' }, svg);
    const labels = el('g', { class: 'labels', 'data-size': 11 }, svg);
    const hits = el('g', { class: 'hits' }, svg);
    const dots = el('g', { class: 'dots' }, svg);
    for (const r of NA.places) {
      const p = el('path', { class: 'place', d: r.d, 'data-kind': r.kind }, g);
      register(r, 'na', p);
      if (r.dot) addDot(r, 'na', hits, dots);
      if (r.kind !== 'dc') label(labels, r);
    }
    el('line', { class: 'tray-line', x1: 0, y1: NA.mainH, x2: NA.w, y2: NA.mainH }, svg);
    const tray = el('g', { class: 'tray' }, svg);
    NA.insets.forEach((ins, i) => {
      const ig = el('g', { class: 'inset' }, tray);
      const cp = el('clipPath', { id: 'clip-inset-' + i }, defs);
      el('rect', { x: ins.x, y: ins.y, width: ins.w, height: ins.h, rx: 6 }, cp);
      terrain(ig, TERRAIN.insets[i], { x: ins.x, y: ins.y, width: ins.w, height: ins.h, 'clip-path': `url(#clip-inset-${i})` });
      const bg = el('rect', { class: 'inset-bg', x: ins.x, y: ins.y, width: ins.w, height: ins.h, rx: 6 }, ig);
      if (ins.id) { const rec = ins.places.find(p => p.id === ins.id) || { id: ins.id, name: ins.label, kind: 'territory' }; register(rec, 'na', bg); }
      const t = el('text', { class: 'inset-label', x: ins.x + 9, y: ins.y + 17 }, ig);
      t.textContent = ins.label;
      for (const r of ins.places) {
        const p = el('path', { class: 'place', d: r.d, 'data-kind': r.kind }, ig);
        register(r, 'na', p);
        if (r.dot) addDot(r, 'na', ig, ig);
      }
    });
    return svg;
  }

  function buildWorld() {
    const svg = el('svg', { viewBox: `0 0 ${WORLD.w} ${WORLD.h}`, class: 'map', 'data-map': 'world', role: 'group', 'aria-label': 'Map of the world' });
    const defs = el('defs', {}, svg);
    hatch(defs, 'world');
    const cp = el('clipPath', { id: 'clip-sphere' }, defs);
    el('path', { d: WORLD.sphere }, cp);
    el('path', { class: 'sphere', d: WORLD.sphere }, svg);
    terrain(svg, TERRAIN.world, { x: 0, y: 0, width: WORLD.w, height: WORLD.h, 'clip-path': 'url(#clip-sphere)' });
    const g = el('g', { class: 'places' }, svg);
    const labels = el('g', { class: 'labels', 'data-size': 10 }, svg);
    const hits = el('g', { class: 'hits' }, svg);
    const dots = el('g', { class: 'dots' }, svg);
    for (const r of WORLD.places) {
      const p = el('path', { class: 'place', d: r.d, 'data-kind': r.kind }, g);
      register(r, 'world', p);
      if (r.dot) addDot(r, 'world', hits, dots);
      if (r.id !== 'ATA') label(labels, r);
    }
    // the sphere outline sits on top so the terrain has a crisp edge
    el('path', { class: 'sphere', d: WORLD.sphere, 'pointer-events': 'none' }, svg).style.fill = 'none';   // CSSOM, not a style="" attribute (CSP)
    return svg;
  }


  // ---------- app install & updates ----------
  // Wired up before the map data loads so no browser event is missed.
  const LS_SAFE = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };
  const isStandalone = () => {
    try { if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true; } catch (_) {}
    return window.navigator.standalone === true;
  };

  // Install button (Chromium browsers)
  const installBtn = $('#install-btn');
  let installPrompt = null;
  function hideInstall() { installPrompt = null; installBtn.hidden = true; }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    if (isStandalone()) return;
    installPrompt = e; installBtn.hidden = false;
  });
  installBtn.addEventListener('click', () => {
    const p = installPrompt; if (!p) return;
    hideInstall();
    try { p.prompt(); Promise.resolve(p.userChoice).catch(() => {}); } catch (_) {}
  });
  window.addEventListener('appinstalled', () => { hideInstall(); hideIosHint(false); });
  try {
    const mq = window.matchMedia('(display-mode: standalone)');
    const onMode = () => { if (mq.matches) { hideInstall(); hideIosHint(false); } };
    if (mq.addEventListener) mq.addEventListener('change', onMode); else if (mq.addListener) mq.addListener(onMode);
  } catch (_) {}

  // One-time hint for iPhone / iPad Safari, which has no install prompt
  const IOS_HINT_KEY = 'travel-atlas:ios-hint';
  const iosHint = $('#ios-hint');
  function hideIosHint(remember) { iosHint.hidden = true; if (remember) LS_SAFE.set(IOS_HINT_KEY, '1'); }
  (function () {
    const ua = navigator.userAgent || '';
    const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const safari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);
    if (ios && safari && !isStandalone() && LS_SAFE.get(IOS_HINT_KEY) !== '1') iosHint.hidden = false;
  })();
  $('#ios-hint-close').addEventListener('click', () => hideIosHint(true));

  // Color for visited places, chosen from a small palette and remembered on this device
  const ACCENT_KEY = 'travel-atlas:accent';
  const accentBtn = $('#accent-btn'), accentPop = $('#accent-pop');
  const swatches = [...accentPop.querySelectorAll('[data-accent]')];
  const ACCENTS = swatches.map(b => b.dataset.accent);
  function setAccent(name, remember) {
    if (!ACCENTS.includes(name)) name = 'amber';
    if (name === 'amber') document.documentElement.removeAttribute('data-accent');
    else document.documentElement.setAttribute('data-accent', name);
    swatches.forEach(b => { const on = b.dataset.accent === name; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    if (remember) LS_SAFE.set(ACCENT_KEY, name);
  }
  function openAccent(open) {
    accentPop.hidden = !open; accentBtn.setAttribute('aria-expanded', String(open));
    if (open) {                                  // keep the palette on screen on narrow phones
      accentPop.style.left = '0px';
      const r = accentPop.getBoundingClientRect(), vw = document.documentElement.clientWidth;
      const shift = Math.max(8 - r.left, Math.min(0, vw - 8 - r.right));
      accentPop.style.left = shift + 'px';
    }
    if (open) (swatches.find(b => b.getAttribute('aria-checked') === 'true') || swatches[0]).focus();
  }
  setAccent(LS_SAFE.get(ACCENT_KEY) || 'amber', false);
  accentBtn.addEventListener('click', () => openAccent(accentPop.hidden));
  swatches.forEach((b, i) => {
    b.addEventListener('click', () => { setAccent(b.dataset.accent, true); openAccent(false); accentBtn.focus(); });
    b.addEventListener('keydown', e => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const n = swatches[(i + step + swatches.length) % swatches.length];
      setAccent(n.dataset.accent, true); n.focus();
    });
  });
  document.addEventListener('click', e => { if (!accentPop.hidden && !e.target.closest('.accent')) openAccent(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !accentPop.hidden) { openAccent(false); accentBtn.focus(); } });

  // Service worker: offline support, and a quiet notice when a new version is ready
  const updateToast = $('#update-toast');
  let waitingWorker = null, reloadRequested = false;
  function showUpdate(worker) { waitingWorker = worker; updateToast.hidden = false; }
  $('#update-reload').addEventListener('click', () => {
    if (!waitingWorker) { location.reload(); return; }
    reloadRequested = true;
    try { waitingWorker.postMessage({ type: 'SKIP_WAITING' }); } catch (_) { location.reload(); }
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloadRequested) return;              // never refresh on our own
      reloadRequested = false; location.reload();
    });
    const registerSW = () => {
      navigator.serviceWorker.register('./sw.js').then(reg => {
        const watch = w => {
          if (!w) return;
          w.addEventListener('statechange', () => {
            if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w);
          });
        };
        if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
        watch(reg.installing);                     // an update may already be mid-install
        reg.addEventListener('updatefound', () => watch(reg.installing));
      }).catch(() => {});
    };
    if (document.readyState === 'complete') registerSW(); else window.addEventListener('load', registerSW);
  }

  // ---------- load map data ----------
  const loadingEls = [...document.querySelectorAll('.frame-loading')];
  try {
    if (!AS) throw new Error('js/store.js missing');
    const get = url => fetch(url).then(r => { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); });
    [NA, WORLD] = await Promise.all([get('./data/na.json'), get('./data/world.json')]);
  } catch (err) {
    for (const n of loadingEls) { n.textContent = 'Couldn’t load the map. Check your connection and reload the page.'; n.classList.add('err'); }
    $('#status').hidden = true;
    return;
  }
  for (const n of loadingEls) n.remove();

  const svgNA = buildNA();
  const svgWorld = buildWorld();
  $('#frame-na').prepend(svgNA);
  $('#frame-world').prepend(svgWorld);
  // the places the map data draws (cities and other module places are added to `places` later)
  const mapIds = { na: [], world: [] };
  for (const p of places.values()) mapIds[p.map].push(p.id);
  const onMaps = new Set(places.keys());

  // ---------- route, link and the data source ----------
  const LS_T = 'travel-atlas:t';                           // ms of the newest local change (kept for old versions)
  const BACKUP_KEY = 'travel-atlas:lastBackup';            // ms timestamp of the last code copy / file download
  const LINK_KEY = AS.KEYS.link;                           // {id, editKey, name, synced, rev?, full?, notesToken} once linked
  const V2_KEY = AS.KEYS.v2;
  const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
  function readJSON(k) { const raw = LS_SAFE.get(k); if (!raw) return null; try { return JSON.parse(raw); } catch (_) { return null; } }
  function readLink() { const l = readJSON(LINK_KEY); return l && typeof l.id === 'string' && typeof l.editKey === 'string' ? l : null; }
  function writeLink(l) { try { if (l) localStorage.setItem(LINK_KEY, JSON.stringify(l)); else localStorage.removeItem(LINK_KEY); } catch (_) {} }

  // /map/<id> (view, or same as / when this device holds that map's key), /map/<id>#edit=<key> (pairing),
  // /map/<id>#notes=<token> (map-with-notes view), /#import=<atlas1 code>&owner=&accent=&style=
  // (sent by the old address's forwarding page)
  function parseRoute() {
    const m = location.pathname.match(/^\/map\/([^/]+)\/?$/);
    let id = null;
    if (m) { try { id = decodeURIComponent(m[1]); } catch (_) { id = m[1]; } }
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    const nt = id ? h.get('notes') : null;
    return { mapId: id, editKey: id ? h.get('edit') : null, notes: nt && TOKEN_RE.test(nt) ? nt : null, imp: !id && h.has('import') ? h : null };
  }
  const route = parseRoute();
  // An edit key waiting to be checked (pairing offline). Kept in memory and in sessionStorage so a
  // reload can retry, never in the address bar.
  const PENDING_KEY = 'travel-atlas:pending-pair';
  const SS = {
    get() { try { const v = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null'); return v && typeof v.id === 'string' && typeof v.key === 'string' ? v : null; } catch (_) { return null; } },
    set(v) { try { if (v) sessionStorage.setItem(PENDING_KEY, JSON.stringify(v)); else sessionStorage.removeItem(PENDING_KEY); } catch (_) {} },
  };
  if (route.mapId && !route.editKey) { const pp = SS.get(); if (pp && pp.id === route.mapId) route.editKey = pp.key; }
  let link = readLink();
  let syncState = 'syncing', unlinkReason = null;
  // true on /map/<id> when this device doesn't hold that map's edit key: someone else's map, read-only
  let viewOnly = !!route.mapId && !route.editKey && !(link && link.id === route.mapId);
  let viewMode = viewOnly ? (route.notes ? 'notes' : 'plain') : 'own';
  // a notes link to this device's own map opens as its own atlas; the token leaves the address bar
  if (!viewOnly && route.notes && !route.editKey) history.replaceState(null, '', location.pathname);

  // The device's own atlas (never created on a view page, so viewing never writes this device's storage).
  let store = viewOnly ? null : AS.create();
  // What a view page shows: the shared map's statuses and (notes view) its notes.
  const viewData = { places: new Map(), notes: new Map() };
  function statusOf(id) {
    if (viewOnly || !store) return viewData.places.get(id) || 0;
    return store.getStatus(id);
  }
  function infoOf(id) {
    if (viewOnly || !store) return viewMode === 'notes' ? viewData.notes.get(id) || null : null;
    return store.getNotes(id);
  }
  function idsOf(s) {
    if (viewOnly || !store) return [...viewData.places].filter(e => e[1] === s).map(e => e[0]).sort();
    return store.ids(s);
  }
  const nameOf = id => (places.get(id) || {}).name || id;
  const mapOf = id => (places.get(id) || {}).map || (/^C-/.test(id) ? 'world' : 'na');
  // "been there · ★★★★☆ · 2019"
  function infoLine(id) {
    const s = statusOf(id), n = infoOf(id), bits = [];
    bits.push(STATUS_WORD[s] || 'not marked');
    if (n && n.rating) bits.push('★'.repeat(n.rating) + '☆'.repeat(5 - n.rating));
    if (n && n.year) bits.push(String(n.year));
    return bits.join(' · ');
  }

  // ---------- groups / counters ----------
  const GROUPS = [
    { map: 'na', label: 'U.S. states', kinds: ['state'] },
    { map: 'na', label: 'D.C. & territories', kinds: ['dc', 'territory'] },
    { map: 'na', label: 'Canadian provinces & territories', kinds: ['province'] },
    { map: 'world', label: 'Countries', kinds: ['country'] },
    { map: 'world', label: 'Territories & other places', kinds: ['other'] },
  ];
  for (const gr of GROUPS) {
    gr.ids = [...places.values()].filter(p => p.map === gr.map && gr.kinds.includes(p.kind)).map(p => p.id);
    const tile = document.createElement('div');
    tile.className = 'stat';
    tile.innerHTML = `<div class="num"><span class="n">0</span><small>/ ${gr.ids.length}</small></div><div class="label">${gr.label}</div><div class="want-line" hidden></div><div class="bar"><i></i><i class="want"></i></div>`;
    $('#stats-' + gr.map).appendChild(tile);
    gr.tile = tile;
    gr.bars = tile.querySelectorAll('.bar i');
  }
  function updateCounters() {
    for (const gr of GROUPS) {
      let n = 0, w = 0;
      for (const id of gr.ids) { const s = statusOf(id); if (s === 1) n++; else if (s === 2) w++; }
      $('.n', gr.tile).textContent = n;
      const wl = $('.want-line', gr.tile);
      wl.hidden = !w; wl.textContent = w ? `+${w} want to go` : '';
      const pct = x => (gr.ids.length ? (100 * x / gr.ids.length) : 0) + '%';
      gr.bars[0].style.width = pct(n);                    // CSSOM (CSP: no style="" attributes)
      gr.bars[1].style.width = pct(w);
    }
    for (const m of ['na', 'world']) renderList(m);
  }

  // Two lists per map: "Been there (n):" solid chips, "Want to go (n):" outline chips.
  // A chip opens details (Atlas 'details' event); on a plain view page chips are plain text.
  const NOTE_GLYPH = '✎';
  function makeChip(p, s) {
    const info = infoOf(p.id);
    const interactive = !viewOnly || viewMode === 'notes';
    const c = document.createElement(interactive ? 'button' : 'span');
    c.className = 'chip' + (s === 2 ? ' want' : '');
    c.dataset.id = p.id;
    const nm = document.createElement('span'); nm.textContent = p.name; c.appendChild(nm);
    if (info && info.rating) { const r = document.createElement('span'); r.className = 'ci-rate'; r.setAttribute('aria-hidden', 'true'); r.textContent = '★' + info.rating; c.appendChild(r); }
    if (info && info.note) { const g = document.createElement('span'); g.className = 'ci-note'; g.setAttribute('aria-hidden', 'true'); g.textContent = NOTE_GLYPH; c.appendChild(g); }
    if (interactive) {
      c.type = 'button';
      const bits = [p.name, STATUS_WORD[s]];
      if (info && info.rating) bits.push('rated ' + info.rating);
      if (info && info.note) bits.push('has a note');
      c.setAttribute('aria-label', bits.join(', ') + '. Open details.');
      c.title = infoLine(p.id);
      c.addEventListener('click', () => openDetails(p.id, c));
    }
    return c;
  }
  function renderList(map) {
    const host = $('#list-' + map);
    const been = [], want = [];
    for (const id of mapIds[map]) { const s = statusOf(id); if (s === 1) been.push(places.get(id)); else if (s === 2) want.push(places.get(id)); }
    host.textContent = '';
    if (!been.length && !want.length) { host.innerHTML = '<span class="none">Nothing marked here yet.</span>'; return; }
    for (const [list, s, title] of [[been, 1, 'Been there'], [want, 2, 'Want to go']]) {
      if (!list.length) continue;
      list.sort((a, b) => a.name.localeCompare(b.name));
      const g = document.createElement('div');
      g.className = 'list-group'; g.dataset.status = s === 1 ? 'been' : 'want';
      g.innerHTML = `<span class="lead">${title} (${list.length}):</span><span class="chips"></span>`;
      const chips = $('.chips', g);
      for (const p of list) chips.appendChild(makeChip(p, s));
      host.appendChild(g);
    }
  }

  // ---------- state rendering ----------
  function paint(id) {
    const s = statusOf(id);
    for (const n of nodes.get(id) || []) { n.classList.toggle('on', s === 1); n.classList.toggle('want', s === 2); }
  }
  function paintAll() { for (const id of nodes.keys()) paint(id); updateCounters(); }

  // ---------- marking: the switch and the tap rules (plan-ux §2.1) ----------
  let markMode = 'been';                                   // never saved: every load starts on Been there
  const markSegs = [...document.querySelectorAll('.mark-seg')];
  function setMode(m) {
    markMode = m === 'want' ? 'want' : 'been';
    for (const seg of markSegs) for (const b of seg.querySelectorAll('button[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === markMode));
    for (const f of document.querySelectorAll('.frame')) f.classList.toggle('mode-want', markMode === 'want' && !viewOnly);
    emit('mode', { mode: markMode });
  }
  for (const seg of markSegs) for (const b of seg.querySelectorAll('button[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  setMode('been');

  function statusToast(id, from, to) {
    const n = nameOf(id);
    if (to === 1) return from === 2 ? `${n}: been there (was on Want to go)` : `${n}: been there`;
    if (to === 2) return `${n}: want to go`;
    return `${n}: cleared`;
  }
  function openDetails(id, opener) {
    if (!id) return;
    emit('details', { id, map: mapOf(id), opener: opener || null, readonly: viewOnly });
  }
  function detailsAction(id) {
    if (!hasListeners('details') || (viewOnly && viewMode !== 'notes')) return null;
    return { label: 'Details', run: btn => openDetails(id, btn) };
  }
  // A tap/click on a place (map, search). Returns the store's tap result on the own atlas.
  function tapPlace(id, opts) {
    const quiet = !!(opts && opts.quiet);
    const map = mapOf(id);
    if (viewOnly) {                              // a shared map seen from another device: look, don't touch
      if (viewMode === 'notes' && statusOf(id) && hasListeners('details')) openDetails(id, null);
      else if (!quiet) toast(map, 'View only');
      return { from: statusOf(id), to: statusOf(id), changed: false, blocked: true };
    }
    const r = store.tap(id, markMode);
    if (quiet) return r;
    if (r.blocked) toast(map, `Already been to ${nameOf(id)}`, detailsAction(id));
    else if (r.changed) toast(map, statusToast(id, r.from, r.to), detailsAction(id));
    return r;
  }
  const S_IN = { none: 0, been: 1, want: 2, '': 0 };
  function setStatusApi(id, s, opts) {
    if (viewOnly || !store) return false;
    if (typeof s === 'string') s = S_IN[s];
    const from = store.getStatus(id);
    const changed = store.setStatus(id, s);
    if (changed && !(opts && opts.quiet)) toast(mapOf(id), statusToast(id, from, s), detailsAction(id));
    return changed;
  }

  // ---------- toast / tooltip ----------
  const toastTimers = {}, toastActs = {};
  function hideToast(map) {
    const t = $('#toast-' + map); if (!t) return;
    t.classList.remove('show');
    clearTimeout(toastTimers[map]);
    const act = toastActs[map];
    // the Details button leaves the tab order once the toast has faded
    if (act) toastTimers[map] = setTimeout(() => { if (!t.classList.contains('show') && document.activeElement !== act) act.hidden = true; }, 250);
  }
  function armToast(map, ms) { clearTimeout(toastTimers[map]); toastTimers[map] = setTimeout(() => hideToast(map), ms); }
  function toast(map, msg, action) {
    const t = $('#toast-' + map); if (!t) return;
    if (typeof action === 'string') action = detailsAction(action);
    t.textContent = '';
    const m = document.createElement('span'); m.className = 'toast-msg'; m.textContent = msg; t.appendChild(m);
    toastActs[map] = null;
    if (action && action.label && typeof action.run === 'function') {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'toast-act'; b.textContent = action.label;
      b.addEventListener('click', e => { e.stopPropagation(); hideToast(map); action.run(b); });
      // stays while hovered or focused, then leaves 1.5 s later
      b.addEventListener('pointerenter', () => clearTimeout(toastTimers[map]));
      b.addEventListener('focus', () => clearTimeout(toastTimers[map]));
      b.addEventListener('pointerleave', () => { if (document.activeElement !== b) armToast(map, 1500); });
      b.addEventListener('blur', () => armToast(map, 1500));
      t.appendChild(b);
      toastActs[map] = b;
    }
    t.classList.add('show');
    armToast(map, toastActs[map] ? 4000 : 1400);
  }
  const tip = $('#tip');
  function showTip(id, x, y) {
    const p = places.get(id); if (!p) return;
    tip.innerHTML = '';
    tip.append(document.createTextNode(p.name));
    const s = statusOf(id);
    const k = document.createElement('span'); k.className = 'k'; k.textContent = s || infoOf(id) ? infoLine(id) : KIND_LABEL[p.kind] || ''; tip.appendChild(k);
    moveTip(x, y); tip.classList.add('show');
  }
  function moveTip(x, y) {
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x, top = y;
    if (x + 12 + w > window.innerWidth - 8) left = x - w - 24;
    if (y + 14 + h > window.innerHeight - 8) top = y - h - 28;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }
  function hideTip() { tip.classList.remove('show'); }
  const runHooks = (list, e) => { for (const fn of list) { try { if (fn(e) === true) return true; } catch (err) { setTimeout(() => { throw err; }, 0); } } return false; };

  // ---------- zoom / pan / click ----------
  function makeInteractive(svg, W, H, mapKey) {
    const frame = svg.parentElement;
    let vb = { x: 0, y: 0, w: W, h: H }, k = 1;
    const MAXK = 10;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const view = { svg, frame, W, H, map: mapKey, onView: [], onTap: [], onHover: [] };
    const zoomBox = $('.zoom[data-for="' + mapKey + '"]');
    zoomBox.innerHTML = `
      <button type="button" data-z="in" aria-label="Zoom in" title="Zoom in"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg></button>
      <button type="button" data-z="out" aria-label="Zoom out" title="Zoom out"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8h10"/></svg></button>
      <button type="button" data-z="reset" aria-label="Reset view" title="Reset view" disabled><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a5 5 0 1 0 1.5-3.6M3 3v2.5h2.5"/></svg></button>`;
    const btnReset = $('[data-z="reset"]', zoomBox), btnIn = $('[data-z="in"]', zoomBox), btnOut = $('[data-z="out"]', zoomBox);

    const labelsG = svg.querySelector('g.labels');
    const labelBase = +labelsG.dataset.size;               // font size in screen px
    const labelEls = [...labelsG.querySelectorAll('text.lbl')].map(t => ({ t, w: +t.dataset.w, h: +t.dataset.h, n: t.textContent.length }));
    const charW = svg.dataset.map === 'world' ? 0.72 : 0.56; // uppercase + tracking is wider
    function layoutLabels() {
      if (!document.body.classList.contains('real')) return;
      const s = scale();                                     // screen px per viewBox unit
      const fs = labelBase / s;                              // font size in viewBox units
      labelsG.setAttribute('font-size', fs.toFixed(2));
      labelsG.setAttribute('stroke-width', (3 / s).toFixed(2));
      // a name is shown once its place is wide enough on screen to hold it
      for (const L of labelEls) {
        const need = L.n * labelBase * charW * 0.8;   // estimated label width on screen
        const room = L.w * s;                           // the place's width on screen
        L.t.style.display = room >= need ? '' : 'none';
      }
    }
    // dot / hit-circle sizes depend only on the zoom factor and the map's on-screen width,
    // so they (and the labels) are recomputed only when one of those changes — never on a pure pan
    const dotEls = [...svg.querySelectorAll('circle.dot')];
    // each hit circle stops at half the distance to its nearest neighbouring dot, so neighbours
    // never overlap and a tap always goes to the closest small place
    const hitEls = [...svg.querySelectorAll('circle.dot-hit')].map(c => ({ c, x: +c.getAttribute('cx'), y: +c.getAttribute('cy'), max: Infinity }));
    for (const a of hitEls) for (const b of hitEls) if (a !== b) a.max = Math.min(a.max, Math.hypot(a.x - b.x, a.y - b.y) / 2);
    const HIT_PX = 11;                                       // hit-circle radius in CSS px (~22 px across)
    const pat = svg.querySelector('pattern#want-' + mapKey);
    const patBg = pat.querySelector('.want-bg'), patLine = pat.querySelector('.want-line');
    function sizeMarks() {
      const r = 3.2 / Math.sqrt(k);
      const rs = r.toFixed(2);
      for (const c of dotEls) c.setAttribute('r', rs);
      const s = scale();
      if (s > 0) for (const h of hitEls) h.c.setAttribute('r', Math.max(r, Math.min(HIT_PX / s, h.max)).toFixed(2));
      // Want to go stripes keep their on-screen size at every zoom
      const p = (6 / k).toFixed(3), lw = (2 / k).toFixed(3), lx = (1 / k).toFixed(3);
      pat.setAttribute('width', p); pat.setAttribute('height', p);
      patBg.setAttribute('width', p); patBg.setAttribute('height', p);
      patLine.setAttribute('x1', lx); patLine.setAttribute('x2', lx); patLine.setAttribute('y2', p);
      patLine.setAttribute('stroke-width', lw);
    }
    function apply(nx, ny, nw) {
      nw = clamp(nw, W / MAXK, W); const nh = nw * H / W;
      nx = clamp(nx, 0, W - nw); ny = clamp(ny, 0, H - nh);
      const prevK = k;
      vb = { x: nx, y: ny, w: nw, h: nh }; k = W / nw;
      svg.setAttribute('viewBox', `${nx} ${ny} ${nw} ${nh}`);
      if (k !== prevK) {
        svg.classList.toggle('zoomed', k > 1.001);
        btnReset.disabled = k <= 1.001; btnIn.disabled = k >= MAXK - 0.001; btnOut.disabled = k <= 1.001;
        sizeMarks();
        layoutLabels();
      }
      for (const fn of view.onView) { try { fn(vb, k); } catch (err) { setTimeout(() => { throw err; }, 0); } }
      if (k !== prevK) emit('zoom', { map: mapKey, k, vb });
    }
    // pointer moves are coalesced to one view update per animation frame
    let rafId = 0, pending = null;
    function flush() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } if (pending) { const p = pending; pending = null; apply(p[0], p[1], p[2]); } }
    function schedule(nx, ny, nw) {
      pending = [nx, ny, nw];
      if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; flush(); });
    }
    function set(nx, ny, nw) { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } pending = null; apply(nx, ny, nw); }
    function scale() { return svg.getBoundingClientRect().width / vb.w; }
    window.addEventListener('resize', () => { sizeMarks(); layoutLabels(); });
    sizeMarks();
    function toSvg(cx, cy) { const rct = svg.getBoundingClientRect(); const s = rct.width / vb.w; return [vb.x + (cx - rct.left) / s, vb.y + (cy - rct.top) / s]; }
    function zoomAt(f, px, py) {
      const nw = clamp(vb.w / f, W / MAXK, W); const real = vb.w / nw;
      set(px - (px - vb.x) / real, py - (py - vb.y) / real, nw);
    }
    btnIn.addEventListener('click', () => zoomAt(1.7, vb.x + vb.w / 2, vb.y + vb.h / 2));
    btnOut.addEventListener('click', () => zoomAt(1 / 1.7, vb.x + vb.w / 2, vb.y + vb.h / 2));
    btnReset.addEventListener('click', () => set(0, 0, W));

    // wheel / trackpad: zooms the map. Once the map is fully zoomed out, scrolling down passes through to the page.
    svg.addEventListener('wheel', e => {
      const pinch = e.ctrlKey || e.metaKey;
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= 400;
      if (dy > 0 && k <= 1.001 && !pinch) return;           // let the page scroll
      e.preventDefault();
      const f = Math.exp(-dy * (pinch ? 0.012 : 0.0035));
      const [px, py] = toSvg(e.clientX, e.clientY);
      zoomAt(f, px, py);
    }, { passive: false });

    // pointer: drag to pan, tap/click to toggle, two-finger pinch
    const pts = new Map();
    let drag = null, pinch = null;
    svg.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        // a touch/pen pointer jitters more than a mouse, so it needs a bigger move before it counts as a drag
        drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, vx: vb.x, vy: vb.y, moved: false, target: e.target, slop: e.pointerType === 'mouse' ? 4 : 10, s: 0 };
        try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      } else if (pts.size === 2) {
        drag = null;
        const [a, b] = [...pts.values()];
        pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), w0: vb.w, mid: toSvg((a.x + b.x) / 2, (a.y + b.y) / 2) };
      }
    });
    svg.addEventListener('pointermove', e => {
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const nw = clamp(pinch.w0 * (pinch.d0 / Math.max(d, 1)), W / MAXK, W);
        const real = vb.w / nw;
        schedule(pinch.mid[0] - (pinch.mid[0] - vb.x) / real, pinch.mid[1] - (pinch.mid[1] - vb.y) / real, nw);
        return;
      }
      if (drag && e.pointerId === drag.id) {
        const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
        if (!drag.moved && Math.hypot(dx, dy) > drag.slop) { drag.moved = true; drag.s = scale(); svg.classList.add('dragging'); hideTip(); }
        if (drag.moved) schedule(drag.vx - dx / drag.s, drag.vy - dy / drag.s, vb.w);
      } else if (e.pointerType === 'mouse') {
        if (runHooks(view.onHover, e)) return;
        const id = e.target && e.target.dataset ? e.target.dataset.id : null;
        if (id) showTip(id, e.clientX, e.clientY); else hideTip();
      }
    });
    function endPointer(e) {
      flush();                                   // apply the last move before the gesture ends
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (drag && e.pointerId === drag.id) {
        if (!drag.moved && e.type === 'pointerup' && !runHooks(view.onTap, e)) {
          const id = drag.target && drag.target.dataset ? drag.target.dataset.id : null;
          if (id) { tapPlace(id); if (e.pointerType === 'mouse') showTip(id, e.clientX, e.clientY); }
        }
        drag = null; svg.classList.remove('dragging');
      }
    }
    svg.addEventListener('pointerup', endPointer);
    svg.addEventListener('pointercancel', endPointer);
    svg.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hideTip(); });

    Object.assign(view, { set, zoomAt, layoutLabels, sizeMarks, scale, toSvg });
    Object.defineProperties(view, {
      k: { get: () => k, enumerable: true },
      vb: { get: () => Object.assign({}, vb), enumerable: true },
    });
    return view;
  }

  const viewNA = makeInteractive(svgNA, NA.w, NA.h, 'na');
  const viewWorld = makeInteractive(svgWorld, WORLD.w, WORLD.h, 'world');
  const views = { na: viewNA, world: viewWorld };

  // ---------- map style: flat colors / real map / module styles ----------
  const STYLE_KEY = 'travel-atlas:style';
  const styleSeg = $('#style-seg');
  let terrainAttached = false, curStyle = 'flat';
  function wireStyleButton(b) { b.addEventListener('click', () => setStyle(b.dataset.style, true)); }
  // Flat and Real are drawn here; a module style (e.g. Ratings) owns its own body class.
  function setStyle(mode, remember) {
    if (!styleSeg.querySelector(`button[data-style="${CSS.escape(String(mode))}"]`)) mode = 'flat';
    const real = mode === 'real';
    if (real && !terrainAttached) { for (const [img, uri] of terrainImgs) img.setAttribute('href', uri); terrainAttached = true; }
    document.body.classList.toggle('real', real);
    styleSeg.querySelectorAll('button[data-style]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.style === mode)));
    if (real) { viewNA.layoutLabels(); viewWorld.layoutLabels(); }
    if (remember) LS_SAFE.set(STYLE_KEY, mode);
    const changed = mode !== curStyle;
    curStyle = mode;
    if (changed) emit('style', { style: mode });
  }
  styleSeg.querySelectorAll('button[data-style]').forEach(wireStyleButton);
  setStyle(LS_SAFE.get(STYLE_KEY) === 'real' ? 'real' : 'flat', false);
  function addStyle(o) {
    const id = String((o && (o.id || o.style)) || '').trim();
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(id) || id === 'flat' || id === 'real') return null;
    let b = styleSeg.querySelector(`button[data-style="${id}"]`);
    if (b) return b;
    b = document.createElement('button');
    b.type = 'button'; b.dataset.style = id; b.setAttribute('aria-pressed', 'false');
    if (o.icon) b.innerHTML = String(o.icon);
    b.appendChild(document.createTextNode(o.label || id));
    styleSeg.appendChild(b);
    wireStyleButton(b);
    return b;
  }
  function addLegend(mapKey, ...extra) {
    const base = $('#legend-' + mapKey); if (!base) return false;
    let after = base;
    for (const n of extra) {
      if (!n || n.nodeType !== 1) continue;
      if (n.classList.contains('legend') || after !== base) { after.after(n); after = n; }
      else base.appendChild(n);
    }
    return true;
  }

  function flashPlace(id) {
    const p = places.get(id); if (!p) return;
    const v = views[p.map];
    const first = (nodes.get(id) || []).find(n => n.tagName === 'path') || (nodes.get(id) || [])[0];
    if (!first) return;
    v.svg.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const b = first.getBBox();
    if (v.k > 1.001) {
      // keep the current zoom, center on it
      v.set(b.x + b.width / 2 - v.W / v.k / 2, b.y + b.height / 2 - v.H / v.k / 2, v.W / v.k);
    }
    for (const n of nodes.get(id)) { n.classList.remove('flash'); void n.getBBox(); n.classList.add('flash'); setTimeout(() => n.classList.remove('flash'), 1000); }
  }

  // ---------- search ----------
  const q = $('#q'), results = $('#results');
  const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const ALIASES = { 'US-DC': 'washington dc district of columbia', USA: 'usa america', GBR: 'uk britain england scotland wales', ARE: 'uae dubai', CZE: 'czech republic', KOR: 'korea', PRK: 'korea', COD: 'congo kinshasa', COG: 'congo brazzaville', MMR: 'burma', SWZ: 'swaziland', TLS: 'east timor', CIV: 'ivory coast', 'CA-QC': 'quebec', 'CA-NL': 'newfoundland labrador', 'US-VIR': 'usvi', NLD: 'holland', VAT: 'vatican holy see', MKD: 'macedonia', TUR: 'turkiye' };
  const index = [...places.values()].map(p => ({ p, key: norm(p.name + ' ' + (ALIASES[p.id] || '')) }));
  const searchSources = [];
  const SOURCE_MAX = 6, RESULTS_MAX = 10;
  let active = -1;
  const rowsByLi = new WeakMap();
  // combobox semantics: #q owns the #results listbox; the highlighted option is aria-activedescendant
  function showResults(open) {
    results.hidden = !open;
    q.setAttribute('aria-expanded', String(open));
    if (!open) q.removeAttribute('aria-activedescendant');
  }
  // three states: filled check (been), striped ring (want), empty
  function optionLabel(li) {
    const row = rowsByLi.get(li); if (!row) return;
    const s = statusOf(row.id);
    li.classList.toggle('on', s === 1);
    li.classList.toggle('want', s === 2);
    li.setAttribute('aria-checked', String(s === 1));
    li.setAttribute('aria-label', `${row.label}, ${STATUS_WORD[s] || 'not marked'}`);
  }
  function refreshResults() { for (const li of results.querySelectorAll('li[data-id]')) optionLabel(li); }
  function setActive(i, items) {
    active = i;
    items.forEach((li, j) => { const on = j === active; li.classList.toggle('active', on); li.setAttribute('aria-selected', String(on)); });
    if (items[active]) { q.setAttribute('aria-activedescendant', items[active].id); items[active].scrollIntoView({ block: 'nearest' }); }
    else q.removeAttribute('aria-activedescendant');
  }
  function emptyRow(text) {
    const li = document.createElement('li'); li.className = 'empty'; li.setAttribute('role', 'option'); li.setAttribute('aria-disabled', 'true'); li.textContent = text;
    results.appendChild(li);
  }
  function renderResults() {
    const raw = q.value.trim(), v = norm(raw);
    results.innerHTML = ''; active = -1; q.removeAttribute('aria-activedescendant');
    if (!v) { showResults(false); return; }
    // One ranking across places and source rows (cities): match class first (exact > prefix >
    // word-prefix > substring), then countries before states/provinces before cities, then name
    // (places) or the source's own order (cities by rank). At most 6 source rows, 10 in all.
    const KIND_RANK = { country: 0, other: 1, state: 1, dc: 1, territory: 1, province: 1 };
    const mc = (key, q) => (key === q ? 0 : key.startsWith(q) ? 1 : key.includes(' ' + q) ? 2 : key.includes(q) ? 3 : 4);
    const rows = [];
    for (const e of index) {
      if (!e.key.includes(v)) continue;
      const where = (KIND_LABEL[e.p.kind] || '') + ' · ' + MAP_LABEL[e.p.map];
      rows.push({ id: e.p.id, name: e.p.name, where, label: `${e.p.name}, ${where}`,
        cls: Math.min(mc(norm(e.p.name), v), mc(e.key, v)), kr: KIND_RANK[e.p.kind] ?? 1, src: false, ord: 0 });
    }
    const notes = [], seen = new Set(rows.map(r => r.id));
    let ord = 0;
    for (const src of searchSources) {
      let got = [];
      try { got = src(raw, v) || []; } catch (err) { setTimeout(() => { throw err; }, 0); }
      for (const r of got) {
        if (!r) continue;
        if (r.empty || !r.id) { if (r.note) notes.push(String(r.note)); continue; }
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const cls = Number.isInteger(r.cls) ? r.cls : mc(norm(r.name || ''), v);
        rows.push(Object.assign({}, r, { cls: Math.min(cls, 3), kr: r.kind === 'city' || /^C-/.test(r.id) ? 2 : 1, src: true, ord: ord++ }));
      }
    }
    rows.sort((a, b) => a.cls - b.cls || a.kr - b.kr || (a.src || b.src ? a.ord - b.ord : a.name.localeCompare(b.name)));
    const shown = [];
    let nSrc = 0;
    for (const r of rows) {
      if (shown.length >= RESULTS_MAX) break;
      if (r.src) { if (nSrc >= SOURCE_MAX) continue; nSrc++; }
      shown.push(r);
    }
    if (!shown.length) { emptyRow(notes[0] || 'No place matches that.'); showResults(true); return; }
    shown.forEach((row, i) => {
      const li = document.createElement('li');
      li.id = 'result-' + i; li.dataset.id = row.id;
      li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false');
      li.innerHTML = `<span class="check" aria-hidden="true"></span><span class="name"></span><span class="where"></span>`;
      $('.name', li).textContent = row.name;
      $('.where', li).textContent = row.where || '';
      rowsByLi.set(li, { id: row.id, label: row.label || `${row.name}, ${row.where || ''}` });
      optionLabel(li);
      li.addEventListener('click', () => {
        if (typeof row.pick === 'function') row.pick(row);
        else { tapPlace(row.id); flashPlace(row.id); }
        optionLabel(li);
      });
      results.appendChild(li);
    });
    for (const n of notes) emptyRow(n);
    showResults(true);
  }
  q.addEventListener('input', renderResults);
  q.addEventListener('focus', renderResults);
  q.addEventListener('keydown', e => {
    const items = [...results.querySelectorAll('li:not(.empty)')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!items.length) return;
      setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length, items);
    } else if (e.key === 'Enter') {
      e.preventDefault(); const li = items[active >= 0 ? active : 0]; if (li) li.click();
    } else if (e.key === 'Escape') { showResults(false); q.blur(); }
  });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.search')) showResults(false); });

  // ---------- persistence ----------
  // Marks live in this browser's storage on this device first (js/store.js, travel-atlas:v2).
  // Backup (code or file) carries them elsewhere; Share (opt-in) keeps a copy on the sync server
  // so other devices can view or edit it.
  const BACKUP_MIN = 5, BACKUP_MAX_AGE = 30 * 24 * 3600 * 1000, SYNC_FRESH = 30 * 24 * 3600 * 1000;
  const statusEl = $('#status'), owner = $('#owner');
  const STATUS = {
    saved: ['saved', 'Saved on this device', 'Your marks are kept in this browser on this device. Use Backup to move them to another phone or computer.'],
    remind: ['unsaved', 'Back up your marks', 'Your marks are kept only in this browser on this device. Copy a backup code or download a backup file so you don’t lose them.'],
    error: ['error', 'Can’t save here — use Backup', 'This browser isn’t letting the page store anything (private browsing or blocked site data), so marks will be lost when it closes. Copy a backup code or download a backup file.'],
    synced: ['synced', 'Synced', 'Your marks are saved on this device and kept in step with your shared map.'],
    syncing: ['saving', 'Syncing…', 'Your marks are saved on this device and are being sent to your shared map.'],
    offline: ['offline', 'Offline · will sync', 'Your marks are saved on this device. They will sync with your shared map when you’re back online.'],
    retry: ['offline', 'Sync paused · will retry', 'Your marks are saved on this device. The sync server didn’t answer, so the app will try again shortly.'],
    reset: ['stopped', 'Edit access was reset — this device stopped syncing', 'Edit access to the shared map was reset on another device. Your marks are still here. Scan the new code from Share on that device to sync again.'],
    deleted: ['stopped', 'This shared map was deleted', 'The shared copy of this map was deleted, so this device stopped syncing. Your marks are still here.'],
  };
  let canSave = true, statusKey = '';
  function setPill(s) {
    const [ds, text, title] = STATUS[s];
    statusKey = s;
    statusEl.dataset.state = ds; statusEl.textContent = text; statusEl.title = title;
    if (s === 'remind' || s === 'reset' || s === 'deleted') { statusEl.setAttribute('role', 'button'); statusEl.tabIndex = 0; }
    else { statusEl.removeAttribute('role'); statusEl.removeAttribute('tabindex'); }
  }
  const markCount = () => (store ? store.ids(1).length + store.ids(2).length : 0);
  function backupDue() {
    if (markCount() < BACKUP_MIN) return false;
    const t = +(LS_SAFE.get(BACKUP_KEY) || 0);
    return !t || Date.now() - t > BACKUP_MAX_AGE;
  }
  // the error state wins; otherwise nudge for a backup once there's something worth keeping
  // Linked devices show the sync state instead; they skip the reminder while they've synced in the last 30 days.
  function refreshStatus() {
    if (viewOnly) return;
    if (link) {
      const fresh = link.synced && Date.now() - link.synced < SYNC_FRESH;
      setPill(!fresh && backupDue() ? 'remind' : syncState);
    } else if (unlinkReason) setPill(unlinkReason);
    else setPill(!canSave ? 'error' : backupDue() ? 'remind' : 'saved');
  }
  function setSyncState(s) { syncState = s; refreshStatus(); }
  function markBackedUp() { LS_SAFE.set(BACKUP_KEY, String(Date.now())); refreshStatus(); }
  // can this browser store anything? Probed on a scratch key so stored marks are never touched.
  function probeStorage() {
    try { const k = 'travel-atlas:probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch (_) { return false; }
  }
  // ask the browser not to evict our storage — once, after the first mark, best-effort
  let persistAsked = false;
  function askPersist() {
    if (persistAsked || !markCount()) return;
    persistAsked = true;
    try {
      const s = navigator.storage;
      if (s && typeof s.persist === 'function') {
        Promise.resolve(typeof s.persisted === 'function' ? s.persisted() : false)
          .then(already => already || s.persist()).catch(() => {});
      }
    } catch (_) {}
  }

  function ownerName() { return owner.textContent.replace(/\s+/g, ' ').trim().slice(0, 40); }
  function pageTitle() { const n = ownerName(); return n ? `${n}’s Travel Atlas` : 'Travel Atlas'; }
  function syncTitle() { document.title = pageTitle(); }

  // Every change to the store lands here: local edits, sync results, other tabs, restores.
  const LOCAL_SOURCES = new Set(['local', 'restore', 'undo']);
  function onStoreChange(info) {
    if (viewOnly) return;
    canSave = store.saveOk;
    if (info.ids) { for (const id of info.ids) paint(id); updateCounters(); } else paintAll();
    refreshResults();
    if (info.owner && !editingOwner()) owner.textContent = store.getOwner();
    syncTitle();
    if (LOCAL_SOURCES.has(info.source)) {
      LS_SAFE.set(LS_T, String(Date.now()));
      askPersist();
      if (link) { setSyncState(navigator.onLine === false ? 'offline' : 'syncing'); scheduleSync(1000); }
    } else {
      undoRestore = null;                        // an undo would now overwrite changes made elsewhere
    }
    if (dlg.open) codeOut.value = store.makeCode();
    refreshStatus();
    emit('change', { ids: info.ids ? info.ids.slice() : null, source: info.source, owner: !!info.owner });
  }
  if (store) {
    store.onChange(onStoreChange);
    owner.textContent = store.getOwner();
  }
  paintAll();
  syncTitle();
  canSave = probeStorage() && (!store || store.saveOk);
  refreshStatus();

  // ---------- whose atlas ----------
  owner.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); owner.blur(); } });
  let ownerAtFocus = '';                     // the text when editing started
  const editingOwner = () => document.activeElement === owner;
  function commitOwner() {
    if (!store || viewOnly) return;
    const n = ownerName();
    if (n !== ownerAtFocus) { ownerAtFocus = n; store.setOwner(n); }
  }
  owner.addEventListener('focus', () => { ownerAtFocus = ownerName(); });
  owner.addEventListener('blur', () => {
    if (!store || viewOnly) return;
    const n = ownerName();
    if (n !== ownerAtFocus) { if (owner.textContent !== n) owner.textContent = n; ownerAtFocus = n; store.setOwner(n); }
    else owner.textContent = store.getOwner();     // untouched: show the stored name (it may have synced meanwhile)
    syncTitle();
  });
  owner.addEventListener('paste', e => { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text').replace(/\n/g, ' ')); });

  // Every toggle, restore and committed name is saved the moment it happens, so leaving the page only
  // saves a name that is still being typed.
  function saveIfUnsaved() { if (editingOwner()) commitOwner(); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveIfUnsaved(); else onWake(); });
  window.addEventListener('pagehide', saveIfUnsaved);

  // ---------- backup & restore ----------
  // Code atlas2:b=…;w=… (map only); file atlas2 JSON (map, notes, ratings, years). atlas1 still restores.
  const dlg = $('#backup'), codeOut = $('#code-out'), codeIn = $('#code-in'), copyNote = $('#copy-note'), restoreNote = $('#restore-note');
  const fileIn = $('#restore-file-input'), replaceBox = $('#restore-replace');
  function note(elm, text, cls) { elm.textContent = text; elm.className = elm.className.replace(/\b(ok|err)\b/g, '').trim() + (cls ? ' ' + cls : ''); }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const isKnown = () => AS.makeIsKnown(id => places.has(id), !!atlasApi.citiesLoaded);
  let undoRestore = null;                   // the store snapshot from just before the last Replace
  // one restore path for the pasted code and a backup file
  function applyRestore(parsed, emptyMsg, badMsg) {
    if (!store || viewOnly) return false;
    if (!parsed) { note(restoreNote, emptyMsg, 'err'); return false; }
    if (!Object.keys(parsed.places).length) { note(restoreNote, badMsg, 'err'); return false; }   // never Replace with nothing
    const replace = replaceBox.checked;
    undoRestore = null;
    const r = store.restore(parsed, { replace });
    codeOut.value = store.makeCode();
    const extra = parsed.unknown ? ` (${plural(parsed.unknown, 'unrecognized entry', 'unrecognized entries')} skipped)` : '';
    if (replace) {
      undoRestore = r.snapshot;
      note(restoreNote, `Replaced with ${plural(r.total, 'place', 'places')}${extra} · `, 'ok');
      const u = document.createElement('button');
      u.type = 'button'; u.className = 'undo'; u.textContent = 'Undo';
      u.addEventListener('click', undoReplace);
      restoreNote.appendChild(u);
    } else {
      const notes = r.notesAdded ? ` and ${plural(r.notesAdded, 'note', 'notes')}` : '';
      note(restoreNote, `Added ${plural(r.added, 'new place', 'new places')}${notes}${extra}.`, 'ok');
    }
    return true;
  }
  function undoReplace() {
    const snap = undoRestore; if (!snap || !store) return;
    undoRestore = null;
    store.undo(snap);
    codeOut.value = store.makeCode();
    note(restoreNote, `Undone. Your previous ${plural(markCount(), 'place is', 'places are')} back.`, 'ok');
  }
  function openBackup() {
    if (!store || viewOnly) return;
    codeOut.value = store.makeCode(); codeIn.value = ''; note(copyNote, ''); note(restoreNote, '');
    replaceBox.checked = false; undoRestore = null;          // "Replace" never carries over from last time
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
    codeOut.focus(); codeOut.select();
  }
  $('#backup-btn').addEventListener('click', openBackup);
  // the "Back up your marks" pill opens the Backup dialog
  function pillAction() { if (statusKey === 'reset' || statusKey === 'deleted') openShare(); else openBackup(); }
  statusEl.addEventListener('click', () => { if (statusEl.getAttribute('role') === 'button') pillAction(); });
  statusEl.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && statusEl.getAttribute('role') === 'button') { e.preventDefault(); pillAction(); }
  });
  $('#copy-code').addEventListener('click', async () => {
    codeOut.focus(); codeOut.select();
    let ok = false;
    try { await navigator.clipboard.writeText(codeOut.value); ok = true; } catch (_) { try { ok = document.execCommand('copy'); } catch (_) {} }
    if (ok) markBackedUp();
    note(copyNote, ok ? 'Copied. Keep it somewhere safe.' : 'Couldn’t copy automatically — select the code and copy it yourself.', ok ? 'ok' : 'err');
  });
  $('#restore-code').addEventListener('click', () => {
    if (!store) return;
    applyRestore(store.parseBackup(codeIn.value, { isKnown: isKnown() }), 'Paste a backup code first.', 'That doesn’t look like a backup code from this page.');
  });

  // download a backup file (atlas2: map, notes, ratings and years)
  $('#download-backup').addEventListener('click', () => {
    if (!store) return;
    const name = AS.backupFileName(new Date());
    const data = store.makeFile(ownerName());
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = name; a.hidden = true;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      markBackedUp();
      note(copyNote, `Downloaded ${name}. Keep it somewhere safe.`, 'ok');
    } catch (_) {
      note(copyNote, 'Couldn’t download here — copy the code instead.', 'err');
    }
  });

  // restore from a backup file: atlas2 / atlas1 JSON, or a text file holding a code
  $('#restore-file').addEventListener('click', () => { fileIn.value = ''; fileIn.click(); });
  fileIn.addEventListener('change', () => {
    const f = fileIn.files && fileIn.files[0]; if (!f || !store) return;
    const reader = new FileReader();
    reader.onload = () => {
      applyRestore(store.parseBackup(String(reader.result || ''), { isKnown: isKnown() }), 'That file is empty.', 'That file doesn’t look like a Travel Atlas backup.');
    };
    reader.onerror = () => note(restoreNote, 'Couldn’t read that file.', 'err');
    reader.readAsText(f);
  });
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  // ---------- other tabs / windows ----------
  // Another tab, window or the installed app changed the stored atlas: re-read it instead of
  // keeping (and later re-saving) a stale copy.
  window.addEventListener('storage', e => {
    if (e.storageArea && e.storageArea !== localStorage) return;
    if (viewOnly || !store) return;                        // viewing someone else's map: this device's marks don't apply
    if (e.key === LINK_KEY || e.key === null) {            // another tab linked, unlinked, re-keyed or synced
      const was = link; link = readLink();
      if (!link) { clearTimeout(syncTimer); syncTimer = 0; }
      else if (!was || was.id !== link.id || was.editKey !== link.editKey) { unlinkReason = null; scheduleSync(0); }
      refreshStatus();
      if (shareDlg.open) renderShare();
      if (e.key === LINK_KEY) return;
    }
    if (e.key === BACKUP_KEY) { refreshStatus(); return; }
    if (e.key !== null && e.key !== V2_KEY) return;
    store.reload();                                        // emits 'reload' when something visible changed
    canSave = probeStorage();
    refreshStatus();
  });

  // ---------- sync with a shared map (opt-in; see docs/SYNC.md) ----------
  // Every request goes to this site's own /api (same origin). 10 s timeout. Never throws:
  // status 0 means offline / network error / timeout.
  async function api(method, path, body, key) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, 10000);
    try {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (key) headers.Authorization = 'Bearer ' + key;
      const res = await fetch('./api/' + path, {
        method, headers, cache: 'no-store', credentials: 'omit',
        body: body === undefined ? undefined : JSON.stringify(body), signal: ctl ? ctl.signal : undefined,
      });
      let data = null;
      if (res.status !== 204) { try { data = await res.json(); } catch (_) {} }
      return { status: res.status, ok: res.ok, data };
    } catch (_) {
      return { status: 0, ok: false, data: null };
    } finally { clearTimeout(timer); }
  }
  const mapPath = id => 'maps/' + encodeURIComponent(id);
  const isRev = v => Number.isSafeInteger(v) && v >= 0;
  function logDropped(data) {
    if (data && data.dropped > 0) console.info(`Travel Atlas: the sync server skipped ${data.dropped} unknown place id(s).`);
  }
  // fields of a sync/GET response that go into travel-atlas:link
  function linkFields(data, l) {
    const o = { name: (data && data.name) || l.name };
    if (data && Object.prototype.hasOwnProperty.call(data, 'notesToken')) o.notesToken = typeof data.notesToken === 'string' ? data.notesToken : null;
    return o;
  }

  // One sync: send dirty entries in chunks (≤ 1000 places / 200 notes / ~100 KB each), ack each,
  // adopt what the server has that this device hasn't seen (since = link.rev).
  // No link.rev means a full send (first link, after the v2 upgrade, after pairing). A full send
  // that gets interrupted keeps its progress in link.full = {rev, done} and resumes from there;
  // link.rev is written only once every full chunk is through.
  const MAX_ROUNDS = 40;
  let syncTimer = 0, syncBusy = false, syncAgain = false, retryDelay = 0;
  function scheduleSync(ms) {
    if (!link || viewOnly) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, ms || 0);
  }
  async function runSync() {
    syncTimer = 0;
    if (!link || viewOnly || !store) return;
    if (syncBusy) { syncAgain = true; return; }
    if (navigator.onLine === false) { setSyncState('offline'); return; }   // 'online' brings us back
    const sent = link;
    const same = () => !!link && link.id === sent.id && link.editKey === sent.editKey;
    syncBusy = true; setSyncState('syncing');
    const full = !isRev(sent.rev);
    const prog = full && sent.full && isRev(sent.full.rev) && Number.isSafeInteger(sent.full.done) ? sent.full : null;
    let cursor = full ? (prog ? prog.rev : null) : sent.rev;
    let done = prog ? prog.done : 0;
    let queue = full ? store.outgoing({ full: true }).slice(done) : store.outgoing({});
    let fullLeft = full ? queue.length : 0;
    if (!queue.length) queue = store.outgoing({});          // always at least one request (a poll)
    let r = null, rounds = 0, failed = false;
    while (queue.length && rounds < MAX_ROUNDS) {
      const chunk = queue.shift(); rounds++;
      if (cursor !== null) chunk.since = cursor; else delete chunk.since;
      r = await api('POST', mapPath(sent.id) + '/sync', chunk, sent.editKey);
      if (!same()) break;
      if (!(r.ok && r.data && r.data.places)) { failed = true; break; }
      store.ack(chunk, r.data);
      logDropped(r.data);
      if (isRev(r.data.rev)) cursor = r.data.rev;
      const upd = linkFields(r.data, link);
      if (fullLeft > 0) {
        fullLeft--; done++;
        if (fullLeft === 0) { upd.rev = cursor; upd.full = undefined; }
        else upd.full = { rev: cursor, done };
      } else if (!full || fullLeft === 0) upd.rev = cursor;
      link = Object.assign({}, link, upd);
      if (link.full === undefined) delete link.full;
      writeLink(link);
      if (!queue.length && store.isDirty() && rounds < MAX_ROUNDS) queue = store.outgoing({});   // edits made meanwhile
    }
    syncBusy = false;
    const again = syncAgain; syncAgain = false;
    if (!same()) { if (link) scheduleSync(0); return; }
    if (!failed && r) {
      retryDelay = 0;
      link = Object.assign({}, link, { synced: Date.now() });
      writeLink(link);
      setSyncState('synced');
      if (again || store.isDirty() || !isRev(link.rev)) scheduleSync(1000);
      if (shareDlg.open) renderShare();
    } else if (r && r.status === 401) {
      unlink('reset');
    } else if (r && r.status === 404) {
      unlink('deleted');
    } else {                                          // offline, timeout, 429, 503, 5xx: keep working locally, retry later
      retryDelay = Math.min(60000, retryDelay ? retryDelay * 2 : 5000);
      setSyncState(!r || r.status === 0 ? 'offline' : 'retry');
      scheduleSync(again ? 1000 : retryDelay);
    }
  }
  // Stop syncing on this device. Marks (and notes) stay here.
  function unlink(reason) {
    link = null; writeLink(null);
    clearTimeout(syncTimer); syncTimer = 0; retryDelay = 0;
    unlinkReason = reason || null;
    if (/^\/map\//.test(location.pathname)) history.replaceState(null, '', '/');
    refreshStatus();
    if (shareDlg.open) { renderShare(); if (reason) note(shareNote, STATUS[reason][1] + '.', 'err'); }
  }
  // The notes view link (Share dialog: the "Map with notes" row): on / off / reset. Other devices learn the token from sync.
  async function notesLink(action) {
    if (!link || viewOnly || !['on', 'off', 'reset'].includes(action)) return { ok: false, status: 0, notesToken: link ? link.notesToken || null : null };
    const l = link;
    const r = await api('POST', mapPath(l.id) + '/notes-link', { action }, l.editKey);
    if (r.ok && r.data && (typeof r.data.notesToken === 'string' || r.data.notesToken === null)) {
      if (link && link.id === l.id) { link = Object.assign({}, link, { notesToken: r.data.notesToken }); writeLink(link); }
      return { ok: true, status: r.status, notesToken: r.data.notesToken };
    }
    if (r.status === 401) unlink('reset');
    else if (r.status === 404) unlink('deleted');
    return { ok: false, status: r.status, notesToken: link ? link.notesToken || null : null };
  }

  // ---------- one-line notes ----------
  const noteBar = $('#note-bar'), noteText = $('#note-text');
  function showNote(msg) { noteText.textContent = msg; noteBar.hidden = false; }
  $('#note-close').addEventListener('click', () => { noteBar.hidden = true; });

  // ---------- view pages: /map/<id> (map only) and /map/<id>#notes=<token> (map with notes) ----------
  const viewBanner = $('#view-banner');
  let viewId = null, viewLoaded = false, viewBusy = false, notesToken = null, notesFailed = false;
  function viewMessage(parts, err, sub) {
    viewBanner.innerHTML = '';
    viewBanner.classList.toggle('err', !!err);
    const line = document.createElement('span');
    for (const p of parts) line.append(p);
    viewBanner.appendChild(line);
    if (sub) { const s = document.createElement('p'); s.className = 'banner-sub'; s.textContent = sub; viewBanner.appendChild(s); }
    viewBanner.hidden = false;
  }
  function ownLink() { const a = document.createElement('a'); a.href = './'; a.textContent = 'Make your own atlas'; return a; }
  function setViewMode(m) {
    viewMode = m;
    document.body.classList.toggle('view-notes', m === 'notes');
    emit('view', { mode: m });
  }
  function enterViewMode(id, token) {
    viewOnly = true; viewId = id; viewLoaded = false;
    notesToken = token || null; notesFailed = false;
    clearTimeout(syncTimer); syncTimer = 0;
    document.body.classList.add('view-only');
    setViewMode(notesToken ? 'notes' : 'plain');
    owner.contentEditable = 'false';
    for (const a of ['role', 'aria-label', 'title', 'tabindex']) owner.removeAttribute(a);
    owner.textContent = '';
    $('.masthead .sub').textContent = 'Someone shared their Travel Atlas with you. Look around and zoom in; only they can change it.';
    $('#backup-btn').hidden = true; $('#share-btn').hidden = true; statusEl.hidden = true;
    for (const f of document.querySelectorAll('.frame')) f.classList.remove('mode-want');
    if (dlg.open) dlg.close();
    if (shareDlg.open) shareDlg.close();
    viewData.places.clear(); viewData.notes.clear();
    paintAll(); refreshResults(); syncTitle();
    viewMessage(['Loading shared map…']);
    loadView();
  }
  function applyView(data, withNotes) {
    viewData.places.clear(); viewData.notes.clear();
    for (const id in data.places || {}) {
      const e = data.places[id];
      if (AS.ID_RE.test(id) && Array.isArray(e) && (e[0] === 1 || e[0] === 2)) viewData.places.set(id, e[0]);
    }
    if (withNotes) for (const id in data.notes || {}) {
      const e = data.notes[id];
      if (!AS.ID_RE.test(id) || !Array.isArray(e)) continue;
      const n = { rating: e[0] | 0, year: e[1] | 0, note: typeof e[2] === 'string' ? e[2] : '' };
      if (n.rating || n.year || n.note) viewData.notes.set(id, n);
    }
    const who = String(data.owner || data.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    owner.textContent = who;
    syncTitle();
    const whose = (who ? who + '’s map' : 'Shared map') + (withNotes ? ' with notes' : '');
    viewMessage([whose + ' · view only · ', ownLink()], false, notesFailed ? 'This link no longer shows notes.' : '');
    paintAll(); refreshResults();
    viewLoaded = true;
    emit('change', { ids: null, source: 'view', owner: true });
  }
  async function loadView() {
    if (!viewId || viewBusy) return;
    viewBusy = true;
    let r, withNotes = false;
    if (viewMode === 'notes' && notesToken) {
      r = await api('GET', mapPath(viewId) + '/notes', undefined, notesToken);
      if (r.status === 401) {                    // turned off or reset: show the plain map instead
        notesFailed = true; notesToken = null; setViewMode('plain');
        r = await api('GET', mapPath(viewId));
      } else withNotes = true;
    } else r = await api('GET', mapPath(viewId));
    viewBusy = false;
    if (r.ok && r.data && r.data.places) {
      applyView(r.data, withNotes && !!r.data.notes);
    } else if (r.status === 404 || r.status === 400) {
      viewData.places.clear(); viewData.notes.clear();
      owner.textContent = ''; syncTitle(); paintAll(); refreshResults();
      viewLoaded = false;
      viewMessage(['Couldn’t load this map. The link may be wrong, or the map was deleted. · ', ownLink()], true);
      emit('change', { ids: null, source: 'view', owner: true });
    } else if (!viewLoaded) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn'; b.textContent = 'Try again';
      b.addEventListener('click', () => { viewMessage(['Loading shared map…']); loadView(); });
      viewMessage([navigator.onLine === false ? 'Couldn’t load this map — you’re offline. ' : 'Couldn’t load this map. Check your connection. ', b], true);
    }                                                // already showing it: keep the last copy quietly
  }

  // ---------- pairing: /map/<id>#edit=<key> ----------
  let pendingPair = null;
  function clearPending() { pendingPair = null; SS.set(null); }
  let pairBusy = false;
  async function pair(id, key) {
    if (pairBusy) return;
    pairBusy = true;
    try { await pairOnce(id, key); } finally { pairBusy = false; }
  }
  async function pairOnce(id, key) {
    pendingPair = { id, key };
    SS.set(pendingPair);
    // the key never stays in the address bar, even if the server can't be reached yet
    history.replaceState(null, '', '/map/' + encodeURIComponent(id));
    setPill('syncing');
    const r = await api('POST', mapPath(id) + '/sync', {}, key);   // checks the key, changes nothing
    if (r.status === 0 || r.status === 429 || r.status >= 500) {
      showNote('Couldn’t reach the sync server to add this device. It will try again when you’re online.');
      refreshStatus();
      return;                                         // kept in pendingPair; retried on online / visible
    }
    clearPending();
    if (r.ok && r.data && r.data.places) {
      const name = r.data.name || id;
      const cur = link;
      if (cur && cur.id !== id) {
        const ok = window.confirm(`This device already syncs with “${cur.name || cur.id}”.\n\nSwitch to “${name}”? The marks on this device will be replaced with that map’s marks.`);
        history.replaceState(null, '', '/');
        if (!ok) { showNote(`Kept syncing with “${cur.name || cur.id}”.`); refreshStatus(); return; }
        // switching maps: this device becomes exactly that map (nothing dirty), deltas from its rev
        link = Object.assign({ id, editKey: key, synced: Date.now() }, linkFields(r.data, { name }));
        if (isRev(r.data.rev)) link.rev = r.data.rev;
        writeLink(link); unlinkReason = null;
        store.replaceAll(r.data);
        setSyncState('synced');
        showNote(`This device now syncs with “${name}”.`);
        return;
      }
      // A device that isn't syncing yet: ask before its own marks go into someone's shared map.
      const n = markCount();
      if (!cur && (n || store.noteIds().length || ownerName())) {
        const what = n ? `your ${plural(n, 'place', 'places')}` : store.noteIds().length ? 'your notes' : 'your name';
        if (!window.confirm(`Add ${what} to “${name}”? Anyone with this map’s edit link can change them.`)) {
          enterViewMode(id);                          // nothing uploaded, no link stored
          return;
        }
      }
      // no rev: the first sync is a full send, so this device's marks merge into the shared map
      link = Object.assign({ id, editKey: key }, linkFields(r.data, { name }));
      writeLink(link); unlinkReason = null;
      history.replaceState(null, '', '/');
      showNote(`This device now syncs with “${name}”.` + (n ? ' The marks that were here have been added to it.' : ''));
      setSyncState('syncing');
      runSync();
      return;
    }
    // the key doesn't work (reset, or a bad link) or the map is gone
    history.replaceState(null, '', '/map/' + encodeURIComponent(id));
    if (link && link.id === id) { showNote('That edit link no longer works.'); refreshStatus(); scheduleSync(0); return; }
    enterViewMode(id);
    if (r.status === 401) showNote('That edit link no longer works (edit access was reset). You can still view the map.');
  }

  // ---------- import from the old address: /#import=<atlas1 code>&owner=&accent=&style= ----------
  function runImport(h) {
    const o = (h.get('owner') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const res = store.importCode(h.get('import') || '', { owner: o, isKnown: isKnown() });   // adds, never removes
    const a = h.get('accent');
    if (a && ACCENTS.includes(a) && LS_SAFE.get(ACCENT_KEY) === null) setAccent(a, true);
    const st = h.get('style');
    if ((st === 'flat' || st === 'real') && LS_SAFE.get(STYLE_KEY) === null) setStyle(st, true);
    history.replaceState(null, '', location.pathname + location.search);
    showNote(res.added ? `Brought over ${plural(res.added, 'place', 'places')} from your old Travel Atlas address.`
      : res.found ? 'Your marks from the old address were already here.' : 'Nothing to bring over from the old address.');
  }

  // ---------- Share dialog ----------
  const shareDlg = $('#share'), shareOff = $('#share-off'), shareOn = $('#share-on'), shareName = $('#share-name');
  const shareView = $('#share-view'), shareNote = $('#share-note'), shareCopyNote = $('#share-copy-note');
  const shareQR = $('#share-qr'), shareWarn = $('#share-edit-warn'), shareSub = $('#share-sub'), shareNative = $('#share-native');
  const shareButtons = [...shareDlg.querySelectorAll('.dlg-part .btn')];
  // the two view links: "Map only" (always) and "Map with notes" (the notes link, off by default)
  const notesSwitch = $('#share-notes-switch'), notesMsg = $('#share-notes-msg'), notesRow = $('#share-notes-row');
  const notesInput = $('#share-notes-url'), notesNote = $('#share-notes-note'), notesNative = $('#share-notes-native');
  const notesConfirm = $('#share-notes-confirm'), notesConfirmText = $('#share-notes-confirm-text');
  const notesYes = $('#share-notes-confirm-yes'), notesNo = $('#share-notes-confirm-no');
  let notesBusy = false, notesAsk = null;          // notesAsk: 'off' | 'reset' while the in-dialog confirm shows
  const viewUrl = l => location.origin + '/map/' + encodeURIComponent(l.id);
  const editUrl = l => viewUrl(l) + '#edit=' + l.editKey;
  const notesUrl = l => (l.notesToken ? viewUrl(l) + '#notes=' + l.notesToken : null);
  function shareBusy(on) { for (const b of shareButtons) b.disabled = on; notesSwitch.disabled = on; }
  function renderShare() {
    const on = !!link;
    shareOff.hidden = on; shareOn.hidden = !on;
    if (!on) { qrFor = ''; shareQR.innerHTML = ''; return; }
    shareSub.textContent = `This map syncs as “${link.name || link.id}”. Marks made on any device you add show up on the others. Share the view link with anyone; they can look but not change anything.`;
    shareView.value = viewUrl(link);
    shareNative.hidden = typeof navigator.share !== 'function';
    renderNotesLink();
    renderQR();
  }
  function notesMessage(text, cls) { note(notesMsg, text, cls); notesMsg.hidden = !text; }
  function renderNotesLink() {
    const url = link ? notesUrl(link) : null;
    notesSwitch.setAttribute('aria-checked', url ? 'true' : 'false');
    if (!url && notesAsk) hideNotesConfirm(false);     // turned off meanwhile (here or on another device)
    if (notesInput.value !== (url || '')) note(notesNote, '');
    notesInput.value = url || '';
    notesRow.hidden = !url;
    notesNative.hidden = typeof navigator.share !== 'function';
  }
  function showNotesConfirm(kind) {
    notesAsk = kind;
    notesConfirmText.textContent = kind === 'off'
      ? 'Turn off the notes link? Anyone who has it will only see the plain map. Turning it back on makes a new link.'
      : 'Reset the notes link? The old link stops showing notes, and you get a new one to share.';
    notesYes.textContent = kind === 'off' ? 'Turn off' : 'Reset';
    notesConfirm.hidden = false;
    notesNo.focus();
  }
  function hideNotesConfirm(refocus) {
    const kind = notesAsk;
    notesAsk = null; notesConfirm.hidden = true;
    if (refocus) (kind === 'reset' && !notesRow.hidden ? $('#share-notes-reset') : notesSwitch).focus();
  }
  function setNotesBusy(on) {
    notesBusy = on;
    notesSwitch.disabled = on; notesYes.disabled = on; notesNo.disabled = on;
    $('#share-notes-reset').disabled = on;
    notesSwitch.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  const NOTES_DONE = {
    on: ['Making the notes link…', 'Notes link made. Copy it to share.', 'Couldn’t make the notes link'],
    off: ['Turning off the notes link…', 'Notes link turned off. It now shows only the plain map.', 'Couldn’t turn off the notes link'],
    reset: ['Making a new notes link…', 'New notes link made. The old one no longer shows notes.', 'Couldn’t reset the notes link'],
  };
  async function runNotesLink(action) {
    if (!link || notesBusy) return;
    const [busyText, okText, failText] = NOTES_DONE[action];
    setNotesBusy(true); notesMessage(busyText);
    const r = await notesLink(action);
    setNotesBusy(false);
    if (r.ok) {
      hideNotesConfirm(false);
      renderShare();
      notesMessage(okText, 'ok');
      notesSwitch.focus();
    } else if (link) {
      notesMessage(errText(r, failText), 'err');      // nothing changed; the confirm stays for another try
    } else notesMessage('');                         // 401/404: unlink() already re-rendered and said why
  }
  function openShare() {
    if (viewOnly) return;
    note(shareNote, !link && unlinkReason ? STATUS[unlinkReason][1] + '.' : '', !link && unlinkReason ? 'err' : '');
    note(shareCopyNote, ''); note(notesNote, ''); notesMessage(''); shareWarn.hidden = true; shareBusy(false);
    hideNotesConfirm(false); setNotesBusy(notesBusy);
    if (!link) shareName.value = ownerName();
    if (typeof shareDlg.showModal === 'function') { if (!shareDlg.open) shareDlg.showModal(); } else shareDlg.setAttribute('open', '');
    renderShare();
    if (!link) shareName.focus();
  }
  $('#share-btn').addEventListener('click', openShare);
  // other editing devices learn the notes token on their next sync; keep an open dialog current
  on('change', () => { if (shareDlg.open && !viewOnly) renderShare(); });
  shareDlg.addEventListener('click', e => { if (e.target === shareDlg) shareDlg.close(); });
  shareName.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#share-create').click(); } });

  // QR code of the edit link, drawn on this device (vendored qrcode-generator, loaded on first use).
  // Always black modules on a white quiet zone so it scans in dark mode too.
  let qrLib = null, qrFor = '';
  function loadQRLib() {
    if (typeof window.qrcode === 'function') return Promise.resolve();
    if (!qrLib) qrLib = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = './js/vendor/qrcode.js';
      sc.onload = () => (typeof window.qrcode === 'function' ? res() : rej(new Error('qrcode missing')));
      sc.onerror = () => { qrLib = null; sc.remove(); rej(new Error('qrcode failed to load')); };
      document.head.appendChild(sc);
    });
    return qrLib;
  }
  function qrSvg(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text); qr.make();
    const n = qr.getModuleCount(), qz = 4, size = n + 2 * qz;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue;
        let w = 1; while (c + w < n && qr.isDark(r, c + w)) w++;
        d += `M${c + qz} ${r + qz}h${w}v1h${-w}z`;
        c += w - 1;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`;
  }
  async function renderQR() {
    if (!link) return;
    const url = editUrl(link);
    if (qrFor === url && shareQR.querySelector('svg')) return;
    qrFor = url;
    shareQR.textContent = 'Making code…';
    try { await loadQRLib(); } catch (_) {
      if (qrFor === url) { qrFor = ''; shareQR.textContent = 'Couldn’t make the code here. Use “Copy edit link instead”.'; }
      return;
    }
    if (!link || editUrl(link) !== url) return;
    shareQR.innerHTML = qrSvg(url);
  }

  async function copyText(text, input) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    let tmp = null;
    try {
      if (!input) {                                  // inside the modal dialog, so the selection is allowed
        tmp = document.createElement('textarea');
        tmp.value = text; tmp.setAttribute('readonly', ''); tmp.style.position = 'fixed'; tmp.style.opacity = '0';
        shareDlg.querySelector('form').appendChild(tmp);
        input = tmp;
      }
      input.focus(); input.select();
      return document.execCommand('copy');
    } catch (_) { return false; } finally { if (tmp) tmp.remove(); }
  }
  function errText(r, what) {
    if (r.status === 0) return what + '. Check your connection and try again.';
    if (r.status === 429) return what + '. Too many tries. Wait a minute and try again.';
    if (r.data && r.data.message) return what + ': ' + r.data.message;
    return what + '. Try again in a moment.';
  }

  $('#share-create').addEventListener('click', async () => {
    if (link) { renderShare(); return; }
    const name = shareName.value.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) { note(shareNote, 'Give the link a name first.', 'err'); shareName.focus(); return; }
    if (editingOwner()) commitOwner();
    shareBusy(true); note(shareNote, 'Creating link…');
    // the first chunk goes with the create; anything beyond it follows as a resumed full send
    const chunks = store.outgoing({ full: true }), c0 = chunks[0];
    const body = { name };
    if (c0.places) body.places = c0.places;
    if (c0.notes) body.notes = c0.notes;
    if (c0.owner) { body.owner = c0.owner[0]; body.ownerT = c0.owner[1]; }
    const r = await api('POST', 'maps', body);
    shareBusy(false);
    if (r.ok && r.data && r.data.id && r.data.editKey) {
      const m = r.data.map || null;
      link = { id: r.data.id, editKey: r.data.editKey, name: (m && m.name) || name, synced: Date.now(), notesToken: null };
      if (m && isRev(m.rev)) { if (chunks.length > 1) link.full = { rev: m.rev, done: 1 }; else link.rev = m.rev; }
      writeLink(link); unlinkReason = null; retryDelay = 0;
      if (m) { store.ack(c0, m); logDropped(m); }
      setSyncState('synced');
      renderShare();
      note(shareNote, 'Link created. This device now syncs with it.', 'ok');
      scheduleSync(0);                               // catches anything changed while the request was out
    } else {
      note(shareNote, errText(r, 'Couldn’t create the link'), 'err');
    }
  });
  $('#share-copy').addEventListener('click', async () => {
    if (!link) return;
    const ok = await copyText(viewUrl(link), shareView);
    note(shareCopyNote, ok ? 'Copied.' : 'Couldn’t copy automatically. Select the link and copy it.', ok ? 'ok' : 'err');
  });
  shareNative.addEventListener('click', () => {
    if (!link || typeof navigator.share !== 'function') return;
    Promise.resolve(navigator.share({ title: pageTitle(), url: viewUrl(link) })).catch(() => {});
  });
  notesSwitch.addEventListener('click', () => {
    if (!link || notesBusy) return;
    if (notesSwitch.getAttribute('aria-checked') === 'true') {
      if (notesAsk === 'off') hideNotesConfirm(true); else { notesMessage(''); showNotesConfirm('off'); }
    } else runNotesLink('on');
  });
  $('#share-notes-reset').addEventListener('click', () => {
    if (!link || notesBusy) return;
    notesMessage(''); showNotesConfirm('reset');
  });
  notesYes.addEventListener('click', () => { if (notesAsk) runNotesLink(notesAsk); });
  notesNo.addEventListener('click', () => { notesMessage(''); hideNotesConfirm(true); });
  $('#share-notes-copy').addEventListener('click', async () => {
    const url = link && notesUrl(link);
    if (!url) return;
    const ok = await copyText(url, notesInput);
    note(notesNote, ok ? 'Copied.' : 'Couldn’t copy automatically. Select the link and copy it.', ok ? 'ok' : 'err');
  });
  notesNative.addEventListener('click', () => {
    const url = link && notesUrl(link);
    if (!url || typeof navigator.share !== 'function') return;
    Promise.resolve(navigator.share({ title: pageTitle(), url })).catch(() => {});
  });
  $('#share-copy-edit').addEventListener('click', async () => {
    if (!link) return;
    shareWarn.hidden = false;
    const ok = await copyText(editUrl(link));
    note(shareNote, ok ? 'Edit link copied. Open it on your other device.' : 'Couldn’t copy automatically. Scan the QR code instead.', ok ? 'ok' : 'err');
  });
  $('#share-reset').addEventListener('click', async () => {
    if (!link) return;
    if (!window.confirm('Reset edit access?\n\nThe old edit link and QR code stop working. Your other devices stop syncing until you add them again with the new code.')) return;
    const l = link;
    shareBusy(true); note(shareNote, 'Resetting edit access…');
    const r = await api('POST', mapPath(l.id) + '/reset-key', {}, l.editKey);
    shareBusy(false);
    if (r.ok && r.data && r.data.editKey) {
      if (!link || link.id !== l.id) return;
      link = Object.assign({}, link, { editKey: r.data.editKey });
      writeLink(link);
      renderShare();
      note(shareNote, 'Edit access reset. Add your other devices again with the new code.', 'ok');
    } else if (r.status === 401) unlink('reset');
    else if (r.status === 404) unlink('deleted');
    else note(shareNote, errText(r, 'Couldn’t reset edit access'), 'err');
  });
  $('#share-stop').addEventListener('click', () => {
    if (!link) return;
    if (!window.confirm('Stop syncing on this device?\n\nYour marks stay here. The shared map and your other devices are not changed.')) return;
    unlink(null);
    renderShare();
    note(shareNote, 'This device no longer syncs. Your marks are still here.', 'ok');
  });
  $('#share-delete').addEventListener('click', async () => {
    if (!link) return;
    if (!window.confirm('Delete the shared map?\n\nThe copy on atlas.elijahpelton.com is removed, the view link stops working, and other devices stop syncing. Your marks stay on this device.')) return;
    const l = link;
    shareBusy(true); note(shareNote, 'Deleting…');
    const r = await api('DELETE', mapPath(l.id), undefined, l.editKey);
    shareBusy(false);
    if (r.ok || r.status === 404) {
      unlink(null); renderShare();
      note(shareNote, 'Shared map deleted. Your marks are still on this device.', 'ok');
    } else if (r.status === 401) unlink('reset');
    else note(shareNote, errText(r, 'Couldn’t delete the shared map'), 'err');
  });

  // ---------- sync triggers ----------
  // 1 s after a change, on startup, when back online, when the page becomes visible,
  // and every 60 s while visible.
  function onWake() {
    if (viewOnly) { loadView(); return; }
    if (pendingPair) { pair(pendingPair.id, pendingPair.key); return; }
    if (link) scheduleSync(0);
  }
  window.addEventListener('online', onWake);
  window.addEventListener('offline', () => { if (link && !viewOnly) setSyncState('offline'); });
  setInterval(() => { if (document.visibilityState === 'visible') onWake(); }, 60000);

  // The same links can arrive without a page load (same-document hash change, e.g. pasted into
  // the address bar of an open tab): handle them the same way.
  window.addEventListener('hashchange', () => {
    const r = parseRoute();
    if (r.editKey && r.mapId) { if (viewOnly) location.reload(); else pair(r.mapId, r.editKey); }
    else if (r.notes && r.mapId) location.reload();
    else if (r.imp && !viewOnly) runImport(r.imp);
  });

  // ---------- the seam: window.Atlas ----------
  let readyResolve;
  const readyP = new Promise(res => { readyResolve = res; });
  const atlasApi = {
    places, nodes, views,
    getStatus: id => statusOf(id),
    setStatus: setStatusApi,
    tap: (id, o) => tapPlace(id, o),
    ids: s => idsOf(+s),
    getInfo: id => infoOf(id),
    setInfo(id, patch) { if (viewOnly || !store) return false; return store.setNotes(id, patch); },
    getNotes: id => infoOf(id),
    setNotes(id, patch) { return atlasApi.setInfo(id, patch); },
    ownerName,
    get mode() { return markMode; },
    setMode,
    get viewMode() { return viewMode; },
    get style() { return curStyle; },
    getStyle: () => curStyle,
    setStyle,
    citiesLoaded: false,
    on, off, emit,
    toast, openDetails, flash: flashPlace,
    tip: showTip, hideTip,
    addSearchSource(fn) { if (typeof fn === 'function') searchSources.push(fn); },
    norm,
    addLayer(mapKey, fn) {
      const v = views[mapKey]; if (!v) return null;
      const g = el('g', { class: 'layer' });
      const dots = v.svg.querySelector('g.dots');
      dots.after(g);
      if (typeof fn === 'function') v.onView.push(fn);
      return g;
    },
    onTap(mapKey, fn) { const v = views[mapKey]; if (v && typeof fn === 'function') v.onTap.push(fn); },
    addStyle, addLegend,
    link: () => (link ? { id: link.id, name: link.name || '', notesToken: link.notesToken || null, viewUrl: viewUrl(link), notesUrl: notesUrl(link) } : null),
    notesLink,
    ready: readyP,
  };
  window.Atlas = atlasApi;
  isReady = true;
  readyResolve(atlasApi);
  emit('ready', atlasApi);
  for (const t of [window, document]) { try { t.dispatchEvent(new CustomEvent('atlas:ready', { detail: atlasApi })); } catch (_) {} }

  // ---------- startup ----------
  if (viewOnly) enterViewMode(route.mapId, route.notes);
  else if (route.editKey) pair(route.mapId, route.editKey);
  else {
    if (route.imp) runImport(route.imp);
    if (link) scheduleSync(0);
  }
})();
