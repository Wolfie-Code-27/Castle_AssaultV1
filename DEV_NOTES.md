# Dev Notes — August 2026 session

Work log for the physics-performance, town-scenery, NPC-traversal and water
passes. Everything here is in `src/main.js` unless stated otherwise.

Line numbers drift as the file changes — search for the named constant or
function instead. All names below are real identifiers in the source.

---

## 1. Build & run on this machine (no Node installed)

There is **no Node runtime on this PC**, so `npm run dev` / `npm run build`
cannot be used. The workflow that does work:

```sh
# 1. bundle (native esbuild binary, no Node required)
./node_modules/@esbuild/win32-x64/esbuild.exe src/main.js \
    --bundle --format=esm --target=es2020 \
    --define:import.meta.env.BASE_URL='"./"' \
    --outfile=dist/assets/game.js

# 2. only if index.html changed — regenerate the built HTML
python scripts/make-dist-html.py

# 3. serve (loopback only)
cd dist && python -m http.server 8777 --bind 127.0.0.1
#   -> http://127.0.0.1:8777/index.html
#   -> add ?perfdebug=1 for the perf overlay
```

### Three traps in that workflow

1. **`--define:import.meta.env.BASE_URL`** is mandatory. Vite substitutes this
   at build time; esbuild does not. `sfxPath()` uses it, and without the define
   it is live at runtime and throws. This caused a full boot failure once.

2. **Do not minify with esbuild.** `vite.config.js` explicitly uses terser
   because *"esbuild minification is causing a production-only TDZ runtime
   crash"*. The unminified bundle is ~2 MB vs ~1 MB; fine for local testing.

3. **`dist/index.html` is a build artifact.** Editing the root `index.html`
   alone changes nothing in the browser. `scripts/make-dist-html.py` reproduces
   vite's HTML transform (strip BOM, rewrite the manifest path, drop the
   `/src/main.js` dev tag, inject `./assets/game.js` before `</head>`) — it was
   verified by diffing against a real vite build.

Before shipping, rebuild properly with `npm run build` on a machine that has
Node, so the output goes through terser rather than this workaround.
**`DEPLOY.md` is the checklist for that** — what to copy, what to verify, and
the traps that have actually caused problems.

### Backups kept on the drive

**Moved out of `dist/` on 2026-08-17** — they now live in `baselines/`, because
`dist/` is what gets uploaded to the web and four megabytes of old bundles were
riding along with it. `baselines/README.md` has the full table and the copy-back
recipe.

`orig.html` is the pre-fix baseline; same test on both URLs is a true A/B. To
run one, copy the page **and its bundle** back into `dist/` (they reference
`./assets/game-*.js`, so both halves must sit in the served root), then delete
them again before building for deploy.

> `npm run build` does **not** empty `dist/`. Vite leaves files it did not
> write, so anything parked there gets deployed. See `DEPLOY.md`.

---

## 2. Boot diagnostics (keep these)

An error thrown while `main.js` is evaluating aborts the rest of the file
silently. The menu renders (it is static HTML) but the difficulty cards never
appear, because `renderDifficultyCards()` runs near the bottom of the same
script. The symptom is always **"the game won't start / no difficulty cards"**,
and it gives no clue as to the cause.

`showBootError()` near the top of `main.js` mirrors any uncaught error onto a
red banner at the top of the page, hooked to both `error` and
`unhandledrejection`. It only renders when something actually throws. It found
a bug in one round trip that three rounds of static analysis had missed.

**This class of bug bit three times.** When touching module-scope code, check
bundle *ordering*, not just that it compiles:

```sh
grep -n "^var waterSurfaceRegistry" dist/assets/game.js
grep -n "addStoryBridgeVisualWaterCap(castleMoatWaterGeo" dist/assets/game.js
# the declaration line number MUST be smaller than the use
```

> **esbuild lowers top-level `const` to `var`.** A `const` used too early gives
> a clear `Cannot access 'X' before initialization`. Once lowered to `var` you
> get `undefined` instead, so a temporal-dead-zone bug disguises itself as a
> null property access. Do not trust the error message's shape here.

---

## 3. Physics performance

### The original complaint

"One shot and the framerate tanks on every level except the town — even with
the shotgun." The town uses a comparable number of bricks, so it was assumed
brick count was not the cause.

### What was actually happening

The town does **not** use static geometry — `buildTownHouse` uses the same
dynamic `mass: 120` builders as the castle. `townStaticBox` (mass 0) is only
used for six pieces of decor. So the premise was right: comparable dynamic
brick counts.

The real difference was a hardcoded role. `getStoryRoleBricks('castle')` feeds
three expensive post-step passes, so **the town never ran any of them**:

1. **Unsupported-brick scan** — every 10 frames, support-probes every sleeping
   brick and wakes any that fail.
2. **Lintel drop check** — was `O(lintels × all bricks)` with no spatial
   pruning, in the same pass.
3. **Cluster topple scan** — union-find every 30 frames, wakes whole clusters.

All three are gated on `_frameCount - _lastDisturbFrame < window`, and
`_lastDisturbFrame` is refreshed on **every frame any brick is awake**. That
closes a self-sustaining loop:

> shot → bricks wake → gate re-arms → scans run → scans wake more bricks →
> bricks stay awake → repeat

It does not decay after the window; it re-arms itself continuously.

### Fixes applied

| Fix | Detail |
| --- | --- |
| **Cascade fix** (biggest) | The support test treated *any awake brick* as absent, so one woken brick invalidated its neighbours' support and the front unzipped through the structure every tick. Now a supporter only stops counting once **displaced >0.35 m from its build slot** — the same rule the lintel check already used. A genuinely falling brick clears that in a tick or two, so chain-float is still caught. |
| **Wake budget** | `SUPPORT_WAKE_BUDGET` = 48 desktop / 12 mobile. The bridge pass already had one. |
| **Lintel loop** | Now uses the existing spatial hash instead of walking every brick per lintel, plus a short-circuit. |
| **Wake propagation** | Was a full sleeping × moving cross product; the budget counted *wakes*, not iterations, so a frame with few qualifying bricks walked the entire product. Added `PROP_PAIR_BUDGET` and `_WAKE_PROP_MAX_PTS`. Also `getWaterSurfaceYAtXZ` was called for **every sleeping brick every prop frame** — now only for ones about to be woken. |
| **Skip inactive levels** | `castleScanIsActive` — the scans no longer walk the castle list while the town owns the frame. |
| **Adaptive solver** | `world.solver.iterations`: 20 → 14 above 120 awake, → 10 above 320. |

### Measured results

Castle, Explosive, Power 40:

| | at rest | full wall collapse |
| --- | --- | --- |
| fps | 29.6 | **29.4** |
| frame | 33.0 ms | 34.0 ms |
| **phys** | **1.3 ms** | **12.9 ms** |
| render | 24.7 ms | 14.7 ms |
| awake / dynAwake | 0 / 0 | 164 / 179 |
| contacts | 0 | 284 |

Worst single frame at impact: 45.4 ms (22 fps), and it recovered. The "tanks
and stays tanked" behaviour is gone.

### ⚠️ The real bottleneck is now RENDERING

At rest: **render 24.7 ms vs phys 1.3 ms**. Nineteen to one, at 29.6 fps
standing still looking at a fully-asleep castle. No physics work can touch
this.

Two consequences:

- `substeps 2.00/frame` — at ~30 fps, cannon runs the 1/60 step **twice per
  frame**. Physics cost is doubled purely because the framerate is low. Fix
  rendering and physics halves for free.
- Render was 24.7 ms at distance vs 6.6 ms up against a wall, so it is
  draw-call / geometry bound when the whole castle is in frustum.

**Next step:** run `window._townProbe.renderInfo()` at rest on the castle. It
reports draw calls and triangles off `renderer.info`, which decides whether to
attack draw calls, geometry volume, or shadows.

### Perf overlay notes

- `perfDebugMarkPhysics` wraps **only `world.step`**. The scan work above is
  outside it. So `phys` high = solver; `frame` high with `phys` flat = scans.
- **The `contacts` counter never worked.** It read
  `world.narrowphase.contactEquations`, which does not exist in cannon-es 0.20
  (the identifier appears zero times in the library). Contacts live on
  `world.contacts`. Fixed — every `contacts 0` in older screenshots is
  meaningless.
- Added `substeps/frame` and `pairs` counters to the broadphase line.
- `pairs 0` at rest confirms the SAP broadphase correctly rejects
  sleeping/sleeping pairs. An unexplained 10 ms `phys` spike seen once did not
  reproduce; suspected shotgun pellets, not structural.

---

## 4. Town scenery

`buildTownFoliage()` and `buildTownPuddles()`, called from
`buildTownEncounter()`. Reuses the editor decor materials (`_getEdTreeMats`,
`_getEdShrubMats`) so new pieces match the existing collection.

- `townSpotBlocked(x, z, clearance)` keeps scenery out of the road corridor,
  house footprints (treated as circles of their half-diagonal, since houses are
  yawed), the tavern, and the player spawn.
- Yields, stable across 30 seeds: 22 belt trees, ~5 gap trees, ~40 verge
  shrubs, 26 outer shrubs.
- **All batched into instanced meshes.** As loose `Group`s those ~93 pieces
  would have cost ~250 draw calls; batched it is 7 for foliage + 1 for puddles.
  Zero physics bodies.
- Instanced batches **must** call `computeBoundingSphere()` after filling
  matrices, or the frustum test uses the origin-centred geometry sphere and the
  whole batch pops out of view.

Puddle outlines come from `makePuddleShape()` — two out-of-phase sine lobes on
the radius, so none read as stamped circles. `PUDDLE_WOBBLE_MAX = 1.6` inflates
the spacing tests, because overlapping coplanar triangles in one merged mesh
z-fight.

---

## 5. Town NPCs — emerging from houses

`buildTownHouse` emits two extra points per door alongside the street post: an
interior standing spot and the doorway gap. Sentries spawn **inside**, dormant
(`setNpcStoryDormant`) so they are invisible, collision-free and unshootable
through walls.

`updateTownDoorEmergence()` wakes them when the player comes within
`TOWN_EMERGE_R2` (17 m) of a door post; they walk the two-point door path then
fall through to normal chase behaviour. Staggered `walkDelay`, occasional shout
via `tryNpcTaunt` (self-limiting).

