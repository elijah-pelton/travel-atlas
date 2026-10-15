// Travel Atlas sync API (contract: docs/SYNC.md).
// Only /api/* reaches this code (assets.run_worker_first); everything else is the static site.
import { PLACE_IDS } from './place-ids.js';
import { ipKey } from './net.js';

const MAX_BODY = 64 * 1024;
const MAX_PLACES = 400;
const MAX_NAME = 40;
const FUTURE_SLACK_MS = 5 * 60 * 1000;
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const READ_CACHE_SECONDS = 15;
// Control (Cc: NUL, newlines, ...) and format (Cf: bidi overrides like U+202E, zero-width chars).
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/gu;
// <slug>-<5 chars>; the slug never starts or ends with "-" and is at most 20 chars.
const MAP_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?-[abcdefghjkmnpqrstuvwxyz23456789]{5}$/;
const KEY_RE = /^[A-Za-z0-9_-]{22}$/;

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, ctx, url);
    } catch (err) {
      if (err instanceof ApiError) return error(err.status, err.code, err.message);
      console.error('api error', err && err.stack ? err.stack : err);
      return error(500, 'server_error', 'Something went wrong on the server.');
    }
  },
};

// ---------- routing ----------

async function handleApi(request, env, ctx, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ["api", "maps", id?, action?]
  const method = request.method;
  if (parts[1] !== 'maps' || parts.length > 4) return notFound();

  if (parts.length === 2) {
    if (method === 'POST') return createMap(request, env, url);
    return notFound();
  }

  const id = parts[2];
  if (!MAP_ID_RE.test(id)) return notFound();

  if (parts.length === 3) {
    if (method === 'GET') return getMap(request, env, ctx, url, id);
    if (method === 'DELETE') return deleteMap(request, env, url, id);
    return notFound();
  }
  if (method === 'POST' && parts[3] === 'sync') return syncMap(request, env, url, id);
  if (method === 'POST' && parts[3] === 'reset-key') return resetKey(request, env, url, id);
  return notFound();
}

// ---------- endpoints ----------

async function createMap(request, env, url) {
  if (ipLimitsOn(env) && !(await allow(env, 'RL_CREATE', clientIp(request)))) return rateLimited();

  const body = await readJson(request);
  const name = checkName(body.name);
  const owner = body.owner === undefined ? '' : checkOwnerName(body.owner);
  let ownerT = 0;
  if (body.ownerT !== undefined) {
    if (!Number.isSafeInteger(body.ownerT) || body.ownerT < 0) throw bad('ownerT must be an integer ≥ 0.');
    ownerT = clampT(body.ownerT);
  }
  const places = checkPlaces(body.places === undefined ? {} : body.places);

  const editKey = newEditKey();
  const keyHash = await sha256Hex(editKey);
  const now = Date.now();
  const slug = slugify(name);

  // Retry on the (very unlikely) chance the random suffix collides with an existing map.
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = `${slug}-${randomSuffix()}`;
    const stmts = [
      env.DB.prepare(
        'INSERT INTO maps (id, name, owner, owner_t, key_hash, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)'
      ).bind(id, name, owner, ownerT, keyHash, now),
    ];
    if (Object.keys(places).length) stmts.push(upsertMarks(env, id, places));
    try {
      await env.DB.batch(stmts);
    } catch (err) {
      if (/UNIQUE|constraint/i.test(String(err && err.message))) continue;
      throw err;
    }
    await purgeMap(url, id); // nothing should be cached for a brand-new id, but be sure
    const map = { id, name, owner, ownerT, updated: now, places: sortPlaces(places) };
    return json(201, { id, editKey, map });
  }
  throw new Error('could not allocate a unique map id');
}

// Reads are cached at the edge (this Cloudflare location's Cache API, server side only) for
// 15 s, so a popular view link costs at most ~4 D1 reads a minute per location. Writes purge the
// entry, so an editor's next read is fresh. Browsers still get Cache-Control: no-store.
async function getMap(request, env, ctx, url, id) {
  const cacheKey = mapCacheKey(url, id);
  const hit = await cacheMatch(cacheKey);
  if (hit) return json(200, hit, { 'X-Atlas-Cache': 'hit' }, true);

  if (ipLimitsOn(env) && !(await allow(env, 'RL_READ', clientIp(request)))) return rateLimited();
  const map = await loadMap(env, id);
  if (!map) return notFound();
  const body = JSON.stringify(map);
  ctx.waitUntil(cachePut(cacheKey, body));
  return json(200, body, { 'X-Atlas-Cache': 'miss' }, true);
}

