# Travel Atlas

Travel Atlas is a pair of maps for keeping track of where you have been. One map covers the United States and Canada. The other covers the world. Tap a place to mark it, and the counters and "Been there" lists update as you go. The Color button lets you pick the color for places you've been (amber, coral, rose, violet, blue, teal or green); each device remembers its own choice. It works offline after the first load and can be installed like an app on a phone or computer.

Live app: https://elijah-pelton.github.io/travel-atlas/

## Install

The app runs fine in a browser tab. Installing it just adds an icon to your home screen or dock.

- **iPhone and iPad:** open the link in Safari, tap Share, then Add to Home Screen.
- **Android:** open the link in Chrome, then choose Install app (or Add to Home screen) from the three-dot menu. You can also use the Install button in the page.
- **Desktop, Chrome or Edge:** click the Install button in the page header, or the install icon in the address bar.
- **Desktop, Safari on macOS:** choose File, then Add to Dock.

## Your marks stay on your device

Marks are stored in your browser on the device you are using. Nothing is uploaded. There are no accounts, no analytics, and no requests to third-party sites.

The flip side: if you clear site data or browser storage, your marks are erased. Make a backup (see below), especially before switching phones.

## Backup and restore

Open Backup in the page header.

- The dialog shows a code starting with `atlas1:` followed by a sorted list of place IDs. Copy it somewhere safe, such as a note or an email to yourself.
- Download backup saves the same information as a `.json` file.
- Restore accepts either a pasted code or a backup file. You can add the restored marks to what you already have, or replace your current marks with them. Entries the app does not recognize are skipped.
- Codes from the older claude.ai version of this atlas still work.

## Updating

When a new version is published, the app shows "Update available · Reload". Tap Reload to switch to it.

## Run locally

From the repo root:

```
python3 -m http.server 8000
```

Then open http://localhost:8000/. The service worker (which provides offline use and installing) only runs on http://localhost or https, so open the page that way rather than as a file.

## Project layout

- `index.html` - the page
- `css/` - styles
- `js/app.js` - the app
- `data/` - map geometry (JSON)
- `terrain/` - shaded-relief JPEGs used by the Real map view
- `fonts/` - self-hosted fonts and their licenses
- `icons/` - app icons
- `sw.js` - service worker (offline cache and updates)
- `manifest.webmanifest` - install metadata
- `tools/split-seed.py` - re-extracts the data and terrain files from the original single-file version
- `tools/make-icons.*` - generates the icon PNGs from the SVG source
- `tests/` - automated checks

## Credits

Map data, terrain imagery and fonts come from other projects. See [NOTICE.md](NOTICE.md). The code is released under the MIT License (see [LICENSE](LICENSE)).
