// Arcade Touch Kit — one touch-control layer for every game on the arcade.
//
// Twin virtual sticks, action buttons, touch gestures, device detection and a
// small settings sheet, in one dependency-free ES module. Each game keeps an
// identical copy of this file in its src/ folder (see README.md and sync.mjs in
// the arcade-touch-kit folder) so the controls cannot drift apart again: the
// feel, the sizes and the player's saved preferences are the same everywhere,
// and only the theme and the button list change from game to game.
//
// Why not nipplejs or similar: they solve one stick. The hard parts on a phone
// are everything round the stick — a fire button you can aim through, a look
// control that is precise AND can keep turning, browser gestures that must be
// suppressed, touches that vanish without a pointerup, and a HUD that has to
// stay out from under two thumbs.
//
// Units: every size and position is in CSS px at scale 1, tuned on a 360 px
// tall landscape phone. The layer multiplies by an automatic scale (bigger on
// tablets) and the player's own size preference.

export const TOUCHKIT_VERSION = '1.1.1';

const STORE_KEY = 'arcadeTouch.v1';      // shared by every game on the same origin
const FORCE_KEY = 'arcadeTouch.force';   // 'touch' | 'desktop'

const DEFAULT_SETTINGS = {
  size: 1,            // 0.8 .. 1.4, multiplies the automatic scale
  opacity: 0.85,      // 0.35 .. 1
  lookSens: 1,        // 0.4 .. 2.2
  lookMode: 'hybrid', // 'hybrid' | 'swipe' | 'stick'
  invertY: false,
  lefty: false,
  haptics: true,
  moveMode: 'floating', // 'floating' | 'fixed'
};

const DEFAULT_THEME = {
  accent: '#f1c40f',
  accentDark: '#825a08',
  ink: '#ffffff',
  glass: 'rgba(10,14,20,0.34)',
  line: 'rgba(255,255,255,0.38)',
  danger: '#d8452f',
  dangerDark: '#7a1710',
  font: 'inherit',
  radius: '50%',        // '50%' round, or e.g. '10px' for squared-off military kit
  panel: 'rgba(16,20,26,0.96)',
};

const SIZES = { xl: 88, lg: 70, md: 58, sm: 46, xs: 38 };

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function mq(q) {
  try { return !!(window.matchMedia && window.matchMedia(q).matches); } catch { return false; }
}

// "Should this device get touch controls by default?"
//
// A touchscreen laptop has touch points but a fine primary pointer and hover,
// and its owner wants mouse and keys. A phone or tablet has a coarse primary
// pointer and no hover. iPadOS pretends to be a Mac, so it is caught by the
// touch-point count. Anything this gets wrong is corrected live: the first real
// finger on the screen switches the kit on (see `adaptive`), and ?touch=0 /
// ?touch=1 or the saved override always win.
export function detectTouchDevice() {
  let forced = null;
  try {
    const p = new URLSearchParams(location.search).get('touch');
    if (p === '1' || p === 'true') forced = true;
    if (p === '0' || p === 'false') forced = false;
    if (forced === null) {
      const s = localStorage.getItem(FORCE_KEY);
      if (s === 'touch') forced = true;
      if (s === 'desktop') forced = false;
    }
  } catch { /* storage blocked: fall through to sniffing */ }
  const maxTouch = navigator.maxTouchPoints || 0;
  const info = {
    forced,
    primaryCoarse: mq('(pointer: coarse)'),
    anyCoarse: mq('(any-pointer: coarse)'),
    noHover: mq('(hover: none)'),
    maxTouch,
    iPadOS: /Mac/.test(navigator.platform || '') && maxTouch > 1,
    uaMobile: !!(navigator.userAgentData && navigator.userAgentData.mobile),
  };
  info.touch = forced !== null
    ? forced
    : (info.primaryCoarse || info.uaMobile || info.iPadOS || (maxTouch > 0 && info.noHover));
  return info;
}

// Sizes a game's canvas from the viewport - and keeps doing so for a moment
// after a rotation. Chrome on iOS (and some Android WebViews) fire `resize`
// while innerWidth / innerHeight still describe the OLD orientation as the
// toolbar animates; a canvas sized from that first reading is the wrong shape
// and the page background shows through as a border. Safari settles before it
// fires, which is why it never showed there. fn(w, h) runs at once on every
// resize / rotate / viewport event and again at 120, 400, 900 and 1600 ms if
// the numbers have changed since.
//
// iOS Chrome has a second failure on top of that: after a rotation it can lay
// the whole DOCUMENT out into the previous orientation's safe rectangle (a
// grey band down one side and along the bottom, the page shifted into the
// corner). Nothing inside the page can move that rectangle, but giving html
// and body explicit pixel sizes and forcing a relayout does snap it back.
export function watchViewport(fn) {
  let last = '';
  let timers = [];
  const fit = (w, h) => {
    const de = document.documentElement.style, bs = document.body.style;
    de.width = bs.width = w + 'px';
    de.height = bs.height = h + 'px';
    de.margin = bs.margin = '0';
    de.overflow = bs.overflow = 'hidden';
    // read-back forces the layout; toggling a transform makes WebKit rebuild
    // the fixed-position viewport it was holding on to
    de.transform = 'translateZ(0)';
    void document.documentElement.offsetHeight;
    de.transform = '';
  };
  const fire = (force) => {
    const w = window.innerWidth, h = window.innerHeight;
    const key = w + 'x' + h;
    if (!force && key === last) return;
    last = key;
    fit(w, h);
    try { window.scrollTo(0, 0); } catch { /* nothing to do */ }
    fn(w, h);
  };
  const kick = () => {
    for (const t of timers) clearTimeout(t);
    fire(true);
    timers = [120, 400, 900, 1600].map((ms) => setTimeout(() => fire(false), ms));
  };
  window.addEventListener('resize', kick);
  window.addEventListener('orientationchange', kick);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', kick);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  return { refresh: kick };
}

