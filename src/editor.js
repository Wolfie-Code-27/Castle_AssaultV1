/**
 * Level Editor  –  src/editor.js
 *
 * Key design:
 *  • 3-D mode auto-acquires pointer lock → WASD works immediately
 *  • Ghost updates every rAF frame from crosshair (3-D) or mouse (top-down)
 *  • Brick / NPC toolbar buttons open inline dropdowns (no full-screen modal)
 *  • NPC mode shows a green cylinder ghost, not the brick box
 *  • window.__editorActive        = true while editor open (suppresses firing)
 *  • window.__editorPhysicsFrozen = true until Play is pressed
 *  • window.__editorOverrideCamera for top-down ortho
 */

import * as THREE from 'three';


/* ─── shape / rotation catalogue ───────────────────────────────────────── */
// Each shape has one or more rotations; R key cycles them.
/* Build a quaternion from an explicit local basis: the voussoir's local axes
   are +X tangent (toward +ring-angle), +Y ring axis, +Z radial-out. Arch
   starters stand the ring plane vertically: the springer's radial-out points
   horizontally, and face-angle snapping then carries the arch up and over. */
function basisQuat(xAxis, yAxis, zAxis) {
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...xAxis), new THREE.Vector3(...yAxis), new THREE.Vector3(...zAxis));
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

const SHAPES = {
  brick: {
    label: 'Brick', icon: '🧱',
    rotations: [
      { id:'X', label:'↔ X-flat',  fn:'createBrick',     w:2, h:1, d:1, col:0x44aaff },
      { id:'Z', label:'↕ Z-flat',  fn:'createBrickZ',    w:1, h:1, d:2, col:0x44aaff },
      { id:'Y', label:'↑ Upright', fn:'createBrickY',    w:1, h:2, d:1, col:0x44aaff },
    ],
  },
  cube: {
    label: 'Cube', icon: '⬜',
    rotations: [
      { id:'cube', label:'■ Cube', fn:'createBrickCube', w:1, h:1, d:1, col:0x55ccff },
    ],
  },
  wedge: {
    label: 'Wedge', icon: '◣',
    rotations: [
      { id:'w0', label:'◣ 0°',   fn:'createBrickAngled', w:2, h:1, d:1, angle:0,            col:0xffaa44 },
      { id:'w1', label:'◤ 90°',  fn:'createBrickAngled', w:1, h:1, d:2, angle:Math.PI/2,    col:0xffaa44 },
      { id:'w2', label:'◥ 180°', fn:'createBrickAngled', w:2, h:1, d:1, angle:Math.PI,      col:0xffaa44 },
      { id:'w3', label:'◢ 270°', fn:'createBrickAngled', w:1, h:1, d:2, angle:-Math.PI/2,   col:0xffaa44 },
      /* Arch springers — vertical ring plane. "Arch X" curves along world X
         (tunnel axis Z): radial-out → +X, ring axis → +Z, tangent → up.
         "Arch Z" curves along world Z (tunnel axis X). */
      { id:'aX', label:'⌒ Arch X', fn:'createBrickAngled', w:1, h:2, d:1, col:0xff8866,
        quat: basisQuat([0, 1, 0], [0, 0, 1], [1, 0, 0]) },
      { id:'aZ', label:'⌒ Arch Z', fn:'createBrickAngled', w:1, h:2, d:1, col:0xff8866,
        quat: basisQuat([0, -1, 0], [1, 0, 0], [0, 0, 1]) },
    ],
  },
  trench: {
    label: 'Trench', icon: '≋',
    rotations: [
      { id:'trench', label:'≋ Ground trench', fn:'createEditorTrench', w:0.5, h:0.7, d:0.5, col:0x795b3a },
    ],
  },
  plank: {
    label: 'Plank', icon: '🪵',
    rotations: [
      // PS = { w:1.5, h:0.75, d:0.75 } (75% of BS)
      { id:'px', label:'— X-plank', fn:'createEditorPlankX', w:1.5, h:0.75, d:0.75, col:0x8a6030 },
      { id:'pz', label:'| Z-plank', fn:'createEditorPlankZ', w:0.75, h:0.75, d:1.5, col:0x8a6030 },
    ],
  },
};

const SHAPE_ORDER = Object.keys(SHAPES);  // ['brick','cube','wedge']

function shapeThumbHTML(shapeId, extraClass = '') {
  const cls = `ed-shape-thumb ed-shape-${shapeId}${extraClass ? ` ${extraClass}` : ''}`;
  return `<span class="${cls}" aria-hidden="true"></span>`;
}

const NPC_DEFS = [
  { id: 'sword',  label: 'Swordsman', icon: '⚔' },
  { id: 'axe',    label: 'Axeman',    icon: '🪓' },
  { id: 'spear',  label: 'Spearman',  icon: '⛏' },
  { id: 'archer', label: 'Archer',    icon: '🏹' },
];

/* ─── decor catalogue ────────────────────────────────────────────────────── */
const DECOR_DEFS = {
  shrub: {
    label: 'Shrub', icon: '🌿',
    variants: [
      { id: 's0', label: '🌿 Shrub',  w: 1.0, h: 0.8, d: 1.0, col: 0x2d6b22, fn: 'createEditorDecorShrub', args: [] },
    ],
  },
  tree: {
    label: 'Tree', icon: '🌲',
    variants: [
      { id: 't0', label: '🌲 Pine Tree', w: 1.6, h: 5.0, d: 1.6, col: 0x1c5218, fn: 'createEditorDecorTree', args: [] },
    ],
  },
  banner: {
    label: 'Banner', icon: '🚩',
    variants: [
      { id: 'b0', label: '🟥 Crimson', w: 1.6, h: 5.0, d: 0.12, col: 0x8e1b2e, fn: 'createEditorDecorBanner', args: [0] },
      { id: 'b1', label: '🟦 Blue',    w: 1.6, h: 5.0, d: 0.12, col: 0x1f3f86, fn: 'createEditorDecorBanner', args: [1] },
      { id: 'b2', label: '🟩 Green',   w: 1.6, h: 5.0, d: 0.12, col: 0x1f6b35, fn: 'createEditorDecorBanner', args: [2] },
      { id: 'b3', label: '🟪 Purple',  w: 1.6, h: 5.0, d: 0.12, col: 0x5a2168, fn: 'createEditorDecorBanner', args: [3] },
    ],
  },
};
const DECOR_ORDER = Object.keys(DECOR_DEFS);

/* ─── mutable state ─────────────────────────────────────────────────────── */
const st = {
  active: false, view: '3d', tool: 'place',
  itemType: 'brick', brickShape: 'brick', brickRot: 0, npcWeapon: 'sword',
  decorType: 'shrub', decorVariant: 0,
  playing: false,
  halfSnap: false,
  trenchBrushSize: 0.5,
  trenchWater: false,
  trenchDrawing: false,
  trenchLastPos: null,
  topZoom: 120, topPanX: 0, topPanZ: 60,
  mouseNdc: { x: 0, y: 0 },
  wedgeSnapQuat: null,   // face-angle snap pose (THREE.Quaternion) derived in placementPos()
};

const placed = [];  // { type:'brick'|'npc', brickEntry?, npcEntry? }

let api = null;
let ghost = null, npcGhost = null, decorGhost = null, topCam = null, topHelper = null;
let raycaster = null;

function setCrosshairCentered() {
  const ch = document.getElementById('crosshair');
  if (!ch) return;
  ch.style.left = '50%';
  ch.style.top = '50%';
  ch.style.transform = 'translate(-50%, -50%)';
}

function setCrosshairFromMouse(clientX, clientY) {
  const ch = document.getElementById('crosshair');
  if (!ch || !api?.renderer?.domElement) return;
  const r = api.renderer.domElement.getBoundingClientRect();
  const x = Math.max(r.left, Math.min(r.right, clientX));
  const y = Math.max(r.top, Math.min(r.bottom, clientY));
  ch.style.left = `${Math.round(x)}px`;
  ch.style.top = `${Math.round(y)}px`;
  ch.style.transform = 'translate(-50%, -50%)';
}

function syncTopdownCrosshairFromNdc() {
  if (!api?.renderer?.domElement) return;
  const r = api.renderer.domElement.getBoundingClientRect();
  const x = r.left + ((st.mouseNdc.x + 1) * 0.5) * r.width;
  const y = r.top + ((1 - st.mouseNdc.y) * 0.5) * r.height;
  setCrosshairFromMouse(x, y);
}

/* ─── init ──────────────────────────────────────────────────────────────── */
export function initEditor(gameAPI) {
  api = gameAPI;
  raycaster = new THREE.Raycaster();
  buildGhosts();
  buildTopCamera();
  injectStyles();
  buildUI();
  bindKeys();
  bindMouse();
  startGhostLoop();

  /* Last-chance flush: a dev-server reload or accidental refresh fires this
     before the page dies, so in-progress builds always survive. */
  window.addEventListener('beforeunload', () => { if (st.active) saveToBrowser(false); });

  if (new URLSearchParams(location.search).has('editor')
      || sessionStorage.getItem('editorMode') === '1') {
    sessionStorage.removeItem('editorMode');
    activateEditor();
  }
}

/* ─── activate / deactivate ─────────────────────────────────────────────── */
export function activateEditor() {
  if (!api) return;
  st.active = true; st.playing = false;
  window.__editorMode = true;
  window.__editorActive = true;
  window.__editorPhysicsFrozen = true;
  window.__editorOverrideCamera = null;

  api.beginTemplateSandboxLevel();
  restoreFromBrowser();   // bring back the last session's build (autosave / Ctrl-S)
  showUI(true);
  setView('3d');
  hideHud(true);

  /* grab pointer lock immediately so WASD works right away */
  api.renderer.domElement.requestPointerLock();
  updateBadge();
}

function deactivateEditor() {
  saveToBrowser(false);   // flush the session before leaving the editor
  st.active = false; st.playing = false;
  st.trenchDrawing = false;
  st.trenchLastPos = null;
  window.__editorMode = false;
  window.__editorActive = false;
  window.__editorPhysicsFrozen = false;
  window.__editorOverrideCamera = null;
  setCrosshairCentered();
  showUI(false);
  closeDropdowns();
  hideHud(false);
  setGhostsVisible(false);
  if (topHelper) topHelper.visible = false;
  if (document.pointerLockElement) document.exitPointerLock();
}

function hideHud(hide) {
  ['hud', 'ammoPanel', 'weaponBar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = hide ? 'none' : '';
  });
}

/* ─── ghosts ────────────────────────────────────────────────────────────── */

