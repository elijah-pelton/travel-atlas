#!/usr/bin/env python3
"""Split the single-file Travel Atlas seed into a static site.

Usage:
    python3 tools/split-seed.py path/to/Travel-Atlas_Source_v1.html            # data + terrain only
    python3 tools/split-seed.py path/to/Travel-Atlas_Source_v1.html --all      # also css/js/index.html

By default only the generated assets (data/*.json, terrain/*.jpg) are rewritten, so re-running it
never clobbers hand edits to index.html, css/app.css or js/app.js. Pass --all for the initial split.
"""
import base64
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def const_json(src, name):
    m = re.search(r'^\s*const ' + name + r' = (\{.*\});\s*$', src, re.M)
    if not m:
        sys.exit(f'could not find const {name}')
    return m.group(0), json.loads(m.group(1))


def write(rel, data):
    p = ROOT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        p.write_text(data, encoding='utf-8')
    else:
        p.write_bytes(data)
    return p


def decode_uri(uri):
    prefix = 'data:image/jpeg;base64,'
    if not uri.startswith(prefix):
        sys.exit('unexpected terrain data URI')
    return base64.b64decode(uri[len(prefix):])


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1]).read_text(encoding='utf-8')
    do_all = '--all' in sys.argv[2:]

    na_line, na = const_json(src, 'NA')
    world_line, world = const_json(src, 'WORLD')
    terrain_line, terrain = const_json(src, 'TERRAIN')

    write('data/na.json', json.dumps(na, separators=(',', ':'), ensure_ascii=False))
    write('data/world.json', json.dumps(world, separators=(',', ':'), ensure_ascii=False))

    total = 0
    jpgs = [('terrain/world.jpg', terrain['world']), ('terrain/na.jpg', terrain['na'])]
    jpgs += [(f'terrain/inset-{i}.jpg', u) for i, u in enumerate(terrain['insets'])]
    for rel, uri in jpgs:
        b = decode_uri(uri)
        if b[:3] != b'\xff\xd8\xff':
            sys.exit(f'{rel} is not a JPEG')
        write(rel, b)
        total += len(b)
    print(f'NA places: {len(na["places"])}, insets: {len(na["insets"])}; WORLD places: {len(world["places"])}')
    print(f'terrain: {len(jpgs)} JPEGs, {total / 1024:.0f} KB total')

    if not do_all:
        return

    css = re.search(r'<style>\n?(.*?)</style>', src, re.S).group(1)
    write('css/app.css', css)

    markup = re.search(r'</style>\n(.*?)\n<script type="application/json" id="atlas-state">', src, re.S).group(1)

    js = re.search(r'<script id="atlas-app">\n(.*?)</script>', src, re.S).group(1)
    # The geometry and terrain now live in files; app.js loads them at startup.
    js = js.replace(na_line, '  let NA, WORLD; // loaded from ./data/na.json and ./data/world.json at startup')
    js = js.replace(world_line, '')
    paths = {'world': './terrain/world.jpg', 'na': './terrain/na.jpg',
             'insets': [f'./terrain/inset-{i}.jpg' for i in range(len(terrain['insets']))]}
    js = js.replace(terrain_line, '  const TERRAIN = ' + json.dumps(paths) + ';')
    write('js/app.js', js)

    html = (
        '<!doctype html>\n<html lang="en">\n<head>\n'
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        '<title>Travel Atlas</title>\n'
        '<link rel="stylesheet" href="./css/app.css">\n'
        '</head>\n<body>\n'
        + markup.strip('\n') +
        '\n<script src="./js/app.js"></script>\n</body>\n</html>\n'
    )
    write('index.html', html)
    print('wrote css/app.css, js/app.js, index.html')


if __name__ == '__main__':
    main()