export function forceInputMode(mode) {
  try {
    if (mode === 'touch' || mode === 'desktop') localStorage.setItem(FORCE_KEY, mode);
    else localStorage.removeItem(FORCE_KEY);
  } catch { /* nothing to do */ }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const CSS = `
.tk-layer{position:fixed;inset:0;pointer-events:none;z-index:var(--tk-z,60);
  font-family:var(--tk-font,inherit);color:var(--tk-ink,#fff);
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;
  -webkit-tap-highlight-color:transparent;opacity:var(--tk-opacity,.85);
  transition:opacity .18s}
.tk-layer.tk-off{display:none}
.tk-layer.tk-idle .tk-play{opacity:0;pointer-events:none!important;visibility:hidden}
.tk-play{transition:opacity .15s}
.tk-hide{display:none!important}
.tk-stick{position:absolute;width:var(--tk-d);height:var(--tk-d);margin:calc(var(--tk-d) / -2) 0 0 calc(var(--tk-d) / -2);
  left:0;top:0;border-radius:50%;box-sizing:border-box;
  border:2px solid var(--tk-line);
  background:radial-gradient(circle at 35% 32%,rgba(255,255,255,.20),var(--tk-glass) 68%);
  box-shadow:0 10px 26px rgba(0,0,0,.40),inset 0 0 0 1px rgba(0,0,0,.25);
  transition:opacity .16s;will-change:transform,opacity}
.tk-stick.tk-rest{opacity:.42}
.tk-stick.tk-fixed{pointer-events:auto;touch-action:none}
.tk-stick.tk-live{opacity:1}
.tk-stick::before{content:"";position:absolute;inset:16%;border-radius:50%;border:1px dashed rgba(255,255,255,.18)}
.tk-stick .tk-nub{position:absolute;left:50%;top:50%;width:42%;height:42%;margin:-21% 0 0 -21%;border-radius:50%;
  box-sizing:border-box;border:2px solid rgba(255,255,255,.5);
  background:radial-gradient(circle at 32% 28%,var(--tk-accent),var(--tk-accent-dark) 78%);
  box-shadow:0 6px 14px rgba(0,0,0,.45),inset 0 2px 5px rgba(255,255,255,.28);will-change:transform}
.tk-stick.tk-look .tk-nub{background:radial-gradient(circle at 32% 28%,rgba(255,255,255,.78),rgba(120,130,150,.72) 78%)}
.tk-stick .tk-cap{position:absolute;left:50%;top:100%;transform:translate(-50%,4px);font-size:10px;letter-spacing:.16em;
  font-weight:700;text-transform:uppercase;opacity:.75;white-space:nowrap;text-shadow:0 1px 3px rgba(0,0,0,.9)}
.tk-stick.tk-live .tk-cap{opacity:0}
.tk-btn{position:absolute;width:var(--tk-d);height:var(--tk-d);box-sizing:border-box;padding:0;margin:0;
  border-radius:var(--tk-radius,50%);border:2px solid var(--tk-line);color:var(--tk-ink);
  background:radial-gradient(circle at 32% 28%,rgba(255,255,255,.22),var(--tk-glass) 72%);
  box-shadow:0 8px 20px rgba(0,0,0,.40),inset 0 2px 6px rgba(255,255,255,.16);
  font:inherit;font-weight:800;font-size:calc(var(--tk-d) * .2);letter-spacing:.05em;text-transform:uppercase;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;line-height:1.05;
  pointer-events:auto;touch-action:none;cursor:pointer;-webkit-appearance:none;appearance:none;outline:none;
  transition:transform .06s,filter .08s,opacity .15s;text-shadow:0 1px 3px rgba(0,0,0,.75)}
.tk-btn .tk-ico{font-size:calc(var(--tk-d) * .40);line-height:1;text-shadow:0 2px 4px rgba(0,0,0,.6)}
.tk-btn .tk-ico svg{width:1em;height:1em;display:block;fill:currentColor}
.tk-btn .tk-lab{display:block}
.tk-btn .tk-sub{display:block;font-size:calc(var(--tk-d) * .15);font-weight:600;letter-spacing:.04em;opacity:.85;text-transform:none}
.tk-btn.tk-icononly .tk-lab{display:none}
.tk-btn.tk-primary{border-color:rgba(255,255,255,.5);
  background:radial-gradient(circle at 32% 28%,var(--tk-danger-hi),var(--tk-danger-dark) 74%)}
.tk-btn.tk-accent{background:radial-gradient(circle at 32% 28%,var(--tk-accent),var(--tk-accent-dark) 76%)}
.tk-btn.tk-ghost{background:rgba(0,0,0,.34);box-shadow:0 4px 12px rgba(0,0,0,.35);border-width:1px}
.tk-btn.tk-down{transform:scale(.93);filter:brightness(1.28)}
.tk-btn.tk-lit{border-color:var(--tk-accent);box-shadow:0 0 0 2px var(--tk-accent),0 8px 20px rgba(0,0,0,.45)}
.tk-btn.tk-disabled{opacity:.35;filter:grayscale(.7)}
.tk-btn .tk-ring{position:absolute;inset:-7px;border-radius:50%;pointer-events:none;opacity:0;transition:opacity .1s;
  background:conic-gradient(from 0deg,var(--tk-accent) calc(var(--tk-p,0) * 1%),rgba(0,0,0,.35) 0);
  -webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 5px),#000 calc(100% - 5px));
          mask:radial-gradient(farthest-side,transparent calc(100% - 5px),#000 calc(100% - 5px))}
.tk-btn.tk-hasring .tk-ring{opacity:1}
.tk-badge{position:absolute;right:-4px;top:-4px;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:9px;
  background:var(--tk-accent);color:#1a1406;font-size:11px;font-weight:800;display:grid;place-items:center;text-shadow:none}
.tk-rotate{position:fixed;inset:0;z-index:calc(var(--tk-z,60) + 30);display:none;place-items:center;text-align:center;
  background:rgba(6,8,10,.93);color:var(--tk-ink);pointer-events:auto;padding:24px;font-family:var(--tk-font,inherit)}
.tk-rotate.tk-on{display:grid}
.tk-rotate b{display:block;font-size:20px;letter-spacing:.08em;text-transform:uppercase;margin:14px 0 6px;color:var(--tk-accent)}
.tk-rotate span{font-size:13px;opacity:.8}
.tk-rotate .tk-phone{width:54px;height:92px;margin:0 auto;border:3px solid var(--tk-accent);border-radius:10px;
  animation:tkturn 2.2s ease-in-out infinite}
@keyframes tkturn{0%,25%{transform:rotate(0)}60%,100%{transform:rotate(-90deg)}}
.tk-rotate button{margin-top:18px;padding:9px 18px;border-radius:8px;border:1px solid var(--tk-line);background:transparent;
  color:inherit;font:inherit;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
.tk-sheet{position:fixed;inset:0;z-index:calc(var(--tk-z,60) + 40);display:none;place-items:center;pointer-events:auto;
  background:rgba(0,0,0,.55);font-family:var(--tk-font,inherit);color:var(--tk-ink)}
.tk-sheet.tk-on{display:grid}
.tk-card{width:min(680px,94vw);max-height:92vh;max-height:92dvh;overflow:auto;box-sizing:border-box;padding:16px 18px 14px;
  background:var(--tk-panel);border:2px solid var(--tk-line);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.7);
  touch-action:pan-y}
.tk-card h3{margin:0 0 12px;font-size:15px;letter-spacing:.16em;text-transform:uppercase;color:var(--tk-accent);text-align:center}
.tk-grid{display:grid;grid-template-columns:1fr;gap:2px 26px}
@media (min-width:620px){.tk-grid{grid-template-columns:1fr 1fr}}
.tk-row{display:grid;grid-template-columns:104px 1fr;align-items:center;gap:10px;margin:7px 0;font-size:13px}
.tk-row label{opacity:.85}
.tk-row input[type=range]{width:100%;accent-color:var(--tk-accent);height:26px}
.tk-seg{display:flex;gap:5px}
.tk-seg button{flex:1;padding:8px 4px;border-radius:8px;border:1px solid var(--tk-line);background:rgba(255,255,255,.05);
  color:inherit;font:inherit;font-size:12px;letter-spacing:.04em}
.tk-seg button.tk-sel{background:var(--tk-accent);color:#1a1406;border-color:var(--tk-accent);font-weight:700}
.tk-note{font-size:11px;opacity:.62;line-height:1.45;margin:2px 0 0}
.tk-card .tk-close{display:block;width:100%;margin-top:12px;padding:11px;border-radius:9px;border:0;
  background:var(--tk-accent);color:#1a1406;font:inherit;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
`;

function injectCss() {
  if (document.getElementById('tk-style')) return;
  const s = document.createElement('style');
  s.id = 'tk-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function lighten(hex) {
  // Only used for the highlight of the primary button; a CSS colour it cannot
  // parse is handed straight back, which still renders.
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const f = (c) => Math.min(255, Math.round(c + (255 - c) * 0.42));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------------------
// Pointer plumbing
// ---------------------------------------------------------------------------
// One pointerdown listener per element; move/up/cancel are watched on window
// and filtered by id. Touch pointers are implicitly captured by the element
// they landed on, so their events always bubble up to window — and listening
// there means a stick keeps working when the thumb slides over a button or off
// the canvas, with no setPointerCapture (which has thrown in assorted WebViews).
// Browsers without Pointer Events get the same interface from Touch Events.

const HAS_POINTER = typeof window !== 'undefined' && 'PointerEvent' in window;
const tracks = new Map();   // id -> { move, up }
let windowWired = false;

function wireWindow() {
  if (windowWired) return;
  windowWired = true;
  const end = (id, x, y, cancelled) => {
    const t = tracks.get(id);
    if (!t) return;
    tracks.delete(id);
    t.up(x, y, cancelled);
  };
  if (HAS_POINTER) {
    window.addEventListener('pointermove', (e) => {
      const t = tracks.get(e.pointerId);
      if (t) { t.move(e.clientX, e.clientY, e); if (e.cancelable) e.preventDefault(); }
    }, { passive: false });
    window.addEventListener('pointerup', (e) => end(e.pointerId, e.clientX, e.clientY, false));
    window.addEventListener('pointercancel', (e) => end(e.pointerId, e.clientX, e.clientY, true));
  } else {
    window.addEventListener('touchmove', (e) => {
      let ours = false;
      for (const c of e.changedTouches) {
        const t = tracks.get('t' + c.identifier);
        if (t) { t.move(c.clientX, c.clientY, e); ours = true; }
      }
      if (ours && e.cancelable) e.preventDefault();
    }, { passive: false });
    const fin = (cancelled) => (e) => {
      for (const c of e.changedTouches) end('t' + c.identifier, c.clientX, c.clientY, cancelled);
    };
    window.addEventListener('touchend', fin(false));
    window.addEventListener('touchcancel', fin(true));
  }
  // A call, a notification shade or a tab switch can swallow the pointerup.
  const dropAll = () => {
    for (const [id, t] of [...tracks]) { tracks.delete(id); t.up(0, 0, true); }
  };
  window.addEventListener('blur', dropAll);
  window.addEventListener('pagehide', dropAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) dropAll(); });
}

