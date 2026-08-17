# Breadth-catalog classification pipeline (`tools/classify/`)

Companion to `tools/refresh/` (same shape: static, committed machinery +
ephemeral per-run data), built for the breadth-catalog reclassification
work in `docs/adr/0006-podcast-classification-methodology.md`. Two
scripts, keyless, no LLM. **Machinery is code (committed here); per-batch
classification judgment is data (never code)** — the same principle
`tools/refresh/README.md` states for the nightly pipeline.

## Why this exists

`data/breadth-classification.json` is not trusted: the prior pass
classified ~19,787 shows from Apple genre + title alone, with no show
description and no episode content (verified: `data/catalog-breadth.json`
show records have no `description` field at all). This pipeline replaces
that, batch by batch, using real per-show signal — see the ADR for the
full methodology and rejected alternatives (title-only, always-full-
transcript, genre-map-only).

**Execution engine**: Claude Max plan via Claude Code cron routines, not
the Anthropic API — no `ANTHROPIC_API_KEY`, no per-token dollar cost. The
"LLM" step is a Claude Code classification **agent**
(`docs/agents/runner-prompts/classify-batch.md`) reading a batch input
file and writing a batch results file; both surrounding scripts here are
plain, deterministic Node.

## Stages

```
prepare-batch.mjs ──▶ classify-batch-<id>.json ──▶ [classification agent] ──▶ classify-results-<id>.json ──▶ merge-results.mjs ──▶ data/breadth-classification.json
  (RSS Tier-0.5 fetch)      (batch input)          (docs/agents/runner-        (batch results)                (validate + merge)     data/classify-progress.json
                                                     prompts/classify-batch.md)
```

| Script | Keyless? | Role |
|--------|----------|------|
| `prepare-batch.mjs` | ✅ (RSS only) | Select the next N un-(re)classified breadth shows, fetch each one's feed for description + recent episode titles/descriptions (Tier 0.5) **and the transcript label**, write one batch input file. |
| `merge-results.mjs` | ✅ | Validate the classification agent's output (taxonomy node ids, confidence bounds, copy rules on `display_title`/`blurb`), merge into `data/breadth-classification.json`, advance progress state. |
| `labels.mjs` | ✅ (pure) | The transcript label and the shard key. Dependency-free and side-effect-free. |
| `select.mjs` | ✅ (pure) | Which shows the next fresh batch takes. Dependency-free. |

The **judgment step** (classifying each show, writing `display_title`/
`blurb`) is the only non-deterministic part, performed by a Claude Code
agent per `docs/agents/runner-prompts/classify-batch.md`. Its entire
output is a results JSON file — data, never code, exactly like
`tools/refresh/`'s `edits.json` pattern.

## Selection modes

- **`--mode fresh`** (default): shows not yet touched by this pipeline —
  still on an old, distrusted source (`"genre-map"` or
  `"llm-title-genre"`) or entirely unclassified. Prioritizes the
  known-worst source (`"llm-title-genre"`) first, so the most-distrusted
  tags get replaced soonest. This is Tier 1 — the default, cheap
  (in usage-plan terms: one classification pass, no transcript fetch).
- **`--mode escalate`**: shows already classified by this pipeline's
  Tier 1 (`source: "classify-agent-tier1"`) but flagged
  `needs_review: true`. Adds the show's Tier-1 result as context and, if
  a `<podcast:transcript>` tag was present in the feed, fetches a short
  excerpt from 2–3 recent episodes (the only place this pipeline fetches
  transcript text — ADR-0004's already-free tier-1 transcript source,
  used only for this narrow, already-ambiguous slice). This is Tier 2.

## Batch results contract

The classification agent reads a batch input file and writes, for every
show it classified:

```json
{
  "batch_id": "<must match the batch input's batch_id verbatim>",
  "results": {
    "<apple_collection_id>": {
      "topics": [{"node": "science", "confidence": 0.85}],
      "needs_review": false,
      "rationale": "<~15 words, grounded in the real description/episodes>",
      "display_title": "<tile header, <=8 words, copy-gated>",
      "blurb": "<1-2 sentence tile description, <=30 words, copy-gated>",
      "model": "<optional free-text provenance note>"
    }
  }
}
```

