# Travel Atlas

Travel Atlas is a pair of maps for keeping track of where you have been. One map covers the United States and Canada. The other covers the world. Tap a place to mark it, and the counters and "Been there" lists update as you go. The Color button lets you pick the color for places you've been (amber, coral, rose, violet, blue, teal or green); each device remembers its own choice. It works offline after the first load and can be installed like an app on a phone or computer.

Live app: https://atlas.elijahpelton.com/

The old address (https://elijah-pelton.github.io/travel-atlas/) now forwards to the new one and carries your marks over automatically. If you installed the old version on your phone or computer, delete that icon and install again from the new address.

## Install

The app runs fine in a browser tab. Installing it just adds an icon to your home screen or dock. Use https://atlas.elijahpelton.com/ for all of these.

- **iPhone and iPad:** open the link in Safari, tap Share, then Add to Home Screen.
- **Android:** open the link in Chrome, then choose Install app (or Add to Home screen) from the three-dot menu. You can also use the Install button in the page.
- **Desktop, Chrome or Edge:** click the Install button in the page header, or the install icon in the address bar.
- **Desktop, Safari on macOS:** choose File, then Add to Dock.

## Privacy

Marks are saved on the device you are using first, in your browser. Nothing leaves the device unless you create a link with Share (see below). If you never use Share, nothing is ever uploaded.

If you do create a link, the app stores three things on Cloudflare, at atlas.elijahpelton.com: your map's name, the owner name you entered, and which places are marked. That is all.

There are no accounts, no analytics, and no requests to third-party sites. The QR code for adding another device is made on your device, so the edit link never goes to anyone else.

The flip side of local storage: if you clear site data or browser storage, the marks on that device are erased. If you are not syncing, make a backup (see below), especially before switching phones.

## Sharing and syncing

Sharing is optional. The atlas works fully on one device without it.

To start, open Share and choose Create link. The app gives your map a name and two kinds of link:

- **View link.** Safe to share. Anyone who opens it sees your map and cannot change it. Use it for "here's everywhere I've been."
- **Edit link.** Lets a device change your map. Anyone with the edit link can change your map, so keep it to yourself.

To add your own other devices, open Share on the first device and use Add a device. Scan the QR code with the other device's camera. On a computer, use Copy edit link instead and open that link on the other device.

Edits made on several devices are merged place by place, including edits made while offline. They sync the next time the device is online.

Other controls in the Share dialog:

- **Reset edit access** makes the old edit link stop working. Use it if an edit link leaked. Your other devices need to be paired again.
- **Stop syncing on this device** keeps your marks here and disconnects this device from the shared map.
- **Delete shared map** removes the copy stored on the server. Marks stay on your devices.

A friend who wants their own atlas makes their own separate map. Maps are not combined.

## Backup and restore

Backup works the same as before. Open Backup in the page header.

- The dialog shows a code starting with `atlas1:` followed by a sorted list of place IDs. Copy it somewhere safe, such as a note or an email to yourself.
- Download backup saves the same information as a `.json` file.
- Restore accepts either a pasted code or a backup file. You can add the restored marks to what you already have, or replace your current marks with them. Entries the app does not recognize are skipped.
- Codes from the older claude.ai and GitHub Pages versions of this atlas still work.
- The backup reminder only appears on devices that are not syncing.

## Updating

When a new version is published, the app shows "Update available · Reload". Tap Reload to switch to it.

## Publishing an update

The first time, run `npm install` in the repo root and log in to Cloudflare with `npx wrangler login`.

1. Make your changes.
2. From the repo root, run `python3 tools/stamp-sw.py`. It updates the version line in `sw.js` so installed copies can tell something changed. (`python3 tools/stamp-sw.py --check` tells you if you forgot.)
3. Commit and push to `main`.
4. From the repo root, run `npx wrangler deploy`. This publishes the site and the sync server to https://atlas.elijahpelton.com/.

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
- `css/` - styles
- `js/app.js` - the app
- `js/vendor/` - the QR code library
- `data/` - map geometry (JSON)
- `terrain/` - shaded-relief JPEGs used by the Real map view
- `fonts/` - self-hosted fonts and their licenses
- `icons/` - app icons
- `sw.js` - service worker (offline cache and updates)
- `manifest.webmanifest` - install metadata
- `worker/` - the small server for shared maps
- `migrations/` - the database tables
- `wrangler.jsonc` - Cloudflare settings
- `redirect/` - the forwarding page published at the old GitHub Pages address (from the `gh-pages` branch)
- `docs/SYNC.md` - how sharing and syncing work
- `tools/split-seed.py` - re-extracts the data and terrain files from the original single-file version
- `tools/make-icons.*` - generates the icon PNGs from the SVG source
- `tests/` - automated checks

## Credits

Map data, terrain imagery and fonts come from other projects. See [NOTICE.md](NOTICE.md). The code is released under the MIT License (see [LICENSE](LICENSE)).
