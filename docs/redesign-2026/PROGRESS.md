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
| 3–5 | **running** (`wf_7ee4833f-b81`, from 2026-10-06 ~21:05 PDT) | Tactile + Ambient; see In flight |

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

- **Phases 3-5 build, `wf_7ee4833f-b81`** (launched 2026-10-06 ~21:05 PDT, night 2).
  `build-directions.workflow.js` with `directions: ["tactile", "ambient"]` plus the
  Tactile prep step (Big Shoulders made the prototype default, "Aa" switcher and
  dropped fonts removed, r8 re-shoot, Tactile artifact republished in place). Per
  direction: creates `feature/redesign-2026-<dir>`, plans (Fable), builds the
  foundation, loops screen by screen (gates, fidelity, both-order judges, review,
  merge), dispatches lab builds, runs QA. **If it dies:** relaunch exactly as in
  `RESTART.md` step 4; units already merged into a direction branch are skipped.
  Open Phase 3 item from the r5 critique: Tactile band codes double at 412px
  (per-bar label gate).

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
- 2026-10-07 — Ambient Phase 3 primitives + gallery completed on `redesign/ambient-p3-primitives`: full BUILD-NOTES §3 inventory in both schemes, live sheet focus traced, gallery gates 0 new, `ambient-gallery` 6-shot baseline and rolling `ambient-app` 144-shot baseline recorded; `trunk-app` comparison is 138 same / 0 differ / 6 gallery additions. Eight named mutations ran red and the targeted aggregate passed. Existing screens remain pixel-identical and adopt only in Phase 4.
- 2026-10-07 — Ambient Phase 3 primitives iteration 2: kept the native bundle's legacy-growth alarm at 2.85 MB, added tight 20/15/9 KB budgets for the isolated CSS/JS/gallery foundation, and left the complete 3 MB hard cap intact. Targeted root/native/UI-lab suites pass; gallery gates have 0 new debt; `ambient-gallery` is 6/6 exact and `ambient-app` 144/144 exact.
- 2026-10-07 — Ambient Phase 3 component gallery baseline completed on `redesign/ambient-p3-gallery`: 41 stable Dusk/Dawn capture plates across three viewports, both live sheets focus-traced, explicit dark/light renders reviewed against the ready round-4 Afterglow prototype, gallery gates 0 new debt, `ambient-gallery` 123/123 exact, unchanged `trunk-app` screens 138/138 exact, and rolling `ambient-app` refreshed to 261 shots; the new capture-map test's named `cards-tiles` mutation ran red.
- 2026-10-07 — Ambient Phase 3 gallery blocking review fixed on `redesign/ambient-p3-gallery`: detail Strip thumbnails and +4px upward current bar, outlined 44px row Play, visible current-queue "Playing" state, and SubjectTile default/pressed plates. Four named mutations ran red; targeted suites, explicit Dusk/Dawn gallery shots, gates and rolling baselines were rerun before push.
- 2026-10-07 — Ambient Phase 3 primitives second blocking review closed on `redesign/ambient-p3-primitives`: loading rows/cards no longer dim text (AA; spinner + `aria-busy` on their Play control), spinner replaces the glyph in its 24px slot, buffering MiniPlayer breathes its glyph per BUILD-NOTES §3, disabled chip at 40%, HeroPick mojibake fixed, drag MiniPlayer plate no longer overlaps. Review items 2 (plate coverage) and 3 (sheet-open stability) were already closed by the gallery unit and re-verified (123/123 exact before; final code recorded privately compares 123/123 twice). Seven new tests, each mutation run red; gallery gates 0 new (dark and light); `trunk-app` 138/138 exact; intended `ambient-gallery` diffs listed in BUILD-NOTES §15.10.
- 2026-10-07 — Ambient Phase 3 primitives round-4 review closed on `redesign/ambient-p3-primitives`: Codex's one blocking item (the EpisodeRow state line spliced its class modifier and caption without `esc()`) fixed; a recording-`esc()` test pins both splices (two mutations run red; floor 23 -> 24). Rendered markup is byte-identical (constants), so the gallery baseline is unaffected; targeted suites green, gallery gates 0 new in dark and light.
- 2026-10-07 — Ambient Phase 3 primitives round-5 review on `redesign/ambient-p3-primitives`: the round-5 Codex run lost its shell (every spawn 0xC0000142, desktop-heap exhaustion under load) and read files via its GitHub connector instead; it returned **merge, 0 blocking**, and an independent Opus pass agreed (11 named mutations all run red, gallery gates 0 new). Nits taken: Reduce Motion holds the buffering glyph at 0.9 per BUILD-NOTES §5 (new test, mutation run red, floor 24 -> 25), spinner-width test scoped to glyph controls, minified `primitives.js` size refreshed (16,355 B, 29 B under budget). Gallery gates 0 new in dark and light; the full run-suites failures on Windows are the 9 native CRLF-only checks.
- 2026-10-07 — Ambient Phase 4 Today (Home) built on `redesign/ambient-today`: hero (foray, else first pick) lit by its show, Keep listening, six-row picks with the Stretch card, the one Playlists rail, Off your path, first run / offline / loading / mid-listen / stress states, pick-to-play Glow and FLIP; `ui/home.js` rewritten, `ui/today.css` and `ui/palette.js` added, the old Home renderers and their tests retired. Gates 0 new; `ambient-gallery` 123/123 exact; `ambient-app` compare shows only the 15 intended Home diffs and 9 added states (not re-recorded: it re-locks on merge); 18 new tests, 40 named mutations run red. Judge passes not run (no judge agent in this run). Notes: `directions/ambient/BUILD-NOTES.md` §16.
- 2026-10-07 — Ambient Today iteration 2 on `redesign/ambient-today`: the six art-director findings closed. Three-tab Dock (Today, Discover, Library; Create folded into Discover, Fill glyph in Lamp for the active tab) wearing the warm Glow Veil, inset and rounded, with a bottom fade so content is never sliced; the hero meta is one line (nowrap, Play never shrinks, a long meta drops under Play whole); typographic apostrophes. Fidelity `today-iter2-c`: `tabBar` delta 0 on six states. Four new tests (floor 18 -> 22) with 13 named mutations run red; gates 0 new; `today.css` budget 8 -> 10 KB (9.2 KB minified). Rulings that fell: "Four tabs + drawer" (tab-bar, home-information-architecture, library-screen, category-browse rewritten). Notes: `directions/ambient/BUILD-NOTES.md` §16 item 13.
- 2026-10-07 — Ambient Today iteration 4 on `redesign/ambient-today`: the two art-director findings closed. The foray hero meta is one nowrap line beside Play ("4 shows · 19 min", the prototype's); a meta that carries the estimate marker and cannot fit the 109px beside Play ("1 show · about 43 min") stacks its two parts one per line with no stranded separator (`todayForayMetaHtml`, copy unchanged). The 2x2 collage gap is a 1px hairline in `ui/primitives.css`, one rule for hero 160 down to the 72 row (shared file; moves every `c4` collage, gallery included, which is why `ambient-gallery` is not exact this iteration). No new suite (floor unchanged); two tests rewritten with new named mutations run red. Gates 0 new.
- 2026-10-07 — Ambient Foray detail built on `redesign/ambient-foray-detail` (`ui/foray-detail.css`, `ui/foray.js`, `ui/foray-player.js`, `ui/palette.js`): a fixed Room from the first show's art (Dusk scrim, Dawn paper), the 160 collage, Lamp eyebrow, three-line title, caption, strip on its sill with a thumbs row, one primary button (Play / Resume · N min left / Play again), why-line, three-up show tiles with Follow, QueueRow clips with Lamp narration rows, an unavailable page (Find similar) and a not-narrated page. The page's old transport (back 15, forward 30, speed, clip row) moved to Now Playing only. New `test/ambient-foray-detail.test.js` (21 tests, 40 named mutations run red), `foray-detail`/`foray-resume` states, fidelity run `foray-detail-i2`, gates 0 new on the Foray states. Judges and reviewer not run by this agent (no sub-agent tool): see BUILD-NOTES section 13.
- 2026-10-07 — Ambient Foray detail iteration 2 on `redesign/ambient-foray-detail`: the Room's scrim ramp starts behind the artwork (120, not 196: no seam under the sleeve), narration is a never-dimmed Lamp pill, thumbs fill the sill on long Forays (12px bar, 4px clear, inside the strip), and the "Start over" link is gone (one button, button to "Why 4a made this" back to the prototype's 24px). Dock findings left to `redesign/ambient-dock`. Six new named mutations run red; gates 0 new on the Foray states; the only run-suites failures are the 9 Windows native CRLF checks.
