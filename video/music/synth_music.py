"""Synthesize a warm ambient-electronic underscore (200 s, 48 kHz stereo)."""
import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
DUR = 200.0
N = int(SR * DUR)
rng = np.random.default_rng(7)
BEAT = 60 / 96  # 0.625 s


def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)


# Chord voicings (MIDI). D4=62
CHORDS = {
    "Dmaj9": [50, 57, 62, 66, 69, 73, 76],   # D3 A3 D4 F#4 A4 C#5 E5
    "Bm7":   [47, 54, 62, 66, 69, 71, 74],   # B2 F#3 D4 F#4 A4 B4 D5
    "Gmaj7": [43, 50, 59, 62, 66, 67, 71],   # G2 D3 B3 D4 F#4 G4 B4
    "A6sus": [45, 52, 62, 64, 66, 69, 74],   # A2 E3 D4 E4 F#4 A4 D5
}
ROOT = {"Dmaj9": 38, "Bm7": 35, "Gmaj7": 31, "A6sus": 33}  # D2 B1 G1 A1
ARP = {  # arp pool (octave 4-5)
    "Dmaj9": [62, 66, 69, 73, 76, 78],
    "Bm7":   [59, 62, 66, 69, 71, 74],
    "Gmaj7": [59, 62, 66, 67, 71, 74],
    "A6sus": [62, 64, 66, 69, 71, 74],
}
cycle = ["Dmaj9", "Bm7", "Gmaj7", "A6sus"]
# (start, length, chord)
timeline = [(i * 8.0, 8.0, cycle[i % 4]) for i in range(22)]  # 0..176
timeline += [(176.0, 8.0, "A6sus"), (184.0, 16.0, "Dmaj9")]


def intensity(t):
    pts = [(0, 0.45), (10, 0.55), (40, 0.7), (118, 0.75), (150, 1.0),
           (176, 1.0), (186, 0.65), (200, 0.4)]
    x, y = zip(*pts)
    return np.interp(t, x, y)


def pan_gains(p):  # p in [-1,1], equal power
    a = (p + 1) * np.pi / 4
    return np.cos(a), np.sin(a)


L = np.zeros(N)
R = np.zeros(N)


def add(sig, start, p=0.0, gain=1.0):
    i0 = int(start * SR)
    if i0 >= N:
        return
    sig = sig[: N - i0]
    gl, gr = pan_gains(p)
    L[i0:i0 + len(sig)] += sig * gl * gain
    R[i0:i0 + len(sig)] += sig * gr * gain


# ---------------------------------------------------------------- PAD
def saw(freq, n, phase0):
    ph = (phase0 + freq * np.arange(n) / SR) % 1.0
    return 2 * ph - 1


pad_L = np.zeros(N)
pad_R = np.zeros(N)
ATT, REL = 2.5, 3.5
for (st, ln, name) in timeline:
    tot = ln + REL
    n = int(tot * SR)
    t = np.arange(n) / SR
    env = np.clip(t / ATT, 0, 1) ** 1.5
    env *= np.where(t < ln, 1.0, np.exp(-(t - ln) / (REL / 4)))
    seg_L = np.zeros(n)
    seg_R = np.zeros(n)
    for m in CHORDS[name]:
        f = mtof(m)
        for k, det in enumerate([-9, -4, 0, 4, 9]):  # cents
            fk = f * 2 ** (det / 1200)
            # slow vibrato per voice
            s = saw(fk, n, rng.random())
            p = (k - 2) / 2.0 * 0.8
            gl, gr = pan_gains(p)
            w = 1.0 / (1 + 0.012 * max(m - 43, 0) ** 1.2)
            seg_L += s * gl * w
            seg_R += s * gr * w
    # lowpass cutoff depends on intensity at this chord
    I = float(intensity(st + ln / 2))
    fc = 700 + 1900 * (I - 0.45) / 0.55
    sos = signal.butter(4, fc, fs=SR, output="sos")
    hp = signal.butter(2, 90, "hp", fs=SR, output="sos")
    seg_L = signal.sosfilt(hp, signal.sosfilt(sos, seg_L)) * env
    seg_R = signal.sosfilt(hp, signal.sosfilt(sos, seg_R)) * env
    i0 = int(st * SR)
    m_ = min(n, N - i0)
    pad_L[i0:i0 + m_] += seg_L[:m_]
    pad_R[i0:i0 + m_] += seg_R[:m_]

# slow filter "breathing": gentle amplitude swell
tt = np.arange(N) / SR
breath = 0.85 + 0.15 * np.sin(2 * np.pi * tt / 16.0)
pad_L *= breath
pad_R *= breath
pad_gain = 0.05
L += pad_L * pad_gain
R += pad_R * pad_gain * 1.0

