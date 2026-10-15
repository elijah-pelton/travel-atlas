// Travel Atlas sync API (contract: docs/SYNC.md).
// Only /api/* reaches this code (assets.run_worker_first); everything else is the static site.
// Validation, merging and response shapes live in worker/model.js (pure, Node-testable).
import { ipKey } from './net.js';
import {
  LIMITS,
  ModelError,
  bad,
  parseCreate,
  parseSync,
  parseDoc,
  serialize,
  stamp,
  mergeDoc,
  mergeOwner,
  delta,
  isFull,
  isNoop,
  docsNeeded,
  checkNoteCaps,
  storageRefuses,
  mapHead,
  publicBody,
  CONVERT_SQL,
} from './model.js';

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const READ_CACHE_SECONDS = 15;
const CAS_ATTEMPTS = 4; // first try + 3 retries, then 503 busy
// <slug>-<5 chars>; the slug never starts or ends with "-" and is at most 20 chars.
const MAP_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?-[abcdefghjkmnpqrstuvwxyz23456789]{5}$/;
const KEY_RE = /^[A-Za-z0-9_-]{22}$/; // edit keys and notes tokens: 16 random bytes, base64url

// Everything about a map except its documents (one row read; never sent to clients as is).
const META_COLS = 'id, name, owner, owner_t, updated, key_hash, rev, pub_rev, priv_rev, notes_token';

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

class ApiError extends ModelError {}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, ctx, url);
    } catch (err) {
      if (err instanceof ModelError) return error(err.status, err.code, err.message);
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
  if (method === 'GET' && parts[3] === 'notes') return getNotes(request, env, ctx, url, id);
  if (method === 'POST' && parts[3] === 'sync') return syncMap(request, env, url, id);
  if (method === 'POST' && parts[3] === 'notes-link') return notesLink(request, env, url, id);
  if (method === 'POST' && parts[3] === 'reset-key') return resetKey(request, env, url, id);
  return notFound();
}

// ---------- endpoints ----------

async function createMap(request, env, url) {
  if (ipLimitsOn(env) && !(await allow(env, 'RL_CREATE', clientIp(request)))) return rateLimited();

  const body = await readJson(request);
  const now = Date.now();
  const input = parseCreate(body, now);
  const pub = serialize(stamp(input.places, 1));
  const privDoc = stamp(input.notes, 1);
  const priv = serialize(privDoc);
  checkNoteCaps({}, privDoc, priv, '{}');

  // Storage guard: a new map always grows the database. size_after comes with every D1 result;
  // `SELECT 1` reads no rows.
  const probe = await env.DB.prepare('SELECT 1').all();
  if (storageRefuses(sizeAfter(probe), true)) return storageFull();

  const editKey = newToken();
  const keyHash = await sha256Hex(editKey);
  const slug = slugify(input.name);

  // Retry on the (very unlikely) chance the random suffix collides with an existing map.
  // New maps start at rev 1 (rev 0 means "not yet converted from the v1 marks table").
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = `${slug}-${randomSuffix()}`;
    try {
      await env.DB.prepare(
        'INSERT INTO maps (id, name, owner, owner_t, key_hash, created, updated, rev, pub, pub_rev, priv, priv_rev) ' +
          'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1, ?7, 1, ?8, 1)'
      )
        .bind(id, input.name, input.owner, input.ownerT, keyHash, now, pub, priv)
        .run();
    } catch (err) {
      if (/UNIQUE|constraint/i.test(String(err && err.message))) continue;
      throw err;
    }
    await purgeMap(url, id); // nothing should be cached for a brand-new id, but be sure
    const row = { id, name: input.name, owner: input.owner, owner_t: input.ownerT, updated: now, rev: 1, notes_token: null };
    const map = syncBody(row, delta(JSON.parse(pub), null), delta(privDoc, null), true, input.dropped);
    return json(201, { id, editKey, map });
  }
  throw new Error('could not allocate a unique map id');
}

