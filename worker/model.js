// Sync data model for the Travel Atlas API (contract: docs/SYNC.md).
// Pure functions only: no Worker globals (env, caches, crypto.subtle, D1), so tests import this
// file directly in Node. Every function that needs the time takes `now` (ms) as an argument.
//
// A map is two JSON documents in its D1 row:
//   pub  = { [placeId]: [status, t, rev] }           status 0 none, 1 been, 2 want
//   priv = { [placeId]: [rating, year, note, t, rev] }
// Each entry is a last-writer-wins register on its client edit time `t`; `rev` is the map-wide
// revision at which the entry last changed (clients sync with `since=<rev>`). Removals (status 0,
// empty notes [0, 0, "", t, rev]) are kept as tombstones so they beat older adds.
import { PLACE_IDS, AREA_ID_RE, CITY_ID_RE } from './place-ids.js';

export const LIMITS = Object.freeze({
  MAX_BODY: 128 * 1024, // bytes per request body
  MAX_PLACES_PER_REQUEST: 1000,
  MAX_NOTES_PER_REQUEST: 200,
  MAX_NOTES: 1000, // non-empty notes per map
  MAX_PRIV_BYTES: 600 * 1024, // serialized priv document per map
  MAX_NOTE_CHARS: 500,
  MAX_NAME: 40, // map name and owner name
  MAX_RATING: 5,
  MIN_YEAR: 1900,
  FUTURE_SLACK_MS: 5 * 60 * 1000,
  STORAGE_LIMIT_BYTES: 400 * 1000 * 1000, // D1 free plan limit is 500 MB
});

// Same shape as the Worker's other errors: { status, code, message } -> JSON error response.
export class ModelError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const bad = (message) => new ModelError(400, 'bad_request', message);

// ---------- text ----------

// Control (Cc: NUL, newlines, ...) and format (Cf: bidi overrides like U+202E, zero-width chars).
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/gu;
// Notes keep "\n" (line breaks) and U+200D ZERO WIDTH JOINER (it glues emoji sequences such as
// family or profession emoji; it cannot reorder or hide text the way bidi controls can).
const NOTE_INVISIBLE_RE = /(?![\n‍])[\p{Cc}\p{Cf}]/gu;

// Invisible characters are removed before trimming and counting: they could hide in a name,
// reverse how it displays (U+202E), or pad the length check.
export function cleanText(v) {
  return v.replace(INVISIBLE_RE, '').trim();
}

const chars = (s) => [...s].length;

export function checkName(v) {
  if (typeof v !== 'string') throw bad('name is required.');
  const s = cleanText(v);
  const n = chars(s);
  if (n < 1 || n > LIMITS.MAX_NAME) throw bad(`name must be 1–${LIMITS.MAX_NAME} characters.`);
  return s;
}

export function checkOwnerName(v) {
  if (typeof v !== 'string') throw bad('owner must be a string.');
  const s = cleanText(v);
  if (chars(s) > LIMITS.MAX_NAME) throw bad(`owner must be at most ${LIMITS.MAX_NAME} characters.`);
  return s;
}

// Strips invisible characters except "\n", allows at most 3 newlines in a row, trims.
export function cleanNote(v) {
  return v.replace(NOTE_INVISIBLE_RE, '').replace(/\n{4,}/g, '\n\n\n').trim();
}

// ---------- times ----------

// Client clocks can be wrong; a time far in the future would block every later edit.
export function clampT(t, now) {
  return Math.min(t, now + LIMITS.FUTURE_SLACK_MS);
}

export function checkT(v, what, now) {
  if (!Number.isSafeInteger(v) || v <= 0) throw bad(`${what} must be an integer > 0.`);
  return clampT(v, now);
}

// ---------- ids ----------

// 'ok' (in the allowlist), 'drop' (well-formed but unknown: a stale or future id that must never
// block a device's sync, so it is skipped and counted) or 'bad' (malformed: 400).
export function classifyId(id, ids = PLACE_IDS) {
  if (ids.has(id)) return 'ok';
  if (AREA_ID_RE.test(id) || CITY_ID_RE.test(id)) return 'drop';
  return 'bad';
}

// Safe to echo in an error message: short, no invisible characters.
const showId = (k) => k.slice(0, 16).replace(INVISIBLE_RE, '');

function checkObject(v, what) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`${what} must be an object.`);
  return v;
}

// ---------- entries ----------

