// Travel Atlas: client data store js/store.js (docs/plan-data-sync.md, "Client (localStorage)",
// "Merge rules", "Backup", "Limits"). Node-only: no browser, no server. The classic script is
// evaluated with a fake `module` (the repo is "type": "module", so require() would treat it as ESM),
// and every store gets an in-memory storage and a hand-driven clock.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '..', 'js', 'store.js'), 'utf8');

function loadModule() {
  const mod = { exports: {} };
  new Function('module', 'self', SRC)(mod, undefined);
  return mod.exports;
}
const S = loadModule();
const K = S.KEYS;
const T0 = 1_800_000_000_000;      // 2027-01-15

// localStorage stand-in; `fail` makes writes (or reads) throw like a blocked / full storage
function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  const writes = [];
  return {
    m, writes, failSet: false, failGet: false,
    getItem(k) { if (this.failGet) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (this.failSet) throw new Error('QuotaExceededError'); writes.push(k); m.set(k, String(v)); },
    removeItem(k) { if (this.failSet) throw new Error('blocked'); m.delete(k); },
  };
}
function clock(t) { const c = { t: t || T0 }; c.now = () => c.t; return c; }
function fresh(init, t) {
  const storage = memStorage(init), c = clock(t);
  const store = S.create({ storage, now: c.now });
  return { store, storage, c, doc: () => JSON.parse(storage.m.get(K.v2)) };
}
const json = v => JSON.stringify(v);
const utf8 = s => Buffer.byteLength(s, 'utf8');

// ---------- loading ----------

test.describe('module', () => {
  test('defines window.AtlasStore as a classic script and module.exports in Node', () => {
    const win = {};
    new Function('module', 'self', SRC)(undefined, win);
    expect(typeof win.AtlasStore.create).toBe('function');
    expect(typeof S.create).toBe('function');
    expect(S.CITY_RE.test('C-2988507')).toBe(true);
    expect(S.CITY_RE.test('C-1234567890123')).toBe(false);
  });

  test('an empty device starts empty and writes an empty :v2', () => {
    const { store, doc } = fresh();
    expect(store.loadedFrom).toBe('migrated');
    expect(doc()).toEqual({ v: 2, places: {}, notes: {}, owner: ['', 0], dirty: {} });
    expect(store.outgoing()).toEqual([{}]);
    expect(store.isDirty()).toBe(false);
  });
});

// ---------- migration ----------

