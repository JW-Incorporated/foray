#!/usr/bin/env python3
"""Transcribe every rendered narration line back to text, locally (GV-72).

docs/roadmap/generation-v2.md GV-72 (from W6-12). The first half of the
Whisper round trip: for each `.m4a` a render manifest lists as rendered (or
already held as flagged), run a LOCAL ASR model over the file and write one
row per line to asr.jsonl:

    {"key": "n/<profile>/<voice>/<sha256>.m4a", "text": "...", "model": "faster-whisper:base.en"}

`asr-check.mjs` then scores each row's word error rate against the script and
lists (or, with --hold-flagged, holds) the lines Kokoro garbled.

ENGINES (pick with --engine):
  faster-whisper  the Python package (`pip install faster-whisper`), CTranslate2
                  weights. --model is a size name (base.en, small.en, ...) that
                  must already be in the local Hugging Face cache or --model-dir,
                  or a path to a converted model directory.
  whisper.cpp     the `whisper-cli` binary (--whisper-cpp to name it) and a ggml
                  model FILE (--model /path/ggml-base.en.bin). ffmpeg converts
                  each .m4a to 16 kHz mono WAV first, in a temp directory.

NO NETWORK. faster-whisper is loaded with local_files_only=True and
HF_HUB_OFFLINE=1 set before the import, so a model that is not on disk is a
refusal, never a download; whisper.cpp reads only the file named. Nothing
here uploads, reads a secret or writes data/forays.json. Transcripts are
generated data: they stay in data-local/ and are never committed.

USAGE
    python tools/narration/asr-transcribe.py --check
    python tools/narration/asr-transcribe.py data-local/narration-render --model base.en
    python tools/narration/asr-transcribe.py out/ --engine whisper.cpp --model ~/models/ggml-base.en.bin --out out/asr.jsonl
    python tools/narration/asr-transcribe.py out/ --resume      # skip keys asr.jsonl already holds
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MANIFEST_KIND = "foray-narration-render"
#: The entry statuses with a file in this render to transcribe.
TRANSCRIBED_STATUSES = ("rendered", "flagged")
ENGINES = ("faster-whisper", "whisper.cpp")
DEFAULT_MODEL = "base.en"
DEFAULT_WHISPER_CPP = "whisper-cli"


class AsrError(RuntimeError):
    """A refusal with a reason."""


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def read_manifests(target: Path) -> list[tuple[Path, dict]]:
    """A manifest file, or every manifest*.json in a render output directory."""
    if target.is_dir():
        files = sorted(p for p in target.iterdir() if p.name.startswith("manifest") and p.suffix == ".json")
    elif target.is_file():
        files = [target]
    else:
        raise AsrError(f"no render output at {target}")
    if not files:
        raise AsrError(f"no manifest*.json in {target}")
    out = []
    for f in files:
        try:
            doc = json.loads(f.read_text(encoding="utf-8"))
        except ValueError as exc:
            raise AsrError(f"{f} is not readable JSON: {exc}") from exc
        if not isinstance(doc, dict) or doc.get("kind") != MANIFEST_KIND:
            raise AsrError(f"{f} is not a {MANIFEST_KIND} manifest")
        out.append((f, doc))
    return out


def plan_files(out_dir: Path, manifests: list[tuple[Path, dict]]) -> list[dict]:
    """[{key, path}] for every rendered (or held) entry, once per key, in
    manifest order. A listed file that is not on disk is a refusal: a line
    that was never heard must not look like a clean one."""
    seen: set[str] = set()
    plan: list[dict] = []
    for f, doc in manifests:
        for e in doc.get("items") or []:
            if e.get("status") not in TRANSCRIBED_STATUSES:
                continue
            key = e.get("key")
            if not isinstance(key, str) or not key.endswith(".m4a") or ".." in key.split("/"):
                raise AsrError(f"{f.name}: {key!r} is not a narration key")
            if key in seen:
                continue
            seen.add(key)
            path = out_dir.joinpath(*key.split("/"))
            if not path.is_file():
                raise AsrError(f"{key} is in {f.name} but not on disk under {out_dir}")
            plan.append({"key": key, "path": path})
    return plan


def read_done(out_path: Path) -> set[str]:
    if not out_path.exists():
        return set()
    done = set()
    for line in out_path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            if isinstance(row.get("key"), str) and isinstance(row.get("text"), str):
                done.add(row["key"])
    return done


def transcribe_all(plan: list[dict], transcribe, model_label: str, out_path: Path, *, resume: bool = False) -> dict:
    """Run `transcribe(path) -> text` over the plan, writing each row as soon
    as it exists (a long run that dies keeps what it heard; --resume skips it).
    Returns {written, skipped, failed: [{key, error}]}."""
    done = read_done(out_path) if resume else set()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    summary = {"written": 0, "skipped": 0, "failed": []}
    with out_path.open("a" if resume else "w", encoding="utf-8", newline="\n") as fh:
        for n, job in enumerate(plan, 1):
            if job["key"] in done:
                summary["skipped"] += 1
                continue
            try:
                text = transcribe(job["path"])
            except Exception as exc:  # one bad file never stops the batch
                summary["failed"].append({"key": job["key"], "error": str(exc)})
                log(f"[{n}/{len(plan)}] {job['key']}: FAILED {exc}")
                continue
            row = {"key": job["key"], "text": " ".join(str(text).split()), "model": model_label}
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            fh.flush()
            summary["written"] += 1
            log(f"[{n}/{len(plan)}] {job['key']}: {len(row['text'].split())} words")
    return summary


# =================================================================== engines


def faster_whisper_transcriber(model: str, *, model_dir: str | None, device: str, compute_type: str, threads: int):
    # Set BEFORE the import: huggingface_hub reads it at import time.
    os.environ["HF_HUB_OFFLINE"] = "1"
    from faster_whisper import WhisperModel  # noqa: PLC0415 - optional dependency, loaded only when used

    m = WhisperModel(model, device=device, compute_type=compute_type, cpu_threads=threads,
                     download_root=model_dir, local_files_only=True)

    def transcribe(path: Path) -> str:
        segments, _info = m.transcribe(str(path), language="en", beam_size=5, condition_on_previous_text=False)
        return " ".join(s.text.strip() for s in segments)

    return transcribe


def whisper_cpp_command(binary: str, model: str, wav: Path, threads: int) -> list[str]:
    return [binary, "-m", model, "-f", str(wav), "-l", "en", "-nt", "-np", "-t", str(threads)]


def whisper_cpp_transcriber(binary: str, model: str, *, ffmpeg: str, threads: int, run=subprocess.run):
    if not Path(model).is_file():
        raise AsrError(f"whisper.cpp needs a ggml model file; {model} is not one on disk")

    def transcribe(path: Path) -> str:
        with tempfile.TemporaryDirectory(prefix="asr-") as tmp:
            wav = Path(tmp) / (path.stem + ".wav")
            conv = run([ffmpeg, "-v", "error", "-y", "-i", str(path), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)],
                       capture_output=True, text=True)
            if conv.returncode != 0:
                raise AsrError(f"ffmpeg could not decode {path.name}: {conv.stderr.strip()[:200]}")
            r = run(whisper_cpp_command(binary, model, wav, threads), capture_output=True, text=True)
            if r.returncode != 0:
                raise AsrError(f"{binary} exited {r.returncode}: {r.stderr.strip()[:200]}")
            return " ".join(line.strip() for line in r.stdout.splitlines() if line.strip())

    return transcribe


def model_label(engine: str, model: str) -> str:
    """The `model` field of each row: the engine and the model's NAME (a
    path's basename), never a local path."""
    name = Path(model).name if (os.sep in model or "/" in model) else model
    return f"{engine}:{name}"


