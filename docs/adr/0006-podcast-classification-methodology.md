# ADR 0006: Podcast Classification Methodology (Breadth Tier)

## Status
Proposed — **design only**. No classification run, no LLM spend, in this
pass. Awaiting founder go-ahead per the task that commissioned this ADR.
Implementation (pilot run, then scaled run) is a separate, explicitly
approved follow-up.

## Context
The breadth tier (`data/catalog-breadth.json`, 19,787 US shows;
`data/catalog-breadth-intl.json.gz`, 121,786 international shows) is
classified today by `tools/classify-breadth.mjs` + an "8-slice opus
refinement" recorded in `data/breadth-classification.json`
(`docs/DECISIONS.md`, 2026-07-09 "scale day"). The founders do not trust
this output. Two concrete failures motivate distrust:

1. **The refinement pass classified from title + Apple genre only — no
   show description, no episode content.** `data/breadth-classification.json`
   entries tag their source as `"llm-title-genre"`. Confirmed failure:
   *Science Friday* (a general-audience science show, `apple_genre:
   "Life Sciences"`, `chart_rank: 1` in its genre) is tagged
   `medicine/biology` at `confidence: "low"` — a plausible-sounding but
   wrong node, because the classifier had nothing to work with beyond a
   genre string and a title that doesn't self-describe.
2. **`data/catalog-breadth.json` show records have no `description` field
   at all** (verified against the schema: `apple_collection_id`, `title`,
   `feed_url`, `artwork_url`, `apple_genre`, `apple_genre_ids`,
   `episode_count`, `explicit`, `chart_genre_id`, `chart_genre_name`,
   `chart_rank`, `in_curated`, `podcastindex_id`, `tier`, `region`,
   `harvest_source`, `harvested_at` — no description, no episode data).
   This means the "richer" signal the task asks Tier 1 to use
   (description + sample episode titles/descriptions) **does not exist
   yet for the breadth catalog** and must be fetched as a preliminary
   step; it was never available to the 2026-07-09 refinement pass either.

A parallel, independently-filed data-integrity issue
([#12](../../../issues/12), curated tier) documents the same class of
error at episode granularity: 46 `data/discover.json` episodes carry
`topics: ["engineering/energy-fusion"]` despite being about FFmpeg, the
LHC beam dump, fission reactors, and EV chargers — general
engineering/physics content dumped into an adjacent, more-specific node.
This is the sharpest available evidence that **genre + title alone
cannot distinguish adjacent nodes** (fusion vs. fission vs. general
engineering vs. energy-grid), and that the failure mode is not random
noise but systematic node-pollution from coarse signal.

## Decision
Adopt a three-tier cheap-first cascade for **show-level** classification,
mirroring `02_ARCHITECTURE.md`'s enrichment pipeline pattern
(Tier 0 free → Tier 1 cheap LLM → Tier 2 gated escalation) and reusing
`backend/src/enrich/`'s existing conventions (budget-guard-gated,
schema-validated JSON output, `claude-haiku-4-5` as the Tier-1 model,
per-call `cost_events` audit row) rather than inventing a parallel
pattern.

**Tier 0 (free, deterministic) — prior, never final.**
`data/genre-taxonomy-map.json` (Apple genre → taxonomy node, already
built, 110 genres mapped) plus title-keyword matching produces a
candidate topic set and a confidence label. This is unchanged from
today's `classify-breadth.mjs` — kept because it's free and a reasonable
starting prior — but is explicitly demoted from "the classification" to
"a prior fed into Tier 1," never written as a final answer on its own.

**Tier 0.5 (free, but real wall-clock cost) — signal acquisition.**
Because the breadth catalog has no description or episode data, a new
step fetches each show's RSS feed (feed_url already present for 99.7% of
US shows, per `docs/CATALOG-PIPELINE.md`) and extracts the channel
`<description>`/`<itunes:summary>` plus the ~5–10 most recent `<item>`
title+description pairs. Zero dollar cost; the real cost is politeness
(rate-limited, jittered, per-host — following the pattern already
established for the Apple chart harvester and the ingest worker's
conditional-GET discipline) and engineering robustness (dead feeds,
timeouts, malformed XML must degrade to Tier-0-only + `needs_review`,
not crash the batch). This step is a prerequisite this ADR flags as new
scope, not something `classify-breadth.mjs` does today.

**Tier 1 (cheap LLM) — the default final answer for most shows.**
`claude-haiku-4-5` ($1.00/$5.00 per MTok), given: show title, Tier-0
genre prior, fetched description (truncated), and the fetched episode
sample (titles + truncated descriptions). Multi-label output: an array
of `{node, confidence}` pairs (not a single node — a show can legitimately
span `science` + `medicine/biology` + `education`), a `needs_review`
boolean, and a short rationale string (cheap, aids human audit of the
pilot and any later spot-check). The full taxonomy node list is placed
in a cached system block (`cache_control: {type: "ephemeral"}`) since it
is byte-identical across all ~20k calls — this is a straightforward,
free-to-adopt cost reduction the current per-episode `AnthropicEnricher`
doesn't need (it classifies one episode at a time with no shared
system-level catalog) but a 20k-show batch clearly benefits from. The
Message Batches API (50% off standard pricing, appropriate since this is
non-interactive) is the default execution mode.

