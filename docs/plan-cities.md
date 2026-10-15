# Cities plan

Scope: city data, IDs, pipeline, drawing, hit-testing, search, attribution. UI layout, want-to-go, notes/ratings: docs/plan-ux.md. Sync/backup: docs/plan-data-sync.md.

## Lead decisions (approved; override anything below that conflicts)
- v1 shows cities on the **World map only** (Equal Earth). The NA map's Albers parameters were never recorded; NA cities are phase 2. US/Canadian cities still appear on the World map and in search, labelled with state/province.
- **No separate Cities mode/view.** Cities are a layer on the World map (per plan-ux §2.5). Tap rule: if a visible city is within **12 CSS px** of a tap (nearest wins), the tap marks that city; otherwise the tap goes to the country exactly as today. Drag/pinch/wheel unchanged.
- City hit-testing uses the JS nearest-point grid below (not `circle.dot-hit`, which is O(n²)).
- Counters: plan-ux's tile "Cities: N · in M countries" plus a muted line "Capitals x / 197" (count national capitals in the data).
- Marking a city "Been there" also marks its country if unmarked (plan-ux decision 12).
- Selection rule default: national capitals + `POP_MAX` ≥ 100,000 + `SCALERANK` ≤ 4 (~3,000–4,000). Guard: if > 4,500, raise the population cut to 150k and report.

## 1. Decisions
| # | Decision | Reason |
|---|---|---|
| D1 | Source: Natural Earth 1:10m Populated Places, pinned release | Public domain like our map data; stable `ne_id`, `wikidataid`, `ADM0_A3`, capital flags, population, many Latin-script names; points only so python stdlib can read it |
| D3 | IDs `C-<ne_id>` (decimal), e.g. `C-1159151299` | Stable by NE design; traceable; lock file means an id is never dropped |
| D4 | City's country = the `world.json` polygon it falls in; `ADM0_A3` as fallback/tiebreak | Matches what the map draws (KOS, SAH, PSX, SDS, CYN, SOL…) |
| D6 | `data/cities.json` precached by the SW, parsed only when first needed (zoom k≥2 or first search focus) | ~65–80 KB gzip; offline abroad is when you want it |
| D7 | SVG circles, build-time zoom tiers, viewport culling, nearest-city tap lookup | Keeps `.on` CSS, accents, tooltips; ≤ 600 visible nodes |
| D8 | Cities join the existing search with aliases; rows "Name · Admin1, Country" | Disambiguates Springfields |

Rejected: GeoNames (CC BY, second license, noisy), OSM (ODbL share-alike on a derived DB in a public repo, heavy processing), Wikidata (slow/inconsistent extraction; keep `wikidataid` as a cross-reference).

Build step must verify: the source `geojson/ne_10m_populated_places.geojson` from `github.com/nvkelso/natural-earth-vector` at the latest release tag (expected v5.1.2) — record tag, commit SHA, URL, SHA-256 in `tools/cities-source.json`; refuse on hash mismatch. Fallback: naturalearthdata.com zip (.dbf only). Check `ne_id` present and unique, field names as expected, license still public domain.

## 2. Selection and tiers
Keep if `FEATURECLA` starts with "Admin-0 capital", or `POP_MAX` ≥ 100,000, or `SCALERANK` ≤ 4. Drop rows without `ne_id` or without a country after D4. Merge duplicates (same `wikidataid`, or same name < 0.3 units apart), keeping higher population.

Zoom tier `z`: rank by capital first, then `POP_MAX`, then `SCALERANK`. For each city in rank order, `z` = smallest k in [1,10] at which it is ≥ 8 CSS px from every higher-ranked city, using a 360 px reference width (1 unit = 0.36·k px); cap at 10. Runtime: visible if `z ≤ k · frameWidth / 360`, or if marked. Expect ~150–250 dots at 1× on a phone.

