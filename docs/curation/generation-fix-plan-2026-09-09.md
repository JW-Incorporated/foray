# Foray generation: fix plan after run 1 (2026-09-09)

Companion to `generation-run-2026-09-09.md` (the findings F-01…F-46 and the interventions ledger). This
document is the spec the implementing agents build against. Every workstream cites the findings it closes,
lists the files it touches, and states what "done" means. Nothing here changes the stage order of the
pipeline (understand → research-shape → spine → deepen → source → narrate → stitch → finalize); it changes
what each stage is given and how its output is checked.

## 0. The one-sentence diagnosis

The writer is asked to produce verbatim quotes, publications and contested flags for every claim while
being given **no text to quote from**, and the verifier checks the writer's declarations only against
themselves. Under that pair of rules the cheapest way to pass is to declare less, shorter, or nothing —
which is what the run shows (F-14, F-22, F-27, F-28, F-30, F-32, F-36, F-42, F-45, F-46). Every retry is a
symptom of that, not of model quality. The fix is to make a quote a **lookup** rather than a claim.

Targets, per Foray, measured in `report.json`:

| Metric | Run 1 (attempt 4, acts 1–2) | Target |
|---|---|---|
| First-attempt page pass rate | 5 / 20 beats | ≥ 80 % |
| Narration calls per beat | 4.2 | ≤ 1.5 |
| Grounded-quote rate (quote is a substring of held text) | unmeasured; known fabrications ≥ 4 | 100 % by construction |
| Tape anchors on-topic | 4 / 20 | ≥ 90 % |
| Time until Act 1 is playable (TTL-A1) | never before the whole Foray finalises | ≤ 30 s p50 (see WS-D) |
| Pipeline tokens per Foray | ≈ 95 k for 2 acts | ≤ 50 k for 3 acts |

## WS-A — Evidence-first narration (closes F-14, F-22, F-27, F-28, F-30, F-32, F-35, F-36, F-41, F-42, F-45, F-46)

**Design.**

1. **Evidence pack per beat**, built before any writer call, by a new module
   `backend/src/generation/gatherEvidence.ts`:
   - For a tape beat: the transcript cue window of the anchored segment (± 90 s) via
     `TranscriptCueProvider` (already wired: `FileTranscriptCueProvider`), plus the episode's show and
     title from the catalogue — so the writer knows *who* is on tape and can say so (F-30, F-34).
   - For every beat: print evidence retrieved for the beat's claim. Use the existing
     `AnthropicExternalResearcher` path (web search + fetch; today it only fires for catalogue-gap seeds,
     F-12) generalised to "retrieve N passages for this claim". Each passage carries `{docId, title,
     url, retrievedAt, text}`. Cap: 3 passages, ≤ 1,500 chars each, per beat. Cache by claim hash under
     `data-local/evidence/` so re-runs are free.
   - Beats the deepen stage tags `kind: "argument"` (see WS-C) get print evidence only, never tape.
2. **Two-step writing, batched per slot.** A *claim-selection* call reads the evidence pack and returns
   `[{claimText, quote, docId}]` where each `quote` MUST be an exact (whitespace-normalised) substring
   of that doc's text — checked mechanically in code, not by a model. Then the *prose* call writes the
   page from those claims only. Both calls take the whole slot's beats at once (one call per slot, not
   per page) to hold the call count down.
3. **Mechanical validation** in `validateNarratedBeat` / `writeNarration`, before any verifier call:
   - quote is a substring of a held doc (normalised); reject otherwise;
   - quote ≥ 8 words unless it is a complete sentence (F-42);
   - quote does not overlap the beat purpose or any prompt text (F-46);
   - publication is the held doc's title/url, never free text (F-30, F-32);
   - negative claims about the record ("the record doesn't say/settle/show", "no one knows") need a
     source whose quote says so (F-45);
   - `sources: []` allowed only when the script has no declarative sentence (F-37/F-44 settled in code so
     the verifier never sees the case).
4. **Verifier** gets the beat purpose and the evidence pack and answers three questions: every claim
   supported by its quote; the page accomplishes the purpose (F-41); rule 3 (contested) judged with the
   source list in hand (F-43). Verification is batched per slot.
5. **Retry note accumulates** all prior rejections (F-35); attempts stay at 3; connective-page drop stays.

**Files.** `gatherEvidence.ts` (new), `AnthropicNarrationWriterBuilder.ts`, `AnthropicNarrationVerifierBuilder.ts`,
`NarrationWriterBuilder.ts`/`NarrationVerifierBuilder.ts` (request shapes gain `evidence`),
`writeNarration.ts`, `types/narration.ts`, `StubNarrationWriterBuilder.ts` (stub emits quotes from a stub
doc so dry-run stays structurally real), `AnthropicExternalResearcher.ts` (generalised retrieval).