/* Build a right-angle ramp (triangular prism) ghost for wedge bricks.
   Centred at origin: bottom at y=-h/2, ramp rises to y=+h/2 at back (z=+d/2). */
function makeWedgeGhostGeo(w, h, d) {
  const x0 = -w/2, x1 = w/2, y0 = -h/2, y1 = h/2, z0 = -d/2, z1 = d/2;
  const v = new Float32Array([
    x0, y0, z0,  x1, y0, z0,   // front bottom (0,1)
    x0, y0, z1,  x1, y0, z1,   // back  bottom (2,3)
    x0, y1, z1,  x1, y1, z1,   // back  top    (4,5)
  ]);
  const idx = [0,1,3, 0,3,2, 2,3,5, 2,5,4, 0,2,4, 1,5,3, 0,4,5, 0,5,1];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/* helper: current decor variant record */
function currentDecorVariant() {
  const def = DECOR_DEFS[st.decorType] || DECOR_DEFS.shrub;
  return def.variants[st.decorVariant % def.variants.length];
}

function rebuildDecorGhost() {
  if (decorGhost) { api.scene.remove(decorGhost); decorGhost.geometry?.dispose(); }
  const v = currentDecorVariant();
  const geo = new THREE.BoxGeometry(v.w, v.h, v.d);
  decorGhost = new THREE.Mesh(geo,
    new THREE.MeshStandardMaterial({ color: v.col, transparent: true, opacity: 0.38, depthWrite: false }));
  decorGhost.renderOrder = 999;
  decorGhost.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: v.col })));
  decorGhost.visible = false;
  api.scene.add(decorGhost);
}

function buildGhostMeshForRot(rot) {
  const isWedge = (rot.fn === 'createBrickAngled');
  let geo;
  if (isWedge && api && api.towerInst && api.towerInst.geometry) {
    geo = api.towerInst.geometry.clone();
  } else {
    geo = new THREE.BoxGeometry(rot.w, rot.h, rot.d);
  }
  const mesh = new THREE.Mesh(geo,
    new THREE.MeshStandardMaterial({ color: rot.col, transparent: true, opacity: 0.38, depthWrite: false }));
  mesh.renderOrder = 999;
  mesh.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: rot.col })));
  if (isWedge) {
    if (rot.quat) mesh.quaternion.copy(rot.quat);
    else mesh.rotation.y = rot.angle || 0;
  }
  mesh.visible = false;
  return mesh;
}

function buildGhosts() {
  /* brick ghost – sized to current shape/rotation */
  const rot = currentRot();
  ghost = buildGhostMeshForRot(rot);
  api.scene.add(ghost);

  /* NPC ghost – green cylinder */
  const npcGeo = new THREE.CylinderGeometry(0.38, 0.38, 1.9, 12, 1, true);
  npcGhost = new THREE.Mesh(npcGeo,
    new THREE.MeshStandardMaterial({ color: 0x44ff88, transparent: true, opacity: 0.38,
      depthWrite: false, side: THREE.DoubleSide }));
  npcGhost.renderOrder = 999;
  npcGhost.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.38, 0.38, 1.9, 12)),
    new THREE.LineBasicMaterial({ color: 0x88ffaa })));
  npcGhost.visible = false;
  api.scene.add(npcGhost);

  /* Decor ghost – sized box that changes when decor type changes */
  rebuildDecorGhost();
}

function rebuildBrickGhost() {
  if (!ghost) return;
  api.scene.remove(ghost);
  ghost.geometry.dispose();
  const rot = currentRot();
  ghost = buildGhostMeshForRot(rot);
  api.scene.add(ghost);
}

function setGhostsVisible(v) {
  if (ghost)       ghost.visible       = v && st.itemType === 'brick';
  if (npcGhost)    npcGhost.visible    = v && st.itemType === 'npc';
  if (decorGhost)  decorGhost.visible  = v && st.itemType === 'decor';
}

/* ─── ghost loop ──────────────────────────────────────────────────────────── */
function startGhostLoop() {
  (function loop() {
    requestAnimationFrame(loop);
    if (!st.active) return;
    if (st.playing) { setGhostsVisible(false); return; }
    if (st.view === 'topdown') syncTopdownCrosshairFromNdc();
    const pos = placementPos();
    if (!pos) { setGhostsVisible(false); return; }
    const erase = st.tool === 'erase';
    if (st.itemType === 'brick') {
      const rot = currentRot();
      const isTrench = st.brickShape === 'trench';
      if (isTrench) {
        const size = Math.max(0.5, Math.min(3, st.trenchBrushSize || 0.5));
        const snapped = snapTrenchBrushPos(pos.x, pos.z, size);
        const sc = size / 0.5;
        ghost.scale.set(sc, 1, sc);
        ghost.position.set(snapped.x, pos.y - rot.h * 0.5 + 0.08, snapped.z);
      } else {
        ghost.scale.set(1, 1, 1);
        ghost.position.set(pos.x, pos.y + rot.h * 0.5, pos.z);
      }
      if (rot.angle !== undefined || rot.quat) {
        /* Wedge ghost mirrors the face-angle snap so the preview shows the
           exact voussoir pose that will be placed. */
        if (st.wedgeSnapQuat)  ghost.quaternion.copy(st.wedgeSnapQuat);
        else if (rot.quat)     ghost.quaternion.copy(rot.quat);
        else                   ghost.rotation.set(0, rot.angle || 0, 0);
      }
      const ne = newBrickHalfExtents();
      const blocked = !erase && overlapsAnyBrick(pos.x, pos.y + ne.halfY, pos.z, ne.halfX, ne.halfY, ne.halfZ);
      ghost.material.color.set(erase ? 0xff4444 : blocked ? 0xff8800 : rot.col);
      ghost.visible = true;
      if (npcGhost)   npcGhost.visible   = false;
      if (decorGhost) decorGhost.visible = false;
    } else if (st.itemType === 'npc') {
      npcGhost.position.set(pos.x, pos.y + 0.95, pos.z);
      npcGhost.material.color.set(erase ? 0xff4444 : 0x44ff88);
      npcGhost.visible = true;
      ghost.visible = false;
      if (decorGhost) decorGhost.visible = false;
    } else {
      /* decor */
      if (decorGhost) {
        const v = currentDecorVariant();
        decorGhost.position.set(pos.x, v.h * 0.5, pos.z);
        decorGhost.material.color.set(erase ? 0xff4444 : v.col);
        decorGhost.visible = true;
      }
      ghost.visible = false;
      if (npcGhost) npcGhost.visible = false;
    }
  })();
}

/* helper: current rotation record */
function currentRot() {
  const sh = SHAPES[st.brickShape] || SHAPES.brick;
  return sh.rotations[st.brickRot % sh.rotations.length];
}

/* per-mesh half-extents { halfH, halfX, halfZ } — populated lazily in placementPos() */
const INST_HALF_H = new Map();

/* half-extents of the brick type currently selected for placement */
function newBrickHalfExtents() {
  const rot = currentRot();
  return { halfX: rot.w / 2, halfY: rot.h / 2, halfZ: rot.d / 2 };
}

/* AABB overlap check against all live bricks — used to block/preview placements */
function overlapsAnyBrick(cx, cy, cz, halfX, halfY, halfZ) {
  if (!api.bricks) return false;
  const eps = st.halfSnap ? 0.50 : 0.05;
  const newIsWedge = currentRot().fn === 'createBrickAngled';
  for (const b of api.bricks) {
    if (!b.body || b.body.position.y < -100) continue;
    /* Wedge vs wedge: the boxy test can't represent angled voussoirs — ring
       neighbours overlap in AABB at diagonal angles even though their mating
       faces just touch. Neighbouring centres sit ~2 m apart (one chord), so
       clear anything farther than 1.55 m horizontally on the same course. */
    if (newIsWedge && b.isWedge) {
      const wdx = b.body.position.x - cx;
      const wdz = b.body.position.z - cz;
      if (Math.hypot(wdx, wdz) > 1.55) continue;
    }
    const [bhx, bhy, bhz] = b.isPlank
                           ? (b.isZ ? [0.375, 0.375, 0.75] : [0.75, 0.375, 0.375])
                           : b.isZ ? [0.5, 0.5, 1.0]
                           : b.isY ? [0.5, 1.0, 0.5]
                           : b.isCube ? [0.5, 0.5, 0.5]
                           : b.isWedge ? [1.0, 0.5, 1.0]
                           : [1.0, 0.5, 0.5];
    if (Math.abs(b.body.position.x - cx) < bhx + halfX - eps &&
        Math.abs(b.body.position.y - cy) < bhy + halfY - eps &&
        Math.abs(b.body.position.z - cz) < bhz + halfZ - eps) return true;
  }
  return false;
}

