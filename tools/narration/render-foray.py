#!/usr/bin/env python3
"""Render every narration line of a Foray to a file, centrally, once.

`docs/plans/spark-central-narration-assessment.md` §3.2 and the Phase 1 fast
path in §5. The founder accepted rulings D1-D11 on 2026-09-28 ("Defaults"):
narration is rendered centrally (D1) at 1.0x (D2) in Heart and Echo (D4), as
AAC-LC `.m4a`, 64 kbps mono (D5), for a public bucket at audio.jwlabs.ai (D6).

WHAT IT DOES, per narration item, per voice:

  1. phonemize the script with K-02's own stage (`phonemize.py`: the lexicon
     first, misaki en-US, espeak-ng for what misaki cannot look up) and cut it
     with `sentence_chunks`, D3's one chunk rule;
  2. synthesize each chunk with Kokoro-82M **fp32** through onnxruntime on the
     CPU (the graph and bytes `tools/mobile/fetch-models.mjs` pins; never
     fp16/q8f16, which returned NaN on ARM), style row `len(ids) - 2`;
  3. REJECT a chunk that is non-finite or silent, and an item whose spoken
     length is outside [0.5, 2.0] x the 17 chars/s estimate. A rejected item
     is reported and left script-only; it is never replaced by anything else;
  4. trim the item's lead and tail silence, join the chunks with 0.08 s (each
     chunk keeps Kokoro's own sentence-edge breath, so that is the natural
     pause), pad 0.5 s at each end;
  5. loudness-normalize: ffmpeg `loudnorm` measures the line (pass 1), then ONE
     linear gain takes it to -19 LUFS integrated on the mono file (-16 LUFS as
     heard), capped so the true peak stays at or under -1 dBTP (pass 2). Never
     loudnorm's dynamic mode, which would compress the voice; output loudness
     is measured again on the encoded file and recorded;
  6. encode AAC-LC `.m4a`, 64 kbps, mono, 24 kHz, faststart, with an MP4
     comment marking it synthetic speech (EU AI Act Art. 50(2), §3.5);
  7. name it by CONTENT: `n/<profile>/<voice>/<sha256>.m4a`, the hash of the
     voice, its weights' sha256, the model's sha256, the phonemes as chunked
     and every render setting (`render-profile.json` `render`). An edit
     re-renders only the lines whose phonemes changed; a stamped line whose key
     still matches is reported `unchanged` and not rendered at all;
  8. measure `duration_sec` by decoding the file as a player does, reject it if
     it is more than 50 ms from the rendered PCM, and write one manifest.

NO CREDENTIALS. This file never uploads and reads no secret, so it may run in
GitHub Actions (`.github/workflows/render-narration.yml`). Uploading is
`upload-narration.mjs`, which runs only where the founder placed a token.
espeak-ng (GPL) runs here, server/CI side, and never enters an app build.

USAGE
    python tools/narration/render-foray.py --check
    python tools/narration/render-foray.py --forays @drafts
    python tools/narration/render-foray.py --forays the-chain-reaction-how-engineering-disasters-rea-25f1b7 --voices af_heart
    python tools/narration/render-foray.py --smoke            # 2 short items, CPU, both voices
    python tools/narration/render-foray.py --report out/manifest.json
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PROFILE_PATH = HERE / "render-profile.json"
FORAYS_PATH = REPO_ROOT / "data" / "forays.json"
FETCH_MODELS_PATH = REPO_ROOT / "tools" / "mobile" / "fetch-models.mjs"
LEXICON_PATH = REPO_ROOT / "mobile" / "plugins" / "foray-tts" / "lexicon" / "hard-terms.json"
DEFAULT_OUT_DIR = REPO_ROOT / "data-local" / "narration-render"
DEFAULT_WEIGHTS_DIR = REPO_ROOT / "data-local" / "narration-weights"

MANIFEST_KIND = "foray-narration-render"
MANIFEST_VERSION = 1
#: Bumped only if the KEY MATERIAL's own shape changes (not the settings in it).
KEY_SCHEMA = 1

STYLE_DIM = 256
STYLE_ROWS = 510
VOICE_BYTES = 522240
VOICE_URL = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/{voice}.bin"
VOICE_ID_RE = re.compile(r"^(af|am|bf|bm)_[a-z]+$")
DRAFTS = "@drafts"

#: The manifest entry's keys, in order. The card's required six plus what the
#: stamp step needs to prove the render is of THIS script and lexicon.
ENTRY_KEYS = (
    "foray_id", "item_id", "voice", "status", "key", "bytes", "duration_sec", "sha256", "profile",
    "text_sha256", "lexicon_sha", "chunks", "speech_sec", "estimate_sec", "container_sec", "loudness",
)


class RenderError(RuntimeError):
    """A refusal with a reason. Never papered over with a substitute file."""


def log(msg: str) -> None:
    print(msg, flush=True)


# ============================================================== pure helpers


def load_profile(path: Path = PROFILE_PATH) -> dict:
    profile = json.loads(path.read_text(encoding="utf-8"))
    for field in ("id", "model", "voices", "default_voice", "render", "reject", "key_prefix"):
        if field not in profile:
            raise RenderError(f"{path.name} has no `{field}`")
    if profile["default_voice"] not in profile["voices"]:
        raise RenderError(f"{path.name}: default_voice {profile['default_voice']} is not one of its voices")
    if float(profile["render"]["speed"]) != 1.0:
        # D2: render once at 1.0x; the player speeds narration to the listener.
        raise RenderError(f"{path.name}: render.speed must be 1.0 (ruling D2)")
    return profile


def canonical_json(obj) -> str:
    """Sorted keys, compact separators, UTF-8 kept: the one byte form a key is
    hashed from, so Python and any later reader agree on it."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def key_material(profile: dict, voice: str, voice_sha256: str, model_sha256: str, chunks: list[str]) -> dict:
    """Everything that changes the bytes of one rendered line, and nothing else.

    NOT in it: the Foray id, the item id, the script's raw text. Two lines that
    phonemize identically are one object (the ElevenLabs-era cache rule in
    `tools/narrate/cache.mjs`: beat identity is deliberately not in the key).
    A typo fix that does not change the phonemes does not re-render."""
    return {
        "schema": KEY_SCHEMA,
        "profile": profile["id"],
        "render": profile["render"],
        "model_sha256": model_sha256,
        "voice": voice,
        "voice_sha256": voice_sha256,
        "chunks": list(chunks),
    }


