#!/usr/bin/env python
"""Regenerate dist/index.html from the source index.html.

This reproduces exactly what `vite build` does to the HTML, so the dist copy can
be refreshed on a machine with no Node installed (the bundle itself is built
with the native esbuild binary in node_modules/@esbuild/win32-x64/).

The transform, verified by diffing a real vite build against the source:
  1. strip the UTF-8 BOM
  2. ./manifest.webmanifest  ->  ./assets/manifest.webmanifest
  3. drop the dev module tag  <script type="module" src="/src/main.js">
  4. insert <script type="module" crossorigin src="./assets/game.js"> just
     before </head>

Run from the repo root:  python scripts/make-dist-html.py
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'index.html')
DST = os.path.join(ROOT, 'dist', 'index.html')

DEV_TAG = '<script type="module" src="/src/main.js"></script>'
BUILT_TAG = '  <script type="module" crossorigin src="./assets/game.js"></script>'

with io.open(SRC, encoding='utf-8-sig') as fh:          # utf-8-sig strips the BOM
    html = fh.read()

html = html.replace('./manifest.webmanifest', './assets/manifest.webmanifest')

lines = [ln for ln in html.split('\n') if DEV_TAG not in ln]

try:
    head_close = next(i for i, ln in enumerate(lines) if '</head>' in ln)
except StopIteration:
    sys.exit('make-dist-html: no </head> found in index.html')
lines.insert(head_close, BUILT_TAG)

with io.open(DST, 'w', encoding='utf-8', newline='') as fh:
    fh.write('\n'.join(lines))

print('wrote %s (%d bytes)' % (DST, os.path.getsize(DST)))