// Reads are cached at the edge (this Cloudflare location's Cache API, server side only) for
// 15 s, so a popular view link costs at most ~4 D1 reads a minute per location. Writes purge the
// entry, so an editor's next read is fresh. Browsers still get Cache-Control: no-store.
// Never contains notes or anything about the notes link.
async function getMap(request, env, ctx, url, id) {
  const cacheKey = mapCacheKey(url, id);
  const hit = await cacheMatch(cacheKey);
  if (hit) return json(200, hit, { 'X-Atlas-Cache': 'hit' }, true);

  if (ipLimitsOn(env) && !(await allow(env, 'RL_READ', clientIp(request)))) return rateLimited();
  const cols = 'id, name, owner, owner_t, updated, rev, pub';
  let row = await env.DB.prepare(`SELECT ${cols} FROM maps WHERE id = ?1`).bind(id).first();
  if (row && row.rev === 0) row = await convert(env, id, cols);
  if (!row) return notFound();
  const body = publicBody(row);
  ctx.waitUntil(cachePut(cacheKey, body));
  return json(200, body, { 'X-Atlas-Cache': 'miss' }, true);
}

// The notes view link: `Authorization: Bearer <notesToken>`. Same shape as GET plus `notes`.
// Cached like GET, under a key derived from SHA-256(token), so only that token's holder can hit
// it. Wrong, malformed or disabled tokens are 401 and count toward RL_BADKEY (per IP + map).
async function getNotes(request, env, ctx, url, id) {
  const token = bearer(request);
  const tokenHash = await sha256Hex(token); // hash even malformed tokens: same work either way
  const wellFormed = KEY_RE.test(token);
  const cacheKey = notesCacheKey(url, id, tokenHash);
  if (wellFormed) {
    const hit = await cacheMatch(cacheKey);
    if (hit) return json(200, hit, { 'X-Atlas-Cache': 'hit' }, true);
  }

  const ip = clientIp(request);
  if (ipLimitsOn(env) && !(await allow(env, 'RL_READ', ip))) return rateLimited();
  const cols = 'id, name, owner, owner_t, updated, rev, pub, priv, notes_token';
  let row = await env.DB.prepare(`SELECT ${cols} FROM maps WHERE id = ?1`).bind(id).first();
  if (!row) return notFound();
  // Compare SHA-256 digests (always 64 hex chars) in constant time; a NULL token never matches.
  const ok = wellFormed && row.notes_token !== null && timingSafeEqualStr(tokenHash, await sha256Hex(row.notes_token));
  if (!ok) {
    if (!(await allow(env, 'RL_BADKEY', `${ip}|${id}`))) return rateLimited();
    return error(401, 'bad_key', 'The notes link is not valid for this map.');
  }
  if (row.rev === 0) {
    row = await convert(env, id, cols);
    if (!row) return notFound();
  }
  const body = publicBody(row, true);
  ctx.waitUntil(cachePut(cacheKey, body));
  return json(200, body, { 'X-Atlas-Cache': 'miss' }, true);
}