test.describe('migration from v1', () => {
  const V1 = {
    [K.v1]: json({ FRA: true, 'US-CA': true, 'C-2988507': true, JPN: false }),
    [K.clock]: json({ FRA: 1_700_000_000_123.7, DEU: 1_700_000_000_500, ITA: 0 }),
    [K.owner]: 'Sam  Doe',
    [K.ownerT]: '1700000000999',
    [K.link]: json({ id: 'sam-abcde', editKey: 'k', name: 'Sam', synced: 5, rev: 42 }),
    'travel-atlas:t': '123',
  };

  test('v1 + clock + owner -> v2 (t = 1 for pre-sync marks, tombstones from the clock)', () => {
    const { store, storage, doc } = fresh(V1);
    expect(store.loadedFrom).toBe('migrated');
    const d = doc();
    expect(d.places).toEqual({
      FRA: [1, 1_700_000_000_123],      // clock t, floored
      'US-CA': [1, 1],                  // marked before sync existed
      'C-2988507': [1, 1],              // a city id nobody has loaded: kept
      DEU: [0, 1_700_000_000_500],      // toggled off here once: a removal that must still win
    });
    expect(d.notes).toEqual({});
    expect(d.owner).toEqual(['Sam Doe', 1_700_000_000_999]);
    expect(Object.keys(d.dirty).sort()).toEqual(['o', 'p:C-2988507', 'p:DEU', 'p:FRA', 'p:US-CA']);
    // link.rev dropped so the next sync is a full one; the rest of the link is untouched
    expect(JSON.parse(storage.m.get(K.link))).toEqual({ id: 'sam-abcde', editKey: 'k', name: 'Sam', synced: 5 });
    // the old keys are left as they were
    expect(storage.m.get(K.clock)).toBe(V1[K.clock]);
    expect(storage.m.get(K.ownerT)).toBe(V1[K.ownerT]);
    expect(storage.m.get('travel-atlas:t')).toBe('123');
    expect(store.getStatus('FRA')).toBe(1);
    expect(store.getStatus('DEU')).toBe(0);
    expect(store.getOwner()).toBe('Sam Doe');
  });

  test('owner without ownerT gets t = 1; no owner gets t = 0 and is not sent', () => {
    let { doc } = fresh({ [K.owner]: 'Ana' });
    expect(doc().owner).toEqual(['Ana', 1]);
    expect(doc().dirty).toEqual({ o: 1 });
    ({ doc } = fresh({ [K.v1]: json({ FRA: true }) }));
    expect(doc().owner).toEqual(['', 0]);
    const s = fresh({ [K.v1]: json({ FRA: true }) }).store;
    expect(s.outgoing()).toEqual([{ places: { FRA: [1, 1] } }]);
  });

  test('migration runs once: a second load reads :v2 and ignores later v1 writes', () => {
    const a = fresh(V1);
    const first = a.storage.m.get(K.v2);
    a.storage.m.set(K.clock, json({ FRA: 1_900_000_000_000 }));   // an old tab still writing v1 keys
    const b = S.create({ storage: a.storage, now: a.c.now });
    expect(b.loadedFrom).toBe('v2');
    expect(a.storage.m.get(K.v2)).toBe(first);
    expect(b.snapshot()).toBe(first);
    // and a link with a fresh rev (written after migrating) keeps it
    a.storage.m.set(K.link, json({ id: 'x', editKey: 'k', rev: 7 }));
    S.create({ storage: a.storage, now: a.c.now });
    expect(JSON.parse(a.storage.m.get(K.link)).rev).toBe(7);
  });

  test('an unreadable :v1 is parked in :v1.bad and the migration starts empty', () => {
    const { store, storage } = fresh({ [K.v1]: '{oops' });
    expect(storage.m.get(K.v1bad)).toBe('{oops');
    expect(store.ids(1)).toEqual([]);
  });

  test('unparseable :v2 is copied to :v2.bad and rebuilt from the v1 keys', () => {
    for (const bad of ['{"v":2,"places":', '[1,2]', json({ v: 3, places: {} }), 'null']) {
      const { store, storage, doc } = fresh({ ...V1, [K.v2]: bad });
      expect(store.loadedFrom).toBe('recovered');
      expect(storage.m.get(K.bad)).toBe(bad);
      expect(doc().places.FRA).toEqual([1, 1_700_000_000_123]);
      expect(JSON.parse(storage.m.get(K.link)).rev).toBeUndefined();
    }
  });

  test('malformed entries inside a good :v2 are dropped one by one', () => {
    const stored = {
      v: 2,
      places: { FRA: [1, 5], bad: [1, 5], DEU: [3, 5], ITA: [1, -1], ESP: 'x', 'C-1': [2, 9] },
      notes: { FRA: [4, 2019, 'ok', 6], DEU: [9, 0, '', 6], ITA: [0, 0, 'x', 0] },
      owner: ['Sam', 3], dirty: { 'p:FRA': 1, junk: 1 },
    };
    const { store } = fresh({ [K.v2]: json(stored) });
    expect(store.loadedFrom).toBe('v2');
    expect(JSON.parse(store.snapshot())).toEqual({
      v: 2, places: { FRA: [1, 5], 'C-1': [2, 9] }, notes: { FRA: [4, 2019, 'ok', 6] }, owner: ['Sam', 3], dirty: { 'p:FRA': 1 },
    });
  });
});

// ---------- saving ----------

test.describe('saving', () => {
  test('mirrors been ids to :v1 and the name to :owner; never writes :clock / :ownerT', () => {
    const { store, storage } = fresh();
    store.setStatus('FRA', 1); store.setStatus('JPN', 2); store.setStatus('C-1850147', 1);
    store.setOwner('Sam');
    expect(JSON.parse(storage.m.get(K.v1))).toEqual({ 'C-1850147': true, FRA: true });   // want is not "visited"
    expect(storage.m.get(K.owner)).toBe('Sam');
    store.setStatus('FRA', 0);
    expect(JSON.parse(storage.m.get(K.v1))).toEqual({ 'C-1850147': true });
    store.setOwner('  ');
    expect(storage.m.has(K.owner)).toBe(false);
    expect(storage.writes).not.toContain(K.clock);
    expect(storage.writes).not.toContain(K.ownerT);
  });

  test('blocked storage: edits still work in memory and saveOk turns false', () => {
    const { store, storage } = fresh();
    storage.failSet = true;
    expect(store.setStatus('FRA', 1)).toBe(true);
    expect(store.saveOk).toBe(false);
    expect(store.getStatus('FRA')).toBe(1);
    storage.failSet = false;
    expect(store.save()).toBe(true);
    expect(JSON.parse(storage.m.get(K.v2)).places.FRA[0]).toBe(1);
    // reads throwing at startup: an empty in-memory store
    const s2 = memStorage(); s2.failGet = true; s2.failSet = true;
    const st = S.create({ storage: s2, now: () => T0 });
    expect(st.ids(1)).toEqual([]);
    expect(st.saveOk).toBe(false);
  });

  test('reload() picks up another tab writing :v2', () => {
    const a = fresh();
    const b = S.create({ storage: a.storage, now: a.c.now });
    const seen = [];
    b.onChange(e => seen.push(e.source));
    a.store.setStatus('PER', 2);
    expect(b.getStatus('PER')).toBe(0);
    expect(b.reload()).toBe(true);
    expect(b.getStatus('PER')).toBe(2);
    expect(seen).toEqual(['reload']);
    expect(b.reload()).toBe(false);                       // nothing new
    a.storage.m.set(K.v2, '{"v":2,"pla');                 // half-written value: keep what we have
    expect(b.reload()).toBe(false);
    expect(b.getStatus('PER')).toBe(2);
  });
});

