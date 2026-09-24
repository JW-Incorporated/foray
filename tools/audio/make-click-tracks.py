#!/usr/bin/env python3
"""Synthesise the NE-25a click tracks: the fixtures the native engine's in-point
and out-point are measured against (docs/native-engine-plan.md, card NE-25a).

    pip install lameenc==1.8.4                     # the one non-stdlib piece (MP3 only)
    python tools/audio/make-click-tracks.py         # write the fixtures + descriptor
    python tools/audio/make-click-tracks.py --check # verify they are current

WHY A CLICK TRACK. A tone tells you playback is happening; it cannot tell you
WHERE in the file playback is. A click every second, with a double click every
ten, is a ruler printed into the audio itself: an MTAudioProcessingTap that sees
the double click knows which ten-second mark it is at, independent of what
AVFoundation believes the time is. That independence is the whole point. An
approximate seek into a VBR MP3 with no table of contents lands at a byte offset
AVFoundation estimated, then REPORTS the time it was asked for. `currentTime`
agrees with itself; only the content can say it is wrong.

WHAT IT MAKES (every number is in click-tracks.json, which the Swift tests and
tools/audio/click-tracks.test.mjs both read, so nothing is restated by hand):

  - The ruler: a 1 ms click (one cycle of a 1 kHz sine, peak 0.8) at every whole
    second from 1 to the file's last whole second. At every multiple of ten a
    second click follows 50 ms later: the double click. Second 0 is silent so no
    click sits on the file's first sample, where encoder delay and a decoder's
    priming would blur it.
  - click-cbr.mp3        16 kHz mono MPEG-2 Layer III, CBR 16 kbps, no header
                         frame. The easy case: time = bytes / constant rate.
  - click-vbr-xing.mp3   the SAME audio frames as the next file, preceded by a
                         Xing header frame with frame count, byte count and a
                         100-entry TOC: the case a well-behaved podcast VBR file is.
  - click-vbr-notoc.mp3  VBR with no Xing/Info/VBRI frame at all: the case where
                         an approximate seek has only an average bitrate to go on.
  - click.wav            8 kHz mono unsigned 8-bit PCM, 60 s. Sample-exact, no
                         codec: the control every MP3 result is read against.

  The card caps the whole set at 1 MB. The MP3s are 90 s as the card asks, and
  16 kHz (one 576-sample frame is 36 ms) to stay small. The WAV is what does not
  fit: even at 8 kHz and 8 bits, 90 s is 720 KB, which with the three MP3s
  (484 KB) is 1.2 MB. So the WAV is 60 s (480 KB, 964 KB in all) at a standard
  telephony rate, rather than 90 s at an odd one (4-5 kHz) that AVFoundation
  would have to be trusted to resample. Every in-point and out-point the tests
  use on it is inside 60 s; the descriptor carries each file's duration.

  The two VBR files share their audio frames byte for byte, so any difference
  between them is the TOC's doing, not the encoder's.

NOT STANDARD LIBRARY, AND WHY THAT IS ACCEPTABLE. There is no MP3 encoder in
Python's standard library, and no ffmpeg on the machines this repo is written
on (make-interlude-placeholder.py says the same). `lameenc` is a pip wheel with
LAME statically linked, used only here, never at runtime, and never by CI: CI
reads the committed bytes. LAME is deterministic for a given version and
settings, so `--check` is exact. It writes raw frames and no tag frame, which is
exactly what the CBR and no-TOC files need; the Xing frame is built below, from
the spec, over the encoded frames.
"""

import hashlib
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(
    ROOT, "mobile", "plugins", "foray-audio", "ios", "Tests", "ForayAudioPluginTests", "Fixtures", "ClickTracks"
)
DESCRIPTOR = "click-tracks.json"
LAMEENC_VERSION = "1.8.4"

MP3_DURATION_SEC = 90
WAV_DURATION_SEC = 60
DOUBLE_EVERY_SEC = 10
DOUBLE_GAP_SEC = 0.050
CLICK_LENGTH_SEC = 0.001
CLICK_FREQ_HZ = 1000.0
CLICK_PEAK = 0.8

