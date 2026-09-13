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

WHAT THIS FILE CANNOT DO ON A MACHINE WITHOUT THE BACKEND.
misaki is a Python package, and CI does not install it. So `--check` reports
honestly what is missing and prints the one command that fixes it; every other
mode refuses rather than emitting a phoneme string nobody produced. The pure
half — reading the lexicon, planning the substitutions, the id mapping and the
output shape — is exercised by `tools/narration/phonemize.test.mjs` through the
JSON contract below, which is what makes the parts that CAN be tested here
tested. The ids this stage produced ARE committed
(`tools/mobile/kokoro-probe-passage.json`) and are re-checked in Node against
the committed id table by `tools/mobile/kokoro-vocab.test.mjs`, which needs no
Python at all.

THE ID TABLE IS NOT MISAKI'S, AND THAT WAS A BUG HERE UNTIL 2026-09-12.
An earlier draft of this file asked misaki for `g2p.vocab` and `g2p.vocab_ids`.
Neither exists on any misaki build: `vocab_sha` therefore always raised and
`--passage` always exited 1, which is why
`tools/mobile/kokoro-probe-passage.json` shipped with `ids: null` and the probe
on Wyatt's phone answered `passage-unphonemized` rather than a number. The id
table belongs to the MODEL, not to the front end — it is the vocabulary the
ONNX graph was exported with — so it is read from
`tools/narration/kokoro-vocab.json`, extracted verbatim from the pinned
export's own `tokenizer.json`. See that file's header.

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
VOCAB_PATH = Path(__file__).resolve().parent / "kokoro-vocab.json"

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


def load_espeak_fallback():
    """misaki's own `espeak-ng` fallback, or `None` when it is not installed.

    THE CARD ASKS FOR THIS EXPLICITLY: K-02's Ask is "misaki (`en-us`) with
    `espeak-ng` fallback for the rest, on the server". An earlier draft passed
    `fallback=None`, and the effect was not "fewer phonemes" but WRONG ones:
    misaki emits a literal `?` glyph for a word it cannot look up, and the
    passage's pronunciation-fixture line came out with six of them -- one for
    each of the six lexicon terms the fixture exists to exercise. A `?` is not
    in the model's vocabulary, so `ids_for` refuses it; with a silent-skip
    mapper it would instead have rendered as six missing words.

    THE GPL DOES NOT TRAVEL. espeak-ng is GPL-3 and runs HERE, on the machine
    that generates a Foray, exactly as `generation-architecture.md` §1.2.1
    confines it. Nothing it produces is a derived work that ships: the output
    is a phoneme string, and `test/release-gates.test.js` holds the line that
    no native build input names espeak.
    """
    try:
        from misaki import espeak  # type: ignore
    except ImportError:
        return None
    try:
        return espeak.EspeakFallback(british=False)
    except Exception:  # pragma: no cover - a system without the espeak library
        return None


def load_backend():
    """misaki's en-US G2P, or a `MissingBackend` naming the one command.

    DELIBERATELY NOT A FALLBACK TO SOMETHING ELSE. A phonemizer that quietly
    used a different front-end would produce a phoneme string that does not
    match the vocabulary the app was built against, and the player's version
    check (deck §5 item 8) would then reject every item -- after the Foray had
    been published. Refusing here costs a build; guessing costs a release.

    `espeak-ng` is not "something else": it is the out-of-vocabulary half of
    the very front end the card names, and `ids_for` re-checks every character
    it produces against the model's own table, so an espeak output the model
    cannot sing is a refusal rather than a surprise.
    """
    try:
        from misaki import en  # type: ignore
    except ImportError as exc:  # pragma: no cover - exercised only where misaki exists
        raise MissingBackend(
            "misaki is not installed, so no phonemes can be produced.\n"
            f"  {INSTALL_HINT}"
        ) from exc
    return en.G2P(trf=False, british=False, fallback=load_espeak_fallback())


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
    espeaked: list[str] = []
    cursor = 0

    def run(chunk: str) -> str:
        """misaki on one span, recording which WORDS it had to fall back for.

        `rating` is misaki's own confidence: 4 is its dictionary, anything
        lower came from the espeak fallback. Recorded rather than discarded
        because the passage's fixture line exists to test PRONUNCIATION, and a
        term espeak guessed at is not evidence about pronunciation control --
        the honest place to say so is next to the phonemes, not in a PR
        description. `None` is punctuation and is not a word.
        """
        out, tokens = g2p(chunk)
        for tok in tokens:
            rating = getattr(tok, "rating", None)
            if rating is not None and rating < 4 and str(tok.text).strip():
                espeaked.append(str(tok.text).strip())
        return out.strip()

    for hit in overrides:
        before = script[cursor:hit["start"]]
        if before.strip():
            pieces.append(run(before))
        pieces.append(hit["ipa"])
        cursor = hit["end"]
    tail = script[cursor:]
    if tail.strip():
        pieces.append(run(tail))
    return {
        "phonemes": " ".join(p for p in pieces if p),
        "overrides": [{"term": h["term"], "ipa": h["ipa"]} for h in overrides],
        "espeak_fallback": espeaked,
        "est_sec": estimate_seconds(script),
    }


# ------------------------------------------------------------------ the table


