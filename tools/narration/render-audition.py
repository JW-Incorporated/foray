#!/usr/bin/env python3
"""K-03's audition kit: twelve voices, one passage, one graph.

`docs/bundled-voice-plan.md` K-03 and §6. Wyatt's rule, made concrete: "for the
voices, the founders should try out a dozen first and choose our 3 favorites,
which are then selectable from within the app."

THE ONE THING THIS FILE EXISTS TO GUARANTEE is that the founders judge what
LISTENERS WILL HEAR. Every clip is rendered:

  * from the SAME ONNX graph and the SAME q8f16 weights K-01 bundles and
    `tools/mobile/fetch-models.mjs` pins — not the fp32 demo, not a hosted
    playground. Deck §5 item 5 is explicit that "resilient to quantization" is
    the model card's claim and nobody here has listened;
  * from K-02's PHONEMES, not from text, so the clip carries the same
    pronunciation overrides a published Foray will;
  * at 1.0x for the ranking round, then the top three again at 1.5x and 2.0x,
    because the `speed` input's quality at the fast end is what long-form
    listeners actually live with;
  * to a DETERMINISTIC output path, so a re-render overwrites rather than
    accumulates and two runs are byte-comparable.

BLIND LABELS. Clips are written as `A.wav` ... `L.wav` in a stable order
derived from the passage, and the label-to-voice key is written to a SEPARATE
file that the audition page does not read. `docs/research/voice-audition-2026-09.md`
holds the sealed key; a founder who can see that `af_heart` is graded A on the
model card is not ranking the voice, they are ranking the grade.

WHAT THIS MACHINE COULD NOT DO, and why it is a refusal rather than a stub.
Neither `kokoro-onnx` nor the weights are present on the machine that wrote
this file, and the weights are ~86 MB which this repository must never carry
(deck §9). So `--check` reports exactly what is missing and prints the two
commands that fix it; `--render` refuses rather than writing silence, a sine
tone, or a system-voice clip labelled as Kokoro. A founder ranking twelve
clips has no way to tell a fake one from a real one, which is precisely why
this file must not produce one.

USAGE

    python tools/narration/render-audition.py --check
    node tools/mobile/fetch-models.mjs                    # once the pins are filled
    python tools/narration/render-audition.py --render
    python tools/narration/render-audition.py --render --speeds 1.5,2.0 --voices af_heart,af_bella,bm_george
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PASSAGE_PATH = REPO_ROOT / "tools" / "mobile" / "kokoro-probe-passage.json"
MODELS_DIR = REPO_ROOT / "mobile" / "models"
MODEL_FILE = MODELS_DIR / "kokoro-v1_0-q8f16.onnx"
OUT_DIR = REPO_ROOT / "mobile" / "models" / "audition"

# §6's slate, in the deck's own order: by model-card grade, then by variety.
# TWELVE, because that is Wyatt's "a dozen". The three with the best combined
# rank ship; the winner is the default (K-04, DECISIONS).
SLATE = [
    "af_heart",    # A
    "af_bella",    # A-
    "af_nicole",   # B-
    "bf_emma",     # B-
    "af_sarah",
    "af_kore",
    "af_aoede",    # C+
    "am_michael",
    "am_fenrir",
    "am_puck",     # C+
    "bm_george",
    "bm_fable",    # C
]

# A..L. Exactly as many labels as voices, asserted below rather than assumed:
# a slate that grew to thirteen with twelve labels would silently drop a voice
# from the audition and nobody would notice until the ranking came back short.
LABELS = [chr(ord("A") + i) for i in range(len(SLATE))]

RANKING_SPEED = 1.0
CONFIRM_SPEEDS = [1.5, 2.0]

FETCH_HINT = (
    "1. fill the sha256 pins:  node tools/mobile/fetch-models.mjs --check\n"
    "  2. fetch the weights:     node tools/mobile/fetch-models.mjs\n"
    "  3. install the runtime:   pip install -r tools/narration/requirements.txt"
)


class MissingDependency(RuntimeError):
    """Raised instead of rendering something a founder cannot tell from real."""


def load_passage(path: Path = PASSAGE_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def passage_fingerprint(passage: dict) -> str:
    """A stable id for THIS passage, so a clip's path changes when the passage
    does and a stale render cannot be ranked as a fresh one. Derived from the
    line ids and their phonemes — not from the text, because a typo fix that
    does not change the phonemes does not change what anyone hears."""
    blob = json.dumps(
        [[line.get("id"), line.get("phonemes")] for line in passage.get("lines", [])],
        ensure_ascii=False,
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:12]


def clip_path(label: str, speed: float, fingerprint: str, out_dir: Path = OUT_DIR) -> Path:
    """DETERMINISTIC, and that is the card's acceptance ("twelve clips exist and
    are bit-identical on re-render"). Speed is in the filename because the
    confirm round renders the same voices again and must not overwrite the
    ranking round's clips."""
    speed_tag = ("%.2f" % speed).replace(".", "p")
    return out_dir / fingerprint / f"{label}-{speed_tag}.wav"