// Sync: merge what the client sent, answer with what it has not seen (entries with rev > since,
// or everything without `since`). Steps (D1 cost in docs/SYNC.md):
// meta row (in authorize) -> convert if rev = 0 -> no-op shortcut -> read the needed documents
// -> merge -> compare-and-swap UPDATE on rev (re-read and retry, then 503 busy) -> purge caches.
async function syncMap(request, env, url, id) {
  const auth = await authorize(request, env, id);
  if (auth instanceof Response) return auth;

  const body = await readJson(request);
  const now = Date.now();
  const input = parseSync(body, now);
  const { since } = input;
  const hasPlaces = Object.keys(input.places).length > 0;
  const hasNotes = Object.keys(input.notes).length > 0;

  let meta = auth.row;
  if (meta.rev === 0) {
    meta = await convert(env, id, META_COLS);
    if (!meta) return gone(url, id, null);
    if (!timingSafeEqualStr(meta.key_hash, auth.row.key_hash)) return keyReplaced();
  }

  // Nothing sent that could change anything, and the client is already at this rev: answer
  // from the meta row alone (1 row read for the whole request, no document parsed).
  if (isNoop({ since, rev: meta.rev, ownerT: meta.owner_t, input })) {
    return json(200, syncBody(meta, {}, {}, false, input.dropped), { 'X-Atlas-Read': 'meta' });
  }

  let need = docsNeeded({ since, rev: meta.rev, pubRev: meta.pub_rev, privRev: meta.priv_rev, hasPlaces, hasNotes });
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const cols = [META_COLS, need.pub ? 'pub' : null, need.priv ? 'priv' : null].filter(Boolean).join(', ');
    const res = await env.DB.prepare(`SELECT ${cols} FROM maps WHERE id = ?1`).bind(id).all();
    let row = res.results && res.results[0];
    if (!row) return gone(url, id, meta.notes_token); // deleted while this sync ran
    if (!timingSafeEqualStr(row.key_hash, auth.row.key_hash)) return keyReplaced(); // reset raced this sync
    if (row.rev === 0) {
      // Only possible if the row was rolled back to v1 meanwhile: convert again and re-read.
      await convert(env, id, 'id');
      need = { pub: true, priv: true };
      continue;
    }
    // A write landed between the meta read and this one and touched a document we skipped.
    const now2 = docsNeeded({ since, rev: row.rev, pubRev: row.pub_rev, privRev: row.priv_rev, hasPlaces, hasNotes });
    if ((now2.pub && !need.pub) || (now2.priv && !need.priv)) {
      need = { pub: need.pub || now2.pub, priv: need.priv || now2.priv };
      continue;
    }

    const pub = need.pub ? parseDoc(row.pub) : null;
    const priv = need.priv ? parseDoc(row.priv) : null;
    const newRev = row.rev + 1;
    const p = hasPlaces ? mergeDoc(pub, input.places, newRev) : { doc: pub, changed: 0 };
    const n = hasNotes ? mergeDoc(priv, input.notes, newRev) : { doc: priv, changed: 0 };
    const o = mergeOwner(row.owner, row.owner_t, input.owner);
    const read = ['meta', need.pub && 'pub', need.priv && 'priv'].filter(Boolean).join(',');
    const full = isFull(since, row.rev);

    if (!p.changed && !n.changed && !o.changed) {
      const out = syncBody(row, pub ? delta(pub, full ? null : since) : {}, priv ? delta(priv, full ? null : since) : {}, full, input.dropped);
      return json(200, out, { 'X-Atlas-Read': read });
    }

    const sets = ['rev = ?3', 'updated = ?4'];
    const args = [id, row.rev, newRev, now, auth.row.key_hash];
    let grows = false;
    if (p.changed) {
      const text = serialize(p.doc);
      grows = grows || text.length > row.pub.length;
      args.push(text);
      sets.push(`pub = ?${args.length}`, 'pub_rev = ?3');
    }
    if (n.changed) {
      const text = serialize(n.doc);
      checkNoteCaps(priv, n.doc, text, row.priv);
      grows = grows || text.length > row.priv.length;
      args.push(text);
      sets.push(`priv = ?${args.length}`, 'priv_rev = ?3');
    }
    if (o.changed) {
      args.push(o.owner, o.ownerT);
      sets.push(`owner = ?${args.length - 1}`, `owner_t = ?${args.length}`);
    }
    // Shrinking (or same-size) writes are always allowed, so a full database can still be tidied.
    if (storageRefuses(sizeAfter(res), grows)) return storageFull();

    // Compare-and-swap: lands only if nobody else wrote since our read and the key still holds.
    const upd = await env.DB.prepare(`UPDATE maps SET ${sets.join(', ')} WHERE id = ?1 AND rev = ?2 AND key_hash = ?5`)
      .bind(...args)
      .run();
    if (!upd.meta || upd.meta.changes !== 1) {
      need = { pub: need.pub || hasPlaces, priv: need.priv || hasNotes };
      continue; // someone else wrote first (or the key/map went away): re-read and decide again
    }

    await Promise.all([purgeMap(url, id), purgeNotes(url, id, row.notes_token)]);
    const merged = { ...row, rev: newRev, updated: now, owner: o.owner, owner_t: o.ownerT };
    const out = syncBody(
      merged,
      p.doc ? delta(p.doc, full ? null : since) : {},
      n.doc ? delta(n.doc, full ? null : since) : {},
      full,
      input.dropped
    );
    return json(200, out, { 'X-Atlas-Read': read });
  }
  return error(503, 'busy', 'The map is busy with other changes. Try again in a moment.', { 'Retry-After': '2' });
}