def load_vocab(path: Path = VOCAB_PATH) -> dict:
    """The model's phoneme-to-id table, as committed.

    NOT FAILURE-TOLERANT, unlike `load_lexicon`. A missing lexicon degrades to
    "no overrides", which is a real and survivable state. A missing id table
    has no degraded form: every id this stage emits comes from it, and an empty
    table would map every phoneme to nothing.
    """
    with path.open(encoding="utf-8") as fh:
        doc = json.load(fh)
    table = doc.get("table")
    if not isinstance(table, dict) or not table:
        raise MissingBackend(f"{path} carries no phoneme-to-id table")
    return doc


def vocab_sha(vocab: dict) -> str:
    """The sha of the phoneme id table this run's phonemes are valid against.

    Stamped onto every item as `tts.vocab` so the player can refuse a mismatch
    (deck §5 item 8) rather than speak nonsense.

    THE TABLE IS THE MODEL'S, NOT THE FRONT END'S. An earlier draft hashed
    `g2p.vocab` -- an attribute misaki does not have, so this function could
    only ever raise. The version skew the player must catch is "the ids in this
    item were built against a different graph than the one in the app", and
    that is a property of the ONNX export's own tokenizer, which is what
    `kokoro-vocab.json` holds. A misaki upgrade that changed the PHONEMES
    without changing the table is caught instead by the pinned requirement.

    `sort_keys` + compact separators + `ensure_ascii=False` is the canonical
    form; `tools/mobile/kokoro-vocab.test.mjs` recomputes the identical bytes
    in Node, so the two languages cannot drift apart unnoticed.
    """
    import hashlib

    blob = json.dumps(
        vocab["table"], sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(blob).hexdigest()[:16]


class UnsingablePhoneme(ValueError):
    """A phoneme the model has no id for. Raised, never skipped -- see below."""


def ids_for(phonemes: str, vocab: dict) -> list[int]:
    """Phoneme string -> the graph's `input_ids`, pads included.

    THE UNKNOWN CHARACTER IS A REFUSAL. `kokoro-onnx`'s own loader does
    `filter(lambda i: i is not None, map(VOCAB.get, phonemes))`, which drops
    anything it does not recognise. Applied to the passage's fixture line that
    would have turned six mispronounced terms into six ABSENT ones -- audio
    that still sounds like fluent speech, still produces an RTF, and measures a
    passage nobody wrote. It would also shorten the id count, and the id count
    is what selects the style vector's row, so every remaining phoneme would be
    sung with the wrong voice matrix.

    The pads are the graph's own contract (`pad_id` at both ends). The style
    row is chosen from the UNPADDED length, so callers that need it use
    `len(ids) - 2`.
    """
    table = vocab["table"]
    pad = vocab["pad_id"]
    out = [pad]
    for ch in phonemes:
        if ch not in table:
            raise UnsingablePhoneme(
                f"the phoneme {ch!r} (U+{ord(ch):04X}) has no id in {VOCAB_PATH.name}; "
                "the model cannot sing it. This is almost always a word misaki could not "
                "look up and espeak-ng was not installed to resolve — see load_espeak_fallback()."
            )
        out.append(table[ch])
    out.append(pad)
    limit = vocab.get("max_input_ids", 512)
    if len(out) > limit:
        raise UnsingablePhoneme(
            f"{len(out)} ids exceeds the graph's input_ids limit of {limit}; "
            "the line must be split before it can be synthesized."
        )
    return out


# ------------------------------------------------------------------------ main


def cmd_check(entries: list[dict]) -> int:
    authored = [e for e in entries if e.get("ipa")]
    print(f"lexicon: {len(entries)} terms, {len(authored)} with an authored IPA")
    vocab = load_vocab()
    print(f"id table: {len(vocab['table'])} phonemes, vocab {vocab_sha(vocab)}")
    try:
        g2p = load_backend()
    except MissingBackend as exc:
        print(f"backend: NOT AVAILABLE\n  {exc}")
        return 1
    fb = "espeak-ng" if getattr(g2p, "fallback", None) else "NONE (out-of-vocabulary words will refuse)"
    print(f"backend: misaki en-US ready, out-of-vocabulary fallback: {fb}")
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
    vocab_doc = load_vocab()
    vocab = vocab_sha(vocab_doc)
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
        fallback_terms: list[str] = []
        for line in doc.get("lines", []):
            res = phonemize_script(line.get("text", ""), entries, g2p)
            line["phonemes"] = res["phonemes"]
            try:
                line["ids"] = ids_for(res["phonemes"], vocab_doc)
            except UnsingablePhoneme as exc:
                # REFUSE THE WHOLE PASSAGE, not just the line. A passage with
                # three good lines and one absent one still produces an RTF,
                # and that number would be quoted as the measurement.
                print(f"{line.get('id')}: {exc}", file=sys.stderr)
                return 1
            line["espeak_fallback"] = res["espeak_fallback"]
            for term in res["espeak_fallback"]:
                if term not in fallback_terms:
                    fallback_terms.append(term)
        doc["vocab"] = vocab
        doc["espeak_fallback_terms"] = fallback_terms
        body = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
        target = path if args.in_place else (Path(args.out) if args.out else None)
        if target:
            # `newline=""` rather than `write_text`: on Windows the default
            # translates every "\n" to "\r\n", so the card's acceptance
            # ("running the stage twice on the same script is byte-identical")
            # would hold on one operating system and not the other.
            with target.open("w", encoding="utf-8", newline="") as fh:
                fh.write(body)
        else:
            sys.stdout.write(body)
        return 0

    ap.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
