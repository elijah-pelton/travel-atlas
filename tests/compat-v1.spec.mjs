// Old app versions (v1 sync client, js/app.js before the v2 store) against the v2 API, and lazy
// conversion of v1 D1 rows (maps.rev = 0, places in the `marks` table). Contract: docs/SYNC.md.
//
// The conversion tests seed v1 rows straight into the LOCAL D1 with `wrangler d1 execute --local`,
// so they only run against a local server. If that server was started with --persist-to <dir>,
// set D1_PERSIST_TO=<dir> so the seeding writes to the same database.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787/';
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(BASE);

const now = () => Date.now();
const auth = (key) => ({ Authorization: `Bearer ${key}` });
const sync = (request, id, key, body) => request.post(`/api/maps/${id}/sync`, { data: body, headers: auth(key) });

// What the v1 client does with a sync/GET response (js/app.js adoptRemote): e[0] === 1 means
// marked, anything else unmarked; e[1] is the time.
function v1Adopt(places) {
  const state = new Set();
  const clock = {};
  for (const id in places) {
    const e = places[id];
    clock[id] = +e[1] || 0;
    if (e[0] === 1) state.add(id);
  }
  return { state, clock };
}
// What the v1 client sends (js/app.js outgoing): marks -> [1, t], clock entries for unmarked -> [0, t].
function v1Outgoing({ state, clock }) {
  const out = {};
  for (const id in clock) if (!state.has(id) && clock[id] > 0) out[id] = [0, clock[id]];
  for (const id of state) out[id] = [1, clock[id] || 1];
  return { places: out };
}

function d1(sql) {
  const args = ['wrangler', 'd1', 'execute', 'DB', '--local', '--json', '--command', sql];
  if (process.env.D1_PERSIST_TO) args.push('--persist-to', process.env.D1_PERSIST_TO);
  const out = execFileSync('npx', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = JSON.parse(out);
  return parsed[0] ? parsed[0].results : [];
}

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
function randomId(prefix) {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += a[Math.floor(Math.random() * a.length)];
  return `${prefix}-${s}`;
}
// A map exactly as the v1 Worker wrote it: rev 0 (the 0002 default) and one marks row per place.
function seedV1Map(marks, { owner = 'Old', ownerT = 5 } = {}) {
  const id = randomId('v1');
  const key = 'K'.repeat(11) + Math.random().toString(36).slice(2, 13).padEnd(11, 'k');
  const hash = createHash('sha256').update(key).digest('hex');
  const t = now() - 100_000;
  const rows = Object.entries(marks).map(([p, [v, mt]]) => `(${sqlStr(id)}, ${sqlStr(p)}, ${v}, ${mt})`);
  d1(
    `INSERT INTO maps (id, name, owner, owner_t, key_hash, created, updated) VALUES (${sqlStr(id)}, 'Old map', ${sqlStr(owner)}, ${ownerT}, ${sqlStr(hash)}, ${t}, ${t});` +
      (rows.length ? ` INSERT INTO marks (map_id, place_id, visited, t) VALUES ${rows.join(', ')};` : '')
  );
  return { id, key };
}

test.describe('v1 clients', () => {
  test('old create body works and the response adopts cleanly', async ({ request }) => {
    const t = now();
    const res = await request.post('/api/maps', { data: { name: 'Old phone', owner: 'Ann', ownerT: t, places: { FRA: [1, t], DEU: [0, t] } } });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.editKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.map.places).toBeTruthy();
    const { state } = v1Adopt(body.map.places);
    expect([...state]).toEqual(['FRA']);
    expect(body.map).toMatchObject({ name: 'Old phone', owner: 'Ann', ownerT: t });
  });

  test('old sync body {owner, places:[0|1,t]} gets the full map; old empty pairing sync works', async ({ request }) => {
    const t = now() - 10_000;
    const created = await (await request.post('/api/maps', { data: { name: 'm', places: { FRA: [1, t] } } })).json();
    const { id, editKey } = created;
    // a v2 device adds a want and a note
    await sync(request, id, editKey, { since: 1, places: { JPN: [2, t + 1] }, notes: { FRA: [5, 2019, 'x', t] } });
    // the v1 pairing check: an empty sync with the key
    const pair = await sync(request, id, editKey, { places: {} });
    expect(pair.status()).toBe(200);
    const p = await pair.json();
    expect(p.places).toBeTruthy();
    expect(Object.keys(p.places).sort()).toEqual(['FRA', 'JPN']);
    // a regular v1 sync: owner + every opinion, no since
    const res = await sync(request, id, editKey, { owner: ['Ann', t], places: { FRA: [1, t], 'US-CA': [1, t + 2], DEU: [0, t] } });
    expect(res.status()).toBe(200);
    const m = await res.json();
    expect(m.full).toBe(true);
    expect(Object.keys(m.places).sort()).toEqual(['DEU', 'FRA', 'JPN', 'US-CA']);
    expect(m.owner).toBe('Ann');
    // to a v1 client, a want looks unmarked
    expect([...v1Adopt(m.places).state].sort()).toEqual(['FRA', 'US-CA']);
  });

  test('a want echoed back by a v1 client as [0, same t] changes nothing', async ({ request }) => {
    const t = now() - 10_000;
    const { id, editKey } = await (await request.post('/api/maps', { data: { name: 'm', places: { FRA: [1, t] } } })).json();
    const v2 = await (await sync(request, id, editKey, { since: 1, places: { JPN: [2, t + 5] } })).json();
    expect(v2.rev).toBe(2);
    // v1 device: adopt the full map, then send its opinions back
    const v1 = v1Adopt((await (await sync(request, id, editKey, { places: {} })).json()).places);
    const body = v1Outgoing(v1);
    expect(body.places.JPN).toEqual([0, t + 5]);
    const after = await (await sync(request, id, editKey, body)).json();
    expect(after.places.JPN).toEqual([2, t + 5, 2]);
    expect(after.rev).toBe(2); // nothing written
    // but a real later un-mark on the v1 device still wins
    const later = await (await sync(request, id, editKey, { places: { JPN: [0, t + 6] } })).json();
    expect(later.places.JPN).toEqual([0, t + 6, 3]);
  });

  test('v1 responses never break on new fields: GET has places with 3-element entries', async ({ request }) => {
    const t = now();
    const { id } = await (await request.post('/api/maps', { data: { name: 'm', places: { FRA: [1, t], ITA: [2, t] } } })).json();
    const g = await (await request.get(`/api/maps/${id}`)).json();
    for (const e of Object.values(g.places)) {
      expect(typeof e[0]).toBe('number');
      expect(typeof e[1]).toBe('number');
    }
    expect([...v1Adopt(g.places).state]).toEqual(['FRA']);
  });
});