**Done when.** Unit tests cover every mechanical rule with the real failing examples from the run (the
griddle slug, the purpose-as-quote, the 2-word spans, "the record doesn't say"); the stub path passes;
`npm run generate-forays -- --dry-run` still produces a candidate; and a live page cannot carry a quote
that is not in a held document.

## WS-B — Veracity metrics and the publish gate (closes the "AI slop" ask; F-27/F-32/F-41 measurement)

Add to `report.json` and to each candidate's `meta.veracity`:

- `groundedQuoteRate` — quotes that are substrings of held docs / all quotes (must be 1.0 after WS-A; the
  metric exists so a regression is visible).
- `attributionStability` — for pages that were retried, share of quotes whose publication did not change
  across attempts.
- `purposeFidelity` — verifier's yes/no per page, averaged.
- `tapeRelevance` — share of tape anchors whose episode shares a taxonomy family with the Foray's resolved
  topic (WS-C makes this computable); plus the list of anchors for human spot-check.
- `firstAttemptPassRate`, `callsPerBeat`, `pagesDropped`, `pipelineTokens` (from `usage` on each reply),
  per-stage wall times (`stageTiming` already exists; surface it).

Gate in `publishForay.ts`: refuse to open the PR when `groundedQuoteRate < 1` or `purposeFidelity < 0.8`
or `tapeRelevance < 0.9`, printing which pages failed. `--force` overrides with a note in the PR body.

**Files.** `runPipeline.ts`, `generateForays.ts`, `publishForay.ts`, `types/generation.ts`, tests.

## WS-C — Sourcing that knows what it is matching (closes F-23, F-24, F-29, F-33, F-38)

1. Deepen stage tags each beat `kind: "account" | "argument"` (schema + prompt line); sourcing skips
   tape lookup for arguments.
2. Tier 1 and tier 2 score the claim against **text**, not metadata: for tier 1 the segment's transcript
   window (cue provider) when available, else why/anchors; for tier 2 the episode's cue text found by the
   existing `resolveAnchorFromCues`, requiring ≥ 3 content-word overlap *inside the anchored window* — a
   4-word run anywhere in an hour of tape is not a match.
3. Topic gate: candidate episode/segment must share the taxonomy family (`engineering/*` etc.) with the
   Foray's resolved topic. Resolve the topic **before** sourcing (today it resolves after narration,
   `runPipeline.ts:306`).
4. Emit `tapeRelevance` inputs for WS-B.

**Files.** `deepenActs.ts` + `AnthropicDeepenActBuilder.ts` (+ stub), `types/spine.ts`, `sourceBeats.ts`,
`segmentPoolLookup.ts`, `transcriptArchiveLookup.ts`, `runPipeline.ts`, tests (reuse the run-1 regression
cases already in `test/sourceBeats.test.ts`).

## WS-D — Time to first listen (closes the 30-second target; F-15)

D1 (pipeline): narration runs **per act, all slots in parallel**, each slot's write and verify batched
(WS-A). Deepen already runs acts in parallel. Stage timings to `report.json`. Optional Haiku for
Frame/Hinge/Marker behind `NARRATION_CONNECTIVE_MODEL` (default unchanged; WS-B metrics decide later).

D2 (streaming publish): the pipeline emits a **partial candidate** after Act 1 finalises its own items
(`acts[0].status = "ready"`, later acts `"pending"`); `generateForays` writes it and the app's generation
endpoint serves it; the player appends items as later acts arrive. The founder-reviewed PR remains the
gate for *catalogue* listing — the streaming path is for the requesting listener only, marked
`visibility: "private"`. Target path: prompt → Act 1 playable ≈ understand + research-shape + spine +
deepen(act 1) + source(act 1) + narrate(act 1, parallel) ≈ 5 model calls in series ≈ 30–45 s at API
latencies. Measure it and print `ttlA1Ms` in the report.

