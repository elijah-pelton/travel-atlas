# Travel Atlas — UX plan: Want to go, notes & ratings, cities

Scope: how the next release looks and behaves. Data model, sync and server live in the data plan (docs/plan-data-sync.md); this file only names the hooks the UI needs from it. City data lives in docs/plan-cities.md.
Ground rules: 375 px and desktop; light and dark via tokens; keyboard and screen reader; offline-first; drag never toggles; no third-party requests; CSP stays `style-src 'self'` (no `style=""` attributes; use classes or CSSOM); keep the existing look.

Lead decisions (approved, override anything below that conflicts): notes/ratings/years sync to the server (needed for the notes view link); notes are owner-only; two view links (map only, map with notes; the notes one off by default, revocable); backup format may change (still accept old `atlas1:` codes).

## 1. Decisions

1. Marking switch inside each map frame (top left, opposite zoom): "Been there | Want to go". Both frames share one state. It sits where you tap, so phone users see the mode.
2. Not tap-cycling or long-press: cycling makes "clear" 2–3 taps; long-press clashes with drag/pinch/iOS callout.
3. Mode resets to "Been there" on every load (never saved).
4. Asymmetric rules: Been mode on a want place → been. Want mode on a been place → no change, toast; keeps rating/note.
5. Want to go = diagonal stripes in the accent color plus a dashed outline (pattern differs, not just color: all 7 accents, both styles, color-blind safe).
6. Details open from chips (Been there / Want to go lists), from a Details button in the map toast, and by tapping a marked place on a notes view link. On the owner's map a tap always means "mark".
7. A chip opens details instead of removing; removal moves into the panel.
8. "Ratings" is a third map style next to Flat colors and Real map.
9. Two view links: "Map only" (always) and "Map with notes" (off until switched on, own secret token). The plain link can never show notes.
10. Cities are dots on the existing maps that appear as you zoom. US/Canada cities show on both maps. Own counter tile and chip list. No third map.
11. City dots are culled: only cities inside the view, by tier, capped ~400 visible; marked cities always show. Pooled DOM nodes.
12. Marking a city "Been there" also marks its country if not marked yet (toast says so). Clearing a city never clears its country.

## 2. Interaction specs

### 2.1 Want to go
- Switch `.mark-seg` reuses `.seg` buttons (aria-pressed), group label "What a tap marks", top left in `#frame-na` and `#frame-world`, styled like the zoom box. The Want button shows a striped swatch; in Want mode the frame gets a 2 px dashed accent outline. Hidden on view pages.
- Tap/click (same drag-vs-tap rules and hit circles):

| Mode | nothing | want | been |
|---|---|---|---|
| Been there | been | been | nothing (rating/note kept 30 days in case you re-mark) |
| Want to go | want | nothing | no change + toast "Already been to Peru" + Details |

- Toasts: "Peru: been there", "Peru: want to go", "Peru: cleared", "Peru: been there (was on Want to go)". Each map-tap toast has a Details button (visible 4 s, longer while hovered/focused); the toast is `pointer-events: auto` only on that button.
- Search: picking a result marks per the switch, flashes, keeps the list open. Row check: filled (been), striped ring (want), empty. Option label ends ", been there" / ", want to go" / ", not marked".
- Keyboard: switch reachable by Tab; search follows the mode; chips are buttons; map shapes stay pointer-only. Live toast announces each change.
- Counters: tiles keep counting been; muted line "+3 want to go" (hidden at 0); the bar gets a second striped segment.
- Lists: "Been there (12):" solid chips, then "Want to go (4):" outline chips. Empty: "Nothing marked here yet."

### 2.2 Notes, ratings, year (owner only)
- Open from a chip or the toast's Details button (search stays a fast marker).
- Panel: `<dialog class="dlg-box place-panel">` built by js/places-panel.js. ≤640 px: bottom sheet (max 80dvh, scrolls inside). Desktop: centered, 420 px. Reuses `.dlg` styles.
  - Header: name (h2), sub "Country · World" / "City · Japan", close ×.
  - Status seg radiogroup "Been there | Want to go | Not marked"; saves at once.
  - Rating (been only): 5 star radios + "No rating"; arrows move, Space picks; SVG stars in accent ink.
  - Year (been only): text, inputmode numeric, 4 digits, 1900..next year.
  - Note: textarea maxlength 500, counter appears at 400.
  - Footer: privacy line, Done (primary). Auto-save (debounce 400 ms and on close).
- Keyboard: focus starts on the status seg; Esc/Done closes and returns focus to the opener; native modal traps Tab.
- Indicators: chips with a note show a note glyph; rated chips show "★4" in mono; tooltip "been there · ★★★★☆ · 2019".

### 2.3 Ratings map style
- Seg: "Flat colors | Real map | Ratings", saved per device. Flat base, no terrain.
- Been places colored by rating (`r1`–`r5`); been without rating = land fill + 1.5 px accent outline (`.unrated`); want/unmarked = plain land.
- Legend replaces the normal one: "1 ★ … 5 ★" ramp, "Been, no rating", "Not been or want to go". Ramp varies in lightness, with numbers written next to swatches. Empty hint: "Rate places from the lists below to color this map."