// Turns the notes view link on (keeps an existing token), off, or replaces it (reset).
// Editing devices learn the token from `notesToken` in sync responses.
async function notesLink(request, env, url, id) {
  const auth = await authorize(request, env, id);
  if (auth instanceof Response) return auth;
  const body = await readJson(request);
  const action = body.action;
  if (action !== 'on' && action !== 'off' && action !== 'reset') throw bad('action must be "on", "off" or "reset".');

  const value = action === 'off' ? 'NULL' : action === 'on' ? 'coalesce(notes_token, ?3)' : '?3';
  const stmt = env.DB.prepare(
    `UPDATE maps SET notes_token = ${value} WHERE id = ?1 AND key_hash = ?2 RETURNING notes_token`
  );
  const res = await (action === 'off' ? stmt.bind(id, auth.row.key_hash) : stmt.bind(id, auth.row.key_hash, newToken())).all();
  const row = res.results && res.results[0];
  if (!row) return keyReplaced(); // a reset-key or delete got there first
  const token = row.notes_token === undefined ? null : row.notes_token;
  if (auth.row.notes_token && auth.row.notes_token !== token) await purgeNotes(url, id, auth.row.notes_token);
  return json(200, { notesToken: token });
}

async function resetKey(request, env, url, id) {
  const auth = await authorize(request, env, id);
  if (auth instanceof Response) return auth;
  await readJson(request, { allowEmpty: true }); // body is `{}`; still enforces type and size

  const editKey = newToken();
  const res = await env.DB.prepare('UPDATE maps SET key_hash = ?3 WHERE id = ?1 AND key_hash = ?2')
    .bind(id, auth.row.key_hash, await sha256Hex(editKey))
    .run();
  if (!res.meta || res.meta.changes !== 1) return keyReplaced();
  await purgeMap(url, id);
  return json(200, { editKey });
}

async function deleteMap(request, env, url, id) {
  const auth = await authorize(request, env, id);
  if (auth instanceof Response) return auth;

  const results = await env.DB.batch([
    // Legacy v1 rows (until docs/later/0003_drop_marks.sql).
    env.DB.prepare(
      'DELETE FROM marks WHERE map_id = ?1 AND EXISTS (SELECT 1 FROM maps WHERE id = ?1 AND key_hash = ?2)'
    ).bind(id, auth.row.key_hash),
    env.DB.prepare('DELETE FROM maps WHERE id = ?1 AND key_hash = ?2').bind(id, auth.row.key_hash),
  ]);
  // 0 rows deleted = a reset-key or another delete got there first: the key no longer works.
  const deleted = results[1] && results[1].meta ? results[1].meta.changes : 0;
  if (deleted !== 1) return keyReplaced();
  await Promise.all([purgeMap(url, id), purgeNotes(url, id, auth.row.notes_token)]);
  return new Response(null, { status: 204, headers: securityHeaders() });
}

// ---------- map rows ----------

// Converts a v1 map (rev = 0, places in `marks`) and re-reads `cols`, in one batch (one
// transaction). Returns the row, or null if the map is gone.
async function convert(env, id, cols) {
  const [, sel] = await env.DB.batch([
    env.DB.prepare(CONVERT_SQL).bind(id),
    env.DB.prepare(`SELECT ${cols} FROM maps WHERE id = ?1`).bind(id),
  ]);
  return (sel.results && sel.results[0]) || null;
}

function syncBody(row, places, notes, full, dropped) {
  return { ...mapHead(row), places, notes, notesToken: row.notes_token ?? null, full, dropped };
}

function sizeAfter(result) {
  const v = result && result.meta ? result.meta.size_after : undefined;
  if (typeof v !== 'number') warnOnce('size_after', 'D1 result meta has no size_after; storage guard is off');
  return v;
}

async function gone(url, id, notesToken) {
  await Promise.all([purgeMap(url, id), purgeNotes(url, id, notesToken)]);
  return notFound();
}