async function syncMap(request, env, url, id) {
  const auth = await authorize(request, env, id);
  if (auth instanceof Response) return auth;

  const body = await readJson(request);
  const places = checkPlaces(body.places === undefined ? {} : body.places);
  let owner = null;
  if (body.owner !== undefined) {
    if (!Array.isArray(body.owner) || body.owner.length !== 2) throw bad('owner must be [name, t].');
    owner = [checkOwnerName(body.owner[0]), checkT(body.owner[1], 'owner t')];
  }

  // One batch = one transaction. Every write re-checks the key hash, so a concurrent
  // reset-key or delete between the auth read and this batch cannot slip a write in; the
  // final key check (same transaction) then tells the client its key stopped working.
  // A no-op sync (every t <= stored t, owner not newer) writes 0 rows: the upsert and
  // UPDATEs are guarded, so it costs only reads (see "D1 cost per request" in docs/SYNC.md).
  const now = Date.now();
  const stmts = [];
  if (Object.keys(places).length) {
    stmts.push(upsertMarks(env, id, places, auth.keyHash));
    // changes() = rows the upsert above actually inserted or updated (older t's change nothing).
    stmts.push(env.DB.prepare('UPDATE maps SET updated = ?2 WHERE id = ?1 AND changes() > 0').bind(id, now));
  }
  if (owner) {
    stmts.push(
      env.DB.prepare(
        'UPDATE maps SET owner = ?2, owner_t = ?3, updated = ?4 WHERE id = ?1 AND key_hash = ?5 AND ?3 > owner_t'
      ).bind(id, owner[0], owner[1], now, auth.keyHash)
    );
  }
  stmts.push(...selectMap(env, id));
  const results = await env.DB.batch(stmts);
  const row = results[results.length - 2].results[0];
  if (!row) {
    await purgeMap(url, id);
    return notFound(); // deleted between the auth check and the batch
  }
  if (!timingSafeEqualStr(row.key_hash, auth.keyHash)) {
    return error(401, 'bad_key', 'The edit key is not valid for this map.'); // reset raced this sync
  }
  await purgeMap(url, id);
  return json(200, mapFromRows(row, results[results.length - 1].results));
}

async function resetKey(request, env, url, id) {
  const auth = await authorize(request, env, id);
  if (auth instanceof Response) return auth;
  await readJson(request, { allowEmpty: true }); // body is `{}`; still enforces type and size

  const editKey = newEditKey();
  const res = await env.DB.prepare('UPDATE maps SET key_hash = ?3 WHERE id = ?1 AND key_hash = ?2')
    .bind(id, auth.keyHash, await sha256Hex(editKey))
    .run();
  if (!res.meta || res.meta.changes !== 1) return error(401, 'bad_key', 'The edit key is not valid for this map.');
  await purgeMap(url, id);
  return json(200, { editKey });
}

async function deleteMap(request, env, url, id) {
  const auth = await authorize(request, env, id);
  if (auth instanceof Response) return auth;

  const results = await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM marks WHERE map_id = ?1 AND EXISTS (SELECT 1 FROM maps WHERE id = ?1 AND key_hash = ?2)'
    ).bind(id, auth.keyHash),
    env.DB.prepare('DELETE FROM maps WHERE id = ?1 AND key_hash = ?2').bind(id, auth.keyHash),
  ]);
  // 0 rows deleted = a reset-key or another delete got there first: the key no longer works.
  const deleted = results[1] && results[1].meta ? results[1].meta.changes : 0;
  if (deleted !== 1) return error(401, 'bad_key', 'The edit key is not valid for this map.');
  await purgeMap(url, id);
  return new Response(null, { status: 204, headers: securityHeaders() });
}

// ---------- auth + rate limits ----------

// Returns { keyHash } for a valid key, or the error Response to send.
// Order: the per-IP write budget first (it caps every write attempt, key or no key, before any
// D1 read); then the key; then the per-map write budget, counted only for a correct key so
// strangers guessing keys cannot use up a map's budget. Bad keys are counted per IP+map: after
// 10 in a window, further BAD keys get 429 instead of 401. A correct key is never refused for
// someone else's bad guesses (only by the normal write limits).
async function authorize(request, env, id) {
  const ip = clientIp(request);
  if (ipLimitsOn(env) && !(await allow(env, 'RL_IPWRITE', ip))) return rateLimited();

  const row = await env.DB.prepare('SELECT key_hash FROM maps WHERE id = ?1').bind(id).first();
  if (!row) return notFound();

  const m = /^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization') || '');
  const key = m ? m[1] : '';
  const presented = await sha256Hex(key); // hash even malformed keys: same work either way
  const ok = KEY_RE.test(key) && timingSafeEqualStr(presented, row.key_hash);

  if (!ok) {
    if (!(await allow(env, 'RL_BADKEY', `${ip}|${id}`))) return rateLimited();
    return error(401, 'bad_key', 'The edit key is missing or not valid for this map.');
  }

  if (!(await allow(env, 'RL_WRITE', id))) return rateLimited();
  return { keyHash: row.key_hash };
}