- **17 m is not arbitrary.** The two "gable to the street" houses put their door
  post ~11.5–12 m off the road centre, versus 6–8 m for road-facing ones. A
  tighter radius leaves those two houses permanently shut.
- `_townEmergeArmedAt` gives a 900 ms grace so the house nearest the spawn does
  not burst open on frame one.
- `npc.townEmerging` bypasses the solid push while a sentry clears the door
  frame, so it cannot snag a jamb.

### The doorway was physically too small

`createPlank(x, 1.62, …)` with `PS.h = 0.75` hung the door lintel from y=1.995
down to **y=1.245**. A standing NPC is **2.0 m** to the helmet top. They could
never fit — they wedged in the opening.

The plank was replaced with two visual-only timber jambs. The masonry course
above the opening (underside y=2.0) is the lintel now, leaving the full 2 m
clear. **Clearance is exact (2.0 vs 2.0)** — if heads clip the brick, nudge
`NPC_HEAD_CLEAR_Y` or drop the helmet slightly.

---

## 6. NPC rubble traversal

### Why they floated instead of climbing

`npcGroundY()` had **no awareness of bricks at all** — drawbridge, trench, moat,
water, then `return 0`. Debris was not in its model of the world.

So the only thing raising an NPC onto rubble was `liftTargetY` inside
`resolveNpcSolidCollision`, and the ground snap fought it: collision lifted
them, the climb block saw `np.y > 0` and applied gravity. Hence knights
hovering over rubble piles.

Second half: `NPC_MAX_STEP_UP` was **0.32** while a brick course is **1.0**
tall. Even with correct ground sampling they could not mount one course, and
exceeding the limit did `np.x = prevX` — cancelling forward motion permanently.

There is no earlier version to restore; the whole repo history is one squashed
commit (`da4e446`), and `npcGroundY` never had rubble sampling in it.

### What was built

A coarse 2D max-height field over **settled** masonry, rebuilt every 8 frames,
so the per-walker lookup is O(1). `RUBBLE_CELL = 1.0`, `RUBBLE_HALF = 128`
(~256 KB).

Three details that matter:

- **Only settled bricks are stamped** (`sleepState === 2`). A tumbling brick
  would teleport a walker upward and drop them a frame later.
- **Cells above `NPC_MAX_RUBBLE_STAND_Y` (4.0 m) are rejected as walls.** The
  field stores each cell's *true* max including over-tall bricks, so an intact
  wall's footprint reads as wall height and is refused — even though its bottom
  course is only 1 m. This is what stops knights walking up a 12-course curtain
  wall one course at a time.
- **Rubble only ever raises the surface** (`withRubble`), never lowers it. A
  plain `Math.max` would break the drained moat, whose floor is below y=0.

### Climb tuning

| Constant | Value | Purpose |
| --- | --- | --- |
| `NPC_MAX_STEP_UP` | 1.15 | A brick course is 1.0 — must exceed it |
| `NPC_CLIMB_RATE` | 0.85 m/s | ~1.2 s per course: a scramble, not a hop |
| `NPC_CLIMB_ADVANCE` | 0.35 | Ground speed kept while mounting |
| `NPC_CLAMBER_COMMIT_SEC` | 0.65 | Scrabble time before committing to a haul-up |
| `NPC_CLAMBER_RATE` | 1.10 m/s | The committed haul-up |

Faces too steep for one step get 0.65 s of scrabbling, then a committed
haul-up, so nobody parks at a rubble face forever. The 4 m cell cap means that
can never become wall-scaling. **The 0.65 s commit is deliberately shorter than
the existing 1.25 s stuck-recovery**, so the two do not fight.

### Also fixed: overhead clearance

`resolveNpcSolidCollision` gated bricks by centre-height then did a **purely 2D
push with no vertical overlap test**. Any brick spanning a doorway was a solid
wall at ground level. Bricks whose underside clears `NPC_HEAD_CLEAR_Y` (1.95)
are now walked under. This affected the castle gate too, not just the town.

---

## 7. Water

### Mode system

`Settings → Water Effects → Mode` existed in `index.html` but was **never wired
up** — `setWaterMode` had zero references. It now selects between:

| Mode | Implementation | Notes |
| --- | --- | --- |
| 0 Reflective | three.js `Water` | The original look |
| **1 Interactive ripples** | `Water` + live heightfield | **Default** |
| 2 Refraction | `Refractor` | See §"Refractor has no distortion" |
| 3 Flow map | `Water2` | Most expensive — builds a Reflector **and** a Refractor internally |
| 4 Sharp mirror | `Reflector` | Reference view for telling distortion apart from resolution artefacts |

Every surface is built through `addWaterSurface()` and recorded in
`waterSurfaceRegistry`, so changing mode rebuilds moat, river and puddles in
place. A mode that fails to construct falls back to Reflective with a console
warning rather than leaving you with no water.

> **Changing the default mode needs TWO edits.**
> `applyWaterFxFromSettingsUi()` reads the `<select>` *before* writing runtime
> state back to it, so the DOM value wins at boot. Set `waterSurfaceMode` **and**
> the `selected` attribute on the matching `<option>`, or the runtime default is
> silently overridden.