// ---------- status ----------

test.describe('status', () => {
  test('set/get, no-op, tombstones and dirty flags', () => {
    const { store, c, doc } = fresh();
    expect(store.getStatus('FRA')).toBe(0);
    expect(store.setStatus('FRA', 0)).toBe(false);        // nothing to remove: no entry made
    expect(doc().places).toEqual({});
    expect(store.setStatus('FRA', 2)).toBe(true);
    expect(store.setStatus('FRA', 2)).toBe(false);
    c.t += 10;
    expect(store.setStatus('FRA', 1)).toBe(true);
    expect(doc().places.FRA).toEqual([1, T0 + 10]);
    c.t += 10;
    store.setStatus('FRA', 0);
    expect(doc().places.FRA).toEqual([0, T0 + 20]);       // kept as a tombstone
    expect(doc().dirty).toEqual({ 'p:FRA': 1 });
    expect(store.getStatus('FRA')).toBe(0);
  });

  test('t always moves forward, even when the clock stands still or steps back', () => {
    const { store, c, doc } = fresh();
    store.setStatus('FRA', 1);
    store.setStatus('FRA', 0);
    store.setStatus('FRA', 2);
    expect(doc().places.FRA).toEqual([2, T0 + 2]);
    c.t = T0 - 50_000;
    store.setStatus('FRA', 1);
    expect(doc().places.FRA).toEqual([1, T0 + 3]);
  });

  test('bad ids and statuses throw; unknown but well-formed ids are kept', () => {
    const { store } = fresh();
    expect(() => store.setStatus('fra', 1)).toThrow(TypeError);
    expect(() => store.setStatus('', 1)).toThrow(TypeError);
    expect(() => store.setStatus('FRA', 3)).toThrow(RangeError);
    expect(() => store.setStatus('FRA', '1')).toThrow(RangeError);
    store.setStatus('C-999999999999', 2);
    store.setStatus('ZZZ', 1);
    expect(store.ids(2)).toEqual(['C-999999999999']);
    expect(store.ids(1)).toEqual(['ZZZ']);
  });

  test('tap() follows the plan-ux §2.1 table', () => {
    const { store } = fresh();
    const tap = (from, mode) => {
      if (from) store.setStatus('PER', from); else store.setStatus('PER', 0);
      const r = store.tap('PER', mode);
      return [r.to, store.getStatus('PER'), r.blocked];
    };
    expect(tap(0, 'been')).toEqual([1, 1, false]);
    expect(tap(2, 'been')).toEqual([1, 1, false]);
    expect(tap(1, 'been')).toEqual([0, 0, false]);
    expect(tap(0, 'want')).toEqual([2, 2, false]);
    expect(tap(2, 'want')).toEqual([0, 0, false]);
    expect(tap(1, 'want')).toEqual([1, 1, true]);        // "Already been to Peru"
    store.setStatus('PER', 1);
    expect(store.tap('PER', 'want').changed).toBe(false);
  });

  test('lists, counts and change events', () => {
    const { store } = fresh();
    const events = [];
    const off = store.onChange(e => events.push(e));
    store.setStatus('US-CA', 1); store.setStatus('FRA', 1); store.setStatus('JPN', 2); store.setStatus('DEU', 1); store.setStatus('DEU', 0);
    store.setNotes('JPN', { note: 'cherry blossoms' });
    expect(store.ids(1)).toEqual(['FRA', 'US-CA']);
    expect(store.ids(2)).toEqual(['JPN']);
    expect(store.ids(0)).toEqual(['DEU']);
    expect(store.noteIds()).toEqual(['JPN']);
    expect(store.counts()).toEqual({ been: 2, want: 1, notes: 1 });
    expect(store.counts(id => id.startsWith('US-'))).toEqual({ been: 1, want: 0, notes: 0 });
    expect(events.map(e => [e.source, e.ids.join()])).toEqual([
      ['local', 'US-CA'], ['local', 'FRA'], ['local', 'JPN'], ['local', 'DEU'], ['local', 'DEU'], ['local', 'JPN'],
    ]);
    off();
    store.setStatus('ITA', 1);
    expect(events.length).toBe(6);
    store.onChange(() => { throw new Error('a bad listener'); });
    expect(() => store.setStatus('ESP', 1)).not.toThrow();
  });
});

// ---------- notes ----------