// "0" (only `npm run dev:test`) skips the limits keyed by IP alone, since a local test suite
// sends everything from 127.0.0.1. The per-map and per-IP+map limits always apply.
function ipLimitsOn(env) {
  return env.RL_IP_LIMITS !== '0';
}

// Fail open when a binding is missing or errors: limits are abuse protection, not correctness.
// But say so in the logs, once per binding per isolate, so a broken limiter is noticed.
const limiterWarned = new Set();
function warnLimiter(name, why) {
  if (limiterWarned.has(name)) return;
  limiterWarned.add(name);
  console.error(`rate limiter ${name} ${why}; failing open`);
}
async function allow(env, name, key) {
  const binding = env[name];
  if (!binding || typeof binding.limit !== 'function') {
    warnLimiter(name, 'binding is missing');
    return true;
  }
  try {
    const { success } = await binding.limit({ key });
    return success !== false;
  } catch (err) {
    warnLimiter(name, `threw ${err && err.message ? err.message : err}`);
    return true;
  }
}

// CF-Connecting-IP, with IPv6 cut to its /64 (see worker/net.js).
function clientIp(request) {
  return ipKey(request.headers.get('CF-Connecting-IP'));
}

// ---------- edge read cache ----------

// The canonical public URL of a map: no query string, no auth, so every viewer shares one entry.
function mapCacheKey(url, id) {
  return `${url.origin}/api/maps/${id}`;
}
async function cacheMatch(key) {
  try {
    const res = await caches.default.match(key);
    return res ? await res.text() : null;
  } catch {
    return null;
  }
}
async function cachePut(key, body) {
  try {
    await caches.default.put(
      key,
      new Response(body, {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `max-age=${READ_CACHE_SECONDS}` },
      })
    );
  } catch {
    /* no cache: every read goes to D1 */
  }
}
async function purgeMap(url, id) {
  try {
    await caches.default.delete(mapCacheKey(url, id));
  } catch {
    /* nothing to purge */
  }
}

// ---------- database helpers ----------

// All places in one statement: json_each expands the {placeId: [visited, t]} object into rows.
// A stored row is only replaced by a strictly newer t (last-writer-wins per place).
// With keyHash, rows are written only if the map still has that key (see syncMap).
function upsertMarks(env, id, places, keyHash) {
  const guard = keyHash
    ? 'EXISTS (SELECT 1 FROM maps WHERE id = ?1 AND key_hash = ?3)'
    : 'EXISTS (SELECT 1 FROM maps WHERE id = ?1)';
  const sql =
    'INSERT INTO marks (map_id, place_id, visited, t) ' +
    "SELECT ?1, j.key, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]') FROM json_each(?2) AS j " +
    `WHERE ${guard} ` + // a WHERE is also required before ON CONFLICT when inserting from a SELECT
    'ON CONFLICT (map_id, place_id) DO UPDATE SET visited = excluded.visited, t = excluded.t ' +
    'WHERE excluded.t > marks.t';
  const args = [id, JSON.stringify(places)];
  if (keyHash) args.push(keyHash);
  return env.DB.prepare(sql).bind(...args);
}

// key_hash is selected for syncMap's final key check; mapFromRows never copies it out.
function selectMap(env, id) {
  return [
    env.DB.prepare('SELECT id, name, owner, owner_t, updated, key_hash FROM maps WHERE id = ?1').bind(id),
    env.DB.prepare('SELECT place_id, visited, t FROM marks WHERE map_id = ?1 ORDER BY place_id').bind(id),
  ];
}

async function loadMap(env, id) {
  const [m, p] = await env.DB.batch(selectMap(env, id));
  return mapFromRows(m.results[0], p.results);
}

// Public shape only: never key_hash or created.
function mapFromRows(row, markRows) {
  if (!row) return null;
  const places = {};
  for (const r of markRows || []) places[r.place_id] = [r.visited, r.t];
  return { id: row.id, name: row.name, owner: row.owner, ownerT: row.owner_t, updated: row.updated, places };
}