// ---------- auth + rate limits ----------

// Returns { row } (META_COLS) for a valid edit key, or the error Response to send.
// Order: the per-IP write budget first (it caps every write attempt, key or no key, before any
// D1 read); then the key; then the per-map write budget, counted only for a correct key so
// strangers guessing keys cannot use up a map's budget. Bad keys are counted per IP+map: after
// 10 in a window, further BAD keys get 429 instead of 401. A correct key is never refused for
// someone else's bad guesses (only by the normal write limits).
async function authorize(request, env, id) {
  const ip = clientIp(request);
  if (ipLimitsOn(env) && !(await allow(env, 'RL_IPWRITE', ip))) return rateLimited();

  const row = await env.DB.prepare(`SELECT ${META_COLS} FROM maps WHERE id = ?1`).bind(id).first();
  if (!row) return notFound();

  const key = bearer(request);
  const presented = await sha256Hex(key); // hash even malformed keys: same work either way
  const ok = KEY_RE.test(key) && timingSafeEqualStr(presented, row.key_hash);

  if (!ok) {
    if (!(await allow(env, 'RL_BADKEY', `${ip}|${id}`))) return rateLimited();
    return error(401, 'bad_key', 'The edit key is missing or not valid for this map.');
  }

  if (!(await allow(env, 'RL_WRITE', id))) return rateLimited();
  return { row };
}

function bearer(request) {
  const m = /^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization') || '');
  return m ? m[1] : '';
}

// "0" (only `npm run dev:test`) skips the limits keyed by IP alone, since a local test suite
// sends everything from 127.0.0.1. The per-map and per-IP+map limits always apply.
function ipLimitsOn(env) {
  return env.RL_IP_LIMITS !== '0';
}

// Fail open when a binding is missing or errors: limits are abuse protection, not correctness.
// But say so in the logs, once per binding per isolate, so a broken limiter is noticed.
const warned = new Set();
function warnOnce(name, why) {
  if (warned.has(name)) return;
  warned.add(name);
  console.error(`${name}: ${why}`);
}
async function allow(env, name, key) {
  const binding = env[name];
  if (!binding || typeof binding.limit !== 'function') {
    warnOnce(name, 'rate limiter binding is missing; failing open');
    return true;
  }
  try {
    const { success } = await binding.limit({ key });
    return success !== false;
  } catch (err) {
    warnOnce(name, `rate limiter threw ${err && err.message ? err.message : err}; failing open`);
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
// Notes responses: one entry per token, keyed by its SHA-256 (the token never appears in a key).
function notesCacheKey(url, id, tokenHash) {
  return `${url.origin}/api/maps/${id}/notes/${tokenHash}`;
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
async function cacheDelete(key) {
  try {
    await caches.default.delete(key);
  } catch {
    /* nothing to purge */
  }
}
function purgeMap(url, id) {
  return cacheDelete(mapCacheKey(url, id));
}
async function purgeNotes(url, id, notesToken) {
  if (notesToken) await cacheDelete(notesCacheKey(url, id, await sha256Hex(notesToken)));
}

// ---------- request body ----------

// Reads the body with a hard 128 KB cap (Content-Length can be absent or wrong).
async function readJson(request, { allowEmpty = false } = {}) {
  const max = LIMITS.MAX_BODY;
  const tooLarge = () => new ApiError(413, 'too_large', `Request body is larger than ${max / 1024} KB.`);
  const len = Number(request.headers.get('Content-Length'));
  if (len > max) throw tooLarge();

  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        reader.cancel().catch(() => {});
        throw tooLarge();
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

// Edit keys and notes tokens: 16 random bytes, base64url without padding = 22 chars.
function newToken() {
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

// The key was right when checked, but a concurrent reset-key or delete replaced it before the write.
function keyReplaced() {
  return error(401, 'bad_key', 'The edit key is not valid for this map.');
}

function rateLimited() {
  return error(429, 'rate_limited', 'Too many requests. Try again in a minute.', { 'Retry-After': '60' });
}

function storageFull() {
  return error(507, 'storage_full', 'The sync server is full. Your changes are kept on this device.');
}