Rules (enforced by `merge-results.mjs`, restated in full for the agent in
`docs/agents/runner-prompts/classify-batch.md` so it doesn't need to read
this file mid-run):

- Every `node` must exist in `data/taxonomy.json`; every `confidence` is a
  number in `[0, 1]`.
- `display_title`/`blurb` obey the same copy rules as every other
  user-facing surface in `data/*.json` (`backend/src/copy/rules.js`'s
  `BANNED` list + `MAX_DISPLAY_TITLE_WORDS`/`MAX_BLURB_WORDS`). A
  violation doesn't reject the show's classification — the topics/
  confidence data is still merged — but the display fields are withheld
  and the show is force-flagged `needs_review: true`.
- A show present in the batch input but missing from the results file (or
  failing schema validation) is **skipped and reported**, never merged
  with guessed data — it stays eligible for a future batch.
- Re-running `merge-results.mjs` with the same batch+results files is
  idempotent (shows already merged under that exact `batch_id` are
  skipped on the second pass).

**Precedence, unconditional**: this pipeline only ever writes
`data/breadth-classification.json`. It never touches `data/catalog.json`
or `data/discover.json` — the curated tier's hand-authored tags always
win over breadth reclassification, by construction (this pipeline simply
never has write access to those files).

## Running locally

```sh
# 1. Prepare a batch (deterministic, keyless — safe to run repeatedly while testing)
node tools/classify/prepare-batch.mjs --batch-size 10 --mode fresh

# 2. A classification agent (or a human, for a smoke test) authors
#    data-local/classify-results-<batch_id>.json from the printed batch path

# 3. Merge
node tools/classify/merge-results.mjs \
  --batch data-local/classify-batch-<batch_id>.json \
  --results data-local/classify-results-<batch_id>.json
```

Local runs default to `data-local/classify-progress.json` (gitignored,
safe to delete and start over). **Real cron routine runs must override
this** — see Path overrides below — so progress survives between
ephemeral routine invocations.

## Path overrides

All paths are env-configurable, mirroring `tools/refresh/`'s cloud-path
convention:

| Env | Default | Set by |
|-----|---------|--------|
| `PROGRESS_PATH` | `data-local/classify-progress.json` | Real cron runs: `data/classify-progress.json` (tracked, committed each batch so state survives across runs) |
| `BATCH_INPUT_PATH` | `data-local/classify-batch-<batch_id>.json` | Rarely overridden — `prepare-batch.mjs` derives a fresh path per run |
| `BREADTH_CLASSIFICATION_PATH` | `data/breadth-classification.json` | Rarely overridden — tests only |
| `TAXONOMY_PATH` | `data/taxonomy.json` | Rarely overridden — tests only |
| `CATALOG_BREADTH_PATH`, `GENRE_MAP_PATH` | `data/catalog-breadth.json`, `data/genre-taxonomy-map.json` | Rarely overridden — tests only |

CLI flags (`--progress`, `--out`/`--batch-size`/`--mode` on
`prepare-batch.mjs`; `--batch`/`--results` on `merge-results.mjs`) take
precedence over env vars where both apply.

## Sharding — `--shard i/N`

Six routines run this pipeline in parallel, each taking a disjoint slice.
`--shard 0/6` … `--shard 5/6`, one per routine.

- **The key is `fnv1a32(String(apple_collection_id)) % N`**, in
  `labels.mjs`. It replaced `Number(id) % N`, which is 2.20x unbalanced
  over the shows that remain (shard0 1,514 against shard3 3,334) because
  Apple collection ids are not uniform mod 6 once the already-classified
  ones, taken in ascending-id order, are removed. Finish time is the
  largest shard, so the modulo key idled a sixth of the fleet from around
  day 12. `shard.test.mjs` measures both against the real catalogue.
- **The key is stable.** A show's shard depends on its id and nothing else
  — never on the list, its length, or a position in it. An index-derived
  key would move shows between shards as siblings got classified, which
  both repeats work and creates permanent gaps.
- **Sharding partitions; it never filters.** The union of all six shards
  is the whole eligible set and the six are disjoint, asserted against the
  real catalogue.
