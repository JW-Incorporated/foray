# Generation v2: the roadmap

Tracking issue #1286 · written 2026-10-11, revised the same day after plan review (25 fixes: checkpoint variant at both sites, same-wave collisions, missing test files and floors, gated backlog, default flips, stale carried-over text) · repo snapshot origin/main b44d1ed6 (C:/w/review-main)

## Purpose and directive

This roadmap turns every issue on the **Foray Generation Baseline** doc into buildable cards: the reviewers' proposals (R1-01..R1-20 speed, R2-01..R2-21 quality), the Baseline tab's "What is not measured" list (QK-20..QK-30), which the founder ruled is a list of things to fix, the "Gaps against the two targets" (GP-01..GP-10, GP-20..GP-28), the HW-12 correction (no local-provider code exists), and the sync-r2 list-only size report and disk guard promised to the founder.

Founder directive, 2026-10-11 (verbatim, issue #1286):

> ok, looking at the artifact, there is already a ton of good improvements to be made that were suggested by the fable agents. Also, the "what is not measured" list should be considered a list of things to fix. please use ultracode and go work through all of the issues listed on the artifact. by all means, make thorough plans and so on before starting any work

Seven workstreams (measurement, provider layer, retrieval, critical path, gates, delivery, model gap) each designed and reviewed their cards against the snapshot. This document merges them: duplicates are folded into one card (the better design wins, covers are merged, each card lists the original ids it came from), dependencies run across workstreams, and the cards are scheduled into waves.

## Constraints

- KPIs: Foray quality "awesome"; generation "about 30 seconds", read as 30 s to first audio on the short tier, the whole Foray ready within 90 s (short) or 4 min (medium), generated ahead of the playhead.
- No Anthropic API call anywhere in the generation pipeline. Models: Qwen3.8-27B on the DGX Spark (SGLang behind LiteLLM at http://192.168.0.72:4000), the second box (Hermes records 2x Tesla P40 serving Qwen3.6-35B-A3B; the founder said V100s; OQ-01 open), and Jev (TypeSafe's hosted typed-decision model).
- Claude-built training data and dossiers through the subscription relay are parked (OQ-06): only Qwen-built or code-built alternatives are planned.
- UI freeze: no edits to app.js, styles.css or index.html. player/ and backend/ are fine.
- docs/legal wording needs the founder. Governed paths (backend/src, backend/migrations, docs/DECISIONS.md and others under tools/ci/path-policy.mjs) need the founder-approved label, which the orchestrator applies.
- Generated candidates stay local; nothing is published to data/forays.json by this work.
- Every card is built and tested offline (fixtures, recorded responses, fakes). Steps that need a model, the Spark's disk, R2 or a listener are separate live steps that wait on founder-supplied secrets queued on #1163 and never block code work.
- Agents run one test process at a time, never tools/ci/run-suites.mjs, and never kill node.exe by image name.
- Adopted defaults (recorded, not re-asked): OQ-02 readability in code, grade band 6-9; OQ-03 as the KPI reading above; OQ-04 clip transcripts only on the timed path, outside facts from precomputed dossiers; OQ-05 Jev inside generation with a Qwen-judge fallback; OQ-07 Spark shared, Foray first in line; OQ-08 start with the models already served; OQ-09 the founder listens; OQ-10 commit a copy of the doc.

## How to read the plan

- Cards are numbered GV-01..GV-124. GV-01..GV-122 were numbered in wave order before the review fixes; after them GV-14 sits in wave 4 and GV-23 in wave 3 (swapped to make room), GV-123 (split out of GV-15) sits in wave 14, GV-124 (the #1413 review follow-ups) sits in wave 20, and GV-77 and GV-96 are in the gated backlog (wave 'gated', 0 in the machine summary). The wave table is authoritative. Each card lists **from** (the original workstream ids). Carried-over design text still names original ids (W1-02, W5-12a ...); the id map at the end resolves them.
- A wave holds at most 6 cards; no two cards in a wave edit the same existing file (test/suite-integrity.test.js excepted, see decision 1); a card sits in a wave only after every card it depends on is in an earlier wave.
- Every behaviour change ships dark behind a flag or a route that defaults to today's behaviour, so main stays shippable between waves. A QK or GP fix is CLOSED only when its default flips, per the Default flips table (after the gated backlog, before Coverage).
- Every card that touches a tools/ci/path-policy.mjs DENIED_PREFIXES path (backend/src/, backend/migrations/, docs/DECISIONS.md, tools/narration/upload-narration.mjs, ...) says 'founder-approved label (orchestrator applies)' in its Founder need line; any live-step need follows it.
- The merged cards begin their design with an INTEGRATION NOTE saying what was kept from each source and what was dropped; where the note and a carried-over source design disagree, the note wins.

## Decisions

1. Floors registry: test/suite-integrity.test.js is exempt from the one-editor-per-wave rule. Every new suite must be floored in the PR that adds it (the 'every backend suite on disk is covered by a floor' test), each card only adds distinct keys, and the 'no suite is floored twice' test catches merge slips; optional floor raises wait for a later PR.
2. Wave count is set by backend/src/generation/runPipeline.ts: 39 cards edit it, so 39 waves is the floor and the schedule reaches it. Splitting runPipeline.ts into stage modules first was considered and rejected: it is a governed 1,777-line file (backend/src/generation/runPipeline.ts) and a mechanical split would conflict with every card in flight.
3. One per-run AsyncLocalStorage context (runLog.ts, GV-01) serves timers, budgets and lane priority; W2-01's chat/callContext.ts is not built, and providers call runLog.recordModelCall directly.
4. One stage-selection mechanism: FORAY_STAGE_<STAGE>=<impl>[:<lane>] with an implementation registry (GV-03). Provider choices are never pipeline flags; FORAY_SPINE_PROVIDER, FORAY_WRITER_PROVIDER, FORAY_CLARITY_PROVIDER, FORAY_NARRATION_VERIFIER, FORAY_RESEARCHER, FORAY_JUDGE_FALLBACK and FORAY_FORBID_ANTHROPIC are dropped.
5. One flag-reader module (generationFlags.ts, call-time, fail-fast naming only the variable); pipelineFlags and gateConfig are built on it, and no retrieval or gate flag goes into config/env.ts.
6. One TypeScript Jev client, flat file backend/src/generation/jevClient.ts (W5-01's design; W2-11 merged), metered through BudgetGuard and recorded as CallRecords.
7. The Qwen-judge fallback implements the JevClient interface (W5-19's shape) with W2-12's circuit breaker and fail-closed 'none' route; the separate TypedJudge interface is not built.
8. Prompt text moves once, straight into backend/src/generation/prompts/*.ts, in the prompt-layout cards (GV-32, GV-50); the legacy retirement card (GV-96) only deletes.
9. ChatSpineBuilder and ChatNarrationWriterBuilder are the only Qwen spine and writer classes; W4-18's LocalSpineBuilder and W4-19's LocalNarrationWriterBuilder become features of them.
10. Output budgets live in one table (config/outputBudgets.ts: per-stage targets, builder caps moved out of the Anthropic builders, spineMaxTokens); the long-tier spine target is 2,400 tokens, PROPOSED.
11. The per-tier spine JSON schema is zodToJsonSchema(RawSpineSchema) with per-tier overrides, not a hand-built schema; reply schemas live only in replySchemas.ts (no writerSchemas.ts).
12. Outside facts: the research route decides (none in local mode, dossier once built); the evidence cache is used only by the anthropic researcher, so no Haiku web text can replay into a local run.
13. Per-act servability (GV-21) merges W6-01's item provenance with W5-12a's act veracity; it is always computed on the new delivery field (no flag), never aborts a run, and the hand-off line counts as unverified.
14. Lead over the playhead is computed in-process by DeliveryTimeline into report.delivery; W1-19's offline lead.mjs is not built.
15. Bench targets: short-tier first audio <= 30 s and whole Foray <= 90 s short / <= 4 min medium are SETTLED (orchestrator's adopted reading); medium first audio <= 40 s and lead >= 30 s stay PROPOSED until a founder ruling.
16. Voice: backend/src/copy/spokenLine.js (CommonJS) is the only implementation of the splitter, FK grade, sentence shape, speakability and filler; tools/foray/voice-metrics.mjs wraps it; there is one voiceChecks.ts.
17. No voice card ships unconditionally: the voice card and exemplars come only from the founder-selected tools/generation/exemplars/narration-exemplars.json, behind FORAY_WRITER_EXEMPLARS (default off).
18. Best-of-2 spine has one implementation: the wrapper GV-91 (W7-07) plus judge adapters GV-97 (W7-11); W4-16 is folded into both and stays off unless the golden set shows a gain.
19. Stage swaps run all-local under the zero-Anthropic rule: arms differ in one stage's lane, model or lever, E0 measures the all-Qwen floor against the committed Claude-written Forays, and one runner (GV-75: W7-04 plus W2-16's spawn) does plan, run, collect and decide.
20. Checkpoint safety: one `variant` string joins the semantics-changing flags (GV-15) and the local routing (GV-55) into checkpointFingerprint, computed once from the same merged flags and passed at BOTH call sites: the FileCheckpointStore built at generateForays.ts:590-593 and the session at runPipeline.ts:920. FileCheckpointStore.save keeps existing stages only when the file's fingerprint equals the store's (checkpointStore.ts:63-67), so a variant at one site only would block a flag-on run from resuming its own stages and would merge classic and flag-on stages into one file. CHECKPOINT_VERSION is not bumped, so classic banked runs survive.
21. The SourcingSession extraction (GV-18) lands before every other sourceBeats.ts change, and any new ledger must be added to its exportState.
22. The lane scheduler (GV-93) derives priority from {stage, act} in the run context, so it does not edit runPipeline.ts or deepenActs.ts; it also charges Spark and second-box seconds to the unit caps (GV-90), which also count Jev calls.
23. Retrieval and sourcing changes ship dark: FORAY_RETRIEVAL_URL unset keeps today's local path, FORAY_RETRIEVAL_MODE defaults to bm25 until the replay gate (GV-88) passes, the show-share rule defaults off.
24. Tier runtime targets use the committed spec values (about 15 / 60 / 180 min) in one constant table; moving short to 10 min is a one-line change if the golden-set listen prefers it.
25. Recorded adopted defaults: golden-set strata 30/10/5/5, reading-grade band 6-9 (OQ-02), Jev with a Qwen-judge fallback (OQ-05), clip transcripts only on the timed path (OQ-04), Claude-built data parked (OQ-06).
26. Doc corrections recorded: backend CI runs vitest, not jest; Spark lane A2 has served 9 concurrent requests since 2026-10-03, so 'maxConcurrent 2' is a Foray policy; lane A2 has neither --enable-cache-report nor --enable-priority-scheduling yet; start-run's tests live in tools/generation/relay.test.mjs.
27. References to original ids (W1-02, W5-12a, ...) inside the carried-over designs are resolved by the id map at the end of this document. Carried-over paragraphs that an integration note or a decision overrides are marked SUPERSEDED in place.
28. The critical path has ONE source: builder-level spans from callLog.ts instrumentDeps (GV-123), fed to serialCallChain. They are provider-independent, so scripted and fake providers produce them offline; GV-117 wires instrumentDeps into runForayPipeline under FORAY_FAST_PATH. CallRecords (GV-07, GV-13, GV-20) remain the source of per-call speed metrics only.
29. Gated backlog: GV-77 (gate: a #862 bench win) and GV-96 (gate: the founder's #1163 confirmation after a golden-set listen of the all-local pipeline) are not scheduled. Nothing depends on them; R1-13 and HW-12 stay covered by scheduled cards. Each is placed when its gate is met, after the last scheduled editor of its files, with a fresh collision check.
30. The QK-20..QK-29 and GP-23..GP-26 fixes are closed by default flips, not by merging the dark cards: the Default flips table names, per flag, the target default, the evidence (golden compare within GV-64's bands, calibration of at least 0.9, the founder's pairwise listen) and who flips it (the orchestrator, with the founder-approved label on the one-line PR).
31. Accepted ordering (GV-68): the relay leaves the default path in wave 12, while Spark, second-box and Jev unit caps land in waves 18-19 (GV-90, GV-93). Until both merge the orchestrator runs no unattended or batch local generation (no golden-set or swap-arm batches), only watched single-prompt checks.
32. One servableThrough: delivery.servableThrough is an ITEM COUNT of the leading servable prefix, prelude included (GV-21). The act-level value is servableThroughAct, derived from delivery.acts and never stored; there is no FORAY_PARTIAL_VERACITY_GATE flag. GV-44's snapshot and servableView slice by the item count.
33. One gate verdict: GV-26's `gate` {ok, failures} and `publishable` are the only verdict fields; GV-118 passes {tapeGate} into the same evaluateVeracityGate call and adds tapeGate to `gate`. There is no meta.veracityGate.
34. Gate config threading: GV-15 adds only RunPipelineOptions.gates and the report row; each gate card threads its own key into WriteActOptions, SourceBeatsOptions or the stitcher options in the PR that first needs it.
35. One listening-axes schema: review verdicts (GV-41, data-local/review/verdicts.jsonl) embed the listen-card/1 axes from tools/listening/card.mjs (GV-08); founder listening cards stay in docs/curation/listening/cards.jsonl. GV-81, GV-94, GV-103 and GV-114 read verdicts from that one schema.
36. The 'none' research route ships with the routing wiring (GV-37: NullExternalResearcher), because GV-03 makes it the local-mode default and runPipeline.ts:992-999 builds the researcher at pipeline start; GV-61 adds the shared researcher, the cache rule, topicNodeIds and printEvidenceSkipped.
37. Structural guards: GV-19's fetch rule allows exactly GV-07's PROVIDER_CALL_SITES (anthropicCall.ts, chat/openAICompatProvider.ts, the flat jevClient.ts) plus the pre-listed retrievalClient.ts; the `.complete(` rule covers chat/** only. When GV-96 deletes anthropicCall.test.ts, these guards move to providerGuards.test.ts first.
38. One set of LiteLLM variables (FORAY_LLM_BASE_URL, FORAY_LLM_API_KEY / FORAY_LLM_API_KEY_FILE) for the backend and the dossier selector (GV-65 adds only FORAY_DOSSIER_MODEL), documented in docs/curation/generation-providers.md (GV-68).
39. GV-108's check-forays question was settled in planning by reading tools/foray/check-forays.mjs: it has no rule requiring a narration item before a clip (segment adjacency rules D2, D4 and D5 run over segments only), so the cut policy emits the dropped seam rather than withholding the act.
40. Every card's file list includes each test suite its acceptance or tests section edits, and the per-wave collision check (no two cards in a wave edit the same file, suite-integrity.test.js excepted) was re-run after the fixes and is clean.

## Waves

| Wave | Cards | Why this wave |
|---|---|---|
| 1 | GV-01 Per-run RunLog (AsyncLocalStorage) with every event type…<br>GV-02 Reply schemas in one module, plus a zod-to-JSON-Schema…<br>GV-03 Stage routing table, implementation registry and lane…<br>GV-04 Bench: true elapsed time beside the stage sum (TM-10,…<br>GV-05 Streamed index assembly: byte-identical per-show BM25 caches…<br>GV-06 sync-r2: list-only inventory report and disk-space guard | Foundations with no dependencies: per-run log, reply schemas and JSON Schema converter, stage routing table, true elapsed time in the bench, streamed index assembly, sync-r2 size report and disk guard. |
| 2 | GV-07 CallRecord at the model-call choke point (createMessage),…<br>GV-08 Listening card: schema, append-only store, unseal and…<br>GV-09 Stream indexer: build caches, staged digest rows and passages…<br>GV-10 One spoken-line and readability library…<br>GV-11 render-foray.py: render from a candidate, per item, default…<br>GV-12 Passage cutter: whole-thought passages with offline anchors… | First users of the foundations: per-call records, listening card, stream indexer, shared spoken-line library, render from a candidate, passage cutter. |
| 3 | GV-13 ChatProvider contract, call context and OpenAI-compatible…<br>GV-15 Run configuration foundation: call-time flag readers,…<br>GV-16 Retrieval server core: resident episode index with exact BM25…<br>GV-17 Bench: per-call speed summary (MT-04..MT-08, MT-10, MT-12)…<br>GV-18 SourcingSession: source one act at a time with the Foray-wide…<br>GV-23 Legacy whisper JSONs: key parser, hash resolver, converter to… | OpenAI-compatible provider, run-configuration foundation (flag readers, pipeline flags, gate config, checkpoint variant at both fingerprint sites), retrieval server, per-call bench summary, the SourcingSession refactor that lands before any other sourceBeats.ts change, and the legacy whisper reader (moved up from wave 4 to make room for GV-14). |
| 4 | GV-14 Stage x tier output-token budgets (R1-17) in one table,…<br>GV-19 askStructured: one provider-neutral JSON call (meter,…<br>GV-20 Typed Jev client in TypeScript (noul / choice / score): never…<br>GV-21 Per-act servability on partial candidates: item provenance,…<br>GV-22 Long-lived render worker with a spool directory, plus the…<br>GV-24 Scorecard: one MQ row per Foray (score.mjs) plus reference… | Output-token budgets (now read through generationFlags, so after GV-15), askStructured, Jev client, per-act servability, render worker, scorecard. |
| 5 | GV-25 Chat builders for the planning stages: understander, spine,…<br>GV-26 The pipeline evaluates its own publish gate; MQ-21 run…<br>GV-27 Per-sentence support judge: candidate sources per sentence…<br>GV-28 Passage store and embeddings: SQLite passages table,…<br>GV-29 Backend retrieval client: RemoteRetrieval,…<br>GV-30 Offline topic dossiers, code-built: fetched article text per… | Qwen planning builders, gate verdict in every run, per-sentence support judge, passage store and embeddings, retrieval client, code-built dossiers. |
| 6 | GV-31 Chat builders for narration: act writer and act verifier on a…<br>GV-32 Planning prompts split into a byte-stable prefix (stable /…<br>GV-33 Item-ready events: onItemReady hook, RunLog readiness events,…<br>GV-34 Numbers, dates and names checked by code against a sentence's…<br>GV-35 Model-swap decision rule, adopted-stack file and append-only…<br>GV-36 Blind pair listening pack: builder plus a self-contained… | Qwen writer and verifier, planning prompt layout, item-ready events, code checks on numbers, dates and names, swap decision rule and ledger, blind listening pack. |
| 7 | GV-37 Wire routing into the seven stage factories and decouple live…<br>GV-38 Act writer sees its act introduction and exit, the previous…<br>GV-39 Corpus fingerprint and prompt-set identity in report.json…<br>GV-40 Streaming (SSE) on the OpenAI-compatible provider, with true…<br>GV-41 Review queue ordered by scorecard risk, per-act review cards,…<br>GV-42 Exemplar miner: code-scored voice exemplar shortlist from… | Routing wired into the factories (with the 'none' research route), act frame for the writer, corpus fingerprint, streaming transport, review queue, exemplar miner. |
| 8 | GV-43 Streamed writer contract: writeActStream plus an incremental…<br>GV-44 Job snapshot sink (file-backed) and an author-checked read of…<br>GV-45 Golden set v1: 10 listened and 40 scored prompts, stratified,…<br>GV-46 Stitcher and partial projection accept a Foray whose later…<br>GV-47 Judge fallback (OQ-05): Qwen-judge behind the JevClient…<br>GV-48 Dense arm, hybrid merge and per-taxonomy-node nightly… | Streamed writer contract, job snapshot sink, golden set v1, incremental stitcher, judge fallback, hybrid merge and node shortlist. |
| 9 | GV-49 Jev clarity understander: one Jev request with two yes/no…<br>GV-50 Act writer and verifier prompts split into a byte-stable…<br>GV-51 JevNarrationVerifierBuilder: per-beat choice and per-sentence…<br>GV-52 Bench delivery columns and the split per-tier targets…<br>GV-53 Digest rows for streamed episodes: RSS join of staged rows,…<br>GV-54 Remote cue store: on-demand R2 body fetch with a bounded disk… | Jev clarity check, writer prompt layout (the only actNarration.test.ts editor in this wave), Jev verifier, bench delivery targets, digest rows for streamed episodes, remote cue store. |
| 10 | GV-55 Driver plumbing: --stage-provider flag, routing in…<br>GV-56 Corpus body schema accepts optional per-cue word timestamps…<br>GV-57 Player: append a streamed Foray and wait for the next part…<br>GV-58 Spark render worker deployment kit and the GB10 benchmark run…<br>GV-59 generation_jobs table (D9) and a Supabase job sink<br>GV-60 Stream indexer: legacy whisper source (index the 7,531 root… | Driver routing and report attribution, word-timestamp schema, player append, Spark render kit, generation_jobs table, legacy whisper indexing. |
| 11 | GV-61 No web research on the timed path: 'none' and 'dossier'…<br>GV-62 Keep and fork checkpoints so arm B reruns only from the…<br>GV-63 Phone diagnostics: per-clip precision row and per-Foray tally…<br>GV-64 Bench --golden aggregation, --headline and --compare with…<br>GV-65 Dossier selection pass by Qwen: choose and flag passages,…<br>GV-66 Retrieval on the Spark: deployment kit, body transfer,… | Shared researcher and no-web cache rule, checkpoint fork for swaps, phone clip diagnostics, golden aggregation and compare, Qwen dossier selection, retrieval-on-Spark kit. |
| 12 | GV-67 Code-derived pre-spine intent; subject, angle,…<br>GV-68 Zero-Anthropic enforcement: structural guard, explicit legacy…<br>GV-69 DossierExternalResearcher: print evidence and research notes…<br>GV-70 Lock-screen 'Building the next part' state for a waiting…<br>GV-71 Stamp rendered audio into a candidate file, never into…<br>GV-72 Whisper round trip (WER <= 5% per item) and a per-Foray… | Copy folded into the spine, zero-Anthropic enforcement, dossier researcher, lock-screen waiting state, candidate audio stamping, whisper round trip. |
| 13 | GV-73 writeAct streaming path: gate each seam as its line closes,…<br>GV-74 Backend render stage: enqueue ready narration items and fold…<br>GV-75 Stage-swap experiment runner: plan, run, collect and decide…<br>GV-76 Whole clip window as evidence: no 3,000-character excerpt,…<br>GV-78 Offline anchor-resolution report per Foray (MQ row, target… | Per-seam streaming gate, render stage, stage-swap runner, whole clip window as evidence, anchor resolution report. GV-77 moved to the gated backlog. |
| 14 | GV-79 MQ-05 clip-on-subject scorer (shadow mode): two Scores per…<br>GV-80 Timed-path round policy: at most one edit round, editing only…<br>GV-81 Two lanes: on-demand plays behind code gates (Jev later);…<br>GV-82 Pronunciation hints into a run-local render lexicon (IPA…<br>GV-123 Critical-path probe: builder-level spans (callLog.ts… | Clip-on-subject scorer (shadow), timed round policy, two review lanes, IPA pronunciation hints, and the critical-path probe split out of GV-15 (it touches no shared file). |
| 15 | GV-83 Show variety metric (MQ-07): distinct shows and largest…<br>GV-84 Streamed act writer on the Spark: writeActStream (one JSONL…<br>GV-85 Code-time spans inside ST-02, ST-03 and ST-06 (MT-08) | Show variety metric, streamed Qwen writer, code-time spans. runPipeline.ts is edited by 39 cards, so from here each wave carries one of them (show variety). |
| 16 | GV-86 Fold deepen into the spine on the short tier (no deepen call…<br>GV-87 Research map: per-show quota so the spine is offered 2-3 shows<br>GV-88 Retrieval replay harness and the hybrid go/no-go gate (MQ-09… | Deepen folded into the short spine (the runPipeline.ts editor), per-show quota, retrieval replay gate. |
| 17 | GV-89 Tier runtime targets and a post-spine runtime check that… | Tier runtime check; runPipeline.ts chain. |
| 18 | GV-90 Unit caps per Foray: Spark seconds, second-box seconds, Jev… | Unit caps per Foray; runPipeline.ts chain. After this wave and wave 19, batch local runs are allowed (GV-68's accepted ordering). |
| 19 | GV-91 Constrained best-of-2 spine wrapper with a deadline and a…<br>GV-92 Offline judged-metrics pass: MQ-10 prompt fit and MQ-12 seam…<br>GV-93 Lane scheduler: per-machine concurrency, critical-path… | Best-of-2 spine wrapper (runPipeline.ts and runPipeline.test.ts editor), offline judged metrics, lane scheduler (its priority assertions live in laneScheduler.test.ts). |
| 20 | GV-94 Typed self-critique decorator: per-sentence check on the…<br>GV-124 Generation follow-ups from #1413: unit caps per Foray… | Typed self-critique; runPipeline.ts chain. GV-124 (the #1413 follow-ups) lands after GV-94, before batch local runs and before self-critique or streaming is switched on. |
| 21 | GV-95 Pipeline wiring: prepare every search and hydrate every body…<br>GV-97 Jev and Qwen-judge adapters for SpineJudge and DraftCritic,… | Remote retrieval wiring (runPipeline.ts editor), spine judge and critic adapters. GV-96 moved to the gated backlog. |
| 22 | GV-98 Evidence wave off the timed path: await only act 1's packs,…<br>GV-99 Voice card and exemplar block in the Qwen writer's cached… | First-act evidence wave (runPipeline.ts editor), exemplar block in the writer prefix. |
| 23 | GV-100 Spine tier sizing on the Spark: per-tier JSON schema,…<br>GV-101 Run-start corpus integrity guard (roadmap PKG-23), extended… | Spine tier sizing (runPipeline.ts editor), run-start corpus guard. |
| 24 | GV-102 Per-act pipeline driver: act 1's deepen, source, evidence,…<br>GV-103 Judge calibration harness: labelled examples in, an… | Per-act pipeline driver (runPipeline.ts editor, after remote retrieval and first-act evidence), judge calibration. |
| 25 | GV-104 Voice checks on generated narration: N7-N9 and N24 in the…<br>GV-105 Spark generation worker: claim a job, run the pipeline with… | Voice checks (runPipeline.ts editor), Spark generation worker. |
| 26 | GV-106 Tier-aware clip ceiling in sourcing plus the MQ-14 tier-fit… | Tier-aware clip ceiling; runPipeline.ts chain. |
| 27 | GV-107 Beat candidate enumeration and async pre-judging: one Jev… | Per-beat clip Choice; runPipeline.ts chain. |
| 28 | GV-108 Cut-to-introduction policy: a failing seam keeps only its… | Cut-to-introduction policy; runPipeline.ts chain. |
| 29 | GV-109 Clean-cut measurement (MQ-06) with per-edge boundary kinds,… | Clean-cut measurement; runPipeline.ts chain. |
| 30 | GV-110 Bench-only writer exchange recorder (request, reply, verdict…<br>GV-111 Snap clip edges to real pauses from word timestamps, with… | Writer exchange recorder (runPipeline.ts editor), pause snapping. |
| 31 | GV-112 Research map: add windows from the topic node's precomputed…<br>GV-113 Cut unsupported sentences instead of rewriting; only an…<br>GV-114 Act-level training-example ledger and fine-tune readiness… | Shortlist windows for the spine (runPipeline.ts editor), cut unsupported sentences, training-example ledger. |
| 32 | GV-115 Sourcing: per-show tape ledger, soft show-diversity order,… | Show-share ledger; runPipeline.ts chain. |
| 33 | GV-116 Voice drift alarm: one Jev 'same narrator as the exemplar?'… | Voice drift alarm; runPipeline.ts chain. |
| 34 | GV-117 Fast-path assembly: early-item signals, three serial model… | Fast-path assembly, after every critical-path card it wires together (including GV-123's probe). |
| 35 | GV-118 Tape publish gate: swap QK-04 (taxonomy family) for MQ-05… | MQ-05 publish gate on GV-26's existing gate field; runPipeline.ts chain. |
| 36 | GV-119 Judged walk in sourceBeats: follow the choice order, a… | Judged sourcing walk; runPipeline.ts chain. |
| 37 | GV-120 Attribution check (MQ-03): the person an introduction names… | Attribution check; runPipeline.ts chain. |
| 38 | GV-121 Verify act introductions, exits and the prelude overview… | Frame verification; runPipeline.ts chain. |
| 39 | GV-122 Mint clip anchors by distinctiveness: never a span that… | Distinctive anchors; runPipeline.ts chain. |
| gated | GV-77 Optional PyTorch-CUDA render backend…<br>GV-96 Retire the legacy Anthropic generation builders… | Gated backlog: not scheduled; each enters a wave only when its gate is met (see the Gated backlog section). |

### Shared-file hot spots

Files edited by five or more cards, in merge order. Rebase on whichever landed last.

| File | Cards (in wave order; gated-backlog cards last) |
|---|---|
| backend/src/generation/runPipeline.ts | GV-01, GV-07, GV-15, GV-21, GV-26, GV-33, GV-38, GV-43, GV-49, GV-55, GV-61, GV-67, GV-73, GV-79, GV-83, GV-86, GV-89, GV-90, GV-91, GV-94, GV-124, GV-95, GV-98, GV-100, GV-102, GV-104, GV-106, GV-107, GV-108, GV-109, GV-110, GV-112, GV-115, GV-116, GV-117, GV-118, GV-119, GV-120, GV-121, GV-122 |
| backend/src/cli/generateForays.ts | GV-01, GV-15, GV-26, GV-33, GV-39, GV-44, GV-49, GV-55, GV-62, GV-68, GV-74, GV-81, GV-85, GV-86, GV-89, GV-90, GV-91, GV-94, GV-124, GV-95, GV-99, GV-101, GV-103, GV-105, GV-106, GV-110, GV-117, GV-118, GV-122, GV-96 |
| backend/test/runPipeline.test.ts | GV-01, GV-07, GV-21, GV-26, GV-33, GV-38, GV-61, GV-67, GV-79, GV-83, GV-90, GV-91, GV-94, GV-95, GV-98, GV-115, GV-119, GV-121 |
| backend/src/generation/veracityMetrics.ts | GV-21, GV-26, GV-34, GV-61, GV-73, GV-79, GV-83, GV-104, GV-106, GV-108, GV-109, GV-113, GV-116, GV-118, GV-120, GV-121 |
| backend/src/generation/gateConfig.ts | GV-34, GV-47, GV-79, GV-103, GV-104, GV-107, GV-108, GV-109, GV-111, GV-113, GV-118, GV-119, GV-120, GV-121 |
| backend/test/generateForays.test.ts | GV-15, GV-26, GV-33, GV-39, GV-44, GV-55, GV-68, GV-74, GV-81, GV-103, GV-118, GV-96 |
| tools/generation-bench/run.mjs | GV-04, GV-08, GV-17, GV-24, GV-52, GV-55, GV-64, GV-83, GV-91, GV-104, GV-106, GV-116 |
| tools/generation-bench/run.test.mjs | GV-04, GV-08, GV-17, GV-24, GV-52, GV-55, GV-64, GV-83, GV-91, GV-104, GV-106, GV-116 |
| backend/test/actNarration.test.ts | GV-07, GV-34, GV-38, GV-50, GV-73, GV-104, GV-106, GV-108, GV-113, GV-120, GV-96 |
| backend/src/generation/sourceBeats.ts | GV-18, GV-85, GV-95, GV-106, GV-107, GV-109, GV-111, GV-115, GV-119, GV-122 |
| backend/src/generation/writeAct.ts | GV-07, GV-34, GV-38, GV-73, GV-80, GV-104, GV-108, GV-110, GV-113, GV-120 |
| backend/test/veracityMetrics.test.ts | GV-26, GV-34, GV-79, GV-83, GV-104, GV-106, GV-109, GV-113, GV-118 |
| backend/test/runPipelineCheckpoint.test.ts | GV-01, GV-21, GV-79, GV-102, GV-108, GV-109, GV-119, GV-121 |
| docs/curation/generation-kpis.md | GV-04, GV-08, GV-17, GV-24, GV-52, GV-64, GV-117, GV-118 |
| backend/src/generation/generationFlags.ts | GV-69, GV-76, GV-87, GV-95, GV-98, GV-112, GV-115 |
| backend/src/generation/transcriptArchiveLookup.ts | GV-05, GV-12, GV-54, GV-85, GV-109, GV-111, GV-122 |
| backend/src/generation/writeNarration.ts | GV-38, GV-46, GV-61, GV-73, GV-80, GV-110, GV-120 |
| backend/src/generation/AnthropicSpineBuilder.ts | GV-02, GV-25, GV-32, GV-67, GV-89, GV-96 |
| backend/src/generation/researchShape.ts | GV-19, GV-61, GV-85, GV-87, GV-95, GV-112 |
| tools/passage-index/README.md | GV-16, GV-28, GV-48, GV-60, GV-66, GV-88 |
| backend/src/generation/AnthropicNarrationVerifierBuilder.ts | GV-02, GV-25, GV-31, GV-50, GV-96 |
| backend/src/generation/AnthropicNarrationWriterBuilder.ts | GV-02, GV-31, GV-38, GV-50, GV-96 |
| backend/src/generation/NarrationWriterBuilder.ts | GV-38, GV-43, GV-80, GV-94, GV-120 |
| backend/src/types/tapeSourcing.ts | GV-79, GV-106, GV-109, GV-115, GV-119 |
| backend/test/stitchForay.test.ts | GV-21, GV-33, GV-46, GV-108, GV-121 |
| tools/narration/render-foray.py | GV-11, GV-22, GV-72, GV-82, GV-77 |
| tools/narration/render-foray.test.mjs | GV-11, GV-22, GV-72, GV-82, GV-77 |

## Cards

### Wave 1

#### GV-01 · Per-run RunLog (AsyncLocalStorage) with every event type declared; stage spans including failures; timed topic stage; elapsedMs, driverMs, tier and promptId in report.json

- **From:** W1-02
- **Wave:** 1 · **Size:** M · **Depends on:** none
- **Covers:** R1-14, TM-10, MT-02, MT-03, GP-01

**Goal.** Give every pipeline attempt one per-run, concurrency-safe log that later cards append to (calls, code spans, readiness, meters, renders). Record stage time even when a stage throws, and give report.json a correct elapsed time, the tier and a prompt id.

**Design.**

INTEGRATION NOTE: CallContext also carries priority?: 'critical'|'background' and lane? (W2-01's separate chat/callContext.ts is not built; the provider layer imports withCallContext from here).

New module backend/src/generation/runLog.ts. It is pure and in-memory: it never writes a file, which keeps promptNoPersistence.test.ts green.
- `RUNLOG_SCHEMA = 'runlog/1'`.
- Every event type the workstream will emit is declared here now, so the tools reader (W1-04) and the producers agree on one shape:
  - `StageSpan {kind:'stage', name, act?, startMs, endMs, ms, status:'ok'|'failed'|'resumed'}`
  - `CallRecord {kind:'call', seq, stage, act, seam, attempt, role, reask, provider, machine, model, label, startMs, endMs, ms, queueMs, ttftMs, promptTokens, cachedTokens, outputTokens, decodeTokPerSec, maxTokens, outputBudget, overBudget, stopReason, jsonValid, error?}`
  - `ParseEvent {kind:'parse', ok, reask}`
  - `CodeSpanAggregate {kind:'code', stage, name, count, totalMs, maxMs}`
  - `ReadyEvent {kind:'ready', granularity:'act'|'item', actIndex, itemIds, readyMs, partialOk}`
  - `RenderSpan {kind:'render', itemId, audioSec, ms}`
  - `MeterEvent {kind:'meter', unit, amount, reserved, stage}`
  - All times are ms since the log's t0.
- `class RunLog({now?})`: append, events(kind), stages(), calls(), callTotals(), spanMs(), toJsonl() (a header line {schema, t0Iso} then one event per line).
- ALS helpers: `runWithRunLog(log, fn)`, `currentRunLog()`, `withCallContext(partial, fn)`, `currentCallContext()` (the merged chain).
- `CallContext {stage?, act?, seam?, attempt?, role?, reask?, tier?, resumeAttempt?}`.
- Every helper is a no-op when no log is active.

stageTiming.ts:
- `StageTiming.failed?: true`.
- StageTimingLog.run (:64) times the call itself. On a throw it pushes `{name, startedAt, ms, failed:true}` and rethrows.
- measureStage (:42) keeps its success-only return shape, because it has no result to return on a throw. Its doc comment (:37-41, :49-52), which falsely claims failures are timed, is corrected.
- Export `spanMsOf(timings)`, the same definition as W1-01.

runPipeline.ts:
- `timed()` (:937) runs fn inside `withCallContext({stage:name, act})`. act comes from a /:(\d+)$/ match. It appends a StageSpan, ok or failed.
- stageDetail (:954) appends a 'resumed' span.
- The inline topic decision (:1137-1162) gets its own span: the pinned/decideTopic branch is wrapped in `timings.run('topic', ...)`. A banked topic or identity calls timings.markResumed('topic').
- The body runs inside `withCallContext({tier: req.duration})`.
- narrationActs (:1694) skips failed rows.
- Update the stage-name pins at runPipeline.test.ts:144 (topic now sits between understand and research-shape) and runPipelineCheckpoint.test.ts:240.

generateForays.ts generateOneCandidate (:548):
- One RunLog per attempt. Each runPipeline call (:666) runs inside runWithRunLog plus withCallContext({resumeAttempt}).
- PromptSpec (:87) gains `id?: string`. normalizePrompts already passes objects through.
- ReportEntry (:433) gains:
  - `elapsedMs`: spanMsOf of the final attempt's timings. On aborted and error rows it comes from the attempt's RunLog stage spans; ms:0 stays.
  - `driverMs`: Date.now() - startedMs (:642).
  - `duration`
  - `promptId`
  - `runLog`: relative path `runlogs/<checkpointKey>.<attempt>.runlog.jsonl`.
- Runlogs are written by the CLI (cli/, outside generation/) unless --dry-run. They hold names, numbers and ids only, no prompt text and no model output.

**Files edited:**

- backend/src/generation/stageTiming.ts
- backend/src/generation/runPipeline.ts
- backend/src/cli/generateForays.ts
- backend/test/stageTiming.test.ts
- backend/test/runPipeline.test.ts
- backend/test/runPipelineCheckpoint.test.ts
- backend/test/generateForaysHandsFree.test.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/runLog.ts
- backend/test/runLog.test.ts

**Acceptance:**

- Two concurrent runWithRunLog scopes with interleaved awaits and Promise.all fan-outs never see each other's events.
- A stage that throws leaves a failed StageSpan and a StageTiming with failed:true and its real ms.
- A stub-builder runForayPipeline produces timings named understand, topic, research-shape, spine, deepen, source, evidence, narrate:0, stitch:0, finalize, in that order.
- A generated report row has elapsedMs equal to spanMsOf(timings), plus driverMs, duration and (when the spec has an id) promptId.
- An aborted row (refused-partial or budget-stop) carries elapsedMs from its log while ms stays 0.
- After a non-dry run, runlogs/<key>.<n>.runlog.jsonl exists, starts with the runlog/1 header, and contains no substring of the prompt.
- npm run typecheck is clean. BACKEND_FLOORS gains runLog.test.ts, and the floors for stageTiming, runPipeline, runPipelineCheckpoint and generateForaysHandsFree are raised.

**Tests.** cd backend && npx vitest run, one file at a time:
- test/runLog.test.ts: ALS isolation, context merge, fake clock, toJsonl shape
- test/stageTiming.test.ts: failed timing, spanMsOf with overlap
- test/runPipeline.test.ts: topic stage, spans recorded, failed span from a throwing injected deepen builder
- test/runPipelineCheckpoint.test.ts: resumed topic span
- test/generateForaysHandsFree.test.ts: elapsedMs on generated and aborted rows; runlog written without prompt text

**Flag.** none. Report fields are additive, readers ignore unknown keys, and the log helpers are inert outside runWithRunLog.

**Live step.** The founder PC's next run (relay or local) writes the first real runlog automatically.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** runPipeline.ts and generateForays.ts are also edited by W1-03, W1-06, W1-08, W1-09 and W1-13, and by other workstreams (provider layer, per-act pipeline). This card lands first and the others rebase on it. AsyncLocalStorage context is lost across event-emitter callbacks; none are on this path, but the tests must cover the deepen Promise.all and the narration gate. A failed narrate stage must not enter narrationActs.

#### GV-02 · Reply schemas in one module, plus a zod-to-JSON-Schema converter for grammar-constrained output

- **From:** W2-03
- **Wave:** 1 · **Size:** S · **Depends on:** none
- **Covers:** R1-18

**Goal.** Make every JSON reply schema available as JSON Schema, for SGLang's json_schema constraint and for llama.cpp, without a new dependency. zod ^3.23.8 has no converter, and backend/package.json has no zod-to-json-schema.

**Design.**

1. Move the reply schemas out of the Anthropic builders, unchanged, into backend/src/generation/replySchemas.ts, and import them back so the Anthropic path is byte-identical:
- ClaritySchema and IntentSchema (AnthropicPromptUnderstander.ts:33,39)
- the title re-case schema z.object({title}), currently inline at ~:229
- RawSpineSchema and its parts (AnthropicSpineBuilder.ts:44-60)
- RawDeepenedActSchema (AnthropicDeepenActBuilder.ts:47-63)
- RawSmoothResultSchema (AnthropicContinuityBuilder.ts:32)
- RawClaimSchema, RawWrittenSeamSchema and RawActWriteSchema (AnthropicNarrationWriterBuilder.ts:54,98,106)
- RawActVerifySchema (AnthropicNarrationVerifierBuilder.ts:68)
Export REPLY_SCHEMAS: Record<ReplySchemaName, ZodTypeAny>. The researcher's ResearchSchema and PassagesSchema stay where they are, because research is not routed locally (W2-10).

2. New module backend/src/generation/chat/jsonSchema.ts: zodToJsonSchema(schema) covers exactly the subset in use, which is object, array, string, number, boolean, enum (deepen's kind), optional, nullable (clarity question) and array .max (clarity readings).
- optional is left out of required.
- nullable becomes type [T,'null'].
- Objects get additionalProperties:false.
- .min/.max become minItems/maxItems or minLength/maxLength.
- Any other construct (union, effects, record, transform, default) throws UnsupportedZodError naming the path.

3. responseFormatFor(name) returns {type:'json_schema', name, schema, strict:true} and caches it. Prose fields stay free strings.

**Files edited:**

- backend/src/generation/AnthropicPromptUnderstander.ts
- backend/src/generation/AnthropicSpineBuilder.ts
- backend/src/generation/AnthropicDeepenActBuilder.ts
- backend/src/generation/AnthropicContinuityBuilder.ts
- backend/src/generation/AnthropicNarrationWriterBuilder.ts
- backend/src/generation/AnthropicNarrationVerifierBuilder.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/replySchemas.ts
- backend/src/generation/chat/jsonSchema.ts
- backend/test/jsonSchema.test.ts
- backend/test/__snapshots__/jsonSchema.test.ts.snap

**Acceptance:**

- Every REPLY_SCHEMAS entry converts without throwing, and a snapshot pins each JSON Schema.
- z.union and .transform throw UnsupportedZodError naming the field path.
- Optional fields are absent from required, nullable fields allow null, and every object has additionalProperties:false.
- AnthropicSpineBuilder.test.ts, AnthropicDeepenActBuilder.test.ts, AnthropicPromptUnderstander.test.ts and actNarration.test.ts pass unchanged.
- For each schema, a sample valid reply (from existing fixtures such as backend/test/fixtures/run2-deepen-2026-09-09.json) parses with zod and fits the generated schema, checked by a minimal walker in the test.

**Tests.** Run `npx vitest run test/jsonSchema.test.ts`, then the four builder suites above one at a time, then `npm run typecheck`.

**Flag.** Inert until W2-04 sends response_format.

**Live step.** Send each schema as response_format to local-heavy and local-worker once. Confirm that xgrammar and llama-server accept it; minLength/maxLength, nullable unions and strict:true are the likely gaps. Record any gap in the lane profile's structuredOutput field (W2-05).

**Founder need.** founder-approved label (orchestrator applies); plus LiteLLM key for the live check.

**Risk.** A grammar can nudge content (R1-18's risk); the eval workstream compares QK-05 before and after on the golden set. Later schema edits (R1-02 title, R2-07 disappointment field) update the snapshot in their own PRs. Governed path.

#### GV-03 · Stage routing table, implementation registry and lane profiles as config (per-stage switch, Spark lane, second-box lane)

- **From:** W2-05, W7-02
- **Wave:** 1 · **Size:** M · **Depends on:** none
- **Covers:** R2-21, R1-08, R1-11, GP-27

**Goal.** Replace the tier-only model choice in config/models.ts:48-143 with a per-stage route; today FORAY_MODEL_SONNET swaps four stages at once. Encode the hardware as data, so the P40-vs-V100 answer (OQ-01, R1-11) becomes a config edit. Make the plan's ruling a validated default: prose stays on the Spark, while planning, deepen and checks go to the second box.

**Design.**

INTEGRATION NOTE (merged W2-05 + the registry half of W7-02; both proposed FORAY_STAGE_<STAGE>).
- One mechanism: FORAY_STAGE_<STAGE>=<impl>[:<lane>] read by stageRouting.ts. Stage ids are W2-05's list plus 'spine-alt' (no default; used by the best-of-2 spine, GV-91). There is no separate stageAssignment.ts.
- Registry (from W7-02): registerStageImplementation(stage, implId, {create, describe}), instantiateStage<T>(stage) and describeStageAssignments() -> Record<stage, {impl, model, machine?}> live in stageRouting.ts. A malformed or unregistered id throws, naming the variable without echoing its value (buildSpine.ts:60-70 pattern). registerStageImplementation refuses a duplicate id.
- Built-ins stub, anthropic (legacy) and local are registered by the factories (GV-37); other cards register their own ids: none and dossier (research, GV-61, GV-69), jev (understand.clarity GV-49, verifier GV-51, judge GV-47).
- W7-02's FORAY_FORBID_ANTHROPIC is not added: the double opt-in of GV-68 is the guard.

--- From W2-05 ---
New module backend/src/config/machineProfiles.ts defines LaneProfile:
- id: 'spark'|'second'
- modelAlias, maxConcurrent, reservedCritical
- prefillTokPerSec, decodeTokPerSec {json, prose}
- promptCeilingTokens|null, allowsProse
- structuredOutput, logprobs
- serverPriority {enabled, critical, background}
- usdPerMtokIn, usdPerMtokOut

Defaults, each with a source comment:
- spark: local-heavy, maxConcurrent 2, reservedCritical 1, prefill 1900 (HW-02), decode json 83 / prose 21.8 (Hermes lane A2 tune report 2026-10-03), allowsProse true, json_schema, serverPriority off.
- second: local-worker, maxConcurrent 2 (one per P40, llama-server --parallel 1), prefill 895 and decode 51 (HW-06), promptCeilingTokens 2000, allowsProse false, json_schema.
FORAY_MACHINE_PROFILES_FILE overrides them. The file is zod-validated, and a malformed file throws.

New module backend/src/config/stageRouting.ts. It is pure and reads an injected source, process.env by default. config/env.ts and env.anthropicDryRun are untouched, because enrich/ and buildSession.ts depend on that getter.
- StageId: understand.clarity | understand.intent | understand.title | research | spine | deepen | writer | verifier | continuity | judge.
- Route: {provider:'stub'|'anthropic'|'local'|'none'|'jev'|'dossier'; lane?; model; thinking?; temperature?}.

resolveRouting(source):
- mode = FORAY_GENERATION_MODE (stub|local|anthropic-legacy). Otherwise it is local if FORAY_LLM_BASE_URL is set, else anthropic-legacy if ANTHROPIC_API_KEY is set (today's behaviour, env.ts:214), else stub.
- Local defaults: understand, spine, writer, verifier and continuity on local:spark; deepen on local:second; research none (OQ-04); judge jev, falling back to local:second (OQ-05).
- FORAY_STAGE_<STAGE> overrides one stage, e.g. FORAY_STAGE_SPINE=local:second.
- It throws RoutingConfigError naming the variable in four cases: writer routed to a lane with allowsProse:false (unless FORAY_ALLOW_PROSE_ON_SECOND=1); local used without FORAY_LLM_BASE_URL; an unknown value; or 'dossier' before the retrieval workstream registers it.

The key comes from FORAY_LLM_API_KEY or FORAY_LLM_API_KEY_FILE. routingSummary() is safe to log. models.ts remains the source only for anthropic-legacy rows.

**Files edited:**

- test/suite-integrity.test.js

**New files:**

- backend/src/config/machineProfiles.ts
- backend/src/config/stageRouting.ts
- backend/test/stageRouting.test.ts
- backend/test/machineProfiles.test.ts

**Acceptance:**

- With an injected source holding only ANTHROPIC_API_KEY, or nothing, resolveRouting reproduces today's per-stage choice exactly.
- With FORAY_LLM_BASE_URL set, every stage resolves to the documented local default, and FORAY_STAGE_SPINE=local:second moves only the spine.
- A writer on the second lane throws, naming the prose rule, unless FORAY_ALLOW_PROSE_ON_SECOND=1.
- A malformed profiles file or an unknown FORAY_STAGE_* value throws, naming the variable.
- routingSummary never contains a key.
- Unregistered implementation ids throw without echoing the value; registerStageImplementation refuses a duplicate id; 'spine-alt' resolves to nothing unless set.

**Tests.** From W2-05: Run `npx vitest run test/stageRouting.test.ts` and `npx vitest run test/machineProfiles.test.ts`. Both test pure functions over an injected source, the same pattern as models.ts resolveModelId(tier, source).
Registry cases (from W7-02) go in test/stageRouting.test.ts.

**Flag.** Pure config and an empty registry. Nothing reads it until the factories are wired.

**Live step.** R1-11: on p40-ai, run `nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv`, then a 60 s bench: prefill at 8k, decode at 1 and 4 streams. Update the 'second' profile (allowsProse and maxConcurrent if the cards turn out to be V100s) through FORAY_MACHINE_PROFILES_FILE or a follow-up PR. Re-measure Spark single-stream and 2-stream decode on lane A2.

**Founder need.** founder-approved label (orchestrator applies); plus Joey or the founder runs the nvidia-smi command and the bench on p40-ai; there is no SSH from the agent machine.

**Risk.** W2-05: Stale facts: HW-01/HW-03 and CONTEXT say the Spark has 4 slots, but production lane A2 has served 9 concurrent requests since 2026-10-03, so maxConcurrent 2 is a Foray policy, not a hardware limit. The second box is unverified (P40 per Hermes, with XID-latch incidents on 2026-10-02, versus the founder's V100). Governed path.
W7-02: Governed path (backend/src) needs founder-approved. If the provider workstream also edits the create*.ts factories or adds its own FORAY_PROVIDER_<STAGE> list, the two drift; the cross need asks it to register 'qwen-spark', 'qwen-p40', 'jev' and 'qwen-judge' here instead. A keyless run that sets no FORAY_STAGE_* still gets Stubs; the no-Anthropic mode decoupled from ANTHROPIC_API_KEY belongs to the provider workstream.

#### GV-04 · Bench: true elapsed time beside the stage sum (TM-10, back-filled), plus core/detail column groups

- **From:** W1-01
- **Wave:** 1 · **Size:** S · **Depends on:** none
- **Covers:** TM-10, MT-02

**Goal.** Stop the KPI table reporting the summed stage time (run 9: 107.7 min) as wall time. Use the stageTimings every existing report already carries, with no backend change. Also add the column grouping that later bench cards need so the committed markdown table stays readable.

**Design.**

tools/generation-bench/run.mjs:
- Add `group: 'core'|'detail'` to every COLUMNS entry (:122); all of today's columns are 'core'. markdownHeader (:648), markdownRow (:640) and formatTable (:555) print 'core' only. A new `--wide` flag prints every column in the table. jsonlLine (:578) and rowFromJsonl (:603) keep carrying every number column. Later cards add 'detail' columns without touching the committed doc header.
- Add `export function spanMsOf(stageTimings)`: max(Date.parse(startedAt)+ms) - min(Date.parse(startedAt)) over entries without `resumed`. Returns null when none.
- Add the core column `{key:'elapsed_min', header:'elapsed m', from:'derived'}` after wall_min. In rowFor (:460), elapsed_min = minutes(num(entry.elapsedMs) ?? spanMsOf(v.stageTimings)). Reports written after W1-02 carry elapsedMs, and it wins.
- Keep key `wall_min` so baseline.jsonl stays comparable. Rename its header to ASCII `stageSum m`. Its targetNote becomes 'sum of stage durations; concurrent acts counted twice (TM-10)'. Move the `<= 6 min` PROPOSED target onto elapsed_min; W1-12 replaces it.

tools/generation-bench/baseline.jsonl: patch ONLY the run-9 line by adding metrics.elapsed_min (2676202 ms = 44.603 min) and sources.elapsed_min 'derived'. Every other byte stays as it is. Do not regenerate the line from the trimmed out-9 candidate. Runs 4-8 carry no stageTimings and stay absent (rule 1).

docs/curation/generation-kpis.md:
- Correct :134-140: `wall m`, now `stageSum m`, is the stage sum; `elapsed m` is first stage start to last stage end.
- Add the elapsed row to the targets table (:40-58).
- Replace the committed header (:105) with markdownHeader(), and regenerate the rows block from baseline.jsonl through `--append`, so the two committed-table tests (run.test.mjs:574-599) stay green.

**Files edited:**

- tools/generation-bench/run.mjs
- tools/generation-bench/run.test.mjs
- tools/generation-bench/baseline.jsonl
- docs/curation/generation-kpis.md
- test/suite-integrity.test.js

**New files:**

- none

**Acceptance:**

- `node tools/generation-bench/run.mjs tools/generation-bench/fixtures/out-9` prints elapsed m 44.6 beside stageSum m 107.7.
- out-4's row prints elapsed m as — (absent, not 0).
- An entry carrying elapsedMs uses it ahead of the derived span.
- Stage timings marked resumed:true are excluded from the span.
- A column with group 'detail' appears in --format jsonl and in --wide, but not in markdownHeader().
- The committed KPI table equals the rendered baseline (the existing test at run.test.mjs:581), and generation-kpis.md no longer says wall m is driver elapsed.
- The run.test.mjs floor in test/suite-integrity.test.js (:1597, 40) is raised to the new count.

**Tests.** node --test tools/generation-bench/run.test.mjs:
- the out-9 span equals 2676202
- resumed rows are ignored
- an elapsedMs override wins
- missing stageTimings reads as absent
- core/detail split in markdown vs jsonl
- the baseline round trip keeps elapsed_min

**Flag.** none. Adds a derived column; no report writer changes.

**Live step.** none

**Founder need.** none

**Risk.** Every later card that edits run.mjs, run.test.mjs or generation-kpis.md (W1-16, W1-04, W1-19, W1-11, W1-12, W1-15) conflicts on the same COLUMNS array and committed table, so they are chained through depends_on in that order. The roadmap's other prose still quotes run 9 as 107.7 min of driver time; fix any such quote found in docs/curation in the same PR.

#### GV-05 · Streamed index assembly: byte-identical per-show BM25 caches built from a body stream (backend refactor plus indexBodies CLI)

- **From:** W3-04
- **Wave:** 1 · **Size:** M · **Depends on:** none
- **Covers:** R1-09, GP-09

**Goal.** Build the exact per-show BM25 cache that FileTranscriptTextIndex reads from a stream of bodies, without a local mirror. An index built on another box must then be byte-compatible and judged fresh.

**Design.**

FileTranscriptTextIndex.build (transcriptTextIndex.ts:416-438) has three properties the streamed build must reproduce:
- Docs are ARCHIVE entries in archive order.
- Each body is found through FileTranscriptCueProvider.locate (transcriptArchiveLookup.ts:472+), trying corpusSafeKey(guid).json, then the bare slug, then a guid-verified prefix, then a scan of the bodies' own guid fields. Committed rows and bodies can disagree on the guid (Becker's: permalink vs slug; warmTranscriptIndex.ts:323-336).
- Cues pass through readCues' filter (:549-573): letter-spaced junk is dropped and bad timings are skipped.
A naive 'index whatever bodies arrive' build fails cacheIsFresh (:400-414), because doc counts and guids differ.

Pure refactors, behaviour unchanged:
1. transcriptArchiveLookup.ts:
   - Export cuesFromBodyJson(json) holding readCues' parse and filter; readCues calls it.
   - Export locateInListing({files: Map<lower,real>, guid, bodyGuidOf:(real)=>string|null}) holding locateUncached's rule; FileTranscriptCueProvider calls it.
2. transcriptTextIndex.ts:
   - Export countTerms (:483) and the ShowIndex and IndexedDoc types.
   - Export buildShowIndex(showId, entries, docFor:(entry)=>{stat, counts}|null), which private build() now calls.
   - Export writeShowIndexFile(indexRoot, index), the tmp+rename writer, and showIndexCacheFile(indexRoot, showId); writeCache and cacheFile call them.
   This module is already exempt in promptNoPersistence.test.ts.
3. warmTranscriptIndex.ts: export the pure core of reconcileCorpus as pendingCorpusRows(showId, showTitle, bodies:[{fileName, guid, cues}], claimedFiles) and claimedFilesFromDigests(). reconcileCorpus calls both.

New backend/src/cli/indexBodies.ts:
- Reads stdin JSONL records {kind:'body', show_id, fileName, stat:{mtimeMs,size}, body} and {kind:'end-show', show_id}.
- Per body it keeps only {fileName, bodyGuid, cuesCount, stat, counts = countTerms(cuesFromBodyJson(body))}. It never keeps the cues.
- At end-show:
  - rows = loadTranscriptArchive() rows for the show, plus pendingCorpusRows over this show's streamed bodies, which are new searchable rows with title = guid.
  - Each row maps to a streamed body with locateInListing over the streamed fileNames.
  - It calls buildShowIndex in row order, then writeShowIndexFile to --index-root (default data-local/transcripts/index).
  - It appends the new rows to --staged-out JSONL (data-local/passage-index/staged-digest.jsonl) and frees the show.
- It writes no body to disk and prints a summary line per show.
- main(stdin, stdout, opts) is exported for tests.

**Files edited:**

- backend/src/generation/transcriptArchiveLookup.ts
- backend/src/generation/transcriptTextIndex.ts
- backend/src/cli/warmTranscriptIndex.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/cli/indexBodies.ts
- backend/test/indexBodies.test.ts

**Acceptance:**

- Parity: for a synthetic tmp normalized corpus with 2 shows, the cache written by indexBodies deep-equals the one FileTranscriptTextIndex({archive, bodies: new FileTranscriptCueProvider(tmp), indexRoot: tmp2}) writes, ignoring builtAt. The corpus includes a committed-style row whose guid differs from the body's guid, a letter-spaced cue and a cue with end < start.
- After indexBodies runs, FileTranscriptTextIndex over the same files treats that cache as fresh and does not rebuild it (spy on readCuesUncached).
- The staged rows equal what reconcileCorpus({offline:true}) produces for the same bodies.
- The existing transcriptTextIndex, transcriptLocate, warmTranscriptIndex, sourceBeats and anchorTextParity suites pass unchanged.

**Tests.** vitest, one file at a time from backend/:
- `npx vitest run test/indexBodies.test.ts` (new)
- re-run test/transcriptTextIndex.test.ts, test/transcriptLocate.test.ts and test/warmTranscriptIndex.test.ts
Add a BACKEND_FLOORS entry for indexBodies.test.ts.

**Flag.** None: refactor-only exports plus a CLI that no pipeline stage calls.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed path (backend/src); it needs the founder-approved label. The locate and readCues extractions must stay behaviour-identical, and the existing locate and index suites plus the parity test pin that. The no-fetch structural test (sourceBeats.test.ts:308-333) still holds, because no fetch is added to these files.

#### GV-06 · sync-r2: list-only inventory report and disk-space guard

- **From:** W3-01
- **Wave:** 1 · **Size:** S · **Depends on:** none
- **Covers:** R2-16, GP-09, GP-22

**Goal.** Give the founder the promised list-only size report of the foray-transcriptions bucket, with no HEAD and no GET. Add a guard that refuses any real sync before it can fill the disk. This sizes normalized, raw, fingerprints and the 7,531 legacy root JSONs before anything is downloaded.

**Design.**

Verified on the snapshot:
- tools/foraycorpus-export/sync-r2.mjs:265 GETs every candidate, even under --dry-run.
- :256 HEADs every same-size local file.
- There is no size report and no free-space check.
- listPrefix (r2-client.mjs:155) yields {key,size}. MAX_OBJECT_BYTES is r2-client.mjs:48.

1. New pure module tools/foraycorpus-export/inventory.mjs.
   - classifyKey(key) returns 'normalized' | 'raw' | 'fingerprints' | 'legacy-root' | 'other'. 'legacy-root' reuses the key regex from W3-02's parseLegacyKey if it has merged; otherwise it inlines foray-db's _KEY_RE `^[a-z0-9][a-z0-9-]*/(?:.*-)?[0-9a-f]{10}\.json$` and excludes the transcripts/, transcript-originals/ and _ prefixes.
   - inventoryFromListing(objects, {out, statLocal}) returns {objects, bytes, unknownSizeObjects, by_area:{area:{objects,bytes,dirs}}, top_dirs (50 per area by bytes), largest_objects (20), local:{normalized_on_disk, would_fetch_objects, would_fetch_bytes}}. would_fetch counts a normalized key as missing when its bodyPath/localDirFor target is absent or a different size. Unknown sizes count as MAX_OBJECT_BYTES.
   - inventoryMarkdown(inv) renders a table to paste into #1163.
   - ensureDiskSpace({path, needBytes, minFreeBytes, statfs = fs.statfsSync}): free = bavail*bsize. It throws SyncError('DISK_SPACE', 'need X GB, free Y GB, keep Z GB') when free - needBytes < minFreeBytes. It is exported for reuse by W3-05.
2. sync-r2.mjs parseSyncArgs gains:
   - --list-only (prefix defaults to '' for this mode)
   - --report <file> (default data-local/transcripts/r2-inventory.json, written with writeJsonAtomic)
   - --min-free-gb <n> (default 20; 0 disables the guard)
   runListOnly calls listPrefix only and never builds Head or Get commands.
3. Split syncR2 (:202) into two phases. Phase A lists and filters the candidates into an array with the existing parseBodyKey, show map, --show and --limit logic, then computes needBytes and runs ensureDiskSpace BEFORE the first HEAD or GET. Phase B is the existing per-object loop, which re-checks statfs every 200 writes and stops with DISK_SPACE. Under --dry-run the guard verdict is printed but never stops the run.
4. DISK_SPACE exits with code 2. Add a README section 'Sizing the bucket before a sync'.

**Files edited:**

- tools/foraycorpus-export/sync-r2.mjs
- tools/foraycorpus-export/sync-r2.test.mjs
- tools/foraycorpus-export/README.md
- test/suite-integrity.test.js

**New files:**

- tools/foraycorpus-export/inventory.mjs
- tools/foraycorpus-export/inventory.test.mjs

**Acceptance:**

- With --list-only, the fake client records only ListObjectsV2 calls, with zero HeadObject and zero GetObject.
- Per-area object and byte counts (normalized, raw, fingerprints, legacy-root, other) equal the fixture listing.
- A sync whose needBytes exceeds free space minus the margin throws DISK_SPACE before any HEAD or GET and writes nothing.
- Same-size local files are excluded from needBytes.
- All existing sync-r2 tests pass. The sync-r2.test.mjs floor at test/suite-integrity.test.js:2251 (8) is raised, and a FLOORS entry is added for inventory.test.mjs.

**Tests.** Run `npm test --prefix tools/foraycorpus-export -- sync-r2.test.mjs inventory.test.mjs` (node:test). Inject a fake S3 client with command classes, as sync-r2.test.mjs already does, and an injected statfs.

Cases:
- call log for list-only
- area aggregation including legacy-root and fingerprints/
- top_dirs order
- would_fetch against a tmp mirror
- guard refuses, guard passes, and the mid-run re-check stops
- --min-free-gb 0

**Flag.** New CLI flags only. A plain sync behaves as before, except that the guard can refuse; --min-free-gb 0 restores the old behaviour.

**Live step.** With the read-only R2 key on the founder PC or the Spark, run `node tools/foraycorpus-export/sync-r2.mjs --list-only` and post the markdown table on #1163. It confirms the bucket size, the legacy count and the normalized bytes that W3-05 must stream.

**Founder need.** The R2 read-only key (R2_CREDENTIALS_FILE) on whichever machine runs the live step.

**Risk.** Low. Phase A holds the listed keys in memory, a few MB for tens of thousands of objects. The listing is lexicographic, so phase B processes keys in the same order as before.

### Wave 2

#### GV-07 · CallRecord at the model-call choke point (createMessage), with stage/act/attempt/role/reask context threaded by wrapping

- **From:** W1-03
- **Wave:** 2 · **Size:** M · **Depends on:** GV-01
- **Covers:** R1-14, MT-04, MT-05, MT-07, GP-01

**Goal.** Record one row per model call in the R1 per-call schema, so the provider layer and the Jev client fill queue, TTFT, cached tokens and decode rate through the same API, and the first local run measures everything.

**Design.**

INTEGRATION NOTE: PROVIDER_CALL_SITES starts as ['anthropicCall.ts', 'chat/openAICompatProvider.ts', 'jevClient.ts'] so GV-13 and GV-20 need no edit here.

runLog.ts gains `recordModelCall(input)`. It merges currentCallContext() and appends a CallRecord. It also exports `PROVIDER_CALL_SITES`, the module allowlist.

anthropicCall.ts createMessage (:22):
- Times the call with an injectable clock.
- On success it records:
  - provider 'anthropic'
  - machine 'relay' when ANTHROPIC_BASE_URL is set, else 'anthropic-api'
  - model = params.model, label
  - promptTokens = usage.input_tokens; cachedTokens = usage.cache_read_input_tokens ?? null; outputTokens
  - stopReason, maxTokens = params.max_tokens
- A max_tokens reply is recorded BEFORE assertReplyComplete throws.
- A thrown transport error is recorded with error = err.name and rethrown.
- queueMs, ttftMs and decodeTokPerSec stay null on this non-streaming path; the doc comment says so.
- runWebSearchTurn's pause_turn continuations (:139-150) run inside withCallContext({reask:'continuation'}).

Context threading, by wrapping only (no builder interface changes):
- deepenActs.ts:356: each act's deepenOneActWithRetry runs in withCallContext({act:index}); its retry loop (:287) adds {attempt}.
- writeAct.ts:399: writer.writeAct runs in withCallContext({attempt:round, role:'writer'}).
- writeAct.ts:443: verifier.verifyAct runs in withCallContext({attempt:round, role:'verifier'}).
- parseWithRetry.ts:57: `reask()` runs in withCallContext({reask:'json'}). Every builder's retryResponse createMessage lives inside that closure. The parse outcome is appended as a ParseEvent.
- buildSpine.ts:119: runs in withCallContext({reask: attempt>0 ? 'structural' : undefined, attempt}).
- postSeedSpine.ts:372: runs in withCallContext({reask:'seed-floor'}).

runPipeline.ts: when a log is active, pipelineTokens (:1729-1731) comes from currentRunLog().callTotals(); otherwise from getUsageTotals(). The two agree for one run per process. The global counter stays, and report `calls` keeps reading it.

anthropicCall.test.ts:111: the source-scan guard also forbids `recordModelCall(` in src/generation modules outside PROVIDER_CALL_SITES. The allowlist starts as anthropicCall.ts plus slots for the future provider and Jev modules.

Stub builders are NOT modified. Pipeline-level tests use test-local builders that wrap a Stub and also call createMessage with fakeAnthropicClient (test/helpers/fakeAnthropicClient.ts), so records come from the real choke point.

**Files edited:**

- backend/src/generation/runLog.ts
- backend/src/generation/anthropicCall.ts
- backend/src/generation/deepenActs.ts
- backend/src/generation/writeAct.ts
- backend/src/generation/parseWithRetry.ts
- backend/src/generation/buildSpine.ts
- backend/src/generation/postSeedSpine.ts
- backend/src/generation/runPipeline.ts
- backend/test/anthropicCall.test.ts
- backend/test/runPipeline.test.ts
- backend/test/actNarration.test.ts
- backend/test/parseWithRetry.test.ts
- test/suite-integrity.test.js

**New files:**

- none

**Acceptance:**

- With fakeAnthropicClient and a fake clock, createMessage appends a CallRecord with promptTokens, outputTokens, cachedTokens (from cache_read_input_tokens), stopReason, ms and label, under the active stage context.
- A truncated reply is still refused with TruncatedReplyError, and its record has stopReason 'max_tokens'.
- A forced JSON re-ask through AnthropicSpineBuilder (constructor client injection) produces a second record with reask 'json', and ParseEvents ok:false then ok:true.
- In actNarration.test.ts, wrapped stub writer and verifier observe currentCallContext() with attempt and role per round.
- With a log active, a runPipeline run with test-local createMessage-calling builders yields per-stage records and pipelineTokens equal to the log totals.
- The anthropicCall.test.ts guard fails when a non-allowlisted generation module calls recordModelCall.
- No prompt pin in actNarration.test.ts changes, so builder arguments are unchanged.

**Tests.** backend vitest, one file at a time:
- anthropicCall.test.ts: record shape, error and truncation records, continuation context, guard
- parseWithRetry.test.ts: reask context and ParseEvent
- actNarration.test.ts: attempt and role context
- runPipeline.test.ts: records per stage; pipelineTokens from the log

**Flag.** none. Recording only, inert outside runWithRunLog.

**Live step.** The first local Qwen run through the provider layer fills queueMs, ttftMs, cachedTokens, decodeTokPerSec and the machine field. It needs the LiteLLM key (#1163).

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** writeAct.ts and the spine and deepen modules are also being restructured by the writing workstream (R2-10 cut, R1-04 per-act chain, R1-06 streaming). Land this small wrapping first, and those cards keep the withCallContext wrappers when they move the calls. The provider layer must add itself to PROVIDER_CALL_SITES.

#### GV-08 · Listening card: schema, append-only store, unseal and pairwise results, bench MQ-20 columns

- **From:** W1-16
- **Wave:** 2 · **Size:** M · **Depends on:** GV-04
- **Covers:** R2-01, MQ-20, QK-30, GP-20

**Goal.** Replace Q-06's three saturating yes/no questions with the blind per-act card: 4 axes scored 1-5, an overall score, timestamped winces, and an A/B preference. Store verdicts as labelled data and show 'last listened' in the bench, so 'nobody has listened since' becomes a visible dated field.

**Design.**

tools/listening/card.mjs:
- `validateCard(card)` for `{schema:'listen-card/1', cardId, packId, label:'A'|'B'|'solo', act:1, listener, listenedAt, scores:{onSubject, flowsAtSeams, oneNarrator, nothingFalseOrOdd} (1-5), overall (1-5), q06:{oneVoice, everyClipIntroduced, anyClipCutShort}, winces:[{atSec, note}], preference?:'A'|'B'|'tie'}`.
- q06 is kept so MQ-20 stays continuous with the baseline definition.
- `readCards(file)`

Store: docs/curation/listening/cards.jsonl, committed and append-only. It holds the founder's verdicts only, with no transcript text. It is the store for founder listening cards; per-act review verdicts (R2-19) live in data-local/review/verdicts.jsonl with the same axes (GV-41), and both are labelled-example sources for LM-24.

tools/listening/unseal.mjs:
- Joins cards with the sealed key (data-local/listening/keys/<packId>.key.json, written by W1-17).
- Returns per pack {promptId, A:{candidateId, provider, stageSwap}, B, preferred, axisDeltas}.
- `aggregate()` gives the pairwise preference rate per stageSwap label, R2-21's go/no-go.
- `listenByCandidate()` gives {mean overall, last listenedAt} per candidate id.

run.mjs:
- 'detail' columns `listen` (mean overall) and `last_listen` (date text), joined by candidate id through listenByCandidate.
- The join is skipped (absent) when the keys are not on the machine.

Docs:
- listening-quality-plan.md Q-06 (:317-327) gets a status line: superseded by the listening card (R2-01).
- generation-kpis.md gets the MQ-20 definition.

**Files edited:**

- tools/generation-bench/run.mjs
- tools/generation-bench/run.test.mjs
- docs/curation/listening-quality-plan.md
- docs/curation/generation-kpis.md
- test/suite-integrity.test.js

**New files:**

- tools/listening/card.mjs
- tools/listening/unseal.mjs
- tools/listening/card.test.mjs
- tools/listening/unseal.test.mjs
- docs/curation/listening/cards.jsonl
- docs/curation/listening/README.md

**Acceptance:**

- validateCard rejects out-of-range scores, a missing axis, and a pair card without a preference.
- unseal maps labels back to candidates only when the key is present; without it, it refuses with a message naming the missing key.
- aggregate on 10 synthetic pair cards returns the correct preference rate.
- The bench prints last_listen as — until the first real card exists, and the committed KPI markdown table is unchanged (detail group).
- The Q-06 status line is updated; the new suites have floors.

**Tests.** node --test tools/listening/card.test.mjs; node --test tools/listening/unseal.test.mjs; node --test tools/generation-bench/run.test.mjs, all on synthetic cards and keys

**Flag.** none

**Live step.** none

**Founder need.** none

**Risk.** cards.jsonl sits under docs/ and auto-merges, so a bot could append a fabricated card. Each card must name the listener and a sealed packId, and the README says only the founder's pasted card JSON is appended. The depends_on is merge order on run.mjs.

#### GV-09 · Stream indexer: build caches, staged digest rows and passages from local bodies or R2 normalized objects, one body in memory (nightly delta)

- **From:** W3-05
- **Wave:** 2 · **Size:** M · **Depends on:** GV-05, GV-06
- **Covers:** R1-09, GP-09, R2-16

**Goal.** Build the BM25 caches, the episode manifest and the passage stream wherever transcripts live: the founder PC's data-local, or the Spark streaming R2. Only one body is held in memory at a time, so the 1 TB bucket never needs a mirror.

**Design.**

New package tools/passage-index/.

package.json:
- private, type module, node >= 22.5
- test script `node --experimental-sqlite --test`, the tools/corpus pattern; it must forward its args, as config.test.mjs requires of the corpus packages
- no dependencies
- It imports ../foraycorpus-export/{r2-client,sync-r2,show-map,inventory}.mjs. Their AWS SDK import is lazy, and tests inject command classes.

sources.mjs has async generators that yield {show_id, fileName, body, stat:{size,mtimeMs}, origin:{kind,key,sha256|etag}}, grouped by show:
- localSource(normalizedRoot) walks data-local/transcripts/normalized/<dir>/*.json in sorted order. stat is the file stat, so caches match a local FileTranscriptTextIndex.
- r2NormalizedSource({client, bucket, showMap, commands}):
  - listPrefix('transcripts/normalized/'), parseBodyKey, then resolveShowDir/localDirFor for show_id (imported, not copied).
  - getObject, then sha256 against metadata, then bodyShapeError.
  - mtimeMs = Date.parse(LastModified).
  - Failures are quarantined with sync-r2's reason codes.

manifest.mjs:
- data-local/passage-index/episodes.jsonl, one row per streamed body: {show_id, fileName, bodyGuid, cues, lastEndSec, size, mtimeMs, origin, indexedAt}.
- showsToRebuild(listing, manifest) compares by size and mtime/etag.

stream-index.mjs CLI: `--source local|r2 [--show x] [--full] [--passages-out f] [--index-root d] [--cue-cache d --cue-cache-gb n]`.
1. List.
2. Choose the shows to rebuild: all with --full, else the delta.
3. Estimate bytes written and run W3-01 ensureDiskSpace: about 0.4x body bytes for postings, plus about 1.1x if passages are on, plus the cue cache.
4. Spawn backend indexBodies once through tsx, using the warm-transcript-index.mjs launcher pattern, and stream body and end-show records.
5. Update the manifest atomically per show.

A show is re-streamed whole on any change, because ShowIndex postings are per show. Bodies are dropped after sending. With --cue-cache they are also kept in a byte-bounded LRU directory for W3-24.

Tests inject an indexer function in place of the spawn.

**Files edited:**

- test/suite-integrity.test.js

**New files:**

- tools/passage-index/package.json
- tools/passage-index/README.md
- tools/passage-index/sources.mjs
- tools/passage-index/manifest.mjs
- tools/passage-index/stream-index.mjs
- tools/passage-index/sources.test.mjs
- tools/passage-index/stream-index.test.mjs

**Acceptance:**

- With a fake R2 client, each normalized object is fetched exactly once per rebuild, and nothing is written to disk except caches, manifest and staged rows (plus cue cache only when set).
- An unchanged second run rebuilds no show and issues no GET.
- Changing one object rebuilds only its show.
- A quarantined object is reported and skipped, and the run continues.
- The disk guard refuses before the first GET.
- Records reach the indexer grouped by show, with an end-show marker after each show.
- The new package's test script forwards its arguments.

**Tests.** node:test, `npm test --prefix tools/passage-index -- sources.test.mjs stream-index.test.mjs`. Uses a fake S3 client (the sync-r2.test.mjs pattern), tmp dirs and a recording indexer stub.

Cases:
- local walk order
- R2 dir mapping and quarantines
- delta detection
- whole-show rebuild
- disk guard
- cue-cache LRU eviction by bytes

Add FLOORS entries. The run-suites discovery of the new package is automatic.

**Flag.** None. This is a new tool, and it writes only under data-local/passage-index and data-local/transcripts/index.

**Live step.** (1) On the founder PC, run `--source local --full` over the 5,041 bodies and confirm the caches match a fresh warm-transcript-index build (W3-08 parity check). (2) On the Spark, run `--source r2 --full` with the R2 read key, then nightly (W3-22).

**Founder need.** The R2 read key on the Spark, and approval to run a multi-hour stream job on the shared Spark (OQ-07: it runs niced).

**Risk.** Re-streaming a whole show costs up to about 306 MB for the largest show, which is acceptable nightly. The tsx child needs backend/node_modules on the running box. Show identity relies on show-map.mjs's 'first writer wins' rule (:68-110), so a wrong mapping files episodes under the wrong lineage. The W3-03 report surfaces unmapped dirs.

#### GV-10 · One spoken-line and readability library (backend/src/copy/spokenLine.js) shared by check-narration, the generator and the scorecard

- **From:** W5-17, W1-10
- **Wave:** 2 · **Size:** S · **Depends on:** none
- **Covers:** R2-14, QK-25, MQ-15, MQ-16, MQ-17, MQ-18

**Goal.** Move check-narration's N7-N9, N21 and N24 rules (tools/foray/check-narration.mjs:104-232, :558-591) into the shared copy/ module, the way narratorStructure.js already is (check-narration.mjs:40-41). One definition then serves the curation gate and generated narration. Today finalizeForay.ts:629-647 never runs check-narration on generated narration. This module is also the single sentence splitter for every per-sentence card (W5-08, W5-10, W5-12b, W5-16, W5-18).

**Design.**

INTEGRATION NOTE (merged W5-17 + W1-10; both wrote the FK grade, syllable counter and sentence statistics). The single implementation is the CommonJS backend/src/copy/spokenLine.js (W5-17), which backend TypeScript and tools .mjs can both import. From W1-10 it also exports speakability(text) (MQ-17, per 100 words: digits, URLs, acronyms, brackets plus spokenLineErrors hits) and filler(text) (MQ-18, per 100 words: -ly adverbs with a stoplist, passive voice, banned hedges/adjectives/openers, rhetorical questions), and sentenceShape reports over25 and shortShare. tools/foray/voice-metrics.mjs is a thin ESM wrapper over spokenLine.js that adds scoreVoice(scripts[]) (word-weighted aggregates) for the scorecard.

--- From W5-17 ---
New backend/src/copy/spokenLine.js, CommonJS ('use strict'; module.exports = {...}) exactly like narratorStructure.js (:1, :500), plus spokenLine.d.ts like narratorStructure.d.ts.

Moved verbatim from check-narration.mjs:
- REFERENCE_LEAK_RE, BANNED_HEDGES, BANNED_ADJECTIVES, BANNED_OPENERS, SPELLED
- SENTENCE_MEAN_WORDS, SENTENCE_MAX_WORDS, SHORT_SENTENCE_WORDS, RHYTHM_TRIGGER_SEC, NUMERIC_FACTS_PER_SENTENCE_MAX
- spokenLineErrors

Added:
- splitSpokenSentences(text): splits on . ! ? and the ellipsis, with an abbreviation guard (Dr., Mr., Mrs., St., U.S., e.g., i.e., vs., single capital initials) and decimals kept whole.
- sentenceShape(sentences) returns {mean, max, min, n}.
- numericExpressionsIn(sentence): digit groups plus spoken-number groups; a two-ended range with one unit counts once. This is N24's generated-text variant, because generated narration has no numeric_facts declarations.
- syllables(word): a heuristic vowel-group counter with silent-e and -le rules.
- fleschKincaidGrade(text) = 0.39(words/sentences) + 11.8(syllables/words) - 15.59.

check-narration.mjs does `import spokenLine from '../../backend/src/copy/spokenLine.js'` and re-exports every moved name with its existing export name, so other importers are unaffected. Its own logic and messages are unchanged.

hasDeclarativeSentence (types/narration.ts:656) is deliberately NOT moved onto the new splitter. Its behaviour is pinned by the stub verifier and the source rule.

--- From W1-10 (now a wrapper) ---
New module tools/foray/voice-metrics.mjs. It imports only check-narration.mjs exports and exports:
- `splitSentences(text)`
- `syllables(word)`: a vowel-group heuristic with silent-e and -le rules
- MQ-15 `fleschKincaidGrade(text)` and `READING_GRADE_BAND = [6, 9]` (OQ-02 adopted default)
- MQ-16 `sentenceShape(text)` {meanWords, maxWords, over25, shortShare}, using SENTENCE_MEAN_WORDS, SENTENCE_MAX_WORDS and SHORT_SENTENCE_WORDS (check-narration.mjs:104-106)
- MQ-17 `speakability(text)`, per 100 words: digits, URLs, acronyms (2+ capitals), brackets, plus spokenLineErrors(text, where, {}) hits (:189)
- MQ-18 `filler(text)`, per 100 words: -ly adverbs with a stoplist, passive voice (be-form + -ed/-en), BANNED_HEDGES/ADJECTIVES/OPENERS hits (:126-152), rhetorical questions
- `scoreVoice(scripts[])`: word-weighted aggregates plus per-script rows

check-narration rules are not edited.

**Files edited:**

- tools/foray/check-narration.mjs
- test/suite-integrity.test.js

**New files:**

- backend/src/copy/spokenLine.js
- backend/src/copy/spokenLine.d.ts
- backend/test/spokenLine.test.ts
- tools/foray/voice-metrics.mjs
- tools/foray/voice-metrics.test.mjs

**Acceptance:**

- node --test tools/foray/check-narration.test.mjs passes with its count unchanged (floor 49, suite-integrity.test.js:1571).
- check-narration output over the committed docs/curation/narration is byte-identical before and after (compare the CLI output in the test or by hand in the PR).
- spokenLine.test.ts:
- the FK grade of a fixed passage is within ±0.5 of the hand-computed value;
- the syllable counter matches a 30-word table;
- numericExpressionsIn('between two and three hundred metres') returns 1;
- splitSpokenSentences keeps 'Dr. Smith went to the U.S. in 1990.' as one sentence;
- spokenLineErrors flags a digit, 'according to', 'fascinating' and an opening 'Now,'.
- Syllable counts are within +-1 on a 30-word reference list.
- The FK grade matches a hand-computed value on 3 synthetic paragraphs (+-0.5).
- On the frozen what-engineers Foray (tools/foray/fixtures/frozen/data/forays.json, 40 scripts), scoreVoice returns snapshot-pinned numbers, and over25 equals a count computed independently in the test by whitespace word split.
- No dependency is added, and a floor is added.

**Tests.** From W5-17: Vitest spokenLine.test.ts. Node check-narration.test.mjs, run alone.
From W1-10: node --test tools/foray/voice-metrics.test.mjs, using synthetic sentences plus the frozen fixture.

**Flag.** A pure refactor plus new functions; no runtime behaviour changes.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** W5-17: check-narration.mjs is a curation gate, so move the code verbatim and keep message strings identical. The FK syllable heuristic is approximate, so the 6-9 band is a scorecard number until calibrated. backend/src/copy is governed; tools/foray is not.
W1-10: Syllable and passive-voice detection is heuristic. Report it as a trend metric and calibrate against the founder's listening cards before any gate (R2-14 owns gating). backend TS cannot import a tools .mjs at runtime (types/narration.ts comment), so R2-14's in-pipeline reuse needs the module lifted into backend/src/copy as CJS (cross-workstream need).

#### GV-11 · render-foray.py: render from a candidate, per item, default voice first

- **From:** W6-05
- **Wave:** 2 · **Size:** S · **Depends on:** none
- **Covers:** R1-13, GP-08

**Goal.** Let the central Kokoro renderer take a generated candidate or job snapshot instead of data/forays.json, render only selected items, and guarantee the default voice renders every line in play order before the other voices.

**Design.**

Today render-foray.py reads only data/forays.json (FORAYS_PATH :74; render_all :674; main :874). It loops voices on the outside and lines on the inside (:712-714). Lines are already in play order within a Foray, and af_heart is first in the profile's voices list. The only real gaps are the input source, item selection, and a --voices order that puts a non-default voice first.
1. Add `--candidate PATH`, mutually exclusive with `--forays`.
   - It loads a final candidate, a PartialCandidate or a JobSnapshot (any doc with top-level `id` and `items`).
   - It wraps the doc as {forays:[{id, status:'candidate', items}]}. narration_items() (:178) works unchanged on that shape.
2. Add `--items id1,id2`, which filters to those narration ids. An unknown id is refused before any model load.
3. Add a pure `voice_order(voices, default_voice)` that puts the default voice first. render_all iterates it.
4. Validation runs before the heavy loads in main (:874) and covers the candidate path too.
5. Unchanged: render_key and key_material (:146-172, which carry no ids in the key), the manifest shape, the CPUExecutionProvider session, and is_unchanged (which reads any stamped audio_url on the candidate's items).

**Files edited:**

- tools/narration/render-foray.py
- tools/narration/render-foray.test.mjs
- test/suite-integrity.test.js

**New files:**

- none

**Acceptance:**

- --candidate on a PartialCandidate fixture (camelCase runtimeSec) selects its narration items, the disclosure item included, without reading data/forays.json.
- With --voices am_echo,af_heart, voice_order still renders af_heart first.
- --candidate together with --forays is refused, and --items with an unknown id is refused, both before any model load.
- Existing @drafts and --forays behaviour and keys are unchanged.

**Tests.** render-foray.test.mjs drives the pure half through the real interpreter, with no model, misaki or ffmpeg. It covers candidate selection, voice ordering, the refusals, and key stability. Update the floor.

**Flag.** The new path is reached only with --candidate. The default stays @drafts on data/forays.json.

**Live step.** none

**Founder need.** none

**Risk.** Low. render-foray.py is not governed (only upload-narration.mjs is). It is also edited by W6-06, W6-10, W6-11 and W6-12, which serialize through depends_on.

#### GV-12 · Passage cutter: whole-thought passages with offline anchors and separate edge kinds

- **From:** W3-23
- **Wave:** 2 · **Size:** M · **Depends on:** GV-05
- **Covers:** R1-09, R2-04

**Goal.** Cut each transcript into whole-thought passages using the boundary and anchor rules sourcing uses. The dense arm, the shortlist and the R2-05 clean-cut work then all have stored passages.

**Design.**

1. tapeExtent.ts: export cueShape (:509), nearestStartBoundary (:563) and nearestEndBoundary (:578). Behaviour is unchanged.
2. New backend/src/generation/passageCutter.ts (pure; generation/ write rule respected).
   Constants:
   - PASSAGE_INDEX_VERSION = 1
   - PASSAGE_TARGET_MIN_SEC = 90
   - PASSAGE_TARGET_MAX_SEC = 180
   - PASSAGE_MAX_SEC = 240
   cutPassages({show_id, guid}, cues), where cues are already filtered by W3-04's cuesFromBodyJson:
   - Build indexCues and cueShape.
   - Walk forward: once a passage covers at least TARGET_MIN, close it at the first cue whose end is a 'turn' or 'sentence' boundary before TARGET_MAX; otherwise close it at MAX_SEC with endBoundary 'cue'.
   - Passages tile the episode and never overlap.
   - Each passage carries:
     - id = the first 16 hex of sha1(show_id|guid|startSec|endSec)
     - firstCue, lastCue, startSec, endSec
     - startBoundary and endBoundary, kept separately for R2-05
     - startAnchor and endAnchor from mintStartAnchor/mintEndAnchor (transcriptArchiveLookup.ts:1363,1376) over the edge cues' canonical words, with the same spill rule as startAnchorFor/endAnchorFor (:1325-1345); export those two helpers
     - text from transcriptArchiveLookup.cueWindowText (:1494, strict edges)
     - indexVersion
3. indexBodies (W3-04) gains --passages-out <jsonl>. For each streamed body it appends cutPassages(...) rows keyed by the ARCHIVE guid that the row maps to at end-show (buffered per show), so passage guids match archive entries.
Anchor rule note: anchors use today's content-word rule. If R2-06's distinctiveness rule lands later, bump PASSAGE_INDEX_VERSION and re-cut.

**Files edited:**

- backend/src/generation/tapeExtent.ts
- backend/src/generation/transcriptArchiveLookup.ts
- backend/src/cli/indexBodies.ts
- test/suite-integrity.test.js
- backend/test/indexBodies.test.ts

**New files:**

- backend/src/generation/passageCutter.ts
- backend/test/passageCutter.test.ts

**Acceptance:**

- Passages tile each episode with no gap or overlap. Every passage except an episode's last is within [TARGET_MIN, MAX_SEC].
- Each anchor is found by phraseIsInWindow (types/anchorText.ts) inside its passage text.
- Ids are deterministic across runs, and passage guids equal archive guids even when the body's own guid differs.
- startBoundary and endBoundary are reported independently.
- The tapeExtent and anchorTextParity suites pass unchanged.

**Tests.** vitest: `npx vitest run test/passageCutter.test.ts` with synthetic cues covering speaker turns, sentence ends, pauses, a letter-spaced cue and a 30-minute monologue with no boundary. Extend test/indexBodies.test.ts with a --passages-out case. Add floors.

**Flag.** None: no stage calls it.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed. At about 15 chars/s, a 90-180 s passage is roughly 340-680 bge tokens, over the 512-token limit for many passages. W3-07 therefore embeds sub-chunks rather than truncating.

### Wave 3

#### GV-13 · ChatProvider contract, call context and OpenAI-compatible client (non-streaming) for LiteLLM/SGLang/llama.cpp

- **From:** W2-01
- **Wave:** 3 · **Size:** M · **Depends on:** GV-07
- **Covers:** HW-12, GP-06

**Goal.** Give generation a provider-neutral way to call an OpenAI-compatible endpoint: LiteLLM on the Spark at :4000, which fronts SGLang and the second box's llama-server. It is built on Node's global fetch with no new dependency, so later cards can move stages off anthropicCall.ts:22 (createMessage, Anthropic SDK, MessageCreateParamsNonStreaming). Nothing uses it yet.

**Design.**

INTEGRATION NOTE: CallContext and withCallContext come from runLog.ts (GV-01), which also carries priority and lane; there is no chat/callContext.ts. The CallObserver hook is replaced by a direct runLog.recordModelCall (GV-07) per call (chat/openAICompatProvider.ts is pre-listed in PROVIDER_CALL_SITES). Because the chat/ modules live in a subfolder, this card makes promptNoPersistence.test.ts scan generation/** recursively (GV-19 does the same for the anthropicCall guard).

New module backend/src/generation/chat/ChatProvider.ts holds the types only.
- ChatMessage {role:'system'|'user'|'assistant'; content:string}.
- ResponseFormat = {type:'json_schema'; name; schema:object; strict:boolean} | {type:'json_object'}.
- ChatRequest {model; messages; maxTokens; responseFormat?; temperature?; topP?; stop?; thinking?:boolean; priority?:number; extraBody?; label; signal?; logprobs?:{top:number}}. thinking defaults to false, which sends body.chat_template_kwargs={enable_thinking:false}, because the Spark runs --reasoning-parser qwen3.
- ChatResponse {text; finishReason:'stop'|'length'|'content_filter'|'other'; usage:{promptTokens|null, completionTokens|null, cachedTokens|null, reasoningTokens|null}; model|null; requestId|null; servedBy|null; timing:{startedAt, firstByteAt|null, endedAt}; logprobs?}.
- ChatProviderError extends Error {kind:'http'|'timeout'|'network'|'malformed'|'aborted'; status?; partialText?}. The message is a fixed reason such as 'http_<status>' and never carries the key or the upstream body text.
- interface ChatProvider {readonly name; complete(req):Promise<ChatResponse>; stream?(req):AsyncIterable<ChatStreamEvent>}. stream is implemented in W2-02.
- SUPERSEDED: no CallObserver. The provider calls runLog.recordModelCall once per call, on success or failure, with {label, lane?, model, startedAt, firstByteAt, endedAt, queueMs|null, usage, finishReason, requestId, servedBy, error?:{kind,status}}; recordModelCall merges currentCallContext() (GV-07).

SUPERSEDED (decision 3): no chat/callContext.ts and no test/callContext.test.ts are built. CallContext, withCallContext and currentCallContext come from runLog.ts (GV-01), which already carries stage, act, seam, attempt, priority and lane.

New module backend/src/generation/chat/openAICompatProvider.ts defines OpenAICompatChatProvider({baseUrl, apiKey, fetchImpl=globalThis.fetch, timeoutMs=120000, now=Date.now}).
- complete() POSTs to `${baseUrl}/v1/chat/completions` with a Bearer key. The body is {model, messages, max_tokens, temperature, top_p, stop, response_format (OpenAI {type:'json_schema', json_schema:{name, schema, strict}}), chat_template_kwargs, priority, logprobs/top_logprobs, ...extraBody}.
- It reads choices[0].message.content and ignores reasoning_content.
- reasoningTokens comes from usage.completion_tokens_details.reasoning_tokens. cachedTokens comes from usage.prompt_tokens_details.cached_tokens and is null, never 0, when absent.
- finish_reason 'length' maps to 'length'.
- requestId comes from x-request-id or x-litellm-call-id. servedBy comes from x-litellm-model-id, unverified, so it stays null when absent.
- Timeout uses AbortController. There are no retries. firstByteAt is the time the headers arrived.

New test helper backend/test/helpers/fakeChatProvider.ts: scriptedProvider({complete: replies | (req)=>reply}). It records every request. W2-02 extends it with stream scripts. It lives here so W2-04/W2-06/W2-07/W2-12 do not depend on the streaming card.

**Files edited:**

- test/suite-integrity.test.js
- backend/test/promptNoPersistence.test.ts

**New files:**

- backend/src/generation/chat/ChatProvider.ts
- backend/src/generation/chat/openAICompatProvider.ts
- backend/test/openAICompatProvider.test.ts
- backend/test/helpers/fakeFetch.ts
- backend/test/helpers/fakeChatProvider.ts
- backend/test/fixtures/openai/chat-stop.json
- backend/test/fixtures/openai/chat-length.json
- backend/test/fixtures/openai/chat-cached-reasoning.json
- backend/test/fixtures/openai/chat-malformed.json

**Acceptance:**

- Against synthetic fixtures, complete() returns text, finishReason, usage, requestId and servedBy. cachedTokens is null when prompt_tokens_details is absent and a number when it is present.
- The request body carries chat_template_kwargs.enable_thinking=false by default, and response_format in OpenAI json_schema shape when one is given. The key appears only in the Authorization header.
- 401, 429 and 503 become kind 'http' with the status, and the message contains neither the key nor the body text. A hung fetch becomes 'timeout' after timeoutMs. A non-JSON or choice-less body becomes 'malformed'.
- recordModelCall is invoked exactly once per call, on success or failure, with the merged currentCallContext().
- A grep test shows no module outside generation/chat/ imports openAICompatProvider.
- Fixtures hold synthetic text only.
- New suites are floored in BACKEND_FLOORS.
- promptNoPersistence.test.ts scans generation/** recursively and fails on a planted fs.writeFileSync in a chat/ file.

**Tests.** Run from backend/, one at a time: `npx vitest run test/openAICompatProvider.test.ts` and `npx vitest run test/promptNoPersistence.test.ts`.
- fakeFetch replays fixture bodies, captures the body and headers, and simulates a hang with fake timers.
- Context isolation across concurrent async chains is already covered by runLog.test.ts (GV-01); openAICompatProvider.test.ts asserts the recorded CallRecord carries the context set by an enclosing withCallContext.

**Flag.** Inert: a new module with no caller.

**Live step.** Capture one non-streaming reply each from local-heavy and local-worker through LiteLLM, using a neutral 'reply {"ok":true}' prompt. Check:
- the usage field names;
- whether x-litellm-model-id is present;
- whether chat_template_kwargs survives drop_params:True, on both SGLang and llama-server;
- whether reasoning_content appears.
Commit the sanitized bodies as fixtures/openai/recorded-*.json.

**Founder need.** founder-approved label (orchestrator applies); plus LiteLLM virtual key for Foray (#1163), for the live capture only.

**Risk.** backend/src is a governed path (tools/ci/path-policy.mjs:93). If LiteLLM drops chat_template_kwargs, Qwen thinks and inflates its output. The fallback is a '/no_think' system line, chosen only after the capture.

#### GV-15 · Run configuration foundation: call-time flag readers, pipeline flags, gate config, checkpoint variant at both fingerprint call sites

- **From:** W4-01, W5-02, W3-16
- **Wave:** 3 · **Size:** M · **Depends on:** none
- **Covers:** R1-01, GP-03

**Goal.** Give every later card one flag surface that defaults to today's behaviour (pipeline flags, gate flags, retrieval flags), and one checkpoint variant that keeps banked runs from resuming across modes. The pinned measure of today's serial-call chain (critical-path probe) was split out into GV-123 (wave 14) so this foundation card stays small.

**Design.**

INTEGRATION NOTE (merged W4-01 + W5-02 + the flag-reader half of W3-16). Three workstreams each proposed a per-run flag module; they become one card so runPipeline.ts and generateForays.ts are edited once.
- backend/src/generation/generationFlags.ts (W3-16 item 1): readEnumFlag(name, values, fallback) and readNumberFlag(name, schema, fallback), called at use time (not at import) so tests can set process.env per case; a malformed value throws naming only the variable (env.ts readBoundedNumber convention, env.ts:170). Every W3 retrieval flag, pipelineFlags and the gateConfig table are built on these readers, and none of them is added to config/env.ts (the provider and budget cards edit env.ts).
- pipelineFlags.ts follows W4-01 below, with one change: provider choices are NOT flags. clarityProvider is dropped; which service answers a stage (Jev clarity, Qwen spine, Jev verifier) is chosen only through the stage routing table (GV-03). The FORAY_FAST_PATH umbrella sets behaviour flags only.
- SPLIT: items 4 and 5 below (criticalPath.ts, callLog.ts instrumentDeps, backend/test/helpers/recordingDeps.ts, criticalPath.test.ts and the stub baseline-chain snapshot) moved to GV-123 (wave 14). The critical path has ONE source: builder-level spans from callLog.ts instrumentDeps (production code, provider-independent, so scripted and fake providers produce spans offline). GV-117 wires instrumentDeps into runForayPipeline. CallRecords (GV-07, GV-13, GV-20) stay the source of per-call speed numbers (MT-04..MT-07), not of the critical path.
- Checkpoint variant at BOTH fingerprint call sites. generateForays.ts builds its FileCheckpointStore with its own fingerprint (backend/src/cli/generateForays.ts:590-593), and FileCheckpointStore.save keeps the existing stages only when the file's fingerprint equals the STORE fingerprint (backend/src/cli/checkpointStore.ts:63-67). If only runPipeline.ts:920 carried the variant, a flag-on run could never resume its own stages (the session fingerprint would differ from the file's), and flag-on and classic stages would be merged into one file that a later classic run resumes. So generateOneCandidate calls readPipelineFlags() (merged with the CLI --fast-path) once, passes checkpointVariant(flags) into the checkpointFingerprint call at generateForays.ts:592, and hands the same merged flags to runForayPipeline through options.flags, so runPipeline.ts:920 computes the identical fingerprint. GV-55 later joins the local routing into this same variant at both sites.
- gateConfig.ts follows W5-02 below (empty table; each gate card adds its own key, env var, default and test). W5-02's merge-order list is superseded by this roadmap's wave table.
- RunPipelineOptions gains flags and gates; the report row carries both resolved objects.

--- From W4-01 ---
1. New module backend/src/generation/pipelineFlags.ts.
   - PipelineFlags fields (clarityProvider is DROPPED per the integration note): fastPath; foldSpineCopy; foldDeepen ('off'|'short'|'all'); perActPipeline; narrationOrder ('parallel'|'sequential'); writerStream; roundPolicy ('default'|'timed'); tierRuntimeCap; tierFitGate; spineBestOf (1|2); spineSeedFloorReasksOnTimedPath (number).
   - readPipelineFlags(env = process.env). FORAY_FAST_PATH=1 sets the fast-path defaults (the Jev clarity check is a routing choice, FORAY_STAGE_UNDERSTAND_CLARITY=jev, not a flag): foldSpineCopy, foldDeepen 'short', perActPipeline, sequential, writerStream, timed, tierRuntimeCap, and 0 seed-floor re-asks. spineBestOf stays 1.
   - Each field has its own env var, and it overrides the umbrella: FORAY_SPINE_FOLD_COPY, FORAY_SPINE_FOLD_DEEPEN, FORAY_PER_ACT_PIPELINE, FORAY_NARRATION_ORDER, FORAY_WRITER_STREAM, FORAY_ROUND_POLICY, FORAY_TIER_RUNTIME_CAP, FORAY_GATE_TIER_FIT, FORAY_SPINE_BEST_OF.
   - A malformed value throws an error that names the variable and never its value. This is the convention of narrationActConcurrency (writeNarration.ts:271) and spineStructuralReasks (buildSpine.ts:62).
   - export checkpointVariant(flags): string | undefined. It is a canonical string built only from the flags that change what a banked stage holds (foldSpineCopy, effective foldDeepen, perActPipeline). It returns undefined when all of them are off.
2. RunPipelineOptions (runPipeline.ts:247) gains `flags?: Partial<PipelineFlags>`, merged over readPipelineFlags() once at the top of runForayPipeline (runPipeline.ts:898). The merged flags are passed to the create*() defaults (runPipeline.ts:992-999), so a factory never re-reads env behind an options override.
3. checkpointFingerprint (checkpoint.ts:130) gains an optional `variant`. Both callers pass checkpointVariant(flags) from the same merged flags: runPipeline.ts:920 and generateForays.ts:592 (see the integration note).
   - With no variant the hashed input string is byte-identical to today, so classic runs keep their hash.
   - Any semantics-changing flag combination gets its own fingerprint, so banked runs never resume across modes. This replaces any CHECKPOINT_VERSION bump in later W4 cards.
4. MOVED TO GV-123. New module backend/src/generation/criticalPath.ts.
   - serialCallChain(calls: {id; stage; startMs; endMs}[]): {length; chain: string[]}. It returns the longest chain in which each call starts at or after the previous one ended (MT-06 'calls in series'), computed by DP over calls sorted by endMs.
   - callsStartedBefore(calls, tMs).
   - Both are pure, so the timers workstream's CallRecords can be fed straight in.
5. MOVED TO GV-123. New module backend/src/generation/callLog.ts (src, not test, because W4-17 uses it in production).
   - instrumentDeps(deps, clock): wraps each builder method in RunPipelineDeps: understander.assessClarity/extractIntent, researcher.research/retrievePassages, spineBuilder.buildSpine, deepenBuilder.deepenAct, narrationWriter.writeAct and writeActStream when present, narrationVerifier.verifyAct, continuityBuilder.smoothSeam.
   - Each wrapper records {id, stage, act, startMs, endMs} in an in-memory array. It writes nothing to disk, so promptNoPersistence.test.ts still passes.
   - backend/test/helpers/recordingDeps.ts reuses it with a fake clock that advances by a scripted latency per stage.
6. generateForays.ts parseArgs (:127) gains `--fast-path`, which sets flags.fastPath.

--- From W5-02 (gate configuration) ---
New module backend/src/generation/gateConfig.ts.
- GateConfig starts with NO feature keys. Each later card adds its own key, env var, default and test in the same PR, so no flag ever exists without behaviour behind it and this card does not have to track the others. Planned keys, owned by their cards:
  - clipJudge (W5-03/04/05)
  - tapeGate (W5-06)
  - specifics (W5-10)
  - sentencePolicy (W5-11)
  - partialGate (W5-12a): DROPPED, per-act servability is always computed with no flag (GV-21)
  - unverifiedSeamPolicy (W5-12b)
  - claimOnlyOpening and cleanCutGate (W5-13)
  - pauseSnap (W5-14b)
  - attribution (W5-15)
  - frameVerify (W5-16)
  - voice and readingGradeBand (W5-18)
  - judge thresholds per judge (W5-07/W5-19)
- readGateConfig(source = process.env) is pure. It uses a declarative table {key, env, parse, default}, and a malformed value throws an error naming the variable, following env.ts readBoundedNumber (:170, CH2-04).
- RunPipelineOptions (runPipeline.ts:247) gains gates?: Partial<GateConfig>, merged over readGateConfig() once per run. This card edits only RunPipelineOptions.gates and the report row. Each gate card threads its own key into WriteActOptions, SourceBeatsOptions or the stitcher options in the PR that first needs it (GV-34, GV-79, GV-104, GV-106 to GV-121 already list those files), so no stage module reads process.env and this card does not touch writeAct.ts, sourceBeats.ts, stitchForay.ts or writeNarration.ts.
- generateForays.ts adds the resolved config to each report.json entry (ReportEntry :433) as `gates`.
- A docs section in docs/curation/generation-architecture.md lists each flag, its default and its owning card. Each card appends its own row.
- Merge order. Most cards edit runPipeline.ts, veracityMetrics.ts (VeracityMetrics :819, buildVeracityMetrics :927) and writeAct.ts validateSeam (:865). These edits are additive but will conflict on rebase, so land in this order: W5-02, W5-17, W5-01, W5-12a, W5-13, W5-10, W5-03, W5-06, W5-18, W5-15, W5-08, W5-12b, W5-09, W5-11, W5-16, W5-04, W5-05, W5-14b, W5-07, W5-19.

**Files edited:**

- backend/src/generation/runPipeline.ts
- backend/src/generation/checkpoint.ts
- backend/src/cli/generateForays.ts
- test/suite-integrity.test.js
- docs/curation/generation-architecture.md
- backend/test/generateForays.test.ts

**New files:**

- backend/src/generation/pipelineFlags.ts
- backend/test/pipelineFlags.test.ts
- backend/src/generation/gateConfig.ts
- backend/test/gateConfig.test.ts
- backend/src/generation/generationFlags.ts
- backend/test/generationFlags.test.ts

**Acceptance:**

- With no env set and no options.flags, every existing runPipeline*.test.ts and generateForays*.test.ts passes unchanged, and checkpointFingerprint returns the same hash as before.
- readPipelineFlags: FORAY_FAST_PATH=1 yields the listed defaults, each per-field variable overrides the umbrella, and a malformed value throws an error naming the variable and not the value.
- checkpointVariant is undefined when every semantics-changing flag is off, and gives a different value for each combination of foldSpineCopy, foldDeepen and perActPipeline.
- The FileCheckpointStore fingerprint (generateForays.ts:592) and the session fingerprint (runPipeline.ts:920) are equal for every flag combination (asserted in generateForays.test.ts with stub builders).
- (a) A flag-on run (FORAY_SPINE_FOLD_COPY=1) killed after its spine stage resumes its own banked stages on the next flag-on run: the spine builder is not called again.
- (b) A classic run never loads a stage banked by a flag-on run for the same prompt, and a flag-on run never loads a classic stage: in both directions the second run starts from an empty stage set, and the file afterwards holds only the second run's mode.
- BACKEND_FLOORS in test/suite-integrity.test.js has entries for the three new suites.
- readGateConfig({}) returns the empty-default config, and the table API rejects a duplicate env name.
- A table entry given a malformed value throws an error that names the variable (tested with a test-only entry).
- runPipeline.test.ts passes unchanged with no gates option, and generateForays.test.ts asserts that the report row carries a `gates` object.
- generationFlags readers throw on a malformed value naming only the variable, and read process.env at call time (a test sets the variable after import).

**Tests.** From W4-01: vitest, one file at a time: backend/test/pipelineFlags.test.ts (env matrix, malformed values, checkpointVariant). The criticalPath suite moved to GV-123.
From W5-02: Vitest: gateConfig.test.ts, plus one assertion in generateForays.test.ts.
Checkpoint variant: generateForays.test.ts gains the fingerprint-equality case and the two resume cases (a) and (b) above, using FileCheckpointStore in a temp dir and stub builders.
New: backend/test/generationFlags.test.ts.

**Flag.** Introduces FORAY_FAST_PATH and the per-field pipeline flags (all default off) and the gate-config mechanism (no gate keys yet). The checkpoint variant is set only when a semantics-changing flag is on.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** W4-01: Governed path (backend/src), so the orchestrator must apply the founder-approved label. Later cards must read flags only from this module, or the umbrella and the per-field overrides will drift. runPipeline.ts is touched by most W4 cards, so they land serially in depends_on order.
W5-02: Flags multiply the paths to test, so every later card tests both its default and its new mode. A resumed checkpoint banked under another gate mode keeps that mode's output. Do NOT add gates to the checkpoint fingerprint (checkpoint.ts), or every banked run is invalidated on a flag flip. Document this in the gate docs.
W3-16: Governed. Under 'null', Carry and Patch pages with requiresEvidence degrade through the existing F-60/F-77 path until dossiers (W3-21) exist. That is the adopted OQ-04 default.

#### GV-16 · Retrieval server core: resident episode index with exact BM25 parity, scopes, episode manifest, local cue reads, archive endpoint

- **From:** W3-08
- **Wave:** 3 · **Size:** M · **Depends on:** GV-05, GV-09
- **Covers:** R1-09, GP-09

**Goal.** Load the index once into a long-lived process on the box that holds the corpus, so no run pays the per-process index load or needs local transcripts.

**Design.**

New backend/src/cli/retrievalServer.ts. It is backend code so it reuses FileTranscriptTextIndex and the lineage helpers byte for byte. It uses node:http only and is not one of the no-fetch-checked files.

At boot:
- Load the archive with loadTranscriptArchive(): committed digests plus data-local corpus-digest.json.
- Build a ManifestBodySource (new backend/src/generation/manifestBodySource.ts, read-only) implementing TranscriptBodySource.
  - bodyStat(entry) maps an archive entry to a manifest row (episodes.jsonl from W3-05) with W3-04's locateInListing over that show's fileNames, and answers from the row. Caches written by indexBodies are then fresh by cacheIsFresh (transcriptTextIndex.ts:400-414) with no body on disk.
  - getCues/readCuesUncached delegate to an injected CueStore. The default is FileTranscriptCueProvider over a local normalized dir (the 5,041 bodies copied over in W3-22); W3-24 adds R2.
  - A stale cache is logged as an error and rebuilt only if the CueStore can serve the bodies.
- new FileTranscriptTextIndex({archive, bodies}), then warmShow for every show WITHOUT forget, so it stays resident. --shows limits the set on small machines.

HTTP JSON API. Auth is Bearer FORAY_RETRIEVAL_TOKEN, required unless bound to 127.0.0.1, which is the default bind.
- POST /v1/scopes {episodes:[[show_id,guid]...] | 'all'} returns {scopeId}. Held in memory with a 2 h TTL. Lineage is decided client-side by familyGateAllows/nodesForArchiveEntry, the same code sourcing uses.
- POST /v1/search {scopeId, queries:[{text, limit}]} returns per query {candidates:[{show_id, guid, score, matchedTerms, rank}], idf}.
  - It calls new exported searchWithIdf(text, {limit, isUsable}) in transcriptTextIndex.ts, which returns {candidates, idf}. idf is present even with zero hits, because search() returns [] at :287 and loses it. search() delegates to it, so behaviour is unchanged.
- GET /v1/episodes returns manifest rows mapped to archive keys [{show_id, guid, size, mtimeMs, transcript_source}].
- GET /v1/cues?show_id&guid returns {cues, transcript_source}, or 404.
- GET /v1/archive returns the archive rows exactly as loaded.
- GET /healthz returns {indexVersion, shows, episodes, archiveGeneratedAt}.
- POST /v1/reload re-reads the archive and caches.

Privacy (§9.4): request bodies carry beat claims. Nothing logs or persists query text; only counts, latencies and query hashes are logged. Responses are gzip-encoded.

Injection: CueStore and the logger are injected. main() is the only place that builds real dependencies.

Launchers:
- tools/passage-index/serve.mjs, using the warm-transcript-index.mjs tsx pattern.
- tools/passage-index/pull-archive.mjs: GET /v1/archive and write data-local/transcripts/corpus-digest.json atomically on the generation box, so every backend reader (topic supply, sourcing, findDigestForItem, deriveItemId/disambiguateItemIds) sees the server's rows.

**Files edited:**

- backend/src/generation/transcriptTextIndex.ts
- tools/passage-index/README.md
- test/suite-integrity.test.js

**New files:**

- backend/src/cli/retrievalServer.ts
- backend/src/generation/manifestBodySource.ts
- backend/test/retrievalServer.test.ts
- backend/test/manifestBodySource.test.ts
- tools/passage-index/serve.mjs
- tools/passage-index/pull-archive.mjs
- tools/passage-index/pull-archive.test.mjs

**Acceptance:**

- Parity: for a synthetic corpus, each /v1/search answer equals FileTranscriptTextIndex.search on the same archive and isUsable, with the same order, scores and idf. An 'all' scope equals search with no isUsable.
- searchWithIdf returns the idf map with zero hits, and search() output is unchanged (existing transcriptTextIndex suite green).
- ManifestBodySource maps a Becker-style guid-mismatched row to its manifest row, and caches built by W3-04 are judged fresh with no body on disk.
- Without a token the server refuses a non-loopback bind. No query text appears in captured logs.
- pull-archive writes a digest that loadTranscriptArchive reads back, yielding the same disambiguated item ids as the server's archive.

**Tests.** vitest:
- `npx vitest run test/retrievalServer.test.ts`: ephemeral port, tmp index built with indexBodies, in-memory CueStore, captured logger
- `npx vitest run test/manifestBodySource.test.ts`
node:test tools/passage-index/pull-archive.test.mjs with a fake HTTP server. Add floors. node:sqlite is never imported in backend tests.

**Flag.** An inert new process. Nothing in the pipeline talks to it until W3-11 sets FORAY_RETRIEVAL_URL.

**Live step.** Start it on the founder PC over the existing 22-show corpus and compare /v1/search with a local run for 10 claims from backend/test/fixtures/run2-deepen-2026-09-09.json. Measure resident RSS.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed. Resident memory for every show's postings is unmeasured: fine on the Spark, so the laptop must use --shows. An HTTP surface in backend/src/cli is bound to localhost by default and needs the token otherwise.

#### GV-17 · Bench: per-call speed summary (MT-04..MT-08, MT-10, MT-12) from the runlog, with a backend parity test

- **From:** W1-04
- **Wave:** 3 · **Size:** M · **Depends on:** GV-07, GV-08
- **Covers:** R1-14, MT-04, MT-05, MT-06, MT-07, MT-08, MT-09, MT-10, MT-12, GP-01, GP-28

**Goal.** Turn each prompt's runlog into the speed scorecard: tokens by stage, calls in series, repeat work, queue, TTFT, cache share, prose tok/s, code time, render rate and unit spend. The reader lives in tools/, so it can change without the founder label.

**Design.**

INTEGRATION NOTE: seriesDepth (MT-06) is the same longest-serial-chain DP as criticalPath.serialCallChain. serialCallChain now lands later, in GV-123 (wave 14), so this card's parity test does NOT import it; GV-123's criticalPath.test.ts asserts that serialCallChain and runlog.mjs's seriesDepth agree on this card's synthetic runlog fixture (tools/generation-bench/fixtures/runlog-synth), the same way runLogBenchParity.test.ts imports the bench module.

New module tools/generation-bench/runlog.mjs.

`readRunLog(file)` requires the runlog/1 header.

`summarizeRunLog(events)` returns:
- `perStage[stage]` {calls, promptTokens, cachedTokens, outputTokens, outputBudget, overBudget, ms, p50CallMs}
- `outputTokens` and `outputTokensByStage` (MT-05)
- `seriesDepth` (MT-06): the longest chain of calls where each starts at or after the previous one's endMs. Sort by startMs, then an O(n^2) DP.
- `seriesBeforeFirstReady`: the same chain over calls ending before the first ReadyEvent; null without ready events.
- `repeatWork` (MT-07) {jsonReasks, spineReasks (structural + seed-floor), extraRounds (writer calls with attempt>1), continuations, parseFailures}
- MT-04: `queueP50Ms`, `ttftP50Ms` and `cachedShare` = cachedTokens/promptTokens. Each is null when no record carries the field.
- MT-12 `proseTokPerSec` per stage: outputTokens/((ms-ttftMs)/1000) when ttftMs is known. Otherwise `e2eTokPerSec`, labelled end-to-end and never mixed with the decode rate.
- `codeMsByStage` (MT-08), from CodeSpanAggregate events
- `renderRealtime` and `firstRenderMs` (MT-09), from RenderSpans
- `unitSpend` (MT-10), from MeterEvents

run.mjs:
- rowsForReport resolves entry.runLog relative to the report's directory.
- New 'detail' columns (W1-01 grouping): out_tok, series, reasks, queue_p50, ttft_p50, cached, prose_tps, code_s, render_x, spark_s. All follow rule 1 (absent, never 0).
- jsonlLine adds `calls_by_stage` as a meta object, not a column.

Parity: backend/test/runLogBenchParity.test.ts runs a stub pipeline under runWithRunLog with test-local createMessage-calling builders (W1-03 pattern). It feeds RunLog.toJsonl() to summarizeRunLog through a dynamic import of the .mjs, as actNarration.test.ts already imports check-narration.mjs, and asserts that the counts match the log. This pins the TS emitter and the mjs reader to one schema.

**Files edited:**

- tools/generation-bench/run.mjs
- tools/generation-bench/run.test.mjs
- docs/curation/generation-kpis.md
- test/suite-integrity.test.js

**New files:**

- tools/generation-bench/runlog.mjs
- tools/generation-bench/runlog.test.mjs
- tools/generation-bench/fixtures/runlog-synth/report.json
- tools/generation-bench/fixtures/runlog-synth/runlogs/synth.1.runlog.jsonl
- backend/test/runLogBenchParity.test.ts

**Acceptance:**

- On the synthetic runlog (3 serial calls, then 4 parallel writer calls, then 1 stitch call), seriesDepth is 5 and repeatWork counts 1 JSON re-ask and 2 extra rounds.
- prose_tps uses ttft when it is present and is labelled e2e otherwise.
- out-4 and out-9 rows (no runLog) print every new column as —, and the committed KPI markdown table is unchanged (detail group).
- The parity test passes: summarizeRunLog's call count and output tokens equal the RunLog's own totals for a stub run.
- The KPI doc legend names each new column and its MT id.
- New suites have floors (FLOORS and BACKEND_FLOORS).

**Tests.** node --test tools/generation-bench/runlog.test.mjs; node --test tools/generation-bench/run.test.mjs; cd backend && npx vitest run test/runLogBenchParity.test.ts. Fixtures are synthetic: no prompt or transcript text.

**Flag.** none; read-only reporting

**Live step.** none

**Founder need.** none (backend/test/ and tools/ are allowlisted; the card touches no DENIED_PREFIXES path)

**Risk.** The parity test's dynamic import of a tools/ .mjs fails under vitest on a Windows path that contains a space (the founder's checkout). It passes in CI, as the existing actNarration import does. Detail columns keep the committed markdown table narrow; W1-15's --headline is the short view. The depends_on on W1-16 is merge order on run.mjs only.

#### GV-18 · SourcingSession: source one act at a time with the Foray-wide ledgers carried forward, and a serialisable state

- **From:** W4-06
- **Wave:** 3 · **Size:** M · **Depends on:** none
- **Covers:** R1-04

**Goal.** Let act 1 be sourced and frozen before acts 2+ are deepened, without changing what sourcing decides. Make the carried state bankable so a per-act checkpoint can resume mid-Foray.

**Design.**

1. sourceBeats.ts: extract the body of sourceBeats (:350-553) into `export class SourcingSession`.
   - constructor(options) builds SourcingState and the result arrays exactly as :351-421 does.
   - sourceAct(act: DeepenedAct, actIndex: number): SourcedAct holds the per-act body of the map at :424-541. Acts must arrive in ascending order, or it throws.
   - result(deepenedActs) runs validateSourcing over the acts sourced so far and returns SourceBeatsResult.
2. sourceBeats(deepenedActs, options) becomes `const s = new SourcingSession(options); deepenedActs.forEach((a, i) => s.sourceAct(a, i)); return s.result(deepenedActs)`. Order and state are the same, so behaviour is identical.
3. Why act i stays frozen when act i+1 is sourced. The ledgers are not strictly append-only: placeTape's `replacing` branch (:1124) rewrites an earlier placement when mergeIntoClip grows a clip. But a merge is allowed only into the last clip of the SAME act (mergeableInto :1429-1432 checks last.actIndex === this.act.index). So nothing in act i's SourcedAct, newSegments rows or tapeRelevance rows can change once act i+1 starts. RQ-08's freeze holds by construction, and the test pins it.
4. exportState(): SourcingSnapshot is a JSON-safe copy of every ledger: usedSegmentIds, lastStart/lastEndByItem, usedCountByItem, placedTapeCount, placedDurations, placedSecByItem, longestSecByItem, placed, mintedIds, newSegments, newSegmentSources, transcriptionQueueCandidates, tapeRelevance, sourcingTrace and the acts sourced so far.
   - lastMintedClip is exported as null. It is only mergeable within its own act, so dropping it at an act boundary changes nothing.
   - static SourcingSession.resume(options, snapshot) rebuilds the session.
5. No fetch or http goes into this file, so the structural test at backend/test/sourceBeats.test.ts:308-333 still passes.

**Files edited:**

- backend/src/generation/sourceBeats.ts
- test/suite-integrity.test.js

**New files:**

- backend/test/sourcingSession.test.ts

**Acceptance:**

- Every sourceBeats() call in backend/test/sourceBeats.test.ts, mintDedupe, pastDuration and itemIdCollision passes unchanged.
- On the run2 deepen fixtures, with synthetic cues and a FileTranscriptTextIndex over a tmpdir corpus, act-by-act SourcingSession deep-equals sourceBeats(all acts).
- After act 0 is sourced, sourcing act 1 never changes act 0's SourcedAct, newSegments rows or tapeRelevance rows (deep-frozen comparison).
- exportState after act 0, JSON round-trip, then resume and source act 1 gives the same result as an uninterrupted session.
- Sourcing acts out of order throws.

**Tests.** vitest sourcingSession.test.ts (equivalence, freeze, snapshot round-trip, ordering). The existing sourceBeats suites are untouched.

**Flag.** none. A pure refactor with identical behaviour; the per-act driver (W4-07) is what is flagged.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** sourceBeats.ts is also the retrieval workstream's file (R1-20 Tier2Walk evaluate/judge/accept, R2-16 show-share ledger). Land this mechanical extraction first. Any ledger they add must be included in exportState, or resume breaks; the round-trip test catches a missing field only if their tests use the session.

#### GV-23 · Legacy whisper JSONs: key parser, hash resolver, converter to the normalized body shape, bounded sampler

- **From:** W3-02
- **Wave:** 3 · **Size:** S · **Depends on:** none
- **Covers:** R2-16, GP-22

**Goal.** Make the 7,531 legacy whisper outputs at the bucket root readable without a mirror. Port foray-db's verified mapper rules into tools/ so the stream indexer can convert each object in memory.

**Design.**

Facts from foray-db src/forays_corpus/acquisition/legacy_asr_mapper.py, read with gh:
- The key is `<show-slug>/<title-slug>-<sha1(guid)[:10]>.json`.
- The body is raw faster-whisper output: `meta` plus `segments[{start,end,text,words[]}]`.
- There is no show_id, guid or enclosure, and no sha256 metadata.
- The show slug is the show title slugified ([^a-z0-9]+ to -).

New tools/foraycorpus-export/legacy-whisper.mjs:
- parseLegacyKey(key) returns {key, showSlug, titleSlug, guidSha1_10} or null, using the same regex and the same prefix exclusions.
- guidHashes(guid) returns the 10-hex sha1 prefixes of the raw and trimmed guid.
- resolveLegacyEpisode(legacyKey, candidates[{guid,title}]) returns {status: matched|unmatched|ambiguous, guid, reason}. It matches the hash. A hash hit on two distinct episodes is ambiguous and is never picked. The title slug is used only as a tie-break report, never as a match.
- convertWhisperDoc(doc, {keepWords=false}) returns {cues:[{start_sec,end_sec,text,words?}], asr:{engine, model, detected_language}}. It throws LegacyShapeError('not_a_whisper_doc') when meta or segments are missing, and drops and counts segments with non-finite times. keepWords keeps per-cue words [{text,start,end}]. This is optional and backward compatible, because bodyShapeError (sync-r2.mjs:152) ignores extra fields.
- toNormalizedBody(converted, {show_id, guid}) returns a body with transcript_source 'asr-local', which is in TRANSCRIPT_SOURCES (merge-segments.mjs:119) and TranscriptSourceSchema. It must NEVER set source_url, because FileTranscriptCueProvider.transcriptSource infers 'publisher' from a source_url, which would mislabel ASR as a publisher transcript.
- CLI `node legacy-whisper.mjs sample --n <k>` lists the root, GETs only k legacy objects into data-local/legacy-sample/ (gitignored) and prints a shape report: segment count, words present, last end, language.

Fixtures are synthetic invented sentences, never real transcript text.

**Files edited:**

- tools/foraycorpus-export/README.md
- test/suite-integrity.test.js

**New files:**

- tools/foraycorpus-export/legacy-whisper.mjs
- tools/foraycorpus-export/legacy-whisper.test.mjs
- tools/foraycorpus-export/fixtures/synthetic/legacy-whisper/doc-ok.json
- tools/foraycorpus-export/fixtures/synthetic/legacy-whisper/doc-bad.json

**Acceptance:**

- parseLegacyKey accepts the documented shape and rejects farm keys, probe keys and keys without the 10-hex suffix.
- toNormalizedBody(convertWhisperDoc(fixture)) passes sync-r2 bodyShapeError, carries transcript_source 'asr-local' and has no source_url.
- Words are dropped unless keepWords is set.
- resolveLegacyEpisode returns ambiguous on a double hit and unmatched with a reason on no hit.
- sample against a fake client GETs exactly n objects.

**Tests.** `npm test --prefix tools/foraycorpus-export -- legacy-whisper.test.mjs` with synthetic fixtures and a fake S3 client. Covers the key table, conversion, a bad document, the words toggle, trimmed and untrimmed guid hashes, the three resolve outcomes and the sample GET count. Add a FLOORS entry.

**Flag.** None. This is a new module, and nothing calls it until W3-03 and W3-06.

**Live step.** Run `legacy-whisper.mjs sample --n 20` with the R2 read key. Confirm the meta/segments shape and how many objects carry words[]. Attach the report to #1163.

**Founder need.** The R2 read-only key for the sample.

**Risk.** The shape is verified only by foray-db's 2026-09-24 evidence, which is why the sampler exists. Legacy objects have no sha256, so integrity rests on JSON validity and the etag.

### Wave 4

#### GV-14 · Stage x tier output-token budgets (R1-17) in one table, stamped on every call, with a pure truncation-policy decision for the provider layer

- **From:** W1-07
- **Wave:** 4 · **Size:** S · **Depends on:** GV-07, GV-15
- **Covers:** R1-17, MT-05, GP-02

**Goal.** Put R1-17's output budgets in one config table. Report every call's output against its budget now. Give the provider layer an enforce switch and an explicit truncation decision, so tight caps never become silent hard failures.

**Design.**

New module backend/src/config/outputBudgets.ts.

`BudgetStage`: 'understand.clarity' | 'understand.intent' | 'understand.title' | 'research' | 'retrieval' | 'spine' | 'deepen' | 'narrate.act' | 'narrate.seam1' | 'narrate.verify' | 'continuity'.

`OUTPUT_TOKEN_BUDGETS[stage][tier]` holds R1-17's targets:
- spine: 450 short / 1200 medium / 2400 long (long is a guess, flagged)
- narrate.act: 1200 short (R1-17's streamed act-1 writer). For medium and long, writerActBudget(seamBands) = ceil(sum of band max chars x 0.25 x 1.25) + 20 per seam, using MODE_CHAR_BANDS (types/narration.ts:68), as R1-17's risk asks (size per tier from RQ-12).
- narrate.seam1: 150 (a sub-budget of narrate.act)
- 0 on every tier: narrate.verify (Jev), understand.clarity (Jev), deepen (folded by R1-01), continuity
- Pre-spine stages, outside R1-17's per-Foray sum and noted as removed by R1-02 and OQ-04: understand.intent 300, understand.title 40, research 400, retrieval 0 (off the timed path)

`R1_17_SUM(tier)` = spine + narrate.act + deepen + continuity + narrate.verify. A unit test pins short at 1,650.

Other exports:
- `TRUNCATION_POLICY[stage]`: 'refuse' | 'reask-once-naming-overrun' | 'keep-finished-seams'
- `truncationDecision(stage, {stopReason, attempt})`: a pure function returning what the provider must do
- `budgetStageOf(record)`: maps CallRecord.stage, label and role to a BudgetStage, covering every createMessage label in the Anthropic builders
- `outputBudgetFor(stage, tier, ctx)`
- `outputBudgetMode()`: reads FORAY_OUTPUT_BUDGETS = off|report|enforce (default report) through generationFlags.readEnumFlag (GV-15, decision 5) at call time. No new reader is added to config/env.ts. A bad value throws at first read and names only the variable.
- `BUILDER_MAX_TOKENS`: the builders' current hard caps, moved here as one constant with unchanged values: clarity 400, intent 600, title 120, spine 8000, deepen 4000, continuity 500, verifier 4000. The writer keeps actOutputTokenBudget and its 12000 floor. Nothing reads BUILDER_MAX_TOKENS in this card; GV-25 points the Anthropic and Chat builders at it, and GV-100 adds spineMaxTokens beside it.

runLog.recordModelCall stamps outputBudget and overBudget from the tier in context.

In enforce mode only the provider layer (cross-workstream) passes min(builderCap, budget) as max_tokens and acts on truncationDecision. The Anthropic builders keep their caps, including the 12000 writer floor (AnthropicNarrationWriterBuilder.ts:74) that exists for the 2026-09-13 truncation defect.

**Files edited:**

- backend/src/generation/runLog.ts
- backend/test/runLog.test.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/config/outputBudgets.ts
- backend/test/outputBudgets.test.ts

**Acceptance:**

- Every BudgetStage has a value for short, medium and long.
- R1_17_SUM('short') is 1650.
- writerActBudget on a fixture seam plan matches a hand-computed number.
- budgetStageOf maps every label passed to createMessage in the seven Anthropic builders (a test enumerates them with a source grep).
- truncationDecision returns 'keep-finished-seams' for narrate.act on max_tokens and 'reask-once-naming-overrun' for spine on attempt 1, then 'refuse' on attempt 2.
- An unknown FORAY_OUTPUT_BUDGETS value throws at call time (the test sets it after import), naming the variable and not echoing the value.
- BUILDER_MAX_TOKENS holds exactly the values the builders use today (a test greps each Anthropic builder's max_tokens constant and compares).
- A call recorded under tier short in stage spine with 900 output tokens is stamped outputBudget 450, overBudget true.
- No existing builder's max_tokens changes, because report is the default.

**Tests.** backend vitest: outputBudgets.test.ts (table completeness, sum, bands, label mapping, policy, call-time flag parse, BUILDER_MAX_TOKENS parity); runLog.test.ts (stamping).

**Flag.** FORAY_OUTPUT_BUDGETS=report by default: it records and reports only. 'enforce' takes effect only in the provider layer once that exists.

**Live step.** Tune the table from the first golden-set run's out_tok by stage (W1-04).

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** The budgets are targets for the redesigned pipeline, so every relay run today will show every stage over budget. The legend must say these are targets, not regressions. A wrong label mapping misattributes calls, so the mapping test enumerates every builder's labels.

#### GV-19 · askStructured: one provider-neutral JSON call (meter, constrained output, truncation refusal, one metered re-ask)

- **From:** W2-04
- **Wave:** 4 · **Size:** M · **Depends on:** GV-02, GV-07, GV-13
- **Covers:** R1-18, GP-06, HW-12

**Goal.** Move createMessage's rules (anthropicCall.ts:22-49: record usage, refuse a max_tokens stop before parsing) and the builders' duplicated meter/parse/re-ask pattern (e.g. AnthropicNarrationWriterBuilder.ts:140-194) into one provider-neutral function that always sends a json_schema constraint, so constrained JSON on every JSON call holds by construction.

**Design.**

INTEGRATION NOTE: the recursive guard keeps GV-07's recordModelCall allowlist (PROVIDER_CALL_SITES) in the same test.

New module backend/src/generation/chat/askStructured.ts. It defines its own StructuredTarget, so it does not depend on the routing card:
- StructuredTarget = {providerName, model, structuredOutput:'json_schema'|'json_object'|'none', usdPerMtokIn, usdPerMtokOut, thinking?, temperature?}
- askStructured<T>({provider, target, schemaName, schema, messages, maxTokens, operation, budget:{guard, userId, sessionId}, label}) returns {value, reasked, response}.

Steps:
1. Meter: guard.checkAndRecord({operation, provider: target.providerName, model, estimatedUsd from chars/4 at the target's rates, sessionId}). This is also where R1-19's seconds and Jev caps hook in.
2. Call provider.complete. responseFormat is responseFormatFor(schemaName) for json_schema, {type:'json_object'} for json_object, and absent for none. thinking defaults to false.
3. recordUsage({input_tokens, output_tokens}) via usageTracking.ts.
4. A finishReason of 'length' throws TruncatedReplyError.
5. parseWithRetry(schema, text, label, reask). reask meters again and re-sends messages plus the bad reply plus 'Your previous reply was not valid JSON; reply with the JSON object only.', with the same responseFormat, and sets reasked=true (MT-07).

TruncatedReplyError moves to backend/src/generation/replyErrors.ts. anthropicCall.ts re-exports it, and researchShape.ts:20 imports it from replyErrors.ts, so researchShape no longer imports anthropicCall.

The structural guard at backend/test/anthropicCall.test.ts:111 is extended:
- It scans generation/** recursively; today it reads only the top level, so chat/ would escape.
- recordUsage is allowed only in anthropicCall.ts, usageTracking.ts and chat/askStructured.ts.
- `fetch(` (the bare global, matched as a whole word) is forbidden in generation/** except the modules in GV-07's PROVIDER_CALL_SITES ('anthropicCall.ts', 'chat/openAICompatProvider.ts', 'jevClient.ts'; the Jev client is the FLAT file backend/src/generation/jevClient.ts that GV-20 adds in this same wave, so either merge order keeps the check green) plus 'retrievalClient.ts', pre-listed for GV-29 (wave 5), whose RemoteRetrieval defaults fetchFn to the global fetch. The allowlist is imported from runLog.ts's PROVIDER_CALL_SITES rather than restated, so the two guards cannot drift. There is no jev/ subfolder.
- `.complete(` in chat/** is allowed only in chat/askStructured.ts and chat/openAICompatProvider.ts's own definition; the rule applies to chat/** only.

**Files edited:**

- backend/src/generation/anthropicCall.ts
- backend/src/generation/researchShape.ts
- backend/test/anthropicCall.test.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/chat/askStructured.ts
- backend/src/generation/replyErrors.ts
- backend/test/askStructured.test.ts

**Acceptance:**

- With scriptedProvider, a valid reply takes one call, one guard check and one recordUsage call, and response_format names the schema.
- An invalid first reply causes exactly one metered re-ask with the same responseFormat, and reasked is true.
- A 'length' finish throws TruncatedReplyError before any parse. researchShape's instanceof check matches errors from both the Anthropic and the chat path.
- structuredOutput 'none' sends no response_format and still parses.
- The recursive guard fails on a planted fetch( or recordUsage( in a chat/ file and passes on the branch.
- A budget refusal inside reask propagates on `cause`, as parseWithRetry.ts documents.

**Tests.** Run `npx vitest run test/askStructured.test.ts`, then `npx vitest run test/anthropicCall.test.ts`, raising its floor from 9.

**Flag.** Inert until a Chat* builder calls it (W2-06, W2-07, W2-12).

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** usageTracking.ts stays process-global for now; the per-run collector belongs to the timers workstream. Local rates are $0, so the dollar guard is inert, and the budget workstream's caps must land before W2-15. Governed path.

#### GV-20 · Typed Jev client in TypeScript (noul / choice / score): never throws on transport errors, budget-metered, records every call, with a fake and recorded fixtures

- **From:** W5-01, W2-11
- **Wave:** 4 · **Size:** M · **Depends on:** GV-07
- **Covers:** R1-20, R1-07, R2-03, OQ-05

**Goal.** Give generation one typed, offline-testable way to ask Jev questions. Every judged gate in this workstream depends on it. Foray has no Jev code today; the only clients are Python (hermes-operating-system hooks/jevclient.py) and JS (Hermes quen/lib/jev.mjs).

**Design.**

INTEGRATION NOTE (merged W5-01 + W2-11; both wrote the TypeScript Jev client). W5-01's design wins: flat files in backend/src/generation/ (the source scans are non-recursive: promptNoPersistence.test.ts:48 and anthropicCall.test.ts:111), metered through BudgetGuard, pooled. Carried over from W2-11: the result's modelMismatch flag; choice criteria capped at 255 options and score levels 2-10, validated like jevclient.py _parse_answers; the onCall payload also carries category. Env names follow W5-01 (JEV_API_KEY, JEV_KEY_FILE, FORAY_JEV_BASE_URL, FORAY_JEV_MODEL, FORAY_JEV_BUDGET_MS). Each call also records a CallRecord through runLog.recordModelCall (provider 'jev', role 'judge'); jevClient.ts is already in GV-07's PROVIDER_CALL_SITES allowlist. Per-Foray Jev-call caps are wired by GV-90; the Qwen fallback by GV-47.

--- From W5-01 ---
FLAT files in backend/src/generation/ (jevTypes.ts, jevClient.ts), not a jev/ subfolder. The existing source scans (backend/test/promptNoPersistence.test.ts:48 and backend/test/anthropicCall.test.ts:111) use non-recursive readdirSync, so a subfolder would escape both.

Wire contract, port of jevclient.py (checked against hermes-operating-system@64b63f53 :29-43, :431-530):
- Request: POST {base}/v1/systemone, body {state, model, questions}, header Authorization: Bearer. Read back x-typesafe-request-id.
- Questions (jevTypes.ts):
  - noul: {type:'noul', instructions, criteria:{true:string,false:string}}
  - choice: {type:'choice', instructions, criteria: Record<optionId,{what:string}>}
  - score: {type:'score', instructions, criteria: string[]} (levels, 0-based)
- Answers:
  - noul: {type:'noul', noul: 0..1}. The field is `noul`, not `p`; noul answers carry no confidence or probabilities.
  - choice: {type:'choice', choice, probabilities: Record<optionId,p>, confidence}
  - score: {type:'score', score: number in [0, levels-1], legend, probabilities keyed '0'..'n-1', confidence}. On a 5-level card, '4 or more' means score >= 3.
- JevResult = {ok:true, answers, model, usage:{inputTokens,outputTokens}, requestId, latencyMs} | {ok:false, error:{category:'no_key'|'network'|'timeout'|'http'|'malformed', reason, httpStatus?}, latencyMs}.
- interface JevClient { ask(state, questions, opts:{purpose, signal?}): Promise<JevResult> }.

HttpJevClient:
- Uses Node 22 global fetch with an AbortController. Total budget 4000 ms, 0 retries.
- Model pinned to 'jev-1.13.0'. If the response names another model, warn but still return ok.
- Validation ports _parse_answers: answer type must match the question; a choice must be one of the criteria keys; probabilities must be finite, in 0..1, and keyed exactly to the criteria (score: '0'..'n-1'); a score must be in range. Any failure is ok:false with category malformed.
- The API key never appears in a string. An HTTP failure's reason is the fixed string 'http_<status>', never the response body.

config/env.ts:
- jevApiKey getter: JEV_API_KEY, else the contents of the file named by JEV_KEY_FILE.
- FORAY_JEV_BASE_URL (default https://api.typesafe.ai) and FORAY_JEV_MODEL via readString.
- FORAY_JEV_BUDGET_MS via readBoundedNumber (env.ts:170), so a malformed value fails startup.

createJevClient() returns Http when a key is present, else NullJevClient (always {ok:false, no_key}).

meteredJevClient(client, {guard: BudgetGuard, userId, sessionId}):
- Before every call it runs guard.checkAndRecord({provider:'jev', model, operation: purpose, sessionId, estimatedUsd: inputChars/4 x 0.042e-6}) (cost/budgetGuard.ts:165, costEvents.ts:14). Every judged call site is therefore metered in ONE place.
- A budget stop propagates, like every other model call. Transport failures never throw.
- An onCall hook {purpose, ok, latencyMs, usage, requestId, judge:'jev'} feeds R1-14 per-call records and R1-19 Jev-call caps.

createJevPool(client, {maxInFlight:8}) is a semaphore wrapper so callers can fan out safely.

A structural test in jevClient.test.ts fails if any generation/*.ts other than jevClient.ts contains 'api.typesafe.ai' or '/v1/systemone'.

backend/src/cli/jevSmoke.ts asks one noul, one choice and one score question on synthetic text. It is for the live step only.

**Files edited:**

- backend/src/config/env.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/jevTypes.ts
- backend/src/generation/jevClient.ts
- backend/src/cli/jevSmoke.ts
- backend/test/jevClient.test.ts
- backend/test/helpers/fakeJevClient.ts
- backend/test/fixtures/jev/answers.json

**Acceptance:**

- Parsing tests: valid noul ({noul:0.7}), choice and score bodies parse. Each malformed variant yields ok:false, category malformed, and never throws: type mismatch, noul out of 0..1, choice not in criteria, probabilities keyed wrong, score out of range, score probabilities with the wrong count, non-JSON body.
- Timeout (a fake fetch that never resolves), network error, HTTP 503 and a missing key each map to their category. The key string never appears in any error or log line.
- meteredJevClient calls BudgetGuard.checkAndRecord once per ask with provider 'jev'. An EpisodeBudgetExceededError propagates; a transport failure does not throw.
- FakeJevClient answers by question id or by a predicate over state, and records every call (purpose, state, questions).
- The structural test fails when another generation/*.ts file names api.typesafe.ai.
- BACKEND_FLOORS (test/suite-integrity.test.js:2470) has an entry for jevClient.test.ts.
- A different answering model sets modelMismatch.
- With a RunLog active, every ask appends one CallRecord with provider 'jev', latency and usage.

**Tests.** backend/test/jevClient.test.ts (vitest) with an injected fetch and synthetic fixtures shaped like hermes-operating-system ops/jev/tests/_fixtures.py (_build_answer, success_body_for, corrupted_body_for). Run with: cd backend && npx vitest run test/jevClient.test.ts

**Flag.** Inert until a key exists: with no JEV_API_KEY or JEV_KEY_FILE, createJevClient() returns NullJevClient. Nothing calls it until a judged card's flag is switched on.

**Live step.** On a machine with the Jev key, run npx tsx backend/src/cli/jevSmoke.ts. Record median and p95 latency and the answering model id on #1163.
With a Jev key, make one call per question type on a neutral synthetic state. Record latency, usage, request-id and model, and commit a sanitized recorded fixture.

**Founder need.** founder-approved label (orchestrator applies); plus a Jev API key (JEV_API_KEY or JEV_KEY_FILE) on the machine that runs generation. One exists on the Spark (LM-22). Queue it on #1163.
A Jev key for Foray on #1163 (signups have been paused since 22 Sep, LM-25), plus the spend line ($0.042/M input).

**Risk.** W5-01: Jev is hosted off-network: each call sends the subject sentence and transcript excerpts to TypeSafe (LM-25). OQ-05's adopted default allows this; record the retention question against RQ-04 in the module doc. 503s were seen on 28 Sep and signups have been paused since 22 Sep, so every caller must treat 'unavailable' as a first-class result. backend/src is a governed path.
W2-11: Listener prompts and transcript excerpts leave the network (LM-25), so keep `state` minimal. Jev is weak on numbers, dates and long irrelevant context (LM-23), and its thresholds need labelled calibration (LM-24). Governed path.

#### GV-21 · Per-act servability on partial candidates: item provenance, act veracity, the hand-off line counts as unverified, only the servable prefix is exposed

- **From:** W6-01, W5-12a
- **Wave:** 4 · **Size:** M · **Depends on:** none
- **Covers:** GP-07, R1-15, R2-13, QK-29, MQ-04, GP-23

**Goal.** Give every item of a partial Foray a readiness record built from the provenance the stitcher already has (verified, unverified, unchecked seam, tape), and compute per act whether it may be served. An act holding an unverified page, including the HANDOFF_SCRIPT fallback, is never served. None of this goes into the forays.json-shaped items.

Skeptic corrections:
- Resumed acts now get real provenance, recomputed from the banked narrate:<i> WrittenAct, so no new checkpoint key is needed.
- The prelude (disclosure) item is classified explicitly.

**Design.**

INTEGRATION NOTE (merged W6-01 + W5-12a; both computed per-act servability and servableThrough). W6-01's provenance model wins (it also recomputes provenance for resumed acts). Carried over from W5-12a: veracityMetrics.computeActVeracity(written, actIndex) {unverifiedPages, handoffPages, groundedQuoteRate, ok, failures} feeds assessAct (an act also blocks when groundedQuoteRate < 1); runPipeline keeps actVeracity[] from the written array in the stitch loop so resumed acts count; PartialCandidateAct gains served and veracity; partialCandidate.ts exports servableView(candidate); generationStatus.readPartialCandidate returns servableView when the stored candidate carries delivery.servableThrough. The gate is always computed for the new `delivery` field and never raises RefusedPartialError. ONE FIELD, ONE UNIT: delivery.servableThrough (W6-01) is an ITEM COUNT of the leading servable prefix, prelude included, and it is the only servableThrough. W5-12a's act-level value is not a second servableThrough: where an act index is needed it is servableThroughAct, derived from delivery.acts (the last index of the contiguous run of servable acts from act 0, or -1), never stored separately. GV-44's snapshot and generationStatus.servableView slice items by the item count.

--- From W6-01 ---
What the snapshot shows:
- Stitched narration items carry `verified` (types/stitching.ts:107; stitchAct.ts:124 provenanceOf).
- toForayItems drops it, and assertNoInternalFieldsLeaked guards that the field stays out (forayItems.ts:405-414). onActReady therefore receives only plain items (stitchForay.ts:91-97, :218-227).
- The HANDOFF page is written `verified:false, unverifiedReason:'no-page'` (writeAct.ts:1214-1223).
- The act introduction and exit items are built inline from deepen text with no `verified` (stitchForay.ts:194-213).

1. New pure module backend/src/generation/itemReadiness.ts:
   - `type ItemCheck = 'verified'|'unverified'|'unchecked-seam'|'tape'|'jingle'|'prelude'`
   - `interface ItemProvenance { itemId; index /* position in the item list including the prelude */; actIndex; kind; narrationKind?; check; pronunciationHints?; scriptSha256? }`
   - `provenanceFor(stitched: StitchedItem[], actIndex)` classifies each item:
     - tape -> 'tape'
     - narration with verified===true -> 'verified'
     - verified===false -> 'unverified' (this includes HANDOFF)
     - verified absent -> 'unchecked-seam' (the act introduction and exit)
   - `assessAct(prov, policy:{blockOnUncheckedSeams}) -> {servable, blockers:{itemId,reason}[]}`. 'unverified' always blocks. 'unchecked-seam' blocks only under the policy, which defaults to false so that today's behaviour holds; the writing workstream's QK-24 decision flips it.
   - `deliveryView(perAct, policy) -> {acts:{index,servable,blockers}[], servableThrough /* item count of the leading all-servable prefix, prelude included */, items:{itemId,index,act,check,ready,audio:'pending'}[]}`.
2. stitchForay.ts:
   - Add `ForayStitcher.actProvenance(i, written)`. It rebuilds the act's StitchedItem list the same way stitchNextAct does (stitchAct(written, actLabel, slotIds) plus the introduction and exit ids) and returns provenanceFor(...). It is pure, so no continuity call is made.
   - stitchNextAct passes `actItemProvenance` and `provenanceSoFar` in the onActReady info.
   - acceptStitchedAct(actItems) becomes acceptStitchedAct(actItems, written: WrittenAct). runPipeline.ts:1688 already holds `writtenAct` from narrations[i], which a resume reads back from the banked `narrate:<i>`. The resumed act's provenance is recomputed rather than marked unknown.
   - Assert that the recomputed ids equal the banked actItems ids. On a mismatch, mark the act's items 'unverified', which is the conservative choice.
   - No new checkpoint key and no CHECKPOINT_VERSION bump. The gen-12 drop filter (runPipeline.ts:977) is unchanged, because it already drops narrate:/stitch: together.
3. runPipeline.ts:1488-1545: give the prelude item `{check:'prelude', index:0}`. Pass `itemProvenance` into PartialActInfo. buildPartialCandidate (partialCandidate.ts:181) attaches `delivery: DeliveryView` as a new optional field.
4. The served/refused verdict is independent of `validation` and of RefusedPartialError. An unservable act never aborts the run, which is the QK-29/R2-13 nuance.

--- From W5-12a ---
1. veracityMetrics.ts: computeActVeracity(written: WrittenAct, actIndex) returns {actIndex, unverifiedPages: FailingPage[], handoffPages, groundedQuoteRate, ok, failures}.
   - It reuses computeUnverifiedPages (:588) and computeGroundedQuoteRate (:93) on [written].
   - A page counts as a hand-off when script === HANDOFF_SCRIPT or unverifiedReason === 'no-page'.
2. stitchForay.ts: the onActReady info (:91-97; call :218) gains written: WrittenAct.
3. runPipeline.ts:
   - Keeps actVeracity[] computed from the `written` array in the stitch loop (:1667-1690). Resumed acts never fire onActReady, so the list must not depend on the callback.
   - The wrapper (:1488) passes the list through PartialActInfo.actVeracity.
4. partialCandidate.ts:
   - PartialCandidateAct (:60) gains served: boolean and veracity {ok, unverifiedPages, handoffPages}.
   - PartialCandidate does NOT gain a top-level servableThrough (superseded; see the integration note). A pure helper servableThroughAct(delivery) returns the last index of the contiguous run of servable acts from act 0, or -1, computed from delivery.acts; there is no gate key and no flag.
   - A new pure servableView(candidate) returns candidate.items.slice(0, candidate.delivery.servableThrough): the item count, prelude included.
   - The gate result is NOT part of validation.ok, so RefusedPartialError (runPipeline.ts:1538) never fires for it. The act is withheld and the run finishes its record.
5. generationStatus.ts readPartialCandidate (:62) returns servableView(candidate) whenever delivery.servableThrough is present on the stored candidate. That is the only shape a future route or job row may serve. It never reads env.

**Files edited:**

- backend/src/generation/stitchForay.ts
- backend/src/generation/partialCandidate.ts
- backend/src/generation/runPipeline.ts
- backend/test/partialCandidate.test.ts
- backend/test/stitchForay.test.ts
- backend/test/runPipeline.test.ts
- backend/test/runPipelineCheckpoint.test.ts
- test/suite-integrity.test.js
- backend/src/generation/veracityMetrics.ts
- backend/src/generation/generationStatus.ts
- backend/test/generationStatus.test.ts

**New files:**

- backend/src/generation/itemReadiness.ts
- backend/test/itemReadiness.test.ts
- backend/test/actVeracityGate.test.ts

**Acceptance:**

- A PartialCandidate written by generateForays carries delivery.acts[i].servable, and delivery.items[] aligns 1:1 with the ids in items[] (prelude included).
- An act containing a HANDOFF page (verified:false) has servable:false with blocker reason 'unverified', while candidate.validation and the run outcome are unchanged.
- items[] stay byte-identical to today: assertNoInternalFieldsLeaked still passes, and no verified or pronunciationHints field appears on any item.
- delivery.servableThrough never extends past the first unservable act.
- Units pinned: on a 2-act fixture whose act 1 is unservable, delivery.servableThrough === 1 + (act 0's item count) (the prelude plus act 0's items), servableThroughAct(delivery) === 0, and servableView returns exactly delivery.servableThrough items, the last of which belongs to act 0.
- On a resumed run (stitch:<i> banked), the provenance of the accepted act equals the provenance a fresh run computes for the same WrittenAct.
- computeActVeracity counts a HANDOFF page as both unverified and hand-off, and the act is ok:false.
- A resumed act (stitch:<i> banked) still contributes its veracity to actVeracity.
- generationStatus.test.ts: a stored partial whose act 0 is unservable (delivery.servableThrough = 1, the prelude only) never returns act items; one without delivery returns everything as today.

**Tests.** From W6-01: vitest, one file at a time:
- itemReadiness.test.ts: classification per kind, the HANDOFF case, unchecked-seam under both policies, and the prefix rule.
- stitchForay.test.ts: provenance ids equal actItems ids in order, and actProvenance equals the provenance stitchNextAct emitted.
- partialCandidate.test.ts: delivery is attached and items are unchanged.
- runPipeline.test.ts: a stub verifier that refuses one seam in act 0 gives delivery.acts[0].servable === false, and the run still completes.
- runPipelineCheckpoint.test.ts: provenance on resume.
- Add a BACKEND_FLOORS entry for itemReadiness.test.ts and bump the floors for the edited suites.
From W5-12a: Vitest actVeracityGate.test.ts, plus additions to partialCandidate.test.ts, runPipeline.test.ts, runPipelineCheckpoint.test.ts and generationStatus.test.ts.

**Flag.** none. `delivery` and the act veracity are new optional fields on the local partial; nothing serves them yet. blockOnUncheckedSeams defaults to false.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** W6-01: - backend/src is governed, so the founder-approved label is needed.
- Act introduction and exit items are unverified deepen text, so 'unchecked-seam' is a real hole until QK-24 lands. The default lets them play, as they do today.
- runPipeline.ts and stitchForay.ts are also edited by the writing workstream (R1-04 per-act chain, R2-13, QK-24). Keep this diff confined to the onActReady wrapper and acceptStitchedAct, and rebase onto whichever lands first.
W5-12a: Under the default keep policy an act whose page fails verification is withheld whole. That is safe but can stall playback; W5-12b's cut policy is what lets such acts be served. Per-item streaming (R1-15, GP-07) must not ship before this card. The whole-Foray publish gate already counts the HANDOFF page (unverifiedReason 'no-page'), so only the partial path changes.

#### GV-22 · Long-lived render worker with a spool directory, plus the spool upload step

- **From:** W6-06
- **Wave:** 4 · **Size:** M · **Depends on:** GV-11
- **Covers:** R1-13, GP-08

**Goal.** Avoid paying the ~1.3 GB fp32 session load per item. One worker process takes per-item jobs in priority order and writes each .m4a and its sidecar the moment it exists. A separate upload step pushes each finished item and records its public URL, so nothing references an object that was never uploaded.

**Design.**

1. Refactor the per-line body of render_all (:715-790) into `render_line(session, style, line, profile, pins, out_dir, tmp, ffmpeg, ffprobe) -> entry`, which raises RenderError on failure. render_all calls it, so its behaviour is unchanged.
2. New `--worker SPOOL` mode.
   - Load the profile, pins, g2p (kept resident, unlike phonemize_work's free at :661) and the ORT session once.
   - Loop over SPOOL/in/*.job.json. A job is {schema:'foray-render-job/1', job_id, foray_id, item_id, script, voice?, priority:int, enqueued_at, lexicon?:[{term,ipa}]}.
   - Take the minimum (priority, enqueued_at) and rename it into SPOOL/work/ (an atomic claim). Phonemize and render it.
   - Write SPOOL/done/<job_id>.json = {job_id, status:'rendered'|'failed', entry|error, timings:{queued_ms, render_ms, audio_sec}}.
   - Stage SPOOL/upload/<job_id>/manifest-<job_id>.json (a one-entry manifest_doc) plus the .m4a at its key path.
   - On start, move SPOOL/work/* back to in/ (crash recovery).
   - Flags: `--once` drains and exits; `--idle-exit SEC`.
   - `process_job(job, deps)` takes injectable render_line and phonemize.
3. New tools/narration/spool-upload.mjs, which is not governed.
   - For each staged dir, it calls upload-narration.mjs's exported collectUploads to verify the dir, then runs the unchanged governed uploader as a child process (`node upload-narration.mjs <dir>`).
   - Only on exit 0 does it write `public_url = <profile.public_base>/<key>` into done/<job_id>.json.
   - The uploader runner can be injected for tests. Under CI it refuses, the same way upload-narration's inCI refuses.

**Files edited:**

- tools/narration/render-foray.py
- tools/narration/render-foray.test.mjs
- test/suite-integrity.test.js

**New files:**

- tools/narration/render-worker.test.mjs
- tools/narration/spool-upload.mjs
- tools/narration/spool-upload.test.mjs

**Acceptance:**

- With a fake render_line, jobs complete in (priority, enqueued_at) order, and each produces done/<job_id>.json with timings.
- A job left in work/ at start is re-queued and rendered exactly once.
- The staged upload dir passes upload-narration.mjs collectUploads with the fake bytes' sha256.
- A failing job writes status failed with the RenderError text, and the worker continues.
- spool-upload writes public_url only after the injected uploader reports success, and never under CI.

**Tests.** - render-worker.test.mjs: node:test driving python with fakes.
- A refactor-equivalence test: render_all still writes the same manifest entry shape.
- spool-upload.test.mjs: injected uploader, success and failure paths, CI refusal.
- Add floors.

**Flag.** The new --worker mode and spool-upload are opt-in. Batch mode is unchanged.

**Live step.** Run `render-foray.py --worker` with real weights on the Spark CPU over a rendered draft, and record render_ms per audio_sec (MT-09). spool-upload runs only where the R2 token exists.

**Founder need.** The R2 narration bucket and write token on the render host (HUMAN-ACTIONS #119/#120), for the live upload only.

**Risk.** - Keeping g2p and the ORT session resident is fine on the Spark but not on this laptop (~3 GB free). Never run it here beyond --smoke or --once with fakes.
- The spool must be on local disk for atomic rename to hold.

#### GV-24 · Scorecard: one MQ row per Foray (score.mjs) plus reference scores for the 7 committed Forays

- **From:** W1-11
- **Wave:** 4 · **Size:** M · **Depends on:** GV-08, GV-10, GV-17
- **Covers:** GP-28, R2-02, MQ-01, MQ-02, MQ-03, MQ-04, MQ-05, MQ-06, MQ-07, MQ-08, MQ-09, MQ-10, MQ-11, MQ-12, MQ-13, MQ-14, MQ-15, MQ-16, MQ-17, MQ-18, MQ-19, MQ-20, MQ-21

**Goal.** Compute the five-pillar quality scorecard for any candidate, off the timed path. Code metrics are computed here, judged and listening metrics are read from their producers, and the 7 Forays in data/forays.json are scored first as the reference.

**Design.**

INTEGRATION NOTE: MQ-07 and MQ-14 prefer the pipeline's own veracity.showVariety (GV-83) and veracity.tierFit (GV-106) when the report carries them; the candidate-derived values are the fallback for old reports and the 7 published Forays.

New module tools/generation-bench/score.mjs.

`scoreCandidate({candidate, entry, pool, sources, judged, listen, tierTargets})` returns `{'MQ-xx': {value, source:'report'|'candidate'|'judged'|'listen', note}}`. Absent is null, never 0.

From the report row:
- MQ-01 veracity.groundedQuoteRate
- MQ-04 unverifiedPages
- MQ-09 veracity.tapeYield (W1-09)
- MQ-11 veracity.beatCoverage (W1-09)
- MQ-13 introRestates
- MQ-21 entry.publishable (W1-09)

From the candidate:
- MQ-06: clean-cut share of minted segments with boundary in {turn, sentence}. Pool rows count as unknown, never clean.
- MQ-07: distinct shows, distinct episodes, and the largest show's share of tape. Show comes from candidate.segmentSources, then data/segment-sources.json, then the pool show_id.
- MQ-08: tape over runtime, median clip, share under 60 s (reuses clipStats, run.mjs:395).
- MQ-14: tierFit = runtimeSec / target. The target is entry.tierTargetSec when R2-15 writes it, else a local PROPOSED table that notes the ~15 min vs 8-12 min conflict.
- MQ-15..18: voice-metrics.mjs (W1-10) on the narration scripts.
- MQ-19: narratorStructureLeaks count (backend/src/copy/narratorStructure.js, imported as check-narration.mjs does).

From `--judged <file>` or meta.veracity fields once the in-pipeline judges exist: MQ-02 supportedSentenceRate, MQ-03 attributionAccuracy, MQ-05 clipOnSubjectRate, MQ-10 promptFit, MQ-12 seamCoherence.

MQ-20 comes from the listening store through unseal.listenByCandidate (W1-16).

`--forays <path> [--ids ...]` scores published Forays with no report. Only voice, tape, structure and runtime apply; MQ-01/02/04/11 are absent by construction (RQ-04). The CLI writes tools/generation-bench/golden/reference-scorecard.jsonl for the 7, each labelled 'curated clip-only' (3) or 'generated pre-Q-03' (4). `--check` re-derives it and reports drift. It is a CLI check, not a unit test, so a later change to data/forays.json cannot break CI.

run.mjs `--scorecard` adds a scorecard object to each JSONL line and the MQ columns (detail group) to --wide.

**Files edited:**

- tools/generation-bench/run.mjs
- tools/generation-bench/run.test.mjs
- docs/curation/generation-kpis.md
- test/suite-integrity.test.js

**New files:**

- tools/generation-bench/score.mjs
- tools/generation-bench/score.test.mjs
- tools/generation-bench/golden/reference-scorecard.jsonl
- tools/generation-bench/fixtures/score-synth/candidate.json

**Acceptance:**

- On a synthetic two-show candidate (short synthetic scripts, no transcript text), MQ-07 reports 2 shows and the correct largest share, MQ-06 the correct clean share, and MQ-16 the expected over-25 count.
- On out-9, report-sourced fields are filled and judged and listen fields are null.
- Scoring tools/foray/fixtures/frozen/data/forays.json gives null voice metrics, not zeros, for the 3 clip-only Foray rows and numbers for what-engineers.
- reference-scorecard.jsonl is committed for the 7 Forays in data/forays.json, and `--check` reports no drift at commit time.
- The KPI doc lists every MQ id with its source and today's availability.

**Tests.** node --test tools/generation-bench/score.test.mjs; node --test tools/generation-bench/run.test.mjs (synthetic fixture plus the frozen forays fixture)

**Flag.** none; an offline tool

**Live step.** Score the 14 Sep candidate and report on the founder PC (backend/data-local/foray-candidates/) for the first current-writer scorecard row.

**Founder need.** none

**Risk.** The 4 generated reference Forays come from the pre-Q-03 writer the founder called clunky, so they are labelled 'reference: pre-Q-03', not 'target', and no metric is tuned towards them. If MQ-02 and MQ-05 do not separate them from run 9, treat that as a metric defect (R2-02's own check). The W1-19 dependency is merge order on run.mjs.

### Wave 5

#### GV-25 · Chat builders for the planning stages: understander, spine, deepen and continuity on a ChatProvider

- **From:** W2-06
- **Wave:** 5 · **Size:** M · **Depends on:** GV-03, GV-14, GV-19
- **Covers:** R2-21, GP-06, HW-12, R1-18

**Goal.** Give the PromptUnderstander, SpineBuilder, DeepenActBuilder and ContinuityBuilder interfaces a Qwen-capable implementation that reuses the existing prompts and schemas, so ST-01, ST-04, ST-05 and ST-09 can each be routed to a lane.

**Design.**

INTEGRATION NOTE: the builder max-token constants (clarity 400, intent 600, title 120, spine 8000, deepen 4000, continuity 500, verifier 4000) live in config/outputBudgets.ts as BUILDER_MAX_TOKENS (GV-14); this card makes the Anthropic and Chat builders read them there. No stageOutputBudgets.ts.

New classes in backend/src/generation/chat/. Each takes (provider, target:StructuredTarget, guard=defaultBudgetGuard), calls askStructured with the matching REPLY_SCHEMAS name and the existing operation labels (prompt_clarity, prompt_intent, spine_build, deepen_act, continuity_smooth), and reports providerName `local:${lane}`.
- ChatPromptUnderstander:
  - assessClarity uses buildClarityPrompt, which is exported from AnthropicPromptUnderstander.ts:255 (today it is not exported).
  - extractIntent uses buildIntentPrompt (:277).
  - The title re-case keeps the same 3-turn conversation and failure-keeps-title behaviour (:193-235). It is extracted into a shared helper that takes an `ask` function, so the logic is not copied.
- ChatSpineBuilder: buildSpinePrompt (:283). ctx.revision is mirrored as [user prompt, assistant spineReplyText(previous), user buildSpineFixInstruction or buildSeedFloorInstruction] (:94-107). It returns the same Spine fields (subject, angle, duration, generatedAt), as :154-163 does.
- ChatDeepenActBuilder: buildDeepenActPrompt (:140).
- ChatContinuityBuilder: buildSmoothPrompt (AnthropicContinuityBuilder.ts:108).

SUPERSEDED (decision 10): there is no stageOutputBudgets.ts. Both the Anthropic and the Chat builders read their caps from BUILDER_MAX_TOKENS in backend/src/config/outputBudgets.ts, defined by GV-14 with unchanged values; this card does not edit outputBudgets.ts. The writer keeps actOutputTokenBudget.

A helper targetFor(route, profile) builds the StructuredTarget. No prompt text changes in this card.

**Files edited:**

- backend/src/generation/AnthropicPromptUnderstander.ts
- backend/src/generation/AnthropicSpineBuilder.ts
- backend/src/generation/AnthropicDeepenActBuilder.ts
- backend/src/generation/AnthropicContinuityBuilder.ts
- backend/src/generation/AnthropicNarrationVerifierBuilder.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/chat/ChatPromptUnderstander.ts
- backend/src/generation/chat/ChatSpineBuilder.ts
- backend/src/generation/chat/ChatDeepenActBuilder.ts
- backend/src/generation/chat/ChatContinuityBuilder.ts
- backend/src/generation/chat/targetFor.ts
- backend/test/chatPlanningBuilders.test.ts
- backend/test/fixtures/openai/spine-reply.json
- backend/test/fixtures/openai/deepen-reply.json

**Acceptance:**

- Driven by scriptedProvider, each Chat builder returns the same parsed object that its Anthropic twin returns for the same reply text. The deepen case uses run2-deepen-2026-09-09.json content.
- The spine structural re-ask sends [prompt, previous spine, fix instruction] in that order, and the seed-floor variant uses buildSeedFloorInstruction.
- Every call carries response_format naming the right schema, the stage's maxTokens, and thinking:false.
- A 'length' finish throws TruncatedReplyError, and one invalid reply costs exactly one re-ask.
- The Anthropic builder suites and spineReask.test.ts pass unchanged.

**Tests.** Run `npx vitest run test/chatPlanningBuilders.test.ts`, then AnthropicSpineBuilder.test.ts, spineReask.test.ts, AnthropicDeepenActBuilder.test.ts, AnthropicPromptUnderstander.test.ts and anthropicCall.test.ts, one at a time, then `npm run typecheck`.

**Flag.** These classes are constructed only by W2-08's factories when a stage routes to 'local'.

**Live step.** With the LiteLLM key, run one benchmark prompt with only ST-04 on local:spark and one with ST-05 on local:second. Record JSON validity and re-ask counts. The judged comparison belongs to the eval workstream.

**Founder need.** founder-approved label (orchestrator applies); plus LiteLLM key (#1163).

**Risk.** Putting Qwen3.8-27B in Opus's place on the spine is the largest quality risk (LM-05, GP-27); the golden set decides whether it holds. Governed path.

#### GV-26 · The pipeline evaluates its own publish gate; MQ-21 run success, MQ-09 tape yield and MQ-11 beat coverage in the report

- **From:** W1-09
- **Wave:** 5 · **Size:** S · **Depends on:** GV-07
- **Covers:** GP-26, MQ-21, MQ-09, MQ-11, MQ-01, MQ-04

**Goal.** A run learns it failed its gates when it finishes, not at publish. The report carries the gate verdict and the tape and story metrics that only the pipeline's internal data can compute.

**Design.**

runPipeline.ts:
- After buildVeracityMetrics (:1717-1735): `const gate = evaluateVeracityGate(veracity)` (veracityMetrics.ts:1019).
- The 'generated' outcome gains `gate {ok, failures}`. Nothing is refused here. Candidates stay local, and publishForay.ts:832 still gates publication.
- BuildVeracityMetricsInput gets optional `sourcingTrace`, passed from sourced.sourcingTrace.

veracityMetrics.ts:
- `computeTapeYield({tapeRelevance, sourcingTrace, sourcedActs})` (MQ-09) returns {tapeBeats, wantedBeats, rate, seedsPlaced, seedsLost}.
  - wantedBeats = tape rows + trace rows with outcome 'no-tape'. 'skipped:argument' is excluded (types/tapeSourcing.ts:623-635).
  - Seeds come from the beats' seeds and seedLost.
- `computeBeatCoverage(writtenActs)` (MQ-11) returns {beats, carried, rate}: the share of narration beats with a verifiedAtAttempt, the same marks computeFirstAttemptPassRates (:249) reads. It is null on the per-page path.
- Both become optional VeracityMetrics fields (tapeYield, beatCoverage), null when not computed.
- The gate itself is unchanged.

generateForays.ts:
- The entry gains `gate` and `publishable = result.validation.ok && gate.ok` (MQ-21).
- The run line appends 'GATE FAIL: <first failure>'.
- The batch summary (:910) also prints the count passing every gate without force.

**Files edited:**

- backend/src/generation/runPipeline.ts
- backend/src/generation/veracityMetrics.ts
- backend/src/cli/generateForays.ts
- backend/test/veracityMetrics.test.ts
- backend/test/runPipeline.test.ts
- backend/test/generateForays.test.ts
- test/suite-integrity.test.js

**New files:**

- none

**Acceptance:**

- A stub run's report row carries gate {ok, failures} equal to evaluateVeracityGate(meta.veracity).
- publishable is false whenever gate.ok or validation.ok is false.
- computeTapeYield on a synthetic SourceBeatsResult (3 tape rows, 1 no-tape, 1 argument) returns rate 0.75.
- computeBeatCoverage on a fixture per-act WrittenAct returns the expected carried share, and null on a per-page fixture.
- The veracityMetrics.test.ts floor rises from 48, and the generateForays.test.ts and runPipeline.test.ts floors rise.

**Tests.** backend vitest: veracityMetrics.test.ts, runPipeline.test.ts, generateForays.test.ts

**Flag.** none; report-only, publish behaviour unchanged

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Making the gate passable is other workstreams' work (R2-10 cut, R2-13 per-act gate, R1-07/R2-09 verifier, R2-03 replacing QK-04), so MQ-21 reads 0 until they land. New field names must not collide with ReportEntry's existing `calls` and `publish`. The depends_on is merge order: W1-03 edits the same runPipeline region (:1729-1735).

#### GV-27 · Per-sentence support judge: candidate sources per sentence (at most ~2k tokens), a Jev yes/no plus a choice of source

- **From:** W5-08
- **Wave:** 5 · **Size:** M · **Depends on:** GV-10, GV-20
- **Covers:** R1-07, MQ-02

**Goal.** Provide the reusable primitive that R1-07, R2-10, QK-24 and the streamed writer need: judge one sentence against only its own candidate sources, never the whole act (R2 guard; LM-23).

**Design.**

- types/narration.ts exports isStatementSentence(sentence): the per-sentence rule inside hasDeclarativeSentence (:656-668): not a question, at least 3 words, not a LISTENER_IMPERATIVES opener. hasDeclarativeSentence keeps its own splitter and calls the new helper, so its behaviour is unchanged.
- Sentences come from W5-17's splitSpokenSentences.
- New backend/src/generation/sentenceSupport.ts:
  - SupportSource {id, kind:'claim'|'clip'|'page'|'doc', text, publication}.
  - candidateSourcesFor(sentence, sources, {maxChars: 8000, maxSources: 3, mustInclude?: string[]}): ranks by distinct tokenizeForSourcing overlap, ALWAYS includes the writer-declared selected claims (mustInclude) whatever their overlap, and trims each long text with passageAround(text, sentence, budget). passageAround picks the window densest in term matches, snapped to sentence ends.
  - interface SentenceSupportJudge { name; judge(items:{id, sentence, sources}[]): Promise<Map<id, {p, restsOn?: string} | {unavailable}>> }.
  - JevSentenceSupportJudge(metered client, pool): one ask per sentence. state = {sentence, sources:{s1..sN}}. Questions:
    - 'supported': a noul with criteria {true:'Every statement of fact in `sentence` is backed by at least one of `sources`, read literally.', false:'Some statement in `sentence` is not in `sources`.'}; p = the noul value.
    - 'restsOn': a choice over the source ids plus 'none'.
  - CodeOverlapSupportJudge: p = the share of the sentence's content words found in the best source. It lets stub and dry-run pipelines exercise downstream code without Jev.

**Files edited:**

- backend/src/types/narration.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/sentenceSupport.ts
- backend/test/sentenceSupport.test.ts

**Acceptance:**

- narrationRules.test.ts, writeNarration.test.ts and actNarration.test.ts are unchanged and green.
- For a synthetic 30-minute clip (about 25k chars) and a sentence about minute 12, candidateSourcesFor returns at most 8,000 characters and the passage contains the minute-12 text.
- A selected claim with zero term overlap is still included when passed in mustInclude.
- The Jev judge maps the noul and choice answers correctly; unavailable or malformed answers come back as {unavailable}; at most 8 asks are in flight.

**Tests.** Vitest sentenceSupport.test.ts with FakeJevClient and synthetic texts.

**Flag.** A library only. Nothing calls it until W5-09, W5-11 or W5-16 is enabled.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Term-overlap source selection can miss a paraphrased source. mustInclude for writer-declared claims mitigates this. Until R2-12 lifts the 3,000-character tape cap, clip sources are truncated windows.

#### GV-28 · Passage store and embeddings: SQLite passages table, sub-chunk embeddings, Embedder interface, dense top-k

- **From:** W3-07
- **Wave:** 5 · **Size:** M · **Depends on:** GV-09, GV-12
- **Covers:** R1-09, R2-04

**Goal.** Hold passages and dense vectors in a portable file store, so a semantic arm can find episodes that share no query word with a claim (for example a Semmelweis passage for 'how germ theory won').

**Design.**

tools/passage-index/store.mjs reuses tools/corpus patterns:
- db.mjs openDb/migrate style, applying its own migrations dir
- vectors.mjs: toBlob, readVectorInto, topK, l2Normalize. These are dependency-free imports.
- embeddings.mjs registerModel shape

node:sqlite migrations (tools/passage-index/migrations/0001_passages.sql):
- passages(id PK, show_id, guid, start_sec, end_sec, start_boundary, end_boundary, start_anchor, end_anchor, text, index_version), indexed on (show_id, guid)
- embedding_models(id, name, revision, dim, pooling, normalized, query_prefix, passage_prefix)
- passage_chunks(passage_id REFERENCES passages ON DELETE CASCADE, ord, model_id, vector BLOB, CHECK length(vector) = 4*dim via trigger)

Functions:
- ingestPassages(db, jsonl): per episode, delete and insert in one transaction.
- backfillEmbeddings(db, embedder, {batch:32}): splits each passage into sub-chunks of at most EMBED_CHUNK_MAX (tools/corpus/embedder.mjs:66, 400) tokens, using the embedder's tokenizer when it has one and a chars/4 estimate otherwise. It embeds passage_prefix plus chunk. It never truncates; tools/corpus/README.md 'Semantic search' measured truncation making hybrid worse. It reports chunks per passage.
- loadDenseIndex(db, modelId): one Float32Array plus a chunk-to-passage map, loaded once.
- denseSearch(index, q, {episodeFilter, k}): brute-force dot products over chunks in the filter. A passage scores the max over its chunks. Returns [{passageId, show_id, guid, sim}].

embedder.mjs provides createPassageEmbedder({kind}):
- 'stub': deterministic hashing into dim 64, for tests
- 'transformers': delegates to tools/corpus/embedder.mjs createEmbedder (opt-in runtime)
- 'openai': POST `${FORAY_EMBED_URL}/v1/embeddings` with FORAY_EMBED_MODEL and bearer FORAY_EMBED_KEY. It refuses a dimension mismatch.
Prefixes come from the model row only.

CLI index-db.mjs: `ingest --passages f` and `embed --embedder stub|transformers|openai`.

**Files edited:**

- tools/passage-index/README.md
- test/suite-integrity.test.js

**New files:**

- tools/passage-index/store.mjs
- tools/passage-index/embedder.mjs
- tools/passage-index/index-db.mjs
- tools/passage-index/migrations/0001_passages.sql
- tools/passage-index/store.test.mjs
- tools/passage-index/embedder.test.mjs

**Acceptance:**

- Ingest is idempotent per episode, and re-ingest removes stale chunk vectors through the cascade.
- The trigger rejects a vector of the wrong length.
- A passage longer than one chunk produces several chunk vectors, and none is truncated.
- denseSearch respects episodeFilter, scores a passage by its best chunk and returns the top-k.
- The openai embedder sends the documented request (fake fetch) and refuses a dimension mismatch.

**Tests.** node:test `npm test --prefix tools/passage-index -- store.test.mjs embedder.test.mjs` (the --experimental-sqlite flag comes from the package script). Synthetic passages and the stub embedder; no model download. Add FLOORS entries.

**Flag.** None. This is a new store, and nothing reads it until W3-09.

**Live step.** On the Spark, choose the embedder: bge-small q8 on CPU, or an OpenAI-compatible embedding endpoint if Joey can serve one on the second box. Backfill, then record throughput and chunks per passage on #1163.

**Founder need.** Approval to install the tools/corpus/embed runtime (about 373 MB) on the Spark, or to serve an embedding model on the second box.

**Risk.** tools/corpus measured hybrid losing to keyword on its gold set, so dense stays behind the W3-15 replay gate. Brute force over about 1-2M chunk vectors x 384 floats is 1.5-3 GB of RAM: fine on the Spark (128 GB), not on the laptop. pgvector or sqlite-vec can replace it later over the same blob format.

#### GV-29 · Backend retrieval client: RemoteRetrieval, PrecomputedTextIndex (scope+query+limit keyed), HydratingCueProvider

- **From:** W3-10
- **Wave:** 5 · **Size:** M · **Depends on:** GV-16
- **Covers:** R1-09, GP-09

**Goal.** Let synchronous sourcing (sourceBeats is sync at sourceBeats.ts:350; getCues is sync at transcriptArchiveLookup.ts:252) use a remote index and remote bodies without making sourceBeats async.

**Design.**

New backend/src/generation/retrievalClient.ts. It is a separate module because the five no-fetch files (backend/test/sourceBeats.test.ts:308-333) must stay fetch-free. It makes no fs writes, so promptNoPersistence holds.

RemoteRetrieval({baseUrl, token, fetchFn = fetch, timeoutMs = 3000, mode, archive}):
- loadManifest(): GET /v1/episodes.
- prepareScope(topic, root): registers two scopes per Foray.
  - 'lineage': archive entries where familyGateAllows(topic, nodesForArchiveEntry(entry, root), root), the exact isUsable of researchShape.ts:310-311 and sourceBeats.ts usableArchiveEntry (:1197).
  - 'all': used by researchShape's probeSubjectTape, which searches with no isUsable (researchShape.ts:498).
- prepare(requests:[{scope:'lineage'|'all', text, limit}]): batches POST /v1/search with deduped requests. Answers are stored under key `${scope}\u0000${limit}\u0000${text}` with the text verbatim, and mapped back to archive entries by show_id+guid (unknown ones are dropped and counted). Each becomes a TranscriptTextCandidate {entry, score, matchedTerms, rank, idf: Map}. via and passage hints go on a side map for later cards.
- hydrate(entries): GET /v1/cues, 8 at a time, gzip.
- Every network failure or timeout resolves with a recorded degraded reason and never throws.

PrecomputedTextIndex implements TranscriptTextIndex (enabled = true):
- search(q, {limit, isUsable}) picks the scope by isUsable presence: undefined means 'all', else 'lineage'. The caller passes the same predicate the scope was built from; an equality-of-sets check runs once per scope in debug builds.
- It returns the stored list filtered by isUsable and sliced to limit.
- A miss delegates to the fallback (NullTranscriptTextIndex) and is counted.
- stats(): {prepared, hits, misses, degraded, hydrated, hydrationMisses}.

HydratingCueProvider implements TranscriptBodySource:
- getCues reads hydrated bodies. An unhydrated entry returns null and increments hydrationMisses.
- bodyStat answers synchronously from the manifest, mapped with W3-04's locate rule. topicSupply's isSearchable (runPipeline.ts:1112-1121) and corpusCoverage then see the remote corpus.
- transcriptSource reads the hydrated body's field with the same rule as FileTranscriptCueProvider.transcriptSource.
- Memory: entries are pinned for the run, bounded at 512 MB, with LRU beyond the pins.

**Files edited:**

- test/suite-integrity.test.js

**New files:**

- backend/src/generation/retrievalClient.ts
- backend/test/retrievalClient.test.ts

**Acceptance:**

- After prepare, PrecomputedTextIndex.search returns exactly the server's candidates mapped to archive entries, honouring isUsable and limit, for both 'lineage' and 'all' scopes.
- A request with an unprepared (scope, limit, text) key falls back and is counted as a miss.
- A timeout leads to degraded mode with fallback, never an exception.
- bodyStat answers from the manifest (null for an unknown episode), and transcriptSource matches FileTranscriptCueProvider's rule on the same body JSON.
- Hydration never exceeds 8 requests in flight.
- The module source contains no fs write call.

**Tests.** vitest `npx vitest run test/retrievalClient.test.ts` with an injected fake fetchFn serving canned /v1/episodes, /v1/scopes, /v1/search and /v1/cues JSON built from a synthetic corpus. Covers the idf carry, dedup batching, both scopes, degraded paths, pin and LRU accounting, and transcriptSource parity. Add a floor.

**Flag.** Inert until constructed. W3-11 constructs it only when FORAY_RETRIEVAL_URL is set.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed. Precomputed answers depend on exact query strings, so W3-11 must prepare the strings the call sites actually pass. hydrationMisses and misses expose any drift. Shipping whole bodies for every candidate (about 8 per beat) costs about 2-5 s over the LAN; it is timed as its own stage in W3-11.

#### GV-30 · Offline topic dossiers, code-built: fetched article text per taxonomy node, verbatim passages, no model, robots-compliant

- **From:** W3-19
- **Wave:** 5 · **Size:** M · **Depends on:** none
- **Covers:** R2-20, QK-23

**Goal.** Replace live web search as the source of outside facts with dossiers of FETCHED text (not a model's retyping, F-48), built offline per taxonomy node, with zero request-time cost.

**Design.**

Lives INSIDE the existing tools/corpus package as tools/corpus/dossiers/. That package already has the polite fetcher (fetcher.mjs: robots, CORPUS_UA, per-host spacing, retries), hostgate.mjs, extract.mjs (Readability/turndown; its dependencies are installed by that package's npm ci), chunk.mjs and a 'dossier areas' concept. A separate tools/dossiers package would import ../corpus/extract.mjs whose dependencies the CI runner might not have installed (run-suites installs per package).

Discovery without a search model, and compliant with the fetcher's robots enforcement. en.wikipedia.org/robots.txt (checked 2026-10-11) disallows /w/ and /api/ for all agents, so the MediaWiki Action API and REST API are OUT. Article pages /wiki/<Title> are allowed.
- seeds.mjs: titlesForNode(node) = the node label as a /wiki/ title (spaces to underscores), plus overrides and extras from a committed tools/corpus/dossiers/seeds.json ({nodeId: [url]}), plus `--subjects <file>` mapping benchmark subjects to URLs.
- seeds.json is code-reviewed data. Its URLs are chosen by hand or by a reviewed PR, and never generated by a Claude call (OQ-06 parks Claude-built dossiers).

build.mjs:
- Fetch each URL through createFetcher({hostGate}), then htmlToMarkdown.
- Paragraph split, then passages of at most 1,500 chars (EVIDENCE_MAX_PASSAGE_CHARS) cut on sentence ends.
- Assert each passage is a verbatim substring of the extracted text.
- Keep at most 120 passages per node in document order. Relevance ranking is left to the backend's tokenizer at request time, so no tokenizer port or parity is needed.
- Output data-local/dossiers/<safe-node-id>.json: {version:1, node_id, label, built_at, builder:'code', sources:[{sourceId, url, publication, title, retrievedAt, sha256 of raw bytes, license}], passages:[{docId:`dossier:<node>:<sourceId>:<n>`, sourceId, text, offset}]}, plus manifest.json (node to file sha256 and passage count).
- A 404 or robots refusal is recorded per node as missing.
- schema.mjs exports the JSON schema that W3-21 is tested against, via a committed fixture.
- Nothing fetched is committed (tools/corpus rule).

CLI: `node tools/corpus/dossiers/build.mjs --all | --node <id>`.

**Files edited:**

- tools/corpus/README.md
- test/suite-integrity.test.js

**New files:**

- tools/corpus/dossiers/build.mjs
- tools/corpus/dossiers/seeds.mjs
- tools/corpus/dossiers/passages.mjs
- tools/corpus/dossiers/schema.mjs
- tools/corpus/dossiers/seeds.json
- tools/corpus/dossiers/build.test.mjs
- tools/corpus/dossiers/passages.test.mjs
- tools/corpus/fixtures/dossiers/article.html

**Acceptance:**

- Every passage is a verbatim substring of its source's extracted text (asserted by the builder and by a test).
- Every source records url, retrievedAt, raw sha256 and license.
- Every request goes through createFetcher with robots enforcement. A test asserts the builder never constructs a /w/ or /api/ Wikipedia URL.
- Fixture-only tests make zero network calls.
- The output validates against schema.mjs.

**Tests.** node:test via `npm test --prefix tools/corpus -- dossiers/build.test.mjs dossiers/passages.test.mjs`, with an injected fetchImpl serving fixture robots.txt and HTML. Cases: passage cut at the 1,500-character cap, verbatim-check refusal, per-node cap, missing-page record, manifest. Add FLOORS entries.

**Flag.** Tool only. Nothing reads dossiers until the research route is set to dossier: FORAY_STAGE_RESEARCH=dossier (routing table, GV-03; DossierExternalResearcher is GV-69).

**Live step.** On a machine with internet, run `build.mjs --all`: about 200-400 polite fetches at at least 2 s per host, under an hour. Record per-node counts and missing nodes on #1163, then grow seeds.json for the gaps in a reviewed PR.

**Founder need.** none

**Risk.** Label-as-title discovery misses niche or ambiguous nodes (disambiguation pages), so seeds.json fills the gaps over time. Wikipedia text is CC BY-SA: storing it stays local and passages carry the publication. The Claude-built variant stays parked (OQ-06).

### Wave 6

#### GV-31 · Chat builders for narration: act writer and act verifier on a ChatProvider (non-streaming)

- **From:** W2-07
- **Wave:** 6 · **Size:** M · **Depends on:** GV-03, GV-19, GV-25
- **Covers:** R2-21, GP-06, HW-12, R1-18

**Goal.** Give ST-08's writer and verifier a Qwen implementation of the existing contracts (NarrationWriterBuilder.ts:54, NarrationVerifierBuilder.ts:87). Then R2-21 can move the writer on its own, and the writing workstream's streamed writer (R1-06) and Jev verifier (R1-07) have a local baseline and a fallback.

**Design.**

ChatNarrationWriterBuilder.writeAct(request, ctx) calls askStructured with:
- schema RawActWriteSchema;
- buildActWritePrompt(request) (AnthropicNarrationWriterBuilder.ts:289);
- maxTokens = actOutputTokenBudget(request) (:92);
- operation 'narration_write_act'.

ChatNarrationVerifierBuilder.verifyAct uses buildActVerifyPrompt (AnthropicNarrationVerifierBuilder.ts:188), RawActVerifySchema and the verifier cap BUILDER_MAX_TOKENS.verifier from config/outputBudgets.ts (GV-14).

The two one-line post-parse mappings move into replySchemas.ts as pure functions, used by both the Anthropic and the Chat classes:
- toActWriteResult (pronunciationHints ?? [], :130)
- toActVerifyResult (restsOn ?? [], :110)

Both Chat classes take the provider through the constructor. The Anthropic writer, verifier and continuity classes build `new Anthropic()` inside (:118-125, :98-105) and cannot be faked; these can. providerName `local:${lane}` flows through runPipeline's counting wrappers (runPipeline.ts:1022-1039).

**Files edited:**

- backend/src/generation/AnthropicNarrationWriterBuilder.ts
- backend/src/generation/AnthropicNarrationVerifierBuilder.ts
- backend/src/generation/replySchemas.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/chat/ChatNarrationWriterBuilder.ts
- backend/src/generation/chat/ChatNarrationVerifierBuilder.ts
- backend/test/chatNarrationBuilders.test.ts
- backend/test/fixtures/openai/act-write-reply.json
- backend/test/fixtures/openai/act-verify-reply.json

**Acceptance:**

- A recorded-shape writer reply yields the same ActWriteResult the Anthropic class would produce, with pronunciationHints defaulted to [].
- The writer's maxTokens equals actOutputTokenBudget(request), and response_format names RawActWriteSchema.
- Both mapping functions are shared by both classes, and actNarration.test.ts passes unchanged.
- An offline runPipeline-style test completes a short-tier run with both Chat builders injected.
- The test's provider responder answers each writeAct and verifyAct with JSON produced by StubNarrationWriterBuilder and StubNarrationVerifierBuilder for the same request, which a test wrapper captures before delegating, so the seam ids match.

**Tests.** Run `npx vitest run test/chatNarrationBuilders.test.ts`, then `npx vitest run test/actNarration.test.ts`, each on its own.

**Flag.** Constructed only when the writer or verifier route is 'local' (W2-08).

**Live step.** Run one short-tier benchmark prompt with the writer on local:spark. Record writer output tokens, wall time per act and JSON validity, and hand the candidate (kept local) to the eval workstream's listening card.

**Founder need.** founder-approved label (orchestrator applies); plus LiteLLM key (#1163).

**Risk.** A writer reply of 1-1.6k prose tokens at about 22 tok/s takes about 74 s. Non-streaming is only a correctness baseline; the 30 s target needs the streamed JSONL writer. A whole-act json_schema may slow decoding. Governed path.

#### GV-32 · Planning prompts split into a byte-stable prefix (stable / this Foray / this call), moved to prompts/*.ts

- **From:** W2-13, W4-04
- **Wave:** 6 · **Size:** M · **Depends on:** GV-25
- **Covers:** R1-10, GP-05, R1-03, R2-07, GP-02

**Goal.** Make every planning call after the first hit SGLang's radix cache (HW-04: a 24k prefix drops from 14 s to 0.24 s). Each prompt becomes [static][this Foray][this call] with byte-identical leading parts. Today every builder opens with per-run text:
- buildSpinePrompt's subject (AnthropicSpineBuilder.ts:357-361)
- deepen's per-act marker (AnthropicDeepenActBuilder.ts:144)
- clarity and intent with the listener prompt near the top

**Design.**

INTEGRATION NOTE (merged W2-13 + the prompt-split half of W4-04; both split the spine prompt). The prompt text moves now into backend/src/generation/prompts/{understand,spine,deepen,continuity}.ts (the final home W2-17 planned), each exporting build*PromptParts and build*Prompt = joinParts(...); the Anthropic and Chat builders import from there, so GV-96 later only deletes. The spine split follows W4-04 item 1 (quoted below) using W2-13's PromptParts {stable, foray, call} names (W4-04's prefix = stable). The fold options (foldCopy, foldDeepen) are added later by GV-67 and GV-86; this card is a content-preserving reorder. W4-04's schema, budget and seed-floor parts are in GV-100.

--- From W2-13 ---
New module backend/src/generation/promptLayout.ts:
- PromptParts {stable, foray, call}
- toChatMessages(parts) → [system: stable, user: foray + '\n\n' + call]
- joinParts(parts), the string the legacy path keeps sending
- stableStringify, which sorts keys and strips timestamps

Add build*PromptParts functions, keeping build*Prompt = joinParts(...) so existing callers compile:
- clarity and intent: rules and the JSON shape are stable; the listener prompt is call.
- spine: rules, taxonomy text, voice options, the tier table for all tiers and the JSON shape are stable. Subject, angle, prior knowledge, disappointment, the research map and the tier line are foray.
- deepen: rules are stable. foray is an act-invariant spine summary with every act rendered alike. The per-act 'THIS IS THE ACT YOU ARE DEEPENING' marker moves out of the summary and into call, together with the target act's slots and frozen-seed lines.
- continuity: rules are stable; the boundary is call.

Re-asks append turns, so the prefix is kept. The Chat* builders switch to toChatMessages.

--- From W4-04 (item 1 only) ---
1. New module backend/src/generation/spinePrompt.ts. The text moves out of AnthropicSpineBuilder.ts:283-401.
   - spinePromptParts(intent, researchShape, duration, opts: {foldCopy, foldDeepen, listenerPrompt?}): {prefix, foray}.
   - prefix holds only static text: role line, beat-as-claim rule, exploration floor, seeding rules (seedRule's text and numbers), voice and overview rules, NARRATOR_STRUCTURE_RULE, field glossary and output contract. It contains no subject, tier numbers, ids or timestamps.
   - foray holds the listener prompt (fold mode only), intent lines, research map with windows, tier line (:368) and length targets.
   - buildSpinePrompt stays exported and returns prefix + '\n\n' + foray, so the Anthropic builder keeps the same lines in a new order. The AnthropicSpineBuilder.test.ts pins are updated in this PR.
   - With foldCopy, the contract orders the fields: copy fields first (W4-03), then voice, then acts, then overview last, so the overview is written knowing the plan.

**Files edited:**

- backend/src/generation/AnthropicPromptUnderstander.ts
- backend/src/generation/AnthropicSpineBuilder.ts
- backend/src/generation/AnthropicDeepenActBuilder.ts
- backend/src/generation/AnthropicContinuityBuilder.ts
- backend/src/generation/chat/ChatPromptUnderstander.ts
- backend/src/generation/chat/ChatSpineBuilder.ts
- backend/src/generation/chat/ChatDeepenActBuilder.ts
- backend/src/generation/chat/ChatContinuityBuilder.ts
- backend/test/AnthropicSpineBuilder.test.ts
- backend/test/AnthropicDeepenActBuilder.test.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/promptLayout.ts
- backend/test/promptLayout.test.ts
- backend/src/generation/prompts/understand.ts
- backend/src/generation/prompts/spine.ts
- backend/src/generation/prompts/deepen.ts
- backend/src/generation/prompts/continuity.ts

**Acceptance:**

- For clarity, intent, spine, deepen and continuity, `stable` is byte-identical across two unrelated fixture inputs.
- Deepen's `foray` part is byte-identical for every act of one Foray.
- No stable or foray part contains an ISO timestamp, a sessionId or a checkpoint key (regex test).
- A line-set test shows every pre-existing instruction line is still present. The only exceptions are the deepen act-marker lines, which are rewritten on purpose and listed in the test.
- Chat builders send [system, user]. Prompt pins in the Anthropic*.test suites are updated in the same PR.
- spinePromptParts(...).prefix is byte-identical across two intents, two research maps and all three tiers, and contains no tier-specific digit, subject or episode id.

**Tests.** Run `npx vitest run test/promptLayout.test.ts`, then AnthropicSpineBuilder.test.ts, spineReask.test.ts, AnthropicDeepenActBuilder.test.ts, AnthropicPromptUnderstander.test.ts and chatPlanningBuilders.test.ts, one at a time.

**Flag.** A content-preserving reorder. The cache benefit appears only on local routes.

**Live step.** With --enable-cache-report on (W2-09's live step), run one medium Foray and read cachedTokens per call. Deepen calls 2..n and the re-asks should show a cached prefix close to stable+foray.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** W2-13: Rules placed before context can shift model behaviour, so compare on the golden set. R1-02 (title into the spine) and R2-07 (a disappointment field) edit the same spine prompt; sequence them after this card. Governed path.
W4-04: Reordering the Anthropic prompt changes the pinned prompt tests on purpose, and can shift Claude's output slightly in classic runs. The content is unchanged. Turning off the seed-floor re-ask on short can lower the seeded share until the passage index lands, so watch MQ-09.

#### GV-33 · Item-ready events: onItemReady hook, RunLog readiness events, delivery timeline and the 30 s lead monitor (MT-01, MT-11)

- **From:** W6-02, W1-06
- **Wave:** 6 · **Size:** M · **Depends on:** GV-01, GV-21
- **Covers:** R1-15, GP-07, R1-14, MT-01, MT-11

**Goal.** Emit one event per item, in playback order, when it becomes ready. Each event carries a timestamp. Compute the lead of generation over a playhead that starts at first audio, so the 'lead >= 30 s' invariant is measured on every fresh run.

**Design.**

INTEGRATION NOTE (merged W6-02 + W1-06 + the lead computation of W1-19; all three changed the onActReady wrapper or computed lead). W6-02's hook and DeliveryTimeline win. Carried over from W1-06: readiness.ts (emitActReady / emitItemReady append RunLog ReadyEvents), called from the same always-constructed wrapper, so runlogs carry readiness. From W1-19: report.delivery also records granularity ('act' until the streamed writer emits per seam, then 'item') and unknownDurations (items runtimeSecFor cannot resolve), and the bench reads delivery.* instead of re-deriving lead offline (W1-19's lead.mjs is not built).

--- From W6-02 ---
1. RunPipelineDeps gains two fields.
   - `onItemReady?: (ev: ItemReadyEvent) => void|Promise<void>`.
   - `wallClockMs?: () => number`, defaulting to Date.now. It is deliberately NOT called `now`: options.now is the deterministic stamp clock that forayIdFor seeds from (runPipeline.ts:905-912).
   - pipelineStartMs (:912) and the ttlA1Ms read (:1490) switch to deps.wallClockMs.
2. The ForayStitcher onActReady wrapper (runPipeline.ts:1488) is constructed today only when deps.onActReady is supplied.
   - Construct it when EITHER hook is supplied.
   - buildPartialCandidate (two finalize runs per act) still runs only when deps.onActReady is given.
   - Item servability comes from W6-01 assessAct, which needs no finalize.
3. The event: `ItemReadyEvent = { forayId, index, itemId, actIndex, check, servable, readyAtMs /* since pipelineStartMs */, playStartSec, durationSec, item: ForayItem }`.
   - playStartSec = runtimeSecFor(itemsBefore, runtimePool) (runPipeline.ts:545).
   - durationSec = runtimeSecFor([item], runtimePool).
   - runtimePool already includes this run's minted segments, so tier-2 clips resolve.
   - Emit the prelude once, before act 0's items. Then emit each NEW item of the act in order.
4. `options.emitPreludeEarly` (default false) emits the prelude right after the spine stage. Everything it needs exists there: intent.subject, spine.overview and slots[0]. Keep it off until QK-24 covers the overview, which is written before any tape.
5. Add `ForayStitcher.emitSeamItems(actIndex, items, provenance)`, unit-tested now with no production caller. The writing workstream's streamed writer (R1-06) will call it per seam, and the event contract does not change.
6. New pure module backend/src/generation/deliveryTimeline.ts with class DeliveryTimeline:
   - record(ev)
   - firstItemReadyMs, firstServableReadyMs, allItemsReadyMs
   - `leadReport({firstAudioAtMs = firstServableReadyMs, rate})`. For each servable item: arrival = firstAudioAtMs/1000 + playStartSec/rate, and leadSec = arrival - readyAtMs/1000. It returns {minLeadSec, itemsBelow30s, lateItems[], pausedAtIndex?}.
   - Report at rate 1 and at rate 1.5.
7. generateForays.ts:
   - generateOneCandidate wires one DeliveryTimeline per attempt into the runPipeline deps (:685).
   - ReportEntry (:433) gains `delivery?: {firstItemReadyMs, firstServableMs, allItemsReadyMs, minLeadSec, minLeadSecAt1_5x, itemsBelow30s, items, pausedAtIndex, resumed?:true}`.
   - A resumed attempt has banked acts that never fire events, so it reports `resumed:true` and omits lead and first-item times, mirroring the ttlA1Ms rule.
   - Absent stays absent, never zero (bench rule 1).

--- From W1-06 ---
New module backend/src/generation/readiness.ts. It uses currentRunLog() and does not edit runLog.ts.
- `emitActReady({actIndex, itemIds, partialOk})`
- `emitItemReady({itemId, actIndex})`, exported for R1-15
- Both append a ReadyEvent with readyMs since log t0.

runPipeline.ts: the ForayStitcher (:1482-1545) always gets an onActReady wrapper.
- It emits an act ReadyEvent with the item ids new since the previous act. Act 0 includes the disclosure prelude id from preludeItem.
- It then runs today's body only when deps.onActReady is supplied: ttlA1Ms, buildPartialCandidate, dropStaleSourcing and the RefusedPartialError exit stay exactly where they are now.
- partialOk is candidate.validation.ok when a partial was built, else null.

**Files edited:**

- backend/src/generation/runPipeline.ts
- backend/src/generation/stitchForay.ts
- backend/src/cli/generateForays.ts
- backend/test/runPipeline.test.ts
- backend/test/stitchForay.test.ts
- backend/test/generateForays.test.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/deliveryTimeline.ts
- backend/test/deliveryTimeline.test.ts
- backend/src/generation/readiness.ts

**Acceptance:**

- For a 3-act stub run with onItemReady and no onActReady: onItemReady fires exactly once per item, indexes run 0..n-1 strictly increasing with the prelude first, and no finalize call happens for partials.
- With an injected wallClockMs, minLeadSec equals the hand-computed value for a scripted fixture (items ready at known ms, with known durations).
- report.json entries carry delivery.* for a completed fresh run. A run with resumed acts carries delivery.resumed:true and no lead.
- An unservable act sets pausedAtIndex, and its items are excluded from the lead because they never play.
- forayIdFor output is unchanged: options.now is untouched.
- With stub builders and no deps.onActReady, runPipeline emits one act ReadyEvent per act, in order. Their itemIds, concatenated, equal the final candidate's items (prelude first).
- A resumed stitch emits no ReadyEvent for that act, matching ttlA1Ms's existing 'not measured' rule.
- On a synthetic 2-act Foray, leadReport returns a negative minLeadSec when act 2 is ready after act 1's audio would end, and the expected positive value when it is ready early (from W1-19).

**Tests.** From W6-02: - deliveryTimeline.test.ts: fake clock, synthetic events, and edge cases (no servable item, lead below 30 s, an unservable middle act, rate 1.5).
- runPipeline.test.ts: a counting onItemReady with stub builders and an injected wallClockMs; a finalize spy proves no partial finalize runs without onActReady.
- stitchForay.test.ts: emitSeamItems ordering.
- generateForays.test.ts: an injected runPipeline that emits events, plus the report row shape.
- Add a floor for the new suite.
From W1-06: cd backend && npx vitest run test/runPipeline.test.ts (new readiness cases plus the existing :637 onActReady cases)

**Flag.** The hook is optional and the report field additive. emitPreludeEarly defaults to false.

**Live step.** Read minLeadSec on the first keyed local run (Spark/LiteLLM) once the provider workstream's Qwen path exists.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** W6-02: - The lead assumes playback starts at the first servable item and that the phone voice can start at once (OQ-03).
- Act-level bursts make the lead look worse than the streamed path will. That is honest until R1-06 lands.
- runtimeSecFor contributes 0 for an unresolvable segment, so playStartSec can be under-estimated, which makes the lead optimistic. Count such items in the report.
- Governed path (backend/src).
W1-06: The delivery workstream (R1-15, GP-07) and the writing workstream (R2-13 per-act gate) both edit this onActReady block. Land this first, and those cards keep the emitActReady call and add emitItemReady at item granularity. MT-11 at act granularity understates lead problems inside an act until then.

#### GV-34 · Numbers, dates and names checked by code against a sentence's sources (spoken-number normaliser plus proper-noun extractor)

- **From:** W5-10
- **Wave:** 6 · **Size:** M · **Depends on:** GV-10, GV-15
- **Covers:** R2-09, R1-07

**Goal.** Jev is weak on counting, arithmetic and dates (LM-23). Code must check that every year, number and proper noun in a narration sentence appears in a source the sentence may rest on.

**Design.**

New pure module backend/src/generation/specifics.ts:
- spokenNumberValues(text): reads both word and digit forms. 'nineteen sixty-four' gives 1964, 'two thousand and eight' 2008, 'forty percent' 40%, 'three point five million' 3.5e6, 'a dozen' 12, and digit forms like '1,964' and '40%'.
- extractSpecifics(sentence, {allowNames}) returns {numbers, years, names}.
  - Small cardinals up to 10 without a unit, and ordinals, are exempt (configurable).
  - Names are capitalised runs that are not sentence-initial, or sentence-initial but not in a common-word list. Possessives are stripped and allowNames removed. extractNames is exported for W5-15.
- unsupportedSpecifics(sentence, sourceTexts, opts) returns string[].
  - A number or year is supported when its value appears among the values parsed from any source.
  - A name is supported when its canonicalizeForAnchorMatch form (types/anchorText.ts) appears, or, for a multi-word name, its longest token of 4 letters or more does. This tolerates ASR lowercasing.

Uses:
1. W5-09 calls it per sentence against that sentence's candidate sources. This is the authoritative use.
2. writeAct.ts validateSeam (:865), with a new gateConfig key specifics (FORAY_SPECIFICS_CHECK = off|report|enforce, default report):
   - Every sentence (W5-17 splitter) is checked against the act's source texts. validateSeam's actScope (:870) gains texts, built in mechanicalPass (:522) from actSourceQuotes, the clip windowTexts and the ground scripts.
   - allowNames = the act's clip shows and episode titles.
   - In 'enforce' mode an unsupported specific becomes a mechanical issue naming it.
   - 'report' does nothing in writeAct.
3. Metrics are computed resume-safe. NarrationWriteStats (writeNarration.ts:228) is not checkpointed, so a resumed act would lose counts kept there. Instead buildVeracityMetrics computes specificsUnsupported from each final page's script against that page's own held evidence texts (NarratedBeat.evidence). VeracityMetrics gains specificsUnsupported: number | null and specificsDetails.

**Files edited:**

- backend/src/generation/writeAct.ts
- backend/src/generation/veracityMetrics.ts
- backend/src/generation/gateConfig.ts
- test/suite-integrity.test.js
- backend/test/actNarration.test.ts
- backend/test/veracityMetrics.test.ts

**New files:**

- backend/src/generation/specifics.ts
- backend/test/specifics.test.ts

**Acceptance:**

- specifics.test.ts has at least 40 table cases:
- digit vs word years;
- 'the nineteen-eighties' vs '1980s';
- percent;
- ranges;
- lowercase ASR names ('joe couitt' supports 'Joe Couitt');
- a sentence-initial common word that is not a name;
- an unsupported year flagged.
- actNarration.test.ts:
- enforce mode re-asks a seam that states a year absent from every act source;
- the same seam with the year present in the clip window passes;
- report mode leaves rounds and text unchanged.
- veracityMetrics.test.ts: specificsUnsupported is computed from page evidence and is identical after a resumed narrate stage.

**Tests.** Vitest specifics.test.ts (pure), plus additions to actNarration.test.ts and veracityMetrics.test.ts.

**Flag.** FORAY_SPECIFICS_CHECK defaults to report, which is metrics only. The check always applies inside the Jev verifier (W5-09).

**Live step.** In report mode, run two fresh golden prompts on the founder PC and read the flagged sentences to count false positives before switching to enforce.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Name false positives are expected: show names spoken in a bridge, common capitalised words ('Internet'), ASR misspellings. Measure in report mode first. Paraphrased figures ('roughly half' for '48%') are accepted false negatives. Collides with R1-06's per-seam writer refactor of validateSeam (writer workstream), so respect W5-02's merge order.

#### GV-35 · Model-swap decision rule, adopted-stack file and append-only swap ledger

- **From:** W7-01
- **Wave:** 6 · **Size:** S · **Depends on:** none
- **Covers:** R2-21, GP-27

**Goal.** Write down how a stage swap or a quality lever is decided, and where each decision is recorded, before any model runs. The rule then becomes something a tool can apply, and the ledger something a reader can audit. The protocol is reworked so it runs under the zero-Anthropic rule.

**Design.**

1) docs/curation/model-swaps.md holds the protocol.
(a) Unit of evidence: an ARM PAIR. The same golden prompt is generated under arm A (the adopted stack) and arm B (exactly ONE stage assignment or ONE lever changed). Both arms share the commit, the corpus fingerprint (R2-02, eval workstream; 'unfrozen' until it lands) and the duration tier.
(b) Required evidence: the 10 listened golden prompts. The founder scores act 1 of both arms blind on the R2-01 card (4 axes 1-5, a preference A/B/even, a wince list). R2-21's comment costs a stage swap at 2 x 10 runs. The 40 scored golden prompts are OPTIONAL extra scorecard evidence; when present they feed the scorecard checks below.
(c) Decision rule. The constants and the function live in tools/generation-bench/swap-rule.mjs, as decideSwap(evidence, {bands}). ADOPT requires ALL of these:
- pairwise wins(B) + ties >= wins(A) over the listened prompts;
- no card axis mean for B is more than 0.5 below A;
- MQ-01 == 1 and MQ-04 == 0 hold on at least as many prompts for B as for A;
- run success (MQ-21) for B >= A minus 1 per 10 prompts;
- MQ-02 and MQ-05 means are within the band passed in (GEN-05; PROPOSED until it lands);
- timing: the changed stage's p50 is not above A's by more than its slack. The spine best-of-2 slack is 3,000 ms. Only the changed stage and later stages are compared, because a seeded arm B (W7-03) marks upstream stages resumed.
A metric absent in BOTH arms is recorded 'unmeasured' and does not block. A metric present in A but absent in B fails.
HOLD: the pairwise result is even or better but a check fails. REJECT: wins(A) > wins(B) + ties. MEASURED: the kind used by E0.
(d) E0 (GP-27 floor) compares all-Qwen output with the committed Claude-written reference (the 4 generated Forays in data/forays.json, prompts reconstructed by R2-02) and records the gap. No Claude arm is ever generated.
(e) Experiment order:
- E0: floor, every stage on Qwen3.8-27B on the Spark, levers off, a non-Anthropic verifier from the gates workstream;
- E1: deepen moved to the P40 35B-A3B;
- E2: continuity moved to the P40;
- E3: writer exemplars on/off;
- E4: spine best-of-2 on/off;
- E5: self-critique (behind the playhead) on/off;
- E6: verifier Jev vs Qwen-judge;
- E7: writer acts 2+ on the second box, only if OQ-01 settles on V100s and the one-voice ruling is revisited;
- fine-tune last (W7-10).
The doc says why this differs from the reviewers' order: no Claude arm is possible.
(f) Who decides: the tool computes the verdict from the founder's cards and the scorecard; the orchestrator commits the row; a production default changes only through a PR that cites the ledger row id.
2) tools/generation-bench/swaps/ledger.jsonl is append-only. tools/generation-bench/swap-ledger.mjs provides validateLedgerRow, appendLedgerRow and renderLedgerTable. Row fields: id, experiment, kind (stage|lever|measure), stage?, lever?, armA {stack, levers}, armB {stack, levers}, commit, goldenSetId, corpusFingerprint|'unfrozen', runDirs, pairwise {wins, ties, losses, listener, listenedOn, packId}, axisMeans {A, B}, scorecardDelta, timingDelta, checks [{name, result: pass|fail|unmeasured}], decision (adopt|hold|reject|measured), supersedes?, notes. A correction is a new row carrying supersedes; rows are never edited. An 'adopt' row with corpusFingerprint 'unfrozen' is refused.
3) tools/generation-bench/swaps/adopted-stack.json maps each stage to {impl, model, machine}, plus levers {exemplars, spineBestOf, selfCritique} and the ledgerRow id. Arm A is built from it (W7-04). It starts as {} with a note that no non-Anthropic stack has been measured.
4) renderLedgerTable splices a table into model-swaps.md between marker comments, using the run.mjs spliceRows / ROWS_BEGIN pattern (run.mjs:636,663).

**Files edited:**

- test/suite-integrity.test.js

**New files:**

- docs/curation/model-swaps.md
- tools/generation-bench/swap-rule.mjs
- tools/generation-bench/swap-ledger.mjs
- tools/generation-bench/swap-ledger.test.mjs
- tools/generation-bench/swaps/ledger.jsonl
- tools/generation-bench/swaps/adopted-stack.json

**Acceptance:**

- model-swaps.md states the rule, the E0-E7 order, why the reviewers' order is replaced (zero-Anthropic), and who decides
- decideSwap returns adopt, hold, reject or measured for each branch and names every failing or unmeasured check
- Bands are a parameter; with no band supplied, the MQ-02/MQ-05 checks are reported 'unmeasured', never 'pass'
- validateLedgerRow rejects a row missing commit or pairwise counts, an 'adopt' row on unfrozen evidence, and a reused id without supersedes
- renderLedgerTable output is byte-stable for the same ledger
- test/suite-integrity.test.js has a FLOORS entry for swap-ledger.test.mjs

**Tests.** node --test tools/generation-bench/swap-ledger.test.mjs with synthetic evidence covering: a pairwise win, tie and loss; an axis drop over 0.5; an MQ-04 regression; timing over slack; a metric absent in one arm vs both arms; the measure kind; append and supersede; table rendering. No network, no models.

**Flag.** none (docs and tools only; nothing in generation reads it)

**Live step.** none

**Founder need.** none

**Risk.** The bands and the golden set come from the eval workstream (GEN-05, R2-02). Until they land, the rule can only produce hold, reject or measured rows on unfrozen evidence, which is the intended behaviour. OQ-09 (the founder listens) is an adopted default and is not asked again.

#### GV-36 · Blind pair listening pack: builder plus a self-contained local listening page (no app UI)

- **From:** W1-17
- **Wave:** 6 · **Size:** M · **Depends on:** GV-08
- **Covers:** R2-01, QK-30, GP-20, MQ-20

**Goal.** Let the founder hear act 1 of one candidate (the QK-30 first listen of the 14 Sep run) or of two candidates blind, without publishing to data/forays.json and without touching app.js, styles.css or index.html.

**Design.**

tools/listening/pack.mjs
Flags: `--a <candidate.json> [--b <candidate.json>] --act 1 --out <dir> [--seed n] [--segments data/segments.json] [--sources data/segment-sources.json] [--key-dir data-local/listening/keys]`.

Building the pack:
- It extracts the act's items: the disclosure, then the items up to the next act introduction.
- Each segment resolves to {enclosureUrl, startSec, endSec, daiVariable}, from candidate.segments and candidate.segmentSources, then the committed data.
- Each narration item resolves to {script, audioUrl?}.
- With --b, the A/B assignment uses a seeded RNG. Without --b the pack is 'solo'.

Outputs:
- `pack.json`: labels and items only, with no candidate id, provider, model or file name. It records which narration voice will be used.
- `listen.html`, self-contained, with inline CSS and JS and no external scripts:
  - one <audio> seeks to startSec and pauses at endSec for clips
  - narration plays audioUrl when rendered, else window.speechSynthesis (phone voice, OQ-03)
  - one card form per version follows listen-card/1, with an elapsed-time stamp button for winces
  - 'Copy card JSON' and 'Download' buttons
  - a 'times may drift' badge on DAI-variable segments
- `<packId>.key.json` goes to --key-dir, never to --out.

**Files edited:**

- test/suite-integrity.test.js

**New files:**

- tools/listening/pack.mjs
- tools/listening/pack.test.mjs
- tools/listening/fixtures/pair/a.json
- tools/listening/fixtures/pair/b.json

**Acceptance:**

- On two synthetic candidates, pack.json and listen.html contain no candidate id, provider or file-name string.
- The key file exists only under --key-dir.
- The same seed gives a byte-identical pack.
- Solo mode works on the out-9 fixture candidate; narration without a script is shown as 'script not in fixture'.
- listen.html has no external URL other than the clip enclosures and rendered narration.
- Card JSON copied from the page passes validateCard (the test exercises the page's card builder function exported for test).
- No change to app.js, styles.css or index.html.

**Tests.** node --test tools/listening/pack.test.mjs, using synthetic candidates and sources (short synthetic scripts, no transcript text) plus the out-9 fixture.

**Flag.** none; an offline tool producing local files

**Live step.** (1) On the founder PC, build a solo pack from backend/data-local/foray-candidates/<14 Sep candidate>.json. The founder listens to act 1 (~10 min) and pastes the card JSON, which is appended to cards.jsonl; this closes QK-30. (2) Once R2-21 produces Qwen candidates for the 10 listened golden prompts, build 10 pair packs (~40 min of listening).

**Founder need.** His ear: ~10 min for the first solo listen, ~40 min for the 10 blind pairs.

**Risk.** speechSynthesis voices differ from rendered narration and from phone to phone. pack.json records the voice used, and rendered audio_url is preferred once R1-13/R2-18 exist. Media seeking on DAI-variable enclosures can land on ads; the badge warns, and the pack prefers non-DAI episodes when there is a choice.

### Wave 7

#### GV-37 · Wire routing into the seven stage factories and decouple live mode from ANTHROPIC_API_KEY

- **From:** W2-08, W7-02
- **Wave:** 7 · **Size:** S · **Depends on:** GV-03, GV-25, GV-31
- **Covers:** R2-21, HW-12, GP-06

**Goal.** Make the per-stage switch real. Each create*.ts factory today chooses Stub or Anthropic on env.anthropicDryRun alone (createSpineBuilder.ts:12-19). It should instead pick stub, anthropic-legacy or a Chat* builder on a lane from resolveRouting, and fail fast instead of silently stubbing a keyless local run.

**Design.**

INTEGRATION NOTE (W7-02's factory half): each create*.ts registers its built-ins (stub, anthropic, local) and returns instantiateStage('<stage>') (GV-03); RunPipelineDeps injection (runPipeline.ts:992-999) still wins. Tests swap the 'anthropic' registration for a sentinel, so no test constructs an Anthropic* builder.

1. New module backend/src/generation/chat/providerRegistry.ts.
- getChatProvider() lazily builds one OpenAICompatChatProvider per process from FORAY_LLM_BASE_URL and the key.
- __setChatProviderForTests() makes it resettable.
- W2-09 later wraps the provider with the LaneScheduler here.

2. The factories switch on routeFor(stage):
- 'stub' returns the existing Stub.
- 'anthropic' keeps the existing lazy require.
- 'local' returns the Chat* class with getChatProvider() and targetFor(route, profile).
- The factories are createPromptUnderstander, createSpineBuilder, createDeepenActBuilder, createNarrationWriterBuilder, createNarrationVerifierBuilder and createContinuityBuilder.
- createExternalResearcher handles stub, anthropic AND 'none' here: this card adds backend/src/generation/NullExternalResearcher.ts (moved from W2-10/GV-61: providerName 'none', research() resolves {notes:'', controversies:[]} with no I/O, no retrievePassages) and registers it under 'none' in a few lines of createExternalResearcher.ts. GV-03 makes 'none' the local-mode research default, and runPipeline.ts:992-999 calls createExternalResearcher at pipeline start, so without this registration every FORAY_GENERATION_MODE=local run would throw RoutingConfigError before GV-61 lands. 'dossier' throws a clear 'not built' error until GV-69. GV-61 keeps the shared researcher, the cache rule, topicNodeIds and printEvidenceSkipped.

3. resolveRouting runs once per factory call against process.env. Its RoutingConfigError surfaces at pipeline start, because runPipeline.ts:992-999 calls every factory before the first stage.

**Files edited:**

- backend/src/generation/createPromptUnderstander.ts
- backend/src/generation/createSpineBuilder.ts
- backend/src/generation/createDeepenActBuilder.ts
- backend/src/generation/createNarrationWriterBuilder.ts
- backend/src/generation/createNarrationVerifierBuilder.ts
- backend/src/generation/createContinuityBuilder.ts
- backend/src/generation/createExternalResearcher.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/chat/providerRegistry.ts
- backend/src/generation/NullExternalResearcher.ts
- backend/test/stageFactories.test.ts

**Acceptance:**

- Without FORAY_LLM_BASE_URL every factory returns what it returns today, and createPromptUnderstander.test.ts passes unchanged.
- With FORAY_LLM_BASE_URL and FORAY_STAGE_SPINE=local:spark, only createSpineBuilder returns ChatSpineBuilder.
- With FORAY_GENERATION_MODE=local every model stage returns a Chat* builder on its default lane, and a local-mode factory call for research returns NullExternalResearcher (providerName 'none') without throwing.
- A stage routed 'local' without FORAY_LLM_BASE_URL throws RoutingConfigError and never falls back to a Stub.
- FORAY_STAGE_WRITER=stub with an ANTHROPIC_API_KEY set returns StubNarrationWriterBuilder while the other stages resolve as before (from W7-02).
- No test constructs an Anthropic* builder: the 'anthropic' registration is swapped for a sentinel in tests.

**Tests.** Run `npx vitest run test/stageFactories.test.ts`, then `npx vitest run test/createPromptUnderstander.test.ts`. The env is injected through resolveRouting(source); a factory test variant takes an optional source argument, never mutating process.env globally.

**Flag.** Default inference keeps today's behaviour until FORAY_LLM_BASE_URL or FORAY_GENERATION_MODE=local is set.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** If a developer shell has FORAY_LLM_BASE_URL set, suites that call the factories change behaviour; the same is already true of ANTHROPIC_API_KEY. Document it in generation-providers.md (W2-15). Governed path.

#### GV-38 · Act writer sees its act introduction and exit, the previous act's exit, start and end states, the overview, and earlier acts' verified pages

- **From:** W4-08
- **Wave:** 7 · **Size:** S · **Depends on:** GV-15
- **Covers:** QK-26, GP-24

**Goal.** Close QK-26: the writer never saw its own act's introduction and exit, or any other act's prose. Add sequential act writing, so acts 2+ are written to follow act 1 rather than stitched after the fact (R2's guard on R1-04).

**Design.**

1. NarrationWriterBuilder.ts ActWriteRequest (:192) gains optional `frame?: ActFrame`:
   ActFrame = {actIntroduction; actExit; previousActExit?; startState; endState; forayOverview?; actIndex; totalActs}.
2. Thread the frame through. writeAct.ts WriteActOptions (:193) gains `frame?` and passes it on every round's request (:399). writeNarration.ts WriteNarrationOptions gains `frames?: ActFrame[]`, threaded next to ground (:568).
3. runPipeline.ts builds the frames from `deepened` and the spine: act i's introduction and exit, act i-1's exit, the spine act's startState and endState, and spine.overview for act 0.
4. buildActWritePrompt (AnthropicNarrationWriterBuilder.ts:289) gets an ACT FRAME block before the layout:
   - what the listener has just heard: the previous act's exit, then this act's introduction;
   - where the act must leave them: endState, and the exit that follows the last seam;
   - rules: do not repeat the introduction or the exit; the first seam follows the introduction; the last seam hands into the exit; do not re-introduce what the previous act established.
   Without a frame the prompt is byte-identical to today's.
5. narrationOrder 'sequential' makes ground useful.
   - In the classic driver the act gate limit is 1. Under W4-07 the act chain enforces the order.
   - Today settledActs[j] is assigned in a separate p.then (runPipeline.ts:1652-1659), which races with the next act's ground() read (writeNarration.ts:568). Move the assignment inside the narrate:<i> task, just before it returns, so act i+1 always sees act i's verified pages.
6. The stub writer ignores the frame.

**Files edited:**

- backend/src/generation/NarrationWriterBuilder.ts
- backend/src/generation/writeAct.ts
- backend/src/generation/writeNarration.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/AnthropicNarrationWriterBuilder.ts
- backend/test/actNarration.test.ts
- backend/test/runPipeline.test.ts
- test/suite-integrity.test.js

**New files:**

- backend/test/actFrame.test.ts

**Acceptance:**

- Each act's ActWriteRequest carries the frame with the deepened act's introduction and exit and the previous act's exit (none for act 0). The wrapped stub writer captures it.
- buildActWritePrompt contains the ACT FRAME block with every field, and without a frame it is byte-identical to today's.
- narrationOrder 'sequential' on a 3-act stub run: act 2's request.ground contains act 1's verified pages on every run (repeat 20 times). With 'parallel' (the default) the first wave sees none, as today.
- With narrationOrder unset, runPipeline.test.ts output is unchanged.

**Tests.** vitest actFrame.test.ts (request plumbing, prompt block, deterministic sequential ground) and actNarration.test.ts prompt-pin additions.

**Flag.** The frame is sent only when FORAY_NARRATION_ORDER is set or under the fast path; otherwise the request is unchanged. narrationOrder defaults to 'parallel'. The settledActs move is behaviour-neutral for 'parallel'.

**Live step.** Pairwise listen on medium golden prompts: sequential with frame against parallel without. Score MQ-12 seam coherence and the R2-01 card's 'flows at the seams' axis.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Sequential writing lengthens whole-Foray time on medium. The prose all runs on one Spark anyway (R2's ruling on R1-08), so the cost is mostly lost overlap with checks. Keep 'parallel' selectable and let the 4-minute medium target decide. The frame's introduction and exit are unverified text (QK-24, owned elsewhere); telling the writer not to repeat them also keeps their claims from spreading.

#### GV-39 · Corpus fingerprint and prompt-set identity in report.json (golden-set snapshot)

- **From:** W1-13
- **Wave:** 7 · **Size:** S · **Depends on:** GV-26
- **Covers:** R2-02

**Goal.** Freeze the golden set with a corpus snapshot, so that a transcript or index change cannot pass for a pipeline change. Every report records exactly which corpus and which prompt file it ran against.

**Design.**

transcriptCorpus.ts:
- `corpusFingerprint({archive, hasBody, indexVersion, extra?})` returns {sha256, rows, rowsHashedBySize, shows, indexVersion, extra}.
- sha256 is taken over the sorted lines `${show_id}\t${guid}\t${sha256 ?? 'bytes:'+bytes ?? ''}` of archive rows whose body is on disk. Committed digests carry sha256 and bytes; machine-local corpus-digest rows may not.
- indexVersion is TRANSCRIPT_TEXT_INDEX_VERSION (transcriptTextIndex.ts:69).
- `extra` is the hook for the passage-index checksum (R1-09).

generateForays.ts main (:887-898, writeReport :922-947):
- Compute the fingerprint beside corpusCoverage and write `report.corpus.fingerprint`.
- Write `report.prompts = {file: basename, sha256 of the file bytes, count}`.

**Files edited:**

- backend/src/generation/transcriptCorpus.ts
- backend/src/cli/generateForays.ts
- backend/test/transcriptCorpus.test.ts
- backend/test/generateForays.test.ts
- test/suite-integrity.test.js

**New files:**

- none

**Acceptance:**

- The fingerprint does not depend on archive order.
- Changing one row's sha256 changes it, and so does removing a body from disk.
- An archive with no bodies gives rows 0 and a stable empty hash.
- A non-dry run with --prompts writes prompts.sha256 matching the file, and corpus.fingerprint when bodies exist.

**Tests.** backend vitest: transcriptCorpus.test.ts and generateForays.test.ts, with a tmpdir corpus and synthetic digests

**Flag.** none; additive report fields

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Rows hashed by size are weaker, so the count is reported. The W1-09 dependency is merge order: the batch-summary region (:910) and writeReport (:922) are adjacent hunks.

#### GV-40 · Streaming (SSE) on the OpenAI-compatible provider, with true TTFT and partial text on error

- **From:** W2-02
- **Wave:** 7 · **Size:** S · **Depends on:** GV-13
- **Covers:** HW-12, GP-06

**Goal.** Build the streaming half of the provider layer that HW-12 says is missing. The writing workstream's streamed JSONL writer (R1-06/R2-08) and the timers' TTFT (MT-04) then have a tested transport.

**Design.**

INTEGRATION NOTE: streamed calls also record ttftMs (first content delta) and queueMs into the CallRecord of GV-07.

New module backend/src/generation/chat/sse.ts: parseSse(byteStream) returns AsyncIterable<string>. It handles a split inside a line, CRLF, ':' comments, multi-line data and 'data: [DONE]'.

OpenAICompatChatProvider.stream(req) sends stream:true and stream_options:{include_usage:true}. It yields ChatStreamEvent:
- {type:'delta', text} for each choices[0].delta.content. Reasoning deltas are dropped.
- {type:'done', finishReason, usage (null when the server sends no usage chunk), model, requestId, timing}.

timing.firstByteAt is the first non-empty content delta. A mid-stream failure throws ChatProviderError with partialText set to everything received so far, so a consumer can keep the seams that finished (the R1-06 rule). finish_reason 'length' arrives on done and is never thrown. An AbortSignal cancels the read. Observers fire once at the end.

fakeChatProvider.ts (from W2-01) gains stream scripts: [{chunks:[{text, delayMs}], finish, usage}], driven by vitest fake timers.

**Files edited:**

- backend/src/generation/chat/openAICompatProvider.ts
- backend/src/generation/chat/ChatProvider.ts
- backend/test/helpers/fakeChatProvider.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/chat/sse.ts
- backend/test/sse.test.ts
- backend/test/openAICompatStream.test.ts
- backend/test/fixtures/openai/stream-jsonl.txt
- backend/test/fixtures/openai/stream-length.txt

**Acceptance:**

- parseSse yields identical events whether the fixture arrives in one chunk or one byte at a time; a fast-check property randomises the split points.
- stream() yields deltas in order, then exactly one done event. Usage comes from the include_usage chunk, or is null when that chunk is missing. Under fake timers firstByteAt equals the first content delta's time.
- A drop after N deltas throws ChatProviderError whose partialText equals the concatenated deltas.
- finish_reason 'length' is reported on done and not thrown.
- scriptedProvider replays a JSONL writer reply line by line with delays, shown by a self-test.

**Tests.** `npx vitest run test/sse.test.ts`, then `npx vitest run test/openAICompatStream.test.ts`. fast-check is already a devDependency.

**Flag.** Inert: nothing calls provider.stream until the writing workstream's streamed writer.

**Live step.** Stream one neutral JSONL reply from local-heavy through LiteLLM. Record TTFT and whether include_usage is forwarded, and commit the result as fixtures/openai/recorded-stream.txt. Then measure the prose-in-JSON decode rate.

**Founder need.** founder-approved label (orchestrator applies); plus LiteLLM key (#1163) for the live capture.

**Risk.** Some LiteLLM versions re-chunk SSE or omit usage in streams; this is handled by reporting usage as null. Governed path.

#### GV-41 · Review queue ordered by scorecard risk, per-act review cards, and verdict capture as labelled examples

- **From:** W6-16
- **Wave:** 7 · **Size:** S · **Depends on:** GV-08
- **Covers:** R2-19

**Goal.** Make the founder's hold review cheap and useful. Rank local candidates by risk, show each act as a card, and append every verdict to a JSONL that Jev threshold calibration (LM-24) and later few-shot or fine-tune work can read.

**Design.**

New tools/generation/review-queue.mjs with three subcommands:
- `list --dir <candidates dir>` reads report.json entries[].veracity (veracityMetrics.ts:819 fields) and spineReasks, plus the candidate files named by entries[].file.
- `card <forayId> [--act N]` prints a markdown card per act: the act title, every narration script in order, every clip (show and episode titles from the candidate's segmentSources, start-end, boundary), and the act's metrics.
- `verdict <forayId> --act N --verdict pass|fail|fix --scores onSubject=4,flowsAtSeams=3,oneNarrator=5,nothingFalseOrOdd=4 [--wince 132:'text'] [--out data-local/review/verdicts.jsonl]`. The axis names, the 1-5 range and the score validation are IMPORTED from tools/listening/card.mjs (GV-08); review-queue.mjs defines no axis list of its own.

Risk order is lexicographic:
1. unverifiedPages > 0
2. groundedQuoteRate < 1
3. purposeFidelity ascending, with null worst
4. clipOnSubjectRate ascending when present (gates workstream), otherwise tapeRelevance
5. retryRounds descending
6. spineReasks.length descending

Verdict row: {schema:'foray-review-verdict/1', forayId, act, candidateSha256, lane, verdict:'pass'|'fail'|'fix', scores:{onSubject, flowsAtSeams, oneNarrator, nothingFalseOrOdd} (1-5, the listen-card/1 axes, validated by card.mjs), winces[{atSec,note}] (the listen-card/1 wince shape), reviewer:'founder', at}. It embeds the listen-card/1 axes and adds only the act verdict and candidateSha256.
- One store per purpose: committed founder LISTENING cards (blind packs, R2-01) go to docs/curation/listening/cards.jsonl (GV-08); per-act REVIEW verdicts (R2-19) go to data-local/review/verdicts.jsonl (this card), with the same axes. GV-81, GV-94's calibration, GV-103 and GV-114 read verdicts from this one schema.
- The row holds no prompt.
- report.json rows do carry `prompt` (ReportEntry :433), and the tool never copies it.

**Files edited:**

- test/suite-integrity.test.js

**New files:**

- tools/generation/review-queue.mjs
- tools/generation/review-queue.test.mjs
- tools/generation/fixtures/review/report.json
- tools/generation/fixtures/review/candidate-a.json

**Acceptance:**

- On the out-9 report plus a synthetic report, a candidate with unverified pages ranks first.
- On a synthetic candidate fixture that has scripts, the card lists every narration script and every clip of the act in play order. The committed out-9 candidate is trimmed and has no scripts, so it is not used for this.
- verdict refuses an axis outside 1-5, an axis name card.mjs does not define, or an act index that does not exist, and otherwise appends exactly one JSON line whose scores object passes card.mjs's score validation.
- candidateSha256 is the sha of the candidate file as read, and no output contains the report's prompt field.

**Tests.** review-queue.test.mjs (node:test), using tools/generation-bench/fixtures/out-9/report.json for ranking plus synthetic fixtures for cards and verdicts. Add the floor.

**Flag.** A new tool, not on any automatic path.

**Live step.** The founder reviews the 14 Sep candidate and the next Qwen-built candidates through the queue, producing the first labelled verdicts.

**Founder need.** Founder listening time per Foray, which D7 already requires.

**Risk.** - Settled in planning: the verdict row reuses the listen-card/1 axes and validation from tools/listening/card.mjs (GV-08, a dependency), so the two schemas cannot diverge.
- The verdict JSONL lives in gitignored data-local unless the founder wants it committed.

#### GV-42 · Exemplar miner: code-scored voice exemplar shortlist from committed Forays and local candidates

- **From:** W7-05
- **Wave:** 7 · **Size:** S · **Depends on:** GV-10
- **Covers:** R2-17

**Goal.** Supply R2-17's few-shot step with exemplars chosen on evidence. The '7 Claude-written Forays' are 3 clip-only curated Forays (0 narration) plus 4 pre-Q-03 per-beat Forays. Those 4 hold 157 narration items (4 of them disclosure markers) across 16 acts, and the founder called them clunky (listening-quality-plan.md:22-46). The miner scores every seam in code; the founder's ear picks 2 exemplars and the voice card.

**Design.**

tools/generation/exemplars/mine-exemplars.mjs:
- Input: --forays (default data/forays.json; Forays with generated:true only) plus a repeatable --candidate <file> (any forays.json-shaped candidate, e.g. the founder-uploaded 14 Sep candidate or Qwen outputs that won a pairwise listen).
- Unit: a SEAM RUN, the consecutive narration items between two segments, excluding the 'disclosure' item.
- Role tagging:
  - act-introduction / act-exit, from the act-N-introduction / exit ids;
  - full-intro, when the next segment's show (resolved through data/segments.json, then data/segment-sources.json) has not played earlier in the Foray;
  - bridge, for everything else and for unresolved shows.
- Per-run metrics:
  - words;
  - sentence count, mean, max and short count against check-narration.mjs SENTENCE_MEAN_WORDS [12,15], SENTENCE_MAX_WORDS 25 and SHORT_SENTENCE_WORDS 6 (:104-106);
  - spokenLineErrors(sentence, where, {hasTape:true}) findings (check-narration.mjs:189);
  - narratorStructureLeaks (backend/src/copy/narratorStructure.js:235, a CJS export);
  - an FK grade column from spokenLine.fleschKincaidGrade (backend/src/copy/spokenLine.js, GV-10, loaded through createRequire like narratorStructure.js); sentence splitting and the count, mean, max and short figures also come from spokenLine.splitSpokenSentences and sentenceShape (decision 16), so the miner adds no splitter or readability code of its own;
  - violations, the sum of the counts.
- Output: data-local/exemplars/candidates.json, plus a markdown shortlist with the top 5 per role (fewest violations, then sentence mean closest to 13.5).
- --select <runId> <runId> --voice-card <file> --listened-on <date> --selected-by <name> writes tools/generation/exemplars/narration-exemplars.json: {version: 1, voiceCard: {text, words}, exemplars: [{role, text, forayId, itemIds, sourceKind, provenance: 'claude-pipeline-historic'|'qwen-pipeline', selectedBy, listenedOn}]}. It refuses an exemplar with any finding, more than 2 exemplars, a voice card over 60 words, or a missing selectedBy/listenedOn.
- The committed file starts as {version: 1, voiceCard: null, exemplars: []}.
- Committed Foray text is existing published copy; nothing here calls a model.

**Files edited:**

- test/suite-integrity.test.js

**New files:**

- tools/generation/exemplars/mine-exemplars.mjs
- tools/generation/exemplars/mine-exemplars.test.mjs
- tools/generation/exemplars/narration-exemplars.json

**Acceptance:**

- On data/forays.json it reports 4 generated Forays, 16 acts and 157 narration items (4 disclosure items excluded from seam runs), and skips 3 clip-only Forays
- Roles come from item ids and the shows of neighbouring segments; an unresolved show yields 'bridge'
- --select refuses a run with a check-narration finding or a structure leak, a voice card over 60 words, and a selection without selectedBy/listenedOn
- Output is byte-stable for the same inputs
- Suite floor added

**Tests.** node --test tools/generation/exemplars/mine-exemplars.test.mjs against tools/foray/fixtures/frozen/data/forays.json (what-engineers-actually-do-all-day-e08236, 40 narration items, plus 3 clip-only Forays), with a small synthetic candidate holding a digit, a 30-word sentence and a structure leak.

**Flag.** none (the data file is read only when W7-06's flag is on)

**Live step.** The founder reads or hears the shortlist (phone voice or a render-foray.py render) and picks 2 exemplars and the voice card. Rerun the miner on Qwen golden outputs after E0.

**Founder need.** Pick the exemplars and approve the voice card by ear. Optionally upload the 14 Sep candidate, the only Q-03-era per-act prose, which is not in git.

**Risk.** The only committed prose is the pre-Q-03 style the founder rejected; anchoring Qwen to it could import the clunkiness. The selection is gated on a listen, and E3 can reject the lever. The exemplar file sits in an allowlisted path yet shapes the writer prompt when flagged on, so W7-06's loader ignores a file whose exemplars lack selectedBy/listenedOn.

### Wave 8

#### GV-43 · Streamed writer contract: writeActStream plus an incremental JSONL seam parser

- **From:** W4-09
- **Wave:** 8 · **Size:** S · **Depends on:** GV-02
- **Covers:** R1-06, R2-08

**Goal.** Define the per-act streamed reply as one seam object per line in listening order, and a parser that yields each seam the moment its line closes. It must survive chunk boundaries and a reply cut at the token cap.

**Design.**

INTEGRATION NOTE: the writer reply schemas already moved to replySchemas.ts (GV-02); WRITTEN_SEAM_JSON_SCHEMA is added there as zodToJsonSchema of a line variant of RawWrittenSeamSchema with usedClaims and pronunciationHints required. No writerSchemas.ts.

1. SUPERSEDED (decision 11): no writerSchemas.ts and no hand-built schema. RawClaimSchema, RawWrittenSeamSchema and RawActWriteSchema already live in replySchemas.ts (GV-02). This card adds there RawWrittenSeamLineSchema (RawWrittenSeamSchema with usedClaims and pronunciationHints REQUIRED, R2's condition) and WRITTEN_SEAM_JSON_SCHEMA = zodToJsonSchema(RawWrittenSeamLineSchema) via chat/jsonSchema.ts (GV-02), covering seamId, script, claims[], usedClaims[], pronunciationHints[].
2. New module backend/src/generation/seamStream.ts: class JsonlSeamParser with push(chunk): SeamLineEvent[] and end(): SeamLineEvent[].
   - Events: {type: 'seam', seam: WrittenSeam} | {type: 'bad-line', line, error} | {type: 'unfinished', partial}.
   - It buffers to '\n', skips blank lines and a leading ``` or ```json fence line, then JSON.parses and zod-validates each complete line.
   - end() reports a non-empty unterminated buffer as 'unfinished', never as a seam.
3. NarrationWriterBuilder gains an optional writeActStream?(request, ctx): AsyncIterable<WriterStreamEvent>.
   - WriterStreamEvent = {type: 'seam', seam, atMs} | {type: 'end', stopReason: 'end'|'length', unfinishedSeamIds: string[], usage?}.
   - Exported helper collectActStream(stream) returns Promise<ActWriteResult & {stopReason; unfinishedSeamIds}>.
4. StubNarrationWriterBuilder.writeActStream yields its writeAct seams one by one in request.seams order, with an injectable per-seam delay on the fake clock (constructor option), then 'end'.
5. countingNarrationWriter (runPipeline.ts:1022) forwards writeActStream and counts one call per stream.

**Files edited:**

- backend/src/generation/NarrationWriterBuilder.ts
- backend/src/generation/StubNarrationWriterBuilder.ts
- backend/src/generation/runPipeline.ts
- test/suite-integrity.test.js
- backend/src/generation/replySchemas.ts

**New files:**

- backend/src/generation/seamStream.ts
- backend/test/seamStream.test.ts

**Acceptance:**

- Property test (fast-check ^4.8, as in backend/test/property): a fixture reply of N JSONL seam lines split at every chunk boundary always yields the same N seams in order.
- Escaped newlines inside strings, unicode escapes and a leading fence are handled. A malformed line becomes a bad-line event and later lines still parse.
- A reply cut mid-line yields every completed seam plus one 'unfinished' event, and no exception.
- The stub's writeActStream yields seams in request order, and collectActStream equals its writeAct result.
- The Anthropic writer still parses with the moved schemas, and actNarration.test.ts is green.

**Tests.** vitest seamStream.test.ts (unit and property), a stub stream test, and actNarration.test.ts unchanged.

**Flag.** none. The method is optional and nothing calls it until W4-10's flag.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** JSONL is the reviewers' converged choice (comment c30f5b24). If the provider layer cannot constrain JSONL, lines are still validated one at a time, so a bad line costs that seam rather than a whole-act re-ask. AnthropicNarrationWriterBuilder.ts is also edited by W4-08; whichever lands second rebases.

#### GV-44 · Job snapshot sink (file-backed) and an author-checked read of the servable prefix

- **From:** W6-03
- **Wave:** 8 · **Size:** M · **Depends on:** GV-21, GV-33
- **Covers:** R1-15, GP-07

**Goal.** Publish to a 'job row' what a phone may play, item by item. For now the row is a local file behind an interface, so a Supabase row can replace it later. Fix generationStatus so it reads exactly one file by id.

**Design.**

INTEGRATION NOTE: the per-act servability and act veracity come from GV-21; events from GV-33.

1. New backend/src/generation/jobSink.ts. Types and pure functions only, no fs: promptNoPersistence.test.ts forbids fs writes in generation/ except two named exemptions.
   - `interface GenerationJobSink { publish(s: JobSnapshot): Promise<void>; close(outcome:'complete'|'failed'|'aborted', detail?): Promise<void> }`
   - `JobSnapshot = { schema:'foray-job/1', jobId, forayId, authorId, lane, status:'running'|'complete'|'failed', seq, updatedAt, title, topic, summary, acts:{index,title,status,servable}[], items: ForayItem[] /* ONLY items[0..delivery.servableThrough), an item count, prelude first */, itemStates:{itemId, check, audio:'pending'|'rendered'|'phone-voice', audioKey?}[], runtimeSecSoFar, delivery?: summary }`
   - `snapshotFrom(partialOrEvents, prevSeq)`. The schema has no prompt field. Title, topic and summary are allowed (§9.4 keeps the title).
   - A zod JobSnapshotSchema pins the contract for W6-04 and W6-18.
2. New backend/src/cli/fileJobSink.ts. It sits in cli/ because generation/ may not write files.
   - Writes `<jobDir>/<forayId>.job.json` atomically (tmp file + rename).
   - forayId is validated with /^[a-z0-9-]{1,120}$/.
3. generateForays.ts adds `--job-dir <dir>`.
   - Publish a new snapshot on every onActReady (W6-01 delivery) and every onItemReady (W6-02), then close with the run outcome.
   - `--dry-run` writes nothing.
4. generationStatus.ts:
   - Add `readJobSnapshot(jobDir, forayId, requestingUserId)`. It reads exactly `<forayId>.job.json`, refuses ids that fail the regex, and refuses an author mismatch.
   - Correct readPartialCandidate's header. It claims the function never lists the directory, yet the code readdir-scans every *.partial.json (:62-77). Keep the function, fix the doc, and point new callers at readJobSnapshot.
5. Update docs/curation/player-streaming-brief.md §1-§3 and §5 to the JobSnapshot payload. The player plays only `items`, and the servable prefix replaces §3.5's 'validation is advisory'.

**Files edited:**

- backend/src/cli/generateForays.ts
- backend/src/generation/generationStatus.ts
- docs/curation/player-streaming-brief.md
- backend/test/generationStatus.test.ts
- backend/test/generateForays.test.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/jobSink.ts
- backend/src/cli/fileJobSink.ts
- backend/test/jobSink.test.ts

**Acceptance:**

- A stub run with --job-dir writes <forayId>.job.json whose seq strictly increases and whose final status is complete.
- snapshot.items never contains an item from or after the first unservable act, even when later acts are ready.
- JobSnapshotSchema has no prompt field. A test that uses a stub understander whose title differs from the prompt finds the raw prompt string in none of the written files.
- readJobSnapshot refuses '../x' ids and another author's job. readPartialCandidate behaviour is unchanged.
- promptNoPersistence.test.ts still passes, because jobSink.ts has no fs call.

**Tests.** - jobSink.test.ts: the snapshotFrom prefix rule, seq, and the schema.
- generationStatus.test.ts: the id regex and the author check.
- generateForays.test.ts: --job-dir writes, and nothing is written under --dry-run.
- Update the floors.

**Flag.** The new --job-dir flag is off by default, so existing runs are unchanged.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** - Governed path.
- The payload becomes the input for the player (W6-04) and for the Supabase row (W6-18), so pin it with the schema test.
- generateForays.ts is also edited by W6-07, W6-17 and W6-19, and by the measurement workstream (ReportEntry, :755). Its parseArgs flag additions sit next to each other, so rebase in merge order.

#### GV-45 · Golden set v1: 10 listened and 40 scored prompts, stratified, validated and locked

- **From:** W1-14
- **Wave:** 8 · **Size:** M · **Depends on:** GV-39
- **Covers:** R2-02, GP-28

**Goal.** Build the fixed benchmark every later change is judged on, in the PromptSpec shape generate-forays already reads, so running it needs no new driver.

**Design.**

INTEGRATION NOTE: every golden-v1.json entry carries bench: true, so GV-62's --keep-checkpoints accepts the manifest.

tools/generation-bench/golden/golden-v1.json is an array of `{id:'g01'..'g50', prompt, duration, topic?, stratum, listened, reference?}`. normalizePrompts (generateForays.ts:159) passes the objects through, and W1-02 reads id as promptId.
- stratum: 'multi-show' | 'single-show' | 'ambiguous' | 'near-no-supply'
- reference: {kind:'forays-json', forayId} or {kind:'founder-candidate', file}
- Strata: 30 / 10 / 5 / 5. This is the orchestrator default; R2's 25/10/5/5 sums to 45, not 50.
- The 10 listened prompts include every prompt that already has a Claude-written candidate: the 4 generated Forays (prompts reconstructed from title, topic and summary), the 14 Sep prompt, and the distinct run 6-9 prompts in baseline.jsonl. The rest are short tier.

tools/generation-bench/golden/select.mjs proposes candidates deterministically from committed data. It counts shows and rows per taxonomy node lineage (data/taxonomy.json) from data/transcript-digests.json, data/breadth-transcript-digests.json and catalog.json, and assigns strata by those counts. The implementing agent writes the final prompt text from node titles and the historical prompts. These are test inputs, made with no model call.

tools/generation-bench/golden/validate.mjs:
- Checks schema, unique ids and prompts, strata counts, and exactly 10 listened.
- `--lock <report.json>` writes golden-v1.lock.json {manifestSha, corpusFingerprint (W1-13), frozenAt}.
- Refuses a manifest whose sha changed (bump to v2 instead).

README:
- Run from backend/: `npm run generate-forays -- --prompts ../tools/generation-bench/golden/golden-v1.json --out <dir>`.
- Do not pass --dry-run: --dry-run writes no report.json (generateForays.ts:924), so it cannot be locked.

**Files edited:**

- test/suite-integrity.test.js

**New files:**

- tools/generation-bench/golden/golden-v1.json
- tools/generation-bench/golden/select.mjs
- tools/generation-bench/golden/validate.mjs
- tools/generation-bench/golden/golden.test.mjs
- tools/generation-bench/golden/README.md

**Acceptance:**

- validate.mjs passes on golden-v1.json: 50 entries, 10 listened, strata 30/10/5/5.
- select.mjs output is deterministic on the committed data.
- Every reference forayId exists in data/forays.json.
- The lock round-trips, and a changed manifest is refused.
- No committed file contains transcript text or model output.

**Tests.** node --test tools/generation-bench/golden/golden.test.mjs: validator on the committed manifest, select determinism, lock behaviour on a synthetic report

**Flag.** none; data plus offline tools

**Live step.** (1) On the founder PC, run the manifest in stub mode (ANTHROPIC_API_KEY unset, no --dry-run, so stubs make no model calls and report.json is written). This checks the supply strata against the 22 shows actually on disk; then write the lock from that report. (2) Once the provider layer and LiteLLM key exist, one 50-prompt Spark run (~20-25 min) seeds golden-baseline.jsonl (W1-15).

**Founder need.** Optional async veto or swap of the 10 listened prompts, since he will listen to them. The default is to proceed with the agent's set.

**Risk.** Strata from committed digests can disagree with the founder's disk, so the stub-mode check runs before the lock. The pre-Q-03 references make Claude-vs-Qwen pairs compare against an older writer. The README says so, and later the first Qwen golden run becomes the pairwise baseline for stage swaps.

#### GV-46 · Stitcher and partial projection accept a Foray whose later acts are not yet deepened or sourced

- **From:** W4-20
- **Wave:** 8 · **Size:** S · **Depends on:** none
- **Covers:** R1-04

**Goal.** Remove the two whole-Foray inputs that stop act 1 being stitched and checked before later acts exist: the stitcher's up-front deepened-acts array, and the partial projection's need for every sourced act.

**Design.**

1. stitchForay.ts ForayStitcher (constructor :135) takes an alternative source of acts: `{actCount: number; deepenedAct: (i) => DeepenedAct | undefined}`. The existing DeepenedAct[] form stays.
   - totalActs (:223) comes from actCount.
   - stitchNextAct(i) (:154) throws as today if act i, or act i-1 for smoothActIntroduction (:167), is not available yet.
   - stitchForay (:262) is unchanged.
2. partialProjection.ts: buildProjectedItems (:182) and PartialProjectionPlan (:151) gain `totalActs`.
   - When plan.sourcedActs.length < totalActs, the unsourced acts are not projected.
   - partialCandidate.ts (:211) then uses a new scope basis 'deferred'. The projected (share-of-whole) rules' failures from the partial's own validation become warnings in supersededOnPartial, not errors, because they cannot be judged on a prefix with unknown later acts. They are still applied by the whole-Foray finalize.
   - This is NOT partialOnlyScope (:280), which judges every rule on the partial. That would reproduce run 5's false M4 FAIL.
3. writeNarration.ts showsHeardBeforeEachAct (:510) gets an incremental twin showsHeardBeforeAct(sourcedActsSoFar, i, nameOf), equal to entry i of the whole-Foray function.

**Files edited:**

- backend/src/generation/stitchForay.ts
- backend/src/generation/partialProjection.ts
- backend/src/generation/partialCandidate.ts
- backend/src/generation/writeNarration.ts
- backend/test/stitchForay.test.ts
- backend/test/partialProjection.test.ts
- backend/test/partialCandidate.test.ts

**New files:**

- none

**Acceptance:**

- The existing stitchForay, partialCandidate and partialProjection tests pass unchanged.
- A ForayStitcher built with {actCount: 3, deepenedAct} stitches act 0 when only act 0 is deepened, and its totalActs is 3.
- A partial at act 0 of 3, with only act 0 sourced and a share rule that fails on the prefix, is not refused. The rule's line appears in supersededOnPartial with basis 'deferred'.
- showsHeardBeforeAct(acts.slice(0, i), i) equals showsHeardBeforeEachAct(acts)[i] for every i on a fixture.

**Tests.** vitest stitchForay.test.ts, partialProjection.test.ts and partialCandidate.test.ts additions.

**Flag.** none. New optional inputs; current callers are unchanged.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** A deferred share rule means an act-0 partial can be served with an M4 problem that only surfaces at the end. That is the trade the per-act path makes, and the whole-Foray finalize and the publish gate still refuse it.

#### GV-47 · Judge fallback (OQ-05): Qwen-judge behind the JevClient interface, circuit breaker, fail-closed when unjudged, routed as the judge stage

- **From:** W5-19, W2-12
- **Wave:** 8 · **Size:** M · **Depends on:** GV-03, GV-15, GV-19, GV-20
- **Covers:** R1-07, R1-20, OQ-05

**Goal.** OQ-05's adopted default allows Jev with a Qwen-judge fallback. Jev outages (503s, paused signups, LM-25) must degrade the gates to a local judge, not to 'unknown everywhere'.

**Design.**

INTEGRATION NOTE (merged W5-19 + W2-12; both built a Jev-then-Qwen judge). W5-19's shape wins: QwenJudgeClient implements the JevClient interface, so every consumer (clarity, clip judge, sentence support, spine judge, critic) has one interface and the fallback is transparent. W2-12's separate TypedJudge/createTypedJudge modules are not built. Carried over from W2-12:
- the circuit breaker inside FallbackJudgeClient {failuresToOpen 3, coolOffMs 60000}, fake clock in tests;
- routing: the 'judge' stage of the routing table selects jev | local:<lane> (qwen-judge only) | none; in local mode the default is jev with local:second fallback. FORAY_JUDGE_FALLBACK is replaced by that route;
- fail-closed: with the judge route 'none', createJevClient returns NullJevClient and every consumer treats {ok:false} as 'not passed';
- QwenJudgeClient builds its constrained JSON with askStructured (GV-19); probabilities come from top_logprobs only when the lane profile has logprobs, otherwise calibrated:false;
- per-judge threshold keys (supportMinP.jev/.qwen, clipLevel.jev/.qwen) are added to gateConfig here, so GV-103 writes calibrated values into them and its calibrateJudges CLI accepts --judge jev|qwen from the start.
- live step: W2-12's shadow comparison on run 9's labelled pages.

--- From W5-19 ---
- New backend/src/generation/qwenJudgeClient.ts (flat file). QwenJudgeClient implements JevClient on the provider workstream's ChatProvider (OpenAI-compatible LiteLLM, alias local-worker, i.e. the second box, so checks stay off the Spark's prose slots).
  - Each question set is rendered as one constrained-JSON request. The schema mirrors Jev answers: noul as {noul}; choice as {choice, probabilities}; score as {score, probabilities}.
  - chat_template_kwargs enable_thinking=false. A dedicated Foray virtual key.
  - Replies pass through W5-01's validator, so a malformed reply is {ok:false, malformed}.
- FallbackJudgeClient(primary, fallback, {onFallback}) falls back only on timeout, http or network, never on malformed.
- createJevClient wraps with the fallback when the routing table's 'judge' route names a local fallback lane (see the integration note); there is no FORAY_JUDGE_FALLBACK variable (decision 4).
- Every answer is tagged judge 'jev' or 'qwen' via onCall. W5-03, W5-05 and W5-09 copy the tag onto rows and verdicts, and thresholds are looked up per judge (W5-07's keys), so Qwen probabilities are never read against Jev thresholds.
- calibrateJudges accepts --judge qwen.

--- From W2-12 ---
SUPERSEDED (decision 7): W2-12's jev/typedJudge.ts module (TypedJudge, JevJudge, QwenJudge, FallbackJudge, NoneJudge, createTypedJudge) is not built and there is no jev/ subfolder. Its circuit breaker, judge route, fail-closed 'none' behaviour (NullJevClient) and logprob-gated calibration flag are carried into FallbackJudgeClient, createJevClient and QwenJudgeClient as listed in the integration note.

**Files edited:**

- backend/src/generation/jevClient.ts
- backend/src/generation/gateConfig.ts
- test/suite-integrity.test.js
- backend/src/config/stageRouting.ts

**New files:**

- backend/src/generation/qwenJudgeClient.ts
- backend/test/qwenJudgeClient.test.ts
- backend/test/fixtures/jev/qwen-judge-replies.json
- backend/test/judgeFallback.test.ts

**Acceptance:**

- A fake ChatProvider replays synthetic OpenAI-format replies. Each question type round-trips into a JevResult, and malformed JSON gives malformed.
- FallbackJudgeClient calls the fallback on a primary timeout or 503 and not on malformed, and tags the judge on every answer.
- A threshold lookup for judge 'qwen' never returns the Jev value.
- After 3 consecutive Jev failures the breaker opens for coolOffMs on a fake clock, and a later success closes it.
- With the judge route 'none', consumers receive ok:false and a contract test documents fail-closed use.

**Tests.** Vitest qwenJudgeClient.test.ts with a fake ChatProvider and recorded synthetic replies.
New backend/test/judgeFallback.test.ts: breaker open/close on a fake clock, route resolution.

**Flag.** FORAY_STAGE_JUDGE=jev|local:<lane>|none (routing table). Default outside local mode: jev when a key exists, no fallback.

**Live step.** With the LiteLLM key, rerun W5-07 calibration with --judge qwen on the same labelled sets. Post Jev-vs-Qwen agreement and latency.
Shadow comparison on the founder PC: run 9's labelled pages (16 verified, 8 refused, in data-local) go through the same yes/no support questions to Jev and to the Qwen judge, and agreement with the labels is recorded. This is LM-24 groundwork, shared with the verification workstream.

**Founder need.** founder-approved label (orchestrator applies); plus a Foray LiteLLM virtual key (#1163). Access to run 9's labelled pages in data-local on the founder PC for the shadow comparison.

**Risk.** W5-19: Blocked on the provider layer's ChatProvider interface (another workstream, HW-12/R2-21). It can only be built against that interface, or against a minimal local interface that the provider card later adopts. A 35B-A3B MoE's self-reported probabilities are poorly calibrated. The P40 lane has one slot per card and an XID-latch history, so it needs its own timeout and a concurrency of 2.
W2-12: Noul and choice probabilities are not comparable, and Qwen probabilities without logprobs are uncalibrated, so thresholds are per judge and every verdict is labelled with its judge. The second-box Qwen judge is serial, and the breaker bounds fallback cost. Governed path.

#### GV-48 · Dense arm, hybrid merge and per-taxonomy-node nightly shortlist

- **From:** W3-09
- **Wave:** 8 · **Size:** M · **Depends on:** GV-16, GV-28
- **Covers:** R1-09, R2-04, QK-22

**Goal.** Add semantic candidates to the BM25 ones without removing any, and precompute about 50 best passages per taxonomy node, so request-time retrieval becomes a lookup plus a rerank.

**Design.**

1. Pure backend/src/generation/hybridRetrieval.ts: mergeCandidates(bm25, dense, {policy:'append'|'rrf', denseExtra=4, k=60}).
   - 'append' is the default and the safe policy, mirroring tier2Candidates' title-path rule (sourceBeats.ts:2170-2180, 'can only ADD candidates'). The BM25 list keeps its order, and up to denseExtra dense-only episodes are appended, each carrying its best passage {passageId, startSec, endSec, startBoundary, endBoundary}.
   - 'rrf' is reciprocal rank fusion at episode level, for evaluation only.
   - Every candidate carries the query's BM25 idf map, so the window floors (transcriptArchiveLookup.ts:1094) weigh dense-only episodes the same way.
   - Each candidate is marked via: 'bm25' | 'dense' | 'both'.
2. Server: /v1/search accepts mode 'hybrid'. It embeds the query once with an injected QueryEmbedder, runs denseSearch filtered to the scope's episodes through an injected PassageStore interface, then calls mergeCandidates.
   - The real store (tools/passage-index/store.mjs, node:sqlite) and embedder are loaded by dynamic import only in main() and serve.mjs (which passes --experimental-sqlite).
   - backend tests inject in-memory fakes, so vitest never needs node:sqlite on Node 22.
3. Shortlist: POST /v1/shortlist/rebuild {nodes?} and GET /v1/shortlist?node=&query=&limit=.
   - For each of the 194 data/taxonomy.json nodes, query = node label, plus child labels, plus the terms of semantic-index concepts the label matches (catalogueLookup.ts:161).
   - Scope = archive entries where familyGateAllows(node, nodesForArchiveEntry(entry)).
   - A hybrid passage search keeps the top 50, stored through the store interface in node_shortlist(node_id, rank, passage_id, score, built_at) (migration 0002).
   - GET reranks the stored 50 against `query` by cosine, or by BM25 over passage text with no embedder, and returns text, seconds, boundaries and anchors.
4. tools/passage-index/nightly.mjs chains:
   1. stream-index delta (W3-05/06)
   2. warm --from-staged (W3-03)
   3. index-db ingest and embed (W3-07)
   4. POST /v1/reload
   5. POST /v1/shortlist/rebuild
   Step timings go to data-local/passage-index/nightly.log. A failure stops the chain.

**Files edited:**

- backend/src/cli/retrievalServer.ts
- tools/passage-index/store.mjs
- tools/passage-index/README.md
- test/suite-integrity.test.js
- backend/test/retrievalServer.test.ts
- tools/passage-index/store.test.mjs

**New files:**

- backend/src/generation/hybridRetrieval.ts
- backend/test/hybridRetrieval.test.ts
- tools/passage-index/migrations/0002_node_shortlist.sql
- tools/passage-index/nightly.mjs
- tools/passage-index/nightly.test.mjs

**Acceptance:**

- Under 'append', every BM25 candidate keeps its rank. Dense-only episodes come after them, at most denseExtra of them.
- Dense hits outside the scope are never returned.
- A node's shortlist holds only lineage-admitted episodes and at most 50 rows.
- A nightly run on an unchanged corpus writes no index and only rebuilds the shortlist.
- Hybrid with the stub embedder is deterministic.
- No backend test imports node:sqlite.

**Tests.** vitest:
- hybridRetrieval.test.ts for pure merge cases
- retrievalServer.test.ts extended with a fake PassageStore and stub QueryEmbedder: hybrid mode, scope filter, shortlist rebuild and GET
node:test:
- nightly.test.mjs with injected steps: order, skip on no delta, a failure stops the chain
- a store.test.mjs case for migration 0002
Add floors.

**Flag.** Hybrid is opt-in per request (mode 'hybrid'). The client sends it only when FORAY_RETRIEVAL_MODE=hybrid (W3-10/W3-11); the default is bm25.

**Live step.** On the Spark after the W3-07 backfill, run the nightly once, time it, and spot-check the shortlists for 5 nodes, including the germ-theory case under medicine.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Dense-only episodes still face the lexical window floor (share >= 0.35 and >= 3 rare terms), so many will be refused at window-overlap until the clip-judge workstream (R1-20/R2-03) accepts windows semantically. W3-15 measures exactly this. The shortlist is a day stale by design.

### Wave 9

#### GV-49 · Jev clarity understander: one Jev request with two yes/no questions replaces the Haiku clarity call

- **From:** W4-02
- **Wave:** 9 · **Size:** S · **Depends on:** GV-15, GV-20, GV-37
- **Covers:** R1-02

**Goal.** Take ST-01's clarity check off the model chain. One Jev request carrying two noul questions costs about 0.2 s. A text-writing fallback runs only when Jev says yes or is unavailable.

**Design.**

INTEGRATION NOTE: selected with FORAY_STAGE_UNDERSTAND_CLARITY=jev through the routing table (GV-03); createPromptUnderstander registers the 'jev' implementation. The Jev client is GV-20 (with the Qwen-judge fallback of GV-47 when routed).

1. New module backend/src/generation/JevPromptUnderstander.ts: class JevPromptUnderstander implements PromptUnderstander (PromptUnderstander.ts:15). Constructor: (jev: JevClient, fallback: PromptUnderstander, thresholds = CLARITY_THRESHOLDS). providerName is 'jev'.
2. assessClarity(prompt, ctx) sends ONE Jev systemone request. The API takes a questions[] array (hermes jevclient.py), so this is one round trip. The state is the prompt plus a one-line product description. The two noul questions:
   - 'two-subjects': does the request name two or more different subjects that would each need their own documentary?
   - 'one-episode': is it a request for one specific podcast episode or show rather than a subject? (R2's addition)
3. Outcomes:
   - Both p(yes) below threshold: return {ambiguous: false, readings: [], question: null}, with no text model call.
   - Either at or above threshold: return fallback.assessClarity(prompt, ctx). The fallback writes the question and readings, or overrules to not ambiguous. Jev never authors listener copy.
   - JevUnavailable or a timeout: return fallback.assessClarity (the OQ-05 Qwen-judge fallback).
4. extractIntent delegates to the fallback. The fast path does not call it (W4-03).
5. Report the decision without module-global state. UnderstandPromptResult's 'understood' and 'needs_clarification' variants gain optional `clarityDecidedBy?: 'jev'|'fallback'`, and UnderstandCheckpointSchema (runPipeline.ts:658) gains the same optional field, so old checkpoints parse. runPipeline carries it to the outcome and report.json.
6. CLARITY_THRESHOLDS = {twoSubjects: 0.5, oneEpisode: 0.5}, marked PROPOSED until the live calibration.
7. SUPERSEDED (decision 4): there is no clarityProvider option or flag. createPromptUnderstander.ts registers a 'jev' implementation for the understand-clarity route (GV-37's registry). When FORAY_STAGE_UNDERSTAND_CLARITY=jev, the factory wraps the understander the routing table picks for the rest of ST-01 in a JevPromptUnderstander built on the GV-20 client (with GV-47's fallback when routed). A 'jev' route without a Jev key throws RoutingConfigError naming JEV_API_KEY at pipeline start, like every other misrouted stage; it never silently returns the default.
8. In production the fallback is whatever the factory gives today. Replacing it with a Qwen understander is the provider workstream's job; this card adds no Anthropic call site.

**Files edited:**

- backend/src/generation/createPromptUnderstander.ts
- backend/src/types/generation.ts
- backend/src/generation/understandPrompt.ts
- backend/src/generation/runPipeline.ts
- backend/src/cli/generateForays.ts
- test/suite-integrity.test.js
- backend/test/understandPrompt.test.ts

**New files:**

- backend/src/generation/JevPromptUnderstander.ts
- backend/test/JevPromptUnderstander.test.ts
- backend/test/fixtures/jev/clarity-replies.json

**Acceptance:**

- When both Jev answers fall below threshold, the fallback is never called and the result is not ambiguous.
- When either answer is at or above threshold, the fallback is called exactly once and its result is returned unchanged.
- Exactly one Jev request is made per assessClarity call, and it carries both question ids.
- JevUnavailable or a timeout routes to the fallback. Nothing throws out of assessClarity because Jev failed.
- understandPrompt (understandPrompt.ts:46) works unchanged with the new understander, and a needs_clarification outcome carries the fallback's question and readings.
- A banked understand checkpoint without clarityDecidedBy still parses.
- Recorded Jev reply fixtures (noul shape with request id) are parsed through the cross-workstream JevClient fake.

**Tests.** vitest backend/test/JevPromptUnderstander.test.ts with the Jev client fake keyed by question id, plus understandPrompt.test.ts cases with the new understander injected.

**Flag.** FORAY_STAGE_UNDERSTAND_CLARITY=jev (routing table). Default keeps the current understander.

**Live step.** With the Jev key, ask both questions of a labelled prompt set: the §4.1 examples in generation-architecture.md plus run prompts recorded in docs/curation/generation-run-*.md, labelled by the founder. Set the thresholds where agreement is 0.9 or better, and record them as settled.

**Founder need.** founder-approved label (orchestrator applies); plus Jev API key (#1163) and labels for the clarity calibration prompts, both for the live step only.

**Risk.** The prompt text goes to TypeSafe's hosted API. OQ-05 accepts this; say it in the PR. The 'one specific episode' question may send servable requests to clarification, so the thresholds stay PROPOSED and the fallback can overrule a Jev yes.

#### GV-50 · Act writer and verifier prompts split into a byte-stable cached prefix, with a JSONL contract variant and an (empty) voice slot

- **From:** W4-11, W2-14
- **Wave:** 9 · **Size:** M · **Depends on:** GV-31, GV-32, GV-38, GV-43
- **Covers:** R2-08, GP-05, R1-10

**Goal.** Put the writer's and verifier's static rules first, so the 9-11k-token prompts are prefix-cache hits across acts, rounds and Forays after their first read, and leave one slot where the founder-selected voice card and exemplars go.

**Design.**

INTEGRATION NOTE (merged W4-11 + W2-14; both split buildActWritePrompt). The writer split follows W4-11 (stable / foray / act = W2-14's stable / foray / call), the verifier split follows W2-14. Text moves to backend/src/generation/prompts/actWrite.ts and prompts/actVerify.ts, not writerPrompt.ts. NO voice card ships unconditionally: W4-11's voice/writer-voice.json and writerExemplars.ts are dropped in favour of the single founder-selected file of GV-42; the `stable` part ends with an empty voice slot that GV-99 fills when FORAY_WRITER_EXEMPLARS=on. The classic Anthropic writer prompt therefore changes order only. Chat writer and verifier (GV-31) send toChatMessages (GV-32). The output 'jsonl' contract references WRITTEN_SEAM_JSON_SCHEMA in replySchemas.ts (GV-43).

--- From W4-11 ---
1. (Module renamed by the integration note: the text goes to backend/src/generation/prompts/actWrite.ts, not writerPrompt.ts.) ACT_CLAIM_RULES (:241), ACT_PROSE_RULES (:254) and actLayout (:329) move to prompts/actWrite.ts from AnthropicNarrationWriterBuilder.ts.
   - actWritePromptParts(request, {output: 'json'|'jsonl'}): {prefix, foray, act}.
   - prefix holds the static role line, the (empty by default) voice slot, HOW TO WRITE, CLAIMS AND QUOTES, the copy rules and the output contract. For jsonl the contract reads: 'one seam object per line, in listening order, s0 first, nothing else on the line', referencing WRITTEN_SEAM_JSON_SCHEMA (W4-09).
   - foray holds voiceLine(request.voice) and the overview.
   - act holds the ACT FRAME (W4-08), layout, DOCUMENTS and retry section.
   - buildActWritePrompt = prefix + foray + act with output 'json'. The lines are the same in a new order; the actNarration.test.ts 'the per-act prompts' pins (:666) are updated deliberately.
2. SUPERSEDED (decision 17): no writerExemplars.ts, no voice/writer-voice.json and no drafted voice card. The voice slot stays empty; GV-99 fills it from the founder-selected tools/generation/exemplars/narration-exemplars.json (GV-42) only when FORAY_WRITER_EXEMPLARS=on.
3. SUPERSEDED: the Anthropic writer gets no voice card; its prompt changes order only.

--- From W2-14 ---
buildActWritePromptParts(request):
- stable: JSON_ONLY, CLAIM_SHAPE, the reply shape, ACT_CLAIM_RULES (:241), ACT_PROSE_RULES (:254) and the seam-mode rules. The voice card and exemplars (R2-08/R2-17, writing workstream) go here.
- foray: voiceLine (:224) and the Foray overview, identical for every act.
- call: act title and thesis, actLayout (seams, clips, documents, ground) and the retry section.

buildActVerifyPromptParts gets the same split. The whole-clip-window evidence (R2-12) lives in `call`.

The Chat writer and verifier send toChatMessages; the legacy path sends joinParts.

**Files edited:**

- backend/src/generation/AnthropicNarrationWriterBuilder.ts
- backend/test/actNarration.test.ts
- test/suite-integrity.test.js
- backend/src/generation/AnthropicNarrationVerifierBuilder.ts
- backend/src/generation/chat/ChatNarrationWriterBuilder.ts
- backend/src/generation/chat/ChatNarrationVerifierBuilder.ts
- backend/test/promptLayout.test.ts

**New files:**

- backend/src/generation/prompts/actWrite.ts
- backend/src/generation/prompts/actVerify.ts
- backend/test/actWritePrompt.test.ts

**Acceptance:**

- actWritePromptParts(...).prefix is byte-identical across two acts, three rounds (retry notes present) and two Forays with different voices and documents.
- The voice slot is empty unless a selected exemplar file is supplied; supplying a test fixture places the block in `stable`, byte-stable.
- The Anthropic writer's prompt contains the same lines as before (reordered), and its tests are green after the pin update.
- The jsonl output contract text names every required line field.
- The writer's and the verifier's `stable` parts are byte-identical across two unrelated Forays.
- `foray` is identical across every act of one Foray and across rounds 1-3 of one act.
- A retry round differs from round 1 only inside `call`.
- The pins in actNarration.test.ts 'the per-act prompts' (:666) are updated, and a line-set test shows every pre-existing instruction line is still present.

**Tests.** From W4-11: vitest actWritePrompt.test.ts (prefix stability across acts, rounds and Forays; empty voice slot and fixture placement; JSONL contract) and the actNarration.test.ts pin updates.
From W2-14: Run each alone: `npx vitest run test/promptLayout.test.ts`, `npx vitest run test/actNarration.test.ts`, `npx vitest run test/chatNarrationBuilders.test.ts`.

**Flag.** A content-preserving reorder; the jsonl contract is used only by the streamed Chat writer (GV-84).

**Live step.** In a local medium run, read cachedTokens for writer rounds 2-3 and for acts 2 and later. Expect a cached share close to (stable+foray)/prompt.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** W4-11: The classic prompt changes order only (no voice card ships here); the golden set catches a regression. The exemplars in data/forays.json are pre-Q-03 per-beat output the founder called clunky (eval-area mapping), which is why none ship until a listen picks them.
W2-14: High conflict risk with the writing workstream's streamed writer, voice card and whole-window evidence, which all edit buildActWritePrompt. Land this first, or fold it into that workstream's first writer PR by agreement. Governed path.

#### GV-51 · JevNarrationVerifierBuilder: per-beat choice and per-sentence support run in parallel, mapped onto verifyAct with sentence verdicts

- **From:** W5-09
- **Wave:** 9 · **Size:** M · **Depends on:** GV-15, GV-27, GV-34, GV-37
- **Covers:** R1-07, R2-09, MQ-02, MQ-11, GP-26

**Goal.** Replace the whole-act Sonnet verifier call (TM-03/TM-04: about 14 s of decode, re-read up to 3 rounds) with parallel Jev questions of about 1 s per act. The contract carries per-sentence verdicts so R2-10 can cut sentences.

**Design.**

INTEGRATION NOTE: selected with FORAY_STAGE_VERIFIER=jev through the routing table (GV-03); createNarrationVerifierBuilder registers 'jev' and throws a config error naming JEV_API_KEY when no key exists.

1. NarrationVerifierBuilder.ts:
   - Add SentenceVerdict {index, text, kind:'statement'|'question'|'imperative'|'intro', verdict:'supported'|'unsupported'|'unknown'|'exempt', p?, restsOn?: string[], specifics?: string[]}.
   - SeamVerdict (:173) gains sentences?: SentenceVerdict[]. BeatVerdict (:159) gains carriedBySentence?: {seamId, index}.
   - All new fields are optional, so the Anthropic and stub verifiers stay valid.
2. New JevNarrationVerifierBuilder.ts implements verifyAct(request, ctx):
   - (a) Per open beat, one choice. state = {claim, options}. The options are every statement sentence of the act's scripted seams ('s3.1') plus every clip ('c0'). A clip's text is passageAround(windowText, claim, 4000) so a clip can carry a beat (BeatVerdict.carriedBy may be c<n>, :166). Add 'none'. If the options exceed 40k chars, split into two asks and keep the higher top p. The beat is carried iff the top option is not 'none' and p >= the judge's support threshold.
   - (b) Per non-frozen seam, split with splitSpokenSentences. Questions and listener imperatives are exempt. Intro sentences are exempt: sentences where introNamesSource (actSeams.ts:385) holds for the introduced clip (checked by code, and by W5-15).
   - (c) Each statement goes to W5-08's judge with candidateSourcesFor over request.sources (ActSourceBrief :99) resolved to text: claims use quote plus claimText; clips use request.clips[].windowText; pages use ground scripts; docs use documents[].text. mustInclude = the seam's selected ids. W5-10's unsupportedSpecifics runs on the same texts, and a failure makes the sentence unsupported whatever Jev said.
   - (d) claimsSupported = no unsupported and no unknown statements. restsOn = the union of the chosen ids. notes QUOTE each unsupported sentence, the shape roundNotes (writeAct.ts:1067) already forwards.
   - (e) contestedHandled is decided by the stub's code rule (StubNarrationVerifierBuilder.ts:105): no contested source, or containsContestedLanguage. Jev is not asked. Document the change.
   - (f) Metering is inherited from W5-01's meteredJevClient.
3. createNarrationVerifierBuilder.ts registers 'jev' in the routing registry (GV-37): FORAY_STAGE_VERIFIER=jev selects it (there is no FORAY_NARRATION_VERIFIER, decision 4), and a missing key throws RoutingConfigError naming JEV_API_KEY. The default route is unchanged.
4. StubNarrationVerifierBuilder gains an opt-in emitSentences mode (CodeOverlapSupportJudge) so offline pipeline tests get sentence verdicts.

**Files edited:**

- backend/src/generation/NarrationVerifierBuilder.ts
- backend/src/generation/createNarrationVerifierBuilder.ts
- backend/src/generation/StubNarrationVerifierBuilder.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/JevNarrationVerifierBuilder.ts
- backend/test/jevNarrationVerifier.test.ts

**Acceptance:**

- Two-seam act, scripted FakeJevClient: verdicts map exactly. The unsupported sentence is quoted in notes, claimsSupported is false, restsOn is the union of ids, and intro and question sentences are 'exempt'.
- A beat carried only by a clip comes back carriedBy 'c0'.
- A sentence saying 'in 1991' against sources saying 'nineteen eighty-seven' is unsupported even when the fake Jev gives p=0.9.
- Jev unavailable for one sentence gives verdict 'unknown' and the seam is not confirmed.
- End to end in the new jevNarrationVerifier.test.ts (not actNarration.test.ts): stub writer plus the Jev builder (fake client), using the wrapped-builder pattern of backend/test/actNarration.test.ts:82-108 copied into the new suite, finishes with frozen seams and verifiedAtAttempt set.
- actNarration.test.ts runs unchanged (this card does not edit it; GV-50 edits it in the same wave), and writeNarration.test.ts is unchanged.

**Tests.** Vitest jevNarrationVerifier.test.ts, which holds the unit cases and the end-to-end case. Fake Jev client only. actNarration.test.ts runs unchanged.

**Flag.** FORAY_STAGE_VERIFIER=jev (routing table). Default: today's choice.

**Live step.** After W5-07, run one short and one medium golden prompt with the Jev verifier. Record verifier wall time per act, retryRounds and unverifiedPages against the run-9 Sonnet baseline.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Jev reads literally (LM-23), so narration heavy in paraphrase may read as unsupported; W5-07 calibration gates the default. Taking contestedHandled away from the model changes F-41-era semantics; the code rule is kept.

#### GV-52 · Bench delivery columns and the split per-tier targets (R1-16): first audio, whole Foray ready, lead, render speed

- **From:** W1-12, W1-19, W6-21
- **Wave:** 9 · **Size:** M · **Depends on:** GV-04, GV-24, GV-26, GV-33
- **Covers:** R1-16, MT-01, MT-02, MT-11, R1-14

**Goal.** Replace the single ttlA1 <= 0.5 min and wall <= 6 min targets with the adopted split: first audio at most 30 s short and 40 s medium; every item checked at most 90 s short and 4 min medium; lead at least 30 s. Each row's target is chosen by its tier.

**Design.**

INTEGRATION NOTE (merged W1-12 + W1-19 + W6-21; all three added first-audio / lead columns). Columns, all from report.delivery written by GV-33 and GV-74: first_s (MT-01, delivery.firstServableMs), full_s (MT-02, delivery.allItemsReadyMs, only when entry.publishable from GV-26), lead_s (MT-11, delivery.minLeadSec; lead at 1.5x as a detail column), render_x (delivery.render.realtimeFactor, detail). Absent prints —. Target status (decision): short first audio <= 30 s and whole Foray <= 90 s short / <= 240 s medium are SETTLED (orchestrator's adopted reading, CONTEXT.md, #1286); medium first audio <= 40 s and lead >= 30 s are PROPOSED (plan.md Targets table). W1-19's lead.mjs is not built.

--- From W1-12 ---
run.mjs:
- `TIER_TARGETS = {short:{first_s:30, full_s:90, lead_s:30}, medium:{first_s:40, full_s:240, lead_s:30}}`, with targetState SETTLED and the note 'orchestrator's adopted reading of the 30 s KPI (OQ-03; plan.md Targets; #1286)'. Long has no target.
- `targetFor(col, row)` picks by entry.duration (W1-02). targetLabel (:547) prints 'per tier' for those columns.
- New core column full_s (MT-02): elapsedMs/1000 only when entry.publishable is true (W1-09). Otherwise it is absent, with the note 'not ready: gate failed'.
- first_s (MT-01) and lead_s (MT-11) come from W1-19.
- ttl_a1_min's 0.5 target and elapsed_min's 6 min target are removed, with the note 'superseded by R1-16'.
- Regenerate the committed header and table.

Docs:
- generation-kpis.md: rewrite the targets table (:34-58).
- docs/curation/foray-to-spec-roadmap.md §1.2 (:170): one paragraph recording the split and pointing at the table.
- Grading stays out of the bench (rule 2).

--- From W6-21 ---
1. tools/generation-bench/run.mjs COLUMNS (:122) gains these columns:
   - `1stAudio s`, from delivery.firstServableMs. With phone-voice-first, the first servable item is first audio.
   - `allReady s`, from delivery.allItemsReadyMs.
   - `minLead s`, from delivery.minLeadSec.
   - `render RTF`, from delivery.render.realtimeFactor.
   - The tier, from the row's spec duration.
2. Targets are per tier.
   - Mark them PROPOSED unless the orchestrator's adopted reading in CONTEXT.md is cited as the adoption. That reading covers the 30 s to first audio and 90 s / 4 min whole-Foray targets, so those are labelled 'settled (orchestrator adopted reading 2026-10-11)'. Medium first audio <= 40 s and lead >= 30 s stay proposed.
   - Absent fields print as an em dash, never zero (rule 1). The bench never grades (rule 2).
3. jsonlLine and rowFromJsonl carry the new fields.
4. docs/curation/generation-kpis.md: update the targets table, and keep ttlA1 as its own (act-level) row. Fix the claim at :134 only if the measurement workstream has not already done so; coordinate.

**Files edited:**

- tools/generation-bench/run.mjs
- tools/generation-bench/run.test.mjs
- docs/curation/generation-kpis.md
- docs/curation/foray-to-spec-roadmap.md
- test/suite-integrity.test.js

**New files:**

- tools/generation-bench/fixtures/delivery/report.json

**Acceptance:**

- A short row shows a 30 s target for first_s and a medium row shows 40 s.
- full_s is absent for a row whose gate failed, even when elapsedMs exists.
- The KPI targets table names MT-01, MT-02 and MT-11 with per-tier values and their provenance.
- Runs 4-9 render unchanged apart from the moved target labels and the new absent columns, and the committed table equals the rendered baseline.
- A synthetic report with delivery.* prints the four columns with per-tier targets. The out-4 and out-9 rows print an em dash for each.
- JSONL round-trips the new fields.

**Tests.** node --test tools/generation-bench/run.test.mjs: per-tier target selection, gate-dependent full_s, legend text Plus the synthetic delivery fixture from W6-21.

**Flag.** none (display only)

**Live step.** none

**Founder need.** none

**Risk.** W1-12: SETTLED rests on the orchestrator's recorded adoption (CONTEXT.md; founder-async rule), not on a founder sentence. The note cites that, so a later founder ruling flips the targets to PROPOSED in one line. The W1-11 dependency is merge order on run.mjs.
W1-19: The duration estimate for unrendered narration (17 chars/s) is the planning rate, not measured speech. The result carries unknownDurations and the granularity so a reader can see how firm the number is.
W6-21: The measurement workstream also edits run.mjs COLUMNS and generation-kpis.md (TM-10, MT columns). Merge both into one PR if that workstream already carries R1-16, or serialize the two by merge order.

#### GV-53 · Digest rows for streamed episodes: RSS join of staged rows, legacy-key resolution, searchable-vs-mintable report

- **From:** W3-03
- **Wave:** 9 · **Size:** M · **Depends on:** GV-05, GV-23
- **Covers:** R2-16, GP-22

**Goal.** Give every newly indexed episode a corpus-digest row with a title, enclosure and duration where its feed has them, and resolve legacy whisper keys to show_id and guid. Report honestly how many new shows can only be searched and how many can actually supply clips.

**Design.**

Reuse warmTranscriptIndex.ts rather than writing a second joiner. It already has:
- loadFeed: the catalog feed_url, conditional GET, a cache under data-local/transcripts/feeds
- corpusDigestRow, which defines mintable as title + enclosure + duration
- mergeCorpusRows
- writeCorpusDigest

The original card's Postgres join is dropped. pg-row-source.mjs has no enclosure column: episodes.mjs takes audio only from 'alternate' assets, and the column lists are marked ASSUMED (pg-row-source.mjs:36-42).

warmTranscriptIndex gains three modes:
1. --from-staged <staged-digest.jsonl> (W3-04 output). For each show it runs loadFeed(needGuids = the staged guids) and corpusDigestRow, then merges into corpus-digest.json with committed rows winning, as today. It replaces the normalized-dir scan, so it works on a box with no local bodies.
2. --resolve-legacy <keys.txt> (the legacy keys from a W3-01 listing):
   - The show slug maps to catalog show_id through slugify(catalog title), the same rule foray-db and show-map.mjs use.
   - loadFeed for that show provides candidate guids.
   - W3-02's resolveLegacyEpisode decides each key. It is loaded by dynamic import, the finalizeForay.ts:623 precedent for importing tools .mjs.
   - Output: data-local/passage-index/legacy-map.json {key: {show_id, guid, title}}, plus counts by status and reason.
   - Optional --legacy-map-from <json>: an export of foray-db's own mapping (transcript_publications rows whose normalized_key is a legacy key) takes precedence when supplied, because RSS feeds often truncate old episodes.
3. --supply-report: for each show in the archive, {searchable, mintable, reason_not_mintable}. Reasons: not-in-catalog (no taxonomy lineage, so never searchable by gated stages), no-dai-verdict (data/dai-classification.json, the RQ-03 gate in audioSourceLookup.ts:194-195), no-enclosure, no-duration. It is printed as a table and written as JSON.

All three reuse the existing pure helpers; network access goes only through the existing loadFeed with --offline respected.

**Files edited:**

- backend/src/cli/warmTranscriptIndex.ts
- backend/test/warmTranscriptIndex.test.ts
- tools/generation/warm-transcript-index.mjs
- test/suite-integrity.test.js

**New files:**

- backend/test/fixtures/warm/staged-digest.jsonl
- backend/test/fixtures/warm/feed-cache-sample.json

**Acceptance:**

- --from-staged with a cached fake feed produces mintable rows that carry enclosure_url and feed_duration_sec, and searchable-only rows when the feed lacks the guid. A committed row is never overwritten.
- --resolve-legacy matches a synthetic key whose hash equals sha1(guid)[:10] for a feed guid, reports ambiguous when two feed guids share the prefix, and reports unmatched with a reason when there is no feed or show.
- --legacy-map-from entries override RSS resolution.
- --supply-report names the first missing mint condition for each show.
- Under --offline, no network call is made.

**Tests.** vitest `npx vitest run test/warmTranscriptIndex.test.ts`, extended with fixture feed caches (loadFeed's cache dir injected) and a tmp corpus-digest path. The dynamic import of tools/foraycorpus-export/legacy-whisper.mjs is exercised in this suite. Raise the floor.

**Flag.** New CLI modes only. The default warm behaviour is unchanged.

**Live step.** After W3-05's first R2 build on the Spark, run `--from-staged`, `--resolve-legacy` and `--supply-report`, and post the report on #1163. The shows it lists as searchable-only are the input to the DAI and catalogue curation pass.

**Founder need.** founder-approved label (orchestrator applies); plus catalogue rows and DAI verdicts for new shows are committed curation data and need a founder- or Joey-approved pass. foray-db's legacy mapping export, if wanted, needs foraycorpus access.

**Risk.** Governed (backend/src/cli). RSS feeds often list only recent episodes, so many legacy keys may stay unmatched without foray-db's mapping; the report counts them. Fetching feeds for many new shows is polite through loadFeed's existing conditional GET, but it is slow on the first run.

#### GV-54 · Remote cue store: on-demand R2 body fetch with a bounded disk cache (subsumes roadmap PKG-24)

- **From:** W3-24
- **Wave:** 9 · **Size:** S · **Depends on:** GV-16, GV-23
- **Covers:** GP-09, R2-16

**Goal.** Let the retrieval server serve cues for episodes whose bodies are only in R2, normalized or legacy, fetching each body once into a bounded cache instead of mirroring the bucket.

**Design.**

A new CueStore implementation in backend/src/cli/remoteCueStore.ts (cli/, so a disk write here is outside the generation/ persistence rule):
- lookup order:
  1. the local normalized dir
  2. the W3-05 --cue-cache dir
  3. an injected async fetchBody(origin) for the manifest row's origin key
- The default fetchBody dynamically imports tools/foraycorpus-export/r2-client.mjs getObject. It verifies sha256 metadata for normalized keys. Legacy keys go through W3-02's convertWhisperDoc/toNormalizedBody.
- Fetched bodies are written byte-identical (normalized) or as the converted JSON (legacy) into the cache dir with tmp+rename. Eviction is LRU by bytes (--cue-cache-gb).

Because the backend index provider is synchronous, the server awaits the fetch BEFORE answering /v1/cues, then reads through the sync provider over the cache dir. It invalidates that show's directory listing after each write: the PKG-24 point that FileTranscriptCueProvider memoises misses (filesByDir/locatedByKey). This adds a public forgetShow(showId) to FileTranscriptCueProvider that clears dirByShow, filesByDir, guidIndexByDir, locatedByKey and cuesByKey for the show.

The roadmap's PKG-24 card (docs/roadmap/corpus.md, 'Cache-through R2 cue provider') is marked superseded by this card in the same PR.

**Files edited:**

- backend/src/generation/transcriptArchiveLookup.ts
- backend/src/cli/retrievalServer.ts
- docs/roadmap/corpus.md
- test/suite-integrity.test.js

**New files:**

- backend/src/cli/remoteCueStore.ts
- backend/test/remoteCueStore.test.ts

**Acceptance:**

- Miss, then fetch, then cache: a second call makes no fetch.
- A body fetched after an earlier miss is returned on the very next request (forgetShow works; mutation: skip it and the test fails).
- A 404 returns null and writes nothing.
- A sha mismatch is not cached.
- A legacy origin is converted and served with transcript_source 'asr-local'.
- The cache stays under its byte bound.

**Tests.** vitest `npx vitest run test/remoteCueStore.test.ts` with an injected fetchBody and a tmp cache dir. Re-run test/transcriptLocate.test.ts for forgetShow. Add floors.

**Flag.** Used only when the server starts with --r2.

**Live step.** On the Spark, start the server with --r2 and confirm /v1/cues latency for a cold and a warm body.

**Founder need.** founder-approved label (orchestrator applies); plus the R2 read key on the Spark.

**Risk.** Governed. A cold R2 GET is about 100-300 ms per body, so the nightly W3-05 --cue-cache warm-up should hold the bodies most likely to be needed.

### Wave 10

#### GV-55 · Driver plumbing: --stage-provider flag, routing in report.json, and a routing-aware checkpoint fingerprint

- **From:** W2-18, W7-02
- **Wave:** 10 · **Size:** S · **Depends on:** GV-04, GV-15, GV-37
- **Covers:** R2-21, HW-12

**Goal.** A run states and records which provider, lane and model served each stage, so bench rows are attributable (R2-21), and it never resumes a stage banked under a different routing.

**Design.**

INTEGRATION NOTE (W7-02's provenance half): report rows also carry stageAssignments (describeStageAssignments(): per stage {impl, model, machine}); a STAGES line prints beside MODELS; the MODE line says 'mixed/live' when any stage is non-stub. tools/generation-bench/run.mjs gains the compact 'stack' detail column (GV-04 grouping; absent on older reports). Checkpoint: the routing string is joined into the same `variant` argument GV-15 introduced: variant = [checkpointVariant(flags), localRouting].filter(Boolean).join('|').

1. generateForays.ts parseArgs (:127) gains --stage-provider stage=provider[:lane][,...], applied as overrides before resolveRouting. A bad value exits non-zero naming it.
2. The MODE and MODELS lines (generateForays.ts:851-862) print routingSummary() in place of the env.anthropicDryRun branch.
3. The report written at :922-947 gains a top-level `routing` and `generationMode`.
4. backend/src/cli/generateForay.ts prints its understand route.
5. Checkpoint:
- The routing string is joined into GV-15's `variant` (no second parameter), and only when the mode is local. Legacy and stub fingerprints are therefore byte-identical, and banked runs survive.
- GV-15 already passes the variant at both callers (runPipeline.ts:920 and generateForays.ts:592) from the same merged flags; this card adds the local routing to that one variant computation, so the FileCheckpointStore fingerprint and the session fingerprint stay equal (checkpointStore.ts:63-67 merges stages only on an equal fingerprint).
- A local run therefore never resumes a Claude-built or differently-routed stage. That keeps the zero-Anthropic rule and keeps R2-21 attribution clean.
- CHECKPOINT_VERSION (:89) is not bumped, because stage shapes are unchanged.

**Files edited:**

- backend/src/cli/generateForays.ts
- backend/src/cli/generateForay.ts
- backend/src/generation/checkpoint.ts
- backend/src/generation/runPipeline.ts
- tools/generation-bench/run.mjs
- tools/generation-bench/run.test.mjs
- backend/test/generateForaysArgs.test.ts
- backend/test/generateForays.test.ts
- backend/test/checkpoint.test.ts

**New files:**

- none

**Acceptance:**

- --stage-provider spine=local:second,deepen=local:spark is parsed and applied, and a malformed value exits non-zero naming it.
- report.json contains routing and generationMode, asserted in the generateForays*.test.ts suites with an injected runPipeline.
- checkpointFingerprint is unchanged for stub and legacy inputs (pinned against today's value in checkpoint.test.ts), and differs between two local routings; the store and session fingerprints are equal under a local routing (generateForays.test.ts).
- runPipelineCheckpoint.test.ts passes unchanged.
- report.json rows carry stageAssignments; run.mjs shows the stack column, absent on out-4/out-9 (from W7-02).

**Tests.** Run each alone: `npx vitest run test/generateForaysArgs.test.ts`, `npx vitest run test/generateForays.test.ts`, `npx vitest run test/checkpoint.test.ts`, `npx vitest run test/runPipelineCheckpoint.test.ts` (unchanged).

**Flag.** Effective only in local mode; legacy and stub runs are unchanged.

**Live step.** Runs only after GV-61 and GV-68 have merged (wave 12): GV-61 completes the no-web research path and GV-68 refuses the relay and pins anthropicCalls=0. First full local run: FORAY_GENERATION_MODE=local on 1-2 benchmark prompts, a single prompt at a time (no batch before GV-90 and GV-93, see GV-68). Keep report.json and the candidate locally, never in data/forays.json, and log the outcome on #1163.

**Founder need.** founder-approved label (orchestrator applies); plus LiteLLM key (#1163) for the live run.

**Risk.** generateForays.ts and runPipeline.ts are also edited by the timers and per-act workstreams, so keep this diff to the cited lines. Governed path.

#### GV-56 · Corpus body schema accepts optional per-cue word timestamps (tools side: sync-r2 shape check and transcript-normalize)

- **From:** W5-14a
- **Wave:** 10 · **Size:** S · **Depends on:** none
- **Covers:** R2-05

**Goal.** Let normalized bodies carry cues[].words so pause snapping (W5-14b) has input. This is the tools half, on allowed paths, so it can merge without the founder label and before the farm emits words.

**Design.**

- tools/foraycorpus-export/sync-r2.mjs bodyShapeError (:152) accepts an optional cues[i].words: [{text, start, end}]. It rejects a non-array, a non-finite or non-monotonic timing, or text that is not a string, with the error `cues[i].words`.
- tools/segments/transcript-normalize.mjs: the JSON segment path (findSegments :215-256) carries segments[].words through to the cue when present (whisper-style {word, start, end} renamed to {text, start, end}).
- The cross-cue overlap de-duplication (:326-365) trims cue text by words, so when it trims a cue it must drop the same leading words from `words`, or drop `words` for that cue when they no longer align.
- The fetch-transcripts body writer preserves the field.

**Files edited:**

- tools/foraycorpus-export/sync-r2.mjs
- tools/foraycorpus-export/sync-r2.test.mjs
- tools/segments/transcript-normalize.mjs
- test/suite-integrity.test.js
- tools/segments/transcript-normalize.test.mjs

**New files:**

- none

**Acceptance:**

- sync-r2.test.mjs: a body with valid words passes, and a non-monotonic word array fails with 'cues[0].words'.
- transcript-normalize tests: a whisper-style JSON with words yields cues whose words join to the cue text. An overlap-trimmed cue's words are trimmed in step or dropped.
- Bodies without words are byte-identical to today.

**Tests.** node --test for tools/foraycorpus-export/sync-r2.test.mjs and the tools/segments normalize test, each run alone. Raise their floors.

**Flag.** Inert: the field is optional and no producer emits it yet.

**Live step.** none

**Founder need.** none

**Risk.** sync-r2.mjs is also edited by the corpus workstream (R2-16 list-only mode and disk guard), so coordinate rebase order. The transcript-farm repo must enable whisper word_timestamps before any real body carries words.

#### GV-57 · Player: append a streamed Foray and wait for the next part (JS lane, no UI files)

- **From:** W6-04
- **Wave:** 10 · **Size:** M · **Depends on:** GV-44
- **Covers:** R1-15, GP-07

**Goal.** Let the JS player start a Foray from its first servable items and append later items without touching anything already loaded or playing. When playback catches up with generation, the player waits and resumes by itself. The lock-screen text is split out to W6-20.

**Design.**

1. player/foray-queue.js (not a parity-covered suite). Keep buildForayQueue (:275) unchanged. Add an exported `appendableTail(prevBuiltItems, nextBuilt)`, implementing option (a) of player-streaming-brief.md §3.3:
   - rebuild from the full items;
   - assert that the prefix ids and content are identical;
   - return the tail;
   - throw on any mismatch.
2. player/queue-manager.js.
   - `appendForayItems(foray)`: build the full queue, take appendableTail, push it onto the queue, and emit `foray.stream.appended.n=<k>`. It never touches currentIndex or the playing ref.
   - `setForayStreamOpen(open)`.
   - Waiting, with the reducer left alone (queue-state.js:399 returns S.ended() + `queue.ended`; queue-state is a recorded parity family):
     - In `_handle` (:1413), when the reducer lands in ended while `_streamOpen` is true, record `_awaitingIndex = queue.length`, emit `foray.stream.waiting`, and skip the end-of-Foray session finalisation.
     - On append, if `_awaitingIndex` is set, call `play(_awaitingIndex)`.
     - A stream that closes as failed or complete while waiting emits `foray.stream.ended reason=<r>` and stays ended.
3. New player/foray-stream.js with `createForayStreamFollower({fetchSnapshot, manager, intervalMs=3000, schedule})`.
   - Poll, and skip when seq is unchanged.
   - The first snapshot with items calls setQueueFromForay, then play(0), then setForayStreamOpen(true).
   - Later snapshots call appendForayItems.
   - complete or failed calls setForayStreamOpen(false) and stops polling.
   - A 403 or 404 is a silent 'nothing yet'.
4. player/client.js: a `followForayStream(fetchSnapshot)` facade.
   - Streaming is JS-lane only, because the Swift engine has no append command (engine-contract.js).
   - The facade refuses with a telemetry line when the native lane is active.
5. Parity guard (player/parity/coverage.js: 'a JS rule change carries its Swift port').
   - Put the behaviour tests in the NEW suite player/foray-stream.test.js, which is not covered. It drives a real QueueManager with player/parity/fakes.js.
   - Any test added to queue-manager.test.js (a covered suite) must be listed in player/parity/exclusions.json in the same PR, with reason 'webview-only' and a sentence citing the client.js native-lane refusal.
6. Nothing calls followForayStream from a screen yet, because of the UI freeze.

**Files edited:**

- player/foray-queue.js
- player/queue-manager.js
- player/client.js
- player/foray-queue.test.js
- player/parity/exclusions.json
- test/suite-integrity.test.js
- docs/curation/player-streaming-brief.md

**New files:**

- player/foray-stream.js
- player/foray-stream.test.js

**Acceptance:**

- Against three JobSnapshot fixtures (schema from W6-03), brief §5 passes: the queue grows by exactly the new items, every existing item is byte-identical in place, the playing item and position are unchanged, and the queue after the complete snapshot equals buildForayQueue(whole).items.
- Reaching the end with the stream open emits foray.stream.waiting and no session-finished save. An append resumes at the next index.
- A prefix mismatch between snapshots throws and leaves the queue untouched.
- followForayStream refuses in the native lane.
- player/parity/coverage.test.js stays green, and app.js, styles.css and index.html are not edited.

**Tests.** - node:test: foray-stream.test.js (injected scheduler and fetch, real manager on parity fakes) and foray-queue.test.js (appendableTail).
- Add a floor for foray-stream.test.js and bump foray-queue.
- Run player/parity/coverage.test.js on its own.

**Flag.** No surface uses the new API. setForayStreamOpen defaults to false, so the existing ended behaviour is unchanged.

**Live step.** The founder hears a streamed Foray on the phone once a job source exists (W6-18/W6-19) and, after the revamp, a surface calls followForayStream.

**Founder need.** none

**Risk.** - Streamed Forays are JS-lane only until a native card ports append (Swift cannot be built here).
- Background polling under the iOS/Android shell is untested (an open question in the brief).
- queue-manager.js is a large shared file. Keep the change to new methods plus one branch in _handle.

#### GV-58 · Spark render worker deployment kit and the GB10 benchmark run (#862)

- **From:** W6-09
- **Wave:** 10 · **Size:** S · **Depends on:** GV-22
- **Covers:** R2-18, R1-13

**Goal.** Package narration rendering for the Spark as a merged, D8-compliant unit. It runs fp32 Kokoro on CPU with bounded threads so it does not starve the Qwen lane. Then measure GB10 render speed for ONNX CPU and PyTorch CUDA with the existing kit.

**Design.**

New tools/narration/spark/foray-render-worker.service, a systemd unit:
- ExecStart runs `python tools/narration/render-foray.py --worker /var/lib/foray/render-spool --threads 4 --out /var/lib/foray/narration-render`, using the existing --threads flag (:860).
- Nice=10. CPUQuota applies only under a system unit, or a user unit with cgroup delegation; the runbook says which.
- No credentials in the unit.

A companion foray-render-upload.timer runs spool-upload.mjs (W6-06), which reads ~/.foray/r2-narration.env.

New tools/narration/spark/README.md, a runbook:
- aarch64 install: pip install -r tools/narration/requirements.txt, plus espeak-ng and ffmpeg from apt.
- fp32 only, because q8f16 NaN on ARM is recorded (HW-10).
- `render-foray.py --check`, then `--smoke`.
- Enable the units.
- Run bench-narration.py with the torch-cuda and ort-cpu backends (#862) and post the results on #862.

A node test pins the unit's invariants:
- no secret-looking env;
- a spool path;
- bounded threads;
- the --worker flag.

Founder ruling #1076 removed only on-device Kokoro. Central render is kept, so the engine does not change.

**Files edited:**

- test/suite-integrity.test.js

**New files:**

- tools/narration/spark/foray-render-worker.service
- tools/narration/spark/foray-render-upload.timer
- tools/narration/spark/README.md
- tools/narration/spark/unit.test.mjs

**Acceptance:**

- The unit file has no credential, runs --worker on a spool path and bounds its threads. A test pins all three.
- The runbook lists the --check, --smoke and bench steps and the D8 spark-live tag.
- render-profile.json is unchanged (same profile id, so every key is unchanged).

**Tests.** unit.test.mjs: node:test, a static parse of the unit files. Add the floor.

**Flag.** Inert until installed on the Spark.

**Live step.** Joey or the founder installs the kit on the Spark under D8 (a merged PR plus the spark-live tag). Run --check and --smoke, then bench-narration.py torch-cuda and ort-cpu on GB10, and record NA-12 / MT-09 on #862.

**Founder need.** Spark hands under D8: the founder places secrets and moves spark-live. The R2 narration write token on the Spark (#119/#120).

**Risk.** - The Spark CPU is shared with SGLang's host processes, so threads must stay bounded.
- There is no ARM build of ONNX GPU for GB10, so any GPU path rests on the PyTorch measurement.

#### GV-59 · generation_jobs table (D9) and a Supabase job sink

- **From:** W6-18
- **Wave:** 10 · **Size:** M · **Depends on:** GV-44
- **Covers:** R1-15, GP-07

**Goal.** Give the job row a real home. Per D9 this is an authenticated Supabase table, protected by row-level security, that holds the author's job and its latest snapshot. The Spark worker writes the row and the phone reads it. The prompt is held only until a worker claims the job.

**Design.**

1. backend/migrations/supabase/0007_generation_jobs.sql. This is a Supabase-only table, because it references auth.users.
   - Columns: `generation_jobs(id uuid pk, author_id uuid not null references auth.users(id) on delete cascade, status text check in (queued,claimed,running,complete,failed,cancelled), tier text, lane text default 'on-demand', prompt text null, snapshot jsonb, seq int, created_at, claimed_at, updated_at, worker text)`.
   - The ON DELETE CASCADE means account deletion removes a listener's jobs on the server side. app.js's SB_USER_TABLES is UI-frozen, which is why the column is author_id.
   - RLS: an author selects their own rows. An author inserts a queued row only when listed in a founder allowlist table (D9: founders first). Authors cannot update or delete, except to cancel.
   - A SECURITY DEFINER function `claim_generation_job(worker)` selects FOR UPDATE SKIP LOCKED, sets the row to claimed, and in the same statement returns the prompt and NULLs it, so the prompt is discarded (§9.4).
   - Update verify-applied.sql and the README.
2. Update the static migration suites that police every Supabase table: test/supabase-rls-coverage.test.js, supabase-rls-verbs.test.js, supabase-verify-applied.test.js and data-deletion.test.js. The table is user data, so the deletion test must see the cascade, not an exemption.
3. backend/src/cli/supabaseJobSink.ts implements GenerationJobSink through PostgREST with an injected fetch and no new dependency. Each publish is a PATCH with the guard `seq=lt.<n>`, and it never sends a prompt.

**Files edited:**

- backend/migrations/supabase/verify-applied.sql
- backend/migrations/supabase/README.md
- test/supabase-rls-coverage.test.js
- test/supabase-rls-verbs.test.js
- test/supabase-verify-applied.test.js
- test/data-deletion.test.js
- test/suite-integrity.test.js

**New files:**

- backend/migrations/supabase/0007_generation_jobs.sql
- backend/src/cli/supabaseJobSink.ts
- backend/test/supabaseJobSink.test.ts

**Acceptance:**

- supabaseJobSink with a fake fetch sends PATCHes with increasing seq, and no request body contains a prompt field.
- A stale publish (lower seq) is a no-op because of the guard.
- The migration text contains: RLS enabled, the author-select policy, the allowlist insert policy, the author_id ON DELETE CASCADE, and a claim function that nulls the prompt. A static SQL test asserts each.
- The existing supabase-* and data-deletion suites pass with the new table accounted for.

**Tests.** supabaseJobSink.test.ts (vitest, fake fetch), plus static SQL assertions extended in the existing supabase-* suites. Add or update floors.

**Flag.** The migration is inert until applied. Nothing constructs the sink unless the worker (W6-19) is run.

**Live step.** The founder applies 0007 to the Supabase project and verifies it with verify-applied.sql.

**Founder need.** founder-approved label (orchestrator applies; backend/migrations/ is a DENIED_PREFIXES path and data-access-sensitive); plus:
- Applying the migration on Supabase.
- The service-role key placed on the Spark (D8).
- Confirmation that holding the prompt in the row until claim satisfies §9.4 / RQ-04, and whether the privacy policy needs a sentence. Wording under docs/legal is the founder's.

**Risk.** - An RLS mistake exposes another listener's Foray, so use least privilege and a static policy test.
- Prompt retention is a privacy rule.
- Realtime vs polling is undecided; polling through PostgREST every 3 s is assumed.

#### GV-60 · Stream indexer: legacy whisper source (index the 7,531 root JSONs in place)

- **From:** W3-06
- **Wave:** 10 · **Size:** S · **Depends on:** GV-09, GV-23, GV-53
- **Covers:** R2-16, GP-22

**Goal.** Index the legacy whisper transcripts alongside the farm's normalized layout, converting each object in memory, so show variety can draw on them.

**Design.**

tools/passage-index/sources.mjs gains r2LegacySource({client, bucket, legacyMap, commands}):
- It lists the bucket root and keeps keys that W3-02 parseLegacyKey accepts.
- It resolves each key through legacy-map.json from W3-03 to {show_id, guid}. Unresolved keys are skipped and counted by reason: unmatched, ambiguous, no-map.
- It GETs the object, then runs convertWhisperDoc and toNormalizedBody (transcript_source 'asr-local', no source_url).
- It yields fileName = `${corpusSafeKey(guid)}.json` so W3-04's locate rule finds it as an exact name. corpusSafeKey is mirrored by tools/segments safeKey, the function config.mjs re-exports.
- stat = {size, mtimeMs: LastModified}; origin = {kind:'legacy', key, etag}.

stream-index.mjs gains --source r2-legacy and --source r2-all (normalized, then legacy).

When the same (show_id, guid) arrives from both sources, the farm-normalized body wins. The legacy duplicate is skipped and counted, so an episode is never indexed twice. That requires r2-all to stream normalized first and to keep a per-show set of guids already yielded.

**Files edited:**

- tools/passage-index/sources.mjs
- tools/passage-index/stream-index.mjs
- tools/passage-index/README.md
- tools/passage-index/sources.test.mjs
- test/suite-integrity.test.js

**New files:**

- none

**Acceptance:**

- Legacy objects are converted and reach the indexer with no local body file.
- Unresolved keys are counted by reason and never indexed.
- A legacy duplicate of a farm-normalized episode is skipped.
- Farm keys, fingerprints and probe keys are never treated as legacy.
- Converted bodies carry transcript_source 'asr-local' and no source_url.

**Tests.** node:test using a fake listing that mixes farm, legacy, fingerprint and probe keys, W3-02's synthetic whisper fixtures and a stub legacy map. Cases:
- conversion reaches the stub
- skip counts
- duplicate preference
- an etag change triggers a rebuild
Raise the floor.

**Flag.** Opt-in --source values. The default stays local.

**Live step.** After W3-03 has produced legacy-map.json, run `stream-index.mjs --source r2-all --full` on the Spark and post the per-show counts.

**Founder need.** The R2 read key, plus foray-db's mapping export if RSS resolution leaves many keys unmatched.

**Risk.** Whisper bodies carry no speaker labels, so turn boundaries degrade to sentence boundaries; tapeExtent already falls back that way. Regenerate the legacy map before each nightly, or it goes stale.

### Wave 11

#### GV-61 · No web research on the timed path: 'none' and 'dossier' research routes, shared researcher for ST-03 and ST-07, topic scope on the context, evidence cache for anthropic only

- **From:** W2-10, W3-16
- **Wave:** 11 · **Size:** S · **Depends on:** GV-03, GV-37
- **Covers:** OQ-04, GP-06, R1-05, R2-20

**Goal.** Apply OQ-04's adopted default: clip transcripts only on the timed path, and outside facts only from precomputed dossiers. Two stages use web search today: ST-03 (researchShape.ts:409-433 → AnthropicExternalResearcher.research) and ST-07 (gatherEvidence.ts:562-675 → retrievePassages). They must make no call in local mode, and no cached Haiku web passage may re-enter a Foray.

**Design.**

INTEGRATION NOTE (merged W2-10 + the researcher half of W3-16; both built a NullExternalResearcher).
- Selection goes through the routing table's research route (GV-03): FORAY_STAGE_RESEARCH=none|stub|anthropic|dossier. There is no FORAY_RESEARCHER variable. In local mode the default is none (OQ-04).
- From W3-16 item 4: ExternalResearchContext gains optional topicNodeIds; runPipeline's ctx gets an explicit type and, after the topic decision, ctx.topicNodeIds = taxonomyLineage(topic) (taxonomyFamily.ts:132) when the topic resolves. DossierExternalResearcher (GV-69) scopes by it.
- The 'dossier' route lazy-requires DossierExternalResearcher and throws a clear 'not built' error until GV-69 merges.
- Evidence cache: W3-16 item 5's rule wins over W2-10 item 5. DefaultEvidenceGatherer's default cacheDir is null for every provider except 'anthropic' (gatherEvidence.ts:398-399), so no non-web researcher reads or writes data-local/evidence and old Haiku documents can never replay.

--- From W2-10 ---
1. MOVED TO GV-37: backend/src/generation/NullExternalResearcher.ts (providerName 'none', research() resolves {notes:'', controversies:[]} with no I/O, no retrievePassages, so retrieveFor returns 'unavailable' at gatherEvidence.ts:638 and writes no cache).
2. MOVED TO GV-37: the 'none' registration in createExternalResearcher. This card adds only the 'dossier' route's lazy require and its 'not built' error.
3. researchShape.fanOutExternalResearch (:410) returns an empty map without iterating when providerName==='none', and logs a single skip line naming OQ-04.
4. runPipeline.ts:1399 calls createEvidenceGatherer({researcher, cueProvider}) with the pipeline's own researcher (runPipeline.ts:993). Today DefaultEvidenceGatherer builds a second researcher from createExternalResearcher() (gatherEvidence.ts:392), so one route now governs both ST-03 and ST-07.
5. Cache (DS-05): in DefaultEvidenceGatherer (gatherEvidence.ts:400), defaultDir is null for 'none' as well as 'stub'. That way printEvidenceFor's readCache (:571) cannot serve old Haiku documents. Other non-anthropic researchers use data-local/evidence/<providerName>/; the anthropic path keeps the root.
6. Unmet demand is counted. A page whose beat has requiresEvidence and whose pack has no print doc adds to EvidencePack.printSkipped. That is summed into NarrationWriteStats.printSkipped (writeNarration.ts:228) and reported as veracity.printEvidenceSkipped through buildVeracityMetrics. The field is measured, not gated.

**Files edited:**

- backend/src/generation/createExternalResearcher.ts
- backend/src/generation/researchShape.ts
- backend/src/generation/gatherEvidence.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/writeNarration.ts
- backend/src/generation/veracityMetrics.ts
- test/suite-integrity.test.js
- backend/src/generation/ExternalResearcher.ts
- backend/test/gatherEvidence.test.ts
- backend/test/runPipeline.test.ts

**New files:**

- backend/test/noWebResearch.test.ts
- backend/test/createExternalResearcher.test.ts

**Acceptance:**

- A runPipeline-style run with NullExternalResearcher and spies makes zero research() and zero retrievePassages() calls and completes.
- With a temp cacheDir pre-seeded with a Haiku-shaped file for a claim hash, a 'none' gatherer returns no print doc.
- Injecting deps.researcher changes evidence behaviour, which proves the gatherer shares the pipeline's researcher.
- printEvidenceSkipped is counted for requiresEvidence pages and appears in veracity.
- gatherEvidence.test.ts, researchShape.test.ts, evidencePrefetch.test.ts and veracityMetrics.test.ts pass unchanged.
- ctx.topicNodeIds is set after the topic decision and is absent when the topic is unresolved.
- A non-anthropic researcher never reads or writes data-local/evidence.
- FORAY_STAGE_RESEARCH=dossier before the dossier researcher exists throws a clear 'not built' error naming the variable.

**Tests.** From W2-10: Run `npx vitest run test/noWebResearch.test.ts`, then gatherEvidence.test.ts, researchShape.test.ts, evidencePrefetch.test.ts, veracityMetrics.test.ts and runPipeline.test.ts, one at a time.
From W3-16: new test/createExternalResearcher.test.ts (route matrix), gatherEvidence.test.ts (cacheDir null for 'none'), runPipeline.test.ts (researcher spy for topicNodeIds and zero retrievePassages calls).

**Flag.** FORAY_STAGE_RESEARCH (routing table). 'none' is the default in local mode only; stub and anthropic-legacy modes keep today's behaviour.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** W2-10: Patch and Carry beats that leaned on web passages lose them. That is the accepted OQ-04 trade, measured by printEvidenceSkipped and recovered by dossiers (R2-20, retrieval workstream). Moving the prefetch stage off the critical path is R1-05 (retrieval workstream). veracityMetrics.ts and runPipeline.ts are shared files. Governed path.
W3-16: Governed. Under 'null', Carry and Patch pages with requiresEvidence degrade through the existing F-60/F-77 path until dossiers (W3-21) exist. That is the adopted OQ-04 default.

#### GV-62 · Keep and fork checkpoints so arm B reruns only from the changed stage (bench prompts only)

- **From:** W7-03
- **Wave:** 11 · **Size:** M · **Depends on:** GV-55
- **Covers:** R2-21

**Goal.** Isolate one stage's effect exactly and cut Spark time per experiment. Arm B reuses arm A's banked upstream stages byte-for-byte and regenerates only from the changed stage on. Today every successful run deletes its checkpoint (generateForays.ts:802), so nothing upstream survives to fork.

**Design.**

INTEGRATION NOTE: depends on the report plumbing of GV-55 (W7-02 merged there).

Pure half, backend/src/generation/checkpoint.ts (no fs, so promptNoPersistence.test.ts stays green):
- CHECKPOINT_STAGE_ORDER = ['understand','topic','research-shape','spine','identity','deepen','source','narrate','stitch']. These are the keys runPipeline banks: understand :1044, topic :1164, research-shape :1174, spine :1208, identity :1315, deepen:i :1325, source :1334, narrate:i :1610, stitch:i :1676. The act-indexed keys match by prefix.
- 'identity' sits AFTER 'spine' because the post-spine topic fallback (F-91) can set its topic from the spine. Rerunning from the spine must therefore drop identity too.
- stagesAtOrAfter(keys, rerunFrom) returns the keys at or after rerunFrom, and throws on an unknown stage.
Driver half, cli/generateForays.ts:
- PromptSpec (:86) gains an optional `bench: true`. normalizePrompts already passes objects through.
- --keep-checkpoints skips the success-path discard (:802) only, and only for specs with bench: true. The CLI refuses the flag when any spec lacks bench: true (§9.4: listener prompts' checkpoints never outlive the run).
- --seed-checkpoints <dir> --rerun-from <stage>: before each prompt runs, if <dir>/<checkpointKey>.checkpoint.json has CHECKPOINT_VERSION and this prompt's checkpointFingerprint, the file is copied into this --out directory's FileCheckpointStore (checkpointStore.ts:39), and FileCheckpointStore.drop(key, stagesAtOrAfter(Object.keys(stages), rerunFrom)) is called on it. checkpointKey is candidateFilename-derived, so it is identical across arms.
- A missing or mismatched seed is logged; the prompt runs from scratch and its row carries seededFrom: null.
- ReportEntry gains seededFrom?: {dir, rerunFrom, stagesKept} | null.
- --rerun-from without --seed-checkpoints is refused, as is --seed-checkpoints together with --no-resume or --dry-run (dry-run disables the store, :685).

**Files edited:**

- backend/src/generation/checkpoint.ts
- backend/src/cli/generateForays.ts
- test/suite-integrity.test.js

**New files:**

- backend/test/checkpointFork.test.ts

**Acceptance:**

- stagesAtOrAfter(['understand','topic','research-shape','spine','identity','deepen:0','source','narrate:0','stitch:0'],'spine') returns spine, identity, deepen:0, source, narrate:0, stitch:0
- A source-scan test fails if runPipeline.ts banks a stage key that is not in CHECKPOINT_STAGE_ORDER
- --keep-checkpoints with all-bench specs leaves <key>.checkpoint.json beside the candidate; with any non-bench spec the CLI refuses before any model call
- A seeded run with --rerun-from narrate makes no understander, spine or deepen builder call (counting stubs) and records seededFrom
- A version- or fingerprint-mismatched seed is ignored, logged, and recorded as seededFrom: null
- promptNoPersistence.test.ts stays green
- BACKEND_FLOORS in test/suite-integrity.test.js has an entry for checkpointFork.test.ts (added in this PR, so 'every backend suite on disk is covered by a floor' stays green).

**Tests.** backend: npx vitest run test/checkpointFork.test.ts. It covers the pure ordering, the runPipeline.ts key scan, and driver tests through generateOneCandidate whose injected runPipeline wraps runForayPipeline with counting Stub builders and an injected finalize, using a tmpdir FileCheckpointStore. The tests assert the drop calls and the zero counts. Add a BACKEND_FLOORS entry.

**Flag.** --keep-checkpoints, --seed-checkpoints, --rerun-from (opt-in CLI flags; bench prompts only)

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed path. Both this card and W7-02 edit ReportEntry in generateForays.ts, so it lands after W7-02. A later CHECKPOINT_VERSION bump, or a new stage key from R1-04/R1-02, invalidates seed dirs or must extend CHECKPOINT_STAGE_ORDER; the key-scan test makes the second case fail loudly. Evidence is not checkpointed but is cached by claim hash in data-local/evidence, which both arms share; that is intended.

#### GV-63 · Phone diagnostics: per-clip precision row and per-Foray tally ('played at authored time vs skipped')

- **From:** W6-15
- **Wave:** 11 · **Size:** S · **Depends on:** none
- **Covers:** R2-06

**Goal.** Record locally on the phone how each Foray clip was handled at load, and print a per-Foray tally in the copied record so the founder's paste yields the MQ row. The possible outcomes:
- exact
- padded
- static (non-DAI)
- skipped for DAI drift
- dropped for missing anchors
- failed to load

**Design.**

Today only refusals are logged:
- queue-manager :2052 `foray.segment.skipped.atLoad` on a gate refusal, plus a note line at :2055;
- :2130 after load attempts are exhausted;
- :951 build drops.
segmentLoadGate returns `{ok:true}` with no note for a non-DAI item (seek-policy.js:292), `{ok:true, note:'<precision> — <reason>'}` (:313), or `{ok:false, reason}` (:312).

1. player/queue-manager.js emits `foray.clip.precision kind=<k> item=<id>`:
   - at :2050-2055: when gate.ok with no note, kind=static; with a note, kind is the note's leading word lowercased (exact|padded); on refusal, kind=skipped;
   - at :2130: kind=load-failed;
   - in setQueueFromForay (:951): kind=dropped for each report.skipped entry whose reason starts with 'DAI source without both anchors' (foray-queue.js:388).
2. player/diagnostic-log.js (not parity-covered):
   - add `RE.clipPrecision`;
   - add a new row kind `clip` with vocabulary CLIP_PRECISION={static,exact,padded,skipped,dropped,load-failed} and the item through dataIdOf, never free text;
   - add a report section per Foray: 'clips: N static, N exact, N padded, N skipped, N dropped, N load-failed; X% at authored time', where authored time = static+exact+padded.
3. Engine lane: count engine `gate` rows (played) and `skip` rows (refused) from ENGINE_ROW_KINDS (:2892) into the same tally.
4. Local-only, with no transmission (#264).
5. queue-manager.test.js is a covered parity suite. New manager tests go into player/parity/exclusions.json with reason 'webview-only' (the engine lane is tallied from its own rows), in the same PR.

**Files edited:**

- player/queue-manager.js
- player/diagnostic-log.js
- player/diagnostic-log.test.js
- player/queue-manager.test.js
- player/parity/exclusions.json
- test/suite-integrity.test.js

**New files:**

- none

**Acceptance:**

- A Foray with one exact, one padded and one drifted DAI clip produces three clip rows and a tally line reading 67% at authored time.
- A non-DAI clip produces a static row and counts as authored time.
- A dropped (no-anchor) segment produces a dropped row at build, and an exhausted load produces load-failed.
- Rows store only vocabulary words and the authored item id, and nothing is transmitted.
- player/parity/coverage.test.js is green.

**Tests.** - diagnostic-log.test.js: parse, vocabulary refusal, tally, engine rows. Floor 133 -> new count.
- queue-manager.test.js: emission cases, with parity exclusions.
- Run coverage.test.js on its own.

**Flag.** None needed: a diagnostic row only, with no behaviour change.

**Live step.** The founder listens to a Foray with DAI clips on the phone and pastes the record. W6-14 turns it into the per-Foray MQ row.

**Founder need.** The paste itself; there is no transport, by design.

**Risk.** - A missing parity exclusion turns CI red.
- diagnostic-log.js carries dead voiceProbe vocabulary from #1076. Do not mix that cleanup into this change.
- The metric is 'played at authored time', not anchor resolution.

#### GV-64 · Bench --golden aggregation, --headline and --compare with tolerance bands (GEN-05)

- **From:** W1-15
- **Wave:** 11 · **Size:** M · **Depends on:** GV-08, GV-24, GV-45, GV-52
- **Covers:** GP-28, R2-02

**Goal.** Turn 50 per-prompt rows into one comparable result per run, per stratum and overall, and say which numbers moved beyond noise against a frozen golden baseline.

**Design.**

run.mjs `--golden <manifest>`:
- Joins rows by entry.promptId to stratum and listened.
- Aggregates per stratum and overall: p50/p90 of first_s, full_s, elapsed_min and lead_s; means of the scorecard MQ rates (W1-11); the MQ-21 share; and the out_tok and series medians (W1-04).
- `--headline` prints exactly the five headline numbers: MT-01, MT-02, MQ-02, MQ-05, MQ-20.
- Emits one `golden-summary` JSONL line per run id.

`--compare <golden-baseline.jsonl>`:
- BANDS: times +-15% relative, rates +-0.05 absolute, counts +-1.
- Prints better, worse or within-band per metric and stratum, and 'absent' when either side lacks the metric.
- Exits 0 (non-grading, rule 2) unless `--fail-on-regression`, which is kept for G-42b.

tools/generation-bench/golden-baseline.jsonl starts empty.

**Files edited:**

- tools/generation-bench/run.mjs
- tools/generation-bench/run.test.mjs
- docs/curation/generation-kpis.md
- test/suite-integrity.test.js

**New files:**

- tools/generation-bench/golden-baseline.jsonl
- tools/generation-bench/fixtures/golden-synth/report.json

**Acceptance:**

- On a synthetic golden report (6 entries across 4 strata), per-stratum medians match hand-computed values.
- --compare flags a 30% first_s slowdown as worse and a 5% one as within band.
- A missing metric is 'absent', never 'better'.
- --headline prints exactly the five headline numbers.
- The band table is recorded in the KPI doc.

**Tests.** node --test tools/generation-bench/run.test.mjs with the synthetic golden fixture

**Flag.** none

**Live step.** After the first 50-prompt run, commit its summary line as golden-baseline.jsonl. Re-derive the bands from two back-to-back runs of one build (the noise floor) before anyone uses --fail-on-regression.

**Founder need.** none

**Risk.** Bands chosen before any local run may be tighter than LLM noise. Re-derive them from the noise floor before --fail-on-regression is used anywhere.

#### GV-65 · Dossier selection pass by Qwen: choose and flag passages, never write text

- **From:** W3-20
- **Wave:** 11 · **Size:** S · **Depends on:** GV-30
- **Covers:** R2-20, QK-23

**Goal.** Let a local Qwen improve dossier relevance (keep, drop, flag contested) while every stored word stays fetched text.

**Design.**

tools/corpus/dossiers/llm.mjs is a minimal OpenAI-compatible fetch client:
- POST `${FORAY_LLM_BASE_URL}/v1/chat/completions` with bearer FORAY_LLM_API_KEY (or the contents of FORAY_LLM_API_KEY_FILE), the SAME variables the backend reads (GV-03), so the founder places the one #1163 key once. Only the model alias is the tool's own variable: FORAY_DOSSIER_MODEL (default the LiteLLM alias local-worker, the P40 lane, overnight). docs/curation/generation-providers.md (GV-68) documents this single set.
- response_format {type:'json_schema', json_schema:{name:'dossier_select', schema}} and chat_template_kwargs {enable_thinking:false}. Lane A2 runs --reasoning-parser qwen3, and LiteLLM drop_params can silently drop unsupported params.
- A dedicated Foray virtual key, outside the terminal-qwen callback scope.
- Align it with the backend provider layer when that lands (cross-workstream).

qwen-select.mjs:
- Per dossier: send the node label, subject sentences and numbered passages, trimmed to fit about 12k tokens (the P40 runs -c 65536 --parallel 1).
- Reply schema: {keep:int[], contested:int[], about_subject:int[]}.
- Code applies it:
  - Out-of-range indices are refused.
  - Passages not in keep are dropped, and passages are never edited.
  - contested sets passage.contested = true.
  - builder becomes 'qwen-select' with model and time.
- The code-built file is kept as <node>.code.json for comparison.
- A parse failure keeps the code-built dossier.
- The run is resumable per node, because P40 XID faults can stall it.

**Files edited:**

- tools/corpus/README.md
- test/suite-integrity.test.js

**New files:**

- tools/corpus/dossiers/llm.mjs
- tools/corpus/dossiers/qwen-select.mjs
- tools/corpus/dossiers/qwen-select.test.mjs
- tools/corpus/fixtures/dossiers/qwen-select-reply.json
- tools/corpus/fixtures/dossiers/qwen-select-bad.json

**Acceptance:**

- With a recorded reply fixture, the output keeps only the selected passages, each byte-identical to its input.
- Malformed or out-of-range replies leave the dossier unchanged.
- The request carries the json_schema response_format and enable_thinking false.
- A source scan finds no Anthropic endpoint or SDK reference.
- A rerun skips nodes already selected.

**Tests.** node:test with a fake fetch returning recorded OpenAI-format responses (good, malformed, out of range), asserting the request body shape. Add a FLOORS entry.

**Flag.** Opt-in CLI. W3-21 reads whichever dossier is on disk, and the builder field records which pass made it.

**Live step.** Run overnight against LiteLLM local-worker for every node, then spot-check 10 nodes' kept and dropped lists.

**Founder need.** A LiteLLM virtual key for Foray (#1163).

**Risk.** Qwen may drop useful passages, so the code-built file is kept for golden-set comparison. There is no Anthropic call anywhere.

#### GV-66 · Retrieval on the Spark: deployment kit, body transfer, nightly timer and runbook

- **From:** W3-22
- **Wave:** 11 · **Size:** S · **Depends on:** GV-09, GV-16, GV-48, GV-54
- **Covers:** GP-09, R1-09

**Goal.** Make moving the index and corpus to the Spark a reviewed, repeatable step, including the 5,041 publisher-fetched bodies that exist only on the founder PC and not in R2.

**Design.**

New runbook docs/plans/retrieval-on-spark.md with these sections:
- what runs where
- disk and RAM budget, from the W3-01 inventory and the W3-05/W3-07/W3-08 live numbers
- body transfer: data-local/transcripts/normalized (~462 MB, 22 shows) and corpus-digest.json copied from the founder PC to the Spark over the tailnet with rsync. Most of these were fetched by tools/segments/fetch-transcripts from publishers and are not in R2, so streaming R2 alone would lose them. The plan's 'move the 5,041 transcripts onto the Spark' is this step.
- first build: stream-index --source local --full on the copied dir; stream-index --source r2-all --full; warm --from-staged / --resolve-legacy / --supply-report; index-db ingest and embed; shortlist rebuild
- the server unit
- the nightly timer
- pointing generation at it: FORAY_RETRIEVAL_URL/TOKEN, then pull-archive
- /healthz checks and the W3-26 guard
- rollback: unset FORAY_RETRIEVAL_URL
- privacy: no query logging, LAN bind plus token

Templates under tools/passage-index/deploy/:
- foray-retrieval.service: User=foray; ExecStart node tools/passage-index/serve.mjs --r2 --cue-cache-gb 50; EnvironmentFile=/etc/foray/retrieval.env; MemoryMax
- foray-index-nightly.service and .timer: 03:30, Nice=10, CPUQuota=400%, so it yields to SGLang (OQ-07)
- retrieval.env.example: variable names only

deploy.test.mjs checks that every ExecStart path exists and runs a secret-pattern scan.

**Files edited:**

- tools/passage-index/README.md
- test/suite-integrity.test.js

**New files:**

- docs/plans/retrieval-on-spark.md
- tools/passage-index/deploy/foray-retrieval.service
- tools/passage-index/deploy/foray-index-nightly.service
- tools/passage-index/deploy/foray-index-nightly.timer
- tools/passage-index/deploy/retrieval.env.example
- tools/passage-index/deploy/deploy.test.mjs

**Acceptance:**

- Every ExecStart path exists in the repo.
- The env example holds names only, with no key-shaped values.
- The runbook names every live step and who runs it, including the body transfer.

**Tests.** node:test deploy.test.mjs: parses the unit files, checks paths and runs the secret scan. Add a FLOORS entry.

**Flag.** Docs and templates only.

**Live step.** The founder or Joey copies the normalized bodies to the Spark. Joey lands the units through a Hermes repo PR (D8: Spark changes only through merged PRs plus the spark-live tag), installs backend and tools dependencies, places the R2 read key and token, and runs the first build. The orchestrator then sets FORAY_RETRIEVAL_URL=http://192.168.0.72:<port> for generation runs.

**Founder need.** Spark access and a Hermes PR approval, the body transfer from the founder PC, the R2 read key and a retrieval token on the Spark, and disk-budget sign-off from the inventory.

**Risk.** The Spark is shared with SGLang, so the nightly is niced and CPU-capped. If disk is short, the cue cache shrinks and cold episodes fall back to per-body R2 GETs at about 100-300 ms each.

### Wave 12

#### GV-67 · Code-derived pre-spine intent; subject, angle, disappointment, title and summary come from the spine

- **From:** W4-03
- **Wave:** 12 · **Size:** M · **Depends on:** GV-02, GV-15, GV-25, GV-32, GV-49
- **Covers:** R1-02, R2-07

**Goal.** Remove the extractIntent call, and the title re-case call with it, from the chain. Keep the angle and 'what would disappoint' as explicit spine JSON fields (R2's guard). Keep topic and research working, since they need a subject before the spine exists.

**Design.**

INTEGRATION NOTE: the spine contract text lives in prompts/spine.ts (GV-32) and RawSpineSchema in replySchemas.ts (GV-02); the subject/angle-from-reply mapping is applied in both AnthropicSpineBuilder and ChatSpineBuilder (GV-25).

1. New module backend/src/generation/preSpineIntent.ts.
   - preSpineIntent(prompt): IntentUnderstanding. subject and angle are the distinct tokenizeForSourcing(prompt) terms in prompt order, at most 12, joined by spaces. priorKnowledge and disappointment are fixed sentinels ('not yet known: decided by the spine').
   - The banked understand, topic and research-shape checkpoints then hold a stopword-stripped keyword list, never the prompt verbatim. That is no worse than today, where Haiku's restatement is banked.
   - provisionalTitle(prompt) = houseStyleTitle(clampWords(first 8 keywords)). houseStyleTitle comes from copy/rules; clampWords is runPipeline.ts:409. It is used only by the pre-spine no-supply outcome (runPipeline.ts:1150).
2. understandPrompt.ts: export understandPromptFast(prompt, understander, ctx). It runs safety, then clarity (W4-02), then returns {outcome: 'understood', intent: preSpineIntent(prompt)} with no extractIntent call.
3. SpineBuildContext (SpineBuilder.ts) gains `listenerPrompt?: string`. It lives on the call stack only and is never checkpointed.
4. SpineSchema (types/spine.ts:199, strict) gains optional fields priorKnowledge, disappointment, answersDisappointment, title and summary, so banked spines still parse. answersDisappointment is one sentence on how this plan avoids the disappointment, for MQ-10. subject and angle stay required.
5. AnthropicSpineBuilder.ts: RawSpineSchema (:60) gains the same optional fields. When ctx.listenerPrompt is set, two things change:
   - The prompt's output contract asks for subject, angle, priorKnowledge, disappointment, answersDisappointment, title and summary first.
   - The returned Spine takes subject and angle from the reply instead of the intent (:155-163).
   Classic calls are unchanged. W4-04 later moves this text into spinePromptParts.
6. runPipeline.ts, fast branch (flags.foldSpineCopy):
   - The understand stage calls understandPromptFast.
   - The pre-spine no-supply stop uses provisionalTitle.
   - forayCopy (runPipeline.ts:450) moves after the spine stage and runs on {subject, angle, title, summary} from the spine.
   - mintedFrom therefore seeds forayIdFor at runPipeline.ts:1305. That already runs after the spine, so its position does not move.
   - The post-spine unresolved-topic and no-supply stops use the spine-derived title.
   - No title re-case re-ask is made. houseStyleTitle runs in code and `unstyled` is reported as today.
7. preludeItem (runPipeline.ts:1498 and :1710) is called with spine.subject instead of intent.subject, on both paths. In classic runs these are equal by construction (AnthropicSpineBuilder.ts:156 and the stub), so this is byte-identical there. In the fast path it stops a keyword list being spoken to the listener.
8. StubSpineBuilder: when ctx.listenerPrompt is set, it emits deterministic title, summary, priorKnowledge, disappointment and answersDisappointment from its own subject restatement.

**Files edited:**

- backend/src/generation/understandPrompt.ts
- backend/src/generation/SpineBuilder.ts
- backend/src/generation/AnthropicSpineBuilder.ts
- backend/src/types/spine.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/StubSpineBuilder.ts
- backend/test/runPipeline.test.ts
- test/suite-integrity.test.js
- backend/src/generation/prompts/spine.ts
- backend/src/generation/replySchemas.ts
- backend/src/generation/chat/ChatSpineBuilder.ts

**New files:**

- backend/src/generation/preSpineIntent.ts
- backend/test/preSpineIntent.test.ts
- backend/test/fastPathCopy.test.ts

**Acceptance:**

- With foldSpineCopy on, extractIntent is never called; the recording understander shows only assessClarity.
- The title and summary come from the spine reply through forayCopy's clamp and house-style code, and the id is minted from the spine title.
- A no-supply outcome reached before the spine carries provisionalTitle.
- The prelude item's script names spine.subject. On classic stub runs the prelude script is byte-identical to today.
- Fast path with stubs on a distinctive prompt: the verbatim prompt string appears in no banked checkpoint value (fake store), no outcome field and no candidate field.
- An old spine checkpoint without the new fields still parses, and the classic runPipeline.test.ts id pin is unchanged.

**Tests.** vitest preSpineIntent.test.ts (keyword derivation, determinism, never verbatim), fastPathCopy.test.ts (stubs plus fake checkpoint store: call log, copy source, prelude subject, scan of every banked value), and runPipeline.test.ts additions showing the flag-off path is identical.

**Flag.** FORAY_SPINE_FOLD_COPY, or the FORAY_FAST_PATH umbrella. Off by default. W4-01's checkpointVariant separates fold-copy checkpoints, so CHECKPOINT_VERSION is not bumped.

**Live step.** Golden-set comparison of MQ-10 prompt fit: folded-copy spines against the classic extractIntent path on the same prompts, by pairwise listen.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** The research map and topic decision now run on keywords instead of Haiku's restatement. The prompt itself already joins the topic text (F-67, runPipeline.ts:1125), so the topic change should be small, but measure no-supply rates and topic flips on the golden set. The spine model now writes subject and angle, so a weak reply can drift from the request; answersDisappointment and the golden set's MQ-10 measure that.

#### GV-68 · Zero-Anthropic enforcement: structural guard, explicit legacy opt-in, anthropicCalls=0 in report.json, relay refused by default

- **From:** W2-15
- **Wave:** 12 · **Size:** S · **Depends on:** GV-37, GV-55, GV-61
- **Covers:** HW-12, GP-06

**Goal.** Turn the founder rule 'the pipeline makes ZERO Anthropic calls' from a convention into something CI and every run prove. Today any ANTHROPIC_API_KEY selects live mode (env.ts:214), and start-run.mjs:131-136 injects a placeholder key so the run goes through the Claude relay.

**Design.**

INTEGRATION NOTE: W7-02's FORAY_FORBID_ANTHROPIC is not added; this card's double opt-in is the single guard.

1. A structural vitest, backend/test/noAnthropicInGeneration.test.ts, recursively scans backend/src/generation/**, cli/generateForays.ts and cli/generateForay.ts.
- Only a LEGACY_ANTHROPIC allowlist may import '@anthropic-ai/sdk', './anthropicCall' or an './Anthropic*' module. The allowlist is the 7 Anthropic*.ts files, anthropicCall.ts, and the lazy require lines in create*.ts.
- Nothing in chat/**, jevClient.ts or qwenJudgeClient.ts may import them (there is no jev/ subfolder).
- researchShape.ts already imports from replyErrors (W2-04).
- enrich/AnthropicEnricher.ts is out of scope by design.

2. stageRouting mode resolution changes:
- ANTHROPIC_API_KEY alone no longer selects a live mode.
- anthropic-legacy requires both FORAY_GENERATION_MODE=anthropic-legacy and FORAY_ALLOW_ANTHROPIC_LEGACY=1.
- An 'anthropic' route without both throws, citing the rule.
- The default is local when FORAY_LLM_BASE_URL is set, else stub.
- env.anthropicDryRun itself is NOT changed, because enrich/ and buildSession.ts rely on it.
- The MODE line says when a present ANTHROPIC_API_KEY was ignored.

3. createMessage increments a per-process anthropicCalls counter in usageTracking. generateForays writes anthropicCalls per entry and at the top level, and exits non-zero when it is above 0 without FORAY_ALLOW_ANTHROPIC_LEGACY.

4. tools/generation/start-run.mjs refuses to start unless --legacy-claude is passed. With the flag, driverEnv also sets both legacy variables and prints the violation. Its tests live in tools/generation/relay.test.mjs, which imports driverEnv at :62; raise its FLOORS entry (33).

5. New doc docs/curation/generation-providers.md covers modes, the FORAY_* variables, lanes, routing defaults, the judge fallback, the live steps, and the shell-env caveat from W2-08. It documents ONE set of LiteLLM variables (FORAY_LLM_BASE_URL, FORAY_LLM_API_KEY / FORAY_LLM_API_KEY_FILE) shared by the backend and the dossier selector (GV-65, which adds only FORAY_DOSSIER_MODEL).

**Files edited:**

- backend/src/config/stageRouting.ts
- backend/src/generation/anthropicCall.ts
- backend/src/generation/usageTracking.ts
- backend/src/cli/generateForays.ts
- tools/generation/start-run.mjs
- tools/generation/relay.test.mjs
- test/suite-integrity.test.js
- backend/test/stageRouting.test.ts
- backend/test/generateForays.test.ts

**New files:**

- backend/test/noAnthropicInGeneration.test.ts
- docs/curation/generation-providers.md

**Acceptance:**

- The structural test passes on the branch and fails on a planted `import Anthropic` in a generation/chat file.
- With only ANTHROPIC_API_KEY set, the resolved mode is 'stub'. anthropic-legacy without FORAY_ALLOW_ANTHROPIC_LEGACY=1 throws, naming the rule.
- This deliberately REVERSES GV-03's pinned acceptance ('with only ANTHROPIC_API_KEY, resolveRouting reproduces today's per-stage choice exactly'): this card edits that assertion in backend/test/stageRouting.test.ts to expect 'stub' for every stage, and leaves GV-03's no-key case ('nothing set' resolves to stub) as it is.
- env.anthropicDryRun's behaviour and the createEnricher tests are unchanged.
- A generateForays test whose injected runPipeline bumps anthropicCalls exits non-zero, and report.json shows anthropicCalls.
- start-run without --legacy-claude exits before starting the relay. With the flag, driverEnv carries both legacy variables (relay.test.mjs).
- A local-mode runForayPipeline case with stub-backed Chat* builders reports anthropicCalls 0. It lives in noAnthropicInGeneration.test.ts, not runPipeline.test.ts (GV-67 edits that suite in the same wave).

**Tests.** Run `npx vitest run test/noAnthropicInGeneration.test.ts`, `npx vitest run test/stageRouting.test.ts`, `npx vitest run test/generateForays.test.ts`, and `node --test tools/generation/relay.test.mjs`, one at a time, raising floors as they grow.

**Flag.** The card is itself the switch. Stub remains the keyless default, so CI and dry-runs are unaffected; a Claude run needs two explicit opt-ins.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** It removes the only working live transport (the relay) from the default path before a local run is validated, so live generation waits on the LiteLLM key. That is intended under the zero-Anthropic ruling and OQ-06. ACCEPTED ORDERING: the Spark-seconds and second-box-seconds caps and the Jev-call caps (R1-19) land only with GV-90 (wave 18) and the lane scheduler's metering with GV-93 (wave 19), so every local live step between waves 12 and 19 runs with only the $0 dollar guard, which is inert. Orchestrator rule until GV-90 and GV-93 have both merged: no unattended or batch local generation runs (generateForays over the golden set, swap-experiment arms, or any overnight generation job); single-prompt live checks only, started and watched by an agent, with the per-stage output budgets of GV-14 as the only bound on each call. The tools-side dossier selection (GV-65) is not a generation run; it is bounded by the node count and runs only with the founder's key and his go-ahead on #1163 (recorded in the founder queue). backend/src is governed; tools/ and docs/ are not.

#### GV-69 · DossierExternalResearcher: print evidence and research notes from local dossiers (no network)

- **From:** W3-21
- **Wave:** 12 · **Size:** M · **Depends on:** GV-15, GV-30, GV-61
- **Covers:** R2-20, QK-23, R1-05

**Goal.** Serve outside facts at request time from fetched-text dossiers in milliseconds, so neither the evidence wave nor ST-03 needs a web call, and every print quote is checked against bytes that were really fetched.

**Design.**

INTEGRATION NOTE: selected with FORAY_STAGE_RESEARCH=dossier through the routing table (GV-03, GV-61); dossierDir() is a generationFlags reader (GV-15).

New backend/src/generation/DossierExternalResearcher.ts (providerName 'dossier') implementing ExternalResearcher (ExternalResearcher.ts:48-58).
- dir comes from generationFlags dossierDir(), default data-local/dossiers.
- It lazily loads manifest.json and the dossier files once per process, read-only, validated with a zod schema mirroring W3-19's schema.mjs. Invalid files are skipped and logged. A missing dir gives an empty set and a single warning, which behaves like the Null researcher.

retrievePassages({claim, maxPassages, maxChars}, ctx):
- Scope = dossiers whose node_id is in ctx.topicNodeIds (W3-16), else all.
- BM25 over passage text with tokenizeForSourcing (catalogueLookup.ts:121), using the same k1 and b as transcriptTextIndex.ts (1.2 / 0.75), with idf over the scoped passages.
- Floors: matched distinct terms >= DOSSIER_MIN_TERMS (2) and idf-weighted share >= DOSSIER_MIN_SHARE (0.2). They are named as uncalibrated, to be calibrated on the golden set.
- Returns RetrievedPassage {docId, title: `${publication} — ${source.title}`, url, retrievedAt, text: text.slice(0, maxChars)}. gatherEvidence maps these to print documents unchanged (:640-656), so writeNarration's substring and publication gate (gateSelectedClaims, writeNarration.ts:739) works as it is.

research(topic, ctx): notes = up to 3 best passages, verbatim with their titles, capped at 800 chars. controversies = the first 200 chars of up to 3 W3-20 contested passages.

The module has no fetch and no fs writes. Add it to a structural test modelled on sourceBeats.test.ts:308-333. createExternalResearcher's 'dossier' branch now constructs it.

**Files edited:**

- backend/src/generation/createExternalResearcher.ts
- backend/src/generation/generationFlags.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/DossierExternalResearcher.ts
- backend/test/DossierExternalResearcher.test.ts
- backend/test/fixtures/dossiers/manifest.json
- backend/test/fixtures/dossiers/medicine.json
- backend/test/fixtures/dossiers/engineering.json

**Acceptance:**

- On synthetic fixture dossiers, a claim matching a medicine passage returns it with publication title and url. Only lineage-scoped dossiers are searched when topicNodeIds is set.
- A claim under the floors returns [].
- maxChars and maxPassages are honoured.
- research() notes are verbatim passage text.
- The module source has no fetch, http or fs-write call.
- Through DefaultEvidenceGatherer({researcher, cacheDir:null}), a Carry beat gets print documents, and a quote taken from a fixture passage passes gateSelectedClaims.

**Tests.** vitest `npx vitest run test/DossierExternalResearcher.test.ts` with synthetic fixture dossiers that validate against a fixture copied from W3-19's schema. Includes the gatherEvidence integration case. Add a floor.

**Flag.** FORAY_STAGE_RESEARCH=dossier (routing table).

**Live step.** After GV-30's live dossier build, run 3 golden prompts with FORAY_STAGE_RESEARCH=dossier. Count print documents and quote-gate passes in report.json. The first-act evidence variant (FORAY_EVIDENCE_PREFETCH=first-act) is repeated only after GV-98 (wave 22) has merged; until then the default prefetch (all acts) is used.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed. Lexical-only retrieval misses paraphrased claims; a later card can reuse W3-07's embedder. The quote gate proves agreement with fetched text, not that the text is true, which is why sources are named.

#### GV-70 · Lock-screen 'Building the next part' state for a waiting stream

- **From:** W6-20
- **Wave:** 12 · **Size:** S · **Depends on:** GV-57
- **Covers:** R1-15

**Goal.** Show the listener on the lock screen why playback paused while a streamed Foray waits for its next item. app.js is not touched.

**Design.**

1. player/media-session.js: mediaSessionView (:522) accepts an optional `awaiting:true`. It then:
   - sets the metadata title to 'Building the next part';
   - sets playbackState 'paused' rather than 'none'.
2. player/queue-manager.js passes awaiting from `_awaitingIndex` (W6-04) into the view fields it already hands to media-session.
3. media-session.test.js is a covered parity suite. Every new test is excluded in player/parity/exclusions.json with reason 'webview-only' (streaming is refused in the native lane, W6-04) in the same PR.
4. The copy string is UI text. It is lock-screen only, and the founder or Joey may reword it.

**Files edited:**

- player/media-session.js
- player/queue-manager.js
- player/media-session.test.js
- player/parity/exclusions.json
- test/suite-integrity.test.js

**New files:**

- none

**Acceptance:**

- mediaSessionView({awaiting:true, foray:true, ...}) returns the waiting title and a paused state.
- Without awaiting, the output is byte-identical to today on the existing fixtures.
- player/parity/coverage.test.js is green.

**Tests.** Add the new tests to media-session.test.js with parity exclusions, bump its floor (161 -> new count), and run coverage.test.js on its own.

**Flag.** Reached only when a stream is open (W6-04), which no surface does yet.

**Live step.** none

**Founder need.** Wording of the waiting line, if it should differ from 'Building the next part' (product copy).

**Risk.** media-session is a covered parity family. A missing exclusion turns CI red, so classify in the same PR.

#### GV-71 · Stamp rendered audio into a candidate file, never into data/forays.json

- **From:** W6-08
- **Wave:** 12 · **Size:** S · **Depends on:** GV-11
- **Covers:** GP-08, R1-13

**Goal.** Let a generated candidate carry its rendered narration (audio_url, duration_sec, render{}) for review and later catalogue promotion, without writing data/forays.json.

**Design.**

tools/narration/stamp-narration.mjs gains a `--candidate PATH` mode.
1. An adapter, `candidateToDoc(c)`, returns {forays:[{id:c.id, status:'draft', items:c.items, runtime_sec:c.runtimeSec}]}.
2. It then calls the existing pure stampForays(doc, manifests, {base, profile}) (:110) and writes items and runtimeSec back into the candidate JSON.
3. The write is refused if the resolved path equals data/forays.json or lies anywhere under data/.
4. The stale-script and profile refusals carry over unchanged.
5. Document in the tool's header that a stamped candidate cannot be PUBLISHED while check-forays RENDERED_NARRATION_ON_PUBLISHED is false (check-forays.mjs:316). The catalogue lane (W6-17) must keep it a draft or strip audio_url.

**Files edited:**

- tools/narration/stamp-narration.mjs
- tools/narration/stamp-narration.test.mjs
- test/suite-integrity.test.js

**New files:**

- none

**Acceptance:**

- Stamping a candidate fixture sets audio_url and duration_sec on its narration items, and restates runtimeSec by the rendered delta.
- --candidate pointing at data/forays.json, or at anything under data/, is refused and nothing is written.
- A stale script (text_sha256 mismatch) is refused exactly as it is for forays.json.

**Tests.** stamp-narration.test.mjs covers the candidate path, the data/ refusal and the runtime restatement. Update the floor.

**Flag.** The new --candidate mode is opt-in. The forays.json path is unchanged.

**Live step.** none

**Founder need.** none

**Risk.** The candidate uses camelCase runtimeSec and stampForays expects snake_case runtime_sec. The adapter handles this, and a test pins it.

#### GV-72 · Whisper round trip (WER <= 5% per item) and a per-Foray loudness spread report

- **From:** W6-12
- **Wave:** 12 · **Size:** M · **Depends on:** GV-22
- **Covers:** R2-18

**Goal.** Catch mispronounced or garbled rendered lines automatically, and report the loudness spread across items. Per-line loudness normalization already exists.

For each rendered line:
- transcribe it back;
- score word error rate against the script;
- list flagged lines and lexicon candidates;
- optionally hold flagged lines so the phone voice speaks them instead.

**Design.**

Loudness is already per item: normalize_and_encode runs per line (render-foray.py:558) and records the result in the manifest entry.

1. New tools/narration/asr-check.mjs, pure:
   - `normalizeForWer(text)` = canonical() from tools/segments/merge-segments.mjs (:152, exported, and its main runs only when invoked directly) plus `spokenNumbers`, which turns digits, years and ordinals into words.
   - `scoreItem(script, asrText)` -> {wer, refWords, errors, suspects}, using wordEditDistance (tools/transcribe/anchor-match.mjs:50).
   - `checkManifest(manifest, asrByKey, {maxWer:0.05, minRefWords:20})`. A line shorter than minRefWords is flagged only on 2 or more errors, because a single error on a 10-word line is already 10%.
   - CLI: `asr-check.mjs <render-out> --asr asr.jsonl [--hold-flagged] [--json out]`. --hold-flagged rewrites flagged entries to status 'flagged'. stamp (stamp-narration.mjs:122) and upload (upload-narration.mjs collectUploads) take only rendered or unchanged entries, so the phone voice speaks a held line (NA-01).
2. New tools/narration/asr-transcribe.py, the runner:
   - faster-whisper or whisper.cpp, model configurable, over each rendered .m4a;
   - writes asr.jsonl {key, text, model};
   - `--check` flag; makes no network calls.
3. render-foray.py report_markdown (:271) gains one line per Foray: min/max output_i, spread in LU, and max output_tp. A spread over 1.0 LU is flagged.

**Files edited:**

- tools/narration/render-foray.py
- tools/narration/render-foray.test.mjs
- test/suite-integrity.test.js

**New files:**

- tools/narration/asr-check.mjs
- tools/narration/asr-check.test.mjs
- tools/narration/asr-transcribe.py

**Acceptance:**

- Recorded ASR fixtures: an exact line scores 0, a line with numbers as digits scores 0 after normalisation, and a mangled proper noun on a line of 20 or more words exceeds 5% and lists the noun as a suspect.
- With --hold-flagged, stamp-narration stamps only unflagged lines and collectUploads skips flagged ones.
- --report prints a loudness spread line per Foray and flags a spread over 1 LU.
- No transcript and no audio is committed; the fixtures are short synthetic texts.

**Tests.** - asr-check.test.mjs: node:test with recorded ASR text fixtures, the 5% threshold edge, and the short-line rule.
- render-foray.test.mjs: the --report spread line.
- Add floors.

**Flag.** A new tool that nothing runs automatically. It only reports unless --hold-flagged is passed.

**Live step.** Run asr-transcribe.py plus asr-check on a rendered draft on the Spark (or on CPU, about 1.33x real time for base.en) to calibrate the 5% threshold against clean Kokoro output. Feed lexiconCandidates into the hard-terms review.

**Founder need.** none

**Risk.** - Whisper's own error rate on clean TTS may sit near 2-5%, so the threshold needs a live calibration.
- Proper-noun spelling variants inflate WER, so suspects need human review before they enter hard-terms.json.
- Comparing narration loudness against tape loudness is not covered: it needs clip audio measurement.

### Wave 13

#### GV-73 · writeAct streaming path: gate each seam as its line closes, release code-checked intro seams early, keep finished seams on a token-cap cut

- **From:** W4-10
- **Wave:** 13 · **Size:** M · **Depends on:** GV-38, GV-43
- **Covers:** R1-06, R1-01, GP-05

**Goal.** Turn a 74 s blocking act call into seam 1 checked at about 7 s, while the round's act-level verification keeps exactly today's rules for everything else.

**Design.**

Inside writeActNarration (writeAct.ts:308), when options.streamSeams is set and writer.writeActStream exists:
1. Seam layout: new actSeams.ts export introOnlyFirstSeam(plans: SeamPlan[]).
   - When s0 introduces a clip and also carries beats, it moves those beats into the seam that follows that clip, creating one if absent. Line 1 is then introduction-only and claim-free (R2's condition).
   - Seam ids are renumbered consistently; beat ids are unchanged.
2. Round 1 consumes the stream. For each seam event it runs gateSeamClaims (:821), then validateSeam (:865), against an incremental act source set: the clip windows, ground pages and the gated claims of the seams already arrived.
   - A seam with no claims and no beats that passes is RELEASED. It is checked by code only (Q-02 naming and the restate check). The card fires options.onSeamChecked?.({actIndex, seamId, script, verifiedBy: 'code', clipId?, atMs}), sets released = true, and treats the seam as frozen.
   - A claim-bearing seam is released only if the optional verifier.verifySeam (verification workstream) confirms it. Otherwise it waits for the act verify.
3. At stream end the existing mechanicalPass (:522), buildActSources, verifyAct, judge (:977) and roundNotes (:1067) run on the full reply exactly as today (:413-474), with released seams counted as frozen.
   - If judge would refuse a released seam, it is NOT edited, because it may be playing. stats.releasedThenRefused += 1, and its beats are re-opened so roundNotes routes them to the next unfrozen seam.
4. stopReason 'length': finished seams are kept. Each unfinished or missing seam gets the mechanical issue 'unfinished: the writer stopped at its token cap', and the next round asks only for those. The classic path keeps its TruncatedReplyError.
5. writeNarration.ts threads onSeamChecked with actIndex. runPipeline.ts adds RunPipelineDeps.onSeamChecked, forwarded, for the delivery workstream (R1-15).
6. NarrationWriteStats (writeNarration.ts:228) gains seamsReleasedEarly, releasedThenRefused and firstSeamCheckedMs. buildVeracityMetrics carries them into report.json.
7. The streamed request carries the W4-08 frame like the non-streamed one.

**Files edited:**

- backend/src/generation/writeAct.ts
- backend/src/generation/actSeams.ts
- backend/src/generation/writeNarration.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/veracityMetrics.ts
- backend/test/actNarration.test.ts
- test/suite-integrity.test.js

**New files:**

- backend/test/actStreaming.test.ts

**Acceptance:**

- The stub stream with a per-seam delay on the fake clock fires onSeamChecked for s0 before the stream's last seam arrives, and s0 has no claims.
- For the same writer output, the streaming path's final WrittenAct equals the non-streaming path's, apart from the frozen flag on released intro seams.
- A scripted stopReason 'length' after 2 of 4 seams keeps both finished drafts. Round 2's request asks only for the 2 unfinished seams, and nothing throws.
- A released seam never appears in a later round's edit list, and releasedThenRefused is 0 across the actNarration fixtures.
- introOnlyFirstSeam moves beats out of s0 only when s0 introduces a clip, and every beat stays in exactly one seam (planActSeams' invariant).

**Tests.** vitest actStreaming.test.ts (fake clock, scripted streams, truncation, release and freeze), the actNarration.test.ts regression, and actSeams unit cases for introOnlyFirstSeam.

**Flag.** FORAY_WRITER_STREAM (or the fast-path umbrella) sets options.streamSeams. It applies only when the writer implements writeActStream. Default off.

**Live step.** Measure seam-1 time on the Spark: first token plus about 150 tokens of JSONL prose (MT-12, prose-in-JSON tok/s). This is R1's 7 s against 2 s question.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Moving s0's beats after the first clip changes where those claims are spoken. It stays behind the streaming flag and the golden-set listen decides. The incremental gate differs from the act-wide gate, so the act-level pass remains the authority and only decides early release of claim-free seams. onSeamChecked is a signal, not permission to play: per-item serving waits for the per-act veracity gate (R2-13/QK-29, delivery workstream).

#### GV-74 · Backend render stage: enqueue ready narration items and fold audio state into delivery (phone voice first)

- **From:** W6-07
- **Wave:** 13 · **Size:** M · **Depends on:** GV-22, GV-33, GV-44
- **Covers:** GP-08, R1-13, R1-15

**Goal.** Put narration rendering inside the generation run, per item and in play order, without ever blocking first audio. An item without a file is marked phone-voice and stays playable (NA-01, OQ-03 default).

**Design.**

1. New backend/src/generation/narrationRender.ts. Pure, with no fs.
   - `interface NarrationRenderClient { enqueue(jobs: RenderJob[]): Promise<void>; results(): Promise<RenderResult[]> }`
   - `RenderJob = {jobId, forayId, itemId, script, priority /* item index */, lexicon?}`
   - `renderJobsFor(ev: ItemReadyEvent)` makes jobs for narration items only, and only when they are servable under W6-01's policy.
   - `audioStateFor(itemId, results, policy)` returns 'pending', 'rendered' or 'phone-voice'.
   - The audio policy is 'phone-voice-first' | 'await-render'. The default, phone-voice-first, ignores audio for readiness. Under await-render, readiness needs a rendered or failed result (failed falls back to phone-voice).
2. New backend/src/cli/spoolRenderClient.ts. It writes SPOOL/in job files (W6-06 schema) and reads SPOOL/done.
3. generateForays.ts adds `--render-spool <dir>` and `--audio-policy`, and wires onItemReady (W6-02) to enqueue jobs.
4. Snapshots (W6-03) set a narration item's `audio_url` only when its done record carries `public_url`, which W6-06's spool-upload writes after a confirmed upload. Otherwise the phone speaks the script.
5. MT-09: the report's delivery block gains `render:{firstRenderedMs, narrationSec, renderWallSec, realtimeFactor, failed}`.

**Files edited:**

- backend/src/cli/generateForays.ts
- backend/src/generation/jobSink.ts
- backend/test/generateForays.test.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/narrationRender.ts
- backend/src/cli/spoolRenderClient.ts
- backend/test/narrationRender.test.ts

**Acceptance:**

- With a fake RenderClient, jobs are enqueued in item-index order, and the first narration item has the lowest priority value.
- A failed render marks the item phone-voice, and the item still appears in the snapshot without audio_url.
- await-render holds readiness until a result arrives; phone-voice-first does not.
- No audio_url is ever written unless the done record carries public_url.
- report delivery.render is populated from fake results.

**Tests.** - narrationRender.test.ts: fake client and fake clock.
- spoolRenderClient, tested against a tmpdir in generateForays.test.ts.
- Add floors.

**Flag.** --render-spool is off by default. The audio policy defaults to phone-voice-first, so first audio never waits on rendering.

**Live step.** An end-to-end run on the Spark with the worker (W6-06/W6-09) and uploads, reading firstRenderedMs against first audio.

**Founder need.** founder-approved label (orchestrator applies); plus the R2 narration bucket and write token on the render host (#119/#120) before any audio_url can be real.

**Risk.** - Governed path.
- phone-voice-first must remain the default, or the 30 s target breaks.
- A medium Foray carries 9-17 min of narration, so the CPU render can fall behind the playhead. The phone voice covers any missing file.
- A candidate stamped with audio_url hits check-forays' RENDERED_NARRATION_ON_PUBLISHED=false (check-forays.mjs:316) if it is ever published. Promotion must keep it a draft or strip audio until that flag flips (W6-08).

#### GV-75 · Stage-swap experiment runner: plan, run, collect and decide (all-local arms, sealed blind pairs, ledger row)

- **From:** W7-04, W2-16
- **Wave:** 13 · **Size:** M · **Depends on:** GV-35, GV-36, GV-45, GV-55, GV-62, GV-68
- **Covers:** R2-21, GP-27

**Goal.** Make each stage swap or lever trial a reproducible command set that ends in a ledger row. The tool never calls a model. It prints the arm commands (the live step), turns the two arms' outputs into a blind pairwise pack plus scorecard and timing deltas, and applies W7-01's rule to the founder's cards.

**Design.**

INTEGRATION NOTE (merged W7-04 + W2-16; both wrote a stage-swap harness). W7-04's plan/collect/decide wins. Carried over from W2-16: a `run` subcommand executes the planned arms with an injected spawn (driver located by start-run's driverEntryFromPackage) into data-local/swaps/<id>/<arm>; --dry-run spawns nothing; an override naming anthropic is refused before anything is spawned. Arm env sets FORAY_GENERATION_MODE=local and every FORAY_STAGE_* explicitly (W7-02's FORAY_FORBID_ANTHROPIC is not needed: GV-68's double opt-in refuses Claude). Pairs use the blind packs of GV-36; W2-16's own pairingManifest is not built. The golden manifest is GV-45; bands come from GV-64 when present.

--- From W7-04 ---
tools/generation-bench/swap-experiment.mjs. An experiment spec at tools/generation-bench/swaps/experiments/<id>.json has the shape {id, kind, stage|lever, armA: 'adopted' | {env}, armB: {env overrides}, rerunFrom, golden: <manifest path>, expect: {stageAssignments?, levers?}}.
1) plan <spec>:
- Builds each arm's env from adopted-stack.json (W7-01). FORAY_GENERATION_MODE=local is set, FORAY_ALLOW_ANTHROPIC_LEGACY is never set (it is stripped if inherited), and every StageId from stageRouting (GV-03; imported from the routing module's exported stage list, not counted by hand) is set EXPLICITLY as FORAY_STAGE_*, so the backend itself refuses any Claude fallback (GV-68). The tool does not re-implement the backend's id parsing.
- Refuses a spec that names 'anthropic', leaves a stage unassigned, or leaves the golden prompts without bench: true.
- Prints the arm A command (generateForays --prompts <golden> --out data-local/swaps/<id>/A --keep-checkpoints) and the arm B command (... --out .../B --seed-checkpoints .../A --rerun-from <rerunFrom>).
2) collect <spec>:
- Reads A/report.json and B/report.json and pairs rows by prompt.
- Drops a pair when B is unseeded (seededFrom null) while rerunFrom is set.
- REFUSES the whole collection when either arm's recorded stageAssignments or levers (W7-02/06/07/08 report fields) do not match spec.expect. Otherwise an unimplemented flag could make arm B silently equal arm A.
- Computes scorecard deltas with run.mjs rowFor (:460), imported and not edited, plus GEN-05 compare when present.
- Takes timing deltas for the changed stage and later stages only, from veracity.stageTimings or R1-14 call records; resumed stages are excluded.
- Calls the eval workstream's blind-pack builder for the listened prompts and writes data-local/swaps/<id>/evidence.json.
3) decide <spec> --cards <jsonl>:
- Unseals the key and maps preferences to A/B.
- Runs decideSwap and appends a ledger row (swap-ledger.mjs).
- Re-renders model-swaps.md and, on adopt, prints the adopted-stack.json diff.
- A 'measure' spec (E0) pairs the all-Qwen act 1 with the committed Claude reference Foray matched to the reconstructed golden prompt.
Committed specs in this card: E0-floor, E1-deepen-p40, E2-continuity-p40, E6-verifier-jev-vs-qwen. These change only FORAY_STAGE_* and are checked through stageAssignments. The lever specs E3, E4 and E5 are committed by W7-06, W7-07 and W7-08, beside the flags they test.

**Files edited:**

- test/suite-integrity.test.js

**New files:**

- tools/generation-bench/swap-experiment.mjs
- tools/generation-bench/swap-experiment.test.mjs
- tools/generation-bench/swaps/experiments/E0-floor.json
- tools/generation-bench/swaps/experiments/E1-deepen-p40.json
- tools/generation-bench/swaps/experiments/E2-continuity-p40.json
- tools/generation-bench/swaps/experiments/E6-verifier-jev-vs-qwen.json

**Acceptance:**

- plan sets FORAY_GENERATION_MODE=local, never sets FORAY_ALLOW_ANTHROPIC_LEGACY, sets every StageId from stageRouting explicitly as FORAY_STAGE_*, and refuses specs naming 'anthropic' or leaving a stage unassigned
- collect excludes unseeded B rows when rerunFrom is set, and refuses when a report's stageAssignments or levers do not match spec.expect
- Timing deltas never include stages marked resumed
- decide with synthetic cards writes the right ledger row for adopt, hold, reject and measured, and refuses cards whose pack id or key does not match
- A structural test greps the module and finds no fetch or http
- Suite floor added
- An anthropic override is refused before anything is spawned.
- --dry-run spawns nothing.
- run executes each arm through the injected spawn with FORAY_GENERATION_MODE=local and the arm's FORAY_STAGE_* set.

**Tests.** node --test tools/generation-bench/swap-experiment.test.mjs. Fixtures: copies of tools/generation-bench/fixtures/out-9/report.json edited into A/B pairs carrying seededFrom, stageAssignments and levers (including a mismatched pair), a fake blind-pack builder, and synthetic card JSONL. Snapshot of the plan output for each committed spec. Spawn is injected, so no process starts in tests.

**Flag.** none (an offline tool; production changes only through an adopted-stack diff a human commits)

**Live step.** Per experiment: run the printed arm commands on a machine with the LiteLLM and Jev keys and the data-local transcripts (founder PC or Spark), then the founder's blind listen (about 40 min), then `decide`. E0 first: it answers GP-27 with a number.
R2-21 protocol: run the 10 listened golden prompts with the spine on local:spark versus local:second, then deepen on local:second versus local:spark, about 10 min of Spark time per stage. The founder listens to the sealed pairs on the R2-01 card.

**Founder need.** LiteLLM and Jev keys (#1163) for the arm runs. Optionally upload the 14 Sep candidate (backend/data-local/foray-candidates/) as a second Claude reference for E0.
LiteLLM key; the founder's listening time (OQ-09); the golden prompt set from the eval workstream.

**Risk.** W7-04: It depends on the eval workstream's golden manifest, corpus fingerprint, blind-pack builder and GEN-05 compare. Until those land, collect marks evidence 'unfrozen' and decide cannot adopt. E0 cannot run until the provider workstream registers Qwen implementations for every stage, including a null or dossier researcher and a non-Anthropic verifier (R1-07).
W2-16: Under zero-Anthropic, R2's original protocol (one stage on Qwen, the rest on Claude) cannot run. Every variant is all-local and differs in one stage's lane, model or prompt. Claude-quality reference enters only through the committed Forays, judged by the eval workstream. W2-18's fingerprint rule prevents reusing banked Claude stages.

#### GV-76 · Whole clip window as evidence: no 3,000-character excerpt, truncation counted, a quote-centred slice for narrow judges

- **From:** W3-18
- **Wave:** 13 · **Size:** S · **Depends on:** GV-15
- **Covers:** R2-12, QK-27

**Goal.** Write and judge statements about a clip against the whole clip, not its first ~190 s (gatherEvidence.ts:77), and measure how often a page had only an excerpt.

**Design.**

INTEGRATION NOTE: generationFlags.ts is created by GV-15; this card adds its reader there.

gatherEvidence.ts:
- cueWindowText (:696) gains an optional 5th parameter opts {maxChars = EVIDENCE_MAX_TAPE_CHARS}. The gen-2 logic (keep the clip whole, shrink the pad, cut only a clip over the cap) is unchanged and just uses opts.maxChars.
- New constants:
  - EVIDENCE_WHOLE_CLIP_MAX_CHARS = 40000: about 44 min at 15 chars/s, above TAPE_WINDOW_MAX_SEC 1,800 s, so the cut path remains a safety net.
  - EVIDENCE_ADJACENT_HEAD_CHARS = 1500
  - EVIDENCE_ADJACENT_TAIL_CHARS = 3000
- tapeEvidenceFor (:489) takes a mode {whole: boolean}. When generationFlags evidenceWholeClip() is on:
  - The page's OWN clip document uses maxChars 40000. The 90 s pre-roll pad stays, so actSeams.clipOpening (actSeams.ts:268-290) still finds the start anchor.
  - ADJACENT clip documents (:432-448) become headAndTail(clip text) joined by a new TAPE_GAP_MARK ' [transcript gap: the clip runs on] '. The tail is what a bridge after a long clip needs.
- New counters on DefaultEvidenceGatherer: tapeDocsBuilt and tapeDocsCut (text ends with TAPE_CUT_MARK). They are exposed through a metrics method and merged into PrefetchingEvidenceGatherer.metrics() and so into veracity.retrieval (runPipeline.ts:1733). QK-27 becomes tapeDocsCut / tapeDocsBuilt.
- New exported sliceAroundQuote(text, quote, maxChars = 8000): the window centred on the quote's canonical match (canonicalizeForAnchorMatch), falling back to the head. It is for the verifier and Jev lanes (LM-23, about 2k tokens). This card does not change the verifier's input.

**Files edited:**

- backend/src/generation/gatherEvidence.ts
- backend/src/generation/evidencePrefetch.ts
- backend/src/generation/generationFlags.ts
- backend/test/gatherEvidence.test.ts
- backend/test/evidencePrefetch.test.ts
- test/suite-integrity.test.js

**New files:**

- none

**Acceptance:**

- With the flag unset, the cap and cut-mark pins in gatherEvidence.test.ts:147-181 pass unchanged.
- With the flag set, a synthetic 30-minute clip's document contains the clip's last sentence, and a minute-12 quote is a substring of it.
- clipOpening finds the start anchor in the whole-clip document.
- Adjacent documents contain the previous clip's last sentences and the gap mark.
- tapeDocsCut counts only cut documents, and the metric reaches veracity.retrieval.
- sliceAroundQuote returns at most maxChars and contains the quote.

**Tests.** vitest:
- `npx vitest run test/gatherEvidence.test.ts` with synthetic 1,800 s cue lists
- `npx vitest run test/evidencePrefetch.test.ts` for the metrics passthrough
- re-run test/actNarration.test.ts
Raise the gatherEvidence floor (45).

**Flag.** FORAY_EVIDENCE_WHOLE_CLIP=1 (default off).

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed. Writer prompts grow by up to about 6k tokens per long clip, so the provider workstream must keep them off the P40 lane and place them after the cached prefix (R1-10). The Sonnet/Qwen verifier gets the whole window until the verifier workstream adopts sliceAroundQuote.

#### GV-78 · Offline anchor-resolution report per Foray (MQ row, target 0.98) plus parsing of pasted phone records

- **From:** W6-14
- **Wave:** 13 · **Size:** M · **Depends on:** GV-63
- **Covers:** R2-06

**Goal.** Measure now whether a Foray's anchors would resolve after an ad shift; the phone cannot resolve anchors yet (seek-policy.js locateStep is implemented:false). Also turn the founder's pasted diagnostic record (W6-15) into the same per-Foray row.

**Design.**

New tools/transcribe/anchor-resolve-report.mjs.

Inputs:
- a candidate JSON (newSegments or segments with item_id, start_sec, end_sec, start_anchor, end_anchor);
- `--transcripts <normalized dir>`, read through FileTranscriptCueProvider's layout;
- optional `--asr-cues <dir>` for farm ASR cues of the same episode.

Simulation per segment, over K seeded scenarios:
1. Insert an ad of L in {30, 60, 120} s at a seeded time before start_sec, shifting later cues.
2. Apply seeded word noise (drop or substitute, p=0.05), or use the real ASR cues when given.
3. Search inside the window from player/locate-window.js locateWindow (pure, imported).
4. A scenario resolves if anchorMatch (tools/transcribe/anchor-match.mjs:75, using from_sec/to_sec) hits within 1 s of the shifted truth.

Uniqueness: count the anchors whose canonical form occurs more than once in the episode.

Output per Foray: {segments, resolveRate, nonUnique, unresolvable[]}, plus a JSONL row `{metric:'anchor_resolve_simulated', forayId, rate, target:0.98}`.

`--diag <pasted record.txt>` parses W6-15's `clip` report lines into rows {metric:'clip_authored_time', forayId, exact, padded, skipped, dropped, loadFailed, authoredTimeRate}.

**Files edited:**

- test/suite-integrity.test.js

**New files:**

- tools/transcribe/anchor-resolve-report.mjs
- tools/transcribe/anchor-resolve-report.test.mjs

**Acceptance:**

- Output is deterministic for a fixed seed.
- In a synthetic episode where the anchor phrase repeats after the shift, the anchor is reported non-unique, and scenarios that land on the repeat count as failures.
- A pasted-record fixture containing clip rows yields the per-Foray authored-time rate.
- The tool reads no network and writes no transcript text.

**Tests.** anchor-resolve-report.test.mjs (node:test) with synthetic cues and a synthetic diag paste. Add the floor.

**Flag.** A new offline tool; nothing runs it automatically.

**Live step.** Run on recent candidates against data-local/transcripts on the founder PC, with farm ASR cues where they exist, and post the resolve rates per Foray against 0.98.

**Founder need.** A paste of the phone's diagnostic record after listening to a Foray that has DAI clips. The record is local-only by design (#264).

**Risk.** The simulated ASR noise is a proxy for the real locate step, not the step itself. The row is named 'simulated' and must never be presented as 'anchors resolved at play'.

### Wave 14

#### GV-79 · MQ-05 clip-on-subject scorer (shadow mode): two Scores per placed clip, computed off the timed path, recorded and reported

- **From:** W5-03
- **Wave:** 14 · **Size:** M · **Depends on:** GV-15, GV-20, GV-67
- **Covers:** QK-20, GP-21, MQ-05, R2-03

**Goal.** Measure what QK-04 cannot. tapeRelevanceFromRows reads isOnTopic, which applies the same lineage rule familyGateAllows already enforced on every candidate (veracityMetrics.ts:460 vs sourceBeats.ts:462/:1197), so QK-04 is 1.0 by construction. This card asks, of every clip the Foray actually plays (the placed, extended span), whether it is about the listener's subject and whether it makes the beat's claim. Sourcing is unchanged.

**Design.**

INTEGRATION NOTE: the clipJudge key goes into gateConfig (GV-15).

New backend/src/generation/clipJudge.ts.
- Types: ClipQuestion {key, subjectSentence, claim, windowText}; ClipScores {subject: 0..4, claim: 0..4, confidence?, judge:'jev'|'qwen'|'code'}.
- interface ClipJudge { name; score(qs): Promise<Map<key, ClipScores | {unavailable:string}>> }.
- Implementations:
  - JevClipJudge(metered JevClient from W5-01, pool). One ask per clip. state = {subject, claim, passage}. Two 5-level score questions:
    - 'subject': 'How much is `passage` about `subject`?'
    - 'claim': 'How directly does `passage` make the point in `claim`?'
  - CodeProxyClipJudge: idf-weighted share of the subject sentence's tokenizeForSourcing terms in the window, mapped to 0..4 at 0.05 / 0.15 / 0.3 / 0.5. Always labelled judge:'code'.
  - NullClipJudge.
- subjectSentenceFor(spine, intent) = spine.subject plus ' (' + spine.angle + ')', plus spine.disappointment where GV-67 has added that field, whenever the spine has them (types/spine.ts:201-202; the spine always exists before sourcing, so this is the normal path). It falls back to intent.subject plus ' (' + intent.angle + ')' only when a spine field is missing. With FORAY_SPINE_FOLD_COPY or FORAY_FAST_PATH on, GV-67 makes the pre-spine intent a keyword list with 'not yet known' sentinels, so the intent is never the source there. This is the listener's subject sentence, never the taxonomy label (LM-23).

New backend/src/generation/scoreClips.ts: scoreSourcedClips(sourced, {cueProvider, transcriptArchive, catalogue, judge, subjectSentence}).
- For each TapeRelevanceInput row it takes the TapePointer at sourced.acts[actIndex].slots[slotIndex].beats[beatIndex].tape. A merged beat (row.mergedInto) is scored once on its carrier clip.
- It resolves the digest with the exported findDigestForItem (gatherEvidence.ts:754) and builds clip-only text with the exported cueWindowText(cues, start, end, 0) (:696).
- It ALWAYS scores the placed span. W5-05's judge scores the pre-extension window, which is a different stretch of tape.

Schema changes:
- types/tapeSourcing.ts TapeRelevanceInput (:247) gains optional clipScores and windowTruncated.
- runPipeline.ts TapeRelevanceInputSchema (:673) gains them as optional fields. No CHECKPOINT_VERSION bump is needed (WS-L precedent at :687-690).

Off the timed path:
- When gates.clipJudge !== 'off' (new key; default 'off'; env FORAY_CLIP_JUDGE = off|shadow|enforce), runPipeline STARTS a checkpointed stage('clip-scores') right after `source` (:1334) without awaiting it.
- It is awaited only just before buildVeracityMetrics (:1720), so first audio never waits on it. A resume never re-pays Jev.
- createClipJudge(gates, jev) returns Jev when a key exists, else CodeProxy.

veracityMetrics.ts:
- computeClipOnSubject(rows) returns {rate, scored, unscored, judge, offSubject:[{itemId, segmentId, claim, scores}]}.
- rate = the share of scored clips with subject >= 3 AND claim >= 3; null when nothing was scored.
- VeracityMetrics gains clipOnSubjectRate, clipOnSubjectJudge and clipOnSubjectDetails.
- The publish gate is untouched here (W5-06).

**Files edited:**

- backend/src/types/tapeSourcing.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/veracityMetrics.ts
- backend/src/generation/gateConfig.ts
- test/suite-integrity.test.js
- backend/test/runPipeline.test.ts
- backend/test/runPipelineCheckpoint.test.ts
- backend/test/veracityMetrics.test.ts

**New files:**

- backend/src/generation/clipJudge.ts
- backend/src/generation/scoreClips.ts
- backend/test/clipJudge.test.ts
- backend/test/scoreClips.test.ts

**Acceptance:**

- Synthetic germ-theory fixture: three clips, two of which the fake judge scores subject 0-1. clipOnSubjectRate is 0.333 and both clips are listed. QK-04 tapeRelevance stays 1.0 on the same fixture.
- A row Jev could not answer is counted in `unscored`. When every row is unscored the rate is null, not 1.
- FORAY_CLIP_JUDGE=off produces output byte-identical to today apart from the absent optional fields.
- The clip-scores stage is not awaited before narration starts: a deferred fake judge still pending does not delay the narrate:0 start (asserted with stage timings).
- A pre-card checkpoint resumes. A checkpoint with clip-scores banked resumes with zero judge calls (asserted from the fake's call log).
- Fold-on case: with FORAY_SPINE_FOLD_COPY=1 (pre-spine intent is a keyword list with 'not yet known' sentinels), the subject sentence handed to the fake judge equals spine.subject + ' (' + spine.angle + ')' and contains neither the keyword list nor the sentinel.

**Tests.** Vitest: clipJudge.test.ts, scoreClips.test.ts (an inline TranscriptCueProvider with synthetic cues), new cases in veracityMetrics.test.ts, a shadow-mode case in runPipeline.test.ts, and a resume case in runPipelineCheckpoint.test.ts.

**Flag.** FORAY_CLIP_JUDGE=shadow (or enforce) turns on the scorer. Default off.

**Live step.** On the founder PC, with the Jev key and data-local transcripts, re-run the 14 Sep germ-theory prompt in shadow mode. Its checkpoint was discarded on success (cli/checkpointStore.ts discard, generateForays.ts:802/816), so this needs a fresh run through sourcing. Post the per-clip scores to #709; the cyclospora, hepatitis B and candida clips should score low.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Until R2-12 lifts EVIDENCE_MAX_TAPE_CHARS (gatherEvidence.ts:77), a clip longer than about 190 s is scored on its first ~3,000 characters. Mark those rows windowTruncated. R1-02's fold (GV-67) is handled by building the subject sentence from the spine. Thresholds are uncalibrated until W5-07.

#### GV-80 · Timed-path round policy: at most one edit round, editing only the failing seams with a short request

- **From:** W4-13
- **Wave:** 14 · **Size:** M · **Depends on:** GV-73
- **Covers:** GP-04, GP-02, GP-05

**Goal.** Stop rounds multiplying writer and verifier output: 3 rounds on 14 Sep, 8 retry rounds in run 9, each re-sending the whole 9-11k-token act. On the timed path, round 2 becomes a small seam edit.

**Design.**

1. writeNarration.ts exports roundPolicyFor(flags, tier): {maxRounds; editScope: 'act'|'seams'}.
   - 'default' gives {NARRATION_PAGE_ATTEMPTS (3, writeNarration.ts:392), 'act'}, today's behaviour.
   - 'timed' gives {2, 'seams'}.
   - WriteActOptions gains roundPolicy, and the loop bound at writeAct.ts:396 uses maxRounds.
2. NarrationWriterBuilder gains optional editSeams?(request: SeamEditRequest, ctx): Promise<ActWriteResult>.
   SeamEditRequest = {actTitle, voice, frame?, seams: SeamBrief[] (only the failing seams, with previousScript and notes), neighbours: {seamId, script}[] (the seam before and after each failing seam), clips: ClipBrief[] (those the failing seams follow or introduce), documents: EvidenceDoc[] (only the docIds those seams or clips cite, plus their tape windows), retryNote}.
3. writeAct.ts round loop: from round 2, when editScope is 'seams' and writer.editSeams exists, call editSeams instead of writeAct.
   - Pad the reply with the frozen seams' drafts. mechanicalPass already keeps frozen text whatever the writer returns (:413-417).
   - Verify, judge, roundNotes and finalPageFor are unchanged.
4. StubNarrationWriterBuilder.editSeams re-runs stubSeam for the requested seams. The local implementation is W4-19.
5. stats.retryRounds counts as today, so report.json shows the drop.
6. R2-10's cut-instead-of-rewrite policy (another workstream) later restricts round 2 to beats a cut orphaned, through this same edit path.

**Files edited:**

- backend/src/generation/writeNarration.ts
- backend/src/generation/writeAct.ts
- backend/src/generation/NarrationWriterBuilder.ts
- backend/src/generation/StubNarrationWriterBuilder.ts
- test/suite-integrity.test.js

**New files:**

- backend/test/roundPolicy.test.ts

**Acceptance:**

- Policy 'default': actNarration.test.ts and runPipeline.test.ts behave identically (at most 3 rounds, whole-act retries).
- Policy 'timed', scripted writer that fails one seam in round 1: exactly 2 writer calls for the act. Round 2 is an editSeams call holding only that seam, its two neighbours and the documents it cites, and its serialized size is under 25% of round 1's request in the fixture.
- Frozen seams are never in an edit request. A seam still failing after round 2 ends unverified exactly as finalPageFor does today.
- A writer without editSeams under 'timed' falls back to a whole-act round 2 (2 rounds max).

**Tests.** vitest roundPolicy.test.ts (call counts, request content and size, frozen handling, fallback) and the actNarration.test.ts regression.

**Flag.** FORAY_ROUND_POLICY=timed (set by the fast-path umbrella). Default 'default'.

**Live step.** Golden-set run comparing 'timed' with 'default': retryRounds, writer output tokens per Foray (MT-05) and MQ-04 unverified pages.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Fewer rounds can leave more seams unverified until R2-10's cut and R2-13's per-act gate land (other workstreams). A short edit request loses act-wide context; the neighbours and the frame mitigate it. Measure MQ-12 before making this the default outside the fast path. writeAct.ts is shared with W4-10, hence the ordering.

#### GV-81 · Two lanes: on-demand plays behind code gates (Jev later); promotion to the catalogue requires review

- **From:** W6-17
- **Wave:** 14 · **Size:** S · **Depends on:** GV-41, GV-44
- **Covers:** R2-19, GP-07

**Goal.** Encode the lane split. An on-demand Foray is served only through its servable prefix, and it can never enter the catalogue without a recorded pass verdict for every act. Catalogue publishing keeps the hold label (D7).

**Design.**

1. generateForays.ts adds `--lane on-demand|catalogue`, default catalogue. The lane goes onto the report entry, the candidate meta (`meta.lane`) and the JobSnapshot (W6-03). FinalizeForayInput.meta is typed `{ veracity }` (finalizeForay.ts:93), so it is extended to `{ veracity; lane? }`.
2. publishForay.ts gets a new pure exported check, `laneCheck(input, verdictRows, inputSha)`, which runs before the veracity gate (:832).
   - When `input.meta?.lane === 'on-demand'`, it requires `--review-verdict <verdicts.jsonl>` holding verdict:'pass' rows for every act of this forayId, each with candidateSha256 equal to the sha of the --input file. Otherwise it exits 1.
   - --force does NOT bypass this check, and hold stays forced as today.
3. Candidates stamped with audio (W6-08) stay drafts or have audio_url stripped while RENDERED_NARRATION_ON_PUBLISHED is false (check-forays.mjs:316). The publish path reports that rule rather than failing on it obscurely.
4. On-demand serving publishes only the delivery.servableThrough items (W6-01/W6-03). Jev clip scores and per-sentence checks from the gates workstream feed assessAct's blockers later, with no change to the lane rule.
5. docs/DECISIONS.md records the rule:
   - on-demand is founder-only per D9, served behind code (and later Jev) gates, and never written to data/forays.json;
   - the catalogue is a held PR per D7;
   - review verdicts are labelled calibration data.

**Files edited:**

- backend/src/cli/generateForays.ts
- backend/src/cli/publishForay.ts
- backend/src/generation/finalizeForay.ts
- backend/src/generation/jobSink.ts
- docs/DECISIONS.md
- backend/test/generateForays.test.ts
- test/suite-integrity.test.js

**New files:**

- backend/test/publishLane.test.ts

**Acceptance:**

- publishForay --dry-run on an on-demand candidate without --review-verdict exits 1 with a lane message, even with --force.
- With a matching pass verdict for every act, publishing proceeds to the existing gates. A sha mismatch or a missing act is refused.
- Catalogue-lane candidates (the default) publish exactly as they do today.
- The DECISIONS.md entry names D7 and D9 and states the lane rule.

**Tests.** publishLane.test.ts (vitest) on laneCheck and parseArgs. generateForays.test.ts checks the lane on the report row. Add the floor.

**Flag.** The lane defaults to catalogue, so existing behaviour is unchanged.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies; backend/src/ and docs/DECISIONS.md are DENIED_PREFIXES paths). Recording the lane split in docs/DECISIONS.md is part of this PR. Widening on-demand beyond founders, so that other listeners hear unreviewed generated Forays, is a founder product and legal ruling.

**Risk.** - backend/src and DECISIONS.md are governed.
- Until Jev gates land, the on-demand lane's gates are code-only: the unverified-page block plus check-forays.
- The parseArgs edits sit next to those in W6-07, W6-13 and W6-19, so rebase in merge order.

#### GV-82 · Pronunciation hints into a run-local render lexicon (IPA notation, validated)

- **From:** W6-11
- **Wave:** 14 · **Size:** S · **Depends on:** GV-21, GV-22, GV-74
- **Covers:** R2-18

**Goal.** Make the writer's pronunciationHints actually change the audio. A hint can carry IPA in Kokoro's phoneme set. Each one is validated and merged into a per-job lexicon, and the curated hard-terms.json stays untouched.

**Design.**

Today:
- PronunciationHintSchema is a strict {word, hint} object of free text (types/narration.ts:246-253).
- The hints ride stitched items but are stripped from output (forayItems.ts:405).
- phonemize.py applies only lexicon entries that have `ipa` (plan_overrides :136), and hard-terms.json has 1 IPA entry out of 83.

1. types/narration.ts adds `ipa: z.string().trim().min(1).optional()` to the strict PronunciationHintSchema. The notation is the misaki/Kokoro phoneme alphabet already used by hard-terms.json `ipa` and checked by phonemize's vocab.
2. W6-01's ItemProvenance already carries pronunciationHints. narrationRender.renderJobsFor (W6-07) maps every hint that has ipa into job.lexicon [{term: word, ipa}].
3. render-foray.py:
   - Add `--lexicon-extra PATH` (batch mode) and accept a job-level `lexicon` (worker mode).
   - `merge_lexicon(curated, extra)`: a curated entry with ipa wins, and extra entries fill only terms that are absent.
   - Check each extra ipa with `P.ids_for(ipa, vocab)`. An unknown symbol drops that entry and records it in a new ENTRY_KEYS field, `lexicon_rejected`.
4. `lexicon_sha` keeps its meaning: the sha of the curated hard-terms.json, which stamp copies into render.lexicon_sha (stamp-narration.mjs:190) and Phase 2 stale checks rely on. Add a new ENTRY_KEYS field, `lexicon_extra_sha`, holding the sha of the run-local entries that were applied.
5. The render key needs no structural change. Chunks carry the resulting phonemes (key_material :146), so a hint that changes the phonemes re-keys only that line.
6. Prompting the writer to emit `ipa` belongs to the writing workstream.

**Files edited:**

- backend/src/types/narration.ts
- backend/src/generation/narrationRender.ts
- tools/narration/render-foray.py
- tools/narration/phonemize.py
- tools/narration/render-foray.test.mjs
- tools/narration/phonemize.test.mjs
- backend/test/narrationRender.test.ts
- test/suite-integrity.test.js

**New files:**

- none

**Acceptance:**

- A hint {word:'Gdansk', ipa:<valid>} changes that line's chunks and key, and no other line's.
- An ipa with a symbol outside the vocab is dropped and recorded in lexicon_rejected, and the render continues.
- A curated hard-terms entry wins over a run-local hint for the same term.
- lexicon_sha still equals sha256(hard-terms.json), and lexicon_extra_sha is set only when extra entries applied.
- PronunciationHintSchema still accepts hints without ipa (existing writer output).

**Tests.** - phonemize.test.mjs: merge precedence, and plan_overrides with extra entries.
- render-foray.test.mjs: rejection recording, and the manifest's ENTRY_KEYS order.
- vitest: the schema accepts the optional ipa, and renderJobsFor maps hints to job.lexicon.

**Flag.** Hints without ipa behave exactly as today. --lexicon-extra is opt-in.

**Live step.** Render a draft with a few hand-checked IPA hints on the Spark, and confirm by ear or with W6-12's ASR round trip.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** - Qwen-authored IPA cannot be verified without an ear or the ASR check, so W6-12 is the guard.
- Tests pin the ENTRY_KEYS order, so update them deliberately.
- The backend schema change is on a governed path.

#### GV-123 · Critical-path probe: builder-level spans (callLog.ts instrumentDeps), serialCallChain and the pinned stub baseline chain

- **From:** W4-01
- **Wave:** 14 · **Size:** S · **Depends on:** GV-17, GV-43
- **Covers:** R1-01, GP-03, MT-06

**Goal.** Pin today's serial-call chain before the first act is ready, so R1-01's cut from 7-11 calls to 3 is measured rather than asserted, with one span source that works offline with scripted and fake providers.

**Design.**

INTEGRATION NOTE: split out of GV-15 (W4-01 items 4 and 5) so the wave-3 foundation stays small; its only consumer is GV-117 (wave 34). It is the ONE critical-path source (see GV-15 and GV-117): builder-level spans, not CallRecords. This card touches no shared file: it adds pure modules and a test helper, and does NOT wire instrumentDeps into runPipeline.ts (GV-117 does that under FORAY_FAST_PATH).
1. New module backend/src/generation/criticalPath.ts.
   - serialCallChain(calls: {id; stage; startMs; endMs}[]): {length; chain: string[]}. It returns the longest chain in which each call starts at or after the previous one ended (MT-06 'calls in series'), computed by DP over calls sorted by endMs.
   - callsStartedBefore(calls, tMs).
   - Both are pure.
2. New module backend/src/generation/callLog.ts (src, because GV-117 uses it in production).
   - instrumentDeps(deps, clock): wraps each builder method in RunPipelineDeps: understander.assessClarity/extractIntent, researcher.research/retrievePassages, spineBuilder.buildSpine, deepenBuilder.deepenAct, narrationWriter.writeAct and writeActStream when present (GV-43), narrationVerifier.verifyAct, continuityBuilder.smoothSeam.
   - Each wrapper records {id, stage, act, startMs, endMs} in an in-memory array. It writes nothing to disk, so promptNoPersistence.test.ts still passes.
3. backend/test/helpers/recordingDeps.ts reuses instrumentDeps with a fake clock that advances by a scripted latency per stage.

**Files edited:**

- test/suite-integrity.test.js

**New files:**

- backend/src/generation/criticalPath.ts
- backend/src/generation/callLog.ts
- backend/test/helpers/recordingDeps.ts
- backend/test/criticalPath.test.ts

**Acceptance:**

- serialCallChain returns the right length on synthetic intervals: fully serial, fully parallel, diamond, and overlap by 1 ms.
- instrumentDeps records one span per builder-method call, including writeActStream when the builder has it, and writes nothing to disk.
- A baseline test runs the short tier with stub builders through recordingDeps (runForayPipeline is called with the wrapped deps; runPipeline.ts is not edited) and snapshot-pins the serial chain before onActReady(act 0). It is at least 6 calls (TM-05 as a number later cards must drive down).
- serialCallChain agrees with tools/generation-bench/runlog.mjs seriesDepth (GV-17) on the synthetic runlog fixture tools/generation-bench/fixtures/runlog-synth (asserted in criticalPath.test.ts; GV-17's own parity suite is not edited).
- BACKEND_FLOORS in test/suite-integrity.test.js has an entry for criticalPath.test.ts.

**Tests.** vitest, alone: backend/test/criticalPath.test.ts (serialCallChain on synthetic intervals, instrumentDeps span recording, and the stub-pipeline baseline chain using recordingDeps and a fake clock).

**Flag.** none. Nothing in production calls instrumentDeps until GV-117.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed path (backend/src). The baseline snapshot pins the classic default path; a later card that changes the default chain must update the snapshot deliberately. A builder method that makes several model calls (re-asks) counts as one span; GV-117 records that limitation.

### Wave 15

#### GV-83 · Show variety metric (MQ-07): distinct shows and largest show's tape share in report.json and the bench

- **From:** W3-12
- **Wave:** 15 · **Size:** S · **Depends on:** GV-04
- **Covers:** QK-21, GP-22

**Goal.** Measure on every run what QK-21 reports (one show per Foray), so variety work has a number.

**Design.**

INTEGRATION NOTE: the two bench columns are 'detail' columns (GV-04 grouping), so the committed KPI table stays unchanged.

1. New backend/src/generation/showIdentity.ts with showKeyForItem(itemId, {archive, newSegments, root}):
   - Minted items: the archive entry's show_id (deriveItemId match).
   - Pool items: segment-sources' show title through taxonomyFamily's loadShowByItemId (taxonomyFamily.ts:171-240), mapped to the catalogue show_id whose title matches, else `title:<normalized show title>`.
   - Last resort: the itemId prefix before '--'.
   The item-id prefix alone is NOT reliable: 69 of the 255 committed pool rows in data/segments.json have no '--', and taxonomyFamily.ts notes 67 of 212 pool segments have no resolvable show.
2. veracityMetrics.ts gains a pure computeShowVariety(items:[{showKey, durationSec}]) returning {distinctShows, distinctEpisodes, largestShowKey, largestShowTapeShare, tapeSecByShow}. largestShowTapeShare is null with no tape. It is an optional VeracityMetrics.showVariety field (:819) passed through buildVeracityMetrics (:927).
3. runPipeline builds the items from the stitched segment items, with the same duration join runtimeSecFor uses (:545).
4. No gate.
5. tools/generation-bench/run.mjs COLUMNS (:122) gains 'shows' and 'top show %'. Both are absent when the field is missing (bench rule 1).

**Files edited:**

- backend/src/generation/veracityMetrics.ts
- backend/src/generation/runPipeline.ts
- backend/test/veracityMetrics.test.ts
- backend/test/runPipeline.test.ts
- tools/generation-bench/run.mjs
- tools/generation-bench/run.test.mjs
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/showIdentity.ts
- backend/test/showIdentity.test.ts

**Acceptance:**

- showKeyForItem returns a non-empty key for every committed data/segments.json item, and the catalogue show_id for every pool item whose segment-sources show matches a catalogue title.
- computeShowVariety gives the right counts and share on a synthetic two-show list, and null with no tape.
- A stub pipeline run's report.json veracity carries showVariety.
- The bench prints the two new columns and shows them absent for the out-4 and out-9 fixtures.
- Gate behaviour is unchanged.

**Tests.** vitest:
- `npx vitest run test/showIdentity.test.ts` against committed data
- test/veracityMetrics.test.ts
- test/runPipeline.test.ts
node:test:
- `node --test tools/generation-bench/run.test.mjs`
Raise the floors: run.test.mjs is 40 at test/suite-integrity.test.js:1597.

**Flag.** Measure-only; no flag.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed (veracityMetrics, runPipeline). The evaluation workstream also edits tools/generation-bench/run.mjs, so coordinate merge order. Title-based keys for pool items can split one show into two keys if titles differ; the showIdentity test over committed data measures this.

#### GV-84 · Streamed act writer on the Spark: writeActStream (one JSONL call per act) and short seam edits on ChatNarrationWriterBuilder

- **From:** W4-19
- **Wave:** 15 · **Size:** M · **Depends on:** GV-31, GV-40, GV-43, GV-50, GV-80
- **Covers:** R1-06, R2-08, GP-05, GP-02

**Goal.** Run ST-08's writer on Qwen3.8-27B as one call per act, which keeps one voice, streamed in listening order on the cached prefix. Give round 2 a small seam-edit request on the same prefix.

**Design.**

INTEGRATION NOTE: writeActStream and editSeams are added to GV-31's ChatNarrationWriterBuilder (no LocalNarrationWriterBuilder); seamEditPromptParts goes in prompts/actWrite.ts (GV-50); selected with FORAY_STAGE_WRITER=local:spark. The suite is backend/test/chatNarrationStream.test.ts. If the lane cannot constrain JSONL, the request carries no response_format and lines are validated one by one.

1. ChatNarrationWriterBuilder (GV-31) gains writeActStream via ChatProvider.stream (no new LocalNarrationWriterBuilder class, decision 9).
   - Request: {stage: 'writer', act: ctx actIndex, prefix, messages: [foray + act], structured: {kind: 'jsonl', itemSchema: WRITTEN_SEAM_JSON_SCHEMA}, maxTokens: streamedActMaxTokens(request), enable_thinking: false}. Priority is not set here: the lane scheduler (GV-93) derives it from the run context (narrate act 0 critical, later acts background).
   - The text deltas pipe through JsonlSeamParser (W4-09).
   - writeAct = collectActStream(writeActStream(...)).
   - streamedActMaxTokens(request) = min(32000, max(1200, ceil(Σ seam.band[1] × 0.5))). There is no 12000 floor, because a cut keeps finished seams (W4-10).
2. editSeams(SeamEditRequest) (contract from W4-13) uses the same prefix plus a short act part built by a new prompts/actWrite.ts export, seamEditPromptParts. maxTokens = ceil(Σ failing band[1] × 0.5) + 200.
3. Selection is only the routing table: FORAY_STAGE_WRITER=local:spark picks ChatNarrationWriterBuilder (GV-37); writeActStream is used when FORAY_WRITER_STREAM (or the fast-path umbrella) is on. createNarrationWriterBuilder.ts is not edited, and there is no FORAY_WRITER_PROVIDER.
4. The verifier stays a separate instance; the 'distinct instances' rule (writeNarration.ts:526) is unchanged.

**Files edited:**

- test/suite-integrity.test.js
- backend/src/generation/chat/ChatNarrationWriterBuilder.ts
- backend/src/generation/prompts/actWrite.ts

**New files:**

- backend/test/fixtures/local/writer-act-stream.jsonl
- backend/test/chatNarrationStream.test.ts

**Acceptance:**

- Against a ScriptedChatProvider that streams the fixture in random chunk sizes, the builder yields the fixture's seams in order. The request carries the jsonl structured option, the W4-11 prefix and the computed maxTokens.
- A scripted finish_reason 'length' yields the finished seams and an 'end' event with stopReason 'length' and the unfinished seam ids.
- An editSeams request starts with the byte-identical prefix used by writeActStream, and holds only the requested seams, their neighbours and their documents.
- No @anthropic-ai/sdk import in chat/ChatNarrationWriterBuilder.ts or prompts/actWrite.ts.

**Tests.** vitest chatNarrationStream.test.ts with the scripted provider from backend/test/helpers/fakeChatProvider.ts (GV-13, stream scripts from GV-40).

**Flag.** FORAY_STAGE_WRITER=local:spark (routing table) plus FORAY_WRITER_STREAM (or the fast-path umbrella).

**Live step.** With the LiteLLM key, run the R2-21 protocol with only ST-08 swapped on the 10 listened golden prompts. Record prose-in-JSONL decode tok/s (MT-12), cachedTokens on rounds 2+, and the R2-01 pairwise listen against the Claude-written reference.

**Founder need.** founder-approved label (orchestrator applies); plus LiteLLM key (#1163), for the live step only.

**Risk.** If SGLang cannot constrain JSONL, the provider falls back to unconstrained output and per-line validation. Prefix-cache hits need the same SGLang process for the whole Foray (routing, cross-workstream).

#### GV-85 · Code-time spans inside ST-02, ST-03 and ST-06 (MT-08)

- **From:** W1-05
- **Wave:** 15 · **Size:** S · **Depends on:** GV-01
- **Covers:** MT-08, R1-14

**Goal.** Measure index load, BM25 search, transcript reads, supply counting and the tier-2 walk below stage level, so the passage-index work (R1-09) has a before number.

**Design.**

New module backend/src/generation/codeSpans.ts. It uses only currentRunLog() and currentCallContext() from runLog.ts and does not edit runLog.ts.
- `codeSpan(name, fn)` and `codeSpanSync(name, fn)` aggregate in a per-log WeakMap keyed by (stage, name) as {count, totalMs, maxMs}.
- `codeHit(name)` counts without timing.
- `flushCodeSpans(log)` appends one CodeSpanAggregate per key. runPipeline does not call it; the CLI calls it before writing the runlog (generateForays.ts, the W1-02 write site).

Instrumented sites:
- transcriptTextIndex.ts: showIndex (:384, 'index.load'), search (:227, 'index.search')
- transcriptArchiveLookup.ts: readCuesUncached (:348, 'transcript.read'); the LRU hit in getCues (:332) gets codeHit('transcript.cacheHit')
- topicSupply.ts: measureTopicSupply (:250, 'supply.measure')
- researchShape.ts: tapeWindowsFor (:298, 'research.tapeWindows')
- sourceBeats.ts: sourceBeats (:350, 'sourcing.all') and Tier2Walk.run (:1437, 'sourcing.tier2')

sourceBeats stays synchronous through codeSpanSync. Nested spans (index.load includes transcript.read) are reported inclusive, and the doc comment says so. The only new import in the files the no-fetch scan checks (sourceBeats.test.ts:306-333) is ./codeSpans, which has no fetch, http or data-local writes.

**Files edited:**

- backend/src/generation/transcriptTextIndex.ts
- backend/src/generation/transcriptArchiveLookup.ts
- backend/src/generation/topicSupply.ts
- backend/src/generation/researchShape.ts
- backend/src/generation/sourceBeats.ts
- backend/src/cli/generateForays.ts
- backend/test/transcriptTextIndex.test.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/codeSpans.ts
- backend/test/codeSpans.test.ts

**Acceptance:**

- Inside runWithRunLog, a FileTranscriptTextIndex search over the FakeBodySource pattern (transcriptTextIndex.test.ts:30-56) yields 'index.load' and 'index.search' aggregates with counts.
- Outside a log, return values are identical, and the existing sourceBeats, topicSupply and researchShape suites pass unchanged.
- The sourceBeats.test.ts no-fetch scan passes.
- After flush, the runlog holds at most one CodeSpanAggregate per (stage, name).

**Tests.** backend vitest, one file at a time: codeSpans.test.ts (aggregation, sync variant, inert outside a log), transcriptTextIndex.test.ts (spans emitted), sourceBeats.test.ts (unchanged).

**Flag.** none; inert outside runWithRunLog

**Live step.** The next founder-PC run against the real corpus gives the first MT-08 numbers. TM-07 measured 3-18 s for research search and 4-14 s for sourcing.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** The retrieval workstream rewrites tier2Candidates and Tier2Walk (R1-20 evaluate/judge/accept) and adds a PassageIndex beside transcriptTextIndex. Land this small change first, and those cards carry the codeSpan calls into the new code. Time only uncached reads, and count cache hits, to keep the overhead negligible.

### Wave 16

#### GV-86 · Fold deepen into the spine on the short tier (no deepen call before act 1)

- **From:** W4-05
- **Wave:** 16 · **Size:** S · **Depends on:** GV-32, GV-67
- **Covers:** R1-01, R1-03, GP-03

**Goal.** Make the short tier's chain clarity, then spine, then writer, by letting the spine reply carry each act's introduction, exit and beat kinds. This is R1-17's 'deepen 0 (folded)' and LM-06.

**Design.**

INTEGRATION NOTE: the shared introduction/exit rules constant lives in prompts/deepen.ts and the folded spine contract in prompts/spine.ts (GV-32).

1. ActSchema (types/spine.ts:174, strict) gains optional `introduction` and `exit` (string, trim, min 1). DeepenedActSchema (:242) = ActSchema.extend({introduction, exit required, ...}).strict() overrides them as required, so its contract is unchanged. BeatSchema (:137) already has optional kind.
2. Move the deepen prompt's introduction and exit rules (AnthropicDeepenActBuilder.ts:195-215) into a shared exported constant, used by both the deepen prompt and spinePromptParts (W4-04). With foldDeepen, the spine contract asks per act for introduction and exit, and per beat for kind, with the deepen prompt's own definition.
3. deepenActs.ts gains an export deepenedFromSpineAct(act: Act): DeepenedAct | null.
   - It returns null unless act.introduction and act.exit are both present.
   - Otherwise it parses {...act} with DeepenedActSchema and runs validateDeepenedAct (types/spine.ts:277).
   - On failure it applies spokenIntroductionAndExit (deepenActs.ts:271, module-internal) once and re-validates. If it still fails, it returns null.
   - On success it applies capArgumentBeats(carryBeatSeeds(act, pinSlotTitles(act, deepened))), the same tail deepenOneActWithRetry (:279) uses.
4. DeepenActsOptions (:333) gains `fromSpine?: (index) => boolean`. deepenActs uses deepenedFromSpineAct for those indexes and falls back to the builder when it returns null, so a spine that omitted the fields costs one deepen call, not a failure. Checkpoint keys stay deepen:<i>.
5. runPipeline.ts passes fromSpine = flags.foldDeepen === 'all' || (flags.foldDeepen === 'short' && req.duration === 'short').
6. The outcome and the report.json entry gain `deepenFolded: number[]`.

Known limit: deepen today also refines slots and beats. A folded act keeps the spine's beats as written, and the golden-set listen judges whether that costs quality.

**Files edited:**

- backend/src/types/spine.ts
- backend/src/generation/deepenActs.ts
- backend/src/generation/runPipeline.ts
- backend/src/cli/generateForays.ts
- backend/test/deepenActs.test.ts
- test/suite-integrity.test.js
- backend/src/generation/prompts/spine.ts
- backend/src/generation/prompts/deepen.ts

**New files:**

- backend/test/deepenFold.test.ts

**Acceptance:**

- Short tier, foldDeepen 'short', spine act carrying introduction and exit: the recording deepen builder is never called. The DeepenedAct equals the spine act with seeds carried and argument beats capped.
- A spine act missing either field falls back to exactly one deepen builder call.
- An introduction that leaks structure ('in this act') is repaired by spokenIntroductionAndExit or refused by validateDeepenedAct, exactly as on the deepen path.
- Medium tier with foldDeepen 'short' is unchanged.
- The deepen prompt and the folded spine prompt contain the same rules constant (asserted).

**Tests.** vitest deepenFold.test.ts (fold, fallback, validation parity with deepenOneActWithRetry on backend/test/fixtures/run2-deepen-2026-09-09.json treated as spine acts). deepenActs.test.ts is unchanged and green.

**Flag.** FORAY_SPINE_FOLD_DEEPEN=off|short|all. The fast-path umbrella sets 'short'. Default off. Folded runs get their own checkpoint fingerprint through W4-01's variant.

**Live step.** Golden-set pairwise listen on short prompts: folded introductions and exits against deepen-written ones (MQ-12 seams, MQ-20 card).

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** The spine writes introductions and exits before any tape is sourced, which deepen already does today (QK-24 is owned by the verification workstream). Folding adds about 100 tokens per act to the spine reply, which is why medium stays unfolded by default.

#### GV-87 · Research map: per-show quota so the spine is offered 2-3 shows

- **From:** W3-13
- **Wave:** 16 · **Size:** S · **Depends on:** GV-15, GV-83
- **Covers:** QK-21

**Goal.** Have the spine see windows from more than one show when the archive has them. Variety in seeds becomes variety in clips, while F-72's rule that seed windows are text the spine actually read is kept.

**Design.**

INTEGRATION NOTE: generationFlags.ts is created by GV-15; this card adds its reader there.

researchShape.ts tapeWindowsFor (:298-384).
- Replace `windows.slice(0, RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC)` (:378) with selectWithShowQuota(windows, {max: 6, perShowMax: ceil(quota * 6)}).
  - Greedy over the score-sorted list: skip a window whose show is at perShowMax, then backfill from the skipped windows if fewer than 6 were kept.
  - It applies only when the candidates span 2 or more shows.
  - The show key is entry.show_id, carried onto a new optional ResearchTapeWindow.showId field (types/research.ts:56).
  - The tie order stays score, then episodeId.
  - usedEpisodes is updated only with kept windows, as today.
- Add an optional SubtopicCandidate.offeredShows: string[] (types/research.ts:77) for the spine workstream's soft variety line.
- ResearchShapeSchema is not .strict(): zod strips unknown keys, so the fields must be added to the schemas or a checkpoint reload drops them. Old checkpoints still parse because the fields are optional, so no CHECKPOINT_VERSION bump is needed.
- The quota is read at call time from FORAY_RESEARCH_SHOW_QUOTA through generationFlags.ts: a number in (0,1]; unset means off.

**Files edited:**

- backend/src/generation/researchShape.ts
- backend/src/types/research.ts
- backend/src/generation/generationFlags.ts
- backend/test/researchShape.test.ts
- test/suite-integrity.test.js

**New files:**

- none

**Acceptance:**

- With the flag unset, the map is byte-identical to today, and the existing researchShape and runPipelineCheckpoint tests pass.
- With quota 0.6 and two shows, no show contributes more than 4 of 6 windows when the other show has enough.
- With one show, the quota changes nothing.
- A checkpointed research shape round-trips showId and offeredShows.

**Tests.** vitest `npx vitest run test/researchShape.test.ts` with a synthetic two-show archive (inline cue provider plus FileTranscriptTextIndex over a FakeBodySource, cache:false). Also re-run test/runPipelineCheckpoint.test.ts. Raise the floor.

**Flag.** FORAY_RESEARCH_SHOW_QUOTA (unset means off).

**Live step.** With W3-15's replay on the founder PC, compare offeredShows and MQ-07 on 5 golden prompts with the quota on and off.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed. The quota can put a weaker window ahead of a stronger one. That trade is intended, and the replay measures it.

#### GV-88 · Retrieval replay harness and the hybrid go/no-go gate (MQ-09 unseeded-beat yield)

- **From:** W3-15
- **Wave:** 16 · **Size:** M · **Depends on:** GV-29, GV-83
- **Covers:** R2-04, QK-22, R1-09

**Goal.** Settle with a number whether the dense arm earns its place, and give W3-13 and W3-14 a replay to choose their defaults. tools/corpus already measured hybrid losing to keyword.

**Design.**

New backend/src/cli/replaySourcing.ts:
- Inputs:
  - a deepened-acts fixture: backend/test/fixtures/run2-deepen-2026-09-09.json, run2-attempt6-deepen-2026-09-09.json, or any checkpoint's deepen output
  - a topic
  - retrieval: local File pair, or FORAY_RETRIEVAL_URL with mode bm25|hybrid via W3-10 prepare
  - optional showShare mode
- It runs sourceBeats only, with no models.
- Per beat: tier, the deciding gate, seeded, seedWindowWon, candidates with via, and the winner.
- Summary:
  - unseededYield (MQ-09: unseeded beats that found tape / unseeded beats)
  - tapeBeats
  - showVariety (W3-12)
  - denseOnlyCandidates and denseOnlyWins
  - window-overlap refusals of dense-only candidates, which shows whether the judge rather than retrieval is the bottleneck

Pure backend/src/generation/replayCompare.ts: compareReplays(base, cand) returns a per-beat diff. 'pass' requires:
- no beat that found tape in base loses it
- unseededYield does not drop
- for the hybrid gate, unseededYield rises by at least 1 or denseOnlyWins > 0

Optional gold file tools/passage-index/eval/gold.json: [{claim_hash, show_id, guid, startSec, endSec, label: on|adjacent|off}]. It holds ids and seconds only; a claim hash, never claim or transcript text. Labels come from the tape-yield-brief method (docs/curation/tape-yield-brief-2026-09-10.md). compareReplays reports candidate recall@8 against it when it is present.

Launcher: tools/passage-index/replay.mjs (tsx).

**Files edited:**

- tools/passage-index/README.md
- test/suite-integrity.test.js

**New files:**

- backend/src/cli/replaySourcing.ts
- backend/src/generation/replayCompare.ts
- backend/test/replayCompare.test.ts
- backend/test/replaySourcing.test.ts
- tools/passage-index/replay.mjs
- tools/passage-index/eval/README.md

**Acceptance:**

- compareReplays flags any beat that lost tape and computes unseededYield exactly on synthetic replays.
- The replay CLI runs offline on a synthetic two-show corpus with the run-2 fixture's structure (claims rewritten to the synthetic vocabulary) and is deterministic.
- The gold-file schema rejects any string field over 64 characters, so no claim or transcript text can be committed.

**Tests.** vitest:
- `npx vitest run test/replayCompare.test.ts`: pass, fail-lost-tape and fail-no-gain cases
- `npx vitest run test/replaySourcing.test.ts`: smoke test of main() on the synthetic corpus
Add floors.

**Flag.** Tool only. The hybrid default stays bm25 until this gate passes on the live corpus.

**Live step.** On the founder PC corpus, run the replay for both run-2 fixtures and the germ-theory prompt's deepen output in bm25 and hybrid (the hybrid run needs W3-09 deployed). Label about 40 beats, then post the verdict on #1163. The orchestrator flips FORAY_RETRIEVAL_MODE only on 'pass'.

**Founder need.** founder-approved label (orchestrator applies); plus founder-PC corpus access (data-local) for the live replay, and about an hour of labelling or an agent on that PC.

**Risk.** Governed (backend/src/cli). The replay measures retrieval through today's lexical floors, so dense gains may show only as refused candidates until the judge workstream lands; re-run then. The fixture claims are Opus-era, so treat results as indicative.

### Wave 17

#### GV-89 · Tier runtime targets and a post-spine runtime check that re-asks only a spine that cannot fit

- **From:** W4-14
- **Wave:** 17 · **Size:** S · **Depends on:** GV-15, GV-25, GV-32
- **Covers:** R2-15, QK-28, GP-25

**Goal.** Give each tier a runtime, not only shape counts, and check it right after the spine and its post-seeding. A plan whose minimum possible runtime already overruns the tier by more than 15% is re-asked once, with the overrun named.

**Design.**

INTEGRATION NOTE: buildRuntimeFixInstruction sits in prompts/spine.ts next to buildSpineFixInstruction (GV-32); both the Anthropic and the Chat spine builders select it for revision.kind 'runtime'.

1. types/spine.ts, next to DURATION_SHAPE_BUDGETS (:28):
   - DURATION_RUNTIME_TARGET_SEC = {short: 900, medium: 3600, long: 10800}, from generation-architecture.md's duration table (:315-317, ~15/~60/up to ~180 min).
   - TIER_RUNTIME_TOLERANCE = SHAPE_TOLERANCE (0.15, :39).
   - tierRuntimeBand(tier): [min, max]. The upper bound is hard. The lower bound is reported only, because thin topics may undershoot (§9.3).
2. New module backend/src/generation/tierRuntime.ts.
   - spineRuntimeLowerBoundSec(spine) sums:
     - each distinct seed window once, at max(TAPE_WINDOW_MIN_SEC (transcriptArchiveLookup.ts:647), endSec - startSec);
     - each unseeded beat at the Patch floor, MODE_CHAR_BANDS.Patch[0] / NARRATION_CHARS_PER_SEC (types/narration.ts);
     - the overview and any folded introduction and exit characters / NARRATION_CHARS_PER_SEC.
   - spineRuntimeEstimateSec(spine): seeded beats at max(window, 124 s pool median), unseeded at mid-band. Reported, never gated.
   - narrationEstimateSec(acts) is used by W4-15.
3. The check runs where seeds are final: inside the runPipeline spine stage, after postSeedWithFloor (runPipeline.ts:1225). Seeds added by post-seeding count toward the bound.
   - A new exported helper in buildSpine.ts, reaskForRuntime(spine, intent, researchShape, duration, builder, ctx), sends one re-ask with revision.kind 'runtime'. SpineRevisionRequest.kind (SpineBuilder.ts:70) gains 'runtime', and buildRuntimeFixInstruction sits next to buildSpineFixInstruction: drop or merge beats so the plan fits, and keep the seeds you keep.
   - The reply must pass the structural gate. postSeedSpine then runs on it deterministically, with no further floor re-ask. If it still overruns, the run continues and W4-15's sourcing ceiling enforces the limit.
   - The AnthropicSpineBuilder and ChatSpineBuilder (decision 9: no LocalSpineBuilder) revision branches select the instruction. The re-ask is recorded in spineReasks with a 'runtime' tag.
4. runPipeline logs one line, `spine runtime: lower bound Xs, estimate Ys, tier band [a,b]`. The outcome carries spineRuntime {lowerBoundSec, estimateSec}, and generateForays writes it to report.json.

**Files edited:**

- backend/src/types/spine.ts
- backend/src/generation/buildSpine.ts
- backend/src/generation/SpineBuilder.ts
- backend/src/generation/AnthropicSpineBuilder.ts
- backend/src/generation/runPipeline.ts
- backend/src/cli/generateForays.ts
- backend/test/buildSpine.test.ts
- test/suite-integrity.test.js
- backend/src/generation/prompts/spine.ts
- backend/src/generation/chat/ChatSpineBuilder.ts
- backend/test/spineReask.test.ts

**New files:**

- backend/src/generation/tierRuntime.ts
- backend/test/tierRuntime.test.ts

**Acceptance:**

- A synthetic short spine whose 10 seeded beats use distinct 120 s windows has a lower bound of at least 1,200 s, above 1,035 s. With the cap on, exactly one 'runtime' re-ask is made and recorded in spineReasks.
- A short spine whose lower bound fits makes no extra call (the recording spine builder shows one call).
- Seeds added by post-seeding count toward the bound (fixture where post-seeding pushes it over).
- A resumed spine reports no re-asks, consistent with F-86.
- The report carries spineRuntime for every outcome that reached the spine.

**Tests.** vitest tierRuntime.test.ts (bounds on synthetic spines) plus buildSpine.test.ts and spineReask.test.ts additions with stub builders.

**Flag.** The runtime re-ask applies when FORAY_TIER_RUNTIME_CAP is on (fast-path umbrella). The estimate and log line are always computed (report-only).

**Live step.** Golden set: compare the spineRuntime estimate with the finished runtime_sec, to calibrate the estimate and the 124 s median.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** TIER TARGET CONFLICT. The committed spec says short is ~15 min ±15%; plan.md's R2-15 row expects 8-12 min. The orchestrator default, recorded rather than asked, is the committed spec values in one constant table, so moving short to 10 min is a one-line change if the golden-set listen prefers it. A post-spine check can only bound runtime, because clip lengths are decided at sourcing; hard enforcement is W4-15. GV-100's ChatSpineBuilder changes must keep the kind 'runtime' branch this card adds.

### Wave 18

#### GV-90 · Unit caps per Foray: Spark seconds, second-box seconds, Jev calls (R1-19), with unit spend and Jev dollars in the report

- **From:** W1-08
- **Wave:** 18 · **Size:** M · **Depends on:** GV-14, GV-20, GV-26
- **Covers:** R1-19, MT-10

**Goal.** Give the local pipeline a ceiling the dollar guard cannot provide at $0 local rates, so a runaway rewrite loop stops with a stage-named error instead of taking the next listener's Spark slot.

**Design.**

INTEGRATION NOTE: this card also makes meteredJevClient (GV-20) reserve one jevCalls unit per ask, and the lane scheduler (GV-93) wraps Spark and second-box calls in metered(); so the caps are live as soon as those land.

New module backend/src/cost/unitBudget.ts.
- Types: `MeterUnit = 'sparkSeconds'|'secondBoxSeconds'|'jevCalls'`; `UnitBudgetExceededError {sessionId, unit, spent, attempted, cap}`; `UnitBudgetStopError {stage, unit, spent, cap, resumeHint}`.
- `class UnitBudgetGuard`:
  - `DEFAULT_UNIT_CAPS` by tier: short {120, 180, 250}, medium {600, 900, 1000}, long {1500, 2400, 2500}. These are initial guesses.
  - Env overrides FORAY_SPARK_SECONDS_PER_FORAY, FORAY_SECOND_BOX_SECONDS_PER_FORAY and FORAY_JEV_CALLS_PER_FORAY go through env.ts's bounded-number schema (readBoundedNumber, env.ts:170, private, so the new vars are read inside env.ts and exposed on `env`). A set override replaces the cap for every tier.
  - `reserve({sessionId, tier, unit, amount})` is serialised through a promise lock like BudgetGuard.checkAndRecord (budgetGuard.ts:165-178).
  - `reconcile(reservation, actual)`, `spent(sessionId)`.
  - `metered({sessionId, tier, unit, estimate}, fn)` reserves, runs, then reconciles with measured seconds: the provider's server-side decode time when given, else wall ms/1000. A throw is charged its elapsed time.
  - Each step appends a MeterEvent through currentRunLog().
  - `findUnitBudgetError(err)` walks `cause` like findBudgetError (budgetGuard.ts:107).
  - `defaultUnitBudgetGuard`.
- The dollar BudgetGuard stays, and keeps metering Jev at $0.042/M input tokens (provider 'jev').

runPipeline.ts timed() (:937): a found UnitBudgetExceededError is rethrown as UnitBudgetStopError naming the stage.

generateForays.ts:
- classifyFailure (:256) maps UnitBudgetStopError to 'budget-stop' (not resumable).
- The entry gains `unitSpend {sparkSeconds, secondBoxSeconds, jevCalls, caps}`.
- `usage {costUsd}` comes from defaultBudgetGuard's sink.all() filtered by sessionId and provider 'jev'. This fills the bench's existing cost_usd column (run.mjs costUsdFor :441) without price arithmetic.

**Files edited:**

- backend/src/config/env.ts
- backend/src/generation/runPipeline.ts
- backend/src/cli/generateForays.ts
- backend/test/runPipeline.test.ts
- backend/test/generateForaysHandsFree.test.ts
- test/suite-integrity.test.js
- backend/src/generation/jevClient.ts

**New files:**

- backend/src/cost/unitBudget.ts
- backend/test/unitBudget.test.ts

**Acceptance:**

- Concurrent reserve calls under one sessionId never overshoot the cap by more than one reservation.
- Reserving beyond the cap throws UnitBudgetExceededError with the unit and figures.
- Sessions are isolated, and reconcile frees surplus.
- A malformed FORAY_SPARK_SECONDS_PER_FORAY fails startup.
- In runPipeline.test.ts, a test-local deepen builder whose metered() call exceeds the cap ends the run with UnitBudgetStopError naming stage 'deepen'.
- generateForays records outcome aborted, abort.reason 'budget-stop', and unitSpend.
- With no caller of metered(), every existing suite is unchanged.

**Tests.** backend vitest: unitBudget.test.ts (fake clock, lock, caps, env); runPipeline.test.ts (stage-named stop); generateForaysHandsFree.test.ts (classification, unitSpend, usage.costUsd)

**Flag.** Inert until the provider layer and the Jev client call metered(). The Anthropic/relay path never meters seconds. Caps are env-tunable.

**Live step.** Retune DEFAULT_UNIT_CAPS after the first golden-set run on the Spark (W1-04 spark_s per tier).

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Wall seconds include queue wait under contention (HW-08), so a busy Spark can trip a cap. Charge from the provider's ttft/decode split when available, and keep queueMs on the CallRecord so a cap stop can be told apart from contention. The depends_on is merge order: env.ts is shared with W1-07, and the ReportEntry build and timed() are shared with W1-09 and W1-02.

### Wave 19

#### GV-91 · Constrained best-of-2 spine wrapper with a deadline and a pluggable judge (fake judge in this card)

- **From:** W7-07, W4-16
- **Wave:** 19 · **Size:** M · **Depends on:** GV-03, GV-04, GV-37, GV-67
- **Covers:** R2-17, R2-07

**Goal.** Implement the orchestrator's call on the reviewers' split (plan.md 'Where the reviewers differ'). A second spine sample runs on the second box in parallel; only samples that pass the code gates compete; a judge picks one; a deadline bounds the added critical-path time. This card ships the wrapper, the SpineJudge interface and the recording. The real Jev and Qwen judges come in W7-11.

**Design.**

INTEGRATION NOTE: 'spine-alt' is already a stage id in the routing table (GV-03). This card is the only best-of-2 implementation: W4-16's wrapper behaviour (secondary timeout, structural gate per sample, primary fallback) is folded here and its Jev Choice judge into GV-97.

New backend/src/generation/bestOfSpine.ts:
- BestOfTwoSpineBuilder implements SpineBuilder (SpineBuilder.ts:17), with providerName 'best-of-2'.
- Constructor: {primary, secondary, judge: SpineJudge, graceMs, now?, sleep?}.
- buildSpine(intent, research, duration, ctx):
  (1) ctx.revision set (structural re-ask, buildSpine.ts:119; seed-floor re-ask, postSeedSpine.ts:372): call the builder whose sample won the last first call on THIS instance (runPipeline builds one per run, :994), else primary.
  (2) Otherwise start both; attach a catch to the secondary at once.
  (3) Await primary.
  (4) If primary threw or failed validation, wait for the secondary with no grace limit; there is nothing else.
  (5) Otherwise race the secondary against graceMs (default 3000).
  (6) A sample counts as valid when SpineSchema.parse and validateSpine (types/spine.ts:762) pass, and checkSpineStructure (spineStructure.ts:181) returns no issues under the SAME options buildSpineWithReasks uses (seedableEpisodeIds from researchShape).
  (7) 0 valid: return or rethrow primary's own result, so buildSpineWithReasks's re-ask and throw paths are unchanged. 1 valid: return it. 2 valid: judge.choose.
  (8) Judge input:
  - renderSpineForJudge(spine): act titles, slots, beat claims, overview, voice, and the R2-07 'disappointment' answer once that field exists. No ids.
  - spineJudgeQuestion(intent, ctx): the judge runs before any spine exists, so when ctx.listenerPrompt is set (GV-67 adds it to SpineBuildContext; it lives on the call stack only and is never banked or recorded) the question is built from the listener's own prompt. Only when it is absent (fold off) does it use intent.subject, intent.angle and intent.disappointment. On the fast path the intent is a keyword list with 'not yet known' sentinels (GV-67), which must never reach the judge.
  - The A/B order comes from a stable hash of ctx.sessionId.
  (9) A judge that times out or throws falls back to primary.
SpineJudge = {kind, choose(input): Promise<{index: 0|1, probabilities?, confidence?, requestId?, ms}>}. This card ships only a scripted FakeSpineJudge in backend/test/helpers.
Recording:
- SpineBuildContext (SpineBuilder.ts:38) gains observe?: (r: SpineSelectionRecord) => void, with SpineSelectionRecord = {samples: [{impl, valid, issues, ms, late}], judge, chosen, reason: 'judged'|'only-valid'|'secondary-late'|'judge-failed'|'none-valid', addedMs}.
- runPipeline's spine stage (:1208-1238) passes {...ctx, observe} and returns spineSelection on the generated outcome.
- ReportEntry.levers.spineBestOf carries the record; run.mjs gets a 'bo2' column (chosen/reason/addedMs).
Factory:
- 'spine-alt' is appended to W7-02's GENERATION_STAGES with no default.
- When FORAY_SPINE_BEST_OF=2, createSpineBuilder wraps instantiateStage('spine') and instantiateStage('spine-alt') with the judge named by FORAY_SPINE_JUDGE, resolved from a judge registry that W7-11 fills.
- It refuses when spine-alt is unset or 'anthropic', or when no judge is registered under that name.
- FORAY_SPINE_BEST_OF_GRACE_MS is a bounded integer.
The card also commits the E4-spine-best-of-2.json spec (rerunFrom 'spine', expect.levers.spineBestOf).

**Files edited:**

- backend/src/generation/SpineBuilder.ts
- backend/src/generation/createSpineBuilder.ts
- backend/src/generation/runPipeline.ts
- backend/src/cli/generateForays.ts
- tools/generation-bench/run.mjs
- tools/generation-bench/run.test.mjs
- test/suite-integrity.test.js
- backend/test/runPipeline.test.ts

**New files:**

- backend/src/generation/bestOfSpine.ts
- backend/test/bestOfSpine.test.ts
- backend/test/helpers/fakeSpineJudge.ts
- tools/generation-bench/swaps/experiments/E4-spine-best-of-2.json

**Acceptance:**

- Both samples valid: the judge is called once and its choice is returned; reason 'judged'
- Secondary slower than primary + graceMs: primary returned without waiting, reason 'secondary-late', addedMs <= graceMs (fake clock)
- Primary throws or fails validation: the secondary is awaited and returned if valid; both invalid: primary's error or spine is passed through unchanged
- A secondary failing checkSpineStructure is never shown to the judge
- A judge that throws or times out returns primary, reason 'judge-failed'
- Revision calls go to the last winner; the loser is not called again
- FORAY_SPINE_BEST_OF unset: createSpineBuilder returns exactly W7-02's builder
- No unhandled rejection from a late secondary
- With two stub builders and the Jev fake choosing 1, the second spine is returned and spineChoice is recorded.
- If one candidate fails the structural gate, the other is used with decidedBy 'only-one-passed' and no judge call.
- Fold-on case: with FORAY_SPINE_FOLD_COPY=1 and ctx.listenerPrompt set, the question FakeSpineJudge receives is built from the listener prompt and contains neither the keyword-list intent nor the 'not yet known' sentinel; the SpineSelectionRecord and report carry no prompt text.

**Tests.** backend: npx vitest run test/bestOfSpine.test.ts. Uses two StubSpineBuilder subclasses with scripted delays and outputs (one carrying a two-sentence claim that fails checkSpineStructure), an injected now/sleep, and FakeSpineJudge (choose, throw, hang). A runPipeline.test.ts case asserts spineSelection reaches the outcome and the report. Add a BACKEND_FLOORS entry and raise the run.test.mjs floor.

**Flag.** FORAY_SPINE_BEST_OF=1|2 (default 1), FORAY_STAGE_SPINE_ALT, FORAY_SPINE_JUDGE, FORAY_SPINE_BEST_OF_GRACE_MS (default 3000)

**Live step.** E4 (W7-04): arm B is best-of-2 with spine-alt on the P40 lane (local-worker), rerun from 'spine'. Read p50 addedMs and how often the secondary wins. Keep the lever only if the pairwise listen is even or better and p50 addedMs <= 3000.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** The P40 reads a ~5.6k prompt at 895 tok/s and writes at 51 tok/s (HW-06), so the secondary will often be late; that is the deadline working, and E4 measures it. 'Constrained' assumes both inner builders use json_schema decoding (R1-18, provider workstream). This card and other workstreams (R1-04, R1-14) edit runPipeline.ts and generateForays.ts, so expect rebases. Governed path.

#### GV-92 · Offline judged-metrics pass: MQ-10 prompt fit and MQ-12 seam coherence (plus MQ-02/03/05 re-score) behind an injected JevClient

- **From:** W1-18
- **Wave:** 19 · **Size:** M · **Depends on:** GV-07, GV-20, GV-24, GV-27, GV-79, GV-90
- **Covers:** MQ-10, MQ-12, MQ-02, MQ-03, MQ-05

**Goal.** Produce the judged scorecard fields after the run, off the timed path, for the metrics no in-pipeline judge produces (MQ-10, MQ-12), and re-score MQ-02/03/05 on old candidates.

**Design.**

INTEGRATION NOTE: no separate JudgeClient interface: the CLI takes a JevClient (GV-20, with the fallback of GV-47) and reuses ClipJudge (GV-79) for MQ-05 and SentenceSupportJudge (GV-27) for MQ-02; it adds only the MQ-10 and MQ-12 questions and the MQ-03 speaker question.

backend/src/cli/judgeCandidate.ts, launched without npm by tools/generation-bench/judge.mjs through tsx (the pattern of tools/generation/warm-transcript-index.mjs).
- Inputs: --candidate, --report (entry prompt and promptId), --golden (prompt by promptId), --out.
- SUPERSEDED: no own JudgeClient interface. It takes an injected JevClient (GV-20's interface; in production createJevClient with GV-47's fallback when routed). Tests use backend/test/helpers/fakeJevClient.ts (GV-20) replaying the recorded fixture, so this card merges offline.

Questions (JUDGE_QUESTIONS_V1):
- MQ-10: Score 1-5. Does the prelude overview plus the act titles answer the subject and angle, and avoid the disappointment? The prompt text comes from the report entry or golden manifest; the pipeline itself never writes it (§9.4).
- MQ-12: Score 1-5 per seam. Does this hand-off follow from the clip just heard? Context is the last ~150 words of the clip window (FileTranscriptCueProvider) plus the seam script, at most 2k tokens.
- MQ-05: Score per clip window against the subject sentence.
- MQ-02: yes/no per sentence against its cited sources.
- MQ-03: does the named speaker match the window's diarised speakers?

Output: `<candidate>.judged.json` {questionsVersion, provider, model, perItem[], MQ-02, MQ-03, MQ-05, MQ-10, MQ-12}, with no prompt or transcript text. It is written from cli/, and score.mjs (W1-11) reads it.

The CLI runs inside runWithRunLog. Each judge call is recorded by the client stack itself (jevClient.ts for Jev, and the chat provider under qwenJudgeClient.ts for the fallback; both are PROVIDER_CALL_SITES; provider 'jev' or 'qwen-judge', role 'judge'), and metered through UnitBudgetGuard.metered with unit jevCalls (GV-90).

**Files edited:**

- test/suite-integrity.test.js

**New files:**

- backend/src/cli/judgeCandidate.ts
- backend/test/judgeCandidate.test.ts
- backend/test/fixtures/jev-recorded-judge-v1.json
- tools/generation-bench/judge.mjs

**Acceptance:**

- With the fake JevClient (GV-20) replaying recorded noul and score bodies (shape from hermes-operating-system ops/jev/tests/_fixtures.py:33-64), judgeCandidate on a synthetic candidate and inline cue provider writes a judged.json with the expected values.
- When the primary client throws an unavailable error, the injected fallback is used and recorded as provider 'qwen-judge'.
- judged.json contains no prompt text and no transcript text.
- Calls appear in the run log with role 'judge', and a jevCalls cap stop ends the pass with a named error.
- BACKEND_FLOORS gains judgeCandidate.test.ts.

**Tests.** backend vitest: test/judgeCandidate.test.ts with recorded judge fixtures and an inline cue provider

**Flag.** none; an offline CLI that never runs on the timed path

**Live step.** Run it on the founder PC, which needs data-local transcripts plus the Jev key and adapter, over the 14 Sep candidate and later the golden-set candidates. Calibrate thresholds against the founder's listening cards (LM-24) before any gate uses them.

**Founder need.** founder-approved label (orchestrator applies); plus the Jev key on the machine that runs it (queued on #1163)

**Risk.** Untuned Jev thresholds are unreliable (LM-24), and Jev is weak on long irrelevant context (LM-23), so each question's context stays at 2k tokens or less. The subject and transcript excerpts leave the network (LM-25), which adopted OQ-05 allows. Results are reported as uncalibrated until cards exist.

#### GV-93 · Lane scheduler: per-machine concurrency, critical-path priority, queueMs, Foray request tagging and server priority

- **From:** W2-09
- **Wave:** 19 · **Size:** M · **Depends on:** GV-03, GV-13, GV-37, GV-90
- **Covers:** R1-08, R1-12, GP-10

**Goal.** Treat the Spark as one critical stream plus limited background work, and send parallel short jobs to the second box (R1-08). Keep a Foray's critical-path calls first in line and make contention visible as queueMs (R1-12, GP-10). Today's per-stage gates would oversubscribe a shared box: narration runs 4 acts (writeNarration.ts:261), deepen runs all acts (deepenActs.ts:349-364), evidence runs 6 x 2 raced queries, and research runs up to 8 calls.

**Design.**

INTEGRATION NOTE: runPipeline's timed() and deepenActs already set {stage, act} through runLog's withCallContext (GV-01, GV-07), so this card does not edit them: the scheduler derives priority itself with criticalFor(stage, act) (critical for understand, topic, research-shape, spine, source, narrate:0, stitch:0 and act 0 of deepen). It also wraps every lane call in UnitBudgetGuard.metered (GV-90) with unit sparkSeconds or secondBoxSeconds by lane, charging decode time when the provider reports it.

New module backend/src/generation/chat/laneScheduler.ts: LaneScheduledProvider implements ChatProvider by wrapping an inner provider.
- Each lane gets one semaphore sized by LaneProfile.maxConcurrent, with reservedCritical slots that background calls cannot take.
- A priority queue serves critical before background, FIFO within each class.
- It is AbortSignal-aware: an aborted queued call rejects with kind 'aborted'.
- queueMs (the wait in acquire) goes into the observation.

Priority comes from currentCallContext() (superseded W2-09 text removed: this card does NOT edit runPipeline.ts timed() or deepenActs.ts). The {stage, act} that GV-01/GV-07 already put on the context is mapped by the exported pure function criticalFor(stage, act) in laneScheduler.ts: critical for understand, topic, research-shape, spine, source, narrate with act 0, stitch with act 0 and deepen with act 0; background otherwise.

On the wire, when profile.serverPriority.enabled, the body carries `priority` with the profile's values; SGLang's sign convention is unverified. The model alias comes from the profile, so a Foray-only deployment is a config switch. Every request also sends `user: 'foray-generation'`.

providerRegistry (W2-08) wraps the provider with the scheduler.

**Files edited:**

- backend/src/generation/chat/providerRegistry.ts
- backend/src/generation/chat/openAICompatProvider.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/chat/laneScheduler.ts
- backend/test/laneScheduler.test.ts

**Acceptance:**

- Under fake timers, with spark at 2 slots and 1 reserved, five background calls never exceed one in flight and a critical call starts at once.
- A queued critical call is served before earlier background calls, and queueMs equals the simulated wait.
- With serverPriority disabled, no `priority` key is sent; when it is enabled, the profile's values are sent.
- In laneScheduler.test.ts (runPipeline.test.ts is not edited; GV-91 edits it in the same wave): criticalFor(stage, act) is table-tested for every stage, and a case imports runForayPipeline with stub deps whose spy writer and spy deepen builder record currentCallContext() at call time; mapping each recorded context through criticalFor gives narrate act 0 critical, narrate acts 1..3 background, and deepen act 0 critical with acts 1+ background.
- An aborted queued call rejects with kind 'aborted' and leaks no slot.

**Tests.** Run `npx vitest run test/laneScheduler.test.ts` (scheduler, criticalFor table and the stub-pipeline priority case). runPipeline.test.ts runs unchanged.

**Flag.** The scheduler is active only on local routes. serverPriority is off in the default profiles.

**Live step.** In the Hermes repo, through an agent PR plus a founder or Joey deploy:
(a) add --enable-priority-scheduling and --enable-cache-report to the lane A2 serve script, after confirming both exist in SGLang v0.5.19;
(b) add a Foray-only LiteLLM deployment capped at 2, plus a Foray virtual key;
(c) move the 60 s health probe off the 27B.
Then enable serverPriority and the alias through FORAY_MACHINE_PROFILES_FILE, and measure queueMs during a busy terminal session.

**Founder need.** founder-approved label (orchestrator applies); plus approval to change the shared Spark's serving config and LiteLLM deployments, which affects the owners' terminals (OQ-07), plus the Foray virtual key.

**Risk.** Local semaphores govern only this process, so other Spark users still contend; that is why the server-side live step matters. A wrong priority sign would put Foray last, so verify it before enabling. runPipeline.ts is shared with W2-10, W2-18 and other workstreams. Governed path.

### Wave 20

#### GV-94 · Typed self-critique decorator: per-sentence check on the first draft, one edit for flagged seams only (fake critic in this card)

- **From:** W7-08
- **Wave:** 20 · **Size:** M · **Depends on:** GV-10, GV-37
- **Covers:** R2-17

**Goal.** R2-17 step 3. Before the real verifier runs, a typed pass asks whether each draft sentence is backed by its seam's own sources, and runs the code structure and banned-copy checks. Only seams with a flagged sentence go back once, with those sentences quoted and every other seam frozen. Off by default; it can be limited to acts behind the playhead. The real Jev and Qwen critics come in W7-11.

**Design.**

INTEGRATION NOTE: FORAY_WRITER_CRITIC names a critic registered by GV-97.

New backend/src/generation/selfCritique.ts:
- SelfCritiquingNarrationWriter implements NarrationWriterBuilder, a decorator over an inner writer and a DraftCritic.
- writeAct(request, ctx):
  (1) draft = await inner.writeAct(request, ctx).
  (2) Return draft unchanged when the mode is off, when request.retryNote is set (writeAct rounds 2-3 already carry verifier notes), or when the mode is 'behind-playhead' and ctx.actIndex === 0.
  (3) Split each non-empty seam script into sentences with spokenLine.splitSpokenSentences (backend/src/copy/spokenLine.js, GV-10; decision 16). No local splitter is added; hasDeclarativeSentence (types/narration.ts:656) is left as it is.
  (4) Flag a sentence when narratorStructureLeaks or the banned-copy rule (types/narration.ts:828) hits, or when critic.supported({sentence, sources}).p < CRITIQUE_FLAG_P (0.3).
  (5) The sources are ONLY the seam's own selected claim quotes plus the window documents of the clips named in its follows/introduces (request.clips[].docId resolved to request.documents), trimmed to about 2k tokens at chars/4 (LM-23).
  (6) Any seam flagged: make ONE inner.writeAct call. Flagged seams carry previousScript = the draft and notes = 'Not backed by the act's sources: «sentence» - drop or re-source it; keep every other sentence.' Every other seam is {frozen: true, previousScript: draft} (SeamBrief, NarrationWriterBuilder.ts:162-189).
  (7) Merge: frozen seams keep the draft's script and claims whatever comes back.
  (8) An edit call that throws returns the draft.
- DraftCritic = {kind, supported(q): Promise<{p, requestId?, ms}>}. This card ships only a scripted FakeDraftCritic in test helpers, plus a critic registry that W7-11 fills.
Context and recording:
- NarrationBuildContext (NarrationWriterBuilder.ts:272) gains actIndex? and observe?: (e: WriterObservation) => void.
- runPipeline sets both at the narrate:i stage (runPipeline.ts:1610) as {...ctx, actIndex: i, observe}. writeNarration is called with ONE act per stage (:1613), so its own index is always 0 and cannot be used.
- The decorator reports {acts, sentences, flagged, editedSeams, editCalls, critiqueCalls, ms, pValues} through observe. runPipeline aggregates the totals onto the generated outcome, adds editCalls to its narrationWriterCalls count (the counting proxy at :1022 sees one call per writeAct), and generateForays writes ReportEntry.levers.selfCritique.
Factory: createNarrationWriterBuilder wraps the writer when FORAY_WRITER_SELF_CRITIQUE=behind-playhead|all. It refuses when FORAY_WRITER_CRITIC names no registered critic. The 'cut' mode is reserved and refused until the narration workstream's cut function exists.
The card also commits the E5-self-critique.json spec (rerunFrom 'narrate').

**Files edited:**

- backend/src/generation/NarrationWriterBuilder.ts
- backend/src/generation/createNarrationWriterBuilder.ts
- backend/src/generation/runPipeline.ts
- backend/src/cli/generateForays.ts
- backend/src/types/narration.ts
- test/suite-integrity.test.js
- backend/test/runPipeline.test.ts

**New files:**

- backend/src/generation/selfCritique.ts
- backend/test/selfCritique.test.ts
- backend/test/helpers/fakeDraftCritic.ts
- tools/generation-bench/swaps/experiments/E5-self-critique.json

**Acceptance:**

- Mode off: the writer is not wrapped and act output is byte-identical
- behind-playhead: act 0 (ctx.actIndex 0 set by runPipeline) is never critiqued; acts 1+ are
- No flagged sentence: no edit call
- One flagged sentence: exactly one edit call with every other seam frozen, and frozen seams keep their draft script and claims
- An edit call that throws returns the draft and the act continues
- Each critic question carries only that seam's sources, within the ~2k-token budget
- levers.selfCritique reaches report.json, and narrationWriterCalls includes the edit calls
- The real verifier still runs after the critique (writeActNarration with wrapped stubs)
- BACKEND_FLOORS in test/suite-integrity.test.js has an entry for selfCritique.test.ts (added in this PR, so 'every backend suite on disk is covered by a floor' stays green).

**Tests.** backend: npx vitest run test/selfCritique.test.ts. Wraps StubNarrationWriterBuilder with a scripted second reply, uses FakeDraftCritic keyed by sentence, adds, inside selfCritique.test.ts, a run through writeActNarration in the wrapped-builder style of actNarration.test.ts (actNarration.test.ts itself is not edited), and a runPipeline.test.ts case for actIndex and observe aggregation. Add a BACKEND_FLOORS entry.

**Flag.** FORAY_WRITER_SELF_CRITIQUE=off|behind-playhead|all (default off; 'cut' reserved), FORAY_WRITER_CRITIC

**Live step.** E5 (W7-04): rerun from 'narrate' with behind-playhead. Compare first-attempt pass rate, retry rounds, MQ-02 and the pairwise listen. Calibrate CRITIQUE_FLAG_P against the R2-19 review verdicts (data-local/review/verdicts.jsonl, GV-41) and the run-9 labelled pages (founder PC data-local).

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** On act 0 the edit call is a second whole-act writer call on the critical path, so 'all' must never be the timed-path default. Jev is weak on numbers and dates (LM-23), so this complements R2-09's code checks rather than replacing them. LM-24 (10 of 13 retried, 1 improved) says the lever may add calls with no gain, which is what E5 decides. R1-04 (per-act chain) and R1-06 (streamed writer) restructure runPipeline's narrate fan-out, so the actIndex/observe wiring must move with them. Governed path.

#### GV-124 · Generation follow-ups from #1413: unit caps per Foray across resumes, the jevCalls cap stops the run, FORAY_SPINE_BEST_OF in the checkpoint variant and LEVER_ENV, self-critique keeps streaming and joins the fork stamp, self-backed quotes dropped, editSeams forwarded

- **From:** #1413 (governed reviews of GV-90, GV-91, GV-93, GV-94)
- **Wave:** 20 · **Size:** S · **Depends on:** none
- **Covers:** none (review follow-ups)

**Goal.** Land #1413's code items before batch local runs (Decision 31) and before self-critique or writer streaming is switched on.

**Design.**

1. Unit caps bind per Foray, not per attempt: `CallContext.sessionId` (runLog.ts); the driver runs each attempt under `withCallContext({ resumeAttempt, sessionId: checkpointKey })`, so the lane scheduler meters every resume against one session and the row's `unitSpend` reads it.
3. `JevPromptUnderstander` and `JevClipJudge.score` re-throw `findUnitBudgetError` as well as `findBudgetError`.
4. `checkpointRunVariant` carries `spine=best-of-2` when FORAY_SPINE_BEST_OF=2 (absent at 1, so classic fingerprints do not move).
5. swap-experiment's `LEVER_ENV` maps `spineBestOf` to FORAY_SPINE_BEST_OF (1|2); an adopted record sets FORAY_SPINE_JUDGE and FORAY_SPINE_BEST_OF_GRACE_MS too.
7. `SelfCritiquingNarrationWriter.writeActStream` (when the inner writer streams): an act it does not critique is the inner stream; a critiqued act is written, critiqued and handed on whole.
8. The fork stamp carries `selfCritique` and `spineBestOf` beside the flags; `forkSeedRefusal` treats a self-critique difference like a changed writer route (rerun from narrate or earlier) and a best-of difference like a changed spine route.
9. `seamCritiqueSources` keeps a claim quote only when it is an exact substring of the document it names in `request.documents`.
10. runPipeline's counting writer (`countingNarrationWriterOf`) forwards `editSeams`.

Not in this card: item 2 (retune `sparkSeconds` from a measured run), item 6 (confirm the `user` tag on a live LiteLLM) and item 11 (GV-97's critic metering).

**Files edited:**

- backend/src/generation/runLog.ts
- backend/src/generation/chat/laneScheduler.ts
- backend/src/cli/generateForays.ts
- backend/src/generation/JevPromptUnderstander.ts
- backend/src/generation/clipJudge.ts
- backend/src/generation/checkpoint.ts
- backend/src/generation/selfCritique.ts
- backend/src/generation/runPipeline.ts
- tools/generation-bench/swap-experiment.mjs
- test/suite-integrity.test.js

**Acceptance:**

- A resumed Foray hits its Spark-seconds cap cumulatively, and the row's unitSpend reads the spend.
- A jevCalls UnitBudgetExceededError stops the run (understand stage) instead of degrading the clarity check or the clip scores.
- Flipping FORAY_SPINE_BEST_OF changes the variant; a run killed after its spine is not resumed across the flip.
- An adopted stack can turn spineBestOf on with its judge.
- Under behind-playhead, act 0 keeps GV-73 streaming through the decorator.
- A seed built under another self-critique is refused from stitch and accepted from narrate.
- An invented quote never reaches the critic as a source.
- The counting writer offers and counts editSeams.

**Tests.** backend: generateForays, JevPromptUnderstander, clipJudge, checkpointFork, selfCritique and runPipeline suites; tools: swap-experiment.test.mjs. One named mutation per test.

**Flag.** None new; every change is inert while self-critique, best-of-2 and the unit caps' callers are off.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

### Wave 21

#### GV-95 · Pipeline wiring: prepare every search and hydrate every body before research-shape, sourcing and evidence, behind FORAY_RETRIEVAL_URL

- **From:** W3-11
- **Wave:** 21 · **Size:** M · **Depends on:** GV-15, GV-18, GV-29
- **Covers:** R1-09, GP-09

**Goal.** Run generation against the remote index and corpus. Leave behaviour byte-identical when the flag is unset.

**Design.**

INTEGRATION NOTE: generationFlags.ts is created by GV-15; this card adds its reader there.

There are four index call sites in the snapshot, and all four must be prepared or they silently miss:
- researchShape.ts:314, per subtopic: queryText = [seed.label, ...seed.terms].join(' '), limit RESEARCH_TAPE_EPISODE_CANDIDATES (12), lineage scope.
- researchShape.ts:498, probeSubjectTape: `${prompt ?? ''} ${intent.subject} ${intent.angle}`, limit 50, 'all' scope.
- sourceBeats.ts:1209, thesisIdfFor: act thesis, limit 1, lineage scope.
- sourceBeats.ts:2199, tier2Candidates: beat claim, limit TRANSCRIPT_TEXT_CANDIDATES (8), lineage scope.

Changes:
1. generationFlags.ts (from W3-16) gains call-time readers for FORAY_RETRIEVAL_URL, FORAY_RETRIEVAL_TOKEN and FORAY_RETRIEVAL_MODE (bm25|hybrid, default bm25).
2. generateForays.ts (:876-898): when the URL is set, build RemoteRetrieval plus HydratingCueProvider plus PrecomputedTextIndex instead of the File pair, and await loadManifest().
   - corpusCoverage takes hasBody from the provider. Its shows-on-disk count comes from the manifest, because scanNormalizedCorpus of a local dir would read 0.
   - Warn if the local corpus-digest generated_at differs from /healthz archiveGeneratedAt (pull-archive not run).
3. RunPipelineDeps (runPipeline.ts:115) gains an optional retrieval: RetrievalPreparer.
4. In runPipeline, after the topic decision, await retrieval.prepareScope(topic).
5. buildResearchShape gets an optional prepareQueries callback. Before the subtopic loop (researchShape.ts:674-677) and before probeSubjectTape (:628), it computes every query string with exported helpers subtopicQueryText(seed) and subjectProbeQuery(prompt, intent). tapeWindowsFor and probeSubjectTape are changed to call these same helpers, so the strings cannot drift. Then it awaits prepare and hydrates the candidates' episodes.
6. In the 'source' stage (runPipeline.ts:1334), before sourceBeats:
   - prepare the act thesis and beat claim strings with exported helpers from sourceBeats.ts (thesisQueryFor, claimQueryFor), used at both call sites
   - then hydrate the union of: text candidates; title-path matches (findTranscriptArchiveMatch over the claim, which is local); seed episodes (entryMatchesSeed); and lineage-admitted pool segments' digest entries (segmentPoolLookup window text)
7. Before the evidence stage (:1398), hydrate every sourced clip's episode and its adjacent clips' episodes, so a resumed run that skipped sourcing also works.

prepare and hydrate are timed as stages 'retrieval:research', 'retrieval:source' and 'retrieval:evidence' through the existing timed() seam, and are not checkpointed. retrieval.stats() goes into veracity.retrieval (runPipeline.ts:1733) beside evidence.metrics().

**Files edited:**

- backend/src/cli/generateForays.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/researchShape.ts
- backend/src/generation/sourceBeats.ts
- backend/src/generation/generationFlags.ts
- backend/test/runPipeline.test.ts
- backend/test/researchShape.test.ts
- test/suite-integrity.test.js

**New files:**

- backend/test/runPipelineRemoteRetrieval.test.ts

**Acceptance:**

- With the flag unset, runPipeline.test.ts, researchShape.test.ts and sourceBeats.test.ts pass unchanged.
- Parity: a fake RemoteRetrieval wrapping FileTranscriptTextIndex over a synthetic corpus gives a run whose research map, newSegments, sourcingTrace, tapeRelevance and evidence tape docs deep-equal those of the same run with the File pair injected directly.
- In the parity run, PrecomputedTextIndex.misses == 0 and hydrationMisses == 0, including probe and thesis queries.
- A degraded retrieval run completes with title-path sourcing and records the degraded reason in report.json.

**Tests.** vitest, one file at a time:
- new test/runPipelineRemoteRetrieval.test.ts: stub builders through RunPipelineDeps, injected finalize as in runPipeline.test.ts, multi-act fixture with a seeded beat and a pool segment
- re-run test/runPipeline.test.ts, test/researchShape.test.ts, test/sourceBeats.test.ts and test/generateForaysArgs.test.ts
Add a floor.

**Flag.** FORAY_RETRIEVAL_URL, plus FORAY_RETRIEVAL_TOKEN and FORAY_RETRIEVAL_MODE=bm25|hybrid (default bm25). Unset means today's local path.

**Live step.** Run one prompt on the founder PC against the founder-PC server (bm25), and diff its report.json sourcing lines against a local run. Then point it at the Spark server once W3-22 is deployed.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed, and it touches runPipeline.ts, researchShape.ts and sourceBeats.ts. Those files are also edited by W3-12/13/14/16/17 and by other workstreams, so merge order matters (see cross-workstream notes). The query-string helpers plus misses == 0 pin the coupling. R1-04's per-act pipeline will move prepare per act.

#### GV-97 · Jev and Qwen-judge adapters for SpineJudge and DraftCritic, with OQ-05 fallback

- **From:** W7-11, W4-16
- **Wave:** 21 · **Size:** S · **Depends on:** GV-20, GV-47, GV-91, GV-94
- **Covers:** R2-17

**Goal.** Give W7-07's best-of-2 spine and W7-08's self-critique their real judges: a Jev Choice for the spine, a Jev yes/no (noul) for draft sentences, a Qwen-judge for both, and a Jev-then-Qwen fallback (OQ-05). They are kept separate so W7-07 and W7-08 can merge before the Jev TS client and the ChatProvider exist.

**Design.**

INTEGRATION NOTE: Jev-backed SpineJudge and DraftCritic use the JevClient interface; when the judge route asks for it the fallback client of GV-47 answers through Qwen, so QwenSpineJudge and QwenDraftCritic are thin aliases, not separate prompts. From W4-16: renderSpineForJudge and the confidence floor (below it, pick the primary) and the timeout-to-primary rule; W4-16's acceptance moves here.

New backend/src/generation/judges.ts. It registers into the judge and critic registries that W7-07 and W7-08 created.
- JevSpineJudge: a Jev choice question built from spineJudgeQuestion(intent) with options A/B from renderSpineForJudge. It maps the response to {index, probabilities, confidence, requestId (x-typesafe-request-id), ms}.
- QwenSpineJudge: a ChatProvider call with a json_schema {choice: 'A'|'B'}, enable_thinking=false.
- JevDraftCritic: a Jev noul question, 'Is every fact in this sentence stated in the source text?', returning p.
- QwenDraftCritic: a json_schema {supported_probability}.
- FallbackJudge/FallbackCritic([jev, qwen]): on JevUnavailable (timeout, 503, malformed body), try the next judge. The answering judge's kind is recorded.
- Registered names: 'jev', 'qwen', 'jev-then-qwen'.
- Every Jev call goes through the gates workstream's TS Jev client (4 s budget, 0 retries, typed unavailable error); none goes through anthropicCall.ts.
- Every Jev call counts toward the R1-19 per-Foray Jev-call cap once that exists.

**Files edited:**

- test/suite-integrity.test.js

**New files:**

- backend/src/generation/judges.ts
- backend/test/judges.test.ts
- backend/test/fixtures/jev-choice-spine.json
- backend/test/fixtures/jev-noul-sentence.json

**Acceptance:**

- A recorded Jev choice body maps to the right index, probabilities and request id; a corrupted body raises unavailable, and jev-then-qwen then calls the Qwen fake
- A recorded noul body maps to p; an unavailable result falls back
- The A/B order hash in the question matches W7-07's renderer
- No import of @anthropic-ai/sdk; anthropicCall.test.ts stays green
- Jev unavailable, below the confidence floor, or the secondary past its timeout on the fake clock: the primary is used, decidedBy 'fallback-primary'.
- BACKEND_FLOORS in test/suite-integrity.test.js has an entry for judges.test.ts (added in this PR, so 'every backend suite on disk is covered by a floor' stays green).

**Tests.** backend: npx vitest run test/judges.test.ts with recorded Jev response fixtures, shaped from hermes-operating-system ops/jev/tests/_fixtures.py success_body_for/corrupted_body_for (no prompt or transcript text), and a fake ChatProvider. Add a BACKEND_FLOORS entry.

**Flag.** selected through FORAY_SPINE_JUDGE and FORAY_WRITER_CRITIC (unset = levers unusable, so inert)

**Live step.** Part of E4 and E5: real Jev and LiteLLM calls with the founder's keys; capture one sanitised response of each kind as a fixture.

**Founder need.** founder-approved label (orchestrator applies); plus Jev key and LiteLLM key (#1163) for the live trials only.

**Risk.** Jev signups were paused on 2026-09-22 and 503s were seen on 2026-09-28; the fallback covers this. noul and choice probabilities are not comparable (Hermes facts), so thresholds stay per question type. Position bias is handled by the order hash. Governed path.

### Wave 22

#### GV-98 · Evidence wave off the timed path: await only act 1's packs, gather the rest behind it

- **From:** W3-17
- **Wave:** 22 · **Size:** S · **Depends on:** GV-15, GV-61
- **Covers:** R1-05

**Goal.** Stop act 1's writer waiting for every act's evidence. runPipeline.ts:1401-1405 awaits a whole-Foray fan-out. Act 1 starts as soon as its own packs exist, and later acts' packs are gathered concurrently.

**Design.**

INTEGRATION NOTE: generationFlags.ts is created by GV-15; this card adds its reader there.

evidencePrefetch.ts PrefetchingEvidenceGatherer:
- prefetch (:167) gains an option acts?: (actIndex) => boolean, applied while building the queue.
- New startBackground(acts, ctx, options) runs the same worker loop without awaiting it.
  - It stores the promise.
  - A budget error (findBudgetError) is caught into deferredBudgetError, which gather() throws on its next call. This mirrors DefaultEvidenceGatherer's deferredBudgetError (gatherEvidence.ts:389, 405).
  - Other failures are counted as today.
- settleBackground() awaits the stored promise.
- metrics() adds timedPages, backgroundPages and backgroundMs.

runPipeline evidence stage, when generationFlags evidencePrefetchMode() === 'first-act':
1. await prefetch(sourced.acts, ctx, {acts: i => i === 0, skipSlot})
2. evidence.startBackground(..., {acts: i => i > 0, skipSlot})
3. narration begins. writeNarration's gathers for later acts share the in-flight memo (lookup, :233-252), so no page is gathered twice.

Before buildVeracityMetrics, and on every exit path (try/finally around narration), await settleBackground(), so no promise outlives the run and metrics are final. For the short tier (one act) this equals today.

**Files edited:**

- backend/src/generation/evidencePrefetch.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/generationFlags.ts
- backend/test/evidencePrefetch.test.ts
- backend/test/runPipeline.test.ts
- test/suite-integrity.test.js

**New files:**

- none

**Acceptance:**

- The default ('all') is unchanged.
- In 'first-act' mode the evidence stage resolves before slower act-2 gathers finish (fake gatherer with scripted delays).
- Every page is gathered exactly once.
- A background budget error surfaces from the next gather and stops the run naming the stage.
- There is no unhandled rejection, including when narration throws.
- Report metrics carry timedPages and backgroundPages.

**Tests.** vitest:
- `npx vitest run test/evidencePrefetch.test.ts`: fake EvidenceGatherer with scripted delays, plus a BudgetExceededError case
- test/runPipeline.test.ts: a multi-act stub run in first-act mode, asserting stage timing order and gather counts
Raise the floors.

**Flag.** FORAY_EVIDENCE_PREFETCH=all|first-act (default all).

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed. Background work must be settled on every exit path. With the null or dossier researcher, evidence is cue reads plus local lookups, so the saving is largest while web retrieval is still on, or with remote hydration.

#### GV-99 · Voice card and exemplar block in the Qwen writer's cached static prefix (flagged)

- **From:** W7-06
- **Wave:** 22 · **Size:** S · **Depends on:** GV-15, GV-31, GV-42, GV-50
- **Covers:** R2-17

**Goal.** Put the 60-word voice card and the 2 selected exemplar seams at the end of the byte-stable static part of the non-Anthropic writer prompt, behind a flag that is off by default, so E3 can A/B it. The block pins the voice and is shared across acts, rounds and Forays, so it lands in the Spark's prefix cache.

**Design.**

INTEGRATION NOTE: the single call site is the voice slot at the end of `stable` in prompts/actWrite.ts (GV-50).

New backend/src/generation/voiceExemplars.ts:
- VoiceExemplarsFileSchema (zod, mirroring W7-05's file).
- loadVoiceExemplars(root): a read-only, process-cached read in the pattern of loadSegmentPool (segmentPoolLookup.ts:54). It returns null for a missing, empty or invalid file, or one whose exemplars lack selectedBy/listenedOn, and logs once.
- writerExemplarsMode(): 'off'|'on' from FORAY_WRITER_EXEMPLARS, read at call time through generationFlags.readEnumFlag (GV-15, decision 5). Default off; a malformed value throws naming only the variable.
- voicePrefixBlock(file): a fixed string, 'VOICE CARD' plus the text, then 'TWO SEAMS IN THIS VOICE (style only - never quote them, never reuse their facts)' plus each exemplar with its role. No ids, dates or per-run text, and a fixed separator at the end.
- withExemplarPrefix(parts: {static, foray, call}, file) appends the block to the end of parts.static.
- exemplarProvenance(file) returns {mode, exemplarIds, fileSha}.
Integration is ONE call site: the provider/prompt-layout workstream's Qwen writer prompt builder (the R1-10 [static][foray][call] parts) calls withExemplarPrefix when the mode is on. AnthropicNarrationWriterBuilder is not changed.
Provenance: generateForays reads exemplarProvenance once per process and writes ReportEntry.levers.exemplars, which W7-04 collect checks. No writeNarration or veracity changes.
The card also commits tools/generation-bench/swaps/experiments/E3-writer-exemplars.json (rerunFrom 'narrate', expect.levers.exemplars.mode 'on').

**Files edited:**

- backend/src/cli/generateForays.ts
- backend/src/generation/prompts/actWrite.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/voiceExemplars.ts
- backend/test/voiceExemplars.test.ts
- tools/generation-bench/swaps/experiments/E3-writer-exemplars.json

**Acceptance:**

- Flag off, or an empty or unselected exemplar file: the Qwen writer prompt is byte-identical to the prompt without this card
- Flag on: the block is byte-identical for act 0 and act 3, round 1 and round 2, and two different Foray requests
- The block contains no timestamp, Foray id or act title
- A quote copied from exemplar text is refused by the existing quote gate (exemplars are not in request.documents); proven by a wrapped-stub test in the actNarration.test.ts style
- report.json rows carry levers.exemplars
- BACKEND_FLOORS in test/suite-integrity.test.js has an entry for voiceExemplars.test.ts (added in this PR, so 'every backend suite on disk is covered by a floor' stays green).

**Tests.** backend: npx vitest run test/voiceExemplars.test.ts. Covers the schema, the loader with a tmp root, mode parsing, byte-stability of withExemplarPrefix over synthetic parts, the quote-gate test, and a generateForays report-field test. Add a BACKEND_FLOORS entry.

**Flag.** FORAY_WRITER_EXEMPLARS=off|on (default off)

**Live step.** E3 (W7-04): arm A without and arm B with exemplars, rerun from 'narrate', founder pairwise listen. Check the cached-token share from the R1-14 call records.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Without the Qwen writer's prompt parts there is no call site, so this card lands after that card; the module alone would be dead code. Governed path. The R2-08 'same narrator?' drift alarm (writer workstream) should read the same file.

### Wave 23

#### GV-100 · Spine tier sizing on the Spark: per-tier JSON schema, tier-sized output budget with one shorter re-ask, seed-floor re-ask off the short timed path

- **From:** W4-04, W4-18
- **Wave:** 23 · **Size:** M · **Depends on:** GV-02, GV-14, GV-15, GV-25, GV-32, GV-67, GV-86
- **Covers:** R1-03, R2-07, GP-02, GP-05

**Goal.** Run the spine on Qwen3.8-27B with the cached prefix, a per-tier JSON schema and a tier-sized output (450 tokens short, about 1,200 medium), so later calls hit the radix cache, parse re-asks disappear, and the short tier keeps the seed-floor re-ask off its timed path.

**Design.**

INTEGRATION NOTE (merged W4-04 items 2-4 + W4-18). W4-18's LocalSpineBuilder duplicates GV-25's ChatSpineBuilder, so its behaviour is added to ChatSpineBuilder instead of a new class:
- schema: spineJsonSchema(tier, opts), exported from replySchemas.ts (decision 11: reply schemas live only there; no spineJsonSchema.ts module), = zodToJsonSchema(RawSpineSchema) (GV-02) with per-tier overrides (W4-04 item 2: acts minItems/maxItems from DURATION_SHAPE_BUDGETS types/spine.ts:28 with SHAPE_TOLERANCE, slots[].beats minItems 1, claim maxLength 420, title/summary maxLength 140, properties in contract order, including the fold fields of GV-67 and GV-86). The hand-built schema is not needed.
- budget: spineMaxTokens(tier, opts) = ceil((target + fold extras) x 1.5) is added to config/outputBudgets.ts (GV-14); the plan targets are that table's spine row (450 short, 1,200 medium, long 2,400 PROPOSED).
- request: ChatSpineBuilder sends the PromptParts of GV-32 as [system: stable, user: foray+call], response_format = spineJsonSchema(tier), maxTokens = spineMaxTokens, enable_thinking false; priority comes from the call context (GV-93).
- re-asks: structural and seed-floor revisions keep the identical prefix; a 'length' stop gets one re-ask 'Shorter: keep every beat one sentence of at most 25 words'; a second length stop throws TruncatedReplyError.
- selection: FORAY_STAGE_SPINE=local:spark (routing table), not FORAY_SPINE_PROVIDER.

--- From W4-04 (items 2-4) ---
2. SUPERSEDED (decision 11): no hand-built schema and no spineJsonSchema.ts. spineJsonSchema(tier, opts) in replySchemas.ts applies the per-tier overrides listed in the integration note (acts minItems/maxItems from DURATION_SHAPE_BUDGETS types/spine.ts:28 with SHAPE_TOLERANCE; slots[].beats minItems 1; claim maxLength 420; title and summary maxLength 140; seed optional) on top of zodToJsonSchema(RawSpineSchema) from chat/jsonSchema.ts (GV-02). A test validates the committed fixture spines against both the schema and RawSpineSchema, and asserts they agree.
3. SUPERSEDED (decision 10): no spineBudget.ts. In config/outputBudgets.ts (GV-14): the spine row of OUTPUT_TOKEN_BUDGETS is the plan target (450 short, 1,200 medium, long 2,400 PROPOSED); SPINE_FOLD_EXTRA_TOKENS (about 120 for the copy fields, about 100 per act for a folded introduction and exit) and spineMaxTokens(tier, opts) = ceil((target + extras) × 1.5) are added beside BUILDER_MAX_TOKENS. The headroom is there because truncation is fatal (anthropicCall.ts:33).
4. runPipeline.ts: with flags.fastPath on the short tier, it passes spineSeedFloorReasks = flags.spineSeedFloorReasksOnTimedPath (0) to postSeedWithFloor (postSeedSpine.ts:343), using the existing maxSeedFloorReasks option. The structural re-ask stays.

--- From W4-18 (applied to ChatSpineBuilder, decision 9) ---
1. ChatSpineBuilder (GV-25; no LocalSpineBuilder class) makes one call over the ChatProvider.
   - One call: {stage: 'spine', prefix, messages: [user: foray], structured: {kind: 'json_schema', schema: spineJsonSchema(tier, opts)}, maxTokens: spineMaxTokens(tier, opts), enable_thinking: false}; priority comes from the run context (GV-93).
   - A re-ask (ctx.revision) sends prefix, then foray, then the previous reply as the assistant turn, then the fix turn (buildSpineFixInstruction :184 or buildSeedFloorInstruction :213, chosen by revision.kind). The cached prefix covers the whole first turn.
   - A 'length' stop gets one re-ask: 'Shorter: keep every beat one sentence of at most 25 words'. A second length stop throws TruncatedReplyError.
   - The reply is parsed with RawSpineSchema and mapped to Spine. subject and angle come from the reply under foldCopy, otherwise from the intent (the same rule as AnthropicSpineBuilder.ts:155-163).
2. Selection is the routing table only: FORAY_STAGE_SPINE=local:spark picks ChatSpineBuilder (GV-37). createSpineBuilder.ts is not edited, and there is no FORAY_SPINE_PROVIDER.

**Files edited:**

- backend/src/generation/chat/ChatSpineBuilder.ts
- backend/src/config/outputBudgets.ts
- backend/src/generation/runPipeline.ts
- test/suite-integrity.test.js
- backend/src/generation/replySchemas.ts

**New files:**

- backend/test/spineTierSizing.test.ts
- backend/test/fixtures/local/spine-short-reply.json
- backend/test/fixtures/local/spine-medium-reply.json

**Acceptance:**

- spineJsonSchema(tier) accepts the short and medium fixture replies, rejects an act count outside the tier band, and agrees with RawSpineSchema on every fixture.
- spineMaxTokens returns the documented values for each tier with and without the fold extras.
- On the fast path, short tier, postSeedWithFloor is called with maxSeedFloorReasks 0. The classic path is unchanged.
- ChatSpineBuilder sends the structured json_schema for the requested tier and maxTokens = spineMaxTokens(tier), and parses the recorded short and medium fixture replies into a Spine that passes validateSpine.
- A re-ask request starts with the identical system and first user turn, followed by the assistant turn and the fix turn of the right kind.
- A scripted length stop triggers exactly one shorter re-ask, and a second length stop throws TruncatedReplyError.
- No @anthropic-ai/sdk import in chat/ChatSpineBuilder.ts or replySchemas.ts.
- BACKEND_FLOORS in test/suite-integrity.test.js has an entry for spineTierSizing.test.ts (added in this PR, so 'every backend suite on disk is covered by a floor' stays green).

**Tests.** backend vitest: test/spineTierSizing.test.ts (schema/zod agreement over the fixtures, budget table, re-ask shapes, length handling) with the scriptedProvider fake (GV-13); chatPlanningBuilders.test.ts re-run.

**Flag.** FORAY_STAGE_SPINE=local:spark (routing table) for the builder; the seed-floor change only under FORAY_FAST_PATH on the short tier.

**Live step.** With the LiteLLM key, run the 10 listened golden prompts with only ST-04 swapped (the R2-21 protocol). Record spine output tokens, cachedTokens on the second call, decode tok/s under the grammar (MT-12), the structural re-ask rate and MQ-10. Confirm SGLang honours json_schema property order and that enable_thinking=false reaches it.

**Founder need.** founder-approved label (orchestrator applies); plus LiteLLM virtual key for the Foray lane (#1163), for the live step only.

**Risk.** W4-04: Reordering the Anthropic prompt changes the pinned prompt tests on purpose, and can shift Claude's output slightly in classic runs. The content is unchanged. Turning off the seed-floor re-ask on short can lower the seeded share until the passage index lands, so watch MQ-09.
W4-18: A 27B model planning in about 450 tokens may plan less (R1's own risk). The golden set and MQ-10 decide, and the targets are constants. A grammar can nudge content toward shorter lists. Prefix-cache hits need the router to pin a Foray to one SGLang process (cross-workstream).

#### GV-101 · Run-start corpus integrity guard (roadmap PKG-23), extended to the remote manifest

- **From:** W3-26
- **Wave:** 23 · **Size:** S · **Depends on:** none
- **Covers:** GP-09

**Goal.** Refuse to source against a short or stale corpus, so a run cannot quietly draw from part of the archive. That is the #703 class of failure, which GP-09's move off the laptop makes more likely.

**Design.**

Follows docs/roadmap/corpus.md 'PKG-23 · Run-start integrity guard'. Its line refs to generateForays.ts are stale: provider construction is now :876-898.
- New backend/src/generation/archiveIntegrity.ts (read-only, so the persistence rule holds):
  - readSyncState(root): data-local/transcripts/r2-sync-state.json, or null.
  - archiveIntegrity({state, shows: corpusCoverage/scanNormalizedCorpus result}) returns {ok, expected, found, missingShows, shortShows}, where ok means found >= state.bodies_expected.
  - remoteIntegrity({healthz, pulledArchiveGeneratedAt}) returns ok when the server's indexVersion equals TRANSCRIPT_TEXT_INDEX_VERSION and the archive stamps match.
- generateForays.ts runs the right check after corpusCoverage: local when FORAY_RETRIEVAL_URL is unset, remote when it is set. On !ok it prints the shortfall and exits 2, unless --allow-short-archive is passed.
- The PKG-03 truncated-archive fixture does not exist (tools/foraycorpus-export/fixtures has only synthetic/), so tests build a tmp corpus plus a state file.

**Files edited:**

- backend/src/cli/generateForays.ts
- backend/test/generateForaysArgs.test.ts
- docs/roadmap/corpus.md
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/archiveIntegrity.ts
- backend/test/archiveIntegrity.test.ts

**Acceptance:**

- A matching state gives ok.
- A truncated tmp corpus gives !ok and names the short show. Mutation: comparing directory counts instead of bodies fails the test.
- An absent state gives ok with expected null.
- A show in the state but missing on disk is listed.
- A remote index version or archive stamp mismatch gives !ok.
- --allow-short-archive parses, defaults to false and bypasses the check.

**Tests.** vitest:
- `npx vitest run test/archiveIntegrity.test.ts`
- `npx vitest run test/generateForaysArgs.test.ts`
Add a BACKEND_FLOORS entry and raise generateForaysArgs from 18.

**Flag.** Always on. --allow-short-archive is the escape hatch.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed. A machine with a stale state file will refuse runs until it re-syncs or the flag is passed. That is the intended behaviour, and the message says which.

### Wave 24

#### GV-102 · Per-act pipeline driver: act 1's deepen, source, evidence, write and stitch first, later acts behind it

- **From:** W4-07
- **Wave:** 24 · **Size:** L · **Depends on:** GV-15, GV-18, GV-46, GV-86, GV-95, GV-98, GV-123
- **Covers:** R1-04, R1-01, GP-03

**Goal.** Stop act 1 waiting on every act's deepen, on whole-Foray sourcing and on the whole evidence wave. R1-04 puts this at 20-40 s of medium first audio; short has one act and is unaffected.

**Design.**

runPipeline.ts, when flags.perActPipeline:
1. After the spine and identity (runPipeline.ts:1305-1307), start deepen per act through its own gate.
   - Act 0 is enqueued first, and is folded where W4-05 applies.
   - The gate's limit is 1 by default, and FORAY_DEEPEN_CONCURRENCY raises it once the routing workstream sends deepen to the second box. Concurrent deepen on one Spark would slow act 0's writer.
   - The call context marks act 0 for priority.
2. Each act is a promise chain.
   - source:<i> waits for deepen:<i> and for source:<i-1>, so ledger order matches the classic path. It runs SourcingSession.sourceAct (W4-06) and banks {act, snapshot: session.exportState()} under the new key source:<i>. On resume the session is rebuilt from the last banked snapshot, so a changed corpus cannot re-decide an act that was already narrated.
   - evidence:<i> runs evidence.prefetch over [sourcedAct_i]. With the retrieval workstream's R1-05 tape-only mode it makes no model call.
   - narrate:<i> follows, then stitch:<i> in act order. The ordered loop (:1659-1680) awaits each act's chain instead of a pre-started narration.
3. The ForayStitcher is built with {actCount: spine.acts.length, deepenedAct: (i) => deepenedSoFar[i]} (W4-20).
   - The onActReady closure reads the session's newSegments and newSegmentSources at call time, not a whole-Foray `sourced`.
   - It passes projection {sourcedActs so far, slots, totalActs}.
4. showsIntroduced for act i comes from showsHeardBeforeAct (W4-20).
5. Narration order follows flags.narrationOrder (W4-08).
6. Checkpoint keys source:<i> and evidence:<i> are new, and W4-01's checkpointVariant separates per-act runs from classic ones. CHECKPOINT_VERSION is NOT bumped, so classic banked runs survive.
7. The no-tape stop (runPipeline.ts:1385 area) behaves the same on the short tier. On multi-act runs it fires only after the last act is sourced and cumulative tape is 0; an earlier act with 0 tape only logs.
8. At the end, session.result() supplies acts, newSegments, newSegmentSources and tapeRelevance for veracity, runtimeSecFor and finalize, exactly where `sourced` is used today.
9. Failure keeps the existing contract: abort the gates, await in-flight work with allSettled, rethrow.
10. Remote retrieval (GV-95). GV-95 prepares every search and hydrates every body inside the whole-Foray 'source' and 'evidence' stages (runPipeline.ts:1334, :1398). Those stages do not run under perActPipeline, so this card moves prepare and hydrate per act: source:<i> first runs GV-95's query helpers for act i's beats (prepare the searches, then hydrate the bodies they name) and only then calls SourcingSession.sourceAct; evidence:<i> hydrates the clip windows of sourcedAct_i before evidence.prefetch. With FORAY_RETRIEVAL_URL unset nothing changes. Without this, a per-act run with FORAY_RETRIEVAL_URL set would miss PrecomputedTextIndex silently and sourcing would degrade.
11. First-act evidence (GV-98). FORAY_EVIDENCE_PREFETCH=first-act is subsumed by the per-act chain: each evidence:<i> gathers only act i's packs and only narrate:<i> waits on it, so act 0 waits only on act 0's evidence. Under perActPipeline the first-act setting is accepted and has no further effect (it is recorded in the report as subsumed).

**Files edited:**

- backend/src/generation/runPipeline.ts
- backend/test/runPipelineCheckpoint.test.ts
- test/suite-integrity.test.js

**New files:**

- backend/test/perActPipeline.test.ts

**Acceptance:**

- Flag off: every runPipeline*, partialCandidate* and generateForays* test passes unchanged.
- Flag on, medium tier with stubs and recordingDeps on a fake clock: narrate:0 starts before source:1 ends and before deepen:3 ends, and onActReady(0) fires before narrate:1 ends.
- Flag on: the finished candidate's items, segments and veracity deep-equal the flag-off run on the same stubs. Only timing differs.
- A per-act run killed after source:1 resumes from the banked snapshot. A stub cue provider that would now source differently does not change acts 0-1.
- A classic checkpoint is not resumed by a per-act run, and the reverse, because the fingerprints differ.
- Remote retrieval: a per-act run with a fake RemoteRetrieval (GV-29) and FORAY_RETRIEVAL_URL set has PrecomputedTextIndex misses == 0 and hydrationMisses == 0, and its candidate deep-equals the classic (flag-off) remote run on the same fake.
- With FORAY_EVIDENCE_PREFETCH=first-act and the flag on, the candidate deep-equals the flag-on run with the default prefetch, and narrate:0 starts before evidence:1 ends.

**Tests.** vitest perActPipeline.test.ts (ordering on the fake clock via recordingDeps from GV-123, equivalence with the classic path, resume from snapshot, the remote-retrieval case with the fake RemoteRetrieval, and the first-act case) and runPipelineCheckpoint.test.ts additions.

**Flag.** FORAY_PER_ACT_PIPELINE, or the FORAY_FAST_PATH umbrella. Default off.

**Live step.** Medium golden prompts on the Spark with the flag on and off: compare first-seam time and MT-06 from CallRecords.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** This is the G-38 act-1 fast path. The spine stays frozen and per-act stages only reorder work after it, so it is recorded as an orchestrator decision against the Spark assessment §2b's question. It is L because it rewires runPipeline's middle section; W4-20 and W4-06 already carry the supporting refactors to keep this PR to the driver. The partial's share rules are deferred, not dropped.

#### GV-103 · Judge calibration harness: labelled examples in, an agreement-by-threshold table out (sentence support and clip scores), plus a flag that keeps the run data calibration needs

- **From:** W5-07
- **Wave:** 24 · **Size:** M · **Depends on:** GV-20, GV-27, GV-47, GV-79
- **Covers:** R1-07, R2-09, R2-03, R1-20

**Goal.** LM-24: untuned thresholds fail (10 of 13 retries). This card sets the support threshold and the clip-score cut-offs at the point where judge-vs-label agreement reaches 0.9 or better. It never makes a new Claude call to label anything.

**Design.**

INTEGRATION NOTE: thresholds are written into the per-judge keys added by GV-47, and calibrateJudges accepts --judge jev|qwen from the start.

Data reality: a run's checkpoint (which holds the WrittenActs with verified/verifierNotes/evidence) is DELETED when the candidate is written (cli/checkpointStore.ts:107-109 discard, called at generateForays.ts:802/816). Run 9's and 14 Sep's per-page verdicts therefore survive only as report.json unverifiedPageDetails, candidate scripts, and the relay's done/ request and answer files on the founder PC.

1. generateForays.ts gains --keep-calibration <dir>. It must be under data-local/; anything else is refused. On success it writes {writtenActs, sourced.tapeRelevance, sourced acts' tape pointers, subjectSentence} for each prompt before the checkpoint is discarded. It is written from cli/, which promptNoPersistence permits, and the prompt text itself is never written.
2. New pure judgeCalibration.ts:
   - LabelledExample = {kind:'page-support'|'clip-subject'|'clip-claim', id, payload, label: boolean, labelSource:'founder'|'review-lane'|'run-verdict'}.
   - extractPages(export) yields pages (script, claim, evidence texts) with the pipeline's own verified flag as an OPTIONAL label (labelSource 'run-verdict').
   - extractClips(export, cueProvider) yields unlabelled clip rows (claim, subject sentence, window text) for the founder or the review lane to mark.
   - calibrate(examples, judge, thresholds) returns {agreement, precision, recall, n, wilson95} per threshold and the lowest threshold with agreement >= 0.9.
     - Pages are predicted supported iff every statement sentence's p >= t (W5-08).
     - Clips are predicted on-subject iff the score >= the level.
3. CLI backend/src/cli/calibrateJudges.ts (--labels <jsonl> --kind --judge jev|qwen --out data-local/judge-calibration/...). The launcher is tools/generation/calibrate-judges.mjs (tsx, the warm-transcript-index.mjs pattern).
4. Thresholds are keyed per judge in gateConfig (supportMinP.jev, clipLevel.jev). A follow-up orchestrator PR copies the recommended values in.

**Files edited:**

- backend/src/cli/generateForays.ts
- backend/src/generation/gateConfig.ts
- test/suite-integrity.test.js
- backend/test/generateForays.test.ts

**New files:**

- backend/src/generation/judgeCalibration.ts
- backend/src/cli/calibrateJudges.ts
- tools/generation/calibrate-judges.mjs
- backend/test/judgeCalibration.test.ts
- backend/test/fixtures/calibration/synthetic-export.json

**Acceptance:**

- Given a synthetic export with 4 verified and 2 refused pages and a fake judge with known p values, the table reports the expected agreement at each threshold and recommends the right one.
- Clip extraction yields one row per placed clip, carrying the subject sentence and window text.
- --keep-calibration refuses a path outside data-local/, and the export contains no prompt field (asserted in generateForays.test.ts).
- calibrateJudges refuses an --out outside data-local/.

**Tests.** Vitest judgeCalibration.test.ts and a generateForays.test.ts addition, using FakeJevClient and synthetic text only (transcript text never goes in git).

**Flag.** Offline tool plus an opt-in driver flag. Nothing changes at request time.

**Live step.** On the founder PC with the Jev key:
1. Run two or three golden prompts with --keep-calibration.
2. Collect founder yes/no labels for about 40 clips and the narrated pages, through the R2-19 review lane (GV-41's verdict rows; labelSource 'review-lane').
3. Calibrate page support and clip scores.
4. Post both tables to #1163 and set the gateConfig thresholds.

**Founder need.** founder-approved label (orchestrator applies); plus a Jev key on the founder PC, and about 20-30 minutes of yes/no labels on extracted clips and pages. Optionally: a ruling on #1163 on whether the pipeline's own existing verifier verdicts (Sonnet, from the run-9 and 14 Sep relay logs) may serve as labels under OQ-06. No new Claude call is made either way. The default is founder labels only.

**Risk.** Sample sizes are tiny (about 40 clips and a few dozen pages), so report Wilson intervals and treat thresholds as provisional. Labels are per page, not per sentence, so the page-level rule approximates. All the data lives on the founder PC. generateForays.ts is also edited by the eval and orchestration workstreams; coordinate rebase order.

### Wave 25

#### GV-104 · Voice checks on generated narration: N7-N9 and N24 in the writer gate, per-seam sentence shape, reading grade 6-9 on the scorecard (MQ-15 to MQ-18)

- **From:** W5-18, W4-12
- **Wave:** 25 · **Size:** M · **Depends on:** GV-04, GV-10, GV-15
- **Covers:** R2-14, QK-25, GP-24, MQ-15, MQ-16, MQ-17, MQ-18, R2-08

**Goal.** Enforce in code the style rules that today live only in the prompt (AnthropicNarrationWriterBuilder.ts:275-279). The 27B will break them more often than Sonnet (R2). This also makes the voice pillar measurable in under 1 s, the adopted reading of 'Hemingway' (OQ-02).

**Design.**

INTEGRATION NOTE (merged W5-18 + the measurement half of W4-12; both created backend/src/generation/voiceChecks.ts). One voiceChecks.ts, built on spokenLine.js (GV-10); no mirrored constants. From W4-12 item 1-2: voice also carries seamShape {meanWords, maxWords, shareInBand, overMaxSeams} per seam, and the bench gains detail columns 'sent mean' and 'grade' (absent prints —). The Jev 'same narrator?' drift alarm is GV-116.

--- From W5-18 ---
- New voiceChecks.ts: voiceReport(script, {hasTape}) returns:
  - hardErrors: spokenLineErrors per sentence (reference leak, digits, hedges, banned adjectives, openers, a rhetorical question with no tape) plus N24 (numericExpressionsIn > 1 per sentence);
  - shape (sentenceShape);
  - shapeIssues: N21 (mean outside 12-15, any sentence over 25, no sentence under 6 when the script runs over RHYTHM_TRIGGER_SEC);
  - grade (fleschKincaidGrade);
  - wordCount.
- writeAct.ts validateSeam (:865-905): gates.voice (new key FORAY_VOICE_GATE = off|report|enforce, default report; plus FORAY_VOICE_ENFORCE_FROM_ACT, default 1, and readingGradeBand [6,9]).
  - In 'enforce', hardErrors (never shape or grade) become mechanical issues, so the seam gets the existing one-seam re-ask. This applies only to acts with index >= voiceEnforceFromAct, which keeps retries off act 1's first-audio path (R2).
  - 'report' does nothing in writeAct.
- veracityMetrics.ts: VeracityMetrics.voice = {readingGrade, gradeInBand, sentencesOver25Per100Words, meanSentenceWords, shortSentenceShare, speakabilityPer100Words{digits, urls, acronyms, brackets}, bannedPer100Words}.
  - Computed over every final narration item: seams, act intros and exits, the prelude.
  - The scripts arrive through a new BuildVeracityMetricsInput.narrationScripts (:902) that runPipeline passes from the final items. hasTape comes from the item's neighbours.
  - Derived from final items, so it is resume-safe.
- No change to check-forays.mjs. 68 of the 157 committed generated narration items already break N21.

--- From W4-12 (items 1, 2 and the bench column part of 4) ---
1. New module backend/src/generation/voiceChecks.ts.
   - seamSentenceShape(script): {sentences, meanWords, maxWords, shortShare, overMax}.
   - It uses spokenLine.splitSpokenSentences and spokenLine.sentenceShape plus the moved constants SENTENCE_MEAN_WORDS, SENTENCE_MAX_WORDS and SHORT_SENTENCE_WORDS from backend/src/copy/spokenLine.js (GV-10, already a dependency; decision 16). Nothing is mirrored and no parity test against check-narration.mjs text is needed, because check-narration.mjs itself re-exports the same module.
   - actVoiceSummary(writtenAct) aggregates per act.
2. veracityMetrics.ts: VeracityMetrics (:819) gains optional `voice: {seamShape: {meanWords, maxWords, shareInBand, overMaxSeams}, drift?: {perAct: Array<number|null>, model: string}}`. buildVeracityMetrics (:927) fills seamShape. evaluateVeracityGate (:1019) is unchanged.

**Files edited:**

- backend/src/generation/writeAct.ts
- backend/src/generation/veracityMetrics.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/gateConfig.ts
- test/suite-integrity.test.js
- tools/generation-bench/run.mjs
- tools/generation-bench/run.test.mjs
- backend/test/veracityMetrics.test.ts
- backend/test/actNarration.test.ts

**New files:**

- backend/src/generation/voiceChecks.ts
- backend/test/voiceChecks.test.ts

**Acceptance:**

- voiceChecks.test.ts:
- a seam with '40 percent', 'Interestingly,' and a 31-word sentence yields hardErrors (digit, opener) and shapeIssues (over 25);
- the grade is reported;
- a question is flagged only when hasTape is false.
- A baseline test reads tools/foray/fixtures/frozen/data/forays.json with fs (what-engineers-actually-do-all-day-e08236, 40 scripts) and pins its voice numbers.
- actNarration.test.ts: in enforce mode a digit in an act-2 seam triggers a re-ask while the same seam in act 1 does not. Report mode never changes rounds.
- The default report mode adds the voice block and changes no output text.
- seamSentenceShape on fixed scripts returns the exact mean, max and short share.
- run.mjs prints the new voice detail columns, with — for the out-4 and out-9 fixtures.

**Tests.** Vitest voiceChecks.test.ts plus additions to veracityMetrics.test.ts and actNarration.test.ts. node --test tools/generation-bench/run.test.mjs for the columns.

**Flag.** FORAY_VOICE_GATE defaults to report; enforce is opt-in, together with FORAY_VOICE_ENFORCE_FROM_ACT.

**Live step.** Compare voice metrics for Qwen-written and Claude-written acts on the golden set (eval workstream), then choose which hard errors to enforce.
With Jev, score the 14 Sep candidate and golden runs. Set an alarm threshold only after the founder's R2-01 cards say which acts sounded like a different narrator.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** W5-18: REFERENCE_LEAK_RE bans 'according to' and 'cites', which attribution may need, so watch the re-ask rate in report mode first. The grade band is not validated for listening and stays scorecard-only. HANDOFF_SCRIPT opens with a question; it is out of scope once W5-12b's cut policy is on.
W4-12: It overlaps R2-14's sentence rules. This card reports per seam and never gates; R2-14 owns gating, and the two must converge on one splitter. tools/generation-bench/run.mjs COLUMNS is also edited by the eval workstream and W4-15, so they land serially. Jev noul and score probabilities are not comparable, so only the score is used.

#### GV-105 · Spark generation worker: claim a job, run the pipeline with the job sink and render spool

- **From:** W6-19
- **Wave:** 25 · **Size:** M · **Depends on:** GV-59, GV-74, GV-81
- **Covers:** R1-15, GP-07, GP-08

**Goal.** Close the on-demand loop. An outbound worker on the Spark claims queued jobs and runs generation, publishing item-level snapshots to the job row ahead of the playhead (W6-03/W6-18) and rendering per item (W6-07). It refuses to run any Anthropic builder.

**Design.**

New backend/src/cli/generationWorker.ts.

The loop:
1. Call rpc `claim_generation_job` and build a PromptSpec from {prompt, tier}.
2. Run generateOneCandidate (generateForays.ts:548) with:
   - deps {jobSink: SupabaseJobSink(jobId), renderClient: SpoolRenderClient(spool)}
   - lane 'on-demand'
   - audioPolicy 'phone-voice-first'
3. Heartbeat updated_at every 10 s.
4. On an exception, close the job as failed with a short reason.
5. Back off when the queue is empty.
6. Run one job at a time. This respects OQ-07 (Spark shared); the provider workstream's semaphores handle concurrency.

Startup refusal (zero-Anthropic rule):
- The worker refuses to start when any stage factory would build an Anthropic builder: env.anthropicDryRun is false and the provider workstream's local-provider mode is unset.
- It also refuses when ANTHROPIC_BASE_URL points at a relay.
- Until a local provider exists, it runs only with Stub builders, which is enough for the end-to-end plumbing test.

Prompt handling:
- The prompt is never logged or written.
- The row's copy is nulled at claim (W6-18).

The loop takes an injected RPC client, sink factory, pipeline and clock. New tools/generation/generation-worker.mjs is a tsx launcher in the style of warm-transcript-index.mjs.

**Files edited:**

- backend/src/cli/generateForays.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/cli/generationWorker.ts
- backend/test/generationWorker.test.ts
- tools/generation/generation-worker.mjs

**Acceptance:**

- With fakes, a queued job is claimed once, the injected pipeline runs, snapshots are published in seq order, and the job closes complete.
- When the pipeline throws, the job closes failed and the loop continues.
- The prompt string appears in no sink call and no log line (the test captures the console).
- An empty queue backs off without busy-looping (fake clock).
- The worker refuses to start when the stage factories would select an Anthropic builder or when ANTHROPIC_BASE_URL is set.

**Tests.** generationWorker.test.ts (vitest) with a fake RPC client, fake sink and render client, and a fake clock. Add floors.

**Flag.** A new CLI that nothing starts automatically.

**Live step.** Once the provider workstream's Qwen path exists, run the worker on the Spark (D8 spark-live) against the applied table. Insert a founder job and measure first audio and minLeadSec end to end.

**Founder need.** founder-approved label (orchestrator applies); plus the Supabase service key and the R2 narration token on the Spark. The founder moves spark-live (D8).

**Risk.** - The worker is useful only with a non-Anthropic provider path, and it must never fall back to the relay.
- The dollar budget guard is inert at $0 local prices, so the worker relies on the provider workstream's Spark-seconds caps (R1-19).

### Wave 26

#### GV-106 · Tier-aware clip ceiling in sourcing plus the MQ-14 tier-fit metric (reported, gate behind a flag)

- **From:** W4-15
- **Wave:** 26 · **Size:** M · **Depends on:** GV-04, GV-18, GV-89
- **Covers:** R2-15, QK-28, GP-25

**Goal.** Make it impossible for one clip to swallow the Foray: the 30-minute thought ceiling becomes min(30 min, the tier budget left). Every run reports how far its runtime is from the tier. On 14 Sep a short was asked for and 37 min came out.

**Design.**

1. sourceBeats.ts: SourceBeatsOptions (:287) gains `runtimeBudgetSec?`. SourcingState gains runtimeBudgetSec and remainingSeededBeats, counted from the deepened acts and decremented as beats resolve. The W4-06 snapshot includes both.
2. New clipCeilingSec(state): number | undefined.
   - undefined when there is no budget, which is exactly today's behaviour.
   - Otherwise left = runtimeBudgetSec - Σ placedDurations - remainingSeededBeats × TAPE_WINDOW_MIN_SEC.
   - It returns 0 ('no room') when left < TAPE_WINDOW_MIN_SEC, else min(left, TAPE_WINDOW_MAX_SEC).
3. Apply the ceiling.
   - chooseCutForPlacement (:2043) passes maxSec = clipCeilingSec(state) to cutExtent (:2069), which already threads maxSec into extendToThought and cutWindowToSegment.
   - mergeIntoClip (:1858, :1874) uses the ceiling in place of TAPE_WINDOW_MAX_SEC.
4. A ceiling of 0 refuses tape with a new gate 'tier-budget'.
   - It is added to Tier2Gate (types/tapeSourcing.ts:464) and to Tier1Gate under the same name, since tier-1 pool segments have fixed lengths and are refused, not cut.
   - It goes in TIER2_GATE_PROGRESS (:2117) after the m4 gates, and into any zod enum for sourcingTrace in the source checkpoint schema.
   - The beat is narrated, and sourcingTrace says why. Undershoot is never padded.
5. runPipeline passes runtimeBudgetSec = tierRuntimeBand(tier)[1] - narrationEstimateSec(deepened) (W4-14) when flags.tierRuntimeCap is on.
6. Tier fit in veracityMetrics.ts.
   - runPipeline computes runtimeSecFor(items, runtimePool) before buildVeracityMetrics (today it is computed after, at :1745) and passes it in.
   - tierFit = {tier, targetSec, runtimeSec, ratio, withinTolerance}.
   - evaluateVeracityGate (:1019) gets an option {tierFit: boolean}. When true it refuses 'tier runtime above +15%', and treats a null tierFit as failing.
   - publishForay (:832) passes the option only when FORAY_GATE_TIER_FIT is set.
7. generateForays report rows carry tierFit. tools/generation-bench/run.mjs gets a 'tier fit' column (absent prints —), with tests and a raised floor.

**Files edited:**

- backend/src/generation/sourceBeats.ts
- backend/src/types/tapeSourcing.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/tierRuntime.ts
- backend/src/generation/veracityMetrics.ts
- backend/src/cli/publishForay.ts
- backend/src/cli/generateForays.ts
- tools/generation-bench/run.mjs
- tools/generation-bench/run.test.mjs
- test/suite-integrity.test.js
- backend/test/veracityMetrics.test.ts
- backend/test/actNarration.test.ts

**New files:**

- backend/test/tierClipCeiling.test.ts

**Acceptance:**

- Without runtimeBudgetSec, every sourceBeats.test.ts case gives byte-identical results.
- Synthetic cues with a relevant thought running 25 min, a short-tier budget of 1,035 s and 3 seeded beats left: the clip is cut at or under 1,035 - 3×60 - placed seconds, on a cue boundary.
- Once the budget is exhausted, later beats resolve to narration with gate 'tier-budget' in sourcingTrace, and a tier-1 pool segment that would overrun is refused under the same gate.
- tierFit is computed for every generated outcome. evaluateVeracityGate is unchanged unless {tierFit: true}, which then refuses a 37-minute short and a null tierFit.
- run.mjs prints the tier fit column, with — on the old fixtures.

**Tests.** vitest tierClipCeiling.test.ts (synthetic cues and tmpdir corpus, budget consumption, gate trace for both tiers) and veracityMetrics.test.ts tierFit cases; node --test tools/generation-bench/run.test.mjs.

**Flag.** FORAY_TIER_RUNTIME_CAP for sourcing (fast-path umbrella) and FORAY_GATE_TIER_FIT for the publish gate. Both off by default; the metric is always reported.

**Live step.** Golden set on the Spark with the cap on and off: share of Forays within ±15% of tier, and MQ-08 tape share.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** sourceBeats.ts is shared with the retrieval workstream, so landing order must be agreed. Capping shortens thoughts only when the budget is short, and cutExtent still ends on boundaries, but MQ-06 clean-cut rate may dip, so watch it. The gate option changes RQ-15's publish-gate semantics, hence the separate flag. run.mjs is shared with W4-12 and the eval workstream.

### Wave 27

#### GV-107 · Beat candidate enumeration and async pre-judging: one Jev choice per beat, then two scores on the top K

- **From:** W5-04
- **Wave:** 27 · **Size:** M · **Depends on:** GV-15, GV-18, GV-20, GV-79
- **Covers:** R1-20, R2-03

**Goal.** Ask Jev, per beat, which candidate window makes this claim about this subject ('none' allowed), and score the leaders. This runs before the synchronous sourceBeats() walk (sourceBeats.ts:350), so the Foray-wide ledgers (M3, M4, D2, the F-96 merge) keep their order, and the 86 sourceBeats() calls in sourceBeats.test.ts stay synchronous.

**Design.**

1. sourceBeats.ts exports beatJudgeCandidates(deepenedActs, options, {actIndices?}): BeatCandidateSet[].
   - It builds the same read-only SourcingState inputs (textIndex, transcriptArchive, cueProvider, topic gate, root, segmentPool, windowText) and NO ledgers.
   - For each non-argument beat (argument beats skip, mirroring resolveOneBeat :1233):
     - candidates = tier2Candidates(claim, state, usableArchiveEntry(state), beat.seed) (:2188), seed first.
     - The seeded candidate gets selectTapeWindow(claim, cues, {idf, within: seed}), mode 'seed-window', exactly as Tier2Walk.run does (:1517-1522).
     - Every candidate gets the whole-episode window, mode 'search'.
     - The top 3 pool rows from scoreSegmentsAgainstClaim (segmentPoolLookup.ts:208), filtered by tier1IsUsable's topic part only, are added as mode 'pool', with text from state.windowText.
     - floorCleared = tapeWindowIsRelevant(window, floor) for each option. Options with share 0 are dropped.
     - The list is capped at 20 options and 40,000 characters (about 10k tokens), dropping the lowest lexical share first (LM-23).
   - Keys are 'pool:<segmentId>' or '<mode>:<itemId>#<firstCue>-<lastCue>'. selectTapeWindow is deterministic in (claim, cues, idf, within), so the walk recomputes the same window.
2. clipJudge.ts (W5-03) gains choose({subjectSentence, claim, options}): Promise<{ranked:{key,p}[], noneP} | {unavailable}>.
   - Jev: state = {subject, claim, passages:{o1..oN}}. One choice question with criteria o1..oN ({what:'passage oN'}) plus 'none' ({what:'no passage makes this claim about this subject'}).
3. New prejudgeClips.ts: prejudgeClips(sets, judge, {subjectSentence, topK: gates.clipJudgeTopK (new key, default 2), concurrency: 8}) returns ClipVerdictBook = Record<'act/slot/beat', {ranked, noneP, windowScores: Record<key, ClipScores>, unavailable?}>.
   - Scores are asked for the top-K keys only. The book has a zod schema so it can be checkpointed.
4. runPipeline.ts: when gates.clipJudge === 'enforce', a checkpointed stage('clip-judge', ClipVerdictBookSchema) runs after deepen and before `source` (:1334). Its book goes to sourceBeats (W5-05).
   - actIndices lets R1-04's per-act pipeline judge act 0 first.
   - sourceBeats.ts imports types only from clipJudge.ts / prejudgeClips.ts, so the no-fetch scan (sourceBeats.test.ts:306-333) stays clean.

**Files edited:**

- backend/src/generation/sourceBeats.ts
- backend/src/generation/clipJudge.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/gateConfig.ts
- test/suite-integrity.test.js
- backend/test/sourceBeats.test.ts

**New files:**

- backend/src/generation/prejudgeClips.ts
- backend/test/prejudgeClips.test.ts

**Acceptance:**

- On three existing sourceBeats.test.ts fixtures, every emitted key's window equals selectTapeWindow recomputed for the same episode, mode and seed (asserted in the test).
- No beat's option list exceeds 20 entries or 40,000 characters.
- prejudgeClips calls choose once per beat and score at most topK times per beat, with at most 8 in flight (a deferred-promise fake).
- A judge 'unavailable' answer yields {unavailable} in the book and never throws.
- The no-fetch structural test still passes.

**Tests.** Vitest prejudgeClips.test.ts with synthetic multi-episode bodies (FakeBodySource pattern, transcriptTextIndex.test.ts:30-56) and a FakeJevClient-backed JevClipJudge. A new describe block in sourceBeats.test.ts for beatJudgeCandidates.

**Flag.** Runs only when FORAY_CLIP_JUDGE=enforce. In off and shadow modes no candidate sets are built.

**Live step.** With the Jev key, prejudge the deepened acts of two fresh golden-set runs on the founder PC. Record choice latency per beat and how often 'none' wins.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** On the timed path: for a medium Foray, about 30 beats x (1 choice + K scores), 8 wide, is roughly 2-3 s. R1-04 (another workstream) must judge act 0 first, or first audio slips. Opening up to 8 bodies per beat before sourcing doubles cue reads; the FileTranscriptCueProvider LRU of 256 (transcriptArchiveLookup.ts:307) absorbs the walk's reopen, but laptop RAM is tight. Choice and noul probabilities are not comparable (Hermes facts.yaml:110), so never threshold one against the other.

### Wave 28

#### GV-108 · Cut-to-introduction policy: a failing seam keeps only its code-checked introduction sentences or is dropped, and HANDOFF_SCRIPT is never emitted

- **From:** W5-12b
- **Wave:** 28 · **Size:** M · **Depends on:** GV-10, GV-15, GV-21
- **Covers:** R2-13, QK-29, GP-26

**Goal.** Apply R2-13's policy. An unverified seam is cut to its introduction, checked in code, or dropped so the clips run together. The hand-off line must never play.

**Design.**

INTEGRATION NOTE: depends on the per-act servability of GV-21 (W5-12a merged there).

writeAct.ts finalPageFor (:1145) and assemble (:1094), when gates.unverifiedSeamPolicy === 'cut' (new key FORAY_UNVERIFIED_SEAM_POLICY = keep|cut, default keep):
- The cases: a confirmed-but-uncarried page (:1176-1191), a salvage page (:1196-1210), and the no-page hand-off (:1211-1225).
  - A seam that introduces a clip keeps only its intro sentences: sentences s (W5-17 splitter) where introNamesSource(s, clip) (actSeams.ts:385) holds, introRestatesClip is false, and narratorStructureLeaks is empty.
  - That page has sources = [the introduced clip's tape source], verified: true, verification {kind:'intro-only', clipId}, and cutSentences = the rest.
  - A seam with no surviving intro sentence, or one that introduces no clip, gets no page. Its narration beats record droppedReason: 'unverified-cut'.
- assemble stops throwing for this case (:1121-1125) in cut mode only. stitchAct.ts:182 already emits nothing for a narration beat without a page.
- HANDOFF_SCRIPT is never produced in cut mode.

Schemas:
- types/narration.ts: verification becomes a union of SynthesisVerificationSchema and IntroOnlyVerificationSchema {kind:'intro-only', clipId}. isSynthesisVerified (:396) is unchanged.
- NarratedBeatSchema (.strict(), :303) gains cutSentences?: string[] (also used by W5-11).
- runPipeline.ts WrittenBeatSchema (:865) gains droppedReason?: 'unverified-cut' on the narration variant.
- forayItems.ts INTERNAL_ONLY_FIELD_NAMES (:405) adds 'cutSentences' (belt and braces).

veracityMetrics:
- computePagesDropped (:482) reports cut drops separately as pagesCut.
- computeUnverifiedPages ignores dropped beats, since nothing plays for them.

**Files edited:**

- backend/src/generation/writeAct.ts
- backend/src/types/narration.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/forayItems.ts
- backend/src/generation/veracityMetrics.ts
- backend/src/generation/gateConfig.ts
- tools/foray/check-forays.test.mjs
- test/suite-integrity.test.js
- backend/test/actNarration.test.ts
- backend/test/stitchForay.test.ts
- backend/test/runPipelineCheckpoint.test.ts

**New files:**

- backend/test/introCut.test.ts

**Acceptance:**

- Cut mode: a failing full-intro seam becomes an intro-only verified page that still names the show (Q-09). A failing Carry seam leaves its beat with no page, and no HANDOFF_SCRIPT appears anywhere in the WrittenAct.
- The stitched act with a dropped beat passes validateActCoverage and stitchForay.
- check-forays accepts a dropped seam, so the dropped seam is emitted (settled in planning by reading the checker, not left to the PR): tools/foray/check-forays.mjs has no rule that a segment item must follow a narration item. Its segment branch (check-forays.mjs:1442-1512) checks the segment id, uniqueness, the LOCATE-REQUIRED tier, the published caption and that the item declares a slot in `slots` (:1468); the adjacency rules D2, D4 and D5 run over the segments-only `played` list (:1009, :1512), so removing a narration item between two clips changes none of their verdicts; the only position rule on narration is that a bridge opening a Foray must declare its own slot (:1305-1313). tools/foray/check-forays.test.mjs gains a fixture Foray in which a clip follows a clip with no narration item between them, each segment carrying its slot, and asserts check-forays reports no error for it.
- A checkpoint with an intro-only page and droppedReason resumes.
- Keep mode: actNarration.test.ts and writeNarration.test.ts are unchanged.

**Tests.** Vitest introCut.test.ts plus additions to actNarration.test.ts, stitchForay.test.ts and runPipelineCheckpoint.test.ts. Run node --test tools/foray/check-forays.test.mjs alone.

**Flag.** FORAY_UNVERIFIED_SEAM_POLICY=cut. Default keep.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** A slot whose every seam is cut becomes all clips. check-forays accepts that shape (see the acceptance), but the listening golden set must hear it before cut becomes the default (default-flips table). Intro sentences pass only a naming check, not a support check; W5-16/W5-15 add those. Rebase order against W5-11 and the writer workstream's R1-06 on writeAct.ts.

### Wave 29

#### GV-109 · Clean-cut measurement (MQ-06) with per-edge boundary kinds, and refusal of a claim-only opening edge

- **From:** W5-13
- **Wave:** 29 · **Size:** M · **Depends on:** GV-15, GV-18
- **Covers:** R2-05, MQ-06

**Goal.** Report the boundary the pipeline already computes. It lands on NewSegment (sourceBeats.ts:1773) and the tape row (:481) but is never aggregated. Gate it at 0.9, and refuse a clip the listener would join mid-thought.

**Design.**

- tapeExtent.ts extendToThought (:209): ThoughtExtent (:194) also returns startBoundary and endBoundary. startKind and endKind already exist; only the weaker is returned (:350).
- transcriptArchiveLookup.ts:
  - TapeSpan (:1118) gains startBoundary and endBoundary.
  - cutWindowToSegment (:1184-1215): floor growth rewrites to 'claim-only' only the edge it moved (first !== window.firstCue or last !== window.lastCue). Today both edges are rewritten at :1207.
- sourceBeats.ts mergeIntoClip (:1847): carry start and end kinds alongside weakerBoundary (:1926).
- types/tapeSourcing.ts: NewSegmentSchema (:188, strict) and TapeRelevanceInput (:332-338) gain optional startBoundary and endBoundary; runPipeline.ts TapeRelevanceInputSchema (:673) likewise. finalizeForay.ts:233 maps fields explicitly and keeps writing only `boundary`, so check-forays and committed data are untouched.
- sourceBeats.ts placementGateFor (:2017): when gates.claimOnlyOpening === 'refuse' (new key FORAY_CLAIM_ONLY_OPENING = allow|refuse, default allow) and cut.span.startBoundary === 'claim-only', return new gate 'claim-only-open'. Tier2Gate (types/tapeSourcing.ts:464), TIER2_GATE_PROGRESS (:2117, beside 'past-duration') and runPipeline's TIER2_GATE_SCHEMA (:715-731) all add it, and the walk falls through.
- veracityMetrics.ts:
  - computeCleanCuts(rows) returns {rate, openingCleanRate, known, unknown, claimOnlyOpenings}. Tier-1 and pool-reused rows carry no boundary and count as unknown.
  - VeracityMetrics gains cleanCutRate and cleanCutDetails.
  - evaluateVeracityGate adds GATE_MIN_CLEAN_CUT_RATE = 0.9 when passed cleanCutGate 'enforce' (new key FORAY_CLEAN_CUT_GATE = report|enforce, default report; passed in like W5-06's tapeGate). N/A when known == 0; null with known > 0 fails.

**Files edited:**

- backend/src/generation/tapeExtent.ts
- backend/src/generation/transcriptArchiveLookup.ts
- backend/src/types/tapeSourcing.ts
- backend/src/generation/sourceBeats.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/veracityMetrics.ts
- backend/src/cli/publishForay.ts
- backend/src/generation/gateConfig.ts
- backend/test/tapeExtent.test.ts
- backend/test/sourceBeats.test.ts
- backend/test/veracityMetrics.test.ts
- backend/test/runPipelineCheckpoint.test.ts

**New files:**

- none

**Acceptance:**

- tapeExtent.test.ts: start on a turn and end on claim-only gives startBoundary 'turn', endBoundary 'claim-only', and boundary 'claim-only' (unchanged).
- transcriptArchiveLookup test: growth that moves only the end leaves startBoundary intact.
- sourceBeats.test.ts: refuse mode rejects a claim-only opening with 'claim-only-open' and the next candidate wins. Allow mode is deep-equal to today.
- veracityMetrics.test.ts: computeCleanCuts on mixed rows, unknown handling, and the gate in report vs enforce.
- The no-fetch structural test passes. A pre-card checkpoint resumes, and a checkpoint carrying the new gate round-trips.

**Tests.** Vitest additions to tapeExtent.test.ts, sourceBeats.test.ts, veracityMetrics.test.ts and runPipelineCheckpoint.test.ts.

**Flag.** FORAY_CLAIM_ONLY_OPENING=refuse (default allow) and FORAY_CLEAN_CUT_GATE=enforce (default report). The metric is always computed.

**Live step.** Read cleanCutRate on the next real run to learn the baseline before enforcing.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** On bodies without speaker labels, 'turn' never fires, and 'sentence' needs a pause of 0.7 s or more or a cue of 30 s or more (tapeExtent.ts:86-99). Refusing claim-only openings may cost tape on caption-only bodies, so measure first. The rule stays sourcing-only and measured in the checker (D5 style), so sourceBeats and check-forays do not drift (sourceBeats.ts:31-51).

### Wave 30

#### GV-110 · Bench-only writer exchange recorder (request, reply, verdict per act and round)

- **From:** W7-09
- **Wave:** 30 · **Size:** M · **Depends on:** GV-55, GV-62
- **Covers:** R2-17

**Goal.** No act-level training or calibration example can exist without the writer's INPUT. Published Forays keep only scripts (RQ-04), and nothing records ActWriteRequest today. For bench prompts only, record every writer request and reply plus the verifier verdict per act and round. This feeds fine-tune counting (W7-10), critic calibration (W7-08) and the dead replayMechanicalGate (writeAct.ts:567).

**Design.**

backend/src/generation/writeAct.ts:
- WriteActOptions gains onExchange?: (x: WriterExchange) => void, with WriterExchange = {actTitle, round, request: ActWriteRequest, reply: ActWriteResult, mechanical: string[], verdict?: ActVerifyResult}.
- It is called once per round after the verify step (writeAct.ts:396-475). It is a callback only, with no fs.
Wiring:
- writeNarration passes the callback through WriteNarrationOptions.
- RunPipelineDeps (runPipeline.ts:115) gains onWriterExchange. At the narrate:i stage (:1610) runPipeline wraps it as (x) => deps.onWriterExchange?.({...x, actIndex: i}), because writeNarration is called per act.
cli/generateForays.ts:
- --record-exchanges appends one line per exchange to <out>/<checkpointKey>.exchanges.jsonl, adding generator = describeStageAssignments().writer (W7-02).
- The flag is refused unless every spec has bench: true (W7-03) AND the resolved --out lies under a data-local directory. The lines carry transcript window text, which never goes in git.
- ReportEntry gains exchangesFile?.
Reader: tools/generation-bench/exchanges.mjs (listExchanges, readExchange). A backend test feeds a recorded exchange through replayMechanicalGate, which gives the dead helper a caller.

**Files edited:**

- backend/src/generation/writeAct.ts
- backend/src/generation/writeNarration.ts
- backend/src/generation/runPipeline.ts
- backend/src/cli/generateForays.ts
- test/suite-integrity.test.js

**New files:**

- backend/test/writerExchanges.test.ts
- tools/generation-bench/exchanges.mjs
- tools/generation-bench/exchanges.test.mjs

**Acceptance:**

- Without the flag: no callback runs, no file is written, output is identical
- With the flag and bench prompts under data-local: one JSONL line per act per round, carrying the real actIndex, the request, the reply, the mechanical issues and the verdict
- With any non-bench prompt, or an --out outside data-local: the CLI refuses before any model call
- promptNoPersistence.test.ts stays green; only src/cli writes
- A recorded exchange replays through replayMechanicalGate with the same mechanical issues

**Tests.** backend: npx vitest run test/writerExchanges.test.ts runs runForayPipeline with stub builders and a capturing onWriterExchange (a multi-act spine, to prove actIndex), plus the CLI refusal cases. tools: node --test tools/generation-bench/exchanges.test.mjs on synthetic JSONL with short synthetic windows. Add floors.

**Flag.** --record-exchanges (opt-in CLI flag; bench prompts only, data-local only)

**Live step.** Turn it on for every W7-04 arm run.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Disk: about 10k tokens per request x rounds x acts x 50 prompts is a few hundred MB per experiment set in data-local, which is acceptable. The narration workstream (R2-10, R2-13) and R1-06 also edit writeAct.ts's round loop, so the hook must follow those changes; it sits at the end of the round to keep conflicts small. Governed path.

#### GV-111 · Snap clip edges to real pauses from word timestamps, with anchors re-minted from the words

- **From:** W5-14b
- **Wave:** 30 · **Size:** M · **Depends on:** GV-56, GV-109
- **Covers:** R2-05, MQ-06

**Goal.** Move clip edges from caption-cue timing (median cue 16.6 s) to real silences of 0.3 s or more. R2 called this the biggest 'sounds professional' lever, and it costs nothing at request time once bodies carry words.

**Design.**

1. transcriptArchiveLookup.ts:
   - TranscriptCue (:233) gains optional words?: {text, start, end}[].
   - readCues (:549) keeps a word array only when it is monotonic, lies within the cue span ±0.5 s, and joins to the cue text after canonicalisation. Otherwise it is dropped.
   - Cue text is unchanged, so TRANSCRIPT_TEXT_INDEX_VERSION does not move.
2. New pure pauseSnap.ts:
   - pausesNear(cues, cueIndex, side, {minGapSec:0.3, maxShiftSec:4}).
   - snapEdge(...) returns {sec, cueIndex, wordIndex, kind}, preferring a pause after terminal punctuation (kind 'sentence').
3. cutWindowToSegment (:1184) gains option snapToPauses (new key FORAY_PAUSE_SNAP = off|on, default off, passed from sourceBeats). When the edge cues carry words:
   - startSec and endSec move to the snapped word boundary;
   - anchors are minted with the existing mintStartAnchor and mintEndAnchor (:1363, :1376) from the word stream that starts or ends at the snapped word, so anchors stay verbatim tape words and keep canonical() parity (anchorTextParity.test.ts);
   - a snapped edge after terminal punctuation upgrades that edge's kind (W5-13) to 'sentence'.
4. Memory: the FileTranscriptCueProvider LRU (:307) holds 256 parsed bodies. Words multiply body size several times, so count words in the LRU budget (or cap the entry count at 64 when words are present).

**Files edited:**

- backend/src/generation/transcriptArchiveLookup.ts
- backend/src/generation/sourceBeats.ts
- backend/src/generation/gateConfig.ts
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/pauseSnap.ts
- backend/test/pauseSnap.test.ts

**Acceptance:**

- pauseSnap.test.ts: synthetic words snap to the 0.42 s gap after 'world.' and not to a 0.1 s gap. maxShiftSec is respected, and cues without words leave the edge unchanged.
- With snapping and words, cutWindowToSegment returns anchors that are verbatim word runs starting at the snapped word, and anchorTextParity.test.ts stays green.
- With no words or the flag off, transcriptArchiveLookup, sourceBeats and tapeExtent tests are unchanged.
- The no-fetch structural test still passes.

**Tests.** Vitest pauseSnap.test.ts and cut tests in the transcriptArchiveLookup and sourceBeats suites.

**Flag.** FORAY_PAUSE_SNAP=on (default off). It is also inert on bodies without words, which today is all of them.

**Live step.** (1) The transcript-farm repo enables whisper word_timestamps and emits cues[].words. (2) Sample about 20 of the 7,531 legacy whisper JSONs at the R2 bucket root to see whether they already carry words. (3) Re-normalize one show and compare cleanCutRate with snapping on and off.

**Founder need.** founder-approved label (orchestrator applies); plus an R2 read key for the legacy-JSON sample (#1163).

**Risk.** Whisper word timing drifts on long files; maxShiftSec bounds the snap. Play-time anchor resolution (R2-06) must use the same word-aware text. Publisher VTT bodies never carry words, so the gain is limited to farm ASR bodies.

### Wave 31

#### GV-112 · Research map: add windows from the topic node's precomputed shortlist

- **From:** W3-25
- **Wave:** 31 · **Size:** S · **Depends on:** GV-48, GV-87, GV-95
- **Covers:** QK-22, R1-09

**Goal.** Offer the spine windows found semantically from the node shortlist (W3-09), which raises seeded beats. Clip count follows seeds (QK-22).

**Design.**

INTEGRATION NOTE: generationFlags.ts is created by GV-15; this card adds its reader there.

- buildResearchShape gains an optional shortlist dependency: (node, queryText, limit) => Promise<ShortlistPassage[]>, wired from RemoteRetrieval to GET /v1/shortlist.
- Before the subtopic loop it prefetches, per seed, the shortlist passages ranked for subtopicQueryText(seed) (W3-11's helper).
- tapeWindowsFor merges them as extra candidates:
  - Each passage maps to its archive entry.
  - It is dropped if span_implausible, if it ends past feed_duration_sec (the F-87 rule at :346), if it is shorter than RESEARCH_TAPE_WINDOW_MIN_SEC, or if its episode is in usedEpisodes.
  - text = trimToSentence(passage.text), cut to RESEARCH_TAPE_WINDOW_MAX_CHARS (600).
  - Shortlist scores are on another scale, so these windows are not score-compared. They are interleaved after the BM25 windows, at most 2 per subtopic, within the same 6 cap and the W3-13 quota.
  - They carry the optional origin 'shortlist' on ResearchTapeWindow.
- Because these windows are quoted into the spine prompt, F-72's premise holds and no sourcing floor changes.
- Enabled only when retrieval is configured and FORAY_RESEARCH_SHORTLIST=1.

**Files edited:**

- backend/src/generation/researchShape.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/retrievalClient.ts
- backend/src/types/research.ts
- backend/src/generation/generationFlags.ts
- backend/test/researchShape.test.ts
- test/suite-integrity.test.js
- backend/test/retrievalClient.test.ts

**New files:**

- none

**Acceptance:**

- Shortlist windows appear only with the dependency and the flag, at most 2 per subtopic.
- They respect usedEpisodes, the duration and implausible-span checks, and the 600-character cap.
- They are deterministic.
- With the flag unset, output is byte-identical.

**Tests.** vitest test/researchShape.test.ts with a stub shortlist function returning synthetic passages over the synthetic two-show archive. A retrievalClient.test.ts case covers the GET /v1/shortlist mapping.

**Flag.** FORAY_RESEARCH_SHORTLIST=1 (default off). It also requires FORAY_RETRIEVAL_URL.

**Live step.** Replay 5 golden prompts with the shortlist on and off, comparing seeded-beat share (postSeedSpine) and unseeded yield (W3-15).

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed. Semantically found windows may be on-node but off-claim. The seed floor and sourcing floors still decide, so the worst case is unused prompt text.

#### GV-113 · Cut unsupported sentences instead of rewriting; only an orphaned beat earns one single-seam edit

- **From:** W5-11
- **Wave:** 31 · **Size:** M · **Depends on:** GV-51, GV-108
- **Covers:** R2-10, MQ-02, MQ-11, GP-26

**Goal.** Make R2-10's policy explicit. On the timed path, code removes an unsupported sentence at no cost. A rewrite round (a writer call plus a 9-11k re-read, GP-05) is spent only when a cut leaves a beat uncarried. QK-05's companion metric becomes 'sentences surviving'.

**Design.**

writeAct.ts judge() (:977), when gates.sentencePolicy === 'cut' (new key FORAY_UNSUPPORTED_SENTENCE_POLICY = rewrite|cut, default rewrite) and verdict.sentences is present:
1. When some, but not all, statement sentences are 'unsupported':
   - Build the trimmed script from the surviving sentences, keeping their original text.
   - Re-run validateSeam (:865) through a new options param {charBandOverride:[0, band[1]]}. That relaxes seamBand's floor (actSeams.ts:243), which would otherwise trip out-of-budget. Every other rule still runs: Q-02/Q-09 naming, restate, Q-08 leaks, banned copy, the voice and specifics checks when enabled.
   - Prune draft.claims not in any surviving sentence's restsOn.
   - Record cutSentences (the NarratedBeat field from W5-12b) and cut round.
2. Beat coverage by code (MQ-11). A beat whose carriedBySentence pointed at a cut sentence is re-opened. Without attribution, it is re-opened when scriptIsAboutPurpose(trimmed, claim) (StubNarrationVerifierBuilder.ts:127) is false. Any orphaned beat re-opens the seam for exactly ONE more writer round with a note naming the beat. After that the trimmed text stands and the beat's fate follows W5-12b.
3. When every statement is unsupported, or the trimmed seam fails validation, the existing failure path applies.
4. New computeSentencesSurviving(writtenActs) = {surviving, cut, rate}, computed from the pages' cutSentences and therefore resume-safe. VeracityMetrics gains sentencesSurvivingRate and sentencesCut beside the first-attempt rates (:249).

**Files edited:**

- backend/src/generation/writeAct.ts
- backend/src/generation/veracityMetrics.ts
- backend/src/generation/gateConfig.ts
- test/suite-integrity.test.js
- backend/test/veracityMetrics.test.ts
- backend/test/actNarration.test.ts

**New files:**

- backend/test/sentenceCut.test.ts

**Acceptance:**

- A fake verifier marks sentence 2 of 3 unsupported. Round 1 confirms the trimmed seam, the writer is called exactly once, and cutSentences holds the removed sentence.
- A cut that orphans a beat triggers exactly one more writer round, never a third.
- A trimmed seam under seamBand's floor passes validation; a trimmed full-intro seam that loses the show name is refused by Q-09 as before.
- toForayItems output never carries cutSentences (assertNoInternalFieldsLeaked).
- Rewrite policy: actNarration.test.ts is unchanged.
- BACKEND_FLOORS in test/suite-integrity.test.js has an entry for sentenceCut.test.ts (added in this PR, so 'every backend suite on disk is covered by a floor' stays green).

**Tests.** Vitest sentenceCut.test.ts (the actNarration wrapped-builder pattern with W5-09's stub emitSentences mode) and a sentencesSurviving case in veracityMetrics.test.ts.

**Flag.** FORAY_UNSUPPORTED_SENTENCE_POLICY=cut. Default rewrite.

**Live step.** Run the Jev verifier with cut on two golden prompts. Compare retryRounds, writer calls per act and sentencesSurvivingRate against the rewrite policy.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** A cut can leave a dangling reference ('That is why...' with its antecedent gone). Count pronoun-led first sentences after a cut as a warning. Cutting shortens narration and raises tape share. assignSeamMode (actSeams.ts:216) must use the trimmed sources. This partly addresses GP-04's rounds; the timed-path round budget belongs to the writer workstream.

#### GV-114 · Act-level training-example ledger and fine-tune readiness count (no training)

- **From:** W7-10
- **Wave:** 31 · **Size:** S · **Depends on:** GV-35, GV-110
- **Covers:** R2-17

**Goal.** Make 'fine-tuning last, about 500 act-level examples needed' a tracked number. The 157 committed items are 16 historic acts with no inputs; they stay reference only. The ledger joins recorded exchanges to labels from founder verdicts (R2-19) and pairwise wins (W7-04), tags provenance, and exports a chat-format SFT file. Claude-derived rows are excluded until OQ-06 is ruled on.

**Design.**

tools/generation-bench/training-corpus.mjs:
- build: reads data-local/swaps/**/*.exchanges.jsonl (W7-09), the R2-19 review verdicts (data-local/review/verdicts.jsonl, GV-41's foray-review-verdict/1 rows; verdict pass/fail/fix maps to keep/reject/edited) and the swap ledger's per-prompt pairwise winners (W7-01). It emits data-local/training/act-examples.jsonl with rows {exampleId: sha(request+reply), forayKey, actIndex, round, exchangeRef {file, line}, label: keep|reject|edited, labelSource: founder-verdict|pairwise-win|pairwise-loss, generator {impl, model}, claudeDerived, finalRound}. Only the final-round reply of a verified act can be a positive. Rows whose generator impl is 'anthropic', and all data/forays.json acts, are claudeDerived: true.
- count: prints 'usable act-level examples: N of 500 (non-claude, labelled keep); claude-derived held: M; historic reference acts without inputs: 16', and appends a dated line to the readiness section of model-swaps.md.
- export-sft --out <file>: writes {messages: [{role: 'user', content: prompt rebuilt from the request by an injected prompt builder (the Qwen writer's exported builder in production)}, {role: 'assistant', content: seams JSON}]}. It refuses claudeDerived rows unless --allow-claude-derived is passed; the doc says that flag stays unused until OQ-06 is ruled on.
- No training run and no model call.

**Files edited:**

- docs/curation/model-swaps.md
- test/suite-integrity.test.js

**New files:**

- tools/generation-bench/training-corpus.mjs
- tools/generation-bench/training-corpus.test.mjs

**Acceptance:**

- count over data/forays.json alone reports 0 usable and 16 historic reference acts
- Only final-round, verified, keep-labelled, non-claude exchanges count toward 500
- export-sft refuses claude-derived rows without the override and otherwise writes valid JSONL
- exampleId is stable for identical request and reply
- Suite floor added

**Tests.** node --test tools/generation-bench/training-corpus.test.mjs with synthetic exchanges (short synthetic windows), synthetic verdict rows, a synthetic ledger and an injected fake prompt builder.

**Flag.** none (an offline tool; the claude-derived override refuses by default)

**Live step.** none

**Founder need.** none

**Risk.** At about 4 acts per Foray, 500 keep-labelled examples needs on the order of 150+ reviewed Forays; the count will honestly show fine-tuning is far off. The verdict schema (R2-19) and the exportable Qwen prompt builder come from other workstreams; until then build runs on pairwise labels only and export-sft needs the injected builder.

### Wave 32

#### GV-115 · Sourcing: per-show tape ledger, soft show-diversity order, optional 60% show-share gate

- **From:** W3-14
- **Wave:** 32 · **Size:** M · **Depends on:** GV-15, GV-18, GV-83
- **Covers:** R2-16, QK-21

**Goal.** When two or more shows can supply the topic, keep the largest show at or below 60% of the Foray's tape (R2-16): first as a preference that cannot lose tape, and as a hard rule only if a replay shows it costs little.

**Design.**

INTEGRATION NOTE: generationFlags.ts is created by GV-15; this card adds its reader there.

sourceBeats.ts:
- SourcingState (:616) gains placedSecByShow and showKeyOf: (itemId) => string. showKeyOf is injected through new SourceBeatsOptions.showKeyFor, with a default built from W3-12's showKeyForItem over state.transcriptArchive and the pool.
- placeTape (:1117) updates placedSecByShow on both the fresh and the replacing (merge) branch. It is the single place ledgers move, which keeps its stated invariant. placeTape receives itemId, so the show comes from showKeyOf(itemId).
- New SourceBeatsOptions.showShare: {mode:'order'|'gate', max:0.6, supplyShows}. supplyShows is the number of shows with at least 1 usable row in topicDecision supply byShow (topicSupply.ts:265-276), passed from runPipeline. The rule is inactive when supplyShows < 2.
- 'order': in tier2Candidates (:2188), after seededFirst (the seed stays first), apply showDiversityOrder. When the dominant show's share of placed tape already exceeds max, other-show candidates move ahead with a stable order inside each group. This changes order only, so no beat loses tape it would otherwise get.
- 'gate': placementAllows (:1090) also returns a new DurationGate 'show-share' when (showSec + dur)/(totalSec + dur) > max and placedTapeCount >= 2. It falls through like m4-runtime, is recorded in the trace, and is added to TIER2_GATE_PROGRESS (:2117) and to the types/tapeSourcing.ts gate enum.
- The mode is read at call time from FORAY_SHOW_SHARE / FORAY_SHOW_SHARE_MAX through generationFlags.ts.
- check-forays.mjs is unchanged while the rule stays soft. If 'gate' becomes the default, mirror it as measured-only (D5 style) in a follow-up.

**Files edited:**

- backend/src/generation/sourceBeats.ts
- backend/src/generation/runPipeline.ts
- backend/src/types/tapeSourcing.ts
- backend/src/generation/generationFlags.ts
- backend/test/sourceBeats.test.ts
- backend/test/runPipeline.test.ts
- test/suite-integrity.test.js

**New files:**

- none

**Acceptance:**

- With showShare unset, every existing sourceBeats test passes unchanged.
- In order mode, a two-show fixture tries show B's candidate first once show A exceeds 60%, while the seeded candidate stays first.
- In gate mode, a placement pushing A past 60% after 2 placements is refused with 'show-share' and falls through.
- supplyShows < 2 disables both modes.
- The merge path keeps placedSecByShow consistent (ledger test).

**Tests.** vitest `npx vitest run test/sourceBeats.test.ts` with new describe blocks over a synthetic two-show archive. Also `npx vitest run test/runPipeline.test.ts` for the supplyShows plumbing. Raise the floor (test/sourceBeats.test.ts: 128).

**Flag.** FORAY_SHOW_SHARE=off|order|gate (default off), with FORAY_SHOW_SHARE_MAX (default 0.6).

**Live step.** With W3-15's replay on the founder PC corpus, compare off, order and gate on 10 prompts for MQ-07, tape beats and narration fallbacks. The orchestrator then picks the default.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Governed; sourceBeats holds the Foray-wide ledgers (M3, M4, D2). supplyShows counts digest rows, not mintable episodes (RQ-03), so the second show may be unmintable. The rule stays soft until W3-03's mintability report.

### Wave 33

#### GV-116 · Voice drift alarm: one Jev 'same narrator as the exemplar?' Score per act after narration (report only)

- **From:** W4-12
- **Wave:** 33 · **Size:** S · **Depends on:** GV-20, GV-99, GV-104
- **Covers:** R2-08, GP-24

**Goal.** Flag acts whose narration drifts from the founder-selected exemplar voice, after narration and off the timed path, without gating anything yet.

**Design.**

INTEGRATION NOTE (the drift half of W4-12). voiceDriftScores(writtenActs, exemplars, jev) lives in voiceDrift.ts. It reads the founder-selected exemplars through loadVoiceExemplars (GV-99), so the drift alarm and the writer prefix share one voice reference (W7 cross-need). It runs after the ordered stitch loop, never before first audio, only when a Jev client and selected exemplars exist; otherwise voice.drift is absent, not zero.

--- From W4-12 (items 3 and the 'drift' column of 4) ---
3. The drift alarm is voiceDriftScores(writtenActs, exemplars, jev).
   - Per act, one Jev Score (1-5) on 'Is this narration written by the same narrator as the reference passage?'. The state is the exemplar script plus the act's seam scripts, capped at 4k tokens.
   - runPipeline runs it after the ordered stitch loop, never before first audio, and only when a Jev client and exemplars (W4-11) are configured. Otherwise the field is absent, not zero.
4. tools/generation-bench/run.mjs COLUMNS (:122) gains only 'drift'; the sentence-mean column is GV-104's 'sent mean' and is not duplicated. Absent values print —, and the run.test.mjs floor is raised.

**Files edited:**

- backend/src/generation/veracityMetrics.ts
- backend/src/generation/runPipeline.ts
- tools/generation-bench/run.mjs
- tools/generation-bench/run.test.mjs
- test/suite-integrity.test.js

**New files:**

- backend/src/generation/voiceDrift.ts
- backend/test/voiceDrift.test.ts

**Acceptance:**

- voice.drift is absent without Jev or exemplars, and equals the fake's scores when both are present.
- evaluateVeracityGate verdicts are unchanged on the veracityMetrics.test.ts fixtures.
- run.mjs prints a 'drift' detail column, with — when absent.
- BACKEND_FLOORS in test/suite-integrity.test.js has an entry for voiceDrift.test.ts (added in this PR, so 'every backend suite on disk is covered by a floor' stays green).

**Tests.** backend vitest test/voiceDrift.test.ts with the Jev fake (GV-20); node --test tools/generation-bench/run.test.mjs.

**Flag.** Report-only. Runs only with a Jev client and founder-selected exemplars.

**Live step.** With Jev, score the 14 Sep candidate and golden runs. Set an alarm threshold only after the founder's R2-01 cards say which acts sounded like a different narrator.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** W4-12: It overlaps R2-14's sentence rules. This card reports per seam and never gates; R2-14 owns gating, and the two must converge on one splitter. tools/generation-bench/run.mjs COLUMNS is also edited by the eval workstream and W4-15, so they land serially. Jev noul and score probabilities are not comparable, so only the score is used.

### Wave 34

#### GV-117 · Fast-path assembly: early-item signals, three serial model calls to the first seam, and an offline latency-model check

- **From:** W4-17
- **Wave:** 34 · **Size:** M · **Depends on:** GV-07, GV-123, GV-32, GV-33, GV-38, GV-49, GV-61, GV-67, GV-73, GV-80, GV-84, GV-86, GV-89, GV-98, GV-100, GV-102, GV-106
- **Covers:** R1-01, GP-03, GP-02, GP-05

**Goal.** Wire W4-02 to W4-15 under FORAY_FAST_PATH, so the short tier's critical path is Jev clarity, then spine, then a streamed act-1 writer. Prove the call sequence and the first-audio arithmetic offline.

**Design.**

INTEGRATION NOTE: criticalPath has ONE source, chosen here and in GV-15/GV-123: builder-level spans from callLog.ts instrumentDeps (GV-123), fed to serialCallChain (GV-123). instrumentDeps wraps the RunPipelineDeps builder methods, so ScriptedChatProvider and the Jev fake produce spans offline even though stubs and fakes write no CallRecords; this card is the one that applies instrumentDeps inside runForayPipeline (it already edits runPipeline.ts). A 'model call' in these counts is one builder-method call (a re-ask inside a method stays inside its span); live runs cross-check against the CallRecord-based MT-06 from the bench (GV-17). preludeReadyMs and firstSeamReadyMs sit beside report.delivery (GV-33). The tape-only evidence and no-web researcher come from GV-61 and GV-98.

1. runPipeline.ts, flags.fastPath. The W4-01 flags drive:
   - understandPromptFast (W4-03) with the Jev understander (W4-02);
   - the folded spine (W4-04, W4-05) and the runtime check (W4-14);
   - the per-act driver (W4-07) with frames and sequential order (W4-08);
   - the clip ceiling (W4-15);
   - the streamed writer with seam release (W4-10);
   - the timed round policy (W4-13).
   Evidence and research use the retrieval workstream's R1-05 mode: deps.evidence is a tape-only gatherer, and deps.researcher is a Null or Dossier researcher, so research-shape and act 0's evidence make no model call.
2. New RunPipelineDeps.onEarlyItem?(e: {kind: 'prelude'|'act-introduction'|'seam'; actIndex; seamId?; script; atMs}).
   - 'prelude' fires right after the spine stage, with preludeItem(spine.subject, spine.overview, slots[0].id) (runPipeline.ts:625).
   - 'act-introduction' fires for act 0 when it was folded.
   - 'seam' fires from onSeamChecked.
   These are signals for the delivery workstream, which decides serving behind R2-13 and the QK-24 check. This card serves nothing.
3. The outcome and report gain criticalPath: {preludeReadyMs, firstSeamReadyMs, modelCallsBeforeFirstSeam, serialChainBeforeFirstSeam}.
   - It is computed with criticalPath.ts (GV-123) over callLog.ts's instrumentDeps (GV-123), which this card makes runPipeline apply to its deps when fastPath is on.
   - It does not switch to CallRecords: the builder spans stay the only source, so offline and live numbers are computed the same way.
   - Absent, not zero, when fastPath is off.
4. Offline test backend/test/fastPath.test.ts uses ScriptedChatProvider, the Jev fake and a fake clock. The rate constants are named and taken from the baseline:
   - Jev 0.2 s;
   - spine prefix read 0.3 s, plus about 700 output tokens (450 plan + 120 copy + 100 folded intro/exit) at 91 tok/s;
   - writer act-part prefill of N uncached tokens at the HW-04 prefill rate, plus a 150-token seam-1 line at 22 tok/s.
   Cases:
   (a) Short tier: the serial chain before the first released seam is exactly [clarity:jev, spine, writer:0-stream]. No extractIntent, deepen, research, evidence retrieval or verifier call starts before it.
   (b) Medium: act 0's chain is [clarity, spine, deepen:0, writer:0-stream], and deepen of acts 1+ starts only behind it.
   (c) preludeReadyMs and firstSeamReadyMs equal the sum of the named constants within 1 ms, and the test also asserts firstSeamReadyMs ≤ 23,000. With the constants above, prelude ≈ 8.2 s and first seam ≈ 15 s plus prefill. A sensitivity assertion checks that a change to one rate moves the result by the predicted amount. Labelled a latency MODEL, not a measurement.
5. docs/curation/generation-kpis.md gets a short note on the two new report fields and what 'first audio' means in each.

**Files edited:**

- backend/src/generation/runPipeline.ts
- backend/src/cli/generateForays.ts
- docs/curation/generation-kpis.md
- test/suite-integrity.test.js

**New files:**

- backend/test/fastPath.test.ts

**Acceptance:**

- Test (a): on the short tier, modelCallsBeforeFirstSeam === 3 and serialChainBeforeFirstSeam === 3.
- Test (b): on medium, deepen of acts 1+ does not start before deepen:0 ends, and overlaps act 0's writer on the fake clock.
- Test (c): the latency-model values equal the arithmetic from the named constants, firstSeamReadyMs ≤ 23,000, and the sensitivity assertion holds.
- With FORAY_FAST_PATH unset, every existing pipeline test is unchanged and criticalPath is absent from report rows.
- onEarlyItem 'prelude' fires before any writer call starts.

**Tests.** vitest fastPath.test.ts (call order, serial chain, latency model, early-item ordering) plus the runPipeline.test.ts flag-off regression.

**Flag.** FORAY_FAST_PATH (umbrella, default off) and `generateForays --fast-path`. Nothing is served to a listener by this card.

**Live step.** Run the golden set's 10 listened and 40 scored prompts with FORAY_FAST_PATH=1 against the Spark (LiteLLM) and Jev. Record MT-01 (prelude and first seam), MT-06, MT-11 lead and output tokens per Foray (GP-02: target about 1,650 short), and compare with the 14 Sep baseline. Needs the R1-08/R1-12 routing and priority live steps first.

**Founder need.** founder-approved label (orchestrator applies); plus LiteLLM key and Jev key (#1163), for the live run only.

**Risk.** The prelude is ready at spine time, but its overview is spine prose written before any tape (QK-24), so preludeReadyMs and firstSeamReadyMs are reported separately and R1-16's owner picks the headline. The latency test is a model; only the live step settles the 17-23 s estimate. The fast path puts every critical-path call on one Spark stream, so Foray priority (R1-12) is a precondition for the live target.

### Wave 35

#### GV-118 · Tape publish gate: swap QK-04 (taxonomy family) for MQ-05 (0.9 of clips scoring 4+) behind FORAY_TAPE_GATE, and record the gate verdict on every run

- **From:** W5-06
- **Wave:** 35 · **Size:** S · **Depends on:** GV-15, GV-26, GV-79
- **Covers:** R2-03, QK-20, GP-21, MQ-05, GP-26

**Goal.** Make the publish gate judge what the listener hears. GATE_MIN_TAPE_RELEVANCE = 0.9 (veracityMetrics.ts:980) gates a metric that cannot fail on the live path. Per GP-26, a run should also learn it would fail before anyone tries to publish it.

**Design.**

veracityMetrics.ts:
- Add GATE_MIN_CLIP_ON_SUBJECT = 0.9.
- evaluateVeracityGate (:1019) gains a PURE optional second argument, {tapeGate:'qk04'|'mq05'|'both'} defaulting to 'qk04'. It never reads env itself.
- 'mq05':
  - tape anchors present and clipOnSubjectRate null: fail (unmeasured is failing, the existing convention, :1060-1064);
  - rate below 0.9: fail, listing each clip under 4 with its subject and claim scores, its judge and its runner-up (when W5-05 has recorded one);
  - every scored clip judged 'code': fail with 'clip relevance was not judged', so a proxy can never pass.
- 'both' requires both conditions.
- New gateConfig key tapeGate (FORAY_TAPE_GATE, default qk04).

cli/publishForay.ts:832 reads readGateConfig().tapeGate, passes it, and prints the failure lines.

GP-26 (report the gate on every run), with NO second verdict field:
- GV-26 already computes `gate = evaluateVeracityGate(veracity)` right after buildVeracityMetrics and puts gate {ok, failures} on the generated outcome and the report entry, with publishable = validation.ok && gate.ok. This card only passes {tapeGate} (from the merged gates config, GV-15) into that SAME call in runPipeline.ts and adds tapeGate to `gate`, which becomes {ok, failures, tapeGate}.
- publishable therefore reflects the MQ-05 gate automatically once tapeGate is mq05, and GV-52's full_s and GV-64's MQ-21 (which read only `gate` and `publishable`) can never disagree with a second field. No meta.veracityGate and no report veracityGate are added, so finalizeForay.ts is not edited.
- This is report-only and refuses nothing at generation time.

Docs: in docs/curation/generation-kpis.md and generation-architecture.md, the gate-table row becomes MQ-05, with the flag noted.

**Files edited:**

- backend/src/generation/veracityMetrics.ts
- backend/src/generation/gateConfig.ts
- backend/src/cli/publishForay.ts
- backend/src/generation/runPipeline.ts
- backend/src/cli/generateForays.ts
- docs/curation/generation-kpis.md
- docs/curation/generation-architecture.md
- test/suite-integrity.test.js
- backend/test/veracityMetrics.test.ts
- backend/test/publishForay.test.ts
- backend/test/generateForays.test.ts

**New files:**

- none

**Acceptance:**

- veracityMetrics.test.ts, mq05 mode: 0.89 fails, 0.9 passes, null with anchors fails, no anchors is N/A, all-code scores fail. qk04 mode is unchanged and the existing 48 tests stay green.
- publishForay.test.ts: a candidate failing mq05 is refused without --force, and the failure lines name the off-subject clips.
- After a stub run, the report entry's existing `gate` carries tapeGate, equals evaluateVeracityGate(meta.veracity, {tapeGate}), and no veracityGate field exists anywhere (generateForays.test.ts). With FORAY_TAPE_GATE=mq05 and an off-subject fixture, gate.ok and publishable are both false.

**Tests.** Vitest additions to veracityMetrics.test.ts, publishForay.test.ts and generateForays.test.ts. Raise the BACKEND_FLOORS count for veracityMetrics.test.ts (:3033) to match.

**Flag.** FORAY_TAPE_GATE defaults to qk04. The orchestrator flips it to mq05 once W5-07 shows judge-vs-founder agreement of at least 0.9.

**Live step.** After W5-07's calibration, flip the default and re-evaluate the 14 Sep candidate's meta to confirm it is now refused.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** This changes the semantics of RQ-15's publish gate, so record the switch in the docs. finalizeForay.ts:93 types meta as {veracity} and is left unchanged, because the verdict lives only on GV-26's `gate`. The bench target note at tools/generation-bench/run.mjs:249 names tapeRelevance; the eval workstream adds the MQ-05 column.

### Wave 36

#### GV-119 · Judged walk in sourceBeats: follow the choice order, a refusing score falls through, 'none' becomes narration, the runner-up is logged

- **From:** W5-05
- **Wave:** 36 · **Size:** L · **Depends on:** GV-107
- **Covers:** R1-20, R2-03, MQ-05, QK-20

**Goal.** Replace first-pass-wins with the judged choice while keeping every ledger rule. Windows Jev scores 2 or below on subject or claim are dropped and the walk falls through (R2-03). The winner's window scores and the runner-up are recorded for review.

**Design.**

- SourceBeatsOptions (:287) gains clipVerdicts?: ClipVerdictBook and clipScoreRefuseAtOrBelow?: number (new gate key clipScoreRefuse, default 1, i.e. '2 or less' on the 1-5 card).
- resolveOneBeat (:1220): when the beat has a verdict that is not unavailable, it calls a new judgedResolve. Otherwise today's path runs untouched.
- judgedResolve:
  - Builds one ordered list from verdict.ranked across the seed window, pool rows and search windows. This is the explicit decision R1-20 asked for: none bypass the judge. Keys the judge never saw are appended last in today's order, and only when floorCleared.
  - If noneP beats every option, the beat is narration with diagnosis outcome 'judge:none'.
  - Per key:
    - a score at or below the refuse level on subject or claim records gate 'judge-refused' and continues;
    - a pool key goes through a new tryTier1Segment(segment, state), refactored out of :1295-1323 (tier1IsUsable, duration and M3 vetoes, placeTape), so tier-1 placement stays one implementation;
    - seed and search keys go through walk.run([candidate], mode) (:1437), which keeps every gate including the F-96 merge. A new run() option admitByJudge skips only the lexical floor (:1528) for a key whose window scores are both >= 3.
- Type and schema updates (all must land together, or resume breaks):
  - types/tapeSourcing.ts: Tier2Gate (:464) and Tier1Gate (:421) add 'judge-refused'.
  - SourcingTrace's outcome gains 'judge:none'.
  - TapeRelevanceInput gains judge?: {choiceP, windowScores, runnerUp?: {key, itemId, p, windowScores?}}. This is NOT clipScores: the judged window is pre-extension, so W5-03 still scores the placed span.
  - runPipeline.ts: TIER2_GATE_SCHEMA (:715-731) and the tier-1 gate enum in SourcingTraceSchema add 'judge-refused'; the SourcingTraceSchema outcome enum adds 'judge:none'; TapeRelevanceInputSchema adds the optional judge field.
  - TIER2_GATE_PROGRESS (:2117) ranks 'judge-refused' between 'window-overlap' and 'no-anchor'.
- summarizeSourcing (:569), topReasonFor (:606) and narrationReasonFor (:2344) print judge refusals.

**Files edited:**

- backend/src/generation/sourceBeats.ts
- backend/src/types/tapeSourcing.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/segmentPoolLookup.ts
- backend/src/generation/gateConfig.ts
- test/suite-integrity.test.js
- backend/test/runPipeline.test.ts
- backend/test/runPipelineCheckpoint.test.ts

**New files:**

- backend/test/judgedSourcing.test.ts

**Acceptance:**

- With no clipVerdicts, every existing sourceBeats, mintDedupe, pastDuration and itemIdCollision test passes unchanged, and three representative fixtures give deep-equal SourceBeatsResult.
- When the choice ranks the second tier-2 candidate first, it wins and runnerUp names the other.
- A winner window scored subject 1 falls through, and the trace shows 'judge-refused'.
- When noneP is highest, the beat is narration with outcome 'judge:none'.
- An M3 or M4 refusal of the judged winner still falls through to the next key.
- An unavailable verdict reproduces the lexical path exactly.
- A checkpoint containing 'judge-refused' gates and a 'judge:none' trace round-trips through runPipelineCheckpoint resume.

**Tests.** Vitest judgedSourcing.test.ts with handcrafted ClipVerdictBooks over synthetic cue providers; an enforce-mode case in runPipeline.test.ts; a round-trip case in runPipelineCheckpoint.test.ts.

**Flag.** Active only when FORAY_CLIP_JUDGE=enforce, which makes W5-04 produce the book. Otherwise clipVerdicts is undefined.

**Live step.** After W5-07 calibration, run the germ-theory prompt and two golden prompts in enforce mode. Compare clip count, tape share (MQ-08) and clipOnSubjectRate against shadow mode.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Tier2Walk is the most delicate code in the repo (F-70, F-84, F-96, F-98 ledger semantics). Touch only ordering and admission, keep acceptCandidate/placeTape as the single acceptance path, and keep the no-verdict path byte-identical. The judge scores the 30-180 s window, but the played clip is the extended thought (up to 30 min), so a good window can grow into off-subject tape. W5-03's placed-span score is the check, and it must stay on. Refusals lower tape share (watch MQ-08 against RQ-07). A wrong 'none' threshold can strip tape, so enable enforce only after calibration.

### Wave 37

#### GV-120 · Attribution check (MQ-03): the person an introduction names must be speaking in the clip window

- **From:** W5-15
- **Wave:** 37 · **Size:** M · **Depends on:** GV-15, GV-34
- **Covers:** R2-11, QK-24, MQ-03

**Goal.** Close the real half of QK-24. writeAct.ts:912-951 already checks that a full intro names the show or an episode-title person, but nothing checks that the named person is the one speaking. An intro can name the host while the guest talks.

**Design.**

1. gatherEvidence.ts:
   - The gatherer-side EvidenceDoc interface (:95, which extends HeldEvidenceDoc) gains speakers?: {inClip: string[], inEpisode: string[]}: distinct cue.speaker labels (transcriptArchiveLookup.ts:233) over the clip span and the whole body, with generic labels dropped.
   - It is set in tapeEvidenceFor (:489).
   - The strict EvidenceDocSchema (types/narration.ts:206) that rides on NarratedBeat is NOT widened, so speakers never persist onto pages.
2. actSeams.ts:
   - isGenericSpeakerLabel(label) matches /^(speaker|spk|presenter|host|guest|interviewer|narrator|unknown)\b|^speaker[_ ]?\d+$/i ('Presenter' is the Being an Engineer case).
   - introSpeakerVerdict(script, clip) returns {verdict:'match'|'mismatch'|'unknowable', named, speakers}, using W5-10's extractNames.
     - match: a named token equals a token of 4 or more letters of an inClip speaker.
     - mismatch: the name belongs only to inEpisode speakers who are absent from the clip.
     - unknowable: otherwise.
3. NarrationWriterBuilder.ts ClipBrief (:74) gains speakers?. writeAct.ts step 2 (:343-378) fills it from the window doc's speakers.
4. writeAct.ts validateSeam (:912-951), for seams that introduce a clip with intro 'full' or 'light':
   - compute the verdict;
   - with gates.attribution === 'enforce' (new key FORAY_ATTRIBUTION_CHECK = off|report|enforce, default report), a mismatch is a mechanical issue: 'the introduction names X, who does not speak in this clip (heard: Y); name who is speaking'.
   - Tallies go into NarrationWriteStats.attribution.
5. VeracityMetrics gains attributionAccuracy = match/(match+mismatch), null when nothing was checkable, plus the counts. Because NarrationWriteStats is not checkpointed, the field is null whenever any narrate:<i> stage resumed (StageTiming.resumed), never a partial count.

**Files edited:**

- backend/src/generation/gatherEvidence.ts
- backend/src/generation/actSeams.ts
- backend/src/generation/NarrationWriterBuilder.ts
- backend/src/generation/writeAct.ts
- backend/src/generation/writeNarration.ts
- backend/src/generation/veracityMetrics.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/gateConfig.ts
- test/suite-integrity.test.js
- backend/test/gatherEvidence.test.ts
- backend/test/actNarration.test.ts

**New files:**

- backend/test/attribution.test.ts

**Acceptance:**

- attribution.test.ts:
- naming the host while only the guest speaks in the window gives mismatch;
- naming the guest gives match;
- 'Presenter' or 'SPEAKER_01' labels give unknowable;
- naming the show only gives unknowable.
- gatherEvidence.test.ts: speakers are extracted with generic labels dropped, and window text is byte-identical (the pins at :147-181 hold).
- actNarration.test.ts: enforce re-asks a mismatching intro, report only counts it, and attributionAccuracy reaches veracity. A run with a resumed narrate stage reports null.

**Tests.** Vitest attribution.test.ts plus additions to gatherEvidence.test.ts and actNarration.test.ts, using synthetic speaker-labelled cues.

**Flag.** FORAY_ATTRIBUTION_CHECK defaults to report; enforce is opt-in.

**Live step.** Run report mode on a Being an Engineer run and a Practical AI run. Record the unknowable share, which shows how much of the corpus can be checked at all.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Coverage is limited to diarised bodies, and many speaker fields are null, so MQ-03 will often be null; report the checkable share beside it. The writer prompt must print ClipBrief.speakers or the writer cannot comply in enforce mode (writer-workstream prompt change).

### Wave 38

#### GV-121 · Verify act introductions, exits and the prelude overview sentence by sentence against held sources

- **From:** W5-16
- **Wave:** 38 · **Size:** M · **Depends on:** GV-15, GV-27, GV-34
- **Covers:** QK-24, GP-23

**Goal.** Close the narration that is never verified. Deepen writes act intros and exits before any tape is sourced (AnthropicDeepenActBuilder.ts:205-209), and they are emitted unverified at stitchForay.ts:189-209. The spine's overview reaches item 0 through preludeItem (runPipeline.ts:625). In a Foray made in 30 s these are among the first words heard.

**Design.**

- New frameVerify.ts:
  - verifyFrameText(text, sources: SupportSource[], judge: SentenceSupportJudge, {threshold, mode}) returns {kept, removed:[{sentence, reason}], checked}. It splits with splitSpokenSentences, exempts non-statements (isStatementSentence), and judges each statement through candidateSourcesFor, the judge (p >= threshold) and unsupportedSpecifics (W5-10).
  - frameSourcesForAct(written: WrittenAct) returns every page's held evidence (NarratedBeat.evidence) plus the act's verified page scripts as kind 'page'.
  - overviewSources(sourced, evidence) returns every sourced clip's tape window from the evidence gatherer (a memo hit after the prefetch at runPipeline.ts:1401) plus act 0's sources.
- stitchForay.ts:
  - ForayStitcher options gain verifyFrame?: (text, {kind:'introduction'|'exit', actIndex, written}) => Promise<string>.
  - It is called in stitchNextAct (:154) after smoothActIntroduction and before items are built (:185-209).
  - An empty result omits that item. stitch:<i> is checkpointed, so a resumed act keeps its verified frame.
- runPipeline.ts:
  - Supplies verifyFrame when gates.frameVerify !== 'off' (new key FORAY_FRAME_VERIFY = off|report|cut, default off).
  - Verifies spine.overview in a checkpointed stage('frame:overview'). The stage STARTS as soon as evidence is prefetched and runs concurrently with narration; it is awaited at act 0's onActReady. The partial and the whole Foray therefore use the same verified text at both preludeItem call sites (:1497, :1710), and a resume never re-pays.
  - 'report' keeps the text and counts; 'cut' removes unsupported sentences.
  - The judge is W5-08's Jev judge when a key exists, else CodeOverlapSupportJudge.
- VeracityMetrics gains frameSentences {checked, unsupported, removed, details}. It is derived from the frame stage outputs, so it survives a resume.

**Files edited:**

- backend/src/generation/stitchForay.ts
- backend/src/generation/runPipeline.ts
- backend/src/generation/veracityMetrics.ts
- backend/src/generation/gateConfig.ts
- test/suite-integrity.test.js
- backend/test/runPipeline.test.ts
- backend/test/runPipelineCheckpoint.test.ts
- backend/test/stitchForay.test.ts

**New files:**

- backend/src/generation/frameVerify.ts
- backend/test/frameVerify.test.ts

**Acceptance:**

- frameVerify.test.ts: a fake judge marks one exit sentence unsupported. Cut mode removes it and keeps the rest verbatim; report mode leaves the text unchanged and counts it.
- stitchForay.test.ts: an introduction verified down to '' omits the act-introduction item, and coverage still validates.
- runPipeline.test.ts, cut mode: the prelude item excludes the removed overview sentence on both the partial and the final candidate, the disclosure text is kept, and preludeItem tolerates an empty overview.
- A resumed run with frame:overview banked makes zero judge calls for it.
- Default 'off' is byte-identical.

**Tests.** Vitest frameVerify.test.ts plus additions to stitchForay.test.ts, runPipeline.test.ts and runPipelineCheckpoint.test.ts, using a fake SentenceSupportJudge.

**Flag.** FORAY_FRAME_VERIFY=report or cut. Default off.

**Live step.** Run report mode on two golden prompts with the Jev judge. If more than about 30% of frame sentences fail (likely, since they are written before tape), escalate the structural fix: have the writer write intros and exits as seams (writer workstream, QK-26), rather than enabling cut.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** Frames are planning prose written before sourcing, so many sentences may be unsupported by construction, and cut mode could gut them. Start in report mode. The act-0 introduction check (about 0.5 s) sits before act 0's partial. On R1-04's per-act path it must overlap with act 0 writing, not follow it.

### Wave 39

#### GV-122 · Mint clip anchors by distinctiveness: never a span that repeats in the episode (flagged)

- **From:** W6-13
- **Wave:** 39 · **Size:** S · **Depends on:** GV-15, GV-18
- **Covers:** R2-06

**Goal.** Make each clip edge's anchor phrase locate exactly one moment, so it survives an ad shift. Near the boundary, pick the 4-8-word span with the highest episode-idf sum, and reject any span that occurs twice in the episode.

**Design.**

Today:
- mintStartAnchor and mintEndAnchor (transcriptArchiveLookup.ts:1363, :1376) pick the span with the most content words within ANCHOR_SEARCH_SPAN, taking the earliest on a tie.
- They use no idf and no uniqueness check.
- They are called only from startAnchorFor and endAnchorFor (:1325, :1334) inside cutWindowToSegment (:1184). cutWindowToSegment builds a fresh CueIndex over the WHOLE episode's cues on every call (indexCues, :1190).

1. Add `anchorStats(cues)`, cached in a module WeakMap keyed by the cues array. The LRU in FileTranscriptCueProvider returns the same array per episode. It holds:
   - tokens: the episode's canonical word stream;
   - cueDf: Map<term, count> over tokenizeForSourcing per cue;
   - N: the cue count.
2. Change the signatures to `mintStartAnchor(words, stats?)` and `mintEndAnchor(words, stats?)`. With stats:
   - score = the sum over distinct content tokens of ln(1 + N/df);
   - reject any candidate whose word sequence occurs 2 or more times in stats.tokens;
   - if nothing in the span is unique, widen the search to 2 x ANCHOR_SEARCH_SPAN;
   - if still nothing, fall back to the legacy pick and mark it non-unique.
   Without stats, behaviour is exactly as today.
3. MIN/MAX_ANCHOR_WORDS (4/8) and ANCHOR_MIN_CONTENT_WORDS stay. ADR-0007's 8-12 versus 4-8 is not changed here.
4. TapeSpan (transcriptArchiveLookup.ts:1118) gains an optional `anchorUnique?: {start, end}`. SourceBeatsResult gains `nonUniqueAnchors: number`.
5. The switch is FORAY_ANCHOR_MINT=legacy|distinct (default legacy), read at call time through generationFlags.readEnumFlag (GV-15; decision 5), not config/env.ts:
   - CutWindowOptions gets `anchorMint?: 'legacy'|'distinct'`;
   - SourceBeatsOptions carries it to the two call sites (sourceBeats.ts:1878, :2078); runPipeline resolves it once per run from the flag;
   - generateForays.ts keeps `--anchor-mint` as an override of the flag and passes it through runPipeline options.
6. Anchors stay consecutive canonical words, which preserves merge-segments canonical() parity (anchorTextParity.test.ts).

**Files edited:**

- backend/src/generation/transcriptArchiveLookup.ts
- backend/src/generation/sourceBeats.ts
- backend/src/generation/runPipeline.ts
- backend/src/cli/generateForays.ts
- test/suite-integrity.test.js

**New files:**

- backend/test/anchorMint.test.ts

**Acceptance:**

- In distinct mode, a boundary whose best legacy span ('and so you know what we') repeats elsewhere in the synthetic episode gets a unique span carrying a rare name instead.
- No distinct-mode anchor occurs twice in its episode unless anchorUnique is false and the anchor is counted in nonUniqueAnchors.
- Legacy-mode output is byte-identical to today on the existing sourceBeats fixtures.
- FORAY_ANCHOR_MINT=distinct selects distinct mode, a malformed value throws naming only the variable, and --anchor-mint overrides the variable.
- Every minted anchor is still a whole-word subsequence of its cue text under canonical().

**Tests.** - anchorMint.test.ts (vitest, synthetic cues): idf preference, repeat rejection, widening, fallback marking, and the legacy pin.
- Also run anchorTextParity.test.ts and sourceBeats.test.ts, one at a time.
- Add the floor.

**Flag.** FORAY_ANCHOR_MINT (default legacy), with `generateForays --anchor-mint` as a per-run override.

**Live step.** Replay sourcing on the founder PC corpus under both modes and compare W6-14's resolve rate before flipping the default.

**Founder need.** founder-approved label (orchestrator applies)

**Risk.** - Governed path.
- sourceBeats.ts is being refactored by the retrieval workstream (R1-20 Tier2Walk). Keep this edit to passing the option through, and rebase onto whichever lands first.
- Rarer spans may be more fragile to on-device ASR errors, so keep the 8-word cap.
- Episode-local idf deliberately differs from the per-query idf, because the locate step searches inside one episode.

### Gated backlog

Cards that cannot merge on code alone. They are not in the wave table and nothing depends on them; each enters a wave only when its gate is met, placed after the last scheduled card that edits any of its files, and the orchestrator re-runs the per-wave collision check then. Their wave field reads 'gated' (0 in the machine summary).

| Card | Gate | Coverage kept elsewhere |
|---|---|---|
| GV-77 | GV-58's GB10 bench posted on #862 shows a torch-cuda win | R1-13 by GV-11, GV-22, GV-58, GV-71, GV-74 |
| GV-96 | The founder's #1163 confirmation, after one golden-set listen of the all-local pipeline | HW-12 by GV-68 (enforcement) plus GV-13, GV-19, GV-25, GV-31, GV-37, GV-40, GV-55 |

#### GV-77 · Optional PyTorch-CUDA render backend as a separate render profile (only if #862 shows a win)

- **From:** W6-10
- **Wave:** gated · **Size:** M · **Depends on:** GV-22, GV-58, GV-108
- **Covers:** R1-13

**Goal.** If the GB10 benchmark shows Kokoro on PyTorch CUDA rendering several times faster than real time with no NaN, add it as a second committed profile so seam 1 renders in under a second. ONNX CPU stays the default until the founder hears the result.

**Design.**

GATED BACKLOG (not in the wave table): this card enters a wave only when GV-58's GB10 bench is posted on #862 AND shows a torch-cuda win (several times faster than real time, no NaN). If the bench shows no win, close the card as obsolete. It edits tools/foray/check-forays.test.mjs, which GV-108 (wave 28) also edits, so it is placed after GV-108 in a wave with no other check-forays or render-foray editor; the orchestrator re-runs the per-wave collision check when it places it. Nothing depends on this card; R1-13 stays covered by GV-11, GV-22, GV-58, GV-71 and GV-74.

1. New tools/narration/render-profile-torch-cuda.json with a NEW id, kokoro-torch-cuda-aac64-v1. The audio bytes differ, and key_material hashes the profile id and the render block.
2. render-foray.py gains `--profile PATH` and `--backend ort-cpu|torch-cuda`. TorchBackend is ported from bench-narration.py (:342; TORCH_REPO/TORCH_REVISION pins :117-118) behind the same chunk_problem and length-ratio rejects.
3. stamp-narration.mjs, upload-narration.mjs collectUploads and check-forays accept a committed profile LIST instead of one id.
   - upload-narration.mjs is GOVERNED and needs the founder-approved label.
   - The audio_url key check becomes n/<profile>/<voice>/<sha>.m4a for any committed profile.
4. The worker (W6-06) takes --profile.

**Files edited:**

- tools/narration/render-foray.py
- tools/narration/stamp-narration.mjs
- tools/narration/upload-narration.mjs
- tools/foray/check-forays.mjs
- tools/narration/render-foray.test.mjs
- tools/narration/stamp-narration.test.mjs
- tools/narration/upload-narration.test.mjs
- tools/foray/check-forays.test.mjs
- test/suite-integrity.test.js

**New files:**

- tools/narration/render-profile-torch-cuda.json

**Acceptance:**

- Keys under the torch profile never collide with the fp32 ONNX profile's keys.
- stamp, upload and check-forays accept both committed profiles and refuse an uncommitted one.
- The default profile and every existing key are unchanged.

**Tests.** Pure-half tests for profile selection, the key prefix, and the stamp/upload/check profile list. The torch path itself runs only live.

**Flag.** --profile is opt-in. The default stays kokoro-fp32-aac64-v1.

**Live step.** Render the same draft under both profiles on the Spark GPU and measure the realtime factor.

**Founder need.** founder-approved label (orchestrator applies; tools/narration/upload-narration.mjs is an exact DENIED_PREFIXES path); plus an ear A/B (a car listen) of torch-cuda against ONNX fp32 renders before the default profile is switched.

**Risk.** - A profile fork re-keys all audio and means two caches to keep.
- The upload change touches a governed path.
- The PyTorch path on GB10 is unmeasured.

#### GV-96 · Retire the legacy Anthropic generation builders once the local path is validated

- **From:** W2-17
- **Wave:** gated · **Size:** M · **Depends on:** GV-47, GV-50, GV-51, GV-67, GV-68, GV-69, GV-75, GV-89, GV-91, GV-94, GV-100, GV-104, GV-106, GV-108, GV-113, GV-120
- **Covers:** HW-12

**Goal.** Remove the legacy path so the provider layer is the only model path in generation. That means the 7 Anthropic*Builder classes, anthropicCall.ts's web-search helpers (:76-151) and the 'anthropic' route. enrich/AnthropicEnricher.ts and the SDK dependency stay.

**Design.**

GATED BACKLOG (not in the wave table): this card enters a wave only when (a) the founder confirms on #1163 that no legacy Claude generation run is wanted for comparison (OQ-06) and that the relay may lose its generation role, and (b) at least one golden-set listen of the all-local pipeline has happened. Neither can be met by code alone. Nothing depends on this card; HW-12 stays covered by GV-68 (enforcement: anthropicCalls = 0, double opt-in, structural guard). When the gate is met it is placed in the first wave after the last scheduled card that edits any file below (today wave 39, so wave 40), and the orchestrator re-runs the per-wave collision check.

INTEGRATION NOTE: the prompts already live in prompts/*.ts (GV-32, GV-50), so step 1 is done; this card only deletes the legacy classes and routes, and first moves the structural guards it would otherwise delete.

Guard migration (BEFORE anthropicCall.test.ts is deleted, in the same PR):
- New backend/test/providerGuards.test.ts takes over every structural guard that lives in anthropicCall.test.ts: the original scan 'no generation module calls messages.create or recordUsage except through anthropicCall.ts' (backend/test/anthropicCall.test.ts:110-122; now: recordUsage only in usageTracking.ts and chat/askStructured.ts, and no messages.create anywhere in generation/**), GV-07's recordModelCall allowlist (PROVIDER_CALL_SITES), and GV-19's recursive fetch, recordUsage and `.complete(` rules. It imports PROVIDER_CALL_SITES from runLog.ts.
- runLog.ts: PROVIDER_CALL_SITES drops 'anthropicCall.ts' and becomes ['chat/openAICompatProvider.ts', 'jevClient.ts'] (the fetch rule keeps its pre-listed 'retrievalClient.ts').
- usageTracking.ts: GV-68's anthropicCalls counter loses its only incrementer (createMessage), so the counter is removed; generateForays.ts keeps writing anthropicCalls: 0 per entry and at the top level, so report readers and the bench columns stay stable, and the emptied noAnthropicInGeneration allowlist becomes the tripwire that replaces the runtime count.
- test/suite-integrity.test.js: remove the BACKEND_FLOORS entries for the five deleted suites (test/AnthropicPromptUnderstander.test.ts, test/AnthropicSpineBuilder.test.ts, test/AnthropicDeepenActBuilder.test.ts, test/AnthropicExternalResearcher.test.ts, test/anthropicCall.test.ts), or the 'still exists' check (test/suite-integrity.test.js:3184) fails, and add one for providerGuards.test.ts. test/AnthropicEnricher.test.ts stays (enrich/ is out of scope).
- Suites that import the Anthropic builders only for their prompt builders are re-pointed to prompts/*.ts and replyErrors.ts: actNarration.test.ts (:23-24: actOutputTokenBudget, assertNotTruncated, buildActWritePrompt, buildActVerifyPrompt), frameTapeSource.test.ts, hingeTapeSource.test.ts, narratorStructure.test.ts, postSeedSpine.test.ts, researchShape.test.ts (TruncatedReplyError from replyErrors.ts), sourceBeats.test.ts and spineReask.test.ts (its AnthropicSpineBuilder re-ask cases move onto ChatSpineBuilder with the scripted provider). gatherEvidence.test.ts and models.test.ts drop their Anthropic-specific cases.

1. Move the prompt builders and constants into neutral modules first: backend/src/generation/prompts/understand.ts, spine.ts, deepen.ts, continuity.ts, actWrite.ts and actVerify.ts. Also move their tests over the exported build*PromptParts.
2. Delete the 7 Anthropic*.ts files, generation/anthropicCall.ts (replyErrors.ts keeps TruncatedReplyError) and the five Anthropic-specific suites listed above, after the guard migration.
3. Remove 'anthropic' and anthropic-legacy from stageRouting, and the legacy tier rows from models.ts.
4. Empty the noAnthropicInGeneration allowlist.
5. Update the floors as listed in the guard migration.
6. Drop start-run's --legacy-claude generation path, or keep the relay for non-generation uses if the founder prefers.

**Files edited:**

- backend/src/generation/AnthropicPromptUnderstander.ts
- backend/src/generation/AnthropicExternalResearcher.ts
- backend/src/generation/AnthropicSpineBuilder.ts
- backend/src/generation/AnthropicDeepenActBuilder.ts
- backend/src/generation/AnthropicNarrationWriterBuilder.ts
- backend/src/generation/AnthropicNarrationVerifierBuilder.ts
- backend/src/generation/AnthropicContinuityBuilder.ts
- backend/src/generation/anthropicCall.ts
- backend/src/generation/createPromptUnderstander.ts
- backend/src/generation/createSpineBuilder.ts
- backend/src/generation/createDeepenActBuilder.ts
- backend/src/generation/createNarrationWriterBuilder.ts
- backend/src/generation/createNarrationVerifierBuilder.ts
- backend/src/generation/createContinuityBuilder.ts
- backend/src/generation/createExternalResearcher.ts
- backend/src/config/stageRouting.ts
- backend/src/config/models.ts
- backend/test/noAnthropicInGeneration.test.ts
- tools/generation/start-run.mjs
- test/suite-integrity.test.js
- backend/src/generation/runLog.ts
- backend/src/generation/usageTracking.ts
- backend/src/cli/generateForays.ts
- backend/test/AnthropicPromptUnderstander.test.ts
- backend/test/AnthropicSpineBuilder.test.ts
- backend/test/AnthropicDeepenActBuilder.test.ts
- backend/test/AnthropicExternalResearcher.test.ts
- backend/test/anthropicCall.test.ts
- backend/test/actNarration.test.ts
- backend/test/frameTapeSource.test.ts
- backend/test/hingeTapeSource.test.ts
- backend/test/narratorStructure.test.ts
- backend/test/postSeedSpine.test.ts
- backend/test/researchShape.test.ts
- backend/test/sourceBeats.test.ts
- backend/test/spineReask.test.ts
- backend/test/gatherEvidence.test.ts
- backend/test/models.test.ts
- backend/test/generateForays.test.ts

**New files:**

- backend/test/providerGuards.test.ts

**Acceptance:**

- No file under backend/src/generation or the generate CLIs references @anthropic-ai/sdk, and the allowlist is empty.
- All prompt content is preserved in prompts/*.ts; the line-set tests are carried over.
- Typecheck is clean. runPipeline.test.ts, actNarration.test.ts and the generateForays*.test.ts suites pass with the Stub and Chat builders.
- providerGuards.test.ts carries every guard that was in anthropicCall.test.ts (GV-07's recordModelCall allowlist; GV-19's recursive fetch, recordUsage and .complete rules) and fails on a planted fetch( or recordModelCall( outside PROVIDER_CALL_SITES; PROVIDER_CALL_SITES no longer names anthropicCall.ts.
- The five deleted suites have no BACKEND_FLOORS entry, providerGuards.test.ts has one, and suite-integrity's 'still exists' and 'covered by a floor' checks pass.
- report.json still carries anthropicCalls: 0 per entry and at the top level.

**Tests.** Run `npm run typecheck`, then providerGuards.test.ts, runPipeline.test.ts, actNarration.test.ts, promptLayout.test.ts, stageFactories.test.ts, noAnthropicInGeneration.test.ts and each re-pointed suite, one at a time, then `node --test test/suite-integrity.test.js`.

**Flag.** None; this is a cleanup. Gated: see the gated-backlog note above.

**Live step.** none

**Founder need.** founder-approved label (orchestrator applies); plus the gate itself: confirm on #1163 that no legacy Claude generation run is wanted for comparison (ties to OQ-06) and that the relay may lose its generation role, after one golden-set listen of the all-local pipeline.

**Risk.** Irreversible in practice: it removes the only reproduction of earlier Claude runs. Hold it until at least one golden-set listen of the all-local pipeline. Large mechanical diff in a governed path.

## Default flips

The founder ruled that the "What is not measured" list (QK-20..QK-30) is a list of things to FIX. Every fix card ships dark with a default that keeps today's behaviour, so building the cards does not by itself fix anything a listener hears. An item is CLOSED only when its default flips. A flip is not a card: it is a one-line PR that changes only the default value in the owning module (generationFlags, gateConfig, pipelineFlags or the routing defaults) and its pinned default test. Because those modules are under backend/src, the orchestrator applies the founder-approved label. The flip PR links the evidence posted on #1286, and the Status column below is updated in the same PR.

Evidence standards used below:
- **golden compare**: a GV-64 `--compare` run of the golden set (GV-45) with the flag on against the adopted baseline. The item's target metric must improve, and no other MQ headline may move outside its tolerance band.
- **calibration**: judge-vs-label agreement of at least 0.9 at the chosen threshold, from GV-103's table (Jev and, where it is routed, the Qwen judge).
- **pairwise listen**: the founder's blind pairs (GV-36, decided with GV-35's rule) come out even or better for the flag-on arm.
- No batch golden run starts before GV-90 and GV-93 have merged (GV-68's accepted-ordering rule).

| Item | Flag (owning card) | Today's default -> target | Evidence required before the flip | Who flips | Status |
|---|---|---|---|---|---|
| QK-20, GP-21 | FORAY_CLIP_JUDGE (GV-79) | off -> shadow | One clean shadow run of the germ-theory prompt (GV-79 live step) | Orchestrator | open |
| QK-20, GP-21 | FORAY_TAPE_GATE (GV-118) | qk04 -> mq05 | Calibration of clip-subject and clip-claim (GV-103); the 14 Sep candidate is refused; golden compare on MQ-05 | Orchestrator | open |
| QK-20, R2-03 | FORAY_CLIP_JUDGE (GV-119 judged walk) | shadow -> enforce | Calibration; golden compare on MQ-05 and MQ-08 (clip count within band); pairwise listen | Orchestrator, after the founder's listen | open |
| QK-21, GP-22 | FORAY_RESEARCH_SHOW_QUOTA (GV-87) | unset -> on | Golden compare on MQ-07 (distinct shows up) with MQ-09 tape yield within band | Orchestrator | open |
| QK-21, GP-22 | FORAY_SHOW_SHARE (GV-115) | off -> order (gate stays opt-in) | GV-115's 10-prompt replay, then golden compare on MQ-07 with tape beats and fallbacks within band | Orchestrator | open |
| QK-22, GP-21 | FORAY_RETRIEVAL_MODE (GV-48, GV-95) | bm25 -> hybrid | GV-88's replay go/no-go passes (MQ-09 unseeded-beat yield) on the live corpus; golden compare | Orchestrator | open |
| QK-22 | FORAY_RESEARCH_SHORTLIST (GV-112) | off -> 1 | GV-112's 5-prompt replay (seeded-beat share and unseeded yield up); golden compare | Orchestrator | open |
| QK-23, GP-23 | FORAY_STAGE_RESEARCH, local-mode default (GV-61, GV-69) | none -> dossier | Live dossier build (GV-30, GV-65); GV-69's 3-prompt run shows print documents and quote-gate passes; golden compare on MQ-02 with printEvidenceSkipped down | Orchestrator | open |
| QK-24, GP-23 | FORAY_ATTRIBUTION_CHECK (GV-120) | report -> enforce | Report-mode golden run with the unknowable share recorded; golden compare on MQ-03 | Orchestrator | open |
| QK-24, GP-23 | FORAY_FRAME_VERIFY (GV-121) | off -> report -> cut | Report: none beyond a clean run. Cut: calibration of sentence support; fewer than about 30% of frames fail (else writer-authored frames first); pairwise listen | Orchestrator, after the founder's listen | open |
| QK-25, GP-24 | FORAY_VOICE_GATE (GV-104) | report -> enforce (the hard errors chosen in GV-104's live step) | GV-104's Qwen-vs-Claude voice comparison; golden compare on MQ-15..MQ-18 inside the 6-9 grade band; pairwise listen | Orchestrator, after the founder's listen | open |
| QK-26, GP-24 | FORAY_NARRATION_ORDER (GV-38) | parallel -> sequential | GV-38's pairwise listen on medium prompts; golden compare with whole-Foray time still within 4 min medium | Orchestrator, after the founder's listen | open |
| QK-27, GP-23 | FORAY_EVIDENCE_WHOLE_CLIP (GV-76) | off -> 1 | Golden compare on MQ-02 and MQ-04 with windowTruncated at 0 and no time target breached | Orchestrator | open |
| QK-28, GP-25 | FORAY_TIER_RUNTIME_CAP (GV-89, GV-106) | off -> on | Golden run: spineRuntime estimate calibrated against runtime_sec (GV-89); tape share within ±15% of tier and MQ-08 not worse (GV-106) | Orchestrator | open |
| QK-28, GP-25 | FORAY_GATE_TIER_FIT (GV-106) | off -> on | MQ-14 in band on the golden set after the cap flip; pairwise listen | Orchestrator, after the founder's listen | open |
| QK-29, GP-23, R2-13 | FORAY_UNVERIFIED_SEAM_POLICY (GV-108) | keep -> cut | Golden compare: MQ-21 up, MQ-04 within band, no HANDOFF_SCRIPT; pairwise listen including a slot whose seams were all cut | Orchestrator, after the founder's listen | open |
| GP-26, R2-10 | FORAY_UNSUPPORTED_SENTENCE_POLICY (GV-113) | rewrite -> cut | Calibration of sentence support; golden compare: retry rounds and writer calls down, sentencesSurvivingRate and MQ-21 up | Orchestrator | open |
| GP-26, R1-07 | FORAY_STAGE_VERIFIER, local-mode default (GV-51) | today's verifier -> jev | Calibration; GV-51's short and medium golden prompts against the run-9 baseline; golden compare on MQ-02 and MQ-21 | Orchestrator | open |
| R1-03, R2-07, GP-02 | FORAY_SPINE_TIER_SIZING (GV-100) | off -> on | GV-100's live step on the 10 listened golden prompts: no truncated spine (TruncatedReplyError), the structural re-ask rate and MQ-10 not worse, spine output tokens down; golden compare with no MQ headline outside its band. The flag is in the checkpoint variant (`spine=tier-sized`, GV-126), so the runs may resume banked checkpoints | Orchestrator | open |
| R1-04, GP-03 | FORAY_PER_ACT_PIPELINE (GV-102) | off -> on | GV-102's live step: medium golden prompts on the Spark with the flag on and off; first-seam time and MT-06 improve; golden compare with whole-Foray time still within 4 min medium and no MQ headline outside its band | Orchestrator | open |
| R1-01, GP-03 | FORAY_FAST_PATH (GV-15, GV-117) | off -> on for the short tier | GV-117's live golden run meets 30 s to first audio (MT-01) on the short tier; pairwise listen of fast-path vs classic short Forays; blocked until #1411 is fixed (the fast path turns on FORAY_WRITER_STREAM, and under the GV-93 lane scheduler a stream's wait for its lane slot counts toward the writer-stream idle bound and is cut as a stall; the same blocker applies to flipping FORAY_WRITER_STREAM alone) | Orchestrator, after the founder's listen | open |

GP-26's closing metric is the golden-set MQ-21 rate (the publishable share, GV-26's `publishable`, aggregated by GV-64). The PROPOSED close is MQ-21 of at least 0.8 on the scored golden prompts, recorded in docs/curation/generation-kpis.md and confirmed by the orchestrator once the first golden baseline exists. QK-30 is closed by the founder's first listen (GV-36), not by a flag.

## Coverage

Every listed item maps to cards or to an explicit disposition. GP-20..GP-25 also count the cards of the QK items they refer to.

| Item | Cards | Disposition |
|---|---|---|
| R1-01 | GV-15, GV-73, GV-86, GV-102, GV-117, GV-123 | covered; the critical-path probe (GV-123) pins today's chain; the offline latency model in GV-117 asserts 3 serial calls; the live golden run measures them; closed when FORAY_FAST_PATH defaults on for the short tier (Default flips) |
| R1-02 | GV-49, GV-67 | covered (Jev clarity, title/summary/intent from the spine) |
| R1-03 | GV-32, GV-86, GV-100 | covered (prefix layout, per-tier schema and budget, folded deepen); closed when FORAY_SPINE_TIER_SIZING defaults on (Default flips) |
| R1-04 | GV-18, GV-46, GV-102 | covered (SourcingSession, incremental stitcher, per-act driver); closed when FORAY_PER_ACT_PIPELINE defaults on (Default flips) |
| R1-05 | GV-61, GV-69, GV-98 | covered (no web research on the timed path, first-act evidence wave, dossier researcher) |
| R1-06 | GV-43, GV-73, GV-84 | covered (streamed JSONL contract, per-seam gating, streamed Qwen writer) |
| R1-07 | GV-20, GV-27, GV-34, GV-47, GV-51, GV-103 | covered (Jev client, per-sentence judge, Jev verifier, calibration, Qwen fallback) |
| R1-08 | GV-03, GV-93 | covered (lane profiles, lane scheduler); live Spark-side config needs founder approval |
| R1-09 | GV-05, GV-09, GV-12, GV-16, GV-28, GV-29, GV-48, GV-66, GV-88, GV-95, GV-112 | covered (streamed index, passages, embeddings, resident server, client wiring, hybrid shortlist, Spark kit) |
| R1-10 | GV-32, GV-50 | covered (planning and writer prompt layouts); cached-token reading needs --enable-cache-report (live) |
| R1-11 | GV-03 | covered in code (lane profiles make P40 vs V100 a config edit); the hardware check is a founder/Joey live step |
| R1-12 | GV-93 | covered in code (priority, reserved slot, queueMs); the Spark serving change is a founder-approved live step |
| R1-13 | GV-11, GV-22, GV-58, GV-71, GV-74 | covered (per-item render, worker, render stage, stamping, GB10 bench); the optional torch profile GV-77 is in the gated backlog (gate: a #862 bench win) |
| R1-14 | GV-01, GV-07, GV-17, GV-33, GV-52, GV-85 | covered (run log, call records, bench summary, code spans, readiness events) |
| R1-15 | GV-21, GV-33, GV-44, GV-57, GV-59, GV-70, GV-74, GV-105 | covered (servability, item events, job sink, player append, job table, Spark worker) |
| R1-16 | GV-52 | covered (bench delivery columns and the split per-tier targets) |
| R1-17 | GV-14 | covered (stage x tier budgets; enforcement in the provider path) |
| R1-18 | GV-02, GV-19, GV-25, GV-31 | covered (schema converter, askStructured with json_schema on every local JSON call, Chat builders) |
| R1-19 | GV-90 | covered (unit caps on Spark seconds, second-box seconds and Jev calls) |
| R1-20 | GV-20, GV-47, GV-103, GV-107, GV-119 | covered (Jev client, per-beat Choice, judged walk, calibration, fallback) |
| R2-01 | GV-08, GV-36 | covered in code (card, store, blind pack); the listening itself is a founder live step |
| R2-02 | GV-24, GV-39, GV-45, GV-64 | covered (scorecard, fingerprint, golden set, aggregation and bands); the 50-prompt Spark run is live |
| R2-03 | GV-20, GV-79, GV-103, GV-107, GV-118, GV-119 | covered (clip scorer, judged walk, MQ-05 publish gate) |
| R2-04 | GV-12, GV-28, GV-48, GV-88 | covered (passages, embeddings, hybrid merge, replay go/no-go) |
| R2-05 | GV-56, GV-109, GV-111 | covered (per-edge boundaries and gate, word-timestamp schema, pause snapping); the farm must emit words (other repo) |
| R2-06 | GV-63, GV-78, GV-122 | covered (distinctive anchors, phone diagnostics, simulated resolve report); real play-time resolution waits on the native locate step (ADR-0008), out of scope |
| R2-07 | GV-32, GV-67, GV-91, GV-100 | covered (tier-sized spine, disappointment fields, best-of-2 behind a flag); closed when FORAY_SPINE_TIER_SIZING defaults on (Default flips) |
| R2-08 | GV-43, GV-50, GV-84, GV-104, GV-116 | covered (streamed one-call-per-act writer, prompt layout with voice slot, voice checks, drift alarm) |
| R2-09 | GV-34, GV-51, GV-103 | covered (code checks on numbers, dates and names inside the Jev verifier) |
| R2-10 | GV-113 | covered (cut unsupported sentences; one edit only for an orphaned beat) |
| R2-11 | GV-120 | covered (attribution check, MQ-03) |
| R2-12 | GV-76 | covered (whole clip window as evidence, behind a flag) |
| R2-13 | GV-21, GV-108 | covered (per-act servability gate, cut-to-introduction policy) |
| R2-14 | GV-10, GV-104 | covered (shared spoken-line library, voice gate and scorecard) |
| R2-15 | GV-89, GV-106 | covered (tier runtime check after the spine, tier-aware clip ceiling, MQ-14) |
| R2-16 | GV-06, GV-09, GV-23, GV-53, GV-54, GV-60, GV-115 | covered (inventory, legacy whisper, streaming, digest rows, show-share ledger); new shows also need catalogue/DAI curation (founder queue) |
| R2-17 | GV-42, GV-91, GV-94, GV-97, GV-99, GV-110, GV-114 | covered up to readiness (exemplars, best-of-2, self-critique, exchange recorder, training ledger); the fine-tune run is deferred until 500 usable non-Claude examples exist; Claude-built data parked (OQ-06) |
| R2-18 | GV-58, GV-72, GV-82 | covered (Spark render kit, IPA hints, whisper round trip and loudness spread); narration-vs-tape loudness is left out (needs clip audio measurement) |
| R2-19 | GV-41, GV-81 | covered (review queue with labelled verdicts, two lanes) |
| R2-20 | GV-30, GV-61, GV-65, GV-69 | covered (research route, code-built dossiers, Qwen selection, dossier researcher); Claude-built dossiers parked (OQ-06) |
| R2-21 | GV-03, GV-25, GV-31, GV-35, GV-37, GV-55, GV-62, GV-75 | covered (routing, Chat builders, driver attribution, checkpoint fork, swap runner); protocol reworked to all-local arms under zero-Anthropic |
| QK-20 | GV-79, GV-118, GV-119 | fix built behind FORAY_CLIP_JUDGE and FORAY_TAPE_GATE (MQ-05 measured on placed clips, then gated); closed when FORAY_TAPE_GATE flips to mq05 after calibration of at least 0.9 and a golden compare (Default flips) |
| QK-21 | GV-83, GV-87, GV-115 | fix built behind FORAY_RESEARCH_SHOW_QUOTA and FORAY_SHOW_SHARE (show variety measured, per-show quota, show-share ledger); closed when both defaults flip after a golden compare on MQ-07 (Default flips) |
| QK-22 | GV-48, GV-88, GV-112 | fix built behind FORAY_RETRIEVAL_MODE and FORAY_RESEARCH_SHORTLIST (dense arm and shortlist offered to the spine); closed when hybrid becomes the default after GV-88's replay gate passes and a golden compare (Default flips) |
| QK-23 | GV-30, GV-65, GV-69 | fix built behind the research route (dossiers of fetched text replace Haiku's retyping); closed when the local-mode research default flips from none to dossier after the live dossier build and a golden compare (Default flips) |
| QK-24 | GV-120, GV-121 | fix built behind FORAY_ATTRIBUTION_CHECK and FORAY_FRAME_VERIFY (named speaker checked; intros, exits and the overview verified per sentence); closed when both reach enforce/cut after calibration, a golden compare and a pairwise listen (Default flips) |
| QK-25 | GV-10, GV-104 | fix built behind FORAY_VOICE_GATE (style rules in code on generated narration); closed when the gate flips to enforce after a golden compare on MQ-15..MQ-18 and a pairwise listen (Default flips) |
| QK-26 | GV-38 | fix built behind FORAY_NARRATION_ORDER (act frame plus sequential act writing); closed when sequential becomes the default after GV-38's pairwise listen and a golden compare (Default flips) |
| QK-27 | GV-76 | fix built behind FORAY_EVIDENCE_WHOLE_CLIP (whole clip window; truncation counted); closed when the flag defaults on after a golden compare (Default flips) |
| QK-28 | GV-89, GV-106 | fix built behind FORAY_TIER_RUNTIME_CAP and FORAY_GATE_TIER_FIT (post-spine runtime check, clip ceiling, tier-fit metric); closed when both default on after a golden run within ±15% of tier and a pairwise listen (Default flips) |
| QK-29 | GV-21, GV-108 | per-act servability is always on (GV-21, no flag); the cut policy is built behind FORAY_UNVERIFIED_SEAM_POLICY; closed when cut becomes the default after a golden compare (MQ-21 up) and a pairwise listen (Default flips) |
| QK-30 | GV-08, GV-36 | fixed in tooling; closed only by the founder's first listen (live step) |
| GP-01 | GV-01, GV-07, GV-17 | covered (run log, call records, bench speed summary); first local numbers need the LiteLLM key |
| GP-02 | GV-14, GV-32, GV-80, GV-84, GV-100, GV-117 | covered (budgets, tier-sized spine, streamed writer cap, seam-only edits, fast path); closed when FORAY_SPINE_TIER_SIZING defaults on (Default flips) |
| GP-03 | GV-15, GV-86, GV-102, GV-117, GV-123 | covered (critical-path probe GV-123, folded deepen, per-act driver, fast path); closed with the FORAY_FAST_PATH flip (Default flips) |
| GP-04 | GV-80 | covered (timed round policy; cut instead of rewrite) |
| GP-05 | GV-32, GV-50, GV-73, GV-80, GV-84, GV-100, GV-117 | covered (prefix layouts, streaming, smaller edit rounds) |
| GP-06 | GV-13, GV-19, GV-25, GV-31, GV-37, GV-40, GV-61, GV-68 | covered (provider layer, Chat builders, routing, no web research, zero-Anthropic enforcement) |
| GP-07 | GV-21, GV-33, GV-44, GV-57, GV-59, GV-81, GV-105 | covered (ready defined per item, delivery to a job row, player append) |
| GP-08 | GV-11, GV-22, GV-71, GV-74, GV-105 | covered (render stage per item, phone voice first) |
| GP-09 | GV-05, GV-06, GV-09, GV-16, GV-29, GV-54, GV-66, GV-95, GV-101 | covered (index and corpus on the Spark, remote retrieval, integrity guard) |
| GP-10 | GV-93 | covered (lane scheduler; Spark-side priority is a live step) |
| GP-20 | GV-08, GV-36 | covered via QK-30 (listening card and blind pack; founder listens) |
| GP-21 | GV-48, GV-79, GV-88, GV-112, GV-118 | covered via QK-20 and QK-22 |
| GP-22 | GV-06, GV-23, GV-53, GV-60, GV-83, GV-87, GV-115 | covered via QK-21 and the R2 corpus work; curation of new shows is a founder/Joey step |
| GP-23 | GV-21, GV-30, GV-65, GV-69, GV-76, GV-108, GV-120, GV-121 | fix built behind the QK-23, QK-24, QK-27 and QK-29 flags; closed when those defaults flip (Default flips) |
| GP-24 | GV-10, GV-38, GV-104, GV-116 | fix built behind the QK-25 and QK-26 flags, plus the report-only drift alarm; closed when FORAY_VOICE_GATE and FORAY_NARRATION_ORDER flip (Default flips) |
| GP-25 | GV-89, GV-106 | fix built behind the QK-28 flags; closed when FORAY_TIER_RUNTIME_CAP and FORAY_GATE_TIER_FIT default on (Default flips) |
| GP-26 | GV-26, GV-51, GV-108, GV-113, GV-118 | gate evaluated in every run (GV-26, always on); the structural fixes (Jev verifier GV-51, cut policies GV-108 and GV-113, MQ-05 gate GV-118) are built behind flags; closed when those defaults flip and the golden-set MQ-21 rate reaches the recorded target (PROPOSED 0.8) (Default flips) |
| GP-27 | GV-03, GV-35, GV-75 | covered in code; E0 (first all-Qwen Forays vs the Claude-written reference) is a live step |
| GP-28 | GV-17, GV-24, GV-45, GV-64 | covered (scorecard, golden set, aggregation and compare) |
| HW-12 | GV-13, GV-19, GV-25, GV-31, GV-37, GV-40, GV-55, GV-68 | covered (OpenAI-compatible provider with streaming, Chat builders, routing, zero-Anthropic enforcement GV-68); legacy retirement GV-96 is in the gated backlog (gate: the founder's #1163 confirmation) |
| sync-r2 size report + disk guard | GV-06 | covered (list-only inventory report with zero HEAD/GET, disk-space guard before any download) |

## Founder queue

Only what needs the founder: secrets, Spark hands, the hardware check, listening, spending and rulings. Everything else is decided by the orchestrator and recorded above. Queue on #1163; none of it blocks code work.

1. LiteLLM virtual key for Foray on #1163, plus approval of a Foray-only LiteLLM deployment. Unblocks every live Qwen step: provider captures (GV-13, GV-40), the first local runs (GV-55), stage swaps (GV-75) and dossier selection (GV-65).
2. Jev (TypeSafe) API key on the machine that runs generation, and the spend line (about $0.042 per million input tokens). Unblocks GV-20, GV-47, GV-49, GV-51, GV-79, GV-92 and GV-103 live steps.
3. R2 read-only key (R2_CREDENTIALS_FILE) on the founder PC or the Spark: sync-r2 list-only size report (GV-06), legacy whisper sample (GV-23), stream indexing (GV-09, GV-60), remote cue store (GV-54), word-timestamp sample (GV-111).
4. R2 narration bucket and write token on the render host (HUMAN-ACTIONS #119/#120): uploaded narration audio (GV-22, GV-58, GV-74).
5. Spark access under D8 (merged Hermes PR plus spark-live tag): retrieval server and nightly units (GV-66), render worker (GV-58), generation worker (GV-105); sign off the disk budget from the inventory and a niced multi-hour nightly index job. Also approve installing the embed runtime (about 373 MB) on the Spark, or serving an embedding model on the second box instead (GV-28; blocks only GV-28's live embedder choice and backfill).
6. Approval to change the shared Spark's serving config (affects the owners' terminals, OQ-07): --enable-priority-scheduling and --enable-cache-report on lane A2, a Foray-only deployment capped at 2, health probe off the 27B (GV-93).
7. Run `nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv` and the 60 s bench on p40-ai (founder or Joey; no SSH from the agent machine). Settles P40 vs V100 (OQ-01, GV-03).
8. Copy the 5,041 normalized transcripts (about 462 MB) and corpus-digest.json from the founder PC to the Spark (GV-66); keep the 14 Sep candidate and report in backend/data-local/foray-candidates for the first listen and scorecard row. Give an agent access to run 9's labelled pages in data-local on the founder PC (GV-47's Jev-vs-Qwen shadow comparison; blocks only that live step).
9. Supabase: apply migration 0007_generation_jobs and place the service key on the Spark; confirm that holding the prompt until a worker claims it satisfies §9.4 / RQ-04, and any privacy-policy wording under docs/legal (GV-59).
10. Listening and labelling (each blocks only a live step): about 10 min for act 1 of the 14 Sep candidate (closes QK-30, GV-36); about 40 min of blind pairs per stage swap (GV-75) and per listened default flip (Default flips table); pick the 2 exemplars and approve the voice card (GV-42); about 20-30 min of yes/no labels on clips and pages for judge calibration (GV-103); review-queue verdicts (GV-41); a founder-labelled clarity prompt set (two-subjects and one-episode yes/no labels) for calibrating GV-49's thresholds at 0.9 agreement; about 40 beat labels, roughly 1 hour on the founder PC, for GV-88's hybrid go/no-go (or an agent on that PC); optionally an async veto or swap of the 10 listened golden prompts (GV-45; the default is to proceed with the agent's set); an ear A/B of torch vs ONNX renders only if the GB10 bench wins (GV-77, gated backlog).
11. Paste the phone's diagnostic record after listening to a Foray with DAI clips (GV-63, GV-78); there is no transport by design.
12. Rule on OQ-06 (Claude-built training data or dossiers through the relay), including whether the pipeline's own historic Sonnet verdicts may serve as calibration labels (GV-103, GV-114). Default until then: excluded.
13. Confirm legacy Claude generation can be removed, after one golden-set listen of the all-local pipeline (GV-96, gated backlog; this confirmation is its gate).
14. Product and legal ruling before the on-demand lane serves anyone beyond the founders (GV-81).
15. Catalogue rows and DAI verdicts (founder- or Joey-approved curation pass) for the shows the mintability report lists as searchable-only; without them the show-variety gain is zero (GV-53). Optionally the foray-db legacy-mapping export, which needs foraycorpus access, if RSS resolution leaves many legacy keys unmatched (GV-53, GV-60; blocks only their live steps).
16. For information, no action: until GV-90 (unit caps) and GV-93 (lane scheduler) merge, the orchestrator runs no unattended or batch local generation (no golden-set or swap-arm batches), only single-prompt live checks it watches (GV-68's accepted ordering). The tools-side dossier selection (GV-65) runs only after the founder's go-ahead on #1163 when the key is supplied.

## Id map

| Original id | Workstream | GV card(s) |
|---|---|---|
| W1-01 | W1-measure | GV-04 |
| W1-02 | W1-measure | GV-01 |
| W1-03 | W1-measure | GV-07 |
| W1-04 | W1-measure | GV-17 |
| W1-05 | W1-measure | GV-85 |
| W1-06 | W1-measure | GV-33 |
| W1-19 | W1-measure | GV-52 |
| W1-07 | W1-measure | GV-14 |
| W1-09 | W1-measure | GV-26 |
| W1-08 | W1-measure | GV-90 |
| W1-10 | W1-measure | GV-10 |
| W1-16 | W1-measure | GV-08 |
| W1-17 | W1-measure | GV-36 |
| W1-11 | W1-measure | GV-24 |
| W1-12 | W1-measure | GV-52 |
| W1-13 | W1-measure | GV-39 |
| W1-14 | W1-measure | GV-45 |
| W1-15 | W1-measure | GV-64 |
| W1-18 | W1-measure | GV-92 |
| W2-01 | W2-provider | GV-13 |
| W2-02 | W2-provider | GV-40 |
| W2-03 | W2-provider | GV-02 |
| W2-04 | W2-provider | GV-19 |
| W2-05 | W2-provider | GV-03 |
| W2-06 | W2-provider | GV-25 |
| W2-07 | W2-provider | GV-31 |
| W2-08 | W2-provider | GV-37 |
| W2-18 | W2-provider | GV-55 |
| W2-09 | W2-provider | GV-93 |
| W2-10 | W2-provider | GV-61 |
| W2-11 | W2-provider | GV-20 |
| W2-12 | W2-provider | GV-47 |
| W2-13 | W2-provider | GV-32 |
| W2-14 | W2-provider | GV-50 |
| W2-15 | W2-provider | GV-68 |
| W2-16 | W2-provider | GV-75 |
| W2-17 | W2-provider | GV-96 |
| W3-01 | W3-retrieval | GV-06 |
| W3-02 | W3-retrieval | GV-23 |
| W3-04 | W3-retrieval | GV-05 |
| W3-23 | W3-retrieval | GV-12 |
| W3-05 | W3-retrieval | GV-09 |
| W3-03 | W3-retrieval | GV-53 |
| W3-06 | W3-retrieval | GV-60 |
| W3-07 | W3-retrieval | GV-28 |
| W3-08 | W3-retrieval | GV-16 |
| W3-24 | W3-retrieval | GV-54 |
| W3-09 | W3-retrieval | GV-48 |
| W3-10 | W3-retrieval | GV-29 |
| W3-11 | W3-retrieval | GV-95 |
| W3-12 | W3-retrieval | GV-83 |
| W3-13 | W3-retrieval | GV-87 |
| W3-25 | W3-retrieval | GV-112 |
| W3-14 | W3-retrieval | GV-115 |
| W3-15 | W3-retrieval | GV-88 |
| W3-16 | W3-retrieval | GV-15, GV-61 |
| W3-17 | W3-retrieval | GV-98 |
| W3-18 | W3-retrieval | GV-76 |
| W3-19 | W3-retrieval | GV-30 |
| W3-20 | W3-retrieval | GV-65 |
| W3-21 | W3-retrieval | GV-69 |
| W3-26 | W3-retrieval | GV-101 |
| W3-22 | W3-retrieval | GV-66 |
| W4-01 | W4-critical-path | GV-15 |
| W4-02 | W4-critical-path | GV-49 |
| W4-03 | W4-critical-path | GV-67 |
| W4-04 | W4-critical-path | GV-32, GV-100 |
| W4-18 | W4-critical-path | GV-100 |
| W4-05 | W4-critical-path | GV-86 |
| W4-06 | W4-critical-path | GV-18 |
| W4-20 | W4-critical-path | GV-46 |
| W4-07 | W4-critical-path | GV-102 |
| W4-08 | W4-critical-path | GV-38 |
| W4-09 | W4-critical-path | GV-43 |
| W4-10 | W4-critical-path | GV-73 |
| W4-11 | W4-critical-path | GV-50 |
| W4-19 | W4-critical-path | GV-84 |
| W4-12 | W4-critical-path | GV-104, GV-116 |
| W4-13 | W4-critical-path | GV-80 |
| W4-14 | W4-critical-path | GV-89 |
| W4-15 | W4-critical-path | GV-106 |
| W4-16 | W4-critical-path | GV-91, GV-97 |
| W4-17 | W4-critical-path | GV-117 |
| W5-01 | W5-gates | GV-20 |
| W5-02 | W5-gates | GV-15 |
| W5-17 | W5-gates | GV-10 |
| W5-03 | W5-gates | GV-79 |
| W5-06 | W5-gates | GV-118 |
| W5-04 | W5-gates | GV-107 |
| W5-05 | W5-gates | GV-119 |
| W5-08 | W5-gates | GV-27 |
| W5-10 | W5-gates | GV-34 |
| W5-09 | W5-gates | GV-51 |
| W5-12a | W5-gates | GV-21 |
| W5-12b | W5-gates | GV-108 |
| W5-11 | W5-gates | GV-113 |
| W5-13 | W5-gates | GV-109 |
| W5-14a | W5-gates | GV-56 |
| W5-14b | W5-gates | GV-111 |
| W5-15 | W5-gates | GV-120 |
| W5-16 | W5-gates | GV-121 |
| W5-18 | W5-gates | GV-104 |
| W5-07 | W5-gates | GV-103 |
| W5-19 | W5-gates | GV-47 |
| W6-01 | W6-delivery | GV-21 |
| W6-02 | W6-delivery | GV-33 |
| W6-03 | W6-delivery | GV-44 |
| W6-04 | W6-delivery | GV-57 |
| W6-20 | W6-delivery | GV-70 |
| W6-05 | W6-delivery | GV-11 |
| W6-06 | W6-delivery | GV-22 |
| W6-07 | W6-delivery | GV-74 |
| W6-08 | W6-delivery | GV-71 |
| W6-09 | W6-delivery | GV-58 |
| W6-10 | W6-delivery | GV-77 |
| W6-11 | W6-delivery | GV-82 |
| W6-12 | W6-delivery | GV-72 |
| W6-13 | W6-delivery | GV-122 |
| W6-14 | W6-delivery | GV-78 |
| W6-15 | W6-delivery | GV-63 |
| W6-16 | W6-delivery | GV-41 |
| W6-17 | W6-delivery | GV-81 |
| W6-18 | W6-delivery | GV-59 |
| W6-19 | W6-delivery | GV-105 |
| W6-21 | W6-delivery | GV-52 |
| W7-01 | W7-model-gap | GV-35 |
| W7-02 | W7-model-gap | GV-03, GV-37, GV-55 |
| W7-03 | W7-model-gap | GV-62 |
| W7-04 | W7-model-gap | GV-75 |
| W7-05 | W7-model-gap | GV-42 |
| W7-06 | W7-model-gap | GV-99 |
| W7-07 | W7-model-gap | GV-91 |
| W7-08 | W7-model-gap | GV-94 |
| W7-09 | W7-model-gap | GV-110 |
| W7-10 | W7-model-gap | GV-114 |
| W7-11 | W7-model-gap | GV-97 |
