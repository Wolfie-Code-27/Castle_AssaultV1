import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import * as CANNON from "cannon-es";

// === Renderer ===
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

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
skyUniforms["turbidity"].value      = 4;
skyUniforms["rayleigh"].value       = 1.2;
skyUniforms["mieCoefficient"].value = 0.006;
skyUniforms["mieDirectionalG"].value = 0.82;
const sunDir = new THREE.Vector3();
const phi   = THREE.MathUtils.degToRad(78);   // altitude (lower = more orange)
const theta = THREE.MathUtils.degToRad(200);  // azimuth
sunDir.setFromSphericalCoords(1, phi, theta);
skyUniforms["sunPosition"].value.copy(sunDir);
// Align directional light with the sky sun
scene.fog = new THREE.FogExp2(0x9ec8f0, 0.0055);

// === Clouds ===
const cloudMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, transparent: true, opacity: 0.90, depthWrite: false
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
        m.scale.y = 0.42;
        m.position.set(px * scale, py * scale, pz * scale);
        g.add(m);
    }
    g.position.set(x, y, z);
    scene.add(g);
    return g;
}

const clouds = [
    { group: createCloud(-100, 80, 120, 1.2), speed: 1.4 },
    { group: createCloud(  30, 90, 180, 1.5), speed: 0.9 },
    { group: createCloud( -40, 75,  80, 1.0), speed: 1.7 },
    { group: createCloud( 130, 85, 150, 1.3), speed: 1.1 },
    { group: createCloud(-180, 70, 110, 0.9), speed: 1.5 },
    { group: createCloud(  70, 95, 220, 1.4), speed: 0.8 },
    { group: createCloud( -80, 82, 170, 1.1), speed: 1.2 },
    { group: createCloud( 200, 78, 100, 1.0), speed: 1.6 },
    { group: createCloud(-250, 88, 200, 1.3), speed: 1.0 },
];

// === First-Person Camera ===
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 2000);
camera.rotation.order = "YXZ";
camera.position.set(0, 2.2, -10);
scene.add(camera);

// Cannon barrel viewmodel — procedural cast-iron texture
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
vmBarrel.position.set(0.22, -0.22, -0.45);
camera.add(vmBarrel);
// Muzzle ring detail
const vmMuzzle = new THREE.Mesh(
    new THREE.TorusGeometry(0.068, 0.016, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.25, metalness: 0.98 })
);
vmMuzzle.position.set(0, 0, -0.95);
vmBarrel.add(vmMuzzle);

// === FPS Aim + Move State ===
let yaw = 0;
let pitch = 0.2;
const PITCH_MIN = -0.15;
const PITCH_MAX = 0.75;
let pointerLocked = false;
const MOVE_SPEED = 8.0;  // m/s
let twoPlayerMode = false;

// === Ball-cam (right-mouse hold) ===
let ballCamActive = false;
let lastFiredBall = null;  // { mesh, body } of the most recently fired cannonball
const ballCamera = new THREE.PerspectiveCamera(80, 16 / 9, 0.05, 300);
ballCamera.rotation.order = 'YXZ';
const _ballCamDir = new THREE.Vector3();
const _ballCamUp  = new THREE.Vector3(0, 1, 0);

window.addEventListener('mousedown', e => { if (e.button === 2) ballCamActive = true; });
window.addEventListener('mouseup',   e => { if (e.button === 2) ballCamActive = false; });
window.addEventListener('contextmenu', e => e.preventDefault());
const keys = { w: false, a: false, s: false, d: false };

window.addEventListener("keydown", e => { if (e.code === "KeyW") keys.w = true; if (e.code === "KeyA") keys.a = true; if (e.code === "KeyS") keys.s = true; if (e.code === "KeyD") keys.d = true; });
window.addEventListener("keyup",   e => { if (e.code === "KeyW") keys.w = false; if (e.code === "KeyA") keys.a = false; if (e.code === "KeyS") keys.s = false; if (e.code === "KeyD") keys.d = false; });

// Overlay click → request pointer lock
document.getElementById("lockMsg").addEventListener("click", () => {
    renderer.domElement.requestPointerLock();
});

// Canvas click while locked → fire (P1 only)
renderer.domElement.addEventListener("click", e => {
    if (e.button !== 0) return;  // left-click only — RMB is ball-cam
    if (pointerLocked && !twoPlayerMode) {
        fireCannonball(parseFloat(document.getElementById("power").value));
    }
});

document.addEventListener("pointerlockchange", () => {
    pointerLocked = document.pointerLockElement === renderer.domElement;
    document.getElementById("lockMsg").style.display = pointerLocked ? "none" : "flex";
});

document.addEventListener("mousemove", e => {
    if (!pointerLocked) return;
    const dx = e.movementX * 0.002;
    const dy = e.movementY * 0.002;
    if (!twoPlayerMode) {
        // 1-player mode — full canvas → P1
        yaw   -= dx;
        pitch -= dy;
        pitch  = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch));
    } else {
        // 2-player split: left half = P1, right half = P2
        // We use raw client coords from mousemove; approximate with clientX
        // (pointer lock zeros absolute position, so we track last cursor side)
        if (_lastMouseX < window.innerWidth / 2) {
            yaw   -= dx;
            pitch -= dy;
            pitch  = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch));
        } else {
            p2Yaw   -= dx;
            p2Pitch -= dy;
            p2Pitch  = Math.max(PITCH_MIN, Math.min(PITCH_MAX, p2Pitch));
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
    const a0 = document.getElementById('p2ammo0');
    const a1 = document.getElementById('p2ammo1');
    const a2 = document.getElementById('p2ammo2');
    if (a0) a0.textContent = p2Ammo[0];
    if (a1) a1.textContent = p2Ammo[1];
    if (a2) a2.textContent = p2Ammo[2];
}

function fireCannonballP2(power) {
    if (gameOver || p2Ammo[currentWeapon] <= 0) return;
    const wep = WEAPONS[currentWeapon];
    p2Ammo[currentWeapon]--;
    p2Shots++; updateP2UI(); checkGameOver();

    const fwd = new THREE.Vector3();
    camera2.getWorldDirection(fwd);
    if (wep.arcLoft > 0) { fwd.y += wep.arcLoft; fwd.normalize(); }

    playCannonFire();

    const fl = new THREE.PointLight(0xffdd88, 55, 22);
    fl.position.copy(camera2.position).addScaledVector(fwd, 2.0);
    scene.add(fl);
    setTimeout(() => scene.remove(fl), 110);

    const ballRadius = currentWeapon === 2 ? 0.52 : BALL_RADIUS;
    const ballMat    = currentWeapon === 0 ? BALL_MAT :
                       new THREE.MeshStandardMaterial({
                           color: WEAPONS[currentWeapon].color,
                           metalness: 0.7, roughness: 0.5,
                           emissive: currentWeapon === 1 ? 0x441100 : 0x221100,
                           emissiveIntensity: 0.6
                       });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(ballRadius, 16, 16), ballMat);
    mesh.castShadow = true;
    scene.add(mesh);

    const body = new CANNON.Body({
        mass: currentWeapon === 2 ? 280 : 180,
        shape: new CANNON.Sphere(ballRadius),
        linearDamping: 0.005
    });
    const start = camera2.position.clone().addScaledVector(fwd, 2.2);
    body.position.set(start.x, start.y, start.z);
    body.velocity.set(fwd.x * power, fwd.y * power, fwd.z * power);
    world.addBody(body);

    const blastR = wep.blastR;
    let p2BallScored = false;
    if (blastR > 0) {
        let detonated = false;
        body.addEventListener('collide', e => {
            if (detonated) return;
            const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
            if (impact < 3) return;
            detonated = true;
            const pos = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
            triggerBlast(pos, blastR);
            if (!p2BallScored) { p2BallScored = true; p2Score += 20; updateP2UI(); }
            setTimeout(() => {
                scene.remove(mesh); world.removeBody(body);
                const idx = cannonballs.findIndex(c => c.body === body);
                if (idx !== -1) cannonballs.splice(idx, 1);
            }, 80);
        });
    } else {
        let lastHit = 0;
        body.addEventListener('collide', e => {
            const now = performance.now();
            if (now - lastHit < 150) return;
            lastHit = now;
            const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
            if (impact > 2) {
                spawnExplosion(new THREE.Vector3(body.position.x, body.position.y, body.position.z));
                playImpact(Math.min(impact / 20, 1));
                const R = 3.0, ix = body.position.x, iy = body.position.y, iz = body.position.z;
                for (const b of bricks) {
                    const dx = b.body.position.x - ix;
                    if (dx > R || dx < -R) continue;
                    const dz = b.body.position.z - iz;
                    if (dz > R || dz < -R) continue;
                    const dy = b.body.position.y - iy;
                    if (dy > R || dy < -R) continue;
                    if (b.body.sleepState !== 0) b.body.wakeUp();
                }
            }
        });
    }

    cannonballs.push({ mesh, body, weaponType: currentWeapon });
    if (cannonballs.length > 8) {
        const old = cannonballs.shift();
        scene.remove(old.mesh);
        world.removeBody(old.body);
    }
}

const twoPlayerBtn = document.getElementById('twoPlayerBtn');
twoPlayerBtn.addEventListener('click', e => {
    e.stopPropagation();
    twoPlayerMode = !twoPlayerMode;
    twoPlayerBtn.textContent = `2-Player Mode: ${twoPlayerMode ? 'ON' : 'OFF'}`;
    document.getElementById('splitLine').style.display  = twoPlayerMode ? 'block' : 'none';
    document.getElementById('scoreboard2').style.display = twoPlayerMode ? 'block' : 'none';
    document.getElementById('p1label').style.display   = twoPlayerMode ? 'block' : 'none';
    document.getElementById('p2label').style.display   = twoPlayerMode ? 'block' : 'none';
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
scene.add(new THREE.AmbientLight(0xd0e8ff, 0.65));

const sun = new THREE.DirectionalLight(0xfff5e0, 2.2);
// Match the visual sun position set in the Sky shader
sun.position.copy(sunDir).multiplyScalar(100);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near   = 1;
sun.shadow.camera.far    = 800;
sun.shadow.camera.left   = -200;
sun.shadow.camera.right  = 200;
sun.shadow.camera.top    = 200;
sun.shadow.camera.bottom = -200;
sun.shadow.bias = -0.001;
scene.add(sun);

// === Physics ===
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -18.0, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = 12;
world.allowSleep = true;
world.defaultContactMaterial.friction    = 0.45;
world.defaultContactMaterial.restitution = 0.03;

// Brick-to-brick contact: zero bounce, energy-absorbing so hits don’t
// chain far through the structure.
const brickPhysMat = new CANNON.Material('brick');
const brickContact = new CANNON.ContactMaterial(brickPhysMat, brickPhysMat, {
    friction:    0.50,
    restitution: 0.0,
    contactEquationStiffness:   5e6,  // softer contact = less impulse transfer
    contactEquationRelaxation:  4,
    frictionEquationStiffness:  5e6,
    frictionEquationRelaxation: 4,
});
world.addContactMaterial(brickContact);

// === Stone Textures (Procedural) ===
function makeStoneColorMap() {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#7a6a5a";
    ctx.fillRect(0, 0, 128, 64);
    for (let i = 0; i < 500; i++) {
        const x = Math.random() * 128;
        const y = Math.random() * 64;
        const r = Math.random() * 6 + 1;
        const v = ((Math.random() * 60) - 30) | 0;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(" + (122+v) + "," + (106+v) + "," + (90+v) + ",0.4)";
        ctx.fill();
    }
    ctx.strokeStyle = "#c8bfb0";
    ctx.lineWidth = 5;
    ctx.strokeRect(2.5, 2.5, 123, 59);
    ctx.strokeStyle = "rgba(30,20,10,0.4)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.moveTo(10 + Math.random() * 50, 5 + Math.random() * 20);
        ctx.lineTo(40 + Math.random() * 50, 25 + Math.random() * 25);
        ctx.stroke();
    }
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
}

function makeStoneBumpMap() {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, 128, 64);
    ctx.fillStyle = "#aaa";
    ctx.fillRect(5, 5, 118, 54);
    for (let i = 0; i < 300; i++) {
        const x = 5 + Math.random() * 118;
        const y = 5 + Math.random() * 54;
        const r = Math.random() * 5 + 0.5;
        const v = (85 + Math.random() * 115) | 0;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(" + v + "," + v + "," + v + ",0.6)";
        ctx.fill();
    }
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
}

