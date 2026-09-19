# Next session — starter prompt

Paste the block below into a fresh Claude Code context. It is self-contained;
the detail lives in `DEV_NOTES.md`, which the new session should read first.

---

I'm working on a three.js + cannon-es castle destruction game at
`D:\Portable Repo\castle-destruction-game`. The whole game is one ~1 MB file,
`src/main.js`.

**Read `DEV_NOTES.md` in the repo root before doing anything.** It documents a
previous session's work — physics performance, town scenery, NPC traversal and
a water-mode system — including the reasoning behind constants that look
arbitrary, and several traps in this project's build workflow.

## Hard constraints

- **Keep everything on the `D:` drive.** No files written to `C:` (that
  includes temp/scratch directories). Reading tools installed on C: is fine.
- **Do not use git** for changes — no commits, no branches, no stashes. Working
  directly on disk is intended; the copy is backed up elsewhere. Read-only
  `git log` for archaeology is fine, but note the entire history is one
  squashed commit so there is nothing to diff against.
- **There is no Node runtime on this machine.** `npm run dev` / `npm run build`
  do not work. Build with the native esbuild binary and regenerate the HTML
  with the Python helper — exact commands are in `DEV_NOTES.md` §1. Three traps
  there will bite you if you skip it: the mandatory `import.meta.env` define,
  never minifying with esbuild, and `dist/index.html` being a build artifact.
- Test at `http://127.0.0.1:8777/index.html` (loopback-only Python static
  server from `dist/`), `?perfdebug=1` for the perf overlay.

## Verification discipline

I can't run a browser from the agent side, so **"it builds" proves nothing**.
Three separate boot failures last session all presented identically as "the
game won't start / no difficulty cards", which is what a module-level throw
looks like. Before declaring anything done:

- Check **bundle ordering** for module-scope changes, not just that it
  compiles. esbuild lowers top-level `const` to `var`, so a temporal-dead-zone
  bug shows up as `Cannot read properties of undefined` rather than a clear TDZ
  error. See `DEV_NOTES.md` §2 for the grep.
- The on-page boot-error banner (`showBootError`) is deliberate — leave it in.
- Where a change can be checked by arithmetic or simulation rather than by eye,
  do that and show me the numbers.
- Tell me plainly what you have and haven't verified.

## Work to do, in priority order

**1. Rendering is the bottleneck — this is the big one.**
At rest on the castle: `render 24.7 ms` vs `phys 1.3 ms`, giving 29.6 fps
standing still looking at a fully-asleep scene. That's 19:1, and no physics
work can touch it. It also costs double elsewhere: at ~30 fps cannon runs its
1/60 step twice per frame, so fixing rendering halves physics cost for free.

Start by having me run `window._townProbe.renderInfo()` at rest on the castle —
it reports draw calls and triangles off `renderer.info` and will tell us
whether to attack draw calls, geometry volume, shadows, or overdraw. Diagnose
before changing anything.

**2. Make the structural scans level-aware.**
`src/main.js` ~line 20761 hardcodes `getStoryRoleBricks('castle')`, so town
masonry is never support-scanned and can be left floating in mid-air when you
shoot out a lower course. The fix is small (`DEV_NOTES.md` §8), but it adds
scan work to the town, which is currently the cheapest level — so measure the
town with `?perfdebug=1` before and after.

**3. Puddle-scale ripples.**
The interactive ripple heightfield is 0.375 m per cell over a fixed 192 m
square. Good on the moat and river; a town puddle is 1–3 m across so it wobbles
as a whole instead of showing rings. Options are higher resolution, or
shrinking the field and recentring it on the player — the latter needs the
buffer contents shifted or ripples appear to slide with the camera.

**4. Give Refraction mode some distortion.**
three's `Refractor` has no dudv or normal input, so water mode 2 is a flat
tinted window. Patching its fragment shader to offset `vUv` by the ripple
normal map would make "muddy water you see through" work — arguably the most
physically right look for the town puddles.

**5. Low priority.** A one-off unexplained 10 ms `phys` reading with zero awake
bodies, never reproduced. Only chase it if it reappears.

## Before this ships

The current `dist/` bundle is unminified esbuild output, produced as a
workaround for having no Node. Rebuild with `npm run build` on a machine with
Node so it goes through terser — `vite.config.js` documents a production-only
TDZ crash with esbuild minification.
