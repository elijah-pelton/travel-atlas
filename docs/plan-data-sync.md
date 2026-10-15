# Plan: data model, sync and backup (want to go / notes / cities)

Scope: data model, sync protocol, API and D1, merge rules, backup, the two view links, limits/quotas, migration of live data. UI: docs/plan-ux.md. City data: docs/plan-cities.md.

## Lead decisions (approved; override anything below that conflicts)
- Notes are up to **500 characters** (matches plan-ux panel); `priv` cap **600 KB**; 1000 non-empty notes max.
- City ids come from **`data/cities-ids.json`** (sorted list of every published `C-<ne_id>`, written by tools/make-cities.py), not from objects in data/cities.json. City id regex `^C-\d{1,12}$`.
- The plain view link shows been **and** want; only notes/ratings/years are private.
- Notes and ratings sync to the server (required for the notes link).

## Decisions
1. Each map is stored as two JSON documents in its `maps` row (`pub` statuses, `priv` notes), not one D1 row per place: with ~10k city ids, per-row costs up to 10k D1 rows per read/sync; a document costs 1 read and 1 write.
2. Per item, two last-writer-wins registers: status `[s,t]` and notes `[rating, year, note, t]` (edited together). Toggling status never wipes notes.
3. Status 0 = none, 1 = been, 2 = want. Old clients test `e[0] === 1`, so want looks unmarked to them and they never send 2.
4. Map-wide `rev`; each entry records the `rev` it last changed at; clients sync with `since=<rev>`. A no-change sync reads 1 row and returns ~200 bytes.
5. Clients send only dirty entries; full send on first link, after this upgrade, or on pairing.
6. Notes link `/map/<id>#notes=<token>` with its own random 128-bit token in the fragment (never sent to servers/logs/referrers). The plain link carries nothing upgradeable.
7. Notes token stored in plain text in D1 (edit key stays hashed): it only grants reading notes stored in the same row; plain text lets every editing device show the link.
8. Backup file `atlas2` JSON is the full backup; code `atlas2:` holds been + want only. `atlas1:` codes/files still accepted.
9. City ids are checked against the generated allowlist; well-formed but unknown ids are dropped (counted in `dropped`), not 400 — a stale id must never block a device's sync forever.
10. Old D1 rows are converted lazily on first access; the `marks` table stays until a later migration (0003) for rollback.

## Server (D1): migrations/0002_docs.sql
```sql
ALTER TABLE maps ADD COLUMN rev         INTEGER NOT NULL DEFAULT 0;   -- 0 = not yet converted from marks
ALTER TABLE maps ADD COLUMN pub         TEXT    NOT NULL DEFAULT '{}'; -- {id: [s, t, rev]}
ALTER TABLE maps ADD COLUMN pub_rev     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE maps ADD COLUMN priv        TEXT    NOT NULL DEFAULT '{}'; -- {id: [rating, year, note, t, rev]}
ALTER TABLE maps ADD COLUMN priv_rev    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE maps ADD COLUMN notes_token TEXT;                           -- NULL = no notes link
```
- `t` = client edit ms, clamped to server now + 5 min. Status 0 and empty notes `[0,0,"",t,rev]` are kept as tombstones so removals beat older adds.
- No secondary indexes (each index update is an extra written row).
- Lazy conversion in the same batch as the first GET/sync of a map with `rev = 0`:
```sql
UPDATE maps SET pub = coalesce((SELECT json_group_object(place_id, json_array(visited, t, 1))
                                FROM marks WHERE map_id = ?1), '{}'), rev = 1, pub_rev = 1
 WHERE id = ?1 AND rev = 0;
```
- Later release: `0003_drop_marks.sql` = `DROP TABLE marks;`.

## Client (localStorage)
- New `travel-atlas:v2` (source of truth): `{ v:2, places:{id:[s,t]}, notes:{id:[r,y,text,t]}, owner:[name,t], dirty:{"p:<id>":1,"n:<id>":1,"o":1} }`. Entries for ids not loaded yet (cities are lazy) are **kept**; only drawing filters.
- `travel-atlas:link` gains `rev` (since cursor; absent = full sync next) and `notesToken` (null or string).
- One-time migration when `:v2` is missing: each `:v1` id → `[1, clock[id] || 1]`; each `:clock` entry for an unmarked place → `[0, t]`; owner → `[:owner, :ownerT || (owner ? 1 : 0)]`; everything dirty; delete `link.rev`.
- This release still mirrors been ids to `:v1` and the name to `:owner` (downgrade safety); stops updating `:clock` / `:ownerT`.
- Unchanged keys: `:t`, `:lastBackup`, `:accent`, `:style`, `:ios-hint`, `:pending-pair` (session), `:v1.bad`.

