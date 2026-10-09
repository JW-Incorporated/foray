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

- 2026-10-07 — Tactile gallery, review blocker fixed on `redesign/tactile-p3-gallery` after merging the primitives second/third-review fixes: the display specimen no longer rebuilds the banned "stitched" from fragments; it reads "Podcasts, lined up around you." (BUILD-PLAN 1.7 records the hard-limit override; onboarding follows in Phase 4). `test/tactile-gallery.test.js` now scans the rendered gallery copy in both schemes (floor 3 -> 4; mutation ran red on the stitching rule). Root suites green except the known Windows CRLF four; ui-lab 55/55; gallery gates 21 screens, 0 new, light and dark; Cream samples `#F7F0E4`; `trunk-app` 138/138 listener shots identical, only 63 gallery shots added; `tactile-gallery` re-locked at 63 shots (re-compare 63/63 identical) and rolling `tactile-app` at 201, both explicit `--scheme light`.
- 2026-10-07 — Tactile Phase 4, screen **Today** (group B, `redesign/tactile-home`): `#/` renders the Dial Today in `ui/home.js` over the primitives: title row with the knob (it is the drawer's opener, `menuOpener()`), Resume (part-played Foray or episode, hidden only while it sounds), Today's foray hero (band, discs, why, Play xl), Also today (three rows plus the Stretch bridge second, the sentence naming both subjects, <= 16 words), Playlists for you (2-up composites), New ground (the gauge). Rulings that fell: Home section order and content (U-03): the rails, "Suggested", the greeting and the play capsule went, with their CSS and tests; the floor did not (Also today always carries its Stretch slot, 20 renders, real data included). Decisions made without the owner: (1) the tab bar keeps four destinations and is drawn as the Dial deck on Today only (`body.view-home`), with the Home tab renamed Today everywhere (the three-tab IA is Find's and Yours' to adopt); (2) the deck's active indicator is at the TOP as in the prototype render (the gallery primitive has it at the bottom: follow-up for the primitive); (3) primitives gained opt-in engine hooks (`data-play`, `data-upnext`, `data-ctl-icons`, `data-branch`), `data-ctl-icons` controls are never written text by `setControlLabel`/`paintControl`; (4) four primitive CSS fixes to meet BUILD-NOTES: the bridge's stretch art is 72, its dots are real circles, the gauge needle 10px and 3px hatch, the row's why-line spans the key column, and the show name no longer has `min-width: 112px` (it pushed a long length over the key); (5) with the test track on, drafts are listed under Forays and Home links there. Fidelity (Cream, vs `home`): header, primary and tabBar +0, hero and rows within +0.1px at 393; at 375/412 the hero/rows deltas are the prototype's longer title and why-lines (measured: with its Barbecue title the app hero is the prototype's +24px, one why-line). Bakelite holds at 393. gates (dark, `--allow`): 0 new on returning/stress/player/empty/first-run, contrast 0; axe (Cream): only the known meta-viewport. Suites: 4575 pass, 7 fail, all 7 identical on the unmodified branch (Windows CRLF / schema). New `test/today-screen.test.js` (17, floored); 37 named mutations run red, plus the two that survived and were fixed. Baselines NOT re-recorded (the orchestrator re-locks after merge): `tactile-gallery` differs in rows, band-states and surfaces (intended: the primitive fixes above) and by 1-83 px in 9 later shots (sections below the rows moved by a fraction of a pixel); `tactile-app` differs on every Home shot, every first-run shot, the gallery shots and by the "Today" tab label (427 px, rows 1663-1681) on every other screen.
- 2026-10-07 — Tactile gallery blocking-review follow-up on `redesign/tactile-p3-gallery`: both schemes now expose and capture the line and buffering bands, playlist-card skeleton, paused and playing mini players, and an open modal sheet in its matching scheme; the contrast specimen now carries all 12 BUILD-NOTES pairs, including on-rubber/rubber. Three named mutations ran red, 58 targeted checks pass, gallery gates are clean across 21 states, Cream samples `#F7F0E4`, all 160 non-gallery app shots remain pixel-identical, and explicit-light `tactile-gallery` / `tactile-app` baselines re-lock at 63 / 201 shots.
- 2026-10-07 — Tactile Phase 3 task 3 (primitives) on `redesign/tactile-p3-primitives`: token-driven keys, chips, tags, artwork, cards, bands, gauges, rows, tiles, mini player, three-tab deck, modal sheet, rotary, skeleton, empty state, toast, and bridge land in `ui/primitives.js`, demonstrated in stacked Cream/Bakelite gallery sections. Five focused suites carry floors and each ran its named mutation red. Gallery gates are clean across 13 states; shared `tactile-gallery` (39 shots) and rolling `tactile-app` (177 shots) baselines were recorded with explicit `--scheme light`. Listener screens remain untouched: `trunk-app` comparison found 138/138 identical at zero tolerance, with only the 39 gallery captures added.
- 2026-10-07 — Tactile primitives blocking review follow-up: corrected Bakelite rubber-keycap contrast, safe fragment URLs and classic-script scanning, bidirectional sheet trapping, operable snapping scrubbers, complete skeleton anatomy, and adoption-ready bridge controls. Targeted mutations ran red; gallery gates are clean; explicit light/dark shoots were reviewed; `tactile-gallery` 39/39 and rolling `tactile-app` 177/177 re-lock at zero pixel tolerance.
- 2026-10-07 — Tactile primitives, second-review blockers: `safeUrl()` is back to http(s)-only (the fragment branch had opened `ui/downloads.js`'s scheme gate; icon hrefs now come from the allow-list-only `tactileSpriteRef`, with a downloads regression test); band bars use a non-overlapping minimum-width layout and progress, needle and scrubber map through the drawn bars; the resting toast is `inert` plus `visibility: hidden`. Nits: buffer/skeleton durations are `:root` tokens, artwork alt is decorative by default and fetches 3x its drawn size (perf-2 was red), and the gauge keeps the direction's copy (listener-copy's popup locator no longer picks it up). 22 named mutations ran red; root suites green except the known Windows CRLF four; gallery gates 13 screens clean; `trunk-app` compare 138/138 identical, 39 gallery shots added. Shared `tactile-*` baselines not re-recorded from this unmerged branch: re-lock at merge.
- 2026-10-07 — Tactile primitives, third-review blockers: icon sprite hrefs go through `safeUrl()` again, with no exemption left in the static href/src scan. `safeUrl()` passes exactly `"#"` + a symbol id from the new `SPRITE_IDS` set in `app.js` (pinned equal to the index.html sprite) and still answers `"#"` for every other fragment. `ui/downloads.js` now gates on `/^https?:/` instead of reading `"#"` as its only refusal, and `"#ph-play"` is in its regression test. A band rendered without an id gets a fresh `dial-band-N` per render, so two default bands no longer share pattern/clip ids. The deck is `position: fixed`, inset 16px plus the left/right safe-area insets, and sits `calc(var(--safe-b) + 12px)` from the bottom. The mini player carries its 3px `.band--line` (foray colours, or one persimmon bar for an episode; decorative, no needle). Mini and line narration is now a solid tick, not hatched (BUILD-NOTES 3.6). The gallery shows each deck inside a `.gallery-device` frame (`contain: layout`), so the specimen is the real fixed rule. Every new test ran its named mutation red. Gallery gates exit 0 (light scheme shot and reviewed). `tactile-gallery` was not re-locked: it now holds a later 63-shot gallery state set that this branch predates, so the comparison is not like for like. Re-lock it when this lands on the direction branch.
- 2026-10-07 — Tactile Phase 3 task 4 (component gallery) on `redesign/tactile-p3-gallery`: `#/gallery` remains Lab/`?gallery=1` only and now carries the exact ten-role specimen plus all 11 measured contrast rows in stacked Cream and Bakelite. The art-direction pass against r8 Today and Now Playing kept the system: Big Shoulders hierarchy, enamel materials, key depth, band grammar and deck all match. The new three-test floored suite ran all three named mutations red; gallery gates are 0/0 across 14 states, Cream sampled `#F7F0E4`, `trunk-app` kept 138/138 listener shots identical with only 42 gallery shots added, `tactile-gallery` re-locks 42/42 at zero tolerance, and rolling `tactile-app` records 180 shots with explicit `--scheme light`.
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
- 2026-10-06 — Tactile Phase 3 task 1 (tokens, motion, the one reduced-motion block) on `redesign/tactile-p3-tokens`: Dial token layer in `styles.css` (Cream + Bakelite, type, space, material, motion), three self-hosted faces (DialDisplay re-cut 84/24 verified in the bytes, DialText, Azeret; 119 KB), `test/ui-tokens-dial.test.js` (15 tests, 21 mutations run and red), twelve legacy-colliding tokens ship as `--dial-*`, two contrast corrections to BUILD-NOTES (ink-3, seg-c3). Screens untouched: trunk-app compare 138/138 same (dark) and 138/138 same (light, shot before and after). Decisions and deferrals (no-zoom, cp_theme, mobile bundle alarm) in tactile BUILD-PLAN 1.8.
- 2026-10-06 — Tactile Phase 3 task 2 (icon sprite) on `redesign/tactile-p3-icons`: one inline sprite in `index.html` (41 symbols, the prototype set verbatim: 27 Phosphor Bold, 7 Fill, 7 custom marks; 0x0, absolute, aria-hidden, first in body), `.sprite` / `.i` / `.i--sm` / `.i--lg` / `.knob-groove` in the Dial section of `styles.css`, and a `#/gallery` icon sheet guarded by the boolean Lab flag or explicit `?gallery=1`. `test/tactile-icons.test.js` has 9 tests and a FLOORS line; 18 named mutations ran red, including removal of the knob gallery item and accepting `?gallery=0`. Screens still swap glyphs in Phase 4; the gallery's `<use>` references are static, and dynamic references remain reserved for `ui/primitives.js`. Primary-scheme render sampled `#F7F0E4`; gallery gates are 3/3 clean. Shared `tactile-gallery` baseline recorded with `--scheme light`, 9/9 same at zero tolerance; `tactile-app` kept all 138 existing shots identical and reported only the 9 intended gallery additions.
- 2026-10-08 - Tactile Now Playing iteration 3 (fidelity fixes) on `redesign/tactile-now-playing`: band bars are now separate rounded blocks with a visible 3px gap (2px on mini/line) and 3px corners, converted from rendered px because the viewBox is stretched non-uniformly; the narration hatch is counter-scaled to screen pixels (3px/3px at 45 degrees, ultramarine on its soft tint); the code row sits 14px apart and drops the narrowest run (never the current one) where a code would be pushed more than 12px off its bar. Two new floored tests, six named band mutations and three code-fit mutations ran red. Gates 0 new; `tactile-gallery` and `tactile-app` differ only on band-bearing shots (band-states, surfaces, mini player, Now Playing), as intended; baselines not re-recorded here.
- 2026-10-07 — Tactile Phase 4 group C, `search` (Find, idle) on `redesign/tactile-search`: `#/shows` is now "Find" (display-xl title over the readout line; the tab bar and drawer say "Find" too), a fixed mosaic of 14 subject tiles (one 2x2, three 2x1, ten 1x1; seeded draw, 40% from outside the listener's own subjects against the 30% floor, no two neighbours from one branch, "More subjects" swaps the set), a followed-shows strip only when the listener follows something, and the 52px field pill docked 12px above the deck with a clear key that waits for text. Rulings that fell, in the PRs that adopt them: the A-Z index of every catalogue show, the browse-pill cloud and the "Shows 4a vouches for" row all left this page (the direction ends it on "More subjects"; `vouchForHtml` stays, rendered nowhere), and the search tab/page name "Search" became "Find". The old four-tab bar wears the deck's box on this page only, until tactile `mini` replaces it. Fidelity vs the prototype at 375/393/412 in Cream: header, field, rows and tabBar all 0px; Bakelite pass at 393 clean. New suite `test/tactile-find.test.js` (17 tests, floor 17, 27 named mutations run red); root suites green except the known CRLF four; gates exit 0 (new 0); `tactile-gallery` compares 63/63 identical; `tactile-app` differs only on the Find states and by the renamed tab label on every other screen (about 400px each), so it needs re-locking at merge. Not run by this agent: the three-judge pairwise pass and the fresh-context reviewer (no subagent tool in this worker); the Playwright specs `search-chrome-dock` and `search-result-stability` were updated for the new geometry and checked by hand in the harness, not run under the Playwright runner.
- 2026-10-07 — Tactile Phase 4 group C, `search` iteration 2 on `redesign/tactile-search`: the Find fidelity findings. The dock findings (four tabs, thin glyphs, deck material) were the old four-tab bar wearing the deck's box on this page only, so `redesign/tactile-mini` (the live three-tab deck: Today/Find/Yours, Phosphor Bold/Fill, indicator, Yours badge) is merged into the branch, and the interim `body.view-find .tab-bar` skin is deleted. The deck now stands on a fixed paper fade (`body.view-find::after`, z 50 behind the field and deck, ported from the prototype's `body::after`) so no tile text shows clipped in the 12px field-to-deck gap or tile art below the deck edge; the field's dock variable moved to the body and a dismissed mini gives its room back. The 'See all' action left the Followed shows heading (prototype has the heading alone); #/starred-shows stays reachable from Yours (`lib-more`), and `test/starred-shows.test.js` reachability was rewritten on purpose to say so. Fidelity `search-i2` (Cream, 375/393/412): header, field, tabBar 0px; rows 0px at 393/412 and +18px at 375 (a three-line tile title from different data, not layout); Bakelite 393 clean. Gates exit 0 (new 0); `tactile-gallery` 63/63 identical; `tactile-app` differs on the deck on every screen (expected, mini). `test/tactile-find.test.js` 19 tests (floor 19), 9 named mutations run red here, 2 more in starred-shows. Not run here: the judge pass and a fresh-context reviewer (no subagent tool). Windows run-suites also shows the failures that come from the merged mini/now-playing branches (privacy key families `cp_art_tint`, label helpers, sheet transport rows, bundle headroom 34 KB under the 3 MB cap) and the CRLF set; none is in Find.
- 2026-10-07 — Tactile `search` review fixes on `redesign/tactile-search` (carries the merged now-playing and mini units): no `cp_art_tint:` storage key (tint cached in memory; the privacy inventory stays 33), Now Playing text writes go through setControlLabel/setStatusText (container clears named in toggle-labels NOT_CONTROLS), transport-controls and episode-link pins rewritten for the haptic call and requestExpanded, mid-drag aria-valuetext follows the thumb again, lock-screen artwork back to one entry (the six-size ladder mislabelled one URL). Windows run: only the known CRLF/build-stamp failures remain.
- 2026-10-07 — Tactile Phase 4 group C, `search-typing` (Find, typing) on `redesign/tactile-search-typing`: results replace the mosaic as Shows (`.row-show` 56 around the `.show-result` link, count readout), Episodes (`searchEpisodeRow`: art 56, title as a stretched link, one Play keycap sm that the player repaints by swapping its `<use>`, "+ Up Next" on the meta line, the show's display name at `min-width: 112px`) and Playlists (two-column `.pcard` collages), each a 17px heading with a count; the last row is the ultramarine sparkle key "Make a playlist about" (escaped, never the bridge mark), now offered whether or not a playlist matched. The star, date, show-name link and description line leave the search episode row (the row/card anatomy ruling, for this list only); `tactileDisplayName` drops a trailing "Podcast" (gallery `*-rows` baseline needs a re-lock). Harness: `search-results-typing` appended (type, press Enter), `search-typing` re-mapped to it with the key as a region. Fidelity `search-typing-i4` (Cream, 393x852 and 412x915): header, field, rows, primary key and tab bar all 0.0px; at 375x667 the meta wraps (rows +16px). New suite `test/tactile-find-typing.test.js` (13 tests, 33 named mutations red).