MP3_SAMPLE_RATE = 16_000
MP3_CBR_KBPS = 16
MP3_VBR_QUALITY = 4  # LAME -V4
WAV_SAMPLE_RATE = 8_000

# MPEG-2 Layer III, 16 kHz, mono (the only layout lameenc is asked for here).
MPEG2_L3_BITRATES_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
MPEG2_SAMPLE_RATES = [22050, 24000, 16000, 0]
SAMPLES_PER_FRAME = 576
MONO_SIDE_INFO_BYTES = 9  # MPEG-2 mono side info: where a Xing tag starts after the 4-byte header


def click_onsets(duration_sec):
    """The onset, in seconds, of every click in the ruler: 1..duration-1, plus
    the second click of each double."""
    onsets = []
    for s in range(1, duration_sec):
        onsets.append(float(s))
        if s % DOUBLE_EVERY_SEC == 0:
            onsets.append(s + DOUBLE_GAP_SEC)
    return onsets


def render(sample_rate, duration_sec):
    """The ruler as floats in -1..1 at `sample_rate`."""
    n = duration_sec * sample_rate
    out = [0.0] * n
    click_n = int(round(CLICK_LENGTH_SEC * sample_rate))
    for onset in click_onsets(duration_sec):
        start = int(round(onset * sample_rate))
        for k in range(click_n):
            out[start + k] = CLICK_PEAK * math.sin(2 * math.pi * CLICK_FREQ_HZ * k / sample_rate)
    return out


def pcm16(samples):
    return b"".join(struct.pack("<h", int(round(max(-1.0, min(1.0, v)) * 32767))) for v in samples)


def wav_u8(samples, sample_rate):
    """A plain RIFF/WAVE, PCM unsigned 8-bit mono. Written by hand (not `wave`)
    so the 44-byte header layout the node test parses is the only layout."""
    data = bytes(max(0, min(255, int(round(128 + v * 127)))) for v in samples)
    fmt = struct.pack("<HHIIHH", 1, 1, sample_rate, sample_rate, 1, 8)
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(data)) + data
    return b"RIFF" + struct.pack("<I", len(body)) + body


def encode_mp3(samples, vbr):
    try:
        import lameenc
    except ImportError:
        sys.exit(f"FATAL: pip install lameenc=={LAMEENC_VERSION} (MP3 encoding only; see this file's header)")
    enc = lameenc.Encoder()
    enc.silence()
    enc.set_channels(1)
    enc.set_in_sample_rate(MP3_SAMPLE_RATE)
    enc.set_out_sample_rate(MP3_SAMPLE_RATE)
    enc.set_quality(2)
    if vbr:
        enc.set_vbr(4)  # vbr_mtrh, LAME's default VBR mode
        enc.set_vbr_quality(MP3_VBR_QUALITY)
    else:
        enc.set_bit_rate(MP3_CBR_KBPS)
    return bytes(enc.encode(pcm16(samples)) + enc.flush())


def split_frames(data):
    """Byte offsets and lengths of every MPEG-2 L3 frame; raises on anything else."""
    frames = []
    i = 0
    while i < len(data):
        h = data[i : i + 4]
        if len(h) < 4 or h[0] != 0xFF or (h[1] & 0xFE) != 0xF2:
            raise ValueError(f"not an MPEG-2 Layer III frame header at byte {i}: {h.hex()}")
        kbps = MPEG2_L3_BITRATES_KBPS[h[2] >> 4]
        rate = MPEG2_SAMPLE_RATES[(h[2] >> 2) & 3]
        pad = (h[2] >> 1) & 1
        size = 72 * kbps * 1000 // rate + pad
        frames.append((i, size, kbps))
        i += size
    return frames


