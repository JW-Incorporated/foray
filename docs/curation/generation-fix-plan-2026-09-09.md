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

## WS-H — Tier 2 matches transcript text, not titles (closes F-06, F-49's cause; depends on WS-C's gates)

Run 2 (#552's offline replay) proved the archive holds the tape and the search never reaches it: the title-token bar
rejects every candidate before the anchored-window test runs. Build a text-level candidate search for tier 2: for each
`account` beat, query `data-local/corpus/corpus.db`'s FTS index (or, where a show has no corpus chunks, a BM25 over the
normalised cue text of the beat's lineage-admissible episodes) with the claim's content words; take the top N episodes;
run the EXISTING `resolveAnchorFromCues` + anchored-window overlap + lineage gate + cut-to-cue-boundaries on those; keep
the title bar only as a tie-breaker. Emit the same `sourcingTrace` rows so the replay test can show which gate now
decides. Regression: run 1's Chernobyl-for-Hyatt and griddle anchors must still be refused (tests pinned in
`sourceBeats.test.ts`); run 2's ImageNet-label-errors beat must reach the window test against *Practical AI*.
**Files.** `transcriptArchiveLookup.ts` (candidate search), a small `corpusSearch.ts` over `corpus.db` (read-only,
machine-local, provider-shaped like `TranscriptCueProvider` so CI without the DB degrades to the title path), tests.
**Done when.** The F-49 fixture (`backend/test/fixtures/run2-deepen-2026-09-09.json`) yields ≥ 1 tape beat offline on
this machine with a trace that names the window test as the deciding gate, and no run-1 regression case flips.

## WS-G — Keyed-run readiness (closes F-05, F-47, F-48)

