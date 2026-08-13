# ADR 0007: Segment Anchoring — how a Foray segment boundary is represented

## Status

**Accepted** — Wyatt, 2026-08-11. Unblocks the segment-extraction fan-out in
`docs/curation/segment-extraction-pipeline.md`. Getting this wrong is not a
bug to fix later; it invalidates every segment the extraction produces,
which is why it was decided before any of it ran.

**Primary sources.** The DAI-drift evidence behind this decision is digested in
`docs/research/corpus/digests.md`: entries 9 (Podcast Namespace issue #254 —
DAI shifts every downstream timestamp), 48 (Pocket Casts #2093 — ~100s chapter
drift, different per download), 19 (Castos DAI mechanics, 22s worked example)
and 15 (Chromaprint, the fingerprint route to offset recovery). Full text is
searchable via `node tools/corpus/corpus.mjs search` on the machine that built
the corpus DB (see CLAUDE.md § Research corpus).

## Context

Epic #63 needs a segment: a bounded `start` → `end` region of a real
episode, played from the publisher's original enclosure (#64 ruling,
2026-08-11: seek-and-stop, never a concatenated derived artefact).

The blocker is dynamic ad insertion. Corner case #2 and
`tools/refresh/dai.mjs` establish the shape of the problem:

- A DAI host stitches ads per request. The same episode GUID serves
  different bytes and a total duration that moves by 1–4 minutes.
- A listener's **own** copy is stable — that is what makes resume work.
- A timestamp authored elsewhere is a **foreign** copy's timeline, and
  `player/seek-policy.js` correctly returns `approximate` for it.

An authored segment boundary is foreign by definition. Approximate cannot
anchor an out-point: cut in the wrong place and you open mid-ad or clip the
speaker's first sentence.

Current exposure, measured 2026-08-11 against `data/discover.json`:
**903 of 1,309 playable items are `dai_suspected`** — 69%, up from the 64%
recorded when #63 was written. The eligible pool is shrinking, not growing.

## Options considered

### 1. Timestamps only, restricted to non-DAI sources (#63 §2's v1 plan)

Store `start_sec`/`end_sec`; a validator rejects any segment referencing a
`dai_suspected` item.

Correct and safe, but it concedes 69% of the catalogue permanently, and the
share is rising. It also means every segment ever extracted is scoped to a
minority tier that the curation engine did not choose for editorial reasons.

### 2. Anchor to published chapters (`<podcast:chapters>`)

The intuition: let the publisher's own chapter marks carry the offsets, on
the theory that a host doing its own ad insertion would keep them honest.

**Rejected on two independent grounds, one structural and one measured.**

**Structural.** A `<podcast:chapters>` tag points at a *static JSON file at
a fixed URL* — the same bytes for every listener. Podcasting 2.0 has no
per-listener mechanism, and the chapters fetch is an uncorrelated request
the ad stitcher cannot associate with any particular stitch. So a chapters
file is authored against the un-stitched master and drifts exactly like our
own timestamps. It is not a second opinion; it is the same foreign
timeline with extra steps. `player/seek-policy.js` already names this
precise case as its canonical example of `FOREIGN`:

> foreign — it came from somewhere else — **chapter marks authored against
> the un-stitched master**, or transcript times from a separate fetch.

**Measured.** Probed all 213 curated shows' live feeds (209 fetched
successfully, 2026-08-11):

| | shows | with ≥1 chaptered episode |
|---|---|---|
| DAI | 136 | **7 (5.1%)** |
| non-DAI | 73 | 3 (4.1%) |
| all | 209 | 10 (4.8%) |

Chapter publishing is rare, and it is *not* concentrated where it would
help. The seven DAI+chaptered shows are all small indie productions on
Buzzsprout, Transistor, and Captivate — and several are thin (Acquired
publishes chapters on 1 of 216 episodes). There is no version of this
that unlocks a meaningful catalogue.

Note the comparison that *does* matter, from the same probe:
**`<podcast:transcript>` coverage is roughly 3× chapter coverage on DAI
shows (23 of 136, 16.9%)** — which points at the option below.

