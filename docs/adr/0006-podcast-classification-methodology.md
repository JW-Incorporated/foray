# ADR 0006: Podcast Classification Methodology (Breadth Tier)

## Status
Accepted. Methodology approved; tooling built
(`tools/classify/prepare-batch.mjs`, `tools/classify/merge-results.mjs`,
`docs/agents/runner-prompts/classify-batch.md`). **Execution engine
changed after initial approval** — see "Execution engine" below: this
runs as Claude Max-plan Claude Code cron routines, not the Anthropic API,
so the cost model is a weekly-usage pacing plan, not a dollar figure. No
classification batch has been run yet; the orchestrator runs the first
test batches and paces the scheduled rollout using this tooling.

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

## Execution engine (superseding note)
This ADR's methodology was approved with the classification calls
running through the Anthropic API (`claude-haiku-4-5` Tier 1, Sonnet 5
Tier 2, budget-guard-gated, per-call `cost_events` rows). Before any run
happened, the founders changed the execution engine: **all classification
runs on the Claude Max plan via Claude Code cron routines**, the same
pattern already established for the nightly content refresh
(`docs/nightly-refresh-cloud.md`) — a scheduled Claude Code agent *is* the
classifier, reasoning directly over a batch of shows, rather than a
script calling a model API. There is no per-token dollar cost; the
constraint is the plan's **weekly usage limits**, paced by the
orchestrator across multiple runs (see "Usage/pacing model" below).

**Everything about the methodology below is unchanged** — the signals
(RSS description + 5–10 recent episode titles/descriptions, never full
transcripts by default), the cheap-first cascade shape, the multi-label
+ per-node-confidence + `needs_review` output, and the `display_title`/
`blurb` fields. Only the *invocation* changed: read the sections below
as "a classification agent does this reasoning," not "an API call with
this model does this reasoning" — the two model names below
(`claude-haiku-4-5`, Sonnet 5) describe the *intended reasoning quality*
at each tier and no longer name a specific billed API call. The API-
specific mechanics (prompt caching, Message Batches API, `BudgetGuard`
routing) that follow are **retained in this document as design
rationale that no longer applies operationally** — struck through in
place rather than deleted, so a future reader understands what was
decided and why the ground shifted, per CLAUDE.md's "knowledge lives in
the repo" instruction.

