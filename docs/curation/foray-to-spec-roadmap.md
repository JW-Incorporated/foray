# Hermes deck: Foray generation to spec — supply, finish line, cycle time

**Status:** plan for Hermes to cut into kanban cards; revised 2026-09-10 after an
adversarial critique (four lenses, 70 findings; every blocker and major applied,
every minor applied or declined with a reason in §11). Written by the founder's
Claude session (the "agent overlord" for this effort), from Wyatt's brief below,
the run ledger `docs/curation/generation-run-2026-09-09.md` (F-01…F-74,
I-01…I-25), the tracker `docs/curation/generation-findings-tracker.md`, the fix
plan `docs/curation/generation-fix-plan-2026-09-09.md` (WS-A…WS-L), the
requirements `docs/curation/foray-generation-requirements.md`, and the five
briefs that ship in the same PR as this deck (§12). Companion to
`docs/search-plan.md` (S-cards), `docs/ui-transition-plan.md` (U-cards),
`docs/ios-controls-and-voice-plan.md` (L-/V-/D-cards),
`docs/bundled-voice-plan.md` (K-cards) and `docs/release-lockstep-plan.md`
(R-cards); this deck's cards are **G-**.

The rule that governs every card, from `CLAUDE.md`: **measured beats inferred.**
Every number carries a tag and a source. Keyed latencies are **[estimated]** —
nothing keyed has ever run. Where a number is a reading of text rather than an
instrument, it says **JUDGED**. Where a card needs something no agent can
supply, it names the human gate.

---

## 0. The brief, verbatim

Wyatt, 2026-09-10 (five messages over one session, in order):

> "why do we still exclude DAI suspected shows? I thought we had a workaround
> there. Also, what if we just pad the timing a little bit? seems like too blunt
> of an approach to just ignore all dai shows. can we get access to that full
> catalog that joey has been working on? the reasons for collapsing seem weak,
> can we improve?"

> "revisit the post mortem of these foray building efforts. It seems the time
> and effort taken to make a foray is orders of magnitude worse than our targets.
> we need a roadmap to spec here. please create a detailed plan of items for us
> to fix to drive us into spec. please scope this out as an .md file I can point
> hermes towards so he can do a lot of the heavy lifting on this"

> "more on the available list of shows: I don't want any bandaid fixes here.
> Whatever joey is producing should be accessible by the production version of
> 4a. you should consider every step that you need to do yourself as an error,
> this whole thing should be automated. spin off as many agents as you need to
> get us there. In all of this, assume the agent overlord role"

> "what have we learned about cataloging? if the shows were organized better
> ahead of time, would that have resulted in a notable speed up? … triage,
> aiming for speed ups first on the order of hours, then minutes, and eventually
> seconds. don't worry about some 5s improvement now when it takes you a full day
> to unsuccessfully produce a foray. that said, if there are lessons learned that
> we can feed into joey's cataloging efforts, we need to capture them and
> communicate them to joey"

> "perhaps it makes the most sense to first get one across the finish line, then
> focus on speed. Perhaps the priorities should loosely be: 1) enable forays to
> pull from the full list of transcribed podcasts, 2) get one or two forays all
> the way across the finish line with minimal deviations from the baseline
> production process, 3) drive foray generation cycle time down through the
> floor. Of course if there's work that's easy to do in parallel then let's do
> it, and if there's some issue that drives cycle time up by 10 hours then let's
> address that up front"

Those five messages are the spec for this deck. Its phases are Wyatt's three
priorities in his order; every card carries an **H / M / S** tag (hours,
minutes, seconds — the triage class of what it saves) next to its **S / M / L**
size; and its definition of done is **no human and no orchestrating session in
the loop** from prompt to a published Foray, with the one retained editorial
keystroke made Wyatt's decision (D4), not the deck's.

---

## 0.1 Direct answers to the first message

Each answer is three lines and a card. The long analysis is in the brief it
cites.

**"Why do we still exclude DAI-suspected shows?"** Because the operative
exclusion was never rule #65. PR #571 relaxed check-forays rule #65 only, and
that relaxation is **inert in practice**: no injecting-show transcript ever
reaches the pipeline that would mint such a segment. The exclusion that acts is
the transcript **fetch** — `tools/segments/fetch-transcripts.mjs:168`
`isAnchorableShow()` skips DAI-flagged shows unless they measured clean. And it
is not "all DAI shows": of 146 flagged shows only 20 ship timed transcripts,
7–8 of those measured ad-free and are already the archive's largest source
(7 by `dai-classification.json`, 8 by `transcript-availability.json`'s flag —
Practical AI, Being an Engineer, …), and **11 injecting shows hold the 6,594
excluded transcripts** (SYSK 2,857, Odd Lots 1,256, …) [measured, DAI brief §2].
Those 11 are **locate-required, not paddable**: 10 are Triton with 5–16 min of
mid-rolled displacement; the 11th (5-4, RedCircle, 45 episodes, ~68 s median)
is the only one that even screens paddable and needs decode-and-compare first.
So the exclusion **must stay for locate-required tape until the locate step
exists** (G-41); what changes now is that the gate becomes the *measured tier*
instead of the host flag (G-12, G-14), and the fetch stops being the gate
(G-11). Full answer: `docs/curation/dai-playback-brief-2026-09-10.md`.

**"I thought we had a workaround there."** The workaround (content anchors,
ADR-0007) is real and is why authored segments will still be correct when the
locate step exists — but it is authoring-side durability only. Nothing at
playback reads an anchor: `locateStep()` returns `{ implemented: false }`
(`player/seek-policy.js:230`), and a DAI segment today is seeked, measured
against the reference copy, and **skipped** if it drifted > 30 s. ADR-0007
said so on the day it was accepted (lines 168–173).

**"What if we just pad the timing a little?"** The pad's *decision* half is
built (ADR-0008's pad tier in `seek-policy.js` / `foray-queue.js`, off by one
option); **the missing part is the measurement side**: N ≥ 2 same-episode
probes exist for exactly one show (Gastropod), Megaphone's `length="0"` needs
decode-and-compare, pads are per episode and must refresh as campaigns change,
and the native iOS backend has no DAI logic at all. A ≤ 120 s pad covers the
mid-host tier (Gastropod-class, 30–100 s, varies per download) — **≤ 45 of the
6,594 excluded transcripts (0.7 %)**. Its real value is giving the locate step
its search window. Cards: **G-40** (pad, Phase 1b) and **G-41** (locate,
Phase 1b, blocked on D5).

**"The reasons for collapsing seem weak."** They are weak *as printed*: the
trace reports the furthest candidate's gate, not the seed's, so a seed refused
by the M4 episode cap at weighted share 0.746 prints as `window-overlap (0.27)`
on another episode. That and two more mechanical bugs (G-24) recover 3 beats
and remove the one wrong-tape beat. The other 14 collapses are real: every
refused window was read (JUDGED) and the archive does not say those claims
(12 off-claim, 2 adjacent). The lever is seeding (G-25) and supply (Phase 1),
not the floor — no floor value admits a single on-claim unseeded window
[measured, tape brief §3].

**"Can we get access to Joey's full catalogue?"** We have it, read-only over
Tailscale (`foraycorpus` on foray-db, role `wyatt_readonly`). It is a **URL
index, not an archive** (0 of 1.23 M transcript rows fetched), it lacks the
primary `<enclosure>` URL for 90 % of episodes, and its crawl has succeeded on
0.57 % of feeds [measured, corpus brief §0, §5]. Phase 1 is what "accessible
by the production version of 4a" takes; the six asks in §8 (G-17) are what the
corpus itself must add.

---

## 1. Where it stands (measured 2026-09-10, times UTC)

### 1.1 Two days, eleven attempts, zero published Forays

Every run so far went through the **test-drive relay** (`ANTHROPIC_BASE_URL` →
a local relay → one Claude Code subagent per model call, requirements §4.7),
because no Anthropic API key exists anywhere in this project — not in the shell,
not in the repo's Actions secrets (`gh secret list` holds only the
store-signing secrets [measured]). Relay calls averaged **117 s** (attempt 3:
7,750 s / 66 fresh calls) and **143 s** (attempt 4b: 13,461 s / 94) [measured,
latency brief §2.1], range 70–200 s, against **[estimated]** API latencies of
3–6 s (Haiku), 12–30 s (Haiku + web search), 15–60 s (Sonnet), 60–150 s (Opus).
The orchestrating session dispatched every call by hand.

| Run / attempt | When | Wall | Calls | Outcome | Deciding finding |
|---|---|---|---|---|---|
| Run 1, attempts 1–4 (disasters prompt) | 09-08/09 | up to 2 h 35 m | 103 | failed at beat 23 of 31 | writer quotes with nothing to quote from (F-14…F-46) |
| Run 2, attempt 1 (AI-systems prompt) | 09-09 15:51–16:24 | 33 m | — | failed at act 1 | purpose contradicted by evidence, third rejection fatal (F-50, F-51) |
| attempt 2 | 17:50–18:30 | 40 m | — | failed at act 1 | empty retrieval was fatal (F-60) |
| attempt 3 | 20:21–21:37 | 76 m | 73 | narration complete, **refused** by `check-forays` | 26-word summary (F-64), zero tape (F-65) |
| attempt 4a | 21:52 | 5 m | 2 (stopped before the 3rd) | stopped at spine | no tape windows: topic mis-resolved (F-67) |
| attempt 4b | 22:05–23:36 | 91 m | 96 | first Foray **with tape**, refused | same-episode order and 40 % one-episode share (F-70); partial plumbing (F-71) |
| attempt 5 | 09-10 00:05–00:31 | 26 m | 51 | stopped after act 1 | partial fails duration rules and DAI rule #65 (F-73, F-74) |
| attempt 6 | 01:12–01:46 | 10 m | ≈ 18 (2 replayed + 1 spine + 4 deepen + 11 retrieval; run doc) | **paused** after sourcing | the session's web-search budget hit 200/200 (I-25) — a harness cap, not a pipeline fault |

All counts are from `generation-run-2026-09-09.md` §2 and §1b. Attempt 6's
beat count is **33 per the run doc and 32 in the checkpoint** the tape-yield
brief replayed; this deck uses the checkpoint's 32 wherever it quotes G-24/G-25
yields, and says so. Attempt 6's checkpoint holds understand, research-shape,
spine, deepen and source (11 tape beats, 10 minted *Practical AI* segments,
mean 135 s) and is resumable; it was **not** resumed in that session because
resuming it meant another 60–90 minutes of a person dispatching subagents,
which is the manual step the brief calls an error.

### 1.2 The spec, how far off it is, and what this deck actually reaches

Targets are the fix plan's (§0 table and WS-D), plus three rows marked
*proposed* that need Wyatt's confirmation (**D0**). The "reachable with this
deck?" column is the honest one: where the deck's own analysis says a target
is out of reach, it names the founder decision that re-baselines it.