Every number in the run doc arrived through the relay, and the relay is exactly the transport that cannot
exercise a real API call's economics. Three findings are open for that reason alone. **F-47:**
`claude-opus-5` and `claude-sonnet-5` run adaptive thinking by default, its tokens bill as output and count
against `max_tokens`, and no builder sets `thinking` or `output_config` — with caps at continuity 500,
understander 400/600, researcher 800 and verifier 2,000, a keyed run truncates a JSON reply inside the
thinking budget (F-39's failure, now systematic) and `BudgetGuard`'s estimate under-counts every call.
**F-48:** `retrievePassages` holds the retrieval model's *restatement* of a search result as the document,
so the substring gate proves a quote is consistent with what that call wrote rather than with the page at
the url — `groundedQuoteRate = 1.0` overstates the veracity chain by exactly that step. **F-05:** the
researcher that decides a topic's "genuine controversies" is the cheapest tier at 800 output tokens, which
is the same cap under the same new thinking budget. Set `output_config: { effort: "low" }` on the per-page
calls (writer, verifier, continuity, understander), leave the spine at default effort, raise the small caps
by a thinking allowance, teach `env.ts`'s estimate to include it, and move retrieval to `web_fetch` +
`citations: { enabled: true }` on the `_20260209` tool types, holding server-attested `cited_text` spans as
the document.

**Files.** `config/models.ts`, `config/env.ts`, `cost/budgetGuard.ts`, `AnthropicExternalResearcher.ts`, the
narration writer/verifier and continuity builders, `AnthropicPromptUnderstander.ts`, tests.

**Done when.** No builder can be called with a cap a thinking budget can exhaust (asserted in a test, not
noted in a comment); the budget estimate names its thinking allowance; a retrieved passage carries a
`cited_text` span the retrieval model did not author, and `groundedQuoteRate`'s doc comment stops
disclaiming itself; and a keyed smoke run of one medium Foray completes with no truncated reply.

## WS-I — Paraphrase-tolerant anchoring (closes F-61, F-62; depends on WS-H)

WS-H moved tier 2's gate from "no title matched" to "the tape itself does not say this", and #553's own
numbers say the second wall is higher than the first: all 23 searching beats of the run-2 fixture reach real
*Practical AI* transcripts (BM25 13–21, `foundBy: text-index`) and every one stops at `tier2:no-anchor`.
`resolveAnchorFromCues` requires a contiguous run of ≥ 4 of the CLAIM's own words spoken verbatim; across 63
bodies exactly one claim has such a run, in an episode ranked 53rd, and the window test correctly refuses it.
The rule conflates two jobs — *which window carries the beat*, a relevance judgement already answered by BM25
plus the anchored-window overlap, and *which spoken phrases mark that window's edges* for ADR-0007's
drift-tolerant seeking, which must be verbatim tape words, but the **tape's**, not the claim's (F-61). The
same PR's one successful mint shows the second defect: `cutSpanToCueBoundaries` grows a short window
symmetrically to reach `MIN_TAPE_SEGMENT_SEC` (45 s), and this archive's cues average ≈ 28 s, so the listener
hears half a minute of Underwriters Laboratories before the passage the beat is about (F-62). Pick the window
by overlap; mint `startAnchor`/`endAnchor` from the first and last distinctive phrases *inside* it; keep the
≥ 3 content-word overlap and the lineage gate; add a relevance floor so a weak window is refused rather than
padded; and grow toward the side whose next cue shares claim terms — a shorter segment beats an off-claim
lead-in.

**Work is already in flight** on `fix/f61-anchors-from-tape`. This card records the spec and the acceptance
that PR has to meet; it is not a new assignment.

**Files.** `transcriptArchiveLookup.ts` (`resolveAnchorFromCues`, `cutSpanToCueBoundaries`), `sourceBeats.ts`
(trace rows), tests.

**Done when.** The F-49 fixture (`backend/test/fixtures/run2-deepen-2026-09-09.json`) yields ≥ 1 tape beat
whose anchors are phrases spoken in the tape rather than written in the claim; no minted segment opens on a
cue that shares no claim term; the trace names the deciding gate; and run 1's Chernobyl-for-Hyatt, griddle
and San Bruno anchors are all still refused.

## WS-J — Finalize-time hygiene (closes F-20, F-55, F-56, F-57, F-58, I-15)

Five defects that all surface at finalize, after every stage has been paid for, and one host lesson.
`slotsFromSpine` de-duplicates slot ids while `toForayItem` re-slugifies without de-duplication, so two slots
sharing a title both emit `slot: "foo"`, the declared `foo-2` gets no items, and non-adjacent slots fail the
contiguity rule at the end of a run (F-55). The minted title is capped at 120 characters while
`check-forays.mjs` rejects anything over 18 words, and nothing between them catches the gap (F-56).
`generation-architecture.md` makes the ± 15 % runtime tolerance a publishability condition, and the code
bounds only act/slot/beat counts, so a *medium* Foray can finalize at 25 or 100 minutes (F-57).
`check-narration.mjs` gates the hand-authored curation artifacts the pipeline never writes, so its
digit-in-a-spoken-line, reference-leak, sentence-rhythm, numeric-facts and hedge rules never touch a
generated page — even though the prose prompt asks for three of them in words (F-58). The driver's own error
text double-encodes `§` on a Windows console (F-20). And I-15: the harness killed the shell wrapping run 1
attempt 4 for low system memory, and only the completion notification was lost because the process tree
happened to survive — a production batch run must be detached (service or container), not a child of an
interactive shell.

**Files.** `runPipeline.ts` (`slotsFromSpine`, the title mint), `forayItems.ts`, `spineStructure.ts`,
`finalizeForay.ts`, `narrationRules.ts`/`validateNarratedBeat`, `cli/generateForays.ts`, tests; one line each
in `generation-architecture.md` for the runtime band and for detached execution.

**Done when.** Two slots sharing a title either finalize contiguously or are refused at the spine; a title
over 18 words cannot be minted; a Foray outside its tier's runtime band fails a named check instead of
passing silently; `spokenLineErrors` runs over every `NarratedBeat.script`; and no console output
double-encodes a section sign. F-57's band per tier and F-58's severity for each lifted rule are founder
calls — bring them a proposal, do not pick them in code.

**Added 2026-09-09 (requirements refresh, PR #561):** two sourcing outputs never leave the run — `sourcingTrace` (per-beat, F-49) and
`transcriptionQueueCandidates` (§8.2's open half) are checkpointed and printed but are on neither `RunPipelineOutcome` nor
`report.json`, and the checkpoint is deleted when the candidate is written. Surface both in `report.json` (trace summarised per
slot, candidates listed) so a run's sourcing evidence survives its success. Also: `purposeFidelity` can now see a `false` from a
kept-unverified page — say so in `veracityMetrics.ts`'s doc comment.

## WS-K — Narration follow-ups (closes F-19; settles F-37 in the design doc; closes F-41's repetition half)

Three things the evidence-first rewrite left behind. **F-19 / F-25:** a Frame's 70–170 characters and §4.7
rule 3 are still close to incompatible — narrowing the definition of *contested* and moving rule 3 to the
verifier lowered the cost without removing the conflict, and a contested source on a Frame page still has to
be voiced inside 170 characters. Either let the budget flex when a source is contested, or forbid contested
sources on connective pages and say so in the selection prompt. **F-37:** the design's disagreement about
whether a connective page needs sources was settled *in code* (`sources: []` only for a page with no
declarative sentence) and never written down; `narration-craft.md` still says nothing about it, so the next
reader re-derives the argument from scratch. **F-41:** the verifier now asks whether a page accomplishes its
purpose, and nothing asks whether it repeats an earlier one — run 1's beat 7 re-told the Hyatt collapse from
the top, date, tea dance, phone call and doubled load, all already covered by beats 1–5, and the
stitch/continuity stage only sees that after every page is paid for. Give the writer a one-line summary of
each previous page in the act, and give the verifier a repetition question alongside `purposeAccomplished`.

**Files.** `AnthropicNarrationWriterBuilder.ts` (selection and prose prompts),
`AnthropicNarrationVerifierBuilder.ts`, `writeNarration.ts`, `types/narration.ts`,
`docs/curation/narration-craft.md`, tests.

**Done when.** A Frame carrying a contested source either fits its budget or cannot be selected;
`narration-craft.md` states the source-free-connective-page rule the code already enforces; and a page that
re-states an earlier page's claims is rejected with that reason, with run 1's beat 7 as the fixture.

## Rules for the agents

- Work on a branch from `generation-run-2026-09-09` (it carries the run-1 fixes); one PR per workstream,
  tests green (`npx vitest run` in `backend/`), CRLF files stay CRLF.
- Do not touch `data/`, `data-local/`, the scratchpad relay, or any running process.
- Do not apply the `founder-approved` label or merge; the overlord reviews and merges.
- Cite the finding ids you close in the PR body; if a finding turns out to be wrong, say so there.
- Keep prompts short and put every rule that can be checked in code, in code.
