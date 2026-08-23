# Segment extraction — architecture for the catalogue fan-out

How Foray goes from "19,787 shows and 73,719 archived episodes" to "a pool
of anchored, topic-tagged segments a Foray can be assembled from," at a
scale one person cannot hand-author.

Companion to `docs/adr/0007-segment-anchoring.md` (the boundary
representation — **read that first, it blocks this**) and epic #63.

Primary sources for the drift and transcript questions live in the *research*
corpus — not the transcript/episode corpus this document measures:
`docs/research/corpus/digests.md`, entries 9 (Podcast Namespace #254 — DAI
breaks timestamps), 19 (Castos DAI mechanics), 1 (`<podcast:transcript>` spec)
and 3 (WhisperX).

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

### Lane B — transcript availability sweep (BUILT, ran 2026-08-12)

Before anything can extract segments, we need to know *where free
transcripts actually are*. Today nothing records this: the refresh pipeline
never captures `podcast:transcript` at all, and `data/discover.json` items
carry no transcript field. `backend/src/feeds/parser.ts` parses
`transcriptUrl`, but that path is not what produces the live catalogue.

The parser now also exposes `timedTranscriptUrl` / `timedTranscriptType`
(issue #103): `transcriptUrl` prefers `text/plain`, which is right for
Tier-1 enrichment and useless for anchoring, since plain text carries no
timestamps. Anything in this pipeline that needs a boundary reads the
timed pair, never `transcriptUrl`.

This is a deterministic fetch job — **not** agent work. Codify it
(`CLAUDE.md` rule 6):

`tools/segments/sweep-transcripts.mjs` (issue #104) — built, dependency-free,
tested by `tools/segments/sweep-transcripts.test.mjs` (26 cases, fixtures only).

- For every show with a `feed_url`, fetch the feed once, politely: concurrency
  6 plus a per-host minimum interval (the feeds cluster onto a few CDNs, so
  concurrency alone is not politeness), honest User-Agent with a contact
  address, `Retry-After`-aware backoff on 429/5xx, 30s timeout.
- Per episode record: `guid`, `title`, `pub_date`, `duration_sec`,
  `transcript_url`, `transcript_type`, **`has_timestamps`**,
  `transcript_types` (every format the episode publishes), `chapters_url`.
- Per show record: `dai_suspected` + `enclosure_host` (via `tools/refresh/
  dai.mjs`, reused not reimplemented), counts for every episode, and
  `status`/`error_code` on failure.
- Checkpoint to `data/transcript-progress.json` (gitignored; machine state)
  after **each show**, atomically. Verified by SIGKILL mid-run: the restart
  swept only the remaining shows.
- Emit `data/transcript-availability.json`. **Episode rows are kept only for
  episodes with a transcript or chapters** — counts cover all 82,043, but
  storing every barren row would quadruple the file for data no lane can use.
  `--all-episodes` overrides.

Two rules the script enforces structurally: it has **no code path that fetches
a `transcript_url`** (a body index would be ~400MB), and every failure exits
through a coded error (`HTTP_404`, `TIMEOUT`, `EMPTY_FEED`, `NOT_RSS`,
`NETWORK`…) that lands in the show record — a run where no show succeeded
refuses to write an index at all.

**Measured 2026-08-12 over the 213 curated shows** (212 fetched; omega tau's
certificate has expired), 82,043 episodes:

| | episodes | with a transcript | |
|---|---|---|---|
| all | 82,043 | 8,012 | **9.8%** |
| DAI (144 shows) | 59,768 | 7,966 | **13.3%** |
| non-DAI (68 shows) | 22,275 | 46 | **0.2%** |

Only **7,515 (9.2%)** carry a *timestamped* format, i.e. ~500 transcribed
episodes are prose and cannot anchor a boundary. Chapters: 732 (0.9%).
Formats across 23,219 tags — vtt 7,063, srt 6,848, plain 6,632, html 1,268,
json 787, x-subrip 621 (~2.9 tags per transcribed episode). The corpus is also
**concentrated**: 30 of 213 shows publish any transcript, 25 publish a timed
one, and Stuff You Should Know (2,850) + Odd Lots (1,251) alone are half of it.
This confirms epic #102's finding independently. Expect the breadth tier to
differ — measure it, do not assume.

**This is the single highest-value thing to build first**, because it turns
"which episodes can we work on for free?" from a guess into a list, and
every downstream lane consumes it.

### Lane C — segment extraction (gated)

The army's real work, once #64 rules and ADR-0007 is accepted.

**Prepare** — `tools/segments/prepare-segment-batch.mjs` (BUILT 2026-08-23),
deterministic, keyless, no network:
- Input: the committed transcript digests plus the bodies `fetch-transcripts.mjs`
  already put in `data-local/transcripts/`. It does not fetch; a transcript that
  is not already on disk is not a candidate.
- **Gate the timeline before anything else (#315).** A transcript whose last cue
  overruns the feed's declared duration by more than
  `TIMELINE_OVERRUN_TOLERANCE_SEC` (5 s) is excluded, with the reason recorded.
  This is the one check nothing downstream can make: ADR-0007's anchor tolerance
  is ±120 s and `span_implausible`'s `MAX_SPAN_RATIO` is 1.5, so a 30–100 s
  offset resolves, passes, and plays the wrong words. Measured over the 1,718
  transcripts held on 2026-08-23: 58 overrun, 55 of them one show.
- Emit a batch file (episode metadata + the transcript the anchors will be
  authored against + `reference_duration_sec`, which is the FEED's number), the
  matching `data/segment-sources.json` rows written from that same number, and
  a numbered, timestamped rendering of each transcript for the extractor to
  quote from.

**Lint** — the same file, `--lint`. The tier-P/tier-B rules from
`segment-length-rules.md` §9 that the merge cannot enforce: L1/L3/L4/L5 drop a
candidate, S1/S2 flag it, M1 drops and M2 flags a same-episode pair that should
have been one segment, B1 reports the batch median.

**Agent** — `docs/agents/runner-prompts/segment-batch.md` (WRITTEN 2026-08-23,
from the brief the first real batch was run against), the contract:
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