## API (changes in bold)
| Method & path | Auth | Body | Success |
|---|---|---|---|
| `POST /api/maps` | none | `{ name, owner?, ownerT?, places?: {id:[s,t]}, **notes?: {id:[r,y,text,t]}** }` | `201 { id, editKey, map }` |
| `GET /api/maps/:id` | none | — | `200 { id, name, owner, ownerT, updated, **rev**, places:{id:[s,t,rev]} }` — never notes or token; edge-cached 15 s |
| **`GET /api/maps/:id/notes`** | `Bearer <notesToken>` | — | `200` GET shape + `notes:{id:[r,y,text,t,rev]}`; edge-cached 15 s under a key derived from SHA-256(token) |
| `POST /api/maps/:id/sync` | Bearer editKey | `{ **since?**, owner?:[name,t], places?:{id:[s,t]}, **notes?** }` | `200 { …GET shape, notes, **notesToken**, **full**:bool, **dropped**:n }`; with `since`, only entries with `rev > since` |
| **`POST /api/maps/:id/notes-link`** | Bearer editKey | `{ action: "on" \| "off" \| "reset" }` | `200 { notesToken: string \| null }` |
| `POST /api/maps/:id/reset-key` | Bearer | `{}` | unchanged (notes token unaffected) |
| `DELETE /api/maps/:id` | Bearer | — | unchanged; also deletes legacy `marks` rows until 0003 |

- Old app versions keep working: no `since` → full response; `places` keeps its name; third array element and `s = 2` are harmless (`e[0] === 1`).
- Sync steps: RL_IPWRITE → `SELECT key_hash, rev, pub_rev, priv_rev, notes_token, name, owner, owner_t, updated` (1 row) → key check → RL_WRITE → convert if `rev = 0` → if the body changes nothing and `since >= rev`, reply without reading documents → otherwise `SELECT pub, priv` (skip `priv` if no notes came in and `since >= priv_rev`) → merge in JS (`worker/model.js`) → if changed, `UPDATE … rev=rev+1 … WHERE id=? AND rev=?old AND key_hash=?` (compare-and-swap; re-read and retry ≤ 3, then `503 busy`, client retries) → purge plain and notes cache entries.
- Notes GET: miss = 1 row read + constant-time compare with `notes_token`; wrong/disabled token → `401 bad_key`, counts toward RL_BADKEY (IP+map); RL_READ on misses.
- New errors: `503 busy`, `507 storage_full`.

## Merge rules
- Status `[s,t]` and notes `[r,y,text,t]` per id; incoming replaces stored only if its `t` is strictly greater; on equal `t` the server value stays and the client adopts it.
- Removals (status 0, empty notes) are kept as tombstones.
- Status and notes independent; owner last-writer-wins on `ownerT`; map name not synced; notes token changed only via `notes-link`.
- Client adopt: take a remote entry if its `t` ≥ local `t`; newer local edits stay dirty. After success, clear dirty flags whose local `t` still equals what was sent; set `link.rev`. Switching maps: adopt everything, reset dirty and rev.
- Chunked push: ≤ 1000 places, 200 notes, ~100 KB per request; loop until clean; back off on 429/503.
- Multi-tab: `storage` event on `:v2` re-reads.

## Backup
- File `travel-atlas-backup-YYYY-MM-DD.json`: `{ "format":"atlas2", "savedAt":"…Z", "owner":"…", "places": { "FRA": {"status":"been","rating":5,"year":2019,"note":"…"}, "C-2988507": {"status":"want"} } }` (no timestamps; a restore is a new edit stamped now).
- Code `atlas2:b=FRA,US-CA,C-2988507;w=JPN,C-1850147` (been and want only; UI says "map only; notes are in the backup file").
- Restore accepts atlas2 file, atlas1 file (`marks` or `v`), or text with `atlas2:` / `atlas1:`. Add (default): fill only empty items, never downgrade or remove. Replace: device becomes exactly the backup; everything else becomes status 0 / empty notes at `t = now`. Undo snapshots the whole `:v2`.
- `/#import=` (forwarding page) keeps accepting `atlas1:` only.