// onDown(x, y, event, pointerType) returns { move, up } to claim the pointer,
// or nothing to let it go.
function listenDown(el, onDown) {
  wireWindow();
  if (HAS_POINTER) {
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (tracks.has(e.pointerId)) return;
      const t = onDown(e.clientX, e.clientY, e, e.pointerType);
      if (!t) return;
      tracks.set(e.pointerId, t);
      // Cancelling pointerdown is what stops the browser following up with
      // compatibility mousedown/click events aimed at the game's mouse code.
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    // iOS still runs its own touch defaults (double-tap zoom, text loupe)
    // unless touchstart itself is cancelled.
    el.addEventListener('touchstart', (e) => { if (e.cancelable && el.__tkBlockTouch !== false) e.preventDefault(); }, { passive: false });
  } else {
    el.addEventListener('touchstart', (e) => {
      let ours = false;
      for (const c of e.changedTouches) {
        const id = 't' + c.identifier;
        if (tracks.has(id)) continue;
        const t = onDown(c.clientX, c.clientY, e, 'touch');
        if (t) { tracks.set(id, t); ours = true; }
      }
      if (ours && e.cancelable) e.preventDefault();
    }, { passive: false });
  }
}

// ---------------------------------------------------------------------------
// The kit
// ---------------------------------------------------------------------------

