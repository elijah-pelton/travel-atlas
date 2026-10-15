// Sync API tests (contract: docs/SYNC.md). Runs against `npm run dev:test` (wrangler dev on
// 127.0.0.1:8787, local D1) or any local server via BASE_URL. That script sets RL_IP_LIMITS=0,
// which turns off only the limits keyed by IP alone (create 5/min, read 60/min, writes 30/min)
// because every test request comes from one IP. The per-map limits stay on (writes 10/min per
// map), and each test uses its own fresh map with fewer than 10 writes, so they never bite by
// accident; the bad-key tests below prove the 429 path for real.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLACE_IDS } from '../worker/place-ids.js';
import { ipKey } from '../worker/net.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const KEY_RE = /^[A-Za-z0-9_-]{22}$/;
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?-[abcdefghjkmnpqrstuvwxyz23456789]{5}$/;
const AREAS = [...PLACE_IDS].filter((id) => !id.startsWith('C-'));
const CITIES = [...PLACE_IDS].filter((id) => id.startsWith('C-'));

const now = () => Date.now();
const auth = (key) => ({ Authorization: `Bearer ${key}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Stored entries carry the rev they last changed at; most tests only care about [value..., t].
const strip = (doc) => Object.fromEntries(Object.entries(doc).map(([k, e]) => [k, e.slice(0, -1)]));

async function create(request, body = {}) {
  const res = await request.post('/api/maps', { data: { name: 'Test Atlas', places: {}, ...body } });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

async function sync(request, id, key, body) {
  return request.post(`/api/maps/${id}/sync`, { data: body, headers: key ? auth(key) : {} });
}

async function notesLink(request, id, key, action) {
  return request.post(`/api/maps/${id}/notes-link`, { data: { action }, headers: key ? auth(key) : {} });
}

async function getNotes(request, id, token) {
  return request.get(`/api/maps/${id}/notes`, { headers: token ? auth(token) : {} });
}

test.describe('sync API', () => {
  test('create returns 201 with id, 22-char key and the map', async ({ request }) => {
    const t = now();
    const res = await request.post('/api/maps', {
      data: { name: '  Élijah’s Trips!  ', owner: 'Elijah', ownerT: t, places: { 'US-CA': [1, t], FRA: [2, t] } },
    });
    expect(res.status()).toBe(201);
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['referrer-policy']).toBe('no-referrer');
    expect(res.headers()['access-control-allow-origin']).toBeUndefined();
    const body = await res.json();
    expect(body.id).toMatch(ID_RE);
    expect(body.id).toMatch(/^elijah-s-trips-[a-z2-9]{5}$/);
    expect(body.editKey).toMatch(KEY_RE);
    expect(body.map).toEqual({
      id: body.id,
      name: 'Élijah’s Trips!',
      owner: 'Elijah',
      ownerT: t,
      updated: body.map.updated,
      rev: 1,
      places: { FRA: [2, t, 1], 'US-CA': [1, t, 1] },
      notes: {},
      notesToken: null,
      full: true,
      dropped: 0,
    });
    expect(JSON.stringify(body.map)).not.toMatch(/key_hash|keyHash/);
  });

  test('create accepts notes; unknown well-formed ids are dropped and counted', async ({ request }) => {
    const t = now();
    const { id, map } = await create(request, {
      places: { FRA: [1, t], 'QA-AAA': [1, t], 'C-1': [1, t] },
      notes: { FRA: [5, 2019, 'Paris!', t], 'C-2': [1, 0, '', t] },
    });
    expect(map.places).toEqual({ FRA: [1, t, 1] });
    expect(map.notes).toEqual({ FRA: [5, 2019, 'Paris!', t, 1] });
    expect(map.dropped).toBe(3);
    const plain = await (await request.get(`/api/maps/${id}`)).json();
    expect(plain.places).toEqual({ FRA: [1, t, 1] });
  });

  test('slug falls back to "atlas" and is cut to 20 chars', async ({ request }) => {
    expect((await create(request, { name: '!!!' })).id).toMatch(/^atlas-[a-z2-9]{5}$/);
    const long = await create(request, { name: 'The Quite Extraordinarily Long Name' });
    expect(long.id).toMatch(/^the-quite-extraordin-[a-z2-9]{5}$/);
  });

  test('GET returns places incl. status 0 and 2 with rev, never notes or secrets', async ({ request }) => {
    const t = now();
    const { id, editKey } = await create(request, {
      places: { 'US-NY': [1, t], 'CA-ON': [0, t], JPN: [2, t] },
      notes: { JPN: [4, 2020, 'secret note', t] },
    });
    expect((await notesLink(request, id, editKey, 'on')).status()).toBe(200);
    const res = await request.get(`/api/maps/${id}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('no-store');
    const text = await res.text();
    expect(text).not.toMatch(/key_hash|keyHash|editKey|notes|notesToken|notes_token|secret note/);
    const map = JSON.parse(text);
    expect(Object.keys(map).sort()).toEqual(['id', 'name', 'owner', 'ownerT', 'places', 'rev', 'updated']);
    expect(map.places).toEqual({ 'CA-ON': [0, t, 1], JPN: [2, t, 1], 'US-NY': [1, t, 1] });
    expect(map.rev).toBe(1);
  });

  test('unknown or malformed map id is 404', async ({ request }) => {
    for (const p of ['/api/maps/nobody-zzzzz', '/api/maps/NOT_AN_ID', '/api/nothing', '/api/maps/nobody-zzzzz/notes']) {
      const res = await request.get(p);
      expect(res.status(), p).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'not_found' });
      expect(res.headers()['cache-control']).toBe('no-store');
    }
    expect((await sync(request, 'nobody-zzzzz', 'A'.repeat(22), { places: {} })).status()).toBe(404);
    expect((await notesLink(request, 'nobody-zzzzz', 'A'.repeat(22), 'on')).status()).toBe(404);
  });

  test('sync with missing or wrong key is 401', async ({ request }) => {
    const { id, editKey } = await create(request);
    const missing = await sync(request, id, null, { places: {} });
    expect(missing.status()).toBe(401);
    expect(await missing.json()).toMatchObject({ error: 'bad_key' });
    const wrong = await sync(request, id, editKey.slice(0, -1) + (editKey.endsWith('A') ? 'B' : 'A'), { places: {} });
    expect(wrong.status()).toBe(401);
    const ok = await sync(request, id, editKey, { places: {} });
    expect(ok.status()).toBe(200);
  });

  test('sync merges per place, last writer wins; status and notes are independent', async ({ request }) => {
    const t0 = now() - 100_000;
    const { id, editKey } = await create(request, {
      places: { 'US-CA': [1, t0], 'US-TX': [1, t0], 'US-OR': [0, t0], FRA: [1, t0] },
      notes: { FRA: [5, 2019, 'kept', t0] },
    });
    const res = await sync(request, id, editKey, {
      places: {
        'US-CA': [0, t0 - 10], // older removal: ignored
        'US-TX': [0, t0 + 10], // newer removal: wins over the add
        'US-OR': [2, t0 + 10], // newer want: wins over the removal
        FRA: [0, t0 + 20], // un-marking a place never wipes its notes
        DEU: [1, t0], // new place
      },
    });
    expect(res.status()).toBe(200);
    const map = await res.json();
    expect(map.rev).toBe(2);
    expect(map.full).toBe(true);
    expect(map.places).toEqual({
      DEU: [1, t0, 2],
      FRA: [0, t0 + 20, 2],
      'US-CA': [1, t0, 1],
      'US-OR': [2, t0 + 10, 2],
      'US-TX': [0, t0 + 10, 2],
    });
    expect(map.notes).toEqual({ FRA: [5, 2019, 'kept', t0, 1] });
    expect((await (await request.get(`/api/maps/${id}`)).json()).places).toEqual(map.places);
    // Same t for a note: the server value stays. Newer: replaces. Empty newer: a tombstone.
    let m = await (await sync(request, id, editKey, { notes: { FRA: [1, 0, 'same t', t0] } })).json();
    expect(m.notes.FRA).toEqual([5, 2019, 'kept', t0, 1]);
    expect(m.rev).toBe(2);
    m = await (await sync(request, id, editKey, { notes: { FRA: [3, 2020, 'newer', t0 + 1] } })).json();
    expect(m.notes.FRA).toEqual([3, 2020, 'newer', t0 + 1, 3]);
    m = await (await sync(request, id, editKey, { notes: { FRA: [0, 0, '', t0 + 2] } })).json();
    expect(m.notes.FRA).toEqual([0, 0, '', t0 + 2, 4]);
    expect(m.places.FRA).toEqual([0, t0 + 20, 2]);
  });

  test('since: only entries changed after the cursor; no-op sync reads only the meta row', async ({ request }) => {
    const t = now() - 50_000;
    const { id, editKey } = await create(request, { places: { FRA: [1, t], DEU: [1, t] }, notes: { FRA: [5, 0, 'a', t] } });
    // Device is at rev 1 and sends nothing: 1 row read, nothing parsed, empty delta.
    let res = await sync(request, id, editKey, { since: 1 });
    expect(res.headers()['x-atlas-read']).toBe('meta');
    let m = await res.json();
    expect(m).toMatchObject({ rev: 1, places: {}, notes: {}, full: false, dropped: 0, notesToken: null });
    // Another device changes one place: rev 2.
    m = await (await sync(request, id, editKey, { since: 1, places: { ITA: [2, t] } })).json();
    expect(m).toMatchObject({ rev: 2, full: false, places: { ITA: [2, t, 2] }, notes: {} });
    // The first device (since 1) gets just that change; notes were not touched, so priv is not read.
    res = await sync(request, id, editKey, { since: 1 });
    expect(res.headers()['x-atlas-read']).toBe('meta,pub');
    m = await res.json();
    expect(m).toMatchObject({ rev: 2, full: false, places: { ITA: [2, t, 2] }, notes: {} });
    // Its own edit comes back stamped with the new rev (so it can clear its dirty flag).
    m = await (await sync(request, id, editKey, { since: 2, notes: { DEU: [3, 0, 'b', t + 1] }, places: { FRA: [1, t] } })).json();
    expect(m).toMatchObject({ rev: 3, places: {}, notes: { DEU: [3, 0, 'b', t + 1, 3] } });
    // Sending an older value changes nothing and does not move rev.
    res = await sync(request, id, editKey, { since: 3, places: { FRA: [0, t - 1] } });
    m = await res.json();
    expect(m).toMatchObject({ rev: 3, places: {}, notes: {}, full: false });
    // No since, since 0, or a cursor ahead of the map: everything, full = true.
    for (const since of [undefined, 0, 99]) {
      m = await (await sync(request, id, editKey, since === undefined ? {} : { since })).json();
      expect(m.full, String(since)).toBe(true);
      expect(Object.keys(m.places).sort()).toEqual(['DEU', 'FRA', 'ITA']);
      expect(Object.keys(m.notes).sort()).toEqual(['DEU', 'FRA']);
    }
  });

  test('updated moves only when something changed', async ({ request }) => {
    const t0 = now() - 50_000;
    const { id, editKey, map: created } = await create(request, { places: { FRA: [1, t0] } });
    await sleep(20);
    const same = await (await sync(request, id, editKey, { places: { FRA: [0, t0 - 1] } })).json();
    expect(same.updated).toBe(created.updated);
    expect(same.rev).toBe(1);
    const changed = await (await sync(request, id, editKey, { places: { FRA: [0, t0 + 1] } })).json();
    expect(changed.updated).toBeGreaterThan(created.updated);
    expect(changed.rev).toBe(2);
  });

  test('t is clamped to server now + 5 minutes', async ({ request }) => {
    const { id, editKey } = await create(request);
    const far = now() + 365 * 24 * 3600 * 1000;
    const map = await (await sync(request, id, editKey, { places: { ITA: [1, far] }, notes: { ITA: [1, 0, '', far] } })).json();
    for (const t of [map.places.ITA[1], map.notes.ITA[3]]) {
      expect(t).toBeLessThanOrEqual(now() + 5 * 60 * 1000 + 1000);
      expect(t).toBeGreaterThan(now() + 4 * 60 * 1000);
    }
  });

  test('owner name is last-writer-wins on its timestamp', async ({ request }) => {
    const t0 = now() - 100_000;
    const { id, editKey } = await create(request, { owner: 'Ann', ownerT: t0 });
    let map = await (await sync(request, id, editKey, { owner: ['Old', t0 - 1], places: {} })).json();
    expect(map).toMatchObject({ owner: 'Ann', ownerT: t0, rev: 1 });
    map = await (await sync(request, id, editKey, { since: 1, owner: ['Bea', t0 + 5] })).json();
    expect(map).toMatchObject({ owner: 'Bea', ownerT: t0 + 5, rev: 2 });
  });

  test('two devices syncing different places both end up with the union', async ({ request }) => {
    const t = now() - 10_000;
    const { id, editKey } = await create(request);
    const a = await (await sync(request, id, editKey, { places: { 'US-CA': [1, t], 'US-NV': [1, t] } })).json();
    expect(Object.keys(a.places).sort()).toEqual(['US-CA', 'US-NV']);
    const b = await (await sync(request, id, editKey, { places: { MEX: [1, t + 1], 'CA-BC': [2, t + 2] } })).json();
    expect(strip(b.places)).toEqual({ 'CA-BC': [2, t + 2], MEX: [1, t + 1], 'US-CA': [1, t], 'US-NV': [1, t] });
    const a2 = await (await sync(request, id, editKey, { places: { 'US-CA': [1, t], 'US-NV': [1, t] } })).json();
    expect(a2.places).toEqual(b.places);
  });

  test('racing syncs on one map all land (compare-and-swap with retries)', async ({ request }) => {
    const t = now() - 10_000;
    const { id, editKey } = await create(request);
    const sets = [['FRA', 'DEU'], ['ITA', 'ESP'], ['JPN', 'KOR'], ['MEX', 'CAN'], ['US-CA', 'US-NY']];
    const results = await Promise.all(
      sets.map((ids, i) =>
        sync(request, id, editKey, { since: 1, places: Object.fromEntries(ids.map((p) => [p, [1, t + i]])), notes: { [ids[0]]: [i, 0, `n${i}`, t] } })
      )
    );
    for (const r of results) expect([200, 503], await r.text()).toContain(r.status());
    const ok = results.filter((r) => r.status() === 200).length;
    expect(ok, 'with 3 retries, 5 racing syncs should all land locally').toBe(5);
    const all = await (await sync(request, id, editKey, {})).json();
    expect(Object.keys(all.places).sort()).toEqual(sets.flat().sort());
    expect(Object.keys(all.notes).length).toBe(5);
    expect(all.rev).toBe(6);
    // every rev 2..6 was used exactly once
    expect([...new Set(Object.values(all.places).map((e) => e[2]))].sort()).toEqual([2, 3, 4, 5, 6]);
  });

  test('validation errors are 400 bad_request', async ({ request }) => {
    const t = now();
    const bads = [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(41) },
      { name: 42 },
      { name: 'ok', owner: 'y'.repeat(41) },
      { name: 'ok', places: { usa: [1, t] } },
      { name: 'ok', places: { 'US-CALI': [1, t] } },
      { name: 'ok', places: { 'U-S': [1, t] } },
      { name: 'ok', places: { 'C-12x': [1, t] } },
      { name: 'ok', places: { 'C-1234567890123': [1, t] } },
      { name: '‮\u0000' }, // only invisible characters: empty after cleaning
      { name: 'ok', places: { FRA: [3, t] } },
      { name: 'ok', places: { FRA: [1, 0] } },
      { name: 'ok', places: { FRA: [1, 1.5] } },
      { name: 'ok', places: { FRA: [1] } },
      { name: 'ok', places: [] },
      { name: 'ok', notes: { FRA: [6, 0, '', t] } },
      { name: 'ok', notes: { FRA: [1, 1800, '', t] } },
      { name: 'ok', notes: { FRA: [1, 0, 'x'.repeat(501), t] } },
      { name: 'ok', notes: { FRA: [1, 0, '', t, 1] } },
      { name: 'ok', notes: [] },
    ];
    for (const data of bads) {
      const res = await request.post('/api/maps', { data });
      expect(res.status(), JSON.stringify(data).slice(0, 80)).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('bad_request');
      expect(typeof body.message).toBe('string');
    }
    // 1001 places in one request: refused on the count
    const many = {};
    for (let i = 0; i < 1001; i++) many[`C-${i + 1}`] = [1, t];
    const tooMany = await request.post('/api/maps', { data: { name: 'ok', places: many } });
    expect(tooMany.status()).toBe(400);
    expect((await tooMany.json()).message).toMatch(/At most 1000/);
    // 201 notes in one request
    const notes = Object.fromEntries(AREAS.slice(0, 201).map((p) => [p, [1, 0, '', t]]));
    const tooManyNotes = await request.post('/api/maps', { data: { name: 'ok', notes } });
    expect(tooManyNotes.status()).toBe(400);
    expect((await tooManyNotes.json()).message).toMatch(/At most 200 notes/);
    // non-JSON content type and broken JSON
    const form = await request.post('/api/maps', { form: { name: 'ok' } });
    expect(form.status()).toBe(400);
    const broken = await request.post('/api/maps', { data: '{"name":', headers: { 'Content-Type': 'application/json' } });
    expect(broken.status()).toBe(400);
    // sync validation too
    const { id, editKey } = await create(request);
    expect((await sync(request, id, editKey, { places: { 'xx-yy': [1, t] } })).status()).toBe(400);
    expect((await sync(request, id, editKey, { owner: 'not-a-pair' })).status()).toBe(400);
    expect((await sync(request, id, editKey, { since: -1 })).status()).toBe(400);
    expect((await sync(request, id, editKey, { since: '3' })).status()).toBe(400);
    expect((await notesLink(request, id, editKey, 'maybe')).status()).toBe(400);
  });

  test('every map place and 1000 cities in one request are fine', async ({ request }) => {
    const t = now();
    const all = Object.fromEntries(AREAS.map((id) => [id, [1, t]]));
    const res = await request.post('/api/maps', { data: { name: 'ok', places: all } });
    expect(res.status()).toBe(201);
    const { id, editKey, map } = await res.json();
    expect(Object.keys(map.places).length).toBe(AREAS.length);
    test.skip(CITIES.length < 1000, 'needs data/cities-ids.json with ≥ 1000 cities');
    const cities = Object.fromEntries(CITIES.slice(0, 1000).map((c) => [c, [2, t]]));
    const s = await sync(request, id, editKey, { since: 1, places: cities });
    expect(s.status()).toBe(200);
    const m = await s.json();
    expect(Object.keys(m.places).length).toBe(1000);
    expect(m.dropped).toBe(0);
  });

  test('bodies over 128 KB are 413; just under is fine', async ({ request }) => {
    const res = await request.post('/api/maps', {
      data: JSON.stringify({ name: 'big', pad: 'x'.repeat(129 * 1024) }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'too_large' });
    const ok = await request.post('/api/maps', {
      data: JSON.stringify({ name: 'big', pad: 'x'.repeat(120 * 1024) }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(ok.status()).toBe(201);
  });

  test('reset-key: old key stops working, new key works, notes token unaffected', async ({ request }) => {
    const { id, editKey } = await create(request);
    const { notesToken } = await (await notesLink(request, id, editKey, 'on')).json();
    const res = await request.post(`/api/maps/${id}/reset-key`, { data: {}, headers: auth(editKey) });
    expect(res.status()).toBe(200);
    const { editKey: fresh } = await res.json();
    expect(fresh).toMatch(KEY_RE);
    expect(fresh).not.toBe(editKey);
    expect((await sync(request, id, editKey, { places: {} })).status()).toBe(401);
    const s = await (await sync(request, id, fresh, { places: {} })).json();
    expect(s.notesToken).toBe(notesToken);
    expect((await getNotes(request, id, notesToken)).status()).toBe(200);
  });

  test('delete: 204, then the map is gone', async ({ request }) => {
    const { id, editKey } = await create(request, { places: { FRA: [1, now()] } });
    expect((await request.delete(`/api/maps/${id}`)).status()).toBe(401);
    const res = await request.delete(`/api/maps/${id}`, { headers: auth(editKey) });
    expect(res.status()).toBe(204);
    expect(res.headers()['cache-control']).toBe('no-store');
    expect((await request.get(`/api/maps/${id}`)).status()).toBe(404);
    expect((await sync(request, id, editKey, { places: { DEU: [1, now()] } })).status()).toBe(404);
  });

  test('after 10 failed key checks, bad keys get 429 but the right key still works', async ({ request }) => {
    const { id, editKey } = await create(request);
    const wrong = 'W'.repeat(22);
    for (let i = 0; i < 10; i++) expect((await sync(request, id, wrong, { places: {} })).status()).toBe(401);
    const limited = await sync(request, id, wrong, { places: {} });
    expect(limited.status()).toBe(429);
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
    expect(limited.headers()['cache-control']).toBe('no-store');
    expect(limited.headers()['retry-after']).toBe('60');
    // A stranger's guesses never lock the owner out.
    expect((await sync(request, id, editKey, { places: {} })).status()).toBe(200);
    expect((await sync(request, id, null, { places: {} })).status()).toBe(429);
    // Other maps are unaffected, and reads still work.
    const other = await create(request);
    expect((await sync(request, other.id, other.editKey, { places: {} })).status()).toBe(200);
    expect((await request.get(`/api/maps/${id}`)).status()).toBe(200);
  });

  test('writes are limited to 10 per minute per map', async ({ request }) => {
    const { id, editKey } = await create(request);
    for (let i = 0; i < 10; i++) expect((await sync(request, id, editKey, { places: {} })).status(), `sync ${i + 1}`).toBe(200);
    const res = await sync(request, id, editKey, { places: {} });
    expect(res.status()).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'rate_limited' });
    // notes-link counts as a write too
    expect((await notesLink(request, id, editKey, 'on')).status()).toBe(429);
    // Bad keys are not counted against the map's budget (they have their own limit).
    const other = await create(request);
    for (let i = 0; i < 9; i++) await sync(request, other.id, 'W'.repeat(22), { places: {} });
    expect((await sync(request, other.id, other.editKey, { places: {} })).status()).toBe(200);
  });

  test('real place and city ids are accepted; unknown well-formed dropped; malformed 400', async ({ request }) => {
    const t = now();
    const real = ['US-PRI', 'CA-ON', 'KOS', 'SAH', 'PSX', 'US-DC', 'US-HI', ...CITIES.slice(0, 3)];
    const { id, editKey, map } = await create(request, { places: Object.fromEntries(real.map((p) => [p, [1, t]])) });
    expect(Object.keys(map.places).sort()).toEqual([...real].sort());
    for (const unknown of ['QA-AAA', 'XX', 'AAA', 'US-XX', 'CA-ZZZ', 'C-1', 'C-999999999999']) {
      const res = await sync(request, id, editKey, { since: 1, places: { [unknown]: [1, t] } });
      expect(res.status(), unknown).toBe(200);
      const m = await res.json();
      expect(m.dropped, unknown).toBe(1);
      expect(m.places[unknown]).toBeUndefined();
    }
    const other = await create(request); // a fresh map: the first one used 8 of its 10 writes
    for (const fake of ['us-ca', 'FRA ', 'C-', 'C-1a']) {
      const res = await sync(request, other.id, other.editKey, { places: { [fake]: [1, t] } });
      expect(res.status(), fake).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_request' });
    }
  });

  test('worker/place-ids.js matches the map and city data', async () => {
    // Throws (exit 1) if someone changed data/*.json without regenerating the allowlist.
    const out = execFileSync(process.execPath, [path.join(REPO, 'tools', 'make-place-ids.mjs'), '--check'], {
      encoding: 'utf8',
    });
    expect(out).toMatch(/up to date/);
    for (const id of ['US-PRI', 'CA-ON', 'KOS', 'SAH', 'PSX', 'FRA', 'US-CA']) expect(PLACE_IDS.has(id), id).toBe(true);
    expect(PLACE_IDS.has('QA-AAA')).toBe(false);
    expect(PLACE_IDS.has('C-1')).toBe(false);
    expect(() => PLACE_IDS.add('QA-AAA')).toThrow();
  });

  test('control and format characters are stripped from name, owner and notes', async ({ request }) => {
    const t = now();
    const res = await request.post('/api/maps', {
      data: {
        name: '‮  Ann\u0000’s​ Map\u0007  ',
        owner: '\u0000Ann‮⁦',
        ownerT: t,
        places: {},
        notes: { FRA: [0, 0, '‮line 1\u0000\n\n\n\n\n\nline 2​', t] },
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.map.name).toBe('Ann’s Map');
    expect(body.map.owner).toBe('Ann');
    expect(body.map.notes.FRA[2]).toBe('line 1\n\n\nline 2');
    expect(body.id).toMatch(/^ann-s-map-[a-z2-9]{5}$/);
    // 40 visible chars plus invisible padding is fine; the padding does not count.
    const padded = await request.post('/api/maps', { data: { name: 'x'.repeat(40) + '‮'.repeat(10) } });
    expect(padded.status()).toBe(201);
    expect((await padded.json()).map.name).toBe('x'.repeat(40));
    // Sync cleans the owner too.
    const synced = await sync(request, body.id, body.editKey, { owner: ['‮Bea\u0000', t + 1] });
    expect((await synced.json()).owner).toBe('Bea');
  });

  test('reads are cached at the edge, and every write purges the cache', async ({ request }) => {
    const t = now() - 10_000;
    const { id, editKey } = await create(request, { places: { FRA: [1, t] } });
    const first = await request.get(`/api/maps/${id}`);
    expect(first.headers()['x-atlas-cache']).toBe('miss');
    await sleep(200); // the cache write runs after the response
    const second = await request.get(`/api/maps/${id}`);
    expect(second.headers()['x-atlas-cache']).toBe('hit');
    expect(second.headers()['cache-control']).toBe('no-store'); // browsers never cache it
    expect(await second.json()).toEqual(await first.json());
    // sync purges: the next read sees the change at once
    expect((await sync(request, id, editKey, { places: { DEU: [1, t] } })).status()).toBe(200);
    const after = await request.get(`/api/maps/${id}`);
    expect(after.headers()['x-atlas-cache']).toBe('miss');
    expect(strip((await after.json()).places)).toEqual({ DEU: [1, t], FRA: [1, t] });
    // delete purges: a deleted map is gone at once, not 15 s later
    await sleep(200);
    expect((await request.get(`/api/maps/${id}`)).headers()['x-atlas-cache']).toBe('hit');
    expect((await request.delete(`/api/maps/${id}`, { headers: auth(editKey) })).status()).toBe(204);
    expect((await request.get(`/api/maps/${id}`)).status()).toBe(404);
  });

  test('sync with a key that a racing reset replaced is 401, and a lost delete race is not 204', async ({ request }) => {
    const { id, editKey } = await create(request);
    // Reset and sync at the same moment with the old key: the sync either ran first (200) or
    // finds its key gone (401). It never reports success after the reset took the key away.
    const [reset, s1] = await Promise.all([
      request.post(`/api/maps/${id}/reset-key`, { data: {}, headers: auth(editKey) }),
      sync(request, id, editKey, { places: { FRA: [1, now()] } }),
    ]);
    expect(reset.status()).toBe(200);
    expect([200, 401]).toContain(s1.status());
    expect((await sync(request, id, editKey, { places: {} })).status()).toBe(401);
    // Two deletes with the same key: exactly one deletes; the other is 401 (raced) or 404 (gone).
    const { editKey: fresh } = await reset.json();
    const dels = await Promise.all([
      request.delete(`/api/maps/${id}`, { headers: auth(fresh) }),
      request.delete(`/api/maps/${id}`, { headers: auth(fresh) }),
    ]);
    const codes = dels.map((r) => r.status()).sort();
    expect(codes[0]).toBe(204);
    expect([401, 404]).toContain(codes[1]);
  });
});

test.describe('notes link', () => {
  test('notes-link needs the edit key; on is idempotent; sync reports the token', async ({ request }) => {
    const t = now();
    const { id, editKey } = await create(request, { notes: { FRA: [5, 2019, 'hello', t] } });
    expect((await notesLink(request, id, null, 'on')).status()).toBe(401);
    expect((await notesLink(request, id, 'W'.repeat(22), 'on')).status()).toBe(401);
    const on = await notesLink(request, id, editKey, 'on');
    expect(on.status()).toBe(200);
    expect(on.headers()['cache-control']).toBe('no-store');
    const { notesToken } = await on.json();
    expect(notesToken).toMatch(KEY_RE);
    expect((await (await notesLink(request, id, editKey, 'on')).json()).notesToken).toBe(notesToken);
    // other editing devices learn it from sync, even on the no-op path
    const s = await sync(request, id, editKey, { since: 1 });
    expect(s.headers()['x-atlas-read']).toBe('meta');
    expect((await s.json()).notesToken).toBe(notesToken);
  });

  test('notes GET: right token gets notes; wrong, missing, off and reset tokens are 401', async ({ request }) => {
    const t = now();
    const { id, editKey } = await create(request, {
      places: { FRA: [1, t], JPN: [2, t] },
      notes: { FRA: [5, 2019, 'Paris in spring', t] },
    });
    // Before the link exists, every token fails the same way (nothing reveals whether one exists).
    const before = await getNotes(request, id, 'A'.repeat(22));
    expect(before.status()).toBe(401);
    const beforeBody = await before.json();
    const { notesToken } = await (await notesLink(request, id, editKey, 'on')).json();

    const res = await getNotes(request, id, notesToken);
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(res.headers()['x-atlas-cache']).toBe('miss');
    const text = await res.text();
    expect(text).not.toMatch(/key_hash|notes_token|notesToken|editKey/);
    expect(text).not.toContain(notesToken);
    const m = JSON.parse(text);
    expect(Object.keys(m).sort()).toEqual(['id', 'name', 'notes', 'owner', 'ownerT', 'places', 'rev', 'updated']);
    expect(m.places).toEqual({ FRA: [1, t, 1], JPN: [2, t, 1] });
    expect(m.notes).toEqual({ FRA: [5, 2019, 'Paris in spring', t, 1] });

    // cached under the token's hash; a sync purges it
    await sleep(200);
    expect((await getNotes(request, id, notesToken)).headers()['x-atlas-cache']).toBe('hit');
    await sync(request, id, editKey, { notes: { FRA: [4, 2019, 'edited', t + 1] } });
    const fresh = await getNotes(request, id, notesToken);
    expect(fresh.headers()['x-atlas-cache']).toBe('miss');
    expect((await fresh.json()).notes.FRA[2]).toBe('edited');

    for (const bad of [null, 'B'.repeat(22), 'short', notesToken + 'x']) {
      const r = await getNotes(request, id, bad);
      expect(r.status(), String(bad)).toBe(401);
      expect(await r.json()).toEqual(beforeBody);
    }
    // The edit key is not a notes token.
    expect((await getNotes(request, id, editKey)).status()).toBe(401);

    // reset: the old token stops working at once (purged here), the new one works
    await sleep(200);
    expect((await getNotes(request, id, notesToken)).headers()['x-atlas-cache']).toBe('hit');
    const { notesToken: reset } = await (await notesLink(request, id, editKey, 'reset')).json();
    expect(reset).toMatch(KEY_RE);
    expect(reset).not.toBe(notesToken);
    expect((await getNotes(request, id, notesToken)).status()).toBe(401);
    expect((await getNotes(request, id, reset)).status()).toBe(200);

    // off: the token stops working; sync reports null
    await sleep(200);
    const off = await notesLink(request, id, editKey, 'off');
    expect(await off.json()).toEqual({ notesToken: null });
    expect((await getNotes(request, id, reset)).status()).toBe(401);
    expect((await (await sync(request, id, editKey, {})).json()).notesToken).toBeNull();
    // the plain view is unaffected throughout
    expect((await request.get(`/api/maps/${id}`)).status()).toBe(200);
  });

  test('notes GET: after 10 bad tokens, bad tokens get 429 but the right one still works', async ({ request }) => {
    const { id, editKey } = await create(request);
    const { notesToken } = await (await notesLink(request, id, editKey, 'on')).json();
    const wrong = 'Q'.repeat(22);
    for (let i = 0; i < 10; i++) expect((await getNotes(request, id, wrong)).status()).toBe(401);
    const limited = await getNotes(request, id, wrong);
    expect(limited.status()).toBe(429);
    expect(limited.headers()['retry-after']).toBe('60');
    expect((await getNotes(request, id, notesToken)).status()).toBe(200);
  });

  test('deleting the map makes the notes link 404', async ({ request }) => {
    const { id, editKey } = await create(request);
    const { notesToken } = await (await notesLink(request, id, editKey, 'on')).json();
    expect((await getNotes(request, id, notesToken)).status()).toBe(200);
    await sleep(200);
    expect((await request.delete(`/api/maps/${id}`, { headers: auth(editKey) })).status()).toBe(204);
    expect((await getNotes(request, id, notesToken)).status()).toBe(404);
  });
});

test.describe('per-map caps', () => {
  test('1000 non-empty notes per map; tombstones do not count', async ({ request }) => {
    test.skip(CITIES.length < 1001, 'needs data/cities-ids.json with > 1000 cities');
    const t = now();
    const { id, editKey } = await create(request);
    const ids = CITIES.slice(0, 1001);
    for (let i = 0; i < 5; i++) {
      const chunk = Object.fromEntries(ids.slice(i * 200, i * 200 + 200).map((c) => [c, [1, 0, '', t]]));
      const r = await sync(request, id, editKey, { since: 1, notes: chunk });
      expect(r.status(), await r.text()).toBe(200);
    }
    const over = await sync(request, id, editKey, { since: 1, notes: { [ids[1000]]: [1, 0, '', t] } });
    expect(over.status()).toBe(400);
    expect((await over.json()).message).toMatch(/1000 notes/);
    // removing one and adding another in one request is fine; a tombstone never counts
    const swap = await sync(request, id, editKey, { since: 1, notes: { [ids[0]]: [0, 0, '', t + 1], [ids[1000]]: [1, 0, '', t] } });
    expect(swap.status(), await swap.text()).toBe(200);
  });
});

test.describe('rate-limit keys', () => {
  test('IPv6 clients are keyed by their /64, IPv4 as is', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:0db8:0001:0002:0000:0000:0000:0001')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8:1:2::ffff')).toBe(ipKey('2001:db8:1:2:9:8:7:6'));
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('2001:DB8:1:2::')).toBe('2001:db8:1:2::/64');
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('::')).toBe('0:0:0:0::/64');
    expect(ipKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(ipKey('2001:db8:a:b:c:d:192.0.2.1')).toBe('2001:db8:a:b::/64');
    expect(ipKey('::ffff:192.0.2.1')).toBe('192.0.2.1'); // IPv4-mapped = an IPv4 client
    expect(ipKey('2001:db8:1:3::1')).not.toBe(ipKey('2001:db8:1:2::1'));
    // Garbage still gives a stable key rather than throwing.
    expect(ipKey('1::2::3')).toBe('1::2::3');
    expect(ipKey('')).toBe('unknown');
    expect(ipKey(null)).toBe('unknown');
  });
});

