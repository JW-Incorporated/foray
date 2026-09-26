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

THE LOCAL AUDITION (2026-09-26), the wide first listen before the sealed round:
every English voice, one published Foray passage, a page to star and annotate.
See "the local audition" below and docs/bundled-voice-plan.md K-03.

    python tools/narration/render-audition.py --local
    python tools/narration/render-audition.py --local --voices af_heart,bm_george
    python tools/narration/render-audition.py --local --page-only
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
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


STYLE_DIM = 256


def style_row_index(padded_len: int) -> int:
    """Which row of a voice's (510, 256) style matrix sings a line of
    `padded_len` ids. The row is chosen by the UNPADDED length — the graph's
    own contract, and what both native engines do
    (`KokoroOrtProbeEngine.swift` / `.java`). An earlier draft of `render`
    below took `style[:256]`, row 0, for every line: a voice sung with the
    matrix for a zero-length input, which is not what a phone plays."""
    return max(0, padded_len - 2)


def synth_ids(session, style, ids: list[int], speed: float):
    """One graph call: padded ids in, float32 samples at 24 kHz out."""
    import numpy as np

    matrix = np.asarray(style, dtype=np.float32).reshape(-1, STYLE_DIM)
    row = matrix[style_row_index(len(ids))].reshape(1, STYLE_DIM)
    out = session.run(
        None,
        {
            "input_ids": np.array([ids], dtype=np.int64),
            "style": row,
            "speed": np.array([speed], dtype=np.float32),
        },
    )
    return out[0].squeeze()


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
            chunks = [synth_ids(session, style, line["ids"], speed) for line in passage["lines"]]
            audio = np.concatenate(chunks)
            path = clip_path(inverse[voice], speed, fingerprint, out_dir)
            path.parent.mkdir(parents=True, exist_ok=True)
            sf.write(str(path), audio, 24000)
            written.append(path)
    return written


# =========================================================== the local audition
#
# Wyatt, 2026-09-26: "How do we decide on a voice? Ideally on my computer we can
# test out many of the kokoro voices, find a couple favorites, ship those to the
# app, test there, then send it."
#
# STEP 1 of that route, and deliberately NOT the sealed A–L ranking above. That
# round ranks twelve pre-picked voices blind; this one is the wide first listen
# that decides what is worth ranking at all: EVERY English Kokoro v1.0 voice,
# one real Foray passage, on the founder's own machine, and a page he can star
# and annotate. It shares the two guarantees that matter with the sealed round:
#
#   * the SAME q8f16 graph K-01 bundles — the model's sha256 must equal the pin
#     in `tools/mobile/fetch-models.mjs`, and the twelve pinned voices must
#     equal theirs, or the run refuses;
#   * K-02's PHONEMES, not text — misaki en-US with the lexicon applied first,
#     exactly as `phonemize.py` produces for a published item.
#
# Everything it writes goes under `data-local/voice-audition/` (gitignored):
# the weights, the WAVs and the page. Nothing here is committed but the code.
#
#     python tools/narration/render-audition.py --local            # fetch, verify, render all, write the page
#     python tools/narration/render-audition.py --local --voices af_heart,bm_george
#     python tools/narration/render-audition.py --local --page-only  # rebuild index.html from audition.json
#
# The page's Blind toggle hides names on screen; the files are still named
# after their voices, so it is a listening aid for one person, not the sealed
# round — that stays `--render` and its separately-written key.

DEFAULT_WORK_DIR = REPO_ROOT / "data-local" / "voice-audition"
FETCH_MODELS_PATH = REPO_ROOT / "tools" / "mobile" / "fetch-models.mjs"
FORAYS_PATH = REPO_ROOT / "data" / "forays.json"
VOICE_URL = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/{voice}.bin"
VOICE_BYTES = 522240  # 510 token-lengths x 256 floats x 4 bytes, as fetch-models.mjs pins
SAMPLE_RATE = 24000
LOCAL_SPEED = 1.0

# Every English voice Kokoro v1.0 ships (the upstream VOICES.md, en-US and
# en-GB), grouped by accent and gender. Grades are deliberately NOT carried:
# a founder who sees "A-" next to a name is hearing the grade.
ENGLISH_VOICES = [
    # American female
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
    "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    # American male
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    # British female
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    # British male
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
]

VOICE_PREFIXES = {
    "af": ("American", "female"),
    "am": ("American", "male"),
    "bf": ("British", "female"),
    "bm": ("British", "male"),
}

