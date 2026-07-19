data = open('src/main.js', 'rb').read()

repl = b'\xef\xbf\xbd'

old = (
    b'const force = (1 - dist / radius) * 5500;\r\n'
    b'        // Offset apply-point so bricks spin ' + repl + b' makes walls topple rather than just translate\r\n'
    b'        const torqueOff = new CANNON.Vec3(\r\n'
    b'            (Math.random() - 0.5) * BS.h,\r\n'
    b'            (Math.random() - 0.5) * BS.h,\r\n'
    b'            (Math.random() - 0.5) * BS.h\r\n'
    b'        );\r\n'
    b'        b.body.applyImpulse(\r\n'
    b'            new CANNON.Vec3(dx/dist * force, Math.abs(dy/dist) * force * 0.5 + 500, dz/dist * force),\r\n'
    b'            torqueOff\r\n'
    b'        );\r\n'
    b'        // Hard velocity cap \xe2\x80\x94 no brick can fly fast enough to demolish a distant tower\r\n'
    b'        const v = b.body.velocity;\r\n'
    b'        const spd2 = v.x*v.x + v.y*v.y + v.z*v.z;\r\n'
    b'        if (spd2 > 100) {  // 10 m/s max\r\n'
    b'            const s = 10 / Math.sqrt(spd2);\r\n'
    b'            b.body.velocity.set(v.x*s, v.y*s, v.z*s);\r\n'
    b'        }'
)

new = (
    b'const force = (1 - dist / radius) * 2200;\r\n'
    b'        // Off-centre apply-point encourages rotation (toppling) over translation\r\n'
    b'        const torqueOff = new CANNON.Vec3(\r\n'
    b'            (Math.random() - 0.5) * BS.h,\r\n'
    b'            (Math.random() - 0.5) * BS.h,\r\n'
    b'            (Math.random() - 0.5) * BS.h\r\n'
    b'        );\r\n'
    b'        // Purely radial impulse -- no fixed upward boost.\r\n'
    b'        // Bricks above blast go up slightly, bricks below go down -- no lofting.\r\n'
    b'        b.body.applyImpulse(\r\n'
    b'            new CANNON.Vec3(\r\n'
    b'                dx/dist * force,\r\n'
    b'                dy/dist * force * 0.35,\r\n'
    b'                dz/dist * force\r\n'
    b'            ),\r\n'
    b'            torqueOff\r\n'
    b'        );\r\n'
    b'        // Tight velocity cap -- bricks can topple/slide but cannot cascade\r\n'
    b'        // energy across the structure to a distant tower.\r\n'
    b'        const v = b.body.velocity;\r\n'
    b'        const spd2 = v.x*v.x + v.y*v.y + v.z*v.z;\r\n'
    b'        if (spd2 > 16) {  // 4 m/s max (was 10)\r\n'
    b'            const s = 4 / Math.sqrt(spd2);\r\n'
    b'            b.body.velocity.set(v.x*s, v.y*s, v.z*s);\r\n'
    b'        }'
)

if old in data:
    data = data.replace(old, new, 1)
    open('src/main.js', 'wb').write(data)
    print('replaced OK')
else:
    # Try to find what the actual bytes look like
    idx = data.find(b'if (spd2 > 100)')
    if idx != -1:
        print('Found velocity cap at offset', idx)
        print(repr(data[idx-300:idx+100]))
    else:
        print('NOT FOUND')
        idx = data.find(b'const force = (1 - dist / radius)')
        print('force line at', idx)
        print(repr(data[idx:idx+600]))