def render_key(profile: dict, voice: str, voice_sha256: str, model_sha256: str, chunks: list[str]) -> str:
    """`n/<profile>/<voice>/<sha256>.m4a` — the object key and the local path."""
    if not VOICE_ID_RE.match(voice):
        raise RenderError(f"{voice!r} is not a Kokoro voice id")
    if not chunks:
        raise RenderError("a line with no phoneme chunks has nothing to render")
    digest = sha256_text(canonical_json(key_material(profile, voice, voice_sha256, model_sha256, chunks)))
    return f"{profile['key_prefix']}/{profile['id']}/{voice}/{digest}.m4a"


def estimate_seconds(script: str, chars_per_sec: float) -> float:
    return round(len(script.strip()) / chars_per_sec, 3)


def narration_items(foray: dict) -> list[dict]:
    return [
        i for i in foray.get("items", [])
        if i.get("type") == "narration" and isinstance(i.get("script"), str) and i["script"].strip()
    ]


def select_forays(doc: dict, spec: list[str]) -> list[dict]:
    """The Forays to render, in the order asked. `@drafts` is every narrated
    draft (Phase 1 renders drafts only; a published Foray waits for the
    player's fallback, assessment §5 Phase 2). An unknown id, or a Foray with
    no narration, is a refusal — never a silent skip."""
    forays = doc.get("forays", [])
    by_id = {f.get("id"): f for f in forays}
    out: list[dict] = []
    for want in spec:
        if want == DRAFTS:
            picked = [f for f in forays if f.get("status") == "draft" and narration_items(f)]
            if not picked:
                raise RenderError("@drafts matched no narrated draft Foray in data/forays.json")
        elif want in by_id:
            if not narration_items(by_id[want]):
                raise RenderError(f"{want} has no narration item with a script")
            picked = [by_id[want]]
        else:
            raise RenderError(f"{want} is not a Foray id in data/forays.json")
        for f in picked:
            if f not in out:
                out.append(f)
    return out


def smoke_selection(forays: list[dict], n: int = 2) -> list[tuple[dict, list[dict]]]:
    """--smoke: the n shortest scripts of the first selected Foray, in order."""
    foray = forays[0]
    items = narration_items(foray)
    keep = sorted(sorted(range(len(items)), key=lambda i: len(items[i]["script"]))[:n])
    return [(foray, [items[i] for i in keep])]