# ---------------------------------------------------------------- FELT PIANO ARP
def felt(freq, vel, dur=2.5):
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    B = 0.0004
    for h in range(1, 9):
        fh = freq * h * np.sqrt(1 + B * h * h)
        if fh > 9000:
            break
        amp = (1.0 / h ** 1.6) * (0.6 + 0.4 * vel)
        tau = 1.4 / (1 + 0.9 * (h - 1)) * (1.0 if freq < 600 else 0.7)
        out += amp * np.exp(-t / tau) * np.sin(2 * np.pi * fh * t + rng.random())
    att = np.clip(t / 0.006, 0, 1)
    out *= att
    # felt: soft lowpass depending on velocity
    sos = signal.butter(2, 1500 + 2500 * vel, fs=SR, output="sos")
    out = signal.sosfilt(sos, out)
    # hammer thump
    th = rng.standard_normal(int(0.01 * SR)) * np.exp(-np.arange(int(0.01 * SR)) / (0.002 * SR))
    th = signal.sosfilt(signal.butter(2, 800, fs=SR, output="sos"), th) * 0.05
    out[: len(th)] += th
    return out * vel


pattern = [0, 2, 4, 1, 3, 5, 2, 4]
for (st, ln, name) in timeline:
    if st + ln < 10:
        continue
    pool = ARP[name]
    step = BEAT / 2
    nsteps = int(ln / step)
    for i in range(nsteps):
        t0 = st + i * step
        if t0 < 10.0:
            continue
        if t0 > 190:
            break
        I = float(intensity(t0))
        fade_in = np.clip((t0 - 10) / 8, 0, 1)
        # sparser early: skip some notes
        if t0 < 40 and i % 2 == 1 and i % 4 != 3:
            continue
        m = pool[pattern[i % 8]]
        vel = (0.55 + 0.25 * (i % 4 == 0) + rng.uniform(-0.08, 0.08)) * (0.6 + 0.4 * I)
        hum = rng.uniform(-0.008, 0.008)
        p = 0.45 * np.sin(i * 1.3)
        add(felt(mtof(m), vel), t0 + hum, p, 0.19 * fade_in)
        # build: 16th ghost notes in upper octave from 128 s
        if 128 <= t0 < 176:
            g = np.clip((t0 - 128) / 20, 0, 1)
            m2 = pool[pattern[(i + 3) % 8]] + 12
            add(felt(mtof(m2), 0.35), t0 + step / 2 + hum, -p, 0.08 * g)

# counter melody in the build (bell-ish high felt, half notes)
melody = [(128, 78), (132, 76), (136, 74), (140, 73), (144, 74), (148, 76),
          (152, 78), (156, 81), (160, 78), (164, 76), (168, 74), (172, 76),
          (176, 73), (180, 74), (184, 78)]
for (t0, m) in melody:
    add(felt(mtof(m), 0.6, dur=3.5), t0, 0.15, 0.12)
    add(felt(mtof(m + 12), 0.3, dur=2.5), t0 + 0.004, -0.2, 0.02)

# --------------------------------------------------------------- SUB BASS
for (st, ln, name) in timeline:
    if st < 24:
        continue
    f = mtof(ROOT[name] + 12) if ROOT[name] < 36 else mtof(ROOT[name])
    f = mtof(ROOT[name] + 12)  # D3/B2/G2/A2 region is too high; use root octave 2
    f = f / 2  # back to D2 etc
    nb = int(ln / BEAT)
    for b in range(nb):
        t0 = st + b * BEAT
        if t0 > 192:
            break
        n = int(BEAT * 1.4 * SR)
        t = np.arange(n) / SR
        env = np.clip(t / 0.03, 0, 1) * np.exp(-t / 0.35)
        s = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t)
        s = np.tanh(1.5 * s) / np.tanh(1.5)
        acc = 1.0 if b % 2 == 0 else 0.7
        I = float(intensity(t0))
        g = np.clip((t0 - 24) / 16, 0, 1) * (0.5 + 0.5 * I)
        add(s * env * acc, t0, 0.0, 0.10 * g)

