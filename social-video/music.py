# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "numpy>=1.26",
#   "scipy>=1.11",
#   "soundfile>=0.12",
# ]
# ///
"""Synthesise the getting-started video's background track: build/music.wav.

Generated from code rather than sourced, so there is no licence to track. An upbeat 120 BPM
electronic track in A minor (Am - F - C - G): four-on-the-floor kick, claps, 16th hats, a
pumping supersaw pad, a driving offbeat bass and a plucky arpeggio with echo. It follows
build/timeline.json so the energy lands on the story:

  intro     filtered pad + riser, then the beat drops as the first scene cuts in
  claude    the arpeggio enters when the AI assistants appear
  modelling breakdown (no kick) while the assistant "thinks", riser into the next scene
  writes    full drop again as the model is written
  verify    impact on "checks its own work"
  end       final hit, the chord rings out

Deterministic: the same timeline always produces the same file. encode.sh ducks it under the
narration and normalises the mix.

    uv run music.py            # writes build/music.wav
"""
import json
import pathlib

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt

HERE = pathlib.Path(__file__).parent
SR = 48000
BPM = 120
BEAT = 60 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(11)

# (bass root, pad voicing) as MIDI; one chord per bar, the progression loops.
CHORDS = [
    (45, [57, 60, 64, 69]),  # Am
    (41, [57, 60, 65, 69]),  # F
    (48, [55, 60, 64, 67]),  # C
    (43, [55, 59, 62, 67]),  # G
]
ARP = [0, 1, 2, 3, 2, 1, 2, 3, 0, 2, 1, 3, 2, 3, 1, 2]


def hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def lp(x, cutoff, order=2):
    return sosfilt(butter(order, cutoff, 'low', fs=SR, output='sos'), x)


def hp(x, cutoff, order=2):
    return sosfilt(butter(order, cutoff, 'high', fs=SR, output='sos'), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], 'band', fs=SR, output='sos'), x)


def saw(f, t, phase=0.0):
    return 2.0 * ((f * t + phase) % 1.0) - 1.0


def env_exp(n, decay, attack=0.002):
    t = np.arange(n) / SR
    e = np.exp(-t / decay)
    a = max(1, int(attack * SR))
    e[:a] *= np.linspace(0, 1, a)
    return e


def add(buf, start, sig, gain=1.0):
    i = int(round(start * SR))
    if i >= len(buf) or i + len(sig) <= 0:
        return
    s0 = max(0, -i)
    i = max(0, i)
    j = min(len(buf), i + len(sig) - s0)
    buf[i:j] += gain * sig[s0 : s0 + (j - i)]


def kick():
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 45 + 110 * np.exp(-t / 0.035)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.28)
    click = hp(rng.standard_normal(n), 2000) * np.exp(-t / 0.004) * 0.25
    return np.tanh(1.6 * (body + click))


def clap():
    n = int(0.35 * SR)
    noise = bp(rng.standard_normal(n), 900, 5000)
    e = np.zeros(n)
    for k, off in enumerate((0.0, 0.011, 0.022)):
        i = int(off * SR)
        e[i:] += env_exp(n - i, 0.012 if k < 2 else 0.14)
    return noise * e * 0.6


def hat(open_=False):
    n = int((0.22 if open_ else 0.06) * SR)
    return hp(rng.standard_normal(n), 7000) * env_exp(n, 0.07 if open_ else 0.018)


