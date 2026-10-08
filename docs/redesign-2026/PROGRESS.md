# Redesign 2026 — progress

Source of truth for a cleared session. Update on every deliverable.

## Where things are

- Worktree: `C:\Users\Fourtys\Documents\Claude\Projects\foray\.claude\worktrees\redesign-2026`
- Trunk branch: `feature/redesign-2026` (pushed to origin)
- Plan and rules: `docs/redesign-2026/PLAN.md`
- Restart prompt: `docs/redesign-2026/RESTART.md`

## Phase status

| Phase | Status | Notes |
|---|---|---|
| Kickoff (STATE.md + HUMAN-ACTIONS via doc-only PR to main) | done | PR #1085 (auto-merges on green); HA #142 Apple lab setup, HA #143 Play lab setup |
| 0a Eyes | done | tools/ui-lab/ |
| 0b Judge | done, hardened | r1 100% was too easy (marketing frames, gross degraders); skeptic hard set 36/36 both orders, 0 position bias; protocol fixed (judge/skeptic-review.md) |
| 0c Test classification | done | docs/redesign-2026/test-classification.md |
| 0d Split app.js | done | merged 2614fc29; see split-notes.md |
| 0e Lab build path | merged into trunk (b74338a0) | owner setup complete |
| 1 Research | done | docs/redesign-2026/research/, design-brief.md |
| 2 Directions | done | editorial r3, ambient r3, native-2026 r3, tactile r3, clarity r3 (docs/redesign-2026/directions/) |
| Checkpoint | **picked: Tactile + Ambient** (owner, 2026-10-06 18:17 PDT) | one condition: replace Tactile's "cartoonish" header/title font first; Phase 3 starts once the owner approves the new font |
| 3–5 | **running** (`wf_91b5c34d-c58`, from 2026-10-08 06:30 PDT; Sonnet builds with a turn budget, Codex reviews, PM watchdog) | foundation 8/8; screens 18/35 merged (tactile 13/19, ambient 5/16); see In flight |

## Checkpoint (decided 2026-10-06: Tactile + Ambient, pending Tactile's font)