function placementPos() {
  const cam = st.view === 'topdown' ? topCam : api.camera;
  const ndc = st.view === 'topdown' ? st.mouseNdc : { x: 0, y: 0 };
  raycaster.setFromCamera(ndc, cam);
  st.wedgeSnapQuat = null;   // reset every query; only 3-D face hits set it

  /* Decor always places on the ground regardless of view */
  if (st.itemType === 'decor') {
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const t = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, t)) return null;
    return new THREE.Vector3(Math.round(t.x * 2) / 2, 0, Math.round(t.z * 2) / 2);
  }

  /* 3-D: read the hit face normal and snap to the correct adjacent slot */
  if (st.view === '3d') {
    if (!INST_HALF_H.size) {
      if (api.brickInstX) INST_HALF_H.set(api.brickInstX, { halfH: 0.5, halfX: 1.0, halfZ: 0.5 });
      if (api.brickInstZ) INST_HALF_H.set(api.brickInstZ, { halfH: 0.5, halfX: 0.5, halfZ: 1.0 });
      if (api.brickInstC) INST_HALF_H.set(api.brickInstC, { halfH: 0.5, halfX: 0.5, halfZ: 0.5 });
      if (api.brickInstY) INST_HALF_H.set(api.brickInstY, { halfH: 1.0, halfX: 0.5, halfZ: 0.5 });
      if (api.towerInst)  INST_HALF_H.set(api.towerInst,  { halfH: 0.5, halfX: 1.0, halfZ: 1.0 });
      if (api.plankInstX) INST_HALF_H.set(api.plankInstX, { halfH: 0.375, halfX: 0.75,  halfZ: 0.375 });
      if (api.plankInstZ) INST_HALF_H.set(api.plankInstZ, { halfH: 0.375, halfX: 0.375, halfZ: 0.75  });
      /* three.js caches an InstancedMesh bounding sphere on first raycast and
         never refreshes it — bricks placed outside the original castle bounds
         would be invisible to the ray. Use a permissive manual sphere instead
         (meshes are already frustumCulled = false, so this costs nothing). */
      for (const mesh of INST_HALF_H.keys())
        mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
    }
    const _mat = new THREE.Matrix4();
    const _pos = new THREE.Vector3();
    const _bestMat = new THREE.Matrix4();
    let bestPoint = null, bestDist = Infinity, bestCenter = null, bestExts = null, bestNormal = null;
    let bestMesh = null, bestLocalNormal = null;

    for (const [mesh, exts] of INST_HALF_H) {
      for (const h of raycaster.intersectObject(mesh, false)) {
        if (h.distance >= bestDist || !h.face) continue;
        mesh.getMatrixAt(h.instanceId, _mat);
        _mat.premultiply(mesh.matrixWorld);
        _pos.setFromMatrixPosition(_mat);
        if (_pos.y < -100) continue;
        bestDist   = h.distance;
        bestPoint  = h.point.clone();
        bestCenter = _pos.clone();
        bestExts   = exts;
        bestMesh   = mesh;
        bestLocalNormal = h.face.normal.clone();
        _bestMat.copy(_mat);
        /* face.normal is geometry-local — rotate by the instance transform so
           rotated instances (wedges) report their true world-space face */
        bestNormal = h.face.normal.clone().transformDirection(_mat);
      }
    }

    if (bestPoint && bestNormal) {
      const ne  = newBrickHalfExtents();
      const newH = ne.halfY * 2;

      /* ── Wedge-on-wedge: snap at the FACE ANGLE so rings/circles continue ──
         Tower voussoirs are trapezoids whose flat side faces mate at the ring
         segment angle. The ring axis is the hit wedge's local +Y and the ring
         centre sits R along its local −Z, so the same quaternion math carries
         horizontal tower rings AND vertical arches (bridge tunnels): aim at a
         mating side face for the next voussoir around the ring, or at the
         local top/bottom face to extend the ring sideways (barrel vaults /
         tower courses). */
      const placingWedge = currentRot().fn === 'createBrickAngled';
      if (placingWedge && bestMesh === api.towerInst
          && Number.isFinite(api.towerRingStep) && Number.isFinite(api.towerRingRadius)) {
        const hitQ = new THREE.Quaternion().setFromRotationMatrix(_bestMat);
        const R = api.towerRingRadius, step = api.towerRingStep;
        if (Math.abs(bestLocalNormal.y) < 0.4 && Math.abs(bestLocalNormal.x) > 0.5) {
          /* Mating side face — rotate one segment about the ring axis. Local
             +X face borders the neighbour at +step. */
          const sign = bestLocalNormal.x > 0 ? 1 : -1;
          const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(hitQ);
          const radial = new THREE.Vector3(0, 0, 1).applyQuaternion(hitQ);
          const ringC = bestCenter.clone().addScaledVector(radial, -R);
          const dq = new THREE.Quaternion().setFromAxisAngle(axis, sign * step);
          const newCenter = bestCenter.clone().sub(ringC).applyQuaternion(dq).add(ringC);
          st.wedgeSnapQuat = dq.multiply(hitQ);
          return new THREE.Vector3(newCenter.x, newCenter.y - ne.halfY, newCenter.z);
        }
        if (Math.abs(bestLocalNormal.y) > 0.5) {
          /* Local top/bottom face — next course with the same pose: straight
             up on towers, sideways along the tunnel axis on vertical arches. */
          const dir = new THREE.Vector3(0, Math.sign(bestLocalNormal.y), 0).applyQuaternion(hitQ);
          const newCenter = bestCenter.clone().addScaledVector(dir, bestExts.halfH * 2);
          st.wedgeSnapQuat = hitQ;
          return new THREE.Vector3(newCenter.x, newCenter.y - ne.halfY, newCenter.z);
        }
      }

      /* Snap X / Z relative to the HIT BRICK's centre — new bricks always
         align with the existing structure regardless of where it started. */
      const stepX = st.halfSnap ? ne.halfX : (ne.halfX * 2);
      const stepZ = st.halfSnap ? ne.halfZ : (ne.halfZ * 2);
      const snapX = v => bestCenter.x + Math.round((v - bestCenter.x) / stepX) * stepX;
      const snapZ = v => bestCenter.z + Math.round((v - bestCenter.z) / stepZ) * stepZ;

      /* Row alignment on side faces: align to the floor row of the hit brick. */
      const hitBase = bestCenter.y - bestExts.halfH;
      const sideY = (hitY) => {
        const row = Math.max(0, Math.floor((hitY - hitBase) / newH));
        return Math.max(0, hitBase + row * newH);
      };

      /* Top-face axis snap.
         1. Compute global grid position closest to the hit point.
         2. Clamp the result so the new brick center is always WITHIN the hit
            brick's face (prevents the ghost jumping outside when aiming at an edge).
         Special case: if the hit brick is no wider than the new brick on this axis,
         just centre the new brick. */
      const snapTopAxis = (v, center, hitHalf, newHalf) => {
        const step = st.halfSnap ? newHalf : (newHalf * 2);
        if (!st.halfSnap && hitHalf <= newHalf) return center;
        // Global-grid snap of the hit point
        const globalSnap = Math.round(v / step) * step;
        // Full snap keeps the new brick fully inside the hit face.
        // Half snap allows half-brick overhang so staggered stacked courses work.
        const inner = st.halfSnap ? hitHalf : (hitHalf - newHalf);
        // Clamp into [−inner, +inner] relative to the hit brick centre
        return center + Math.max(-inner, Math.min(inner, globalSnap - center));
      };

      if (bestNormal.y > 0.5) {
        /* TOP face – always lands on the hit brick */
        return new THREE.Vector3(
          snapTopAxis(bestPoint.x, bestCenter.x, bestExts.halfX, ne.halfX),
          bestCenter.y + bestExts.halfH,
          snapTopAxis(bestPoint.z, bestCenter.z, bestExts.halfZ, ne.halfZ)
        );
      } else if (Math.abs(bestNormal.x) > 0.5) {
        /* ±X side face — the adjacent slot is exact (hit centre ± touching
           half-extents); re-snapping it to the global grid rounded half-step
           structures back INTO the hit brick, blocking placement. */
        return new THREE.Vector3(
          bestCenter.x + Math.sign(bestNormal.x) * (bestExts.halfX + ne.halfX),
          sideY(bestPoint.y),
          snapZ(bestPoint.z)
        );
      } else if (Math.abs(bestNormal.z) > 0.5) {
        /* ±Z side face */
        return new THREE.Vector3(
          snapX(bestPoint.x),
          sideY(bestPoint.y),
          bestCenter.z + Math.sign(bestNormal.z) * (bestExts.halfZ + ne.halfZ)
        );
      }
    }
  }

  /* 3-D fallback: ray against Y=0 ground plane so bricks can always be placed
     on the floor without needing a Y-level adjustment. */
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const t = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(groundPlane, t)) return null;
  const ne2 = newBrickHalfExtents();
  const stepX = st.halfSnap ? ne2.halfX : (ne2.halfX * 2);
  const stepZ = st.halfSnap ? ne2.halfZ : (ne2.halfZ * 2);
  return new THREE.Vector3(
    Math.round(t.x / stepX) * stepX,
    0,
    Math.round(t.z / stepZ) * stepZ
  );
}


/* ─── top-down camera ───────────────────────────────────────────────────── */
function buildTopCamera() {
  const a = window.innerWidth / window.innerHeight;
  const h = st.topZoom;
  topCam = new THREE.OrthographicCamera(-h * a, h * a, h, -h, 0.1, 2000);
  // Looking straight down with default up=(0,1,0) makes lookAt ambiguous.
  // Use a horizontal up vector for a stable top-down orientation.
  topCam.up.set(0, 0, -1);
  syncTopCam();
}

function syncTopCam() {
  const a = window.innerWidth / window.innerHeight;
  const h = st.topZoom;
  Object.assign(topCam, { left: -h * a, right: h * a, top: h, bottom: -h });
  topCam.updateProjectionMatrix();
  // Keep camera around 50m above ground as requested.
  topCam.position.set(st.topPanX, 50, st.topPanZ);
  topCam.lookAt(st.topPanX, 0, st.topPanZ);
}

function setView(v) {
  st.view = v;
  st.trenchDrawing = false;
  st.trenchLastPos = null;
  setActive('ed-btn-3d',  v === '3d');
  setActive('ed-btn-top', v === 'topdown');
  const h3  = document.getElementById('ed-3d-help');
  const htd = document.getElementById('ed-topdown-help');
  if (h3)  h3.style.display  = v === '3d'      ? 'block' : 'none';
  if (htd) htd.style.display = v === 'topdown' ? 'block' : 'none';
  if (v === 'topdown') {
    if (document.pointerLockElement) document.exitPointerLock();
    syncTopCam();
    syncTopdownCrosshairFromNdc();
    window.__editorOverrideCamera = topCam;
    if (!topHelper) {
      topHelper = new THREE.GridHelper(500, 500, 0x555555, 0x333333);
      topHelper.position.y = 0.06;
      api.scene.add(topHelper);
    }
    topHelper.visible = true;
  } else {
    window.__editorOverrideCamera = null;
    if (topHelper) topHelper.visible = false;
    setCrosshairCentered();
    api.renderer.domElement.requestPointerLock();
  }
}

/* ─── placement ─────────────────────────────────────────────────────────── */
function doPlace() {
  if (st.playing) return;
  if (isTrenchBrushActive()) {
    placeTrenchStrokeStep();
    return;
  }
  const pos = placementPos();
  if (!pos) return;
  if (st.itemType === 'decor')      placeDecor(pos);
  else if (st.itemType === 'brick') placeBrick(pos);
  else                               placeNPC(pos);
}

function doErase() {
  if (st.playing) return;
  const pos = placementPos();
  if (pos) eraseNearest(pos);
}

