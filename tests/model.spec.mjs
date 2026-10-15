// Unit tests for worker/model.js (pure sync model). No browser and no server: Playwright's test
// runner imports the module directly in Node. Run: npx playwright test model.spec.mjs
import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import {
  LIMITS,
  ModelError,
  cleanNote,
  checkName,
  classifyId,
  checkPlaces,
  checkNotes,
  parseCreate,
  parseSync,
  mergeDoc,
  mergeOwner,
  delta,
  isFull,
  isNoop,
  docsNeeded,
  checkNoteCaps,
  storageRefuses,
  serialize,
  stamp,
  parseDoc,
  publicBody,
  CONVERT_SQL,
} from '../worker/model.js';
import { PLACE_IDS, CITY_ID_RE, AREA_ID_RE } from '../worker/place-ids.js';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const YEAR = 2026;
const CITY = [...PLACE_IDS].find((id) => id.startsWith('C-'));

function throws400(fn, re) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, 'expected a 400').toBeInstanceOf(ModelError);
  expect(err.status).toBe(400);
  expect(err.code).toBe('bad_request');
  if (re) expect(err.message).toMatch(re);
}

test.describe('model: ids', () => {
  test('allowlist has map places and cities; regexes exported', () => {
    expect(PLACE_IDS.has('FRA')).toBe(true);
    expect(PLACE_IDS.has('US-CA')).toBe(true);
    expect(CITY, 'data/cities-ids.json should be in the allowlist').toBeTruthy();
    expect(CITY).toMatch(CITY_ID_RE);
    expect(AREA_ID_RE.test('US-PRI')).toBe(true);
  });

  test('known ok, well-formed unknown dropped, malformed bad', () => {
    expect(classifyId('FRA')).toBe('ok');
    expect(classifyId(CITY)).toBe('ok');
    for (const id of ['QA-AAA', 'ZZZ', 'US-ZZ', 'XX', 'C-1', 'C-999999999999']) expect(classifyId(id), id).toBe('drop');
    for (const id of ['usa', 'us-ca', 'FRA ', 'U-S', 'US-CALI', 'C-', 'C-1234567890123', 'C-12a', '', 'xx-yy', '__proto__']) {
      expect(classifyId(id), id).toBe('bad');
    }
  });
});

