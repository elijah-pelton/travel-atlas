#!/usr/bin/env python3
"""Stamp sw.js with a content-hash VERSION so every deploy reaches installed copies.

Run before each commit:   python3 tools/stamp-sw.py
Verify (CI / pre-push):   python3 tools/stamp-sw.py --check
Another copy of the site: python3 tools/stamp-sw.py --root /path/to/site

What it does:
  1. Rewrites the PRECACHE array in sw.js from the "precache" list in tools/asset-list.json.
  2. Hashes (sha256) every precached file's bytes, in list order, each preceded by its path.
     "./" is the same file as "./index.html", so each file is hashed once.
  3. Adds sw.js itself with its VERSION line blanked out, so changes to the worker's own
     logic also produce a new version.
  4. Writes the first 10 hex digits into the single line `const VERSION = '...';`.

The result depends only on file contents, so running it again with no changes is a no-op.
--check changes nothing and exits 1 if sw.js is not up to date.
Standard library only.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

VERSION_RE = re.compile(r"^const VERSION = '[^'\n]*';[ \t]*$", re.M)
PRECACHE_RE = re.compile(r"^const PRECACHE = \[\n.*?^\];[ \t]*$", re.M | re.S)
HASH_LEN = 10


def fail(msg):
    print('stamp-sw: ' + msg, file=sys.stderr)
    sys.exit(2)


def precache_list(root):
    data = json.loads((root / 'tools' / 'asset-list.json').read_text(encoding='utf-8'))
    entries = data.get('precache')
    if not isinstance(entries, list) or not entries:
        fail('tools/asset-list.json has no "precache" list')
    return entries


def render_precache(entries):
    body = ',\n'.join("  '%s'" % e for e in entries)
    return 'const PRECACHE = [\n' + body + '\n];'


def file_for(entry):
    """Map a precache URL path to the file on disk (relative to the site root)."""
    rel = entry[2:] if entry.startswith('./') else entry.lstrip('/')
    if rel == '' or rel.endswith('/'):
        rel += 'index.html'
    return rel


def compute_version(root, entries, sw_text):
    h = hashlib.sha256()
    seen = set()
    for entry in entries:
        rel = file_for(entry)
        if rel in seen:          # "./" and "./index.html" are the same file
            continue
        seen.add(rel)
        path = root / rel
        if not path.is_file():
            fail('precached file is missing: %s (from %s)' % (rel, entry))
        h.update(rel.encode('utf-8') + b'\0')
        h.update(path.read_bytes())
        h.update(b'\0')
    neutral = VERSION_RE.sub("const VERSION = '';", sw_text, count=1)
    h.update(b'sw.js\0' + neutral.encode('utf-8'))
    return h.hexdigest()[:HASH_LEN]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--check', action='store_true',
                    help='exit 1 if sw.js is stale; change nothing')
    ap.add_argument('--root', default=str(Path(__file__).resolve().parent.parent),
                    help='site root (default: this repo)')
    args = ap.parse_args()

    root = Path(args.root).resolve()
    sw_path = root / 'sw.js'
    if not sw_path.is_file():
        fail('no sw.js in ' + str(root))
    original = sw_path.read_text(encoding='utf-8')

    if len(VERSION_RE.findall(original)) != 1:
        fail("sw.js must contain exactly one line like: const VERSION = '...';")
    if len(PRECACHE_RE.findall(original)) != 1:
        fail('sw.js must contain exactly one "const PRECACHE = [ ... ];" block')

    entries = precache_list(root)
    text = PRECACHE_RE.sub(lambda _m: render_precache(entries), original, count=1)
    version = compute_version(root, entries, text)
    text = VERSION_RE.sub(lambda _m: "const VERSION = '%s';" % version, text, count=1)

    current = re.search(r"^const VERSION = '([^'\n]*)';", original, re.M).group(1)
    if args.check:
        if text != original:
            what = 'PRECACHE list and VERSION' if PRECACHE_RE.search(original).group(0) != render_precache(entries) else 'VERSION'
            print("stamp-sw: sw.js is out of date (%s). VERSION is '%s', should be '%s'.\n"
                  "Run: python3 tools/stamp-sw.py" % (what, current, version), file=sys.stderr)
            sys.exit(1)
        print("stamp-sw: sw.js is up to date (VERSION '%s')" % version)
        return

    if text == original:
        print("stamp-sw: no change (VERSION '%s')" % version)
        return
    sw_path.write_text(text, encoding='utf-8')
    print("stamp-sw: VERSION '%s' -> '%s'" % (current, version))


if __name__ == '__main__':
    main()