function placeBrick(pos) {
  const rot = currentRot();
  const fn = api[rot.fn];
  if (!fn) return;
  if (rot.fn === 'createEditorTrench') {
    const size = Math.max(0.5, Math.min(3, st.trenchBrushSize || rot.w || 0.5));
    const snapped = snapTrenchBrushPos(pos.x, pos.z, size);
    const trench = fn(snapped.x, snapped.z, size, size, 0.7, st.trenchWater);
    if (trench) {
      placed.push({ type: 'trench', trenchEntry: trench, size: { w: size, d: size, depth: 0.7 }, water: st.trenchWater });
      setUndoState(true);
      scheduleAutosave();
    }
    return;
  }
  const ne = newBrickHalfExtents();
  if (overlapsAnyBrick(pos.x, pos.y + ne.halfY, pos.z, ne.halfX, ne.halfY, ne.halfZ)) return;
  const prev = api.bricks.length;
  if (rot.fn === 'createBrickAngled') {
    /* Face-angle snap (ring continuation) overrides the catalogue pose. */
    const q = st.wedgeSnapQuat
      || rot.quat
      || new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rot.angle || 0, 0));
    if (api.createBrickAngledQuat) {
      api.createBrickAngledQuat(pos.x, pos.y + rot.h * 0.5, pos.z, q);
    } else {
      fn(pos.x, pos.y + rot.h * 0.5, pos.z, rot.angle || 0);
    }
  } else {
    fn(pos.x, pos.y + rot.h * 0.5, pos.z);
  }
  if (api.bricks.length > prev) {
    const e = api.bricks[api.bricks.length - 1];
    if (e.body) { e.body.type = 0; e.body.updateMassProperties(); e.body.sleep(); }
    placed.push({ type: 'brick', brickEntry: e });
    setUndoState(true);
    scheduleAutosave();
  }
}

function placeNPC(pos) {
  const prev = api.npcList.length;
  api.buildNPC(pos.x, pos.z, 0, Math.PI, st.npcWeapon);
  if (api.npcList.length > prev) {
    const e = api.npcList[api.npcList.length - 1];
    if (e.bodies) for (const b of e.bodies) { b.type = 0; b.sleep(); }
    if (e.group) e.group.visible = true;
    placed.push({ type: 'npc', npcEntry: e, weapon: st.npcWeapon });
    setUndoState(true);
    scheduleAutosave();
  }
}

function placeDecor(pos) {
  const v = currentDecorVariant();
  const fn = api[v.fn];
  if (!fn) return;
  const entry = fn(pos.x, pos.z, ...(v.args || []));
  if (entry) {
    placed.push({ type: 'decor', decorEntry: entry });
    setUndoState(true);
    scheduleAutosave();
  }
}

function eraseNearest(pos) {
  let best = -1, bestD = 5;
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    let px = 0, pz = 0;
    if (p.type === 'brick' && p.brickEntry?.body)  { px = p.brickEntry.body.position.x; pz = p.brickEntry.body.position.z; }
    else if (p.type === 'npc' && p.npcEntry?.group) { px = p.npcEntry.group.position.x;  pz = p.npcEntry.group.position.z; }
    else if (p.type === 'trench' && p.trenchEntry) { px = p.trenchEntry.x; pz = p.trenchEntry.z; }
    else if (p.type === 'decor' && p.decorEntry)   { px = p.decorEntry.x; pz = p.decorEntry.z; }
    else continue;
    const d = Math.hypot(pos.x - px, pos.z - pz);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best >= 0) removeItem(best);
}

function isTrenchBrushActive() {
  return st.active
    && !st.playing
    && st.tool === 'place'
    && st.itemType === 'brick'
    && st.brickShape === 'trench'
    && st.view === 'topdown';
}

function trenchPointerPos() {
  if (!topCam) return null;
  raycaster.setFromCamera(st.mouseNdc, topCam);
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const t = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(groundPlane, t)) return null;
  return t;
}

function snapTrenchBrushPos(x, z, size) {
  const snap = value => Math.round((Math.round(value / size) * size) * 1000) / 1000;
  return { x: snap(x), z: snap(z) };
}

function placeTrenchStampAt(x, z) {
  const rot = currentRot();
  if (rot.fn !== 'createEditorTrench' || !api.createEditorTrench) return;
  const size = Math.max(0.5, Math.min(3, st.trenchBrushSize || rot.w || 0.5));
  const snapped = snapTrenchBrushPos(x, z, size);
  x = snapped.x;
  z = snapped.z;

  const minDist = size * 0.5;
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i];
    if (p.type !== 'trench' || !p.trenchEntry) continue;
    const d = Math.hypot(x - p.trenchEntry.x, z - p.trenchEntry.z);
    if (d < minDist) return;
  }

  const trench = api.createEditorTrench(x, z, size, size, 0.7, st.trenchWater);
  if (!trench) return;
  placed.push({ type: 'trench', trenchEntry: trench, size: { w: size, d: size, depth: 0.7 }, water: st.trenchWater });
  setUndoState(true);
  scheduleAutosave();
}

function placeTrenchStrokeStep() {
  const p = trenchPointerPos();
  if (!p) return;
  const cur = new THREE.Vector2(p.x, p.z);

  if (!st.trenchLastPos) {
    placeTrenchStampAt(cur.x, cur.y);
    st.trenchLastPos = cur;
    return;
  }

  const last = st.trenchLastPos;
  const dx = cur.x - last.x;
  const dz = cur.y - last.y;
  const dist = Math.hypot(dx, dz);
  const step = Math.max(0.15, (st.trenchBrushSize || 0.5) * 0.3);
  const n = Math.max(1, Math.floor(dist / step));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    placeTrenchStampAt(last.x + dx * t, last.y + dz * t);
  }
  st.trenchLastPos = cur;
}

function removeItem(idx) {
  const p = placed[idx]; if (!p) return;
  if (p.type === 'brick' && p.brickEntry) {
    const b = p.brickEntry;
    if (b.body) { b.body.position.set(0, -999, 0); b.body.sleep(); }
    const inst = b.isPlank
               ? (b.isZ ? api.plankInstZ : api.plankInstX)
               : b.isZ ? api.brickInstZ : b.isY ? api.brickInstY
               : b.isCube ? api.brickInstC : b.isWedge ? api.towerInst : api.brickInstX;
    if (inst) { inst.setMatrixAt(b.idx, new THREE.Matrix4().makeTranslation(0, -999, 0)); inst.instanceMatrix.needsUpdate = true; }
    const bi = api.bricks.indexOf(b); if (bi >= 0) api.bricks.splice(bi, 1);
  } else if (p.type === 'npc' && p.npcEntry) {
    if (p.npcEntry.group) api.scene.remove(p.npcEntry.group);
    const ni = api.npcList.indexOf(p.npcEntry); if (ni >= 0) api.npcList.splice(ni, 1);
  } else if (p.type === 'trench' && p.trenchEntry) {
    if (api.removeEditorTrench) api.removeEditorTrench(p.trenchEntry);
  } else if (p.type === 'decor' && p.decorEntry) {
    if (api.removeEditorDecor) api.removeEditorDecor(p.decorEntry);
  }
  placed.splice(idx, 1);
  setUndoState(placed.length > 0);
  scheduleAutosave();
}

const undoLast = () => { if (placed.length) removeItem(placed.length - 1); };

/* ─── SAVE / EXPORT / IMPORT ───────────────────────────────────── */
const SAVE_KEY = 'castleEditorLevel';
let _autosaveTimer = null;

/* Serialize everything placed this session into a portable JSON structure. */
function serializeLevel() {
  const items = [];
  for (const p of placed) {
    if (p.type === 'brick' && p.brickEntry?.body) {
      const b = p.brickEntry;
      // While physics is live, use the frozen edit-time pose, not the rubble.
      const pos  = (st.playing && p._savedPos)  ? p._savedPos  : b.body.position;
      const quat = (st.playing && p._savedQuat) ? p._savedQuat : b.body.quaternion;
      const kind = b.isPlank ? (b.isZ ? 'plankz' : 'plankx')
                 : b.isCube ? 'cube' : b.isY ? 'y' : b.isZ ? 'z' : b.isWedge ? 'wedge' : 'x';
      const item = { t: 'brick', k: kind,
        p: [+pos.x.toFixed(3), +pos.y.toFixed(3), +pos.z.toFixed(3)] };
      if (kind === 'wedge')
        item.q = [+quat.x.toFixed(5), +quat.y.toFixed(5), +quat.z.toFixed(5), +quat.w.toFixed(5)];
      items.push(item);
    } else if (p.type === 'npc' && p.npcEntry?.group) {
      const gp = p.npcEntry.group.position;
      items.push({ t: 'npc', p: [+gp.x.toFixed(3), +gp.z.toFixed(3)], w: p.weapon || 'sword' });
    } else if (p.type === 'trench' && p.trenchEntry) {
      const t = p.trenchEntry;
      const size = p.size || { w: t.length || 8, d: t.width || 3, depth: t.depth || 0.7 };
      items.push({ t: 'trench', p: [+t.x.toFixed(3), +t.z.toFixed(3)], s: [+size.w.toFixed(3), +size.d.toFixed(3), +size.depth.toFixed(3)], w: p.water === true });
    } else if (p.type === 'decor' && p.decorEntry) {
      const d = p.decorEntry;
      items.push({ t: 'decor', k: d.kind, v: d.variant, p: [+d.x.toFixed(3), +d.z.toFixed(3)] });
    }
  }
  return { format: 'castle-level', version: 1, savedAt: new Date().toISOString(), items };
}

function clearPlaced() { while (placed.length) removeItem(placed.length - 1); }

function restoreDecorEntry(kind, variant, x, z) {
  switch (kind) {
    case 'shrub':  return api.createEditorDecorShrub?.(x, z);
    case 'tree':   return api.createEditorDecorTree?.(x, z);
    case 'plank': {
      /* legacy save used decor plank; now uses instanced brick-style planks */
      const ri = variant === 'pz' ? 1 : 0;
      const groundY = 0.375; // PS.h/2 — ground-level placement
      return (ri === 1 ? api.createEditorPlankZ?.(x, groundY, z) : api.createEditorPlankX?.(x, groundY, z)) ?? null;
    }
    case 'banner': {
      const ci = parseInt((variant || 'b0').replace('b', ''), 10) || 0;
      return api.createEditorDecorBanner?.(x, z, ci);
    }
    default: return null;
  }
}