test.describe('notes', () => {
  test('rating, year and note are validated per the plan limits', () => {
    const { store } = fresh();
    const next = new Date(T0).getFullYear() + 1;
    expect(() => store.setNotes('FRA', { rating: 6 })).toThrow(RangeError);
    expect(() => store.setNotes('FRA', { rating: -1 })).toThrow(RangeError);
    expect(() => store.setNotes('FRA', { rating: 2.5 })).toThrow(RangeError);
    expect(() => store.setNotes('FRA', { year: 1899 })).toThrow(RangeError);
    expect(() => store.setNotes('FRA', { year: next + 1 })).toThrow(RangeError);
    expect(() => store.setNotes('FRA', { year: '2019' })).toThrow(RangeError);
    expect(store.getNotes('FRA')).toBeNull();
    expect(store.setNotes('FRA', { rating: 5, year: next })).toBe(true);
    expect(store.getNotes('FRA')).toEqual({ rating: 5, year: next, note: '' });
    expect(store.setNotes('FRA', { year: 1900 })).toBe(true);
    expect(store.getNotes('FRA')).toEqual({ rating: 5, year: 1900, note: '' });   // other fields kept
  });

  test('note text is cleaned: control/format chars, CRLF, newline runs, trim, 500 chars', () => {
    const { store } = fresh();
    store.setNotes('FRA', { note: '  Pa‮ris\u0000\r\nline2\n\n\n\n\n\nend​  ' });
    expect(store.getNotes('FRA').note).toBe('Paris\nline2\n\n\nend');
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';      // ZWJ sequence survives
    store.setNotes('FRA', { note: family });
    expect(store.getNotes('FRA').note).toBe(family);
    store.setNotes('FRA', { note: '\u{1F600}'.repeat(600) });         // counted in code points
    expect(Array.from(store.getNotes('FRA').note).length).toBe(500);
    expect(S.cleanNote('a\tb')).toBe('ab');
  });

  test('clearing leaves an empty tombstone; status and notes are independent', () => {
    const { store, c, doc } = fresh();
    store.setStatus('FRA', 1);
    store.setNotes('FRA', { rating: 4, note: 'croissants' });
    c.t += 5;
    store.setStatus('FRA', 0);
    expect(store.getNotes('FRA')).toEqual({ rating: 4, year: 0, note: 'croissants' });   // toggling never wipes notes
    expect(store.clearNotes('FRA')).toBe(true);
    expect(store.getNotes('FRA')).toBeNull();
    expect(doc().notes.FRA).toEqual([0, 0, '', T0 + 5]);
    expect(store.clearNotes('FRA')).toBe(false);
    expect(store.setNotes('FRA', { note: '   ' })).toBe(false);          // whitespace only = empty
    expect(Object.keys(doc().dirty).sort()).toEqual(['n:FRA', 'p:FRA']);
    expect(() => store.setNotes('bad id', { rating: 1 })).toThrow(TypeError);
  });

  test('at most 1000 non-empty notes; editing an existing one still works', () => {
    const notes = {};
    for (let i = 0; i < 1000; i++) notes['C-' + i] = [1, 0, '', 5];
    const { store } = fresh({ [K.v2]: json({ v: 2, places: {}, notes, owner: ['', 0], dirty: {} }) });
    let err = null;
    try { store.setNotes('FRA', { rating: 3 }); } catch (e) { err = e; }
    expect(err && err.code).toBe('too_many_notes');
    expect(store.setNotes('C-1', { rating: 2 })).toBe(true);
    store.clearNotes('C-2');
    expect(store.setNotes('FRA', { rating: 3 })).toBe(true);
  });

  test('owner name is cleaned, stamped and dirty', () => {
    const { store, c, doc } = fresh();
    expect(store.setOwner('  Sam‮   Doe ')).toBe(true);
    expect(store.getOwner()).toBe('Sam Doe');
    expect(store.setOwner('Sam Doe')).toBe(false);
    c.t += 1;
    store.setOwner('x'.repeat(60));
    expect(store.getOwner()).toBe('x'.repeat(40));
    expect(doc().owner).toEqual(['x'.repeat(40), T0 + 1]);
    expect(doc().dirty).toEqual({ o: 1 });
  });
});

// ---------- sync ----------