### 2.4 Notes privacy and Share dialog
Linked state (`#share-on`): replace the single View link block with:
```
VIEW LINKS
Map only        [ atlas.elijahpelton.com/map/abc ] [Copy] [Share]
  Places you've been and want to go. No notes or ratings.
[switch] Also make a link that shows my notes and ratings
Map with notes  [ atlas.elijahpelton.com/map/abc#n=… ] [Copy] [Share]
  Anyone with this link can read your notes, ratings and years.
```
(Exact notes-link URL shape comes from the data plan.)
- Switch: `<button role="switch" aria-checked>`, off by default. On → creates the notes link. Off → confirm "Turn off the notes link? Anyone who has it will only see the plain map. Turning it back on makes a new link." [Turn off] [Keep it]; off revokes the token.
- Each link row has its own copy note (`.dlg-note`, role=status). "Add a device" and "Manage" unchanged.

| | Map only | Map with notes |
|---|---|---|
| Been/want marks, counters, lists | yes | yes |
| Styles | Flat, Real | Flat, Real, Ratings |
| Tap marked place / chip | toast "View only" / plain-text chip | read-only panel |
| Tooltip | name + status | + stars and year |
| Banner | "Sam's map · view only · Make your own atlas" | "Sam's map with notes · view only · Make your own atlas" |
| Marking switch, Backup, Share, editing | hidden | hidden |