**Tier 2 (escalation, gated) — reserved, not default.**
Escalates only when Tier-1 confidence on every candidate node is below a
threshold (e.g. 0.6), or Tier-1's top node conflicts with a
high-confidence Tier-0 genre prior (the exact signature of the fusion/
fission confusion in issue #12), or the show is a `chart_rank` top-N
show in its genre (higher stakes — more listeners are exposed to a wrong
tag). Tier 2 uses a stronger model (Sonnet 5) with the same fetched
signal plus, only if `<podcast:transcript>` is already present in the
RSS feed for 2–3 recent episodes (ADR-0004's tier-1 transcript
source — already free, zero additional fetch), truncated transcript
excerpts. **Full transcripts for every show are explicitly rejected as
the default** — see Rejected Alternatives below.

**Output never silently guesses.** Every show gets a `needs_review: true`
flag when confidence is low after Tier 2 (or Tier 2 wasn't reached and
Tier 1 was inconclusive) rather than forcing a best-guess node. A show
with no confident node above threshold is tagged `topics: []`,
`needs_review: true` — visible and auditable, not hidden behind a
plausible-looking wrong label (exactly the failure mode that produced
the Science Friday and issue-#12 errors).

**Forward-compatible display fields, captured now, not surfaced now.**
The same Tier-1 call additionally produces two Foray-authored fields,
since the marginal cost is a handful of output tokens on a call that is
already reading the show's description and recent episodes:
- `display_title`: a short, accurate tile header — used when the real
  show title is long, opaque, or clickbait-shaped (e.g. a title that's a
  pun or a host's name with no topic signal). If the real title is
  already clear, this is a light normalization or a pass-through, never
  an invented framing that misrepresents the show.
- `blurb`: a 1–2 sentence tile description, grounded strictly in the
  fetched description/episode content — never fabricated, never
  exaggerated (principle #3, "legally boring," extends naturally to
  "don't invent what a show is about").

Both are **copy-gated** against the existing rules in
`backend/src/copy/rules.js` (the banned-phrase list — "fascinating,"
"deep dive," "delve," "explores," clickbait withholding,
commute-length framing — and the word-count helper already enforced on
every other user-facing copy surface in `data/*.json`). A show whose
generated `display_title`/`blurb` fails the copy gate is treated the
same as a low-confidence classification: flagged, not silently emitted.

**This ADR reserves the fields; it does not decide UI.** Whether/how
these surface — header vs. subtitle, which surfaces get a tile at all —
is Joey's product call, later, informed by the future tile UI work. This
pass only captures the data at classification time (cheap, same call) so
that decision isn't blocked on a second reclassification pass later.

## Cost model summary
The display-fields addition above does not change the cost estimate
materially (a few dozen extra output tokens per show at Tier-1 pricing).
See the pilot/cost-model report accompanying this ADR (delivered to the
founders alongside this file, not duplicated here to avoid the two
drifting) for the full token/dollar breakdown. Headline numbers: Tier 1
alone across all 19,787 US shows is roughly $25–$85 depending on
batch/cache adoption; a full Tier 1 + Tier 2 pass (assuming ~15–25% of
shows escalate) lands in the **$100–$200** range. The pilot (50–100
shows) costs under $5. The 121,786-show international batch is **not
in scope for this pass** — extrapolated at roughly 6x the US cost
(~$700–900) and explicitly deferred pending a founder scope decision,
separately from cross-lingual classification-quality risk (the taxonomy
is English-labeled; non-English show descriptions add an open question
this ADR does not resolve).

## Budget-guard routing
The existing `BudgetGuard`/`costEvents` machinery
(`backend/src/cost/budgetGuard.ts`) already tier-routes by operation-name
prefix (`tier1_*` / `tier2_*`) with no code change needed — this batch
job's calls use operation names `tier1_classify_breadth_show` /
`tier2_classify_breadth_show_escalate` so they fall into the existing
cutoff logic. The **production runtime daily cap** (`DAILY_BUDGET_USD`,
default $2.00) is deliberately not the ceiling for this job — a
one-time ~$120–200 batch spend would take years to clear at $2/day, and
conflating the two would either block the batch indefinitely or require
inflating the production cap for a one-off, both wrong. Instead, the
classification tool constructs its own `BudgetGuard` instance with an
explicit `--budget-usd` CLI flag (the constructor already accepts a
`dailyBudgetUsd` override — no interface change), so a founder-approved
one-off ceiling is enforced structurally without touching the runtime
guard other engine code paths rely on. Every call still writes a
`cost_events` row (synthetic `userId: "system:catalog-breadth-classify"`)
so the batch's actual spend is auditable exactly like any other LLM call
in the system.

## Options considered

1. **Title-only classification (today's `llm-title-genre` refinement).**
   Rejected — this is the status quo and is the documented cause of the
   Science Friday misclassification. A title alone frequently doesn't
   name its subject (show names skew branded/cute, not descriptive), so
   the model is left guessing from genre alone, which is exactly the
   coarse signal the founders no longer trust.
2. **Full transcripts for every show, always (Tier-2-as-default).**
   Rejected on cost and architecture-consistency grounds. Transcribing
   or even just fetching+processing full transcripts for ~10 episodes
   per show × 19,787 shows is one to two orders of magnitude more
   expensive than the Tier-1 pass (transcript text alone typically runs
   5,000–15,000+ tokens per episode vs. ~50–200 for a truncated
   description) and requires the transcript acquisition ladder
   (ADR-0004) to run at bulk scale — which ADR-0004 itself explicitly
   scopes to curation-engine-shortlisted episodes only, calling bulk
   invocation exactly the corner case (#33) the budget guard exists to
   prevent. Description + episode-title sampling is already
   information-dense enough to resolve the concrete failure cases
   observed (Science Friday's description says "science news"; the
   fusion/fission cluster's episode titles alone would have disambiguated
   most of the 46 mistagged items). Transcripts are reserved for Tier 2's
   narrow, already-ambiguous-after-Tier-1 slice, where the marginal cost
   is justified by the marginal signal.
3. **Genre-map-only, keep it deterministic, never call an LLM.**
   Rejected — this is Tier 0 alone, and Tier 0 alone is precisely what
   produced garbage results before any LLM was involved (the pre-refinement
   genre-map base). Apple's genre taxonomy is coarse by design (110
   genres for a taxonomy this project needs ~120+ specific nodes to
   cover) and cannot express node-level nuance no matter how carefully
   the map is hand-tuned — Science Friday's genre is "Life Sciences,"
   which is defensibly close to `medicine/biology` even though the show
   itself is general-science, not biology-specific. The map is kept as
   Tier 0's prior (cheap, non-zero signal) but never trusted alone.
4. **Single confidence score per show (top-1 classification) instead of
   multi-label with per-node confidence.** Rejected — `data/taxonomy.json`
   and ADR-0003 establish multi-label as the representation the rest of
   the system (curation engine, learning job, interests editor) already
   expects; forcing top-1 here would need a lossy re-expansion step
   downstream and would hide genuine multi-topic shows (a show can
   legitimately be both `business/startups` and `craft/instrument-making`
   if that's what it is) behind a single dominant tag.

## Consequences
- **New scope this ADR creates but does not implement yet**: the RSS
  description/episode-sample fetch step (Tier 0.5) does not exist in any
  committed tool today; `tools/classify-breadth.mjs` only ever consumed
  fields already present in `catalog-breadth.json`. Building it is
  in-scope for the implementation phase, gated on founder go-ahead.
- **Taxonomy governance gap, not resolved here**: shows that fit no
  existing node well (the multi-label output legitimately returns
  `topics: [], needs_review: true`) surface a taxonomy-coverage gap the
  same way the 2026-07-09 "new_nodes" expansion in `data/taxonomy.json`
  did (60+ nodes added at `confidence: 0.3`, i.e., provisional). This
  ADR does not define the process for reviewing `needs_review` output
  and deciding "add a taxonomy node" vs. "force into the nearest
  existing node" vs. "leave untagged" — flagged as an open question for
  the founders, not a silent default either way.
- **The existing `AnthropicEnricher`/`Enricher` interface is
  episode-level** (`ClassificationInput` takes `episodeId`,
  `showTitle`, `title`, `descriptionText`, `durationSeconds`) and is not
  reused verbatim — a **new**, parallel show-level classification
  function is needed (same conventions: budget-guard-gated, zod-schema-
  validated JSON, `StubEnricher`-style dry-run path for tests) rather
  than overloading the episode interface with show-shaped inputs.
- **Batch API adoption is new** — nothing in the codebase currently uses
  `client.messages.batches.*`; this is the first use, and the
  implementation phase should treat "does the SDK version pinned in
  `backend/package.json` support Batches + prompt caching cleanly"
  as a pre-flight check, not an assumption.
- Re-running this pass is idempotent by design (content-hash-keyed
  cache, per `02_ARCHITECTURE.md`'s Tier-1 caching convention) so a
  partial run, a taxonomy update, or a re-harvest of `catalog-breadth.json`
  can re-trigger only the shows whose input signal actually changed.
