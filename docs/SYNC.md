# Sync design

Travel Atlas works fully on one device with no account. Sync is opt-in: creating a link stores a copy of the map on atlas.elijahpelton.com so other devices can view or edit it.

## Hosting

One Cloudflare Worker (`travel-atlas`) on the custom domain `atlas.elijahpelton.com`:

- Static assets: the site files at the repo root (`.assetsignore` excludes tests/, tools/, worker/, migrations/, redirect/, docs/, node_modules/, *.md except nothing needed, package files, wrangler.jsonc).
- `assets.not_found_handling = "single-page-application"`, so `/map/<id>` serves `index.html`.
- `assets.run_worker_first = ["/api/*"]`: only the API runs Worker code.
- D1 database `travel-atlas` (binding `DB`). Rate limiting bindings (see below).
- `workers_dev = false` and `preview_urls = false`: the custom domain is the only address.
- Workers Logs on, but `observability.logs.invocation_logs = false`: invocation logs record request headers, and `Authorization` carries the edit key. There is no setting that drops only headers, so per-request invocation logs are off; `console.error` output (server errors, a failing rate limiter) is still logged.
- Plan: Workers **Free**, on purpose. Every quota (requests, D1 rows, rate-limiter calls) fails closed on the free plan, so the worst an abuser can cause is "sync paused until the daily reset", never a bill. Local use of the app never depends on the API.
- The app lives at the domain root. `index.html` has `<base href="/">` so its relative URLs work from `/map/<id>` too.

The old GitHub Pages address becomes a forwarding page (`redirect/`, published from the `gh-pages` branch) that carries existing marks over via the URL fragment.

## Words

- **Map ID**: `<slug>-<5 chars>`, e.g. `elijah-12ab3`. Slug = name lowercased, accents stripped, non `[a-z0-9]` runs → `-`, trimmed, max 20 chars (`atlas` if empty). Suffix = 5 random chars from `abcdefghjkmnpqrstuvwxyz23456789`. Public: anyone with it can view.
- **Edit key**: 16 random bytes, base64url (22 chars). Secret. Server stores only `SHA-256(key)` hex. Compared in constant time.
- **Notes token**: 16 random bytes, base64url (22 chars). Grants reading the map's notes only. Stored in plain text (see Data model). Off by default.
- **View link**: `https://atlas.elijahpelton.com/map/<id>` (been and want; no notes)
- **Edit link**: `https://atlas.elijahpelton.com/map/<id>#edit=<key>`. The key is in the fragment, so browsers never send it to the server, logs, or referrers. The app reads it, sends it only in an `Authorization` header, then removes it from the address bar.
- **Notes link**: `https://atlas.elijahpelton.com/map/<id>#notes=<token>`. Read-only view with ratings, years and notes. The token is in the fragment (never sent to servers, logs or referrers); the app sends it only in `Authorization` to `GET /api/maps/:id/notes`, and leaves it in the address bar (it is the link the visitor was given). The plain view link shows been and want, never notes, and no response reveals whether a notes link exists.

## Data model (D1)

```
maps(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', owner_t INTEGER NOT NULL DEFAULT 0,
     key_hash TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
     rev INTEGER NOT NULL DEFAULT 0,        -- map-wide revision; 0 = not yet converted from marks
     pub TEXT NOT NULL DEFAULT '{}',        -- { [placeId]: [status, t, rev] }
     pub_rev INTEGER NOT NULL DEFAULT 0,    -- rev at which pub last changed
     priv TEXT NOT NULL DEFAULT '{}',       -- { [placeId]: [rating, year, note, t, rev] }
     priv_rev INTEGER NOT NULL DEFAULT 0,   -- rev at which priv last changed
     notes_token TEXT)                      -- notes view link token; NULL = no notes link
marks(map_id, place_id, visited, t)          -- v1 only; read once per map by the lazy conversion, dropped by a later 0003
```