test.describe('sync: outgoing chunks', () => {
  test('only dirty entries, or everything with {full}; since is copied in', () => {
    const { store, doc } = fresh({
      [K.v2]: json({ v: 2, places: { FRA: [1, 5], DEU: [0, 6] }, notes: { FRA: [3, 0, 'x', 7] }, owner: ['Sam', 8], dirty: { 'p:DEU': 1 } }),
    });
    expect(store.outgoing()).toEqual([{ places: { DEU: [0, 6] } }]);
    expect(store.outgoing({ since: 12 })).toEqual([{ since: 12, places: { DEU: [0, 6] } }]);
    expect(store.outgoing({ full: true })).toEqual([{ owner: ['Sam', 8], places: { DEU: [0, 6], FRA: [1, 5] }, notes: { FRA: [3, 0, 'x', 7] } }]);
    store.ack(store.outgoing()[0]);
    expect(store.outgoing({ since: 3 })).toEqual([{ since: 3 }]);      // nothing dirty: a plain poll
    expect(doc().dirty).toEqual({});
  });

  test('≤ 1000 places and ≤ 200 notes per chunk; owner goes in the first', () => {
    const { store } = fresh();
    store.setOwner('Sam');
    for (let i = 0; i < 2500; i++) store.setStatus('C-' + i, 1 + (i % 2));
    for (let i = 0; i < 450; i++) store.setNotes('C-' + i, { rating: 1 + (i % 5) });
    const chunks = store.outgoing({ since: 9 });
    const np = chunks.map(c => Object.keys(c.places || {}).length);
    const nn = chunks.map(c => Object.keys(c.notes || {}).length);
    expect(np.every(n => n <= 1000)).toBe(true);
    expect(nn.every(n => n <= 200)).toBe(true);
    expect(np.reduce((a, b) => a + b)).toBe(2500);
    expect(nn.reduce((a, b) => a + b)).toBe(450);
    expect(chunks[0].owner).toEqual(['Sam', T0]);
    expect(chunks.slice(1).some(c => c.owner)).toBe(false);
    expect(chunks.every(c => c.since === 9)).toBe(true);
    for (const c of chunks) expect(utf8(json(c))).toBeLessThanOrEqual(100 * 1024);
  });

  test('chunks stay under ~100 KB even with long multi-byte notes', () => {
    const { store } = fresh();
    for (let i = 0; i < 200; i++) store.setNotes('C-' + i, { note: '\u{1F600}'.repeat(500) });   // ~2 KB each
    const chunks = store.outgoing();
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(utf8(json(c))).toBeLessThanOrEqual(100 * 1024);
    expect(chunks.reduce((a, c) => a + Object.keys(c.notes).length, 0)).toBe(200);
  });
});

test.describe('sync: ack and adopt', () => {
  test('ack clears only dirty flags whose t is unchanged since sending', () => {
    const { store, c, doc } = fresh();
    store.setStatus('FRA', 1); store.setStatus('JPN', 2); store.setNotes('FRA', { rating: 3 }); store.setOwner('Sam');
    const [chunk] = store.outgoing();
    c.t += 100;
    store.setStatus('JPN', 1);                 // edited while the request was out
    store.setNotes('FRA', { rating: 4 });
    store.setStatus('ITA', 1);                 // not in the chunk at all
    const r = store.ack(chunk, { rev: 5, places: {}, notes: {} });
    expect(r.rev).toBe(5);
    expect(Object.keys(doc().dirty).sort()).toEqual(['n:FRA', 'p:ITA', 'p:JPN']);
    const [next] = store.outgoing();
    expect(next).toEqual({ places: { ITA: [1, T0 + 100], JPN: [1, T0 + 100] }, notes: { FRA: [4, 0, '', T0 + 100] } });
    store.ack(next);
    expect(store.isDirty()).toBe(false);
  });

  test('adopt: remote newer is taken, equal t takes the server value, older keeps local and stays dirty', () => {
    const { store, doc } = fresh({
      [K.v2]: json({
        v: 2,
        places: { NEW: [1, 10], EQL: [1, 10], OLD: [2, 10] },
        notes: { NEW: [1, 0, 'a', 10], EQL: [1, 0, 'a', 10], OLD: [1, 0, 'a', 10] },
        owner: ['Sam', 10],
        dirty: { 'p:NEW': 1, 'p:EQL': 1, 'p:OLD': 1, 'n:NEW': 1, 'n:EQL': 1, 'n:OLD': 1, o: 1 },
      }),
    });
    const events = [];
    store.onChange(e => events.push(e));
    const r = store.adopt({
      rev: 9, owner: 'Samantha', ownerT: 10,
      places: { NEW: [0, 11, 9], EQL: [2, 10, 9], OLD: [0, 9, 9], 'C-5': [2, 3, 9], 'bad id': [1, 5, 9], X: [7, 5, 9] },
      notes: { NEW: [5, 2019, 'b', 11, 9], EQL: [2, 0, 'c', 10, 9], OLD: [0, 0, '', 9, 9] },
    });
    const d = doc();
    expect(d.places).toEqual({ NEW: [0, 11], EQL: [2, 10], OLD: [2, 10], 'C-5': [2, 3] });
    expect(d.notes).toEqual({ NEW: [5, 2019, 'b', 11], EQL: [2, 0, 'c', 10], OLD: [1, 0, 'a', 10] });
    expect(d.owner).toEqual(['Samantha', 10]);           // ownerT equal: the server's name wins too
    expect(d.dirty).toEqual({ 'p:OLD': 1, 'n:OLD': 1 });
    expect(r).toEqual({ ids: ['C-5', 'EQL', 'NEW'], owner: true, changed: true, rev: 9 });
    expect(events).toEqual([{ source: 'remote', ids: ['C-5', 'EQL', 'NEW'], owner: true }]);
    // an identical answer changes nothing visible and fires no event
    expect(store.adopt({ rev: 9, places: { NEW: [0, 11, 9] } }).changed).toBe(false);
    expect(events.length).toBe(1);
  });

  test('adopt keeps a newer local owner; old servers without notes are fine', () => {
    const { store, c } = fresh();
    store.setOwner('Local');                                 // t = T0
    const r = store.adopt({ owner: 'Remote', ownerT: T0 - 1, places: { FRA: [1, 5] } });
    expect(store.getOwner()).toBe('Local');
    expect(r.owner).toBe(false);
    expect(store.getStatus('FRA')).toBe(1);
    expect(store.outgoing()[0].owner).toEqual(['Local', T0]);
    c.t += 1;
    expect(store.adopt(null).changed).toBe(false);
  });

  test('replaceAll: the device becomes exactly the other map, nothing dirty', () => {
    const { store, doc } = fresh();
    store.setStatus('FRA', 1); store.setStatus('C-77', 2); store.setNotes('FRA', { note: 'mine' }); store.setOwner('Me');
    const r = store.replaceAll({ rev: 30, owner: 'Sam', ownerT: 4, places: { JPN: [1, 2, 3], FRA: [1, 1, 1] }, notes: { JPN: [5, 0, 'ramen', 2, 3] } });
    expect(doc()).toEqual({ v: 2, places: { JPN: [1, 2], FRA: [1, 1] }, notes: { JPN: [5, 0, 'ramen', 2] }, owner: ['Sam', 4], dirty: {} });
    expect(r.ids).toEqual(['C-77', 'FRA', 'JPN']);           // FRA: its note went away
    expect(r.rev).toBe(30);
    expect(store.outgoing()).toEqual([{}]);
  });
});