VOICE_ID_RE = re.compile(r"^(af|am|bf|bm)_[a-z]+$")

# The passage: four narration lines from a PUBLISHED generated Foray, chosen
# to cover the four shapes a narrator actually speaks — the disclosure
# prelude, a one-line clip introduction, a mid-Foray bridge carrying proper
# nouns and an initialism ("TSMC", "Taiwan", "U.S." is in the intro), and the
# closing exit. 1,502 characters, ~88 s at narration-craft.md §2a's
# 17 characters/second. Read from `data/forays.json` at render time, never
# copied here, so the audition speaks what the app would.
AUDITION_FORAY_ID = "how-ai-actually-gets-built-3b83e1"
AUDITION_LINES = [
    ("prelude", "disclosure"),
    ("clip-intro", "narration-act-1-5-connective"),
    ("bridge", "narration-act-1-7-beat"),
    ("closing", "act-4-exit"),
]

# A line longer than the graph's 510 style rows is split at sentence ends.
# 460 leaves headroom under the 509 unpadded ids the style matrix can index.
MAX_CHUNK_PHONEMES = 460
LINE_GAP_SEC = 0.45
CHUNK_GAP_SEC = 0.08


def voice_meta(voice: str) -> dict:
    """`af_heart` -> {id, name: "Heart", accent: "American", gender: "female"}."""
    if not VOICE_ID_RE.match(voice):
        raise ValueError(f"{voice!r} is not an English Kokoro voice id")
    accent, gender = VOICE_PREFIXES[voice[:2]]
    return {"id": voice, "name": voice[3:].capitalize(), "accent": accent, "gender": gender}


def local_clip_path(voice: str, out_dir: Path) -> Path:
    """`out/<voice>.wav`. The id is validated first because it becomes a path."""
    voice_meta(voice)
    return out_dir / f"{voice}.wav"


def read_pins(path: Path = FETCH_MODELS_PATH) -> dict:
    """The model and voice pins, read out of `fetch-models.mjs` itself so there
    is ONE table of hashes in the repository, not a second copy to drift."""
    src = path.read_text(encoding="utf-8")
    m = re.search(
        r'name: "kokoro-v1_0-q8f16\.onnx",\s*url: "([^"]+)",\s*sha256: "([0-9a-f]{64})",\s*bytes: (\d+)',
        src,
    )
    if not m:
        raise ValueError(f"no q8f16 model pin found in {path}")
    voices = {
        v: {"sha256": sha, "bytes": int(n)}
        for v, sha, n in re.findall(r'\["([a-z]{2}_[a-z]+)", "([0-9a-f]{64})", (\d+)\]', src)
    }
    return {
        "model": {"name": "kokoro-v1_0-q8f16.onnx", "url": m.group(1), "sha256": m.group(2), "bytes": int(m.group(3))},
        "voices": voices,
    }


def load_audition_lines(forays_path: Path = FORAYS_PATH) -> list[dict]:
    """The four lines, from the published Foray. A missing Foray or item is an
    error, never a substitute line — the point is the app's own words."""
    doc = json.loads(forays_path.read_text(encoding="utf-8"))
    foray = next((f for f in doc.get("forays", []) if f.get("id") == AUDITION_FORAY_ID), None)
    if foray is None:
        raise ValueError(f"{AUDITION_FORAY_ID} is not in {forays_path}")
    by_id = {i.get("id"): i for i in foray.get("items", []) if i.get("type") == "narration"}
    lines = []
    for role, item_id in AUDITION_LINES:
        item = by_id.get(item_id)
        if not item or not str(item.get("script", "")).strip():
            raise ValueError(f"{AUDITION_FORAY_ID} has no narration item {item_id!r}")
        lines.append({"id": item_id, "role": role, "text": item["script"].strip()})
    return lines