const stoneColorMap = makeStoneColorMap();
const stoneBumpMap  = makeStoneBumpMap();

// === Procedural Grass Texture ===
function makeGrassTexture() {
    const W = 512, H = 512;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    // Base green
    ctx.fillStyle = "#3d6b1a";
    ctx.fillRect(0, 0, W, H);

    // Broad colour variation patches
    for (let i = 0; i < 300; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const r = Math.random() * 40 + 10;
        const v = ((Math.random() * 50) - 25) | 0;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.6, Math.random() * Math.PI, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${30+v+20},${100+v+7},${15+v},0.28)`;
        ctx.fill();
    }

    // Individual grass blades
    for (let i = 0; i < 3000; i++) {
        const x  = Math.random() * W;
        const y  = Math.random() * H;
        const len = Math.random() * 14 + 5;
        const g   = (80 + Math.random() * 60) | 0;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (Math.random() - 0.5) * 4, y - len);
        ctx.strokeStyle = `rgba(30,${g},10,0.55)`;
        ctx.lineWidth = Math.random() * 1.2 + 0.3;
        ctx.stroke();
    }

    // Fine noise specks for micro-detail
    for (let i = 0; i < 6000; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const v = ((Math.random() * 40) - 20) | 0;
        ctx.fillStyle = `rgba(${20+v},${80+v},${5+v},0.18)`;
        ctx.fillRect(x, y, 1, 1);
    }

    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(24, 24);
    return t;
}

function makeGrassBump() {
    const W = 256, H = 256;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#555";
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 2000; i++) {
        const x = Math.random() * W, y = Math.random() * H;
        const v = (120 + Math.random() * 135) | 0;
        ctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
        ctx.fillRect(x, y, 1 + (Math.random() * 2 | 0), 3 + (Math.random() * 8 | 0));
    }
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(24, 24);
    return t;
}

// === Ground (split into 5 pieces so the moat channel is visible below) ===
// Moat outer rect: x∈[M_OX1..M_OX2], z∈[M_OZ1..M_OZ2]  (defined just below)
// We can’t reference those consts yet, so use literal coords matching them.
const _MOX1 = -29.0, _MOX2 =  29.0;
const _MOZ1 =  45.0, _MOZ2 = 103.0; // moat outer
const _MIX1 = -22.0, _MIX2 =  22.0;
const _MIZ1 =  54.0, _MIZ2 =  94.0; // island = castle footprint

const grassMat = new THREE.MeshStandardMaterial({
    map:      makeGrassTexture(),
    bumpMap:  makeGrassBump(),
    bumpScale: 0.12,
    roughness: 0.92,
    metalness: 0.0
});

function addGround(cx, cz, w, d) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), grassMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(cx, 0, cz);
    m.receiveShadow = true;
    scene.add(m);
}
// 1. Front strip
addGround(0, (_MOZ1 + (-500)) / 2,  1000,         _MOZ1 + 500);
// 2. Back strip
addGround(0, (_MOZ2 + 500)   / 2,   1000,         500 - _MOZ2);
// 3. Left strip
addGround((_MOX1 + (-500)) / 2, (_MOZ1 + _MOZ2) / 2, _MOX1 + 500, _MOZ2 - _MOZ1);
// 4. Right strip
addGround((_MOX2 + 500)    / 2, (_MOZ1 + _MOZ2) / 2, 500 - _MOX2, _MOZ2 - _MOZ1);
// 5. Castle island (inside moat)
addGround((_MIX1 + _MIX2) / 2, (_MIZ1 + _MIZ2) / 2, _MIX2 - _MIX1, _MIZ2 - _MIZ1);

const groundBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(groundBody);

// === Moat (decorative water ring around the castle) ===
// Castle island occupies x ∈ [-8.5, 7.5], z ∈ [22.5, 43.5].
// The lowered drawbridge tip lands exactly at z=22.5 (inner island edge).
function makeWaterTexture() {
    const W = 256, H = 256;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#005577";
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 60; i++) {
        const y = Math.random() * H;
        const b = (50 + Math.random() * 80) | 0;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(64, y + (Math.random()-0.5)*12, 192, y + (Math.random()-0.5)*12, W, y + (Math.random()-0.5)*8);
        ctx.strokeStyle = `rgba(${b},${b+50},${b+90},0.38)`;
        ctx.lineWidth = Math.random() * 3 + 0.5;
        ctx.stroke();
    }
    // Highlights
    for (let i = 0; i < 30; i++) {
        const x = Math.random()*W, y = Math.random()*H, r = Math.random()*18+4;
        ctx.beginPath(); ctx.ellipse(x, y, r, r*0.35, Math.random()*Math.PI, 0, Math.PI*2);
        ctx.fillStyle = `rgba(120,200,255,0.09)`;  ctx.fill();
    }
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(5, 5);
    return t;
}
// === Moat water — Reflector-based mirrors with ripple overlay ===
// Each strip gets its own Reflector (live mirror) plus a semi-transparent
// ripple plane on top for the animated water surface detail.

// Water ring: 4 rectangular planes around the castle island.
const M_OX1 = -29.0, M_OX2 = 29.0;  // outer X bounds
const M_OZ1 =  45.0, M_OZ2 = 103.0; // outer Z bounds
const M_IX1 = -22.0, M_IX2 =  22.0; // island X bounds
const M_IZ1 =  54.0, M_IZ2 =  94.0; // island Z bounds (flush with castle faces)

const MOAT_DEPTH = 3.6;
const WATER_Y    = -(MOAT_DEPTH * 0.65);

const waterRippleTex = makeWaterTexture();
const waterTex = waterRippleTex;   // alias kept for the scroll animation
const rippleMat = new THREE.MeshStandardMaterial({
    map: waterRippleTex,
    transparent: true, opacity: 0.28,
    roughness: 0.0, metalness: 0.0,
    depthWrite: false,
});

const reflectors = [];
function addWaterPlane(cx, cz, w, d) {
    // Reflector sits at WATER_Y, rotated to face up
    const reflector = new Reflector(new THREE.PlaneGeometry(w, d), {
        clipBias: 0.003,
        textureWidth:  512,
        textureHeight: 512,
        color: 0x226688,
    });
    reflector.rotation.x = -Math.PI / 2;
    reflector.position.set(cx, WATER_Y, cz);
    scene.add(reflector);
    reflectors.push(reflector);

    // Ripple overlay — thin transparent plane just above
    const ripple = new THREE.Mesh(new THREE.PlaneGeometry(w, d), rippleMat);
    ripple.rotation.x = -Math.PI / 2;
    ripple.position.set(cx, WATER_Y + 0.02, cz);
    scene.add(ripple);
}
addWaterPlane((M_OX1+M_OX2)/2, (M_OZ1+M_IZ1)/2, M_OX2-M_OX1, M_IZ1-M_OZ1); // front strip
addWaterPlane((M_OX1+M_OX2)/2, (M_IZ2+M_OZ2)/2, M_OX2-M_OX1, M_OZ2-M_IZ2); // back strip
addWaterPlane((M_OX1+M_IX1)/2, (M_IZ1+M_IZ2)/2, M_IX1-M_OX1, M_IZ2-M_IZ1); // left strip
addWaterPlane((M_IX2+M_OX2)/2, (M_IZ1+M_IZ2)/2, M_OX2-M_IX2, M_IZ2-M_IZ1); // right strip

// Moat bank walls (4 inner + 4 outer stone faces, thin boxes)
const bankMat = new THREE.MeshStandardMaterial({
    map: stoneColorMap, bumpMap: stoneBumpMap, bumpScale: 0.06,
    roughness: 0.9, metalness: 0.0
});
function addBankWall(cx, cy, cz, w, h, d) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bankMat);
    m.position.set(cx, cy, cz); m.receiveShadow = true; m.castShadow = true;
    scene.add(m);
}
// Moat wall height = full depth from water surface to ground
const BANK_H = MOAT_DEPTH;
const BANK_Y = -MOAT_DEPTH / 2;  // centred so top is at y=0, bottom at y=-MOAT_DEPTH
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

// Moat floor (dark mud below the water)
const mudMat = new THREE.MeshStandardMaterial({ color: 0x2a1f0f, roughness: 1.0 });
const moatFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(M_OX2-M_OX1, M_OZ2-M_OZ1),
    mudMat
);
moatFloor.rotation.x = -Math.PI / 2;
moatFloor.position.set((M_OX1+M_OX2)/2, -MOAT_DEPTH, (M_OZ1+M_OZ2)/2);
scene.add(moatFloor);

// === Castle ===
// Brick: 1.0m wide x 0.5m tall x 0.5m deep
const bricks = [];
const BS = { w: 2.0, h: 1.0, d: 1.0 };

// X-aligned brick: long axis along X (used for front/back faces)
const brickGeo  = new THREE.BoxGeometry(BS.w, BS.h, BS.d);
// Z-aligned brick: long axis along Z (used for side walls & tower sides)
const brickGeoZ = new THREE.BoxGeometry(BS.d, BS.h, BS.w);

const brickMat = new THREE.MeshStandardMaterial({
    map: stoneColorMap,
    bumpMap: stoneBumpMap,
    bumpScale: 0.08,
    roughness: 0.85,
    metalness: 0.0
});

// ── InstancedMesh for bricks (2 draw calls total instead of ~1600) ──
// We pre-allocate for the maximum expected brick count.
const MAX_BRICKS = 4000;
const _iDummy    = new THREE.Object3D();
const brickInstX = new THREE.InstancedMesh(brickGeo, brickMat, MAX_BRICKS);
const brickInstZ = new THREE.InstancedMesh(brickGeoZ, brickMat, MAX_BRICKS);
brickInstX.castShadow = true; brickInstX.receiveShadow = true;
brickInstZ.castShadow = true; brickInstZ.receiveShadow = true;
brickInstX.count = 0; brickInstZ.count = 0;
scene.add(brickInstX); scene.add(brickInstZ);

// Collision filter groups — bricks ignore the drawbridge so the swinging
// door doesn't wake/knock sleeping bricks in the gate arch.
const CGROUP_BRICK  = 2;
const CGROUP_BRIDGE = 8;
// (default group=1 for ground, cannonballs, ragdoll parts)

function createBrick(x, y, z) {
    const idx = brickInstX.count++;
    _iDummy.position.set(x, y, z); _iDummy.quaternion.set(0,0,0,1); _iDummy.updateMatrix();
    brickInstX.setMatrixAt(idx, _iDummy.matrix);
    brickInstX.instanceMatrix.needsUpdate = true;
    const body = new CANNON.Body({
        mass: 150,   // heavier — more inertia, harder to shift
        material: brickPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(BS.w / 2, BS.h / 2, BS.d / 2)),
        allowSleep: true,
        sleepSpeedLimit: 0.3,
        sleepTimeLimit:  0.5,
        linearDamping:   0.12,
        angularDamping:  0.18,
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  -1 ^ CGROUP_BRIDGE
    });
    body.position.set(x, y, z);
    world.addBody(body);
    body.sleep();
    bricks.push({ idx, isZ: false, body, ix: x, iy: y, iz: z, scored: false });
}

// Z-aligned brick: long axis runs along Z (for side walls & tower sides)
function createBrickZ(x, y, z) {
    const idx = brickInstZ.count++;
    _iDummy.position.set(x, y, z); _iDummy.quaternion.set(0,0,0,1); _iDummy.updateMatrix();
    brickInstZ.setMatrixAt(idx, _iDummy.matrix);
    brickInstZ.instanceMatrix.needsUpdate = true;
    const body = new CANNON.Body({
        mass: 150,
        material: brickPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(BS.d / 2, BS.h / 2, BS.w / 2)),
        allowSleep: true,
        sleepSpeedLimit: 0.3,
        sleepTimeLimit:  0.5,
        linearDamping:   0.12,
        angularDamping:  0.18,
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  -1 ^ CGROUP_BRIDGE
    });
    body.position.set(x, y, z);
    world.addBody(body);
    body.sleep();
    bricks.push({ idx, isZ: true, body, ix: x, iy: y, iz: z, scored: false });
}

// Angled brick: same geometry as brickInstX (1.0 × 0.5 × 0.5) but
// rotated `angle` radians around Y — used for circular tower rings.
// The CANNON body starts with the same rotation so sync is exact.
function createBrickAngled(x, y, z, angle) {
    const idx = brickInstX.count++;
    _iDummy.position.set(x, y, z);
    _iDummy.rotation.set(0, angle, 0);
    _iDummy.updateMatrix();
    brickInstX.setMatrixAt(idx, _iDummy.matrix);
    brickInstX.instanceMatrix.needsUpdate = true;
    const body = new CANNON.Body({
        mass: 150,
        material: brickPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(BS.w / 2, BS.h / 2, BS.d / 2)),
        allowSleep: true,
        sleepSpeedLimit: 0.3,
        sleepTimeLimit:  0.5,
        linearDamping:   0.12,
        angularDamping:  0.18,
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  -1 ^ CGROUP_BRIDGE
    });
    body.position.set(x, y, z);
    body.quaternion.setFromEuler(0, angle, 0);
    world.addBody(body);
    body.sleep();
    bricks.push({ idx, isZ: false, body, ix: x, iy: y, iz: z, scored: false });
}

// === Castle build helpers ===
// Layout (metres):
//   Front outer face Z = CFZ = 27 (drawbridge hinge)
//   Back outer face  Z = CASTLE_BZ = 47
//   Left outer wall  X = -10,  Right outer wall X = 10  (20 m wide)
//   Hollow corner towers: TW=4 m × TD=4 m outer, 1 brick thick all faces
//   Curtain walls between towers: 1 brick thick, 12 m wide
//   NO stagger — all joints are gap/overlap free

const CFZ        = 54;
const CASTLE_XL  = -20;
const CASTLE_XR  =  20;
const CASTLE_BZ  = CFZ + 40;           // 94
const TW         =   8;                // tower footprint width  (X)
const TD         =   8;                // tower footprint depth  (Z)
const WALL_XL    = CASTLE_XL + TW;    // -6
const WALL_XR    = CASTLE_XR - TW;    //  6
const WALL_BRICKS = Math.round((WALL_XR - WALL_XL) / BS.w);  // 12

const WALL_ROWS  = 12;   // curtain wall height  (6.0 m)
const TOWER_ROWS = 18;   // tower height         (9.0 m)
const GATE_ROWS  =  8;   // gate opening rows    (4.0 m — tall enough for the drawbridge)

// Side wall span: between back face of front towers and front face of back towers
const SIDE_Z_START = CFZ       + TD;   // 31
const SIDE_Z_END   = CASTLE_BZ - TD;   // 43
const SIDE_BRICKS  = Math.round((SIDE_Z_END - SIDE_Z_START) / BS.w);  // 12

const TOWER_R = TW / 2;   // outer radius = 2.0 m

// Tower centre positions (cx, cz) — identical footprint to old square towers
const TOWER_CENTERS = [
    { cx: CASTLE_XL + TW / 2, cz: CFZ       + TD / 2 },   // front-left  (-8, 29)
    { cx: CASTLE_XR - TW / 2, cz: CFZ       + TD / 2 },   // front-right  (8, 29)
    { cx: CASTLE_XL + TW / 2, cz: CASTLE_BZ - TD / 2 },   // back-left   (-8, 45)
    { cx: CASTLE_XR - TW / 2, cz: CASTLE_BZ - TD / 2 },   // back-right   (8, 45)
];

// ── Circular tower: bricks placed tangentially around a ring ──
// brickR = centre-of-wall radius; long (1 m) axis tangent to circle,
// short (0.5 m) axis radial.  Alternate rows stagger by half a brick angle.
function buildRoundTower(cx, cz, R, rows) {
    const brickR  = R - BS.d / 2;
    const nBricks = Math.round(2 * Math.PI * brickR / BS.w);
    const aStep   = (2 * Math.PI) / nBricks;
    for (let r = 0; r < rows; r++) {
        const y    = BS.h / 2 + r * BS.h;
        const aOff = (r % 2) * (aStep / 2);
        for (let i = 0; i < nBricks; i++) {
            const a  = aOff + i * aStep;
            createBrickAngled(
                cx + brickR * Math.sin(a),
                y,
                cz + brickR * Math.cos(a),
                a
            );
        }
    }
}

// ── Round battlement ring (every other brick = merlon / gap pattern) ──
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

// ── Curtain wall: X-aligned WITH stagger ──
// Arrow-slit windows at x ≈ ±4.5 on rows 4-5 (2 m to 3 m height)
const CURTAIN_WIN_X = [-9.0, 9.0];
function buildCurtainWallX(zCenter, rows, withGate) {
    for (let r = 0; r < rows; r++) {
        const y    = BS.h / 2 + r * BS.h;
        const xOff = (r % 2) * (BS.w / 2);
        for (let i = 0; i < WALL_BRICKS; i++) {
            const cx = WALL_XL + xOff + BS.w / 2 + i * BS.w;
            if (cx < WALL_XL || cx > WALL_XR) continue;
            if (withGate && r < GATE_ROWS && Math.abs(cx) < 1.75) continue;
            // Arrow-slit windows: 1-brick gap, 2 rows tall
            if (r >= 4 && r <= 5) {
                let isWindow = false;
                for (const wx of CURTAIN_WIN_X) { if (Math.abs(cx - wx) < 1.2) { isWindow = true; break; } }
                if (isWindow) continue;
            }
            createBrick(cx, y, zCenter);
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

// ── Side wall: Z-aligned WITH stagger ──
// Arrow-slit windows at z ≈ SIDE_Z_START + 3.5 and + 8.5  (rows 4-5)
const SIDE_WIN_Z = [SIDE_Z_START + 7.0, SIDE_Z_START + 17.0];
function buildSideWallZ(xOuter, rows) {
    const xc = xOuter + (xOuter < 0 ? BS.d / 2 : -BS.d / 2);
    for (let r = 0; r < rows; r++) {
        const y    = BS.h / 2 + r * BS.h;
        const zOff = (r % 2) * (BS.w / 2);
        for (let d = 0; d < SIDE_BRICKS; d++) {
            const zc = SIDE_Z_START + zOff + BS.w / 2 + d * BS.w;
            if (zc < SIDE_Z_START || zc > SIDE_Z_END) continue;
            // Arrow-slit windows
            if (r >= 4 && r <= 5) {
                let isWindow = false;
                for (const wz of SIDE_WIN_Z) { if (Math.abs(zc - wz) < 1.2) { isWindow = true; break; } }
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

// ── Assemble the castle ──
// Circular corner towers
for (const { cx, cz } of TOWER_CENTERS) {
    buildRoundTower(cx, cz, TOWER_R, TOWER_ROWS);
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
(function addGateLintel() {
    const lw = 7.0, lh = BS.h, ld = BS.d;
    const lx = 0, ly = BS.h / 2 + (GATE_ROWS - 1) * BS.h, lz = CFZ + BS.d / 2;
    // Use a standalone mesh (not instanced) since it’s a unique static piece
    const lMesh = new THREE.Mesh(
        new THREE.BoxGeometry(lw, lh, ld),
        new THREE.MeshStandardMaterial({ map: stoneColorMap, bumpMap: stoneBumpMap,
                                          bumpScale: 0.08, roughness: 0.85 })
    );
    lMesh.position.set(lx, ly, lz);
    lMesh.castShadow = true; lMesh.receiveShadow = true;
    scene.add(lMesh);
    const body = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Box(new CANNON.Vec3(lw / 2, lh / 2, ld / 2)),
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  -1 ^ CGROUP_BRIDGE
    });
    body.position.set(lx, ly, lz);
    world.addBody(body);
    // idx:-1 flags this as not-instanced; isZ irrelevant; scored:true skips scoring
    bricks.push({ idx: -1, isZ: false, body, ix: lx, iy: ly, iz: lz, scored: true });
})()

// ── Window lintels ──
// Windows are gaps at rows 4-5. The row-6 bricks directly above have no
// support there, so they fall on load. A static lintel beam at row-5 height
// (same slot as the missing row-5 brick) bridges the gap and holds row 6+.
function addWindowLintel(x, y, z, isZ) {
    const lw = isZ ? BS.d : BS.w * 1.8;   // X dimension
    const lh = BS.h;
    const ld = isZ ? BS.w * 1.8 : BS.d;   // Z dimension
    const lMesh = new THREE.Mesh(
        new THREE.BoxGeometry(lw, lh, ld),
        new THREE.MeshStandardMaterial({ map: stoneColorMap, bumpMap: stoneBumpMap,
                                         bumpScale: 0.08, roughness: 0.85 })
    );
    lMesh.position.set(x, y, z);
    lMesh.castShadow = true; lMesh.receiveShadow = true;
    scene.add(lMesh);
    const body = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Box(new CANNON.Vec3(lw / 2, lh / 2, ld / 2)),
        collisionFilterGroup: CGROUP_BRICK,
        collisionFilterMask:  -1 ^ CGROUP_BRIDGE
    });
    body.position.set(x, y, z);
    world.addBody(body);
    bricks.push({ idx: -1, isZ: false, body, ix: x, iy: y, iz: z, scored: true });
}

// Lintel sits at row-5 position (top of the 2-row window gap)
const WIN_LINTEL_Y = BS.h / 2 + 5 * BS.h;

// Curtain walls (front & back) — X-aligned windows
for (const wx of CURTAIN_WIN_X) {
    addWindowLintel(wx, WIN_LINTEL_Y, CFZ + BS.d / 2,       false);
    addWindowLintel(wx, WIN_LINTEL_Y, CASTLE_BZ - BS.d / 2, false);
}

// Side walls (left & right) — Z-aligned windows
for (const wz of SIDE_WIN_Z) {
    addWindowLintel(CASTLE_XL + BS.d / 2, WIN_LINTEL_Y, wz, true);
    addWindowLintel(CASTLE_XR - BS.d / 2, WIN_LINTEL_Y, wz, true);
}
buildSideWallZ(CASTLE_XL, WALL_ROWS);
buildSideWallZ(CASTLE_XR, WALL_ROWS);
addSideWallBattlements(CASTLE_XL);
addSideWallBattlements(CASTLE_XR);

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

// Plank size — half the castle brick
const PS = { w: BS.w * 0.75, h: BS.h * 0.75, d: BS.d * 0.75 };

// Separate InstancedMesh pair for house planks (wood material)
const MAX_PLANKS = 800;
const plankGeoX  = new THREE.BoxGeometry(PS.w, PS.h, PS.d);
const plankGeoZ  = new THREE.BoxGeometry(PS.d, PS.h, PS.w);
const plankInstX = new THREE.InstancedMesh(plankGeoX, woodPlankMat, MAX_PLANKS);
const plankInstZ = new THREE.InstancedMesh(plankGeoZ, woodPlankMat, MAX_PLANKS);
plankInstX.castShadow = true; plankInstX.receiveShadow = true;
plankInstZ.castShadow = true; plankInstZ.receiveShadow = true;
plankInstX.count = 0; plankInstZ.count = 0;
scene.add(plankInstX); scene.add(plankInstZ);

// Track planks separately so they sync correctly
const planks = [];

function createPlank(x, y, z, isZ = false) {
    const idx = isZ ? plankInstZ.count++ : plankInstX.count++;
    _iDummy.position.set(x, y, z);
    _iDummy.quaternion.set(0, 0, 0, 1);
    _iDummy.updateMatrix();
    if (isZ) { plankInstZ.setMatrixAt(idx, _iDummy.matrix); plankInstZ.instanceMatrix.needsUpdate = true; }
    else      { plankInstX.setMatrixAt(idx, _iDummy.matrix); plankInstX.instanceMatrix.needsUpdate = true; }

    const hw = isZ ? PS.d/2 : PS.w/2;
    const hd = isZ ? PS.w/2 : PS.d/2;
    const body = new CANNON.Body({
        mass: 60,
        material: brickPhysMat,
        shape: new CANNON.Box(new CANNON.Vec3(hw, PS.h/2, hd)),
        allowSleep: true, sleepSpeedLimit: 0.3, sleepTimeLimit: 0.5,
        linearDamping: 0.10, angularDamping: 0.15,
        collisionFilterGroup: CGROUP_BRICK, collisionFilterMask: -1 ^ CGROUP_BRIDGE
    });
    body.position.set(x, y, z);
    world.addBody(body);
    body.sleep();
    planks.push({ idx, isZ, body, ix: x, iy: y, iz: z, scored: false, isPlank: true });
    bricks.push(planks[planks.length - 1]); // also add to bricks for blast/wake checks
}

function buildWoodenHouse(cx, cz) {
    // Simple cottage: 4 walls, 6 planks wide × 5 planks tall, open doorway in front
    const W = 6, D = 5, ROWS = 5;
    const DOOR_W = 2; // door columns to skip (centred)
    const doorMinX = Math.floor((W - DOOR_W) / 2);
    const doorMaxX = doorMinX + DOOR_W - 1;

    for (let r = 0; r < ROWS; r++) {
        const y = PS.h/2 + r * PS.h;
        const xOff = (r % 2) * (PS.w / 2);

        // Front wall (Z-facing, X-aligned planks) — with door gap rows 0-2
        for (let i = 0; i < W; i++) {
            const px = cx - (W * PS.w)/2 + xOff + PS.w/2 + i * PS.w;
            // Door gap
            if (r < 3 && i >= doorMinX && i <= doorMaxX) continue;
            createPlank(px, y, cz, false);
        }
        // Back wall
        for (let i = 0; i < W; i++) {
            const px = cx - (W * PS.w)/2 + xOff + PS.w/2 + i * PS.w;
            createPlank(px, y, cz + D * PS.d, false);
        }
        // Left wall (Z-aligned planks, interior span)
        const zOff = (r % 2) * (PS.w / 2);
        for (let j = 1; j < D; j++) {
            const pz = cz + zOff + PS.d/2 + (j-0.5) * PS.d;
            if (pz >= cz && pz <= cz + D * PS.d)
                createPlank(cx - (W * PS.w)/2 + PS.d/2, y, pz, true);
        }
        // Right wall
        for (let j = 1; j < D; j++) {
            const pz = cz + zOff + PS.d/2 + (j-0.5) * PS.d;
            if (pz >= cz && pz <= cz + D * PS.d)
                createPlank(cx + (W * PS.w)/2 - PS.d/2, y, pz, true);
        }
    }

    // Roof ridge: a gabled flat roof — two sloped rows of planks
    const roofY = PS.h/2 + ROWS * PS.h;
    for (let i = 0; i < W + 2; i++) {
        const px = cx - (W * PS.w)/2 - PS.w/2 + PS.w/2 + i * PS.w;
        for (let j = 0; j < D + 1; j++) {
            const pz = cz - PS.d/2 + j * PS.d;
            createPlank(px, roofY, pz, false);
        }
    }
}

buildWoodenHouse(60, 30);

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
        ctx.bezierCurveTo(42, y + (Math.random()-0.5)*5, 85, y + (Math.random()-0.5)*5, 128, y + (Math.random()-0.5)*3);
        const v = (Math.random()*35)|0;
        ctx.strokeStyle = `rgba(${20+v},${12+v},${5+v},0.55)`;
        ctx.lineWidth = Math.random() * 2.5 + 0.5;
        ctx.stroke();
    }
    for (let i = 0; i < 800; i++) {
        const x = Math.random()*128, y = Math.random()*64, v = ((Math.random()*30)-15)|0;
        ctx.fillStyle = `rgba(${80+v},${50+v},${25+v},0.18)`;
        ctx.fillRect(x, y, 1, 1);
    }
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(5, 1);
    return t;
}

const woodMat  = new THREE.MeshStandardMaterial({ map: makeWoodTexture(), roughness: 0.9, metalness: 0.0 });
const chainMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.25, metalness: 0.85 });

// === Drawbridge — single hinged board, starts vertical (closed), lowers open ===
// Hinge is at the base of the gate face (z = CFZ, y = 0).
// The board geometry extends DB_LENGTH toward the player (-z) in local space.
const DB_W      = 6.0;                   // width  (x)
const DB_H      = 0.44;                  // thickness
const DB_LENGTH = 9.0;                   // spans the 8m moat; bridge tip lands at z=45

const dbPivot = new THREE.Group();
dbPivot.position.set(0, DB_H / 2, CFZ);
scene.add(dbPivot);

const dbMesh = new THREE.Mesh(
    new THREE.BoxGeometry(DB_W, DB_H, DB_LENGTH),
    woodMat
);
dbMesh.position.set(0, 0, -DB_LENGTH / 2);   // pivot at one end, board toward player
dbMesh.castShadow = true;
dbMesh.receiveShadow = true;
dbPivot.add(dbMesh);

// Kinematic physics body — mass 0, manually synced each frame
const dbBody = new CANNON.Body({ mass: 0 });
dbBody.addShape(new CANNON.Box(new CANNON.Vec3(DB_W / 2, DB_H / 2, DB_LENGTH / 2)));
dbBody.collisionFilterGroup = CGROUP_BRIDGE;
dbBody.collisionFilterMask  = -1 ^ CGROUP_BRICK;  // collide with everything except bricks
world.addBody(dbBody);

let dbAngle     = Math.PI / 2;           // start vertical (closed)
let dbOpening   = false;
const DB_SPEED  = (Math.PI / 2) / 4.5;  // 4.5 s to fully open

// Begin lowering after 1.5 s so player sees it start closed
setTimeout(() => { dbOpening = true; }, 1500);

// Helper — sync kinematic body to current pivot angle
function syncDrawbridgePhysics() {
    // Centre of the board in world space when pivot is at (0, DB_H/2, CFZ)
    // and board local pos is (0, 0, -DB_LENGTH/2)
    const cy = DB_H / 2 + (DB_LENGTH / 2) * Math.sin(dbAngle);
    const cz = CFZ      - (DB_LENGTH / 2) * Math.cos(dbAngle);
    dbBody.position.set(0, cy, cz);
    dbBody.quaternion.setFromEuler(dbAngle, 0, 0);
}
syncDrawbridgePhysics();

// Chains — static cables from bridge front corners up to gate-arch top
const chainY = GATE_ROWS * BS.h;
const CX_L   = -DB_W / 2;
const CX_R   =  DB_W / 2;
const zFront = CFZ - DB_LENGTH;   // bridge tip when open

function addChain(x, zBottom, zTop, yTop) {
    const p1 = new THREE.Vector3(x, DB_H, zBottom);
    const p2 = new THREE.Vector3(x, yTop,  zTop);
    const len  = p1.distanceTo(p2);
    const mid  = p1.clone().add(p2).multiplyScalar(0.5);
    const dir  = p2.clone().sub(p1).normalize();
    const cable = new THREE.Mesh(
        new THREE.CylinderGeometry(0.038, 0.038, len, 6),
        chainMat
    );
    cable.position.copy(mid);
    cable.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    scene.add(cable);
    const steps = Math.max(3, (len / 1.0) | 0);
    for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.02, 4, 6), chainMat);
        ring.position.set(
            p1.x + (p2.x - p1.x) * t,
            p1.y + (p2.y - p1.y) * t,
            p1.z + (p2.z - p1.z) * t
        );
        ring.quaternion.copy(cable.quaternion);
        scene.add(ring);
    }
}
addChain(CX_L, zFront, CFZ, chainY);
addChain(CX_R, zFront, CFZ, chainY);

// === NPC — medieval guard standing inside the courtyard ===
// Each entry: { group, parts:[{mesh,hw,hh,hd,mass}], isRagdoll, ragdollParts:[{mesh,body}] }
const npcList = [];

function buildNPC(xPos, zPos, yBase = 0, facingAngle = Math.PI) {
    const g = new THREE.Group();
    g.position.set(xPos, yBase, zPos);
    g.rotation.y = facingAngle;   // face toward the gate (toward the player) by default
    scene.add(g);

    const legMat    = new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.8 });
    const armourMat = new THREE.MeshStandardMaterial({ color: 0x7f8c8d, roughness: 0.35, metalness: 0.65 });
    const skinMat   = new THREE.MeshStandardMaterial({ color: 0xf0c080, roughness: 0.7 });
    const helmetMat = new THREE.MeshStandardMaterial({ color: 0x5d6d7e, roughness: 0.25, metalness: 0.80 });
    const shaftMat  = new THREE.MeshStandardMaterial({ color: 0x5c3a1e, roughness: 0.9 });
    const tipMat    = new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.15, metalness: 0.85 });

    const parts = [];  // {mesh, hw, hh, hd, mass}

    // Legs
    [-0.15, 0.15].forEach(lx => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.72, 0.22), legMat.clone());
        leg.castShadow = true;
        leg.position.set(lx, 0.36, 0);
        g.add(leg);
        parts.push({ mesh: leg, hw: 0.11, hh: 0.36, hd: 0.11, mass: 8 });
    });
    // Torso
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.76, 0.3), armourMat.clone());
    torso.castShadow = true;
    torso.position.y = 1.08;
    g.add(torso);
    parts.push({ mesh: torso, hw: 0.28, hh: 0.38, hd: 0.15, mass: 20 });
    // Arms
    [-0.44, 0.44].forEach(ax => {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.65, 0.20), armourMat.clone());
        arm.castShadow = true;
        arm.position.set(ax, 0.98, 0);
        g.add(arm);
        parts.push({ mesh: arm, hw: 0.10, hh: 0.325, hd: 0.10, mass: 5 });
    });
    // Head
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.34, 0.32), skinMat.clone());
    head.castShadow = true;
    head.position.y = 1.64;
    g.add(head);
    parts.push({ mesh: head, hw: 0.175, hh: 0.17, hd: 0.16, mass: 6 });
    // Helmet top
    const helmetTop = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.2, 8), helmetMat.clone());
    helmetTop.castShadow = true;
    helmetTop.position.y = 1.90;
    g.add(helmetTop);
    parts.push({ mesh: helmetTop, hw: 0.21, hh: 0.10, hd: 0.21, mass: 3 });
    // Helmet brim
    const helmetBrim = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.055, 8), helmetMat.clone());
    helmetBrim.castShadow = true;
    helmetBrim.position.y = 1.82;
    g.add(helmetBrim);
    parts.push({ mesh: helmetBrim, hw: 0.27, hh: 0.028, hd: 0.27, mass: 2 });
    // Spear shaft
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 2.3, 6), shaftMat.clone());
    shaft.castShadow = true;
    shaft.position.set(0.48, 1.15, 0);
    g.add(shaft);
    parts.push({ mesh: shaft, hw: 0.066, hh: 1.15, hd: 0.066, mass: 3 });
    // Spear tip
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.058, 0.34, 6), tipMat.clone());
    tip.castShadow = true;
    tip.position.set(0.48, 2.32, 0);
    g.add(tip);
    parts.push({ mesh: tip, hw: 0.058, hh: 0.17, hd: 0.058, mass: 1 });

    // Physics trigger sphere — cannonballs collide with this instead of a
    // per-frame proximity check (reliable at any framerate / ball speed).
    const npcEntry = { group: g, parts, isRagdoll: false, ragdollParts: [],
                    walking: false, arrowTimer: 4.5, walkTime: 0,
                    waypoints: [], isTowerGuard: yBase > 0, triggerBody: null };
    npcList.push(npcEntry);
}

buildNPC(0, CFZ + 10);   // inside courtyard, facing out toward gate

// Tower-top guards: one on each circular tower, facing outward
const TOWER_TOP_Y = TOWER_ROWS * BS.h;   // 9.0 m
TOWER_CENTERS.forEach(({ cx, cz }) => {
    // Facing angle: outward from castle centre (0, CASTLE_MZ)
    const CASTLE_MZ = (CFZ + CASTLE_BZ) / 2;  // 37
    const angle = Math.atan2(cx - 0, cz - CASTLE_MZ);  // face away from centre
    buildNPC(cx, cz, TOWER_TOP_Y, angle);
});

// Explode an NPC into individually-simulated ragdoll parts.
// ballBody may be null for a gravity-drop (tower collapsed under them).
function activateRagdoll(npc, ballBody, isExplosion = false) {
    npc.isRagdoll = true;
    npc.group.visible = false;
    // Remove trigger body so it no longer intercepts cannonballs
    if (npc.triggerBody) { world.removeBody(npc.triggerBody); npc.triggerBody = null; }

    // Compute world transform from the group's stored position/rotation directly.
    // Avoids any stale Three.js matrix-cache issues (getWorldPosition can return
    // wrong values if matrixWorld hasn't been refreshed this frame).
    const gx   = npc.group.position.x;
    const gy   = npc.group.position.y;
    const gz   = npc.group.position.z;
    const yaw  = npc.group.rotation.y;
    const cosA = Math.cos(yaw);
    const sinA = Math.sin(yaw);
    const groupQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));

    const bvx = ballBody ? ballBody.velocity.x : 0;
    const bvy = ballBody ? ballBody.velocity.y : -2;
    const bvz = ballBody ? ballBody.velocity.z : 0;
    const bpx = ballBody ? ballBody.position.x : gx;
    const bpy = ballBody ? ballBody.position.y : gy + 1;
    const bpz = ballBody ? ballBody.position.z : gz;

    for (const p of npc.parts) {
        // Rotate the part's local XZ by the group's Y rotation to get world XZ
        const lx = p.mesh.position.x;
        const ly = p.mesh.position.y;
        const lz = p.mesh.position.z;
        const wx = gx + lx * cosA - lz * sinA;
        const wy = gy + ly;
        const wz = gz + lx * sinA + lz * cosA;

        const rdMesh = new THREE.Mesh(p.mesh.geometry, p.mesh.material);
        rdMesh.castShadow = true;
        rdMesh.position.set(wx, wy, wz);
        rdMesh.quaternion.copy(groupQuat);
        scene.add(rdMesh);

        const body = new CANNON.Body({
            mass: p.mass,
            linearDamping:  0.04,
            angularDamping: 0.06,
            allowSleep: false,
        });
        body.addShape(new CANNON.Box(new CANNON.Vec3(
            Math.max(p.hw, 0.05),
            Math.max(p.hh, 0.05),
            Math.max(p.hd, 0.05)
        )));
        body.position.set(wx, wy, wz);
        body.quaternion.set(groupQuat.x, groupQuat.y, groupQuat.z, groupQuat.w);

        const dx = wx - bpx, dy = wy - bpy, dz = wz - bpz;
        const dist  = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const scale = 1.0 / (1.0 + dist * 0.5);

        if (isExplosion) {
            // Violent scatter — parts fly apart in all directions
            body.velocity.set(
                bvx * scale + (Math.random() - 0.5) * 12,
                Math.abs(bvy * scale) + Math.random() * 10 + 5,
                bvz * scale + (Math.random() - 0.5) * 12
            );
            body.angularVelocity.set(
                (Math.random() - 0.5) * 30,
                (Math.random() - 0.5) * 30,
                (Math.random() - 0.5) * 30
            );
        } else if (ballBody) {
            // Tumble — whole figure knocked in ball's direction, spins as one unit
            const spd = Math.sqrt(bvx*bvx + bvz*bvz) + 0.001;
            const baseVX = (bvx / spd) * 12.0;
            const baseVY = 7.0;
            const baseVZ = (bvz / spd) * 12.0;
            const spinX =  (bvz / spd) * 14.0;
            const spinZ = -(bvx / spd) * 14.0;
            body.velocity.set(
                baseVX + (Math.random() - 0.5) * 1.2,
                baseVY + (Math.random() - 0.5) * 0.8,
                baseVZ + (Math.random() - 0.5) * 1.2
            );
            body.angularVelocity.set(
                spinX + (Math.random() - 0.5) * 3.0,
                (Math.random() - 0.5) * 4.0,
                spinZ + (Math.random() - 0.5) * 3.0
            );
        } else {
            // Tower collapse — fall outward
            body.velocity.set(
                (wx - gx) * 1.5 + (Math.random() - 0.5) * 2.0,
                3.0 + Math.random() * 3.0,
                (wz - gz) * 1.5 + (Math.random() - 0.5) * 2.0
            );
            body.angularVelocity.set(
                (Math.random() - 0.5) * 14,
                (Math.random() - 0.5) * 14,
                (Math.random() - 0.5) * 14
            );
        }

        world.addBody(body);
        npc.ragdollParts.push({ mesh: rdMesh, body });
    }

    // For non-explosive hits: add PointToPointConstraints so parts stay
    // connected at their attachment points — the figure tumbles as one body.
    // parts order: 0=Lleg 1=Rleg 2=torso 3=Larm 4=Rarm 5=head 6=helmTop 7=helmBrim 8=shaft 9=tip
    if (!isExplosion && npc.ragdollParts.length >= 6) {
        const P = npc.ragdollParts;
        const torso = P[2].body;
        // Joint anchors in torso-local space (approx attachment points)
        const joints = [
            // [part, pivot-on-part, pivot-on-torso]
            [P[0].body, new CANNON.Vec3(0,  0.36, 0), new CANNON.Vec3(-0.15, -0.38, 0)], // Lleg hip
            [P[1].body, new CANNON.Vec3(0,  0.36, 0), new CANNON.Vec3( 0.15, -0.38, 0)], // Rleg hip
            [P[3].body, new CANNON.Vec3(0,  0.32, 0), new CANNON.Vec3(-0.38,  0.10, 0)], // Larm shoulder
            [P[4].body, new CANNON.Vec3(0,  0.32, 0), new CANNON.Vec3( 0.38,  0.10, 0)], // Rarm shoulder
            [P[5].body, new CANNON.Vec3(0, -0.17, 0), new CANNON.Vec3( 0,     0.38, 0)], // head neck
        ];
        for (const [part, pivA, pivB] of joints) {
            const c = new CANNON.PointToPointConstraint(part, pivA, torso, pivB);
            world.addConstraint(c);
            npc.ragdollParts.push({ constraint: c }); // store for future cleanup
        }
    }
}

// === Arrows (fired by NPC guard) ===
const arrows = [];
const _arrowFwd = new THREE.Vector3(0, 0, 1);
const _arrowVel = new THREE.Vector3();
const arrowShaftMat = new THREE.MeshStandardMaterial({ color: 0x5c3a1e, roughness: 0.9 });
const arrowTipMat   = new THREE.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.18, metalness: 0.82 });
const arrowFeatherMat = new THREE.MeshStandardMaterial({ color: 0xddddcc, roughness: 1.0 });

function fireArrow(npc) {
    if (npc.isRagdoll) return;
    npc.group.updateWorldMatrix(true, true);
    // Launch from spear tip in world space
    const originLocal = new THREE.Vector3(0.48, 2.32, 0);
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

    arrows.push({ mesh: g, vx: dir.x * ARROW_SPEED,
                           vy: dir.y * ARROW_SPEED,
                           vz: dir.z * ARROW_SPEED, life: 8 });
}

// === Scoring ===
let score = 0, bricksDestroyed = 0, shotsFired = 0;
const AMMO_START = [3, 1, 1]; // standard, explosive, mortar
let p1Ammo = [...AMMO_START];
let p2Ammo = [...AMMO_START];
function updateUI() {
    document.getElementById("scoreValue").textContent = score;
    document.getElementById("bricksHit").textContent  = bricksDestroyed;
    document.getElementById("shotsValue").textContent = shotsFired;
    for (let i = 0; i < 3; i++) {
        const el = document.getElementById('ammo' + i);
        if (el) el.textContent = '\u00d7' + p1Ammo[i];
        const btn = document.getElementById('wBtn' + i);
        if (btn) btn.classList.toggle('empty', p1Ammo[i] === 0);
    }
}

// === Audio (procedural Web Audio) ===
let audioCtx = null;
function getAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}

function playCannonFire() {
    const ctx = getAudio(), sr = ctx.sampleRate, now = ctx.currentTime;

    // --- Layer 1: deep sub-bass body thump (0–120 Hz) ---
    const thumpLen = sr * 1.4;
    const thumpBuf = ctx.createBuffer(1, thumpLen, sr);
    const thumpData = thumpBuf.getChannelData(0);
    for (let i = 0; i < thumpLen; i++) {
        const t = i / sr;
        // Pitch-sweeping sine: starts at 90 Hz, drops to 28 Hz
        const freq = 90 * Math.exp(-t * 3.5) + 28;
        thumpData[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 2.8)
                     + (Math.random() * 2 - 1) * 0.18 * Math.exp(-t * 6);
    }
    const thumpSrc = ctx.createBufferSource(); thumpSrc.buffer = thumpBuf;
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(3.5, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 1.4);
    thumpSrc.connect(thumpGain); thumpGain.connect(ctx.destination); thumpSrc.start(now);

    // --- Layer 2: mid-freq pressure blast (noise through resonant LP) ---
    const blastLen = sr * 0.9;
    const blastBuf = ctx.createBuffer(1, blastLen, sr);
    const blastData = blastBuf.getChannelData(0);
    for (let i = 0; i < blastLen; i++) blastData[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sr) * 7);
    const blastSrc = ctx.createBufferSource(); blastSrc.buffer = blastBuf;
    const blastLP = ctx.createBiquadFilter(); blastLP.type = 'lowpass';
    blastLP.frequency.setValueAtTime(900, now);
    blastLP.frequency.exponentialRampToValueAtTime(120, now + 0.9);
    blastLP.Q.value = 3.5;
    const blastGain = ctx.createGain();
    blastGain.gain.setValueAtTime(2.8, now);
    blastGain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
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

function playImpact(intensity) {
    const ctx = getAudio(), sr = ctx.sampleRate, now = ctx.currentTime;
    const vol = Math.min(intensity, 1.0);

    // --- Layer 1: deep stone rumble thud ---
    const thudLen = Math.floor(sr * (0.5 + vol * 0.6));
    const thudBuf = ctx.createBuffer(1, thudLen, sr);
    const thudData = thudBuf.getChannelData(0);
    for (let i = 0; i < thudLen; i++) {
        const t = i / sr;
        const freq = (55 + vol * 30) * Math.exp(-t * 4) + 22;
        thudData[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * (4 - vol * 1.5))
                    + (Math.random() * 2 - 1) * 0.22 * Math.exp(-t * 9);
    }
    const thudSrc = ctx.createBufferSource(); thudSrc.buffer = thudBuf;
    const thudLP = ctx.createBiquadFilter(); thudLP.type = 'lowpass';
    thudLP.frequency.value = 220 + vol * 120; thudLP.Q.value = 1.8;
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(vol * 2.8, now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5 + vol * 0.5);
    thudSrc.connect(thudLP); thudLP.connect(thudGain); thudGain.connect(ctx.destination); thudSrc.start(now);

    // --- Layer 2: stone crack / scrape (band-passed noise burst) ---
    const crackLen = Math.floor(sr * (0.18 + vol * 0.22));
    const crackBuf = ctx.createBuffer(1, crackLen, sr);
    const crackData = crackBuf.getChannelData(0);
    for (let i = 0; i < crackLen; i++) crackData[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sr) * 22);
    const crackSrc = ctx.createBufferSource(); crackSrc.buffer = crackBuf;
    const crackBP = ctx.createBiquadFilter(); crackBP.type = 'bandpass';
    crackBP.frequency.value = 600 + vol * 500; crackBP.Q.value = 0.9;
    const crackGain = ctx.createGain(); crackGain.gain.value = vol * 1.2;
    crackSrc.connect(crackBP); crackBP.connect(crackGain); crackGain.connect(ctx.destination); crackSrc.start(now);

    // --- Layer 3: short debris rattle (high-freq sprinkle, only on hard hits) ---
    if (vol > 0.35) {
        const rattleLen = Math.floor(sr * 0.3);
        const rattleBuf = ctx.createBuffer(1, rattleLen, sr);
        const rattleData = rattleBuf.getChannelData(0);
        for (let i = 0; i < rattleLen; i++) rattleData[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sr) * 14);
        const rattleSrc = ctx.createBufferSource(); rattleSrc.buffer = rattleBuf;
        const rattleHP = ctx.createBiquadFilter(); rattleHP.type = 'highpass'; rattleHP.frequency.value = 2200;
        const rattleGain = ctx.createGain(); rattleGain.gain.value = (vol - 0.35) * 0.7;
        rattleSrc.connect(rattleHP); rattleHP.connect(rattleGain); rattleGain.connect(ctx.destination);
        rattleSrc.start(now + 0.04);
    }
}

function playExplosionBlast(radius) {
    const ctx = getAudio(), sr = ctx.sampleRate, now = ctx.currentTime;
    const scale = Math.min(radius / 7.0, 1.0);

    // Sub-bass shockwave
    const boomLen = sr * 2.0;
    const boomBuf = ctx.createBuffer(1, boomLen, sr);
    const boomData = boomBuf.getChannelData(0);
    for (let i = 0; i < boomLen; i++) {
        const t = i / sr;
        const freq = 70 * Math.exp(-t * 2.5) + 18;
        boomData[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 1.8)
                    + (Math.random() * 2 - 1) * 0.3 * Math.exp(-t * 4);
    }
    const boomSrc = ctx.createBufferSource(); boomSrc.buffer = boomBuf;
    const boomLP = ctx.createBiquadFilter(); boomLP.type = 'lowpass';
    boomLP.frequency.value = 180; boomLP.Q.value = 2.2;
    const boomGain = ctx.createGain();
    boomGain.gain.setValueAtTime(3.5 + scale * 2.0, now);
    boomGain.gain.exponentialRampToValueAtTime(0.001, now + 2.0);
    boomSrc.connect(boomLP); boomLP.connect(boomGain); boomGain.connect(ctx.destination); boomSrc.start(now);

    // Wide-band explosion body
    const bodyLen = sr * 1.1;
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

    // Debris tail
    const tailLen = sr * 1.8;
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

// === Particles ===
const particles = [];
const MAX_PARTICLES = 200;
const PARTICLE_GEO = new THREE.BoxGeometry(1, 1, 1);
const P_COLORS = [0x7a6a5a, 0x5a4a3a, 0xb0a090, 0x888888, 0x444444];

function spawnExplosion(pos) {
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

// === Weapon system ===
// 0 = standard cannonball, 1 = explosive, 2 = mortar
let currentWeapon = 0;
const WEAPONS = [
    { name: 'Cannonball', blastR: 0,   arcLoft: 0,    color: 0x2a2a2a },
    { name: 'Explosive',  blastR: 5.5, arcLoft: 0,    color: 0xff4400 },
    { name: 'Mortar',     blastR: 7.0, arcLoft: 0.55, color: 0x333300 },
];

let gameOver = false;
let gameOverPending = false;

function showGameOver() {
    gameOver = true;
    gameOverPending = false;
    document.getElementById('gameOver').style.display = 'flex';
    if (twoPlayerMode) {
        const winner = score > p2Score ? 'Player 1 Wins! \uD83C\uDFC6' :
                       p2Score > score ? 'Player 2 Wins! \uD83C\uDFC6' : "It's a Tie!";
        document.getElementById('goMsg').textContent = winner;
        document.getElementById('goScores').textContent = `P1: ${score} pts  |  P2: ${p2Score} pts`;
    } else {
        document.getElementById('goMsg').textContent = `Final Score: ${score} pts`;
        document.getElementById('goScores').textContent =
            `${bricksDestroyed} bricks destroyed in ${shotsFired} shots`;
    }
}

function checkGameOver() {
    const p1Done = p1Ammo.every(a => a === 0);
    const p2Done = !twoPlayerMode || p2Ammo.every(a => a === 0);
    if (!p1Done || !p2Done) return;
    // Wait for any in-flight balls to land before showing the overlay
    gameOverPending = true;
    if (cannonballs.length === 0) showGameOver();
}

function setWeapon(idx) {
    let w = ((idx % 3) + 3) % 3;
    // Skip weapons where both players are empty (or P1 only in 1P mode)
    for (let tries = 0; tries < 3; tries++) {
        const p1e = p1Ammo[w] === 0;
        const p2e = !twoPlayerMode || p2Ammo[w] === 0;
        if (!p1e || !p2e) break;
        w = (w + 1) % 3;
    }
    currentWeapon = w;
    document.querySelectorAll('.wBtn').forEach((b,i) =>
        b.classList.toggle('active', i === currentWeapon));
    updateUI();
}

// Blast: wake + impulse bricks within radius, spawn big explosion
function triggerBlast(pos, radius) {
    const r2 = radius * radius;
    const px = pos.x, py = pos.y, pz = pos.z;
    spawnExplosion(pos);
    spawnExplosion(new THREE.Vector3(px, py + 0.5, pz));  // double cloud
    playExplosionBlast(radius);

    // Big flash
    const fl = new THREE.PointLight(0xff8800, 200, radius * 3);
    fl.position.set(px, py, pz);
    scene.add(fl);
    setTimeout(() => scene.remove(fl), 180);

    for (const b of bricks) {
        const dx = b.body.position.x - px;
        const dy = b.body.position.y - py;
        const dz = b.body.position.z - pz;
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 > r2) continue;
        b.body.wakeUp();
        const dist  = Math.sqrt(d2) + 0.01;
        const force = (1 - dist / radius) * 12000;
        // Offset apply-point so bricks spin — makes walls topple rather than just translate
        const torqueOff = new CANNON.Vec3(
            (Math.random() - 0.5) * BS.h,
            (Math.random() - 0.5) * BS.h,
            (Math.random() - 0.5) * BS.h
        );
        b.body.applyImpulse(
            new CANNON.Vec3(dx/dist * force, Math.abs(dy/dist) * force * 0.6 + 700, dz/dist * force),
            torqueOff
        );
    }

    // Shockwave: wake bricks in 2× radius so the collapse ripples outward
    const shockR2 = (radius * 2.0) * (radius * 2.0);
    for (const b of bricks) {
        if (b.body.sleepState === 0) continue;
        const dx = b.body.position.x - px;
        const dy = b.body.position.y - py;
        const dz = b.body.position.z - pz;
        if (dx*dx + dy*dy + dz*dz < shockR2) b.body.wakeUp();
    }

    // Blast also ragdolls any NPC within radius (explosive scatter)
    const NPC_BLAST_R2 = radius * radius;
    for (const npc of npcList) {
        if (npc.isRagdoll) continue;
        const nx = npc.group.position.x - px;
        const ny = (npc.group.position.y + 1.1) - py;
        const nz = npc.group.position.z - pz;
        if (nx*nx + ny*ny + nz*nz < NPC_BLAST_R2) {
            activateRagdoll(npc, null, true);
        }
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

function fireCannonball(power) {
    if (gameOver || p1Ammo[currentWeapon] <= 0) return;
    const wep = WEAPONS[currentWeapon];
    p1Ammo[currentWeapon]--;
    shotsFired++; updateUI(); checkGameOver();

    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);

    // Arc loft for mortar
    if (wep.arcLoft > 0) {
        fwd.y += wep.arcLoft;
        fwd.normalize();
    }

    playCannonFire();

    // Muzzle flash
    const flash1 = new THREE.PointLight(0xffdd88, 55, 22);
    flash1.position.copy(camera.position).addScaledVector(fwd, 2.0);
    scene.add(flash1);
    const flash2 = new THREE.PointLight(0xffffff, 30, 10);
    flash2.position.copy(flash1.position);
    scene.add(flash2);
    setTimeout(() => { scene.remove(flash1); scene.remove(flash2); }, 110);

    const ballColor  = wep.color;
    const ballRadius = currentWeapon === 2 ? 0.52 : BALL_RADIUS;
    const ballMat    = currentWeapon === 0 ? BALL_MAT :
                       new THREE.MeshStandardMaterial({
                           color: ballColor, metalness: 0.7, roughness: 0.5,
                           emissive: currentWeapon === 1 ? 0x441100 : 0x221100,
                           emissiveIntensity: 0.6
                       });
    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(ballRadius, 16, 16),
        ballMat
    );
    mesh.castShadow = true;
    scene.add(mesh);

    const body = new CANNON.Body({
        mass: currentWeapon === 2 ? 280 : 180,
        shape: new CANNON.Sphere(ballRadius),
        linearDamping: 0.005
    });
    const start = camera.position.clone().addScaledVector(fwd, 2.2);
    body.position.set(start.x, start.y, start.z);
    body.velocity.set(fwd.x * power, fwd.y * power, fwd.z * power);
    world.addBody(body);

    const blastR = wep.blastR;

    if (blastR > 0) {
        // Explosive / mortar — detonate on first significant impact
        let detonated = false;
        body.addEventListener('collide', e => {
            if (detonated) return;
            const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
            if (impact < 3) return;
            detonated = true;
            const pos = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
            triggerBlast(pos, blastR);
            // Remove from tracking after short delay so visuals persist briefly
            setTimeout(() => {
                scene.remove(mesh);
                world.removeBody(body);
                const idx = cannonballs.findIndex(c => c.body === body);
                if (idx !== -1) cannonballs.splice(idx, 1);
            }, 80);
        });
    } else {
        // Standard — impact particles only
        let lastHit = 0;
        body.addEventListener('collide', e => {
            const now = performance.now();
            if (now - lastHit < 150) return;
            lastHit = now;
            const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
            if (impact > 2) {
                spawnExplosion(new THREE.Vector3(body.position.x, body.position.y, body.position.z));
                playImpact(Math.min(impact / 20, 1));
                const IMPACT_WAKE_R = 6.0;
                const ix = body.position.x, iy = body.position.y, iz = body.position.z;
                for (const b of bricks) {
                    const dx = b.body.position.x - ix;
                    if (dx > IMPACT_WAKE_R || dx < -IMPACT_WAKE_R) continue;
                    const dz = b.body.position.z - iz;
                    if (dz > IMPACT_WAKE_R || dz < -IMPACT_WAKE_R) continue;
                    const dy = b.body.position.y - iy;
                    if (dy > IMPACT_WAKE_R || dy < -IMPACT_WAKE_R) continue;
                    if (b.body.sleepState !== 0) b.body.wakeUp();
                }
            }
        });
    }

    cannonballs.push({ mesh, body, weaponType: currentWeapon });
    if (cannonballs.length > 8) {
        const old = cannonballs.shift();
        scene.remove(old.mesh);
        world.removeBody(old.body);
    }
    lastFiredBall = cannonballs[cannonballs.length - 1];
    return lastFiredBall;
}

// P1 fire wrapper — reads slider
function p1Fire() { fireCannonball(parseFloat(powerSlider.value)); }
function p2Fire() { if (twoPlayerMode) fireCannonballP2(parseFloat(powerSlider.value)); }

// === UI ===
const powerSlider = document.getElementById("power");
const powerVal    = document.getElementById("powerValue");
powerSlider.addEventListener("input", e => { powerVal.textContent = e.target.value; });

function adjustPower(delta) {
    const min = parseFloat(powerSlider.min);
    const max = parseFloat(powerSlider.max);
    const val = Math.max(min, Math.min(max, parseFloat(powerSlider.value) + delta));
    powerSlider.value = val;
    powerVal.textContent = val;
}

document.getElementById("fireButton").addEventListener("click", e => {
    e.stopPropagation();
    p1Fire();
});

window.addEventListener("keydown", e => {
    if (e.code === "Space") { e.preventDefault(); p1Fire(); }
    if (e.code === "Equal" || e.code === "NumpadAdd")    { e.preventDefault(); adjustPower(+5); }
    if (e.code === "Minus" || e.code === "NumpadSubtract") { e.preventDefault(); adjustPower(-5); }
    if (e.code === "Escape" && pointerLocked) document.exitPointerLock();
    if (e.code === "KeyQ") setWeapon(currentWeapon - 1);
    if (e.code === "KeyE") setWeapon(currentWeapon + 1);
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

function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);

    // Show game-over once the last fired ball has left the scene
    if (gameOverPending && cannonballs.length === 0) showGameOver();

    // Apply FPS aim — P1
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;

    // WASD movement — strafe along the horizontal plane (ignore pitch)
    if (keys.w || keys.a || keys.s || keys.d) {
        const fwd   = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
        const right = new THREE.Vector3( Math.cos(yaw), 0, -Math.sin(yaw));
        const move  = new THREE.Vector3();
        if (keys.w) move.addScaledVector(fwd,   1);
        if (keys.s) move.addScaledVector(fwd,  -1);
        if (keys.d) move.addScaledVector(right,  1);
        if (keys.a) move.addScaledVector(right, -1);
        if (move.lengthSq() > 0) {
            move.normalize().multiplyScalar(MOVE_SPEED * dt);
            camera.position.addScaledVector(move, 1);
            camera.position.y = 2.2;
        }
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

    // Unsupported-brick check — runs every 2 frames after the grace period.
    // KEY FIX: only sleeping bricks count as valid support. An awake (falling)
    // brick cannot support anything above it. This breaks the "chain float"
    // where brick A sleeps on top of floating brick B — B gets woken first,
    // then on the next pass A has no sleeping support and gets woken too.
    // Three passes per invocation collapse multi-level floating chains in one go.
    if (_frameCount > 180 && _frameCount % 2 === 0) {
        const GROUND_Y    = BS.h * 0.55;   // bricks resting on ground are exempt
        const CHECK_XZ    = BS.w + 0.2;
        const CHECK_DY_LO = 0.05;
        const CHECK_DY_HI = BS.h * 1.4;

        for (let pass = 0; pass < 3; pass++) {
            for (const b of bricks) {
                if (b.body.sleepState === 0) continue;  // already awake
                const by = b.body.position.y;
                if (by < GROUND_Y) continue;            // sitting on ground — fine
                const bx = b.body.position.x;
                const bz = b.body.position.z;
                let supported = false;
                for (const other of bricks) {
                    if (other === b) continue;
                    // Only a SLEEPING brick can act as valid support.
                    // An awake brick is in motion and cannot hold up anything.
                    if (other.body.sleepState !== 2) continue;
                    const ox = other.body.position.x;
                    if (Math.abs(ox - bx) > CHECK_XZ) continue;
                    const oz = other.body.position.z;
                    if (Math.abs(oz - bz) > CHECK_XZ) continue;
                    const dy = by - other.body.position.y;
                    if (dy > CHECK_DY_LO && dy < CHECK_DY_HI) { supported = true; break; }
                }
                if (!supported) b.body.wakeUp();
            }
        }
    }

    // Pre-step wake: sleeping bricks near an approaching cannonball must be
    // awake so the solver generates full contacts with them (tunneling fix).
    // Guards:
    //  a) Only run if the ball is moving faster than 2 m/s (rolling ball on
    //     the ground must not continuously wake tower bases).
    //  b) Only wake bricks roughly AHEAD of the ball (dot-product > 0), so
    //     bricks already passed through don’t re-wake and cascade.
    //  c) Tight 1.6 m radius — just enough to cover the brick thickness.
    for (const cb of cannonballs) {
        const bv = cb.body.velocity;
        const spd2 = bv.x*bv.x + bv.y*bv.y + bv.z*bv.z;
        if (spd2 < 4) continue;  // < 2 m/s — skip slow / resting balls
        const invSpd = 1 / Math.sqrt(spd2);
        const nx = bv.x * invSpd, ny = bv.y * invSpd, nz = bv.z * invSpd; // velocity direction unit vec
        const bp = cb.body.position;
        const R  = BS.d * 2.0;  // scale with brick thickness
        for (const b of bricks) {
            if (b.body.sleepState === 0) continue;  // already awake
            const dx = b.body.position.x - bp.x;
            if (dx > R || dx < -R) continue;
            const dz = b.body.position.z - bp.z;
            if (dz > R || dz < -R) continue;
            const dy = b.body.position.y - bp.y;
            if (dy > R || dy < -R) continue;
            // Forward-cone: only wake if brick is ahead of ball
            if (dx*nx + dy*ny + dz*nz < -0.2) continue;
            b.body.wakeUp();
        }
    }

    // Per-frame cannonball→NPC proximity check (replaces kinematic trigger body
    // which never fired collide events due to collisionResponse:false in cannon-es).
    const NPC_HIT_R2 = 1.5 * 1.5;
    for (const npc of npcList) {
        if (npc.isRagdoll) continue;
        const np = npc.group.position;
        const ny = np.y + 1.1;  // torso centre
        for (const cb of cannonballs) {
            const bp = cb.body.position;
            const dx = bp.x - np.x, dy = bp.y - ny, dz = bp.z - np.z;
            if (dx*dx + dy*dy + dz*dz < NPC_HIT_R2) {
                activateRagdoll(npc, cb.body, cb.weaponType > 0);
                break;
            }
        }
    }

    // NPC walking + arrow firing (only after drawbridge opens, or always for tower guards)
    const NPC_WALK_SPEED  = 2.5;
    const ARROW_INTERVAL  = 5.0;

    // Tower guards: always fire arrows + fall when tower collapses beneath them
    for (const npc of npcList) {
        if (npc.isRagdoll || !npc.isTowerGuard) continue;

        const gp = npc.group.position;

        // Support check every frame: scan bricks in the tower column.
        // Ragdoll the instant ANY top-layer brick wakes up (starts moving) —
        // no need to wait for it to physically fall.
        if (gp.y > 1.0) {
            const HR2 = (TOWER_R + 0.5) * (TOWER_R + 0.5);
            const footY = gp.y;
            let topBrickAwake = false;
            let maxBrickY = -Infinity;
            for (const b of bricks) {
                const dx = b.body.position.x - gp.x;
                const dz = b.body.position.z - gp.z;
                if (dx * dx + dz * dz > HR2) continue;
                const by = b.body.position.y;
                if (by > maxBrickY) {
                    maxBrickY = by;
                    // sleepState 0 = AWAKE in cannon-es
                    topBrickAwake = (b.body.sleepState === 0);
                }
            }
            // Ragdoll if: highest brick is awake (disturbed) AND still within
            // 2 rows of the guard's feet (avoids triggering on distant falling debris)
    if (_frameCount > 180 && topBrickAwake && maxBrickY > footY - BS.h * 2) {
                activateRagdoll(npc, null);
                continue;
            }
            // Also ragdoll if the highest brick has already fallen away entirely
            if (maxBrickY < footY - BS.h * 0.5) {
                activateRagdoll(npc, null);
                continue;
            }
        }

        // Rotate to track camera (player 1)
        const dx = camera.position.x - gp.x;
        const dz = camera.position.z - gp.z;
        npc.group.rotation.y = Math.atan2(dx, dz);
        npc.arrowTimer += dt;
        if (npc.arrowTimer >= ARROW_INTERVAL) {
            npc.arrowTimer = 0;
            fireArrow(npc);
        }
    }

    for (const npc of npcList) {
        if (npc.isRagdoll || !npc.walking || npc.isTowerGuard) continue;
        const np = npc.group.position;

        // Follow waypoints first; once exhausted, track the player
        let tx, tz;
        if (npc.waypoints.length > 0) {
            const wp = npc.waypoints[0];
            const wdx = wp.x - np.x, wdz = wp.z - np.z;
            if (wdx * wdx + wdz * wdz < 0.4 * 0.4) npc.waypoints.shift();
            const cur = npc.waypoints[0] || { x: camera.position.x, z: camera.position.z };
            tx = cur.x; tz = cur.z;
        } else {
            tx = camera.position.x; tz = camera.position.z;
        }

        const dx = tx - np.x;
        const dz = tz - np.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        npc.group.rotation.y = Math.atan2(dx, dz);  // face direction of travel
        if (dist > 0.4) {
            np.x += (dx / dist) * NPC_WALK_SPEED * dt;
            np.z += (dz / dist) * NPC_WALK_SPEED * dt;
            npc.walkTime += dt;
            const swing = Math.sin(npc.walkTime * 4.5) * 0.55;
            npc.parts[0].mesh.rotation.x =  swing;   // left leg
            npc.parts[1].mesh.rotation.x = -swing;   // right leg
            npc.parts[3].mesh.rotation.x = -swing;   // left arm
            npc.parts[4].mesh.rotation.x =  swing;   // right arm
        }
        npc.arrowTimer += dt;
        if (npc.arrowTimer >= ARROW_INTERVAL) {
            npc.arrowTimer = 0;
            fireArrow(npc);
        }
    }

    // Cascade wake: any brick moving faster than 1 m/s wakes its immediate
    // contact neighbours. This is the domino effect — a toppling section of
    // wall pushes the next section rather than each brick flying independently.
    const CAS_R  = BS.w * 1.4;  // just wider than one brick face
    const CAS_V2 = 1.0;         // 1 m/s threshold
    for (const b of bricks) {
        if (b.body.sleepState !== 0) continue;  // only awake bricks drive cascade
        const bv = b.body.velocity;
        if (bv.x*bv.x + bv.y*bv.y + bv.z*bv.z < CAS_V2) continue;
        const bx = b.body.position.x, by = b.body.position.y, bz = b.body.position.z;
        for (const other of bricks) {
            if (other === b || other.body.sleepState === 0) continue;
            const dx = other.body.position.x - bx;
            if (dx > CAS_R || dx < -CAS_R) continue;
            const dz = other.body.position.z - bz;
            if (dz > CAS_R || dz < -CAS_R) continue;
            const dy = other.body.position.y - by;
            if (dy > CAS_R * 2 || dy < -CAS_R * 2) continue;
            other.body.wakeUp();
        }
    }

    // Fixed timestep 1/180 s → at 30 m/s the ball moves 0.167 m per substep,
    // well under the 0.5 m brick thickness, preventing tunneling.
    world.step(1 / 180, dt, 8);

    // Sync instanced brick meshes — only bricks that are awake need updating.
    // We rebuild both instance matrices in full each frame (fast since GPU
    // upload of a contiguous Float32Array is cheap).
    for (const b of bricks) {
        if (b.idx < 0) continue;   // static non-instanced pieces (lintel etc.)
        _iDummy.position.copy(b.body.position);
        _iDummy.quaternion.copy(b.body.quaternion);
        _iDummy.updateMatrix();
        if (b.isPlank) {
            if (b.isZ) plankInstZ.setMatrixAt(b.idx, _iDummy.matrix);
            else       plankInstX.setMatrixAt(b.idx, _iDummy.matrix);
        } else {
            if (b.isZ) brickInstZ.setMatrixAt(b.idx, _iDummy.matrix);
            else       brickInstX.setMatrixAt(b.idx, _iDummy.matrix);
        }
        if (!b.scored) {
            const dx = b.body.position.x - b.ix;
            const dy = b.body.position.y - b.iy;
            const dz = b.body.position.z - b.iz;
            if (dx * dx + dy * dy + dz * dz > 0.25) {
                b.scored = true; bricksDestroyed++; score += 10; updateUI();
            }
        }
    }
    brickInstX.instanceMatrix.needsUpdate = true;
    brickInstZ.instanceMatrix.needsUpdate = true;
    plankInstX.instanceMatrix.needsUpdate = true;
    plankInstZ.instanceMatrix.needsUpdate = true;

    for (const cb of cannonballs) {
        cb.mesh.position.copy(cb.body.position);
        cb.mesh.quaternion.copy(cb.body.quaternion);
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
    }

    // Sync ragdoll NPC part meshes to their physics bodies
    for (const npc of npcList) {
        if (!npc.isRagdoll) continue;
        for (const p of npc.ragdollParts) {
            if (!p.mesh) continue;  // constraint-only entry — no mesh to sync
            p.mesh.position.copy(p.body.position);
            p.mesh.quaternion.copy(p.body.quaternion);
        }
    }

    // Animate drawbridge lowering
    if (dbOpening && dbAngle > 0) {
        dbAngle = Math.max(0, dbAngle - DB_SPEED * dt);
        dbPivot.rotation.x = dbAngle;
        syncDrawbridgePhysics();
        if (dbAngle <= 0) {
            // Bridge fully down — courtyard NPC marches out (tower guards stay put)
            for (const npc of npcList) {
                if (!npc.isRagdoll && !npc.isTowerGuard) {
                    npc.walking   = true;
                    npc.waypoints = [
                        { x: 0, z: CFZ + 0.5 },
                        { x: 0, z: M_OZ1 - 0.5 },
                    ];
                }
            }
        }
    }

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
    for (const c of clouds) {
        c.group.position.x -= c.speed * dt;
        if (c.group.position.x < -150) c.group.position.x = 150;
    }

    // Scroll moat water ripple UV
    waterTex.offset.x  = (waterTex.offset.x + 0.018 * dt) % 1;
    waterTex.offset.y  = (waterTex.offset.y + 0.006 * dt) % 1;
    waterTex.needsUpdate = true;

    // Render — reflectors handle their own internal render pass automatically

    if (twoPlayerMode) {
        // Left half: P1
        const hw = Math.floor(window.innerWidth / 2);
        const h  = window.innerHeight;
        renderer.setScissorTest(true);
        renderer.setScissor(0, 0, hw, h);
        renderer.setViewport(0, 0, hw, h);
        renderer.render(scene, camera);

        // Right half: P2
        renderer.setScissor(hw, 0, hw, h);
        renderer.setViewport(hw, 0, hw, h);
        renderer.render(scene, camera2);

        renderer.setScissorTest(false);
        renderer.setScissor(0, 0, window.innerWidth, h);
        renderer.setViewport(0, 0, window.innerWidth, h);
    } else {
        renderer.render(scene, camera);
    }

    // Ball-cam PiP: bottom-right corner while RMB held and ball exists
    if (ballCamActive && lastFiredBall && cannonballs.includes(lastFiredBall)) {
        const W = window.innerWidth, H = window.innerHeight;
        const pw = Math.floor(W * 0.30);   // 30 % width
        const ph = Math.floor(pw * 9 / 16);
        const px = W - pw - 12;
        const py = 12;
        renderer.setScissorTest(true);
        // Dark border
        renderer.setScissor(px - 3, H - py - ph - 3, pw + 6, ph + 6);
        renderer.setViewport(px - 3, H - py - ph - 3, pw + 6, ph + 6);
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
        // PiP viewport
        renderer.setScissor(px, H - py - ph, pw, ph);
        renderer.setViewport(px, H - py - ph, pw, ph);
        ballCamera.aspect = pw / ph;
        ballCamera.updateProjectionMatrix();
        renderer.render(scene, ballCamera);
        renderer.setScissorTest(false);
        renderer.setScissor(0, 0, W, H);
        renderer.setViewport(0, 0, W, H);
        renderer.setClearColor(0x9ec8f0, 1);   // restore sky clear colour
    }
}

animate();