**Tooling built to this design**: `tools/classify/prepare-batch.mjs`
(Tier 0 + Tier 0.5, deterministic, keyless), `tools/classify/merge-results.mjs`
(schema + copy-rule validation, merge, idempotent), and
`docs/agents/runner-prompts/classify-batch.md` (the classification
agent's instructions — Tier 1 and Tier 2 both, see below). Full contract:
`tools/classify/README.md`.

## Decision
Adopt a three-tier cheap-first cascade for **show-level** classification,
mirroring `02_ARCHITECTURE.md`'s enrichment pipeline pattern
(Tier 0 free → Tier 1 cheap classification → Tier 2 gated escalation).
~~Originally specified as reusing `backend/src/enrich/`'s API-call
conventions (budget-guard-gated, schema-validated JSON output,
`claude-haiku-4-5` as the Tier-1 model, per-call `cost_events` audit
row).~~ Under the Claude Code cron execution engine, the classification
*agent itself* is the reasoning step (no API call, no `Enricher`
interface involved) — schema validation and audit-trail duties move to
`tools/classify/merge-results.mjs` instead.

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

**Tier 1 (cheap classification) — the default final answer for most
shows.** A Claude Code classification agent
(`docs/agents/runner-prompts/classify-batch.md`), given: show title,
Tier-0 genre prior, fetched description (truncated), and the fetched
episode sample (titles + truncated descriptions). Multi-label output: an
array of `{node, confidence}` pairs (not a single node — a show can
legitimately span `science` + `medicine/biology` + `education`), a
`needs_review` boolean, and a short rationale string (cheap, aids human
audit of any spot-check). ~~The full taxonomy node list was to be placed
in a cached system block (`cache_control: {type: "ephemeral"}`) since it
is byte-identical across all ~20k calls, and the Message Batches API
(50% off standard pricing) was the default execution mode.~~ Neither
applies under the Claude Code execution engine — the agent reads
`data/taxonomy.json` directly each run (see the runner prompt), and
there is no batch-API concept for an agent invocation. `tools/classify/prepare-batch.mjs`
selects a batch of shows per run (`--batch-size`, tunable) so the unit
of work stays exactly as designed — only *how* a batch gets classified
changed.

**Tier 2 (escalation, gated) — reserved, not default.**
Escalates only when Tier-1 confidence on every candidate node is below a
threshold (e.g. 0.6), or Tier-1's top node conflicts with a
high-confidence Tier-0 genre prior (the exact signature of the fusion/
fission confusion in issue #12), or the show is a `chart_rank` top-N
show in its genre (higher stakes — more listeners are exposed to a wrong
tag). `tools/classify/prepare-batch.mjs --mode escalate` selects exactly
these shows (source `classify-agent-tier1`, `needs_review: true`) into a
dedicated Tier-2 batch, carrying the Tier-1 result as context plus,
only if `<podcast:transcript>` is already present in the RSS feed for
2–3 recent episodes (ADR-0004's tier-1 transcript source — already free,
zero additional fetch), a truncated transcript excerpt. ~~Tier 2 was
specified to run on a stronger API model (Sonnet 5).~~ Under the Claude
Code execution engine, "stronger" means the orchestrator can route
Tier-2 (`--mode escalate`) batches to a routine configured for deeper
reasoning (a Cloud-agent config knob, not something this ADR's tooling
controls) — the runner prompt instructs extra diligence regardless of
which routine runs it. **Full transcripts for every show are explicitly
rejected as the default** — see Rejected Alternatives below.

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

## Usage/pacing model (supersedes the original dollar cost model)
No per-token dollar cost under the Claude Code cron execution engine —
the constraint is the Claude Max plan's **weekly usage limit**, shared
with every other Claude Code use on the account (including the nightly
refresh routine). The relevant variable is wall-clock/reasoning budget
per routine invocation, not dollars, and the founders are pacing the
rollout across roughly **two weeks** rather than running it in one shot.

**Sizing math** (the orchestrator's call to tune, not fixed by this ADR):
```
shows_covered = batch_size × runs_per_day × days
19,787 (US breadth catalog) ≈ batch_size × runs_per_day × 14
```
e.g. a batch size of 40 shows/run at 2–3 runs/day covers the full US
catalog in roughly 12–18 days — in the same range as the orchestrator's
~2-week pacing target, with headroom for Tier-2 escalation runs (a
smaller batch size, since each show gets deeper scrutiny and, on shows
with a transcript tag, extra fetch+read time) layered on top of the
Tier-1 runs. `--batch-size` on `tools/classify/prepare-batch.mjs` is the
single knob — **scaling the rollout up or down is a config flip, not a
rewrite**, per the explicit design goal.

**Original API-era cost model, retained for context, not operative:**
the design (see `docs/curation/breadth-classification-methodology-plan.md`
for the full breakdown) estimated $70–$185 for a Tier-1+Tier-2 pass
across the full US catalog via the Anthropic API — a real number that
would have needed founder budget approval before any spend. That
approval question is now moot (no per-call billing), but the estimate
is left in the plan doc as the honest record of what was proposed before
the execution engine changed, not scrubbed to look like this was always
usage-based.

**International (121,786 shows)**: still explicitly out of scope, per
the founders' 2026-07-24 decision — "US breadth only" for now,
independent of the execution-engine question.

## Budget-guard routing (superseded — not used by this pipeline)
~~The original design routed every classification call through
`backend/src/cost/budgetGuard.ts` (`BudgetGuard`/`costEvents`,
tier-prefix cutoff logic, a founder-approved `--budget-usd` ceiling).~~
None of that applies — there is no API call for it to gate. This section
is kept, struck through, as the record of the pre-pivot design; the
functioning equivalent under the new execution engine is
`data/classify-progress.json` (which shows are done/in-flight/failed) and
the orchestrator's routine-scheduling config (how often, how large a
batch) — a scheduling/pacing concern, not a dollar-metering one.

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
- **Tooling built, matching the nightly-refresh two-tier shape**
  (`docs/nightly-refresh-cloud.md`'s pattern, adapted from a two-stage
  Action+Cloud-agent split to a single-stage cron routine since there's
  no keyless/judgment split needed here): `tools/classify/prepare-batch.mjs`
  (Tier 0 genre-map prior + Tier 0.5 RSS fetch, deterministic, keyless),
  `docs/agents/runner-prompts/classify-batch.md` (the classification
  agent's contract, Tier 1 and Tier 2), `tools/classify/merge-results.mjs`
  (schema + copy-rule validation, idempotent merge into
  `data/breadth-classification.json`). Verified end-to-end against the
  real breadth catalog (RSS fetch working, Science Friday's fetched
  signal confirmed to actually fix the documented misclassification, copy-
  rule gate confirmed catching banned phrasing, invalid-taxonomy-node
  rejection confirmed, idempotent re-merge confirmed) — no LLM/agent step
  was invoked in this verification, only the deterministic surrounding
  scripts.
- **Backward-compatible schema**: `data/breadth-classification.json`
  entries keep the existing flat `topics: string[]` + `confidence` bucket
  fields (so `tools/topic-coverage-report.mjs` and any other consumer
  reading the old shape keep working unchanged) and add
  `topic_confidences: [{node, confidence}]`, `needs_review`, `rationale`,
  `display_title`, `blurb`, `display_copy_ok`, `source`, `tier`,
  `batch_id`, `classified_at` alongside. Additive, not a breaking
  migration.
- **Curated-tier precedence is structural, not enforced by a runtime
  check**: this pipeline's tooling has no write path to
  `data/catalog.json`/`data/discover.json` at all — the founders'
  "curated tier always wins" rule (2026-07-24) holds by construction, not
  by a rule someone has to remember to apply at merge time.
- **Taxonomy governance gap, not resolved here**: shows that fit no
  existing node well (the multi-label output legitimately returns
  `topics: [], needs_review: true`) surface a taxonomy-coverage gap the
  same way the 2026-07-09 "new_nodes" expansion in `data/taxonomy.json`
  did (60+ nodes added at `confidence: 0.3`, i.e., provisional). Per the
  founders' explicit decision: `needs_review` output is **never
  auto-applied** — it's held for a human pass. This ADR still does not
  define *what that human pass does* (add a taxonomy node vs. force into
  the nearest existing node vs. leave untagged) — flagged as an open
  question, not a silent default either way. `data/classify-progress.json`
  plus a query over `breadth-classification.json`'s `needs_review: true`
  entries is enough to quantify the pile's size once real batches run;
  the review *process* itself is still undesigned.
- **The existing `AnthropicEnricher`/`Enricher` interface is not used at
  all** by this pipeline (superseded by the execution-engine pivot — see
  above) — no new `Enricher` implementation was needed, since there is no
  model API call to wrap.
- Re-running this pipeline is idempotent by design:
  `merge-results.mjs` skips a batch already merged under its `batch_id`,
  and `prepare-batch.mjs` never re-selects a show whose current entry's
  `source` already starts with `classify-agent-` — so a taxonomy update
  or a re-harvest of `catalog-breadth.json` doesn't require any manual
  bookkeeping to avoid duplicate work, it just naturally re-queues
  whatever the founders explicitly reset.
