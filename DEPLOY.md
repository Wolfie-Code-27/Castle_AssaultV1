# Deploying to the web

The short version: **build on a machine with Node, upload the whole of `dist/`.**

The `dist/` folder on the dev PC is produced by a no-Node workaround (a raw
esbuild bundle, unminified, ~2.1 MB). It runs, but it is twice the download and
it has never been through the pipeline the project is actually configured for.
Do not upload it.

---

## 1. What to copy to the Node machine

Everything except `node_modules/`, `dist/` and `baselines/` — all three are
either regenerated or local-only.

```
src/            index.html
public/         manifest.webmanifest
scripts/        package.json
vite.config.js  package-lock.json
DEPLOY.md       DEV_NOTES.md
```

> `public/audio/` is **7.5 MB of sound effects and is essential**. Vite copies
> it into `dist/` at build time. It is easy to skip because it is large and
> nothing in `src/` imports it — the paths are built at runtime by `sfxPath()`.

## 2. Build

```sh
npm ci            # npm install also fine; ci is reproducible
npm run build
```

`vite.config.js` pins three things that matter, so do not pass extra flags:

- **`minify: 'terser'`** — esbuild minification causes a production-only TDZ
  runtime crash on this bundle. Never "helpfully" switch it to esbuild, and
  never add `--minify` to the raw esbuild command in DEV_NOTES §1 either.
- **`base: './'`** — every emitted path is relative, so the site works at a web
  root *or* in a subfolder (`/castle/`) with no changes.
- **Stable output names** (`assets/game.js`, not `assets/index-a1b2c3.js`) —
  chosen so a partial FTP upload or a stale cache cannot break module loading
  through a hash mismatch.

Expected output, about 9 MB total:

```
dist/index.html
dist/assets/game.js               ~1 MB terser-minified
dist/assets/manifest.webmanifest
dist/audio/sfx/…                  ~7.5 MB
```

## 3. Check the build before uploading

This is worth the two minutes: the **terser-minified bundle is the one
combination nobody has ever run.** All local testing has been against the
unminified esbuild output.

```sh
npm run preview     # serves dist/ on http://localhost:4173
```

Open it and confirm:

- [ ] The difficulty cards appear. If the menu renders but the cards do not,
      that is a module-level throw — the red `showBootError` banner at the top
      of the page will have the message. See DEV_NOTES §2.
- [ ] Console is clean on load.
- [ ] Sound works (proves `audio/` copied and `sfxPath()` resolved).
- [ ] Start a round and fire something.

## 4. Upload

Upload the **contents** of `dist/` to the web root (or a subfolder):

```
index.html
assets/game.js
assets/manifest.webmanifest
audio/                 ← the whole tree
```

For GitHub Pages there is already a script:

```sh
npm run deploy         # vite build && npx gh-pages -d dist
```

---

## Optional: stop hotlinking Wikimedia

The Wilhelm scream is fetched from Wikimedia Commons at page load. It is public
domain and it fails silently to a synthesised fallback, but a public page should
not depend on someone else's bandwidth.

The loader already tries a **self-hosted copy first**, so this is a drop-in with
no code change — just put the file here before building:

```sh
curl -L -o public/audio/sfx/wilhelm_scream.ogg \
  https://upload.wikimedia.org/wikipedia/commons/d/d9/Wilhelm_Scream.ogg
```

If the file is absent the remote fetch still happens exactly as before.

---

## Gotchas that have actually caused problems

- **`npm run build` does not empty `dist/`.** Vite leaves files it did not
  write. Anything you drop in there — old bundles, A/B baseline pages — will be
  uploaded. The baselines used to live in `dist/` for exactly this reason and
  were moved to `baselines/` on 2026-08-17; see `baselines/README.md`.
- **`dist/` is in `.gitignore`**, so it will not travel via git. Copy it by
  hand, or just rebuild on the target machine (preferred).
- **Hard-reload after uploading.** Stable filenames mean no cache-busting hash,
  which is deliberate, but it does mean browsers will happily serve the old
  `assets/game.js`. Ctrl+Shift+R, and tell testers to do the same.
- **Test over HTTP, never `file://`.** The bundle is an ES module and the audio
  is fetched, both of which are blocked by the file:// origin rules.