def riser(dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    # brighten over time: blend a dark and a bright band, then swell
    x = (1 - t / dur) * bp(noise, 300, 1500) + (t / dur) * bp(noise, 2000, 9000)
    sweep = np.sin(2 * np.pi * np.cumsum(200 + 1400 * (t / dur) ** 2) / SR) * 0.25
    return (x + sweep) * (t / dur) ** 2.2


def impact():
    n = int(2.5 * SR)
    t = np.arange(n) / SR
    boom = np.sin(2 * np.pi * np.cumsum(35 + 80 * np.exp(-t / 0.08)) / SR) * np.exp(-t / 0.7)
    crash = hp(rng.standard_normal(n), 3000) * np.exp(-t / 0.9) * 0.35
    return boom + crash


# A supplied track, when present, replaces the synthesised one. It must be one whose licence
# allows redistribution in a public repo and product (the current one is the maintainer's own).
SUPPLIED = [HERE / 'music' / f'background.{ext}' for ext in ('m4a', 'mp3', 'wav', 'flac')]
# Loudness the rest of the pipeline is tuned for (encode.sh's steady bed level assumes it).
TARGET_LUFS = -14.5


def from_supplied(src: pathlib.Path, total: float) -> None:
    """Trim the supplied track to the video, fade it in and out, and level it to TARGET_LUFS."""
    import subprocess
    import re
    out = HERE / 'build' / 'music.wav'
    raw = HERE / 'build' / 'music.raw.wav'
    fade_out = 4.0
    subprocess.run([
        'ffmpeg', '-v', 'error', '-y', '-i', str(src), '-t', f'{total:.3f}',
        '-af', f'afade=t=in:d=0.5,afade=t=out:st={max(0.0, total - fade_out):.3f}:d={fade_out}',
        '-ac', '1', '-ar', str(SR), str(raw),
    ], check=True)
    # Measure, then apply one exact gain (one-pass loudnorm undershoots on dense tracks and
    # would also reshape the track's own dynamics).
    meter = subprocess.run(['ffmpeg', '-nostats', '-i', str(raw), '-af', 'ebur128', '-f', 'null', '-'],
                           capture_output=True, text=True).stderr
    measured = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', meter)[-1])
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(raw), '-af',
                    f'volume={TARGET_LUFS - measured:.2f}dB,alimiter=limit=0.95', str(out)], check=True)
    raw.unlink()
    print(f'music: {out} ({total:.2f} s, from {src.relative_to(HERE)})')


