# Sound Pass Scan (Free/Commercial-Usable Sources)

Date: 2026-06-19

## Current in-game sound hooks to replace
- Player hit cue: playArrowHitSound in src/main.js
- Guard footsteps: playNpcFootstep in src/main.js
- Drawbridge movement: playDrawbridgeCreak in src/main.js
- Mortar/cannon boom: playCannonFire and playExplosionBlast in src/main.js
- Minigun: playMinigunShot in src/main.js
- Sniper: playSniperShot in src/main.js

## Source options scanned

### 1) Sonniss GameAudioGDC (highest realism)
- Site: https://sonniss.com/gameaudiogdc
- License: https://sonniss.com/gdc-bundle-license/
- Terms seen:
  - Commercial use allowed
  - Unlimited projects/lifetime use
  - No attribution required
  - Cannot resell raw sounds
  - AI training prohibited
- Best for: realistic weapons, impacts, mechanical creaks, heavy booms

### 2) Pixabay SFX (fast pull + big catalog)
- License summary: https://pixabay.com/service/license-summary/
- Search pages:
  - Guns: https://pixabay.com/sound-effects/search/gun/
  - Footsteps: https://pixabay.com/sound-effects/search/footsteps/
- Terms seen:
  - Free use
  - No attribution required
  - Commercial use allowed under Pixabay terms
  - Cannot redistribute standalone files as your own pack
- Best for: footsteps surface variations, gun tails, reloads, movement foley

### 3) Mixkit SFX (quick no-attribution drops)
- Main: https://mixkit.co/free-sound-effects/
- License hub: https://mixkit.co/license/
- Category pages:
  - Warfare: https://mixkit.co/free-sound-effects/warfare/
  - Footsteps: https://mixkit.co/free-sound-effects/footsteps/
  - Impact: https://mixkit.co/free-sound-effects/impact/
- Terms seen on site FAQ/category pages:
  - Free for commercial/personal projects
  - No attribution required
  - Use under Mixkit license
- Best for: acceptable placeholders and rapid iteration

### 4) OpenGameArt CC0 collections
- Library page: https://opengameart.org/content/soundfx-library-cc0
- Terms seen:
  - CC0 collections available
- Best for: backup pool for one-shot hits/impacts and material foley

### 5) Freesound (use only CC0 or CC-BY with credits discipline)
- FAQ/licensing: https://freesound.org/help/faq/
- Terms seen:
  - Mixed licenses: CC0, CC-BY, CC-BY-NC
  - Attribution and commercial restrictions depend on item
- Best for: cherry-picked specialty sounds only after per-file license check

## Recommended pack strategy for this game

### Priority order
1. Sonniss GameAudioGDC for core realistic weapon and bridge mechanical sounds
2. Pixabay for footsteps variety and secondary weapon tails
3. Mixkit for quick temporary fills while curating final set

### Target replacements by complaint
- Irritating hit noise:
  - Replace with short realistic body impact + armor/cloth layer
  - Avoid tonal synth/vocal timbre
- Guard footsteps:
  - Use 3 to 5 short footstep variants and randomize
  - Surface set: dirt/stone/wood depending on map area
- Drawbridge lowering:
  - Use wood strain + chain rattle loop, not tonal oscillator creak
- Mortar:
  - Deep low-frequency boom with longer tail and less top-end crack
- Minigun:
  - Quiet spin-up motor + medium shot transients + short mechanical tails
  - Keep sustained perception without loud single-shot peaks
- Sniper:
  - Real supersonic crack + punch + outdoor tail/reverb
  - Remove toy-like pop character

## Integration suggestion (next implementation step)
- Add folder: public/audio/sfx/
- Add one JSON map in src/main.js keyed by cue name
- Load with HTMLAudioElement pool or Web Audio decoded buffers
- Keep current procedural sounds as fallback if asset missing
- Add per-cue volume trims so minigun can stay quieter than mortar/sniper

## Safe license notes
- Keep a SOURCES.md listing each file, author, URL, and license
- Avoid CC-BY-NC assets for any commercial release path
- Do not redistribute raw third-party packs in your repo release bundles unless license permits
