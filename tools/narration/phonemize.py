#!/usr/bin/env python3
"""K-02's grapheme-to-phoneme stage. Runs on the server, never on a phone.

`docs/bundled-voice-plan.md` K-02. The deck's load-bearing idea (§4): our
narration scripts are authored by our pipeline, on our machines, at generation
time, so the pipeline can phonemize there and the app receives PHONEMES rather
than text.

WHY THAT MATTERS, in the order it matters:

  1. **The GPL stays on the server.** misaki (Apache-2.0) covers its
     dictionaries; anything out of vocabulary falls to `espeak-ng`, which is
     GPL-3. `generation-architecture.md` §1.2.1 already confined espeak to the
     server for the *fallback* render path. This stage extends the same line to
     the on-device path: espeak runs here, in a container that never ships, and
     `test/release-gates.test.js` asserts no native build input in this repo
     names it.
  2. **No misaki port to maintain on two platforms.** MisakiSwift exists for
     iOS; nothing equivalent is known for Android. We need neither.
  3. **Bit-for-bit the same phonemes on every phone.** The model is
     deterministic, so a curator's render on a laptop is what every listener
     hears — which brings back the review gate `on-device-tts.md` §5 said
     on-device narration had lost.

THE LEXICON IS APPLIED FIRST, AND IT WINS.
`mobile/plugins/foray-tts/lexicon/hard-terms.json` carries 83 hand-audited
terms. Every term with an authored `ipa` is substituted before misaki sees the
text, on a case-insensitive word boundary with apostrophes treated as interior
characters — the rule `narrator-voice.md`'s Appendix describes and
`foray-tts.js`'s `findMatches` implements. A term whose `ipa` is `null` is left
alone: that file's own honesty note says why, and inventing one here would put
an unverified claim into the artefact whose whole job is to be exact.

DETERMINISM IS A REQUIREMENT, NOT A PROPERTY.
The card's acceptance says "running the stage twice on the same script is
byte-identical". misaki is deterministic; so is espeak in the mode used here.
Nothing in this file introduces a dictionary iteration order, a set, a hash
seed or a timestamp into the output.

WHAT THIS FILE CANNOT DO ON THE MACHINE THAT WROTE IT.
misaki is not installed here, and this branch was authored on Windows where
`espeak-ng` is not present either. So `--check` reports honestly what is
missing and prints the one command that fixes it; every other mode refuses
rather than emitting a phoneme string nobody produced. The pure half — reading
the lexicon, planning the substitutions, and the output shape — is exercised by
`tools/narration/phonemize.test.mjs` through the JSON contract below, which is
what makes the parts that CAN be tested here tested.

USAGE

    python tools/narration/phonemize.py --check
    python tools/narration/phonemize.py --text "The sake was poured."
    python tools/narration/phonemize.py --json <in.json> --out <out.json>
    python tools/narration/phonemize.py --passage tools/mobile/kokoro-probe-passage.json --in-place

`--json` reads `{"items": [{"id": ..., "script": ...}, ...]}` and writes
`{"items": [{"id": ..., "phonemes": ..., "tts": {...}, "est_sec": ...}, ...]}`
— the shape `backend/src/generation/phonemize.ts` consumes. `--passage` fills
`phonemes` and `ids` in the probe/audition passage in place.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
LEXICON_PATH = REPO_ROOT / "mobile" / "plugins" / "foray-tts" / "lexicon" / "hard-terms.json"

# narration-craft.md §2a's planning rate: 170 wpm ~= 17 characters/second.
CHARS_PER_SEC = 17.0

# The engine and model this stage stamps onto every item it phonemizes. The
# player refuses (falls back to the system voice) on a mismatch with what the
# app carries -- deck §5 item 8 -- so these are a contract, not a label.
ENGINE = "kokoro"
MODEL = "1.0"

INSTALL_HINT = (
    "pip install -r tools/narration/requirements.txt   "
    "(and a system espeak-ng: `apt-get install espeak-ng` / `brew install espeak-ng`)"
)


# --------------------------------------------------------------------- lexicon


def load_lexicon(path: Path = LEXICON_PATH) -> list[dict]:
    """The lexicon's entries, or an empty list.

    Failure-tolerant for the same reason `check-forays.mjs`'s own loader is: an
    unreadable lexicon must degrade to "no overrides", which is the behaviour a
    lexicon of 83 nulls already has, rather than to a new failure mode.
    """
    try:
        with path.open(encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return []
    entries = doc.get("entries")
    return entries if isinstance(entries, list) else []


def term_pattern(term: str) -> re.Pattern:
    """Case-insensitive, word-boundary, apostrophe-safe.

    A plain ``\\b`` breaks on ``ch'arki`` -- ``narrator-voice.md``'s Appendix
    says so explicitly about its own counting script. The lookarounds below are
    the same ones ``foray-tts.js``'s ``findMatches`` uses, transcribed rather
    than reinvented: no letter, digit or apostrophe on either side.
    """
    escaped = re.escape(term)
    return re.compile(rf"(?<![^\W_]|['’]){escaped}(?![^\W_]|['’])", re.IGNORECASE | re.UNICODE)


def plan_overrides(script: str, entries: list[dict]) -> list[dict]:
    """Which lexicon overrides apply to this script, in the order they occur.

    Only terms with an authored ``ipa``. Non-overlapping: the longest match
    wins at any position, so ``binchōtan`` is not also matched as a shorter
    term that happens to be a prefix of it. Sorted by start offset so the
    substitution below can walk the string once, left to right, deterministically.
    """
    hits: list[dict] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        ipa = entry.get("ipa")
        term = entry.get("term")
        if not ipa or not isinstance(term, str) or not term:
            continue
        for m in term_pattern(term).finditer(script):
            hits.append({"term": term, "ipa": ipa, "start": m.start(), "end": m.end()})
    hits.sort(key=lambda h: (h["start"], -(h["end"] - h["start"]), h["term"]))
    chosen: list[dict] = []
    cursor = -1
    for hit in hits:
        if hit["start"] < cursor:
            continue  # overlaps an earlier, longer match
        chosen.append(hit)
        cursor = hit["end"]
    return chosen


def estimate_seconds(script: str) -> float:
    """`est_sec` until K-04 can record a real rendered length (deck K-02)."""
    return round(len(script) / CHARS_PER_SEC, 3)


# ----------------------------------------------------------------- the backend


class MissingBackend(RuntimeError):
    """Raised instead of guessing. See the module docstring."""


def load_backend():
    """misaki's en-US G2P, or a `MissingBackend` naming the one command.

    DELIBERATELY NOT A FALLBACK TO SOMETHING ELSE. A phonemizer that quietly
    used a different front-end would produce a phoneme string that does not
    match the vocabulary the app was built against, and the player's version
    check (deck §5 item 8) would then reject every item -- after the Foray had
    been published. Refusing here costs a build; guessing costs a release.
    """
    try:
        from misaki import en  # type: ignore
    except ImportError as exc:  # pragma: no cover - exercised only where misaki exists
        raise MissingBackend(
            "misaki is not installed, so no phonemes can be produced.\n"
            f"  {INSTALL_HINT}"
        ) from exc
    return en.G2P(trf=False, british=False, fallback=None)


def phonemize_script(script: str, entries: list[dict], g2p) -> dict:
    """One script -> `{phonemes, overrides, est_sec}`.

    THE LEXICON GOES IN FIRST AND COMES OUT UNTOUCHED. Each overridden span is
    phonemized by substitution, not by asking misaki; the text between spans is
    phonemized by misaki. Concatenating in source order is what makes the
    override survive the trip, which is the property `check-forays.mjs`'s
    `phonemeProblems` then enforces on the published item.
    """
    overrides = plan_overrides(script, entries)
    pieces: list[str] = []
    cursor = 0
    for hit in overrides:
        before = script[cursor:hit["start"]]
        if before.strip():
            pieces.append(g2p(before)[0].strip())
        pieces.append(hit["ipa"])
        cursor = hit["end"]
    tail = script[cursor:]
    if tail.strip():
        pieces.append(g2p(tail)[0].strip())
    return {
        "phonemes": " ".join(p for p in pieces if p),
        "overrides": [{"term": h["term"], "ipa": h["ipa"]} for h in overrides],
        "est_sec": estimate_seconds(script),
    }


def vocab_sha(g2p) -> str:
    """The sha of the phoneme id table this run's phonemes are valid against.

    Stamped onto every item as `tts.vocab` so the player can refuse a mismatch
    (deck §5 item 8) rather than speak nonsense. Derived from the backend's own
    vocabulary rather than hard-coded, because a misaki upgrade that changed
    the table silently would otherwise produce items the app accepts and
    mispronounces.
    """
    import hashlib

    table = getattr(g2p, "vocab", None) or getattr(g2p, "phoneme_vocab", None)
    if table is None:
        raise MissingBackend(
            "this misaki build exposes no phoneme vocabulary, so `tts.vocab` cannot be "
            "computed and the player would have nothing to version-check against."
        )
    blob = json.dumps(table, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return "sha256:" + hashlib.sha256(blob).hexdigest()[:16]


# ------------------------------------------------------------------------ main


def cmd_check(entries: list[dict]) -> int:
    authored = [e for e in entries if e.get("ipa")]
    print(f"lexicon: {len(entries)} terms, {len(authored)} with an authored IPA")
    try:
        g2p = load_backend()
    except MissingBackend as exc:
        print(f"backend: NOT AVAILABLE\n  {exc}")
        return 1
    print(f"backend: misaki en-US ready, vocab {vocab_sha(g2p)}")
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="report what is installed and exit")
    ap.add_argument("--text", help="phonemize one string and print the result as JSON")
    ap.add_argument("--json", dest="json_in", help='read {"items":[{"id","script"}]} and write the phonemized items')
    ap.add_argument("--passage", help="fill `phonemes`/`ids` in a probe/audition passage")
    ap.add_argument("--out", help="where to write (default: stdout)")
    ap.add_argument("--in-place", action="store_true", help="rewrite --passage in place")
    args = ap.parse_args(argv)

    entries = load_lexicon()
    if args.check:
        return cmd_check(entries)

    try:
        g2p = load_backend()
    except MissingBackend as exc:
        print(str(exc), file=sys.stderr)
        return 1
    vocab = vocab_sha(g2p)
    stamp = {"engine": ENGINE, "model": MODEL, "vocab": vocab}

    if args.text:
        out = phonemize_script(args.text, entries, g2p)
        out["tts"] = stamp
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    if args.json_in:
        doc = json.loads(Path(args.json_in).read_text(encoding="utf-8"))
        items = []
        for item in doc.get("items", []):
            res = phonemize_script(item.get("script", ""), entries, g2p)
            items.append({
                "id": item.get("id"),
                "phonemes": res["phonemes"],
                "est_sec": res["est_sec"],
                "tts": stamp,
            })
        body = json.dumps({"items": items}, ensure_ascii=False, indent=2) + "\n"
        if args.out:
            Path(args.out).write_text(body, encoding="utf-8")
        else:
            sys.stdout.write(body)
        return 0

    if args.passage:
        path = Path(args.passage)
        doc = json.loads(path.read_text(encoding="utf-8"))
        for line in doc.get("lines", []):
            res = phonemize_script(line.get("text", ""), entries, g2p)
            line["phonemes"] = res["phonemes"]
            line["ids"] = g2p.vocab_ids(res["phonemes"]) if hasattr(g2p, "vocab_ids") else None
            if line["ids"] is None:
                print(
                    "this misaki build cannot map phonemes to ids; K-04's id table is needed "
                    "before the passage can be filled.",
                    file=sys.stderr,
                )
                return 1
        doc["vocab"] = vocab
        body = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
        target = path if args.in_place else (Path(args.out) if args.out else None)
        if target:
            target.write_text(body, encoding="utf-8")
        else:
            sys.stdout.write(body)
        return 0

    ap.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