`Water2` defaults to loading `textures/water/*.jpg` from disk, which this
project does not ship — pass `normalMap0` / `normalMap1` explicitly or it 404s
and renders untextured.

**Refractor has no distortion.** Its shader only has `color` / `tDiffuse` /
`textureMatrix` — no dudv or normal input. Mode 2 is a flat tinted window, not
water. Kept as a reference because it cannot visually detach. Making it good
means patching its fragment shader to offset `vUv` by a normal map — the same
trick the ripple mode uses.

### Interactive ripple heightfield

Ping-pong wave-equation solver on two half-float render targets: height in `.r`,
previous height in `.g`, damped, border zeroed so waves die instead of wrapping.
Differentiated into a normal map and fed to the water. World-anchored over a
fixed 192 m square so ripples line up across surfaces.

**Driven by impacts only** — cannonballs, falling masonry, ragdolls, the player.
All of these already funnelled through `spawnWaterImpactRipple()`. The drop is
queued **above** that function's guards, so it is not gated by the "Impact
Ripples" checkbox (which governs the ring decals), an empty ring pool, or the
shore-clearance rejections.

An earlier version also rippled where the aim swept across the surface. Removed
deliberately: water reacting to a camera pan reads as wrong once impacts are
doing the work. To restore, project the camera ray onto the surface plane and
call `queueRippleDrop()` at the intersection.

three's `getNoise` blends **four time-scrolled samples** of the normal map,
which turns crisp ripples to mush — so the mode patches `getNoise` down to a
single lookup and sets `size = 1.0` (making the shader's uv equal world metres,
which is what the sim mapping assumes). If the regex fails to match a future
three version it warns and falls back to static normals.

### Ripple tuning — the important bit

| Setting | Range | Default |
| --- | --- | --- |
| Wave Speed | 0.40–4.00 m/s | 1.20 |
| Ripple Life | 1.0–8.0 s | 3.0 |
| Reach (read-only) | speed × life | ~3.6 m |

**Reach is the number that matters.** Below roughly 1 m the disturbance never
gets clear of the drop that made it, and you get a blob oscillating in place
rather than a travelling ring. This was a real bug in the first version: the
speed slider went down to 0.10 m/s (reach 0.29 m) and the decay slider down to
0.960 (reach 0.34 m), either of which produced a wobbling circle — and it
persisted to localStorage, so it stayed broken across reloads.

Fixes: speed floor raised to 0.40; the opaque "Wave Decay 0.996" replaced with
"Ripple Life" in seconds; reach surfaced in the UI so the consequence of both
sliders is visible while dragging.

Impact drop radius is `0.45 + speed × 0.018` m, capped at 1.45 — deliberately
well under the reach, or the disturbance is as wide as the distance it travels.

Suggested: big open water (bridge river) likes ~2.0 m/s and ~4 s (≈8 m reach);
small town puddles want slower and shorter.

### Other water fixes

- **The puddle reflection looked detached from the scene when moving.** `Water`
  samples its reflection buffer in **screen space**, so a small buffer does not
  mean "small on screen", it means undersampled. A flat 256×256 was ~8× under at
  1080p. Now scaled to the viewport like the big bodies. `distortionScale` also
  dropped from 0.8 to 0.30 to match.
- Puddles use **one merged geometry driving a single `Water`**. `Water` runs a
  planar reflection pass *per instance*, so ~20 separate pools would have meant
  ~20 extra scene renders a frame.
- The puddle surface deliberately does **not** join
  `bridgeLibraryWaterSurfaces` — that array is swept by the bridge suppression
  passes, which would hide the puddles the moment the town stage took the frame.
  It is wired separately into the time-uniform update, `setWaterFxEnabled` and
  `setTownSuppressed`.
- `waterMouseRipple` is still accumulated on mouse drag and read by nothing. It
  predates this work.

### ⚠️ Water cost

`Water`, `Water2`, `Reflector` and `Refractor` all re-render the scene. Mode 3
does it twice. This is the most expensive thing added, in a level that was
otherwise cheap. It is on the Settings water-FX toggle, so it can be A/B'd
directly with `?perfdebug=1` — watch `render`.

---

## 8a. Render diagnostics (added this session, not yet run)

`renderer.shadowMap.autoUpdate = false` near the renderer setup is currently a
no-op: the frame loop sets `renderer.shadowMap.needsUpdate = true`
**unconditionally every frame**, so the 2048² PCFSoft map is fully re-rendered
each frame over a fixed 240 m ortho box that never follows the player. Prime
suspect for the 24.7 ms, but unconfirmed.

> **Every draw-call number read from this game before now was wrong.**
> `renderer.info.autoReset` defaults to true and `WebGLRenderer.render()` calls
> `info.reset()` at its start. `Water`/`Reflector`/`Refractor`/the ripple sim all
> call `renderer.render()` recursively from `onBeforeRender`, so a nested pass
> wipes the counters mid-frame and what you read afterwards is only the tail of
> the frame. Everything below captures with `autoReset` switched off.

Three console probes, diagnostics only:

