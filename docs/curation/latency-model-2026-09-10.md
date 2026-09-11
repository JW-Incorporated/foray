# Foray generation — critical-path latency and manual-step model

> Companion brief to `docs/curation/foray-to-spec-roadmap.md` (the Hermes G-deck, 2026-09-10). Numbers here are the deck's sources; the deck cites this file by section.

Repo `foray`, branch `generation-run-2026-09-09` (read only). Built from the orchestration code (`backend/src/generation/*`), the seven `Anthropic*Builder.ts` files, `backend/src/config/models.ts`, `docs/curation/foray-generation-requirements.md` (§3.0, §4.7, §7, §8.5, §8.8, §9.1) and `docs/curation/generation-run-2026-09-09.md` (§0, §1b, run 2).

Every number is tagged **[measured]** (from the run doc or a stage-timing line) or **[estimated]** (from the latency assumptions in §2). Nothing keyed has ever run: every measured figure is from the subagent relay, which the run doc itself says is "not a production path".

---

## 0. The one-paragraph answer

The pipeline is already parallel in the two places the fix plan said it would be (deepen across acts, slots within an act). What is left on the critical path is a *chain*: 2 Haiku → 1 Opus → 1 Sonnet (slowest deepen act) → keyless sourcing → per slot: 1–2 Haiku retrievals → (select → prose → verify) × 1–3 attempts, and then that per-slot chain again for every later act, in series, with one continuity call between acts. That is **8–16 model calls in series before Act 1 is playable** (the design doc's WS-D said "≈ 5") and **~23–52 in series for the whole Foray**, out of ~70–100 total calls. At API latencies this is **ttlA1 ≈ 3.5–9 min typical (best ~2.5 min, worst ~15 min)** and **full run ≈ 9–22 min typical** — roughly 5–12× the 30–45 s target and 3–5× the 50k-token target (measured 140–166k). The relay accounts for the rest of the gap: at 70–200 s per call it inflated the same chain to 18 min / 76–91 min **[measured]**. The 30–45 s target is not reachable by parallelising the current stage graph; it needs an act-1 fast path (a founder decision, §3.4).

---

## 1. Call graph for a MEDIUM Foray

Shape assumed throughout: 4 acts, 6 slots (1.5 per act; the requirements' §9.1 assumption), 32 beats, ~11 tape beats (attempts 5/6 **[measured]**: 11/32 and 11/33), so ~21 narration pages plus ~8 connective pages ≈ **30 pages** (attempt 3: 33 pages for 35 beats; 4b: 28 for 33 **[measured]**).

### 1.1 Model tiers and caps (as coded on the branch)

| Builder | Tier → id (`config/models.ts:58–62`) | `max_tokens` | Tools | thinking / effort / stream / cache_control |
|---|---|---|---|---|
| `AnthropicPromptUnderstander` clarity / intent | haiku → `claude-haiku-4-5-20251001` | 400 / 600 (`:83`, `:137`) | none | none set anywhere (grep over `backend/src/`: zero hits for `output_config`, `thinking`, `stream(`, `cache_control`) |
| `AnthropicExternalResearcher.research` | haiku | 800 (`:99`) | `web_search_20250305`, `max_uses: 3` (`:41`, `:103–105`) | — |
| `AnthropicExternalResearcher.retrievePassages` | haiku | 2000 (`:45`, `:194`) | same, `max_uses: 3` | — |
| `AnthropicSpineBuilder` | **opus → `claude-opus-5`** | 8000 (`:35`) | none | Opus 5 runs adaptive thinking by default when `thinking` is omitted → F-47 |
| `AnthropicDeepenActBuilder` | sonnet → `claude-sonnet-5` | 4000 (`:29`) | none | Sonnet 5 runs adaptive thinking by default → F-47 |
| `AnthropicNarrationWriterBuilder` selectClaims / writePages | sonnet | 4000 / 4000 (`:57`) | none | same |
| `AnthropicNarrationVerifierBuilder` | sonnet | 2000 (`:55`) | none | same |
| `AnthropicContinuityBuilder` | sonnet | 500 (`:29`) | none | same — a 500-token cap under adaptive thinking is the most likely truncation (F-47) |

Every builder has a `parseWithRetry` re-ask (`parseWithRetry.ts:57`) that is a **second full call in series** when the first reply is not parseable JSON.

### 1.2 Stage-by-stage serialization (file:line = the serialization point)

| # | Stage | Calls (tier) | Series / parallel | Serialization point | On critical path |
|---|---|---|---|---|---|
| 1 | understand | 2 haiku (clarity, then intent) | series | `understandPrompt.ts:46` then `:57`; `runPipeline.ts:667` | 2 |
| 2 | research-shape | 0–8 haiku+web_search, only for catalogue-gap subtopics | parallel fan-out | `researchShape.ts:325` `Promise.all`; keyless BM25 windows run synchronously per subtopic `:437–450` | 0–1 (+ keyless 9 s **[measured 4b]**) |
| 3 | spine | 1 **opus** | single | `runPipeline.ts:717`; `AnthropicSpineBuilder.ts:97` | 1 (largest single block) |
| — | resolveTopic | 0 | sync | `runPipeline.ts:747` | ~0 |
| 4 | deepen | 4 sonnet (1/act), ×2 on an act's uninformed retry | **parallel across acts** | `deepenActs.ts:290–307` `Promise.all`; retry loop `:231` | 1 (slowest act; 2 on retry) |
| 5 | source | 0 | sync, Foray-wide (M3/M4 ledgers need every act) | `runPipeline.ts:803` | 0 (2–15 s **[measured]**) |
| 6 | gather evidence (inside 7) | 1 haiku+web_search per page; +1 rephrased retry if empty and page is Patch/Carry (F-60) | **parallel across pages of a slot**; the F-60 retry is **serial** after the first | `writeNarration.ts:377` `Promise.all`; `gatherEvidence.ts:349→358` (second query awaits the first) | 1–2 per act |
| 7 | narrate | per slot per attempt: select → prose → verify (3 sonnet); 1–3 attempts | **slots parallel within an act** (`writeNarration.ts:300`); **acts serial** (`writeNarration.ts:292`, `runPipeline.ts:957`); attempts serial (`:411`); the 3 calls serial (`:567` → `:585` → `:639`) | as listed | 3–9 per act (slowest slot) |
| 8 | stitch + continuity | 1 sonnet per act boundary (acts 2..4) | serial, and **before** that act's items are assembled | `stitchForay.ts:159` awaits `smoothActIntroduction` before `stitchAct`; runs inside the same per-act loop as narrate (`runPipeline.ts:992`) | 1 per act after the first |
| 8b | partial candidate | 0 (runs `check-forays.mjs` in-process) | serial inside `onActReady` | `stitchForay.ts:205–214` → `partialCandidate.ts:170` `await finalize(...)` | ~0 (8 ms **[measured]**) |
| 9 | finalize | 0 | sync | `runPipeline.ts:1050` | ~0 |
| batch | prompts | — | **serial across prompts** | `generateForays.ts:395` `for (const spec of queue)` | n/a |

**Critical-path call count**

- **To Act 1 playable:** 2 (understand) + 0–1 (research gap) + 1 (spine) + 1 (deepen tail) + 1–2 (retrieval for the slowest slot) + 3–9 (narration attempts for the slowest slot) = **8–16 calls in series**. Act 1 has no continuity call.
- **Whole Foray:** ttlA1 chain + 3 × [1–2 retrieval + 3–9 narration + 1 continuity] = **23–52 calls in series**.
- **Total calls:** 2 + 0–2 + 1 + 4 + ~30 retrievals (+ ~8 rephrased) + 6 slots × 3 × 1–3 attempts (18–54; measured 35–43) + 3 continuity ≈ **70–100** (attempt 3: 73, attempt 4b: 96 **[measured]** — the model matches).

Note the count is dominated by *retries*, not by stages: first-attempt page pass rate was 0.67 (attempt 3) and 0.44 (4b) **[measured]**, and any rejected page sends its whole slot through another 3-call round.

---

## 2. Wall-time estimates at API latencies

### 2.1 Assumptions (stated; all **[estimated]** unless marked)

| Call | Input | Output | Latency assumption |
|---|---|---|---|
| Haiku 4.5, no tools (clarity, intent) | <1k tok | 100–300 tok | **3–6 s** |
| Haiku 4.5 + `web_search` (retrieval, research) | ~0.5k | 0.5–1.5k (three 1,500-char passages) | 3–6 s + 1–3 searches × 5–10 s + output ≈ **12–30 s**; the F-60 second query doubles it: **25–60 s** on an empty first hit |
| Sonnet 5 deepen | ~6–8k (full spine + act) | 1.5–2.5k | **25–60 s** (15–30 s for 1–1.5k output per the brief's assumption, scaled for the larger output and default adaptive thinking) |
| Sonnet 5 select (slot) | 8–12k (up to 7 pages × 3 × 1,500-char passages + 3,000-char tape window) | 0.5–1.5k | **15–30 s** |
| Sonnet 5 prose (slot) | ~3k (claims only, no docs) | 1–2k (5 Carry scripts ≈ 200–470 tok each) | **20–40 s** |
| Sonnet 5 verify (slot) | 8–12k (evidence pack + script + sources) | 0.3–0.8k | **10–25 s** |
| Sonnet 5 continuity | ~0.5k | ~0.1k | **5–12 s** (if thinking fits in 500; a truncation costs a re-ask) |
| Opus 5 spine | ~6k (23,689-char prompt **[measured 4b]**) | ~3–5k (33 beats with seeds, voice, acts) | **60–150 s** (60–120 s for 3k output, plus default adaptive thinking at default effort; F-47) |
| Keyless | research windows 9 s, source 2–15 s, partial/final check-forays 8 ms | | **[measured]** |

Adaptive thinking is on by default for Opus 5 and Sonnet 5 when `thinking` is omitted (the branch omits it everywhere), so the per-call figures above already include some thinking; a run that hits `max_tokens` inside thinking pays a full re-ask (F-47, §8.5).

Sanity check against the relay: relay calls averaged 117 s (attempt 3: 7,750 s / 66 fresh calls) and 143 s (4b: 13,461 s / 94) **[measured]**, versus ~20–40 s assumed here for a Sonnet call → the relay inflates ~4–6×. The measured ttlA1 of 18.1 min (attempt 5) ÷ 4–6 ≈ 3–4.5 min, inside the estimate below.

### 2.2 ttlA1 (prompt → Act 1 partial candidate), keyed, today's serialization

| Segment | Typical | Best | Worst |
|---|---|---|---|
| understand (2 haiku, series) | 6–12 s | 6 s | 25 s (one re-ask) |
| research-shape (keyless 9 s ∥ 0–1 haiku web search) | 9–40 s | 9 s | 60 s |
| spine (1 opus) | 60–150 s | 60 s | 300 s (re-ask) |
| deepen (slowest of 4 parallel) | 30–70 s | 25 s | 140 s (retry) |
| source (keyless) | 2–15 s | 2 s | 15 s |
| act-1 retrieval (slowest slot; attempt 5 had 7/11 empty first queries **[measured]** → F-60 retry) | 12–60 s | 12 s | 60 s |
| act-1 narration, slowest slot: attempt 1 (45–95 s) + attempt 2 (likely at 0.44–0.67 first-pass) + attempt 3 (sometimes) | 100–250 s | 45 s | 350 s |
| stitch:0 + partial check | <1 s | | 1 s |
| **ttlA1** | **≈ 3.5–9 min** | **≈ 2.5 min** | **≈ 15 min** |

Design target: 30–45 s. Even the *best* case is 3–5× over, and the two biggest fixed costs (spine 60–150 s, one narration round 45–95 s) each exceed the whole target on their own.

### 2.3 Full run (4 acts), keyed, today's serialization

Each later act adds, in series: retrieval 12–60 s + narration 100–250 s (slowest slot, 2 rounds) + continuity 5–12 s ≈ **2–5.5 min per act** (relay: 12–33 min per act **[measured]** ÷ 4–6 ≈ 2.5–6.5 min — consistent).

| | Typical | Best | Worst |
|---|---|---|---|
| ttlA1 | 3.5–9 min | 2.5 min | 15 min |
| acts 2–4 | 6–16 min | 4 min | 25 min |
| finalize | <1 s | | |
| **Full run** | **≈ 9–22 min** | **≈ 7 min** | **≈ 40 min** |

Relay actuals for comparison: 76 min (attempt 3), 91 min (4b) **[measured]**; ÷ 4–6 ≈ 13–23 min. So **~60–70 min of each relay run is the relay**, and the pipeline's own keyed cost is ~10–20 min.

### 2.4 Where the keyed time goes (typical full run ≈ 15 min)

1. **Narration retry rounds** ≈ 6–8 min (40–50 %): each rejected page re-runs 3 serial Sonnet calls for its slot; 4 acts × ~2 rounds.
2. **Acts in series** ≈ the whole of acts 2–4 (6–16 min) is *after* Act 1 is playable — invisible to the listener only if something serves the partial (nothing does, §8.8).
3. **Spine** 1–2.5 min (10–15 %): one Opus call with a 24 KB prompt and ~4k tokens of JSON out.
4. **Retrieval** 1–4 min in series across acts (F-60's second query is serial; ~half of first queries came back empty in attempts 4b/5 **[measured]**).
5. **Deepen** 0.5–1.2 min.
6. **Tokens:** 140–166k vs ≤ 50k target **[measured]** because the evidence pack for a slot (8–12k tokens) is re-sent on every select and every verify of every attempt, and the full spine (6k) is sent to each of 4 deepen calls. Nothing is cached.

---

## 3. Changes that remove wall time, ranked HOURS → MINUTES → SECONDS

Savings are per medium Foray, **[estimated]** unless noted.

### HOURS (the founder's "orders of magnitude" is almost entirely here)

| # | Change | Saves | Files | Risk |
|---|---|---|---|---|
| H1 | **Run keyed.** Replace the relay (`ANTHROPIC_BASE_URL` → subagents) with `ANTHROPIC_API_KEY`. | **≈ 60–70 min of 76–91** (relay 117–143 s/call → 20–40 s) **[measured vs estimated]**; also removes I-03/06/09/10/17/19/21/23/25 and the ~40× harness-token overhead (`≈ 44k` subagent tokens per call **[measured]**) | none — `.env` | F-47 (thinking inside 400–2000 caps) is untested keyed; run WS-G first or accept some re-asks on the first keyed run |
| H2 | **Stop re-running whole attempts by hand.** Every attempt 1→6 was a human relaunch after a fix, with hand-replayed answers (I-05, I-11, I-14). Checkpoints now bank stages; a driver-level retry loop (resume on error, cap N) removes the human relaunch. | the hours between attempts | `cli/generateForays.ts` | none technical; the founder rule says these are defects, not process |

### MINUTES (keyed run, 10–20 min → 3–6 min full; ttlA1 3.5–9 → ~1.5–3 min)

| # | Change | Saves | Files | Risk |
|---|---|---|---|---|
| M1 | **Narrate all acts in one `Promise.all` (acts ∥, not just slots ∥).** Stitch/continuity must stay in act order (cheap: each waits for act N−1's stitched items), and the per-act checkpoint keys are unchanged. | **6–16 min of full run → ~2–5 min** (full run ≈ ttlA1 + slowest act tail). ttlA1 unchanged. | `writeNarration.ts:292` (loop → `Promise.all`), `runPipeline.ts:957–1000` (start all `narrate:i` stages, then stitch in order), tests | 18 Sonnet + ~30 Haiku calls in flight → rate limits; `BudgetGuard` is metered per call so it is fine; `usageTracking` is process-global (documented as one-run-at-a-time, still true) |
| M2 | **`output_config: { effort: "low" }` on per-page calls** (writer, verifier, continuity, understander, researcher; leave the spine at default) and raise the small caps by a thinking allowance (WS-G / F-47). | **20–40 % per Sonnet call** ≈ 40–90 s ttlA1, 2–5 min full; plus avoids the truncation → re-ask path (each re-ask is a full second call) | all `Anthropic*Builder.ts`, `config/env.ts` budget estimate, tests | verifier judgement quality — watch `firstAttemptPassRate` / `unverifiedPages` in `meta.veracity`; F-47 says a *keyed* run will otherwise truncate, so this is also a correctness fix |
| M3 | **Cut the retry tax.** Three levers, in order: (a) merge select + prose into one call (claims with quotes *and* scripts in one reply; the mechanical gate runs on the quotes afterwards, and a failed page re-runs only itself); (b) on a verifier rejection, re-run prose + verify only, not select (the selected claims already passed the substring gate); (c) treat a `purposeAccomplished: false` on a `purposeRevised: true` page as accepted rather than a round. | (a) 15–30 s per attempt per act ≈ 1–3 min full, 30–90 s ttlA1; (b) another 15–30 s per rejected round; (c) fewer rounds | `writeNarration.ts:558–676` (`runSlotAttempt`), `AnthropicNarrationWriterBuilder.ts` prompts, `NarrationWriterBuilder.ts` types | WS-A's *order of operations is the design* (select → code gate → prose). (a) keeps the gate but after prose; a rejected quote now wastes a script. (b) is safe. (c) changes what "verified" means — founder-level |
| M4 | **Shrink or speed the spine call.** Options: Opus 5 fast mode (`speed: "fast"`, 2.5× output tok/s, $10/$50 — Opus-only); `effort: "medium"`; reference research windows by index instead of re-emitting `episodeId/startSec/endSec` per seed; or Sonnet 5 for the spine. | **30–90 s ttlA1** | `AnthropicSpineBuilder.ts`, `config/models.ts` | "the single most consequential call" (§4.3) — Sonnet is a founder decision; fast mode is a research preview with its own rate limit |
| M5 | **Run the two retrieval queries concurrently** (first + rephrased) instead of serially, or cap `max_uses` at 2. | 12–30 s per slot whose first query is empty (≈ half of slots **[measured]**) → 30–90 s full, 12–30 s ttlA1 | `gatherEvidence.ts:348–359` | one wasted Haiku call (~$0.02) when the first query succeeds; F-69's empties are real, so this is the common case |
| M6 | **Gather evidence for every act right after `source`, in one fan-out**, instead of inside each act's `writeSlot`. Seeded claims are frozen at the spine (F-68), so their retrieval can start **during deepen**. | 12–60 s per later act (already covered by M1 if acts go parallel); **12–30 s ttlA1** for the seeded-claim head start | `runPipeline.ts` (new stage between `spine`/`deepen` and `narrate`), `writeNarration.ts:377`, `gatherEvidence.ts` | claims that deepen rewrites miss the cache and retrieve twice (cost, not time); cache key is the claim hash |

### SECONDS

| # | Change | Saves | Files | Risk |
|---|---|---|---|---|
| S1 | **Prompt caching**: put the slot's evidence block first and mark it `cache_control` so select, verify and every retry read it from cache; cache the spine prefix shared by the 4 deepen calls. | TTFT 1–3 s per call; **input tokens −40–60 %** (the main lever on the 50k target, since the same 8–12k pack is sent 2× per attempt) | `AnthropicNarrationWriterBuilder.ts`, `AnthropicNarrationVerifierBuilder.ts`, `AnthropicDeepenActBuilder.ts` | minimum cacheable prefix is model-dependent (512–4096 tokens) — the per-slot pack qualifies, the continuity prompt does not; parallel deepen calls may not hit until the first completes |
| S2 | **Haiku verifier** (and Haiku for slots that are all-connective — WS-D1's `NARRATION_CONNECTIVE_MODEL` was never built; connective pages are batched into the same Sonnet call today, so a separate Haiku path only helps when the slot has no content pages). | verify 10–25 s → 3–8 s per round ≈ 15–50 s per act | `createNarrationVerifierBuilder.ts`, verifier builder | F-27's junk-passing verifier is why WS-A exists; Haiku 4.5 is last-generation — gate on veracity metrics |
| S3 | **Structured outputs / strict JSON** (`output_config.format`) to eliminate `parseWithRetry` re-asks. | 0 typically; 15–150 s when a re-ask fires (subagents fenced ~half the time; a keyed model less, but F-47 truncations make it likelier) | all builders, `parseWithRetry.ts` | none material |
| S4 | **Streaming** (`messages.stream`) with per-slot partial emission. | does not shorten a call; removes the SDK 10-min timeout risk and lets the player start on the first *slot* rather than the first act (~half of act 1's narration wait) | builders, `stitchForay.ts` `onActReady` granularity, player | the partial candidate's `check-forays` validation is per act; per-slot partials need a relaxed gate |
| S5 | **Merge clarity + intent into one Haiku call** (one JSON with both). | 3–6 s ttlA1 | `AnthropicPromptUnderstander.ts`, `understandPrompt.ts` | §4.1's "safety, then clarity, then intent" ordering is a doc rule; safety is keyless and stays first |
| S6 | Deepen act 1 first, others in background — **not worth it**: sourcing is Foray-wide (M3/M4 ledgers, `sourceBeats.ts`) so act 1 cannot be sourced until all acts are deepened; saves only the parallel tail (10–20 s). | 10–20 s | — | — |

### 3.4 What the target actually needs (founder decision)

Summing the best of M2–M6 and S1–S5 with today's stage graph gives **ttlA1 ≈ 1.5–3 min** (2 haiku 6 s → 1 haiku 4 s; spine 40–90 s; deepen 20–40 s; source 5 s; retrieval 12–30 s; one merged write 20–40 s + Haiku verify 5 s). The floor is set by *spine + deepen + one write round ≈ 90–180 s*, not by parallelism. Reaching 30–45 s requires an **act-1 fast path** — a short spine-lite for act 1 (Sonnet, effort low, 1 act) that starts playing while the full Opus spine and later acts build behind it — which bends §6.1's "the spine is frozen" invariant and is a design ruling, not an engineering ticket.

---

## 4. Manual steps in today's operation of a run

Founder rule: every step a human or an orchestrating session has to do by hand is a defect. Sources: run doc §1b (I-01…I-25), requirements §7, §6.5, §8.8, and the launch mechanics observed on this branch. "Needs" = the smallest thing that would automate it: **credential**, **server**, **code**, or **founder decision**.

| # | Manual step today | Evidence | Needs |
|---|---|---|---|
| 1 | Provide an Anthropic key: `ANTHROPIC_API_KEY` is unset, so `create*()` returns stubs (`env.ts:168`) and every real run went through the relay | §7.4/§7.5; founder plan "the key is the missing one" | **credential** + **founder decision** on whose key and the daily/per-Foray caps (`DAILY_BUDGET_USD`, `EPISODE_BUDGET_USD`) |
| 2 | Operate the relay: start `relay.mjs`, set `ANTHROPIC_BASE_URL`, dispatch one subagent per request, hand-deliver Haiku replies (I-21), `/reset` on deadlock (I-23), watch the session's 200-search cap (I-25) | I-03, I-06, I-09, I-10, I-17, I-19, I-21, I-23, I-25 | **credential** (retire the relay) |
| 3 | Set budget env / `--budget-usd` per run | I-01 (defaults were $2/day); now $25/$10 | **founder decision** on production caps; then a fixed config |
| 4 | Author `--prompts <file>.json` by hand and remember `--duration medium` (default is `short`, I-08) | §7.1 | **server** (the prompt should arrive from the app) + **code** (default tier) |
| 5 | Launch `npm run generate-forays` from `backend/` in an interactive shell on the founder's PC; the harness killed the shell once (I-15) | I-15 | **server** (detached service/container; Path B decision 1: hermes-vm vs founder box) |
| 6 | Keep `data-local/transcripts/normalized/` (1,713 bodies) present on the one machine; it was silently emptied mid-session and regenerated by hand (I-24) | I-24, §7.5 "machine-local, gitignored" | **server** holding the archive (or object storage — the transcript-farm plan) + **code** (body-count guard, card WS-J) |
| 7 | Evidence cache `data-local/evidence/` and the text index cache are machine-local; a run elsewhere re-pays retrieval | `evidenceCache.ts`, §3.7.3 | **server**/shared store (accept if one server runs everything) |
| 8 | Replay previous attempts' answers by hand (`reuse.py`, I-05/I-11/I-14) and decide `--no-resume` | I-05, I-11, I-14 | **credential** (replays only existed because relay calls cost minutes); checkpoints already cover resume |
| 9 | Re-run after a failure: the driver prints "checkpoint kept … — re-run to resume" and waits for a human | `generateForays.ts:292`, §3.3.4 | **code** (driver retry/resume loop with a cap) |
| 10 | Watch the run and stop it by hand when the partial candidate is refused (attempt 5 stopped after act 1; attempt 6 paused after source) | run 2 attempts 5–6 | **code** (a refused partial aborts or re-plans automatically; the partial already runs `check-forays`) + **founder decision** on abort-vs-continue |
| 11 | Diagnose finalize refusals from `report.json` (F-64 summary words, F-70 M3/M4, F-73 D2/D3/D5, F-74 `dai_suspected`) after paying for the whole run | run 2 attempts 3–5 | **code** (push each rule to the earliest stage that can check it — partly done for F-64/F-70/F-73) |
| 12 | Fix code between attempts and merge PRs (I-12, I-13, I-16, I-18, #551–#569) | §1b | engineering, not operations — but merges are founder-gated by branch protection: **founder decision** (the standing near-zero-founder-merges rule / agent-overlord) |
| 13 | Pin `topic` by hand when the run returns `unresolved-topic` | §3.0 outcomes, `runPipeline.ts:749` | **code** (resolver) or accept as a rare terminal outcome surfaced in-app |
| 14 | Re-prompt by hand on `needs-clarification` | `runPipeline.ts:680` | **server** + app UI (this is the listener's step, not an operator's) |
| 15 | Set thinking/effort and caps before the first keyed run (F-47) or the first keyed run may truncate JSON | §8.5 | **code** (WS-G) |
| 16 | Serve the partial candidate: it is written to a file and **nothing serves it** — no HTTP server in the repo | §8.8, F-15 | **server** + **4 founder decisions** (where it runs, spend, review gate for the testing track, CSP `connect-src`) |
| 17 | Run `npm run publish-foray -- --input <candidate>` by hand | §6.5, §7.2 | **code** (driver calls publish on a passing candidate) |
| 18 | `git` + `gh` authenticated on the machine that publishes | `publishForay.ts:181–205` | **credential** on the server |
| 19 | Decide `--force` when the veracity gate refuses | `publishForay.ts:126–135` | **founder decision** on thresholds; no human in the loop otherwise |
| 20 | Founder reviews the PR, removes the `hold` label (or merges); `automerge-nightly.yml` will not touch it while held | `publishForay.ts:204–206`, §1.3 phase 1 | **founder decision** (phase 2 = hold comes off; who reviews — Kevin-style agent against `meta.veracity`?) |
| 21 | CI `check-forays` on the PR; a red check needs a human | `tools/foray/check-forays.test.mjs` | none if 11 is done (the same checker already ran locally) |
| 22 | Merge to `data/` so the app (which reads only `data/forays.json` + segments + sources) sees the Foray | §6.6 | same as 20 |
| 23 | Curator review of minted tier-2 segments (`needs_review: true`) and `dai_suspected` sources (F-74); `verify-source-audio.mjs` by hand | `finalizeForay.ts:165–179`, F-74 | **founder decision** (publish with `needs_review`?) + **code** (audio verification in the pipeline) |
| 24 | Notice that a run died: no alert, no notification (I-15 lost the completion signal) | I-15 | **server** + notification hook |
| 25 | Choose a new id when `finalizeForay` throws on a duplicate id in `data/forays.json` | `finalizeForay.ts:197` | **code** (suffix or supersede automatically) |
| 26 | Budget stop (`BudgetStopError`) → a human re-runs with a higher cap | `runPipeline.ts:580` | **founder decision** on caps; then **code** (auto-resume when the daily window resets) |

Of the 26: **6 vanish with a credential** (1, 2, 8, 18 and most of 3/15 once keyed), **7 need a server** (5, 6, 7, 14, 16, 24, plus 4), **8 are code**, and **6 are founder decisions** (caps, spine model, abort policy, `--force` thresholds, the review gate / who drops `hold`, `needs_review` publishing). The only step that *should* remain manual by design is the founder's editorial review (#20) — and the founder's own rule puts even that on the decision list.

---

## 5. Measured vs estimated — summary table

| Quantity | Measured (relay) | Estimated (keyed, today) | Estimated (keyed, after M1–M6/S1–S5) | Target |
|---|---|---|---|---|
| ttlA1 | 18.1 min (attempt 5) | 3.5–9 min | 1.5–3 min | 30–45 s |
| Full run | 76 min / 91 min | 9–22 min | 3–6 min | — |
| Calls in series to Act 1 | — | 8–16 | 5–7 | "≈ 5" |
| Total calls | 73 / 96 | 70–100 | 40–60 | ~28 (§9.1, first-attempt-pass assumption) |
| Pipeline tokens | 139,803 / 166,475 | same | ~60–90k (caching cuts billed input, not sent tokens) | ≤ 50k |
| Per-call latency | 117–143 s mean | 3–6 s haiku, 15–60 s sonnet, 60–150 s opus | — | — |
| Human interventions per run | I-01…I-25 | ~26 manual steps (§4) | — | 0 |