def stamped_url(item: dict, voice: str, default_voice: str):
    """The URL data/forays.json already carries for this line in this voice."""
    if voice == default_voice:
        return item.get("audio_url")
    voices = item.get("voices")
    if isinstance(voices, dict) and isinstance(voices.get(voice), dict):
        return voices[voice].get("audio_url")
    return None


def stamped_duration(item: dict, voice: str, default_voice: str):
    if voice == default_voice:
        return item.get("duration_sec")
    v = (item.get("voices") or {}).get(voice) or {}
    return v.get("duration_sec")


def is_unchanged(item: dict, voice: str, default_voice: str, key: str) -> bool:
    url = stamped_url(item, voice, default_voice)
    return isinstance(url, str) and url.endswith("/" + key)


def manifest_entry(**fields) -> dict:
    """One manifest row, with every key in ENTRY_KEYS present (None when not
    applicable, e.g. `bytes` of an `unchanged` line), in that order."""
    unknown = set(fields) - set(ENTRY_KEYS)
    if unknown:
        raise ValueError(f"unknown manifest fields: {sorted(unknown)}")
    return {k: fields.get(k) for k in ENTRY_KEYS}


def manifest_doc(profile: dict, model: dict, voices: dict, tools: dict, entries: list[dict], failed: list[dict]) -> dict:
    rendered = [e for e in entries if e["status"] == "rendered"]
    return {
        "kind": MANIFEST_KIND,
        "version": MANIFEST_VERSION,
        "profile": profile["id"],
        "model": model,
        "voices": voices,
        "tools": tools,
        "totals": {
            "items": len(entries),
            "rendered": len(rendered),
            "unchanged": len(entries) - len(rendered),
            "failed": len(failed),
            "bytes": sum(e["bytes"] or 0 for e in rendered),
            "duration_sec": round(sum(e["duration_sec"] or 0 for e in entries), 3),
        },
        "items": entries,
        "failed": failed,
    }


def report_markdown(manifest: dict) -> str:
    """A table for $GITHUB_STEP_SUMMARY: per Foray and voice, items, minutes, MB."""
    rows: dict[tuple[str, str], dict] = {}
    for e in manifest.get("items", []):
        r = rows.setdefault((e["foray_id"], e["voice"]), {"items": 0, "sec": 0.0, "bytes": 0, "unchanged": 0})
        r["items"] += 1
        r["sec"] += e.get("duration_sec") or 0
        r["bytes"] += e.get("bytes") or 0
        r["unchanged"] += 1 if e.get("status") == "unchanged" else 0
    lines = [
        f"### Narration render `{manifest.get('profile')}`",
        "",
        "| Foray | Voice | Items | Unchanged | Minutes | MB | kbps (avg) |",
        "|---|---|---:|---:|---:|---:|---:|",
    ]
    for (fid, voice), r in rows.items():
        kbps = (r["bytes"] * 8 / 1000 / r["sec"]) if r["sec"] and r["bytes"] else 0
        lines.append(
            f"| {fid} | {voice} | {r['items']} | {r['unchanged']} | {r['sec'] / 60:.1f} | {r['bytes'] / 1e6:.2f} | {kbps:.0f} |"
        )
    t = manifest.get("totals", {})
    lines += ["", f"Total: {t.get('items', 0)} lines, {t.get('duration_sec', 0) / 60:.1f} min, "
                  f"{t.get('bytes', 0) / 1e6:.2f} MB rendered, {t.get('failed', 0)} failed."]
    for f in manifest.get("failed", []):
        lines.append(f"- FAILED {f.get('foray_id')} / {f.get('item_id')} / {f.get('voice')}: {f.get('error')}")
    return "\n".join(lines) + "\n"


# =================================================================== weights


def read_pins(path: Path = FETCH_MODELS_PATH) -> dict:
    """Model and voice pins, parsed out of fetch-models.mjs so the repository
    keeps ONE table of hashes (render-audition.py and bench-narration.py read
    it the same way)."""
    src = path.read_text(encoding="utf-8")
    models = {
        name: {"name": name, "url": url, "sha256": sha, "bytes": int(n)}
        for name, url, sha, n in re.findall(
            r'name: "(kokoro-v1_0-[a-z0-9]+\.onnx)",\s*url: "([^"]+)",\s*sha256: "([0-9a-f]{64})",\s*bytes: (\d+)', src
        )
    }
    voices = {
        v: {"sha256": sha, "bytes": int(n), "url": VOICE_URL.format(voice=v)}
        for v, sha, n in re.findall(r'\["([a-z]{2}_[a-z]+)", "([0-9a-f]{64})", (\d+)\]', src)
    }
    return {"models": models, "voices": voices}