### 2.5 Cities
- `<g class="cities">` above `.dots` in both SVGs. Data loaded lazily (first zoom to k≥2 or first search keystroke), then cached by the SW so it works offline.
- Tiers from the cities plan; marked cities show at every zoom.
- Culling on each `apply()` (rAF-batched): only cities in the viewBox, up to ~400 by tier then population, from a node pool.
- Marks: visible circle (3 px, sized via sizeMarks) + transparent hit circle ≈16 px (smaller than country dots' 22 px). Same tap rules and marking switch.
- Labels: Real style shows names at k≥4 for marked and tier-1 cities, using the existing label collision pass.
- Counters: World tile "Cities: 14 · in 6 countries"; NA tile "Cities: 5 · in 3 states and provinces". No denominator, bar hidden.
- Lists: "Cities (14):" grouped by country (state/province on NA): "Japan: Kyoto, Osaka ★5". World lists non-US/CA cities; NA lists US/CA ones (no duplicates). Want cities as outline chips in the same group.
- Search: same index and `norm()`; rows "Kyoto · City · Japan"; places first on equal match, then cities by population; max 10 rows, max 6 cities. Picking a city marks it, zooms to k=4 centered, flashes.
- Same panel for notes/ratings; Ratings style colors city dots by the ramp.

## 3. Visual specs (css/features.css, loaded after app.css)
- Tokens on :root with dark overrides in the same three blocks as app.css: `--want-stripe` (light `var(--visited-hover)`, dark `var(--visited)`), `--want-ink: var(--visited-ink)`, `--r1…--r5 = color-mix(in oklab, var(--visited) N%, var(--land))`, N = 22/40/60/80/100 (fallback: opacity steps).
- Hatch: per SVG `<pattern id="want-na|want-world" patternUnits="userSpaceOnUse" width=6 height=6 patternTransform="rotate(45)">` with `rect.want-bg` + `line.want-line` (2 px). sizeMarks sets width/height to `6/k`. `.place.want { fill: url(#want-<map>); stroke: var(--want-stripe); stroke-dasharray: 3 2; }`; `.want-bg { fill: var(--land) }`; `.want-line { stroke: var(--want-stripe) }`; Real style: `.want-bg` transparent, line opacity .8.
- Dots (small places and cities): been = filled accent; want = land fill + 2 px accent ring (non-scaling); unmarked = today's dot. `.inset-bg.want`: dashed accent stroke, no fill.
- Want chip: transparent bg, `1.5px dashed var(--want-stripe)`, text `var(--want-ink)`; hover underlines (no line-through). Keep the 36 px phone tap area.
- Legend: "Been there" (solid), "Want to go" (striped, `repeating-linear-gradient(45deg, var(--want-stripe) 0 2px, var(--land) 2px 5px)`), "Not yet", "Small place: tap the dot", "City (zoom in to see)".
- `.frame.mode-want { outline: 2px dashed var(--want-stripe); outline-offset: -2px; }`.
- Phone: switch and zoom inside the frame; Ratings seg wraps; panel sheet uses `env(safe-area-inset-bottom)`. Reduced motion: no slide/flash.

## 4. Copy (no em dashes, no "you should")
- Switch: "Been there", "Want to go"; group label "What a tap marks".
- Masthead sub: "Tap a state, province, country or city to mark it. Use the switch on the map to mark places you want to go. Tap a name in the lists to add a rating or a note."
- Toasts: "Peru: been there", "Peru: want to go", "Peru: cleared", "Peru: been there (was on Want to go)", "Already been to Peru", "Kyoto and Japan: been there", button "Details".
- Panel: "Been there", "Want to go", "Not marked", "Your rating", "No rating", "When did you go? (optional)", "Note", placeholders "What do you remember?" / "Why do you want to go?", counter "120 left", "Done". Privacy line: "Only you see notes and ratings, unless you turn on the notes link in Share." Read-only: "Sam's rating", "Went in 2019", "No note."
- Lists: "Been there (12):", "Want to go (4):", "Cities (14):", "Nothing marked here yet." Tile: "+3 want to go"; "Cities", "in 6 countries".
- Styles/legend: "Ratings", "1 ★"…"5 ★", "Been, no rating", "Not been or want to go".
- Share and banners: as in §2.4. Search row: "Kyoto · City · Japan". Legend: "City (zoom in to see)".

## 5. Accessibility
- Want differs by pattern and outline; ratings by lightness plus numbers. Extend test 13 contrast checks to stripes and ramp in all 7 accents, both themes.
- Marking switch aria-pressed + live toast; notes-link `role="switch"`.
- Panel: native modal dialog with aria-labelledby; stars are radios labelled "1 star"…"5 stars"; focus returns to opener; chips are the path that never times out.
- Chip names: "Peru, been there, rated 4, has a note. Open details." Notes-link chips are buttons; plain-link chips are text.
- ≥40 px targets on phones; 16 px inputs.

## 6. UI states to build and test
1 Owner Been mode. 2 Owner Want mode. 3 Each status × Flat/Real/Ratings × light/dark × 7 accents. 4 Panel: been, want, not marked, city. 5 Toast with Details; "Already been". 6 Ratings with no ratings (hint). 7 Cities: not loaded, loading (fade in), offline without cache (search: "Cities need one online visit first."), zoomed out (marked only). 8 Share not linked. 9 Linked, notes link off. 10 Notes link on. 11 Turn-off confirm. 12 Map-only view. 13 Map-with-notes view (read-only panel). 14 Notes link revoked → plain view + "This link no longer shows notes." 15 View loading/failed. 16 375 px for all.

## 7. Work breakdown (one owner per file)
Seam: app.js exposes `window.Atlas = { places, nodes, views, getStatus(id), setStatus(id, s, {quiet}), getInfo(id), setInfo(id, patch), mode, viewMode ('own'|'plain'|'notes'), on(evt, fn), toast(map, msg, action), addSearchSource(fn), addLayer(mapKey, fn) }` with events `change`, `zoom`, `style`. New modules are plain `<script defer>` after app.js and talk to app.js only through `Atlas`.

| Task | Owns | Depends on |
|---|---|---|
| T1 Core + seam: been/want state, tap rules, switch, paint, counters, two lists, three-state search, toast action, `window.Atlas` | js/app.js, index.html (script tags, switch, legend) | data plan state shape |
| T2 Styles | css/features.css (new) | — |
| T3 Place panel | js/places-panel.js (new) | T1 |
| T4 Ratings style | js/ratings.js (new) | T1, T3 |
| T5 Cities UI | js/cities.js (new) | T1, cities data |
| T6 Share + view pages (two links, switch, notes view) | share/view parts of js/app.js after T1, `#share` in index.html | T1, T3, server token |
| T7 Copy + docs | index.html `#howto` + `.sub`, README.md, docs/SYNC.md UI parts | T1–T6 |
| T8 Release | sw.js, tools/ | all |

Order: T1 ∥ T2 → T3 ∥ T4 ∥ T5 → T6 → T7, T8.

## 8. Tests
- want.spec (T1): Want tap → `.want` + pattern + "+1 want to go" + outline chip; Been on want → been; Want on been → toast; reload resets mode keeps marks; drag in Want marks nothing; search aria-labels.
- panel.spec (T3): chip opens, Esc returns focus; rating/year/note persist; removal from panel; Details opens; 375 px sheet, 40 px targets, 16 px inputs; keyboard-only flow.
- ratings.spec (T4): ramp classes, legend, unrated outline; ramp contrast monotonic in 7 accents × 2 themes.
- cities.spec (T5): no city request before zoom/search; ≤400 nodes at max zoom over Europe; marked cities at k=1; Kyoto marks Japan, clearing keeps Japan; "Sao Paulo" finds São Paulo; offline after one visit; pan frame < 16 ms on 4× throttle.
- share-notes.spec (T6): switch makes second link; plain link API never returns notes; notes link shows read-only panel + Ratings; turning off revokes.
- Update: fix9 chip aria-label; smoke 03-04 chips open panel; sync counts both lists; test 12 includes cities.json; test 13 stripe contrast; test 15 stripes follow accent.

## 9. How it works / README
- Intro: tap marks Been there; the switch changes taps to Want to go; tap again to clear; want places look striped.
- New "Notes and ratings": tap a name in the lists to rate 1–5, add a year and a note; Ratings style colors the map.
- New "Cities": zoom in to see cities; marking a city also marks its country; search finds any city.
- Share: two view links; map-only never shows notes; notes link off until switched on, and turning it off stops it working.
- README privacy: what's stored when sharing (want-to-go, cities, notes/ratings/years); the notes link is the only way others see notes. README layout: new modules, css/features.css, data/cities.json; credit city data in NOTICE.md.
