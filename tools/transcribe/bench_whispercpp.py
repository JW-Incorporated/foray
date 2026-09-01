#!/usr/bin/env python3
"""Foray transcription benchmark harness -- AMD GPU path (issue T7/#118).

`bench.py` times `faster-whisper` (CTranslate2), which has NO AMD GPU
backend at all -- no ROCm, no Vulkan. CTranslate2 only accelerates on
NVIDIA CUDA. An AMD card (RX 6700 XT and similar) needs a different engine
entirely: **whisper.cpp**, built with its Vulkan backend, which runs on any
GPU with a Vulkan 1.3+ driver (AMD, NVIDIA, Intel) with no vendor SDK
install required for the Vulkan build specifically.

This script does NOT reimplement transcription. It shells out to the
`whisper-cli` binary that ships with whisper.cpp (prebuilt, or built with
`-DGGML_VULKAN=ON`), times the wall clock the same way `bench.py` does, and
reshapes whisper-cli's own JSON transcript into the SAME result schema
`bench.py` prints on its last stdout line -- same field names, same units --
so a `base.en` GPU run here and a `base.en` CPU run from bench.py are
directly comparable in the same results file. See README.md #3b.

Requires: a whisper.cpp `whisper-cli` binary (path via --whisper-cli or the
WHISPER_CLI env var) and a GGML model file (`ggml-*.bin`, NOT the CTranslate2
weights bench.py uses -- these are a different format from a different
project; see README.md for the one-line download command).

CPU (any machine, incl. this sandbox -- verified end-to-end 2026-09-01):
    python bench_whispercpp.py AUDIO --model models/ggml-base.en.bin \\
        --whisper-cli /path/to/whisper-cli --device cpu

AMD GPU via Vulkan (Windows, RX 6700 XT -- NOT verified here, no AMD GPU
in this sandbox; expected numbers only until run on real hardware):
    python bench_whispercpp.py AUDIO --model models\\ggml-base.en.bin `
        --whisper-cli C:\\whisper\\whisper-cli.exe --device vulkan
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def audio_duration_seconds(path: str) -> float:
    """Duration in seconds, decoded via PyAV -- same method bench.py uses.

    Only `av` is required (already pinned in requirements.txt); this script
    does not need faster-whisper/ctranslate2 at all, on purpose -- the whole
    point is a path that has no CTranslate2 dependency.
    """
    import av

    with av.open(path) as container:
        if container.duration is not None:
            return container.duration / av.time_base
        stream = next(s for s in container.streams if s.type == "audio")
        return float(stream.duration * stream.time_base)


def find_default_whisper_cli() -> str | None:
    env = os.environ.get("WHISPER_CLI")
    if env and Path(env).exists():
        return env
    found = shutil.which("whisper-cli") or shutil.which("whisper-cli.exe")
    return found


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Time whisper.cpp (whisper-cli) on one file -- the AMD GPU path."
    )
    ap.add_argument("audio", help="path to an audio file (mp3, m4a, wav, flac, ogg)")
    ap.add_argument("--model", required=True,
                     help="path to a ggml-*.bin model file (NOT a faster-whisper/"
                          "CTranslate2 model -- different format, see README.md)")
    ap.add_argument("--whisper-cli", default=None,
                     help="path to the whisper-cli binary. Defaults to $WHISPER_CLI "
                          "or whatever 'whisper-cli' resolves to on PATH")
    ap.add_argument("--device", default="vulkan", choices=["cpu", "vulkan", "rocm"],
                     help="cpu disables GPU (-ng); vulkan/rocm assume the binary was "
                          "built with that backend and leave GPU on (whisper-cli's "
                          "default) -- this flag does not change which backend a "
                          "given whisper-cli binary was compiled with")
    ap.add_argument("--language", default="en")
    ap.add_argument("--threads", type=int, default=0,
                     help="CPU threads; 0 = os.cpu_count() (still used for encode-"
                          "adjacent CPU work even on --device vulkan/rocm)")
    ap.add_argument("--word-timestamps", dest="word_timestamps",
                     action=argparse.BooleanOptionalAction, default=True,
                     help="request word-level timestamps via -ojf (default: on)")
    ap.add_argument("--beam-size", type=int, default=5)
    ap.add_argument("--vad", action=argparse.BooleanOptionalAction, default=False,
                     help="enable whisper.cpp's own VAD filtering (off = honest "
                          "full-audio timing, matching bench.py's default)")
    ap.add_argument("--out", default=None,
                     help="write the transcript JSON here (gitignored; optional)")
    ap.add_argument("--limit-seconds", type=float, default=None,
                     help="only transcribe the first N seconds via --duration. "
                          "SMOKE TESTS ONLY, same caveat as bench.py's flag of the "
                          "same name -- not a timing mode")
    args = ap.parse_args()

    whisper_cli = args.whisper_cli or find_default_whisper_cli()
    if not whisper_cli or not Path(whisper_cli).exists():
        print("ERROR: no whisper-cli binary found. Pass --whisper-cli /path/to/it "
              "or set WHISPER_CLI. See README.md #3b for where to get one.",
              file=sys.stderr)
        return 2

    threads = args.threads or (os.cpu_count() or 1)

    if args.limit_seconds:
        print("WARNING: --limit-seconds is a smoke test, NOT a timing mode. "
              "Same caveat as bench.py's flag of the same name.", file=sys.stderr)

    duration = audio_duration_seconds(args.audio)
    if args.limit_seconds:
        duration = min(duration, args.limit_seconds)

    print(f"host              : {platform.processor() or platform.machine()}")
    print(f"python            : {sys.version.split()[0]}")
    print(f"engine            : whisper.cpp (whisper-cli)")
    print(f"whisper-cli       : {whisper_cli}")
    print(f"model / device    : {Path(args.model).name} / {args.device}")
    print(f"threads           : {threads}")
    print(f"word_timestamps   : {args.word_timestamps}")
    print(f"audio             : {args.audio}")
    print(f"audio duration    : {duration:.1f} s ({duration / 60:.1f} min)")
    print("-" * 60, flush=True)

    with tempfile.TemporaryDirectory() as tmp:
        out_stem = str(Path(tmp) / "result")
        cmd = [
            whisper_cli,
            "-m", args.model,
            "-f", args.audio,
            "-l", args.language,
            "-t", str(threads),
            "-bs", str(args.beam_size),
            "-of", out_stem,
            "-pp",
        ]
        # -ojf (JSON-full) is what gives per-word timestamps + tokens; plain
        # -oj only gives per-segment text, mirroring bench.py's
        # --no-word-timestamps distinction.
        cmd.append("-ojf" if args.word_timestamps else "-oj")
        if args.device == "cpu":
            cmd.append("-ng")
        if args.vad:
            cmd.append("--vad")
        if args.limit_seconds:
            cmd.extend(["-d", str(int(args.limit_seconds * 1000))])

        t0 = time.perf_counter()
        proc = subprocess.run(cmd, capture_output=True, text=True)
        wall = time.perf_counter() - t0

        if proc.returncode != 0:
            print("whisper-cli FAILED:", file=sys.stderr)
            print(proc.stdout, file=sys.stderr)
            print(proc.stderr, file=sys.stderr)
            return proc.returncode

        stderr = proc.stderr
        load_match = re.search(r"load time\s*=\s*([\d.]+)\s*ms", stderr)
        load_wall = float(load_match.group(1)) / 1000.0 if load_match else float("nan")

        result_json_path = Path(out_stem + ".json")
        if not result_json_path.exists():
            print("ERROR: whisper-cli did not produce the expected JSON output "
                  f"at {result_json_path}", file=sys.stderr)
            print(stderr, file=sys.stderr)
            return 1
        raw = json.loads(result_json_path.read_text(encoding="utf-8"))

    # Reshape whisper.cpp's transcript into bench.py's {segments: [...]} shape
    # so the two harnesses' --out files line up field-for-field.
    collected = []
    n_words = 0
    bad = 0
    prev_end = -1.0
    for i, seg in enumerate(raw.get("transcription", [])):
        seg_start = seg["offsets"]["from"] / 1000.0
        seg_end = seg["offsets"]["to"] / 1000.0
        words = None
        if args.word_timestamps and seg.get("tokens"):
            words = []
            for tok in seg["tokens"]:
                text = tok["text"]
                # whisper.cpp emits bracketed special/control tokens
                # ([_BEG_], [_TT_550], etc.) interleaved with real words in
                # -ojf output; bench.py's word list has no such tokens, so
                # they are dropped here to keep the two outputs comparable.
                if text.startswith("[_") and text.endswith("]"):
                    continue
                w_start = tok["offsets"]["from"] / 1000.0
                w_end = tok["offsets"]["to"] / 1000.0
                words.append({"start": w_start, "end": w_end, "word": text})
                n_words += 1
                if not (w_start <= w_end) or w_start < prev_end - 0.05 \
                        or w_start < seg_start - 0.5 or w_end > seg_end + 0.5:
                    bad += 1
                prev_end = w_end
        collected.append({
            "id": i, "start": seg_start, "end": seg_end,
            "text": seg["text"], "words": words,
        })

    rtm = duration / wall if wall else float("nan")
    print("-" * 60)
    print(f"segments          : {len(collected)}")
    print(f"words w/ times    : {n_words}")
    print(f"wall clock        : {wall:.1f} s ({wall / 60:.2f} min)")
    print(f"REALTIME MULTIPLE : {rtm:.2f}x")
    print(f"  (+model load    : {duration / (wall + (load_wall if load_wall == load_wall else 0)):.2f}x)")
    print("-" * 60)
    print(f"word-time sanity  : {n_words - bad}/{n_words} ok"
          f"{' -- ' + str(bad) + ' suspect' if bad else ''}")

    result = {
        "audio": str(Path(args.audio).name),
        "engine": "whisper.cpp",
        "model": Path(args.model).name,
        "device": args.device,
        "compute_type": None,
        "threads": threads,
        "word_timestamps": args.word_timestamps,
        "beam_size": args.beam_size,
        "vad_filter": args.vad,
        "audio_duration_sec": round(duration, 2),
        "model_load_sec": round(load_wall, 2) if load_wall == load_wall else None,
        "wall_clock_sec": round(wall, 2),
        "cpu_time_sec": None,
        "effective_threads": None,
        "realtime_multiple": round(rtm, 3),
        "limit_seconds": args.limit_seconds,
        "segments": len(collected),
        "words": n_words,
        "word_times_suspect": bad,
        "detected_language": raw.get("result", {}).get("language"),
        "python": sys.version.split()[0],
        "faster_whisper": None,
        "ctranslate2": None,
        "whisper_cli_systeminfo": raw.get("systeminfo"),
    }
    print(json.dumps(result))

    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(
            json.dumps({"meta": result, "segments": collected}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        print(f"transcript written: {args.out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