def model_pin(profile: dict, pins: dict) -> dict:
    pin = pins["models"].get(profile["model"])
    if pin is None:
        raise RenderError(f"{profile['model']} has no pin in tools/mobile/fetch-models.mjs")
    return pin


def voice_pin(voice: str, profile: dict, pins: dict) -> dict:
    """fetch-models.mjs first; the profile's recorded pin only where none exists."""
    pin = pins["voices"].get(voice)
    if pin is not None:
        return {**pin, "pinned_by": "tools/mobile/fetch-models.mjs"}
    rec = profile.get("recorded_voice_pins", {}).get(voice)
    if rec is not None:
        return {**rec, "url": rec.get("url") or VOICE_URL.format(voice=voice), "pinned_by": "tools/narration/render-profile.json"}
    raise RenderError(f"{voice} has no pin in fetch-models.mjs and no recorded pin in render-profile.json")


def weight_search_dirs(extra: list[Path]) -> list[Path]:
    return [
        *extra,
        REPO_ROOT / "mobile" / "models",
        REPO_ROOT / "data-local" / "voice-audition" / "model",
        REPO_ROOT / "data-local" / "voice-audition" / "voices",
        REPO_ROOT / "data-local" / "narration-bench" / "voices",
    ]


def _download(url: str, dest: Path) -> None:
    import urllib.request

    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "foray-narration-render"})
    with urllib.request.urlopen(req, timeout=300) as resp, part.open("wb") as fh:
        while True:
            block = resp.read(1 << 20)
            if not block:
                break
            fh.write(block)
    part.replace(dest)


def ensure_file(name: str, pin: dict, dest_dir: Path, search: list[Path], allow_download: bool) -> Path:
    """A verified local copy of one pinned file; a hash mismatch is never used."""
    for d in [dest_dir, *search]:
        p = d / name
        if p.exists() and p.stat().st_size == pin["bytes"] and sha256_file(p) == pin["sha256"]:
            return p
    if not allow_download:
        raise RenderError(f"{name} is not on disk (with its pinned sha256) and --no-download was given")
    dest = dest_dir / name
    log(f"fetching {name} ({pin['bytes']:,} bytes)")
    _download(pin["url"], dest)
    got = sha256_file(dest)
    if got != pin["sha256"] or dest.stat().st_size != pin["bytes"]:
        dest.unlink(missing_ok=True)
        raise RenderError(f"{name}: downloaded sha256 {got} does not match the pin {pin['sha256']}")
    return dest


# ===================================================================== audio


def chunk_problem(audio, min_peak: float):
    """Why a synthesized chunk must not be used, or None."""
    import numpy as np

    if audio.size == 0:
        return "empty output"
    if not bool(np.isfinite(audio).all()):
        return f"{int((~np.isfinite(audio)).sum())} non-finite samples (NaN/Inf)"
    peak = float(np.abs(audio).max())
    if peak < min_peak:
        return f"silent (peak {peak:.5f} < {min_peak})"
    return None


def trim_edges(audio, sample_rate: int, threshold_dbfs: float, keep_sec: float):
    """Cut leading and trailing near-silence, keeping `keep_sec` of it."""
    import numpy as np

    thr = 10 ** (threshold_dbfs / 20)
    loud = np.flatnonzero(np.abs(audio) > thr)
    if loud.size == 0:
        return audio[:0]
    keep = int(round(keep_sec * sample_rate))
    start = max(0, int(loud[0]) - keep)
    end = min(audio.size, int(loud[-1]) + 1 + keep)
    return audio[start:end]


def assemble(chunks: list, render: dict):
    """Chunks -> one line: joined with the gap, edges trimmed, padded."""
    import numpy as np

    sr = int(render["sample_rate"])
    gap = np.zeros(int(round(render["chunk_gap_sec"] * sr)), dtype=np.float32)
    parts = []
    for i, c in enumerate(chunks):
        if i:
            parts.append(gap)
        parts.append(np.asarray(c, dtype=np.float32).reshape(-1))
    joined = np.concatenate(parts)
    t = render["edge_trim"]
    speech = trim_edges(joined, sr, float(t["threshold_dbfs"]), float(t["keep_sec"]))
    pad = int(round(render["edge_pad_sec"] * sr))
    # The tail pad is stretched (by < 1 frame of silence) so the line is a whole
    # number of AAC frames: the encoder then has no partial last frame to round,
    # and the decoded length equals this PCM length.
    tail = tail_pad_samples(pad, speech.size, int(render.get("frame_samples", 1024)))
    return speech, np.concatenate([np.zeros(pad, dtype=np.float32), speech, np.zeros(tail, dtype=np.float32)])


