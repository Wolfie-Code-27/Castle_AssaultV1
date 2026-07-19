// SAP patch verification: (1) behavioral scenarios (wall + cannonball, incl.
// teleport-while-asleep), (2) ground-truth pair-set equivalence vs a Naive
// reference on every snapshot of a chaotic run (explosion wake, sleepers,
// ground plane, teleports), (3) rough sweep cost with many awake bodies.
import * as CANNON from '../node_modules/cannon-es/dist/cannon-es.js';

function patchSapCollisionPairs(bp) {
    let keyLo = new Float64Array(0);
    let prefixMaxHi = new Float64Array(0);
    const unbounded = [];
    bp.collisionPairs = function (w, p1, p2) {
        const bodies = this.axisList;
        const N = bodies.length;
        this.dirty = false;
        const ax = this.axisIndex === 0 ? 'x' : this.axisIndex === 1 ? 'y' : 'z';
        const STATIC = CANNON.Body.STATIC;
        const SLEEPING = CANNON.Body.SLEEPING;
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
            if (r > 1e9) unbounded.push(b);
            else if (p + r > runMax) runMax = p + r;
            prefixMaxHi[i] = runMax;
        }
        for (let i = 0; i !== N; i++) {
            const bi = bodies[i];
            if ((bi.type & STATIC) !== 0 || bi.sleepState === SLEEPING) continue;
            const r = bi.boundingRadius;
            const biLo = keyLo[i];
            const biHi = bi.position[ax] + r;
            for (let j = i + 1; j < N; j++) {
                const bj = bodies[j];
                if (keyLo[j] > biHi) break;
                if (!this.needBroadphaseCollision(bi, bj)) continue;
                this.intersectionTest(bi, bj, p1, p2);
            }
            for (let j = i - 1; j >= 0; j--) {
                if (prefixMaxHi[j] < biLo) break;
                const bj = bodies[j];
                if (!((bj.type & STATIC) !== 0 || bj.sleepState === SLEEPING)) continue;
                if (bj.boundingRadius > 1e9) continue;
                if (bj.position[ax] + bj.boundingRadius < biLo) continue;
                if (!this.needBroadphaseCollision(bi, bj)) continue;
                this.intersectionTest(bj, bi, p1, p2);
            }
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

// Reference pair set: Naive (all i<j) with cannon's own filters. This is the
// "no pairs missed" ground truth the patched sweep must match exactly.
function referencePairs(bp, world) {
    const p1 = [], p2 = [];
    const bodies = world.bodies;
    for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
            if (!bp.needBroadphaseCollision(bodies[i], bodies[j])) continue;
            bp.intersectionTest(bodies[i], bodies[j], p1, p2);
        }
    }
    return pairKeySet(p1, p2);
}

function pairKeySet(p1, p2) {
    const s = new Set();
    for (let i = 0; i < p1.length; i++) {
        const a = p1[i].id, b = p2[i].id;
        s.add(a < b ? a * 100000 + b : b * 100000 + a);
    }
    return s;
}

function buildWorld(patch) {
    const world = new CANNON.World();
    world.gravity.set(0, -9.82, 0);
    world.allowSleep = true;
    const bp = new CANNON.SAPBroadphase(world);
    bp.axisIndex = 2;
    if (patch) patchSapCollisionPairs(bp);
    world.broadphase = bp;
    world.solver.iterations = 20;
    const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(ground);
    const bricks = [];
    for (let gy = 0; gy < 8; gy++) {
        for (let gx = 0; gx < 14; gx++) {
            const b = new CANNON.Body({
                mass: 12,
                shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.25, 0.25)),
                allowSleep: true, sleepSpeedLimit: 0.6, sleepTimeLimit: 0.3,
            });
            b.position.set((gx - 7) * 1.01, 0.26 + gy * 0.51, (gx % 3) * 0.02);
            b.sleep();
            world.addBody(b);
            bricks.push(b);
        }
    }
    return { world, bp, bricks };
}

// --- 1. Behavioral scenarios ---
function runScenario(patch, teleport) {
    const { world, bricks } = buildWorld(patch);
    const ball = new CANNON.Body({ mass: 180, shape: new CANNON.Sphere(0.4), linearDamping: 0.08, angularDamping: 0.6 });
    ball.position.set(0, 1.6, 18);
    ball.velocity.set(0, 2, -40);
    world.addBody(ball);
    let collided = false;
    ball.addEventListener('collide', () => { collided = true; });
    if (teleport) {
        world.step(1 / 60);
        for (const b of bricks) {
            const p = b.position.clone();
            b.position.set(0, -5000, 0);
            b.sleep();
            b.position.set(p.x, p.y, p.z);
        }
    }
    let minZ = Infinity;
    for (let s = 0; s < 180; s++) {
        world.step(1 / 60, 1 / 60, 4);
        if (ball.position.z < minZ) minZ = ball.position.z;
    }
    const awake = bricks.filter(b => b.sleepState === CANNON.Body.AWAKE).length;
    return { collided, minZ: minZ.toFixed(2), awakeBricks: awake };
}
console.log('behav stock          :', JSON.stringify(runScenario(false, false)));
console.log('behav patched        :', JSON.stringify(runScenario(true, false)));
console.log('behav stock  +tp     :', JSON.stringify(runScenario(false, true)));
console.log('behav patched+tp     :', JSON.stringify(runScenario(true, true)));

// --- 2. Ground-truth pair-set equivalence during a chaotic explosive run ---
{
    const { world, bp, bricks } = buildWorld(true);
    for (const b of bricks) {
        const d = Math.hypot(b.position.x, b.position.y - 2, b.position.z);
        if (d < 6) {
            b.wakeUp();
            b.velocity.set(b.position.x * 2, 6 + Math.random() * 4, (Math.random() - 0.5) * 8);
        }
    }
    let missing = 0;
    let checked = 0;
    for (let s = 0; s < 240; s++) {
        world.step(1 / 60, 1 / 60, 4);
        if (s % 5 === 0) {
            const sleepers = bricks.filter(b => b.sleepState === CANNON.Body.SLEEPING);
            if (sleepers.length && s % 20 === 0) {
                const b = sleepers[(Math.random() * sleepers.length) | 0];
                const p = b.position.clone();
                b.position.set(0, -5000, 0);
                b.position.set(p.x, p.y, p.z);
            }
            const p1 = [], p2 = [];
            bp.collisionPairs(world, p1, p2);
            const got = pairKeySet(p1, p2);
            const ref = referencePairs(bp, world);
            checked++;
            for (const k of ref) if (!got.has(k)) missing++;
        }
    }
    console.log(`pair ground-truth    : ${checked} snapshots, missing pairs = ${missing} ${missing === 0 ? '(PASS)' : '(FAIL!)'}`);
}

// --- 3. Sweep cost with many awake bodies (mobile explosive worst case) ---
{
    const { world, bp } = buildWorld(true);
    for (const b of world.bodies) if (b.mass > 0) b.wakeUp();
    const p1 = [], p2 = [];
    const t0 = performance.now();
    for (let k = 0; k < 200; k++) { p1.length = 0; p2.length = 0; bp.collisionPairs(world, p1, p2); }
    const perCall = (performance.now() - t0) / 200;
    console.log(`all-awake sweep cost : ${perCall.toFixed(3)} ms/call (${world.bodies.length} bodies, ${p1.length} pairs)`);
}