// ---------- validation ----------

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (message) => new ApiError(400, 'bad_request', message);

// Reads the body with a hard 64 KB cap (Content-Length can be absent or wrong).
async function readJson(request, { allowEmpty = false } = {}) {
  const len = Number(request.headers.get('Content-Length'));
  if (len > MAX_BODY) throw new ApiError(413, 'too_large', 'Request body is larger than 64 KB.');

  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        reader.cancel().catch(() => {});
        throw new ApiError(413, 'too_large', 'Request body is larger than 64 KB.');
      }
      chunks.push(value);
    }
  }
  if (size === 0 && allowEmpty) return {};

  // Same-origin API: requiring JSON also means a plain cross-site form post can never reach it.
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw bad('Content-Type must be application/json.');

  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw bad('Body is not valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Body must be a JSON object.');
  return body;
}

// Invisible characters are removed before trimming and counting: they could hide in a name,
// reverse how it displays (U+202E), or pad the length check.
function cleanText(v) {
  return v.replace(INVISIBLE_RE, '').trim();
}

function checkName(v) {
  if (typeof v !== 'string') throw bad('name is required.');
  const s = cleanText(v);
  const n = [...s].length;
  if (n < 1 || n > MAX_NAME) throw bad(`name must be 1–${MAX_NAME} characters.`);
  return s;
}

function checkOwnerName(v) {
  if (typeof v !== 'string') throw bad('owner must be a string.');
  const s = cleanText(v);
  if ([...s].length > MAX_NAME) throw bad(`owner must be at most ${MAX_NAME} characters.`);
  return s;
}

function checkT(v, what = 't') {
  if (!Number.isSafeInteger(v) || v <= 0) throw bad(`${what} must be an integer > 0.`);
  return clampT(v);
}

// Client clocks can be wrong; a time far in the future would block every later edit.
function clampT(t) {
  return Math.min(t, Date.now() + FUTURE_SLACK_MS);
}

// Returns a fresh object { placeId: [visited, t] } with t clamped.
function checkPlaces(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('places must be an object.');
  const keys = Object.keys(v);
  if (keys.length > MAX_PLACES) throw bad(`At most ${MAX_PLACES} places per request.`);
  const out = {};
  for (const k of keys) {
    if (!PLACE_IDS.has(k)) throw bad(`Unknown place id: ${k.slice(0, 12).replace(INVISIBLE_RE, '')}`);
    const e = v[k];
    if (!Array.isArray(e) || e.length !== 2) throw bad(`places.${k} must be [visited, t].`);
    if (e[0] !== 0 && e[0] !== 1) throw bad(`places.${k}: visited must be 0 or 1.`);
    out[k] = [e[0], checkT(e[1], `places.${k}: t`)];
  }
  return out;
}

function sortPlaces(places) {
  const out = {};
  for (const k of Object.keys(places).sort()) out[k] = places[k];
  return out;
}

// ---------- ids, keys, hashing ----------

// Lowercase, strip accents, runs of anything but [a-z0-9] become "-", trim, max 20.
function slugify(name) {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
    .replace(/-+$/, '');
  return s || 'atlas';
}

// 5 chars from a 31-letter alphabet without look-alikes; rejection sampling keeps it uniform.
function randomSuffix() {
  let out = '';
  const limit = 256 - (256 % ID_ALPHABET.length);
  while (out.length < 5) {
    for (const b of crypto.getRandomValues(new Uint8Array(8))) {
      if (b < limit && out.length < 5) out += ID_ALPHABET[b % ID_ALPHABET.length];
    }
  }
  return out;
}

// 16 random bytes, base64url without padding = 22 chars.
function newEditKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualStr(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength) return false; // both are 64-char hex, so this never leaks
  return crypto.subtle.timingSafeEqual(ea, eb);
}

// ---------- responses ----------

function securityHeaders() {
  const { 'Content-Type': _ct, ...rest } = API_HEADERS;
  return rest;
}

function json(status, body, extra, raw = false) {
  return new Response(raw ? body : JSON.stringify(body), { status, headers: { ...API_HEADERS, ...extra } });
}

function error(status, code, message, extra) {
  return json(status, { error: code, message }, extra);
}

function notFound() {
  return error(404, 'not_found', 'No such map.');
}

function rateLimited() {
  return error(429, 'rate_limited', 'Too many requests. Try again in a minute.', { 'Retry-After': '60' });
}