def make_transcriber(args):
    if args.engine == "faster-whisper":
        return faster_whisper_transcriber(args.model, model_dir=args.model_dir, device=args.device,
                                          compute_type=args.compute_type, threads=args.threads)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise AsrError("ffmpeg must be on PATH for whisper.cpp (it converts each .m4a to 16 kHz WAV)")
    binary = shutil.which(args.whisper_cpp) or (args.whisper_cpp if Path(args.whisper_cpp).is_file() else None)
    if not binary:
        raise AsrError(f"{args.whisper_cpp} is not on PATH (build whisper.cpp, or pass --whisper-cpp PATH)")
    return whisper_cpp_transcriber(binary, args.model, ffmpeg=ffmpeg, threads=args.threads)


def cmd_check(args) -> int:
    """What is installed for the chosen engine. Loads no model."""
    print(f"python: {sys.version.split()[0]}")
    ok = True
    if args.engine == "faster-whisper":
        have = importlib.util.find_spec("faster_whisper") is not None
        print(f"faster-whisper: {'installed' if have else 'MISSING (pip install faster-whisper)'}")
        ok &= have
        print(f"model: {args.model} (loaded with local_files_only; a model not on disk is refused, never downloaded)")
    else:
        binary = shutil.which(args.whisper_cpp)
        print(f"whisper.cpp: {binary or f'MISSING ({args.whisper_cpp} not on PATH)'}")
        ffmpeg = shutil.which("ffmpeg")
        print(f"ffmpeg: {ffmpeg or 'MISSING'}")
        have_model = Path(args.model).is_file()
        print(f"model: {args.model} {'on disk' if have_model else 'MISSING (a ggml model file)'}")
        ok &= bool(binary) and bool(ffmpeg) and have_model
    print("ready to transcribe." if ok else "NOT READY")
    return 0 if ok else 1


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("render_out", nargs="?", help="render output directory (manifest*.json and n/...) or one manifest")
    ap.add_argument("--check", action="store_true", help="report what the chosen engine needs, then exit")
    ap.add_argument("--engine", choices=ENGINES, default="faster-whisper")
    ap.add_argument("--model", default=DEFAULT_MODEL,
                    help="faster-whisper: a size name in the local cache or a model directory; whisper.cpp: a ggml file")
    ap.add_argument("--model-dir", help="faster-whisper: where local models live (download_root; never downloaded into)")
    ap.add_argument("--whisper-cpp", default=DEFAULT_WHISPER_CPP, help="the whisper.cpp binary (default whisper-cli)")
    ap.add_argument("--device", default="cpu", help="faster-whisper device (cpu, cuda)")
    ap.add_argument("--compute-type", default="int8", help="faster-whisper compute type (int8, float16, ...)")
    ap.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 1))
    ap.add_argument("--out", help="the asr.jsonl to write (default <render-out>/asr.jsonl)")
    ap.add_argument("--resume", action="store_true", help="keep the rows --out already holds and skip their keys")
    return ap


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.check:
            return cmd_check(args)
        if not args.render_out:
            raise AsrError("name a render output directory (or a manifest), or pass --check")
        target = Path(args.render_out).resolve()
        out_dir = target if target.is_dir() else target.parent
        plan = plan_files(out_dir, read_manifests(target))
        out_path = Path(args.out).resolve() if args.out else out_dir / "asr.jsonl"
        if not plan:
            log("nothing rendered to transcribe")
            return 0
        transcribe = make_transcriber(args)
        s = transcribe_all(plan, transcribe, model_label(args.engine, args.model), out_path, resume=args.resume)
        log(f"{s['written']} transcribed, {s['skipped']} kept, {len(s['failed'])} failed -> {out_path}")
        return 0 if not s["failed"] else 1
    except AsrError as exc:
        print(f"asr-transcribe: {exc}", file=sys.stderr)
        return 2
    except ImportError as exc:
        print(f"asr-transcribe: missing dependency: {exc}. Run with --check.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