Migrations: `0001_init.sql` (v1), `0002_docs.sql` (adds the v2 columns only, so the v1 Worker keeps working on the new schema). `docs/later/0003_drop_marks.sql` (`DROP TABLE marks`) is kept out of `migrations/` until every map is converted; the Worker's legacy marks code must be removed in the same release. No secondary indexes (each index update is an extra written row).

Each map is two JSON documents in its own row, not one row per place: with ~3,600 place and city ids, a document costs 1 row read and 1 row written where per-place rows would cost thousands.

- `pub` holds each place's **status**: `0` none, `1` been, `2` want. `places` in every response is `pub`.
- `priv` holds each place's **notes**: `rating` integer 0–5 (0 = none), `year` 0 (none) or 1900..next year, `note` text ≤ 500 chars. Rating, year and note are edited together as one value.
- Each entry is a last-writer-wins register on `t` (the client's edit time, ms). Status and notes are independent registers: toggling a status never touches notes.
- `rev` on an entry = the map `rev` at which that entry last changed. The map's `rev` goes up by 1 on every write that changes anything (an entry, or the owner name).
- Removals are kept as tombstones, so they beat older adds from devices that have not synced yet: status `0`, and empty notes `[0, 0, "", t, rev]`.
- Owner name is last-writer-wins on `owner_t`. The map name is set at create and not synced.
- The notes token (16 random bytes, base64url, 22 chars) is stored in plain text: it only grants reading the notes in the same row, and plain text lets every editing device show the link. The edit key stays hashed.

Merge (server, `worker/model.js`): an incoming entry replaces the stored one only if its `t` is **strictly greater**. On equal `t` the stored value stays and the client adopts it. Changed entries are stamped with the new `rev`.

Lazy conversion: maps written by the v1 Worker have `rev = 0` and their places in `marks`. The first GET, notes GET (with a valid token) or sync converts them in one batch with the read: every mark becomes `[visited, t, 1]` in `pub`, `rev = pub_rev = 1`. The UPDATE only applies `WHERE rev = 0`, so racing converters are harmless. New maps start at `rev = 1`. Rollback to the v1 Worker before 0003 means copying `pub` back into `marks` (status 2 → 0); notes are lost on rollback.

## API

All JSON. `Cache-Control: no-store` on every API response. Errors: `{ "error": "<code>", "message": "<human text>" }`.

| Method & path | Auth | Body | Success |
|---|---|---|---|
| `POST /api/maps` | none | `{ name, owner?, ownerT?, places?: { [id]: [s, t] }, notes?: { [id]: [r, y, text, t] } }` | `201 { id, editKey, map }`, `map` = sync shape (`rev: 1`, `full: true`, `notesToken: null`) |
| `GET /api/maps/:id` | none | — | `200 { id, name, owner, ownerT, updated, rev, places: { [id]: [s, t, rev] } }`. Never notes, never anything about the notes link. Edge-cached 15 s |
| `GET /api/maps/:id/notes` | `Authorization: Bearer <notesToken>` | — | `200` GET shape + `notes: { [id]: [r, y, text, t, rev] }`. Edge-cached 15 s per token |
| `POST /api/maps/:id/sync` | `Authorization: Bearer <editKey>` | `{ since?, owner?: [name, t], places?: { [id]: [s, t] }, notes?: { [id]: [r, y, text, t] } }` | `200 { id, name, owner, ownerT, updated, rev, places, notes, notesToken, full, dropped }` |
| `POST /api/maps/:id/notes-link` | Bearer editKey | `{ action: "on" \| "off" \| "reset" }` | `200 { notesToken: string \| null }` |
| `POST /api/maps/:id/reset-key` | Bearer editKey | `{}` | `200 { editKey }` (old key stops working; the notes token is unaffected) |
| `DELETE /api/maps/:id` | Bearer editKey | — | `204` (map deleted, plus its legacy `marks` rows until 0003); `401` if the key stopped working before the delete ran |

Field names, exactly:

| Field | Type | Where | Meaning |
|---|---|---|---|
| `id` | string | create, GET, notes GET, sync | map ID |
| `editKey` | string (22) | create, reset-key | secret edit key (only ever returned to the creator / resetter) |
| `name` | string | create body, all map shapes | map name, 1–40 chars |
| `owner` | string (create body) / `[name, t]` (sync body) / string (responses) | | owner name ≤ 40 chars |
| `ownerT` | integer ms | create body, responses | owner name edit time |
| `updated` | integer ms | responses | server time of the last change |
| `rev` | integer ≥ 1 | responses | the map's revision after this request; the client's next `since` |
| `since` | integer ≥ 0 | sync body | the `rev` this device last adopted; absent = full sync |
| `places` | `{ [id]: [s, t] }` in bodies, `{ [id]: [s, t, rev] }` in responses | | status registers |
| `notes` | `{ [id]: [r, y, text, t] }` in bodies, `{ [id]: [r, y, text, t, rev] }` in responses | | notes registers |
| `notesToken` | string (22) or `null` | sync, create `map`, notes-link | the notes view link token (editors only) |
| `full` | boolean | sync, create `map` | `true` = `places` and `notes` contain **every** entry |
| `dropped` | integer | sync, create `map` | well-formed but unknown ids skipped from this request |
| `action` | `"on"`, `"off"`, `"reset"` | notes-link body | |

Sync semantics:

- **Delta.** With `since` = n ≥ 1 and n ≤ the map's `rev`, `places` and `notes` hold only entries with `rev > n` (`full: false`), including the client's own changes from this request (stamped with the new `rev`), so it can clear its dirty flags. Without `since`, with `since: 0`, or with `since` greater than the map's `rev` (a cursor the server cannot honour), the response is full (`full: true`): every entry, including tombstones. A client that gets `full: true` treats it as the whole map.
- **Rev.** `rev` in the response is the cursor for the next request. A sync that changes nothing does not move `rev` or `updated`.
- **No-op.** A sync with `since ≥ rev`, no places, no notes and no newer owner reads only the meta row (1 row, no document parsed) and answers `places: {}`, `notes: {}`, `full: false` (`X-Atlas-Read: meta`). This is the poll.
- **Documents read.** `pub` is read only when places came in, the response is full, or `pub` changed after `since`; `priv` likewise. `X-Atlas-Read` (`meta`, `meta,pub`, `meta,priv`, `meta,pub,priv`) says which were read, for debugging.
- **Compare-and-swap.** The write is `UPDATE … SET rev = rev + 1 … WHERE id = ? AND rev = <read rev> AND key_hash = ?`. If another write landed first, the Worker re-reads and merges again (up to 3 retries), then answers `503 busy` with `Retry-After: 2`; the client retries later with the same dirty entries.
- **notesToken** is always the current one (also on the no-op path), so other editing devices learn about `on` / `reset` / `off` on their next sync.
- **Dropped ids.** A well-formed id that is not in the allowlist (a stale or future city, a removed region) is skipped and counted in `dropped`, never `400`: a stale id must never block a device's sync forever. Its entry still has to be valid.
- **Old (v1) clients** keep working: they send no `since` and get a full response; `places` keeps its name; the third array element and `s = 2` are harmless to them (they test `e[0] === 1`, so a want looks unmarked), and they never send 2. A want echoed back by a v1 client as `[0, same t]` changes nothing (equal `t` keeps the server value). v1 clients ignore `notes`, `rev`, `full`, `dropped`, `notesToken`.

Status codes: `400 bad_request` (validation, per-map caps), `401 bad_key` (missing/wrong edit key or notes token, including a key that a concurrent reset-key replaced while the request was running), `404 not_found`, `413 too_large` (body > 128 KB), `429 rate_limited` (with `Retry-After: 60`), `503 busy` (compare-and-swap kept losing; `Retry-After: 2`), `507 storage_full` (database near the free-plan limit; see Storage guard). Clients treat 429, 503, 507 and 5xx like being offline: keep the change locally and retry later.

Validation (`worker/model.js`):

- `name` and `owner`: control and format characters (Unicode `Cc` and `Cf`: NUL, newlines, bidi overrides such as U+202E, zero-width characters) are removed first, then trimmed; `name` must then be 1–40 chars, `owner` ≤ 40 chars.
- `note`: the same characters are removed except `\n` and U+200D (zero-width joiner, which glues emoji sequences; it cannot reorder text); at most 3 newlines in a row (longer runs are cut to 3); trimmed; then ≤ 500 chars (code points). Invisible padding does not count.
- Status `0`, `1` or `2`. Rating integer 0–5. Year `0` or 1900..(current UTC year + 1). `t` an integer > 0, clamped to server now + 5 minutes (also `ownerT` / owner `t`). `since` an integer ≥ 0. Entries must have exactly 2 (`places`) or 4 (`notes`) elements.
- Place ids: in the allowlist → accepted. Well-formed but not listed → dropped (counted in `dropped`). Well-formed means `^[A-Z]{2,3}(?:-[A-Z]{2,3})?$` (map places, e.g. `FRA`, `US-CA`, `US-PRI`) or `^C-\d{1,12}$` (cities, `C-<Natural Earth ne_id>`). Anything else → `400`.
- Per request: body ≤ 128 KB (`413`), ≤ 1000 places, ≤ 200 notes (`400`). A client pushing many entries sends chunks of ≤ 1000 places, ≤ 200 notes and ~100 KB, looping until clean, and backs off on 429/503.
- Per map: ≤ 1000 non-empty notes and serialized `priv` ≤ 600 KB (`400`). Only growth is refused, so a map over a cap can always shrink (tombstones never count as notes). `pub` is bounded by the allowlist (~3,600 ids × ~35 B).

The allowlist (`worker/place-ids.js`) is generated, never hand-edited: `node tools/make-place-ids.mjs` rewrites it from `data/na.json` (`places`, `insets[].id`, `insets[].places`), `data/world.json` (`places`) and `data/cities-ids.json` (every city id ever published, including retired ones, written by `tools/make-cities.py`), and `node tools/make-place-ids.mjs --check` (also run by `tests/api.spec.mjs`) fails if it is out of date. The file is compact (space-separated ids) and also exports `AREA_ID_RE` and `CITY_ID_RE`. Changing the map or city data means regenerating it before deploying.

Notes link: `GET /api/maps/:id/notes` with `Authorization: Bearer <notesToken>`. The token is compared in constant time (SHA-256 of both sides). A wrong, malformed or disabled token is `401 bad_key` with the same body whether or not a notes link exists, and counts toward `RL_BADKEY` (IP + map), so after 10 bad tokens further bad ones get `429`; a correct token is never refused for someone else's guesses. `notes-link` needs the edit key and counts as a write (`RL_IPWRITE`, `RL_WRITE`): `on` creates a token if there is none (idempotent), `reset` replaces it, `off` sets it to `null`.

Rate limits (Workers Rate Limiting bindings, per Cloudflare location, period 60 s). "Per IP" means per IPv4 address, or per IPv6 `/64` prefix (one subscriber usually holds a whole /64); IPv4-mapped IPv6 counts as the IPv4 address.

| Binding | Limit | Key | Counts |
|---|---|---|---|
| `RL_CREATE` | 5 | IP | `POST /api/maps` |
| `RL_IPWRITE` | 30 | IP | every sync / notes-link / reset-key / delete attempt, checked first (before any D1 read), whatever the key |
| `RL_BADKEY` | 10 | IP + map | failed edit-key checks and failed notes-token checks; after 10, further **bad** keys/tokens get `429` instead of `401`. A correct key or token is never refused because of someone else's bad guesses |
| `RL_WRITE` | 10 | map ID | sync / notes-link / reset-key / delete with a correct key |
| `RL_READ` | 60 | IP | `GET /api/maps/:id` and `GET /api/maps/:id/notes` that miss the edge cache |

Limits fail open if a binding is missing or errors (they are abuse protection, not correctness); the Worker then logs one `console.error` per binding per isolate. The var `RL_IP_LIMITS = "0"` (set only by `npm run dev:test`, because a local suite sends everything from 127.0.0.1) skips the three IP-only limits (`RL_CREATE`, `RL_IPWRITE`, `RL_READ`); the per-map and per-IP+map limits always apply. With 10 writes per map per minute, a client syncing on every change can hit `429`; it treats that like being offline and retries later.

Edge cache: `GET /api/maps/:id` is cached server side with the Cache API (`caches.default`, per Cloudflare location) for 15 s, keyed by the canonical URL `https://<host>/api/maps/<id>` (no query, no auth). Notes responses are cached the same way under `https://<host>/api/maps/<id>/notes/<SHA-256(token) hex>`, so only a holder of that token can hit the entry and the token never appears in a cache key; a request whose token is malformed never looks in the cache. Only `200` responses are cached. A successful create, sync that changed something, reset-key or delete purges the plain entry; a changing sync and delete also purge the current token's notes entry; `notes-link` `reset`/`off` purges the old token's entry. Purges are per location: another location may serve a copy (including notes for a token just reset or turned off) up to 15 s old. Browsers always get `Cache-Control: no-store`. Responses carry `X-Atlas-Cache: hit|miss` for debugging. GET and notes GET splice the stored documents into the response without parsing them.

Storage guard: D1 returns `meta.size_after` (database size in bytes) with every result (verified in local wrangler/miniflare; documented for remote D1). When it is above 400 MB (free plan limit 500 MB), `POST /api/maps` answers `507 storage_full` (create first runs `SELECT 1`, which reads no rows, to get the size), and a sync whose write would make a document longer is refused with `507`; syncs that keep documents the same size or shrink them still work. If `size_after` is ever missing, the guard fails open and logs one `console.error`.

D1 cost per request (free plan: 5 M rows read and 100 k rows written per day). `M` = a v1 map's marks rows (only on its first access).

| Request | Rows read | Rows written |
|---|---|---|
| GET / notes GET, cache miss | 1 | 0 (first access to an unconverted map: + M read, 1 written, once) |
| GET / notes GET, cache hit | 0 | 0 |
| sync, nothing new (poll) | 1 | 0 |
| sync with changes | 2 (+ 1 per CAS retry) | 1 (+ conversion once) |
| create | 0 | 1 |
| notes-link, reset-key | ~2 | 1 |
| delete | 1 (+ legacy marks lookup) | 1 (+ legacy marks until 0003) |

Worst case per IP (/64) per location: 30 write attempts/min, about 2 rows read each, ≈ 86 k rows read per day per IP, far under the 5 M quota. The binding free-plan limit is the 100 k Worker requests/day on `/api/*` (static assets are not Worker requests, so the site itself stays up): many abusive IPs could pause sync for everyone until the daily reset while the app keeps working locally. That is the accepted failure mode; on the free plan it never costs money. Worker CPU: a poll parses nothing; a sync parses only the documents it needs (≤ ~360 KB, ~1–3 ms).

## Client behaviour

The client side of this contract (from docs/plan-data-sync.md; implemented in `js/store.js` and `js/app.js`):

- `travel-atlas:v2` (source of truth): `{ v: 2, places: { [id]: [s, t] }, notes: { [id]: [r, y, text, t] }, owner: [name, t], dirty: { "p:<id>": 1, "n:<id>": 1, "o": 1 } }`. Entries for ids not loaded yet (cities are lazy) are kept.
- `travel-atlas:link` — `{ id, editKey, name, rev?, full?, notesToken? }` once this device edits a shared map. `rev` is the `since` cursor (absent = full sync next); `notesToken` is null or the current token. Absent = local only.
- `link.full` = `{ rev, done }`: progress of a first full send that was interrupted (offline, 429, tab closed). `done` is how many full-send chunks the server has acknowledged and `rev` the cursor after the last one; the next sync skips those chunks and continues with `since: rev`. `link.rev` is written only after every chunk is through, and `full` is then removed. A create whose full send needs more than one chunk starts with `full = { rev, done: 1 }`, since the first chunk goes with the create.
- One-time migration when `:v2` is missing: each `:v1` id → `[1, clock[id] || 1]`; each `:clock` entry for an unmarked place → `[0, t]`; owner → `[:owner, :ownerT || (owner ? 1 : 0)]`; everything dirty; `link.rev` deleted. This release still mirrors been ids to `:v1` and the name to `:owner` (downgrade safety). The v1 keys `travel-atlas:clock` and `travel-atlas:ownerT` are no longer updated.

Sync loop (only when linked): send `since: link.rev` plus only dirty entries (everything on the first full sync), in chunks of ≤ 1000 places, ≤ 200 notes, ~100 KB, looping until clean. Adopt a remote entry if its `t` ≥ the local `t`; newer local edits stay dirty. After success, clear dirty flags whose local `t` still equals what was sent, set `link.rev = rev` and `link.notesToken = notesToken`. Switching maps: adopt everything, reset dirty and rev. Triggers: 1 s after any change, on startup, on `online`, when the page becomes visible, and every 60 s while visible. Requests time out after 10 s. Offline, 429, 503, 507 or 5xx: keep working locally and retry later with backoff.

Status pill: `Synced` / `Syncing…` / `Offline · will sync` / `Edit access was reset — this device stopped syncing` (on 401; unlink, keep local marks). Unlinked devices keep `Saved on this device` and the backup reminder. Linked devices that synced in the last 30 days don't show the backup reminder.

Pages:

- `/` — your atlas (local, plus sync if linked).
- `/map/<id>` with no edit key on this device — view only: fetches the map, shows "<owner>’s map · view only" with a link to start your own atlas, never touches this device's own marks. Clicks don't toggle.
- `/map/<id>` when this device holds that map's key — same as `/`.
- `/map/<id>#notes=<token>` — notes view: `GET /api/maps/:id/notes` with the token in `Authorization`; shows ratings, years and notes, read only. If this device holds the edit key it opens as its own atlas. If the token fails: plain view plus "This notes link no longer works." Old app versions ignore the fragment.
- `/map/<id>#edit=<key>` — pairing: checks the key with an empty sync. If this device isn't linked, its local marks merge into the shared map. If it's linked to a different map, it asks before switching (switching replaces local marks with the other map's). Then it removes the key from the address bar and continues as `/`.
- `/#import=<atlas1 code>&owner=<name>&accent=<name>&style=<flat|real>` — sent by the old-address forwarding page; adds the marks (never removes), sets owner/accent/style only if unset here, cleans the address bar, and shows a one-line note.

Share dialog ("Share" button next to Backup):

- Not linked: one paragraph on what sharing does, a name field (prefilled from the owner name), "Create link".
- Linked: view link with Copy / Share; "Add a device" with a QR code of the edit link ("Scan with the other device's camera") and a "Copy edit link instead" button behind the warning "Anyone with this link can change your map."; "Reset edit access" (confirm; other devices stop syncing until paired again); "Stop syncing on this device" (keeps marks here); "Delete shared map" (confirm; removes the copy on the server; marks stay on this device).

The QR code is generated on the device (vendored MIT library in `js/vendor/`), so the edit link never goes to a third party.

Service worker: `/api/*` is never cached (network only). Navigations to `/map/*` get the cached app shell like `/`.
