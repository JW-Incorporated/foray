# Segment extraction — architecture for the catalogue fan-out

How Foray goes from "19,787 shows and 73,719 archived episodes" to "a pool
of anchored, topic-tagged segments a Foray can be assembled from," at a
scale one person cannot hand-author.

Companion to `docs/adr/0007-segment-anchoring.md` (the boundary
representation — **read that first, it blocks this**) and epic #63.

---

## 1. Reuse the shape that already worked

The breadth-classification pipeline (`tools/classify/`, DECISIONS
2026-07-24) established a three-stage pattern that survived contact with
the real catalogue. Do not invent a second one:

```
prepare  (deterministic, keyless, resumable)  →  data/*-progress.json
   ↓
agent    (LLM, runs on Claude Max via Claude Code routines, not the API)
   ↓
merge    (validates hard, rejects silently-wrong output, idempotent)
```

Three properties that made it work and must carry over:

- **The prepare stage is dumb and free.** No LLM. It fetches, normalises,
  and checkpoints, so a crashed run resumes instead of restarting.
- **The merge stage distrusts the agent.** `merge-results.mjs` validates
  taxonomy node ids, confidence bounds, and copy rules, and *leaves the
  record untouched* on a violation rather than writing degraded data. It
  caught a real copy-rule violation in its own test fixtures.