def label_key(slate: list[str] = SLATE) -> dict[str, str]:
    """The sealed label -> voice mapping. Written to its own file; the audition
    page never reads it."""
    if len(slate) != len(LABELS):
        raise ValueError(f"{len(slate)} voices but {len(LABELS)} labels — the audition would drop one")
    return dict(zip(LABELS, slate))


def missing_dependencies() -> list[str]:
    """Everything standing between here and a real render, named."""
    missing = []
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        missing.append("onnxruntime (pip)")
    try:
        import soundfile  # noqa: F401
    except ImportError:
        missing.append("soundfile (pip)")
    if not MODEL_FILE.exists():
        missing.append(f"{MODEL_FILE.relative_to(REPO_ROOT)} (fetched, never committed)")
    passage = load_passage()
    if any(not line.get("ids") for line in passage.get("lines", [])):
        missing.append("phonemized passage (run tools/narration/phonemize.py --passage ... --in-place)")
    return missing


def render(voices: list[str], speeds: list[float], out_dir: Path = OUT_DIR) -> list[Path]:
    """Render each voice at each speed. Refuses when anything is missing.

    THE REFUSAL IS THE FEATURE. A founder ranking twelve clips has no way to
    tell a fake one from a real one — so a stub that wrote silence, a sine
    tone, or a system-voice clip labelled as Kokoro would corrupt the one
    decision this kit exists to support, and would do it invisibly.
    """
    missing = missing_dependencies()
    if missing:
        raise MissingDependency(
            "cannot render the audition — missing:\n  - " + "\n  - ".join(missing) + "\n\n  " + FETCH_HINT
        )
    import numpy as np  # noqa: F401  (imported here so --check works without it)
    import onnxruntime as ort
    import soundfile as sf

    passage = load_passage()
    fingerprint = passage_fingerprint(passage)
    session = ort.InferenceSession(str(MODEL_FILE), providers=["CPUExecutionProvider"])
    written: list[Path] = []
    key = label_key()
    inverse = {v: k for k, v in key.items()}
    for voice in voices:
        style = np.fromfile(MODELS_DIR / f"{voice}.bin", dtype=np.float32)
        for speed in speeds:
            chunks = []
            for line in passage["lines"]:
                ids = np.array([line["ids"]], dtype=np.int64)
                out = session.run(
                    None,
                    {"input_ids": ids, "style": style[: 256].reshape(1, 256), "speed": np.array([speed], dtype=np.float32)},
                )
                chunks.append(out[0].squeeze())
            audio = np.concatenate(chunks)
            path = clip_path(inverse[voice], speed, fingerprint, out_dir)
            path.parent.mkdir(parents=True, exist_ok=True)
            sf.write(str(path), audio, 24000)
            written.append(path)
    return written


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="report what is missing and exit")
    ap.add_argument("--render", action="store_true")
    ap.add_argument("--voices", help="comma-separated voice ids (default: the twelve-voice slate)")
    ap.add_argument("--speeds", help="comma-separated speeds (default: 1.0)")
    ap.add_argument("--key-out", help="where to write the sealed label key")
    args = ap.parse_args(argv)

    voices = args.voices.split(",") if args.voices else list(SLATE)
    speeds = [float(s) for s in args.speeds.split(",")] if args.speeds else [RANKING_SPEED]

    if args.check:
        missing = missing_dependencies()
        print(f"slate: {len(SLATE)} voices, labels {LABELS[0]}..{LABELS[-1]}")
        print(f"passage: {PASSAGE_PATH.relative_to(REPO_ROOT)}")
        if not missing:
            print("ready to render.")
            return 0
        print("NOT READY — missing:")
        for m in missing:
            print(f"  - {m}")
        print("\n  " + FETCH_HINT)
        return 1

    if not args.render:
        ap.print_help()
        return 2

    if args.key_out:
        Path(args.key_out).write_text(json.dumps(label_key(), indent=2) + "\n", encoding="utf-8")
    try:
        written = render(voices, speeds)
    except MissingDependency as exc:
        print(str(exc), file=sys.stderr)
        return 1
    for p in written:
        print(p.relative_to(REPO_ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