// ---------- backup ----------

test.describe('backup formats', () => {
  function sample() {
    const f = fresh();
    const { store } = f;
    store.setOwner('Sam');
    store.setStatus('US-CA', 1); store.setStatus('FRA', 1); store.setStatus('C-2988507', 1);
    store.setStatus('JPN', 2); store.setStatus('C-1850147', 2);
    store.setStatus('DEU', 1); store.setStatus('DEU', 0);    // tombstone: not in the backup
    store.setNotes('FRA', { rating: 5, year: 2019, note: 'Line 1\nLine 2' });
    store.setNotes('PER', { note: 'someday' });              // a note on an unmarked place
    return f;
  }

  test('makeCode: atlas2 with sorted been/want ids, empty sections left out', () => {
    expect(sample().store.makeCode()).toBe('atlas2:b=C-2988507,FRA,US-CA;w=C-1850147,JPN');
    const { store } = fresh();
    expect(store.makeCode()).toBe('atlas2:');
    store.setStatus('JPN', 2);
    expect(store.makeCode()).toBe('atlas2:w=JPN');
  });

  test('makeFile: the atlas2 object, no timestamps', () => {
    const f = sample().store.makeFile();
    expect(f).toEqual({
      format: 'atlas2', savedAt: new Date(T0).toISOString(), owner: 'Sam',
      places: {
        'C-1850147': { status: 'want' }, 'C-2988507': { status: 'been' },
        FRA: { status: 'been', rating: 5, year: 2019, note: 'Line 1\nLine 2' },
        JPN: { status: 'want' }, PER: { note: 'someday' }, 'US-CA': { status: 'been' },
      },
    });
    expect(Object.keys(f.places)).toEqual(Object.keys(f.places).slice().sort());
    expect(sample().store.makeFile('Other').owner).toBe('Other');
    expect(S.backupFileName(new Date(2026, 9, 4))).toBe('travel-atlas-backup-2026-10-04.json');
  });

  test('atlas2 file round trip (object and JSON text) into an empty device', () => {
    const file = sample().store.makeFile();
    for (const input of [file, JSON.stringify(file, null, 2), '﻿' + JSON.stringify(file)]) {
      const b = fresh(undefined, T0 + 1000).store;
      const parsed = b.parseBackup(input);
      expect(parsed.kind).toBe('atlas2-file');
      expect(parsed.mapOnly).toBe(false);
      expect(parsed.owner).toBe('Sam');
      expect(parsed.unknown).toBe(0);
      const r = b.restore(parsed);
      expect(r.added).toBe(5);
      expect(r.notesAdded).toBe(2);
      expect(r.ownerSet).toBe(true);
      expect(Object.assign(b.makeFile(), { savedAt: file.savedAt })).toEqual(file);
    }
  });

  test('atlas2 code round trip: been beats want inside a code, lower case accepted', () => {
    const code = sample().store.makeCode();
    const b = fresh().store;
    const parsed = b.parseBackup('my backup: ' + code + '\n');
    expect(parsed.kind).toBe('atlas2-code');
    expect(parsed.mapOnly).toBe(true);
    b.restore(parsed);
    expect(b.makeCode()).toBe(code);
    expect(b.getNotes('FRA')).toBeNull();                       // a code carries no notes
    expect(S.parseBackup('ATLAS2:b=fra;w=fra, jpn;x=ITA').places).toEqual({ FRA: { status: 1 }, JPN: { status: 2 } });
    expect(S.parseBackup('atlas2:').places).toEqual({});
  });

  test('atlas1 files (marks or v) and codes (prefixed or bare lists) are accepted', () => {
    const p1 = S.parseBackup(JSON.stringify({ format: 'atlas1', owner: 'Ana', marks: ['FRA', 'us-ca'], savedAt: 'x' }));
    expect(p1).toEqual({ kind: 'atlas1-file', mapOnly: true, places: { FRA: { status: 1 }, 'US-CA': { status: 1 } }, unknown: 0, owner: 'Ana' });
    expect(S.parseBackup({ v: ['JPN'] }).places).toEqual({ JPN: { status: 1 } });
    const p2 = S.parseBackup('atlas1:FRA,US-CA,DEU');
    expect(p2.kind).toBe('atlas1-code');
    expect(Object.keys(p2.places)).toEqual(['FRA', 'US-CA', 'DEU']);
    expect(Object.keys(S.parseBackup('fra us-ca;deu,\n ita').places)).toEqual(['FRA', 'US-CA', 'DEU', 'ITA']);
    expect(Object.keys(S.parseBackup('{"not":"ours"} atlas1:FRA').places)).toEqual(['FRA']);
    expect(S.parseBackup('')).toBeNull();
    expect(S.parseBackup('   ')).toBeNull();
    expect(S.parseBackup({ hello: 1 })).toBeNull();
    // a restored atlas1 backup lands as been
    const { store } = fresh();
    store.restore(p1);
    expect(store.ids(1)).toEqual(['FRA', 'US-CA']);
    expect(store.getOwner()).toBe('Ana');
  });

  test('unknown ids: malformed always; with isKnown, unknown places (cities pass while unloaded)', () => {
    expect(S.parseBackup('atlas1:FRA,???,hello world').unknown).toBe(1);   // HELLO and WORLD are well-formed
    const known = new Set(['FRA', 'JPN', 'C-1']);
    const unloaded = S.makeIsKnown(id => known.has(id), false);
    const loaded = S.makeIsKnown(id => known.has(id), true);
    const text = 'atlas2:b=FRA,HELLO,C-2988507;w=JPN,C-1,C-12345678901234';
    const a = S.parseBackup(text, { isKnown: unloaded });
    expect(Object.keys(a.places).sort()).toEqual(['C-1', 'C-2988507', 'FRA', 'JPN']);
    expect(a.unknown).toBe(2);
    const b = S.parseBackup(text, { isKnown: loaded });
    expect(Object.keys(b.places).sort()).toEqual(['C-1', 'FRA', 'JPN']);
    expect(b.unknown).toBe(3);
    const f = S.parseBackup({ format: 'atlas2', places: { FRA: { status: 'been', rating: 9, year: 1850, note: 7 }, ZZZ: { status: 'want' }, BAD: 'x' } }, { isKnown: loaded });
    expect(f.places).toEqual({ FRA: { status: 1 } });           // bad fields dropped, the place kept
    expect(f.unknown).toBe(2);
  });
});

