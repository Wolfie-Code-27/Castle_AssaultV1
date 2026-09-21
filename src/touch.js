// Touch controls for Castle Destruction, built on the shared Arcade Touch Kit
// (touchkit.js — identical in every game; edit the master in arcade-touch-kit
// and re-sync, never this copy).
//
// Left thumb walks (and rolls / pitches the drone). Right thumb aims: a swipe
// for precision, lean on the rim to keep turning. FIRE is whatever the trigger
// means for the weapon in hand — fires, sprays while held, cooks a grenade
// while held and throws on release, lifts the drone — and you can keep aiming
// with the same thumb while you hold it. The weapon roller stays as it was:
// it is the one piece of the old mobile HUD worth keeping, and it now sits on
// the left above the walk stick.
//
// main.js hands in the verbs as `api`; this file never touches game state.
import { createTouchKit } from './touchkit.js';

const THEME = {
  accent: '#f1c40f', accentDark: '#7a5406', ink: '#f2e8c6',
  glass: 'rgba(15,22,34,.50)', line: 'rgba(255,255,255,.40)',
  danger: '#d8452f', dangerDark: '#7a1710',
  panel: 'rgba(15,22,34,.97)',
  font: 'Georgia, "Times New Roman", serif',
};

export function createTouchControls(canvas, api) {
  const kit = createTouchKit({ theme: THEME, zIndex: 120, keepAwake: true });
  kit.lockPage();
  kit.attachSurface(canvas, { onIdleTap: () => api.idleTap() });
  kit.requireLandscape('The castle is wider than it is tall.');

  const move = kit.addStick({ id: 'move', side: 'left', label: 'Move', rest: { x: 100, y: 92 } });
  kit.addStick({ id: 'look', side: 'right', kind: 'look', label: 'Aim', rest: { x: 250, y: 92 }, rate: 900 });

  const fire = kit.addButton({
    id: 'fire', label: 'Fire', size: 'xl', variant: 'primary', type: 'hold', dragLook: true,
    pos: { x: 20, y: 22 }, groups: ['play'],
    onDown: () => api.fireDown(),
    onUp: (b, cancelled) => api.fireUp(cancelled),
  });
  const jump = kit.addButton({
    id: 'jump', icon: '⤒', label: 'Jump', size: 'md', pos: { x: 120, y: 12 }, groups: ['play'],
    onTap: () => api.jump(),
  });
  // The slot above JUMP is context: the sniper's scope, the drone's descent,
  // or USE when there is something to use. One thumb-reach, one job at a time.
  const scope = kit.addButton({
    id: 'scope', icon: '◎', label: 'Scope', size: 'md', type: 'toggle', dragLook: true,
    pos: { x: 118, y: 84 }, groups: ['play'],
    onToggle: (on) => api.setScope(on),
  });
  const descend = kit.addButton({
    id: 'descend', icon: '▼', label: 'Down', size: 'md', type: 'hold', dragLook: true,
    pos: { x: 118, y: 84 }, groups: ['play'],
    onDown: () => api.descend(true), onUp: () => api.descend(false),
  });
  const use = kit.addButton({
    id: 'use', icon: '✋', label: 'Use', size: 'md', variant: 'accent',
    pos: { x: 118, y: 84 }, groups: ['play'],
    onTap: () => api.interact(),
  });
  const cam = kit.addButton({
    id: 'cam', icon: '▣', label: 'Cam', size: 'sm', type: 'toggle', variant: 'ghost',
    pos: { x: 26, y: 128 }, groups: ['play'],
    onToggle: (on) => api.pinBallCam(on),
  });
  // Along the top edge, clear of both thumbs.
  const sys = (id, icon, x, onTap, extra) => kit.addButton({
    id, icon, size: 'xs', variant: 'ghost', system: true, hand: 'right', pos: { x, y: 10, from: 'top' }, onTap, ...(extra || {}),
  });
  sys('pause', '❚❚', 12, () => api.pause(), { groups: null });
  sys('gear', '⚙', 56, () => api.openSettings());
  if (kit.canFullscreen) sys('fs', '⛶', 100, () => kit.toggleFullscreen());

  let group = '';
  let ctx = '';
  return {
    kit, move,
    get enabled() { return kit.enabled; },
    resetScope() { scope.setOn(false); },
    setCam(on) { cam.setOn(on); },
    openSettings(o) { return kit.openSettings(o); },
    // Once a frame. Returns the aim deltas gathered since the last call.
    frame(dt, s) {
      if (!kit.enabled) return null;
      // s: { playing, sniper, drone, canUse, cooking, cook, ammoOut, fireLabel }
      kit.setActive(s.playing);
      const g = s.playing ? 'play' : '';
      if (g !== group) { group = g; kit.setGroups(g ? [g] : []); }
      if (!s.playing) { kit.consumeLook(); return null; }
      const want = s.drone ? 'descend' : s.sniper ? 'scope' : s.canUse ? 'use' : '';
      if (want !== ctx) {
        ctx = want;
        scope.setVisible(want === 'scope'); descend.setVisible(want === 'descend'); use.setVisible(want === 'use');
        if (want !== 'scope' && scope.on) scope.setOn(false);
      }
      fire.setLabel(s.fireLabel || 'Fire');
      fire.setProgress(s.cooking ? s.cook : null);
      fire.setEnabled(!s.ammoOut);
      kit.update(dt);
      return kit.consumeLook();
    },
  };
}