// { id: [status, t] } -> { entries: { id: [status, t] } with t clamped, dropped }
export function checkPlaces(v, now, ids = PLACE_IDS) {
  checkObject(v, 'places');
  const keys = Object.keys(v);
  if (keys.length > LIMITS.MAX_PLACES_PER_REQUEST) {
    throw bad(`At most ${LIMITS.MAX_PLACES_PER_REQUEST} places per request.`);
  }
  const entries = {};
  let dropped = 0;
  for (const k of keys) {
    const kind = classifyId(k, ids);
    if (kind === 'bad') throw bad(`Unknown place id: ${showId(k)}`);
    const e = v[k];
    if (!Array.isArray(e) || e.length !== 2) throw bad(`places.${showId(k)} must be [status, t].`);
    if (e[0] !== 0 && e[0] !== 1 && e[0] !== 2) throw bad(`places.${showId(k)}: status must be 0, 1 or 2.`);
    const t = checkT(e[1], `places.${showId(k)}: t`, now);
    if (kind === 'drop') {
      dropped++;
      continue;
    }
    entries[k] = [e[0], t];
  }
  return { entries, dropped };
}

// { id: [rating, year, note, t] } -> { entries (note cleaned, t clamped), dropped }
export function checkNotes(v, now, ids = PLACE_IDS) {
  checkObject(v, 'notes');
  const keys = Object.keys(v);
  if (keys.length > LIMITS.MAX_NOTES_PER_REQUEST) {
    throw bad(`At most ${LIMITS.MAX_NOTES_PER_REQUEST} notes per request.`);
  }
  const maxYear = new Date(now).getUTCFullYear() + 1;
  const entries = {};
  let dropped = 0;
  for (const k of keys) {
    const kind = classifyId(k, ids);
    if (kind === 'bad') throw bad(`Unknown place id: ${showId(k)}`);
    const e = v[k];
    const at = `notes.${showId(k)}`;
    if (!Array.isArray(e) || e.length !== 4) throw bad(`${at} must be [rating, year, note, t].`);
    const [r, y, text] = e;
    if (!Number.isInteger(r) || r < 0 || r > LIMITS.MAX_RATING) throw bad(`${at}: rating must be an integer 0–${LIMITS.MAX_RATING}.`);
    if (!Number.isInteger(y) || (y !== 0 && (y < LIMITS.MIN_YEAR || y > maxYear))) {
      throw bad(`${at}: year must be 0 or ${LIMITS.MIN_YEAR}–${maxYear}.`);
    }
    if (typeof text !== 'string') throw bad(`${at}: note must be a string.`);
    const note = cleanNote(text);
    if (chars(note) > LIMITS.MAX_NOTE_CHARS) throw bad(`${at}: note must be at most ${LIMITS.MAX_NOTE_CHARS} characters.`);
    const t = checkT(e[3], `${at}: t`, now);
    if (kind === 'drop') {
      dropped++;
      continue;
    }
    entries[k] = [r, y, note, t];
  }
  return { entries, dropped };
}

export function checkSince(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isSafeInteger(v) || v < 0) throw bad('since must be an integer ≥ 0.');
  return v;
}

// POST /api/maps body.
export function parseCreate(body, now, ids = PLACE_IDS) {
  const name = checkName(body.name);
  const owner = body.owner === undefined ? '' : checkOwnerName(body.owner);
  let ownerT = 0;
  if (body.ownerT !== undefined) {
    if (!Number.isSafeInteger(body.ownerT) || body.ownerT < 0) throw bad('ownerT must be an integer ≥ 0.');
    ownerT = clampT(body.ownerT, now);
  }
  const p = checkPlaces(body.places === undefined ? {} : body.places, now, ids);
  const n = checkNotes(body.notes === undefined ? {} : body.notes, now, ids);
  return { name, owner, ownerT, places: p.entries, notes: n.entries, dropped: p.dropped + n.dropped };
}

// POST /api/maps/:id/sync body.
export function parseSync(body, now, ids = PLACE_IDS) {
  const since = checkSince(body.since);
  let owner = null;
  if (body.owner !== undefined) {
    if (!Array.isArray(body.owner) || body.owner.length !== 2) throw bad('owner must be [name, t].');
    owner = [checkOwnerName(body.owner[0]), checkT(body.owner[1], 'owner t', now)];
  }
  const p = checkPlaces(body.places === undefined ? {} : body.places, now, ids);
  const n = checkNotes(body.notes === undefined ? {} : body.notes, now, ids);
  return { since, owner, places: p.entries, notes: n.entries, dropped: p.dropped + n.dropped };
}

export function isEmptyNote(e) {
  return e[0] === 0 && e[1] === 0 && e[2] === '';
}

// ---------- documents ----------

