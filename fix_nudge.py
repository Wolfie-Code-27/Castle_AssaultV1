data = open('src/main.js', 'rb').read()

old = (
    b'                const nudge = 8; on exposed edge bricks.\r\n'
    b'                const nudge = 18;\r\n'
)

new = (
    b'                const nudge = 8;\r\n'
)

if old in data:
    data = data.replace(old, new, 1)
    open('src/main.js', 'wb').write(data)
    print('fixed OK')
else:
    print('NOT FOUND')
    idx = data.find(b'const nudge = 8')
    print(repr(data[idx:idx+100]))
