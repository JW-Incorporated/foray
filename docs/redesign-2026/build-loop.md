# Redesign 2026: Phase 3/4 build-loop runbook

What a Phase 3/4 workflow and its agents follow once the owner has picked
directions (`PLAN.md`, owner decision 8). One instance of this runbook runs per
picked direction, parameterised by its slug (`tactile`, `ambient`, ...).
`PLAN.md` holds the rules; this file is the procedure. Where they disagree,
`PLAN.md` wins. Numbers marked **(decision)** are this runbook's calls, not the
owner's; change them here if experience says so.

## 0. Before anything

- Read `PLAN.md`, the direction's `DIRECTION.md` and `BUILD-NOTES.md` (the
  measurements; where a number there and a sentence in DIRECTION disagree,
  BUILD-NOTES wins), and its `critique-r3.md` (the open P1/P2 fixes the art
  director wrote down). Search `docs/research/corpus/digests.md` before reasoning
  from memory on legal/audio questions (CLAUDE.md "Research corpus").
- Tooling is in `tools/ui-lab/` (`README.md`): `shoot.mjs`, `a11y.mjs`,
  `baseline.mjs`, `judge-set.mjs`, `fidelity.mjs`, and `gates.mjs` (hard-limit gates;
  lands from branch `redesign/p0-gates` (CLI: `--target`, `--allow <debt json>`, `--states`, `--no-remote-images`), with `gates-known-debt.json` as the
  accepted-debt list; it is a required step below from the day it is on the trunk).
  One-time per checkout: `cd tools/ui-lab && npm install && npx playwright install chromium`.
- Renders, judge sets and fidelity output live in `data-local/redesign/`
  (gitignored). **Never commit a screenshot or any third-party imagery, including
  renders of a prototype's artwork.** This is deliberately stricter than `PLAN.md`
  (which allows our own renders): a prototype render contains third-party podcast
  artwork, and the repo is public, so the rule is "no renders in git at all".
- **The shared data root.** An agent's isolated worktree has its own empty
  `data-local/`, so the baselines, `shots/today/` and judge refs recorded in the
  trunk checkout are not there. Every command that reads or writes them takes
  `--root <trunk checkout>\data-local\redesign`, i.e.
  `--root C:\Users\Fourtys\Documents\Claude\Projects\foray\.claude\worktrees\redesign-2026\data-local\redesign`
  (written `$ROOT` below): `baseline.mjs record|compare|list`, `judge-set.mjs`
  and `fidelity.mjs`. `shoot.mjs` and `gates.mjs` write to `--out`/their default under
  your own worktree; that is fine, nothing downstream needs those. Baselines are tied to
  one machine's Chromium and fonts, which is another reason they live in one place.
- Windows: Git Bash rewrites `#/...` arguments; use PowerShell or `MSYS_NO_PATHCONV=1`.
  `run-suites` shows CRLF-only failures on Windows; judge Linux CI, not the
  Windows count (`PROGRESS.md`).

## 1. Branches and merging

| Branch | Cut from | Merges into | By |
|---|---|---|---|
| `feature/redesign-2026-<direction>` (the direction branch) | trunk `feature/redesign-2026` | never `main` | created once by the orchestrator |
| `redesign/p3-<direction>-<task>` (foundation tasks) | the direction branch | the direction branch | after reviewer sign-off |
| `redesign/p4-<direction>-<screen>` (one per screen) | the direction branch | the direction branch | after reviewer sign-off |

- **Never open a PR into `main`** from redesign work, never push a `v*` tag,
  never dispatch `release.yml`, `pages.yml` or `android-release.yml` (`PLAN.md`
  "Isolation"). A PR into `main` that touches allow-listed paths auto-merges on
  green and reaches TestFlight in about two hours. PRs, if any, target the
  direction branch.
- Merge direction-branch work with a merge commit (keeps one screen = one
  reviewable unit), then update the rolling baseline (section 4, step 8).
- Agents run in isolated worktrees. At most **20 concurrent agents** (`PLAN.md`
  owner decision 2); parallelise across screens only after Now Playing has set
  the pattern, and never put two agents on the same `ui/*.js` file.
- `git add` explicit paths only; never `git restore`, `git checkout -- <file>`,
  `git clean`, `git reset --hard`, bare `git stash`. No blanket `git add -A` / `.`.