// Stored documents are written only by this code (serialize), so parsing failures mean a
// corrupt row; treat anything that is not an object as empty rather than failing every request.
export function parseDoc(text) {
  if (!text) return {};
  const v = JSON.parse(text);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// Keys sorted so the stored text is deterministic (GET splices it into the response as is).
export function sortDoc(doc) {
  const out = {};
  for (const k of Object.keys(doc).sort()) out[k] = doc[k];
  return out;
}

export function serialize(doc) {
  return JSON.stringify(sortDoc(doc));
}

export function byteLength(s) {
  return new TextEncoder().encode(s).byteLength;
}

// Stamps fresh client entries ([..., t]) with a rev: [..., t, rev].
export function stamp(entries, rev) {
  const out = {};
  for (const k of Object.keys(entries)) out[k] = [...entries[k], rev];
  return out;
}

// Last-writer-wins merge of client entries ([..., t]) into a stored document ([..., t, rev]).
// Incoming replaces stored only if its t is strictly greater; on equal t the stored value stays
// (the client adopts it). Changed entries are stamped with `rev`. Returns a new document.
export function mergeDoc(doc, incoming, rev) {
  const out = { ...doc };
  let changed = 0;
  for (const k of Object.keys(incoming)) {
    const inc = incoming[k];
    const t = inc[inc.length - 1];
    const cur = out[k];
    if (Array.isArray(cur) && !(t > cur[cur.length - 2])) continue;
    out[k] = [...inc, rev];
    changed++;
  }
  return { doc: out, changed };
}

// Owner name is last-writer-wins on ownerT. Returns the winning [name, t] and whether it changed.
export function mergeOwner(owner, ownerT, incoming) {
  if (incoming && incoming[1] > ownerT) return { owner: incoming[0], ownerT: incoming[1], changed: true };
  return { owner, ownerT, changed: false };
}

// Entries a client with cursor `since` has not seen (rev > since); since = null -> everything.
export function delta(doc, since) {
  const out = {};
  for (const k of Object.keys(doc).sort()) {
    const e = doc[k];
    if (since === null || e[e.length - 1] > since) out[k] = e;
  }
  return out;
}

// A response is "full" (contains every entry) without a cursor, from 0, or when the cursor is
// ahead of the map (a cursor the server cannot honour, e.g. after a restore): start over.
export function isFull(since, rev) {
  return since === null || since === 0 || since > rev;
}

// Which documents a sync has to read. pubRev/privRev = revs at which pub/priv last changed.
export function docsNeeded({ since, rev, pubRev, privRev, hasPlaces, hasNotes }) {
  const full = isFull(since, rev);
  return {
    pub: hasPlaces || full || since < pubRev,
    priv: hasNotes || full || since < privRev,
  };
}

// A sync that sends nothing new and is already at the map's rev needs no document at all.
export function isNoop({ since, rev, ownerT, input }) {
  if (since === null || isFull(since, rev)) return false;
  if (Object.keys(input.places).length || Object.keys(input.notes).length) return false;
  if (input.owner && input.owner[1] > ownerT) return false;
  return since >= rev;
}

export function noteStats(doc) {
  let count = 0;
  for (const k of Object.keys(doc)) if (!isEmptyNote(doc[k])) count++;
  return count;
}

// Per-map caps on notes. Only growth is refused, so a map over a cap can always shrink.
export function checkNoteCaps(before, after, afterText, beforeText = serialize(before)) {
  const nBefore = noteStats(before);
  const nAfter = noteStats(after);
  if (nAfter > LIMITS.MAX_NOTES && nAfter > nBefore) throw bad(`At most ${LIMITS.MAX_NOTES} notes per map.`);
  const bBefore = byteLength(beforeText);
  const bAfter = byteLength(afterText);
  if (bAfter > LIMITS.MAX_PRIV_BYTES && bAfter > bBefore) {
    throw bad(`Notes for one map are limited to ${Math.round(LIMITS.MAX_PRIV_BYTES / 1024)} KB.`);
  }
}

// Storage guard: refuse writes that grow the database once D1 reports it above the limit.
// sizeAfter is D1's result meta.size_after; if it is missing the guard fails open (returns false).
export function storageRefuses(sizeAfter, grows, limit = LIMITS.STORAGE_LIMIT_BYTES) {
  if (!grows) return false;
  if (typeof sizeAfter !== 'number' || !Number.isFinite(sizeAfter)) return false;
  return sizeAfter > limit;
}

// ---------- response shapes ----------

// Public map fields (never key_hash, created or notes_token).
export function mapHead(row) {
  return { id: row.id, name: row.name, owner: row.owner, ownerT: row.owner_t, updated: row.updated, rev: row.rev };
}

// GET /api/maps/:id body as text, splicing the stored documents in without parsing them.
export function publicBody(row, withNotes = false) {
  const head = JSON.stringify(mapHead(row));
  return `${head.slice(0, -1)},"places":${row.pub || '{}'}${withNotes ? `,"notes":${row.priv || '{}'}` : ''}}`;
}

// ---------- conversion of v1 rows ----------

// Maps written by the v1 Worker have rev = 0 and their places in the `marks` table. The first
// GET or sync converts them (same batch as the read). Each mark becomes [visited, t, 1].
// ?1 = map id. Only a still-unconverted row changes (rev = 0), so racing converters are harmless.
export const CONVERT_SQL =
  'UPDATE maps SET pub = coalesce((SELECT json_group_object(place_id, json_array(visited, t, 1)) ' +
  'FROM (SELECT place_id, visited, t FROM marks WHERE map_id = ?1 ORDER BY place_id)), ' +
  "'{}'), rev = 1, pub_rev = 1 WHERE id = ?1 AND rev = 0";