def split_phonemes(phonemes: str, limit: int = MAX_CHUNK_PHONEMES) -> list[str]:
    """Split a phoneme string at sentence ends so every chunk fits the graph.

    Greedy, left to right, never mid-sentence unless one sentence alone is over
    the limit (then at the last space before it). Joining the chunks with a
    single space gives back the input, which is what the test pins: nothing is
    dropped, because a dropped phoneme is a missing word."""
    phonemes = phonemes.strip()
    if len(phonemes) <= limit:
        return [phonemes] if phonemes else []
    sentences = [s for s in re.split(r"(?<=[.!?;])\s+", phonemes) if s]
    pieces: list[str] = []
    for s in sentences:
        while len(s) > limit:
            cut = s.rfind(" ", 0, limit)
            cut = cut if cut > 0 else limit
            pieces.append(s[:cut].strip())
            s = s[cut:].strip()
        if s:
            pieces.append(s)
    chunks: list[str] = []
    for p in pieces:
        if chunks and len(chunks[-1]) + 1 + len(p) <= limit:
            chunks[-1] = chunks[-1] + " " + p
        else:
            chunks.append(p)
    return chunks


def text_fingerprint(lines: list[dict]) -> str:
    blob = json.dumps([[l["id"], l["text"]] for l in lines], ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:12]


def _load_phonemize_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location("foray_phonemize", Path(__file__).resolve().parent / "phonemize.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def phonemize_lines(lines: list[dict]) -> tuple[list[dict], dict]:
    """K-02's own stage, on each line: lexicon first, misaki en-US, espeak-ng
    for what misaki cannot look up, then the model's id table. Returns the
    lines with `chunks` ([{phonemes, ids}]) and a description of the backend."""
    P = _load_phonemize_module()
    g2p = P.load_backend()
    entries = P.load_lexicon()
    vocab = P.load_vocab()
    fallback = getattr(g2p, "fallback", None)
    backend = {
        "g2p": "misaki en-US " + _pkg_version("misaki"),
        "fallback": "none",
        "vocab": P.vocab_sha(vocab),
    }
    if fallback is not None:
        eb = getattr(fallback, "backend", None)
        ver = ".".join(str(x) for x in eb.version()) if eb is not None and hasattr(eb, "version") else "?"
        lib = ""
        try:
            import espeakng_loader  # type: ignore

            lib = " via espeakng_loader " + Path(espeakng_loader.get_library_path()).name
        except Exception:
            pass
        backend["fallback"] = f"espeak-ng {ver}{lib}"
    out = []
    for line in lines:
        res = P.phonemize_script(line["text"], entries, g2p)
        chunks = [{"phonemes": c, "ids": P.ids_for(c, vocab)} for c in split_phonemes(res["phonemes"])]
        out.append({**line, "phonemes": res["phonemes"], "espeak_fallback": res["espeak_fallback"], "chunks": chunks})
    return out, backend


def _pkg_version(name: str) -> str:
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:
        return "?"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _download(url: str, dest: Path) -> None:
    import urllib.request

    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "foray-voice-audition"})
    with urllib.request.urlopen(req, timeout=120) as resp, part.open("wb") as fh:
        while True:
            block = resp.read(1 << 20)
            if not block:
                break
            fh.write(block)
    part.replace(dest)


def ensure_weights(voices: list[str], work_dir: Path, log=print) -> dict:
    """Fetch (once) and verify the model and every voice. Returns the record
    written to `voices/manifest.json`.

    THE MODEL AND THE TWELVE PINNED VOICES MUST MATCH `fetch-models.mjs`, or
    this raises: an audition on different weights from the app's is the one
    thing this tool must never produce. The other sixteen voices have no pin in
    the repository yet; their sha256 is RECORDED here on first download and
    re-checked on every later run, so a file that changes underneath is caught
    even before anyone pins it."""
    pins = read_pins()
    model_pin = pins["model"]
    model_path = work_dir / "model" / model_pin["name"]
    if not model_path.exists():
        log(f"fetching {model_pin['name']} ({model_pin['bytes']:,} bytes)")
        _download(model_pin["url"], model_path)
    got = sha256_file(model_path)
    if got != model_pin["sha256"]:
        raise MissingDependency(
            f"{model_path} sha256 {got} does not match the pin {model_pin['sha256']} in "
            "tools/mobile/fetch-models.mjs — delete it and re-run"
        )
    voices_dir = work_dir / "voices"
    record_path = voices_dir / "manifest.json"
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        record = {}
    record_voices = record.get("voices", {})
    for voice in voices:
        voice_meta(voice)
        path = voices_dir / f"{voice}.bin"
        if not path.exists():
            log(f"fetching {voice}.bin")
            _download(VOICE_URL.format(voice=voice), path)
        got = sha256_file(path)
        size = path.stat().st_size
        pin = pins["voices"].get(voice)
        if size != VOICE_BYTES:
            raise MissingDependency(f"{path} is {size} bytes, expected {VOICE_BYTES}")
        if pin and got != pin["sha256"]:
            raise MissingDependency(f"{voice}.bin sha256 {got} does not match its pin {pin['sha256']}")
        prior = record_voices.get(voice, {}).get("sha256")
        if not pin and prior and prior != got:
            raise MissingDependency(f"{voice}.bin changed since it was first recorded ({prior} -> {got})")
        record_voices[voice] = {
            "sha256": got,
            "bytes": size,
            "pinned": bool(pin),
            "url": VOICE_URL.format(voice=voice),
        }
    record = {
        "model": {"name": model_pin["name"], "sha256": model_pin["sha256"], "bytes": model_pin["bytes"], "url": model_pin["url"]},
        "voices": dict(sorted(record_voices.items())),
    }
    voices_dir.mkdir(parents=True, exist_ok=True)
    record_path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return record