Artifacts:
- [4a Redesign Checkpoint (compare + pass the phone)](https://claude.ai/artifact/56qxbdHQ9V5LYyR8r5qCyE)
- [4a Redesign: Tactile](https://claude.ai/artifact/6N8mk5PZJc32D8shdHw7GK)
- [4a Redesign: Ambient](https://claude.ai/artifact/SAQuPQZudiWo3y3eDViZiW)
- [4a Redesign: Editorial](https://claude.ai/artifact/KJ216C5n7Yu927WKEVY6WD)
- [4a Redesign: Native 2026](https://claude.ai/artifact/GnXudytwoQVx57t98wNwGc)
- [4a Redesign: Clarity](https://claude.ai/artifact/1YAp1DjBVKMzZEgKpkW6UY)

Recommendation (unchanged after the 2026-10-06 polish-to-ready pass, links refreshed
in place): build Tactile and Ambient. All five directions are now Ready (Tactile r3,
Ambient r4, Editorial r4, Native 2026 r5, Clarity r4), so the ranking is no longer
weighted toward polish. Tactile 20/20 votes (4-0 against every direction); Ambient 15/20,
losing only to Tactile (3-1 over Editorial, 4-0 over the rest); Editorial 11 and Native
2026 10 tied 2-2 head to head for third; Clarity 4; today 0. Every direction beats today
4/4. Position-following 10% (under the 20% limit), so the ranking is binding. Judges'
Phase 3 watch items: Ambient's Foray labels over Library artwork, content showing
through Editorial's tab bar. Detail: `checkpoint/README.md`.

## In flight

(Agent/workflow and what it is doing. Clear an entry when it lands.)

- **Phases 3-5 build, Claude workflow `wf_91b5c34d-c58`** (launched 2026-10-08 06:30 PDT, script @ 19b7b152, maxIters 3, watchdog `pm-watchdog.mjs` beside it; `wf_00d839e8-3c4` ran 06:20-05:58 and was stopped for the token fixes; before it `wf_d90d5c98-c0e`, 2026-10-07 16:10 to 2026-10-08 05:50,
  `build-directions.workflow.js` @ 197aff46; launch args and resume steps in RESTART.md "Day
  3"). Sonnet builds and fixes;
  Codex reviews (up to 3 rounds, Opus if Codex fails); Fable/Opus judge; 4 screens in
  flight per direction, one per screen family; merges serialised; resumes pushed work
  branches. **If it dies:** relaunch per RESTART.md "Day 3".
- Open Phase 3 item from the r5 critique: Tactile band codes double at 412px
  (per-bar label gate).

Stopped: Codex build driver PID 30772 (2026-10-06 23:00 to 2026-10-07 06:20 PDT): merged
tactile p3-icons and ambient p3-gallery; tactile p3-primitives, p3-gallery and ambient
p3-icons, p3-primitives ended blocked by the Codex review after one fix round (real
hard-rule findings: a global safeUrl change reaching the download queue, gallery copy
evading the listener-copy gate, an un-escaped interpolation, AA contrast); both Now
Playing screens in progress (pushed). Too slow (Codex steps 10-60 min each, one screen at
a time), so the build went back to Claude.

Stopped: `wf_7ee4833f-b81` (Claude workflow, 21:05-22:40 PDT): baseline, Tactile prep
(Big Shoulders, artifact republished), both BUILD-PLANs (Fable), `p3-tokens` merged in
both directions (tactile 45f848ee, ambient de82b662). Stopped to save Claude's last
weekly usage for taste calls; the driver continues from its branches.

Finished: `wf_bab57673-e04` "redesign-2026-night-1" (19:40-22:40 PDT, 128 agents,
0 errors) ran 0a-0e, 1, 2, Rank and the checkpoint package.

## Next actions (orchestrator)

- **Lab dry run** — BLOCKED, see below. When unblocked: dispatch
  `gh workflow run lab-build.yml -f ref=feature/redesign-2026 -f platforms=both`
  to ship today's design as "4a Lab" to Wyatt's iPhone and Joey's Android. If
  Play refuses the first upload of the new app, file one HUMAN-ACTIONS item with
  the AAB link and the console clicks. The first run also checks the untested
  iOS display-name/bundle-id read-back and the Android debug APK step.
- **When the owner picks (HA #148):** launch phases 3-5 with
  `Workflow({scriptPath: "<trunk>/docs/redesign-2026/workflows/build-directions.workflow.js", args: {directions: ["<slug>", "<slug>"]}})`.
  It creates `feature/redesign-2026-<slug>` per direction, plans, builds the
  foundation, loops screen by screen (gates, fidelity, both-order judges, review,
  merge), dispatches lab builds, and runs QA. Dry-run with stub agents: clean.
  Needs `redesign/p0-gates` and `redesign/p0-fidelity` (build-loop.md) merged first.
- `mobile/VERSION` shows as modified in the main worktree, but it is a
  line-ending-only (CRLF) change with no content diff. Leave it alone.
- Windows `run-suites` failures (10 on the trunk, up to 27 in the split agent's
  wider run) are CRLF/environment-only: the trunk is fully green on Linux and
  macOS CI (run 37411460946, all 9 jobs). Judge Linux CI, not the Windows count.

## Blocked

(Item, reason, what would unblock it.)

- Nothing blocked. (Lab dry run unblocked 2026-10-05 21:17 PDT: PR #1087 merged, 749a986b.)

## Fable invocations

(Date, phase, count, why. Owner-authorized 2026-10-05 for Phase 2 art direction.)

- 2026-10-05/06, Phase 2 art direction, 20 Fable calls across 5 directors, owner-authorized.
- 2026-10-06, Tactile font change, 3 Fable calls, owner-requested.
- 2026-10-06, Tactile font round 2, 3 Fable calls, owner-requested.
- 2026-10-06, Phase 2 polish-to-ready, 5 Fable calls (ambient r4, editorial r4, clarity r4, native-2026 r4+r5), owner-requested.
- 2026-10-06, Phase 3 plan, 2 Fable calls (tactile and ambient BUILD-PLAN.md, workflow `wf_7ee4833f-b81`), owner-authorized for phases 3-5. From 23:00 the Codex driver counts its own Fable calls (`status` -> "Fable successful calls"); add them here when it finishes.

## Log

- 2026-10-05 — Plan approved by the owner in session; trunk branch created from
  `main` @ 3a9dfefa; PLAN/PROGRESS/RESTART written.
- 2026-10-05/06 — 0a Eyes done: screenshot + a11y harness at `tools/ui-lab/`.
- 2026-10-05/06 — 0b Judge done, calibrated, accuracy 100%: `docs/redesign-2026/judge/`.
- 2026-10-05/06 — 0c Test classification done: `docs/redesign-2026/test-classification.md`.
- 2026-10-05/06 — 1 Research done: `docs/redesign-2026/research/` (7 notes) and `docs/redesign-2026/design-brief.md`.
- 2026-10-05/06 — 0d Split app.js merged into trunk (2614fc29). node --check clean; run-suites had 10 Windows CRLF failures identical to the pre-merge trunk (not caused by the split).
- 2026-10-05/06 — 0e Lab build path merged into trunk (b74338a0). node --check clean; run-suites had the same 10 Windows CRLF failures as the pre-merge trunk (identical set, diffed), none new.
- 2026-10-05/06 — 2 Directions + checkpoint package committed (99e8f9a1). Ranking tactile 15/15, ambient 12/15, editorial 8, native-2026 7, clarity 3, today 0; every direction beats today 3/3. Six private artifacts published; HA #148 via PR #1090 (doc-only, auto-merges).
- 2026-10-05/06 — Trunk verified green on Linux + macOS CI (run 37411460946): the Windows failures are CRLF-only.
- 2026-10-05/06 — Judge skeptic review merged (redesign/p0-judge-skeptic adf5fb17): r1 pairs were answerable without taste; hard set 36/36 with both orders, 0/24 position-following; rubric + protocol fixed. Top-2 recommendation stands under the new protocol (3-0 sweeps across both orders); middle ranks are leans.
- 2026-10-05/06 — Visual baselines merged (redesign/p0-baselines 51ebe347): `tools/ui-lab/baseline.mjs` record/compare/list, pixelThreshold 0, 138-shot double render 0 diffs, 16 tests, CI green (run 37414072294).
- 2026-10-05/06 — Checkpoint artifacts verified (all six render: bundled artwork, no blocked hosts, routes navigate).
- 2026-10-05/06 — Hard-limit gates merged (redesign/p0-gates 018db2c1): `tools/ui-lab/gates.mjs`, 8 gates; hit-tested tap targets, viewport-geometry overflow. Today's debt 119 (110 tap targets, 8 contrast, 1 overflow: stress/episode-token at 375px) in `gates-known-debt.json`. Real-browser smoke of the 0d split: 0 console/page errors, 0 CSP violations across 46 screens.
- 2026-10-05/06 — Fidelity tool + build-loop runbook merged (redesign/p0-fidelity 9e97cf08): `tools/ui-lab/fidelity.mjs`, `screens.json` per direction, `docs/redesign-2026/build-loop.md`. ui-lab suites 55/55, suite-integrity 477/477.
- 2026-10-05/06 — Phases 3-5 workflow staged: `docs/redesign-2026/workflows/build-directions.workflow.js` (c24d5e69), stub dry run clean.
- 2026-10-05/06 — Lab dry run dispatched (PR #1087 merged 21:17 PDT, so lab-build.yml is on main). First Android attempt exposed a pipefail bug in the read-back step; fixed and tested (a684a6c0); re-run queued. Trunk CI 37424512769 green on all Linux jobs after the gates/fidelity merges.
- 2026-10-06 — Lab dry run DELIVERED: iOS uploaded to TestFlight (run 37423123667, delivery 752b5524-1d15-44a4-b8e6-0209b87a879b); Android uploaded to the Play internal testing track (run 37424888622, with the read-back fix). The 4a Lab delivery path is proven for both platforms; no HUMAN-ACTIONS item needed.
- 2026-10-06 — Polish-to-ready pass (owner request, workflow wf_dfc8207d-359, 76 agents, 0 errors): ambient r4, editorial r4, native-2026 r5, clarity r4 all Ready; re-ranked six entrants, 4 judges per pair in both orders: tactile 20, ambient 15, editorial 11, native-2026 10, clarity 4, today 0; position-following 10%. Recommendation unchanged (Tactile + Ambient). Comparison page and four prototypes republished to the same URLs (version 2). Why it was needed: the overnight run capped every direction at a fixed 3 rounds instead of polishing to Ready.
- 2026-10-06 — Tactile header font (owner feedback 'cartoonish'): Bricolage display/title replaced by Archivo (alternates IBM Plex Sans, Instrument Sans), round 5, art director Ready; review-only font switcher in the prototype; Tactile prototype and comparison page republished in place. Waiting for the owner to approve the font before Phase 3.
- 2026-10-06 — Tactile header font round 2 (owner: round-1 faces too plain; keep the original fun intent, not Bricolage; Archivo is the fallback; dark mode stays): fun picks Anybody, Big Shoulders, Dela Gothic One, default Anybody, round 7, art director Ready; Tactile prototype and comparison page republished in place.
- 2026-10-06 — Tactile font decision applied (owner pick, Big Shoulders, 20:55 PDT): `prototype/tokens.css` now sets display/title/heading in Big Shoulders at the BUILD-NOTES 1.1 r7 values (800/750/750, 44/36/26/22px, hero line-height 1.2 moved into `app.css`); Anybody, Dela and Archivo WOFF2/@font-face/tokens and `font-preview.js/.css` deleted; prototype README rewritten; `build-checkpoint.mjs` ROUNDS tactile -> r8. Re-shot `--scheme light` to `data-local/redesign/shots/tactile/r8` (21 shots, 0 errors, Home background pixel #F7F0E4 confirmed with pngjs); Tactile artifact https://claude.ai/artifact/6N8mk5PZJc32D8shdHw7GK republished in place (v4, fonts inlined, font-preview files removed, title kept). Open: Phase 3 still re-cuts the Big Shoulders hhea/OS2 metrics for WebKit.
- 2026-10-07 — tactile/p3-tokens: skipped, iterations 0, judged by none
- 2026-10-07 — tactile/p3-icons: NOT merged (implementer failed), iterations 0, judged by none
- 2026-10-06 23:00 PDT — Claude weekly usage at 91% (resets 2026-10-07 16:00): owner asked to lean on Codex and make the run resumable. Claude workflow `wf_7ee4833f-b81` stopped (p3-tokens merged in both directions); phases 3-5 moved to the Codex build driver `build-directions.codex.mjs` (1838677f, fixed 9013ec3f: short worktree root `C:\Users\Fourtys\fw`, serialised trunk git), dry run 15/15 with mutations, relaunched detached as PID 30772. The two 2026-10-07 lines above (p3-tokens skipped, p3-icons NOT merged) come from the first launch at 22:54, aborted after 10 s on a Windows long-path failure; p3-icons is not failed, the driver resumes it. Resume instructions: `PAUSE.md` (worktree root); resume prompt scheduled for 16:07 PDT in this session.
- 2026-10-07 — tactile/p3-tokens: skipped, iterations 0, judged by none
- 2026-10-07 — ambient/p3-tokens: skipped, iterations 0, judged by none
- 2026-10-07 — ambient/p3-icons: NOT merged (review blocking), iterations 1, judged by none
- 2026-10-07 — tactile/p3-icons: merged, iterations 2, judged by none
- 2026-10-07 — tactile/p3-primitives: NOT merged (review blocking), iterations 1, judged by none
- 2026-10-07 — ambient/p3-primitives: NOT merged (review blocking), iterations 2, judged by none
- 2026-10-07 — tactile/p3-gallery: NOT merged (review blocking), iterations 1, judged by none
- 2026-10-07 — tactile: Phase 3 foundation 2/4 merged into feature/redesign-2026-tactile
- 2026-10-07 — ambient/p3-gallery: merged, iterations 1, judged by none
- 2026-10-07 — ambient: Phase 3 foundation 2/4 merged into feature/redesign-2026-ambient
- 2026-10-07 06:40 PDT — Overnight Codex driver result: foundation 4/8 merged in total (tactile tokens+icons, ambient tokens+gallery), 4 blocked at Codex review, 0 screens; 1 Fable call, all verdicts by Claude (none Codex-judged or UNJUDGED). Owner: switch back to full Claude, spend the last ~8% weekly before the 16:00 reset, keep Codex for code reviews. Driver stopped; ambient now-playing WIP saved (86d27a06); workflow reworked (77a8fa81: Opus builds, Codex reviews x3 with Opus fallback, 4 screens in flight per direction by family, resume pushed work branches, UNJUDGED flag, plans from file; stub harness 10/10, three mutations caught) and launched as `wf_8c930d5d-182`.
- 2026-10-07 — ambient: Phase 3 foundation 3/4 merged into feature/redesign-2026-ambient
- 2026-10-07 — tactile: Phase 3 foundation 4/4 merged into feature/redesign-2026-tactile
- 2026-10-07 16:10 PDT — Run `wf_8c930d5d-182` (06:40-09:19) died on the weekly limit: merged tactile p3-primitives + p3-gallery (tactile foundation 4/4) and ambient p3-icons (foundation 7/8 overall); ambient p3-primitives' Codex review was cut off by the limit (not a verdict); its 12 screen starts, QA and lab steps all failed on the limit (its "0 high QA issues" is vacuous, not a result). 58 agents, 6.3M subagent tokens. After the 16:00 reset: workflow fixed (197aff46: any CODEX_REVIEW_* failure -> Opus review, QA/lab skipped when screens stop, builders back to Sonnet now that the last-8% push is over; stub 13/13, both fixes mutation-tested) and relaunched as `wf_d90d5c98-c0e`. PAUSE.md retired; resume steps now in RESTART.md "Day 3".
- 2026-10-07 — ambient: Phase 3 foundation 4/4 merged into feature/redesign-2026-ambient
- 2026-10-08 — tactile: Phase 4 screens 13/19 merged; escalated: mini
- 2026-10-08 — ambient: Phase 4 screens 5/16 merged; escalated: today, foray-detail
- 2026-10-08 06:20 PDT — Run `wf_d90d5c98-c0e` (16:10 to ~05:50, 510 agents) merged 18 of 35 screens (tactile 13/19: home, home-first-run, home-loading, search, search-typing, search-none, mini, library-empty, library-shows, foray, onboarding, settings, toast; ambient 5/16: today, show, foray-detail, onboarding, settings-tuning-about), then the disk filled (C: 0 GB free): ~260 leftover agent worktrees (~115 MB each) plus test temp. Run stopped; 121 finished worktrees (HEAD on origin, clean) removed with plain `git worktree remove` -> 18.8 GB free; 140 with modified/untracked files and 30 belonging to other sessions left untouched. Workflow now cleans up after each screen and stops starting screens under 4 GB (2b1584d8; stub 17 checks, low-disk mutation caught after the first version of that check proved vacuous). Relaunched as `wf_00d839e8-3c4`. Still open: both Now Playing screens (long fix/review loops), tactile now-playing-paused/-episode, home-offline, library, library-forays; ambient dock, discover, library, now-playing-car, episode, playlist-detail-and-playlists, up-next, forays-list, category-and-browse, not-found.
- 2026-10-08 06:30 PDT — Owner: one night cost 45% of the weekly Max 20x plan; be efficient and project-manage. Token audit of `wf_d90d5c98-c0e` (510 agents, `workflows/token-audit.mjs`): builders 65% and fixers 17% of usage, from ~316-turn agents re-reading ~376k-token contexts every turn (6.5B cache reads); checks 5%, judges+fidelity 5%, Codex-review wrappers 1.5%, Opus fallback reviews 3%. Fixes (19b7b152): context budget for every build-type agent, build/fix agents hand over to a fresh agent after ~100 tool calls (up to 4 chunks), `maxIters` 4 -> 3; model-free PM watchdog `workflows/pm-watchdog.mjs` (DISK/STALL/ERRORS/RUNAWAY/STUCK/BURN) runs beside the build. Disk: of 175 GB in `%TEMP%\claude`, 151 GB is Swift2 session temp (not this effort; left for the owner), 3.8 GB foray. Relaunched as `wf_91b5c34d-c58` with the watchdog.
