# Travel Atlas

Travel Atlas is a pair of maps for keeping track of where you have been and where you want to go. One map covers the United States and Canada. The other covers the world, with about 3,300 cities that appear as you zoom in. Tap a place to mark it; a switch on each map changes taps from "Been there" to "Want to go", and want places show up striped. Tap a name in the lists below a map to give it a rating from 1 to 5, the year you went and a short note. The Ratings map style colors the map by your stars.

The Color button lets you pick the color for places you've been (amber, coral, rose, violet, blue, teal or green); each device remembers its own choice. It works offline after the first load and can be installed like an app on a phone or computer.

Live app: https://atlas.elijahpelton.com/

The old address (https://elijah-pelton.github.io/travel-atlas/) now forwards to the new one and carries your marks over automatically. If you installed the old version on your phone or computer, delete that icon and install again from the new address.

## Install

The app runs fine in a browser tab. Installing it just adds an icon to your home screen or dock. Use https://atlas.elijahpelton.com/ for all of these.

- **iPhone and iPad:** open the link in Safari, tap Share, then Add to Home Screen.
- **Android:** open the link in Chrome, then choose Install app (or Add to Home screen) from the three-dot menu. You can also use the Install button in the page.
- **Desktop, Chrome or Edge:** click the Install button in the page header, or the install icon in the address bar.
- **Desktop, Safari on macOS:** choose File, then Add to Dock.

## Privacy

Marks and notes are saved on the device you are using first, in your browser. Nothing leaves the device unless you create a link with Share (see below). If you never use Share, nothing is ever uploaded.

If you do create a link, the app stores these on Cloudflare, at atlas.elijahpelton.com:

- your map's name and the owner name you entered;
- which places and cities are marked Been there or Want to go;
- your notes, ratings and years, so your other devices get them too.

The plain view link shows marks only. Notes, ratings and years are readable by someone else only through the map-with-notes link, which is off until you switch it on.

There are no accounts, no analytics, and no requests to third-party sites. The QR code for adding another device is made on your device, so the edit link never goes to anyone else.

The flip side of local storage: if you clear site data or browser storage, the marks on that device are erased. If you are not syncing, make a backup (see below), especially before switching phones.

## Sharing and syncing

Sharing is optional. The atlas works fully on one device without it.

To start, open Share and choose Create link. The app gives your map a name and these links:

- **View link, map only.** Safe to share. Anyone who opens it sees where you've been and want to go, and cannot change anything. It never shows notes or ratings.
- **View link, map with notes.** Off until you switch it on in Share. It shows the same map plus your ratings, years and notes, still read only. Switching it off makes it stop working; switching it back on makes a new link, so the old one stays dead. Resetting it also gives you a new link and stops the old one.
- **Edit link.** Lets a device change your map. Anyone with the edit link can change your map, so keep it to yourself.

To add your own other devices, open Share on the first device and use Add a device. Scan the QR code with the other device's camera. On a computer, use Copy edit link instead and open that link on the other device.

Edits made on several devices are merged place by place, including edits made while offline. A place's mark and its note are merged separately, so clearing a mark on one device never wipes a note written on another. Changes sync the next time the device is online.

Other controls in the Share dialog:

- **Reset edit access** makes the old edit link stop working. Use it if an edit link leaked. Your other devices need to be paired again.
- **Stop syncing on this device** keeps your marks here and disconnects this device from the shared map.
- **Delete shared map** removes the copy stored on the server. Marks stay on your devices.

A friend who wants their own atlas makes their own separate map. Maps are not combined.

## Backup and restore

Open Backup in the page header.

- The dialog shows a code starting with `atlas2:`. It holds your map only: places and cities you've been to and want to go. Copy it somewhere safe, such as a note or an email to yourself.
- Download backup saves a `.json` file with everything: marks plus notes, ratings and years.
- Restore accepts either a pasted code or a backup file. You can add the restored entries to what you already have (this never removes or downgrades anything), or replace your current atlas with them. Entries the app does not recognize are skipped.
- Older `atlas1:` codes and files, including ones from the claude.ai and GitHub Pages versions of this atlas, still restore.
- The backup reminder only appears on devices that are not syncing.

## Cities

City dots come from Natural Earth's 1:10m populated places, a public-domain dataset: national capitals, places of 100,000 people or more, and a few smaller well-known ones, about 3,300 in all. They show on the world map only, appear as you zoom in, and search finds all of them. Marking a city Been there also marks its country if it isn't marked yet; clearing a city leaves the country alone. The city file loads the first time you zoom in or search, and then stays cached for offline use.

To rebuild the city data (for example after a new Natural Earth release), from the repo root:

```
python3 tools/make-cities.py
node tools/make-place-ids.mjs
```

The first writes `data/cities.json` and `data/cities-ids.json` from the source pinned in `tools/cities-source.json` (it refuses a file whose checksum doesn't match). The second regenerates the server's list of allowed place IDs; the server drops any city it doesn't know, so skipping this step means new cities never sync.

## Updating

When a new version is published, the app shows "Update available · Reload". Tap Reload to switch to it.

## Publishing an update

The first time, run `npm install` in the repo root and log in to Cloudflare with `npx wrangler login`.

1. Make your changes.
2. From the repo root, run `python3 tools/stamp-sw.py`. It updates the version line in `sw.js` so installed copies can tell something changed. (`python3 tools/stamp-sw.py --check` tells you if you forgot.)
3. Commit and push to `main`.
4. If anything in `migrations/` changed, run `npx wrangler d1 migrations apply DB --remote` first. Migrations only add to the database, so the version still running keeps working.
5. From the repo root, run `npx wrangler deploy`. This publishes the site and the sync server to https://atlas.elijahpelton.com/.

Installed copies show "Update available · Reload" the next time they are opened.

Terrain images are kept across updates to save downloads. If you ever replace a terrain JPEG, give it a new file name so devices fetch the new one.

## Run locally

From the repo root:

```
npm install
npm run dev
```

This starts Cloudflare's local server with a local database. Open http://localhost:8787/. The service worker (which provides offline use and installing) only runs on http://localhost or https, so open the page that way rather than as a file.

To run the tests:

```
cd tests
npm install
npx playwright test
```

The tests start the local server themselves.

## Project layout

- `index.html` - the page
- `css/` - styles (`css/features.css` holds want to go, the notes panel, the Ratings style and cities)
- `js/app.js` - the app
- `js/store.js` - saved data on the device: marks, notes, sync bookkeeping and backup formats
- `js/places-panel.js` - the notes and ratings panel
- `js/ratings.js` - the Ratings map style
- `js/cities.js` - city dots, tapping and search
- `js/vendor/` - the QR code library
- `data/` - map geometry (JSON)
- `data/cities.json` - city names, positions and zoom tiers
- `data/cities-ids.json` - every city ID ever published, so the server keeps accepting old ones
- `terrain/` - shaded-relief JPEGs used by the Real map view
- `fonts/` - self-hosted fonts and their licenses
- `icons/` - app icons
- `sw.js` - service worker (offline cache and updates)
- `manifest.webmanifest` - install metadata
- `worker/` - the small server for shared maps
- `worker/model.js` - the server's checks and merge rules, kept separate so tests can run them directly
- `migrations/` - the database tables
- `wrangler.jsonc` - Cloudflare settings
- `redirect/` - the forwarding page published at the old GitHub Pages address (from the `gh-pages` branch)
- `docs/SYNC.md` - how sharing and syncing work
- `docs/plan-*.md` - design plans for want to go, notes and ratings, cities, and the data and sync changes
- `docs/later/` - a database migration held back until every shared map has been converted
- `tools/split-seed.py` - re-extracts the data and terrain files from the original single-file version
- `tools/make-icons.*` - generates the icon PNGs from the SVG source
- `tools/make-cities.py` - builds the city data from Natural Earth
- `tools/make-place-ids.mjs` - regenerates the server's list of allowed place IDs
- `tests/` - automated checks

## Credits

Map data, terrain imagery and fonts come from other projects. See [NOTICE.md](NOTICE.md). The code is released under the MIT License (see [LICENSE](LICENSE)).