- **A malformed `--shard` exits with an error.** It used to fail *open*:
  `6/6`, `abc`, `0/0` or a missing value all silently ran the full
  unsharded catalogue, recreating the six-way duplicate work the flag
  exists to prevent, from one typo in one routine's config. Shards are
  0-indexed; `6/6` is invalid. Omitting the flag entirely is still legal
  and still means "the whole catalogue".
- **`--mode escalate` has no shard support** and no ordering; run
  escalation as a single routine.

## The transcript label

Every batch entry, and every record `merge-results.mjs` writes, carries a
`transcript_labels` object:

```json
"transcript_labels": {
  "label_schema_version": 1,
  "episodes_sampled": 8,
  "transcript_present": true,
  "transcript_tags": 3,
  "episodes_with_timed_transcript": 2,
  "transcript_types": { "text/vtt": 2, "text/plain": 1 }
}
```

**It is a cost signal, not a requirement, and never a filter.** Read
`labels.mjs`'s header before writing anything that consumes it; the short
version:

- We make our own transcripts, at ~1.1x realtime — roughly **46 minutes of
  CPU per hour of audio** — and on domain vocabulary ours have beaten the
  publishers' (a Spotify SRT rendered "geology bites" as `jala g b`). So a
  show with no `<podcast:transcript>` is *expensive*, not unusable.
- The founder's ruling (2026-08-16) is that no show is excluded at this
  stage: *"I don't want to accidentally toss out shows that are still
  useful, for example for playlists (not forays)."* No consumer may read
  this label as an eligibility test.
  `no-exclusion.test.mjs` enforces that three ways — behaviourally over
  the selector, behaviourally over the merge, and by scanning this
  directory's own source for `if (…transcript_present…)`.
- **The counts are a FLOOR.** They are sampled over the ≤ 8 items the
  Tier-0.5 fetch already read, not the show's whole back catalogue, which
  is why `episodes_sampled` travels with them. `episodes_sampled: 0` means
  "the feed could not be read", not "no transcripts".
- **Timed vs prose matters.** `text/plain` is a tag but cannot anchor a
  segment, so it raises `transcript_tags` and not
  `episodes_with_timed_transcript`. The timed-format list is imported from
  `tools/segments/sweep-transcripts.mjs` rather than restated, so it cannot
  drift from `data/transcript-availability.json`.
- **The agent does not write it.** It comes off the batch input, where
  `prepare-batch.mjs` put it deterministically. The agent's results
  contract is unchanged.

**Deliberately not recorded here: any per-show ad flag, ratio or boolean.**
ADR-0008 removed ad load as a rejection reason, and a per-show ad number
is invalid by that ADR's own rule (N ≥ 2 probes of the *same* episode, a
maximum in seconds, never a median across different episodes). The
ranged-GET probe stays the separate narrow sweep it already is in
`tools/transcribe/ad-inflation.mjs`.

## Tests

```sh
node --test tools/classify/
```

- `shard.test.mjs` — balance, stability and the partition property, measured
  against the **real** `data/catalog-breadth.json`. Ratios and floors, never
  pinned counts, because the eligible set shrinks with every merged batch.
- `transcript-label.test.mjs` — extraction from the feed shapes real
  publishers emit, plus a genuine prepare → merge round trip (the batch entry
  is built by `prepare-batch.mjs`'s own code, and the merge is
  `merge-results.mjs` in a child process).
- `no-exclusion.test.mjs` — the founder's constraint, made mechanical.

These suites import `prepare-batch.mjs` and `merge-results.mjs`, so both must
stay importable **without `backend/node_modules`** — CI's `data-and-site` job
never installs them. That is why `fast-xml-parser` is resolved lazily on first
parse, and why the label is read with a regex parser rather than that one.

## Cloud topology (paced rollout, not built here)

`prepare-batch.mjs` and `merge-results.mjs` plus the runner prompt are the
complete tooling contract; **the actual scheduled routine (cadence, batch
size, how many runs per day, `docs/agents/runners.md` registration) is a
separate, deliberately out-of-scope decision** — the founders are pacing
the rollout across the Claude Max plan's weekly usage limits (see the
usage/pacing model in `docs/adr/0006-podcast-classification-methodology.md`),
and will run the first test batches themselves before committing to a
cadence.
