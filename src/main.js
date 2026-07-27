import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { Water } from "three/examples/jsm/objects/Water.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import * as CANNON from "cannon-es";
import { initEditor, activateEditor } from './editor.js';

window.__GAME_BOOTED = true;
window.dispatchEvent(new Event('game-booted'));

const coarsePointerQuery = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
const hasTouchInput = ((navigator.maxTouchPoints || 0) > 0) || ('ontouchstart' in window);
// Force-desktop override lets touchscreen PC users suppress mobile mode.
const isMobileProfile = !window.__forceDesktopMode &&
    (hasTouchInput || !!(coarsePointerQuery && coarsePointerQuery.matches));

// === Renderer ===
let renderer;
try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
} catch (err) {
    console.error('WebGL renderer init failed.', err);
    const fallback = document.createElement('div');
    fallback.style.position = 'fixed';
    fallback.style.inset = '0';
    fallback.style.display = 'flex';
    fallback.style.alignItems = 'center';
    fallback.style.justifyContent = 'center';
    fallback.style.padding = '24px';
    fallback.style.background = '#0f1622';
    fallback.style.color = '#f2e8c6';
    fallback.style.fontFamily = 'Georgia, serif';
    fallback.style.fontSize = '18px';
    fallback.style.textAlign = 'center';
    fallback.style.zIndex = '9999';
    fallback.textContent = 'Graphics initialization failed. Please reload the page. If this persists, close other game tabs/windows and try again.';
    document.body.innerHTML = '';
    document.body.appendChild(fallback);
    throw err;
}
renderer.setSize(window.innerWidth, window.innerHeight);
const _pixelMaxCap = isMobileProfile
    ? Math.min(window.devicePixelRatio, 2.0)   // 3x phone DPR = 9x the pixels of 1x; 2.0 is visually near-identical on small screens
    : Math.min(window.devicePixelRatio, 2);  // adaptive-resolution cap (see monitorPerf)
let _pixelCap = _pixelMaxCap;
renderer.setPixelRatio(_pixelCap);
const TEX_ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = isMobileProfile ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
// Render the shadow map at most ONCE per frame (we trigger it manually in the
// loop) to avoid redundant shadow work in any extra render passes.
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

let _webglRecovering = false;
renderer.domElement.addEventListener('webglcontextlost', (ev) => {
    // Prevent the browser default so recovery/reload can proceed cleanly.
    ev.preventDefault();
    if (_webglRecovering) return;
    _webglRecovering = true;
    console.warn('WebGL context lost; waiting for restore or manual reload.');
    const lock = document.getElementById('lockMsg');
    if (lock) {
        lock.textContent = 'Graphics context lost. Press F5 to reload if it does not recover.';
        lock.style.display = 'flex';
    }
}, { passive: false });

renderer.domElement.addEventListener('webglcontextrestored', () => {
    console.warn('WebGL context restored.');
    _webglRecovering = false;
    const lock = document.getElementById('lockMsg');
    if (lock && lock.textContent && lock.textContent.includes('Graphics context lost')) {
        lock.style.display = 'none';
    }
});

// === Environment Map ===
const pmrem = new THREE.PMREMGenerator(renderer);
const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

// === Scene ===
const scene = new THREE.Scene();
scene.environment = envTexture;

// Physically-based sky with sun
const sky = new Sky();
sky.scale.setScalar(1000);
scene.add(sky);
const skyUniforms = sky.material.uniforms;
skyUniforms["turbidity"].value      = 3.4;
skyUniforms["rayleigh"].value       = 1.55;
skyUniforms["mieCoefficient"].value = 0.0052;
skyUniforms["mieDirectionalG"].value = 0.80;
const sunDir = new THREE.Vector3();
const phi   = THREE.MathUtils.degToRad(78);   // altitude (lower = more orange)
const theta = THREE.MathUtils.degToRad(200);  // azimuth
sunDir.setFromSphericalCoords(1, phi, theta);
skyUniforms["sunPosition"].value.copy(sunDir);
// Align directional light with the sky sun
scene.fog = new THREE.FogExp2(0xa3cce8, 0.0051);

// === Clouds ===
const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xfafcff,
    roughness: 1.0,
    metalness: 0.0,
    emissive: 0xe4f1ff,
    emissiveIntensity: 0.22,
    transparent: true,
    opacity: 0.92,
    depthWrite: false
});

function createCloud(x, y, z, scale) {
    const g = new THREE.Group();
    // Each entry: [offsetX, offsetY, offsetZ, puffScale]
    const puffs = [
        [0.0,  0.0,  0.0,  1.00],
        [2.8,  0.5,  0.3,  0.78],
        [-2.5, 0.4, -0.4,  0.74],
        [1.2,  1.0, -1.2,  0.62],
        [-1.2, 0.7,  1.4,  0.60],
        [4.0, -0.2, -0.6,  0.52],
        [-3.8, 0.0,  0.9,  0.50],
    ];
    for (const [px, py, pz, ps] of puffs) {
        const m = new THREE.Mesh(
            new THREE.SphereGeometry(2.8 * ps * scale, 7, 5),
            cloudMat
        );
        m.scale.y = 0.34 + Math.random() * 0.18;
        m.rotation.y = Math.random() * Math.PI * 2;
        m.position.set(px * scale, py * scale, pz * scale);
        g.add(m);
    }
    g.position.set(x, y, z);
    g.userData.baseY = y;
    g.userData.bobAmp = 0.6 + Math.random() * 1.4;
    g.userData.bobSpeed = 0.07 + Math.random() * 0.14;
    g.userData.phase = Math.random() * Math.PI * 2;
    g.userData.driftMul = 0.84 + Math.random() * 0.34;
    g.userData.rollSpeed = (Math.random() - 0.5) * 0.014;
    scene.add(g);
    return g;
}

const clouds = (() => {
    const out = [];
    const ambientCloudCount = isMobileProfile ? 14 : 30;
    // Deterministic scatter so cloud layout is stable across reloads.
    let seed = 90210;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
    for (let i = 0; i < ambientCloudCount; i++) {
        const x = -360 + rnd() * 720;
        const y = 66 + rnd() * 40;
        const z = 68 + rnd() * 240;
        const scale = 0.9 + rnd() * 1.7;
        const speed = 0.42 + rnd() * 1.25;
        out.push({ group: createCloud(x, y, z, scale), speed });
    }
    // A few hero puffs near the play-space sightline.
    if (!isMobileProfile) {
        out.push({ group: createCloud(-120, 82, 140, 1.8), speed: 0.72 });
        out.push({ group: createCloud(60, 88, 175, 1.6), speed: 0.65 });
        out.push({ group: createCloud(170, 76, 120, 1.35), speed: 0.84 });
    }
    return out;
})();

// === First-Person Camera ===
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 2000);
camera.rotation.order = "YXZ";
camera.position.set(0, 2.2, -10);
scene.add(camera);

// Cannon barrel viewmodel ? procedural cast-iron texture
function makeCannonTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    // Base dark iron
    const grad = ctx.createLinearGradient(0, 0, 128, 0);
    grad.addColorStop(0,    '#1a1a1a');
    grad.addColorStop(0.35, '#3a3a3a');
    grad.addColorStop(0.5,  '#4e4e4e');
    grad.addColorStop(0.65, '#3a3a3a');
    grad.addColorStop(1,    '#1a1a1a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 256);
    // Reinforcement rings every ~32 px
    for (let y = 16; y < 256; y += 32) {
        ctx.fillStyle = 'rgba(80,80,80,0.55)';
        ctx.fillRect(0, y - 5, 128, 10);
        ctx.fillStyle = 'rgba(20,20,20,0.4)';
        ctx.fillRect(0, y - 6, 128, 2);
        ctx.fillRect(0, y + 4, 128, 2);
    }
    // Surface oxidation speckle
    for (let i = 0; i < 1200; i++) {
        const x = Math.random()*128, y = Math.random()*256;
        const v = (Math.random()*30)|0;
        ctx.fillStyle = `rgba(${40+v},${35+v},${30+v},0.25)`;
        ctx.fillRect(x, y, 1, 1);
    }
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
}
const vmBarrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.10, 1.9, 14),
    new THREE.MeshStandardMaterial({
        map: makeCannonTexture(),
        roughness: 0.38, metalness: 0.92, envMapIntensity: 1.8
    })
);
vmBarrel.rotation.x = Math.PI / 2;
vmBarrel.position.set(0.08, -0.24, -0.45);
camera.add(vmBarrel);
// Track hit flash state: time remaining for red tint
let cannonHitFlash = 0;
const vmBarrelMat  = vmBarrel.material;
// Muzzle ring detail
const vmMuzzle = new THREE.Mesh(
    new THREE.TorusGeometry(0.068, 0.016, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.25, metalness: 0.98 })
);
vmMuzzle.position.set(0, 0, -0.95);
vmBarrel.add(vmMuzzle);

// === Mortar viewmodel (short fat tube, angled upward) ===
const vmMortarMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a28, roughness: 0.55, metalness: 0.85
});
// Main tube: short and wide
const vmMortarTube = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.16, 0.65, 14),
    vmMortarMat
);
// Muzzle bell: flared open end
const vmMortarBell = new THREE.Mesh(
    new THREE.CylinderGeometry(0.19, 0.13, 0.18, 14),
    vmMortarMat
);
vmMortarBell.position.y = 0.415;
vmMortarTube.add(vmMortarBell);
// Base plate
const vmMortarBase = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.07, 0.42),
    new THREE.MeshStandardMaterial({ color: 0x1a1a18, roughness: 0.7, metalness: 0.6 })
);
vmMortarBase.position.y = -0.36;
vmMortarTube.add(vmMortarBase);
// Group so we can position it as a unit
const vmMortarGroup = new THREE.Group();
vmMortarGroup.add(vmMortarTube);
// Tilt tube ~55� forward (mortar angle), place bottom-centre of view and pull
// it down + back a little so it's less clunky and doesn't block the view.
vmMortarTube.rotation.x = -0.85;  // 55� toward player's face
vmMortarGroup.scale.setScalar(0.82);
vmMortarGroup.position.set(0.07, -0.46, -0.34);
vmMortarGroup.visible = false;
camera.add(vmMortarGroup);

// === Minigun (Gatling gun) viewmodel ===
const vmMinigunMat = new THREE.MeshStandardMaterial({ color: 0xb8c2cc, roughness: 0.22, metalness: 1.0 });
const vmMinigunGroup = new THREE.Group();
// Receiver housing
const vmMgReceiver = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.055, 0.32, 12),
    vmMinigunMat
);
vmMgReceiver.rotation.x = Math.PI / 2;
vmMinigunGroup.add(vmMgReceiver);
// Barrel spinner group (rotates when firing)
const vmMgBarrelSpin = new THREE.Group();
vmMgReceiver.add(vmMgBarrelSpin);
// 8 barrels in a circle
const MG_BARREL_COUNT = 8;
const MG_BARREL_R = 0.052;
for (let i = 0; i < MG_BARREL_COUNT; i++) {
    const angle = (i / MG_BARREL_COUNT) * Math.PI * 2;
    const bx = Math.cos(angle) * MG_BARREL_R;
    const bz = Math.sin(angle) * MG_BARREL_R;
    const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.010, 0.012, 0.75, 6),
        vmMinigunMat
    );
    barrel.position.set(bx, 0, bz);
    // Muzzle tip ring
    const tip = new THREE.Mesh(
        new THREE.TorusGeometry(0.013, 0.004, 5, 10),
        new THREE.MeshStandardMaterial({ color: 0xc8d0d8, roughness: 0.16, metalness: 1.0 })
    );
    tip.position.y = 0.375;
    barrel.add(tip);
    vmMgBarrelSpin.add(barrel);
}
// Belt-feed housing box on the side
const vmMgFeed = new THREE.Mesh(
    new THREE.BoxGeometry(0.11, 0.07, 0.18),
    new THREE.MeshStandardMaterial({ color: 0x252520, roughness: 0.6, metalness: 0.7 })
);
vmMgFeed.position.set(0.10, 0, 0);
vmMgReceiver.add(vmMgFeed);
// Skin-toned hand gripping the receiver underneath (so it reads as a hand, not
// a black metal block). vmMinigunGroup is unrotated, so +Z is back toward the
// player � place the hand at the rear-underside of the gun.
const vmSkinMat = new THREE.MeshStandardMaterial({ color: 0xf0c080, roughness: 0.75, metalness: 0.0 });
const vmMgHand = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.07, 0.11), vmSkinMat);
vmMgHand.position.set(-0.02, -0.075, 0.08);
vmMinigunGroup.add(vmMgHand);
// Thumb wrapping over the top
const vmMgThumb = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.055, 0.05), vmSkinMat);
vmMgThumb.position.set(0.02, -0.04, 0.085);
vmMinigunGroup.add(vmMgThumb);
vmMinigunGroup.position.set(0.20, -0.23, -0.42);
vmMinigunGroup.visible = false;
camera.add(vmMinigunGroup);

// === Sniper rifle viewmodel ===
function makeRifleStockTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0, '#2a221a');
    g.addColorStop(0.45, '#4a3725');
    g.addColorStop(1, '#231b15');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 64);
    for (let i = 0; i < 180; i++) {
        const x = Math.random() * 256;
        const y = Math.random() * 64;
        const a = 0.05 + Math.random() * 0.14;
        ctx.strokeStyle = `rgba(30,20,8,${a})`;
        ctx.lineWidth = 0.6 + Math.random() * 1.2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(Math.min(256, x + 20 + Math.random() * 34), Math.max(0, y + (Math.random() - 0.5) * 6));
        ctx.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(2, 1);
    return t;
}

const vmSniperGroup = new THREE.Group();
const vmSniperStockMat = new THREE.MeshStandardMaterial({
    map: makeRifleStockTexture(),
    color: 0xb8b0a0,
    roughness: 0.76,
    metalness: 0.06
});
const vmSniperSteel = new THREE.MeshStandardMaterial({ color: 0x778390, roughness: 0.24, metalness: 0.98 });
const vmSniperBlack = new THREE.MeshStandardMaterial({ color: 0x161718, roughness: 0.42, metalness: 0.72 });
const vmSniperRubber = new THREE.MeshStandardMaterial({ color: 0x1f1d1b, roughness: 0.92, metalness: 0.03 });
const vmSniperGlass = new THREE.MeshStandardMaterial({ color: 0x8dc8e8, roughness: 0.04, metalness: 0.0, transparent: true, opacity: 0.58 });
const vmSniperScopeBodyMat = vmSniperBlack.clone();
vmSniperScopeBodyMat.transparent = false;
vmSniperScopeBodyMat.opacity = 1;
vmSniperScopeBodyMat.side = THREE.DoubleSide;
const vmSniperScopeRingMat = vmSniperSteel.clone();
vmSniperScopeRingMat.transparent = true;
vmSniperScopeRingMat.opacity = 1;
const vmSniperScopeLensMat = vmSniperGlass.clone();
vmSniperScopeLensMat.side = THREE.DoubleSide;
vmSniperScopeLensMat.depthWrite = false;

const vmSniperStock = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.86), vmSniperStockMat);
vmSniperStock.position.set(0.0, -0.02, 0.06);
vmSniperGroup.add(vmSniperStock);
const vmSniperCheek = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.34), vmSniperRubber);
vmSniperCheek.position.set(0.0, 0.065, 0.19);
vmSniperGroup.add(vmSniperCheek);
const vmSniperGrip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.11), vmSniperStockMat);
vmSniperGrip.position.set(0.02, -0.12, 0.16);
vmSniperGrip.rotation.x = -0.24;
vmSniperGroup.add(vmSniperGrip);
const vmSniperButt = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.11, 0.04), vmSniperRubber);
vmSniperButt.position.set(0.0, -0.01, 0.49);
vmSniperGroup.add(vmSniperButt);
const vmSniperFore = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.095, 0.64), vmSniperStockMat);
vmSniperFore.position.set(0.0, -0.003, -0.46);
vmSniperGroup.add(vmSniperFore);

const vmSniperReceiver = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.09, 0.48), vmSniperSteel);
vmSniperReceiver.position.set(0.0, 0.06, -0.14);
vmSniperGroup.add(vmSniperReceiver);
const vmSniperRail = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.02, 0.38), vmSniperBlack);
vmSniperRail.position.set(0.0, 0.115, -0.2);
vmSniperGroup.add(vmSniperRail);
const vmSniperMagazine = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.11, 0.12), vmSniperBlack);
vmSniperMagazine.position.set(0.0, -0.12, -0.11);
vmSniperGroup.add(vmSniperMagazine);
const vmSniperTriggerGuard = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 8, 12), vmSniperBlack);
vmSniperTriggerGuard.rotation.x = Math.PI / 2;
vmSniperTriggerGuard.position.set(0.0, -0.085, 0.03);
vmSniperGroup.add(vmSniperTriggerGuard);

const vmSniperBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, 1.42, 16), vmSniperSteel);
vmSniperBarrel.rotation.x = Math.PI / 2;
vmSniperBarrel.position.set(0.0, 0.055, -0.84);
vmSniperGroup.add(vmSniperBarrel);
const vmSniperBrake = new THREE.Mesh(new THREE.CylinderGeometry(0.023, 0.024, 0.10, 10), vmSniperBlack);
vmSniperBrake.rotation.x = Math.PI / 2;
vmSniperBrake.position.set(0.0, 0.055, -1.56);
vmSniperGroup.add(vmSniperBrake);

const vmSniperScopeBody = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.62, 28, 1, true), vmSniperScopeBodyMat);
vmSniperScopeBody.rotation.x = Math.PI / 2;
vmSniperScopeBody.position.set(0.0, 0.176, -0.26);
vmSniperGroup.add(vmSniperScopeBody);
const vmSniperScopeRingA = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.012, 18, 1, true), vmSniperScopeRingMat);
vmSniperScopeRingA.rotation.x = Math.PI / 2;
vmSniperScopeRingA.position.set(0.0, 0.176, -0.10);
vmSniperGroup.add(vmSniperScopeRingA);
const vmSniperScopeRingB = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.012, 18, 1, true), vmSniperScopeRingMat);
vmSniperScopeRingB.rotation.x = Math.PI / 2;
vmSniperScopeRingB.position.set(0.0, 0.176, -0.40);
vmSniperGroup.add(vmSniperScopeRingB);
const vmSniperScopeFront = new THREE.Mesh(new THREE.CircleGeometry(0.037, 20), vmSniperScopeLensMat);
vmSniperScopeFront.position.set(0.0, 0.176, -0.58);
vmSniperGroup.add(vmSniperScopeFront);

const vmScopeMountMat = new THREE.MeshStandardMaterial({ color: 0x4b5562, roughness: 0.45, metalness: 0.95 });
const vmScopeMountBaseA = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.022, 0.050), vmScopeMountMat);
vmScopeMountBaseA.position.set(0.0, 0.141, -0.10);
vmSniperGroup.add(vmScopeMountBaseA);
const vmScopeMountBaseB = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.022, 0.050), vmScopeMountMat);
vmScopeMountBaseB.position.set(0.0, 0.141, -0.40);
vmSniperGroup.add(vmScopeMountBaseB);

const vmSniperBoltGroup = new THREE.Group();
vmSniperGroup.add(vmSniperBoltGroup);
const vmSniperBolt = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.20, 10), vmSniperSteel);
vmSniperBolt.rotation.z = Math.PI / 2;
vmSniperBolt.position.set(0.07, 0.07, -0.20);
vmSniperBoltGroup.add(vmSniperBolt);
const vmSniperHandle = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), vmSniperSteel);
vmSniperHandle.position.set(0.165, 0.07, -0.20);
vmSniperBoltGroup.add(vmSniperHandle);

vmSniperGroup.position.set(0.23, -0.28, -0.38);
vmSniperGroup.rotation.y = -0.03;
vmSniperGroup.visible = false;
camera.add(vmSniperGroup);
const SNIPER_VM_HIP = { x: 0.23, y: -0.28, z: -0.38, ry: -0.03, rx: 0.0 };
const SNIPER_VM_ADS_LIFT = { x: 0.0, y: -0.226, z: -0.560, ry: 0.0, rx: 0.003 };
const SNIPER_VM_ADS_EYE = { x: 0.0, y: -0.202, z: -0.390, ry: 0.0, rx: 0.0 };

// === Double-barrel shotgun viewmodel ===
const vmShotgunGroup = new THREE.Group();
const vmShotgunBreakGroup = new THREE.Group();
vmShotgunGroup.add(vmShotgunBreakGroup);
const vmShotgunWood = new THREE.MeshStandardMaterial({
    map: makeRifleStockTexture(),
    color: 0xb8ab95,
    roughness: 0.78,
    metalness: 0.05
});
const vmShotgunSteel = new THREE.MeshStandardMaterial({ color: 0x7b8792, roughness: 0.20, metalness: 0.98 });
const vmShotgunBlack = new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.48, metalness: 0.72 });
const vmShotgunBrass = new THREE.MeshStandardMaterial({ color: 0xb68f44, roughness: 0.30, metalness: 0.92 });

const vmShotgunStock = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.11, 0.78), vmShotgunWood);
vmShotgunStock.position.set(0.0, -0.03, 0.12);
vmShotgunGroup.add(vmShotgunStock);
const vmShotgunGrip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, 0.11), vmShotgunWood);
vmShotgunGrip.position.set(0.02, -0.13, 0.16);
vmShotgunGrip.rotation.x = -0.30;
vmShotgunGroup.add(vmShotgunGrip);
const vmShotgunButt = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.10, 0.05), vmShotgunBlack);
vmShotgunButt.position.set(0.0, -0.03, 0.47);
vmShotgunGroup.add(vmShotgunButt);

const vmShotgunReceiver = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.09, 0.24), vmShotgunSteel);
vmShotgunReceiver.position.set(0.0, 0.03, -0.05);
vmShotgunGroup.add(vmShotgunReceiver);
const vmShotgunTriggerGuard = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.007, 8, 12), vmShotgunBlack);
vmShotgunTriggerGuard.rotation.x = Math.PI / 2;
vmShotgunTriggerGuard.position.set(0.0, -0.09, 0.05);
vmShotgunGroup.add(vmShotgunTriggerGuard);

const vmShotgunHinge = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.11, 10), vmShotgunBlack);
vmShotgunHinge.rotation.z = Math.PI / 2;
vmShotgunHinge.position.set(0.0, 0.04, -0.18);
vmShotgunGroup.add(vmShotgunHinge);
const vmShotgunTopLeverPivot = new THREE.Group();
vmShotgunTopLeverPivot.position.set(0.0, 0.082, -0.16);
const vmShotgunTopLever = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.012, 0.16), vmShotgunSteel);
vmShotgunTopLever.position.set(0.0, 0.0, -0.075);
vmShotgunTopLeverPivot.add(vmShotgunTopLever);
vmShotgunGroup.add(vmShotgunTopLeverPivot);

vmShotgunBreakGroup.position.set(0.0, 0.045, -0.18);
const vmShotgunBarrelL = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.048, 1.10, 14), vmShotgunSteel);
vmShotgunBarrelL.rotation.x = Math.PI / 2;
vmShotgunBarrelL.position.set(-0.052, 0.0, -0.56);
vmShotgunBreakGroup.add(vmShotgunBarrelL);
const vmShotgunBarrelR = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.048, 1.10, 14), vmShotgunSteel);
vmShotgunBarrelR.rotation.x = Math.PI / 2;
vmShotgunBarrelR.position.set(0.052, 0.0, -0.56);
vmShotgunBreakGroup.add(vmShotgunBarrelR);

const vmShotgunRib = new THREE.Mesh(new THREE.BoxGeometry(0.064, 0.014, 0.96), vmShotgunBlack);
vmShotgunRib.position.set(0.0, 0.019, -0.58);
vmShotgunBreakGroup.add(vmShotgunRib);
const vmShotgunFore = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.08, 0.34), vmShotgunWood);
vmShotgunFore.position.set(0.0, -0.05, -0.34);
vmShotgunBreakGroup.add(vmShotgunFore);

const vmShotgunMuzzleL = new THREE.Mesh(new THREE.TorusGeometry(0.047, 0.005, 6, 14), vmShotgunBlack);
vmShotgunMuzzleL.position.set(-0.052, 0.0, -1.11);
vmShotgunBreakGroup.add(vmShotgunMuzzleL);
const vmShotgunMuzzleR = new THREE.Mesh(new THREE.TorusGeometry(0.047, 0.005, 6, 14), vmShotgunBlack);
vmShotgunMuzzleR.position.set(0.052, 0.0, -1.11);
vmShotgunBreakGroup.add(vmShotgunMuzzleR);
const vmShotgunBead = new THREE.Mesh(new THREE.SphereGeometry(0.005, 8, 6), vmShotgunBrass);
vmShotgunBead.position.set(0.0, 0.025, -1.10);
vmShotgunBreakGroup.add(vmShotgunBead);

const vmShotgunShellL = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.020, 0.072, 12), vmShotgunBrass);
vmShotgunShellL.rotation.x = Math.PI / 2;
vmShotgunShellL.position.set(-0.052, -0.010, -0.03);
vmShotgunBreakGroup.add(vmShotgunShellL);
const vmShotgunShellR = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.020, 0.072, 12), vmShotgunBrass);
vmShotgunShellR.rotation.x = Math.PI / 2;
vmShotgunShellR.position.set(0.052, -0.010, -0.03);
vmShotgunBreakGroup.add(vmShotgunShellR);
const vmShotgunEjectL = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.070, 12, 1, true), vmShotgunBrass);
vmShotgunEjectL.rotation.x = Math.PI / 2;
vmShotgunEjectL.position.set(-0.052, -0.010, -0.03);
vmShotgunEjectL.visible = false;
vmShotgunBreakGroup.add(vmShotgunEjectL);
const vmShotgunEjectR = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.070, 12, 1, true), vmShotgunBrass);
vmShotgunEjectR.rotation.x = Math.PI / 2;
vmShotgunEjectR.position.set(0.052, -0.010, -0.03);
vmShotgunEjectR.visible = false;
vmShotgunBreakGroup.add(vmShotgunEjectR);

vmShotgunGroup.position.set(0.22, -0.29, -0.34);
vmShotgunGroup.rotation.y = 0;
vmShotgunGroup.visible = false;
camera.add(vmShotgunGroup);

// === Level-editor hand viewmodel ===
const vmHandSkinMat = new THREE.MeshStandardMaterial({ color: 0xf0c080, roughness: 0.75, metalness: 0.0 });
const vmHandSkinDark = new THREE.MeshStandardMaterial({ color: 0xdba86a, roughness: 0.8, metalness: 0.0 });
const vmHandCuffMat = new THREE.MeshStandardMaterial({ color: 0x3a5a2e, roughness: 0.9, metalness: 0.0 });
const vmHandGroup = new THREE.Group();
{
    // Forearm / cuff angling back toward the bottom-right of the screen
    const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.075, 0.10), vmHandCuffMat);
    cuff.position.set(0.012, -0.020, 0.085);
    cuff.rotation.x = 0.18;
    vmHandGroup.add(cuff);
    const wrist = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.058, 0.06), vmHandSkinDark);
    wrist.position.set(0.006, -0.006, 0.038);
    vmHandGroup.add(wrist);

    // Palm � slightly wider than deep, tilted a touch inward like a relaxed point
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.088, 0.042, 0.105), vmHandSkinMat);
    palm.position.set(0, 0, -0.030);
    palm.rotation.z = -0.06;
    vmHandGroup.add(palm);

    // Index finger � extended, two segments with a soft downward bend
    const idxA = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.020, 0.052), vmHandSkinMat);
    idxA.position.set(0.030, 0.004, -0.102);
    vmHandGroup.add(idxA);
    const idxB = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 0.046), vmHandSkinMat);
    idxB.position.set(0.030, 0.000, -0.146);
    idxB.rotation.x = -0.16;
    vmHandGroup.add(idxB);

    // Middle / ring / pinky � curled under: a knuckle stub angled down plus a
    // folded segment tucked toward the palm.
    const curls = [
        { x:  0.008, len: 1.00 },   // middle
        { x: -0.015, len: 0.94 },   // ring
        { x: -0.036, len: 0.80 },   // pinky
    ];
    for (const c of curls) {
        const knuckle = new THREE.Mesh(new THREE.BoxGeometry(0.019, 0.020, 0.034 * c.len), vmHandSkinMat);
        knuckle.position.set(c.x, -0.004, -0.092);
        knuckle.rotation.x = 0.85;
        vmHandGroup.add(knuckle);
        const fold = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.017, 0.030 * c.len), vmHandSkinDark);
        fold.position.set(c.x, -0.026, -0.082);
        fold.rotation.x = 1.9;
        vmHandGroup.add(fold);
    }

    // Thumb � two segments wrapping over the curled fingers from the left
    const thumbA = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.020, 0.044), vmHandSkinMat);
    thumbA.position.set(-0.048, 0.004, -0.052);
    thumbA.rotation.set(0.0, 0.55, -0.35);
    vmHandGroup.add(thumbA);
    const thumbB = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 0.036), vmHandSkinDark);
    thumbB.position.set(-0.030, 0.006, -0.086);
    thumbB.rotation.set(0.0, 0.95, -0.30);
    vmHandGroup.add(thumbB);
}
vmHandGroup.position.set(0.20, -0.23, -0.42);
vmHandGroup.rotation.set(-0.12, -0.22, 0.10);   // relaxed point toward the crosshair
vmHandGroup.visible = false;
camera.add(vmHandGroup);

// === Grenade viewmodel: egg-shaped frag grenade held in right hand ===
const vmGrenadeGroup = new THREE.Group();
const _vmGrenMat = new THREE.MeshStandardMaterial({ color: 0x4a5e2a, roughness: 0.72, metalness: 0.30 });
const _vmGrenBandMat = new THREE.MeshStandardMaterial({ color: 0x2e3a1c, roughness: 0.82, metalness: 0.40 });
const _vmGrenMetalMat = new THREE.MeshStandardMaterial({ color: 0xb0b8b0, roughness: 0.30, metalness: 0.85 });
// Egg body: sphere squashed X/Z, elongated Y
const _vmGrenBody = new THREE.Mesh(new THREE.SphereGeometry(0.046, 14, 12), _vmGrenMat);
_vmGrenBody.scale.set(1.0, 1.32, 1.0);
vmGrenadeGroup.add(_vmGrenBody);
// Equatorial segmentation ring
const _vmGrenRing = new THREE.Mesh(new THREE.TorusGeometry(0.047, 0.005, 6, 18), _vmGrenBandMat);
vmGrenadeGroup.add(_vmGrenRing);
// Vertical rib
const _vmGrenRibH = new THREE.Mesh(new THREE.TorusGeometry(0.046, 0.004, 5, 18, Math.PI), _vmGrenBandMat);
_vmGrenRibH.rotation.y = Math.PI / 2;
vmGrenadeGroup.add(_vmGrenRibH);
// Cap / fuse well on top
const _vmGrenCap = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.020, 0.022, 8), _vmGrenMetalMat);
_vmGrenCap.position.y = 0.058;
vmGrenadeGroup.add(_vmGrenCap);
// Safety lever (spoon)
const _vmGrenLever = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.044, 0.009), _vmGrenMetalMat);
_vmGrenLever.position.set(0.048, 0.010, 0);
vmGrenadeGroup.add(_vmGrenLever);
// Pin ring
const _vmGrenPin = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.003, 5, 10), _vmGrenMetalMat);
_vmGrenPin.position.set(0.048, 0.040, 0);
_vmGrenPin.rotation.y = Math.PI / 2;
vmGrenadeGroup.add(_vmGrenPin);
// Fuse ember (glows orange while cooking)
const _vmGrenFuseMat = new THREE.MeshStandardMaterial({
    color: 0xff6600, emissive: 0xff4400, emissiveIntensity: 0, roughness: 0.9, metalness: 0
});
const _vmGrenFuse = new THREE.Mesh(new THREE.SphereGeometry(0.0055, 6, 4), _vmGrenFuseMat);
_vmGrenFuse.position.y = 0.075;
vmGrenadeGroup.add(_vmGrenFuse);
// Fuse cord: two-segment pendulum. SegA anchored at cap, SegB hangs from
// a pivot at the top of SegA and sways with spring physics.
const _vmGrenFuseCordMat = new THREE.MeshStandardMaterial({ color: 0x886633, roughness: 1.0, metalness: 0 });
const FUSE_CORD_MAX_LEN = 0.045;
const FUSE_HALF = FUSE_CORD_MAX_LEN * 0.5;
const _vmGrenFuseBase = _vmGrenCap.position.y + 0.013; // y where cord exits cap top
// Upper segment � stays vertical, anchored at cap
const _vmGrenFuseSegA = new THREE.Mesh(new THREE.CylinderGeometry(0.0032, 0.0032, FUSE_HALF, 5), _vmGrenFuseCordMat);
_vmGrenFuseSegA.position.y = _vmGrenFuseBase + FUSE_HALF * 0.5;
vmGrenadeGroup.add(_vmGrenFuseSegA);
// Pivot at top of SegA � SegB and ember swing around this point
const _vmGrenFusePivot = new THREE.Object3D();
_vmGrenFusePivot.position.y = _vmGrenFuseBase + FUSE_HALF;
vmGrenadeGroup.add(_vmGrenFusePivot);
// Lower segment � child of pivot, droops and sways
const _vmGrenFuseSegB = new THREE.Mesh(new THREE.CylinderGeometry(0.0028, 0.0016, FUSE_HALF, 5), _vmGrenFuseCordMat);
_vmGrenFuseSegB.position.y = FUSE_HALF * 0.5;
_vmGrenFusePivot.add(_vmGrenFuseSegB);
// Fuse ember � re-parent from vmGrenadeGroup to pivot so it swings with SegB
vmGrenadeGroup.remove(_vmGrenFuse);
_vmGrenFuse.position.y = FUSE_HALF;
_vmGrenFusePivot.add(_vmGrenFuse);
// Spring state for pendulum
let _fuseSwayX = 0.04, _fuseSwayZ = 0.02;
let _fuseVelX = 0, _fuseVelZ = 0;
let _prevYawForFuse = 0, _prevPitchForFuse = 0;
vmGrenadeGroup.position.set(0.14, -0.21, -0.32);
vmGrenadeGroup.rotation.set(0.15, -0.3, 0.55);
vmGrenadeGroup.visible = false;
camera.add(vmGrenadeGroup);

// Grenade cook state
let grenadeCooking = false;
let grenadeCookStart = 0;
const GRENADE_FUSE_MS = 4800;   // full fuse duration when not cooked
let _grenadeThrowConsumeClick = false;

let yaw = Math.PI;  // start facing castle (+Z direction)
let pitch = 0.2;
const DEFAULT_PITCH_MIN = -0.15;
const MINIGUN_PITCH_MIN = -1.18;
const SNIPER_PITCH_MIN = -0.95;
const PITCH_MAX = 0.75;
const NORMAL_FOV = 70;
const SNIPER_FOV_AIM = 26;
const SNIPER_ZOOM_LERP = 15;
let pointerLocked = false;
const touchControls = {
    enabled: isMobileProfile,
    active: false,
    moveTouchId: null,
    lookTouchId: null,
    moveStartX: 0,
    moveStartY: 0,
    moveRight: 0,
    moveForward: 0,
    lookLastX: 0,
    lookLastY: 0,
    lookMoved: false,
    lookStartAt: 0,
    hud: null,
    pad: null,
    stick: null,
    sniperAimBtn: null,
    sniperAimHeld: false,
};

function applyInputUiMode() {
    const touchUi = !!touchControls.enabled;
    document.body.classList.toggle('touch-ui', touchUi);
    document.body.classList.toggle('desktop-ui', !touchUi);
}

function applyTouchRuntimeUi() {
    renderer.domElement.style.touchAction = 'none';
    const lockMsgP = document.querySelector('#lockMsg p');
    if (lockMsgP) lockMsgP.textContent = 'Tap to begin and use touch controls';
    const weaponBarEl = document.getElementById('weaponBar');
    if (weaponBarEl) weaponBarEl.style.pointerEvents = 'auto';
    document.querySelectorAll('.wBtn').forEach(btn => {
        btn.style.pointerEvents = 'auto';
        btn.style.cursor = 'pointer';
    });
}

function activateTouchProfileIfNeeded() {
    if (!touchControls.enabled) {
        touchControls.enabled = true;
        applyInputUiMode();
    }
    applyTouchRuntimeUi();
}

function hasPrimaryPlayerInputCapture() {
    return pointerLocked || touchControls.active;
}

function updateTouchStick() {
    if (!touchControls.stick) return;
    touchControls.stick.style.transform = `translate(calc(-50% + ${(touchControls.moveRight * 30).toFixed(1)}px), calc(-50% + ${(-touchControls.moveForward * 30).toFixed(1)}px))`;
}

function isTouchInMovePad(clientX, clientY) {
    const pad = touchControls.pad;
    if (!pad) return false;
    const r = pad.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

function ensureTouchHud() {
    if (!touchControls.enabled || touchControls.hud) return;
    const compactHud = window.innerWidth <= 430 || window.innerHeight <= 760;
    const padSize = compactHud ? 116 : 130;
    const stickSize = compactHud ? 46 : 52;
    const hud = document.createElement('div');
    hud.id = 'touchHud';
    hud.style.position = 'fixed';
    hud.style.inset = '0';
    hud.style.pointerEvents = 'none';
    hud.style.zIndex = '120';

    const pad = document.createElement('div');
    pad.style.position = 'absolute';
    pad.style.left = compactHud ? '14px' : '24px';
    pad.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 14px)';
    pad.style.width = `${padSize}px`;
    pad.style.height = `${padSize}px`;
    pad.style.borderRadius = '50%';
    pad.style.border = '2px solid rgba(255,255,255,0.32)';
    pad.style.background = 'radial-gradient(circle at 35% 35%, rgba(255,255,255,0.24), rgba(0,0,0,0.22))';
    pad.style.boxShadow = '0 12px 28px rgba(0,0,0,0.45)';

    const stick = document.createElement('div');
    stick.style.position = 'absolute';
    stick.style.left = '50%';
    stick.style.top = '50%';
    stick.style.width = `${stickSize}px`;
    stick.style.height = `${stickSize}px`;
    stick.style.borderRadius = '50%';
    stick.style.border = '2px solid rgba(255,255,255,0.42)';
    stick.style.background = 'radial-gradient(circle at 30% 30%, rgba(241,196,15,0.75), rgba(130,90,8,0.76))';
    stick.style.transform = 'translate(-50%, -50%)';
    pad.appendChild(stick);

    const aimHint = document.createElement('div');
    aimHint.textContent = 'Right side: drag to aim, use FIRE button';
    aimHint.style.position = 'absolute';
    aimHint.style.right = compactHud ? '12px' : '18px';
    aimHint.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 8px)';
    aimHint.style.padding = '6px 10px';
    aimHint.style.borderRadius = '999px';
    aimHint.style.background = 'rgba(0,0,0,0.45)';
    aimHint.style.border = '1px solid rgba(255,255,255,0.18)';
    aimHint.style.color = '#e7ecff';
    aimHint.style.fontSize = '11px';
    aimHint.style.letterSpacing = '0.03em';
    if (compactHud) aimHint.style.display = 'none';

    const sniperAimBtn = document.createElement('button');
    sniperAimBtn.id = 'mobileSniperAimBtn';
    sniperAimBtn.type = 'button';
    sniperAimBtn.textContent = 'AIM';
    sniperAimBtn.setAttribute('aria-pressed', 'false');
    sniperAimBtn.style.position = 'absolute';
    sniperAimBtn.style.left = compactHud ? '138px' : '164px';
    sniperAimBtn.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 40px)';
    sniperAimBtn.style.width = compactHud ? '62px' : '70px';
    sniperAimBtn.style.height = compactHud ? '62px' : '70px';
    sniperAimBtn.style.borderRadius = '50%';
    sniperAimBtn.style.border = '2px solid rgba(225, 238, 255, 0.6)';
    sniperAimBtn.style.background = 'radial-gradient(circle at 30% 30%, rgba(45, 64, 96, 0.95), rgba(17, 27, 46, 0.95))';
    sniperAimBtn.style.color = '#d9ecff';
    sniperAimBtn.style.fontWeight = '800';
    sniperAimBtn.style.fontSize = compactHud ? '12px' : '13px';
    sniperAimBtn.style.letterSpacing = '0.08em';
    sniperAimBtn.style.pointerEvents = 'auto';
    sniperAimBtn.style.touchAction = 'none';
    sniperAimBtn.style.display = 'none';
    sniperAimBtn.style.boxShadow = '0 10px 24px rgba(0,0,0,0.45)';

    const setSniperAimButtonHeld = held => {
        touchControls.sniperAimHeld = held;
        sniperAimBtn.classList.toggle('active', held);
        sniperAimBtn.style.borderColor = held ? 'rgba(143, 212, 255, 0.95)' : 'rgba(225, 238, 255, 0.6)';
        sniperAimBtn.style.boxShadow = held
            ? '0 0 0 2px rgba(116, 208, 255, 0.5), 0 12px 28px rgba(0,0,0,0.5)'
            : '0 10px 24px rgba(0,0,0,0.45)';
        sniperAimBtn.setAttribute('aria-pressed', held ? 'true' : 'false');
        if (currentWeapon === WEAPON_IDX_SNIPER && hasPrimaryPlayerInputCapture()) {
            sniperAiming = held || touchControls.lookTouchId != null;
        }
    };

    const aimStart = e => {
        e.preventDefault();
        e.stopPropagation();
        if (!touchControls.enabled || twoPlayerMode || currentWeapon !== WEAPON_IDX_SNIPER || !hasPrimaryPlayerInputCapture()) return;
        setSniperAimButtonHeld(true);
    };
    const aimEnd = e => {
        e.preventDefault();
        e.stopPropagation();
        setSniperAimButtonHeld(false);
    };

    sniperAimBtn.addEventListener('touchstart', aimStart, { passive: false });
    sniperAimBtn.addEventListener('touchend', aimEnd, { passive: false });
    sniperAimBtn.addEventListener('touchcancel', aimEnd, { passive: false });
    sniperAimBtn.addEventListener('mousedown', aimStart);
    sniperAimBtn.addEventListener('mouseup', aimEnd);
    sniperAimBtn.addEventListener('mouseleave', aimEnd);

    hud.appendChild(pad);
    hud.appendChild(aimHint);
    hud.appendChild(sniperAimBtn);
    document.body.appendChild(hud);

    touchControls.hud = hud;
    touchControls.pad = pad;
    touchControls.stick = stick;
    touchControls.sniperAimBtn = sniperAimBtn;
    updateTouchStick();
    updateMobileSniperAimButton();
}

function updateMobileSniperAimButton() {
    const btn = touchControls.sniperAimBtn;
    if (!btn) return;
    const visible = !!(touchControls.enabled && touchControls.active && !twoPlayerMode && currentWeapon === WEAPON_IDX_SNIPER);
    btn.style.display = visible ? 'block' : 'none';
    if (!visible) {
        touchControls.sniperAimHeld = false;
        btn.classList.remove('active');
        btn.style.borderColor = 'rgba(225, 238, 255, 0.6)';
        btn.style.boxShadow = '0 10px 24px rgba(0,0,0,0.45)';
        btn.setAttribute('aria-pressed', 'false');
    }
}

function setTouchHudVisible(visible) {
    if (touchControls.hud) {
        touchControls.hud.style.display = visible ? 'block' : 'none';
    }
    if (!visible) touchControls.sniperAimHeld = false;
    updateMobileSniperAimButton();
}

function beginTouchControls() {
    if (!touchControls.enabled || twoPlayerMode) return false;
    unlockAndPrecacheSfx();
    touchControls.active = true;
    ensureTouchHud();
    setTouchHudVisible(true);
    _hasPlayed = true;
    setPaused(false);
    document.getElementById('lockMsg').style.display = 'none';
    return true;
}

function resetTouchInputs() {
    touchControls.moveTouchId = null;
    touchControls.lookTouchId = null;
    touchControls.moveRight = 0;
    touchControls.moveForward = 0;
    touchControls.lookMoved = false;
    minigunFiring = false;
    sniperAiming = false;
    sniperHoldBreath = false;
    touchControls.sniperAimHeld = false;
    if (touchControls.sniperAimBtn) {
        touchControls.sniperAimBtn.classList.remove('active');
        touchControls.sniperAimBtn.style.borderColor = 'rgba(225, 238, 255, 0.6)';
        touchControls.sniperAimBtn.style.boxShadow = '0 10px 24px rgba(0,0,0,0.45)';
        touchControls.sniperAimBtn.setAttribute('aria-pressed', 'false');
    }
    updateTouchStick();
}

const MOVE_SPEED = 8.0;  // m/s
const PLAYER_BASE_Y = 2.2;
const PLAYER_JUMP_SPEED = 10.4;
const PLAYER_GRAVITY = 18.0;
const LANDING_BOB_DURATION = 0.16;
const LANDING_BOB_ANGLE = 0.016;
const PLAYER_WATER_EYE_OFFSET = 0.86;
const PLAYER_WATER_DROWN_MIN_SEC = 3.2;
const PLAYER_WATER_DROWN_JITTER_SEC = 0.8;
const PLAYER_WATER_DRIFT_SPEED = 0.72;
const PLAYER_WATER_BOB_AMP = 0.11;
const PLAYER_WATER_ENTRY_LERP = 7.4;
// Keep player drowning triggers slightly inside the visual shoreline so
// exposed trench-edge grass/mud doesn't count as water contact.
const PLAYER_WATER_EDGE_BUFFER_CASTLE = 1.55;
const PLAYER_WATER_EDGE_BUFFER_BRIDGE = 0.90;
const PLAYER_WATER_CONTACT_DELAY_SEC = 0.6;
const WATER_SYSTEM_ENABLED = true;
const CASTLE_MOAT_WATER_ENABLED = true;
const BRIDGE_CHANNEL_WATER_ENABLED = true;
const SIMPLE_MURKY_WATER_OVERLAY = false;
const DEV_SHOW_BRIDGE_WATER_PERIMETERS = false;
const DEV_HIDE_ALL_GRASS = false;
// Bridge-level trench spans the crossing from ramp to ramp.
const BRIDGE_WATER_MIN_X = -35.5;
const BRIDGE_WATER_MAX_X = 35.5;
const BRIDGE_WATER_HALF_Z = 34;
const BRIDGE_WATER_VISUAL_HALF_Z = 36;
const BRIDGE_WATER_VISUAL_OUTSET = 0.0;
// The reflective library Water surface is back on for the bridge: the opaque
// solid-cap workaround (old mud-shoreline seam era) painted the whole trench a
// flat tan sheet and made the dev water toggle appear dead. The shore fill and
// water now share one sampled shoreline polyline, so the seam it hid is gone.
const BRIDGE_WATER_USE_LIBRARY_SURFACE = true;
const WATER_DEPTH_M = 0.70;
const WATER_VISUAL_SURFACE_DROP_M = 0.30;
const SIMPLE_WATER_SURFACE_Y = 0.028 - WATER_VISUAL_SURFACE_DROP_M;
const MURKY_WATER_COLOR = 0x5a4932;
const MURKY_WATER_OPACITY = 0.80;
const MURKY_WATER_CAP_OPACITY = 0.64;
const MURKY_WATER_REFLECTIVITY = 0.84;
const MURKY_WATER_ROUGHNESS = 0.07;
const MURKY_WATER_ENV_INTENSITY = 0.50;
const WATER_SETTLE_DEPTH_OFFSET = WATER_DEPTH_M;
let waterFxColor = MURKY_WATER_COLOR;
let waterFxOpacity = MURKY_WATER_OPACITY;
let waterFxImpactRipplesEnabled = true;
let waterFxRippleStrengthMul = 1.4;
let waterFxRippleSizeMul = 1.25;
let waterFxRippleLifeMul = 1.15;
let devWaterFxEnabled = true;
const WATER_BRICK_LINEAR_DAMPING = 0.84;
const WATER_BRICK_ANGULAR_DAMPING = 0.95;
const WATER_BRICK_SLEEP_SPEED2 = 0.012;
const WATER_BRICK_SLEEP_ANG2 = 0.06;
const WATER_BRICK_SLEEP_DELAY = 0.30;
let playerYVel = 0;
let playerOnGround = true;
let jumpQueued = false;
let landingBobTimer = 0;
let playerWaterState = null;
let playerWaterLastDurationSec = 0;
let playerWaterContactSec = 0;
let waterMouseRipple = 0;
let twoPlayerMode = false;
let invertMouse = false;
let disarmNpc   = false;
let guardsDisabled = false;
let slowMo      = false;
let minigunFiring   = false;
let minigunNextFire = 0;
const MINIGUN_RATE  = 80; // ms between shots
let shotgunNextFire = 0;
let p2ShotgunNextFire = 0;
let shotgunShotKick = 0;
let shotgunBreakAnim = 0;
let shotgunEjectAnim = 0;
let shotgunEjectTriggered = false;
const SHOTGUN_RATE = 820;
const SHOTGUN_PELLETS = 8;
const SHOTGUN_SPREAD = 0.062;
const SHOTGUN_STAGGER = 0.018;
const SHOTGUN_BREAK_SPEED = 2.0;
let sniperAiming = false;
let sniperNextFire = 0;
let p2SniperNextFire = 0;
const SNIPER_RATE = 680;
const sniperTracers = [];
let sniperHoldBreath = false;
let sniperBreathStamina = 1.0;
let sniperBreathCooldown = 0;
let sniperShotKick = 0;
let sniperBoltAnim = 0;
let sniperAdsWasAiming = false;
let sniperScopeAimBlend = 0;
let sniperAdsPose = 0;
let sniperScopeTunnel = 0;
const SNIPER_BREATH_DRAIN = 0.35;
const SNIPER_BREATH_RECOVER = 0.24;
const SNIPER_BREATH_COOLDOWN = 1.25;
const SNIPER_DRAG = 0.022;
const SNIPER_GRAVITY = 7.0;
const SNIPER_AIM_SENS = 0.56;

const WEAPON_IDX_SHOTGUN = 0;
const WEAPON_IDX_CANNON = 1;
const WEAPON_IDX_EXPLOSIVE = 2;
const WEAPON_IDX_MORTAR = 3;
const WEAPON_IDX_MINIGUN = 4;
const WEAPON_IDX_SNIPER  = 5;
const WEAPON_IDX_DRONE   = 6;
const WEAPON_IDX_GRENADE = 7;   // bouncing grenade launcher
const WEAPON_IDX_CLUSTER = 8;   // cluster bomb (mid-air burst)

function getPitchMinForWeapon(w) {
    if (window.__editorActive) return MINIGUN_PITCH_MIN;
    if (w === WEAPON_IDX_MINIGUN || w === WEAPON_IDX_SHOTGUN) return MINIGUN_PITCH_MIN;
    if (w === WEAPON_IDX_SNIPER) return SNIPER_PITCH_MIN;
    if (w === WEAPON_IDX_GRENADE || w === WEAPON_IDX_CLUSTER) return MINIGUN_PITCH_MIN;
    return DEFAULT_PITCH_MIN;
}
function clampAimPitch(v) {
    return Math.max(getPitchMinForWeapon(currentWeapon), Math.min(PITCH_MAX, v));
}

function getAimSensitivityScale() {
    return (currentWeapon === WEAPON_IDX_SNIPER && sniperAiming && !twoPlayerMode) ? SNIPER_AIM_SENS : 1;
}

// Hoisted here to avoid temporal dead zone � used before their declaration site
const npcList = [];
let gameOver = false;
let gameOverPending = false;
let gameOverPendingAt = 0;
let gameOverCalmSec = 0;
let _npcAggroTriggered = false;
let _hutChargerTriggered = false;
let playerHits = 0;
let playerDefeatReason = '';
let gamePaused = true;
let _hasPlayed = false;
let _gameStarted = false;   // true once a difficulty is chosen from the start modal
let _roundStartAtMs = performance.now();
const GAME_OVER_MIN_DELAY_MS = 1300;
const GAME_OVER_MAX_DELAY_MS = 4200;
const GAME_OVER_CALM_AWAKE_LIMIT = 3;
const GAME_OVER_CALM_HOLD_SEC = 0.45;

// === Ball-cam (right-mouse hold, or always-on via settings) ===
let ballCamActive = false;
let ballCamAuto = true;    // auto ball-cam on by default on both desktop and mobile
const _insetHiddenMeshes = [];  // scratch: meshes hidden for the ball-cam inset pass
let mobileBallCamPinned = false;
let lastFiredBall = null;  // { mesh, body } of the most recently fired cannonball
const ballCamera = new THREE.PerspectiveCamera(80, 16 / 9, 0.05, 300);
ballCamera.rotation.order = 'YXZ';
const _ballCamDir = new THREE.Vector3();
const _ballCamUp  = new THREE.Vector3(0, 1, 0);
const ballCamCrtEl    = document.getElementById('ballCamCrt');
const ballCamScreenEl = document.getElementById('ballCamScreen');
const mobileBallCamBtn = document.getElementById('mobileBallCamBtn');

// === FPV Drone ===
const droneCamera = new THREE.PerspectiveCamera(90, 16/9, 0.04, 300);
droneCamera.rotation.order = 'YXZ';
const droneFpvOverlayEl = document.getElementById('droneFpvOverlay');
const droneFpvScreenEl  = document.getElementById('droneFpvScreen');
const droneFpvAltEl     = document.getElementById('droneFpvAlt');
const droneFpvSpeedEl   = document.getElementById('droneFpvSpeed');
let droneBlastReplayTimer = 0;
const _droneBlastPos = new THREE.Vector3();
let droneYaw     = 0;
let dronePitch   = 0;    // nose tilt: +forward, -back
let droneRoll    = 0;
let droneVx      = 0, droneVy = 0, droneVz = 0;
let activeDrone  = null;           // { body, group, propFL, propFR, detonated }
let droneCamPitch = 0;             // camera look up/down from mouse (separate from movement pitch)
let droneAscend  = false;          // LMB held
let droneDescend = false;          // RMB held

// Grenade launcher: bouncy contact material (created lazily on first shot)
const _grenadeCcMat = new CANNON.Material('grenade');
let   _grenadeContactMatAdded = false;
const DRONE_PITCH_LIMIT  = 1.18;   // rad nose-down (matches MINIGUN_PITCH_MIN steep dive)
const DRONE_PITCH_MIN    = -0.75;  // rad nose-up (matches player PITCH_MAX sky angle)
const DRONE_ROLL_LIMIT   = 0.30;   // rad
const DRONE_ROLL_SPEED   = 4.0;    // spring-back rate
const DRONE_FWD_SPEED    = 18.0;   // m/s at full pitch tilt
const DRONE_UP_SPEED     = 10.0;   // m/s vertical
const DRONE_GRAVITY      = 2.2;    // partial gravity (drone partially offsets)
const DRONE_DRAG         = 2.8;    // velocity damping
const DRONE_PROP_SPIN    = 26.0;   // rad/s propeller visual spin
const DRONE_BLAST_RADIUS = 9.5;    // heavier payload � between explosive and mortar
const DRONE_MOUSE_YAW    = 1.0;    // mouse-x -> yaw multiplier
const DRONE_MOUSE_PITCH  = 0.55;   // mouse-y -> pitch-tilt multiplier
const mobileFullscreenBtn = document.getElementById('mobileFullscreenBtn');

function setBallCamCrtVisible(visible) {
    if (!ballCamCrtEl) return;
    ballCamCrtEl.style.display = visible ? 'block' : 'none';
}

function updateMobileBallCamButton() {
    if (!mobileBallCamBtn) return;
    const visible = touchControls.enabled && !twoPlayerMode;
    mobileBallCamBtn.style.display = visible ? 'block' : 'none';
    if (!visible) mobileBallCamPinned = false;
    mobileBallCamBtn.classList.toggle('active', mobileBallCamPinned);
    mobileBallCamBtn.textContent = mobileBallCamPinned ? 'Unpin Ball Cam' : 'Pin Ball Cam';
    mobileBallCamBtn.setAttribute('aria-pressed', mobileBallCamPinned ? 'true' : 'false');
}

function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function hasFullscreenSupport() {
    const de = document.documentElement;
    return !!(de.requestFullscreen || de.webkitRequestFullscreen);
}

function updateMobileFullscreenButton() {
    if (!mobileFullscreenBtn) return;
    const visible = touchControls.enabled && hasFullscreenSupport();
    mobileFullscreenBtn.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    const active = !!getFullscreenElement();
    mobileFullscreenBtn.classList.toggle('active', active);
    mobileFullscreenBtn.textContent = active ? 'Exit Full Screen' : 'Full Screen';
    mobileFullscreenBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
}

async function toggleMobileFullscreen() {
    const de = document.documentElement;
    const active = !!getFullscreenElement();
    try {
        if (!active) {
            if (de.requestFullscreen) await de.requestFullscreen();
            else if (de.webkitRequestFullscreen) de.webkitRequestFullscreen();
        } else {
            if (document.exitFullscreen) await document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        }
    } catch (e) {
        // Ignore failed requests; browser gesture policies vary across devices.
    }
    updateMobileFullscreenButton();
}

window.addEventListener('mousedown', e => {
    if (e.button !== 2) return;
    if (pointerLocked && !twoPlayerMode && currentWeapon === WEAPON_IDX_SNIPER) {
        sniperAiming = true;
        ballCamActive = false;
    } else {
        ballCamActive = true;
    }
});
window.addEventListener('mouseup', e => {
    if (e.button !== 2) return;
    ballCamActive = false;
    sniperAiming = false;
});
window.addEventListener('contextmenu', e => e.preventDefault());
const keys = { w: false, a: false, s: false, d: false };

function bindTapActivate(el, handler) {
    if (!el) return;
    let lastTouchAt = -1;
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartAt = 0;
    let touchMoved = false;
    let activeTouchId = null;
    el.addEventListener('touchstart', e => {
        const t = e.changedTouches && e.changedTouches[0];
        if (!t) return;
        touchStartX = t.clientX;
        touchStartY = t.clientY;
        touchStartAt = performance.now();
        touchMoved = false;
        activeTouchId = t.identifier;
    }, { passive: true });
    el.addEventListener('touchmove', e => {
        if (activeTouchId == null) return;
        for (const t of e.changedTouches || []) {
            if (t.identifier !== activeTouchId) continue;
            const dx = t.clientX - touchStartX;
            const dy = t.clientY - touchStartY;
            if (dx * dx + dy * dy > 20 * 20) touchMoved = true;
            break;
        }
    }, { passive: true });
    el.addEventListener('touchend', e => {
        const t = e.changedTouches && e.changedTouches[0];
        if (t && activeTouchId != null && t.identifier !== activeTouchId) return;
        const heldMs = performance.now() - touchStartAt;
        const shouldActivate = !touchMoved && heldMs < 420;
        activeTouchId = null;
        if (!shouldActivate) return;
        lastTouchAt = performance.now();
        e.preventDefault();
        e.stopPropagation();
        handler(e);
    }, { passive: false });
    el.addEventListener('click', e => {
        if (lastTouchAt >= 0 && (performance.now() - lastTouchAt) < 700) return;
        handler(e);
    });
}

if (touchControls.enabled) activateTouchProfileIfNeeded();
applyInputUiMode();

// Safety net for iOS/Safari variants that misreport pointers at startup.
window.addEventListener('touchstart', () => activateTouchProfileIfNeeded(), { capture: true, passive: true });
window.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') activateTouchProfileIfNeeded();
}, { capture: true, passive: true });

window.addEventListener("keydown", e => {
    if (e.code === "KeyW") keys.w = true;
    if (e.code === "KeyA") keys.a = true;
    if (e.code === "KeyS") keys.s = true;
    if (e.code === "KeyD") keys.d = true;
    if (e.code === "Space" && hasPrimaryPlayerInputCapture()) {
        jumpQueued = true;
        e.preventDefault();
    }
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") sniperHoldBreath = true;
});
window.addEventListener("keyup", e => {
    if (e.code === "KeyW") keys.w = false;
    if (e.code === "KeyA") keys.a = false;
    if (e.code === "KeyS") keys.s = false;
    if (e.code === "KeyD") keys.d = false;
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") sniperHoldBreath = false;
});

// Overlay tap/click -> begin touch controls or request pointer lock.
bindTapActivate(document.getElementById("lockMsg"), () => {
    unlockAndPrecacheSfx();
    if (!beginTouchControls()) renderer.domElement.requestPointerLock();
});
const pauseActionsEl = document.getElementById('pauseActions');
const resumeBtn = document.getElementById('resumeBtn');
const pauseRetryBtn = document.getElementById('pauseRetryBtn');
const goRetryBtn = document.getElementById('goRetryBtn');
const goMenuBtn  = document.getElementById('goMenuBtn');
if (resumeBtn) {
    resumeBtn.addEventListener('click', e => {
        e.stopPropagation();
        unlockAndPrecacheSfx();
        if (!beginTouchControls()) renderer.domElement.requestPointerLock();
    });
}
if (pauseRetryBtn) {
    pauseRetryBtn.addEventListener('click', e => {
        e.stopPropagation();
        retryCurrentLevel();
    });
}
if (goRetryBtn) goRetryBtn.addEventListener('click', () => retryCurrentLevel());
if (goMenuBtn)  goMenuBtn.addEventListener('click',  () => returnToMenu());

// Canvas click while locked -> fire (P1 only, non-minigun weapons)
renderer.domElement.addEventListener("click", e => {
    if (e.button !== 0) return;  // left-click only - RMB is ball-cam
    if (!pointerLocked) return;  // touch mode fires only via dedicated mobile fire button
    if (window.__editorActive) return;  // editor edit mode: clicks place bricks, never fire (Play clears the flag)
    // Grenade/cluster throw is handled on mouseup � suppress the resulting click
    if (_grenadeThrowConsumeClick) { _grenadeThrowConsumeClick = false; return; }
    if (hasPrimaryPlayerInputCapture() && !twoPlayerMode) {
        if (activeDrone) {
            // LMB is now ascend (hold) while drone active � single click does nothing
        } else if (currentWeapon === WEAPON_IDX_DRONE) {
            fireDrone();
        } else if (currentWeapon === WEAPON_IDX_GRENADE || currentWeapon === WEAPON_IDX_CLUSTER) {
            // fired on mouseup � ignore click
        } else if (currentWeapon !== WEAPON_IDX_MINIGUN) {
            fireCannonball(parseFloat(document.getElementById("power").value));
        }
    }
});

// Minigun: fire while mouse held. Drone: LMB=ascend, RMB=descend while piloting.
// Grenade/cluster: LMB hold to cook, release to throw.
renderer.domElement.addEventListener('mousedown', e => {
    if (!hasPrimaryPlayerInputCapture() || twoPlayerMode) return;
    if (window.__editorActive) return;
    if (activeDrone) {
        if (e.button === 0) droneAscend  = true;
        if (e.button === 2) droneDescend = true;
        return;
    }
    if (e.button !== 0) return;
    if (currentWeapon === WEAPON_IDX_MINIGUN) { minigunFiring = true; minigunNextFire = 0; }
    if ((currentWeapon === WEAPON_IDX_GRENADE || currentWeapon === WEAPON_IDX_CLUSTER)
            && !gameOver && !gamePaused && pointerLocked && p1Ammo[currentWeapon] > 0) {
        grenadeCooking = true;
        grenadeCookStart = performance.now();
        vmGrenadeGroup.visible = true;
    }
});
renderer.domElement.addEventListener('mouseup', e => {
    if (e.button === 0) {
        minigunFiring = false; droneAscend = false;
        if (grenadeCooking) {
            grenadeCooking = false;
            vmGrenadeGroup.visible = false;
            _vmGrenFuseMat.emissiveIntensity = 0;
            if (!gameOver && !gamePaused && pointerLocked) {
                _grenadeThrowConsumeClick = true;
                const cookMs = Math.min(performance.now() - grenadeCookStart, GRENADE_FUSE_MS - 200);
                fireCannonballCooked(cookMs);
            }
        }
    }
    if (e.button === 2) { droneDescend = false; }
});

if (window.PointerEvent || (navigator.maxTouchPoints || 0) > 0 || ('ontouchstart' in window)) {
    const compactTouch = window.innerWidth <= 430 || window.innerHeight <= 760;
    const TOUCH_MOVE_RADIUS = compactTouch ? 52 : 58;
    const TOUCH_LOOK_SENS = compactTouch ? 0.0032 : 0.00355;
    const TOUCH_TAP_MOVE_PX = 8;
    const touchInputTarget = window;
    const isUiTouchTarget = target => {
        if (!(target instanceof Element)) return false;
        return !!target.closest('#weaponBar, #controls, #mobileWeaponHud, #mobileWeaponRoller, #mobileFireBtn, #mobileInteractBtn, #mobileBallCamBtn, #mobileFullscreenBtn, #settingsPanel, #settingsBtn, #twoPlayerBtn, #difficultyModal, #lockMsg, #pauseActions, #gameOver, button, input, label, .dmCard, .dmModeBtn, .pauseBtn, .goBtn');
    };
    const isUiTouchPoint = (x, y) => isUiTouchTarget(document.elementFromPoint(x, y));

    touchInputTarget.addEventListener('touchstart', e => {
        if (!_gameStarted) return;
        if (twoPlayerMode) return;
        if (gamePaused && _gameStarted && !hasPrimaryPlayerInputCapture()) beginTouchControls();

        let consumed = false;
        for (const t of e.changedTouches) {
            if (isUiTouchPoint(t.clientX, t.clientY)) continue;
            const touchOnMovePad = isTouchInMovePad(t.clientX, t.clientY);
            if (touchOnMovePad) {
                if (touchControls.moveTouchId == null) {
                    touchControls.moveTouchId = t.identifier;
                    touchControls.moveStartX = t.clientX;
                    touchControls.moveStartY = t.clientY;
                    touchControls.moveRight = 0;
                    touchControls.moveForward = 0;
                    updateTouchStick();
                    consumed = true;
                }
                continue;
            }

            if (touchControls.lookTouchId == null) {
                touchControls.lookTouchId = t.identifier;
                touchControls.lookLastX = t.clientX;
                touchControls.lookLastY = t.clientY;
                touchControls.lookMoved = false;
                touchControls.lookStartAt = performance.now();
                consumed = true;
            }
        }
        if (consumed) e.preventDefault();
    }, { passive: false });

    touchInputTarget.addEventListener('touchmove', e => {
        if (!_gameStarted) return;
        let consumed = false;
        for (const t of e.changedTouches) {
            if (t.identifier === touchControls.moveTouchId) {
                const dx = t.clientX - touchControls.moveStartX;
                const dy = t.clientY - touchControls.moveStartY;
                const len = Math.hypot(dx, dy) || 1;
                const clamped = Math.min(len, TOUCH_MOVE_RADIUS);
                const nx = (dx / len) * (clamped / TOUCH_MOVE_RADIUS);
                const ny = (dy / len) * (clamped / TOUCH_MOVE_RADIUS);
                touchControls.moveRight = nx;
                touchControls.moveForward = -ny;
                updateTouchStick();
                consumed = true;
                continue;
            }
            if (t.identifier === touchControls.lookTouchId) {
                const dx = (t.clientX - touchControls.lookLastX) * getAimSensitivityScale();
                const dy = (t.clientY - touchControls.lookLastY) * getAimSensitivityScale();
                if (activeDrone && !twoPlayerMode) {
                    droneYaw -= dx * TOUCH_LOOK_SENS * DRONE_MOUSE_YAW;
                    droneCamPitch += invertMouse ? (dy * TOUCH_LOOK_SENS * DRONE_MOUSE_PITCH) : (-dy * TOUCH_LOOK_SENS * DRONE_MOUSE_PITCH);
                    droneCamPitch = Math.max(-1.0, Math.min(0.9, droneCamPitch));
                } else {
                    yaw -= dx * TOUCH_LOOK_SENS;
                    pitch += invertMouse ? (dy * TOUCH_LOOK_SENS) : (-dy * TOUCH_LOOK_SENS);
                    pitch = clampAimPitch(pitch);
                }
                if (Math.abs(t.clientX - touchControls.lookLastX) > TOUCH_TAP_MOVE_PX ||
                    Math.abs(t.clientY - touchControls.lookLastY) > TOUCH_TAP_MOVE_PX) {
                    touchControls.lookMoved = true;
                }
                touchControls.lookLastX = t.clientX;
                touchControls.lookLastY = t.clientY;
                consumed = true;
            }
        }
        if (consumed) e.preventDefault();
    }, { passive: false });

    const endTouchHandler = e => {
        if (!_gameStarted) return;
        let consumed = false;
        for (const t of e.changedTouches) {
            if (t.identifier === touchControls.moveTouchId) {
                touchControls.moveTouchId = null;
                touchControls.moveRight = 0;
                touchControls.moveForward = 0;
                updateTouchStick();
                consumed = true;
                continue;
            }
            if (t.identifier === touchControls.lookTouchId) {
                if (currentWeapon === WEAPON_IDX_SNIPER) sniperAiming = !!touchControls.sniperAimHeld;
                touchControls.lookTouchId = null;
                touchControls.lookMoved = false;
                consumed = true;
            }
        }
        if (consumed) e.preventDefault();
    };

    touchInputTarget.addEventListener('touchend', endTouchHandler, { passive: false });
    touchInputTarget.addEventListener('touchcancel', endTouchHandler, { passive: false });

    // Pointer-event fallback for mobile browsers that do not reliably emit touch events.
    touchInputTarget.addEventListener('pointerdown', e => {
        if (e.pointerType !== 'touch') return;
        if (!_gameStarted) return;
        if (twoPlayerMode) return;
        activateTouchProfileIfNeeded();
        if (gamePaused && _gameStarted && !hasPrimaryPlayerInputCapture()) beginTouchControls();
        if (isUiTouchPoint(e.clientX, e.clientY)) return;

        const pid = `p${e.pointerId}`;
        const pointerOnMovePad = isTouchInMovePad(e.clientX, e.clientY);
        if (pointerOnMovePad) {
            if (touchControls.moveTouchId == null) {
                touchControls.moveTouchId = pid;
                touchControls.moveStartX = e.clientX;
                touchControls.moveStartY = e.clientY;
                touchControls.moveRight = 0;
                touchControls.moveForward = 0;
                updateTouchStick();
            }
            e.preventDefault();
            return;
        }

        if (touchControls.lookTouchId == null) {
            touchControls.lookTouchId = pid;
            touchControls.lookLastX = e.clientX;
            touchControls.lookLastY = e.clientY;
            touchControls.lookMoved = false;
            touchControls.lookStartAt = performance.now();
            e.preventDefault();
        }
    }, { passive: false });

    touchInputTarget.addEventListener('pointermove', e => {
        if (e.pointerType !== 'touch') return;
        const pid = `p${e.pointerId}`;
        if (pid === touchControls.moveTouchId) {
            const dx = e.clientX - touchControls.moveStartX;
            const dy = e.clientY - touchControls.moveStartY;
            const len = Math.hypot(dx, dy) || 1;
            const clamped = Math.min(len, TOUCH_MOVE_RADIUS);
            const nx = (dx / len) * (clamped / TOUCH_MOVE_RADIUS);
            const ny = (dy / len) * (clamped / TOUCH_MOVE_RADIUS);
            touchControls.moveRight = nx;
            touchControls.moveForward = -ny;
            updateTouchStick();
            e.preventDefault();
            return;
        }
        if (pid === touchControls.lookTouchId) {
            const dx = (e.clientX - touchControls.lookLastX) * getAimSensitivityScale();
            const dy = (e.clientY - touchControls.lookLastY) * getAimSensitivityScale();
            if (activeDrone && !twoPlayerMode) {
                droneYaw -= dx * TOUCH_LOOK_SENS * DRONE_MOUSE_YAW;
                droneCamPitch += invertMouse ? (dy * TOUCH_LOOK_SENS * DRONE_MOUSE_PITCH) : (-dy * TOUCH_LOOK_SENS * DRONE_MOUSE_PITCH);
                droneCamPitch = Math.max(-1.0, Math.min(0.9, droneCamPitch));
            } else {
                yaw -= dx * TOUCH_LOOK_SENS;
                pitch += invertMouse ? (dy * TOUCH_LOOK_SENS) : (-dy * TOUCH_LOOK_SENS);
                pitch = clampAimPitch(pitch);
            }
            if (Math.abs(e.clientX - touchControls.lookLastX) > TOUCH_TAP_MOVE_PX ||
                Math.abs(e.clientY - touchControls.lookLastY) > TOUCH_TAP_MOVE_PX) {
                touchControls.lookMoved = true;
            }
            touchControls.lookLastX = e.clientX;
            touchControls.lookLastY = e.clientY;
            e.preventDefault();
        }
    }, { passive: false });

    const endPointerHandler = e => {
        if (e.pointerType !== 'touch') return;
        const pid = `p${e.pointerId}`;
        if (pid === touchControls.moveTouchId) {
            touchControls.moveTouchId = null;
            touchControls.moveRight = 0;
            touchControls.moveForward = 0;
            updateTouchStick();
            e.preventDefault();
            return;
        }
        if (pid === touchControls.lookTouchId) {
            if (currentWeapon === WEAPON_IDX_SNIPER) sniperAiming = !!touchControls.sniperAimHeld;
            touchControls.lookTouchId = null;
            touchControls.lookMoved = false;
            e.preventDefault();
        }
    };

    touchInputTarget.addEventListener('pointerup', endPointerHandler, { passive: false });
    touchInputTarget.addEventListener('pointercancel', endPointerHandler, { passive: false });
}

document.querySelectorAll('.wBtn').forEach((btn, idx) => {
    btn.addEventListener('click', e => {
        e.stopPropagation();
        setWeapon(idx);
    });
});

document.addEventListener("pointerlockchange", () => {
    pointerLocked = document.pointerLockElement === renderer.domElement;
    const hasCapture = hasPrimaryPlayerInputCapture();
    // Don't reveal the lock prompt until the player has chosen a difficulty.
    document.getElementById("lockMsg").style.display =
        (hasCapture || !_gameStarted) ? "none" : "flex";
    if (pauseActionsEl) {
        pauseActionsEl.style.display = (!hasCapture && _hasPlayed && !gameOver) ? 'flex' : 'none';
    }
    if (!gameOver) {
        if (hasCapture) { _hasPlayed = true; setPaused(false); }
        else setPaused(true);
    }
    if (!hasCapture) {
        minigunFiring = false;
        sniperAiming = false;
        sniperHoldBreath = false;
        resetPlayerWaterState();
        waterMouseRipple = 0;
        jumpQueued = false;
        playerYVel = 0;
        playerOnGround = true;
        landingBobTimer = 0;
        camera.position.y = PLAYER_BASE_Y;
        camera.fov = NORMAL_FOV;
        camera.updateProjectionMatrix();
        const scopeEl = document.getElementById('scopeOverlay');
        if (scopeEl) scopeEl.style.display = 'none';
        resetTouchInputs();
        setTouchHudVisible(false);
    }
});

document.addEventListener("mousemove", e => {
    if (!pointerLocked) return;
    const dragPx = Math.hypot(e.movementX, e.movementY);
    if (WATER_SYSTEM_ENABLED) {
        waterMouseRipple = Math.min(1.35, waterMouseRipple + dragPx * 0.0022);
    }
    const sens = getAimSensitivityScale();
    const dx = e.movementX * 0.002 * sens;
    const dy = e.movementY * 0.002 * sens;
    if (activeDrone && !twoPlayerMode) {
        // Mouse X = yaw pan; mouse Y = camera look pitch (separate from movement pitch)
        droneYaw      -= dx * DRONE_MOUSE_YAW;
        droneCamPitch += (invertMouse ? dy : -dy) * DRONE_MOUSE_PITCH;
        droneCamPitch  = Math.max(-1.0, Math.min(0.9, droneCamPitch));
    } else if (!twoPlayerMode) {
        yaw   -= dx;
        pitch += invertMouse ? dy : -dy;
        pitch  = clampAimPitch(pitch);
    } else {
        // 2-player split: left half = P1, right half = P2
        // We use raw client coords from mousemove; approximate with clientX
        // (pointer lock zeros absolute position, so we track last cursor side)
        if (_lastMouseX < window.innerWidth / 2) {
            yaw   -= dx;
            pitch += invertMouse ? dy : -dy;
            pitch  = clampAimPitch(pitch);
        } else {
            p2Yaw   -= dx;
            p2Pitch += invertMouse ? dy : -dy;
            p2Pitch  = clampAimPitch(p2Pitch);
        }
    }
    _lastMouseX = Math.max(0, Math.min(window.innerWidth - 1,
        (_lastMouseX || window.innerWidth / 4) + e.movementX));
});
let _lastMouseX = window.innerWidth / 4;  // start in P1 half

// === 2-Player Mode ===
let p2Yaw = 0, p2Pitch = 0.2;
let p2Score = 0, p2Shots = 0, p2Bricks = 0;

const camera2 = new THREE.PerspectiveCamera(70, 0.5 * window.innerWidth / window.innerHeight, 0.05, 2000);
camera2.rotation.order = "YXZ";
camera2.position.set(4, 2.2, -2);
scene.add(camera2);

const keysP2 = { i: false, j: false, k: false, l: false };

function updateP2UI() {
    document.getElementById('scoreValue2').textContent  = p2Score;
    document.getElementById('bricksHit2').textContent   = p2Bricks;
    document.getElementById('shotsValue2').textContent  = p2Shots;
    for (let i = 0; i < WEAPONS.length; i++) {
        const el = document.getElementById('p2ammo' + i);
        if (el) el.textContent = p2Ammo[i] ?? 0;
    }
}

function removeCannonballEntry(entry) {
    if (!entry) return;
    if (entry._expiryTimer) {
        clearTimeout(entry._expiryTimer);
        entry._expiryTimer = 0;
    }
    if (entry._fuseTimer) {
        clearTimeout(entry._fuseTimer);
        entry._fuseTimer = 0;
    }
    scene.remove(entry.mesh);
    if (entry.body && entry.body.world) entry.body.world.removeBody(entry.body);
    const idx = cannonballs.indexOf(entry);
    if (idx !== -1) cannonballs.splice(idx, 1);
}

function removeCannonballByBody(body) {
    if (!body) return;
    const entry = cannonballs.find(c => c.body === body);
    if (!entry) return;
    removeCannonballEntry(entry);
}

function scheduleCannonballExpiry(entry, ttlMs = (isMobileProfile ? 5500 : 12000)) {
    if (!entry) return;
    entry.expiresAt = performance.now() + ttlMs;
    entry._expiryTimer = setTimeout(() => removeCannonballEntry(entry), ttlMs);
}

function fireCannonballP2(power) {
    if (gameOver || p2Ammo[currentWeapon] <= 0) return;
    markSfxCombatActivity();
    const isShotgun = (currentWeapon === WEAPON_IDX_SHOTGUN);
    const isMinigun = (currentWeapon === WEAPON_IDX_MINIGUN);
    const isSniper = (currentWeapon === WEAPON_IDX_SNIPER);
    const now = performance.now();
    if (isShotgun && now < p2ShotgunNextFire) return;
    if (isShotgun) p2ShotgunNextFire = now + SHOTGUN_RATE;
    if (isSniper && now < p2SniperNextFire) return;
    if (isSniper) p2SniperNextFire = now + SNIPER_RATE;
    const wep = WEAPONS[currentWeapon];
    p2Ammo[currentWeapon]--;
    p2Shots++; updateP2UI(); checkGameOver();

    const fwd = new THREE.Vector3();
    camera2.getWorldDirection(fwd);
    if (wep.arcLoft > 0) { fwd.y += wep.arcLoft; fwd.normalize(); }

    if (isShotgun) {
        playShotgunShot();
        const muzzle = camera2.position.clone().addScaledVector(fwd, 1.35);
        popFlash(muzzle.x, muzzle.y, muzzle.z, 0xffd9aa, 44, 18, 95);
        addShake(0.20);

        const right = new THREE.Vector3().crossVectors(fwd, camera2.up).normalize();
        const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
        const launchSpeed2 = getWeaponLaunchSpeed(currentWeapon, power);

        for (let i = 0; i < SHOTGUN_PELLETS; i++) {
            const barrelSide = (i & 1) ? 1 : -1;
            const yawJitter = (Math.random() - 0.5) * SHOTGUN_SPREAD + barrelSide * SHOTGUN_STAGGER;
            const pitchJitter = (Math.random() - 0.5) * SHOTGUN_SPREAD * 0.7;
            const dir = fwd.clone()
                .addScaledVector(right, yawJitter)
                .addScaledVector(up, pitchJitter)
                .normalize();

            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(0.055, 6, 6),
                new THREE.MeshStandardMaterial({ color: 0xd7d0c2, metalness: 0.82, roughness: 0.24 })
            );
            scene.add(mesh);

            const body = new CANNON.Body({
                mass: 7,
                shape: new CANNON.Sphere(0.055),
                linearDamping: 0.012,
                angularDamping: 0.12,
                allowSleep: true,
                sleepSpeedLimit: 0.9,
                sleepTimeLimit: 0.16
            });
            const start = camera2.position.clone()
                .addScaledVector(dir, 1.25)
                .addScaledVector(right, barrelSide * 0.062)
                .addScaledVector(up, -0.018);
            body.position.set(start.x, start.y, start.z);
            const pelletSpeed = launchSpeed2 * (0.92 + Math.random() * 0.18);
            body.velocity.set(dir.x * pelletSpeed, dir.y * pelletSpeed, dir.z * pelletSpeed);
            world.addBody(body);

            let hit = false;
            body.addEventListener('collide', e => {
                if (hit) return;
                const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
                const hitIsPlank = !!(e.body && e.body._isPlank);
                if (impact < (hitIsPlank ? 7 : 4)) return;
                recordShotDamage(impact);
                hit = true;
                if (e.body && e.body.mass > 0) {
                    const spd = Math.sqrt(body.velocity.x * body.velocity.x + body.velocity.y * body.velocity.y + body.velocity.z * body.velocity.z) || 1;
                    const nudge = hitIsPlank ? 9 : 28;
                    e.body.wakeUp();
                    e.body.applyImpulse(
                        new CANNON.Vec3(
                            (body.velocity.x / spd) * nudge,
                            (body.velocity.y / spd) * nudge * 0.24,
                            (body.velocity.z / spd) * nudge
                        ),
                        new CANNON.Vec3((Math.random() - 0.5) * 0.28, (Math.random() - 0.5) * 0.16, (Math.random() - 0.5) * 0.28)
                    );
                }
                setTimeout(() => removeCannonballByBody(body), 30);
            });

            const shotEntry = { mesh, body, weaponType: currentWeapon, isP2: true };
            cannonballs.push(shotEntry);
            scheduleCannonballExpiry(shotEntry, 900);
        }

        while (cannonballs.length > 32) {
            const old = cannonballs.shift();
            removeCannonballEntry(old);
        }
        return;
    }

    if (isMinigun) playMinigunShot();
    else if (isSniper) playSniperShot();
    else playCannonFire(currentWeapon);

    const _fp = camera2.position.clone().addScaledVector(fwd, 2.0);
    if (isMinigun) popFlash(_fp.x, _fp.y, _fp.z, 0xffffaa, 12, 6, 40);
    else if (isSniper) popFlash(_fp.x, _fp.y, _fp.z, 0xc5e7ff, 32, 16, 70);
    else popFlash(_fp.x, _fp.y, _fp.z, 0xffdd88, 55, 22, 110);

    const ballRadius = isMinigun ? 0.10 : isSniper ? 0.08 : currentWeapon === WEAPON_IDX_MORTAR ? 0.52 : BALL_RADIUS;
    const ballMat    = currentWeapon === WEAPON_IDX_CANNON ? BALL_MAT :
                       new THREE.MeshStandardMaterial({
                           color: WEAPONS[currentWeapon].color,
                           metalness: 0.7, roughness: 0.5,
                           emissive: currentWeapon === WEAPON_IDX_EXPLOSIVE ? 0x441100 : 0x221100,
                           emissiveIntensity: 0.6
                       });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(ballRadius, 16, 16), ballMat);
    mesh.castShadow = true;
    scene.add(mesh);

    const body = new CANNON.Body({
        mass: isMinigun ? 5 : isSniper ? 9 : currentWeapon === WEAPON_IDX_MORTAR ? 280 : 180,
        shape: new CANNON.Sphere(ballRadius),
        linearDamping: isMinigun ? 0.01 : isSniper ? 0.01 : 0.08,
        angularDamping: isMinigun ? 0.18 : isSniper ? 0.14 : 0.6,
        allowSleep: true,
        sleepSpeedLimit: isMinigun ? 0.65 : isSniper ? 0.8 : 0.35,
        sleepTimeLimit: isMinigun ? 0.18 : isSniper ? 0.18 : 0.3
    });
    const start = camera2.position.clone().addScaledVector(fwd, isMinigun ? 1.4 : isSniper ? 1.9 : 2.2);
    body.position.set(start.x, start.y, start.z);
    const launchSpeed2 = getWeaponLaunchSpeed(currentWeapon, power);
    body.velocity.set(fwd.x * launchSpeed2, fwd.y * launchSpeed2, fwd.z * launchSpeed2);
    world.addBody(body);
    if (isSniper) spawnSniperTracer(start, start.clone().addScaledVector(fwd, 95));

    const blastR = wep.blastR;
    let p2BallScored = false;
    if (blastR > 0) {
        let detonated = false;
        body.addEventListener('collide', e => {
            if (detonated) return;
            const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
            if (impact < 3) return;
            recordShotDamage(impact);
            detonated = true;
            const pos = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
            triggerBlast(pos, blastR);
            if (!p2BallScored) { p2BallScored = true; p2Score += 20; updateP2UI(); }
            setTimeout(() => {
                removeCannonballByBody(body);
            }, 80);
        });
    } else {
        let impactFxDone = false;
        let wakeDone = false;
        let lastHit = 0;
        body.addEventListener('collide', e => {
            const now = performance.now();
            if (now - lastHit < 150) return;
            lastHit = now;
            const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
            const impactThreshold = isMobileProfile ? 3.8 : 2;
            if (impact > impactThreshold) {
                recordShotDamage(impact);
                if (!impactFxDone) {
                    spawnExplosion(new THREE.Vector3(body.position.x, body.position.y, body.position.z));
                    playImpact(Math.min(impact / 16, 1), isSniper ? 'sniper' : 'stone');
                    impactFxDone = true;
                }
                if (!wakeDone) {
                    const hitRole = e.body?._storyRole || null;
                    const isBridgeHit = hitRole === 'bridge';
                    // Bridge masonry is long and precarious: keep wakes tiny and
                    // spherical so one shot only disturbs the immediate bay.
                    const R = isBridgeHit
                        ? (isMobileProfile ? 0.72 : 0.82)
                        : (isMobileProfile ? 1.35 : 1.7);
                    const R2 = R * R;
                    const wakeLimit = isBridgeHit ? 8 : 34;
                    let woke = 0;
                    const ix = body.position.x, iy = body.position.y, iz = body.position.z;
                    for (const b of bricks) {
                        if (isBrickInInactiveStoryLevel(b)) continue;
                        if (hitRole && b.storyRole !== hitRole) continue;
                        const dx = b.body.position.x - ix;
                        const dy = b.body.position.y - iy;
                        const dz = b.body.position.z - iz;
                        if (dx * dx + dy * dy + dz * dz > R2) continue;
                        if (b.body.sleepState !== 0) {
                            b.body.wakeUp();
                            woke++;
                            if (woke >= wakeLimit) break;
                        }
                    }
                    wakeDone = true;
                }
            }
        });
    }

    const shotEntry = { mesh, body, weaponType: currentWeapon, isP2: true };
    cannonballs.push(shotEntry);
    scheduleCannonballExpiry(shotEntry);
    if (cannonballs.length > 8) {
        const old = cannonballs.shift();
        removeCannonballEntry(old);
    }
}

const twoPlayerBtn = document.getElementById('twoPlayerBtn');
function setTwoPlayerMode(on) {
    if (touchControls.enabled) on = false;
    twoPlayerMode = on;
    if (touchControls.enabled) {
        if (twoPlayerMode) resetTouchInputs();
        setTouchHudVisible(touchControls.active && !twoPlayerMode);
        renderMobileWeaponRoller();
        updateMobileBallCamButton();
        updateMobileFullscreenButton();
        updateMobileSniperAimButton();
    }
    twoPlayerBtn.textContent = `2-Player Mode: ${twoPlayerMode ? 'ON' : 'OFF'}`;
    document.getElementById('splitLine').style.display  = twoPlayerMode ? 'block' : 'none';
    document.getElementById('scoreboard2').style.display = twoPlayerMode ? 'block' : 'none';
    // Re-size both cameras to half width
    const asp = (twoPlayerMode ? 0.5 : 1) * window.innerWidth / window.innerHeight;
    camera.aspect  = asp;
    camera.updateProjectionMatrix();
    camera2.aspect = asp;
    camera2.updateProjectionMatrix();
    // Copy P1 position to P2 so they start side-by-side
    if (twoPlayerMode) {
        camera2.position.copy(camera.position);
        camera2.position.x += 3;
        p2Yaw   = yaw;
        p2Pitch = pitch;
    }
}
twoPlayerBtn.addEventListener('click', e => {
    e.stopPropagation();
    setTwoPlayerMode(!twoPlayerMode);
});

// P2 keyboard movement (IJKL)
window.addEventListener('keydown', e => {
    if (e.code === 'KeyI') keysP2.i = true;
    if (e.code === 'KeyJ') keysP2.j = true;
    if (e.code === 'KeyK') keysP2.k = true;
    if (e.code === 'KeyL') keysP2.l = true;
    // P2 fire with Enter
    if (e.code === 'Enter' && twoPlayerMode) { e.preventDefault(); p2Fire(); }
});
window.addEventListener('keyup', e => {
    if (e.code === 'KeyI') keysP2.i = false;
    if (e.code === 'KeyJ') keysP2.j = false;
    if (e.code === 'KeyK') keysP2.k = false;
    if (e.code === 'KeyL') keysP2.l = false;
});

// === Lighting ===
const ambientLight = new THREE.AmbientLight(0xd0e8ff, 0.65);
scene.add(ambientLight);

const sun = new THREE.DirectionalLight(0xfff5e0, 2.2);
// Match the visual sun position set in the Sky shader
sun.position.copy(sunDir).multiplyScalar(100);
sun.castShadow = true;
sun.shadow.mapSize.set(isMobileProfile ? 1024 : 2048, isMobileProfile ? 1024 : 2048);
sun.shadow.camera.near   = 5;
sun.shadow.camera.far    = 400;
sun.shadow.camera.left   = -120;
sun.shadow.camera.right  =  120;
sun.shadow.camera.top    =  120;
sun.shadow.camera.bottom = -120;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun);

// === Pooled muzzle / blast flash lights ===
// three.js recompiles EVERY material's shader program whenever the *number* of
// lights in the scene changes. Adding then removing a PointLight per shot made
// the light count oscillate on every trigger pull, so rapid fire (minigun) or
// click-spam while moving caused a shader-recompilation storm that froze the
// game. Instead we keep a small fixed pool of flash lights that stay in the
// scene permanently (so the light count never changes � no recompiles) and only
// animate their intensity. Idle lights sit at intensity 0.
const FLASH_POOL_SIZE = 6;
const _flashPool = [];
for (let i = 0; i < FLASH_POOL_SIZE; i++) {
    const L = new THREE.PointLight(0xffffff, 0, 10);
    scene.add(L);                       // added once, never removed
    _flashPool.push({ light: L, life: 0, maxLife: 1, peak: 0 });
}
let _flashCursor = 0;
function popFlash(x, y, z, color, intensity, distance, durationMs) {
    const f = _flashPool[_flashCursor];
    _flashCursor = (_flashCursor + 1) % FLASH_POOL_SIZE;
    f.light.color.setHex(color);
    f.light.distance = distance;
    f.light.position.set(x, y, z);
    f.light.intensity = intensity;
    f.peak = intensity;
    f.maxLife = f.life = durationMs / 1000;
}
// Called once per frame to fade active flashes back to intensity 0.
function updateFlashes(dt) {
    for (const f of _flashPool) {
        if (f.life <= 0) continue;
        f.life -= dt;
        f.light.intensity = f.life <= 0 ? 0 : f.peak * (f.life / f.maxLife);
    }
}


const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -13.0, 0) });

// --- Broadphase selection + timing instrumentation (one-shot-tank investigation) ---
// PRIMARY HYPOTHESIS: with ~1.6k mostly-sleeping brick bodies, SAPBroadphase
// sweeps EVERY body each step regardless of sleep state. Sorting on Z (axisIndex
// 2) clusters whole wall courses (which run along X at a constant Z) onto the
// sweep axis, so the sweep's overlap inner-loop degrades toward O(n^2). That
// matches the telemetry signature (phys time high while contacts / dynAwake stay
// low, persists after settling, intermittent by how bricks pack on Z).
//
// GridBroadphase buckets bodies into fixed spatial cells, so cost stays ~O(n)
// and is immune to sweep-axis clustering. We keep SAP as the default for
// stability and expose a reversible override with ?bp=grid for A/B testing.
let _perfDbgBroadphaseMs = 0;
function parseBroadphaseMode() {
    try {
        const q = new URLSearchParams(window.location.search);
        const raw = (q.get('bp') || '').trim().toLowerCase();
        if (raw === 'grid' || raw === 'sap') return raw;
    } catch (_) { /* ignore */ }
    return 'sap';
}

// PERF FIX (confirmed root cause of the "one shot tank"): stock cannon-es
// SAPBroadphase.collisionPairs runs needBroadphaseCollision() BEFORE the
// sweep's early-exit break, so sleeping-vs-sleeping pairs `continue` past the
// break and an all-sleeping scene (801 bricks) does a full O(N^2/2) pair scan
// (~560k iterations) EVERY substep. One shot raises frame time -> more
// substeps/frame -> more sweeps -> FPS locks into a lower equilibrium.
//
// v4 sweep (2026-07-05). History matters here:
//   v2 broke early using sortList's aabb.lowerBound keys � but this game moves
//   bodies directly between sorts (CCD pull-back, story parking), AABBs went
//   stale, and cannonballs clipped through walls. v3 dropped ALL breaks
//   (active-vs-all scan) � correct, but O(active x N): one explosive on the
//   castle level wakes hundreds of bricks and tanked mobile to ~6 FPS.
// v4 keeps v3's "only active bodies scan" rule but restores early exits using
// keys that are ALWAYS fresh by construction: position[axis] � boundingRadius,
// recomputed from live positions every call. We insertion-sort the list by
// (pos - r) each call (near-sorted between substeps -> ~O(N)), so sort key and
// break key are the same live value � no staleness hazard, teleports included.
//   - pair needs narrowphase only if >= 1 body is active (cannon's own rule)
//   - active bi scans right, breaking when bj.(pos-r) > bi.(pos+r): sorted by
//     that same key, nothing further right can overlap.
//   - leftward pairs use a prefix running-max of (pos+r): break when the max
//     of everything further left is below bi.(pos-r). Only inactive partners
//     are taken leftward (an active left partner's own rightward scan reaches
//     us before its break � same fresh key ordering guarantees it).
//   - bodies with huge/infinite boundingRadius (ground Planes) would poison
//     the prefix-max, so they're pulled into a tiny side list and tested
//     directly against every active body.
// Final pair filter stays cannon's own position-based intersectionTest, so the
// emitted pair set == NaiveBroadphase reference minus inactive-inactive pairs
// (verified by scripts/test-sap.mjs ground-truth comparison).
// Cost: O(N + active x axis-neighbours) � free asleep, flat during collapses.
function patchSapCollisionPairs(bp) {
    let keyLo = new Float64Array(0);      // pos - r per sorted index
    let prefixMaxHi = new Float64Array(0); // running max of (pos + r)
    const unbounded = [];                  // Planes etc. (radius > 1e9)
    bp.collisionPairs = function (w, p1, p2) {
        const bodies = this.axisList;
        const N = bodies.length;
        this.dirty = false;                // we maintain our own ordering
        const ax = this.axisIndex === 0 ? 'x' : this.axisIndex === 1 ? 'y' : 'z';
        const STATIC = CANNON.Body.STATIC;
        const SLEEPING = CANNON.Body.SLEEPING;

        // Insertion sort by live key (pos - r). Near-sorted across substeps.
        for (let i = 1; i < N; i++) {
            const v = bodies[i];
            const vKey = v.position[ax] - v.boundingRadius;
            let j = i - 1;
            while (j >= 0 && (bodies[j].position[ax] - bodies[j].boundingRadius) > vKey) {
                bodies[j + 1] = bodies[j];
                j--;
            }
            bodies[j + 1] = v;
        }

        if (keyLo.length < N) {
            keyLo = new Float64Array(N);
            prefixMaxHi = new Float64Array(N);
        }
        unbounded.length = 0;
        let runMax = -Infinity;
        for (let i = 0; i < N; i++) {
            const b = bodies[i];
            const r = b.boundingRadius;
            const p = b.position[ax];
            keyLo[i] = p - r;
            if (r > 1e9) unbounded.push(b);   // plane/huge: handle off-sweep
            else if (p + r > runMax) runMax = p + r;
            prefixMaxHi[i] = runMax;
        }

        for (let i = 0; i !== N; i++) {
            const bi = bodies[i];
            if ((bi.type & STATIC) !== 0 || bi.sleepState === SLEEPING) continue; // inactive
            const r = bi.boundingRadius;
            const biLo = keyLo[i];
            const biHi = bi.position[ax] + r;
            // Rightward: everything overlapping on the axis (fresh sorted key).
            for (let j = i + 1; j < N; j++) {
                const bj = bodies[j];
                if (keyLo[j] > biHi) break;
                if (!this.needBroadphaseCollision(bi, bj)) continue;
                this.intersectionTest(bi, bj, p1, p2);
            }
            // Leftward: inactive partners only (active ones pair us rightward).
            for (let j = i - 1; j >= 0; j--) {
                if (prefixMaxHi[j] < biLo) break;
                const bj = bodies[j];
                if (!((bj.type & STATIC) !== 0 || bj.sleepState === SLEEPING)) continue;
                if (bj.boundingRadius > 1e9) continue;  // handled via side list
                if (bj.position[ax] + bj.boundingRadius < biLo) continue;
                if (!this.needBroadphaseCollision(bi, bj)) continue;
                this.intersectionTest(bj, bi, p1, p2);
            }
            // Unbounded bodies (ground planes): direct test, they're very few.
            for (let u = 0; u < unbounded.length; u++) {
                const bu = unbounded[u];
                if (bu === bi) continue;
                if (!this.needBroadphaseCollision(bi, bu)) continue;
                this.intersectionTest(bi, bu, p1, p2);
            }
        }
    };
    return bp;
}

// Wrap collisionPairs so we can attribute broadphase cost separately from the
// solver/narrowphase inside world.step. Zero-cost when perf debug is off.
function instrumentBroadphase(bp) {
    if (!bp || bp.__instrumented) return bp;
    const orig = bp.collisionPairs.bind(bp);
    bp.collisionPairs = function (w, p1, p2) {
        if (!_perfDebugEnabled) return orig(w, p1, p2);
        const t0 = performance.now();
        const r = orig(w, p1, p2);
        _perfDbgBroadphaseMs += performance.now() - t0;
        return r;
    };
    bp.__instrumented = true;
    return bp;
}

function createBroadphase(mode) {
    if (mode === 'grid') {
        // Generous bounds covering the battlefield, moat island and the firing
        // lane the player shoots from. Cells ~5-6 m so 1 m bricks bin cleanly.
        const bp = new CANNON.GridBroadphase(
            new CANNON.Vec3(-60, -2, -60),
            new CANNON.Vec3( 60, 40, 120),
            20, 6, 30
        );
        return instrumentBroadphase(bp);
    }
    const bp = new CANNON.SAPBroadphase(world);
    // Avoid X-axis broadphase ordering bias (left/right wall halves).
    // Sorting on Z makes front-wall contact generation left-right neutral.
    bp.axisIndex = 2;
    patchSapCollisionPairs(bp);
    return instrumentBroadphase(bp);
}

const _broadphaseMode = parseBroadphaseMode();
const sapBroadphase = createBroadphase(_broadphaseMode);
world.broadphase = sapBroadphase;
// AABB staleness fix: updateMassProperties() computes the AABB at construction
// (position 0,0,0) and clears aabbNeedsUpdate, and Body.position.set() does not
// re-flag it — so every body positioned after construction kept its ORIGIN
// AABB forever. Raycasts (ball CCD anti-tunnel) query via AABBs, so they were
// effectively blind away from the origin. Flag every body on add; aabbQuery
// refreshes flagged bodies lazily at query time.
const _origWorldAddBody = world.addBody.bind(world);
world.addBody = (body) => { body.aabbNeedsUpdate = true; _origWorldAddBody(body); };
// Stiff contacts need more solver passes to converge; 20 keeps a 12-high stack
// of heavy blocks rock-steady and � crucially � makes the left and right halves
// of a wall settle identically instead of one side ending up pre-stressed.
world.solver.iterations = 20;
world.solver.tolerance  = 0.001;
world.allowSleep = true;
world.defaultContactMaterial.friction    = 0.45;
world.defaultContactMaterial.restitution = 0.0;

// Brick-to-brick contact: zero bounce, energy-absorbing so hits don?t
// chain far through the structure.
const brickPhysMat = new CANNON.Material('brick');
// TOWER wedges keep this stiff 1e7 contact � they tile with flat shared faces
// (no gap, no built-in penetration) so they stay crisp and topple well. Do NOT
// retune this; the towers are dialled in.
const brickContact = new CANNON.ContactMaterial(brickPhysMat, brickPhysMat, {
    friction:    0.68,
    restitution: 0.0,
    contactEquationStiffness:   1e7,
    contactEquationRelaxation:  3,
    frictionEquationStiffness:  1e7,
    frictionEquationRelaxation: 3,
});
world.addContactMaterial(brickContact);

// WALL bricks get their OWN, gentler contact. Stacked gapped boxes at mass 210
// with a 1e7 contact overwhelmed the GS solver: it ejected bricks into each
// other (the "fall through each other" tunnelling) and the whole course shed at
// once like a card stack. A firmer-but-solvable 1e6 contact with extra grip,
// solved over 20 iterations against lighter (120 kg) blocks, lets a tall wall
// rest as a stable, EQUAL-strength bonded mass � while a cannonball impulse can
// still punch a brick clean out. Separate material so none of this touches the
// tuned towers.
const wallPhysMat = new CANNON.Material('wall');
const wallContact = new CANNON.ContactMaterial(wallPhysMat, wallPhysMat, {
    friction:    0.75,
    restitution: 0.0,
    contactEquationStiffness:   1e6,
    contactEquationRelaxation:  4,
    frictionEquationStiffness:  1e6,
    frictionEquationRelaxation: 4,
});
world.addContactMaterial(wallContact);

// --- Continuous collision detection (anti-tunnel) scratch objects ---
// A fast cannonball can travel further than its own diameter in one 1/60 s
// step and clip straight through a 1 m wall. Each frame we ray-cast the exact
// segment a ball travelled and, if it crossed a solid surface, snap it back to
// that surface so the discrete solver registers the impact next step.
const _ccdFrom    = new CANNON.Vec3();
const _ccdTo      = new CANNON.Vec3();
const _ccdResult  = new CANNON.RaycastResult();
const _ccdRayOpts      = { collisionFilterMask: -1, skipBackfaces: true };
const _droneCcdRayOpts = { collisionFilterMask: -1, skipBackfaces: false }; // hits ground plane back-face too
const MOBILE_SHOT_STABILITY_FIX = (() => {
    try {
        const q = new URLSearchParams(window.location.search);
        return (q.get('shotfix') || '1').trim().toLowerCase() !== '0';
    } catch (_) {
        return true;
    }
})();

// --- Awake-brick velocity / spin caps ---
// No brick � whether launched by a direct kinetic hit, a blast, or the solver
// resolving a build-time overlap at a wall/tower junction � may exceed these.
// Generous enough that direct hits still fling stone convincingly, but low
// enough to stop the runaway speeds that cascade-shatter a whole tower and make
// otherwise-identical towers behave inconsistently.
// Flat walls and general debris use a low cap so a single hit stays a LOCAL
// breach instead of an energetic ripple down the whole length. Wedge-tower
// bricks are keyed into a compression ring and need more room to actually
// eject, so they get their own higher cap. A directly-struck brick gets the
// highest cap briefly (the PUNCH window) so a kinetic round can knock it clear.
const MAX_BRICK_SPEED  = 13;
const MAX_BRICK_SPEED2 = MAX_BRICK_SPEED * MAX_BRICK_SPEED;
const BRIDGE_BRICK_SPEED = 8.5;
const BRIDGE_BRICK_SPEED2 = BRIDGE_BRICK_SPEED * BRIDGE_BRICK_SPEED;
const MAX_BRICK_SPIN   = 6.5;
const MAX_BRICK_SPIN2   = MAX_BRICK_SPIN * MAX_BRICK_SPIN;
const TOWER_BRICK_SPEED  = 24;   // wedge voussoirs need headroom to leave the ring
const TOWER_BRICK_SPEED2 = TOWER_BRICK_SPEED * TOWER_BRICK_SPEED;
const PUNCH_BRICK_SPEED  = 32;
const PUNCH_BRICK_SPEED2 = PUNCH_BRICK_SPEED * PUNCH_BRICK_SPEED;
// Max upward velocity a settled wall brick may have (m/s). Stops tightly-stacked
// blocks being launched skyward by explosive contact resolution � a wall breach
// then tumbles outward/down instead of the whole course erupting upward.
const WALL_MAX_UP = 4.5;

// --- Cannonball speed cap (for the 1/60 physics step) ---
// At a 1/60 s fixed step a ball travels speed/60 metres per step. Walls are one
// brick deep (0.5 m) and the standard ball radius is 0.38 m, so to guarantee the
// discrete solver registers a solid wall contact (rather than tunnelling) the
// per-step travel must stay within ~(radius + half wall) � 0.63 m ? ~38 m/s.
// We clamp launched cannonballs to this so the top of the power slider can't
// push them past the clipping threshold. (The minigun keeps relying on the CCD
// raycast for its small, very fast rounds.)
// 40 m/s tested as the sweet spot � clipping stops at/below this speed.
const MAX_BALL_SPEED  = 40;
const MAX_BALL_SPEED2 = MAX_BALL_SPEED * MAX_BALL_SPEED;

// === Stone Textures (Procedural) ===
function makeStoneColorMap() {
    const W = 256, H = 128;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    // Base limestone/sandstone tone.
    ctx.fillStyle = "#b9ad97";
    ctx.fillRect(0, 0, W, H);

    // Large-scale colour mottling � uneven weathered patches across the face.
    for (let i = 0; i < 70; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const r = 14 + Math.random() * 40;
        const warm = Math.random() < 0.5;
        const dv = (Math.random() * 34) | 0;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const cr = warm ? 150 - dv : 120 - dv;
        const cg = warm ? 138 - dv : 116 - dv;
        const cb = warm ? 116 - dv : 104 - dv;
        g.addColorStop(0, `rgba(${cr},${cg},${cb},0.22)`);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }

    // Fine mineral grain � thousands of tiny speckles.
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let p = 0; p < d.length; p += 4) {
        const n = (Math.random() * 30 - 15) | 0;
        d[p]   = Math.max(0, Math.min(255, d[p]   + n));
        d[p+1] = Math.max(0, Math.min(255, d[p+1] + n));
        d[p+2] = Math.max(0, Math.min(255, d[p+2] + n));
    }
    ctx.putImageData(img, 0, 0);

    // Darker pitting / embedded grit.
    for (let i = 0; i < 260; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const r = Math.random() * 2.2 + 0.4;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(70,60,48,${0.10 + Math.random() * 0.18})`;
        ctx.fill();
    }
    // Lighter eroded flecks.
    for (let i = 0; i < 140; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const r = Math.random() * 1.8 + 0.3;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(225,216,198,${0.10 + Math.random() * 0.16})`;
        ctx.fill();
    }

    // Hairline cracks across the stone face.
    ctx.strokeStyle = "rgba(60,50,40,0.5)";
    for (let i = 0; i < 7; i++) {
        ctx.lineWidth = 0.6 + Math.random() * 0.8;
        let x = 12 + Math.random() * (W - 24);
        let y = 12 + Math.random() * (H - 24);
        ctx.beginPath(); ctx.moveTo(x, y);
        const steps = 3 + (Math.random() * 4 | 0);
        for (let s = 0; s < steps; s++) {
            x += (Math.random() * 30 - 15);
            y += (Math.random() * 22 - 11);
            ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // Recessed mortar joint around the block edge (darker, with a faint
    // highlight lip on the inner top/left so the stone reads as proud).
    ctx.strokeStyle = "rgba(56,48,38,0.85)";
    ctx.lineWidth = 9;
    ctx.strokeRect(4.5, 4.5, W - 9, H - 9);
    ctx.strokeStyle = "rgba(232,224,206,0.30)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(10, 10, W - 20, H - 20);

    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
}

function makeStoneBumpMap() {
    const W = 256, H = 128;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    // Deep mortar joint = dark (low); stone face = mid-grey raised.
    ctx.fillStyle = "#2b2b2b";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#9a9a9a";
    ctx.fillRect(9, 9, W - 18, H - 18);

    // Surface relief: clustered light/dark blobs give an uneven hewn-stone face.
    for (let i = 0; i < 520; i++) {
        const x = 9 + Math.random() * (W - 18);
        const y = 9 + Math.random() * (H - 18);
        const r = Math.random() * 4 + 0.6;
        const v = (70 + Math.random() * 150) | 0;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
        ctx.fill();
    }
    // Cracks as deep dark lines (matching the colour map cracks� feel).
    ctx.strokeStyle = "rgba(20,20,20,0.8)";
    for (let i = 0; i < 7; i++) {
        ctx.lineWidth = 0.8 + Math.random();
        let x = 14 + Math.random() * (W - 28);
        let y = 14 + Math.random() * (H - 28);
        ctx.beginPath(); ctx.moveTo(x, y);
        const steps = 3 + (Math.random() * 4 | 0);
        for (let s = 0; s < steps; s++) {
            x += (Math.random() * 30 - 15);
            y += (Math.random() * 22 - 11);
            ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
}

const stoneColorMap = makeStoneColorMap();
const stoneBumpMap  = makeStoneBumpMap();

// === Procedural Grass Texture ===
function makeGrassTexture() {
    const W = 768, H = 768;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    // Base � mottled green gradient so it isn't a flat slab of colour
    const base = ctx.createLinearGradient(0, 0, W, H);
    base.addColorStop(0,   "#3a5d1c");
    base.addColorStop(0.5, "#456b20");
    base.addColorStop(1,   "#365417");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    // Large soft colour patches (sun-bleached + lush + earthy)
    const patchCols = [
        [92, 120, 48], [70, 102, 36], [120, 132, 60],
        [86, 74, 40],  [54, 84, 28],
    ];
    for (let i = 0; i < 360; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const r = Math.random() * 70 + 20;
        const c = patchCols[(Math.random() * patchCols.length) | 0];
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * (0.5 + Math.random()*0.4), Math.random() * Math.PI, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.18)`;
        ctx.fill();
    }

    // Dirt / worn patches
    for (let i = 0; i < 85; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const r = Math.random() * 26 + 8;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.7, Math.random() * Math.PI, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(96,74,44,${0.10 + Math.random()*0.12})`;
        ctx.fill();
    }

    // Individual grass blades (two-tone for depth)
    for (let i = 0; i < 11000; i++) {
        const x  = Math.random() * W;
        const y  = Math.random() * H;
        const len = Math.random() * 16 + 5;
        const lean = (Math.random() - 0.5) * 5;
        const g   = (90 + Math.random() * 80) | 0;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + lean, y - len);
        ctx.strokeStyle = `rgba(${28 + (Math.random()*30|0)},${g},${14 + (Math.random()*16|0)},0.5)`;
        ctx.lineWidth = Math.random() * 1.1 + 0.3;
        ctx.stroke();
    }

    // Fine speckle for micro-detail
    for (let i = 0; i < 15000; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const v = ((Math.random() * 40) - 20) | 0;
        ctx.fillStyle = `rgba(${24+v},${82+v},${10+v},0.16)`;
        ctx.fillRect(x, y, 1, 1);
    }

    // Broad sunlight variation bands so terrain doesn't read as one flat carpet.
    const sunBands = ctx.createLinearGradient(0, 0, W, H * 0.75);
    sunBands.addColorStop(0.00, 'rgba(255,245,200,0.08)');
    sunBands.addColorStop(0.35, 'rgba(255,255,255,0.00)');
    sunBands.addColorStop(0.70, 'rgba(70,95,45,0.10)');
    sunBands.addColorStop(1.00, 'rgba(35,60,22,0.16)');
    ctx.fillStyle = sunBands;
    ctx.fillRect(0, 0, W, H);

    // Tiny meadow flowers and dry straw flecks break up green repetition.
    const bloomCols = [
        [232, 217, 154], [206, 224, 170], [198, 188, 146], [222, 204, 166],
    ];
    for (let i = 0; i < 760; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const c = bloomCols[(Math.random() * bloomCols.length) | 0];
        const a = 0.12 + Math.random() * 0.16;
        ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a})`;
        ctx.beginPath();
        ctx.arc(x, y, 0.6 + Math.random() * 1.2, 0, Math.PI * 2);
        ctx.fill();
    }
    for (let i = 0; i < 2200; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const len = 1.5 + Math.random() * 4.0;
        ctx.strokeStyle = `rgba(135,122,72,${0.06 + Math.random() * 0.14})`;
        ctx.lineWidth = 0.35 + Math.random() * 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (Math.random() - 0.5) * 2.2, y - len);
        ctx.stroke();
    }

    // Soft trampled shadow lanes add depth and keep the field from looking flat.
    for (let i = 0; i < 34; i++) {
        const y = Math.random() * H;
        const drift = (Math.random() - 0.5) * 26;
        ctx.strokeStyle = `rgba(28,40,20,${0.028 + Math.random() * 0.05})`;
        ctx.lineWidth = 6 + Math.random() * 15;
        ctx.beginPath();
        ctx.moveTo(0, y + drift * 0.2);
        ctx.bezierCurveTo(
            W * 0.22, y + drift,
            W * 0.74, y - drift * 0.8,
            W, y + drift * 0.15
        );
        ctx.stroke();
    }

    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(24, 24);
    t.anisotropy = TEX_ANISO;
    return t;
}

function makeGrassBump() {
    const W = 384, H = 384;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#555";
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 4200; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const v = (120 + Math.random() * 135) | 0;
        ctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
        ctx.fillRect(x, y, 1 + (Math.random() * 2 | 0), 3 + (Math.random() * 8 | 0));
    }
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(28, 28);
    t.anisotropy = Math.max(2, TEX_ANISO >> 1);
    return t;
}

function makeGrassRoughnessMap() {
    const W = 256, H = 256;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#e8e8e8";
    ctx.fillRect(0, 0, W, H);

    // Slightly glossier, trampled tracks.
    for (let i = 0; i < 120; i++) {
        const y = Math.random() * H;
        const w = 1 + Math.random() * 2.4;
        ctx.strokeStyle = `rgba(120,120,120,${0.05 + Math.random() * 0.08})`;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(80, y + (Math.random() - 0.5) * 10, 170, y + (Math.random() - 0.5) * 14, W, y + (Math.random() - 0.5) * 12);
        ctx.stroke();
    }

    // Matte clumps and wet-ish speckles.
    for (let i = 0; i < 5000; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const v = (180 + Math.random() * 70) | 0;
        ctx.fillStyle = `rgba(${v},${v},${v},${0.06 + Math.random() * 0.10})`;
        ctx.fillRect(x, y, 1, 1);
    }

    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(20, 20);
    t.anisotropy = Math.max(2, TEX_ANISO >> 1);
    return t;
}

function makeMudTexture() {
    const W = 384, H = 384;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    const base = ctx.createLinearGradient(0, 0, W, H);
    base.addColorStop(0.00, '#312513');
    base.addColorStop(0.45, '#2a1f10');
    base.addColorStop(1.00, '#1f170d');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    // Silt blotches and darker wet pockets.
    for (let i = 0; i < 420; i++) {
        const x = Math.random() * W;
        const y = Math.random() * H;
        const r = 4 + Math.random() * 18;
        const alpha = 0.08 + Math.random() * 0.14;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * (0.55 + Math.random() * 0.65), Math.random() * Math.PI, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${34 + (Math.random() * 20 | 0)},${24 + (Math.random() * 16 | 0)},${14 + (Math.random() * 10 | 0)},${alpha})`;
        ctx.fill();
    }

    // Pebble-like grit sparkle for subtle detail under water.
    for (let i = 0; i < 7200; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const v = 28 + (Math.random() * 42 | 0);
        ctx.fillStyle = `rgba(${v},${v - 6},${Math.max(0, v - 12)},${0.08 + Math.random() * 0.14})`;
        ctx.fillRect(x, y, 1, 1);
    }

    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(8, 8);
    t.anisotropy = Math.max(2, TEX_ANISO >> 1);
    return t;
}

// === Ground (split into 5 pieces so the moat channel is visible below) ===
// Moat outer rect: x?[M_OX1..M_OX2], z?[M_OZ1..M_OZ2]  (defined just below)
// We can?t reference those consts yet, so use literal coords matching them.
const _MOX1 = -29.0, _MOX2 =  29.0;
const _MOZ1 =  45.0, _MOZ2 = 103.0; // moat outer
const _MIX1 = -22.0, _MIX2 =  22.0;
const _MIZ1 =  54.0, _MIZ2 =  94.0; // island = castle footprint

const grassMat = new THREE.MeshStandardMaterial({
    map:      makeGrassTexture(),
    bumpMap:  makeGrassBump(),
    roughnessMap: makeGrassRoughnessMap(),
    bumpScale: 0.16,
    roughness: 0.94,
    metalness: 0.02,
    color: 0xaac892,
    side: THREE.DoubleSide
});
if (DEV_HIDE_ALL_GRASS) {
    grassMat.visible = false;
}

// Flat green used in Bridge-2 dev mode so z-fighting shows as a clean colour
// shift rather than exploding texture noise, making it easier to diagnose.
const grassFlatMat = new THREE.MeshStandardMaterial({
    color: 0x4a8c2a,
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.DoubleSide,
});

function _applyGroundMaterial(mat) {
    scene.traverse(obj => {
        if (obj.isMesh && (
            obj.name === 'baseGrass' ||
            obj.name === 'bridgeGroundPatch' ||
            obj.name === 'groundSeamUnderlay' ||
            obj.userData?.bridge2GroundPatch
        )) {
            obj.material = mat;
        }
    });
}

// === Procedural snow ground texture ===
function makeSnowTexture() {
    const W = 512, H = 512;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Base: mid blue-grey so bright highlights and dark shadows both read clearly
    ctx.fillStyle = '#c0d0e0';
    ctx.fillRect(0, 0, W, H);

    // Deep compressed-snow hollows
    for (let i = 0; i < 80; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const rx = 35 + Math.random() * 85, ry = 14 + Math.random() * 38;
        const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
        g.addColorStop(0,   'rgba(80,110,150,0.60)');
        g.addColorStop(0.6, 'rgba(100,130,165,0.22)');
        g.addColorStop(1,   'rgba(130,155,185,0)');
        ctx.save(); ctx.translate(x, y); ctx.scale(1, ry / rx);
        ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2);
        ctx.fillStyle = g; ctx.fill(); ctx.restore();
    }

    // Bright drift crests
    for (let i = 0; i < 90; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const rx = 20 + Math.random() * 60, ry = 8 + Math.random() * 22;
        const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
        g.addColorStop(0,   'rgba(255,255,255,0.80)');
        g.addColorStop(0.5, 'rgba(240,248,255,0.30)');
        g.addColorStop(1,   'rgba(255,255,255,0)');
        ctx.save(); ctx.translate(x, y); ctx.scale(1, ry / rx);
        ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2);
        ctx.fillStyle = g; ctx.fill(); ctx.restore();
    }

    // Wind-blown ridges - strong directional lines
    for (let i = 0; i < 70; i++) {
        const x0 = Math.random() * W, y0 = Math.random() * H;
        const len = 50 + Math.random() * 140;
        const angle = (Math.random() - 0.5) * 0.5;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 + Math.cos(angle) * len, y0 + Math.sin(angle) * len);
        const bright = Math.random() < 0.55;
        ctx.strokeStyle = bright
            ? `rgba(255,255,255,${(0.42 + Math.random() * 0.38).toFixed(2)})`
            : `rgba(70,105,145,${(0.28 + Math.random() * 0.28).toFixed(2)})`;
        ctx.lineWidth = 0.8 + Math.random() * 3.0;
        ctx.stroke();
    }

    // Dense speckle - mix of bright whites and cool blue shadows
    for (let i = 0; i < 18000; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const r = Math.random();
        if (r < 0.45) {
            ctx.fillStyle = `rgba(255,255,255,${(0.20 + Math.random() * 0.30).toFixed(2)})`;
        } else if (r < 0.75) {
            ctx.fillStyle = `rgba(80,120,165,${(0.16 + Math.random() * 0.22).toFixed(2)})`;
        } else {
            ctx.fillStyle = `rgba(45,80,125,${(0.12 + Math.random() * 0.18).toFixed(2)})`;
        }
        ctx.fillRect(x, y, 1 + (Math.random() < 0.2 ? 1 : 0), 1);
    }

    // Ice crystal glints
    for (let i = 0; i < 450; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const sz = 1 + Math.random() * 2.5;
        ctx.fillStyle = `rgba(255,255,255,${(0.7 + Math.random() * 0.3).toFixed(2)})`;
        ctx.fillRect(x, y, sz, sz);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(9, 9);
    return tex;
}
const snowGroundMap = makeSnowTexture();
let grassTuftsMesh = null;
let grassTuftCountMax = 0;
let grassOriginalMatrices = null;  // backup for trench-culling
const baseGroundMeshes = [];
const castleSceneMeshes = [];
const castleMoatPhysicsBodies = [];
let castleIslandGroundBody = null;
let bridgeFlankGroundBodyLeft = null;
let bridgeFlankGroundBodyRight = null;
let bridgeCenterExtGroundBodyFront = null;
let bridgeCenterExtGroundBodyBack = null;
// y=0 castle-stage covers over the four bridge-water trench rects (attached
// while the bridge stage is suppressed, detached while it is active).
const castleBridgeBandCoverBodies = [];

// === The King's Bunker (underground heist below the castle courtyard) ===
// A stairwell mouth in the courtyard leads down a steep ramp into a sloped
// tunnel that opens into a grand torch-lit chamber. One big rectangular hole
// in the island colliders; the only opening is the stairwell mouth.
const BUNKER = {
    X1: -14, X2: 14,                        // chamber width (under the great hall)
    OPEN_Z1: 75, Z2: 93,                    // mouth z, far wall z
    OPEN_X1: -1.5, OPEN_X2: 1.5,            // stairwell mouth (3 wide, hall floor)
    OPEN_Z2: 81,                            // stairwell ramp end z
    RAMP1_TOP: 0.0, RAMP1_BOT: -4.0,        // stairwell slope (z 75 -> 81)
    TUNNEL_Z2: 86,                          // tunnel slope end z (-> chamber)
    FLOOR_Y: -6.4,                          // chamber floor
    CEIL_Y: -1.0,
    TRAPDOOR_X: 0, TRAPDOOR_Z: 78,
    HATCH_Z2: 77.4,                         // hatch door covers z OPEN_Z1..here; planks cover the rest
    LADDER_Z: 75.35,                        // ladder flat against the shaft's south wall
    THRONE_X: -11, THRONE_Z: 89.5,
    CEIL_COLLIDER_T: 0.6,
};
const BUNKER_COIN_TOTAL = 10, BUNKER_COIN_SCORE = 50, KING_BONUS_SCORE = 500;
const BUNKER_FLOOD_DELAY_SEC = 20, BUNKER_FLOOD_RISE_SEC = 60, BUNKER_WATER_MAX_Y = -0.8;
const MOAT_DRAIN_SEC = 6, MOAT_DRAINED_Y = -1.55;   // just under the trench floor top (-1.4)
const KING_PUNCH_RANGE = 2.0, KING_PUNCH_COOLDOWN = 2.5;

// Physical floor height along the descent: the stairwell is a VERTICAL shaft
// with a flat landing (ladder-only exit); the tunnel beyond keeps its slope.
function bunkerFloorYAt(pz) {
    if (pz <= BUNKER.OPEN_Z2) return BUNKER.RAMP1_BOT;
    if (pz <= BUNKER.TUNNEL_Z2) {
        const t = (pz - BUNKER.OPEN_Z2) / (BUNKER.TUNNEL_Z2 - BUNKER.OPEN_Z2);
        return THREE.MathUtils.lerp(BUNKER.RAMP1_BOT, BUNKER.FLOOR_Y, t);
    }
    return BUNKER.FLOOR_Y;
}
// Eye height for the player at (px,pz), or null when on the sealed courtyard
// above (the camera is held at courtyard level everywhere except the mouth).
// The closed trapdoor counts as courtyard floor; the ramp starts flush at y=0.
function bunkerEyeYAt(px, pz, camY) {
    if (storyCastleSuppressed) return null;
    if (px < BUNKER.X1 || px > BUNKER.X2 || pz < BUNKER.OPEN_Z1 || pz > BUNKER.Z2) return null;
    const inMouth = px >= BUNKER.OPEN_X1 && px <= BUNKER.OPEN_X2 && pz >= BUNKER.OPEN_Z1 && pz <= BUNKER.OPEN_Z2;
    if (inMouth) {
        // Only the hatch (south end of the mouth) ever opens; the plank deck
        // over the rest is permanent floor, like a shut door.
        const overHatch = pz <= BUNKER.HATCH_Z2;
        const doorShut = trapdoor && trapdoor.state !== 'open' && trapdoor.state !== 'opening';
        if (camY > 1.0 && (!overHatch || doorShut)) return null;
        return bunkerFloorYAt(pz) + PLAYER_BASE_Y;
    }
    if (camY > 1.0) return null;   // sealed courtyard level
    return bunkerFloorYAt(pz) + PLAYER_BASE_Y;
}

// Bunker runtime state. phase 'above' = outside; 'inside' = anywhere below
// courtyard level (derived from camera position); descending/ascending =
// scripted ladder climb (input suspended).
const bunkerState = { phase: 'above', seg: 0, t: 0, from: new THREE.Vector3(), via: new THREE.Vector3(), to: new THREE.Vector3() };
let bunkerEverEntered = false;
let hasKey = false;
let trapdoor = null;              // { pivot, state: 'locked'|'opening'|'open', angle }
let trapdoorBody = null;          // locked-cover collider (removed when opened)
const bunkerColliderBodies = [];  // all static bunker physics, for castle suppression
let king = null;                  // the king NPC entry
let throneGroup = null;
let bunkerWp = null;              // bunker flood water plane record
let bunkerWaterCap = null;        // fancy Three.js Water surface for the flood
let bunkerFlooding = false, castleMoatDraining = false, castleMoatDrained = false;
let bunkerCoinsCollected = 0;
let castleMoatWaterPlane = null, castleMoatWaterCap = null;
let kingSwitchTimer = -1;         // seconds until the king pulls the switch (-1 = idle)
let bunkerHeistWin = false;       // set when the stage-2 win is the coin heist
const bunkerPickups = [];         // { mesh, kind: 'key'|'coin', collected, baseY, phase }
const castleIslandStripBodies = [];  // 3 island strips around the bunker footprint (bridge-managed)
let templateGroundOverrideMesh = null;
let templateGroundOverrideBody = null;
const templateGroundCarvedBodies = [];

function setGrassQualityForDifficulty(diffKey) {
    if (!grassTuftsMesh || grassTuftCountMax <= 0) return;
    if (DEV_HIDE_ALL_GRASS) {
        grassTuftsMesh.visible = false;
        return;
    }
    // Squire prioritizes smoothness; other difficulties keep fuller coverage.
    const mul = diffKey === 'squire'
        ? (isMobileProfile ? 0.58 : 0.68)
        : (isMobileProfile ? 0.82 : 1.0);
    grassTuftsMesh.count = Math.max(220, Math.floor(grassTuftCountMax * mul));
}

function addGround(cx, cz, w, d, levelRole = 'shared') {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), grassMat);
    m.name = 'baseGrass';
    m.userData.levelRole = levelRole;
    m.rotation.x = -Math.PI / 2;
    m.position.set(cx, 0, cz);
    m.receiveShadow = true;
    scene.add(m);
    baseGroundMeshes.push(m);
    if (levelRole === 'castle') castleSceneMeshes.push(m);
}
// 1-4. Ground strips around the moat rect � carved around the WIDER bridge
// water band (x �35.5, z 74�36). The old full strips overlapped the band's
// margins (trench mouth + flanks), drawing walkable-looking grass at y=0 over
// bridge-stage water/carved physics � you'd fall "into grass". The carved
// margin pieces come back as 'castle'-role meshes: visible in castle mode
// (where the ground really is solid), hidden in bridge mode (where the bridge
// stage builds its own shaped shoreline grass).
const _BWZ1 = (_MOZ1 + _MOZ2) / 2 - BRIDGE_WATER_VISUAL_HALF_Z; // 38
const _BWZ2 = (_MOZ1 + _MOZ2) / 2 + BRIDGE_WATER_VISUAL_HALF_Z; // 110
// 1. Front strip (z < moat): shared up to the band edge, split around it.
addGround(0, (_BWZ1 + (-500)) / 2, 1000, _BWZ1 + 500);
addGround((BRIDGE_WATER_MIN_X + (-500)) / 2, (_BWZ1 + _MOZ1) / 2, BRIDGE_WATER_MIN_X + 500, _MOZ1 - _BWZ1);
addGround((BRIDGE_WATER_MAX_X + 500) / 2, (_BWZ1 + _MOZ1) / 2, 500 - BRIDGE_WATER_MAX_X, _MOZ1 - _BWZ1);
addGround(0, (_BWZ1 + _MOZ1) / 2, BRIDGE_WATER_MAX_X - BRIDGE_WATER_MIN_X, _MOZ1 - _BWZ1, 'castle');
// 2. Back strip (z > moat): shared beyond the band, split around it.
addGround(0, (_BWZ2 + 500) / 2, 1000, 500 - _BWZ2);
addGround((BRIDGE_WATER_MIN_X + (-500)) / 2, (_MOZ2 + _BWZ2) / 2, BRIDGE_WATER_MIN_X + 500, _BWZ2 - _MOZ2);
addGround((BRIDGE_WATER_MAX_X + 500) / 2, (_MOZ2 + _BWZ2) / 2, 500 - BRIDGE_WATER_MAX_X, _BWZ2 - _MOZ2);
addGround(0, (_MOZ2 + _BWZ2) / 2, BRIDGE_WATER_MAX_X - BRIDGE_WATER_MIN_X, _BWZ2 - _MOZ2, 'castle');
// 3. Left strip: shared out to the band's x-edge, castle margin inside it.
addGround((BRIDGE_WATER_MIN_X + (-500)) / 2, (_MOZ1 + _MOZ2) / 2, BRIDGE_WATER_MIN_X + 500, _MOZ2 - _MOZ1);
addGround((BRIDGE_WATER_MIN_X + _MOX1) / 2, (_MOZ1 + _MOZ2) / 2, _MOX1 - BRIDGE_WATER_MIN_X, _MOZ2 - _MOZ1, 'castle');
// 4. Right strip: mirror of the left.
addGround((BRIDGE_WATER_MAX_X + 500) / 2, (_MOZ1 + _MOZ2) / 2, 500 - BRIDGE_WATER_MAX_X, _MOZ2 - _MOZ1);
addGround((_MOX2 + BRIDGE_WATER_MAX_X) / 2, (_MOZ1 + _MOZ2) / 2, BRIDGE_WATER_MAX_X - _MOX2, _MOZ2 - _MOZ1, 'castle');
// 5. Castle island (inside moat): four strips around the King's Bunker descent
// (the stairwell/tunnel/chamber cut through the island — no grass cap over it).
addGround((_MIX1 + _MIX2) / 2, (_MIZ1 + BUNKER.OPEN_Z1) / 2, _MIX2 - _MIX1, BUNKER.OPEN_Z1 - _MIZ1, 'castle');
addGround((_MIX1 + _MIX2) / 2, (BUNKER.Z2 + _MIZ2) / 2, _MIX2 - _MIX1, _MIZ2 - BUNKER.Z2, 'castle');
addGround((_MIX1 + BUNKER.X1) / 2, (BUNKER.OPEN_Z1 + BUNKER.Z2) / 2, BUNKER.X1 - _MIX1, BUNKER.Z2 - BUNKER.OPEN_Z1, 'castle');
addGround((BUNKER.X2 + _MIX2) / 2, (BUNKER.OPEN_Z1 + BUNKER.Z2) / 2, _MIX2 - BUNKER.X2, BUNKER.Z2 - BUNKER.OPEN_Z1, 'castle');

// Seam underlays: the strips above abut edge-to-edge without shared vertices,
// so float rounding leaves hairline cracks along the joins � visible as white
// "skybox stripes" at shallow view angles (cursor probe: ShaderMaterial skybox
// hit through the gap). Thin grass planes 1 cm BELOW the seams catch those
// rays so any crack shows grass, never sky. Seams along the moat-margin joins
// only exist in castle mode, so those underlays are castle-role; band-edge
// underlays are safe as shared (always solid ground or under shore fill).
(function addGroundSeamUnderlays() {
    const seam = (cx, cz, w, d, levelRole = 'shared') => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), grassMat);
        m.name = 'groundSeamUnderlay';
        m.userData.levelRole = levelRole;
        m.rotation.x = -Math.PI / 2;
        m.position.set(cx, -0.01, cz);
        m.receiveShadow = true;
        scene.add(m);
        baseGroundMeshes.push(m);
        if (levelRole === 'castle') castleSceneMeshes.push(m);
    };
    const SW = 0.8; // seam cover width
    // Band front/back edges (full width � always solid ground beneath).
    seam(0, _BWZ1, 1000, SW);
    seam(0, _BWZ2, 1000, SW);
    // Moat front/back edges outside the band (shared) and band margins (castle).
    for (const z of [_MOZ1, _MOZ2]) {
        seam((BRIDGE_WATER_MIN_X + (-500)) / 2, z, BRIDGE_WATER_MIN_X + 500, SW);
        seam((BRIDGE_WATER_MAX_X + 500) / 2, z, 500 - BRIDGE_WATER_MAX_X, SW);
        seam((BRIDGE_WATER_MIN_X + _MOX1) / 2, z, _MOX1 - BRIDGE_WATER_MIN_X, SW, 'castle');
        seam((_MOX2 + BRIDGE_WATER_MAX_X) / 2, z, BRIDGE_WATER_MAX_X - _MOX2, SW, 'castle');
    }
    // Band left/right edges (under shore fill in bridge mode, solid in castle).
    seam(BRIDGE_WATER_MIN_X, (_BWZ1 + _BWZ2) / 2, SW, _BWZ2 - _BWZ1);
    seam(BRIDGE_WATER_MAX_X, (_BWZ1 + _BWZ2) / 2, SW, _BWZ2 - _BWZ1);
    // King's Bunker descent edges — only where the island strips actually join
    // (the hole itself stays uncovered or it would cap the stairwell).
    const BKX1 = BUNKER.X1, BKX2 = BUNKER.X2;
    seam((_MIX1 + BKX1) / 2, BUNKER.OPEN_Z1, BKX1 - _MIX1, SW, 'castle');
    seam((BKX2 + _MIX2) / 2, BUNKER.OPEN_Z1, _MIX2 - BKX2, SW, 'castle');
    seam((_MIX1 + BKX1) / 2, BUNKER.Z2, BKX1 - _MIX1, SW, 'castle');
    seam((BKX2 + _MIX2) / 2, BUNKER.Z2, _MIX2 - BKX2, SW, 'castle');
})();

// === Solid physics ground with a carved-out moat trench ===
// Five static slabs (top flush with the grass at y=0) match the visible ground
// pieces, leaving the moat ring open so bricks tumble in and settle at water
// level � just like the NPCs that fall into the moat. A lower trench-floor slab
// catches the debris a touch below the water surface.
(function buildGroundColliders() {
    const T = 30;   // slab thickness (top sits at the given Y)
    function slab(x1, x2, z1, z2, topY, thick = T) {
        const w = x2 - x1, d = z2 - z1;
        if (w <= 0 || d <= 0) return;
        const body = new CANNON.Body({
            mass: 0, material: brickPhysMat,
            shape: new CANNON.Box(new CANNON.Vec3(w / 2, thick / 2, d / 2)),
        });
        body.position.set((x1 + x2) / 2, topY - thick / 2, (z1 + z2) / 2);
        world.addBody(body);
        return body;
    }

    // Keep a carved trench under the expanded bridge-water strip so debris
    // consistently sinks instead of resting on hidden y=0 side-bank slabs.
    const BRIDGE_Z = (_MOZ1 + _MOZ2) * 0.5;
    const BRIDGE_BAND_Z1 = BRIDGE_Z - BRIDGE_WATER_HALF_Z;
    const BRIDGE_BAND_Z2 = BRIDGE_Z + BRIDGE_WATER_HALF_Z;
    const BRIDGE_TRENCH_TOP_Y = -(WATER_DEPTH_M * 2);

    // Split front/back aprons around the bridge-water span so the bridge trench
    // remains open from ramp to ramp (no hidden y=0 "water square" support).
    slab(-500, 500, -500, BRIDGE_BAND_Z1, 0); // far front apron
    slab(-500, BRIDGE_WATER_MIN_X, BRIDGE_BAND_Z1, _MOZ1, 0); // front-left bank
    slab(BRIDGE_WATER_MAX_X, 500, BRIDGE_BAND_Z1, _MOZ1, 0);  // front-right bank
    slab(-500, BRIDGE_WATER_MIN_X, _MOZ2, BRIDGE_BAND_Z2, 0); // back-left bank
    slab(BRIDGE_WATER_MAX_X, 500, _MOZ2, BRIDGE_BAND_Z2, 0);  // back-right bank
    slab(-500, 500, BRIDGE_BAND_Z2, 500, 0); // far back apron
    slab(-500, BRIDGE_WATER_MIN_X, BRIDGE_BAND_Z1, BRIDGE_BAND_Z2, 0); // far left terrain
    slab(BRIDGE_WATER_MAX_X, 500, BRIDGE_BAND_Z1, BRIDGE_BAND_Z2, 0);  // far right terrain

    // Bridge flanks follow the trench depth whenever bridge water is enabled.
    bridgeFlankGroundBodyLeft = slab(BRIDGE_WATER_MIN_X, _MOX1, BRIDGE_BAND_Z1, BRIDGE_BAND_Z2,
        BRIDGE_CHANNEL_WATER_ENABLED ? BRIDGE_TRENCH_TOP_Y : 0); // left bridge flank
    bridgeFlankGroundBodyRight = slab(_MOX2, BRIDGE_WATER_MAX_X, BRIDGE_BAND_Z1, BRIDGE_BAND_Z2,
        BRIDGE_CHANNEL_WATER_ENABLED ? BRIDGE_TRENCH_TOP_Y : 0);  // right bridge flank

    // Central bridge-water extension in front/back moat strips, keeping the
    // trench floor continuous where water gameplay is active.
    bridgeCenterExtGroundBodyFront = slab(BRIDGE_WATER_MIN_X, BRIDGE_WATER_MAX_X, BRIDGE_BAND_Z1, _MOZ1,
        BRIDGE_CHANNEL_WATER_ENABLED ? BRIDGE_TRENCH_TOP_Y : 0);
    bridgeCenterExtGroundBodyBack = slab(BRIDGE_WATER_MIN_X, BRIDGE_WATER_MAX_X, _MOZ2, BRIDGE_BAND_Z2,
        BRIDGE_CHANNEL_WATER_ENABLED ? BRIDGE_TRENCH_TOP_Y : 0);

    // Castle-stage covers: the four sunken bridge-trench rects above sit under
    // flat castle grass (the bridge river only exists visually in the bridge
    // stage), so cap them with solid y=0 ground. Without these, castle mode
    // had an invisible 0.7 m trench in front of/behind the moat and a
    // bottomless band along its left/right flanks (balls sank through grass,
    // debris floated below ground level). buildStoryBridgeEncounter marks them
    // _bridgeAttachWhenSuppressed=true so the bridge stage removes them.
    castleBridgeBandCoverBodies.push(
        slab(BRIDGE_WATER_MIN_X, _MOX1, BRIDGE_BAND_Z1, BRIDGE_BAND_Z2, 0),  // left flank cover
        slab(_MOX2, BRIDGE_WATER_MAX_X, BRIDGE_BAND_Z1, BRIDGE_BAND_Z2, 0), // right flank cover
        slab(BRIDGE_WATER_MIN_X, BRIDGE_WATER_MAX_X, BRIDGE_BAND_Z1, _MOZ1, 0), // front ext cover
        slab(BRIDGE_WATER_MIN_X, BRIDGE_WATER_MAX_X, _MOZ2, BRIDGE_BAND_Z2, 0)  // back ext cover
    );

    // Castle island: four strips leaving the King's Bunker descent open for the
    // full slab depth (the slab is 30 m thick — a shallow hole would put solid
    // collider volume right through the chamber). All four follow the original
    // slab's bridge-stage lifecycle (registered with markStoryBridgeBody below).
    castleIslandGroundBody = slab(_MIX1, _MIX2, _MIZ1, BUNKER.OPEN_Z1, 0);  // front strip
    castleIslandStripBodies.push(
        slab(_MIX1, _MIX2, BUNKER.Z2, _MIZ2, 0),                           // back strip
        slab(_MIX1, BUNKER.X1, BUNKER.OPEN_Z1, BUNKER.Z2, 0),              // left strip
        slab(BUNKER.X2, _MIX2, BUNKER.OPEN_Z1, BUNKER.Z2, 0),              // right strip
    );
    // Moat trench floor (also the earth under the island): strips around the
    // bunker descent, same idea — no hidden slab through the chamber.
    slab(_MOX1, _MOX2, _MOZ1, BUNKER.OPEN_Z1, -(WATER_DEPTH_M * 2));
    slab(_MOX1, _MOX2, BUNKER.Z2, _MOZ2, -(WATER_DEPTH_M * 2));
    slab(_MOX1, BUNKER.X1, BUNKER.OPEN_Z1, BUNKER.Z2, -(WATER_DEPTH_M * 2));
    slab(BUNKER.X2, _MOX2, BUNKER.OPEN_Z1, BUNKER.Z2, -(WATER_DEPTH_M * 2));

    // === King's Bunker static colliders (indestructible stone descent) ===
    // Ceiling covers everything except the stairwell mouth; floors are sloped
    // boxes matching the two ramps, then the flat chamber floor.
    {
        const B = BUNKER, CT = B.CEIL_COLLIDER_T;
        bunkerColliderBodies.push(
            slab(B.X1, B.OPEN_X1, B.OPEN_Z1, B.Z2, 0, CT),             // west of mouth
            slab(B.OPEN_X2, B.X2, B.OPEN_Z1, B.Z2, 0, CT),             // east of mouth
            slab(B.OPEN_X1, B.OPEN_X2, B.OPEN_Z2, B.Z2, 0, CT),        // over tunnel+chamber
        );
        const rampBody = (x1, x2, z1, z2, yAtZ1, yAtZ2) => {
            const w = x2 - x1, run = z2 - z1, rise = yAtZ2 - yAtZ1;
            const len = Math.hypot(run, rise);
            const body = new CANNON.Body({
                mass: 0, material: brickPhysMat,
                shape: new CANNON.Box(new CANNON.Vec3(w / 2, 0.3, len / 2)),
            });
            body.position.set((x1 + x2) / 2, (yAtZ1 + yAtZ2) / 2 - 0.3, (z1 + z2) / 2);
            body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.atan2(rise, run));
            world.addBody(body);
            bunkerColliderBodies.push(body);
        };
        rampBody(B.OPEN_X1, B.OPEN_X2, B.OPEN_Z2, B.TUNNEL_Z2, B.RAMP1_BOT, B.FLOOR_Y);   // tunnel
        bunkerColliderBodies.push(slab(B.OPEN_X1, B.OPEN_X2, B.OPEN_Z1, B.OPEN_Z2, B.RAMP1_BOT));  // shaft landing (flat)
        bunkerColliderBodies.push(slab(B.X1, B.X2, B.TUNNEL_Z2, B.Z2, B.FLOOR_Y));        // chamber floor
        // Walls: chamber sides + far end, from below the floor up to y=0.
        const wallH = 0 - (B.FLOOR_Y - 0.6), wallCY = (B.FLOOR_Y - 0.6) / 2;
        const wallBox = (cx, cz, w, d, h = wallH, cy = wallCY) => {
            const body = new CANNON.Body({
                mass: 0, material: brickPhysMat,
                shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)),
            });
            body.position.set(cx, cy, cz);
            world.addBody(body);
            bunkerColliderBodies.push(body);
        };
        wallBox(B.X1 - 0.15, (B.TUNNEL_Z2 + B.Z2) / 2, 0.3, B.Z2 - B.TUNNEL_Z2);   // west
        wallBox(B.X2 + 0.15, (B.TUNNEL_Z2 + B.Z2) / 2, 0.3, B.Z2 - B.TUNNEL_Z2);   // east
        wallBox((B.X1 + B.X2) / 2, B.Z2 + 0.15, B.X2 - B.X1 + 0.6, 0.3);           // far (north)
        // Tunnel side walls (both ramps) + the chamber's south face beside the
        // tunnel — FULL chamber depth (the tunnel floor reaches FLOOR_Y at the
        // chamber end; shorter walls leave a see-through strip at floor level).
        wallBox(B.OPEN_X1 - 0.15, (B.OPEN_Z1 + B.TUNNEL_Z2) / 2, 0.3, B.TUNNEL_Z2 - B.OPEN_Z1);
        wallBox(B.OPEN_X2 + 0.15, (B.OPEN_Z1 + B.TUNNEL_Z2) / 2, 0.3, B.TUNNEL_Z2 - B.OPEN_Z1);
        wallBox((B.X1 + B.OPEN_X1) / 2, B.TUNNEL_Z2 - 0.15, B.OPEN_X1 - B.X1, 0.3);
        wallBox((B.OPEN_X2 + B.X2) / 2, B.TUNNEL_Z2 - 0.15, B.X2 - B.OPEN_X2, 0.3);
        // Locked hatch cover over the south end of the mouth (removed when opened)
        trapdoorBody = new CANNON.Body({
            mass: 0, material: brickPhysMat,
            shape: new CANNON.Box(new CANNON.Vec3((B.OPEN_X2 - B.OPEN_X1) / 2, 0.15, (B.HATCH_Z2 - B.OPEN_Z1) / 2)),
        });
        trapdoorBody.position.set(B.TRAPDOOR_X, 0.14, (B.OPEN_Z1 + B.HATCH_Z2) / 2);   // top ~y=0.29, flush with the hall floor
        world.addBody(trapdoorBody);
        bunkerColliderBodies.push(trapdoorBody);
        // Permanent plank deck over the rest of the mouth — never removed.
        const plankBody = new CANNON.Body({
            mass: 0, material: brickPhysMat,
            shape: new CANNON.Box(new CANNON.Vec3((B.OPEN_X2 - B.OPEN_X1) / 2, 0.15, (B.OPEN_Z2 - B.HATCH_Z2) / 2)),
        });
        plankBody.position.set(B.TRAPDOOR_X, 0.14, (B.HATCH_Z2 + B.OPEN_Z2) / 2);
        world.addBody(plankBody);
        bunkerColliderBodies.push(plankBody);
    }
})();

// Level 3 template mode uses a single continuous grass ground override so
// moat/bridge trenches cannot show visually or swallow projectiles.
(function buildTemplateGroundOverride() {
    const SIZE = 1000;
    const TOP_Y = 0.032;
    const HALF_H = 0.25;

    const m = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), grassMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, TOP_Y, 0);
    m.receiveShadow = true;
    m.visible = false;
    scene.add(m);
    templateGroundOverrideMesh = m;

    const b = new CANNON.Body({ mass: 0, material: brickPhysMat });
    b.addShape(new CANNON.Box(new CANNON.Vec3(SIZE * 0.5, HALF_H, SIZE * 0.5)));
    b.position.set(0, -HALF_H, 0); // top face at y=0
    templateGroundOverrideBody = b;
})();

function setTemplateGroundOverrideActive(active) {
    const on = !!active;
    if (templateGroundOverrideMesh) templateGroundOverrideMesh.visible = on;
    for (const mesh of baseGroundMeshes) {
        mesh.visible = on
            ? false
            : (mesh.userData.levelRole !== 'castle' || !storyCastleSuppressed);
    }
    rebuildTemplateGroundCarving(on);
}

function rebuildTemplateGroundCarving(forceActive = null) {
    if (!templateGroundOverrideMesh || !templateGroundOverrideBody) return;
    const active = forceActive == null ? templateGroundOverrideMesh.visible : !!forceActive;
    const baseIsAdded = world?.bodies?.includes(templateGroundOverrideBody);
    if (baseIsAdded) world.removeBody(templateGroundOverrideBody);
    while (templateGroundCarvedBodies.length) {
        const body = templateGroundCarvedBodies.pop();
        if (world?.bodies?.includes(body)) world.removeBody(body);
    }

    const cuts = editorTrenchEntries.map(e => ({
        minX: Math.max(-500, e.minX), maxX: Math.min(500, e.maxX),
        minZ: Math.max(-500, e.minZ), maxZ: Math.min(500, e.maxZ),
    })).filter(e => e.maxX > e.minX && e.maxZ > e.minZ);

    if (!cuts.length) {
        const oldGeometry = templateGroundOverrideMesh.geometry;
        templateGroundOverrideMesh.geometry = new THREE.PlaneGeometry(1000, 1000);
        templateGroundOverrideMesh.rotation.set(-Math.PI / 2, 0, 0);
        templateGroundOverrideMesh.position.set(0, 0.032, 0);
        oldGeometry?.dispose();
        if (active) world.addBody(templateGroundOverrideBody);
        return;
    }

    const zEdges = [-500, 500];
    for (const cut of cuts) zEdges.push(cut.minZ, cut.maxZ);
    zEdges.sort((a, b) => a - b);
    const uniqueZ = zEdges.filter((value, index) => index === 0 || Math.abs(value - zEdges[index - 1]) > 0.001);
    const rects = [];
    for (let zi = 0; zi < uniqueZ.length - 1; zi++) {
        const z1 = uniqueZ[zi], z2 = uniqueZ[zi + 1];
        if (z2 - z1 < 0.001) continue;
        const intervals = cuts
            .filter(cut => cut.minZ < z2 - 0.001 && cut.maxZ > z1 + 0.001)
            .map(cut => [cut.minX, cut.maxX])
            .sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const interval of intervals) {
            const tail = merged[merged.length - 1];
            if (tail && interval[0] <= tail[1] + 0.001) tail[1] = Math.max(tail[1], interval[1]);
            else merged.push(interval.slice());
        }
        let x = -500;
        for (const interval of merged) {
            if (interval[0] > x + 0.001) rects.push({ x1: x, x2: interval[0], z1, z2 });
            x = Math.max(x, interval[1]);
        }
        if (x < 500 - 0.001) rects.push({ x1: x, x2: 500, z1, z2 });
    }

    const positions = [], normals = [], uvs = [], indices = [];
    for (const rect of rects) {
        const base = positions.length / 3;
        positions.push(rect.x1, 0.032, rect.z1, rect.x1, 0.032, rect.z2,
            rect.x2, 0.032, rect.z2, rect.x2, 0.032, rect.z1);
        normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
        uvs.push(rect.x1 * 0.02, rect.z1 * 0.02, rect.x1 * 0.02, rect.z2 * 0.02,
            rect.x2 * 0.02, rect.z2 * 0.02, rect.x2 * 0.02, rect.z1 * 0.02);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);

        const width = rect.x2 - rect.x1, depth = rect.z2 - rect.z1;
        const body = new CANNON.Body({ mass: 0, material: brickPhysMat });
        body.addShape(new CANNON.Box(new CANNON.Vec3(width * 0.5, 0.25, depth * 0.5)));
        body.position.set((rect.x1 + rect.x2) * 0.5, -0.25, (rect.z1 + rect.z2) * 0.5);
        templateGroundCarvedBodies.push(body);
        if (active) world.addBody(body);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    const oldGeometry = templateGroundOverrideMesh.geometry;
    templateGroundOverrideMesh.geometry = geometry;
    templateGroundOverrideMesh.rotation.set(0, 0, 0);
    templateGroundOverrideMesh.position.set(0, 0, 0);
    oldGeometry?.dispose();
}

// === Rolling hills on the horizon (scenery only, no physics) ===
// Two concentric rings of low-poly domes encircle the battlefield: a nearer
// green band and a hazy blue-green far band that melts into the fog for depth.
let hillNearMat = null;   // exposed for the seasons system
let hillFarMat = null;
// Ground footprints of the near-ring hills (x, z, r2). The hills are scenery
// with no physics bodies, so NPC walkability treats these circles as solid �
// otherwise fleeing knights sprint straight through the mountains.
const npcHillBlockers = [];
(function addHills() {
    const CZ = 74;  // ring centre (castle sits around z=74)
    const hillNear = new THREE.MeshStandardMaterial({
        color: 0x4d7838, roughness: 1.0, metalness: 0.0, flatShading: true
    });
    const hillFar = new THREE.MeshStandardMaterial({
        color: 0x7d9fb6, roughness: 1.0, metalness: 0.0, flatShading: true
    });
    hillNearMat = hillNear;
    hillFarMat = hillFar;
    // Deterministic pseudo-random so the skyline is stable between reloads.
    let _seed = 1337;
    const rnd = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; };

    function makeHillGeo(cx, cz, radius, height, phase) {
        // Top half of a low-poly sphere, squashed and lumped for a natural ridge.
        const geo = new THREE.SphereGeometry(radius, 9, 6, 0, Math.PI * 2, 0, Math.PI / 2);
        const pos = geo.attributes.position;
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i);
            const n = Math.sin((v.x + phase) * 0.16) * Math.cos((v.z - phase) * 0.19);
            const widen = 1 + n * 0.20;
            v.x *= widen; v.z *= widen;
            v.y = v.y * (height / radius) + n * height * 0.22;
            pos.setXYZ(i, v.x, v.y, v.z);
        }
        geo.translate(cx, -2, cz);   // bake world position so the meshes can merge
        return geo;
    }

    // Build each ring's hills, then merge into a SINGLE mesh per material so the
    // whole horizon is just 2 draw calls instead of 42 (helps draw-call-bound
    // integrated GPUs). Hills don't cast/receive shadows, so they already skip
    // the shadow pass.
    const nearGeos = [], farGeos = [];
    // Near ring � green, partially fogged
    const N1 = 24;
    for (let i = 0; i < N1; i++) {
        const a = (i / N1) * Math.PI * 2 + (rnd() - 0.5) * 0.18;
        const dist = 165 + rnd() * 55;
        const hx = Math.sin(a) * dist, hz = CZ + Math.cos(a) * dist;
        const hr = 38 + rnd() * 48;
        const blockR = hr * 0.94;   // slopes flatten out near the rim � allow the skirt
        npcHillBlockers.push({ x: hx, z: hz, r2: blockR * blockR });
        nearGeos.push(makeHillGeo(hx, hz, hr, 20 + rnd() * 34, i * 13.7));
    }
    // Far ring � hazy, larger, blends into the sky
    const N2 = 18;
    for (let i = 0; i < N2; i++) {
        const a = (i / N2) * Math.PI * 2 + (rnd() - 0.5) * 0.25;
        const dist = 300 + rnd() * 90;
        farGeos.push(makeHillGeo(Math.sin(a) * dist, CZ + Math.cos(a) * dist,
                 60 + rnd() * 75, 36 + rnd() * 52, i * 7.3 + 100));
    }
    scene.add(new THREE.Mesh(mergeGeometries(nearGeos), hillNear));
    scene.add(new THREE.Mesh(mergeGeometries(farGeos),  hillFar));
})();


// Scatters thousands of small crossed-quad blade clumps over the visible play
// area, skipping the moat water and the wooden hut footprint.
(function addGrassTufts() {
    // Alpha texture: a small clump of green blades on a transparent background.
    function makeBladeTex() {
        const S = 64;
        const c = document.createElement('canvas'); c.width = c.height = S;
        const x = c.getContext('2d');
        x.clearRect(0, 0, S, S);
        for (let i = 0; i < 6; i++) {
            const bx  = 8 + Math.random() * (S - 16);
            const w   = 3 + Math.random() * 3;
            const tip = 4 + Math.random() * 10;
            const lean = (Math.random() - 0.5) * 18;
            const g   = (120 + Math.random() * 90) | 0;
            const grad = x.createLinearGradient(0, S, 0, tip);
            grad.addColorStop(0, `rgb(20,${(g*0.5)|0},10)`);
            grad.addColorStop(1, `rgb(60,${g},30)`);
            x.fillStyle = grad;
            x.beginPath();
            x.moveTo(bx - w/2, S);
            x.quadraticCurveTo(bx + lean*0.5, (S+tip)/2, bx + lean, tip);
            x.quadraticCurveTo(bx + lean*0.5, (S+tip)/2, bx + w/2, S);
            x.closePath();
            x.fill();
        }
        return new THREE.CanvasTexture(c);
    }

    // Geometry: three crossed quads, base seated at y=0.
    const TW = 0.9, TH = 1.0;
    const pos = [], uv = [], idx = [];
    let vi = 0;
    for (let q = 0; q < 3; q++) {
        const a = (q / 3) * Math.PI;
        const cxq = Math.cos(a) * TW/2, sz = Math.sin(a) * TW/2;
        pos.push(-cxq, 0, -sz,  cxq, 0, sz,  cxq, TH, sz,  -cxq, TH, -sz);
        uv.push(0,0, 1,0, 1,1, 0,1);
        idx.push(vi, vi+1, vi+2, vi, vi+2, vi+3);
        vi += 4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
        map: makeBladeTex(), alphaTest: 0.45, side: THREE.DoubleSide,
        roughness: 0.95, metalness: 0.0,
    });

    const COUNT = isMobileProfile ? 2200 : 6400;
    const tufts = new THREE.InstancedMesh(geo, mat, COUNT);
    tufts.receiveShadow = !isMobileProfile;
    tufts.castShadow = false;
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    const bridgeWaterCenterZ = (_MOZ1 + _MOZ2) * 0.5;

    const inWater = (x, z) => {
        const inCastleMoat =
            x > _MOX1 && x < _MOX2 && z > _MOZ1 && z < _MOZ2 &&
            !(x > _MIX1 && x < _MIX2 && z > _MIZ1 && z < _MIZ2);
        let inBridgeBand = false;
        if (WATER_SYSTEM_ENABLED && BRIDGE_CHANNEL_WATER_ENABLED && x > BRIDGE_WATER_MIN_X && x < BRIDGE_WATER_MAX_X) {
            const span = Math.max(0.001, BRIDGE_WATER_MAX_X - BRIDGE_WATER_MIN_X);
            const t = THREE.MathUtils.clamp((x - BRIDGE_WATER_MIN_X) / span, 0, 1);
            const leftRampIn = THREE.MathUtils.smoothstep(t, 0.02, 0.18);
            const rightWrap = THREE.MathUtils.smoothstep(t, 0.50, 1.0);
            const mouthFade = leftRampIn * THREE.MathUtils.smoothstep(1 - t, 0.01, 0.08);

            const meander =
                Math.sin(x * 0.052 + 0.8) * 1.55 +
                Math.sin(x * 0.138 + 2.1) * 0.74 +
                Math.sin(x * 0.29 + 0.35) * 0.26;
            const rightBend = rightWrap * 3.4;
            const centerOffset = -(meander + rightBend) * leftRampIn;

            const widthWobble = 1
                + Math.sin(x * 0.17 + 0.45) * 0.095
                + Math.sin(x * 0.41 + 1.0) * 0.045;
            const channelHalf = THREE.MathUtils.lerp(BRIDGE_WATER_HALF_Z * 0.42, BRIDGE_WATER_HALF_Z * 0.48, leftRampIn);
            const valleyWrapBoost = rightWrap * 3.0;
            const unclampedHalf = Math.max(0.8, (channelHalf + valleyWrapBoost) * widthWobble);
            const baseHalfWidth = THREE.MathUtils.clamp(unclampedHalf, 0.8, BRIDGE_WATER_HALF_Z - 1.6);
            const halfWidth = baseHalfWidth * mouthFade;

            if (halfWidth > 0.04) {
                const centerLimit = Math.max(0, BRIDGE_WATER_HALF_Z - halfWidth - 0.8);
                const centerZ = bridgeWaterCenterZ + THREE.MathUtils.clamp(centerOffset, -centerLimit, centerLimit);
                inBridgeBand = Math.abs(z - centerZ) < halfWidth;
            }
        }
        return inCastleMoat || inBridgeBand;
    };
    const nearHut = (x, z) => Math.hypot(x - 60, z - 30) < 11;
    // Don't scatter grass inside the castle � the stone/wood courtyard floor sits
    // just above ground level, so blades poke up through it. (Literal bounds: the
    // castle constants are declared further down, so they're not in scope here �
    // interior is x?[-15,15], z?[54,94] per WALL_XL/WALL_XR and CFZ/CASTLE_BZ.)
    const inCastle = (x, z) => x > -16 && x < 16 && z > 53 && z < 95;

    let n = 0, tries = 0;
    while (n < COUNT && tries < COUNT * 4) {
        tries++;
        const x = -170 + Math.random() * 340;   // x ? [-170, 170]
        const z = -90 + Math.random() * 270;    // z ? [-90, 180]
        if (inWater(x, z) || nearHut(x, z) || inCastle(x, z)) continue;
        const s = (0.55 + Math.random() * 0.9) * 0.6;   // 40% smaller tufts
        dummy.position.set(x, 0, z);
        dummy.rotation.y = Math.random() * Math.PI;
        dummy.scale.set(s, s * (0.8 + Math.random()*0.6), s);
        dummy.updateMatrix();
        tufts.setMatrixAt(n, dummy.matrix);
        const b = 0.70 + Math.random() * 0.48;
        const moss = 0.90 + Math.sin((x * 0.11) + (z * 0.08)) * 0.10;
        col.setRGB((0.34 + 0.14 * b) * moss, (0.50 + 0.22 * b) * moss, (0.26 + 0.12 * b) * moss);
        tufts.setColorAt(n, col);
        n++;
    }
    tufts.count = n;
    grassTuftCountMax = n;
    grassTuftsMesh = tufts;
    tufts.visible = !DEV_HIDE_ALL_GRASS;
    tufts.instanceMatrix.needsUpdate = true;
    if (tufts.instanceColor) tufts.instanceColor.needsUpdate = true;
    scene.add(tufts);
})();

// === Seasons & weather ===
// Each round rolls a random season (never the same twice in a row) and a
// weather state for it. Purely audiovisual: sky/sun/fog/ground/cloud tints,
// optional precipitation particles and storm lightning+thunder. No physics or
// gameplay values are touched, so difficulty/perf tuning is unaffected.
const SEASONS = {
    summer: {
        label: 'Summer',
        grass: 0xaac892, grassMap: true, tuft: 0xffffff, tuftVisible: true,
        hillNear: 0x4d7838, hillFar: 0x7d9fb6,
        fog: 0xa3cce8, fogDensity: 0.0051,
        sunColor: 0xfff5e0, sunIntensity: 2.2, ambient: 0xd0e8ff, ambientIntensity: 0.65,
        skyTurbidity: 3.4, skyRayleigh: 1.55, sunPhi: 78, sunTheta: 200,
        cloud: 0xfafcff, cloudOpacity: 0.92,
        weatherOdds: { clear: 0.62, rain: 0.24, storm: 0.14 },
    },
    spring: {
        label: 'Spring',
        grass: 0x9ed48a, grassMap: true, tuft: 0xd8ffd0, tuftVisible: true,
        hillNear: 0x568440, hillFar: 0x84a8b8,
        fog: 0xb4d6e6, fogDensity: 0.0047,
        sunColor: 0xfff9ec, sunIntensity: 2.1, ambient: 0xd6ecff, ambientIntensity: 0.7,
        skyTurbidity: 2.8, skyRayleigh: 1.2, sunPhi: 76, sunTheta: 195,
        cloud: 0xffffff, cloudOpacity: 0.9,
        weatherOdds: { clear: 0.45, rain: 0.38, storm: 0.17 },
    },
    autumn: {
        label: 'Autumn',
        grass: 0xc0a566, grassMap: true, tuft: 0xe8b866, tuftVisible: true,
        hillNear: 0x8a7440, hillFar: 0x8f9aa8,
        fog: 0xc9bda4, fogDensity: 0.0064,
        sunColor: 0xffdfae, sunIntensity: 1.95, ambient: 0xe8dcc4, ambientIntensity: 0.6,
        skyTurbidity: 5.2, skyRayleigh: 2.4, sunPhi: 71, sunTheta: 210,
        cloud: 0xf2ead8, cloudOpacity: 0.94,
        weatherOdds: { clear: 0.42, rain: 0.38, storm: 0.20 },
    },
    winter: {
        label: 'Winter',
        grass: 0xe8f0f5, grassMap: true, tuft: 0xdfe9f4, tuftVisible: false, // snow buries the blades
        hillNear: 0xd3dde6, hillFar: 0xaebfd0,
        fog: 0xd8e2ec, fogDensity: 0.0072,
        sunColor: 0xeef4ff, sunIntensity: 1.7, ambient: 0xdfe8f4, ambientIntensity: 0.78,
        skyTurbidity: 6.5, skyRayleigh: 0.65, sunPhi: 66, sunTheta: 205,
        cloud: 0xe8edf3, cloudOpacity: 0.96,
        weatherOdds: { clear: 0.5, snow: 0.5 },
    },
};
// Weather overlays multiply/darken the season's base look.
const WEATHER_FX = {
    clear: { sunMul: 1.0, ambMul: 1.0, fogMul: 1.0, cloud: null, cloudOpacity: null, precip: null },
    rain:  { sunMul: 0.66, ambMul: 0.86, fogMul: 1.28, cloud: 0xb6bec8, cloudOpacity: 0.97, precip: 'rain' },
    storm: { sunMul: 0.4, ambMul: 0.72, fogMul: 1.55, cloud: 0x8e97a2, cloudOpacity: 0.98, precip: 'rain', lightning: true },
    snow:  { sunMul: 0.82, ambMul: 1.0, fogMul: 1.25, cloud: 0xdfe5eb, cloudOpacity: 0.97, precip: 'snow' },
};
let currentSeasonKey = 'summer';
let currentWeatherKey = 'clear';
let _lastSeasonKey = null;
const grassBaseMap = grassMat.map;   // restored when leaving winter

function applySeason(seasonKey, weatherKey) {
    const s = SEASONS[seasonKey] || SEASONS.summer;
    const wfx = WEATHER_FX[weatherKey] || WEATHER_FX.clear;
    currentSeasonKey = seasonKey;
    currentWeatherKey = weatherKey;

    // Ground + horizon tints.
    grassMat.color.setHex(s.grass);
    const wantMap = s.grassMap ? (seasonKey === 'winter' ? snowGroundMap : grassBaseMap) : null;
    if (grassMat.map !== wantMap) {
        grassMat.map = wantMap;         // winter: snow texture; other seasons: grass map
        grassMat.needsUpdate = true;    // one recompile per season switch � fine
    }
    if (grassTuftsMesh) {
        grassTuftsMesh.material.color.setHex(s.tuft);
        grassTuftsMesh.visible = !DEV_HIDE_ALL_GRASS && s.tuftVisible;
    }
    if (hillNearMat) hillNearMat.color.setHex(s.hillNear);
    if (hillFarMat) hillFarMat.color.setHex(s.hillFar);

    // Sky, sun, ambient, fog (weather darkening applied on top of the season).
    skyUniforms['turbidity'].value = s.skyTurbidity * (wfx.precip ? 1.6 : 1.0);
    skyUniforms['rayleigh'].value = s.skyRayleigh;
    sunDir.setFromSphericalCoords(1,
        THREE.MathUtils.degToRad(s.sunPhi),
        THREE.MathUtils.degToRad(s.sunTheta));
    skyUniforms['sunPosition'].value.copy(sunDir);
    sun.position.copy(sunDir).multiplyScalar(100);
    sun.color.setHex(s.sunColor);
    sun.intensity = s.sunIntensity * wfx.sunMul;
    ambientLight.color.setHex(s.ambient);
    ambientLight.intensity = s.ambientIntensity * wfx.ambMul;
    scene.fog.color.setHex(s.fog);
    if (wfx.precip) scene.fog.color.multiplyScalar(0.9);
    scene.fog.density = s.fogDensity * wfx.fogMul;

    // Clouds.
    cloudMat.color.setHex(wfx.cloud != null ? wfx.cloud : s.cloud);
    cloudMat.opacity = wfx.cloudOpacity != null ? wfx.cloudOpacity : s.cloudOpacity;

    setPrecipitationMode(wfx.precip || null);
    _lightningNextAt = wfx.lightning
        ? performance.now() + 4000 + Math.random() * 8000
        : Infinity;
    _lightningFlashT = 0;
}

function applyRandomSeason() {
    const keys = Object.keys(SEASONS).filter(k => k !== _lastSeasonKey);
    const seasonKey = keys[(Math.random() * keys.length) | 0];
    _lastSeasonKey = seasonKey;
    const odds = SEASONS[seasonKey].weatherOdds;
    let roll = Math.random();
    let weatherKey = 'clear';
    for (const [k, p] of Object.entries(odds)) {
        roll -= p;
        if (roll <= 0) { weatherKey = k; break; }
    }
    applySeason(seasonKey, weatherKey);
}
// Dev hook: force a season/weather from the console, e.g.
// __season.apply('winter','snow') / __season.apply('summer','storm') / __season.random()
try { window.__season = { apply: applySeason, random: applyRandomSeason, get: () => `${currentSeasonKey}/${currentWeatherKey}` }; } catch (_) {}

// --- Precipitation: one pooled THREE.Points cloud that follows the camera. ---
const PRECIP_COUNT = isMobileProfile ? 480 : 1400;
const PRECIP_HALF = 26;    // local box half-extent around the camera
const PRECIP_TOP = 30;
let precipPoints = null;
let precipMode = null;     // null | 'rain' | 'snow'
function setPrecipitationMode(mode) {
    precipMode = mode;
    if (!mode) {
        if (precipPoints) precipPoints.visible = false;
        return;
    }
    if (!precipPoints) {
        const posArr = new Float32Array(PRECIP_COUNT * 3);
        for (let i = 0; i < PRECIP_COUNT; i++) {
            posArr[i * 3] = (Math.random() * 2 - 1) * PRECIP_HALF;
            posArr[i * 3 + 1] = Math.random() * PRECIP_TOP;
            posArr[i * 3 + 2] = (Math.random() * 2 - 1) * PRECIP_HALF;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
        const mat = new THREE.PointsMaterial({
            color: 0xaec6d8, size: 0.14, transparent: true, opacity: 0.55,
            sizeAttenuation: true, depthWrite: false,
        });
        precipPoints = new THREE.Points(geo, mat);
        precipPoints.frustumCulled = false;
        precipPoints.renderOrder = 5;
        scene.add(precipPoints);
    }
    const m = precipPoints.material;
    if (mode === 'snow') {
        m.color.setHex(0xffffff); m.size = 0.22; m.opacity = 0.85;
    } else {
        m.color.setHex(0xaec6d8); m.size = 0.14; m.opacity = 0.55;
    }
    precipPoints.visible = true;
}

// --- Storm lightning + procedural thunder. ---
let _lightningNextAt = Infinity;
let _lightningFlashT = 0;   // seconds remaining in the current flash
function playThunder(closeness = 0.5) {
    if (!soundEnabled) return;
    const ctx = getAudio();
    const now = ctx.currentTime;
    const dur = 2.2 + Math.random() * 1.4;
    // Filtered noise rumble.
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {           // pinkish noise (integrated white)
        last = last * 0.94 + (Math.random() * 2 - 1) * 0.16;
        data[i] = last;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(240 + closeness * 320, now);
    lp.frequency.exponentialRampToValueAtTime(48, now + dur);
    const g = ctx.createGain();
    const peak = 0.16 + closeness * 0.22;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.05 + (1 - closeness) * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(lp); lp.connect(g); g.connect(ctx.destination);
    src.start(now); src.stop(now + dur + 0.05);
    // Sub-bass body.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(52, now);
    osc.frequency.exponentialRampToValueAtTime(26, now + dur * 0.8);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, now);
    og.gain.exponentialRampToValueAtTime(peak * 0.6, now + 0.08);
    og.gain.exponentialRampToValueAtTime(0.0001, now + dur * 0.8);
    osc.connect(og); og.connect(ctx.destination);
    osc.start(now); osc.stop(now + dur);
}

function updateSeasonWeather(dt) {
    // Precipitation particles follow the camera; individual drops wrap in the
    // local box so the cloud never needs rebuilding.
    if (precipPoints && precipPoints.visible) {
        precipPoints.position.copy(camera.position);
        const arr = precipPoints.geometry.attributes.position.array;
        const t = performance.now() * 0.001;
        if (precipMode === 'snow') {
            for (let i = 0; i < PRECIP_COUNT; i++) {
                let y = arr[i * 3 + 1] - 2.4 * dt;
                if (y < -2) y += PRECIP_TOP + 2;
                arr[i * 3 + 1] = y;
                arr[i * 3] += Math.sin(t * 0.9 + i) * 0.55 * dt;   // lazy sway
            }
        } else {
            for (let i = 0; i < PRECIP_COUNT; i++) {
                let y = arr[i * 3 + 1] - 34 * dt;
                if (y < -2) y += PRECIP_TOP + 2;
                arr[i * 3 + 1] = y;
            }
        }
        precipPoints.geometry.attributes.position.needsUpdate = true;
    }

    // Lightning: brief two-pulse light spike, thunder rolls in later.
    const s = SEASONS[currentSeasonKey] || SEASONS.summer;
    const wfx = WEATHER_FX[currentWeatherKey] || WEATHER_FX.clear;
    if (_lightningFlashT > 0) {
        _lightningFlashT = Math.max(0, _lightningFlashT - dt);
        const k = _lightningFlashT / 0.28;
        const pulse = Math.max(0, Math.sin(k * Math.PI * 2)) * k;   // double flicker
        ambientLight.intensity = s.ambientIntensity * wfx.ambMul + pulse * 1.9;
        sun.intensity = s.sunIntensity * wfx.sunMul + pulse * 1.5;
    }
    if (performance.now() >= _lightningNextAt) {
        _lightningNextAt = performance.now() + 6000 + Math.random() * 14000;
        _lightningFlashT = 0.28;
        const closeness = 0.25 + Math.random() * 0.75;
        setTimeout(() => playThunder(closeness), 350 + (1 - closeness) * 2400);
    }
}

// === Moat (decorative water ring around the castle) ===
// Castle island occupies x ? [-8.5, 7.5], z ? [22.5, 43.5].
// The lowered drawbridge tip lands exactly at z=22.5 (inner island edge).
function makeWaterTexture() {
    const W = 256, H = 256;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const TWO_PI = Math.PI * 2;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const u = x / (W - 1);
            const v = y / (H - 1);
            // Integer-frequency periodic terms keep the texture tile seamless.
            const n1 = Math.sin(TWO_PI * (3 * u + 2 * v) + 0.2);
            const n2 = Math.cos(TWO_PI * (u - 4 * v) + 1.1);
            const n3 = Math.sin(TWO_PI * (5 * u + 3 * v) + 2.3);
            const shape = 0.5 + 0.5 * (n1 * 0.46 + n2 * 0.34 + n3 * 0.20);
            const depth = 0.62 + 0.38 * v;
            const glint = Math.pow(Math.max(0, Math.sin(TWO_PI * (8 * u - 7 * v) + 0.6)), 6) * 0.16;
            const i = (y * W + x) * 4;
            img.data[i + 0] = THREE.MathUtils.clamp(Math.round(44 + shape * 30 + depth * 8 + glint * 46), 0, 255);
            img.data[i + 1] = THREE.MathUtils.clamp(Math.round(66 + shape * 42 + depth * 14 + glint * 62), 0, 255);
            img.data[i + 2] = THREE.MathUtils.clamp(Math.round(38 + shape * 20 + depth * 6 + glint * 28), 0, 255);
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);

    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(5.2, 5.2);
    return t;
}

function makeWaterFoamTexture() {
    const W = 256, H = 256;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const smooth = (a, b, x) => {
        const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
    };
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const u = x / (W - 1);
            const v = y / (H - 1);
            const edge = Math.min(u, v, 1 - u, 1 - v);
            const edgeMask = 1 - smooth(0.03, 0.24, edge);
            const n1 = Math.sin((u * 41.0 + v * 28.0) * Math.PI * 2);
            const n2 = Math.sin((u * 17.0 - v * 36.0 + 0.33) * Math.PI * 2);
            const grain = Math.max(0, 0.5 + 0.5 * (n1 * 0.65 + n2 * 0.35));
            const alpha = Math.max(0, Math.min(1, edgeMask * (0.25 + grain * 0.75)));
            const i = (y * W + x) * 4;
            const c = 192 + Math.floor(grain * 44);
            img.data[i + 0] = c + 10;
            img.data[i + 1] = c + 14;
            img.data[i + 2] = c - 2;
            img.data[i + 3] = Math.floor(alpha * 255);
        }
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(4.5, 4.5);
    return t;
}

function makeWaterReflectionTexture() {
    const W = 384, H = 256;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const TWO_PI = Math.PI * 2;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const u = x / (W - 1);
            const v = y / (H - 1);
            const n1 = Math.sin(TWO_PI * (2 * u + v) + 0.35);
            const n2 = Math.cos(TWO_PI * (u - 3 * v) + 1.9);
            const n3 = Math.sin(TWO_PI * (4 * u + 2 * v) + 2.6);
            const tone = 0.5 + 0.5 * (n1 * 0.42 + n2 * 0.34 + n3 * 0.24);
            const horizon = 1.0 - Math.abs(v - 0.34) * 1.75;
            const haze = THREE.MathUtils.clamp(horizon, 0, 1);
            const i = (y * W + x) * 4;
            img.data[i + 0] = THREE.MathUtils.clamp(Math.round(74 + tone * 36 + haze * 14), 0, 255);
            img.data[i + 1] = THREE.MathUtils.clamp(Math.round(92 + tone * 44 + haze * 18), 0, 255);
            img.data[i + 2] = THREE.MathUtils.clamp(Math.round(62 + tone * 20 + haze * 8), 0, 255);
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);

    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(2.6, 2.2);
    return t;
}

// Procedural tangent-space normal map for the water surface. A height field of
// summed sine waves is differentiated into per-texel normals, giving the moat a
// rippling surface that catches the sun's specular highlight and reflects the
// environment � far more water-like than a flat mirror.
function makeWaterNormalMap() {
    const S = 256;
    const canvas = document.createElement("canvas");
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(S, S);
    const TWO_PI = Math.PI * 2;
    // A few overlapping wave trains at different angles/frequencies.
    const waves = [
        { a: 1.0, fx: 3,  fz: 1,  ph: 0.0 },
        { a: 0.7, fx: 1,  fz: 4,  ph: 1.3 },
        { a: 0.5, fx: 5,  fz: 3,  ph: 2.1 },
        { a: 0.4, fx: 2,  fz: 6,  ph: 0.7 },
    ];
    const height = (u, v) => {
        let h = 0;
        for (const w of waves) h += w.a * Math.sin(TWO_PI * (w.fx * u + w.fz * v) + w.ph);
        return h;
    };
    const STRENGTH = 1.6;
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const u = x / S, v = y / S, e = 1 / S;
            // Central differences ? surface gradient ? normal.
            const dhdx = (height(u + e, v) - height(u - e, v)) / (2 * e);
            const dhdv = (height(u, v + e) - height(u, v - e)) / (2 * e);
            let nx = -dhdx * STRENGTH, nz = -dhdv * STRENGTH, ny = 1.0;
            const len = Math.hypot(nx, ny, nz) || 1;
            nx /= len; ny /= len; nz /= len;
            const i = (y * S + x) * 4;
            img.data[i]     = (nx * 0.5 + 0.5) * 255;
            img.data[i + 1] = (nz * 0.5 + 0.5) * 255;
            img.data[i + 2] = (ny * 0.5 + 0.5) * 255;
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(4, 4);
    return t;
}
// Each water strip uses a dim reflected-image underlay plus animated ripple
// layers for distortion, avoiding expensive live mirror render passes.

// Castle moat bounds (rounded-square ring around the island).
const M_OX1 = -29.0, M_OX2 = 29.0;  // outer X bounds
const M_OZ1 =  45.0, M_OZ2 = 103.0; // outer Z bounds
const M_IX1 = -22.0, M_IX2 =  22.0; // island X bounds
const M_IZ1 =  54.0, M_IZ2 =  94.0; // island Z bounds (flush with castle faces)
const CASTLE_MOAT_OUTER_CORNER_R = 6.2;
const CASTLE_MOAT_INNER_CORNER_R = 4.1;

const MOAT_DEPTH = WATER_DEPTH_M * 2;
const WATER_Y    = -WATER_DEPTH_M;

function isInsideRoundedRectXZ(x, z, x1, x2, z1, z2, cornerRadius, offset = 0) {
    const minX = x1 - offset;
    const maxX = x2 + offset;
    const minZ = z1 - offset;
    const maxZ = z2 + offset;
    if (maxX <= minX || maxZ <= minZ) return false;

    const maxCorner = Math.min((maxX - minX) * 0.5 - 1e-4, (maxZ - minZ) * 0.5 - 1e-4);
    if (maxCorner <= 0) return false;
    const r = THREE.MathUtils.clamp(cornerRadius + offset, 0, maxCorner);

    if (x < minX || x > maxX || z < minZ || z > maxZ) return false;
    const cx = THREE.MathUtils.clamp(x, minX + r, maxX - r);
    const cz = THREE.MathUtils.clamp(z, minZ + r, maxZ - r);
    const dx = x - cx;
    const dz = z - cz;
    return (dx * dx + dz * dz) <= (r * r + 1e-6);
}

function sampleRoundedRectLoop(x1, x2, z1, z2, cornerRadius, segPerCorner = 14) {
    const w = x2 - x1;
    const h = z2 - z1;
    const r = Math.max(0.001, Math.min(cornerRadius, w * 0.5 - 0.001, h * 0.5 - 0.001));
    const seg = Math.max(4, segPerCorner | 0);
    const pts = [new THREE.Vector2(x1 + r, z1), new THREE.Vector2(x2 - r, z1)];

    const pushArc = (cx, cz, a0, a1) => {
        for (let i = 1; i <= seg; i++) {
            const t = i / seg;
            const a = a0 + (a1 - a0) * t;
            pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cz + Math.sin(a) * r));
        }
    };

    pushArc(x2 - r, z1 + r, -Math.PI * 0.5, 0);
    pts.push(new THREE.Vector2(x2, z2 - r));
    pushArc(x2 - r, z2 - r, 0, Math.PI * 0.5);
    pts.push(new THREE.Vector2(x1 + r, z2));
    pushArc(x1 + r, z2 - r, Math.PI * 0.5, Math.PI);
    pts.push(new THREE.Vector2(x1, z1 + r));
    pushArc(x1 + r, z1 + r, Math.PI, Math.PI * 1.5);
    return pts;
}

function makeRoundedRectRingGeometry(outer, inner, segPerCorner = 16) {
    const outerLoop = sampleRoundedRectLoop(
        outer.x1, outer.x2, outer.z1, outer.z2, outer.r,
        segPerCorner
    );
    const innerLoop = sampleRoundedRectLoop(
        inner.x1, inner.x2, inner.z1, inner.z2, inner.r,
        Math.max(8, segPerCorner - 2)
    ).reverse();

    const shape = new THREE.Shape(outerLoop);
    shape.holes.push(new THREE.Path(innerLoop));
    return new THREE.ShapeGeometry(shape, Math.max(20, segPerCorner * 3));
}

function makeRoundedRectGeometry(x1, x2, z1, z2, cornerRadius, segPerCorner = 16) {
    const loop = sampleRoundedRectLoop(x1, x2, z1, z2, cornerRadius, segPerCorner);
    return new THREE.ShapeGeometry(new THREE.Shape(loop), Math.max(20, segPerCorner * 3));
}

function isInCastleMoatRingXZ(x, z, edgeBuffer = 0) {
    const inOuter = isInsideRoundedRectXZ(
        x, z,
        M_OX1, M_OX2,
        M_OZ1, M_OZ2,
        CASTLE_MOAT_OUTER_CORNER_R,
        -edgeBuffer
    );
    const onIsland = isInsideRoundedRectXZ(
        x, z,
        M_IX1, M_IX2,
        M_IZ1, M_IZ2,
        CASTLE_MOAT_INNER_CORNER_R,
        edgeBuffer
    );
    const onBridge = Math.abs(x) < (3.0 + edgeBuffer) && z > (M_OZ1 - edgeBuffer) && z < (M_IZ1 + edgeBuffer);
    return inOuter && !onIsland && !onBridge;
}

function isCastleMoatWaterActive() {
    const castleStageActive = !storyModeEnabled || storyStage === 2 || storyStage === 3;
    return WATER_SYSTEM_ENABLED
    && CASTLE_MOAT_WATER_ENABLED
        && castleStageActive
        && !castleMoatDrained
        && (typeof storyCastleSuppressed === 'undefined' || !storyCastleSuppressed);
}

function isInStoryBridgeWaterBandXZ(x, z, edgeBuffer = 0) {
    const minX = STORY_BRIDGE_WATER_MIN_X + edgeBuffer;
    const maxX = STORY_BRIDGE_WATER_MAX_X - edgeBuffer;
    const halfZ = STORY_BRIDGE_WATER_HALF_Z - edgeBuffer;
    if (minX >= maxX || halfZ <= 0) return false;
    return x > minX && x < maxX && Math.abs(z - STORY_BRIDGE_Z) < halfZ;
}

function isInStoryBridgeWaterShapeXZ(x, z, edgeBuffer = 0) {
    const minX = STORY_BRIDGE_WATER_MIN_X + edgeBuffer;
    const maxX = STORY_BRIDGE_WATER_MAX_X - edgeBuffer;
    if (minX >= maxX || x <= minX || x >= maxX) return false;

    const p = getStoryBridgeWaterProfileAtX(x);
    const halfWidth = p.halfWidth - edgeBuffer;
    if (halfWidth <= 0) return false;
    return Math.abs(z - p.centerZ) < halfWidth;
}

// Returns the ground Y that an NPC's feet should target.
// Inside the moat ring (but not on the island or drawbridge) they fall to water
// level. On the drawbridge they stand on the board's top surface (which rises
// while the bridge is still being lowered), so they walk across rather than
// clipping through it.
function npcGroundY(x, z) {
    const onBridge = Math.abs(x) < 3.0 && z > M_OZ1 && z < M_IZ1;  // 3.0 = DB_W/2
    if (onBridge) {
        // Bridge board pivots at (z = CFZ, y = DB_H/2); a point at distance L
        // along the board has top surface y = DB_H/2 + L�sin? + (DB_H/2)�cos?,
        // with z = CFZ - L�cos?. Solve for L from z, clamp cos? away from 0.
        const c = Math.max(Math.cos(dbAngle), 0.05);
        const L = Math.min(Math.max((CFZ - z) / c, 0), DB_LENGTH);
        const rawY = DB_H / 2 + L * Math.sin(dbAngle) + (DB_H / 2) * Math.cos(dbAngle);
        // Ramp the hinge entry: the castle floor is at y=0 but the bridge top
        // surface is DB_H=0.44m, which exceeds NPC_MAX_STEP_UP and stalls walkers.
        // Blend from 0 (island floor) to the full bridge surface over 1.5m.
        const t = THREE.MathUtils.clamp(L / 1.5, 0, 1);
        return THREE.MathUtils.lerp(0, rawY, t);
    }
    if (isInStoryBridgeTrenchXZ(x, z, 0)) return STORY_BRIDGE_TRENCH_FLOOR_Y;
    const castleStageActive = !storyModeEnabled || storyStage === 2 || storyStage === 3;
    if (castleStageActive && isInCastleMoatRingXZ(x, z, 0)) {
        if (!castleMoatDrained && WATER_SYSTEM_ENABLED && CASTLE_MOAT_WATER_ENABLED) return WATER_Y;
        return -MOAT_DEPTH + 0.15;
    }
    if (!WATER_SYSTEM_ENABLED) return 0;
    const waterSurfaceY = getWaterSurfaceYAtXZ(x, z, false);
    if (waterSurfaceY != null) return waterSurfaceY;
    return 0;
}

function isInMoatWaterXZ(x, z) {
    if (!WATER_SYSTEM_ENABLED) return false;
    const inCastleMoat = isCastleMoatWaterActive() && isInCastleMoatRingXZ(x, z, 0);
    return inCastleMoat || isInStoryBridgeWaterXZ(x, z);
}

function isPlayerInMoatWaterXZ(x, z) {
    if (!WATER_SYSTEM_ENABLED) return false;
    const bCastle = PLAYER_WATER_EDGE_BUFFER_CASTLE;
    const bBridge = PLAYER_WATER_EDGE_BUFFER_BRIDGE;

    // Castle moat with edge buffer to avoid accidental trigger on banks.
    const inCastleWater = isCastleMoatWaterActive() && isInCastleMoatRingXZ(x, z, bCastle);

    // Story bridge water: use shoreline clearance so road/collar regions are
    // excluded and only points meaningfully inside the water volume trigger.
    let inBridgeWater = false;
    if (isStoryBridgeWaterActive()) {
        const bridgeClearance = getWaterRippleShoreClearanceAtXZ(x, z, 'bridge');
        inBridgeWater = bridgeClearance > bBridge;
    }

    return inCastleWater || inBridgeWater;
}

function isStoryBridgeWaterActive() {
    let bridge2Active = false;
    try {
        bridge2Active = !!bridge2ModeActive;
    } catch {}
    if (bridge2Active) return false;
    const bridgeStageActive = storyModeEnabled && storyStage === 1;
    return WATER_SYSTEM_ENABLED
    && devWaterFxEnabled
    && BRIDGE_CHANNEL_WATER_ENABLED
        && bridgeStageActive
        && storyBridgeBuilt
        && !storyBridgeSuppressed;
}

function isInStoryBridgeWaterXZ(x, z) {
    if (!WATER_SYSTEM_ENABLED) return false;
    if (!isStoryBridgeWaterActive()) return false;
    const onRoad = isOnStoryBridgeRoadXZ(x, z, 0);
    const inShape = isInStoryBridgeWaterShapeXZ(x, z, 0);
    return inShape && !onRoad;
}

function getStoryBridgeWaterProfileAtX(x) {
    if (x <= STORY_BRIDGE_WATER_MIN_X || x >= STORY_BRIDGE_WATER_MAX_X) {
        return { centerZ: STORY_BRIDGE_Z, halfWidth: 0 };
    }

    const span = Math.max(0.001, STORY_BRIDGE_WATER_MAX_X - STORY_BRIDGE_WATER_MIN_X);
    const t = THREE.MathUtils.clamp((x - STORY_BRIDGE_WATER_MIN_X) / span, 0, 1);

    // Smoothly open from the left ramp and bend around the right-side hills.
    const leftRampIn = THREE.MathUtils.smoothstep(t, 0.02, 0.18);
    const rightWrap = THREE.MathUtils.smoothstep(t, 0.50, 1.0);
    const mouthFade = leftRampIn * THREE.MathUtils.smoothstep(1 - t, 0.01, 0.08);

    const meander =
        Math.sin(x * 0.052 + 0.8) * 1.55 +
        Math.sin(x * 0.138 + 2.1) * 0.74 +
        Math.sin(x * 0.29 + 0.35) * 0.26;
    const rightBend = rightWrap * 3.4;
    // Flip shoreline orientation toward the hills, leaving the left approach
    // side of the bridge more accessible.
    const centerOffset = -(meander + rightBend) * leftRampIn;

    const widthWobble = 1
        + Math.sin(x * 0.17 + 0.45) * 0.095
        + Math.sin(x * 0.41 + 1.0) * 0.045;
    const channelHalf = THREE.MathUtils.lerp(1.35, STORY_BRIDGE_WATER_HALF_Z * 0.48, leftRampIn);
    const valleyWrapBoost = rightWrap * 3.0;
    const unclampedHalf = Math.max(0.8, (channelHalf + valleyWrapBoost) * widthWobble);
    const baseHalfWidth = THREE.MathUtils.clamp(unclampedHalf, 0.8, STORY_BRIDGE_WATER_HALF_Z - 1.6);
    const halfWidth = baseHalfWidth * mouthFade;
    if (halfWidth <= 0.04) {
        return { centerZ: STORY_BRIDGE_Z, halfWidth: 0 };
    }

    // Keep the shaped shoreline inside the playable flooded band so visuals,
    // colliders, and grass masking stay synchronized.
    const centerLimit = Math.max(0, STORY_BRIDGE_WATER_HALF_Z - halfWidth - 0.8);
    const centerZ = STORY_BRIDGE_Z + THREE.MathUtils.clamp(centerOffset, -centerLimit, centerLimit);
    return { centerZ, halfWidth };
}

function isOnStoryBridgeRoadXZ(x, z, buffer = 0) {
    const minX = STORY_BRIDGE_APPROACH_ROAD_START_X - buffer;
    const maxX = STORY_BRIDGE_APPROACH_X + 0.9 + buffer;
    const halfRoad = STORY_BRIDGE_ROAD_HALF_Z + buffer;
    if (x < minX || x > maxX) return false;
    const centerZ = x <= STORY_BRIDGE_APPROACH_ROAD_END_X
        ? getStoryBridgeRoadCenterZAtX(x)
        : STORY_BRIDGE_Z;
    return Math.abs(z - centerZ) <= halfRoad;
}

function getWaterSurfaceYAtXZ(x, z, includeBridgeRoad = true) {
    if (!WATER_SYSTEM_ENABLED) return null;
    const editorTrenchWaterY = getEditorTrenchWaterYAtXZ(x, z);
    if (editorTrenchWaterY != null) return editorTrenchWaterY;
    const inStoryBridgeWaterVisual = isStoryBridgeWaterActive() && isInStoryBridgeWaterShapeXZ(x, z, 0);
    if (inStoryBridgeWaterVisual && (includeBridgeRoad || !isOnStoryBridgeRoadXZ(x, z, 0))) {
        return STORY_BRIDGE_WATER_Y;
    }

    if (isCastleMoatWaterActive() && isInCastleMoatRingXZ(x, z, 0)) {
        return WATER_Y;
    }
    return null;
}

function getWaterVisualSurfaceYAtXZ(x, z, includeBridgeRoad = true) {
    if (!WATER_SYSTEM_ENABLED) return null;
    const editorTrenchWaterY = getEditorTrenchWaterYAtXZ(x, z);
    if (editorTrenchWaterY != null) {
        return editorTrenchWaterY + (SIMPLE_WATER_SURFACE_Y - WATER_Y);
    }
    const inStoryBridgeWaterVisual = isStoryBridgeWaterActive() && isInStoryBridgeWaterShapeXZ(x, z, 0);
    if (inStoryBridgeWaterVisual && (includeBridgeRoad || !isOnStoryBridgeRoadXZ(x, z, 0))) {
        return SIMPLE_WATER_SURFACE_Y;
    }

    if (isCastleMoatWaterActive() && isInCastleMoatRingXZ(x, z, 0)) {
        return SIMPLE_WATER_SURFACE_Y;
    }
    return null;
}

function getBodyAabbHalfHeight(body, fallback = 0.5) {
    const aabb = body?.aabb;
    if (aabb && Number.isFinite(aabb.lowerBound?.y) && Number.isFinite(aabb.upperBound?.y)) {
        const h = (aabb.upperBound.y - aabb.lowerBound.y) * 0.5;
        if (Number.isFinite(h) && h > 0.01) return h;
    }
    const shape = body?.shapes?.[0];
    if (shape && shape.halfExtents && Number.isFinite(shape.halfExtents.y)) {
        return Math.max(0.1, shape.halfExtents.y);
    }
    return fallback;
}

// Walkability test for living NPCs: keep them out of moat water unless they're
// on the island or the drawbridge corridor. Also treats the scenery mountain
// footprints as solid and fences the arena so fleeing NPCs cannot run through
// hills or off into the fog.
const NPC_ARENA_CENTER_Z = 74;        // hill ring centre (see addHills)
const NPC_ARENA_MAX_R2 = 140 * 140;   // hard fence � nothing playable past this
const NPC_HILL_CHECK_MIN_R2 = 70 * 70; // hills never intrude closer than this
function isNpcWalkableXZ(x, z) {
    if (isInStoryBridgeWaterXZ(x, z)) return false;
    if (isCastleMoatWaterActive() && isInCastleMoatRingXZ(x, z, 0)) return false;
    const cdz = z - NPC_ARENA_CENTER_Z;
    const centerR2 = x * x + cdz * cdz;
    if (centerR2 > NPC_ARENA_MAX_R2) return false;
    if (centerR2 > NPC_HILL_CHECK_MIN_R2) {
        for (const h of npcHillBlockers) {
            const hdx = x - h.x, hdz = z - h.z;
            if (hdx * hdx + hdz * hdz < h.r2) return false;
        }
    }
    return true;
}

const waterRippleTex = null;
const waterTex = null;
const WATER_USE_THREEJS_LIBRARY_WATER = true;
const WATER_USE_LIVE_REFLECTION = false;
const WATER_SCENERY_REFLECTION_STRENGTH = 0.50;
const WATER_SCENERY_REFLECTION_RESOLUTION = isMobileProfile ? 64 : 128;
const WATER_SCENERY_REFLECTION_MIN_FRAME_STRIDE = isMobileProfile ? 20 : 10;
const WATER_SCENERY_REFLECTION_MAX_FRAME_STRIDE = isMobileProfile ? 36 : 18;
const WATER_SCENERY_REFLECTION_PROBE_Y = 2.6;
const WATER_SCENERY_REFLECTION_VIEW_AHEAD = 26;
const WATER_PLANAR_REFLECTION_RESOLUTION_SCALE = isMobileProfile ? 0.55 : 0.75;
const WATER_SURFACE_EFFECTS_ENABLED = false;
const WATER_IMPACT_RIPPLES_ENABLED = true;
const WATER_IMPACT_RIPPLE_Y_OFFSET = 0.055;
const WATER_IMPACT_RING_OUTER_RADIUS_SCALE = 1.1;
const WATER_IMPACT_RIPPLE_SHORE_PADDING_M = 0.12;
const WATER_IMPACT_RIPPLE_MIN_RADIUS_M = 0.38;
const WATER_LIBRARY_WAVE_SPEED = isMobileProfile ? 0.09 : 0.11;
const WATER_LIBRARY_WAVE_SIZE = isMobileProfile ? 2.2 : 2.6;
const waterFoamTex = null;
const waterReflectTex = null;
const mudTex = makeMudTexture();
const WATER_MOTION_RATE = 0.24;
// Keep one gentle normal layer to avoid moire/checker artifacts.
const waterNormalA = WATER_SYSTEM_ENABLED ? makeWaterNormalMap() : null;
const waterNormalB = null;
const waterNormalC = null;
if (waterNormalA) waterNormalA.repeat.set(2.2, 2.2);
const rippleMat = WATER_SYSTEM_ENABLED ? new THREE.MeshStandardMaterial({
    normalMap: waterNormalA,
    normalScale: new THREE.Vector2(0.24, 0.24),
    color: 0x4a3d2c,
    transparent: true, opacity: 0.21,
    roughness: 0.86, metalness: 0.0,
    envMap: scene.environment,
    envMapIntensity: 0.08,
    side: THREE.DoubleSide,
    depthWrite: false,
}) : null;
const rippleMat2 = null;
const rippleMat3 = null;
const waterUnderlayMat = WATER_SYSTEM_ENABLED ? new THREE.MeshStandardMaterial({
    map: mudTex,
    color: waterFxColor,
    transparent: true,
    opacity: waterFxOpacity,
    roughness: MURKY_WATER_ROUGHNESS,
    metalness: MURKY_WATER_REFLECTIVITY,
    envMapIntensity: MURKY_WATER_ENV_INTENSITY,
    side: THREE.DoubleSide,
    depthWrite: false,
}) : null;
const foamMat = null;

const waterSceneryReflectionTarget = (WATER_SYSTEM_ENABLED && WATER_USE_LIVE_REFLECTION)
    ? new THREE.WebGLCubeRenderTarget(WATER_SCENERY_REFLECTION_RESOLUTION, {
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
    })
    : null;
const waterSceneryReflectionProbe = waterSceneryReflectionTarget
    ? new THREE.CubeCamera(0.1, 1800, waterSceneryReflectionTarget)
    : null;
const waterSceneryReflectionMeshes = [];
const waterSceneryReflectionMaterials = [];
const waterSceneryReflectionProbePos = new THREE.Vector3();
let waterSceneryReflectionFrame = 0;
let waterSceneryReflectionFrameStride = WATER_SCENERY_REFLECTION_MIN_FRAME_STRIDE;
let waterSceneryReflectionReady = false;

function registerWaterReflectionMaterial(mat) {
    if (!WATER_USE_LIVE_REFLECTION || !mat) return;
    if (!waterSceneryReflectionMaterials.includes(mat)) {
        waterSceneryReflectionMaterials.push(mat);
    }
    if (!waterSceneryReflectionTarget) return;
    mat.envMap = waterSceneryReflectionTarget.texture;
    mat.envMapIntensity = WATER_SCENERY_REFLECTION_STRENGTH;
    mat.needsUpdate = true;
}

function registerWaterReflectionMesh(mesh) {
    if (!WATER_USE_LIVE_REFLECTION || !mesh) return;
    if (!waterSceneryReflectionMeshes.includes(mesh)) {
        waterSceneryReflectionMeshes.push(mesh);
    }
}

function updateLiveWaterSceneryReflection() {
    if (!WATER_USE_LIVE_REFLECTION || !waterSceneryReflectionProbe || !waterSceneryReflectionTarget) return;
    if (!waterSceneryReflectionMeshes.length || !waterSceneryReflectionMaterials.length) return;

    waterSceneryReflectionFrame++;
    if (waterSceneryReflectionReady && (waterSceneryReflectionFrame % waterSceneryReflectionFrameStride) !== 0) {
        return;
    }

    const visibleWaterMeshes = [];
    for (const mesh of waterSceneryReflectionMeshes) {
        if (mesh && mesh.visible) visibleWaterMeshes.push(mesh);
    }
    if (!visibleWaterMeshes.length) return;

    let probeX = camera.position.x;
    let probeZ = camera.position.z;
    if (twoPlayerMode && camera2) {
        probeX = (camera.position.x + camera2.position.x) * 0.5;
        probeZ = (camera.position.z + camera2.position.z) * 0.5;
    }

    // Keep capture centered near the player viewpoint to avoid the "zoomed-in"
    // look from a distant fixed probe while still biasing toward active water.
    if (storyModeEnabled && storyStage === 1) {
        const centerX = 0;
        const centerZ = STORY_BRIDGE_Z;
        const lookDir = new THREE.Vector3();
        camera.getWorldDirection(lookDir);
        lookDir.y = 0;
        if (lookDir.lengthSq() < 0.0001) {
            lookDir.set(1, 0, 0);
        } else {
            lookDir.normalize();
        }

        // Probe toward where the player is aiming so bridge/soldiers dominate
        // the capture instead of only distant scenery.
        const lookX = camera.position.x + lookDir.x * WATER_SCENERY_REFLECTION_VIEW_AHEAD;
        const lookZ = camera.position.z + lookDir.z * WATER_SCENERY_REFLECTION_VIEW_AHEAD;
        probeX = THREE.MathUtils.lerp(centerX, lookX, 0.64);
        probeZ = THREE.MathUtils.lerp(centerZ, lookZ, 0.64);
        probeX = THREE.MathUtils.clamp(probeX, STORY_BRIDGE_WATER_MIN_X + 4.0, STORY_BRIDGE_WATER_MAX_X - 4.0);
        probeZ = THREE.MathUtils.clamp(probeZ, STORY_BRIDGE_Z - STORY_BRIDGE_WATER_VISUAL_HALF_Z + 2.0, STORY_BRIDGE_Z + STORY_BRIDGE_WATER_VISUAL_HALF_Z - 2.0);
    } else if (!storyModeEnabled || storyStage === 2 || storyStage === 3) {
        const moatCenterZ = (M_OZ1 + M_OZ2) * 0.5;
        probeX = THREE.MathUtils.lerp(0, probeX, 0.72);
        probeZ = THREE.MathUtils.lerp(moatCenterZ, probeZ, 0.72);
    }
    probeX = THREE.MathUtils.clamp(probeX, BRIDGE_WATER_MIN_X - 14, BRIDGE_WATER_MAX_X + 14);
    probeZ = THREE.MathUtils.clamp(probeZ, M_OZ1 - 24, STORY_BRIDGE_Z + STORY_BRIDGE_WATER_VISUAL_HALF_Z + 24);
    const targetProbeX = probeX;
    const targetProbeZ = probeZ;
    if (!waterSceneryReflectionReady) {
        waterSceneryReflectionProbePos.set(targetProbeX, WATER_SCENERY_REFLECTION_PROBE_Y, targetProbeZ);
    } else {
        waterSceneryReflectionProbePos.x = THREE.MathUtils.lerp(waterSceneryReflectionProbePos.x, targetProbeX, 0.35);
        waterSceneryReflectionProbePos.z = THREE.MathUtils.lerp(waterSceneryReflectionProbePos.z, targetProbeZ, 0.35);
        waterSceneryReflectionProbePos.y = WATER_SCENERY_REFLECTION_PROBE_Y;
    }
    waterSceneryReflectionProbe.position.copy(waterSceneryReflectionProbePos);

    for (const mesh of visibleWaterMeshes) mesh.visible = false;
    waterSceneryReflectionProbe.update(renderer, scene);
    for (const mesh of visibleWaterMeshes) mesh.visible = true;

    waterSceneryReflectionReady = true;
}

registerWaterReflectionMaterial(waterUnderlayMat);

function makeWaterSurfaceGeometry(w, d) {
    const step = isMobileProfile ? 3.8 : 2.1;
    const segX = Math.min(80, Math.max(12, Math.round(w / step)));
    const segZ = Math.min(44, Math.max(8, Math.round(d / step)));
    return new THREE.PlaneGeometry(w, d, segX, segZ);
}

function bindAnimatedWaterSurface(mesh) {
    const pos = mesh?.geometry?.attributes?.position;
    if (!pos) return;
    mesh.userData.waterBase = new Float32Array(pos.array);
}

function createWaterUnderlayMesh(geometry, levelRole = 'castle') {
    if (!WATER_SYSTEM_ENABLED) return null;
    const underlay = new THREE.Mesh(geometry.clone(), waterUnderlayMat);
    registerWaterReflectionMesh(underlay);
    return underlay;
}

function animateWaterSurfaceMesh(mesh, timeSec, waveAmp, waveSpeed, phase) {
    const pos = mesh?.geometry?.attributes?.position;
    const base = mesh?.userData?.waterBase;
    if (!pos || !base || base.length !== pos.array.length) return;
    const arr = pos.array;
    const t = timeSec * waveSpeed;
    for (let i = 0; i < arr.length; i += 3) {
        const x = base[i];
        const y = base[i + 1];
        const w1 = Math.sin((x * 0.11 + y * 0.07) + t + phase);
        const w2 = Math.sin((x * 0.23 - y * 0.15) - t * 1.37 + phase * 1.8);
        const w3 = Math.sin((x * 0.041 + y * 0.061) + t * 0.53 + phase * 0.6);
        arr[i + 2] = base[i + 2] + (w1 * 0.58 + w2 * 0.30 + w3 * 0.12) * waveAmp;
    }
    pos.needsUpdate = true;
}

const moatReflector = null;
const bridgeLibraryWaterSurfaces = [];

// Ripple overlay sheets stay as lightweight transparent planes (no extra
// render pass) so the animated surface detail remains cheap.
const levelWaterPlanes = [];
const waterImpactRipples = [];
const storyWaterCapMaterials = [];
const storyWaterCapMeshes = [];
const editorTrenchEntries = [];
let editorTrenchWaterSurface = null;
let editorTrenchBoundaryMesh = null;
let editorTrenchBoundaryMaterial = null;
let waterImpactRippleCursor = 0;

function createEditorTrench(x, z, length = 0.5, width = 0.5, _depth = 0.7, withWater = false) {
    const L = Math.max(0.5, Math.min(3.0, Math.abs(length) || 0.5));
    const W = Math.max(0.5, Math.min(3.0, Math.abs(width) || 0.5));
    const D = 0.7;
    const waterY = withWater ? -D * 0.58 : null;

    const g = new THREE.Group();
    g.position.set(x, 0, z);

    const floorMat = new THREE.MeshStandardMaterial({
        map: makeMudTexture(), bumpMap: stoneBumpMap, bumpScale: 0.012,
        color: 0x503921, roughness: 1.0, metalness: 0.0,
    });

    // ── Pit floor ──────────────────────────────────────────────────────────
    const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(L, W), floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -D + 0.01;
    floorMesh.receiveShadow = true;
    g.add(floorMesh);

    // ── Water (optional) — near-surface so the moat is visible from above ──
    // ── Physics floor ──────────────────────────────────────────────────────
    const floorBody = new CANNON.Body({ mass: 0, material: brickPhysMat });
    floorBody.addShape(new CANNON.Box(new CANNON.Vec3(L * 0.5 + 0.1, 0.15, W * 0.5 + 0.1)));
    floorBody.position.set(x, -D - 0.15, z);
    world.addBody(floorBody);

    scene.add(g);
    const entry = {
        group: g,
        floorBody,
        x, z,
        length: L,
        width: W,
        depth: D,
        waterY,
        waterPlane: null,
        minX: x - L * 0.5,
        maxX: x + L * 0.5,
        minZ: z - W * 0.5,
        maxZ: z + W * 0.5,
    };
    editorTrenchEntries.push(entry);
    updateEditorTrenchWalls();
    rebuildEditorTrenchWaterSurface();
    rebuildTemplateGroundCarving();
    updateGrassTrenchCull();
    return entry;
}

function buildEditorTrenchWaterGeometry(entries) {
    const zEdges = [];
    for (const entry of entries) zEdges.push(entry.minZ, entry.maxZ);
    zEdges.sort((a, b) => a - b);
    const uniqueZ = zEdges.filter((value, index) => index === 0 || Math.abs(value - zEdges[index - 1]) > 0.001);
    const positions = [], indices = [];
    for (let zi = 0; zi < uniqueZ.length - 1; zi++) {
        const z1 = uniqueZ[zi], z2 = uniqueZ[zi + 1];
        const intervals = entries
            .filter(entry => entry.minZ < z2 - 0.001 && entry.maxZ > z1 + 0.001)
            .map(entry => [entry.minX, entry.maxX])
            .sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const interval of intervals) {
            const tail = merged[merged.length - 1];
            if (tail && interval[0] <= tail[1] + 0.001) tail[1] = Math.max(tail[1], interval[1]);
            else merged.push(interval.slice());
        }
        for (const [x1, x2] of merged) {
            const base = positions.length / 3;
            positions.push(x1, -z1, 0, x2, -z1, 0, x2, -z2, 0, x1, -z2, 0);
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    const spanX = Math.max(0.001, bounds.max.x - bounds.min.x);
    const spanY = Math.max(0.001, bounds.max.y - bounds.min.y);
    const uvs = new Float32Array((positions.length / 3) * 2);
    for (let i = 0; i < positions.length / 3; i++) {
        uvs[i * 2] = (positions[i * 3] - bounds.min.x) / spanX;
        uvs[i * 2 + 1] = (positions[i * 3 + 1] - bounds.min.y) / spanY;
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    return geometry;
}

function rebuildEditorTrenchWaterSurface() {
    const wetEntries = editorTrenchEntries.filter(entry => entry.waterY != null);
    if (!wetEntries.length) {
        if (editorTrenchWaterSurface) editorTrenchWaterSurface.visible = false;
        return;
    }
    const geometry = buildEditorTrenchWaterGeometry(wetEntries);
    if (!editorTrenchWaterSurface) {
        const bucket = [];
        editorTrenchWaterSurface = addStoryBridgeVisualWaterCap(
            geometry, -0.7 * 0.58, 0, 0, bucket, 'editor', false
        );
        geometry.dispose();
    } else {
        const oldGeometry = editorTrenchWaterSurface.geometry;
        editorTrenchWaterSurface.geometry = geometry;
        oldGeometry?.dispose();
        editorTrenchWaterSurface.visible = devWaterFxEnabled;
    }
}

function setEditorTrenchWater(entry, enabled) {
    if (!entry || !editorTrenchEntries.includes(entry)) return;
    entry.waterY = enabled ? -0.7 * 0.58 : null;
    rebuildEditorTrenchWaterSurface();
}

function setAllEditorTrenchWater(enabled) {
    const waterY = enabled ? -0.7 * 0.58 : null;
    for (const entry of editorTrenchEntries) entry.waterY = waterY;
    rebuildEditorTrenchWaterSurface();
}

function updateEditorTrenchWalls() {
    if (!editorTrenchEntries.length) {
        if (editorTrenchBoundaryMesh) editorTrenchBoundaryMesh.visible = false;
        return;
    }

    const uniqueSorted = values => values.sort((a, b) => a - b)
        .filter((value, index, array) => index === 0 || Math.abs(value - array[index - 1]) > 0.001);
    const xEdges = uniqueSorted(editorTrenchEntries.flatMap(entry => [entry.minX, entry.maxX]));
    const zEdges = uniqueSorted(editorTrenchEntries.flatMap(entry => [entry.minZ, entry.maxZ]));
    const occupied = new Set();
    for (let xi = 0; xi < xEdges.length - 1; xi++) {
        const x = (xEdges[xi] + xEdges[xi + 1]) * 0.5;
        for (let zi = 0; zi < zEdges.length - 1; zi++) {
            const z = (zEdges[zi] + zEdges[zi + 1]) * 0.5;
            if (editorTrenchEntries.some(entry => x > entry.minX && x < entry.maxX
                && z > entry.minZ && z < entry.maxZ)) occupied.add(`${xi}:${zi}`);
        }
    }

    const positions = [], uvs = [], indices = [];
    const addWallQuad = (a, b, c, d, span) => {
        const base = positions.length / 3;
        positions.push(...a, ...b, ...c, ...d);
        uvs.push(0, 0, span, 0, span, 0.7, 0, 0.7);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const top = 0.035, bottom = -0.71;
    for (let xi = 0; xi < xEdges.length - 1; xi++) {
        const x1 = xEdges[xi], x2 = xEdges[xi + 1];
        for (let zi = 0; zi < zEdges.length - 1; zi++) {
            if (!occupied.has(`${xi}:${zi}`)) continue;
            const z1 = zEdges[zi], z2 = zEdges[zi + 1];
            if (!occupied.has(`${xi - 1}:${zi}`))
                addWallQuad([x1, top, z1], [x1, top, z2], [x1, bottom, z2], [x1, bottom, z1], z2 - z1);
            if (!occupied.has(`${xi + 1}:${zi}`))
                addWallQuad([x2, top, z2], [x2, top, z1], [x2, bottom, z1], [x2, bottom, z2], z2 - z1);
            if (!occupied.has(`${xi}:${zi - 1}`))
                addWallQuad([x2, top, z1], [x1, top, z1], [x1, bottom, z1], [x2, bottom, z1], x2 - x1);
            if (!occupied.has(`${xi}:${zi + 1}`))
                addWallQuad([x1, top, z2], [x2, top, z2], [x2, bottom, z2], [x1, bottom, z2], x2 - x1);
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    if (!editorTrenchBoundaryMesh) {
        editorTrenchBoundaryMaterial = new THREE.MeshStandardMaterial({
            map: makeMudTexture(), bumpMap: stoneBumpMap, bumpScale: 0.02,
            color: 0x684c2f, roughness: 0.98, metalness: 0.0,
            side: THREE.DoubleSide,
        });
        editorTrenchBoundaryMesh = new THREE.Mesh(geometry, editorTrenchBoundaryMaterial);
        editorTrenchBoundaryMesh.name = 'editorTrenchBoundary';
        editorTrenchBoundaryMesh.castShadow = true;
        editorTrenchBoundaryMesh.receiveShadow = true;
        scene.add(editorTrenchBoundaryMesh);
    } else {
        const oldGeometry = editorTrenchBoundaryMesh.geometry;
        editorTrenchBoundaryMesh.geometry = geometry;
        oldGeometry?.dispose();
        editorTrenchBoundaryMesh.visible = true;
    }
}

function removeEditorTrench(entry) {
    if (!entry) return;
    const i = editorTrenchEntries.indexOf(entry);
    if (i >= 0) editorTrenchEntries.splice(i, 1);
    if (entry.waterPlane) {
        const wi = levelWaterPlanes.indexOf(entry.waterPlane);
        if (wi >= 0) levelWaterPlanes.splice(wi, 1);
        if (entry.waterPlane.underlay) scene.remove(entry.waterPlane.underlay);
        if (entry.waterPlane.ripple) scene.remove(entry.waterPlane.ripple);
    }
    if (entry.floorBody) world.removeBody(entry.floorBody);
    if (entry.group) scene.remove(entry.group);
    updateEditorTrenchWalls();
    rebuildEditorTrenchWaterSurface();
    rebuildTemplateGroundCarving();
    updateGrassTrenchCull();
}

function clearEditorTrenches() {
    while (editorTrenchEntries.length) {
        const e = editorTrenchEntries.pop();
        if (e?.waterPlane) {
            const wi = levelWaterPlanes.indexOf(e.waterPlane);
            if (wi >= 0) levelWaterPlanes.splice(wi, 1);
            if (e.waterPlane.underlay) scene.remove(e.waterPlane.underlay);
            if (e.waterPlane.ripple) scene.remove(e.waterPlane.ripple);
        }
        if (e?.floorBody) world.removeBody(e.floorBody);
        if (e?.group) scene.remove(e.group);
    }
    updateEditorTrenchWalls();
    rebuildEditorTrenchWaterSurface();
    rebuildTemplateGroundCarving();
    updateGrassTrenchCull();
}

// Cull grass-tuft instances that fall inside any placed editor trench.
// Called after any trench add / remove so the instancedMesh stays in sync.
function updateGrassTrenchCull() {
    if (!grassTuftsMesh || grassTuftsMesh.count <= 0) return;
    // Lazily snapshot the original matrices once (before any culling).
    if (!grassOriginalMatrices) {
        grassOriginalMatrices = new Float32Array(grassTuftsMesh.instanceMatrix.array);
    }
    const m4  = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const q4  = new THREE.Quaternion();
    const sc  = new THREE.Vector3();
    const d2  = new THREE.Object3D();
    for (let i = 0; i < grassTuftsMesh.count; i++) {
        m4.fromArray(grassOriginalMatrices, i * 16);
        m4.decompose(pos, q4, sc);
        let hidden = false;
        for (const e of editorTrenchEntries) {
            if (pos.x >= e.minX && pos.x <= e.maxX &&
                pos.z >= e.minZ && pos.z <= e.maxZ) {
                hidden = true; break;
            }
        }
        if (hidden) {
            d2.position.copy(pos); d2.quaternion.copy(q4); d2.scale.set(0, 0, 0);
            d2.updateMatrix();
            grassTuftsMesh.setMatrixAt(i, d2.matrix);
        } else {
            grassTuftsMesh.setMatrixAt(i, m4);
        }
    }
    grassTuftsMesh.instanceMatrix.needsUpdate = true;
}

// === Editor Decor � shrubs, trees, wood planks, banners ===
const editorDecorEntries = [];

let _edShrubMatA = null, _edShrubMatB = null;
function _getEdShrubMats() {
    if (!_edShrubMatA) {
        _edShrubMatA = new THREE.MeshStandardMaterial({ color: 0x3a6128, roughness: 0.97, metalness: 0.0, flatShading: true });
        _edShrubMatB = new THREE.MeshStandardMaterial({ color: 0x4d7035, roughness: 0.97, metalness: 0.0, flatShading: true });
    }
    return [_edShrubMatA, _edShrubMatB];
}

let _edTreeTrunkMat = null, _edTreeLeafMat = null;
function _getEdTreeMats() {
    if (!_edTreeTrunkMat) {
        _edTreeTrunkMat = new THREE.MeshStandardMaterial({ color: 0x4a2c0e, roughness: 0.97, metalness: 0.0 });
        _edTreeLeafMat  = new THREE.MeshStandardMaterial({ color: 0x235a1a, roughness: 0.95, metalness: 0.0, flatShading: true });
    }
    return { trunk: _edTreeTrunkMat, leaf: _edTreeLeafMat };
}

const ED_BANNER_PALETTES = [
    ['#8e1b2e', '#e8c24a', '#e8c24a'],
    ['#1f3f86', '#d8d8d8', '#d8d8d8'],
    ['#1f6b35', '#e8c24a', '#e8c24a'],
    ['#5a2168', '#e8c24a', '#e8c24a'],
];

function createEditorDecorShrub(x, z) {
    const [matA, matB] = _getEdShrubMats();
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const s = 0.82 + Math.random() * 0.34;
    const m1 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.44, 0), matA);
    m1.scale.set(s, s * 0.78, s);
    m1.position.set(0, 0.44 * s * 0.78, 0);
    m1.rotation.y = Math.random() * Math.PI;
    m1.castShadow = true;
    g.add(m1);
    if (Math.random() < 0.65) {
        const s2 = s * 0.66;
        const m2 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.36, 0), matB);
        m2.scale.set(s2, s2 * 0.82, s2);
        m2.position.set((Math.random() - 0.5) * 0.28, 0.3 * s2, (Math.random() - 0.5) * 0.28 + 0.22);
        m2.rotation.y = Math.random() * Math.PI;
        m2.castShadow = true;
        g.add(m2);
    }
    scene.add(g);
    const entry = { kind: 'shrub', variant: 's0', group: g, x, z };
    editorDecorEntries.push(entry);
    return entry;
}

function createEditorDecorTree(x, z) {
    const { trunk: trunkMat, leaf: leafMat } = _getEdTreeMats();
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const trunkH = 1.8 + Math.random() * 0.6;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.21, trunkH, 7), trunkMat);
    trunk.position.set(0, trunkH * 0.5, 0);
    trunk.castShadow = true;
    const cone1 = new THREE.Mesh(new THREE.ConeGeometry(1.30, 2.3, 8), leafMat);
    cone1.position.set(0, trunkH + 1.15, 0);
    cone1.castShadow = true;
    const cone2 = new THREE.Mesh(new THREE.ConeGeometry(1.00, 1.9, 8), leafMat);
    cone2.position.set(0, trunkH + 2.2, 0);
    cone2.castShadow = true;
    const cone3 = new THREE.Mesh(new THREE.ConeGeometry(0.65, 1.5, 8), leafMat);
    cone3.position.set(0, trunkH + 3.1, 0);
    cone3.castShadow = true;
    g.add(trunk, cone1, cone2, cone3);
    scene.add(g);
    const entry = { kind: 'tree', variant: 't0', group: g, x, z };
    editorDecorEntries.push(entry);
    return entry;
}

function createEditorDecorBanner(x, z, colorIdx = 0) {
    const ci = ((colorIdx | 0) % ED_BANNER_PALETTES.length + ED_BANNER_PALETTES.length) % ED_BANNER_PALETTES.length;
    const pal = ED_BANNER_PALETTES[ci];
    const tex = makeBannerTexture(pal[0], pal[1], pal[2]);
    const bannerMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x4a2c0e, roughness: 0.92, metalness: 0.0 });
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 5.4, 7), postMat);
    post.position.set(0, 2.7, 0);
    post.castShadow = true;
    const bW = 1.5, bH = 3.8;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(bW, bH, 1, 5), bannerMat);
    cloth.position.set(bW * 0.5, 3.9, 0.025);
    cloth.castShadow = true;
    const cross = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, bW + 0.18, 6), postMat);
    cross.rotation.z = Math.PI * 0.5;
    cross.position.set(bW * 0.5, 4.8, 0);
    cross.castShadow = true;
    g.add(post, cloth, cross);
    scene.add(g);
    const entry = { kind: 'banner', variant: `b${ci}`, colorIdx: ci, group: g, x, z };
    editorDecorEntries.push(entry);
    return entry;
}

/* Editor plank placement � delegates to the shared createPlank infrastructure
   (instanced mesh + physics body in bricks[]) so planks stack and snap exactly
   like masonry bricks. Returns the new bricks[] tail entry for tracking. */
function createEditorPlankX(x, y, z) {
    createPlank(x, y, z, false);
    return bricks[bricks.length - 1];
}
function createEditorPlankZ(x, y, z) {
    createPlank(x, y, z, true);
    return bricks[bricks.length - 1];
}

function removeEditorDecor(entry) {
    if (!entry) return;
    const i = editorDecorEntries.indexOf(entry);
    if (i >= 0) editorDecorEntries.splice(i, 1);
    if (entry.group) scene.remove(entry.group);
    else if (entry.mesh) scene.remove(entry.mesh);
}

function clearEditorDecor() {
    while (editorDecorEntries.length) {
        const e = editorDecorEntries.pop();
        if (e?.group) scene.remove(e.group);
        else if (e?.mesh) scene.remove(e.mesh);
    }
}

function getEditorTrenchWaterYAtXZ(x, z) {
    for (let i = editorTrenchEntries.length - 1; i >= 0; i--) {
        const e = editorTrenchEntries[i];
        if (Number.isFinite(e.radius)) {
            const dx = x - e.x;
            const dz = z - e.z;
            if ((dx * dx + dz * dz) <= (e.radius * e.radius)) return e.waterY;
        } else if (x >= e.minX && x <= e.maxX && z >= e.minZ && z <= e.maxZ) {
            return e.waterY;
        }
    }
    return null;
}

function isLevelRoleSuppressed(levelRole = 'bridge') {
    // This helper is called during early scene setup; these flags are declared
    // later in the module, so guard against TDZ access on first load.
    if (levelRole === 'castle') {
        try {
            return !!storyCastleSuppressed;
        } catch {
            return false;
        }
    }
    if (levelRole === 'bridge') {
        try {
            return !!storyBridgeSuppressed;
        } catch {
            return false;
        }
    }
    return false;
}

function setDevWaterFxEnabled(enabled) {
    devWaterFxEnabled = !!enabled;

    for (const wp of levelWaterPlanes) {
        if (!wp) continue;
        const forceHiddenByBridge2 = bridge2ModeActive && wp.levelRole === 'bridge';
        const levelSuppressed = (wp.levelRole === 'bridge')
            ? storyBridgeSuppressed
            : (wp.levelRole === 'castle' ? storyCastleSuppressed : false);
        const showLevelWater = devWaterFxEnabled && !levelSuppressed && !forceHiddenByBridge2;
        if (wp.underlay) wp.underlay.visible = showLevelWater;
        if (wp.ripple) wp.ripple.visible = showLevelWater;
        if (wp.ripple2) wp.ripple2.visible = showLevelWater;
        if (wp.ripple3) wp.ripple3.visible = showLevelWater;
        if (wp.foam) wp.foam.visible = showLevelWater;
    }

    for (const wm of bridgeLibraryWaterSurfaces) {
        if (!wm) continue;
        const role = wm.userData?.waterRole || 'bridge';
        const forceHiddenByBridge2 = bridge2ModeActive && role === 'bridge';
        const levelSuppressed = isLevelRoleSuppressed(role);
        wm.visible = devWaterFxEnabled && !levelSuppressed && !forceHiddenByBridge2;
    }

    for (const cap of storyWaterCapMeshes) {
        if (!cap) continue;
        const role = cap.userData?.waterRole || 'bridge';
        const forceHiddenByBridge2 = bridge2ModeActive && role === 'bridge';
        const levelSuppressed = isLevelRoleSuppressed(role);
        cap.visible = devWaterFxEnabled && !levelSuppressed && !forceHiddenByBridge2;
    }

    if (!devWaterFxEnabled || !waterFxImpactRipplesEnabled) {
        for (const r of waterImpactRipples) {
            if (!r || !r.mesh) continue;
            r.active = false;
            r.mesh.visible = false;
            if (r.mat) r.mat.opacity = 0;
        }
    } else {
        for (const r of waterImpactRipples) {
            if (!r || !r.mesh) continue;
            const forceHiddenByBridge2 = bridge2ModeActive && r.role === 'bridge';
            const levelSuppressed = (r.role === 'bridge')
                ? storyBridgeSuppressed
                : (r.role === 'castle' ? storyCastleSuppressed : false);
            r.mesh.visible = !levelSuppressed && !forceHiddenByBridge2 && r.active;
        }
    }

    // Re-apply current tint/opacity to all active water materials when toggled.
    applyWaterFxRuntimeTuning();
}

function setWaterImpactRipplesEnabled(enabled) {
    waterFxImpactRipplesEnabled = !!enabled;
    if (waterFxImpactRipplesEnabled) return;
    for (const r of waterImpactRipples) {
        if (!r || !r.mesh) continue;
        r.active = false;
        r.mesh.visible = false;
        if (r.mat) r.mat.opacity = 0;
    }
}

function getReadableWaterColor(hexColor = waterFxColor) {
    const c = new THREE.Color(hexColor);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    if (hsl.l < 0.16) {
        c.offsetHSL(0, 0, 0.16 - hsl.l);
        // Keep a touch of the baseline murky tone so water remains legible.
        c.lerp(new THREE.Color(MURKY_WATER_COLOR), 0.22);
    }
    return c;
}

function applyWaterFxRuntimeTuning() {
    const readableWaterColor = getReadableWaterColor(waterFxColor);

    if (waterUnderlayMat) {
        waterUnderlayMat.color.copy(readableWaterColor);
        waterUnderlayMat.opacity = waterFxOpacity;
        waterUnderlayMat.needsUpdate = true;
    }

    for (const capMat of storyWaterCapMaterials) {
        if (!capMat) continue;
        if (capMat.userData?.forceTintCap) {
            const readableTint = readableWaterColor.clone().lerp(new THREE.Color(MURKY_WATER_COLOR), 0.72);
            capMat.color.copy(readableTint);
        } else {
            capMat.color.copy(readableWaterColor);
        }
        const opacityMax = Math.max(0.08, capMat.userData?.waterCapOpacityMax ?? MURKY_WATER_CAP_OPACITY);
        const opacityMin = capMat.userData?.forceTintCap ? 0.34 : 0.08;
        capMat.opacity = Math.min(opacityMax, Math.max(opacityMin, waterFxOpacity * 0.85));
        capMat.needsUpdate = true;
    }

    if (rippleMat) {
        const tint = readableWaterColor.clone();
        tint.offsetHSL(0, 0.02, -0.08);
        rippleMat.color.copy(tint);
        rippleMat.needsUpdate = true;
    }

    for (const wm of bridgeLibraryWaterSurfaces) {
        const uniforms = wm?.material?.uniforms;
        if (uniforms?.waterColor?.value) {
            uniforms.waterColor.value.copy(readableWaterColor);
        }
        if (uniforms?.alpha) {
            uniforms.alpha.value = Math.max(0.12, Math.min(0.92, waterFxOpacity * 0.72));
        }
    }

    const rippleTint = readableWaterColor.clone().lerp(new THREE.Color(0xffffff), 0.55);
    for (const r of waterImpactRipples) {
        if (!r?.mat) continue;
        r.mat.color.copy(rippleTint);
        r.mat.needsUpdate = true;
    }
}

function initWaterImpactRipples() {
    if (!WATER_SYSTEM_ENABLED || !WATER_IMPACT_RIPPLES_ENABLED || waterImpactRipples.length) return;
    const poolSize = isMobileProfile ? 20 : 34;
    const ringGeo = new THREE.RingGeometry(0.76, 1.1, 28);
    const rippleTint = new THREE.Color(waterFxColor).lerp(new THREE.Color(0xffffff), 0.55);
    for (let i = 0; i < poolSize; i++) {
        const mat = new THREE.MeshBasicMaterial({
            color: rippleTint,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
            side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(ringGeo, mat);
        ring.rotation.x = -Math.PI / 2;
        ring.visible = false;
        scene.add(ring);
        waterImpactRipples.push({
            mesh: ring,
            mat,
            active: false,
            age: 0,
            life: 0.85,
            startR: 1.0,
            endR: 6.0,
            intensity: 1.0,
            y: WATER_Y,
            role: 'bridge',
        });
    }
}

function isWaterRippleSafePointAtXZ(x, z, edgeBuffer = 0, preferredRole = null) {
    const checkBridge = preferredRole !== 'castle';
    const checkCastle = preferredRole !== 'bridge';

    if (checkBridge && isStoryBridgeWaterActive()) {
        const inBridge = isInStoryBridgeWaterShapeXZ(x, z, edgeBuffer) && !isOnStoryBridgeRoadXZ(x, z, edgeBuffer);
        if (inBridge) return true;
    }

    if (checkCastle && isCastleMoatWaterActive()) {
        if (isInCastleMoatRingXZ(x, z, edgeBuffer)) return true;
    }

    return false;
}

function getWaterRippleShoreClearanceAtXZ(x, z, role = null) {
    let preferredRole = (role === 'bridge' || role === 'castle') ? role : null;
    if (!isWaterRippleSafePointAtXZ(x, z, 0, preferredRole)) {
        if (preferredRole && isWaterRippleSafePointAtXZ(x, z, 0, null)) {
            preferredRole = null;
        } else {
            return 0;
        }
    }

    let lo = 0;
    let hi = preferredRole === 'castle' ? 5.0 : 3.6;
    const maxHi = preferredRole === 'castle' ? 24.0 : 14.0;
    while (hi < maxHi && isWaterRippleSafePointAtXZ(x, z, hi, preferredRole)) {
        lo = hi;
        hi += preferredRole === 'castle' ? 2.5 : 1.8;
    }
    hi = Math.min(hi, maxHi);

    for (let i = 0; i < 9; i++) {
        const mid = (lo + hi) * 0.5;
        if (isWaterRippleSafePointAtXZ(x, z, mid, preferredRole)) lo = mid;
        else hi = mid;
    }
    return lo;
}

function spawnWaterImpactRipple(x, z, y = WATER_Y, speed = 1.0, role = 'bridge') {
    if (!WATER_SYSTEM_ENABLED || !devWaterFxEnabled || !waterFxImpactRipplesEnabled || !WATER_IMPACT_RIPPLES_ENABLED || !waterImpactRipples.length) return;
    const preferredRole = (role === 'bridge' || role === 'castle') ? role : null;
    const shoreClearance = getWaterRippleShoreClearanceAtXZ(x, z, preferredRole);
    const maxScaleRadius = (shoreClearance - WATER_IMPACT_RIPPLE_SHORE_PADDING_M) / WATER_IMPACT_RING_OUTER_RADIUS_SCALE;
    if (!(maxScaleRadius > WATER_IMPACT_RIPPLE_MIN_RADIUS_M)) return;

    const startR = (0.55 + Math.min(0.7, speed * 0.02)) * waterFxRippleSizeMul;
    const endR = startR + (1.3 + Math.min(2.5, speed * 0.065)) * waterFxRippleSizeMul;
    const clampedEndR = Math.min(endR, maxScaleRadius);
    if (!(clampedEndR > WATER_IMPACT_RIPPLE_MIN_RADIUS_M)) return;
    const clampedStartR = Math.max(
        WATER_IMPACT_RIPPLE_MIN_RADIUS_M,
        Math.min(startR, clampedEndR * 0.72)
    );

    const r = waterImpactRipples[waterImpactRippleCursor];
    waterImpactRippleCursor = (waterImpactRippleCursor + 1) % waterImpactRipples.length;
    r.active = true;
    r.age = 0;
    r.life = (0.92 + Math.min(0.55, speed * 0.028)) * waterFxRippleLifeMul;
    r.startR = clampedStartR;
    r.endR = clampedEndR;
    r.intensity = THREE.MathUtils.clamp((0.36 + speed * 0.025) * waterFxRippleStrengthMul, 0.25, 1.35);
    r.y = y;
    r.role = preferredRole || getRippleRoleAtXZ(x, z);
    r.mesh.visible = true;
    r.mesh.position.set(x, y + WATER_IMPACT_RIPPLE_Y_OFFSET, z);
    r.mesh.scale.setScalar(r.startR);
    r.mat.opacity = 0.52 * r.intensity;
}

function updateWaterImpactRipples(dt) {
    if (!WATER_SYSTEM_ENABLED || !devWaterFxEnabled || !waterFxImpactRipplesEnabled || !WATER_IMPACT_RIPPLES_ENABLED || !waterImpactRipples.length) return;
    for (const r of waterImpactRipples) {
        if (!r.active) continue;
        r.age += dt;
        const t = r.life > 0 ? Math.min(1, r.age / r.life) : 1;
        if (t >= 1) {
            r.active = false;
            r.mesh.visible = false;
            r.mat.opacity = 0;
            continue;
        }
        const eased = 1 - Math.pow(1 - t, 2.2);
        const radius = THREE.MathUtils.lerp(r.startR, r.endR, eased);
        r.mesh.scale.setScalar(radius);
        r.mesh.position.y = r.y + WATER_IMPACT_RIPPLE_Y_OFFSET + Math.sin((t + radius) * 3.8) * 0.0035;
        r.mat.opacity = (1 - t) * (1 - t * 0.2) * 0.52 * r.intensity;
    }
}

function getRippleRoleAtXZ(x, z) {
    if (isInStoryBridgeWaterShapeXZ(x, z, 0)) return 'bridge';
    if (isInCastleMoatRingXZ(x, z, 0)) return 'castle';
    const activeRole = getActiveStoryRole();
    if (activeRole) return activeRole;
    return 'castle';
}

function addWaterPlane(cx, cz, w, d, levelRole = 'castle', yBase = WATER_Y) {
    if (!WATER_SYSTEM_ENABLED) return null;
    const geoA = makeWaterSurfaceGeometry(w, d);
    const showLevelWater = devWaterFxEnabled && !isLevelRoleSuppressed(levelRole);
    const bridgeSolidCapMode = levelRole === 'bridge' && !BRIDGE_WATER_USE_LIBRARY_SURFACE;

    const underlay = bridgeSolidCapMode ? null : createWaterUnderlayMesh(geoA, levelRole);
    if (underlay) {
        underlay.rotation.x = -Math.PI / 2;
        underlay.position.set(cx, yBase + 0.006, cz);
        underlay.visible = showLevelWater;
        scene.add(underlay);
    }

    let ripple = null;
    if (WATER_SURFACE_EFFECTS_ENABLED && rippleMat) {
        ripple = new THREE.Mesh(geoA, rippleMat);
        ripple.rotation.x = -Math.PI / 2;
        ripple.position.set(cx, yBase + 0.02, cz);
        ripple.visible = showLevelWater;
        scene.add(ripple);
        bindAnimatedWaterSurface(ripple);
    }

    levelWaterPlanes.push({
        underlay,
        ripple,
        ripple2: null,
        ripple3: null,
        foam: null,
        levelRole,
        baseY: yBase,
        phase: Math.random() * Math.PI * 2,
        waveAmp: levelRole === 'bridge' ? 0.012 : 0.038,
        waveSpeed: levelRole === 'bridge' ? 0.62 : 1.02,
    });
    return levelWaterPlanes[levelWaterPlanes.length - 1];
}

function addWaterShapePlane(shapeGeometry, cx, cz, levelRole = 'castle', yBase = WATER_Y) {
    if (!WATER_SYSTEM_ENABLED) return null;
    const showLevelWater = devWaterFxEnabled && !isLevelRoleSuppressed(levelRole);
    const bridgeSolidCapMode = levelRole === 'bridge' && !BRIDGE_WATER_USE_LIBRARY_SURFACE;
    const underlay = bridgeSolidCapMode ? null : createWaterUnderlayMesh(shapeGeometry, levelRole);
    if (underlay) {
        underlay.rotation.x = -Math.PI / 2;
        underlay.position.set(cx, yBase + 0.006, cz);
        underlay.name = `waterUnderlay-${levelRole}`;
        underlay.visible = showLevelWater;
        scene.add(underlay);
    }

    let ripple = null;
    if (WATER_SURFACE_EFFECTS_ENABLED && rippleMat) {
        ripple = new THREE.Mesh(shapeGeometry.clone(), rippleMat);
        ripple.rotation.x = -Math.PI / 2;
        ripple.position.set(cx, yBase + 0.02, cz);
        ripple.name = `waterRipplePlane-${levelRole}`;
        ripple.visible = showLevelWater;
        scene.add(ripple);
        bindAnimatedWaterSurface(ripple);
    }

    levelWaterPlanes.push({
        underlay,
        ripple,
        ripple2: null,
        ripple3: null,
        foam: null,
        levelRole,
        baseY: yBase,
        phase: Math.random() * Math.PI * 2,
        waveAmp: levelRole === 'bridge' ? 0.014 : 0.040,
        waveSpeed: levelRole === 'bridge' ? 0.66 : 1.08,
    });
    return levelWaterPlanes[levelWaterPlanes.length - 1];
}
const castleMoatWaterGeo = makeRoundedRectRingGeometry(
    {
        x1: M_OX1,
        x2: M_OX2,
        z1: M_OZ1,
        z2: M_OZ2,
        r: 0.01, // square outer edge � matches straight bank walls
    },
    {
        x1: M_IX1,
        x2: M_IX2,
        z1: M_IZ1,
        z2: M_IZ2,
        r: 0.01, // square inner edge � matches straight island bank walls
    },
    isMobileProfile ? 10 : 16
);
// Rounded-rect ShapeGeometry stores points in XY. Our moat points are authored
// in XZ-world terms, and these meshes are rotated by -PI/2, so mirror local Y
// to land the ring at the castle's positive-Z moat instead of the opposite side.
castleMoatWaterGeo.scale(1, -1, 1);
if (WATER_SYSTEM_ENABLED && (CASTLE_MOAT_WATER_ENABLED || SIMPLE_MURKY_WATER_OVERLAY)) {
    // Match bridge layering: keep underlay/ripple depth at gameplay water Y
    // and render the visible Water shader surface at SIMPLE_WATER_SURFACE_Y.
    // Handles captured for the King's Bunker moat-drain sequence.
    castleMoatWaterPlane = addWaterShapePlane(castleMoatWaterGeo, 0, 0, 'castle', WATER_Y);
    castleMoatWaterCap = addStoryBridgeVisualWaterCap(castleMoatWaterGeo, SIMPLE_WATER_SURFACE_Y, 0, 0, castleSceneMeshes, 'castle', true);
}
initWaterImpactRipples();

// Moat bank walls (4 inner + 4 outer stone faces, thin boxes)
const bankMat = new THREE.MeshStandardMaterial({
    map: stoneColorMap, bumpMap: stoneBumpMap, bumpScale: 0.06,
    roughness: 0.9, metalness: 0.0
});
function addBankWall(cx, cy, cz, w, h, d) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bankMat);
    m.position.set(cx, cy, cz); m.receiveShadow = true; m.castShadow = true;
    scene.add(m);
    castleSceneMeshes.push(m);
}
// Moat wall height = full depth from water surface to ground
const BANK_H = MOAT_DEPTH;
const BANK_Y = -MOAT_DEPTH / 2 - 0.02;  // sink slightly below grass to prevent seam flicker
const MOAT_WALL_T = 0.35;         // thickness of stone bank walls
addBankWall((M_IX1+M_IX2)/2, BANK_Y, M_IZ1,  M_IX2-M_IX1, BANK_H, MOAT_WALL_T); // front inner
addBankWall((M_IX1+M_IX2)/2, BANK_Y, M_IZ2,  M_IX2-M_IX1, BANK_H, MOAT_WALL_T); // back inner
addBankWall(M_IX1,           BANK_Y, (M_IZ1+M_IZ2)/2, MOAT_WALL_T, BANK_H, M_IZ2-M_IZ1); // left inner
addBankWall(M_IX2,           BANK_Y, (M_IZ1+M_IZ2)/2, MOAT_WALL_T, BANK_H, M_IZ2-M_IZ1); // right inner
// Outer bank walls (player-side)
addBankWall((M_OX1+M_OX2)/2, BANK_Y, M_OZ1,  M_OX2-M_OX1, BANK_H, MOAT_WALL_T); // front outer
addBankWall((M_OX1+M_OX2)/2, BANK_Y, M_OZ2,  M_OX2-M_OX1, BANK_H, MOAT_WALL_T); // back outer
addBankWall(M_OX1,           BANK_Y, (M_OZ1+M_OZ2)/2, MOAT_WALL_T, BANK_H, M_OZ2-M_OZ1); // left outer
addBankWall(M_OX2,           BANK_Y, (M_OZ1+M_OZ2)/2, MOAT_WALL_T, BANK_H, M_OZ2-M_OZ1); // right outer

// Moat floor (mud + silt detail below the water)
const mudMat = new THREE.MeshStandardMaterial({
    map: mudTex,
    color: 0x7f7568,
    roughness: 0.98,
    metalness: 0.0,
    side: THREE.DoubleSide
});
const moatFloorGeo = makeRoundedRectRingGeometry(
    {
        x1: M_OX1,
        x2: M_OX2,
        z1: M_OZ1,
        z2: M_OZ2,
        r: 0.01, // square � matches bank walls
    },
    {
        x1: M_IX1,
        x2: M_IX2,
        z1: M_IZ1,
        z2: M_IZ2,
        r: 0.01,
    },
    isMobileProfile ? 10 : 14
);
moatFloorGeo.scale(1, -1, 1);
const moatFloor = new THREE.Mesh(moatFloorGeo, mudMat);
moatFloor.rotation.x = -Math.PI / 2;
moatFloor.position.set(0, -MOAT_DEPTH, 0);
scene.add(moatFloor);
castleSceneMeshes.push(moatFloor);

// Submerged silt shelf follows the same rounded moat ring silhouette.
const moatShelfMat = new THREE.MeshStandardMaterial({
    map: mudTex,
    color: 0x6f6658,
    roughness: 0.97,
    metalness: 0.0,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide
});
const moatShelfGeo = makeRoundedRectRingGeometry(
    {
        x1: M_OX1 + 0.45,
        x2: M_OX2 - 0.45,
        z1: M_OZ1 + 0.45,
        z2: M_OZ2 - 0.45,
        r: 0.01, // square � matches bank walls
    },
    {
        x1: M_IX1 - 0.28,
        x2: M_IX2 + 0.28,
        z1: M_IZ1 - 0.28,
        z2: M_IZ2 + 0.28,
        r: 0.01,
    },
    isMobileProfile ? 8 : 12
);
moatShelfGeo.scale(1, -1, 1);
if (CASTLE_MOAT_WATER_ENABLED) {
    const moatShelf = new THREE.Mesh(moatShelfGeo, moatShelfMat);
    moatShelf.rotation.x = -Math.PI / 2;
    moatShelf.position.set(0, WATER_Y + 0.014, 0);
    moatShelf.receiveShadow = true;
    scene.add(moatShelf);
    castleSceneMeshes.push(moatShelf);
}

// === Moat physics floor � static CANNON bodies for moat collisions ===
// Six segments cover the moat ring, skipping the island and the drawbridge corridor.
(function addMoatPhysicsFloor() {
    function seg(cx, cz, hw, hd) {
        const b = new CANNON.Body({ mass: 0 });
        b.addShape(new CANNON.Box(new CANNON.Vec3(hw, 0.15, hd)));
        // Dry moat uses the trench bottom; water mode uses the shallower
        // submerged settle depth.
        const moatPhysicsY = CASTLE_MOAT_WATER_ENABLED
            ? (WATER_Y - WATER_DEPTH_M)
            : (-MOAT_DEPTH + 0.15);
        b.position.set(cx, moatPhysicsY, cz);
        b._storyRole = 'castle';
        world.addBody(b);
        castleMoatPhysicsBodies.push(b);
    }
    const bHW = 3.0;    // drawbridge half-width (DB_W=6 is declared later � use literal)
    // Front strip (z 45-54): left of bridge and right of bridge
    seg(-(M_OX2 + bHW) / 2, (M_OZ1 + M_IZ1) / 2, (M_OX2 - bHW) / 2, (M_IZ1 - M_OZ1) / 2);
    seg( (M_OX2 + bHW) / 2, (M_OZ1 + M_IZ1) / 2, (M_OX2 - bHW) / 2, (M_IZ1 - M_OZ1) / 2);
    // Left side strip
    seg((M_OX1 + M_IX1) / 2, (M_IZ1 + M_IZ2) / 2, (M_IX1 - M_OX1) / 2, (M_IZ2 - M_IZ1) / 2);
    // Right side strip
    seg((M_IX2 + M_OX2) / 2, (M_IZ1 + M_IZ2) / 2, (M_OX2 - M_IX2) / 2, (M_IZ2 - M_IZ1) / 2);
    // Back strip
    seg((M_OX1 + M_OX2) / 2, (M_IZ2 + M_OZ2) / 2, (M_OX2 - M_OX1) / 2, (M_OZ2 - M_IZ2) / 2);
})();

// === Castle ===
// Brick: 1.0m wide x 0.5m tall x 0.5m deep
const bricks = [];
const BS = { w: 2.0, h: 1.0, d: 1.0 };

// X-aligned brick: long axis along X (used for front/back faces)
const brickGeo  = new THREE.BoxGeometry(BS.w, BS.h, BS.d);
// Z-aligned brick: long axis along Z (used for side walls & tower sides)
const brickGeoZ = new THREE.BoxGeometry(BS.d, BS.h, BS.w);
// Y-aligned brick: long axis along Y (used as vertical closers in stagger gaps)
const brickGeoY = new THREE.BoxGeometry(BS.h, BS.w, BS.d);
// Cube brick: 1x1x1 gap filler for half-step stagger voids.
const brickGeoC = new THREE.BoxGeometry(BS.h, BS.h, BS.h);
// Half-height slab: 2.0 � 0.5 � 1.0 bearing course � fills half-module gaps
// (e.g. bridge substructure top ? deck underside) that a 1 m brick cannot.
const brickGeoH = new THREE.BoxGeometry(BS.w, BS.h * 0.5, BS.d);

const brickMat = new THREE.MeshStandardMaterial({
    map: stoneColorMap,
    bumpMap: stoneBumpMap,
    bumpScale: 0.14,
    roughness: 0.92,
    metalness: 0.0
});
const wedgeStoneMap = stoneColorMap.clone();
wedgeStoneMap.wrapS = THREE.ClampToEdgeWrapping;
wedgeStoneMap.wrapT = THREE.ClampToEdgeWrapping;
wedgeStoneMap.repeat.set(1, 1);

const wedgeStoneMat = new THREE.MeshStandardMaterial({
    map: wedgeStoneMap,
    bumpMap: stoneBumpMap,
    bumpScale: 0.05,
    roughness: 0.95,
    metalness: 0.0
});
wedgeStoneMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
            vec4 sampledDiffuseColor = texture2D( map, vMapUv );
            diffuseColor *= sampledDiffuseColor;
            float edgeDist = min(min(vMapUv.x, 1.0 - vMapUv.x), min(vMapUv.y, 1.0 - vMapUv.y));
            float mortar = smoothstep(0.0, 0.08, edgeDist);
            diffuseColor.rgb *= mix(0.58, 1.0, mortar);
        #endif`
    );
};

// -- InstancedMesh for bricks (2 draw calls total instead of ~1600) --
// We pre-allocate for the maximum expected brick count.
const MAX_BRICKS = 12000;
const _iDummy    = new THREE.Object3D();
const brickInstX = new THREE.InstancedMesh(brickGeo, brickMat, MAX_BRICKS);
const brickInstZ = new THREE.InstancedMesh(brickGeoZ, brickMat, MAX_BRICKS);
const brickInstY = new THREE.InstancedMesh(brickGeoY, brickMat, MAX_BRICKS);
const brickInstC = new THREE.InstancedMesh(brickGeoC, brickMat, MAX_BRICKS);
const brickInstH = new THREE.InstancedMesh(brickGeoH, brickMat, 1024);
brickInstX.castShadow = true; brickInstX.receiveShadow = true;
brickInstZ.castShadow = true; brickInstZ.receiveShadow = true;
brickInstY.castShadow = true; brickInstY.receiveShadow = true;
brickInstC.castShadow = true; brickInstC.receiveShadow = true;
brickInstH.castShadow = true; brickInstH.receiveShadow = true;
// Dynamic instanced masonry moves across a wide playfield. Keep frustum
// culling off so per-mesh bounds never clip visible instances by camera angle.
brickInstX.frustumCulled = false;
brickInstZ.frustumCulled = false;
brickInstY.frustumCulled = false;
brickInstC.frustumCulled = false;
brickInstH.frustumCulled = false;
brickInstX.count = 0; brickInstZ.count = 0; brickInstY.count = 0; brickInstC.count = 0; brickInstH.count = 0;
scene.add(brickInstX); scene.add(brickInstZ); scene.add(brickInstY); scene.add(brickInstC); scene.add(brickInstH);

// -- Tower wedge (voussoir) bricks --
// Round-tower bricks are trapezoidal prisms, not rectangular boxes, so they tile
// the ring exactly (shared flat radial faces, no overlap, no gap). They get
// their own instanced mesh and a single shared convex collider, both built once
// the ring dimensions are known (further below). Declared here so
// createBrickAngled and the per-frame sync loop can reference them.
const MAX_TOWER_BRICKS = 1200;
let towerInst = null;
let towerWedgeShape = null;
// Build a flat-shaded, UV-mapped BufferGeometry from explicit vertices + convex
// faces (each face a CCW index loop). Vertices are duplicated per face so the
// stone reads as crisp, hard-edged masonry rather than a smoothed lump.
function makeWedgeGeometry(verts, faces) {
    const pos = [], uv = [];
    const edge = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const V = i => [verts[i][0], verts[i][1], verts[i][2]];
    for (const f of faces) {
        const uvByFaceIdx = new Array(f.length);
        if (f.length === 4) {
            // Map each quad to the full UV square in face-loop order so
            // mortar is guaranteed on all 4 perimeter edges, including slants.
            let start = 0;
            let bestLen2 = -1;
            for (let i = 0; i < 4; i++) {
                const a = f[i];
                const b = f[(i + 1) % 4];
                edge.set(verts[b][0] - verts[a][0], verts[b][1] - verts[a][1], verts[b][2] - verts[a][2]);
                const len2 = edge.lengthSq();
                if (len2 > bestLen2) {
                    bestLen2 = len2;
                    start = i;
                }
            }
            const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
            for (let k = 0; k < 4; k++) {
                uvByFaceIdx[(start + k) % 4] = corners[k];
            }
        } else {
            for (let i = 0; i < f.length; i++) {
                const t = i / f.length;
                uvByFaceIdx[i] = [0.5 + 0.5 * Math.cos(t * Math.PI * 2), 0.5 + 0.5 * Math.sin(t * Math.PI * 2)];
            }
        }
        for (let i = 1; i < f.length - 1; i++) {
            for (const vi of [0, i, i + 1]) {
                const idx = f[vi];
                tmp.set(...V(idx));
                pos.push(tmp.x, tmp.y, tmp.z);
                const uvPair = uvByFaceIdx[vi];
                uv.push(uvPair[0], uvPair[1]);
            }
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
}

// Collision filter groups ? bricks ignore the drawbridge so the swinging
// door doesn't wake/knock sleeping bricks in the gate arch.
const CGROUP_BRICK  = 2;
const CGROUP_BRIDGE = 8;
const CGROUP_NPC    = 16;  // ragdoll parts ? bricks ignore these so NPCs don't launch walls
const CGROUP_TOWER  = 32;  // round-tower bricks ? physically decoupled from walls
// (default group=1 for ground, cannonballs)
//
// Tower bricks and wall bricks are deliberately on separate groups that do NOT
// collide with each other. The side/curtain walls visually overlap (extend 3 m
// into) the round towers to leave no gaps, but that means their end bricks are
// built INSIDE the tower ring. If they collided, the solver would violently
// separate that deep build-time penetration the instant either side is
// disturbed � and the impulse would chain along the connected wall to topple a
// distant tower (the "hit front tower, rear tower falls" bug). Decoupling makes
// every tower an independent, symmetric structure: walls can collapse without
// dragging towers down, and a hit on one tower can't reach another.
const WALL_MASK  = -1 ^ CGROUP_BRIDGE ^ CGROUP_NPC ^ CGROUP_TOWER;
const TOWER_MASK = -1 ^ CGROUP_BRIDGE ^ CGROUP_NPC ^ CGROUP_BRICK;

// Wall bricks sit at exactly BS.w spacing, so full-width colliders touch their
// row-neighbours face-to-face and weld the whole course into one rigid chain � a
// side-on hit then transmits a compression wave that tears down the entire wall
// length. Trim the collider a hair along the LENGTH axis only (height/depth stay
// full so vertical stacking and wall-thickness stay solid). The instanced visual
// is unchanged, so bricks still look perfectly butted together.
const WALL_BRICK_HALF_LEN = BS.w / 2 - 0.05;   // ~10 cm gap between row-neighbours

function createBrick(x, y, z) {
    const idx = brickInstX.count++;
    _iDummy.position.set(x, y, z); _iDummy.quaternion.set(0,0,0,1); _iDummy.updateMatrix();
    brickInstX.setMatrixAt(idx, _iDummy.matrix);
    brickInstX.instanceMatrix.needsUpdate = true;
    const body = new CANNON.Body({
        mass: 120,   // heavy hewn block, but light enough that a 12-high stack stays solver-stable
        material: wallPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(WALL_BRICK_HALF_LEN, BS.h / 2, BS.d / 2)),
        allowSleep: true,
        sleepSpeedLimit: 0.6,
        sleepTimeLimit:  0.3,
        linearDamping:   0.30,
        angularDamping:  0.55,
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  WALL_MASK
    });
    body.position.set(x, y, z);
    body._storyRole = 'castle';
    world.addBody(body);
    body.sleep();
    bricks.push({ idx, isZ: false, body, ix: x, iy: y, iz: z, scored: false, grp: CGROUP_BRICK, storyRole: 'castle' });
}

// X-aligned brick with an explicit quaternion (used for smooth ramp courses).
function createBrickTiltQuat(x, y, z, quat) {
    const idx = brickInstX.count++;
    _iDummy.position.set(x, y, z);
    _iDummy.quaternion.copy(quat);
    _iDummy.updateMatrix();
    brickInstX.setMatrixAt(idx, _iDummy.matrix);
    brickInstX.instanceMatrix.needsUpdate = true;
    const body = new CANNON.Body({
        mass: 120,
        material: wallPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(WALL_BRICK_HALF_LEN, BS.h / 2, BS.d / 2)),
        allowSleep: true,
        sleepSpeedLimit: 0.6,
        sleepTimeLimit:  0.3,
        linearDamping:   0.30,
        angularDamping:  0.55,
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  WALL_MASK
    });
    body.position.set(x, y, z);
    body.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    body._storyRole = 'castle';
    world.addBody(body);
    body.sleep();
    bricks.push({ idx, isZ: false, isTilt: true, body, ix: x, iy: y, iz: z, scored: false, grp: CGROUP_BRICK, storyRole: 'castle' });
}

// Z-aligned brick: long axis runs along Z (for side walls & tower sides)
function createBrickZ(x, y, z) {
    const idx = brickInstZ.count++;
    _iDummy.position.set(x, y, z); _iDummy.quaternion.set(0,0,0,1); _iDummy.updateMatrix();
    brickInstZ.setMatrixAt(idx, _iDummy.matrix);
    brickInstZ.instanceMatrix.needsUpdate = true;
    const body = new CANNON.Body({
        mass: 120,
        material: wallPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(BS.d / 2, BS.h / 2, WALL_BRICK_HALF_LEN)),
        allowSleep: true,
        sleepSpeedLimit: 0.6,
        sleepTimeLimit:  0.3,
        linearDamping:   0.30,
        angularDamping:  0.55,
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  WALL_MASK
    });
    body.position.set(x, y, z);
    body._storyRole = 'castle';
    world.addBody(body);
    body.sleep();
    bricks.push({ idx, isZ: true, body, ix: x, iy: y, iz: z, scored: false, grp: CGROUP_BRICK, storyRole: 'castle' });
}

// Y-aligned brick: long axis runs along Y (vertical closer blocks)
function createBrickY(x, y, z) {
    const idx = brickInstY.count++;
    _iDummy.position.set(x, y, z); _iDummy.quaternion.set(0,0,0,1); _iDummy.updateMatrix();
    brickInstY.setMatrixAt(idx, _iDummy.matrix);
    brickInstY.instanceMatrix.needsUpdate = true;
    const body = new CANNON.Body({
        mass: 120,
        material: wallPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(BS.h / 2, WALL_BRICK_HALF_LEN, BS.d / 2)),
        allowSleep: true,
        sleepSpeedLimit: 0.6,
        sleepTimeLimit:  0.3,
        linearDamping:   0.30,
        angularDamping:  0.55,
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  WALL_MASK
    });
    body.position.set(x, y, z);
    body._storyRole = 'castle';
    world.addBody(body);
    body.sleep();
    bricks.push({ idx, isY: true, body, ix: x, iy: y, iz: z, scored: false, grp: CGROUP_BRICK, storyRole: 'castle' });
}

// Z-aligned brick with an explicit quaternion (tilted ramp courses, running bond).
function createBrickZTiltQuat(x, y, z, quat) {
    const idx = brickInstZ.count++;
    _iDummy.position.set(x, y, z);
    _iDummy.quaternion.copy(quat);
    _iDummy.updateMatrix();
    brickInstZ.setMatrixAt(idx, _iDummy.matrix);
    brickInstZ.instanceMatrix.needsUpdate = true;
    const body = new CANNON.Body({
        mass: 120,
        material: wallPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(BS.d / 2, BS.h / 2, WALL_BRICK_HALF_LEN)),
        allowSleep: true,
        sleepSpeedLimit: 0.6,
        sleepTimeLimit:  0.3,
        linearDamping:   0.30,
        angularDamping:  0.55,
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  WALL_MASK
    });
    body.position.set(x, y, z);
    body.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    body._storyRole = 'castle';
    world.addBody(body);
    body.sleep();
    bricks.push({ idx, isZ: true, isTilt: true, body, ix: x, iy: y, iz: z, scored: false, grp: CGROUP_BRICK, storyRole: 'castle' });
}

// Y-aligned (upright) brick with an explicit quaternion (tilted ramp gap fillers).
function createBrickYTiltQuat(x, y, z, quat) {
    const idx = brickInstY.count++;
    _iDummy.position.set(x, y, z);
    _iDummy.quaternion.copy(quat);
    _iDummy.updateMatrix();
    brickInstY.setMatrixAt(idx, _iDummy.matrix);
    brickInstY.instanceMatrix.needsUpdate = true;
    const body = new CANNON.Body({
        mass: 120,
        material: wallPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(BS.h / 2, WALL_BRICK_HALF_LEN, BS.d / 2)),
        allowSleep: true,
        sleepSpeedLimit: 0.6,
        sleepTimeLimit:  0.3,
        linearDamping:   0.30,
        angularDamping:  0.55,
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  WALL_MASK
    });
    body.position.set(x, y, z);
    body.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    body._storyRole = 'castle';
    world.addBody(body);
    body.sleep();
    bricks.push({ idx, isY: true, isTilt: true, body, ix: x, iy: y, iz: z, scored: false, grp: CGROUP_BRICK, storyRole: 'castle' });
}

function createBrickCube(x, y, z) {
    const idx = brickInstC.count++;
    _iDummy.position.set(x, y, z); _iDummy.quaternion.set(0,0,0,1); _iDummy.updateMatrix();
    brickInstC.setMatrixAt(idx, _iDummy.matrix);
    brickInstC.instanceMatrix.needsUpdate = true;
    const body = new CANNON.Body({
        mass: 95,
        material: wallPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(BS.h / 2, BS.h / 2, BS.h / 2)),
        allowSleep: true,
        sleepSpeedLimit: 0.6,
        sleepTimeLimit:  0.3,
        linearDamping:   0.30,
        angularDamping:  0.55,
        collisionFilterGroup: CGROUP_BRICK,
        // Gap-fill cubes should not force neighboring bridge bricks apart.
        collisionFilterMask:  (WALL_MASK ^ CGROUP_BRICK)
    });
    body.position.set(x, y, z);
    body._storyRole = 'castle';
    world.addBody(body);
    body.sleep();
    bricks.push({ idx, isCube: true, body, ix: x, iy: y, iz: z, scored: false, grp: CGROUP_BRICK, storyRole: 'castle' });
}

function createBrickCubeTiltQuat(x, y, z, quat) {
    const idx = brickInstC.count++;
    _iDummy.position.set(x, y, z);
    _iDummy.quaternion.copy(quat);
    _iDummy.updateMatrix();
    brickInstC.setMatrixAt(idx, _iDummy.matrix);
    brickInstC.instanceMatrix.needsUpdate = true;
    const body = new CANNON.Body({
        mass: 95,
        material: wallPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(BS.h / 2, BS.h / 2, BS.h / 2)),
        allowSleep: true,
        sleepSpeedLimit: 0.6,
        sleepTimeLimit:  0.3,
        linearDamping:   0.30,
        angularDamping:  0.55,
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  (WALL_MASK ^ CGROUP_BRICK)
    });
    body.position.set(x, y, z);
    body.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    body._storyRole = 'castle';
    world.addBody(body);
    body.sleep();
    bricks.push({ idx, isCube: true, isTilt: true, body, ix: x, iy: y, iz: z, scored: false, grp: CGROUP_BRICK, storyRole: 'castle' });
}

// Half-height slab brick (2.0 � 0.5 � 1.0, long axis along X): bearing course
// that fills half-module vertical gaps a full-height brick cannot.
function createBrickSlab(x, y, z) {
    const idx = brickInstH.count++;
    _iDummy.position.set(x, y, z); _iDummy.quaternion.set(0,0,0,1); _iDummy.updateMatrix();
    brickInstH.setMatrixAt(idx, _iDummy.matrix);
    brickInstH.instanceMatrix.needsUpdate = true;
    const body = new CANNON.Body({
        mass: 60,
        material: wallPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(WALL_BRICK_HALF_LEN, BS.h * 0.25, BS.d / 2)),
        allowSleep: true,
        sleepSpeedLimit: 0.6,
        sleepTimeLimit:  0.3,
        linearDamping:   0.30,
        angularDamping:  0.55,
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  WALL_MASK
    });
    body.position.set(x, y, z);
    body._storyRole = 'castle';
    world.addBody(body);
    body.sleep();
    bricks.push({ idx, isSlab: true, body, ix: x, iy: y, iz: z, scored: false, grp: CGROUP_BRICK, storyRole: 'castle' });
}

// Half-height slab rotated across Z: a 1.0 x 0.5 x 2.0 tread used by the
// bridge approaches so each metre of run rises by only half a metre.
function createBrickSlabZ(x, y, z) {
    const idx = brickInstH.count++;
    const quat = new CANNON.Quaternion();
    quat.setFromEuler(0, Math.PI * 0.5, 0);
    _iDummy.position.set(x, y, z);
    _iDummy.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    _iDummy.updateMatrix();
    brickInstH.setMatrixAt(idx, _iDummy.matrix);
    brickInstH.instanceMatrix.needsUpdate = true;
    const body = new CANNON.Body({
        mass: 60,
        material: wallPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(WALL_BRICK_HALF_LEN, BS.h * 0.25, BS.d / 2)),
        allowSleep: true,
        sleepSpeedLimit: 0.6,
        sleepTimeLimit:  0.3,
        linearDamping:   0.30,
        angularDamping:  0.55,
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  WALL_MASK
    });
    body.position.set(x, y, z);
    body.quaternion.copy(quat);
    body._storyRole = 'castle';
    world.addBody(body);
    body.sleep();
    bricks.push({ idx, isSlab: true, isZ: true, body, ix: x, iy: y, iz: z, scored: false, grp: CGROUP_BRICK, storyRole: 'castle' });
}

// Angled wedge brick � one voussoir of a tower ring. Placed at the ring
// centreline point with a Y-rotation of `angle`; the shared trapezoidal convex
// collider (towerWedgeShape) and instanced wedge mesh are oriented so local +Z
// points radially outward, so neighbours meet on flat shared faces with no
// overlap. Because there's no built-in penetration there's no stored spring
// energy � every tower starts stress-free and collapses identically, and the
// flat faces let bricks rest on each other with weight instead of clipping.
function createBrickAngledQuat(x, y, z, quat) {
    const idx = towerInst.count++;
    _iDummy.position.set(x, y, z);
    _iDummy.quaternion.copy(quat);
    _iDummy.updateMatrix();
    towerInst.setMatrixAt(idx, _iDummy.matrix);
    towerInst.instanceMatrix.needsUpdate = true;
    const body = new CANNON.Body({
        mass: 150,
        material: brickPhysMat,
        allowSleep: true,
        sleepSpeedLimit: 0.6,
        sleepTimeLimit:  0.3,
        linearDamping:   0.18,
        angularDamping:  0.42,
        collisionFilterGroup: CGROUP_TOWER,
        collisionFilterMask:  TOWER_MASK
    });
    body.addShape(towerWedgeShape);
    body.position.set(x, y, z);
    body.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    body._storyRole = 'castle';
    world.addBody(body);
    body.sleep();
    bricks.push({ idx, isZ: false, isWedge: true, body, ix: x, iy: y, iz: z, scored: false, grp: CGROUP_TOWER, storyRole: 'castle' });
}

function createBrickAngled(x, y, z, angle) {
    const q = new THREE.Quaternion();
    q.setFromEuler(new THREE.Euler(0, angle, 0));
    createBrickAngledQuat(x, y, z, q);
}

// === Castle build helpers ===
// Layout (metres):
//   Front outer face Z = CFZ = 27 (drawbridge hinge)
//   Back outer face  Z = CASTLE_BZ = 47
//   Left outer wall  X = -10,  Right outer wall X = 10  (20 m wide)
//   Hollow corner towers: TW=4 m ? TD=4 m outer, 1 brick thick all faces
//   Curtain walls between towers: 1 brick thick, 12 m wide
//   NO stagger ? all joints are gap/overlap free

const CFZ        = 54;
const CASTLE_XL  = -20;
const CASTLE_XR  =  20;
const CASTLE_BZ  = CFZ + 40;           // 94
const TW         =   8;                // tower footprint width  (X)
const TD         =   8;                // tower footprint depth  (Z)
const WALL_XL    = CASTLE_XL + TW - 3;  // -15: extended 3 m to reach tower face
const WALL_XR    = CASTLE_XR - TW + 3;  //  15: extended 3 m to reach tower face
const WALL_BRICKS = Math.round((WALL_XR - WALL_XL) / BS.w);

const WALL_ROWS  = 12;   // curtain wall height  (6.0 m)
const TOWER_ROWS = 18;   // tower height         (9.0 m)
const GATE_ROWS  =  8;   // gate opening rows    (4.0 m ? tall enough for the drawbridge)

// Side wall span: extended 3 m at each end to physically close gap with round towers
const SIDE_Z_START = CFZ       + TD - 3;   // 59: now reaches tower face
const SIDE_Z_END   = CASTLE_BZ - TD + 3;   // 89: now reaches tower face
const SIDE_BRICKS  = Math.round((SIDE_Z_END - SIDE_Z_START) / BS.w);

// Window grid-snap � the master alignment fix.
// A window is now a single 1-brick HOLE on an even row (4 & 8), capped by a
// 2-brick-wide static LINTEL on the odd row directly above (5 & 9). The wall
// runs a half-brick stagger, so the lintel row's bricks sit offset from the hole
// row's; a 2-brick lintel always lands on solid masonry either side of the hole
// regardless of that offset. We snap windows AND lintels to the EVEN-row brick
// grid (the hole's grid) so the cap is centred over its hole on every wall, and
// clear exactly the 2 lintel-row bricks the beam occupies ? no overlap (no
// stored spring energy) and nothing left partially supported (no startup
// collapse, no "pop" when woken).
const snapWinX = v => WALL_XL      + BS.w / 2 + Math.round((v - WALL_XL      - BS.w / 2) / BS.w) * BS.w;
const snapWinZ = v => SIDE_Z_START + BS.w / 2 + Math.round((v - SIDE_Z_START - BS.w / 2) / BS.w) * BS.w;
const WIN_HOLE_ROWS   = [4, 8];     // single-brick openings
const WIN_LINTEL_ROWS = [5, 9];     // 2-brick static cap directly above each hole
// Half-width to clear on a given wall row: 1 brick on a hole row, 2 bricks on a
// lintel row (or -1 if this row has no window).
const winClearHalf = r =>
    WIN_HOLE_ROWS.includes(r)   ? 0.5 :
    WIN_LINTEL_ROWS.includes(r) ? BS.w + 0.1 : -1;
// Build rows from centre outward so the solver index/order is mirror-symmetric
// about the wall midpoint. Left->right insertion gave one side consistently
// weaker under impact because GS constraints are solved in body order.
const centreOut = (arr, flipSign = false) => {
    const s = arr.slice().sort((a, b) => {
        const da = Math.abs(a), db = Math.abs(b);
        if (da !== db) return da - db;
        return a - b;
    });
    const out = [];
    for (let i = 0; i < s.length; ) {
        let j = i + 1;
        while (j < s.length && Math.abs(Math.abs(s[j]) - Math.abs(s[i])) < 1e-6) j++;
        if (j - i === 2 && Math.abs(s[i] + s[i + 1]) < 1e-6) {
            // Alternate +/- insertion order each row so neither side is always first.
            if (flipSign) { out.push(s[i], s[i + 1]); }
            else          { out.push(s[i + 1], s[i]); }
        } else {
            for (let k = i; k < j; k++) out.push(s[k]);
        }
        i = j;
    }
    return out;
};

const TOWER_R = TW / 2;   // outer radius = 2.0 m

// Tower centre positions (cx, cz) ? identical footprint to old square towers
const TOWER_CENTERS = [
    { cx: CASTLE_XL + TW / 2, cz: CFZ       + TD / 2 },   // front-left  (-8, 29)
    { cx: CASTLE_XR - TW / 2, cz: CFZ       + TD / 2 },   // front-right  (8, 29)
    { cx: CASTLE_XL + TW / 2, cz: CASTLE_BZ - TD / 2 },   // back-left   (-8, 45)
    { cx: CASTLE_XR - TW / 2, cz: CASTLE_BZ - TD / 2 },   // back-right   (8, 45)
];

// -- Circular tower: bricks placed tangentially around a ring --
// brickR = centre-of-wall radius; long (1 m) axis tangent to circle,
// short (0.5 m) axis radial.  Alternate rows stagger by half a brick angle.
// Places a SINGLE brick (position i of row r) so the four towers can be
// assembled fully interleaved brick-by-brick (see the assembly loop) � every
// tower then receives body indices spaced exactly 4 apart, so the Gauss-Seidel
// solver visits the four towers round-robin and converges them identically.
// Row-batch interleaving still gave each tower a contiguous block of indices,
// leaving the right-hand towers (built later in the foundation row) softer; the
// brick-level interleave removes that bias entirely.
const TOWER_BRICK_R   = TOWER_R - BS.d / 2;
const TOWER_N_BRICKS  = Math.round(2 * Math.PI * TOWER_BRICK_R / BS.w);
const TOWER_A_STEP    = (2 * Math.PI) / TOWER_N_BRICKS;

// -- Build the shared tower wedge collider + instanced visual --
// One trapezoidal prism (voussoir) sized so TOWER_N_BRICKS of them tile the ring
// edge-to-edge: adjacent wedges share an identical flat radial face (the right
// face of one is the left face of the next), so there is no overlap and no gap.
// Local axes: +Z radial-out, X tangential, Y up. The body is placed at the ring
// centreline (radius TOWER_BRICK_R) so these vertices are relative to that.
const TOWER_RI = TOWER_R - BS.d;         // inner face radius (3.0 m)
const TOWER_RO = TOWER_R;                // outer face radius (4.0 m)
const _wHalf   = TOWER_A_STEP / 2;
const _wIhx = TOWER_RI * Math.sin(_wHalf), _wIhz = TOWER_RI * Math.cos(_wHalf) - TOWER_BRICK_R;
const _wOhx = TOWER_RO * Math.sin(_wHalf), _wOhz = TOWER_RO * Math.cos(_wHalf) - TOWER_BRICK_R;
const _wHy  = BS.h / 2;
// 8 corners: 0-3 bottom (inner-L, inner-R, outer-R, outer-L); 4-7 the same on top.
const TOWER_WEDGE_VERTS = [
    [-_wIhx, -_wHy, _wIhz], [ _wIhx, -_wHy, _wIhz], [ _wOhx, -_wHy, _wOhz], [-_wOhx, -_wHy, _wOhz],
    [-_wIhx,  _wHy, _wIhz], [ _wIhx,  _wHy, _wIhz], [ _wOhx,  _wHy, _wOhz], [-_wOhx,  _wHy, _wOhz],
];
// Faces as CCW index loops with OUTWARD normals (cannon-es convention).
const TOWER_WEDGE_FACES = [
    [0, 1, 2, 3], // bottom   (-Y)
    [4, 7, 6, 5], // top      (+Y)
    [0, 4, 5, 1], // inner    (-Z)
    [3, 2, 6, 7], // outer    (+Z)
    [1, 5, 6, 2], // +tangent radial side
    [0, 3, 7, 4], // -tangent radial side
];
towerWedgeShape = new CANNON.ConvexPolyhedron({
    vertices: TOWER_WEDGE_VERTS.map(v => new CANNON.Vec3(v[0], v[1], v[2])),
    faces: TOWER_WEDGE_FACES,
});
towerInst = new THREE.InstancedMesh(
    makeWedgeGeometry(TOWER_WEDGE_VERTS, TOWER_WEDGE_FACES), wedgeStoneMat, MAX_TOWER_BRICKS);
towerInst.castShadow = true; towerInst.receiveShadow = true;
towerInst.frustumCulled = false;
towerInst.count = 0;
scene.add(towerInst);

function buildRoundTowerBrick(cx, cz, r, i) {
    const y    = BS.h / 2 + r * BS.h;
    const aOff = (r % 2) * (TOWER_A_STEP / 2);
    const a    = aOff + i * TOWER_A_STEP;
    createBrickAngled(
        cx + TOWER_BRICK_R * Math.sin(a),
        y,
        cz + TOWER_BRICK_R * Math.cos(a),
        a
    );
}

// -- Round battlement ring (every other brick = merlon / gap pattern) --
function addRoundBattlements(cx, cz, R) {
    const brickR  = R - BS.d / 2;
    const nBricks = Math.round(2 * Math.PI * brickR / BS.w);
    const aStep   = (2 * Math.PI) / nBricks;
    const y       = BS.h / 2 + TOWER_ROWS * BS.h;
    for (let i = 0; i < nBricks; i += 2) {
        const a = i * aStep;
        createBrickAngled(
            cx + brickR * Math.sin(a),
            y,
            cz + brickR * Math.cos(a),
            a
        );
    }
}

// -- Curtain wall: X-aligned WITH stagger --
// Window centres are on the EVEN-row brick grid (even integers) and symmetric
// about x=0. They were [-9,0,9], but snapWinX rounds half-up, so -9 snapped to
// -8 while +9 snapped to +10 � that thinned the RIGHT pier to 2 bricks vs the
// left's 3, which is exactly why the right half collapsed in one shot while the
// left felt indestructible. Grid-aligned symmetric centres snap to themselves.
const CURTAIN_WIN_X = [-8.0, 0.0, 8.0]; // 3 slits per curtain wall, symmetric piers
function buildCurtainWallX(zCenter, rows, withGate) {
    for (let r = 0; r < rows; r++) {
        const y    = BS.h / 2 + r * BS.h;
        const xOff = (r % 2) * (BS.w / 2);
        const row = [];
        for (let i = 0; i < WALL_BRICKS; i++) {
            const cx = WALL_XL + xOff + BS.w / 2 + i * BS.w;
            // Symmetric edge clamp: even rows span -14..14, odd rows -13..13. The
            // raw odd row would run -13..15, poking one extra brick out the RIGHT
            // end (into the tower) with no mirror on the left � an asymmetry that
            // made the right half weaker. Dropping cx just past WALL_XR removes it.
            if (cx < WALL_XL || cx > WALL_XR - 0.5) continue;
            row.push(cx);
        }
        for (const cx of centreOut(row, (r & 1) === 1)) {
            if (withGate && r < GATE_ROWS && Math.abs(cx) < 3.01) continue;
            // Arrow-slit windows: a 1-brick hole (rows 4 & 8) capped by a 2-brick
            // static lintel on the row above (rows 5 & 9). winClearHalf returns
            // how much of this row to clear; the lintel beam is placed separately.
            const clear = winClearHalf(r);
            if (clear > 0) {
                const upper = (r >= 8);
                let isWindow = false;
                for (const wx of CURTAIN_WIN_X) {
                    // Gate wall: the centre column (x�0) is the gate � no upper slit
                    // there (its bricks above would be left unsupported).
                    if (upper && withGate && Math.abs(wx) < 3.0) continue;
                    if (Math.abs(cx - snapWinX(wx)) < clear) { isWindow = true; break; }
                }
                if (isWindow) continue;
            }
            createBrick(cx, y, zCenter);
        }
        // Odd gate rows: stagger leaves a 1m slot at each gate edge � fill with
        // Z-brick. SKIP the lintel row (GATE_ROWS-1): the static 8m gate lintel
        // already spans that whole row, so a fill brick there would overlap it
        // and store the spring tension that blew the wall apart on wake.
        if (withGate && r < GATE_ROWS && (r % 2) === 1 && r !== GATE_ROWS - 1) {
            createBrickZ(-3.5, y, zCenter);
            createBrickZ( 3.5, y, zCenter);
        }
    }
}

function addCurtainWallBattlements(zCenter) {
    const y    = BS.h / 2 + WALL_ROWS * BS.h;
    const xOff = (WALL_ROWS % 2) * (BS.w / 2);
    for (let i = 0; i < WALL_BRICKS; i += 2) {
        const cx = WALL_XL + xOff + BS.w / 2 + i * BS.w;
        if (cx < WALL_XL || cx > WALL_XR) continue;
        createBrick(cx, y, zCenter);
    }
}

// -- Side wall: Z-aligned WITH stagger --
// Window centres on the even-row grid, symmetric about the wall centre (z=74).
const SIDE_WIN_Z = [68, 74, 80]; // 3 slits per side, symmetric
function buildSideWallZ(xOuter, rows) {
    const xc = xOuter + (xOuter < 0 ? BS.d / 2 : -BS.d / 2);
    for (let r = 0; r < rows; r++) {
        const y    = BS.h / 2 + r * BS.h;
        const zOff = (r % 2) * (BS.w / 2);
        const row = [];
        for (let d = 0; d < SIDE_BRICKS; d++) {
            const zc = SIDE_Z_START + zOff + BS.w / 2 + d * BS.w;
            // Symmetric edge clamp (see curtain wall) � drop the odd-row overhang.
            if (zc < SIDE_Z_START || zc > SIDE_Z_END - 0.5) continue;
            row.push(zc);
        }
        for (const zc of centreOut(row.map(v => v - (SIDE_Z_START + SIDE_Z_END) / 2), (r & 1) === 1)
            .map(v => v + (SIDE_Z_START + SIDE_Z_END) / 2)) {
            // Arrow-slit windows: 1-brick hole (rows 4 & 8) capped by a 2-brick
            // static lintel on the row above (rows 5 & 9).
            const clear = winClearHalf(r);
            if (clear > 0) {
                let isWindow = false;
                for (const wz of SIDE_WIN_Z) { if (Math.abs(zc - snapWinZ(wz)) < clear) { isWindow = true; break; } }
                if (isWindow) continue;
            }
            createBrickZ(xc, y, zc);
        }
    }
}

function addSideWallBattlements(xOuter) {
    const xc   = xOuter + (xOuter < 0 ? BS.d / 2 : -BS.d / 2);
    const y    = BS.h / 2 + WALL_ROWS * BS.h;
    const zOff = (WALL_ROWS % 2) * (BS.w / 2);
    for (let d = 0; d < SIDE_BRICKS; d += 2) {
        const zc = SIDE_Z_START + zOff + BS.w / 2 + d * BS.w;
        if (zc < SIDE_Z_START || zc > SIDE_Z_END) continue;
        createBrickZ(xc, y, zc);
    }
}

// -- Assemble the castle --
// Circular corner towers � built fully INTERLEAVED brick-by-brick across all
// four towers. For every (row, brick-index) we lay that one brick on tower 0,
// then tower 1, 2, 3. Each tower's bodies therefore land on indices spaced 4
// apart throughout the whole structure, so the solver gives all four identical
// treatment � no tower is systematically built/solved first, which is what made
// the right-hand pair crumble faster than the left.
for (let r = 0; r < TOWER_ROWS; r++) {
    for (let i = 0; i < TOWER_N_BRICKS; i++) {
        for (const { cx, cz } of TOWER_CENTERS) {
            buildRoundTowerBrick(cx, cz, r, i);
        }
    }
}
for (const { cx, cz } of TOWER_CENTERS) {
    addRoundBattlements(cx, cz, TOWER_R);
}

buildCurtainWallX(CFZ + BS.d / 2,       WALL_ROWS, true);   // front (gate)
buildCurtainWallX(CASTLE_BZ - BS.d / 2, WALL_ROWS, false);  // rear
addCurtainWallBattlements(CFZ + BS.d / 2);
addCurtainWallBattlements(CASTLE_BZ - BS.d / 2);

// Gate lintel: static (mass=0) stone beam above the gate hole.
// It sits at exactly row GATE_ROWS-1 height so the support check finds it
// beneath the row GATE_ROWS wall bricks that span the opening.
// Being in the bricks array (scored:true, sleepState=0) it is found as a
// support but is never itself woken or knocked free.

// Lintels are a darker, harder stone (granite vs the sandstone blocks) and sit
// slightly PROUD of the wall face. The proud offset both reads as deliberate
// architectural detail AND ends the z-fighting that appeared when the camera
// moved: a wide lintel's end sections share volume with the blocks beside the
// opening, so their coplanar faces flickered. Offsetting the mesh outward gives
// the lintel face a clear win. Only the visible mesh moves � the physics body
// stays in the wall plane so it still supports the bricks above.
const LINTEL_PROUD  = 0.09;
const _CASTLE_CZ    = (CFZ + CASTLE_BZ) / 2;
const lintelMat = new THREE.MeshStandardMaterial({
    map: stoneColorMap, bumpMap: stoneBumpMap, bumpScale: 0.16,
    roughness: 0.96, metalness: 0.0, color: 0x5f5a52
});

(function addGateLintel() {
    const lw = 8.0, lh = BS.h, ld = BS.d;   // lw widened to cover 6m gate + 1m each side
    const lx = 0, ly = BS.h / 2 + (GATE_ROWS - 1) * BS.h, lz = CFZ + BS.d / 2;
    // Use a standalone mesh (not instanced) since it?s a unique static piece
    const lMesh = new THREE.Mesh(
        new THREE.BoxGeometry(lw, lh, ld),
        lintelMat
    );
    lMesh.position.set(lx, ly, lz - LINTEL_PROUD);   // proud of the front face
    lMesh.castShadow = true; lMesh.receiveShadow = true;
    scene.add(lMesh);
    const body = new CANNON.Body({
        mass: 0,
        material: wallPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(lw / 2, lh / 2, ld / 2)),
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  WALL_MASK
    });
    body.position.set(lx, ly, lz);
    body._storyRole = 'castle';
    world.addBody(body);
    // idx:-1 flags this as not-instanced; isZ irrelevant; scored:true skips scoring
    bricks.push({ idx: -1, isZ: false, body, ix: lx, iy: ly, iz: lz, scored: true,
                  isLintel: true, mesh: lMesh, spanAxis: 'x', halfSpan: lw / 2, dropped: false,
                  storyRole: 'castle' });
})();

// -- Window lintels --
// Windows are gaps at rows 4-5 (and 8-9). The bricks directly above the opening
// have no support, so a static lintel beam fills the TOP row of each slit and
// holds the courses above.
//
// The slit is exactly one brick wide, so the lintel is one brick wide too. It is
// also SNAPPED onto its own row's brick grid: the wall courses stagger by half a
// brick on alternate rows, so the nominal window centre (wx/wz) rarely lines up
// with the actual brick that got removed. Snapping the lintel to that brick's
// grid slot makes it replace the removed stone exactly � no end of the beam
// pokes into (and stores spring tension against) a neighbouring block, which was
// the intersecting-lintel glitch on the side walls.
function addWindowLintel(x, y, z, isZ) {
    // Snap onto the hole grid through the SAME function the window carve uses, so
    // the 2-brick beam sits centred over its 1-brick hole.
    if (isZ) z = snapWinZ(z);
    else      x = snapWinX(x);

    const span = 2 * BS.w;          // 2 bricks wide � always lands on solid masonry
    const lw = isZ ? BS.d : span;   // X dimension
    const lh = BS.h;
    const ld = isZ ? span : BS.d;   // Z dimension
    const lMesh = new THREE.Mesh(
        new THREE.BoxGeometry(lw, lh, ld),
        lintelMat
    );
    // Push the mesh proud of the wall face along its outward normal so its face
    // reads as a distinct capstone and never z-fights the wall plane.
    const ox = isZ ? Math.sign(x) * LINTEL_PROUD : 0;
    const oz = isZ ? 0 : Math.sign(z - _CASTLE_CZ) * LINTEL_PROUD;
    lMesh.position.set(x + ox, y, z + oz);
    lMesh.castShadow = true; lMesh.receiveShadow = true;
    scene.add(lMesh);
    // Collider trimmed a hair along the SPAN axis so the static beam rests flush
    // beside its neighbour bricks without an interpenetration that stores energy.
    const halfSpan = span / 2 - 0.05;
    const shape = isZ
        ? new CANNON.Box(new CANNON.Vec3(BS.d / 2, lh / 2, halfSpan))
        : new CANNON.Box(new CANNON.Vec3(halfSpan, lh / 2, BS.d / 2));
    const body = new CANNON.Body({
        mass: 0,
        material: wallPhysMat,
        shape,
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  WALL_MASK
    });
    body.position.set(x, y, z);
    body._storyRole = 'castle';
    world.addBody(body);
    bricks.push({ idx: -1, isZ: false, body, ix: x, iy: y, iz: z, scored: true,
                  isLintel: true, mesh: lMesh, spanAxis: isZ ? 'z' : 'x',
                  halfSpan: span / 2, dropped: false, storyRole: 'castle' });
}

// Lintel sits at row-5 position (top of the 2-row window gap)
const WIN_LINTEL_Y      = BS.h / 2 + 5 * BS.h;   // lintel row 5, capping the row-4 hole
const WIN_LINTEL_HIGH_Y = BS.h / 2 + 9 * BS.h;   // lintel row 9, capping the row-8 hole

// Curtain walls (front & back) � lower + upper slits
// Skip x=0 window lintels for the FRONT wall � x=0 is inside the gate hole
for (const wx of CURTAIN_WIN_X) {
    const inGate = Math.abs(wx) < 3.0;
    if (!inGate) addWindowLintel(wx, WIN_LINTEL_Y,      CFZ + BS.d / 2,       false);
    addWindowLintel(wx, WIN_LINTEL_Y,      CASTLE_BZ - BS.d / 2, false);
    if (!inGate) addWindowLintel(wx, WIN_LINTEL_HIGH_Y, CFZ + BS.d / 2,       false);
    addWindowLintel(wx, WIN_LINTEL_HIGH_Y, CASTLE_BZ - BS.d / 2, false);
}

// Side walls (left & right) � lower + upper slits
for (const wz of SIDE_WIN_Z) {
    addWindowLintel(CASTLE_XL + BS.d / 2, WIN_LINTEL_Y,      wz, true);
    addWindowLintel(CASTLE_XR - BS.d / 2, WIN_LINTEL_Y,      wz, true);
    addWindowLintel(CASTLE_XL + BS.d / 2, WIN_LINTEL_HIGH_Y, wz, true);
    addWindowLintel(CASTLE_XR - BS.d / 2, WIN_LINTEL_HIGH_Y, wz, true);
}
buildSideWallZ(CASTLE_XL, WALL_ROWS);
buildSideWallZ(CASTLE_XR, WALL_ROWS);
addSideWallBattlements(CASTLE_XL);
addSideWallBattlements(CASTLE_XR);

// === Corner gap fills ===
// Corner gap fills removed � walls now extended 3m each end to physically reach tower faces.

// === Destructible wooden house ===
// Built from planks (same physics as bricks but wood texture, smaller).
// Placed to the right of the castle at roughly (50, 0, 60).

function makeWoodPlankTexture() {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#7a4f28'; ctx.fillRect(0, 0, 256, 128);
    // Plank lines
    for (let y = 0; y < 128; y += 22) {
        ctx.fillStyle = '#5c3317'; ctx.fillRect(0, y, 256, 2);
    }
    // Vertical grain lines
    for (let i = 0; i < 40; i++) {
        const x = Math.random() * 256;
        ctx.strokeStyle = `rgba(40,20,5,${0.1 + Math.random() * 0.15})`;
        ctx.lineWidth = Math.random() * 1.5 + 0.3;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + (Math.random()-0.5)*10, 128); ctx.stroke();
    }
    // Knots
    for (let i = 0; i < 5; i++) {
        const kx = Math.random()*256, ky = Math.random()*128;
        ctx.beginPath(); ctx.ellipse(kx, ky, 4, 3, Math.random()*Math.PI, 0, Math.PI*2);
        ctx.fillStyle = 'rgba(40,18,5,0.55)'; ctx.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
}

const woodPlankTex = makeWoodPlankTexture();
const woodPlankMat = new THREE.MeshStandardMaterial({
    map: woodPlankTex, roughness: 0.88, metalness: 0.0
});

// === Castle interior floor � stone courtyard with a raised wooden great-hall ===
// Decorative, static. A stone-flagged base covers the whole interior footprint,
// with a planked wooden floor laid over the rear half (the keep / great hall).
(function addCastleFloor() {
    const x0 = WALL_XL, x1 = WALL_XR;            // interior X span (between side walls)
    const z0 = CFZ + BS.d, z1 = CASTLE_BZ - BS.d; // interior Z span (inside front/back)
    const cxC = (x0 + x1) / 2, czC = (z0 + z1) / 2;
    const wX = x1 - x0, wZ = z1 - z0;

    // Stone flagstones (tinted/greyer copy of the block stone, tiled).
    const flagTex = stoneColorMap.clone();
    flagTex.needsUpdate = true;
    flagTex.repeat.set(wX / 2, wZ / 2);
    const stoneFloorMat = new THREE.MeshStandardMaterial({
        map: flagTex, bumpMap: stoneBumpMap, bumpScale: 0.12,
        roughness: 0.97, metalness: 0.0, color: 0x9b958a
    });
    // Stone floor as four boxes around the King's Bunker stairwell mouth, so
    // the visual hole exactly matches the collider opening (top flush, y=0.1).
    const shaftRects = [
        [x0, BUNKER.OPEN_X1, z0, z1],                                  // west of mouth
        [BUNKER.OPEN_X2, x1, z0, z1],                                  // east of mouth
        [BUNKER.OPEN_X1, BUNKER.OPEN_X2, z0, BUNKER.OPEN_Z1],          // south strip
        [BUNKER.OPEN_X1, BUNKER.OPEN_X2, BUNKER.OPEN_Z2, z1],          // north strip
    ];
    for (const [fx0, fx1, fz0, fz1] of shaftRects) {
        const fw = fx1 - fx0, fd = fz1 - fz0;
        if (fw <= 0 || fd <= 0) continue;
        const piece = new THREE.Mesh(new THREE.BoxGeometry(fw, 0.2, fd), stoneFloorMat);
        piece.position.set((fx0 + fx1) / 2, 0.0, (fz0 + fz1) / 2);
        piece.receiveShadow = true;
        scene.add(piece);
        castleSceneMeshes.push(piece);
    }

    // Wooden great-hall floor over the rear half, raised one plank thickness —
    // built as boxes around the King's Bunker stairwell mouth so the hatch sits
    // cleanly in the wood.
    const woodTex = woodPlankTex.clone();
    woodTex.needsUpdate = true;
    woodTex.repeat.set(wX / 2.4, (wZ / 2) / 2.4);
    const hallMat = new THREE.MeshStandardMaterial({
        map: woodTex, roughness: 0.9, metalness: 0.0, color: 0xb89066
    });
    const hallZ0 = czC, hallZ1 = z1 - 0.5;    // rear half (0.5m stone margin at the wall)
    const hallX0 = x0 + 0.5, hallX1 = x1 - 0.5;
    const hallRects = [
        [hallX0, BUNKER.OPEN_X1, hallZ0, hallZ1],
        [BUNKER.OPEN_X2, hallX1, hallZ0, hallZ1],
        [BUNKER.OPEN_X1, BUNKER.OPEN_X2, hallZ0, BUNKER.OPEN_Z1],
        [BUNKER.OPEN_X1, BUNKER.OPEN_X2, BUNKER.OPEN_Z2, hallZ1],
    ];
    for (const [hx0, hx1, hz0, hz1] of hallRects) {
        const hw = hx1 - hx0, hd = hz1 - hz0;
        if (hw <= 0 || hd <= 0) continue;
        const piece = new THREE.Mesh(new THREE.BoxGeometry(hw, 0.24, hd), hallMat);
        piece.position.set((hx0 + hx1) / 2, 0.12, (hz0 + hz1) / 2);
        piece.receiveShadow = true; piece.castShadow = true;
        scene.add(piece);
        castleSceneMeshes.push(piece);
    }
    // Dark wooden rim framing the stairwell mouth (trim, no gameplay role)
    const rimMat = new THREE.MeshStandardMaterial({ map: woodPlankTex, roughness: 0.8, color: 0x6b4a28 });
    const rimY = 0.26;
    for (const [rx, rz, rw, rd] of [
        [BUNKER.OPEN_X1 - 0.15, BUNKER.TRAPDOOR_Z, 0.3, BUNKER.OPEN_Z2 - BUNKER.OPEN_Z1 + 0.6],
        [BUNKER.OPEN_X2 + 0.15, BUNKER.TRAPDOOR_Z, 0.3, BUNKER.OPEN_Z2 - BUNKER.OPEN_Z1 + 0.6],
        [BUNKER.TRAPDOOR_X, BUNKER.OPEN_Z1 - 0.15, BUNKER.OPEN_X2 - BUNKER.OPEN_X1 + 0.6, 0.3],
        [BUNKER.TRAPDOOR_X, BUNKER.OPEN_Z2 + 0.15, BUNKER.OPEN_X2 - BUNKER.OPEN_X1 + 0.6, 0.3],
    ]) {
        const rim = new THREE.Mesh(new THREE.BoxGeometry(rw, 0.1, rd), rimMat);
        rim.position.set(rx, rimY, rz);
        scene.add(rim);
        castleSceneMeshes.push(rim);
    }
})();

// === The King's Bunker: stairwell descent, tunnel, grand chamber ===
// Indestructible (visual meshes only — physics is the static collider set in
// buildGroundColliders). Torch PointLights are created ONCE here at startup and
// only ever intensity-flickered: adding/removing lights at runtime recompiles
// every material's shader and would freeze the game (see note near the sun).
const bunkerTorches = [];         // { light, flame, baseI, phase }
(function buildBunkerRoom() {
    const B = BUNKER;
    const wallTex = stoneColorMap.clone();
    wallTex.needsUpdate = true;
    wallTex.repeat.set(4, 1.6);
    const bunkerStoneMat = new THREE.MeshStandardMaterial({
        map: wallTex, bumpMap: stoneBumpMap, bumpScale: 0.18,
        roughness: 0.98, metalness: 0.0, color: 0x4a4640,
    });
    const bunkerFloorMat = new THREE.MeshStandardMaterial({
        map: wallTex, bumpMap: stoneBumpMap, bumpScale: 0.14,
        roughness: 0.99, metalness: 0.0, color: 0x36322d,
    });
    const hash2 = (a, b) => {
        const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
        return s - Math.floor(s);
    };
    const lumpPanel = (w, h) => {
        // Non-indexed so it merges with the (non-indexed) dodecahedron studs;
        // position-hashed jitter keeps shared vertices crack-free.
        const g = new THREE.PlaneGeometry(w, h, 18, 7).toNonIndexed();
        const pos = g.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            const px = pos.getX(i), py = pos.getY(i);
            const edge = Math.min(w / 2 - Math.abs(px), h / 2 - Math.abs(py));
            const amp = Math.min(0.22, Math.max(0, edge));
            pos.setZ(i, (hash2(px, py) - 0.35) * amp);
        }
        g.computeVertexNormals();
        return g;
    };
    const wallGeos = [];
    const place = (g, x, y, z, rotY) => {
        g.rotateY(rotY);
        g.translate(x, y, z);
        wallGeos.push(g);
    };
    const chamberH = 0 - (B.FLOOR_Y - 0.2), chamberCY = (B.FLOOR_Y - 0.2) / 2;
    const chLen = B.Z2 - B.TUNNEL_Z2, chCZ = (B.TUNNEL_Z2 + B.Z2) / 2;
    place(lumpPanel(chLen, chamberH), B.X1, chamberCY, chCZ, Math.PI / 2);          // west
    place(lumpPanel(chLen, chamberH), B.X2, chamberCY, chCZ, -Math.PI / 2);         // east
    place(lumpPanel(B.X2 - B.X1, chamberH), (B.X1 + B.X2) / 2, chamberCY, B.Z2, Math.PI); // far (north)
    // tunnel lining (both ramps) + chamber south face beside the tunnel — all
    // full chamber depth. The south face uses rotY 0: its +z normal faces the
    // chamber (single-sided planes are invisible from behind!).
    const tunLen = B.TUNNEL_Z2 - B.OPEN_Z1, tunCZ = (B.OPEN_Z1 + B.TUNNEL_Z2) / 2;
    place(lumpPanel(tunLen, chamberH), B.OPEN_X1, chamberCY, tunCZ, Math.PI / 2);
    place(lumpPanel(tunLen, chamberH), B.OPEN_X2, chamberCY, tunCZ, -Math.PI / 2);
    place(lumpPanel(B.OPEN_X1 - B.X1, chamberH), (B.X1 + B.OPEN_X1) / 2, chamberCY, B.TUNNEL_Z2, 0);
    place(lumpPanel(B.X2 - B.OPEN_X2, chamberH), (B.OPEN_X2 + B.X2) / 2, chamberCY, B.TUNNEL_Z2, 0);
    // Shaft south face (below the courtyard edge) + the band above the tunnel
    // mouth: without these you're looking through the (invisible) island slab
    // into the white skybox from inside the shaft.
    place(lumpPanel(B.OPEN_X2 - B.OPEN_X1, chamberH), B.TRAPDOOR_X, chamberCY, B.OPEN_Z1, 0);
    {
        const bandH = (0.1 - B.CEIL_Y), bandCY = (0.1 + B.CEIL_Y) / 2;
        place(lumpPanel(B.OPEN_X2 - B.OPEN_X1, bandH), B.TRAPDOOR_X, bandCY, B.OPEN_Z2, Math.PI);
    }
    // stud boulders pressed against the chamber walls
    for (let i = 0; i < 26; i++) {
        const sz = B.TUNNEL_Z2 + 0.5 + hash2(i, 2) * (B.Z2 - B.TUNNEL_Z2 - 1);
        const sy = B.FLOOR_Y + 0.4 + hash2(i, 3) * (chamberH - 1.4);
        const r = 0.10 + hash2(i, 4) * 0.18;
        const g = new THREE.DodecahedronGeometry(r, 0);
        g.scale(1, 0.55, 1);
        const left = hash2(i, 5) < 0.5;
        g.translate(left ? B.X1 + 0.05 : B.X2 - 0.05, sy, sz);
        wallGeos.push(g);
    }
    const wallsMesh = new THREE.Mesh(mergeGeometries(wallGeos), bunkerStoneMat);
    wallsMesh.receiveShadow = true;
    scene.add(wallsMesh);
    castleSceneMeshes.push(wallsMesh);

    // Floors: sloped meshes matching the two physics ramps + chamber slab
    const rampMesh = (x1, x2, z1, z2, yAtZ1, yAtZ2) => {
        const w = x2 - x1, run = z2 - z1, rise = yAtZ2 - yAtZ1;
        const len = Math.hypot(run, rise);
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, len), bunkerFloorMat);
        m.position.set((x1 + x2) / 2, (yAtZ1 + yAtZ2) / 2 - 0.05, (z1 + z2) / 2);
        m.rotation.x = -Math.atan2(rise, run);
        m.receiveShadow = true;
        scene.add(m);
        castleSceneMeshes.push(m);
    };
    rampMesh(B.OPEN_X1, B.OPEN_X2, B.OPEN_Z2, B.TUNNEL_Z2, B.RAMP1_BOT, B.FLOOR_Y);
    const landing = new THREE.Mesh(new THREE.BoxGeometry(B.OPEN_X2 - B.OPEN_X1, 0.2, B.OPEN_Z2 - B.OPEN_Z1), bunkerFloorMat);
    landing.position.set(B.TRAPDOOR_X, B.RAMP1_BOT - 0.1, B.TRAPDOOR_Z);
    landing.receiveShadow = true;
    scene.add(landing);
    castleSceneMeshes.push(landing);
    const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(B.X2 - B.X1, 0.2, B.Z2 - B.TUNNEL_Z2), bunkerFloorMat);
    floorMesh.position.set((B.X1 + B.X2) / 2, B.FLOOR_Y - 0.1, (B.TUNNEL_Z2 + B.Z2) / 2);
    floorMesh.receiveShadow = true;
    scene.add(floorMesh);
    castleSceneMeshes.push(floorMesh);

    // Ceiling ring (mirrors the collider hole around the stairwell mouth)
    const ceilRects = [
        [B.X1, B.OPEN_X1, B.OPEN_Z1, B.Z2],
        [B.OPEN_X2, B.X2, B.OPEN_Z1, B.Z2],
        [B.OPEN_X1, B.OPEN_X2, B.OPEN_Z2, B.Z2],
    ];
    for (const [cx0, cx1, cz0, cz1] of ceilRects) {
        const cw = cx1 - cx0, cd = cz1 - cz0;
        const piece = new THREE.Mesh(new THREE.BoxGeometry(cw, 0.12, cd), bunkerFloorMat);
        piece.position.set((cx0 + cx1) / 2, B.CEIL_Y + 0.06, (cz0 + cz1) / 2);
        scene.add(piece);
        castleSceneMeshes.push(piece);
    }

    // Mine-shaft support frames down the tunnel (posts + lintels, dark wood)
    const supportMat = new THREE.MeshStandardMaterial({ color: 0x3a2a18, roughness: 0.9 });
    for (const sz of [77, 80, 83, 85]) {
        const fy = bunkerFloorYAt(sz);
        const postH = (B.CEIL_Y + 0.05) - fy;
        for (const px of [B.OPEN_X1 + 0.2, B.OPEN_X2 - 0.2]) {
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, postH, 0.18), supportMat);
            post.position.set(px, fy + postH / 2, sz);
            scene.add(post);
            castleSceneMeshes.push(post);
        }
        const lintel = new THREE.Mesh(new THREE.BoxGeometry(B.OPEN_X2 - B.OPEN_X1 - 0.1, 0.2, 0.2), supportMat);
        lintel.position.set(B.TRAPDOOR_X, B.CEIL_Y - 0.05, sz);
        scene.add(lintel);
        castleSceneMeshes.push(lintel);
    }

    // Throne dais (the king floats off it when the flood comes)
    const dais = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.5, 3.2), bunkerStoneMat);
    dais.position.set(B.THRONE_X, B.FLOOR_Y + 0.25, B.THRONE_Z);
    dais.receiveShadow = true;
    scene.add(dais);
    castleSceneMeshes.push(dais);

    // The ladder: VERTICAL, flat against the shaft's south wall directly under
    // the hatch — the only way in and out (visual; the E-key climb is the
    // mechanism). Tops out just below the closed door so it never clips it.
    {
        const ladderMat = new THREE.MeshStandardMaterial({ color: 0x5a4022, roughness: 0.85 });
        const anchorMat = new THREE.MeshStandardMaterial({ color: 0x33271a, roughness: 0.9 });
        const topY = 0.20, botY = B.RAMP1_BOT;
        const len = topY - botY;
        const geos = [];
        for (const rx of [-0.26, 0.26]) {
            const g = new THREE.BoxGeometry(0.07, len, 0.07);
            g.translate(rx, botY + len / 2, 0);
            geos.push(g);
        }
        const rungCount = Math.floor(len / 0.36);
        for (let i = 0; i < rungCount; i++) {
            const g = new THREE.CylinderGeometry(0.025, 0.025, 0.52, 8);
            g.rotateZ(Math.PI / 2);
            g.translate(0, botY + 0.24 + i * 0.36, 0);
            geos.push(g);
        }
        const ladder = new THREE.Mesh(mergeGeometries(geos), ladderMat);
        ladder.position.set(B.TRAPDOOR_X, 0, B.LADDER_Z);
        scene.add(ladder);
        castleSceneMeshes.push(ladder);
        // Anchor brackets tying the rails back to the stone wall.
        const standoff = B.LADDER_Z - B.OPEN_Z1;
        for (const ay of [topY - 0.35, botY + len * 0.5, botY + 0.45]) {
            for (const ax of [-0.26, 0.26]) {
                const anchor = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, standoff), anchorMat);
                anchor.position.set(ax, ay, B.OPEN_Z1 + standoff / 2);
                scene.add(anchor);
                castleSceneMeshes.push(anchor);
            }
        }
    }

    // Wall torches: emissive-look flame cones + a fixed pool of point lights.
    const torchSpots = [
        { x: B.OPEN_X2 - 0.28, y: -2.3, z: 78.5, nx: -1, nz: 0 },     // stairwell east wall
        { x: B.X1 + 0.28, y: -4.4, z: 88, nx: 1, nz: 0 },             // chamber west (by the throne)
        { x: 8, y: -4.4, z: B.Z2 - 0.28, nx: 0, nz: -1 },             // chamber north wall
    ];
    const torchCount = isMobileProfile ? 2 : 3;
    const bracketMat = new THREE.MeshStandardMaterial({ color: 0x2b2118, roughness: 0.9 });
    const flameGeo = new THREE.ConeGeometry(0.07, 0.24, 8);
    for (let i = 0; i < torchCount; i++) {
        const s = torchSpots[i];
        const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.2, 0.07), bracketMat);
        bracket.position.set(s.x, s.y - 0.14, s.z);
        scene.add(bracket);
        castleSceneMeshes.push(bracket);
        const flame = new THREE.Mesh(flameGeo, new THREE.MeshBasicMaterial({ color: 0xffa028 }));
        flame.position.set(s.x, s.y, s.z);
        scene.add(flame);
        castleSceneMeshes.push(flame);
        const light = new THREE.PointLight(0xff7733, 1.1, 14, 2);
        light.castShadow = false;
        light.position.set(s.x + s.nx * 0.35, s.y + 0.1, s.z + s.nz * 0.35);
        scene.add(light);
        bunkerTorches.push({ light, flame, baseI: 1.1, phase: i * 2.1 });
    }

    // Flood water: hidden inside the chamber floor until the switch is pulled;
    // the flood is driven by lerping bunkerWp.baseY (level surface is correct
    // over the sloped descent — it pools at the throne end first).
    bunkerWp = addWaterPlane((B.X1 + B.X2) / 2, (B.OPEN_Z1 + B.Z2) / 2, B.X2 - B.X1 - 0.4, B.Z2 - B.OPEN_Z1 - 0.4, 'castle', B.FLOOR_Y - 0.15);
    // The stock underlay is dark-on-dark in the torch-lit chamber — swap in a
    // flat UNLIT water blue that always reads, even in pitch dark.
    if (bunkerWp && bunkerWp.underlay) {
        bunkerWp.underlay.material = new THREE.MeshBasicMaterial({
            color: 0x2a7fb8, transparent: true, opacity: 0.6, depthWrite: false,
        });
    }
    // The visible surface is the same Three.js Water as the moat, layered on
    // top of the underlay — with reduced alpha so the readable blue shows
    // through and the reflection adds shimmer rather than hiding it.
    const bunkerWaterGeo = makeRoundedRectGeometry(B.X1 + 0.2, B.X2 - 0.2, B.OPEN_Z1 + 0.2, B.Z2 - 0.2, 1.5, 8);
    // Points are authored in world XZ (like the moat ring): mirror local Y so
    // the -PI/2 X-rotation lands the shape at positive Z, and keep the mesh at
    // the origin — offsetting by the chamber centre on top of absolute coords
    // is what teleported the surface ~85 units away under the island.
    bunkerWaterGeo.scale(1, -1, 1);
    bunkerWaterCap = addStoryBridgeVisualWaterCap(bunkerWaterGeo, B.FLOOR_Y - 0.15 + 0.05, 0, 0, castleSceneMeshes, 'castle', false);
    if (bunkerWaterCap) {
        bunkerWaterCap.visible = false;
        const uni = bunkerWaterCap.material?.uniforms;
        if (uni && uni.alpha) uni.alpha.value = 0.45;
    }
})();

// === King's Bunker: trapdoor, key pickup, interaction, descent/ascent ===
const interactPromptEl = document.getElementById('interactPrompt');
const mobileInteractBtn = document.getElementById('mobileInteractBtn');

(function buildTrapdoor() {
    const B = BUNKER;
    const doorTex = woodPlankTex.clone();
    doorTex.needsUpdate = true;
    doorTex.repeat.set(1.4, 1.4);
    const doorMat = new THREE.MeshStandardMaterial({ map: doorTex, roughness: 0.85, metalness: 0.0, color: 0x7a5c38 });
    const bandMat = new THREE.MeshStandardMaterial({ color: 0x2e2a26, roughness: 0.55, metalness: 0.65 });

    // Fixed plank deck over the north part of the mouth (matches plankBody).
    const deckMat = new THREE.MeshStandardMaterial({ map: woodPlankTex, roughness: 0.9, metalness: 0.0, color: 0x6b4e2e });
    const deckW = (B.OPEN_X2 - B.OPEN_X1) - 0.04, deckL = B.OPEN_Z2 - B.HATCH_Z2;
    const plankCount = Math.max(4, Math.round(deckL / 0.48));
    const plankD = deckL / plankCount - 0.03;
    for (let i = 0; i < plankCount; i++) {
        const plank = new THREE.Mesh(new THREE.BoxGeometry(deckW, 0.08, plankD), deckMat);
        plank.position.set(B.TRAPDOOR_X, 0.26, B.HATCH_Z2 + (i + 0.5) * (deckL / plankCount));
        plank.receiveShadow = true;
        scene.add(plank);
        castleSceneMeshes.push(plank);
    }

    // The hatch door: hinged along the deck edge (north), flops open flat
    // onto the planks like a real cellar hatch.
    const pivot = new THREE.Group();
    pivot.position.set(B.TRAPDOOR_X, 0.30, B.HATCH_Z2);
    scene.add(pivot);
    castleSceneMeshes.push(pivot);

    const doorW = (B.OPEN_X2 - B.OPEN_X1) - 0.06, doorL = (B.HATCH_Z2 - B.OPEN_Z1) - 0.06;
    const door = new THREE.Mesh(new THREE.BoxGeometry(doorW, 0.07, doorL), doorMat);
    door.position.set(0, 0, -doorL / 2 - 0.03);
    door.castShadow = true;
    pivot.add(door);
    for (const off of [-0.45, -doorL / 2 - 0.03, -doorL + 0.45]) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(doorW - 0.1, 0.085, 0.12), bandMat);
        band.position.set(0, 0.005, off);
        pivot.add(band);
    }
    // Strap hinges reaching from the deck edge onto the door.
    for (const hx of [-0.9, 0.9]) {
        const strap = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.09, 0.55), bandMat);
        strap.position.set(hx, 0.005, -0.30);
        pivot.add(strap);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.025, 6, 12), bandMat);
    ring.position.set(0, 0.06, -doorL + 0.16);
    ring.rotation.x = -Math.PI / 2;
    pivot.add(ring);

    trapdoor = { pivot, state: 'locked', angle: 0 };
})();

function updateTrapdoor(dt) {
    if (!trapdoor || trapdoor.state !== 'opening') return;
    // 0 -> ~PI: the door swings up and over the north hinge, coming to rest
    // nearly flat on the plank deck. Eased so it starts slow and lands heavy.
    trapdoor.angle = Math.min(2.95, trapdoor.angle + dt * (0.8 + trapdoor.angle * 1.4));
    trapdoor.pivot.rotation.x = trapdoor.angle;
    if (trapdoor.angle >= 2.94) {
        trapdoor.state = 'open';
        if (trapdoorBody) {
            if (trapdoorBody.world) world.removeBody(trapdoorBody);
            const i = bunkerColliderBodies.indexOf(trapdoorBody);
            if (i >= 0) bunkerColliderBodies.splice(i, 1);   // suppression never re-adds it
        }
    }
}

// The bunker key, hidden in the hut. Spins/bobs until walked over.
(function buildBunkerKey() {
    const goldMat = new THREE.MeshStandardMaterial({
        color: 0xd4af37, metalness: 0.9, roughness: 0.25, emissive: 0x332200,
    });
    const key = new THREE.Group();
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.10, 0.032, 8, 16), goldMat);
    bow.position.y = 0.14;
    key.add(bow);
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.24, 0.045), goldMat);
    shaft.position.y = -0.02;
    key.add(shaft);
    const tooth1 = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.04, 0.045), goldMat);
    tooth1.position.set(0.045, -0.10, 0);
    key.add(tooth1);
    const tooth2 = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.04, 0.045), goldMat);
    tooth2.position.set(0.035, -0.05, 0);
    key.add(tooth2);
    key.position.set(58.5, 0.95, 33.0);   // inside the hut, off the charger's spot
    scene.add(key);
    castleSceneMeshes.push(key);
    bunkerPickups.push({ mesh: key, kind: 'key', collected: false, baseY: 0.95, phase: Math.random() * Math.PI * 2 });
})();

// The king's coin hoard: 10 gold coins scattered around the throne. Shared
// geometry/material; collected by walking over them (updateBunkerPickups).
const coinCountEl = document.getElementById('coinCount');
const coinHudEl = document.getElementById('coinHud');
const coinTimerEl = document.getElementById('coinTimer');
(function buildBunkerCoins() {
    const coinGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.045, 12);
    coinGeo.rotateZ(Math.PI / 2);   // stand on edge, spins like a Mario coin
    const coinMat = new THREE.MeshStandardMaterial({
        color: 0xd4af37, metalness: 0.9, roughness: 0.22, emissive: 0x2a1e00,
    });
    const TX = BUNKER.THRONE_X, TZ = BUNKER.THRONE_Z;
    const spots = [];
    for (const a of [0, 60, 120, 180, 240, 300]) spots.push([TX + Math.cos(a * Math.PI / 180) * 1.6, TZ + Math.sin(a * Math.PI / 180) * 1.6]);
    // A loose trail back toward the tunnel mouth, all clear of the walls.
    spots.push([-6, 88], [-2, 90.5], [3, 88.5], [8, 89.5]);
    for (const [cx, cz] of spots) {
        const coin = new THREE.Mesh(coinGeo, coinMat);
        coin.position.set(cx, BUNKER.FLOOR_Y + 0.5, cz);
        scene.add(coin);
        castleSceneMeshes.push(coin);
        bunkerPickups.push({ mesh: coin, kind: 'coin', collected: false, baseY: BUNKER.FLOOR_Y + 0.5, phase: Math.random() * Math.PI * 2 });
    }
})();

let _coinHudLast = '';
function updateCoinHud() {
    if (!coinHudEl) return;
    const show = bunkerEverEntered || bunkerCoinsCollected > 0 || (storyModeEnabled && storyStage >= 2 && !gameOver);
    const timerTxt = (kingSwitchTimer > 0 && bunkerEverEntered && !bunkerFlooding)
        ? ` · ⚠ ${Math.ceil(kingSwitchTimer)}s`
        : (bunkerFlooding ? ' · 🌊' : '');
    const key = `${show}|${bunkerCoinsCollected}|${timerTxt}`;
    if (key === _coinHudLast) return;
    _coinHudLast = key;
    coinHudEl.style.display = show ? 'block' : 'none';
    if (coinCountEl) coinCountEl.textContent = bunkerCoinsCollected;
    if (coinTimerEl) coinTimerEl.textContent = timerTxt;
}

function updateBunkerPickups(dt) {
    const px = camera.position.x, pz = camera.position.z;
    const tNow = performance.now() * 0.001;
    for (const p of bunkerPickups) {
        if (p.collected) continue;
        p.mesh.rotation.y += dt * 2.2;
        let y = p.baseY + Math.sin(tNow * 2.0 + p.phase) * 0.06;
        if (p.kind === 'coin' && bunkerFlooding && bunkerWp) y = Math.max(y, bunkerWp.baseY + 0.03);
        p.mesh.position.y = y;
        const dx = px - p.mesh.position.x, dz = pz - p.mesh.position.z;
        if (dx * dx + dz * dz > 1.0) continue;
        if (p.kind === 'key' && (bunkerState.phase !== 'above' || storyCastleSuppressed)) continue;
        if (p.kind === 'coin' && bunkerState.phase !== 'inside') continue;
        p.collected = true;
        p.mesh.visible = false;
        if (p.kind === 'key') {
            hasKey = true;
            spawnScorePopup(p.mesh.position.x, p.mesh.position.y + 0.4, p.mesh.position.z, 'BUNKER KEY', null);
            if (storyModeEnabled) setStoryHud('Key found — back to the courtyard trapdoor');
        } else {
            bunkerCoinsCollected++;
            score += BUNKER_COIN_SCORE;
            updateUI();
            playCoinSound();
            spawnScorePopup(p.mesh.position.x, p.mesh.position.y + 0.4, p.mesh.position.z, '+' + BUNKER_COIN_SCORE, null);
            updateCoinHud();
            kingCoinTaunt();
        }
    }
}

// Context-sensitive "use" (E key / USE button): the trapdoor and the ladder.
// E falls through to weapon-next everywhere else.
function getInteractContext() {
    if (window.__editorActive || gameOver || storyCastleSuppressed) return null;
    if (bunkerState.phase === 'descending' || bunkerState.phase === 'ascending') return { id: 'busy', text: '' };
    if (!trapdoor) return null;
    if (bunkerState.phase === 'above') {
        if (camera.position.y < 1.2) return null;   // below courtyard — no prompt through the floor
        // Distance to the HATCH rim (not the whole mouth): the door is used
        // from its edge — you can't stand over the open hole to use it.
        const mx = THREE.MathUtils.clamp(camera.position.x, BUNKER.OPEN_X1, BUNKER.OPEN_X2);
        const mz = THREE.MathUtils.clamp(camera.position.z, BUNKER.OPEN_Z1, BUNKER.HATCH_Z2);
        if (Math.hypot(camera.position.x - mx, camera.position.z - mz) >= 1.2) return null;
        if (trapdoor.state === 'open' || trapdoor.state === 'opening') return { id: 'hatch-descend', text: 'Climb down the ladder' };
        if (hasKey) return { id: 'trapdoor-unlock', text: 'Unlock the trapdoor' };
        return { id: 'trapdoor-locked', text: 'Locked — find the key' };
    }
    // inside: climbing out happens at the ladder base in the shaft
    const dLadder = Math.hypot(camera.position.x - BUNKER.TRAPDOOR_X, camera.position.z - BUNKER.LADDER_Z);
    if (dLadder < 1.7 && !playerWaterState && trapdoor.state === 'open') return { id: 'hatch-ascend', text: 'Climb up the ladder' };
    return null;
}

function tryInteract() {
    const ctx = getInteractContext();
    if (!ctx) return false;
    switch (ctx.id) {
        case 'busy':
            return true;
        case 'trapdoor-locked':
            flashInteractPrompt();
            return true;
        case 'trapdoor-unlock':
            hasKey = false;
            trapdoor.state = 'opening';
            playDrawbridgeCreak(0.4, 0.3);
            return true;
        case 'hatch-descend':
            beginBunkerTransition('down');
            return true;
        case 'hatch-ascend':
            beginBunkerTransition('up');
            return true;
    }
    return true;
}

function updateInteractPrompt() {
    const ctx = getInteractContext();
    const show = !!ctx && ctx.id !== 'busy';
    if (interactPromptEl) {
        if (show) {
            interactPromptEl.style.display = 'block';
            interactPromptEl.textContent = (touchControls.enabled ? '' : 'E — ') + ctx.text;
        } else {
            interactPromptEl.style.display = 'none';
        }
    }
    if (mobileInteractBtn) {
        mobileInteractBtn.style.display = (show && touchControls.enabled) ? 'block' : 'none';
    }
}

function flashInteractPrompt() {
    if (!interactPromptEl) return;
    interactPromptEl.classList.remove('flash');
    void interactPromptEl.offsetWidth;
    interactPromptEl.classList.add('flash');
}

// Scripted ladder climb: two smoothstep segments (to the shaft centre, then
// the vertical climb) with input suspended and mouse look live. The ladder is
// the only way in and out of the shaft; the tunnel slope beyond is walked.
function beginBunkerTransition(dir) {
    const B = BUNKER;
    bunkerState.from.copy(camera.position);
    bunkerState.via.set(B.TRAPDOOR_X, PLAYER_BASE_Y, B.LADDER_Z + 0.55);
    if (dir === 'down') {
        bunkerState.to.set(B.TRAPDOOR_X, B.RAMP1_BOT + PLAYER_BASE_Y, B.LADDER_Z + 0.65);
    } else {
        bunkerState.to.set(B.TRAPDOOR_X, PLAYER_BASE_Y, B.OPEN_Z1 - 1.0);
    }
    bunkerState.seg = 0;
    bunkerState.t = 0;
    bunkerState.phase = dir === 'down' ? 'descending' : 'ascending';
    playerOnGround = false;
    playerYVel = 0;
    jumpQueued = false;
}

function updateBunkerTransition(dt) {
    if (bunkerState.phase !== 'descending' && bunkerState.phase !== 'ascending') return;
    const SEG_TIMES = [0.5, 1.7];
    bunkerState.t += dt / SEG_TIMES[bunkerState.seg];
    const t = Math.min(1, bunkerState.t);
    const s = t * t * (3 - 2 * t);   // smoothstep
    const a = bunkerState.seg === 0 ? bunkerState.from : bunkerState.via;
    const b = bunkerState.seg === 0 ? bunkerState.via : bunkerState.to;
    camera.position.lerpVectors(a, b, s);
    if (t >= 1) {
        if (bunkerState.seg === 0) {
            bunkerState.seg = 1;
            bunkerState.t = 0;
        } else {
            const goingDown = bunkerState.phase === 'descending';
            bunkerState.phase = goingDown ? 'inside' : 'above';
            camera.position.copy(bunkerState.to);
            playerOnGround = true;
            playerYVel = 0;
            if (goingDown && !bunkerEverEntered) {
                bunkerEverEntered = true;
                kingSwitchTimer = BUNKER_FLOOD_DELAY_SEC;
            }
        }
    }
}

// === Front-facing cloth banners that hang from the battlements ===
// Each banner hangs against the front wall, anchored to the nearest wall brick.

// Dev/test hook (harmless in production): lets an automated browser test drive
// the heist loop without simulating minutes of play.
window.__bunkerTest = {
    camera,
    state: () => bunkerState,
    pickups: bunkerPickups,
    king: () => king,
    trapdoor: () => trapdoor,
    throne: () => throneGroup,
    water: () => bunkerWp,
    waterCap: () => bunkerWaterCap,
    hasKey: () => hasKey,
    giveKey: () => { hasKey = true; },
    tryInteract,
    getInteractContext,
    coinsCollected: () => bunkerCoinsCollected,
    everEntered: () => bunkerEverEntered,
    flooding: () => ({ bunkerFlooding, castleMoatDrained, moatY: castleMoatWaterPlane ? castleMoatWaterPlane.baseY : null, bunkerY: bunkerWp ? bunkerWp.baseY : null }),
    switchTimer: () => kingSwitchTimer,
    floatState: () => ({
        kingFloating, kingSwitchPullT, bunkerFloodT,
        kingY: king ? +king.group.position.y.toFixed(2) : null,
        kingRotX: king ? +king.group.rotation.x.toFixed(2) : null,
        throneY: throneGroup ? +throneGroup.position.y.toFixed(2) : null,
        ragdoll: king ? !!king.isRagdoll : null,
    }),
    teleportAbove: () => {
        camera.position.set(BUNKER.TRAPDOOR_X, PLAYER_BASE_Y, BUNKER.OPEN_Z1 - 1.5);
        bunkerState.phase = 'above';
    },
    teleportInside: () => {
        camera.position.set(8, BUNKER.FLOOR_Y + PLAYER_BASE_Y, 78);
        bunkerState.phase = 'inside';
        if (!bunkerEverEntered) { bunkerEverEntered = true; kingSwitchTimer = BUNKER_FLOOD_DELAY_SEC; }
    },
    // Physics probes for automated verification of the two original bugs.
    probeDown: (x, z, fromY = 2, skipBackfaces = true) => {
        const rc = new CANNON.RaycastResult();
        world.raycastClosest(new CANNON.Vec3(x, fromY, z), new CANNON.Vec3(x, -30, z),
            { collisionFilterMask: -1, skipBackfaces }, rc);
        return rc.hasHit ? rc.hitPointWorld.y : null;
    },
    probeRay: (fx, fy, fz, tx, ty, tz) => {
        const rc = new CANNON.RaycastResult();
        world.raycastClosest(new CANNON.Vec3(fx, fy, fz), new CANNON.Vec3(tx, ty, tz),
            { collisionFilterMask: -1, skipBackfaces: true }, rc);
        return rc.hasHit ? { p: rc.hitPointWorld.toArray().map(v => +v.toFixed(2)) } : null;
    },
    meshProbe: (fx, fy, fz, tx, ty, tz) => {
        const rc = new THREE.Raycaster(new THREE.Vector3(fx, fy, fz), new THREE.Vector3(tx - fx, ty - fy, tz - fz).normalize());
        const hits = rc.intersectObjects(castleSceneMeshes, true);
        return hits.length ? { d: +hits[0].distance.toFixed(2), name: hits[0].object.name || hits[0].object.type } : null;
    },
    // Raycast through a screen pixel (ndc -1..1); returns direction + first hits.
    pixelProbe: (ndcX, ndcY, maxD = 60) => {
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
        rc.far = maxD;
        const hits = rc.intersectObjects(scene.children, true);
        return {
            dir: rc.ray.direction.toArray().map(v => +v.toFixed(3)),
            hits: hits.slice(0, 3).map(h => ({
                d: +h.distance.toFixed(2),
                name: h.object.name || h.object.type,
                vis: h.object.visible,
                col: h.object.material && h.object.material.color ? h.object.material.color.getHexString() : null,
            })),
        };
    },
    blast: (x, y, z, r = 4) => triggerBlast(new THREE.Vector3(x, y, z), r),
    aim: (y, p) => { yaw = y; pitch = p; },
    rafAlive: (() => { let n = 0; const tick = () => { n++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); return () => n; })(),
    countBodies: () => world.bodies.length,
    gameFlags: () => ({ gameOver, gamePaused, storyCastleSuppressed, storyModeEnabled, storyStage, playerWaterState: !!playerWaterState, playerHits }),
    aabbsNear: (x, z, r = 6) => world.bodies
        .filter(b => Math.abs(b.position.x - x) < r && Math.abs(b.position.z - z) < r && Math.abs(b.position.y) < 100)
        .map(b => ({
            pos: [+b.position.x.toFixed(1), +b.position.y.toFixed(1), +b.position.z.toFixed(1)],
            lb: [+b.aabb.lowerBound.x.toFixed(1), +b.aabb.lowerBound.y.toFixed(1), +b.aabb.lowerBound.z.toFixed(1)],
            ub: [+b.aabb.upperBound.x.toFixed(1), +b.aabb.upperBound.y.toFixed(1), +b.aabb.upperBound.z.toFixed(1)],
            upd: b.aabbNeedsUpdate,
        }))
        .slice(0, 30),
    bodiesNear: (x, z, r = 6) => world.bodies
        .filter(b => Math.abs(b.position.x - x) < r && Math.abs(b.position.z - z) < r && Math.abs(b.position.y) < 100)
        .map(b => ({ x: +b.position.x.toFixed(1), y: +b.position.y.toFixed(1), z: +b.position.z.toFixed(1), mass: b.mass, type: b.type }))
        .slice(0, 40),
};

// When that brick is knocked loose (woken / displaced), the banner detaches and
// falls under its own simple gravity (a full cloth sim would be overkill).
const banners = [];
function makeBannerTexture(base, trim, emblem) {
    const W = 64, H = 128;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = base; x.fillRect(0, 0, W, H);
    // Vertical centre stripe + side trims
    x.fillStyle = trim; x.fillRect(W/2 - 4, 0, 8, H);
    x.fillRect(4, 0, 3, H); x.fillRect(W - 7, 0, 3, H);
    // Subtle cloth shading bands
    for (let i = 0; i < 40; i++) {
        x.fillStyle = `rgba(0,0,0,${0.03 + Math.random()*0.05})`;
        x.fillRect(0, Math.random()*H, W, 1 + Math.random()*2);
    }
    // Heraldic emblem disc near the top
    x.fillStyle = emblem;
    x.beginPath(); x.arc(W/2, 30, 13, 0, Math.PI*2); x.fill();
    x.fillStyle = base;
    x.beginPath(); x.arc(W/2, 30, 6, 0, Math.PI*2); x.fill();
    const t = new THREE.CanvasTexture(c);
    return t;
}
(function addFrontBanners() {
    const frontZ = CFZ + BS.d / 2;       // front wall plane
    const faceZ  = frontZ - BS.d / 2 - 0.06;  // just proud of the outer face
    const topY   = WALL_ROWS * BS.h - 0.3;    // hang from just below the battlements
    const bW = 1.7, bH = 5.0;
    // Heraldic colour sets: [cloth, trim, emblem]
    const palettes = [
        ['#8e1b2e', '#e8c24a', '#e8c24a'],   // crimson + gold
        ['#1f3f86', '#d8d8d8', '#d8d8d8'],   // royal blue + silver
        ['#1f6b35', '#e8c24a', '#e8c24a'],   // green + gold
        ['#5a2168', '#e8c24a', '#e8c24a'],   // purple + gold
    ];
    const xs = [-11.5, -6, 6, 11.5];          // avoid gate (0) and window slits (�9)
    xs.forEach((bx, i) => {
        const pal = palettes[i % palettes.length];
        const tex = makeBannerTexture(pal[0], pal[1], pal[2]);
        const mat = new THREE.MeshStandardMaterial({
            map: tex, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide
        });
        const cyY = topY - bH / 2;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(bW, bH, 1, 6), mat);
        mesh.position.set(bx, cyY, faceZ);
        mesh.castShadow = true;
        // Gentle hanging curve so it doesn't look like flat cardboard.
        const pos = mesh.geometry.attributes.position;
        for (let v = 0; v < pos.count; v++) {
            const px = pos.getX(v);
            pos.setZ(v, -Math.abs(px) * 0.12);   // edges curl back toward the wall
        }
        pos.needsUpdate = true; mesh.geometry.computeVertexNormals();
        scene.add(mesh);
        // Anchor to the nearest front-wall brick near the top of the banner.
        let anchor = null, best = Infinity;
        for (const b of bricks) {
            if (b.grp !== CGROUP_BRICK || b.isLintel) continue;
            const p = b.body.position;
            if (Math.abs(p.z - frontZ) > 1.2) continue;        // front wall only
            const dx = p.x - bx, dy = p.y - topY;
            const d2 = dx*dx + dy*dy;
            if (d2 < best) { best = d2; anchor = b; }
        }
        banners.push({
            mesh, anchor,
            ax: bx, ay: cyY, az: faceZ,
            anchorRest: anchor ? anchor.body.position.clone() : null,
            falling: false, vx: 0, vy: 0, vz: 0,
            rvx: 0, rvy: 0, rvz: 0, life: 6
        });
    });
})();


// A solid wooden deck caps each round tower so the guards have a floor to stand
// on instead of hovering over the hollow shaft. Static (mass 0) while the tower
// stands, then released to fall under gravity the moment its supporting ring is
// destroyed (see the platform-drop check in the animation loop) � so it never
// hangs floating in mid-air after the tower below it is gone.
const towerPlatforms = [];
(function addTowerPlatforms() {
    const floorY = TOWER_ROWS * BS.h;        // top of the wall ring
    const thick  = 0.34;
    const rad    = TOWER_R - 0.7;            // rests on the inner ledge with a touch more clearance
    for (const { cx, cz } of TOWER_CENTERS) {
        const mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(rad, rad, thick, 24),
            woodPlankMat
        );
        const py = floorY - thick / 2 - 0.03;
        mesh.position.set(cx, py, cz);
        mesh.castShadow = true; mesh.receiveShadow = true;
        scene.add(mesh);
        const body = new CANNON.Body({
            mass: 0,
            material: wallPhysMat,
            shape: new CANNON.Box(new CANNON.Vec3(rad * 0.50, Math.max(0.06, thick / 2 - 0.04), rad * 0.50)),
            linearDamping: 0.30,
            angularDamping: 0.55,
            collisionFilterGroup: CGROUP_TOWER,
            collisionFilterMask:  TOWER_MASK
        });
        body.position.set(cx, py, cz);
        world.addBody(body);
        towerPlatforms.push({ body, mesh, cx, cz, floorY, dropped: false, thick, rad });
    }
})();

// (The hut is all wood now — the old thatch/plaster/stone hut materials went
// with the brick-built version.)

// Plank size ? half the castle brick. PT = board thickness (rough-sawn siding,
// half the old masonry depth — reads as wood, not brick).
const PS = { w: BS.w * 0.75, h: BS.h * 0.75, d: BS.d * 0.75 };
const PT = PS.d * 0.5;

// Separate InstancedMesh pair for house planks (wood material). Board LENGTH
// varies per instance via matrix scale on the length axis (PS.w is the unit).
const MAX_PLANKS = 800;
const plankGeoX  = new THREE.BoxGeometry(PS.w, PS.h, PT);
const plankGeoZ  = new THREE.BoxGeometry(PT, PS.h, PS.w);
const plankInstX = new THREE.InstancedMesh(plankGeoX, woodPlankMat, MAX_PLANKS);
const plankInstZ = new THREE.InstancedMesh(plankGeoZ, woodPlankMat, MAX_PLANKS);
plankInstX.castShadow = true; plankInstX.receiveShadow = true;
plankInstZ.castShadow = true; plankInstZ.receiveShadow = true;
plankInstX.frustumCulled = false;
plankInstZ.frustumCulled = false;
plankInstX.count = 0; plankInstZ.count = 0;
scene.add(plankInstX); scene.add(plankInstZ);

// Track planks separately so they sync correctly
const planks = [];

// One long siding board (old-western shed style). lenMeters runs along the
// board's length axis (x for front/back walls, z for sides); the shared unit
// geometry is stretched per instance via matrix scale.
function createPlank(x, y, z, isZ = false, lenMeters = PS.w) {
    const idx = isZ ? plankInstZ.count++ : plankInstX.count++;
    const lenScale = lenMeters / PS.w;
    _iDummy.position.set(x, y, z);
    _iDummy.quaternion.set(0, 0, 0, 1);
    _iDummy.scale.set(isZ ? 1 : lenScale, 1, isZ ? lenScale : 1);
    _iDummy.updateMatrix();
    _iDummy.scale.set(1, 1, 1);
    if (isZ) { plankInstZ.setMatrixAt(idx, _iDummy.matrix); plankInstZ.instanceMatrix.needsUpdate = true; }
    else      { plankInstX.setMatrixAt(idx, _iDummy.matrix); plankInstX.instanceMatrix.needsUpdate = true; }

    // Long, heavy, sleepy boards: a light knock rattles ONE board loose instead
    // of rippling the whole hut down. Length collider is trimmed a hair so
    // stacked courses never weld into a single rigid chain.
    const lenHalf = lenMeters / 2 - 0.06;
    const shape = isZ
        ? new CANNON.Box(new CANNON.Vec3(PT / 2, PS.h / 2, lenHalf))
        : new CANNON.Box(new CANNON.Vec3(lenHalf, PS.h / 2, PT / 2));
    const body = new CANNON.Body({
        mass: Math.round(42 * lenMeters),
        material: brickPhysMat,
        shape,
        allowSleep: true, sleepSpeedLimit: 0.55, sleepTimeLimit: 0.45,
        linearDamping: 0.50, angularDamping: 0.80,
        collisionFilterGroup: CGROUP_BRICK, collisionFilterMask: -1 ^ CGROUP_BRIDGE
    });
    body.position.set(x, y, z);
    body._storyRole = 'castle';
    body._isPlank = true;   // wood (not stone) impact sound
    world.addBody(body);
    body.sleep();
    planks.push({ idx, isZ, body, ix: x, iy: y, iz: z, lenScale, scored: false, isPlank: true, grp: CGROUP_BRICK, storyRole: 'castle' });
    bricks.push(planks[planks.length - 1]); // also add to bricks for blast/wake checks
}

function buildWoodenHouse(cx, cz) {
    const markCastleMesh = (m) => { castleSceneMeshes.push(m); return m; };
    const W = 9, D = 6, ROWS = 6;
    const DOOR_W = 3;
    const DOOR_H = 4;
    const doorMinX = Math.floor((W - DOOR_W) / 2);
    const doorMaxX = doorMinX + DOOR_W - 1;
    const WIN_A = 2;
    const WIN_B = D - 2;

    // Long horizontal siding boards, lap-staggered per course like an old
    // western shed. Board = one physics body; gaps preserve the door, the
    // charger's exit lane, and one window slit per side wall.
    const wallL = W * PS.w;
    const xL = cx - wallL / 2, xR = cx + wallL / 2;
    const doorXL = cx - (DOOR_W * PS.w) / 2, doorXR = cx + (DOOR_W * PS.w) / 2;
    const boardX = (x0, x1, y, z) => createPlank((x0 + x1) / 2, y, z, false, x1 - x0);
    const boardZ = (z0, z1, y, x) => createPlank(x, y, (z0 + z1) / 2, true, z1 - z0);
    const sideZ0 = cz + PS.d / 2, sideZ1 = cz + D * PS.d - PS.d / 2;
    const sideXL = xL + PS.d / 2, sideXR = xR - PS.d / 2;
    for (let r = 0; r < ROWS; r++) {
        const y = PS.h / 2 + r * PS.h;
        const lap = (r % 2 ? -1 : 1) * PS.w;   // stagger the butt joints per course
        // Front wall: boards flank the tall centred door; full courses above it.
        if (r < DOOR_H) {
            boardX(xL, doorXL, y, cz);
            boardX(doorXR, xR, y, cz);
        } else {
            boardX(xL, cx + lap, y, cz);
            boardX(cx + lap, xR, y, cz);
        }
        // Back wall: two lapped boards per course.
        boardX(xL, cx - lap, y, cz + D * PS.d);
        boardX(cx - lap, xR, y, cz + D * PS.d);
        // Side walls: charge lane gap near the door below door height, a
        // two-course window slit mid-wall, full boards up top.
        for (const sx of [sideXL, sideXR]) {
            if (r < 2) {
                boardZ(cz + PS.d * 1.5, sideZ1, y, sx);            // lane kept clear
            } else if (r < DOOR_H) {
                boardZ(cz + PS.d * 2.5, cz + PS.d * 3.5, y, sx);   // stub between windows
                boardZ(cz + PS.d * 4.5, sideZ1, y, sx);            // rear of the slit
            } else {
                boardZ(sideZ0, sideZ1, y, sx);
            }
        }
    }

    // Timber frame (static visual beams): sturdier medieval hut look.
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x4b341e, roughness: 0.85, metalness: 0.05 });
    const hutW = W * PS.w;
    const hutD = D * PS.d;
    const cornerH = ROWS * PS.h + PS.h * 1.2;
    // Corner posts are wide enough to fully cover the wall butt-joints on both faces.
    // cPr: each post/quoin is shifted 18 mm outward so its outer face stands
    // clear of the coplanar wall-plank surface, preventing Z-fighting flicker.
    const cPostW = PS.w * 0.62;  // ~0.93 m � covers both wall-face joint seams
    const cPr = 0.018;
    const cornerPts = [
        [cx - hutW/2 + cPostW*0.5 - cPr, cornerH/2, cz + cPostW*0.5 - cPr],
        [cx + hutW/2 - cPostW*0.5 + cPr, cornerH/2, cz + cPostW*0.5 - cPr],
        [cx - hutW/2 + cPostW*0.5 - cPr, cornerH/2, cz + hutD - cPostW*0.5 + cPr],
        [cx + hutW/2 - cPostW*0.5 + cPr, cornerH/2, cz + hutD - cPostW*0.5 + cPr],
    ];
    const cPostHalf = cPostW * 0.5;
    for (const [px, py, pz] of cornerPts) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(cPostW, cornerH, cPostW), frameMat);
        c.castShadow = true;
        c.position.set(px, py, pz);
        scene.add(c);
        markCastleMesh(c);

        // Static collision body � stops planks and cannonballs from clipping through.
        const cbody = new CANNON.Body({
            mass: 0,
            material: brickPhysMat,
            shape: new CANNON.Box(new CANNON.Vec3(cPostHalf, cornerH * 0.5, cPostHalf)),
            collisionFilterGroup: CGROUP_BRICK,
            collisionFilterMask: -1 ^ CGROUP_BRIDGE
        });
        cbody.position.set(px, py, pz);
        cbody._storyRole = 'castle';
        world.addBody(cbody);
        bricks.push({
            idx: -1, isZ: false, body: cbody,
            ix: px, iy: py, iz: pz,
            scored: true, isHutSupport: true, grp: CGROUP_BRICK, storyRole: 'castle'
        });
    }

    const eaveBeamY = ROWS * PS.h + PS.h * 0.35;

    // Physical roof supports (static posts): roof rests on these so startup is
    // dead-stable and collapse occurs only from actual impact damage.
    const supportH = eaveBeamY + PS.h * 0.20;
    const supportHalf = PS.d * 0.22;
    const supportPts = [
        [cx - hutW * 0.28, supportH * 0.5, cz + hutD * 0.36],
        [cx + hutW * 0.28, supportH * 0.5, cz + hutD * 0.36],
        [cx - hutW * 0.22, supportH * 0.5, cz + hutD * 0.66],
        [cx + hutW * 0.22, supportH * 0.5, cz + hutD * 0.66],
    ];
    for (const [sx, sy, sz] of supportPts) {
        const smesh = new THREE.Mesh(new THREE.BoxGeometry(supportHalf * 2.2, supportH, supportHalf * 2.2), frameMat);
        smesh.castShadow = true;
        smesh.receiveShadow = true;
        smesh.position.set(sx, sy, sz);
        scene.add(smesh);
        markCastleMesh(smesh);

        const sbody = new CANNON.Body({
            mass: 0,
            material: brickPhysMat,
            shape: new CANNON.Box(new CANNON.Vec3(supportHalf, supportH * 0.5, supportHalf)),
            collisionFilterGroup: CGROUP_BRICK,
            collisionFilterMask: -1 ^ CGROUP_BRIDGE
        });
        sbody.position.set(sx, sy, sz);
        sbody._storyRole = 'castle';
        world.addBody(sbody);
        bricks.push({
            idx: -1, isZ: false, body: sbody,
            ix: sx, iy: sy, iz: sz,
            scored: true, isHutSupport: true, grp: CGROUP_BRICK, storyRole: 'castle'
        });
    }

    const beamF = new THREE.Mesh(new THREE.BoxGeometry(hutW + PS.d*0.25, PS.h*0.45, PS.d*0.62), frameMat);
    beamF.castShadow = true; beamF.position.set(cx, eaveBeamY, cz + PS.d*0.15);
    scene.add(beamF);
    markCastleMesh(beamF);
    const beamB = beamF.clone(); beamB.position.z = cz + hutD - PS.d*0.15; scene.add(beamB);
    markCastleMesh(beamB);
    const beamL = new THREE.Mesh(new THREE.BoxGeometry(PS.d*0.62, PS.h*0.45, hutD - PS.d*0.25), frameMat);
    beamL.castShadow = true; beamL.position.set(cx - hutW/2 + PS.d*0.16, eaveBeamY, cz + hutD/2);
    scene.add(beamL);
    markCastleMesh(beamL);
    const beamR = beamL.clone(); beamR.position.x = cx + hutW/2 - PS.d*0.16; scene.add(beamR);
    markCastleMesh(beamR);

    // Door frame posts + lintel (static meshes, not physics)
    const doorL = cx - (W * PS.w)/2 + doorMinX * PS.w;
    const doorR = cx - (W * PS.w)/2 + (doorMaxX + 1) * PS.w;
    const postH = DOOR_H * PS.h;
    const trimMat = new THREE.MeshStandardMaterial({ map: woodPlankTex, roughness: 0.9 });
    [[doorL, postH/2, cz], [doorR, postH/2, cz]].forEach(([px, py, pz]) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(PS.d*0.9, postH, PS.d*0.9), trimMat);
        m.castShadow = true; m.position.set(px, py, pz); scene.add(m); markCastleMesh(m);
    });
    const lintelW = (doorR - doorL) + PS.d * 1.0;
    const lm = new THREE.Mesh(new THREE.BoxGeometry(lintelW, PS.h*0.75, PS.d*0.9), trimMat);
    lm.castShadow = true; lm.position.set((doorL+doorR)/2, DOOR_H*PS.h + PS.h*0.4, cz); scene.add(lm); markCastleMesh(lm);

    // Porch with wider front step/ramp for reliable charge-out lane.
    const sm = new THREE.Mesh(new THREE.BoxGeometry((DOOR_W+2.1)*PS.w, PS.h*0.38, PS.d*1.55), trimMat);
    sm.castShadow = true; sm.receiveShadow = true;
    sm.position.set(cx, PS.h*0.19, cz - PS.d*0.74); scene.add(sm); markCastleMesh(sm);
    const ramp = new THREE.Mesh(new THREE.BoxGeometry((DOOR_W+2.0)*PS.w, PS.h*0.26, PS.d*1.1), trimMat);
    ramp.castShadow = true; ramp.receiveShadow = true;
    ramp.position.set(cx, PS.h*0.11, cz - PS.d*1.42);
    ramp.rotation.x = -0.12;
    scene.add(ramp);
    markCastleMesh(ramp);

    // === Pitched thatched roof (one rigid dynamic body resting on the walls) ===
    // The whole roof (both slopes, ridge cap and the two plaster gable ends) is
    // a single THREE.Group driven by one CANNON box body. The body sits on top
    // of the wall planks, so once enough wall is knocked away it loses support
    // and topples / falls as one piece instead of floating in mid-air.
    const eaveY  = ROWS * PS.h + PS.h * 0.22;       // seats on top of the wall planks
    const zFront = cz;
    const zBack  = cz + D * PS.d;
    const zMid   = (zFront + zBack) / 2;
    const ovX = 0.82, ovZ = 0.68;       // eave overhangs
    const ridgeRise = 2.7;
    const ridgeY = eaveY + ridgeRise;
    const run    = (zBack - zFront) / 2 + ovZ;
    const slopeLen  = Math.hypot(run, ridgeRise);
    const angle     = Math.atan2(ridgeRise, run);
    const panelLenX = hutW + 2 * ovX;

    // Weathered board roof (was thatch): plank texture run across the slope.
    const roofTex = woodPlankTex.clone();
    roofTex.rotation = Math.PI / 2;
    roofTex.repeat.set(slopeLen / 1.4, panelLenX / 1.6);
    roofTex.needsUpdate = true;
    const roofMat = new THREE.MeshStandardMaterial({ map: roofTex, color: 0x9c8465, roughness: 0.95, metalness: 0.0 });

    // Group origin at the eave centre so child offsets are simple and the body's
    // collision box bottom sits exactly on the wall tops.
    const roofGroup = new THREE.Group();
    roofGroup.position.set(cx, eaveY, zMid);
    scene.add(roofGroup);

    const slopeGeo = new THREE.BoxGeometry(panelLenX, 0.16, slopeLen);
    // Back slope (drops toward +Z)
    const backSlope = new THREE.Mesh(slopeGeo, roofMat);
    backSlope.castShadow = true; backSlope.receiveShadow = true;
    backSlope.position.set(0, ridgeRise / 2, run / 2);
    backSlope.rotation.x = angle;
    roofGroup.add(backSlope);
    // Front slope (drops toward -Z)
    const frontSlope = new THREE.Mesh(slopeGeo, roofMat);
    frontSlope.castShadow = true; frontSlope.receiveShadow = true;
    frontSlope.position.set(0, ridgeRise / 2, -run / 2);
    frontSlope.rotation.x = -angle;
    roofGroup.add(frontSlope);
    // Ridge board along the apex
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(panelLenX, 0.24, 0.56), roofMat);
    ridge.castShadow = true; ridge.position.set(0, ridgeRise + 0.04, 0);
    roofGroup.add(ridge);

    // Vertical-board gable-end triangles (relative to the eave-centre origin)
    const gableTex = woodPlankTex.clone();
    gableTex.rotation = Math.PI / 2;             // boards run vertically
    gableTex.repeat.set(0.8, 0.55);
    gableTex.needsUpdate = true;
    const gableMat = new THREE.MeshStandardMaterial({
        map: gableTex, color: 0xa08a68, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide,
    });
    function addGable(zRel) {
        const sh = new THREE.Shape();
        sh.moveTo(-hutW / 2, 0); sh.lineTo(hutW / 2, 0); sh.lineTo(0, ridgeRise); sh.closePath();
        const gm = new THREE.Mesh(new THREE.ShapeGeometry(sh), gableMat);
        gm.castShadow = true; gm.position.z = zRel;
        roofGroup.add(gm);
    }
    addGable(zFront - zMid);
    addGable(zBack - zMid);

    // Rusty stovepipe poking through the back slope — part of the roof group,
    // so it topples with the roof.
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x3d3630, roughness: 0.6, metalness: 0.55 });
    const pipeX = hutW * 0.28, pipeZ = run * 0.30;
    const pipeBaseY = ridgeRise * (1 - pipeZ / run);   // slope height at pipeZ
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 1.5, 10), pipeMat);
    pipe.castShadow = true;
    pipe.position.set(pipeX, pipeBaseY + 0.45, pipeZ);
    roofGroup.add(pipe);
    const pipeCap = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.08, 10), pipeMat);
    pipeCap.position.set(pipeX, pipeBaseY + 1.28, pipeZ);
    roofGroup.add(pipeCap);

    // Dynamic body: compact ridge core + two slim eave rails. The rails let the
    // roof sit naturally on wall tops and fail progressively as support is lost,
    // without the giant overlap-prone full-volume collider.
    const roofHalfX = panelLenX * 0.44;
    const roofHalfY = ridgeRise * 0.34;
    const roofHalfZ = Math.max(0.55, run * 0.58);
    const roofCoreY = eaveY + ridgeRise * 0.70;
    const roofBody = new CANNON.Body({
        mass: 78,
        material: brickPhysMat,
        allowSleep: true, sleepSpeedLimit: 0.4, sleepTimeLimit: 0.5,
        linearDamping: 0.18, angularDamping: 0.34,
        collisionFilterGroup: CGROUP_BRICK, collisionFilterMask: -1 ^ CGROUP_BRIDGE
    });
    roofBody.addShape(new CANNON.Box(new CANNON.Vec3(roofHalfX, roofHalfY, roofHalfZ)));
    const railHalfX = panelLenX * 0.42;
    const railHalfY = 0.11;
    const railHalfZ = 0.15;
    const railY = -ridgeRise * 0.66;
    const railZ = run * 0.62;
    roofBody.addShape(new CANNON.Box(new CANNON.Vec3(railHalfX, railHalfY, railHalfZ)), new CANNON.Vec3(0, railY, railZ));
    roofBody.addShape(new CANNON.Box(new CANNON.Vec3(railHalfX, railHalfY, railHalfZ)), new CANNON.Vec3(0, railY, -railZ));
    roofBody.position.set(cx, roofCoreY, zMid);
    roofBody._storyRole = 'castle';
    world.addBody(roofBody);
    roofBody.sleep();
    // Keep the visual roof group's origin at eave height while physics body uses
    // a smaller collider near the ridge.
    bricks.push({ idx: -1, isZ: false, body: roofBody, ix: cx, iy: eaveY, iz: zMid,
                  scored: true, isRoof: true, mesh: roofGroup, grp: CGROUP_BRICK, storyRole: 'castle',
                  offY: -ridgeRise * 0.70 });

    // Crooked hand-painted "KEEP OUT" sign nailed above the door.
    {
        const sc = document.createElement('canvas'); sc.width = 256; sc.height = 64;
        const sx2 = sc.getContext('2d');
        sx2.fillStyle = '#8a6b42'; sx2.fillRect(0, 0, 256, 64);
        sx2.strokeStyle = 'rgba(60,40,20,0.5)'; sx2.lineWidth = 3;
        for (const lx of [4, 250]) { sx2.beginPath(); sx2.moveTo(lx, 2); sx2.lineTo(lx, 62); sx2.stroke(); }
        sx2.fillStyle = '#2b1d10';
        sx2.font = 'bold 38px Georgia, serif';
        sx2.textAlign = 'center'; sx2.textBaseline = 'middle';
        sx2.fillText('KEEP OUT', 128, 34);
        // nail heads
        sx2.fillStyle = '#1c1c1c';
        for (const [nx, ny] of [[14, 12], [242, 14], [16, 52], [240, 50]]) {
            sx2.beginPath(); sx2.arc(nx, ny, 4, 0, Math.PI * 2); sx2.fill();
        }
        const signTex = new THREE.CanvasTexture(sc);
        const sign = new THREE.Mesh(
            new THREE.BoxGeometry(2.3, 0.58, 0.06),
            new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.9 })
        );
        sign.castShadow = true;
        sign.position.set(cx + 0.35, DOOR_H * PS.h + PS.h * 1.15, cz - PT * 0.75);
        sign.rotation.z = -0.055;   // hung slightly wonky, naturally
        scene.add(sign);
        markCastleMesh(sign);
    }
}
buildWoodenHouse(60, 30);
// NPC guard inside the hut, facing the door (door is the front wall at z=30,
// facing -Z toward the player). Placed clearly inside and tagged so that when
// it charges it exits through the door opening instead of clipping a wall.
buildNPC(60, 31, 0, Math.PI, 'axe');
{
    const hutNpc = npcList[npcList.length - 1];
    hutNpc.storyRole = 'castle';
    hutNpc.isInHut = true;
    hutNpc.isHutCharger = true;
    hutNpc.walking = false;
    hutNpc.walkDelay = 0;
    hutNpc.speedMul = 2.2;  // front-line charger: at least 2x typical walker pace
    hutNpc.chaseOffsetX = 0;
    // Door opening is centred at x�60 in the front (-Z) wall. These two points
    // route the knight out through the gap, then clear of the hut, before it
    // chases the player.
    hutNpc.doorPath = [
        { x: 60, z: 29.2 },   // through the widened door gap
        { x: 60, z: 25.8 },   // clear of the porch/ramp
    ];
}

const STORY_BRIDGE_Z = (M_OZ1 + M_OZ2) * 0.5;
const STORY_BRIDGE_HALF_SPAN = 20;
const STORY_BRIDGE_WATER_HALF_X = BRIDGE_WATER_MAX_X;
const STORY_BRIDGE_WATER_MIN_X = BRIDGE_WATER_MIN_X;
const STORY_BRIDGE_WATER_MAX_X = BRIDGE_WATER_MAX_X;
const STORY_BRIDGE_WATER_SPAN_X = STORY_BRIDGE_WATER_MAX_X - STORY_BRIDGE_WATER_MIN_X;
const STORY_BRIDGE_WATER_HALF_Z = BRIDGE_WATER_HALF_Z;
const STORY_BRIDGE_WATER_VISUAL_HALF_Z = BRIDGE_WATER_VISUAL_HALF_Z;
const STORY_BRIDGE_WATER_Y = WATER_Y;
const STORY_BRIDGE_DECK_Y = 4.2;
const STORY_BRIDGE_RAMP_LEN = 12;
const STORY_BRIDGE_DECK_HALF = 12;
const STORY_BRIDGE_RAMP_START_OFFSET = 12.0;
const STORY_BRIDGE_RAMP_OUTER_X = STORY_BRIDGE_DECK_HALF + STORY_BRIDGE_RAMP_START_OFFSET + STORY_BRIDGE_RAMP_LEN;
const STORY_BRIDGE_APPROACH_X = STORY_BRIDGE_RAMP_OUTER_X + 0.9;
const STORY_BRIDGE_ROAD_HALF_Z = 3.35;
const STORY_BRIDGE_APPROACH_ROAD_LEN = 132;
const STORY_BRIDGE_APPROACH_ROAD_END_X = -STORY_BRIDGE_APPROACH_X + 1.4;
const STORY_BRIDGE_APPROACH_ROAD_START_X = STORY_BRIDGE_APPROACH_ROAD_END_X - STORY_BRIDGE_APPROACH_ROAD_LEN;
const STORY_BRIDGE_TRENCH_HALF_X = STORY_BRIDGE_RAMP_OUTER_X + 1.6;
const STORY_BRIDGE_TRENCH_BASE_HALF_Z = (STORY_BRIDGE_ROAD_HALF_Z * 2 + 12.6) * 0.5;
const STORY_BRIDGE_TRENCH_HALF_Z_BASE = STORY_BRIDGE_TRENCH_BASE_HALF_Z * 2.0;
const STORY_BRIDGE_TRENCH_MIN_HALF_Z = STORY_BRIDGE_ROAD_HALF_Z + 6.2;
const STORY_BRIDGE_TRENCH_MAX_HALF_Z = STORY_BRIDGE_WATER_VISUAL_HALF_Z - 1.4;
const STORY_BRIDGE_TRENCH_FLOOR_Y = -(WATER_DEPTH_M * 2) + 0.15;
let storyBridgeBuilt = false;
let storyBridgeBudget = 0;
let storyBridgeHadNpcWave = false;
let storyCastleSuppressed = false;
let storyBridgeSuppressed = false;
const storyBridgeSceneMeshes = [];
const storyBridgeSceneBodies = [];

function sampleStoryBridgeShorelineEdgePolyline(samples = 72) {
    const sampleCount = Math.max(8, Math.floor(samples));
    const topLocal = [];
    const bottomLocal = [];
    const topWorld = [];
    const bottomWorld = [];
    let minEdgeZ = Infinity;
    let maxEdgeZ = -Infinity;

    for (let i = 0; i <= sampleCount; i++) {
        const t = i / sampleCount;
        const x = STORY_BRIDGE_WATER_MIN_X + t * STORY_BRIDGE_WATER_SPAN_X;
        const p = getStoryBridgeWaterProfileAtX(x);
        if (p.halfWidth <= 0) continue;

        const visualHalf = THREE.MathUtils.clamp(
            p.halfWidth + BRIDGE_WATER_VISUAL_OUTSET,
            0,
            STORY_BRIDGE_WATER_VISUAL_HALF_Z - 0.2
        );
        if (visualHalf <= 0.0001) continue;

        const topWorldZ = p.centerZ + visualHalf;
        const bottomWorldZ = p.centerZ - visualHalf;
        topLocal.push(new THREE.Vector2(x, STORY_BRIDGE_Z - topWorldZ));
        bottomLocal.push(new THREE.Vector2(x, STORY_BRIDGE_Z - bottomWorldZ));
        topWorld.push(new THREE.Vector3(x, 0, topWorldZ));
        bottomWorld.push(new THREE.Vector3(x, 0, bottomWorldZ));
        minEdgeZ = Math.min(minEdgeZ, bottomWorldZ);
        maxEdgeZ = Math.max(maxEdgeZ, topWorldZ);
    }

    if (!Number.isFinite(minEdgeZ) || !Number.isFinite(maxEdgeZ)) {
        minEdgeZ = STORY_BRIDGE_Z - STORY_BRIDGE_WATER_VISUAL_HALF_Z;
        maxEdgeZ = STORY_BRIDGE_Z + STORY_BRIDGE_WATER_VISUAL_HALF_Z;
    }

    return {
        sampleCount,
        topLocal,
        bottomLocal,
        topWorld,
        bottomWorld,
        minEdgeZ,
        maxEdgeZ,
    };
}

function makeStoryBridgeWaterShapeGeometry(samplesOrEdge = 72) {
    const edge = typeof samplesOrEdge === 'number'
        ? sampleStoryBridgeShorelineEdgePolyline(samplesOrEdge)
        : samplesOrEdge;
    const top = edge?.topLocal || [];
    const bottom = edge?.bottomLocal || [];
    if (top.length < 3 || bottom.length < 3) {
        return new THREE.PlaneGeometry(STORY_BRIDGE_WATER_SPAN_X, STORY_BRIDGE_WATER_HALF_Z * 2);
    }

    const points = top.concat(bottom.slice().reverse());
    const segs = Math.max(16, Math.floor((edge?.sampleCount || 72) * 0.75));
    return new THREE.ShapeGeometry(new THREE.Shape(points), segs);
}

function makeStoryBridgeShoreShapeGeometry(sideSign = 1, samplesOrEdge = 72) {
    const side = sideSign >= 0 ? 1 : -1;
    const edge = typeof samplesOrEdge === 'number'
        ? sampleStoryBridgeShorelineEdgePolyline(samplesOrEdge)
        : samplesOrEdge;
    const shoreline = side > 0 ? edge?.topLocal : edge?.bottomLocal;
    if (!shoreline || shoreline.length < 3) return null;

    const bankLocalZ = side > 0 ? -STORY_BRIDGE_WATER_VISUAL_HALF_Z : STORY_BRIDGE_WATER_VISUAL_HALF_Z;
    const outer = shoreline.map((p) => new THREE.Vector2(p.x, bankLocalZ));
    const inner = shoreline.slice().reverse();
    const segs = Math.max(14, Math.floor((edge?.sampleCount || 72) * 0.65));
    const shape = new THREE.Shape(outer.concat(inner));
    return new THREE.ShapeGeometry(shape, segs);
}

function getStoryBridgeApproachRoadTFromX(x) {
    const span = Math.max(0.001, STORY_BRIDGE_APPROACH_ROAD_LEN);
    return THREE.MathUtils.clamp((STORY_BRIDGE_APPROACH_ROAD_END_X - x) / span, 0, 1);
}

function getStoryBridgeRoadCenterZAtX(x) {
    const t = getStoryBridgeApproachRoadTFromX(x);
    const main = Math.sin(t * Math.PI * 1.15) * 1.85;
    const secondary = Math.sin((t * 2.9 + 0.22) * Math.PI) * 0.82 * (1 - t * 0.36);
    const joinFade = THREE.MathUtils.smoothstep(t, 0.04, 0.985);
    return STORY_BRIDGE_Z + (main + secondary) * joinFade;
}

function isStoryBridgeTrenchActive() {
    const bridgeStageActive = storyModeEnabled && storyStage === 1;
    return bridgeStageActive
        && storyBridgeBuilt
        && !storyBridgeSuppressed
        && !BRIDGE_CHANNEL_WATER_ENABLED;
}

function getStoryBridgeTrenchHalfWidthAtX(x) {
    const trenchX1 = -STORY_BRIDGE_TRENCH_HALF_X;
    const trenchX2 = STORY_BRIDGE_TRENCH_HALF_X;
    if (x <= trenchX1 || x >= trenchX2) return 0;

    const span = Math.max(0.001, trenchX2 - trenchX1);
    const t = THREE.MathUtils.clamp((x - trenchX1) / span, 0, 1);
    const midBulge = Math.pow(Math.sin(t * Math.PI), 1.08);
    const edgeTaper = 0.70 + midBulge * 0.56;
    const uneven =
        Math.sin(x * 0.19 + 0.42) * 1.8 +
        Math.sin(x * 0.47 + 1.06) * 0.9 +
        Math.sin(x * 0.071 + 0.9) * 1.1;
    const raw = STORY_BRIDGE_TRENCH_HALF_Z_BASE * edgeTaper + uneven;
    return THREE.MathUtils.clamp(raw, STORY_BRIDGE_TRENCH_MIN_HALF_Z, STORY_BRIDGE_TRENCH_MAX_HALF_Z);
}

function isInStoryBridgeTrenchXZ(x, z, edgeBuffer = 0) {
    if (!isStoryBridgeTrenchActive()) return false;
    const trenchX1 = -STORY_BRIDGE_TRENCH_HALF_X + edgeBuffer;
    const trenchX2 = STORY_BRIDGE_TRENCH_HALF_X - edgeBuffer;
    if (x <= trenchX1 || x >= trenchX2) return false;
    const half = getStoryBridgeTrenchHalfWidthAtX(x) - edgeBuffer;
    if (half <= 0) return false;
    return Math.abs(z - STORY_BRIDGE_Z) < half;
}

function sampleStoryBridgeWaterEdgePoints(edgeBuffer = 0, samples = 96, y = STORY_BRIDGE_WATER_Y) {
    const top = [];
    const bottom = [];
    const span = STORY_BRIDGE_WATER_MAX_X - STORY_BRIDGE_WATER_MIN_X;
    for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const x = STORY_BRIDGE_WATER_MIN_X + span * t;
        const p = getStoryBridgeWaterProfileAtX(x);
        const half = p.halfWidth - edgeBuffer;
        if (half <= 0) continue;
        top.push(new THREE.Vector3(x, y, p.centerZ + half));
        bottom.push(new THREE.Vector3(x, y, p.centerZ - half));
    }
    return { top, bottom };
}

function sampleStoryBridgeRoadExclusionEdgePoints(buffer = 0, samples = 96, y = STORY_BRIDGE_WATER_Y) {
    const left = [];
    const right = [];
    const minX = Math.max(STORY_BRIDGE_WATER_MIN_X + 0.2, STORY_BRIDGE_APPROACH_ROAD_START_X - buffer);
    const maxX = Math.min(STORY_BRIDGE_WATER_MAX_X - 0.2, STORY_BRIDGE_APPROACH_X + 0.9 + buffer);
    if (minX >= maxX) return { left, right };

    const halfRoad = STORY_BRIDGE_ROAD_HALF_Z + buffer;
    const span = maxX - minX;
    for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const x = minX + span * t;
        const center = x <= STORY_BRIDGE_APPROACH_ROAD_END_X
            ? getStoryBridgeRoadCenterZAtX(x)
            : STORY_BRIDGE_Z;

        // Road exclusion edges only matter where the road slices through water.
        if (!isInStoryBridgeWaterShapeXZ(x, center, 0)) continue;

        left.push(new THREE.Vector3(x, y, center + halfRoad));
        right.push(new THREE.Vector3(x, y, center - halfRoad));
    }
    return { left, right };
}

function makeStoryBridgeDebugTube(points, color, radius = 0.14, closed = false) {
    if (!points || points.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal', 0.25);
    const segments = Math.max(24, points.length * 2);
    const geo = new THREE.TubeGeometry(curve, segments, radius, 10, closed);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.98, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 9999;
    return mesh;
}

function addStoryBridgeWaterPerimeterDebug() {
    if (!DEV_SHOW_BRIDGE_WATER_PERIMETERS || !WATER_SYSTEM_ENABLED || !BRIDGE_CHANNEL_WATER_ENABLED) return;

    const samples = isMobileProfile ? 56 : 110;

    // 1) Graphical waterline (cyan): exact rendered curved edge.
    const visual = sampleStoryBridgeWaterEdgePoints(0, samples, STORY_BRIDGE_WATER_Y + 0.07);
    const visualTop = makeStoryBridgeDebugTube(visual.top, 0x00e5ff, 0.17, false);
    const visualBottom = makeStoryBridgeDebugTube(visual.bottom, 0x00e5ff, 0.17, false);

    // 2) Physical/player waterline (orange): same curved edge as graphics.
    const phys = sampleStoryBridgeWaterEdgePoints(0, samples, STORY_BRIDGE_WATER_Y + 0.21);
    const physTop = makeStoryBridgeDebugTube(phys.top, 0xffa31a, 0.14, false);
    const physBottom = makeStoryBridgeDebugTube(phys.bottom, 0xffa31a, 0.14, false);

    // 3) Drop line (magenta): same curved shoreline projected to trench floor.
    const dropY = STORY_BRIDGE_WATER_Y - WATER_DEPTH_M + 0.05;
    const drop = sampleStoryBridgeWaterEdgePoints(0, samples, dropY);
    const dropTop = makeStoryBridgeDebugTube(drop.top, 0xff2e86, 0.12, false);
    const dropBottom = makeStoryBridgeDebugTube(drop.bottom, 0xff2e86, 0.12, false);

    for (const m of [visualTop, visualBottom, physTop, physBottom, dropTop, dropBottom]) {
        if (!m) continue;
        scene.add(m);
        storyBridgeSceneMeshes.push(m);
    }
}

function addStoryBridgeVisualWaterCap(
    shapeGeometry,
    yBase = SIMPLE_WATER_SURFACE_Y,
    centerX = 0,
    centerZ = STORY_BRIDGE_Z,
    sceneMeshBucket = null,
    levelRole = 'bridge',
    forceTintCap = false
) {
    if (!WATER_SYSTEM_ENABLED || !shapeGeometry) return null;
    const meshBucket = Array.isArray(sceneMeshBucket) ? sceneMeshBucket : storyBridgeSceneMeshes;
    const showLevelWater = devWaterFxEnabled && !isLevelRoleSuppressed(levelRole);
    const useLibrarySurface = WATER_USE_THREEJS_LIBRARY_WATER
        && (levelRole !== 'bridge' || BRIDGE_WATER_USE_LIBRARY_SURFACE);
    let libraryWater = null;
    const readableWaterColor = getReadableWaterColor(waterFxColor);

    if (useLibrarySurface) {
        const pixelRatio = renderer?.getPixelRatio ? renderer.getPixelRatio() : 1;
        const texW = Math.max(128, Math.floor(window.innerWidth * pixelRatio * WATER_PLANAR_REFLECTION_RESOLUTION_SCALE));
        const texH = Math.max(128, Math.floor(window.innerHeight * pixelRatio * WATER_PLANAR_REFLECTION_RESOLUTION_SCALE));
        const waterNormals = waterNormalA || makeWaterNormalMap();
        if (waterNormals) {
            waterNormals.wrapS = THREE.RepeatWrapping;
            waterNormals.wrapT = THREE.RepeatWrapping;
        }

        // ShapeGeometry UVs can be uneven on irregular shorelines; remap to a
        // simple planar UV so Water distortion stays subtle and stable.
        const waterGeo = shapeGeometry.clone();
        const pos = waterGeo.attributes?.position;
        if (pos) {
            waterGeo.computeBoundingBox();
            const bb = waterGeo.boundingBox;
            const minX = bb?.min?.x ?? -1;
            const minY = bb?.min?.y ?? -1;
            const spanX = Math.max(0.001, (bb?.max?.x ?? 1) - minX);
            const spanY = Math.max(0.001, (bb?.max?.y ?? 1) - minY);
            let uv = waterGeo.attributes.uv;
            if (!uv || uv.count !== pos.count) {
                uv = new THREE.Float32BufferAttribute(pos.count * 2, 2);
                waterGeo.setAttribute('uv', uv);
            }
            for (let i = 0; i < pos.count; i++) {
                const x = pos.getX(i);
                const y = pos.getY(i);
                uv.setXY(i, (x - minX) / spanX, (y - minY) / spanY);
            }
            uv.needsUpdate = true;
        }

        libraryWater = new Water(waterGeo, {
            textureWidth: texW,
            textureHeight: texH,
            waterNormals,
            sunDirection: sunDir.clone().normalize(),
            sunColor: 0xffffff,
            waterColor: readableWaterColor.getHex(),
            distortionScale: isMobileProfile ? 0.22 : 0.30,
            fog: !!scene.fog,
            alpha: Math.max(0.12, Math.min(0.92, waterFxOpacity * 0.72)),
        });
        libraryWater.rotation.x = -Math.PI / 2;
        libraryWater.position.set(centerX, yBase - 0.006, centerZ);
        libraryWater.name = `libraryWater-${levelRole}`;
        libraryWater.visible = showLevelWater;
        libraryWater.receiveShadow = false;
        // Ring-shaped ShapeGeometry can wind opposite between levels.
        // Render both sides so castle moat water never disappears from top view.
        if (libraryWater.material) {
            libraryWater.material.side = THREE.DoubleSide;
        }
        libraryWater.frustumCulled = false;
        libraryWater.userData = libraryWater.userData || {};
        libraryWater.userData.waterRole = levelRole;
        if (libraryWater.material?.uniforms?.size) {
            libraryWater.material.uniforms.size.value = WATER_LIBRARY_WAVE_SIZE;
        }
        scene.add(libraryWater);
        meshBucket.push(libraryWater);
        bridgeLibraryWaterSurfaces.push(libraryWater);
    }

    // Optional tinted top cap. Keep this off for bridge by default when murky
    // overlay is disabled, but allow per-level forcing (castle moat) so the
    // surface remains readable in all camera angles.
    if (!SIMPLE_MURKY_WATER_OVERLAY && !forceTintCap) return libraryWater;

    const capMat = waterUnderlayMat ? waterUnderlayMat.clone() : new THREE.MeshStandardMaterial({
        color: readableWaterColor.getHex(),
        roughness: MURKY_WATER_ROUGHNESS,
        metalness: MURKY_WATER_REFLECTIVITY,
        envMapIntensity: MURKY_WATER_ENV_INTENSITY,
        transparent: true,
        opacity: Math.min(MURKY_WATER_CAP_OPACITY, Math.max(0.08, waterFxOpacity * 0.85)),
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const capOpacityMax = useLibrarySurface ? 0.50 : MURKY_WATER_CAP_OPACITY;
    capMat.transparent = true;
    capMat.userData = capMat.userData || {};
    capMat.userData.forceTintCap = !!forceTintCap;
    capMat.userData.waterCapOpacityMax = capOpacityMax;
    capMat.opacity = Math.min(capMat.opacity ?? MURKY_WATER_CAP_OPACITY, capOpacityMax);
    capMat.depthWrite = false;
    // With planar mirror enabled, keep the top tint murky and avoid stacking
    // additional environment reflections that can re-introduce scale artifacts.
    if (useLibrarySurface) {
        capMat.metalness = 0.02;
        capMat.roughness = 0.90;
        capMat.envMapIntensity = 0.0;
        capMat.opacity = Math.min(capMat.opacity ?? MURKY_WATER_CAP_OPACITY, 0.50);
    }
    if (!useLibrarySurface && levelRole === 'bridge' && forceTintCap) {
        // Solid cap avoids the persistent bright shoreline seam produced by
        // transparent shader edges on this irregular bridge-water shape.
        capMat.transparent = false;
        capMat.opacity = 1.0;
        capMat.depthWrite = true;
        capMat.metalness = 0.0;
        capMat.roughness = 0.96;
        capMat.envMapIntensity = 0.0;
        capMat.polygonOffset = false;
        capMat.polygonOffsetFactor = 0;
        capMat.polygonOffsetUnits = 0;
        capMat.map = null;
    }
    if (forceTintCap && !SIMPLE_MURKY_WATER_OVERLAY) {
        const readableTint = readableWaterColor.clone().lerp(new THREE.Color(MURKY_WATER_COLOR), 0.72);
        capMat.color.copy(readableTint);
        capMat.opacity = Math.max(capMat.opacity ?? 0.34, 0.34);
        capMat.polygonOffset = true;
        capMat.polygonOffsetFactor = -1;
        capMat.polygonOffsetUnits = -1;
    }
    registerWaterReflectionMaterial(capMat);
    storyWaterCapMaterials.push(capMat);

    const cap = new THREE.Mesh(shapeGeometry.clone(), capMat);
    cap.name = `waterTintCap-${levelRole}`;
    cap.userData = cap.userData || {};
    cap.userData.waterRole = levelRole;
    storyWaterCapMeshes.push(cap);
    cap.rotation.x = -Math.PI / 2;
    cap.position.set(centerX, yBase, centerZ);
    cap.visible = showLevelWater;
    if (forceTintCap) cap.renderOrder = 3;
    cap.receiveShadow = false;
    registerWaterReflectionMesh(cap);
    scene.add(cap);
    meshBucket.push(cap);
    return cap;
}

function addHorseVisualToNpc(npc, tint = 0x7f5a39) {
    if (!npc || !npc.group) return;
    const horse = new THREE.Group();
    const hideMat = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.9, metalness: 0.0 });
    const maneMat = new THREE.MeshStandardMaterial({ color: 0x2a211a, roughness: 0.95, metalness: 0.0 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.62, 0.5), hideMat);
    body.position.set(0, 0.42, -0.25);
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.54, 0.3), hideMat);
    neck.position.set(0.53, 0.68, -0.25);
    neck.rotation.z = -0.28;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.26, 0.24), hideMat);
    head.position.set(0.74, 0.89, -0.22);
    const mane = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.4, 0.18), maneMat);
    mane.position.set(0.54, 0.84, -0.26);

    const legGeo = new THREE.BoxGeometry(0.14, 0.7, 0.14);
    const legPos = [
        [-0.43, 0.02, -0.07],
        [0.22, 0.02, -0.07],
        [-0.43, 0.02, -0.43],
        [0.22, 0.02, -0.43],
    ];
    for (const [lx, ly, lz] of legPos) {
        const leg = new THREE.Mesh(legGeo, hideMat);
        leg.position.set(lx, ly, lz);
        horse.add(leg);
    }

    horse.add(body, neck, head, mane);
    horse.position.set(0, 0, 0.24);
    horse.rotation.y = -Math.PI / 2;
    horse.castShadow = true;
    npc.group.add(horse);
    npc.horseVisual = horse;
}

function buildStoryBridgeEncounter() {
    if (storyBridgeBuilt) return;
    storyBridgeBuilt = true;

    const markStoryBridgeBody = (body) => {
        if (!body) return;
        body._storyRole = 'bridge';
        storyBridgeSceneBodies.push(body);
    };
    const syncBridgeBodySuppression = (body) => {
        if (!body) return;
        const shouldAttach = body._bridgeAttachWhenSuppressed ? storyBridgeSuppressed : !storyBridgeSuppressed;
        if (shouldAttach) attachStoryBody(body);
        else detachStoryBody(body);
    };

    const addStoryBridgeGroundBody = (cx, cz, w, d, topY = 0.02) => {
        if (w <= 0.02 || d <= 0.02) return null;
        const T = 30;
        const body = new CANNON.Body({
            mass: 0,
            material: brickPhysMat,
            shape: new CANNON.Box(new CANNON.Vec3(w * 0.5, T * 0.5, d * 0.5)),
        });
        body.position.set(cx, topY - T * 0.5, cz);
        world.addBody(body);
        markStoryBridgeBody(body);
        return body;
    };

    // Fill the old castle-moat footprint (and buffer) while leaving a wide
    // opening where bridge-mode water sits, so submerged water remains visible.
    const patchCx = (M_OX1 + M_OX2) / 2;
    const patchCz = (M_OZ1 + M_OZ2) / 2;
    const patchW = (M_OX2 - M_OX1) + 80;
    const patchD = (M_OZ2 - M_OZ1) + 120;
    const addBridgeGroundPatch = (cx, cz, w, d, mat = grassMat) => {
        if (w <= 0.02 || d <= 0.02) return;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
        m.name = 'bridgeGroundPatch';
        m.rotation.x = -Math.PI / 2;
        m.position.set(cx, 0.02, cz);
        m.receiveShadow = true;
        m.userData = m.userData || {};
        m.userData.bridge2GroundPatch = true;
        m.userData.bridge2KeepVisible = true;
        scene.add(m);
        storyBridgeSceneMeshes.push(m);
        addStoryBridgeGroundBody(cx, cz, w, d, 0.02);
    };
    const shorelineSamples = isMobileProfile ? 64 : 128;
    const shorelineEdge = sampleStoryBridgeShorelineEdgePolyline(shorelineSamples);
    const bridgeWaterBandMinZ = STORY_BRIDGE_Z - STORY_BRIDGE_WATER_VISUAL_HALF_Z;
    const bridgeWaterBandMaxZ = STORY_BRIDGE_Z + STORY_BRIDGE_WATER_VISUAL_HALF_Z;
    // Base patches stop exactly at the rectangular visual band edge; inside the
    // band the curved grass shore fill exclusively owns [band edge ? shoreline].
    // (Extending patches to the shoreline min/max made them coplanar with the
    // shore fill over a wide band ? draw-order z-fighting ? flickering rectangle.)
    const bridgeBandMinZ = bridgeWaterBandMinZ;
    const bridgeBandMaxZ = bridgeWaterBandMaxZ;
    // Four strips around the bridge-water opening.
    const patchMinX = patchCx - patchW * 0.5;
    const patchMaxX = patchCx + patchW * 0.5;
    const patchFrontMinZ = patchCz - patchD * 0.5;
    const patchBackMaxZ = patchCz + patchD * 0.5;
    const sideLeftW = Math.max(0, STORY_BRIDGE_WATER_MIN_X - patchMinX);
    const sideRightW = Math.max(0, patchMaxX - STORY_BRIDGE_WATER_MAX_X);
    const frontD = Math.max(0, bridgeBandMinZ - patchFrontMinZ);
    const backD = Math.max(0, patchBackMaxZ - bridgeBandMaxZ);
    const frontCz = patchFrontMinZ + frontD * 0.5;
    const backCz = patchBackMaxZ - backD * 0.5;
    if (!bridge2ModeActive) {
        addBridgeGroundPatch(patchCx, frontCz, patchW, frontD);
        addBridgeGroundPatch(patchCx, backCz, patchW, backD);
    } else {
        // In Bridge2, keep the trench opening clear: only fill front/back
        // outside the trench span instead of dropping full-width rectangles.
        const trenchCutMinX = -STORY_BRIDGE_TRENCH_HALF_X;
        const trenchCutMaxX = STORY_BRIDGE_TRENCH_HALF_X;
        const frontBackLeftW = Math.max(0, trenchCutMinX - patchMinX);
        const frontBackRightW = Math.max(0, patchMaxX - trenchCutMaxX);

        if (frontBackLeftW > 0.02) {
            const leftCx = patchMinX + frontBackLeftW * 0.5;
            addBridgeGroundPatch(leftCx, frontCz, frontBackLeftW, frontD);
            addBridgeGroundPatch(leftCx, backCz, frontBackLeftW, backD);
        }
        if (frontBackRightW > 0.02) {
            const rightCx = trenchCutMaxX + frontBackRightW * 0.5;
            addBridgeGroundPatch(rightCx, frontCz, frontBackRightW, frontD);
            addBridgeGroundPatch(rightCx, backCz, frontBackRightW, backD);
        }
    }

    const sideMinZ = bridgeBandMinZ;
    const sideMaxZ = bridgeBandMaxZ;
    const sideD = Math.max(0.02, sideMaxZ - sideMinZ);
    const sideCenterZ = (sideMinZ + sideMaxZ) * 0.5;
    addBridgeGroundPatch(
        patchMinX + sideLeftW * 0.5,
        sideCenterZ,
        sideLeftW,
        sideD
    );
    addBridgeGroundPatch(
        STORY_BRIDGE_WATER_MAX_X + sideRightW * 0.5,
        sideCenterZ,
        sideRightW,
        sideD
    );

    if (bridge2ModeActive) {
        // Fill sky-bleed gaps left by hidden castle-role ground strips.
        // 1. Endpoint x-strips: ±[STORY_BRIDGE_TRENCH_HALF_X … STORY_BRIDGE_WATER_MAX_X]
        //    The side patches end at BRIDGE_WATER_MIN/MAX_X; the trench edge is
        //    slightly inside that, leaving a narrow uncovered band.
        const trenchEdgeL = -STORY_BRIDGE_TRENCH_HALF_X;
        const trenchEdgeR =  STORY_BRIDGE_TRENCH_HALF_X;
        const endGapLW = Math.max(0, trenchEdgeL - STORY_BRIDGE_WATER_MIN_X);
        const endGapRW = Math.max(0, STORY_BRIDGE_WATER_MAX_X - trenchEdgeR);
        if (endGapLW > 0.01) {
            addBridgeGroundPatch(
                (STORY_BRIDGE_WATER_MIN_X + trenchEdgeL) * 0.5,
                sideCenterZ, endGapLW + 0.2, sideD + 0.4
            );
        }
        if (endGapRW > 0.01) {
            addBridgeGroundPatch(
                (trenchEdgeR + STORY_BRIDGE_WATER_MAX_X) * 0.5,
                sideCenterZ, endGapRW + 0.2, sideD + 0.4
            );
        }
        // 2. Moat-margin strips: x ±[_MOX2 … BRIDGE_WATER_MIN/MAX_X], full band Z.
        //    These were castle-role addGround strips, hidden in bridge2 mode.
        //    The lake apron/rim only samples from trenchX1→trenchX2, so the
        //    margin band (x –35.5→–29 and 29→35.5) has no coverage.
        const moatMarginW = Math.max(0, STORY_BRIDGE_WATER_MIN_X - _MOX1) + 0.2;
        if (moatMarginW > 0.2) {
            addBridgeGroundPatch(
                (_MOX1 + STORY_BRIDGE_WATER_MIN_X) * 0.5,
                sideCenterZ, moatMarginW, sideD + 0.4
            );
            addBridgeGroundPatch(
                (_MOX2 + STORY_BRIDGE_WATER_MAX_X) * 0.5,
                sideCenterZ, moatMarginW, sideD + 0.4
            );
        }
    }

    if (WATER_SYSTEM_ENABLED && BRIDGE_CHANNEL_WATER_ENABLED && !bridge2ModeActive) {
        // Water and shore now share one sampled shoreline edge, so the join is
        // exact and stable from all viewing angles.
        const shoreLeftGeo = makeStoryBridgeShoreShapeGeometry(-1, shorelineEdge);
        const shoreRightGeo = makeStoryBridgeShoreShapeGeometry(1, shorelineEdge);
        const addStoryBridgeShoreFill = (geo) => {
            if (!geo) return;
            // Grass runs all the way to the waterline: the old mud fill drew a
            // large dark-brown rectangle around the whole trench. Rescale the
            // ShapeGeometry UVs (local metres) to roughly match surrounding
            // grass texel density before applying the shared grass material.
            const uvAttr = geo.attributes.uv;
            if (uvAttr) {
                for (let i = 0; i < uvAttr.count; i++) {
                    uvAttr.setXY(i, uvAttr.getX(i) * 0.006, uvAttr.getY(i) * 0.006);
                }
                uvAttr.needsUpdate = true;
            }
            const m = new THREE.Mesh(geo, grassMat);
            m.name = 'bridgeShoreFillGrass';
            m.rotation.x = -Math.PI / 2;
            m.position.set(0, 0.02, STORY_BRIDGE_Z);
            m.receiveShadow = true;
            scene.add(m);
            storyBridgeSceneMeshes.push(m);
        };
        const addStoryBridgeShoreColliders = (edgeData = shorelineEdge) => {
            const topPts = edgeData?.topWorld || [];
            const bottomPts = edgeData?.bottomWorld || [];
            const n = Math.min(topPts.length, bottomPts.length);
            if (n < 2) return;

            // Match the visual layout: patch colliders end at the visual band
            // edge, so shore colliders fill [band edge ? shoreline].
            const bandMinZ = bridgeWaterBandMinZ;
            const bandMaxZ = bridgeWaterBandMaxZ;
            for (let i = 0; i < n - 1; i++) {
                const frontP0 = bottomPts[i];
                const frontP1 = bottomPts[i + 1];
                const backP0 = topPts[i];
                const backP1 = topPts[i + 1];
                const xMid = (frontP0.x + frontP1.x) * 0.5;
                const segW = Math.max(0.02, Math.abs(frontP1.x - frontP0.x));
                const frontEdgeZ = (frontP0.z + frontP1.z) * 0.5;
                const backEdgeZ = (backP0.z + backP1.z) * 0.5;

                const frontD = frontEdgeZ - bandMinZ;
                if (frontD > 0.02) {
                    addStoryBridgeGroundBody(xMid, bandMinZ + frontD * 0.5, segW, frontD, 0.02);
                }

                const backD = bandMaxZ - backEdgeZ;
                if (backD > 0.02) {
                    addStoryBridgeGroundBody(xMid, backEdgeZ + backD * 0.5, segW, backD, 0.02);
                }
            }
        };
        addStoryBridgeShoreFill(shoreLeftGeo);
        addStoryBridgeShoreFill(shoreRightGeo);
        addStoryBridgeShoreColliders();

        // Mud waterline skirt: the grass shore plane (y�0.02) and the visual
        // water sheet (SIMPLE_WATER_SURFACE_Y � -0.27) share the same shoreline
        // polyline but different heights, leaving an open ~0.3 m vertical ring
        // between them. At shallow view angles that ring exposed the skybox �
        // the "white rim mirroring clouds" (cursor-probe rays escaped to the
        // sky box at x�500). Seal it with a continuous muddy bank ribbon that
        // leans from just under the grass lip down through the water sheet,
        // reading as a dirty rocky shore leading into the lake.
        const bridgeShoreMudMat = new THREE.MeshStandardMaterial({
            map: makeMudTexture(),
            color: 0x77684c,
            roughness: 0.97,
            metalness: 0.0,
            side: THREE.DoubleSide,
        });
        const addStoryBridgeWaterlineSkirt = (edgePoints, sideHint) => {
            if (!edgePoints || edgePoints.length < 2) return;
            const pos = [];
            const uv = [];
            const idx = [];
            let dist = 0;
            for (let i = 0; i < edgePoints.length; i++) {
                const p = edgePoints[i];
                if (i > 0) {
                    const prev = edgePoints[i - 1];
                    dist += Math.hypot(p.x - prev.x, p.z - prev.z);
                }
                const centerZ = getStoryBridgeWaterProfileAtX(p.x).centerZ;
                let inward = Math.sign(centerZ - p.z);
                if (inward === 0) inward = sideHint;
                // Wobble keeps the bank hand-formed instead of extruded.
                const wob = Math.sin(p.x * 0.31 + inward * 0.9) * 0.18
                          + Math.sin(p.x * 0.073 + 1.7) * 0.12;
                const topZ = p.z - inward * 0.14;          // tucked under the grass lip
                const botZ = p.z + inward * (0.85 + wob);  // leans into the water
                pos.push(p.x, 0.034, topZ,
                         p.x, SIMPLE_WATER_SURFACE_Y - 0.30, botZ);
                uv.push(dist * 0.2, 0, dist * 0.2, 1);
            }
            for (let i = 0; i < edgePoints.length - 1; i++) {
                const a = i * 2;
                const b = a + 1;
                const c = a + 2;
                const d = a + 3;
                idx.push(a, c, d, a, d, b);
            }
            if (idx.length < 6) return;
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
            geo.setIndex(idx);
            geo.computeVertexNormals();
            const skirt = new THREE.Mesh(geo, bridgeShoreMudMat);
            skirt.receiveShadow = true;
            scene.add(skirt);
            storyBridgeSceneMeshes.push(skirt);
        };
        addStoryBridgeWaterlineSkirt(shorelineEdge?.topWorld, -1);
        addStoryBridgeWaterlineSkirt(shorelineEdge?.bottomWorld, 1);

        // Water-mouth grass caps: the shore-fill shapes only span the shoreline
        // polyline's x-range (first?last sample with halfWidth > 0, ~�34.1),
        // but the water band extends to �35.5. Those mouth margins had no
        // bridge-mode visual at all once the old (fall-through) base grass was
        // carved away � a skybox stripe along x�-35 toward the bridge. Cap them
        // with grass at y=0.012 (under the 0.02 shore fill so the small overlap
        // never z-fights) plus solid ground colliders. Entirely outside the
        // water shape (halfWidth is 0 there), so gameplay water is unaffected.
        {
            const topPts = shorelineEdge?.topWorld || [];
            const bandD = bridgeWaterBandMaxZ - bridgeWaterBandMinZ;
            const bandCz = (bridgeWaterBandMinZ + bridgeWaterBandMaxZ) * 0.5;
            const addMouthCap = (x1, x2) => {
                const w = x2 - x1;
                if (w <= 0.02) return;
                const m = new THREE.Mesh(new THREE.PlaneGeometry(w, bandD), grassMat);
                m.name = 'bridgeWaterMouthCap';
                m.rotation.x = -Math.PI / 2;
                m.position.set((x1 + x2) * 0.5, 0.012, bandCz);
                m.receiveShadow = true;
                scene.add(m);
                storyBridgeSceneMeshes.push(m);
                addStoryBridgeGroundBody((x1 + x2) * 0.5, bandCz, w, bandD, 0.012);
            };
            if (topPts.length >= 2) {
                addMouthCap(STORY_BRIDGE_WATER_MIN_X, topPts[0].x + 0.45);
                addMouthCap(topPts[topPts.length - 1].x - 0.45, STORY_BRIDGE_WATER_MAX_X);
            }
        }

        const bridgeWaterGeo = makeStoryBridgeWaterShapeGeometry(shorelineEdge);
        // Bridge-level water: shaped body that matches gameplay water checks.
        const bridgeWaterY = STORY_BRIDGE_WATER_Y;
        addWaterShapePlane(bridgeWaterGeo, 0, STORY_BRIDGE_Z, 'bridge', bridgeWaterY);
        // Visual top sheet: keeps the visible water graphic aligned to the
        // same curved boundary, even where terrain sits above trench depth.
        addStoryBridgeVisualWaterCap(
            bridgeWaterGeo,
            SIMPLE_WATER_SURFACE_Y,
            0,
            STORY_BRIDGE_Z,
            storyBridgeSceneMeshes,
            'bridge',
            true
        );
    } else {
        // Dry bridge trench/lake: use the same visible moat-style construction
        // (bank walls + mud floor) so the span has a carved lake to cross.
        const trenchX1 = -STORY_BRIDGE_TRENCH_HALF_X;
        const trenchX2 = STORY_BRIDGE_TRENCH_HALF_X;
        const trenchDepth = WATER_DEPTH_M * 2;
        const trenchBankY = -trenchDepth * 0.5 - 0.02;
        const trenchWallT = 0.35;
        // Keep trench framing stable and symmetric in dry/Bridge2 modes.
        // Shared-edge shoreline bounds are only used in the wet seam path.
        const bandMinZ = bridgeWaterBandMinZ;
        const bandMaxZ = bridgeWaterBandMaxZ;
        const trenchSpanX = Math.max(0.001, trenchX2 - trenchX1);
        const bridge2TrenchWallMat = bridge2ModeActive
            ? new THREE.MeshStandardMaterial({
                map: makeMudTexture(),
                bumpMap: stoneBumpMap,
                bumpScale: 0.02,
                color: 0x86785f,
                roughness: 0.95,
                metalness: 0.0,
            })
            : bankMat;
        const bridge2TrenchFloorMat = bridge2ModeActive
            ? new THREE.MeshStandardMaterial({
                map: makeMudTexture(),
                bumpMap: stoneBumpMap,
                bumpScale: 0.012,
                color: 0x6f6048,
                roughness: 0.98,
                metalness: 0.0,
                side: THREE.DoubleSide,
            })
            : mudMat;
        const bridge2TrenchShoulderMat = bridge2ModeActive
            ? new THREE.MeshStandardMaterial({
                map: makeMudTexture(),
                color: 0x7b6c52,
                roughness: 0.96,
                metalness: 0.0,
                side: THREE.DoubleSide,
            })
            : bridge2TrenchFloorMat;

        const getLakeProfileAtX = (x) => {
            if (bridge2ModeActive) {
                const p = getStoryBridgeWaterProfileAtX(x);
                const visualHalf = THREE.MathUtils.clamp(
                    p.halfWidth + BRIDGE_WATER_VISUAL_OUTSET,
                    0,
                    STORY_BRIDGE_WATER_VISUAL_HALF_Z - 0.2
                );
                return { centerZ: p.centerZ, halfWidth: visualHalf };
            }
            return { centerZ: STORY_BRIDGE_Z, halfWidth: getStoryBridgeTrenchHalfWidthAtX(x) };
        };

        // Side wings are already covered by the base side strips created above.
        // Adding them again here causes coplanar overlap (visible square seams).

        // Fill the center band around the irregular lake outline.
        // Bridge2 relies on shoulders + trench floor and outer strips; skip
        // this segmented filler pass there to avoid hard lip artifacts.
        if (!bridge2ModeActive) {
            const shoreSegs = isMobileProfile ? 16 : 24;
            const shoreFillInset = 0;
            for (let i = 0; i < shoreSegs; i++) {
                const t0 = i / shoreSegs;
                const t1 = (i + 1) / shoreSegs;
                const x0 = trenchX1 + trenchSpanX * t0;
                const x1 = trenchX1 + trenchSpanX * t1;
                const xMid = (x0 + x1) * 0.5;
                const segW = Math.max(0.02, x1 - x0);
                const profile = getLakeProfileAtX(xMid);
                const frontEdgeZ = profile.centerZ - profile.halfWidth;
                const backEdgeZ = profile.centerZ + profile.halfWidth;

                const frontD = (frontEdgeZ + shoreFillInset) - bandMinZ;
                if (frontD > 0.02) {
                    addBridgeGroundPatch(xMid, bandMinZ + frontD * 0.5, segW, frontD);
                }

                const backD = bandMaxZ - (backEdgeZ - shoreFillInset);
                if (backD > 0.02) {
                    addBridgeGroundPatch(xMid, (backEdgeZ - shoreFillInset) + backD * 0.5, segW, backD);
                }
            }
        }

        const addBridgeTrenchWall = (cx, cy, cz, w, h, d) => {
            const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bridge2TrenchWallMat);
            wall.position.set(cx, cy, cz);
            wall.castShadow = true;
            wall.receiveShadow = true;
            wall.userData = wall.userData || {};
            wall.userData.bridge2KeepVisible = true;
            scene.add(wall);
            storyBridgeSceneMeshes.push(wall);
        };

        const lakeSamples = isMobileProfile ? 34 : 66;
        const lakeTop = [];
        const lakeBottom = [];
        const lakeTopWorld = [];
        const lakeBottomWorld = [];
        for (let i = 0; i <= lakeSamples; i++) {
            const t = i / lakeSamples;
            const x = trenchX1 + trenchSpanX * t;
            const profile = getLakeProfileAtX(x);
            const topZ = profile.centerZ + profile.halfWidth;
            const bottomZ = profile.centerZ - profile.halfWidth;
            lakeTop.push(new THREE.Vector2(x, STORY_BRIDGE_Z - topZ));
            lakeBottom.push(new THREE.Vector2(x, STORY_BRIDGE_Z - bottomZ));
            lakeTopWorld.push(new THREE.Vector3(x, 0, topZ));
            lakeBottomWorld.push(new THREE.Vector3(x, 0, bottomZ));
        }

        const bridge2ApronInnerBase = 3.5;
        const bridge2ApronOuterBase = 9.5;
        const getBridge2GrassApronSpansAt = (x, dir) => {
            const wobble =
                Math.sin(x * 0.14 + dir * 1.1) * 0.45 +
                Math.sin(x * 0.033 + 0.8) * 0.28;
            return {
                inner: bridge2ApronInnerBase + wobble * 0.35,
                outer: bridge2ApronOuterBase + wobble,
            };
        };

        if (bridge2ModeActive) {
            // Curved center-bank fill closes the remaining exposed "void"
            // between the new shoreline apron and the far front/back terrain.
            const fillSegs = isMobileProfile ? 28 : 48;
            const fillX1 = STORY_BRIDGE_WATER_MIN_X;
            const fillX2 = STORY_BRIDGE_WATER_MAX_X;
            const fillSpanX = Math.max(0.001, fillX2 - fillX1);
            for (let i = 0; i < fillSegs; i++) {
                const t0 = i / fillSegs;
                const t1 = (i + 1) / fillSegs;
                const x0 = fillX1 + fillSpanX * t0;
                const x1 = fillX1 + fillSpanX * t1;
                const xMid = (x0 + x1) * 0.5;
                const segW = Math.max(0.02, x1 - x0);
                const profile = getLakeProfileAtX(xMid);

                const frontApron = getBridge2GrassApronSpansAt(xMid, -1).outer + 0.55;
                const backApron = getBridge2GrassApronSpansAt(xMid, 1).outer + 0.55;
                const frontOuterZ = profile.centerZ - (profile.halfWidth + frontApron);
                const backOuterZ = profile.centerZ + (profile.halfWidth + backApron);

                const frontFillD = frontOuterZ - patchFrontMinZ;
                if (frontFillD > 0.02) {
                    addBridgeGroundPatch(xMid, patchFrontMinZ + frontFillD * 0.5, segW, frontFillD);
                }

                const backFillD = patchBackMaxZ - backOuterZ;
                if (backFillD > 0.02) {
                    addBridgeGroundPatch(xMid, backOuterZ + backFillD * 0.5, segW, backFillD);
                }
            }
        }

        const addBridgeLakeGrassRim = (edgePoints, sideHint = 1) => {
            if (!bridge2ModeActive || !edgePoints || edgePoints.length < 2) return;
            const rimInner = -0.55;
            const rimOuterBase = 4.1;
            const pos = [];
            const uv = [];
            const idx = [];
            let dist = 0;

            for (let i = 0; i < edgePoints.length; i++) {
                const p = edgePoints[i];
                if (i > 0) {
                    const prev = edgePoints[i - 1];
                    dist += Math.hypot(p.x - prev.x, p.z - prev.z);
                }
                const centerZ = getLakeProfileAtX(p.x).centerZ;
                let dir = Math.sign(p.z - centerZ);
                if (dir === 0) dir = sideHint;

                const rimNoise =
                    Math.sin(p.x * 0.18 + dir * 0.7) * 0.28 +
                    Math.sin(p.x * 0.041 + 1.2) * 0.16;
                const outerSpan = rimOuterBase + rimNoise;

                const innerX = p.x;
                const innerY = 0.026;
                const innerZ = p.z + dir * rimInner;
                const outerX = p.x;
                const outerY = 0.034;
                const outerZ = p.z + dir * outerSpan;

                pos.push(innerX, innerY, innerZ, outerX, outerY, outerZ);
                uv.push(dist * 0.18, 0, dist * 0.18, 1);
            }

            for (let i = 0; i < edgePoints.length - 1; i++) {
                const a = i * 2;
                const b = a + 1;
                const c = a + 2;
                const d = a + 3;
                idx.push(a, c, d, a, d, b);
            }

            if (idx.length < 6) return;
            const rimGeo = new THREE.BufferGeometry();
            rimGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            rimGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
            rimGeo.setIndex(idx);
            rimGeo.computeVertexNormals();

            const rim = new THREE.Mesh(rimGeo, grassMat);
            rim.receiveShadow = true;
            rim.userData = rim.userData || {};
            rim.userData.bridge2KeepVisible = true;
            rim.userData.bridge2GroundPatch = true;
            scene.add(rim);
            storyBridgeSceneMeshes.push(rim);

            // Add a matching collision shelf so impacts roll a bit farther onto
            // the grassed bank before dropping into the trench.
            for (let i = 0; i < edgePoints.length - 1; i++) {
                const p0 = edgePoints[i];
                const p1 = edgePoints[i + 1];
                const segW = Math.max(0.02, Math.abs(p1.x - p0.x));
                const xMid = (p0.x + p1.x) * 0.5;

                const c0 = getLakeProfileAtX(p0.x).centerZ;
                const c1 = getLakeProfileAtX(p1.x).centerZ;
                let d0 = Math.sign(p0.z - c0);
                let d1 = Math.sign(p1.z - c1);
                if (d0 === 0) d0 = sideHint;
                if (d1 === 0) d1 = sideHint;

                const n0 =
                    Math.sin(p0.x * 0.18 + d0 * 0.7) * 0.28 +
                    Math.sin(p0.x * 0.041 + 1.2) * 0.16;
                const n1 =
                    Math.sin(p1.x * 0.18 + d1 * 0.7) * 0.28 +
                    Math.sin(p1.x * 0.041 + 1.2) * 0.16;
                const outer0 = rimOuterBase + n0;
                const outer1 = rimOuterBase + n1;

                const innerZ0 = p0.z + d0 * rimInner;
                const outerZ0 = p0.z + d0 * outer0;
                const innerZ1 = p1.z + d1 * rimInner;
                const outerZ1 = p1.z + d1 * outer1;

                const zMin = Math.min(innerZ0, outerZ0, innerZ1, outerZ1);
                const zMax = Math.max(innerZ0, outerZ0, innerZ1, outerZ1);
                const segD = zMax - zMin;
                if (segD <= 0.03) continue;
                addStoryBridgeGroundBody(xMid, (zMin + zMax) * 0.5, segW, segD, 0.04);
            }
        };
        const addBridgeLakeGrassApron = (edgePoints, sideHint = 1) => {
            if (!bridge2ModeActive || !edgePoints || edgePoints.length < 2) return;
            const pos = [];
            const uv = [];
            const idx = [];
            let dist = 0;

            for (let i = 0; i < edgePoints.length; i++) {
                const p = edgePoints[i];
                if (i > 0) {
                    const prev = edgePoints[i - 1];
                    dist += Math.hypot(p.x - prev.x, p.z - prev.z);
                }
                const centerZ = getLakeProfileAtX(p.x).centerZ;
                let dir = Math.sign(p.z - centerZ);
                if (dir === 0) dir = sideHint;

                const spans = getBridge2GrassApronSpansAt(p.x, dir);
                const innerSpan = spans.inner;
                const outerSpan = spans.outer;

                const innerX = p.x;
                const innerY = 0.032;
                const innerZ = p.z + dir * innerSpan;
                const outerX = p.x;
                const outerY = 0.035;
                const outerZ = p.z + dir * outerSpan;

                pos.push(innerX, innerY, innerZ, outerX, outerY, outerZ);
                uv.push(dist * 0.1, 0, dist * 0.1, 1);
            }

            for (let i = 0; i < edgePoints.length - 1; i++) {
                const a = i * 2;
                const b = a + 1;
                const c = a + 2;
                const d = a + 3;
                idx.push(a, c, d, a, d, b);
            }

            if (idx.length < 6) return;
            const apronGeo = new THREE.BufferGeometry();
            apronGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            apronGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
            apronGeo.setIndex(idx);
            apronGeo.computeVertexNormals();

            const apron = new THREE.Mesh(apronGeo, grassMat);
            apron.receiveShadow = true;
            apron.userData = apron.userData || {};
            apron.userData.bridge2KeepVisible = true;
            apron.userData.bridge2GroundPatch = true;
            scene.add(apron);
            storyBridgeSceneMeshes.push(apron);

            // Keep physics aligned with the curved visual apron so projectiles
            // and debris don't fall through apparent "grass" coverage.
            for (let i = 0; i < edgePoints.length - 1; i++) {
                const p0 = edgePoints[i];
                const p1 = edgePoints[i + 1];
                const segW = Math.max(0.02, Math.abs(p1.x - p0.x));
                const xMid = (p0.x + p1.x) * 0.5;

                const c0 = getLakeProfileAtX(p0.x).centerZ;
                const c1 = getLakeProfileAtX(p1.x).centerZ;
                let d0 = Math.sign(p0.z - c0);
                let d1 = Math.sign(p1.z - c1);
                if (d0 === 0) d0 = sideHint;
                if (d1 === 0) d1 = sideHint;

                const s0 = getBridge2GrassApronSpansAt(p0.x, d0);
                const s1 = getBridge2GrassApronSpansAt(p1.x, d1);
                const innerZ0 = p0.z + d0 * s0.inner;
                const outerZ0 = p0.z + d0 * s0.outer;
                const innerZ1 = p1.z + d1 * s1.inner;
                const outerZ1 = p1.z + d1 * s1.outer;

                const zMin = Math.min(innerZ0, outerZ0, innerZ1, outerZ1);
                const zMax = Math.max(innerZ0, outerZ0, innerZ1, outerZ1);
                const segD = zMax - zMin;
                if (segD <= 0.04) continue;
                addStoryBridgeGroundBody(xMid, (zMin + zMax) * 0.5, segW, segD, 0.04);
            }
        };
        const addBridgeLakeSeamCap = (edgePoints, sideHint = 1) => {
            if (!bridge2ModeActive || !edgePoints || edgePoints.length < 2) return;
            const pos = [];
            const uv = [];
            const idx = [];
            let dist = 0;

            for (let i = 0; i < edgePoints.length; i++) {
                const p = edgePoints[i];
                if (i > 0) {
                    const prev = edgePoints[i - 1];
                    dist += Math.hypot(p.x - prev.x, p.z - prev.z);
                }
                const centerZ = getLakeProfileAtX(p.x).centerZ;
                let dir = Math.sign(p.z - centerZ);
                if (dir === 0) dir = sideHint;

                const spans = getBridge2GrassApronSpansAt(p.x, dir);
                const seamInner = spans.outer - 0.7;
                const seamOuter = spans.outer + 2.4;

                const innerX = p.x;
                const innerY = 0.036;
                const innerZ = p.z + dir * seamInner;
                const outerX = p.x;
                const outerY = 0.030;
                const outerZ = p.z + dir * seamOuter;

                pos.push(innerX, innerY, innerZ, outerX, outerY, outerZ);
                uv.push(dist * 0.09, 0, dist * 0.09, 1);
            }

            for (let i = 0; i < edgePoints.length - 1; i++) {
                const a = i * 2;
                const b = a + 1;
                const c = a + 2;
                const d = a + 3;
                idx.push(a, c, d, a, d, b);
            }

            if (idx.length < 6) return;
            const seamGeo = new THREE.BufferGeometry();
            seamGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            seamGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
            seamGeo.setIndex(idx);
            seamGeo.computeVertexNormals();

            const seam = new THREE.Mesh(seamGeo, grassMat);
            seam.receiveShadow = true;
            seam.userData = seam.userData || {};
            seam.userData.bridge2KeepVisible = true;
            seam.userData.bridge2GroundPatch = true;
            scene.add(seam);
            storyBridgeSceneMeshes.push(seam);

            for (let i = 0; i < edgePoints.length - 1; i++) {
                const p0 = edgePoints[i];
                const p1 = edgePoints[i + 1];
                const segW = Math.max(0.02, Math.abs(p1.x - p0.x));
                const xMid = (p0.x + p1.x) * 0.5;

                const c0 = getLakeProfileAtX(p0.x).centerZ;
                const c1 = getLakeProfileAtX(p1.x).centerZ;
                let d0 = Math.sign(p0.z - c0);
                let d1 = Math.sign(p1.z - c1);
                if (d0 === 0) d0 = sideHint;
                if (d1 === 0) d1 = sideHint;

                const s0 = getBridge2GrassApronSpansAt(p0.x, d0);
                const s1 = getBridge2GrassApronSpansAt(p1.x, d1);
                const innerZ0 = p0.z + d0 * (s0.outer - 0.7);
                const outerZ0 = p0.z + d0 * (s0.outer + 2.4);
                const innerZ1 = p1.z + d1 * (s1.outer - 0.7);
                const outerZ1 = p1.z + d1 * (s1.outer + 2.4);

                const zMin = Math.min(innerZ0, outerZ0, innerZ1, outerZ1);
                const zMax = Math.max(innerZ0, outerZ0, innerZ1, outerZ1);
                const segD = zMax - zMin;
                if (segD <= 0.04) continue;
                addStoryBridgeGroundBody(xMid, (zMin + zMax) * 0.5, segW, segD, 0.042);
            }
        };
        addBridgeLakeGrassRim(lakeTopWorld, 1);
        addBridgeLakeGrassRim(lakeBottomWorld, -1);
        addBridgeLakeGrassApron(lakeTopWorld, 1);
        addBridgeLakeGrassApron(lakeBottomWorld, -1);
        addBridgeLakeSeamCap(lakeTopWorld, 1);
        addBridgeLakeSeamCap(lakeBottomWorld, -1);

        const addBridgeLakeShoulder = (edgePoints, sideHint = 1) => {
            if (!bridge2ModeActive || !edgePoints || edgePoints.length < 2) return;
            const shoulderOutset = 0.35;
            const shoulderInset = 0.08;
            const pos = [];
            const uv = [];
            const idx = [];
            let dist = 0;

            for (let i = 0; i < edgePoints.length; i++) {
                const p = edgePoints[i];
                if (i > 0) {
                    const prev = edgePoints[i - 1];
                    dist += Math.hypot(p.x - prev.x, p.z - prev.z);
                }
                const centerZ = getLakeProfileAtX(p.x).centerZ;
                let dir = Math.sign(p.z - centerZ);
                if (dir === 0) dir = sideHint;

                const outerX = p.x;
                const outerY = 0.02;
                const outerZ = p.z + dir * shoulderOutset;
                const innerX = p.x;
                const innerY = -trenchDepth + 0.02;
                const innerZ = p.z - dir * shoulderInset;

                pos.push(outerX, outerY, outerZ, innerX, innerY, innerZ);
                uv.push(dist * 0.22, 0, dist * 0.22, 1);
            }

            for (let i = 0; i < edgePoints.length - 1; i++) {
                const a = i * 2;
                const b = a + 1;
                const c = a + 2;
                const d = a + 3;
                idx.push(a, c, d, a, d, b);
            }

            if (idx.length < 6) return;
            const shoulderGeo = new THREE.BufferGeometry();
            shoulderGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            shoulderGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
            shoulderGeo.setIndex(idx);
            shoulderGeo.computeVertexNormals();

            const shoulder = new THREE.Mesh(shoulderGeo, bridge2TrenchShoulderMat);
            shoulder.castShadow = true;
            shoulder.receiveShadow = true;
            shoulder.userData = shoulder.userData || {};
            shoulder.userData.bridge2KeepVisible = true;
            scene.add(shoulder);
            storyBridgeSceneMeshes.push(shoulder);
        };
        addBridgeLakeShoulder(lakeTopWorld, 1);
        addBridgeLakeShoulder(lakeBottomWorld, -1);

        // Bridge2 already uses segmented ground patching around the trench.
        // Avoid adding an extra rectangular infill mesh here; that sheet can
        // visually cover the trench opening.

        const buildBridgeLakeRibbonGeometry = (topPts, bottomPts, yWorld) => {
            const n = Math.min(topPts.length, bottomPts.length);
            if (n < 2) return null;
            const pos = [];
            const uv = [];
            const idx = [];
            let dist = 0;

            for (let i = 0; i < n; i++) {
                const tp = topPts[i];
                const bp = bottomPts[i];
                if (i > 0) {
                    const prev = topPts[i - 1];
                    dist += Math.hypot(tp.x - prev.x, tp.z - prev.z);
                }
                pos.push(tp.x, yWorld, tp.z, bp.x, yWorld, bp.z);
                uv.push(dist * 0.16, 0, dist * 0.16, 1);
            }

            for (let i = 0; i < n - 1; i++) {
                const a = i * 2;
                const b = a + 1;
                const c = a + 2;
                const d = a + 3;
                idx.push(a, c, d, a, d, b);
            }

            if (idx.length < 6) return null;
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
            geo.setIndex(idx);
            geo.computeVertexNormals();
            return geo;
        };

        const trenchFloorMeshGeo = buildBridgeLakeRibbonGeometry(lakeTopWorld, lakeBottomWorld, -trenchDepth);
        if (trenchFloorMeshGeo) {
            const trenchFloor = new THREE.Mesh(trenchFloorMeshGeo, bridge2TrenchFloorMat);
            trenchFloor.receiveShadow = true;
            trenchFloor.userData = trenchFloor.userData || {};
            trenchFloor.userData.bridge2KeepVisible = true;
            scene.add(trenchFloor);
            storyBridgeSceneMeshes.push(trenchFloor);
        }

        // Bridge2 visual under-bed: covers any exposed deep void under the
        // segmented trench/ground joins so no white "missing world" strips show.
        if (bridge2ModeActive) {
            const underBedGeo = buildBridgeLakeRibbonGeometry(lakeTopWorld, lakeBottomWorld, -trenchDepth - 0.08);
            if (underBedGeo) {
                const underBed = new THREE.Mesh(underBedGeo, bridge2TrenchFloorMat);
                underBed.receiveShadow = true;
                underBed.userData = underBed.userData || {};
                underBed.userData.bridge2KeepVisible = true;
                scene.add(underBed);
                storyBridgeSceneMeshes.push(underBed);
            }
        }

        const trenchFloorShape = new THREE.Shape(lakeTop.concat(lakeBottom.slice().reverse()));
        const trenchFloorGeo = new THREE.ShapeGeometry(trenchFloorShape, isMobileProfile ? 14 : 24);

        if (SIMPLE_MURKY_WATER_OVERLAY) {
            addStoryBridgeVisualWaterCap(trenchFloorGeo, SIMPLE_WATER_SURFACE_Y);
        }

        const addBridgeLakeBankFromEdge = (edgePoints) => {
            for (let i = 0; i < edgePoints.length - 1; i++) {
                const p0 = edgePoints[i];
                const p1 = edgePoints[i + 1];
                const dx = p1.x - p0.x;
                const dz = p1.z - p0.z;
                const segLen = Math.hypot(dx, dz);
                if (segLen < 0.25) continue;
                const wall = new THREE.Mesh(new THREE.BoxGeometry(segLen + 0.06, trenchDepth, trenchWallT), bridge2TrenchWallMat);
                wall.position.set((p0.x + p1.x) * 0.5, trenchBankY, (p0.z + p1.z) * 0.5);
                wall.rotation.y = Math.atan2(dx, dz);
                wall.castShadow = true;
                wall.receiveShadow = true;
                wall.userData = wall.userData || {};
                wall.userData.bridge2KeepVisible = true;
                scene.add(wall);
                storyBridgeSceneMeshes.push(wall);
            }
        };
        if (!bridge2ModeActive) {
            addBridgeLakeBankFromEdge(lakeTopWorld);
            addBridgeLakeBankFromEdge(lakeBottomWorld);

            const endLeft = getLakeProfileAtX(trenchX1 + 0.1);
            const endRight = getLakeProfileAtX(trenchX2 - 0.1);
            addBridgeTrenchWall(trenchX1, trenchBankY, endLeft.centerZ, trenchWallT, trenchDepth, endLeft.halfWidth * 2);
            addBridgeTrenchWall(trenchX2, trenchBankY, endRight.centerZ, trenchWallT, trenchDepth, endRight.halfWidth * 2);
        }

        // Moat-style floor colliders sampled across X so the uneven lake still
        // catches debris/NPC falls consistently.
        const floorSegs = isMobileProfile ? 12 : 20;
        for (let i = 0; i < floorSegs; i++) {
            const t0 = i / floorSegs;
            const t1 = (i + 1) / floorSegs;
            const x0 = trenchX1 + trenchSpanX * t0;
            const x1 = trenchX1 + trenchSpanX * t1;
            const xMid = (x0 + x1) * 0.5;
            const hw = Math.max(0.2, (x1 - x0) * 0.5);
            const profile = getLakeProfileAtX(xMid);
            const hd = Math.max(0.8, profile.halfWidth - 0.45);
            const trenchBody = new CANNON.Body({ mass: 0, material: brickPhysMat });
            trenchBody.addShape(new CANNON.Box(new CANNON.Vec3(hw, 0.15, hd)));
            trenchBody.position.set(xMid, -trenchDepth + 0.15, profile.centerZ);
            world.addBody(trenchBody);
            markStoryBridgeBody(trenchBody);
        }
    }

    // Mark bridge-related static geometry bodies (created before this function)
    // so stage suppression can detach them from physics when inactive.
    if (castleIslandGroundBody) {
        // Castle island should only be active when bridge stage is suppressed.
        castleIslandGroundBody._bridgeAttachWhenSuppressed = true;
        markStoryBridgeBody(castleIslandGroundBody);
        syncBridgeBodySuppression(castleIslandGroundBody);
    }
    for (const body of castleIslandStripBodies) {
        if (!body) continue;
        // The three extra strips around the King's Bunker footprint behave
        // exactly like the original island slab: castle-stage only.
        body._bridgeAttachWhenSuppressed = true;
        markStoryBridgeBody(body);
        syncBridgeBodySuppression(body);
    }
    for (const body of [bridgeFlankGroundBodyLeft, bridgeFlankGroundBodyRight,
                        bridgeCenterExtGroundBodyFront, bridgeCenterExtGroundBodyBack]) {
        if (!body) continue;
        // Bridge flank trench support must stay active during bridge stage.
        body._bridgeAttachWhenSuppressed = false;
        markStoryBridgeBody(body);
        syncBridgeBodySuppression(body);
    }
    for (const body of castleBridgeBandCoverBodies) {
        if (!body) continue;
        // Castle-grass covers over the trench rects: only while bridge stage
        // is suppressed, so the bridge river trench stays open in bridge mode.
        body._bridgeAttachWhenSuppressed = true;
        markStoryBridgeBody(body);
        syncBridgeBodySuppression(body);
    }

    addStoryBridgeWaterPerimeterDebug();

    // Keep bridge water visuals and gameplay footprint identical.

    // Low-poly valley framing and a road approach into the bridge crossing.
    const makeValleyRoadTexture = () => {
        const c = document.createElement('canvas');
        c.width = 256;
        c.height = 96;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#847a66';
        ctx.fillRect(0, 0, c.width, c.height);
        // Central worn path and subtle wheel tracks.
        const mid = c.height * 0.5;
        for (let x = 0; x < c.width; x += 2) {
            const wobble = Math.sin(x * 0.085) * 1.4;
            const rutA = mid - 14 + wobble;
            const rutB = mid + 14 - wobble;
            ctx.fillStyle = 'rgba(92,84,68,0.28)';
            ctx.fillRect(x, rutA, 2, 4);
            ctx.fillRect(x, rutB, 2, 4);
            ctx.fillStyle = 'rgba(190,178,152,0.10)';
            ctx.fillRect(x, mid - 7 + wobble * 0.5, 2, 14);
        }
        // Pebble/noise breakup.
        for (let i = 0; i < 1800; i++) {
            const x = Math.random() * c.width;
            const y = Math.random() * c.height;
            const v = 95 + (Math.random() * 55) | 0;
            ctx.fillStyle = `rgba(${v},${Math.max(0, v - 8)},${Math.max(0, v - 22)},${0.07 + Math.random() * 0.14})`;
            ctx.fillRect(x, y, 1, 1);
        }
        const t = new THREE.CanvasTexture(c);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(14, 1.6);
        t.anisotropy = Math.max(2, (typeof TEX_ANISO !== 'undefined') ? (TEX_ANISO >> 1) : 4);
        return t;
    };
    const valleyRoadMat = new THREE.MeshStandardMaterial({ map: makeValleyRoadTexture(), color: 0x93866f, roughness: 0.96, metalness: 0.0 });
    const valleyRoadEdgeMat = new THREE.MeshStandardMaterial({ color: 0x9f937f, roughness: 0.92, metalness: 0.0 });
    const valleyRockMatA = new THREE.MeshStandardMaterial({ color: 0x6f8e7b, roughness: 0.98, metalness: 0.0, flatShading: true });
    const valleyRockMatB = new THREE.MeshStandardMaterial({ color: 0x5f7c6d, roughness: 0.98, metalness: 0.0, flatShading: true });
    const valleyStonePatchMat = new THREE.MeshStandardMaterial({ color: 0x768072, roughness: 0.92, metalness: 0.0, flatShading: true });
    const shorelineShrubLeafMatA = new THREE.MeshStandardMaterial({ color: 0x4d6638, roughness: 0.97, metalness: 0.0, flatShading: true });
    const shorelineShrubLeafMatB = new THREE.MeshStandardMaterial({ color: 0x5f733f, roughness: 0.97, metalness: 0.0, flatShading: true });
    const shorelineShrubLeafMatDry = new THREE.MeshStandardMaterial({ color: 0x6b5836, roughness: 0.98, metalness: 0.0, flatShading: true });

    const addStoryBridgePerimeterShrubs = () => {
        if (DEV_HIDE_ALL_GRASS) return;
        const tuftGeoA = new THREE.DodecahedronGeometry(0.29, 0);
        const tuftGeoB = new THREE.IcosahedronGeometry(0.24, 0);
        const rimY = 0.03;

        const placeShrubCluster = (x, z, sideHint = 1) => {
            const roadCenterZ = getStoryBridgeRoadCenterZAtX(x);
            if (Math.abs(z - roadCenterZ) < STORY_BRIDGE_ROAD_HALF_Z + 0.8) return;

            const matRoll = Math.random();
            const tuftMat = matRoll < 0.52
                ? shorelineShrubLeafMatA
                : (matRoll < 0.88 ? shorelineShrubLeafMatB : shorelineShrubLeafMatDry);
            const shrub = new THREE.Mesh(Math.random() < 0.5 ? tuftGeoA : tuftGeoB, tuftMat);
            const s = 0.76 + Math.random() * 0.44;
            shrub.scale.set(s, s * (0.82 + Math.random() * 0.28), s);
            shrub.position.set(x, rimY + 0.18 + Math.random() * 0.08, z);
            shrub.rotation.set((Math.random() - 0.5) * 0.3, Math.random() * Math.PI, (Math.random() - 0.5) * 0.3);
            shrub.castShadow = true;
            shrub.receiveShadow = true;
            shrub.userData = shrub.userData || {};
            shrub.userData.bridge2KeepVisible = true;
            scene.add(shrub);
            storyBridgeSceneMeshes.push(shrub);

            if (Math.random() < 0.42) {
                const mate = new THREE.Mesh(Math.random() < 0.5 ? tuftGeoA : tuftGeoB, Math.random() < 0.7 ? shorelineShrubLeafMatB : shorelineShrubLeafMatDry);
                const ms = s * (0.68 + Math.random() * 0.22);
                mate.scale.set(ms, ms * (0.88 + Math.random() * 0.2), ms);
                mate.position.set(
                    x + (Math.random() - 0.5) * 0.38,
                    rimY + 0.14 + Math.random() * 0.06,
                    z + sideHint * (0.16 + Math.random() * 0.22)
                );
                mate.rotation.set((Math.random() - 0.5) * 0.26, Math.random() * Math.PI, (Math.random() - 0.5) * 0.26);
                mate.castShadow = true;
                mate.receiveShadow = true;
                mate.userData = mate.userData || {};
                mate.userData.bridge2KeepVisible = true;
                scene.add(mate);
                storyBridgeSceneMeshes.push(mate);
            }
        };

        const placeEdgeShrubs = (edgePoints, centerAtX, sideHint = 1, edgeInset = 0) => {
            if (!edgePoints || edgePoints.length < 2) return;
            const stride = isMobileProfile ? 1 : 1;
            for (let i = 0; i < edgePoints.length; i += stride) {
                const p = edgePoints[i];
                const centerZ = centerAtX(p.x);
                let dir = Math.sign(p.z - centerZ);
                if (dir === 0) dir = sideHint;
                const offset = Math.max(0.02, edgeInset + 0.06 + Math.random() * 0.16);
                const x = p.x + (Math.random() - 0.5) * 0.24;
                const z = p.z + dir * offset + (Math.random() - 0.5) * 0.12;
                placeShrubCluster(x, z, dir);
            }
        };

        const makeEndCapPoints = (x, z0, z1, samples = 18) => {
            const pts = [];
            for (let i = 0; i <= samples; i++) {
                const t = samples <= 0 ? 0 : i / samples;
                pts.push(new THREE.Vector3(x, rimY, THREE.MathUtils.lerp(z0, z1, t)));
            }
            return pts;
        };

        if (WATER_SYSTEM_ENABLED && BRIDGE_CHANNEL_WATER_ENABLED) {
            const edgeSamples = isMobileProfile ? 72 : 128;
            const shore = sampleStoryBridgeWaterEdgePoints(0, edgeSamples, rimY);
            placeEdgeShrubs(shore.top, (x) => getStoryBridgeWaterProfileAtX(x).centerZ, 1, -0.02);
            placeEdgeShrubs(shore.top, (x) => getStoryBridgeWaterProfileAtX(x).centerZ, 1, 0.12);
            placeEdgeShrubs(shore.top, (x) => getStoryBridgeWaterProfileAtX(x).centerZ, 1, 0.52);
            placeEdgeShrubs(shore.bottom, (x) => getStoryBridgeWaterProfileAtX(x).centerZ, -1, -0.02);
            placeEdgeShrubs(shore.bottom, (x) => getStoryBridgeWaterProfileAtX(x).centerZ, -1, 0.12);
            placeEdgeShrubs(shore.bottom, (x) => getStoryBridgeWaterProfileAtX(x).centerZ, -1, 0.52);

            if (shore.top.length && shore.bottom.length) {
                const leftTop = shore.top[0];
                const leftBottom = shore.bottom[0];
                const rightTop = shore.top[shore.top.length - 1];
                const rightBottom = shore.bottom[shore.bottom.length - 1];
                const leftCap = makeEndCapPoints(STORY_BRIDGE_WATER_MIN_X - 0.36, leftBottom.z, leftTop.z, isMobileProfile ? 9 : 16);
                const rightCap = makeEndCapPoints(STORY_BRIDGE_WATER_MAX_X + 0.36, rightBottom.z, rightTop.z, isMobileProfile ? 9 : 16);
                placeEdgeShrubs(leftCap, () => STORY_BRIDGE_Z, -1, 0.0);
                placeEdgeShrubs(rightCap, () => STORY_BRIDGE_Z, 1, 0.0);
            }
        } else {
            const edgeSamples = isMobileProfile ? 44 : 86;
            const x1 = -STORY_BRIDGE_TRENCH_HALF_X;
            const x2 = STORY_BRIDGE_TRENCH_HALF_X;
            const top = [];
            const bottom = [];
            for (let i = 0; i <= edgeSamples; i++) {
                const t = i / edgeSamples;
                const x = THREE.MathUtils.lerp(x1, x2, t);
                const half = getStoryBridgeTrenchHalfWidthAtX(x);
                top.push(new THREE.Vector3(x, rimY, STORY_BRIDGE_Z + half));
                bottom.push(new THREE.Vector3(x, rimY, STORY_BRIDGE_Z - half));
            }
            placeEdgeShrubs(top, () => STORY_BRIDGE_Z, 1, -0.02);
            placeEdgeShrubs(top, () => STORY_BRIDGE_Z, 1, 0.12);
            placeEdgeShrubs(bottom, () => STORY_BRIDGE_Z, -1, -0.02);
            placeEdgeShrubs(bottom, () => STORY_BRIDGE_Z, -1, 0.12);

            // Fill side caps so the shrub line reads as a continuous perimeter.
            for (const sgn of [-1, 1]) {
                const x = sgn < 0 ? (x1 - 0.50) : (x2 + 0.50);
                const endHalf = getStoryBridgeTrenchHalfWidthAtX(sgn < 0 ? (x1 + 0.2) : (x2 - 0.2));
                const capCount = isMobileProfile ? 12 : 20;
                for (let i = 0; i < capCount; i++) {
                    const t = capCount <= 1 ? 0.5 : i / (capCount - 1);
                    const z = STORY_BRIDGE_Z - endHalf + t * (endHalf * 2);
                    if (Math.abs(z - getStoryBridgeRoadCenterZAtX(x)) < STORY_BRIDGE_ROAD_HALF_Z + 0.8) continue;
                    placeShrubCluster(x + (Math.random() - 0.5) * 0.18, z + (Math.random() - 0.5) * 0.3, sgn);
                }
            }
        }
    };

    // Valley road rides just proud of the terrain. It never crosses the water
    // (it ends at the ramp mouth, and the water shape excludes the road
    // corridor), so do NOT sink it when bridge water is enabled � the old
    // water-conditional Y (WATER_Y - WATER_DEPTH_M = -1.05) buried the whole
    // road a metre underground, making it invisible.
    const roadY = 0.045;
    const approachLen = STORY_BRIDGE_APPROACH_ROAD_LEN;
    const roadEndX = STORY_BRIDGE_APPROACH_ROAD_END_X; // tie directly into soldier-entry ramp mouth
    const roadCenterZAtT = (t) => getStoryBridgeRoadCenterZAtX(roadEndX - t * approachLen);

    const makeValleyHillGeo = (seed) => {
        let s = (((seed * 100000) | 0) ^ 0x9e3779b9) >>> 0;
        const rnd = () => {
            s = (s * 1664525 + 1013904223) >>> 0;
            return s / 4294967295;
        };

        const ws = 7 + Math.floor(rnd() * 5);
        const hs = 5 + Math.floor(rnd() * 3);
        const g = new THREE.SphereGeometry(1, ws, hs, 0, Math.PI * 2, 0, Math.PI * (0.70 + rnd() * 0.10));
        const pos = g.attributes.position;
        const v = new THREE.Vector3();
        const skewX = (rnd() - 0.5) * 0.9;
        const skewZ = (rnd() - 0.5) * 0.8;
        const ridgeFreqA = 1.7 + rnd() * 1.5;
        const ridgeFreqB = 2.4 + rnd() * 1.6;
        for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i);
            const angle = Math.atan2(v.z, v.x);
            const ridge = Math.sin(angle * ridgeFreqA + seed * 1.3) * (0.12 + rnd() * 0.05)
                + Math.cos(v.y * ridgeFreqB + seed * 0.9) * (0.06 + rnd() * 0.04);
            const radial = 1 + ridge;
            v.x *= radial;
            v.z *= radial;
            const crown = Math.max(0, v.y + 0.16);
            v.x += skewX * crown * (0.32 + rnd() * 0.15);
            v.z += skewZ * crown * (0.3 + rnd() * 0.16);
            v.y *= 0.9 + ridge * (0.22 + rnd() * 0.14);
            if (v.y < -0.2) v.y = -0.2 + (v.y + 0.2) * 0.18;
            pos.setXYZ(i, v.x, v.y, v.z);
        }
        pos.needsUpdate = true;
        g.computeBoundingBox();
        g.computeVertexNormals();
        return g;
    };

    const addValleyRock = (x, y, z, sx, sy, sz, ry, mat, allowCompanion = true) => {
        const seed = Math.random() * 9.0 + 0.4;
        const geo = makeValleyHillGeo(seed);
        const rock = new THREE.Mesh(geo, mat);

        const roadT = THREE.MathUtils.clamp((roadEndX - x) / Math.max(0.001, approachLen), 0, 1);
        const roadZ = roadCenterZAtT(roadT);
        const halfFootprint = Math.max(sx, sz) * 0.46;
        const minRoadClearance = STORY_BRIDGE_ROAD_HALF_Z + 3.4 + halfFootprint;
        let placedZ = z;
        const dzFromRoad = placedZ - roadZ;
        if (Math.abs(dzFromRoad) < minRoadClearance) {
            const side = dzFromRoad === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(dzFromRoad);
            placedZ = roadZ + side * minRoadClearance;
        }

        rock.scale.set(sx, sy, sz);
        const baseY = (geo.boundingBox?.min?.y ?? -0.2) * sy;
        rock.position.set(x, y - baseY - 0.06 + Math.random() * 0.02, placedZ);
        rock.rotation.y = ry;
        rock.rotation.x = (Math.random() - 0.5) * 0.045;
        rock.rotation.z = (Math.random() - 0.5) * 0.04;
        rock.castShadow = true;
        rock.receiveShadow = true;

        const stoneCount = 1 + ((Math.random() < 0.72) ? 1 : 0) + ((Math.random() < 0.28) ? 1 : 0);
        for (let k = 0; k < stoneCount; k++) {
            const stone = new THREE.Mesh(
                new THREE.DodecahedronGeometry(0.18 + Math.random() * 0.16, 0),
                valleyStonePatchMat
            );
            const side = Math.random() < 0.5 ? -1 : 1;
            stone.position.set(
                side * (0.36 + Math.random() * 0.34),
                0.05 + Math.random() * 0.22,
                (Math.random() - 0.5) * 0.58
            );
            stone.scale.set(0.95 + Math.random() * 0.5, 0.46 + Math.random() * 0.28, 0.95 + Math.random() * 0.52);
            stone.rotation.set((Math.random() - 0.5) * 0.6, Math.random() * Math.PI, (Math.random() - 0.5) * 0.6);
            stone.castShadow = true;
            stone.receiveShadow = true;
            rock.add(stone);
        }

        scene.add(rock);
        storyBridgeSceneMeshes.push(rock);

        if (allowCompanion && Math.random() < 0.28) {
            const ox = (Math.random() - 0.5) * sx * 0.8;
            const oz = (Math.random() - 0.5) * sz * 0.8;
            addValleyRock(
                x + ox,
                y,
                z + oz,
                sx * (0.42 + Math.random() * 0.28),
                sy * (0.44 + Math.random() * 0.24),
                sz * (0.42 + Math.random() * 0.26),
                ry + (Math.random() - 0.5) * 0.6,
                mat === valleyRockMatA ? valleyRockMatB : valleyRockMatA,
                false
            );
        }
    };

    // Valley road builder � one curved dirt road per side of the bridge, each
    // running from its ramp mouth away down the valley. `centerZAtX` supplies
    // the meander; the far (+x) side mirrors the approach curve so both roads
    // read as one route crossing the bridge. Soldiers walk the same corridor
    // (ground colliders live at y�0.02 beneath; the road deck is a thin visual
    // cap just proud of the grass).
    const buildValleyRoad = (endX, dirSign, centerZAtX) => {
        const roadSegments = 30;
        for (let i = 0; i < roadSegments; i++) {
            const t0 = i / roadSegments;
            const t1 = (i + 1) / roadSegments;
            const tMid = (t0 + t1) * 0.5;
            const x0 = endX + dirSign * t0 * approachLen;
            const x1 = endX + dirSign * t1 * approachLen;
            const z0 = centerZAtX(x0);
            const z1 = centerZAtX(x1);
            const xMid = (x0 + x1) * 0.5;
            const zMid = (z0 + z1) * 0.5;
            const dx = x1 - x0;
            const dz = z1 - z0;
            const segLen = Math.hypot(dx, dz) + 0.36;
            const yaw = Math.atan2(dx, dz);
            const nx = -dz / Math.max(0.001, segLen);
            const nz = dx / Math.max(0.001, segLen);

            const roadSeg = new THREE.Mesh(new THREE.BoxGeometry(segLen, 0.075, 4.2), valleyRoadMat);
            roadSeg.position.set(xMid, roadY + Math.sin(tMid * Math.PI * 2.0 + 0.25) * 0.015, zMid);
            roadSeg.rotation.y = yaw;
            roadSeg.receiveShadow = true;
            scene.add(roadSeg);
            storyBridgeSceneMeshes.push(roadSeg);

            const edgeOffset = 2.42;
            const roadEdgeL = new THREE.Mesh(new THREE.BoxGeometry(segLen, 0.07, 0.52), valleyRoadEdgeMat);
            roadEdgeL.position.set(xMid + nx * edgeOffset, roadY + 0.024, zMid + nz * edgeOffset);
            roadEdgeL.rotation.y = yaw;
            roadEdgeL.receiveShadow = true;
            const roadEdgeR = roadEdgeL.clone();
            roadEdgeR.position.set(xMid - nx * edgeOffset, roadY + 0.024, zMid - nz * edgeOffset);
            scene.add(roadEdgeL, roadEdgeR);
            storyBridgeSceneMeshes.push(roadEdgeL, roadEdgeR);
        }
    };
    // Near (soldier-entry) side: existing approach curve, running toward -x.
    buildValleyRoad(roadEndX, -1, getStoryBridgeRoadCenterZAtX);
    // Far side: mirrored curve leaving the +x ramp mouth, so the route reads
    // as one continuous road over the bridge.
    buildValleyRoad(-roadEndX, 1, (x) => getStoryBridgeRoadCenterZAtX(-x));

    // Bridge-side shoulders: continue the valley berms right up to the bridge.
    const shoulderNearX = roadEndX - 1.8;
    const shoulderFarX = -STORY_BRIDGE_WATER_HALF_X - 3.5;
    const shoulderSteps = 10;
    for (let i = 0; i < shoulderSteps; i++) {
        const t = shoulderSteps <= 1 ? 0 : (i / (shoulderSteps - 1));
        const x = THREE.MathUtils.lerp(shoulderNearX, shoulderFarX, t);
        const spread = 6.2 + t * 4.6;
        const sx = 3.8 + Math.random() * 2.2 + t * 0.8;
        const sy = 3.4 + Math.random() * 2.4 + t * 0.8;
        const sz = 4.6 + Math.random() * 2.8 + t * 0.9;
        addValleyRock(
            x,
            0.02,
            STORY_BRIDGE_Z - spread,
            sx,
            sy,
            sz,
            Math.random() * Math.PI,
            (i % 2) ? valleyRockMatA : valleyRockMatB
        );
        addValleyRock(
            x,
            0.02,
            STORY_BRIDGE_Z + spread,
            sx,
            sy,
            sz,
            Math.random() * Math.PI,
            (i % 2) ? valleyRockMatB : valleyRockMatA
        );
    }

    // Valley walls on soldier-entry side (negative X), widening away from bridge.
    const wallStartX = -STORY_BRIDGE_WATER_HALF_X - 5;
    for (let i = 0; i < 12; i++) {
        const t = i / 11;
        const x = wallStartX - t * 72;
        const spread = 9.4 + t * 16.0;
        const sz = 5.6 + Math.random() * 5.2 + t * 1.2;
        const sy = 3.1 + Math.random() * 3.4 + t * 0.9;
        const sx = 3.6 + Math.random() * 4.4 + t * 0.8;
        addValleyRock(x, 0.02, STORY_BRIDGE_Z - spread, sx, sy, sz, Math.random() * Math.PI, (i % 2) ? valleyRockMatA : valleyRockMatB);
        addValleyRock(x, 0.02, STORY_BRIDGE_Z + spread, sx, sy, sz, Math.random() * Math.PI, (i % 2) ? valleyRockMatB : valleyRockMatA);
    }

    // Ramp-mouth masking so troops appear to emerge from the valley road.
    const mouthX = -STORY_BRIDGE_APPROACH_X + 0.6;
    for (const sgn of [-1, 1]) {
        const sy = 4.8 + Math.random() * 1.5;
        const sx = 4.2 + Math.random() * 1.6;
        const sz = 5.6 + Math.random() * 2.0;
        addValleyRock(
            mouthX,
            0.01,
            STORY_BRIDGE_Z + sgn * 6.3,
            sx,
            sy,
            sz,
            Math.random() * Math.PI,
            sgn > 0 ? valleyRockMatA : valleyRockMatB
        );
    }

    // Extra road-entry masking so soldiers read as arriving down-valley.
    const roadStartX = roadEndX - approachLen;
    for (const sgn of [-1, 1]) {
        const zBase = roadCenterZAtT(1.0) + sgn * 5.2;
        addValleyRock(roadStartX + 6.0, 0.02, zBase, 6.0, 5.0, 7.2, Math.random() * Math.PI, sgn > 0 ? valleyRockMatA : valleyRockMatB);
        addValleyRock(roadStartX + 16.0, 0.02, zBase + sgn * 1.6, 5.2, 4.2, 6.4, Math.random() * Math.PI, sgn > 0 ? valleyRockMatB : valleyRockMatA);
    }

    // Low-poly scrub around the active lake edge helps hide water/ground joins.
    addStoryBridgePerimeterShrubs();

    const occupied = new Set();
    const occupiedAabbs = [];
    let placedCount = 0;
    const snap = (v, s) => Math.round(v / s) * s;
    const getBridgeHalfExtents = (orient) => {
        if (orient === 'z') return { hx: BS.d * 0.5, hy: BS.h * 0.5, hz: WALL_BRICK_HALF_LEN };
        if (orient === 's') return { hx: BS.d * 0.5, hy: BS.h * 0.25, hz: WALL_BRICK_HALF_LEN };
        if (orient === 'y') return { hx: BS.h * 0.5, hy: WALL_BRICK_HALF_LEN, hz: BS.d * 0.5 };
        if (orient === 'c') return { hx: BS.h * 0.5, hy: BS.h * 0.5, hz: BS.h * 0.5 };
        if (orient === 'h') return { hx: WALL_BRICK_HALF_LEN, hy: BS.h * 0.25, hz: BS.d * 0.5 };
        return { hx: WALL_BRICK_HALF_LEN, hy: BS.h * 0.5, hz: BS.d * 0.5 };
    };
    const isOverlappingBridgeAabb = (x, y, z, hx, hy, hz) => {
        for (const a of occupiedAabbs) {
            if (Math.abs(x - a.x) >= (hx + a.hx - 1e-3)) continue;
            if (Math.abs(y - a.y) >= (hy + a.hy - 1e-3)) continue;
            if (Math.abs(z - a.z) >= (hz + a.hz - 1e-3)) continue;
            return true;
        }
        return false;
    };
    const markStoryBridgeBrick = () => {
        const e = bricks[bricks.length - 1];
        if (!e) return;
        e.storyRole = 'bridge';
        if (e.body) {
            // Keep bridge brick physics consistent with castle-wall bricks.
            e.body.collisionFilterGroup = CGROUP_BRICK;
            e.body.collisionFilterMask = e.isCube
                ? (WALL_MASK ^ CGROUP_BRICK)
                : WALL_MASK;
            e.body._storyRole = 'bridge';
        }
        e.grp = CGROUP_BRICK;
        placedCount++;
    };
    const placeBridgeBrick = (x, y, z, orient = 'x', extraKey = '', quat = null, isAnchor = false) => {
        const sx = snap(x, 0.25);
        const sy = snap(y, 0.25);
        const sz = snap(z, 0.25);
        const o = orient === 'z' ? 'z' : (orient === 's' ? 's' : (orient === 'y' ? 'y' : (orient === 'c' ? 'c' : (orient === 'h' ? 'h' : 'x'))));
        const tag = String(extraKey || '');
        const he = getBridgeHalfExtents(o);
        const qk = quat ? `|q${Math.round(quat.x * 1000)}|${Math.round(quat.y * 1000)}|${Math.round(quat.z * 1000)}|${Math.round(quat.w * 1000)}` : '';
        const key = `${sx}|${sy}|${sz}|${o}${qk}`;
        if (occupied.has(key)) return;
        // Ramp/stair rows intentionally pack tightly; elsewhere, prune true
        // AABB penetrations so bridge bricks don't spawn interpenetrating.
        if (!tag.startsWith('ramp-') && isOverlappingBridgeAabb(sx, sy, sz, he.hx, he.hy, he.hz)) return;
        occupied.add(key);
        if (o === 'z') { if (quat) createBrickZTiltQuat(sx, sy, sz, quat); else createBrickZ(sx, sy, sz); }
        else if (o === 's') createBrickSlabZ(sx, sy, sz);
        else if (o === 'y') { if (quat) createBrickYTiltQuat(sx, sy, sz, quat); else createBrickY(sx, sy, sz); }
        else if (o === 'c') { if (quat) createBrickCubeTiltQuat(sx, sy, sz, quat); else createBrickCube(sx, sy, sz); }
        else if (o === 'h') createBrickSlab(sx, sy, sz);
        else if (quat) createBrickTiltQuat(sx, sy, sz, quat);
        else createBrick(sx, sy, sz);
        occupiedAabbs.push({ x: sx, y: sy, z: sz, hx: he.hx, hy: he.hy, hz: he.hz });
        {
            const e = bricks[bricks.length - 1];
            if (e && e.body) {
                const shape = e.body.shapes?.[0];
                if (shape?.halfExtents) {
                    const mortarGapHalf = 0.04;
                    if (o === 'z') {
                        shape.halfExtents.x = Math.max(0.05, shape.halfExtents.x - mortarGapHalf);
                    } else if (o === 'y' || o === 'c') {
                        shape.halfExtents.x = Math.max(0.05, shape.halfExtents.x - mortarGapHalf);
                        shape.halfExtents.z = Math.max(0.05, shape.halfExtents.z - mortarGapHalf);
                    } else {
                        shape.halfExtents.z = Math.max(0.05, shape.halfExtents.z - mortarGapHalf);
                    }
                    shape.updateConvexPolyhedronRepresentation();
                    e.body.updateBoundingRadius();
                    e.body.aabbNeedsUpdate = true;
                }
                if (isAnchor) {
                    // Keep anchor rows stable but still destructible.
                    e.body.type = CANNON.Body.DYNAMIC;
                    e.body.mass = Math.max(e.body.mass || 0, 260);
                    e.body.updateMassProperties();
                    e.body.linearDamping  = Math.max(e.body.linearDamping,  0.36);
                    e.body.angularDamping = Math.max(e.body.angularDamping, 0.64);
                }
                e.body.sleep();  // all bridge bricks start in a known sleeping state
            }
        }
        markStoryBridgeBrick();
    };
    const placeBridgeWedge = (x, y, z, quat, isAnchor = false) => {
        const sx = Math.round(x * 100) / 100;
        const sy = Math.round(y * 100) / 100;
        const sz = Math.round(z * 100) / 100;
        const key = `w|${sx}|${sy}|${sz}|${Math.round(quat.x * 1000) / 1000}|${Math.round(quat.y * 1000) / 1000}|${Math.round(quat.z * 1000) / 1000}|${Math.round(quat.w * 1000) / 1000}`;
        if (occupied.has(key)) return;
        occupied.add(key);
        createBrickAngledQuat(sx, sy, sz, quat);
        const e = bricks[bricks.length - 1];
        if (e && e.body) {
            e.body.material = wallPhysMat;
            e.body.linearDamping  = 0.30;
            e.body.angularDamping = 0.55;
            if (isAnchor) {
                e.body.type = CANNON.Body.DYNAMIC;
                e.body.mass = Math.max(e.body.mass || 0, 300);
                e.body.linearDamping  = Math.max(e.body.linearDamping,  0.38);
                e.body.angularDamping = Math.max(e.body.angularDamping, 0.66);
                e.body.updateMassProperties();
            }
            e.bridgeWedge = true;
            e.body.sleep();
        }
        markStoryBridgeBrick();
    };

    // === Bridge masonry ===
    //   - 4 semicircular tunnel arches (anchored voussoirs)
    //   - solid substructure: 2-brick piers between arches, abutments at the
    //     ends, spandrel fill above the arches (tunnel openings carved out)
    //   - road: staggered Z-brick running bond, upright Y-bricks fill the gaps
    //   - ramps: wedge row -> staggered tilted bricks -> 180-flipped wedge row
    const zStep = BS.d;                              // 1.0
    const normalZ = new THREE.Vector3(0, 0, 1);
    const radial = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const basis = new THREE.Matrix4();
    const wedgeQ = new THREE.Quaternion();

    const archCount = 4;
    const archRadius = TOWER_BRICK_R;               // 3.5 centreline radius
    const archSpringY = 0.5;
    const RO = archRadius + BS.d / 2;               // 4.0 extrados radius
    const archMortarClearance = 0.08;
    const pierW = 2.0;                              // target pillar width between arches
    const deckHalf = STORY_BRIDGE_DECK_HALF;        // core deck half-span (without extension)
    const supportSpanHalf = deckHalf + STORY_BRIDGE_RAMP_START_OFFSET;
    const edgeInset = RO + pierW * 0.5;
    const archPitch = archCount > 1
        ? (2 * Math.max(0.5, supportSpanHalf - edgeInset)) / (archCount - 1)
        : 0;
    const voussoirCount = Math.max(7, Math.floor(Math.PI / TOWER_A_STEP) + 1);
    const startTheta = (Math.PI + (voussoirCount - 1) * TOWER_A_STEP) * 0.5;
    const tunnelRows = 6;
    const zCenter = STORY_BRIDGE_Z;
    const archCenters = [];
    for (let i = 0; i < archCount; i++) archCenters.push(-supportSpanHalf + edgeInset + i * archPitch);
    const supportBands = [];
    for (let i = 0; i < archCenters.length - 1; i++) {
        supportBands.push((archCenters[i] + archCenters[i + 1]) * 0.5);
    }
    const supportHalfWidth = BS.d * 0.5;
    const isSupportBandX = (x) => supportBands.some(cx => Math.abs(x - cx) <= (supportHalfWidth + 1e-6));
    const ROAD_TIE_SPACING_X = 4.0;
    const isRoadTieX = (x) => {
        const rel = x - 0.5;
        const snapTie = Math.round(rel / ROAD_TIE_SPACING_X) * ROAD_TIE_SPACING_X + 0.5;
        return Math.abs(x - snapTie) <= 1e-6;
    };
    const addBridgeFoundationFootings = () => {
        const trenchFloorTopY = -(WATER_DEPTH_M * 2);
        const footingHeight = -trenchFloorTopY;
        const seen = new Set();
        const addFooting = (x, z, hx, hz) => {
            const key = `${x.toFixed(2)}|${z.toFixed(2)}|${hx.toFixed(2)}|${hz.toFixed(2)}`;
            if (seen.has(key)) return;
            seen.add(key);

            const body = new CANNON.Body({
                mass: 0,
                material: wallPhysMat,
                shape: new CANNON.Box(new CANNON.Vec3(hx, footingHeight * 0.5, hz)),
            });
            body.position.set(x, trenchFloorTopY + footingHeight * 0.5, z);
            world.addBody(body);
            markStoryBridgeBody(body);

            const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(hx * 2, footingHeight, hz * 2),
                wedgeStoneMat
            );
            mesh.position.copy(body.position);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.userData.bridge2KeepVisible = true;
            scene.add(mesh);
            storyBridgeSceneMeshes.push(mesh);
        };

        for (const e of bricks) {
            if ((e.storyRole || e.body?._storyRole) !== 'bridge' || !e.body) continue;
            const halfExtents = e.body.shapes?.[0]?.halfExtents;
            const foundationCenterY = halfExtents?.y ?? (BS.h * 0.5);
            if (Math.abs(e.body.position.y - foundationCenterY) > 1e-3) continue;
            if (halfExtents) {
                addFooting(e.body.position.x, e.body.position.z, halfExtents.x, halfExtents.z);
            } else if (e.bridgeWedge) {
                addFooting(e.body.position.x, e.body.position.z, BS.d * 0.48, BS.d * 0.48);
            }
        }
    };
    // Support piers are generated as a separate centred pass between arches so
    // they carry the deck without being forced into arch carve geometry.

    // Distance from (x,y) to the nearest arch ring centreline (y measured above
    // the springline; below the springline it is purely horizontal -> tunnel legs).
    const archDist = (x, y) => {
        const ay = Math.max(0, y - archSpringY);
        let m = Infinity;
        for (const cx of archCenters) m = Math.min(m, Math.hypot(x - cx, ay));
        return m;
    };
    const archRectDist = (x, y, hx, hy) => {
        const ay = Math.max(0, y - hy - archSpringY);
        let m = Infinity;
        for (const cx of archCenters) {
            const ax = Math.max(0, Math.abs(x - cx) - hx);
            m = Math.min(m, Math.hypot(ax, ay));
        }
        return m;
    };
    const archCellDist = (x, y) => archRectDist(
        x, y,
        BS.d * 0.5 - 0.04,
        BS.h * 0.5
    );

    // ==========================================================
    // DEV BRIDGE: redesigned structure used when bridgeDevLevelEnabled
    // is set in the dev menu. Falls through to the original bridge if
    // the flag is off, so the production bridge is entirely untouched.
    // Features: 8-row wedge arches, solid spandrel fill, heavy stone
    // road, solid + battlement parapets, staircase approaches.
    // ==========================================================
    if (bridgeDevLevelEnabled) {
        const devTunnelRows = 8;   // thicker arch rings than production's 6
        const devDeckY      = 5.5; // must stay in sync with _BRIDGE_DECK_Y - 0.5 (walker analytic)
        const devSubTopY    = 4.0;
        const devGroundY    = BS.h * 0.5;       // 0.5
        const devSpan       = supportSpanHalf;   // 24 m
        const devCarveClear = RO + archMortarClearance;

        const devStrengthen = (mass, ld, ad) => {
            const e = bricks[bricks.length - 1];
            if (!e || !e.body) return;
            e.body.mass = Math.max(e.body.mass || 0, mass);
            e.body.updateMassProperties();
            e.body.linearDamping  = Math.max(e.body.linearDamping,  ld);
            e.body.angularDamping = Math.max(e.body.angularDamping, ad);
            e.body.sleep();
        };

        // 1. Arch voussoir rings — 8 deep for impressive thick masonry
        for (let i = 0; i < archCount; i++) {
            const cX = archCenters[i];
            for (let row = 0; row < devTunnelRows; row++) {
                const z = zCenter + (row - (devTunnelRows - 1) * 0.5) * zStep;
                for (let j = 0; j < voussoirCount; j++) {
                    const theta = startTheta - j * TOWER_A_STEP;
                    const x = cX + Math.cos(theta) * archRadius;
                    const y = archSpringY + Math.sin(theta) * archRadius;
                    radial.set(Math.cos(theta), Math.sin(theta), 0).normalize();
                    tangent.set(-Math.sin(theta), Math.cos(theta), 0).normalize();
                    basis.makeBasis(tangent, normalZ, radial);
                    wedgeQ.setFromRotationMatrix(basis);
                    placeBridgeWedge(x, y, z, wedgeQ, j === 0 || j === voussoirCount - 1);
                }
            }
        }

        // 2. Solid spandrel substructure (ground → subTopY, arches carved out)
        for (let xc = -devSpan + 0.5; xc <= devSpan - 0.5 + 1e-6; xc += 1.0) {
            if (isSupportBandX(xc)) continue;
            for (let y = devGroundY; y <= devSubTopY + 1e-6; y += BS.h) {
                if (archCellDist(xc, y) < devCarveClear) continue;
                const isFound  = y <= devGroundY + 1e-6;
                const isHaunch = !isFound && archCellDist(xc, y - BS.h) < devCarveClear;
                const anch     = isFound || isHaunch;
                placeBridgeBrick(xc, y, zCenter - 2, 'z', 'dsub', null, anch);
                placeBridgeBrick(xc, y, zCenter,     'z', 'dsub', null, anch);
                placeBridgeBrick(xc, y, zCenter + 2, 'z', 'dsub', null, anch);
            }
        }

        // 3. Between-arch support piers (fully packed running bond, full height)
        for (const sx of supportBands) {
            for (let y = devGroundY; y <= devSubTopY + 1e-6; y += BS.h) {
                const ph   = ((Math.round((y - devGroundY) / BS.h) % 2) + 2) % 2;
                const anch = y <= devGroundY + 1e-6;
                if (!ph) {
                    for (let zc = zCenter - 2.5; zc <= zCenter + 2.5 + 1e-6; zc += 1.0) {
                        placeBridgeBrick(sx, y, zc, 'x', 'dpier-a', null, anch);
                    }
                } else {
                    for (const xc of [sx - 0.5, sx + 0.5]) {
                        for (const zc of [zCenter - 2, zCenter, zCenter + 2]) {
                            placeBridgeBrick(xc, y, zc, 'z', 'dpier-b', null, anch);
                        }
                    }
                }
            }
        }

        // Half-height caps fill y=4.0..4.5 above the final full course. Near
        // each crown the arch itself occupies this layer and carries the bearing.
        const devCapY = devSubTopY + BS.h * 0.25;
        for (let xc = -devSpan + 1.0; xc <= devSpan - 1.0 + 1e-6; xc += 2.0) {
            if (archRectDist(xc, devCapY, WALL_BRICK_HALF_LEN, BS.h * 0.25) < devCarveClear) continue;
            for (let zc = zCenter - 3; zc <= zCenter + 3 + 1e-6; zc += 1.0) {
                placeBridgeBrick(xc, devCapY, zc, 'h', 'd-support-cap', null, true);
            }
        }

        // 4. Deck bearing course (half-height slabs, bridging pier tops to road)
        const devBearY = devSubTopY + BS.h * 0.75;
        for (let xc = -devSpan + 1.0; xc <= devSpan - 1.0 + 1e-6; xc += 2.0) {
            for (let zc = zCenter - 3; zc <= zCenter + 3 + 1e-6; zc += 1.0) {
                placeBridgeBrick(xc, devBearY, zc, 'h', 'dbear', null, true);
            }
        }

        // 5. Stone road — heavy X-beam planks across full 7m width
        const devRoadZs = [zCenter-3, zCenter-2, zCenter-1, zCenter, zCenter+1, zCenter+2, zCenter+3];
        for (const zc of devRoadZs) {
            for (let xc = -devSpan + 1.0; xc <= devSpan - 1.0 + 1e-6; xc += 2.0) {
                const overPier = isSupportBandX(xc) || isSupportBandX(xc - 1.0) || isSupportBandX(xc + 1.0);
                const anch = overPier || isRoadTieX(xc);
                placeBridgeBrick(xc, devDeckY, zc, 'x', 'droad', null, anch);
                devStrengthen(anch ? 320 : 240, 0.45, 0.78);
            }
        }

        // 6. Solid parapets (2 full courses) + battlement row (every other merlon)
        const pzN = zCenter - 3, pzP = zCenter + 3;
        for (const pz of [pzN, pzP]) {
            let mIdx = 0;
            for (let xc = -devSpan + 1.0; xc <= devSpan - 1.0 + 1e-6; xc += 2.0) {
                placeBridgeBrick(xc, devDeckY + BS.h,       pz, 'x', 'dpar1');
                placeBridgeBrick(xc, devDeckY + 2 * BS.h,   pz, 'x', 'dpar2');
                if (mIdx % 2 === 0) placeBridgeBrick(xc, devDeckY + 3 * BS.h, pz, 'x', 'dparm');
                mIdx++;
            }
        }

        // 7. Staircase approaches: twelve 0.5 m rises with 1 m treads.
        //    Each column fills solid from ground up so nothing floats.
        for (const sgn of [-1, 1]) {
            for (let k = 1; k <= STORY_BRIDGE_RAMP_LEN; k++) {
                const surfaceY = Math.max(BS.h * 0.5, devDeckY + BS.h * 0.5 - k * BS.h * 0.5);
                const stepY = surfaceY - BS.h * 0.25;
                const xc    = sgn * (devSpan + k - 0.5);
                const supportTopY = surfaceY - BS.h * 0.5;
                const needsHalfBase = Math.abs(supportTopY - Math.round(supportTopY)) > 1e-6;
                if (needsHalfBase) {
                    placeBridgeBrick(xc, BS.h * 0.25, zCenter - 2, 's', 'dsbase' + k, null, true);
                    placeBridgeBrick(xc, BS.h * 0.25, zCenter,     's', 'dsbase' + k, null, true);
                    placeBridgeBrick(xc, BS.h * 0.25, zCenter + 2, 's', 'dsbase' + k, null, true);
                }
                const firstFullY = needsHalfBase ? BS.h : devGroundY;
                for (let fy = firstFullY; fy <= supportTopY - BS.h * 0.5 + 1e-6; fy += BS.h) {
                    const fanch = fy <= firstFullY + 1e-6;
                    placeBridgeBrick(xc, fy, zCenter - 2, 'z', 'dsfill' + k, null, fanch);
                    placeBridgeBrick(xc, fy, zCenter,     'z', 'dsfill' + k, null, fanch);
                    placeBridgeBrick(xc, fy, zCenter + 2, 'z', 'dsfill' + k, null, fanch);
                }
                placeBridgeBrick(xc, stepY, zCenter - 2, 's', 'dstep' + k, null, true);
                placeBridgeBrick(xc, stepY, zCenter,     's', 'dstep' + k, null, true);
                placeBridgeBrick(xc, stepY, zCenter + 2, 's', 'dstep' + k, null, true);
            }
        }

        addBridgeFoundationFootings();
        storyBridgeBudget = placedCount;
        return;
    }
    // === End dev bridge — production bridge masonry follows unchanged ===

    // --- Arch rings (anchored at both ends, re-spaced for 2-brick piers) ---
    for (let i = 0; i < archCount; i++) {
        const centerX = archCenters[i];
        for (let row = 0; row < tunnelRows; row++) {
            const z = zCenter + (row - (tunnelRows - 1) * 0.5) * zStep;
            for (let j = 0; j < voussoirCount; j++) {
                const theta = startTheta - j * TOWER_A_STEP;
                const x = centerX + Math.cos(theta) * archRadius;
                const y = archSpringY + Math.sin(theta) * archRadius;
                radial.set(Math.cos(theta), Math.sin(theta), 0).normalize();
                tangent.set(-Math.sin(theta), Math.cos(theta), 0).normalize();
                basis.makeBasis(tangent, normalZ, radial);
                wedgeQ.setFromRotationMatrix(basis);
                placeBridgeWedge(x, y, z, wedgeQ, (j === 0 || j === voussoirCount - 1));
            }
        }
    }

    // --- Levels ---
    const deckY = 5.5;                 // road centre above the bearing course
    const subTopY = 4.0;               // height target; final full course spans y=3.0..4.0
    const groundY = BS.h * 0.5;        // 0.5: lowest brick centre
    const carveClear = RO + archMortarClearance;

    // --- Solid substructure: piers / abutments / spandrels with arches carved out.
    //     Z-bricks (1 wide in X) butt cleanly on a 1 m X grid; arch tunnels are
    //     left empty so there is no overlap with the voussoir ring. ---
    for (let xc = -supportSpanHalf + 0.5; xc <= supportSpanHalf - 0.5 + 1e-6; xc += 1.0) {
        const inSupportBand = isSupportBandX(xc);
        for (let y = groundY; y <= subTopY + 1e-6; y += BS.h) {
            if (inSupportBand) continue;
            if (archCellDist(xc, y) < carveClear) continue;
            const isFoundationRow = y <= groundY + 1e-6;
            const isDeckTieRow = (y >= subTopY - 1e-6) && isRoadTieX(xc);
            // Haunch rows: the first course whose cell BELOW was carved out by
            // the arch � these bricks hover over the voussoir ring on the snap
            // grid. Anchor them (heavy + damped) so a blast doesn't free-fall
            // them onto the arch and unzip the span.
            const isHaunchRow = !isFoundationRow && archCellDist(xc, y - BS.h) < carveClear;
            const isAnchorRow = isFoundationRow || isDeckTieRow || isHaunchRow;
            placeBridgeBrick(xc, y, zCenter - 2, 'z', 'sub', null, isAnchorRow);
            placeBridgeBrick(xc, y, zCenter,     'z', 'sub', null, isAnchorRow);
            placeBridgeBrick(xc, y, zCenter + 2, 'z', 'sub', null, isAnchorRow);
        }
    }

    // --- Between-arch support piers, centred in each bay.
    //     Every course fills the full 2 x 6 m pier footprint. Alternating
    //     X/Z running bond interlocks the masonry without overlapping bricks;
    //     the old sparse rows left one-metre voids under half of each course.
    for (const sx of supportBands) {
        for (let y = groundY; y <= subTopY + 1e-6; y += BS.h) {
            const supportRow = Math.round((y - groundY) / BS.h);
            const supportPhase = ((supportRow % 2) + 2) % 2;
            const isFoundationRow = y <= groundY + 1e-6;
            if (!supportPhase) {
                for (let zc = zCenter - 2.5; zc <= zCenter + 2.5 + 1e-6; zc += 1.0) {
                    placeBridgeBrick(sx, y, zc, 'x', 'support-rib-a', null, isFoundationRow);
                }
            } else {
                for (const xc of [sx - 0.5, sx + 0.5]) {
                    for (const zc of [zCenter - 2, zCenter, zCenter + 2]) {
                        placeBridgeBrick(xc, y, zc, 'z', 'support-rib-b', null, isFoundationRow);
                    }
                }
            }
        }
    }

    // The full-height grid ends at centre y=3.5 (top y=4.0). Fill the actual
    // 0.5 m gap below the bearing, except where the arch crown reaches y=4.5.
    const supportCapY = subTopY + BS.h * 0.25;
    for (let xc = -supportSpanHalf + 1.0; xc <= supportSpanHalf - 1.0 + 1e-6; xc += 2.0) {
        if (archRectDist(xc, supportCapY, WALL_BRICK_HALF_LEN, BS.h * 0.25) < carveClear) continue;
        for (let zc = zCenter - 3; zc <= zCenter + 3 + 1e-6; zc += 1.0) {
            placeBridgeBrick(xc, supportCapY, zc, 'h', 'deck-support-cap', null, true);
        }
    }

    // --- Deck bearing course: half-height slab layer that fills the exact
    //     0.5 m gap between the substructure/arch top (y=4.5) and the deck
    //     underside (y=5.0). The previous full-height X-brick
    //     caps at subTopY overlapped the top substructure course and were all
    //     pruned by the AABB check � so the whole road spawned floating in
    //     mid-air and one explosive wake unzipped the entire span. Slabs are
    //     laid continuously (2 m pitch, butted) under all seven road lanes;
    //     over the support bands they bridge the 1 m bay like lintels, resting
    //     on the sub columns either side.
    const bearingY = subTopY + BS.h * 0.75;   // 4.75: spans 4.5..5.0
    for (let xc = -supportSpanHalf + 1.0; xc <= supportSpanHalf - 1.0 + 1e-6; xc += 2.0) {
        for (let zc = zCenter - 3; zc <= zCenter + 3 + 1e-6; zc += 1.0) {
            placeBridgeBrick(xc, bearingY, zc, 'h', 'deck-bearing', null, true);
        }
    }

    // Continuous trench-floor physics for every bridge mode catches rubble on
    // the bed. Discrete footings below meet the dynamic masonry exactly at y=0.
    const trenchFloorTopY = -(WATER_DEPTH_M * 2);   // -1.4
    addStoryBridgeGroundBody(
        0, zCenter,
        STORY_BRIDGE_TRENCH_HALF_X * 2 + 4,
        tunnelRows + 4,
        trenchFloorTopY
    );

    // --- One staggered Z-brick deck column (shared by road + ramp body).
    //     Even columns lay z-bricks at -2/0/+2; odd columns are offset half a
    //     brick (�1) and add outer edge bricks (�3) under the parapets.
    //     NOTE: place order decides which brick survives AABB pruning � a
    //     first-placed gap cube used to prune the odd column's lane brick and
    //     punch 1.5 m holes in the road, so cubes are gone and z-bricks go first.
    const placeDeckColumn = (xc, yc, quat, isAnchor = false) => {
        const phase = ((Math.round(xc - 0.5) % 2) + 2) % 2;
        if (!phase) {
            placeBridgeBrick(xc, yc, zCenter - 2, 'z', 'deck', quat, isAnchor);
            placeBridgeBrick(xc, yc, zCenter,     'z', 'deck', quat, isAnchor);
            placeBridgeBrick(xc, yc, zCenter + 2, 'z', 'deck', quat, isAnchor);
        } else {
            placeBridgeBrick(xc, yc, zCenter - 1, 'z', 'deck', quat, isAnchor);
            placeBridgeBrick(xc, yc, zCenter + 1, 'z', 'deck', quat, isAnchor);
            placeBridgeBrick(xc, yc, zCenter - 3, 'z', 'deck-edge', quat, isAnchor);
            placeBridgeBrick(xc, yc, zCenter + 3, 'z', 'deck-edge', quat, isAnchor);
        }
    };

    // --- Road surface: longitudinal X-brick beams ---
    // A real stone bridge deck is spanned by long beams resting on piers.
    // Replacing the staggered Z-brick running bond with continuous X-aligned
    // beams (2 m long) makes each deck plank a heavy, stable body that is far
    // less sensitive to small impulses. The beams sit directly on the
    // substructure/bearing course and are locked together by transverse ties
    // over every support band, so a local hit breaches one bay instead of
    // rippling the whole span.
    const roadSpanHalf = deckHalf + STORY_BRIDGE_RAMP_START_OFFSET;
    const deckBeamRowsZ = [zCenter - 3, zCenter - 2, zCenter - 1, zCenter,
                           zCenter + 1, zCenter + 2, zCenter + 3];
    const strengthenLastBrick = (mass, linearDamp, angularDamp) => {
        const e = bricks[bricks.length - 1];
        if (!e || !e.body) return;
        e.body.mass = Math.max(e.body.mass || 0, mass);
        e.body.updateMassProperties();
        e.body.linearDamping = Math.max(e.body.linearDamping, linearDamp);
        e.body.angularDamping = Math.max(e.body.angularDamping, angularDamp);
        e.body.sleep();
    };
    for (const zc of deckBeamRowsZ) {
        for (let xc = -roadSpanHalf + 1.0; xc <= roadSpanHalf - 1.0 + 1e-6; xc += 2.0) {
            const overSupport = isSupportBandX(xc) || isSupportBandX(xc - 1.0) || isSupportBandX(xc + 1.0);
            const isTie = isRoadTieX(xc);
            const isAnchor = overSupport || isTie;
            placeBridgeBrick(xc, deckY, zc, 'x', 'deck-beam', null, isAnchor);
            strengthenLastBrick(isAnchor ? 320 : 240, 0.45, 0.78);
        }
    }
    // Transverse ties over support bands lock the longitudinal beams together.
    for (const sx of supportBands) {
        for (const zc of [zCenter - 2, zCenter, zCenter + 2]) {
            placeBridgeBrick(sx, deckY, zc, 'z', 'deck-tie', null, true);
            strengthenLastBrick(300, 0.45, 0.78);
        }
    }

    // --- Side parapets rebuilt as a simple stable running bond:
    // X-bricks are 2 m long, so centres must be spaced by BS.w (2 m) to avoid
    // 50% overlap. Alternate courses are shifted by half a brick (1 m).
    const parapetBaseY = deckY;
    const parapetZNeg = zCenter - 3;
    const parapetZPos = zCenter + 3;
    const parapetCourses = 3;
    const parapetPitch = BS.w;
    const parapetHalfBrick = BS.w * 0.5;
    const parapetSpanHalf = roadSpanHalf;
    for (const pz of [parapetZNeg, parapetZPos]) {
        for (let course = 0; course < parapetCourses; course++) {
            if (course === 0) continue; // keep lower sightline row open
            const shift = (course % 2) * parapetHalfBrick;
            const rowMin = -parapetSpanHalf + parapetHalfBrick + shift;
            const rowMax = parapetSpanHalf - parapetHalfBrick - shift;
            const isMiddleCourse = course === 1;
            const isTopCourse = course === (parapetCourses - 1);
            for (let xc = rowMin; xc <= rowMax + 1e-6; xc += parapetPitch) {
                const y = parapetBaseY + course * BS.h;
                const brickIndex = Math.round((xc - rowMin) / parapetPitch);
                const isRowStart = Math.abs(xc - rowMin) < 1e-6;
                const isRowEnd = Math.abs(xc - rowMax) < 1e-6;

                if (isMiddleCourse && !isRowStart && !isRowEnd && (brickIndex % 2 === 1)) {
                    continue;
                }

                if (isTopCourse && (isRowStart || isRowEnd)) {
                    placeBridgeBrick(xc, y - BS.h * 0.5, pz, 'y', 'parapet-top-end-cap');
                    continue;
                }

                placeBridgeBrick(xc, y, pz, 'x', `parapet-course-${course}`);
            }
        }
    }

    // --- Ramps: twelve half-height rises with one-metre treads. Rotated slabs
    //     are 1 m along X and 2 m across Z, giving a walkable 1:2 stair slope.
    const rampLen = Math.round(STORY_BRIDGE_RAMP_LEN);
    const rampOccupiedCells = new Set();
    const placeRampBrick = (x, y, z, orient, extraKey, isAnchor = false) => {
        const sx = snap(x, 0.25);
        const sy = snap(y, 0.25);
        const sz = snap(z, 0.25);
        const cellKey = `${sx}|${sy}|${sz}`;
        if (rampOccupiedCells.has(cellKey)) return;
        rampOccupiedCells.add(cellKey);
        placeBridgeBrick(sx, sy, sz, orient, extraKey, null, isAnchor);
    };

    // One deck-style Z-brick row at (xc, y) — identical layout to placeDeckColumn.
    const placeRampRow = (xc, y, key, isAnchor = false) => {
        const phase = ((Math.round(xc - 0.5) % 2) + 2) % 2;
        if (!phase) {
            placeRampBrick(xc, y, zCenter - 2, 'z', `${key}-n2`, isAnchor);
            placeRampBrick(xc, y, zCenter,     'z', `${key}-0`,  isAnchor);
            placeRampBrick(xc, y, zCenter + 2, 'z', `${key}-p2`, isAnchor);
        } else {
            placeRampBrick(xc, y, zCenter - 1, 'z', `${key}-n1`, isAnchor);
            placeRampBrick(xc, y, zCenter + 1, 'z', `${key}-p1`, isAnchor);
            placeRampBrick(xc, y, zCenter - 3, 'z', `${key}-n3`, isAnchor);
            placeRampBrick(xc, y, zCenter + 3, 'z', `${key}-p3`, isAnchor);
        }
    };

    const placeRampSlabRow = (xc, y, key, isAnchor = false) => {
        for (const zc of [zCenter - 2, zCenter, zCenter + 2]) {
            placeRampBrick(xc, y, zc, 's', `${key}-${zc}`, isAnchor);
        }
    };

    const placeRampColumn = (xc, surfaceY) => {
        const slabCenterY = surfaceY - BS.h * 0.25;
        const supportTopY = surfaceY - BS.h * 0.5;
        const needsHalfBase = Math.abs(supportTopY - Math.round(supportTopY)) > 1e-6;
        if (needsHalfBase) placeRampSlabRow(xc, BS.h * 0.25, `rbase-${xc}`, true);
        const firstFullY = needsHalfBase ? BS.h : groundY;
        for (let y = firstFullY; y <= supportTopY - BS.h * 0.5 + 1e-6; y += BS.h) {
            placeRampRow(xc, y, `rcore-${xc}-${y}`, y <= firstFullY + 1e-6);
        }
        placeRampSlabRow(xc, slabCenterY, `rtread-${xc}`, true);
    };

    const deckSurfaceY = deckY + BS.h * 0.5;
    for (const sgn of [-1, 1]) {
        for (let k = 1; k <= rampLen; k++) {
            const xc = sgn * (deckHalf + STORY_BRIDGE_RAMP_START_OFFSET + k - 0.5);
            const surfaceY = Math.max(BS.h * 0.5, deckSurfaceY - k * BS.h * 0.5);
            placeRampColumn(xc, surfaceY);
        }
    }

    addBridgeFoundationFootings();
    storyBridgeBudget = placedCount;

}

function spawnStoryBridgeConvoy(diffKey) {
    if (guardsDisabled) return;

    // Rebuild bridge wave cleanly on each bridge-stage entry.
    for (let i = npcList.length - 1; i >= 0; i--) {
        const n = npcList[i];
        if (n.storyRole !== 'bridge') continue;
        if (!n.isRagdoll && n.group) scene.remove(n.group);
        npcList.splice(i, 1);
    }

    const diffCfg = DIFFICULTIES[diffKey] || DIFFICULTIES.knight;
    const convoyByDifficulty = {
        squire: 2,
        knight: 5,
        warlord: 9,
        extreme: 12,
    };
    const walkers = convoyByDifficulty[diffKey] ?? Math.max(2, diffCfg.knights || 3);
    const minX = -STORY_BRIDGE_APPROACH_X;
    const maxX =  STORY_BRIDGE_APPROACH_X;

    for (let i = 0; i < walkers; i++) {
        const lane = (i % 2 === 0) ? -0.85 : 0.85;
        const row = Math.floor(i / 2);
        const spawnX = minX - row * 0.7;
        const spawnZ = STORY_BRIDGE_Z + lane;
        const supportY = storyBridgeSupportY(spawnX, spawnZ);
        const spawnY = (supportY != null)
            ? (supportY + 0.05)
            : (npcGroundY(spawnX, spawnZ) + 0.05);
        const weapon = Math.random() < 0.35 ? 'axe' : 'sword';
        const npc = buildNPC(spawnX, spawnZ, spawnY, Math.PI / 2, weapon);

        // Bridge convoy are always marching melee soldiers, never tower archers.
        npc.isTowerGuard = false;
        npc.arrowTimer = 0;

        npc.storyRole = 'bridge';
        npc.storyBridgeWalker = true;
        npc.storyBridgeCrossed = false;
        npc.storyBridgeMinX = minX;
        npc.storyBridgeMaxX = maxX;
        npc.storyBridgeSpeed = 1.25 + Math.random() * 0.45;
        npc.storyBridgeVy = 0;
        npc.storyBridgeFalling = false;
        npc.walking = false; // handled by updateStoryBridgeConvoy until crossing completes
        npc.waypoints = [];
        npc.tauntCooldown = BRIDGE_TAUNT_INTERVAL_BASE * 0.7 + Math.random() * BRIDGE_TAUNT_INTERVAL_JITTER;
        npc.bridgeTurnLock = false;
        npc.clearedBridge = false;
        npc.chaseOffsetX = (Math.random() - 0.5) * 5.0;
    }
}

// Analytical bridge surface Y at a given X position.
// Returns the expected walking surface: 0 on the approach road, half-height
// steps on the ramp, and flat at deck height across the main span + arch piers.
// This avoids all brick-scan filter headaches (wall bricks, arch keystones, etc.)
// and gives exactly the same surface the player walks on.
// deckY=5.5 (brick centres); deck top surface = deckY + BS.h*0.5 = 6.0 m.
const _BRIDGE_DECK_Y = 6.0;
const _BRIDGE_RAMP_INNER = STORY_BRIDGE_DECK_HALF + STORY_BRIDGE_RAMP_START_OFFSET; // 24
function bridgeWalkerSurfaceY(x) {
    const ax = Math.abs(x);
    if (ax >= STORY_BRIDGE_RAMP_OUTER_X) return 0;           // approach road
    if (ax <= _BRIDGE_RAMP_INNER) return _BRIDGE_DECK_Y;    // flat deck + arch section
    const step = Math.min(
        STORY_BRIDGE_RAMP_LEN,
        Math.floor(ax - _BRIDGE_RAMP_INNER) + 1
    );
    return Math.max(BS.h * 0.5, _BRIDGE_DECK_Y - step * BS.h * 0.5);
}

function storyBridgeSupportY(x, z, currentY = 8) {
    // Used only to detect destroyed-deck holes: if no bridge brick exists within
    // radius near the analytical surface, the NPC should fall.
    const R2 = 1.8 * 1.8;
    let best = -Infinity;
    for (const b of bricks) {
        if (b.storyRole !== 'bridge' || !b.body) continue;
        const dx = b.body.position.x - x;
        const dz = b.body.position.z - z;
        if (dx * dx + dz * dz > R2) continue;
        const topY = (b.body.aabb && b.body.aabb.upperBound.y > -100)
            ? b.body.aabb.upperBound.y
            : (b.body.position.y + 0.5);
        if (topY > best) best = topY;
    }
    return Number.isFinite(best) ? best : null;
}

function detachStoryBody(body) {
    if (!body || !body.world) return;
    body.world.removeBody(body);
    body._storyDetached = true;
}

function attachStoryBody(body) {
    if (!body || body.world || !body._storyDetached) return;
    world.addBody(body);
    body._storyDetached = false;
}

function getActiveStoryRole() {
    // In classic/new-level modes we can still have one role explicitly
    // suppressed; treat the visible role as active so brick counts and
    // per-frame brick loops don't include hidden-level geometry.
    if (storyBridgeSuppressed && !storyCastleSuppressed) return 'castle';
    if (!storyBridgeSuppressed && storyCastleSuppressed) return 'bridge';

    if (!storyModeEnabled) return null;
    if (storyStage === 1) return 'bridge';
    if (storyStage === 2) return 'castle';
    return null;
}

let storyBridgeBrickCache = [];
let storyCastleBrickCache = [];
let storyBrickCacheSize = -1;

function rebuildStoryBrickCachesIfNeeded() {
    if (storyBrickCacheSize === bricks.length) return;
    storyBridgeBrickCache = [];
    storyCastleBrickCache = [];
    for (const b of bricks) {
        const role = b.storyRole || b.body?._storyRole || 'castle';
        if (role === 'bridge') storyBridgeBrickCache.push(b);
        else storyCastleBrickCache.push(b);
    }
    storyBrickCacheSize = bricks.length;
}

function getStoryRoleBricks(role) {
    if (!role) return bricks;
    rebuildStoryBrickCachesIfNeeded();
    return role === 'bridge' ? storyBridgeBrickCache : storyCastleBrickCache;
}

function getFrameActiveBricks() {
    const activeRole = getActiveStoryRole();
    return activeRole ? getStoryRoleBricks(activeRole) : bricks;
}

function isBrickInInactiveStoryLevel(b) {
    if (!b) return false;
    const role = b.storyRole || b.body?._storyRole || null;
    if (!role) return false;
    const activeRole = getActiveStoryRole();
    return !!(activeRole && role !== activeRole);
}

function getActiveLevelBrickCount() {
    if (templateLevelEnabled) return 0;
    const activeRole = getActiveStoryRole();
    if (!activeRole) return bricks.length;
    return getStoryRoleBricks(activeRole).length;
}

function updateTotalBricksUi() {
    const el = document.getElementById("totalBricks");
    if (!el) return;
    el.textContent = String(getActiveLevelBrickCount());
}

function syncBrickVisualTransform(b) {
    if (!b || !b.body || b.idx < 0) return;
    _iDummy.position.copy(b.body.position);
    _iDummy.quaternion.copy(b.body.quaternion);
    if (b.isPlank && b.lenScale) _iDummy.scale.set(b.isZ ? 1 : b.lenScale, 1, b.isZ ? b.lenScale : 1);
    _iDummy.updateMatrix();
    _iDummy.scale.set(1, 1, 1);
    if (b.isPlank) {
        if (b.isZ) plankInstZ.setMatrixAt(b.idx, _iDummy.matrix);
        else       plankInstX.setMatrixAt(b.idx, _iDummy.matrix);
    } else if (b.isWedge) {
        towerInst.setMatrixAt(b.idx, _iDummy.matrix);
    } else {
        if (b.isCube) brickInstC.setMatrixAt(b.idx, _iDummy.matrix);
        else if (b.isSlab) brickInstH.setMatrixAt(b.idx, _iDummy.matrix);
        else if (b.isY) brickInstY.setMatrixAt(b.idx, _iDummy.matrix);
        else if (b.isZ) brickInstZ.setMatrixAt(b.idx, _iDummy.matrix);
        else            brickInstX.setMatrixAt(b.idx, _iDummy.matrix);
    }
    brickInstX.instanceMatrix.needsUpdate = true;
    brickInstZ.instanceMatrix.needsUpdate = true;
    brickInstY.instanceMatrix.needsUpdate = true;
    brickInstC.instanceMatrix.needsUpdate = true;
    brickInstH.instanceMatrix.needsUpdate = true;
    towerInst.instanceMatrix.needsUpdate = true;
    plankInstX.instanceMatrix.needsUpdate = true;
    plankInstZ.instanceMatrix.needsUpdate = true;
}

function setStoryCastleSuppressed(suppressed) {
    if (storyCastleSuppressed === suppressed) return;
    storyCastleSuppressed = suppressed;

    for (const body of castleMoatPhysicsBodies) {
        if (!body) continue;
        if (suppressed) {
            if (body._storyPrevMask === undefined) body._storyPrevMask = body.collisionFilterMask;
            body.collisionFilterMask = 0;
            body.velocity.set(0, 0, 0);
            body.angularVelocity.set(0, 0, 0);
            body.sleep();
            detachStoryBody(body);
        } else {
            attachStoryBody(body);
            if (body._storyPrevMask !== undefined) body.collisionFilterMask = body._storyPrevMask;
            body.sleep();
        }
    }

    // King's Bunker: while the castle stage is hidden, detach the room's
    // colliders. The island strips that frame the bunker footprint follow the
    // original slab's bridge lifecycle instead (registered at 8124-style below).
    for (const body of bunkerColliderBodies) {
        if (!body) continue;
        if (suppressed) {
            if (body._storyPrevMask === undefined) body._storyPrevMask = body.collisionFilterMask;
            body.collisionFilterMask = 0;
            body.sleep();
            detachStoryBody(body);
        } else {
            attachStoryBody(body);
            if (body._storyPrevMask !== undefined) body.collisionFilterMask = body._storyPrevMask;
        }
    }

    for (const b of bricks) {
        const role = b.storyRole || b.body?._storyRole || null;
        if (role === 'bridge') continue;
        const mesh = b.mesh;
        if (mesh) mesh.visible = !suppressed;
        if (!b.body) continue;
        if (suppressed) {
            if (!b._storyPrevPos) {
                b._storyPrevPos = new CANNON.Vec3(b.body.position.x, b.body.position.y, b.body.position.z);
                b._storyPrevQuat = new CANNON.Quaternion(b.body.quaternion.x, b.body.quaternion.y, b.body.quaternion.z, b.body.quaternion.w);
            }
            b.body.position.set(0, -5000, 0);
            b.body.velocity.set(0, 0, 0);
            b.body.angularVelocity.set(0, 0, 0);
            if (b._storyPrevMask === undefined) b._storyPrevMask = b.body.collisionFilterMask;
            b.body.collisionFilterMask = 0;
            b.body.sleep();
            detachStoryBody(b.body);
            syncBrickVisualTransform(b);
        } else if (b._storyPrevMask !== undefined) {
            attachStoryBody(b.body);
            b.body.collisionFilterMask = b._storyPrevMask;
            if (b._storyPrevPos) {
                b.body.position.copy(b._storyPrevPos);
                if (b._storyPrevQuat) b.body.quaternion.copy(b._storyPrevQuat);
            }
            b.body.wakeUp();
            syncBrickVisualTransform(b);
        }
    }

    if (Array.isArray(towerPlatforms)) {
        for (const p of towerPlatforms) {
            if (p.mesh) p.mesh.visible = !suppressed;
            if (!p.body) continue;
            if (suppressed) {
                if (p._storyPrevMask === undefined) p._storyPrevMask = p.body.collisionFilterMask;
                p.body.collisionFilterMask = 0;
                p.body.velocity.set(0, 0, 0);
                p.body.angularVelocity.set(0, 0, 0);
                p.body.sleep();
                detachStoryBody(p.body);
            } else if (p._storyPrevMask !== undefined) {
                attachStoryBody(p.body);
                p.body.collisionFilterMask = p._storyPrevMask;
                if (!p.dropped) p.body.sleep();
            }
        }
    }

    if (Array.isArray(banners)) {
        for (const b of banners) {
            if (b.mesh) b.mesh.visible = !suppressed;
        }
    }

    if (typeof dbPivot !== 'undefined' && dbPivot) dbPivot.visible = !suppressed;
    if (typeof dbMesh !== 'undefined' && dbMesh) dbMesh.visible = !suppressed;
    if (typeof dbBody !== 'undefined' && dbBody) {
        if (suppressed) {
            if (dbBody._storyPrevMask === undefined) dbBody._storyPrevMask = dbBody.collisionFilterMask;
            dbBody.collisionFilterMask = 0;
            detachStoryBody(dbBody);
        } else if (dbBody._storyPrevMask !== undefined) {
            attachStoryBody(dbBody);
            dbBody.collisionFilterMask = dbBody._storyPrevMask;
            syncDrawbridgePhysics();
        }
    }
    if (typeof chains !== 'undefined' && Array.isArray(chains)) {
        for (const ch of chains) {
            for (const seg of ch.segMeshes) seg.visible = !suppressed;
        }
    }

    if (typeof moatReflector !== 'undefined' && moatReflector) moatReflector.visible = !suppressed && !castleMoatDrained;
    for (const wp of levelWaterPlanes) {
        if (wp.levelRole !== 'castle') continue;
        const showLevelWater = !suppressed && devWaterFxEnabled && !(wp === castleMoatWaterPlane && castleMoatDrained);
        if (wp.underlay) wp.underlay.visible = showLevelWater;
        if (wp.ripple) wp.ripple.visible = showLevelWater;
        if (wp.ripple2) wp.ripple2.visible = showLevelWater;
        if (wp.ripple3) wp.ripple3.visible = showLevelWater;
        if (wp.foam) wp.foam.visible = showLevelWater;
    }
    for (const r of waterImpactRipples) {
        if (r.role !== 'castle') continue;
        if (!r.mesh) continue;
        r.mesh.visible = !suppressed && devWaterFxEnabled && waterFxImpactRipplesEnabled && r.active;
    }
    for (const m of castleSceneMeshes) {
        if (m) m.visible = !suppressed;
    }
    // Castle water caps / library surfaces live in castleSceneMeshes too
    // (force-shown just above) � re-apply the dev water toggle last. A drained
    // moat (King's Bunker switch) stays drained across stage toggles.
    for (const wm of bridgeLibraryWaterSurfaces) {
        if (!wm) continue;
        if ((wm.userData?.waterRole || 'bridge') !== 'castle') continue;
        wm.visible = !suppressed && devWaterFxEnabled && !(wm === castleMoatWaterCap && castleMoatDrained);
    }
    for (const cap of storyWaterCapMeshes) {
        if (!cap) continue;
        if ((cap.userData?.waterRole || 'bridge') !== 'castle') continue;
        cap.visible = !suppressed && devWaterFxEnabled && !(cap === castleMoatWaterCap && castleMoatDrained);
    }
}

function setStoryBridgeSuppressed(suppressed) {
    if (storyBridgeSuppressed === suppressed) return;
    storyBridgeSuppressed = suppressed;
    const bridge2Only = bridge2ModeActive && !suppressed;

    for (const body of storyBridgeSceneBodies) {
        if (!body) continue;
        const shouldAttach = body._bridgeAttachWhenSuppressed ? suppressed : !suppressed;
        if (shouldAttach) attachStoryBody(body);
        else detachStoryBody(body);
    }

    for (const b of bricks) {
        const role = b.storyRole || b.body?._storyRole || null;
        if (role !== 'bridge') continue;
        const mesh = b.mesh;
        if (mesh) mesh.visible = !suppressed;
        if (!b.body) continue;
        if (suppressed) {
            if (!b._storyPrevPos) {
                b._storyPrevPos = new CANNON.Vec3(b.body.position.x, b.body.position.y, b.body.position.z);
                b._storyPrevQuat = new CANNON.Quaternion(b.body.quaternion.x, b.body.quaternion.y, b.body.quaternion.z, b.body.quaternion.w);
            }
            b.body.position.set(0, -5000, 0);
            b.body.velocity.set(0, 0, 0);
            b.body.angularVelocity.set(0, 0, 0);
            if (b._storyPrevMask === undefined) b._storyPrevMask = b.body.collisionFilterMask;
            b.body.collisionFilterMask = 0;
            b.body.sleep();
            detachStoryBody(b.body);
            syncBrickVisualTransform(b);
        } else if (b._storyPrevMask !== undefined) {
            attachStoryBody(b.body);
            b.body.collisionFilterMask = b._storyPrevMask;
            if (b._storyPrevPos) {
                b.body.position.copy(b._storyPrevPos);
                if (b._storyPrevQuat) b.body.quaternion.copy(b._storyPrevQuat);
            }
            b.body.sleep();
            syncBrickVisualTransform(b);
        }
    }

    for (const m of storyBridgeSceneMeshes) {
        if (!m) continue;
        const keepInBridge2 = !!m.userData?.bridge2KeepVisible;
        if (suppressed) {
            m.visible = false;
            continue;
        }
        m.visible = bridge2Only ? keepInBridge2 : true;
    }

    for (const wp of levelWaterPlanes) {
        if (wp.levelRole !== 'bridge') continue;
        const showLevelWater = bridge2Only ? false : (!suppressed && devWaterFxEnabled);
        if (wp.underlay) wp.underlay.visible = showLevelWater;
        if (wp.ripple) wp.ripple.visible = showLevelWater;
        if (wp.ripple2) wp.ripple2.visible = showLevelWater;
        if (wp.ripple3) wp.ripple3.visible = showLevelWater;
        if (wp.foam) wp.foam.visible = showLevelWater;
    }
    for (const r of waterImpactRipples) {
        if (r.role !== 'bridge') continue;
        if (!r.mesh) continue;
        r.mesh.visible = !bridge2Only && !suppressed && devWaterFxEnabled && waterFxImpactRipplesEnabled && r.active;
    }
    for (const wm of bridgeLibraryWaterSurfaces) {
        if (!wm) continue;
        const role = wm.userData?.waterRole || 'bridge';
        if (role !== 'bridge') continue;
        wm.visible = !bridge2Only && !suppressed && devWaterFxEnabled;
    }
    for (const cap of storyWaterCapMeshes) {
        if (!cap) continue;
        const role = cap.userData?.waterRole || 'bridge';
        if (role !== 'bridge') continue;
        // Caps also sit in storyBridgeSceneMeshes (force-shown above), so
        // re-apply the water toggle last.
        cap.visible = !bridge2Only && !suppressed && devWaterFxEnabled;
    }
}

document.getElementById("totalBricks").textContent = bricks.length;

// === Drawbridge ===
function makeWoodTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 128; canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#5c3a1e";
    ctx.fillRect(0, 0, 128, 64);
    for (let i = 0; i < 22; i++) {
        const y = Math.random() * 64;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(42, y + (Math.random() - 0.5) * 5, 85, y + (Math.random() - 0.5) * 5, 128, y + (Math.random() - 0.5) * 3);
        const v = (Math.random() * 35) | 0;
        ctx.strokeStyle = `rgba(${20 + v},${12 + v},${5 + v},0.55)`;
        ctx.lineWidth = Math.random() * 2.5 + 0.5;
        ctx.stroke();
    }
    for (let i = 0; i < 800; i++) {
        const x = Math.random() * 128;
        const y = Math.random() * 64;
        const v = ((Math.random() * 30) - 15) | 0;
        ctx.fillStyle = `rgba(${80 + v},${50 + v},${25 + v},0.18)`;
        ctx.fillRect(x, y, 1, 1);
    }
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(5, 1);
    return t;
}

const woodMat = new THREE.MeshStandardMaterial({ map: makeWoodTexture(), roughness: 0.9, metalness: 0.0 });
const chainMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.25, metalness: 0.85 });

const DB_W = 6.0;
const DB_H = 0.44;
const DB_LENGTH = 9.0;

const dbPivot = new THREE.Group();
dbPivot.position.set(0, DB_H / 2, CFZ);
scene.add(dbPivot);

const dbMesh = new THREE.Mesh(
    new THREE.BoxGeometry(DB_W, DB_H, DB_LENGTH),
    woodMat
);
dbMesh.position.set(0, 0, -DB_LENGTH / 2);
dbMesh.castShadow = true;
dbMesh.receiveShadow = true;
dbPivot.add(dbMesh);

const dbIronMat = new THREE.MeshStandardMaterial({ color: 0x22252a, roughness: 0.26, metalness: 0.9 });
const dbBrassMat = new THREE.MeshStandardMaterial({ color: 0x9b7a30, roughness: 0.35, metalness: 0.95 });
const dbWearMat = new THREE.MeshStandardMaterial({ color: 0x4a351f, roughness: 0.97, metalness: 0.02 });
const DB_TOP_Y = DB_H * 0.5 + 0.001;
const DB_FRONT_FACE_Y = -DB_TOP_Y;

// Decorative iron hardware on the drawbridge (strap bands, hinge plates, rivets).
// Panel extents are clamped to the visible door section of the bridge.
const DB_BAR_PANEL_Z = Math.min(DB_LENGTH - 0.9, GATE_ROWS * BS.h - 0.3);
const DB_BAR_CENTER_Z = -0.55;
const DB_BAR_SPAN_X = DB_W - 0.7;
const DB_BAR_X = [-1.95, -0.65, 0.65, 1.95];
const DB_BAR_Z_MIN = DB_BAR_CENTER_Z - DB_BAR_PANEL_Z * 0.5;
const DB_BAR_Z_MAX = DB_BAR_CENTER_Z + DB_BAR_PANEL_Z * 0.5;

function dbBarZ(t) {
    return DB_BAR_Z_MIN + (DB_BAR_Z_MAX - DB_BAR_Z_MIN) * t;
}

// Longitudinal strap bands.
DB_BAR_X.forEach((sx) => {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, DB_BAR_PANEL_Z), dbIronMat);
    strap.position.set(sx, DB_FRONT_FACE_Y, DB_BAR_CENTER_Z);
    strap.castShadow = true;
    dbMesh.add(strap);
});

// Cross braces across the bar panel.
[0.20, 0.48, 0.76].forEach((t) => {
    const brace = new THREE.Mesh(new THREE.BoxGeometry(DB_BAR_SPAN_X, 0.032, 0.22), dbIronMat);
    brace.position.set(0, DB_FRONT_FACE_Y - 0.001, dbBarZ(t));
    brace.castShadow = true;
    dbMesh.add(brace);
});

// Lower reinforcement bars near the bottom of the panel.
[0.90, 0.97].forEach((t) => {
    const hingeBand = new THREE.Mesh(new THREE.BoxGeometry(DB_BAR_SPAN_X, 0.05, 0.16), dbIronMat);
    hingeBand.position.set(0, DB_FRONT_FACE_Y - 0.001, dbBarZ(t));
    hingeBand.castShadow = true;
    dbMesh.add(hingeBand);
});

// Side edge reinforcement plates where chain load is transferred.
[-DB_W * 0.5 + 0.06, DB_W * 0.5 - 0.06].forEach((sx) => {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.19, 1.35), dbIronMat);
    plate.position.set(sx, 0, -0.95);
    plate.castShadow = true;
    dbMesh.add(plate);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.022, 8, 16), dbIronMat);
    ring.position.set(sx * 0.96, -0.17, -1.26);
    ring.rotation.y = Math.PI / 2;
    ring.castShadow = true;
    dbMesh.add(ring);
});

// Rivets on straps for extra close-up detail.
const rivetGeo = new THREE.SphereGeometry(0.028, 8, 6);
for (const sx of DB_BAR_X) {
    for (const t of [0.08, 0.24, 0.42, 0.60, 0.78, 0.94]) {
        const rv = new THREE.Mesh(rivetGeo, dbBrassMat);
        rv.position.set(sx, DB_FRONT_FACE_Y - 0.008, dbBarZ(t));
        rv.castShadow = true;
        dbMesh.add(rv);
    }
}

// Abrasion strips and patch repairs where wheels/boots and chains grind wood.
for (const sx of DB_BAR_X) {
    const scuff = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.012, DB_BAR_PANEL_Z - 0.3), dbWearMat);
    scuff.position.set(sx + (Math.random() - 0.5) * 0.05, DB_TOP_Y + 0.006, DB_BAR_CENTER_Z + 0.08);
    scuff.rotation.y = (Math.random() - 0.5) * 0.06;
    dbMesh.add(scuff);
}
[-1.45, 1.45].forEach((sx) => {
    const patch = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.016, 0.42), dbWearMat);
    patch.position.set(sx, DB_TOP_Y + 0.006, dbBarZ(0.86));
    patch.rotation.y = sx > 0 ? 0.08 : -0.08;
    dbMesh.add(patch);
});

// Kinematic physics body ? mass 0, manually synced each frame
const dbBody = new CANNON.Body({ mass: 0 });
dbBody.addShape(new CANNON.Box(new CANNON.Vec3(DB_W / 2, DB_H / 2, DB_LENGTH / 2)));
dbBody.collisionFilterGroup = CGROUP_BRIDGE;
dbBody.collisionFilterMask  = -1 ^ CGROUP_BRICK;  // collide with everything except bricks
world.addBody(dbBody);

let dbAngle     = Math.PI / 2;           // start vertical (closed)
let dbOpening   = false;
const DB_SPEED  = (Math.PI / 2) / 4.5;  // 4.5 s to fully open
let _drawbridgeCreakCooldown = 0;

// Begin lowering after 1.5 s so player sees it start closed
setTimeout(() => { dbOpening = true; }, 1500);

// Helper ? sync kinematic body to current pivot angle
function syncDrawbridgePhysics() {
    // Centre of the board in world space when pivot is at (0, DB_H/2, CFZ)
    // and board local pos is (0, 0, -DB_LENGTH/2)
    const cy = DB_H / 2 + (DB_LENGTH / 2) * Math.sin(dbAngle);
    const cz = CFZ      - (DB_LENGTH / 2) * Math.cos(dbAngle);
    dbBody.position.set(0, cy, cz);
    dbBody.quaternion.setFromEuler(dbAngle, 0, 0);
}
syncDrawbridgePhysics();

// Chains � verlet-simulated rope cables. Each chain is pinned at the gate-arch
// top and at the moving bridge-tip corner. The interior links sag under gravity
// and swing, so the chain goes slack when the bridge is raised and pulls taut
// as it lowers � proper physical behaviour rather than a static prop.
const chainY = GATE_ROWS * BS.h;
const CX_L   = -DB_W / 2;
const CX_R   =  DB_W / 2;

const chains = [];
const CHAIN_SEGMENTS = 14;
const CHAIN_GRAV     = -20;   // m/s^2 on the rope links
const _chainDir = new THREE.Vector3();
const _chainUp  = new THREE.Vector3(0, 1, 0);

// World-space bridge-tip corner for the current bridge angle.
function chainTipAnchor(x, out) {
    return out.set(
        x,
        DB_H / 2 + DB_LENGTH * Math.sin(dbAngle),
        CFZ      - DB_LENGTH * Math.cos(dbAngle)
    );
}

function makeChain(x) {
    const top = new THREE.Vector3(x, chainY, CFZ);
    const tip = chainTipAnchor(x, new THREE.Vector3());
    // Rest length = taut length when the bridge is fully lowered.
    const restLen = top.distanceTo(tip);
    const segLen  = restLen / CHAIN_SEGMENTS;
    const points  = [];
    for (let i = 0; i <= CHAIN_SEGMENTS; i++) {
        const p = top.clone().lerp(tip, i / CHAIN_SEGMENTS);
        points.push({ pos: p.clone(), prev: p.clone() });
    }
    const segMeshes = [];
    const segGeo = new THREE.CylinderGeometry(0.045, 0.045, segLen, 6);
    for (let i = 0; i < CHAIN_SEGMENTS; i++) {
        const seg = new THREE.Mesh(segGeo, chainMat);
        seg.castShadow = true;
        scene.add(seg);
        segMeshes.push(seg);
    }
    chains.push({ x, points, segMeshes, segLen, topPinned: true, tipPinned: true, _accum: 0 });
}

// Is the gate-arch brick that anchors this chain's top still in place?
// (Checks for a settled/standing brick near the top anchor point.)
function chainTopSupported(x) {
    const ax = x, ay = chainY, az = CFZ;
    const R_XZ = BS.w * 0.9, R_Y = BS.h * 2.0;
    for (const b of getFrameActiveBricks()) {
        if (b.body.mass > 0 && b.body.sleepState === 0) continue; // moving = not support
        const p = b.body.position;
        if (Math.abs(p.x - ax) > R_XZ) continue;
        if (Math.abs(p.z - az) > R_XZ) continue;
        if (Math.abs(p.y - ay) > R_Y)  continue;
        return true;
    }
    return false;
}

// One fixed-step verlet update for a single chain (stable regardless of FPS).
const CHAIN_FIXED_DT = 1 / 120;
const CHAIN_FLOOR    = 0.06;    // links pile on the ground rather than sink through
function stepChain(ch, topX, topY, topZ, tipX, tipY, tipZ) {
    const pts = ch.points;
    const last = pts.length - 1;
    const h2   = CHAIN_FIXED_DT * CHAIN_FIXED_DT;
    const damp = 0.985;
    const MAXV = ch.segLen * 0.9;   // per-step move clamp � kills explosions
    // Integrate free points (skip whichever ends are pinned).
    const loStart = ch.topPinned ? 1 : 0;
    const hiEnd   = ch.tipPinned ? last - 1 : last;
    for (let i = loStart; i <= hiEnd; i++) {
        const p = pts[i];
        let vx = (p.pos.x - p.prev.x) * damp;
        let vy = (p.pos.y - p.prev.y) * damp;
        let vz = (p.pos.z - p.prev.z) * damp;
        // Clamp velocity so a glitch can never fling a link out of sight.
        const v2 = vx*vx + vy*vy + vz*vz;
        if (v2 > MAXV*MAXV) { const s = MAXV / Math.sqrt(v2); vx*=s; vy*=s; vz*=s; }
        p.prev.copy(p.pos);
        p.pos.x += vx;
        p.pos.y += vy + CHAIN_GRAV * h2;
        p.pos.z += vz;
        // Ground collision: rest on the floor with a little horizontal friction.
        if (p.pos.y < CHAIN_FLOOR) {
            p.pos.y = CHAIN_FLOOR;
            p.prev.x += (p.pos.x - p.prev.x) * 0.5;
            p.prev.z += (p.pos.z - p.prev.z) * 0.5;
            p.prev.y = p.pos.y;
        }
    }
    // Relax distance constraints; re-pin whichever end(s) are still attached.
    for (let k = 0; k < 18; k++) {
        if (ch.topPinned) pts[0].pos.set(topX, topY, topZ);
        if (ch.tipPinned) pts[last].pos.set(tipX, tipY, tipZ);
        for (let i = 0; i < last; i++) {
            const a = pts[i].pos, b = pts[i + 1].pos;
            const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
            const d  = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
            const diff = ((d - ch.segLen) / d) * 0.5;
            let ox = dx * diff, oy = dy * diff, oz = dz * diff;
            const aFree = (i !== 0)        || !ch.topPinned;
            const bFree = (i + 1 !== last)  || !ch.tipPinned;
            if (aFree && bFree) {
                a.x += ox; a.y += oy; a.z += oz;
                b.x -= ox; b.y -= oy; b.z -= oz;
            } else if (aFree) {
                a.x += 2*ox; a.y += 2*oy; a.z += 2*oz;
            } else if (bFree) {
                b.x -= 2*ox; b.y -= 2*oy; b.z -= 2*oz;
            }
        }
    }
}

function updateChains(dt) {
    const _tip = _chainDir;  // reuse scratch (not needed simultaneously)
    const settledBridgeMobile = isMobileProfile && dbAngle <= 0.001;
    for (const ch of chains) {
        const pts = ch.points;
        const last = pts.length - 1;
        const topX = ch.x, topY = chainY, topZ = CFZ;
        chainTipAnchor(ch.x, _tip);
        // Release BOTH anchors once the gate-arch brick holding the top is gone,
        // so the freed chain drops straight down where it hangs (falls in situ)
        // instead of staying tied to the bridge tip and snapping onto it.
        if (ch.topPinned && _frameCount % 12 === 0 && !chainTopSupported(ch.x)) {
            ch.topPinned = false;
            ch.tipPinned = false;
            // Zero inherited velocity on every link so it starts falling cleanly
            // (a limp chain dropping) instead of snapping with stored energy.
            for (const p of pts) p.prev.copy(p.pos);
        }
        // Fixed-timestep accumulator ? frame-rate-independent, stable motion.
        ch._accum += Math.min(dt, 0.05);
        let iter = 0;
        const iterCap = settledBridgeMobile ? 2 : 6;
        while (ch._accum >= CHAIN_FIXED_DT && iter < iterCap) {
            stepChain(ch, topX, topY, topZ, _tip.x, _tip.y, _tip.z);
            ch._accum -= CHAIN_FIXED_DT;
            iter++;
        }
        // Orient each cylinder segment between consecutive points.
        for (let i = 0; i < ch.segMeshes.length; i++) {
            const a = pts[i].pos, b = pts[i + 1].pos;
            const seg = ch.segMeshes[i];
            seg.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
            _chainDir.set(b.x - a.x, b.y - a.y, b.z - a.z);
            const len = _chainDir.length() || 1e-6;
            seg.scale.y = len / ch.segLen;
            seg.quaternion.setFromUnitVectors(_chainUp, _chainDir.divideScalar(len));
        }
    }
}

makeChain(CX_L);
makeChain(CX_R);

// === NPC ? medieval guard standing inside the courtyard ===
// Each entry: { group, parts:[{mesh,hw,hh,hd,mass}], isRagdoll, ragdollParts:[{mesh,body}] }
// npcList declared at top of file

function buildNPC(xPos, zPos, yBase = 0, facingAngle = Math.PI, weaponType = 'sword') {
    const g = new THREE.Group();
    g.position.set(xPos, yBase, zPos);
    g.rotation.y = facingAngle;   // face toward the gate (toward the player) by default
    scene.add(g);

    const legMat    = new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.8 });
    const armourMat = new THREE.MeshStandardMaterial({ color: 0x7f8c8d, roughness: 0.35, metalness: 0.65 });
    const skinMat   = new THREE.MeshStandardMaterial({ color: 0xf0c080, roughness: 0.7 });
    const helmetMat = new THREE.MeshStandardMaterial({ color: 0x5d6d7e, roughness: 0.25, metalness: 0.80 });
    const woodMatW  = new THREE.MeshStandardMaterial({ color: 0x5c3a1e, roughness: 0.9 });
    const steelMat  = new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.18, metalness: 0.9 });
    const eyeMat    = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.4, metalness: 0.0 });
    const lipMat    = new THREE.MeshStandardMaterial({ color: 0x8a4f45, roughness: 0.85, metalness: 0.0 });

    const parts = [];  // {mesh, hw, hh, hd, mass, parent, pivotSelf, pivotParent}

    // Add a body part under `parentObj` (g, or a limb pivot group). `x,y,z` are
    // local to that parent. `joint` links it to another part for the ragdoll.
    function addPart(mesh, parentObj, x, y, z, hw, hh, hd, mass, joint) {
        mesh.castShadow = true;
        mesh.position.set(x, y, z);
        parentObj.add(mesh);
        parts.push({
            mesh, hw, hh, hd, mass,
            parent:      joint ? joint.parent   : null,
            pivotSelf:   joint ? joint.self     : null,
            pivotParent: joint ? joint.onParent : null,
        });
        return parts.length - 1;
    }

    // 0 � Torso (ragdoll root) � rounded chest/abdomen silhouette.
    const torsoGeo = mergeGeometries([
        new THREE.CylinderGeometry(0.22, 0.25, 0.50, 12).translate(0, 0, 0),
        new THREE.SphereGeometry(0.24, 12, 10).translate(0, 0.24, 0),
        new THREE.SphereGeometry(0.21, 12, 10).translate(0, -0.24, 0),
    ]);
    const iTorso = addPart(new THREE.Mesh(torsoGeo, armourMat.clone()),
        g, 0, 1.08, 0, 0.28, 0.38, 0.15, 20, null);

    // 1 � Head (spherical with simple face details)
    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 12), skinMat.clone());
    headMesh.scale.set(1.0, 0.96, 0.96);
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.017, 8, 6), eyeMat.clone());
    const eyeR = eyeL.clone();
    eyeL.position.set(-0.06, 0.015, 0.15);
    eyeR.position.set(0.06, 0.015, 0.15);
    const browL = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.016, 0.012), eyeMat.clone());
    const browR = browL.clone();
    browL.position.set(-0.06, 0.055, 0.147);
    browR.position.set(0.06, 0.055, 0.147);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.05, 6), skinMat.clone());
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, -0.005, 0.163);
    // Mouth rig: curved lip arc (? grin at scale.y=+1 ? n deep frown at -1),
    // a dark openable mouth interior (chuckling / shouting), and a teeth strip
    // that shows through the mocking grin.
    const mouthGroup = new THREE.Group();
    mouthGroup.position.set(0, -0.060, 0.150);
    const lipArc = new THREE.Mesh(
        new THREE.TorusGeometry(0.05, 0.011, 6, 14, Math.PI).rotateZ(Math.PI),
        lipMat.clone()
    );
    lipArc.material.side = THREE.DoubleSide;
    lipArc.position.z = 0.006;
    const mouthOpen = new THREE.Mesh(
        new THREE.SphereGeometry(0.032, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0x431614, roughness: 0.9 })
    );
    mouthOpen.scale.set(1.15, 0.02, 0.5);
    mouthOpen.visible = false;
    const teeth = new THREE.Mesh(
        new THREE.BoxGeometry(0.062, 0.018, 0.012),
        new THREE.MeshStandardMaterial({ color: 0xf2ead8, roughness: 0.55 })
    );
    teeth.position.set(0, -0.002, 0.010);
    teeth.visible = false;
    mouthGroup.add(mouthOpen, teeth, lipArc);
    headMesh.add(eyeL, eyeR, browL, browR, nose, mouthGroup);

    const iHead = addPart(headMesh,
        g, 0, 1.64, 0, 0.18, 0.18, 0.18, 6,
        { parent: iTorso, self: [0, -0.17, 0], onParent: [0, 0.39, 0] });

    // 2 � Helmet (top + brim merged into ONE piece so it can't split in two).
    // No ragdoll joint: it sits on the head while standing, but flies off freely
    // as a single piece the moment the figure is knocked into a ragdoll.
    const helmTop  = new THREE.CylinderGeometry(0.21, 0.22, 0.18, 10).translate(0, 0.05, 0);
    const helmBrim = new THREE.CylinderGeometry(0.27, 0.27, 0.05, 10).translate(0, -0.04, 0);
    const helmGeo  = mergeGeometries([helmTop, helmBrim]);
    addPart(new THREE.Mesh(helmGeo, helmetMat.clone()),
        g, 0, 1.85, 0, 0.27, 0.12, 0.27, 3, null);

    // Legs: thigh ? shin ? foot under a hip pivot, so the whole leg swings as
    // one when the pivot rotates (feet follow the thigh).
    function buildLeg(sx) {
        const hip = new THREE.Group();
        hip.position.set(sx, 0.74, 0);   // hip joint height
        g.add(hip);
        const iThigh = addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.10, 0.40, 10), legMat.clone()),
            hip, 0, -0.20, 0, 0.10, 0.20, 0.10, 6,
            { parent: iTorso, self: [0, 0.19, 0], onParent: [sx, -0.35, 0] });
        const iShin = addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.085, 0.40, 10), legMat.clone()),
            hip, 0, -0.56, 0, 0.085, 0.20, 0.085, 4,
            { parent: iThigh, self: [0, 0.19, 0], onParent: [0, -0.17, 0] });
        const footGeo = mergeGeometries([
            // Align feet with the NPC forward axis (local +Z) instead of sideways.
            new THREE.CylinderGeometry(0.055, 0.075, 0.24, 8).rotateX(Math.PI / 2).translate(0.02, 0, 0.06),
            new THREE.SphereGeometry(0.075, 8, 6).translate(0.02, 0, 0.17),
        ]);
        addPart(new THREE.Mesh(footGeo, legMat.clone()),
            hip, 0, -0.70, 0.07, 0.09, 0.06, 0.15, 2,
            { parent: iShin, self: [0, 0.05, -0.07], onParent: [0, -0.09, 0] });
        return hip;
    }
    const hipL = buildLeg(-0.13);
    const hipR = buildLeg( 0.13);

    // Arms: upper ? forearm ? hand (+weapon) under a shoulder pivot, so the
    // forearm, hand and weapon swing with the upper arm.
    function buildArm(sx) {
        const sh = new THREE.Group();
        sh.position.set(sx, 1.36, 0);   // shoulder joint height
        g.add(sh);
        const iUpper = addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.085, 0.42, 10), armourMat.clone()),
            sh, 0, -0.22, 0, 0.085, 0.21, 0.085, 4,
            { parent: iTorso, self: [Math.sign(sx) * -0.08, 0.16, 0], onParent: [sx * 0.78, 0.22, 0] });
        const iFore = addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.075, 0.40, 10), armourMat.clone()),
            sh, 0, -0.58, 0, 0.075, 0.20, 0.075, 3,
            { parent: iUpper, self: [0, 0.19, 0], onParent: [0, -0.17, 0] });
        const iHand = addPart(new THREE.Mesh(new THREE.SphereGeometry(0.082, 10, 8), skinMat.clone()),
            sh, 0, -0.78, 0.02, 0.07, 0.08, 0.08, 1,
            { parent: iFore, self: [0, 0.04, -0.02], onParent: [0, -0.16, 0] });
        return { sh, iUpper, iHand };
    }
    const armL = buildArm(-0.42);
    const armR = buildArm( 0.42);

    // Weapon � knights carry a sword/axe, tower archers carry a bow. Parented to
    // the wielding arm's shoulder pivot so it swings with the arm.
    if (weaponType === 'bow') {
        // Bow: curved limb (torus arc) + bowstring, merged into one piece.
        const arc = new THREE.TorusGeometry(0.40, 0.028, 6, 16, Math.PI * 1.4)
            .rotateZ(Math.PI * 0.3).rotateY(Math.PI / 2);
        const str = new THREE.BoxGeometry(0.012, 0.78, 0.012).translate(0, 0, -0.34);
        const bowGeo = mergeGeometries([arc, str]);
        const bow = new THREE.Mesh(bowGeo, woodMatW.clone());
        bow.rotation.y = 0.2;
        addPart(bow, armL.sh, -0.06, -0.36, 0.18, 0.10, 0.42, 0.42, 1.5,
            { parent: armL.iHand, self: [0, -0.42, -0.16], onParent: [-0.06, 0.0, 0.16] });
    } else if (weaponType === 'axe') {
        const haft = new THREE.CylinderGeometry(0.03, 0.035, 0.92, 10).translate(0, 0.10, 0);
        const head = new THREE.BoxGeometry(0.33, 0.16, 0.09).translate(0.14, 0.52, 0);
        const beard = new THREE.ConeGeometry(0.06, 0.18, 8).rotateZ(-Math.PI / 2).translate(0.30, 0.46, 0);
        const butt = new THREE.CylinderGeometry(0.04, 0.04, 0.07, 8).translate(0, -0.38, 0);
        const axeGeo = mergeGeometries([haft, head, beard, butt]);
        const axe = new THREE.Mesh(axeGeo, steelMat.clone());
        axe.rotation.set(0.55, 0, 0.2);
        addPart(axe, armR.sh, 0.06, -0.44, 0.11, 0.22, 0.62, 0.14, 2,
            { parent: armR.iHand, self: [0, -0.26, 0], onParent: [0.04, 0.0, 0.03] });
    } else if (weaponType === 'none') {
        // Unarmed (the King) — he throws punches, not steel.
    } else {
        // Sword: blade + crossguard + grip + pommel, merged into one piece.
        const blade  = new THREE.BoxGeometry(0.045, 0.85, 0.11).translate(0, 0.35, 0);
        const guard  = new THREE.BoxGeometry(0.30, 0.07, 0.07).translate(0, -0.10, 0);
        const grip   = new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8).translate(0, -0.26, 0);
        const pommel = new THREE.SphereGeometry(0.05, 8, 6).translate(0, -0.40, 0);
        const swordGeo = mergeGeometries([blade, guard, grip, pommel]);
        const sword = new THREE.Mesh(swordGeo, steelMat.clone());
        // Tilt the blade up-and-forward (toward the foe) so it's brandished at a
        // natural ready angle rather than poking straight up or pointing back.
        sword.rotation.set(0.7, 0, 0.12);
        addPart(sword, armR.sh, 0.06, -0.46, 0.10, 0.15, 0.62, 0.11, 2,
            { parent: armR.iHand, self: [0, -0.26, 0], onParent: [0.04, 0.0, 0.03] });
    }

    const npcEntry = { group: g, parts, isRagdoll: false, ragdollParts: [],
                    walking: false, arrowTimer: Math.random() * 5.0, walkTime: 0,
                    vy: 0, waypoints: [], isTowerGuard: yBase > 0, triggerBody: null,
                    npcPanicSwim: null,
                    weaponType, towerDisturbFrames: 0, tauntCooldown: 30 + Math.random() * 45,
                    angerLevel: 0,
                    avoidPhase: (Math.random() * 3) | 0,
                    walkCollisionPhase: (Math.random() * 2) | 0,
                    crawlMode: false, crawlHold: 0, crawlCheckCooldown: 0, crawlDebrisScore: 0,
                    fallingWithTower: false, fallStartY: 0,
                    // Named limb-pivot refs: rotating a pivot swings the whole limb.
                    anim: { legL: hipL, legR: hipR, armL: armL.sh, armR: armR.sh,
                            browL, browR, mouthGroup, lipArc, mouthOpen, teeth,
                            eyeL, eyeR, headMesh,
                            facePhase: Math.random() * Math.PI * 2 } };
    npcList.push(npcEntry);
    return npcEntry;
}

function initTowerGuardPost(npc, cx, cz, outwardAngle, topY) {
    if (!npc) return;
    const deck = towerPlatforms.find(p => Math.abs(p.cx - cx) < 0.01 && Math.abs(p.cz - cz) < 0.01);
    const deckRadius = deck ? deck.rad : (TOWER_R - 0.7);
    const exposedRadius = Math.max(0.35, deckRadius * 0.84);
    const coverRadius = Math.max(0.18, exposedRadius - 0.52);
    const safeRadius = Math.max(0.3, exposedRadius + 0.03);

    // Merlon (solid battlement) angles for this tower — archers tuck behind
    // these and lean into the crenel gaps between them to shoot. Mirrors the
    // layout produced by addRoundBattlements() so cover lines up visually.
    const battleBrickR = TOWER_R - BS.d / 2;
    const nBattle = Math.max(2, Math.round(2 * Math.PI * battleBrickR / BS.w));
    const gapStep = (2 * Math.PI) / nBattle;
    const merlonAngles = [];
    for (let i = 0; i < nBattle; i += 2) merlonAngles.push(i * gapStep);

    // Start behind whichever merlon is closest to the guard's outward facing.
    const angDist = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    let coverAngle = merlonAngles[0];
    for (const m of merlonAngles) {
        if (angDist(m, outwardAngle) < angDist(coverAngle, outwardAngle)) coverAngle = m;
    }

    npc.towerGuardPost = {
        cx,
        cz,
        baseY: topY,
        merlonAngles,
        gapStep,
        coverAngle,
        peekAngle: coverAngle,
        angle: coverAngle,
        targetAngle: coverAngle,
        safeRadius,
        coverRadius,
        exposedRadius,
        state: 'hide',
        isPeeking: false,
        stateTimer: 1.0 + Math.random() * 2.8,
        diveCooldown: 5.0 + Math.random() * 6.0,
        fistTimer: 0,
        fistDuration: 1.15,
        fistCooldown: 6.0 + Math.random() * 7.0,
        scanPhase: (Math.random() * 8) | 0,
        collisionPhase: (Math.random() * 3) | 0,
    };

    npc.group.position.x = cx + Math.sin(coverAngle) * coverRadius;
    npc.group.position.z = cz + Math.cos(coverAngle) * coverRadius;
    npc.group.position.y = topY;
}

buildNPC(0, CFZ + 10);   // inside courtyard knight (sword), facing out toward gate
npcList[npcList.length - 1].storyRole = 'castle';

// Tower-top guards: one on each circular tower, facing outward � archers with bows
const TOWER_TOP_Y = TOWER_ROWS * BS.h;   // 9.0 m
TOWER_CENTERS.forEach(({ cx, cz }) => {
    // Facing angle: outward from castle centre (0, CASTLE_MZ)
    const CASTLE_MZ = (CFZ + CASTLE_BZ) / 2;  // 37
    const angle = Math.atan2(cx - 0, cz - CASTLE_MZ);  // face away from centre
    const guard = buildNPC(cx, cz, TOWER_TOP_Y, angle, 'bow');
    guard.storyRole = 'castle';
    initTowerGuardPost(guard, cx, cz, angle, TOWER_TOP_Y);
});

// === The King on his throne (King's Bunker) ===
// A comically fat, crowned, permanently-seated NPC. storyRole 'castleKing'
// keeps him out of the castle defender count (his death is an optional
// bonus), and he is excluded from the drawbridge-aggro march.
let kingPunchT = 0, kingPunchCooldown = 0, kingPunchKind = 'R';
const KING_PUNCH_DUR = 0.45;

// The king's running commentary: dry contempt that curdles into fury as the
// coin count climbs. Tiers are keyed to coins pocketed (1-3 / 4-6 / 7-9).
const KING_COIN_TAUNTS = [
    [
        'Oh, do help yourself.',
        'That one\'s cursed, actually.',
        'Yes, lovely, put it back.',
        'A burglar. How exotic.',
    ],
    [
        'Right. That was the holiday fund.',
        'I counted those, you know. Twice.',
        'You\'re actually pocketing my bling.',
        'Starting to find this quite rude.',
    ],
    [
        'PUT. THEM. BACK.',
        'Expect a strongly worded letter.',
        'Guards! ...Oh, marvellous. Nobody.',
        'I am WELL annoyed now.',
    ],
];
const KING_LAST_COIN_TAUNT = 'Took the lot. I hope you\'re proud.';
const KING_AMBIENT_TAUNTS = [
    'You do know this is burglary, yes?',
    'The décor is not for sale either.',
    'I\'d offer tea, but you\'re a criminal.',
    'Mind the throne. It\'s antique.',
];
const KING_FLOAT_TAUNTS = [
    'Bit damp down there, is it?',
    'Do mind the water. It\'s rising, you see.',
    'Heavy, are they? The coins?',
];
const KING_SWITCH_TAUNT = 'Let\'s see you swim with full pockets.';
let kingTauntAtMs = 0;
let kingAmbientTauntIn = 7;
function kingSay(text, minGapMs = 2500) {
    if (!king || king.isRagdoll || storyCastleSuppressed) return;
    const now = performance.now();
    if (now - kingTauntAtMs < minGapMs) return;
    kingTauntAtMs = now;
    spawnNpcTaunt(king, text);
}
function kingCoinTaunt() {
    if (bunkerCoinsCollected >= BUNKER_COIN_TOTAL) { kingSay(KING_LAST_COIN_TAUNT, 0); return; }
    const tier = bunkerCoinsCollected <= 3 ? 0 : (bunkerCoinsCollected <= 6 ? 1 : 2);
    const pool = KING_COIN_TAUNTS[tier];
    kingSay(pool[(Math.random() * pool.length) | 0]);
}
(function buildKingNPC() {
    king = buildNPC(BUNKER.THRONE_X, BUNKER.THRONE_Z, BUNKER.FLOOR_Y + 0.5, Math.PI, 'none');
    king.storyRole = 'castleKing';
    king.isBunkerKing = true;
    king.walking = false;

    // Comically fat: scale the torso mesh and widen its ragdoll box to match.
    const torso = king.parts[0];
    torso.mesh.scale.set(1.65, 1.12, 1.55);
    torso.hw *= 1.6;
    torso.hd *= 1.5;
    torso.mesh.material.color.set(0x7a1f2b);   // royal crimson

    // Crown: swap the helmet part's geometry/material in place — it stays a
    // no-joint part, so the crown still flies off when he ragdolls.
    const crownMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.9, roughness: 0.25, emissive: 0x2a1e00 });
    const crownGeos = [new THREE.CylinderGeometry(0.20, 0.21, 0.11, 12)];
    for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        crownGeos.push(new THREE.ConeGeometry(0.035, 0.13, 6).translate(Math.cos(a) * 0.185, 0.11, Math.sin(a) * 0.185));
    }
    const helm = king.parts[2];
    helm.mesh.geometry.dispose();
    helm.mesh.geometry = mergeGeometries(crownGeos);
    helm.mesh.material = crownMat;
    castleSceneMeshes.push(king.group);

    // Throne: heavy dark-wood chair with gold trim. Separate from the NPC so
    // the flood can float king + chair as one piece.
    throneGroup = new THREE.Group();
    const woodT = new THREE.MeshStandardMaterial({ color: 0x4a2f1a, roughness: 0.8 });
    const goldT = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.85, roughness: 0.3 });
    const addBox = (w, h, d, x, y, z, mat = woodT) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, y, z);
        m.castShadow = true;
        throneGroup.add(m);
        return m;
    };
    addBox(0.70, 0.50, 0.95, 0, 0.30, 0);                 // seat (top y=0.55)
    addBox(0.12, 1.50, 0.95, -0.34, 1.05, 0);             // tall back
    addBox(0.55, 0.12, 0.12, -0.02, 0.78, 0.50);          // armrest L
    addBox(0.55, 0.12, 0.12, -0.02, 0.78, -0.50);         // armrest R
    addBox(0.14, 0.07, 0.99, -0.34, 1.83, 0, goldT);      // back top trim
    addBox(0.72, 0.06, 0.97, 0, 0.56, 0, goldT);          // seat trim
    for (const fin of [-0.42, 0.42]) {
        const finial = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), goldT);
        finial.position.set(-0.34, 1.90, fin);
        throneGroup.add(finial);
    }
    throneGroup.position.set(BUNKER.THRONE_X, BUNKER.FLOOR_Y + 0.5, BUNKER.THRONE_Z);
    scene.add(throneGroup);
    castleSceneMeshes.push(throneGroup);

    // The switch beside the throne (lever the king pulls at 20 s).
    const leverBase = addBox(0.16, 0.55, 0.16, 0.10, 0.28, 0.85, goldT);
    leverBase.castShadow = false;
    const leverArm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.42, 0.05), woodT);
    leverArm.geometry.translate(0, 0.21, 0);
    leverArm.position.set(0.10, 0.55, 0.85);
    leverArm.rotation.x = -0.6;
    throneGroup.add(leverArm);
    throneGroup.userData.leverArm = leverArm;
})();

// Per-frame hub for the whole King's Bunker feature. Called once from
// animate() right after updateStoryProgression (movement already done).
function updateKingsBunker(dt) {
    if (storyCastleSuppressed || window.__editorActive) {
        // Castle stage hidden (bridge/template) or editor: keep prompts off and
        // bank the torch cost (intensity 0 — lights are never added/removed).
        if (interactPromptEl) interactPromptEl.style.display = 'none';
        if (mobileInteractBtn) mobileInteractBtn.style.display = 'none';
        for (const t of bunkerTorches) t.light.intensity = 0;
        return;
    }
    // Derive inside/outside from the camera position (the descent is walked,
    // no scripted transitions). First entry starts the 20-second fuse.
    const camY = camera.position.y;
    const insideNow = bunkerEyeYAt(camera.position.x, camera.position.z, camY) != null && camY < 1.0;
    if (insideNow && bunkerState.phase === 'above') {
        bunkerState.phase = 'inside';
        if (!bunkerEverEntered) {
            bunkerEverEntered = true;
            kingSwitchTimer = BUNKER_FLOOD_DELAY_SEC;
        }
    } else if (!insideNow && bunkerState.phase === 'inside') {
        bunkerState.phase = 'above';
    }
    updateTrapdoor(dt);
    updateBunkerTransition(dt);
    updateInteractPrompt();
    updateBunkerPickups(dt);
    updateKingPose(dt);
    updateKingAI(dt);
    updateBunkerFlood(dt);
    updateCoinHud();
    // Torch flicker: intensity + flame scale only (constant light count).
    const tNow = performance.now() * 0.001;
    for (const t of bunkerTorches) {
        const n = (Math.sin(tNow * 11 + t.phase) + Math.sin(tNow * 23 + t.phase * 1.7)) * 0.25 + 0.5;
        t.light.intensity = t.baseI * (0.85 + 0.3 * n);
        const s = 0.9 + 0.25 * n;
        t.flame.scale.set(s, 1.0 + 0.35 * n, s);
    }
    // Rain and snow do not fall indoors.
    if (precipPoints) precipPoints.visible = bunkerState.phase === 'above' ? (precipMode != null) : false;
}

// Per-frame seated pose. MUST early-return on ragdoll: pinning limbs/position
// after activateRagdoll hides the group is what froze the old version.
const _kingHeadScratch = new THREE.Vector3();
function updateKingPose(dt) {
    if (!king || king.isRagdoll || !throneGroup) return;
    const tNow = performance.now() * 0.001;

    // Scripted mood for the shared face rig: smug on his throne, furious while
    // the player is inside robbing him, laughing the moment his flood wins.
    const moodTarget = bunkerFlooding ? 0.03 : (bunkerState.phase !== 'above' ? 1.0 : 0.15);
    king.angerLevel = THREE.MathUtils.lerp(king.angerLevel ?? 0.15, moodTarget, Math.min(1, dt * 2.0));

    if (kingFloating && bunkerWp) {
        // Belly-up float: horizontal on the surface, limbs out, crown slipping.
        const bob = Math.sin(tNow * 2.1) * 0.045 + Math.sin(tNow * 3.7 + 1.3) * 0.02;
        const targetY = bunkerWp.baseY - 0.12 + bob;
        king.group.position.x += (throneGroup.position.x - king.group.position.x) * Math.min(1, dt * 3.2);
        king.group.position.y += (targetY - king.group.position.y) * Math.min(1, dt * 3.2);
        king.group.position.z += (throneGroup.position.z - king.group.position.z) * Math.min(1, dt * 3.2);
        king.group.rotation.x += (-1.30 - king.group.rotation.x) * Math.min(1, dt * 2.6);
        king.group.rotation.z = Math.sin(tNow * 1.4) * 0.08;
        king.anim.armL.rotation.z += (1.25 - king.anim.armL.rotation.z) * Math.min(1, dt * 4);
        king.anim.armR.rotation.z += (-1.25 - king.anim.armR.rotation.z) * Math.min(1, dt * 4);
        // Gloating: chin up watching the player, fists pumping in triumph —
        // with the occasional smug remark while you struggle below.
        kingAmbientTauntIn -= dt;
        if (kingAmbientTauntIn <= 0) {
            kingAmbientTauntIn = 11 + Math.random() * 7;
            kingSay(KING_FLOAT_TAUNTS[(Math.random() * KING_FLOAT_TAUNTS.length) | 0], 4000);
        }
        king.anim.headMesh.rotation.x += (-0.75 - king.anim.headMesh.rotation.x) * Math.min(1, dt * 3);
        king.anim.headMesh.rotation.y += (0 - king.anim.headMesh.rotation.y) * Math.min(1, dt * 3);
        const pump = Math.sin(tNow * 6.5);
        king.anim.armL.rotation.x = -0.5 + pump * 0.35;
        king.anim.armR.rotation.x = -0.5 - pump * 0.35;
        // indignant little kicks
        king.anim.legL.rotation.x = -0.15 + Math.sin(tNow * 5.2) * 0.22;
        king.anim.legR.rotation.x = -0.15 + Math.sin(tNow * 5.2 + Math.PI) * 0.22;
        return;
    }
    // Ride the throne (it floats during the flood).
    king.group.position.set(throneGroup.position.x, throneGroup.position.y, throneGroup.position.z);
    king.group.rotation.y = Math.PI / 2;   // face the tunnel mouth (east, +x)

    // Head tracking: the lever mid-pull, otherwise the player once inside.
    {
        const head = king.anim.headMesh;
        let tx = null, ty = 0, tz = 0;
        if (kingSwitchPullT > 0) {
            tx = throneGroup.position.x + 0.10; ty = throneGroup.position.y + 0.55; tz = throneGroup.position.z + 0.85;
        } else if (bunkerState.phase !== 'above') {
            tx = camera.position.x; ty = camera.position.y; tz = camera.position.z;
        }
        let yawT = 0, pitchT = 0;
        if (tx != null) {
            const hw = head.getWorldPosition(_kingHeadScratch);
            const dx = tx - hw.x, dy = ty - hw.y, dz = tz - hw.z;
            let yaw = Math.atan2(dx, dz) - king.group.rotation.y;
            yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
            yawT = THREE.MathUtils.clamp(yaw, -1.15, 1.15);
            pitchT = -THREE.MathUtils.clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.55, 0.65);
        }
        const hk = Math.min(1, dt * 5);
        head.rotation.y += (yawT - head.rotation.y) * hk;
        head.rotation.x += (pitchT - head.rotation.x) * hk;
    }

    // Ambient grumbling while the thief is in the room (pre-flood).
    if (bunkerState.phase !== 'above' && !bunkerFlooding) {
        kingAmbientTauntIn -= dt;
        if (kingAmbientTauntIn <= 0) {
            kingAmbientTauntIn = 9 + Math.random() * 6;
            kingSay(KING_AMBIENT_TAUNTS[(Math.random() * KING_AMBIENT_TAUNTS.length) | 0], 4000);
        }
    }

    // Seated: thighs forward, feet comically dangling; gentle breathing.
    king.anim.legL.rotation.x = -0.9;
    king.anim.legR.rotation.x = -0.9;
    const torsoMesh = king.parts[0].mesh;
    torsoMesh.scale.y = 1.12 + Math.sin(tNow * 1.8) * 0.012;

    const restK = Math.min(1, dt * 8);
    const dxp = camera.position.x - king.group.position.x;
    const dzp = camera.position.z - king.group.position.z;
    const distP = Math.hypot(dxp, dzp);

    if (kingPunchT > 0) {
        const p = 1 - kingPunchT / KING_PUNCH_DUR;
        const wave = Math.sin(p * Math.PI);
        // Whole body commits: torso pivots into the blow.
        king.group.rotation.y = Math.PI / 2 + wave * (kingPunchKind === 'L' ? 0.22 : -0.22);
        if (kingPunchKind === 'KICK') {
            king.anim.legR.rotation.x = -0.9 - wave * 1.1;
        } else if (kingPunchKind === 'L') {
            king.anim.armL.rotation.x = -0.55 - wave * 1.9;
        } else {
            king.anim.armR.rotation.x = -0.55 - wave * 1.9;
        }
    } else if (kingSwitchPullT > 0) {
        // Reach left to the lever beside the throne and haul it over.
        const pull = 1 - Math.max(0, kingSwitchPullT / 0.9);
        king.anim.armL.rotation.z += (1.10 - king.anim.armL.rotation.z) * Math.min(1, dt * 9);
        king.anim.armL.rotation.x += ((-0.25 - pull * 0.75) - king.anim.armL.rotation.x) * Math.min(1, dt * 9);
        king.anim.armR.rotation.x += (-0.55 - king.anim.armR.rotation.x) * restK;
    } else if (bunkerState.phase !== 'above' && !bunkerFlooding && distP >= KING_PUNCH_RANGE) {
        // Out of reach: shake a raised fist at the thief.
        const shake = Math.sin(tNow * 13) * 0.16;
        king.anim.armR.rotation.x += ((-2.05 + shake) - king.anim.armR.rotation.x) * Math.min(1, dt * 7);
        king.anim.armR.rotation.z += (-0.30 - king.anim.armR.rotation.z) * Math.min(1, dt * 7);
        king.anim.armL.rotation.x += (-0.55 - king.anim.armL.rotation.x) * restK;
        king.anim.armL.rotation.z += (0 - king.anim.armL.rotation.z) * restK;
    } else {
        king.anim.armL.rotation.x += (-0.55 - king.anim.armL.rotation.x) * restK;
        king.anim.armR.rotation.x += (-0.55 - king.anim.armR.rotation.x) * restK;
        king.anim.armL.rotation.z += (0 - king.anim.armL.rotation.z) * restK;
        king.anim.armR.rotation.z += (0 - king.anim.armR.rotation.z) * restK;
    }
}

// The switch, the moat drain, the flood, the floating king, and the drowning
// escape-window. Timer starts on first bunker entry and keeps running even if
// the player leaves — the flood is world state.
let moatDrainT = 0, bunkerFloodT = 0, kingSwitchPullT = 0, kingFloating = false;
function updateBunkerFlood(dt) {
    if (kingSwitchTimer > 0 && !gameOver) {
        kingSwitchTimer -= dt;
        if (kingSwitchTimer <= 0) {
            kingSwitchTimer = 0;
            castleMoatDraining = true;
            bunkerFlooding = true;
            castleMoatDrained = true;   // gameplay flags flip at drain START
            kingSwitchPullT = 0.9;
            kingSay(KING_SWITCH_TAUNT, 0);
            if (storyModeEnabled) setStoryHud('The King pulled the switch — the bunker is flooding!');
        }
    }
    if (kingSwitchPullT > 0 && throneGroup) {
        kingSwitchPullT -= dt;
        const lever = throneGroup.userData.leverArm;
        if (lever) lever.rotation.x = THREE.MathUtils.lerp(-0.6, 0.6, 1 - Math.max(0, kingSwitchPullT / 0.9));
    }
    // The moat visibly empties into the room.
    if (castleMoatDraining && moatDrainT < MOAT_DRAIN_SEC) {
        moatDrainT = Math.min(MOAT_DRAIN_SEC, moatDrainT + dt);
        const t = moatDrainT / MOAT_DRAIN_SEC;
        const y = THREE.MathUtils.lerp(WATER_Y, MOAT_DRAINED_Y, t);
        if (castleMoatWaterPlane) castleMoatWaterPlane.baseY = y;
        if (castleMoatWaterCap) {
            castleMoatWaterCap.position.y = THREE.MathUtils.lerp(SIMPLE_WATER_SURFACE_Y, MOAT_DRAINED_Y, t);
            if (t >= 1) castleMoatWaterCap.visible = false;
        }
        if (typeof moatReflector !== 'undefined' && moatReflector) moatReflector.visible = false;
    }
    // The bunker fills — stock moat layering: underlay + ripple at the water
    // level, the Three.js Water surface just above.
    if (bunkerFlooding && bunkerWp && bunkerFloodT < BUNKER_FLOOD_RISE_SEC) {
        bunkerFloodT = Math.min(BUNKER_FLOOD_RISE_SEC, bunkerFloodT + dt);
        const t = bunkerFloodT / BUNKER_FLOOD_RISE_SEC;
        bunkerWp.baseY = THREE.MathUtils.lerp(BUNKER.FLOOR_Y - 0.15, BUNKER_WATER_MAX_Y, t);
        if (bunkerWp.underlay) bunkerWp.underlay.visible = devWaterFxEnabled;
        if (bunkerWp.ripple) bunkerWp.ripple.visible = devWaterFxEnabled;
    }
    if (bunkerWaterCap) {
        bunkerWaterCap.visible = bunkerFlooding && devWaterFxEnabled && !storyCastleSuppressed;
        if (bunkerWaterCap.visible) bunkerWaterCap.position.y = bunkerWp.baseY + 0.05;
    }
    // Once it is deep enough the fat king floats — on his BACK, furious, while
    // the empty throne bobs beside him (a seated king on a floating throne
    // would poke straight through the ceiling).
    if (bunkerWp && bunkerFlooding && king && !king.isRagdoll && throneGroup) {
        const wy = bunkerWp.baseY;
        if (wy > BUNKER.FLOOR_Y + 1.2) kingFloating = true;
        if (wy > BUNKER.FLOOR_Y + 0.45) {
            const tNow = performance.now() * 0.001;
            const bob = Math.sin(tNow * 2.1) * 0.045 + Math.sin(tNow * 3.7 + 1.3) * 0.02;
            throneGroup.position.y += ((wy + 0.05 + bob) - throneGroup.position.y) * Math.min(1, dt * 3.2);
            throneGroup.rotation.z = Math.sin(tNow * 1.3) * 0.03;
            throneGroup.rotation.x = Math.sin(tNow * 1.7 + 0.7) * 0.025;
        }
    }
    // Rising water past the head starts the drown — the escape window closes.
    if (bunkerFlooding && bunkerWp && bunkerState.phase !== 'above' && !playerWaterState && !gameOver) {
        if (bunkerWp.baseY >= camera.position.y - 0.1) {
            beginPlayerWaterFall(bunkerWp.baseY);
        }
    }
}

// Punch/kick triggers + the optional kill bonus. Damage mirrors the walking
// knights' melee (one heart + shove), but the king never stands up.
function updateKingAI(dt) {
    if (!king) return;
    if (king.isRagdoll) {
        if (!king._bonusAwarded) {
            king._bonusAwarded = true;
            score += KING_BONUS_SCORE;
            updateUI();
            const gp = king.group.position;
            spawnScorePopup(gp.x, gp.y + 2.0, gp.z, '+' + KING_BONUS_SCORE + ' KING SLAIN', null);
        }
        return;
    }
    if (kingPunchCooldown > 0) kingPunchCooldown -= dt;
    if (kingPunchT > 0) {
        kingPunchT -= dt;
        if (!king._punchHitDone && kingPunchT <= KING_PUNCH_DUR * 0.5) {
            king._punchHitDone = true;
            const dx = camera.position.x - king.group.position.x;
            const dz = camera.position.z - king.group.position.z;
            const d = Math.hypot(dx, dz);
            if (d < KING_PUNCH_RANGE + 0.3 && bunkerState.phase === 'inside') {
                onPlayerHitFrom(king.group.position);
                const len = d || 1;
                camera.position.x += (dx / len) * 0.9;
                camera.position.z += (dz / len) * 0.9;
            }
        }
        return;
    }
    if (bunkerState.phase !== 'inside' || disarmNpc || kingFloating || playerWaterState) return;
    const dx = camera.position.x - king.group.position.x;
    const dz = camera.position.z - king.group.position.z;
    if (Math.hypot(dx, dz) < KING_PUNCH_RANGE && kingPunchCooldown <= 0) {
        kingPunchT = KING_PUNCH_DUR;
        king._punchHitDone = false;
        kingPunchKind = ['L', 'R', 'KICK'][(Math.random() * 3) | 0];
        kingPunchCooldown = KING_PUNCH_COOLDOWN;
    }
}

// === Knight+ ballista encounter ===
let ballista = null;
const ballistaBolts = [];

const BALLISTA_TUNING = {
    knight: {
        deploySpeed: 1.7,
        moveSpeed: 1.3,
        firstShotDelay: 4.0,
        fireInterval: 15.0,
        rangeMin: 21,
        rangeMax: 34,
        boltSpeed: 25,
        boltHitRadius: 1.45,
        aimJitter: 0.020,
        sideBias: 1.0,
    },
    warlord: {
        deploySpeed: 2.2,
        moveSpeed: 1.8,
        firstShotDelay: 3.2,
        fireInterval: 12.0,
        rangeMin: 23,
        rangeMax: 37,
        boltSpeed: 29,
        boltHitRadius: 1.65,
        aimJitter: 0.012,
        sideBias: 1.25,
    },
    extreme: {
        deploySpeed: 2.8,
        moveSpeed: 2.3,
        firstShotDelay: 2.0,
        fireInterval: 9.0,
        rangeMin: 24,
        rangeMax: 40,
        boltSpeed: 33,
        boltHitRadius: 1.9,
        aimJitter: 0.006,
        sideBias: 1.5,
    }
};

function getBallistaTuning() {
    return BALLISTA_TUNING[currentDifficulty] || BALLISTA_TUNING.knight;
}

function clearBallistaEncounter() {
    if (!ballista) return;
    if (ballista.group) scene.remove(ballista.group);
    // Remove living crew from npc list/scene; ragdolls remain as world debris.
    npcList.splice(0, npcList.length, ...npcList.filter(n => {
        if (!n.isBallistaCrew) return true;
        if (n.isRagdoll) return true;
        if (n.group) scene.remove(n.group);
        return false;
    }));
    for (const b of ballistaBolts) scene.remove(b.mesh);
    ballistaBolts.length = 0;
    ballista = null;
}

function setupBallistaEncounter() {
    clearBallistaEncounter();
    if (guardsDisabled) return;
    if (currentDifficulty === 'squire') return;
    const tune = getBallistaTuning();

    const g = new THREE.Group();
    g.position.set(0, 0, CFZ + 7.2);    // parked inside on wooden floor
    g.visible = true;
    scene.add(g);

    const wood  = new THREE.MeshStandardMaterial({ color: 0x6f4a24, roughness: 0.9, metalness: 0.05 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xb8c2cc, roughness: 0.22, metalness: 0.92 });
    const steelDark = new THREE.MeshStandardMaterial({ color: 0x5f6974, roughness: 0.28, metalness: 0.85 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xc79a3f, roughness: 0.26, metalness: 0.9 });
    const leather = new THREE.MeshStandardMaterial({ color: 0x6d4022, roughness: 0.92, metalness: 0.0 });

    // Chassis with layered beams and braces.
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.22, 2.45), wood);
    base.position.set(0, 0.34, 0.0); base.castShadow = true; base.receiveShadow = true;
    g.add(base);
    const railL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.24, 2.3), wood);
    const railR = railL.clone();
    railL.position.set(-0.78, 0.49, 0.0); railR.position.set(0.78, 0.49, 0.0);
    railL.castShadow = railR.castShadow = true;
    g.add(railL, railR);
    const frontPlow = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.18, 0.45), steelDark);
    frontPlow.position.set(0, 0.24, -1.17); frontPlow.castShadow = true;
    g.add(frontPlow);
    const rearBox = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.22, 0.36), leather);
    rearBox.position.set(0, 0.46, 1.03); rearBox.castShadow = true;
    g.add(rearBox);

    // Axles + wheels (with rims and spokes).
    const axleFront = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 1.9, 12), steelDark);
    const axleBack  = axleFront.clone();
    axleFront.rotation.z = Math.PI / 2; axleBack.rotation.z = Math.PI / 2;
    axleFront.position.set(0, 0.3, -0.72); axleBack.position.set(0, 0.3, 0.82);
    axleFront.castShadow = axleBack.castShadow = true;
    g.add(axleFront, axleBack);

    const wheels = [];
    const wheelRadius = 0.36;
    function makeWheel(x, z) {
        const wg = new THREE.Group();
        wg.position.set(x, 0.3, z);
        const tire = new THREE.Mesh(new THREE.TorusGeometry(wheelRadius, 0.06, 10, 22), steelDark);
        tire.rotation.y = Math.PI / 2;
        tire.castShadow = true;
        wg.add(tire);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(wheelRadius - 0.03, 0.018, 8, 20), brass);
        rim.rotation.y = Math.PI / 2;
        rim.castShadow = true;
        wg.add(rim);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.17, 10), steel);
        hub.rotation.z = Math.PI / 2;
        hub.castShadow = true;
        wg.add(hub);
        for (let i = 0; i < 6; i++) {
            const sp = new THREE.Mesh(new THREE.BoxGeometry(0.014, wheelRadius - 0.09, 0.035), brass);
            sp.position.y = (wheelRadius - 0.09) * 0.5;
            sp.rotation.x = i * Math.PI / 3;
            sp.castShadow = true;
            wg.add(sp);
        }
        g.add(wg);
        wheels.push(wg);
    }
    makeWheel(-0.98, -0.72);
    makeWheel(0.98, -0.72);
    makeWheel(-0.98, 0.82);
    makeWheel(0.98, 0.82);

    // Decorative rear pennant + side lanterns for more siege flair.
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 8), steelDark);
    pole.position.set(0.0, 0.95, 1.08); pole.castShadow = true;
    g.add(pole);
    const pennant = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.28), new THREE.MeshStandardMaterial({ color: 0x8b1f1f, roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide }));
    pennant.position.set(0.28, 1.03, 1.08);
    pennant.rotation.y = Math.PI / 2;
    g.add(pennant);
    const lanternL = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), brass);
    lanternL.position.set(-0.58, 0.62, 1.02);
    const lanternR = lanternL.clone(); lanternR.position.x = 0.58;
    g.add(lanternL, lanternR);

    // Turret/launcher
    const turret = new THREE.Group();
    turret.position.set(0, 0.70, -0.16);
    g.add(turret);
    const turntable = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.42, 0.16, 16), steelDark);
    turntable.castShadow = true;
    turret.add(turntable);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 1.95), wood);
    rail.position.z = 0.02; rail.castShadow = true;
    turret.add(rail);
    const groove = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.03, 1.65), steelDark);
    groove.position.set(0, 0.08, -0.02); groove.castShadow = true;
    turret.add(groove);
    // Side handrails on the launcher carriage, oriented along travel direction.
    const handRailL = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 1.34, 10), steel);
    handRailL.position.set(-0.25, 0.13, -0.06);
    handRailL.rotation.x = Math.PI / 2;
    handRailL.castShadow = true;
    const handRailR = handRailL.clone(); handRailR.position.x = 0.25;
    turret.add(handRailL); turret.add(handRailR);
    // Curved hand guards at the front, opening outward.
    const guardL = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.022, 8, 16, Math.PI * 0.92), steel);
    guardL.position.set(-0.25, 0.11, -0.67);
    guardL.rotation.set(0, 0, Math.PI * 0.50);
    guardL.castShadow = true;
    const guardR = guardL.clone();
    guardR.position.x = 0.25;
    guardR.rotation.z = -Math.PI * 0.50;
    turret.add(guardL); turret.add(guardR);
    // Rear push handles where crew brace their hands.
    const pushCross = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 1.18, 10), steelDark);
    pushCross.position.set(0, 0.16, 0.88);
    pushCross.rotation.z = Math.PI / 2;
    pushCross.castShadow = true;
    turret.add(pushCross);
    const pushPostL = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.26, 8), steelDark);
    pushPostL.position.set(-0.42, 0.03, 0.88);
    pushPostL.castShadow = true;
    const pushPostR = pushPostL.clone(); pushPostR.position.x = 0.42;
    turret.add(pushPostL, pushPostR);

    // Loading mechanism: sliding carriage + side crank lever used before each shot.
    const loadSlide = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.12, 0.50), steelDark);
    loadSlide.position.set(0, 0.12, 0.34);
    loadSlide.castShadow = true;
    turret.add(loadSlide);
    const leverPivot = new THREE.Group();
    leverPivot.position.set(0.37, 0.13, 0.44);
    turret.add(leverPivot);
    const leverArm = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.44, 8), steelDark);
    leverArm.rotation.z = Math.PI / 2;
    leverArm.castShadow = true;
    leverPivot.add(leverArm);
    const leverKnob = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), brass);
    leverKnob.position.set(0.22, 0, 0);
    leverKnob.castShadow = true;
    leverPivot.add(leverKnob);
    const string = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.48, 6), leather);
    string.position.set(0, 0.08, -0.87);
    string.rotation.z = Math.PI / 2;
    turret.add(string);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.09, -1.03);
    turret.add(muzzle);

    // Two crew push from behind.
    buildNPC(-0.9, CFZ + 8.2, 0, Math.PI, 'sword');
    const crewL = npcList[npcList.length - 1];
    buildNPC( 0.9, CFZ + 8.2, 0, Math.PI, 'sword');
    const crewR = npcList[npcList.length - 1];
    for (const c of [crewL, crewR]) {
        c.isBallistaCrew = true;
        c.storyRole = 'castle';
        c.walking = false;
        c.isTowerGuard = false;
    }

    ballista = {
        group: g, turret, muzzle, wheels, wheelRadius, loadSlide, leverPivot,
        crewL, crewR,
        side: Math.random() < 0.5 ? -1 : 1,
        state: 'deploying',
        deployDelay: 0.10,
        deployStuckTimer: 0,
        crewPhase: Math.random() * Math.PI * 2,
        path: [
            { x: 0, z: CFZ + 7.2 },
            { x: 0, z: CFZ + 2.4 },
            { x: 0, z: CFZ - 2.5 },
            { x: 0, z: M_OZ1 - 2.2 },
        ],
        pathIndex: 0,
        fireTimer: tune.firstShotDelay,
        rangeMin: tune.rangeMin,
        rangeMax: tune.rangeMax,
        moveSpeed: tune.moveSpeed,
        deploySpeed: tune.deploySpeed,
        firstShotDelay: tune.firstShotDelay,
        fireInterval: tune.fireInterval,
        boltSpeed: tune.boltSpeed,
        boltHitRadius: tune.boltHitRadius,
        aimJitter: tune.aimJitter,
        sideBias: tune.sideBias,
        stagingX: tune.side * 16,
        stagingZ: M_OZ1 - 7.0,
        stagingRefreshAt: 0,
        turretBaseZ: -0.16,
        recoil: 0,
        recoilV: 0,
        holdTimer: 0,
        windupTimer: 0,
        windupDuration: 0.55,
        reloadProgress: 1,
        reloadDuration: 1.25,
        groundOffset: 0.06,
    };
}

function updateBallistaCrewPose(dt = 0, moving = false) {
    if (!ballista) return;
    const b = ballista;
    const gp = b.group.position;
    const yaw = b.group.rotation.y;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    if (dt > 0) b.crewPhase = (b.crewPhase || 0) + dt * 7.0;
    const place = (npc, ox, oz) => {
        if (!npc || npc.isRagdoll) return;
        const tx = gp.x + ox * cy - oz * sy;
        const tz = gp.z + ox * sy + oz * cy;
        const pushBob = moving ? Math.abs(Math.sin((b.crewPhase || 0) + (ox > 0 ? Math.PI : 0))) * 0.03 : 0;
        npc.group.position.set(tx, npcGroundY(tx, tz) + 0.05 + pushBob, tz);
        resolveNpcSolidCollision(npc.group.position, npc.group.position.y + 1.1);
        npc.group.rotation.y = yaw;

        // Visual push gait so crew appear to drive the chassis forward.
        if (npc.anim) {
            if (moving) {
                const s = Math.sin((b.crewPhase || 0) + (ox > 0 ? Math.PI : 0)) * 0.52;
                npc.anim.legL.rotation.x = s;
                npc.anim.legR.rotation.x = -s;
                npc.anim.armL.rotation.x = -1.05 - s * 0.20;
                npc.anim.armR.rotation.x = -1.05 + s * 0.20;
            } else {
                npc.anim.legL.rotation.x = 0;
                npc.anim.legR.rotation.x = 0;
                npc.anim.armL.rotation.x = -0.85;
                npc.anim.armR.rotation.x = -0.85;
            }
        }
    };
    place(b.crewL, -0.50, 1.28);
    place(b.crewR,  0.50, 1.28);
}

function spinBallistaWheels(distanceTravelled) {
    if (!ballista || !ballista.wheels || ballista.wheels.length === 0) return;
    const r = Math.max(0.12, ballista.wheelRadius || 0.36);
    const dTheta = distanceTravelled / r;
    for (const w of ballista.wheels) w.rotation.x -= dTheta;
}

function fireBallistaBolt() {
    if (!ballista) return;
    const origin = new THREE.Vector3();
    ballista.muzzle.getWorldPosition(origin);
    const target = camera.position.clone();
    const dir = target.sub(origin);
    const dist = dir.length() || 1;
    dir.normalize();
    dir.y += Math.min(0.35, 0.06 * (dist / 20)); // slight loft
    dir.x += (Math.random() - 0.5) * ballista.aimJitter;
    dir.z += (Math.random() - 0.5) * ballista.aimJitter;
    dir.normalize();

    const bolt = new THREE.Group();
    bolt.position.copy(origin);
    scene.add(bolt);

    // Heavy oak shaft � thick and long like a real siege bolt
    const shaftMat = new THREE.MeshStandardMaterial({ color: 0x3d2209, roughness: 0.88, metalness: 0.0 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.056, 2.1, 10), shaftMat);
    shaft.rotation.x = Math.PI / 2;
    bolt.add(shaft);

    // Iron binding rings for a brutish siege look
    const bandMat = new THREE.MeshStandardMaterial({ color: 0x2a2d30, roughness: 0.35, metalness: 0.88 });
    for (const bz of [-0.55, 0.1, 0.70]) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.082, 0.020, 8, 14), bandMat);
        band.rotation.x = Math.PI / 2;
        band.position.z = bz;
        bolt.add(band);
    }

    // Large angular steel tip � four-sided pyramid, very aggressive
    const tipMat = new THREE.MeshStandardMaterial({ color: 0x8a9198, roughness: 0.15, metalness: 0.98, envMapIntensity: 1.2 });
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.58, 4), tipMat);
    tip.rotation.x = -Math.PI / 2;
    tip.position.z = 1.34;
    bolt.add(tip);

    // Rear stabiliser fins (two crossed flat vanes)
    const finMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 0.95, side: THREE.DoubleSide });
    for (let f = 0; f < 2; f++) {
        const fin = new THREE.Mesh(new THREE.PlaneGeometry(0.40, 0.28), finMat);
        fin.rotation.y = f * Math.PI / 2;
        fin.position.z = -0.88;
        bolt.add(fin);
    }

    bolt.quaternion.setFromUnitVectors(_arrowFwd, dir);
    const S = ballista.boltSpeed;
    ballistaBolts.push({
        mesh: bolt,
        vx: dir.x * S,
        vy: dir.y * S,
        vz: dir.z * S,
        life: 10,
        hitRadius: ballista.boltHitRadius,
    });
}

function updateBallistaEncounter(dt) {
    if (guardsDisabled) return;
    if (!ballista || gameOver) return;
    const b = ballista;
    if (window.__editorMode) {
        b.storyDormant = true;
        if (b.group) b.group.visible = false;
        return;
    }
    if (b.storyDormant) return;

    const p = b.group.position;
    const crewAlive = (b.crewL && !b.crewL.isRagdoll ? 1 : 0) + (b.crewR && !b.crewR.isRagdoll ? 1 : 0);

    const stickBallistaToGround = () => {
        const gy = npcGroundY(p.x, p.z) + (b.groundOffset || 0);
        // Smooth small height changes to reduce bridge-edge jitter, but snap
        // hard when a large step occurs.
        if (Math.abs(gy - p.y) > 0.55) p.y = gy;
        else p.y += (gy - p.y) * Math.min(1, dt * 12);
    };

    if (crewAlive === 0) {
        b.state = 'abandoned';
        b.windupTimer = 0;
        b.fireTimer = 9999;
        b.recoilV *= Math.exp(-8.0 * dt);
        b.recoil += b.recoilV * dt;
        b.turret.position.z = b.turretBaseZ + b.recoil;
        stickBallistaToGround();
        return;
    }

    stickBallistaToGround();

    if (b.state === 'hidden') {
        // Start deployment as soon as combat starts or the gate begins opening.
        const shouldDeploy =
            _npcAggroTriggered ||
            dbOpening ||
            dbAngle < Math.PI * 0.75 ||
            npcList.some(n => !n.isTowerGuard && !n.isRagdoll && n.walking);
        if (shouldDeploy) b.state = 'deploying';
        updateBallistaCrewPose(dt, false);
        return;
    }

    if (b.state === 'deploying') {
        if (b.deployDelay > 0) {
            b.deployDelay -= dt;
            updateBallistaCrewPose(dt, false);
            return;
        }
        const oldX = p.x, oldZ = p.z;
        const t = b.path[Math.min(b.pathIndex, b.path.length - 1)];
        const dx = t.x - p.x, dz = t.z - p.z;
        const d = Math.hypot(dx, dz) || 1;
        const step = Math.min(d, b.deploySpeed * dt);
        p.x += (dx / d) * step;
        p.z += (dz / d) * step;
        const moved = Math.hypot(p.x - oldX, p.z - oldZ);
        stickBallistaToGround();
        spinBallistaWheels(moved);
        if (moved < 0.002) b.deployStuckTimer = (b.deployStuckTimer || 0) + dt;
        else b.deployStuckTimer = 0;
        // Ballista front is modeled on local -Z (muzzle at negative Z), so
        // convert travel vector to chassis yaw with a 180deg offset.
        b.group.rotation.y = Math.atan2(dx, dz) + Math.PI;
        if ((b.deployStuckTimer || 0) > 0.8) {
            b.pathIndex++;
            b.deployStuckTimer = 0;
        }
        if (d < 0.15) b.pathIndex++;
        if (b.pathIndex >= b.path.length) {
            b.state = 'active';
            b.fireTimer = b.firstShotDelay;
        }
        updateBallistaCrewPose(dt, moved > 0.001);
        return;
    }

    // Active: select a stable staging patch on grass away from the moat and
    // hold position there, only refreshing occasionally. This prevents jitter
    // from constant retreat/advance decisions at the moat lip.
    const nowMs = performance.now();
    const MOAT_SAFE_Z = M_OZ1 - 3.4;
    const STAGE_Z = M_OZ1 - 7.0;
    const chooseStagingPatch = () => {
        const preferX = THREE.MathUtils.clamp(camera.position.x + b.side * 11, -22, 22);
        const altX = THREE.MathUtils.clamp(camera.position.x - b.side * 9, -22, 22);
        const candidates = [
            { x: b.side * 18, z: STAGE_Z },
            { x: b.side * 14, z: STAGE_Z - 1.6 },
            { x: preferX, z: STAGE_Z },
            { x: altX, z: STAGE_Z - 1.0 },
            { x: b.side * 20, z: STAGE_Z - 2.2 },
        ];
        let best = null;
        let bestD2 = Infinity;
        for (const c of candidates) {
            if (!isNpcWalkableXZ(c.x, c.z)) continue;
            const dx = c.x - p.x, dz = c.z - p.z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) { best = c; bestD2 = d2; }
        }
        if (!best) {
            best = { x: THREE.MathUtils.clamp(b.side * 16, -22, 22), z: STAGE_Z };
        }
        b.stagingX = best.x;
        b.stagingZ = Math.min(best.z, MOAT_SAFE_Z - 1.0);
    };

    const pdxLive = camera.position.x - p.x;
    const pdzLive = camera.position.z - p.z;
    const playerDist = Math.hypot(pdxLive, pdzLive) || 1;
    if (!Number.isFinite(b.stagingX) || !Number.isFinite(b.stagingZ)) {
        chooseStagingPatch();
        b.stagingRefreshAt = nowMs + 1200;
    }
    if (nowMs >= (b.stagingRefreshAt || 0) || playerDist < b.rangeMin * 0.8) {
        chooseStagingPatch();
        b.stagingRefreshAt = nowMs + (playerDist < b.rangeMin * 0.8 ? 500 : 1400);
    }

    let mx = b.stagingX - p.x;
    let mz = b.stagingZ - p.z;
    if (p.z > MOAT_SAFE_Z) mz -= 2.6;
    if (Math.abs(p.x) < 5.2) mx += b.side * b.sideBias * 1.2;
    b.holdTimer = Math.max(0, (b.holdTimer || 0) - dt);
    if (b.holdTimer > 0) { mx = 0; mz = 0; }
    const ml = Math.hypot(mx, mz);
    let moved = 0;
    if (ml > 0.22) {
        const oldX = p.x, oldZ = p.z;
        const nx = p.x + (mx / ml) * b.moveSpeed * dt;
        const nz = Math.min(p.z + (mz / ml) * b.moveSpeed * dt, MOAT_SAFE_Z);
        if (isNpcWalkableXZ(nx, nz)) {
            p.x = nx; p.z = nz;
        } else {
            b.holdTimer = 0.7;
        }
        stickBallistaToGround();
        moved = Math.hypot(p.x - oldX, p.z - oldZ);
        spinBallistaWheels(moved);
        // Keep chassis front pointed along its chosen movement vector.
        b.group.rotation.y = Math.atan2(mx, mz) + Math.PI;
    }

    // Aim turret at player.
    const pdx = camera.position.x - p.x;
    const pdz = camera.position.z - p.z;
    const yawToPlayer = Math.atan2(pdx, pdz);
    b.turret.rotation.y = yawToPlayer - b.group.rotation.y;

    // Recoil spring for a heavier, mechanical launcher feel.
    b.recoilV += (-b.recoil * 36.0) * dt;
    b.recoilV *= Math.exp(-10.0 * dt);
    b.recoil += b.recoilV * dt;
    b.turret.position.z = b.turretBaseZ + b.recoil;

    // Lever + carriage loading cycle. Wind-up cocks the mechanism before firing.
    if (b.windupTimer > 0) {
        b.windupTimer = Math.max(0, b.windupTimer - dt);
        const k = 1 - b.windupTimer / b.windupDuration;
        if (b.leverPivot) b.leverPivot.rotation.z = -0.2 - k * 1.0;
        if (b.loadSlide)  b.loadSlide.position.z = 0.34 + k * 0.32;
        if (b.windupTimer <= 0) {
            fireBallistaBolt();
            b.recoilV -= 1.9;
            b.fireTimer = b.fireInterval;
            b.reloadProgress = 0;
        }
    } else {
        if (b.reloadProgress < 1) {
            b.reloadProgress = Math.min(1, b.reloadProgress + dt / b.reloadDuration);
        }
        const rp = b.reloadProgress;
        if (b.leverPivot) b.leverPivot.rotation.z = -1.2 + rp * 1.0;
        if (b.loadSlide)  b.loadSlide.position.z = 0.66 - rp * 0.32;
    }

    // Only count down the fire timer once the player is close to the moat �
    // ballista stays silent at range and opens up as the player approaches.
    const BALLISTA_ENGAGE_DIST = 38;   // metres from ballista to player
    const ballistaPlayerDist = Math.hypot(camera.position.x - p.x, camera.position.z - p.z);
    if (ballistaPlayerDist < BALLISTA_ENGAGE_DIST) {
        b.fireTimer -= dt;
    }
    if (b.fireTimer <= 0 && b.windupTimer <= 0) {
        b.windupTimer = b.windupDuration;
    }
    updateBallistaCrewPose(dt, moved > 0.001);
}

// Explode an NPC into individually-simulated ragdoll parts.
// ballBody may be null for a gravity-drop (tower collapsed under them).
const RAGDOLL_TTL_MS = isMobileProfile ? 10000 : 16000;
const RAGDOLL_BODY_BUDGET = isMobileProfile ? 56 : 96;
const RAGDOLL_SLEEP_CULL_MS = isMobileProfile ? 2400 : 3600;
const RAGDOLL_FLOAT_MS = isMobileProfile ? 1800 : 3200;
const RAGDOLL_SINK_MAX_MS = isMobileProfile ? 3600 : 5200;
const RAGDOLL_MAX_SPIN = isMobileProfile ? 6.0 : 8.0;
const RAGDOLL_MAX_SPIN2 = RAGDOLL_MAX_SPIN * RAGDOLL_MAX_SPIN;
const RAGDOLL_MAX_SPEED = isMobileProfile ? 14.0 : 18.0;
const RAGDOLL_MAX_SPEED2 = RAGDOLL_MAX_SPEED * RAGDOLL_MAX_SPEED;
const BRIDGE_BLAST_FLING_CHANCE = 0.40;
const CASTLE_BLAST_FLING_CHANCE = 0.30;
const CASTLE_ARCHER_BLAST_FLING_CHANCE = 0.50;
const CASTLE_BLAST_FLING_ZONE_PAD = 10;
const BRIDGE_BLAST_FLING_SIDE_SPEED = isMobileProfile ? 6.4 : 8.8;
const BRIDGE_BLAST_FLING_UP_SPEED = isMobileProfile ? 4.6 : 6.1;
const BRIDGE_BLAST_FLING_FORWARD_SPEED = isMobileProfile ? 1.1 : 1.8;

function isNpcInBridgeBlastLaunchZone(npc) {
    if (!npc || npc.isRagdoll || !npc.group) return false;
    if (npc.storyDormant) return false;
    if (npc.storyRole !== 'bridge') return false;
    const gp = npc.group.position;
    if (Math.abs(gp.x) > (STORY_BRIDGE_APPROACH_X + 1.2)) return false;
    if (Math.abs(gp.z - STORY_BRIDGE_Z) > 6.8) return false;
    return gp.y > 0.35;
}

function isNpcInCastleBlastLaunchZone(npc) {
    if (!npc || npc.isRagdoll || !npc.group) return false;
    if (npc.storyDormant) return false;
    if (npc.storyRole === 'bridge') return false;
    const gp = npc.group.position;
    if (gp.x < (M_OX1 - CASTLE_BLAST_FLING_ZONE_PAD) || gp.x > (M_OX2 + CASTLE_BLAST_FLING_ZONE_PAD)) return false;
    if (gp.z < (M_OZ1 - CASTLE_BLAST_FLING_ZONE_PAD) || gp.z > (M_OZ2 + CASTLE_BLAST_FLING_ZONE_PAD)) return false;
    return gp.y > 0.35;
}

function getNpcBlastFlingOptions(npc, blastX, blastZ) {
    if (isNpcInBridgeBlastLaunchZone(npc) && Math.random() < BRIDGE_BLAST_FLING_CHANCE) {
        const zOff = npc.group.position.z - STORY_BRIDGE_Z;
        const sideSign = Math.abs(zOff) > 0.32
            ? Math.sign(zOff)
            : (Math.random() < 0.5 ? -1 : 1);
        const fromBlastX = npc.group.position.x - blastX;
        const forwardSign = Math.abs(fromBlastX) > 0.24
            ? Math.sign(fromBlastX)
            : (Math.random() < 0.5 ? -1 : 1);
        return {
            bridgeBlastFling: true,
            bridgeSideSign: sideSign,
            bridgeForwardSign: forwardSign,
        };
    }

    if (isNpcInCastleBlastLaunchZone(npc)) {
        const chance = npc.isTowerGuard ? CASTLE_ARCHER_BLAST_FLING_CHANCE : CASTLE_BLAST_FLING_CHANCE;
        if (Math.random() < chance) {
            const castleCX = (M_IX1 + M_IX2) * 0.5;
            const castleCZ = (M_IZ1 + M_IZ2) * 0.5;
            const outX = npc.group.position.x - castleCX;
            const outZ = npc.group.position.z - castleCZ;
            const fromBlastX = npc.group.position.x - blastX;
            const fromBlastZ = npc.group.position.z - blastZ;
            const forwardSign = Math.abs(outX) > 0.22
                ? Math.sign(outX)
                : (Math.abs(fromBlastX) > 0.22 ? Math.sign(fromBlastX) : (Math.random() < 0.5 ? -1 : 1));
            const sideSign = Math.abs(outZ) > 0.22
                ? Math.sign(outZ)
                : (Math.abs(fromBlastZ) > 0.22 ? Math.sign(fromBlastZ) : (Math.random() < 0.5 ? -1 : 1));
            return {
                bridgeBlastFling: true,
                bridgeSideSign: sideSign,
                bridgeForwardSign: forwardSign,
            };
        }
    }

    return null;
}

function cleanupNpcRagdoll(npc) {
    if (!npc || !npc.ragdollParts || npc.ragdollParts.length === 0) return;
    for (const part of npc.ragdollParts) {
        if (part.constraint && part.constraint.world) {
            world.removeConstraint(part.constraint);
        }
        if (part.body && part.body.world) {
            part.body.world.removeBody(part.body);
        }
        if (part.mesh) {
            scene.remove(part.mesh);
        }
    }
    npc.ragdollParts.length = 0;
    npc.ragdollWaterState = null;
}

function getActiveRagdollBodyCount() {
    let count = 0;
    for (const npc of npcList) {
        if (!npc.isRagdoll || !npc.ragdollParts) continue;
        for (const part of npc.ragdollParts) {
            if (part.body) count++;
        }
    }
    return count;
}

function enforceRagdollBodyBudget(preserveNpc = null) {
    let bodyCount = getActiveRagdollBodyCount();
    if (bodyCount <= RAGDOLL_BODY_BUDGET) return;
    const staleRagdolls = npcList
        .filter(npc => npc !== preserveNpc
            && npc.isRagdoll
            && npc.ragdollParts
            && npc.ragdollParts.some(part => part.body)
            && !npc.ragdollWaterState   // keep NPCs already splashing in water
            && !npc.ragdollParts.some(p => p.body && p.body.position.y > 0.5)) // keep mid-air NPCs
        .sort((a, b) => (a.ragdollExpireAt || 0) - (b.ragdollExpireAt || 0));
    for (const stale of staleRagdolls) {
        if (bodyCount <= RAGDOLL_BODY_BUDGET) break;
        let staleBodies = 0;
        for (const part of stale.ragdollParts) {
            if (part.body) staleBodies++;
        }
        cleanupNpcRagdoll(stale);
        bodyCount -= staleBodies;
    }
}

function activateRagdoll(npc, ballBody, isExplosion = false, opts = null) {
    perfRecordEvent('ragdoll', `${isExplosion ? 'blast' : (ballBody ? 'hit' : 'fall')}/${npc?.isTowerGuard ? 'tower' : 'ground'}`);
    const spawnNow = performance.now();
    npc.npcPanicSwim = null;
    npc.isRagdoll = true;
    npc.group.visible = false;
    // In kill-win modes (e.g. Extreme Destruction) check if this was the last enemy.
    if (DIFFICULTIES[currentDifficulty] && DIFFICULTIES[currentDifficulty].killWin) checkGameOver();
    npc.ragdollSpawnAt = spawnNow;
    npc.ragdollExpireAt = spawnNow + RAGDOLL_TTL_MS;
    npc.ragdollWaterState = null;
    // Remove trigger body so it no longer intercepts cannonballs
    if (npc.triggerBody) { world.removeBody(npc.triggerBody); npc.triggerBody = null; }

    // Refresh the whole NPC's world matrices so each part's posed (swinging)
    // world transform is current, then capture per-part world pos/orientation.
    npc.group.updateWorldMatrix(true, true);
    const gx   = npc.group.position.x;
    const gy   = npc.group.position.y;
    const gz   = npc.group.position.z;
    const _wp = new THREE.Vector3();
    const _wq = new THREE.Quaternion();

    const bvx = ballBody ? ballBody.velocity.x : 0;
    const bvy = ballBody ? ballBody.velocity.y : -2;
    const bvz = ballBody ? ballBody.velocity.z : 0;
    const bpx = ballBody ? ballBody.position.x : gx;
    const bpy = ballBody ? ballBody.position.y : gy + 1;
    const bpz = ballBody ? ballBody.position.z : gz;
    const blastFling = !!(isExplosion && opts && opts.bridgeBlastFling);
    const flingSide = blastFling
        ? (opts.bridgeSideSign || (Math.random() < 0.5 ? -1 : 1))
        : 0;
    const flingForward = blastFling
        ? (opts.bridgeForwardSign || (Math.random() < 0.5 ? -1 : 1))
        : 0;
    const useConnectedRagdoll = !isExplosion || blastFling;

    // Mobile lightweight mode: one proxy body instead of full multi-part ragdoll.
    if (isMobileProfile && lightweightRubbleMode) {
        const core = npc.parts.reduce((best, p) => {
            if (!best) return p;
            return p.mass > best.mass ? p : best;
        }, null) || npc.parts[0];
        if (core) {
            core.mesh.getWorldPosition(_wp);
            core.mesh.getWorldQuaternion(_wq);
            const wx = _wp.x, wy = _wp.y, wz = _wp.z;

            const rdMesh = new THREE.Mesh(core.mesh.geometry, core.mesh.material);
            rdMesh.castShadow = true;
            rdMesh.position.set(wx, wy, wz);
            rdMesh.quaternion.copy(_wq);
            scene.add(rdMesh);

            const body = new CANNON.Body({
                mass: Math.max(8, core.mass * 1.8),
                linearDamping: 0.22,
                angularDamping: 0.34,
                allowSleep: true,
                sleepSpeedLimit: 0.28,
                sleepTimeLimit: 0.45,
                collisionFilterGroup: CGROUP_NPC,
                collisionFilterMask: 1,
            });
            body.addShape(new CANNON.Box(new CANNON.Vec3(
                Math.max(core.hw * 1.2, 0.12),
                Math.max(core.hh * 1.35, 0.18),
                Math.max(core.hd * 1.2, 0.12)
            )));
            body.position.set(wx, wy, wz);
            body.quaternion.set(_wq.x, _wq.y, _wq.z, _wq.w);

            if (blastFling) {
                body.velocity.set(
                    flingForward * (BRIDGE_BLAST_FLING_FORWARD_SPEED + (Math.random() - 0.5) * 1.1),
                    BRIDGE_BLAST_FLING_UP_SPEED + Math.random() * 1.3,
                    flingSide * (BRIDGE_BLAST_FLING_SIDE_SPEED + (Math.random() - 0.5) * 1.6)
                );
                body.angularVelocity.set(
                    (Math.random() - 0.5) * 4.2,
                    (Math.random() - 0.5) * 4.8,
                    (Math.random() - 0.5) * 4.2
                );
            } else if (isExplosion) {
                body.velocity.set(
                    bvx * 0.28 + (Math.random() - 0.5) * 3.2,
                    Math.abs(bvy) * 0.16 + 2.4,
                    bvz * 0.28 + (Math.random() - 0.5) * 3.2
                );
                body.angularVelocity.set(
                    (Math.random() - 0.5) * 5.5,
                    (Math.random() - 0.5) * 5.5,
                    (Math.random() - 0.5) * 5.5
                );
            } else if (ballBody) {
                const spd = Math.sqrt(bvx * bvx + bvz * bvz) + 0.001;
                body.velocity.set(
                    (bvx / spd) * 5.2 + (Math.random() - 0.5) * 0.7,
                    1.9 + (Math.random() - 0.5) * 0.45,
                    (bvz / spd) * 5.2 + (Math.random() - 0.5) * 0.7
                );
                body.angularVelocity.set(
                    (Math.random() - 0.5) * 3.0,
                    (Math.random() - 0.5) * 3.6,
                    (Math.random() - 0.5) * 3.0
                );
            } else {
                body.velocity.set(
                    (wx - gx) * 1.1 + (Math.random() - 0.5) * 1.3,
                    1.0 + Math.random() * 1.0,
                    (wz - gz) * 1.1 + (Math.random() - 0.5) * 1.3
                );
                body.angularVelocity.set(
                    (Math.random() - 0.5) * 4.2,
                    (Math.random() - 0.5) * 4.2,
                    (Math.random() - 0.5) * 4.2
                );
            }

            world.addBody(body);
            npc.ragdollParts.push({ mesh: rdMesh, body });
            enforceRagdollBodyBudget(npc);
            return;
        }
    }

    for (const p of npc.parts) {
        // True world transform of this (possibly mid-stride) part.
        p.mesh.getWorldPosition(_wp);
        p.mesh.getWorldQuaternion(_wq);
        const wx = _wp.x, wy = _wp.y, wz = _wp.z;

        const rdMesh = new THREE.Mesh(p.mesh.geometry, p.mesh.material);
        rdMesh.castShadow = true;
        rdMesh.position.set(wx, wy, wz);
        rdMesh.quaternion.copy(_wq);
        scene.add(rdMesh);

        const body = new CANNON.Body({
            mass: p.mass,
            linearDamping:  0.16,
            angularDamping: 0.24,
            allowSleep: true,
            sleepSpeedLimit: 0.22,
            sleepTimeLimit: 0.6,
            collisionFilterGroup: CGROUP_NPC,
            collisionFilterMask:  1,  // only collides with ground (group 1), not bricks
        });
        body.addShape(new CANNON.Box(new CANNON.Vec3(
            Math.max(p.hw, 0.05),
            Math.max(p.hh, 0.05),
            Math.max(p.hd, 0.05)
        )));
        body.position.set(wx, wy, wz);
        body.quaternion.set(_wq.x, _wq.y, _wq.z, _wq.w);

        const dx = wx - bpx, dy = wy - bpy, dz = wz - bpz;
        const dist  = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const scale = 1.0 / (1.0 + dist * 0.5);

        if (blastFling) {
            const partKick = 0.78 + Math.random() * 0.42;
            body.velocity.set(
                flingForward * (BRIDGE_BLAST_FLING_FORWARD_SPEED * partKick + (Math.random() - 0.5) * 1.1),
                BRIDGE_BLAST_FLING_UP_SPEED + Math.random() * 1.6 + Math.max(-0.2, dy) * 0.08,
                flingSide * (BRIDGE_BLAST_FLING_SIDE_SPEED * partKick + (Math.random() - 0.5) * 1.4)
            );
            body.angularVelocity.set(
                (Math.random() - 0.5) * 4.8,
                (Math.random() - 0.5) * 5.5,
                (Math.random() - 0.5) * 4.8
            );
        } else if (isExplosion) {
            // Violent scatter ? parts fly apart in all directions
            body.velocity.set(
                bvx * scale * 0.55 + (Math.random() - 0.5) * 5.2,
                Math.abs(bvy * scale) * 0.35 + Math.random() * 3.0 + 1.6,
                bvz * scale * 0.55 + (Math.random() - 0.5) * 5.2
            );
            body.angularVelocity.set(
                (Math.random() - 0.5) * 8.0,
                (Math.random() - 0.5) * 8.0,
                (Math.random() - 0.5) * 8.0
            );
        } else if (ballBody) {
            // Tumble ? whole figure knocked in ball's direction, spins as one unit
            const spd = Math.sqrt(bvx*bvx + bvz*bvz) + 0.001;
            const baseVX = (bvx / spd) * 6.0;
            const baseVY = 2.2;
            const baseVZ = (bvz / spd) * 6.0;
            const spinX =  (bvz / spd) * 4.5;
            const spinZ = -(bvx / spd) * 4.5;
            body.velocity.set(
                baseVX + (Math.random() - 0.5) * 0.8,
                baseVY + (Math.random() - 0.5) * 0.5,
                baseVZ + (Math.random() - 0.5) * 0.8
            );
            body.angularVelocity.set(
                spinX + (Math.random() - 0.5) * 1.2,
                (Math.random() - 0.5) * 1.8,
                spinZ + (Math.random() - 0.5) * 1.2
            );
        } else {
            // Tower collapse ? fall outward
            body.velocity.set(
                (wx - gx) * 1.5 + (Math.random() - 0.5) * 2.0,
                1.0 + Math.random() * 1.4,
                (wz - gz) * 1.5 + (Math.random() - 0.5) * 2.0
            );
            body.angularVelocity.set(
                (Math.random() - 0.5) * 4.0,
                (Math.random() - 0.5) * 4.0,
                (Math.random() - 0.5) * 4.0
            );
        }

        world.addBody(body);
        npc.ragdollParts.push({ mesh: rdMesh, body });
    }

    // For non-explosive hits: add PointToPointConstraints so connected parts
    // stay loosely attached at their joints � the whole figure flails and
    // tumbles as a floppy ragdoll instead of cleanly disassembling.
    // Each part stores its parent index + pivot anchors (NPC-local coords, which
    // equal body-local coords since the bodies share the group's yaw).
    if (useConnectedRagdoll) {
        for (let i = 0; i < npc.parts.length; i++) {
            const pj = npc.parts[i];
            if (pj.parent == null) continue;
            const bodyA = npc.ragdollParts[i].body;
            const bodyB = npc.ragdollParts[pj.parent].body;
            if (!bodyA || !bodyB) continue;
            const c = new CANNON.PointToPointConstraint(
                bodyA, new CANNON.Vec3(pj.pivotSelf[0],   pj.pivotSelf[1],   pj.pivotSelf[2]),
                bodyB, new CANNON.Vec3(pj.pivotParent[0], pj.pivotParent[1], pj.pivotParent[2])
            );
            world.addConstraint(c);
            npc.ragdollParts.push({ constraint: c }); // store for future cleanup
        }
    }
    enforceRagdollBodyBudget(npc);
}

function activateRagdollLite(npc, ballBody = null, isExplosion = false, opts = null) {
    // Keep a dedicated entry point but use the lightweight proxy ragdoll path
    // in activateRagdoll so mobile deaths are visible (no pop-out disappear).
    activateRagdoll(npc, ballBody, isExplosion, opts);
}

// === Arrows (fired by NPC guard) ===
const arrows = [];
const _arrowFwd = new THREE.Vector3(0, 0, 1);
const _arrowVel = new THREE.Vector3();
const arrowShaftMat = new THREE.MeshStandardMaterial({ color: 0x5c3a1e, roughness: 0.9 });
const arrowTipMat   = new THREE.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.18, metalness: 0.82 });
const arrowFeatherMat = new THREE.MeshStandardMaterial({ color: 0xddddcc, roughness: 1.0 });

function fireArrow(npc) {
    if (guardsDisabled) return;
    if (npc.isRagdoll || disarmNpc) return;
    npc.group.updateWorldMatrix(true, true);
    // Launch from the bow (held in the left hand) in world space
    const originLocal = new THREE.Vector3(-0.40, 1.30, 0.25);
    const origin = originLocal.applyMatrix4(npc.group.matrixWorld);

    // Aim directly at the cannon (camera position) with gravity-compensating loft
    const target = camera.position.clone();
    const dir = target.sub(origin);
    const dist = dir.length();
    dir.normalize();
    // Loft proportional to gravity drop over flight time
    const ARROW_SPEED = 22;
    const flightTime = dist / ARROW_SPEED;
    dir.y += 0.5 * 9.81 * flightTime * flightTime / dist;
    dir.normalize();
    _spawnArrowMesh(origin, dir, ARROW_SPEED);
}

// Archers aim at the drone while it is airborne.
function fireArrowAtDrone(npc) {
    if (guardsDisabled || !activeDrone || activeDrone.detonated) return;
    if (npc.isRagdoll || disarmNpc) return;
    npc.group.updateWorldMatrix(true, true);
    const originLocal = new THREE.Vector3(-0.40, 1.30, 0.25);
    const origin = originLocal.applyMatrix4(npc.group.matrixWorld);
    const dp = activeDrone.body.position;
    const ARROW_SPEED = 22;
    const dir = new THREE.Vector3(dp.x - origin.x, dp.y - origin.y, dp.z - origin.z);
    const dist = dir.length() || 1;
    dir.normalize();
    // Lead the drone by half the flight time so the arrow has a chance to connect
    const flightTime = dist / ARROW_SPEED;
    const dv = activeDrone.body.velocity;
    dir.x += dv.x * flightTime * 0.5 / dist;
    dir.z += dv.z * flightTime * 0.5 / dist;
    dir.y += 0.5 * 9.81 * flightTime * flightTime / dist;
    dir.normalize();
    _spawnArrowMesh(origin, dir, ARROW_SPEED);
}

function _spawnArrowMesh(origin, dir, speed) {
    const g = new THREE.Group();
    g.position.copy(origin);
    scene.add(g);

    const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.022, 0.95, 6),
        arrowShaftMat
    );
    shaft.rotation.x = Math.PI / 2;
    g.add(shaft);

    const tip = new THREE.Mesh(
        new THREE.ConeGeometry(0.046, 0.20, 6),
        arrowTipMat
    );
    tip.rotation.x = -Math.PI / 2;
    tip.position.z = 0.575;
    g.add(tip);

    // Fletching
    const fletch = new THREE.Mesh(
        new THREE.ConeGeometry(0.062, 0.18, 4),
        arrowFeatherMat
    );
    fletch.rotation.x = Math.PI / 2;
    fletch.position.z = -0.475;
    g.add(fletch);

    g.quaternion.setFromUnitVectors(_arrowFwd, dir);

    arrows.push({ mesh: g, vx: dir.x * speed,
                           vy: dir.y * speed,
                           vz: dir.z * speed, life: 8 });
}

// === Scoring ===
let score = 0, bricksDestroyed = 0, shotsFired = 0;
let bestShotDamage = 0;
let AMMO_START = [12, 10, 3, 2, 200, 5, 1, 0, 0]; // shotgun, standard, explosive, mortar, minigun, sniper, drone, grenade, cluster
let p1Ammo = [...AMMO_START];
let p2Ammo = [...AMMO_START];
let currentDifficulty = 'knight';   // set from the start modal
let cannonImpactScale = 170;        // settings slider (1..500)
let storyModePreference = false;    // user-selected start mode from the modal (classic/new levels default)
let levelPreference = 'castle';     // user-selected level when not in story campaign
let templateLevelEnabled = false;   // settings override: empty grass template level
let bridge2LevelEnabled = false;    // settings override: template + bridge bricks/physics only
let bridgeDevLevelEnabled = false;  // settings override: rebuilt dev bridge with steps + thick arches
let bridgeNewLevelEnabled = false;  // settings override: new bridge level (kept for legacy localStorage compat)
let cursorInspectorEnabled = false; // dev: crosshair mesh inspector pill
let castleNewLevelEnabled = false;  // settings override: new castle level (kept for legacy localStorage compat)
let bridge2ModeActive = false;      // runtime latch for Bridge 2 behavior
let storyModeEnabled = false;
let storyCampaignActive = false;
let storyStage = 0;                 // 0 = off, 1 = bridge, 2 = castle, 3 = cleared
let storyHudEl = null;
let bridgeStageCompletePendingAdvance = false;
let bridgeStageClearPendingAt = 0;
let bridgeStageClearCalmSince = 0;
const BRIDGE_CLEAR_MIN_DELAY_MS = 1300;
const BRIDGE_CLEAR_MAX_DELAY_MS = 4200;
const BRIDGE_CLEAR_CALM_AWAKE_LIMIT = 3;
const BRIDGE_CLEAR_CALM_HOLD_MS = 450;

function recordShotDamage(impact) {
    const v = Number.isFinite(impact) ? impact : 0;
    if (v > bestShotDamage) bestShotDamage = v;
}

function ensureStoryHud() {
    if (storyHudEl) return storyHudEl;
    const el = document.createElement('div');
    el.id = 'storyHud';
    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.top = '10px';
    el.style.transform = 'translateX(-50%)';
    el.style.padding = '8px 14px';
    el.style.borderRadius = '999px';
    el.style.border = '1px solid rgba(255,255,255,0.3)';
    el.style.background = 'rgba(9, 16, 30, 0.72)';
    el.style.color = '#f4e8bb';
    el.style.fontFamily = 'Georgia, serif';
    el.style.fontSize = '13px';
    el.style.letterSpacing = '0.04em';
    el.style.zIndex = '121';
    el.style.pointerEvents = 'none';
    el.style.display = 'none';
    document.body.appendChild(el);
    storyHudEl = el;
    return el;
}

function setStoryHud(text) {
    const el = ensureStoryHud();
    if (!text) {
        el.style.display = 'none';
        return;
    }
    el.textContent = text;
    el.style.display = 'block';
}

function countAliveStoryNpcs(role) {
    let alive = 0;
    for (const npc of npcList) {
        if (npc.storyRole !== role) continue;
        if (npc.isRagdoll) continue;
        alive++;
    }
    return alive;
}

function updateEnemyCountUi() {
    const alive = npcList.filter(n => !n.isRagdoll).length;
    const el  = document.getElementById('enemyCount');
    const el2 = document.getElementById('enemyCount2');
    if (el)  el.textContent  = alive;
    if (el2) el2.textContent = alive;
}

function updateUI() {
    document.getElementById("scoreValue").textContent = score;
    document.getElementById("bricksHit").textContent  = bricksDestroyed;
    document.getElementById("shotsValue").textContent = shotsFired;
    updateTotalBricksUi();
    updateEnemyCountUi();
    for (let i = 0; i < WEAPONS.length; i++) {
        const el = document.getElementById('ammo' + i);
        if (el) el.textContent = '\u00d7' + p1Ammo[i];
        const btn = document.getElementById('wBtn' + i);
        if (btn) btn.classList.toggle('empty', p1Ammo[i] === 0);
    }
    renderMobileWeaponRoller();
}

// === Audio (procedural Web Audio) ===
let audioCtx = null;
let soundEnabled = true;   // toggled by the Sound on/off setting
function getAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}

const SFX_ASSET_CUES = {
    cannon_fire:     { gain: 0.96, files: ['cannon_fire_01.ogg'] },
    mortar_fire:     { gain: 1.02, files: ['mortar_fire_01.ogg', 'mortar_fire_02.ogg'] },
    explosion_blast: { gain: 0.96, files: ['explosion_blast_01.ogg', 'explosion_blast_02.ogg'] },
    drawbridge_creak:{ gain: 0.74, files: ['drawbridge_creak_01.ogg', 'drawbridge_creak_02.ogg'] },
    player_hit:      { gain: 0.68, files: ['player_hit_01.ogg', 'player_hit_02.ogg', 'player_hit_03.ogg'] },
    guard_footstep:  { gain: 0.30, files: ['guard_step_01.ogg', 'guard_step_02.ogg', 'guard_step_03.ogg', 'guard_step_04.ogg'] },
    minigun_spin:    { gain: 0.22, files: ['minigun_spin_01.ogg'] },
    minigun_shot:    { gain: 0.20, files: ['minigun_shot_01.ogg', 'minigun_shot_02.ogg', 'minigun_shot_03.ogg'] },
    sniper_shot:     { gain: 0.94, files: ['sniper_shot_01.ogg'] },
    stone_impact:    { gain: 0.92, files: ['stone_hit_01.ogg', 'stone_hit_02.ogg', 'stone_hit_03.ogg'] },
    stone_crack:     { gain: 0.28, files: ['stone_crack_01.ogg', 'stone_crack_02.ogg'] },
    sniper_thwack:   { gain: 0.86, files: ['sniper_thwack_01.ogg'] }
};
const sfxBufferCache = new Map();   // path -> AudioBuffer|null
const sfxBufferLoads = new Map();   // path -> Promise
let sfxPrecacheStarted = false;
let sfxPrecacheGestureBound = false;
let sfxPrecacheQueue = [];
let sfxPrecacheTimer = null;
let sfxMobileWarmReady = true;
let sfxPrecacheCombatPauseUntil = 0;
let sfxFirstCombatAt = 0;
let activeSfxCueVoices = 0;
const MAX_ACTIVE_SFX_CUE_VOICES = isMobileProfile ? 12 : 40;
const SFX_PRECACHE_COMBAT_PAUSE_MS = isMobileProfile ? 18000 : 7000;
let minigunSpinLastAt = 0;
const MORTAR_RARE_BOOM_CHANCE = 0.18;
let rubbleSoundEnabled = false;   // dedicated A/B toggle: keeps global sound on while muting rubble loop
const lightweightRubbleMode = true; // hardwired: stricter rubble/scan throttles are always on (Settings toggle removed � it was forced true everywhere and did nothing)
let masonryRumbleLevel = 0;
let masonryNextPulseAt = 0;
let masonryNextCrackAt = 0;

function sfxPath(fileName) {
    const base = (import.meta.env.BASE_URL || '/');
    return `${base}audio/sfx/${fileName}`;
}

function queueSfxBufferLoad(path) {
    if (sfxBufferCache.has(path) || sfxBufferLoads.has(path)) return;
    const ctx = getAudio();
    const job = fetch(path)
        .then(r => {
            if (!r.ok) throw new Error(`SFX fetch failed: ${path}`);
            return r.arrayBuffer();
        })
        .then(ab => ctx.decodeAudioData(ab.slice(0)))
        .then(buffer => { sfxBufferCache.set(path, buffer); })
        .catch(() => { sfxBufferCache.set(path, null); })
        .finally(() => {
            sfxBufferLoads.delete(path);
            if (isMobileProfile && sfxPrecacheStarted && sfxPrecacheQueue.length === 0 && sfxBufferLoads.size === 0) {
                sfxMobileWarmReady = true;
            }
        });
    sfxBufferLoads.set(path, job);
}

function pumpSfxPrecacheQueue() {
    if (sfxPrecacheQueue.length === 0) {
        sfxPrecacheTimer = null;
        if (isMobileProfile && sfxPrecacheStarted && sfxBufferLoads.size === 0) {
            sfxMobileWarmReady = true;
        }
        return;
    }
    const now = performance.now();
    if (now < sfxPrecacheCombatPauseUntil) {
        sfxPrecacheTimer = setTimeout(pumpSfxPrecacheQueue, isMobileProfile ? 650 : 280);
        return;
    }
    const path = sfxPrecacheQueue.shift();
    queueSfxBufferLoad(path);
    const gapMs = isMobileProfile ? 140 : 24;
    sfxPrecacheTimer = setTimeout(pumpSfxPrecacheQueue, gapMs);
}

function markSfxCombatActivity() {
    const now = performance.now();
    _lastPlayerShotMs = now;  // track for NPC quiet-taunt gate
    if (!sfxFirstCombatAt) sfxFirstCombatAt = now;
    sfxPrecacheCombatPauseUntil = Math.max(sfxPrecacheCombatPauseUntil, now + SFX_PRECACHE_COMBAT_PAUSE_MS);
}

function enqueueSfxPrecache(path) {
    if (sfxBufferCache.has(path) || sfxBufferLoads.has(path)) return;
    if (sfxPrecacheQueue.includes(path)) return;
    sfxPrecacheQueue.push(path);
    if (!sfxPrecacheTimer) pumpSfxPrecacheQueue();
}

function precacheSfxBuffers() {
    if (sfxPrecacheStarted) return;
    sfxPrecacheStarted = true;
    if (isMobileProfile) {
        // Mobile: avoid bulk decode/streaming during play. Use procedural fallback.
        sfxMobileWarmReady = true;
        sfxPrecacheQueue.length = 0;
        return;
    }
    // Ensure one AudioContext exists so decode jobs can run immediately.
    getAudio();
    const mobilePriorityCues = new Set([
        'cannon_fire', 'mortar_fire', 'explosion_blast',
        'drawbridge_creak', 'minigun_spin', 'minigun_shot',
        'sniper_shot', 'stone_impact', 'sniper_thwack'
    ]);
    for (const [cueName, cue] of Object.entries(SFX_ASSET_CUES)) {
        if (!cue || !cue.files) continue;
        if (isMobileProfile && !mobilePriorityCues.has(cueName)) continue;
        for (const fileName of cue.files) {
            enqueueSfxPrecache(sfxPath(fileName));
        }
    }
}

function unlockAndPrecacheSfx() {
    const ctx = getAudio();
    if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
    }
    // Desktop keeps asset-cue warmup. Mobile stays procedural-only for stability.
    if (!isMobileProfile) precacheSfxBuffers();
}

function bindSfxPrecacheGesture() {
    if (isMobileProfile) return;
    if (sfxPrecacheGestureBound) return;
    sfxPrecacheGestureBound = true;
    const warm = () => {
        unlockAndPrecacheSfx();
        window.removeEventListener('pointerdown', warm, true);
        window.removeEventListener('keydown', warm, true);
        window.removeEventListener('touchstart', warm, true);
    };
    window.addEventListener('pointerdown', warm, true);
    window.addEventListener('keydown', warm, true);
    window.addEventListener('touchstart', warm, true);
}

// Desktop can warm up early; mobile defers to first gesture to avoid startup hitches.
if (!isMobileProfile) precacheSfxBuffers();
bindSfxPrecacheGesture();

function tryPlaySfxCue(cueName, opts = {}) {
    if (!soundEnabled) return false;
    if (isMobileProfile) return false;
    if (activeSfxCueVoices >= MAX_ACTIVE_SFX_CUE_VOICES) return false;
    const cue = SFX_ASSET_CUES[cueName];
    if (!cue || !cue.files || cue.files.length === 0) return false;

    const candidates = [];
    for (const fileName of cue.files) {
        const path = sfxPath(fileName);
        const cached = sfxBufferCache.get(path);
        if (cached) candidates.push(cached);
        else if (cached !== null) queueSfxBufferLoad(path);
    }
    if (candidates.length === 0) return false;

    const ctx = getAudio();
    const now = ctx.currentTime + (opts.delay || 0);
    const buffer = candidates[(Math.random() * candidates.length) | 0];
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const rateJitter = Math.max(0, opts.rateJitter || 0);
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * rateJitter;

    const g = ctx.createGain();
    const cueGain = Number.isFinite(cue.gain) ? cue.gain : 1;
    const userGain = Number.isFinite(opts.gain) ? opts.gain : 1;
    g.gain.value = cueGain * userGain;
    src.connect(g);
    g.connect(ctx.destination);
    activeSfxCueVoices++;
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        activeSfxCueVoices = Math.max(0, activeSfxCueVoices - 1);
        try { src.disconnect(); } catch (e) {}
        try { g.disconnect(); } catch (e) {}
    };
    src.onended = cleanup;
    try {
        src.start(now);
    } catch (e) {
        cleanup();
        return false;
    }
    return true;
}

function hasReadySfxCueBuffer(cueName) {
    const cue = SFX_ASSET_CUES[cueName];
    if (!cue || !cue.files) return false;
    for (const fileName of cue.files) {
        const cached = sfxBufferCache.get(sfxPath(fileName));
        if (cached) return true;
    }
    return false;
}

function isSfxCueFullyLoaded(cueName) {
    const cue = SFX_ASSET_CUES[cueName];
    if (!cue || !cue.files || cue.files.length === 0) return false;
    for (const fileName of cue.files) {
        const cached = sfxBufferCache.get(sfxPath(fileName));
        if (!cached) return false;
    }
    return true;
}

function playLegacyLiteShot(kind = 'cannon') {
    if (!soundEnabled) return;
    const ctx = getAudio();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const startF = kind === 'mortar' ? 82 : 110;
    const endF = kind === 'mortar' ? 38 : 52;
    osc.frequency.setValueAtTime(startF, now);
    osc.frequency.exponentialRampToValueAtTime(endF, now + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(kind === 'mortar' ? 0.22 : 0.18, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.20);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.22);
}

function playLegacyLiteImpact(vol = 0.5) {
    if (!soundEnabled) return;
    const ctx = getAudio();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(96, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.10);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.10 + Math.min(1, vol) * 0.14, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.14);
}

function playCannonFire(weaponIdx = currentWeapon) {
    if (!soundEnabled) return;
    const isMortar = weaponIdx === WEAPON_IDX_MORTAR;
    if (isMortar) {
        const mortarAssetsReady = isSfxCueFullyLoaded('mortar_fire') && isSfxCueFullyLoaded('explosion_blast');
        if (mortarAssetsReady) {
        const rareBoom = Math.random() < MORTAR_RARE_BOOM_CHANCE;
        const blastPlayed = tryPlaySfxCue('explosion_blast', { gain: 1.24, rateJitter: 0.03 });
        if (rareBoom && blastPlayed) {
            // Subtle slap-back to make rare mortar shots feel huge and cinematic.
            tryPlaySfxCue('explosion_blast', { gain: 0.34, delay: 0.13, rateJitter: 0.02 });
        }
        tryPlaySfxCue('mortar_fire', { gain: 1.62, rateJitter: 0.02 });

        // Mobile uses lean sample-first audio; skip expensive synthesis path.
        if (isMobileProfile) return;
        }

        // Mobile fallback: ultra-cheap procedural thump until cues are fully loaded.
        if (isMobileProfile && !mortarAssetsReady) {
            playLegacyLiteShot('mortar');
            return;
        }

        // Always add a deep-pressure tail so mortar feels heavier than cannon.
        const mctx = getAudio();
        const mnow = mctx.currentTime;
        const sub = mctx.createOscillator();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(40, mnow);
        sub.frequency.exponentialRampToValueAtTime(22, mnow + 0.95);
        const subLP = mctx.createBiquadFilter(); subLP.type = 'lowpass'; subLP.frequency.value = 95;
        const subGain = mctx.createGain();
        subGain.gain.setValueAtTime(0.0001, mnow);
        subGain.gain.exponentialRampToValueAtTime(1.16, mnow + 0.03);
        subGain.gain.exponentialRampToValueAtTime(0.0001, mnow + 1.18);
        sub.connect(subLP); subLP.connect(subGain); subGain.connect(mctx.destination);
        sub.start(mnow); sub.stop(mnow + 1.22);

        // Big delayed reflection about 1 second later so mortar reads outdoors and powerful.
        tryPlaySfxCue('explosion_blast', { gain: 0.52, delay: 1.0, rateJitter: 0.02 });

        const eNow = mnow + 1.0;
        const echoSub = mctx.createOscillator();
        echoSub.type = 'sine';
        echoSub.frequency.setValueAtTime(52, eNow);
        echoSub.frequency.exponentialRampToValueAtTime(28, eNow + 0.62);
        const echoLP = mctx.createBiquadFilter(); echoLP.type = 'lowpass'; echoLP.frequency.value = 130;
        const echoGain = mctx.createGain();
        echoGain.gain.setValueAtTime(0.0001, eNow);
        echoGain.gain.exponentialRampToValueAtTime(0.46, eNow + 0.04);
        echoGain.gain.exponentialRampToValueAtTime(0.0001, eNow + 0.72);
        echoSub.connect(echoLP); echoLP.connect(echoGain); echoGain.connect(mctx.destination);
        echoSub.start(eNow); echoSub.stop(eNow + 0.76);

        const echoNoiseLen = Math.floor(mctx.sampleRate * 0.70);
        const echoNoiseBuf = mctx.createBuffer(1, echoNoiseLen, mctx.sampleRate);
        const en = echoNoiseBuf.getChannelData(0);
        for (let i = 0; i < echoNoiseLen; i++) {
            const t = i / mctx.sampleRate;
            en[i] = (Math.random() * 2 - 1) * Math.exp(-t * 5.8);
        }
        const echoNoiseSrc = mctx.createBufferSource(); echoNoiseSrc.buffer = echoNoiseBuf;
        const echoBP = mctx.createBiquadFilter(); echoBP.type = 'bandpass'; echoBP.frequency.value = 210; echoBP.Q.value = 0.65;
        const echoNoiseGain = mctx.createGain();
        echoNoiseGain.gain.setValueAtTime(0.24, eNow + 0.02);
        echoNoiseGain.gain.exponentialRampToValueAtTime(0.0001, eNow + 0.74);
        echoNoiseSrc.connect(echoBP); echoBP.connect(echoNoiseGain); echoNoiseGain.connect(mctx.destination);
        echoNoiseSrc.start(eNow + 0.02);

        // Do not early-return here: mortar should always keep the synthesized
        // low-end boom layers, even when the external sample is preloaded.
    } else {
        if (isSfxCueFullyLoaded('cannon_fire')) {
            const cannonCuePlayed = tryPlaySfxCue('cannon_fire', { gain: 1.0, rateJitter: 0.02 });
            if (cannonCuePlayed) return;
        }
        if (isMobileProfile) {
            playLegacyLiteShot('cannon');
            return;
        }
    }

    const ctx = getAudio(), sr = ctx.sampleRate, now = ctx.currentTime;
    const toneScale = isMortar ? 0.72 : 1.0;
    const tailScale = isMortar ? 1.35 : 1.0;

    // --- Layer 1: deep sub-bass body thump (0?120 Hz) ---
    const thumpLen = sr * (1.4 * tailScale);
    const thumpBuf = ctx.createBuffer(1, thumpLen, sr);
    const thumpData = thumpBuf.getChannelData(0);
    for (let i = 0; i < thumpLen; i++) {
        const t = i / sr;
        // Pitch-sweeping sine: starts at 90 Hz, drops to 28 Hz
        const freq = (90 * toneScale) * Math.exp(-t * 3.5) + (28 * toneScale);
        thumpData[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * (isMortar ? 2.2 : 2.8))
                     + (Math.random() * 2 - 1) * 0.18 * Math.exp(-t * 6);
    }
    const thumpSrc = ctx.createBufferSource(); thumpSrc.buffer = thumpBuf;
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(isMortar ? 3.9 : 3.5, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + (1.4 * tailScale));
    thumpSrc.connect(thumpGain); thumpGain.connect(ctx.destination); thumpSrc.start(now);

    // --- Layer 2: mid-freq pressure blast (noise through resonant LP) ---
    const blastLen = sr * (isMortar ? 1.05 : 0.9);
    const blastBuf = ctx.createBuffer(1, blastLen, sr);
    const blastData = blastBuf.getChannelData(0);
    for (let i = 0; i < blastLen; i++) blastData[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sr) * 7);
    const blastSrc = ctx.createBufferSource(); blastSrc.buffer = blastBuf;
    const blastLP = ctx.createBiquadFilter(); blastLP.type = 'lowpass';
    blastLP.frequency.setValueAtTime(isMortar ? 700 : 900, now);
    blastLP.frequency.exponentialRampToValueAtTime(isMortar ? 90 : 120, now + (isMortar ? 1.05 : 0.9));
    blastLP.Q.value = 3.5;
    const blastGain = ctx.createGain();
    blastGain.gain.setValueAtTime(isMortar ? 2.5 : 2.8, now);
    blastGain.gain.exponentialRampToValueAtTime(0.001, now + (isMortar ? 1.05 : 0.9));
    blastSrc.connect(blastLP); blastLP.connect(blastGain); blastGain.connect(ctx.destination); blastSrc.start(now);

    // --- Layer 3: sharp high crack transient ---
    const crackLen = sr * 0.12;
    const crackBuf = ctx.createBuffer(1, crackLen, sr);
    const crackData = crackBuf.getChannelData(0);
    for (let i = 0; i < crackLen; i++) crackData[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sr) * 60);
    const crackSrc = ctx.createBufferSource(); crackSrc.buffer = crackBuf;
    const crackHP = ctx.createBiquadFilter(); crackHP.type = 'highpass'; crackHP.frequency.value = 1800;
    const crackGain = ctx.createGain(); crackGain.gain.value = 1.6;
    crackSrc.connect(crackHP); crackHP.connect(crackGain); crackGain.connect(ctx.destination); crackSrc.start(now);
}

// Classic two-note coin "bling" (B5 -> E6, square wave, fast attack/decay) —
// Mario-esque, synthesized so no sample is needed. Plays on both platforms.
function playCoinSound() {
    if (!soundEnabled) return;
    const ctx = getAudio(), now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(isMobileProfile ? 0.10 : 0.14, now);
    master.connect(ctx.destination);
    const note = (freq, t0, dur) => {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.setValueAtTime(freq, t0);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(1, t0 + 0.008);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
        o.connect(g);
        g.connect(master);
        o.start(t0);
        o.stop(t0 + dur + 0.02);
    };
    note(988, now, 0.09);          // B5
    note(1319, now + 0.07, 0.40);  // E6, held
}

function playDrawbridgeCreak(amount = 0.6, speedNorm = 0.5) {
    if (!soundEnabled) return;
    if (isMobileProfile) return;
    const ctx = getAudio(), now = ctx.currentTime;
    const vol = Math.max(0.12, Math.min(1, amount));
    const speed = Math.max(0, Math.min(1, speedNorm));

    // Sample-first path is much cheaper on mobile than building many nodes.
    if (isSfxCueFullyLoaded('drawbridge_creak')) {
        if (tryPlaySfxCue('drawbridge_creak', {
            gain: (0.55 + speed * 0.55) * vol,
            rateJitter: 0.03 + speed * 0.02
        })) return;
    }

    // Mobile perf: do not synthesize fallback if sample is not ready yet.
    if (isMobileProfile) {
        return;
    }

    const clanks = speed > 0.72 ? 3 : speed > 0.38 ? 2 : 1;
    const spacing = 0.032 + (1 - speed) * 0.050;

    // Multi-hit chain clank cluster (short, heavy metal strikes).
    for (let k = 0; k < clanks; k++) {
        const t0 = now + k * spacing;
        const ring = ctx.createOscillator();
        ring.type = 'triangle';
        const base = 170 + Math.random() * 75;
        ring.frequency.setValueAtTime(base, t0);
        ring.frequency.exponentialRampToValueAtTime(96 + Math.random() * 32, t0 + 0.12);
        const ringBP = ctx.createBiquadFilter();
        ringBP.type = 'bandpass';
        ringBP.frequency.value = 260 + Math.random() * 100;
        ringBP.Q.value = 1.1;
        const ringGain = ctx.createGain();
        ringGain.gain.setValueAtTime(0.0001, t0);
        ringGain.gain.exponentialRampToValueAtTime((0.19 + speed * 0.20) * vol, t0 + 0.006);
        ringGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
        ring.connect(ringBP); ringBP.connect(ringGain); ringGain.connect(ctx.destination);
        ring.start(t0); ring.stop(t0 + 0.17);

        const thunk = ctx.createOscillator();
        thunk.type = 'sine';
        thunk.frequency.setValueAtTime(86 + Math.random() * 14, t0);
        thunk.frequency.exponentialRampToValueAtTime(48 + Math.random() * 10, t0 + 0.09);
        const thunkLP = ctx.createBiquadFilter(); thunkLP.type = 'lowpass'; thunkLP.frequency.value = 160;
        const thunkGain = ctx.createGain();
        thunkGain.gain.setValueAtTime(0.0001, t0);
        thunkGain.gain.exponentialRampToValueAtTime((0.16 + speed * 0.18) * vol, t0 + 0.010);
        thunkGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
        thunk.connect(thunkLP); thunkLP.connect(thunkGain); thunkGain.connect(ctx.destination);
        thunk.start(t0); thunk.stop(t0 + 0.13);
    }

    // Short chain rattle tail under the clanks.
    const nDur = 0.18 + speed * 0.10;
    const sr = ctx.sampleRate;
    const nLen = Math.floor(sr * nDur);
    const nBuf = ctx.createBuffer(1, nLen, sr);
    const nDat = nBuf.getChannelData(0);
    for (let i = 0; i < nLen; i++) {
        const t = i / sr;
        nDat[i] = (Math.random() * 2 - 1) * Math.exp(-t * (16 + speed * 6));
    }
    const ns = ctx.createBufferSource(); ns.buffer = nBuf;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 850;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1450; bp.Q.value = 0.7;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime((0.05 + speed * 0.07) * vol, now + 0.010);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + nDur + 0.010);
    ns.connect(hp); hp.connect(bp); bp.connect(ng); ng.connect(ctx.destination);
    ns.start(now + 0.015);
}

function playImpact(intensity, flavor = 'stone') {
    if (!soundEnabled) return;
    const ctx = getAudio(), sr = ctx.sampleRate, now = ctx.currentTime;
    const vol = Math.min(intensity, 1.0);

    let cueAssetsReady = false;
    if (flavor === 'sniper') {
        const sniperAssetsReady = isSfxCueFullyLoaded('sniper_thwack') && isSfxCueFullyLoaded('stone_impact');
        cueAssetsReady = sniperAssetsReady;
        if (sniperAssetsReady) {
            tryPlaySfxCue('sniper_thwack', {
                gain: 0.75 + vol * 0.45,
                rateJitter: 0
            });
            tryPlaySfxCue('stone_impact', {
                gain: 0.22 + vol * 0.22,
                rateJitter: 0.05,
                delay: 0.01
            });
        }
        // Add a low-end hit body so sniper impacts feel dense, not clicky.
        const hitSub = ctx.createOscillator();
        hitSub.type = 'sine';
        hitSub.frequency.setValueAtTime(88, now);
        hitSub.frequency.exponentialRampToValueAtTime(42, now + 0.16);
        const hitSubLP = ctx.createBiquadFilter();
        hitSubLP.type = 'lowpass';
        hitSubLP.frequency.value = 160;
        const hitSubGain = ctx.createGain();
        hitSubGain.gain.setValueAtTime(0.0001, now);
        hitSubGain.gain.exponentialRampToValueAtTime(0.16 + vol * 0.20, now + 0.012);
        hitSubGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.19);
        hitSub.connect(hitSubLP); hitSubLP.connect(hitSubGain); hitSubGain.connect(ctx.destination);
        hitSub.start(now);
        hitSub.stop(now + 0.22);
        if (sniperAssetsReady && Math.random() < (0.14 + vol * 0.18)) {
            tryPlaySfxCue('stone_crack', {
                gain: 0.07 + vol * 0.12,
                rateJitter: 0.05,
                delay: 0.03
            });
        }
    } else {
        const impactAssetsReady = isSfxCueFullyLoaded('stone_impact');
        cueAssetsReady = impactAssetsReady;
        const heavyGain = flavor === 'explosive'
            ? (0.98 + vol * 0.55)
            : (0.62 + vol * 0.45);
        if (impactAssetsReady) {
            tryPlaySfxCue('stone_impact', {
                gain: heavyGain,
                rateJitter: 0.06
            });
        }
        const crackChance = flavor === 'explosive'
            ? (0.24 + vol * 0.20)
            : (0.06 + vol * 0.14);
        if (impactAssetsReady && Math.random() < crackChance) {
            tryPlaySfxCue('stone_crack', {
                gain: flavor === 'explosive' ? (0.12 + vol * 0.16) : (0.06 + vol * 0.10),
                rateJitter: 0.05,
                delay: 0.02 + Math.random() * 0.04
            });
        }
    }

    // Sample-first path: if cues are available, skip expensive synthesized
    // layers to avoid hit-time CPU spikes during heavy masonry contacts.
    if (cueAssetsReady) return;

    // Mobile perf: keep impact audio sample-only; skip expensive synthesis.
    if (isMobileProfile) {
        playLegacyLiteImpact(vol);
        return;
    }

    // --- Layer 1: deep stone rumble thud ---
    const isExplosive = flavor === 'explosive';
    const thudLen = Math.floor(sr * (0.5 + vol * (isExplosive ? 0.85 : 0.6)));
    const thudBuf = ctx.createBuffer(1, thudLen, sr);
    const thudData = thudBuf.getChannelData(0);
    for (let i = 0; i < thudLen; i++) {
        const t = i / sr;
        const baseFreq = isExplosive ? (44 + vol * 24) : (55 + vol * 30);
        const floorFreq = isExplosive ? 16 : 22;
        const freq = baseFreq * Math.exp(-t * 4) + floorFreq;
        thudData[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * (isExplosive ? (2.9 - vol) : (4 - vol * 1.5)))
                    + (Math.random() * 2 - 1) * 0.22 * Math.exp(-t * 9);
    }
    const thudSrc = ctx.createBufferSource(); thudSrc.buffer = thudBuf;
    const thudLP = ctx.createBiquadFilter(); thudLP.type = 'lowpass';
    thudLP.frequency.value = (isExplosive ? 180 : 220) + vol * 120; thudLP.Q.value = 1.8;
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(vol * (isExplosive ? 3.4 : 2.8), now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5 + vol * (isExplosive ? 0.7 : 0.5));
    thudSrc.connect(thudLP); thudLP.connect(thudGain); thudGain.connect(ctx.destination); thudSrc.start(now);

    // Dedicated low-end pressure wave so hits read as heavy stone, not clicks.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(isExplosive ? 38 : 48, now);
    sub.frequency.exponentialRampToValueAtTime(isExplosive ? 24 : 32, now + 0.24 + vol * 0.12);
    const subLP = ctx.createBiquadFilter(); subLP.type = 'lowpass'; subLP.frequency.value = 95;
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.exponentialRampToValueAtTime((isExplosive ? 1.35 : 0.95) * (0.45 + vol * 0.45), now + 0.02);
    subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.30 + vol * 0.18);
    sub.connect(subLP); subLP.connect(subGain); subGain.connect(ctx.destination);
    sub.start(now); sub.stop(now + 0.40 + vol * 0.22);

    // --- Layer 2: stone crack / scrape (band-passed noise burst) ---
    const crackLen = Math.floor(sr * (0.18 + vol * 0.22));
    const crackBuf = ctx.createBuffer(1, crackLen, sr);
    const crackData = crackBuf.getChannelData(0);
    for (let i = 0; i < crackLen; i++) crackData[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sr) * 22);
    const crackSrc = ctx.createBufferSource(); crackSrc.buffer = crackBuf;
    const crackBP = ctx.createBiquadFilter(); crackBP.type = 'bandpass';
    crackBP.frequency.value = 420 + vol * 260; crackBP.Q.value = 0.75;
    const crackGain = ctx.createGain(); crackGain.gain.value = vol * 0.38;
    crackSrc.connect(crackBP); crackBP.connect(crackGain); crackGain.connect(ctx.destination); crackSrc.start(now);

    // --- Layer 3: short debris rattle (high-freq sprinkle, only on hard hits) ---
    if (vol > 0.35) {
        const rattleLen = Math.floor(sr * 0.3);
        const rattleBuf = ctx.createBuffer(1, rattleLen, sr);
        const rattleData = rattleBuf.getChannelData(0);
        for (let i = 0; i < rattleLen; i++) rattleData[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sr) * 14);
        const rattleSrc = ctx.createBufferSource(); rattleSrc.buffer = rattleBuf;
        const rattleHP = ctx.createBiquadFilter(); rattleHP.type = 'highpass'; rattleHP.frequency.value = 2400;
        const rattleGain = ctx.createGain(); rattleGain.gain.value = (vol - 0.35) * 0.24;
        rattleSrc.connect(rattleHP); rattleHP.connect(rattleGain); rattleGain.connect(ctx.destination);
        rattleSrc.start(now + 0.04);
    }
}

function playExplosionBlast(radius) {
    if (!soundEnabled) return;
    const ctx = getAudio(), sr = ctx.sampleRate, now = ctx.currentTime;
    const scale = Math.min(radius / 7.0, 1.0);

    // Play the OGG asset for a rich body/tail � but do NOT return early;
    // the synthesized punch below ALWAYS plays to guarantee a sharp attack
    // regardless of whether the OGG is loaded or mastered loudly.
    const cueReady = isSfxCueFullyLoaded('explosion_blast');
    if (cueReady) tryPlaySfxCue('explosion_blast', { gain: 0.55 + scale * 0.38, rateJitter: 0.04 });

    if (isMobileProfile) {
        if (!cueReady) playLegacyLiteImpact(0.9);
        // Lightweight punch on mobile so there is SOMETHING bang-like
        const pLen = Math.floor(sr * 0.14);
        const pBuf = ctx.createBuffer(1, pLen, sr);
        const pd = pBuf.getChannelData(0);
        for (let i = 0; i < pLen; i++) pd[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sr) * 32);
        const pSrc = ctx.createBufferSource(); pSrc.buffer = pBuf;
        const pG = ctx.createGain();
        pG.gain.setValueAtTime(1.6 + scale * 1.1, now);
        pG.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        pSrc.connect(pG); pG.connect(ctx.destination); pSrc.start(now);
        return;
    }

    // Desktop: layered synthesized bang � always runs.

    // 1. Sharp broadband crack � the actual �BANG�, very fast decay
    const crackLen = Math.floor(sr * 0.26);
    const crackBuf = ctx.createBuffer(1, crackLen, sr);
    const crackData = crackBuf.getChannelData(0);
    for (let i = 0; i < crackLen; i++) {
        const t = i / sr;
        crackData[i] = (Math.random() * 2 - 1) * Math.exp(-t * 20)
                     + (Math.random() * 2 - 1) * 0.5 * Math.exp(-t * 68);
    }
    const crackSrc = ctx.createBufferSource(); crackSrc.buffer = crackBuf;
    const crackHP = ctx.createBiquadFilter(); crackHP.type = 'highpass'; crackHP.frequency.value = 65;
    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(3.6 + scale * 2.8, now);
    crackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
    crackSrc.connect(crackHP); crackHP.connect(crackGain); crackGain.connect(ctx.destination);
    crackSrc.start(now);

    // 2. Sub-bass thump: pitched sweep from ~110Hz ? 28Hz
    const thumpLen = Math.floor(sr * 0.7);
    const thumpBuf = ctx.createBuffer(1, thumpLen, sr);
    const thumpData = thumpBuf.getChannelData(0);
    for (let i = 0; i < thumpLen; i++) {
        const t = i / sr;
        thumpData[i] = Math.sin(2 * Math.PI * (110 * Math.exp(-t * 4.0) + 28) * t)
                     * Math.exp(-t * 3.5);
    }
    const thumpSrc = ctx.createBufferSource(); thumpSrc.buffer = thumpBuf;
    const thumpLP = ctx.createBiquadFilter(); thumpLP.type = 'lowpass'; thumpLP.frequency.value = 200;
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(3.8 + scale * 2.2, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
    thumpSrc.connect(thumpLP); thumpLP.connect(thumpGain); thumpGain.connect(ctx.destination);
    thumpSrc.start(now);

    // 3. Mid-range body + debris tail (only when OGG didn�t load, avoids double-body)
    if (!cueReady) {
        const bodyLen = Math.floor(sr * 1.1);
        const bodyBuf = ctx.createBuffer(1, bodyLen, sr);
        const bodyData = bodyBuf.getChannelData(0);
        for (let i = 0; i < bodyLen; i++) bodyData[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sr) * 5);
        const bodySrc = ctx.createBufferSource(); bodySrc.buffer = bodyBuf;
        const bodyLP = ctx.createBiquadFilter(); bodyLP.type = 'lowpass';
        bodyLP.frequency.setValueAtTime(2200, now);
        bodyLP.frequency.exponentialRampToValueAtTime(200, now + 1.1);
        bodyLP.Q.value = 1.5;
        const bodyGain = ctx.createGain();
        bodyGain.gain.setValueAtTime(2.2 + scale * 1.5, now);
        bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 1.1);
        bodySrc.connect(bodyLP); bodyLP.connect(bodyGain); bodyGain.connect(ctx.destination); bodySrc.start(now);

        const tailLen = Math.floor(sr * 1.8);
        const tailBuf = ctx.createBuffer(1, tailLen, sr);
        const tailData = tailBuf.getChannelData(0);
        for (let i = 0; i < tailLen; i++) tailData[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sr) * 3);
        const tailSrc = ctx.createBufferSource(); tailSrc.buffer = tailBuf;
        const tailBP = ctx.createBiquadFilter(); tailBP.type = 'bandpass';
        tailBP.frequency.value = 1200; tailBP.Q.value = 0.5;
        const tailGain = ctx.createGain();
        tailGain.gain.setValueAtTime(scale * 1.2, now + 0.05);
        tailGain.gain.exponentialRampToValueAtTime(0.001, now + 1.8);
        tailSrc.connect(tailBP); tailBP.connect(tailGain); tailGain.connect(ctx.destination); tailSrc.start(now + 0.05);
    }
}

function playStoneCrackAccent(strength = 1) {
    if (!soundEnabled) return;
    const s = Math.max(0.2, Math.min(1.6, strength));
    if (isSfxCueFullyLoaded('stone_crack') && tryPlaySfxCue('stone_crack', { gain: 0.11 * s, rateJitter: 0.06 })) return;
    const ctx = getAudio();
    const now = ctx.currentTime;
    const n = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.11), ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
        const t = i / ctx.sampleRate;
        d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 40);
    }
    const src = ctx.createBufferSource(); src.buffer = n;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.06 * s, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
    src.connect(hp); hp.connect(g); g.connect(ctx.destination);
    src.start(now);
}

function playMasonryRubblePulse(intensity) {
    if (!soundEnabled) return;
    if (isMobileProfile) return;
    const i = Math.max(0.1, Math.min(1.6, intensity));
    if (i < 0.22) return;
    const drive = Math.pow(Math.min(1.2, i / 1.2), 1.6);

    if (Math.random() < (0.12 + drive * 0.28)) {
        tryPlaySfxCue('stone_impact', {
            gain: (0.03 + i * 0.08) * drive,
            rateJitter: 0.08
        });
    }

    const ctx = getAudio();
    const now = ctx.currentTime;
    const dur = 0.42 + i * 0.55;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let n = 0; n < len; n++) {
        const t = n / ctx.sampleRate;
        const body = (Math.random() * 2 - 1) * Math.exp(-t * (2.8 - Math.min(1.2, i * 0.7)));
        const grit = (Math.random() * 2 - 1) * Math.exp(-t * 12.0);
        d[n] = body * 0.65 + grit * 0.35;
    }

    const src = ctx.createBufferSource(); src.buffer = buf;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 28;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260 + i * 180;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime((0.03 + i * 0.08) * drive, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(ctx.destination);
    src.start(now);

    // Sub-rumble carrier under collapse tails.
    const sub = ctx.createOscillator();
    sub.type = 'triangle';
    sub.frequency.setValueAtTime(44 - i * 6, now);
    sub.frequency.exponentialRampToValueAtTime(26, now + dur);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.exponentialRampToValueAtTime((0.04 + i * 0.12) * drive, now + 0.03);
    subGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    const subLP = ctx.createBiquadFilter(); subLP.type = 'lowpass'; subLP.frequency.value = 90;
    sub.connect(subLP); subLP.connect(subGain); subGain.connect(ctx.destination);
    sub.start(now); sub.stop(now + dur + 0.05);

    if (i > 0.6) {
        const debrisLen = Math.floor(ctx.sampleRate * 0.26);
        const debrisBuf = ctx.createBuffer(1, debrisLen, ctx.sampleRate);
        const dd = debrisBuf.getChannelData(0);
        for (let n = 0; n < debrisLen; n++) dd[n] = (Math.random() * 2 - 1) * Math.exp(-(n / ctx.sampleRate) * 24);
        const ds = ctx.createBufferSource(); ds.buffer = debrisBuf;
        const dhp = ctx.createBiquadFilter(); dhp.type = 'highpass'; dhp.frequency.value = 1700;
        const dg = ctx.createGain();
        dg.gain.setValueAtTime((0.01 + i * 0.015) * drive, now + 0.06);
        dg.gain.exponentialRampToValueAtTime(0.0001, now + 0.30);
        ds.connect(dhp); dhp.connect(dg); dg.connect(ctx.destination);
        ds.start(now + 0.06);
    }
}

function updateMasonrySoundscape(movingCount, movingEnergy, dt) {
    if (!soundEnabled) return;
    if (!rubbleSoundEnabled) {
        masonryRumbleLevel = Math.max(0, masonryRumbleLevel - dt * 2.0);
        return;
    }
    if (isMobileProfile) return;
    // Tiny residual jitter from one or two bricks should not keep spawning
    // procedural rubble pulses indefinitely after a collapse has settled.
    if (movingCount < 3 || movingEnergy < 1.4) {
        masonryRumbleLevel = Math.max(0, masonryRumbleLevel - dt * 2.8);
        return;
    }
    const avgSpeed = movingCount > 0 ? Math.sqrt(movingEnergy / movingCount) : 0;
    const speedNorm = Math.max(0, Math.min(1.2, (avgSpeed - 0.85) / 4.2));
    const massNorm = Math.max(0, Math.min(1.0, (movingCount - 2) / 34));
    const target = Math.pow(speedNorm, 1.7) * (0.35 + massNorm * 0.95);
    masonryRumbleLevel += (target - masonryRumbleLevel) * Math.min(1, dt * 3.2);

    const now = performance.now();
    if (masonryRumbleLevel > 0.16 && now >= masonryNextPulseAt) {
        playMasonryRubblePulse(masonryRumbleLevel);
        const pulseGap = Math.max(95, 340 - masonryRumbleLevel * 160);
        masonryNextPulseAt = now + pulseGap + Math.random() * 120;
    }

    if (masonryRumbleLevel > 0.88 && now >= masonryNextCrackAt && Math.random() < 0.18) {
        playStoneCrackAccent(0.7 + masonryRumbleLevel * 0.9);
        masonryNextCrackAt = now + 520 + Math.random() * 760;
    }
}

// Short impact grunt for hits 1 & 2
function playArrowHitSound() {
    if (!soundEnabled) return;
    if (tryPlaySfxCue('player_hit', { gain: 0.95, rateJitter: 0.08 })) return;
    // Fallback: short body impact thud + cloth rustle (no vocal synth tone)
    const ctx = getAudio(), sr = ctx.sampleRate, now = ctx.currentTime;
    const dur = 0.20, N = Math.floor(sr * dur);
    const buf = ctx.createBuffer(1, N, sr); const d = buf.getChannelData(0);
    let phase = 0;
    for (let i = 0; i < N; i++) {
        const t = i / sr;
        const f0 = 98 * Math.exp(-t * 8) + 42;
        phase += (2 * Math.PI * f0) / sr;
        const body = Math.sin(phase) * Math.exp(-t * 21);
        const cloth = (Math.random() * 2 - 1) * Math.exp(-t * 35);
        d[i] = body * 0.95 + cloth * 0.20;
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 48;
    const g = ctx.createGain(); g.gain.value = 0.62;
    src.connect(lp); lp.connect(hp); hp.connect(g); g.connect(ctx.destination);
    src.start(now);
}


function playMinigunShot() {
    if (!soundEnabled) return;
    const nowMs = performance.now();
    if (nowMs - minigunSpinLastAt > 150) {
        tryPlaySfxCue('minigun_spin', { gain: 0.65, rateJitter: 0.03 });
        minigunSpinLastAt = nowMs;
    }
    const shotCuePlayed = tryPlaySfxCue('minigun_shot', { gain: 0.80, rateJitter: 0.03 });

    const ctx = getAudio(), sr = ctx.sampleRate, now = ctx.currentTime;
    // Bike-like rev overtone on every bullet pulse so the stream sounds like an engine.
    const rev = ctx.createOscillator();
    rev.type = 'sawtooth';
    rev.frequency.setValueAtTime(90 + Math.random() * 10, now);
    rev.frequency.exponentialRampToValueAtTime(156 + Math.random() * 18, now + 0.08);
    const revLP = ctx.createBiquadFilter(); revLP.type = 'lowpass'; revLP.frequency.value = 560;
    const revBP = ctx.createBiquadFilter(); revBP.type = 'bandpass'; revBP.frequency.value = 170;
    revBP.Q.value = 0.85;
    const revGain = ctx.createGain();
    revGain.gain.setValueAtTime(0.0001, now);
    revGain.gain.exponentialRampToValueAtTime(0.15, now + 0.012);
    revGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    rev.connect(revBP); revBP.connect(revLP); revLP.connect(revGain); revGain.connect(ctx.destination);
    rev.start(now);
    rev.stop(now + 0.12);

    const revSub = ctx.createOscillator();
    revSub.type = 'triangle';
    revSub.frequency.setValueAtTime(68, now);
    revSub.frequency.exponentialRampToValueAtTime(46, now + 0.09);
    const revSubLP = ctx.createBiquadFilter(); revSubLP.type = 'lowpass'; revSubLP.frequency.value = 120;
    const revSubGain = ctx.createGain();
    revSubGain.gain.setValueAtTime(0.0001, now);
    revSubGain.gain.exponentialRampToValueAtTime(0.10, now + 0.01);
    revSubGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    revSub.connect(revSubLP); revSubLP.connect(revSubGain); revSubGain.connect(ctx.destination);
    revSub.start(now);
    revSub.stop(now + 0.13);

    if (shotCuePlayed) return;

    // Fallback: quieter mechanical chatter with a short rotating whirr body.
    const N = Math.floor(sr * 0.10);
    const buf = ctx.createBuffer(1, N, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < N; i++) {
        const t = i / sr;
        const thump = Math.sin(2 * Math.PI * 78 * t) * Math.exp(-t * 46);
        const grit = (Math.random() * 2 - 1) * Math.exp(-t * 60);
        d[i] = thump * 0.48 + grit * 0.12;
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const whirr = ctx.createOscillator();
    whirr.type = 'sawtooth';
    whirr.frequency.setValueAtTime(145, now);
    whirr.frequency.exponentialRampToValueAtTime(185, now + 0.08);
    const whirrLp = ctx.createBiquadFilter(); whirrLp.type = 'lowpass'; whirrLp.frequency.value = 420;
    const whirrGain = ctx.createGain();
    whirrGain.gain.setValueAtTime(0.0001, now);
    whirrGain.gain.exponentialRampToValueAtTime(0.06, now + 0.008);
    whirrGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.10);

    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.value = 520; lp.Q.value = 1.0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.001; comp.release.value = 0.05;
    const gain = ctx.createGain(); gain.gain.value = 0.38;
    src.connect(lp); lp.connect(comp); comp.connect(gain); gain.connect(ctx.destination);
    whirr.connect(whirrLp); whirrLp.connect(whirrGain); whirrGain.connect(ctx.destination);
    src.start(now);
    whirr.start(now);
    whirr.stop(now + 0.11);
}

function playShotgunShot() {
    if (!soundEnabled) return;
    // Layer two close cannon-fire cues to suggest both barrels discharging.
    tryPlaySfxCue('cannon_fire', { gain: 0.54, rateJitter: 0.03 });
    tryPlaySfxCue('cannon_fire', { gain: 0.38, delay: 0.016, rateJitter: 0.03 });
    tryPlaySfxCue('stone_crack', { gain: 0.08, delay: 0.012, rateJitter: 0.08 });

    const ctx = getAudio(), sr = ctx.sampleRate, now = ctx.currentTime;

    const thump = ctx.createOscillator();
    thump.type = 'triangle';
    thump.frequency.setValueAtTime(132, now);
    thump.frequency.exponentialRampToValueAtTime(48, now + 0.18);
    const thumpLP = ctx.createBiquadFilter();
    thumpLP.type = 'lowpass';
    thumpLP.frequency.value = 310;
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.0001, now);
    thumpGain.gain.exponentialRampToValueAtTime(1.25, now + 0.010);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    thump.connect(thumpLP); thumpLP.connect(thumpGain); thumpGain.connect(ctx.destination);
    thump.start(now);
    thump.stop(now + 0.28);

    const crackLen = Math.floor(sr * 0.11);
    const crackBuf = ctx.createBuffer(1, crackLen, sr);
    const crackData = crackBuf.getChannelData(0);
    for (let i = 0; i < crackLen; i++) {
        const t = i / sr;
        crackData[i] = (Math.random() * 2 - 1) * Math.exp(-t * 62);
    }
    const crackSrc = ctx.createBufferSource(); crackSrc.buffer = crackBuf;
    const crackBP = ctx.createBiquadFilter();
    crackBP.type = 'bandpass';
    crackBP.frequency.value = 760;
    crackBP.Q.value = 0.82;
    const crackGain = ctx.createGain();
    crackGain.gain.value = 0.26;
    crackSrc.connect(crackBP); crackBP.connect(crackGain); crackGain.connect(ctx.destination);
    crackSrc.start(now);

    const echoLen = Math.floor(sr * 0.22);
    const echoBuf = ctx.createBuffer(1, echoLen, sr);
    const echoData = echoBuf.getChannelData(0);
    for (let i = 0; i < echoLen; i++) {
        const t = i / sr;
        echoData[i] = (Math.random() * 2 - 1) * Math.exp(-t * 24);
    }
    const echoSrc = ctx.createBufferSource(); echoSrc.buffer = echoBuf;
    const echoLP = ctx.createBiquadFilter();
    echoLP.type = 'lowpass';
    echoLP.frequency.value = 510;
    const echoGain = ctx.createGain();
    echoGain.gain.setValueAtTime(0.13, now + 0.12);
    echoGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    echoSrc.connect(echoLP); echoLP.connect(echoGain); echoGain.connect(ctx.destination);
    echoSrc.start(now + 0.12);
}

function playSniperShot() {
    if (!soundEnabled) return;
    tryPlaySfxCue('sniper_shot', { gain: 0.46, rateJitter: 0 });

    const ctx = getAudio(), sr = ctx.sampleRate, now = ctx.currentTime;

    // Slap-back echo bus to give the shot outdoor power and distance.
    const echoDelay = ctx.createDelay(0.9);
    echoDelay.delayTime.value = 0.29;
    const echoFeedback = ctx.createGain();
    echoFeedback.gain.value = 0.46;
    const echoLP = ctx.createBiquadFilter();
    echoLP.type = 'lowpass';
    echoLP.frequency.value = 760;
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.44;
    echoDelay.connect(echoFeedback);
    echoFeedback.connect(echoLP);
    echoLP.connect(echoDelay);
    echoLP.connect(echoOut);
    echoOut.connect(ctx.destination);

    // Core muzzle bang body (low-mid punch) so it reads as a powerful rifle.
    const bangOsc = ctx.createOscillator();
    bangOsc.type = 'triangle';
    bangOsc.frequency.setValueAtTime(138, now);
    bangOsc.frequency.exponentialRampToValueAtTime(46, now + 0.16);
    const bangLP = ctx.createBiquadFilter();
    bangLP.type = 'lowpass';
    bangLP.frequency.value = 360;
    const bangGain = ctx.createGain();
    bangGain.gain.setValueAtTime(0.0001, now);
    bangGain.gain.exponentialRampToValueAtTime(1.95, now + 0.013);
    bangGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    bangOsc.connect(bangLP); bangLP.connect(bangGain); bangGain.connect(ctx.destination);
    bangGain.connect(echoDelay);
    bangOsc.start(now);
    bangOsc.stop(now + 0.36);

    // Low-mid pressure burst for a harder "bang" attack.
    const punchLen = Math.floor(sr * 0.18);
    const punchBuf = ctx.createBuffer(1, punchLen, sr);
    const punchData = punchBuf.getChannelData(0);
    for (let i = 0; i < punchLen; i++) {
        const t = i / sr;
        punchData[i] = (Math.random() * 2 - 1) * Math.exp(-t * 26);
    }
    const punchSrc = ctx.createBufferSource(); punchSrc.buffer = punchBuf;
    const punchBP = ctx.createBiquadFilter();
    punchBP.type = 'bandpass';
    punchBP.frequency.value = 240;
    punchBP.Q.value = 0.78;
    const punchGain = ctx.createGain();
    punchGain.gain.value = 0.78;
    punchSrc.connect(punchBP); punchBP.connect(punchGain); punchGain.connect(ctx.destination);
    punchGain.connect(echoDelay);
    punchSrc.start(now);

    // Extra sub body so the report lands like a heavy rifle.
    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(78, now);
    subOsc.frequency.exponentialRampToValueAtTime(34, now + 0.24);
    const subLP = ctx.createBiquadFilter();
    subLP.type = 'lowpass';
    subLP.frequency.value = 115;
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.exponentialRampToValueAtTime(1.72, now + 0.014);
    subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    subOsc.connect(subLP); subLP.connect(subGain); subGain.connect(ctx.destination);
    subGain.connect(echoDelay);
    subOsc.start(now);
    subOsc.stop(now + 0.45);

    // Chest-thump pressure pulse for extra power at trigger time.
    const chestOsc = ctx.createOscillator();
    chestOsc.type = 'sine';
    chestOsc.frequency.setValueAtTime(44, now);
    chestOsc.frequency.exponentialRampToValueAtTime(31, now + 0.16);
    const chestLP = ctx.createBiquadFilter();
    chestLP.type = 'lowpass';
    chestLP.frequency.value = 86;
    const chestGain = ctx.createGain();
    chestGain.gain.setValueAtTime(0.0001, now);
    chestGain.gain.exponentialRampToValueAtTime(1.46, now + 0.010);
    chestGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    chestOsc.connect(chestLP); chestLP.connect(chestGain); chestGain.connect(ctx.destination);
    chestGain.connect(echoDelay);
    chestOsc.start(now);
    chestOsc.stop(now + 0.20);

    // Muzzle blast noise transient for the sharp "bang" edge.
    const blastLen = Math.floor(sr * 0.12);
    const blastBuf = ctx.createBuffer(1, blastLen, sr);
    const blastData = blastBuf.getChannelData(0);
    for (let i = 0; i < blastLen; i++) {
        const t = i / sr;
        blastData[i] = (Math.random() * 2 - 1) * Math.exp(-t * 52);
    }
    const blastSrc = ctx.createBufferSource(); blastSrc.buffer = blastBuf;
    const blastBP = ctx.createBiquadFilter();
    blastBP.type = 'bandpass';
    blastBP.frequency.value = 380;
    blastBP.Q.value = 0.7;
    const blastGain = ctx.createGain();
    blastGain.gain.value = 0.22;
    blastSrc.connect(blastBP); blastBP.connect(blastGain); blastGain.connect(ctx.destination);
    blastGain.connect(echoDelay);
    blastSrc.start(now);

    const crackDur = 0.11;
    const crackN = Math.floor(sr * crackDur);
    const crackBuf = ctx.createBuffer(1, crackN, sr);
    const crackData = crackBuf.getChannelData(0);
    for (let i = 0; i < crackN; i++) {
        const t = i / sr;
        const env = Math.exp(-t * 65);
        crackData[i] = (Math.random() * 2 - 1) * env
            + Math.sin(2 * Math.PI * (1200 - t * 600) * t) * env * 0.35;
    }
    const crackSrc = ctx.createBufferSource();
    crackSrc.buffer = crackBuf;
    const crackHP = ctx.createBiquadFilter();
    crackHP.type = 'highpass'; crackHP.frequency.value = 1800;
    const crackGain = ctx.createGain(); crackGain.gain.value = 0.26;
    crackSrc.connect(crackHP); crackHP.connect(crackGain); crackGain.connect(ctx.destination);
    crackGain.connect(echoDelay);
    crackSrc.start(now);

    const tailOsc = ctx.createOscillator();
    tailOsc.type = 'triangle';
    tailOsc.frequency.setValueAtTime(118, now);
    tailOsc.frequency.exponentialRampToValueAtTime(56, now + 0.27);
    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(0.62, now + 0.02);
    tailGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.52);
    tailOsc.connect(tailGain); tailGain.connect(ctx.destination);
    tailGain.connect(echoDelay);
    tailOsc.start(now + 0.02);
    tailOsc.stop(now + 0.30);

    // Distant tail for outdoor realism.
    const tailNoiseLen = Math.floor(sr * 0.42);
    const tailNoiseBuf = ctx.createBuffer(1, tailNoiseLen, sr);
    const tailData = tailNoiseBuf.getChannelData(0);
    for (let i = 0; i < tailNoiseLen; i++) {
        const t = i / sr;
        tailData[i] = (Math.random() * 2 - 1) * Math.exp(-t * 7.5);
    }
    const tailSrc = ctx.createBufferSource();
    tailSrc.buffer = tailNoiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 460; bp.Q.value = 0.7;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.30, now + 0.06);
    tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.78);
    tailSrc.connect(bp); bp.connect(tg); tg.connect(ctx.destination);
    tg.connect(echoDelay);
    tailSrc.start(now + 0.05);

    // Important for long sessions on mobile: this shot builds a local feedback
    // echo graph. Explicitly disconnect once the tail is done so graphs don't
    // accumulate over many shots.
    const cleanupMs = 2800;
    setTimeout(() => {
        const nodes = [
            tg, bp, tailGain, crackGain, crackHP, blastGain, blastBP,
            chestGain, chestLP, subGain, subLP, punchGain, punchBP,
            bangGain, bangLP, echoOut, echoLP, echoFeedback, echoDelay
        ];
        for (const n of nodes) {
            try { n.disconnect(); } catch (e) {}
        }
    }, cleanupMs);
}

function playBulletWhizz(distance) {
    if (!soundEnabled) return;
    const ctx = getAudio();
    const now = ctx.currentTime;
    const near = Math.max(0, 1 - (distance / 5));
    if (near <= 0) return;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1800, now);
    osc.frequency.exponentialRampToValueAtTime(380, now + 0.08);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.28 * near, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
    osc.connect(hp); hp.connect(g); g.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.12);
}

function playNpcFootstep(distance, pace = 1) {
    // Footstep audio intentionally disabled per gameplay feedback.
    return;
}

function playHeadshotCue() {
    if (!soundEnabled) return;
    const ctx = getAudio();
    const now = ctx.currentTime;

    const ping1 = ctx.createOscillator();
    ping1.type = 'triangle';
    ping1.frequency.setValueAtTime(1200, now);
    ping1.frequency.exponentialRampToValueAtTime(760, now + 0.06);
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.0001, now);
    g1.gain.exponentialRampToValueAtTime(0.16, now + 0.008);
    g1.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    ping1.connect(g1); g1.connect(ctx.destination);
    ping1.start(now);
    ping1.stop(now + 0.08);

    const ping2 = ctx.createOscillator();
    ping2.type = 'sine';
    ping2.frequency.setValueAtTime(1650, now + 0.065);
    ping2.frequency.exponentialRampToValueAtTime(1100, now + 0.13);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, now + 0.06);
    g2.gain.exponentialRampToValueAtTime(0.11, now + 0.073);
    g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
    ping2.connect(g2); g2.connect(ctx.destination);
    ping2.start(now + 0.06);
    ping2.stop(now + 0.15);
}

function spawnSniperTracer(start, end) {
    const dir = end.clone().sub(start);
    const len = dir.length();
    if (len < 0.1) return;
    const mid = start.clone().addScaledVector(dir, 0.5);
    const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.013, 0.008, len, 8),
        new THREE.MeshBasicMaterial({
            color: 0xe2f4ff,
            transparent: true,
            opacity: 0.95,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        })
    );
    mesh.position.copy(mid);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    scene.add(mesh);
    sniperTracers.push({ mesh, life: 0.10, maxLife: 0.10 });
}

// Real Wilhelm scream fetched from Wikimedia Commons (public domain)
// Falls back to synthesised version if fetch fails (CORS / network).
let _wilhelmBuffer = null;
let _wilhelmArrayBuf = null;
fetch('https://upload.wikimedia.org/wikipedia/commons/d/d9/Wilhelm_Scream.ogg')
    .then(r => r.arrayBuffer())
    .then(ab => { _wilhelmArrayBuf = ab; })
    .catch(() => {});

async function playWilhelmScream() {
    if (!soundEnabled) return;
    const ctx = getAudio();
    // Decode on first use (needs AudioContext which requires user gesture first)
    if (!_wilhelmBuffer && _wilhelmArrayBuf) {
        try {
            _wilhelmBuffer = await ctx.decodeAudioData(_wilhelmArrayBuf.slice(0));
        } catch (e) { _wilhelmBuffer = null; }
    }
    if (_wilhelmBuffer) {
        const src = ctx.createBufferSource();
        src.buffer = _wilhelmBuffer;
        const g = ctx.createGain(); g.gain.value = 1.8;
        src.connect(g); g.connect(ctx.destination);
        src.start(ctx.currentTime);
        return;
    }
    // Synthesised fallback (pitch-shifted vocal scream)
    const sr = ctx.sampleRate, now = ctx.currentTime;
    const dur = 2.0, N = Math.floor(sr * dur);
    const buf = ctx.createBuffer(1, N, sr); const d = buf.getChannelData(0);
    let phase = 0, vibPhase = 0;
    for (let i = 0; i < N; i++) {
        const t = i / sr;
        let base;
        if      (t < 0.10) base = 280 + (t / 0.10) * 200;
        else if (t < 0.42) base = 480 + ((t - 0.10) / 0.32) * 340;
        else if (t < 0.75) base = 820 - ((t - 0.42) / 0.33) * 230;
        else if (t < 1.10) base = 590 + ((t - 0.75) / 0.35) * 130;
        else               base = 720 - ((t - 1.10) / 0.90) * 480;
        base = Math.max(140, base);
        vibPhase += (2 * Math.PI * 5.5) / sr;
        const freq = base * (1 + 0.03 * Math.sin(vibPhase));
        phase += (2 * Math.PI * freq) / sr;
        const ph = phase % (2 * Math.PI);
        const osc = (ph / Math.PI - 1) * 0.65 + (ph < Math.PI ? 0.35 : -0.35);
        const env = Math.min(1, t / 0.05) * Math.max(0, 1 - Math.max(0, t - 1.7) / 0.3);
        d[i] = osc * env * 0.45;
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 820;  f1.Q.value = 5;
    const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1380; f2.Q.value = 5;
    const f3 = ctx.createBiquadFilter(); f3.type = 'bandpass'; f3.frequency.value = 2700; f3.Q.value = 4;
    const mix = ctx.createGain(); mix.gain.value = 2.6;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -4; comp.ratio.value = 10;
    src.connect(f1); f1.connect(mix);
    src.connect(f2); f2.connect(mix);
    src.connect(f3); f3.connect(mix);
    mix.connect(comp); comp.connect(ctx.destination);
    src.start(now);
}

// === Particles ===
const particles = [];
const MAX_PARTICLES = 200;
const PARTICLE_GEO = new THREE.BoxGeometry(1, 1, 1);
const P_COLORS = [0x7a6a5a, 0x5a4a3a, 0xb0a090, 0x888888, 0x444444];

function spawnExplosion(pos) {
    if (isMobileProfile) {
        // Keep readable impact feedback on mobile without particle churn.
        popFlash(pos.x, pos.y, pos.z, 0xb7b7b7, 12, 5, 55);
        return;
    }
    if (particles.length >= MAX_PARTICLES) return;
    const count = Math.min(24, MAX_PARTICLES - particles.length);
    for (let i = 0; i < count; i++) {
        const s = Math.random() * 0.15 + 0.05;
        const mat = new THREE.MeshBasicMaterial({
            color: P_COLORS[(Math.random() * P_COLORS.length) | 0],
            transparent: true, opacity: 1.0
        });
        const mesh = new THREE.Mesh(PARTICLE_GEO, mat);
        mesh.scale.setScalar(s);
        mesh.position.copy(pos);
        scene.add(mesh);
        const spd = Math.random() * 8 + 3;
        const theta = Math.random() * Math.PI * 2;
        const upBias = Math.random() * 0.5 + 0.3;
        const maxLife = 1.2 + Math.random() * 1.0;
        particles.push({
            mesh, mat,
            vx: spd * Math.cos(theta) * (1 - upBias),
            vy: spd * upBias + 1.5,
            vz: spd * Math.sin(theta) * (1 - upBias),
            sx: (Math.random() - 0.5) * 12,
            sy: (Math.random() - 0.5) * 12,
            sz: (Math.random() - 0.5) * 12,
            life: maxLife, maxLife
        });
    }
}

// Blood spray for NPC impacts � red, and about half the particle count of the
// stone-dust burst (dust is reserved for hitting masonry).
const BLOOD_COLORS = [0x8a0303, 0xb71010, 0x6a0202, 0xd02020];
function spawnBlood(pos) {
    if (isMobileProfile) return;
    if (particles.length >= MAX_PARTICLES) return;
    const count = Math.min(12, MAX_PARTICLES - particles.length);
    for (let i = 0; i < count; i++) {
        const s = Math.random() * 0.12 + 0.04;
        const mat = new THREE.MeshBasicMaterial({
            color: BLOOD_COLORS[(Math.random() * BLOOD_COLORS.length) | 0],
            transparent: true, opacity: 1.0
        });
        const mesh = new THREE.Mesh(PARTICLE_GEO, mat);
        mesh.scale.setScalar(s);
        mesh.position.copy(pos);
        scene.add(mesh);
        const spd = Math.random() * 7 + 2.5;
        const theta = Math.random() * Math.PI * 2;
        const upBias = Math.random() * 0.5 + 0.3;
        const maxLife = 0.9 + Math.random() * 0.8;
        particles.push({
            mesh, mat,
            vx: spd * Math.cos(theta) * (1 - upBias),
            vy: spd * upBias + 1.0,
            vz: spd * Math.sin(theta) * (1 - upBias),
            sx: (Math.random() - 0.5) * 10,
            sy: (Math.random() - 0.5) * 10,
            sz: (Math.random() - 0.5) * 10,
            life: maxLife, maxLife
        });
    }
}

// === Weapon system ===
// 0 = double-barrel shotgun, 1 = standard cannonball, 2 = explosive,
// 3 = mortar, 4 = minigun, 5 = sniper
let currentWeapon = 0;
const WEAPONS = [
    { name: 'Double Barrel', blastR: 0,            arcLoft: 0,    color: 0xd6c7af },
    { name: 'Cannonball',    blastR: 0,            arcLoft: 0,    color: 0x2a2a2a },
    { name: 'Explosive',     blastR: 6.6,          arcLoft: 0,    color: 0xff4400 },
    { name: 'Mortar',        blastR: 9.5,          arcLoft: 0.55, color: 0x333300 },
    { name: 'Minigun',       blastR: 0,            arcLoft: 0,    color: 0xcccccc },
    { name: 'Sniper',        blastR: 0,            arcLoft: 0,    color: 0xaec6d8 },
    { name: 'FPV Drone',     blastR: DRONE_BLAST_RADIUS, arcLoft: 0, color: 0x2a2a2a },
    { name: 'Grenade',       blastR: 5.5,          arcLoft: 0,    color: 0x556b2f },
    { name: 'Cluster',       blastR: 2.4,          arcLoft: 0,    color: 0xdd4400 },
];
const WEAPON_ICONS = ['💥', '⚫', '💣', '🌋', '⚡', '🎯', '🚁', '🟢', '✳️'];
const POWER_SLIDER_MIN = 10;
const POWER_SLIDER_MAX = 40;
const WEAPON_SPEED_RANGES = [
    { min: 120, max: 190 },            // shotgun pellets
    { min: 10,  max: MAX_BALL_SPEED }, // cannonball
    { min: 10,  max: MAX_BALL_SPEED }, // explosive
    { min: 10,  max: MAX_BALL_SPEED }, // mortar
    { min: 120, max: 176 },            // minigun
    { min: 220, max: 306 },            // sniper
    { min: 0,   max: 0 },              // drone (self-propelled)
    { min: 8,   max: 26 },             // grenade launcher (medium throw range)
    { min: 10,  max: 34 },             // cluster bomb
];
let weaponPowerByIndex = WEAPONS.map(() => POWER_SLIDER_MAX);

function getWeaponLaunchSpeed(weaponIdx, sliderPower) {
    const raw = Number.isFinite(sliderPower) ? sliderPower : POWER_SLIDER_MAX;
    const clampedPower = Math.max(POWER_SLIDER_MIN, Math.min(POWER_SLIDER_MAX, raw));
    const t = (clampedPower - POWER_SLIDER_MIN) / (POWER_SLIDER_MAX - POWER_SLIDER_MIN);
    const range = WEAPON_SPEED_RANGES[weaponIdx] || WEAPON_SPEED_RANGES[0];
    return range.min + (range.max - range.min) * t;
}

// gameOver/gameOverPending/etc declared at top of file to avoid TDZ

function setPaused(paused) {
    gamePaused = paused;
    if (paused) clock.getDelta(); // drain accumulated dt so resuming doesn't jump
    // Show PAUSED banner only mid-game; on the initial screen lockMsg covers things already
    document.getElementById('pauseMsg').style.display = (paused && _hasPlayed) ? 'flex' : 'none';
}

function updateHearts() {
    for (let i = 0; i < 3; i++) {
        const h = document.getElementById('heart' + i);
        if (h) h.classList.toggle('lost', i >= (3 - playerHits));
    }
}

function resetPlayerWaterState(clearReason = true) {
    playerWaterState = null;
    playerWaterContactSec = 0;
    if (clearReason) {
        playerWaterLastDurationSec = 0;
        playerDefeatReason = '';
    }
}

function beginPlayerWaterFall(surfaceY = null) {
    if (playerWaterState || gameOver) return;
    const a = Math.random() * Math.PI * 2;
    const wy = getWaterSurfaceYAtXZ(camera.position.x, camera.position.z);
    if (wy != null) {
        const rippleY = getWaterVisualSurfaceYAtXZ(camera.position.x, camera.position.z) ?? wy;
        spawnWaterImpactRipple(camera.position.x, camera.position.z, rippleY, 6.0, getRippleRoleAtXZ(camera.position.x, camera.position.z));
    }
    playerWaterState = {
        elapsed: 0,
        drownAt: PLAYER_WATER_DROWN_MIN_SEC + Math.random() * PLAYER_WATER_DROWN_JITTER_SEC,
        driftX: Math.cos(a),
        driftZ: Math.sin(a),
        surfaceY,   // null = global moat level; set for the rising bunker flood
    };
    playerOnGround = false;
    playerYVel = Math.min(playerYVel, -2.8);
    jumpQueued = false;
}

function updatePlayerWaterFall(dt) {
    if (!playerWaterState || gameOver) return;
    const ws = playerWaterState;
    ws.elapsed += dt;

    // Drowning takes priority over ammo-out pending so the death reason is correct.
    gameOverPending = false;
    gameOverPendingAt = 0;
    gameOverCalmSec = 0;

    const wobble = Math.sin(ws.elapsed * 4.6) * PLAYER_WATER_BOB_AMP
        + Math.sin(ws.elapsed * 8.9 + 1.25) * (PLAYER_WATER_BOB_AMP * 0.42);
    const sinkStart = ws.drownAt * 0.68;
    const sinkT = Math.max(0, (ws.elapsed - sinkStart) / Math.max(0.2, ws.drownAt - sinkStart));
    const sink = sinkT * sinkT * 0.54;
    // The bunker flood chases its own rising surface; the moat uses WATER_Y.
    if (ws.surfaceY != null && bunkerWp) ws.surfaceY = bunkerWp.baseY;
    const targetY = (ws.surfaceY ?? WATER_Y) + PLAYER_WATER_EYE_OFFSET + wobble - sink;
    camera.position.y = THREE.MathUtils.lerp(
        camera.position.y,
        targetY,
        Math.min(1, dt * PLAYER_WATER_ENTRY_LERP)
    );

    // Slow drifting while bobbing around in the water.
    ws.driftX += (Math.random() - 0.5) * dt * 0.42;
    ws.driftZ += (Math.random() - 0.5) * dt * 0.42;
    const dl = Math.hypot(ws.driftX, ws.driftZ) || 1;
    ws.driftX /= dl;
    ws.driftZ /= dl;
    camera.position.x += ws.driftX * PLAYER_WATER_DRIFT_SPEED * dt;
    camera.position.z += ws.driftZ * PLAYER_WATER_DRIFT_SPEED * dt;

    playerYVel = 0;
    playerOnGround = false;

    if (ws.elapsed >= ws.drownAt) {
        playerWaterLastDurationSec = ws.elapsed;
        const reason = ws.surfaceY != null ? 'drowned-bunker' : 'drowned';
        playerWaterState = null;
        playerDefeatReason = reason;
        showGameOver(false, false, reason);
    }
}

function onPlayerHit() {
    if (gameOver) return;
    playerDefeatReason = '';
    playerHits++;
    cannonHitFlash = 0.4;
    updateHearts();
    // Red vignette flash
    const ov = document.getElementById('hitOverlay');
    ov.classList.add('active');
    setTimeout(() => ov.classList.remove('active'), 200);
    if (playerHits >= 3) {
        playWilhelmScream();
        setTimeout(() => showGameOver(true), 700);
    } else {
        playArrowHitSound();
    }
}

function setNpcStoryDormant(npc, dormant) {
    if (!npc || npc.isRagdoll) return;
    npc.storyDormant = !!dormant;
    if (npc.group) npc.group.visible = !dormant;
    if (npc.body) {
        if (dormant) {
            if (npc._storyDormantPrevMask === undefined) npc._storyDormantPrevMask = npc.body.collisionFilterMask;
            npc.body.collisionFilterMask = 0;
            npc.body.velocity.set(0, 0, 0);
            npc.body.angularVelocity.set(0, 0, 0);
            npc.body.sleep();
        } else if (npc._storyDormantPrevMask !== undefined) {
            npc.body.collisionFilterMask = npc._storyDormantPrevMask;
            npc.body.wakeUp();
        }
    }
    if (dormant) {
        npc.npcPanicSwim = null;
        npc.walking = false;
        npc.waypoints = [];
    }
}

function beginBridgeStage(campaignMode) {
    bridge2ModeActive = false;
    storyModeEnabled = true;
    storyCampaignActive = !!campaignMode;

    // Spawn clearly on dry approach terrain before the bridge-water footprint.
    camera.position.set(0, PLAYER_BASE_Y, STORY_BRIDGE_Z - 36);
    yaw = Math.PI;
    pitch = 0.05;

    buildStoryBridgeEncounter();
    spawnStoryBridgeConvoy(currentDifficulty);
    // Refresh suppression state in case we are transitioning from Bridge 2.
    setStoryBridgeSuppressed(true);
    setStoryBridgeSuppressed(false);
    setStoryCastleSuppressed(true);

    for (const npc of npcList) {
        if (!npc.storyRole) npc.storyRole = 'castle';
        if (npc.storyRole === 'bridge') {
            setNpcStoryDormant(npc, false);
            npc.walking = false;
        } else {
            setNpcStoryDormant(npc, true);
        }
    }

    if (ballista) {
        ballista.storyDormant = true;
        ballista.group.visible = false;
    }

    storyStage = 1;
    updateTotalBricksUi();
    bridgeStageCompletePendingAdvance = false;
    bridgeStageClearPendingAt = 0;
    bridgeStageClearCalmSince = 0;
    const alive = countAliveStoryNpcs('bridge');
    storyBridgeHadNpcWave = alive > 0;
    if (alive > 0) {
        setStoryHud(storyCampaignActive
            ? `Story 1/2: Shatter the bridge crossing (${alive} left)`
            : `Bridge Level: Break the crossing defenders (${alive} left)`);
    } else {
        setStoryHud(storyCampaignActive
            ? 'Story 1/2: Bridge tunnel sandbox (NPCs disabled)'
            : 'Bridge Level: Tunnel sandbox (NPCs disabled)');
    }
}

function beginBridge2TemplateLevel() {
    bridge2ModeActive = true;
    storyModeEnabled = true;
    storyCampaignActive = false;
    storyStage = 1;
    bridgeStageCompletePendingAdvance = false;
    bridgeStageClearPendingAt = 0;
    bridgeStageClearCalmSince = 0;
    storyBridgeHadNpcWave = false;

    // Bridge 2 keeps trench geometry visible, so disable full flat override.
    setTemplateGroundOverrideActive(false);

    camera.position.set(0, PLAYER_BASE_Y, STORY_BRIDGE_Z - 36);
    yaw = Math.PI;
    pitch = 0.05;

    buildStoryBridgeEncounter();

    setStoryBridgeSuppressed(true);
    setStoryBridgeSuppressed(false);
    setStoryCastleSuppressed(true);
    for (const wp of levelWaterPlanes) {
        if (wp?.levelRole !== 'castle') continue;
        if (wp.underlay) wp.underlay.visible = false;
        if (wp.ripple) wp.ripple.visible = false;
        if (wp.ripple2) wp.ripple2.visible = false;
        if (wp.ripple3) wp.ripple3.visible = false;
        if (wp.foam) wp.foam.visible = false;
    }
    for (const r of waterImpactRipples) {
        if (r?.role !== 'castle' || !r.mesh) continue;
        r.mesh.visible = false;
    }
    for (const wm of bridgeLibraryWaterSurfaces) {
        const role = wm?.userData?.waterRole || 'bridge';
        if (role === 'castle' && wm) wm.visible = false;
    }
    if (typeof moatReflector !== 'undefined' && moatReflector) moatReflector.visible = false;
    for (const m of castleSceneMeshes) {
        if (m) m.visible = false;
    }
    updateTotalBricksUi();

    for (const npc of npcList) {
        if (!npc.storyRole) npc.storyRole = 'castle';
        setNpcStoryDormant(npc, true);
    }

    if (ballista) {
        ballista.storyDormant = true;
        ballista.group.visible = false;
    }

    setStoryHud('Bridge 2: Bridge bricks + physics only');
    // Use flat green so z-fighting (if any) shows as a clean colour contrast
    // rather than wild texture flickering, making the glitch easier to read.
    _applyGroundMaterial(grassFlatMat);
}

function beginBridgeDevLevel() {
    bridge2ModeActive = true;
    storyModeEnabled = true;
    storyCampaignActive = false;
    storyStage = 1;
    bridgeStageCompletePendingAdvance = false;
    bridgeStageClearPendingAt = 0;
    bridgeStageClearCalmSince = 0;
    storyBridgeHadNpcWave = false;

    setTemplateGroundOverrideActive(false);

    camera.position.set(0, PLAYER_BASE_Y, STORY_BRIDGE_Z - 36);
    yaw = Math.PI;
    pitch = 0.05;

    buildStoryBridgeEncounter();

    setStoryBridgeSuppressed(true);
    setStoryBridgeSuppressed(false);
    setStoryCastleSuppressed(true);
    for (const wp of levelWaterPlanes) {
        if (wp?.levelRole !== 'castle') continue;
        if (wp.underlay) wp.underlay.visible = false;
        if (wp.ripple) wp.ripple.visible = false;
        if (wp.ripple2) wp.ripple2.visible = false;
        if (wp.ripple3) wp.ripple3.visible = false;
        if (wp.foam) wp.foam.visible = false;
    }
    for (const r of waterImpactRipples) {
        if (r?.role !== 'castle' || !r.mesh) continue;
        r.mesh.visible = false;
    }
    for (const wm of bridgeLibraryWaterSurfaces) {
        const role = wm?.userData?.waterRole || 'bridge';
        if (role === 'castle' && wm) wm.visible = false;
    }
    if (typeof moatReflector !== 'undefined' && moatReflector) moatReflector.visible = false;
    for (const m of castleSceneMeshes) {
        if (m) m.visible = false;
    }
    updateTotalBricksUi();

    for (const npc of npcList) {
        if (!npc.storyRole) npc.storyRole = 'castle';
        setNpcStoryDormant(npc, true);
    }

    if (ballista) {
        ballista.storyDormant = true;
        ballista.group.visible = false;
    }

    setStoryHud('Bridge Dev: rebuilt design — thick arches, stone road, battlements, stair approaches');
}

function beginStoryModeRound() {
    _applyGroundMaterial(grassMat);  // restore textured grass for any non-bridge2 level
    setTemplateGroundOverrideActive(false);
    bridge2ModeActive = false;
    applyRandomSeason();   // every level/round rolls a fresh season + weather

    if (bridgeDevLevelEnabled) {
        beginBridgeDevLevel();
        return;
    }

    if (bridge2LevelEnabled) {
        beginBridge2TemplateLevel();
        return;
    }

    if (templateLevelEnabled) {
        beginTemplateSandboxLevel();
        return;
    }

    // Guard-disable mode should not force a castle fallback. Keep bridge
    // routing intact and use non-campaign bridge sandbox when guards are off.
    const storyRequested = storyModePreference && !twoPlayerMode;
    if (storyRequested) {
        beginBridgeStage(!guardsDisabled);
        return;
    }

    storyCampaignActive = false;
    if (levelPreference === 'bridge') {
        beginBridgeStage(false);
        return;
    }

    storyModeEnabled = false;
    storyStage = 0;
    updateTotalBricksUi();
    setStoryBridgeSuppressed(true);
    setStoryCastleSuppressed(false);
    for (const npc of npcList) {
        if (!npc.storyRole) npc.storyRole = 'castle';
        setNpcStoryDormant(npc, npc.storyRole === 'bridge');
    }
    if (ballista) {
        ballista.storyDormant = false;
        ballista.group.visible = true;
    }
    setStoryHud('');
}

// Returns the effective floor Y for the editor: ground (PLAYER_BASE_Y) or on top of a placed brick.
function getEditorFloorY(px, pz) {
    let bestTop = 0;
    const pw = 0.35;
    for (const b of bricks) {
        if (!b.body || b.body.position.y < -100) continue;
        const bhx = (b.isZ || b.isY || b.isCube) ? 0.5 : 1.0;
        const bhy = b.isY ? 1.0 : 0.5;
        const bhz = b.isZ ? 1.0 : 0.5;
        if (Math.abs(b.body.position.x - px) < bhx + pw &&
            Math.abs(b.body.position.z - pz) < bhz + pw) {
            const top = b.body.position.y + bhy;
            if (top > bestTop && top < camera.position.y + 0.5) bestTop = top;
        }
    }
    return bestTop + PLAYER_BASE_Y;
}

// Player floor over the story-bridge masonry: lets the player walk ON the
// road deck / ramps (and their rubble) instead of clipping through the
// bridge. Only scans bricks while inside the bridge road footprint.
function getPlayerFloorY(px, pz) {
    if (window.__editorActive) return getEditorFloorY(px, pz);
    // King's Bunker descent: the stairwell/tunnel/chamber floor is walkable;
    // the drained moat trench becomes walkable once the king pulls the switch.
    const bunkerEye = bunkerEyeYAt(px, pz, camera.position.y);
    if (bunkerEye != null) return bunkerEye;
    if (castleMoatDrained && isInCastleMoatRingXZ(px, pz, PLAYER_WATER_EDGE_BUFFER_CASTLE)) return -MOAT_DEPTH + PLAYER_BASE_Y;
    // Bridge-level only: the road footprint z-band overlaps the castle in
    // castle stage, where stepping onto wall masonry is not wanted.
    if (getActiveStoryRole() !== 'bridge') return PLAYER_BASE_Y;
    const spanX = STORY_BRIDGE_DECK_HALF + STORY_BRIDGE_RAMP_START_OFFSET + STORY_BRIDGE_RAMP_LEN + 2.5;
    if (Math.abs(px) > spanX || Math.abs(pz - STORY_BRIDGE_Z) > 4.2) return PLAYER_BASE_Y;
    const feetY = camera.position.y - PLAYER_BASE_Y;
    const maxStepTop = feetY + 1.15;   // can mount one brick course per step
    let bestTop = 0;
    const pw = 0.35;
    for (const b of getFrameActiveBricks()) {
        if (!b.body || b.isWedge) continue;
        const p = b.body.position;
        if (p.y < -2 || p.y > feetY + 2.5) continue;
        const bhx = (b.isZ || b.isY || b.isCube) ? 0.5 : 1.0;
        if (Math.abs(p.x - px) >= bhx + pw) continue;
        const bhz = b.isZ ? 1.0 : 0.5;
        if (Math.abs(p.z - pz) >= bhz + pw) continue;
        const bhy = b.isSlab ? 0.25 : (b.isY ? 1.0 : 0.5);
        const top = p.y + bhy;
        if (top > bestTop && top <= maxStepTop) bestTop = top;
    }
    return bestTop + PLAYER_BASE_Y;
}

function beginTemplateSandboxLevel() {
    clearEditorTrenches();
    clearEditorDecor();
    bridge2ModeActive = false;
    storyModeEnabled = false;
    storyCampaignActive = false;
    storyStage = 0;
    bridgeStageCompletePendingAdvance = false;
    bridgeStageClearPendingAt = 0;
    bridgeStageClearCalmSince = 0;

    // Hide the main-menu modal if it is still visible (e.g. when launched from the level editor).
    // Looked up lazily: the `difficultyModal` const is declared later in this module, and the
    // editor can call this synchronously during module init (TDZ ReferenceError would abort boot).
    const _diffModal = document.getElementById('difficultyModal');
    if (_diffModal) _diffModal.classList.add('hidden');
    _gameStarted = true;

    setStoryBridgeSuppressed(true);
    setStoryCastleSuppressed(true);
    setTemplateGroundOverrideActive(true);
    updateTotalBricksUi();

    camera.position.set(0, PLAYER_BASE_Y, -20);
    yaw = Math.PI;
    pitch = 0.05;

    for (const npc of npcList) {
        if (!npc.storyRole) npc.storyRole = 'castle';
        setNpcStoryDormant(npc, true);
    }

    if (ballista) {
        ballista.storyDormant = true;
        ballista.group.visible = false;
    }

    setStoryHud('Level 3: Empty grass template');
}

function advanceToCastleStage() {
    bridge2ModeActive = false;
    storyStage = 2;
    applyRandomSeason();   // castle stage rolls its own season/weather
    updateTotalBricksUi();
    bridgeStageCompletePendingAdvance = false;
    bridgeStageClearPendingAt = 0;
    bridgeStageClearCalmSince = 0;
    setStoryBridgeSuppressed(true);
    setStoryCastleSuppressed(false);
    for (const npc of npcList) {
        if (npc.storyRole === 'castle' || npc.storyRole === 'castleKing') {
            setNpcStoryDormant(npc, false);
        } else if (npc.storyRole === 'bridge') {
            setNpcStoryDormant(npc, true);
        }
    }
    if (ballista) {
        ballista.storyDormant = false;
        ballista.group.visible = true;
        if (ballista.state === 'abandoned') {
            ballista.state = 'hidden';
            ballista.fireTimer = ballista.firstShotDelay;
        }
    }
    _npcAggroTriggered = false;
    _hutChargerTriggered = false;
    const alive = countAliveStoryNpcs('castle');
    setStoryHud(`Story 2/2: Rob the King's bunker — find the key in the old hut${alive > 0 ? ` · ${alive} guards` : ''}`);
}

function updateStoryBridgeConvoy(dt) {
    if (!storyModeEnabled || storyStage !== 1) return;
    for (const npc of npcList) {
        if (npc.isRagdoll || !npc.storyBridgeWalker || npc.storyDormant) continue;
        if (npc.isTowerGuard) npc.isTowerGuard = false;
        const gp = npc.group.position;
        if (!npc.npcPanicSwim) {
            const waterY = getWaterSurfaceYAtXZ(gp.x, gp.z, false);
            if (waterY != null && gp.y <= waterY + 0.55) {
                beginNpcPanicSwim(npc, 'bridge-slip');
            }
        }
        if (updateNpcPanicSwim(npc, dt)) continue;

        const minX = npc.storyBridgeMinX ?? (-STORY_BRIDGE_APPROACH_X);
        const maxX = npc.storyBridgeMaxX ?? (STORY_BRIDGE_APPROACH_X);

        const laneOffset = gp.z - STORY_BRIDGE_Z;
        const offRoad = Math.abs(laneOffset) > 2.2;
        const needsRecentre = offRoad || isInStoryBridgeWaterXZ(gp.x, gp.z);

        // One-way crossing: ground -> ramp -> bridge -> far ramp -> pursue player.
        // Speed and Z-scatter are boosted by drone proximity, player proximity, and nearby shots.
        const droneNearby = !!(activeDrone && !activeDrone.detonated);
        if (droneNearby) {
            const dp = activeDrone.body.position;
            const ddx = gp.x - dp.x, ddy = gp.y - dp.y, ddz = gp.z - dp.z;
            const droneDist2 = ddx*ddx + ddy*ddy + ddz*ddz;
            if (droneDist2 < DRONE_FEAR_RADIUS * DRONE_FEAR_RADIUS) {
                const fearStr = 1 - Math.sqrt(droneDist2) / DRONE_FEAR_RADIUS;
                npc.droneFear = Math.min(1, (npc.droneFear || 0) + fearStr * dt * 3.5);
                // Smooth sine-wave weave — dt keeps it frame-rate independent
                npc._panicWeave = (npc._panicWeave || 0) + dt * (5 + fearStr * 4);
                gp.z += Math.sin(npc._panicWeave) * 1.8 * (npc.droneFear || 0) * dt;
                if (droneDist2 < 7 * 7) gp.z += (Math.random() - 0.5) * 3.0 * (npc.droneFear || 0) * dt;
                // Panic taunt
                npc.droneTauntCooldown = Math.max(0, (npc.droneTauntCooldown || 0) - dt);
                if ((npc.droneFear || 0) > 0.18 && (npc.droneTauntCooldown || 0) <= 0 && Math.random() < 0.008) {
                    const pNow = performance.now();
                    if (pNow - _npcGlobalTauntMs >= 1600) {
                        _npcGlobalTauntMs = pNow;
                        spawnNpcTaunt(npc, DRONE_FEAR_TAUNTS[(Math.random() * DRONE_FEAR_TAUNTS.length) | 0]);
                        npc.droneTauntCooldown = 2.8 + Math.random() * 2.0;
                    }
                }
            } else {
                npc.droneFear = Math.max(0, (npc.droneFear || 0) - dt * 0.6);
            }
        } else {
            npc.droneFear = Math.max(0, (npc.droneFear || 0) - dt * 0.8);
        }

        // Player proximity: gentle Z dodge + occasional taunt.
        const camDx = camera.position.x - gp.x;
        const camDz = camera.position.z - gp.z;
        const playerDist2 = camDx*camDx + camDz*camDz;
        const playerFear = playerDist2 < 18*18 ? (1 - Math.sqrt(playerDist2) / 18) : 0;
        if (playerFear > 0.05 && !npc.storyBridgeFalling) {
            const awayZ = (gp.z >= camera.position.z) ? 1 : -1;
            gp.z += awayZ * playerFear * 1.0 * dt;
            npc._playerTauntCooldown = Math.max(0, (npc._playerTauntCooldown || 0) - dt);
            if (playerFear > 0.3 && (npc._playerTauntCooldown || 0) <= 0 && Math.random() < 0.006) {
                const pNow = performance.now();
                if (pNow - _npcGlobalTauntMs >= 2000) {
                    _npcGlobalTauntMs = pNow;
                    spawnNpcTaunt(npc, TOWER_GUARD_TAUNTS[(Math.random() * TOWER_GUARD_TAUNTS.length) | 0]);
                    npc._playerTauntCooldown = 4 + Math.random() * 3;
                }
            }
        }

        // Near-miss cannonball: single startle impulse that decays (not per-frame random).
        let shotNear = false;
        for (const cb of cannonballs) {
            if (cb._spent) continue;
            const bx = cb.body.position.x - gp.x, bz = cb.body.position.z - gp.z;
            if (bx*bx + bz*bz < 7*7) { shotNear = true; break; }
        }
        if (shotNear && !(npc._bridgeStartleActive)) {
            npc._bridgeStartleActive = true;
            npc._bridgeStartleDir = (gp.z > STORY_BRIDGE_Z ? 1 : -1) * (1.5 + Math.random());
            npc._bridgeStartleDecay = 1.2;
            npc._shotTauntCooldown = Math.max(0, (npc._shotTauntCooldown || 0) - dt);
            if ((npc._shotTauntCooldown || 0) <= 0 && Math.random() < 0.5) {
                const pNow = performance.now();
                if (pNow - _npcGlobalTauntMs >= 1200) {
                    _npcGlobalTauntMs = pNow;
                    spawnNpcTaunt(npc, TOWER_GUARD_TAUNTS[(Math.random() * TOWER_GUARD_TAUNTS.length) | 0]);
                    npc._shotTauntCooldown = 2.5 + Math.random() * 2;
                }
            }
        } else if (!shotNear) {
            npc._bridgeStartleActive = false;
        }
        if ((npc._bridgeStartleDecay || 0) > 0) {
            npc._bridgeStartleDecay = Math.max(0, npc._bridgeStartleDecay - dt * 2);
            gp.z += (npc._bridgeStartleDir || 0) * npc._bridgeStartleDecay * dt;
        }

        let panicSpeedMul = 1
            + Math.min(1, (npc.droneFear || 0)) * 2.2
            + playerFear * 1.2
            + (shotNear ? 1.5 : 0);
        gp.x += (npc.storyBridgeSpeed || 1.3) * panicSpeedMul * dt;
        if (gp.x > maxX) gp.x = maxX;
        if (needsRecentre) {
            const recenterRate = 3.6;
            gp.z += (STORY_BRIDGE_Z - gp.z) * Math.min(1, dt * recenterRate);
            const nearRamp = Math.abs(gp.x) > (STORY_BRIDGE_DECK_HALF + STORY_BRIDGE_RAMP_START_OFFSET - 1.5);
            const roadHalfZ = nearRamp ? 1.8 : 2.05;
            gp.z = THREE.MathUtils.clamp(gp.z, STORY_BRIDGE_Z - roadHalfZ, STORY_BRIDGE_Z + roadHalfZ);
            npc.storyBridgeVy = Math.min(0, npc.storyBridgeVy || 0);
        }

        const analyticalY = bridgeWalkerSurfaceY(gp.x);
        // Extend span to full approach zone so there's no falling gap before handoff.
        const inBridgeSpan = Math.abs(gp.x) < STORY_BRIDGE_APPROACH_X + 0.5;
        const scanY = inBridgeSpan ? storyBridgeSupportY(gp.x, gp.z, gp.y) : null;
        // Use analytical Y directly — no scanY cap that causes bobbing between
        // slab-bearing tops (4.5 m) and deck-board tops (5.5 m).
        // Scan only determines structural integrity: null → hole → NPC falls.
        const supportY = (inBridgeSpan && analyticalY >= 0)
            ? (scanY != null ? analyticalY : null)
            : null;
        if (supportY != null) {
            npc.storyBridgeFalling = false;
            npc.storyBridgeVy = Math.max(0, npc.storyBridgeVy || 0);
            gp.y = THREE.MathUtils.lerp(gp.y, supportY, Math.min(1, dt * 10));
        } else {
            if (!npc.storyBridgeFalling) {
                npc.storyBridgeFalling = true;
                npc.storyBridgeFallStartY = gp.y;
                npc.storyBridgeVy = 0;
            }
            npc.storyBridgeVy = (npc.storyBridgeVy || 0) - 14 * dt;
            gp.y += npc.storyBridgeVy * dt;

            const onLeftApproachGround = gp.x < (-STORY_BRIDGE_DECK_HALF - STORY_BRIDGE_RAMP_START_OFFSET + 0.4);
            const fallWaterY = getWaterSurfaceYAtXZ(gp.x, gp.z, true);
            const groundY = onLeftApproachGround
                ? npcGroundY(gp.x, gp.z)
                : ((fallWaterY != null) ? fallWaterY : npcGroundY(gp.x, gp.z));
            if (gp.y <= groundY) {
                const drop = (npc.storyBridgeFallStartY || gp.y) - groundY;
                gp.y = groundY;
                npc.storyBridgeVy = 0;
                npc.storyBridgeFalling = false;
                if (drop > 2.8) {
                    const waterY = getWaterSurfaceYAtXZ(gp.x, gp.z, false);
                    if (waterY != null && beginNpcPanicSwim(npc, 'bridge-drop')) {
                        continue;
                    }
                    activateRagdoll(npc, null);
                    continue;
                }
            }
        }

        if (!npc.storyBridgeFalling && !needsRecentre && maybeTripNpcOnRubble(npc, dt)) {
            continue;
        }

        npc.group.rotation.y = Math.PI / 2 + THREE.MathUtils.clamp((STORY_BRIDGE_Z - gp.z) * 0.18, -0.32, 0.32);

        // Walking animation (skipped by the main walker pass which filters out storyBridgeWalker).
        if (npc.anim && !npc.storyBridgeFalling) {
            npc.walkTime = (npc.walkTime || 0) + dt;
            const swing = Math.sin(npc.walkTime * 4.5) * 0.55;
            npc.anim.legL.rotation.x =  swing;
            npc.anim.legR.rotation.x = -swing;
            npc.anim.armL.rotation.x = -1.05 - swing * 0.20;
            npc.anim.armR.rotation.x = -1.05 + swing * 0.20;
        }
        npc.tauntCooldown = Math.max(0, (npc.tauntCooldown || 0) - dt);
        if (!npc.storyBridgeFalling) {
            tryNpcTaunt(npc, TOWER_GUARD_TAUNTS[(Math.random() * TOWER_GUARD_TAUNTS.length) | 0]);
        }

        if (gp.x >= maxX - 0.05) {
            // Handoff: now use the normal NPC walker/chase logic.
            npc.storyBridgeWalker = false;
            npc.walking = true;
            npc.clearedBridge = true;
            npc.bridgeTurnLock = false;
            npc.waypoints = [
                { x: gp.x, z: STORY_BRIDGE_Z - 2.0 },
            ];
            npc.walkDelay = Math.random() * 0.45;
        }
    }
}

function updateStoryProgression() {
    if (bridge2ModeActive) return;
    if (!storyModeEnabled || gameOver || !(_gameStarted || _hasPlayed) || guardsDisabled) return;

    if (storyStage === 1) {
        if (bridgeStageCompletePendingAdvance) return;
        const aliveBridge = countAliveStoryNpcs('bridge');
        if (aliveBridge > 0) {
            bridgeStageClearPendingAt = 0;
            bridgeStageClearCalmSince = 0;
            setStoryHud(storyCampaignActive
                ? `Story 1/2: Shatter the bridge crossing (${aliveBridge} left)`
                : `Bridge Level: Break the crossing defenders (${aliveBridge} left)`);
        } else if (storyBridgeHadNpcWave) {
            const now = performance.now();
            if (bridgeStageClearPendingAt <= 0) {
                bridgeStageClearPendingAt = now;
                bridgeStageClearCalmSince = 0;
            }
            const elapsedMs = now - bridgeStageClearPendingAt;
            const ballsDone = cannonballs.length === 0;
            const awakeCount = countAwakeDynamicBodies(BRIDGE_CLEAR_CALM_AWAKE_LIMIT + 1);
            const calmNow = ballsDone && awakeCount <= BRIDGE_CLEAR_CALM_AWAKE_LIMIT;
            if (calmNow) {
                if (bridgeStageClearCalmSince <= 0) bridgeStageClearCalmSince = now;
            } else {
                bridgeStageClearCalmSince = 0;
            }
            const longEnough = elapsedMs >= BRIDGE_CLEAR_MIN_DELAY_MS;
            const calmHeld = bridgeStageClearCalmSince > 0 && (now - bridgeStageClearCalmSince) >= BRIDGE_CLEAR_CALM_HOLD_MS;
            const timedOut = elapsedMs >= BRIDGE_CLEAR_MAX_DELAY_MS;
            if (longEnough && (calmHeld || timedOut)) {
                showBridgeStageEndBanner();
            } else {
                setStoryHud(storyCampaignActive
                    ? 'Story 1/2: Last guard down - hold the line...'
                    : 'Bridge Level: Last guard down - hold the line...');
            }
        } else {
            bridgeStageClearPendingAt = 0;
            bridgeStageClearCalmSince = 0;
            setStoryHud(storyCampaignActive
                ? 'Story 1/2: Bridge tunnel sandbox (NPCs disabled)'
                : 'Bridge Level: Tunnel sandbox (NPCs disabled)');
        }
        return;
    }

    if (storyStage === 2) {
        // The heist: rob all 10 coins and get back above ground. Guards are a
        // hazard, not a requirement — killing them does not end the stage.
        const coinsLeft = BUNKER_COIN_TOTAL - bunkerCoinsCollected;
        if (coinsLeft === 0 && bunkerEverEntered && bunkerState.phase === 'above') {
            bunkerHeistWin = true;
            storyStage = 3;
            showGameOver(false, true);
            return;
        }
        const aliveCastle = countAliveStoryNpcs('castle');
        const guardsNote = aliveCastle > 0 ? ` · ${aliveCastle} guards` : '';
        let obj;
        if (bunkerState.phase === 'inside' && bunkerFlooding) obj = 'Get out — the bunker is flooding!';
        else if (bunkerState.phase !== 'above' && coinsLeft > 0) obj = `Rob the King's bunker (${coinsLeft} coin${coinsLeft === 1 ? '' : 's'} left)`;
        else if (coinsLeft === 0) obj = 'Escape the bunker!';
        else if (bunkerEverEntered) obj = `Back to the bunker (${coinsLeft} coins left)`;
        else if (!hasKey && trapdoor && trapdoor.state === 'locked') obj = 'Find the bunker key — last seen in the old hut';
        else obj = 'Open the courtyard trapdoor';
        setStoryHud(obj + guardsNote);
    }
}

function showBridgeStageEndBanner() {
    if (bridgeStageCompletePendingAdvance) return;
    bridgeStageCompletePendingAdvance = true;
    bridgeStageClearPendingAt = 0;
    bridgeStageClearCalmSince = 0;
    storyStage = 1;
    gameOverPending = false;
    setPaused(true);
    setStoryHud('Bridge Cleared');
    if (document.pointerLockElement === renderer.domElement) {
        document.exitPointerLock();
    }

    const go = document.getElementById('gameOver');
    const goMsg = document.getElementById('goMsg');
    const goScores = document.getElementById('goScores');
    const goBestEl = document.getElementById('goBest');
    if (go) go.style.display = 'flex';
    if (goBestEl) goBestEl.style.display = 'none';
    if (goRetryBtn) goRetryBtn.textContent = 'Next Level';
    if (goMenuBtn) goMenuBtn.textContent = 'Menu';

    const bestDamageText = bestShotDamage.toFixed(1);
    const eff = shotsFired > 0 ? (bricksDestroyed / shotsFired) : 0;
    if (goMsg) goMsg.textContent = 'Bridge Secured';
    if (goScores) {
        goScores.textContent =
            `Score ${score} � Bricks ${bricksDestroyed} � Shots ${shotsFired} � Best Shot Damage ${bestDamageText} � Efficiency ${eff.toFixed(2)} bricks/shot`;
    }
}

function showGameOver(killedByArrows = false, storyVictory = false, defeatReason = '') {
    gameOver = true;
    gameOverPending = false;
    gameOverPendingAt = 0;
    gameOverCalmSec = 0;
    if (defeatReason) playerDefeatReason = defeatReason;
    if (!storyVictory) setStoryHud('');
    if (document.pointerLockElement === renderer.domElement) {
        document.exitPointerLock();
    }
    document.getElementById('gameOver').style.display = 'flex';
    if (goRetryBtn) goRetryBtn.textContent = 'Retry';
    if (goMenuBtn) goMenuBtn.textContent = 'Menu';
    const mode = twoPlayerMode ? '2p' : '1p';
    const goBestEl = document.getElementById('goBest');
    goBestEl.style.display = 'none';
    if (playerDefeatReason === 'drowned' || playerDefeatReason === 'drowned-bunker') {
        document.getElementById('goMsg').textContent = playerDefeatReason === 'drowned-bunker' ? "Drowned in the King's bunker" : 'Drowned in the moat';
        document.getElementById('goScores').textContent = `You slipped into the water and sank after ${Math.max(0.1, playerWaterLastDurationSec).toFixed(1)} seconds. Score: ${score} pts`;
        recordHighScore(currentDifficulty, mode, twoPlayerMode ? Math.max(score, p2Score) : score);
    } else if (killedByArrows) {
        document.getElementById('goMsg').textContent = '\u2694\ufe0f Slain by the castle guards!';
        document.getElementById('goScores').textContent = `Hit 3 times before the walls fell. Score: ${score} pts`;
        recordHighScore(currentDifficulty, mode, twoPlayerMode ? Math.max(score, p2Score) : score);
    } else if (twoPlayerMode) {
        const winner = score > p2Score ? 'Player 1 Wins! \uD83C\uDFC6' :
                       p2Score > score ? 'Player 2 Wins! \uD83C\uDFC6' : "It's a Tie!";
        document.getElementById('goMsg').textContent = winner;
        const best = recordHighScore(currentDifficulty, mode, Math.max(score, p2Score));
        document.getElementById('goScores').textContent =
            `P1: ${score} pts  |  P2: ${p2Score} pts  \u2022  ${difficultyName(currentDifficulty)} best: ${best}`;
    } else if (storyVictory) {
        if (bunkerHeistWin) {
            document.getElementById('goMsg').textContent = 'The King\'s gold is yours!';
            document.getElementById('goScores').textContent =
                `Bunker robbed clean • ${bricksDestroyed} bricks destroyed in ${shotsFired} shots` +
                (king && king.isRagdoll ? ' • and the King is dead' : ' • and the King never saw it coming');
        } else {
            document.getElementById('goMsg').textContent = 'Bridge Broken. Castle Fallen.';
            document.getElementById('goScores').textContent =
                `All defenders eliminated � ${bricksDestroyed} bricks destroyed in ${shotsFired} shots`;
        }
        setStoryHud('Story Complete');
    } else {
        const prevBest = getHighScore(currentDifficulty, mode);
        const best = recordHighScore(currentDifficulty, mode, score);
        const isNew = score > 0 && score >= best && score > prevBest;
        goBestEl.style.display = isNew ? 'inline-block' : 'none';
        document.getElementById('goScores').textContent =
            `${bricksDestroyed} bricks destroyed in ${shotsFired} shots  \u2022  ${difficultyName(currentDifficulty)} best: ${best}`;
        // Count-up reveal of the final score for a little drama.
        _countUp(score, 900, v => {
            document.getElementById('goMsg').textContent =
                (isNew ? '\uD83C\uDFC6 New Best! ' : 'Final Score: ') + `${v} pts`;
        });
    }
}

function retryCurrentLevel() {
    if (bridgeStageCompletePendingAdvance) {
        try {
            sessionStorage.setItem('castleRetry', JSON.stringify({
                diff: currentDifficulty,
                mode: '1p',
                storyPref: 'classic',
                levelPref: 'castle'
            }));
        } catch (e) {}
        location.reload();
        return;
    }
    try {
        sessionStorage.setItem('castleRetry', JSON.stringify({
            diff: currentDifficulty,
            mode: twoPlayerMode ? '2p' : '1p',
            storyPref: storyModePreference ? 'story' : 'classic',
            levelPref: levelPreference
        }));
    } catch (e) {}
    location.reload();
}

function returnToMenu() {
    bridgeStageCompletePendingAdvance = false;
    try { sessionStorage.removeItem('castleRetry'); } catch (e) {}
    location.reload();
}

window.retryCurrentLevel = retryCurrentLevel;
window.returnToMenu = returnToMenu;

// Animate an integer from 0 ? target with ease-out, calling render(value) each frame.
function _countUp(target, durationMs, render) {
    if (target <= 0) { render(0); return; }
    const start = performance.now();
    function tick(now) {
        const t = Math.min(1, (now - start) / durationMs);
        const eased = 1 - Math.pow(1 - t, 3);
        render(Math.round(target * eased));
        if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

function checkGameOver() {
    if (storyModeEnabled && !twoPlayerMode) return;
    const diff = DIFFICULTIES[currentDifficulty];
    if (diff && diff.killWin) {
        // Extreme mode: win when every enemy is down
        if (npcList.length === 0 || !npcList.every(n => n.isRagdoll)) return;
    } else {
        const p1Done = p1Ammo.every(a => a === 0);
        const p2Done = !twoPlayerMode || p2Ammo.every(a => a === 0);
        if (!p1Done || !p2Done) return;
    }
    // Wait for any in-flight balls to land before showing the overlay
    if (!gameOverPending) {
        gameOverPending = true;
        gameOverPendingAt = performance.now();
        gameOverCalmSec = 0;
    }
}

function applyGuardDisableMode() {
    if (!guardsDisabled) return;

    for (const a of arrows) scene.remove(a.mesh);
    arrows.length = 0;
    for (const b of ballistaBolts) scene.remove(b.mesh);
    ballistaBolts.length = 0;
    clearBallistaEncounter();

    for (const npc of npcList) {
        if (npc.triggerBody && npc.triggerBody.world) {
            npc.triggerBody.world.removeBody(npc.triggerBody);
            npc.triggerBody = null;
        }
        if (npc.isRagdoll) {
            cleanupNpcRagdoll(npc);
            npc.isRagdoll = false;
        }
        if (npc.group) scene.remove(npc.group);
    }
    npcList.length = 0;
    _npcAggroTriggered = true;
    _hutChargerTriggered = true;
}

function setWeapon(idx) {
    if (activeDrone) return;  // cannot switch weapons while piloting drone
    const N = WEAPONS.length;
    let w = ((idx % N) + N) % N;
    // Skip weapons where both players are empty (or P1 only in 1P mode)
    for (let tries = 0; tries < N; tries++) {
        const p1e = p1Ammo[w] === 0;
        const p2e = !twoPlayerMode || p2Ammo[w] === 0;
        if (!p1e || !p2e) break;
        w = (w + 1) % N;
    }
    currentWeapon = w;
    document.querySelectorAll('.wBtn').forEach((b,i) =>
        b.classList.toggle('active', i === currentWeapon));
    // Weapon-aware crosshair (colour / gap / minigun ring)
    const _ch = document.getElementById('crosshair');
    if (_ch) _ch.className = 'w' + w;
    // Swap viewmodels across all six weapons.
    vmBarrel.visible       = (w === WEAPON_IDX_CANNON || w === WEAPON_IDX_EXPLOSIVE);
    vmShotgunGroup.visible = (w === WEAPON_IDX_SHOTGUN);
    vmMortarGroup.visible  = (w === WEAPON_IDX_MORTAR);
    vmMinigunGroup.visible = (w === WEAPON_IDX_MINIGUN);
    vmSniperGroup.visible  = (w === WEAPON_IDX_SNIPER);
    if (w !== WEAPON_IDX_MINIGUN) minigunFiring = false;
    if (w !== WEAPON_IDX_SHOTGUN) {
        shotgunShotKick = 0;
        shotgunBreakAnim = 0;
        shotgunEjectAnim = 0;
        shotgunEjectTriggered = false;
        vmShotgunShellL.visible = true;
        vmShotgunShellR.visible = true;
        vmShotgunEjectL.visible = false;
        vmShotgunEjectR.visible = false;
        vmShotgunTopLeverPivot.rotation.x = 0;
    }
    if (w !== WEAPON_IDX_SNIPER) {
        sniperAiming = false;
        touchControls.sniperAimHeld = false;
        camera.fov = NORMAL_FOV;
        camera.updateProjectionMatrix();
        const scopeEl = document.getElementById('scopeOverlay');
        if (scopeEl) scopeEl.style.display = 'none';
    }
    const min = parseFloat(powerSlider.min);
    const max = parseFloat(powerSlider.max);
    const savedPower = weaponPowerByIndex[w];
    const nextPower = Number.isFinite(savedPower) ? Math.max(min, Math.min(max, savedPower)) : max;
    powerSlider.value = String(nextPower);
    powerVal.textContent = powerSlider.value;
    updateMobileSniperAimButton();
    pitch = clampAimPitch(pitch);
    p2Pitch = clampAimPitch(p2Pitch);
    updateUI();
}

// Blast: wake + impulse bricks within radius, spawn big explosion
// blastOpts.tumbleOnly = true  ? NPCs ragdoll as a connected tumble (grenade/cluster)
//                       false ? violent explosive scatter (mortar/explosive/drone)
function triggerBlast(pos, radius, blastOpts = {}) {
    const r2 = radius * radius;
    const px = pos.x, py = pos.y, pz = pos.z;
    // Record for NPC danger-taunt gate.
    _lastImpactMs = performance.now();
    _lastImpactPos.x = px; _lastImpactPos.z = pz;
    spawnExplosion(pos);
    spawnExplosion(new THREE.Vector3(px, py + 0.5, pz));  // double cloud
    playExplosionBlast(radius);
    playImpact(Math.min(1, 0.72 + radius / 12), 'explosive');
    if (Math.random() < 0.35) playStoneCrackAccent(1.0 + radius * 0.05);

    // Big flash
    popFlash(px, py, pz, 0xff8800, 200, radius * 3, 180);

    // Camera shake scaled by how close the blast is to the player.
    const _cdx = camera.position.x - px, _cdy = camera.position.y - py, _cdz = camera.position.z - pz;
    const _cd = Math.sqrt(_cdx*_cdx + _cdy*_cdy + _cdz*_cdz);
    addShake(Math.max(0.18, 0.9 * Math.max(0, 1 - _cd / 60)));

    // Settled bridge masonry gets a tighter wake radius: the bridge deck is a
    // long precarious span, and waking its full blast radius unzips the whole
    // bridge from one explosive. Local breach only � sleeping bridge bricks
    // outside ~58% of the radius stay asleep.
    const bridgeWakeR2 = (radius * 0.58) * (radius * 0.58);
    for (const b of bricks) {
        if (isBrickInInactiveStoryLevel(b)) continue;
        const dx = b.body.position.x - px;
        const dy = b.body.position.y - py;
        const dz = b.body.position.z - pz;
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 > r2) continue;
        const isBridgeBrick = b.body._storyRole === 'bridge';
        if (d2 > bridgeWakeR2
            && isBridgeBrick
            && b.body.sleepState === 2) continue;
        b.body.wakeUp();
        const dist  = Math.sqrt(d2) + 0.01;
        const fall = 1 - dist / radius;
        // Bridge masonry: quadratic falloff + reduced magnitude so blast energy
        // stays in the breach instead of shoving the whole deck sideways.
        let force = isBridgeBrick
            ? fall * fall * 13000 * 0.55
            : fall * 13000;
        // Off-centre apply-point encourages rotation (toppling) over translation
        const torqueOff = new CANNON.Vec3(
            (Math.random() - 0.5) * BS.h,
            (Math.random() - 0.5) * BS.h,
            (Math.random() - 0.5) * BS.h
        );
        // Purely radial impulse -- no fixed upward boost.
        // Bricks above blast go up slightly, bricks below go down -- no lofting.
        b.body.applyImpulse(
            new CANNON.Vec3(
                dx/dist * force,
                dy/dist * force * 0.35,
                dz/dist * force
            ),
            torqueOff
        );
        // Hard linear + angular velocity caps.
        // Linear: bricks can topple but can't carry cascade energy to a distant tower.
        // Angular: spinning bricks are the hidden cascade carrier � cap them too.
        // Bridge bricks get lower caps + heavier damping so flying debris
        // cannot re-wake the deck far down the span.
        const maxSpd = isBridgeBrick ? 8.5 : 14;
        const maxSpin = isBridgeBrick ? 4.5 : 7;
        const v = b.body.velocity;
        const spd2 = v.x*v.x + v.y*v.y + v.z*v.z;
        if (spd2 > maxSpd * maxSpd) {
            const s = maxSpd / Math.sqrt(spd2);
            b.body.velocity.set(v.x*s, v.y*s, v.z*s);
        }
        const av = b.body.angularVelocity;
        const aspd2 = av.x*av.x + av.y*av.y + av.z*av.z;
        if (aspd2 > maxSpin * maxSpin) {
            const as = maxSpin / Math.sqrt(aspd2);
            b.body.angularVelocity.set(av.x*as, av.y*as, av.z*as);
        }
        if (isBridgeBrick) {
            b.body.linearDamping = Math.max(b.body.linearDamping, 0.48);
            b.body.angularDamping = Math.max(b.body.angularDamping, 0.72);
        }
    }

    // (Shockwave wake removed � it woke bricks far outside blast radius causing chain reactions)

    // Blast also ragdolls nearby active NPCs, but never dormant/hidden story NPCs.
    if (!bridge2ModeActive) {
        const NPC_BLAST_R2 = radius * radius;
        const tumbleOnly = !!blastOpts.tumbleOnly;
        for (const npc of npcList) {
            if (npc.isRagdoll || npc.storyDormant || !npc.group || !npc.group.visible) continue;
            const nx = npc.group.position.x - px;
            const ny = (npc.group.position.y + 1.1) - py;
            const nz = npc.group.position.z - pz;
            if (nx*nx + ny*ny + nz*nz < NPC_BLAST_R2) {
                if (tumbleOnly) {
                    // Grenade / cluster: connected ragdoll tumble � no scatter
                    activateRagdoll(npc, null, false, null);
                } else {
                    const ragdollOpts = getNpcBlastFlingOptions(npc, px, pz);
                    activateRagdoll(npc, null, true, ragdollOpts);
                }
            }
        }
        // Blast also angers nearby NPCs (wider radius than ragdoll).
        markNpcAngry(px, pz, 0.55, radius * 2.8);
    }
}

// Raise anger for all NPCs within radius of an impact position.
function markNpcAngry(px, pz, strength, radius) {
    const r2 = radius * radius;
    for (const npc of npcList) {
        if (npc.isRagdoll || !npc.group) continue;
        const gp = npc.group.position;
        const dx = gp.x - px, dz = gp.z - pz;
        if (dx * dx + dz * dz > r2) continue;
        npc.angerLevel = Math.min(1.0, (npc.angerLevel || 0) + strength);
        // Shorten per-NPC cooldown so an angry NPC can speak up sooner.
        if (npc.angerLevel > 0.35 && (npc.tauntCooldown || 0) > 6)
            npc.tauntCooldown = 3 + Math.random() * 4;
    }
}
// === Cannonballs ===
const cannonballs = [];
const BALL_RADIUS = 0.38;
const BALL_GEO = new THREE.SphereGeometry(BALL_RADIUS, 28, 28);
// Procedural worn cast-iron texture for the ball
function makeIronTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1c1c1c';
    ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 2000; i++) {
        const x = Math.random()*128, y = Math.random()*128;
        const v = (Math.random()*28)|0;
        ctx.fillStyle = `rgba(${28+v},${24+v},${20+v},0.35)`;
        ctx.fillRect(x, y, 1 + (Math.random()*2|0), 1 + (Math.random()*2|0));
    }
    // Rust patches
    for (let i = 0; i < 12; i++) {
        const x = Math.random()*128, y = Math.random()*128, r = Math.random()*6+2;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2);
        ctx.fillStyle = `rgba(${80+((Math.random()*30)|0)},${25},${5},0.18)`;
        ctx.fill();
    }
    return new THREE.CanvasTexture(canvas);
}
const BALL_MAT = new THREE.MeshStandardMaterial({
    map: makeIronTexture(),
    color: 0x2a2a2a,
    metalness: 0.88,
    roughness: 0.45,
    envMapIntensity: 2.2
});

// Mortar shells (purely visual flight, explode on ground contact)
const mortars = [];

// ============================================================
// FPV DRONE weapon
// ============================================================
// === FPV Drone motor audio ===
// Continuous oscillator-based whine that pitches up with speed.
function startDroneMotorSound() {
    if (!soundEnabled) return null;
    const ctx = getAudio();
    const now = ctx.currentTime;

    // Noise buffer � looped air turbulence source
    const noiseLen = Math.floor(ctx.sampleRate * 1.4);
    const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const noiseD = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) noiseD[i] = Math.random() * 2 - 1;

    // Primary noise: blade-air turbulence, shaped below 340 Hz
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    noiseSrc.loop = true;

    const bladeLP = ctx.createBiquadFilter();
    bladeLP.type = 'lowpass';
    bladeLP.frequency.value = 340;
    bladeLP.Q.value = 0.8;

    // Amplitude-modulate at blade-pass rate for the characteristic chop.
    // No tonal oscillator � the AM rate (~85 Hz) creates rhythm without pitch.
    const amOsc = ctx.createOscillator();
    amOsc.type = 'sine';
    amOsc.frequency.value = 85;

    const amDepth = ctx.createGain();
    amDepth.gain.value = 0.32;        // modulation depth

    const amCarrier = ctx.createGain();
    amCarrier.gain.value = 0.52;      // DC offset: gain swings 0.20 ? 0.84
    amOsc.connect(amDepth);
    amDepth.connect(amCarrier.gain);  // AudioParam modulation
    noiseSrc.connect(bladeLP);
    bladeLP.connect(amCarrier);

    // Second noise layer: air-rip mid texture
    const noiseSrc2 = ctx.createBufferSource();
    noiseSrc2.buffer = noiseBuf;
    noiseSrc2.loop = true;
    noiseSrc2.loopStart = 0.28;  // offset for variation

    const airBP = ctx.createBiquadFilter();
    airBP.type = 'bandpass';
    airBP.frequency.value = 220;
    airBP.Q.value = 1.5;

    const airGain = ctx.createGain();
    airGain.gain.value = 0.20;
    noiseSrc2.connect(airBP);
    airBP.connect(airGain);

    // Master lowpass to strip anything harsh above ~520 Hz
    const masterLP = ctx.createBiquadFilter();
    masterLP.type = 'lowpass';
    masterLP.frequency.value = 520;
    masterLP.Q.value = 0.5;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.0001, now);
    masterGain.gain.linearRampToValueAtTime(0.65, now + 0.38);

    amCarrier.connect(masterLP);
    airGain.connect(masterLP);
    masterLP.connect(masterGain);
    masterGain.connect(ctx.destination);

    amOsc.start(now);
    noiseSrc.start(now);
    noiseSrc2.start(now);

    return { amOsc, noiseSrc, noiseSrc2, masterGain };
}

function stopDroneMotorSound(motor) {
    if (!motor) return;
    try {
        const ctx = getAudio();
        const now = ctx.currentTime;
        motor.masterGain.gain.setTargetAtTime(0.0001, now, 0.06);
        setTimeout(() => {
            try { motor.amOsc.stop(); } catch (e) {}
            try { motor.noiseSrc.stop(); } catch (e) {}
            try { motor.noiseSrc2.stop(); } catch (e) {}
        }, 400);
    } catch (e) {}
}

function detonateDrone() {
    if (!activeDrone || activeDrone.detonated) return;
    activeDrone.detonated = true;
    const d = activeDrone;
    stopDroneMotorSound(d._motor);
    const pos = new THREE.Vector3(d.body.position.x, d.body.position.y, d.body.position.z);
    triggerBlast(pos, DRONE_BLAST_RADIUS);
    if (d.body.world) world.removeBody(d.body);
    scene.remove(d.group);
    activeDrone = null;
    droneVx = droneVy = droneVz = 0;
    dronePitch = droneCamPitch = droneRoll = 0;
    droneAscend = droneDescend = false;
    if (droneFpvOverlayEl) droneFpvOverlayEl.style.display = 'none';
    // Restore mobile fire button label and hide descend button
    if (mobileFireBtn) mobileFireBtn.textContent = 'FIRE';
    const _mdd2 = document.getElementById('mobileDescendBtn');
    if (_mdd2) _mdd2.style.display = 'none';
    // Queue a cinematic orbit shot of the blast in the ball cam inset
    _droneBlastPos.copy(pos);
    droneBlastReplayTimer = 3.8;
}

function fireDrone() {
    if (gameOver || p1Ammo[WEAPON_IDX_DRONE] <= 0 || activeDrone || twoPlayerMode) return;
    markSfxCombatActivity();
    p1Ammo[WEAPON_IDX_DRONE]--;
    shotsFired++;
    updateUI();
    checkGameOver();

    // Initialise heading from player orientation
    droneYaw   = yaw;
    dronePitch = -0.04;
    droneRoll  = 0;
    droneVx    = 0;
    droneVy    = 2.8;   // small launch pop upward
    droneVz    = 0;

    // Spawn position: just in front of & above the player's eye level
    const sinY = Math.sin(yaw), cosY = Math.cos(yaw);
    const sx = camera.position.x - sinY * 2.5;
    const sy = camera.position.y + 0.7;
    const sz = camera.position.z - cosY * 2.5;

    // --- Three.js drone visual group ---
    const group = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.55, metalness: 0.80 });
    group.add(new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.07, 0.26), bodyMat));

    const armMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7, metalness: 0.5 });
    const armGeo = new THREE.BoxGeometry(0.18, 0.034, 0.054);

    const armFL = new THREE.Mesh(armGeo, armMat);
    armFL.position.set(-0.20, 0.004, -0.13);
    armFL.rotation.y =  0.45;
    group.add(armFL);

    const armFR = new THREE.Mesh(armGeo, armMat);
    armFR.position.set( 0.20, 0.004, -0.13);
    armFR.rotation.y = -0.45;
    group.add(armFR);

    // Rear arms (mirror of front)
    const armRL = new THREE.Mesh(armGeo, armMat);
    armRL.position.set(-0.20, 0.004, 0.13);
    armRL.rotation.y = -0.45;
    group.add(armRL);

    const armRR = new THREE.Mesh(armGeo, armMat);
    armRR.position.set( 0.20, 0.004, 0.13);
    armRR.rotation.y =  0.45;
    group.add(armRR);

    const motorGeo = new THREE.CylinderGeometry(0.032, 0.032, 0.038, 8);
    const motorMat = new THREE.MeshStandardMaterial({ color: 0x404040, roughness: 0.4, metalness: 0.9 });
    const motorFL = new THREE.Mesh(motorGeo, motorMat);
    motorFL.position.set(-0.30, 0.024, -0.21);
    group.add(motorFL);
    const motorFR = new THREE.Mesh(motorGeo, motorMat);
    motorFR.position.set( 0.30, 0.024, -0.21);
    group.add(motorFR);
    const motorRL = new THREE.Mesh(motorGeo, motorMat);
    motorRL.position.set(-0.30, 0.024,  0.21);
    group.add(motorRL);
    const motorRR = new THREE.Mesh(motorGeo, motorMat);
    motorRR.position.set( 0.30, 0.024,  0.21);
    group.add(motorRR);

    // Propeller discs � semi-transparent, spin for visual effect; visible from FPV at upper corners
    const propGeo = new THREE.CylinderGeometry(0.155, 0.155, 0.009, 14);
    const propMatL = new THREE.MeshStandardMaterial({
        color: 0x333333, transparent: true, opacity: 0.55,
        roughness: 0.9, metalness: 0.1, side: THREE.DoubleSide
    });
    const propMatR = propMatL.clone();

    const propFL = new THREE.Mesh(propGeo, propMatL);
    propFL.position.set(-0.30, 0.037, -0.21);
    group.add(propFL);

    const propFR = new THREE.Mesh(propGeo, propMatR);
    propFR.position.set( 0.30, 0.037, -0.21);
    group.add(propFR);

    const propRL = new THREE.Mesh(propGeo, propMatL.clone());
    propRL.position.set(-0.30, 0.037,  0.21);
    group.add(propRL);

    const propRR = new THREE.Mesh(propGeo, propMatR.clone());
    propRR.position.set( 0.30, 0.037,  0.21);
    group.add(propRR);

    // Bomb payload � red glowing sphere under the body
    const bombMat = new THREE.MeshStandardMaterial({
        color: 0xcc2200, metalness: 0.35, roughness: 0.55,
        emissive: 0x550800, emissiveIntensity: 0.9
    });
    const bombMesh = new THREE.Mesh(new THREE.SphereGeometry(0.092, 10, 8), bombMat);
    bombMesh.position.set(0, -0.116, 0.03);
    group.add(bombMesh);

    group.position.set(sx, sy, sz);
    group.rotation.order = 'YXZ';
    scene.add(group);

    // --- CANNON kinematic body for collision detection ---
    const body = new CANNON.Body({ mass: 0 });
    body.type = CANNON.Body.KINEMATIC;
    body.addShape(new CANNON.Sphere(0.22));
    body.position.set(sx, sy, sz);
    body.velocity.set(0, droneVy, 0);
    body.linearDamping  = 0;
    body.angularDamping = 1;
    world.addBody(body);

    let impactDetonated = false;
    body.addEventListener('collide', e => {
        if (impactDetonated || !activeDrone || activeDrone.detonated) return;
        // Detonate on any physics contact � velocity-along-normal can be ~0
        // when the drone slides parallel to a surface (e.g. horizontal deck).
        impactDetonated = true;
        detonateDrone();
    });

    activeDrone = { body, group, propFL, propFR, propRL, propRR, detonated: false };
    if (soundEnabled) activeDrone._motor = startDroneMotorSound();
    // Update mobile fire button label and show descend button for drone mode
    if (mobileFireBtn) mobileFireBtn.textContent = 'POWER';
    const _mdd = document.getElementById('mobileDescendBtn');
    if (_mdd) _mdd.style.display = '';

    // Aspect ratio: drone camera now IS the primary full-screen render
    droneCamera.aspect = window.innerWidth / window.innerHeight;
    droneCamera.updateProjectionMatrix();

    if (droneFpvOverlayEl) droneFpvOverlayEl.style.display = 'block';
    playCannonFire(WEAPON_IDX_EXPLOSIVE);
    popFlash(sx, sy, sz, 0xffdd88, 28, 10, 70);
    addShake(0.12);
}

// Fire grenade/cluster with a pre-cooked fuse (cookMs = ms already burned)
function fireCannonballCooked(cookMs) {
    fireCannonball(parseFloat(powerSlider.value), cookMs);
}

function fireCannonball(power, grenadeCookMs = 0) {
    if (gameOver || p1Ammo[currentWeapon] <= 0) return;
    markSfxCombatActivity();
    perfRecordEvent('shot', `w${currentWeapon}`);
    const wep = WEAPONS[currentWeapon];
    const isShotgun    = (currentWeapon === WEAPON_IDX_SHOTGUN);
    const isMinigun    = (currentWeapon === WEAPON_IDX_MINIGUN);
    const isSniper     = (currentWeapon === WEAPON_IDX_SNIPER);
    const isHeavyRound = (currentWeapon === WEAPON_IDX_CANNON);
    const isGrenade    = (currentWeapon === WEAPON_IDX_GRENADE);
    const isCluster    = (currentWeapon === WEAPON_IDX_CLUSTER);
    const now = performance.now();
    if (isShotgun && now < shotgunNextFire) return;
    if (isShotgun) shotgunNextFire = now + SHOTGUN_RATE;
    if (isSniper && now < sniperNextFire) return;
    if (isSniper) sniperNextFire = now + SNIPER_RATE;
    p1Ammo[currentWeapon]--;
    shotsFired++; updateUI(); checkGameOver();

    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);

    // Arc loft for mortar
    if (wep.arcLoft > 0) {
        fwd.y += wep.arcLoft;
        fwd.normalize();
    }

    if (isShotgun) {
        playShotgunShot();
        const muzzle = camera.position.clone().addScaledVector(fwd, 1.35);
        popFlash(muzzle.x, muzzle.y, muzzle.z, 0xffd9aa, 44, 18, 95);
        popFlash(muzzle.x, muzzle.y, muzzle.z, 0xffffff, 26, 11, 85);
        addShake(0.24);
        shotgunShotKick = Math.max(shotgunShotKick, 1);
        shotgunBreakAnim = 1;
        shotgunEjectAnim = 0;
        shotgunEjectTriggered = false;
        vmShotgunShellL.visible = true;
        vmShotgunShellR.visible = true;
        vmShotgunEjectL.visible = false;
        vmShotgunEjectR.visible = false;

        const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
        const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
        const launchSpeed = getWeaponLaunchSpeed(currentWeapon, power);
        let firstPelletEntry = null;

        for (let i = 0; i < SHOTGUN_PELLETS; i++) {
            const barrelSide = (i & 1) ? 1 : -1;
            const yawJitter = (Math.random() - 0.5) * SHOTGUN_SPREAD + barrelSide * SHOTGUN_STAGGER;
            const pitchJitter = (Math.random() - 0.5) * SHOTGUN_SPREAD * 0.7;
            const dir = fwd.clone()
                .addScaledVector(right, yawJitter)
                .addScaledVector(up, pitchJitter)
                .normalize();

            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(0.055, 6, 6),
                new THREE.MeshStandardMaterial({ color: 0xd7d0c2, metalness: 0.82, roughness: 0.24 })
            );
            scene.add(mesh);

            const body = new CANNON.Body({
                mass: 7,
                shape: new CANNON.Sphere(0.055),
                linearDamping: 0.012,
                angularDamping: 0.12,
                allowSleep: true,
                sleepSpeedLimit: 0.9,
                sleepTimeLimit: 0.16
            });
            const start = camera.position.clone()
                .addScaledVector(dir, 1.25)
                .addScaledVector(right, barrelSide * 0.062)
                .addScaledVector(up, -0.018);
            body.position.set(start.x, start.y, start.z);
            const pelletSpeed = launchSpeed * (0.92 + Math.random() * 0.18);
            body.velocity.set(dir.x * pelletSpeed, dir.y * pelletSpeed, dir.z * pelletSpeed);
            world.addBody(body);

            let hit = false;
            body.addEventListener('collide', e => {
                if (hit) return;
                const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
                const hitIsPlank = !!(e.body && e.body._isPlank);
                if (impact < (hitIsPlank ? 7 : 4)) return;
                recordShotDamage(impact);
                hit = true;
                if (e.body && e.body.mass > 0) {
                    const spd = Math.sqrt(body.velocity.x * body.velocity.x + body.velocity.y * body.velocity.y + body.velocity.z * body.velocity.z) || 1;
                    const nudge = hitIsPlank ? 9 : 30;  // planks take ~5� more hits before cascading
                    e.body.wakeUp();
                    e.body.applyImpulse(
                        new CANNON.Vec3(
                            (body.velocity.x / spd) * nudge,
                            (body.velocity.y / spd) * nudge * 0.26,
                            (body.velocity.z / spd) * nudge
                        ),
                        new CANNON.Vec3((Math.random() - 0.5) * 0.28, (Math.random() - 0.5) * 0.16, (Math.random() - 0.5) * 0.28)
                    );
                }
                setTimeout(() => removeCannonballByBody(body), 30);
            });

            const shotEntry = { mesh, body, weaponType: currentWeapon };
            if (!firstPelletEntry) firstPelletEntry = shotEntry;
            cannonballs.push(shotEntry);
            scheduleCannonballExpiry(shotEntry, 900);
        }

        if (firstPelletEntry) lastFiredBall = firstPelletEntry;

        while (cannonballs.length > 36) {
            const old = cannonballs.shift();
            removeCannonballEntry(old);
        }
        return;
    }

    // === Grenade Launcher ===
    if (isGrenade) {
        playCannonFire(WEAPON_IDX_EXPLOSIVE);
        const muzzle = camera.position.clone().addScaledVector(fwd, 1.8);
        popFlash(muzzle.x, muzzle.y, muzzle.z, 0xffcc44, 34, 12, 80);
        addShake(0.20);

        // Egg-shaped frag grenade mesh
        const gGroup = new THREE.Group();
        const gBodyMat = new THREE.MeshStandardMaterial({ color: 0x4a5e2a, roughness: 0.72, metalness: 0.30 });
        const gBandMat = new THREE.MeshStandardMaterial({ color: 0x2e3a1c, roughness: 0.82, metalness: 0.40 });
        const gMetMat  = new THREE.MeshStandardMaterial({ color: 0xb0b8b0, roughness: 0.30, metalness: 0.85 });
        const gBodyMesh = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 12), gBodyMat);
        gBodyMesh.scale.set(1.0, 1.32, 1.0);
        gGroup.add(gBodyMesh);
        const gRing = new THREE.Mesh(new THREE.TorusGeometry(0.087, 0.008, 6, 18), gBandMat);
        gGroup.add(gRing);
        const gCap = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.034, 0.036, 8), gMetMat);
        gCap.position.y = 0.104;
        gGroup.add(gCap);
        const gLever = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.072, 0.014), gMetMat);
        gLever.position.set(0.086, 0.016, 0);
        gGroup.add(gLever);
        gGroup.castShadow = true;
        scene.add(gGroup);
        const gMesh = gGroup;   // cannonball entry holds the group

        // Bouncy contact material (lazily added to world once)
        if (!_grenadeContactMatAdded) {
            _grenadeContactMatAdded = true;
            world.addContactMaterial(new CANNON.ContactMaterial(
                _grenadeCcMat, world.defaultMaterial,
                { restitution: 0.55, friction: 0.38 }
            ));
        }

        const launchSpeed = getWeaponLaunchSpeed(currentWeapon, power);
        const gBody = new CANNON.Body({
            mass: 22,
            shape: new CANNON.Sphere(0.09),
            material: _grenadeCcMat,
            linearDamping: 0.06,
            angularDamping: 0.30,
            allowSleep: true, sleepSpeedLimit: 0.5, sleepTimeLimit: 0.4
        });
        const gStart = camera.position.clone().addScaledVector(fwd, 1.8);
        gBody.position.set(gStart.x, gStart.y, gStart.z);
        gBody.velocity.set(fwd.x * launchSpeed, fwd.y * launchSpeed, fwd.z * launchSpeed);
        world.addBody(gBody);

        let gDetonated = false;
        const detonateGrenade = () => {
            if (gDetonated) return;
            gDetonated = true;
            triggerBlast(new THREE.Vector3(gBody.position.x, gBody.position.y, gBody.position.z), wep.blastR, { tumbleOnly: true });
            setTimeout(() => removeCannonballByBody(gBody), 60);
        };
        gBody.addEventListener('collide', e => {
            if (gDetonated) return;
            const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
            if (impact > 2.5) playImpact(Math.min(0.55, impact * 0.028), 'stone');
        });

        const remainingFuse = Math.max(200, GRENADE_FUSE_MS - grenadeCookMs);
        const gEntry = { mesh: gMesh, body: gBody, weaponType: currentWeapon };
        gEntry._fuseTimer = setTimeout(detonateGrenade, remainingFuse);
        cannonballs.push(gEntry);
        scheduleCannonballExpiry(gEntry, remainingFuse + 800);
        lastFiredBall = gEntry;
        while (cannonballs.length > 36) removeCannonballEntry(cannonballs.shift());
        return;
    }

    // === Cluster Bomb ===
    if (isCluster) {
        playCannonFire(WEAPON_IDX_EXPLOSIVE);   // quieter throw sound, not mortar boom
        const muzzle = camera.position.clone().addScaledVector(fwd, 1.8);
        popFlash(muzzle.x, muzzle.y, muzzle.z, 0xffcc44, 34, 12, 80);
        addShake(0.18);

        // Cluster grenade visual: same egg shape as the hand grenade but
        // with orange/red markings to distinguish it.
        const cGroup = new THREE.Group();
        const cBodyMat   = new THREE.MeshStandardMaterial({ color: 0x5a3018, roughness: 0.72, metalness: 0.28 });
        const cBandMat   = new THREE.MeshStandardMaterial({ color: 0xcc3300, roughness: 0.65, metalness: 0.35 });
        const cMetalMat  = new THREE.MeshStandardMaterial({ color: 0xb0b8b0, roughness: 0.30, metalness: 0.85 });
        const cBodyMesh  = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 12), cBodyMat);
        cBodyMesh.scale.set(1.0, 1.32, 1.0);
        cGroup.add(cBodyMesh);
        const cRing  = new THREE.Mesh(new THREE.TorusGeometry(0.087, 0.010, 6, 18), cBandMat);
        cGroup.add(cRing);
        // Second band � marks it as cluster variant
        const cRing2 = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.007, 5, 16), cBandMat);
        cRing2.rotation.x = Math.PI / 4;
        cGroup.add(cRing2);
        const cCap   = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.034, 0.036, 8), cMetalMat);
        cCap.position.y = 0.104;
        cGroup.add(cCap);
        const cLever = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.072, 0.014), cMetalMat);
        cLever.position.set(0.086, 0.016, 0);
        cGroup.add(cLever);
        cGroup.castShadow = true;
        scene.add(cGroup);

        const launchSpeed = getWeaponLaunchSpeed(currentWeapon, power);
        const cBody = new CANNON.Body({
            mass: 28,
            shape: new CANNON.Sphere(0.09),
            material: _grenadeCcMat,   // bouncy contact so it arcs naturally
            linearDamping: 0.06, angularDamping: 0.30, allowSleep: false
        });
        const cStart = camera.position.clone().addScaledVector(fwd, 1.8);
        cBody.position.set(cStart.x, cStart.y, cStart.z);
        cBody.velocity.set(fwd.x * launchSpeed, fwd.y * launchSpeed, fwd.z * launchSpeed);
        world.addBody(cBody);

        let cBurst = false;
        const burstCluster = () => {
            if (cBurst) return;
            cBurst = true;
            const bPos = new THREE.Vector3(cBody.position.x, cBody.position.y, cBody.position.z);
            popFlash(bPos.x, bPos.y, bPos.z, 0xff8800, 90, 5.0, 150);
            playExplosionBlast(4.0);
            addShake(0.22);
            // 3 heavy bomblets at 120� apart � punchy, visually distinct sub-munitions
            const SUB_COUNT = 3;
            const SUB_BLAST = 6.5;   // bigger than a grenade for real impact
            const bvx = cBody.velocity.x, bvz = cBody.velocity.z;
            const parentSpd = Math.hypot(bvx, bvz);
            for (let i = 0; i < SUB_COUNT; i++) {
                const ang = (i / SUB_COUNT) * Math.PI * 2 + Math.random() * 0.5;
                const sp  = 2.5 + Math.random() * 2.0;   // gentle lateral spread
                const svx = Math.cos(ang) * sp + bvx * 0.25;
                const svy = 1.5 + Math.random() * 1.5;   // small upward pop then fall
                const svz = Math.sin(ang) * sp + bvz * 0.25;
                // Bomblet: small cylinder + nose cone
                const bGroup = new THREE.Group();
                const bCylMat = new THREE.MeshStandardMaterial({ color: 0x8c1c00, roughness: 0.55, metalness: 0.55 });
                const bNoseMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.25, metalness: 0.90 });
                const bCyl = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 0.28, 10), bCylMat);
                bCyl.castShadow = true;
                bGroup.add(bCyl);
                const bNose = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.18, 10), bNoseMat);
                bNose.position.y = 0.23;
                bNose.castShadow = true;
                bGroup.add(bNose);
                scene.add(bGroup);

                const sBody = new CANNON.Body({ mass: 14, shape: new CANNON.Sphere(0.12),
                    linearDamping: 0.04, angularDamping: 0.2, allowSleep: false });
                // Spawn slightly above the burst point so the initial physics step
                // doesn't find the bomblet already overlapping the ground/parent body.
                sBody.position.set(bPos.x, bPos.y + 0.18, bPos.z);
                sBody.velocity.set(svx, svy, svz);
                world.addBody(sBody);
                const sSpawnedAt = performance.now();
                let sDet = false;
                const detSub = () => {
                    if (sDet) return; sDet = true;
                    triggerBlast(new THREE.Vector3(sBody.position.x, sBody.position.y, sBody.position.z), SUB_BLAST, { tumbleOnly: true });
                    setTimeout(() => removeCannonballByBody(sBody), 55);
                };
                sBody.addEventListener('collide', e => {
                    // Grace period: ignore any contacts in the first 300 ms so the
                    // solver doesn't detonate the bomblet against the burst-point surface.
                    if (performance.now() - sSpawnedAt < 300) return;
                    if (Math.abs(e.contact.getImpactVelocityAlongNormal()) > 3) detSub();
                });
                const sEntry = { mesh: bGroup, body: sBody, weaponType: currentWeapon };
                // Bomblets only detonate on contact � no airburst timer.
                // Cleanup fallback: silently remove after 8 s if still undetonated.
                sEntry._fuseTimer = setTimeout(() => { if (!sDet) { sDet = true; removeCannonballByBody(sBody); } }, 8000);
                cannonballs.push(sEntry);
                scheduleCannonballExpiry(sEntry, 8200);
            }
            setTimeout(() => removeCannonballByBody(cBody), 55);
        };
        cBody.addEventListener('collide', e => {
            if (Math.abs(e.contact.getImpactVelocityAlongNormal()) > 12) burstCluster();
        });
        const cEntry = { mesh: cGroup, body: cBody, weaponType: currentWeapon };
        const clusterFuseMs = Math.max(200, GRENADE_FUSE_MS - grenadeCookMs);
        cEntry._fuseTimer = setTimeout(burstCluster, clusterFuseMs);
        cannonballs.push(cEntry);
        scheduleCannonballExpiry(cEntry, clusterFuseMs + 800);
        lastFiredBall = cEntry;
        while (cannonballs.length > 36) removeCannonballEntry(cannonballs.shift());
        return;
    }

    if (isMinigun) {
        playMinigunShot();
        const _mf = camera.position.clone().addScaledVector(fwd, 1.5);
        popFlash(_mf.x, _mf.y, _mf.z, 0xffffaa, 12, 6, 40);
        addShake(0.05);   // light rattle per round
    } else if (isSniper) {
        playSniperShot();
        const _sf = camera.position.clone().addScaledVector(fwd, 2.1);
        popFlash(_sf.x, _sf.y, _sf.z, 0xc5e7ff, 32, 16, 70);
        addShake(0.16);
    } else {
        playCannonFire(currentWeapon);
        const _f1 = camera.position.clone().addScaledVector(fwd, 2.0);
        popFlash(_f1.x, _f1.y, _f1.z, 0xffdd88, 55, 22, 110);
        popFlash(_f1.x, _f1.y, _f1.z, 0xffffff, 30, 10, 110);
        addShake(currentWeapon === WEAPON_IDX_MORTAR ? 0.42 : 0.30);   // mortar kicks hardest
    }

    const ballColor  = wep.color;
    const ballRadius = isMinigun ? 0.10 : isSniper ? 0.08 : currentWeapon === WEAPON_IDX_MORTAR ? 0.52 : BALL_RADIUS;
    const ballMat    = isMinigun
        ? new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.95, roughness: 0.15 })
        : isSniper
        ? new THREE.MeshStandardMaterial({ color: 0xaec6d8, metalness: 0.96, roughness: 0.12, emissive: 0x123040, emissiveIntensity: 0.2 })
        : currentWeapon === WEAPON_IDX_CANNON ? BALL_MAT
        : new THREE.MeshStandardMaterial({
              color: ballColor, metalness: 0.7, roughness: 0.5,
              emissive: currentWeapon === WEAPON_IDX_EXPLOSIVE ? 0x441100 : 0x221100,
              emissiveIntensity: 0.6
          });
    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(ballRadius, (isMinigun || isSniper) ? 6 : 16, (isMinigun || isSniper) ? 6 : 16),
        ballMat
    );
    mesh.castShadow = !(isMinigun || isSniper);
    scene.add(mesh);

    const launchSpeed = getWeaponLaunchSpeed(currentWeapon, power);
    const body = new CANNON.Body({
        mass: isMinigun ? 5 : isSniper ? 9 : currentWeapon === WEAPON_IDX_MORTAR ? 280 : 180,
        shape: new CANNON.Sphere(ballRadius),
        linearDamping: isMinigun ? 0.01 : isSniper ? 0.01 : 0.08,
        angularDamping: isMinigun ? 0.18 : isSniper ? 0.14 : 0.6,
        allowSleep: true,
        sleepSpeedLimit: isMinigun ? 0.65 : isSniper ? 0.8 : 0.35,
        sleepTimeLimit: isMinigun ? 0.18 : isSniper ? 0.18 : 0.3
    });
    const start = camera.position.clone().addScaledVector(fwd, isMinigun ? 1.4 : isSniper ? 1.9 : 2.2);
    body.position.set(start.x, start.y, start.z);
    body.velocity.set(fwd.x * launchSpeed, fwd.y * launchSpeed, fwd.z * launchSpeed);
    world.addBody(body);
    if (isSniper) spawnSniperTracer(start, start.clone().addScaledVector(fwd, 110));

    const blastR = wep.blastR;

    if (blastR > 0) {
        // Explosive / mortar -- detonate on first significant impact
        let detonated = false;
        body.addEventListener('collide', e => {
            if (detonated) return;
            const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
            if (impact < 3) return;
            detonated = true;
            const pos = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
            triggerBlast(pos, blastR);
            setTimeout(() => {
                removeCannonballByBody(body);
            }, 80);
        });
    } else if (isMinigun) {
        // Minigun -- low per-shot kinetic nudge with small accumulated chip force.
        // It can grind out an exposed brick after sustained fire, but should not
        // trigger broad wall cascades.
        let hit = false;
        body.addEventListener('collide', e => {
            if (hit) return;
            const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
            if (impact < 5) return;
            recordShotDamage(impact);
            hit = true;
            const isMasonry = e.body && e.body.mass > 0
                && (e.body.collisionFilterGroup === CGROUP_BRICK
                 || e.body.collisionFilterGroup === CGROUP_TOWER);
            const isSettledMasonry = isMasonry && e.body.sleepState !== 0; // 0 = awake; anything else = at rest
            if (e.body && e.body.mass > 0) {
                const spd = Math.sqrt(body.velocity.x**2 + body.velocity.y**2 + body.velocity.z**2) || 1;
                if (isSettledMasonry) {
                    // Accumulate tiny "chip" energy on the struck resting brick.
                    // Sustained bursts can pop one exposed stone loose, but a single
                    // hit is too weak to disturb settled courses.
                    e.body._mgChip = (e.body._mgChip || 0) + impact * 0.65;
                    if (e.body._mgChip >= 50) {
                        e.body._mgChip = 0;
                        const chipImpulse = e.body.collisionFilterGroup === CGROUP_TOWER ? 42 : 52;
                        e.body.wakeUp();
                        e.body.applyImpulse(
                            new CANNON.Vec3(
                                (body.velocity.x / spd) * chipImpulse,
                                4,
                                (body.velocity.z / spd) * chipImpulse
                            ),
                            new CANNON.Vec3(
                                (Math.random() - 0.5) * 0.24,
                                0,
                                (Math.random() - 0.5) * 0.24
                            )
                        );
                    }
                } else {
                    // Loose debris still reacts immediately so bursts sweep rubble.
                    const nudge = 16;
                    e.body.wakeUp();
                    e.body.applyImpulse(
                        new CANNON.Vec3(
                            (body.velocity.x / spd) * nudge,
                            0,
                            (body.velocity.z / spd) * nudge
                        ),
                        new CANNON.Vec3(
                            (Math.random() - 0.5) * 0.45,
                            (Math.random() - 0.5) * 0.25,
                            0
                        )
                    );
                }
            }
            setTimeout(() => {
                removeCannonballByBody(body);
            }, 40);
        });
    } else {
        // Standard -- kinetic impact: explicit impulse so the struck brick actually flies
        let lastHit = 0;
        let impulseDone = false;
        let neighborhoodWakeDone = false;
        let impactFxDone = false;
        body.addEventListener('collide', e => {
            const now = performance.now();
            if (now - lastHit < 280) return;
            lastHit = now;
            const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
            const impactThreshold = isMobileProfile ? 3.8 : 2;
            if (impact > impactThreshold) {
                const speed2Now = body.velocity.x * body.velocity.x
                    + body.velocity.y * body.velocity.y
                    + body.velocity.z * body.velocity.z;
                // Ignore tiny post-settle contact chatter that can otherwise keep
                // retriggering expensive impact logic while a ball sits on ground.
                if (speed2Now < 16 && impact < 6.5) return;

                recordShotDamage(impact);
                if (MOBILE_SHOT_STABILITY_FIX && isMobileProfile && isHeavyRound) {
                    // One-shot iPhone failure path: a single heavy ball can linger
                    // in repeated low-value contacts and keep waking nearby bodies.
                    // Keep the dramatic first impact, then cull shortly after.
                    body._mobileCullAt = Math.min(body._mobileCullAt || Infinity, now + 320);
                }
                let ricocheted = false;
                const shouldRunImpactFx = !impactFxDone;
                if (shouldRunImpactFx) {
                    spawnExplosion(new THREE.Vector3(body.position.x, body.position.y, body.position.z));
                    playImpact(Math.min(impact / 16, 1), isSniper ? 'sniper' : 'stone');
                    showHitMarker(false);   // confirm the hit on the crosshair
                    impactFxDone = true;
                    // Track for NPC danger-taunt gate.
                    _lastImpactMs = performance.now();
                    _lastImpactPos.x = body.position.x; _lastImpactPos.z = body.position.z;
                    markNpcAngry(body.position.x, body.position.z, 0.28, 18);
                }

                // First hit only: sharp supplemental impulse so the struck brick punches
                // out hard rather than softly pushing. ~1300 Ns / 150 kg = ~8.7 m/s extra
                // (capped by the global brick-speed clamp). Gated to one-shot so the
                // initial impact punches through without cascading the whole ring.
                // Round-tower bricks form a self-supporting compression ring, so a
                // single brick is held tight by its tangential neighbours � they need
                // a stronger punch and a wider disturbance than a flat wall to break.
                const isTowerHit = e.body && e.body.collisionFilterGroup === CGROUP_TOWER;
                if (!impulseDone && e.body && e.body.mass > 0) {
                    impulseDone = true;
                    const spd = Math.sqrt(body.velocity.x**2 + body.velocity.y**2 + body.velocity.z**2) || 1;
                    e.body.wakeUp();
                    if (isTowerHit) {
                        // Brief speed-cap exemption so the struck wedge ejects cleanly
                        // before the clamp pulls it back to debris speed. Tower-only �
                        // walls keep the low cap so they can't over-energize.
                        e.body._punchUntil = _frameCount + 12;
                        // A tower brick is a wedge-shaped voussoir keyed into a
                        // compression ring: pushing it radially INWARD (the ball's
                        // direction) just jams it tighter against its neighbours �
                        // the same keystone effect that makes real arches strong, so
                        // a straight punch does nothing. The only way it can leave is
                        // to ride UP and OUT of its slot. So eject it along
                        // radial-outward + up, which knocks the stone loose and lets
                        // the courses above tumble into the gap.
                        const bp = e.body.position;
                        let nearest = TOWER_CENTERS[0], best = Infinity;
                        for (const t of TOWER_CENTERS) {
                            const ddx = bp.x - t.cx, ddz = bp.z - t.cz;
                            const d2 = ddx * ddx + ddz * ddz;
                            if (d2 < best) { best = d2; nearest = t; }
                        }
                        let rx = bp.x - nearest.cx, rz = bp.z - nearest.cz;
                        const rlen = Math.hypot(rx, rz) || 1;
                        rx /= rlen; rz /= rlen;                       // radial-out unit (XZ)
                        const towerPunchScale = isSniper ? 0.45 : 1.0;
                        const imp = Math.min(impact * 95 * towerPunchScale, 5600 * towerPunchScale);
                        // UP-dominant so the stone rises clear of the ball (which is
                        // sitting in the outward escape path) instead of jamming
                        // against it; outward component pops it off the ring.
                        e.body.applyImpulse(
                            new CANNON.Vec3(
                                rx * imp * 0.6,
                                imp * 1.15,                          // lift it up and out of its slot
                                rz * imp * 0.6
                            ),
                            new CANNON.Vec3(
                                (Math.random() - 0.5) * 0.3,
                                (Math.random() - 0.5) * 0.15,
                                (Math.random() - 0.5) * 0.3
                            )
                        );
                        // Release the keystone lock: a voussoir is held by its two
                        // tangential neighbours, so nudge the closest ring bricks
                        // outward+up too � once the arch is locally broken the struck
                        // stone (and the courses above) can actually come away.
                        const nx = bp.x, ny = bp.y, nz = bp.z;
                        for (const nb of bricks) {
                            if (nb.grp !== CGROUP_TOWER || nb.body === e.body) continue;
                            const ddx = nb.body.position.x - nx;
                            const ddy = nb.body.position.y - ny;
                            const ddz = nb.body.position.z - nz;
                            if (ddx*ddx + ddy*ddy + ddz*ddz > 2.6 * 2.6) continue;
                            let orx = nb.body.position.x - nearest.cx;
                            let orz = nb.body.position.z - nearest.cz;
                            const orl = Math.hypot(orx, orz) || 1;
                            nb.body.wakeUp();
                            nb.body._punchUntil = _frameCount + 12;
                            nb.body.applyImpulse(new CANNON.Vec3(
                                (orx / orl) * imp * (isSniper ? 0.20 : 0.30),
                                imp * (isSniper ? 0.20 : 0.35),
                                (orz / orl) * imp * (isSniper ? 0.20 : 0.30)
                            ), new CANNON.Vec3(0, 0, 0));
                        }
                        // Ricochet the ball back out and downward so it vacates the
                        // brick's escape path (and reads like stone deflecting shot).
                        body.velocity.set(rx * (isSniper ? 4.8 : 7), isSniper ? -6.2 : -8, rz * (isSniper ? 4.8 : 7));
                        ricocheted = true;
                    } else {
                        // Flat wall brick: no arch lock, so drive it straight along
                        // the ball's travel � a clean kinetic knock-through. Kept
                        // modest so the hit opens a LOCAL hole rather than rippling
                        // energy down the whole course.
                        const impScale = isSniper ? 0.28 : 1.0;
                        const imp = Math.min(impact * cannonImpactScale * impScale, cannonImpactScale * 60 * impScale);
                        e.body.applyImpulse(
                            new CANNON.Vec3(
                                (body.velocity.x / spd) * imp,
                                (body.velocity.y / spd) * imp,
                                (body.velocity.z / spd) * imp
                            ),
                            // Deterministic wall hit: no random torque arm.
                            // Random spin occasionally made one side of the front
                            // wall catastrophically unzip while the mirrored side
                            // only dented, despite equal masses.
                            new CANNON.Vec3(0, 0, 0)
                        );
                    }
                }

                // Every significant hit: wake the immediate neighbourhood so the ball
                // progressively disturbs bricks as it rolls/bounces through. A tower
                // hit uses a slightly larger radius so a localised SECTION can be
                // knocked out (the struck brick + its near neighbours), but kept tight
                // enough that the whole ring doesn't lose cohesion and collapse from a
                // single hit. A flat wall keeps the standard radius.
                const shouldRunNeighborhoodWake = !neighborhoodWakeDone;
                if (shouldRunNeighborhoodWake) {
                    const hitRole = e.body?._storyRole || null;
                    const isBridgeHit = hitRole === 'bridge';
                    const IMPACT_WAKE_R = isTowerHit
                        ? 2.9
                        : (isSniper ? 0.55 : (isBridgeHit ? 0.82 : 1.7));
                    const IMPACT_WAKE_R2 = IMPACT_WAKE_R * IMPACT_WAKE_R;
                    // Bridge: tiny local wake so one shot doesn't unzip the span.
                    const wakeLimit = isBridgeHit ? 10 : 40;
                    let woke = 0;
                    const struckGrp = e.body.collisionFilterGroup;
                    const ix = body.position.x, iy = body.position.y, iz = body.position.z;
                    for (const b of bricks) {
                        if (isBrickInInactiveStoryLevel(b)) continue;
                        if (b.grp !== struckGrp) continue;   // stay within the struck structure
                        if (hitRole && b.storyRole !== hitRole) continue;
                        const dx = b.body.position.x - ix;
                        const dy = b.body.position.y - iy;
                        const dz = b.body.position.z - iz;
                        if (dx * dx + dy * dy + dz * dz > IMPACT_WAKE_R2) continue;
                        if (b.body.sleepState !== 0) {
                            b.body.wakeUp();
                            woke++;
                            if (woke >= wakeLimit) break;
                        }
                    }
                    neighborhoodWakeDone = true;
                }

                // Realistic penetration: a cannonball dumps most of its kinetic
                // energy breaking through the first courses it strikes, so bleed
                // its speed hard on every significant impact. This stops one ball
                // plowing the entire length of a wall (the "ripple" collapse) �
                // it now punches a local breach and stalls, like real round shot.
                // (Skip if we already set a ricochet velocity for a tower hit.)
                if (!ricocheted) {
                    const bleed = isSniper ? 0.06 : 0.4;
                    body.velocity.scale(bleed, body.velocity);
                    body.angularVelocity.scale(bleed, body.angularVelocity);
                }
            }
        });
    }

    const shotEntry = { mesh, body, weaponType: currentWeapon };
    cannonballs.push(shotEntry);
    scheduleCannonballExpiry(shotEntry);
    if (cannonballs.length > 16) {
        const old = cannonballs.shift();
        removeCannonballEntry(old);
    }
    if (!(isMinigun || isSniper)) lastFiredBall = shotEntry;
    return shotEntry;
}
function p1Fire() {
    if (currentWeapon === WEAPON_IDX_DRONE && !activeDrone) { fireDrone(); return; }
    if (activeDrone) return; // drone active: fire button repurposed as ascend (touch handled separately)
    fireCannonball(parseFloat(powerSlider.value));
}
function p2Fire() { if (twoPlayerMode) fireCannonballP2(parseFloat(powerSlider.value)); }

const mobileWeaponHudEl = document.getElementById('mobileWeaponHud');
const mwPrevEl = document.getElementById('mwPrev');
const mwCurrentEl = document.getElementById('mwCurrent');
const mwNextEl = document.getElementById('mwNext');
const mobileWeaponAssemblyEl = document.getElementById('mobileWeaponAssembly');
const mobileWeaponRollerEl = document.getElementById('mobileWeaponRoller');
const mwTrackEl = document.getElementById('mwTrack');
const mwGripWheelEl = document.getElementById('mwGripWheel');
const mobileFireBtn = document.getElementById('mobileFireBtn');
const rollerSwipe = { touchId: null, lastY: 0, lastAt: 0, dragOffset: 0, previewWeapon: null };
const rollerStepQueue = [];
let rollerAnimating = false;

function playRollLockClick() {
    if (!soundEnabled) return;
    const ctx = getAudio();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1450, now);
    osc.frequency.exponentialRampToValueAtTime(860, now + 0.038);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.05, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    osc.connect(hp);
    hp.connect(g);
    g.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.055);
}

function runNextRollStep() {
    if (rollerAnimating || rollerStepQueue.length === 0) return;
    const step = rollerStepQueue.shift();
    const dir = step && step.dir;
    const spinMs = Math.max(70, Math.min(220, step && step.spinMs ? step.spinMs : 130));
    if (!dir) return;
    if (!mobileWeaponAssemblyEl || !mobileWeaponRollerEl || !mwTrackEl) {
        setWeapon(currentWeapon + dir);
        runNextRollStep();
        return;
    }

    const LOCK_MS = 165;
    const slotTravel = Math.round((mobileWeaponRollerEl.clientHeight || 180) / 3);
    const spinTravel = dir > 0 ? -slotTravel : slotTravel;
    const wheelTravel = dir > 0 ? -26 : 26;

    rollerAnimating = true;
    mobileWeaponAssemblyEl.classList.remove('rolling-up', 'rolling-down', 'lock-up', 'lock-down');

    mwTrackEl.style.transition = `transform ${spinMs}ms cubic-bezier(.12,.82,.22,1)`;
    mwTrackEl.style.transform = `translateY(${spinTravel}px)`;
    if (mwGripWheelEl) {
        mwGripWheelEl.style.transition = `transform ${spinMs}ms cubic-bezier(.12,.82,.22,1), background-position ${spinMs}ms cubic-bezier(.12,.82,.22,1)`;
        mwGripWheelEl.style.transform = `translateY(${dir > 0 ? -2 : 2}px)`;
        mwGripWheelEl.style.backgroundPosition = `0 0, 0 ${wheelTravel}px`;
    }

    setTimeout(() => {
        setWeapon(currentWeapon + dir);
        playRollLockClick();

        // Snap to aligned slot immediately after commit to avoid visual pop.
        mwTrackEl.style.transition = 'none';
        mwTrackEl.style.transform = 'translateY(0px)';
        if (mwGripWheelEl) {
            mwGripWheelEl.style.transition = 'none';
            mwGripWheelEl.style.transform = 'translateY(0px)';
            mwGripWheelEl.style.backgroundPosition = '0 0, 0 0';
        }
        // Force style flush before lock settle transition.
        void mwTrackEl.offsetHeight;

        // Gentle lock settle so the lock-in is visible but not jarring.
        mwTrackEl.style.transition = `transform ${LOCK_MS}ms cubic-bezier(.2,.86,.2,1)`;
        mwTrackEl.style.transform = 'translateY(0px)';
        if (mwGripWheelEl) {
            mwGripWheelEl.style.transition = `transform ${LOCK_MS}ms cubic-bezier(.2,.86,.2,1), background-position ${LOCK_MS}ms cubic-bezier(.2,.86,.2,1)`;
            mwGripWheelEl.style.transform = 'translateY(0px)';
            mwGripWheelEl.style.backgroundPosition = '0 0, 0 0';
        }

        setTimeout(() => {
            mwTrackEl.style.transition = '';
            mwTrackEl.style.transform = '';
            if (mwGripWheelEl) {
                mwGripWheelEl.style.transition = '';
                mwGripWheelEl.style.transform = '';
                mwGripWheelEl.style.backgroundPosition = '';
            }
            rollerAnimating = false;
            runNextRollStep();
        }, LOCK_MS);
    }, spinMs);
}

function queueWeaponRoll(dir, steps = 1, spinMs = 200) {
    if (!dir || steps <= 0) return;
    for (let i = 0; i < steps; i++) {
        rollerStepQueue.push({ dir: dir > 0 ? 1 : -1, spinMs });
    }
    runNextRollStep();
}

function nextSelectableWeapon(from, dir) {
    const N = WEAPONS.length;
    let w = ((from % N) + N) % N;
    for (let tries = 0; tries < N; tries++) {
        w = (w + dir + N) % N;
        const p1e = p1Ammo[w] === 0;
        const p2e = !twoPlayerMode || p2Ammo[w] === 0;
        if (!p1e || !p2e) return w;
    }
    return currentWeapon;
}

function weaponCardHtml(idx) {
    return `<div class="mwCard"><div class="mwIcon">${WEAPON_ICONS[idx] || '•'}</div><div class="mwName">${WEAPONS[idx].name}</div><div class="mwAmmo">×${p1Ammo[idx] ?? 0}</div></div>`;
}

function renderMobileWeaponRoller(selectedWeapon = currentWeapon) {
    if (!touchControls.enabled || !mobileWeaponHudEl || !mwPrevEl || !mwCurrentEl || !mwNextEl) return;
    mobileWeaponHudEl.style.display = twoPlayerMode ? 'none' : 'flex';
    const prev = nextSelectableWeapon(selectedWeapon, -1);
    const next = nextSelectableWeapon(selectedWeapon, +1);
    mwPrevEl.innerHTML = weaponCardHtml(prev);
    mwCurrentEl.innerHTML = weaponCardHtml(selectedWeapon);
    mwNextEl.innerHTML = weaponCardHtml(next);
}

function applyRollDragVisual(offsetPx) {
    if (!mobileWeaponRollerEl || !mwTrackEl) return;
    const slotTravel = Math.round((mobileWeaponRollerEl.clientHeight || 180) / 3);
    const dragNorm = Math.max(-1, Math.min(1, offsetPx / 26));
    const travel = Math.max(-slotTravel * 0.72, Math.min(slotTravel * 0.72, dragNorm * slotTravel * 0.72));
    mwTrackEl.style.transition = 'none';
    mwTrackEl.style.transform = `translateY(${travel.toFixed(1)}px)`;
    if (mwGripWheelEl) {
        mwGripWheelEl.style.transition = 'none';
        mwGripWheelEl.style.transform = `translateY(${(dragNorm * 2.2).toFixed(1)}px)`;
        mwGripWheelEl.style.backgroundPosition = `0 0, 0 ${(dragNorm * 20).toFixed(1)}px`;
    }
}

function settleRollDragVisual() {
    const SETTLE_MS = 190;
    if (mwTrackEl) {
        mwTrackEl.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(.2,.86,.2,1)`;
        mwTrackEl.style.transform = 'translateY(0px)';
    }
    if (mwGripWheelEl) {
        mwGripWheelEl.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(.2,.86,.2,1), background-position ${SETTLE_MS}ms cubic-bezier(.2,.86,.2,1)`;
        mwGripWheelEl.style.transform = 'translateY(0px)';
        mwGripWheelEl.style.backgroundPosition = '0 0, 0 0';
    }
    setTimeout(() => {
        if (mwTrackEl) {
            mwTrackEl.style.transition = '';
            mwTrackEl.style.transform = '';
        }
        if (mwGripWheelEl) {
            mwGripWheelEl.style.transition = '';
            mwGripWheelEl.style.transform = '';
            mwGripWheelEl.style.backgroundPosition = '';
        }
    }, SETTLE_MS + 20);
}

if (mwPrevEl) {
    mwPrevEl.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        queueWeaponRoll(-1, 1, 210);
    });
}
if (mwNextEl) {
    mwNextEl.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        queueWeaponRoll(1, 1, 210);
    });
}
function attachRollerSwipeControl(targetEl) {
    if (!targetEl) return;
    targetEl.addEventListener('touchstart', e => {
        activateTouchProfileIfNeeded();
        if (twoPlayerMode || rollerSwipe.touchId != null) return;
        const t = e.changedTouches && e.changedTouches[0];
        if (!t) return;
        rollerSwipe.touchId = t.identifier;
        rollerSwipe.lastY = t.clientY;
        rollerSwipe.lastAt = performance.now();
        rollerSwipe.dragOffset = 0;
        rollerSwipe.previewWeapon = currentWeapon;
        renderMobileWeaponRoller(rollerSwipe.previewWeapon);
        e.preventDefault();
        e.stopPropagation();
    }, { passive: false });

    targetEl.addEventListener('touchmove', e => {
        if (rollerSwipe.touchId == null) return;
        let tracked = null;
        for (const t of e.changedTouches) {
            if (t.identifier === rollerSwipe.touchId) {
                tracked = t;
                break;
            }
        }
        if (!tracked) return;
        const dy = tracked.clientY - rollerSwipe.lastY;
        const STEP_PX = 26;
        rollerSwipe.dragOffset += dy;

        let stepped = false;
        while (rollerSwipe.dragOffset <= -STEP_PX) {
            rollerSwipe.dragOffset += STEP_PX;
            rollerSwipe.previewWeapon = nextSelectableWeapon(rollerSwipe.previewWeapon, +1);
            stepped = true;
        }
        while (rollerSwipe.dragOffset >= STEP_PX) {
            rollerSwipe.dragOffset -= STEP_PX;
            rollerSwipe.previewWeapon = nextSelectableWeapon(rollerSwipe.previewWeapon, -1);
            stepped = true;
        }

        if (stepped) renderMobileWeaponRoller(rollerSwipe.previewWeapon);
        applyRollDragVisual(rollerSwipe.dragOffset);

        rollerSwipe.lastY = tracked.clientY;
        rollerSwipe.lastAt = performance.now();
        e.preventDefault();
        e.stopPropagation();
    }, { passive: false });

    const endRollerSwipe = e => {
        if (rollerSwipe.touchId == null) return;
        for (const t of e.changedTouches) {
            if (t.identifier === rollerSwipe.touchId) {
                const finalWeapon = rollerSwipe.previewWeapon == null ? currentWeapon : rollerSwipe.previewWeapon;
                if (finalWeapon !== currentWeapon) {
                    setWeapon(finalWeapon);
                    playRollLockClick();
                }
                settleRollDragVisual();
                rollerSwipe.touchId = null;
                rollerSwipe.lastAt = 0;
                rollerSwipe.dragOffset = 0;
                rollerSwipe.previewWeapon = null;
                break;
            }
        }
    };
    targetEl.addEventListener('touchend', endRollerSwipe, { passive: true });
    targetEl.addEventListener('touchcancel', endRollerSwipe, { passive: true });

    targetEl.addEventListener('pointerdown', e => {
        if (e.pointerType !== 'touch') return;
        activateTouchProfileIfNeeded();
        if (twoPlayerMode || rollerSwipe.touchId != null) return;
        rollerSwipe.touchId = `p${e.pointerId}`;
        rollerSwipe.lastY = e.clientY;
        rollerSwipe.lastAt = performance.now();
        rollerSwipe.dragOffset = 0;
        rollerSwipe.previewWeapon = currentWeapon;
        renderMobileWeaponRoller(rollerSwipe.previewWeapon);
        if (targetEl.setPointerCapture) {
            try { targetEl.setPointerCapture(e.pointerId); } catch (_) {}
        }
        e.preventDefault();
        e.stopPropagation();
    }, { passive: false });

    targetEl.addEventListener('pointermove', e => {
        if (e.pointerType !== 'touch') return;
        if (rollerSwipe.touchId !== `p${e.pointerId}`) return;
        const dy = e.clientY - rollerSwipe.lastY;
        const STEP_PX = 26;
        rollerSwipe.dragOffset += dy;

        let stepped = false;
        while (rollerSwipe.dragOffset <= -STEP_PX) {
            rollerSwipe.dragOffset += STEP_PX;
            rollerSwipe.previewWeapon = nextSelectableWeapon(rollerSwipe.previewWeapon, +1);
            stepped = true;
        }
        while (rollerSwipe.dragOffset >= STEP_PX) {
            rollerSwipe.dragOffset -= STEP_PX;
            rollerSwipe.previewWeapon = nextSelectableWeapon(rollerSwipe.previewWeapon, -1);
            stepped = true;
        }

        if (stepped) renderMobileWeaponRoller(rollerSwipe.previewWeapon);
        applyRollDragVisual(rollerSwipe.dragOffset);
        rollerSwipe.lastY = e.clientY;
        rollerSwipe.lastAt = performance.now();
        e.preventDefault();
        e.stopPropagation();
    }, { passive: false });

    const endRollerPointer = e => {
        if (e.pointerType !== 'touch') return;
        if (rollerSwipe.touchId !== `p${e.pointerId}`) return;
        const finalWeapon = rollerSwipe.previewWeapon == null ? currentWeapon : rollerSwipe.previewWeapon;
        if (finalWeapon !== currentWeapon) {
            setWeapon(finalWeapon);
            playRollLockClick();
        }
        settleRollDragVisual();
        rollerSwipe.touchId = null;
        rollerSwipe.lastAt = 0;
        rollerSwipe.dragOffset = 0;
        rollerSwipe.previewWeapon = null;
        e.preventDefault();
        e.stopPropagation();
    };
    targetEl.addEventListener('pointerup', endRollerPointer, { passive: false });
    targetEl.addEventListener('pointercancel', endRollerPointer, { passive: false });
}

attachRollerSwipeControl(mobileWeaponRollerEl);
attachRollerSwipeControl(mwGripWheelEl);
if (mobileFireBtn) {
    const fireStart = e => {
        e.preventDefault();
        e.stopPropagation();
        if (activeDrone) {
            droneAscend = true;   // fire button = ascend while piloting
            return;
        }
        if (currentWeapon === WEAPON_IDX_MINIGUN) {
            minigunFiring = true;
            minigunNextFire = 0;
        } else {
            p1Fire();
        }
    };
    const fireEnd = e => {
        e.preventDefault();
        e.stopPropagation();
        minigunFiring = false;
        droneAscend = false;   // release ascend on touch end
    };
    mobileFireBtn.addEventListener('touchstart', fireStart, { passive: false });
    mobileFireBtn.addEventListener('touchend', fireEnd, { passive: false });
    mobileFireBtn.addEventListener('touchcancel', fireEnd, { passive: false });
    mobileFireBtn.addEventListener('mousedown', fireStart);
    mobileFireBtn.addEventListener('mouseup', fireEnd);
    mobileFireBtn.addEventListener('mouseleave', fireEnd);
}
const mobileDescendBtn = document.getElementById('mobileDescendBtn');
if (mobileInteractBtn) {
    mobileInteractBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        tryInteract();
    }, { passive: false });
}
if (mobileDescendBtn) {
    const descStart = e => { e.preventDefault(); e.stopPropagation(); droneDescend = true; };
    const descEnd   = e => { e.preventDefault(); e.stopPropagation(); droneDescend = false; };
    mobileDescendBtn.addEventListener('touchstart',  descStart, { passive: false });
    mobileDescendBtn.addEventListener('touchend',    descEnd,   { passive: false });
    mobileDescendBtn.addEventListener('touchcancel', descEnd,   { passive: false });
    mobileDescendBtn.addEventListener('mousedown',   descStart);
    mobileDescendBtn.addEventListener('mouseup',     descEnd);
    mobileDescendBtn.addEventListener('mouseleave',  descEnd);
}
if (mobileBallCamBtn) {
    const toggleMobileBallCam = e => {
        e.preventDefault();
        e.stopPropagation();
        if (!touchControls.enabled || twoPlayerMode) return;
        mobileBallCamPinned = !mobileBallCamPinned;
        if (!mobileBallCamPinned) ballCamActive = false;
        updateMobileBallCamButton();
    };
    mobileBallCamBtn.addEventListener('click', toggleMobileBallCam);
}
if (mobileFullscreenBtn) {
    const onFsTap = e => {
        e.preventDefault();
        e.stopPropagation();
        toggleMobileFullscreen();
    };
    mobileFullscreenBtn.addEventListener('click', onFsTap);
}
updateMobileBallCamButton();
updateMobileFullscreenButton();
document.addEventListener('fullscreenchange', updateMobileFullscreenButton);
document.addEventListener('webkitfullscreenchange', updateMobileFullscreenButton);

// === UI ===
const powerSlider = document.getElementById("power");
const powerVal    = document.getElementById("powerValue");
powerSlider.min = String(POWER_SLIDER_MIN);
powerSlider.max = String(POWER_SLIDER_MAX);
powerSlider.value = String(POWER_SLIDER_MAX);
powerVal.textContent = powerSlider.value;
weaponPowerByIndex = WEAPONS.map(() => parseFloat(powerSlider.max));
powerSlider.addEventListener("input", e => {
    powerVal.textContent = e.target.value;
    weaponPowerByIndex[currentWeapon] = parseFloat(e.target.value);
});

// === Settings panel ===
const RELEASE_BUILD_STAMP = '2026-06-20';
const settingsBtn   = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const cannonImpactInput = document.getElementById('setCannonImpact');
const cannonImpactValEl = document.getElementById('setCannonImpactVal');
const buildStampEl = document.getElementById('buildStamp');
const waterColorInputEl = document.getElementById('setWaterColor');
const waterOpacityInputEl = document.getElementById('setWaterOpacity');
const waterOpacityValEl = document.getElementById('setWaterOpacityVal');
const waterImpactsInputEl = document.getElementById('setWaterImpacts');
const waterRippleStrengthInputEl = document.getElementById('setWaterRippleStrength');
const waterRippleStrengthValEl = document.getElementById('setWaterRippleStrengthVal');
const waterRippleSizeInputEl = document.getElementById('setWaterRippleSize');
const waterRippleSizeValEl = document.getElementById('setWaterRippleSizeVal');
const waterRippleLifeInputEl = document.getElementById('setWaterRippleLife');
const waterRippleLifeValEl = document.getElementById('setWaterRippleLifeVal');
const templateLevelInputEl = document.getElementById('setTemplateLevel');
const bridge2LevelInputEl     = document.getElementById('setBridge2Level');
const bridgeDevLevelInputEl   = document.getElementById('setBridgeDevLevel');
const bridgeNewLevelInputEl   = document.getElementById('setBridgeNewLevel');  // returns null (checkbox removed)
const castleNewLevelInputEl = document.getElementById('setCastleNewLevel');  // returns null (checkbox removed)
if (buildStampEl) buildStampEl.textContent = `Build: ${RELEASE_BUILD_STAMP}`;

function clampInt(v, min, max, fallback) {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function hexColorToInputValue(hexColor) {
    return `#${((hexColor >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
}

function parseColorInputHex(raw, fallback) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        return (raw >>> 0) & 0xffffff;
    }
    if (typeof raw !== 'string') return fallback;
    const m = raw.trim().match(/^#?([0-9a-fA-F]{6})$/);
    if (!m) return fallback;
    return Number.parseInt(m[1], 16);
}

function updateWaterFxUiLabels() {
    if (waterOpacityValEl && waterOpacityInputEl) {
        waterOpacityValEl.textContent = `${clampInt(waterOpacityInputEl.value, 20, 100, 80)}%`;
    }
    if (waterRippleStrengthValEl && waterRippleStrengthInputEl) {
        waterRippleStrengthValEl.textContent = `${clampInt(waterRippleStrengthInputEl.value, 50, 300, 140)}%`;
    }
    if (waterRippleSizeValEl && waterRippleSizeInputEl) {
        waterRippleSizeValEl.textContent = `${clampInt(waterRippleSizeInputEl.value, 60, 260, 125)}%`;
    }
    if (waterRippleLifeValEl && waterRippleLifeInputEl) {
        waterRippleLifeValEl.textContent = `${clampInt(waterRippleLifeInputEl.value, 60, 240, 115)}%`;
    }
}

function setWaterFxInputsFromRuntimeState() {
    if (waterColorInputEl) waterColorInputEl.value = hexColorToInputValue(waterFxColor);
    if (waterOpacityInputEl) waterOpacityInputEl.value = String(Math.round(Math.min(100, Math.max(20, waterFxOpacity * 100))));
    if (waterImpactsInputEl) waterImpactsInputEl.checked = !!waterFxImpactRipplesEnabled;
    if (waterRippleStrengthInputEl) waterRippleStrengthInputEl.value = String(Math.round(Math.min(300, Math.max(50, waterFxRippleStrengthMul * 100))));
    if (waterRippleSizeInputEl) waterRippleSizeInputEl.value = String(Math.round(Math.min(260, Math.max(60, waterFxRippleSizeMul * 100))));
    if (waterRippleLifeInputEl) waterRippleLifeInputEl.value = String(Math.round(Math.min(240, Math.max(60, waterFxRippleLifeMul * 100))));
    updateWaterFxUiLabels();
}

function readWaterFxFromSettingsUi() {
    const wcl = parseColorInputHex(waterColorInputEl ? waterColorInputEl.value : null, waterFxColor);
    const wop = clampInt(waterOpacityInputEl ? waterOpacityInputEl.value : null, 20, 100, Math.round(waterFxOpacity * 100));
    const wir = waterImpactsInputEl ? !!waterImpactsInputEl.checked : waterFxImpactRipplesEnabled;
    const wrs = clampInt(waterRippleStrengthInputEl ? waterRippleStrengthInputEl.value : null, 50, 300, Math.round(waterFxRippleStrengthMul * 100));
    const wrz = clampInt(waterRippleSizeInputEl ? waterRippleSizeInputEl.value : null, 60, 260, Math.round(waterFxRippleSizeMul * 100));
    const wrl = clampInt(waterRippleLifeInputEl ? waterRippleLifeInputEl.value : null, 60, 240, Math.round(waterFxRippleLifeMul * 100));
    return { wcl, wop, wir, wrs, wrz, wrl };
}

function applyWaterFxFromSettingsUi(saveToStorage = false) {
    const w = readWaterFxFromSettingsUi();
    waterFxColor = w.wcl;
    waterFxOpacity = w.wop / 100;
    waterFxRippleStrengthMul = w.wrs / 100;
    waterFxRippleSizeMul = w.wrz / 100;
    waterFxRippleLifeMul = w.wrl / 100;
    setWaterImpactRipplesEnabled(w.wir);
    setWaterFxInputsFromRuntimeState();
    applyWaterFxRuntimeTuning();

    if (!saveToStorage) return;
    try {
        const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
        o.wcl = w.wcl;
        o.wop = w.wop;
        o.wir = w.wir;
        o.wrs = w.wrs;
        o.wrz = w.wrz;
        o.wrl = w.wrl;
        localStorage.setItem('castleSettings', JSON.stringify(o));
    } catch (err) {}
}

setWaterFxInputsFromRuntimeState();

// Load persisted settings from localStorage and apply to inputs + AMMO_START
(function loadSettings() {
    const s = localStorage.getItem('castleSettings');
    if (!s) {
        const bcEl = document.getElementById('setBallCam');
        if (bcEl) bcEl.checked = true;
        const fpsEl = document.getElementById('setFpsCounter');
        if (fpsEl) fpsEl.checked = false;
        const perfEl = document.getElementById('setPerfDebug');
        if (perfEl) perfEl.checked = false;
        const waterFxEl = document.getElementById('setWaterFx');
        if (waterFxEl) waterFxEl.checked = true;
        const rubbleEl = document.getElementById('setRubbleSound');
        if (rubbleEl) rubbleEl.checked = false;
        const guardsEl = document.getElementById('setDisableGuards');
        if (guardsEl) guardsEl.checked = false;
        if (templateLevelInputEl) templateLevelInputEl.checked = false;
        if (bridge2LevelInputEl) bridge2LevelInputEl.checked = false;
        if (bridgeDevLevelInputEl) bridgeDevLevelInputEl.checked = false;
        ballCamAuto = true;
        templateLevelEnabled = false;
        bridge2LevelEnabled = false;
        bridgeDevLevelEnabled = false;
        setFpsCounterEnabled(false);
        setDevWaterFxEnabled(true);
        applyWaterFxFromSettingsUi(false);
        return;
    }
    try {
        const o = JSON.parse(s);
        if (o.sg  != null) { document.getElementById('setSg').value  = o.sg;  AMMO_START[0] = Math.max(0, o.sg|0); }
        if (o.cb  != null) { document.getElementById('setCb').value  = o.cb;  AMMO_START[1] = Math.max(0, o.cb|0); }
        if (o.cimp != null) {
            const cimp = Math.min(500, Math.max(1, o.cimp|0));
            cannonImpactScale = cimp;
            if (cannonImpactInput) cannonImpactInput.value = String(cimp);
            if (cannonImpactValEl) cannonImpactValEl.textContent = String(cimp);
        }
        if (o.ex  != null) { document.getElementById('setEx').value  = o.ex;  AMMO_START[2] = Math.max(0, o.ex|0); }
        if (o.mo  != null) { document.getElementById('setMo').value  = o.mo;  AMMO_START[3] = Math.max(0, o.mo|0); }
        if (o.mg  != null) { document.getElementById('setMg').value  = o.mg;  AMMO_START[4] = Math.max(0, o.mg|0); }
        if (o.sn  != null) { document.getElementById('setSn').value  = o.sn;  AMMO_START[5] = Math.max(0, o.sn|0); }
        if (o.npc != null) { document.getElementById('setNpc').value = o.npc; }
        if (o.inv != null) { document.getElementById('setInvertMouse').checked = o.inv; invertMouse = !!o.inv; }
        if (o.bc  != null) { document.getElementById('setBallCam').checked       = o.bc;  ballCamAuto = !!o.bc; }
        else {
            const bcEl = document.getElementById('setBallCam');
            if (bcEl) bcEl.checked = true;
            ballCamAuto = true;
        }
        if (o.fps != null) {
            const fpsOn = !!o.fps;
            document.getElementById('setFpsCounter').checked = fpsOn;
            setFpsCounterEnabled(fpsOn);
        } else {
            const fpsEl = document.getElementById('setFpsCounter');
            if (fpsEl) fpsEl.checked = false;
            setFpsCounterEnabled(false);
        }
        if (o.pd != null) {
            const perfOn = !!o.pd;
            const perfEl = document.getElementById('setPerfDebug');
            if (perfEl) perfEl.checked = perfOn;
        } else {
            const perfEl = document.getElementById('setPerfDebug');
            if (perfEl) perfEl.checked = false;
        }
        if (o.wfx != null) {
            const waterFxOn = !!o.wfx;
            const waterFxEl = document.getElementById('setWaterFx');
            if (waterFxEl) waterFxEl.checked = waterFxOn;
            setDevWaterFxEnabled(waterFxOn);
        } else {
            const waterFxEl = document.getElementById('setWaterFx');
            if (waterFxEl) waterFxEl.checked = true;
            setDevWaterFxEnabled(true);
        }
        if (o.wcl != null && waterColorInputEl) {
            waterColorInputEl.value = hexColorToInputValue(parseColorInputHex(o.wcl, waterFxColor));
        }
        if (o.wop != null && waterOpacityInputEl) {
            waterOpacityInputEl.value = String(clampInt(o.wop, 20, 100, Math.round(waterFxOpacity * 100)));
        }
        if (o.wir != null && waterImpactsInputEl) {
            waterImpactsInputEl.checked = !!o.wir;
        }
        if (o.wrs != null && waterRippleStrengthInputEl) {
            waterRippleStrengthInputEl.value = String(clampInt(o.wrs, 50, 300, Math.round(waterFxRippleStrengthMul * 100)));
        }
        if (o.wrz != null && waterRippleSizeInputEl) {
            waterRippleSizeInputEl.value = String(clampInt(o.wrz, 60, 260, Math.round(waterFxRippleSizeMul * 100)));
        }
        if (o.wrl != null && waterRippleLifeInputEl) {
            waterRippleLifeInputEl.value = String(clampInt(o.wrl, 60, 240, Math.round(waterFxRippleLifeMul * 100)));
        }
        if (o.dis != null) { document.getElementById('setDisarmNpc').checked   = o.dis; disarmNpc   = !!o.dis; }
        if (o.gds != null) { document.getElementById('setDisableGuards').checked = o.gds; guardsDisabled = !!o.gds; }
        else {
            const guardsEl = document.getElementById('setDisableGuards');
            if (guardsEl) guardsEl.checked = false;
            guardsDisabled = false;
        }
        if (o.tpl != null) {
            if (templateLevelInputEl) templateLevelInputEl.checked = !!o.tpl;
            templateLevelEnabled = !!o.tpl;
        } else {
            if (templateLevelInputEl) templateLevelInputEl.checked = false;
            templateLevelEnabled = false;
        }
        if (o.br2 != null) {
            if (bridge2LevelInputEl) bridge2LevelInputEl.checked = !!o.br2;
            bridge2LevelEnabled = !!o.br2;
        } else {
            if (bridge2LevelInputEl) bridge2LevelInputEl.checked = false;
            bridge2LevelEnabled = false;
        }
        if (o.bdl != null) {
            if (bridgeDevLevelInputEl) bridgeDevLevelInputEl.checked = !!o.bdl;
            bridgeDevLevelEnabled = !!o.bdl;
        } else {
            if (bridgeDevLevelInputEl) bridgeDevLevelInputEl.checked = false;
            bridgeDevLevelEnabled = false;
        }
        if (bridge2LevelEnabled && templateLevelEnabled) {
            templateLevelEnabled = false;
            if (templateLevelInputEl) templateLevelInputEl.checked = false;
        }
        if (o.bnl != null) {
            if (bridgeNewLevelInputEl) bridgeNewLevelInputEl.checked = !!o.bnl;
            bridgeNewLevelEnabled = !!o.bnl;
        } else {
            if (bridgeNewLevelInputEl) bridgeNewLevelInputEl.checked = false;
            bridgeNewLevelEnabled = false;
        }
        if (o.cnl != null) {
            if (castleNewLevelInputEl) castleNewLevelInputEl.checked = !!o.cnl;
            castleNewLevelEnabled = !!o.cnl;
        } else {
            if (castleNewLevelInputEl) castleNewLevelInputEl.checked = false;
            castleNewLevelEnabled = false;
        }
        if (o.bnl != null) {
            if (bridgeNewLevelInputEl) bridgeNewLevelInputEl.checked = !!o.bnl;
            bridgeNewLevelEnabled = !!o.bnl;
        } else {
            if (bridgeNewLevelInputEl) bridgeNewLevelInputEl.checked = false;
            bridgeNewLevelEnabled = false;
        }
        if (o.cnl != null) {
            if (castleNewLevelInputEl) castleNewLevelInputEl.checked = !!o.cnl;
            castleNewLevelEnabled = !!o.cnl;
        } else {
            if (castleNewLevelInputEl) castleNewLevelInputEl.checked = false;
            castleNewLevelEnabled = false;
        }
        if (o.ci != null) {
            const ciEl = document.getElementById('setCursorInspector');
            if (ciEl) ciEl.checked = !!o.ci;
            cursorInspectorEnabled = !!o.ci;
        }
        if (o.slw != null) { document.getElementById('setSlowMo').checked      = o.slw; slowMo      = !!o.slw; }
        if (o.snd != null) { document.getElementById('setSound').checked       = o.snd; soundEnabled = !!o.snd; }
        if (o.rub != null) { document.getElementById('setRubbleSound').checked = o.rub; rubbleSoundEnabled = !!o.rub; }
        else {
            const rubbleEl = document.getElementById('setRubbleSound');
            if (rubbleEl) rubbleEl.checked = false;
            rubbleSoundEnabled = false;
        }
    } catch (e) {}

    // Mobile perf default: keep auto ball-cam off. The inset camera renders an
    // extra scene pass per frame when active, which can tank FPS on weaker GPUs.
    if (isMobileProfile) {
        const bcEl = document.getElementById('setBallCam');
        if (bcEl) bcEl.checked = false;
        ballCamAuto = false;
    }

    applyWaterFxFromSettingsUi(false);

    applyGuardDisableMode();
})();

settingsBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (devPanel) devPanel.style.display = 'none';
    settingsPanel.style.display = settingsPanel.style.display === 'block' ? 'none' : 'block';
});
// Settings gear on the level-select modal opens the same panel
document.getElementById('dmSettingsBtn').addEventListener('click', e => {
    e.stopPropagation();
    if (devPanel) devPanel.style.display = 'none';
    settingsPanel.style.display = settingsPanel.style.display === 'block' ? 'none' : 'block';
});
settingsPanel.addEventListener('click', e => e.stopPropagation());

// Dev menu button toggles the dev panel
const devMenuBtn = document.getElementById('devMenuBtn');
const devPanel   = document.getElementById('devPanel');
if (devMenuBtn && devPanel) {
    devMenuBtn.addEventListener('click', e => {
        e.stopPropagation();
        settingsPanel.style.display = 'none';
        devPanel.style.display = devPanel.style.display === 'block' ? 'none' : 'block';
    });
    devPanel.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => {
        if (devPanel.style.display === 'block') devPanel.style.display = 'none';
    });
}

// Level editor button
const openEditorBtn = document.getElementById('openEditorBtn');
if (openEditorBtn) {
    openEditorBtn.addEventListener('click', e => {
        e.stopPropagation();
        activateEditor();
    });
}

// Initialise embedded level editor
initEditor({
    renderer,
    scene,
    camera,
    bricks,
    npcList,
    brickInstX,
    brickInstZ,
    brickInstY,
    brickInstC,
    towerInst,
    towerRingStep: TOWER_A_STEP,
    towerRingRadius: TOWER_BRICK_R,
    createBrick,
    createBrickZ,
    createBrickY,
    createBrickCube,
    createBrickAngled,
    createBrickAngledQuat,
    createEditorTrench,
    removeEditorTrench,
    setEditorTrenchWater,
    setAllEditorTrenchWater,
    createEditorDecorShrub,
    createEditorDecorTree,
    createEditorDecorBanner,
    createEditorPlankX,
    createEditorPlankZ,
    plankInstX,
    plankInstZ,
    removeEditorDecor,
    buildNPC,
    beginTemplateSandboxLevel,
});
document.addEventListener('click', () => {
    if (settingsPanel.style.display === 'block') settingsPanel.style.display = 'none';
});
if (cannonImpactInput) {
    cannonImpactInput.addEventListener('input', e => {
        const v = Math.min(500, Math.max(1, parseInt(e.target.value) || 170));
        cannonImpactScale = v;
        if (cannonImpactValEl) cannonImpactValEl.textContent = String(v);
    });
}
// Auto ball-cam toggle applies live (no restart needed)
document.getElementById('setBallCam').addEventListener('change', e => {
    ballCamAuto = e.target.checked;
    try {
        const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
        o.bc = ballCamAuto;
        localStorage.setItem('castleSettings', JSON.stringify(o));
    } catch (err) {}
});
// FPS debug overlay toggle applies live (no restart needed)
document.getElementById('setFpsCounter').addEventListener('change', e => {
    const enabled = e.target.checked;
    setFpsCounterEnabled(enabled);
    try {
        const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
        o.fps = enabled;
        localStorage.setItem('castleSettings', JSON.stringify(o));
    } catch (err) {}
});
// Temporary perf overlay toggle applies live and persists (no restart needed)
document.getElementById('setPerfDebug').addEventListener('change', e => {
    const enabled = e.target.checked;
    setPerfDebugEnabled(enabled);
    try {
        const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
        o.pd = enabled;
        localStorage.setItem('castleSettings', JSON.stringify(o));
    } catch (err) {}
});
// Cursor inspector toggle applies live and persists (no restart needed)
const cursorInspectorInputEl = document.getElementById('setCursorInspector');
if (cursorInspectorInputEl) {
    cursorInspectorInputEl.addEventListener('change', e => {
        cursorInspectorEnabled = e.target.checked;
        if (!cursorInspectorEnabled) {
            const pill = document.getElementById('cursorInspectorPill');
            if (pill) pill.style.display = 'none';
        }
        try {
            const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
            o.ci = cursorInspectorEnabled;
            localStorage.setItem('castleSettings', JSON.stringify(o));
        } catch (err) {}
    });
}
// Developer water effect toggle applies live (no restart needed)
document.getElementById('setWaterFx').addEventListener('change', e => {
    const enabled = e.target.checked;
    setDevWaterFxEnabled(enabled);
    try {
        const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
        o.wfx = enabled;
        localStorage.setItem('castleSettings', JSON.stringify(o));
    } catch (err) {}
});
if (waterColorInputEl) {
    waterColorInputEl.addEventListener('input', () => applyWaterFxFromSettingsUi(true));
    waterColorInputEl.addEventListener('change', () => applyWaterFxFromSettingsUi(true));
}
if (waterOpacityInputEl) {
    waterOpacityInputEl.addEventListener('input', () => applyWaterFxFromSettingsUi(true));
    waterOpacityInputEl.addEventListener('change', () => applyWaterFxFromSettingsUi(true));
}
if (waterImpactsInputEl) {
    waterImpactsInputEl.addEventListener('change', () => applyWaterFxFromSettingsUi(true));
}
if (waterRippleStrengthInputEl) {
    waterRippleStrengthInputEl.addEventListener('input', () => applyWaterFxFromSettingsUi(true));
    waterRippleStrengthInputEl.addEventListener('change', () => applyWaterFxFromSettingsUi(true));
}
if (waterRippleSizeInputEl) {
    waterRippleSizeInputEl.addEventListener('input', () => applyWaterFxFromSettingsUi(true));
    waterRippleSizeInputEl.addEventListener('change', () => applyWaterFxFromSettingsUi(true));
}
if (waterRippleLifeInputEl) {
    waterRippleLifeInputEl.addEventListener('input', () => applyWaterFxFromSettingsUi(true));
    waterRippleLifeInputEl.addEventListener('change', () => applyWaterFxFromSettingsUi(true));
}
// Sound toggle applies live (no restart needed)
document.getElementById('setSound').addEventListener('change', e => {
    soundEnabled = e.target.checked;
    if (soundEnabled) unlockAndPrecacheSfx();
    try {
        const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
        o.snd = soundEnabled;
        localStorage.setItem('castleSettings', JSON.stringify(o));
    } catch (err) {}
});
document.getElementById('setRubbleSound').addEventListener('change', e => {
    rubbleSoundEnabled = e.target.checked;
    if (!rubbleSoundEnabled) masonryRumbleLevel = 0;
    try {
        const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
        o.rub = rubbleSoundEnabled;
        localStorage.setItem('castleSettings', JSON.stringify(o));
    } catch (err) {}
});
document.getElementById('setDisableGuards').addEventListener('change', e => {
    guardsDisabled = e.target.checked;
    if (guardsDisabled) applyGuardDisableMode();
    try {
        const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
        o.gds = guardsDisabled;
        localStorage.setItem('castleSettings', JSON.stringify(o));
    } catch (err) {}
});

// Force-desktop toggle: persists immediately then reloads so isMobileProfile is re-evaluated.
const forceDesktopEl = document.getElementById('setForceDesktop');
if (forceDesktopEl) {
    forceDesktopEl.checked = localStorage.getItem('castleForceDesktop') === '1';
    forceDesktopEl.addEventListener('change', e => {
        if (e.target.checked) {
            localStorage.setItem('castleForceDesktop', '1');
        } else {
            localStorage.removeItem('castleForceDesktop');
        }
        location.reload();
    });
}
if (templateLevelInputEl) {
    templateLevelInputEl.addEventListener('change', e => {
        templateLevelEnabled = e.target.checked;
        if (templateLevelEnabled && bridge2LevelInputEl) {
            bridge2LevelInputEl.checked = false;
            bridge2LevelEnabled = false;
        }
        try {
            const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
            o.tpl = templateLevelEnabled;
            o.br2 = bridge2LevelEnabled;
            localStorage.setItem('castleSettings', JSON.stringify(o));
        } catch (err) {}
    });
}
if (bridge2LevelInputEl) {
    bridge2LevelInputEl.addEventListener('change', e => {
        bridge2LevelEnabled = e.target.checked;
        if (bridge2LevelEnabled && templateLevelInputEl) {
            templateLevelInputEl.checked = false;
            templateLevelEnabled = false;
        }
        try {
            const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
            o.br2 = bridge2LevelEnabled;
            o.tpl = templateLevelEnabled;
            localStorage.setItem('castleSettings', JSON.stringify(o));
        } catch (err) {}
    });
}
if (bridgeNewLevelInputEl) {
    bridgeNewLevelInputEl.addEventListener('change', e => {
        bridgeNewLevelEnabled = e.target.checked;
        if (bridgeNewLevelEnabled) {
            castleNewLevelEnabled = false;
            if (castleNewLevelInputEl) castleNewLevelInputEl.checked = false;
        }
        try {
            const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
            o.bnl = bridgeNewLevelEnabled;
            o.cnl = castleNewLevelEnabled;
            localStorage.setItem('castleSettings', JSON.stringify(o));
        } catch (err) {}
    });
}
if (castleNewLevelInputEl) {
    castleNewLevelInputEl.addEventListener('change', e => {
        castleNewLevelEnabled = e.target.checked;
        if (castleNewLevelEnabled) {
            bridgeNewLevelEnabled = false;
            if (bridgeNewLevelInputEl) bridgeNewLevelInputEl.checked = false;
        }
        try {
            const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
            o.cnl = castleNewLevelEnabled;
            o.bnl = bridgeNewLevelEnabled;
            localStorage.setItem('castleSettings', JSON.stringify(o));
        } catch (err) {}
    });
}
if (bridgeNewLevelInputEl) {
    bridgeNewLevelInputEl.addEventListener('change', e => {
        bridgeNewLevelEnabled = e.target.checked;
        if (bridgeNewLevelEnabled) {
            castleNewLevelEnabled = false;
            if (castleNewLevelInputEl) castleNewLevelInputEl.checked = false;
        }
        try {
            const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
            o.bnl = bridgeNewLevelEnabled;
            o.cnl = castleNewLevelEnabled;
            localStorage.setItem('castleSettings', JSON.stringify(o));
        } catch (err) {}
    });
}
if (castleNewLevelInputEl) {
    castleNewLevelInputEl.addEventListener('change', e => {
        castleNewLevelEnabled = e.target.checked;
        if (castleNewLevelEnabled) {
            bridgeNewLevelEnabled = false;
            if (bridgeNewLevelInputEl) bridgeNewLevelInputEl.checked = false;
        }
        try {
            const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
            o.cnl = castleNewLevelEnabled;
            o.bnl = bridgeNewLevelEnabled;
            localStorage.setItem('castleSettings', JSON.stringify(o));
        } catch (err) {}
    });
}
document.getElementById('applySettings').addEventListener('click', () => {
    const prevTemplateLevelEnabled = templateLevelEnabled;
    const prevBridge2LevelEnabled = bridge2LevelEnabled;
    const sg  = Math.max(0, parseInt(document.getElementById('setSg').value)  || 0);
    const cb  = Math.max(0, parseInt(document.getElementById('setCb').value)  || 0);
    const cimp = Math.min(500, Math.max(1, parseInt(document.getElementById('setCannonImpact').value) || 170));
    const ex  = Math.max(0, parseInt(document.getElementById('setEx').value)  || 0);
    const mo  = Math.max(0, parseInt(document.getElementById('setMo').value)  || 0);
    const mg  = Math.max(0, parseInt(document.getElementById('setMg').value)  || 0);
    const sn  = Math.max(0, parseInt(document.getElementById('setSn').value)  || 0);
    const npc = Math.min(20, Math.max(1, parseInt(document.getElementById('setNpc').value) || 1));
    const inv = document.getElementById('setInvertMouse').checked;
    const bc  = document.getElementById('setBallCam').checked;
    const fps = document.getElementById('setFpsCounter').checked;
    const pd  = document.getElementById('setPerfDebug').checked;
    const wfx = document.getElementById('setWaterFx').checked;
    const dis = document.getElementById('setDisarmNpc').checked;
    const gds = document.getElementById('setDisableGuards').checked;
    const br2 = bridge2LevelInputEl ? bridge2LevelInputEl.checked : false;
    const tpl = br2 ? false : (templateLevelInputEl ? templateLevelInputEl.checked : false);
    const slw = document.getElementById('setSlowMo').checked;
    const snd = document.getElementById('setSound').checked;
    const rub = document.getElementById('setRubbleSound').checked;
    const { wcl, wop, wir, wrs, wrz, wrl } = readWaterFxFromSettingsUi();
    invertMouse = inv;
    ballCamAuto = bc;
    setFpsCounterEnabled(fps);
    setPerfDebugEnabled(pd);
    setDevWaterFxEnabled(wfx);
    waterFxColor = wcl;
    waterFxOpacity = wop / 100;
    waterFxRippleStrengthMul = wrs / 100;
    waterFxRippleSizeMul = wrz / 100;
    waterFxRippleLifeMul = wrl / 100;
    setWaterImpactRipplesEnabled(wir);
    setWaterFxInputsFromRuntimeState();
    applyWaterFxRuntimeTuning();
    disarmNpc   = dis;
    guardsDisabled = gds;
    templateLevelEnabled = tpl;
    bridge2LevelEnabled = br2;
    slowMo      = slw;
    soundEnabled = snd;
    rubbleSoundEnabled = rub;
    if (!rubbleSoundEnabled) masonryRumbleLevel = 0;
    cannonImpactScale = cimp;
    if (cannonImpactValEl) cannonImpactValEl.textContent = String(cimp);
    AMMO_START[0] = sg; AMMO_START[1] = cb; AMMO_START[2] = ex; AMMO_START[3] = mo; AMMO_START[4] = mg; AMMO_START[5] = sn;
    localStorage.setItem('castleSettings', JSON.stringify({ sg, cb, cimp, ex, mo, mg, sn, npc, inv, bc, fps, pd, wfx, wcl, wop, wir, wrs, wrz, wrl, dis, gds, tpl, br2, slw, snd, rub }));
    p1Ammo = [...AMMO_START]; p2Ammo = [...AMMO_START];
    score = 0; bricksDestroyed = 0; shotsFired = 0;
    bestShotDamage = 0;
    p2Score = 0; p2Bricks = 0; p2Shots = 0;
    gameOver = false; gameOverPending = false; gameOverPendingAt = 0; gameOverCalmSec = 0; _npcAggroTriggered = false; _hutChargerTriggered = false;
    resetPlayerWaterState(false);
    _npcKillCount = 0; _npcWorldAnger = 0;
    playerHits = 0; updateHearts();
    document.getElementById('gameOver').style.display = 'none';
    settingsPanel.style.display = 'none';
    updateUI(); updateP2UI();
    setWeapon(0);
    // Spawn extra courtyard NPCs (beyond the one already built at game start).
    // Spread them in a loose grid inside the courtyard so they don't stack.
    const existing = npcList.filter(n => !n.isTowerGuard).length;
    const toAdd = npc - existing;
    if (toAdd > 0) {
        const CASTLE_MZ2 = (CFZ + CASTLE_BZ) / 2;
        for (let i = 0; i < toAdd; i++) {
            const col = (existing + i) % 4;
            const row = Math.floor((existing + i) / 4);
            const nx = (col - 1.5) * 4;
            const nz = CASTLE_MZ2 + row * 4;
            buildNPC(nx, nz, 0, Math.PI);
            npcList[npcList.length - 1].storyRole = 'castle';
        }
    }
    applyGuardDisableMode();
    if (templateLevelEnabled || prevTemplateLevelEnabled || bridge2LevelEnabled || prevBridge2LevelEnabled) {
        beginStoryModeRound();
    } else if (storyModeEnabled && storyStage === 1) {
        for (const n of npcList) {
            if (n.storyRole === 'castle') setNpcStoryDormant(n, true);
        }
    }
});

// === Difficulty start modal ===
const DIFFICULTIES = {
    squire: {
        name: 'Squire', emoji: '\uD83D\uDEE1\uFE0F',
        blurb: 'A gentle siege. The lone guard is unarmed and won\u2019t fight back \u2014 plenty of ammo to learn your aim.',
        ammo: [24, 20, 6, 4, 400, 8, 0, 0, 0], knights: 1, disarm: true,
        c1: '#34d399', c2: '#0f9b6c'
    },
    knight: {
        name: 'Knight', emoji: '\u2694\uFE0F',
        blurb: 'The classic challenge. Armed defenders, a small war-band of three, and a standard supply of ammunition.',
        ammo: [12, 10, 3, 2, 200, 5, 0, 0, 0], knights: 3, disarm: false,
        c1: '#f1c40f', c2: '#b8860b'
    },
    warlord: {
        name: 'Warlord', emoji: '\uD83D\uDC80',
        blurb: 'Brutal. A full company of eight armed knights storms out and ammo is scarce. Make every shot count.',
        ammo: [8, 6, 2, 1, 120, 4, 0, 0, 0], knights: 8, disarm: false,
        c1: '#ef4444', c2: '#991b1b'
    },
    modern: {
        name: 'Modern Warfare', emoji: '\uD83C\uDF96\uFE0F',
        blurb: 'Ditch the catapults. Three FPV strike drones, a precision sniper, 300 minigun rounds, four bouncing grenades and two cluster bombs. Six armed defenders await.',
        ammo: [0, 0, 0, 0, 300, 8, 3, 4, 2], knights: 6, disarm: false,
        c1: '#22d3ee', c2: '#0c4a6e', wide: true,
        statsLine: 'Minigun \u00d7300 \u00b7 Sniper \u00d78 \u00b7 FPV Drone \u00d73 \u00b7 Grenade \u00d74 \u00b7 Cluster \u00d72'
    },
    extreme: {
        name: 'Extreme Destruction', emoji: '\uD83D\uDCA5',
        blurb: 'Every weapon. No limits. Cannons, explosives, mortars, minigun, sniper, drones, grenades, cluster bombs — the lot. Twelve armed defenders. Game ends when the last one falls.',
        ammo: [60, 80, 30, 20, 2000, 20, 4, 8, 4], knights: 12, disarm: false,
        c1: '#a855f7', c2: '#6b21a8', wide: true, killWin: true,
        statsLine: 'Cannon \u00d780 \u00b7 Explosive \u00d730 \u00b7 Mortar \u00d720 \u00b7 Minigun \u00d72000 \u00b7 Sniper \u00d720 \u00b7 Drone \u00d74 \u00b7 Grenade \u00d78 \u00b7 Cluster \u00d74'
    }
};
const DIFF_ORDER = ['squire', 'knight', 'warlord', 'modern', 'extreme'];

function difficultyName(key) { return DIFFICULTIES[key] ? DIFFICULTIES[key].name : key; }

function loadHighScores() {
    try { return JSON.parse(localStorage.getItem('castleHighScores') || '{}'); }
    catch (e) { return {}; }
}
function getHighScore(diff, mode) {
    const h = loadHighScores();
    return (h[diff] && h[diff][mode]) || 0;
}
// Returns the best score for this difficulty/mode after recording the new one.
function recordHighScore(diff, mode, value) {
    const h = loadHighScores();
    if (!h[diff]) h[diff] = {};
    const prev = h[diff][mode] || 0;
    const best = Math.max(prev, value || 0);
    h[diff][mode] = best;
    try { localStorage.setItem('castleHighScores', JSON.stringify(h)); } catch (e) {}
    return best;
}
// Hoisted here so startGameWithDifficulty (and the castleRetry early-call path)
// can reference them without hitting TDZ before their original declaration site.
let _npcKillCount = 0;
let _npcWorldAnger = 0;

const difficultyModal = document.getElementById('difficultyModal');
const dmGrid = document.getElementById('dmGrid');
let dmMode = '1p';   // '1p' or '2p' selection in the modal
let dmStory = 'classic'; // 'story' or 'classic' selection in the modal � classic (new levels) is the default
let dmLevel = 'bridge'; // 'bridge' or 'castle' for classic mode
if (touchControls.enabled) {
    dmMode = '1p';
    const dmHint = document.getElementById('dmModeHint');
    if (dmHint) dmHint.textContent = 'Mobile currently supports single-player mode.';
}

function updateDmLevelUi() {
    const levelHint = document.getElementById('dmLevelHint');
    const levelButtons = document.querySelectorAll('.dmLevelBtn');
    const allowManualLevel = dmMode === '1p' && dmStory === 'classic';

    for (const btn of levelButtons) {
        const active = btn.dataset.level === dmLevel;
        btn.classList.toggle('active', active);
        btn.disabled = !allowManualLevel;
    }

    if (!levelHint) return;
    if (!allowManualLevel) {
        levelHint.textContent = 'Story campaign always starts on Bridge and transitions to Castle.';
        return;
    }
    levelHint.textContent = dmLevel === 'bridge'
        ? 'Classic starts on the standalone bridge level.'
        : 'Classic starts on the castle siege level.';
}

function updateDmStoryUi() {
    const storyHint = document.getElementById('dmStoryHint');
    const storyButtons = document.querySelectorAll('.dmStoryBtn');
    const storyAllowed = dmMode === '1p';

    if (!storyAllowed) dmStory = 'classic';
    for (const btn of storyButtons) {
        const active = btn.dataset.story === dmStory;
        btn.classList.toggle('active', active);
        btn.disabled = !storyAllowed;
    }

    if (!storyHint) return;
    if (!storyAllowed) {
        storyHint.textContent = 'Story mode is available in single-player only.';
        return;
    }
    storyHint.textContent = dmStory === 'story'
        ? 'Story mode runs Bridge -> Castle and ends when all defenders are down.'
        : 'Classic mode lets you choose Bridge or Castle as the starting level.';

    updateDmLevelUi();
}

function renderDifficultyCards() {
    dmGrid.innerHTML = '';
    for (const key of DIFF_ORDER) {
        const d = DIFFICULTIES[key];
        const hi = getHighScore(key, dmMode);
        const hiHtml = hi > 0
            ? `<span>\uD83C\uDFC6 Best: ${hi} pts</span>`
            : `<span class="none">No score yet</span>`;
        const ammoLine = d.statsLine ||
            `${d.ammo[0]} \u00b7 ${d.ammo[1]} \u00b7 ${d.ammo[2]} \u00b7 ${d.ammo[3]} \u00b7 ${d.ammo[4] >= 1000 ? '\u221e' : d.ammo[4]} \u00b7 ${d.ammo[5]} ammo`;
        const stats = [
            d.disarm ? 'Unarmed guards' : 'Armed defenders',
            `${d.knights} knight${d.knights > 1 ? 's' : ''}`,
            ammoLine
        ].map(s => `<span class="dmStat">${s}</span>`).join('');
        const card = document.createElement('div');
        card.className = 'dmCard' + (d.wide ? ' wide' : '');
        card.style.setProperty('--c1', d.c1);
        card.style.setProperty('--c2', d.c2);
        card.innerHTML = `
            <div class="dmGlow"></div>
            <div class="dmEmoji">${d.emoji}</div>
            <div class="dmRight">
                <div class="dmName">${d.name}</div>
                <div class="dmBlurb">${d.blurb}</div>
                <div class="dmStats">${stats}</div>
                <div class="dmHi">${hiHtml}</div>
                <div class="dmPlay">${key === 'modern' ? 'Deploy' : 'Begin Siege'} <span class="arr">\u2192</span></div>
            </div>`;
        bindTapActivate(card, () => startGameWithDifficulty(key));
        dmGrid.appendChild(card);
    }
}

document.querySelectorAll('.dmModeBtn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (touchControls.enabled && btn.dataset.mode === '2p') return;
        document.querySelectorAll('.dmModeBtn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        dmMode = btn.dataset.mode;
        document.getElementById('dmModeHint').textContent = dmMode === '2p'
            ? 'Two sieges, one screen \u2014 compare your best scores per difficulty.'
            : 'High scores are tracked per difficulty.';
        updateDmStoryUi();
        renderDifficultyCards();
    });
});

document.querySelectorAll('.dmStoryBtn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (dmMode !== '1p') return;
        dmStory = btn.dataset.story === 'classic' ? 'classic' : 'story';
        updateDmStoryUi();
    });
});

document.querySelectorAll('.dmLevelBtn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (!(dmMode === '1p' && dmStory === 'classic')) return;
        dmLevel = btn.dataset.level === 'castle' ? 'castle' : 'bridge';
        updateDmLevelUi();
    });
});

function startGameWithDifficulty(key) {
    if (!DIFFICULTIES[key]) return;
    unlockAndPrecacheSfx();
    const d = DIFFICULTIES[key];
    currentDifficulty = key;
    clearEditorTrenches();
    setGrassQualityForDifficulty(key);
    setupBallistaEncounter();
    // Apply ammo + NPC arming
    for (let i = 0; i < AMMO_START.length; i++) {
        AMMO_START[i] = d.ammo[i] ?? 0;
    }
    disarmNpc = d.disarm;
    p1Ammo = [...AMMO_START]; p2Ammo = [...AMMO_START];
    // Reset score state
    score = 0; bricksDestroyed = 0; shotsFired = 0;
    bestShotDamage = 0;
    p2Score = 0; p2Bricks = 0; p2Shots = 0;
    gameOver = false; gameOverPending = false; gameOverPendingAt = 0; gameOverCalmSec = 0; _npcAggroTriggered = false; _hutChargerTriggered = false;
    resetPlayerWaterState();
    _npcKillCount = 0; _npcWorldAnger = 0;
    playerHits = 0; updateHearts();
    document.getElementById('gameOver').style.display = 'none';
    // Multiplayer is temporarily disabled.
    setTwoPlayerMode(false);
    storyModePreference = dmMode === '1p' && dmStory === 'story';
    levelPreference = dmLevel === 'bridge' ? 'bridge' : 'castle';
    updateUI(); updateP2UI();
    setWeapon(0);
    // Spawn extra courtyard knights to reach the difficulty's count.
    const existing = npcList.filter(n => !n.isTowerGuard).length;
    const toAdd = d.knights - existing;
    if (toAdd > 0) {
        const CASTLE_MZ2 = (CFZ + CASTLE_BZ) / 2;
        for (let i = 0; i < toAdd; i++) {
            const col = (existing + i) % 4;
            const row = Math.floor((existing + i) / 4);
            const nx = (col - 1.5) * 4;
            const nz = CASTLE_MZ2 + row * 4;
            buildNPC(nx, nz, 0, Math.PI);
            npcList[npcList.length - 1].storyRole = 'castle';
        }
    }
    applyGuardDisableMode();
    beginStoryModeRound();
    // Reveal the lock prompt and dismiss the modal.
    _gameStarted = true;
    _roundStartAtMs = performance.now();
    difficultyModal.classList.add('hidden');
    document.getElementById('lockMsg').style.display = 'flex';
}

try {
    renderDifficultyCards();
} catch (e) {
    console.error('renderDifficultyCards failed:', e);
}
updateDmStoryUi();
updateDmLevelUi();

// If the player chose "Retry", restart the same difficulty immediately.
try {
    const retry = JSON.parse(sessionStorage.getItem('castleRetry') || 'null');
    if (retry && DIFFICULTIES[retry.diff]) {
        sessionStorage.removeItem('castleRetry');
        dmMode = '1p';
        dmStory = retry.storyPref === 'classic' ? 'classic' : 'story';
        dmLevel = retry.levelPref === 'bridge' ? 'bridge' : 'castle';
        document.querySelectorAll('.dmModeBtn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === dmMode);
        });
        document.getElementById('dmModeHint').textContent = dmMode === '2p'
            ? 'Two sieges, one screen � compare your best scores per difficulty.'
            : 'High scores are tracked per difficulty.';
        updateDmStoryUi();
        updateDmLevelUi();
        startGameWithDifficulty(retry.diff);
    }
} catch (e) {}

function adjustPower(delta) {
    const min = parseFloat(powerSlider.min);
    const max = parseFloat(powerSlider.max);
    const val = Math.max(min, Math.min(max, parseFloat(powerSlider.value) + delta));
    powerSlider.value = val;
    powerVal.textContent = val;
    weaponPowerByIndex[currentWeapon] = val;
}

document.getElementById("fireButton").addEventListener("click", e => {
    e.stopPropagation();
    p1Fire();
});

window.addEventListener("keydown", e => {
    if (e.code === "Equal" || e.code === "NumpadAdd")    { e.preventDefault(); adjustPower(+5); }
    if (e.code === "Minus" || e.code === "NumpadSubtract") { e.preventDefault(); adjustPower(-5); }
    if (e.code === "Escape") {
        if (pointerLocked) {
            document.exitPointerLock(); // pause handled by pointerlockchange
        } else if (_gameStarted && !gameOver) {
            settingsPanel.style.display = settingsPanel.style.display === 'block' ? 'none' : 'block';
        }
        e.preventDefault();
        return;
    }
    if (!window.__editorActive && e.code === "KeyQ") setWeapon(currentWeapon - 1);
    if (!window.__editorActive && e.code === "KeyE") { if (!tryInteract()) setWeapon(currentWeapon + 1); }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') sniperHoldBreath = true;
});

window.addEventListener("keyup", e => {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') sniperHoldBreath = false;
});

window.addEventListener("wheel", e => {
    e.preventDefault();
    adjustPower(e.deltaY < 0 ? +5 : -5);
}, { passive: false });

window.addEventListener("resize", () => {
    if (twoPlayerMode) {
        const asp = 0.5 * window.innerWidth / window.innerHeight;
        camera.aspect  = asp;
        camera2.aspect = asp;
    } else {
        camera.aspect = window.innerWidth / window.innerHeight;
    }
    camera.updateProjectionMatrix();
    camera2.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// === Animation Loop ===
const clock = new THREE.Clock();
let _frameCount = 0;  // used for throttled support checks
let _lastDisturbFrame = -9999;  // last frame any brick was awake (gates cluster check)
let _mobilePerfEmergency = false;
let _mobilePerfBadSec = 0;
let _mobilePerfGoodSec = 0;
// Toppling propagation: a moving brick (speed� above _WAKE_PROP_MOVE2) wakes the
// sleeping bricks within _WAKE_PROP_R so undermined sections collapse. The flat
// buffer holds x,y,z triples of this frame's moving bricks.
// Toppling propagation: a moving brick (speed� above _WAKE_PROP_MOVE2) wakes the
// sleeping bricks resting directly on top of it so undermined sections collapse.
// The flat buffer holds x,y,z triples of this frame's moving bricks.
const _WAKE_PROP_RXZ    = 0.7;   // XZ overlap to count as "stacked on" the brick
const _WAKE_PROP_DY_MIN = 0.2;   // only bricks ABOVE (=0.2 m higher) ...
const _WAKE_PROP_DY_MAX = 0.85;  // ... up to one course up (brick is 0.5 m tall)
const _WAKE_PROP_MOVE2 = 0.25;   // (0.5 m/s)� � ignore tiny settling jitter
const _WAKE_PROP_INTERVAL = isMobileProfile ? 12 : 6;   // mobile: halve scan rate to cut first-impact spikes
const _WAKE_PROP_BUDGET = isMobileProfile ? 16 : 40;    // mobile: tighter wake budget bounds worst-case cost
const _awakeBrickPts   = [];
function getWakePropagationInterval() {
    if (lightweightRubbleMode) return isMobileProfile ? 34 : 16;
    if (isMobileProfile && (_frameCount - _lastDisturbFrame) < 150) return 26;
    if (currentDifficulty === 'squire') return isMobileProfile ? 18 : 12;
    return _WAKE_PROP_INTERVAL;
}
function getWakePropagationBudget() {
    if (lightweightRubbleMode) return isMobileProfile ? 4 : 12;
    if (isMobileProfile && (_frameCount - _lastDisturbFrame) < 150) return 6;
    if (currentDifficulty === 'squire') return isMobileProfile ? 10 : 16;
    return _WAKE_PROP_BUDGET;
}
const _roofOff = new THREE.Vector3();  // scratch for syncing the hut roof group
// Scratch buffers for the cluster-stability (cantilever) check, allocated once.
const _cluParent = new Int32Array(MAX_BRICKS);
const _cluIndex  = new Int32Array(MAX_BRICKS);
// Spatial hash shared by the (throttled) support + cluster passes. Cell size is
// a touch larger than the widest neighbour query (~2.3 m) so a 3�3�3 cell sweep
// always covers it, turning the old O(bricks�) scans into ~O(bricks).
const _GRID_CELL = 2.5;
const _GRID_BASE = 512;                 // cell-coord offset so packed keys stay positive
const _grid = new Map();                // packed cell key -> array of brick / candidate indices
const _cellKeyXYZ = (cx, cy, cz) =>
    (cx + _GRID_BASE) + (cy + _GRID_BASE) * 1024 + (cz + _GRID_BASE) * 1048576;

// Adaptive resolution: the cheapest, safest runtime quality lever � it only
// changes how many pixels we shade, not the scene itself. If a weaker GPU can't
// hold a good frame-rate, step the internal resolution down; when FPS is stable
// again, recover quality slowly to avoid visible oscillation.
let _perfAccum = 0, _perfFrames = 0;
let _perfLowStreak = 0;
let _perfRecoverStreak = 0;
function monitorPerf(dt) {
    if (dt <= 0) return;
    _perfAccum += dt; _perfFrames++;
    if (_perfAccum < 2) return;                 // evaluate roughly every 2 s
    const avgFps = _perfFrames / _perfAccum;
    _perfAccum = 0; _perfFrames = 0;
    const pixelFloor = isMobileProfile ? 0.85 : 1.0;
    const degradeThreshold = isMobileProfile ? 48 : 50;
    const degradeStep = isMobileProfile ? 0.30 : 0.5;
    const recoverThreshold = isMobileProfile ? 57 : 56;
    const recoverStep = isMobileProfile ? 0.12 : 0.25;
    // Mobile reacts after ~2 consecutive low windows (~4 s) instead of ~12 s �
    // a phone stuck at full DPR for 12 s of low FPS feels broken; resolution is
    // the cheapest lever and recovery is slow/hysteretic anyway.
    const degradeStreakNeeded = isMobileProfile ? 2 : 6;
    if (avgFps < degradeThreshold && _pixelCap > pixelFloor) {
        _perfLowStreak++;
        if (_perfLowStreak >= degradeStreakNeeded) {
            _pixelCap = Math.max(pixelFloor, _pixelCap - degradeStep);
            renderer.setPixelRatio(_pixelCap);
            renderer.setSize(window.innerWidth, window.innerHeight);
            _perfLowStreak = 0;
            _perfRecoverStreak = 0;
        }
        return;
    }
    _perfLowStreak = 0;
    if (avgFps >= recoverThreshold && _pixelCap < _pixelMaxCap) {
        _perfRecoverStreak++;
        if (_perfRecoverStreak >= 2) {
            _pixelCap = Math.min(_pixelMaxCap, _pixelCap + recoverStep);
            renderer.setPixelRatio(_pixelCap);
            renderer.setSize(window.innerWidth, window.innerHeight);
            _perfRecoverStreak = 0;
        }
    } else {
        _perfRecoverStreak = 0;
    }
}

function updateWaterReflectionPerfGovernor(rawDt) {
    if (!WATER_USE_LIVE_REFLECTION || rawDt <= 0) return;
    const fps = 1 / rawDt;
    if (fps < 34) {
        waterSceneryReflectionFrameStride = Math.min(
            WATER_SCENERY_REFLECTION_MAX_FRAME_STRIDE,
            waterSceneryReflectionFrameStride + 1
        );
    } else if (fps > 52) {
        waterSceneryReflectionFrameStride = Math.max(
            WATER_SCENERY_REFLECTION_MIN_FRAME_STRIDE,
            waterSceneryReflectionFrameStride - 1
        );
    }
}

function updateMobilePerfGovernor(rawDt) {
    if (!isMobileProfile || rawDt <= 0) return;
    const fps = 1 / rawDt;

    if (fps < 16) {
        _mobilePerfBadSec += rawDt;
        _mobilePerfGoodSec = Math.max(0, _mobilePerfGoodSec - rawDt * 0.5);
    } else if (fps > 28) {
        _mobilePerfGoodSec += rawDt;
        _mobilePerfBadSec = Math.max(0, _mobilePerfBadSec - rawDt * 0.5);
    } else {
        _mobilePerfBadSec = Math.max(0, _mobilePerfBadSec - rawDt * 0.25);
        _mobilePerfGoodSec = Math.max(0, _mobilePerfGoodSec - rawDt * 0.25);
    }

    if (!_mobilePerfEmergency && _mobilePerfBadSec >= 2.2) {
        _mobilePerfEmergency = true;
        _mobilePerfBadSec = 0;
        _mobilePerfGoodSec = 0;
    } else if (_mobilePerfEmergency && _mobilePerfGoodSec >= 6.0) {
        _mobilePerfEmergency = false;
        _mobilePerfBadSec = 0;
        _mobilePerfGoodSec = 0;
    }

    world.solver.iterations = _mobilePerfEmergency ? 10 : 20;
}

function countAwakeDynamicBodies(limit = 2) {
    let count = 0;
    for (let i = 0; i < world.bodies.length; i++) {
        const b = world.bodies[i];
        if (!b || b.mass <= 0) continue;
        if (b.sleepState !== 0) continue;
        count++;
        if (count >= limit) break;
    }
    return count;
}

// (rebuildSapBroadphase removed 2026-07-05: the mobile idle self-heal that
// used it is gone � patchSapCollisionPairs fixed the underlying O(N�) sweep.)

// Temporary perf diagnostics overlay (enable with ?perfdebug=1 or Settings toggle).
function parsePerfDebugFromQuery() {
    try {
        const q = new URLSearchParams(window.location.search);
        const raw = (q.get('perfdebug') ?? q.get('perf') ?? '').trim().toLowerCase();
        if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
        if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
        return window.location.hash.toLowerCase().includes('perfdebug');
    } catch (_) {
        return false;
    }
}

function parsePerfDebugFromStorage() {
    try {
        const o = JSON.parse(localStorage.getItem('castleSettings') || '{}');
        return !!o.pd;
    } catch (_) {
        return false;
    }
}

let _perfDebugEnabled = parsePerfDebugFromQuery() || parsePerfDebugFromStorage();
let _perfDbgEl = null;
let _perfDbgAccum = 0;
let _perfDbgFrames = 0;
let _perfDbgPhysicsMs = 0;
let _perfDbgRenderMs = 0;
let _perfDbgFrameMs = 0;
let _perfDbgAwakeBricks = 0;
let _perfDbgBodies = 0;
let _perfDbgBalls = 0;
let _perfDbgRagdolls = 0;
let _perfDbgSfxVoices = 0;
let _perfDbgSfxPending = 0;
let _perfDbgRumble = 0;
let _perfDbgSupportScan = false;
let _perfDbgEmergency = false;
let _perfDbgDynAwake = 0;
let _perfDbgDynSleep = 0;
let _perfDbgDynTotal = 0;
let _perfDbgContacts = 0;
let _perfDbgConstraints = 0;
let _perfDbgWaterMs = 0;
let _perfDbgBridgeAiMs = 0;
const _PERF_SPIKE_EVENT_MAX = 14;
const _PERF_SPIKE_COOLDOWN_MS = 2500;
let _perfSpikeEvents = [];
let _perfSpikeLastAt = 0;
let _perfSpikeLastSummary = 'none';

function perfRecordEvent(type, detail = '') {
    const now = performance.now();
    const entry = {
        t: now,
        type: String(type || 'evt').slice(0, 24),
        detail: String(detail || '').slice(0, 48)
    };
    _perfSpikeEvents.push(entry);
    if (_perfSpikeEvents.length > _PERF_SPIKE_EVENT_MAX) {
        _perfSpikeEvents.shift();
    }
}

function perfRecentEventsString() {
    if (_perfSpikeEvents.length === 0) return 'none';
    const now = performance.now();
    const items = [];
    for (let i = Math.max(0, _perfSpikeEvents.length - 3); i < _perfSpikeEvents.length; i++) {
        const e = _perfSpikeEvents[i];
        const ageSec = Math.max(0, (now - e.t) / 1000);
        const ageTxt = ageSec >= 9.95 ? '10s+' : `${ageSec.toFixed(1)}s`;
        items.push(`${e.type}${e.detail ? ':' + e.detail : ''}@${ageTxt}`);
    }
    return items.join(' | ');
}

function perfCaptureSpike(reason, metrics) {
    const now = performance.now();
    if ((_frameCount || 0) < 180) return;
    if (now - _perfSpikeLastAt < _PERF_SPIKE_COOLDOWN_MS) return;
    _perfSpikeLastAt = now;
    const parts = [
        reason,
        `fps ${metrics.fps.toFixed(1)}`,
        `frame ${metrics.frame.toFixed(1)}ms`,
        `phys ${metrics.phys.toFixed(1)}ms`,
        `render ${metrics.render.toFixed(1)}ms`,
        `awake ${metrics.awake}`,
        `bodies ${metrics.bodies}`,
        `ragdolls ${metrics.ragdolls}`,
        `dyn ${metrics.dynTotal} awake ${metrics.dynAwake}`,
        `contacts ${metrics.contacts}`,
        `constraints ${metrics.constraints}`,
        `pending ${metrics.pending.toFixed(1)}`,
        `events ${perfRecentEventsString()}`
    ];
    _perfSpikeLastSummary = parts.join(' | ');
    if (typeof window !== 'undefined') {
        window.__castlePerfSpike = {
            at: now,
            summary: _perfSpikeLastSummary,
            events: _perfSpikeEvents.slice(-6)
        };
    }
    console.warn('[perf-spike]', _perfSpikeLastSummary);
}

function collectWorldPhysicsStats() {
    let dynAwake = 0;
    let dynSleep = 0;
    let dynTotal = 0;
    for (let i = 0; i < world.bodies.length; i++) {
        const b = world.bodies[i];
        if (!b || b.mass <= 0) continue;
        dynTotal++;
        if (b.sleepState === 0) dynAwake++;
        else dynSleep++;
    }
    const contacts = world.narrowphase && world.narrowphase.contactEquations
        ? world.narrowphase.contactEquations.length
        : 0;
    const constraints = world.constraints ? world.constraints.length : 0;
    return { dynAwake, dynSleep, dynTotal, contacts, constraints };
}

function collectStoryBodyRoleStats() {
    let bridgeAttached = 0;
    let bridgeDetached = 0;
    let castleAttached = 0;
    let castleDetached = 0;
    let bridgeDynAttached = 0;
    let castleDynAttached = 0;
    let bridgeAwake = 0;
    let castleAwake = 0;

    for (const b of bricks) {
        const body = b?.body;
        if (!body) continue;
        const role = b.storyRole || body._storyRole || 'castle';
        const attached = !!body.world;
        const dynamic = body.mass > 0;
        const awake = body.sleepState === 0;
        if (role === 'bridge') {
            if (attached) bridgeAttached++;
            else bridgeDetached++;
            if (attached && dynamic) bridgeDynAttached++;
            if (attached && dynamic && awake) bridgeAwake++;
        } else {
            if (attached) castleAttached++;
            else castleDetached++;
            if (attached && dynamic) castleDynAttached++;
            if (attached && dynamic && awake) castleAwake++;
        }
    }

    return {
        bridgeAttached,
        bridgeDetached,
        castleAttached,
        castleDetached,
        bridgeDynAttached,
        castleDynAttached,
        bridgeAwake,
        castleAwake,
    };
}

function resetPerfDebugStats() {
    _perfDbgAccum = 0;
    _perfDbgFrames = 0;
    _perfDbgPhysicsMs = 0;
    _perfDbgRenderMs = 0;
    _perfDbgBroadphaseMs = 0;
    _perfDbgFrameMs = 0;
    _perfDbgAwakeBricks = 0;
    _perfDbgBodies = 0;
    _perfDbgBalls = 0;
    _perfDbgRagdolls = 0;
    _perfDbgSfxVoices = 0;
    _perfDbgSfxPending = 0;
    _perfDbgRumble = 0;
    _perfDbgSupportScan = false;
    _perfDbgDynAwake = 0;
    _perfDbgDynSleep = 0;
    _perfDbgDynTotal = 0;
    _perfDbgContacts = 0;
    _perfDbgConstraints = 0;
    _perfDbgWaterMs = 0;
    _perfDbgBridgeAiMs = 0;
}

const _ciRaycaster = new THREE.Raycaster();
let _ciNextSampleAt = 0;
function updateCursorInspector() {
    if (!cursorInspectorEnabled) return;
    const pill = document.getElementById('cursorInspectorPill');
    if (!pill) return;
    const now = performance.now();
    if (now < _ciNextSampleAt) return;
    _ciNextSampleAt = now + 120;

    const cam = window.__editorOverrideCamera || camera;
    _ciRaycaster.setFromCamera({ x: 0, y: 0 }, cam);
    const hits = _ciRaycaster.intersectObjects(scene.children, true);
    let hit = null;
    for (const h of hits) {
        const o = h.object;
        // Skip invisible chains, the camera-attached viewmodel, and the
        // per-blade grass detail layer (it would mask what's underneath).
        let skip = false, isCamChild = false, node = o;
        while (node) {
            if (!node.visible) { skip = true; break; }
            if (node === cam || node.isCamera) { isCamChild = true; break; }
            node = node.parent;
        }
        if (skip || isCamChild) continue;
        if (o === grassTuftsMesh) continue;
        hit = h;
        break;
    }
    if (!hit) { pill.style.display = 'none'; return; }

    const o = hit.object;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const matCol = mat && mat.color ? '#' + mat.color.getHexString() : '�';
    const label = o.name
        || (o.userData && Object.keys(o.userData).length ? `ud:${Object.keys(o.userData).join(',')}` : '')
        || '(unnamed)';
    const p = hit.point;
    const inst = (hit.instanceId !== undefined && hit.instanceId !== null) ? ` inst#${hit.instanceId}` : '';
    pill.textContent =
        `${label}${inst} � ${o.type}/${o.geometry ? o.geometry.type : '?'} � ${mat ? mat.type : 'no-mat'} ${matCol}`
        + ` � hit ${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)} � meshY ${o.position.y.toFixed(3)}`;
    pill.style.display = 'block';
}

function setPerfDebugEnabled(enabled) {
    _perfDebugEnabled = !!enabled;
    if (_perfDebugEnabled) {
        ensurePerfDebugOverlay();
        return;
    }
    resetPerfDebugStats();
    if (_perfDbgEl && _perfDbgEl.parentNode) _perfDbgEl.parentNode.removeChild(_perfDbgEl);
    _perfDbgEl = null;
}

const perfDebugToggleEl = document.getElementById('setPerfDebug');
if (perfDebugToggleEl) perfDebugToggleEl.checked = _perfDebugEnabled;

function ensurePerfDebugOverlay() {
    if (!_perfDebugEnabled || _perfDbgEl) return;
    const el = document.createElement('div');
    el.id = 'tempPerfDebug';
    el.style.position = 'fixed';
    el.style.left = '10px';
    el.style.top = 'calc(env(safe-area-inset-top, 0px) + 10px)';
    el.style.zIndex = '99999';
    el.style.pointerEvents = 'none';
    el.style.padding = '7px 9px';
    el.style.borderRadius = '8px';
    el.style.background = 'rgba(5, 12, 18, 0.82)';
    el.style.border = '1px solid rgba(130, 210, 255, 0.35)';
    el.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    el.style.fontSize = '11px';
    el.style.lineHeight = '1.35';
    el.style.color = '#cfefff';
    el.textContent = 'perf debug...';
    document.body.appendChild(el);
    _perfDbgEl = el;
}

function perfDebugMarkPhysics(ms) {
    if (!_perfDebugEnabled) return;
    _perfDbgPhysicsMs += ms;
}

function perfDebugMarkRender(ms) {
    if (!_perfDebugEnabled) return;
    _perfDbgRenderMs += ms;
}

function perfDebugMarkWater(ms) {
    if (!_perfDebugEnabled) return;
    _perfDbgWaterMs += ms;
}

function perfDebugMarkBridgeAi(ms) {
    if (!_perfDebugEnabled) return;
    _perfDbgBridgeAiMs += ms;
}

function perfDebugMarkFrame(rawDt, awakeBricks, supportScanRan) {
    if (!_perfDebugEnabled) return;
    ensurePerfDebugOverlay();
    _perfDbgAccum += rawDt;
    _perfDbgFrames++;
    _perfDbgFrameMs += rawDt * 1000;
    _perfDbgAwakeBricks += awakeBricks;
    _perfDbgBodies += world.bodies.length;
    _perfDbgBalls += cannonballs.length;
    _perfDbgRagdolls += getActiveRagdollBodyCount();
    _perfDbgSfxVoices += activeSfxCueVoices;
    _perfDbgSfxPending += (sfxPrecacheQueue.length + sfxBufferLoads.size);
    _perfDbgRumble += masonryRumbleLevel;
    const pstats = collectWorldPhysicsStats();
    _perfDbgDynAwake += pstats.dynAwake;
    _perfDbgDynSleep += pstats.dynSleep;
    _perfDbgDynTotal += pstats.dynTotal;
    _perfDbgContacts += pstats.contacts;
    _perfDbgConstraints += pstats.constraints;
    _perfDbgEmergency = _mobilePerfEmergency;
    if (supportScanRan) _perfDbgSupportScan = true;
    if (_perfDbgAccum < 0.5 || !_perfDbgEl) return;

    const avgFps = _perfDbgFrames / _perfDbgAccum;
    const avgFrame = _perfDbgFrameMs / _perfDbgFrames;
    const avgPhys = _perfDbgPhysicsMs / _perfDbgFrames;
    const avgRender = _perfDbgRenderMs / _perfDbgFrames;
    const avgBroadphase = _perfDbgBroadphaseMs / _perfDbgFrames;
    const avgWater = _perfDbgWaterMs / _perfDbgFrames;
    const avgBridgeAi = _perfDbgBridgeAiMs / _perfDbgFrames;
    const avgAwake = Math.round(_perfDbgAwakeBricks / _perfDbgFrames);
    const avgBodies = Math.round(_perfDbgBodies / _perfDbgFrames);
    const avgBalls = (_perfDbgBalls / _perfDbgFrames).toFixed(1);
    const avgRagdolls = (_perfDbgRagdolls / _perfDbgFrames).toFixed(1);
    const avgSfxVoices = (_perfDbgSfxVoices / _perfDbgFrames).toFixed(1);
    const avgSfxPending = (_perfDbgSfxPending / _perfDbgFrames).toFixed(1);
    const avgRumble = (_perfDbgRumble / _perfDbgFrames).toFixed(2);
    const avgDynAwake = Math.round(_perfDbgDynAwake / _perfDbgFrames);
    const avgDynSleep = Math.round(_perfDbgDynSleep / _perfDbgFrames);
    const avgDynTotal = Math.round(_perfDbgDynTotal / _perfDbgFrames);
    const avgContacts = Math.round(_perfDbgContacts / _perfDbgFrames);
    const avgConstraints = Math.round(_perfDbgConstraints / _perfDbgFrames);
    const roleStats = collectStoryBodyRoleStats();

    const avgFpsNum = avgFps;
    const avgFrameNum = avgFrame;
    const avgPhysNum = avgPhys;
    const avgRenderNum = avgRender;
    const avgAwakeNum = avgAwake;
    const avgBodiesNum = avgBodies;
    const avgRagdollsNum = Number(avgRagdolls);
    const avgSfxPendingNum = Number(avgSfxPending);
    const avgDynAwakeNum = avgDynAwake;
    const avgDynTotalNum = avgDynTotal;
    const avgContactsNum = avgContacts;
    const avgConstraintsNum = avgConstraints;

    if (rawDt > 0.12 || avgFpsNum < 18) {
        perfCaptureSpike(rawDt > 0.12 ? 'long-frame' : 'low-fps', {
            fps: avgFpsNum,
            frame: avgFrameNum,
            phys: avgPhysNum,
            render: avgRenderNum,
            awake: avgAwakeNum,
            bodies: avgBodiesNum,
            ragdolls: avgRagdollsNum,
            dynAwake: avgDynAwakeNum,
            dynTotal: avgDynTotalNum,
            contacts: avgContactsNum,
            constraints: avgConstraintsNum,
            pending: avgSfxPendingNum
        });
    }

    _perfDbgEl.textContent =
`fps ${avgFps.toFixed(1)} | frame ${avgFrame.toFixed(1)}ms\n` +
`phys ${avgPhys.toFixed(1)}ms | render ${avgRender.toFixed(1)}ms\n` +
`broadphase ${avgBroadphase.toFixed(1)}ms (${_broadphaseMode})\n` +
`waterAnim ${avgWater.toFixed(1)}ms | bridgeAI ${avgBridgeAi.toFixed(1)}ms\n` +
`awake ${avgAwake} | bodies ${avgBodies} | balls ${avgBalls} | ragdolls ${avgRagdolls}\n` +
`dyn ${avgDynTotal} | dynAwake ${avgDynAwake} | dynSleep ${avgDynSleep}\n` +
`storyBodies bridge ${roleStats.bridgeAttached}/${roleStats.bridgeAttached + roleStats.bridgeDetached} | castle ${roleStats.castleAttached}/${roleStats.castleAttached + roleStats.castleDetached}\n` +
`storyDyn bridge ${roleStats.bridgeDynAttached} awake ${roleStats.bridgeAwake} | castle ${roleStats.castleDynAttached} awake ${roleStats.castleAwake}\n` +
`contacts ${avgContacts} | constraints ${avgConstraints}\n` +
`sfxVoices ${avgSfxVoices} | sfxPending ${avgSfxPending} | rumble ${avgRumble}\n` +
`supportScan ${_perfDbgSupportScan ? 'yes' : 'no'} | emergency ${_perfDbgEmergency ? 'on' : 'off'}\n` +
`recent ${perfRecentEventsString()}\n` +
`lastSpike ${_perfSpikeLastSummary}`;

    resetPerfDebugStats();
}

// Optional on-screen FPS counter (toggle via Settings).
var fpsCounterEnabled = true;
var _fpsBadge = null;
var _fpsAccum = 0;
var _fpsFrames = 0;
var _fpsWorstDt = 0;
var _fpsSmooth = 60;
function setFpsCounterEnabled(enabled) {
    fpsCounterEnabled = !!enabled;
    if (!fpsCounterEnabled) {
        if (_fpsBadge && _fpsBadge.parentNode) _fpsBadge.parentNode.removeChild(_fpsBadge);
        _fpsBadge = null;
        _fpsAccum = 0;
        _fpsFrames = 0;
        _fpsWorstDt = 0;
    }
}
function ensureFpsBadge() {
    if (!fpsCounterEnabled || _fpsBadge) return;
    const el = document.createElement('div');
    el.id = 'tempFpsBadge';
    el.style.position = 'fixed';
    el.style.top = '13px';
    el.style.right = '204px'; // sits inline to the left of the dev-menu button
    el.style.height = '36px';
    el.style.boxSizing = 'border-box';
    el.style.display = 'inline-flex';
    el.style.alignItems = 'center';
    el.style.zIndex = '300';
    el.style.pointerEvents = 'none';
    el.style.padding = '0 12px';
    el.style.borderRadius = '8px';
    el.style.background = 'rgba(8, 14, 19, 0.72)';
    el.style.border = '1px solid rgba(255, 255, 255, 0.20)';
    el.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    el.style.fontSize = '12px';
    el.style.lineHeight = '1';
    el.style.color = '#e6f1f7';
    el.textContent = 'FPS --';
    document.body.appendChild(el);
    _fpsBadge = el;
}
function updateFpsBadge(dt) {
    if (!fpsCounterEnabled || dt <= 0) return;
    ensureFpsBadge();
    if (!_fpsBadge) return;
    _fpsAccum += dt;
    _fpsFrames++;
    _fpsWorstDt = Math.max(_fpsWorstDt, dt);
    const instFps = 1 / dt;
    _fpsSmooth = _fpsSmooth * 0.90 + instFps * 0.10;
    if (_fpsAccum < 0.25) return;
    const avgFps = _fpsFrames / _fpsAccum;
    _fpsBadge.textContent = `FPS ${avgFps.toFixed(1)}`;
    _fpsAccum = 0;
    _fpsFrames = 0;
    _fpsWorstDt = 0;
}

// === Polish: camera shake, hit markers, floating score popups ===
// Camera shake � "trauma" decays each frame; the applied angle is trauma� so it
// fades out smoothly. Only the P1 camera shakes (it's set from yaw/pitch every
// frame, so the jitter never accumulates). Respects the slow-mo/quality vibe by
// staying subtle.
let _shakeTrauma = 0;
function addShake(amount) { _shakeTrauma = Math.min(1, _shakeTrauma + amount); }

// Hit marker + crosshair flash � driven by a timestamp so rapid (minigun) hits
// just refresh the timer instead of spawning DOM each shot.
const _hitMarkerEl = document.getElementById('hitMarker');
const _crosshairEl = document.getElementById('crosshair');
let _hitMarkerUntil = 0;
let _hitFlashUntil  = 0;
let _headshotFlashUntil = 0;
function showHitMarker(isKill, isHeadshot = false) {
    const now = performance.now();
    _hitMarkerEl.classList.toggle('kill', !!isKill);
    _hitMarkerUntil = now + (isKill ? 320 : 180);
    _hitFlashUntil  = now + 110;
    if (_crosshairEl) {
        _crosshairEl.classList.add('hit');
        if (isHeadshot) {
            _headshotFlashUntil = now + 95;
            _crosshairEl.classList.add('headshot');
        }
    }
}
function updateHitFx() {
    const now = performance.now();
    _hitMarkerEl.style.opacity = now < _hitMarkerUntil
        ? String(Math.max(0, (_hitMarkerUntil - now) / 180)) : '0';
    if (_crosshairEl && now > _hitFlashUntil) _crosshairEl.classList.remove('hit');
    if (_crosshairEl && now > _headshotFlashUntil) _crosshairEl.classList.remove('headshot');
}

// Floating "+N" score popups � world position projected to screen. Brick scores
// are aggregated over a short window so a big collapse shows one tidy "+120"
// rather than a blizzard of "+10"s. NPC kills pop immediately.
const _popupsEl = document.getElementById('popups');
const _popProj  = new THREE.Vector3();
const MAX_ACTIVE_POPUPS = isMobileProfile ? 24 : 64;
function spawnScorePopup(worldX, worldY, worldZ, text, cls) {
    if (!_popupsEl) return;
    _popProj.set(worldX, worldY, worldZ).project(camera);
    if (_popProj.z > 1) return;  // behind the camera
    const sx = (_popProj.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-_popProj.y * 0.5 + 0.5) * window.innerHeight;
    while (_popupsEl.childElementCount >= MAX_ACTIVE_POPUPS && _popupsEl.firstElementChild) {
        _popupsEl.firstElementChild.remove();
    }
    const el = document.createElement('div');
    el.className = 'popup' + (cls ? ' ' + cls : '');
    el.textContent = text;
    el.style.left = sx + 'px';
    el.style.top  = sy + 'px';
    _popupsEl.appendChild(el);
    const fallbackMs = (cls && String(cls).includes('speech')) ? 2400 : 1400;
    const fallbackKill = setTimeout(() => el.remove(), fallbackMs);
    el.addEventListener('animationend', () => {
        clearTimeout(fallbackKill);
        el.remove();
    }, { once: true });
}
const TOWER_GUARD_TAUNTS = [
    'Brilliant. You missed the entire castle.',
    'Oh good, a cannon. Very dramatic.',
    'Is that your best, or a warm-up?',
    'Right, I\'ll just stand here then.',
    'Lovely trajectory. Shame about the aim.',
    'You know walls don\'t dodge, yeah?',
    'We\'ve got all day. You haven\'t.',
    'That\'s going on your permanent record.',
    'Structural damage: zero. Embarrassment: high.',
    'Do carry on. I\'ve got snacks.',
    'Bold strategy. Very bold. Very wrong.',
    'The wall sends its regards.',
    'Technically, that\'s called a miss.',
    'I\'d clap but I\'m holding a bow.',
    'Statistically, you\'ll hit something eventually.',
    'Oh very dramatic. Nothing moved.',
    'Top tier siege work. Truly.',
    'I\'ve seen better aim from a falling trebuchet.',
    'You had one job.',
    'At this rate we\'ll all retire naturally.',
    'Oi, peasant! Yeah, you.',
    'You\'re getting mashed up, no cap.',
    'Mate. MATE. Look at the state of you.',
    'Absolute melt, this one.',
    'You\'re about to catch these gauntlets.',
    'Proper liberty you\'re taking, brah.',
    'Bro thinks he\'s a siege engine.',
    'Certified peasant behaviour, that.',
    'You\'re done, fam. Dusted. Finished.',
    'It\'s giving... peasant.',
    'On the wall\'s life, you\'re getting folded.',
    'Touch grass, peasant. Oh wait—',
];
const DRONE_FEAR_TAUNTS = [
    'THAT IS NOT A BIRD—',
    'I WANT TO SPEAK TO THE KING—',
    'ABORT. ABORT EVERYTHING—',
    'No no no no no no—',
    'WELL THIS IS UNACCEPTABLE—',
    'I DID NOT SIGN UP FOR THIS—',
    'OHH IT\'S FOLLOWING ME—',
    'STRATEGICALLY RETREATING—',
    'Right. I am OFF—',
    'WHY DOES IT HAVE EYES—',
    'EVERY MAN FOR HIMSELF—',
    'THAT IS CHEATING THAT IS—',
    'I QUIT I QUIT I QUIT—',
    'WHERE IS HR WHEN YOU NEED THEM—',
    'NOT IN THE JOB DESCRIPTION—',
    'I AM HAVING A TERRIBLE DAY—',
    'INCOMING EVERYTHING—',
    'RIGHT THAT\'S IT I\'M MOVING COUNTRY—',
    'Oh for the love of — RUN—',
    'GET IT AWAY FROM ME—',
    'NAH. NAH NAH NAH. I\'M OUT—',
    'IT\'S LOCKED ON, FAM—',
    'THAT THING\'S MOVING MAD—',
];
const DRONE_FEAR_RADIUS  = 28;   // m - NPCs spot the drone
const DRONE_CRAWL_RADIUS =  8;   // m - NPCs dive for cover

function updateDronePanic(dt) {
    const droneActive = !!(activeDrone && !activeDrone.detonated);
    for (const npc of npcList) {
        if (npc.isRagdoll) continue;
        if (!droneActive) {
            if ((npc.droneFear || 0) > 0) npc.droneFear = Math.max(0, npc.droneFear - dt * 0.8);
            continue;
        }
        const gp = npc.group.position;
        const dp = activeDrone.body.position;
        const ddx = gp.x - dp.x, ddz = gp.z - dp.z;
        const dist = Math.sqrt(ddx * ddx + ddz * ddz);
        if (dist > DRONE_FEAR_RADIUS) {
            npc.droneFear = Math.max(0, (npc.droneFear || 0) - dt * 0.5);
            continue;
        }
        const fearStr = 1 - dist / DRONE_FEAR_RADIUS;
        npc.droneFear = Math.min(1, (npc.droneFear || 0) + fearStr * dt * 3.0);
        if (!npc.isTowerGuard && !npc.storyDormant) {
            npc.walking = true;
            npc.speedMul = 2.8 + fearStr * 2.0;           // 2.8�4.8� sprint
        }
        if (dist < DRONE_CRAWL_RADIUS && !npc.isTowerGuard) {
            npc.crawlMode = true;
            npc.crawlHold = Math.max(npc.crawlHold || 0, 1.5 + Math.random() * 1.4);
        }
        // Drone-specific screams (bypass quiet gate, use own cooldown)
        if ((npc.droneFear || 0) > 0.25 && (npc.droneTauntCooldown || 0) <= 0 && Math.random() < 0.006) {
            const now = performance.now();
            if (now - _npcGlobalTauntMs >= 2200) {
                _npcGlobalTauntMs = now;
                spawnNpcTaunt(npc, DRONE_FEAR_TAUNTS[(Math.random() * DRONE_FEAR_TAUNTS.length) | 0]);
                npc.droneTauntCooldown = 3.5 + Math.random() * 3;
            }
        }
        if ((npc.droneTauntCooldown || 0) > 0) npc.droneTauntCooldown -= dt;
    }
}
const HUT_CHARGER_TAUNT_INTERVAL = 55.0;
const NPC_TAUNT_INTERVAL_BASE = 55.0;     // per-NPC minimum between taunts
const NPC_TAUNT_INTERVAL_JITTER = 25.0;
const BRIDGE_TAUNT_INTERVAL_BASE = 60.0;
const BRIDGE_TAUNT_INTERVAL_JITTER = 25.0;
// Global taunt governor: at most one NPC speaks every N seconds.
const NPC_GLOBAL_TAUNT_GAP_MS = 5000;
// Quiet window: no shot for this long ? idle taunts are allowed.
const NPC_IDLE_QUIET_MS = 10000;
// Danger window: blast within this radius/age lets nearby NPCs react.
const NPC_DANGER_RADIUS2 = 22 * 22;
const NPC_DANGER_WINDOW_MS = 5000;
let _npcGlobalTauntMs = 0;    // ms timestamp of the last any-NPC taunt
let _lastPlayerShotMs = 0;    // updated in markSfxCombatActivity
let _lastImpactMs = 0;        // updated in triggerBlast + heavy cannonball hit
const _lastImpactPos = { x: 0, z: 0 };
const _skinColorHappy  = new THREE.Color(0xf0c080); // warm skin
const _skinColorAngry  = new THREE.Color(0xd86848); // pinkish-red flush (not full crimson)
const _skinColorScratch = new THREE.Color();
const NPC_TRIP_CHECK_MIN = 0.16;
const NPC_TRIP_CHECK_JITTER = 0.22;
const NPC_TRIP_RADIUS = 0.95;
const NPC_TRIP_RUBBLE_MIN_SCORE = 2.4;
const NPC_TRIP_BASE_CHANCE = 0.22;
const NPC_MAX_STEP_UP = 0.32;
const NPC_CLIMB_RATE = 0.85;
const NPC_CRAWL_TRIGGER_STUCK = 0.36;
const NPC_CRAWL_DEBRIS_SCORE_MIN = 2.2;
const NPC_CRAWL_SPEED_SCALE = 0.5;
const NPC_CRAWL_COLLISION_R = 0.2;
const NPC_CRAWL_MIN_HOLD = 1.0;
const NPC_PANIC_SWIM_MIN_SEC = isMobileProfile ? 1.5 : 2.8;
const NPC_PANIC_SWIM_MAX_SEC = isMobileProfile ? 2.8 : 4.8;
const NPC_PANIC_SWIM_DRIFT_SPEED = isMobileProfile ? 0.42 : 0.56;
const NPC_PANIC_SWIM_BOB_AMP = isMobileProfile ? 0.10 : 0.20;
const NPC_PANIC_SWIM_SURFACE_OFFSET = 0.36;
const NPC_PANIC_SWIM_TAUNTS = [
    'Help!', 'Glub!', 'Nooo!', 'Save me!', 'Blurgh!',
    'Can\'t swim in chainmail, FYI—',
    'This is bare cold—',
    'Who put water here—',
];
function spawnNpcTaunt(npc, text) {
    const p = npc.group.position;
    spawnScorePopup(p.x, p.y + 2.1, p.z, text, 'speech');
}
// Gated taunt: respects global gap, per-NPC cooldown, and whether the
// situation warrants speech (quiet spell OR the NPC is near a recent blast).
function tryNpcTaunt(npc, text) {
    if ((npc.tauntCooldown || 0) > 0) return;
    const now = performance.now();
    if (now - _npcGlobalTauntMs < NPC_GLOBAL_TAUNT_GAP_MS) return;
    const quiet = now - _lastPlayerShotMs > NPC_IDLE_QUIET_MS;
    const gp = npc.group ? npc.group.position : null;
    const nearBlast = gp && (now - _lastImpactMs < NPC_DANGER_WINDOW_MS)
        && ((gp.x - _lastImpactPos.x) ** 2 + (gp.z - _lastImpactPos.z) ** 2) < NPC_DANGER_RADIUS2;
    const isAngry = (npc.angerLevel || 0) > 0.2;
    if (!quiet && !nearBlast && !isAngry) return;
    _npcGlobalTauntMs = now;
    spawnNpcTaunt(npc, text);
    npc.tauntCooldown = NPC_TAUNT_INTERVAL_BASE + Math.random() * NPC_TAUNT_INTERVAL_JITTER;
}
const _damageDirEl = document.getElementById('damageDir');
const _damageDirTimers = { up: 0, right: 0, down: 0, left: 0 };
function showDamageDirection(attackerPos) {
    if (!_damageDirEl || !attackerPos) return;
    const dx = attackerPos.x - camera.position.x;
    const dz = attackerPos.z - camera.position.z;
    const fyx = -Math.sin(yaw), fyz = -Math.cos(yaw);
    const rtx = Math.cos(yaw), rtz = -Math.sin(yaw);
    const fwd = dx * fyx + dz * fyz;
    const side = dx * rtx + dz * rtz;
    let dir = 'up';
    if (Math.abs(side) > Math.abs(fwd)) dir = side >= 0 ? 'right' : 'left';
    else dir = fwd >= 0 ? 'up' : 'down';

    _damageDirTimers[dir] = performance.now() + 380;
    _damageDirEl.classList.add(dir);
}
function updateDamageDirectionFx() {
    if (!_damageDirEl) return;
    const now = performance.now();
    for (const k of ['up', 'right', 'down', 'left']) {
        if (now > _damageDirTimers[k]) _damageDirEl.classList.remove(k);
    }
}
function onPlayerHitFrom(attackerPos) {
    showDamageDirection(attackerPos);
    onPlayerHit();
}

function beginNpcPanicSwim(npc, cause = 'water') {
    if (!WATER_SYSTEM_ENABLED || !npc || npc.isRagdoll || !npc.group) return false;
    const gp = npc.group.position;
    const waterY = getWaterSurfaceYAtXZ(gp.x, gp.z, false);
    if (waterY == null) return false;
    if (npc.npcPanicSwim) return true;

    const a = Math.random() * Math.PI * 2;
    npc.npcPanicSwim = {
        cause,
        elapsed: 0,
        drownAt: NPC_PANIC_SWIM_MIN_SEC + Math.random() * (NPC_PANIC_SWIM_MAX_SEC - NPC_PANIC_SWIM_MIN_SEC),
        driftX: Math.cos(a),
        driftZ: Math.sin(a),
        phase: Math.random() * Math.PI * 2,
        waterY,
        splashTimer: 0.08 + Math.random() * 0.10,
    };

    npc.vy = 0;
    npc.crawlMode = false;
    npc.crawlHold = 0;
    npc.bridgeTurnLock = false;
    npc.storyBridgeFalling = false;
    npc.fallingWithTower = false;
    if ((npc.tauntCooldown || 0) <= 0 && Math.random() < 0.75) {
        spawnNpcTaunt(npc, NPC_PANIC_SWIM_TAUNTS[(Math.random() * NPC_PANIC_SWIM_TAUNTS.length) | 0]);
        npc.tauntCooldown = 1.1 + Math.random() * 1.1;
    }

    const entryRippleY = getWaterVisualSurfaceYAtXZ(gp.x, gp.z) ?? waterY;
    spawnWaterImpactRipple(gp.x, gp.z, entryRippleY, 5.4, getRippleRoleAtXZ(gp.x, gp.z));
    return true;
}

function updateNpcPanicSwim(npc, dt) {
    const ps = npc?.npcPanicSwim;
    if (!ps || npc.isRagdoll || !npc.group) return false;

    const gp = npc.group.position;
    const waterY = getWaterSurfaceYAtXZ(gp.x, gp.z);
    if (waterY == null) {
        npc.npcPanicSwim = null;
        return false;
    }

    ps.elapsed += dt;
    ps.waterY = THREE.MathUtils.lerp(ps.waterY, waterY, Math.min(1, dt * 4.0));

    ps.driftX += (Math.random() - 0.5) * dt * 0.75;
    ps.driftZ += (Math.random() - 0.5) * dt * 0.75;
    const dl = Math.hypot(ps.driftX, ps.driftZ) || 1;
    ps.driftX /= dl;
    ps.driftZ /= dl;

    const driftSpeed = NPC_PANIC_SWIM_DRIFT_SPEED * (0.85 + Math.sin(ps.elapsed * 3.3 + ps.phase) * 0.25);
    gp.x += ps.driftX * driftSpeed * dt;
    gp.z += ps.driftZ * driftSpeed * dt;

    const bob = Math.sin(ps.elapsed * 8.5 + ps.phase) * NPC_PANIC_SWIM_BOB_AMP
        + Math.sin(ps.elapsed * 14.2 + ps.phase * 1.7) * (NPC_PANIC_SWIM_BOB_AMP * 0.45);
    const targetY = ps.waterY + NPC_PANIC_SWIM_SURFACE_OFFSET + bob;
    gp.y = THREE.MathUtils.lerp(gp.y, targetY, Math.min(1, dt * 8.5));

    npc.group.rotation.y += Math.sin(ps.elapsed * 4.4 + ps.phase) * dt * 0.9;

    if (npc.anim) {
        // True alternating windmill: opposite phases so one arm is up while the other is down.
        const wave = ps.elapsed * 11.5;
        const waveL = Math.sin(wave + ps.phase);
        const waveR = Math.sin(wave + ps.phase + Math.PI); // exactly opposite � real windmill
        // Full arc: from pointing forward/up (-2.3) through hanging down (0) to behind (+1.9).
        npc.anim.armL.rotation.x = -0.15 + waveL * 2.15;
        npc.anim.armR.rotation.x = -0.15 + waveR * 2.15;
        // Lateral spread: arms pulse outward for a desperate splashing silhouette.
        const spread = 0.45 + Math.abs(Math.sin(ps.elapsed * 6.2 + ps.phase)) * 0.65;
        npc.anim.armL.rotation.z = -spread;
        npc.anim.armR.rotation.z =  spread;
        // Vigorous alternating leg kick.
        npc.anim.legL.rotation.x = Math.sin(ps.elapsed * 10.8 + ps.phase) * 0.85;
        npc.anim.legR.rotation.x = -Math.sin(ps.elapsed * 10.8 + ps.phase) * 0.85;
    }

    ps.splashTimer -= dt;
    if (ps.splashTimer <= 0) {
        const splashSpeed = 2.2 + Math.random() * 2.0;
        const splashRippleY = getWaterVisualSurfaceYAtXZ(gp.x, gp.z) ?? ps.waterY;
        spawnWaterImpactRipple(gp.x, gp.z, splashRippleY, splashSpeed, getRippleRoleAtXZ(gp.x, gp.z));
        ps.splashTimer = 0.22 + Math.random() * 0.28;
    }

    if (ps.elapsed >= ps.drownAt) {
        activateRagdoll(npc, null, false);
        if (npc.ragdollParts && npc.ragdollParts.length > 0) {
            for (const rp of npc.ragdollParts) {
                if (!rp.body) continue;
                rp.body.wakeUp();
                rp.body.angularVelocity.x += (Math.random() - 0.5) * 1.6;
                rp.body.angularVelocity.z += (Math.random() - 0.5) * 1.6;
                if (rp.body.velocity.y > 1.2) rp.body.velocity.y = 1.2;
            }
        }
        return true;
    }

    return true;
}

// Lightweight NPC-vs-solid collision resolver for standing/walking guards.
// Bricks deliberately ignore CGROUP_NPC in cannon-es to keep NPCs from pushing
// walls, so we do a cheap kinematic push-out here to stop visual clipping.
function resolveNpcSolidCollision(np, footY, r = 0.34) {
    let bestPushX = 0;
    let bestPushZ = 0;
    let liftTargetY = -Infinity;
    const berth = 0.10;        // keep a little stand-off from surfaces
    const minPen = 0.025;      // ignore tiny penetrations to stop jitter
    const maxStepLift = 0.46;  // prevent sudden pop-ups from deep overlaps
    for (const b of getFrameActiveBricks()) {
        if (!b || !b.body) continue;
        const bp = b.body.position;
        if (Math.abs(bp.y - footY) > 1.65) continue;
        let hx = BS.w / 2, hy = BS.h / 2, hz = BS.d / 2;
        if (b.isLintel) {
            hx = (b.spanAxis === 'x') ? b.halfSpan : BS.d / 2;
            hy = BS.d / 2;
            hz = (b.spanAxis === 'z') ? b.halfSpan : BS.d / 2;
        } else if (b.isPlank) {
            const halfLen = (PS.w / 2) * (b.lenScale || 1);
            hx = b.isZ ? PT / 2 : halfLen;
            hy = PS.h / 2;
            hz = b.isZ ? halfLen : PT / 2;
        } else if (b.isWedge) {
            hx = BS.w / 2;
            hy = BS.w / 2;
            hz = BS.w / 2;
        } else {
            if (b.isCube) {
                hx = BS.h / 2;
                hy = BS.h / 2;
                hz = BS.h / 2;
            } else if (b.isY) {
                hx = BS.h / 2;
                hy = BS.w / 2;
                hz = BS.d / 2;
            } else {
                hx = b.isZ ? BS.d / 2 : WALL_BRICK_HALF_LEN;
                hy = BS.h / 2;
                hz = b.isZ ? WALL_BRICK_HALF_LEN : BS.d / 2;
            }
        }
        if (b.body.aabb) {
            const aabb = b.body.aabb;
            const ax = (aabb.upperBound.x - aabb.lowerBound.x) * 0.5;
            const ay = (aabb.upperBound.y - aabb.lowerBound.y) * 0.5;
            const az = (aabb.upperBound.z - aabb.lowerBound.z) * 0.5;
            if (ax > hx) hx = ax;
            if (ay > hy) hy = ay;
            if (az > hz) hz = az;
        }

        const vv = b.body.velocity;
        const speed2 = vv ? (vv.x * vv.x + vv.y * vv.y + vv.z * vv.z) : 0;
        const unstable = b.body.sleepState === 0 || speed2 > 0.7;
        const localBerth = unstable ? (berth + 0.05) : berth;
        const localMinPen = unstable ? (minPen * 0.5) : minPen;

        const ex = hx + r, ez = hz + r;
        const dx = np.x - bp.x, dz = np.z - bp.z;
        const px = ex - Math.abs(dx);
        const pz = ez - Math.abs(dz);
        if (px <= 0 || pz <= 0) continue;
        if (px < localMinPen && pz < localMinPen) continue;

        const topY = b.body.aabb ? b.body.aabb.upperBound.y : (bp.y + hy);
        const desiredNpcY = topY - 1.1 + 0.03;
        if (desiredNpcY > np.y && desiredNpcY - np.y <= maxStepLift) {
            liftTargetY = Math.max(liftTargetY, desiredNpcY);
        }

        if (px < pz) {
            const push = (dx >= 0 ? (px + localBerth) : -(px + localBerth));
            if (Math.abs(push) > Math.abs(bestPushX)) bestPushX = push;
        } else {
            const push = (dz >= 0 ? (pz + localBerth) : -(pz + localBerth));
            if (Math.abs(push) > Math.abs(bestPushZ)) bestPushZ = push;
        }
        if (unstable && vv) {
            const shoveScale = Math.min(0.11, 0.035 + Math.sqrt(speed2) * 0.012);
            bestPushX += vv.x * shoveScale;
            bestPushZ += vv.z * shoveScale;
        }
    }
    // Apply only the dominant axis correction once for this frame.
    if (Math.abs(bestPushX) > Math.abs(bestPushZ)) {
        const clamped = Math.max(-0.42, Math.min(0.42, bestPushX));
        np.x += clamped;
    } else {
        const clamped = Math.max(-0.42, Math.min(0.42, bestPushZ));
        np.z += clamped;
    }
    if (Number.isFinite(liftTargetY)) np.y = Math.max(np.y, liftTargetY);
}

function getNpcRubbleScore(np, radius = 1.2) {
    const rr2 = radius * radius;
    let score = 0;
    for (const b of getFrameActiveBricks()) {
        if (!b || !b.body) continue;
        const bp = b.body.position;
        const dx = bp.x - np.x;
        const dz = bp.z - np.z;
        if (dx * dx + dz * dz > rr2) continue;
        if (bp.y < np.y - 0.9 || bp.y > np.y + 1.05) continue;

        const moved =
            Math.abs(bp.x - (b.ix ?? bp.x)) > 0.18
            || Math.abs(bp.y - (b.iy ?? bp.y)) > 0.18
            || Math.abs(bp.z - (b.iz ?? bp.z)) > 0.18;
        const vv = b.body.velocity;
        const unstable = vv && (vv.x * vv.x + vv.y * vv.y + vv.z * vv.z) > 0.2;
        if (!moved && !unstable) continue;

        score += moved ? 1.0 : 0.45;
        if (unstable) score += 0.7;
        if (b.body.sleepState === 0) score += 0.3;
        if (score >= 5.2) break;
    }
    return score;
}

function maybeTripNpcOnRubble(npc, dt) {
    if (!npc || npc.isRagdoll || !npc.group || npc.storyDormant) return false;
    if (npc.isTowerGuard || npc.fallingWithTower) return false;
    if (npc.storyRole === 'bridge') return false;

    npc.tripCheckCooldown = Math.max(0, (npc.tripCheckCooldown || 0) - dt);
    if ((npc.tripCheckCooldown || 0) > 0) return false;
    npc.tripCheckCooldown = NPC_TRIP_CHECK_MIN + Math.random() * NPC_TRIP_CHECK_JITTER;

    const np = npc.group.position;
    const nearWater = isInMoatWaterXZ(np.x, np.z)
        || isInMoatWaterXZ(np.x + 1.2, np.z)
        || isInMoatWaterXZ(np.x - 1.2, np.z)
        || isInMoatWaterXZ(np.x, np.z + 1.2)
        || isInMoatWaterXZ(np.x, np.z - 1.2);
    const rr2 = NPC_TRIP_RADIUS * NPC_TRIP_RADIUS;
    let rubbleScore = 0;
    for (const b of getFrameActiveBricks()) {
        if (!b || !b.body) continue;
        const bp = b.body.position;
        const dx = bp.x - np.x;
        const dz = bp.z - np.z;
        if (dx * dx + dz * dz > rr2) continue;
        if (bp.y < np.y - 0.75 || bp.y > np.y + 1.05) continue;

        const moved =
            Math.abs(bp.x - (b.ix ?? bp.x)) > 0.18
            || Math.abs(bp.y - (b.iy ?? bp.y)) > 0.18
            || Math.abs(bp.z - (b.iz ?? bp.z)) > 0.18;
        const vv = b.body.velocity;
        const unstable = vv && (vv.x * vv.x + vv.y * vv.y + vv.z * vv.z) > 0.2;
        if (!moved && !unstable) continue;

        rubbleScore += moved ? 1.0 : 0.5;
        if (unstable) rubbleScore += 0.7;
        if (b.body.sleepState === 0) rubbleScore += 0.35;
        if (rubbleScore >= NPC_TRIP_RUBBLE_MIN_SCORE + 1.2) break;
    }
    if (rubbleScore < NPC_TRIP_RUBBLE_MIN_SCORE) return false;

    const chance = nearWater
        ? Math.min(0.78, NPC_TRIP_BASE_CHANCE + 0.08 + (rubbleScore - NPC_TRIP_RUBBLE_MIN_SCORE) * 0.14)
        : Math.min(0.62, NPC_TRIP_BASE_CHANCE + (rubbleScore - NPC_TRIP_RUBBLE_MIN_SCORE) * 0.10);
    if (Math.random() > chance) return false;

    let dirX = 0;
    let dirZ = 0;
    let bestSteps = Infinity;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[0.707,0.707],[0.707,-0.707],[-0.707,0.707],[-0.707,-0.707]];
    for (const d of dirs) {
        for (let s = 1; s <= 6; s++) {
            const tx = np.x + d[0] * s * 1.2;
            const tz = np.z + d[1] * s * 1.2;
            if (!isInMoatWaterXZ(tx, tz)) continue;
            if (s < bestSteps) {
                bestSteps = s;
                dirX = d[0];
                dirZ = d[1];
            }
            break;
        }
    }
    if (!Number.isFinite(bestSteps)) {
        if (!nearWater) {
            // Dry-rubble trip: stumble into a crawl instead of instant death.
            npc.crawlMode = true;
            npc.crawlHold = Math.max(npc.crawlHold || 0, 1.35 + Math.random() * 0.75);
            npc.stuckTimer = Math.max(npc.stuckTimer || 0, 0.65);
            np.x += (Math.random() - 0.5) * 0.18;
            np.z += (Math.random() - 0.5) * 0.14;
            return true;
        }
        const heading = npc.group.rotation.y + (Math.random() - 0.5) * 1.8;
        dirX = Math.sin(heading);
        dirZ = Math.cos(heading);
    }
    const dl = Math.hypot(dirX, dirZ) || 1;
    dirX /= dl;
    dirZ /= dl;

    if (nearWater && beginNpcPanicSwim(npc, 'trip')) {
        return true;
    }

    activateRagdoll(npc, null);
    if (npc.ragdollParts && npc.ragdollParts.length > 0) {
        for (const rp of npc.ragdollParts) {
            if (!rp.body) continue;
            rp.body.wakeUp();
            const shove = nearWater ? (7.0 + Math.random() * 2.8) : (3.2 + Math.random() * 1.3);
            const up = nearWater ? (0.7 + Math.random() * 0.6) : (0.45 + Math.random() * 0.4);
            rp.body.applyImpulse(
                new CANNON.Vec3(dirX * shove, up, dirZ * shove),
                rp.body.position
            );
            // Keep trips as knockdowns, not sky launches.
            const v = rp.body.velocity;
            if (v.y > 2.4) v.y = 2.4;
        }
    }
    return true;
}
// Brick-score aggregator state.
let _popAccum = 0, _popLastFlush = 0;
const _popPos = new THREE.Vector3();
function addBrickScorePopup(x, y, z) {
    _popAccum += 10;
    _popPos.set(x, y, z);
}
function flushScorePopup() {
    if (_popAccum <= 0) return;
    const now = performance.now();
    if (now - _popLastFlush < 160) return;
    _popLastFlush = now;
    spawnScorePopup(_popPos.x, _popPos.y, _popPos.z, '+' + _popAccum,
        _popAccum >= 50 ? 'big' : '');
    _popAccum = 0;
}

// Player XZ movement with wall collision. Two gates, both grounded-only so
// jumps stay free: (1) analytic rise gate — the target floor may not be more
// than ~1.45 m above the camera (bridge masonry steps are ≤1.15, the drained
// moat lip is 1.4); (2) a short horizontal waist-height ray against physics
// bodies — brick castle walls, hut planks, bunker walls. Axis-separated so
// the player slides along walls instead of sticking to them.
const _wallRayFrom = new CANNON.Vec3();
const _wallRayTo = new CANNON.Vec3();
const _wallRayOpts = { collisionFilterMask: -1, skipBackfaces: true };
const _wallRayRc = new CANNON.RaycastResult();
function playerWallBlocks(fx, fy, fz, tx, tz) {
    const dx = tx - fx, dz = tz - fz;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return false;
    const nx = dx / len, nz = dz / len;
    const perpX = -nz * 0.25, perpZ = nx * 0.25;   // fan of 3 rays covers brick seams
    for (let i = -1; i <= 1; i++) {
        _wallRayFrom.set(fx + perpX * i, fy, fz + perpZ * i);
        _wallRayTo.set(tx + perpX * i + nx * 0.30, fy, tz + perpZ * i + nz * 0.30);
        _wallRayRc.reset();
        world.raycastClosest(_wallRayFrom, _wallRayTo, _wallRayOpts, _wallRayRc);
        if (_wallRayRc.hasHit) return true;
    }
    return false;
}
function applyPlayerXZMove(move) {
    const px = camera.position.x, py = camera.position.y, pz = camera.position.z;
    const nx = px + move.x, nz = pz + move.z;
    if (!playerOnGround) {
        camera.position.x = nx;
        camera.position.z = nz;
        return;
    }
    const waistY = py - 1.0;
    const free = (tx, tz) =>
        (getPlayerFloorY(tx, tz) - py) <= 1.45 && !playerWallBlocks(px, waistY, pz, tx, tz);
    if (free(nx, nz)) {
        camera.position.x = nx;
        camera.position.z = nz;
    } else if (free(nx, pz)) {
        camera.position.x = nx;
    } else if (free(px, nz)) {
        camera.position.z = nz;
    }
}

function animate() {
    requestAnimationFrame(animate);
    const frameStartAt = _perfDebugEnabled ? performance.now() : 0;
    const rawDt = clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    const rawFps = rawDt > 0 ? (1 / rawDt) : 60;
    updateFpsBadge(rawDt);
    updateCursorInspector();
    updateMobilePerfGovernor(rawDt);
    updateWaterReflectionPerfGovernor(rawDt);

    // (Removed 2026-07-05: the mobile idle low-FPS SAP broadphase rebuild
    // self-heal. Its root cause � the O(N�) sleeping-pair sweep in stock
    // cannon-es collisionPairs � is fixed by patchSapCollisionPairs, and the
    // periodic rebuild itself caused visible hitches + collision-matrix resets.)

    if (gamePaused) {
        // Still render the frozen scene so the pause overlay looks right
        const pauseRenderStart = _perfDebugEnabled ? performance.now() : 0;
        const _pauseRenderCam = window.__editorOverrideCamera || camera;
        renderer.render(scene, _pauseRenderCam);
        if (_perfDebugEnabled) perfDebugMarkRender(performance.now() - pauseRenderStart);
        setBallCamCrtVisible(false);
        if (_perfDebugEnabled) perfDebugMarkFrame(rawDt, 0, false);
        return;
    }

    // Hold game-over briefly so final impacts/ragdolls resolve on screen.
    if (gameOverPending) {
        if (gameOverPendingAt <= 0) gameOverPendingAt = performance.now();
        const elapsedMs = performance.now() - gameOverPendingAt;
        const ballsDone = cannonballs.length === 0;
        const awakeCount = countAwakeDynamicBodies(GAME_OVER_CALM_AWAKE_LIMIT + 1);
        const calmNow = ballsDone && awakeCount <= GAME_OVER_CALM_AWAKE_LIMIT;
        if (calmNow) gameOverCalmSec += dt;
        else gameOverCalmSec = 0;

        const longEnough = elapsedMs >= GAME_OVER_MIN_DELAY_MS;
        const calmHeld = gameOverCalmSec >= GAME_OVER_CALM_HOLD_SEC;
        const timedOut = elapsedMs >= GAME_OVER_MAX_DELAY_MS;
        if (longEnough && (calmHeld || timedOut)) {
            showGameOver();
        }
    }

    monitorPerf(rawDt);  // adaptive resolution should track true frame-time
    updateFlashes(dt);   // fade pooled muzzle/blast flashes
    updateHitFx();       // fade hit marker / crosshair flash
    updateDamageDirectionFx(); // fade directional hit indicators
    flushScorePopup();   // emit aggregated brick-score popups

    // Sniper breath-control stamina model.
    const breathActive = hasPrimaryPlayerInputCapture() && currentWeapon === WEAPON_IDX_SNIPER && sniperAiming && sniperHoldBreath && sniperBreathCooldown <= 0 && sniperBreathStamina > 0.05;
    if (breathActive) {
        sniperBreathStamina = Math.max(0, sniperBreathStamina - SNIPER_BREATH_DRAIN * dt);
        if (sniperBreathStamina <= 0.05) {
            sniperBreathCooldown = SNIPER_BREATH_COOLDOWN;
            sniperHoldBreath = false;
        }
    } else {
        sniperBreathStamina = Math.min(1, sniperBreathStamina + SNIPER_BREATH_RECOVER * dt);
    }
    sniperBreathCooldown = Math.max(0, sniperBreathCooldown - dt);

    // Scope vignette pulse and stamina bars.
    const scopeEl = document.getElementById('scopeOverlay');
    const scopeBreath = document.getElementById('scopeBreath');
    const scopeLung = document.getElementById('scopeLung');
    if (scopeBreath) scopeBreath.style.transform = `scaleX(${sniperBreathStamina.toFixed(3)})`;
    if (scopeLung) scopeLung.style.opacity = breathActive ? '1' : '0.62';
    if (scopeEl) {
        const pulse = 0.93 + Math.sin(performance.now() * (breathActive ? 0.006 : 0.012)) * (breathActive ? 0.01 : 0.04);
        scopeEl.style.filter = `brightness(${pulse.toFixed(3)})`;
    }

    // Sniper tracers: short-lived bright streaks that quickly fade.
    for (let i = sniperTracers.length - 1; i >= 0; i--) {
        const t = sniperTracers[i];
        t.life -= dt;
        if (t.life <= 0) {
            scene.remove(t.mesh);
            sniperTracers.splice(i, 1);
            continue;
        }
        t.mesh.material.opacity = 0.95 * (t.life / t.maxLife);
    }

    // Sniper ADS: RMB zoom + scope overlay in 1P while sniper is equipped.
    const isSniperAim = hasPrimaryPlayerInputCapture() && !twoPlayerMode && currentWeapon === WEAPON_IDX_SNIPER && sniperAiming;
    if (isSniperAim && !sniperAdsWasAiming) {
        sniperAdsPose = 0;
        sniperScopeTunnel = 0;
    }
    sniperAdsWasAiming = isSniperAim;

    // Entry: animate rifle up first; reticle appears only near full shoulder mount.
    // Exit: reticle/scope drops first; rifle returns to hip only after scope is almost gone.
    const allowReturnToHip = isSniperAim || sniperScopeTunnel <= 0.035;
    const poseTarget = isSniperAim ? 1 : (allowReturnToHip ? 0 : 1);
    const poseSpeed = poseTarget > sniperAdsPose ? 5.4 : 10.2;
    sniperAdsPose = THREE.MathUtils.lerp(sniperAdsPose, poseTarget, Math.min(1, dt * poseSpeed));

    let tunnelTarget = 0;
    if (isSniperAim) {
        // Delay scope view until the rifle is essentially at eye level.
        tunnelTarget = Math.max(0, Math.min(1, (sniperAdsPose - 0.90) / 0.10));
    }
    const tunnelSpeed = tunnelTarget > sniperScopeTunnel ? 8.6 : 14.0;
    sniperScopeTunnel = THREE.MathUtils.lerp(sniperScopeTunnel, tunnelTarget, Math.min(1, dt * tunnelSpeed));

    const settleRaw = Math.max(0, Math.min(1, (sniperScopeTunnel - 0.62) / 0.38));
    const settle = settleRaw * settleRaw * (3 - 2 * settleRaw);
    const reticleRaw = Math.max(0, Math.min(1, (settle - 0.35) / 0.65));
    const reticleAlpha = reticleRaw * reticleRaw * (3 - 2 * reticleRaw);

    if (scopeEl) {
        scopeEl.style.display = (isSniperAim || sniperScopeTunnel > 0.02) ? 'block' : 'none';
        scopeEl.style.setProperty('--scope-tunnel', sniperScopeTunnel.toFixed(3));
        scopeEl.style.setProperty('--reticle-alpha', reticleAlpha.toFixed(3));
        const ocularRaw = Math.max(0, Math.min(1, (sniperScopeTunnel - 0.20) / 0.80));
        scopeEl.style.setProperty('--ocular-alpha', ocularRaw.toFixed(3));
        scopeEl.style.setProperty('--ocular-scale', '1.000');
    }

    const aimFov = THREE.MathUtils.lerp(38, SNIPER_FOV_AIM, sniperScopeTunnel);
    const targetFov = THREE.MathUtils.lerp(NORMAL_FOV, aimFov, sniperScopeTunnel);
    if (Math.abs(camera.fov - targetFov) > 0.02) {
        const t = Math.min(1, dt * SNIPER_ZOOM_LERP);
        camera.fov += (targetFov - camera.fov) * t;
        camera.updateProjectionMatrix();
    }

    // Apply FPS aim ? P1
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;

    // Realistic micro-sway in scope; reduced while holding breath.
    if (currentWeapon === WEAPON_IDX_SNIPER && isSniperAim) {
        const t = performance.now() * 0.001;
        const swayScale = breathActive ? 0.10 : (0.95 + (1 - sniperBreathStamina) * 1.10);
        camera.rotation.y += Math.sin(t * 1.8) * 0.0038 * swayScale;
        camera.rotation.x += Math.cos(t * 2.35) * 0.0032 * swayScale;
    }

    // Shot kick settles independently of global trauma for scoped precision feel.
    if (sniperShotKick > 0.0005) {
        camera.rotation.x += sniperShotKick * 0.015;
        sniperShotKick = Math.max(0, sniperShotKick - dt * 3.8);
    }
    if (shotgunShotKick > 0.0005) {
        camera.rotation.x += shotgunShotKick * 0.011;
        shotgunShotKick = Math.max(0, shotgunShotKick - dt * 4.6);
    }
    if (landingBobTimer > 0) {
        landingBobTimer = Math.max(0, landingBobTimer - dt);
        const t = 1 - (landingBobTimer / LANDING_BOB_DURATION);
        // Quick down-up dip for a subtle landing feel.
        camera.rotation.x += Math.sin(t * Math.PI) * (1 - t * 0.35) * LANDING_BOB_ANGLE;
    }
    // Camera shake (trauma�-scaled, decays each frame). rotation.z isn't set
    // anywhere else, so resetting it to the shake value (or 0) is clean.
    if (_shakeTrauma > 0) {
        const s = _shakeTrauma * _shakeTrauma;
        const k = 0.045 * s;
        camera.rotation.x += (Math.random() * 2 - 1) * k;
        camera.rotation.y += (Math.random() * 2 - 1) * k;
        camera.rotation.z  = (Math.random() * 2 - 1) * k;
        _shakeTrauma = Math.max(0, _shakeTrauma - dt * 1.9);
    } else {
        camera.rotation.z = 0;
    }

    // WASD + touch joystick movement along the horizontal plane (ignore pitch).
    // Keys are captured by drone controls while piloting � player stands still.
    // Scripted ladder climbs drive the camera themselves (input suspended).
    const bunkerScripted = bunkerState.phase === 'descending' || bunkerState.phase === 'ascending';
    const moveForwardInput = (activeDrone || bunkerScripted) ? 0 : ((keys.w ? 1 : 0) - (keys.s ? 1 : 0) + touchControls.moveForward);
    const moveRightInput   = (activeDrone || bunkerScripted) ? 0 : ((keys.d ? 1 : 0) - (keys.a ? 1 : 0) + touchControls.moveRight);
    const waterDrag = playerWaterState ? 0.26 : 1.0;
    if (Math.abs(moveForwardInput) > 0.001 || Math.abs(moveRightInput) > 0.001) {
        const fwd   = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
        const right = new THREE.Vector3( Math.cos(yaw), 0, -Math.sin(yaw));
        const move  = new THREE.Vector3();
        if (Math.abs(moveForwardInput) > 0.001) move.addScaledVector(fwd, moveForwardInput);
        if (Math.abs(moveRightInput) > 0.001) move.addScaledVector(right, moveRightInput);
        if (move.lengthSq() > 0) {
            move.normalize().multiplyScalar(MOVE_SPEED * waterDrag * dt);
            applyPlayerXZMove(move);
        }
    }

    if (!playerWaterState && !gameOver && !bunkerScripted) {
        // Standing on bridge masonry above the waterline must not dunk the
        // player � the water test is 2D, so gate it on feet near ground level.
        const touchingWater = isPlayerInMoatWaterXZ(camera.position.x, camera.position.z)
            && camera.position.y <= PLAYER_BASE_Y + 0.6;
        if (touchingWater) playerWaterContactSec += dt;
        else playerWaterContactSec = Math.max(0, playerWaterContactSec - dt * 2.2);
        if (playerWaterContactSec >= PLAYER_WATER_CONTACT_DELAY_SEC) {
            beginPlayerWaterFall();
        }
    }

    if (playerWaterState) {
        jumpQueued = false;
        updatePlayerWaterFall(dt);
    } else if (!bunkerScripted) {
        // Space jump for P1 (works even while standing still).
        if (jumpQueued) {
            if (playerOnGround) {
                playerYVel = PLAYER_JUMP_SPEED;
                playerOnGround = false;
            }
            jumpQueued = false;
        }
        if (!playerOnGround || playerYVel !== 0) {
            playerYVel -= PLAYER_GRAVITY * dt;
            camera.position.y += playerYVel * dt;
            const floorY = getPlayerFloorY(camera.position.x, camera.position.z);
            if (camera.position.y <= floorY) {
                const wasAirborne = !playerOnGround;
                camera.position.y = floorY;
                playerYVel = 0;
                playerOnGround = true;
                if (wasAirborne) landingBobTimer = LANDING_BOB_DURATION;
            }
        } else {
            const floorY = getPlayerFloorY(camera.position.x, camera.position.z);
            if (floorY > camera.position.y + 0.01) {
                // Step up onto masonry (ramp stairs, deck) at a climb rate
                // instead of snapping, so mounting courses reads as climbing.
                camera.position.y = Math.min(floorY, camera.position.y + 9.0 * dt);
            } else if (floorY < camera.position.y - 0.3
                       && bunkerEyeYAt(camera.position.x, camera.position.z, camera.position.y) != null) {
                // Steep bunker descent: glide down the ramp at a controlled
                // rate instead of bounce-falling off it frame after frame.
                camera.position.y = Math.max(floorY, camera.position.y - 10.0 * dt);
                if (camera.position.y <= floorY + 1e-4) {
                    camera.position.y = floorY;
                    playerYVel = 0;
                    playerOnGround = true;
                }
            } else if (floorY < camera.position.y - 0.3) {
                playerOnGround = false;   // walked off an edge � gravity takes over
            } else {
                camera.position.y = floorY;
            }
        }
    }

    // Inside the bunker the camera is the player's whole body: keep it inside
    // the descent (the game's cameras have no wall collision anywhere else) and
    // below the ceiling while jumping in the covered parts.
    if (bunkerState.phase === 'inside') {
        camera.position.x = THREE.MathUtils.clamp(camera.position.x, BUNKER.X1 + 0.4, BUNKER.X2 - 0.4);
        camera.position.z = THREE.MathUtils.clamp(camera.position.z, BUNKER.OPEN_Z1 + 0.3, BUNKER.Z2 - 0.4);
        const inMouth = camera.position.x >= BUNKER.OPEN_X1 - 0.2 && camera.position.x <= BUNKER.OPEN_X2 + 0.2
            && camera.position.z >= BUNKER.OPEN_Z1 && camera.position.z <= BUNKER.OPEN_Z2 + 0.2;
        if (!inMouth && camera.position.y > BUNKER.CEIL_Y - 0.08) camera.position.y = BUNKER.CEIL_Y - 0.08;
    }

    // P2 IJKL movement
    if (twoPlayerMode && (keysP2.i || keysP2.j || keysP2.k || keysP2.l)) {
        camera2.rotation.y = p2Yaw;
        camera2.rotation.x = p2Pitch;
        const fwd2   = new THREE.Vector3(-Math.sin(p2Yaw), 0, -Math.cos(p2Yaw));
        const right2 = new THREE.Vector3( Math.cos(p2Yaw), 0, -Math.sin(p2Yaw));
        const move2  = new THREE.Vector3();
        if (keysP2.i) move2.addScaledVector(fwd2,   1);
        if (keysP2.k) move2.addScaledVector(fwd2,  -1);
        if (keysP2.l) move2.addScaledVector(right2,  1);
        if (keysP2.j) move2.addScaledVector(right2, -1);
        if (move2.lengthSq() > 0) {
            move2.normalize().multiplyScalar(MOVE_SPEED * dt);
            camera2.position.addScaledVector(move2, 1);
            camera2.position.y = 2.2;
        }
    }
    if (twoPlayerMode) {
        camera2.rotation.y = p2Yaw;
        camera2.rotation.x = p2Pitch;
    }

    _frameCount++;

    const frameActiveBricks = getFrameActiveBricks();
    const castleScanBricks = getStoryRoleBricks('castle');

    // Unsupported-brick check.
    // KEY FIX: only sleeping bricks count as valid support. An awake (falling)
    // brick cannot support anything above it. This breaks the "chain float"
    // where brick A sleeps on top of floating brick B ? B gets woken first,
    // then on the next pass A has no sleeping support and gets woken too.
    // Three passes per invocation collapse multi-level floating chains in one go.
    // Perf guard: only run while masonry was recently disturbed; otherwise this
    // scan is pure overhead on stable scenes (visible as deterministic FPS drops
    // a few seconds after start on mobile).
    let mobileImpactBudgetMode = isMobileProfile && ((_frameCount - _lastDisturbFrame) < 240 || _mobilePerfEmergency);
    if (lightweightRubbleMode) {
        const ragdollPressure = getActiveRagdollBodyCount() >= (isMobileProfile ? 10 : 24);
        mobileImpactBudgetMode = mobileImpactBudgetMode
            || ((_frameCount - _lastDisturbFrame) < (isMobileProfile ? 520 : 300))
            || ragdollPressure;
    }
    let supportScanInterval = mobileImpactBudgetMode
        ? 64
        : (currentDifficulty === 'squire'
            ? (isMobileProfile ? 22 : 18)
            : (isMobileProfile ? 16 : 10));
    if (lightweightRubbleMode) {
        supportScanInterval = Math.max(supportScanInterval, isMobileProfile ? 96 : 20);
    }
    let supportScanActiveWindow = isMobileProfile ? 300 : 420;
    if (lightweightRubbleMode) {
        supportScanActiveWindow = Math.max(supportScanActiveWindow, isMobileProfile ? 560 : 500);
    }
    const bridgeStageActive = storyModeEnabled && storyStage === 1;
    const shouldRunSupportScan = _frameCount > 180
        && (_frameCount % supportScanInterval === 0)
        && (_frameCount - _lastDisturbFrame < supportScanActiveWindow)
        && !bridgeStageActive
        && !_mobilePerfEmergency;
    if (shouldRunSupportScan) {
        const GROUND_Y    = BS.h * 0.55;
        const CHECK_XZ    = BS.w * 0.85;
        const CHECK_DY_LO = 0.05;
        const CHECK_DY_HI = BS.h * 1.4;

        // Build a spatial hash of all bricks so each support lookup only scans the
        // few bricks in the surrounding 3�3�3 cells instead of the whole castle.
        // (This pass was O(bricks�) � the main cause of the heavy-destruction
        // freeze, especially in Extreme mode where the structure stays large.)
        _grid.clear();
        for (let i = 0; i < castleScanBricks.length; i++) {
            const p = castleScanBricks[i].body.position;
            const k = _cellKeyXYZ(Math.floor(p.x / _GRID_CELL), Math.floor(p.y / _GRID_CELL), Math.floor(p.z / _GRID_CELL));
            let arr = _grid.get(k);
            if (!arr) { arr = []; _grid.set(k, arr); }
            arr.push(i);
        }

        for (const b of castleScanBricks) {
            if (b.isPlank || b.isRoof || b.isHutSupport) continue;
            if (b.body.sleepState === 0) continue;
            const by = b.body.position.y;
            if (by < GROUND_Y) continue;
            const bx = b.body.position.x;
            const bz = b.body.position.z;
            const ccx = Math.floor(bx / _GRID_CELL), ccy = Math.floor(by / _GRID_CELL), ccz = Math.floor(bz / _GRID_CELL);
            let supported = false;
            for (let dcx = -1; dcx <= 1 && !supported; dcx++)
            for (let dcy = -1; dcy <= 1 && !supported; dcy++)
            for (let dcz = -1; dcz <= 1 && !supported; dcz++) {
                const arr = _grid.get(_cellKeyXYZ(ccx + dcx, ccy + dcy, ccz + dcz));
                if (!arr) continue;
                for (let j = 0; j < arr.length; j++) {
                    const other = castleScanBricks[arr[j]];
                    if (other === b) continue;
                    // Accept: fully sleeping dynamic bricks OR static bodies (mass=0,
                    // e.g. lintels) which cannon-es never transitions out of sleepState=0.
                    // Dynamic supporters must belong to the SAME structure � a wall brick
                    // (which overlaps 3 m into a tower) must not be counted as holding up a
                    // physically-decoupled tower brick, or destroying the wall would topple
                    // the untouched tower.
                    if (other.body.mass > 0) {
                        if (other.body.sleepState !== 2) continue;   // moving = not support
                        if (other.grp !== b.grp) continue;           // different structure
                    }
                    const ox = other.body.position.x;
                    if (Math.abs(ox - bx) > CHECK_XZ) continue;
                    const oz = other.body.position.z;
                    if (Math.abs(oz - bz) > CHECK_XZ) continue;
                    const dy = by - other.body.position.y;
                    if (dy > CHECK_DY_LO && dy < CHECK_DY_HI) { supported = true; break; }
                }
            }
            if (!supported) b.body.wakeUp();
        }

        // Lintel drop check: a static lintel beam is simply-supported on the
        // wall columns at each of its two ends. If either end column has been
        // destroyed it can no longer hold � convert it to a dynamic body so it
        // falls realistically instead of floating in mid-air.
        const END_XZ = BS.w * 0.7;   // horizontal reach to find an end column
        const END_DY_LO = -BS.h * 0.6;
        const END_DY_HI =  BS.h * 1.6;
        for (const L of castleScanBricks) {
            if (!L.isLintel || L.dropped) continue;
            const lp = L.body.position;
            const ex1 = L.spanAxis === 'x' ? lp.x - L.halfSpan : lp.x;
            const ez1 = L.spanAxis === 'z' ? lp.z - L.halfSpan : lp.z;
            const ex2 = L.spanAxis === 'x' ? lp.x + L.halfSpan : lp.x;
            const ez2 = L.spanAxis === 'z' ? lp.z + L.halfSpan : lp.z;
            let end1 = false, end2 = false;
            for (const o of castleScanBricks) {
                if (o === L || o.isLintel) continue;
                // A brick counts as an end support if it's still roughly where it
                // was built � even if it's momentarily AWAKE (a nearby hit jitters
                // it without knocking it out). The old check skipped all awake
                // bricks, so a hit that merely woke the gate columns made the
                // lintel think its supports were gone; it then dropped as a heavy
                // dynamic beam and fell straight through those still-present
                // bricks. Only a brick actually displaced from its build slot
                // (knocked loose) should stop counting.
                if (o.body.mass > 0) {
                    const odx = o.body.position.x - o.ix;
                    const ody = o.body.position.y - o.iy;
                    const odz = o.body.position.z - o.iz;
                    if (odx*odx + ody*ody + odz*odz > 0.35 * 0.35) continue; // displaced = no longer supporting
                }
                const op = o.body.position;
                const dyl = lp.y - op.y;
                if (dyl < END_DY_LO || dyl > END_DY_HI) continue;
                if (!end1 && Math.abs(op.x - ex1) < END_XZ && Math.abs(op.z - ez1) < END_XZ) end1 = true;
                if (!end2 && Math.abs(op.x - ex2) < END_XZ && Math.abs(op.z - ez2) < END_XZ) end2 = true;
                if (end1 && end2) break;
            }
            if (!end1 || !end2) {
                L.body.type = CANNON.Body.DYNAMIC;
                L.body.mass = 150;
                L.body.updateMassProperties();
                L.body.wakeUp();
                L.dropped = true;
                L.scored  = false;   // now a real falling brick � eligible to score
            }
        }
    }

    // Bridge-specific support scan. The castle scan is disabled while the
    // bridge stage is active, so sleeping bridge bricks that lost their
    // support can hover. Run a cheap throttled scan on bridge bricks only.
    const shouldRunBridgeSupportScan = bridgeStageActive
        && _frameCount > 180
        && (_frameCount % (supportScanInterval * 2) === 0)
        && (_frameCount - _lastDisturbFrame < supportScanActiveWindow)
        && !_mobilePerfEmergency;
    if (shouldRunBridgeSupportScan) {
        const bridgeBricks = getStoryRoleBricks('bridge');
        const GROUND_Y    = BS.h * 0.55;
        const CHECK_XZ    = BS.w * 0.75;
        const CHECK_DY_LO = 0.05;
        const CHECK_DY_HI = BS.h * 1.4;
        _grid.clear();
        for (let i = 0; i < bridgeBricks.length; i++) {
            const p = bridgeBricks[i].body.position;
            const k = _cellKeyXYZ(Math.floor(p.x / _GRID_CELL), Math.floor(p.y / _GRID_CELL), Math.floor(p.z / _GRID_CELL));
            let arr = _grid.get(k);
            if (!arr) { arr = []; _grid.set(k, arr); }
            arr.push(i);
        }
        let woken = 0;
        const BUDGET = isMobileProfile ? 8 : 18;
        for (const b of bridgeBricks) {
            if (b.body.sleepState === 0) continue;
            const by = b.body.position.y;
            if (by < GROUND_Y) continue;
            const bx = b.body.position.x;
            const bz = b.body.position.z;
            const ccx = Math.floor(bx / _GRID_CELL), ccy = Math.floor(by / _GRID_CELL), ccz = Math.floor(bz / _GRID_CELL);
            let supported = false;
            for (let dcx = -1; dcx <= 1 && !supported; dcx++)
            for (let dcy = -1; dcy <= 1 && !supported; dcy++)
            for (let dcz = -1; dcz <= 1 && !supported; dcz++) {
                const arr = _grid.get(_cellKeyXYZ(ccx + dcx, ccy + dcy, ccz + dcz));
                if (!arr) continue;
                for (let j = 0; j < arr.length; j++) {
                    const other = bridgeBricks[arr[j]];
                    if (other === b) continue;
                    if (other.body.mass > 0 && other.body.sleepState !== 2) continue;
                    const oy = other.body.position.y;
                    const dy = by - oy;
                    if (dy < CHECK_DY_LO || dy > CHECK_DY_HI) continue;
                    const dx = Math.abs(bx - other.body.position.x);
                    const dz = Math.abs(bz - other.body.position.z);
                    if (dx <= CHECK_XZ && dz <= CHECK_XZ) { supported = true; break; }
                }
            }
            if (!supported) {
                b.body.wakeUp();
                woken++;
                if (woken >= BUDGET) break;
            }
        }
    }

    // Cluster stability (cantilever / top-heavy collapse) check.
    // The per-brick check above only asks "is *something* underneath me" � so a
    // thin column can appear to "support" a big overhanging mass even though, in
    // reality, the combined centre of mass hangs past the base and would topple.
    // Here we group connected sleeping bricks into rigid clusters and topple any
    // whose horizontal centre of mass falls outside its base footprint.
    // Gated to recent disturbances so a fully-settled scene costs nothing.
    const clusterScanInterval = mobileImpactBudgetMode
        ? 220
        : (currentDifficulty === 'squire'
            ? (isMobileProfile ? 130 : 90)
            : (isMobileProfile ? 90 : 30));
    const clusterScanActiveWindow = mobileImpactBudgetMode
        ? 120
        : (currentDifficulty === 'squire'
            ? (isMobileProfile ? 180 : 260)
            : (isMobileProfile ? 240 : 360));
    if (!mobileImpactBudgetMode && _frameCount > 180 && _frameCount % clusterScanInterval === 0 &&
        _frameCount - _lastDisturbFrame < clusterScanActiveWindow && !bridgeStageActive) {
        const GROUND_Y = BS.h * 0.55;
        const ADJ_XZ   = BS.w * 1.15;   // connects same-row + stacked neighbours
        const ADJ_Y    = BS.h * 1.2;
        const MARGIN   = BS.w * 0.45;   // brick half-width tolerance before toppling

        // Gather fully-settled dynamic bricks as cluster candidates.
        let m = 0;
        for (let i = 0; i < castleScanBricks.length; i++) {
            const b = castleScanBricks[i];
            if (b.isPlank || b.isRoof || b.isHutSupport) continue;
            if (b.body.mass > 0 && b.body.sleepState === 2 &&
                b.body.position.y > GROUND_Y) {
                _cluIndex[m] = i;
                _cluParent[m] = m;
                m++;
            }
        }
        if (m > 1) {
            const find = a => { while (_cluParent[a] !== a) { _cluParent[a] = _cluParent[_cluParent[a]]; a = _cluParent[a]; } return a; };
            // Spatial-hash the candidates so each only unions against neighbours in
            // its 3�3�3 cells (was O(m�) � a heavy-destruction freeze contributor).
            _grid.clear();
            for (let a = 0; a < m; a++) {
                const p = castleScanBricks[_cluIndex[a]].body.position;
                const k = _cellKeyXYZ(Math.floor(p.x / _GRID_CELL), Math.floor(p.y / _GRID_CELL), Math.floor(p.z / _GRID_CELL));
                let arr = _grid.get(k);
                if (!arr) { arr = []; _grid.set(k, arr); }
                arr.push(a);
            }
            // Union adjacent bricks into connected clusters.
            for (let a = 0; a < m; a++) {
                const pa = castleScanBricks[_cluIndex[a]].body.position;
                const ccx = Math.floor(pa.x / _GRID_CELL), ccy = Math.floor(pa.y / _GRID_CELL), ccz = Math.floor(pa.z / _GRID_CELL);
                for (let dcx = -1; dcx <= 1; dcx++)
                for (let dcy = -1; dcy <= 1; dcy++)
                for (let dcz = -1; dcz <= 1; dcz++) {
                    const arr = _grid.get(_cellKeyXYZ(ccx + dcx, ccy + dcy, ccz + dcz));
                    if (!arr) continue;
                    for (let t = 0; t < arr.length; t++) {
                        const c = arr[t];
                        if (c <= a) continue;   // visit each pair once
                        const pc = castleScanBricks[_cluIndex[c]].body.position;
                        if (Math.abs(pa.x - pc.x) > ADJ_XZ) continue;
                        if (Math.abs(pa.z - pc.z) > ADJ_XZ) continue;
                        if (Math.abs(pa.y - pc.y) > ADJ_Y)  continue;
                        // Don't merge decoupled structures (wall vs tower) into one
                        // cluster � they don't physically collide, so they can't brace
                        // each other against toppling.
                        if (castleScanBricks[_cluIndex[a]].grp !== castleScanBricks[_cluIndex[c]].grp) continue;
                        const ra = find(a), rc = find(c);
                        if (ra !== rc) _cluParent[ra] = rc;
                    }
                }
            }
            // Accumulate per-cluster centre of mass + lowest level.
            const sumX = new Map(), sumZ = new Map(), cnt = new Map(), minY = new Map();
            for (let a = 0; a < m; a++) {
                const r = find(a);
                const p = castleScanBricks[_cluIndex[a]].body.position;
                sumX.set(r, (sumX.get(r) || 0) + p.x);
                sumZ.set(r, (sumZ.get(r) || 0) + p.z);
                cnt.set(r,  (cnt.get(r)  || 0) + 1);
                const my = minY.get(r);
                if (my === undefined || p.y < my) minY.set(r, p.y);
            }
            // Footprint = x/z bounds of each cluster's bottom layer (within one row).
            const fMinX = new Map(), fMaxX = new Map(), fMinZ = new Map(), fMaxZ = new Map();
            for (let a = 0; a < m; a++) {
                const r = find(a);
                const p = castleScanBricks[_cluIndex[a]].body.position;
                if (p.y > minY.get(r) + BS.h * 1.5) continue;  // not bottom layer
                fMinX.set(r, Math.min(fMinX.get(r) ??  Infinity, p.x));
                fMaxX.set(r, Math.max(fMaxX.get(r) ?? -Infinity, p.x));
                fMinZ.set(r, Math.min(fMinZ.get(r) ??  Infinity, p.z));
                fMaxZ.set(r, Math.max(fMaxZ.get(r) ?? -Infinity, p.z));
            }
            // Topple clusters whose centre of mass overhangs the base footprint.
            for (const [r, n] of cnt) {
                if (n < 3) continue;  // ignore tiny rubble piles
                const comX = sumX.get(r) / n;
                const comZ = sumZ.get(r) / n;
                if (comX >= fMinX.get(r) - MARGIN && comX <= fMaxX.get(r) + MARGIN &&
                    comZ >= fMinZ.get(r) - MARGIN && comZ <= fMaxZ.get(r) + MARGIN) {
                    continue;  // balanced � stays standing
                }
                for (let a = 0; a < m; a++) {
                    if (find(a) === r) castleScanBricks[_cluIndex[a]].body.wakeUp();
                }
            }
        }
    }

    // Pre-step wake: sleeping bricks near an approaching cannonball must be
    // awake so the solver generates full contacts with them (tunneling fix).
    // Guards:
    //  a) Only run if the ball is moving faster than 2 m/s (rolling ball on
    //     the ground must not continuously wake tower bases).
    //  b) Only wake bricks roughly AHEAD of the ball (dot-product > 0), so
    //     bricks already passed through don?t re-wake and cascade.
    //  c) Tight 1.6 m radius ? just enough to cover the brick thickness.
    const mobileEarlyRound = isMobileProfile && ((performance.now() - _roundStartAtMs) < 12000);
    // The broad wake scan can wake hundreds of sleeping bricks on the first
    // impact, causing a large physics spike. CCD below now handles fast-shot
    // anti-tunneling, so keep this disabled by default.
    const runProjectileWakeScan = false;
    if (runProjectileWakeScan) {
        const wakeBudget = isMobileProfile ? 20 : 1000000;
        let wakeCount = 0;
        for (const cb of cannonballs) {
            const bv = cb.body.velocity;
            const spd2 = bv.x*bv.x + bv.y*bv.y + bv.z*bv.z;
            if (spd2 < 4) continue;  // < 2 m/s ? skip slow / resting balls
            const invSpd = 1 / Math.sqrt(spd2);
            const nx = bv.x * invSpd, ny = bv.y * invSpd, nz = bv.z * invSpd; // velocity direction unit vec
            const bp = cb.body.position;
            const R  = BS.d * 1.1;  // just wider than one brick face � tight cone
            for (const b of frameActiveBricks) {
                if (b.body.sleepState === 0) continue;  // already awake
                const dx = b.body.position.x - bp.x;
                if (dx > R || dx < -R) continue;
                const dz = b.body.position.z - bp.z;
                if (dz > R || dz < -R) continue;
                const dy = b.body.position.y - bp.y;
                if (dy > R || dy < -R) continue;
                // Forward-cone: only wake if brick is strictly ahead of ball
                if (dx*nx + dy*ny + dz*nz < 0.3) continue;
                b.body.wakeUp();
                wakeCount++;
                if (wakeCount >= wakeBudget) break;
            }
            if (wakeCount >= wakeBudget) break;
        }
    }

    // Falling debris crush check: fast downward bricks can kill standing NPCs.
    const NPC_CRUSH_CHECK_STRIDE = isMobileProfile ? 2 : 1;
    const NPC_CRUSH_MIN_FALL_SPEED = 2.8;
    const NPC_CRUSH_MIN_SPEED2 = 11.0;
    const NPC_CRUSH_Y_PAD_LOW = 0.35;
    const NPC_CRUSH_Y_PAD_HIGH = 1.10;
    if ((_frameCount % NPC_CRUSH_CHECK_STRIDE) === 0) {
        for (const npc of npcList) {
            if (npc.isRagdoll || npc.storyDormant) continue;
            const np = npc.group.position;
            const chestY = np.y + 1.05;
            const headY = np.y + 1.55;
            let crushed = false;
            for (const b of frameActiveBricks) {
                if (!b || !b.body || b.body.mass <= 0) continue;
                const bv = b.body.velocity;
                if (!bv || bv.y > -NPC_CRUSH_MIN_FALL_SPEED) continue;
                const sp2 = bv.x * bv.x + bv.y * bv.y + bv.z * bv.z;
                if (sp2 < NPC_CRUSH_MIN_SPEED2) continue;

                const bp = b.body.position;
                if (bp.y < chestY - NPC_CRUSH_Y_PAD_LOW) continue;
                if (bp.y > headY + NPC_CRUSH_Y_PAD_HIGH) continue;

                const dx = bp.x - np.x;
                const dz = bp.z - np.z;
                const baseR = b.isLintel
                    ? Math.min(1.7, Math.max(0.6, (b.halfSpan || 0.6) * 0.55))
                    : (b.isWedge ? 0.52 : (b.isPlank ? 0.56 : 0.48));
                const hitR = baseR + 0.30;
                if (dx * dx + dz * dz > hitR * hitR) continue;

                perfRecordEvent('npc_hit', `${npc.isTowerGuard ? 'tower' : 'ground'}/crush/${isMobileProfile ? 'mobile' : 'desktop'}`);
                spawnBlood(new THREE.Vector3(np.x, chestY, np.z));
                if (isMobileProfile) activateRagdollLite(npc, null, false);
                else activateRagdoll(npc, null, false);
                if (npc.ragdollParts && npc.ragdollParts.length > 0) {
                    for (const rp of npc.ragdollParts) {
                        if (!rp.body) continue;
                        rp.body.wakeUp();
                        const bv = b.body.velocity;
                        const fl = Math.hypot(bv.x, bv.z) || 1;
                        rp.body.applyImpulse(
                            new CANNON.Vec3((bv.x / fl) * 1.8, -0.35, (bv.z / fl) * 1.8),
                            rp.body.position
                        );
                        if (rp.body.velocity.y > 1.6) rp.body.velocity.y = 1.6;
                    }
                }
                const crushScore = 30;
                score += crushScore; updateUI();
                spawnScorePopup(np.x, chestY + 0.55, np.z, `+${crushScore} CRUSH`, 'kill');
                showHitMarker(true, false);
                crushed = true;
                break;
            }
            if (crushed) continue;
        }
    }

    // Per-frame cannonball?NPC proximity check (replaces kinematic trigger body
    // which never fired collide events due to collisionResponse:false in cannon-es).
    const NPC_HIT_R_GROUND = 1.5;
    const NPC_HIT_R_TOWER  = 0.75; // tighter so cannon shots into tower masonry aren't accidental guard kills
    const NPC_HIT_R_SNIPER = 0.42; // precision projectile; no incidental near-body splash kills
    const NPC_SAFE_BALL_SPEED2 = 4.84; // <= 2.2 m/s is treated as a shove/obstacle, not a lethal impact
    const _npcPartPos = new THREE.Vector3();
    for (const npc of npcList) {
        if (npc.isRagdoll || npc.storyDormant) continue;
        const np = npc.group.position;
        const ny = np.y + 1.1;  // torso centre
        npc.group.updateWorldMatrix(true, true);
        for (const cb of cannonballs) {
            if (cb._spent) continue;
            const bp = cb.body.position;
            const cv = cb.body.velocity;
            const cbSpeed2 = cv.x * cv.x + cv.y * cv.y + cv.z * cv.z;
            if (cb.weaponType !== WEAPON_IDX_SNIPER && cbSpeed2 < NPC_SAFE_BALL_SPEED2) {
                const ax = np.x - bp.x;
                const az = np.z - bp.z;
                const ad2 = ax * ax + az * az;
                if (ad2 > 1e-6) {
                    const inv = 1 / Math.sqrt(ad2);
                    np.x += ax * inv * 0.035;
                    np.z += az * inv * 0.035;
                }
                continue;
            }
            const br = (cb.body.shapes && cb.body.shapes[0] && cb.body.shapes[0].radius) ? cb.body.shapes[0].radius : 0.1;
            const sx = (cb._px !== undefined) ? cb._px : bp.x;
            const sy = (cb._py !== undefined) ? cb._py : bp.y;
            const sz = (cb._pz !== undefined) ? cb._pz : bp.z;
            const vx = bp.x - sx, vy = bp.y - sy, vz = bp.z - sz;
            const seg2 = vx*vx + vy*vy + vz*vz;
            let hit = false;
            let hitPartIndex = -1;
            if (cb.weaponType === WEAPON_IDX_SNIPER) {
                // Sniper: test every body part so head/limbs/torso can all register.
                for (let pi = 0; pi < npc.parts.length && !hit; pi++) {
                    const part = npc.parts[pi];
                    part.mesh.getWorldPosition(_npcPartPos);
                    const pr = Math.max(part.hw, part.hh, part.hd) * 1.05 + br * 0.6;
                    if (seg2 > 1e-7) {
                        const wx = _npcPartPos.x - sx, wy = _npcPartPos.y - sy, wz = _npcPartPos.z - sz;
                        let t = (wx*vx + wy*vy + wz*vz) / seg2;
                        if (t < 0) t = 0;
                        else if (t > 1) t = 1;
                        const cx = sx + vx * t, cy = sy + vy * t, cz = sz + vz * t;
                        const dx = cx - _npcPartPos.x, dy = cy - _npcPartPos.y, dz = cz - _npcPartPos.z;
                        hit = (dx*dx + dy*dy + dz*dz) < pr * pr;
                    } else {
                        const dx = bp.x - _npcPartPos.x, dy = bp.y - _npcPartPos.y, dz = bp.z - _npcPartPos.z;
                        hit = (dx*dx + dy*dy + dz*dz) < pr * pr;
                    }
                    if (hit) hitPartIndex = pi;
                }
            } else {
                const hr = npc.isTowerGuard ? NPC_HIT_R_TOWER : NPC_HIT_R_GROUND;
                const hitR = hr + br * 0.7;
                if (seg2 > 1e-7) {
                    const wx = np.x - sx, wy = ny - sy, wz = np.z - sz;
                    let t = (wx*vx + wy*vy + wz*vz) / seg2;
                    if (t < 0) t = 0;
                    else if (t > 1) t = 1;
                    const cx = sx + vx * t, cy = sy + vy * t, cz = sz + vz * t;
                    const dx = cx - np.x, dy = cy - ny, dz = cz - np.z;
                    hit = (dx*dx + dy*dy + dz*dz) < hitR * hitR;
                } else {
                    const dx = bp.x - np.x, dy = bp.y - ny, dz = bp.z - np.z;
                    hit = (dx*dx + dy*dy + dz*dz) < hitR * hitR;
                }
            }
            if (hit) {
                // Grenades and cluster bombs shove/stagger NPCs without killing �
                // the actual explosion handles kills when the grenade detonates.
                if (cb.weaponType === WEAPON_IDX_GRENADE || cb.weaponType === WEAPON_IDX_CLUSTER) {
                    const bv = cb.body.velocity;
                    const horiz = Math.sqrt(bv.x*bv.x + bv.z*bv.z) || 1;
                    np.x += (bv.x / horiz) * 0.65;
                    np.z += (bv.z / horiz) * 0.65;
                    markNpcAngry(np.x, np.z, 0.55, 18);
                    break; // shoved, no kill
                }
                perfRecordEvent('npc_hit', `${cb.weaponType}/${npc.isTowerGuard ? 'tower' : 'ground'}/${isMobileProfile ? 'mobile' : 'desktop'}`);
                // Red blood spray at the impact point (people, not stone).
                spawnBlood(new THREE.Vector3(cb.body.position.x, cb.body.position.y, cb.body.position.z));
                // Only explosive/mortar trigger violent scatter; minigun = tumble
                if (isMobileProfile) {
                    activateRagdollLite(npc, cb.body, cb.weaponType === WEAPON_IDX_EXPLOSIVE || cb.weaponType === WEAPON_IDX_MORTAR);
                } else {
                    activateRagdoll(npc, cb.body, cb.weaponType === WEAPON_IDX_EXPLOSIVE || cb.weaponType === WEAPON_IDX_MORTAR);
                }
                if (cb.weaponType === WEAPON_IDX_SNIPER && cb.body) {
                    // Sniper kills hit with a stronger directed shove for impact authority.
                    const sp = cb.body.velocity;
                    const ss = Math.sqrt(sp.x * sp.x + sp.y * sp.y + sp.z * sp.z) || 1;
                    if (npc.partBodies && npc.partBodies[0]) {
                        npc.partBodies[0].applyImpulse(
                            new CANNON.Vec3((sp.x / ss) * 120, 20, (sp.z / ss) * 120),
                            npc.partBodies[0].position
                        );
                    }
                }
                // Kill reward + feedback (skip P2's balls � those score on the P2 side)
                if (!cb.isP2) {
                    const isHeadshot = cb.weaponType === WEAPON_IDX_SNIPER && hitPartIndex === 1;
                    const sniperBonus = cb.weaponType === WEAPON_IDX_SNIPER ? 15 : 0;
                    const headshotBonus = isHeadshot ? 20 : 0;
                    const totalKillScore = 25 + sniperBonus + headshotBonus;
                    score += totalKillScore; updateUI();
                    _npcKillCount++;  // drives NPC face anger
                    // Nearby guards witness the kill and get angry.
                    markNpcAngry(np.x, np.z, 0.45, 20);
                    if (isHeadshot) {
                        playHeadshotCue();
                        spawnScorePopup(np.x, ny + 0.8, np.z, `HEADSHOT +${totalKillScore}`, 'kill big');
                    } else {
                        spawnScorePopup(np.x, ny + 0.6, np.z, `+${totalKillScore} KILL`, 'kill');
                    }
                    showHitMarker(true, isHeadshot);
                }
                if (cb.weaponType === WEAPON_IDX_SNIPER) {
                    cb._spent = true;
                    removeCannonballEntry(cb);
                }
                break;
            }
        }
    }

    // NPC walking + arrow firing (only after drawbridge opens, or always for tower guards)
    const NPC_WALK_SPEED  = 2.5;
    const ARROW_INTERVAL  = 5.0;

    const MOAT_AGGRO_Z = M_OZ1 - 12;  // 45 - 12 = 33

    // Front-line hut charger: trigger only when the player is near the moat,
    // not merely from a distant opening shot.
    if (!_hutChargerTriggered && shotsFired > 0 && camera.position.z >= MOAT_AGGRO_Z) {
        const hut = npcList.find(n => !n.isRagdoll && !n.storyDormant && n.isHutCharger);
        if (hut) {
            _hutChargerTriggered = true;
            hut.walking = true;
            hut.walkDelay = 0;
            hut.speedMul = Math.max(2.2, hut.speedMul || 0);
            hut.chaseOffsetX = 0;
            hut.waypoints = hut.doorPath ? hut.doorPath.slice() : [];
            hut.attackCommit = 1.2;
            hut.launchRushTimer = 2.2;
            hut.tauntCooldown = NPC_TAUNT_INTERVAL_BASE + Math.random() * NPC_TAUNT_INTERVAL_JITTER;
        }
    }

    // Moat aggro trigger: when the cannon gets within 12 m of the moat outer edge,
    // all courtyard knights charge directly at the player (one-shot, no drawbridge needed).
    if (!_npcAggroTriggered && camera.position.z >= MOAT_AGGRO_Z) {
        _npcAggroTriggered = true;
        let waveIndex = 0;
        for (const npc of npcList) {
            // isBunkerKing: the king never leaves his throne — marching him would
            // ground-snap him to the courtyard ABOVE his own bunker.
            if (npc.isRagdoll || npc.isTowerGuard || npc.storyDormant || npc.storyBridgeWalker || npc.isBunkerKing) continue;
            npc.walking   = true;
            npc.clearedBridge = false;
            npc.bridgeTurnLock = false;
            if (npc.isHutCharger) {
                npc.walkDelay = 0;
                npc.speedMul = Math.max(2.2, npc.speedMul || 0);
                npc.chaseOffsetX = 0;
                npc.waypoints = npc.doorPath ? npc.doorPath.slice() : [];
                npc.attackCommit = 1.2;
                npc.launchRushTimer = Math.max(1.4, npc.launchRushTimer || 0);
                continue;
            }
            // Staggered exit + varied pace so the company trickles out and spreads
            // over time instead of surging forward as one tidy rank.
            if (isMobileProfile && lightweightRubbleMode) {
                npc.walkDelay = 0.5 + Math.random() * 1.8 + waveIndex * 0.38;
            } else {
                npc.walkDelay = Math.random() * 1.4;
            }
            npc.speedMul  = 0.8 + Math.random() * 0.45;
            // The hut knight first walks out through the door, then chases the
            // player directly (it isn't a castle defender, so it skips the gate
            // scatter waypoints).
            if (npc.isInHut) {
                npc.waypoints = npc.doorPath.slice();
                continue;
            }
            // Scatter: each knight threads the gate on its own lane, then fans out
            // WIDE past the moat so they attack from spread-out angles rather than
            // funnelling into a single column to be knocked down like dominoes.
            const lane = (Math.random() - 0.5) * 3.2;   // gate lane (�1.6 m, fits the opening)
            const bridgeLane = THREE.MathUtils.clamp(lane * 0.6, -1.5, 1.5);
            const fan  = (Math.random() - 0.5) * 22;    // wide spread past the gate (�11 m)
            npc.chaseOffsetX = fan * 0.45;              // keep approaching off the player's axis
            npc.bridgeLaneX = bridgeLane;
            npc.waypoints = [
                { x: lane * 0.5, z: CFZ + 2 },          // through the gate opening
                { x: bridgeLane, z: M_IZ1 - 0.8 },      // keep lane on bridge
                { x: bridgeLane, z: M_OZ1 - 1.4 },      // exit bridge before turning
                { x: fan,        z: M_OZ1 - 2.4 },      // fan out only once off bridge
            ];  // after waypoints exhausted they chase the camera (with their offset)
            waveIndex++;
        }
    }

    // Tower guards: always fire arrows + fall when tower collapses beneath them
    for (const npc of npcList) {
        if (npc.isRagdoll || !npc.isTowerGuard || npc.storyDormant) continue;

        const gp = npc.group.position;
        if (!npc.npcPanicSwim) {
            const waterY = getWaterSurfaceYAtXZ(gp.x, gp.z, false);
            if (waterY != null && gp.y <= waterY + 0.55) {
                beginNpcPanicSwim(npc, 'tower-slip');
            }
        }
        if (updateNpcPanicSwim(npc, dt)) continue;

        npc.tauntCooldown = Math.max(0, (npc.tauntCooldown || 0) - dt);

        // If the tower deck beneath this guard has dropped, start falling now so
        // they move with the collapsing stand (no hovering delay).
        let onDroppedPlatform = false;
        let intactPlatformTopY = null;
        for (const pf of towerPlatforms) {
            const dxp = gp.x - pf.cx;
            const dzp = gp.z - pf.cz;
            if (dxp * dxp + dzp * dzp > (pf.rad * 1.02) * (pf.rad * 1.02)) continue;
            onDroppedPlatform = !!pf.dropped;
            if (!pf.dropped && pf.mesh) {
                intactPlatformTopY = pf.mesh.position.y + pf.thick * 0.5;
            }
            break;
        }
        const anchoredToIntactPlatform = intactPlatformTopY != null;
        if (anchoredToIntactPlatform) {
            // Intact deck means this guard should remain supported/alive.
            // Keep a little blend so there is no visible teleport/jitter.
            gp.y = THREE.MathUtils.lerp(gp.y, intactPlatformTopY, Math.min(1, dt * 8.0));
            npc.vy = Math.max(0, npc.vy || 0);
            npc.fallingWithTower = false;
            npc.towerDisturbFrames = 0;
        }
        if (!npc.fallingWithTower && onDroppedPlatform) {
            npc.fallingWithTower = true;
            npc.fallStartY = gp.y;
            npc.vy = Math.min(0, npc.vy || 0);
            tryNpcTaunt(npc, TOWER_GUARD_TAUNTS[(Math.random() * TOWER_GUARD_TAUNTS.length) | 0]);
        }

        // Falling-with-tower state: guard only dies from the resulting fall if
        // total drop exceeds 3 m (unless directly hit by projectile elsewhere).
        if (npc.fallingWithTower) {
            // If a dropped platform is still underfoot, ride it instead of
            // falling through. Otherwise apply gravity.
            let riding = false;
            for (const pf of towerPlatforms) {
                const dxp = gp.x - pf.mesh.position.x;
                const dzp = gp.z - pf.mesh.position.z;
                if (dxp * dxp + dzp * dzp > (pf.rad * 0.95) * (pf.rad * 0.95)) continue;
                const topY = pf.mesh.position.y + pf.thick * 0.5;
                if (gp.y < topY - 0.6 || gp.y > topY + 0.35) continue;
                gp.x += pf.body.velocity.x * dt;
                gp.z += pf.body.velocity.z * dt;
                gp.y = topY;
                npc.vy = Math.max(0, pf.body.velocity.y);
                riding = true;
                break;
            }

            const targetY = npcGroundY(gp.x, gp.z);
            if (!riding) {
                npc.vy -= 14 * dt;
                gp.y += npc.vy * dt;
            }
            if (gp.y <= targetY) {
                const drop = (npc.fallStartY || gp.y) - targetY;
                gp.y = targetY;
                npc.vy = 0;
                npc.fallingWithTower = false;
                npc.towerDisturbFrames = 0;
                if (drop > 3.0) {
                    const waterY = getWaterSurfaceYAtXZ(gp.x, gp.z, false);
                    if (waterY != null && beginNpcPanicSwim(npc, 'tower-drop')) {
                        continue;
                    }
                    activateRagdoll(npc, null);
                    continue;
                }
                tryNpcTaunt(npc, TOWER_GUARD_TAUNTS[(Math.random() * TOWER_GUARD_TAUNTS.length) | 0]);
            }
            resolveNpcSolidCollision(gp, gp.y + 1.1);
            continue; // don't aim/fire arrows while falling
        }

        // Guarded battlement behavior: periodically relocate around the tower and
        // rhythmically peek out from cover before slipping back behind merlons.
        const post = npc.towerGuardPost;
        if (post) {
            post.fistCooldown = Math.max(0, post.fistCooldown - dt);
            post.fistTimer = Math.max(0, post.fistTimer - dt);
            post.diveCooldown = Math.max(0, post.diveCooldown - dt);

            const angDist = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
            const toPlayer = Math.atan2(camera.position.x - post.cx, camera.position.z - post.cz);

            // Deliberate cover rhythm: stay tucked behind a merlon, then lean out
            // through the adjacent crenel gap to loose an arrow before ducking back.
            post.stateTimer -= dt;
            if (post.stateTimer <= 0) {
                if (post.state === 'hide') {
                    // Rise and lean toward whichever gap faces the player.
                    post.state = 'peek';
                    post.stateTimer = 1.2 + Math.random() * 1.2;
                    const gapA = post.coverAngle + post.gapStep;
                    const gapB = post.coverAngle - post.gapStep;
                    post.peekAngle = angDist(gapA, toPlayer) <= angDist(gapB, toPlayer) ? gapA : gapB;
                } else {
                    // Duck back into cover; sometimes dive to a better merlon.
                    post.state = 'hide';
                    post.stateTimer = 2.4 + Math.random() * 3.4;
                    if (post.diveCooldown <= 0 && post.merlonAngles.length > 1 && Math.random() < 0.5) {
                        let best = post.coverAngle;
                        for (const m of post.merlonAngles) {
                            if (angDist(m, toPlayer) < angDist(best, toPlayer)) best = m;
                        }
                        post.coverAngle = best;
                        post.diveCooldown = 6.0 + Math.random() * 7.0;
                    }
                }
            }

            post.isPeeking = post.state === 'peek';
            post.targetAngle = post.isPeeking ? post.peekAngle : post.coverAngle;

            // Slow, deliberate rotation around the tower — no more twitchy spins.
            const aDelta = Math.atan2(Math.sin(post.targetAngle - post.angle), Math.cos(post.targetAngle - post.angle));
            post.angle += aDelta * Math.min(1, dt * 1.15);

            const radiusTarget = post.isPeeking ? post.exposedRadius : post.coverRadius;
            const tx = post.cx + Math.sin(post.angle) * radiusTarget;
            const tz = post.cz + Math.cos(post.angle) * radiusTarget;
            gp.x = THREE.MathUtils.lerp(gp.x, tx, Math.min(1, dt * 2.6));
            gp.z = THREE.MathUtils.lerp(gp.z, tz, Math.min(1, dt * 2.6));

            // Safe zone on tower tops: clamp to a stable ring so guards avoid
            // edge jitter from repeated collision pushes.
            const offX = gp.x - post.cx;
            const offZ = gp.z - post.cz;
            const offLen = Math.hypot(offX, offZ);
            if (offLen > post.safeRadius && offLen > 1e-5) {
                const scl = post.safeRadius / offLen;
                gp.x = post.cx + offX * scl;
                gp.z = post.cz + offZ * scl;
            }

            // Crouch behind the merlon while hidden; rise to fire when peeking.
            const hideDrop = post.isPeeking ? 0.0 : 0.22;
            gp.y = THREE.MathUtils.lerp(gp.y, post.baseY - hideDrop, Math.min(1, dt * 4.0));

            // Occasional fist-wave taunt while visible; sparse by design.
            if (post.isPeeking && post.fistCooldown <= 0 && post.fistTimer <= 0) {
                post.fistTimer = post.fistDuration;
                post.fistCooldown = 7.0 + Math.random() * 9.0;
            }
            if (npc.anim) {
                const armLBase = post.isPeeking ? -0.88 : -0.98;
                const armRBase = post.isPeeking ? -0.92 : -1.02;
                let armLTarget = armLBase;
                let armRTarget = armRBase;
                if (post.fistTimer > 0) {
                    const p = 1 - post.fistTimer / post.fistDuration;
                    const wave = 0.5 + 0.5 * Math.sin(p * Math.PI * 4.4);
                    // Fist-pump only with the non-weapon arm.
                    const weaponArm = npc.weaponType === 'bow' ? 'left' : 'right';
                    if (weaponArm === 'left') {
                        armRTarget = 0.62 - wave * 2.28;
                    } else {
                        armLTarget = 0.62 - wave * 2.28;
                    }
                }
                npc.anim.armL.rotation.x = THREE.MathUtils.lerp(npc.anim.armL.rotation.x, armLTarget, Math.min(1, dt * 13.0));
                npc.anim.armR.rotation.x = THREE.MathUtils.lerp(npc.anim.armR.rotation.x, armRTarget, Math.min(1, dt * 13.0));
            }
        }

        // Support check every frame: scan bricks in the tower column.
        // Guards should not die from tiny vibration � only sustained local
        // instability or a real support drop should ragdoll them.
        const isMobileTower = isMobileProfile;
        const scanStride = isMobileTower
            ? (mobileImpactBudgetMode ? 12 : (currentDifficulty === 'squire' ? 8 : 4))
            : 1;
        const scanPhase = post ? post.scanPhase : 0;
        const shouldRunTowerSupportScan = scanStride === 1 || ((_frameCount + scanPhase) % scanStride === 0);
        if (gp.y > 1.0 && shouldRunTowerSupportScan && !anchoredToIntactPlatform) {
            const HR2 = (TOWER_R + 0.5) * (TOWER_R + 0.5);
            const footY = gp.y;
            let topBrickAwake = false;
            let topBrickMoving = false;
            let maxBrickY = -Infinity;
            for (const b of frameActiveBricks) {
                const dx = b.body.position.x - gp.x;
                const dz = b.body.position.z - gp.z;
                if (dx * dx + dz * dz > HR2) continue;
                const by = b.body.position.y;
                if (by > maxBrickY) {
                    maxBrickY = by;
                    // sleepState 0 = AWAKE in cannon-es
                    topBrickAwake = (b.body.sleepState === 0);
                    const vv = b.body.velocity;
                    topBrickMoving = (vv.x * vv.x + vv.y * vv.y + vv.z * vv.z) > 0.6 * 0.6;
                }
            }

            // Require sustained disturbance before ragdolling from motion.
            const localDisturb = topBrickAwake && topBrickMoving && maxBrickY > footY - BS.h * 2;
            if (localDisturb) npc.towerDisturbFrames = (npc.towerDisturbFrames || 0) + 1;
            else npc.towerDisturbFrames = Math.max(0, (npc.towerDisturbFrames || 0) - 2);

            // Disturbance alone should NOT drop the guard. Cannon hits can wake the
            // top ring briefly without removing support; in that case the guard
            // taunts and keeps footing.
            if (_frameCount > 180 && (npc.towerDisturbFrames || 0) >= 12) {
                npc.towerDisturbFrames = 0;
                tryNpcTaunt(npc, TOWER_GUARD_TAUNTS[(Math.random() * TOWER_GUARD_TAUNTS.length) | 0]);
            }

            // If support is already far below, start falling immediately.
            if (maxBrickY < footY - 1.0) {
                npc.fallingWithTower = true;
                npc.fallStartY = gp.y;
                npc.vy = Math.min(0, npc.vy || 0);
                continue;
            }
        }

        // Keep standing guards from clipping into masonry/wood at rest.
        // On mobile, run this less often to reduce continuous CPU pressure.
        const collisionStride = isMobileTower
            ? (mobileImpactBudgetMode ? 4 : (currentDifficulty === 'squire' ? 3 : 2))
            : 1;
        const collisionPhase = post ? post.collisionPhase : 0;
        if (collisionStride === 1 || ((_frameCount + collisionPhase) % collisionStride === 0)) {
            resolveNpcSolidCollision(gp, gp.y + 1.1);
        }

        // Rotate to track target: aim at the drone while it\'s airborne,
        // otherwise track the player as normal.
        const droneFlying = !!(activeDrone && !activeDrone.detonated);
        let targetX, targetZ;
        if (droneFlying) {
            targetX = activeDrone.body.position.x;
            targetZ = activeDrone.body.position.z;
        } else {
            targetX = camera.position.x;
            targetZ = camera.position.z;
        }
        const dx = targetX - gp.x;
        const dz = targetZ - gp.z;
        npc.group.rotation.y = Math.atan2(dx, dz);
        npc.arrowTimer += dt;
        // Only loose an arrow while leaning out of cover — tucked guards hold fire.
        const canShoot = !post || post.isPeeking;
        if (npc.arrowTimer >= ARROW_INTERVAL && canShoot) {
            npc.arrowTimer = 0;
            if (droneFlying) {
                fireArrowAtDrone(npc);
            } else {
                fireArrow(npc);
            }
        }
    }

    // Drone panic: update NPC flee/crawl states before the walker loop
    updateDronePanic(dt);

    for (const npc of npcList) {
        // isBunkerKing is defensive: any stray walking=true (drone fear, aggro)
        // must never route the throne-bound king through walker locomotion.
        if (npc.isRagdoll || !npc.walking || npc.isTowerGuard || npc.storyDormant || npc.storyBridgeWalker || npc.isBunkerKing) continue;
        const panicPos = npc.group.position;
        if (!npc.npcPanicSwim) {
            const waterY = getWaterSurfaceYAtXZ(panicPos.x, panicPos.z, false);
            if (waterY != null && panicPos.y <= waterY + 0.55) {
                beginNpcPanicSwim(npc, 'walker-slip');
            }
        }
        if (updateNpcPanicSwim(npc, dt)) continue;

        if (isMobileProfile && lightweightRubbleMode) {
            const walkStride = _mobilePerfEmergency ? 4 : 3;
            if (npc.walkUpdatePhase == null) npc.walkUpdatePhase = (Math.random() * walkStride) | 0;
            if (((_frameCount + npc.walkUpdatePhase) % walkStride) !== 0) {
                if (!npc.meleeCooldown) npc.meleeCooldown = 0;
                npc.meleeCooldown = Math.max(0, npc.meleeCooldown - dt);
                continue;
            }
        }
        // Staggered start: hold position until this knight's delay elapses so the
        // company trickles out rather than surging as one rank.
        if (npc.walkDelay > 0) { npc.walkDelay -= dt; continue; }
        const np = npc.group.position;
        npc.launchRushTimer = Math.max(0, (npc.launchRushTimer || 0) - dt);

        if (npc.isHutCharger && _hutChargerTriggered) {
            npc.tauntCooldown = Math.max(0, (npc.tauntCooldown || 0) - dt);
            tryNpcTaunt(npc, TOWER_GUARD_TAUNTS[(Math.random() * TOWER_GUARD_TAUNTS.length) | 0]);
        }

        // Once they fully clear the bridge, don't re-apply bridge-specific locks.
        if (!npc.clearedBridge && np.z <= M_OZ1 - 2.0) {
            npc.clearedBridge = true;
            npc.bridgeTurnLock = false;
            npc.bridgeLaneX = null;
            if (npc.waypoints && npc.waypoints.length > 0) {
                npc.waypoints = npc.waypoints.filter(wp => (wp.z || 0) < M_OZ1 - 1.8);
            }
        }

        // Follow waypoints first; once exhausted, track the player (each knight
        // keeps a lateral offset so they converge from spread-out angles).
        let tx, tz;
        if (npc.waypoints.length > 0) {
            const wp = npc.waypoints[0];
            const wdx = wp.x - np.x, wdz = wp.z - np.z;
            const reachR = npc.isHutCharger ? 0.75 : 0.4;
            if (wdx * wdx + wdz * wdz < reachR * reachR) npc.waypoints.shift();
            const cur = npc.waypoints[0] || { x: camera.position.x + (npc.chaseOffsetX || 0), z: camera.position.z };
            tx = cur.x; tz = cur.z;
        } else {
            tx = camera.position.x + (npc.chaseOffsetX || 0); tz = camera.position.z;
            if (npc.isHutCharger) {
                // Front-line charger ignores orbit/flank and runs straight in.
                tx = camera.position.x;
                tz = camera.position.z;
                npc.attackCommit = Math.max(npc.attackCommit || 0, 0.25);
            }

            // Close-range flanking: each knight keeps a preferred combat radius
            // and lateral side, making them circle and surround instead of
            // beelining into a single-file stack.
            if (!npc.isHutCharger && npc.flankSign == null) npc.flankSign = Math.random() < 0.5 ? -1 : 1;
            if (!npc.isHutCharger && npc.preferredRange == null) npc.preferredRange = 1.45 + Math.random() * 0.8;
            const pdx = np.x - camera.position.x;
            const pdz = np.z - camera.position.z;
            const pr = Math.hypot(pdx, pdz) || 1;
            if (npc.isHutCharger) {
                // Keep charger in direct pursuit once waypoints are exhausted.
                tx = camera.position.x;
                tz = camera.position.z;
            } else if ((npc.attackCommit || 0) > 0) {
                npc.attackCommit = Math.max(0, (npc.attackCommit || 0) - dt);
                tx = camera.position.x;
                tz = camera.position.z;
            } else if (pr < 3.2 && (npc.meleeCooldown || 0) <= 0) {
                // Commit to a short direct rush so knights don't orbit forever
                // just outside strike distance.
                npc.attackCommit = 0.55 + Math.random() * 0.2;
                tx = camera.position.x;
                tz = camera.position.z;
            } else if (pr < 12) {
                const rx = pdx / pr, rz = pdz / pr;
                const txn = -rz * npc.flankSign, tzn = rx * npc.flankSign;
                const radialErr = pr - npc.preferredRange;
                const orbit = 1.2 + Math.min(1.6, Math.abs(radialErr) * 0.45);
                tx = camera.position.x + rx * npc.preferredRange + txn * orbit;
                tz = camera.position.z + rz * npc.preferredRange + tzn * orbit;
            }
        }

        // While crossing the bridge center lane, force a straight bridge exit
        // before allowing lateral turns. Only apply this lock when the NPC is
        // actually in the central corridor and still following bridge waypoints.
        const inBridgeZ = np.z > M_OZ1 - 0.2 && np.z < M_IZ1 + 0.5;
        if (!npc.clearedBridge && inBridgeZ) {
            if (!Number.isFinite(npc.bridgeLaneX)) npc.bridgeLaneX = THREE.MathUtils.clamp(np.x, -1.6, 1.6);
            else npc.bridgeLaneX = THREE.MathUtils.clamp(THREE.MathUtils.lerp(npc.bridgeLaneX, np.x, 0.08), -1.6, 1.6);
        }
        const laneTargetX = Number.isFinite(npc.bridgeLaneX)
            ? npc.bridgeLaneX
            : THREE.MathUtils.clamp(np.x, -1.6, 1.6);
        const inBridgeCenter = Math.abs(np.x) < 2.6;
        // Exit-first lock: engage for ANY not-yet-cleared walker in the bridge
        // corridor � waypoints can be consumed or dropped mid-crossing (pack
        // shoves, stuck recovery), and chasing the player at an angle from the
        // board leaves them jittering against the moat edge.
        if (!npc.clearedBridge && inBridgeZ && inBridgeCenter && np.z > M_OZ1 + 0.7) {
            tx = laneTargetX;
            tz = M_OZ1 - 1.4;
            npc.bridgeTurnLock = true;
        } else if (!npc.clearedBridge && npc.bridgeTurnLock && np.z > M_OZ1 - 1.5 && inBridgeCenter) {
            tx = laneTargetX;
            tz = M_OZ1 - 1.4;
        } else {
            npc.bridgeTurnLock = false;
        }

        // Drone fear: override movement target � flee away from the drone.
        // Probe a fan of headings and commit briefly to a WALKABLE one, so
        // panicked NPCs route around water/mountains instead of pinning
        // themselves against unwalkable edges and jittering there.
        if ((npc.droneFear || 0) > 0.1 && activeDrone && !activeDrone.detonated) {
            const dp = activeDrone.body.position;
            const fdx = np.x - dp.x, fdz = np.z - dp.z;
            const awayYaw = Math.atan2(fdx, fdz);
            npc.fleeHeadingHold = Math.max(0, (npc.fleeHeadingHold || 0) - dt);
            const headingOk = (yaw) => {
                const hx = Math.sin(yaw), hz = Math.cos(yaw);
                return isNpcWalkableXZ(np.x + hx * 2.4, np.z + hz * 2.4)
                    && isNpcWalkableXZ(np.x + hx * 6.0, np.z + hz * 6.0);
            };
            let heading = npc.fleeHeading;
            if (!Number.isFinite(heading) || (npc.fleeHeadingHold || 0) <= 0 || !headingOk(heading)) {
                heading = awayYaw;
                if (!headingOk(heading)) {
                    if (!npc.fleeSweepSign) npc.fleeSweepSign = Math.random() < 0.5 ? -1 : 1;
                    for (const offDeg of [35, 70, 105, 140, 180]) {
                        const off = offDeg * Math.PI / 180;
                        if (headingOk(awayYaw + off * npc.fleeSweepSign)) { heading = awayYaw + off * npc.fleeSweepSign; break; }
                        if (headingOk(awayYaw - off * npc.fleeSweepSign)) { heading = awayYaw - off * npc.fleeSweepSign; break; }
                    }
                }
                npc.fleeHeading = heading;
                npc.fleeHeadingHold = 0.45 + Math.random() * 0.35;
            }
            tx = np.x + Math.sin(heading) * 30;
            tz = np.z + Math.cos(heading) * 30;
        }

        const dx = tx - np.x;
        const dz = tz - np.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        // Face the target only while steering is NOT deflecting along an edge;
        // the blocked-step branch owns the facing then (smooth turn toward the
        // direction actually walked) so blocked walkers don't visually thrash.
        const wasSteerDeflected = !!npc._steerDeflected;
        npc._steerDeflected = false;
        if (!wasSteerDeflected) npc.group.rotation.y = Math.atan2(dx, dz);  // face direction of travel
        const prevX = np.x, prevZ = np.z;

        const inBridgeDebrisLane = !npc.clearedBridge
            && np.z > M_OZ1 - 1.8
            && np.z < M_IZ1 + 1.4
            && Math.abs(np.x) < 6.5;
        npc.crawlCheckCooldown = Math.max(0, (npc.crawlCheckCooldown || 0) - dt);
        if ((npc.crawlCheckCooldown || 0) <= 0) {
            npc.crawlCheckCooldown = 0.12 + Math.random() * 0.08;
            npc.crawlDebrisScore = inBridgeDebrisLane ? getNpcRubbleScore(np, 1.25) : 0;
        }
        const crawlDebrisScore = npc.crawlDebrisScore || 0;
        if (!npc.crawlMode) {
            if (inBridgeDebrisLane
                && (npc.stuckTimer || 0) >= NPC_CRAWL_TRIGGER_STUCK
                && crawlDebrisScore >= NPC_CRAWL_DEBRIS_SCORE_MIN) {
                npc.crawlMode = true;
                npc.crawlHold = NPC_CRAWL_MIN_HOLD;
            }
        } else {
            npc.crawlHold = Math.max(0, (npc.crawlHold || 0) - dt);
            const shouldExitCrawl = !inBridgeDebrisLane
                || (((npc.stuckTimer || 0) < 0.08)
                    && crawlDebrisScore < (NPC_CRAWL_DEBRIS_SCORE_MIN - 0.9)
                    && (npc.crawlHold || 0) <= 0);
            if (shouldExitCrawl) npc.crawlMode = false;
        }

        if (dist > 0.4) {
            const spd = NPC_WALK_SPEED * (npc.speedMul || 1) * (npc.crawlMode ? NPC_CRAWL_SPEED_SCALE : 1);
            const isMobileWalker = isMobileProfile;
            const doBrickAvoidance = !isMobileWalker || ((_frameCount + (npc.avoidPhase || 0)) % 3 === 0);
            const doWalkCollision = !isMobileWalker || ((_frameCount + (npc.walkCollisionPhase || 0)) % 2 === 0);

            // Dedicated bridge-lane solver: when lock is active, move straight
            // off the bridge first (center + forward) before any turning logic.
            if (npc.bridgeTurnLock) {
                np.x += (laneTargetX - np.x) * Math.min(1, dt * 3.8);
                np.z += Math.sign((M_OZ1 - 1.4) - np.z) * Math.min(Math.abs((M_OZ1 - 1.4) - np.z), spd * dt);
                const laneMin = Math.max(-2.2, laneTargetX - 0.7);
                const laneMax = Math.min(2.2, laneTargetX + 0.7);
                np.x = Math.max(laneMin, Math.min(laneMax, np.x));
                np.z = Math.max(M_OZ1 - 1.6, np.z);
                if (!isNpcWalkableXZ(np.x, np.z)) {
                    // Safety fallback if pushed out of walkable bridge corridor.
                    np.x = laneTargetX;
                    np.z = Math.max(M_OZ1 - 1.6, np.z);
                }
                if (doWalkCollision) resolveNpcSolidCollision(np, np.y + 1.1, npc.crawlMode ? NPC_CRAWL_COLLISION_R : 0.22);
            } else {
            // Steering direction starts as straight toward the target.
            let sx = dx / dist, sz = dz / dist;

            // Wide-berth obstacle avoidance: bias steering away from nearby solid
            // bricks before contact so NPCs arc around corners instead of
            // shortcutting directly into geometry and vibrating on push-out.
            const footY = np.y + 1.1;
            const avoidPad = npc.crawlMode ? 0.36 : 0.72;
            const playerDist = Math.hypot(camera.position.x - np.x, camera.position.z - np.z);
            const isAttackCommit = (npc.attackCommit || 0) > 0;
            if ((!isAttackCommit || playerDist > 3.0) && doBrickAvoidance) {
                for (const b of frameActiveBricks) {
                    const bp = b.body.position;
                    if (Math.abs(bp.y - footY) > 1.25) continue;
                    let hx = BS.w / 2, hz = BS.d / 2;
                    if (b.isLintel) {
                        hx = (b.spanAxis === 'x') ? b.halfSpan : BS.d / 2;
                        hz = (b.spanAxis === 'z') ? b.halfSpan : BS.d / 2;
                    } else if (b.isPlank) {
                        const halfLen = (PS.w / 2) * (b.lenScale || 1);
                        hx = b.isZ ? PT / 2 : halfLen;
                        hz = b.isZ ? halfLen : PT / 2;
                    } else if (b.isWedge) {
                        hx = BS.w / 2; hz = BS.w / 2;
                    } else {
                        if (b.isCube) {
                            hx = BS.h / 2;
                            hz = BS.h / 2;
                        } else if (b.isY) {
                            hx = BS.h / 2;
                            hz = BS.d / 2;
                        } else {
                            hx = b.isZ ? BS.d / 2 : WALL_BRICK_HALF_LEN;
                            hz = b.isZ ? WALL_BRICK_HALF_LEN : BS.d / 2;
                        }
                    }
                    const ex = hx + avoidPad, ez = hz + avoidPad;
                    const bx = np.x - bp.x, bz = np.z - bp.z;
                    const ox = ex - Math.abs(bx), oz = ez - Math.abs(bz);
                    if (ox <= 0 || oz <= 0) continue;
                    const weight = Math.min(1, (ox + oz) * 0.35);
                    const avoidForce = npc.crawlMode ? 0.55 : 0.9;
                    if (ox < oz) sx += (bx >= 0 ? 1 : -1) * avoidForce * weight;
                    else         sz += (bz >= 0 ? 1 : -1) * avoidForce * weight;
                }
            }

            // Avoid slow / resting cannonballs on the ground � walking into one is
            // lethal, and they'd otherwise march straight through them. Each nearby
            // near-stationary ball adds a sideways push around it (perpendicular to
            // the NPC's heading, on whichever side the ball is NOT), so the knight
            // smoothly steers past instead of bumping into it.
            for (const cb of cannonballs) {
                const cv = cb.body.velocity;
                if (cv.x * cv.x + cv.y * cv.y + cv.z * cv.z > 16) continue;  // moving fast � let CCD/impact handle it
                const bx = cb.body.position.x - np.x;
                const bz = cb.body.position.z - np.z;
                const bd2 = bx * bx + bz * bz;
                if (bd2 > 9) continue;                       // only react within ~3 m
                const bd = Math.sqrt(bd2) || 1;
                // Side-step: perpendicular to heading, away from the ball.
                const perpX = -sz, perpZ = sx;
                const side = (bx * perpX + bz * perpZ) > 0 ? -1 : 1;   // push to the clear side
                const commitScale = (isAttackCommit && playerDist <= 2.8) ? 0.55 : 1.0;
                const strength = (3 - bd) / 3 * 1.6 * commitScale * (npc.crawlMode ? 0.55 : 1.0);        // stronger the closer it is
                sx += perpX * side * strength;
                sz += perpZ * side * strength;
                // Also brake straight-on approach so they curve rather than ram.
                sx -= (bx / bd) * strength * 0.5;
                sz -= (bz / bd) * strength * 0.5;
            }
            const slen = Math.hypot(sx, sz) || 1;

            // Keep walkers out of moat water: if the forward step would enter an
            // unwalkable moat cell, steer tangentially along the moat edge.
            const nx = np.x + (sx / slen) * spd * dt;
            const nz = np.z + (sz / slen) * spd * dt;
            if (isNpcWalkableXZ(nx, nz)) {
                np.x = nx;
                np.z = nz;
            } else {
                // Blocked ahead (water / mountain footprint). Commit to ONE
                // tangent side for a short hold instead of re-picking the
                // closest-to-target side every frame � per-frame side flips at
                // concave shore points are what caused the shoreline jitter.
                npc._steerDeflected = true;
                npc.steerSideHold = Math.max(0, (npc.steerSideHold || 0) - dt);
                const fwx = sx / slen, fwz = sz / slen;
                const sideStep = (side) => ({
                    x: np.x + (-fwz * side) * spd * dt,
                    z: np.z + (fwx * side) * spd * dt,
                    dirX: -fwz * side, dirZ: fwx * side,
                });
                let step = null;
                if ((npc.steerSide === 1 || npc.steerSide === -1) && (npc.steerSideHold || 0) > 0) {
                    const held = sideStep(npc.steerSide);
                    if (isNpcWalkableXZ(held.x, held.z)) step = held;
                }
                if (!step) {
                    const a = sideStep(1), b = sideStep(-1);
                    const aOk = isNpcWalkableXZ(a.x, a.z);
                    const bOk = isNpcWalkableXZ(b.x, b.z);
                    const da = (tx - a.x) * (tx - a.x) + (tz - a.z) * (tz - a.z);
                    const db = (tx - b.x) * (tx - b.x) + (tz - b.z) * (tz - b.z);
                    if (aOk && (da <= db || !bOk)) { step = a; npc.steerSide = 1; }
                    else if (bOk)                  { step = b; npc.steerSide = -1; }
                    npc.steerSideHold = 0.8 + Math.random() * 0.5;
                }
                if (step) {
                    np.x = step.x; np.z = step.z;
                    // Turn smoothly toward the direction actually walked.
                    const wantYaw = Math.atan2(step.dirX, step.dirZ);
                    let dyaw = wantYaw - npc.group.rotation.y;
                    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
                    npc.group.rotation.y += dyaw * Math.min(1, dt * 8);
                } else {
                    // Fully cornered � back straight off the edge at half speed.
                    const backX = np.x - fwx * spd * dt * 0.5;
                    const backZ = np.z - fwz * spd * dt * 0.5;
                    if (isNpcWalkableXZ(backX, backZ)) { np.x = backX; np.z = backZ; }
                }
            }
            const walkCollisionR = npc.crawlMode
                ? NPC_CRAWL_COLLISION_R
                : ((npc.isHutCharger && (npc.launchRushTimer || 0) > 0) ? 0.18 : 0.34);
            if (doWalkCollision) resolveNpcSolidCollision(np, np.y + 1.1, walkCollisionR);
            }

            // Keep bridge-crossers on the board: avoidance biases and collision
            // push-out can shove an NPC over the side rail, where the moat makes
            // every lateral step unwalkable and it jitters at the edge forever.
            if (!npc.clearedBridge && np.z > M_OZ1 - 0.2 && np.z < M_IZ1 + 0.5 && Math.abs(np.x) < 3.6) {
                np.x = THREE.MathUtils.clamp(np.x, -2.35, 2.35);
            }

            if (maybeTripNpcOnRubble(npc, dt)) continue;

            npc.walkTime += dt;
            const gaitRate = npc.isHutCharger ? 8.8 : 4.5;
            const swing = Math.sin(npc.walkTime * gaitRate) * 0.55;
            const stepBin = Math.floor((npc.walkTime * gaitRate) / Math.PI);
            if (stepBin !== npc.lastStepBin) {
                npc.lastStepBin = stepBin;
                const pdx = camera.position.x - np.x;
                const pdz = camera.position.z - np.z;
                playNpcFootstep(Math.hypot(pdx, pdz), npc.speedMul || 1);
            }
            if (npc.crawlMode) {
                const crawlPhase = npc.walkTime * 6.2;
                const crawlSwing = Math.sin(crawlPhase) * 0.48;
                npc.anim.legL.rotation.x = -1.05 + crawlSwing * 0.55;
                npc.anim.legR.rotation.x = -1.05 - crawlSwing * 0.55;
                npc.anim.armL.rotation.x = -1.22 - crawlSwing * 0.65;
                npc.anim.armR.rotation.x = -1.22 + crawlSwing * 0.65;
            } else if (npc.isHutCharger) {
                // High-knee sprint silhouette: lifted thighs and stronger arm pump.
                const runPhase = npc.walkTime * gaitRate;
                const liftL = Math.max(0, Math.sin(runPhase));
                const liftR = Math.max(0, Math.sin(runPhase + Math.PI));
                const drive = Math.sin(runPhase) * 0.6;
                npc.anim.legL.rotation.x = -0.25 + drive * 0.55 + liftL * 1.05;
                npc.anim.legR.rotation.x = -0.25 - drive * 0.55 + liftR * 1.05;
                npc.anim.armL.rotation.x = -0.85 - drive * 0.8;
                npc.anim.armR.rotation.x = -1.20 + drive * 0.45;
            } else {
                npc.anim.legL.rotation.x =  swing;   // left thigh
                npc.anim.legR.rotation.x = -swing;   // right thigh
                npc.anim.armL.rotation.x = -swing;   // left arm (counter-swing)
                // Right arm: sword-chop overhead when close, normal swing when far
                if (dist < 12) {
                    // Overhead chop � arm swings forward and up
                    npc.anim.armR.rotation.x = -Math.abs(Math.sin(npc.walkTime * 6.0)) * 1.8 - 0.4;
                } else {
                    npc.anim.armR.rotation.x =  swing;
                }
            }
        }

        // Anti-freeze recovery: if almost no progress for a short time, break
        // lock and force a clear bridge-exit waypoint.
        const moved2 = (np.x - prevX) * (np.x - prevX) + (np.z - prevZ) * (np.z - prevZ);
        const inBridgeFlow = (!npc.clearedBridge && (npc.bridgeTurnLock || (npc.waypoints && npc.waypoints.length > 0)));
        const shouldTrackStuck = inBridgeFlow || dist > 0.9;
        if (shouldTrackStuck) {
            if (moved2 < 0.00025) npc.stuckTimer = (npc.stuckTimer || 0) + dt;
            else npc.stuckTimer = Math.max(0, (npc.stuckTimer || 0) - dt * 1.5);
        } else {
            npc.stuckTimer = 0;
        }
        const stuckRecoverThreshold = npc.crawlMode ? 2.2 : 1.25;
        if ((npc.stuckTimer || 0) > stuckRecoverThreshold) {
            npc.bridgeTurnLock = false;
            npc.stuckTimer = 0;
            if (!npc.clearedBridge) {
                if (!(npc.waypoints && npc.waypoints.length && (npc.waypoints[0].z || 0) < M_OZ1 - 1.0)) {
                    npc.waypoints.unshift({ x: laneTargetX, z: M_OZ1 - 1.5 });
                }
                np.z = Math.max(M_OZ1 - 1.6, np.z);
            } else {
                // If stuck on an exhausted/blocked route, drop one waypoint and
                // force a small reposition to break local deadlocks.
                if (npc.waypoints && npc.waypoints.length > 0) npc.waypoints.shift();
                // Near player: micro-nudge only. Never snap back toward bridge.
                np.x += (Math.random() - 0.5) * 0.72;
                np.z += (Math.random() - 0.5) * 0.72;
            }
        }

        // Vertical locomotion: allow only slow, small step-ups so rubble cannot
        // pop NPCs upward in a jump-like way while they keep advancing.
        let targetY = npcGroundY(np.x, np.z);
        const climbDy = targetY - np.y;
        if (climbDy > 0.001) {
            if (climbDy > NPC_MAX_STEP_UP) {
                // Too steep: cancel this frame's horizontal motion and recover.
                np.x = prevX;
                np.z = prevZ;
                targetY = npcGroundY(np.x, np.z);
                if (np.y > targetY + 0.02) {
                    npc.vy -= 14 * dt;
                    np.y += npc.vy * dt;
                    if (np.y <= targetY) { np.y = targetY; npc.vy = 0; }
                } else {
                    np.y = targetY;
                    npc.vy = 0;
                }
                npc.stuckTimer = Math.max(npc.stuckTimer || 0, 0.12);
            } else {
                const climbRate = NPC_CLIMB_RATE * (npc.isHutCharger ? 1.08 : 1.0);
                np.y += Math.min(climbDy, climbRate * dt);
                npc.vy = 0;
            }
        } else if (np.y > targetY + 0.02) {
            npc.vy -= 14 * dt;
            np.y += npc.vy * dt;
            if (np.y <= targetY) { np.y = targetY; npc.vy = 0; }
        } else {
            np.y = targetY;
            npc.vy = 0;
        }
        // Melee hit: use actual distance to CAMERA, not distance to waypoint target
        if (!npc.meleeCooldown) npc.meleeCooldown = 0;
        npc.meleeCooldown = Math.max(0, npc.meleeCooldown - dt);
        if (!disarmNpc && npc.meleeCooldown <= 0) {
            const cdx = camera.position.x - np.x;
            const cdz = camera.position.z - np.z;
            if (cdx * cdx + cdz * cdz < 1.8 * 1.8) {
                onPlayerHitFrom(np);
                npc.meleeCooldown = 2.5;
            }
        }
        // Walking knights do NOT fire arrows � only tower guards do
    }

    // Editor hand: replace all weapon viewmodels when editor is active
    const _editorHandActive = !!window.__editorActive;
    vmHandGroup.visible = _editorHandActive;
    if (_editorHandActive) {
        vmBarrel.visible       = false;
        vmShotgunGroup.visible = false;
        vmMortarGroup.visible  = false;
        vmMinigunGroup.visible = false;
        vmSniperGroup.visible  = false;
        vmGrenadeGroup.visible = false;
    }

    // Grenade cook animation: two-segment floppy fuse burns down; spring
    // pendulum makes the cord sway with camera movement. Over-hold kills.
    if (grenadeCooking) {
        const nowMs = performance.now();
        const elapsed = nowMs - grenadeCookStart;
        // Over-hold: fuse burns all the way � grenade detonates in hand
        if (elapsed >= GRENADE_FUSE_MS) {
            grenadeCooking = false;
            vmGrenadeGroup.visible = false;
            _vmGrenFuseMat.emissiveIntensity = 0;
            _vmGrenFuseSegA.scale.y = 1;
            _vmGrenFuseSegB.scale.y = 1;
            _vmGrenFuseSegA.position.y = _vmGrenFuseBase + FUSE_HALF * 0.5;
            _vmGrenFusePivot.position.y = _vmGrenFuseBase + FUSE_HALF;
            // Big blast centred on player + deal 3 hits (instant kill)
            const blastPos = new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z);
            triggerBlast(blastPos, 6.0);
            onPlayerHit(); onPlayerHit(); onPlayerHit();  // instant kill
        } else {
            const cookFrac = elapsed / GRENADE_FUSE_MS;
            // --- Spring pendulum: react to camera turns ---
            const yawDelta   = yaw   - _prevYawForFuse;
            const pitchDelta = pitch - _prevPitchForFuse;
            _prevYawForFuse   = yaw;
            _prevPitchForFuse = pitch;
            const stiff = 24, damp = 5.2;
            const restX = 0.04, restZ = 0.02;
            _fuseVelX += (-stiff * (_fuseSwayX - restX) - damp * _fuseVelX + pitchDelta * 10) * dt;
            _fuseVelZ += (-stiff * (_fuseSwayZ - restZ) - damp * _fuseVelZ + yawDelta   * 10) * dt;
            _fuseSwayX += _fuseVelX * dt;
            _fuseSwayZ += _fuseVelZ * dt;
            _fuseSwayX = Math.max(-0.55, Math.min(0.55, _fuseSwayX));
            _fuseSwayZ = Math.max(-0.55, Math.min(0.55, _fuseSwayZ));
            _vmGrenFusePivot.rotation.x = _fuseSwayX;
            _vmGrenFusePivot.rotation.z = _fuseSwayZ;
            // --- Fuse burns from tip: SegB shrinks first, then SegA ---
            const remaining = 1 - cookFrac;
            const segBScale = Math.max(0.001, Math.min(1, remaining * 2));       // first half
            const segAScale = Math.max(0.001, Math.min(1, (remaining - 0.5) * 2)); // second half
            _vmGrenFuseSegB.scale.y = segBScale;
            _vmGrenFuseSegB.position.y = FUSE_HALF * segBScale * 0.5;
            _vmGrenFuse.position.y     = FUSE_HALF * segBScale;  // ember at tip of SegB
            _vmGrenFuseSegA.scale.y    = segAScale;
            _vmGrenFuseSegA.position.y = _vmGrenFuseBase + FUSE_HALF * segAScale * 0.5;
            _vmGrenFusePivot.position.y = _vmGrenFuseBase + FUSE_HALF * segAScale;
            // --- Ember glow: faster pulse near end ---
            const pulse = 0.5 + 0.5 * Math.sin(nowMs * 0.018 * (1 + cookFrac * 4));
            _vmGrenFuseMat.emissiveIntensity = (0.7 + cookFrac * 1.6) * pulse;
            // Arm rises slightly as cook progresses
            vmGrenadeGroup.position.y = THREE.MathUtils.lerp(-0.21, -0.14, cookFrac * 0.7);
            vmGrenadeGroup.rotation.x = THREE.MathUtils.lerp(0.15, -0.10, cookFrac * 0.5);
        }
    }

    if (currentWeapon === WEAPON_IDX_SHOTGUN) {
        const blend = Math.min(1, dt * 13.5);
        const kick = Math.max(0, Math.min(1, shotgunShotKick));
        const tgtX = 0.22;
        const tgtY = -0.29 - kick * 0.022;
        const tgtZ = -0.34 + kick * 0.030;
        const tgtRY = 0;
        const tgtRX = 0;
        vmShotgunGroup.position.x = THREE.MathUtils.lerp(vmShotgunGroup.position.x, tgtX, blend);
        vmShotgunGroup.position.y = THREE.MathUtils.lerp(vmShotgunGroup.position.y, tgtY, blend);
        vmShotgunGroup.position.z = THREE.MathUtils.lerp(vmShotgunGroup.position.z, tgtZ, blend);
        vmShotgunGroup.rotation.y = THREE.MathUtils.lerp(vmShotgunGroup.rotation.y, tgtRY, blend);
        vmShotgunGroup.rotation.x = THREE.MathUtils.lerp(vmShotgunGroup.rotation.x, tgtRX, blend);

        const breakProgress = 1 - Math.max(0, Math.min(1, shotgunBreakAnim));
        let breakPhase = 0;
        if (breakProgress < 0.42) {
            breakPhase = breakProgress / 0.42;
        } else if (breakProgress < 0.60) {
            breakPhase = 1;
        } else {
            breakPhase = Math.max(0, 1 - ((breakProgress - 0.60) / 0.40));
        }
        vmShotgunBreakGroup.rotation.x = -0.80 * breakPhase;
        vmShotgunTopLeverPivot.rotation.x = -0.72 * breakPhase;

        if (!shotgunEjectTriggered && breakProgress >= 0.46) {
            shotgunEjectTriggered = true;
            shotgunEjectAnim = 0.001;
        }
        if (shotgunEjectTriggered && shotgunEjectAnim < 1) {
            shotgunEjectAnim = Math.min(1, shotgunEjectAnim + dt * 5.2);
        }

        const ejectT = 1 - Math.pow(1 - Math.min(1, shotgunEjectAnim), 3);
        const ejectVisible = shotgunEjectTriggered && shotgunEjectAnim < 1;
        vmShotgunShellL.visible = !shotgunEjectTriggered;
        vmShotgunShellR.visible = !shotgunEjectTriggered;
        vmShotgunEjectL.visible = ejectVisible;
        vmShotgunEjectR.visible = ejectVisible;
        if (ejectVisible) {
            vmShotgunEjectL.position.set(-0.052 - ejectT * 0.030, -0.010 + ejectT * 0.080, -0.030 + ejectT * 0.105);
            vmShotgunEjectR.position.set(0.052 + ejectT * 0.030, -0.010 + ejectT * 0.080, -0.030 + ejectT * 0.105);
            vmShotgunEjectL.rotation.set(Math.PI / 2 - ejectT * 0.95, 0, -ejectT * 2.8);
            vmShotgunEjectR.rotation.set(Math.PI / 2 - ejectT * 0.95, 0, ejectT * 2.8);
        }

        shotgunBreakAnim = Math.max(0, shotgunBreakAnim - dt * SHOTGUN_BREAK_SPEED);
        if (shotgunBreakAnim <= 0) {
            shotgunEjectAnim = 0;
            shotgunEjectTriggered = false;
            vmShotgunEjectL.visible = false;
            vmShotgunEjectR.visible = false;
            vmShotgunShellL.visible = true;
            vmShotgunShellR.visible = true;
            vmShotgunTopLeverPivot.rotation.x = 0;
        }
    }

    // Minigun barrel spin � rotate around Y (barrel long axis toward target)
    if (currentWeapon === WEAPON_IDX_MINIGUN) {
        const spinSpeed = minigunFiring ? 12 : Math.max(0, (vmMgBarrelSpin.userData.spinSpeed || 0) - dt * 6);
        vmMgBarrelSpin.userData.spinSpeed = minigunFiring ? 12 : spinSpeed;
        vmMgBarrelSpin.rotation.y += (minigunFiring ? 12 : spinSpeed) * dt;
    }
    if (currentWeapon === WEAPON_IDX_SNIPER) {
        const liftRaw = Math.max(0, Math.min(1, sniperAdsPose / 0.58));
        const lift = liftRaw * liftRaw * (3 - 2 * liftRaw);
        const settleRaw = Math.max(0, Math.min(1, (sniperAdsPose - 0.58) / 0.42));
        const settle = settleRaw * settleRaw * (3 - 2 * settleRaw);

        const liftTgt = {
            x: THREE.MathUtils.lerp(SNIPER_VM_HIP.x, SNIPER_VM_ADS_LIFT.x, lift),
            y: THREE.MathUtils.lerp(SNIPER_VM_HIP.y, SNIPER_VM_ADS_LIFT.y, lift),
            z: THREE.MathUtils.lerp(SNIPER_VM_HIP.z, SNIPER_VM_ADS_LIFT.z, lift),
            ry: THREE.MathUtils.lerp(SNIPER_VM_HIP.ry, SNIPER_VM_ADS_LIFT.ry, lift),
            rx: THREE.MathUtils.lerp(SNIPER_VM_HIP.rx, SNIPER_VM_ADS_LIFT.rx, lift),
        };
        const settleTgt = {
            x: THREE.MathUtils.lerp(liftTgt.x, SNIPER_VM_ADS_EYE.x, settle),
            y: THREE.MathUtils.lerp(liftTgt.y, SNIPER_VM_ADS_EYE.y, settle),
            z: THREE.MathUtils.lerp(liftTgt.z, SNIPER_VM_ADS_EYE.z, settle),
            ry: THREE.MathUtils.lerp(liftTgt.ry, SNIPER_VM_ADS_EYE.ry, settle),
            rx: THREE.MathUtils.lerp(liftTgt.rx, SNIPER_VM_ADS_EYE.rx, settle),
        };

        const tgt = settleTgt;
        const blend = Math.min(1, dt * 12.5);
        const hideScopeHardware = sniperScopeTunnel > 0.08;
        sniperScopeAimBlend = THREE.MathUtils.lerp(sniperScopeAimBlend, hideScopeHardware ? 1 : 0, Math.min(1, dt * 14));
        vmSniperScopeRingMat.opacity = THREE.MathUtils.lerp(1.0, 0.42, sniperScopeAimBlend);
        vmSniperScopeLensMat.opacity = THREE.MathUtils.lerp(0.06, 0.0, sniperScopeAimBlend);
        vmSniperScopeBody.visible = !hideScopeHardware;
        vmSniperScopeRingA.visible = !hideScopeHardware;
        vmSniperScopeRingB.visible = !hideScopeHardware;
        vmSniperScopeFront.visible = !hideScopeHardware && vmSniperScopeLensMat.opacity > 0.004;
        vmScopeMountBaseA.visible = !hideScopeHardware;
        vmScopeMountBaseB.visible = !hideScopeHardware;
        vmSniperGroup.position.x = THREE.MathUtils.lerp(vmSniperGroup.position.x, tgt.x, blend);
        vmSniperGroup.position.y = THREE.MathUtils.lerp(vmSniperGroup.position.y, tgt.y, blend);
        vmSniperGroup.position.z = THREE.MathUtils.lerp(vmSniperGroup.position.z, tgt.z, blend);
        vmSniperGroup.rotation.y = THREE.MathUtils.lerp(vmSniperGroup.rotation.y, tgt.ry, blend);
        vmSniperGroup.rotation.x = THREE.MathUtils.lerp(vmSniperGroup.rotation.x, tgt.rx, blend);
        const boltPhase = Math.max(0, sniperBoltAnim);
        vmSniperBoltGroup.position.z = -0.07 * Math.sin(Math.min(1, boltPhase) * Math.PI);
        vmSniperBoltGroup.rotation.y = 0.32 * Math.sin(Math.min(1, boltPhase) * Math.PI);
        sniperBoltAnim = Math.max(0, sniperBoltAnim - dt * 4.5);
    }

    // Minigun auto-fire while mouse held
    if (minigunFiring && currentWeapon === WEAPON_IDX_MINIGUN && !gameOver && !gamePaused) {
        const now = performance.now();
        if (now >= minigunNextFire) {
            minigunNextFire = now + MINIGUN_RATE;
            fireCannonball(parseFloat(document.getElementById('power').value));
        }
    }

    // Fixed timestep 1/60 s � cannon accumulates sub-steps so high-fps
    // screens don't run physics in slow motion.
    const physicsDt = slowMo ? dt * 0.25 : dt;

    // CCD prep: remember where each ball is BEFORE stepping so we can ray-check
    // the segment it travels this step (anti-tunnel for fast / far shots).
    for (const cb of cannonballs) {
        if (cb.body.userData && cb.body.userData.sniper) {
            // Integrate simple ballistic model for sniper rounds: gravity drop + drag.
            const v = cb.body.velocity;
            const drag = Math.max(0, 1 - SNIPER_DRAG * dt);
            v.x *= drag;
            v.z *= drag;
            v.y = v.y * drag - SNIPER_GRAVITY * dt;

            // Near-miss supersonic crack when bullet passes close to player.
            if (!cb.body.userData.whizzed) {
                const cp = cb.body.position;
                const dx = cp.x - camera.position.x;
                const dy = cp.y - (camera.position.y + 0.1);
                const dz = cp.z - camera.position.z;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d < 4.5) {
                    playBulletWhizz(d);
                    cb.body.userData.whizzed = true;
                }
            }
        }
        // Clamp regular cannonballs to the max speed that stays clip-safe at the
        // 1/60 step (minigun rounds are tiny + fast and lean on the CCD raycast).
        if (cb.weaponType !== WEAPON_IDX_MINIGUN && cb.weaponType !== WEAPON_IDX_SNIPER && cb.weaponType !== WEAPON_IDX_SHOTGUN) {
            const v = cb.body.velocity;
            const s2 = v.x * v.x + v.y * v.y + v.z * v.z;
            if (s2 > MAX_BALL_SPEED2) {
                const s = MAX_BALL_SPEED / Math.sqrt(s2);
                v.x *= s; v.y *= s; v.z *= s;
            }
        }
        const p = cb.body.position;
        cb._px = p.x; cb._py = p.y; cb._pz = p.z;
    }

    // FPV Drone: update velocity on kinematic body before physics step
    if (activeDrone && !activeDrone.detonated) {
        const d = activeDrone;

        if (d._crashing) {
            // Arrow-hit crash: motors dead, full gravity + wild spin
            droneVy -= 9.81 * dt;          // full gravity, no lift
            droneVx *= (1 + 0.55 * dt);   // diverging lateral drift
            droneVz *= (1 + 0.55 * dt);
        } else {
        // Roll: spring toward A/D input (A = tilt right, D = tilt left)
        const joyRight = (touchControls.enabled && activeDrone) ? touchControls.moveRight : 0;
        const joyFwd   = (touchControls.enabled && activeDrone) ? touchControls.moveForward : 0;
        const rollInput = (keys.a ? 1 : 0) + (keys.d ? -1 : 0) - joyRight;
        droneRoll += (rollInput * DRONE_ROLL_LIMIT - droneRoll) * Math.min(1, DRONE_ROLL_SPEED * dt);

        // W/S spring dronePitch: W = nose down (forward), S = nose up (backward)
        const pitchTarget = keys.w ? 0.45 : keys.s ? -0.22 : joyFwd * 0.45;
        dronePitch += (pitchTarget - dronePitch) * Math.min(1, 2.2 * dt);

        // World-space forward direction from yaw + pitch
        const sinY = Math.sin(droneYaw), cosY = Math.cos(droneYaw);
        const pitchS = Math.sin(dronePitch), pitchC = Math.cos(dronePitch);

        // Apply velocity drag
        const dragF = Math.exp(-DRONE_DRAG * dt);
        droneVx *= dragF;
        droneVz *= dragF;
        droneVy *= Math.exp(-DRONE_DRAG * 0.45 * dt);

        // Forward thrust proportional to pitch tilt
        const fwdThrust = dronePitch * DRONE_FWD_SPEED;
        droneVx += (-sinY * pitchC) * fwdThrust * dt * 10.0;
        droneVz += (-cosY * pitchC) * fwdThrust * dt * 10.0;

        // Lateral thrust from roll banking (A/D strafe) � negated to match tilt direction
        const latThrust = -droneRoll * DRONE_FWD_SPEED;
        droneVx += cosY * latThrust * dt * 10.0;
        droneVz += (-sinY) * latThrust * dt * 10.0;

        // Vertical: LMB=ascend / RMB=descend + light residual gravity
        const altInput = (droneAscend ? 1.0 : 0.0) - (droneDescend ? 1.0 : 0.0);
        droneVy += (altInput * DRONE_UP_SPEED - DRONE_GRAVITY) * dt;
        }

        // Speed cap
        const spd2 = droneVx*droneVx + droneVy*droneVy + droneVz*droneVz;
        if (spd2 > 30 * 30) {
            const s = 30 / Math.sqrt(spd2);
            droneVx *= s; droneVy *= s; droneVz *= s;
        }

        // Save position for post-step CCD tunnel check
        d._px = d.body.position.x;
        d._py = d.body.position.y;
        d._pz = d.body.position.z;

        // Set kinematic body velocity (cannon integrates position during world.step)
        d.body.velocity.set(droneVx, droneVy, droneVz);
    }

    // Fixed 1/60 step with substeps capped at 4. Clip-prone fast cannonballs are
    // held below MAX_BALL_SPEED above, and the CCD raycast below catches any
    // remaining fast/far shots, so we get smooth real-time physics without the
    // slow-motion the finer 1/120 step could cause on heavy frames.
    // Keep at least 2 substeps in mobile emergency. A single substep can
    // increase post-impact penetration/correction churn and trap low FPS.
    const physicsSubsteps = (isMobileProfile && _mobilePerfEmergency) ? 2 : 4;
    const physicsStartAt = _perfDebugEnabled ? performance.now() : 0;
    world.step(1 / 60, physicsDt, physicsSubsteps);
    if (_perfDebugEnabled) perfDebugMarkPhysics(performance.now() - physicsStartAt);

    // Heavy round-shot settle: once a cannonball is on/near ground and moving
    // slowly, bleed residual roll and put it to sleep. This prevents perpetual
    // skating while keeping high-speed impacts unchanged.
    for (const cb of cannonballs) {
        if (cb.weaponType === WEAPON_IDX_MINIGUN || cb.weaponType === WEAPON_IDX_SHOTGUN) continue; // minigun/shotgun rounds are intentionally light/fast
        const v = cb.body.velocity;
        const w = cb.body.angularVelocity;
        const horiz2 = v.x * v.x + v.z * v.z;
        const nearGround = cb.body.position.y < 0.9;
        if (!nearGround) continue;
        if (horiz2 < 1.0 && Math.abs(v.y) < 0.35) {
            v.x *= 0.82; v.z *= 0.82;
            w.x *= 0.78; w.y *= 0.78; w.z *= 0.78;
        }
        if (horiz2 < 0.05 && Math.abs(v.y) < 0.12) {
            v.x = 0; v.y = 0; v.z = 0;
            w.x = 0; w.y = 0; w.z = 0;
            cb.body.sleep();
        }
        if (cb.weaponType === WEAPON_IDX_CANNON) {
            if (horiz2 < 0.16 && Math.abs(v.y) < 0.18) {
                cb._restingMs = (cb._restingMs || 0) + dt * 1000;
            } else {
                cb._restingMs = 0;
            }
        }
        if (isMobileProfile) {
            // Mobile Safari can stay expensive while a near-rest cannonball keeps
            // participating in broadphase updates. Cull only after it has been
            // effectively dead for a short, continuous window.
            if (horiz2 < 0.28 && Math.abs(v.y) < 0.18) {
                cb._restingMs = (cb._restingMs || 0) + dt * 1000;
            } else {
                cb._restingMs = 0;
            }
        }
    }

    // CCD resolve: if a ball crossed a solid surface this step, pull it back to
    // that surface so it can't clip through a wall / tower face. Snapping the
    // sphere tangent to the hit point lets the discrete solver apply the impact
    // (and fire the brick-knock impulse) on the next step instead of tunnelling.
    // Keep CCD active during the opening mobile seconds unless explicitly
    // rolled back with ?shotfix=0 for A/B testing.
    const runProjectileCcd = !isMobileProfile || !mobileEarlyRound || MOBILE_SHOT_STABILITY_FIX;
    if (runProjectileCcd) {
        for (const cb of cannonballs) {
            if (cb._px === undefined) continue;
            const p = cb.body.position;
            const dx = p.x - cb._px, dy = p.y - cb._py, dz = p.z - cb._pz;
            const travel2 = dx * dx + dy * dy + dz * dz;
            if (travel2 < 1e-4) continue;          // essentially stationary � skip
            const r = cb.body.shapes[0].radius || 0.2;
            const travel = Math.sqrt(travel2);
            const inv = 1 / travel;
            _ccdFrom.set(cb._px, cb._py, cb._pz);
            // Extend the segment forward by one radius so the ball's *leading*
            // surface is tested, not just its centre � catches grazing contacts and
            // fast rounds threading the small gaps between tower bricks.
            _ccdTo.set(p.x + dx * inv * r, p.y + dy * inv * r, p.z + dz * inv * r);
            _ccdResult.reset();
            world.raycastClosest(_ccdFrom, _ccdTo, _ccdRayOpts, _ccdResult);
            if (_ccdResult.hasHit && _ccdResult.body !== cb.body) {
                const hp = _ccdResult.hitPointWorld;
                cb.body.position.set(
                    hp.x - (dx * inv) * r,
                    hp.y - (dy * inv) * r,
                    hp.z - (dz * inv) * r
                );
            }
        }
    }

    // FPV Drone CCD: raycast along the drone's travel path to catch tunneling
    // through bricks at high speed (kinematic bodies skip standard CCD).
    if (activeDrone && !activeDrone.detonated && activeDrone._px !== undefined) {
        const d  = activeDrone;
        const bp = d.body.position;
        const ddx = bp.x - d._px, ddy = bp.y - d._py, ddz = bp.z - d._pz;
        const travel2 = ddx*ddx + ddy*ddy + ddz*ddz;
        if (travel2 > 1e-4) {
            const r      = 0.22;          // drone collision sphere radius
            const travel = Math.sqrt(travel2);
            const inv    = 1 / travel;
            _ccdFrom.set(d._px, d._py, d._pz);
            _ccdTo.set(bp.x + ddx * inv * r, bp.y + ddy * inv * r, bp.z + ddz * inv * r);
            _ccdResult.reset();
            world.raycastClosest(_ccdFrom, _ccdTo, _droneCcdRayOpts, _ccdResult);
            if (_ccdResult.hasHit && _ccdResult.body !== d.body) {
                // Pull drone back to surface then detonate
                const hp = _ccdResult.hitPointWorld;
                bp.x = hp.x - ddx * inv * r;
                bp.y = hp.y - ddy * inv * r;
                bp.z = hp.z - ddz * inv * r;
                detonateDrone();
            }
        }
    }

    // Sync instanced brick meshes ? only bricks that are awake need updating.
    // We rebuild both instance matrices in full each frame (fast since GPU
    // upload of a contiguous Float32Array is cheap).
    // Toppling propagation only needs to run a few times a second � gate the
    // (potentially O(bricks?moving) ) scan to every _WAKE_PROP_INTERVAL frames
    // so big collapses don't tank the frame rate. Collapse still looks continuous
    // because moving bricks stay moving across the skipped frames.
    const wakePropInterval = getWakePropagationInterval();
    const wakePropBudget = getWakePropagationBudget();
    const _doPropFrame = (_frameCount % wakePropInterval) === 0;
    let movingMasonryCount = 0;
    let movingMasonryEnergy = 0;
    if (_doPropFrame) _awakeBrickPts.length = 0;
    let awakeBricksThisFrame = 0;
    for (const b of frameActiveBricks) {
        if (b.idx < 0) {
            // Standalone (non-instanced) lintel beams: once dropped they become
            // dynamic, so keep their mesh in sync with the physics body.
            if (b.isLintel && b.dropped && b.mesh) {
                b.mesh.position.copy(b.body.position);
                b.mesh.quaternion.copy(b.body.quaternion);
                if (b.body.sleepState === 0) _lastDisturbFrame = _frameCount;
            }
            // Dynamic hut roof: a single rigid body driving the roof group. Its
            // group origin is offY below the body centre, so apply that offset in
            // the body's local frame when syncing.
            else if (b.isRoof && b.mesh) {
                b.mesh.quaternion.copy(b.body.quaternion);
                _roofOff.set(0, b.offY, 0).applyQuaternion(b.body.quaternion);
                b.mesh.position.set(
                    b.body.position.x + _roofOff.x,
                    b.body.position.y + _roofOff.y,
                    b.body.position.z + _roofOff.z
                );
                if (b.body.sleepState === 0) _lastDisturbFrame = _frameCount;
            }
            continue;   // static non-instanced pieces (lintel etc.)
        }
        // Sleep gating: a fully-sleeping brick (state 2) can't move, splash or
        // need damping � skip its water shoreline lookups (several trig-heavy
        // profile evals each) and its matrix compose. SLEEPY (1) bricks still
        // integrate slowly, so they keep the full path.
        const brickSimulated = b.body.sleepState !== 2;
        const brickWaterY = brickSimulated ? getWaterSurfaceYAtXZ(b.body.position.x, b.body.position.z) : null;
        const brickSubmerged = brickWaterY != null && b.body.position.y <= brickWaterY + 0.95;
        // Cap awake-brick speed/spin so no single brick can carry runaway
        // energy that cascade-shatters a tower. Keeps destruction consistent
        // across all towers while still letting direct hits fling stone.
        if (b.body.sleepState === 0) {
            awakeBricksThisFrame++;
            _lastDisturbFrame = _frameCount;  // structure is in motion
            const v = b.body.velocity;
            const s2 = v.x * v.x + v.y * v.y + v.z * v.z;
            if (!b.isPlank && !b.isRoof && !b.isHutSupport && s2 > 0.32) {
                movingMasonryCount++;
                movingMasonryEnergy += Math.min(64, s2);
            }
            // Pick the speed cap per brick: a freshly-struck brick keeps the high
            // PUNCH cap for a few frames; tower (wedge) bricks use the tower cap so
            // they can eject from the ring; everything else (walls, debris,
            // solver-resolved overlaps) uses the low cap that keeps walls local.
            let capV, capV2;
            if (b.body._punchUntil > _frameCount) {
                capV = PUNCH_BRICK_SPEED; capV2 = PUNCH_BRICK_SPEED2;
            } else if (b.storyRole === 'bridge') {
                capV = BRIDGE_BRICK_SPEED; capV2 = BRIDGE_BRICK_SPEED2;
            } else if (b.grp === CGROUP_TOWER) {
                capV = TOWER_BRICK_SPEED; capV2 = TOWER_BRICK_SPEED2;
            } else {
                capV = MAX_BRICK_SPEED; capV2 = MAX_BRICK_SPEED2;
            }
            if (s2 > capV2) {
                const s = capV / Math.sqrt(s2);
                v.x *= s; v.y *= s; v.z *= s;
            }
            // Anti-pop: a flat-wall brick should be knocked OUTWARD and tumble
            // DOWN, never launched skyward. Explosive contact resolution between
            // tightly-stacked wall blocks occasionally converts a hit into a big
            // upward velocity � the "whole wall jumps up and self-destructs" bug.
            // Cap upward velocity hard for wall bricks so a breach stays local and
            // realistic. Towers are exempt (a voussoir must ride UP out of its
            // ring), and a freshly-punched brick keeps its full ejection window.
            if (b.grp === CGROUP_BRICK && b.body._punchUntil <= _frameCount && v.y > WALL_MAX_UP) {
                v.y = WALL_MAX_UP;
            }
            const av = b.body.angularVelocity;
            const a2 = av.x * av.x + av.y * av.y + av.z * av.z;
            if (a2 > MAX_BRICK_SPIN2) {
                const a = MAX_BRICK_SPIN / Math.sqrt(a2);
                av.x *= a; av.y *= a; av.z *= a;
            }
            // Record this moving brick so we can wake the sleeping neighbours it
            // is undermining (see the toppling-propagation pass below).
            // Planks need to be genuinely airborne (=1.4 m/s, s�=2.0) before they
            // cascade-wake the planks above � stops pellet fan-out from collapsing
            // the whole hut while still letting cannonball / blast flings cascade.
            const plankCascadeThresh = b.isPlank ? 2.0 : _WAKE_PROP_MOVE2;
            if (_doPropFrame && s2 > plankCascadeThresh && !brickSubmerged) {
                const p = b.body.position;
                _awakeBrickPts.push(p.x, p.y, p.z, b.grp);
            }
        }

        if (brickWaterY != null && b.body.type === CANNON.Body.DYNAMIC) {
            if (brickSubmerged && !b._waterSubmergedPrev) {
                const speed = b.body.velocity.length();
                if (speed > 0.35) {
                    const brickRippleY = getWaterVisualSurfaceYAtXZ(b.body.position.x, b.body.position.z) ?? brickWaterY;
                    spawnWaterImpactRipple(b.body.position.x, b.body.position.z, brickRippleY, speed, getRippleRoleAtXZ(b.body.position.x, b.body.position.z));
                }
            }
            b._waterSubmergedPrev = brickSubmerged;
        } else {
            b._waterSubmergedPrev = false;
            b._waterSettleTimer = 0;
        }

        if (brickWaterY != null && b.body.type === CANNON.Body.DYNAMIC && b.body.position.y <= brickWaterY + 1.05) {
            const vv = b.body.velocity;
            const av = b.body.angularVelocity;
            const depth = Math.max(0, brickWaterY - b.body.position.y + 0.55);
            const floorY = brickWaterY - WATER_SETTLE_DEPTH_OFFSET;
            const bodyHalfY = getBodyAabbHalfHeight(b.body, BS.h * 0.5);
            const floorTargetY = floorY + bodyHalfY + 0.02;
            const nearFloor = b.body.position.y <= floorTargetY + 0.08;
            const targetVy = -0.36 - Math.min(1.2, depth * 0.55);
            const sinkBlend = Math.min(1, dt * 6.0);

            b.body.linearDamping = Math.max(b.body.linearDamping, WATER_BRICK_LINEAR_DAMPING);
            b.body.angularDamping = Math.max(b.body.angularDamping, WATER_BRICK_ANGULAR_DAMPING);

            vv.x *= 0.94;
            vv.z *= 0.94;

            // Pit behavior only: no buoyancy lift. Bricks fall in, lose energy,
            // and settle against the trench floor with correct body clearance.
            if (!nearFloor) {
                if (vv.y > targetVy) {
                    vv.y = THREE.MathUtils.lerp(vv.y, targetVy, sinkBlend);
                }
                if (vv.y > 0.02) vv.y = 0.02;
            } else {
                if (b.body.position.y < floorTargetY) b.body.position.y = floorTargetY;
                vv.y = (vv.y < 0) ? vv.y * 0.2 : vv.y * 0.5;
                if (Math.abs(vv.y) < 0.03) vv.y = 0;
            }

            av.x *= 0.86;
            av.y *= 0.86;
            av.z *= 0.86;

            const speed2 = vv.x * vv.x + vv.y * vv.y + vv.z * vv.z;
            const ang2 = av.x * av.x + av.y * av.y + av.z * av.z;
            if (nearFloor && speed2 < WATER_BRICK_SLEEP_SPEED2 && ang2 < WATER_BRICK_SLEEP_ANG2) {
                b._waterSettleTimer = (b._waterSettleTimer || 0) + dt;
                if (b._waterSettleTimer >= WATER_BRICK_SLEEP_DELAY) {
                    vv.x = 0; vv.y = 0; vv.z = 0;
                    av.x = 0; av.y = 0; av.z = 0;
                    b.body.position.y = Math.max(b.body.position.y, floorTargetY);
                    b.body.sleep();
                }
            } else {
                b._waterSettleTimer = Math.max(0, (b._waterSettleTimer || 0) - dt * 0.5);
            }
        }

        // Sync the instance matrix while simulated, plus ONE extra frame after
        // falling asleep so the visual lands exactly on the body's final pose.
        if (brickSimulated || b._wasSimulatedPrev) {
            _iDummy.position.copy(b.body.position);
            _iDummy.quaternion.copy(b.body.quaternion);
            if (b.isPlank && b.lenScale) _iDummy.scale.set(b.isZ ? 1 : b.lenScale, 1, b.isZ ? b.lenScale : 1);
            _iDummy.updateMatrix();
            _iDummy.scale.set(1, 1, 1);
            if (b.isPlank) {
                if (b.isZ) plankInstZ.setMatrixAt(b.idx, _iDummy.matrix);
                else       plankInstX.setMatrixAt(b.idx, _iDummy.matrix);
            } else if (b.isWedge) {
                towerInst.setMatrixAt(b.idx, _iDummy.matrix);
            } else {
                if (b.isCube) brickInstC.setMatrixAt(b.idx, _iDummy.matrix);
                else if (b.isSlab) brickInstH.setMatrixAt(b.idx, _iDummy.matrix);
                else if (b.isY) brickInstY.setMatrixAt(b.idx, _iDummy.matrix);
                else if (b.isZ) brickInstZ.setMatrixAt(b.idx, _iDummy.matrix);
                else            brickInstX.setMatrixAt(b.idx, _iDummy.matrix);
            }
        }
        b._wasSimulatedPrev = brickSimulated;
        if (!b.scored && brickSimulated) {
            const dx = b.body.position.x - b.ix;
            const dy = b.body.position.y - b.iy;
            const dz = b.body.position.z - b.iz;
            if (dx * dx + dy * dy + dz * dz > 0.25) {
                b.scored = true; bricksDestroyed++; score += 10; updateUI();
                addBrickScorePopup(b.body.position.x, b.body.position.y, b.body.position.z);
            }
        }
    }
    brickInstX.instanceMatrix.needsUpdate = true;
    brickInstZ.instanceMatrix.needsUpdate = true;
    brickInstY.instanceMatrix.needsUpdate = true;
    brickInstC.instanceMatrix.needsUpdate = true;
    brickInstH.instanceMatrix.needsUpdate = true;
    towerInst.instanceMatrix.needsUpdate = true;
    plankInstX.instanceMatrix.needsUpdate = true;
    plankInstZ.instanceMatrix.needsUpdate = true;
    updateMasonrySoundscape(movingMasonryCount, movingMasonryEnergy, dt);

    // Tower-platform support + sync: each static deck rests on its tower's top
    // ring. Once that ring is destroyed (its bricks have woken / fallen away)
    // the deck has nothing under it, so release it to fall under gravity instead
    // of leaving it floating. A dropped deck then tracks its dynamic body.
    if (!bridgeStageActive) {
        for (const pf of towerPlatforms) {
            if (!pf.dropped) {
                const platformSupportStride = mobileImpactBudgetMode
                    ? 24
                    : (currentDifficulty === 'squire'
                        ? (isMobileProfile ? 18 : 12)
                        : 6);
                if (_frameCount % platformSupportStride === 0 && _frameCount > 180) {
                    const HR2 = (TOWER_R + 0.5) * (TOWER_R + 0.5);
                    let support = 0;
                    for (const b of castleScanBricks) {
                        if (b.grp !== CGROUP_TOWER) continue;
                        if (b.body.sleepState !== 2) continue;        // settled bricks only
                        const dx = b.body.position.x - pf.cx;
                        const dz = b.body.position.z - pf.cz;
                        if (dx * dx + dz * dz > HR2) continue;
                        if (b.body.position.y < pf.floorY - 2.2) continue;  // near the top ring
                        support++;
                        if (support >= 4) break;
                    }
                    if (support < 4) {
                        pf.body.type = CANNON.Body.DYNAMIC;
                        pf.body.mass = 90;
                        pf.body.updateMassProperties();
                        pf.body.velocity.set(0, 0, 0);
                        pf.body.angularVelocity.set(0, 0, 0);
                        pf.body.linearDamping = 0.30;
                        pf.body.angularDamping = 0.55;
                        pf.body.wakeUp();
                        pf.dropped = true;
                    }
                }
            } else {
                pf.mesh.position.copy(pf.body.position);
                pf.mesh.quaternion.copy(pf.body.quaternion);
            }
        }
    }

    // NPC face anger: global anger grows monotonically with destruction; faces
    // start as big happy grins and shift to red-faced furious as the round progresses.
    {
        // Recompute world anger target each frame � never decreases.
        const brickAnger = Math.min(0.72, bricksDestroyed / 75);
        const killAnger  = Math.min(0.28, _npcKillCount  * 0.12);
        const worldTarget = Math.min(1.0, brickAnger + killAnger);
        if (worldTarget > _npcWorldAnger)
            _npcWorldAnger = THREE.MathUtils.lerp(_npcWorldAnger, worldTarget, Math.min(1, dt * 0.6));

        const faceClock = performance.now() * 0.001;
        const L = THREE.MathUtils.lerp;
        for (const npc of npcList) {
            if (npc.isRagdoll || !npc.group || !npc.anim) continue;
            // Per-NPC anger: local proximity spike, decays slowly but floor is world anger.
            // The king's mood is scripted (smug -> furious -> laughing) in
            // updateKingPose, so he skips the world floor entirely.
            npc.angerLevel = npc.isBunkerKing
                ? (npc.angerLevel || 0)
                : Math.max(_npcWorldAnger, (npc.angerLevel || 0) - dt * 0.06);
            const anger = npc.angerLevel;
            const { browL, browR, mouthGroup, lipArc, mouthOpen, teeth,
                    eyeL, eyeR, headMesh } = npc.anim;
            const phase = npc.anim.facePhase || 0;
            const t = Math.min(1, dt * 3.5);
            // Expression phases: sarcastic laughing ? souring ? shouting fury.
            const laughing = 1 - THREE.MathUtils.smoothstep(anger, 0.08, 0.40);
            const fury = THREE.MathUtils.smoothstep(anger, 0.55, 0.88);
            // Slow smug drift keeps the mockery alive instead of a frozen grin.
            const sarcasm = laughing * (0.55 + 0.45 * Math.sin(faceClock * 0.9 + phase));
            // Brows: mocking = one raised skeptical brow; angry = hard deep V.
            const browRotBase = L(-0.30, 1.05, anger);
            const browYBase   = L(0.072, 0.022, anger);
            if (browL) {
                browL.rotation.z = L(browL.rotation.z,  browRotBase - sarcasm * 0.34, t);
                browL.position.y = L(browL.position.y, browYBase + sarcasm * 0.020, t);
                browL.position.x = L(browL.position.x, -0.06 + anger * 0.022, t);
            }
            if (browR) {
                browR.rotation.z = L(browR.rotation.z, -browRotBase - sarcasm * 0.14, t);
                browR.position.y = L(browR.position.y, browYBase - sarcasm * 0.006, t);
                browR.position.x = L(browR.position.x,  0.06 - anger * 0.022, t);
            }
            // Eyes: laughing squint ? wide furious glare.
            if (eyeL && eyeR) {
                const eyeY  = L(L(1.0, 0.42, laughing), 1.55, fury);
                const eyeXZ = 1 + fury * 0.35;
                eyeL.scale.set(L(eyeL.scale.x, eyeXZ, t), L(eyeL.scale.y, eyeY, t), L(eyeL.scale.z, eyeXZ, t));
                eyeR.scale.copy(eyeL.scale);
            }
            // Mouth: ? grin ? flat line ? n bellowing frown, with an openable jaw.
            if (mouthGroup && lipArc && mouthOpen) {
                let curve = L(1.0, -1.0, THREE.MathUtils.smoothstep(anger, 0.12, 0.80));
                if (Math.abs(curve) < 0.06) curve = curve < 0 ? -0.06 : 0.06;
                const width = L(L(0.95, 1.35, laughing), 1.30, fury);
                lipArc.scale.x = L(lipArc.scale.x, width, t);
                lipArc.scale.y = L(lipArc.scale.y, curve, t);
                // Smirk tilt while sarcastic; levels out as the mood sours.
                mouthGroup.rotation.z = L(mouthGroup.rotation.z, laughing * 0.20, t);
                mouthGroup.position.y = L(mouthGroup.position.y, -0.060 - fury * 0.014, t);
                // Jaw: rhythmic chuckle at low anger, hard shouting bursts at fury.
                const chuckle = laughing * (0.35 + 0.30 * Math.max(0, Math.sin(faceClock * 7.5 + phase)));
                const shout = fury * (0.55 + 0.45 * Math.abs(Math.sin(faceClock * 4.6 + phase)));
                const jaw = Math.max(chuckle, shout);
                mouthOpen.visible = jaw > 0.08;
                mouthOpen.scale.x = L(mouthOpen.scale.x, 1.15 + jaw * 0.40, t);
                mouthOpen.scale.y = L(mouthOpen.scale.y, 0.02 + jaw * 1.35, t);
                mouthOpen.position.y = L(mouthOpen.position.y,
                    (curve > 0 ? -0.014 : 0.004) - jaw * 0.030, t);
                // Teeth flash through the mocking grin only.
                if (teeth) teeth.visible = laughing > 0.25 && jaw > 0.12;
            }
            // Skin flush: warm skin ? red-faced angry.
            if (headMesh && headMesh.material) {
                _skinColorScratch.lerpColors(_skinColorHappy, _skinColorAngry, anger * anger);
                headMesh.material.color.lerp(_skinColorScratch, t);
            }
        }
    }

    // Front banners: hang static until their anchor brick is knocked loose,
    // then detach and fall under simple gravity (no cloth sim).
    for (const bn of banners) {
        if (!bn.falling) {
            const a = bn.anchor;
            if (a && bn.anchorRest && _frameCount > 180) {
                const p = a.body.position;
                const moved = Math.abs(p.x - bn.anchorRest.x) > 0.25
                            || Math.abs(p.y - bn.anchorRest.y) > 0.25
                            || Math.abs(p.z - bn.anchorRest.z) > 0.25;
                if (a.body.sleepState === 0 && moved) {
                    bn.falling = true;
                    bn.vx = (Math.random() - 0.5) * 1.2;
                    bn.vz = -0.6 - Math.random() * 0.8;   // peels off the wall
                    bn.vy = 0.5;
                    bn.rvx = (Math.random() - 0.5) * 2.2;
                    bn.rvz = (Math.random() - 0.5) * 2.2;
                }
            }
        } else if (bn.life > 0) {
            bn.vy -= 11 * dt;                 // gravity
            bn.vx *= 0.99; bn.vz *= 0.99;
            bn.mesh.position.x += bn.vx * dt;
            bn.mesh.position.y += bn.vy * dt;
            bn.mesh.position.z += bn.vz * dt;
            bn.mesh.rotation.x += bn.rvx * dt;
            bn.mesh.rotation.z += bn.rvz * dt;
            if (bn.mesh.position.y < 0.3) {   // settle on the ground
                bn.mesh.position.y = 0.3;
                bn.vy = 0; bn.vx *= 0.6; bn.vz *= 0.6;
                bn.rvx *= 0.4; bn.rvz *= 0.4;
                bn.life -= dt;
            }
        }
    }

    // Toppling propagation: a moving brick wakes only the sleeping bricks
    // resting *directly on top of it* (roughly overlapping in XZ, one course
    // higher). Those are the bricks it was supporting, so they now fall under
    // gravity (a sleeping body gets no gravity in cannon-es, so an undermined
    // slab would otherwise just hang in the air). Restricting to the bricks
    // above � rather than all neighbours � keeps the physics solver's awake set
    // small, so big collapses don't balloon the per-step cost. It injects NO
    // impulse (gravity does the work) and towers/walls are collision-decoupled,
    // so a brick that turns out to still be supported simply settles back to
    // sleep within sleepTimeLimit. A per-scan budget bounds the worst case.
    if (_doPropFrame && _awakeBrickPts.length > 0 && !mobileImpactBudgetMode) {
        const RXZ = _WAKE_PROP_RXZ;
        // Bridge spans are fragile: allow undermined bricks to fall, but cap
        // the propagation budget much lower so a single moving brick can't
        // cascade-wake the whole deck.
        const isBridgeActive = bridgeStageActive;
        const propBudget = isBridgeActive ? Math.min(6, wakePropBudget) : wakePropBudget;
        let woken = 0;
        for (const b of frameActiveBricks) {
            if (b.body.sleepState === 0) continue;   // already awake
            const bp = b.body.position;
            const wakeWaterY = getWaterSurfaceYAtXZ(bp.x, bp.z);
            if (wakeWaterY != null && bp.y <= wakeWaterY + 0.45) continue;
            for (let i = 0; i < _awakeBrickPts.length; i += 4) {
                // Only a brick from the SAME structure can be undermined by this
                // moving brick — wall debris must not knock the decoupled towers down.
                if (_awakeBrickPts[i + 3] !== b.grp) continue;
                // Bridge propagation: only bridge bricks can undermine bridge
                // bricks, and we keep the budget tiny.
                if (isBridgeActive && b.storyRole !== 'bridge') continue;
                // Must sit ABOVE the moving brick (its support was below it).
                const dy = bp.y - _awakeBrickPts[i + 1];
                if (dy < _WAKE_PROP_DY_MIN || dy > _WAKE_PROP_DY_MAX) continue;
                const dx = bp.x - _awakeBrickPts[i];
                if (dx > RXZ || dx < -RXZ) continue;
                const dz = bp.z - _awakeBrickPts[i + 2];
                if (dz > RXZ || dz < -RXZ) continue;
                b.body.wakeUp();
                woken++;
                break;
            }
            if (woken >= propBudget) break;   // bound worst-case work
        }
    }

    const nowMs = performance.now();
    for (let i = cannonballs.length - 1; i >= 0; i--) {
        const cb = cannonballs[i];
        const p = cb.body.position;
        // Hard cull runaway/expired rounds to avoid lingering physics cost.
        if ((cb.expiresAt && nowMs >= cb.expiresAt)
            || p.y < -8
            || Math.abs(p.x) > 500
            || Math.abs(p.z) > 500
            || (MOBILE_SHOT_STABILITY_FIX && isMobileProfile && cb.weaponType === WEAPON_IDX_CANNON
                && cb.body && cb.body._mobileCullAt && nowMs >= cb.body._mobileCullAt)
            || (!isMobileProfile && cb.weaponType === WEAPON_IDX_CANNON && (cb._restingMs || 0) >= 1800)
            || (isMobileProfile && (cb._restingMs || 0) >= 380)) {
            removeCannonballEntry(cb);
            continue;
        }
        cb.mesh.position.copy(p);
        cb.mesh.quaternion.copy(cb.body.quaternion);

        const prevPos = cb._prevWaterPos || null;
        const cbWaterY = getWaterSurfaceYAtXZ(p.x, p.z);
        const cbInWater = cbWaterY != null && p.y <= cbWaterY + 0.30;
        let crossedWaterSurface = false;
        let splashX = p.x;
        let splashZ = p.z;
        let splashY = cbWaterY;
        if (prevPos) {
            const prevWaterY = getWaterSurfaceYAtXZ(prevPos.x, prevPos.z);
            if (prevWaterY != null && cbWaterY != null) {
                const prevDy = prevPos.y - (prevWaterY + 0.02);
                const currDy = p.y - (cbWaterY + 0.02);
                if (prevDy > 0 && currDy <= 0) {
                    const denom = prevDy - currDy;
                    const t = denom > 1e-5 ? THREE.MathUtils.clamp(prevDy / denom, 0, 1) : 0;
                    splashX = THREE.MathUtils.lerp(prevPos.x, p.x, t);
                    splashZ = THREE.MathUtils.lerp(prevPos.z, p.z, t);
                    const crossWaterY = getWaterVisualSurfaceYAtXZ(splashX, splashZ) ?? getWaterSurfaceYAtXZ(splashX, splashZ);
                    splashY = crossWaterY != null ? crossWaterY : cbWaterY;
                    crossedWaterSurface = true;
                }
            }
        }

        if ((cbInWater && !cb._waterSubmergedPrev) || crossedWaterSurface) {
            const splashSpeed = cb.body.velocity.length();
            const rippleRole = getRippleRoleAtXZ(splashX, splashZ);
            const splashVisualY = getWaterVisualSurfaceYAtXZ(splashX, splashZ) ?? splashY;
            const splashBase = Math.max(9.5, splashSpeed * 2.2);
            // Cannonballs are heavy impacts; emit a primary ring plus a short
            // delayed secondary ring so water-entry hits read clearly.
            spawnWaterImpactRipple(splashX, splashZ, splashVisualY, splashBase, rippleRole);
            spawnWaterImpactRipple(
                splashX + (Math.random() - 0.5) * 0.25,
                splashZ + (Math.random() - 0.5) * 0.25,
                splashVisualY,
                splashBase * 0.82,
                rippleRole
            );
            spawnWaterImpactRipple(
                splashX + (Math.random() - 0.5) * 0.35,
                splashZ + (Math.random() - 0.5) * 0.35,
                splashVisualY,
                splashBase * 0.64,
                rippleRole
            );
        }
        cb._waterSubmergedPrev = cbInWater;
        cb._prevWaterPos = { x: p.x, y: p.y, z: p.z };
    }

    // FPV Drone post-physics: sync mesh + camera from kinematic body position
    if (activeDrone && !activeDrone.detonated) {
        const d = activeDrone;
        const bp = d.body.position;

        if (bp.y < 0.4 || bp.y < -12 || Math.abs(bp.x) > 500 || Math.abs(bp.z) > 500) {
            // Hit ground or left the world
            detonateDrone();
        } else {
            // Belt-and-suspenders: explicit brick/plank AABB overlap check.
            // Catches the case where the drone slides parallel to a surface
            // (contact normal ? velocity ? physics event fires but impact = 0)
            // or where the physics event fires late due to sleep state.
            if (!activeDrone.detonated) {
                const dpx = bp.x, dpy = bp.y, dpz = bp.z;
                const HX = 1.22, HY = 0.82, HZ = 1.22; // brick half-extents + drone radius
                for (const b of bricks) {
                    if (!b.body) continue;
                    const pp = b.body.position;
                    if (Math.abs(dpx - pp.x) < HX &&
                        Math.abs(dpy - pp.y) < HY &&
                        Math.abs(dpz - pp.z) < HZ) { detonateDrone(); break; }
                }
            }
            if (activeDrone && !activeDrone.detonated) {
                const dpx = bp.x, dpy = bp.y, dpz = bp.z;
                const PHX = 0.72, PHY = 0.72, PHZ = 0.72;
                for (const p of planks) {
                    if (!p.body) continue;
                    const pp = p.body.position;
                    if (Math.abs(dpx - pp.x) < PHX &&
                        Math.abs(dpy - pp.y) < PHY &&
                        Math.abs(dpz - pp.z) < PHZ) { detonateDrone(); break; }
                }
            }
            if (!activeDrone) return; // detonated by proximity check above
            // Sync velocity state from body (cannon may clamp/correct it)
            droneVx = d.body.velocity.x;
            droneVy = d.body.velocity.y;
            droneVz = d.body.velocity.z;

            // Spin all four propellers visually
            d.propFL.rotation.y += DRONE_PROP_SPIN * dt;
            d.propFR.rotation.y -= DRONE_PROP_SPIN * dt;
            if (d.propRL) d.propRL.rotation.y -= DRONE_PROP_SPIN * dt;
            if (d.propRR) d.propRR.rotation.y += DRONE_PROP_SPIN * dt;

            // Update motor audio pitch based on 3D speed
            if (d._motor && soundEnabled) {
                const spd = Math.sqrt(droneVx*droneVx + droneVy*droneVy + droneVz*droneVz);
                const motorCtx = getAudio();
                const mNow = motorCtx.currentTime;
                d._motor.amOsc.frequency.setTargetAtTime(78 + spd * 1.8, mNow, 0.15);
                // Volume: wide dynamic range so acceleration is clearly audible.
                // Quadratic curve makes the difference between hover and full throttle dramatic.
                // Extra boost from active ascend input and pitch tilt (forward thrust).
                const thrustBoost = (droneAscend ? 0.25 : 0) + Math.min(0.20, Math.abs(dronePitch) * 0.45);
                const vol = Math.min(1.1, 0.60 + Math.pow(Math.min(spd / 18, 1), 1.3) * 0.50 + thrustBoost);
                d._motor.masterGain.gain.setTargetAtTime(vol, mNow, 0.07);
            }

            // Update drone group position + rotation
            // Negate pitch for rotation: Three.js rotation.x > 0 = nose UP,
            // but dronePitch > 0 means nose-DOWN intent, so flip the sign.
            d.group.position.set(bp.x, bp.y, bp.z);
            d.group.rotation.set(-dronePitch, droneYaw, droneRoll, 'YXZ');

            // Position FPV camera at drone nose, matching drone heading
            const euler = new THREE.Euler(-dronePitch, droneYaw, 0, 'YXZ');
            const noseOffset = new THREE.Vector3(0, 0.04, -0.18).applyEuler(euler);
            droneCamera.position.set(bp.x + noseOffset.x, bp.y + noseOffset.y, bp.z + noseOffset.z);
            // Camera look = drone orientation + separate mouse camera-look pitch
            droneCamera.rotation.set(-dronePitch + droneCamPitch, droneYaw, droneRoll, 'YXZ');

            // HUD readouts
            const spd = Math.sqrt(droneVx*droneVx + droneVy*droneVy + droneVz*droneVz).toFixed(1);
            if (droneFpvAltEl)   droneFpvAltEl.textContent   = `ALT: ${bp.y.toFixed(1)}m`;
            if (droneFpvSpeedEl) droneFpvSpeedEl.textContent = `SPD: ${spd}`;
        }
    }

    // Update ball-cam: sit just behind & slightly above the last fired ball,
    // pointing in the direction of travel.
    if (lastFiredBall && cannonballs.includes(lastFiredBall)) {
        const bv = lastFiredBall.body.velocity;
        const bp = lastFiredBall.body.position;
        const spd = Math.sqrt(bv.x*bv.x + bv.y*bv.y + bv.z*bv.z);
        if (spd > 0.5) {
            _ballCamDir.set(bv.x/spd, bv.y/spd, bv.z/spd);
        }
        // Position: 1.2 m behind the ball, 0.3 m above
        ballCamera.position.set(
            bp.x - _ballCamDir.x * 1.2,
            bp.y - _ballCamDir.y * 1.2 + 0.3,
            bp.z - _ballCamDir.z * 1.2
        );
        ballCamera.lookAt(bp.x, bp.y, bp.z);
    }

    // Arrow flight (ballistic with gravity)
    for (let i = arrows.length - 1; i >= 0; i--) {
        const a = arrows[i];
        a.life -= dt;
        if (a.life <= 0 || a.mesh.position.y < -1) {
            scene.remove(a.mesh); arrows.splice(i, 1); continue;
        }
        a.vy -= 9.81 * dt;
        a.mesh.position.x += a.vx * dt;
        a.mesh.position.y += a.vy * dt;
        a.mesh.position.z += a.vz * dt;
        _arrowVel.set(a.vx, a.vy, a.vz);
        if (_arrowVel.lengthSq() > 0.01) {
            a.mesh.quaternion.setFromUnitVectors(_arrowFwd, _arrowVel.normalize());
        }
        // Hit-check against camera (player/cannon) � 1.0 m radius sphere
        const adx = a.mesh.position.x - camera.position.x;
        const ady = a.mesh.position.y - camera.position.y;
        const adz = a.mesh.position.z - camera.position.z;
        if (adx*adx + ady*ady + adz*adz < 1.0) {
            scene.remove(a.mesh); arrows.splice(i, 1);
            onPlayerHit();
            continue;
        }
        // Hit-check against active FPV drone � arrows can strike and crash it
        if (activeDrone && !activeDrone.detonated && !activeDrone._crashing) {
            const dp = activeDrone.body.position;
            const ddx = a.mesh.position.x - dp.x;
            const ddy = a.mesh.position.y - dp.y;
            const ddz = a.mesh.position.z - dp.z;
            if (ddx*ddx + ddy*ddy + ddz*ddz < 0.64) {
                scene.remove(a.mesh); arrows.splice(i, 1);
                playArrowHitSound();
                addShake(0.65);
                activeDrone._crashing = true;
                droneVx += (Math.random() - 0.5) * 18;
                droneVy  = -5 - Math.random() * 5;
                droneVz += (Math.random() - 0.5) * 18;
                setTimeout(detonateDrone, 900 + Math.random() * 700);
                continue;
            }
        }
    }

    // Ballista bolt flight (heavier and slightly faster than arrows)
    for (let i = ballistaBolts.length - 1; i >= 0; i--) {
        const b = ballistaBolts[i];
        b.life -= dt;
        if (b.life <= 0 || b.mesh.position.y < -2) {
            scene.remove(b.mesh); ballistaBolts.splice(i, 1); continue;
        }
        b.vy -= 9.81 * dt;
        b.mesh.position.x += b.vx * dt;
        b.mesh.position.y += b.vy * dt;
        b.mesh.position.z += b.vz * dt;
        _arrowVel.set(b.vx, b.vy, b.vz);
        if (_arrowVel.lengthSq() > 0.01) {
            b.mesh.quaternion.setFromUnitVectors(_arrowFwd, _arrowVel.normalize());
        }
        const dx = b.mesh.position.x - camera.position.x;
        const dy = b.mesh.position.y - camera.position.y;
        const dz = b.mesh.position.z - camera.position.z;
        const hr = b.hitRadius || 1.8;
        if (dx * dx + dy * dy + dz * dz < hr * hr) {
            scene.remove(b.mesh); ballistaBolts.splice(i, 1);
            onPlayerHit();
            continue;
        }
    }

    // Sync ragdoll NPC part meshes to their physics bodies
    const ragdollNowMs = performance.now();
    for (const npc of npcList) {
        if (!npc.isRagdoll) continue;
        let shouldCullRagdoll = !!(npc.ragdollExpireAt && ragdollNowMs >= npc.ragdollExpireAt);
        let hasAwakeRagdollBody = false;
        for (const p of npc.ragdollParts) {
            if (!p.mesh) continue;  // constraint-only entry ? no mesh to sync
            if (p.body && p.body.position.y < -12) {
                shouldCullRagdoll = true;
            }
            if (p.body && p.body.sleepState === 0) {
                hasAwakeRagdollBody = true;
            }
            if (p.body) {
                const av = p.body.angularVelocity;
                const av2 = av.x * av.x + av.y * av.y + av.z * av.z;
                if (av2 > RAGDOLL_MAX_SPIN2) {
                    const s = RAGDOLL_MAX_SPIN / Math.sqrt(av2);
                    av.x *= s;
                    av.y *= s;
                    av.z *= s;
                }

                const vv = p.body.velocity;
                const vv2 = vv.x * vv.x + vv.y * vv.y + vv.z * vv.z;
                if (vv2 > RAGDOLL_MAX_SPEED2) {
                    const s = RAGDOLL_MAX_SPEED / Math.sqrt(vv2);
                    vv.x *= s;
                    vv.y *= s;
                    vv.z *= s;
                }
            }
            const ragdollWaterY = p.body ? getWaterSurfaceYAtXZ(p.body.position.x, p.body.position.z) : null;
            if (p.body && ragdollWaterY != null && p.body.position.y <= ragdollWaterY + 1.5) {
                if (!p._waterSubmergedPrev) {
                    const impactSpeed = p.body.velocity.length();
                    const ragdollRippleY = getWaterVisualSurfaceYAtXZ(p.body.position.x, p.body.position.z) ?? ragdollWaterY;
                    spawnWaterImpactRipple(
                        p.body.position.x,
                        p.body.position.z,
                        ragdollRippleY,
                        Math.max(2.2, impactSpeed),
                        getRippleRoleAtXZ(p.body.position.x, p.body.position.z)
                    );
                }
                p._waterSubmergedPrev = true;

                if (!npc.ragdollWaterState) {
                    const cx = (M_OX1 + M_OX2) * 0.5;
                    const cz = (M_OZ1 + M_OZ2) * 0.5;
                    let dx = p.body.position.x - cx;
                    let dz = p.body.position.z - cz;
                    let dl = Math.hypot(dx, dz);
                    if (dl < 0.001) {
                        const a = Math.random() * Math.PI * 2;
                        dx = Math.cos(a);
                        dz = Math.sin(a);
                        dl = 1;
                    }
                    npc.ragdollWaterState = {
                        enteredAt: ragdollNowMs,
                        driftX: dx / dl,
                        driftZ: dz / dl,
                        sinkSpeed: 0.55 + Math.random() * 0.35,
                        waterY: ragdollWaterY,
                        // Visual surface is higher than physics water Y; float bodies here
                        // so they are actually visible at the waterline, not submerged.
                        visualWaterY: getWaterVisualSurfaceYAtXZ(p.body.position.x, p.body.position.z) ?? ragdollWaterY,
                    };
                }

                // Water deaths: half-float + frantic flail/struggle, then sink out.
                const ws = npc.ragdollWaterState;
                const tMs = ragdollNowMs - ws.enteredAt;
                const floatPhase = tMs < RAGDOLL_FLOAT_MS;
                const waterY = ws.waterY ?? ragdollWaterY;
                const visualY = ws.visualWaterY ?? waterY;
                // Entry plunge window: let them sink under first so the trench
                // floor collider brakes them, THEN buoyancy floats them back up.
                const RAGDOLL_PLUNGE_MS = 700;
                const plunging = tMs < RAGDOLL_PLUNGE_MS;
                // Half-float target: upper body pokes out while they wave arms.
                const surfaceY = visualY - 0.05 + Math.sin((tMs * 0.006) + (p.body.id || 0)) * 0.05;
                const targetY = floatPhase
                    ? surfaceY
                    : (waterY - 0.12 - ((tMs - RAGDOLL_FLOAT_MS) / 1000) * ws.sinkSpeed);

                p.body.wakeUp();

                if (floatPhase) {
                    if (plunging) {
                        // PLUNGE: dip UNDER the surface. A spring toward a fixed
                        // depth (not the trench floor) arrests the entry momentum
                        // reliably, so they always resurface regardless of how
                        // hard they were flung in.
                        p.body.linearDamping = 0.40;
                        p.body.angularDamping = 0.20;
                        const dipTarget = surfaceY - 0.8;   // ~0.8 m under water
                        const dy = dipTarget - p.body.position.y;
                        p.body.velocity.y += dy * dt * 6.0;
                        p.body.velocity.y *= (1 - dt * 1.5);
                        p.body.velocity.y = THREE.MathUtils.clamp(p.body.velocity.y, -5.0, 2.0);
                    } else {
                        // FLOAT: strong buoyant spring lifts the body back up so it
                        // clearly rides at/above the waterline (bodies lie on their
                        // side, so aim well above the surface to stay visible);
                        // loose damping lets the limbs thrash.
                        p.body.linearDamping = 0.16;
                        p.body.angularDamping = 0.10;
                        const dy = (surfaceY + 0.5) - p.body.position.y;   // ride well above water for clear visibility
                        p.body.velocity.y += dy * dt * 12.0;       // buoyant lift
                        p.body.velocity.y *= (1 - dt * 2.0);
                        p.body.velocity.y = THREE.MathUtils.clamp(p.body.velocity.y, -2.5, 4.5);
                    }

                    // Water resistance on horizontal motion so incoming momentum
                    // bleeds off into a slow outward drift instead of sliding away.
                    p.body.velocity.x = THREE.MathUtils.lerp(p.body.velocity.x, ws.driftX * 0.5, Math.min(1, dt * 2.4));
                    p.body.velocity.z = THREE.MathUtils.lerp(p.body.velocity.z, ws.driftZ * 0.5, Math.min(1, dt * 2.4));

                    // Frantic per-part flailing: strong windmill torque + splashy
                    // kicks. Each part uses its own frequency so the whole figure
                    // thrashes chaotically rather than rotating as one rigid lump.
                    const id = p.body.id || 0;
                    const fq = 0.012 + (id % 5) * 0.004;
                    const fp = id * 0.73;
                    const flailX = Math.sin(tMs * fq + fp);
                    const flailZ = Math.cos(tMs * (fq * 0.9) + fp + 1.1);
                    p.body.angularVelocity.x += flailX * dt * 15.0;
                    p.body.angularVelocity.z += flailZ * dt * 13.0;
                    p.body.angularVelocity.y += Math.sin(tMs * fq * 0.6 + fp) * dt * 9.0;
                    // Only add splashy upward kicks once floating (not during plunge).
                    if (!plunging) {
                        p.body.velocity.y += Math.max(0, flailX) * dt * 2.4;   // upstroke splash
                    }
                    p.body.velocity.x += Math.cos(tMs * fq * 1.3 + fp) * dt * 2.0;
                    p.body.velocity.z += Math.sin(tMs * fq * 1.1 + fp + 0.6) * dt * 2.0;
                } else {
                    // Sinking phase: steady damped pull downward and outward.
                    p.body.linearDamping = 0.76;
                    p.body.angularDamping = 0.82;
                    const blend = Math.min(1, dt * 2.4);
                    p.body.velocity.x = THREE.MathUtils.lerp(p.body.velocity.x, ws.driftX, blend);
                    p.body.velocity.z = THREE.MathUtils.lerp(p.body.velocity.z, ws.driftZ, blend);
                    p.body.velocity.y = THREE.MathUtils.lerp(
                        p.body.velocity.y,
                        THREE.MathUtils.clamp((targetY - p.body.position.y) * 2.4, -1.2, 0.3),
                        blend
                    );
                }

                if (tMs > (RAGDOLL_FLOAT_MS + RAGDOLL_SINK_MAX_MS)) {
                    shouldCullRagdoll = true;
                }
            } else if (p.body) {
                p._waterSubmergedPrev = false;
            }
            p.mesh.position.copy(p.body.position);
            p.mesh.quaternion.copy(p.body.quaternion);
        }
        if (!shouldCullRagdoll
            && !hasAwakeRagdollBody
            && npc.ragdollSpawnAt
            && ragdollNowMs - npc.ragdollSpawnAt >= RAGDOLL_SLEEP_CULL_MS) {
            shouldCullRagdoll = true;
        }
        if (shouldCullRagdoll) cleanupNpcRagdoll(npc);
    }

    if (_perfDebugEnabled) {
        const bridgeAiStart = performance.now();
        updateStoryBridgeConvoy(dt);
        perfDebugMarkBridgeAi(performance.now() - bridgeAiStart);
    } else {
        updateStoryBridgeConvoy(dt);
    }

    // Animate drawbridge lowering only when castle stage is active.
    if (!storyCastleSuppressed && dbOpening && dbAngle > 0) {
        const prevDbAngle = dbAngle;
        dbAngle = Math.max(0, dbAngle - DB_SPEED * dt);
        dbPivot.rotation.x = dbAngle;
        syncDrawbridgePhysics();
        _drawbridgeCreakCooldown = Math.max(0, _drawbridgeCreakCooldown - dt);
        const angleDelta = Math.max(0, prevDbAngle - dbAngle);
        if (angleDelta > 1e-5 && _drawbridgeCreakCooldown <= 0) {
            const openT = 1 - dbAngle / (Math.PI / 2); // 0->1 while lowering
            const tension = 0.25 + 0.75 * Math.sin(openT * Math.PI);
            const speedNorm = Math.pow(Math.max(0, Math.min(1, openT)), 0.75);
            playDrawbridgeCreak(0.42 + tension * 0.58, speedNorm);
            _drawbridgeCreakCooldown = Math.max(0.055, 0.30 - speedNorm * 0.22) + Math.random() * 0.045;
        }
        if (dbAngle <= 0) {
            // Bridge fully down � courtyard NPCs march out through gate, fanning out
            for (const npc of npcList) {
                if (!npc.isRagdoll && !npc.isTowerGuard && !npc.walking && !npc.storyDormant && !npc.storyBridgeWalker && !npc.isBunkerKing) {
                    npc.walking   = true;
                    npc.clearedBridge = false;
                    npc.bridgeTurnLock = false;
                    // Hut knight uses its own door-exit path (see aggro trigger).
                    if (npc.isHutCharger) {
                        npc.walkDelay = 0;
                        npc.speedMul = Math.max(2.2, npc.speedMul || 0);
                        npc.chaseOffsetX = 0;
                        npc.waypoints = npc.doorPath ? npc.doorPath.slice() : [];
                        npc.attackCommit = 1.2;
                        npc.launchRushTimer = Math.max(1.4, npc.launchRushTimer || 0);
                        continue;
                    }
                    if (npc.isInHut) { npc.waypoints = npc.doorPath.slice(); continue; }
                    const scatter = (Math.random() - 0.5) * 6;
                    const bridgeLane = THREE.MathUtils.clamp(scatter * 0.22, -1.5, 1.5);
                    npc.bridgeLaneX = bridgeLane;
                    npc.waypoints = [
                        { x: scatter * 0.3, z: CFZ + 2 },
                        { x: bridgeLane,    z: M_IZ1 - 0.8 },
                        { x: bridgeLane,    z: M_OZ1 - 1.4 },
                        { x: scatter,       z: M_OZ1 - 2.2 },
                    ];
                }
            }
        }
    }

    // Drawbridge chains follow the bridge with rope physics (sag + swing).
    // On mobile once the bridge is fully lowered, update at a reduced cadence
    // to avoid a deterministic post-drop CPU spike.
    if (!storyCastleSuppressed && isMobileProfile && dbAngle <= 0.001) {
        const hasLooseChain = chains.some(ch => !ch.topPinned || !ch.tipPinned);
        if (hasLooseChain) {
            // Keep decent fidelity when a chain is detached and actively falling.
            if (_frameCount % 4 === 0) updateChains(dt * 4);
        } else {
            // Once fully lowered with both anchors intact, chains are almost static.
            // A much slower cadence avoids iPhone post-drop frame collapse.
            if (_frameCount % 24 === 0) updateChains(dt * 24);
        }
    } else if (!storyCastleSuppressed) {
        updateChains(dt);
    }

    // Safety net: if Knight+ encounter object was lost for any reason, rebuild it.
    // Do not rebuild in editor mode � the ballista should not appear in the template sandbox.
    if (!guardsDisabled && !ballista && _gameStarted && currentDifficulty !== 'squire' && !window.__editorMode && !window.__editorActive) {
        setupBallistaEncounter();
    }

    // Knight+ siege unit behavior.
    updateBallistaEncounter(dt);
    updateStoryProgression();
    updateKingsBunker(dt);

    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        if (p.life <= 0) { scene.remove(p.mesh); p.mat.dispose(); particles.splice(i, 1); continue; }
        p.vy -= 9.81 * dt;
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
        p.mesh.rotation.x += p.sx * dt;
        p.mesh.rotation.y += p.sy * dt;
        p.mesh.rotation.z += p.sz * dt;
        if (p.mesh.position.y < 0.04) {
            p.mesh.position.y = 0.04;
            p.vy = Math.abs(p.vy) * 0.35;
            p.vx *= 0.65; p.vz *= 0.65;
        }
        p.mat.opacity = p.life / p.maxLife;
    }

    // Drift clouds
    const cloudT = performance.now() * 0.001;
    updateSeasonWeather(dt);   // precipitation + storm lightning
    for (const c of clouds) {
        const d = c.group.userData;
        c.group.position.x -= c.speed * (d.driftMul || 1) * dt;
        c.group.position.y = d.baseY + Math.sin(cloudT * d.bobSpeed + d.phase) * d.bobAmp;
        c.group.rotation.y += d.rollSpeed * dt;
        if (c.group.position.x < -420) {
            c.group.position.x = 420;
            c.group.position.z = 68 + Math.random() * 240;
            d.baseY = 66 + Math.random() * 40;
        }
    }

    const waterAnimStart = _perfDebugEnabled ? performance.now() : 0;
    if (WATER_SYSTEM_ENABLED && devWaterFxEnabled
        && (levelWaterPlanes.length || bridgeLibraryWaterSurfaces.length)) {
        // Scroll water UVs (three counter-moving normal layers).
        const waterDt = dt * WATER_MOTION_RATE;
        const waterT = performance.now() * 0.001 * WATER_MOTION_RATE;
        waterMouseRipple = Math.max(0, waterMouseRipple - dt * 1.7);
        if (waterTex) {
            waterTex.offset.x  = (waterTex.offset.x + 0.018 * waterDt) % 1;
            waterTex.offset.y  = (waterTex.offset.y + 0.006 * waterDt) % 1;
            waterTex.needsUpdate = true;
        }
        if (waterReflectTex) {
            waterReflectTex.offset.x = (waterReflectTex.offset.x + 0.008 * waterDt) % 1;
            waterReflectTex.offset.y = (waterReflectTex.offset.y - 0.004 * waterDt + 1) % 1;
        }
        if (waterNormalA?.offset) {
            waterNormalA.offset.x = (waterNormalA.offset.x + 0.013 * waterDt) % 1;
            waterNormalA.offset.y = (waterNormalA.offset.y + 0.009 * waterDt) % 1;
        }

        const swell = 0.5 + 0.5 * Math.sin(waterT * 0.55);
        const normalA = 0.18 + swell * 0.018;
        if (rippleMat?.normalScale) rippleMat.normalScale.set(normalA, normalA);
        if (waterUnderlayMat) waterUnderlayMat.opacity = waterFxOpacity;

        for (const wp of levelWaterPlanes) {
            if (!wp || !wp.ripple) continue;
            if (!(wp.ripple.visible || (wp.underlay && wp.underlay.visible))) {
                continue;
            }
            const phase = wp.phase || 0;
            const amp = wp.waveAmp || 0.04;
            const speed = wp.waveSpeed || 1.1;
            const bob = Math.sin(waterT * speed + phase) * (amp * 0.14);
            const waterShaderUniforms = wp.underlay?.userData?.waterShader?.uniforms;
            if (waterShaderUniforms?.uWaterTime) {
                waterShaderUniforms.uWaterTime.value = waterT * speed + phase;
            }
            if (waterShaderUniforms?.uWaterDistort) {
                waterShaderUniforms.uWaterDistort.value = (wp.levelRole === 'bridge')
                    ? (0.00035 + amp * 0.0035)
                    : (0.0008 + amp * 0.010);
            }
            if (wp.underlay) wp.underlay.position.y = (wp.baseY ?? WATER_Y) + 0.006 + bob * 0.75;
            wp.ripple.position.y = (wp.baseY ?? WATER_Y) + 0.020 + bob;
        }

        for (const wm of bridgeLibraryWaterSurfaces) {
            if (!wm || !wm.visible) continue;
            const uniforms = wm.material?.uniforms;
            if (uniforms?.time) uniforms.time.value += dt * WATER_LIBRARY_WAVE_SPEED;
        }

        updateLiveWaterSceneryReflection();
        updateWaterImpactRipples(dt);
        if (_perfDebugEnabled) perfDebugMarkWater(performance.now() - waterAnimStart);
    } else if (_perfDebugEnabled) {
        perfDebugMarkWater(0);
    }

    // Render pass. Shadow map is refreshed once per frame (autoUpdate is off).
    renderer.shadowMap.needsUpdate = true;

    if (twoPlayerMode) {
        // Left half: P1
    // Cannon hit flash: tint active viewmodel red for cannonHitFlash seconds
    if (cannonHitFlash > 0) {
        cannonHitFlash -= dt;
        const t = Math.max(0, cannonHitFlash) / 0.4;  // 1?0
        const r = 0.4 + 0.6 * (1 - t), gb = 0.05 + 0.15 * (1 - t);
        vmBarrelMat.color.setRGB(r, gb, gb);
        vmBarrelMat.emissive.setRGB(0.5 * t, 0, 0);
        vmMortarMat.color.setRGB(r, gb, gb);
        vmMortarMat.emissive.setRGB(0.5 * t, 0, 0);
    } else {
        vmBarrelMat.color.setRGB(1, 1, 1);
        vmBarrelMat.emissive.setRGB(0, 0, 0);
        vmMortarMat.color.setRGB(1, 1, 1);
        vmMortarMat.emissive.setRGB(0, 0, 0);
    }

        const hw = Math.floor(window.innerWidth / 2);
        const h  = window.innerHeight;
        renderer.setScissorTest(true);
        renderer.setScissor(0, 0, hw, h);
        renderer.setViewport(0, 0, hw, h);
        const renderP1Start = _perfDebugEnabled ? performance.now() : 0;
        renderer.render(scene, camera);
        if (_perfDebugEnabled) perfDebugMarkRender(performance.now() - renderP1Start);

        // Right half: P2
        renderer.setScissor(hw, 0, hw, h);
        renderer.setViewport(hw, 0, hw, h);
        const renderP2Start = _perfDebugEnabled ? performance.now() : 0;
        renderer.render(scene, camera2);
        if (_perfDebugEnabled) perfDebugMarkRender(performance.now() - renderP2Start);

        renderer.setScissorTest(false);
        renderer.setScissor(0, 0, window.innerWidth, h);
        renderer.setViewport(0, 0, window.innerWidth, h);
    } else {
        const W = window.innerWidth, H = window.innerHeight;
        const droneActive = !!(activeDrone && !activeDrone.detonated);
        const renderStart = _perfDebugEnabled ? performance.now() : 0;
        // When drone is flying: use drone camera as the primary full-screen render,
        // then overlay a small player-view PIP. This costs the same as a normal
        // single render pass instead of 1.75� with a separate large FPV pass.
        const _activeCam = droneActive ? droneCamera : (window.__editorOverrideCamera || camera);
        renderer.render(scene, _activeCam);
        if (_perfDebugEnabled) perfDebugMarkRender(performance.now() - renderStart);
        if (droneActive) {
            // Player-view PIP: bottom-right corner, ~28% wide � 24% tall
            const pipW = Math.max(2, Math.floor(W * 0.28));
            const pipH = Math.max(2, Math.floor(H * 0.24));
            const pipX = W - pipW - 10;
            const pipY = 10;
            renderer.setScissorTest(true);
            renderer.setScissor(pipX, H - pipY - pipH, pipW, pipH);
            renderer.setViewport(pipX, H - pipY - pipH, pipW, pipH);
            camera.aspect = pipW / pipH;
            camera.updateProjectionMatrix();
            renderer.clearDepth();
            renderer.render(scene, camera);
            camera.aspect = W / H;
            camera.updateProjectionMatrix();
            renderer.setScissorTest(false);
            renderer.setScissor(0, 0, W, H);
            renderer.setViewport(0, 0, W, H);
        }
    }

    // Ball-cam CRT monitor: left-side inset while active and a fired ball exists.
    // Drone detonation: position ball cam to orbit the blast point for a cinematic replay.
    if (droneBlastReplayTimer > 0 && !twoPlayerMode) {
        droneBlastReplayTimer = Math.max(0, droneBlastReplayTimer - dt);
        const elapsed = 3.8 - droneBlastReplayTimer;
        const orbitAngle  = elapsed * 0.75;
        const orbitRadius = 6 + elapsed * 0.6;
        ballCamera.position.set(
            _droneBlastPos.x + Math.cos(orbitAngle) * orbitRadius,
            _droneBlastPos.y + 3.5,
            _droneBlastPos.z + Math.sin(orbitAngle) * orbitRadius
        );
        ballCamera.lookAt(_droneBlastPos.x, _droneBlastPos.y, _droneBlastPos.z);
    }
    const ballCamShouldShow = isMobileProfile
        ? (ballCamActive || mobileBallCamPinned)
        : (ballCamActive || ballCamAuto);
    const ballCamThreatSpeed = isMobileProfile ? 2.6 : 0.9;
    const ballIsThreat = (() => {
        if (!(lastFiredBall && cannonballs.includes(lastFiredBall))) return false;
        const bv = lastFiredBall.body.velocity;
        const spd = Math.sqrt(bv.x * bv.x + bv.y * bv.y + bv.z * bv.z);
        const asleep = (lastFiredBall.body.sleepState || 0) !== 0;
        return !asleep && spd >= ballCamThreatSpeed;
    })();
    const showBallCam = !twoPlayerMode && !isSniperAim &&
        (droneBlastReplayTimer > 0 ||
            (ballCamShouldShow && ballIsThreat &&
             lastFiredBall && cannonballs.includes(lastFiredBall))) &&
        !!ballCamScreenEl;

    setBallCamCrtVisible(showBallCam);
    if (showBallCam) {
        const screenRect = ballCamScreenEl.getBoundingClientRect();
        const W = window.innerWidth;
        const H = window.innerHeight;
        const px = Math.max(0, Math.floor(screenRect.left));
        const py = Math.max(0, Math.floor(screenRect.top));
        const pw = Math.max(2, Math.floor(screenRect.width));
        const ph = Math.max(2, Math.floor(screenRect.height));
        const glY = H - py - ph;

        renderer.setScissorTest(true);
        renderer.setScissor(px, glY, pw, ph);
        renderer.setViewport(px, glY, pw, ph);
        ballCamera.aspect = pw / ph;
        ballCamera.updateProjectionMatrix();
        // The inset re-renders the whole scene, and every visible library
        // Water surface re-renders a planar REFLECTION of the scene inside
        // each render call � so one ball in flight could triple scene cost
        // (the "one shot tank", even on misses). Strip tufts + library water
        // from the inset; its murky caps/underlay still read as water on the
        // small CRT.
        const hideTuftsForInset = !DEV_HIDE_ALL_GRASS && !!grassTuftsMesh && grassTuftsMesh.visible;
        if (hideTuftsForInset) grassTuftsMesh.visible = false;
        _insetHiddenMeshes.length = 0;
        for (const wm of bridgeLibraryWaterSurfaces) {
            if (wm && wm.visible) { wm.visible = false; _insetHiddenMeshes.push(wm); }
        }
        renderer.clearDepth();
        const insetRenderStart = _perfDebugEnabled ? performance.now() : 0;
        renderer.render(scene, ballCamera);
        if (_perfDebugEnabled) perfDebugMarkRender(performance.now() - insetRenderStart);
        if (hideTuftsForInset) grassTuftsMesh.visible = true;
        for (const wm of _insetHiddenMeshes) wm.visible = true;
        _insetHiddenMeshes.length = 0;
        renderer.setScissorTest(false);
        renderer.setScissor(0, 0, W, H);
        renderer.setViewport(0, 0, W, H);
    }

    // FPV Drone: render drone POV into the large top-3/4 overlay
    // FPV Drone: show/hide HUD overlay (rendering now handled in the main render block above)
    const showDroneFpv = !twoPlayerMode && !!activeDrone && !activeDrone.detonated;
    if (droneFpvOverlayEl) droneFpvOverlayEl.style.display = showDroneFpv ? 'block' : 'none';

    if (_perfDebugEnabled) {
        perfDebugMarkFrame(rawDt, awakeBricksThisFrame, shouldRunSupportScan);
    }
}

animate();











