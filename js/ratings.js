// Travel Atlas: "Ratings" map style (docs/plan-ux.md §2.3, copy §4, a11y §5).
// Classic script, loaded with <script defer> after app.js. Talks to the app only through
// window.Atlas (plan-ux §7). No inline styles: everything is classes from css/features.css.
//
// In Ratings: body.ratings (flat base, terrain and labels hidden by CSS); been places, dots and
// cities get .r1-.r5 from their rating or .unrated; want and unmarked stay plain. Each map
// section gets a .legend.legend-ratings and a .ratings-hint (shown by CSS only under body.ratings).
// The style is saved per device under the app's own key (travel-atlas:style = 'ratings').
// On a plain view link ratings are private, so the button is hidden and the map shows Flat.
(function () {
  'use strict';
  const STYLE_KEY = 'travel-atlas:style';
  const STYLE = 'ratings';
  const RAMP = ['r1', 'r2', 'r3', 'r4', 'r5'];
  const ALL = RAMP.concat('unrated');
  const MARK_SEL = 'svg.map :is(.place, .dot, .city)[data-id]';
  const ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><rect x="1.5" y="9" width="3" height="5" rx=".8" opacity=".35"/><rect x="6.5" y="6" width="3" height="8" rx=".8" opacity=".65"/><rect x="11.5" y="2.5" width="3" height="11.5" rx=".8"/></svg>';

  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };

  let A = null;          // window.Atlas
  let btn = null;        // the Ratings button in #style-seg
  let active = false;
  let wanted = false;    // the user picked Ratings (kept while it's unavailable on a plain view)
  let queued = 0;
  const parts = [];      // [{map, legend, hint}]

  // ---------- reading the core ----------
  function isBeen(id) {
    const s = A.getStatus(id);
    return s === 'been' || s === 1;
  }
  function ratingOf(id) {
    let info = null;
    try { info = A.getInfo(id); } catch (_) {}
    const r = info && Number(info.rating);
    return r >= 1 && r <= 5 ? Math.round(r) : 0;
  }
  function viewMode() {
    if (A && typeof A.viewMode === 'string') return A.viewMode;
    const b = document.body.classList;
    return b.contains('view-only') ? (b.contains('view-notes') ? 'notes' : 'plain') : 'own';
  }
  const available = () => viewMode() !== 'plain';

  // ---------- paint ----------
  function paintNode(n, cls) {
    for (const c of ALL) if (c !== cls && n.classList.contains(c)) n.classList.remove(c);
    if (cls && !n.classList.contains(cls)) n.classList.add(cls);
  }
  function paint() {
    queued = 0;
    if (!A) return;
    const cache = new Map();
    const rated = { na: false, world: false };
    const classOf = id => {
      if (cache.has(id)) return cache.get(id);
      let cls = null;
      if (isBeen(id)) { const r = ratingOf(id); cls = r ? RAMP[r - 1] : 'unrated'; }
      cache.set(id, cls);
      return cls;
    };
    if (active) {
      for (const n of document.querySelectorAll(MARK_SEL)) paintNode(n, classOf(n.dataset.id));
    }
    // the hint depends on the data, not on what's drawn: any rated been place of that map
    const ids = A.places && typeof A.places.keys === 'function' ? A.places.keys() : [];
    for (const id of ids) {
      const p = A.places.get(id);
      if (!p || rated[p.map] || !isBeen(id)) continue;
      if (ratingOf(id)) rated[p.map] = true;
    }
    for (const pt of parts) pt.hint.hidden = rated[pt.map];
  }
  function schedule() {
    if (queued || !active) return;
    queued = requestAnimationFrame(paint);
  }

  // ---------- legend + hint ----------
  function buildLegend(section, map) {
    const base = section.querySelector('.legend:not(.legend-ratings)');
    if (!base || section.querySelector('.legend-ratings')) return;
    const lg = document.createElement('div');
    lg.className = 'legend legend-ratings';
    const ramp = document.createElement('span');
    ramp.className = 'ramp';
    ramp.setAttribute('role', 'img');
    ramp.setAttribute('aria-label', 'Been there, by rating: 1 star lightest to 5 stars darkest');
    for (let r = 1; r <= 5; r++) {
      const s = document.createElement('span');
      s.innerHTML = `<i class="r${r}"></i><span class="num">${r} ★</span>`;
      ramp.appendChild(s);
    }
    lg.appendChild(ramp);
    for (const [cls, text] of [['unrated', 'Been, no rating'], ['', 'Not been or want to go']]) {
      const s = document.createElement('span');
      const i = document.createElement('i');
      if (cls) i.className = cls;
      s.appendChild(i);
      s.appendChild(document.createTextNode(text));
      lg.appendChild(s);
    }
    const hint = document.createElement('p');
    hint.className = 'ratings-hint';
    hint.textContent = 'Rate places from the lists below to color this map.';
    hint.hidden = true;
    let added = false;
    if (typeof A.addLegend === 'function') {
      try { added = A.addLegend(map, lg, hint) !== false && lg.isConnected; } catch (_) {}
    }
    if (!added) { base.after(lg); lg.after(hint); }
    if (!hint.isConnected) lg.after(hint);
    parts.push({ map, legend: lg, hint });
  }

  // ---------- the style seg ----------
  function pressed(style) {
    for (const b of document.querySelectorAll('#style-seg button[data-style]')) {
      b.setAttribute('aria-pressed', String(b.dataset.style === style));
    }
  }
  function enter() {
    if (active) return;
    active = true;
    document.body.classList.add('ratings');
    paint();
  }
  function leave() {
    if (!active) return;
    active = false;
    document.body.classList.remove('ratings');
    if (queued) { cancelAnimationFrame(queued); queued = 0; }
  }
  // the core switches styles; we follow its 'style' event (or our own click in the fallback path)
  function onStyle(style) {
    wanted = style === STYLE;
    if (wanted && available()) enter(); else leave();
  }
  function choose(remember) {
    wanted = true;
    if (typeof A.setStyle === 'function') { A.setStyle(STYLE, remember); if (!active) onStyle(STYLE); return; }
    // fallback for a core without setStyle: let it go flat (drops body.real), then take over
    const flat = document.querySelector('#style-seg button[data-style="flat"]');
    if (flat && document.body.classList.contains('real')) flat.click();
    if (remember) LS.set(STYLE_KEY, STYLE);
    pressed(STYLE);
    enter();
  }
  function addButton() {
    const seg = document.getElementById('style-seg');
    if (!seg) return null;
    let b = seg.querySelector('button[data-style="ratings"]');
    if (!b && typeof A.addStyle === 'function') {
      try { b = A.addStyle({ id: STYLE, style: STYLE, label: 'Ratings', icon: ICON }) || null; } catch (_) { b = null; }
      if (!(b instanceof Element)) b = seg.querySelector('button[data-style="ratings"]');
    }
    if (!b) {
      b = document.createElement('button');
      b.type = 'button';
      b.dataset.style = STYLE;
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = ICON + 'Ratings';
      seg.appendChild(b);
      b.addEventListener('click', () => { if (!active) choose(true); });
      // other buttons: leave Ratings (the core handles its own styles and the saved key)
      for (const o of seg.querySelectorAll('button[data-style]')) {
        if (o !== b) o.addEventListener('click', () => { wanted = false; leave(); });
      }
    }
    return b;
  }
  function syncAvailability() {
    const ok = available();
    // .seg button sets display, so [hidden] alone wouldn't hide it: take it out of the seg instead
    if (btn) {
      btn.hidden = !ok;
      const seg = document.getElementById('style-seg');
      if (!ok && btn.isConnected) btn.remove();
      else if (ok && !btn.isConnected && seg) seg.appendChild(btn);
    }
    if (!ok && active) {
      leave();
      // show Flat without overwriting this device's saved choice
      if (typeof A.setStyle === 'function') A.setStyle('flat', false); else pressed('flat');
    } else if (ok && wanted && !active) {
      if (typeof A.setStyle === 'function') A.setStyle(STYLE, false);
      pressed(STYLE);
      enter();
    }
  }

  // ---------- boot ----------
  function boot(atlas) {
    if (A) return;
    A = atlas;
    for (const map of ['na', 'world']) {
      const sec = document.getElementById('sec-' + map);
      if (sec) buildLegend(sec, map);
    }
    btn = addButton();
    if (typeof A.on === 'function') {
      A.on('change', () => { if (active) schedule(); });
      A.on('style', s => onStyle(typeof s === 'string' ? s : (s && (s.style || s.name || s.mode))));
      for (const e of ['zoom', 'cities', 'view', 'mode']) { try { A.on(e, () => { syncAvailability(); schedule(); }); } catch (_) {} }
    }
    // view pages decide plain/notes after the shared map loads: follow body class changes too
    new MutationObserver(syncAvailability).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const cur = typeof A.style === 'string' ? A.style : (typeof A.getStyle === 'function' ? A.getStyle() : null);
    if (cur === STYLE || LS.get(STYLE_KEY) === STYLE) {
      wanted = true;
      if (available()) {
        if (cur !== STYLE && typeof A.setStyle === 'function') A.setStyle(STYLE, false);
        pressed(STYLE);
        enter();
      }
    }
    syncAvailability();
  }

  // app.js builds the maps asynchronously; window.Atlas appears when it's done
  function tryBoot() { if (window.Atlas && !A) { boot(window.Atlas); return true; } return !!A; }
  if (!tryBoot()) {
    const go = () => { tryBoot(); };
    window.addEventListener('atlas:ready', go);
    document.addEventListener('atlas:ready', go);
    let tries = 0;
    const poll = setInterval(() => { if (tryBoot() || ++tries > 600) clearInterval(poll); }, 50);
  }
})();
