// Sync API tests (contract: docs/SYNC.md). Runs against `npm run dev:test` (wrangler dev on
// 127.0.0.1:8787, local D1). That script sets RL_IP_LIMITS=0, which turns off only the
// limits keyed by IP alone (create 5/min, read 60/min, writes 30/min) because every test request
// comes from one IP. The per-map limits stay on (writes 10/min per map), and each test uses its
// own fresh map with fewer than 10 writes, so they never bite by accident; the bad-key test
// below proves the 429 path for real.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLACE_IDS } from '../worker/place-ids.js';
import { ipKey } from '../worker/net.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const KEY_RE = /^[A-Za-z0-9_-]{22}$/;
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?-[abcdefghjkmnpqrstuvwxyz23456789]{5}$/;

const now = () => Date.now();
const auth = (key) => ({ Authorization: `Bearer ${key}` });

async function create(request, body = {}) {
  const res = await request.post('/api/maps', { data: { name: 'Test Atlas', places: {}, ...body } });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

async function sync(request, id, key, body) {
  return request.post(`/api/maps/${id}/sync`, { data: body, headers: key ? auth(key) : {} });
}

test.describe('sync API', () => {
  test('create returns 201 with id, 22-char key and the map', async ({ request }) => {
    const t = now();
    const res = await request.post('/api/maps', {
      data: { name: '  Élijah’s Trips!  ', owner: 'Elijah', ownerT: t, places: { 'US-CA': [1, t], FRA: [1, t] } },
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
    expect(body.map).toMatchObject({
      id: body.id,
      name: 'Élijah’s Trips!',
      owner: 'Elijah',
      ownerT: t,
      places: { 'US-CA': [1, t], FRA: [1, t] },
    });
    expect(JSON.stringify(body.map)).not.toMatch(/key_hash|keyHash/);
  });

  test('slug falls back to "atlas" and is cut to 20 chars', async ({ request }) => {
    expect((await create(request, { name: '!!!' })).id).toMatch(/^atlas-[a-z2-9]{5}$/);
    const long = await create(request, { name: 'The Quite Extraordinarily Long Name' });
    expect(long.id).toMatch(/^the-quite-extraordin-[a-z2-9]{5}$/);
  });

  test('GET returns places including visited 0 rows, never the key hash', async ({ request }) => {
    const t = now();
    const { id } = await create(request, { places: { 'US-NY': [1, t], 'CA-ON': [0, t], JPN: [1, t] } });
    const res = await request.get(`/api/maps/${id}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('no-store');
    const text = await res.text();
    expect(text).not.toMatch(/key_hash|keyHash|editKey/);
    const map = JSON.parse(text);
    expect(Object.keys(map).sort()).toEqual(['id', 'name', 'owner', 'ownerT', 'places', 'updated']);
    expect(map.places).toEqual({ 'CA-ON': [0, t], JPN: [1, t], 'US-NY': [1, t] });
  });

  test('unknown or malformed map id is 404', async ({ request }) => {
    for (const path of ['/api/maps/nobody-zzzzz', '/api/maps/NOT_AN_ID', '/api/nothing']) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'not_found' });
      expect(res.headers()['cache-control']).toBe('no-store');
    }
    const r = await sync(request, 'nobody-zzzzz', 'A'.repeat(22), { places: {} });
    expect(r.status()).toBe(404);
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

  test('sync merges per place, last writer wins', async ({ request }) => {
    const t0 = now() - 100_000;
    const { id, editKey } = await create(request, {
      places: { 'US-CA': [1, t0], 'US-TX': [1, t0], 'US-OR': [0, t0], FRA: [1, t0] },
    });
    const res = await sync(request, id, editKey, {
      places: {
        'US-CA': [0, t0 - 10], // older removal: ignored
        'US-TX': [0, t0 + 10], // newer removal: wins over the add
        'US-OR': [1, t0 + 10], // newer add: wins over the removal
        FRA: [1, t0], // same t: no change
        DEU: [1, t0], // new place
      },
    });
    expect(res.status()).toBe(200);
    const map = await res.json();
    expect(map.places).toEqual({
      'US-CA': [1, t0],
      'US-TX': [0, t0 + 10],
      'US-OR': [1, t0 + 10],
      FRA: [1, t0],
      DEU: [1, t0],
    });
    expect((await (await request.get(`/api/maps/${id}`)).json()).places).toEqual(map.places);
  });

  test('updated moves only when something changed', async ({ request }) => {
    const t0 = now() - 50_000;
    const { id, editKey, map: created } = await create(request, { places: { FRA: [1, t0] } });
    await new Promise((r) => setTimeout(r, 20));
    const same = await (await sync(request, id, editKey, { places: { FRA: [0, t0 - 1] } })).json();
    expect(same.updated).toBe(created.updated);
    const changed = await (await sync(request, id, editKey, { places: { FRA: [0, t0 + 1] } })).json();
    expect(changed.updated).toBeGreaterThan(created.updated);
  });

  test('t is clamped to server now + 5 minutes', async ({ request }) => {
    const { id, editKey } = await create(request);
    const far = now() + 365 * 24 * 3600 * 1000;
    const map = await (await sync(request, id, editKey, { places: { ITA: [1, far] } })).json();
    expect(map.places.ITA[1]).toBeLessThanOrEqual(now() + 5 * 60 * 1000 + 1000);
    expect(map.places.ITA[1]).toBeGreaterThan(now() + 4 * 60 * 1000);
  });

  test('owner name is last-writer-wins on its timestamp', async ({ request }) => {
    const t0 = now() - 100_000;
    const { id, editKey } = await create(request, { owner: 'Ann', ownerT: t0 });
    let map = await (await sync(request, id, editKey, { owner: ['Old', t0 - 1], places: {} })).json();
    expect(map).toMatchObject({ owner: 'Ann', ownerT: t0 });
    map = await (await sync(request, id, editKey, { owner: ['Bea', t0 + 5] })).json();
    expect(map).toMatchObject({ owner: 'Bea', ownerT: t0 + 5 });
  });

  test('two devices syncing different places both end up with the union', async ({ request }) => {
    const t = now() - 10_000;
    const { id, editKey } = await create(request);
    const a = await (await sync(request, id, editKey, { places: { 'US-CA': [1, t], 'US-NV': [1, t] } })).json();
    expect(Object.keys(a.places).sort()).toEqual(['US-CA', 'US-NV']);
    // Device B never saw A's places and has its own; it gets the merged map back.
    const b = await (await sync(request, id, editKey, { places: { MEX: [1, t + 1], 'CA-BC': [1, t + 2] } })).json();
    expect(b.places).toEqual({ 'CA-BC': [1, t + 2], MEX: [1, t + 1], 'US-CA': [1, t], 'US-NV': [1, t] });
    // Device A's next sync (still only its own opinions) also sees B's places.
    const a2 = await (await sync(request, id, editKey, { places: { 'US-CA': [1, t], 'US-NV': [1, t] } })).json();
    expect(a2.places).toEqual(b.places);
  });

  test('validation errors are 400 bad_request', async ({ request }) => {
    const t = now();
    const bads = [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(41) },
      { name: 42 },
      { name: 'ok', owner: 'y'.repeat(41) },
      { name: 'ok', places: { 'usa': [1, t] } },
      { name: 'ok', places: { 'US-CALI': [1, t] } },
      { name: 'ok', places: { 'U-S': [1, t] } },
      { name: 'ok', places: { 'QA-AAA': [1, t] } }, // fits the old regex, but is not a real place
      { name: 'ok', places: { 'ZZZ': [1, t] } },
      { name: 'ok', places: { 'US-ZZ': [1, t] } },
      { name: '\u202E\u0000' }, // only invisible characters: empty after cleaning
      { name: 'ok', places: { FRA: [2, t] } },
      { name: 'ok', places: { FRA: [1, 0] } },
      { name: 'ok', places: { FRA: [1, 1.5] } },
      { name: 'ok', places: { FRA: [1] } },
      { name: 'ok', places: [] },
    ];
    for (const data of bads) {
      const res = await request.post('/api/maps', { data });
      expect(res.status(), JSON.stringify(data)).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('bad_request');
      expect(typeof body.message).toBe('string');
    }
    // 401 places in one request: refused on the count before any id is looked at
    const many = {};
    const L = (n) => String.fromCharCode(65 + n);
    for (let i = 0; i < 401; i++) many[`${L(Math.floor(i / 26))}${L(i % 26)}-AA`] = [1, t];
    expect(Object.keys(many).length).toBe(401);
    const tooMany = await request.post('/api/maps', { data: { name: 'ok', places: many } });
    expect(tooMany.status()).toBe(400);
    expect((await tooMany.json()).message).toMatch(/At most 400/);
    // every real place at once is fine (fewer than 400 exist)
    const all = Object.fromEntries([...PLACE_IDS].map((id) => [id, [1, t]]));
    expect(Object.keys(all).length).toBeLessThanOrEqual(400);
    const allRes = await request.post('/api/maps', { data: { name: 'ok', places: all } });
    expect(allRes.status()).toBe(201);
    expect(Object.keys((await allRes.json()).map.places).length).toBe(PLACE_IDS.size);
    // non-JSON content type and broken JSON
    const form = await request.post('/api/maps', { form: { name: 'ok' } });
    expect(form.status()).toBe(400);
    const broken = await request.post('/api/maps', { data: '{"name":', headers: { 'Content-Type': 'application/json' } });
    expect(broken.status()).toBe(400);
    // sync validation too
    const { id, editKey } = await create(request);
    expect((await sync(request, id, editKey, { places: { 'xx-yy': [1, t] } })).status()).toBe(400);
    expect((await sync(request, id, editKey, { places: { 'QA-AAA': [1, t] } })).status()).toBe(400);
    expect((await sync(request, id, editKey, { owner: 'not-a-pair' })).status()).toBe(400);
  });

  test('bodies over 64 KB are 413', async ({ request }) => {
    const res = await request.post('/api/maps', {
      data: JSON.stringify({ name: 'big', pad: 'x'.repeat(70 * 1024) }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'too_large' });
  });

  test('reset-key: old key stops working, new key works', async ({ request }) => {
    const { id, editKey } = await create(request);
    const res = await request.post(`/api/maps/${id}/reset-key`, { data: {}, headers: auth(editKey) });
    expect(res.status()).toBe(200);
    const { editKey: fresh } = await res.json();
    expect(fresh).toMatch(KEY_RE);
    expect(fresh).not.toBe(editKey);
    expect((await sync(request, id, editKey, { places: {} })).status()).toBe(401);
    expect((await sync(request, id, fresh, { places: {} })).status()).toBe(200);
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
    // Bad keys are not counted against the map's budget (they have their own limit).
    const other = await create(request);
    for (let i = 0; i < 9; i++) await sync(request, other.id, 'W'.repeat(22), { places: {} });
    expect((await sync(request, other.id, other.editKey, { places: {} })).status()).toBe(200);
  });

  test('real place ids are accepted, made-up ones are not', async ({ request }) => {
    const t = now();
    const real = ['US-PRI', 'CA-ON', 'KOS', 'SAH', 'PSX', 'US-DC', 'US-HI'];
    const { id, editKey, map } = await create(request, { places: Object.fromEntries(real.map((p) => [p, [1, t]])) });
    expect(Object.keys(map.places).sort()).toEqual([...real].sort());
    for (const fake of ['QA-AAA', 'XX', 'AAA', 'US-XX', 'CA-ZZZ', 'us-ca', 'FRA ']) {
      const res = await sync(request, id, editKey, { places: { [fake]: [1, t] } });
      expect(res.status(), fake).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_request' });
    }
  });

  test('worker/place-ids.js matches the map data', async () => {
    // Throws (exit 1) if someone changed data/*.json without regenerating the allowlist.
    const out = execFileSync(process.execPath, [path.join(REPO, 'tools', 'make-place-ids.mjs'), '--check'], {
      encoding: 'utf8',
    });
    expect(out).toMatch(/up to date/);
    for (const id of ['US-PRI', 'CA-ON', 'KOS', 'SAH', 'PSX', 'FRA', 'US-CA']) expect(PLACE_IDS.has(id), id).toBe(true);
    expect(PLACE_IDS.has('QA-AAA')).toBe(false);
    expect(() => PLACE_IDS.add('QA-AAA')).toThrow();
  });

  test('control and format characters are stripped from name and owner', async ({ request }) => {
    const t = now();
    const res = await request.post('/api/maps', {
      data: { name: '\u202E  Ann\u0000’s\u200B Map\u0007  ', owner: '\u0000Ann\u202E\u2066', ownerT: t, places: {} },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.map.name).toBe('Ann’s Map');
    expect(body.map.owner).toBe('Ann');
    expect(body.id).toMatch(/^ann-s-map-[a-z2-9]{5}$/);
    // 40 visible chars plus invisible padding is fine; the padding does not count.
    const padded = await request.post('/api/maps', { data: { name: 'x'.repeat(40) + '\u202E'.repeat(10) } });
    expect(padded.status()).toBe(201);
    expect((await padded.json()).map.name).toBe('x'.repeat(40));
    // Sync cleans the owner too.
    const synced = await sync(request, body.id, body.editKey, { owner: ['\u202EBea\u0000', t + 1] });
    expect((await synced.json()).owner).toBe('Bea');
  });

  test('reads are cached at the edge, and every write purges the cache', async ({ request }) => {
    const t = now() - 10_000;
    const { id, editKey } = await create(request, { places: { FRA: [1, t] } });
    const first = await request.get(`/api/maps/${id}`);
    expect(first.headers()['x-atlas-cache']).toBe('miss');
    await new Promise((r) => setTimeout(r, 200)); // the cache write runs after the response
    const second = await request.get(`/api/maps/${id}`);
    expect(second.headers()['x-atlas-cache']).toBe('hit');
    expect(second.headers()['cache-control']).toBe('no-store'); // browsers never cache it
    expect(await second.json()).toEqual(await first.json());
    // sync purges: the next read sees the change at once
    expect((await sync(request, id, editKey, { places: { DEU: [1, t] } })).status()).toBe(200);
    const after = await request.get(`/api/maps/${id}`);
    expect(after.headers()['x-atlas-cache']).toBe('miss');
    expect((await after.json()).places).toEqual({ DEU: [1, t], FRA: [1, t] });
    // delete purges: a deleted map is gone at once, not 15 s later
    await new Promise((r) => setTimeout(r, 200));
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
    for (const path of ['/', '/map/anything-12345']) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
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
      '/wrangler.jsonc': 'compatibility_date',
      '/README.md': 'Travel Atlas is a pair of maps',
      '/package.json': '"devDependencies"',
      '/migrations/0001_init.sql': 'CREATE TABLE',
      '/docs/SYNC.md': 'Sync design',
      '/.assetsignore': 'node_modules',
    };
    for (const [path, marker] of Object.entries(secrets)) {
      const res = await request.get(path);
      const text = await res.text();
      expect(text, path).not.toContain(marker);
    }
  });
});