# Measured on the audition PC (2026-09-26, 16-thread x86, ORT 1.20.1): the q8f16
# graph spends ~84% of its time in ConvInteger, ORT's int8 dynamic-quantized
# convolution, and runs ~3x slower than real time. Four intra-op threads beat
# both the default and eight (81 s vs 107-123 s for one 24 s line) and leave
# the rest of the machine usable.
LOCAL_THREADS = 4


def render_local(voices: list[str], work_dir: Path = DEFAULT_WORK_DIR, log=print, threads: int = LOCAL_THREADS) -> dict:
    """Fetch, verify, phonemize once, then render each voice SEQUENTIALLY in
    this one process (the audition machine has little free memory: one ORT
    session, one voice at a time, no workers). Writes `out/<voice>.wav`,
    `out/audition.json` after every voice, and `out/index.html` at the end."""
    import gc
    import time

    out_dir = work_dir / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    weights = ensure_weights(voices, work_dir, log=log)

    lines = load_audition_lines()
    fp = text_fingerprint(lines)
    cache = out_dir / "passage.json"
    passage = None
    try:
        cached = json.loads(cache.read_text(encoding="utf-8"))
        if cached.get("text_fingerprint") == fp:
            passage = cached
    except (OSError, ValueError):
        pass
    if passage is None:
        log("phonemizing the passage (misaki + espeak-ng)")
        phonemized, backend = phonemize_lines(lines)
        passage = {"foray_id": AUDITION_FORAY_ID, "text_fingerprint": fp, "backend": backend, "lines": phonemized}
        cache.write_text(json.dumps(passage, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        gc.collect()  # drop spaCy/misaki before the ONNX session loads

    import numpy as np
    import onnxruntime as ort
    import soundfile as sf

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    session = ort.InferenceSession(
        str(work_dir / "model" / weights["model"]["name"]), opts, providers=["CPUExecutionProvider"]
    )
    manifest_path = out_dir / "audition.json"
    try:
        prior = {v["id"]: v for v in json.loads(manifest_path.read_text(encoding="utf-8")).get("voices", [])}
    except (OSError, ValueError):
        prior = {}
    manifest = {
        "kind": "foray-voice-audition",
        "version": 1,
        "foray_id": AUDITION_FORAY_ID,
        "passage_fingerprint": fp,
        "speed": LOCAL_SPEED,
        "model": {"name": weights["model"]["name"], "sha256": weights["model"]["sha256"]},
        "phonemizer": passage["backend"],
        "onnxruntime": ort.__version__,
        "threads": threads,
        "passage": [{"id": l["id"], "role": l["role"], "text": l["text"]} for l in passage["lines"]],
        "voices": [],
        "failed": [],
    }
    # Voices rendered earlier from the SAME passage stay on the page.
    keep = {k: v for k, v in prior.items() if k not in voices and v.get("passage_fingerprint") == fp}
    line_gap = np.zeros(int(LINE_GAP_SEC * SAMPLE_RATE), dtype=np.float32)
    chunk_gap = np.zeros(int(CHUNK_GAP_SEC * SAMPLE_RATE), dtype=np.float32)
    done: dict[str, dict] = {}
    for n, voice in enumerate(voices, 1):
        t0 = time.perf_counter()
        try:
            style = np.fromfile(work_dir / "voices" / f"{voice}.bin", dtype=np.float32)
            parts = []
            for li, line in enumerate(passage["lines"]):
                if li:
                    parts.append(line_gap)
                for ci, chunk in enumerate(line["chunks"]):
                    if ci:
                        parts.append(chunk_gap)
                    parts.append(synth_ids(session, style, chunk["ids"], LOCAL_SPEED).astype(np.float32))
            audio = np.concatenate(parts)
            path = local_clip_path(voice, out_dir)
            sf.write(str(path), audio, SAMPLE_RATE, subtype="PCM_16")
            secs = round(time.perf_counter() - t0, 2)
            dur = round(len(audio) / SAMPLE_RATE, 2)
            done[voice] = {
                **voice_meta(voice),
                "file": path.name,
                "render_sec": secs,
                "audio_sec": dur,
                "voice_sha256": weights["voices"][voice]["sha256"],
                "pinned": weights["voices"][voice]["pinned"],
                "passage_fingerprint": fp,
            }
            log(f"[{n}/{len(voices)}] {voice}: {dur:.1f} s of audio in {secs:.1f} s")
        except Exception as exc:  # one voice failing must not lose the others
            manifest["failed"].append({"voice": voice, "error": f"{type(exc).__name__}: {exc}"})
            log(f"[{n}/{len(voices)}] {voice}: FAILED {exc}")
        merged = {**keep, **done}
        manifest["voices"] = [merged[v] for v in ENGLISH_VOICES if v in merged]
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        gc.collect()
    write_page(manifest, out_dir)
    return manifest


def write_page(manifest: dict, out_dir: Path) -> Path:
    path = out_dir / "index.html"
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(audition_page_html(manifest))
    return path


def audition_page_html(manifest: dict) -> str:
    """The audition page: one self-contained file that opens from disk.

    PURE — a manifest in, a string out — so the test suite can build it on a
    machine with no runtime and no weights. No network: no external script,
    stylesheet, font or image; the audio is the relative `<voice>.wav` beside
    it. The manifest rides inside a JSON script tag with `<` escaped, so a
    narration line containing `</script>` cannot end the tag early."""
    data = json.dumps(manifest, ensure_ascii=False, sort_keys=True).replace("<", "\\u003c")
    return PAGE_TEMPLATE.replace("__MANIFEST_JSON__", data)


PAGE_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Voice audition</title>
<style>
:root {
  --bg: #f6f5f2; --surface: #ffffff; --surface-2: #efede8; --text: #1c1b19; --muted: #6a675f;
  --line: #dcd9d1; --accent: #3a5bd9; --accent-text: #ffffff; --star: #d99a00; --now: #2f9e6b;
  --radius: 14px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121316; --surface: #1b1d22; --surface-2: #252830; --text: #eceae4; --muted: #a09d95;
    --line: #30333b; --accent: #7d97ff; --accent-text: #0d0f14; --star: #ffc53d; --now: #4cc38a;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header, main { max-width: 1180px; margin: 0 auto; padding: 0 16px; }
header { padding-top: 28px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 4px; letter-spacing: -0.01em; }
.sub { color: var(--muted); margin: 0 0 14px; }
details.passage { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 12px 16px; margin-bottom: 14px; }
details.passage summary { cursor: pointer; font-weight: 600; min-height: 28px; }
.passage p { margin: 10px 0 0; max-width: 70ch; }
.passage .role { display: inline-block; font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--muted); min-width: 80px; }
.bar { position: sticky; top: 0; z-index: 5; background: var(--bg); padding: 10px 0;
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center; border-bottom: 1px solid var(--line); }
.bar .spacer { flex: 1; }
button, .seg label { font: inherit; min-height: 44px; padding: 0 16px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--line); background: var(--surface); color: var(--text); }
button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); font-weight: 600; }
button[aria-pressed="true"] { background: var(--text); color: var(--bg); border-color: var(--text); }
button:disabled { opacity: .45; cursor: default; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; }
.seg button { border: 0; border-radius: 0; }
.count { color: var(--muted); font-size: 14px; padding: 0 4px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; padding: 16px 0 60px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px;
  display: flex; flex-direction: column; gap: 10px; }