/* Rebuild a serialized level. Replaces whatever is currently placed. */
function restoreLevel(data) {
  if (!data || data.format !== 'castle-level' || !Array.isArray(data.items)) return 0;
  clearPlaced();
  let n = 0;
  for (const it of data.items) {
    if (it.t === 'brick' && Array.isArray(it.p)) {
      const [x, y, z] = it.p;
      const prev = api.bricks.length;
      if (it.k === 'wedge' && api.createBrickAngledQuat) {
        const q = new THREE.Quaternion(...(Array.isArray(it.q) ? it.q : [0, 0, 0, 1]));
        api.createBrickAngledQuat(x, y, z, q);
      }
      else if (it.k === 'plankx') api.createEditorPlankX?.(x, y, z);
      else if (it.k === 'plankz') api.createEditorPlankZ?.(x, y, z);
      else if (it.k === 'cube') api.createBrickCube(x, y, z);
      else if (it.k === 'y')    api.createBrickY(x, y, z);
      else if (it.k === 'z')    api.createBrickZ(x, y, z);
      else                      api.createBrick(x, y, z);
      if (api.bricks.length > prev) {
        const e = api.bricks[api.bricks.length - 1];
        if (e.body) { e.body.type = 0; e.body.updateMassProperties(); e.body.sleep(); }
        placed.push({ type: 'brick', brickEntry: e });
        n++;
      }
    } else if (it.t === 'npc' && Array.isArray(it.p)) {
      const prevN = api.npcList.length;
      api.buildNPC(it.p[0], it.p[1], 0, Math.PI, it.w || 'sword');
      if (api.npcList.length > prevN) {
        const e = api.npcList[api.npcList.length - 1];
        if (e.bodies) for (const b of e.bodies) { b.type = 0; b.sleep(); }
        if (e.group) e.group.visible = true;
        placed.push({ type: 'npc', npcEntry: e, weapon: it.w || 'sword' });
        n++;
      }
    } else if (it.t === 'trench' && Array.isArray(it.p) && api.createEditorTrench) {
      const s = Array.isArray(it.s) ? it.s : [8, 3, 0.7];
      const width = Math.max(0.5, Math.min(3, Number(s[0]) || 0.5));
      const length = Math.max(0.5, Math.min(3, Number(s[1]) || 0.5));
      s[2] = 0.7;
      const withWater = it.w === true;
      const trench = api.createEditorTrench(it.p[0], it.p[1], width, length, s[2], withWater);
      if (trench) {
        placed.push({ type: 'trench', trenchEntry: trench, size: { w: width, d: length, depth: s[2] }, water: withWater });
        n++;
      }
    } else if (it.t === 'decor' && Array.isArray(it.p)) {
      const entry = restoreDecorEntry(it.k, it.v, it.p[0], it.p[1]);
      if (entry) { placed.push({ type: 'decor', decorEntry: entry }); n++; }
    }
  }
  setUndoState(placed.length > 0);
  scheduleAutosave();
  return n;
}

function saveToBrowser(showFlash = false) {
  try {
    const data = serializeLevel();
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    if (showFlash) flashBanner(`\ud83d\udcbe Level saved — ${data.items.length} item${data.items.length === 1 ? '' : 's'}`, '#22dd66');
    return true;
  } catch (err) {
    if (showFlash) flashBanner('\u26a0 Save failed (storage unavailable?)', '#ff5544');
    return false;
  }
}

/* Debounced autosave — every placement/erase lands in browser storage within
   ~1 s, so a page refresh or dev-server reload can never eat a build again. */
function scheduleAutosave() {
  clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(() => saveToBrowser(false), 1000);
}

function restoreFromBrowser() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { return; }
  if (!data || !Array.isArray(data.items) || !data.items.length) return;
  const n = restoreLevel(data);
  if (n > 0) flashBanner(`\u21bb Restored ${n} item${n === 1 ? '' : 's'} from last save`, '#44aaff');
}