test.describe('model: validation', () => {
  test('places: status 0/1/2, t > 0 integer, clamped to now + 5 min, unknown dropped', () => {
    const r = checkPlaces({ FRA: [2, NOW], DEU: [0, 5], ITA: [1, NOW * 2], 'QA-AAA': [1, NOW], [CITY]: [1, NOW] }, NOW);
    expect(r.entries).toEqual({ FRA: [2, NOW], DEU: [0, 5], ITA: [1, NOW + LIMITS.FUTURE_SLACK_MS], [CITY]: [1, NOW] });
    expect(r.dropped).toBe(1);
    for (const bad of [{ FRA: [3, NOW] }, { FRA: [1, 0] }, { FRA: [1, 1.5] }, { FRA: [1] }, { FRA: [1, NOW, 1] }, { FRA: 'x' }, { usa: [1, NOW] }]) {
      throws400(() => checkPlaces(bad, NOW));
    }
    throws400(() => checkPlaces([], NOW));
    // a dropped id still has to be a valid entry (no smuggling junk through unknown ids)
    throws400(() => checkPlaces({ 'QA-AAA': [9, NOW] }, NOW));
  });

  test('places: at most 1000 per request', () => {
    const ok = {};
    for (let i = 0; i < 1000; i++) ok[`C-${i + 1}`] = [1, NOW];
    expect(checkPlaces(ok, NOW).dropped).toBe(1000 - [...Object.keys(ok)].filter((k) => PLACE_IDS.has(k)).length);
    throws400(() => checkPlaces({ ...ok, 'C-5000': [1, NOW] }, NOW), /At most 1000 places/);
  });

  test('notes: rating 0–5, year 0 or 1900..next year, ≤ 500 chars, ≤ 3 newlines, invisible chars stripped', () => {
    const r = checkNotes(
      {
        FRA: [5, 2019, '  Paris‮ in\u0000 spring​\n\n\n\n\nyes  ', NOW],
        DEU: [0, 0, '', NOW],
        JPN: [3, YEAR + 1, '👨‍👩‍👧 trip', NOW],
        ITA: [0, 1900, 'x'.repeat(500), NOW],
      },
      NOW
    );
    expect(r.entries.FRA).toEqual([5, 2019, 'Paris in spring\n\n\nyes', NOW]);
    expect(r.entries.DEU).toEqual([0, 0, '', NOW]);
    expect(r.entries.JPN[2]).toBe('👨‍👩‍👧 trip'); // emoji joiners survive
    expect(r.entries.ITA[2].length).toBe(500);
    expect(cleanNote('a\r\nb')).toBe('a\nb');
    const bads = [
      { FRA: [6, 0, '', NOW] },
      { FRA: [-1, 0, '', NOW] },
      { FRA: [1.5, 0, '', NOW] },
      { FRA: [0, 1899, '', NOW] },
      { FRA: [0, YEAR + 2, '', NOW] },
      { FRA: [0, 0, 'x'.repeat(501), NOW] },
      { FRA: [0, 0, 5, NOW] },
      { FRA: [0, 0, '', 0] },
      { FRA: [0, 0, ''] },
      { FRA: [0, 0, '', NOW, 1] },
    ];
    for (const b of bads) throws400(() => checkNotes(b, NOW), undefined);
    // padding with invisible characters does not count toward 500
    expect(checkNotes({ FRA: [0, 0, 'x'.repeat(500) + '‮'.repeat(50), NOW] }, NOW).entries.FRA[2].length).toBe(500);
  });

  test('notes: at most 200 per request', () => {
    const many = {};
    const ids = [...PLACE_IDS].slice(0, 201);
    for (const id of ids) many[id] = [1, 0, '', NOW];
    throws400(() => checkNotes(many, NOW), /At most 200 notes/);
    delete many[ids[200]];
    expect(Object.keys(checkNotes(many, NOW).entries).length).toBe(200);
  });

  test('names are cleaned and limited; create/sync bodies parse', () => {
    expect(checkName('  ‮Ann\u0000  ')).toBe('Ann');
    throws400(() => checkName('‮'));
    throws400(() => checkName('x'.repeat(41)));
    const c = parseCreate({ name: 'Trips', owner: 'Ann', ownerT: NOW, places: { FRA: [1, NOW] }, notes: { FRA: [4, 0, 'hi', NOW] } }, NOW);
    expect(c).toMatchObject({ name: 'Trips', owner: 'Ann', ownerT: NOW, places: { FRA: [1, NOW] }, notes: { FRA: [4, 0, 'hi', NOW] }, dropped: 0 });
    const s = parseSync({ since: 7, owner: ['Bea', NOW], places: { 'QA-AAA': [1, NOW] }, notes: { 'C-1': [1, 0, '', NOW] } }, NOW);
    expect(s).toMatchObject({ since: 7, owner: ['Bea', NOW], places: {}, notes: {}, dropped: 2 });
    expect(parseSync({}, NOW)).toMatchObject({ since: null, owner: null, places: {}, notes: {}, dropped: 0 });
    for (const since of [-1, 1.5, '3', true]) throws400(() => parseSync({ since }, NOW), /since/);
    throws400(() => parseSync({ owner: 'x' }, NOW));
  });
});

