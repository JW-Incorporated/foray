#!/usr/bin/env python3
"""Foray transcription benchmark harness (T1, issue #116).

Times faster-whisper on one audio file and reports the realtime multiple
(audio duration / wall clock). Device and model are arguments, not constants,
so the *same* script produces directly comparable numbers on a CPU-only box
and on a CUDA box.

CPU:   python bench.py AUDIO --model small.en  --device cpu  --compute-type int8
CUDA:  python bench.py AUDIO --model medium.en --device cuda --compute-type float16

See README.md in this directory for the full setup.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import time
from pathlib import Path


def audio_duration_seconds(path: str) -> float:
    """Duration in seconds, decoded via PyAV (bundled with faster-whisper).

    No external ffmpeg binary required.
    """
    import av

    with av.open(path) as container:
        if container.duration is not None:
            return container.duration / av.time_base
        stream = next(s for s in container.streams if s.type == "audio")
        return float(stream.duration * stream.time_base)


def main() -> int:
    ap = argparse.ArgumentParser(description="Time faster-whisper on one file.")
    ap.add_argument("audio", help="path to an audio file (mp3, m4a, wav, ...)")
    ap.add_argument("--model", default="small.en",
                    help="whisper model id, e.g. base.en / small.en / medium.en / large-v3")
    ap.add_argument("--device", default="cpu", choices=["cpu", "cuda", "auto"],
                    help="cpu or cuda (cuda needs the CUDA build of CTranslate2)")
    ap.add_argument("--compute-type", default=None,
                    help="int8 (cpu default) or float16 / int8_float16 (cuda default: float16)")
    ap.add_argument("--threads", type=int, default=0,
                    help="CPU threads; 0 = os.cpu_count() (ignored on cuda)")
    ap.add_argument("--word-timestamps", dest="word_timestamps",
                    action=argparse.BooleanOptionalAction, default=True,
                    help="request word-level timestamps (default: on)")
    ap.add_argument("--beam-size", type=int, default=5)
    ap.add_argument("--vad", action=argparse.BooleanOptionalAction, default=False,
                    help="enable Silero VAD filtering (off = honest full-audio timing)")
    ap.add_argument("--download-root", default=None,
                    help="where to cache model weights (keep this OUT of the repo)")
    ap.add_argument("--out", default=None,
                    help="write the transcript JSON here (gitignored; optional)")
    ap.add_argument("--limit-seconds", type=float, default=None,
                    help="only transcribe the first N seconds. SMOKE TESTS ONLY -- "
                         "the resulting timing is not comparable to a full pass "
                         "(trim the audio to its own file if you want to time a sample)")
    args = ap.parse_args()

    if args.compute_type is None:
        args.compute_type = "float16" if args.device == "cuda" else "int8"
    threads = args.threads or (os.cpu_count() or 1)

    if args.limit_seconds:
        print("WARNING: --limit-seconds is a smoke test, NOT a timing mode.\n"
              "         faster-whisper still pays whole-file costs, so the realtime\n"
              "         multiple comes out far worse than a full pass on the same\n"
              "         audio. To time a short sample, trim it to its own file first.",
              file=sys.stderr)

    from faster_whisper import WhisperModel
    import ctranslate2
    import faster_whisper

    duration = audio_duration_seconds(args.audio)
    if args.limit_seconds:
        duration = min(duration, args.limit_seconds)

    print(f"host              : {platform.processor() or platform.machine()}")
    print(f"python            : {sys.version.split()[0]}")
    print(f"faster-whisper    : {faster_whisper.__version__}")
    print(f"ctranslate2       : {ctranslate2.__version__}")
    print(f"model / device    : {args.model} / {args.device} / {args.compute_type}")
    print(f"threads           : {threads if args.device == 'cpu' else 'n/a (gpu)'}")
    print(f"word_timestamps   : {args.word_timestamps}")
    print(f"audio             : {args.audio}")
    print(f"audio duration    : {duration:.1f} s ({duration / 60:.1f} min)")
    print("-" * 60, flush=True)

    load_start = time.perf_counter()
    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        cpu_threads=threads,
        download_root=args.download_root,
    )
    load_wall = time.perf_counter() - load_start
    print(f"model load        : {load_wall:.1f} s", flush=True)

    # faster-whisper's transcribe() is lazy: the generator does the work.
    # Timing must wrap the full drain of the generator, not just the call.
    # process_time() sums CPU across all threads, so cpu/wall tells us how much
    # of `--threads` we actually got. On this CPU it came out near 1.3-2.6 of 16,
    # which is the whole reason the CPU path is slow -- worth measuring, not
    # guessing, and worth re-checking on any new box.
    c0 = time.process_time()
    t0 = time.perf_counter()
    segments, info = model.transcribe(
        args.audio,
        beam_size=args.beam_size,
        word_timestamps=args.word_timestamps,
        vad_filter=args.vad,
        clip_timestamps=[0, args.limit_seconds] if args.limit_seconds else "0",
    )

    collected = []
    n_words = 0
    for seg in segments:
        words = None
        if seg.words:
            words = [{"start": w.start, "end": w.end, "word": w.word} for w in seg.words]
            n_words += len(words)
        collected.append(
            {"id": seg.id, "start": seg.start, "end": seg.end,
             "text": seg.text, "words": words}
        )
    wall = time.perf_counter() - t0
    cpu = time.process_time() - c0

    rtm = duration / wall if wall else float("nan")
    eff_threads = cpu / wall if wall else float("nan")
    print("-" * 60)
    print(f"segments          : {len(collected)}")
    print(f"words w/ times    : {n_words}")
    print(f"wall clock        : {wall:.1f} s ({wall / 60:.2f} min)")
    print(f"cpu time          : {cpu:.1f} s")
    print(f"threads used      : {eff_threads:.2f} effective"
          f"{f' of {threads} requested' if args.device == 'cpu' else ''}")
    print(f"REALTIME MULTIPLE : {rtm:.2f}x")
    print(f"  (+model load    : {duration / (wall + load_wall):.2f}x)")
    print("-" * 60)

    # Word-timestamp sanity: monotonic, inside the parent segment, non-negative.
    bad = 0
    prev_end = -1.0
    for seg in collected:
        for w in seg["words"] or []:
            if not (w["start"] <= w["end"]) or w["start"] < prev_end - 0.05 \
                    or w["start"] < seg["start"] - 0.5 or w["end"] > seg["end"] + 0.5:
                bad += 1
            prev_end = w["end"]
    print(f"word-time sanity  : {n_words - bad}/{n_words} ok"
          f"{' -- ' + str(bad) + ' suspect' if bad else ''}")
    if collected and collected[0]["words"]:
        sample = collected[0]["words"][:12]
        print("first words       : "
              + " ".join(f"[{w['start']:.2f}-{w['end']:.2f}]{w['word']}" for w in sample))

    result = {
        "audio": str(Path(args.audio).name),
        "model": args.model,
        "device": args.device,
        "compute_type": args.compute_type,
        "threads": threads if args.device == "cpu" else None,
        "word_timestamps": args.word_timestamps,
        "beam_size": args.beam_size,
        "vad_filter": args.vad,
        "audio_duration_sec": round(duration, 2),
        "model_load_sec": round(load_wall, 2),
        "wall_clock_sec": round(wall, 2),
        "cpu_time_sec": round(cpu, 2),
        "effective_threads": round(eff_threads, 2),
        "realtime_multiple": round(rtm, 3),
        "limit_seconds": args.limit_seconds,
        "segments": len(collected),
        "words": n_words,
        "word_times_suspect": bad,
        "detected_language": info.language,
        "python": sys.version.split()[0],
        "faster_whisper": faster_whisper.__version__,
        "ctranslate2": ctranslate2.__version__,
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