**Files.** `writeNarration.ts`, `runPipeline.ts`, `generateForays.ts`, `finalizeForay.ts`, backend generation
endpoint + `app.js` player append (Hermes' UI area — coordinate via PR, do not restyle), tests.

## WS-E — Hygiene found along the way (F-09, F-21, F-26, F-39, F-40)

- Fix the pre-existing failing test (`writeNarration.test.ts` importing `check-forays.mjs` breaks on a
  path with a space) and the `tsc` errors in `NarrationVerifierBuilder` exports.
- Decode HTML entities in writer output (`&amp;`).
- A test that fails if `function parseWithRetry` appears outside `parseWithRetry.ts`.
- Keep `parseOrRepairJson`; add a single re-ask on parse failure inside the shared parser path (the
  builders pass a `reask` callback).

## WS-F — Robustness: the run survives its own failures (closes F-03, F-04, F-11, F-13, F-17, F-18)

None of these five is about what the pipeline writes. They are about what it costs when something goes
wrong, and run 1's answer was "everything": attempt 4 ran 2 h 35 m, made 103 model calls, finished 22 of
31 beats, and discarded all of it when beat 23 failed a third time.

1. **Per-stage checkpoint and resume inside one Foray (F-17, F-18).** `runForayPipeline` takes an optional
   `checkpoint` store (`load(key)` / `save(key, stage, data)`) and an `options.checkpointKey`. Every stage
   persists its output the moment it exists — `understand`, `research-shape`, `spine`, `deepen:<n>`,
   `source`, `narrate:<n>`, `stitch` — to `<out>/<candidate-basename>.checkpoint.json`; a re-run of the same
   request resumes at the first stage that never finished, and every stored value is re-validated against
   the stage's own schema on the way back in. Deepening and narration are keyed PER ACT, which is what makes
   a beat-23 failure cost act 3's narration rather than the Foray. The candidate-exists skip is unchanged
   and is still the outer resume; the checkpoint is deleted once the candidate is written, and also when the
   prompt ends in a terminal non-candidate outcome (rejected, needs-clarification) that a re-run would only
   reproduce. `--no-resume` on the driver forces every stage to be rebuilt.
2. **Budgets (F-04).** `DAILY_BUDGET_USD` 2.00 → 25.00 and `EPISODE_BUDGET_USD` 10.00, with the per-medium-
   Foray arithmetic (≈ $3.35 from the builders' own per-call estimates) written into `env.ts`. A
   `--budget-usd` flag on `generateForays` re-caps both for one run. A budget stop is re-thrown as
   `BudgetStopError` naming the stage, the spend so far, the cap, and the checkpoint to resume from — found
   through the `cause` chain, so §4.4's `ActDeepeningError` cannot bury it.
3. **Model ids in one place (F-03).** `backend/src/config/models.ts` maps tier → id and tier → per-token
   price, env-overridable (`FORAY_MODEL_OPUS` etc.), defaulting to `claude-opus-5`, `claude-sonnet-5`,
   `claude-haiku-4-5-20251001`. All eight Anthropic-calling classes read it; a grep test fails if a literal
   `claude-*` appears anywhere in `src/` outside that file.
4. **Spine validation before deepening (F-13).** `spineStructure.ts` checks what a per-beat schema cannot
   see — a claim written into two acts, a paragraph where a claim belongs, two sentences in one beat, an act
   with no start or end state — plus the tier's act/slot/beat ranges, and `buildSpine` fails the stage on
   any of them. Run 1's real spine (3 acts, 6 slots, 31 beats) is the fixture that must keep passing.
5. **Research-map topic filter (F-11).** Two changes in `matchConceptsInText`: a term must match at a word
   boundary (exact token, or a ≥4-character stem), and — when the caller knows the Foray's resolved
   topic — a concept that matched only on a stem and sits outside the Foray's taxonomy lineage is dropped.
   `buildResearchShape` resolves that topic from the intent itself.

   *Correction to F-11 as written.* The finding says the leak came from "shared tokens (`engineering`)".
   It did not. `ai`'s first term is the two-letter string `ai`, the prompt contained the word "chains", and
   the old matcher accepted any interior substring — `ch-ai-ns`. The finding's proposed fix, "topic-node
   filtering", is also wrong if *family* means the root segment: `ai`'s only topic is
   `engineering/ai-robotics`, which shares the `engineering` root with `engineering/disasters`, so a
   root-segment rule would have KEPT the leak while deleting `bridges`, `disasters`, `infrastructure` and
   `decision-making` — the four most on-topic concepts run 1 matched, all of which live under other roots.
   Family here therefore means *lineage* (a node, its ancestors, its descendants), and the boundary rule
   does the work the finding attributed to the filter.

**Files.** `config/models.ts`, `generation/checkpoint.ts`, `generation/spineStructure.ts` (new);
`config/env.ts`, `cost/budgetGuard.ts`, `generation/{runPipeline,buildSpine,catalogueLookup,researchShape,deepenActs,stageTiming}.ts`,
`cli/generateForays.ts`, every `Anthropic*` builder, tests.

**Done when.** A pipeline run whose narration fails leaves its spine and deepened acts on disk and the
re-run pays only for narration; a budget stop says which stage and how much; no builder names a model; a
spine with a duplicated or multi-sentence beat claim never reaches a deepen call; and `Ai` is not in the
research map for run 1's own prompt.

## Rules for the agents

- Work on a branch from `generation-run-2026-09-09` (it carries the run-1 fixes); one PR per workstream,
  tests green (`npx vitest run` in `backend/`), CRLF files stay CRLF.
- Do not touch `data/`, `data-local/`, the scratchpad relay, or any running process.
- Do not apply the `founder-approved` label or merge; the overlord reviews and merges.
- Cite the finding ids you close in the PR body; if a finding turns out to be wrong, say so there.
- Keep prompts short and put every rule that can be checked in code, in code.