test.describe('static site through the Worker', () => {
  test('app routes serve the app', async ({ request }) => {
    for (const p of ['/', '/map/anything-12345']) {
      const res = await request.get(p);
      expect(res.status(), p).toBe(200);
      expect(res.headers()['content-type']).toContain('text/html');
      expect(await res.text()).toContain('<html');
    }
    const data = await request.get('/data/world.json');
    expect(data.status()).toBe(200);
    expect(data.headers()['content-type']).toContain('json');
    await data.json();
  });

  test('repo-only files are not published', async ({ request }) => {
    const secrets = {
      '/tests/smoke.spec.mjs': '@playwright/test',
      '/worker/index.js': 'export default',
      '/worker/model.js': 'CONVERT_SQL',
      '/wrangler.jsonc': 'compatibility_date',
      '/README.md': 'Travel Atlas is a pair of maps',
      '/package.json': '"devDependencies"',
      '/migrations/0001_init.sql': 'CREATE TABLE',
      '/migrations/0002_docs.sql': 'ALTER TABLE',
      '/docs/SYNC.md': 'Sync design',
      '/docs/later/0003_drop_marks.sql': 'DROP TABLE',
      '/.assetsignore': 'node_modules',
    };
    for (const [p, marker] of Object.entries(secrets)) {
      const res = await request.get(p);
      const text = await res.text();
      expect(text, p).not.toContain(marker);
    }
  });
});
