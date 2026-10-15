# Persona-rating pipeline (`tools/recommender/`)

The offline half of recommender v1 ([`docs/roadmap/recommender-v1.md`](../../docs/roadmap/recommender-v1.md), issue #1380; decisions in `docs/DECISIONS.md`, 2026-10-14). Archetype rating personas rate shows from evidence packs; the ratings become a **cold-start prior and a labelling engine** for the client's persona-mixture model, not the recommender itself (D2).

**Machinery is code (committed here); per-batch rating judgement is data (never code).** That is the rule `tools/classify/README.md` states for the breadth classifier, and this pipeline copies its shape: a deterministic script prepares a batch file, a Claude Code agent reads it and writes a results file, a deterministic script validates and merges. Nothing in this folder calls a model, and nothing calls Anthropic: the rater is an agent on the subscription following a runner prompt (D1). The dormant Qwen and Jev paths use the existing LiteLLM and Jev clients and are tested only with fakes.

**Everything here ships dark.** No live app path reads any file this pipeline writes until the one parked `app.js` card (RV-27), which sits behind `RECOMMENDER_PRIOR = false`.

## Stages

```
sample -> prepare -> [ agent | qwen | jev ] -> merge -> agreement -> student -> predict -> build-ratings-client
```

| Stage | Script | Card | Role |
|---|---|---|---|
| shapes | `schema.mjs` | RV-02 | The only definition of the results file, `data/recommender/ratings.json` and `data/recommender/ratings-client.json`: `validateResultsFile`, `validateRatingsFile`, `validateClientFile`, and the two normalisers the merge applies (`nullAudioScoresUnlessTranscript`, `capConfidence`). |
| progress | `progress.mjs` | RV-02 | The only writer of `data/recommender/rating-progress.json`: `reserve`, `reclaimStale` (12 h), `release`, `markRated`, sorted-key `saveProgress`. Shared by every rater path. |
| personas | `profiles.mjs` | RV-01 | Loads and checks `data/recommender/persona-profiles.json`, the rating personas (new ids, not `data/personas.json`, D11). |
| evidence | `evidence.mjs` | RV-03 | The only place show text is assembled for any rater or the embedder: evidence tier, stripping of chart rank, counts, network and `in_curated` (D7), datamarking, injection pre-scan, transcript windows. |
| enrich | `enrich-rss.mjs` | RV-04 | Recent episode titles and descriptions from RSS, through `tools/segments/politeness.mjs`, cached in `data-local/recommender/rss/`. |
| R2 sample | `sample-r2.mjs` | RV-05 | Transcript windows sampled from R2; dormant until the R2 read key (#1163 item 17.3). |
| sample | `sample.mjs` | RV-07 | The stratified gold set: pilot, gold, retest and holdout flags, strata over evidence tier, root node, chart band and DAI (D12). |
| prepare | `prepare-rating-batch.mjs` | RV-08 | Joint and isolated batches, personas shuffled per show, shows shuffled per batch, reservations through `progress.mjs`, `--shard i/n`. |
| rate | agent, `qwen-rate.mjs`, `jev-rate.mjs` | RV-10, RV-20, RV-18 | The judgement step. The agent follows `docs/agents/runner-prompts/persona-rate-batch.md` and `docs/curation/rating-rubric-v1.md`; Qwen and Jev are dormant until their keys (#1163 items 17.1, 17.2). |
| merge | `merge-rating-results.mjs` | RV-09 | Validates a results file against its batch with `schema.mjs`, normalises, merges newest-wins with pass means into `ratings.json`, keeps one `top_reason` per show, writes full reasons to data-local, releases the reservation. `--check` validates the committed file. |
| agreement | `agreement.mjs` | RV-11 | Krippendorff's alpha, Spearman, within-node Kendall tau, test-retest, joint vs isolated, persona differentiation, per-batch drift. |
| embed | `embed.mjs` | RV-12 | Evidence-pack embeddings through the passage-index Embedder. |
| student | `student.mjs` | RV-14 | Ridge regression from features to the rating vector, with the gate. |
| predict | `predict.mjs` | RV-25 | The gated student over the ~26k catalogued shows: `data/recommender/ratings-predicted.json`. |
| client | `build-ratings-client.mjs` | RV-15, RV-30 | The 40 KB client projection `data/recommender/ratings-client.json`, with a `--check` drift test. |
| reports | `eval.mjs`, `foray-supply.mjs`, `anomaly.mjs` | RV-21, RV-22, RV-26 | Offline eval against the chart, the Foray supply per persona, and the anomaly and injection audit. |

Scripts land card by card; a row above whose file does not exist yet is planned, not missing. RV-13 adds the run loop as it was actually run, with the pilot's numbers.

## The three file shapes

Defined in `schema.mjs`, and only there. The rubric that tells a rater what each number means is `docs/curation/rating-rubric-v1.md`; its worked example is validated by `schema.test.mjs`.

- **Results file** (one per batch, written by the rater, `data-local/recommender/results/rating-results-<batch_id>.json`): `{ batch_id, rubric_version, model, mode: "joint" | "isolated:<persona_id>", pass, rated_at, profiles_sha256?, results: { <show_key>: { evidence_tier, summary, format, host_count, flags, not_rated_because, personas: { <persona_id>: { fit, return_prob, topic_fit, depth, accessibility, binge_vs_dip, host_style, production, ad_load, confidence, reason } } } } }`.
- **`data/recommender/ratings.json`** (merged gold ratings): `{ version, rubric_version, built_at, merged_batches, shows: { <show_key>: { evidence_tier, summary, format, flags, top_reason, top_persona, passes, personas: { <persona_id>: [10 slots] } } } }`, the slots in `RATING_SLOTS` order: `fit, return_prob, topic_fit, depth, accessibility, binge_vs_dip, host_style, production, ad_load, confidence`. Multi-pass shows store the one-decimal mean.
- **`data/recommender/ratings-client.json`** (client projection): `{ version, personas: [ids], shows: { <show_id>: { f: "<one fit digit per persona, 0 = unrated>", x: 0|1, t: "t"|"e"|"s" } } }`.

`show_key` is `show_id` for a curated row (`data/catalog.json`) and `String(apple_collection_id)` for a breadth row (`data/catalog-breadth.json`); `schema.mjs` `showKey(row)` computes it. The validators return problems as `{ code, at, message }` and never throw; an unknown field anywhere is a problem, so a hidden field (D7) cannot ride into `data/`.

The audio sub-scores (`host_style`, `production`, `ad_load`) and `host_count` are null unless `evidence_tier` is `transcript`; `confidence` is capped at 0.5 for `show-metadata` and 0.7 for `episode-metadata` (D3). A show at tier `none` is never rated.

## Progress

`data/recommender/rating-progress.json` is `{ in_flight: { <key>: { batch_id, reserved_at } }, rated: { <key>: { last_batch_id, passes: [1, 2, 3] } } }`, committed empty. Prepare calls `reclaimStale` then `reserve` (all or nothing; a key already in flight is refused); merge calls `release` and `markRated`. A batch abandoned before merge frees its shows after 12 hours. `saveProgress` writes sorted keys with a trailing newline so the file diffs cleanly; a progress file that does not parse throws rather than resetting.

Both prepare and merge rewrite the file whole, so each holds `withProgressLock` (an exclusive `<progress file>.lock` directory) across its whole load, change and save (merge also across its ratings write); a concurrent prepare or merge waits up to five minutes, and a lock older than ten minutes is a crashed holder's and is taken over. Prepare can therefore overlap a merging pool without losing pass records (RV-13 lost four batches' that way).

## Local data (never committed)

```
data-local/recommender/
  rss/          RSS enrichment cache (RV-04)
  batches/      rating-batch-<batch_id>.json, the agent's input (RV-08)
  results/      rating-results-<batch_id>.json, the agent's output (RV-10)
  reasons/      <batch_id>.jsonl, every persona's full reason (RV-09)
  embeddings/   evidence-pack embeddings (RV-12)
```

Only `data/recommender/` is committed: personas, ratings, predicted ratings, progress and the client projection (D8).

## Tests

`node --test tools/recommender/schema.test.mjs` and `node --test tools/recommender/progress.test.mjs`, offline, fixtures only. Each test names the one-line mutation that turns it red. Every suite here has a floor in `test/suite-integrity.test.js`.
