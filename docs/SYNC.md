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
- **View link**: `https://atlas.elijahpelton.com/map/<id>`
- **Edit link**: `https://atlas.elijahpelton.com/map/<id>#edit=<key>`. The key is in the fragment, so browsers never send it to the server, logs, or referrers. The app reads it, sends it only in an `Authorization` header, then removes it from the address bar.

## Data model (D1)

```
maps(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', owner_t INTEGER NOT NULL DEFAULT 0,
     key_hash TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)
marks(map_id TEXT NOT NULL, place_id TEXT NOT NULL, visited INTEGER NOT NULL, t INTEGER NOT NULL,
      PRIMARY KEY (map_id, place_id))
```

Each place is its own row with a timestamp `t` (ms). A change is applied only if its `t` is newer than the stored one (`INSERT … ON CONFLICT DO UPDATE … WHERE excluded.t > marks.t`), so concurrent and offline edits from several devices merge place by place and nothing overwrites a newer change. Removing a place is a row with `visited = 0`, so a deliberate removal also wins over an older add. Owner name is last-writer-wins on `owner_t`.

## API

All JSON. `Cache-Control: no-store` on every API response. Errors: `{ "error": "<code>", "message": "<human text>" }`.

| Method & path | Auth | Body | Success |
|---|---|---|---|
| `POST /api/maps` | none | `{ name, owner?, ownerT?, places: { [placeId]: [visited 0/1, t] } }` | `201 { id, editKey, map }` |
| `GET /api/maps/:id` | none | — | `200 map` (may be up to 15 s old, see Edge cache) |
| `POST /api/maps/:id/sync` | `Authorization: Bearer <editKey>` | `{ owner?: [name, t], places: { [placeId]: [visited, t] } }` | `200 map` (state after merge) |
| `POST /api/maps/:id/reset-key` | Bearer | `{}` | `200 { editKey }` (old key stops working) |
| `DELETE /api/maps/:id` | Bearer | — | `204` (map and its marks deleted); `401` if the key stopped working before the delete ran |

`map` = `{ id, name, owner, ownerT, updated, places: { [placeId]: [visited, t] } }` — includes `visited: 0` rows so clients can merge removals.

Status codes: `400 bad_request` (validation), `401 bad_key` (missing/wrong key, including a key that a concurrent reset-key replaced while the sync or delete was running), `404 not_found`, `413 too_large` (body > 64 KB), `429 rate_limited` (with `Retry-After: 60`).

Validation: control and format characters (Unicode `Cc` and `Cf`: NUL, newlines, bidi overrides such as U+202E, zero-width characters) are removed from `name` and `owner` first, then they are trimmed; `name` must then be 1–40 chars, `owner` ≤ 40 chars. Place IDs must be in the allowlist `worker/place-ids.js` (310 ids: every place in `data/na.json` — `places`, `insets[].id`, `insets[].places` — and `data/world.json` `places`, e.g. `US-CA`, `US-PRI`, `CA-ON`, `FRA`, `KOS`, `PSX`); anything else is `400`. At most 400 places per request. `t` must be an integer > 0, and is clamped to server now + 5 minutes; `visited` is 0 or 1.

The allowlist is generated, never hand-edited: `node tools/make-place-ids.mjs` rewrites it from the data files, and `node tools/make-place-ids.mjs --check` (also run by `tests/api.spec.mjs`) fails if it is out of date. Adding a place to the map data means regenerating it before deploying.

Rate limits (Workers Rate Limiting bindings, per Cloudflare location, period 60 s). "Per IP" means per IPv4 address, or per IPv6 `/64` prefix (one subscriber usually holds a whole /64); IPv4-mapped IPv6 counts as the IPv4 address.

| Binding | Limit | Key | Counts |
|---|---|---|---|
| `RL_CREATE` | 5 | IP | `POST /api/maps` |
| `RL_IPWRITE` | 30 | IP | every sync / reset-key / delete attempt, checked first (before any D1 read), whatever the key |
| `RL_BADKEY` | 10 | IP + map | failed key checks; after 10, further **bad** keys get `429` instead of `401`. A correct key is never refused because of someone else's bad guesses |
| `RL_WRITE` | 10 | map ID | sync / reset-key / delete with a correct key |
| `RL_READ` | 60 | IP | `GET /api/maps/:id` that miss the edge cache |

Limits fail open if a binding is missing or errors (they are abuse protection, not correctness); the Worker then logs one `console.error` per binding per isolate. The var `RL_IP_LIMITS = "0"` (set only by `npm run dev:test`, because a local suite sends everything from 127.0.0.1) skips the three IP-only limits (`RL_CREATE`, `RL_IPWRITE`, `RL_READ`); the per-map and per-IP+map limits always apply. With 10 writes per map per minute, a client syncing on every change can hit `429`; it treats that like being offline and retries later.