| Probe | What it gives |
| --- | --- |
| `_townProbe.renderInfo()` | calls/triangles split into **shadow pass vs main pass**, drawing-buffer size and megapixels, pixel-ratio state, shadow config, light/program/geometry/texture counts, water surfaces and mode |
| `_townProbe.renderAudit()` | scene-graph census: what the frame *would* cost with no culling, aggregated so 400 unnamed decor meshes are one row |
| `_townProbe.renderAB()` | the experiment. Baseline plus ~16 variants, **CPU submission time and GPU time reported separately** via `gl.finish()`. Variants: shadow map cached vs re-rendered, sun shadow off, pixel ratio ×0.5 / ×0.25, water hidden, fog off, envmap off, everything hidden, and the 8 heaviest scene groups hidden one at a time. Freezes the tab ~20 s; every variant restores its own state |

`cpu >> gpu` means draw-call / scene-graph bound; `gpu >> cpu` means fill-rate
or shader bound. That single comparison decides the whole optimisation strategy.

Also added: a **`scan` field in the perf overlay** — ms/frame, tick count,
bricks walked per tick, and which role's list was scanned. The structural scans
run *outside* `perfDebugMarkPhysics`, so before this they were only visible as
"frame high while phys flat". On the town it reads `town:SKIPPED`, which is the
§8 hardcoded-role bug showing itself.

---

## 9. Karate chop (melee) + Modern Warfare airdrops

Modern Warfare now deploys you with **only** a karate chop, unlimited, and
delivers every other weapon by parachute from an AC-130.

### Weapon slots 9 and 10

Adding a weapon touches more tables than you would guess. All of these must stay
the same length or the UI and the ammo logic drift apart: `WEAPONS`,
`WEAPON_ICONS`, `WEAPON_SPEED_RANGES`, `AMMO_START`, every
`DIFFICULTIES[*].ammo`, and a `wBtnN` div in `index.html`.

> **The weapon bar binds its click handlers once, by DOM index.** So a new
> weapon needs its button to exist, and hiding an unowned weapon must use
> `display:none` — removing the node would shift every later weapon's index by
> one and the buttons would fire the wrong weapon.

### The bar lists what you have, not the catalogue

`updateUI()` hides any slot both players are empty on, mirroring the skip rule
in `setWeapon()`/`nextSelectableWeapon()` exactly (in two-player mode a slot
counts as owned while *either* player has rounds). The currently selected weapon
stays listed even at zero, so firing your last round does not make the slot you
are holding vanish. In Modern Warfare this means the bar opens as just the two
melees and grows as crates are recovered.

**Unlimited ammo is `Infinity`, deliberately.** It is never `=== 0`, so the
skip logic in `setWeapon()` and `nextSelectableWeapon()` treats the slot as
always available with no special case. `ammoText()` renders it as `∞`;
without that the HUD reads `×Infinity`.

> **Consequence: Modern Warfare had to become `killWin: true`.** The default end
> condition is `p1Ammo.every(a => a === 0)`, which can never be true once a slot
> holds Infinity. The mode now ends when the last defender falls, exactly as
> Extreme Destruction already did. Extreme also gained the chop (it advertises
> "every weapon") and was already killWin, so nothing changed there.

### Two strikes on one machine

There are two melee weapons — **karate chop** (slot 9) and **mae geri**, a front
snap kick (slot 10). They share one state machine (`updateMelee`) and one impact
resolver (`meleeStrikeImpact`); everything that differs lives in `MELEE_KARATE`
and `MELEE_MAEGERI` up with the viewmodels. Adding a third strike is a data
change.

A swing is a **list of phases**, each easing the rig from one named pose to the
next, with exactly one phase flagged `strike:` carrying the impact frame:

| | phases | cycle | rate |
| --- | --- | --- | --- |
| Karate chop | cock → **hit** → home | 0.68 s + 0.10 | 1.28 /s |
| Mae geri | chamber → **snap** → chamber → stance | 0.72 s + 0.16 | 1.14 /s |

The mae geri's second chamber is the point: **a kick that just drops to the
floor afterwards reads as a punt.** Re-chambering before setting down is what
makes it a technique.

Reach envelopes, with the camera at `PLAYER_BASE_Y` = 2.2:

| | level pitch | down 30° | wall courses |
| --- | --- | --- | --- |
| Chop (reach 2.35, r 1.55, drop 0.35) | 0.41 – 4.29 m | 0.00 – 4.10 m | 0, 1, 2 |
| Mae geri (reach 2.90, r 1.30, drop 0.55) | 1.15 – 4.65 m | 0.87 – 4.15 m | 0, 1, 2 |

The kick reaches ~0.4 m further but has a real **minimum range** — you cannot
kick someone who is hugging you, which is the chop's job.

Brick impulse is 5200 Ns for the chop and 3400 for the kick, against 120 kg
bricks, clamped to the same 12 m/s ceiling `triggerBlast` uses so a strike can
never pump energy into a cascade. The chop biases downward (`brickDownBias`
0.22) and cuts through courses; the kick biases slightly *up* (−0.06) and throws
them further.

### Comedy launches and the combo

Every connect increments `meleeComboCount`, which expires after 2.6 s and
survives switching between the two melees — so chop → chop → mae geri is one
string. The combo feeds the launch:

| | fresh hit | after a 3-hit string |
| --- | --- | --- |
| Chop | 70 Ns up | 148 Ns |
| Mae geri | 250 Ns up | **535 Ns** |

### ⚠️ Per-limb random spin does nothing. Spin the ragdoll as a rigid body.

The first version of the launch set a **random `angularVelocity` on each part**
and it looked feeble. The reason is not tuning:

> The ragdoll parts are joined by cannon **constraints**. Giving each limb its
> own angular velocity, and touching nothing else, hands the solver a pile of
> mutually contradictory motions — so it cancels them within a step or two.
> Net whole-body rotation contributed: **zero**. Every limb just twisted in
> place against its own joint.

`applyRagdollSpin()` treats the ragdoll as one rigid body instead. Every part
gets the *same* angular velocity about a common axis through the ragdoll's
centre, **plus the tangential linear velocity that rotation implies at its own
offset** (`v += ω × r`). That second half is the bit that was missing. Checked
numerically: the separation rate between any two parts is ~1e-16 m/s, i.e. the
motion is rigid to floating-point precision, so the constraints have nothing to
fight and the whole body helicopters away intact.

The axis is horizontal and perpendicular to the strike (so the body somersaults
*away* from the player) with a little yaw mixed in so it corkscrews rather than
cartwheeling in a flat plane. A small per-limb jitter is added on top so the
limbs still flail. `npcSpinDamp` then loosens the ragdoll's damping — the stock
values are tuned for a corpse settling, not for a man helicoptering over a wall.

**The spin cap is about thin masonry, not the ground.** The world floor is a
30 m thick slab and nothing is getting through it. The real bound is a bridge
plank at `PS.d = 0.75 m`: staying under half of that per substep (0.375 m,
i.e. 22.5 m/s) stops a flying limb passing through a deck. `MAX_TANGENTIAL` is
19 m/s, leaving margin at 0.29 m per substep. Note `world.step()` always
advances in fixed 1/60 s substeps regardless of frame rate, so this bound does
not get worse on a slow machine.

Result: the mae geri spins at 20 rad/s — **3.2 somersaults a second** — with the
extremities at 17.5 m/s.

### Hit-stop is what makes a strike land

A connect freezes the world for a few frames (`meleeHitStop`, scaling `dt` to
6%). This is the single biggest contributor to a strike reading as *weight*
rather than as a shove — the eye needs a beat to register contact before
anything moves. Everything downstream of `dt` slows together, so physics,
ragdolls and the swing pose all hold, exactly as they do in a fighting game.

- `rawDt` is deliberately untouched, so the perf overlay and the frame governors
  still see real time.
- The scale is 0.06, not 0.0: a hard zero looks like a dropped frame, whereas a
  trickle reads as the world straining against the blow.
- Duration scales with the target (a body is worth more than a wall) and with
  the combo, so a string digs in harder as it builds. Chop 0.055 s, kick 0.13 s.
- `world.step(1/60, physicsDt, …)` is a fixed-step accumulator, so a tiny
  `physicsDt` simply runs zero substeps for a few frames. No instability.

Alongside it: a tight bright `popFlash` at the contact point, a dust burst on
flesh as well as on stone, camera shake scaled by profile and combo, and a
second sub-100 Hz audio layer on the heavy strike — pitch alone does not make a
hit feel big, it needs energy under 60 Hz and a longer tail.

### Two bugs the phase machine had

- **The FOV unwind was keyed to the current phase's start.** Fine for a 3-phase
  chop; the mae geri's extra re-chamber phase made the FOV jump back to full
  punch the moment that phase began. It now keys off the *strike window*
  (`strikeStart`/`strikeEnd`), which is independent of how many phases surround
  it.
- **The impact frame was gated on "we are inside the strike phase".** A long
  frame that stepped clean over an 0.08 s strike window would have swallowed the
  hit. It is now keyed to the swing timeline. Verified: the impact fires exactly
  once at 20, 30, 60 and 144 fps, 2–48 ms late from frame quantisation.

Continuity is verified numerically rather than by eye — the swing hands back to
the rest pose with **0.000000** error on pose, lunge and FOV, and the largest
per-step change anywhere in either swing is 0.008 rad at a 0.17 ms step (i.e. a
derivative, not a snap). An earlier version using absolute rather than
home-relative offsets left a ~9 mm / 3° snap at the hand-back.

### The AC-130

Dark green, low poly, nose along local −Z like the drone. **The 21 airframe
pieces are merged into one mesh with three material groups**: 8 draw calls per
pass (3 airframe + 4 propellers + 1 cargo ramp) instead of 26. Rendering is
this project's bottleneck, so even a transient prop batches itself.
`mergeGeometries` returns `null` rather than throwing on incompatible input, and
if any slot fails the builder falls back to loose meshes rather than flying a
plane with its belly missing.

The engine drone is three detuned sawtooths under a lowpass with a 5.6 Hz
tremolo for the prop beat, gain `0.24 / (1 + d/85)`. `setPaused` mutes it —
`animate()` early-returns while paused, so it would otherwise hold its last
gain behind the pause overlay.

### The drop, and why the lead is 7.4 m

Crates are hand-integrated, not physics bodies: a parachute in cannon-es is a
constraint rig with no gameplay payoff, and the crate has to land somewhere
predictable and reachable.

