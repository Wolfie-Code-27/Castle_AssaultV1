import re

with open('src/main.js', 'rb') as f:
    data = f.read()

# Find start of fireCannonball P1 function
start_marker = b'function fireCannonball(power) {'
end_marker = b'\r\nfunction p1Fire'

start_idx = data.find(start_marker)
end_idx = data.find(end_marker, start_idx)

if start_idx == -1 or end_idx == -1:
    print(f'Markers not found: start={start_idx}, end={end_idx}')
    exit(1)

old_block = data[start_idx:end_idx]
print(f'Found block, length={len(old_block)}')

new_block = b'''function fireCannonball(power) {
    if (gameOver || p1Ammo[currentWeapon] <= 0) return;
    const wep = WEAPONS[currentWeapon];
    const isMinigun = (currentWeapon === 3);
    p1Ammo[currentWeapon]--;
    shotsFired++; updateUI(); checkGameOver();

    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);

    // Arc loft for mortar
    if (wep.arcLoft > 0) {
        fwd.y += wep.arcLoft;
        fwd.normalize();
    }

    if (isMinigun) {
        playMinigunShot();
        const mfl = new THREE.PointLight(0xffffaa, 12, 6);
        mfl.position.copy(camera.position).addScaledVector(fwd, 1.5);
        scene.add(mfl);
        setTimeout(() => scene.remove(mfl), 40);
    } else {
        playCannonFire();
        const flash1 = new THREE.PointLight(0xffdd88, 55, 22);
        flash1.position.copy(camera.position).addScaledVector(fwd, 2.0);
        scene.add(flash1);
        const flash2 = new THREE.PointLight(0xffffff, 30, 10);
        flash2.position.copy(flash1.position);
        scene.add(flash2);
        setTimeout(() => { scene.remove(flash1); scene.remove(flash2); }, 110);
    }

    const ballColor  = wep.color;
    const ballRadius = isMinigun ? 0.10 : currentWeapon === 2 ? 0.52 : BALL_RADIUS;
    const ballMat    = isMinigun
        ? new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.95, roughness: 0.15 })
        : currentWeapon === 0 ? BALL_MAT
        : new THREE.MeshStandardMaterial({
              color: ballColor, metalness: 0.7, roughness: 0.5,
              emissive: currentWeapon === 1 ? 0x441100 : 0x221100,
              emissiveIntensity: 0.6
          });
    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(ballRadius, isMinigun ? 6 : 16, isMinigun ? 6 : 16),
        ballMat
    );
    mesh.castShadow = !isMinigun;
    scene.add(mesh);

    // Minigun fires at 2.2x power for high-speed kinetic impact
    const launchSpeed = isMinigun ? Math.max(power * 2.2, 80) : power;
    const body = new CANNON.Body({
        mass: isMinigun ? 5 : currentWeapon === 2 ? 280 : 180,
        shape: new CANNON.Sphere(ballRadius),
        linearDamping: isMinigun ? 0.001 : 0.005
    });
    const start = camera.position.clone().addScaledVector(fwd, isMinigun ? 1.4 : 2.2);
    body.position.set(start.x, start.y, start.z);
    body.velocity.set(fwd.x * launchSpeed, fwd.y * launchSpeed, fwd.z * launchSpeed);
    world.addBody(body);

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
                scene.remove(mesh);
                world.removeBody(body);
                const idx = cannonballs.findIndex(c => c.body === body);
                if (idx !== -1) cannonballs.splice(idx, 1);
            }, 80);
        });
    } else if (isMinigun) {
        // Minigun -- kinetic hit: direct impulse to struck brick, quick self-destruct
        let hit = false;
        body.addEventListener('collide', e => {
            if (hit) return;
            const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
            if (impact < 5) return;
            hit = true;
            if (e.body && e.body.mass > 0) {
                const spd = Math.sqrt(body.velocity.x**2 + body.velocity.y**2 + body.velocity.z**2) || 1;
                const imp = Math.min(spd * 0.6, 12);
                e.body.wakeUp();
                e.body.applyImpulse(
                    new CANNON.Vec3(
                        (body.velocity.x / spd) * imp * 150,
                        (body.velocity.y / spd) * imp * 150 + 80,
                        (body.velocity.z / spd) * imp * 150
                    ),
                    new CANNON.Vec3(0, 0, 0)
                );
                const ix = body.position.x, iy = body.position.y, iz = body.position.z;
                for (const b of bricks) {
                    if (Math.abs(b.body.position.x - ix) > 1.5) continue;
                    if (Math.abs(b.body.position.z - iz) > 1.5) continue;
                    if (Math.abs(b.body.position.y - iy) > 1.5) continue;
                    b.body.wakeUp();
                }
            }
            setTimeout(() => {
                scene.remove(mesh);
                world.removeBody(body);
                const idx = cannonballs.findIndex(c => c.body === body);
                if (idx !== -1) cannonballs.splice(idx, 1);
            }, 40);
        });
    } else {
        // Standard -- impact particles only
        let lastHit = 0;
        body.addEventListener('collide', e => {
            const now = performance.now();
            if (now - lastHit < 150) return;
            lastHit = now;
            const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
            if (impact > 2) {
                spawnExplosion(new THREE.Vector3(body.position.x, body.position.y, body.position.z));
                playImpact(Math.min(impact / 20, 1));
                const IMPACT_WAKE_R = 2.5;
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
    if (cannonballs.length > 16) {
        const old = cannonballs.shift();
        scene.remove(old.mesh);
        world.removeBody(old.body);
    }
    if (!isMinigun) lastFiredBall = cannonballs[cannonballs.length - 1];
    return cannonballs[cannonballs.length - 1];
}'''.replace(b'\n', b'\r\n')

data = data[:start_idx] + new_block + data[end_idx:]
with open('src/main.js', 'wb') as f:
    f.write(data)
print('Done OK')