test.describe('model: merge', () => {
  test('last writer wins per entry; equal t keeps the stored value; rev stamped on change only', () => {
    const doc = { FRA: [1, 100, 1], DEU: [1, 100, 1], ITA: [0, 100, 1] };
    const { doc: out, changed } = mergeDoc(doc, { FRA: [0, 99], DEU: [2, 100], ITA: [1, 101], JPN: [2, 5] }, 2);
    expect(out).toEqual({ FRA: [1, 100, 1], DEU: [1, 100, 1], ITA: [1, 101, 2], JPN: [2, 5, 2] });
    expect(changed).toBe(2);
    expect(doc.ITA).toEqual([0, 100, 1]); // input not mutated
  });

  test('tombstones (status 0, empty notes) are stored and beat older adds', () => {
    let { doc } = mergeDoc({}, { FRA: [0, 200] }, 1);
    expect(doc.FRA).toEqual([0, 200, 1]);
    ({ doc } = mergeDoc(doc, { FRA: [1, 150] }, 2));
    expect(doc.FRA).toEqual([0, 200, 1]);
    let notes = mergeDoc({ FRA: [5, 2019, 'x', 100, 1] }, { FRA: [0, 0, '', 101] }, 2).doc;
    expect(notes.FRA).toEqual([0, 0, '', 101, 2]);
    notes = mergeDoc(notes, { FRA: [3, 0, 'old', 100] }, 3).doc;
    expect(notes.FRA).toEqual([0, 0, '', 101, 2]);
  });

  test('status and notes are independent documents', () => {
    const pub = mergeDoc({ FRA: [1, 100, 1] }, { FRA: [0, 300] }, 2).doc;
    const priv = mergeDoc({ FRA: [5, 2019, 'kept', 100, 1] }, {}, 2).doc;
    expect(pub.FRA).toEqual([0, 300, 2]);
    expect(priv.FRA).toEqual([5, 2019, 'kept', 100, 1]);
  });

  test('owner is last-writer-wins on ownerT', () => {
    expect(mergeOwner('Ann', 10, ['Bea', 9])).toEqual({ owner: 'Ann', ownerT: 10, changed: false });
    expect(mergeOwner('Ann', 10, ['Bea', 10])).toEqual({ owner: 'Ann', ownerT: 10, changed: false });
    expect(mergeOwner('Ann', 10, ['Bea', 11])).toEqual({ owner: 'Bea', ownerT: 11, changed: true });
    expect(mergeOwner('Ann', 10, null).changed).toBe(false);
  });

  test('since delta returns entries with rev > since; full rules', () => {
    const doc = { A: [1, 1, 1], B: [1, 1, 3], C: [0, 1, 5] };
    expect(delta(doc, null)).toEqual(doc);
    expect(delta(doc, 3)).toEqual({ C: [0, 1, 5] });
    expect(delta(doc, 5)).toEqual({});
    expect(Object.keys(delta({ Z: [1, 1, 1], A: [1, 1, 1] }, null))).toEqual(['A', 'Z']);
    expect(isFull(null, 5)).toBe(true);
    expect(isFull(0, 5)).toBe(true);
    expect(isFull(6, 5)).toBe(true); // cursor ahead of the map: start over
    expect(isFull(5, 5)).toBe(false);
    expect(isFull(2, 5)).toBe(false);
  });

  test('a no-op sync needs no document; documents are read only when needed', () => {
    const input = { places: {}, notes: {}, owner: null };
    expect(isNoop({ since: 5, rev: 5, ownerT: 10, input })).toBe(true);
    expect(isNoop({ since: 4, rev: 5, ownerT: 10, input })).toBe(false);
    expect(isNoop({ since: null, rev: 5, ownerT: 10, input })).toBe(false);
    expect(isNoop({ since: 5, rev: 5, ownerT: 10, input: { ...input, owner: ['x', 10] } })).toBe(true);
    expect(isNoop({ since: 5, rev: 5, ownerT: 10, input: { ...input, owner: ['x', 11] } })).toBe(false);
    expect(isNoop({ since: 5, rev: 5, ownerT: 10, input: { ...input, places: { FRA: [1, 1] } } })).toBe(false);
    const base = { rev: 9, pubRev: 9, privRev: 4, hasPlaces: false, hasNotes: false };
    expect(docsNeeded({ ...base, since: 5 })).toEqual({ pub: true, priv: false });
    expect(docsNeeded({ ...base, since: 4, hasNotes: true })).toEqual({ pub: true, priv: true });
    expect(docsNeeded({ ...base, since: 9 })).toEqual({ pub: false, priv: false });
    expect(docsNeeded({ ...base, since: 9, hasPlaces: true })).toEqual({ pub: true, priv: false });
    expect(docsNeeded({ ...base, since: null })).toEqual({ pub: true, priv: true });
  });
});

