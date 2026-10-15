# Notices and credits

The code in this repository is licensed under the MIT License (see `LICENSE`). That license does not apply to the map data or fonts listed below, which have their own terms.

## Map data

Made with Natural Earth. Free vector and raster map data at https://www.naturalearthdata.com.

Natural Earth is in the public domain. This app uses:

- 1:50m cultural and physical vector data (country, state, province and territory outlines)
- Natural Earth I with Shaded Relief, Water, and Drainages (raster), used for the Real map view
- 1:10m cultural vector data: populated places (cities), version 5.1.x (pinned to release v5.1.2; source details in `tools/cities-source.json`). Population figures are Natural Earth's estimates and are approximate.

The geometry in `data/` has been projected and simplified for this app. Projections used: Equal Earth for the world map, and Albers equal-area conic for the U.S. and Canada map. City positions use the same Equal Earth projection as the world map.

## Fonts

These fonts are self-hosted in `fonts/` under the SIL Open Font License, Version 1.1. The full license texts are in `fonts/` (files named `OFL-*.txt`).

- Bricolage Grotesque, by Mathieu Triay and the Bricolage Grotesque Project Authors
- IBM Plex Sans, Copyright IBM Corp.
- IBM Plex Mono, Copyright IBM Corp.

## QR code generator

qrcode-generator by Kazuhiko Arase, MIT License, vendored in `js/vendor/qrcode.js` (license header kept in the file).