## 3. IDs and server allowlist
- `data/cities-ids.json` lists every city id ever published. Build fails if one disappears unless `tools/cities-remap.json` maps it (via `wikidataid`) or marks it `retired`. Retired/remapped ids stay in the allowlist forever; the app remaps old ids on load.
- `tools/make-place-ids.mjs` also reads `data/cities-ids.json` (full history) into `worker/place-ids.js` (~60 KB for 3,500 ids; fine for the Worker size limit). `--check` keeps working.
- Sync caps: today `MAX_PLACES = 400` and every sync sends every entry; countries+regions are already 310. The data plan must raise/redesign this before cities ship.

## 4. Pipeline: `tools/make-cities.py` (python3 stdlib)
Usage `python3 tools/make-cities.py [--src local.geojson] [--check]`.
1. Fetch pinned URL (or `--src`) into $TMPDIR; check SHA-256.
2. Parse and select (§2).
3. Project with d3 Equal Earth (A1=1.340264, A2=-0.081106, A3=0.000893, A4=0.003796, M=√3/2). Scale s = 500 / x_raw(π, 0) ≈ 184.7316, tx = 500, ty = 243.36, y negated: x = 500 + s·X, y = 243.36 − s·Y. (Planner checked VAT/MCO/SGP dots within 0.4 units; total height 486.7 matches the sphere.) Self-checks that fail the build: (a) projected sphere edge vs `world.sphere`, max error 0.2; (b) re-projected known `dot` places (VAT, MCO, SMR, LIE, SGP, MLT, AND) median error < 0.5; (c) least-squares fit of s/tx/ty from (b) within 0.1% of the constants.
4. Country: parse world.json paths (absolute M/L/Z only — verify) into rings; point-in-polygon. Inside one: use it. Inside none: polygon whose id equals `ADM0_A3` if within 3 units, else nearest within 3 units; else drop and log. Print PIP-vs-`ADM0_A3` disagreements (expect Jerusalem, Crimea, Western Sahara, N. Cyprus); pin exceptions in `tools/cities-overrides.json`.
5. Names: `n` = `NAME`; aliases = distinct `NAMEASCII`, `name_en`, `NAMEALT`, `NAMEPAR`, Latin-script `name_de/fr/es/it/pt/nl/pl/sv/tr/id/vi`, deduped after accent/case folding; skip non-Latin scripts in v1. `r` = `ADM1NAME` into a lookup table.
6. Tiers `z` (§2); flags `k`: 2 national capital, 1 admin-1 capital, 0 otherwise.
7. Write `data/cities.json` (rank-sorted, 1 decimal) and update `data/cities-ids.json`. `--check` regenerates in memory and diffs.
8. Print counts per tier/country, dropped rows, disagreements, raw and gzip sizes.

## 5. Output format
```
{ "v":1, "src":"ne_10m_populated_places v5.1.2 <sha>", "proj":"equalearth s=184.7316 t=500,243.36",
  "r":["Illinois","São Paulo",...],
  "c":[[1159151299,"São Paulo",["Sao Paulo"],"BRA",1,2,1.0,330.1,321.4], ...] }
```
Row: `[ne_id, name, aliases|0, worldId, admin1Index|-1, flags, z, x, y]`; client adds `C-`. ~200–230 KB raw, ~65–80 KB gzip.

## 6. Rendering: `js/cities.js`
- API: `Cities.load()` → Promise; `Cities.mount(svg, view, { isOn, onToggle, onTip })` → `{ update(vb, k), hit(clientX, clientY), refresh(id), count() }`. Integrate through the `window.Atlas` seam in plan-ux §7 (app.js gets `onView(vb, k)` at the end of `apply()` and `onTap(e)` checked first in `endPointer` on a non-moving tap; return true to skip the country toggle).
- Layer `<g class="cities">` above `.dots`, pooled `<circle class="city">` + `<g class="city-labels">`. `update()` once per frame (already coalesced): walk rank order, keep rows with `z ≤ k·w/360` inside viewBox + 5% (marked always), reuse nodes, set data-id/cx/cy and `on`/`want` classes. Hard cap 600. Radius fixed in CSS px like `sizeMarks()`: 2.4 px, 3.2 marked, 3.6 + ring for capitals.
- Hit test: 32 px grid of visible cities rebuilt on `update()`; nearest within 12 CSS px wins (lead decision). Hover uses the same lookup for tooltips.
- Labels: SVG text, recomputed on zoom change and pan end; rank order, right of the dot if the screen box is free (occupancy grid); max 40 on phones, 80 desktop; font like `layoutLabels()`. Shown in Flat and Real.
- Accessibility: cities reachable via search and lists; circles `aria-hidden`; changes announced through the existing toast.

