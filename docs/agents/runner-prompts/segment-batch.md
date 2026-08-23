# Runner prompt — segment extraction batch (issue #110)

The versioned contract for the Lane C extraction agent
(`docs/curation/segment-extraction-pipeline.md` §3). Text in, text out: it reads
one prepared batch of transcripts and returns candidate segments. No network, no
audio, no API key — this runs on the Max plan like every other routine here.

Read `CLAUDE.md` first (product principles and copy rules — binding), then
`docs/curation/segment-length-rules.md` §7 and §9 for the reasoning behind the
numbers below. **Re-read this file every run**; it is the operational contract.

## Your inputs

`tools/segments/prepare-segment-batch.mjs --render <dir>` writes one file per
episode. Each line is:

```
[<index> <hh:mm:ss> | <start>-<end>] <cue text>
```

The header gives the `item_id` and the `reference_duration_sec` you are bound by.
**Read each transcript in full before choosing anything.** The prepare stage has
already excluded every episode whose timeline does not describe the audio a
listener will hear (#315), so you do not have to think about that — but it is
also why you may not substitute a transcript of your own.

## The one quality bar that matters

**A segment must survive being heard cold.** The listener drops into it having
heard nothing before it. A segment that opens mid-anaphora — *"and that's why it
matters"*, *"so the second one is even worse"* — is a bad cut however good the
content is. §7: *"So that's why the whole thing collapsed" is broken at second
zero and stays broken at four minutes.*

When you pick a start point:

- **Leave a sacrificial head of about 4 seconds** (§2a, §3f). Measured:
  comprehension of the first sentence after a voice change is ~52% against ~72%
  thereafter. So **start the cut roughly one sentence BEFORE the sentence you
  actually want.** Do not anchor on the money line; anchor on its run-up. This
  is the highest-value rule here and the one no validator can check.
- The first ~12 words should carry a proper noun or the subject term.
- End on a completed thought, at a sentence terminal, not mid-clause.

**Returning zero segments for an episode is a first-class, correct answer and is
never penalised.** Most tape contains nothing worth a Foray. A quota
manufactures filler and filler is what kills the format. Two excellent segments
beat five adequate ones.

## Always excluded

Intros, outros, theme music, sponsor and ad reads, Patreon/merch plugs,
housekeeping, guest-credential recitations; anything whose interest depends on
having heard an earlier part of the episode; passages too garbled to follow.

**Boundaries are editorial only.** Never choose a boundary because of where an
ad is, and never mention advertising in `why` (#63 §3, R11).

## Length — these are rejections, not targets

| | |
|---|---|
| hard floor | `end_sec - start_sec >= 30`. Under 30 s is dropped |
| target band | 75–180 s, centre ~110 s — a *property of good output*, never a number to hit |
| soft max | over 240 s needs `needs_review: true` **and** a `long_reason` (≤ 18 words) |
| hard max | 480 s `narrative`/`exchange`, 360 s `explanation`, 90 s `quote` |
| relative max | ≤ **20%** of the episode's `reference_duration_sec` |
| same episode | consecutive segments ≥ 45 s apart, else they must be ONE segment. A 45–180 s gap needs a `keep_separate_reason` |

**The fix for a too-short segment is almost always to widen it, not to discard
it.** A 22-second idea usually has 15 seconds of set-up in front of it that you
skipped because the set-up is not the interesting part. It is the part that
makes the interesting part land. Widening is not padding.

Vary the lengths. Three consecutive segments within ±20% of each other is itself
a defect (§2d) — a Foray of equal blocks sounds metronomic.

## Anchors — the check that fails silently if you get it wrong

An anchor is a verbatim quotation used to re-find the boundary in a different
copy of the file. **A paraphrased anchor produces a boundary that can never be
resolved and it fails silently at playback**: nothing throws, the seek policy
degrades to `approximate` forever, and the segment is skipped.
`merge-segments.mjs` compares word-for-word — case, punctuation and apostrophes
are forgiven; a changed, added or dropped word is not; `30` for `thirty` is a
rewrite and is rejected.

- `start_anchor` = the text of the segment's **first** cue line(s), copied
  character for character, joined with single spaces, until you have 8–14 words.
- `end_anchor` = the same from the segment's **last** cue line(s), ending exactly
  where the segment ends.
- Strip only the `[…] ` prefix. Keep typos, ASR mangling, `[Music]` markers and
  odd capitalisation. **Do not tidy anything.**
- If you cannot copy it exactly, do not emit the segment.

`start_sec` is the first number in your first cue's bracket; `end_sec` is the
second number in your last cue's bracket. Copy both as printed.

## Fields

```jsonc
{
  "start_sec": 754.20,
  "end_sec": 869.40,
  "start_anchor": "…8–14 words, verbatim…",
  "end_anchor":   "…8–14 words, verbatim…",
  "topic": "nature/earth-science",   // an existing data/taxonomy.json node id
  "why": "…≤ 18 words, our own prose…",
  "confidence": "high",              // high | medium | low
  "role": "explanation",             // quote | explanation | exchange | narrative
  "tier": "spine",                   // spine | supporting | colour
  "cold_open_ok": false,             // override a false-positive cold-open flag
  "long_reason": null,               // required over 240 s
  "keep_separate_reason": null       // required on a 45–180 s same-episode gap
}
```

`why` is the one line we write. One sentence, ≤ 18 words, concrete, naming the
thing. `Hoffman explains how a frozen ocean still weathers rock, and why that
ends the freeze` — not `A great discussion about snowball earth`. Banned
outright by `backend/src/copy/rules.js`: `fascinat…`, `deep dive`/`deep-dive`,
`delve`, `explore`/`explores`, `you won't believe`, `fits your drive`, `your
commute`, `-min drive`.

`topic` must be an id that exists in `data/taxonomy.json`. Anything else is
rejected by the merge.

## Output

One JSON file, nothing else:

```jsonc
{
  "batch_id": "<the batch id you were given>",
  "results": {
    "<item_id>": [ {…}, … ],
    "<item_id with nothing worth cutting>": []
  }
}
```

An entry for every episode you were given, including the empty ones.

## What happens next, and why you should not try to be clever

`prepare-segment-batch.mjs --lint` drops anything breaking a length rule and
flags the cold-open/clean-out cases; `merge-segments.mjs` then re-derives every
anchor against the transcript and **rejects rather than repairs**. Neither stage
will fix a paraphrase, widen a short segment, or merge a pair you left 20 s
apart. A candidate that does not survive both is simply lost, so the cheapest
place to be careful is here.