### 3. Content anchoring — the decision

Stop treating a boundary as a *time* and start treating it as a *place in
the content*, with time as a cache.

Every segment stores **both**:

```jsonc
{
  "type": "segment",
  "item_id": "lex-353-whyte",
  "why": "Whyte explains the Lawson criterion without hand-waving",

  // Timeline cache — fast path. Valid only against the reference copy.
  "start_sec": 2530,
  "end_sec": 3110,
  "reference_duration_sec": 11840,   // duration of the copy these were authored against

  // Content anchor — durable. Survives re-stitching, re-encoding, re-upload.
  "start_anchor": "so the Lawson criterion is really a statement about",
  "end_anchor": "and that's why the tokamak won by default for thirty years"
}
```

At playback, `seekPrecision()` gains a third source alongside `OWN` and
`FOREIGN`:

- Local downloaded file (#29) → **exact**, timeline frozen. Unchanged.
- Not DAI → **exact** via `start_sec`. Unchanged.
- DAI, and `|observed_duration − reference_duration| ≤ DRIFT_TOLERANCE_SEC`
  → **exact** via `start_sec`. The ad load happens to match; the cache is
  live.
- DAI, and the duration has drifted → **resolve the anchor** against a
  transcript of the copy in hand, and seek to the resolved time.
- Anchor unresolvable → **approximate**, and the segment is skipped rather
  than played at the wrong place. Honest failure, never a bad cut.

### Why this is the right shape

- **The anchor is free at authoring time.** Extraction reads a transcript
  to choose the boundary at all. Capturing the ~8–12 words at each edge
  costs nothing extra — it is a substring of what the extractor already has
  in context.
- **It makes the extraction output durable.** This is the load-bearing
  reason and the reason this ADR blocks the fan-out. A segment stored as
  bare timestamps is scoped to one copy of one file and rots when the
  publisher re-uploads, re-encodes, or changes ad load. A segment stored
  with anchors is a claim about *content*, and stays true. If an army
  spends two days extracting segments, that output should not have a
  shelf life measured in ad campaigns.
- **It degrades honestly.** Every failure path lands on "skip this
  segment," never "play the wrong 40 seconds."
- **It reuses the existing seam.** `seekPrecision()` is already the single
  chokepoint every seek path consults. This adds a branch, not an
  architecture.

## Decision

**Adopt dual anchoring (option 3).** Segments carry both a timeline cache
and content anchors. Timestamps are an optimisation; the anchor is the
truth.

Consequences for #65's schema: `reference_duration_sec`, `start_anchor`,
and `end_anchor` become required fields on a `segment` item, and the
validator's `dai_suspected: false` hard requirement relaxes to: *a DAI
source is permitted if and only if both anchors are present and non-empty.*
Non-DAI sources may omit anchors, but should not — a publisher can
re-upload a static file too.

## What this does not do

- **It does not make DAI sources v1-ready.** Resolving an anchor needs a
  transcript of the listener's copy, which needs the audio, which in
  practice means the download path (#29) — still native-only. v1 ships
  non-DAI sources, exactly as #63 §2 planned. The change is that v1's
  *extraction output* is already correct for the DAI catalogue when #29
  lands, instead of needing a re-run.
- **It does not touch ad detection.** Anchors are chosen for editorial
  reasons. That an ad falls outside a chosen segment stays incidental and
  is never a stated feature (R11, #63 §3, and the 2026-08-11 ruling).
- **It does not change the legal posture.** Playback remains seek-and-stop
  against the publisher's original enclosure. No derived audio artefact is
  produced at any point.

## Open question for Wyatt

Corner case #33 requires that Tier-2 transcript work be minted with a
shortlist token from the curation engine and *"can't be invoked in bulk by
accident."* Deliberate bulk segment extraction is exactly what
`docs/curation/segment-extraction-pipeline.md` proposes. That constraint
needs an explicit amendment — bulk-by-design with a budget ceiling, rather
than bulk-by-accident — not a quiet workaround.