Free fall for 0.85 s, canopy pops, descent settles to 8.5 m/s. From 62 m that
is a ~7 s canopy ride. `AIRDROP_RELEASE_LEAD` was **derived by integrating the
exact update loop, not guessed**:

```
drift downrange between release and touchdown   16.4 m
crate appears AIRDROP_RAMP_OFFSET behind the plane  −9.0 m
                                                --------
lead                                              7.4 m
```

Getting the sign wrong here is easy — the ramp offset *subtracts*, so the lead
is the difference, not the sum. The first attempt used +9 and the crate landed
19 m short of its own smoke marker. The integration is stable to within 0.5 m
from 20 fps to 144 fps and 0.1 m across the aircraft's altitude bob.

Timeline of the drop: pass at 8 s of play, 5.1 s from spawn to release, the
whole stick out in 0.7 s, 7.0 s under canopy — **the arsenal is on the ground at
~20 s**, scattered over about 50 m. That is the bare-handed opening: long
enough to be the point, short enough not to be the whole level.

> Scheduling counts **seconds of play**, not `performance.now()`. `animate()`
> early-returns while paused, so a wall-clock deadline set at arm time expires
> behind the "click to play" prompt and the first AC-130 appears the instant the
> player takes control.

### One pass carries the whole arsenal, scattered by wind

A single AC-130 run puts **every remaining weapon** out of the back in one
stick. Each crate gets its own wind vector, so they come down in separate parts
of the map rather than in a line.

`stepCrateDescent()` is the descent model, and the **run planner flies the very
same function** to decide where each crate will land — prediction and reality
cannot drift apart by construction. The planner samples winds per crate and
keeps the first one whose predicted touchdown is in bounds, legal, and clear of
its siblings. The wind stays a real physical input; nothing is solved backwards
onto a chosen spot.

> The prediction runs at 20 Hz while the game runs the descent at frame rate.
> Measured disagreement across the whole wind range and 30–144 fps is **1.32 m
> worst case**, which is inside the 1.5 m pad the moat-ring and trench tests
> already use. That is why a validated crate cannot drift into water.

**What separates the crates is the wind, not the spacing between releases.**
This was the whole difficulty. The first version spaced releases 24 m apart
along the track, which puts 96 m of stick into a town arena that is 56 m wide —
the back half had nowhere legal to go. Simulating the planner against faithful
models of all three arenas:

| config | town | bridge | castle |
| --- | --- | --- | --- |
| 24 m spacing, ±40° wind, random heading | 8 % | 19 % | 26 % |
| 10 m, ±40°, along the long axis | 44 % | 50 % | 66 % |
| 8 m, ±90°, long axis | 69 % | 74 % | 90 % |
| + relaxing separation, 32 tries, 3 replans | **98 %** | **100 %** | **100 %** |

(percentage of passes that place all five crates; median footprint ~51 m)

The four things that got it there, all in `planAirdropStick()` /
`pickAirdropRunHeading()`:

1. **Short releases** — `AIRDROP_DROP_SPACING` 8 m, so the whole stick leaves in
   0.7 s and the wind does the scattering.
2. **Fly the arena's long axis**, not a random heading. Crossing the short axis
   of a narrow arena is unrecoverable no matter how the wind is sampled.
3. **Relax the separation requirement as attempts fail** (16 m down to ~10 m),
   so a tight arena places everything instead of deferring half the arsenal.
4. **Replan the whole stick up to 3 times with a fresh heading.** One unlucky
   heading is the single biggest failure mode — this alone took the town from
   75 % to 96 %.

Later wind samples aim at the arena centre rather than the prevailing wind,
which is what rescues drops planned near a boundary.

### Landing spots

`pickAirdropTarget()` samples an annulus 26–58 m around the player, clipped to
`airdropArenaBounds()` for whichever level owns the frame, then validates with
`airdropLandingOk()`: no water, no moat ring (gated on the castle stage, since
that test is pure geometry and the bridge level fills the same footprint), no
active bridge trench, no town house or tavern footprint, and nothing on top of
a standing wall. A wider fallback sweep runs if the annulus is fully blocked —
a run is deferred, never dropped into the moat.

- **A crate whose spot cannot be validated is not dropped.** Its weapon stays in
  the pool and a catch-up pass comes `AIRDROP_GAP_SEC` later. Better a short
  wait than a crate in the moat.
- **Uncollected crates return to the pool on a level change.** Otherwise
  advancing from the town to the bridge with two crates still on the ground
  would destroy those weapons for the rest of the run.
- **Bridge stage: crates land on the approach roads, not the deck.** The trench
  test covers the road corridor above it, so deck drops are rejected. That is
  intentional — `bridgeWalkerSurfaceY` is analytic and does not know about holes
  blown in the deck, so a crate could otherwise land on air.
- Landed crates **re-settle**. This is a destruction game: blow up the rubble a
  crate is sitting on and it would otherwise hang in mid-air.
- Label sprites hide past 45 m. With the whole arsenal on the ground there can
  be five of them, and rendering is the bottleneck; the smoke column carries the
  read at range.

Crate colours come from `airdropTint()`, **not** `WEAPONS[].color` — several of
those are near-black (the drone is `0x2a2a2a`) and would give an additively
blended smoke column that renders as nothing.

