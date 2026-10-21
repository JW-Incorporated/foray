# Model swaps: how a stage swap or a quality lever is decided

Status: protocol adopted with GV-35 (docs/roadmap/generation-v2.md, card GV-35, from W7-01; issue #1286). No experiment has run yet. The ledger below is empty and so is the adopted stack.

This page says how Foray decides to move a generation stage to another model or machine, or to turn a quality lever on, and where each decision is recorded. It is written before any model runs so the rule cannot be bent to fit a result.

| Piece | Where |
|---|---|
| The rule, as code | `tools/generation-bench/swap-rule.mjs` (`decideSwap(evidence, { bands })`) |
| The ledger (append-only) | `tools/generation-bench/swaps/ledger.jsonl`, written by `tools/generation-bench/swap-ledger.mjs` |
| The adopted stack (arm A of every experiment) | `tools/generation-bench/swaps/adopted-stack.json` |
| The runner that builds evidence and appends rows | `tools/generation-bench/swap-experiment.mjs` (GV-75: plan, run, collect, decide) |
| The act-level training-example ledger and readiness count | `tools/generation-bench/training-corpus.mjs` (GV-114) |

## The zero-Anthropic rule changes the protocol

The founder directed that the generation pipeline make no Anthropic API call (docs/roadmap/generation-v2.md, "Constraints"; #1286). Every arm of every experiment therefore runs all-local: Qwen3.8-27B on the DGX Spark, Qwen3.6-35B-A3B on the second box, and Jev for typed decisions.

The reviewers' order (R2-21) started from the Claude stack and moved one stage at a time to Qwen, with the rest of the stages still on Claude. Each step's quality cost was then measured against a Claude baseline. That order cannot run now: no Claude arm may be generated, so there is no Claude stack to move stages away from. This protocol makes three changes:

- The floor comes first. E0 measures the all-Qwen pipeline against the committed Claude-written Forays, which already exist. It generates nothing on Claude.
- Later experiments start from the adopted all-local stack. Each one changes a single stage's lane, model or lever.
- Claude-quality reference only enters through the committed Forays. It is never a live arm.

## The unit of evidence: an arm pair

- Arm A is the adopted stack (`adopted-stack.json`). Arm B is the same stack with exactly ONE stage assignment or ONE lever changed.
- Both arms run the same golden prompts and share the same commit, corpus fingerprint and duration tier. The corpus fingerprint comes from the eval workstream (R2-02). Until it lands, evidence is `unfrozen`.
- A seeded arm B (GV-62) resumes the stages upstream of the change from arm A's checkpoints, so those stages are identical by construction.

## Required evidence

- The 10 listened golden prompts. The founder listens to act 1 of both arms blind and scores each one on the listening card (`tools/listening/card.mjs`, listen-card/1). A card has four axes scored 1-5, a preference for A, B or a tie, and a wince list. R2-21 costs a stage swap at 2 x 10 runs. That the founder does the listening is an adopted default (OQ-09, docs/roadmap/generation-v2.md "Constraints") and is not asked again.
- The 40 scored golden prompts are optional. When present, they add scorecard evidence (`tools/generation-bench/score.mjs`, MQ-01..MQ-21) to the checks below.
- Preferences are unsealed before the rule sees them (`tools/listening/unseal.mjs`). The rule reads arm A and arm B, never the blind pack label.

## The decision rule

`decideSwap(evidence, { bands })` in `swap-rule.mjs` applies the rule below. Every constant named here is exported from that file.

ADOPT requires every one of these checks to pass, or to be `unmeasured`:

| Check | Passes when |
|---|---|
| `listened` | at least 10 prompts carry a preference (`MIN_LISTENED`) |
| `pairwise` | wins(B) + ties >= wins(A) over the listened prompts |
| `axis:<axis>` | B's mean on that card axis is no more than 0.5 below A's (`AXIS_DROP_MAX`); checked for each of onSubject, flowsAtSeams, oneNarrator and nothingFalseOrOdd |
| `MQ-01+MQ-04` | MQ-01 == 1 and MQ-04 == 0 hold together on at least as many prompts for B as for A |
| `MQ-21` | B's run successes >= A's minus 1 per 10 prompts |
| `MQ-02`, `MQ-05` | B's mean is not below A's by more than the band passed in (GEN-05, GV-64; PROPOSED until it lands) |
| `timing:<stage>` | for the changed stage and every later stage, B's p50 is not above A's by more than the slack |
| `corpus-frozen` | the evidence names a frozen corpus fingerprint, not `unfrozen` |

The verdict:

- REJECT: wins(A) > wins(B) + ties.
- HOLD: the pairwise result is even or better, but a check fails.
- ADOPT: no check fails.
- MEASURED: the kind used by E0. The gap is recorded and nothing is adopted.

The verdict names every failing check and every unmeasured check.

**Absent is not pass.** These rules apply when a metric is missing:

- Absent in both arms: the check is `unmeasured` and does not block.
- Present in A but absent in B: the check fails. A swap must not win by losing a measurement.
- Present in B but absent in A: the check is `unmeasured`, because there is nothing to compare against.
- MQ-02 or MQ-05 with no band supplied: the check is `unmeasured`, never `pass`.

**Timing.** Only the changed stage and later stages are compared. A seeded arm B marks upstream stages as resumed, and resumed stages are skipped. Slack works like this:

- The spine best-of-2 slack is 3,000 ms (`SLACK_MS`).
- Every other change gets 15% of A's p50 for that stage (`DEFAULT_SLACK_RELATIVE`), which is the GEN-05 time band. This figure is PROPOSED until the noise floor of two back-to-back runs of one build is measured.
- A caller can pass `slackMs` to override both.

**Unfrozen evidence cannot adopt.** Until the golden set and the corpus fingerprint land (R2-02), every stage or lever experiment ends HOLD (`corpus-frozen` fails) or REJECT, and E0 ends MEASURED. This is intended. The ledger also refuses an `adopt` row on an `unfrozen` corpus, even one written by hand.

## Experiment order

| Id | Change (arm B against the adopted stack) |
|---|---|
| E0 | Floor (GP-27). Every stage on Qwen3.8-27B on the Spark, every lever off, and a non-Anthropic verifier from the gates workstream. Compared with the 4 generated Claude-written Forays in data/forays.json, with prompts reconstructed by R2-02. Kind `measure`. No Claude arm is generated. |
| E1 | Deepen moved to the second box (P40, Qwen3.6-35B-A3B) |
| E2 | Continuity moved to the second box |
| E3 | Writer exemplars on or off (lever `exemplars`) |
| E4 | Spine best-of-2 on or off (lever `spineBestOf`) |
| E5 | Self-critique, run behind the playhead, on or off (lever `selfCritique`) |
| E6 | Verifier: Jev versus the Qwen judge |
| E7 | Writer for acts 2 and later on the second box. Runs only if OQ-01 settles on V100s and the one-voice ruling is revisited. |
| last | Fine-tune (GV-114, W7-10) |

E0 runs first because it answers GP-27 with a number, the gap between all-local and the committed Claude-written Forays. Each later experiment then starts from whatever stack the earlier ones adopted.

## Who decides

1. The tool computes the verdict from the founder's cards and the scorecard (`decideSwap`). Nobody types a decision.
2. The orchestrator commits the ledger row (`node tools/generation-bench/swap-ledger.mjs append <row.json>`) and re-renders the table below (`render --write`).
3. A production default changes only through a PR that cites the ledger row id. On ADOPT that PR edits `adopted-stack.json` and sets its `ledgerRow` to the row. `swap-ledger.mjs check` refuses a stack that names stages without citing a current `adopt` row.

## The ledger

`tools/generation-bench/swaps/ledger.jsonl` is append-only, one JSON row per decision:

```
{ id, experiment, kind: stage|lever|measure, stage?, lever?,
  armA: { stack, levers }, armB: { stack, levers },
  commit, goldenSetId, corpusFingerprint | "unfrozen", runDirs: { A, B },
  pairwise: { wins, ties, losses, listener, listenedOn, packId },
  axisMeans: { A, B }, scorecardDelta, timingDelta,
  checks: [{ name, result: pass|fail|unmeasured, note? }],
  decision: adopt|hold|reject|measured, supersedes?, notes }
```

- `pairwise.wins` counts B preferred and `losses` counts A preferred.
- Rows are never edited. A correction is a new row with its own id, carrying `supersedes: <old id>`. In the table, the old row shows as superseded.
- `validateLedgerRow` refuses a row that is missing its commit or pairwise counts, an `adopt` row on unfrozen evidence, an `adopt` row with a failing check, and a reused id.

The table between the markers is rebuilt from the ledger by `renderLedgerTable`. Do not edit it by hand: `swap-ledger.mjs check` and the suite fail when it drifts.

<!-- swaps:ledger:begin -->
| id | experiment | kind | change | B wins / ties / A wins | decision | failing checks | corpus | commit | status |
|---|---|---|---|---|---|---|---|---|---|
| (no rows yet) | | | | | | | | | |
<!-- swaps:ledger:end -->

## The adopted stack

`tools/generation-bench/swaps/adopted-stack.json` has these fields:

- `stages`: maps each stage to `{ impl, model, machine }`.
- `levers`: holds `exemplars`, `spineBestOf` and `selfCritique`.
- `ledgerRow`: the id of the row that adopted the stack.

Arm A of every experiment is built from this file (GV-75). It starts empty because no non-Anthropic stack has been measured. A stack entry that names an Anthropic model is refused.

## Fine-tune readiness (the last experiment)

Fine-tuning is the last item in the experiment order. The reviewers put the need at about 500 act-level examples (R2-17). `tools/generation-bench/training-corpus.mjs` (GV-114) keeps that number. It trains nothing and calls no model.

An act-level example is what the writer was sent for one act, what it returned, and a label. Only bench runs recorded with `generate-forays --record-exchanges` (GV-110) have the input. The acts of the committed Forays in `data/forays.json` keep only their scripts. They are counted as reference acts and are never examples.

- `build` reads every `*.exchanges.jsonl` under `data-local/swaps/`. It labels each act's final reply from two sources. The founder's review verdict (`data-local/review/verdicts.jsonl`, GV-41) comes first: pass is keep, fail is reject, fix is edited. Otherwise a swap pair's unsealed preference applies: the preferred arm's act 1 is keep and the other arm's is reject. A tie labels nothing. The rows go to `data-local/training/act-examples.jsonl`.
- `count` prints the line below and appends it, dated, to this section.
- `export-sft --out data-local/...` writes chat-format SFT lines. Each holds the prompt rebuilt by the Qwen writer's own prompt builder and the reply's seams as JSON.

An example counts toward 500 only when all of these hold:

- It is the final round of the act (the latest attempt's last round).
- The round is verified: no mechanical issue, and every seam and beat its verifier judged passed.
- It is labelled keep.
- Its recorded generator is not Anthropic or Claude.

The same request and reply count once (`exampleId` is their sha-256).

Claude-built training data is parked (OQ-06, docs/roadmap/generation-v2.md "Constraints"). Rows whose generator is Anthropic or a Claude model are marked `claudeDerived` and counted as held, never as usable. `export-sft` leaves them out unless `--allow-claude-derived` is passed. That flag stays unused until OQ-06 is ruled on.

At about 4 acts per Foray, 500 keep-labelled acts means about 150 or more reviewed Forays. The count shows how far off fine-tuning is.

The lines between the markers are appended by `node tools/generation-bench/training-corpus.mjs count`. Do not edit them by hand.

<!-- training:readiness:begin -->
- 2026-10-21: usable act-level examples: 0 of 500 (non-claude, labelled keep); claude-derived held: 0; historic reference acts without inputs: 16
<!-- training:readiness:end -->