test.describe('restore: Add, Replace, Undo', () => {
  function device() {
    const f = fresh();
    const s = f.store;
    s.setOwner('Me');
    s.setStatus('FRA', 1);             // been
    s.setStatus('JPN', 2);             // want
    s.setStatus('ITA', 1);
    s.setNotes('FRA', { rating: 2, note: 'mine' });
    s.setNotes('ITA', { note: 'pasta' });
    f.c.t += 1000;
    s.ack(s.outgoing()[0]);            // pretend all of it is synced
    return f;
  }
  const backup = {
    format: 'atlas2', owner: 'Backup Owner',
    places: {
      FRA: { status: 'want', rating: 5, note: 'theirs' },   // been here: never downgraded, note kept
      JPN: { status: 'been' },                              // want -> been
      PER: { status: 'want', year: 2020 },                  // new
      ESP: { note: 'tapas' },                               // notes only
    },
  };

  test('Add never downgrades or removes; notes fill only empty items; owner kept', () => {
    const { store, c } = device();
    const r = store.restore(store.parseBackup(backup));
    expect(r.replaced).toBe(false);
    expect(r.added).toBe(2);                                 // JPN up to been, PER new
    expect(r.removed).toBe(0);
    expect(r.notesAdded).toBe(2);                            // PER, ESP
    expect(r.ownerSet).toBe(false);
    expect([store.getStatus('FRA'), store.getStatus('JPN'), store.getStatus('PER'), store.getStatus('ITA'), store.getStatus('ESP')]).toEqual([1, 1, 2, 1, 0]);
    expect(store.getNotes('FRA')).toEqual({ rating: 2, year: 0, note: 'mine' });
    expect(store.getNotes('PER')).toEqual({ rating: 0, year: 2020, note: '' });
    expect(store.getOwner()).toBe('Me');
    expect(r.total).toBe(4);
    // a restore is a new edit stamped now, and goes up with the next sync
    const out = store.outgoing()[0];
    expect(out.places).toEqual({ JPN: [1, c.t], PER: [2, c.t] });
    expect(Object.keys(out.notes).sort()).toEqual(['ESP', 'PER']);
    // been beats want beats none in every direction
    const s2 = fresh().store;
    s2.setStatus('A1', 2);
    s2.restore(S.parseBackup('atlas2:w=A1,A2'));
    s2.restore(S.parseBackup('atlas1:A2'));
    s2.restore(S.parseBackup('atlas2:w=A2'));
    expect([s2.getStatus('A1'), s2.getStatus('A2')]).toEqual([2, 1]);
  });

  test('Replace makes removals at t = now; file notes replace too; owner replaced', () => {
    const { store, c, doc } = device();
    const r = store.restore(store.parseBackup(backup), { replace: true });
    expect(r.replaced).toBe(true);
    expect(store.ids(1)).toEqual(['JPN']);
    expect(store.ids(2)).toEqual(['FRA', 'PER']);
    expect(store.getStatus('ITA')).toBe(0);
    expect(doc().places.ITA).toEqual([0, c.t]);              // removal stamped now: beats the old add
    expect(r.removed).toBe(1);
    expect(store.getNotes('FRA')).toEqual({ rating: 5, year: 0, note: 'theirs' });
    expect(store.getNotes('ITA')).toBeNull();
    expect(doc().notes.ITA).toEqual([0, 0, '', c.t]);
    expect(store.getNotes('ESP')).toEqual({ rating: 0, year: 0, note: 'tapas' });
    expect(store.getOwner()).toBe('Backup Owner');
    expect(store.makeFile().places).toEqual({
      ESP: { note: 'tapas' }, FRA: { status: 'want', rating: 5, note: 'theirs' }, JPN: { status: 'been' }, PER: { status: 'want', year: 2020 },
    });
  });

  test('Replace from a code changes the map only and leaves notes alone', () => {
    const { store } = device();
    store.restore(S.parseBackup('atlas2:b=PER'), { replace: true });
    expect(store.ids(1)).toEqual(['PER']);
    expect(store.ids(2)).toEqual([]);
    expect(store.getNotes('FRA')).toEqual({ rating: 2, year: 0, note: 'mine' });
    expect(store.getOwner()).toBe('Me');
  });

  test('Undo puts the whole :v2 back (values), stamped newer so it also wins on sync', () => {
    const { store, c, doc } = device();
    const before = doc();
    const r = store.restore(store.parseBackup(backup), { replace: true });
    store.ack(store.outgoing()[0]);                          // the replace already reached the server
    c.t += 500;
    const events = [];
    store.onChange(e => events.push(e.source));
    expect(store.undo(r.snapshot)).toBe(true);
    const after = doc();
    const vals = d => ({
      places: Object.fromEntries(Object.entries(d.places).filter(([, e]) => e[0]).map(([k, e]) => [k, e[0]])),
      notes: Object.fromEntries(Object.entries(d.notes).filter(([, e]) => e[0] || e[1] || e[2]).map(([k, e]) => [k, e.slice(0, 3)])),
      owner: d.owner[0],
    });
    expect(vals(after)).toEqual(vals(before));
    expect(after.places.ITA).toEqual([1, c.t]);               // re-stamped
    expect(after.places.PER).toEqual([0, c.t]);
    expect(after.dirty['p:ITA'] && after.dirty['p:PER'] && after.dirty['n:FRA'] && after.dirty.o).toBe(1);
    expect(events).toEqual(['undo']);
    expect(store.undo('garbage')).toBe(false);
  });

  test('restore reports nothing to do for an already-merged backup', () => {
    const { store } = device();
    const r = store.restore(S.parseBackup('atlas1:FRA,ITA'));
    expect(r.added).toBe(0);
    expect(r.changed).toBe(0);
    expect(store.isDirty()).toBe(false);
  });
});

test.describe('import from the old address', () => {
  test('importCode merges an atlas1 code with Add; owner only when this device has none', () => {
    const { store } = fresh();
    store.setStatus('FRA', 2);
    const r = store.importCode('atlas1:FRA,US-CA,???', { owner: 'Old Name' });
    expect(r).toEqual({ added: 2, found: 2, unknown: 1, ownerSet: true });
    expect(store.ids(1)).toEqual(['FRA', 'US-CA']);
    expect(store.getOwner()).toBe('Old Name');
    expect(store.importCode('US-CA', { owner: 'Other' })).toEqual({ added: 0, found: 1, unknown: 0, ownerSet: false });
    expect(store.importCode('atlas2:b=JPN')).toEqual({ added: 0, found: 0, unknown: 0, ownerSet: false });
    expect(store.importCode('')).toEqual({ added: 0, found: 0, unknown: 0, ownerSet: false });
    const known = S.makeIsKnown(id => id === 'DEU', false);
    expect(store.importCode('atlas1:DEU,ZZZ', { isKnown: known })).toEqual({ added: 1, found: 1, unknown: 1, ownerSet: false });
  });
});