> **`airdropTint` is a function, not a lookup object, on purpose.** An object
> literal with computed keys — `{ [WEAPON_IDX_MINIGUN]: … }` — evaluates those
> constants at module scope, and they are declared further down the file.
> esbuild lowers their `const` to `var`, so instead of a TDZ error every key
> becomes the string `"undefined"` and all five entries collapse into one. This
> is §2 exactly, and it was caught by grepping the bundle, not by reading.

### State/ordering discipline

Every mutable binding for both systems is declared **up with the viewmodels**,
not next to the functions that use them. The reason is concrete:
`startGameWithDifficulty` runs *during module evaluation* on the sessionStorage
"Retry" path, and it reaches `setWeapon` and `armAirdropForDifficulty`. Any
state declared below that call site would be `undefined` at that moment — and
because esbuild lowers `let`/`const` to `var`, silently so.

---

## 9a. Dev menu is hidden by default

The 🧪 pill is `display: none` in CSS and revealed by **Settings → Dev Menu
Button**. Defaulting to hidden in the stylesheet rather than hiding it from
script means there is no flash of the button before `main.js` evaluates.

Three things that are easy to get wrong here:

1. **`setDevMenuButtonVisible()` looks the element up with `getElementById` on
   every call rather than capturing it.** `loadSettings()` runs during module
   evaluation at bundle line ~50072, and `const devMenuBtn` is at ~50340 —
   *after* it. esbuild lowers that const to `var`, so a captured reference would
   silently be `undefined` and the setting would appear to do nothing on boot,
   with no error. This is section 2 again.
2. **`APPLY & RESTART` rewrites the whole settings object**, it does not merge —
   so `dev` had to be added to the payload at the bottom of that handler or the
   toggle would reset itself every time anyone pressed Apply. Easy to miss
   because the toggle also persists itself on change.
3. Turning the toggle off while the dev panel is open closes the panel too,
   otherwise it is left on screen with nothing able to dismiss it.

The FPS badge sits at `right: 204px`, immediately left of the pill, so
`fpsBadgeRightPx()` moves it to 148px when the pill is hidden — without that
there is a 56 px hole in the top-right strip.

The level editor is **not** behind this: `openEditorBtn` lives on the difficulty
modal, not in the dev panel. And Settings is always reachable, so hiding the dev
menu cannot lock anyone out of re-enabling it.

---

## 10. Known limitations / not done

- **Rendering is the bottleneck** and has not been touched. Start with
  `window._townProbe.renderInfo()`.
- **The ripple field is 0.375 m per cell** over a fixed 192 m square. Fine for
  the moat and river; a town puddle is 1–3 m across, so it wobbles as a whole
  rather than showing concentric rings. Fixing that means higher resolution, or
  shrinking the field and recentring it on the player (which needs the buffer
  contents shifted, or ripples appear to slide with the camera).
- **`getStoryRoleBricks('castle')` is still hardcoded** in the support scan.
  Making it level-aware is the *correct* fix — town bricks are never
  support-scanned, so they can float — but it would add work to the town rather
  than remove it. Do it only alongside the budgets. The overlay's new `scan`
  field now shows this directly as `role town:SKIPPED`.
- **Refraction mode has no wave distortion** (see above).
- **The unexplained 10 ms `phys` reading** with zero awake bodies, seen once and
  not reproduced.
- **The melee and the airdrops have not been played.** They compile, the bundle
  ordering is verified, every identifier they reference resolves to a real
  top-level declaration, and the descent, scatter and strike geometry were all
  checked by numerical simulation — but nobody has thrown a kick or watched a
  crate come down. Most likely things to want tuning by eye: the pose numbers in
  `MELEE_KARATE.poses` / `MELEE_MAEGERI.poses` (particularly whether the leg
  reads well in frame), `brickForce` on either profile, `npcSpin` if the
  cartwheel is too much or not enough, and the AC-130's altitude versus how
  readable it is through `FogExp2`.
- **The AC-130 costs 8 draw calls while in shot**, in a project whose bottleneck
  is draw calls. It is transient and only in Modern Warfare, but if §8a's
  measurements come back CPU-bound it is worth revisiting.
- Nothing in these sessions was verified by an automated test. Static checks and
  arithmetic simulations only, plus manual play testing.

## Touch controls (2026-09-22)
The hand-rolled move pad / look drag / mobile FIRE-DESC-USE pills are gone.
`src/touch.js` builds the layer on the shared Arcade Touch Kit
(`src/touchkit.js`, identical in every game - edit the master in
`C:\Users\Dale\arcade-touch-kit`, run `node sync.mjs`). main.js supplies the
verbs (`ensureTouchHud`) and reads the thumbs once a frame
(`applyTouchFrame`, just before movement is summed). `isMobileProfile` now
comes from the kit's detection, so a touchscreen laptop is a desktop unless
`?touch=1`. Pause on touch is an explicit button (`pauseTouchGame`); tapping
the overlay resumes. Probe for tests: `window._townProbe.touch()`. Test:
`node C:\Users\Dale\arcade-touch-kit\tests\castle.test.mjs` with
`npx vite --port 5173` running (20 checks).
