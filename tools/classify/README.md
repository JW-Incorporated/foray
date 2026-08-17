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
  over the 17,936 shows still needing a pass (shard0 1,514 against
  shard3 3,334 — the review's §4 quotes 1,504 / 2.21x over the 17,875
  *eligible* subset; name the set when quoting either) because
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
  "episodes_with_transcript": 3,
  "episodes_with_timed_transcript": 2,
  "transcript_tags": 4,
  "transcript_types": { "text/vtt": 2, "text/plain": 2 }
}
```

**It is a cost signal, not a requirement, and never a filter.** Read
`labels.mjs`'s header before writing anything that consumes it; the short
version:

- We make our own transcripts. The measured rate and its source are in
  `labels.mjs`; it is deliberately written down once rather than restated
  here, because a number in eight files is a number that will disagree with
  itself. A show with no `<podcast:transcript>` is *expensive*, not
  unusable. (Transcript *quality* against a publisher's is a separate,
  still-open question — T2, issue #117.)
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
  segment, so it raises `episodes_with_transcript` and not
  `episodes_with_timed_transcript`. The timed-format list is imported from
  `tools/segments/sweep-transcripts.mjs` rather than restated, so it cannot
  drift from `data/transcript-availability.json`.
- **Episodes and tags are different numbers, and the field names say which
  is which.** Feeds publish ~2.9 `<podcast:transcript>` tags per transcribed
  episode, so `episodes_with_transcript` (the coverage number) and
  `transcript_tags` (which sums to `transcript_types`) differ by about that
  factor. Both names mean exactly what they mean in
  `data/transcript-availability.json`, deliberately, because the two files
  describe the same quantities over overlapping show sets.
- **A re-merge keeps the richer observation.** A Tier-2 escalation whose feed
  fetch fails must not overwrite a real Tier-1 reading of 8 episodes with
  "we saw 0" — `mergeTranscriptLabels` decides what the label *says*, never
  whether the show is merged.
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
node --test "tools/classify/*.test.mjs"
```

(The quoted glob, not `node --test tools/classify/` — the directory form errors
on this repo's Node. CI is unaffected either way: `tools/ci/run-suites.mjs`
enumerates the files itself.)

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

## `reconcile-shards.mjs` — landing the six shard branches

**Read this before you conclude the classification fleet is dead.** The six
`foray-classify-shard0-5` cloud routines do **not** follow §8 of
`docs/agents/runner-prompts/classify-batch.md`: they commit to
`origin/reclassify-<N>` and **open no pull request**, so nothing they produce
ever reaches `main` on its own. On 2026-08-17 that had hidden **17,427 real
tier-1 classifications** across six branches while `main` sat at 1,851 and
looked like a fleet that had stopped on 2026-08-03.

```
node tools/classify/reconcile-shards.mjs --dry-run   # the numbers, writes nothing
node tools/classify/reconcile-shards.mjs             # merge them into data/
```

It reads `origin/reclassify-0..5:data/breadth-classification.json` with
`git show` (so it needs those refs fetched, and nothing else — no network, no
keys, no LLM) and merges the agent rows into whatever the working tree's
`data/breadth-classification.json` currently says.

**Merge data; never check out a branch's file.** Shards 1–5 descend from
`origin/reclassify`, which last moved 2026-07-25, so their `genre-map` and
`llm-title-genre` rows are three weeks stale. Checking one out costs, measured
per branch: **`reclassify-1`/`3`/`4`/`5` each lose 1,707 of `main`'s 1,851 agent
rows**; **`reclassify-2` loses 1,815 of them and drops 16,799 entries from the
catalogue outright** (its file holds only agent rows — see below);
**`reclassify-0` loses none**, being `main`'s own lineage. Only shard 0 is even
survivable, and it would still discard the other five shards' 15,951 rows.

Precedence, in full:

| base row | shard row | result |
|---|---|---|
| `genre-map` / `llm-title-genre` / sourceless | agent | shard row wins |
| agent, **older** `classified_at` | agent, newer | shard row wins (`refreshed`) |
| agent, same or newer `classified_at` | agent | base row wins (`incumbent_kept`) |
| anything | absent | base row untouched |

**Disjointness is verified, not trusted.** `--shard i/N` used to *fail open*: an
empty `--shard ""` (an unset variable in a routine), an out-of-range `6/6` or a
non-numeric value were silently ignored and the run then selected from the whole
catalogue. PR #203 fixed that — `parseShard` throws now — but **every row already
on the six branches predates the fix**, so it cannot be assumed of this data. A
shard that ran unsharded would have classified other shards' shows, so this
script hard-fails on any id whose lane is not that shard's, and on any id two
shards both claim.

**Each row is checked under the one key it was selected with.** #203 also replaced the shard key
(`Number(id) % N` → `fnv1a32(String(id)) % N`), so a branch holds rows
partitioned by whichever key was live at the time — and from the next run onward,
every branch holds both. `keyForRow()` picks the era from the row's own
`classified_at` against `SHARD_KEY_CUTOVER` (the #203 merge instant,
2026-08-17T03:29:56Z); a row with no timestamp reads `legacy`, safe because
anything predating the field also predates the key change.

Two weaker designs were tried first and are worth not repeating: accepting a row
if *either* key places it in-lane is **1.83x weaker forever** (an unsharded run's
rows pass 11/36 of the time instead of 6/36), and requiring each *branch* pure
under one key is full-strength but refuses the mixed-era branches the next run
creates.

The only exemption is a row **byte-identical to the incumbent** — an inherited
row the shard never ran. Identity, not "older timestamp": an off-lane row that
differs from the incumbent is evidence of off-lane work whichever way its clock
points.

Measured 2026-08-17: **0 off-lane rows among each shard's own work, on all six
branches.** Be precise about that claim, because the weaker version is false and
a two-line script contradicts it: the branch **files** do contain off-lane agent
rows — 115–127 each on shards 0, 1, 3, 4 and 5 — and every one is byte-identical
to a row inherited from `origin/reclassify` or `main`. Counting all agent rows
per file instead of each shard's own work makes it look as though five of six ran
unsharded. They did not.

### `superseded_topics` — why a row can carry fewer topics than before

When an adopted row does not carry a topic the row it replaced had, the
displaced ids are recorded on it as `superseded_topics`, with
`superseded_source` naming where they came from. So the live `topics` reflect
the better judgement and **nothing is deleted**.

This is deliberately *not* a union of the two lists. PR #198 measured that
bolting the genre map's coarse secondary branches onto a judged row makes
classification worse, not better — root-only pairs went 9,741 → **10,502**
under the superset rule. The demoted ids stay auditable and out of `topics`.

`auditNoRegression()` is the gate that makes this safe, and it runs on every
invocation before anything is written: no entry may disappear, end with empty
`topics` or no `source`, lose an agent classification, or lose a topic id from
both `topics` and `superseded_topics`. Any violation aborts the write.

**The demotion is a one-generation record, not an archive.** `merge-results.mjs`
rebuilds an entry from the agent's results file rather than spreading the
existing row, so the next classification of that show deletes its
`superseded_topics` and `superseded_source`. That is defensible — a fresh
judgement supersedes the thing the previous judgement had already demoted — but
it means the demoted ids are recoverable from git history, not from the file
forever. Do not cite `superseded_topics` as durable provenance.