Edge cache: `GET /api/maps/:id` is cached server side with the Cache API (`caches.default`, per Cloudflare location) for 15 s, keyed by the canonical URL `https://<host>/api/maps/<id>` (no query, no auth). Only `200` responses are cached. A successful create, sync, reset-key or delete purges that key, so an editor's own reads are fresh at once (and sync returns the merged map anyway). Another location may serve a copy up to 15 s old. Browsers always get `Cache-Control: no-store`. Responses carry `X-Atlas-Cache: hit|miss` for debugging.

D1 cost per request (free plan: 5 M rows read and 100 k rows written per day). Each request is at most one D1 batch (one transaction) plus, for sync/reset/delete, the one-row key lookup.

- `GET` (cache miss): 1 + (the map's marks) rows read, 0 written. Cache hit: 0.
- `sync` sending P places to a map with M marks: about 1 (key lookup) + P (upsert lookups and its key guard) + 1 + M (the merged map) rows read. Rows written = places whose `t` is newer than stored, +1 for `maps.updated` if any changed, +1 if the owner changed. A no-op sync (every `t` ≤ stored, owner not newer) writes **0** rows: every write is guarded, so it costs only reads.
- `create`: 1 + P rows written. `reset-key`: 1 written. `delete`: 1 + M written.

Worst case per IP (/64) per location: 30 write attempts/min × ~800 rows read ≈ 24 k rows read/min, so one determined abuser could use up the daily D1 read quota in roughly 3–4 hours; many IPs, sooner. The same goes for the free plan's 100 k Worker requests/day on `/api/*` (static assets are not Worker requests, so the site itself stays up). Either way sync pauses for everyone until the daily reset while the app keeps working locally. That is the accepted failure mode; on the free plan it never costs money.

## Client behaviour

New localStorage keys (existing keys unchanged):

- `travel-atlas:clock` — `{ [placeId]: t }`, the time each place was last toggled on this device (on or off). Places marked before sync existed have no entry and are sent with `t = 1`, so they are added unless the shared map deliberately removed them.
- `travel-atlas:ownerT` — when the owner name last changed here.
- `travel-atlas:link` — `{ id, editKey, name }` once this device edits a shared map. Absent = local only.

Sync loop (only when linked): send every place this device has an opinion on (`marks` → visited 1, clock entries for unmarked places → visited 0) plus the owner, then replace local state with the merged result from the server. Triggers: 1 s after any change, on startup, on `online`, when the page becomes visible, and every 60 s while visible. Requests time out after 10 s. Offline or failing: keep working locally and retry later.

Status pill: `Synced` / `Syncing…` / `Offline · will sync` / `Edit access was reset — this device stopped syncing` (on 401; unlink, keep local marks). Unlinked devices keep `Saved on this device` and the backup reminder. Linked devices that synced in the last 30 days don't show the backup reminder.

Pages:

- `/` — your atlas (local, plus sync if linked).
- `/map/<id>` with no edit key on this device — view only: fetches the map, shows "<owner>’s map · view only" with a link to start your own atlas, never touches this device's own marks. Clicks don't toggle.
- `/map/<id>` when this device holds that map's key — same as `/`.
- `/map/<id>#edit=<key>` — pairing: checks the key with an empty sync. If this device isn't linked, its local marks merge into the shared map. If it's linked to a different map, it asks before switching (switching replaces local marks with the other map's). Then it removes the key from the address bar and continues as `/`.
- `/#import=<atlas1 code>&owner=<name>&accent=<name>&style=<flat|real>` — sent by the old-address forwarding page; adds the marks (never removes), sets owner/accent/style only if unset here, cleans the address bar, and shows a one-line note.

Share dialog ("Share" button next to Backup):

- Not linked: one paragraph on what sharing does, a name field (prefilled from the owner name), "Create link".
- Linked: view link with Copy / Share; "Add a device" with a QR code of the edit link ("Scan with the other device's camera") and a "Copy edit link instead" button behind the warning "Anyone with this link can change your map."; "Reset edit access" (confirm; other devices stop syncing until paired again); "Stop syncing on this device" (keeps marks here); "Delete shared map" (confirm; removes the copy on the server; marks stay on this device).

The QR code is generated on the device (vendored MIT library in `js/vendor/`), so the edit link never goes to a third party.

Service worker: `/api/*` is never cached (network only). Navigations to `/map/*` get the cached app shell like `/`.
