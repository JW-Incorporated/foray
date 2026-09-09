# Generation findings tracker — every F and every I, in one place

*Consolidated 2026-09-09 against branch `generation-run-2026-09-09` (tip `ac5688c`, the merge of
`fix/f60-no-evidence-page`).* This is the single answer to the founder's ask — *"ensure all issues you
encountered are tabulated and addressed"* — for the generation test-drive: every finding **F-01…F-62** and
every non-historical intervention **I-01…I-23** from `generation-run-2026-09-09.md`, cross-checked against
what the merged PRs **actually** did rather than against what `generation-fix-plan-2026-09-09.md` promised,
and against what runs 1 and 2 then showed. Read the **status** column as: `fixed` — merged into
`generation-run-2026-09-09`, with the PR and the file/function named; `in flight` — an open PR; `card` — a
workstream or deck card carries it; `issue` — a GitHub issue; `open` — nothing tracks it yet (as of this revision, none); `accepted` — a deliberate deviation or a transport-only note that
production never sees; `superseded` — another finding replaced it. Nothing on the branch has reached `main`
yet: **PR #538** (`generation-run-2026-09-09` → `main`) is the open umbrella for all of it, so every `fixed`
row means *fixed on the generation branch*. Four interventions are omitted as purely historical, with
nothing left to track: **I-04** (attempt 1 aborted on a cp1252 mojibake, fixed the same hour), **I-05**,
**I-11** and **I-14** (answers replayed between attempts because the prompts were byte-identical).

## 1. The tracker

