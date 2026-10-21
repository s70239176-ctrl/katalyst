"""Generate an original ambient/electronic soundtrack (no samples, no third-party music)."""
import numpy as np
from scipy.io import wavfile

SR = 44100
BPM = 92
DUR = 190.0
beat = 60.0 / BPM
n = int(DUR * SR)
t = np.arange(n) / SR
L = np.zeros(n)
R = np.zeros(n)

def hz(midi): return 440.0 * 2 ** ((midi - 69) / 12)

# Am - F - C - G, two bars each (8 beats)
CHORDS = [
    (57, [57, 60, 64, 67]),   # Am7
    (53, [53, 57, 60, 64]),   # Fmaj7
    (48, [48, 52, 55, 59]),   # Cmaj7
    (55, [55, 59, 62, 65]),   # G7sus-ish
]
chord_len = 8 * beat

def env_adsr(length, a, r):
    m = int(length * SR)
    e = np.ones(m)
    ai, ri = int(a * SR), int(r * SR)
    if ai: e[:ai] = np.linspace(0, 1, ai) ** 1.5
    if ri: e[-ri:] *= np.linspace(1, 0, ri) ** 1.5
    return e

def add(buf, start, sig, gain=1.0):
    i = int(start * SR)
    j = min(n, i + len(sig))
    if i < n: buf[i:j] += sig[: j - i] * gain

rng = np.random.default_rng(7)

# ---- pad: detuned additive saw-ish voices, slow attack ----
def pad_voice(f, length):
    tt = np.arange(int(length * SR)) / SR
    s = np.zeros_like(tt)
    for det in (-0.07, 0.0, 0.07):
        ff = f * 2 ** (det / 12)
        for h in range(1, 7):
            s += np.sin(2 * np.pi * ff * h * tt + rng.uniform(0, 6.28)) / (h ** 1.35)
    # slow tremolo
    s *= 0.85 + 0.15 * np.sin(2 * np.pi * 0.17 * tt)
    return s * env_adsr(length, 1.6, 2.2)

# ---- plucks ----
def pluck(f, length=0.9):
    tt = np.arange(int(length * SR)) / SR
    s = np.sin(2 * np.pi * f * tt) + 0.5 * np.sin(2 * np.pi * 2 * f * tt) * np.exp(-tt * 9) + 0.25 * np.sin(2 * np.pi * 3 * f * tt) * np.exp(-tt * 14)
    return s * np.exp(-tt * 6.5) * (1 - np.exp(-tt * 400))

def kick(length=0.35):
    tt = np.arange(int(length * SR)) / SR
    f = 48 + 90 * np.exp(-tt * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-tt * 9)

def hat(length=0.06):
    tt = np.arange(int(length * SR)) / SR
    x = rng.standard_normal(len(tt)) * np.exp(-tt * 80)
    return np.diff(x, prepend=0)  # crude highpass

total_chords = int(DUR / chord_len) + 1
for ci in range(total_chords):
    root, notes = CHORDS[ci % 4]
    start = ci * chord_len
    # pad (three chord tones, spread in stereo)
    for k, m in enumerate(notes[:3]):
        v = pad_voice(hz(m + 12), chord_len + 1.5)
        pan = (-0.35, 0.0, 0.35)[k]
        add(L, start, v, 0.060 * (1 - pan))
        add(R, start, v, 0.060 * (1 + pan))
    # bass: root, half notes
    for b in range(0, 8, 2):
        tt = np.arange(int(1.7 * beat * SR)) / SR
        bs = np.sin(2 * np.pi * hz(root - 12) * tt) * np.exp(-tt * 1.6) * (1 - np.exp(-tt * 60))
        add(L, start + b * beat, bs, 0.16)
        add(R, start + b * beat, bs, 0.16)
    # arpeggio enters after 2 chords
    if ci >= 2:
        pattern = [0, 2, 3, 1, 3, 2, 1, 2]
        for step in range(16):
            tone = notes[pattern[step % 8]] + 12 * (1 + (step // 8) % 2)
            ts = start + step * beat / 2
            pl = pluck(hz(tone))
            pan = np.sin(step * 0.7) * 0.4
            add(L, ts, pl, 0.085 * (1 - pan))
            add(R, ts, pl, 0.085 * (1 + pan))
    # gentle pulse from chord 4
    if ci >= 4:
        for b in range(8):
            if b % 2 == 0:
                k = kick(); add(L, start + b * beat, k, 0.22); add(R, start + b * beat, k, 0.22)
            h = hat(); add(L, start + (b + 0.5) * beat, h, 0.05); add(R, start + (b + 0.5) * beat, h, 0.05)

# ---- echo / space ----
def echo(x, delay, fb, mix):
    d = int(delay * SR)
    y = x.copy()
    for k in range(1, 5):
        y[k * d:] += x[: n - k * d] * (fb ** k) * mix
    return y

L = echo(L, beat * 0.75, 0.45, 0.6)
R = echo(R, beat * 0.75 * 1.05, 0.45, 0.6)

# master: fades and soft limiting
fade_in, fade_out = int(3.0 * SR), int(6.0 * SR)
m = np.ones(n)
m[:fade_in] = np.linspace(0, 1, fade_in)
m[-fade_out:] = np.linspace(1, 0, fade_out)
L *= m; R *= m
peak = max(np.abs(L).max(), np.abs(R).max())
L, R = np.tanh(L / peak * 1.4) * 0.8, np.tanh(R / peak * 1.4) * 0.8
out = (np.stack([L, R], axis=1) * 32767).astype(np.int16)
wavfile.write(r'C:\Users\User\AppData\Local\Temp\kt-demo\music.wav', SR, out)
print('music ok', len(out) / SR)
