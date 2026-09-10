#!/usr/bin/env python3
"""Synthesise the PLACEHOLDER interlude jingle: player/assets/interlude-placeholder.wav

Founder request (2026-09-10): a Foray must carry "the little jingle that we
want to use as an interlude between podcasts". No jingle asset existed anywhere
in the repo, so this script makes a stand-in the player can ship today. It is
deliberately modest — a warm four-note rising motif, nothing a listener would
mistake for the brand — and it is replaced, not tuned, the day the founders
supply the real one (see docs/curation/narration-craft.md § "The interlude
jingle (placeholder)").

Standard library only (`wave` + `math`): there is no ffmpeg and no audio
toolchain on the machines this repo is built on, and the repo root stays
dependency-free (CLAUDE.md § Layout). Deterministic: the same bytes every run,
so the committed file is reproducible and `player/interlude.test.js` can pin
its measured properties.

    python tools/audio/make-interlude-placeholder.py            # write the asset
    python tools/audio/make-interlude-placeholder.py --check    # verify it is current

What it makes, and why each number:
  - 44.1 kHz, stereo, 16-bit PCM WAV — the one format every <audio> element on
    every host decodes without a codec question, and small enough (< 600 KB) to
    commit.
  - 3.0 s total. generation-architecture.md §4.8 asks for "roughly 1-2 s"; the
    extra second is the tail of the last note ringing out under a fade, so the
    seam reads as a soft mark rather than a stab. Longer than the 2.0 s seam
    beat it replaces (player/seam-gap.js), by design — a beat and a jingle are
    alternatives, never both.
  - D major pentatonic arpeggio D4 F#4 A4 D5, staggered so the notes overlap
    and ring together like a small chime, plus the same notes an octave up at
    -14 dB for shimmer. Sine fundamental with a little triangle for warmth.
  - Peak normalised to -6 dBFS: audible against a podcast's dialogue level
    without being the loudest thing in the hour (segment-length-rules.md §2f —
    a seam is already a loudness event).
"""

import hashlib
import math
import os
import struct
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
OUT_PATH = os.path.join(ROOT, "player", "assets", "interlude-placeholder.wav")

SAMPLE_RATE = 44_100
CHANNELS = 2
SAMPLE_WIDTH = 2  # bytes -> 16-bit
DURATION_SEC = 3.0
PEAK_DBFS = -6.0
FADE_OUT_SEC = 0.45

# (frequency Hz, onset s, pan -1..1). D4, F#4, A4, D5 — a rising D major
# arpeggio, which is inside the D major pentatonic (D E F# A B).
NOTES = [
    (293.66, 0.00, -0.35),
    (369.99, 0.22, -0.12),
    (440.00, 0.44, 0.12),
    (587.33, 0.66, 0.35),
]
OCTAVE_UP_GAIN = 10 ** (-14 / 20)  # -14 dB shimmer
ATTACK_SEC = 0.018
DECAY_TAU_SEC = 0.62  # exponential decay time constant per note
TRIANGLE_MIX = 0.22


def triangle(phase):
    """Triangle wave, phase in cycles, amplitude -1..1."""
    p = phase - math.floor(phase)
    return 4.0 * abs(p - 0.5) - 1.0


def envelope(t):
    if t < 0:
        return 0.0
    if t < ATTACK_SEC:
        return t / ATTACK_SEC
    return math.exp(-(t - ATTACK_SEC) / DECAY_TAU_SEC)


def voice(freq, t):
    """One partial-rich note voice at time t (seconds since onset)."""
    ph = freq * t
    return math.sin(2 * math.pi * ph) * (1 - TRIANGLE_MIX) + triangle(ph) * TRIANGLE_MIX


def render():
    n = int(round(DURATION_SEC * SAMPLE_RATE))
    left = [0.0] * n
    right = [0.0] * n
    for freq, onset, pan in NOTES:
        lg = math.cos((pan + 1) * math.pi / 4)  # constant-power pan
        rg = math.sin((pan + 1) * math.pi / 4)
        start = int(onset * SAMPLE_RATE)
        for i in range(start, n):
            t = (i - start) / SAMPLE_RATE
            env = envelope(t)
            if env < 1e-5:
                continue
            s = voice(freq, t) + OCTAVE_UP_GAIN * voice(freq * 2, t)
            s *= env
            left[i] += s * lg
            right[i] += s * rg

    # Fade the whole thing out over the last FADE_OUT_SEC so the file ends at
    # silence and the element's `ended` never lands on a click.
    fade_n = int(FADE_OUT_SEC * SAMPLE_RATE)
    for k in range(fade_n):
        i = n - fade_n + k
        g = 0.5 * (1 + math.cos(math.pi * k / fade_n))  # raised cosine 1 -> 0
        left[i] *= g
        right[i] *= g
    # The last 10 ms are exactly zero.
    for i in range(n - int(0.010 * SAMPLE_RATE), n):
        left[i] = 0.0
        right[i] = 0.0

    peak = max(max(abs(v) for v in left), max(abs(v) for v in right))
    target = 10 ** (PEAK_DBFS / 20)
    gain = target / peak if peak > 0 else 0.0
    frames = bytearray()
    for i in range(n):
        l = max(-1.0, min(1.0, left[i] * gain))
        r = max(-1.0, min(1.0, right[i] * gain))
        frames += struct.pack("<hh", int(round(l * 32767)), int(round(r * 32767)))
    return bytes(frames)


def wav_bytes(frames):
    import io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(CHANNELS)
        w.setsampwidth(SAMPLE_WIDTH)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(frames)
    return buf.getvalue()


def main(argv):
    data = wav_bytes(render())
    digest = hashlib.sha256(data).hexdigest()
    if "--check" in argv:
        if not os.path.exists(OUT_PATH):
            print(f"FATAL: {OUT_PATH} is missing - run without --check to write it", file=sys.stderr)
            return 1
        with open(OUT_PATH, "rb") as f:
            on_disk = hashlib.sha256(f.read()).hexdigest()
        if on_disk != digest:
            print(f"FATAL: {OUT_PATH} is stale (disk {on_disk[:12]} vs generated {digest[:12]})", file=sys.stderr)
            return 1
        print(f"ok - {OUT_PATH} is current (sha256 {digest[:12]}, {len(data)} bytes, {DURATION_SEC} s)")
        return 0
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "wb") as f:
        f.write(data)
    print(f"wrote {OUT_PATH}: {len(data)} bytes, {DURATION_SEC} s, sha256 {digest[:12]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
