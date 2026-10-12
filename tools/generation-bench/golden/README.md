# Golden set v1

The fixed benchmark every later generation change is judged on (GV-45, R2-02, GP-28; plan: `docs/roadmap/generation-v2.md`, issue #1286). Fifty prompts: 10 the founder listens to, 40 the bench scores. The file uses the `PromptSpec` shape `generate-forays` already reads, so running it needs no new driver.

| File | What it is |
|---|---|
| `golden-v1.json` | The 50 prompts. |
| `select.mjs` | Proposes strata from committed data. It is deterministic, calls no model and reads no transcript text. |
| `validate.mjs` | Checks the set, writes the lock and refuses an edited set. |
| `golden-v1.lock.json` | Written by the live step below. It does not exist until the founder-PC run has happened. |
| `reference-scorecard.jsonl` | GV-24's scores for the committed Forays. This card does not change it. |

## Running it

Run from `backend/`:

```
npm run generate-forays -- --prompts ../tools/generation-bench/golden/golden-v1.json --out <dir>
```

Do not pass `--dry-run`. A `--dry-run` batch writes no `report.json` (`generateForays.ts`, `writeReport` returns early), so it cannot be locked or compared. To run with no model calls, use stub mode: leave the provider keys unset and do not pass `--dry-run`. The run prints `MODE: dry-run (no ANTHROPIC_API_KEY) — stub builders`. If it prints `MODE: live`, stop.

Each entry's `id` (`g01`..`g50`) is carried into `report.json` as `promptId`. The bench joins rows on it, so it never needs the prompt text.

## The entry

```
{ id, prompt, duration, stratum, listened, nodes, reference?, bench: true }
```

- `prompt`, `duration`, `id`: read by `generate-forays`. No entry pins `topic`, because topic resolution is part of what the set measures (F-59, F-91). `topic` is still allowed and validated.
- `bench: true`: GV-62's `--keep-checkpoints` (a later card) accepts only a bench manifest.
- `stratum`: one of `multi-show`, `single-show`, `ambiguous` or `near-no-supply`. The split is 30 / 10 / 5 / 5 (decision 25). R2's 25/10/5/5 sums to 45, not 50.
- `nodes`: the taxonomy node the stratum was counted on. An ambiguous prompt lists two or more readings from different families. Nothing in generation reads this field. It records why the prompt sits in its stratum. This field is an addition to the card's schema.
- `listened`: exactly 10 are `true`.
- `reference` (listened prompts only) is one of:
  - `{kind: "forays-json", forayId}`: a Foray in `data/forays.json`.
  - `{kind: "founder-candidate", file}`: a candidate under `backend/data-local/foray-candidates/`. That is local data and is never committed.

## Strata

`select.mjs` counts the shows and usable digest rows in each taxonomy node's family. A family is the node, its ancestors and its descendants, the same lineage `taxonomyFamily.ts` gates tape on. The counts come from:

- `data/transcript-digests.json` and `data/breadth-transcript-digests.json`. A row counts only when it has cues.
- `data/catalog.json` `taxonomy_node_ids`.
- `data/breadth-classification.json`, for the five breadth shows that the curated catalogue does not carry. This follows `taxonomyNodesForShowId`'s order. Without it those 1,126 rows would count nowhere, while sourcing does use them.

| Stratum | Rule on the committed data |
|---|---|
| multi-show | 2 or more shows in the family |
| single-show | exactly 1 show, with at least 3 usable rows |
| near-no-supply | fewer than 3 usable rows. 3 is `MIN_TOPIC_SUPPLY` in `topicSupply.ts`. The proposals list nodes that have catalogue shows but no transcripts first: the tape exists, but nothing has transcribed it. |
| ambiguous | two readings that both have supply. Seeds are label words shared across roots (`science`: cooking science and earth science). |

`node tools/generation-bench/golden/select.mjs` prints the proposal and the sha256 of each input file. The prompt text in `golden-v1.json` was written by hand from those node labels and from the historical prompts. No model wrote any of it.

## The 10 listened prompts

Every prompt that already has a Claude-written candidate is included. They keep the tier their reference was made at (`medium`). The other listened prompts are `short`.

| id | reference | where the prompt comes from |
|---|---|---|
| g01 | `how-ai-actually-gets-built-3b83e1` | run 6 in `../baseline.jsonl`. Runs 5 and 6 and the 2026-09-09 run 2 all used this prompt. |
| g02 | `beyond-the-algorithm-engineering-production-ai-s-e6533b` | Reconstructed from the Foray's title, topic and summary. Its recorded prompt is g01's (`docs/curation/generation-run-2026-09-09.md`, run 2), and two entries cannot share a prompt. |
| g03 | `the-chain-reaction-how-engineering-disasters-rea-25f1b7` | run 7 |
| g04 | `what-engineers-actually-do-all-day-e08236` | runs 8 and 9 (one distinct prompt) |
| g05 | founder candidate, 2026-09-14 | The germ-theory prompt, quoted in issue #703. The file name is `candidateFilename` of that prompt. If the founder's copy has another name, update the reference before the lock. Once the set is locked, any change means v2. |
| g06–g10 | none | `short`, across all four strata |

The reference Forays come from the pre-Q-03 writer, which the founder called clunky. They are older writing to compare against, not targets. Once the first Qwen golden run exists, it becomes the pairwise baseline for stage swaps.

## Checking and locking

```
node tools/generation-bench/golden/validate.mjs                    # schema, ids, prompts, strata, 10 listened, references; the lock if present
node tools/generation-bench/golden/validate.mjs --strict-strata    # also fail when the committed data no longer puts a prompt in its stratum
node tools/generation-bench/golden/validate.mjs --lock <out>/report.json
```

- Strata drift is printed as a note. A locked set does not move with the archive, so drift alone does not fail the check.
- `--lock` refuses a report that is not from a real run, that ran a different prompt file (`report.prompts.sha256`, GV-39), that has no corpus fingerprint, or that never reached every golden id. It writes `golden-v1.lock.json` with `{manifestSha, corpusFingerprint, frozenAt}`. `corpusFingerprint` is the report's whole `corpus.fingerprint` object. A swap-ledger row cites its `sha256`.
- `manifestSha` is taken with CRLF read as LF, so a Windows checkout does not look like an edit.
- Once the lock exists, a manifest whose sha has changed is refused. Do not edit a locked set: copy it to `golden-v2.json` and lock that.

## Live step (founder PC)

1. Run the manifest in stub mode, as described above, with the transcripts on disk. This checks the strata against the 22 shows actually on that disk, which the committed digests do not all cover. For example, g05's medicine shows have no committed digest rows. Then run `validate.mjs --lock <out>/report.json` and commit the lock.
2. Once the provider layer and the LiteLLM key exist, run all 50 prompts once on the Spark (about 20–25 minutes) to seed `golden-baseline.jsonl` (GV-64).