.card.now { outline: 3px solid var(--now); outline-offset: -1px; }
.card.fav { border-color: var(--star); }
.top { display: flex; align-items: flex-start; gap: 10px; }
.who { flex: 1; min-width: 0; }
.name { font-size: 22px; font-weight: 650; line-height: 1.2; }
.vid { font: 13px ui-monospace, "Cascadia Mono", Consolas, monospace; color: var(--muted); }
.meta { font-size: 14px; color: var(--muted); }
.chip { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--surface-2);
  color: var(--muted); margin-left: 6px; vertical-align: middle; }
.star { width: 48px; height: 48px; min-height: 48px; padding: 0; font-size: 24px; line-height: 1; flex: none; }
.star[aria-pressed="true"] { background: var(--star); border-color: var(--star); color: #1c1400; }
audio { width: 100%; height: 44px; }
textarea { width: 100%; min-height: 64px; resize: vertical; font: inherit; font-size: 15px; padding: 8px 10px;
  border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
.failed { color: #c0392b; }
.toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); background: var(--text); color: var(--bg);
  padding: 10px 16px; border-radius: 999px; opacity: 0; transition: opacity .2s; pointer-events: none; }
.toast.on { opacity: 1; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<header>
  <h1>Voice audition</h1>
  <p class="sub" id="sub"></p>
  <details class="passage"><summary>The passage</summary><div id="passage"></div></details>
</header>
<main>
  <div class="bar" role="toolbar" aria-label="Audition controls">
    <button id="blind" aria-pressed="false" title="Shuffle and hide names">Blind</button>
    <button id="reshuffle" hidden>Reshuffle</button>
    <div class="seg" role="group" aria-label="Show">
      <button data-show="all" aria-pressed="true">All</button>
      <button data-show="favs" aria-pressed="false">Favourites</button>
    </div>
    <div class="seg" role="group" aria-label="Accent" id="accent-seg">
      <button data-accent="all" aria-pressed="true">Any accent</button>
      <button data-accent="American" aria-pressed="false">American</button>
      <button data-accent="British" aria-pressed="false">British</button>
    </div>
    <div class="seg" role="group" aria-label="Gender" id="gender-seg">
      <button data-gender="all" aria-pressed="true">Any</button>
      <button data-gender="female" aria-pressed="false">Female</button>
      <button data-gender="male" aria-pressed="false">Male</button>
    </div>
    <span class="spacer"></span>
    <span class="count" id="count"></span>
    <button id="playfavs" class="primary">Play favourites</button>
    <button id="export">Export favourites</button>
  </div>
  <p class="failed" id="failed" hidden></p>
  <div class="grid" id="grid"></div>
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script type="application/json" id="manifest">__MANIFEST_JSON__</script>
<script>
/*<pure>*/
function letterFor(i) {
  var s = "", n = i + 1;
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function shuffled(ids, rand) {
  var a = ids.slice();
  for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
function blindLetters(order) {
  var m = {};
  (order || []).forEach(function (id, i) { m[id] = letterFor(i); });
  return m;
}
function favouritesDoc(manifest, state, now) {
  var favs = state.favs || {}, notes = state.notes || {}, letters = blindLetters(state.order);
  var note = function (id) { return String(notes[id] || "").trim(); };
  var favourites = [], other = [];
  manifest.voices.forEach(function (v) {
    if (favs[v.id]) {
      favourites.push({ voice: v.id, name: v.name, accent: v.accent, gender: v.gender,
        notes: note(v.id), blind_letter: letters[v.id] || null });
    } else if (note(v.id)) {
      other.push({ voice: v.id, notes: note(v.id), blind_letter: letters[v.id] || null });
    }
  });
  return {
    kind: "foray-voice-audition-favourites", version: 1, exported_at: now,
    foray_id: manifest.foray_id, passage_fingerprint: manifest.passage_fingerprint,
    model: manifest.model.name, speed: manifest.speed, blind_round: !!(state.order && state.order.length),
    favourites: favourites, other_notes: other
  };
}
/*</pure>*/
(function () {
  var M = JSON.parse(document.getElementById("manifest").textContent);
  var KEY = "foray-voice-audition:v1";
  var state = { favs: {}, notes: {}, blind: false, order: null, show: "all", accent: "all", gender: "all" };
  try { var saved = JSON.parse(localStorage.getItem(KEY) || "null"); if (saved && typeof saved === "object") Object.assign(state, saved); } catch (e) {}
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  var $ = function (id) { return document.getElementById(id); };
  var byId = {}; M.voices.forEach(function (v) { byId[v.id] = v; });
  var ids = M.voices.map(function (v) { return v.id; });

  $("sub").textContent = M.voices.length + " English Kokoro voices · " + M.model.name + " · " + M.speed.toFixed(1) +
    "× · the app's own q8f16 weights and phonemes · passage from Foray " + M.foray_id;
  M.passage.forEach(function (l) {
    var p = document.createElement("p"), r = document.createElement("span");
    r.className = "role"; r.textContent = l.role; p.appendChild(r); p.appendChild(document.createTextNode(" " + l.text));
    $("passage").appendChild(p);
  });
  if (M.failed && M.failed.length) {
    $("failed").hidden = false;
    $("failed").textContent = "Not rendered: " + M.failed.map(function (f) { return f.voice; }).join(", ");
  }

  var cards = {};
  ids.forEach(function (id) {
    var v = byId[id];
    var card = document.createElement("section"); card.className = "card"; card.dataset.voice = id;
    card.innerHTML =
      '<div class="top"><div class="who"><div class="name"></div><div class="vid"></div></div>' +
      '<button class="star" aria-pressed="false" aria-label="Favourite">☆</button></div>' +
      '<div class="meta"></div>' +
      '<audio controls preload="metadata"></audio>' +
      '<textarea placeholder="Notes: pace, warmth, how it handled TSMC…" aria-label="Notes"></textarea>';
    var audio = card.querySelector("audio"); audio.src = v.file;
    var star = card.querySelector(".star");
    star.addEventListener("click", function () { state.favs[id] = !state.favs[id]; if (!state.favs[id]) delete state.favs[id]; save(); paint(); });
    var ta = card.querySelector("textarea"); ta.value = state.notes[id] || "";
    ta.addEventListener("input", function () { state.notes[id] = ta.value; if (!ta.value.trim()) delete state.notes[id]; save(); });
    audio.addEventListener("play", function () {
      Object.keys(cards).forEach(function (o) { var a = cards[o].audio; if (o !== id && !a.paused) a.pause(); });
      if (queue.length && queue[qi] !== id) stopQueue();
    });
    audio.addEventListener("ended", function () { if (queue.length && queue[qi] === id) { qi++; playAt(); } });
    cards[id] = { el: card, audio: audio, star: star };
  });

  function order() {
    if (state.blind && state.order) {
      var known = state.order.filter(function (id) { return byId[id]; });
      ids.forEach(function (id) { if (known.indexOf(id) < 0) known.push(id); });
      return known;
    }
    return ids;
  }
  function visible(id) {
    var v = byId[id];
    if (state.show === "favs" && !state.favs[id]) return false;
    if (state.blind) return true;
    return (state.accent === "all" || v.accent === state.accent) && (state.gender === "all" || v.gender === state.gender);
  }
  function paint() {
    var letters = blindLetters(state.order), grid = $("grid");
    order().forEach(function (id) {
      var c = cards[id], v = byId[id];
      grid.appendChild(c.el);
      c.el.hidden = !visible(id);
      var fav = !!state.favs[id];
      c.el.classList.toggle("fav", fav);
      c.star.setAttribute("aria-pressed", String(fav)); c.star.textContent = fav ? "★" : "☆";
      var name = c.el.querySelector(".name"), vid = c.el.querySelector(".vid"), meta = c.el.querySelector(".meta");
      if (state.blind) {
        name.textContent = "Voice " + (letters[id] || "?"); vid.textContent = ""; meta.textContent = "";
      } else {
        name.textContent = v.name; vid.textContent = v.id;
        meta.textContent = v.accent + " · " + v.gender + " · " + v.audio_sec.toFixed(0) + " s · rendered in " + v.render_sec.toFixed(1) + " s";
        if (letters[id]) { var ch = document.createElement("span"); ch.className = "chip"; ch.textContent = "blind " + letters[id]; meta.appendChild(ch); }
      }
    });
    $("blind").setAttribute("aria-pressed", String(!!state.blind));
    $("reshuffle").hidden = !state.blind;
    document.querySelectorAll("[data-show]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.show === state.show)); });
    document.querySelectorAll("[data-accent]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.accent === state.accent)); b.disabled = !!state.blind; });
    document.querySelectorAll("[data-gender]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.gender === state.gender)); b.disabled = !!state.blind; });
    var n = Object.keys(state.favs).filter(function (id) { return byId[id]; }).length;
    $("count").textContent = n + " favourite" + (n === 1 ? "" : "s");
  }

  function toast(msg) { var t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove("on"); }, 2200); }
  function reshuffle() { state.order = shuffled(ids, Math.random); }

  $("blind").addEventListener("click", function () { state.blind = !state.blind; if (state.blind && !state.order) reshuffle(); save(); paint(); });
  $("reshuffle").addEventListener("click", function () { reshuffle(); save(); paint(); toast("Shuffled — new letters"); });
  document.querySelectorAll("[data-show]").forEach(function (b) { b.addEventListener("click", function () { state.show = b.dataset.show; save(); paint(); }); });
  document.querySelectorAll("[data-accent]").forEach(function (b) { b.addEventListener("click", function () { state.accent = b.dataset.accent; save(); paint(); }); });
  document.querySelectorAll("[data-gender]").forEach(function (b) { b.addEventListener("click", function () { state.gender = b.dataset.gender; save(); paint(); }); });

  var queue = [], qi = -1;
  function markNow(id) { Object.keys(cards).forEach(function (o) { cards[o].el.classList.toggle("now", o === id); }); }
  function stopQueue() { queue = []; qi = -1; markNow(null); $("playfavs").textContent = "Play favourites"; }
  function playAt() {
    if (qi < 0 || qi >= queue.length) { stopQueue(); toast("Done — that was every favourite"); return; }
    var id = queue[qi], a = cards[id].audio;
    markNow(id); a.currentTime = 0;
    cards[id].el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    var p = a.play(); if (p && p.catch) p.catch(function () { stopQueue(); });
  }
  $("playfavs").addEventListener("click", function () {
    if (queue.length) { var cur = cards[queue[qi]]; if (cur) cur.audio.pause(); stopQueue(); return; }
    var list = order().filter(function (id) { return state.favs[id]; });
    if (!list.length) { toast("Star a few voices first"); return; }
    queue = list; qi = 0; $("playfavs").textContent = "Stop"; playAt();
  });
  $("export").addEventListener("click", function () {
    var doc = favouritesDoc(M, state, new Date().toISOString());
    if (!doc.favourites.length) { toast("No favourites yet — exporting notes only"); }
    var blob = new Blob([JSON.stringify(doc, null, 2) + "\n"], { type: "application/json" });
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "favourites.json";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  paint();
})();
</script>
</body>
</html>
"""


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="report what is missing and exit")
    ap.add_argument("--render", action="store_true")
    ap.add_argument("--local", action="store_true",
                    help="the local audition: every English voice, the published passage, out/<voice>.wav + index.html")
    ap.add_argument("--work-dir", help="where --local keeps weights and output (default: data-local/voice-audition)")
    ap.add_argument("--page-only", action="store_true", help="with --local: rebuild index.html from out/audition.json")
    ap.add_argument("--threads", type=int, default=LOCAL_THREADS, help="with --local: ONNX Runtime intra-op threads")
    ap.add_argument("--voices", help="comma-separated voice ids (default: the twelve-voice slate)")
    ap.add_argument("--speeds", help="comma-separated speeds (default: 1.0)")
    ap.add_argument("--key-out", help="where to write the sealed label key")
    args = ap.parse_args(argv)

    if args.local:
        return main_local(args)

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


def main_local(args) -> int:
    work_dir = Path(args.work_dir).resolve() if args.work_dir else DEFAULT_WORK_DIR
    out_dir = work_dir / "out"
    if args.page_only:
        try:
            manifest = json.loads((out_dir / "audition.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"no manifest to rebuild the page from: {exc}", file=sys.stderr)
            return 1
        print(write_page(manifest, out_dir).resolve())
        return 0
    voices = args.voices.split(",") if args.voices else list(ENGLISH_VOICES)
    unknown = [v for v in voices if v not in ENGLISH_VOICES]
    if unknown:
        print(f"not English Kokoro v1.0 voices: {', '.join(unknown)}", file=sys.stderr)
        return 2
    try:
        manifest = render_local(voices, work_dir, log=lambda m: print(m, flush=True), threads=args.threads)
    except (MissingDependency, ImportError) as exc:
        print(f"cannot render the local audition: {exc}", file=sys.stderr)
        return 1
    print()
    print(f"phonemizer: {manifest['phonemizer']['g2p']}, fallback {manifest['phonemizer']['fallback']}")
    print(f"rendered {len(manifest['voices'])} voices, failed {len(manifest['failed'])}")
    print(f"open: {(out_dir / 'index.html').resolve()}")
    return 0 if not manifest["failed"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
