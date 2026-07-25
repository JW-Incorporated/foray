# Breadth-catalog classification methodology — plan

*2026-07-24. Companion to `docs/adr/0006-podcast-classification-methodology.md`.
The ADR records the decision and rationale; this doc carries the detail that
would otherwise bloat it — the full cascade spec, the (now-superseded) dollar
cost model, and the original pilot design.*

**Execution-engine update (read this first):** the plan below was approved
with classification calls running through the Anthropic API — that's the
context for §2's dollar cost model and §3's pilot design as written. Before
any run happened, the founders moved execution to **Claude Max-plan Claude
Code cron routines** (no API key, no per-token cost; constraint is weekly
usage, paced over ~2 weeks). The methodology, signals, and output schema
below are all still accurate and were **not** rewritten — only §2 and §3's
"how do we spend money running this" framing is now moot. See ADR-0006's
"Execution engine" and "Usage/pacing model" sections for the operative
version, and `tools/classify/README.md` for the tooling this plan became
(`tools/classify/prepare-batch.mjs`, `tools/classify/merge-results.mjs`,
`docs/agents/runner-prompts/classify-batch.md`). §2 and §3 are left as
written below as the honest historical record of what was proposed.

## 0. Why this exists

The founders don't trust `data/breadth-classification.json`. Concretely:

- The current pipeline's final layer (`docs/DECISIONS.md`, 2026-07-09 "scale
  day": *"Breadth tier fully classified: 19,787 shows... genre-map base + 8-slice
  opus refinement"*) tagged shows using **title + Apple genre only** — every
  refined entry in `data/breadth-classification.json` carries
  `"source": "llm-title-genre"`. There was no show description and no episode
  content in the prompt, because none existed in the data available to it.
- Confirmed failure: **Science Friday** — a general-audience science show,
  `apple_genre: "Life Sciences"`, `chart_rank: 1` in its Apple genre — is tagged
  `topics: ["medicine/biology"]` at `confidence: "low"`. Plausible-looking,
  wrong.
- Independently, [issue #12](../../issues/12) documents the same failure mode
  at episode granularity in the curated tier: 46 `data/discover.json` items
  tagged `engineering/energy-fusion` are actually about FFmpeg, LHC beam
  dumps, fission reactors, and EV chargers. This is not random noise — it's
  systematic dumping of general/adjacent content into a specific node because
  the classifier (title + genre, in that pipeline too) can't tell "engineering
  in general" from "fusion specifically," or "fission" from "fusion."
- **Root architectural gap**: `data/catalog-breadth.json` show records have
  no `description` field. Verified against the harvester (`tools/harvest-catalog.mjs`)
  and a live sample record — fields present are `apple_collection_id`, `title`,
  `feed_url`, `artwork_url`, `apple_genre`, `apple_genre_ids`, `episode_count`,
  `explicit`, `chart_genre_id`, `chart_genre_name`, `chart_rank`, `in_curated`,
  `podcastindex_id`, `tier`, `region`, `harvest_source`, `harvested_at`. No
  description, no episode data. The "richer per-show signal" this plan's
  Tier 1 needs literally does not exist in the harvested data yet.

## 1. The cascade

Mirrors `docs/brief/02_ARCHITECTURE.md`'s "Enrichment pipeline (cheap-first
cascade)" philosophy, extended for show-level (not episode-level)
classification.

### Tier 0 — free, deterministic, prior only

`data/genre-taxonomy-map.json` (already built: 110 Apple genres → taxonomy
node(s) + confidence label) + a small title-keyword table. Output: a
candidate topic set + confidence (`high`/`medium`/`low`), written as
`source: "genre-map"` exactly as `tools/classify-breadth.mjs` does today.
**Change from today: this output is never the final answer.** It's an input
feature to Tier 1, not a fallback that gets silently upgraded to `"final"`
when the LLM agrees. (Today's pipeline effectively does treat genre-map
output as final when it exists and only refines the gaps — that's part of
why Science Friday's `Life Sciences → medicine/biology` genre-map inference
never got a second look.)

