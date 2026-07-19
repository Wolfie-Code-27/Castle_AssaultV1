with open('src/main.js', 'rb') as f:
    data = f.read()

marker = b'// Real Wilhelm scream fetched from Wikimedia Commons'
idx = data.find(marker)
if idx == -1:
    print('marker not found')
    exit(1)

minigun_fn = b'''
function playMinigunShot() {
    const ctx = getAudio(), sr = ctx.sampleRate, now = ctx.currentTime;
    // Short sharp mechanical crack
    const N = Math.floor(sr * 0.06);
    const buf = ctx.createBuffer(1, N, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < N; i++) {
        const t = i / sr;
        // Transient click + noise tail
        const env = Math.exp(-t * 90) + Math.exp(-t * 30) * 0.4;
        d[i] = ((Math.random() * 2 - 1) * 0.8 + Math.sin(2 * Math.PI * 1800 * t) * 0.2) * env;
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 800;
    const gain = ctx.createGain(); gain.gain.value = 0.55;
    src.connect(hp); hp.connect(gain); gain.connect(ctx.destination);
    src.start(now);
}

'''

data = data[:idx] + minigun_fn + data[idx:]
with open('src/main.js', 'wb') as f:
    f.write(data)
print('Done OK')