test.describe('model: caps and storage guard', () => {
  const noteDoc = (n, len = 1) => {
    const d = {};
    for (let i = 0; i < n; i++) d[`C-${i + 1}`] = [1, 0, 'x'.repeat(len), 1, 1];
    return d;
  };

  test('at most 1000 non-empty notes per map; tombstones do not count; shrinking always allowed', () => {
    const at = noteDoc(1000);
    checkNoteCaps({}, at, serialize(at));
    const over = { ...at, 'C-5000': [1, 0, '', 1, 1] };
    throws400(() => checkNoteCaps(at, over, serialize(over)), /1000 notes/);
    const tomb = { ...at, 'C-5000': [0, 0, '', 1, 1] };
    checkNoteCaps(at, tomb, serialize(tomb));
    const shrink = { ...over };
    delete shrink['C-1'];
    shrink['C-2'] = [0, 0, '', 2, 2];
    checkNoteCaps(over, shrink, serialize(shrink)); // still over? no: 999 non-empty. And shrinking is fine.
  });

  test('priv is limited to 600 KB', () => {
    const big = noteDoc(1000, 600); // ~ 640 KB serialized
    throws400(() => checkNoteCaps({}, big, serialize(big)), /600 KB/);
    // same size or smaller than before is fine, even above the cap
    checkNoteCaps(big, big, serialize(big));
  });

  test('storage guard refuses growth above the limit, fails open without size_after', () => {
    const L = LIMITS.STORAGE_LIMIT_BYTES;
    expect(storageRefuses(L + 1, true)).toBe(true);
    expect(storageRefuses(L + 1, false)).toBe(false);
    expect(storageRefuses(L, true)).toBe(false);
    expect(storageRefuses(undefined, true)).toBe(false);
    expect(storageRefuses(NaN, true)).toBe(false);
    expect(L).toBeLessThan(500 * 1000 * 1000);
  });
});

test.describe('model: documents and conversion', () => {
  test('serialize sorts keys; stamp adds rev; parseDoc tolerates empties', () => {
    expect(serialize({ Z: [1, 1, 1], A: [0, 2, 1] })).toBe('{"A":[0,2,1],"Z":[1,1,1]}');
    expect(stamp({ FRA: [1, 5] }, 1)).toEqual({ FRA: [1, 5, 1] });
    expect(parseDoc('')).toEqual({});
    expect(parseDoc('[]')).toEqual({});
    expect(parseDoc('{"A":[1,1,1]}')).toEqual({ A: [1, 1, 1] });
  });

  test('publicBody splices documents without parsing and never includes secrets', () => {
    const row = { id: 'a-bcdef', name: 'N', owner: 'O', owner_t: 1, updated: 2, rev: 3, pub: '{"FRA":[1,1,1]}', priv: '{"FRA":[1,0,"x",1,1]}', key_hash: 'h', notes_token: 't' };
    const plain = JSON.parse(publicBody(row));
    expect(plain).toEqual({ id: 'a-bcdef', name: 'N', owner: 'O', ownerT: 1, updated: 2, rev: 3, places: { FRA: [1, 1, 1] } });
    const withNotes = JSON.parse(publicBody(row, true));
    expect(withNotes.notes).toEqual({ FRA: [1, 0, 'x', 1, 1] });
    expect(publicBody(row, true)).not.toMatch(/key_hash|notes_token|"h"|"t"/);
  });

  test('CONVERT_SQL turns v1 marks into pub [visited, t, 1] once (SQLite)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE maps (id TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 0, pub TEXT NOT NULL DEFAULT '{}',
             pub_rev INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE marks (map_id TEXT, place_id TEXT, visited INTEGER, t INTEGER, PRIMARY KEY (map_id, place_id));
             INSERT INTO maps (id) VALUES ('m-aaaaa'), ('e-aaaaa'), ('done-aaaaa');
             UPDATE maps SET rev = 4, pub = '{"X":[1,1,4]}', pub_rev = 4 WHERE id = 'done-aaaaa';
             INSERT INTO marks VALUES ('m-aaaaa', 'US-CA', 1, 50), ('m-aaaaa', 'FRA', 0, 60), ('m-aaaaa', 'DEU', 1, 1),
                                      ('done-aaaaa', 'FRA', 1, 9), ('other-aaaaa', 'JPN', 1, 7);`);
    const run = (id) => db.prepare(CONVERT_SQL).run(id);
    const get = (id) => db.prepare('SELECT rev, pub, pub_rev FROM maps WHERE id = ?').get(id);
    expect(run('m-aaaaa').changes).toBe(1);
    expect(get('m-aaaaa')).toEqual({ rev: 1, pub: '{"DEU":[1,1,1],"FRA":[0,60,1],"US-CA":[1,50,1]}', pub_rev: 1 });
    expect(run('m-aaaaa').changes).toBe(0); // only once
    expect(run('e-aaaaa').changes).toBe(1);
    expect(get('e-aaaaa')).toEqual({ rev: 1, pub: '{}', pub_rev: 1 }); // no marks: empty document
    expect(run('done-aaaaa').changes).toBe(0); // already converted: untouched
    expect(get('done-aaaaa').pub).toBe('{"X":[1,1,4]}');
  });
});
