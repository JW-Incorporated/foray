# ADR 0004: Transcript Acquisition Ladder

## Status
Accepted — **design only**. Nothing in this ADR is implemented in this
pass (no transcript fetching, no Whisper integration); `episodes.
transcript_status` (migration 0003) and `episode_enrichment.tier = 2`
(migration 0004) reserve the storage shape this design writes into.

**Primary sources.** `docs/research/corpus/digests.md` digests the research
behind this ladder: entries 1 (`<podcast:transcript>` tag spec — step 1's
contract), 3 and 20 (WhisperX paper + implementation — the step-4 ingest
architecture) and 4 (pyannote diarization). Full text is searchable via
`node tools/corpus/corpus.mjs search` where the corpus DB exists (CLAUDE.md
§ Research corpus).

## Context
01_PROMPT.md item 3 asks for an ordering of preference among
`<podcast:transcript>`, publisher-hosted transcripts, YouTube captions for
simulcast shows, and Whisper — plus a decision on Whisper's compute
location (API vs. the user's always-on workstation, swappable), and *when*
an episode earns transcription. 02_ARCHITECTURE.md's cheap-first cascade
already answers the "when": Tier 2 (transcript-based enrichment) runs only
for episodes shortlisted by the curation engine's metadata-only pass, or
explicitly queued by the user — never in bulk. Corner case 33 makes this a
hard requirement: "Tier-2 requires a shortlist token minted by the
curation engine (can't be invoked in bulk by accident)."

## The ladder (in preference order)
1. **`<podcast:transcript>` tag** — already-parsed by
   `src/feeds/parser.ts` (`transcriptUrl`, preferring `text/plain` then
   `application/json` when a feed offers multiple formats). Zero cost,
   zero latency beyond a fetch — publisher already did the work and
   implicitly consents to transcript use by declaring the tag. Always try
   this first.
2. **Publisher-hosted transcript page** (linked from show notes, not the
   podcasting-2.0 tag). Requires a per-show scraper/heuristic to locate —
   not generically parseable the way the RSS tag is. Worth it for
   high-value recurring shows (e.g. a show the user subscribes to
   long-term) where the one-time cost of writing a scraper amortizes;
   not worth it as a generic fallback for every episode.
3. **YouTube captions for simulcast shows** — many interview podcasts
   (Lex Fridman among them) also publish full video to YouTube with
   auto-generated or creator-uploaded captions. When a show's `shows` row
   can be matched to a YouTube channel (manual mapping initially; the
   `show_id ↔ youtube_channel_id` link is not automatic), captions are
   free relative to Whisper and often more accurate than ASR alone
   (creator-reviewed on popular channels). Timestamps from YouTube
   captions carry the same DAI caveat as everything else (corner case 2)
   if the audio podcast version has different ad placement/duration than
   the YouTube video — treat as approximate, never a hard seek target,
   exactly as the corner-cases doc requires for DAI-suspected shows.
4. **Whisper (self-hosted or API), last resort.** Only reached when steps
   1–3 all miss. This is the expensive step cost-discipline exists to
   gate.

## Whisper compute location: swappable, decided per-call
Design the call site as a `TranscriptionProvider` interface (not built in
this pass) with at least two implementations:
- **API-backed** (e.g. a hosted Whisper endpoint): simplest to operate,
  metered like any other `cost_events` row (`operation: "tier2_transcript"`,
  `provider: "whisper-api"`), no infrastructure to babysit. Default for
  correctness and to avoid depending on the user's workstation being
  online at ingest time.
- **Workstation-hosted** (the user's always-on machine, per
  01_PROMPT.md's explicit mention "I have one"): zero marginal API cost,
  but requires the ingest worker to reach it (a queue the workstation polls,
  or an inbound connection the worker makes to it) and a health/availability
  check before routing work there — a transcription job must not silently
  vanish if the workstation is asleep or offline. `cost_events` still
  records these rows (`estimated_usd: 0`, `provider: "whisper-local"`) so
  the audit trail is uniform regardless of where compute happened.

The interface boundary is deliberately at the `TranscriptionProvider`
level, not baked into the enrichment pipeline, so switching from
"API by default" to "workstation by default" (or per-show/per-priority
routing between the two) is a config change, not a rewrite — directly
answering 01_PROMPT.md's "design the interface so the compute location is
swappable."

## When an episode earns transcription
Exactly per 02_ARCHITECTURE.md: **shortlisted by the curation engine's
Tier-0/Tier-1 score AND actually needed** — either the episode is a live
candidate for tomorrow's session (top-N per archetype pool before final
slot selection) or the user explicitly queues it (e.g. "give me more depth
on this one" voice command, not built yet). A Tier-2 job must be minted
with a shortlist token traceable back to the curation engine run that
requested it (corner case 33) — no code path may queue transcription for
an arbitrary batch of episodes directly.

## Consequences
- No transcript-derived segment maps or pull-quotes exist yet — Tier-1-only
  why-lines must hedge scope ("billed as...") per corner case 30, which
  `AnthropicEnricher`'s prompt already does implicitly by working from
  show-notes metadata rather than claiming transcript-verified content.
- The YouTube-captions path needs a `show_id ↔ youtube_channel_id` mapping
  table not yet designed; deferred until a concrete simulcast show is
  actually being enriched, to avoid guessing at a schema with no real
  usage to validate it against.
- Whisper cost estimation (USD per audio-minute, both API and
  self-hosted-amortized) is not filled in yet — the budget guard's Tier-2
  cutoff (`src/cost/budgetGuard.ts`, 60% of daily budget) applies once real
  numbers exist; today nothing calls it because nothing invokes Tier 2.