export function createTouchKit(opts = {}) {
  injectCss();
  const theme = { ...DEFAULT_THEME, ...(opts.theme || {}) };
  const settings = loadSettings(opts.defaults);
  const device = detectTouchDevice();
  const listeners = { mode: [], settings: [] };

  const layer = document.createElement('div');
  layer.className = 'tk-layer tk-off tk-idle';
  layer.setAttribute('aria-hidden', 'true');
  if (opts.zIndex != null) layer.style.setProperty('--tk-z', String(opts.zIndex));
  const tv = (k, v) => layer.style.setProperty(k, v);
  tv('--tk-accent', theme.accent); tv('--tk-accent-dark', theme.accentDark);
  tv('--tk-ink', theme.ink); tv('--tk-glass', theme.glass); tv('--tk-line', theme.line);
  tv('--tk-danger-hi', lighten(theme.danger)); tv('--tk-danger-dark', theme.dangerDark);
  tv('--tk-font', theme.font); tv('--tk-radius', theme.radius); tv('--tk-panel', theme.panel);
  (opts.root || document.body).appendChild(layer);

  const sticks = [];
  const buttons = [];
  const look = { dx: 0, dy: 0 };
  let surface = null;
  let enabled = false;        // touch mode on at all
  let active = false;         // gameplay controls showing and live
  let groups = null;          // Set of active group names, or null for "no filter"
  let lastTouchAt = -1e9;
  let scale = 1;

  // --- settings -----------------------------------------------------------
  function loadSettings(defaults) {
    const base = { ...DEFAULT_SETTINGS, ...(defaults || {}) };
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in raw && typeof raw[k] === typeof DEFAULT_SETTINGS[k]) base[k] = raw[k];
      }
    } catch { /* corrupt or blocked: defaults */ }
    return base;
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
  }
  function setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) return;
    settings[key] = value;
    saveSettings();
    relayout();
    for (const fn of listeners.settings) fn(settings, key);
  }

  // --- layout -------------------------------------------------------------
  function autoScale() {
    // A phone in landscape is ~360-430 px tall and wants scale 1. Tablets have
    // the same size thumbs on a bigger sheet of glass, so grow a little, not
    // in proportion.
    const short = Math.min(window.innerWidth, window.innerHeight);
    const s = short <= 430 ? 1 : short <= 600 ? 1.08 : short <= 820 ? 1.2 : 1.3;
    // Very small windows (split-screen, tiny phones in portrait) shrink.
    return short < 330 ? 0.88 : s;
  }
  function relayout() {
    scale = autoScale() * clamp(settings.size, 0.7, 1.5);
    tv('--tk-opacity', String(clamp(settings.opacity, 0.2, 1)));
    for (const s of sticks) s._layout();
    for (const b of buttons) b._layout();
    checkRotate();
  }
  // Which screen edge a thing is measured from, after the left-handed swap.
  function sideOf(hand) {
    if (hand !== 'left' && hand !== 'right') return hand;
    if (!settings.lefty) return hand;
    return hand === 'left' ? 'right' : 'left';
  }
  function place(el, pos, hand) {
    // pos: { x, y, from: 'bottom'|'top', center: bool }. x is measured from the
    // edge named by `hand` (after the lefty swap), or from the centre line.
    const px = (pos.x || 0) * scale, py = (pos.y || 0) * scale;
    el.style.left = el.style.right = el.style.top = el.style.bottom = '';
    if (hand === 'center') {
      el.style.left = `calc(50% + ${px}px)`;
    } else {
      const side = sideOf(hand);
      el.style[side] = `calc(env(safe-area-inset-${side}, 0px) + ${px}px)`;
    }
    const v = pos.from === 'top' ? 'top' : 'bottom';
    el.style[v] = `calc(env(safe-area-inset-${v}, 0px) + ${py}px)`;
  }

  function haptic(ms) {
    if (!settings.haptics) return;
    try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch { /* iOS has none */ }
  }

  function groupVisible(g) {
    if (!g || !g.length) return true;
    if (!groups) return false;      // grouped things stay hidden until a group is chosen
    for (const n of g) if (groups.has(n)) return true;
    return false;
  }
  function refreshVisibility() {
    for (const s of sticks) s._refresh();
    for (const b of buttons) b._refresh();
  }

  // --- sticks -------------------------------------------------------------
  function addStick(o) {
    const s = {
      id: o.id, kind: o.kind === 'look' ? 'look' : 'move', hand: o.side === 'right' ? 'right' : 'left',
      groups: o.groups || null,
      radius: o.radius || 58,          // travel, in px at scale 1
      deadZone: o.deadZone != null ? o.deadZone : (o.kind === 'look' ? 0.10 : 0.14),
      curve: o.curve || (o.kind === 'look' ? 1.6 : 1.25),
      rest: o.rest || { x: 104, y: 96 },   // where the resting hint sits: centre, from the hand's corner
      zone: o.zone || null,            // floating: fraction of the surface this stick owns, [x0, x1, y0, y1]
      mode: o.mode || null,            // 'floating' | 'fixed'; null = follow the player's setting (move) or floating (look)
      rimStart: o.rimStart != null ? o.rimStart : 0.62,   // hybrid look: where sustained turning begins
      rate: o.rate || 820,             // look: px-equivalents per second at full deflection
      accel: o.accel != null ? o.accel : 0,     // swipe acceleration: off unless a game asks; players find it unpredictable
      label: o.label || '',
      onTap: o.onTap || null, onStart: o.onStart || null, onEnd: o.onEnd || null,
      x: 0, y: 0, mag: 0, angle: 0, active: false, visible: true,
      _ox: 0, _oy: 0, _px: 0, _py: 0, _t0: 0, _moved: 0, _lastT: 0, _lx: 0, _ly: 0,
    };
    const el = document.createElement('div');
    el.className = `tk-stick tk-play tk-rest ${s.kind === 'look' ? 'tk-look' : 'tk-move'}`;
    el.innerHTML = `<div class="tk-nub"></div>${s.label ? `<div class="tk-cap">${s.label}</div>` : ''}`;
    const nub = el.firstChild;
    layer.appendChild(el);
    s.el = el;

    s._mode = () => s.mode || (s.kind === 'move' ? settings.moveMode : 'floating');
    s._R = () => s.radius * scale;
    s._restPoint = () => {
      const side = sideOf(s.hand);
      const r = layer.getBoundingClientRect();
      const x = side === 'left' ? s.rest.x * scale + safe.left : r.width - s.rest.x * scale - safe.right;
      const y = r.height - s.rest.y * scale - safe.bottom;
      return { x, y };
    };
    s._layout = () => {
      el.style.setProperty('--tk-d', `${Math.round(s._R() * 2.25)}px`);
      el.classList.toggle('tk-fixed', s._mode() === 'fixed');
      if (!s.active) s._park();
    };
    s._park = () => {
      const p = s._restPoint();
      el.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`;
      nub.style.transform = 'translate(0px,0px)';
      el.classList.add('tk-rest'); el.classList.remove('tk-live');
    };
    s._refresh = () => {
      const show = s.visible && groupVisible(s.groups);
      el.classList.toggle('tk-hide', !show);
      if (!show && s.active) s._release(true);
    };
    s._owns = (x, y) => {
      if (!s.visible || !groupVisible(s.groups) || s.active) return false;
      if (s._mode() === 'fixed') {
        const p = s._restPoint();
        return Math.hypot(x - p.x, y - p.y) <= s._R() * 1.7;
      }
      const r = (surface || layer).getBoundingClientRect();
      let z = s.zone || (s.hand === 'left' ? [0, 0.45, 0.18, 1] : [0.45, 1, 0.12, 1]);
      if (settings.lefty) z = [1 - z[1], 1 - z[0], z[2], z[3]];
      const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
      return fx >= z[0] && fx <= z[1] && fy >= z[2] && fy <= z[3];
    };
    s._begin = (x, y) => {
      s.active = true;
      const fixed = s._mode() === 'fixed';
      // Fixed sticks keep their housing where it is but still measure from
      // where the thumb landed, so an off-centre touch does not lurch.
      const p = fixed ? s._restPoint() : { x, y };
      s._hx = p.x; s._hy = p.y;          // housing centre (what is drawn)
      s._ox = x; s._oy = y;              // origin (what is measured from)
      s._px = x; s._py = y; s._lx = x; s._ly = y;
      s._t0 = performance.now(); s._lastT = s._t0; s._moved = 0;
      el.classList.remove('tk-rest'); el.classList.add('tk-live');
      s._draw();
      if (s.onStart) s.onStart(s);
      return { move: s._move, up: s._up };
    };
    s._move = (x, y) => {
      const now = performance.now();
      const ddx = x - s._lx, ddy = y - s._ly;
      s._moved += Math.abs(ddx) + Math.abs(ddy);
      if (s.kind === 'look' && settings.lookMode !== 'stick') {
        // Swipe part: finger travel is aim travel, one for one, with a little
        // speed-based gain so a flick turns further than a slow drag.
        const dtMs = Math.max(1, now - s._lastT);
        const speed = Math.hypot(ddx, ddy) / dtMs;                  // px per ms
        const gain = 1 + s.accel * clamp((speed - 0.35) / 1.4, 0, 1);
        look.dx += ddx * gain * settings.lookSens;
        look.dy += ddy * gain * settings.lookSens * (settings.invertY ? -1 : 1);
      }
      s._lx = x; s._ly = y; s._lastT = now;
      s._px = x; s._py = y;
      // Follow: past the rim the origin is dragged along behind the thumb, so
      // the stick is never "lost" and reversing is always a short move.
      const R = s._R();
      let dx = x - s._ox, dy = y - s._oy;
      const len = Math.hypot(dx, dy);
      const slack = s.kind === 'look' ? 1.0 : 1.2;
      if (len > R * slack && s._mode() !== 'fixed') {
        const k = (len - R * slack) / len;
        s._ox += dx * k; s._oy += dy * k; s._hx += dx * k; s._hy += dy * k;
        dx = x - s._ox; dy = y - s._oy;
      }
      s._solve(dx, dy);
      s._draw();
    };
    s._solve = (dx, dy) => {
      const R = s._R();
      const len = Math.hypot(dx, dy);
      if (len < 1e-4) { s.x = s.y = s.mag = 0; return; }
      const raw = Math.min(1, len / R);
      // Radial dead zone, rescaled so output starts from 0 at its edge rather
      // than jumping. Axial dead zones make diagonals sticky; never use them.
      const m = clamp((raw - s.deadZone) / (1 - s.deadZone), 0, 1);
      const out = Math.pow(m, s.curve);
      s.mag = out;
      s.x = (dx / len) * out;
      s.y = (-dy / len) * out;          // up the screen is +y: forward / look up
      s.angle = Math.atan2(s.y, s.x);
    };
    s._draw = () => {
      const R = s._R();
      let dx = s._px - s._ox, dy = s._py - s._oy;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx *= R / len; dy *= R / len; }
      el.style.transform = `translate(${s._hx.toFixed(1)}px,${s._hy.toFixed(1)}px)`;
      nub.style.transform = `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)`;
    };
    s._up = (x, y, cancelled) => {
      const quick = performance.now() - s._t0 < 240 && s._moved < 12 * scale;
      s._release(false);
      if (quick && !cancelled && s.onTap) s.onTap(x, y);
    };
    s._release = () => {
      const was = s.active;
      s.active = false; s.x = s.y = s.mag = 0;
      s._park();
      if (was && s.onEnd) s.onEnd(s);
    };
    // Sustained turning for look sticks, called from kit.update().
    s._tick = (dt) => {
      if (!s.active || s.kind !== 'look' || settings.lookMode === 'swipe') return;
      let ax = s.x, ay = s.y;
      if (settings.lookMode === 'hybrid') {
        // Only the outer part of the throw turns by itself; inside it the stick
        // is a pure trackpad. Rescale so the rate rises from zero at rimStart.
        const R = s._R();
        const dx = s._px - s._ox, dy = s._py - s._oy;
        const raw = Math.min(1, Math.hypot(dx, dy) / R);
        const m = clamp((raw - s.rimStart) / (1 - s.rimStart), 0, 1);
        if (m <= 0) return;
        const len = Math.hypot(dx, dy) || 1;
        const k = Math.pow(m, 1.5);
        ax = (dx / len) * k; ay = (-dy / len) * k;
      }
      look.dx += ax * s.rate * dt * settings.lookSens;
      // Stick up = look up, which in screen-delta terms is a negative dy.
      look.dy += -ay * s.rate * 0.72 * dt * settings.lookSens * (settings.invertY ? -1 : 1);
    };

    if (HAS_POINTER || 'ontouchstart' in window) {
      // Fixed housings take their own touches; floating ones are fed by the
      // surface listener in attachSurface().
      listenDown(el, (x, y, e, type) => {
        if (!enabled || !active || s._mode() !== 'fixed' || !s._owns(x, y)) return null;
        noteTouch(type);
        return s._begin(x, y);
      });
    }
    sticks.push(s);
    s._layout(); s._refresh();
    return s;
  }

  // --- buttons ------------------------------------------------------------
  function addButton(o) {
    const b = {
      id: o.id, hand: o.hand || 'right', pos: o.pos || { x: 24, y: 24 },
      size: typeof o.size === 'number' ? o.size : (SIZES[o.size] || SIZES.md),
      groups: o.groups || null, type: o.type || 'tap',    // 'tap' | 'hold' | 'toggle'
      dragLook: !!o.dragLook, system: !!o.system,
      onDown: o.onDown || null, onUp: o.onUp || null, onTap: o.onTap || null, onToggle: o.onToggle || null,
      pressed: false, on: false, visible: o.visible !== false, enabled: true,
    };
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `tk-btn ${b.system ? '' : 'tk-play'} tk-${o.variant || 'neutral'}`;
    el.dataset.tk = b.id;
    el.innerHTML = '<span class="tk-ring"></span><span class="tk-ico"></span><span class="tk-lab"></span><span class="tk-sub"></span>';
    const [ring, ico, lab, sub] = el.children;
    layer.appendChild(el);
    b.el = el;

    b.setLabel = (t) => { lab.textContent = t || ''; lab.style.display = t ? '' : 'none'; return b; };
    b.setIcon = (t) => { if (t && t[0] === '<') ico.innerHTML = t; else ico.textContent = t || ''; ico.style.display = t ? '' : 'none'; return b; };
    b.setSub = (t) => { sub.textContent = t || ''; sub.style.display = t ? '' : 'none'; return b; };
    b.setVisible = (v) => { b.visible = !!v; b._refresh(); return b; };
    b.setEnabled = (v) => { b.enabled = !!v; el.classList.toggle('tk-disabled', !v); if (!v && b.pressed) b._end(true); return b; };
    b.setLit = (v) => { el.classList.toggle('tk-lit', !!v); return b; };
    b.setOn = (v) => { b.on = !!v; b.setLit(b.on); return b; };
    b.setVariant = (v) => { el.className = el.className.replace(/tk-(primary|accent|neutral|ghost)/, `tk-${v}`); return b; };
    // 0..1 draws a ring round the button (a charge, a cooldown); null hides it.
    b.setProgress = (p) => {
      if (p == null) { el.classList.remove('tk-hasring'); return b; }
      el.classList.add('tk-hasring');
      ring.style.setProperty('--tk-p', (clamp(p, 0, 1) * 100).toFixed(1));
      return b;
    };
    b.setBadge = (t) => {
      let bd = el.querySelector('.tk-badge');
      if (t == null || t === '') { if (bd) bd.remove(); return b; }
      if (!bd) { bd = document.createElement('span'); bd.className = 'tk-badge'; el.appendChild(bd); }
      bd.textContent = t;
      return b;
    };
    b.setLabel(o.label); b.setIcon(o.icon); b.setSub(o.sub);

    b._layout = () => {
      el.style.setProperty('--tk-d', `${Math.round(b.size * scale)}px`);
      place(el, b.pos, b.hand);
      if (b.hand === 'center') el.style.marginLeft = `${Math.round(-b.size * scale / 2)}px`;
    };
    b._refresh = () => { el.classList.toggle('tk-hide', !(b.visible && groupVisible(b.groups))); if (!b.visible && b.pressed) b._end(true); };
    b._end = (cancelled) => {
      if (!b.pressed) return;
      b.pressed = false;
      el.classList.remove('tk-down');
      if (b.onUp) b.onUp(b, cancelled);
    };

    listenDown(el, (x, y, e, type) => {
      if (!enabled || !b.enabled || (!b.system && !active)) return null;
      noteTouch(type);
      b.pressed = true;
      el.classList.add('tk-down');
      haptic(b.type === 'hold' ? 10 : 6);
      if (b.onDown) b.onDown(b);
      let lx = x, ly = y, travelled = 0, armed = false;
      const t0 = performance.now();
      return {
        move: (mx, my) => {
          const ddx = mx - lx, ddy = my - ly;
          lx = mx; ly = my;
          travelled += Math.abs(ddx) + Math.abs(ddy);
          // A thumb resting on FIRE wobbles. Only start steering once it has
          // clearly set off, then pass everything through.
          if (b.dragLook && (armed || travelled > 9 * scale)) {
            armed = true;
            look.dx += ddx * settings.lookSens;
            look.dy += ddy * settings.lookSens * (settings.invertY ? -1 : 1);
          }
        },
        up: (ux, uy, cancelled) => {
          b._end(cancelled);
          if (cancelled) return;
          // A tap counts if the finger came up on or near the button; sliding
          // off is the universal way of changing your mind.
          const r = el.getBoundingClientRect();
          const pad = 22 * scale;
          const inside = ux >= r.left - pad && ux <= r.right + pad && uy >= r.top - pad && uy <= r.bottom + pad;
          if (b.type === 'toggle' && (inside || b.dragLook)) { b.setOn(!b.on); if (b.onToggle) b.onToggle(b.on, b); }
          if (b.onTap && (inside || b.dragLook) && (b.type !== 'hold')) b.onTap(b, performance.now() - t0);
        },
      };
    });
    buttons.push(b);
    b._layout(); b._refresh();
    return b;
  }

  // --- surface ------------------------------------------------------------
  // Floating sticks are born from touches on the game canvas itself. Anything
  // drawn above the canvas with pointer-events on (the game's own HUD buttons,
  // this kit's buttons) takes its touches first, so no hit-testing is needed.
  function attachSurface(el, o = {}) {
    surface = el;
    el.style.touchAction = 'none';
    listenDown(el, (x, y, e, type) => {
      if (!enabled) return null;
      if (type === 'mouse' && !o.mouse) return null;
      noteTouch(type);
      if (!active) { if (o.onIdleTap) o.onIdleTap(x, y); return null; }
      for (const s of sticks) {
        if (s._mode() === 'floating' && s._owns(x, y)) return s._begin(x, y);
      }
      return null;
    });
    el.addEventListener('contextmenu', (e) => { if (enabled) e.preventDefault(); });
  }

  // --- mode ---------------------------------------------------------------
  const safe = { left: 0, right: 0, top: 0, bottom: 0 };
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  layer.appendChild(probe);
  function readSafe() {
    const cs = getComputedStyle(probe);
    safe.top = parseFloat(cs.paddingTop) || 0; safe.right = parseFloat(cs.paddingRight) || 0;
    safe.bottom = parseFloat(cs.paddingBottom) || 0; safe.left = parseFloat(cs.paddingLeft) || 0;
  }

  function noteTouch(type) {
    if (type !== 'mouse') lastTouchAt = performance.now();
  }
  function setEnabled(on) {
    on = !!on;
    if (on === enabled) return;
    enabled = on;
    layer.classList.toggle('tk-off', !on);
    document.body.classList.toggle('tk-touch', on);
    document.body.classList.toggle('tk-desktop', !on);
    if (!on) releaseAll();
    readSafe(); relayout();
    for (const fn of listeners.mode) fn(on);
  }
  function setActive(on) {
    on = !!on;
    if (on === active) return;
    active = on;
    layer.classList.toggle('tk-idle', !on);
    if (!on) releaseAll();
  }
  function releaseAll() {
    for (const [id, t] of [...tracks]) { tracks.delete(id); t.up(0, 0, true); }
    look.dx = look.dy = 0;
  }
  function setGroups(list) {
    groups = list ? new Set([].concat(list)) : null;
    refreshVisibility();
  }

  // A device the sniffing got wrong announces itself with its first touch.
  if (opts.adaptive !== false) {
    window.addEventListener('touchstart', () => {
      lastTouchAt = performance.now();
      if (!enabled && device.forced !== false) setEnabled(true);
    }, { capture: true, passive: true });
  }

  // --- page hygiene ---------------------------------------------------------
  // iOS pinch-zoom ignores user-scalable=no, and a double tap zooms the page.
  // Both are fatal mid-game. touch-action: manipulation turns off double-tap
  // zoom without the old trick of cancelling the second touchend, which also
  // ate the second of two quick taps on a weapon belt or a cycle button.
  function lockPage() {
    const st = document.documentElement.style;
    st.overscrollBehavior = 'none';
    st.touchAction = 'manipulation';
    // The games place their own HUD inside the safe area element by element;
    // a padding on the root only makes the document taller than the screen,
    // and a document taller than the screen is one iOS Chrome can scroll into
    // a grey band.
    st.padding = '0';
    document.body.style.overscrollBehavior = 'none';
    document.body.style.overflow = 'hidden';
    document.addEventListener('gesturestart', (e) => { if (enabled) e.preventDefault(); }, { passive: false });
    document.addEventListener('contextmenu', (e) => {
      if (enabled && performance.now() - lastTouchAt < 1200) e.preventDefault();
    });
  }

  // --- fullscreen and orientation ----------------------------------------------
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const canFullscreen = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  async function toggleFullscreen(target) {
    const el = target || document.documentElement;
    try {
      if (fsEl()) {
        await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
      } else {
        await (el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen());
        // Only allowed once fullscreen, and only on Android; harmless elsewhere.
        try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch { /* not allowed */ }
      }
    } catch { /* iPhone has no element fullscreen at all */ }
    return !!fsEl();
  }
  let wake = null;
  async function keepAwake(on) {
    try {
      if (on && !wake && navigator.wakeLock) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      } else if (!on && wake) { await wake.release(); wake = null; }
    } catch { /* low battery, or not supported */ }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && enabled && opts.keepAwake) keepAwake(true); });

  let rotateEl = null, rotateDismissed = false;
  function requireLandscape(text) {
    rotateEl = document.createElement('div');
    rotateEl.className = 'tk-rotate';
    rotateEl.innerHTML = `<div><div class="tk-phone"></div><b>Turn your device</b><span>${text || 'This one plays in landscape.'}</span><br><button type="button">Play upright anyway</button></div>`;
    rotateEl.querySelector('button').addEventListener('click', () => { rotateDismissed = true; checkRotate(); });
    for (const k of ['--tk-accent', '--tk-ink', '--tk-line', '--tk-font']) rotateEl.style.setProperty(k, layer.style.getPropertyValue(k));
    document.body.appendChild(rotateEl);
    checkRotate();
  }
  function checkRotate() {
    if (!rotateEl) return;
    const portrait = window.innerHeight > window.innerWidth * 1.05;
    rotateEl.classList.toggle('tk-on', enabled && portrait && !rotateDismissed);
  }

  // --- settings sheet ---------------------------------------------------------
  let sheet = null;
  function openSettings(o = {}) {
    const items = o.items || opts.settingsItems || ['size', 'opacity', 'lookSens', 'lookMode', 'moveMode', 'invertY', 'lefty', 'haptics'];
    if (sheet) sheet.remove();
    sheet = document.createElement('div');
    sheet.className = 'tk-sheet tk-on';
    for (const k of ['--tk-accent', '--tk-ink', '--tk-line', '--tk-font', '--tk-panel']) sheet.style.setProperty(k, layer.style.getPropertyValue(k));
    const card = document.createElement('div');
    card.className = 'tk-card';
    card.dataset.tkScroll = '1';
    card.innerHTML = '<h3>Touch controls</h3><div class="tk-grid"></div>';
    const grid = card.lastChild;
    const range = (key, label, min, max, step) => {
      const row = document.createElement('div'); row.className = 'tk-row';
      row.innerHTML = `<label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${settings[key]}">`;
      row.lastChild.addEventListener('input', (e) => setSetting(key, parseFloat(e.target.value)));
      grid.appendChild(row);
    };
    const seg = (key, label, choices, note) => {
      const row = document.createElement('div'); row.className = 'tk-row';
      row.innerHTML = `<label>${label}</label><div class="tk-seg"></div>`;
      for (const [val, text] of choices) {
        const bt = document.createElement('button');
        bt.type = 'button'; bt.textContent = text;
        bt.classList.toggle('tk-sel', settings[key] === val);
        bt.addEventListener('click', () => {
          setSetting(key, val);
          row.querySelectorAll('button').forEach((n) => n.classList.toggle('tk-sel', n === bt));
        });
        row.lastChild.appendChild(bt);
      }
      const cell = document.createElement('div');
      cell.appendChild(row);
      if (note) { const p = document.createElement('p'); p.className = 'tk-note'; p.textContent = note; cell.appendChild(p); }
      grid.appendChild(cell);
    };
    for (const it of items) {
      if (it === 'size') range('size', 'Control size', 0.8, 1.4, 0.05);
      if (it === 'opacity') range('opacity', 'Opacity', 0.35, 1, 0.05);
      if (it === 'lookSens') range('lookSens', 'Aim sensitivity', 0.4, 2.2, 0.05);
      if (it === 'lookMode') seg('lookMode', 'Right thumb', [['hybrid', 'Hybrid'], ['swipe', 'Swipe'], ['stick', 'Stick']],
        'Hybrid: swipe to aim precisely, push to the rim to keep turning. Swipe: trackpad only. Stick: classic joystick.');
      if (it === 'moveMode') seg('moveMode', 'Left stick', [['floating', 'Floating'], ['fixed', 'Fixed']],
        'Floating appears wherever your thumb lands. Fixed stays in the corner.');
      if (it === 'invertY') seg('invertY', 'Invert aim', [[false, 'Off'], [true, 'On']]);
      if (it === 'lefty') seg('lefty', 'Handed', [[false, 'Right'], [true, 'Left']]);
      if (it === 'haptics') seg('haptics', 'Vibration', [[true, 'On'], [false, 'Off']]);
    }
    if (typeof o.extra === 'function') o.extra(grid, { range, seg });
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'tk-close'; close.textContent = 'Done';
    const shut = () => { if (sheet) { sheet.remove(); sheet = null; } if (o.onClose) o.onClose(); };
    close.addEventListener('click', shut);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) shut(); });
    card.appendChild(close);
    sheet.appendChild(card);
    document.body.appendChild(sheet);
    return sheet;
  }

  // --- frame ----------------------------------------------------------------
  function update(dt) {
    if (!enabled || !active) return;
    for (const s of sticks) s._tick(dt);
  }
  function consumeLook() {
    const out = { dx: look.dx, dy: look.dy };
    look.dx = look.dy = 0;
    return out;
  }

  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    // Safari reports the old size for a beat after an orientation change.
    resizeTimer = setTimeout(() => { readSafe(); releaseAll(); relayout(); }, 120);
    readSafe(); relayout();
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  const kit = {
    version: TOUCHKIT_VERSION,
    device, settings, layer,
    get enabled() { return enabled; },
    get active() { return active; },
    get scale() { return scale; },
    // True for a moment after any touch: lets a game's mouse handlers ignore
    // the compatibility mouse events some browsers still send after a tap.
    recentTouch(ms = 800) { return performance.now() - lastTouchAt < ms; },
    setEnabled, setActive, setGroups, setSetting,
    addStick, addButton, attachSurface,
    stick(id) { return sticks.find((s) => s.id === id) || null; },
    button(id) { return buttons.find((b) => b.id === id) || null; },
    update, consumeLook, releaseAll,
    lockPage, toggleFullscreen, canFullscreen, keepAwake, requireLandscape,
    get isFullscreen() { return !!fsEl(); },
    openSettings, haptic, relayout,
    onModeChange(fn) { listeners.mode.push(fn); },
    onSettingsChange(fn) { listeners.settings.push(fn); },
  };

  readSafe(); relayout();
  if (device.touch) setEnabled(true);
  else { document.body.classList.add('tk-desktop'); }
  return kit;
}