### Tier 0.5 — free ($0), real wall-clock cost — signal acquisition

**New scope. Nothing today fetches this.** For each show with a `feed_url`
(99.7% of US breadth shows per `docs/CATALOG-PIPELINE.md`), fetch the RSS
feed and extract:

- Channel-level `<description>` / `<itunes:summary>` (truncate to ~800
  chars for the prompt — most show descriptions are 1–3 paragraphs; longer
  ones are usually boilerplate/legal text after the first paragraph).
- The 5–10 most recent `<item>` elements: `<title>` + `<description>`
  (truncate each description to ~200 chars). Recent episodes are the
  cheapest available proxy for "what does this show actually cover right
  now" — far richer than a static show blurb for shows that pivot content
  over time.

Implementation notes (design, not built):
- Politeness matches the existing pattern: `tools/harvest-catalog.mjs` uses
  ≥3s between requests against a *single* host (Apple's chart API); this
  step hits ~19,787 *different* hosts, so it can run with much higher
  aggregate throughput (concurrent requests spread across hosts) while
  still respecting per-host rate limits and an honest User-Agent — closer
  in spirit to the backend ingest worker's per-feed polling discipline
  (conditional GET, no hammering) than to the single-host chart harvest.
- Expect real failures: dead feeds, redirects, timeouts, malformed XML,
  paywalled/geo-blocked feeds. Budget for **10–15% failure rate**. A failed
  fetch does not block the show — it falls back to Tier-0-only
  classification with `confidence` capped at `"low"` and `needs_review: true`.
- Estimated wall-clock: at a conservative sustained 2–3 req/sec (parallel
  across hosts, single-threaded politeness per host), ~19,787 shows
  completes in roughly 2–3 hours. This is infrastructure/engineering time,
  not a line item in the dollar budget below.
- Output is cached to a new file (e.g. `data/breadth-signal.json`, keyed by
  `apple_collection_id`) so Tier 1/Tier 2 reruns (e.g. after a taxonomy
  update) don't re-fetch feeds that haven't changed. Content-hash the
  fetched text so a Tier-1 re-run only re-classifies shows whose signal
  actually changed — same idempotency principle `02_ARCHITECTURE.md`
  specifies for episode enrichment ("cache forever keyed on content hash").

### Tier 1 — cheap LLM, the default final answer

Model: `claude-haiku-4-5` ($1.00 / $5.00 per MTok input/output — same model
and pricing already documented in `backend/src/enrich/AnthropicEnricher.ts`
for episode-level Tier-1 classification; reusing it here keeps one
cost/quality tier consistent across the codebase rather than introducing a
second "cheap model" choice).

**Input per show:**
- Show title
- Tier-0 genre-map prior (topics + confidence) — given to the model as
  context, explicitly labeled as a *prior*, not ground truth, so the model
  isn't anchored into repeating it
- Fetched description (Tier 0.5), truncated
- Fetched episode sample (Tier 0.5): 5–10 title+description pairs

**Output (schema-validated JSON, same `parseWithRetry` pattern as
`AnthropicEnricher.ts`):**
```json
{
  "topics": [
    { "node": "science", "confidence": 0.85 },
    { "node": "medicine/biology", "confidence": 0.4 }
  ],
  "needs_review": false,
  "rationale": "General-audience science news show; occasional biology/medicine segments.",
  "display_title": "Science Friday",
  "blurb": "Weekly science news and interviews covering research, technology, and the natural world."
}
```

**`display_title` and `blurb` (added post-pilot-design, founder request).**
Generated in the same Tier-1 call — marginal cost is a handful of output
tokens, not a second call. `display_title` is a short, accurate tile
header (light normalization or pass-through when the real title is
already clear; never an invented framing when the real title is opaque
or clickbait-shaped). `blurb` is a 1–2 sentence tile description grounded
strictly in the fetched description/episode content. Both are
**copy-gated** using the existing `backend/src/copy/rules.js`
(`BANNED` regex list + `wordCount`) — the same gate every other
user-facing copy surface in `data/*.json` already passes through. A show
whose generated fields fail the gate is flagged, not silently emitted
with banned phrasing. **This plan captures the fields; it does not decide
whether/how they surface in the UI** — that's a later, separate product
call (ADR-0006 §"Forward-compatible display fields").
- Multi-label, not top-1 — a show can legitimately span nodes (consistent
  with ADR-0003's taxonomy representation and how `data/taxonomy.json` is
  consumed downstream).
- Per-node confidence (0–1), not a single show-level confidence bucket —
  lets a show be tagged `science` with high confidence and
  `medicine/biology` with low confidence simultaneously, rather than
  forcing one number to describe a multi-label decision.
- `needs_review: true` whenever every candidate node's confidence is below
  a threshold (proposed default **0.6** — tune during the pilot), or when
  the model's top node contradicts a `"high"`-confidence Tier-0 genre-map
  prior (the exact signature that would have caught the fusion/fission
  pollution in issue #12 — a show whose Apple genre confidently maps to
  `engineering` but whose LLM classification lands on
  `engineering/energy-fusion` specifically is exactly the case that should
  raise a flag, not be silently accepted).
- `rationale`: short (~15 words), cheap to generate, makes human spot-review
  of `needs_review` items and pilot QA tractable without re-deriving intent
  from raw show data every time.

**Cost-saving techniques (both free to adopt, neither used by the existing
per-episode `AnthropicEnricher`, both a natural fit for a 20k-call batch):**
1. **Prompt caching.** The full taxonomy node list (~120 nodes, id + label +
   apple_anchor) plus the classification instructions is byte-identical
   across all ~20k calls — put it in a `cache_control: {type: "ephemeral"}`
   system block. One cache write, then every subsequent call reads at ~0.1x
   the input price. `docs/adr/0003-taxonomy-representation.md` already
   established the taxonomy as the shared reference structure; this is
   just the LLM-cost-aware way to hand it to the model.
2. **Message Batches API** (`POST /v1/messages/batches`, 50% off standard
   token pricing, up to 100k requests per batch, results within ~1h
   typically / 24h max). This job is not latency-sensitive — a founder
   kicking off a reclassification run doesn't need results in seconds. Not
   currently used anywhere in this codebase; would be the first adoption.
   Confirmed compatible with prompt caching (see `shared/prompt-caching.md`
   and the Batches API doc's "Batch with Prompt Caching" pattern — cache
   the shared system prompt once, then batch the ~20k varying-content
   requests against it).

### Tier 2 — escalation, gated, reserved

**Escalation trigger (any one of):**
- Every Tier-1 candidate node's confidence is below threshold (default 0.6).
- Tier-1's top node conflicts with a `"high"`-confidence Tier-0 prior (see
  above — this is the issue-#12 signature).
- The show is a `chart_rank` top-N-in-genre show (proposed: top 20 per
  genre) — higher stakes because more prospective listeners see the tag;
  worth the extra cost to double-check even absent a confidence trigger.

Model: **Sonnet 5** (`claude-sonnet-5`, $3.00/$15.00 per MTok, intro pricing
$2.00/$10.00 through 2026-08-31) — a meaningfully stronger model than Haiku
without jumping to Opus-tier pricing, appropriate for "resolve genuine
ambiguity" rather than "the model just needs more examples." Input: same
fetched signal as Tier 1, **plus**, only if already present for free —
`<podcast:transcript>` tag content for 2–3 recent episodes (ADR-0004's
tier-1 transcript source; zero additional fetch cost since the feed is
already being pulled at Tier 0.5) — truncated to ~2,000 chars each. Shows
without a `<podcast:transcript>` tag get Tier 2 on the same description/
episode-sample signal as Tier 1, just with a stronger model and an explicit
instruction to weigh the Tier-0/Tier-1 disagreement directly (e.g. "Tier 1
proposed X but the show's genre strongly suggests Y — which is right, and
why?").

**Escalation is expected to be the minority of shows** — proposed budget
assumption 15–25% of the catalog, tunable after the pilot measures real
Tier-1 confidence distribution. If the pilot shows a much higher escalation
rate than expected, that's itself a signal the Tier-1 prompt or confidence
threshold needs tuning before a full run, not a reason to silently absorb
the cost.

### What never happens: full transcripts as the default

Explicitly rejected — see ADR-0006 "Rejected Alternatives" for the full
argument. Summary: transcript text runs 5,000–15,000+ tokens per episode
vs. ~50–200 for a truncated description; fetching/transcribing ~10 episodes
per show × 19,787 shows would be one to two orders of magnitude more
expensive than Tier 1, and would require running ADR-0004's transcript
acquisition ladder at bulk scale — which that ADR explicitly scopes to
curation-engine-shortlisted episodes only, calling bulk invocation exactly
the corner case (#33: "a bug queues 500 episodes for transcription
overnight") the budget guard exists to prevent. The concrete failure cases
observed (Science Friday, the fusion/fission cluster) are resolvable from
description + episode titles alone — transcripts buy diminishing marginal
signal at a cost the founders have not been asked to approve.

## 2. Cost model (superseded — API-era estimate, kept for the record; see ADR-0006 "Usage/pacing model" for the operative version)

All figures use current pricing (`claude-haiku-4-5`: $1.00/$5.00 per MTok;
`claude-sonnet-5`: $3.00/$15.00, or $2.00/$10.00 intro through 2026-08-31).
Batch API halves standard token pricing; prompt-cache reads are ~0.1x,
cache writes ~1.25x (5-min TTL). Figures below are per-show estimates ×
19,787 US breadth shows, rounded.

### Token estimate per show (Tier 1)

| Component | Tokens (approx) | Cached? |
|---|---:|---|
| Taxonomy node list + instructions (system) | ~2,500 | Yes — shared across all calls |
| Show title + Tier-0 prior | ~30 | No |
| Fetched description (truncated ~800 chars) | ~200 | No |
| Episode sample (7 episodes × ~60 tok) | ~420 | No |
| **Variable input total** | **~650** | |
| Output (topics array + rationale) | ~150–250 | No |

### Tier 1 cost per show

| Scenario | Per-show cost | Full US catalog (19,787) |
|---|---:|---:|
| No caching, no batch (standard API) | ~$0.0043 | ~$85 |
| Caching only, standard API | ~$0.002 | ~$40 |
| Caching + Batch API (recommended) | ~$0.0011 | ~$22 |

### Tier 2 cost per show (escalated shows only)

Assumes ~1,200–1,500 tokens variable input (description + episode sample +
occasional transcript excerpt), ~500–800 output/thinking tokens at
`effort: medium`, same taxonomy caching:

| Scenario | Per-show cost |
|---|---:|
| Sonnet 5, no caching, standard API | ~$0.025 |
| Sonnet 5, caching + Batch | ~$0.012 |

At an assumed **20% escalation rate** (3,957 shows): **~$47–$99** depending
on caching/batch adoption.

### Combined estimate — full US breadth catalog (19,787 shows)

| Adoption level | Tier 1 | Tier 2 (20% escalate) | **Total** |
|---|---:|---:|---:|
| Neither caching nor batch | $85 | $99 | **~$184** |
| Caching + Batch (recommended) | $22 | $47 | **~$69** |
| Mid case (caching only) | $40 | $70 | **~$110** |

**Headline range: $70–$185 for the full US breadth reclassification**,
expected to land near the caching+batch figure (~$70–$110) since both
optimizations are essentially free to adopt (no architectural cost, just
correct API usage) and there's no reason not to use them for a batch job
like this.

### International batch (out of scope for this pass)

`data/catalog-breadth-intl.json.gz` — 121,786 shows, ~6.15x the US catalog
size. Extrapolating the combined estimate: **~$430–$1,140**, likely
~$550–$700 at the recommended caching+batch adoption level. **Not proposed
for this pass** — flagged as a distinct, larger scope decision, and
compounded by an unresolved risk this plan does not answer: the taxonomy
(`data/taxonomy.json`) is English-labeled, and classification quality on
non-English show descriptions into an English node taxonomy is untested.
If the international batch is ever approved, it should get its own pilot
first, not inherit the US pilot's validation.

### Pilot cost

50–100 shows, Tier 1 for all, Tier 2 for a deliberately oversampled ~30%
(since the pilot exists partly to exercise the escalation path and measure
its trigger rate — see §3): **well under $5**, likely $1–2. This is small
enough that the pilot's dollar cost is not the reason to seek go-ahead —
it's the principle (every LLM call requires approval per CLAUDE.md's
decision-authority rule #3) and the chance to validate the methodology
against known-hard cases before spending on the full catalog.

### Budget-guard mechanics

The batch job is **not** run under the production `DAILY_BUDGET_USD`
runtime cap (default $2.00 — designed for daily per-user app traffic, not
a one-off catalog job; at $2/day a $100 spend would take 50 days to clear,
which would either block the batch indefinitely or pressure someone into
quietly raising the production cap for an unrelated reason). Instead:

- The classification tool constructs its own `BudgetGuard` instance,
  passing an explicit `dailyBudgetUsd` override (the constructor already
  accepts this — `new BudgetGuard(sink, approvedBudgetUsd)` — no interface
  change needed).
- The founder-approved ceiling is passed as a CLI flag (e.g.
  `--budget-usd 250`), set comfortably above the estimated cost so a
  legitimate run doesn't get cut off mid-catalog, but still a real ceiling
  that trips `BudgetExceededError` if something runs away (e.g. a bug that
  loops on retries, or escalates far more shows to Tier 2 than expected).
- Operation names (`tier1_classify_breadth_show`,
  `tier2_classify_breadth_show_escalate`) fall into the existing
  `tierOf()` prefix-matching logic in `budgetGuard.ts` with zero code
  change to that file.
- Every call writes a `cost_events` row under a synthetic
  `userId: "system:catalog-breadth-classify"` so the batch's actual spend
  is queryable/auditable exactly like any other LLM call in the system —
  no parallel, unaudited spending path.

## 3. Pilot design (superseded — written for an API pilot that was never run; see `tools/classify/README.md` for what actually got built)

**Goal:** measure (a) agreement/disagreement vs. the current
genre-map/opus-refinement output, (b) correctness where a human can judge
it, (c) real per-show cost, (d) the actual Tier-2 escalation rate (the
20% assumption above is a planning placeholder, not measured), before
committing to a full-catalog run.

### Sample construction (50–100 shows)

1. **Genre spread** (~40 shows): stratified sample across a wide range of
   Apple genres/chart tiers — not just top-charting shows, since breadth-
   tier quality matters most for the long tail that never gets curated-tier
   editorial attention.
2. **Known-hard cases** (~15–20 shows): shows whose current
   `breadth-classification.json` entry looks likely wrong on inspection —
   Science Friday is one; a quick scan of other `source: "llm-title-genre"`,
   `confidence: "low"` entries against their `apple_genre`/`chart_genre_name`
   would surface more candidates worth including (e.g. shows where the
   genre-derived node and the title suggest genuinely different topics).
   Purpose: does the new methodology actually fix the documented failure
   mode, not just produce different-looking output.
3. **Adjacent-node confusion probes** (~10 shows): shows in and around the
   `engineering/energy-fusion`, `engineering/disasters`,
   `engineering/energy-grid`, and `medicine/biology` clusters implicated by
   issue #12 (even though that issue is curated-tier/episode-level, the
   same node-adjacency confusion is the exact failure mode this breadth
   methodology must avoid). Purpose: stress-test the Tier-0/Tier-1
   disagreement escalation trigger specifically.
4. **Deliberate easy cases** (~10–15 shows): shows whose current
   `"genre-map"` (not `"llm-title-genre"`) high-confidence tag looks
   obviously correct — e.g. a true-crime show genre-mapped to `true-crime`.
   Purpose: confirm the new methodology doesn't regress on cases the cheap
   deterministic tier already gets right; if Tier 1 disagrees with an
   obviously-correct genre-map tag on an easy case, that's a prompt bug to
   fix before scaling, not a nuance to accept.

### Execution plan (not run in this phase)

1. Tier 0.5 fetch for the sample only (RSS description + episode sample) —
   built as a small, reusable function even though the pilot only needs
   ~100 calls, since it's identical code the full run will use.
2. Tier 1 classify all sampled shows via the real Anthropic API
   (`ANTHROPIC_API_KEY` from the gitignored root `.env`), **not** the
   Batch API for the pilot (small enough that synchronous calls are simpler
   to debug and inspect one-by-one; Batch API is a full-run optimization).
3. Apply the Tier-2 escalation trigger; run Tier 2 for whichever subset
   actually triggers (expected to be inflated vs. the full-catalog rate
   given the deliberate hard-case oversampling in the pilot set).
4. Produce a comparison table per show: current `breadth-classification.json`
   tag vs. new Tier-1 (and Tier-2 where applicable) output, side by side,
   plus the `needs_review` flag and `rationale` string.
5. **Human judgment pass** (a founder or the agent, spot-checking):
   for each show where old and new disagree, is the new tag better, worse,
   or a genuine judgment call? For the known-hard-case and adjacent-node
   subsets specifically, does the new methodology resolve the documented
   failure?
6. Report: agreement rate vs. old classification, estimated correctness
   rate (where judgeable), real measured per-show cost (Tier 1 and Tier 2
   separately), real Tier-2 escalation rate, and a recommendation on
   whether the confidence threshold (0.6 proposed) needs tuning before the
   full run.

### What the pilot will spend, stated explicitly for approval

- Tier 0.5 fetch: $0, ~5–10 minutes wall-clock for ~100 feeds.
- Tier 1: 100 shows × ~$0.002–0.004/show (no batch discount at this scale,
  caching still applies) ≈ **$0.20–0.40**.
- Tier 2 (assume ~30 shows escalate, given deliberate hard-case
  oversampling): 30 × ~$0.012–0.025/show ≈ **$0.36–0.75**.
- **Total pilot spend: under $1.50**, comfortably under the $5 ceiling
  flagged in the founder-facing summary.

## 4. Open questions / risks (not resolved in this pass)

- **Taxonomy governance for `needs_review` output.** Neither this plan nor
  ADR-0006 defines the process for turning a batch of `needs_review: true`
  shows into a decision (new taxonomy node vs. force into nearest existing
  node vs. leave untagged). The 2026-07-09 taxonomy expansion (60+ nodes
  added at `confidence: 0.3`) suggests this has happened informally before;
  it should be a deliberate step this time, not a re-run of the same
  under-specified process that produced the distrust in the first place.
- **International/cross-lingual scope** — explicitly deferred (§2).
- **SDK Batch API + prompt caching compatibility** — should be confirmed
  against the exact `@anthropic-ai/sdk` version pinned in
  `backend/package.json` before the full run; not blocking for the pilot
  (which doesn't use Batches).
- **Confidence threshold calibration** — 0.6 is a starting proposal, not a
  measured value. The pilot's job is partly to produce a real distribution
  of Tier-1 confidence scores to calibrate against.
- **`in_curated: true` overlap** — breadth shows that are also in the
  curated tier (`catalog.json`) already have hand-authored tags in some
  cases; this plan doesn't specify precedence if the two ever disagree
  post-reclassification. Likely resolution: curated-tier hand tags win
  (higher-trust source), but this should be an explicit rule, not an
  accident of write order.