def tail_pad_samples(pad: int, speech_samples: int, frame: int) -> int:
    """The tail pad, stretched to make lead pad + speech + tail a whole number of frames."""
    return pad + (-(pad + speech_samples + pad) % frame)


def _ffmpeg_json(stderr: str) -> dict:
    start, end = stderr.rfind("{"), stderr.rfind("}")
    if start < 0 or end < start:
        raise RenderError("ffmpeg loudnorm printed no JSON")
    return json.loads(stderr[start:end + 1])


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RenderError(f"{Path(cmd[0]).name} exited {r.returncode}: {r.stderr.strip()[-600:]}")
    return r


def measure_filter(render: dict) -> str:
    """ffmpeg `loudnorm` in measure-only use: it prints the EBU R128 integrated
    loudness and true peak of the input as JSON; its own output is discarded."""
    L = render["loudness"]
    return f"loudnorm=I={L['integrated_lufs']}:TP={L['true_peak_dbtp']}:LRA={L['lra']}:print_format=json"


def linear_gain_db(render: dict, input_i: float, input_tp: float) -> tuple[float, str]:
    """ONE gain for the whole line: to the integrated target, but never past the
    true-peak ceiling. This is loudnorm's own `linear=true` rule, without its
    fallback to dynamic compression when the peak would clip: a line with an
    unusually hot peak comes out slightly quieter, never squashed. Returns
    (gain dB, "linear" | "linear-peak-limited")."""
    L = render["loudness"]
    to_target = float(L["integrated_lufs"]) - input_i
    # AAC re-synthesis overshoots the input's true peak slightly (the smoke run
    # measured +0.2 dB), so the cap keeps `encoder_headroom_db` in hand.
    to_ceiling = float(L["true_peak_dbtp"]) - float(L.get("encoder_headroom_db", 0)) - input_tp
    if to_target <= to_ceiling:
        return round(to_target, 2), "linear"
    return round(to_ceiling, 2), "linear-peak-limited"


def encode_command(ffmpeg: str, wav: Path, out: Path, render: dict, gain_db: float) -> list[str]:
    """Gain, then AAC-LC. `volume` keeps the sample count exactly, which is what
    lets the measured PCM duration be the duration the player plays."""
    e = render["encode"]
    cmd = [
        ffmpeg, "-hide_banner", "-nostdin", "-y", "-i", str(wav),
        "-af", f"volume={gain_db}dB",
        "-c:a", e["codec"], "-b:a", f"{e['bitrate_kbps']}k", "-ac", str(e["channels"]), "-ar", str(e["sample_rate"]),
        "-map_metadata", "-1", "-metadata", f"comment={render['metadata']['comment']}",
        "-fflags", "+bitexact", "-flags:a", "+bitexact",
    ]
    if e.get("faststart"):
        cmd += ["-movflags", "+faststart"]
    return cmd + [str(out)]


def _measure(ffmpeg: str, src: Path, render: dict) -> dict:
    r = _run([ffmpeg, "-hide_banner", "-nostdin", "-i", str(src), "-af", measure_filter(render), "-f", "null", "-"])
    m = _ffmpeg_json(r.stderr)
    if not all(_finite_str(m.get(k)) for k in ("input_i", "input_tp")):
        raise RenderError(f"loudnorm could not measure {src.name}: {m}")
    return {"i": float(m["input_i"]), "tp": float(m["input_tp"])}


def decoded_seconds(ffmpeg: str, src: Path, sample_rate: int) -> float:
    """Decode the file as a player would (edit list honoured) and count samples."""
    r = subprocess.run(
        [ffmpeg, "-v", "error", "-nostdin", "-i", str(src), "-f", "s16le", "-ac", "1", "-ar", str(sample_rate), "-"],
        capture_output=True,
    )
    if r.returncode != 0:
        raise RenderError(f"ffmpeg could not decode {src.name}: {r.stderr.decode(errors='replace')[-300:]}")
    return round(len(r.stdout) / 2 / sample_rate, 3)


