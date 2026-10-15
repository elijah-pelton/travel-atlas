// Travel Atlas: "Browse as a list" under each map. Find and mark places (and their cities) from an
// expandable list instead of the map.
// Classic script, loaded with <script defer> after cities.js. Talks to the core only through
// window.Atlas (see the seam comment at the top of js/app.js) and to the cities module through
// window.AtlasCities (load(), loaded, the 'cities' event; city records live in Atlas.places).
//
// Per map: <details class="browse"> (collapsed) with a filter box, a polite live region and one
// <details class="browse-group"> per group. Rows are built only for open groups, so the 3,320
// cities cost nothing until a place is expanded. A 'change' event only updates rows already on
// screen (pressed state, badges, counts), never rebuilds them, so scroll and open state stay put.
//   U.S. & Canada: U.S. states / D.C. & territories / Canadian provinces & territories;
//                  each row expands to its cities (by their NA state id).
//   World:         one group per continent (data/regions.json, tools/make-regions.py), countries
//                  first, then "Territories & other places"; each row expands to its cities.
// Marking a city Been there also marks its state/province and country if they are unmarked: the
// same rule js/cities.js applies on the map (its tapCity is internal, so it is repeated here).
(function () {
  'use strict';

  const REGIONS_URL = './data/regions.json';
  const NA_GROUPS = [
    { key: 'states', label: 'U.S. states', kinds: ['state'] },
    { key: 'dc', label: 'D.C. & territories', kinds: ['dc', 'territory'] },
    { key: 'provinces', label: 'Canadian provinces & territories', kinds: ['province'] },
  ];
  const MAP_NAME = { na: 'U.S. & Canada', world: 'World' };
  const NOTE_GLYPH = '✎';
  const SEE_NA = new Set(['USA', 'CAN']);       // their cities live in the U.S. & Canada list
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let A = null;
  let regions = null, regionsP = null;           // {Africa: [ids], ...} once loaded
  let cityIdx = null;                            // {na: Map parent -> [ids], world: Map, key: Map id -> norm name}
  let uid = 0;
  const lists = {};

  // ---------- small helpers ----------
  const S_OF = { none: 0, been: 1, want: 2 };
  function st(id) { const s = A.getStatus(id); return typeof s === 'number' ? s : S_OF[s] || 0; }
  function nameOf(id) { const p = A.places.get(id); return p ? p.name : id; }
  function vm() { return A.viewMode || 'own'; }
  function norm(s) { return typeof A.norm === 'function' ? A.norm(String(s || '')).trim() : String(s || '').toLowerCase().trim(); }
  const coll = typeof Intl !== 'undefined' && Intl.Collator ? new Intl.Collator(undefined, { sensitivity: 'base' }) : null;
  const byName = (a, b) => (coll ? coll.compare(nameOf(a), nameOf(b)) : nameOf(a).localeCompare(nameOf(b)));
  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(kind) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    s.setAttribute('class', 'bi bi-' + kind);
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.8');
    p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    p.setAttribute('d', kind === 'chev' ? 'M6 3.5 10.5 8 6 12.5' : 'M8 7.2v4.3M8 4.6v.1M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z');
    s.appendChild(p);
    return s;
  }

  // ---------- data ----------
  function loadRegions() {
    if (regions) return Promise.resolve(regions);
    if (!regionsP) {
      regionsP = fetch(REGIONS_URL).then(r => { if (!r.ok) throw new Error('regions ' + r.status); return r.json(); })
        .then(d => { regions = d.regions; return regions; })
        .catch(err => { regionsP = null; throw err; });
    }
    return regionsP;
  }
  const citiesReady = () => !!(window.AtlasCities && window.AtlasCities.loaded && A.citiesLoaded);
  function indexCities() {
    if (cityIdx || !citiesReady()) return cityIdx;
    const na = new Map(), world = new Map(), key = new Map();
    for (const [id, rec] of A.places) {
      if (!rec || rec.kind !== 'city' || rec.id !== id) continue;     // skip remapped old ids
      key.set(id, norm(rec.name));
      if (rec.state) { if (!na.has(rec.state)) na.set(rec.state, []); na.get(rec.state).push(id); }
      if (rec.country) { if (!world.has(rec.country)) world.set(rec.country, []); world.get(rec.country).push(id); }
    }
    for (const m of [na, world]) for (const arr of m.values()) arr.sort(byName);
    cityIdx = { na, world, key };
    return cityIdx;
  }
  // Load the cities once (expanding a place or filtering). Resolves true when they are usable.
  function ensureCities() {
    if (indexCities()) return Promise.resolve(true);
    const AC = window.AtlasCities;
    if (!AC || typeof AC.load !== 'function') return Promise.resolve(false);
    return AC.load().then(() => !!indexCities(), () => false);
  }
  const citiesOf = (L, id) => (cityIdx && cityIdx[L.map].get(id)) || [];

  // ---------- marking ----------
  function say(L, msg) {
    L.live.textContent = '';
    // a fresh text node after a tick so screen readers announce repeats too
    setTimeout(() => { L.live.textContent = msg; }, 30);
  }
  function setPlace(L, id, which) {
    if (vm() !== 'own') return;
    const from = st(id);
    const to = which === 1 ? (from === 1 ? 0 : 1) : (from === 2 ? 0 : 2);
    const city = (A.places.get(id) || {}).kind === 'city';
    if (!A.setStatus(id, to, { quiet: true })) return;
    const name = nameOf(id);
    let msg;
    if (to === 1) {
      const also = [];
      if (city) {
        // decision 12 (js/cities.js tapCity): a city marked Been there also marks its state or
        // province and its country, if they are not marked yet. Clearing never touches either.
        const rec = A.places.get(id) || {};
        for (const pid of [rec.state, rec.country]) {
          if (!pid || !A.places.has(pid) || st(pid) !== 0) continue;
          A.setStatus(pid, 1, { quiet: true });
          const pn = nameOf(pid);
          if (!also.includes(pn)) also.push(pn);
        }
      }
      if (also.length === 1) msg = `${name} and ${also[0]}: been there`;
      else if (also.length > 1) msg = `${name}, ${also.slice(0, -1).join(', ')} and ${also[also.length - 1]}: been there`;
      else msg = from === 2 ? `${name}: been there (was on Want to go)` : `${name}: been there`;
    } else if (to === 2) msg = from === 1 ? `${name}: want to go (was Been there)` : `${name}: want to go`;
    else msg = `${name}: cleared`;
    say(L, msg);
    scheduleUpdate();          // the core emits 'change' too; this keeps the list in step either way
  }

  // ---------- rows ----------
  function countLine(L, id) {
    const ids = citiesOf(L, id);
    let n = 0; for (const c of ids) if (st(c)) n++;
    return `${n} of ${ids.length} ${ids.length === 1 ? 'city' : 'cities'}`;
  }
  function expanded(L, id) {
    if (L.forced.has(id)) return L.forced.get(id);
    if (L.q && L.cityHits && L.cityHits.has(id)) return true;
    return L.open.has(id);
  }
  function makeRow(L, id, isCity) {
    const li = h('li', 'brow' + (isCity ? ' brow-city' : ''));
    li.dataset.id = id;
    const line = h('div', 'brow-line');
    li.appendChild(line);
    const sw = h('i', 'brow-sw'); sw.setAttribute('aria-hidden', 'true');
    const name = nameOf(id);
    const canExpand = !isCity && (!cityIdx || citiesOf(L, id).length > 0);
    let label;
    if (canExpand) {
      const b = h('button', 'brow-exp');
      b.type = 'button';
      const cid = 'bc-' + (++uid);
      b.setAttribute('aria-expanded', 'false');
      b.setAttribute('aria-controls', cid);
      const sub = h('span', 'brow-sub');
      sub.append(h('span', 'brow-dot', ' · '), h('span', 'brow-count'));
      b.append(icon('chev'), sw, h('span', 'brow-name', name), sub);
      b.addEventListener('click', () => toggleCities(L, li));
      line.appendChild(b);
      label = b;
      li.dataset.cid = cid;
    } else {
      label = h('span', 'brow-label');
      label.append(sw, h('span', 'brow-name', name));
      line.appendChild(label);
    }
    const marks = h('span', 'brow-marks'); marks.setAttribute('aria-hidden', 'true');
    const sr = h('span', 'brow-vh');
    line.append(marks, sr);
    const acts = h('span', 'brow-acts');
    line.appendChild(acts);
    const mode = vm();
    if (mode === 'own') {
      for (const [which, text, word] of [[1, 'Been', 'been there'], [2, 'Want', 'want to go']]) {
        const b = h('button', 'bt ' + (which === 1 ? 'bt-been' : 'bt-want'), text);
        b.type = 'button';
        b.setAttribute('aria-label', `Mark ${name} as ${word}`);
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => setPlace(L, id, which));
        acts.appendChild(b);
      }
    } else {
      const s = h('span', 'brow-st');
      acts.appendChild(s);
    }
    if (mode !== 'plain' && typeof A.openDetails === 'function') {
      const d = h('button', 'bt-info');
      d.type = 'button';
      d.setAttribute('aria-label', `Details for ${name}`);
      d.title = 'Details';
      d.appendChild(icon('info'));
      d.addEventListener('click', () => A.openDetails(id, d));
      acts.appendChild(d);
    }
    if (canExpand && expanded(L, id)) fillCities(L, li, true);
    updateRow(L, li);
    return li;
  }
  function updateRow(L, li) {
    const id = li.dataset.id;
    const s = st(id);
    const info = typeof A.getInfo === 'function' ? A.getInfo(id) : null;
    li.classList.toggle('on', s === 1);
    li.classList.toggle('want', s === 2);
    for (const b of li.querySelectorAll(':scope > .brow-line .bt')) {
      b.setAttribute('aria-pressed', String(b.classList.contains('bt-been') ? s === 1 : s === 2));
    }
    const ro = li.querySelector(':scope > .brow-line .brow-st');
    if (ro) ro.textContent = s === 1 ? 'Been there' : s === 2 ? 'Want to go' : '';
    const marks = li.querySelector(':scope > .brow-line .brow-marks');
    const mt = (info && info.rating ? '★' + info.rating : '') + (info && info.note ? (info.rating ? ' ' : '') + NOTE_GLYPH : '');
    if (marks.textContent !== mt) marks.textContent = mt;
    const bits = [];
    if (vm() !== 'own' && !ro) bits.push(s === 1 ? 'been there' : s === 2 ? 'want to go' : '');
    if (info && info.rating) bits.push('rated ' + info.rating);
    if (info && info.note) bits.push('has a note');
    const srt = bits.filter(Boolean).length ? ', ' + bits.filter(Boolean).join(', ') : '';
    const sr = li.querySelector(':scope > .brow-line .brow-vh');
    if (sr.textContent !== srt) sr.textContent = srt;
    const info$ = li.querySelector(':scope > .brow-line .bt-info');
    if (info$ && vm() === 'notes') info$.hidden = !s && !info;       // the read-only panel shows marked places
    const sub = li.querySelector(':scope > .brow-line .brow-count');
    if (sub) { const t = cityIdx ? countLine(L, id) : 'cities'; if (sub.textContent !== t) sub.textContent = t; }
  }
  function toggleCities(L, li) {
    const id = li.dataset.id;
    const now = !expanded(L, id);
    if (L.q) L.forced.set(id, now);
    else if (now) L.open.add(id); else L.open.delete(id);
    fillCities(L, li, now);
  }
  function fillCities(L, li, show) {
    const id = li.dataset.id;
    const b = li.querySelector(':scope > .brow-line .brow-exp');
    if (b) b.setAttribute('aria-expanded', String(show));
    let ul = li.querySelector(':scope > .brow-cities');
    if (!show) { if (ul) ul.remove(); return; }
    if (!ul) { ul = h('ul', 'brow-cities'); ul.id = li.dataset.cid || ''; li.appendChild(ul); }
    ul.textContent = '';
    if (L.map === 'world' && SEE_NA.has(id) && !L.q) {
      const note = h('li', 'brow-note');
      const go = h('button', 'brow-link', 'Open that list');
      go.type = 'button';
      go.addEventListener('click', () => { const n = lists.na; if (!n) return; n.root.open = true; n.root.scrollIntoView({ block: 'start' }); n.input.focus({ preventScroll: true }); });
      note.append(h('span', null, `Cities in ${nameOf(id)} are listed under the U.S. & Canada map. `), go);
      ul.appendChild(note);
      return;
    }
    if (!cityIdx) {
      ul.appendChild(h('li', 'brow-note', 'Loading cities'));
      ensureCities().then(ok => {
        if (!li.isConnected || !expanded(L, id)) return;
        if (ok) { refreshAll(); return; }
        ul.textContent = '';
        ul.appendChild(h('li', 'brow-note', (window.AtlasCities && window.AtlasCities.OFFLINE_NOTE) || 'Cities need one online visit first.'));
      });
      return;
    }
    let ids = citiesOf(L, id);
    if (L.q && L.cityHits && L.cityHits.has(id)) ids = L.cityHits.get(id);
    if (!ids.length) { ul.appendChild(h('li', 'brow-note', 'No cities listed here yet.')); return; }
    const frag = document.createDocumentFragment();
    for (const c of ids) frag.appendChild(makeRow(L, c, true));
    ul.appendChild(frag);
  }

  // ---------- groups ----------
  function groupsFor(L) {
    if (L.map === 'na') {
      return NA_GROUPS.map(g => ({
        key: g.key, label: g.label,
        parts: [{ label: null, ids: [...A.places.values()].filter(p => p.map === 'na' && g.kinds.includes(p.kind)).map(p => p.id).sort(byName) }],
      }));
    }
    if (!regions) return null;
    const out = [];
    for (const cont of Object.keys(regions)) {
      const ids = regions[cont].filter(id => A.places.has(id) && A.places.get(id).map === 'world');
      if (!ids.length) continue;
      const kindOf = id => A.places.get(id).kind;
      out.push({
        key: cont, label: cont,
        parts: [
          { label: null, ids: ids.filter(id => kindOf(id) === 'country').sort(byName) },
          { label: 'Territories & other places', ids: ids.filter(id => kindOf(id) !== 'country').sort(byName) },
        ],
      });
    }
    return out;
  }
  const groupIds = g => g.parts.reduce((a, p) => a.concat(p.ids), []);
  function buildGroups(L) {
    const gs = groupsFor(L);
    if (!gs) return false;
    L.body.textContent = '';
    L.groups = gs;
    for (const g of gs) {
      const d = h('details', 'browse-group');
      d.dataset.group = g.key;
      const s = h('summary');
      const h3 = h('h3', 'bg-title', g.label);
      const c = h('span', 'bg-count');
      s.append(h3, c);
      const box = h('div', 'bg-body');
      d.append(s, box);
      d.addEventListener('toggle', () => { if (d.open && !g.rendered) renderGroup(L, g); });
      g.el = d; g.box = box; g.count = c; g.all = groupIds(g); g.rendered = false;
      L.body.appendChild(d);
    }
    updateCounts(L);
    return true;
  }
  function placeMatches(L, id) { return !L.q || L.keys.get(id).includes(L.q) || (L.cityHits && L.cityHits.has(id)); }
  function renderGroup(L, g) {
    g.box.textContent = '';
    g.rendered = true;
    for (const part of g.parts) {
      const ids = part.ids.filter(id => placeMatches(L, id));
      if (!ids.length) continue;
      if (part.label) g.box.appendChild(h('h4', 'bg-sub', part.label));
      const ul = h('ul', 'brow-list');
      const frag = document.createDocumentFragment();
      for (const id of ids) frag.appendChild(makeRow(L, id, false));
      ul.appendChild(frag);
      g.box.appendChild(ul);
    }
  }
  function updateCounts(L) {
    let n = 0, total = 0;
    for (const id of L.allIds) { total++; if (st(id)) n++; }
    L.count.textContent = `${n} of ${total} marked`;
    for (const g of L.groups || []) {
      let m = 0; for (const id of g.all) if (st(id)) m++;
      g.count.textContent = `${m} of ${g.all.length}`;
    }
  }

  // ---------- filter ----------
  // force: run again for the same query (cities arrived, the groups were just built, view changed)
  function applyFilter(L, force) {
    const q = norm(L.input.value);
    if (q === L.q && !force) return;
    if (q && !L.q) L.snapshot = (L.groups || []).filter(g => g.el.open).map(g => g.key);
    L.q = q;
    L.forced = new Map();
    L.cityHits = null;
    if (q && cityIdx) {
      const hits = new Map();
      for (const [pid, ids] of cityIdx[L.map]) {
        if (L.map === 'world' && !A.places.has(pid)) continue;
        const m = ids.filter(c => cityIdx.key.get(c).includes(q));
        if (m.length) hits.set(pid, m);
      }
      L.cityHits = hits;
    }
    if (!L.groups) return;
    let any = false;
    for (const g of L.groups) {
      const has = !q || g.all.some(id => placeMatches(L, id));
      g.el.hidden = !has;
      if (has && q) any = true;
      if (q) g.el.open = has;
      else g.el.open = (L.snapshot || []).includes(g.key);
      g.rendered = false;
      g.box.textContent = '';
      if (g.el.open) renderGroup(L, g);
    }
    if (!q) L.snapshot = null;
    L.empty.hidden = !q || any;
  }
  function onFilterInput(L) {
    clearTimeout(L.timer);
    L.timer = setTimeout(() => {
      if (norm(L.input.value) && !cityIdx) {
        ensureCities().then(ok => { if (ok) applyFilter(L, true); });
      }
      applyFilter(L);
    }, 120);
  }

  // ---------- lists ----------
  function build(map) {
    const sec = document.getElementById('sec-' + map);
    if (!sec || lists[map]) return;
    const L = { map, open: new Set(), forced: new Map(), q: '', cityHits: null, groups: null, snapshot: null, timer: 0 };
    L.allIds = [...A.places.values()].filter(p => p.map === map && p.kind !== 'city').map(p => p.id);
    L.keys = new Map(L.allIds.map(id => [id, norm(nameOf(id))]));
    const root = h('details', 'browse');
    root.dataset.map = map;
    root.id = 'browse-' + map;
    const sum = h('summary', 'browse-sum');
    sum.append(h('span', 'browse-title', 'Browse as a list'), L.count = h('span', 'browse-count'));
    const inner = h('div', 'browse-inner');
    const fl = h('div', 'browse-filter');
    const input = h('input', 'browse-q');
    input.type = 'search';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = map === 'na' ? 'Filter states, provinces and cities' : 'Filter countries, places and cities';
    input.setAttribute('aria-label', `Filter the ${MAP_NAME[map]} list`);
    fl.appendChild(input);
    const live = h('p', 'brow-vh browse-live');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    const empty = h('p', 'browse-empty', 'No matches');
    empty.hidden = true;
    const body = h('div', 'browse-body');
    inner.append(fl, live, empty, body);
    root.append(sum, inner);
    Object.assign(L, { root, input, live, empty, body });
    input.addEventListener('input', () => onFilterInput(L));
    input.addEventListener('keydown', e => { if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; applyFilter(L); } });
    root.addEventListener('toggle', () => { if (root.open && !L.groups) fillBody(L); });
    sec.appendChild(root);
    lists[map] = L;
    updateCounts(L);
  }
  function fillBody(L) {
    if (buildGroups(L)) { if (L.q) applyFilter(L, true); return; }
    L.body.textContent = '';
    L.body.appendChild(h('p', 'brow-note', 'Loading the list'));
    loadRegions().then(() => {
      buildGroups(L);
      if (L.q) applyFilter(L, true);
    }, () => {
      L.body.textContent = '';
      L.body.appendChild(h('p', 'brow-note', 'The list needs one online visit first.'));
    });
  }

  // ---------- live updates ----------
  let pending = false;
  function scheduleUpdate() {
    if (pending) return;
    pending = true;
    Promise.resolve().then(() => { pending = false; updateAll(); });
  }
  function updateAll() {
    for (const L of Object.values(lists)) {
      updateCounts(L);
      for (const li of L.root.querySelectorAll('li.brow')) updateRow(L, li);
    }
  }
  // Rebuild the rows of open groups (cities just arrived, or the view mode changed). Keeps which
  // groups and places are open and the filter; the page scroll stays where it is.
  function refreshAll() {
    for (const L of Object.values(lists)) {
      if (!L.groups) continue;
      if (L.q) { applyFilter(L, true); continue; }
      for (const g of L.groups) { g.rendered = false; g.box.textContent = ''; if (g.el.open) renderGroup(L, g); }
    }
  }

  function init() {
    if (A) return;
    A = window.Atlas;
    build('na');
    build('world');
    A.on('change', scheduleUpdate);
    A.on('view', () => refreshAll());
    A.on('cities', () => { if (!cityIdx && indexCities()) refreshAll(); });
    if (indexCities()) refreshAll();
    window.AtlasBrowse = {
      lists,
      get citiesIndexed() { return !!cityIdx; },
      get regionsLoaded() { return !!regions; },
    };
  }
  if (window.Atlas && window.Atlas.places) init();
  else {
    window.addEventListener('atlas:ready', init, { once: true });
    // in case the event fired before this deferred script ran
    (function wait(n) { if (A) return; if (window.Atlas && window.Atlas.places) { init(); return; } if (n < 1200) setTimeout(() => wait(n + 1), 50); })(0);
  }
})();