- One agent owns one screen's files for the length of its loop. Shared files
  (tokens, sprite, primitives, `index.html`) change only in Phase 3 tasks, or in
  a one-line follow-up PR to the direction branch that says which screens it
  affects. **`tools/ui-lab/lib/states.mjs`:** Phase 3 owns its structure; a screen
  agent may **append** the states and steps its own screen needs (a new entry in
  `appStates()`, or new steps in a state block it added), never edit or reorder
  existing ones. Appended blocks are what `screens.json` `app.state`/`app.step` point
  at; `fidelity.mjs` refuses a map that names a step that does not exist.

## 2. Hard limits (a direction may not challenge these)

Source: `PLAN.md` "Hard limits still in force" and `CLAUDE.md`. Each row names
the suite or gate that holds it; a loop that turns one of them red is not done.

| Limit | Held by |
|---|---|
| Every interpolation through `esc()`, every href/src through `safeUrl()` | `test/app-security.test.js`; `test/listener-copy.test.js` |
| Strict CSP: no inline `style=`, no inline script, no `javascript:`, fonts self-hosted (`font-src 'self'`) | `test/ui-tokens.test.js` (keep half); `gates.mjs` console/CSP gate |
| localStorage only through the storage shim, `cp_` keys (renaming wipes user state) | `test/app-security.test.js`; never invent a key without the prefix |
| Tap targets at least 44px | `test/tap-targets.test.js`; `gates.mjs` 44px gate |
| Focus managed in sheets (move in, trap, restore) | `test/modal-and-focus.test.js`; `gates.mjs` sheet-focus gate |
| **One** `prefers-reduced-motion` block naming every transition and animation | `test/ui-tokens.test.js`; `gates.mjs` reduced-motion gate. Every new transition or animation is added to that block in the same change |
| WCAG AA contrast for every text/background pair in every shipped scheme | `test/ui-tokens.test.js` (parametrised over the new token list); `node docs/redesign-2026/directions/ambient/contrast-check.mjs` is the pattern |
| No horizontal overflow at 375, 393, 412 wide | `test/no-horizontal-scroll.test.js`; `gates.mjs` overflow gate |
| Copy: why-lines at most 18 words, hooks at most 16; banned words ("fascinating", "deep dive", "delve(s)", "explores", clickbait withholding, commute-length framing, pipeline vocabulary such as "beat", "segment", "act", "running order"); no "we/us/our"; "subject", not "topic" | `backend/test/copyRules.test.ts` (`backend/src/copy/rules`); `test/listener-copy.test.js` |
| About 30% exploration floor on discovery surfaces; no streaks; no infinite scroll. Continuous playback is allowed and wanted (founder ruling 2026-09-14) | `test/home-v2.test.js` (floor); `test/up-next-autoadvance.test.js` |
| Legally boring: never rehost, proxy or transform episode audio, never strip ads, no "skip the sponsor"; no copy implying we produce a new audio file | `test/listener-copy.test.js` (stitching rule); product principle 3 |
| State observed, never declared (no manual "done" toggles, no commute-length UI) | review; product principle 2 |
| Lab builds never write to production (no sign-up, token refresh, or event POST) | `test/lab-flag.test.js`; `window.__FORAY_LAB__` |
| No new secrets, no paid services, free/OFL fonts only | review; `PLAN.md` owner decision 3 |

Rulings a direction **may** overturn (dark-only, 4 tabs + drawer, no zoom, card
anatomy, section order, palette) are listed in `test-classification.md` section 0.
A loop overturns one only if the owner's pick said so, and the PR says which.

## 3. Phase 3: Foundation

One agent per task, in this order, each its own `redesign/p3-<direction>-<task>`
branch, each merged before the next starts. Output is **real app code**, not a
prototype: the prototype is the target, `BUILD-NOTES.md` the measurements.

1. **Tokens, motion included.** Colour (every declared scheme), type scale,
   spacing, radius, elevation, and motion (duration and easing tokens, the one
   reduced-motion block). Nothing hard-coded in a component. Fonts self-hosted
   under `fonts/`, OFL only (`BUILD-NOTES.md` section 1 has the files and
   budget). Rewrite the `ui-tokens` half that pins today's look, in this PR, and
   name the ruling that fell (`test-classification.md`, `ui-tokens`
   "Rewrite must still guarantee").
