// Travel Atlas place details panel (docs/plan-ux.md §2.2, §2.4 read-only panel, §4 copy, §5 a11y, §6 states).
// Plain classic script, loaded with <script defer> after js/app.js. Talks to the app only through
// window.Atlas (plan-ux §7). Builds its own <dialog class="dlg-box place-panel">; selectors follow the
// contract at the top of css/features.css. No inline styles (CSP style-src 'self').
//
// Public surface: window.AtlasPanel = { open(id, opener?), close(), isOpen(), id(), flush() }
(function () {
  'use strict';

  const NOTE_MAX = 500;          // code points (store LIMITS.note)
  const NOTE_COUNT_AT = 400;     // the counter appears from here
  const FIRST_YEAR = 1900;       // store LIMITS.firstYear
  const DEBOUNCE = 400;

  const KIND_LABEL = { state: 'U.S. state', dc: 'Federal district', territory: 'U.S. territory', province: 'Canada', country: 'Country', other: 'Territory', city: 'City' };
  const MAP_LABEL = { na: 'U.S. & Canada', world: 'World' };
  const STATUS = [
    { key: 'been', n: 1, label: 'Been there' },
    { key: 'want', n: 2, label: 'Want to go' },
    { key: 'none', n: 0, label: 'Not marked' },
  ];
  const STAR_PATH = 'M12 2.8l2.84 5.75 6.35.92-4.6 4.48 1.09 6.32L12 17.27l-5.68 2.99 1.09-6.32-4.6-4.48 6.35-.92z';
  const SVGNS = 'http://www.w3.org/2000/svg';

  let A = null;                  // window.Atlas once known
  let dlg = null, ui = null;
  let cur = null;                // { id, readonly }
  let opener = null;
  let lastActivated = null, lastActivatedAt = 0;
  let saveTimer = 0;
  let pending = null;            // { year?, note? } not yet written
  let statusIsString = false;    // Atlas.getStatus returns 'been'/'want'/'' instead of 1/2/0

  const cps = s => Array.from(String(s || ''));
  const maxYear = () => new Date().getFullYear() + 1;

  // ---------- Atlas adapters (tolerant of small seam differences) ----------
  function viewMode() {
    const m = A && A.viewMode;
    return (typeof m === 'function' ? m.call(A) : m) || 'own';
  }
  function statusKey(id) {
    let s = 0;
    try { s = A.getStatus(id); } catch (_) {}
    if (typeof s === 'string') statusIsString = true;
    if (s === 1 || s === 'been') return 'been';
    if (s === 2 || s === 'want') return 'want';
    return 'none';
  }
  function setStatus(id, key) {
    const st = STATUS.find(x => x.key === key);
    const v = statusIsString ? (key === 'none' ? 0 : key) : st.n;
    try { A.setStatus(id, v, { quiet: true }); return true; } catch (e) { reportError(e); return false; }
  }
  function info(id) {
    let n = null;
    try { n = A.getInfo ? A.getInfo(id) : null; } catch (_) {}
    return { rating: (n && n.rating) | 0, year: (n && n.year) | 0, note: (n && n.note) || '' };
  }
  function setInfo(id, patch) {
    try { A.setInfo(id, patch); return true; } catch (e) { reportError(e); return false; }
  }
  function getPlace(id) {
    const P = A && A.places;
    if (P && typeof P.get === 'function') { const p = P.get(id); if (p) return p; }
    else if (P && P[id]) return P[id];
    const C = (A && A.cities) || window.AtlasCities || window.Cities;
    if (C && typeof C.get === 'function') { try { const c = C.get(id); if (c) return c; } catch (_) {} }
    return null;
  }
  function countryName(p) {
    if (!p) return '';
    if (typeof p.countryName === 'string') return p.countryName;
    const c = p.country || p.cc || p.countryId;
    if (c && typeof c === 'object') return c.name || '';
    if (typeof c === 'string') { const q = getPlace(c); return q && q.id !== p.id ? q.name : c; }
    return '';
  }
  function ownerName() {
    const o = A && (A.ownerName !== undefined ? A.ownerName : A.owner);
    const v = typeof o === 'function' ? o.call(A) : o;
    return typeof v === 'string' ? v.trim() : '';
  }
  function placeName(id) { const p = getPlace(id); return (p && p.name) || id; }
  function subLine(id) {
    const p = getPlace(id);
    if (/^C-/.test(id)) { const c = countryName(p); return c ? 'City · ' + c : 'City'; }
    if (!p) return '';
    const k = KIND_LABEL[p.kind] || '', m = MAP_LABEL[p.map] || '';
    return k && m ? k + ' · ' + m : k || m;
  }

  // ---------- DOM helpers ----------
  function h(tag, attrs, parent, text) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (attrs[k] === false || attrs[k] == null) continue;
      if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function star(cls, parent) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    if (cls) s.setAttribute('class', cls);
    const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', STAR_PATH); s.appendChild(p);
    parent.appendChild(s);
    return s;
  }

  function build() {
    dlg = h('dialog', { class: 'dlg-box place-panel', 'aria-labelledby': 'pp-title', 'aria-describedby': 'pp-sub' }, document.body);
    const form = h('form', { method: 'dialog', class: 'dlg' }, dlg);
    const head = h('div', { class: 'dlg-head' }, form);
    const title = h('h2', { id: 'pp-title' }, head);
    h('button', { type: 'submit', class: 'x', 'aria-label': 'Close', value: 'close' }, head, '×');
    const sub = h('p', { class: 'dlg-sub', id: 'pp-sub' }, form);

    // status
    const seg = h('div', { class: 'seg status-seg', role: 'radiogroup', 'aria-label': 'Status' }, form);
    const statusBtns = STATUS.map(st => {
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-status': st.key, tabindex: '-1' }, seg, st.label);
      b.addEventListener('click', () => pickStatus(st.key, b));
      return b;
    });
    seg.addEventListener('keydown', e => {
      const i = statusBtns.indexOf(document.activeElement);
      if (i < 0) return;
      let j = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % statusBtns.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i + statusBtns.length - 1) % statusBtns.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = statusBtns.length - 1;
      if (j < 0) return;
      e.preventDefault();
      statusBtns[j].focus();
      if (!cur.readonly) pickStatus(statusBtns[j].dataset.status, statusBtns[j]);
    });

    // rating (owner)
    const rateF = h('div', { class: 'pp-field pp-rating' }, form);
    h('div', { class: 'dlg-label', id: 'pp-rate-lbl' }, rateF, 'Your rating');
    const stars = h('div', { class: 'stars', role: 'radiogroup', 'aria-labelledby': 'pp-rate-lbl' }, rateF);
    const starInputs = [];
    for (let i = 1; i <= 5; i++) {
      const l = h('label', { class: 'star', title: i === 1 ? '1 star' : i + ' stars' }, stars);
      const inp = h('input', { type: 'radio', name: 'pp-rating', value: String(i), 'aria-label': i === 1 ? '1 star' : i + ' stars' }, l);
      star('', l);
      starInputs.push(inp);
    }
    const noneL = h('label', { class: 'star-none' }, stars);
    const noneInp = h('input', { type: 'radio', name: 'pp-rating', value: '0' }, noneL);
    noneL.appendChild(document.createTextNode('No rating'));
    starInputs.unshift(noneInp);       // index == rating
    stars.addEventListener('change', e => {
      if (!cur || cur.readonly || e.target.name !== 'pp-rating') return;
      setInfo(cur.id, { rating: +e.target.value });
    });

    // read-only rating
    const rateRo = h('div', { class: 'pp-field pp-rating-ro' }, form);
    const rateRoLbl = h('div', { class: 'dlg-label', id: 'pp-rate-ro-lbl' }, rateRo, 'Rating');
    const starsRo = h('span', { class: 'stars-ro', role: 'img' }, rateRo);
    const starRo = [];
    for (let i = 1; i <= 5; i++) starRo.push(star('star-ro', starsRo));
    const rateRoNone = h('p', { class: 'place-ro none' }, rateRo, 'No rating.');

    // year (owner)
    const yearF = h('div', { class: 'pp-field pp-year' }, form);
    h('label', { class: 'dlg-label', for: 'pp-year' }, yearF, 'When did you go? (optional)');
    const year = h('input', {
      type: 'text', id: 'pp-year', class: 'dlg-input year-input', inputmode: 'numeric', maxlength: '4',
      autocomplete: 'off', spellcheck: 'false', placeholder: 'e.g. 2019', 'aria-describedby': 'pp-year-err',
    }, yearF);
    const yearErr = h('p', { class: 'dlg-note err', id: 'pp-year-err', role: 'status', hidden: true }, yearF);
    year.addEventListener('input', () => {
      const d = year.value.replace(/\D+/g, '').slice(0, 4);
      if (d !== year.value) year.value = d;
      queue({ year: true });
    });
    year.addEventListener('blur', () => flush());

    // read-only year
    const yearRo = h('p', { class: 'place-ro pp-year-ro' }, form);

    // note (owner)
    const noteF = h('div', { class: 'pp-field pp-note' }, form);
    h('label', { class: 'dlg-label', for: 'pp-note' }, noteF, 'Note');
    const note = h('textarea', { id: 'pp-note', class: 'note-input', rows: '4', maxlength: String(NOTE_MAX * 2), 'aria-describedby': 'pp-note-count pp-note-err' }, noteF);
    const noteCount = h('p', { class: 'note-count', id: 'pp-note-count', hidden: true }, noteF);
    const noteErr = h('p', { class: 'dlg-note err', id: 'pp-note-err', role: 'status', hidden: true }, noteF);
    note.addEventListener('input', () => {
      const c = cps(note.value);
      if (c.length > NOTE_MAX) {
        const at = note.selectionStart, over = c.length - NOTE_MAX;
        note.value = c.slice(0, NOTE_MAX).join('');
        try { note.setSelectionRange(Math.max(0, at - over), Math.max(0, at - over)); } catch (_) {}
      }
      updateCount();
      queue({ note: true });
    });
    note.addEventListener('blur', () => flush());

    // read-only note
    const noteRoF = h('div', { class: 'pp-field pp-note-ro' }, form);
    h('div', { class: 'dlg-label' }, noteRoF, 'Note');
    const noteRo = h('p', { class: 'place-ro' }, noteRoF);

    // footer
    const foot = h('div', { class: 'place-foot' }, form);
    const privacy = h('p', { class: 'place-privacy' }, foot, 'Only you see notes and ratings, unless you turn on the notes link in Share.');
    const done = h('button', { type: 'submit', class: 'btn primary', value: 'done' }, foot, 'Done');

    dlg.addEventListener('close', onClosed);
    // a click on the backdrop (outside the box) closes, like the other dialogs feel on phones
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

    ui = { title, sub, seg, statusBtns, rateF, starInputs, rateRo, rateRoLbl, starsRo, starRo, rateRoNone, yearF, year, yearErr, yearRo,
      noteF, note, noteCount, noteErr, noteRoF, noteRo, privacy, done };
  }

  // ---------- rendering ----------
  function render(full) {
    if (!cur) return;
    const id = cur.id, ro = cur.readonly;
    const s = statusKey(id), n = info(id);
    dlg.classList.toggle('readonly', ro);
    ui.title.textContent = placeName(id);
    ui.sub.textContent = subLine(id);

    ui.seg.setAttribute('aria-readonly', String(ro));
    ui.statusBtns.forEach(b => {
      const on = b.dataset.status === s;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      if (ro) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    });

    const been = s === 'been', marked = s !== 'none';
    // owner fields
    ui.rateF.hidden = ro || !been;
    ui.yearF.hidden = ro || !been;
    ui.noteF.hidden = ro || !marked;
    ui.privacy.hidden = ro;
    if (!ro) {
      const r = Math.max(0, Math.min(5, n.rating));
      ui.starInputs.forEach((inp, i) => { inp.checked = i === r; });
      const pend = pending || {};
      if (full || (!pend.year && document.activeElement !== ui.year)) { ui.year.value = n.year ? String(n.year) : ''; showYearErr(''); }
      if (full || (!pend.note && document.activeElement !== ui.note)) ui.note.value = n.note;
      ui.note.placeholder = s === 'want' ? 'Why do you want to go?' : 'What do you remember?';
      updateCount();
      if (full) showNoteErr('');
    }
    // read-only fields
    ui.rateRo.hidden = !ro || !been;
    ui.yearRo.hidden = !ro || !been || !n.year;
    ui.noteRoF.hidden = !ro || !marked;
    if (ro) {
      const who = ownerName();
      ui.rateRoLbl.textContent = who ? who + '’s rating' : 'Rating';
      ui.starsRo.hidden = !n.rating;
      ui.rateRoNone.hidden = !!n.rating;
      ui.starRo.forEach((sv, i) => sv.classList.toggle('lit', i < n.rating));
      ui.starsRo.setAttribute('aria-label', n.rating === 1 ? '1 star' : n.rating + ' stars');
      ui.yearRo.textContent = n.year ? 'Went in ' + n.year : '';
      ui.noteRo.textContent = n.note || 'No note.';
      ui.noteRo.classList.toggle('none', !n.note);
    }
  }
  function updateCount() {
    const used = cps(ui.note.value).length;
    ui.noteCount.hidden = used < NOTE_COUNT_AT;
    ui.noteCount.textContent = (NOTE_MAX - used) + ' left';
  }
  function showYearErr(msg) {
    ui.yearErr.textContent = msg; ui.yearErr.hidden = !msg;
    if (msg) ui.year.setAttribute('aria-invalid', 'true'); else ui.year.removeAttribute('aria-invalid');
  }
  function showNoteErr(msg) { ui.noteErr.textContent = msg; ui.noteErr.hidden = !msg; }
  function reportError(e) {
    if (!ui) return;
    if (e && e.code === 'too_many_notes') showNoteErr('This map already holds 1000 notes, the most it can keep.');
    else if (e && e instanceof RangeError && /year/i.test(e.message)) showYearErr(yearMsg());
    else showNoteErr('Could not save that change.');
  }
  const yearMsg = () => `Use a year from ${FIRST_YEAR} to ${maxYear()}, or leave it empty.`;

  // ---------- saving ----------
  function pickStatus(key, btn) {
    if (!cur || cur.readonly) return;
    flush();
    if (statusKey(cur.id) !== key) setStatus(cur.id, key);
    render(false);
    if (btn) btn.focus();
  }
  function queue(what) {
    pending = Object.assign(pending || {}, what);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, DEBOUNCE);
  }
  function flush() {
    clearTimeout(saveTimer); saveTimer = 0;
    if (!cur || cur.readonly || !pending) return;
    const what = pending; pending = null;
    const patch = {};
    if (what.year) {
      const v = ui.year.value.trim();
      if (v === '') { patch.year = 0; showYearErr(''); }
      else if (/^\d{4}$/.test(v) && +v >= FIRST_YEAR && +v <= maxYear()) { patch.year = +v; showYearErr(''); }
      else if (v.length === 4 || document.activeElement !== ui.year || !dlg.open) showYearErr(yearMsg());
      // a partly typed year (fewer than 4 digits, still focused) waits without an error
    }
    if (what.note) patch.note = ui.note.value;
    if (!Object.keys(patch).length) return;
    const cur0 = info(cur.id);
    if (patch.year === cur0.year) delete patch.year;
    if (patch.note !== undefined && patch.note === cur0.note) delete patch.note;
    if (!Object.keys(patch).length) return;
    if (setInfo(cur.id, patch) && patch.note !== undefined) showNoteErr('');
  }

  // ---------- open / close ----------
  function open(id, from) {
    if (!A || !id) return false;
    const mode = viewMode();
    if (mode === 'plain') return false;
    if (!getPlace(id) && !/^C-/.test(id)) return false;
    if (!dlg) build();
    const readonly = mode !== 'own';
    if (cur && dlg.open) {
      if (cur.id === id && cur.readonly === readonly) { render(false); return true; }
      flush();
    } else {
      opener = from || pickOpener();
    }
    cur = { id, readonly };
    pending = null;
    render(true);
    if (!dlg.open) { try { dlg.showModal(); } catch (_) { dlg.setAttribute('open', ''); } }
    const on = ui.statusBtns.find(b => b.getAttribute('aria-checked') === 'true') || ui.statusBtns[0];
    on.focus();
    return true;
  }
  function pickOpener() {
    const a = document.activeElement;
    if (a && a !== document.body && a !== document.documentElement && !(dlg && dlg.contains(a))) return a;
    if (lastActivated && Date.now() - lastActivatedAt < 2000) return lastActivated;
    return null;
  }
  function close() { if (dlg && dlg.open) dlg.close(); }
  function onClosed() {
    flush();
    const id = cur && cur.id;
    cur = null; pending = null;
    let t = opener; opener = null;
    if (!usable(t) && id) {
      // the toast's Details button is gone or hidden: fall back to the place's chip
      const esc = window.CSS && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '');
      t = document.querySelector(`.chip[data-id="${esc}"]`);
    }
    if (usable(t)) { try { t.focus({ preventScroll: true }); } catch (_) { t.focus(); } }
  }
  function usable(el) {
    if (!el || !el.isConnected || typeof el.focus !== 'function') return false;
    if (el.closest('[hidden], [inert]')) return false;
    const toast = el.closest('.toast');
    if (toast && !toast.classList.contains('show')) return false;
    return el.getClientRects().length > 0;
  }

  // ---------- wiring ----------
  function idOf(arg) {
    if (typeof arg === 'string') return arg;
    if (arg && typeof arg === 'object') return arg.id || (arg.detail && arg.detail.id) || (Array.isArray(arg.ids) && arg.ids[0]) || null;
    return null;
  }
  function onChange(arg) {
    if (!cur || !dlg || !dlg.open) return;
    const ids = arg && typeof arg === 'object' && Array.isArray(arg.ids) ? arg.ids : typeof arg === 'string' ? [arg] : null;
    if (ids && !ids.includes(cur.id)) return;
    render(false);
  }
  function wire() {
    if (A || !window.Atlas) return !!A;
    A = window.Atlas;
    if (typeof A.on === 'function') {
      A.on('details', arg => { const id = idOf(arg); if (id) open(id, arg && arg.opener); });
      A.on('change', onChange);
    }
    // a note glyph etc. may live in the chip; remember the last activated control for focus return
    // (Safari does not focus buttons on click)
    document.addEventListener('click', e => {
      const b = e.target && e.target.closest && e.target.closest('button, a, [tabindex]');
      if (b && !(dlg && dlg.contains(b))) { lastActivated = b; lastActivatedAt = Date.now(); }
    }, true);
    window.addEventListener('pagehide', () => flush());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    return true;
  }

  window.AtlasPanel = {
    open: (id, from) => { wire(); return open(id, from); },
    close,
    flush,
    isOpen: () => !!(dlg && dlg.open),
    id: () => (cur ? cur.id : null),
  };

  // app.js publishes window.Atlas once both maps are built (after its data loads), then fires
  // 'atlas:ready'; this script may run before or after that
  if (!wire()) window.addEventListener('atlas:ready', wire, { once: true });
})();
