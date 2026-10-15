// Travel Atlas client data store (docs/plan-data-sync.md: "Client (localStorage)", "Merge rules",
// "Backup", "Limits"). Pure logic: no DOM, no network. Storage and clock are injectable so the same
// file runs in the page (window.AtlasStore) and in Node tests (module.exports).
//
// The document kept under travel-atlas:v2 is the source of truth on this device:
//   { v: 2, places: {id: [s, t]}, notes: {id: [rating, year, text, t]}, owner: [name, t],
//     dirty: {"p:<id>": 1, "n:<id>": 1, "o": 1} }
// s: 0 = none, 1 = been, 2 = want. t: ms of the edit (last-writer-wins per register).
// Status 0 and empty notes are kept as tombstones so a removal beats an older add elsewhere.
// Ids the app hasn't loaded (cities are lazy) are kept; only drawing filters by known ids.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.AtlasStore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEYS = {
    v2: 'travel-atlas:v2',
    bad: 'travel-atlas:v2.bad',          // an unreadable :v2 is parked here instead of being overwritten
    v1: 'travel-atlas:v1',               // mirrored: been ids as {id: true} (downgrade safety)
    v1bad: 'travel-atlas:v1.bad',
    owner: 'travel-atlas:owner',         // mirrored: owner name
    clock: 'travel-atlas:clock',         // read once by the migration, never written again
    ownerT: 'travel-atlas:ownerT',       // read once by the migration, never written again
    link: 'travel-atlas:link',           // the migration drops link.rev so the next sync is full
  };
  const LIMITS = {
    note: 500,            // characters (code points) per note
    notes: 1000,          // non-empty notes per map
    name: 40,             // owner name, code points
    rating: 5,
    firstYear: 1900,
    chunkPlaces: 1000,    // per sync request
    chunkNotes: 200,
    chunkBytes: 100 * 1024,
  };
  const ID_RE = /^[A-Z0-9][A-Z0-9-]{0,19}$/;   // shape only; the server checks its allowlist
  const CITY_RE = /^C-\d{1,12}$/;
  const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/gu;      // same set the server strips from names
  // notes keep \n and U+200D ZERO WIDTH JOINER (emoji sequences), as worker/model.js does
  const NOTE_INVISIBLE_RE = /(?![\n\u200D])[\p{Cc}\p{Cf}]/gu;
  const STATUS_NAME = { 1: 'been', 2: 'want' };
  const STATUS_OF = { been: 1, want: 2 };
  const RANK = [0, 2, 1];                        // precedence for Add: been beats want beats none

  // ---------- small pure helpers ----------
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const validT = t => Number.isSafeInteger(t) && t > 0;
  const validS = s => s === 0 || s === 1 || s === 2;
  const validId = id => typeof id === 'string' && ID_RE.test(id);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const cps = s => Array.from(s);                // code points (an emoji counts once)

  function maxYear(nowMs) { return new Date(nowMs).getFullYear() + 1; }
  function validRating(r) { return Number.isInteger(r) && r >= 0 && r <= LIMITS.rating; }
  function validYear(y, nowMs) { return y === 0 || (Number.isInteger(y) && y >= LIMITS.firstYear && y <= maxYear(nowMs)); }
  // stored or server data: a device whose clock runs behind must not drop a year saved elsewhere
  function storedYear(y) { return y === 0 || (Number.isInteger(y) && y >= LIMITS.firstYear && y <= 9999); }

  // Note text: CRLF -> LF, control/format chars stripped except \n and ZWJ, at most 3 newlines in a row,
  // trimmed, at most 500 code points.
  function cleanNote(v) {
    let s = String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(NOTE_INVISIBLE_RE, '');
    s = s.replace(/\n{4,}/g, '\n\n\n').trim();
    const c = cps(s);
    if (c.length > LIMITS.note) s = c.slice(0, LIMITS.note).join('').trimEnd();
    return s;
  }
  // Owner name: invisible chars stripped, whitespace collapsed (as the app's ownerName()), ≤ 40.
  function cleanName(v) {
    const s = String(v == null ? '' : v).replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
    const c = cps(s);
    return c.length > LIMITS.name ? c.slice(0, LIMITS.name).join('').trim() : s;
  }
  const notesEmpty = n => !n || (n[0] === 0 && n[1] === 0 && n[2] === '');
  const sameNotes = (a, b) => (notesEmpty(a) && notesEmpty(b)) || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

  // UTF-8 byte length, for sizing sync chunks
  function utf8Len(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  function emptyDoc() { return { v: 2, places: {}, notes: {}, owner: ['', 0], dirty: {} }; }

  // A stored :v2 with the right shape; malformed entries are dropped one by one.
  // Returns null when the whole thing is unusable (then the caller recovers from :v1).
  function sanitizeDoc(o) {
    if (!isObj(o) || o.v !== 2) return null;
    const d = emptyDoc();
    if (isObj(o.places)) for (const id in o.places) {
      const e = o.places[id];
      if (validId(id) && Array.isArray(e) && validS(e[0]) && validT(e[1])) d.places[id] = [e[0], e[1]];
    }
    if (isObj(o.notes)) for (const id in o.notes) {
      const e = o.notes[id];
      if (!validId(id) || !Array.isArray(e) || !validT(e[3])) continue;
      if (!validRating(e[0]) || !storedYear(e[1]) || typeof e[2] !== 'string') continue;
      d.notes[id] = [e[0], e[1], cleanNote(e[2]), e[3]];
    }
    if (Array.isArray(o.owner) && typeof o.owner[0] === 'string' && Number.isSafeInteger(o.owner[1]) && o.owner[1] >= 0) {
      d.owner = [cleanName(o.owner[0]), o.owner[1]];
    }
    if (isObj(o.dirty)) for (const k in o.dirty) if (o.dirty[k] && (k === 'o' || /^[pn]:/.test(k))) d.dirty[k] = 1;
    return d;
  }

  // localStorage-like storage, every call wrapped (private mode, blocked site data, quota).
  function wrapStorage(s) {
    if (s === undefined) { try { s = globalThis.localStorage; } catch (_) { s = null; } }
    return {
      get(k) { try { return s ? s.getItem(k) : null; } catch (_) { return null; } },
      set(k, v) { try { if (!s) return false; s.setItem(k, v); return true; } catch (_) { return false; } },
      remove(k) { try { if (s) s.removeItem(k); return !!s; } catch (_) { return false; } },
    };
  }

  // ---------- backup parsing (pure) ----------
  // isKnown(id) (optional): ids it rejects are counted in `unknown` and left out.
  function parseBackup(input, opts) {
    const isKnown = opts && typeof opts.isKnown === 'function' ? opts.isKnown : null;
    const nowMs = opts && typeof opts.now === 'number' ? opts.now : Date.now();
    const out = { kind: '', mapOnly: true, places: {}, unknown: 0 };
    const accept = id => {
      id = String(id == null ? '' : id).trim().toUpperCase();
      if (!id) return null;
      if (!validId(id) || (isKnown && !isKnown(id))) { out.unknown++; return null; }
      return id;
    };
    const putStatus = (id, s) => {          // been beats want inside one backup too
      const cur = out.places[id];
      if (!cur) out.places[id] = { status: s };
      else if (RANK[s] > RANK[cur.status]) cur.status = s;
    };
    const ownerOf = o => { if (typeof o.owner === 'string' && cleanName(o.owner)) out.owner = cleanName(o.owner); };

    function fromObject(o) {
      if (!isObj(o)) return null;
      if (o.format === 'atlas2' && (o.places === undefined || isObj(o.places))) {
        out.kind = 'atlas2-file'; out.mapOnly = false; ownerOf(o);
        const p = o.places || {};
        for (const k in p) {
          const e = p[k];
          if (!isObj(e)) { out.unknown++; continue; }
          const id = accept(k); if (!id) continue;
          const item = { status: STATUS_OF[e.status] || 0 };
          if (validRating(e.rating) && e.rating) item.rating = e.rating;
          if (validYear(e.year, nowMs) && e.year) item.year = e.year;
          const note = typeof e.note === 'string' ? cleanNote(e.note) : '';
          if (note) item.note = note;
          if (!item.status && !item.rating && !item.year && !item.note) continue;
          const cur = out.places[id];
          if (cur && RANK[cur.status] > RANK[item.status]) item.status = cur.status;
          out.places[id] = Object.assign({}, cur, item);
        }
        return out;
      }
      const list = Array.isArray(o.marks) ? o.marks : Array.isArray(o.v) ? o.v : null;
      if (list) {
        out.kind = 'atlas1-file'; ownerOf(o);
        for (const x of list) { const id = accept(x); if (id) putStatus(id, 1); }
        return out;
      }
      return null;
    }
    function fromCode2(s) {                 // b=FRA,US-CA;w=JPN
      out.kind = 'atlas2-code';
      for (const part of s.split(';')) {
        const m = part.match(/^\s*([a-z]+)\s*=(.*)$/i);
        if (!m) { if (part.trim()) out.unknown++; continue; }
        const s2 = m[1].toLowerCase() === 'b' ? 1 : m[1].toLowerCase() === 'w' ? 2 : 0;
        for (const tok of m[2].split(/[\s,]+/)) {
          if (!tok) continue;
          if (!s2) { out.unknown++; continue; }
          const id = accept(tok); if (id) putStatus(id, s2);
        }
      }
      return out;
    }
    function fromCode1(s) {                 // FRA,US-CA (commas, spaces or semicolons)
      out.kind = 'atlas1-code';
      for (const tok of s.split(/[\s,;]+/)) { const id = accept(tok); if (id) putStatus(id, 1); }
      return out;
    }

    if (isObj(input)) return fromObject(input);
    const text = String(input == null ? '' : input).replace(/^﻿/, '').trim();
    if (!text) return null;
    if (text[0] === '{') {
      let o = null; try { o = JSON.parse(text); } catch (_) {}
      const r = o && fromObject(o);
      if (r) return r;
    }
    let at = text.search(/atlas2:/i);
    if (at >= 0) return fromCode2(text.slice(at + 7));
    at = text.search(/atlas1:/i);
    return fromCode1(at >= 0 ? text.slice(at + 7) : text);
  }

  // Known-id test for restore reporting: a known place, or (while cities aren't loaded yet)
  // anything shaped like a city id.
  function makeIsKnown(has, citiesLoaded) {
    return id => !!has(id) || (!citiesLoaded && CITY_RE.test(id));
  }
  function backupFileName(date) {
    const d = date || new Date(), pad = n => String(n).padStart(2, '0');
    return `travel-atlas-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
  }

  // ---------- the store ----------
  // opts.storage: localStorage-like (default: localStorage). opts.now: () => ms (default Date.now).
  function create(opts) {
    opts = opts || {};
    const now = typeof opts.now === 'function' ? () => Math.floor(opts.now()) : () => Date.now();
    const ls = wrapStorage(opts.storage);
    const listeners = new Set();
    let doc = emptyDoc(), saveOk = true, loadedFrom = '';

    // a new edit's t: now, but always after the entry's previous t (clocks can step back)
    const stamp = prevT => Math.max(now(), (prevT || 0) + 1);

    function emit(info) {
      for (const fn of [...listeners]) { try { fn(info); } catch (_) {} }
    }
    function readObj(k, badKey) {
      const raw = ls.get(k);
      if (raw == null) return null;
      try { const o = JSON.parse(raw); if (isObj(o)) return o; } catch (_) {}
      if (badKey && ls.get(badKey) !== raw) ls.set(badKey, raw);
      return null;
    }

    // One-time conversion of the v1 keys (run when :v2 is missing or unreadable).
    function migrate() {
      const d = emptyDoc();
      const v1 = readObj(KEYS.v1, KEYS.v1bad) || {};
      const clock = readObj(KEYS.clock) || {};
      const tOf = id => { const t = Math.floor(+clock[id]); return validT(t) ? t : 0; };
      for (const id in v1) if (v1[id] && validId(id)) d.places[id] = [1, tOf(id) || 1];   // t = 1: marked before sync
      for (const id in clock) if (!d.places[id] && validId(id) && tOf(id)) d.places[id] = [0, tOf(id)];
      const name = cleanName(ls.get(KEYS.owner) || '');
      const ot = Math.floor(+(ls.get(KEYS.ownerT) || 0));
      d.owner = [name, validT(ot) ? ot : name ? 1 : 0];
      for (const id in d.places) d.dirty['p:' + id] = 1;
      if (d.owner[1]) d.dirty.o = 1;
      const link = readObj(KEYS.link);
      if (link && own(link, 'rev')) { delete link.rev; ls.set(KEYS.link, JSON.stringify(link)); }
      return d;
    }

    // Read :v2 (or migrate). Returns 'v2' | 'migrated' | 'recovered'.
    function load() {
      const raw = ls.get(KEYS.v2);
      if (raw != null) {
        let d = null;
        try { d = sanitizeDoc(JSON.parse(raw)); } catch (_) {}
        if (d) { doc = d; loadedFrom = 'v2'; return loadedFrom; }
        if (ls.get(KEYS.bad) !== raw) ls.set(KEYS.bad, raw);
        loadedFrom = 'recovered';
      } else loadedFrom = 'migrated';
      doc = migrate();
      save();
      return loadedFrom;
    }

    // Write :v2, then mirror been ids to :v1 and the name to :owner. False if storage refused.
    function save() {
      saveOk = ls.set(KEYS.v2, JSON.stringify(doc));
      if (saveOk) {
        const v1 = {};
        for (const id of Object.keys(doc.places).sort()) if (doc.places[id][0] === 1) v1[id] = true;
        ls.set(KEYS.v1, JSON.stringify(v1));
        if (doc.owner[0]) ls.set(KEYS.owner, doc.owner[0]); else ls.remove(KEYS.owner);
      }
      return saveOk;
    }

    // Another tab wrote :v2 (storage event): re-read it. True if anything visible changed.
    function reload() {
      const before = JSON.stringify([doc.places, doc.notes, doc.owner]);
      if (ls.get(KEYS.v2) == null) load();
      else {
        let d = null;
        try { d = sanitizeDoc(JSON.parse(ls.get(KEYS.v2))); } catch (_) {}
        if (!d) return false;                    // half-written or foreign value: keep what we have
        doc = d;
      }
      const changed = before !== JSON.stringify([doc.places, doc.notes, doc.owner]);
      if (changed) emit({ source: 'reload', ids: null, owner: true });
      return changed;
    }

    // ---------- status ----------
    function checkId(id) { if (!validId(id)) throw new TypeError('Bad place id: ' + String(id).slice(0, 24)); return id; }
    function getStatus(id) { const e = doc.places[id]; return e ? e[0] : 0; }
    function putStatus(id, s) {                 // raw write + dirty; no save/emit
      const cur = doc.places[id];
      doc.places[id] = [s, stamp(cur && cur[1])];
      doc.dirty['p:' + id] = 1;
    }
    function setStatus(id, s) {
      checkId(id);
      if (!validS(s)) throw new RangeError('Status must be 0, 1 or 2.');
      if (getStatus(id) === s) return false;
      putStatus(id, s); save();
      emit({ source: 'local', ids: [id], owner: false });
      return true;
    }
    // plan-ux §2.1 tap rules. mode 'been': none/want -> been, been -> none.
    // mode 'want': none -> want, want -> none, been -> unchanged (blocked: the app toasts "Already been").
    function tap(id, mode) {
      const from = getStatus(id);
      let to;
      if (mode === 'want') to = from === 0 ? 2 : from === 2 ? 0 : 1;
      else to = from === 1 ? 0 : 1;
      const changed = to !== from && setStatus(id, to);
      return { from, to, changed: !!changed, blocked: mode === 'want' && from === 1 };
    }

    // ---------- notes ----------
    function getNotes(id) {
      const n = doc.notes[id];
      return notesEmpty(n) ? null : { rating: n[0], year: n[1], note: n[2] };
    }
    function noteCount() { let c = 0; for (const id in doc.notes) if (!notesEmpty(doc.notes[id])) c++; return c; }
    function putNotes(id, n) {                  // n = [r, y, text]; raw write + dirty
      const cur = doc.notes[id];
      doc.notes[id] = [n[0], n[1], n[2], stamp(cur && cur[3])];
      doc.dirty['n:' + id] = 1;
    }
    // patch: {rating?, year?, note?}; missing fields keep their value. Bad rating/year -> RangeError;
    // the note is cleaned and cut to 500. A 1001st non-empty note -> Error with code 'too_many_notes'.
    function setNotes(id, patch) {
      checkId(id);
      patch = patch || {};
      const cur = doc.notes[id] || [0, 0, '', 0];
      const r = patch.rating === undefined ? cur[0] : patch.rating;
      const y = patch.year === undefined ? cur[1] : patch.year;
      if (!validRating(r)) throw new RangeError('Rating must be an integer 0–5.');
      if (!validYear(y, now())) throw new RangeError(`Year must be 0 or ${LIMITS.firstYear}–${maxYear(now())}.`);
      const next = [r, y, patch.note === undefined ? cur[2] : cleanNote(patch.note)];
      if (sameNotes(cur, next)) return false;
      if (notesEmpty(cur) && noteCount() >= LIMITS.notes) {
        const e = new Error(`At most ${LIMITS.notes} notes.`); e.code = 'too_many_notes'; throw e;
      }
      putNotes(id, next); save();
      emit({ source: 'local', ids: [id], owner: false });
      return true;
    }
    function clearNotes(id) { return setNotes(id, { rating: 0, year: 0, note: '' }); }

    // ---------- owner ----------
    function getOwner() { return doc.owner[0]; }
    function setOwner(name) {
      const n = cleanName(name);
      if (n === doc.owner[0]) return false;
      doc.owner = [n, stamp(doc.owner[1])]; doc.dirty.o = 1; save();
      emit({ source: 'local', ids: [], owner: true });
      return true;
    }

    // ---------- lists ----------
    function ids(s) { return Object.keys(doc.places).filter(id => doc.places[id][0] === s).sort(); }
    function noteIds() { return Object.keys(doc.notes).filter(id => !notesEmpty(doc.notes[id])).sort(); }
    // filter(id) optional, e.g. "only places on this map"
    function counts(filter) {
      const c = { been: 0, want: 0, notes: 0 };
      for (const id in doc.places) {
        if (filter && !filter(id)) continue;
        const s = doc.places[id][0];
        if (s === 1) c.been++; else if (s === 2) c.want++;
      }
      for (const id in doc.notes) if (!notesEmpty(doc.notes[id]) && (!filter || filter(id))) c.notes++;
      return c;
    }

    // ---------- sync ----------
    // Request bodies for POST /sync: only dirty entries, or everything with {full: true}.
    // Always at least one chunk (an empty one is a plain poll). opts.since is copied into each
    // chunk; the app normally overwrites it with link.rev before sending each one.
    function outgoing(o) {
      o = o || {};
      const full = !!o.full, chunks = [];
      const base = () => (o.since != null ? { since: o.since } : {});
      let cur = base(), np = 0, nn = 0, bytes = 64;
      const flush = () => { chunks.push(cur); cur = base(); np = nn = 0; bytes = 64; };
      const fits = (size, isNote) => (isNote ? nn < LIMITS.chunkNotes : np < LIMITS.chunkPlaces) && bytes + size <= LIMITS.chunkBytes;
      if (doc.owner[1] > 0 && (full || doc.dirty.o)) { cur.owner = [doc.owner[0], doc.owner[1]]; bytes += utf8Len(JSON.stringify(cur.owner)) + 10; }
      const pick = (map, prefix) => Object.keys(map).filter(id => full || doc.dirty[prefix + id]).sort();
      for (const id of pick(doc.places, 'p:')) {
        const e = [doc.places[id][0], doc.places[id][1]];
        const size = utf8Len(JSON.stringify(id)) + utf8Len(JSON.stringify(e)) + 2;
        if (!fits(size, false)) flush();
        (cur.places || (cur.places = {}))[id] = e; np++; bytes += size;
      }
      for (const id of pick(doc.notes, 'n:')) {
        const n = doc.notes[id], e = [n[0], n[1], n[2], n[3]];
        const size = utf8Len(JSON.stringify(id)) + utf8Len(JSON.stringify(e)) + 2;
        if (!fits(size, true)) flush();
        (cur.notes || (cur.notes = {}))[id] = e; nn++; bytes += size;
      }
      flush();                                   // a chunk only overflows once it holds something
      return chunks;
    }
    function isDirty() { return Object.keys(doc.dirty).length > 0; }

    // Adopt a server response into doc. No save/emit. Returns {ids, owner}.
    function adoptInto(r) {
      const touched = new Set();
      let ownerChanged = false;
      if (isObj(r.places)) for (const id in r.places) {
        const e = r.places[id];
        if (!validId(id) || !Array.isArray(e) || !validS(e[0]) || !validT(e[1])) continue;
        const cur = doc.places[id];
        if (cur && e[1] < cur[1]) continue;          // newer local edit: stays dirty, goes up next sync
        if (getStatus(id) !== e[0]) touched.add(id);
        doc.places[id] = [e[0], e[1]];
        delete doc.dirty['p:' + id];
      }
      if (isObj(r.notes)) for (const id in r.notes) {
        const e = r.notes[id];
        if (!validId(id) || !Array.isArray(e) || !validT(e[3])) continue;
        if (!validRating(e[0]) || !storedYear(e[1]) || typeof e[2] !== 'string') continue;
        const cur = doc.notes[id];
        if (cur && e[3] < cur[3]) continue;
        const next = [e[0], e[1], cleanNote(e[2]), e[3]];
        if (!sameNotes(cur, next)) touched.add(id);
        doc.notes[id] = next;
        delete doc.dirty['n:' + id];
      }
      const rt = r.ownerT == null ? 0 : +r.ownerT;
      if (typeof r.owner === 'string' && Number.isSafeInteger(rt) && rt >= 0 && rt >= doc.owner[1]) {
        const n = cleanName(r.owner);
        if (n !== doc.owner[0]) ownerChanged = true;
        doc.owner = [n, rt];
        delete doc.dirty.o;
      }
      return { ids: [...touched].sort(), owner: ownerChanged };
    }
    function finish(res, source, rev) {
      save();
      if (res.ids.length || res.owner) emit({ source, ids: res.ids, owner: res.owner });
      return { ids: res.ids, owner: res.owner, changed: res.ids.length > 0 || res.owner, rev: Number.isSafeInteger(rev) ? rev : null };
    }
    // Client adopt rule: take a remote entry if its t >= local t (equal t: the server's value wins).
    function adopt(response) {
      if (!isObj(response)) return { ids: [], owner: false, changed: false, rev: null };
      return finish(adoptInto(response), 'remote', response.rev);
    }
    // After a successful sync of `chunk`: clear dirty flags whose entry still has the t that was
    // sent (an edit made while the request was out stays dirty), then adopt the response.
    function ack(chunk, response) {
      chunk = chunk || {};
      if (isObj(chunk.places)) for (const id in chunk.places) {
        const e = doc.places[id];
        if (e && e[1] === chunk.places[id][1]) delete doc.dirty['p:' + id];
      }
      if (isObj(chunk.notes)) for (const id in chunk.notes) {
        const n = doc.notes[id];
        if (n && n[3] === chunk.notes[id][3]) delete doc.dirty['n:' + id];
      }
      if (Array.isArray(chunk.owner) && doc.owner[1] === chunk.owner[1]) delete doc.dirty.o;
      const res = isObj(response) ? adoptInto(response) : { ids: [], owner: false };
      return finish(res, 'remote', isObj(response) ? response.rev : null);
    }
    // Switching to another map: the device becomes exactly that map; nothing is dirty.
    // (The app also drops link.rev.)
    function replaceAll(response) {
      const old = doc;
      doc = emptyDoc();
      adoptInto(isObj(response) ? response : {});
      doc.dirty = {};
      const touched = new Set();
      for (const id of new Set([...Object.keys(old.places), ...Object.keys(doc.places)])) {
        if ((old.places[id] ? old.places[id][0] : 0) !== getStatus(id)) touched.add(id);
      }
      for (const id of new Set([...Object.keys(old.notes), ...Object.keys(doc.notes)])) {
        if (!sameNotes(old.notes[id], doc.notes[id])) touched.add(id);
      }
      const res = { ids: [...touched].sort(), owner: old.owner[0] !== doc.owner[0] };
      return finish(res, 'remote', isObj(response) ? response.rev : null);
    }

    // ---------- backup ----------
    // atlas2 code: been and want only, ids sorted, empty sections left out.
    function makeCode() {
      const parts = [];
      const b = ids(1), w = ids(2);
      if (b.length) parts.push('b=' + b.join(','));
      if (w.length) parts.push('w=' + w.join(','));
      return 'atlas2:' + parts.join(';');
    }
    // atlas2 backup file object (no timestamps). owner defaults to the stored name.
    function makeFile(owner) {
      const places = {};
      for (const id of new Set([...Object.keys(doc.places), ...Object.keys(doc.notes)])) {
        const s = getStatus(id), n = getNotes(id);
        if (!s && !n) continue;
        const e = {};
        if (s) e.status = STATUS_NAME[s];
        if (n && n.rating) e.rating = n.rating;
        if (n && n.year) e.year = n.year;
        if (n && n.note) e.note = n.note;
        places[id] = e;
      }
      const sorted = {};
      for (const id of Object.keys(places).sort()) sorted[id] = places[id];
      return { format: 'atlas2', savedAt: new Date(now()).toISOString(), owner: owner === undefined ? doc.owner[0] : cleanName(owner), places: sorted };
    }
    function snapshot() { return JSON.stringify(doc); }

    // Apply parseBackup() output. Add (default): never downgrade or remove; notes fill only empty
    // items; owner only if none. Replace: the device becomes exactly the backup; everything else
    // becomes status 0 (and, for a file, empty notes) at t = now. A code (mapOnly) carries no
    // notes, so Replace from a code leaves notes alone.
    function restore(parsed, o) {
      const replace = !!(o && o.replace);
      const snap = snapshot();
      const res = { added: 0, removed: 0, changed: 0, notesAdded: 0, notesSkipped: 0, ownerSet: false, replaced: replace, snapshot: snap };
      const touched = new Set();
      const inc = (parsed && isObj(parsed.places)) ? parsed.places : {};
      const withNotes = !!parsed && parsed.mapOnly === false;
      for (const id in inc) {
        if (!validId(id)) continue;
        const item = inc[id] || {};
        const s = validS(item.status) ? item.status : 0, cs = getStatus(id);
        const target = replace ? s : (RANK[s] > RANK[cs] ? s : cs);
        if (target !== cs) {
          putStatus(id, target); touched.add(id); res.changed++;
          if (target === 0) res.removed++; else if (RANK[target] > RANK[cs]) res.added++;
        }
        const n = [validRating(item.rating) ? item.rating : 0, validYear(item.year, now()) ? item.year : 0, item.note ? cleanNote(item.note) : ''];
        const cur = doc.notes[id];
        if (replace ? withNotes && !sameNotes(cur, n) : notesEmpty(cur) && !notesEmpty(n)) {
          if (notesEmpty(cur) && noteCount() >= LIMITS.notes) { res.notesSkipped++; continue; }
          putNotes(id, n); touched.add(id);
          if (!notesEmpty(n)) res.notesAdded++;
        }
      }
      if (replace) {
        for (const id in doc.places) if (!own(inc, id) && doc.places[id][0] !== 0) {
          putStatus(id, 0); touched.add(id); res.removed++; res.changed++;
        }
        if (withNotes) for (const id in doc.notes) if (!own(inc, id) && !notesEmpty(doc.notes[id])) {
          putNotes(id, [0, 0, '']); touched.add(id);
        }
      }
      const name = parsed && typeof parsed.owner === 'string' ? cleanName(parsed.owner) : '';
      if (name && name !== doc.owner[0] && (replace || !doc.owner[0])) {
        doc.owner = [name, stamp(doc.owner[1])]; doc.dirty.o = 1; res.ownerSet = true;
      }
      res.total = ids(1).length + ids(2).length;
      save();
      if (touched.size || res.ownerSet) emit({ source: 'restore', ids: [...touched].sort(), owner: res.ownerSet });
      return res;
    }

    // Put back the values of a snapshot from restore(). Entries whose value differs from now are
    // re-stamped at t = now and marked dirty, so the undo also wins on the server.
    function undo(snap) {
      let d = null;
      try { d = sanitizeDoc(JSON.parse(snap)); } catch (_) {}
      if (!d) return false;
      const touched = new Set();
      for (const id of new Set([...Object.keys(doc.places), ...Object.keys(d.places)])) {
        const want = d.places[id] ? d.places[id][0] : 0;
        if (getStatus(id) !== want) { putStatus(id, want); touched.add(id); }
      }
      for (const id of new Set([...Object.keys(doc.notes), ...Object.keys(d.notes)])) {
        const want = d.notes[id] || [0, 0, ''];
        if (!sameNotes(doc.notes[id], want)) { putNotes(id, [want[0], want[1], want[2]]); touched.add(id); }
      }
      let ownerChanged = false;
      if (d.owner[0] !== doc.owner[0]) { doc.owner = [d.owner[0], stamp(doc.owner[1])]; doc.dirty.o = 1; ownerChanged = true; }
      for (const k in d.dirty) doc.dirty[k] = 1;   // whatever was waiting to sync still is
      save();
      if (touched.size || ownerChanged) emit({ source: 'undo', ids: [...touched].sort(), owner: ownerChanged });
      return true;
    }

    // /#import=atlas1:…&owner=… from the old address's forwarding page: atlas1 (or a bare list)
    // only, merged with Add; the owner name is used only if this device has none.
    function importCode(code, o) {
      o = o || {};
      let s = String(code == null ? '' : code).trim();
      if (/^atlas2:/i.test(s)) s = '';          // the forwarding page only ever sends atlas1
      const parsed = s ? parseBackup(/^atlas1:/i.test(s) ? s : 'atlas1:' + s, { isKnown: o.isKnown, now: now() }) : null;
      const found = parsed ? Object.keys(parsed.places).length : 0;
      const p = parsed || { places: {}, mapOnly: true };
      if (o.owner) p.owner = o.owner;
      const r = restore(p, { replace: false });
      return { added: r.added, found, unknown: parsed ? parsed.unknown : 0, ownerSet: r.ownerSet };
    }

    function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

    load();
    return {
      load, save, reload, snapshot,
      get loadedFrom() { return loadedFrom; },
      get saveOk() { return saveOk; },
      getStatus, setStatus, tap,
      getNotes, setNotes, clearNotes,
      getOwner, setOwner,
      ids, noteIds, counts,
      outgoing, ack, adopt, replaceAll, isDirty,
      makeCode, makeFile, restore, undo, importCode,
      parseBackup: (input, o2) => parseBackup(input, Object.assign({ now: now() }, o2)),
      onChange,
    };
  }

  return { create, parseBackup, makeIsKnown, backupFileName, cleanNote, cleanName, KEYS, LIMITS, ID_RE, CITY_RE };
});