function exportLevel() {
  const data = serializeLevel();
  if (!data.items.length) { flashBanner('Nothing to export yet — place some bricks first', '#ff8800'); return; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  a.download = `castle-level-${ts}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  flashBanner(`\u2b07 Exported ${data.items.length} item${data.items.length === 1 ? '' : 's'} — share the file to import elsewhere`, '#44aaff');
}

function importLevelFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      const n = restoreLevel(data);
      if (n > 0) { saveToBrowser(false); flashBanner(`\ud83d\udcc2 Imported ${n} item${n === 1 ? '' : 's'}`, '#22dd66'); }
      else flashBanner('\u26a0 Not a valid castle-level file', '#ff5544');
    } catch {
      flashBanner('\u26a0 Could not read level file', '#ff5544');
    }
  };
  reader.readAsText(file);
}

/* ─── PLAY ──────────────────────────────────────────────────────────────── */
function hitPlay() {
  if (st.playing) return;
  st.playing = true;
  st.trenchDrawing = false;
  st.trenchLastPos = null;
  window.__editorActive = false;
  window.__editorPhysicsFrozen = false;
  for (const p of placed) {
    if (p.type === 'brick' && p.brickEntry?.body) {
      const b = p.brickEntry.body;
      // Save position/quaternion so hitStop can restore them
      p._savedPos  = { x: b.position.x,   y: b.position.y,   z: b.position.z };
      p._savedQuat = { x: b.quaternion.x, y: b.quaternion.y, z: b.quaternion.z, w: b.quaternion.w };
      b.type = 1; b.updateMassProperties();
      // Start ASLEEP, exactly like the prebuilt levels: waking every brick at
      // once makes gravity+solver settle the whole structure in one burst (a
      // visible jump that can collapse stacks). Sleeping bodies get no gravity
      // and only wake when something actually hits or undermines them.
      b.velocity.set(0, 0, 0);
      b.angularVelocity.set(0, 0, 0);
      b.sleep();
    }
    if (p.type === 'npc' && p.npcEntry?.bodies)
      for (const b of p.npcEntry.bodies) { b.type = 1; b.sleep(); }
  }
  hideHud(false);
  if (st.view === 'topdown') setView('3d');
  setGhostsVisible(false);
  const btn = document.getElementById('ed-play-btn');
  if (btn) { btn.textContent = '⏹ Stop'; btn.onclick = hitStop; btn.className = btn.className.replace('ed-play','ed-stop'); }
  const bb = document.getElementById('ed-brickbar'); if (bb) bb.style.display = 'none';
  flashBanner('▶  Physics live!', '#22dd66');
}

function hitStop() {
  if (!st.playing) return;
  st.playing = false;
  window.__editorActive = true;
  window.__editorPhysicsFrozen = true;
  for (const p of placed) {
    if (p.type === 'brick' && p.brickEntry?.body) {
      const b = p.brickEntry.body;
      if (p._savedPos)  { b.position.x = p._savedPos.x;  b.position.y = p._savedPos.y;  b.position.z = p._savedPos.z; }
      if (p._savedQuat) { b.quaternion.x = p._savedQuat.x; b.quaternion.y = p._savedQuat.y; b.quaternion.z = p._savedQuat.z; b.quaternion.w = p._savedQuat.w; }
      b.velocity.set(0, 0, 0);
      b.angularVelocity.set(0, 0, 0);
      b.force.set(0, 0, 0);
      b.torque.set(0, 0, 0);
      b.sleep();
    }
    if (p.type === 'npc' && p.npcEntry?.bodies) {
      for (const b of p.npcEntry.bodies) {
        b.velocity.set(0, 0, 0);
        b.angularVelocity.set(0, 0, 0);
        b.sleep();
      }
    }
  }
  hideHud(true);
  api.renderer.domElement.requestPointerLock();
  const btn = document.getElementById('ed-play-btn');
  if (btn) { btn.textContent = '▶ Play'; btn.onclick = hitPlay; btn.className = btn.className.replace('ed-stop','ed-play'); }
  updateBrickBar();
  flashBanner('⏹  Editing resumed', '#4488ff');
}

/* ─── key bindings ──────────────────────────────────────────────────────── */
function bindKeys() {
  window.addEventListener('keydown', e => {
    if (!st.active) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') { closeDropdowns(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoLast(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveToBrowser(true); return; }
    if (e.key.toLowerCase() === 'x') { setTool(st.tool === 'erase' ? 'place' : 'erase'); return; }
    if (e.key.toLowerCase() === 'r' && st.itemType === 'brick') { cycleRotation(); return; }
    if (e.key.toLowerCase() === 'r' && st.itemType === 'decor') { cycleDecorVariant(); return; }
    if (e.key.toLowerCase() === 'h' && st.itemType === 'brick') {
      st.halfSnap = !st.halfSnap;
      updateBadge();
      flashBanner(st.halfSnap ? '↔ Half-snap ON (stagger mode)' : '↔ Half-snap OFF (full grid)', '#446688');
      return;
    }
    if (e.key.toLowerCase() === 'q') { if (st.itemType === 'decor') { cycleDecorType(-1); } else { cycleBrickShape(-1); } return; }
    if (e.key.toLowerCase() === 'e') { if (st.itemType === 'decor') { cycleDecorType(+1); } else { cycleBrickShape(+1); } return; }
    if (st.view === 'topdown') {
      const s = st.topZoom * 0.08;
      const k = e.key;
      if (k==='ArrowLeft'  ||k==='a'||k==='A') { st.topPanX -= s; syncTopCam(); }
      if (k==='ArrowRight' ||k==='d'||k==='D') { st.topPanX += s; syncTopCam(); }
      if (k==='ArrowUp'    ||k==='w'||k==='W') { st.topPanZ -= s; syncTopCam(); }
      if (k==='ArrowDown'  ||k==='s'||k==='S') { st.topPanZ += s; syncTopCam(); }
    }
  });
}

/* ─── mouse bindings ────────────────────────────────────────────────────── */
function bindMouse() {
  const updateTopdownAimFromPointer = e => {
    if (!st.active || st.view !== 'topdown') return;
    const r = api.renderer.domElement.getBoundingClientRect();
    const locked = document.pointerLockElement === api.renderer.domElement;
    if (locked) {
      // Fallback path: when pointer-lock is active, clientX/clientY stay fixed.
      // Integrate movement deltas to keep top-down crosshair responsive.
      st.mouseNdc.x += (e.movementX || 0) * (2 / Math.max(1, r.width));
      st.mouseNdc.y -= (e.movementY || 0) * (2 / Math.max(1, r.height));
      st.mouseNdc.x = Math.max(-1, Math.min(1, st.mouseNdc.x));
      st.mouseNdc.y = Math.max(-1, Math.min(1, st.mouseNdc.y));
      syncTopdownCrosshairFromNdc();
      return;
    }
    st.mouseNdc.x =  ((e.clientX - r.left) / r.width)  * 2 - 1;
    st.mouseNdc.y = -((e.clientY - r.top)  / r.height) * 2 + 1;
    st.mouseNdc.x = Math.max(-1, Math.min(1, st.mouseNdc.x));
    st.mouseNdc.y = Math.max(-1, Math.min(1, st.mouseNdc.y));
    setCrosshairFromMouse(e.clientX, e.clientY);

    if (st.trenchDrawing && isTrenchBrushActive()) {
      placeTrenchStrokeStep();
    }
  };

  window.addEventListener('mousemove', updateTopdownAimFromPointer);
  window.addEventListener('pointermove', updateTopdownAimFromPointer);

  window.addEventListener('mousedown', e => {
    if (!st.active || e.button !== 0) return;
    if (isUI(e.target)) return;
    if (!isTrenchBrushActive()) return;
    e.preventDefault();
    closeDropdowns();
    st.trenchDrawing = true;
    st.trenchLastPos = null;
    placeTrenchStrokeStep();
  });

  window.addEventListener('mouseup', e => {
    if (e.button !== 0) return;
    st.trenchDrawing = false;
    st.trenchLastPos = null;
  });

  window.addEventListener('click', e => {
    if (!st.active || e.button !== 0) return;
    if (isUI(e.target)) return;
    if (isTrenchBrushActive()) return;
    closeDropdowns();
    st.tool === 'erase' ? doErase() : doPlace();
  });

  window.addEventListener('contextmenu', e => {
    if (!st.active || isUI(e.target)) return;
    e.preventDefault(); doErase();
  });

  window.addEventListener('wheel', e => {
    if (!st.active) return;
    if (st.view === 'topdown') {
      st.topZoom = Math.max(10, Math.min(300, st.topZoom + e.deltaY * 0.15)); syncTopCam();
    }
    // In 3-D mode the scroll wheel is intentionally a no-op: brick placement
    // works by pointing the crosshair at a face (Minecraft-style), not by
    // adjusting a Y-plane. Top-down zoom is handled above.
  }, { passive: true });
}

const isUI = el => !!(el && el.closest('#ed-toolbar,#ed-help,#ed-badge,.ed-dropdown'));

/* ─── UI build ──────────────────────────────────────────────────────────── */
function buildUI() {
  const bar = document.createElement('div');
  bar.id = 'ed-toolbar';

  const brickItems = Object.entries(SHAPES).map(([id, sh]) =>
    `<div class="ed-drop-item" data-shape="${id}" data-for="brick">
       ${shapeThumbHTML(id, 'ed-drop-shape')}
       <span>${sh.label}</span>
     </div>`).join('');

  const npcItems = NPC_DEFS.map(d =>
    `<div class="ed-drop-item" data-id="${d.id}" data-for="npc">
       <span class="ed-drop-icon">${d.icon}</span><span>${d.label}</span>
     </div>`).join('');

  const decorItems = Object.entries(DECOR_DEFS).map(([id, def]) =>
    `<div class="ed-drop-item" data-decor="${id}" data-for="decor">
       <span class="ed-drop-icon">${def.icon}</span><span>${def.label}</span>
     </div>`).join('');

  bar.innerHTML = `
    <span class="ed-title">✏ Editor</span>
    <div class="ed-sep"></div>

    <button id="ed-btn-3d"  class="ed-btn ed-btn-active">3-D</button>
    <button id="ed-btn-top" class="ed-btn">Top↓</button>
    <div class="ed-sep"></div>

    <div class="ed-drop-wrap">
      <button id="ed-btn-brick" class="ed-btn ed-btn-active">${shapeThumbHTML('brick', 'ed-btn-shape')} <span id="ed-brick-lbl">Brick ↔</span> ▾</button>
      <div id="ed-brick-drop" class="ed-dropdown">${brickItems}</div>
    </div>

    <div class="ed-drop-wrap">
      <button id="ed-btn-decor" class="ed-btn">🌿 <span id="ed-decor-lbl">Shrub</span> ▾</button>
      <div id="ed-decor-drop" class="ed-dropdown">${decorItems}</div>
    </div>

    <div class="ed-drop-wrap">
      <button id="ed-btn-npc" class="ed-btn">🪖 <span id="ed-npc-lbl">Swordsman</span> ▾</button>
      <div id="ed-npc-drop" class="ed-dropdown">${npcItems}</div>
    </div>
    <div class="ed-sep"></div>

    <button id="ed-btn-place" class="ed-btn ed-btn-active">Place</button>
    <button id="ed-btn-erase" class="ed-btn">Erase</button>
    <label id="ed-trench-size-wrap" class="ed-label" style="display:none">
      Brush <input id="ed-trench-size" type="range" min="0.5" max="3" step="0.1" value="0.5" class="ed-range">
      <span id="ed-trench-size-val">0.5</span>m
      <button id="ed-trench-water-btn" class="ed-btn" title="Toggle water fill" style="margin-left:6px;padding:2px 8px;font-size:11px">💧 Water</button>
    </label>
    <div class="ed-sep"></div>

    <button id="ed-undo-btn" class="ed-btn" disabled>↩ Undo</button>
    <div class="ed-sep"></div>
    <button id="ed-save-btn" class="ed-btn ed-save" title="Save level in this browser (Ctrl-S)">💾 Save</button>
    <div class="ed-drop-wrap">
      <button id="ed-file-btn" class="ed-btn" title="Export / import level files">⇅ File ▾</button>
      <div id="ed-file-drop" class="ed-dropdown ed-file-menu">
        <div class="ed-drop-item" id="ed-export-item"><span class="ed-drop-icon">⬇</span><span>Export to file…</span></div>
        <div class="ed-drop-item" id="ed-import-item"><span class="ed-drop-icon">📂</span><span>Import from file…</span></div>
        <div class="ed-drop-item" id="ed-clear-item"><span class="ed-drop-icon">🗑</span><span>Clear level</span></div>
      </div>
    </div>
    <div class="ed-sep" style="flex:1"></div>
    <button id="ed-play-btn" class="ed-btn ed-play">▶ Play</button>
    <button id="ed-close-btn" class="ed-btn ed-danger">✕ Exit</button>
  `;
  document.body.appendChild(bar);

  /* help — starts as a collapsed pill so it never blocks the viewport */
  const help = document.createElement('div'); help.id = 'ed-help';
  help.innerHTML = `
    <button id="ed-help-toggle" class="ed-help-pill">ⓘ Help</button>
    <div id="ed-help-content">
      <div id="ed-3d-help" class="ed-help-panel">
        <b>3-D mode</b><br>WASD + mouse → move<br>Space → jump / climb bricks<br>
        Left-click → place at crosshair<br>Right-click → erase<br>
        <b>R</b> → rotate brick / decor variant<br><b>H</b> → half-snap (stagger)<br>X → toggle erase<br>Ctrl-Z → undo<br>
        <b>Q / E</b> → cycle decor type (when Decor active)<br>
        <b>Ctrl-S</b> → save (auto-saves too)<br>
        <i>Aim at any brick face or ground to place</i>
      </div>
      <div id="ed-topdown-help" class="ed-help-panel" style="display:none">
        <b>Top-down</b><br>Left-click → place<br>Right-click → erase<br>
        Mouse move → aim crosshair<br>WASD → pan<br>Scroll → zoom<br><b>R</b> → rotate brick / decor variant<br><b>H</b> → half-snap<br>Trench: hold LMB and drag (Brush slider)<br>Ctrl-Z → undo
      </div>
    </div>`;
  document.body.appendChild(help);
  document.getElementById('ed-help-toggle').addEventListener('click', () => {
    help.classList.toggle('ed-help-open');
    document.getElementById('ed-help-toggle').textContent =
      help.classList.contains('ed-help-open') ? '✕ Close' : 'ⓘ Help';
  });

  const badge = document.createElement('div'); badge.id = 'ed-badge'; document.body.appendChild(badge);
  const banner = document.createElement('div'); banner.id = 'ed-banner'; document.body.appendChild(banner);
  const brickBar = document.createElement('div'); brickBar.id = 'ed-brickbar'; brickBar.style.display = 'none'; document.body.appendChild(brickBar);

  /* button wiring */
  document.getElementById('ed-btn-3d')   .onclick = () => setView('3d');
  document.getElementById('ed-btn-top')  .onclick = () => setView('topdown');
  document.getElementById('ed-btn-place').onclick = () => setTool('place');
  document.getElementById('ed-btn-erase').onclick = () => setTool('erase');
  document.getElementById('ed-undo-btn') .onclick = undoLast;
  document.getElementById('ed-play-btn') .onclick = hitPlay;
  document.getElementById('ed-close-btn').onclick = deactivateEditor;
  const trenchSizeInput = document.getElementById('ed-trench-size');
  if (trenchSizeInput) {
    trenchSizeInput.addEventListener('input', e => {
      st.trenchBrushSize = Math.max(0.5, Math.min(3, parseFloat(e.target.value) || 0.5));
      const val = document.getElementById('ed-trench-size-val');
      if (val) val.textContent = st.trenchBrushSize.toFixed(1);
      updateBadge();
    });
  }
  const trenchWaterBtn = document.getElementById('ed-trench-water-btn');
  if (trenchWaterBtn) {
    trenchWaterBtn.addEventListener('click', e => {
      e.stopPropagation();
      st.trenchWater = !st.trenchWater;
      trenchWaterBtn.classList.toggle('ed-btn-active', st.trenchWater);
      trenchWaterBtn.textContent = st.trenchWater ? '\uD83D\uDCA7 Water' : '\uD83E\uDEB8 Dry';
      for (const item of placed) {
        if (item.type !== 'trench' || !item.trenchEntry) continue;
        item.water = st.trenchWater;
      }
      api.setAllEditorTrenchWater?.(st.trenchWater);
      scheduleAutosave();
      updateBadge();
      if (st.view === '3d') api.renderer.domElement.requestPointerLock();
    });
  }

  /* save + file menu */
  document.getElementById('ed-save-btn').onclick = () => saveToBrowser(true);
  document.getElementById('ed-file-btn').addEventListener('click', e => {
    e.stopPropagation();
    const drop = document.getElementById('ed-file-drop');
    const open = drop.classList.contains('ed-drop-open');
    closeDropdowns();
    if (!open) {
      drop.classList.add('ed-drop-open');
      if (document.pointerLockElement) document.exitPointerLock();
    }
  });
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f) importLevelFile(f);
  });
  document.getElementById('ed-export-item').addEventListener('click', () => { closeDropdowns(); exportLevel(); });
  document.getElementById('ed-import-item').addEventListener('click', () => { closeDropdowns(); fileInput.click(); });
  document.getElementById('ed-clear-item').addEventListener('click', () => {
    closeDropdowns();
    if (!placed.length) { flashBanner('Level is already empty', '#ff8800'); return; }
    if (confirm('Clear the whole level? (Export it first if you want to keep a copy)')) {
      clearPlaced();
      saveToBrowser(false);
      flashBanner('\ud83d\uddd1 Level cleared', '#ff8800');
    }
  });

  /* brick button → open/close dropdown */
  document.getElementById('ed-btn-brick').addEventListener('click', e => {
    e.stopPropagation();
    const drop = document.getElementById('ed-brick-drop');
    const open = drop.classList.contains('ed-drop-open');
    closeDropdowns();
    if (!open) {
      drop.classList.add('ed-drop-open');
      if (document.pointerLockElement) document.exitPointerLock();
    }
  });

  /* Decor button → open/close dropdown */
  document.getElementById('ed-btn-decor').addEventListener('click', e => {
    e.stopPropagation();
    const drop = document.getElementById('ed-decor-drop');
    const open = drop.classList.contains('ed-drop-open');
    closeDropdowns();
    if (!open) {
      drop.classList.add('ed-drop-open');
      if (document.pointerLockElement) document.exitPointerLock();
    }
  });

  /* NPC button → open/close dropdown */
  document.getElementById('ed-btn-npc').addEventListener('click', e => {
    e.stopPropagation();
    const drop = document.getElementById('ed-npc-drop');
    const open = drop.classList.contains('ed-drop-open');
    closeDropdowns();
    if (!open) {
      drop.classList.add('ed-drop-open');
      if (document.pointerLockElement) document.exitPointerLock();
    }
  });

  /* dropdown item clicks */
  document.getElementById('ed-brick-drop').addEventListener('click', e => {
    const item = e.target.closest('[data-for="brick"]'); if (!item) return;
    selectShape(item.dataset.shape); closeDropdowns();
    if (st.view === '3d') api.renderer.domElement.requestPointerLock();
  });
  document.getElementById('ed-decor-drop').addEventListener('click', e => {
    const item = e.target.closest('[data-for="decor"]'); if (!item) return;
    selectDecorType(item.dataset.decor); closeDropdowns();
    if (st.view === '3d') api.renderer.domElement.requestPointerLock();
  });
  document.getElementById('ed-npc-drop').addEventListener('click', e => {
    const item = e.target.closest('[data-for="npc"]'); if (!item) return;
    selectNpc(item.dataset.id); closeDropdowns();
    if (st.view === '3d') api.renderer.domElement.requestPointerLock();
  });

  document.addEventListener('click', e => { if (!e.target.closest('.ed-drop-wrap')) closeDropdowns(); });

  updateBadge();
  updateBrickBar();
  updateTrenchBrushUi();
}

function showUI(v) {
  const toolbar = document.getElementById('ed-toolbar');
  toolbar.style.display = v ? 'flex' : 'none';
  document.getElementById('ed-help')  .style.display = v ? 'block' : 'none';
  document.getElementById('ed-badge') .style.display = v ? 'block' : 'none';
  const bb = document.getElementById('ed-brickbar');
  if (bb) bb.style.display = v ? 'flex' : 'none';

  const settingsBtn   = document.getElementById('settingsBtn');
  const devMenuBtn    = document.getElementById('devMenuBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const devPanel      = document.getElementById('devPanel');

  if (v) {
    requestAnimationFrame(() => {
      const tbH = toolbar.getBoundingClientRect().height || 40;
      const topPx = Math.ceil(tbH) + 6;
      const top = `${topPx}px`;
      if (settingsBtn) { settingsBtn.style.top = top; settingsBtn.style.zIndex = '9500'; }
      if (devMenuBtn)  { devMenuBtn.style.top  = top; devMenuBtn.style.zIndex  = '9500'; }
      const fpsBadge = document.getElementById('tempFpsBadge');
      if (fpsBadge) { fpsBadge.style.top = top; fpsBadge.style.zIndex = '9500'; }
      if (settingsPanel) settingsPanel.style.zIndex = '9600';
      if (devPanel)      devPanel.style.zIndex      = '9600';
      const helpEl = document.getElementById('ed-help');
      // Help pill sits just below the buttons row.
      if (helpEl) helpEl.style.top = `${topPx + 42}px`;
    });
  } else {
    if (settingsBtn) { settingsBtn.style.top = ''; settingsBtn.style.zIndex = ''; }
    if (devMenuBtn)  { devMenuBtn.style.top  = ''; devMenuBtn.style.zIndex  = ''; }
    const fpsBadge = document.getElementById('tempFpsBadge');
    if (fpsBadge) { fpsBadge.style.top = ''; fpsBadge.style.zIndex = ''; }
    if (settingsPanel) settingsPanel.style.zIndex = '';
    if (devPanel)      devPanel.style.zIndex      = '';
    const helpEl = document.getElementById('ed-help');
    if (helpEl) helpEl.style.top = '';
  }
}

function closeDropdowns() {
  document.querySelectorAll('.ed-dropdown').forEach(d => d.classList.remove('ed-drop-open'));
}

/* ─── selection ─────────────────────────────────────────────────────────── */
function selectShape(shapeId) {
  if (!SHAPES[shapeId]) return;
  st.brickShape = shapeId; st.brickRot = 0; st.itemType = 'brick';
  setActive('ed-btn-brick', true); setActive('ed-btn-npc', false); setActive('ed-btn-decor', false);
  document.getElementById('ed-brick-lbl').textContent = SHAPES[shapeId].label;
  const btn = document.getElementById('ed-btn-brick');
  const icon = btn ? btn.querySelector('.ed-btn-shape') : null;
  if (icon) icon.className = `ed-shape-thumb ed-btn-shape ed-shape-${shapeId}`;
  setTool('place'); rebuildBrickGhost(); updateBadge(); updateBrickBar();
  updateTrenchBrushUi();
  markDrop('ed-brick-drop', shapeId);
}

function cycleBrickShape(dir) {
  const idx = SHAPE_ORDER.indexOf(st.brickShape);
  const next = (idx + dir + SHAPE_ORDER.length) % SHAPE_ORDER.length;
  selectShape(SHAPE_ORDER[next]);
}

function cycleRotation() {
  const sh = SHAPES[st.brickShape];
  if (!sh || sh.rotations.length <= 1) return;
  st.brickRot = (st.brickRot + 1) % sh.rotations.length;
  rebuildBrickGhost(); updateBadge(); updateBrickBar();
  flashBanner(`${sh.icon} ${currentRot().label}`, '#446688');
}

function updateBrickBar() {
  const bar = document.getElementById('ed-brickbar'); if (!bar) return;
  bar.innerHTML = '';
  SHAPE_ORDER.forEach(shapeId => {
    const sh = SHAPES[shapeId];
    const isActive = st.itemType === 'brick' && st.brickShape === shapeId;
    const rot = isActive ? currentRot() : sh.rotations[0];
    const div = document.createElement('div');
    div.className = 'ed-bbar-item' + (isActive ? ' ed-bbar-active' : '');
    div.innerHTML = `${shapeThumbHTML(shapeId, 'ed-bbar-shape')}<span class="ed-bbar-name">${sh.label}</span><span class="ed-bbar-rot">${rot.label}</span>`;
    div.addEventListener('click', () => {
      selectShape(shapeId);
      if (st.view === '3d') api.renderer.domElement.requestPointerLock();
    });
    bar.appendChild(div);
  });
}

function selectNpc(id) {
  st.npcWeapon = id; st.itemType = 'npc';
  setActive('ed-btn-npc', true); setActive('ed-btn-brick', false); setActive('ed-btn-decor', false);
  document.getElementById('ed-npc-lbl').textContent = NPC_DEFS.find(d => d.id === id)?.label || id;
  setTool('place'); updateBadge(); updateTrenchBrushUi(); markDrop('ed-npc-drop', id);
}

function selectDecorType(typeId) {
  if (!DECOR_DEFS[typeId]) return;
  st.decorType = typeId; st.decorVariant = 0; st.itemType = 'decor';
  setActive('ed-btn-decor', true); setActive('ed-btn-brick', false); setActive('ed-btn-npc', false);
  const def = DECOR_DEFS[typeId];
  document.getElementById('ed-decor-lbl').textContent = def.label;
  const btn = document.getElementById('ed-btn-decor');
  if (btn) btn.firstChild.textContent = def.icon + ' ';
  rebuildDecorGhost();
  setTool('place'); updateBadge(); updateTrenchBrushUi();
  markDropDecor(typeId);
}

function cycleDecorType(dir) {
  const idx = DECOR_ORDER.indexOf(st.decorType);
  const next = (idx + dir + DECOR_ORDER.length) % DECOR_ORDER.length;
  selectDecorType(DECOR_ORDER[next]);
}

function cycleDecorVariant() {
  const def = DECOR_DEFS[st.decorType];
  if (!def || def.variants.length <= 1) return;
  st.decorVariant = (st.decorVariant + 1) % def.variants.length;
  rebuildDecorGhost(); updateBadge();
  flashBanner(`${def.icon} ${currentDecorVariant().label}`, '#446688');
}

function markDropDecor(activeId) {
  document.querySelectorAll('#ed-decor-drop .ed-drop-item')
    .forEach(el => el.classList.toggle('ed-drop-active', el.getAttribute('data-decor') === activeId));
}

function setTool(t) {
  st.tool = t;
  setActive('ed-btn-place', t === 'place');
  setActive('ed-btn-erase', t === 'erase');
  updateTrenchBrushUi();
}

const setActive  = (id, on) => document.getElementById(id)?.classList.toggle('ed-btn-active', on);
const setUndoState = on => { const b = document.getElementById('ed-undo-btn'); if (b) b.disabled = !on; };

function updateTrenchBrushUi() {
  const wrap = document.getElementById('ed-trench-size-wrap');
  const input = document.getElementById('ed-trench-size');
  const val = document.getElementById('ed-trench-size-val');
  const waterBtn = document.getElementById('ed-trench-water-btn');
  if (!wrap || !input || !val) return;
  const show = st.itemType === 'brick' && st.brickShape === 'trench';
  wrap.style.display = show ? 'flex' : 'none';
  input.value = String(st.trenchBrushSize.toFixed(1));
  val.textContent = st.trenchBrushSize.toFixed(1);
  if (waterBtn) {
    waterBtn.classList.toggle('ed-btn-active', st.trenchWater);
    waterBtn.textContent = st.trenchWater ? '\uD83D\uDCA7 Water' : '\uD83E\uDEB8 Dry';
  }
}

function updateBadge() {
  const b = document.getElementById('ed-badge'); if (!b) return;
  if (st.itemType === 'brick') {
    const sh = SHAPES[st.brickShape];
    const rot = currentRot();
    const rotHint = sh && sh.rotations.length > 1 ? '  [R=rotate]' : '';
    const snapHint = st.halfSnap ? '  [H=1/2 snap]' : '  [H=full snap]';
    const brushHint = st.brickShape === 'trench' ? `  [Brush ${st.trenchBrushSize.toFixed(1)}m | ${st.trenchWater ? 'Water' : 'Dry'}]` : '';
    b.textContent = `${sh?.icon || '🧱'} ${sh?.label} — ${rot.label}${rotHint}${snapHint}${brushHint}`;
  } else if (st.itemType === 'decor') {
    const def = DECOR_DEFS[st.decorType];
    const v = currentDecorVariant();
    const varHint = def && def.variants.length > 1 ? '  [R=variant]' : '';
    b.textContent = `${def?.icon || '🌿'} ${def?.label} — ${v.label}${varHint}  [Q/E=type]`;
  } else {
    const d = NPC_DEFS.find(d => d.id === st.npcWeapon);
    b.textContent = `🪖 ${d?.icon || ''} ${d?.label || st.npcWeapon}`;
  }
}

function markDrop(dropId, activeId) {
  const attr = dropId === 'ed-brick-drop' ? 'data-shape' : 'data-id';
  document.querySelectorAll(`#${dropId} .ed-drop-item`)
    .forEach(el => el.classList.toggle('ed-drop-active', el.getAttribute(attr) === activeId));
}

function flashBanner(msg, color = '#ffcc00') {
  const b = document.getElementById('ed-banner'); if (!b) return;
  b.textContent = msg; b.style.background = color;
  b.style.opacity = '1'; b.style.display = 'block';
  clearTimeout(b._t); b._t = setTimeout(() => { b.style.opacity = '0'; }, 2200);
}

/* ─── brick preview canvases (removed — shapes now use emoji icons) ─────── */


/* ─── CSS ───────────────────────────────────────────────────────────────── */
function injectStyles() {
  const s = document.createElement('style');
  s.textContent = `
  #ed-toolbar {
    position:fixed; top:0; left:0; right:0; z-index:9000;
    display:none; align-items:center; gap:5px; flex-wrap:wrap;
    padding:5px 10px;
    background:rgba(7,7,13,.94); border-bottom:2px solid #1e1e32;
    font-family:system-ui,sans-serif; font-size:12px; color:#ddd;
    backdrop-filter:blur(6px); user-select:none;
  }
  .ed-title { font-weight:700; font-size:13px; color:#ffe080; }
  .ed-sep   { width:1px; height:20px; background:#333; margin:0 2px; }
  .ed-label { display:flex; align-items:center; gap:3px; color:#aaa; font-size:11px; }
  .ed-num   { width:44px; background:#191926; color:#eee; border:1px solid #444;
               border-radius:4px; padding:2px 4px; font-size:11px; }
  .ed-range {
    width:90px; accent-color:#56b4ff;
  }

  .ed-btn {
    padding:4px 9px; border-radius:5px; border:1px solid #3a3a50;
    background:#191926; color:#ccc; cursor:pointer; font-size:12px;
    white-space:nowrap; transition:background .1s;
  }
  .ed-btn:hover    { background:#242438; }
  .ed-btn:disabled { opacity:.35; cursor:default; }
  .ed-btn-active   { background:#1e3660!important; color:#7ac0ff; border-color:#2d5090; }
  .ed-play  { background:#163016; color:#66ff88; border-color:#2e6a2e; font-weight:700; }
  .ed-play:hover { background:#1c401c; }
  .ed-stop  { background:#381414; color:#ff7777; border-color:#6a2e2e; font-weight:700; }
  .ed-danger{ background:#2e1212; color:#ff8888; border-color:#602020; }
  .ed-danger:hover { background:#3d1818; }
  .ed-save {
    background:#0f3a2a; color:#5fffb0; border-color:#2e6a50;
    font-weight:700; font-size:13px; padding:5px 14px;
    box-shadow:0 0 8px rgba(60,255,160,.25);
  }
  .ed-save:hover { background:#155038; box-shadow:0 0 12px rgba(60,255,160,.45); }
  .ed-file-menu { min-width:170px; flex-direction:column; }
  .ed-file-menu .ed-drop-item {
    flex-direction:row; justify-content:flex-start; width:100%;
    min-width:0; padding:7px 10px; gap:9px;
  }
  .ed-file-menu .ed-drop-icon { font-size:16px; }

  /* dropdowns */
  .ed-drop-wrap { position:relative; }
  .ed-dropdown {
    display:none; position:absolute; top:calc(100% + 5px); left:0; z-index:9300;
    background:#111120; border:1px solid #3a3a55; border-radius:9px;
    padding:7px; gap:6px; flex-wrap:wrap; min-width:190px;
    box-shadow:0 10px 30px rgba(0,0,0,.8);
  }
  .ed-dropdown.ed-drop-open { display:flex; }
  .ed-drop-item {
    display:flex; flex-direction:column; align-items:center; gap:4px;
    padding:8px 10px; border-radius:7px; border:2px solid #252535;
    background:#181828; cursor:pointer; font-size:11px; color:#bbb;
    min-width:68px; transition:border-color .12s, background .12s;
  }
  .ed-drop-item:hover  { border-color:#5599ff; background:#1d1d38; color:#fff; }
  .ed-drop-active      { border-color:#4499ff!important; background:#162040!important; color:#fff; }
  .ed-drop-canvas      { border-radius:3px; display:block; }
  .ed-drop-icon        { font-size:22px; line-height:1.2; }

  /* brick shape thumbnails (front-facing silhouettes) */
  .ed-shape-thumb {
    display:inline-block; position:relative; flex:0 0 auto;
    background:linear-gradient(180deg,#e7e3da 0%, #d7d1c4 100%);
    border:1px solid rgba(118,108,92,.92);
    box-shadow:inset 0 0 0 1px rgba(255,255,255,0.28), 0 1px 3px rgba(0,0,0,.45);
    border-radius:2px;
  }
  .ed-shape-thumb::before,
  .ed-shape-thumb::after { content:none; }

  .ed-shape-brick {
    width:26px; height:13px;
    background:
      linear-gradient(90deg, transparent 0 47%, rgba(120,110,95,.42) 47% 53%, transparent 53% 100%),
      linear-gradient(180deg, transparent 0 48%, rgba(120,110,95,.42) 48% 54%, transparent 54% 100%),
      linear-gradient(180deg,#e7e3da 0%, #d7d1c4 100%);
  }
  .ed-shape-cube {
    width:15px; height:15px;
    background:linear-gradient(180deg,#e7e3da 0%, #d7d1c4 100%);
  }
  .ed-shape-wedge {
    width:22px; height:14px;
    border-radius:1px;
    /* Front-facing wedge/ramp: flat base, sloped top, vertical back face. */
    clip-path:polygon(0 100%, 100% 100%, 100% 0, 0 58%);
    background:linear-gradient(180deg,#ece8de 0%, #d3cdbc 100%);
    border:1px solid rgba(118,108,92,.92);
    box-shadow:inset 0 0 0 1px rgba(255,255,255,0.28), 0 1px 3px rgba(0,0,0,.45);
  }
  .ed-shape-trench {
    width:26px; height:13px;
    background:
      linear-gradient(180deg, transparent 0 30%, rgba(65,115,170,.65) 30% 70%, transparent 70% 100%),
      linear-gradient(180deg,#b6ac97 0%, #a09580 100%);
    border:1px solid rgba(108,98,82,.95);
    border-radius:2px;
  }
  .ed-shape-plank {
    width:26px; height:9px;
    background:linear-gradient(180deg,#c08840 0%,#9a6624 100%);
    border:1px solid rgba(80,44,12,.88);
    border-radius:1px;
    box-shadow:inset 0 1px 0 rgba(255,210,130,.32), 0 1px 3px rgba(0,0,0,.45);
  }
  .ed-drop-shape { margin-bottom:2px; }
  .ed-btn-shape { margin-right:6px; vertical-align:middle; transform:translateY(1px); }
  .ed-bbar-shape { margin-bottom:2px; }

  /* help */
  #ed-help { position:fixed; top:70px; right:10px; z-index:8900; display:none; pointer-events:none; }
  /* Collapsed by default — only the pill is visible */
  #ed-help-content { display:none; }
  .ed-help-open #ed-help-content { display:block; }
  .ed-help-pill {
    pointer-events:auto; display:block; width:100%;
    background:rgba(12,17,33,0.88); color:#b0ccf0;
    border:1px solid rgba(120,160,220,0.38); border-radius:20px;
    padding:4px 13px; cursor:pointer; font-size:12px;
    font-family:system-ui,sans-serif; text-align:center; white-space:nowrap;
    margin-bottom:4px;
  }
  .ed-help-pill:hover { background:rgba(25,35,65,0.95); color:#ddeeff; }
  .ed-help-panel {
    background:rgba(7,7,13,.86); border:1px solid #2a2a40; border-radius:8px;
    padding:9px 13px; font-size:11px; color:#aaa; line-height:1.85;
    backdrop-filter:blur(4px);
  }
  .ed-help-panel b { color:#ffe080; }

  /* badge */
  #ed-badge {
    position:fixed; bottom:90px; left:50%; transform:translateX(-50%);
    z-index:8900; display:none;
    background:rgba(7,7,20,.92); border:1px solid #3a3a55; border-radius:20px;
    padding:5px 16px; font-size:13px; color:#fff;
    font-family:system-ui,sans-serif; pointer-events:none;
  }

  /* brick selector bar */
  #ed-brickbar {
    position:fixed; bottom:16px; left:50%; transform:translateX(-50%);
    z-index:8950; display:none;
    flex-direction:row; gap:6px;
    background:rgba(0,0,0,0.82); border:1px solid rgba(255,255,255,0.15);
    border-radius:14px; padding:8px 12px;
    font-family:system-ui,sans-serif; user-select:none;
  }
  .ed-bbar-item {
    display:flex; flex-direction:column; align-items:center; gap:2px;
    padding:7px 16px; border-radius:9px; cursor:pointer;
    border:2px solid transparent; min-width:74px;
    transition:border-color .12s, background .12s;
  }
  .ed-bbar-item:hover { background:rgba(255,255,255,0.08); }
  .ed-bbar-active { border-color:#4499ff !important; background:rgba(40,80,160,0.45) !important; }
  .ed-bbar-name { font-size:11px; color:#eee; font-weight:700; }
  .ed-bbar-rot  { font-size:10px; color:#aaa; }

  /* banner */
  #ed-banner {
    position:fixed; top:50px; left:50%; transform:translateX(-50%);
    z-index:9100; display:none; padding:7px 22px; border-radius:7px;
    font-size:14px; font-weight:700; color:#000;
    font-family:system-ui,sans-serif; pointer-events:none; transition:opacity .6s;
  }
  `;
  document.head.appendChild(s);
}