## 7. Performance budget (mid-range phone; Chrome 4× CPU throttle as stand-in)
≤ 600 city circles + 80 labels (typical 150–400). `apply()` with cities ≤ 4 ms/frame (55–60 fps pan, 45+ pinch). Label relayout ≤ 8 ms at gesture end. First load: parse 15–30 ms, build ≤ 50 ms, no long task > 100 ms. Zero cost before cities are needed. Fallback if missed: canvas overlay.

## 8. Search
After load, add entries `{ p, key: norm(name + aliases), pop, country, admin1 }`. Extra folds in `norm`: ß→ss, ø→o, æ→ae, ł→l, đ→d, ı→i. Ranking: exact name/alias, prefix, word-prefix, substring; on identical names, countries/states/provinces before cities ("Georgia", "Mexico"), then cities by population. Display "Springfield · Illinois, United States"; if still identical add "(pop. 1.2M)"; show matched alias "Kyiv (Kiev)". Picking toggles per the marking switch; `flashPlace` gets a city branch centering at k ≥ 4. < 2 ms per keystroke.

## 9. Attribution
- NOTICE.md (Map data): "1:10m cultural vector data: populated places (cities), version 5.1.x. Population figures are Natural Earth's estimates and are approximate." and "City positions use the same Equal Earth projection as the world map."
- Footer: add "Cities: Natural Earth 1:10m populated places (public domain)."
- README: cities come from Natural Earth; rebuild with `python3 tools/make-cities.py` then `node tools/make-place-ids.mjs`.

## 10. Risks
Sync caps (data plan); `ne_id` churn (lock + remap); coastal cities outside 1:50m polygons (3-unit fallback + report); disputed places (our map decides, overrides pinned); dated populations/missing small towns (documented); density in Europe/Caribbean (z thinning, measure at 360 px); allowlist growth (acceptable); small-dot contrast in dark/Real (ring).

## 11. Phase 2 (not v1)
Cities on the NA map: fit Albers parameters (parallels near 29.5/45.5 etc. + rotation) from NE 1:50m admin-1 vertices against na.json, accept if median error < 0.5; insets need their own transforms.

## 12. Work breakdown
| Task | Owns | Depends on | Tests |
|---|---|---|---|
| C1 Pipeline | tools/make-cities.py, tools/cities-source.json, tools/cities-overrides.json, tools/cities-remap.json, data/cities.json, data/cities-ids.json | — | --check; projection self-checks; uniqueness; count guard |
| C2 Allowlist | tools/make-place-ids.mjs, worker/place-ids.js | C1 | api: real `C-` id accepted, `C-1` rejected, --check passes |
| C3 Sync caps | per data plan | C2 | api: 1,000+ entries accepted |
| C4 City layer | js/cities.js (+ seam hooks via plan-ux T1) | C1, UX T1 | cities.spec: tap within 12 px marks nearest city; drag over a city doesn't toggle; node count ≤ 600 at k = 1, 3, 10; marked city visible at k = 1 |
| C5 Search | search block (owner per plan-ux T1/T5 split) | C1, C4 | "sao paulo", "kiev" → Kyiv, "springfield" ≥ 2 states, "georgia" country first |
| C6 Offline | tools/asset-list.json, stamp | C1 | sw: cities.json served offline |
| C7 Credits | NOTICE.md, footer, README | C1 | smoke: footer text |
| C8 Perf pass | measure only | C4 | 4× throttle: apply() ≤ 4 ms p95 |