def xing_frame(audio):
    """A Xing header frame for `audio` (the encoded frames it will precede).

    32 kbps is the smallest MPEG-2 16 kHz frame (144 bytes) that holds the tag:
    4 header + 9 side info + "Xing" + flags + frames + bytes + 100-byte TOC =
    129. The TOC maps percent-of-duration to byte position / file size * 256,
    counting the header frame itself in the byte total, as the spec does."""
    frames = split_frames(audio)
    frame_bytes = 72 * 32 * 1000 // MP3_SAMPLE_RATE
    total = frame_bytes + len(audio)
    toc = bytearray()
    for pct in range(100):
        idx = min(len(frames) - 1, int(pct / 100 * len(frames)))
        toc.append(min(255, int((frame_bytes + frames[idx][0]) * 256 / total)))
    header = bytes([0xFF, 0xF3, (4 << 4) | (2 << 2), 0xC4])  # 32 kbps, 16 kHz, mono, "original"
    tag = b"Xing" + struct.pack(">III", 0x0007, len(frames), total) + bytes(toc)
    frame = header + bytes(MONO_SIDE_INFO_BYTES) + tag
    return frame + bytes(frame_bytes - len(frame))


def build():
    mp3_pcm = render(MP3_SAMPLE_RATE, MP3_DURATION_SEC)
    cbr = encode_mp3(mp3_pcm, vbr=False)
    vbr = encode_mp3(mp3_pcm, vbr=True)
    files = {
        "click-cbr.mp3": (cbr, {"kind": "mp3-cbr", "durationSec": MP3_DURATION_SEC, "sampleRate": MP3_SAMPLE_RATE, "bitrateKbps": MP3_CBR_KBPS, "header": "none"}),
        "click-vbr-xing.mp3": (xing_frame(vbr) + vbr, {"kind": "mp3-vbr-xing", "durationSec": MP3_DURATION_SEC, "sampleRate": MP3_SAMPLE_RATE, "vbrQuality": MP3_VBR_QUALITY, "header": "xing-toc"}),
        "click-vbr-notoc.mp3": (vbr, {"kind": "mp3-vbr-notoc", "durationSec": MP3_DURATION_SEC, "sampleRate": MP3_SAMPLE_RATE, "vbrQuality": MP3_VBR_QUALITY, "header": "none"}),
        "click.wav": (wav_u8(render(WAV_SAMPLE_RATE, WAV_DURATION_SEC), WAV_SAMPLE_RATE), {"kind": "wav-pcm-u8", "durationSec": WAV_DURATION_SEC, "sampleRate": WAV_SAMPLE_RATE, "header": "riff"}),
    }
    descriptor = {
        "//": "Written by tools/audio/make-click-tracks.py; read by ClickTrackFixture.swift and tools/audio/click-tracks.test.mjs. Do not edit by hand.",
        "card": "NE-25a",
        "firstClickSec": 1,
        "maxBytesTotal": 1_000_000,
        "doubleEverySec": DOUBLE_EVERY_SEC,
        "doubleGapSec": DOUBLE_GAP_SEC,
        "clickLengthSec": CLICK_LENGTH_SEC,
        "clickFreqHz": CLICK_FREQ_HZ,
        "clickPeak": CLICK_PEAK,
        "encoder": f"lameenc {LAMEENC_VERSION}",
        "fixtures": [
            dict(file=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), **meta)
            for name, (data, meta) in files.items()
        ],
    }
    out = {name: data for name, (data, _) in files.items()}
    out[DESCRIPTOR] = (json.dumps(descriptor, indent=2) + "\n").encode("utf-8")
    return out


def main(argv):
    out = build()
    if "--check" in argv:
        stale = []
        for name, data in out.items():
            path = os.path.join(OUT_DIR, name)
            if not os.path.exists(path):
                stale.append(f"{name} (missing)")
                continue
            with open(path, "rb") as f:
                if f.read() != data:
                    stale.append(name)
        if stale:
            print("FATAL: stale click tracks: " + ", ".join(stale), file=sys.stderr)
            return 1
        print(f"ok - {len(out)} click-track files are current")
        return 0
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, data in out.items():
        with open(os.path.join(OUT_DIR, name), "wb") as f:
            f.write(data)
        print(f"wrote {name}: {len(data)} bytes")
    total = sum(len(d) for n, d in out.items() if n != DESCRIPTOR)
    print(f"total audio bytes: {total}")
    if total >= 1_000_000:
        print("FATAL: the card caps the click tracks at 1 MB", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