test.describe('lazy conversion of v1 rows (rev = 0)', () => {
  test.skip(!LOCAL, 'seeds the local D1 directly');

  test('GET converts a v1 map once; marks become [visited, t, 1]', async ({ request }) => {
    const { id } = seedV1Map({ 'US-CA': [1, 111], FRA: [0, 222], DEU: [1, 333] });
    expect(d1(`SELECT rev FROM maps WHERE id = ${sqlStr(id)}`)[0].rev).toBe(0);
    const res = await request.get(`/api/maps/${id}`);
    expect(res.status()).toBe(200);
    const m = await res.json();
    expect(m).toMatchObject({ id, name: 'Old map', owner: 'Old', ownerT: 5, rev: 1 });
    expect(m.places).toEqual({ DEU: [1, 333, 1], FRA: [0, 222, 1], 'US-CA': [1, 111, 1] });
    const row = d1(`SELECT rev, pub_rev, priv_rev, pub, priv, notes_token FROM maps WHERE id = ${sqlStr(id)}`)[0];
    expect(row).toEqual({ rev: 1, pub_rev: 1, priv_rev: 0, pub: '{"DEU":[1,333,1],"FRA":[0,222,1],"US-CA":[1,111,1]}', priv: '{}', notes_token: null });
    // marks stay (rollback safety until 0003)
    expect(d1(`SELECT count(*) AS n FROM marks WHERE map_id = ${sqlStr(id)}`)[0].n).toBe(3);
  });

  test('sync converts a v1 map and merges on top; since works after', async ({ request }) => {
    const { id, key } = seedV1Map({ FRA: [1, 1000], ITA: [1, 1000] });
    const res = await sync(request, id, key, { places: { FRA: [0, 2000], ESP: [2, 1500] }, notes: { ITA: [4, 2018, 'Rome', 1500] } });
    expect(res.status(), await res.text()).toBe(200);
    const m = await res.json();
    expect(m.rev).toBe(2);
    expect(m.places).toEqual({ ESP: [2, 1500, 2], FRA: [0, 2000, 2], ITA: [1, 1000, 1] });
    expect(m.notes).toEqual({ ITA: [4, 2018, 'Rome', 1500, 2] });
    const d = await (await sync(request, id, key, { since: 2 })).json();
    expect(d).toMatchObject({ rev: 2, places: {}, notes: {}, full: false });
  });

  test('empty v1 map converts; v1 pairing sync works; wrong key never converts', async ({ request }) => {
    const { id, key } = seedV1Map({});
    expect((await sync(request, id, 'W'.repeat(22), { places: {} })).status()).toBe(401);
    expect(d1(`SELECT rev FROM maps WHERE id = ${sqlStr(id)}`)[0].rev).toBe(0);
    const pair = await (await sync(request, id, key, { places: {} })).json();
    expect(pair).toMatchObject({ rev: 1, places: {}, notes: {}, full: true, notesToken: null });
  });

  test('delete removes the legacy marks rows too', async ({ request }) => {
    const { id, key } = seedV1Map({ FRA: [1, 1] });
    expect((await request.delete(`/api/maps/${id}`, { headers: auth(key) })).status()).toBe(204);
    expect(d1(`SELECT count(*) AS n FROM marks WHERE map_id = ${sqlStr(id)}`)[0].n).toBe(0);
    expect((await request.get(`/api/maps/${id}`)).status()).toBe(404);
  });
});