## Two view links
- Plain `/map/<id>` → `GET /api/maps/:id`; no response ever reveals whether a notes link exists.
- Notes `/map/<id>#notes=<token>` (22-char base64url, 16 random bytes). The app sends the token only in `Authorization`. The token stays in the address bar (it's the read-only link the visitor was given). If this device holds the edit key, the link opens as its own atlas. On failure: plain view + "This notes link no longer works." Old app versions ignore the fragment.
- Share switch "Notes link", off by default: on → `notes-link {on}`; "Reset notes link" → `{reset}`; off → `{off}`. Other editing devices learn the token from `notesToken` on their next sync.
- Staleness: purge is per location; other locations may serve old notes ≤ 15 s (documented).

## Limits and quotas
- Validation: place ids via the allowlist (malformed → 400; well-formed unknown → dropped); city ids `^C-\d{1,12}$` then allowlist; status 0/1/2; rating integer 0–5 (0 = none); year 0 or 1900..current+1; note: strip control/format chars except `\n`, ≤ 3 consecutive newlines, ≤ 500 chars.
- Request caps: `MAX_BODY` 64 KB → **128 KB**; ≤ 1000 places, ≤ 200 notes per request.
- Per-map caps: ≤ 1000 non-empty notes, `priv` ≤ 600 KB (400 if exceeded); `pub` bounded by the allowlist (~10k × 35 B ≈ 360 KB); row < ~1 MB, inside D1's 2 MB.
- Storage guard: if D1 `meta.size_after` > 400 MB (free limit 500 MB), `create` → `507`, and syncs that grow a document are refused (shrinking allowed). Fallback if `size_after` is unavailable: daily create cap in a 1-row counter table.
- Rate limits unchanged; RL_READ covers notes GET misses; RL_BADKEY counts bad notes tokens.

| Request | Rows read v1 | Rows read v2 | Rows written v2 |
|---|---|---|---|
| GET / notes GET (miss) | 1 + M | 1 | 0 (first access to an unconverted map: + M read, 1 write, once) |
| sync, nothing new | ~2 + 2M | 1 | 0 |
| sync with changes | ~2 + 2M | 2 | 1 (+ CAS retries) |
| create | 0 | 0 | 1 |
| delete | 1 | 1 | 1 (+ legacy marks until 0003) |

Abuser at 30 writes/min/IP ≈ 86k reads/day/IP vs 5M; writes capped by RL_WRITE. Binding free-plan limit becomes 100k Worker requests/day (unchanged, accepted). Poll ~60 B up / 200 B down. Worker CPU: a poll parses nothing; a sync parses only needed documents (≤ 360 KB ≈ 1–3 ms).

## Live migration runbook (lead)
1. All tests pass; `node tools/make-place-ids.mjs --check` passes with cities.
2. `wrangler d1 migrations apply DB --remote` (0002 only adds columns; the old Worker ignores them).
3. `wrangler deploy`; maps convert on first GET/sync; old app versions keep syncing.
4. Clients convert on first load and do one full sync.
5. Two weeks later: backfill `rev = 0` maps, verify count 0, ship 0003, stop mirroring `:v1`.
6. Rollback before 0003: redeploy the old Worker after copying `pub` back into `marks` (`s = 2` → 0); notes are lost on rollback.

## Risks
D1 2 MB row / 100 KB statement limits must not apply to bound values (verify with a ~700 KB document on a scratch remote D1; fallback split `pub_places`/`pub_cities`); free-plan CPU at worst-case sizes (check `cpuTime` in logs after deploy); `meta.size_after` availability; city ids never reused; one big app.js (data logic moves to js/store.js; ordered tasks); single-row concurrency (CAS); localStorage ~400 KB for 10k cities (fine).

## Work breakdown
| # | Task | Owns | Depends on |
|---|---|---|---|
| D1 | D1 migration | migrations/0002_docs.sql (+ 0003 later) | — |
| D2 | Allowlist with cities (compact output; exports city regex) | tools/make-place-ids.mjs, worker/place-ids.js | data/cities-ids.json |
| D3 | Server model (pure, no Worker globals): validate, merge, delta, caps, conversion | worker/model.js, tests/model.spec.mjs | — |
| D4 | API endpoints, caching, auth, storage guard | worker/index.js, tests/api.spec.mjs, tests/compat-v1.spec.mjs | D1–D3 |
| D5 | Client store (classic script `window.AtlasStore`, Node-testable): :v2, migration, adopt/merge, dirty, chunking, atlas1/atlas2 | js/store.js, tests/store.spec.mjs | — |
| D6 | App wiring: persistence, sync with `since`, pairing, view/notes-view loading, Share data calls, backup buttons | js/app.js (persistence/sync/backup/view), index.html script tag, tests/sync.spec.mjs | D4, D5; lands before UI tasks edit app.js; exposes getStatus/setStatus/getNotes/setNotes/notesLink() |
| D7 | Docs | docs/SYNC.md, README.md | D4, D6 |
| D8 | Deploy + runbook | lead | all |

## Tests
- model.spec: independent LWW; equal t keeps server; tombstones; t clamp; rev stamping; since delta; caps (1000 notes, 500 chars, rating, year, newlines); unknown ids dropped, malformed 400; conversion.
- api.spec: since round trip; no-op sync reads only meta; rev=0 map converts on GET and sync; plain GET never contains notes/notesToken/notes_token; notes GET good/wrong/off/reset (429 after 10 bad); notes-link needs edit key; reset-key keeps notes token; > 128 KB → 413; racing syncs both land; city ids accepted; allowlist --check.
- compat-v1.spec: old body `{owner, places:{id:[0|1,t]}}` gets full places; `s = 2` echoed back by an old client is a no-op; old empty pairing sync works.
- store.spec: v1+clock+owner → v2 (t=1 for pre-sync marks); unknown ids kept; dirty cleared only when t unchanged; chunk limits; atlas2 round trip; atlas1 restore; Add never downgrades; Replace makes removals; Undo.
- sync.spec (browser): want and notes reach a second device; seeded old-format device upgrades losslessly; plain link shows want not notes; notes link shows notes; reset notes link falls back; two-tab :v2 storage event; first full sync of 2,000 city ids chunks without 413/429 loops.