# ---------------------------------------------------------------- SHIMMER
noise = rng.standard_normal((2, N))
sos = signal.butter(4, [5000, 12000], "bp", fs=SR, output="sos")
sh = signal.sosfilt(sos, noise, axis=1)
shimmer_env = 0.012 * (0.5 + 0.5 * np.sin(2 * np.pi * tt / 11.0)) * (intensity(tt) ** 2)
L += sh[0] * shimmer_env
R += sh[1] * shimmer_env
# high sine partials (octave-up chord tones), slow tremolo
for (st, ln, name) in timeline:
    n = int((ln + 3) * SR)
    t = np.arange(n) / SR
    env = np.clip(t / 3, 0, 1) * np.where(t < ln, 1, np.exp(-(t - ln) / 0.8))
    for j, m in enumerate(CHORDS[name][-3:]):
        f = mtof(m + 24)
        trem = 0.5 + 0.5 * np.sin(2 * np.pi * (0.2 + 0.07 * j) * t + j)
        s = np.sin(2 * np.pi * f * t) * trem * env
        I = float(intensity(st))
        add(s, st, (-0.7, 0.0, 0.7)[j], 0.007 * I)

# ---------------------------------------------------------------- RISER into climax
rn = int(8 * SR)
t = np.arange(rn) / SR
rs = rng.standard_normal((2, rn))
out = []
for ch in range(2):
    y = np.zeros(rn)
    blk = 2400
    for k in range(0, rn, blk):
        fc = 400 + 5000 * (k / rn) ** 2
        so = signal.butter(2, [fc * 0.7, fc * 1.3], "bp", fs=SR, output="sos")
        y[k:k + blk] = signal.sosfilt(so, rs[ch, k:k + blk])
    out.append(y)
renv = (t / 8) ** 2.5 * np.clip((8 - t) / 0.3, 0, 1)
add(out[0] * renv, 144.0, -0.3, 0.05)
add(out[1] * renv, 144.0, 0.3, 0.05)

# master dynamic arc (pre-reverb): quiet intro, lift through build
G = intensity(tt) ** 1.1
L *= G
R *= G

# ---------------------------------------------------------------- REVERB
ir_len = int(4.5 * SR)
ti = np.arange(ir_len) / SR
irs = []
for ch in range(2):
    nz = rng.standard_normal(ir_len)
    # frequency-dependent damping: blend bright early / dark late
    dark = signal.sosfilt(signal.butter(2, 1800, fs=SR, output="sos"), nz)
    mix = np.exp(-ti / 0.6)
    nz = nz * mix + dark * (1 - mix) * 1.6
    ir = nz * np.exp(-ti * 6.9 / 3.8)  # RT60 ~3.8 s
    ir[: int(0.02 * SR)] *= np.linspace(0, 1, int(0.02 * SR))  # pre-delay-ish
    ir /= np.sqrt(np.sum(ir ** 2))
    irs.append(ir)
wetL = signal.oaconvolve(L, irs[0])[:N]
wetR = signal.oaconvolve(R, irs[1])[:N]
# multi-tap dotted-8th delay on arp region is implicit in reverb; add subtle ping-pong
d = int(BEAT * 0.75 * SR)
dl = np.zeros(N); dr = np.zeros(N)
dl[d:] = R[:-d] * 0.18
dr[2 * d:] = L[:-2 * d] * 0.14
mixL = L * 0.75 + wetL * 0.55 + dl
mixR = R * 0.75 + wetR * 0.55 + dr

# ---------------------------------------------------------------- MASTER
# mid/side widen a touch
M = (mixL + mixR) / 2
S = (mixL - mixR) / 2
S *= 1.25
mixL, mixR = M + S, M - S
# gentle high-shelf-ish air and DC removal
hp = signal.butter(2, 25, "hp", fs=SR, output="sos")
mixL = signal.sosfilt(hp, mixL)
mixR = signal.sosfilt(hp, mixR)
# low-mid de-mud: RBJ peaking EQ -3.5 dB @ 280 Hz, +2 dB air shelf-ish @ 8k
def peq(x, f0, gdb, q):
    A = 10 ** (gdb / 40); w = 2 * np.pi * f0 / SR; al = np.sin(w) / (2 * q)
    b = [1 + al * A, -2 * np.cos(w), 1 - al * A]; a = [1 + al / A, -2 * np.cos(w), 1 - al / A]
    return signal.lfilter(b, a, x)
mixL = peq(peq(mixL, 280, -3.5, 0.8), 9000, 2.5, 0.7)
mixR = peq(peq(mixR, 280, -3.5, 0.8), 9000, 2.5, 0.7)
# fades
fi = np.clip(tt / 3.0, 0, 1) ** 2
fo = np.clip((DUR - tt) / 10.0, 0, 1) ** 2
mixL *= fi * fo
mixR *= fi * fo
st = np.stack([mixL, mixR], axis=1)
st /= np.max(np.abs(st)) / 0.7
wavfile.write("music_raw.wav", SR, st.astype(np.float32))
print("written", st.shape)
