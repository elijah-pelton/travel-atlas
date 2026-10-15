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

  // ---------- registry ----------
  const places = new Map();        // id -> {id, name, kind, map}
  const nodes = new Map();         // id -> [svg elements]
  const state = new Set();         // visited ids
  const KIND_LABEL = { state: 'U.S. state', dc: 'Federal district', territory: 'U.S. territory', province: 'Canada', country: 'Country', other: 'Territory' };
  const MAP_LABEL = { na: 'U.S. & Canada', world: 'World' };

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

  function buildNA() {
    const svg = el('svg', { viewBox: `0 0 ${NA.w} ${NA.h}`, class: 'map', 'data-map': 'na', role: 'group', 'aria-label': 'Map of the United States and Canada' });
    const defs = el('defs', {}, svg);
    el('rect', { class: 'water', x: 0, y: 0, width: NA.w, height: NA.mainH }, svg);
    terrain(svg, TERRAIN.na, { x: 0, y: 0, width: NA.w, height: NA.mainH });
    el('path', { class: 'ctx', d: NA.context }, svg);
    const g = el('g', { class: 'places' }, svg);
    const labels = el('g', { class: 'labels', 'data-size': 11 }, svg);
    const dots = el('g', { class: 'dots' }, svg);
    for (const r of NA.places) {
      const p = el('path', { class: 'place', d: r.d, 'data-kind': r.kind }, g);
      register(r, 'na', p);
      if (r.dot) { const c = el('circle', { class: 'dot', cx: r.dot[0], cy: r.dot[1], r: 3.2 }, dots); register(r, 'na', c); }
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
        if (r.dot) { const c = el('circle', { class: 'dot', cx: r.dot[0], cy: r.dot[1], r: 3.2 }, ig); register(r, 'na', c); }
      }
    });
    return svg;
  }

  function buildWorld() {
    const svg = el('svg', { viewBox: `0 0 ${WORLD.w} ${WORLD.h}`, class: 'map', 'data-map': 'world', role: 'group', 'aria-label': 'Map of the world' });
    const defs = el('defs', {}, svg);
    const cp = el('clipPath', { id: 'clip-sphere' }, defs);
    el('path', { d: WORLD.sphere }, cp);
    el('path', { class: 'sphere', d: WORLD.sphere }, svg);
    terrain(svg, TERRAIN.world, { x: 0, y: 0, width: WORLD.w, height: WORLD.h, 'clip-path': 'url(#clip-sphere)' });
    const g = el('g', { class: 'places' }, svg);
    const labels = el('g', { class: 'labels', 'data-size': 10 }, svg);
    const dots = el('g', { class: 'dots' }, svg);
    for (const r of WORLD.places) {
      const p = el('path', { class: 'place', d: r.d, 'data-kind': r.kind }, g);
      register(r, 'world', p);
      if (r.dot) { const c = el('circle', { class: 'dot', cx: r.dot[0], cy: r.dot[1], r: 3.2 }, dots); register(r, 'world', c); }
      if (r.id !== 'ATA') label(labels, r);
    }
    // the sphere outline sits on top so the terrain has a crisp edge
    el('path', { class: 'sphere', d: WORLD.sphere, style: 'fill:none', 'pointer-events': 'none' }, svg);
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
        if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const w = reg.installing; if (!w) return;
          w.addEventListener('statechange', () => {
            if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w);
          });
        });
      }).catch(() => {});
    };
    if (document.readyState === 'complete') registerSW(); else window.addEventListener('load', registerSW);
  }

  // ---------- load map data ----------
  const loadingEls = [...document.querySelectorAll('.frame-loading')];
  try {
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
    tile.innerHTML = `<div class="num"><span class="n">0</span><small>/ ${gr.ids.length}</small></div><div class="label">${gr.label}</div><div class="bar"><i></i></div>`;
    $('#stats-' + gr.map).appendChild(tile);
    gr.tile = tile;
  }
  function updateCounters() {
    for (const gr of GROUPS) {
      const n = gr.ids.reduce((a, id) => a + (state.has(id) ? 1 : 0), 0);
      $('.n', gr.tile).textContent = n;
      $('.bar i', gr.tile).style.width = (gr.ids.length ? (100 * n / gr.ids.length) : 0) + '%';
    }
    for (const m of ['na', 'world']) renderList(m);
  }
  function renderList(map) {
    const host = $('#list-' + map);
    const names = [...state].map(id => places.get(id)).filter(p => p && p.map === map).sort((a, b) => a.name.localeCompare(b.name));
    if (!names.length) { host.innerHTML = '<span class="none">Nothing marked here yet.</span>'; return; }
    host.innerHTML = `<span class="lead">Been there (${names.length}):</span><span class="chips"></span>`;
    const chips = $('.chips', host);
    for (const p of names) {
      const b = document.createElement('button');
      b.className = 'chip'; b.type = 'button'; b.title = 'Clear ' + p.name;
      b.innerHTML = `<span></span><span class="x">×</span>`;
      b.firstChild.textContent = p.name;
      b.addEventListener('click', () => toggle(p.id));
      chips.appendChild(b);
    }
  }

  // ---------- state rendering ----------
  function paint(id) {
    const on = state.has(id);
    for (const n of nodes.get(id) || []) n.classList.toggle('on', on);
  }
  function paintAll() { for (const id of nodes.keys()) paint(id); updateCounters(); }

  function toggle(id, opts) {
    const on = !state.has(id);
    if (on) state.add(id); else state.delete(id);
    paint(id); updateCounters(); persist(id, on);
    const p = places.get(id);
    if (p && !(opts && opts.quiet)) toast(p.map, on ? `${p.name} — been there` : `${p.name} — cleared`);
    return on;
  }

  // ---------- toast / tooltip ----------
  const toastTimers = {};
  function toast(map, msg) {
    const t = $('#toast-' + map); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimers[map]); toastTimers[map] = setTimeout(() => t.classList.remove('show'), 1400);
  }
  const tip = $('#tip');
  function showTip(id, x, y) {
    const p = places.get(id); if (!p) return;
    tip.innerHTML = '';
    tip.append(document.createTextNode(p.name));
    const k = document.createElement('span'); k.className = 'k'; k.textContent = state.has(id) ? 'been there' : KIND_LABEL[p.kind] || ''; tip.appendChild(k);
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

  // ---------- zoom / pan / click ----------
  function makeInteractive(svg, W, H, mapKey) {
    const frame = svg.parentElement;
    let vb = { x: 0, y: 0, w: W, h: H }, k = 1;
    const MAXK = 10;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
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
    function set(nx, ny, nw) {
      nw = clamp(nw, W / MAXK, W); const nh = nw * H / W;
      nx = clamp(nx, 0, W - nw); ny = clamp(ny, 0, H - nh);
      vb = { x: nx, y: ny, w: nw, h: nh }; k = W / nw;
      svg.setAttribute('viewBox', `${nx} ${ny} ${nw} ${nh}`);
      svg.classList.toggle('zoomed', k > 1.001);
      btnReset.disabled = k <= 1.001; btnIn.disabled = k >= MAXK - 0.001; btnOut.disabled = k <= 1.001;
      const r = 3.2 / Math.sqrt(k);
      svg.querySelectorAll('circle.dot').forEach(c => c.setAttribute('r', r.toFixed(2)));
      layoutLabels();
    }
    function scale() { return svg.getBoundingClientRect().width / vb.w; }
    window.addEventListener('resize', layoutLabels);
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
        drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, vx: vb.x, vy: vb.y, moved: false, target: e.target };
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
        set(pinch.mid[0] - (pinch.mid[0] - vb.x) / real, pinch.mid[1] - (pinch.mid[1] - vb.y) / real, nw);
        return;
      }
      if (drag && e.pointerId === drag.id) {
        const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
        if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; svg.classList.add('dragging'); hideTip(); }
        if (drag.moved) { const s = scale(); set(drag.vx - dx / s, drag.vy - dy / s, vb.w); }
      } else if (e.pointerType === 'mouse') {
        const id = e.target && e.target.dataset ? e.target.dataset.id : null;
        if (id) showTip(id, e.clientX, e.clientY); else hideTip();
      }
    });
    function endPointer(e) {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (drag && e.pointerId === drag.id) {
        if (!drag.moved && e.type === 'pointerup') {
          const id = drag.target && drag.target.dataset ? drag.target.dataset.id : null;
          if (id) { toggle(id); if (e.pointerType === 'mouse') showTip(id, e.clientX, e.clientY); }
        }
        drag = null; svg.classList.remove('dragging');
      }
    }
    svg.addEventListener('pointerup', endPointer);
    svg.addEventListener('pointercancel', endPointer);
    svg.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hideTip(); });

    return { set, zoomAt, layoutLabels, get k() { return k; }, W, H, svg };
  }

  const viewNA = makeInteractive(svgNA, NA.w, NA.h, 'na');
  const viewWorld = makeInteractive(svgWorld, WORLD.w, WORLD.h, 'world');
  const views = { na: viewNA, world: viewWorld };

  // ---------- map style: flat colors / real map ----------
  const STYLE_KEY = 'travel-atlas:style';
  let terrainAttached = false;
  function setStyle(mode, remember) {
    const real = mode === 'real';
    if (real && !terrainAttached) { for (const [img, uri] of terrainImgs) img.setAttribute('href', uri); terrainAttached = true; }
    document.body.classList.toggle('real', real);
    document.querySelectorAll('#style-seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.style === mode)));
    if (real) { viewNA.layoutLabels(); viewWorld.layoutLabels(); }
    if (remember) { try { localStorage.setItem(STYLE_KEY, mode); } catch (_) {} }
  }
  document.querySelectorAll('#style-seg button').forEach(b => b.addEventListener('click', () => setStyle(b.dataset.style, true)));
  let savedStyle = 'flat';
  try { savedStyle = localStorage.getItem(STYLE_KEY) || 'flat'; } catch (_) {}
  setStyle(savedStyle === 'real' ? 'real' : 'flat', false);

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
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const ALIASES = { 'US-DC': 'washington dc district of columbia', USA: 'usa america', GBR: 'uk britain england scotland wales', ARE: 'uae dubai', CZE: 'czech republic', KOR: 'korea', PRK: 'korea', COD: 'congo kinshasa', COG: 'congo brazzaville', MMR: 'burma', SWZ: 'swaziland', TLS: 'east timor', CIV: 'ivory coast', 'CA-QC': 'quebec', 'CA-NL': 'newfoundland labrador', 'US-VIR': 'usvi', NLD: 'holland', VAT: 'vatican holy see', MKD: 'macedonia', TUR: 'turkiye' };
  const index = [...places.values()].map(p => ({ p, key: norm(p.name + ' ' + (ALIASES[p.id] || '')) }));
  let active = -1, shown = [];
  function renderResults() {
    const v = norm(q.value.trim());
    results.innerHTML = ''; active = -1;
    if (!v) { results.hidden = true; return; }
    shown = index.filter(e => e.key.includes(v)).sort((a, b) => (a.key.startsWith(v) ? 0 : 1) - (b.key.startsWith(v) ? 0 : 1) || a.p.name.localeCompare(b.p.name)).slice(0, 10).map(e => e.p);
    if (!shown.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No place matches that.'; results.appendChild(li); results.hidden = false; return; }
    for (const p of shown) {
      const li = document.createElement('li');
      li.className = state.has(p.id) ? 'on' : '';
      li.innerHTML = `<span class="check"></span><span class="name"></span><span class="where"></span>`;
      $('.name', li).textContent = p.name;
      $('.where', li).textContent = (KIND_LABEL[p.kind] || '') + ' · ' + MAP_LABEL[p.map];
      li.addEventListener('click', () => { toggle(p.id); li.classList.toggle('on', state.has(p.id)); flashPlace(p.id); });
      results.appendChild(li);
    }
    results.hidden = false;
  }
  q.addEventListener('input', renderResults);
  q.addEventListener('focus', renderResults);
  q.addEventListener('keydown', e => {
    const items = [...results.querySelectorAll('li:not(.empty)')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.classList.toggle('active', i === active));
    } else if (e.key === 'Enter') {
      e.preventDefault(); const li = items[active >= 0 ? active : 0]; if (li) li.click();
    } else if (e.key === 'Escape') { results.hidden = true; q.blur(); }
  });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.search')) results.hidden = true; });

  // ---------- persistence ----------
  // Marks live in this browser's storage on this device. Backup (code or file) carries them elsewhere.
  const LS_KEY = 'travel-atlas:v1', LS_T = 'travel-atlas:t', OWNER_KEY = 'travel-atlas:owner';
  const statusEl = $('#status'), owner = $('#owner');
  const STATUS = {
    saved: ['Saved on this device', 'Your marks are kept in this browser on this device. Use Backup to move them to another phone or computer.'],
    error: ['Can’t save here — use Backup', 'This browser isn’t letting the page store anything (private browsing or blocked site data), so marks will be lost when it closes. Copy a backup code or download a backup file.'],
  };
  function setStatus(s) { statusEl.dataset.state = s; statusEl.textContent = STATUS[s][0]; statusEl.title = STATUS[s][1]; }

  let lastChange = 0;                       // ms timestamp of the newest change
  function readLocal() {
    try {
      const o = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      return { v: Object.keys(o).filter(id => o[id] && places.has(id)), owner: localStorage.getItem(OWNER_KEY) || '', t: +(localStorage.getItem(LS_T) || 0) };
    } catch (_) { return { v: [], owner: '', t: 0 }; }
  }
  function saveLocal() {
    try {
      const o = {}; for (const id of state) o[id] = true;
      localStorage.setItem(LS_KEY, JSON.stringify(o)); localStorage.setItem(LS_T, String(lastChange));
      const n = ownerName(); if (n) localStorage.setItem(OWNER_KEY, n); else localStorage.removeItem(OWNER_KEY);
      setStatus('saved');
      return true;
    } catch (_) { setStatus('error'); return false; }
  }
  // ask the browser not to evict our storage — once, after the first mark, best-effort
  let persistAsked = false;
  function askPersist() {
    if (persistAsked || !state.size) return;
    persistAsked = true;
    try {
      const s = navigator.storage;
      if (s && typeof s.persist === 'function') {
        Promise.resolve(typeof s.persisted === 'function' ? s.persisted() : false)
          .then(already => already || s.persist()).catch(() => {});
      }
    } catch (_) {}
  }
  function applySnapshot(snap) {
    state.clear(); for (const id of snap.v) state.add(id);
    owner.textContent = snap.owner || '';
    lastChange = snap.t || 0;
  }

  function ownerName() { return owner.textContent.replace(/\s+/g, ' ').trim().slice(0, 40); }
  function pageTitle() { const n = ownerName(); return n ? `${n}’s Travel Atlas` : 'Travel Atlas'; }
  function syncTitle() { document.title = pageTitle(); }

  applySnapshot(readLocal());
  paintAll();
  syncTitle();
  saveLocal();                              // also tells us whether this browser lets us save at all

  function markDirty() {
    lastChange = Date.now();
    if (saveLocal()) askPersist();
    syncTitle();
  }
  function persist() { markDirty(); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveLocal(); });
  window.addEventListener('pagehide', () => { saveLocal(); });

  // ---------- whose atlas ----------
  owner.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); owner.blur(); } });
  let ownerWas = ownerName();
  owner.addEventListener('focus', () => { ownerWas = ownerName(); });
  owner.addEventListener('blur', () => { const n = ownerName(); if (owner.textContent !== n) owner.textContent = n; if (n !== ownerWas) { ownerWas = n; markDirty(); } });
  owner.addEventListener('paste', e => { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text').replace(/\n/g, ' ')); });

  // ---------- backup & restore ----------
  const dlg = $('#backup'), codeOut = $('#code-out'), codeIn = $('#code-in'), copyNote = $('#copy-note'), restoreNote = $('#restore-note');
  const fileIn = $('#restore-file-input');
  const CODE_PREFIX = 'atlas1:';
  function makeCode() { return CODE_PREFIX + [...state].sort().join(','); }
  function parseCode(s) {
    s = (s || '').trim();
    if (!s) return null;
    if (s.startsWith(CODE_PREFIX)) s = s.slice(CODE_PREFIX.length);
    const ids = s.split(/[\s,;]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
    const known = ids.filter(id => places.has(id));
    return { ids: known, unknown: ids.length - known.length };
  }
  function note(elm, text, cls) { elm.textContent = text; elm.className = elm.className.replace(/\b(ok|err)\b/g, '').trim() + (cls ? ' ' + cls : ''); }
  // one restore path for both the pasted code and a backup file
  function applyRestore(parsed, emptyMsg) {
    if (!parsed) { note(restoreNote, emptyMsg, 'err'); return false; }
    if (!parsed.ids.length) { note(restoreNote, 'That doesn’t look like a backup code from this page.', 'err'); return false; }
    const replace = $('#restore-replace').checked;
    if (replace) state.clear();
    let added = 0;
    for (const id of parsed.ids) { if (!state.has(id)) { state.add(id); added++; } }
    paintAll(); markDirty();
    codeOut.value = makeCode();
    const extra = parsed.unknown ? ` (${parsed.unknown} unrecognized ${parsed.unknown === 1 ? 'entry' : 'entries'} skipped)` : '';
    note(restoreNote, replace ? `Restored ${parsed.ids.length} ${parsed.ids.length === 1 ? 'place' : 'places'}${extra}.` : `Added ${added} new ${added === 1 ? 'place' : 'places'}${extra}.`, 'ok');
    return true;
  }
  $('#backup-btn').addEventListener('click', () => {
    codeOut.value = makeCode(); codeIn.value = ''; note(copyNote, ''); note(restoreNote, '');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    codeOut.focus(); codeOut.select();
  });
  $('#copy-code').addEventListener('click', async () => {
    codeOut.focus(); codeOut.select();
    let ok = false;
    try { await navigator.clipboard.writeText(codeOut.value); ok = true; } catch (_) { try { ok = document.execCommand('copy'); } catch (_) {} }
    note(copyNote, ok ? 'Copied. Keep it somewhere safe.' : 'Couldn’t copy automatically — select the code and copy it yourself.', ok ? 'ok' : 'err');
  });
  $('#restore-code').addEventListener('click', () => { applyRestore(parseCode(codeIn.value), 'Paste a backup code first.'); });

  // download a backup file
  $('#download-backup').addEventListener('click', () => {
    const now = new Date(), pad = n => String(n).padStart(2, '0');
    const name = `travel-atlas-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
    const data = { format: 'atlas1', owner: ownerName(), marks: [...state].sort(), savedAt: now.toISOString() };
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = name; a.hidden = true;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      note(copyNote, `Downloaded ${name}. Keep it somewhere safe.`, 'ok');
    } catch (_) {
      note(copyNote, 'Couldn’t download here — copy the code instead.', 'err');
    }
  });

  // restore from a backup file: our JSON, or a text file holding an atlas1: code
  function parseBackupFile(text) {
    text = String(text || '').replace(/^﻿/, '').trim();
    if (!text) return null;
    if (text[0] === '{') {
      try {
        const o = JSON.parse(text);
        const list = Array.isArray(o.marks) ? o.marks : Array.isArray(o.v) ? o.v : null;
        if (list) {
          const parsed = parseCode(list.map(String).join(',')) || { ids: [], unknown: 0 };
          parsed.owner = typeof o.owner === 'string' ? o.owner : '';
          return parsed;
        }
      } catch (_) {}
    }
    const at = text.indexOf(CODE_PREFIX);
    return parseCode(at >= 0 ? text.slice(at) : text);
  }
  $('#restore-file').addEventListener('click', () => { fileIn.value = ''; fileIn.click(); });
  fileIn.addEventListener('change', () => {
    const f = fileIn.files && fileIn.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseBackupFile(reader.result);
      if (parsed && !parsed.ids.length) { note(restoreNote, 'That file doesn’t look like a Travel Atlas backup.', 'err'); return; }
      const ok = applyRestore(parsed, 'That file is empty.');
      if (ok && parsed.owner && !ownerName()) {
        owner.textContent = parsed.owner.replace(/\s+/g, ' ').trim().slice(0, 40);
        ownerWas = ownerName(); markDirty();
      }
    };
    reader.onerror = () => note(restoreNote, 'Couldn’t read that file.', 'err');
    reader.readAsText(f);
  });
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
})();