| Metric | Best measured so far | Target | Reachable with this deck? | Cards |
|---|---|---|---|---|
| Prompt → Act 1 playable (`ttlA1Ms`) | 18.1 min on the relay (attempt 5, `report.json`) | ≤ 30 s p50 at API latency (fix plan WS-D) | **No.** [estimated] today's stage graph keyed: 3.5–9 min; after every M/S change in Phase 3: **1.5–3 min**, floor = spine + deepen + one write round ≈ 90–180 s. 30–45 s needs an Act-1 fast path (G-38), a design ruling Wyatt has not made → **D6 re-baseline: accept ≤ 3 min p50 for this deck, or fund G-38** | G-32…G-38 |
| Prompt → finished, validated Foray | 76–91 min on the relay; never validated | *proposed*: ≤ 6 min p50 keyed after Phase 3 (the brief's post-optimisation range is 3–6 min) | Yes, [estimated] 3–6 min; today's keyed pipeline 9–22 min typical (best 7, worst 40) | G-30…G-37 |
| Prompt → **published** Foray, no human | never | *proposed*: the same clock plus CI; zero operational steps, one editorial keystroke per Foray retained by design (D4) | Yes, once D1, D2, D4 are decided | G-20…G-22 |
| First-attempt page pass rate | **0.67 (attempt 3), 0.44 (attempt 4b)** — `report.json firstAttemptPassRate` | ≥ 80 % | Partly: G-34 cuts the *cost* of a rejection; the rate itself depends on evidence quality (F-69's empties) and is measured, not promised | G-34, G-35, G-02 |
| Pages verified by end of run (context for the row above) | 30 of 33 (attempt 3), 22 of 28 (attempt 4b) | — | — | — |
| Narration calls per beat | **1.0 per beat / 1.06 per page** (attempt 3); 1.30 per page (4b) | ≤ 1.5 | Met on attempt 3; hold it | G-34 |
| Grounded-quote rate | 86/86, 71/71 (by construction since WS-A) | 100 % | Met | — |
| Tape beats per medium Foray | 11 of 32 (attempt 6 checkpoint), from **one** show | *proposed*: ≥ 40 % of beats; the "from ≥ 3 shows" half is **deferred until G-18 measures topic depth** | Beats: yes for the run-2 fixture — ≥ 14 with G-24 (measured replay), 18–24 with G-25 (JUDGED, +0.9 per extra seed). Shows: unknown until G-18 → **D0** | G-24, G-25, G-18 |
| Tape anchors on-topic | 5/5 (attempt 4b, `report.json tapeRelevance`); attempt 6: **10/11 by reading the cue text** (tape brief §2, JUDGED — no automatic reading exists, the run paused before narration; the 11th is the Hyatt Regency wrong-tape beat) | ≥ 90 % | Yes; G-24 R2 removes the one wrong tape | G-24 |
| Pipeline tokens per Foray | 139,803 (attempt 3), 166,475 (4b) — `report.json`, **relay-billed, so adaptive-thinking output tokens are absent** | ≤ 50 k for 3 acts | **No.** [estimated] ~60–90 k after caching (caching cuts *billed* input, not sent tokens). 50 k needs a smaller stage graph → **D6 re-baseline: ≤ 90 k billed, or accept the target as aspirational** | G-37a |
| **Cost per Foray** (new row) | never measured (the relay bills nothing); **[estimated] ≈ $1–4 per attempt** at current list prices, §7 | *proposed*: measured from `usage` on every keyed run; fits inside `EPISODE_BUDGET_USD` $10 | Yes — G-20's first keyed run replaces the estimate | G-20, G-42a |
| Shows the pipeline can draw tape from | 22 show directories, 5,041 bodies on this PC at 13:26Z (2,857 of them SYSK from the all-timed fetch, which finished 04:45Z); **1,713 curated bodies** after the I-24 regeneration; **17** directories at the time of the run | every English show with a timed transcript in Joey's corpus: 442 k episodes / 1,967 podcasts (323 k / 1,185 with audio too) [measured, corpus brief §2–3] | Only as *authorable* supply. **Playable** supply after the DAI tier is unmeasured and plausibly a small minority: 79 % of transcript rows are `api.omny.fm` (Triton), the class that is 5–16 min displaced → G-19 measures it; most of the Omny supply waits on G-41 | G-10…G-14, G-19, G-41 |
| **Playable tape supply after DAI tier** (new row) | unmeasured; in 4a's own inventory 6,594 of 7,504 DAI-flagged timed transcripts (88 %) are locate-required | — | Measured by G-19 before G-11's backfill | G-19 |
| **Topic depth for the two fixed prompts** (new row) | AI systems: **1** show with bodies (Practical AI, 63); disasters: Causality (12 bodies) + pool segments | *proposed*: ≥ 3 shows with ≥ 20 timed+audio episodes per prompt node | Unknown — **G-18 measures it first**, and its answer decides whether Phase 1 changes prompt 2's supply at all | G-18 |
| Manual steps per run | 26 enumerated in §1.5 (latency brief §4) | **0 operational**; the per-Foray editorial flip is retained only if D4 says so | Yes: 26 rows → 26 cards or decisions (§1.5 is the acceptance) | all |

Per-page quality is close to spec already (the WS-A…WS-L fleet did that work).
What is orders of magnitude off is **time, supply and automation** — and those
three are one problem: the pipeline runs on one PC, through a stand-in
transport, against an archive that lives only on that PC.

### 1.3 Post-mortem (the second message)

The time accounting, from the cataloguing brief §2 (MEASURED wall, INFERRED
attribution), over the **≈ 8.0 h of run wall-clock** across the eleven attempts
of 2026-09-08…10:

| Cause class | Run wall | What it was |
|---|---|---|
| (a) catalogue / organisation | **≈ 1 h direct** (run 2 att 2, att 4a, the F-74 half of att 5) **+ ≈ 2 h off-run** (I-24 archive wipe) **+ co-cause in ≈ 2.8 h** (every zero-tape attempt) | topic labels/vocabulary, per-host DAI flag, no text index or windows, one-show archive, archive integrity |
| (b) pipeline logic | **≈ 5.3 h** | evidence-first narration (F-14…F-46), fatal-page branches, finalize rules never mirrored in sourcing, deepen paraphrase |
| (c) harness / manual operation | **≈ 1.8 h** | relay transport (≈ 83 min of orchestrator latency in run 1), session search budget, host memory |

Reconciliation, so the two halves of this deck do not contradict each other:
the **5.3 h of pipeline logic is behind us** — WS-A…WS-L closed it, and per-page
quality is at spec. What remains, and what §2 triages, is transport (the relay),
supply (one show) and automation (26 manual steps) — none of which is a
pipeline-logic defect. "Notably faster with a better catalogue" is true (the
zero-tape wall would not have existed; two finalize refusals would have been
non-events); "dominantly" is not (7 of 11 attempts died on logic no catalogue
touches).

### 1.4 Live state at revision time (2026-09-10 13:30Z)

- **PR #573** (merge main into `generation-run-2026-09-09`) merged
  2026-09-10T04:20:24Z. **PR #538** was MERGEABLE from then until **PR #576**
  (S-01, `app.js` + `deploy-manifest.json` + `sw.js`) landed on main at
  06:13Z; measured now, `git merge-tree origin/main origin/generation-run-2026-09-09`
  reports **conflicts in `deploy-manifest.json` and `sw.js` only** (both
  generated files — regenerate, do not hand-merge), 3 behind / 100 ahead. G-00
  is the fix.
- **The SYSK all-timed transcript fetch is complete on the founder's PC:**
  2,857 SYSK bodies written 03:47–04:45Z (equal to SYSK's timed-transcript
  count in `transcript-availability.json`); 5,041 bodies in 22 directories at
  13:26Z; no writes since 04:54Z. `data/transcript-digests.json` and
  `breadth-transcript-digests.json` carry **0 SYSK rows**, so tier-2 sourcing
  cannot see those bodies yet. **Nothing may add them to a digest before G-14's
  tier gate lands** — ADR-0008 decision 5 ("author now, play later") must stay
  out of published Forays while `locateStep().implemented === false`, or
  listeners get "N segments can't play" banners on every SYSK segment (expected
  skip rate on those shows: 100 %, DAI brief §1).
- **The 2026-09-10 Foray for Wyatt is being produced through the relay right
  now** (`relay.mjs` + `generate-forays` processes running at 13:26Z). That run
  is a manual transport, hand-dispatched, on the founder's PC — named in G-20 as
  the last relay run, with the card that retires it.
- **I-27 (new, harness):** at ~06:15Z the orchestrating Claude session hit its
  usage limit for ~7 hours, killing every agent and stalling the relay run. This
  is the same error class as I-15 (shell killed), I-23 (relay deadlock) and I-25
  (search budget): a harness in the loop of a production run. A keyed, detached
  run (G-01 + G-30) retires the class; the deck counts it as manual step 2 in
  §1.5.
- **Hermes deck audit** (`deck-audit`, 2026-09-10): UI deck **12/13** done
  (U-11 records incomplete); release deck **7/8** (R-08 is a founder console
  action); iOS deck: **L-05, L-06, M-03 not started**, L-02 partial;
  bundled-voice **K-cards 0/7** and search **S-cards 0/8** are Hermes's active
  work (S-07's HUMAN-ACTIONS #43 branch exists, unmerged). This deck competes
  with those two for Hermes's attention; §9 says which G-cards are Hermes's and
  which are the overlord's, and most of the pipeline cards are the overlord's
  because they sit in `backend/src/`.

### 1.5 Every manual step, and the card that removes it

The brief's rule: every step a person or an orchestrating session does by hand
is a defect. The 26 steps are the latency brief's §4 table; **N rows → N cards
or decisions is the acceptance for this deck.** "Retained" appears once, and it
is Wyatt's call.

| # | Manual step today | Removed by |
|---|---|---|
| 1 | Provide an Anthropic key (`ANTHROPIC_API_KEY` unset → stub builders) | **D1 → G-01** |
| 2 | Operate the relay: start `relay.mjs`, dispatch one subagent per call, hand-deliver Haiku replies (I-21), `/reset` on deadlock (I-23), watch the 200-search cap (I-25), survive the session's usage limit (I-27) | **G-01** (the relay is retired by the credential) |
| 3 | Set budget env / `--budget-usd` per run | **D1** (production caps), then a fixed config in **G-01** |
| 4 | Author `--prompts <file>.json` by hand; remember `--duration medium` (default `short`, I-08) | default tier: **G-30**; a prompt arriving from the app is a product feature this deck does not build (the Create page's Foray option is `disabled`, U-06) — recorded, out of scope |
| 5 | Launch from an interactive shell on the founder's PC (I-15) | **G-30** (detached service) on the host **D2** chooses |
| 6 | Keep `data-local/transcripts/normalized/` present on one machine (I-24) | **G-14** (store + integrity guard), fed by **G-11** |
| 7 | Evidence cache and text-index cache are machine-local | **G-14** (accepted if one host runs everything, D2) |
| 8 | Replay previous attempts' answers by hand (`reuse.py`, I-05/I-11/I-14) | **G-01** (replays existed only because relay calls cost minutes; checkpoints cover resume) |
| 9 | Re-run after a failure ("checkpoint kept — re-run to resume") | **G-30** |
| 10 | Watch the run; stop it by hand when the partial is refused | **G-30**; abort-vs-continue policy is **D4** |
| 11 | Diagnose finalize refusals from `report.json` after paying for the run | **G-31** |
| 12 | Fix code between attempts; hand-merged PRs | the standing agent-overlord rule (§9): the overlord labels and merges founder-lane PRs under standing approval; no founder merge per attempt |
| 13 | Pin `topic` by hand on `unresolved-topic` | **G-13b** (resolver from corpus terms); otherwise surfaced as a terminal outcome |
| 14 | Re-prompt by hand on `needs-clarification` | this is the listener's step, not an operator's; needs the in-app prompt (step 4) — out of scope, recorded |
| 15 | Set thinking/effort and caps before the first keyed run (F-47) | **G-02** |
| 16 | Serve the partial candidate (nothing serves it; no HTTP server in the repo) | Phase 3 first-listen track: **G-37d** (per-slot streaming) + **D2** (host) + **D6** (G-38); the Phase 2 baseline publishes finished Forays and does not need it |
| 17 | Run `npm run publish-foray` by hand | **G-21a** (driver publishes a passing candidate) |
| 18 | `git` + `gh` authenticated on the publishing machine | **D2** (credential on the host), **G-16** |
| 19 | Decide `--force` when the veracity gate refuses | **D4** (thresholds); no human otherwise |
| 20 | Founder reviews the PR / removes `hold` | **G-21a** + **D4** — **the one retained keystroke (draft → published) if Wyatt keeps it** |
| 21 | CI `check-forays` red on the PR needs a human | **G-31** (the same checker already ran at sourcing) |
| 22 | Merge to `data/` so the app sees the Foray | **G-21** (a green `data/`-only PR with no blocking label already auto-merges) |
| 23 | Curator review of minted tier-2 segments (`needs_review`) and `dai_suspected` sources; `verify-source-audio.mjs` by hand | **D4** (`needs_review` publishing) + **G-14** (tier carried, locate-required refused) |
| 24 | Notice that a run died (no alert, I-15, I-27) | **G-30** (notification) |
| 25 | Choose a new id on a duplicate id in `data/forays.json` | **G-23** |
| 26 | Budget stop → a human re-runs with a higher cap | **D1** caps + **G-30** (auto-resume when the daily window resets) |

---

## 2. Triage: the things that each cost hours, addressed up front

Wyatt's rule: hours first, then minutes, then seconds; if something adds ten
hours, fix it before anything else. Five things do, and none of them is a
pipeline-logic defect.

| # | What it costs | Evidence | Card |
|---|---|---|---|
| H1 | **No API key.** Every run goes through the relay at a mean 117–143 s per call [measured] against 3–60 s (Sonnet) / 60–150 s (Opus) [estimated]; a person dispatches every call; the session's caps ended attempt 6 (I-25) and stalled the 09-10 run (I-27). A 76–91-minute relay run is a **~10–20-minute keyed run** [estimated: ÷ 4–6, latency brief §2.3] — and a keyed run needs nobody watching **once G-30 lands**. | `gh secret list`; latency brief §2.1, §2.3 | **G-01** (human gate D1) |
| H2 | **The tape supply is one PC's folder, and one show per topic.** `data-local/transcripts/` is gitignored, was wiped once by an unknown process (I-24, ≈ 2 h to regenerate 1,713 bodies), and for the AI-systems prompt offers exactly one show (*Practical AI*, 63 episodes). Supply is not the cause of most refusals — the cataloguing brief's split is 1 h direct / 2.8 h co-cause / 5.3 h pipeline — but it **caps tape diversity** (one show → M4's 25 % cap fails by arithmetic, F-70) and the ≥ 3-shows target. Joey's corpus holds 442 k English timed episodes (323 k with audio) [measured] — as URLs, unfetched, DAI-unmeasured. | cataloguing brief §2.2; corpus brief §0 | **Phase 1**, starting with **G-18** (measure) |
| H3 | **Publishing is a founder-reviewed PR with a `hold` label** (requirements §6.5 step 7, applied by `backend/src/cli/publishForay.ts`). Correct for the public catalogue; it means no Foray reaches a listener without a person. | §6.5; `tools/ci/path-policy.mjs` BLOCKING_LABELS | **G-21** |
| H4 | **The pipeline lives on a branch main cannot merge.** #538 is 100 ahead / 3 behind with conflicts in two generated files after #576; Hermes works from main. | `git merge-tree`, §1.4 | **G-00** |
| H5 | **A harness in the loop.** I-15, I-23, I-25, I-27: four distinct ways a Claude Code session, not the pipeline, ended a run. | run doc §1b; §1.4 | **G-01** + **G-30** |

Everything in Phase 3 is minutes or seconds by comparison and waits.

---

## Card format

Every card below carries: **Owner** (Hermes, overlord, or a human gate), the
**H/M/S** triage tag and **S/M/L** size, **Ask**, **Owned files**, **Done
when** (testable), **Dependencies**, **Human gate** (or "none"). Lanes are
`tools/ci/path-policy.mjs` on `origin/main` (§9): anything in `backend/src/`,
`.github/`, `tools/ci/`, `docs/DECISIONS.md`, `docs/adr/` is **overlord
(founder-approved lane)**; `api/` and `ios/` are *unlisted* — neither allowed
nor denied — so a PR touching them needs a **human merge click**, and every
card that touches them says so. L cards carry **design comment first** and a
measurable first step.

---

## 3. Phase 0 — Prerequisites (parallel, this week)

### G-00 · Land the generation branch on main — **H · M**
- **Owner:** overlord (founder-approved lane: `backend/src/`, `.github/`).
- **Ask.** Regenerate `deploy-manifest.json` and `sw.js` on the branch against
  current main (`tools/ci/generate-manifest.mjs --write` **from an LF checkout
  only** — `crlf-guard.mjs` explains why), resolve nothing by hand, get #538 out
  of draft, CI green, label under standing approval, merge. Until then every
  "branch from main" in this deck means "branch from
  `generation-run-2026-09-09`", and every `docs/curation/generation-*` /
  `foray-generation-requirements.md` citation resolves with
  `git show origin/generation-run-2026-09-09:<path>`.
- **Owned files.** the merge itself; `deploy-manifest.json`, `sw.js`.
- **Done when.** #538 merged; `npm test` at the root and `npx vitest run` in
  `backend/` green on main; the requirements doc and tracker on main describe
  what main runs.
- **Dependencies.** none. **Human gate.** none (D8: overlord under standing
  approval).

### G-01 · An Anthropic API key with spend caps — **H · S — HUMAN GATE (Wyatt, D1)**
- **Owner:** Wyatt places the key; overlord wires the config.
- **Ask.** A Console API key (not a Claude.ai login), placed where the
  generation host reads it (`backend/.env` on the host, or the host's secret
  store — never in chat, never in the repo). **The founder's PC is the interim
  host until D2 names the production host; the key moves with the host.** The
  driver already honours `DAILY_BUDGET_USD` / `EPISODE_BUDGET_USD`; defaults are
  now **$25/day and $10/Foray** (`backend/src/config/env.ts:106`; requirements
  §4.1 — F-04's $2 default was raised on the branch). Wyatt sets the production
  caps from the cost estimate in §7. Note the brand-new key's rate tier is
  unknown and is what G-32/G-35's fan-out will test (429s).
- **Owned files.** host `.env`; `docs/HUMAN-ACTIONS.md` entry with the literal
  steps.
- **Done when.** `npm run generate-forays` on the host prints
  `MODE: live — Anthropic builders, metered by BudgetGuard (daily $…, per-Foray $…)`
  (the banner at `generateForays.ts:372`; it does not print model ids — G-02
  adds them) and completes a `short` Foray with no truncated reply.
- **Dependencies.** D1. **Human gate.** D1.

### G-02 · WS-G keyed-run readiness lands BEFORE the first keyed run — **H · S**
- **Owner:** overlord (founder-approved lane). Absorbs **G-33** (effort and
  caps on per-page calls), which is the same scope.
- **Ask.** F-47 (adaptive thinking inside tight `max_tokens` caps — Opus 5 and
  Sonnet 5 run adaptive thinking by default when `thinking` is omitted, and the
  branch omits it everywhere), F-48 (evidence is the retrieval model's
  restatement → hold `cited_text` spans as the document), F-05. Set
  `output_config: { effort: "low" }` on writer / verifier / continuity /
  understander / researcher (leave the spine at default), raise the small caps
  by a thinking allowance, and print the three pinned ids (Opus 5, Sonnet 5,
  Haiku 4.5 — `config/models.ts:59–61`) in the MODE banner. Spec: fix plan
  §WS-G. [estimated] 20–40 % per Sonnet call and the F-47 truncation class
  disappears; the verifier's judgement is the risk — watch
  `firstAttemptPassRate` / `unverifiedPages` in `meta.veracity`.
- **Owned files.** `backend/src/config/models.ts`, `config/env.ts`,
  `cost/budgetGuard.ts`, `AnthropicExternalResearcher.ts`, the
  `Anthropic*Builder.ts` files, `cli/generateForays.ts` (banner),
  `backend/test/**`.
- **Done when (keyless, closes this card).** A unit test asserts no builder can
  be constructed with a cap a thinking allowance can exhaust; the budget
  estimate names its thinking allowance; `cited_text` spans are held as the
  document (fixture test). **The keyed smoke run moves to G-20.**
- **Dependencies.** G-00 (the files exist only on the branch). **Human
  gate.** none (founder-approved under standing approval).

### G-03 · Fixtures the other cards need, produced on the PC — **H · S**
- **Owner:** overlord (the only place with `foraycorpus` and `data-local/`).
- **Ask.** (a) A scrubbed `pg_dump` fixture of `foraycorpus` — ~20 podcasts with
  their feeds, source records, episodes and assets — with a `counts.json` of
  the expected show/episode/asset counts, so G-10 can be developed and tested
  with **no live DB in CI**. (b) Three *Practical AI* normalized bodies plus
  their sha256 from `data-local/`, so G-11's byte-identical check is a unit
  test. (c) A truncated-archive fixture for G-14's guard.
- **Owned files.** `backend/test/fixtures/corpus/**`,
  `backend/test/fixtures/transcripts/**`, `tools/foraycorpus-export/fixtures/**`.
- **Done when.** The fixtures are committed with a README naming the query and
  the date; sizes < 5 MB total.
- **Dependencies.** none. **Human gate.** none.

---

## 4. Phase 1 — Supply: Forays pull from the full list of transcribed podcasts

**What the corpus is today** (measured 2026-09-10 03:30–04:30Z against
`foraycorpus`, read-only; corpus brief §1–§5): **4.4 M podcasts (4.7 M feeds),
7.8 M episodes, 1.23 M transcript URLs** over 525 k distinct episodes.
Restricted to English: **442 k episodes with a timed transcript across 1,967
podcasts** (1,207 with ≥ 20); **323 k of those also have an audio URL, across
1,185 podcasts** (409 with ≥ 20). That is ~58× the 7,571 timed episodes 4a's
own index knows and ~88× the 5,041 bodies on this PC. But it is a **URL index,
not an archive**: 0 % of `assets` rows carry `object_uri`, a byte length or a
checksum; there is **no DAI signal** and **no per-episode topic**; the primary
`<enclosure>` URL is not captured (`episodes.primary_asset_id` 100 % null), so
only 10.2 % of episodes have any audio URL, nearly all Omny/Amperwave feeds.
**Crawl health:** the crawl began 2026-09-04; 27,080 of 4.74 M feeds have ever
succeeded (**0.57 %**, essentially all tier 1); 14 major hosts are auto-paused
on timeout; episode inserts fell from ~4.1 M/day (09-06) to ~120 k/day (09-10);
counts drift ~0.6 % between queries an hour apart. The "4.4 M / 7.8 M" are the
PodcastIndex import; "442 k" is a snapshot of a stalled six-day crawl — a floor
or a ceiling depending on whether the crawler recovers. **Supply skew:** 79 %
of transcript rows are `api.omny.fm` (Triton), and the top shows are iHeart
daily radio and sports. The playable fraction of the 442 k after the DAI tier
is **unmeasured** — G-19 exists to measure it before anything is backfilled.

**The rule for this phase:** the corpus is the source of truth for *what
exists*; 4a's exporter turns it into *what the pipeline can quote*. Nothing in
this phase is a hand-run script in its end state: one scheduled job on the
tailnet publishes versioned artifacts to an object store, and every 4a reader
(the Vercel `api/` functions, the generation pipeline, the app's catalogue
files) reads through one pointer file — the pattern `shows-index-pointer.json`
already uses (S-04). Development dry-runs from the founder's PC are
**development only** and cannot close a card (G-10's Done-when needs a
non-founder host).

**Order inside the phase (hours first):** G-18 and G-19 *measure* before G-11
*moves 24 GB*. G-18's answer decides whether Phase 1 changes the two fixed
prompts' supply at all; G-19's decides how much of the backfill is playable.

### G-18 · MEASURE topic depth for the two fixed prompts — **H · M**
- **Owner:** overlord (needs the RO role over Tailscale; hermes-vm access is
  D2).
- **Ask.** For the two prompts' resolved nodes (`engineering/ai-robotics`;
  `engineering/disasters` and its lineage), using only what the corpus holds
  today — feed `categories`, PodcastIndex `category1..10`, episode
  `title_raw` / `description_raw` term matches against `data/taxonomy.json`
  `terms[]` and `data/semantic-index.json` — list the **top shows per topic
  with their English timed-transcript episode count and their timed+audio
  count**, and answer one question per prompt: *does the corpus hold ≥ 3 shows
  with ≥ 20 timed+audio episodes on this node?* Compare with the archive's one
  show (Practical AI, 63). No bodies are fetched; no model call.
- **Owned files.** `tools/foraycorpus-export/depth-probe.sql` (+ `.mjs`
  wrapper), `docs/curation/corpus-depth-2026-09.md`.
- **Done when.** The doc holds a table of ≥ 10 shows per topic with counts and
  the yes/no per prompt, dated, with the query committed; D0's "≥ 3 shows"
  target is confirmed, changed or waived on that evidence.
- **Dependencies.** none (read-only role exists). **Human gate.** none; feeds
  D0.

### G-19 · DAI tier sample BEFORE the backfill — **H · S**
- **Owner:** overlord (runs on the PC or hermes-vm; ranged GETs against
  publisher CDNs — see the politeness note in G-11).
- **Ask.** A stratified sample of ~500 episodes from the 323 k
  transcript+audio set (by feed host, by show size), two 2-byte ranged GETs
  ≥ 24 h apart per episode via `tools/transcribe/ad-inflation.mjs` logic (**HEAD
  lies**, ADR-0008), reporting the share that screens `ad-free` /
  `paddable` (delta_max ≤ 90 s) / `locate-required` / `unmeasurable`
  (`length="0"`). This is the number the §1.2 "playable tape supply" row needs.
- **Owned files.** `tools/foraycorpus-export/dai-sample.mjs`, a results JSON
  under `docs/curation/`.
- **Done when.** The three shares are published with N and the sampling frame;
  G-11's first backfill tranche is ordered by them (ad-free shows first).
- **Dependencies.** none. **Human gate.** none.

### G-10 · Corpus exporter: catalogue + episode index — **H · M — Hermes**
- **Owner:** Hermes (`tools/` lane). Directory is
  `tools/foraycorpus-export/` — **not** `tools/corpus/`, which already exists on main as
  the unrelated research-document corpus.
- **Ask.** Node, reusing 4a's own modules: read the RO role (`wyatt_readonly`
  today; a dedicated export role is D2), emit `shows.jsonl`
  (`podcasts ⋈ podcast_feeds ⋈ podcast_source_records ⋈` episode aggregates;
  **feed URL is the join key** — only 64 % of shows carry an iTunes id) and
  per-show `episodes.jsonl` (guid, title, published, duration, transcript URL +
  MIME, chapters URL, audio URL or null). **Rights flags in `shows.jsonl`**:
  `itunes:block` (2,929 crawled feeds) and `podcast:locked` (3,823) carried, and
  excluded from fetch until D10 rules. Delta by `assets.id` /
  `episodes.updated_at` high-water mark. A manifest per run with sha256 per
  file, **feeds-crawled / feeds-known and the 30-day insert rate** (so
  freshness means something), and a `latest.json` pointer written last,
  atomically. The exact SQL is the corpus brief §2–§6 (same PR as this deck);
  G-03's fixture dump is the test DB. Add the itunes_id ↔ `apple_collection_id`
  overlap query for the 19,787 breadth shows (brief §7.4) as a reported number.
- **Owned files.** `tools/foraycorpus-export/**` (+ tests against the G-03
  fixture; no live DB in CI).
- **Done when.** Against the G-03 fixture: counts equal `counts.json` exactly,
  and a second run with no change emits an empty delta. Against the live DB
  from a **non-founder host** (hermes-vm or the D2 host): show and episode
  counts within **±2 % of the corpus brief's 2026-09-10 figures** (crawl
  drift), the overlap number reported. A PC dry-run does not close the card.
- **Dependencies.** G-03; D2 for the non-founder host. **Human gate.** none
  for the code; D2 for the host.

### G-11 · Transcript bodies: fetch, normalize, index — at corpus scale — **H · L — Hermes — design comment first**
- **Owner:** Hermes (`tools/` lane). If the normalizer or the index code needs
  a change, that is its own overlord PR on `backend/src/`.
- **Ask.** Extend G-10 with the three steps the corpus does not do: GET each
  new timed transcript, normalize with the existing
  `tools/segments/transcript-normalize.mjs` into the existing
  `safeKey(show)/safeKey(guid)` layout, build the per-show BM25 index with the
  existing `backend/src/generation/transcriptTextIndex.ts` (loaded from a
  `.mjs` tool via `npx tsx`, or from a compiled `backend/dist` import — the
  design comment picks one), and emit per-episode term vectors. **Fetch every
  English timed transcript regardless of the DAI flag** — the flag is a
  playback tier (G-12/G-14), not a fetch gate; that is the card at which the
  fetch-side exclusion ends. **Idf:** the cataloguing brief R1 says one idf
  across the whole corpus (two corpora's BM25 scores are not comparable); keep
  per-show postings but publish a **corpus-wide document-frequency table**
  beside them, and G-14 recalibrates the relevance floor against it before
  G-25's numbers are quoted. **Politeness is the calendar:** 442 k GETs, 79 %
  against `api.omny.fm`, a host Joey's crawler has *already* auto-paused on
  rate-limit signals; at 1 req/s per host the Omny backfill is **4–11 days**
  (one format per episode vs all) — read Joey's `feed_host_policies` as the
  shared politeness table, use the `ForayCorpusBot` UA from
  `tools/segments/politeness.mjs`, and run from an egress that is not the
  crawler's, or coordinate with Joey so two bots do not get one IP blocked.
  Backfill in the order G-19 sets (ad-free shows first). Sizing, all
  **[inferred]** from measured bytes/hour (range in brackets): **~24 GB raw
  (17–32), ~36 GB normalized JSON, ~9 GB gzipped, ~4 GB of index** (linear from
  337 documents; an 8,800-episode Omny show's index is ~80 MB loaded whole);
  ~0.8 GB/month after backfill. Compute time is unsized — the design comment
  includes a 1 %-sample timing.
- **Owned files.** `tools/foraycorpus-export/**`, tests.
- **Done when.** (a) The three Practical AI fixture bodies (G-03) produced by
  this path are byte-identical to their sha256 — unit test. (b) SYSK and Odd
  Lots bodies are present in the archive (the exclusion has ended at the fetch)
  **and marked with their G-12 tier**, never offered to sourcing without it.
  (c) The df table and per-show indexes load through G-14's provider. (d) The
  G-14 integrity guard reports the manifest's body count.
- **Dependencies.** G-00 (for `transcriptTextIndex.ts`), G-10, G-19 (order),
  D2 (host + rate), **D10 (rights posture — must precede the shared-store
  publish)**; G-14 for the guard half. **Human gate.** D2, D10.

### G-12 · Per-episode ad-load measurement as a corpus artifact — **H · M — Hermes (data) + overlord (readers in `backend/src`)**
- **Owner:** Hermes for the measurement job and the new artifact; overlord for
  `audioSourceLookup.ts` / `sourceBeats.ts` (done under G-14).
- **Ask.** For every episode with an audio URL, the 2-byte ranged-GET probe
  from `tools/transcribe/ad-inflation.mjs` (**HEAD lies**), **two probes ≥ 24 h
  apart** on G-16's scheduled job, emitting `delta_max_sec`, `spread_sec`,
  `n_probes`, `pad_sec` and `tier ∈ {ad-free, paddable, locate-required,
  unmeasured, unmeasurable}` plus the redirect-chain host, into a **new
  per-episode artifact `data/dai-measurements.json`** (or the store's
  `dai.jsonl`). The existing per-show `data/dai-classification.json`
  (machine-generated by `tools/refresh/classify-dai.mjs`, `built_at` stamped,
  shape `{dai, reason, resolved_host, ad_inflation}`) is **derived from it**,
  not replaced — its readers stay: `fetch-transcripts.mjs:171`,
  `rank-breadth.mjs`, `refresh/merge.mjs`, `prepare-segment-batch.mjs`,
  `web/prepare-dist.mjs`, the CI "DAI flags" invariant and
  `tools/ci/generate-manifest.mjs` (tools/ci → founder lane if the new file is
  listed in the manifest). The per-host `dai_suspected` flag becomes a
  **prior**, never a verdict (F-74). Feed-declared length is the denominator;
  `length="0"` (Megaphone) is `unmeasurable`, not guessed.
- **Blocked on Joey for 90 % of episodes:** the corpus does not capture the
  primary `<enclosure>` URL or its `length`. That is ask **6** in §8 (D3). Until
  then this card covers the 10 % that have an audio URL (Omny/Amperwave feeds —
  which includes the Triton shows, so SYSK is in the slice; Practical AI is on
  Changelog's own feed and is *not*, so its assertion below waits on D3 or on
  4a's own `transcript-availability.json` enclosure).
- **Owned files.** `tools/foraycorpus-export/dai-measure.mjs`,
  `data/dai-measurements.json`, `tools/refresh/classify-dai.mjs` (derive),
  tests.
- **Done when.** For the 10 % slice: every episode probed twice; SYSK reads
  `locate-required` with N ≥ 2; Gastropod's tier reproduces ADR-0008's
  33.4 s spread; `classify-dai.json` is derived and byte-stable across two runs
  with no new probes; the CI DAI invariant passes.
- **Dependencies.** G-10, G-16 (cadence/host). **Human gate.** D3 for the
  other 90 %.

### G-13 · Per-episode topic terms and taxonomy nodes — **H · M — Hermes (data) + G-13b overlord (resolver)**
- **Owner:** Hermes for the data; overlord for the resolver.
- **Ask (G-13, Hermes).** From G-11's term vectors: top-k distinctive terms per
  episode (**tf-idf over the corpus-wide df table, no model call**), and a
  taxonomy node assignment per episode via `data/taxonomy.json`'s
  `apple_anchor` ↔ corpus categories plus term overlap — **never inherited from
  the show** (#547: 1,688 of 2,047 items inherit one show label; F-59, F-67).
  Mark broad shows `general: true` so the lineage gate stops treating them as
  specialists. Fill `terms[]` on all 194 taxonomy nodes from the same tf-idf
  pass (1 node had them before #554). Output: a `topics[]` column in G-10's
  `episodes.jsonl` and, for the committed catalogue, `data/episode-topics.json`.
- **Ask (G-13b, overlord).** `backend/src/generation` topic resolver reads node
  `terms[]` and the df table instead of label tokens (requirements §3.4;
  tracker: "resolver is still token overlap").
- **Owned files.** `tools/foraycorpus-export/topics.mjs`,
  `data/taxonomy.json` (`terms[]`), `data/episode-topics.json`,
  `test/data-topic-integrity.test.js` (the #547 regression: no `discover.json`
  item's only claim to a node is its show label — with a MUTATION); G-13b:
  `backend/src/generation/{resolveTopic,catalogueLookup}.ts` + fixture test.
- **Done when.** The regression test is green with its mutation red; the run-2
  prompt and the 8-word 4a paraphrase (F-67) both resolve to
  `engineering/ai-robotics` from corpus terms alone in a fixture test.
- **Dependencies.** G-11 (vectors), G-00 for G-13b. **Human gate.** none.

### G-14 · The pipeline reads the store, not the PC — carries the DAI tier — **H · M — overlord**
- **Owner:** overlord (`backend/src/`).
- **Ask.** `HttpTranscriptCueProvider` and an HTTP-backed text-index loader
  implementing today's `TranscriptCueProvider` / text-index interfaces
  (`transcriptArchiveLookup.ts`, `transcriptTextIndex.ts` need no logic
  change), a catalogue adapter that emits `catalog-breadth.json`-shaped rows
  from `shows.jsonl`, and the integrity guard from I-24: at run start the
  provider reports how many bodies it can read and the driver refuses to source
  against an archive whose count fell below the manifest's. `data-local/`
  becomes a cache. **The tier gate:** `audioSourceLookup.ts` carries G-12's
  per-episode tier; `sourceBeats.ts` refuses (narrates instead) any
  `locate-required` candidate while `locateStep().implemented === false`, and
  `check-forays.mjs` gets the matching rule so a published Foray can never
  contain a segment the player will skip. **Floor recalibration:** re-run the
  run-2 fixture on the Phase 1 index with the corpus-wide df table and
  re-derive the false-positive / nearest-miss margins (today 0.257 / 0.349
  against a 63-document idf) before any G-25 number is quoted.
- **Owned files.** `backend/src/generation/{transcriptArchiveLookup,
  transcriptTextIndex, audioSourceLookup, sourceBeats, catalogueLookup}.ts`,
  `backend/src/cli/generateForays.ts` (guard), `tools/foray/check-forays.mjs`,
  `backend/test/**`.
- **Done when.** A fresh clone with only the pointer configured (a `file://`
  store fixture for the test) yields ≥ 1 tape beat on the run-2 fixture; the
  guard fires on G-03's truncated archive (mutation test); a fixture with a
  `locate-required` seed window is narrated, not minted, and `check-forays`
  refuses a hand-built record that contains one; the recalibrated margins are
  recorded in the PR.
- **Dependencies.** G-00, G-10, G-11 (or the file:// fixture), G-12 (tier),
  D2. **Human gate.** none (founder-approved under standing approval).

### G-15 · App catalogue from the corpus — **M · M — Hermes, with a human merge click**
- **Owner:** Hermes. **`api/` is unlisted in `path-policy.mjs`** — a PR
  touching `api/shows/search.ts` or `api/episodes/search.ts` cannot auto-merge
  and needs Wyatt's merge click (the S-deck's G3 is the same click).
- **Ask.** `api/shows/search.ts`, `api/episodes/search.ts` and
  `backend/src/catalog/breadthCatalog.ts`'s readers take a corpus-derived
  artifact through the pointer (S-04's shape) instead of the 2026-07-09
  Apple-chart harvest. **`chart_rank` still comes from the old harvest join** —
  the corpus has no chart data — kept as a *prior* (33 % ad-free at ranks 1–25
  vs 71 % at 26–200: harvesting by chart selected against anchorable shows).
  The freshness check is **a scheduled advisory workflow that opens/updates an
  issue when the manifest is > 48 h old** — not a required check that reddens
  unrelated PRs — and lives in its own PR (`.github/` → founder-approved).
- **Owned files.** `api/shows/search.ts`, `api/episodes/search.ts`,
  `api/test/**`, `tools/foraycorpus-export/catalog-adapter.mjs`; separate PR:
  `.github/workflows/corpus-freshness.yml`.
- **Done when.** The shows search answers from corpus rows (api test with a
  fixture manifest); the harvester is reduced to the rank prior; the S-deck
  suites stay green; the advisory workflow has one run id in the PR.
- **Dependencies.** G-10; S-03/S-04 sequencing (coordinate in STATE.md).
  **Human gate.** Wyatt's merge click on `api/`; founder-approved on the
  workflow PR.

### G-16 · Where the exporter runs, and its credentials — **HUMAN GATE (Wyatt + Joey, D2)**
- Three options (corpus brief §7.2): Joey's foray-db box (ideal — the fetch
  worker could write `object_uri` / `observed_byte_length` back into `assets`
  so the corpus *becomes* the archive), hermes-vm on the tailnet (Wyatt's, RO
  role only), or GitHub Actions with a Tailscale OAuth client (6-hour job cap
  makes the backfill awkward; fine for deltas). Plus: the store (R2 tokens
  already exist in `data-local/`; ~$0.15/month per 10 GB version, current list
  price, verify), egress rate against Omny and coordination with Joey's
  crawler, retention (keep N versions) and takedown handling, and the
  **production generation host — which is also the key's home (G-01)**.
- **Done when.** One line each in `docs/DECISIONS.md` (founder-approved lane);
  G-10/G-11/G-12/G-30 then have a home.

### G-17 · Communicate the cataloguing lessons to Joey — **H · S — Hermes**
- **Owner:** Hermes (`docs/` lane); Wyatt forwards.
- **Ask.** The lessons are captured in
  `docs/curation/cataloguing-lessons-for-corpus.md` (same PR). Communication is
  a concrete step, not a clause: **a GitHub issue in this repo addressed to
  `@sffan15-sys`** carrying the cover note, the five asks, the enclosure-URL /
  `length` gap (ask 6), and a link to the doc on the PR branch. The issue number
  is recorded in §8. **Wyatt: forward the issue to Joey** — the repo mention
  reaches him only if he watches the repo.
- **Owned files.** the issue; §8 of this deck; `docs/HUMAN-ACTIONS.md` (one
  line: "forward to Joey").
- **Done when.** The issue is open and mentioned here; Joey has acknowledged
  it; each of the six asks is mapped in the issue to a corpus change, a date,
  or a declined reason.
- **Dependencies.** this PR. **Human gate.** Wyatt forwards; Joey answers.

### Phase 1b — unlock the 6,594 (the DAI-injecting supply)

### G-40 · Ship the ad-pad tier — **M · S — Hermes (`player/`, `app.js`, `tools/`) — needs D5 (OQ2)**
- **Owner:** Hermes for the web player and the writer; the iOS half touches
  `ios/App/Player/PlayerBackend.swift`, an **unlisted path → human merge click**.
- **Ask.** Wire `allowAdPad: true` into the `forayOpts` object `app.js` builds
  for `player.playForay(...)` (the option is consumed at
  `player/foray-queue.js:228` → `:354`, forwarded by `foray-resolve.js:296`;
  `app.js` on main has no `allowAdPad` today — grep for `playForay`, not a line
  number). Add `tools/segments/stamp-ad-pad.mjs` that stamps `ad_pad_sec`
  (= `delta_max + spread`, N ≥ 2, from G-12's artifact) onto
  `data/segments.json` rows; the ceiling stays 120 s (`seek-policy.js:109`).
  **Honest coverage:** until D3 the artifact covers the 10 % with an audio URL;
  the pad unlocks ≤ 45 of the 6,594 excluded transcripts (5-4, and only after
  decode-and-compare — one of its five samples is under 1.0); its real value is
  G-41's search window. **iOS:** `PlayerBackend.swift` seeks with zero
  tolerance and has no DAI logic — the pad/skip gate must hold there too or the
  app plays what the web skips.
- **Owned files.** `app.js`, `player/foray-queue.js`,
  `player/foray-queue.test.js`, `player/seek-policy.test.js`,
  `tools/segments/stamp-ad-pad.mjs` (+ test); separate PR (human merge):
  `ios/App/Player/PlayerBackend.swift`.
- **Done when.** A `segments.json` row with `ad_pad_sec` from G-12 resolves as
  `padded` in the queue test; a pad > 120 s is asserted LOCATE-REQUIRED; the
  writer refuses N < 2; the iOS backend has a test (or a recorded simulator
  run) that a DAI item with drift > 30 s and no pad is skipped, not played.
- **Dependencies.** G-12; **D5 OQ2** ("does the pad ship before the locate
  step?" — `seek-policy.js:71–74` waits on it). **Human gate.** D5; merge
  click on `ios/`.

### G-41 · The locate step: on-device windowed ASR — **H (supply) · L — Hermes (native) — BLOCKED on D5; design comment first; not cuttable as one card**
- **Owner:** Hermes (`mobile/` lane is allowed; `ios/App/**` is unlisted →
  human merge; Android under `mobile/`).
- **What it is.** ADR-0007 rung 4 / ADR-0008 option 1: at Foray open (not at
  tap, to protect the < 1.5 s tap-to-audio budget), the native shell
  ranged-GETs the listener's own copy over
  `[start_sec, start_sec + delta_max + margin]` (≈ 8–14 min of audio for SYSK),
  runs on-device speech recognition (`SFSpeechRecognizer` with
  `requiresOnDeviceRecognition`; Android `SpeechRecognizer` / whisper.cpp tiny),
  fuzzy-matches the 8–12 anchor words, seeks to the hit; same for the end
  anchor; cached per episode per device; falls to today's skip on no hit.
  Web/PWA stays skip. **Unlocks all 6,594** (SYSK + Odd Lots alone are 4,113).
  Weeks, native only.
- **Measurable first step (the only thing to do before D5).** A feasibility
  measurement, no product code: on **one** SYSK episode already on the PC,
  ranged-GET the window for three authored anchors, run on-device ASR (a Mac
  with `SFSpeechRecognizer`, or whisper.cpp tiny as a stand-in), and record
  **time-to-locate, hit/miss per anchor, and bytes fetched**. Publish as
  `docs/curation/locate-step-feasibility-2026-09.md`. That number is what D5
  OQ1 (ASR vs fingerprint) needs.
- **After D5.** Write its own deck (L-01-style: plugin package layout, method
  contract, XCTest/JUnit list, simulator acceptance, a "locating…" UI state,
  the locate cache, `locateStep()` with the drift arithmetic); cut from that.
- **Owned files (first step only).** the feasibility doc + the throwaway
  script under `tools/transcribe/`.
- **Done when (first step).** The doc has the three numbers with the device and
  model named. **Dependencies.** G-12 (`delta_max` window), G-40 (window
  parameter). **Human gate.** D5 (OQ1, OQ3, OQ4, native-only acceptance,
  cellular bandwidth budget for up to ~14 min of audio per segment).

---

## 5. Phase 2 — Finish line: one or two Forays through the baseline production process

"Minimal deviations from the baseline" means: `npm run generate-forays` with a
key → `check-forays.mjs` → `npm run publish-foray` → PR → merge → store build.
**Interim, stated plainly:** the 2026-09-10 Foray for Wyatt is being produced
through the **relay** (a manual transport, hand-dispatched, on the founder's
PC, already stalled once by I-27) because no key exists — that is the **last
relay run**, retired by **G-01**. G-20's keyed runs then happen **on the
founder's PC** until **G-14** moves the archive off it — that is the **last
PC-hosted run**, retired by **G-14 + D2**. Both are named here as the last
instances of their error class; neither is "unattended" until G-30 lands,
which is why G-30 sits in this phase, ahead of G-20.

### G-30 · Detached, self-resuming runs with a notification — **H · M — overlord**
- **Owner:** overlord (`backend/src/cli/generateForays.ts`, founder-approved
  lane); the service/container half waits on D2.
- **Ask.** (a) The driver retries/resumes from the checkpoint with a cap (N)
  instead of printing "re-run to resume" (§1.5 step 9). (b) A refused partial
  candidate ends the run with a named reason instead of a person watching
  (step 10; abort-vs-continue is D4). (c) The default tier becomes `medium`
  (step 4). (d) A run's end — success, refusal, budget stop, crash — posts
  **one comment on the run's tracking issue via `gh`** (the transport; a
  HUMAN-ACTIONS line is the fallback when `gh` is absent). (e) Budget stop
  auto-resumes when the daily window resets (step 26). (f) The service /
  container form on the D2 host.
- **Owned files.** `backend/src/cli/generateForays.ts`,
  `backend/src/generation/runPipeline.ts` (partial-refusal exit),
  `backend/test/generateForays.*.test.ts`.
- **Done when (keyless).** In `MODE: dry-run` with the stub builders
  (`generateForays.ts:371`) and a fixture checkpoint: a process killed
  mid-stage resumes itself on relaunch and completes; a fixture that fails the
  partial gate ends the run with the reason in `report.json`; the notification
  hook fires once (mocked `gh`). **(f) after D2:** one run on the host with no
  interactive shell.
- **Dependencies.** G-00; D2 for (f). **Human gate.** none for (a)–(e);
  D2 for (f).

### G-20 · Keyed runs of the two prompts, with every human touch counted — **H · M — overlord, needs G-01, G-02, G-30**
- **Owner:** overlord (the founder's PC holds the archive until G-14; nobody
  else may touch it).
- **Ask.** Run **prompt 1 first** (engineering disasters, medium — the archive
  has Causality + the 212-segment pool, so the multi-show target is testable),
  then **prompt 2** ("How AI systems really get built…", medium) after either
  G-11 has ≥ 3 AI shows *or* D0 has waived the ≥ 3-shows target for the
  finish-line run. Keyed, detached (G-30), `--budget-usd` set, `--duration
  medium`, checkpoint/resume handling failures. Fix only what blocks; log every
  new F-id / I-id in the run doc. Publish the ones that pass through the
  baseline path. **Record in `report.json` / the run doc:** wall, `ttlA1Ms`,
  `firstAttemptPassRate`, tokens by tier from `usage`, **$ per Foray** (this
  replaces §7's estimate), **observed 429 count and `retry-after`** (the key's
  rate tier), and **the list of every human touch** — target zero after the
  key is placed; the draft → published flip counted separately.
- **Owned files.** `docs/curation/generation-run-2026-09-09.md` (run 3 table),
  `data/forays.json` etc. via `publish-foray`.
- **Done when.** Two Forays in `data/forays.json` via `publish-foray`, each with
  the KPI row filled, the $ figure, and the human-touch list; the WS-G keyed
  smoke run (moved here from G-02) completed with no truncated reply.
- **Dependencies.** G-01, G-02, G-30, G-23, G-24; D0 or G-11 for prompt 2.
  **Human gate.** D1; D4 if the veracity gate refuses.

### G-21 · The publish gate without a person — split in two
#### G-21a · `publish-foray` decides `hold` — **H · S — overlord**
- **Owner:** overlord (`backend/src/cli/publishForay.ts`, founder-approved
  lane).
- **Ask.** Today §6.5 step 7 labels the PR `hold` and waits for a founder.
  Change: `publishForay` defaults to **no `hold`** when `evaluateVeracityGate`
  passes and `check-forays` is green, applies `hold` when either fails, and
  attaches the report as the PR body. A green `data/`-only PR with no blocking
  label **already auto-merges** under `automerge-nightly.yml`
  (`BLOCKING_LABELS = ["hold", "founder-decision"]`; there is no positive
  "generated" label and none is invented). The driver (G-30) calls publish on a
  passing candidate (§1.5 step 17). The `status: draft → published` field in
  `data/forays.json` (3 draft, 1 published on main) is **the one retained
  keystroke** — kept only if D4 says so; otherwise the same PR flips it.
- **Owned files.** `backend/src/cli/publishForay.ts`, `backend/test/**`.
- **Done when.** Fixture tests: passing candidate → PR without `hold`; failing
  → `hold` + report body; the status flip follows D4's ruling and is tested
  either way.
- **Dependencies.** G-00; **D4 thresholds need ≥ N passing keyed Forays from
  G-20 with recorded `meta.veracity`** — no Foray has ever passed either gate,
  so the thresholds have zero calibration data until then. **Human gate.** D4.

#### G-21b · The digest — **H · S — Hermes**
- **Owner:** Hermes (`docs/`, `tools/` lanes).
- **Ask.** Founders get a digest, not a gate: one issue comment per candidate
  (title, outcome, veracity numbers, PR link) on a standing "generated Forays"
  tracking issue, written by a small `tools/foray/digest.mjs` the driver calls;
  HUMAN-ACTIONS gets one line when a candidate needs the D4 keystroke.
- **Owned files.** `tools/foray/digest.mjs` (+ test), `docs/HUMAN-ACTIONS.md`.
- **Done when.** A fixture `report.json` renders the comment; the driver hook
  is one line in G-30.
- **Dependencies.** G-30. **Human gate.** none.

### G-22 · Store build on merge — **M · S — overlord (`.github/`) — needs D9**
- **Owner:** overlord (`.github/workflows/release.yml`,
  `tools/mobile/release-ci.mjs` are both denied paths).
- **Ask.** A merge that changes `data/forays.json`, `data/segments.json` or
  `data/segment-sources.json` triggers `release.yml` (both stores). Today
  `release.yml` runs on `v*` tags and `workflow_dispatch` with a `bump` input,
  and its `guard` job requires main or a tag that is an ancestor of main. A
  content-only release needs a version policy — **D9**: auto-bump patch on
  `mobile/VERSION`, or build without a bump.
- **Owned files.** `.github/workflows/release.yml`,
  `tools/mobile/release-workflow.test.mjs`, `docs/releases.md`.
- **Done when.** The next generated Foray appears in the internal-testing
  builds with no `workflow_dispatch` click — the PR names the workflow run id
  and the TestFlight / Play build number.
- **Dependencies.** G-21, D9; R-08 (testers) for the Play email.
  **Human gate.** D9; founder-approved label.

### G-23 · Finalize hygiene before the first keyed run — **H · S — overlord (WS-J)**
- **Owner:** overlord (WS-J's files are `runPipeline.ts`, `forayItems.ts`,
  `spineStructure.ts`, `finalizeForay.ts`, `narrationRules.ts`,
  `cli/generateForays.ts` — all `backend/src/`).
- **Ask.** F-55 (duplicate slot titles), F-56 (title over 18 words), F-58
  (`spokenLineErrors` over generated pages), F-20, and §1.5 step 25 (a
  duplicate id in `data/forays.json` gets a suffix or supersedes, never throws).
  **F-57 (runtime band) waits on D7** and is not in this card's Done-when.
- **Owned files.** as above + `backend/test/**`.
- **Done when.** WS-J's own Done-when verbatim minus the F-57/F-58 severity
  halves: each rule has a fixture that fails at finalize today and is caught at
  spine/stitch with the change; the duplicate-id fixture publishes with a
  suffix.
- **Dependencies.** G-00. **Human gate.** none; D7 for F-57.

### G-24 · Tape-sourcing correctness: the three mechanical bugs — **H · S — overlord**
- **Owner:** overlord (`backend/src/generation/`).
- **Ask.** From the tape-yield brief (same PR): (1) `cueWindowText`
  (`transcriptArchiveLookup.ts:1104`) keeps the cue that *ends* at the window's
  start, so the spine writes claims from a sentence the seed bounds then
  exclude — 2 beats lost, 4 survived by the fallback (R1); (2) the M4
  one-segment-per-episode cap refuses a seed window at weighted share 0.746
  before opening it, and the trace reports `window-overlap` on another episode
  — make the cap visible to seeding and report the seed's own gate (R3);
  (3) tier 1 runs before the seed and its unweighted 4-of-15 bar admitted the
  Hyatt Regency walkway under an agent-engineering claim — seeded beats consult
  the seed window first, or tier 1 adopts the idf-weighted share + rare-word
  floor (R2). Plus R5 (compound normalisation: `neo cloud` → `neocloud`).
  **The relevance floor (0.35 / 3 rare words) stays.** Lowering it admits
  nothing on-claim on the unseeded path at any value and starts admitting
  off-claim windows at 0.15 [measured walk, JUDGED verdicts].
- **Owned files.** `backend/src/generation/{transcriptArchiveLookup,
  researchShape, sourceBeats, segmentPoolLookup}.ts`, `backend/test/**`.
- **Done when.** The run-2 fixture (32-beat checkpoint) yields **≥ 14 tape
  beats with zero wrong tape** at the current floor [measured replay: 11 + 3];
  the trace names the seed's own gate; a test asserts a claim's seed window
  scores ≥ the quoted window's own share.
- **Dependencies.** G-00. **Human gate.** none.

### G-25 · Seed more of the spine from tape — **H · M — overlord**
- **Owner:** overlord (`backend/src/generation/`).
- **Ask.** Unseeded search yield is 0 of 14 at every floor; seeded yield is
  10 of 14 [measured]. Ask for a seed on every `account` beat that has a
  research window (`RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC` 4 → 6), keep
  `argument` beats narrated, and make the M4 cap visible to the spine so one
  episode is not seeded twice before eight segments exist. **JUDGED:** each
  extra seed ≈ +0.9 tape beat; 18–24 tape beats per medium Foray is plausible
  against 11 now — **single-show by construction until Phase 1 adds AI shows**,
  so this card cannot meet the "≥ 3 shows" half of the target. Risks the brief
  names: the 23.7 k-char Opus spine prompt grows (already the largest ttlA1
  block, 60–150 s [estimated]); claim faithfulness (1/1/1 "ISPs"); more tape
  from one show raises M3/M4 pressure.
- **Owned files.** `backend/src/generation/{researchShape,
  AnthropicSpineBuilder}.ts`, prompts, `backend/test/**`.
- **Done when.** Offline on the run-2 fixture ≥ 18 tape beats; M3/M4 pass on
  the fixture; spine prompt size and (once keyed) Opus call time recorded in
  the PR; **five spot-checked on-claim by the overlord, recorded in the PR
  body** (not a founder gate).
- **Dependencies.** G-24; G-14's recalibration before any number is quoted on
  the Phase 1 index. **Human gate.** none.

---

## 6. Phase 3 — Cycle time through the floor (hours → minutes → seconds)

**Every number in this section is [estimated] — nothing keyed has ever run**
(`docs/curation/latency-model-2026-09-10.md`, same PR). Keyed, today's
pipeline is **≈ 9–22 min per medium Foray typical (best ≈ 7, worst ≈ 40);
ttlA1 ≈ 3.5–9 min (best 2.5, worst 15)**: 8–16 model calls in series before
Act 1, 23–52 for the whole Foray, of ~70–100 total (measured 73 / 96);
narration retry rounds are 40–50 % of it. The relay added 60–70 min on top.
**Phase 3 as written lands ttlA1 at 1.5–3 min and the full run at 3–6 min —
not 30 s.** The floor is spine + deepen + one write round ≈ 90–180 s; the 30 s
target needs G-38 (D6). G-20's first keyed run is the measurement that
replaces every number here.

### HOURS

#### G-31 · Every finalize rule checked at the earliest stage that can — **H · S — overlord**
- **Owner:** overlord (`backend/src/generation/`).
- **Ask.** F-64 (copy length), F-70 (M3/M4), F-73 (durations) were each found
  after 26–91 minutes. The partial candidate already runs `check-forays`; push
  the remaining rules (G-23's set, the runtime band once D7 rules) into
  sourcing/stitch so a doomed run stops in seconds, and `check-forays` on the
  PR (§1.5 step 21) never sees a new failure class.
- **Owned files.** `backend/src/generation/{sourceBeats, stitchForay,
  partialCandidate}.ts`, `backend/test/**`.
- **Done when.** A fixture that would fail F-64 / F-70 / F-73 is refused at the
  sourcing or stitch stage in a unit test, with a mutation test that removing
  the early check makes it fail only at finalize.
- **Dependencies.** G-23. **Human gate.** none.

### MINUTES

#### G-32 · Narrate all acts in parallel — **M · M — overlord**
- **Owner:** overlord.
- **Ask.** `writeNarration.ts:292` and `runPipeline.ts:957` loop acts in
  series; make narration a `Promise.all` across acts while stitch and
  continuity stay in act order (each waits for act N−1's stitched items);
  per-act checkpoint keys unchanged. **Saves ≈ 4–11 min: acts 2–4 drop from
  6–16 min to ~2–5 min** [estimated]; ttlA1 unchanged. **Risk the brief
  names:** 18 Sonnet + ~30 Haiku calls in flight on a brand-new key of unknown
  rate tier → 429s, and the SDK's default retries inflate wall time rather than
  fail. **Gate on G-20's measured 429 count**; `BudgetGuard` is metered per
  call and is fine; `usageTracking` is process-global (one run at a time,
  still true).
- **Owned files.** `backend/src/generation/{writeNarration, runPipeline}.ts`,
  tests.
- **Done when.** `timings` on the run-2 fixture (stub builders with injected
  latency) show acts 2–4 overlapping; zero 429s on a keyed medium run, or a
  concurrency cap that keeps it so.
- **Dependencies.** G-20 (rate tier). **Human gate.** none.

#### G-33 · Effort and caps on per-page calls — **folded into G-02** (same files, same WS-G scope; id kept so no card is renumbered).

#### G-34 · Cut the retry tax — **M · M — overlord**
- **Owner:** overlord.
- **Ask.** (a) Merge select + prose into one call and re-run only the failed
  page (the mechanical quote gate runs on the quotes afterwards — WS-A's order
  of operations is the design; (a) keeps the gate but after prose, and a
  rejected quote now wastes a script); (b) on a verifier rejection re-run
  prose + verify, not select (safe); (c) treating a `purposeRevised` page's
  `purposeAccomplished: false` as accepted changes what "verified" means —
  **D6-later, not built**. Saves 1–3 min per Foray [estimated].
- **Owned files.** `backend/src/generation/writeNarration.ts:558–676`
  (`runSlotAttempt`), `AnthropicNarrationWriterBuilder.ts`,
  `NarrationWriterBuilder.ts`, tests.
- **Done when.** `report.json` on a keyed run shows narration calls per page
  ≤ 1.2 at the same `firstAttemptPassRate`; the fixture test counts calls per
  rejected page = 2, not 3.
- **Dependencies.** G-20. **Human gate.** D6-later for (c).

#### G-35 · Retrieval concurrency and prefetch — **M · S — overlord**
- **Owner:** overlord (the critique is right that these are `backend/src`
  files; it is not a Hermes card).
- **Ask.** Run the F-60 rephrased query concurrently with the first
  (`gatherEvidence.ts:348–359`; one wasted Haiku call ≈ $0.02 when the first
  succeeds; ≈ half of first queries were empty [measured]); gather evidence for
  every act in one fan-out after `source`, starting the seeded claims'
  retrieval during deepen (claims are frozen at the spine since F-68; cache key
  is the claim hash). Saves 12–30 s ttlA1 and 30–90 s per run [estimated].
- **Owned files.** `backend/src/generation/{gatherEvidence, writeNarration,
  runPipeline}.ts`, `AnthropicExternalResearcher.ts`, tests.
- **Done when.** `timings.retrieval` for a 3-act fixture falls by ≥ 25 %
  (stub latency), and on the first keyed run after this lands.
- **Dependencies.** G-20. **Human gate.** none.

#### G-36 · A faster spine — **M · S — D6-later, then overlord**
Opus 5 fast mode (`speed: "fast"`, research preview, $10/$50 per MTok, current
list price — verify; own rate limit), `effort: "medium"`, or Sonnet 5 for the
spine: 30–90 s of ttlA1 [estimated]. "The single most consequential call" —
Wyatt picks, **after** Phase 3 MINUTES is measured, not now.

### SECONDS

#### G-37 · Four cards, all overlord, each with a `report.json`-measured Done-when
- **G-37a · Prompt caching** — put the slot's evidence block first and mark it
  `cache_control` so select, verify and every retry read it from cache (it is
  re-sent 2× per attempt; input −40–60 % [estimated]); cache the spine prefix
  shared by the four deepen calls. Minimum cacheable prefix is model-dependent
  (512–4,096 tokens; the per-slot pack qualifies, the continuity prompt does
  not). **Done when:** `usage.cache_read_input_tokens` > 0 on the second call
  of a slot; billed input tokens per Foray ≤ 90 k on a keyed medium run.
- **G-37b · Structured outputs** — `output_config.format` on every builder to
  eliminate `parseWithRetry` re-asks. **Done when:** zero re-asks in the trace
  of a keyed run.
- **G-37c · Haiku verifier** — gated on the veracity metrics (F-27's
  junk-passing verifier is why WS-A exists; Haiku 4.5 is last-generation).
  **Done when:** `firstAttemptPassRate` and `unverifiedPages` within noise of
  the Sonnet baseline over ≥ 3 keyed runs.
- **G-37d · Per-slot streaming** — `messages.stream` with per-slot partial
  emission so the player can start on the first *slot*; changes the pipeline
  output contract and `stitchForay.ts` `onActReady` granularity, and needs a
  relaxed per-slot `check-forays` gate. **Not a seconds tweak** — it is the
  first-listen track's prerequisite with G-38. **Done when:** a partial exists
  at the first slot's `stitch` in `timings`.

#### G-38 · An Act-1 fast path — **D6-later (design ruling, not a ticket)**
The only route to a 30–45 s first listen: a spine-lite for act 1 (Sonnet,
effort low, one act) that starts playing while the full Opus spine and later
acts build behind it. Bends the "spine is frozen" invariant (§6.1). Wyatt
rules; nothing is built until then, and nothing is asked of him until Phase 3
MINUTES has a measured number.

---

## 7. Cost per Foray (estimated; current list prices, verify)

Nothing keyed has ever been billed, so this is arithmetic on measured token
counts and list prices, not a measurement — G-20's first keyed run replaces
it with `usage`. Inputs: 139,803 / 166,475 pipeline tokens per Foray
[measured, attempts 3 / 4b], of which the Opus spine is ~6 k in / 3–5 k out
and the rest is Sonnet (select / prose / verify / deepen / continuity) with
~35 Haiku calls; 30–40 retrievals with up to 3 web searches each (F-60
rephrases add more). List prices (Anthropic first-party, cached 2026-06-24 —
verify): Opus 5 **$5 / $25**, Sonnet 5 **$2 / $10**, Haiku 4.5 **$1 / $5** per
MTok; web search **$10 per 1,000 searches**; cache writes 1.25× input, cache
reads 0.1×. Assuming ~85 % of pipeline tokens are input: Sonnet ≈ $0.25 in +
$0.20–0.25 out; Opus ≈ $0.03 in + $0.08–0.13 out; Haiku < $0.05; web searches
$0.30–1.00 (30–100 searches). **≈ $1–2 per attempt on the measured counts,
≈ $1–4 once adaptive-thinking output tokens are billed** — the relay never
billed them, so they are absent from every measured token figure. Retries
(G-20's checkpoint/resume) multiply this; G-42a's bench is two Forays per run
(≈ $2–8), so it runs on a schedule, not on every PR. The defaults
`DAILY_BUDGET_USD` $25 / `EPISODE_BUDGET_USD` $10 fit with room; D1 sets the
production caps from the measured figure, not this one. G-37a's caching cuts
the billed input, which is where 40–60 % of the Sonnet cost sits.

---

## 8. Lessons for Joey's cataloguing

Captured in `docs/curation/cataloguing-lessons-for-corpus.md` (same PR):
fifteen requirements triaged HOURS → MINUTES → SECONDS with the finding that
proves each, the time split in §1.3, and a cover note. **Communication is card
G-17**: a GitHub issue in this repo addressed to `@sffan15-sys` — **issue
#578** — carrying the cover note and the six asks below; **Wyatt,
forward it to Joey.** The asks, numbered once and referenced by these numbers
everywhere in this deck:

1. Normalized timed cue text per episode + a text index over 90–180 s windows
   (titles never matched a claim; text matched all of them — F-06/F-49, WS-H,
   WS-L).
2. Per-episode (and per-window) taxonomy node ids, never inherited from the
   show; a distinctive term list per node (#547, F-59, F-67).
3. Ad load measured per episode in seconds (2-byte ranged GET, N ≥ 2, keep
   max + spread); `dai_suspected` is a host guess (F-74, ADR-0008).
4. Per-episode transcript availability with format, timestamp granularity and
   quality flags, keyed on guid + enclosure URL + Apple ids on one row; never
   join on title.
5. A depth ledger per topic node (anchorable episodes, distinct shows,
   minutes); harvest by topic, not chart rank; record language.
6. **The corpus-side gap Phase 1 cannot work around:** capture the primary
   `<enclosure>` URL and its `length` for every episode
   (`episodes.primary_asset_id` exists for exactly this), populate
   `declared_byte_length` from the RSS attribute, and look at why 14 major
   hosts auto-paused on `timeout`.

**Would better organisation have sped things up notably?** Notably, yes;
dominantly, no (§1.3).

---

## 9. Human gates and founder decisions

Ordered so the first row unblocks the most. **D2 is first**: it gates the key's
home (G-01), the exporter (G-10…G-16) and the run service (G-30).

| # | Decision | Blocks | Owner |
|---|---|---|---|
| D2 | Where the exporter and the generation service run (foray-db box / hermes-vm / Actions + Tailscale) — **this host is also the API key's home**; the store; the Omny egress rate and crawler coordination; retention/takedown; a dedicated export role | G-01 (production home), G-10…G-16, G-30(f) | Wyatt + Joey |
| D1 | **Anthropic API key + `DAILY_BUDGET_USD` / `EPISODE_BUDGET_USD` caps** (defaults $25 / $10; §7 for the estimate) — interim on the founder's PC | G-01, G-20, all of Phase 3 | Wyatt |
| D10 | **Rights posture for storing transcript bodies in a shared store.** 4a's standing policy was "bodies are never fetched or stored" (#104), relaxed to `data-local` only (#255); a shared store is a policy change whatever its ACL. 2,929 crawled feeds carry `itunes:block`, 3,823 `podcast:locked`, 853 CC-licensed assets; bulk `api.omny.fm` fetching has ToS exposure | G-11 (must precede the publish) | Wyatt |
| D3 | Corpus asks to Joey (§8, ask 6 first) | G-12 for 90 % of episodes; G-40's coverage | Joey |
| D0 | **Confirm or change the three *proposed* targets in §1.2** (full-run clock, published-with-no-human, tape share and the ≥ 3-shows half pending G-18) | G-42 (the acceptance table), G-20 prompt 2 | Wyatt |
| D4 | **The publish gate:** veracity thresholds (after ≥ N passing keyed Forays from G-20), who reviews (Kevin-style agent?), whether `needs_review` tier-2 tape may publish, abort-vs-continue on a refused partial, **and whether the per-Foray draft → published flip is the one retained human step or is automated too** | G-21a, G-30(b), §1.5 rows 10/19/20/23 | Wyatt |
| D5 | ADR-0008 OQ2 (pad before locate), OQ1 (on-device ASR vs fingerprint — G-41's first-step measurement informs it), OQ3/OQ4 (~100 s pad on ~110 s segments; N stays 2), native-only acceptance ("plays in the app, skips on the web"), cellular bandwidth budget for the locate window | G-40, G-41 | Wyatt |
| D7 | Runtime band per tier (F-57) and severity for each lifted narration rule (F-58) | G-23's F-57 half, G-31 | Wyatt |
| D9 | Content-only release: auto-bump patch on `mobile/VERSION`, or build without a bump | G-22 | Wyatt |
| D11 | API key + per-run budget in **Actions secrets** for a scheduled bench, or bench runs only on the host with results pushed | G-42b | Wyatt |
| D8 | Land #538 on main (overlord under standing approval once CI is green) | G-00 | overlord |

**Later decisions** — not needed until Phase 3 MINUTES has a measured number;
raised then, not now, per the fourth message:

| # | Decision | Blocks |
|---|---|---|
| D6 | The spine model (G-36); an Act-1 fast path (G-38); treating `purposeRevised` pages as accepted (G-34c); **re-baseline of the ttlA1 ≤ 30 s and ≤ 50 k-token targets** the deck cannot reach without them | Phase 3 tail; the two "No" rows in §1.2 |

---

## 10. Measurement — how we know we are in spec

Every number in §1.2 comes from `report.json` (per Foray: outcome, wall,
`ttlA1Ms`, `timings`, `usage`, `meta.veracity`) and the run doc's KPI tables.

### G-42a · Benchmark harness on the generation host — **M · S — Hermes**
- **Owner:** Hermes (`tools/`, `docs/` lanes).
- **Ask.** `tools/generation-bench/run.mjs` runs the two fixed prompts keyed on
  the host **on a schedule** (not per PR — ≈ $2–8 per run, §7), appends one row
  per run to `docs/curation/generation-kpis.md` (the §1.2 columns plus $ from
  `usage`, 429 count, and the manual-step count from the driver's log), and
  reports a **trend with a tolerance band** rather than a hard pass/fail — LLM
  runs are non-deterministic and a hard gate would be flaky by construction.
- **Owned files.** `tools/generation-bench/**` (+ test with a fixture
  `report.json`), `docs/curation/generation-kpis.md`.
- **Done when.** Two scheduled runs have appended rows; the trend renders.
- **Dependencies.** G-20, D0. **Human gate.** none.

### G-42b · The regression job in CI — **M · S — overlord (`.github/`) — needs D11**
- A scheduled workflow that runs G-42a and fails only when a column regresses
  past its D0-confirmed target by more than the band, once the target has been
  met. Needs a key and a budget in Actions secrets (D11) — `gh secret list`
  holds none today and G-01 says "never in the repo".
- **Done when.** One scheduled run id in the PR; the job is `continue-on-error`
  until D0 has confirmed the targets.

---

## 11. Rules for Hermes, and fan-out

**Lanes — the authority is `tools/ci/path-policy.mjs` on `origin/main`
(`DENIED_PREFIXES` wins; read it before opening a PR).** In this deck's terms:

- **Auto-merge when green:** `data/`, `docs/` (except the governed files below),
  `player/`, `tools/` (except the denied files below), `test/`, `backend/test/`,
  `mobile/`, `app.js`, `styles.css`, `search-engine.js`, `STATE.md`,
  `HUMAN-ACTIONS.md`, `deploy-manifest.json`, `sw.js`.
- **Denied (founder-approved label; the overlord reviews and labels under
  standing approval — never apply it yourself):** `backend/src/`, `.github/`,
  `tools/ci/`, `docs/DECISIONS.md`, `docs/adr/`, `docs/roles.md`,
  `docs/agents/routine-invariants.md`, `.claude/`, `CLAUDE.md`,
  `tools/test-search.mjs`, `tools/validate-semantic-index.mjs`,
  `tools/events-server.mjs`, `tools/mobile/{wire-signing, inject-app-icon,
  inject-splash, release-ci}.mjs`.
- **Unlisted (neither list → a human merge click, all-or-nothing for the
  PR):** `api/`, `ios/`. Every card above that touches them says so.
- Blocking labels are `hold` and `founder-decision`; the founder queue label
  is `needs-founder`.

**Conventions**, as in the S-/L-/R-decks: branch `t_<card>/<slug>`; one PR per
card titled `G-nn: …`; a STATE.md entry per PR; sizing S ≤ ½ day, M ≤ 2 days,
L ≤ 5 days; L cards post a design comment before code. Tests green (`npm test`
at the root, `npx vitest run` in `backend/`); CRLF files stay CRLF; never
`format:write` repo-wide. Branch from `main` once G-00 lands; until then from
`generation-run-2026-09-09`, and cite that branch for every `generation-*` /
requirements reference. Do not touch `data-local/`, the relay, or any running
process on the founder's PC; the keyed runs of G-20 are the overlord's. Cite
the finding ids (F-nn / I-nn) a PR closes; if a finding is wrong, say so in
the PR. Keep prompts short; put every checkable rule in code. Measured beats
inferred: every number in a PR body says which it is.

**Fan-out (the third message's "as many agents as you need").** Day 1, in
parallel, eleven cards need no decision: overlord — G-00, G-02, G-03, G-18,
G-19, G-23, G-24, G-30(a–e); Hermes — G-17, G-21b, G-42a (scaffold). Day 2+:
Hermes — G-10 (after G-03), G-40's player half (after G-12's shape is fixed),
G-41's first-step measurement; overlord — G-13b, G-14, G-21a, G-25, G-31.
Chains: G-03 → G-10 → G-11 → G-12/G-13 → G-14 → G-15; G-01 → G-20 → G-32/G-34/
G-35 → G-37. Independent of everything: G-17, G-18, G-19, G-24, G-42a. Expect
**six to eight agents concurrently** on day 1 (four overlord subagents, two to
three Hermes cards alongside its S-/K-decks). Critical path to the first
published Foray: **D1 → G-01 → G-30 → G-20 (prompt 1)**, with G-02/G-23/G-24
landing in parallel before it; prompt 2 waits on G-18's answer or D0.

**What this deck declines from the critique, and why** (every other finding is
applied):

- "Tag every card with H/M/S in the size slot" — done as `H · M`-style tags;
  the critique's alternative (a separate legend column) was not used because
  the cards are prose, not a table.
- "Make G-42 a hard CI regression gate" (numbers lens) vs "make it a trend with
  a band" (over-promising lens) — the two lenses disagree; the band wins
  because the runs are non-deterministic; G-42b keeps a gate only past the band.
- "Move §7's answers to directly after §0 *and* keep G-40/G-41 in §7" — the
  answers moved (§0.1); the cards moved to Phase 1b instead of staying under the
  answers, because Hermes sequences by phase.
- "Rename `tools/corpus-export/` to `tools/foraycorpus-export/`" — applied,
  with one caveat the critique did not raise: `tools/corpus/` already exists on
  main as a directory (its suites are in the CI scan), so the rename is
  required, not cosmetic.
- "State '#538 MERGEABLE'" (the live-state instruction) — superseded by a fresh
  measurement at revision time: #576 re-conflicted two generated files (§1.4).
  The deck reports what `git merge-tree` says now, not what was true at 04:20Z.

## 12. Sources (all in the same PR as this deck unless noted)

`docs/curation/corpus-integration-brief.md`,
`docs/curation/latency-model-2026-09-10.md`,
`docs/curation/dai-playback-brief-2026-09-10.md`,
`docs/curation/tape-yield-brief-2026-09-10.md`,
`docs/curation/cataloguing-lessons-for-corpus.md`; on
`generation-run-2026-09-09` until G-00 lands: `generation-run-2026-09-09.md`,
`generation-findings-tracker.md`, `generation-fix-plan-2026-09-09.md`,
`foray-generation-requirements.md`; ADR-0007, ADR-0008;
`tools/ci/path-policy.mjs` (origin/main); the Hermes deck audit of 2026-09-10
(§1.4). Live state measured at 13:26Z on 2026-09-10 on the founder's PC.