- **Nothing auto-applies when flagged.** `needs_review` output is held for
  a human pass (principle #2).

## 2. The cost wall, and why it decides the plan

The instinct is "transcribe everything, then extract segments." Run the
numbers before committing two days to it:

| | |
|---|---|
| Archived episodes | 73,719 |
| Mean episode length | ~45 min |
| Whisper API | ~$0.006/audio-min |
| **Full-corpus transcription** | **≈ $20,000** |

That is not a budget question, it is a different company. And it is
*dollar*-bound, not token-bound — the Claude Max plan does not help,
because transcription is audio work, not text work.

**So the fan-out must be routed to where tokens are the binding constraint
and audio dollars are zero.** That means:

1. Free transcripts first, always. `<podcast:transcript>` is a fetch, not a
   spend, and the publisher declaring the tag is implicit consent to use it
   (ADR-0004 step 1).
2. Whisper is reserved for a shortlist that has already earned it — never a
   sweep. ADR-0004 and corner case #33 both say this; the economics now say
   it independently.
3. Everything the army does should be **text-in, text-out**.

## 3. Three lanes, and only one of them is gated

The most useful property of this plan: **Lane A can start immediately and
does not depend on the #64 ruling at all.** If Joey reads a Foray as the
rejected clip format and #63 closes, Lane A's output is still valuable —
it is the classification work ADR-0006 already commissioned.

```
Lane A  breadth classification        ── ungated, tooling built, start now
Lane B  transcript availability sweep ── ungated, needs a small script
Lane C  segment extraction            ── GATED on #64 + ADR-0007
```

### Lane A — breadth classification (ungated, ready)

ADR-0006's Tier-1 pass over 19,787 US breadth shows. The tooling exists and
was verified end-to-end against real feeds; only ~44 shows have been
classified so far (PR #86, still open). This is the largest block of
genuinely token-bound work already sitting on the shelf.

- Prepare: `tools/classify/prepare-batch.mjs` (built)
- Agent contract: `docs/agents/runner-prompts/classify-batch.md` (built)
- Merge: `tools/classify/merge-results.mjs` (built)

**Work needed: none, beyond running it.** Pick a batch size, register the
routine in `docs/agents/runners.md`, and fan out. The one open question is
pacing, which the orchestrator decides.

### Lane B — transcript availability sweep (ungated, small build)

Before anything can extract segments, we need to know *where free
transcripts actually are*. Today nothing records this: the refresh pipeline
never captures `podcast:transcript` at all, and `data/discover.json` items
carry no transcript field. `backend/src/feeds/parser.ts` parses
`transcriptUrl`, but that path is not what produces the live catalogue.

This is a deterministic fetch job — **not** agent work. Codify it
(`CLAUDE.md` rule 6):

`tools/segments/sweep-transcripts.mjs`
- For every show with a `feed_url`, fetch the feed once, politely.
- Per episode record: `transcript_url`, `transcript_type`
  (`text/plain` / `application/json` / `text/vtt` / `application/srt`),
  `chapters_url`, `dai_suspected` (via the existing `dai.mjs` host
  resolution), `duration_sec`.
- Checkpoint to `data/transcript-progress.json` so it resumes.
- Emit `data/transcript-availability.json`.

Known shape from the 2026-08-11 probe of the 213 curated shows: transcript
coverage is ~17% of DAI shows and ~10% of non-DAI, against ~5% for
chapters. Expect the breadth tier to differ — measure it, do not assume.

**This is the single highest-value thing to build first**, because it turns
"which episodes can we work on for free?" from a guess into a list, and
every downstream lane consumes it.

### Lane C — segment extraction (gated)

The army's real work, once #64 rules and ADR-0007 is accepted.

**Prepare** — `tools/segments/prepare-segment-batch.mjs`, deterministic:
- Input: `data/transcript-availability.json` + a target topic node.
- Select episodes with a free transcript, in-topic, above a duration floor.
- Fetch and normalise the transcript to a common shape
  (`[{start_sec, text}]` — VTT/SRT/JSON all collapse to this).
- Emit a batch file: episode metadata + the normalised transcript +
  `reference_duration_sec` (from the enclosure actually fetched).

**Agent** — `docs/agents/runner-prompts/segment-batch.md`, the contract:
- Input: one episode's transcript, the taxonomy, the topic in question.
- Output: 0–N candidate segments, each with `start_sec`, `end_sec`,
  `start_anchor`, `end_anchor` (verbatim from the transcript, 8–12 words),
  `topic`, `why` (≤18 words, copy-rules clean), `confidence`.
- **Returning zero segments must be a first-class, unpenalised answer.**
  Most episodes contain no segment worth a Foray. A prompt that implies a
  quota manufactures filler, and filler is what kills the format.
- Boundaries are chosen for editorial reasons only. An ad falling outside a
  segment is incidental and must never be mentioned in `why` (R11, #63 §3).

**Merge** — `tools/segments/merge-segments.mjs`, validates hard:
- Anchors must appear **verbatim** in the source transcript. This is the
  critical check — an LLM paraphrasing an anchor produces a boundary that
  can never be resolved, and it fails silently at playback. Reject, do not
  repair.
- `end_sec > start_sec`, both within `reference_duration_sec`.
- `why` passes `backend/src/copy/rules.js` (note: `deep dive` is banned —
  it will trip on segment prose more than you expect).
- Topic must be a real taxonomy node.
- Idempotent; a re-run must not duplicate.
- Output: `data/segments.json`.

## 4. Data model

One new file, additive. Nothing existing changes shape.

```jsonc
// data/segments.json
{
  "version": 1,
  "segments": [
    {
      "id": "lex-353-whyte#2530",
      "item_id": "lex-353-whyte",
      "topic": "engineering/energy-fusion",
      "start_sec": 2530, "end_sec": 3110,
      "reference_duration_sec": 11840,
      "start_anchor": "so the Lawson criterion is really a statement about",
      "end_anchor": "and that's why the tokamak won by default for thirty years",
      "why": "Whyte explains the Lawson criterion without hand-waving",
      "confidence": "high",
      "source": "agent-v1", "batch_id": "seg-2026-08-12-a",
      "needs_review": false
    }
  ]
}
```

A Foray is then an *ordered selection over this pool* plus narration —
which is `data/ladders.json`'s existing job (#65: extend, do not fork).
Segments are the raw material; ladders are the editorial artefact. Keeping
them separate is what lets the army run wide without anyone approving a
finished product it did not author.

## 5. Sequencing for the two-day window

```
now      ADR-0007 decision (Wyatt)        ── 30 min, blocks Lane C
         #64 ruling (Joey)                ── blocks Lane C
         ↓
day 1    Lane B: sweep-transcripts.mjs    ── build + run, ungated
         Lane A: breadth classification   ── fan out immediately, ungated
         ↓
day 1-2  Lane C prepare + merge tooling   ── build while A/B run
         ↓
day 2    Lane C fan-out on 2-3 topics     ── only where the sweep says
                                             free transcripts are dense
```

**Build the merge validator before the extraction runs, not after.** The
classification pipeline's own history is the argument: its validator caught
a real copy-rule violation in hand-written test fixtures. An army that runs
for a day against a missing validator produces a day of data nobody can
trust and nobody wants to hand-audit.

## 6. Explicit non-goals for this pass

- **No bulk Whisper.** Free transcripts only. The shortlist path stays as
  ADR-0004 designed it.
- **No automated Foray assembly.** The army produces *candidate segments*.
  Assembling three hand-authored Forays (#67) is still the honest test of
  whether the format is any good, and industrialising a format nobody wants
  is the expensive mistake available here (#63 §6).
- **No narration generation.** ElevenLabs spend is unapproved (#64 §2).
- **No DAI sources in a shipped Foray.** ADR-0007 makes the *extraction*
  durable for DAI; playback still waits on downloads (#29).
- **No writes to the curated tier.** Same structural rule as
  classification: this tooling has no write path to `data/catalog.json` or
  `data/discover.json` at all.