| id | one-line | severity (as logged) | status | where fixed / tracked | what remains |
|---|---|---|---|---|---|
| F-01 | Tier-2 tape sourcing could never fire: the only cue provider was the null one. | High | fixed | #538 branch commit `e666c2a` — `FileTranscriptCueProvider`, wired by `generateForays.ts` (I-02) | Nothing. Extended by #553's `bodyStat()`. |
| F-02 | `parseWithRetry` had no retry; one malformed reply killed the stage. | High for robustness | fixed | #544 — `parseWithRetry.ts` gains a `reask` closure; every real builder passes one | Nothing. Same defect as F-39; #544 cites F-39/F-40, not F-02. |
| F-03 | Model ids were last-generation and scattered across eight builder classes. | Medium | fixed | #543 — `backend/src/config/models.ts`, grep test in `test/models.test.ts` | Nothing — but the upgrade itself created F-47. |
| F-04 | `DAILY_BUDGET_USD` defaulted to $2.00; a medium Foray would halt mid-run. | Medium | fixed | #543 — `config/env.ts` default 25.00, `--budget-usd` on `generateForays` | Nothing. The per-Foray half was still inert until F-54/#551. |
| F-05 | The cheapest tier (Haiku, 800 output tokens) decides a topic's "genuine controversies". | Low / observe | card | **WS-G** (`generation-fix-plan-2026-09-09.md`) — Unchanged; named in requirements §8.13 | Raise the researcher cap and set its effort alongside F-47/F-48. |
| F-06 | Tier-2 matched episode **titles** only; transcript text was never searched. | Medium (recall) | fixed | #553 (WS-H) — `transcriptTextIndex.ts` BM25 candidate search feeding the existing gates in `sourceBeats.ts` | Nothing. **#546 titled itself "closes F-06" and did not**: it fixed tier 1's haystack; run 2 then found zero tape and the "F-49 → resolved (cause)" row proved the title bar was still the binding gate. |
| F-07 | The SDK's 10-min timeout and 2 retries can mint duplicate requests on a slow transport. | Low | accepted | Relay-side; requirements §8.13 | Irrelevant with a real key. Any future queued transport must key idempotency on the SDK request id, not the body (see I-23). |
| F-08 | The keyless stub run built a Foray, then failed M4 show-concentration at 30.9 %. | Info | accepted | Expected on the 212-row pool; WS-B's `tapeRelevance` makes it measurable | Re-check once #553's tier-2 tape actually flows; no separate work. |
| F-09 | `backend` did not typecheck: `import.meta`, an unexported type, missing `.mjs` declarations. | Medium (hygiene) | fixed | #544 — `mjs-modules.d.ts`, `__dirname` in `finalizeForay`/`publishForay`, `NarrationBuildContext` re-export | Nothing. Four pre-existing `breadthCatalog.test.ts` strict-null errors remain, unrelated. |
| F-10 | Subagents fenced their JSON about half the time. | Low | accepted | Transport; `parseWithRetry` already strips one fence pair (I-06) | Nothing — a production API call does not have this shape. |
| F-11 | The research map leaked off-topic concepts into the spine prompt. | Medium | fixed | #543 — `matchConceptsInText` word-boundary rule plus lineage drop; `buildResearchShape` resolves the topic | Nothing. #543 also records that the **finding's stated cause was wrong** — the leak was `ch-ai-ns`, an interior substring, not a shared `engineering` token. |
| F-12 | External research fires only for catalogue-gap seeds, so it never ran in run 1. | Observe → Medium | accepted | By design; requirements §8.13. WS-A (#545) now retrieves print evidence for **every** beat regardless | Confirm in run 3 that F-11's fix lets a genuine gap trigger `fanOutExternalResearch`; if it still never fires, card it then. |
| F-13 | No structural check on the spine before three deepen calls were spent. | Medium | fixed | #543 — `spineStructure.ts`, enforced by `buildSpine`; run 2's 35-beat spine passed it | Nothing. |
| F-14 | The writer was asked for verbatim quotes with no text to quote from. | High | fixed | #545 (WS-A) — `gatherEvidence.ts` + `selectClaims`, quote checked as a substring in code | Nothing. Run 2 attempt 1: zero fabricated citations reached the verifier (run 1: ≥6). |
| F-15 | Narration was fully serial; nothing is playable until the whole Foray finalises. | High (time-to-listen) | card | #545 (WS-D1, slots parallel per act), #539 (WS-D2 partial candidate, `ttlA1Ms`); `player-streaming-brief.md` | The serving half. Requirements §8.8: **no HTTP server exists**, and Path B needs four founder decisions (host, spend cap, review-gate exception, CSP). `ttlA1Ms` is not yet a true Act-1 number. |
| F-16 | The narration retry re-sent a byte-identical prompt. | High | fixed | #538 branch commit `e666c2a` (I-12); superseded in #545 by an accumulating retry note | Nothing. |
| F-17 | One beat's narration failure discarded the whole Foray. | High | fixed | #543 (per-stage checkpoint), #551 (a page never throws), #555 (the no-evidence branch) | Nothing. Took three PRs: #543's checkpoints and I-13's connective drop both left fatal branches that run 2 then died on twice. |
| F-18 | The batch driver could not resume inside a Foray. | Medium | fixed | #543 — `generation/checkpoint.ts`, `FileCheckpointStore`; #551 adds `narrate:<act>:<slot>` keys | Nothing. |
| F-19 | A Frame's 70–170 characters cannot voice a contested source, so rule 3 rejects it. | Medium | card | **WS-K** (`generation-fix-plan-2026-09-09.md`) — *Mitigated* only — requirements §8.13 | Let a Frame carrying a contested source flex its budget, or forbid contested sources on connective pages. |
| F-20 | The driver's error text double-encodes `§` on a Windows console. | Low | card | **WS-J** (`generation-fix-plan-2026-09-09.md`) — Unchanged, cosmetic; requirements §8.13 | One-line fix: force the driver's console output to UTF-8 (or write "section"). |
| F-21 | A pre-existing test failed on a checkout path containing a space. | Low | fixed | #544 — `writeNarration.test.ts` runs `check-forays.mjs` in a plain Node subprocess | Nothing. `finalizeForay.test.ts` ×5 still fails the same way and is documented as such. |
| F-22 | The verifier read only the writer's own declarations, so a fabricated quote passed. | High | fixed | #545 — mechanical substring gate runs **before** any verifier call; the verifier gets the evidence pack | The gate proves the quote is in the *retrieved* text, not on the page at the url — that residual is F-48. |
| F-23 | Tape was anchored to the wrong disaster on shared show-title tokens. | High | fixed | #546 (WS-C) — `taxonomyFamily.ts` lineage gate + topic resolved before sourcing | Nothing in code; run 1's Chernobyl-for-Hyatt case is pinned in `sourceBeats.test.ts` and still refused under #553. Never re-exercised live: runs 2 produced zero tape. |
| F-24 | Tier 2 minted tiny off-topic "tape" from a generic four-word run anywhere in an hour. | High | fixed | #546 — ±30 s anchored-window overlap excluding the anchor's own words; span cut to cue boundaries | Nothing. The cut rule's symmetric padding is what F-62 then found. |
| F-25 | "Contested" was the writer's default, and Frame pages could not voice it. | High (cost) | fixed | I-13 (narrow definition, `e666c2a`); #545 — the verifier judges rule 3 with the sources in hand | The character-budget half is tracked as F-19. |
| F-26 | The writer emitted HTML entities inside `publication` strings. | Low | fixed | #544 — `decodeEntities` in `writeNarration`; re-ordered in #545 so decoding precedes the substring check | Nothing. |
| F-27 | A Chernobyl-flavoured fabricated citation on a Kansas City claim passed verification. | **Critical** | fixed | #545 — `publication` is derived from the held document, so the failure is unrepresentable; #540's `groundedQuoteRate` measures it | Nothing. Run 2 attempt 1's mechanical gate passed first time on all 5 selection calls. |
| F-28 | The writer's `claimText` asserted more than its own quote contained. | Medium | fixed | #545 — claims are selected from evidence and the purpose is not quotable | Nothing structural. Run 2 attempt 2 still had 4 verifier rejections for overreach — caught, which is the design. |
| F-29 | Tier 1 scored function words and fell through to a cross-domain segment on exhaustion. | **Critical** | fixed | I-13 (stopwords), #546 — transcript-window coverage bar + lineage gate inside the ranked walk | Deliberate deviation from the plan: exhaustion falls through to the next **lineage-admissible** candidate rather than returning null. |
| F-30 | The tape item's slug was cited as a publication. | High | fixed | I-13 (slug-shape rejection); #545 — `publication` is the held document's title, never writer text | Nothing. |
| F-31 | Two attempts per page made a 31-beat Foray statistically unreachable (≈0.1 %). | **Critical** | fixed | I-13 (3 attempts + connective drop), #551, #555 | Nothing. First-attempt pass rate went 5/23 → 6/11 → 6/9. |
| F-32 | The same quote span moved between publications across attempts. | High | fixed | #545 (publication no longer writer-supplied); #540 — `attributionStability` | Nothing. |
| F-33 | Two shared content words are noise inside one domain. | **Critical** | fixed | I-16 (thresholds 2→3), #546 (score against transcript text), #553 (BM25 candidate search) | Nothing. |
| F-34 | A page with zero sources passed structural validation. | Medium | fixed | #545 — `sources: []` allowed only when the script has no declarative sentence | Nothing. |
| F-35 | The informed retry carried only the latest rejection, not the history. | Medium (cost) | fixed | #545 — the retry note accumulates every prior rejection | Nothing. |
| F-36 | An orchestrator prompt line made source-less Frames the dominant first attempt. | High (self-inflicted) | fixed | #538 branch commit `57ec51b`; superseded by #545's code-level rule | Nothing. |
| F-37 | The stub, the writer prompt and the verifier disagreed on whether a connective page needs sources. | Medium | fixed | #545 — settled in code, so the verifier never sees the case | The **ruling is not written down**: `narration-craft.md` still says nothing about a source-free connective page. Tracked on **WS-K**. |
| F-38 | Analytical beats were given tape; nothing marked a beat as argument. | Medium | fixed | #546 — `kind: "account" \| "argument"` on the deepen schema, tape search skipped for arguments | Nothing — but the prompt line alone drifted, which is F-49. |
| F-39 | A malformed model reply spent a whole page attempt. | Medium | fixed | #544 — `parseOrRepairJson` + one re-ask before the attempt fails | Nothing. |
| F-40 | Three builders each carried a private copy of `parseWithRetry`. | Low | fixed | #544 — all delegate to the shared module; `parseWithRetry.test.ts` greps for drift | Nothing. |
| F-41 | Nothing checked that a page did what its beat existed for. | High | fixed | #545 — the verifier answers `purposeAccomplished`; #540 — `purposeFidelity`; refined by #551 | The **repetition** half is unbuilt: no stage asks whether a page re-tells an earlier one, and the writer is not given previous scripts. Tracked on **WS-K**. |
| F-42 | Quote spans degenerated to one and two words. | High | fixed | #545 — ≥8 words unless a complete sentence at a real boundary, checked in code | Nothing. |
| F-43 | Rule 3's keyword list rejected a page that *did* say the point was disputed. | **Critical** | fixed | #538 branch commit `91d32aa` (broadened list); #545 — the verifier judges it with the sources | Nothing. |
| F-44 | The verifier passed a source-less question page once in eleven. | Medium | fixed | #545 — decided structurally, so sampling cannot decide it | Nothing. |
| F-45 | "Narrow to what you can source" produced a false claim about the record. | High | fixed | #545 — a script asserting what the record does/does not contain needs a source whose quote says so | Nothing. |
| F-46 | The writer quoted the beat purpose back and credited it to a real publisher. | **Critical** | fixed | #545 — any quote overlapping the purpose or prompt is rejected; #540 pins the exact string as a regression | Nothing. |
| F-47 | Claude 5 runs adaptive thinking by default inside `max_tokens` caps of 400–2,000. | High | card | **WS-G** (`generation-fix-plan-2026-09-09.md`) — Named and **not** closed in #545; requirements §8.5 | `output_config: {effort: "low"}` on the per-page calls, raise the small caps, include thinking in the budget estimate. Keyed runs only — the relay never exercised it. |
| F-48 | Print evidence is the retrieval model's restatement, not fetched bytes. | Medium | card | **WS-G** (`generation-fix-plan-2026-09-09.md`) — Named in `retrievePassages`'s own doc comment (#545); requirements §8.4 | Retrieve with `web_fetch` + `citations`, hold server-attested `cited_text`, move to the `_20260209` tool types with F-47. `groundedQuoteRate = 1.0` overstates until then. |
| F-49 | Run 2 sourced zero tape for 35 beats on the archive's richest subject. | **Critical** | fixed | #552 — `account` is the default and arguments are capped in `deepenActs.ts`, plus a per-beat `sourcingTrace`; #553 — the cause half (F-06) | Both named causes are closed and **tape yield is still 0**: the next gate is the verbatim-anchor rule, F-61. |
| F-50 | A page contradicted by its own evidence had no honest move and killed the Foray. | **Critical** | fixed | #551 — selection/prose may report the tension; verifier's `purposeAccomplished` judges the subject; `purposeRevised` flags | Nothing. Run 2 attempt 2 passed 3 pages as `purposeRevised: true`. |
| F-51 | A narration beat's third rejection still failed the whole Foray. | **Critical** | fixed | #551 (keep the page `verified: false`, gate refuses) and #555 (the no-page branch) | Nothing. **#551 claimed it and left a branch standing**: run 2 attempt 2 died on exactly that branch via F-60. |
| F-52 | Tape beats never got their transcript cue window; the gatherer fell back to the null provider. | High | fixed | #551 — `WriteNarrationOptions.cueProvider`, threaded from `runPipeline` deps | Never exercised by a run: both run-2 attempts had zero tape. |
| F-53 | A tier-2 anchor named a segment absent from `data/segments.json`, failing finalize. | **Critical** | fixed | #552 — `newSegmentSources` + `audioSourceLookup.ts`; `finalizeForay` merges, `publishForay` writes both files | Never exercised by a run. Proven end to end in `tools/foray/check-forays.test.mjs`, not by live tape. |
| F-54 | The per-Foray budget cap was inert because the batch path passed no `sessionId`. | Medium | fixed | #551 — the checkpoint key is passed as `sessionId` | Nothing. |
| F-55 | Duplicate slot titles collapse in the item mapping and can trip the contiguity rule. | Low | card | **WS-J** (`generation-fix-plan-2026-09-09.md`) — Logged "Card" in the run doc. Requirements §8.6 | One-line fix: pass the resolved slot-id list into `toForayItem` instead of re-slugifying, or forbid duplicate slot titles in `spineStructure.ts`. |
| F-56 | The title is capped at 120 characters but `check-forays` rejects over 18 words. | Low | card | **WS-J** (`generation-fix-plan-2026-09-09.md`) — Logged "Card" in the run doc. Requirements §8.7 | One-line fix: cap the minted title by **words** in `runPipeline.ts`. |
| F-57 | The ±15 % runtime tolerance is documented and implemented nowhere. | Medium | card | **WS-J** (`generation-fix-plan-2026-09-09.md`) — Requirements §8.11 | Gated on a founder-approved band per tier plus a decision on the narration-length error margin. |
| F-58 | `check-narration.mjs` structurally cannot validate generated narration. | Medium | card | **WS-J** (`generation-fix-plan-2026-09-09.md`) — Requirements §8.9; #551 records *why* no checker was changed | Lift `spokenLineErrors` into `validateNarratedBeat` (a pure function over one sentence). |
| F-59 | `resolveTopic` sent an AI/ML prompt to `engineering/energy-fusion`, so lineage refused all AI tape. | High | fixed | #554 — generic-token suppression + distinctive-evidence rule in the resolver; `terms` added to that node in `data/taxonomy.json` | The **show-classification** half of the same magnet is untouched: GitHub **#547**. #554 lists what that fix should reuse. |
| F-60 | A page with no evidence still cost three claim-selection calls, then ended the run. | Medium | fixed | #555 — one rephrased retrieval retry, then degrade to an unverified page; never a selection call on zero documents | Nothing. |
| F-61 | The verbatim-anchor rule refuses every window: claims are prose, tape is speech. | **Critical** (tape yield) | card | **WS-I** (`generation-fix-plan-2026-09-09.md`) — Logged in branch commit `1a2c95e`; #553 explicitly declined to decide it | Pick the window by BM25 + overlap, then mint anchors from phrases **inside** that window's cue text; keep the lineage and overlap gates; add a relevance floor. Run 1's refused anchors stay refused. |
| F-62 | Symmetric padding to the 45 s minimum pulls ~28 s of off-claim tape in front. | Medium | card | **WS-I** (`generation-fix-plan-2026-09-09.md`) — Logged in branch commit `1a2c95e`, from #553's one successful mint | Grow the span toward the side whose next cue shares claim terms; allow a shorter segment over an off-claim lead-in. |
| F-63 | the spine never reads the tape, so its beats claim what the archive does not say; matcher now refuses correctly | Critical | fixed (unverified) | WS-L merged (#566) | attempt 4 is the first run on it; the tracker row moves to fixed when a slot sources tape |
| F-64 | `summary` was the understander's 26-word prompt restatement; the checker's 18-word rule refused the finished Foray | High | fixed | branch commit (F-64/F-65): understander asked for bounded `title`/`summary`; `forayCopy` clamps to 18 words and warns | Nothing. |
| F-65 | a zero-tape run cannot pass `check-forays` and the pipeline only found out at finalize, 76 min later | High | fixed | branch commit (F-64/F-65): `no-tape` outcome after §4.5 with the per-slot sourcing summary; CLI prints `NO TAPE` | Nothing; the tape itself is F-63/WS-L. |
| F-66 | `ttlA1Ms` measures the whole run — the partial candidate is written in stitch, after every act is narrated | Medium | fixed | #567 — stitch act *i* as it is narrated; `ttlA1` stamped at act 0; `stitch:<i>` checkpoints | attempt 5 is the first run with it |
| F-67 | the topic is resolved from the understander's paraphrase; an 8-word subject moved run 2 to `architecture/infrastructure` and the lineage gate closed on every AI episode, so WS-L produced no windows | Critical | fixed | branch commit (F-67): the user's prompt joins the topic text at both resolution sites; `engineering/ai-robotics` gains `terms` | resolver is still token overlap; a classifier is the real fix (WS-K candidate) |
| F-68 | deepen paraphrases seeded claims; the overlap floor refuses the paraphrase — 5 tape of 16 seeded | Critical | fixed | #568 — claim and seed frozen through deepen (restored mechanically, logged); tier 2 searches the seed's own window first | attempt 5 measures the yield |
| F-69 | F-60's rephrased retry is an IDF word bag, not a query; 12 of 43 retrievals in attempt 4b came back empty, one retry returned rotating-machinery papers for an on-call-rotation claim | Medium | open | — | rephrase from the purpose sentence; skip the web for seeded beats |
| F-70 | tier 2 skips the same-episode ledger (M3 order, M4 25 % share); the first Foray with tape was refused on both | Critical | fix in flight | `fix/f70-f71-tier2-episode-ledger` (agent PR) | attempt 5 |
| F-71 | the partial candidate's finalize input lacks the minted segments, so it never validates when tier-2 tape exists | High | fix in flight | same PR as F-70 | attempt 5 |
| I-01 | Budgets raised to $1000 for the run because the $2.00 default would have halted it. | — | fixed | #543 — defaults 25.00 / 10.00 and `--budget-usd`; requirements §8.13 agrees | Nothing (the per-Foray half was F-54). |
| I-02 | `FileTranscriptCueProvider` written and wired the hour before run 1. | — | fixed | #538 branch commit `e666c2a`; tests came with #546/#553 | Nothing. Run 1 tested code an hour old — a one-off, recorded. |
| I-03 | The relay transport itself: `ANTHROPIC_BASE_URL` → local relay → subagent. | — (transport) | accepted | By design of the exercise | Token counts are estimates and latency is not API latency; no KPI that depends on either is a production number. |
| I-06 | The answer helper strips one markdown fence pair before the relay sees the reply. | — (transport) | accepted | Kept; fence frequency logged separately (F-10) | Nothing. |
| I-07 | The wrapper added an anti-fabrication instruction to call #7 — a prompt deviation. | — (error) | fixed | Stopped from call #8 on; call #7's answer flagged in the KPI log | Nothing. The one prompt deviation of the exercise, and it is quarantined to a single call. |
| I-08 | `--duration medium` chosen for "about an hour". | — | accepted | §3 of the architecture maps ~60 min to *medium* | Nothing; recorded so the choice is visible. |
| I-09 | The relay dedupes identical retried requests to absorb the SDK's 10-min timeout. | — (transport) | accepted | Production never sees this path | It is what made I-23 possible; a production transport keys on the request id. |
| I-10 | The dedupe served a legitimate re-ask a stale answer, guaranteeing the retry failed. | — (harness) | fixed | Dedupe now applies only to an *in-flight* duplicate | Nothing. Cost run 1 attempt 2. |
| I-12 | `writeNarration` retry appends the rejection reasons (the F-16 fix). | — | fixed | #538 branch commit `e666c2a`; #545 accumulates the whole history | Nothing. |
| I-13 | Five code/prompt fixes applied between run-1 attempts 3 and 4, each traced to a finding. | — | fixed | #538 branch commit `e666c2a` + 6 regression tests | Nothing. Deviation by design — the brief asked for fixes between runs. |
| I-15 | The harness killed the shell wrapping attempt 4 for low system memory. | — (host) | card | **WS-J** (`generation-fix-plan-2026-09-09.md`) — Noted only; no pipeline defect | A production batch run must be detached (service or container), not a child of an interactive shell. |
| I-16 | Sourcing thresholds raised 2 → 3 mid-attempt-4 after F-33. | — | fixed | #538 branch commit `2c10407`; largely superseded by #546/#553's text-level scoring | Nothing. |
| I-17 | A subagent reported one tool use despite the "no tools" instruction. | — (harness) | accepted | No pipeline effect; the reply was a bare JSON object | A production relay should run subagents with an **empty tool set** rather than an instruction. |
| I-18 | `parseOrRepairJson` and the shared-parser consolidation, prepared during attempt 4. | — | fixed | #538 branch commit `526f672`; completed by #544 | Nothing. |
| I-19 | From call #41 the answering subagent writes its own reply into the relay. | — (transport) | accepted | Harness efficiency; the prompt the model answers is unchanged | Orchestrator latency fell 75 % → 52 % → 21 % → ≈0 %; none of that is an API-latency number. |
| I-20 | The first self-delivering subagent used its tools to fetch the web and quote it. | — (transport) | accepted | The page was kept rather than re-asked | Nothing to fix: it is the clearest demonstration that retrieval fixes F-27/F-32, and is now WS-A (#545). |
| I-21 | Haiku subagents did not perform the delivery step; the orchestrator delivered by hand. | — (transport) | accepted | Wrapper now makes the subagent start with a tool call | Reply text unchanged; not a pipeline deviation. |
| I-22 | Evidence-retrieval subagents are allowed WebSearch/WebFetch, capped at `max_uses`. | — (transport) | accepted | By design of the exercise; the relay records `tools` per request | Same limitation as F-48: the passages are the subagent's copy, not fetched bytes. |
| I-23 | The relay's in-memory body-hash dedupe deadlocked attempt 2's first call. | — (harness) | fixed | `/reset` added so the map clears with the queue | Cost ~15 min and no model calls. A production transport keys idempotency on the SDK's request id (see F-07/I-09). |
| I-24 | the normalised transcript archive was emptied mid-session by an unidentified process; regenerated from raw | High | card | WS-J (archive-count guard + data-local write audit) | identify the process; add the guard |

## 2. By status

| status | count | ids |
|---|---|---|
| `fixed` | 55 | F-01, F-02, F-03, F-04, F-06, F-09, F-11, F-13, F-14, F-16, F-17, F-18, F-21, F-22, F-23, F-24, F-25, F-26, F-27, F-28, F-29, F-30, F-31, F-32, F-33, F-34, F-35, F-36, F-37, F-38, F-39, F-40, F-41, F-42, F-43, F-44, F-45, F-46, F-49, F-50, F-51, F-52, F-53, F-54, F-59, F-60; I-01, I-02, I-07, I-10, I-12, I-13, I-16, I-18, I-23 |
| `card` | 13 | F-15 (WS-D2 + §8.8); F-05, F-47, F-48 (**WS-G**); F-61, F-62 (**WS-I**); F-20, F-55, F-56, F-57, F-58, I-15 (**WS-J**); F-19 (**WS-K**) |
| `accepted` | 13 | F-07, F-08, F-10, F-12; I-03, I-06, I-08, I-09, I-17, I-19, I-20, I-21, I-22 |
| `open` | 0 | — |
| `in flight` | 0 | — (PR #538 carries the whole branch to `main` and is the umbrella, not a per-finding row) |
| `issue` | 0 | — (F-59's show-classification half is tracked on #547 inside that row) |
| `superseded` | 0 | — |
| **total** | **81** | 62 findings + 19 non-historical interventions |

**The twelve ids that were `open` now have cards**, appended to `generation-fix-plan-2026-09-09.md` in the
plan's own shape (rationale, *Files.*, *Done when.*): **WS-G — keyed-run readiness** (F-05, F-47, F-48),
**WS-I — paraphrase-tolerant anchoring** (F-61, F-62), **WS-J — finalize-time hygiene** (F-20, F-55, F-56,
F-57, F-58, I-15) and **WS-K — narration follow-ups** (F-19, plus F-37's unwritten ruling and F-41's
repetition gap, both of which sit inside otherwise-closed rows). WS-I is the highest-value of the four and
has work in flight on `fix/f61-anchors-from-tape`, so that card records the spec and the acceptance rather
than new work. Two decisions inside WS-J stay with the founder: F-57's runtime band per tier and F-58's
severity for each lifted narration rule.

## 3. What the next run will show for the first time

Run 2 attempt 2 ended ~18:30Z. Three PRs merged after it, so **nothing has ever exercised these fixes**:

- **F-06 / F-49 (cause half)** — #553's BM25 text index reaching real *Practical AI* transcripts instead of
  stopping at the title bar.
- **F-59** — #554's resolver sending the AI/ML prompt to `engineering/ai-robotics`, which is what lets the
  lineage gate admit those shows at all.
- **F-60**, and with it **F-51's last fatal branch** — #555's rephrased retrieval retry and the degrade-to-
  unverified path, so an empty evidence pack costs zero writer calls instead of ending the run.

Two more have run but have never been *tested*, because both run-2 attempts produced zero tape:
**F-52** (the cue window reaching the writer) and **F-53** (a minted tier-2 segment surviving finalize).
Both only fire when tape flows — which, per **F-61**, it still does not.

## 4. Founder-feedback cross-reference (F15–F20, off-repo log)

The app-feedback items in `4a-feedback.md` are tracked outside this branch. Listed here so the founder has
one page; the log itself is unchanged.

| item | one-line | status | where tracked |
|---|---|---|---|
| F15 | Lock screen and car Now Playing show only "4a" — no title, artist or album. | card | `docs/ios-controls-and-voice-plan.md` card **L-06** (instrument the payload, then Apple-Podcasts parity) |
| F16 | Playback stops once, ~30 s after the screen goes off, no seam crossed. | issue + card | GitHub **#548**; card **M-03** (native interruption/lifecycle events in the record, then reproduce) |
| F17 | The Now Playing screen covered the left menu. | fixed | PR **#550** — `--z-drawer` at 80/81, the whole ladder documented in `styles.css`; card **U-12**; build 2026090908 |
| F18 | Closing Now Playing stopped playback, with no way back to it. | fixed | PR **#550** — ✕ collapses to the mini bar, Stop is its own control; card **U-13**; ride-along N1 bottom reservation; build 2026090908 |
| F19 | The "fusion" playlist mixed quantum, AI and unrelated content. | issue | GitHub **#547** — episode topics inherited from one show-level label. Same magnet as **F-59**; #554 fixed the resolver half and lists what the classifier should reuse |
| F20 | With the screen off, the car's play button does nothing. | issue + card | Appended to **#548** and card **M-03** — native receives the command, the suspended web process cannot act on it |