// ---------------------------------------------------------------------------
// Gestures — for games where the finger works ON the world (an RTS map)
// rather than steering through it.
// ---------------------------------------------------------------------------
// Turns raw touches on one element into: tap, doubleTap, longPress, a
// one-finger drag, and a two-finger pinch / twist / pan. Mouse and pen are left
// alone so the desktop handlers keep working untouched.
//
//   createGestureSurface(canvas, {
//     onTap(x, y), onDoubleTap(x, y),
//     onLongPress(x, y),                       // finger held still; it may go on to drag:
//     onLongMove(x, y, dx, dy), onLongEnd(x, y, moved, cancelled),
//     onDragStart(x, y), onDragMove(x, y, dx, dy), onDragEnd(x, y, cancelled),
//     onPinchStart(), onPinch({ scale, rotate, dx, dy, cx, cy }), onPinchEnd(),
//   })
// A tap is reported at once; a second tap inside doubleTapMs is reported as
// onDoubleTap on top of it, so nothing waits on a timer.
export function createGestureSurface(el, h = {}) {
  const TAP_SLOP = h.tapSlop || 12;          // px of wobble still counted as a tap
  const LONG_MS = h.longPressMs || 420;
  const DOUBLE_MS = h.doubleTapMs || 300;
  const pts = new Map();
  let mode = 'none';                          // none | press | drag | pinch | dead
  let longTimer = 0, lastTapAt = -1e9, lastTapX = 0, lastTapY = 0;
  let pinch = null, longMoved = false;
  el.style.touchAction = 'none';

  const two = () => { const a = [...pts.values()]; return [a[0], a[1]]; };
  const geom = () => {
    const [a, b] = two();
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(b.x - a.x, b.y - a.y) || 1, ang: Math.atan2(b.y - a.y, b.x - a.x) };
  };

  function down(id, x, y) {
    pts.set(id, { x, y, sx: x, sy: y });
    if (pts.size === 1) {
      mode = 'press';
      clearTimeout(longTimer);
      longTimer = setTimeout(() => {
        if (mode === 'press') { mode = 'long'; longMoved = false; if (h.onLongPress) h.onLongPress(x, y); }
      }, LONG_MS);
    } else if (pts.size === 2) {
      clearTimeout(longTimer);
      if (mode === 'drag' && h.onDragEnd) h.onDragEnd(x, y, true);
      if (mode === 'long' && h.onLongEnd) h.onLongEnd(x, y, longMoved, true);
      mode = 'pinch';
      pinch = geom();
      if (h.onPinchStart) h.onPinchStart();
    }
  }
  function move(id, x, y) {
    const p = pts.get(id);
    if (!p) return;
    const dx = x - p.x, dy = y - p.y;
    p.x = x; p.y = y;
    if (mode === 'press' && Math.hypot(x - p.sx, y - p.sy) > TAP_SLOP) {
      clearTimeout(longTimer);
      mode = 'drag';
      if (h.onDragStart) h.onDragStart(p.sx, p.sy);
    }
    if (mode === 'drag' && h.onDragMove) h.onDragMove(x, y, dx, dy);
    if (mode === 'long') {
      if (!longMoved && Math.hypot(x - p.sx, y - p.sy) > TAP_SLOP) longMoved = true;
      if (longMoved && h.onLongMove) h.onLongMove(x, y, dx, dy);
    }
    if (mode === 'pinch' && pts.size >= 2) {
      const g = geom();
      let rot = g.ang - pinch.ang;
      if (rot > Math.PI) rot -= Math.PI * 2;
      if (rot < -Math.PI) rot += Math.PI * 2;
      if (h.onPinch) h.onPinch({ scale: g.d / pinch.d, rotate: rot, dx: g.cx - pinch.cx, dy: g.cy - pinch.cy, cx: g.cx, cy: g.cy });
      pinch = g;
    }
  }
  function up(id, x, y, cancelled) {
    if (!pts.has(id)) return;
    pts.delete(id);
    clearTimeout(longTimer);
    if (mode === 'press' && !cancelled) {
      const now = performance.now();
      if (now - lastTapAt < DOUBLE_MS && Math.hypot(x - lastTapX, y - lastTapY) < 36 && h.onDoubleTap) {
        lastTapAt = -1e9;
        h.onDoubleTap(x, y);
      } else {
        lastTapAt = now; lastTapX = x; lastTapY = y;
        if (h.onTap) h.onTap(x, y);
      }
    } else if (mode === 'drag') {
      if (h.onDragEnd) h.onDragEnd(x, y, !!cancelled);
    } else if (mode === 'long') {
      if (h.onLongEnd) h.onLongEnd(x, y, longMoved, !!cancelled);
    } else if (mode === 'pinch') {
      if (h.onPinchEnd) h.onPinchEnd();
    }
    // Lifting one finger of a pinch must not turn the other into a drag or a
    // tap: the gesture is over until every finger is up.
    mode = pts.size ? 'dead' : 'none';
  }

  if (HAS_POINTER) {
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      try { el.setPointerCapture(e.pointerId); } catch { /* fine without */ }
      down(e.pointerId, e.clientX, e.clientY);
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    el.addEventListener('pointermove', (e) => { if (e.pointerType === 'touch') move(e.pointerId, e.clientX, e.clientY); });
    el.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') up(e.pointerId, e.clientX, e.clientY, false); });
    el.addEventListener('pointercancel', (e) => { if (e.pointerType === 'touch') up(e.pointerId, e.clientX, e.clientY, true); });
    el.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  } else {
    el.addEventListener('touchstart', (e) => { for (const c of e.changedTouches) down(c.identifier, c.clientX, c.clientY); if (e.cancelable) e.preventDefault(); }, { passive: false });
    el.addEventListener('touchmove', (e) => { for (const c of e.changedTouches) move(c.identifier, c.clientX, c.clientY); if (e.cancelable) e.preventDefault(); }, { passive: false });
    el.addEventListener('touchend', (e) => { for (const c of e.changedTouches) up(c.identifier, c.clientX, c.clientY, false); });
    el.addEventListener('touchcancel', (e) => { for (const c of e.changedTouches) up(c.identifier, c.clientX, c.clientY, true); });
  }
  return {
    get mode() { return mode; },
    get touches() { return pts.size; },
    cancel() { clearTimeout(longTimer); pts.clear(); mode = 'none'; },
  };
}
