data = open('src/main.js', 'rb').read()
repl = b'\xef\xbf\xbd'

old = (
    b'// Canvas click while locked ? fire (P1 only)\r\n'
    b'renderer.domElement.addEventListener("click", e => {\r\n'
    b'    if (e.button !== 0) return;  // left-click only ' + repl + b' RMB is ball-cam\r\n'
    b'    if (pointerLocked && !twoPlayerMode) {\r\n'
    b'        fireCannonball(parseFloat(document.getElementById("power").value));\r\n'
    b'    }\r\n'
    b'});'
)

new = (
    b'// Canvas click while locked -> fire (P1 only, non-minigun weapons)\r\n'
    b'renderer.domElement.addEventListener("click", e => {\r\n'
    b'    if (e.button !== 0) return;  // left-click only - RMB is ball-cam\r\n'
    b'    if (pointerLocked && !twoPlayerMode && currentWeapon !== 3) {\r\n'
    b'        fireCannonball(parseFloat(document.getElementById("power").value));\r\n'
    b'    }\r\n'
    b'});\r\n'
    b'\r\n'
    b'// Minigun: fire while mouse held\r\n'
    b"renderer.domElement.addEventListener('mousedown', e => {\r\n"
    b'    if (e.button !== 0 || !pointerLocked || twoPlayerMode) return;\r\n'
    b'    if (currentWeapon === 3) { minigunFiring = true; minigunNextFire = 0; }\r\n'
    b'});\r\n'
    b"renderer.domElement.addEventListener('mouseup', e => {\r\n"
    b'    if (e.button === 0) minigunFiring = false;\r\n'
    b'});'
)

if old in data:
    data = data.replace(old, new, 1)
    open('src/main.js', 'wb').write(data)
    print('replaced OK')
else:
    print('NOT FOUND - showing context:')
    idx = data.find(b'Canvas click while locked')
    print(repr(data[idx:idx+300]))