2. **SVG icon sprite.** One sprite, one family, matched weight and optical size;
   referenced by `<use>`, no text glyphs standing in for icons. Strict-CSP safe.
3. **Primitives.** Button/key, chip, row, card, sheet, tab bar, scrubber, art
   tile, toast: one treatment each, every state (default, pressed, focus,
   disabled, loading). New `*.test.js` suites carry their FLOORS line and a
   named mutation (section 5).
4. **Component gallery.** A route `#/gallery`, registered only under the lab flag
   or `?gallery=1` (**decision**: never reachable in the production app), rendering
   every primitive in every state in each scheme. Add a `gallery` state to
   `tools/ui-lab/lib/states.mjs` on the direction branch. Then:
   ```
   node tools/ui-lab/shoot.mjs --target app --states gallery --no-remote-images --out data-local/redesign/shots/<direction>-gallery
   node tools/ui-lab/gates.mjs --target app --states gallery --allow tools/ui-lab/gates-known-debt.json --no-remote-images   # must exit 0
   node tools/ui-lab/baseline.mjs record --name <direction>-gallery --root $ROOT --target app --states gallery --no-remote-images
   ```
   That baseline is the regression net for the foundation: from here on, an
   unintended primitive change fails `baseline.mjs compare --name <direction>-gallery --root $ROOT`.
   Judge the gallery once against the direction's own prototype (section 4, step 5)
   before Phase 4 starts.

Phase 3 exit: all suites green (`node tools/ci/run-suites.mjs`), gates green,
gallery baseline recorded, and the **rolling app baseline** recorded once over the
whole app (`baseline.mjs record --name <direction>-app --root $ROOT --target app --no-remote-images`;
section 4, step 8 keeps it current), `PROGRESS.md` updated.

## 4. Phase 4: the per-screen loop

**Order: Now Playing first** (the direction's signature screen and the
hardest; it sets the pattern), then Today, Find/Search, Library, Foray detail,
Onboarding, then the rest in `lib/states.mjs` order. The screen map
`docs/redesign-2026/directions/<direction>/screens.json` lists each prototype
screen, the route that shows it, and the app state it corresponds to (`app: null`
= nothing in today's app yet: build the state into `lib/states.mjs` first so the
harness can reach it).

For each screen, one agent, branch `redesign/p4-<direction>-<screen>`:

1. **Implement** against the prototype and `BUILD-NOTES.md`. Real data, real
   `esc()`/`safeUrl()`, markup only in the screen's own `ui/*.js`.
2. **Tests first-class.** Per `test-classification.md`: KEEP suites stay green
   or are ported unchanged to the new markup; REWRITE-ON-PURPOSE suites change
   only in the PR that adopts the ruling, and that PR says which ruling fell.
   Every new test names its one-line mutation and you run it. New suite =
   FLOORS line.
3. **Gates.**
   ```
   node tools/ui-lab/gates.mjs --target app --allow tools/ui-lab/gates-known-debt.json --no-remote-images
   ```
   must exit 0: no violation outside the known-debt list (without `--allow` all
   known debt counts as new and the exit is always 1; the list was recorded with
   `--no-remote-images`, so keep that flag). Do not add to the list to get green; a
   new entry, or `--write-allow`, is an orchestrator decision.
4. **Shoot and pair.** For the screen's rows in `screens.json`:
   ```
   node tools/ui-lab/fidelity.mjs --direction <direction> --screens <ids> --run <screen>-i<N> --root $ROOT
   ```
   (Remote images are off by default; `--remote-images` opts in.) Open `$ROOT\fidelity\<run>\report.md` and the `side/*.png`
   (prototype | app). The report gives per-screen pixel diff (dominated by data
   and artwork, so read it only as "is it close at all") and per-region
   position/size deltas in px (header, hero art, rows, tab bar, primary control,
   mini player, scrubber). Fix every region delta above **4px** (**decision**) that
   the prototype does not explain. `--max-region-delta 4` turns that into an exit
   code if a workflow wants it (then a region over 4px, a region on one side only,
   a region matching nothing on either side, or a screen skipped for a missing shot
   all fail); fidelity is otherwise judged, not thresholded. A region listed under
   "Broken regions" is a selector typo in `screens.json`: fix the map, it is not a
   finding. A `screens.json` naming a state or step that does not exist exits 2.
   Sanity: `--against self` must read 0% on every screen.