def main() -> None:
    tl = json.loads((HERE / 'build' / 'timeline.json').read_text())
    total = tl['total']
    supplied = next((p for p in SUPPLIED if p.exists()), None)
    generator = HERE / 'music' / 'synth_music.py'
    if not supplied and generator.exists():
        # The maintainer's own "demo audio kit" underscore (part 1: warm ambient, D major,
        # 96 BPM). It writes music_raw.wav (200 s, stereo) into its working directory.
        import subprocess
        import sys
        subprocess.run([sys.executable, str(generator)], cwd=HERE / 'build', check=True)
        supplied = HERE / 'build' / 'music_raw.wav'
    if supplied:
        from_supplied(supplied, total)
        return
    starts = {s['id']: s['start'] for s in tl['scenes']}
    drop = starts.get('two-ways', 6.7)
    arp_in = starts.get('claude', 26.6)
    brk_a, brk_b = starts.get('modelling', 67.9), starts.get('writes', 81.3)
    verify = starts.get('verify', 90.1)
    end = starts.get('end', 110.6)

    grid0 = drop - BAR * np.floor(drop / BAR)  # a downbeat lands exactly on the drop
    n = int((total + 3) * SR)
    drums, bass, pad, arp, fx = (np.zeros(n) for _ in range(5))
    pump = np.ones(n)
    K, C = kick(), clap()

    def beat_on(t):  # full beat between the drop and the end card, minus the breakdown
        return drop <= t < end and not (brk_a <= t < brk_b - 0.01)

    bar_i = 0
    t_bar = grid0 - BAR  # one pickup bar of pad before the first downbeat
    while t_bar < total:
        root, voicing = CHORDS[bar_i % len(CHORDS)]
        # ---- pad: supersaw chord, one bar, gentle swell -------------------------------
        m = int((BAR + 0.6) * SR)
        t = np.arange(m) / SR
        chord = np.zeros(m)
        for note in voicing:
            for cents in (-12, -5, 0, 5, 12):
                chord += saw(hz(note) * 2 ** (cents / 1200), t, rng.random())
        e = np.minimum(1, t / 0.05) * np.where(t > BAR, np.exp(-(t - BAR) / 0.15), 1)
        add(pad, t_bar, chord * e * 0.035)
        # ---- per-beat material ------------------------------------------------------
        for b in range(4):
            tb = t_bar + b * BEAT
            if beat_on(tb):
                add(drums, tb, K, 0.85)
                ki = int(tb * SR)
                if 0 <= ki < n:  # sidechain pump on pad + bass
                    L = min(n - ki, int(BEAT * SR))
                    tt = np.arange(L) / SR
                    pump[ki : ki + L] = np.minimum(pump[ki : ki + L], 1 - 0.7 * np.exp(-tt / 0.09))
                if b in (1, 3):
                    add(drums, tb, C, 0.45)
            if drop - BAR <= tb < end:  # hats run from a bar before the drop, breakdown too
                for s in range(4):
                    ts = tb + s * BEAT / 4 + rng.normal(0, 0.002)
                    add(drums, ts, hat(open_=(s == 2)), 0.10 if s == 2 else 0.06 + 0.03 * (s == 0))
            if beat_on(tb):  # offbeat pumping bass: 8ths, accent on the "and"
                for s in range(2):
                    ts = tb + s * BEAT / 2
                    L = int(0.2 * SR)
                    tt = np.arange(L) / SR
                    f = hz(root - 12)
                    tone = lp(saw(f, tt) + 0.6 * np.sin(2 * np.pi * f / 2 * tt), 900)
                    add(bass, ts, tone * env_exp(L, 0.12, 0.004), 0.30 if s == 1 else 0.20)
        # ---- arpeggio: 16ths from the assistants scene on (also through the breakdown) --
        if arp_in <= t_bar + BAR and t_bar < end:
            for s in range(16):
                ts = t_bar + s * BEAT / 4
                if ts < arp_in or ts >= end:
                    continue
                note = voicing[ARP[s] % len(voicing)] + 12
                L = int(0.25 * SR)
                tt = np.arange(L) / SR
                f = hz(note)
                tone = np.sin(2 * np.pi * f * tt) + 0.35 * np.sign(np.sin(2 * np.pi * f * tt)) * 0.5
                add(arp, ts, tone * env_exp(L, 0.07, 0.002), 0.07 * (1.15 if s % 4 == 0 else 1))
        t_bar += BAR
        bar_i += 1

    # ---- transitions ---------------------------------------------------------------
    add(fx, drop - 3.0, riser(3.0), 0.30)
    add(fx, drop, impact(), 0.40)
    add(fx, brk_b - 2.0, riser(2.0), 0.28)
    add(fx, brk_b, impact(), 0.30)
    add(fx, verify, impact(), 0.40)
    add(fx, end, impact(), 0.55)
    for sid, t0 in starts.items():  # a soft whoosh on every other scene change
        if sid not in ('intro', 'two-ways', 'writes', 'verify', 'end') and t0 > 1:
            add(fx, t0 - 0.6, riser(0.6), 0.12)

    # Intro: the pad starts muffled and opens up into the drop.
    dark, bright = lp(pad, 700), lp(pad, 4500)
    tt = np.arange(n) / SR
    open_amt = np.clip((tt - 0.0) / max(0.1, drop), 0, 1) ** 2
    pad_f = dark * (1 - open_amt) + bright * open_amt
    # Breakdown: pad a little darker and without the pump.
    brk = (tt >= brk_a) & (tt < brk_b)
    pad_f = np.where(brk, lp(pad, 2200), pad_f)
    pad_f *= np.where(brk, 1.0, pump)
    bass *= pump

    # Echo on the arp (dotted-8th), plus a shared synthetic room on pad + arp.
    d = int(0.75 * BEAT * SR)
    echo = arp.copy()
    for k, g in enumerate((0.45, 0.25, 0.12), start=1):
        echo[k * d :] += g * lp(arp, 3500)[: n - k * d]
    ir_t = np.arange(int(1.8 * SR)) / SR
    ir = lp(rng.standard_normal(len(ir_t)), 6000) * np.exp(-ir_t / 0.45)
    ir /= np.sqrt(np.sum(ir ** 2))
    send = pad_f * 0.6 + echo
    size = 1 << int(np.ceil(np.log2(n + len(ir))))
    room = np.fft.irfft(np.fft.rfft(send, size) * np.fft.rfft(ir, size), size)[:n]

    mix = drums + bass + pad_f + echo + 0.25 * room + fx
    # After the end hit only the tail rings: fade everything out over the last seconds.
    mix = mix[: int(total * SR)]
    fi, fo = int(0.8 * SR), int(3.0 * SR)
    mix[:fi] *= np.linspace(0, 1, fi)
    mix[-fo:] *= np.linspace(1, 0, fo) ** 1.5
    mix = np.tanh(1.2 * mix / max(1e-9, np.max(np.abs(mix)))) # gentle glue
    mix *= 10 ** (-1 / 20) / max(1e-9, np.max(np.abs(mix)))

    out = HERE / 'build' / 'music.wav'
    sf.write(out, mix.astype(np.float32), SR, subtype='PCM_16')
    print(f'music: {out} ({total:.2f} s, {BPM} BPM, drop at {drop:.2f} s)')


if __name__ == '__main__':
    main()