def normalize_and_encode(ffmpeg: str, ffprobe: str, pcm, out: Path, render: dict, tmp: Path) -> dict:
    import soundfile as sf

    wav = tmp / (out.stem + ".wav")
    sf.write(str(wav), pcm, int(render["sample_rate"]), subtype="FLOAT")
    try:
        before = _measure(ffmpeg, wav, render)
        gain, kind = linear_gain_db(render, before["i"], before["tp"])
        out.parent.mkdir(parents=True, exist_ok=True)
        _run(encode_command(ffmpeg, wav, out, render, gain))
    finally:
        wav.unlink(missing_ok=True)
    after = _measure(ffmpeg, out, render)
    probe = _run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(out)])
    return {
        "input_i": before["i"],
        "input_tp": before["tp"],
        "gain_db": gain,
        "output_i": after["i"],
        "output_tp": after["tp"],
        "type": kind,
        "decoded_sec": decoded_seconds(ffmpeg, out, int(render["encode"]["sample_rate"])),
        "container_sec": round(float(probe.stdout.strip()), 3),
    }


def _finite_str(v) -> bool:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return False
    return f == f and f not in (float("inf"), float("-inf"))


# ================================================================= rendering


def _load_phonemize():
    spec = importlib.util.spec_from_file_location("foray_phonemize", HERE / "phonemize.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _pkg_version(name: str) -> str:
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:
        return "?"


def _tool_version(exe: str | None) -> str:
    if not exe:
        return "missing"
    try:
        r = subprocess.run([exe, "-version"], capture_output=True, text=True)
        return r.stdout.splitlines()[0] if r.stdout else "?"
    except OSError:
        return "missing"


def phonemize_work(work: list[tuple[dict, list[dict]]]) -> tuple[list[dict], dict]:
    """Every selected line -> {foray_id, item, chunks, ids | error}. Done once,
    for all voices, and the G2P freed before the ONNX session loads."""
    P = _load_phonemize()
    g2p = P.load_backend()
    entries, vocab = P.load_lexicon(), P.load_vocab()
    fallback = getattr(g2p, "fallback", None)
    phon = {
        "g2p": "misaki en-US " + _pkg_version("misaki"),
        "fallback": "espeak-ng" if fallback is not None else "none",
        "vocab": P.vocab_sha(vocab),
    }
    lines = []
    for foray, items in work:
        for item in items:
            row = {"foray_id": foray["id"], "item": item, "chunks": [], "ids": [], "error": None}
            try:
                res = P.phonemize_script(item["script"].strip(), entries, g2p)
                row["chunks"] = P.sentence_chunks(res["phonemes"])
                row["ids"] = [P.ids_for(c, vocab) for c in row["chunks"]]
                if not row["chunks"]:
                    row["error"] = "phonemized to nothing"
            except P.UnsingablePhoneme as exc:
                row["error"] = f"unsingable: {exc}"
            lines.append(row)
    del g2p
    gc.collect()
    return lines, phon


def render_all(args, profile: dict) -> int:
    import numpy as np

    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise RenderError("ffmpeg and ffprobe must be on PATH (apt-get install ffmpeg)")

    doc = json.loads(FORAYS_PATH.read_text(encoding="utf-8"))
    spec = args.forays.split(",") if args.forays else [DRAFTS]
    forays = select_forays(doc, [s.strip() for s in spec if s.strip()])
    work = smoke_selection(forays) if args.smoke else [(f, narration_items(f)) for f in forays]
    voices = args.voices.split(",") if args.voices else list(profile["voices"])
    for v in voices:
        if v not in profile["voices"]:
            raise RenderError(f"{v} is not a voice in render-profile.json ({', '.join(profile['voices'])})")

    pins = read_pins()
    mpin = model_pin(profile, pins)
    vpins = {v: voice_pin(v, profile, pins) for v in voices}
    weights_dir = Path(args.weights_dir).resolve() if args.weights_dir else DEFAULT_WEIGHTS_DIR
    search = weight_search_dirs([])
    model_path = ensure_file(profile["model"], mpin, weights_dir / "model", search, not args.no_download)
    voice_paths = {v: ensure_file(f"{v}.bin", vpins[v], weights_dir / "voices", search, not args.no_download) for v in voices}

    n_items = sum(len(items) for _, items in work)
    log(f"phonemizing {n_items} narration line(s) from {len(work)} Foray(s)")
    lines, phon = phonemize_work(work)

    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = args.threads
    session = ort.InferenceSession(str(model_path), opts, providers=["CPUExecutionProvider"])

    out_dir = Path(args.out).resolve() if args.out else DEFAULT_OUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="render-", dir=str(out_dir)))
    render, reject = profile["render"], profile["reject"]
    lexicon_sha = sha256_file(LEXICON_PATH) if LEXICON_PATH.exists() else None
    default_voice = profile["default_voice"]
    entries: list[dict] = []
    failed: list[dict] = []
    total = len(lines) * len(voices)
    n = 0
    try:
        for voice in voices:
            style = np.fromfile(voice_paths[voice], dtype=np.float32).reshape(STYLE_ROWS, STYLE_DIM)
            for line in lines:
                n += 1
                item = line["item"]
                tag = f"[{n}/{total}] {line['foray_id']} / {item['id']} / {voice}"
                base = {"foray_id": line["foray_id"], "item_id": item["id"], "voice": voice}
                if line["error"]:
                    failed.append({**base, "error": line["error"]})
                    log(f"{tag}: FAILED {line['error']}")
                    continue
                key = render_key(profile, voice, vpins[voice]["sha256"], mpin["sha256"], line["chunks"])
                common = dict(
                    base, key=key, profile=profile["id"], text_sha256=sha256_text(item["script"]),
                    lexicon_sha=lexicon_sha, chunks=len(line["chunks"]),
                    estimate_sec=estimate_seconds(item["script"], reject["estimate_chars_per_sec"]),
                )
                if not args.rerender and is_unchanged(item, voice, default_voice, key):
                    entries.append(manifest_entry(**common, status="unchanged",
                                                  duration_sec=stamped_duration(item, voice, default_voice)))
                    log(f"{tag}: unchanged ({key})")
                    continue
                out = out_dir / key
                sidecar = out.with_suffix(".json")
                if out.exists() and sidecar.exists():
                    prior = json.loads(sidecar.read_text(encoding="utf-8"))
                    if prior.get("sha256") == sha256_file(out) and prior.get("key") == key:
                        entries.append(manifest_entry(**{**prior, **common, "status": "rendered"}))
                        log(f"{tag}: reused {key}")
                        continue
                t0 = time.perf_counter()
                try:
                    audio = []
                    for ci, ids in enumerate(line["ids"]):
                        row = style[max(0, min(len(ids) - 2, STYLE_ROWS - 1))].reshape(1, STYLE_DIM)
                        a = session.run(None, {
                            "input_ids": np.array([ids], dtype=np.int64),
                            "style": row,
                            "speed": np.array([float(render["speed"])], dtype=np.float32),
                        })[0]
                        a = np.asarray(a, dtype=np.float32).reshape(-1)
                        why = chunk_problem(a, float(reject["min_chunk_peak"]))
                        if why:
                            raise RenderError(f"chunk {ci + 1}/{len(line['ids'])}: {why}")
                        audio.append(a)
                    speech, pcm = assemble(audio, render)
                    sr = int(render["sample_rate"])
                    speech_sec = round(speech.size / sr, 3)
                    lo, hi = reject["length_ratio"]
                    ratio = speech_sec / common["estimate_sec"] if common["estimate_sec"] else 0
                    if not (lo <= ratio <= hi):
                        raise RenderError(
                            f"spoken length {speech_sec} s is {ratio:.2f}x the {common['estimate_sec']} s estimate, "
                            f"outside [{lo}, {hi}]"
                        )
                    pcm_sec = round(pcm.size / sr, 3)
                    loud = normalize_and_encode(ffmpeg, ffprobe, pcm, out, render, tmp)
                    # duration_sec is what a player decodes (edit list honoured),
                    # and it must agree with the PCM we rendered.
                    duration = loud.pop("decoded_sec")
                    drift = abs(duration - pcm_sec)
                    if drift > float(reject["max_container_drift_sec"]):
                        out.unlink(missing_ok=True)
                        raise RenderError(f"decodes to {duration} s, PCM is {pcm_sec} s ({drift:.3f} s apart)")
                    data = out.read_bytes()
                    container_sec = loud.pop("container_sec")
                    entry = manifest_entry(
                        **common, status="rendered", bytes=len(data), duration_sec=duration,
                        sha256=sha256_bytes(data), speech_sec=speech_sec,
                        container_sec=container_sec, loudness=loud,
                    )
                    sidecar.write_text(json.dumps(entry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                    entries.append(entry)
                    log(f"{tag}: {duration:.3f} s (pcm {pcm_sec}, container {container_sec}), {len(data) / 1000:.0f} kB, "
                        f"{entry['loudness']['output_i']:.1f} LUFS / {entry['loudness']['output_tp']:.1f} dBTP "
                        f"({entry['loudness']['type']}, {entry['loudness']['gain_db']:+.1f} dB) in {time.perf_counter() - t0:.1f} s")
                except RenderError as exc:
                    failed.append({**base, "error": str(exc)})
                    log(f"{tag}: FAILED {exc}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    tools = {
        "onnxruntime": ort.__version__,
        "phonemizer": phon,
        "ffmpeg": _tool_version(ffmpeg),
        "threads": args.threads,
        "provider": "CPUExecutionProvider",
    }
    manifest = manifest_doc(
        profile,
        {"name": profile["model"], "sha256": mpin["sha256"]},
        {v: {"sha256": vpins[v]["sha256"], "pinned_by": vpins[v]["pinned_by"]} for v in voices},
        tools, entries, failed,
    )
    mpath = Path(args.manifest).resolve() if args.manifest else out_dir / "manifest.json"
    mpath.parent.mkdir(parents=True, exist_ok=True)
    with mpath.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    t = manifest["totals"]
    log(f"\n{t['rendered']} rendered, {t['unchanged']} unchanged, {t['failed']} failed; "
        f"{t['duration_sec'] / 60:.1f} min, {t['bytes'] / 1e6:.2f} MB -> {mpath}")
    return 0 if not failed else 1


# ====================================================================== main


def cmd_check(profile: dict) -> int:
    ready = True
    print(f"profile: {profile['id']} (voices {', '.join(profile['voices'])}, default {profile['default_voice']})")
    try:
        pins = read_pins()
        mp = model_pin(profile, pins)
        print(f"model pin: {mp['name']} sha256 {mp['sha256'][:12]}... {mp['bytes']:,} B")
        for v in profile["voices"]:
            vp = voice_pin(v, profile, pins)
            print(f"voice pin: {v} sha256 {vp['sha256'][:12]}... ({vp['pinned_by']})")
    except RenderError as exc:
        print(f"pins: NOT OK: {exc}")
        ready = False
    for mod in ("numpy", "onnxruntime", "soundfile", "misaki"):
        ok = importlib.util.find_spec(mod) is not None
        print(f"python module {mod}: {'ok' if ok else 'MISSING'}")
        ready &= ok
    for exe in ("ffmpeg", "ffprobe"):
        path = shutil.which(exe)
        print(f"{exe}: {path or 'MISSING'}")
        ready &= bool(path)
    if not ready:
        print("\nNOT READY. Install: pip install -r tools/narration/requirements.txt; "
              "apt-get install espeak-ng ffmpeg (weights are fetched and sha256-checked on first render).")
        return 1
    print("ready to render.")
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="report what is installed and pinned, then exit")
    ap.add_argument("--forays", help=f"comma-separated Foray ids, or {DRAFTS} (default)")
    ap.add_argument("--voices", help="comma-separated voices (default: the profile's, Heart and Echo)")
    ap.add_argument("--smoke", action="store_true", help="the 2 shortest lines of the first selected Foray only")
    ap.add_argument("--out", help="output directory (default data-local/narration-render)")
    ap.add_argument("--manifest", help="manifest path (default <out>/manifest.json)")
    ap.add_argument("--weights-dir", help="where fetched weights live (default data-local/narration-weights)")
    ap.add_argument("--no-download", action="store_true", help="refuse to fetch weights")
    ap.add_argument("--rerender", action="store_true", help="render lines data/forays.json already stamps with the same key")
    ap.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 1), help="onnxruntime intra-op threads")
    ap.add_argument("--report", nargs="+", metavar="MANIFEST", help="print a markdown summary of manifest(s) and exit")
    args = ap.parse_args(argv)

    try:
        if args.report:
            for p in args.report:
                sys.stdout.write(report_markdown(json.loads(Path(p).read_text(encoding="utf-8"))))
            return 0
        profile = load_profile()
        if args.check:
            return cmd_check(profile)
        # Validate the selection BEFORE anything heavy loads, so a typo'd id
        # costs a second, not a model load.
        doc = json.loads(FORAYS_PATH.read_text(encoding="utf-8"))
        select_forays(doc, [s.strip() for s in (args.forays or DRAFTS).split(",") if s.strip()])
        return render_all(args, profile)
    except RenderError as exc:
        print(f"render-foray: {exc}", file=sys.stderr)
        return 2
    except ImportError as exc:
        print(f"render-foray: missing dependency: {exc}. Run with --check.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