5. **Judge, pairwise, per `judge/protocol.md`.** Copy the two renders to neutral
   `A.png`/`B.png` via `judge-set.mjs ... --root $ROOT` (build a `pairs.json` for the screen;
   `judge/hard-pairs.json` is the format); never hand a judge a path or the
   `side/` image, which names the prototype. Same screen/state/viewport, same
   rubric (`judge/rubric.md`):
   - **Fidelity pair:** implementation vs the prototype's render
     (`$ROOT\fidelity\<run>\shots\prototype\` vs `shots\app\`). Question: has the
     build lost anything the prototype had? Pass: the prototype does not win.
   - **Is-it-better pair:** implementation vs today's app for the same screen
     (`$ROOT\shots\today\`). Pass: the implementation wins.
   - **Quick iterations (protocol "Judges per pair"): two judges total per pair.**
     `judge-set.mjs` shows each pair in both orders, one judge per order, which is
     exactly two verdicts. If they disagree (one A, one B), add a third.
   - **The pass that accepts a screen: three judges.** Take the two verdicts
     above and add a third fresh Opus judge on a neutral copy of one order's
     `A.png`/`B.png` folder (copy one `j<k>/<nn>` folder from the set to a new
     directory; pick the order by coin flip and note it in the run record). Map all
     three back through `key.json`, majority per protocol "Aggregation": 2-0 or 3-0
     is a win, a 2-1 is a lean (accept and record it in the review), a split with no
     majority is a tie. Order-following pairs are ties.
   - Judges are Opus, fresh context, images and rubric only. Keep their
     `decisive_reasons`; they are the fix list.
6. **Fix, then re-run steps 3 to 5.** Cap: **4 iterations** (**decision**). Past
   that, stop and escalate to the orchestrator with: the last fidelity report,
   the judges' repeated reasons, and your read on whether the prototype itself is
   the problem (a prototype that cannot be built on the web, or collides with a
   hard limit, is a direction defect, not a build failure). The orchestrator
   rules; do not loop further.
7. **Reviewer agent on the diff** (Opus, fresh context): hard-limit table
   (section 2), test discipline (section 5), classification, no stray files,
   no screenshots committed, no direct-to-main anything. Reviewer returns
   section 7's shape. Must-fix items go back to step 6 and count as an iteration.
8. **Regression check, merge, re-lock.** Baselines are **rolling, one per
   direction, not one per screen**: every baseline render shoots the whole app, so a
   per-screen baseline would be broken by the next screen. There are two:
   `<direction>-gallery` (the foundation) and `<direction>-app` (every state, every
   viewport). Before merging, on the screen branch:
   ```
   node tools/ui-lab/baseline.mjs compare --name <direction>-gallery --root $ROOT
   node tools/ui-lab/baseline.mjs compare --name <direction>-app --root $ROOT
   ```
   `compare` re-renders with the shoot args stored by `record` (read
   `$ROOT\compare\<name>\report.md`; `diffs\` has the overlays). Diffs on the screen
   you just built are expected; **a diff anywhere else is a regression** (fix it, or,
   if the change is intended, say which screen and why in the PR). Then merge into the
   direction branch (merge commit) and re-lock:
   ```
   node tools/ui-lab/baseline.mjs record --name <direction>-app --force --root $ROOT --target app --no-remote-images
   node tools/ui-lab/baseline.mjs record --name <direction>-gallery --force --root $ROOT --target app --states gallery --no-remote-images   # only if the PR meant to change a primitive
   ```
   (`record` without `--from` renders with `shoot.mjs`; a baseline recorded with
   `--from` cannot be re-rendered by `compare --name` alone, which exits 2.) Re-record
   only for a change the PR intended, never to silence a diff. Baselines are tied to
   one machine's Chromium and fonts. Append one line to `PROGRESS.md`.

After the last screen: full `node tools/ci/run-suites.mjs`, `gates.mjs` (with
`--allow` and `--no-remote-images`) on every state, `a11y.mjs` on every route/state,
both baselines compared clean, then
hand to Phase 5 (QA, perf budget, store screenshots and copy; no app icon).

## 5. Test discipline

- Classification is `docs/redesign-2026/test-classification.md`: **KEEP** =
  enforces a hard limit, stays green or is ported unchanged; **REWRITE-ON-PURPOSE**
  = pins today's look or a ruling a direction may overturn, rewritten only in
  the PR that adopts the overturning direction, which must state the ruling.
  A suite marked R is never deleted on a builder's own initiative.
- `CLAUDE.md` "A green test is not evidence until you have broken it": for every
  new test, name the one-line mutation (in the test's own comment), run it, see
  it fail. Audit the harness (does your fake answer more forgivingly than the
  real thing?), assert on the raw result, not a truncated view.
- A new `tools/**/*.test.mjs` or `player/**/*.test.js` needs its entry in
  `FLOORS` in `test/suite-integrity.test.js` in the same change; a floor may go
  down only in the PR that deletes the pinned behaviour.
- A package `test` script must forward its arguments (end in `node --test`).
- Verification before any commit: `node tools/ci/run-suites.mjs` (one command,
  what CI runs; `--skip-install` reuses deps), `node --check app.js`, and
  `cd backend && npm test` when copy-bearing data or `data/*.json` text changed.
- Do not report done while any item is unmet; say what is missing.

## 6. Lab delivery

- The lab flag is `window.__FORAY_LAB__`, set by the lab web bundle
  (`FORAY_LAB=1`, `tools/mobile/prepare-webdir.mjs`); with it the client never
  signs up, refreshes a token, or POSTs an event (`test/lab-flag.test.js`).
  Any new network write a screen adds must honour it, and get a test beside the
  three in that file.
- `.github/workflows/lab-build.yml` builds a branch as "4a Lab"
  (`ai.jwlabs.foura.lab`) for Wyatt's iPhone (TestFlight) and Joey's Android
  (Play internal, plus a debug APK). It is dispatch-only, accepts only
  `redesign/*` or `feature/redesign-2026*` refs, and must be dispatched from
  `main`'s copy (it is on `main` since #1087, 749a986b). Only the **orchestrator**
  (never a build agent) dispatches it:
  `gh workflow run lab-build.yml --ref main -f ref=feature/redesign-2026-<direction> -f platforms=both`
  (`--ref main` is the workflow file's ref; the `ref` input is the branch to build and
  must be `redesign/*` or `feature/redesign-2026*`), when a direction reaches a milestone worth putting in hands (Now Playing
  accepted; then each screen group). Do not dispatch `release.yml`.
- Each lab build gets one `PROGRESS.md` line: ref, SHA, which screens are in it,
  what to try. Feedback from the devices goes in `HUMAN-ACTIONS.md` only if it
  needs the owner; otherwise into the next loop as a fix list.

## 7. What each agent returns

Short. The orchestrator keeps a small context; verify, never trust the summary.

| Role | Returns (under 200 words) |
|---|---|
| Foundation engineer | Branch and SHA; what landed; suites run and result; gallery baseline name; the mutation for each new test; anything blocked |
| Screen engineer | Branch and SHA; screen id; iterations used (of 4); last `fidelity` run path, mean pixel diff, worst three region deltas; gates result vs known debt; judge outcomes (vote splits, both pairs); open P1/P2 left; tests added with mutations; what escalated |
| Judge | The JSON shape in `judge/rubric.md` and nothing else (winner, confidence, 2-3 `decisive_reasons`, optional `dimensions`) |
| Reviewer | Verdict (ship / fix), must-fix list with file:line, hard-limit table result, test-discipline result, anything committed that should not be (screenshots especially) |
| Orchestrator (to the owner) | Per screen: accepted / escalated, vote splits, a link to the lab build if one exists; one line on what changed in the hard-limit gates |

## 8. Decisions recorded here

- Iteration cap is 4 per screen; region-delta tolerance is 4px; both are
  starting values.
- The gallery lives behind `#/gallery` under the lab flag or `?gallery=1`.
- Acceptance needs both a fidelity pass (the prototype does not win) and a
  better-than-today pass (the implementation wins), three judges, both orders.
- Fidelity tooling (`tools/ui-lab/fidelity.mjs`, `screens.json` per direction)
  pairs prototypes to app states; an unmapped screen (`app: null`) is a state to
  build, not a screen to skip.
